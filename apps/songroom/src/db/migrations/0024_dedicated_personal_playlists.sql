-- Issue 01 / ADR-0002: one-time local retirement of external owner sources.
-- No upstream request, cloud deletion, subscription change or song copying occurs.
-- Only snapshots made orphaned by this retirement are removed. Shared active,
-- retired-public and dedicated-personal references retain their snapshot/tracks.
-- Command receipts and all creation/operation recovery evidence stay untouched.
CREATE TEMP TABLE songroom_retired_external_snapshot_target AS
SELECT account_id, playlist_id FROM playlist_snapshot
WHERE EXISTS (
  SELECT 1 FROM personal_playlist_binding AS external
  WHERE external.account_id = playlist_snapshot.account_id
    AND external.playlist_id = playlist_snapshot.playlist_id
    AND external.type IN ('ownerCreated', 'ownerSubscribed')
)
AND NOT EXISTS (
  SELECT 1 FROM personal_playlist_binding AS dedicated
  WHERE dedicated.account_id = playlist_snapshot.account_id
    AND dedicated.playlist_id = playlist_snapshot.playlist_id
    AND dedicated.type = 'roommateDedicated'
)
AND NOT EXISTS (
  SELECT 1 FROM public_playlist_binding AS public
  WHERE public.account_id = playlist_snapshot.account_id
    AND public.playlist_id = playlist_snapshot.playlist_id
)
AND NOT EXISTS (
  SELECT 1 FROM retired_public_playlist_binding AS retired
  WHERE retired.account_id = playlist_snapshot.account_id
    AND retired.playlist_id = playlist_snapshot.playlist_id
);--> statement-breakpoint
-- Explicit track deletion also works when the migration runner pauses FK
-- enforcement to safely rebuild referenced tables in older migrations.
DELETE FROM playlist_track WHERE (account_id, playlist_id) IN (
  SELECT account_id, playlist_id FROM songroom_retired_external_snapshot_target
);--> statement-breakpoint
DELETE FROM playlist_snapshot WHERE (account_id, playlist_id) IN (
  SELECT account_id, playlist_id FROM songroom_retired_external_snapshot_target
);--> statement-breakpoint
DROP TABLE songroom_retired_external_snapshot_target;--> statement-breakpoint
-- Invalidate pre-upgrade room pages once per affected room before removing
-- the associations; this also makes stale versioned commands fail normally.
UPDATE room SET version = version + 1
WHERE EXISTS (
  SELECT 1 FROM personal_playlist_binding AS external
  WHERE external.room_id = room.id AND external.type IN ('ownerCreated', 'ownerSubscribed')
);--> statement-breakpoint
DELETE FROM personal_playlist_binding WHERE type IN ('ownerCreated', 'ownerSubscribed');--> statement-breakpoint
-- Verify the old dedicated identity before dropping its obsolete discriminator
-- columns. A read-only source must abort, never become a writeable resource.
CREATE TEMP TABLE songroom_legacy_personal_binding_check (valid integer NOT NULL CHECK(valid = 1));--> statement-breakpoint
INSERT INTO songroom_legacy_personal_binding_check (valid)
SELECT type = 'roommateDedicated' AND writeable = 1 FROM personal_playlist_binding;--> statement-breakpoint
DROP TABLE songroom_legacy_personal_binding_check;--> statement-breakpoint
-- The creation ID is durable provenance, not a foreign key into expiring
-- operation receipts. Missing evidence aborts the whole migration transaction.
CREATE UNIQUE INDEX room_membership_room_id_unique ON room_membership (room_id, id);--> statement-breakpoint
CREATE TABLE `__new_personal_playlist_binding` (
  `id` text PRIMARY KEY NOT NULL,
  `room_id` text NOT NULL REFERENCES room(id) ON DELETE CASCADE,
  `member_id` text NOT NULL,
  `account_id` text NOT NULL,
  `playlist_id` text NOT NULL,
  `name` text NOT NULL,
  `generation` integer NOT NULL DEFAULT 1 CHECK(generation > 0),
  `creation_operation_id` text NOT NULL CHECK(length(creation_operation_id) > 0),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (room_id, member_id) REFERENCES room_membership(room_id, id) ON DELETE CASCADE,
  CHECK(length(playlist_id) > 0 AND length(account_id) > 0 AND length(name) > 0)
);--> statement-breakpoint
-- The insert guard also checks converted legacy bindings. Conflicts abort
-- atomically instead of assigning a shared cloud resource to a new owner.
CREATE TRIGGER personal_playlist_binding_target_insert
BEFORE INSERT ON __new_personal_playlist_binding
WHEN EXISTS (SELECT 1 FROM public_playlist_binding WHERE account_id = NEW.account_id AND playlist_id = NEW.playlist_id)
BEGIN
  SELECT RAISE(ABORT, 'PLAYLIST_TARGET_CONFLICT');
END;--> statement-breakpoint
INSERT INTO `__new_personal_playlist_binding`
  (id, room_id, member_id, account_id, playlist_id, name, generation, creation_operation_id, created_at, updated_at)
SELECT id, room_id, member_id, account_id, playlist_id, name, generation, creation_operation_id, created_at, updated_at
FROM personal_playlist_binding;--> statement-breakpoint
DROP TABLE personal_playlist_binding;--> statement-breakpoint
ALTER TABLE `__new_personal_playlist_binding` RENAME TO personal_playlist_binding;--> statement-breakpoint
CREATE UNIQUE INDEX personal_playlist_binding_room_member_unique ON personal_playlist_binding (room_id, member_id);--> statement-breakpoint
CREATE UNIQUE INDEX personal_playlist_binding_target_unique ON personal_playlist_binding (account_id, playlist_id);--> statement-breakpoint
CREATE UNIQUE INDEX personal_playlist_binding_creation_unique ON personal_playlist_binding (creation_operation_id);--> statement-breakpoint
-- Cross-table uniqueness must be enforced in both write directions.
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
UPDATE schema_meta SET value = '25' WHERE key = 'schema_version';
