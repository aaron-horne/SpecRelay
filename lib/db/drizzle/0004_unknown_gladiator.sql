UPDATE "credential_metadata" SET "status" = 'REVOKED' WHERE "secret_ciphertext" = '' OR "secret_iv" = '' OR "secret_auth_tag" = '';--> statement-breakpoint
ALTER TABLE "credential_metadata" ALTER COLUMN "status" SET DEFAULT 'REVOKED';--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "key_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD COLUMN "key_id" text DEFAULT 'credential-key-v1' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "credential_metadata_workspace_api_scheme_unique" ON "credential_metadata" USING btree ("workspace_id","api_id","scheme_name");