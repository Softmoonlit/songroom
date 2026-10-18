PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`room_id` text NOT NULL,
	`account_id` text,
	`authorization_id` text,
	`generation` integer,
	`status` text NOT NULL,
	`error_code` text,
	`last_granted` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "operation_version_valid" CHECK("__new_operation"."version" > 0),
	CONSTRAINT "operation_kind_valid" CHECK("__new_operation"."kind" IN ('createPublicPlaylist', 'requestPublicSong', 'playNext', 'createPersonalPlaylist', 'replacePublicPlaylist')),
	CONSTRAINT "operation_status_valid" CHECK("__new_operation"."status" IN ('queued', 'processing', 'awaitingConfirmation', 'waitingAuthorization', 'needsAdministrator', 'succeeded', 'failed', 'stopped')),
	CONSTRAINT "operation_recovery_scope_valid" CHECK(("__new_operation"."status" IN ('succeeded', 'failed', 'stopped') AND "__new_operation"."account_id" IS NULL AND "__new_operation"."authorization_id" IS NULL AND "__new_operation"."generation" IS NULL) OR ("__new_operation"."status" NOT IN ('succeeded', 'failed', 'stopped') AND "__new_operation"."account_id" IS NOT NULL AND "__new_operation"."authorization_id" IS NOT NULL AND "__new_operation"."generation" IS NOT NULL AND "__new_operation"."generation" > 0))
);--> statement-breakpoint
INSERT INTO `__new_operation`("id", "kind", "user_id", "room_id", "account_id", "authorization_id", "generation", "status", "error_code", "last_granted", "version", "created_at", "updated_at")
SELECT "id", "kind", "user_id", "room_id", "account_id", "authorization_id", "generation", "status", "error_code", "last_granted", "version", "created_at", "updated_at" FROM `operation`;--> statement-breakpoint
DROP TABLE `operation`;--> statement-breakpoint
ALTER TABLE `__new_operation` RENAME TO `operation`;--> statement-breakpoint
CREATE UNIQUE INDEX `operation_pending_public_room_unique` ON `operation` (`room_id`) WHERE "operation"."kind" = 'createPublicPlaylist' AND "operation"."status" NOT IN ('succeeded', 'failed', 'stopped');--> statement-breakpoint
CREATE UNIQUE INDEX `operation_pending_user_room_unique` ON `operation` (`room_id`, `user_id`) WHERE "operation"."status" NOT IN ('succeeded', 'failed', 'stopped');--> statement-breakpoint
CREATE INDEX `operation_room_created_index` ON `operation` (`room_id`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `public_playlist_replacement` (
	`operation_id` text PRIMARY KEY NOT NULL REFERENCES operation(id) ON DELETE CASCADE,
	`playlist_id` text NOT NULL,
	`binding_generation` integer NOT NULL CHECK(binding_generation > 0),
	`target_count` integer NOT NULL CHECK(target_count >= 0),
	`target_tracks` text NOT NULL,
	`original_song_ids` text NOT NULL,
	`sources` text NOT NULL DEFAULT '[]',
	`added_song_ids` text NOT NULL DEFAULT '[]',
	`removed_song_ids` text NOT NULL DEFAULT '[]',
	`current_action` text CHECK(current_action IS NULL OR current_action IN ('add', 'remove')),
	`current_song_id` text,
	`step` text NOT NULL DEFAULT 'ready' CHECK(step IN ('ready', 'verified', 'sending', 'confirming', 'tagging', 'succeeded', 'rejected', 'unknown', 'stopped')),
	`tag_confirmed` integer NOT NULL DEFAULT 0 CHECK(tag_confirmed IN (0, 1)),
	`check_round` integer NOT NULL DEFAULT 0 CHECK(check_round BETWEEN 0 AND 3),
	`next_check_at` integer,
	CHECK(length(playlist_id) > 0)
);--> statement-breakpoint
CREATE INDEX `public_playlist_replacement_target_index` ON `public_playlist_replacement` (`playlist_id`);--> statement-breakpoint
UPDATE schema_meta SET value = '24' WHERE key = 'schema_version';
