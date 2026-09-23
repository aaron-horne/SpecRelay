import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, isNull, gt, desc } from "drizzle-orm";
import { connectorActorsTable, connectorTokensTable, workspaceMembershipsTable, auditEventsTable, db } from "@workspace/db";
import { ServiceError } from "./errors";

export const connectorsEnabled = () => process.env.CONNECTOR_TOKENS_ENABLED === "true";
const format = /^srct_([a-f0-9]{24})_([A-Za-z0-9_-]{64})$/;
const hash = (token: string) => createHash("sha256").update(token).digest();
const dummy = hash("invalid-token");
const windows = new Map<string, { count: number; until: number }>();

// Local, bounded first-line protection; multi-instance deployments should also enforce
// limits at their ingress. Never retain raw credentials in limit keys.
export function limit(key: string, max: number): boolean {
  const now = Date.now();
  if (windows.size > 10_000) {
    for (const [k, value] of windows) if (value.until <= now) windows.delete(k);
    // Evict one old bucket rather than clearing *every* limiter under churn.
    if (windows.size > 10_000) windows.delete(windows.keys().next().value!);
  }
  const entry = windows.get(key);
  const next = !entry || entry.until <= now ? { count: 1, until: now + 60_000 } : { ...entry, count: entry.count + 1 };
  windows.set(key, next);
  return next.count <= max;
}

function issue() {
  const lookupId = randomBytes(12).toString("hex");
  const token = `srct_${lookupId}_${randomBytes(48).toString("base64url")}`;
  return { lookupId, token, verifier: hash(token).toString("hex") };
}

export type ConnectorIdentity = { tokenId: string; actorId: string; memberId: string; workspaceId: string; scopes: Array<"tools:list" | "tools:call"> };

export async function verifyConnector(token: string): Promise<ConnectorIdentity | null> {
  const parsed = format.exec(token);
  const [row] = parsed ? await db.select({ token: connectorTokensTable, actor: connectorActorsTable, member: workspaceMembershipsTable })
    .from(connectorTokensTable)
    .innerJoin(connectorActorsTable, and(eq(connectorActorsTable.id, connectorTokensTable.actorId), eq(connectorActorsTable.workspaceId, connectorTokensTable.workspaceId)))
    .innerJoin(workspaceMembershipsTable, and(eq(workspaceMembershipsTable.workspaceId, connectorActorsTable.workspaceId), eq(workspaceMembershipsTable.userId, connectorActorsTable.memberId), eq(workspaceMembershipsTable.role, "MEMBER")))
    .where(eq(connectorTokensTable.lookupId, parsed[1]!)).limit(1) : [];
  const candidate = row ? Buffer.from(row.token.verifier, "hex") : dummy;
  const actual = hash(token);
  const valid = candidate.length === actual.length && timingSafeEqual(candidate, actual);
  if (!valid || !row || row.token.revokedAt || (row.token.expiresAt && row.token.expiresAt <= new Date())) return null;
  return { tokenId: row.token.id, actorId: row.actor.id, memberId: row.actor.memberId, workspaceId: row.actor.workspaceId, scopes: row.token.scopes };
}

export async function checkConnector(identity: ConnectorIdentity, scope: "tools:list" | "tools:call"): Promise<boolean> {
  if (!connectorsEnabled()) return false;
  const [row] = await db.select({ scopes: connectorTokensTable.scopes, expiresAt: connectorTokensTable.expiresAt })
    .from(connectorTokensTable)
    .innerJoin(connectorActorsTable, and(eq(connectorActorsTable.id, connectorTokensTable.actorId), eq(connectorActorsTable.workspaceId, connectorTokensTable.workspaceId)))
    .innerJoin(workspaceMembershipsTable, and(eq(workspaceMembershipsTable.workspaceId, connectorActorsTable.workspaceId), eq(workspaceMembershipsTable.userId, connectorActorsTable.memberId), eq(workspaceMembershipsTable.role, "MEMBER")))
    .where(and(eq(connectorTokensTable.id, identity.tokenId), eq(connectorTokensTable.workspaceId, identity.workspaceId),
      eq(connectorTokensTable.actorId, identity.actorId), isNull(connectorTokensTable.revokedAt),
    )).limit(1);
  return !!row && (!row.expiresAt || row.expiresAt > new Date()) && row.scopes.includes(scope);
}

export async function auditConnector(workspaceId: string, actorId: string, eventType: string, resourceId: string) {
  await db.insert(auditEventsTable).values({ workspaceId, eventType, resourceType: "connector_actor", resourceId, metadata: { actorId, actorType: "CONNECTOR" } });
}

