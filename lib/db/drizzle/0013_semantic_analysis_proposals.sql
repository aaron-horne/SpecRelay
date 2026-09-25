CREATE TYPE "public"."semantic_proposal_status" AS ENUM ('pending', 'accepted', 'rejected', 'stale');
--> statement-breakpoint
CREATE TABLE "semantic_analysis_proposals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "workspace_id" uuid NOT NULL,
  "workspace_is_live" boolean DEFAULT true NOT NULL,
  "api_id" uuid NOT NULL,
  "specification_id" uuid NOT NULL,
  "operation_id" uuid NOT NULL,
  "proposal_text" text NOT NULL,
  "proposal_kind" text DEFAULT 'description' NOT NULL,
  "confidence" real NOT NULL,
  "uncertainty" real NOT NULL,
  "source_field" text NOT NULL,
  "status" "semantic_proposal_status" DEFAULT 'pending' NOT NULL,
  "created_by" text NOT NULL,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "semantic_analysis_proposals_live_check" CHECK ("workspace_is_live" = true),
  CONSTRAINT "semantic_analysis_proposals_confidence_check" CHECK ("confidence" >= 0 AND "confidence" <= 1),
  CONSTRAINT "semantic_analysis_proposals_uncertainty_check" CHECK ("uncertainty" >= 0 AND "uncertainty" <= 1),
  CONSTRAINT "semantic_analysis_proposals_text_size_check" CHECK (length("proposal_text") BETWEEN 1 AND 500),
  CONSTRAINT "semantic_analysis_proposals_workspace_live_fk"
    FOREIGN KEY ("workspace_id", "workspace_is_live") REFERENCES "workspaces"("id", "is_live") ON DELETE CASCADE,
  CONSTRAINT "semantic_analysis_proposals_workspace_api_fk"
    FOREIGN KEY ("workspace_id", "api_id") REFERENCES "api_sources"("workspace_id", "id") ON DELETE CASCADE,
  CONSTRAINT "semantic_analysis_proposals_specification_fk"
    FOREIGN KEY ("workspace_id", "api_id", "specification_id")
    REFERENCES "api_spec_versions"("workspace_id", "api_id", "id") ON DELETE CASCADE,
  CONSTRAINT "semantic_analysis_proposals_operation_fk"
    FOREIGN KEY ("workspace_id", "api_id", "specification_id", "operation_id")
    REFERENCES "api_operations"("workspace_id", "api_id", "specification_id", "id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "semantic_analysis_proposals_workspace_api_idx"
  ON "semantic_analysis_proposals" ("workspace_id", "api_id", "created_at");
--> statement-breakpoint
CREATE INDEX "semantic_analysis_proposals_operation_idx"
  ON "semantic_analysis_proposals" ("workspace_id", "operation_id", "created_at");