PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_public_playlist_cleanup` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`creation_operation_id` text,
	`has_sent` integer DEFAULT 0 NOT NULL,
	`check_fact` text,
	`check_round` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`last_error_code` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_playlist_cleanup_account_id_valid" CHECK(length("__new_public_playlist_cleanup"."account_id") > 0),
	CONSTRAINT "public_playlist_cleanup_playlist_id_valid" CHECK(length("__new_public_playlist_cleanup"."playlist_id") > 0),
	CONSTRAINT "public_playlist_cleanup_version_valid" CHECK("__new_public_playlist_cleanup"."version" > 0),
	CONSTRAINT "public_playlist_cleanup_status_valid" CHECK("__new_public_playlist_cleanup"."status" IN ('ready', 'sending', 'awaitingConfirmation', 'waitingAuthorization', 'needsAdministrator', 'succeeded')),
	CONSTRAINT "public_playlist_cleanup_check_round_valid" CHECK("__new_public_playlist_cleanup"."check_round" >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_public_playlist_cleanup`("id", "user_id", "account_id", "playlist_id", "creation_operation_id", "has_sent", "check_fact", "check_round", "status", "last_error_code", "version", "created_at", "updated_at")
SELECT "id", "user_id", "account_id", "playlist_id", NULL, CASE WHEN "status" = 'ready' THEN 0 ELSE 1 END, NULL, 0, "status", "last_error_code", "version", "created_at", "updated_at" FROM `public_playlist_cleanup`;
--> statement-breakpoint
DROP TABLE `public_playlist_cleanup`;
--> statement-breakpoint
ALTER TABLE `__new_public_playlist_cleanup` RENAME TO `public_playlist_cleanup`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `public_playlist_cleanup_target_unique` ON `public_playlist_cleanup` (`account_id`, `playlist_id`);--> statement-breakpoint
CREATE INDEX `public_playlist_cleanup_user_status_index` ON `public_playlist_cleanup` (`user_id`, `status`);--> statement-breakpoint
UPDATE `schema_meta` SET `value` = '18' WHERE `key` = 'schema_version';
