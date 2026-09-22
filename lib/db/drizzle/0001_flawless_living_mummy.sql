CREATE TABLE "workspace_memberships" (
	"workspace_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'MEMBER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_memberships_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_memberships" ADD CONSTRAINT "workspace_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_memberships_user_idx" ON "workspace_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_sources_workspace_id_unique" ON "api_sources" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_spec_versions_workspace_api_id_unique" ON "api_spec_versions" USING btree ("workspace_id","api_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_operations_workspace_id_unique" ON "api_operations" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "api_spec_versions" ADD CONSTRAINT "api_spec_versions_workspace_api_fk" FOREIGN KEY ("workspace_id","api_id") REFERENCES "public"."api_sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_operations" ADD CONSTRAINT "api_operations_workspace_api_fk" FOREIGN KEY ("workspace_id","api_id") REFERENCES "public"."api_sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_operations" ADD CONSTRAINT "api_operations_workspace_specification_fk" FOREIGN KEY ("workspace_id","api_id","specification_id") REFERENCES "public"."api_spec_versions"("workspace_id","api_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_policies" ADD CONSTRAINT "operation_policies_workspace_operation_fk" FOREIGN KEY ("workspace_id","operation_id") REFERENCES "public"."api_operations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credential_metadata" ADD CONSTRAINT "credential_metadata_workspace_api_fk" FOREIGN KEY ("workspace_id","api_id") REFERENCES "public"."api_sources"("workspace_id","id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();