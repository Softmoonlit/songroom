CREATE TABLE `schema_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `schema_meta` (`key`, `value`) VALUES ('schema_version', '1');
