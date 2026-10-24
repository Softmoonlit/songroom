DROP TRIGGER IF EXISTS personal_playlist_binding_target_insert;--> statement-breakpoint
DROP TRIGGER IF EXISTS personal_playlist_binding_target_update;--> statement-breakpoint
DROP TRIGGER IF EXISTS public_playlist_binding_personal_target_insert;--> statement-breakpoint
DROP TRIGGER IF EXISTS public_playlist_binding_personal_target_update;--> statement-breakpoint
CREATE TABLE `__new_personal_playlist_binding` (
  `id` text PRIMARY KEY NOT NULL,
  `room_id` text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  `member_id` text NOT NULL,
  `account_id` text NOT NULL,
  `playlist_id` text NOT NULL,
  `name` text NOT NULL,
  `generation` integer NOT NULL DEFAULT 1 CHECK(generation > 0),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (room_id, member_id) REFERENCES room_membership(room_id, id) ON DELETE CASCADE,
  CHECK(length(playlist_id) > 0 AND length(account_id) > 0 AND length(name) > 0)
);--> statement-breakpoint
INSERT INTO `__new_personal_playlist_binding`
  (id, room_id, member_id, account_id, playlist_id, name, generation, created_at, updated_at)
SELECT id, room_id, member_id, account_id, playlist_id, name, generation, created_at, updated_at
FROM personal_playlist_binding;--> statement-breakpoint
DROP TABLE personal_playlist_binding;--> statement-breakpoint
ALTER TABLE `__new_personal_playlist_binding` RENAME TO personal_playlist_binding;--> statement-breakpoint
CREATE UNIQUE INDEX personal_playlist_binding_room_member_unique ON personal_playlist_binding (room_id, member_id);--> statement-breakpoint
CREATE INDEX personal_playlist_binding_target_index ON personal_playlist_binding (account_id, playlist_id);--> statement-breakpoint
CREATE TRIGGER personal_playlist_binding_target_insert
BEFORE INSERT ON personal_playlist_binding
WHEN EXISTS (SELECT 1 FROM public_playlist_binding WHERE account_id = NEW.account_id AND playlist_id = NEW.playlist_id)
BEGIN
  SELECT RAISE(ABORT, 'PLAYLIST_TARGET_CONFLICT');
END;--> statement-breakpoint
CREATE TRIGGER personal_playlist_binding_target_update
BEFORE UPDATE OF account_id, playlist_id ON personal_playlist_binding
WHEN EXISTS (SELECT 1 FROM public_playlist_binding WHERE account_id = NEW.account_id AND playlist_id = NEW.playlist_id)
BEGIN
  SELECT RAISE(ABORT, 'PLAYLIST_TARGET_CONFLICT');
END;--> statement-breakpoint
CREATE TRIGGER public_playlist_binding_personal_target_insert
BEFORE INSERT ON public_playlist_binding
WHEN EXISTS (SELECT 1 FROM personal_playlist_binding WHERE account_id = NEW.account_id AND playlist_id = NEW.playlist_id)
BEGIN
  SELECT RAISE(ABORT, 'PLAYLIST_TARGET_CONFLICT');
END;--> statement-breakpoint
CREATE TRIGGER public_playlist_binding_personal_target_update
BEFORE UPDATE OF account_id, playlist_id ON public_playlist_binding
WHEN EXISTS (SELECT 1 FROM personal_playlist_binding WHERE account_id = NEW.account_id AND playlist_id = NEW.playlist_id)
BEGIN
  SELECT RAISE(ABORT, 'PLAYLIST_TARGET_CONFLICT');
END;--> statement-breakpoint
DROP TABLE IF EXISTS personal_playlist_creation;--> statement-breakpoint
DROP TABLE IF EXISTS personal_song_addition;--> statement-breakpoint
DROP TABLE IF EXISTS personal_song_mutation;--> statement-breakpoint
UPDATE schema_meta SET value = '30' WHERE key = 'schema_version';
