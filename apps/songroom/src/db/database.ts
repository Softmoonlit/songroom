import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles, type MigrationMeta } from "drizzle-orm/migrator";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export const CURRENT_SCHEMA_VERSION = 11;

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export type AppDatabase = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

export type DatabaseCheck = {
  ok: true;
  schemaVersion: number;
  migrationHashes: string[];
  journalMode: "wal";
  foreignKeys: true;
  integrity: "ok";
};

export function databaseExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function createDatabase(filePath: string): Database.Database {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "wx", 0o600);
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      throw new Error(`database already exists: ${filePath}`);
    }
    throw error;
  }
  fs.closeSync(descriptor);

  try {
    fs.chmodSync(filePath, 0o600);
    return new Database(filePath, { fileMustExist: true });
  } catch (error) {
    removeDatabaseFiles(filePath);
    throw error;
  }
}

export function initializeDatabase(filePath: string): void {
  const client = createDatabase(filePath);
  try {
    configureWritableSqlite(client);
    runMigrations(client);
    assertDatabase(client);
  } catch (error) {
    client.close();
    removeDatabaseFiles(filePath);
    throw error;
  } finally {
    if (client.open) {
      client.close();
    }
  }
}

export function migrateDatabase(filePath: string): void {
  assertDatabasePath(filePath);
  const client = new Database(filePath, { fileMustExist: true });
  try {
    const expectedMigrations = readMigrations();
    assertMigrationHistoryPrefix(client, expectedMigrations, false);
    configureWritableSqlite(client);
    runMigrations(client);
    assertDatabase(client);
  } finally {
    client.close();
  }
}

export function openDatabase(filePath: string): AppDatabase {
  assertDatabasePath(filePath);
  const client = new Database(filePath, { fileMustExist: true });
  try {
    configureConnection(client);
    assertHealthyDatabase(client);
    return drizzle(client, { schema }) as AppDatabase;
  } catch (error) {
    client.close();
    throw error;
  }
}

export function checkDatabase(filePath: string): DatabaseCheck {
  assertDatabasePath(filePath);
  const client = new Database(filePath, { fileMustExist: true, readonly: true });
  try {
    configureReadOnlyConnection(client);
    assertHealthyDatabase(client);
    const expectedMigrations = readMigrations();
    const migrationHashes = assertMigrationHashes(client, expectedMigrations);
    return {
      ok: true,
      schemaVersion: readSchemaVersion(client),
      migrationHashes,
      journalMode: "wal",
      foreignKeys: true,
      integrity: "ok"
    };
  } finally {
    client.close();
  }
}

function runMigrations(client: Database.Database): void {
  const database = drizzle(client, { schema }) as AppDatabase;
  migrate(database, { migrationsFolder });
}

function configureWritableSqlite(client: Database.Database): void {
  configureConnection(client);
  const journalMode = String(client.pragma("journal_mode = WAL", { simple: true })).toLowerCase();
  if (journalMode !== "wal") {
    throw new Error(`unable to enable SQLite WAL (journal mode: ${journalMode})`);
  }
}

function configureConnection(client: Database.Database): void {
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
  client.pragma("synchronous = NORMAL");
}

function configureReadOnlyConnection(client: Database.Database): void {
  client.pragma("foreign_keys = ON");
  client.pragma("busy_timeout = 5000");
}

function assertHealthyDatabase(client: Database.Database): void {
  assertDatabase(client);
  const journalMode = String(client.pragma("journal_mode", { simple: true })).toLowerCase();
  if (journalMode !== "wal") {
    throw new Error(`database journal mode ${journalMode} is not WAL`);
  }
  const integrity = String(client.pragma("integrity_check", { simple: true })).toLowerCase();
  if (integrity !== "ok") {
    throw new Error(`database integrity check failed: ${integrity}`);
  }
  const foreignKeyViolations = client.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length !== 0) {
    throw new Error("database foreign key check failed");
  }
  const foreignKeys = client.pragma("foreign_keys", { simple: true });
  if (foreignKeys !== 1) {
    throw new Error("database foreign keys are disabled");
  }
}

const schemaMetaColumns = [
  { name: "key", type: "TEXT", notnull: 1, pk: 1 },
  { name: "value", type: "TEXT", notnull: 1, pk: 0 }
] as const;
const migrationColumns = [
  { name: "id", type: "SERIAL", notnull: 0, pk: 1 },
  { name: "hash", type: "TEXT", notnull: 1, pk: 0 },
  { name: "created_at", type: "NUMERIC", notnull: 0, pk: 0 }
] as const;

