ALTER TABLE `public_playlist_cleanup` ADD COLUMN `retry_authorized` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `upstream_account` ADD COLUMN `pause_reason` text;--> statement-breakpoint
CREATE TABLE `admin_audit_log_new` (
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
INSERT INTO `admin_audit_log_new` (`id`, `admin_user_id`, `target_type`, `target_id`, `action`, `reason`, `result`, `details`, `created_at`)
SELECT `id`, `admin_user_id`, 'user', `target_user_id`, `action`, `reason`,
       CASE WHEN `set_password_result` = 'succeeded' AND `revoke_sessions_result` = 'succeeded' THEN 'succeeded'
            WHEN `set_password_result` = 'succeeded' THEN 'partially_completed'
            ELSE 'failed' END,
       json_object('setPasswordResult', `set_password_result`, 'revokeSessionsResult', `revoke_sessions_result`),
       `created_at`
FROM `admin_audit_log`;--> statement-breakpoint
DROP TABLE `admin_audit_log`;--> statement-breakpoint
ALTER TABLE `admin_audit_log_new` RENAME TO `admin_audit_log`;--> statement-breakpoint
CREATE INDEX `admin_audit_log_admin_user_index` ON `admin_audit_log` (`admin_user_id`);--> statement-breakpoint
CREATE INDEX `admin_audit_log_target_index` ON `admin_audit_log` (`target_type`, `target_id`);--> statement-breakpoint
UPDATE `schema_meta` SET `value` = '20' WHERE `key` = 'schema_version';
