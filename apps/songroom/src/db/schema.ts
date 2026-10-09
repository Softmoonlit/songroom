import { adapterErrorCodeSchema } from "../netease/protocol.js";
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const schemaMeta = sqliteTable("schema_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
}, (table) => [
  check("schema_version_valid", sql`${table.key} = 'schema_version' AND CAST(${table.value} AS INTEGER) > 0 AND CAST(CAST(${table.value} AS INTEGER) AS TEXT) = ${table.value}`)
]);

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
  image: text("image"),
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
}, (table) => [uniqueIndex("user_email_unique").on(table.email)]);

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by")
}, (table) => [uniqueIndex("session_token_unique").on(table.token)]);

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
}, (table) => [uniqueIndex("account_provider_account_unique").on(table.providerId, table.accountId)]);

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull()
});

export const neteaseAuthorization = sqliteTable("netease_authorization", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  nickname: text("nickname").notNull(),
  generation: integer("generation").notNull(),
  status: text("status", { enum: ["active", "waitingAuthorization"] }).notNull(),
  credentials: text("credentials")
}, table => [
  uniqueIndex("netease_authorization_user_unique").on(table.userId),
  uniqueIndex("netease_authorization_account_unique").on(table.accountId),
  check("netease_authorization_generation_valid", sql`${table.generation} > 0`),
  check("netease_authorization_status_valid", sql`${table.status} IN ('active', 'waitingAuthorization')`),
  check("netease_authorization_account_valid", sql`length(${table.accountId}) > 0`)
]);

export const commandReceipt = sqliteTable("command_receipt", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  key: text("key").notNull(),
  digest: text("digest").notNull(),
  resourceId: text("resource_id").notNull(),
  expiresAt: integer("expires_at").notNull()
}, table => [primaryKey({ columns: [table.userId, table.key] })]);

export const room = sqliteTable("room", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id").notNull().references(() => user.id),
  version: integer("version").notNull().default(1)
}, table => [check("room_version_valid", sql`${table.version} > 0`)]);

export const roomMembership = sqliteTable("room_membership", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => room.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id),
  nickname: text("nickname").notNull()
}, table => [
  uniqueIndex("room_membership_user_unique").on(table.roomId, table.userId),
  uniqueIndex("room_membership_nickname_unique").on(table.roomId, table.nickname),
  check("room_membership_nickname_valid", sql`length(${table.nickname}) BETWEEN 1 AND 12`)
]);

export const roomInvite = sqliteTable("room_invite", {
  roomId: text("room_id").primaryKey().references(() => room.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  generation: integer("generation").notNull().default(1)
}, table => [
  uniqueIndex("room_invite_code_unique").on(table.code),
  check("room_invite_code_valid", sql`length(${table.code}) = 10 AND ${table.code} NOT GLOB '*[^A-Za-z0-9_-]*'`),
  check("room_invite_generation_valid", sql`${table.generation} > 0`)
]);

// 只保存已退役邀请码的摘要；房间删除后同时移除失效识别记录。
export const retiredRoomInvite = sqliteTable("retired_room_invite", {
  digest: text("digest").primaryKey(),
  roomId: text("room_id").notNull().references(() => room.id, { onDelete: "cascade" })
}, table => [
  index("retired_room_invite_room_index").on(table.roomId),
  check("retired_room_invite_digest_valid", sql`length(${table.digest}) = 64 AND ${table.digest} NOT GLOB '*[^0-9a-f]*'`)
]);

export const joinApplication = sqliteTable("join_application", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => room.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  nickname: text("nickname").notNull(),
  inviteGeneration: integer("invite_generation").notNull(),
  status: text("status", { enum: ["pending", "withdrawn", "cancelled", "approved", "rejected", "nickname_conflict"] }).notNull().default("pending")
}, table => [
  uniqueIndex("join_application_pending_user_room_unique").on(table.roomId, table.userId).where(sql`${table.status} = 'pending'`),
  index("join_application_user_status_index").on(table.userId, table.status),
  index("join_application_room_status_index").on(table.roomId, table.status),
  check("join_application_nickname_valid", sql`length(${table.nickname}) BETWEEN 1 AND 12`),
  check("join_application_generation_valid", sql`${table.inviteGeneration} > 0`),
  check("join_application_status_valid", sql`${table.status} IN ('pending', 'withdrawn', 'cancelled', 'approved', 'rejected', 'nickname_conflict')`)
]);

