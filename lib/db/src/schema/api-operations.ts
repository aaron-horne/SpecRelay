import {
  boolean,
  check,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { apiSourcesTable } from "./api-sources";
import { apiSpecVersionsTable } from "./api-spec-versions";
import { workspacesTable } from "./workspaces";

export const operationRiskEnum = pgEnum("operation_risk", [
  "READ_LIKE",
  "WRITE",
  "DESTRUCTIVE",
  "UNKNOWN",
]);

export const apiOperationsTable = pgTable(
  "api_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    workspaceIsLive: boolean("workspace_is_live").notNull().default(true),
    apiId: uuid("api_id")
      .notNull()
      .references(() => apiSourcesTable.id, { onDelete: "cascade" }),
    specificationId: uuid("specification_id")
      .notNull()
      .references(() => apiSpecVersionsTable.id, { onDelete: "cascade" }),
    method: text("method").notNull(),
    path: text("path").notNull(),
    operationId: text("operation_id"),
    displayName: text("display_name").notNull(),
    summary: text("summary"),
    description: text("description"),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    parameters: jsonb("parameters")
      .$type<
        Array<{
          name: string;
          location: "path" | "query" | "header" | "cookie";
          required: boolean;
          schemaType: string | null;
          description: string | null;
        }>
      >()
      .notNull()
      .default([]),
    requestBody: jsonb("request_body").$type<{
      required: boolean;
      contentTypes: string[];
      description: string | null;
    } | null>(),
    responses: jsonb("responses")
      .$type<
        Array<{
          statusCode: string;
          description: string | null;
          contentTypes: string[];
        }>
      >()
      .notNull()
      .default([]),
    securityRequirements: jsonb("security_requirements")
      .$type<string[]>()
      .notNull()
      .default([]),
    securityGroups: jsonb("security_groups")
      .$type<Array<Array<{ scheme: string; scopes: string[] }>>>()
      .notNull()
      .default([]),
    risk: operationRiskEnum("risk").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("api_operations_workspace_api_idx").on(
      table.workspaceId,
      table.apiId,
    ),
    uniqueIndex("api_operations_spec_method_path_unique").on(
      table.specificationId,
      table.method,
      table.path,
    ),
    uniqueIndex("api_operations_workspace_id_unique").on(table.workspaceId, table.id),
    uniqueIndex("api_operations_workspace_api_specification_id_unique").on(
      table.workspaceId,
      table.apiId,
      table.specificationId,
      table.id,
    ),
    foreignKey({
      columns: [table.workspaceId, table.apiId],
      foreignColumns: [apiSourcesTable.workspaceId, apiSourcesTable.id],
      name: "api_operations_workspace_api_fk",
    }).onDelete("cascade"),
    check("api_operations_live_check", sql`${table.workspaceIsLive} = true`),
    foreignKey({ columns: [table.workspaceId, table.workspaceIsLive], foreignColumns: [workspacesTable.id, workspacesTable.isLive], name: "api_operations_workspace_live_fk" }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.apiId, table.specificationId],
      foreignColumns: [
        apiSpecVersionsTable.workspaceId,
        apiSpecVersionsTable.apiId,
        apiSpecVersionsTable.id,
      ],
      name: "api_operations_workspace_specification_fk",
    }).onDelete("cascade"),
  ],
);

export type ApiOperationRow = typeof apiOperationsTable.$inferSelect;