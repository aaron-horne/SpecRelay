import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const connectorRateLimitsTable = pgTable(
  "connector_rate_limits",
  {
    keyHash: text("key_hash").primaryKey(),
    count: integer("count").notNull(),
    until: timestamp("until", { withTimezone: true }).notNull(),
  },
  (table) => [index("connector_rate_limits_until_idx").on(table.until)],
);

export type ConnectorRateLimit = typeof connectorRateLimitsTable.$inferSelect;
export type InsertConnectorRateLimit =
  typeof connectorRateLimitsTable.$inferInsert;