import { getAuth } from "@clerk/express";
import type { NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, workspaceMembershipsTable, workspacesTable } from "@workspace/db";

const actors = new WeakMap<Request, string>();
export function setConnectorActor(req: Request, memberId: string): void {
  actors.set(req, memberId);
}

export function shouldInstallClerkMiddleware(
  nodeEnv: string | undefined,
): boolean {
  return nodeEnv !== "test";
}

export function resolveActorId(
  auth: { userId?: string | null; sessionClaims?: unknown },
  testHeader: string | undefined,
  isTest = process.env.NODE_ENV === "test",
): string | undefined {
  if (isTest) {
    if (testHeader === "__unauthenticated__") return undefined;
    return testHeader || "security-test-user";
  }
  return auth.userId ?? undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (actors.has(req) && req.path.endsWith("/mcp")) { next(); return; }
  const isTest = process.env.NODE_ENV === "test";
  const testHeader = isTest ? req.header("x-test-user-id") : undefined;
  const auth = isTest ? {} : getAuth(req);
  const actorId = resolveActorId(auth, testHeader, isTest);
  if (!actorId) {
    res.status(401).json({ error: "Unauthorized", code: "UNAUTHENTICATED" });
    return;
  }
  actors.set(req, actorId);
  next();
}

function configuredPublicOrigins(): Set<string> {
  if (process.env.NODE_ENV === "test") return new Set();
  const configured = process.env.REPLIT_DOMAINS;
  if (!configured) return new Set();
  return new Set(
    configured.split(",").flatMap((value) => {
      const host = value.trim();
      if (!host) return [];
      try {
        const url = new URL(host.includes("://") ? host : `https://${host}`);
        return [url.origin];
      } catch {
        return [];
      }
    }),
  );
}

/**
 * DELETE workspace is a browser cookie-bearing action. Require Origin rather
 * than falling back to Referer or SameSite cookies. In production the
 * expected origin comes from Replit's runtime-managed public domains, not
 * request-controlled forwarding headers.
 */
export function requireSameOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const rawOrigin = req.header("origin");
  if (!rawOrigin || rawOrigin === "null") {
    res.status(403).json({ error: "Valid same-origin request required", code: "CSRF_ORIGIN_INVALID" });
    return;
  }
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("invalid origin");
    }
  } catch {
    res.status(403).json({ error: "Valid same-origin request required", code: "CSRF_ORIGIN_INVALID" });
    return;
  }

  const expected = configuredPublicOrigins();
  // Supertest has no Replit runtime domain. Keep this test-only fallback
  // request-local; production never trusts a forwarded host supplied by a
  // caller when the managed public-domain value is unavailable.
  if (expected.size === 0 && process.env.NODE_ENV === "test") {
    expected.add(`${req.protocol}://${req.get("host")}`);
    expected.add(`${req.protocol}://${req.hostname}`);
  }
  if (!expected.has(origin.origin)) {
    res.status(403).json({ error: "Valid same-origin request required", code: "CSRF_ORIGIN_INVALID" });
    return;
  }
  next();
}

export function actorId(req: Request): string {
  const id = actors.get(req);
  if (!id) throw new Error("Authenticated actor missing");
  return id;
}

export async function requireWorkspaceMembership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const workspaceId = String(req.params.workspaceId);
  const userId = actorId(req);
  const [membership] = await db
    .select({ workspaceId: workspaceMembershipsTable.workspaceId })
    .from(workspaceMembershipsTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, workspaceMembershipsTable.workspaceId))
    .where(
      and(
        eq(workspaceMembershipsTable.workspaceId, workspaceId),
        eq(workspaceMembershipsTable.userId, userId),
        isNull(workspacesTable.deletedAt),
      ),
    )
    .limit(1);
  if (!membership) {
    res.status(404).json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" });
    return;
  }
  next();
}

export async function requireWorkspaceOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const workspaceId = String(req.params.workspaceId);
  const userId = actorId(req);
  const [membership] = await db
    .select({ role: workspaceMembershipsTable.role })
    .from(workspaceMembershipsTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, workspaceMembershipsTable.workspaceId))
    .where(
      and(
        eq(workspaceMembershipsTable.workspaceId, workspaceId),
        eq(workspaceMembershipsTable.userId, userId),
        isNull(workspacesTable.deletedAt),
      ),
    )
    .limit(1);
  if (!membership) {
    res.status(404).json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" });
    return;
  }
  if (membership.role !== "OWNER") {
    res.status(403).json({ error: "Workspace owner access required", code: "OWNER_REQUIRED" });
    return;
  }
  next();
}