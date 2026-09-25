ALTER TABLE "semantic_analysis_proposals"
  ADD COLUMN "provider_config_id" uuid,
  ADD COLUMN "credential_revision" integer;
--> statement-breakpoint
ALTER TABLE "semantic_analysis_proposals"
  ADD CONSTRAINT "semantic_analysis_proposals_credential_revision_check"
  CHECK ("credential_revision" IS NULL OR "credential_revision" >= 0);