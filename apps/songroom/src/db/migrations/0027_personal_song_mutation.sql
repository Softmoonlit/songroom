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
	CONSTRAINT "operation_kind_valid" CHECK("__new_operation"."kind" IN ('createPublicPlaylist', 'requestPublicSong', 'playNext', 'createPersonalPlaylist', 'replacePublicPlaylist', 'addPersonalSong', 'removePersonalSong')),
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
CREATE TABLE `personal_song_mutation` (
	`operation_id` text PRIMARY KEY NOT NULL REFERENCES operation(id) ON DELETE CASCADE,
	`member_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`binding_generation` integer NOT NULL CHECK(binding_generation > 0),
	`song_id` text NOT NULL CHECK(length(song_id) > 0),
	`name` text NOT NULL CHECK(length(name) > 0),
	`artists` text NOT NULL,
	`album` text NOT NULL,
	`step` text NOT NULL DEFAULT 'ready' CHECK(step IN ('ready', 'verified', 'prepared', 'sending', 'confirming', 'succeeded', 'rejected', 'unknown', 'stopped')),
	`check_round` integer NOT NULL DEFAULT 0 CHECK(check_round BETWEEN 0 AND 3),
	`next_check_at` integer,
	CHECK(length(playlist_id) > 0)
);--> statement-breakpoint
CREATE INDEX `personal_song_mutation_target_index` ON `personal_song_mutation` (`playlist_id`);--> statement-breakpoint
CREATE INDEX `personal_song_mutation_member_index` ON `personal_song_mutation` (`member_id`);--> statement-breakpoint
INSERT INTO personal_song_mutation SELECT * FROM personal_song_addition;--> statement-breakpoint
DROP TABLE personal_song_addition;--> statement-breakpoint
UPDATE schema_meta SET value = '28' WHERE key = 'schema_version';
