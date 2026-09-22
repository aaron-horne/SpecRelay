import {
  index,
  integer,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { apiSourcesTable } from "./api-sources";
import { workspacesTable } from "./workspaces";

export const credentialMetadataTable = pgTable(
  "credential_metadata",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    apiId: uuid("api_id")
      .notNull()
      .references(() => apiSourcesTable.id, { onDelete: "cascade" }),
    schemeName: text("scheme_name").notNull(),
    credentialType: text("credential_type", { enum: ["API_KEY", "BEARER"] }).notNull(),
    location: text("location", { enum: ["header", "query"] }).notNull(),
    parameterName: text("parameter_name").notNull(),
    label: text("label").notNull(),
    providerName: text("provider_name").notNull(),
    externalReference: text("external_reference").notNull(),
    destinationHost: text("destination_host").notNull(),
    status: text("status", { enum: ["ACTIVE", "DISABLED", "REVOKED"] })
      .notNull()
      .default("REVOKED"),
    secretCiphertext: text("secret_ciphertext").notNull(),
    secretIv: text("secret_iv").notNull(),
    secretAuthTag: text("secret_auth_tag").notNull(),
    keyVersion: integer("key_version").notNull().default(1),
    keyId: text("key_id").notNull().default("credential-key-v1"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("credential_metadata_workspace_api_idx").on(
      table.workspaceId,
      table.apiId,
    ),
    index("credential_metadata_scheme_idx").on(
      table.workspaceId,
      table.apiId,
      table.schemeName,
      table.status,
    ),
    uniqueIndex("credential_metadata_workspace_api_scheme_unique").on(
      table.workspaceId,
      table.apiId,
      table.schemeName,
    ),
    foreignKey({
      columns: [table.workspaceId, table.apiId],
      foreignColumns: [apiSourcesTable.workspaceId, apiSourcesTable.id],
      name: "credential_metadata_workspace_api_fk",
    }).onDelete("cascade"),
  ],
);