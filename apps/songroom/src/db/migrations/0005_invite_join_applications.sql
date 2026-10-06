CREATE TABLE `join_application` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`nickname` text NOT NULL,
	`invite_generation` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "join_application_nickname_valid" CHECK(length("join_application"."nickname") BETWEEN 1 AND 12),
	CONSTRAINT "join_application_generation_valid" CHECK("join_application"."invite_generation" > 0),
	CONSTRAINT "join_application_status_valid" CHECK("join_application"."status" IN ('pending', 'withdrawn', 'cancelled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `join_application_pending_user_room_unique` ON `join_application` (`room_id`,`user_id`) WHERE "join_application"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `join_application_user_status_index` ON `join_application` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `join_application_room_status_index` ON `join_application` (`room_id`,`status`);--> statement-breakpoint
CREATE TABLE `retired_room_invite` (
	`digest` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "retired_room_invite_digest_valid" CHECK(length("retired_room_invite"."digest") = 64 AND "retired_room_invite"."digest" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `retired_room_invite_room_index` ON `retired_room_invite` (`room_id`);
--> statement-breakpoint
UPDATE schema_meta SET value = '6' WHERE key = 'schema_version';
