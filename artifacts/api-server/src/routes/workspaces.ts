import { Router, type IRouter } from "express";
import {
  CreateWorkspaceBody,
  CreateWorkspaceResponse,
  DeleteWorkspaceBody,
  GetWorkspaceOverviewParams,
  GetWorkspaceOverviewResponse,
  GetWorkspaceParams,
  GetWorkspaceResponse,
  ListWorkspacesResponse,
} from "@workspace/api-zod";
import { WorkspaceService } from "../services/workspaces";
import { actorId } from "../middlewares/auth";

const router: IRouter = Router();
const service = new WorkspaceService();

router.get("/workspaces", async (req, res): Promise<void> => {
  res.json(ListWorkspacesResponse.parse(await service.list(actorId(req))));
});

router.post("/workspaces", async (req, res): Promise<void> => {
  const input = CreateWorkspaceBody.strict().safeParse(req.body);
  if (!input.success) {
    res.status(400).json({
      error: "Invalid workspace input",
      code: "INVALID_INPUT",
      details: input.error.issues.map((issue) => issue.message),
    });
    return;
  }
  const workspace = await service.create(input.data.name, actorId(req));
  res.status(201).json(CreateWorkspaceResponse.parse(workspace));
});

router.get("/workspaces/:workspaceId", async (req, res): Promise<void> => {
  const params = GetWorkspaceParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid workspace identifier" });
    return;
  }
  res.json(GetWorkspaceResponse.parse(await service.get(params.data.workspaceId, actorId(req))));
});

router.delete("/workspaces/:workspaceId", async (req, res): Promise<void> => {
  const params = GetWorkspaceParams.safeParse(req.params);
  const input = DeleteWorkspaceBody.strict().safeParse(req.body);
  if (!params.success) {
    res.status(400).json({ error: "Invalid workspace identifier", code: "INVALID_INPUT" });
    return;
  }
  if (!input.success) {
    res.status(400).json({
      error: "Workspace name confirmation is required",
      code: "INVALID_INPUT",
      details: input.error.issues.map((issue) => issue.message),
    });
    return;
  }
  await service.delete(params.data.workspaceId, actorId(req), input.data.name);
  res.status(204).send();
});

router.get(
  "/workspaces/:workspaceId/overview",
  async (req, res): Promise<void> => {
    const params = GetWorkspaceOverviewParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid workspace identifier" });
      return;
    }
    res.json(
      GetWorkspaceOverviewResponse.parse(
        await service.overview(params.data.workspaceId, actorId(req)),
      ),
    );
  },
);

export default router;