function assertDatabase(client: Database.Database): void {
  assertRequiredTableDefinitions(client);
  const schemaVersion = readSchemaVersion(client);
  if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`database schema version ${String(schemaVersion)} does not match ${CURRENT_SCHEMA_VERSION}`);
  }
  assertMigrationHistoryPrefix(client, readMigrations(), true);
  const tableSql = client.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'").pluck().get() as string;
  const normalized = tableSql.replace(/[\s`\"]/g, "").toLowerCase();
  if (!normalized.includes("check(schema_meta.key='schema_version'andcast(schema_meta.valueasinteger)>0andcast(cast(schema_meta.valueasinteger)astext)=schema_meta.value)")) {
    throw new Error("database schema version constraint is missing");
  }
}

function assertRequiredTableDefinitions(client: Database.Database): void {
  assertTableDefinition(client, "schema_meta", schemaMetaColumns);
  assertTableDefinition(client, "__drizzle_migrations", migrationColumns);
}

function assertTableDefinition(
  client: Database.Database,
  table: string,
  columns: ReadonlyArray<{ name: string; type: string; notnull: number; pk: number }>
): void {
  const actual = client.prepare(`PRAGMA table_info(\"${table}\")`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    pk: number;
  }>;
  if (actual.length !== columns.length || actual.some((column, index) => {
    const expectedColumn = columns[index];
    return column.name !== expectedColumn.name
      || column.type.toUpperCase() !== expectedColumn.type
      || column.notnull !== expectedColumn.notnull
      || column.pk !== expectedColumn.pk;
  })) {
    throw new Error(`database table definition is invalid: ${table}`);
  }
}

function readSchemaVersion(client: Database.Database): number {
  const value = client
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .pluck()
    .get();
  const version = Number(value);
  if (!Number.isInteger(version)) {
    throw new Error(`invalid database schema version: ${String(value)}`);
  }
  return version;
}

function assertMigrationHistoryPrefix(client: Database.Database, expected: MigrationMeta[], requireCurrent: boolean): string[] {
  const migrationTable = client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'")
    .pluck()
    .get();
  if (!migrationTable) {
    throw new Error("database migration history is missing; run db init to establish a baseline");
  }
  assertTableDefinition(client, "__drizzle_migrations", migrationColumns);
  assertTableDefinition(client, "schema_meta", schemaMetaColumns);
  const applied = client
    .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, id")
    .all() as Array<{ hash: string; created_at: number | null }>;

  const expectedHashes = expected.map((migration) => migration.hash);
  if (applied.length > expectedHashes.length) {
    throw new Error(`database migration history is newer than application schema (${applied.length})`);
  }
  if (requireCurrent && applied.length !== expectedHashes.length) {
    throw new Error(`database migration history has ${applied.length} entries; expected ${expectedHashes.length}`);
  }
  let previousCreatedAt = -Infinity;
  for (let index = 0; index < applied.length; index += 1) {
    const createdAt = Number(applied[index].created_at);
    if (applied[index].created_at === null || createdAt !== expected[index].folderMillis || createdAt <= previousCreatedAt) {
      throw new Error("database migration history ordering or timestamp is invalid");
    }
    previousCreatedAt = createdAt;
    if (applied[index].hash !== expectedHashes[index]) {
      throw new Error(`database migration hash mismatch at version ${index + 1}`);
    }
  }
  const schemaVersion = readSchemaVersion(client);
  if (schemaVersion > CURRENT_SCHEMA_VERSION || schemaVersion > applied.length) {
    throw new Error(`database schema version ${String(schemaVersion)} is newer than application schema`);
  }
  if (schemaVersion !== applied.length) {
    throw new Error("database schema version does not match migration history");
  }
  return applied.map((migration) => migration.hash);
}

function assertMigrationHashes(client: Database.Database, expected: MigrationMeta[]): string[] {
  return assertMigrationHistoryPrefix(client, expected, true);
}

function readMigrations(): MigrationMeta[] {
  return readMigrationFiles({ migrationsFolder });
}

function assertDatabasePath(filePath: string): void {
  if (!databaseExists(filePath)) {
    throw new Error(`database does not exist: ${filePath}; run db init`);
  }
}

function removeDatabaseFiles(filePath: string): void {
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try {
      fs.rmSync(candidate, { force: true });
    } catch {
      // Preserve the original initialization error.
    }
  }
}

function isAlreadyExistsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST";
}
