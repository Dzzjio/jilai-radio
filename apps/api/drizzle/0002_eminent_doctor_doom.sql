CREATE TABLE "site_appearance" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"text" text,
	"bg_kind" text,
	"bg_file" text,
	"bg_poster" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_appearance_single_row" CHECK ("site_appearance"."id" = 1)
);
