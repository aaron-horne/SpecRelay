import {
  foreignKey,
  boolean,
  check,
  index,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { apiOperationsTable } from "./api-operations";
import { apiSourcesTable } from "./api-sources";
import { apiSpecVersionsTable } from "./api-spec-versions";
import { workspacesTable } from "./workspaces";
import { sql } from "drizzle-orm";

export const executionLeasesTable = pgTable(
  "execution_leases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
    workspaceIsLive: boolean("workspace_is_live").notNull().default(true),
    apiId: uuid("api_id").notNull().references(() => apiSourcesTable.id, { onDelete: "cascade" }),
    specificationId: uuid("specification_id").notNull().references(() => apiSpecVersionsTable.id, { onDelete: "cascade" }),
    operationId: uuid("operation_id").notNull().references(() => apiOperationsTable.id, { onDelete: "cascade" }),
    acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("execution_leases_workspace_api_expiry_idx").on(
      table.workspaceId,
      table.apiId,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.workspaceId, table.apiId, table.specificationId],
      foreignColumns: [apiSpecVersionsTable.workspaceId, apiSpecVersionsTable.apiId, apiSpecVersionsTable.id],
      name: "execution_leases_workspace_specification_fk",
    }).onDelete("cascade"),
    check("execution_leases_live_check", sql`${table.workspaceIsLive} = true`),
    foreignKey({ columns: [table.workspaceId, table.workspaceIsLive], foreignColumns: [workspacesTable.id, workspacesTable.isLive], name: "execution_leases_workspace_live_fk" }).onDelete("cascade"),
    foreignKey({
      columns: [table.workspaceId, table.apiId, table.specificationId, table.operationId],
      foreignColumns: [
        apiOperationsTable.workspaceId,
        apiOperationsTable.apiId,
        apiOperationsTable.specificationId,
        apiOperationsTable.id,
      ],
      name: "execution_leases_workspace_api_spec_operation_fk",
    }).onDelete("cascade"),
  ],
);

export type ExecutionLeaseRow = typeof executionLeasesTable.$inferSelect;