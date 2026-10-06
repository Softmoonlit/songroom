CREATE TABLE `command_receipt` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`digest` text NOT NULL,
	`resource_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `room` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "room_version_valid" CHECK("room"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE `room_invite` (
	`room_id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "room_invite_code_valid" CHECK(length("room_invite"."code") = 10 AND "room_invite"."code" NOT GLOB '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "room_invite_generation_valid" CHECK("room_invite"."generation" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_invite_code_unique` ON `room_invite` (`code`);--> statement-breakpoint
CREATE TABLE `room_membership` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`nickname` text NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "room_membership_nickname_valid" CHECK(length("room_membership"."nickname") BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_membership_user_unique` ON `room_membership` (`room_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_membership_nickname_unique` ON `room_membership` (`room_id`,`nickname`);--> statement-breakpoint
INSERT INTO command_receipt (user_id, key, digest, resource_id, expires_at)
SELECT user_id, key, digest, flow_id, expires_at FROM qr_command_receipt;
--> statement-breakpoint
DROP TABLE `qr_command_receipt`;
--> statement-breakpoint
UPDATE schema_meta SET value = '5' WHERE key = 'schema_version';