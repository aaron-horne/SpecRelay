import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspacesTable } from "./workspaces";

export const semanticAnalysisPreflightTokensTable = pgTable(
  "semantic_analysis_preflight_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    tokenKind: text("token_kind").notNull().default("preflight"),
    actorId: text("actor_id").notNull(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    workspaceIsLive: boolean("workspace_is_live").notNull().default(true),
    apiId: uuid("api_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    specificationId: uuid("specification_id").notNull(),
    documentHash: text("document_hash").notNull(),
    credentialId: uuid("credential_id").notNull(),
    credentialRevision: integer("credential_revision").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("semantic_analysis_preflight_expiry_idx").on(table.expiresAt),
    check("semantic_analysis_preflight_tokens_kind_check", sql`${table.tokenKind} IN ('preflight', 'dispatch')`),
    foreignKey({
      columns: [table.workspaceId, table.workspaceIsLive],
      foreignColumns: [workspacesTable.id, workspacesTable.isLive],
      name: "semantic_analysis_preflight_tokens_workspace_live_fk",
    }).onDelete("cascade"),
    check("semantic_analysis_preflight_tokens_live_check", sql`${table.workspaceIsLive} = true`),
  ],
);