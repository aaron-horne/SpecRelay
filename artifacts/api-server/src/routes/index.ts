import { Router, type IRouter } from "express";
import healthRouter from "./health";
import workspaceRouter from "./workspaces";
import catalogRouter from "./catalog";
import { requireAuth } from "../middlewares/auth";
import mcpRouter from "./mcp";
import credentialsRouter from "./credentials";
import executionLogsRouter from "./execution-logs";
import connectorRouter from "./connector-tokens";
import semanticProvidersRouter from "./semantic-providers";
import { connectorMcpAuth } from "../middlewares/connector-auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/workspaces/:workspaceId/mcp", connectorMcpAuth);
router.use(requireAuth);
router.use(workspaceRouter);
router.use(catalogRouter);
router.use(credentialsRouter);
router.use(executionLogsRouter);
router.use(connectorRouter);
router.use(semanticProvidersRouter);
router.use(mcpRouter);

export default router;
