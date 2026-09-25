import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  AnalyzeApiOperationBody,
  AnalyzeApiOperationParams,
  AnalyzeApiOperationResponse,
  ConfirmSemanticAnalysisBody,
  ConfirmSemanticAnalysisParams,
  ConfirmSemanticAnalysisResponse,
  DecideSemanticProposalBody,
  DecideSemanticProposalParams,
  DecideSemanticProposalResponse,
  ListSemanticProposalsParams,
  ListSemanticProposalsResponse,
  PrepareSemanticAnalysisParams,
  PrepareSemanticAnalysisResponse,
  PreviewSemanticMcpPublicationParams,
  PreviewSemanticMcpPublicationResponse,
  PublishSemanticMcpDescriptionParams,
  PublishSemanticMcpDescriptionBody,
  PublishSemanticMcpDescriptionResponse,
  RevokeSemanticMcpDescriptionParams,
  RevokeSemanticMcpDescriptionResponse,
} from "@workspace/api-zod";
import { actorId, requireSameOrigin, requireWorkspaceMembership, requireWorkspaceOwner } from "../middlewares/auth";
import { SemanticAnalysisService } from "../services/semantic-analysis";
import { recordSemanticAnalysisDenial, semanticAnalysisRequestCategory } from "../services/semantic-analysis-denial-audit";
import { SemanticMcpPublicationService } from "../services/semantic-mcp-publication";

const router: IRouter = Router();
const service = new SemanticAnalysisService();
const publication = new SemanticMcpPublicationService();

const base = "/workspaces/:workspaceId/apis/:apiId";

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
  const requestCategory = semanticAnalysisRequestCategory(req.method, `${req.baseUrl}${req.path}`) ?? "dispatch";
  await requireWorkspaceOwner(req, res, () => { passed = true; next(); }, () =>
    recordSemanticAnalysisDenial(actorId(req), requestCategory, "workspace_unavailable"));
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
  `${base}/operations/:operationId/semantic-analysis/confirm`,
  requireAnalysisOwner,
  requireAnalysisOrigin,
  async (req, res): Promise<void> => {
    const params = ConfirmSemanticAnalysisParams.safeParse(req.params);
    const input = ConfirmSemanticAnalysisBody.strict().safeParse(req.body);
    if (!params.success || !input.success) {
      if (!isRecordBody(req.body) || req.body.confirmedNoSensitiveData !== true) {
        try {
          await service.recordConfirmationDenial(actorId(req));
        } catch { /* Preserve the original request validation response. */ }
      } else {
        await recordEarlyDenial(req, "invalid_request");
      }
      res.status(400).json({ error: "A valid reviewed payload handle and explicit confirmation are required", code: "INVALID_INPUT" });
      return;
    }
    const result = await service.confirm(
      params.data.workspaceId,
      params.data.apiId,
      params.data.operationId,
      actorId(req),
      input.data.preflightHandle,
      input.data.confirmedNoSensitiveData,
    );
    res.json(ConfirmSemanticAnalysisResponse.parse(result));
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
      res.status(400).json({ error: "A valid single-use dispatch token is required", code: "INVALID_INPUT" });
      return;
    }
    const result = await service.analyze(
      params.data.workspaceId,
      params.data.apiId,
      params.data.operationId,
      actorId(req),
      input.data.dispatchToken,
    );
    res.json(AnalyzeApiOperationResponse.parse(result));
  },
);

function isRecordBody(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

router.use(base, requireWorkspaceMembership);

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

router.post(
  `${base}/semantic-proposals/:proposalId/mcp-publication/preview`,
  requireWorkspaceOwner,
  requireSameOrigin,
  async (req, res): Promise<void> => {
    const params = PreviewSemanticMcpPublicationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid publication target", code: "INVALID_INPUT" });
      return;
    }
    const result = await publication.preview(
      params.data.workspaceId, params.data.apiId, params.data.proposalId, actorId(req),
    );
    res.json(PreviewSemanticMcpPublicationResponse.parse(result));
  },
);

router.post(
  `${base}/semantic-proposals/:proposalId/mcp-publication`,
  requireWorkspaceOwner,
  requireSameOrigin,
  async (req, res): Promise<void> => {
    const params = PublishSemanticMcpDescriptionParams.safeParse(req.params);
    const input = PublishSemanticMcpDescriptionBody.strict().safeParse(req.body);
    if (!params.success || !input.success) {
      res.status(400).json({ error: "Invalid publication confirmation", code: "INVALID_INPUT" });
      return;
    }
    const result = await publication.publish(
      params.data.workspaceId, params.data.apiId, params.data.proposalId, actorId(req), input.data.previewToken,
    );
    res.json(PublishSemanticMcpDescriptionResponse.parse(result));
  },
);

router.delete(
  `${base}/semantic-proposals/:proposalId/mcp-publication`,
  requireWorkspaceOwner,
  requireSameOrigin,
  async (req, res): Promise<void> => {
    const params = RevokeSemanticMcpDescriptionParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid publication target", code: "INVALID_INPUT" });
      return;
    }
    const result = await publication.revoke(
      params.data.workspaceId, params.data.apiId, params.data.proposalId, actorId(req),
    );
    res.json(RevokeSemanticMcpDescriptionResponse.parse(result));
  },
);

export default router;