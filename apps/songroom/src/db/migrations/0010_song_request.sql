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
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "operation_kind_valid" CHECK("__new_operation"."kind" IN ('createPublicPlaylist', 'requestPublicSong')),
	CONSTRAINT "operation_status_valid" CHECK("__new_operation"."status" IN ('queued', 'processing', 'awaitingConfirmation', 'waitingAuthorization', 'needsAdministrator', 'succeeded', 'failed', 'stopped')),
	CONSTRAINT "operation_recovery_scope_valid" CHECK(("__new_operation"."status" IN ('succeeded', 'failed', 'stopped') AND "__new_operation"."account_id" IS NULL AND "__new_operation"."authorization_id" IS NULL AND "__new_operation"."generation" IS NULL) OR ("__new_operation"."status" NOT IN ('succeeded', 'failed', 'stopped') AND "__new_operation"."account_id" IS NOT NULL AND "__new_operation"."authorization_id" IS NOT NULL AND "__new_operation"."generation" IS NOT NULL AND "__new_operation"."generation" > 0))
);
--> statement-breakpoint
INSERT INTO `__new_operation`("id", "kind", "user_id", "room_id", "account_id", "authorization_id", "generation", "status", "error_code", "last_granted", "created_at", "updated_at")
SELECT "id", "kind", "user_id", "room_id", "account_id", "authorization_id", "generation", "status", "error_code", "last_granted", "created_at", "updated_at" FROM `operation`;
--> statement-breakpoint
DROP TABLE `operation`;
--> statement-breakpoint
ALTER TABLE `__new_operation` RENAME TO `operation`;
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_pending_public_room_unique` ON `operation` (`room_id`) WHERE "operation"."kind" = 'createPublicPlaylist' AND "operation"."status" NOT IN ('succeeded', 'failed', 'stopped');
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_pending_user_room_unique` ON `operation` (`room_id`, `user_id`) WHERE "operation"."status" NOT IN ('succeeded', 'failed', 'stopped');
--> statement-breakpoint
CREATE INDEX `operation_room_created_index` ON `operation` (`room_id`,`created_at`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
CREATE TABLE `public_song_request` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`song_id` text NOT NULL,
	`name` text NOT NULL,
	`artists` text NOT NULL,
	`album` text NOT NULL,
	`step` text DEFAULT 'ready' NOT NULL,
	`song_confirmed` integer DEFAULT false NOT NULL,
	`tag_confirmed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operation`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "public_song_request_step_valid" CHECK("public_song_request"."step" IN ('ready', 'verified', 'sending', 'confirming', 'tagging', 'succeeded', 'rejected', 'unknown', 'stopped')),
	CONSTRAINT "public_song_request_song_id_valid" CHECK(length("public_song_request"."song_id") > 0),
	CONSTRAINT "public_song_request_name_valid" CHECK(length("public_song_request"."name") > 0)
);
--> statement-breakpoint
CREATE TABLE `requester_tag` (
	`room_id` text NOT NULL,
	`binding_generation` integer NOT NULL,
	`song_id` text NOT NULL,
	`member_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`room_id`, `binding_generation`, `song_id`, `member_id`),
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`member_id`) REFERENCES `room_membership`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "requester_tag_generation_valid" CHECK("requester_tag"."binding_generation" > 0),
	CONSTRAINT "requester_tag_song_id_valid" CHECK(length("requester_tag"."song_id") > 0)
);
--> statement-breakpoint
CREATE INDEX `requester_tag_room_song_index` ON `requester_tag` (`room_id`, `binding_generation`, `song_id`);
--> statement-breakpoint
UPDATE schema_meta SET value = '11' WHERE key = 'schema_version';
