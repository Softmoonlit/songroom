DROP TABLE IF EXISTS `public_playlist_creation`;
--> statement-breakpoint
CREATE TABLE `public_playlist_creation` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`step` text DEFAULT 'ready' NOT NULL,
	`playlist_id` text,
	`before_playlists` text,
	`after_playlists` text,
	`sent_at` integer,
	`recovered` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "public_playlist_creation_step_valid" CHECK("public_playlist_creation"."step" IN ('ready', 'verified', 'sending', 'confirming', 'succeeded', 'rejected', 'unknown', 'stopped')),
	CONSTRAINT "public_playlist_creation_returned_id_valid" CHECK(("public_playlist_creation"."step" IN ('confirming', 'succeeded') AND "public_playlist_creation"."playlist_id" IS NOT NULL AND length("public_playlist_creation"."playlist_id") > 0) OR ("public_playlist_creation"."step" NOT IN ('confirming', 'succeeded') AND "public_playlist_creation"."playlist_id" IS NULL)),
	CONSTRAINT "public_playlist_creation_sent_at_valid" CHECK("public_playlist_creation"."sent_at" IS NULL OR "public_playlist_creation"."sent_at" > 0),
	CONSTRAINT "public_playlist_creation_recovered_valid" CHECK("public_playlist_creation"."recovered" IN (0, 1))
);
--> statement-breakpoint
UPDATE schema_meta SET value = '13' WHERE key = 'schema_version';
