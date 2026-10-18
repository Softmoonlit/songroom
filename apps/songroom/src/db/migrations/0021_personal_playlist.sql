CREATE TABLE `personal_playlist_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
	`member_id` text NOT NULL REFERENCES room_membership(id) ON DELETE CASCADE,
	`account_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL CHECK(type IN ('ownerCreated', 'ownerSubscribed')),
	`writeable` integer NOT NULL CHECK(writeable IN (0, 1)),
	`generation` integer NOT NULL DEFAULT 1 CHECK(generation > 0),
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK(length(playlist_id) > 0 AND length(account_id) > 0 AND length(name) > 0)
);--> statement-breakpoint
CREATE UNIQUE INDEX `personal_playlist_binding_room_member_unique` ON `personal_playlist_binding` (`room_id`, `member_id`);--> statement-breakpoint
CREATE INDEX `personal_playlist_binding_target_index` ON `personal_playlist_binding` (`account_id`, `playlist_id`);--> statement-breakpoint
UPDATE schema_meta SET value = '22' WHERE key = 'schema_version';
