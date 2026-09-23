import { boolean, check, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";

export const workspacesTable = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  isLive: boolean("is_live").notNull().default(true),
}, (table) => [
  unique("workspaces_id_live_unique").on(table.id, table.isLive),
  check("workspaces_live_marker_check", sql`${table.isLive} = (${table.deletedAt} IS NULL)`),
]);

export const insertWorkspaceSchema = createInsertSchema(workspacesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
  isLive: true,
});

export type WorkspaceRow = typeof workspacesTable.$inferSelect;
export type NewWorkspaceRow = typeof workspacesTable.$inferInsert;