import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })
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
  status: text("status", { enum: ["active"] }).notNull(),
  credentials: text("credentials").notNull()
}, table => [
  uniqueIndex("netease_authorization_user_unique").on(table.userId),
  uniqueIndex("netease_authorization_account_unique").on(table.accountId),
  check("netease_authorization_generation_valid", sql`${table.generation} > 0`),
  check("netease_authorization_status_valid", sql`${table.status} = 'active'`),
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
  kind: text("kind", { enum: ["createPublicPlaylist"] }).notNull(),
  userId: text("user_id").notNull(),
  roomId: text("room_id").notNull(),
  accountId: text("account_id"),
  authorizationId: text("authorization_id"),
  generation: integer("generation"),
  status: text("status", { enum: ["queued", "processing", "awaitingConfirmation", "waitingAuthorization", "needsAdministrator", "succeeded", "failed", "stopped"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull()
}, table => [
  check("operation_kind_valid", sql`${table.kind} = 'createPublicPlaylist'`),
  check("operation_status_valid", sql`${table.status} IN ('queued', 'processing', 'awaitingConfirmation', 'waitingAuthorization', 'needsAdministrator', 'succeeded', 'failed', 'stopped')`),
  check("operation_recovery_scope_valid", sql`(${table.status} IN ('succeeded', 'failed', 'stopped') AND ${table.accountId} IS NULL AND ${table.authorizationId} IS NULL AND ${table.generation} IS NULL) OR (${table.status} NOT IN ('succeeded', 'failed', 'stopped') AND ${table.accountId} IS NOT NULL AND ${table.authorizationId} IS NOT NULL AND ${table.generation} IS NOT NULL AND ${table.generation} > 0)`),
  uniqueIndex("operation_pending_public_room_unique").on(table.roomId).where(sql`${table.kind} = 'createPublicPlaylist' AND ${table.status} NOT IN ('succeeded', 'failed', 'stopped')`),
  index("operation_room_created_index").on(table.roomId, table.createdAt)
]);

export const publicPlaylistCreation = sqliteTable("public_playlist_creation", {
  operationId: text("operation_id").primaryKey().references(() => operation.id),
  name: text("name").notNull(),
  step: text("step", { enum: ["ready", "sending", "confirming", "succeeded", "rejected", "unknown", "stopped"] }).notNull().default("ready"),
  playlistId: text("playlist_id")
}, table => [
  check("public_playlist_creation_step_valid", sql`${table.step} IN ('ready', 'sending', 'confirming', 'succeeded', 'rejected', 'unknown', 'stopped')`),
  check("public_playlist_creation_returned_id_valid", sql`(${table.step} IN ('confirming', 'succeeded') AND ${table.playlistId} IS NOT NULL AND length(${table.playlistId}) > 0) OR (${table.step} NOT IN ('confirming', 'succeeded') AND ${table.playlistId} IS NULL)`)
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

export const authSchema = { user, session, account, verification };
export const schema = { schemaMeta, ...authSchema, neteaseAuthorization, commandReceipt, room, roomMembership, roomInvite, retiredRoomInvite, joinApplication, operation, publicPlaylistCreation, publicPlaylistBinding };

export type SchemaMeta = typeof schemaMeta.$inferSelect;
export type NewSchemaMeta = typeof schemaMeta.$inferInsert;