// 封闭业务操作信封；原始归属不用级联外键，可能已发的创建证据不能随实体删除。
export const operation = sqliteTable("operation", {
  id: text("id").primaryKey(),
  kind: text("kind", { enum: ["createPublicPlaylist", "requestPublicSong", "playNext"] }).notNull(),
  userId: text("user_id").notNull(),
  roomId: text("room_id").notNull(),
  accountId: text("account_id"),
  authorizationId: text("authorization_id"),
  generation: integer("generation"),
  status: text("status", { enum: ["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded", "failed", "stopped"] }).notNull(),
  errorCode: text("error_code", { enum: ["ACCOUNT_PAUSED", "PLAYBACK_CONFLICT", "PLAYLIST_CONFLICT", "PLAY_NEXT_NOOP", ...adapterErrorCodeSchema.options] }),
  lastGranted: integer("last_granted").notNull().default(0),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
}, table => [
  check("operation_version_valid", sql`${table.version} > 0`),
  check("operation_kind_valid", sql`${table.kind} IN ('createPublicPlaylist', 'requestPublicSong', 'playNext')`),
  check("operation_status_valid", sql`${table.status} IN ('queued', 'processing', 'awaitingConfirmation', 'waitingAuthorization', 'needsAdministrator', 'succeeded', 'failed', 'stopped')`),
  check("operation_recovery_scope_valid", sql`(${table.status} IN ('succeeded', 'failed', 'stopped') AND ${table.accountId} IS NULL AND ${table.authorizationId} IS NULL AND ${table.generation} IS NULL) OR (${table.status} NOT IN ('succeeded', 'failed', 'stopped') AND ${table.accountId} IS NOT NULL AND ${table.authorizationId} IS NOT NULL AND ${table.generation} IS NOT NULL AND ${table.generation} > 0)`),
  uniqueIndex("operation_pending_public_room_unique").on(table.roomId).where(sql`${table.kind} = 'createPublicPlaylist' AND ${table.status} NOT IN ('succeeded', 'failed', 'stopped')`),
  uniqueIndex("operation_pending_user_room_unique").on(table.roomId, table.userId).where(sql`${table.status} NOT IN ('succeeded', 'failed', 'stopped')`),
  index("operation_room_created_index").on(table.roomId, table.createdAt)
]);

export const publicPlaylistCreation = sqliteTable("public_playlist_creation", {
  operationId: text("operation_id").primaryKey().references(() => operation.id),
  name: text("name").notNull(),
  step: text("step", { enum: ["ready", "verified", "sending", "confirming", "succeeded", "rejected", "unknown", "stopped"] }).notNull().default("ready"),
  playlistId: text("playlist_id"),
  beforePlaylists: text("before_playlists"),
  afterPlaylists: text("after_playlists"),
  sentAt: integer("sent_at"),
  recovered: integer("recovered", { mode: "boolean" }).notNull().default(false)
}, table => [
  check("public_playlist_creation_step_valid", sql`${table.step} IN ('ready', 'verified', 'sending', 'confirming', 'succeeded', 'rejected', 'unknown', 'stopped')`),
  check("public_playlist_creation_returned_id_valid", sql`(${table.step} IN ('confirming', 'succeeded') AND ${table.playlistId} IS NOT NULL AND length(${table.playlistId}) > 0) OR (${table.step} NOT IN ('confirming', 'succeeded') AND ${table.playlistId} IS NULL)`),
  check("public_playlist_creation_sent_at_valid", sql`${table.sentAt} IS NULL OR ${table.sentAt} > 0`),
  check("public_playlist_creation_recovered_valid", sql`${table.recovered} IN (0, 1)`)
]);

export const publicPlaylistBinding = sqliteTable("public_playlist_binding", {
  roomId: text("room_id").primaryKey().references(() => room.id),
  accountId: text("account_id").notNull(),
  playlistId: text("playlist_id").notNull(),
  name: text("name").notNull(),
  // 独立的专用创建来源证据；不依赖可到期移除的操作信封。
  creationOperationId: text("creation_operation_id").notNull(),
  generation: integer("generation").notNull().default(1)
}, table => [
  uniqueIndex("public_playlist_binding_target_unique").on(table.accountId, table.playlistId),
  uniqueIndex("public_playlist_binding_creation_unique").on(table.creationOperationId),
  check("public_playlist_binding_generation_valid", sql`${table.generation} > 0`),
  check("public_playlist_binding_id_valid", sql`length(${table.playlistId}) > 0`)
]);

