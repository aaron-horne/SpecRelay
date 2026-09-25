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
  recordSemanticAnalysisDenial,
  semanticAnalysisRequestCategory,
} from "../services/semantic-analysis-denial-audit";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/workspaces/:workspaceId/mcp", connectorMcpAuth);
router.use((req, res, next) => {
  const requestCategory = semanticAnalysisRequestCategory(req.method, req.path);
  return requireAuth(req, res, next, requestCategory
    ? () => recordSemanticAnalysisDenial(null, requestCategory, "unauthenticated")
    : undefined);
});
router.use("/workspaces/:workspaceId/apis/:apiId/operations/:operationId/semantic-analysis", (req, res, next) => {
  const requestCategory = semanticAnalysisRequestCategory(req.method, `${req.baseUrl}${req.path}`);
  if (!requestCategory) return next();
  return requireWorkspaceMembership(req, res, next, () =>
    recordSemanticAnalysisDenial(actorId(req), requestCategory, "workspace_unavailable"));
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