export async function createConnector(workspaceId: string, ownerId: string, name: string, scopes: Array<"tools:list" | "tools:call">, expiresAt: Date | null) {
  const id = crypto.randomUUID();
  const memberId = `svc:${id}`;
  const issued = issue();
  await db.transaction(async (tx) => {
    await tx.insert(workspaceMembershipsTable).values({ workspaceId, userId: memberId, role: "MEMBER" });
    await tx.insert(connectorActorsTable).values({ id, workspaceId, memberId, name, createdBy: ownerId });
    await tx.insert(connectorTokensTable).values({ workspaceId, actorId: id, ...issued, scopes, expiresAt });
    await tx.insert(auditEventsTable).values({ workspaceId, eventType: "connector.created", resourceType: "connector_actor", resourceId: id, metadata: { actorId: ownerId, actorType: "HUMAN" } });
  });
  return { actorId: id, token: issued.token };
}

export async function listConnectors(workspaceId: string) {
  const rows = await db.select({ actor: connectorActorsTable, token: connectorTokensTable })
    .from(connectorActorsTable).innerJoin(connectorTokensTable, and(eq(connectorTokensTable.actorId, connectorActorsTable.id), eq(connectorTokensTable.workspaceId, connectorActorsTable.workspaceId)))
    .where(eq(connectorActorsTable.workspaceId, workspaceId));
  return rows.map(({ actor, token }) => ({
    actorId: actor.id, name: actor.name, tokenId: token.id, scopes: token.scopes,
    createdAt: token.createdAt, expiresAt: token.expiresAt, revokedAt: token.revokedAt,
    status: token.revokedAt ? "revoked" : token.expiresAt && token.expiresAt <= new Date() ? "expired" : "active",
  }));
}

export async function rotateConnector(workspaceId: string, actorId: string, ownerId: string) {
  const issued = issue();
  const result = await db.transaction(async (tx) => {
    const [actor] = await tx.select().from(connectorActorsTable).where(and(eq(connectorActorsTable.workspaceId, workspaceId), eq(connectorActorsTable.id, actorId))).limit(1);
    if (!actor) throw new ServiceError("Connector not found", 404, "CONNECTOR_NOT_FOUND");
    const [latest] = await tx.select().from(connectorTokensTable).where(and(eq(connectorTokensTable.workspaceId, workspaceId), eq(connectorTokensTable.actorId, actorId), isNull(connectorTokensTable.revokedAt))).orderBy(desc(connectorTokensTable.createdAt)).limit(1);
    if (!latest || (latest.expiresAt && latest.expiresAt <= new Date())) throw new ServiceError("Connector not active", 409, "CONNECTOR_INACTIVE");
    const originalExpiry = latest.expiresAt;
    const overlapEnd = new Date(Date.now() + 5 * 60_000);
    await tx.update(connectorTokensTable).set({ expiresAt: overlapEnd }).where(and(eq(connectorTokensTable.workspaceId, workspaceId), eq(connectorTokensTable.actorId, actorId), isNull(connectorTokensTable.revokedAt), gt(connectorTokensTable.expiresAt, overlapEnd)));
    // Also bound tokens without an expiry.
    await tx.update(connectorTokensTable).set({ expiresAt: overlapEnd }).where(and(eq(connectorTokensTable.workspaceId, workspaceId), eq(connectorTokensTable.actorId, actorId), isNull(connectorTokensTable.revokedAt), isNull(connectorTokensTable.expiresAt)));
    await tx.insert(connectorTokensTable).values({ workspaceId, actorId, ...issued, scopes: latest.scopes, expiresAt: originalExpiry });
    await tx.insert(auditEventsTable).values({ workspaceId, eventType: "connector.rotated", resourceType: "connector_actor", resourceId: actorId, metadata: { actorId: ownerId, actorType: "HUMAN" } });
    return true;
  });
  return { actorId, token: issued.token, rotated: result };
}

export async function revokeConnector(workspaceId: string, actorId: string, ownerId: string) {
  return db.transaction(async (tx) => {
    const [actor] = await tx.select({ id: connectorActorsTable.id }).from(connectorActorsTable).where(and(eq(connectorActorsTable.workspaceId, workspaceId), eq(connectorActorsTable.id, actorId))).limit(1);
    if (!actor) throw new ServiceError("Connector not found", 404, "CONNECTOR_NOT_FOUND");
    await tx.update(connectorTokensTable).set({ revokedAt: new Date() }).where(and(eq(connectorTokensTable.workspaceId, workspaceId), eq(connectorTokensTable.actorId, actorId), isNull(connectorTokensTable.revokedAt)));
    await tx.insert(auditEventsTable).values({ workspaceId, eventType: "connector.revoked", resourceType: "connector_actor", resourceId: actorId, metadata: { actorId: ownerId, actorType: "HUMAN" } });
    return { revoked: true };
  });
}