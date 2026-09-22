import { Router, type IRouter } from "express";
import healthRouter from "./health";
import workspaceRouter from "./workspaces";
import catalogRouter from "./catalog";
import { requireAuth } from "../middlewares/auth";
import mcpRouter from "./mcp";
import credentialsRouter from "./credentials";
import executionLogsRouter from "./execution-logs";

const router: IRouter = Router();

router.use(healthRouter);
router.use(requireAuth);
router.use(workspaceRouter);
router.use(catalogRouter);
router.use(credentialsRouter);
router.use(executionLogsRouter);
router.use(mcpRouter);

export default router;
