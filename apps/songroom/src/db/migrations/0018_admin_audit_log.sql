ALTER TABLE `user` ADD COLUMN `role` text;--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `banned` integer;--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `ban_reason` text;--> statement-breakpoint
ALTER TABLE `user` ADD COLUMN `ban_expires` integer;--> statement-breakpoint
ALTER TABLE `session` ADD COLUMN `impersonated_by` text;--> statement-breakpoint
CREATE TABLE `admin_audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`admin_user_id` text NOT NULL,
	`target_user_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`set_password_result` text NOT NULL,
	`revoke_sessions_result` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "admin_audit_log_reason_len" CHECK(length(`reason`) >= 1 AND length(`reason`) <= 500)
);
--> statement-breakpoint
CREATE INDEX `admin_audit_log_admin_user_index` ON `admin_audit_log` (`admin_user_id`);--> statement-breakpoint
CREATE INDEX `admin_audit_log_target_user_index` ON `admin_audit_log` (`target_user_id`);--> statement-breakpoint
UPDATE `schema_meta` SET `value` = '19' WHERE `key` = 'schema_version';
