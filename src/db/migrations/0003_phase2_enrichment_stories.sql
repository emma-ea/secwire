DROP INDEX "items_story_id_idx";--> statement-breakpoint
DROP INDEX "items_unclustered_idx";--> statement-breakpoint
DROP INDEX "stories_item_count_idx";--> statement-breakpoint
DROP INDEX "stories_risk_idx";--> statement-breakpoint
ALTER TABLE "cves" ADD COLUMN "nvd_status" text;--> statement-breakpoint
ALTER TABLE "cves" ADD COLUMN "nvd_vendor" text;--> statement-breakpoint
ALTER TABLE "cves" ADD COLUMN "nvd_product" text;--> statement-breakpoint
ALTER TABLE "cves" ADD COLUMN "cwe_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "activity_at" timestamp with time zone GENERATED ALWAYS AS (LEAST("items"."published_at", "items"."fetched_at")) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "max_epss_percentile" numeric;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "has_ransomware" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "cve_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "vendors" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "source_ids" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
CREATE INDEX "cves_epss_enriched_idx" ON "cves" USING btree ("epss_enriched_at");--> statement-breakpoint
CREATE INDEX "items_activity_idx" ON "items" USING btree ("activity_at");--> statement-breakpoint
CREATE INDEX "items_story_activity_idx" ON "items" USING btree ("story_id","activity_at");--> statement-breakpoint
CREATE INDEX "stories_source_ids_idx" ON "stories" USING gin ("source_ids");--> statement-breakpoint
CREATE INDEX "items_unclustered_idx" ON "items" USING btree ("activity_at","id") WHERE "items"."story_id" IS NULL;--> statement-breakpoint
CREATE INDEX "stories_item_count_idx" ON "stories" USING btree ("item_count" DESC NULLS LAST,"last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stories_risk_idx" ON "stories" USING btree ("has_kev" DESC NULLS LAST,coalesce("max_epss", -1) DESC,coalesce("max_cvss", -1) DESC,"last_activity_at" DESC NULLS LAST,"id" DESC NULLS LAST);