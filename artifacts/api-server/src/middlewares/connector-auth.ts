import type { Request, Response, NextFunction } from "express";
import { auditConnector, checkConnector, connectorsEnabled, limit, verifyConnector, type ConnectorIdentity } from "../services/connector-tokens";
import { setConnectorActor } from "./auth";

const identities = new WeakMap<Request, ConnectorIdentity>();
export const connectorIdentity = (req: Request) => identities.get(req);
const unauthorized = (res: Response) => res.status(401).json({ error: "Unauthorized", code: "UNAUTHENTICATED" });

export async function connectorMcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authorization = req.header("authorization") ?? "";
  // Explicit format only. A malformed connector credential must not fall back to Clerk.
  if (!/^Bearer srct_/i.test(authorization)) { next(); return; }
  if (!connectorsEnabled()) { unauthorized(res); return; }
  const fingerprint = req.ip ?? "unknown";
  // A coarse per-origin ceiling protects random-identifier spraying; a narrower
  // per-identifier ceiling protects repeated guesses behind a shared origin.
  const lookupId = /^Bearer srct_([a-f0-9]{24})_/i.exec(authorization)?.[1] ?? "malformed";
  if (!limit(`auth:${fingerprint}`, 600) || !limit(`lookup:${fingerprint}:${lookupId}`, 60)) {
    req.log.warn("Connector authentication rate limit reached");
    res.status(429).json({ error: "Too many requests", code: "RATE_LIMITED" }); return;
  }
  if (req.header("cookie") || req.header("x-test-user-id")) {
    unauthorized(res); return;
  }
  const token = authorization.slice(7);
  const identity = await verifyConnector(token);
  if (!identity) { unauthorized(res); return; }
  if (identity.workspaceId !== String(req.params.workspaceId)) {
    res.status(404).json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" }); return;
  }
  if (!limit(`actor:${identity.workspaceId}:${identity.actorId}`, 120)) {
    req.log.warn({ workspaceId: identity.workspaceId, actorId: identity.actorId }, "Connector actor rate limit reached");
    await auditConnector(identity.workspaceId, identity.memberId, "connector.rate_limited", identity.actorId);
    res.status(429).json({ error: "Too many requests", code: "RATE_LIMITED" }); return;
  }
  identities.set(req, identity);
  setConnectorActor(req, identity.memberId);
  next();
}

export async function requireConnectorScope(req: Request, res: Response, scope: "tools:list" | "tools:call"): Promise<boolean> {
  const identity = connectorIdentity(req);
  if (!identity) return true;
  if (await checkConnector(identity, scope)) return true;
  await auditConnector(identity.workspaceId, identity.memberId, "execution.denied", identity.actorId);
  res.status(403).json({ error: "Connector scope denied", code: "SCOPE_DENIED" });
  return false;
}