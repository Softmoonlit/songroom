PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_schema_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	CONSTRAINT "schema_version_valid" CHECK("__new_schema_meta"."key" = 'schema_version' AND CAST("__new_schema_meta"."value" AS INTEGER) > 0 AND CAST(CAST("__new_schema_meta"."value" AS INTEGER) AS TEXT) = "__new_schema_meta"."value")
);
--> statement-breakpoint
INSERT INTO `__new_schema_meta`("key", "value") SELECT "key", "value" FROM `schema_meta`;--> statement-breakpoint
DROP TABLE `schema_meta`;--> statement-breakpoint
ALTER TABLE `__new_schema_meta` RENAME TO `schema_meta`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
--> statement-breakpoint
UPDATE `schema_meta` SET `value` = '2' WHERE `key` = 'schema_version';
