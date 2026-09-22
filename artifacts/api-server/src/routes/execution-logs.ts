import { Router, type IRouter } from "express";
import {
  ListExecutionLogsQueryParams,
  ListExecutionLogsResponse,
} from "@workspace/api-zod";
import { actorId } from "../middlewares/auth";
import { ExecutionLogsService } from "../services/execution-logs";

const router: IRouter = Router();
const service = new ExecutionLogsService();

router.get("/execution-logs", async (req, res): Promise<void> => {
  const query = ListExecutionLogsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({
      error: "Invalid execution log filters",
      code: "INVALID_INPUT",
      details: query.error.issues.map((issue) => issue.message),
    });
    return;
  }
  res.json(
    ListExecutionLogsResponse.parse(
      await service.list(actorId(req), query.data),
    ),
  );
});

export default router;