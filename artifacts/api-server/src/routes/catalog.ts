import { Router, type IRouter } from "express";
import {
  CreateApiBody,
  CreateApiParams,
  CreateApiResponse,
  GetApiParams,
  GetApiResponse,
  GetOperationParams,
  GetOperationResponse,
  ImportSpecificationBody,
  ImportSpecificationParams,
  ImportSpecificationResponse,
  ListApisParams,
  ListApisResponse,
  ListOperationsParams,
  ListOperationsResponse,
  UpdateOperationStateBody,
  UpdateOperationStateParams,
  UpdateOperationStateResponse,
} from "@workspace/api-zod";
import { CatalogService } from "../services/catalog";
import { requireWorkspaceMembership, requireWorkspaceOwner } from "../middlewares/auth";
import { actorId } from "../middlewares/auth";

const router: IRouter = Router();
const service = new CatalogService();

router.use("/workspaces/:workspaceId", requireWorkspaceMembership);

router.get("/workspaces/:workspaceId/apis", async (req, res): Promise<void> => {
  const params = ListApisParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid workspace identifier" });
    return;
  }
  res.json(ListApisResponse.parse(await service.listApis(params.data.workspaceId)));
});

router.post("/workspaces/:workspaceId/apis", requireWorkspaceOwner, async (req, res): Promise<void> => {
  const params = CreateApiParams.safeParse(req.params);
  const input = CreateApiBody.strict().safeParse(req.body);
  if (!params.success || !input.success) {
    res.status(400).json({
      error: "Invalid API source input",
      code: "INVALID_INPUT",
      details: [
        ...(params.success
          ? []
          : params.error.issues.map((issue) => issue.message)),
        ...(input.success ? [] : input.error.issues.map((issue) => issue.message)),
      ],
    });
    return;
  }
  const api = await service.createApi(params.data.workspaceId, input.data);
  res.status(201).json(CreateApiResponse.parse(api));
});

router.get(
  "/workspaces/:workspaceId/apis/:apiId",
  async (req, res): Promise<void> => {
    const params = GetApiParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid API source identifier" });
      return;
    }
    res.json(
      GetApiResponse.parse(
         await service.getApi(params.data.workspaceId, params.data.apiId, actorId(req)),
      ),
    );
  },
);

router.post(
  "/workspaces/:workspaceId/apis/:apiId/specifications",
  requireWorkspaceOwner,
  async (req, res): Promise<void> => {
    const params = ImportSpecificationParams.safeParse(req.params);
    const input = ImportSpecificationBody.strict().safeParse(req.body);
    if (!params.success || !input.success) {
      res.status(400).json({
        error: "Invalid specification import",
        code: "INVALID_INPUT",
        details: [
          ...(params.success
            ? []
            : params.error.issues.map((issue) => issue.message)),
          ...(input.success ? [] : input.error.issues.map((issue) => issue.message)),
        ],
      });
      return;
    }
    const result = await service.importSpecification(
      params.data.workspaceId,
      params.data.apiId,
      input.data.document,
    );
    res.status(201).json(ImportSpecificationResponse.parse(result));
  },
);

router.get(
  "/workspaces/:workspaceId/apis/:apiId/operations",
  async (req, res): Promise<void> => {
    const params = ListOperationsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid catalog identifier" });
      return;
    }
    res.json(
      ListOperationsResponse.parse(
        await service.listOperations(
          params.data.workspaceId,
          params.data.apiId,
        ),
      ),
    );
  },
);

router.get(
  "/workspaces/:workspaceId/apis/:apiId/operations/:operationId",
  async (req, res): Promise<void> => {
    const params = GetOperationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid operation identifier" });
      return;
    }
    res.json(
      GetOperationResponse.parse(
        await service.getOperation(
          params.data.workspaceId,
          params.data.apiId,
          params.data.operationId,
        ),
      ),
    );
  },
);

router.patch(
  "/workspaces/:workspaceId/apis/:apiId/operations/:operationId",
  requireWorkspaceOwner,
  async (req, res): Promise<void> => {
    const params = UpdateOperationStateParams.safeParse(req.params);
    const input = UpdateOperationStateBody.strict().safeParse(req.body);
    if (!params.success || !input.success) {
      res.status(400).json({
        error: "Invalid operation state update",
        code: "INVALID_INPUT",
      });
      return;
    }
    res.json(
      UpdateOperationStateResponse.parse(
        await service.updateOperationState(
          params.data.workspaceId,
          params.data.apiId,
          params.data.operationId,
          input.data.enabled,
          actorId(req),
        ),
      ),
    );
  },
);

export default router;