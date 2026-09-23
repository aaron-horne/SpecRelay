import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";
import { workspaceMembershipsTable } from "./workspace-memberships";

export const connectorActorsTable = pgTable("connector_actors", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspacesTable.id, { onDelete: "cascade" }),
  memberId: text("member_id").notNull(),
  name: text("name").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("connector_actors_workspace_id_unique").on(t.workspaceId, t.id),
  uniqueIndex("connector_actors_member_unique").on(t.workspaceId, t.memberId),
  foreignKey({ columns: [t.workspaceId, t.memberId], foreignColumns: [workspaceMembershipsTable.workspaceId, workspaceMembershipsTable.userId] }).onDelete("cascade"),
]);

export const connectorTokensTable = pgTable("connector_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  actorId: uuid("actor_id").notNull(),
  lookupId: text("lookup_id").notNull(),
  verifier: text("verifier").notNull(),
  scopes: jsonb("scopes").$type<Array<"tools:list" | "tools:call">>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => [
  uniqueIndex("connector_tokens_lookup_unique").on(t.lookupId),
  index("connector_tokens_workspace_actor_idx").on(t.workspaceId, t.actorId),
  foreignKey({ columns: [t.workspaceId, t.actorId], foreignColumns: [connectorActorsTable.workspaceId, connectorActorsTable.id] }).onDelete("cascade"),
]);