CREATE TYPE "public"."operation_risk" AS ENUM('READ_LIKE', 'WRITE', 'DESTRUCTIVE', 'UNKNOWN');--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_spec_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"api_id" uuid NOT NULL,
	"version" text NOT NULL,
	"format" text NOT NULL,
	"openapi_version" text NOT NULL,
	"document_hash" text NOT NULL,
	"raw_document" text NOT NULL,
	"normalized_document" jsonb NOT NULL,
	"server_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation_warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"api_id" uuid NOT NULL,
	"specification_id" uuid NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"operation_id" text,
	"display_name" text NOT NULL,
	"summary" text,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"parameters" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_body" jsonb,
	"responses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"security_requirements" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"risk" "operation_risk" NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"decision" text DEFAULT 'DENY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credential_metadata" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"api_id" uuid NOT NULL,
	"provider_name" text NOT NULL,
	"external_reference" text NOT NULL,
	"destination_host" text NOT NULL,
	"status" text DEFAULT 'DISABLED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_sources" ADD CONSTRAINT "api_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_spec_versions" ADD CONSTRAINT "api_spec_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_spec_versions" ADD CONSTRAINT "api_spec_versions_api_id_api_sources_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."api_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_operations" ADD CONSTRAINT "api_operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_operations" ADD CONSTRAINT "api_operations_api_id_api_sources_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."api_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_operations" ADD CONSTRAINT "api_operations_specification_id_api_spec_versions_id_fk" FOREIGN KEY ("specification_id") REFERENCES "public"."api_spec_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_policies" ADD CONSTRAINT "operation_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_policies" ADD CONSTRAINT "operation_policies_operation_id_api_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."api_operations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD CONSTRAINT "credential_metadata_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD CONSTRAINT "credential_metadata_api_id_api_sources_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."api_sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_sources_workspace_idx" ON "api_sources" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_sources_workspace_name_unique" ON "api_sources" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "api_spec_versions_workspace_api_idx" ON "api_spec_versions" USING btree ("workspace_id","api_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_spec_versions_api_hash_unique" ON "api_spec_versions" USING btree ("api_id","document_hash");--> statement-breakpoint
CREATE INDEX "api_operations_workspace_api_idx" ON "api_operations" USING btree ("workspace_id","api_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_operations_spec_method_path_unique" ON "api_operations" USING btree ("specification_id","method","path");--> statement-breakpoint
CREATE INDEX "operation_policies_workspace_idx" ON "operation_policies" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "operation_policies_workspace_operation_unique" ON "operation_policies" USING btree ("workspace_id","operation_id");--> statement-breakpoint
CREATE INDEX "credential_metadata_workspace_api_idx" ON "credential_metadata" USING btree ("workspace_id","api_id");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_created_idx" ON "audit_events" USING btree ("workspace_id","created_at");