import {
  index,
  boolean,
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { sql } from "drizzle-orm";
import { workspacesTable } from "./workspaces";

export const apiSourcesTable = pgTable(
  "api_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    workspaceIsLive: boolean("workspace_is_live").notNull().default(true),
    name: text("name").notNull(),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("api_sources_workspace_idx").on(table.workspaceId),
    uniqueIndex("api_sources_workspace_name_unique").on(
      table.workspaceId,
      table.name,
    ),
    uniqueIndex("api_sources_workspace_id_unique").on(table.workspaceId, table.id),
    check("api_sources_live_check", sql`${table.workspaceIsLive} = true`),
    foreignKey({ columns: [table.workspaceId, table.workspaceIsLive], foreignColumns: [workspacesTable.id, workspacesTable.isLive], name: "api_sources_workspace_live_fk" }).onDelete("cascade"),
  ],
);

export const insertApiSourceSchema = createInsertSchema(apiSourcesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type ApiSourceRow = typeof apiSourcesTable.$inferSelect;