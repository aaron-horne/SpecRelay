import { boolean, check, index, foreignKey, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspacesTable } from "./workspaces";

export const workspaceMembershipsTable = pgTable(
  "workspace_memberships",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    workspaceIsLive: boolean("workspace_is_live").notNull().default(true),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["OWNER", "MEMBER"] }).notNull().default("MEMBER"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    index("workspace_memberships_user_idx").on(table.userId),
    check("workspace_memberships_live_check", sql`${table.workspaceIsLive} = true`),
    foreignKey({
      columns: [table.workspaceId, table.workspaceIsLive],
      foreignColumns: [workspacesTable.id, workspacesTable.isLive],
      name: "workspace_memberships_workspace_live_fk",
    }).onDelete("cascade"),
  ],
);

export type WorkspaceMembershipRow = typeof workspaceMembershipsTable.$inferSelect;