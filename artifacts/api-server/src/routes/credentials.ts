import { Router, type IRouter } from "express";
import {
  ListCredentialsParams,
  ListCredentialsResponse,
  SaveCredentialBody,
  SaveCredentialParams,
  SaveCredentialResponse,
  RevokeCredentialParams,
  RevokeCredentialResponse,
} from "@workspace/api-zod";
import { actorId, requireWorkspaceMembership, requireWorkspaceOwner } from "../middlewares/auth";
import { CredentialService } from "../services/credentials";

const router: IRouter = Router();
const service = new CredentialService();

router.use("/workspaces/:workspaceId/apis/:apiId/credentials", requireWorkspaceMembership);

router.get(
  "/workspaces/:workspaceId/apis/:apiId/credentials",
  async (req, res): Promise<void> => {
    const params = ListCredentialsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid credential identifier", code: "INVALID_INPUT" });
      return;
    }
     res.json(ListCredentialsResponse.parse(await service.list(params.data.workspaceId, params.data.apiId)));
  },
);

router.post(
  "/workspaces/:workspaceId/apis/:apiId/credentials",
  requireWorkspaceOwner,
  async (req, res): Promise<void> => {
    const params = SaveCredentialParams.safeParse(req.params);
    const input = SaveCredentialBody.strict().safeParse(req.body);
    if (!params.success || !input.success) {
      res.status(400).json({ error: "Invalid credential input", code: "INVALID_INPUT" });
      return;
    }
    const saved = await service.createOrReplace(
      params.data.workspaceId,
      params.data.apiId,
      actorId(req),
      input.data,
    );
    res.status(200).json(SaveCredentialResponse.parse(saved));
  },
);

router.delete(
  "/workspaces/:workspaceId/apis/:apiId/credentials/:credentialId",
  requireWorkspaceOwner,
  async (req, res): Promise<void> => {
    const params = RevokeCredentialParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid credential identifier", code: "INVALID_INPUT" });
      return;
    }
    const revoked = await service.revoke(
      params.data.workspaceId,
      params.data.apiId,
      params.data.credentialId,
      actorId(req),
    );
    res.json(RevokeCredentialResponse.parse(revoked));
  },
);

export default router;