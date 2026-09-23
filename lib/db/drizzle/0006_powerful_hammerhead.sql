CREATE TABLE "connector_actors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"member_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"lookup_id" text NOT NULL,
	"verifier" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "api_spec_versions" ALTER COLUMN "is_active" SET DEFAULT false;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_actors_workspace_id_unique" ON "connector_actors" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_actors_member_unique" ON "connector_actors" USING btree ("workspace_id","member_id");--> statement-breakpoint
ALTER TABLE "connector_actors" ADD CONSTRAINT "connector_actors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_actors" ADD CONSTRAINT "connector_actors_workspace_id_member_id_workspace_memberships_workspace_id_user_id_fk" FOREIGN KEY ("workspace_id","member_id") REFERENCES "public"."workspace_memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_tokens" ADD CONSTRAINT "connector_tokens_workspace_id_actor_id_connector_actors_workspace_id_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."connector_actors"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_tokens_lookup_unique" ON "connector_tokens" USING btree ("lookup_id");--> statement-breakpoint
CREATE INDEX "connector_tokens_workspace_actor_idx" ON "connector_tokens" USING btree ("workspace_id","actor_id");