ALTER TABLE `public_playlist_creation` ADD `before_playlists` text;
--> statement-breakpoint
ALTER TABLE `public_playlist_creation` ADD `after_playlists` text;
--> statement-breakpoint
ALTER TABLE `public_playlist_creation` ADD `sent_at` integer;
--> statement-breakpoint
ALTER TABLE `public_playlist_creation` ADD `recovered` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE schema_meta SET value = '13' WHERE key = 'schema_version';
