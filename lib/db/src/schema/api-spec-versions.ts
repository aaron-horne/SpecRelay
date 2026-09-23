import {
  index,
  foreignKey,
  jsonb,
  boolean,
  check,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { apiSourcesTable } from "./api-sources";
import { workspacesTable } from "./workspaces";

export const apiSpecVersionsTable = pgTable(
  "api_spec_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    workspaceIsLive: boolean("workspace_is_live").notNull().default(true),
    apiId: uuid("api_id")
      .notNull()
      .references(() => apiSourcesTable.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    format: text("format", { enum: ["json", "yaml"] }).notNull(),
    openapiVersion: text("openapi_version").notNull(),
    documentHash: text("document_hash").notNull(),
    rawDocument: text("raw_document").notNull(),
    normalizedDocument: jsonb("normalized_document").notNull(),
    serverUrls: jsonb("server_urls").$type<string[]>().notNull().default([]),
    securitySchemes: jsonb("security_schemes")
      .$type<
        Array<{
          name: string;
          type: "apiKey" | "http" | "unsupported";
          location: "header" | "query" | null;
          parameterName: string | null;
          bearer: boolean;
        }>
      >()
      .notNull()
      .default([]),
    validationWarnings: jsonb("validation_warnings")
      .$type<
        Array<{
          code: string;
          message: string;
          path: string | null;
          severity: "info" | "warning" | "blocked";
        }>
      >()
      .notNull()
      .default([]),
    isActive: boolean("is_active").notNull().default(false),
    importedAt: timestamp("imported_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("api_spec_versions_workspace_api_idx").on(
      table.workspaceId,
      table.apiId,
    ),
    uniqueIndex("api_spec_versions_api_hash_unique").on(
      table.apiId,
      table.documentHash,
    ),
    uniqueIndex("api_spec_versions_workspace_api_id_unique").on(
      table.workspaceId,
      table.apiId,
      table.id,
    ),
    uniqueIndex("api_spec_versions_one_active_per_api_unique")
      .on(table.workspaceId, table.apiId)
      .where(sql`is_active`),
    foreignKey({
      columns: [table.workspaceId, table.apiId],
      foreignColumns: [apiSourcesTable.workspaceId, apiSourcesTable.id],
      name: "api_spec_versions_workspace_api_fk",
    }).onDelete("cascade"),
    check("api_spec_versions_live_check", sql`${table.workspaceIsLive} = true`),
    foreignKey({ columns: [table.workspaceId, table.workspaceIsLive], foreignColumns: [workspacesTable.id, workspacesTable.isLive], name: "api_spec_versions_workspace_live_fk" }).onDelete("cascade"),
  ],
);

export type ApiSpecVersionRow = typeof apiSpecVersionsTable.$inferSelect;