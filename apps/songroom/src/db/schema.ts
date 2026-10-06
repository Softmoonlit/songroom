import { sql } from "drizzle-orm";
import { check, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

export const authSchema = { user, session, account, verification };
export const schema = { schemaMeta, ...authSchema, neteaseAuthorization, commandReceipt, room, roomMembership, roomInvite };

export type SchemaMeta = typeof schemaMeta.$inferSelect;
export type NewSchemaMeta = typeof schemaMeta.$inferInsert;
