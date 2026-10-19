import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { v7 } from "uuid";
import { canonicalDigest } from "../commands/commands.js";
import { readCommandResource } from "../commands/receipts.js";
import {
  CURRENT_SCHEMA_VERSION,
  checkDatabase,
  initializeDatabase,
  migrateDatabase,
  openDatabase
} from "./database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDatabasePath(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "songroom-db-test-"));
  temporaryDirectories.push(directory);
  return path.join(directory, "songroom.sqlite");
}

function createOldDatabase(filePath: string, versions = 1): void {
  const fixtureFolder = path.join(path.dirname(filePath), "old-migrations");
  const migrationFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta/_journal.json"), "utf8")) as {
    version: string;
    dialect: string;
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.slice(0, versions);
  fs.mkdirSync(path.join(fixtureFolder, "meta"), { recursive: true });
  fs.writeFileSync(path.join(fixtureFolder, "meta/_journal.json"), JSON.stringify(journal));
  for (const entry of journal.entries) {
    fs.copyFileSync(path.join(migrationFolder, `${entry.tag}.sql`), path.join(fixtureFolder, `${entry.tag}.sql`));
  }
  const oldClient = new Database(filePath);
  fs.chmodSync(filePath, 0o600);
  oldClient.pragma("foreign_keys = ON");
  oldClient.pragma("busy_timeout = 5000");
  oldClient.pragma("journal_mode = WAL");
  migrate(drizzle(oldClient), { migrationsFolder: fixtureFolder });
  oldClient.close();
}

