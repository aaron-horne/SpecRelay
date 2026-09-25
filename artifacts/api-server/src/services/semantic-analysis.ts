import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import {
  apiOperationsTable,
  apiSourcesTable,
  apiSpecVersionsTable,
  auditEventsTable,
  db,
  semanticAnalysisPreflightTokensTable,
  semanticAnalysisProposalsTable,
  semanticProviderConfigsTable,
  workspaceMembershipsTable,
  workspacesTable,
} from "@workspace/db";
import { decryptSemanticProviderSecret } from "./credential-crypto";
import {
  JevSemanticAnalysisAdapter,
  serializeJevRequest,
  type JevAnalysisJudgment,
  type JevCandidate,
  type JevOperationInput,
  type SemanticAnalysisAdapter,
} from "./semantic-analysis-adapter";
import { ServiceError } from "./errors";

const PROVIDER = "jev";
const RATE_WINDOW_MS = 60_000;
const PREFLIGHT_TTL_MS = 2 * 60_000;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OperationRow = typeof apiOperationsTable.$inferSelect;
type ProposalRow = typeof semanticAnalysisProposalsTable.$inferSelect;
type SpecificationRow = typeof apiSpecVersionsTable.$inferSelect;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function requireRollout(workspaceId: string): void {
  if (process.env.SEMANTIC_PROVIDERS_ENABLED !== "true") {
    throw new ServiceError("Jev analysis is disabled", 503, "SEMANTIC_PROVIDERS_DISABLED");
  }
  const ids = process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS?.split(",").map((item) => item.trim()) ?? [];
  if (!ids.length || !ids.every((id) => WORKSPACE_ID_PATTERN.test(id)) ||
      !ids.some((id) => id.toLowerCase() === workspaceId.toLowerCase())) {
    throw new ServiceError("Jev analysis is not available for this workspace", 503, "SEMANTIC_PROVIDER_WORKSPACE_NOT_ALLOWED");
  }
}

async function lockOwner(tx: Tx, workspaceId: string, actorId: string): Promise<void> {
  const [workspace] = await tx.select({ id: workspacesTable.id }).from(workspacesTable)
    .where(and(eq(workspacesTable.id, workspaceId), eq(workspacesTable.isLive, true), isNull(workspacesTable.deletedAt)))
    .for("update").limit(1);
  if (!workspace) throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
  const [membership] = await tx.select({ role: workspaceMembershipsTable.role }).from(workspaceMembershipsTable)
    .where(and(eq(workspaceMembershipsTable.workspaceId, workspaceId), eq(workspaceMembershipsTable.userId, actorId)))
    .for("share").limit(1);
  if (!membership) throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
  if (membership.role !== "OWNER") throw new ServiceError("Workspace owner access required", 403, "OWNER_REQUIRED");
}

async function acquireApiLock(tx: Tx, workspaceId: string, apiId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${apiId}`}))`);
}

