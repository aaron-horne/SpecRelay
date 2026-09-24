import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { workspacesTable } from "./workspaces";

export const semanticProviderConfigsTable = pgTable(
  "semantic_provider_configs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    workspaceIsLive: boolean("workspace_is_live").notNull().default(true),
    provider: text("provider").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    secretCiphertext: text("secret_ciphertext"),
    secretIv: text("secret_iv"),
    secretAuthTag: text("secret_auth_tag"),
    keyId: text("key_id"),
    keyVersion: integer("key_version"),
    credentialRevision: integer("credential_revision").notNull().default(0),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastTestOutcome: text("last_test_outcome"),
    testedRevision: integer("tested_revision"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    unique("semantic_provider_configs_workspace_provider_unique").on(
      table.workspaceId,
      table.provider,
    ),
    foreignKey({
      columns: [table.workspaceId, table.workspaceIsLive],
      foreignColumns: [workspacesTable.id, workspacesTable.isLive],
      name: "semantic_provider_configs_workspace_live_fk",
    }).onDelete("cascade"),
    check(
      "semantic_provider_configs_live_check",
      sql`${table.workspaceIsLive} = true`,
    ),
  ],
);

export const insertSemanticProviderConfigSchema = createInsertSchema(
  semanticProviderConfigsTable,
).omit({
  id: true,
  workspaceIsLive: true,
  credentialRevision: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSemanticProviderConfig = z.infer<
  typeof insertSemanticProviderConfigSchema
>;
export type SemanticProviderConfigRow =
  typeof semanticProviderConfigsTable.$inferSelect;