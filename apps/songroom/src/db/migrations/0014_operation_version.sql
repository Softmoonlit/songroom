ALTER TABLE `operation` ADD COLUMN `version` integer DEFAULT 1 NOT NULL CHECK(`version` > 0);
--> statement-breakpoint
UPDATE schema_meta SET value = '15' WHERE key = 'schema_version';
