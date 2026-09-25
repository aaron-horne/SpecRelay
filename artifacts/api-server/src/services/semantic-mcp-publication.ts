import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  apiOperationsTable,
  auditEventsTable,
  db,
  operationPoliciesTable,
  semanticAnalysisProposalsTable,
  semanticProviderConfigsTable,
  workspacesTable,
} from "@workspace/db";
import { createMcpTool } from "@workspace/mcp";
import { ServiceError } from "./errors";
import { isMcpListableOperation } from "./mcp-listing-eligibility";
import { authenticationMode, operationView } from "./mcp-operation-view";
import {
  acquireApiLock,
  currentSourceOperation,
  lockOwner,
  operationInput,
  proposalView,
  requireReadyCredential,
  requireRollout,
} from "./semantic-analysis";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Operation = typeof apiOperationsTable.$inferSelect;

function previewToken(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function validPreview(
  tx: Tx,
  workspaceId: string,
  apiId: string,
  proposalId: string,
  actorId: string,
  lock = false,
) {
  await lockOwner(tx, workspaceId, actorId);
  requireRollout(workspaceId);
  const query = tx.select().from(semanticAnalysisProposalsTable).where(and(
    eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
    eq(semanticAnalysisProposalsTable.apiId, apiId),
    eq(semanticAnalysisProposalsTable.id, proposalId),
  ));
  const [proposal] = lock ? await query.for("update").limit(1) : await query.limit(1);
  if (!proposal) throw new ServiceError("Proposal not found", 404, "SEMANTIC_PROPOSAL_NOT_FOUND");
  if (proposal.status !== "accepted" || proposal.proposalKind !== "description") {
    throw new ServiceError("Only an accepted description can be published", 409, "SEMANTIC_MCP_PROPOSAL_NOT_ACCEPTED");
  }
  const { operation, specification } = await currentSourceOperation(tx, workspaceId, apiId, proposal.operationId);
  const { row: credential } = await requireReadyCredential(tx, workspaceId);
  if (proposal.specificationId !== specification.id ||
      proposal.sourceDocumentHash !== specification.documentHash ||
      proposal.operationId !== operation.id ||
      operationInput(operation).sources.get(proposal.sourceField) !== proposal.proposalText ||
      proposal.providerConfigId !== credential.id ||
      proposal.credentialRevision !== credential.credentialRevision) {
    throw new ServiceError("The accepted description is no longer current", 409, "SEMANTIC_MCP_PROPOSAL_STALE");
  }
  const [policy] = await tx.select({
    decision: operationPoliciesTable.decision,
    approved: operationPoliciesTable.executionApproved,
  }).from(operationPoliciesTable).where(and(
    eq(operationPoliciesTable.workspaceId, workspaceId),
    eq(operationPoliciesTable.operationId, operation.id),
  )).limit(1);
  if (!policy || !(await isMcpListableOperation(workspaceId, {
    operation,
    ...policy,
    serverUrls: specification.serverUrls,
    securitySchemes: specification.securitySchemes,
  }))) {
    throw new ServiceError(
      "This operation is not currently in MCP tools/list. It must be enabled, have policy ALLOW and execution approval, be an HTTPS GET without a request body with only path/query parameters, and have compatible credentials when required. The accepted description remains console-only.",
      409,
      "SEMANTIC_MCP_OPERATION_NOT_LISTABLE",
    );
  }
  const tool = createMcpTool({
    ...operationView(operation, authenticationMode(operation, specification.securitySchemes)),
    description: proposal.proposalText,
  });
  const preview = {
    importedDescription: operation.description ?? operation.displayName,
    proposalText: proposal.proposalText,
    toolDescription: tool.description,
  };
  return {
    proposal,
    preview,
    digest: previewToken({
      actorId, workspaceId, apiId, proposalId,
      specificationId: specification.id, documentHash: specification.documentHash,
      operationId: operation.id, sourceField: proposal.sourceField,
      credentialId: credential.id, credentialRevision: credential.credentialRevision,
      toolDescription: tool.description, importedDescription: operation.description ?? operation.displayName,
    }),
  };
}

export class SemanticMcpPublicationService {
  async preview(workspaceId: string, apiId: string, proposalId: string, actorId: string) {
    return db.transaction(async (tx) => {
      await acquireApiLock(tx, workspaceId, apiId);
      const { proposal, preview, digest } = await validPreview(tx, workspaceId, apiId, proposalId, actorId, true);
      if (proposal.mcpPublishedAt) {
        throw new ServiceError("Description is already published", 409, "SEMANTIC_MCP_ALREADY_PUBLISHED");
      }
      const token = randomUUID();
      await tx.update(semanticAnalysisProposalsTable).set({
        mcpPreviewTokenHash: previewToken([token, digest]),
        mcpPreviewActorId: actorId,
        mcpPreviewExpiresAt: new Date(Date.now() + 2 * 60_000),
      }).where(eq(semanticAnalysisProposalsTable.id, proposal.id));
      return { ...preview, previewToken: token };
    });
  }

  async publish(workspaceId: string, apiId: string, proposalId: string, actorId: string, token: string) {
    return db.transaction(async (tx) => {
      await acquireApiLock(tx, workspaceId, apiId);
      const { proposal, digest } = await validPreview(tx, workspaceId, apiId, proposalId, actorId, true);
      if (!proposal.mcpPreviewExpiresAt || proposal.mcpPreviewExpiresAt.getTime() <= Date.now() ||
          proposal.mcpPreviewActorId !== actorId ||
          proposal.mcpPreviewTokenHash !== previewToken([token, digest])) {
        throw new ServiceError("The preview expired, was already used, or changed; review it again", 409, "SEMANTIC_MCP_PREVIEW_STALE");
      }
      const [already] = await tx.select({ id: semanticAnalysisProposalsTable.id })
        .from(semanticAnalysisProposalsTable).where(and(
          eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
          eq(semanticAnalysisProposalsTable.specificationId, proposal.specificationId),
          eq(semanticAnalysisProposalsTable.operationId, proposal.operationId),
          isNotNull(semanticAnalysisProposalsTable.mcpPublishedAt),
        )).limit(1);
      if (already) {
        throw new ServiceError("Revoke the current MCP publication before publishing another", 409, "SEMANTIC_MCP_ALREADY_PUBLISHED");
      }
      const [updated] = await tx.update(semanticAnalysisProposalsTable)
        .set({
          mcpPublishedAt: new Date(),
          mcpPreviewTokenHash: null, mcpPreviewActorId: null, mcpPreviewExpiresAt: null,
        })
        .where(and(
          eq(semanticAnalysisProposalsTable.id, proposal.id),
          eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
          eq(semanticAnalysisProposalsTable.status, "accepted"),
        )).returning();
      if (!updated) throw new ServiceError("Proposal changed; review it again", 409, "SEMANTIC_MCP_PROPOSAL_STALE");
      await tx.insert(auditEventsTable).values({
        workspaceId, eventType: "semantic_mcp_overlay.published",
        resourceType: "semantic_analysis_proposal", resourceId: proposal.id,
        metadata: {
          actorId, apiId, specificationId: proposal.specificationId, operationId: proposal.operationId,
          credentialRevision: proposal.credentialRevision,
        },
      });
      return proposalView(updated);
    });
  }

  async revoke(workspaceId: string, apiId: string, proposalId: string, actorId: string) {
    return db.transaction(async (tx) => {
      await acquireApiLock(tx, workspaceId, apiId);
      await lockOwner(tx, workspaceId, actorId);
      const [proposal] = await tx.select().from(semanticAnalysisProposalsTable).where(and(
        eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
        eq(semanticAnalysisProposalsTable.apiId, apiId),
        eq(semanticAnalysisProposalsTable.id, proposalId),
      )).for("update").limit(1);
      if (!proposal) throw new ServiceError("Publication not found", 404, "SEMANTIC_PROPOSAL_NOT_FOUND");
      if (!proposal.mcpPublishedAt) throw new ServiceError("Publication is no longer active", 409, "SEMANTIC_MCP_NOT_PUBLISHED");
      const [updated] = await tx.update(semanticAnalysisProposalsTable).set({
        mcpPublishedAt: null, mcpPreviewTokenHash: null, mcpPreviewActorId: null, mcpPreviewExpiresAt: null,
      })
        .where(and(eq(semanticAnalysisProposalsTable.id, proposal.id), isNotNull(semanticAnalysisProposalsTable.mcpPublishedAt)))
        .returning();
      if (!updated) throw new ServiceError("Publication changed; reload", 409, "SEMANTIC_MCP_NOT_PUBLISHED");
      await tx.insert(auditEventsTable).values({
        workspaceId, eventType: "semantic_mcp_overlay.revoked",
        resourceType: "semantic_analysis_proposal", resourceId: proposal.id,
        metadata: {
          actorId, apiId, specificationId: proposal.specificationId, operationId: proposal.operationId,
          credentialRevision: proposal.credentialRevision,
        },
      });
      return proposalView(updated);
    });
  }
}

// Called within the same transaction as an import or credential mutation.
export async function staleMcpPublications(
  tx: Tx, workspaceId: string, actorId: string, reason: string, apiId?: string,
) {
  const conditions = [
    eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
    isNotNull(semanticAnalysisProposalsTable.mcpPublishedAt),
  ];
  if (apiId) conditions.push(eq(semanticAnalysisProposalsTable.apiId, apiId));
  const stale = await tx.update(semanticAnalysisProposalsTable).set({
    mcpPublishedAt: null, mcpPreviewTokenHash: null, mcpPreviewActorId: null, mcpPreviewExpiresAt: null,
  })
    .where(and(...conditions))
    .returning({
      id: semanticAnalysisProposalsTable.id,
      apiId: semanticAnalysisProposalsTable.apiId,
      specificationId: semanticAnalysisProposalsTable.specificationId,
      operationId: semanticAnalysisProposalsTable.operationId,
      credentialRevision: semanticAnalysisProposalsTable.credentialRevision,
    });
  if (stale.length) await tx.insert(auditEventsTable).values(stale.map((row) => ({
    workspaceId, eventType: "semantic_mcp_overlay.stale",
    resourceType: "semantic_analysis_proposal", resourceId: row.id,
    metadata: {
      actorId, apiId: row.apiId, specificationId: row.specificationId,
      operationId: row.operationId, credentialRevision: row.credentialRevision, reason,
    },
  })));
}

// Listing must not depend on a background stale-state write. Always revalidate
// source, active version, rollout, live workspace and credential at read time.
export async function publishedMcpDescriptions(
  workspaceId: string,
  rows: ReadonlyArray<{ operation: Operation; documentHash: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (!rows.length) return result;
  try { requireRollout(workspaceId); } catch { return result; }
  const [workspace] = await db.select({ id: workspacesTable.id }).from(workspacesTable)
    .where(and(eq(workspacesTable.id, workspaceId), eq(workspacesTable.isLive, true), isNull(workspacesTable.deletedAt))).limit(1);
  if (!workspace) return result;
  const [credential] = await db.select({
    id: semanticProviderConfigsTable.id,
    enabled: semanticProviderConfigsTable.enabled,
    credentialRevision: semanticProviderConfigsTable.credentialRevision,
    testedRevision: semanticProviderConfigsTable.testedRevision,
    lastTestOutcome: semanticProviderConfigsTable.lastTestOutcome,
    secretCiphertext: semanticProviderConfigsTable.secretCiphertext,
  }).from(semanticProviderConfigsTable).where(and(
    eq(semanticProviderConfigsTable.workspaceId, workspaceId),
    eq(semanticProviderConfigsTable.workspaceIsLive, true),
    eq(semanticProviderConfigsTable.provider, "jev"),
  )).limit(1);
  if (!credential?.enabled || !credential.secretCiphertext ||
      credential.lastTestOutcome !== "success" || credential.testedRevision !== credential.credentialRevision) return result;
  const active = new Map(rows.map((row) => [row.operation.id, row]));
  const published = await db.select().from(semanticAnalysisProposalsTable).where(and(
    eq(semanticAnalysisProposalsTable.workspaceId, workspaceId),
    eq(semanticAnalysisProposalsTable.status, "accepted"),
    isNotNull(semanticAnalysisProposalsTable.mcpPublishedAt),
    inArray(semanticAnalysisProposalsTable.operationId, [...active.keys()]),
  ));
  for (const proposal of published) {
    const match = active.get(proposal.operationId);
    if (!match || match.operation.workspaceId !== workspaceId ||
        match.operation.apiId !== proposal.apiId ||
        match.operation.specificationId !== proposal.specificationId ||
        match.documentHash !== proposal.sourceDocumentHash ||
        proposal.providerConfigId !== credential.id ||
        proposal.credentialRevision !== credential.credentialRevision ||
        proposal.proposalKind !== "description") continue;
    try {
      if (operationInput(match.operation).sources.get(proposal.sourceField) === proposal.proposalText) {
        result.set(proposal.operationId, proposal.proposalText);
      }
    } catch { /* Invalid imported source cannot authorize an MCP overlay. */ }
  }
  return result;
}