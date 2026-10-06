CREATE TABLE `upstream_account` (
	`account_id` text PRIMARY KEY NOT NULL,
	`next_start_at` integer DEFAULT 0 NOT NULL,
	`running_operation_id` text,
	`paused` integer DEFAULT false NOT NULL,
	CONSTRAINT "upstream_account_next_start_valid" CHECK("upstream_account"."next_start_at" >= 0)
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_public_playlist_creation` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`step` text DEFAULT 'ready' NOT NULL,
	`playlist_id` text,
	FOREIGN KEY (`operation_id`) REFERENCES `operation`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "public_playlist_creation_step_valid" CHECK("__new_public_playlist_creation"."step" IN ('ready', 'verified', 'sending', 'confirming', 'succeeded', 'rejected', 'unknown', 'stopped')),
	CONSTRAINT "public_playlist_creation_returned_id_valid" CHECK(("__new_public_playlist_creation"."step" IN ('confirming', 'succeeded') AND "__new_public_playlist_creation"."playlist_id" IS NOT NULL AND length("__new_public_playlist_creation"."playlist_id") > 0) OR ("__new_public_playlist_creation"."step" NOT IN ('confirming', 'succeeded') AND "__new_public_playlist_creation"."playlist_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_public_playlist_creation`("operation_id", "name", "step", "playlist_id") SELECT "operation_id", "name", "step", "playlist_id" FROM `public_playlist_creation`;--> statement-breakpoint
DROP TABLE `public_playlist_creation`;--> statement-breakpoint
ALTER TABLE `__new_public_playlist_creation` RENAME TO `public_playlist_creation`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `operation` ADD `error_code` text;--> statement-breakpoint
ALTER TABLE `operation` ADD `last_granted` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE schema_meta SET value = '9' WHERE key = 'schema_version';