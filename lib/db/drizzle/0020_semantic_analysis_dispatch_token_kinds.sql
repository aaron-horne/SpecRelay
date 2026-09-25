ALTER TABLE "semantic_analysis_preflight_tokens"
  ADD COLUMN IF NOT EXISTS "token_kind" text NOT NULL DEFAULT 'preflight';
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'semantic_analysis_preflight_tokens'::regclass
      AND conname = 'semantic_analysis_preflight_tokens_kind_check'
  ) THEN
    ALTER TABLE "semantic_analysis_preflight_tokens"
      ADD CONSTRAINT "semantic_analysis_preflight_tokens_kind_check"
      CHECK ("token_kind" IN ('preflight', 'dispatch'));
  END IF;
END
$$;