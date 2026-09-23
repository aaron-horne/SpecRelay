import {
  boolean,
  check,
  index,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { apiOperationsTable } from "./api-operations";
import { workspacesTable } from "./workspaces";

export const operationPoliciesTable = pgTable(
  "operation_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    workspaceIsLive: boolean("workspace_is_live").notNull().default(true),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => apiOperationsTable.id, { onDelete: "cascade" }),
    decision: text("decision", {
      enum: ["DENY", "ALLOW", "REQUIRE_APPROVAL"],
    })
      .notNull()
      .default("DENY"),
    executionApproved: boolean("execution_approved").notNull().default(false),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("operation_policies_workspace_idx").on(table.workspaceId),
    uniqueIndex("operation_policies_workspace_operation_unique").on(
      table.workspaceId,
      table.operationId,
    ),
    foreignKey({
      columns: [table.workspaceId, table.operationId],
      foreignColumns: [apiOperationsTable.workspaceId, apiOperationsTable.id],
      name: "operation_policies_workspace_operation_fk",
    }).onDelete("cascade"),
    check("operation_policies_live_check", sql`${table.workspaceIsLive} = true`),
    foreignKey({ columns: [table.workspaceId, table.workspaceIsLive], foreignColumns: [workspacesTable.id, workspacesTable.isLive], name: "operation_policies_workspace_live_fk" }).onDelete("cascade"),
  ],
);