CREATE TYPE "public"."run_kind" AS ENUM('ingest', 'enrich', 'recluster', 'backfill');--> statement-breakpoint
CREATE TYPE "public"."run_source_status" AS ENUM('queued', 'coalesced', 'running', 'succeeded', 'not_modified', 'skipped_locked', 'failed');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."run_trigger" AS ENUM('schedule', 'admin', 'api', 'cli');--> statement-breakpoint
CREATE TYPE "public"."source_category" AS ENUM('news', 'research', 'advisory', 'community', 'social');--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('rss', 'cisa_kev', 'hackernews');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"scheduler_enabled" boolean DEFAULT true NOT NULL,
	"scheduler_interval_minutes" integer DEFAULT 15 NOT NULL,
	"enrich_refresh_enabled" boolean DEFAULT true NOT NULL,
	"last_tick_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "app_settings_singleton" CHECK ("app_settings"."id"),
	CONSTRAINT "app_settings_interval_preset" CHECK ("app_settings"."scheduler_interval_minutes" IN (5, 10, 15, 30, 60, 120, 180, 360, 720, 1440))
);
--> statement-breakpoint
CREATE TABLE "cves" (
	"id" text PRIMARY KEY NOT NULL,
	"description" text,
	"cvss_score" numeric(3, 1),
	"cvss_version" text,
	"cvss_vector" text,
	"cvss_severity" text,
	"epss_score" numeric,
	"epss_percentile" numeric,
	"in_kev" boolean DEFAULT false NOT NULL,
	"kev_date_added" date,
	"kev_due_date" date,
	"kev_ransomware" text,
	"kev_vendor" text,
	"kev_product" text,
	"kev_name" text,
	"nvd_published_at" timestamp with time zone,
	"nvd_enriched_at" timestamp with time zone,
	"epss_enriched_at" timestamp with time zone,
	CONSTRAINT "cves_id_format" CHECK ("cves"."id" ~ '^CVE-[0-9]{4}-[0-9]{4,7}$')
);
--> statement-breakpoint
CREATE TABLE "ingestion_run_sources" (
	"run_id" uuid NOT NULL,
	"source_id" text NOT NULL,
	"job_id" text,
	"status" "run_source_status" DEFAULT 'queued' NOT NULL,
	"coalesced_into_job_id" text,
	"http_status" integer,
	"items_seen" integer DEFAULT 0 NOT NULL,
	"items_new" integer DEFAULT 0 NOT NULL,
	"items_updated" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"error" text,
	CONSTRAINT "ingestion_run_sources_run_id_source_id_pk" PRIMARY KEY("run_id","source_id")
);
--> statement-breakpoint
CREATE TABLE "ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" "run_trigger" NOT NULL,
	"triggered_by" text,
	"kind" "run_kind" NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "item_cves" (
	"item_id" uuid NOT NULL,
	"cve_id" text NOT NULL,
	CONSTRAINT "item_cves_item_id_cve_id_pk" PRIMARY KEY("item_id","cve_id")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text NOT NULL,
	"canonical_url_hash" text NOT NULL,
	"title" text NOT NULL,
	"excerpt" text,
	"author" text,
	"published_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"story_id" uuid,
	"raw" jsonb,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce("items"."title", '') || ' ' || coalesce("items"."excerpt", ''))) STORED,
	CONSTRAINT "items_source_external_uq" UNIQUE("source_id","external_id"),
	CONSTRAINT "items_url_http" CHECK ("items"."url" ~* '^https?://'),
	CONSTRAINT "items_excerpt_len" CHECK ("items"."excerpt" IS NULL OR char_length("items"."excerpt") <= 400)
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" "source_type" NOT NULL,
	"url" text NOT NULL,
	"category" "source_category" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_interval_minutes" integer,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"etag" text,
	"last_modified" text,
	"last_fetched_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sources_min_interval_positive" CHECK ("sources"."min_interval_minutes" IS NULL OR "sources"."min_interval_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "stories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"item_count" integer DEFAULT 0 NOT NULL,
	"max_cvss" numeric(3, 1),
	"has_kev" boolean DEFAULT false NOT NULL,
	"max_epss" numeric,
	"summary" text
);
--> statement-breakpoint
CREATE TABLE "story_cves" (
	"story_id" uuid NOT NULL,
	"cve_id" text NOT NULL,
	CONSTRAINT "story_cves_story_id_cve_id_pk" PRIMARY KEY("story_id","cve_id")
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_beat_at" timestamp with time zone NOT NULL,
	"version" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ingestion_run_sources" ADD CONSTRAINT "ingestion_run_sources_run_id_ingestion_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ingestion_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_run_sources" ADD CONSTRAINT "ingestion_run_sources_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_cves" ADD CONSTRAINT "item_cves_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_cves" ADD CONSTRAINT "item_cves_cve_id_cves_id_fk" FOREIGN KEY ("cve_id") REFERENCES "public"."cves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_cves" ADD CONSTRAINT "story_cves_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_cves" ADD CONSTRAINT "story_cves_cve_id_cves_id_fk" FOREIGN KEY ("cve_id") REFERENCES "public"."cves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cves_in_kev_idx" ON "cves" USING btree ("in_kev") WHERE "cves"."in_kev";--> statement-breakpoint
CREATE INDEX "cves_kev_vendor_idx" ON "cves" USING btree (lower("kev_vendor"));--> statement-breakpoint
CREATE INDEX "cves_nvd_enriched_idx" ON "cves" USING btree ("nvd_enriched_at");--> statement-breakpoint
CREATE INDEX "ingestion_run_sources_source_idx" ON "ingestion_run_sources" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "ingestion_run_sources_job_idx" ON "ingestion_run_sources" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "ingestion_runs_created_idx" ON "ingestion_runs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ingestion_runs_trigger_created_idx" ON "ingestion_runs" USING btree ("trigger","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ingestion_runs_active_idx" ON "ingestion_runs" USING btree ("status") WHERE "ingestion_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE INDEX "item_cves_cve_idx" ON "item_cves" USING btree ("cve_id");--> statement-breakpoint
CREATE INDEX "items_canonical_url_hash_idx" ON "items" USING btree ("canonical_url_hash");--> statement-breakpoint
CREATE INDEX "items_story_id_idx" ON "items" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "items_unclustered_idx" ON "items" USING btree ("fetched_at") WHERE "items"."story_id" IS NULL;--> statement-breakpoint
CREATE INDEX "items_source_fetched_idx" ON "items" USING btree ("source_id","fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "items_published_idx" ON "items" USING btree ("published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "items_search_vector_idx" ON "items" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "sources_enabled_idx" ON "sources" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "stories_last_activity_idx" ON "stories" USING btree ("last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stories_first_seen_idx" ON "stories" USING btree ("first_seen_at");--> statement-breakpoint
CREATE INDEX "stories_item_count_idx" ON "stories" USING btree ("item_count" DESC NULLS LAST,"last_activity_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stories_risk_idx" ON "stories" USING btree ("has_kev" DESC NULLS LAST,"max_epss" DESC NULLS LAST,"max_cvss" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "story_cves_cve_idx" ON "story_cves" USING btree ("cve_id");--> statement-breakpoint
CREATE INDEX "worker_heartbeats_last_beat_idx" ON "worker_heartbeats" USING btree ("last_beat_at" DESC NULLS LAST);