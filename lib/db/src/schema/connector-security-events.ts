import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const connectorSecurityEventsTable = pgTable(
  "connector_security_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    eventType: text("event_type").notNull(),
    workspaceId: uuid("workspace_id"),
    actorId: uuid("actor_id"),
  },
  (table) => [
    index("connector_security_events_occurred_at_idx").on(table.occurredAt),
    index("connector_security_events_workspace_occurred_at_idx").on(
      table.workspaceId,
      table.occurredAt,
    ),
  ],
);

export type ConnectorSecurityEvent =
  typeof connectorSecurityEventsTable.$inferSelect;
export type InsertConnectorSecurityEvent =
  typeof connectorSecurityEventsTable.$inferInsert;