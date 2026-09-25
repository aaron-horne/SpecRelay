import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, sql } from "drizzle-orm";
import {
  apiOperationsTable,
  apiSourcesTable,
  apiSpecVersionsTable,
  auditEventsTable,
  db,
  semanticAnalysisProposalsTable,
  semanticProviderConfigsTable,
  workspaceMembershipsTable,
  workspacesTable,
} from "@workspace/db";
import { decryptSemanticProviderSecret } from "./credential-crypto";
import { JevSemanticAnalysisAdapter, type JevAnalysisJudgment, type JevCandidate, type JevOperationInput, type SemanticAnalysisAdapter } from "./semantic-analysis-adapter";
import { ServiceError } from "./errors";

const PROVIDER = "jev";
const RATE_WINDOW_MS = 60_000;
const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type OperationRow = typeof apiOperationsTable.$inferSelect;
type ProposalRow = typeof semanticAnalysisProposalsTable.$inferSelect;

function requireRollout(workspaceId: string): void {
  if (process.env.SEMANTIC_PROVIDERS_ENABLED !== "true") {
    throw new ServiceError("Jev analysis is disabled", 503, "SEMANTIC_PROVIDERS_DISABLED");
  }
  const raw = process.env.SEMANTIC_PROVIDER_TEST_WORKSPACE_IDS;
  const ids = raw?.split(",").map((item) => item.trim()) ?? [];
  if (!ids.length || !ids.every((id) => WORKSPACE_ID_PATTERN.test(id)) ||
      !ids.some((id) => id.toLowerCase() === workspaceId.toLowerCase())) {
    throw new ServiceError("Jev analysis is not available for this workspace", 503, "SEMANTIC_PROVIDER_WORKSPACE_NOT_ALLOWED");
  }
}

async function lockOwner(tx: Tx, workspaceId: string, actorId: string): Promise<void> {
  const [workspace] = await tx.select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(and(eq(workspacesTable.id, workspaceId), eq(workspacesTable.isLive, true), isNull(workspacesTable.deletedAt)))
    .for("update").limit(1);
  if (!workspace) throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
  const [membership] = await tx.select({ role: workspaceMembershipsTable.role })
    .from(workspaceMembershipsTable)
    .where(and(eq(workspaceMembershipsTable.workspaceId, workspaceId), eq(workspaceMembershipsTable.userId, actorId)))
    .for("share").limit(1);
  if (!membership) throw new ServiceError("Workspace not found", 404, "WORKSPACE_NOT_FOUND");
  if (membership.role !== "OWNER") throw new ServiceError("Workspace owner access required", 403, "OWNER_REQUIRED");
}

async function acquireApiLock(tx: Tx, workspaceId: string, apiId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${workspaceId}:${apiId}`}))`);
}