export const retiredPublicPlaylistBinding = sqliteTable("retired_public_playlist_binding", {
  id: text("id").primaryKey(),
  roomId: text("room_id").notNull().references(() => room.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  playlistId: text("playlist_id").notNull(),
  name: text("name").notNull(),
  generation: integer("generation").notNull(),
  invalidatedAt: integer("invalidated_at").notNull()
}, table => [
  index("retired_public_playlist_binding_room_generation_index").on(table.roomId, table.generation),
  index("retired_public_playlist_binding_account_playlist_index").on(table.accountId, table.playlistId),
  check("retired_public_playlist_binding_generation_valid", sql`${table.generation} > 0`),
  check("retired_public_playlist_binding_id_valid", sql`length(${table.playlistId}) > 0`)
]);

// 真实账号请求启动预算与风控暂停持久化；执行权在发送前短事务中认领。
export const upstreamAccount = sqliteTable("upstream_account", {
  accountId: text("account_id").primaryKey(),
  nextStartAt: integer("next_start_at").notNull().default(0),
  runningOperationId: text("running_operation_id"),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  pauseReason: text("pause_reason")
}, table => [check("upstream_account_next_start_valid", sql`${table.nextStartAt} >= 0`)]);

// 规范化云端歌单权威快照元数据；跨房间绑定共享同一记录。
export const playlistSnapshot = sqliteTable("playlist_snapshot", {
  accountId: text("account_id").notNull(),
  playlistId: text("playlist_id").notNull(),
  snapshotVersion: integer("snapshot_version").notNull().default(0),
  lastReadStartedAt: integer("last_read_started_at").notNull().default(0),
  syncedAt: integer("synced_at"),
  lastErrorCode: text("last_error_code"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
}, table => [
  primaryKey({ columns: [table.accountId, table.playlistId] }),
  check("playlist_snapshot_account_id_valid", sql`length(${table.accountId}) > 0`),
  check("playlist_snapshot_playlist_id_valid", sql`length(${table.playlistId}) > 0`),
  check("playlist_snapshot_version_valid", sql`${table.snapshotVersion} >= 0`),
  check("playlist_snapshot_synced_at_valid", sql`${table.syncedAt} IS NULL OR ${table.syncedAt} > 0`)
]);

// 快照内部按网易云实际顺序保存的歌曲；不推断中间事件，按集合在事务中整体替换。
export const playlistTrack = sqliteTable("playlist_track", {
  accountId: text("account_id").notNull(),
  playlistId: text("playlist_id").notNull(),
  position: integer("position").notNull(),
  songId: text("song_id").notNull(),
  name: text("name").notNull(),
  artists: text("artists").notNull(),
  album: text("album").notNull()
}, table => [
  primaryKey({ columns: [table.accountId, table.playlistId, table.position] }),
  foreignKey({
    columns: [table.accountId, table.playlistId],
    foreignColumns: [playlistSnapshot.accountId, playlistSnapshot.playlistId]
  }).onDelete("cascade"),
  index("playlist_track_target_song_index").on(table.accountId, table.playlistId, table.songId),
  check("playlist_track_position_valid", sql`${table.position} >= 0`),
  check("playlist_track_song_id_valid", sql`length(${table.songId}) > 0`),
  check("playlist_track_name_valid", sql`length(${table.name}) > 0`)
]);

export const publicSongRequest = sqliteTable("public_song_request", {
  operationId: text("operation_id").primaryKey().references(() => operation.id, { onDelete: "cascade" }),
  songId: text("song_id").notNull(),
  name: text("name").notNull(),
  artists: text("artists").notNull(),
  album: text("album").notNull(),
  step: text("step", { enum: ["ready", "verified", "sending", "confirming", "tagging", "succeeded", "rejected", "unknown", "stopped"] }).notNull().default("ready"),
  songConfirmed: integer("song_confirmed", { mode: "boolean" }).notNull().default(false),
  tagConfirmed: integer("tag_confirmed", { mode: "boolean" }).notNull().default(false),
  playlistId: text("playlist_id").notNull(),
  bindingGeneration: integer("binding_generation").notNull(),
  checkRound: integer("check_round").notNull().default(0),
  nextCheckAt: integer("next_check_at")
}, table => [
  index("public_song_request_target_index").on(table.playlistId),
  check("public_song_request_step_valid", sql`${table.step} IN ('ready', 'verified', 'sending', 'confirming', 'tagging', 'succeeded', 'rejected', 'unknown', 'stopped')`),
  check("public_song_request_song_id_valid", sql`length(${table.songId}) > 0`),
  check("public_song_request_name_valid", sql`length(${table.name}) > 0`),
  check("public_song_request_playlist_id_valid", sql`length(${table.playlistId}) > 0`),
  check("public_song_request_binding_generation_valid", sql`${table.bindingGeneration} > 0`),
  check("public_song_request_check_round_valid", sql`${table.checkRound} >= 0 AND ${table.checkRound} <= 3`)
]);

export const publicPlayNext = sqliteTable("public_play_next", {
  operationId: text("operation_id").primaryKey().references(() => operation.id, { onDelete: "cascade" }),
  songId: text("song_id").notNull(),
  anchorSongId: text("anchor_song_id").notNull(),
  playlistId: text("playlist_id").notNull(),
  bindingGeneration: integer("binding_generation").notNull(),
  memberId: text("member_id"),
  originalSongIds: text("original_song_ids"),
  targetSongIds: text("target_song_ids"),
  step: text("step", { enum: ["ready", "identityVerified", "playbackVerified", "verified", "sending", "confirming", "unknown", "succeeded", "rejected", "stopped"] }).notNull().default("ready"),
  checkRound: integer("check_round").notNull().default(0),
  nextCheckAt: integer("next_check_at")
}, table => [
  index("public_play_next_target_index").on(table.playlistId),
  check("public_play_next_step_valid", sql`${table.step} IN ('ready', 'identityVerified', 'playbackVerified', 'verified', 'sending', 'confirming', 'unknown', 'succeeded', 'rejected', 'stopped')`),
  check("public_play_next_generation_valid", sql`${table.bindingGeneration} > 0`),
  check("public_play_next_song_valid", sql`length(${table.songId}) > 0 AND length(${table.anchorSongId}) > 0 AND length(${table.playlistId}) > 0`),
  check("public_play_next_round_valid", sql`${table.checkRound} BETWEEN 0 AND 3`)
]);

export const requesterTag = sqliteTable("requester_tag", {
  roomId: text("room_id").notNull().references(() => room.id, { onDelete: "cascade" }),
  bindingGeneration: integer("binding_generation").notNull(),
  songId: text("song_id").notNull(),
  memberId: text("member_id").notNull().references(() => roomMembership.id, { onDelete: "cascade" }),
  createdAt: integer("created_at").notNull()
}, table => [
  primaryKey({ columns: [table.roomId, table.bindingGeneration, table.songId, table.memberId] }),
  index("requester_tag_room_song_index").on(table.roomId, table.bindingGeneration, table.songId),
  check("requester_tag_generation_valid", sql`${table.bindingGeneration} > 0`),
  check("requester_tag_song_id_valid", sql`length(${table.songId}) > 0`)
]);

export const publicPlaylistCleanup = sqliteTable("public_playlist_cleanup", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  playlistId: text("playlist_id").notNull(),
  creationOperationId: text("creation_operation_id"),
  hasSent: integer("has_sent", { mode: "boolean" }).notNull().default(false),
  retryAuthorized: integer("retry_authorized", { mode: "boolean" }).notNull().default(false),
  checkFact: text("check_fact"),
  checkRound: integer("check_round").notNull().default(0),
  status: text("status", { enum: ["ready", "sending", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded"] }).notNull(),
  lastErrorCode: text("last_error_code"),
  version: integer("version").notNull().default(1),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
}, table => [
  uniqueIndex("public_playlist_cleanup_target_unique").on(table.accountId, table.playlistId),
  index("public_playlist_cleanup_user_status_index").on(table.userId, table.status),
  check("public_playlist_cleanup_account_id_valid", sql`length(${table.accountId}) > 0`),
  check("public_playlist_cleanup_playlist_id_valid", sql`length(${table.playlistId}) > 0`),
  check("public_playlist_cleanup_version_valid", sql`${table.version} > 0`),
  check("public_playlist_cleanup_status_valid", sql`${table.status} IN ('ready', 'sending', 'awaitingConfirmation', 'waitingAuthorization', 'needsAdministrator', 'succeeded')`),
  check("public_playlist_cleanup_check_round_valid", sql`${table.checkRound} >= 0`),
  check("public_playlist_cleanup_retry_authorized_valid", sql`${table.retryAuthorized} IN (0, 1)`)
]);

export const adminAuditLog = sqliteTable("admin_audit_log", {
  id: text("id").primaryKey(),
  adminUserId: text("admin_user_id").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  action: text("action").notNull(),
  reason: text("reason").notNull(),
  previousStatus: text("previous_status"),
  nextStatus: text("next_status"),
  result: text("result").notNull(),
  details: text("details"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull()
}, (table) => [
  index("admin_audit_log_admin_user_index").on(table.adminUserId),
  index("admin_audit_log_target_index").on(table.targetType, table.targetId),
  check("admin_audit_log_reason_len", sql`length(${table.reason}) >= 1 AND length(${table.reason}) <= 500`)
]);

export const authSchema = { user, session, account, verification };
export const schema = { schemaMeta, ...authSchema, neteaseAuthorization, commandReceipt, room, roomMembership, roomInvite, retiredRoomInvite, joinApplication, operation, publicPlaylistCreation, publicPlaylistBinding, retiredPublicPlaylistBinding, upstreamAccount, playlistSnapshot, playlistTrack, publicSongRequest, publicPlayNext, requesterTag, publicPlaylistCleanup, adminAuditLog };

export type SchemaMeta = typeof schemaMeta.$inferSelect;
export type NewSchemaMeta = typeof schemaMeta.$inferInsert;
