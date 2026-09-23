import { Router, type IRouter } from "express";
import { actorId, requireWorkspaceOwner } from "../middlewares/auth";
import { connectorsEnabled, createConnector, listConnectors, rotateConnector, revokeConnector } from "../services/connector-tokens";

const router: IRouter = Router();
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function input(value: unknown): { name: string; scopes: Array<"tools:list" | "tools:call">; expiresAt: Date | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(k => !["name", "scopes", "expiresAt"].includes(k)) ||
      typeof data.name !== "string" || !data.name.trim() || data.name.length > 100 ||
      !Array.isArray(data.scopes) || data.scopes.length < 1 || data.scopes.length > 2 ||
      new Set(data.scopes).size !== data.scopes.length ||
      !data.scopes.every(s => s === "tools:list" || s === "tools:call") ||
      (data.expiresAt !== undefined && data.expiresAt !== null && (typeof data.expiresAt !== "string" || !/^\d{4}-\d\d-\d\dT/.test(data.expiresAt)))) return null;
  const expiresAt = typeof data.expiresAt === "string" ? new Date(data.expiresAt) : null;
  if (expiresAt && (!Number.isFinite(expiresAt.valueOf()) || expiresAt <= new Date())) return null;
  return { name: data.name.trim(), scopes: data.scopes as Array<"tools:list" | "tools:call">, expiresAt };
}
router.use("/workspaces/:workspaceId/connectors", (req, res, next) => {
  if (!connectorsEnabled()) { res.status(404).json({ error: "Route not found", code: "ROUTE_NOT_FOUND" }); return; }
  if (!uuid(req.params.workspaceId)) { res.status(400).json({ error: "Invalid workspace", code: "INVALID_INPUT" }); return; }
  const origin = req.header("origin");
  if (origin) {
    try {
      if (new URL(origin).host !== req.header("host")) {
        res.status(403).json({ error: "Invalid Origin", code: "INVALID_ORIGIN" }); return;
      }
    } catch {
      res.status(403).json({ error: "Invalid Origin", code: "INVALID_ORIGIN" }); return;
    }
  }
  res.setHeader("Cache-Control", "no-store");
  next();
}, requireWorkspaceOwner);

router.get("/workspaces/:workspaceId/connectors", async (req, res): Promise<void> => {
  res.json(await listConnectors(String(req.params.workspaceId)));
});
router.post("/workspaces/:workspaceId/connectors", async (req, res): Promise<void> => {
  const parsed = input(req.body);
  if (!parsed) {
    res.status(400).json({ error: "Invalid connector input", code: "INVALID_INPUT" }); return;
  }
  res.status(201).json(await createConnector(String(req.params.workspaceId), actorId(req), parsed.name, parsed.scopes, parsed.expiresAt));
});
router.post("/workspaces/:workspaceId/connectors/:actorId/rotate", async (req, res): Promise<void> => {
  if (!uuid(req.params.actorId)) { res.status(400).json({ error: "Invalid connector", code: "INVALID_INPUT" }); return; }
  res.json(await rotateConnector(String(req.params.workspaceId), String(req.params.actorId), actorId(req)));
});
router.delete("/workspaces/:workspaceId/connectors/:actorId", async (req, res): Promise<void> => {
  if (!uuid(req.params.actorId)) { res.status(400).json({ error: "Invalid connector", code: "INVALID_INPUT" }); return; }
  res.json(await revokeConnector(String(req.params.workspaceId), String(req.params.actorId), actorId(req)));
});
export default router;