function safeText(value: string | null | undefined, maxLength: number): string | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const trimmed = value.trim();
  const sensitive = /\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|authorization|credential|bearer|secret)\b/i;
  const identifiable = /https?:\/\/|(?:\[[0-9a-f:]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d{2,5})?|\b(?:localhost|[a-z0-9-]+:\d{2,5})\b|\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b|\b(?:sk|pk|tok|key|token|secret)_[A-Za-z0-9_-]{8,}\b|\b[A-Za-z0-9_-]{40,}\b/i;
  if (sensitive.test(trimmed) || identifiable.test(trimmed) || /[^\P{Cc}\t\n\r]/u.test(trimmed)) {
    throw new ServiceError("Operation content cannot be safely prepared", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
  }
  const normalized = trimmed.replace(/\s+/g, " ");
  if (normalized.length > maxLength) {
    throw new ServiceError("Operation content exceeds the safe preparation limit", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
  }
  return normalized;
}

function safeMethod(method: string): string {
  const normalized = method.toUpperCase();
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE)$/.test(normalized)) {
    throw new ServiceError("Operation method cannot be safely prepared", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
  }
  return normalized;
}

function safePath(rawPath: string): string {
  if (!rawPath.startsWith("/") || rawPath.length > 512 || /[?#\s]/.test(rawPath)) {
    throw new ServiceError("Operation path cannot be safely prepared", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
  }
  const segments = rawPath.split("/").slice(1);
  if (segments.length > 16) throw new ServiceError("Operation path cannot be safely prepared", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
  return `/${segments.map((part) => part.startsWith("{") && part.endsWith("}") ? "{parameter}" : "{segment}").join("/")}`;
}

type Prepared = {
  input: JevOperationInput;
  candidates: JevCandidate[];
  sources: Map<string, string>;
};

function operationInput(operation: OperationRow): Prepared {
  if (operation.parameters.length > 6 || operation.responses.length > 4) {
    throw new ServiceError("Operation has too many descriptions to safely prepare", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
  }
  const summary = safeText(operation.summary, 240);
  const description = safeText(operation.description, 420);
  const parameters = operation.parameters.map((item) => {
    if (!["path", "query", "header", "cookie"].includes(item.location) || typeof item.required !== "boolean") {
      throw new ServiceError("Operation parameter structure cannot be safely prepared", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
    }
    const schemaType = item.schemaType && ["string", "integer", "number", "boolean", "array", "object"].includes(item.schemaType)
      ? item.schemaType : null;
    const preparedDescription = safeText(item.description, 120);
    return { location: item.location, required: item.required, schemaType, description: preparedDescription };
  });
  const responses = operation.responses.map((item) => {
    const status = /^(?:[1-5][0-9]{2}|default)$/.test(item.statusCode) ? item.statusCode : "other";
    return { status, description: safeText(item.description, 120) };
  });
  const input: JevOperationInput = {
    method: safeMethod(operation.method),
    path: safePath(operation.path),
    summary,
    description,
    parameters: parameters.map(({ location, required, schemaType, description: text }) => ({
      location,
      required,
      ...(schemaType ? { schemaType } : {}),
      ...(text ? { description: text } : {}),
    })) as JevOperationInput["parameters"],
    responses: responses.map(({ status, description: text }) => ({ status, ...(text ? { description: text } : {}) })) as JevOperationInput["responses"],
  };
  const candidates: JevCandidate[] = [];
  const sources = new Map<string, string>();
  const add = (sourceField: string, text: string | null) => {
    if (text) {
      const id = `c${candidates.length + 1}`;
      candidates.push({ id, sourceField, text });
      sources.set(sourceField, text);
    }
  };
  add("summary", summary);
  add("description", description);
  parameters.forEach((parameter, index) => add(`parameter_description:${index}`, parameter.description));
  responses.forEach((response, index) => add(`response_description:${index}`, response.description));
  if (candidates.length > 8) {
    throw new ServiceError("Operation has too many candidate descriptions to safely prepare", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
  }
  return { input, candidates, sources };
}

async function currentSourceOperation(
  tx: Tx,
  workspaceId: string,
  apiId: string,
  operationId: string,
): Promise<{ specification: SpecificationRow; operation: OperationRow }> {
  const [specification] = await tx.select().from(apiSpecVersionsTable).where(and(
    eq(apiSpecVersionsTable.workspaceId, workspaceId),
    eq(apiSpecVersionsTable.apiId, apiId),
    eq(apiSpecVersionsTable.isActive, true),
  )).limit(1);
  if (!specification) throw new ServiceError("Operation not found", 404, "OPERATION_NOT_FOUND");
  const [operation] = await tx.select().from(apiOperationsTable).where(and(
    eq(apiOperationsTable.workspaceId, workspaceId),
    eq(apiOperationsTable.apiId, apiId),
    eq(apiOperationsTable.specificationId, specification.id),
    eq(apiOperationsTable.id, operationId),
  )).limit(1);
  if (!operation) throw new ServiceError("Operation not found", 404, "OPERATION_NOT_FOUND");
  return { specification, operation };
}

async function requireReadyCredential(tx: Tx, workspaceId: string) {
  requireRollout(workspaceId);
  const [row] = await tx.select().from(semanticProviderConfigsTable).where(and(
    eq(semanticProviderConfigsTable.workspaceId, workspaceId),
    eq(semanticProviderConfigsTable.workspaceIsLive, true),
    eq(semanticProviderConfigsTable.provider, PROVIDER),
  )).limit(1);
  if (!row?.enabled || !row.secretCiphertext || row.lastTestOutcome !== "success" ||
      row.testedRevision !== row.credentialRevision) {
    throw new ServiceError("A Ready Jev credential successfully tested at its current revision is required", 409, "SEMANTIC_ANALYSIS_NOT_READY");
  }
  if (!row.secretIv || !row.secretAuthTag || !row.keyId || row.keyVersion === null) {
    throw new ServiceError("Provider key is unavailable", 503, "SEMANTIC_PROVIDER_KEY_UNAVAILABLE");
  }
  let secret: string;
  try {
    secret = decryptSemanticProviderSecret({
      ciphertext: row.secretCiphertext, iv: row.secretIv, authTag: row.secretAuthTag,
      keyId: row.keyId, keyVersion: row.keyVersion,
    }, { workspaceId, provider: PROVIDER, credentialId: row.id });
  } catch {
    throw new ServiceError("Provider key cannot be decrypted", 503, "SEMANTIC_PROVIDER_KEY_UNAVAILABLE");
  }
  return { row, secret };
}

function proposalView(row: ProposalRow) {
  return {
    id: row.id, workspaceId: row.workspaceId, apiId: row.apiId, specificationId: row.specificationId,
    operationId: row.operationId, proposalText: row.proposalText, proposalKind: "description" as const,
    confidence: row.confidence, uncertainty: row.uncertainty, sourceField: row.sourceField,
    status: row.status, createdAt: row.createdAt, decidedAt: row.decidedAt,
  };
}

async function auditDenied(
  workspaceId: string,
  apiId: string,
  operationId: string,
  actorId: string,
  reason: string,
  eventType = "semantic_analysis.preflight_denied",
) {
  const safeApiId = WORKSPACE_ID_PATTERN.test(apiId) ? apiId : null;
  const safeOperationId = WORKSPACE_ID_PATTERN.test(operationId) ? operationId : null;
  await db.insert(auditEventsTable).values({
    workspaceId,
    eventType,
    resourceType: "api_operation",
    resourceId: safeOperationId,
    metadata: { actorId, apiId: safeApiId, reasonCategory: reason },
  });
}

function reasonCategory(error: unknown): string {
  if (error instanceof ServiceError) {
    if (error.code.includes("REDACTION")) return "unsafe_source";
    if (error.code.includes("RATE_LIMIT")) return "rate_limited";
    if (error.code.includes("READY")) return "credential_not_ready";
    if (error.code.includes("OWNER")) return "owner_required";
    if (error.code.includes("NOT_FOUND")) return "target_unavailable";
    if (error.code.includes("DISABLED") || error.code.includes("WORKSPACE_NOT_ALLOWED")) return "rollout_unavailable";
  }
  return "preflight_failed";
}

export class SemanticAnalysisService {
  constructor(private readonly adapter: SemanticAnalysisAdapter = new JevSemanticAnalysisAdapter()) {}

  async recordEarlyDenial(workspaceId: string, apiId: string, operationId: string, actorId: string, reason: "owner_required" | "origin_invalid" | "invalid_request") {
    await auditDenied(workspaceId, apiId, operationId, actorId, reason, "semantic_analysis.request_denied");
  }

  async prepare(workspaceId: string, apiId: string, operationId: string, actorId: string) {
    try {
      return await db.transaction(async (tx) => {
        await acquireApiLock(tx, workspaceId, apiId);
        await lockOwner(tx, workspaceId, actorId);
        requireRollout(workspaceId);
        const { specification, operation } = await currentSourceOperation(tx, workspaceId, apiId, operationId);
        const { row: credential } = await requireReadyCredential(tx, workspaceId);
        const prepared = operationInput(operation);
        if (!prepared.candidates.length) throw new ServiceError("Operation has no eligible source descriptions", 400, "SEMANTIC_ANALYSIS_NO_CANDIDATES");
        const payload = serializeJevRequest(prepared.input, prepared.candidates);
        if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 8_192) {
          throw new ServiceError("Operation exceeds the safe preparation size limit", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
        }
        const payloadDigest = digest(payload);
        const token = randomUUID();
        const expiresAt = new Date(Date.now() + PREFLIGHT_TTL_MS);
        await tx.delete(semanticAnalysisPreflightTokensTable)
          .where(lt(semanticAnalysisPreflightTokensTable.expiresAt, new Date()));
        await tx.insert(semanticAnalysisPreflightTokensTable).values({
          tokenHash: digest(token), actorId, workspaceId, workspaceIsLive: true, apiId, operationId,
          specificationId: specification.id, documentHash: specification.documentHash,
          credentialId: credential.id, credentialRevision: credential.credentialRevision,
          payloadDigest, expiresAt,
        });
        await tx.insert(auditEventsTable).values({
          workspaceId, eventType: "semantic_analysis.preflight_created",
          resourceType: "api_operation", resourceId: operationId,
          metadata: { actorId, apiId, specificationId: specification.id, credentialRevision: credential.credentialRevision },
        });
        return { preflightToken: token, expiresAt, payload };
      });
    } catch (error) {
      try {
        await auditDenied(workspaceId, apiId, operationId, actorId, reasonCategory(error));
      } catch { /* Preserve the original, non-sensitive preflight error. */ }
      throw error;
    }
  }

  async analyze(workspaceId: string, apiId: string, operationId: string, actorId: string, preflightToken: string) {
    const tokenHash = digest(preflightToken);
    const reservation = await db.transaction(async (tx) => {
      await acquireApiLock(tx, workspaceId, apiId);
      await lockOwner(tx, workspaceId, actorId);
      requireRollout(workspaceId);
      const [token] = await tx.select().from(semanticAnalysisPreflightTokensTable).where(and(
        eq(semanticAnalysisPreflightTokensTable.tokenHash, tokenHash),
        eq(semanticAnalysisPreflightTokensTable.actorId, actorId),
        eq(semanticAnalysisPreflightTokensTable.workspaceId, workspaceId),
        eq(semanticAnalysisPreflightTokensTable.apiId, apiId),
        eq(semanticAnalysisPreflightTokensTable.operationId, operationId),
      )).for("update").limit(1);
      if (!token || token.consumedAt || token.expiresAt.getTime() <= Date.now()) {
        throw new ServiceError("Preflight token is invalid, expired, or already used", 409, "SEMANTIC_ANALYSIS_PREFLIGHT_INVALID");
      }
      const { specification, operation } = await currentSourceOperation(tx, workspaceId, apiId, operationId);
      const { row: credential, secret } = await requireReadyCredential(tx, workspaceId);
      const prepared = operationInput(operation);
      const payload = serializeJevRequest(prepared.input, prepared.candidates);
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > 8_192) {
        throw new ServiceError("Operation exceeds the safe preparation size limit", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
      }
      if (specification.id !== token.specificationId || specification.documentHash !== token.documentHash ||
          credential.id !== token.credentialId || credential.credentialRevision !== token.credentialRevision ||
          digest(payload) !== token.payloadDigest) {
        throw new ServiceError("Operation, specification, or Jev configuration changed after preflight", 409, "SEMANTIC_ANALYSIS_PREFLIGHT_STALE");
      }
      const [recent] = await tx.select({ id: auditEventsTable.id }).from(auditEventsTable).where(and(
        eq(auditEventsTable.workspaceId, workspaceId),
        eq(auditEventsTable.eventType, "semantic_analysis.reserved"),
        gte(auditEventsTable.createdAt, sql`now() - (${RATE_WINDOW_MS} * interval '1 millisecond')`),
      )).limit(1);
      if (recent) throw new ServiceError("Jev analysis rate limit is active", 409, "SEMANTIC_ANALYSIS_RATE_LIMITED");
      const reservationId = randomUUID();
      await tx.update(semanticAnalysisPreflightTokensTable).set({ consumedAt: new Date() })
        .where(and(eq(semanticAnalysisPreflightTokensTable.tokenHash, tokenHash), isNull(semanticAnalysisPreflightTokensTable.consumedAt)));
      const metadata = {
        actorId, provider: PROVIDER, apiId, specificationId: specification.id, operationId,
        credentialRevision: credential.credentialRevision, reservationId,
      };
      await tx.insert(auditEventsTable).values([
        { workspaceId, eventType: "semantic_analysis.requested", resourceType: "api_operation", resourceId: operationId, metadata },
        { workspaceId, eventType: "semantic_analysis.reserved", resourceType: "api_operation", resourceId: operationId, metadata },
      ]);
      return {
        specificationId: specification.id, documentHash: specification.documentHash, operation,
        credential, secret, input: prepared.input, candidates: prepared.candidates, payloadDigest: token.payloadDigest, reservationId,
      };
    }).catch(async (error: unknown) => {
      try {
        await auditDenied(workspaceId, apiId, operationId, actorId, reasonCategory(error), "semantic_analysis.request_denied");
      } catch { /* Preserve the original, non-sensitive confirmation error. */ }
      throw error;
    });

    let judgment: JevAnalysisJudgment;
    try {
      const attempt = await db.transaction(async (tx) => {
        await acquireApiLock(tx, workspaceId, apiId);
        await lockOwner(tx, workspaceId, actorId);
        requireRollout(workspaceId);
        const { specification, operation } = await currentSourceOperation(tx, workspaceId, apiId, operationId);
        const { row: credential, secret } = await requireReadyCredential(tx, workspaceId);
        const prepared = operationInput(operation);
        const payload = serializeJevRequest(prepared.input, prepared.candidates);
        if (specification.id !== reservation.specificationId || specification.documentHash !== reservation.documentHash ||
            credential.id !== reservation.credential.id || credential.credentialRevision !== reservation.credential.credentialRevision ||
            digest(payload) !== reservation.payloadDigest) {
          throw new ServiceError("Operation or Jev configuration changed before analysis", 409, "SEMANTIC_ANALYSIS_REVISION_CONFLICT");
        }
        return this.adapter.dispatch(secret, prepared.input, prepared.candidates);
      });
      judgment = await attempt.judgment;
    } catch (error) {
      await db.insert(auditEventsTable).values({
        workspaceId, eventType: "semantic_analysis.outcome", resourceType: "api_operation", resourceId: operationId,
        metadata: {
          actorId, provider: PROVIDER, apiId, specificationId: reservation.specificationId,
          outcome: error instanceof ServiceError ? "not_dispatched" : "provider_error",
          reservationId: reservation.reservationId,
          ...(error instanceof ServiceError ? { reasonCode: error.code } : {}),
        },
      });
      if (error instanceof ServiceError) throw error;
      throw new ServiceError("Jev analysis could not be completed", 502, "SEMANTIC_ANALYSIS_PROVIDER_ERROR");
    }

    try {
      return await db.transaction(async (tx) => {
        await acquireApiLock(tx, workspaceId, apiId);
        await lockOwner(tx, workspaceId, actorId);
        requireRollout(workspaceId);
        const { specification, operation } = await currentSourceOperation(tx, workspaceId, apiId, operationId);
        const { row: credential } = await requireReadyCredential(tx, workspaceId);
        const prepared = operationInput(operation);
        const payload = serializeJevRequest(prepared.input, prepared.candidates);
        if (specification.id !== reservation.specificationId || specification.documentHash !== reservation.documentHash ||
            credential.id !== reservation.credential.id || credential.credentialRevision !== reservation.credential.credentialRevision ||
            digest(payload) !== reservation.payloadDigest) {
          throw new ServiceError("Operation or Jev configuration changed during analysis; result discarded", 409, "SEMANTIC_ANALYSIS_REVISION_CONFLICT");
        }
        const candidate = judgment.abstained ? undefined : reservation.candidates.find((item) => item.id === judgment.candidateId);
        const selected = candidate && judgment.confidence >= 0.55 ? candidate : undefined;
        let proposal: ProposalRow | null = null;
        if (selected) {
          const sourceText = prepared.sources.get(selected.sourceField);
          if (!sourceText || sourceText !== selected.text) {
            throw new ServiceError("Proposal source changed during analysis", 409, "SEMANTIC_ANALYSIS_REVISION_CONFLICT");
          }
          [proposal] = await tx.insert(semanticAnalysisProposalsTable).values({
            workspaceId, apiId, specificationId: reservation.specificationId,
            sourceDocumentHash: reservation.documentHash, operationId,
            providerConfigId: reservation.credential.id,
            credentialRevision: reservation.credential.credentialRevision,
            proposalText: selected.text, proposalKind: "description",
            confidence: judgment.confidence, uncertainty: 1 - judgment.confidence,
            sourceField: selected.sourceField, createdBy: actorId,
          }).returning();
        }
        const outcome = proposal ? "proposal" : "abstained";
        await tx.insert(auditEventsTable).values({
          workspaceId, eventType: "semantic_analysis.outcome", resourceType: "api_operation", resourceId: operationId,
          metadata: {
            actorId, provider: PROVIDER, apiId, specificationId: reservation.specificationId,
            operationId, credentialRevision: reservation.credential.credentialRevision,
            outcome, confidence: judgment.confidence, reservationId: reservation.reservationId,
          },
        });
        if (proposal) {
          await tx.insert(auditEventsTable).values({
            workspaceId, eventType: "semantic_analysis.proposal_created",
            resourceType: "semantic_analysis_proposal", resourceId: proposal.id,
            metadata: { actorId, apiId, specificationId: reservation.specificationId, operationId, confidence: proposal.confidence },
          });
        }
        return {
          outcome, specificationId: reservation.specificationId, operationId,
          confidence: judgment.confidence, uncertainty: 1 - judgment.confidence,
          proposal: proposal ? proposalView(proposal) : null,
        };
      });
    } catch (error) {
      await db.insert(auditEventsTable).values({
        workspaceId, eventType: "semantic_analysis.outcome", resourceType: "api_operation", resourceId: operationId,
        metadata: {
          actorId, provider: PROVIDER, apiId, specificationId: reservation.specificationId,
          outcome: "discarded", reservationId: reservation.reservationId,
          reasonCode: error instanceof ServiceError ? error.code : "PERSISTENCE_ERROR",
        },
      });
      throw error;
    }
  }

  async list(workspaceId: string, apiId: string, operationId: string, actorId: string) {
    return db.transaction(async (tx) => {
      await acquireApiLock(tx, workspaceId, apiId);
      await lockOwner(tx, workspaceId, actorId);
      const [api] = await tx.select({ id: apiSourcesTable.id }).from(apiSourcesTable)
        .where(and(eq(apiSourcesTable.workspaceId, workspaceId), eq(apiSourcesTable.id, apiId))).limit(1);
      if (!api) throw new ServiceError("API source not found", 404, "API_NOT_FOUND");
      let active: { specification: SpecificationRow; sources: Map<string, string> } | null = null;
      try {
        const current = await currentSourceOperation(tx, workspaceId, apiId, operationId);
        active = { specification: current.specification, sources: operationInput(current.operation).sources };
      } catch { active = null; }
      const rows = await tx.select().from(semanticAnalysisProposalsTable).where(and(
        eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
        eq(semanticAnalysisProposalsTable.apiId, apiId),
        eq(semanticAnalysisProposalsTable.operationId, operationId),
      )).orderBy(desc(semanticAnalysisProposalsTable.createdAt));
      const stale = rows.filter((row) => row.status !== "stale" && (
        !active || row.specificationId !== active.specification.id ||
        row.sourceDocumentHash !== active.specification.documentHash ||
        active.sources.get(row.sourceField) !== row.proposalText
      ));
      for (const row of stale) {
        await tx.update(semanticAnalysisProposalsTable).set({ status: "stale", decidedAt: new Date() })
          .where(and(eq(semanticAnalysisProposalsTable.id, row.id), eq(semanticAnalysisProposalsTable.status, row.status)));
        await tx.insert(auditEventsTable).values({
          workspaceId, eventType: "semantic_analysis.proposal_stale", resourceType: "semantic_analysis_proposal",
          resourceId: row.id, metadata: { actorId, apiId, specificationId: row.specificationId, operationId },
        });
      }
      const updated = await tx.select().from(semanticAnalysisProposalsTable).where(and(
        eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
        eq(semanticAnalysisProposalsTable.apiId, apiId),
        eq(semanticAnalysisProposalsTable.operationId, operationId),
      )).orderBy(desc(semanticAnalysisProposalsTable.createdAt));
      return updated.map(proposalView);
    });
  }

  async decide(workspaceId: string, apiId: string, proposalId: string, actorId: string, decision: "accepted" | "rejected") {
    const result = await db.transaction(async (tx) => {
      await acquireApiLock(tx, workspaceId, apiId);
      await lockOwner(tx, workspaceId, actorId);
      const { row: credential } = await requireReadyCredential(tx, workspaceId);
      const [proposal] = await tx.select().from(semanticAnalysisProposalsTable).where(and(
        eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
        eq(semanticAnalysisProposalsTable.apiId, apiId),
        eq(semanticAnalysisProposalsTable.id, proposalId),
      )).for("update").limit(1);
      if (!proposal) throw new ServiceError("Semantic proposal not found", 404, "SEMANTIC_PROPOSAL_NOT_FOUND");
      let current: { specification: SpecificationRow; sources: Map<string, string> } | null = null;
      try {
        const resolved = await currentSourceOperation(tx, workspaceId, apiId, proposal.operationId);
        current = { specification: resolved.specification, sources: operationInput(resolved.operation).sources };
      } catch { current = null; }
      const sourceValid = !!current &&
        proposal.specificationId === current.specification.id &&
        proposal.sourceDocumentHash === current.specification.documentHash &&
        current.sources.get(proposal.sourceField) === proposal.proposalText;
      if (!sourceValid) {
        if (proposal.status !== "stale") {
          await tx.update(semanticAnalysisProposalsTable).set({ status: "stale", decidedAt: new Date() })
            .where(eq(semanticAnalysisProposalsTable.id, proposal.id));
          await tx.insert(auditEventsTable).values({
            workspaceId, eventType: "semantic_analysis.proposal_stale", resourceType: "semantic_analysis_proposal",
            resourceId: proposal.id, metadata: { actorId, apiId, specificationId: proposal.specificationId, operationId: proposal.operationId },
          });
        }
        return null;
      }
      if (proposal.providerConfigId !== credential.id || proposal.credentialRevision !== credential.credentialRevision) {
        throw new ServiceError("Jev credential changed since this proposal was created", 409, "SEMANTIC_PROPOSAL_CREDENTIAL_CHANGED");
      }
      if (proposal.status !== "pending") throw new ServiceError("Only pending proposals can be decided", 409, "SEMANTIC_PROPOSAL_NOT_PENDING");
      const [updated] = await tx.update(semanticAnalysisProposalsTable).set({
        status: decision, decidedBy: actorId, decidedAt: new Date(),
      }).where(and(eq(semanticAnalysisProposalsTable.id, proposal.id), eq(semanticAnalysisProposalsTable.status, "pending"))).returning();
      if (!updated) throw new ServiceError("Proposal changed; reload before deciding", 409, "SEMANTIC_PROPOSAL_NOT_PENDING");
      await tx.insert(auditEventsTable).values({
        workspaceId, eventType: `semantic_analysis.proposal_${decision}`,
        resourceType: "semantic_analysis_proposal", resourceId: updated.id,
        metadata: { actorId, apiId, specificationId: updated.specificationId, operationId: updated.operationId },
      });
      return proposalView(updated);
    });
    if (!result) throw new ServiceError("Proposal is stale for the current imported specification", 409, "SEMANTIC_PROPOSAL_STALE");
    return result;
  }
}