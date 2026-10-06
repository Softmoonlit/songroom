CREATE TABLE `netease_authorization` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`nickname` text NOT NULL,
	`generation` integer NOT NULL,
	`status` text NOT NULL,
	`credentials` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "netease_authorization_generation_valid" CHECK("netease_authorization"."generation" > 0),
	CONSTRAINT "netease_authorization_status_valid" CHECK("netease_authorization"."status" = 'active'),
	CONSTRAINT "netease_authorization_account_valid" CHECK(length("netease_authorization"."account_id") > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `netease_authorization_user_unique` ON `netease_authorization` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `netease_authorization_account_unique` ON `netease_authorization` (`account_id`);--> statement-breakpoint
CREATE TABLE `qr_command_receipt` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`digest` text NOT NULL,
	`session_id` text NOT NULL,
	`flow_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "qr_command_receipt_kind_valid" CHECK("qr_command_receipt"."kind" IN ('start', 'confirm'))
);
--> statement-breakpoint
UPDATE `schema_meta` SET `value` = '4' WHERE `key` = 'schema_version';
