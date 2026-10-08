ALTER TABLE `public_playlist_cleanup` ADD COLUMN `retry_authorized` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DROP TABLE IF EXISTS `admin_audit_log`;--> statement-breakpoint
CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`previous_status` text,
	`next_status` text,
	`result` text NOT NULL,
	`details` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "admin_audit_log_reason_len" CHECK(length(`reason`) >= 1 AND length(`reason`) <= 500)
);--> statement-breakpoint
CREATE INDEX `admin_audit_log_admin_user_index` ON `admin_audit_log` (`admin_user_id`);--> statement-breakpoint
CREATE INDEX `admin_audit_log_target_index` ON `admin_audit_log` (`target_type`, `target_id`);--> statement-breakpoint
UPDATE `schema_meta` SET `value` = '20' WHERE `key` = 'schema_version';
