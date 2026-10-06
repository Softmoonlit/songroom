CREATE TABLE `operation` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`user_id` text NOT NULL,
	`room_id` text NOT NULL,
	`account_id` text,
	`authorization_id` text,
	`generation` integer,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "operation_kind_valid" CHECK("operation"."kind" = 'createPublicPlaylist'),
	CONSTRAINT "operation_status_valid" CHECK("operation"."status" IN ('queued', 'processing', 'awaitingConfirmation', 'waitingAuthorization', 'needsAdministrator', 'succeeded', 'failed', 'stopped')),
	CONSTRAINT "operation_recovery_scope_valid" CHECK(("operation"."status" IN ('succeeded', 'failed', 'stopped') AND "operation"."account_id" IS NULL AND "operation"."authorization_id" IS NULL AND "operation"."generation" IS NULL) OR ("operation"."status" NOT IN ('succeeded', 'failed', 'stopped') AND "operation"."account_id" IS NOT NULL AND "operation"."authorization_id" IS NOT NULL AND "operation"."generation" IS NOT NULL AND "operation"."generation" > 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `operation_pending_public_room_unique` ON `operation` (`room_id`) WHERE "operation"."kind" = 'createPublicPlaylist' AND "operation"."status" NOT IN ('succeeded', 'failed', 'stopped');--> statement-breakpoint
CREATE INDEX `operation_room_created_index` ON `operation` (`room_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `public_playlist_binding` (
	`room_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`playlist_id` text NOT NULL,
	`name` text NOT NULL,
	`creation_operation_id` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "public_playlist_binding_generation_valid" CHECK("public_playlist_binding"."generation" > 0),
	CONSTRAINT "public_playlist_binding_id_valid" CHECK(length("public_playlist_binding"."playlist_id") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `public_playlist_binding_target_unique` ON `public_playlist_binding` (`account_id`,`playlist_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `public_playlist_binding_creation_unique` ON `public_playlist_binding` (`creation_operation_id`);--> statement-breakpoint
CREATE TABLE `public_playlist_creation` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`step` text DEFAULT 'ready' NOT NULL,
	`playlist_id` text,
	FOREIGN KEY (`operation_id`) REFERENCES `operation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "public_playlist_creation_step_valid" CHECK("public_playlist_creation"."step" IN ('ready', 'sending', 'confirming', 'succeeded', 'rejected', 'unknown', 'stopped')),
	CONSTRAINT "public_playlist_creation_returned_id_valid" CHECK(("public_playlist_creation"."step" IN ('confirming', 'succeeded') AND "public_playlist_creation"."playlist_id" IS NOT NULL AND length("public_playlist_creation"."playlist_id") > 0) OR ("public_playlist_creation"."step" NOT IN ('confirming', 'succeeded') AND "public_playlist_creation"."playlist_id" IS NULL))
);

--> statement-breakpoint
UPDATE schema_meta SET value = '8' WHERE key = 'schema_version';
