CREATE TABLE IF NOT EXISTS "connector_rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connector_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
"event_type" text NOT NULL,
	"workspace_id" uuid,
	"actor_id" uuid
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_rate_limits_until_idx" ON "connector_rate_limits" USING btree ("until");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_security_events_occurred_at_idx" ON "connector_security_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connector_security_events_workspace_occurred_at_idx" ON "connector_security_events" USING btree ("workspace_id","occurred_at");