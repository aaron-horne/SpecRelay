ALTER TABLE "semantic_analysis_proposals"
  ADD COLUMN IF NOT EXISTS "source_document_hash" text;
--> statement-breakpoint
UPDATE "semantic_analysis_proposals" p
SET "source_document_hash" = s."document_hash"
FROM "api_spec_versions" s
WHERE p."specification_id" = s."id"
  AND p."source_document_hash" IS NULL;
--> statement-breakpoint
ALTER TABLE "semantic_analysis_proposals"
  ALTER COLUMN "source_document_hash" SET NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "semantic_analysis_preflight_tokens" (
  "token_hash" text PRIMARY KEY,
  "actor_id" text NOT NULL,
  "workspace_id" uuid NOT NULL REFERENCES "workspaces"("id") ON DELETE CASCADE,
  "api_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "specification_id" uuid NOT NULL,
  "document_hash" text NOT NULL,
  "credential_id" uuid NOT NULL,
  "credential_revision" integer NOT NULL,
  "payload_digest" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "semantic_analysis_preflight_expiry_idx"
  ON "semantic_analysis_preflight_tokens" ("expires_at");