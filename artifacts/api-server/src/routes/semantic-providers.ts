import { Router, type IRouter } from "express";
import {
  DeleteSemanticProviderKeyParams,
  DeleteSemanticProviderKeyResponse,
  GetSemanticProviderParams,
  GetSemanticProviderResponse,
  SaveSemanticProviderKeyBody,
  SaveSemanticProviderKeyParams,
  SaveSemanticProviderKeyResponse,
  SetSemanticProviderReadyBody,
  SetSemanticProviderReadyParams,
  SetSemanticProviderReadyResponse,
  TestSemanticProviderParams,
  TestSemanticProviderResponse,
} from "@workspace/api-zod";
import {
  actorId,
  requireSameOrigin,
  requireWorkspaceMembership,
  requireWorkspaceOwner,
} from "../middlewares/auth";
import { SemanticProviderService } from "../services/semantic-providers";

const router: IRouter = Router();
const service = new SemanticProviderService();
const route = "/workspaces/:workspaceId/semantic-providers/jev";

router.use(route, requireWorkspaceMembership);

router.get(route, requireWorkspaceOwner, async (req, res): Promise<void> => {
  const params = GetSemanticProviderParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid workspace identifier", code: "INVALID_INPUT" });
    return;
  }
  res.json(GetSemanticProviderResponse.parse(await service.getMetadata(
    params.data.workspaceId,
    actorId(req),
  )));
});

router.put(route, requireWorkspaceOwner, requireSameOrigin, async (req, res): Promise<void> => {
  const params = SaveSemanticProviderKeyParams.safeParse(req.params);
  const input = SaveSemanticProviderKeyBody.strict().safeParse(req.body);
  if (!params.success || !input.success) {
    res.status(400).json({ error: "Invalid semantic provider key input", code: "INVALID_INPUT" });
    return;
  }
  const metadata = await service.saveKey(
    params.data.workspaceId,
    actorId(req),
    input.data.secret,
  );
  res.json(SaveSemanticProviderKeyResponse.parse(metadata));
});

router.delete(route, requireWorkspaceOwner, requireSameOrigin, async (req, res): Promise<void> => {
  const params = DeleteSemanticProviderKeyParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid workspace identifier", code: "INVALID_INPUT" });
    return;
  }
  const result = await service.deleteKey(params.data.workspaceId, actorId(req));
  res.json(DeleteSemanticProviderKeyResponse.parse(result));
});

router.patch(
  `${route}/ready`,
  requireWorkspaceOwner,
  requireSameOrigin,
  async (req, res): Promise<void> => {
    const params = SetSemanticProviderReadyParams.safeParse(req.params);
    const input = SetSemanticProviderReadyBody.strict().safeParse(req.body);
    if (!params.success || !input.success) {
      res.status(400).json({ error: "Invalid semantic provider readiness input", code: "INVALID_INPUT" });
      return;
    }
    const metadata = await service.setReady(
      params.data.workspaceId,
      actorId(req),
      input.data.enabled,
    );
    res.json(SetSemanticProviderReadyResponse.parse(metadata));
  },
);

router.post(
  `${route}/test`,
  requireWorkspaceOwner,
  requireSameOrigin,
  async (req, res): Promise<void> => {
    const params = TestSemanticProviderParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid workspace identifier", code: "INVALID_INPUT" });
      return;
    }
    if (
      req.body !== undefined &&
      req.body !== null &&
      (typeof req.body !== "object" ||
        Array.isArray(req.body) ||
        Object.keys(req.body as Record<string, unknown>).length > 0)
    ) {
      res.status(400).json({
        error: "Provider tests do not accept caller-supplied payloads",
        code: "INVALID_INPUT",
      });
      return;
    }
    const result = await service.test(params.data.workspaceId, actorId(req));
    res.json(TestSemanticProviderResponse.parse(result));
  },
);

export default router;