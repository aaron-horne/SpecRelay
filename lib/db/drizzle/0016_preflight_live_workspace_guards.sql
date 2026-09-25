ALTER TABLE "semantic_analysis_preflight_tokens"
  ADD COLUMN IF NOT EXISTS "workspace_is_live" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE "semantic_analysis_preflight_tokens"
  ADD CONSTRAINT "semantic_analysis_preflight_tokens_workspace_live_fk"
    FOREIGN KEY ("workspace_id", "workspace_is_live")
    REFERENCES "workspaces" ("id", "is_live") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "semantic_analysis_preflight_tokens"
  ADD CONSTRAINT "semantic_analysis_preflight_tokens_live_check"
    CHECK ("workspace_is_live" = true);