CREATE TABLE `public_playlist_cleanup` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`status` text NOT NULL,
	`last_error_code` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_playlist_cleanup_account_id_valid" CHECK(length("public_playlist_cleanup"."account_id") > 0),
	CONSTRAINT "public_playlist_cleanup_playlist_id_valid" CHECK(length("public_playlist_cleanup"."playlist_id") > 0),
	CONSTRAINT "public_playlist_cleanup_version_valid" CHECK("public_playlist_cleanup"."version" > 0),
	CONSTRAINT "public_playlist_cleanup_status_valid" CHECK("public_playlist_cleanup"."status" IN ('ready', 'sending', 'awaitingConfirmation', 'waitingAuthorization', 'needsAdministrator', 'succeeded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_playlist_cleanup_target_unique` ON `public_playlist_cleanup` (`account_id`, `playlist_id`);--> statement-breakpoint
CREATE INDEX `public_playlist_cleanup_user_status_index` ON `public_playlist_cleanup` (`user_id`, `status`);--> statement-breakpoint
UPDATE `schema_meta` SET `value` = '17' WHERE `key` = 'schema_version';
