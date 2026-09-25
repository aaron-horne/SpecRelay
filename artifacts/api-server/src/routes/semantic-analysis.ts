import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  AnalyzeApiOperationBody,
  AnalyzeApiOperationParams,
  AnalyzeApiOperationResponse,
  DecideSemanticProposalBody,
  DecideSemanticProposalParams,
  DecideSemanticProposalResponse,
  ListSemanticProposalsParams,
  ListSemanticProposalsResponse,
  PrepareSemanticAnalysisParams,
  PrepareSemanticAnalysisResponse,
} from "@workspace/api-zod";
import { actorId, requireSameOrigin, requireWorkspaceMembership, requireWorkspaceOwner } from "../middlewares/auth";
import { SemanticAnalysisService } from "../services/semantic-analysis";

const router: IRouter = Router();
const service = new SemanticAnalysisService();

const base = "/workspaces/:workspaceId/apis/:apiId";
router.use(base, requireWorkspaceMembership);

async function recordEarlyDenial(req: Request, reason: "owner_required" | "origin_invalid" | "invalid_request") {
  try {
    await service.recordEarlyDenial(
      String(req.params.workspaceId), String(req.params.apiId), String(req.params.operationId), actorId(req), reason,
    );
  } catch {
    // Preserve the original authorization or validation response if the workspace was removed.
  }
}

async function requireAnalysisOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  let passed = false;
  await requireWorkspaceOwner(req, res, () => { passed = true; next(); });
  if (!passed) await recordEarlyDenial(req, "owner_required");
}

async function requireAnalysisOrigin(req: Request, res: Response, next: NextFunction): Promise<void> {
  let passed = false;
  requireSameOrigin(req, res, () => { passed = true; next(); });
  if (!passed) await recordEarlyDenial(req, "origin_invalid");
}

router.post(
  `${base}/operations/:operationId/semantic-analysis/preflight`,
  requireAnalysisOwner,
  requireAnalysisOrigin,
  async (req, res): Promise<void> => {
    const params = PrepareSemanticAnalysisParams.safeParse(req.params);
    if (!params.success) {
      await recordEarlyDenial(req, "invalid_request");
      res.status(400).json({ error: "Invalid analysis target", code: "INVALID_INPUT" });
      return;
    }
    if (req.body !== undefined && req.body !== null &&
        (typeof req.body !== "object" || Array.isArray(req.body) ||
          Object.keys(req.body as Record<string, unknown>).length !== 0)) {
      await recordEarlyDenial(req, "invalid_request");
      res.status(400).json({ error: "Preflight accepts no caller-supplied operation data", code: "INVALID_INPUT" });
      return;
    }
    const result = await service.prepare(
      params.data.workspaceId, params.data.apiId, params.data.operationId, actorId(req),
    );
    res.json(PrepareSemanticAnalysisResponse.parse(result));
  },
);

router.post(
  `${base}/operations/:operationId/semantic-analysis`,
  requireAnalysisOwner,
  requireAnalysisOrigin,
  async (req, res): Promise<void> => {
    const params = AnalyzeApiOperationParams.safeParse(req.params);
    if (!params.success) {
      await recordEarlyDenial(req, "invalid_request");
      res.status(400).json({ error: "Invalid analysis target", code: "INVALID_INPUT" });
      return;
    }
    const input = AnalyzeApiOperationBody.strict().safeParse(req.body);
    if (!input.success) {
      await recordEarlyDenial(req, "invalid_request");
      res.status(400).json({ error: "A valid preflight token is required", code: "INVALID_INPUT" });
      return;
    }
    const result = await service.analyze(
      params.data.workspaceId,
      params.data.apiId,
      params.data.operationId,
      actorId(req),
      input.data.preflightToken,
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