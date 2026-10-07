CREATE TABLE `playlist_snapshot` (
	`account_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`snapshot_version` integer DEFAULT 0 NOT NULL,
	`synced_at` integer,
	`last_error_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `playlist_id`),
	CONSTRAINT "playlist_snapshot_account_id_valid" CHECK(length("playlist_snapshot"."account_id") > 0),
	CONSTRAINT "playlist_snapshot_playlist_id_valid" CHECK(length("playlist_snapshot"."playlist_id") > 0),
	CONSTRAINT "playlist_snapshot_version_valid" CHECK("playlist_snapshot"."snapshot_version" >= 0),
	CONSTRAINT "playlist_snapshot_synced_at_valid" CHECK("playlist_snapshot"."synced_at" IS NULL OR "playlist_snapshot"."synced_at" > 0)
);
--> statement-breakpoint
CREATE TABLE `playlist_track` (
	`account_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`position` integer NOT NULL,
	`song_id` text NOT NULL,
	`name` text NOT NULL,
	`artists` text NOT NULL,
	`album` text NOT NULL,
	PRIMARY KEY(`account_id`, `playlist_id`, `position`),
	FOREIGN KEY (`account_id`, `playlist_id`) REFERENCES `playlist_snapshot`(`account_id`, `playlist_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "playlist_track_position_valid" CHECK("playlist_track"."position" >= 0),
	CONSTRAINT "playlist_track_song_id_valid" CHECK(length("playlist_track"."song_id") > 0),
	CONSTRAINT "playlist_track_name_valid" CHECK(length("playlist_track"."name") > 0)
);
--> statement-breakpoint
CREATE INDEX `playlist_track_target_song_index` ON `playlist_track` (`account_id`, `playlist_id`, `song_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `playlist_snapshot` (`account_id`, `playlist_id`, `snapshot_version`, `synced_at`, `created_at`, `updated_at`)
SELECT `account_id`, `playlist_id`, 0, NULL, strftime('%s','now')*1000, strftime('%s','now')*1000 FROM `public_playlist_binding`;
--> statement-breakpoint
UPDATE schema_meta SET value = '10' WHERE key = 'schema_version';
