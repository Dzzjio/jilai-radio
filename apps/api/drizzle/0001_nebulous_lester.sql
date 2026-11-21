ALTER TABLE "tracks" ADD COLUMN "source" text DEFAULT 'upload' NOT NULL;--> statement-breakpoint
ALTER TABLE "tracks" ADD COLUMN "on_repeat" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_one_repeat_idx" ON "tracks" USING btree ("on_repeat") WHERE "tracks"."on_repeat";