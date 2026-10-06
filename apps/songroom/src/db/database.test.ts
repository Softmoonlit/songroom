import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
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

function createOldDatabase(filePath: string): void {
  const fixtureFolder = path.join(path.dirname(filePath), "old-migrations");
  const migrationFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");
  const journal = JSON.parse(fs.readFileSync(path.join(migrationFolder, "meta/_journal.json"), "utf8")) as {
    version: string;
    dialect: string;
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.slice(0, 1);
  fs.mkdirSync(path.join(fixtureFolder, "meta"), { recursive: true });
  fs.writeFileSync(path.join(fixtureFolder, "meta/_journal.json"), JSON.stringify(journal));
  fs.copyFileSync(path.join(migrationFolder, `${journal.entries[0].tag}.sql`), path.join(fixtureFolder, `${journal.entries[0].tag}.sql`));
  const oldClient = new Database(filePath);
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
      "schema_meta"
    ]);
    expect(database.$client.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get()).toBe(String(CURRENT_SCHEMA_VERSION));
    database.$client.close();
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
      migrationHashes: [expect.any(String), expect.any(String)],
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

    expect(checkDatabase(filePath).schemaVersion).toBe(2);
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