function redactedText(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  if (/\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|authorization|credential|bearer|secret)\b/i.test(value)) {
    return null;
  }
  const safe = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[URL]")
    .replace(/\b(?:localhost|(?:\d{1,3}\.){3}\d{1,3})(?::\d{2,5})?\b/gi, "[HOST]")
    .replace(/\[[0-9a-f:]{2,}\](?::\d{2,5})?/gi, "[HOST]")
    .replace(/\b[a-z0-9-]+:\d{2,5}\b/gi, "[HOST]")
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"'<>]*)?/gi, "[URL]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[CREDENTIAL]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[CREDENTIAL]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[EMAIL]")
    .replace(/\b(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\b(?:sk|pk|tok|key|token|secret)_[A-Za-z0-9_-]{8,}\b/gi, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED]")
    .replace(/[^\P{Cc}\t\n\r]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
  return safe || null;
}

function operationInput(operation: OperationRow): { input: JevOperationInput; candidates: JevCandidate[] } {
  // Never forward literal route segments: they may contain identifiers,
  // internal names, or customer data even if they do not match a secret regex.
  if (!operation.path.startsWith("/") || operation.path.length > 512 ||
      /[?#\s]/.test(operation.path)) {
    throw new ServiceError("Operation path cannot be safely minimized", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
  }
  const segments = operation.path.split("/").slice(1);
  if (segments.length > 16) {
    throw new ServiceError("Operation path cannot be safely minimized", 400, "SEMANTIC_ANALYSIS_REDACTION_FAILED");
  }
  const path = "/" + segments.map((part) => part.startsWith("{") && part.endsWith("}")
    ? "{parameter}" : "{segment}").join("/");
  const parameters = operation.parameters.slice(0, 6).flatMap((item) => {
    const description = redactedText(item.description, 120);
    return description ? [{ location: item.location, required: item.required, description }] : [];
  });
  const responses = operation.responses.slice(0, 4).flatMap((item) => {
    const description = redactedText(item.description, 120);
    const status = /^(?:[1-5][0-9]{2}|default)$/.test(item.statusCode) ? item.statusCode : "other";
    return description ? [{ status, description }] : [];
  });
  const summary = redactedText(operation.summary, 240);
  const description = redactedText(operation.description, 420);
  const input: JevOperationInput = {
    method: operation.method.toUpperCase().slice(0, 12),
    path,
    summary,
    description,
    parameters,
    responses,
  };
  const candidates: JevCandidate[] = [];
  const add = (sourceField: string, text: string | null) => {
    if (text && !candidates.some((candidate) => candidate.text === text)) {
      candidates.push({ id: `c${candidates.length + 1}`, sourceField, text: text.slice(0, 500) });
    }
  };
  add("summary", summary);
  add("description", description);
  for (const parameter of parameters) add("parameter_description", parameter.description);
  for (const response of responses) add("response_description", response.description);
  return { input, candidates: candidates.slice(0, 8) };
}

async function currentSourceOperation(
  tx: Tx,
  workspaceId: string,
  apiId: string,
  operationId: string,
): Promise<{ specificationId: string; operation: OperationRow }> {
  const [specification] = await tx.select({ id: apiSpecVersionsTable.id })
    .from(apiSpecVersionsTable)
    .where(and(
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
  return { specificationId: specification.id, operation };
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
      ciphertext: row.secretCiphertext,
      iv: row.secretIv,
      authTag: row.secretAuthTag,
      keyId: row.keyId,
      keyVersion: row.keyVersion,
    }, { workspaceId, provider: PROVIDER, credentialId: row.id });
  } catch {
    throw new ServiceError("Provider key cannot be decrypted", 503, "SEMANTIC_PROVIDER_KEY_UNAVAILABLE");
  }
  return { row, secret };
}

function proposalView(row: ProposalRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    apiId: row.apiId,
    specificationId: row.specificationId,
    operationId: row.operationId,
    proposalText: row.proposalText,
    proposalKind: "description" as const,
    confidence: row.confidence,
    uncertainty: row.uncertainty,
    sourceField: row.sourceField,
    status: row.status,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

export class SemanticAnalysisService {
  constructor(private readonly adapter: SemanticAnalysisAdapter = new JevSemanticAnalysisAdapter()) {}

  async analyze(workspaceId: string, apiId: string, operationId: string, actorId: string) {
    const reservation = await db.transaction(async (tx) => {
      await acquireApiLock(tx, workspaceId, apiId);
      await lockOwner(tx, workspaceId, actorId);
      requireRollout(workspaceId);
      const { specificationId, operation } = await currentSourceOperation(tx, workspaceId, apiId, operationId);
      const { row: credential, secret } = await requireReadyCredential(tx, workspaceId);
      const [recent] = await tx.select({ id: auditEventsTable.id }).from(auditEventsTable).where(and(
        eq(auditEventsTable.workspaceId, workspaceId),
        eq(auditEventsTable.eventType, "semantic_analysis.reserved"),
        gte(auditEventsTable.createdAt, sql`now() - (${RATE_WINDOW_MS} * interval '1 millisecond')`),
      )).limit(1);
      if (recent) throw new ServiceError("Jev analysis rate limit is active", 409, "SEMANTIC_ANALYSIS_RATE_LIMITED");
      const { input, candidates } = operationInput(operation);
      const reservationId = randomUUID();
      const metadata = {
        actorId,
        provider: PROVIDER,
        apiId,
        specificationId,
        operationId,
        credentialRevision: credential.credentialRevision,
        reservationId,
      };
      await tx.insert(auditEventsTable).values([
        { workspaceId, eventType: "semantic_analysis.requested", resourceType: "api_operation", resourceId: operationId, metadata },
        { workspaceId, eventType: "semantic_analysis.reserved", resourceType: "api_operation", resourceId: operationId, metadata },
      ]);
      return { specificationId, operation, credential, secret, input, candidates, reservationId };
    });

    let judgment: JevAnalysisJudgment;
    try {
      const attempt = await db.transaction(async (tx) => {
        await acquireApiLock(tx, workspaceId, apiId);
        await lockOwner(tx, workspaceId, actorId);
        requireRollout(workspaceId);
        const { specificationId } = await currentSourceOperation(tx, workspaceId, apiId, operationId);
        const { row: credential, secret } = await requireReadyCredential(tx, workspaceId);
        if (specificationId !== reservation.specificationId ||
            credential.id !== reservation.credential.id ||
            credential.credentialRevision !== reservation.credential.credentialRevision) {
          throw new ServiceError("Operation or Jev configuration changed before analysis", 409, "SEMANTIC_ANALYSIS_REVISION_CONFLICT");
        }
        requireRollout(workspaceId);
        return this.adapter.dispatch(secret, reservation.input, reservation.candidates);
      });
      judgment = await attempt.judgment;
    } catch (error) {
      if (error instanceof ServiceError) {
        await db.insert(auditEventsTable).values({
          workspaceId,
          eventType: "semantic_analysis.outcome",
          resourceType: "api_operation",
          resourceId: operationId,
          metadata: {
            actorId,
            provider: PROVIDER,
            apiId,
            specificationId: reservation.specificationId,
            outcome: "not_dispatched",
            reservationId: reservation.reservationId,
            reasonCode: error.code,
          },
        });
        throw error;
      }
      await db.insert(auditEventsTable).values({
        workspaceId,
        eventType: "semantic_analysis.outcome",
        resourceType: "api_operation",
        resourceId: operationId,
        metadata: { actorId, provider: PROVIDER, apiId, specificationId: reservation.specificationId, outcome: "provider_error", reservationId: reservation.reservationId },
      });
      throw new ServiceError("Jev analysis could not be completed", 502, "SEMANTIC_ANALYSIS_PROVIDER_ERROR");
    }

    try {
      return await db.transaction(async (tx) => {
        await acquireApiLock(tx, workspaceId, apiId);
        await lockOwner(tx, workspaceId, actorId);
        requireRollout(workspaceId);
        const { specificationId } = await currentSourceOperation(tx, workspaceId, apiId, operationId);
        const { row: credential } = await requireReadyCredential(tx, workspaceId);
        if (specificationId !== reservation.specificationId ||
            credential.id !== reservation.credential.id ||
            credential.credentialRevision !== reservation.credential.credentialRevision) {
          throw new ServiceError("Operation or Jev configuration changed during analysis; result discarded", 409, "SEMANTIC_ANALYSIS_REVISION_CONFLICT");
        }

        const candidate = judgment.abstained ? undefined : reservation.candidates.find((item) => item.id === judgment.candidateId);
        const selected = candidate && judgment.confidence >= 0.55 ? candidate : undefined;
        let proposal: ProposalRow | null = null;
        if (selected) {
          [proposal] = await tx.insert(semanticAnalysisProposalsTable).values({
            workspaceId,
            apiId,
            specificationId: reservation.specificationId,
            operationId,
            providerConfigId: reservation.credential.id,
            credentialRevision: reservation.credential.credentialRevision,
            proposalText: selected.text,
            proposalKind: "description",
            confidence: judgment.confidence,
            uncertainty: 1 - judgment.confidence,
            sourceField: selected.sourceField,
            createdBy: actorId,
          }).returning();
        }
        const outcome = proposal ? "proposal" : "abstained";
        const metadata = {
          actorId,
          provider: PROVIDER,
          apiId,
          specificationId,
          operationId,
          credentialRevision: reservation.credential.credentialRevision,
          outcome,
          confidence: judgment.confidence,
          reservationId: reservation.reservationId,
        };
        await tx.insert(auditEventsTable).values({
          workspaceId,
          eventType: "semantic_analysis.outcome",
          resourceType: "api_operation",
          resourceId: operationId,
          metadata,
        });
        if (proposal) {
          await tx.insert(auditEventsTable).values({
            workspaceId,
            eventType: "semantic_analysis.proposal_created",
            resourceType: "semantic_analysis_proposal",
            resourceId: proposal.id,
            metadata: { actorId, apiId, specificationId, operationId, confidence: proposal.confidence },
          });
        }
        return {
          outcome,
          specificationId: reservation.specificationId,
          operationId,
          confidence: judgment.confidence,
          uncertainty: 1 - judgment.confidence,
          proposal: proposal ? proposalView(proposal) : null,
        };
      });
    } catch (error) {
      await db.insert(auditEventsTable).values({
        workspaceId,
        eventType: "semantic_analysis.outcome",
        resourceType: "api_operation",
        resourceId: operationId,
        metadata: {
            actorId,
          provider: PROVIDER,
          apiId,
          specificationId: reservation.specificationId,
          outcome: "discarded",
          reservationId: reservation.reservationId,
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
      const [api] = await tx.select({ id: apiSourcesTable.id }).from(apiSourcesTable).where(and(
        eq(apiSourcesTable.workspaceId, workspaceId), eq(apiSourcesTable.id, apiId),
      )).limit(1);
      if (!api) throw new ServiceError("API source not found", 404, "API_NOT_FOUND");
      const [active] = await tx.select({ id: apiSpecVersionsTable.id }).from(apiSpecVersionsTable).where(and(
        eq(apiSpecVersionsTable.workspaceId, workspaceId),
        eq(apiSpecVersionsTable.apiId, apiId),
        eq(apiSpecVersionsTable.isActive, true),
      )).limit(1);
      const rows = await tx.select().from(semanticAnalysisProposalsTable).where(and(
        eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
        eq(semanticAnalysisProposalsTable.apiId, apiId),
        eq(semanticAnalysisProposalsTable.operationId, operationId),
      )).orderBy(desc(semanticAnalysisProposalsTable.createdAt));
      const stale = rows.filter((row) => row.specificationId !== active?.id && row.status !== "stale");
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

  async decide(
    workspaceId: string,
    apiId: string,
    proposalId: string,
    actorId: string,
    decision: "accepted" | "rejected",
  ) {
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
      const [active] = await tx.select({ id: apiSpecVersionsTable.id }).from(apiSpecVersionsTable).where(and(
        eq(apiSpecVersionsTable.workspaceId, workspaceId),
        eq(apiSpecVersionsTable.apiId, apiId),
        eq(apiSpecVersionsTable.isActive, true),
      )).limit(1);
      if (proposal.specificationId !== active?.id) {
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
      if (proposal.providerConfigId !== credential.id ||
          proposal.credentialRevision !== credential.credentialRevision) {
        throw new ServiceError("Jev credential changed since this proposal was created", 409, "SEMANTIC_PROPOSAL_CREDENTIAL_CHANGED");
      }
      if (proposal.status !== "pending") throw new ServiceError("Only pending proposals can be decided", 409, "SEMANTIC_PROPOSAL_NOT_PENDING");
      const [updated] = await tx.update(semanticAnalysisProposalsTable).set({
        status: decision,
        decidedBy: actorId,
        decidedAt: new Date(),
      }).where(and(
        eq(semanticAnalysisProposalsTable.id, proposal.id),
        eq(semanticAnalysisProposalsTable.status, "pending"),
      )).returning();
      if (!updated) throw new ServiceError("Proposal changed; reload before deciding", 409, "SEMANTIC_PROPOSAL_NOT_PENDING");
      await tx.insert(auditEventsTable).values({
        workspaceId,
        eventType: `semantic_analysis.proposal_${decision}`,
        resourceType: "semantic_analysis_proposal",
        resourceId: updated.id,
        metadata: { actorId, apiId, specificationId: updated.specificationId, operationId: updated.operationId },
      });
      return proposalView(updated);
    });
    if (!result) throw new ServiceError("Proposal is stale for the current imported specification", 409, "SEMANTIC_PROPOSAL_STALE");
    return result;
  }
}