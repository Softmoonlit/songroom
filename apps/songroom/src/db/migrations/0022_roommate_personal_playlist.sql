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
	CONSTRAINT "operation_kind_valid" CHECK("__new_operation"."kind" IN ('createPublicPlaylist', 'requestPublicSong', 'playNext', 'createPersonalPlaylist')),
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
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_personal_playlist_binding` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
	`member_id` text NOT NULL REFERENCES room_membership(id) ON DELETE CASCADE,
	`account_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL CHECK(type IN ('ownerCreated', 'ownerSubscribed', 'roommateDedicated')),
	`writeable` integer NOT NULL CHECK(writeable IN (0, 1)),
	`generation` integer NOT NULL DEFAULT 1 CHECK(generation > 0),
	`creation_operation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK(length(playlist_id) > 0 AND length(account_id) > 0 AND length(name) > 0)
);--> statement-breakpoint
INSERT INTO `__new_personal_playlist_binding`("id", "room_id", "member_id", "account_id", "playlist_id", "name", "type", "writeable", "generation", "creation_operation_id", "created_at", "updated_at")
SELECT "id", "room_id", "member_id", "account_id", "playlist_id", "name", "type", "writeable", "generation", NULL, "created_at", "updated_at" FROM `personal_playlist_binding`;--> statement-breakpoint
DROP TABLE `personal_playlist_binding`;--> statement-breakpoint
ALTER TABLE `__new_personal_playlist_binding` RENAME TO `personal_playlist_binding`;--> statement-breakpoint
CREATE UNIQUE INDEX `personal_playlist_binding_room_member_unique` ON `personal_playlist_binding` (`room_id`, `member_id`);--> statement-breakpoint
CREATE INDEX `personal_playlist_binding_target_index` ON `personal_playlist_binding` (`account_id`, `playlist_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `personal_playlist_creation` (
	`operation_id` text PRIMARY KEY NOT NULL REFERENCES operation(id) ON DELETE CASCADE,
	`owner_user_id` text NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`step` text NOT NULL DEFAULT 'ready' CHECK(step IN ('ready', 'verified', 'sending', 'confirming', 'succeeded', 'rejected', 'unknown', 'stopped')),
	`playlist_id` text,
	`before_playlists` text,
	`after_playlists` text,
	`sent_at` integer,
	`recovered` integer NOT NULL DEFAULT 0 CHECK(recovered IN (0, 1)),
	CHECK(length(name) >= 1 AND length(name) <= 100)
);--> statement-breakpoint
UPDATE schema_meta SET value = '23' WHERE key = 'schema_version';
