CREATE TABLE IF NOT EXISTS "semantic_analysis_denial_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "actor_id" text,
  "request_category" text NOT NULL,
  "reason_class" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "semantic_analysis_denial_events_category_check"
    CHECK ("request_category" IN ('preflight', 'confirmation')),
  CONSTRAINT "semantic_analysis_denial_events_reason_check"
    CHECK ("reason_class" IN ('unauthenticated', 'workspace_unavailable', 'payload_confirmation_required', 'request_rejected'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_analysis_denial_events_created_idx"
  ON "semantic_analysis_denial_events" ("created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_analysis_denial_events_actor_created_idx"
  ON "semantic_analysis_denial_events" ("actor_id", "created_at");
--> statement-breakpoint
DROP TRIGGER IF EXISTS "semantic_analysis_preflight_tokens_reject_deleted_workspace_write"
  ON "semantic_analysis_preflight_tokens";