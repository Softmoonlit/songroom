ALTER TABLE `public_song_request` ADD COLUMN `source_playlist_id` text;--> statement-breakpoint
ALTER TABLE `public_song_request` ADD COLUMN `source_binding_generation` integer;--> statement-breakpoint
ALTER TABLE `public_song_request` ADD COLUMN `source_member_id` text;--> statement-breakpoint
CREATE INDEX `public_song_request_source_playlist_index` ON `public_song_request` (`source_playlist_id`);--> statement-breakpoint
CREATE INDEX `public_song_request_source_member_index` ON `public_song_request` (`source_member_id`);--> statement-breakpoint
UPDATE schema_meta SET value = '27' WHERE key = 'schema_version';
