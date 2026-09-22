ALTER TABLE "operation_policies" ADD COLUMN "execution_approved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "operation_policies" ADD COLUMN "approved_by" text;--> statement-breakpoint
ALTER TABLE "operation_policies" ADD COLUMN "approved_at" timestamp with time zone;