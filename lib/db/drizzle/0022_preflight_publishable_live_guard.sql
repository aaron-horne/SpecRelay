-- The composite live-workspace FK and CHECK already reject writes for deleted
-- workspaces. Publish generates both, but does not replay custom trigger SQL.
-- Remove the redundant dev-only trigger and single-column workspace FK.
DROP TRIGGER IF EXISTS "semantic_preflight_tokens_reject_deleted_workspace_write"
  ON "semantic_analysis_preflight_tokens";
--> statement-breakpoint
ALTER TABLE "semantic_analysis_preflight_tokens"
  DROP CONSTRAINT IF EXISTS "semantic_analysis_preflight_tokens_workspace_id_fkey";