import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const semanticAnalysisDenialEventsTable = pgTable(
  "semantic_analysis_denial_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorId: text("actor_id"),
    requestCategory: text("request_category").notNull(),
    reasonClass: text("reason_class").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("semantic_analysis_denial_events_created_idx").on(table.createdAt),
    index("semantic_analysis_denial_events_actor_created_idx").on(table.actorId, table.createdAt),
    check("semantic_analysis_denial_events_category_check", sql`${table.requestCategory} IN ('preflight', 'confirmation', 'dispatch')`),
    check("semantic_analysis_denial_events_reason_check", sql`${table.reasonClass} IN ('unauthenticated', 'workspace_unavailable', 'payload_confirmation_required', 'request_rejected')`),
  ],
);

export type SemanticAnalysisDenialEventRow = typeof semanticAnalysisDenialEventsTable.$inferSelect;