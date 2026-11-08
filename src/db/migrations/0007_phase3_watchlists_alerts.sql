CREATE TYPE "public"."alert_channel" AS ENUM('slack', 'email');--> statement-breakpoint
CREATE TYPE "public"."alert_kind" AS ENUM('new', 'kev');--> statement-breakpoint
CREATE TYPE "public"."alert_status" AS ENUM('pending', 'sent', 'failed', 'skipped');--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"watchlist_id" uuid NOT NULL,
	"anchor_item_id" uuid NOT NULL,
	"kind" "alert_kind" NOT NULL,
	"story_id" uuid,
	"title" text NOT NULL,
	"had_kev" boolean NOT NULL,
	"status" "alert_status" DEFAULT 'pending' NOT NULL,
	"sent_channels" "alert_channel"[] DEFAULT '{}'::alert_channel[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "alert_deliveries_once" UNIQUE("watchlist_id","anchor_item_id","kind")
);
--> statement-breakpoint
CREATE TABLE "watchlists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"terms" text[] NOT NULL,
	"min_cvss" numeric(3, 1),
	"kev_only" boolean DEFAULT false NOT NULL,
	"ransomware_only" boolean DEFAULT false NOT NULL,
	"channels" "alert_channel"[] DEFAULT '{}'::alert_channel[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watchlists_terms_nonempty" CHECK (cardinality("watchlists"."terms") > 0),
	CONSTRAINT "watchlists_min_cvss_range" CHECK ("watchlists"."min_cvss" IS NULL OR ("watchlists"."min_cvss" >= 0 AND "watchlists"."min_cvss" <= 10))
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_watchlist_id_watchlists_id_fk" FOREIGN KEY ("watchlist_id") REFERENCES "public"."watchlists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_anchor_item_id_items_id_fk" FOREIGN KEY ("anchor_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_deliveries_pending_idx" ON "alert_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "alert_deliveries_created_idx" ON "alert_deliveries" USING btree ("created_at" DESC NULLS LAST);