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