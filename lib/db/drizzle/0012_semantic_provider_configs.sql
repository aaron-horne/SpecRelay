-- Semantic-provider credentials are independent of OpenAPI credential metadata.
-- The table is additive and retains the declarative live-workspace barrier.
CREATE TABLE IF NOT EXISTS "semantic_provider_configs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "workspace_is_live" boolean DEFAULT true NOT NULL,
  "provider" text NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "secret_ciphertext" text,
  "secret_iv" text,
  "secret_auth_tag" text,
  "key_id" text,
  "key_version" integer,
  "credential_revision" integer DEFAULT 0 NOT NULL,
  "last_tested_at" timestamp with time zone,
  "last_test_outcome" text,
  "tested_revision" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "semantic_provider_configs_workspace_provider_unique"
    UNIQUE ("workspace_id", "provider"),
  CONSTRAINT "semantic_provider_configs_live_check"
    CHECK ("workspace_is_live" = true),
  CONSTRAINT "semantic_provider_configs_workspace_live_fk"
    FOREIGN KEY ("workspace_id", "workspace_is_live")
    REFERENCES "workspaces"("id", "is_live")
    ON DELETE CASCADE
);