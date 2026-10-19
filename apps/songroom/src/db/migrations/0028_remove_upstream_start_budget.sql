CREATE TABLE `__new_upstream_account` (
  `account_id` text PRIMARY KEY NOT NULL,
  `running_operation_id` text,
  `paused` integer DEFAULT false NOT NULL,
  `pause_reason` text
);--> statement-breakpoint
INSERT INTO `__new_upstream_account` (`account_id`, `running_operation_id`, `paused`, `pause_reason`)
SELECT `account_id`, `running_operation_id`, `paused`, `pause_reason` FROM `upstream_account`;--> statement-breakpoint
DROP TABLE `upstream_account`;--> statement-breakpoint
ALTER TABLE `__new_upstream_account` RENAME TO `upstream_account`;--> statement-breakpoint
CREATE TABLE `__new_personal_song_mutation` (
  `operation_id` text PRIMARY KEY NOT NULL REFERENCES operation(id) ON DELETE CASCADE,
  `member_id` text NOT NULL,
  `playlist_id` text NOT NULL CHECK(length(playlist_id) > 0),
  `binding_generation` integer NOT NULL CHECK(binding_generation > 0),
  `song_id` text NOT NULL CHECK(length(song_id) > 0),
  `name` text NOT NULL CHECK(length(name) > 0),
  `artists` text NOT NULL,
  `album` text NOT NULL,
  `step` text NOT NULL DEFAULT 'ready' CHECK(step IN ('ready', 'prepared', 'sending', 'confirming', 'succeeded', 'rejected', 'unknown', 'stopped')),
  `check_round` integer NOT NULL DEFAULT 0 CHECK(check_round BETWEEN 0 AND 3),
  `next_check_at` integer
);--> statement-breakpoint
INSERT INTO `__new_personal_song_mutation` (`operation_id`, `member_id`, `playlist_id`, `binding_generation`, `song_id`, `name`, `artists`, `album`, `step`, `check_round`, `next_check_at`)
SELECT `operation_id`, `member_id`, `playlist_id`, `binding_generation`, `song_id`, `name`, `artists`, `album`,
  CASE WHEN `step` = 'verified' THEN 'ready' ELSE `step` END, `check_round`, `next_check_at`
FROM `personal_song_mutation`;--> statement-breakpoint
DROP TABLE `personal_song_mutation`;--> statement-breakpoint
ALTER TABLE `__new_personal_song_mutation` RENAME TO `personal_song_mutation`;--> statement-breakpoint
CREATE INDEX `personal_song_mutation_target_index` ON `personal_song_mutation` (`playlist_id`);--> statement-breakpoint
CREATE INDEX `personal_song_mutation_member_index` ON `personal_song_mutation` (`member_id`);--> statement-breakpoint
CREATE TABLE `__new_public_play_next` (
  `operation_id` text PRIMARY KEY NOT NULL REFERENCES operation(id) ON DELETE CASCADE,
  `song_id` text NOT NULL,
  `anchor_song_id` text NOT NULL,
  `playlist_id` text NOT NULL,
  `binding_generation` integer NOT NULL CHECK(binding_generation > 0),
  `member_id` text,
  `original_song_ids` text,
  `target_song_ids` text,
  `step` text NOT NULL DEFAULT 'ready' CHECK(step IN ('ready', 'playbackVerified', 'verified', 'sending', 'confirming', 'unknown', 'succeeded', 'rejected', 'stopped')),
  `check_round` integer NOT NULL DEFAULT 0 CHECK(check_round BETWEEN 0 AND 3),
  `next_check_at` integer,
  CHECK(length(song_id) > 0 AND length(anchor_song_id) > 0 AND length(playlist_id) > 0)
);--> statement-breakpoint
INSERT INTO `__new_public_play_next` (`operation_id`, `song_id`, `anchor_song_id`, `playlist_id`, `binding_generation`, `member_id`, `original_song_ids`, `target_song_ids`, `step`, `check_round`, `next_check_at`)
SELECT `operation_id`, `song_id`, `anchor_song_id`, `playlist_id`, `binding_generation`, `member_id`, `original_song_ids`, `target_song_ids`,
  CASE WHEN `step` = 'identityVerified' THEN 'ready' ELSE `step` END, `check_round`, `next_check_at`
FROM `public_play_next`;--> statement-breakpoint
DROP TABLE `public_play_next`;--> statement-breakpoint
ALTER TABLE `__new_public_play_next` RENAME TO `public_play_next`;--> statement-breakpoint
CREATE INDEX `public_play_next_target_index` ON `public_play_next` (`playlist_id`);--> statement-breakpoint
UPDATE schema_meta SET value = '29' WHERE key = 'schema_version';
