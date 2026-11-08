ALTER TABLE "stories" ADD COLUMN "summary_item_count" integer;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "summary_model" text;--> statement-breakpoint
ALTER TABLE "stories" ADD COLUMN "summary_generated_at" timestamp with time zone;