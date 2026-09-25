import { Router, type IRouter } from "express";
import {
  AnalyzeApiOperationParams,
  AnalyzeApiOperationResponse,
  DecideSemanticProposalBody,
  DecideSemanticProposalParams,
  DecideSemanticProposalResponse,
  ListSemanticProposalsParams,
  ListSemanticProposalsResponse,
} from "@workspace/api-zod";
import { actorId, requireSameOrigin, requireWorkspaceMembership, requireWorkspaceOwner } from "../middlewares/auth";
import { SemanticAnalysisService } from "../services/semantic-analysis";

const router: IRouter = Router();
const service = new SemanticAnalysisService();

const base = "/workspaces/:workspaceId/apis/:apiId";
router.use(base, requireWorkspaceMembership);

router.post(
  `${base}/operations/:operationId/semantic-analysis`,
  requireWorkspaceOwner,
  requireSameOrigin,
  async (req, res): Promise<void> => {
    const params = AnalyzeApiOperationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid analysis target", code: "INVALID_INPUT" });
      return;
    }
    if (req.body !== undefined && req.body !== null &&
        (typeof req.body !== "object" || Array.isArray(req.body) ||
          Object.keys(req.body as Record<string, unknown>).length !== 0)) {
      res.status(400).json({ error: "Manual analysis accepts no caller-supplied operation data", code: "INVALID_INPUT" });
      return;
    }
    const result = await service.analyze(
      params.data.workspaceId,
      params.data.apiId,
      params.data.operationId,
      actorId(req),
    );
    res.json(AnalyzeApiOperationResponse.parse(result));
  },
);

router.get(
  `${base}/operations/:operationId/semantic-proposals`,
  requireWorkspaceOwner,
  async (req, res): Promise<void> => {
    const params = ListSemanticProposalsParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid proposal target", code: "INVALID_INPUT" });
      return;
    }
    const result = await service.list(
      params.data.workspaceId,
      params.data.apiId,
      params.data.operationId,
      actorId(req),
    );
    res.json(ListSemanticProposalsResponse.parse(result));
  },
);

router.patch(
  `${base}/semantic-proposals/:proposalId`,
  requireWorkspaceOwner,
  requireSameOrigin,
  async (req, res): Promise<void> => {
    const params = DecideSemanticProposalParams.safeParse(req.params);
    const input = DecideSemanticProposalBody.strict().safeParse(req.body);
    if (!params.success || !input.success) {
      res.status(400).json({ error: "Invalid proposal decision", code: "INVALID_INPUT" });
      return;
    }
    const result = await service.decide(
      params.data.workspaceId,
      params.data.apiId,
      params.data.proposalId,
      actorId(req),
      input.data.decision,
    );
    res.json(DecideSemanticProposalResponse.parse(result));
  },
);

export default router;