import { Router, type IRouter } from "express";
import healthRouter from "./health";
import workspaceRouter from "./workspaces";
import catalogRouter from "./catalog";
import { actorId, requireAuth, requireWorkspaceMembership } from "../middlewares/auth";
import mcpRouter from "./mcp";
import credentialsRouter from "./credentials";
import executionLogsRouter from "./execution-logs";
import connectorRouter from "./connector-tokens";
import semanticProvidersRouter from "./semantic-providers";
import semanticAnalysisRouter from "./semantic-analysis";
import { connectorMcpAuth } from "../middlewares/connector-auth";
import {
  auditSemanticAnalysisDenialResponse,
  semanticAnalysisRequestCategory,
} from "../services/semantic-analysis-denial-audit";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/workspaces/:workspaceId/mcp", connectorMcpAuth);
router.use((req, res, next) => {
  if (semanticAnalysisRequestCategory(req.method, req.originalUrl || req.path)) {
    res.once("finish", () => {
      let authenticatedActor: string | null = null;
      if (res.statusCode !== 401) {
        try { authenticatedActor = actorId(req); } catch { /* Unauthenticated actor. */ }
      }
      auditSemanticAnalysisDenialResponse(req, res.statusCode, authenticatedActor);
    });
  }
  return next();
});
router.use((req, res, next) => {
  return requireAuth(req, res, next);
});
router.use("/workspaces/:workspaceId/apis/:apiId/operations/:operationId/semantic-analysis", (req, res, next) => {
  const requestCategory = semanticAnalysisRequestCategory(req.method, `${req.baseUrl}${req.path}`);
  if (!requestCategory) return next();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(req.params.workspaceId))) {
    res.status(404).json({ error: "Workspace not found", code: "WORKSPACE_NOT_FOUND" });
    return;
  }
  return requireWorkspaceMembership(req, res, next);
});
router.use(workspaceRouter);
router.use(catalogRouter);
router.use(credentialsRouter);
router.use(executionLogsRouter);
router.use(connectorRouter);
router.use(semanticProvidersRouter);
router.use(semanticAnalysisRouter);
router.use(mcpRouter);

export default router;
