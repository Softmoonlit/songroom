CREATE TABLE `retired_public_playlist_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`account_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`name` text NOT NULL,
	`generation` integer NOT NULL,
	`invalidated_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "retired_public_playlist_binding_generation_valid" CHECK("generation" > 0),
	CONSTRAINT "retired_public_playlist_binding_id_valid" CHECK(length("playlist_id") > 0)
);
--> statement-breakpoint
CREATE INDEX `retired_public_playlist_binding_room_generation_index` ON `retired_public_playlist_binding` (`room_id`, `generation`);
--> statement-breakpoint
CREATE INDEX `retired_public_playlist_binding_account_playlist_index` ON `retired_public_playlist_binding` (`account_id`, `playlist_id`);
--> statement-breakpoint
UPDATE schema_meta SET value = '14' WHERE key = 'schema_version';
