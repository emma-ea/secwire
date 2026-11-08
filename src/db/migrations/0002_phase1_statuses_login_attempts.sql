ALTER TYPE "public"."run_source_status" ADD VALUE 'skipped_disabled';--> statement-breakpoint
ALTER TYPE "public"."run_source_status" ADD VALUE 'skipped_cooldown';--> statement-breakpoint
ALTER TYPE "public"."run_source_status" ADD VALUE 'cancelled';--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"succeeded" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingestion_run_sources" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ingestion_run_sources" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ingestion_run_sources" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "login_attempts_ip_time_idx" ON "login_attempts" USING btree ("ip","attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "login_attempts_time_idx" ON "login_attempts" USING btree ("attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ingestion_run_sources_active_idx" ON "ingestion_run_sources" USING btree ("source_id") WHERE "ingestion_run_sources"."status" IN ('queued', 'running');