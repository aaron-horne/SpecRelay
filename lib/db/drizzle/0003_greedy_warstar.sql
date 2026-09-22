ALTER TABLE "credential_metadata" ALTER COLUMN "status" SET DEFAULT 'REVOKED';--> statement-breakpoint
ALTER TABLE "api_spec_versions" ADD COLUMN "security_schemes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "api_operations" ADD COLUMN "security_groups" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "scheme_name" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "credential_type" text DEFAULT 'API_KEY' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "location" text DEFAULT 'header' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "parameter_name" text DEFAULT 'X-Legacy-Credential' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "label" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "secret_ciphertext" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "secret_iv" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "secret_auth_tag" text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX "credential_metadata_scheme_idx" ON "credential_metadata" USING btree ("workspace_id","api_id","scheme_name","status");