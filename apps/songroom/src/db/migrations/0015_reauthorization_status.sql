PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_netease_authorization` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`nickname` text NOT NULL,
	`generation` integer NOT NULL,
	`status` text NOT NULL,
	`credentials` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "netease_authorization_generation_valid" CHECK("__new_netease_authorization"."generation" > 0),
	CONSTRAINT "netease_authorization_status_valid" CHECK("__new_netease_authorization"."status" IN ('active', 'waitingAuthorization')),
	CONSTRAINT "netease_authorization_account_valid" CHECK(length("__new_netease_authorization"."account_id") > 0)
);
--> statement-breakpoint
INSERT INTO `__new_netease_authorization`("id", "user_id", "account_id", "nickname", "generation", "status", "credentials")
SELECT "id", "user_id", "account_id", "nickname", "generation", "status", "credentials" FROM `netease_authorization`;
--> statement-breakpoint
DROP TABLE `netease_authorization`;
--> statement-breakpoint
ALTER TABLE `__new_netease_authorization` RENAME TO `netease_authorization`;
--> statement-breakpoint
CREATE UNIQUE INDEX `netease_authorization_user_unique` ON `netease_authorization` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `netease_authorization_account_unique` ON `netease_authorization` (`account_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
UPDATE `schema_meta` SET `value` = '16' WHERE `key` = 'schema_version';
