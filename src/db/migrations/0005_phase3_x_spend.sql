ALTER TYPE "public"."run_source_status" ADD VALUE 'skipped_budget';--> statement-breakpoint
ALTER TYPE "public"."source_type" ADD VALUE 'x';--> statement-breakpoint
CREATE TABLE "api_spend" (
	"provider" text NOT NULL,
	"month" text NOT NULL,
	"usd" numeric(12, 6) DEFAULT 0 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_spend_provider_month_pk" PRIMARY KEY("provider","month"),
	CONSTRAINT "api_spend_month_format" CHECK ("api_spend"."month" ~ '^[0-9]{4}-[0-9]{2}$')
);
