PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_join_application` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`user_id` text NOT NULL,
	`nickname` text NOT NULL,
	`invite_generation` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `room`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "join_application_nickname_valid" CHECK(length("__new_join_application"."nickname") BETWEEN 1 AND 12),
	CONSTRAINT "join_application_generation_valid" CHECK("__new_join_application"."invite_generation" > 0),
	CONSTRAINT "join_application_status_valid" CHECK("__new_join_application"."status" IN ('pending', 'withdrawn', 'cancelled', 'approved', 'rejected', 'nickname_conflict'))
);
--> statement-breakpoint
INSERT INTO `__new_join_application`("id", "room_id", "user_id", "nickname", "invite_generation", "status") SELECT "id", "room_id", "user_id", "nickname", "invite_generation", "status" FROM `join_application`;--> statement-breakpoint
DROP TABLE `join_application`;--> statement-breakpoint
ALTER TABLE `__new_join_application` RENAME TO `join_application`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `join_application_pending_user_room_unique` ON `join_application` (`room_id`,`user_id`) WHERE "join_application"."status" = 'pending';--> statement-breakpoint
CREATE INDEX `join_application_user_status_index` ON `join_application` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `join_application_room_status_index` ON `join_application` (`room_id`,`status`);
--> statement-breakpoint
UPDATE schema_meta SET value = '7' WHERE key = 'schema_version';