describe("database lifecycle", () => {
  it("initializes a real SQLite database from the explicit migration", () => {
    const filePath = temporaryDatabasePath();

    initializeDatabase(filePath);

    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    const database = openDatabase(filePath);
    expect(database.$client).toBeDefined();
    expect(database.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all()).toEqual([
      "__drizzle_migrations",
      "account",
      "admin_audit_log",
      "command_receipt",
      "join_application",
      "netease_authorization",
      "operation",
      "personal_playlist_binding",
      "personal_playlist_creation",
      "personal_song_mutation",
      "playlist_snapshot",
      "playlist_track",
      "public_play_next",
      "public_playlist_binding",
      "public_playlist_cleanup",
      "public_playlist_creation",
      "public_playlist_replacement",
      "public_song_request",
      "requester_tag",
      "retired_public_playlist_binding",
      "retired_room_invite",
      "room",
      "room_invite",
      "room_membership",
      "schema_meta",
      "session",
      "upstream_account",
      "user",
      "verification"
    ]);
    expect(database.$client.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get()).toBe(String(CURRENT_SCHEMA_VERSION));
    database.$client.close();
  });

  it("显式房间迁移保留已有扫码防重标识，旧命令表清除后仍不会重放", () => {
    const filePath = temporaryDatabasePath();
    createOldDatabase(filePath, 4);
    const now = Date.now();
    const key = v7({ msecs: now });
    const resourceId = v7();
    const digest = canonicalDigest({ intent: "start", sessionId: "previous-session" });
    const old = new Database(filePath, { fileMustExist: true });
    old.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run("previous-user", "迁移测试", "migration@example.com", now, now);
    old.prepare("INSERT INTO qr_command_receipt (user_id, key, kind, digest, session_id, flow_id, expires_at) VALUES (?, ?, 'start', ?, ?, ?, ?)").run("previous-user", key, digest, "previous-session", resourceId, now + 86_400_000);
    old.close();
    migrateDatabase(filePath);
    const current = openDatabase(filePath);
    try {
      expect(readCommandResource(current, { accountId: "previous-user", key, digest }, now)).toBe(resourceId);
      expect(() => readCommandResource(current, { accountId: "previous-user", key, digest: canonicalDigest({ intent: "createRoom" }) }, now)).toThrowError("IDEMPOTENCY_CONFLICT");
      expect(current.$client.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'qr_command_receipt'").get()).toBeUndefined();
    } finally { current.$client.close(); }
  });

  it.each([22, 23, 24])("从版本 %s 升级退役外部来源与孤立快照，保留公共资源和旧 bind/unbind 防重事实", versions => {
    const filePath = temporaryDatabasePath();
    createOldDatabase(filePath, versions);
    const now = Date.now();
    const old = new Database(filePath);
    old.pragma("foreign_keys = ON");
    old.exec(`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', '房主', 'owner@example.com', 0, 1, 1);
      INSERT INTO room (id, name, owner_user_id) VALUES ('room-a', '宿舍', 'owner'), ('room-b', '另一个宿舍', 'owner'), ('untouched', '无旧关联', 'owner');
      INSERT INTO room_membership (id, room_id, user_id, nickname) VALUES ('member-a', 'room-a', 'owner', '房主'), ('member-b', 'room-b', 'owner', '房主');
      INSERT INTO personal_playlist_binding (id, room_id, member_id, account_id, playlist_id, name, type, writeable, created_at, updated_at) VALUES
        ('external-a', 'room-a', 'member-a', 'cloud', 'external', '已有', 'ownerCreated', 1, 1, 1),
        ('external-b', 'room-b', 'member-b', 'cloud', 'public', '收藏', 'ownerSubscribed', 0, 1, 1);
      INSERT INTO public_playlist_binding (room_id, account_id, playlist_id, name, creation_operation_id) VALUES ('room-a', 'cloud', 'public', '公共', 'public-creation');
      INSERT INTO playlist_snapshot (account_id, playlist_id, created_at, updated_at) VALUES ('cloud', 'external', 1, 1), ('cloud', 'public', 1, 1), ('other-cloud', 'external', 1, 1);
      INSERT INTO playlist_track (account_id, playlist_id, position, song_id, name, artists, album) VALUES
        ('cloud', 'external', 0, 'song', '歌曲', '[]', ''), ('cloud', 'public', 0, 'song', '歌曲', '[]', ''), ('other-cloud', 'external', 0, 'song', '歌曲', '[]', '');
    `);
    const receipts = ["bindPersonalPlaylist", "unbindPersonalPlaylist"].map(intent => {
      const key = v7({ msecs: now });
      const digest = canonicalDigest({ intent, roomId: "room-a" });
      const resourceId = `${intent}-result`;
      old.prepare("INSERT INTO command_receipt VALUES (?, ?, ?, ?, ?)").run("owner", key, digest, resourceId, now + 86_400_000);
      return { accountId: "owner", key, digest, resourceId };
    });
    old.close();

    migrateDatabase(filePath);
    migrateDatabase(filePath);

    const current = openDatabase(filePath);
    try {
      expect(current.$client.prepare("SELECT * FROM personal_playlist_binding").all()).toEqual([]);
      expect(current.$client.prepare("SELECT account_id, playlist_id FROM playlist_snapshot ORDER BY account_id, playlist_id").all()).toEqual([
        { account_id: "cloud", playlist_id: "public" }, { account_id: "other-cloud", playlist_id: "external" }
      ]);
      expect(current.$client.prepare("SELECT count(*) FROM playlist_track").pluck().get()).toBe(2);
      expect(current.$client.prepare("SELECT count(*) FROM public_playlist_cleanup").pluck().get()).toBe(0);
      expect(current.$client.prepare("SELECT count(*) FROM room_membership").pluck().get()).toBe(2);
      expect(current.$client.prepare("SELECT count(*) FROM public_playlist_binding").pluck().get()).toBe(1);
      for (const receipt of receipts) {
        expect(readCommandResource(current, receipt, now)).toBe(receipt.resourceId);
        expect(() => readCommandResource(current, { ...receipt, digest: canonicalDigest({ intent: "createPersonalPlaylist" }) }, now)).toThrowError("IDEMPOTENCY_CONFLICT");
      }
      expect(current.$client.prepare("SELECT id, version FROM room ORDER BY id").all()).toEqual([
        { id: "room-a", version: 2 }, { id: "room-b", version: 2 }, { id: "untouched", version: 1 }
      ]);
      expect(checkDatabase(filePath).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    } finally { current.$client.close(); }
  });

  it.each([23, 24])("从版本 %s 升级保留有独立创建证据的专用绑定、共享快照和所有在途创建状态，不依赖已到期操作信封", versions => {
    const filePath = temporaryDatabasePath();
    createOldDatabase(filePath, versions);
    const old = new Database(filePath);
    old.pragma("foreign_keys = ON");
    old.exec(`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', '房主', 'owner@example.com', 0, 1, 1), ('roommate', '室友', 'roommate@example.com', 0, 1, 1);
      INSERT INTO room (id, name, owner_user_id) VALUES ('room-a', '宿舍', 'owner'), ('room-b', '另一个宿舍', 'owner');
      INSERT INTO room_membership (id, room_id, user_id, nickname) VALUES ('owner-member', 'room-a', 'owner', '房主'), ('dedicated-member', 'room-b', 'roommate', '室友');
      INSERT INTO personal_playlist_binding (id, room_id, member_id, account_id, playlist_id, name, type, writeable, generation, creation_operation_id, created_at, updated_at) VALUES
        ('external', 'room-a', 'owner-member', 'cloud', 'dedicated', '收藏', 'ownerSubscribed', 0, 1, NULL, 1, 1),
        ('dedicated', 'room-b', 'dedicated-member', 'cloud', 'dedicated', 'songroom-另一个宿舍-室友', 'roommateDedicated', 1, 3, 'expired-creation-operation', 11, 22);
      INSERT INTO playlist_snapshot (account_id, playlist_id, snapshot_version, created_at, updated_at) VALUES ('cloud', 'dedicated', 7, 1, 1);
      INSERT INTO playlist_track (account_id, playlist_id, position, song_id, name, artists, album) VALUES ('cloud', 'dedicated', 0, 'song', '歌曲', '[]', '');
    `);
    for (const [index, step] of ["ready", "verified", "sending", "confirming", "unknown"].entries()) {
      const status = step === "ready" ? "queued" : step === "unknown" ? "awaitingConfirmation" : "processing";
      old.prepare("INSERT INTO operation (id, kind, user_id, room_id, account_id, authorization_id, generation, status, created_at, updated_at) VALUES (?, 'createPersonalPlaylist', ?, 'room-a', 'cloud', 'auth', 2, ?, 1, 2)").run(`pending-${index}`, `actor-${index}`, status);
      old.prepare("INSERT INTO personal_playlist_creation (operation_id, owner_user_id, member_id, name, step, playlist_id, before_playlists, after_playlists, sent_at, recovered) VALUES (?, 'owner', ?, '专用创建', ?, ?, ?, ?, ?, ?)").run(`pending-${index}`, `member-${index}`, step, step === "confirming" ? "returned-id" : null, '["before"]', step === "unknown" ? '["after"]' : null, ["sending", "confirming", "unknown"].includes(step) ? 123 : null, index % 2);
    }
    const operations = old.prepare("SELECT * FROM operation ORDER BY id").all();
    const creations = old.prepare("SELECT * FROM personal_playlist_creation ORDER BY operation_id").all();
    const snapshots = old.prepare("SELECT * FROM playlist_snapshot").all();
    const tracks = old.prepare("SELECT * FROM playlist_track").all();
    old.close();

    migrateDatabase(filePath);

    const current = openDatabase(filePath);
    try {
      expect(current.$client.prepare("SELECT * FROM personal_playlist_binding").all()).toEqual([{
        id: "dedicated", room_id: "room-b", member_id: "dedicated-member", account_id: "cloud", playlist_id: "dedicated",
        name: "songroom-另一个宿舍-室友", generation: 3,
        creation_operation_id: "expired-creation-operation", created_at: 11, updated_at: 22
      }]);
      expect(current.$client.prepare("SELECT * FROM operation ORDER BY id").all()).toEqual(operations);
      expect(current.$client.prepare("SELECT * FROM personal_playlist_creation ORDER BY operation_id").all()).toEqual(creations);
      expect(current.$client.prepare("SELECT * FROM playlist_snapshot").all()).toEqual(snapshots);
      expect(current.$client.prepare("SELECT * FROM playlist_track").all()).toEqual(tracks);
      expect(current.$client.pragma("foreign_key_check")).toEqual([]);
      expect(checkDatabase(filePath).ok).toBe(true);
    } finally { current.$client.close(); }
  });

  it.each([
    ["缺少创建证据", "UPDATE personal_playlist_binding SET creation_operation_id = NULL WHERE id = 'dedicated'"],
    ["空创建证据", "UPDATE personal_playlist_binding SET creation_operation_id = '' WHERE id = 'dedicated'"],
    ["只读专用来源", "UPDATE personal_playlist_binding SET writeable = 0 WHERE id = 'dedicated'"],
    ["专用目标重复", "INSERT INTO personal_playlist_binding SELECT 'duplicate', room_id, 'other-member', account_id, playlist_id, name, type, writeable, generation, 'other-creation', created_at, updated_at FROM personal_playlist_binding WHERE id = 'dedicated'"],
    ["创建证据重复", "INSERT INTO personal_playlist_binding SELECT 'duplicate', room_id, 'other-member', account_id, 'other-target', name, type, writeable, generation, creation_operation_id, created_at, updated_at FROM personal_playlist_binding WHERE id = 'dedicated'"],
    ["公共目标冲突", "INSERT INTO public_playlist_binding (room_id, account_id, playlist_id, name, creation_operation_id) VALUES ('room-a', 'cloud', 'dedicated', '公共', 'public-op')"],
    ["成员跨房间", "UPDATE personal_playlist_binding SET room_id = 'room-a' WHERE id = 'dedicated'"]
  ])("旧专用绑定%s时升级拒绝且完整回滚，包括先执行的外部退役", (_reason, damage) => {
    const filePath = temporaryDatabasePath();
    createOldDatabase(filePath, 24);
    const old = new Database(filePath);
    old.pragma("foreign_keys = ON");
    old.exec(`
      INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES ('owner', '房主', 'owner@example.com', 0, 1, 1), ('roommate', '室友', 'roommate@example.com', 0, 1, 1), ('other', '另一室友', 'other@example.com', 0, 1, 1);
      INSERT INTO room (id, name, owner_user_id) VALUES ('room-a', '宿舍', 'owner'), ('room-b', '另一个宿舍', 'owner');
      INSERT INTO room_membership (id, room_id, user_id, nickname) VALUES ('owner-member', 'room-a', 'owner', '房主'), ('dedicated-member', 'room-b', 'roommate', '室友'), ('other-member', 'room-b', 'other', '另一室友');
      INSERT INTO personal_playlist_binding (id, room_id, member_id, account_id, playlist_id, name, type, writeable, generation, creation_operation_id, created_at, updated_at) VALUES
        ('external', 'room-a', 'owner-member', 'cloud', 'external', '收藏', 'ownerSubscribed', 0, 1, NULL, 1, 1),
        ('dedicated', 'room-b', 'dedicated-member', 'cloud', 'dedicated', '专用', 'roommateDedicated', 1, 1, 'dedicated-op', 1, 1);
      INSERT INTO playlist_snapshot (account_id, playlist_id, created_at, updated_at) VALUES ('cloud', 'external', 1, 1);
      INSERT INTO playlist_track (account_id, playlist_id, position, song_id, name, artists, album) VALUES ('cloud', 'external', 0, 'song', '歌曲', '[]', '');
    `);
    old.exec(damage);
    const tables = ["schema_meta", "__drizzle_migrations", "room", "room_membership", "personal_playlist_binding", "playlist_snapshot", "playlist_track", "public_playlist_binding", "command_receipt", "public_playlist_cleanup", "operation", "personal_playlist_creation"];
    const before = tables.map(table => old.prepare(`SELECT * FROM ${table}`).all());
    old.close();

    expect(() => migrateDatabase(filePath)).toThrow();

    const unchanged = new Database(filePath);
    try {
      expect(tables.map(table => unchanged.prepare(`SELECT * FROM ${table}`).all())).toEqual(before);
      expect(unchanged.pragma("foreign_key_check")).toEqual([]);
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name LIKE '__new_%'").all()).toEqual([]);
    } finally { unchanged.close(); }
  });

  it("does not change an existing non-WAL journal mode when opening", () => {
    const filePath = temporaryDatabasePath();
    initializeDatabase(filePath);
    const client = new Database(filePath, { fileMustExist: true });
    client.pragma("journal_mode = DELETE");
    client.close();

    expect(() => openDatabase(filePath)).toThrow(/not WAL/);
    const readonly = new Database(filePath, { fileMustExist: true, readonly: true });
    expect(readonly.pragma("journal_mode", { simple: true })).toBe("delete");
    readonly.close();
  });
  it("does not overwrite an existing file during initialization", () => {
    const filePath = temporaryDatabasePath();
    fs.writeFileSync(filePath, "pre-existing");

    expect(() => initializeDatabase(filePath)).toThrow(/already exists/);
    expect(fs.readFileSync(filePath, "utf8")).toBe("pre-existing");
  });

  it("applies explicit migrations and performs a read-only health check", () => {
    const filePath = temporaryDatabasePath();
    initializeDatabase(filePath);

    migrateDatabase(filePath);

    expect(checkDatabase(filePath)).toEqual({
      ok: true,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      migrationHashes: Array.from({ length: CURRENT_SCHEMA_VERSION }, () => expect.any(String)),
      journalMode: "wal",
      foreignKeys: true,
      integrity: "ok"
    });
  });

  it("upgrades a real database built from the first Drizzle migration", () => {
    const filePath = temporaryDatabasePath();
    createOldDatabase(filePath);

    expect(() => checkDatabase(filePath)).toThrow(/schema version/);
    migrateDatabase(filePath);

    expect(checkDatabase(filePath).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("rejects database file with invalid permissions or symbolic link", () => {
    const filePath = temporaryDatabasePath();
    initializeDatabase(filePath);
    fs.chmodSync(filePath, 0o644);
    expect(() => checkDatabase(filePath)).toThrow(/0600 or 0400/);
    expect(() => openDatabase(filePath)).toThrow(/mode 0600/);
    expect(() => migrateDatabase(filePath)).toThrow(/mode 0600/);

    fs.chmodSync(filePath, 0o400);
    // 0400 is allowed for read-only check, but rejected for writable open and migration
    expect(checkDatabase(filePath).ok).toBe(true);
    expect(() => openDatabase(filePath)).toThrow(/mode 0600/);
    expect(() => migrateDatabase(filePath)).toThrow(/mode 0600/);

    fs.chmodSync(filePath, 0o600);
    const symlinkPath = path.join(path.dirname(filePath), "symlink.sqlite");
    fs.symlinkSync(filePath, symlinkPath);
    expect(() => checkDatabase(symlinkPath)).toThrow(/symbolic link/);
    expect(() => openDatabase(symlinkPath)).toThrow(/symbolic link/);
    expect(() => migrateDatabase(symlinkPath)).toThrow(/symbolic link/);
  });

  it("公共歌单清理表迁移升级时保守保留发送状态，非 ready 状态任务升级为 has_sent=1", () => {
    const filePath = temporaryDatabasePath();
    createOldDatabase(filePath, 17);
    const now = Date.now();
    const old = new Database(filePath, { fileMustExist: true });
    old.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)").run("mig-user", "迁移测试", "migration-clean@example.com", now, now);
    old.prepare("INSERT INTO public_playlist_cleanup (id, user_id, account_id, playlist_id, status, last_error_code, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("cl-ready", "mig-user", "acc-1", "pl-1", "ready", null, 1, now, now);
    old.prepare("INSERT INTO public_playlist_cleanup (id, user_id, account_id, playlist_id, status, last_error_code, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("cl-sending", "mig-user", "acc-1", "pl-2", "sending", null, 1, now, now);
    old.prepare("INSERT INTO public_playlist_cleanup (id, user_id, account_id, playlist_id, status, last_error_code, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("cl-waiting", "mig-user", "acc-1", "pl-3", "waitingAuthorization", null, 1, now, now);
    old.close();

    migrateDatabase(filePath);

    const current = openDatabase(filePath);
    expect(checkDatabase(filePath).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const rows = current.$client.prepare("SELECT id, has_sent FROM public_playlist_cleanup ORDER BY id").all() as Array<{ id: string; has_sent: number }>;
    expect(rows).toEqual([
      { id: "cl-ready", has_sent: 0 },
      { id: "cl-sending", has_sent: 1 },
      { id: "cl-waiting", has_sent: 1 }
    ]);
    current.$client.close();
  });

  it("从版本 25 升级保留既有操作并在新库中支持个人歌曲添加表与枚举", () => {
    const filePath = temporaryDatabasePath();
    createOldDatabase(filePath, 25);
    const old = new Database(filePath);
    old.pragma("foreign_keys = ON");
    const now = Date.now();
    old.prepare("INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run("u-1", "用户", "u1@example.com", 0, now, now);
    old.prepare("INSERT INTO room (id, name, owner_user_id) VALUES (?, ?, ?)").run("r-1", "房间", "u-1");
    old.prepare("INSERT INTO room_membership (id, room_id, user_id, nickname) VALUES (?, ?, ?, ?)").run("m-1", "r-1", "u-1", "房主");
    old.prepare("INSERT INTO operation (id, kind, user_id, room_id, status, last_granted, version, created_at, updated_at) VALUES (?, 'createPublicPlaylist', ?, ?, 'succeeded', 0, 1, ?, ?)").run("op-prev", "u-1", "r-1", now, now);
    old.close();

    migrateDatabase(filePath);

    const current = openDatabase(filePath);
    expect(checkDatabase(filePath).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    const op = current.$client.prepare("SELECT * FROM operation WHERE id = 'op-prev'").get() as { id: string; kind: string };
    expect(op.kind).toBe("createPublicPlaylist");

    // 验证新 operation.kind 允许 addPersonalSong 并能插入 personal_song_mutation
    current.$client.prepare("INSERT INTO operation (id, kind, user_id, room_id, account_id, authorization_id, generation, status, last_granted, version, created_at, updated_at) VALUES (?, 'addPersonalSong', ?, ?, 'acc', 'auth', 1, 'queued', 0, 1, ?, ?)").run("op-add", "u-1", "r-1", now, now);
    current.$client.prepare("INSERT INTO personal_song_mutation (operation_id, member_id, playlist_id, binding_generation, song_id, name, artists, album, step) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run("op-add", "m-1", "pl-1", 1, "s-1", "歌", "[]", "专", "ready");
    const addition = current.$client.prepare("SELECT * FROM personal_song_mutation WHERE operation_id = 'op-add'").get() as { song_id: string; step: string };
    expect(addition.song_id).toBe("s-1");
    expect(addition.step).toBe("ready");
    expect(current.$client.pragma("foreign_key_check")).toEqual([]);
    current.$client.close();
  });

  it.each(["DELETE FROM schema_meta", "DROP TABLE schema_meta"])("缺少版本事实时，迁移在写入前拒绝并保留原库：%s", sql => {
    const filePath = temporaryDatabasePath();
    createOldDatabase(filePath);
    const damaged = new Database(filePath, { fileMustExist: true });
    damaged.exec(sql);
    damaged.close();
    const before = fs.readFileSync(filePath);
    expect(() => migrateDatabase(filePath)).toThrow(/schema version|table definition/);
    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
  });

  it("rejects a database whose required table constraints were changed", () => {
    const filePath = temporaryDatabasePath();
    initializeDatabase(filePath);
    const client = new Database(filePath, { fileMustExist: true });
    client.exec("ALTER TABLE schema_meta RENAME TO old_schema_meta");
    client.exec("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)");
    client.exec("INSERT INTO schema_meta SELECT * FROM old_schema_meta");
    client.exec("DROP TABLE old_schema_meta");
    client.close();
    const before = fs.readFileSync(filePath);

    expect(() => checkDatabase(filePath)).toThrow(/table definition/);
    expect(() => openDatabase(filePath)).toThrow(/table definition/);
    expect(() => migrateDatabase(filePath)).toThrow(/table definition/);
    expect(fs.readFileSync(filePath)).toEqual(before);
  });

  it("does not modify a database with a changed migration timestamp", () => {
    const filePath = temporaryDatabasePath();
    initializeDatabase(filePath);
    const client = new Database(filePath, { fileMustExist: true });
    client.exec("UPDATE __drizzle_migrations SET created_at = created_at + 1");
    client.close();
    const before = fs.readFileSync(filePath);

    expect(() => migrateDatabase(filePath)).toThrow(/migration history/);
    expect(fs.readFileSync(filePath)).toEqual(before);
  });

  it("does not create missing files when checking, opening, or migrating", () => {
    const filePath = temporaryDatabasePath();

    expect(() => checkDatabase(filePath)).toThrow(/does not exist/);
    expect(() => openDatabase(filePath)).toThrow(/does not exist/);
    expect(() => migrateDatabase(filePath)).toThrow(/does not exist/);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("rejects a changed migration hash during the read-only check", () => {
    const filePath = temporaryDatabasePath();
    initializeDatabase(filePath);
    const database = openDatabase(filePath);
    database.$client.prepare("UPDATE __drizzle_migrations SET hash = 'tampered'").run();
    database.$client.close();

    expect(() => checkDatabase(filePath)).toThrow(/migration hash/i);
  });
});

it("0027将已有个人加歌明细升级到共享加删表，保持sending与恢复证据且不保留旧表", () => {
  const filePath = temporaryDatabasePath();
  createOldDatabase(filePath, 27);
  const old = new Database(filePath);
  const now = Date.now();
  old.prepare("INSERT INTO operation (id, kind, user_id, room_id, account_id, authorization_id, generation, status, last_granted, version, created_at, updated_at) VALUES ('op-existing', 'addPersonalSong', 'actor', 'room', 'acc', 'auth', 2, 'processing', 4, 7, ?, ?)").run(now, now);
  old.prepare("INSERT INTO personal_song_addition (operation_id, member_id, playlist_id, binding_generation, song_id, name, artists, album, step, check_round, next_check_at) VALUES ('op-existing', 'member', 'target', 3, 'song', '歌', '[]', '专', 'sending', 2, ?)").run(now + 30000);
  old.close();
  migrateDatabase(filePath);
  const current = openDatabase(filePath);
  expect(checkDatabase(filePath).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  expect(current.$client.prepare("SELECT name FROM sqlite_master WHERE name = 'personal_song_addition'").get()).toBeUndefined();
  expect(current.$client.prepare("SELECT kind, version, status, account_id FROM operation WHERE id = 'op-existing'").get()).toEqual({ kind: "addPersonalSong", version: 7, status: "processing", account_id: "acc" });
  expect(current.$client.prepare("SELECT song_id, binding_generation, step, check_round, next_check_at FROM personal_song_mutation WHERE operation_id = 'op-existing'").get()).toEqual({ song_id: "song", binding_generation: 3, step: "sending", check_round: 2, next_check_at: now + 30000 });
  current.$client.prepare("INSERT INTO operation (id, kind, user_id, room_id, status, version, created_at, updated_at) VALUES ('op-remove', 'removePersonalSong', 'actor2', 'room', 'succeeded', 1, ?, ?)").run(now, now);
  current.$client.prepare("INSERT INTO personal_song_mutation (operation_id, member_id, playlist_id, binding_generation, song_id, name, artists, album, step) VALUES ('op-remove', 'member2', 'target2', 1, 'song2', '歌2', '[]', '', 'prepared')").run();
  expect(current.$client.pragma("foreign_key_check")).toEqual([]);
  current.$client.close();
});

it("0028移除请求间隔与废弃步骤，保留执行权、暂停及个人歌曲和playNext恢复事实", () => {
  const filePath = temporaryDatabasePath();
  createOldDatabase(filePath, 28);
  const old = new Database(filePath);
  old.exec(`
    INSERT INTO upstream_account (account_id, next_start_at, running_operation_id, paused, pause_reason) VALUES
      ('running', 9999999999999, 'op-sending', 0, NULL), ('paused', 9999999999999, NULL, 1, 'RATE_LIMITED');
  `);
  const steps = ["ready", "verified", "prepared", "sending", "confirming", "unknown", "succeeded", "rejected", "stopped"];
  for (const step of steps) {
    old.prepare("INSERT INTO operation (id, kind, user_id, room_id, account_id, authorization_id, generation, status, created_at, updated_at) VALUES (?, 'removePersonalSong', ?, 'room', 'running', 'auth', 1, 'processing', 1, 2)").run(`op-${step}`, `actor-${step}`);
    old.prepare("INSERT INTO personal_song_mutation (operation_id, member_id, playlist_id, binding_generation, song_id, name, artists, album, step, check_round, next_check_at) VALUES (?, 'member', 'target', 3, 'song', '歌', '[]', '专', ?, 2, 30000)").run(`op-${step}`, step);
  }
  const playNextSteps = ["ready", "identityVerified", "playbackVerified", "verified", "sending", "confirming", "unknown", "succeeded", "rejected", "stopped"];
  for (const step of playNextSteps) {
    old.prepare("INSERT INTO operation (id, kind, user_id, room_id, account_id, authorization_id, generation, status, created_at, updated_at) VALUES (?, 'playNext', ?, 'room', 'running', 'auth', 4, 'processing', 11, 22)").run(`play-${step}`, `player-${step}`);
    old.prepare("INSERT INTO public_play_next (operation_id, song_id, anchor_song_id, playlist_id, binding_generation, member_id, original_song_ids, target_song_ids, step, check_round, next_check_at) VALUES (?, 'song', 'anchor', 'public-target', 5, 'member', ?, ?, ?, 3, 120000)").run(`play-${step}`, '["song","anchor","other"]', '["anchor","song","other"]', step);
  }
  const operations = old.prepare("SELECT * FROM operation ORDER BY id").all();
  old.close();

  migrateDatabase(filePath);
  migrateDatabase(filePath);

  const current = openDatabase(filePath);
  try {
    expect(current.$client.prepare("SELECT * FROM upstream_account ORDER BY account_id").all()).toEqual([
      { account_id: "paused", running_operation_id: null, paused: 1, pause_reason: "RATE_LIMITED" },
      { account_id: "running", running_operation_id: "op-sending", paused: 0, pause_reason: null }
    ]);
    expect(current.$client.prepare("SELECT * FROM operation ORDER BY id").all()).toEqual(operations);
    for (const step of steps) {
      expect(current.$client.prepare("SELECT * FROM personal_song_mutation WHERE operation_id = ?").get(`op-${step}`)).toEqual({
        operation_id: `op-${step}`, member_id: "member", playlist_id: "target", binding_generation: 3,
        song_id: "song", name: "歌", artists: "[]", album: "专", step: step === "verified" ? "ready" : step,
        check_round: 2, next_check_at: 30000
      });
    }
    expect(() => current.$client.prepare("UPDATE personal_song_mutation SET step = 'verified' WHERE operation_id = 'op-ready'").run()).toThrow(/CHECK constraint/);
    for (const step of playNextSteps) {
      expect(current.$client.prepare("SELECT * FROM public_play_next WHERE operation_id = ?").get(`play-${step}`)).toEqual({
        operation_id: `play-${step}`, song_id: "song", anchor_song_id: "anchor", playlist_id: "public-target", binding_generation: 5,
        member_id: "member", original_song_ids: '["song","anchor","other"]', target_song_ids: '["anchor","song","other"]',
        step: step === "identityVerified" ? "ready" : step, check_round: 3, next_check_at: 120000
      });
    }
    expect(() => current.$client.prepare("UPDATE public_play_next SET step = 'identityVerified' WHERE operation_id = 'play-ready'").run()).toThrow(/CHECK constraint/);
    expect(current.$client.pragma("foreign_key_check")).toEqual([]);
    expect(checkDatabase(filePath).schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  } finally { current.$client.close(); }
});
