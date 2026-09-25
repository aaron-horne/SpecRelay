import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { apiOperationsTable } from "./api-operations";
import { apiSourcesTable } from "./api-sources";
import { apiSpecVersionsTable } from "./api-spec-versions";
import { workspacesTable } from "./workspaces";

export const semanticProposalStatusEnum = pgEnum("semantic_proposal_status", [
  "pending",
  "accepted",
  "rejected",
  "stale",
]);

export const semanticAnalysisProposalsTable = pgTable(
  "semantic_analysis_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    workspaceIsLive: boolean("workspace_is_live").notNull().default(true),
    apiId: uuid("api_id").notNull(),
    specificationId: uuid("specification_id").notNull(),
    sourceDocumentHash: text("source_document_hash").notNull(),
    operationId: uuid("operation_id").notNull(),
    providerConfigId: uuid("provider_config_id"),
    credentialRevision: integer("credential_revision"),
    proposalText: text("proposal_text").notNull(),
    proposalKind: text("proposal_kind").notNull().default("description"),
    confidence: real("confidence").notNull(),
    uncertainty: real("uncertainty").notNull(),
    sourceField: text("source_field").notNull(),
    status: semanticProposalStatusEnum("status").notNull().default("pending"),
    createdBy: text("created_by").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    mcpPublishedAt: timestamp("mcp_published_at", { withTimezone: true }),
    mcpPreviewTokenHash: text("mcp_preview_token_hash"),
    mcpPreviewActorId: text("mcp_preview_actor_id"),
    mcpPreviewExpiresAt: timestamp("mcp_preview_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("semantic_analysis_proposals_workspace_api_idx").on(table.workspaceId, table.apiId, table.createdAt),
    index("semantic_analysis_proposals_operation_idx").on(table.workspaceId, table.operationId, table.createdAt),
    uniqueIndex("semantic_analysis_proposals_one_mcp_publication_idx")
      .on(table.workspaceId, table.specificationId, table.operationId)
      .where(sql`${table.mcpPublishedAt} IS NOT NULL`),
    foreignKey({
      columns: [table.workspaceId, table.workspaceIsLive],
      foreignColumns: [workspacesTable.id, workspacesTable.isLive],
      name: "semantic_analysis_proposals_workspace_live_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.apiId],
      foreignColumns: [apiSourcesTable.workspaceId, apiSourcesTable.id],
      name: "semantic_analysis_proposals_workspace_api_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.apiId, table.specificationId],
      foreignColumns: [apiSpecVersionsTable.workspaceId, apiSpecVersionsTable.apiId, apiSpecVersionsTable.id],
      name: "semantic_analysis_proposals_specification_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.apiId, table.specificationId, table.operationId],
      foreignColumns: [apiOperationsTable.workspaceId, apiOperationsTable.apiId, apiOperationsTable.specificationId, apiOperationsTable.id],
      name: "semantic_analysis_proposals_operation_fk",
    }).onDelete("cascade"),
    check("semantic_analysis_proposals_live_check", sql`${table.workspaceIsLive} = true`),
    check("semantic_analysis_proposals_credential_revision_check", sql`${table.credentialRevision} IS NULL OR ${table.credentialRevision} >= 0`),
    check("semantic_analysis_proposals_confidence_check", sql`${table.confidence} >= 0 AND ${table.confidence} <= 1`),
    check("semantic_analysis_proposals_uncertainty_check", sql`${table.uncertainty} >= 0 AND ${table.uncertainty} <= 1`),
    check("semantic_analysis_proposals_text_size_check", sql`length(${table.proposalText}) BETWEEN 1 AND 500`),
    check("semantic_analysis_proposals_mcp_preview_check",
      sql`(${table.mcpPreviewTokenHash} IS NULL AND ${table.mcpPreviewActorId} IS NULL AND ${table.mcpPreviewExpiresAt} IS NULL) OR
          (${table.mcpPreviewTokenHash} IS NOT NULL AND ${table.mcpPreviewActorId} IS NOT NULL AND ${table.mcpPreviewExpiresAt} IS NOT NULL)`),
  ],
);

export const insertSemanticAnalysisProposalSchema = createInsertSchema(
  semanticAnalysisProposalsTable,
).omit({ id: true, createdAt: true });
export type InsertSemanticAnalysisProposal = z.infer<typeof insertSemanticAnalysisProposalSchema>;
export type SemanticAnalysisProposalRow = typeof semanticAnalysisProposalsTable.$inferSelect;