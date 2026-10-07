DROP TABLE IF EXISTS `public_song_request`;
--> statement-breakpoint
CREATE TABLE `public_song_request` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`name` text NOT NULL,
	`artists` text NOT NULL,
	`album` text NOT NULL,
	`step` text DEFAULT 'ready' NOT NULL,
	`song_confirmed` integer DEFAULT false NOT NULL,
	`tag_confirmed` integer DEFAULT false NOT NULL,
	`playlist_id` text NOT NULL,
	`binding_generation` integer NOT NULL,
	`check_round` integer DEFAULT 0 NOT NULL,
	`next_check_at` integer,
	FOREIGN KEY (`operation_id`) REFERENCES `operation`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_song_request_step_valid" CHECK("public_song_request"."step" IN ('ready', 'verified', 'sending', 'confirming', 'tagging', 'succeeded', 'rejected', 'unknown', 'stopped')),
	CONSTRAINT "public_song_request_song_id_valid" CHECK(length("public_song_request"."song_id") > 0),
	CONSTRAINT "public_song_request_name_valid" CHECK(length("public_song_request"."name") > 0),
	CONSTRAINT "public_song_request_playlist_id_valid" CHECK(length("public_song_request"."playlist_id") > 0),
	CONSTRAINT "public_song_request_binding_generation_valid" CHECK("public_song_request"."binding_generation" > 0),
	CONSTRAINT "public_song_request_check_round_valid" CHECK("public_song_request"."check_round" >= 0 AND "public_song_request"."check_round" <= 3)
);
--> statement-breakpoint
CREATE INDEX `public_song_request_target_index` ON `public_song_request` (`playlist_id`);
--> statement-breakpoint
UPDATE schema_meta SET value = '12' WHERE key = 'schema_version';
