ALTER TABLE "semantic_analysis_proposals"
  ADD COLUMN IF NOT EXISTS "mcp_preview_token_hash" text,
  ADD COLUMN IF NOT EXISTS "mcp_preview_actor_id" text,
  ADD COLUMN IF NOT EXISTS "mcp_preview_expires_at" timestamptz;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'semantic_analysis_proposals_mcp_preview_check'
      AND conrelid = 'semantic_analysis_proposals'::regclass
  ) THEN
    ALTER TABLE "semantic_analysis_proposals"
      ADD CONSTRAINT "semantic_analysis_proposals_mcp_preview_check"
      CHECK (
        ("mcp_preview_token_hash" IS NULL AND "mcp_preview_actor_id" IS NULL AND "mcp_preview_expires_at" IS NULL)
        OR ("mcp_preview_token_hash" IS NOT NULL AND "mcp_preview_actor_id" IS NOT NULL AND "mcp_preview_expires_at" IS NOT NULL)
      );
  END IF;
END $$;