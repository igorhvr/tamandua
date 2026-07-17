import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { tamanduaTempDir } from "../../src/lib/temp-dir.ts";
import {
  E2E_DATABASE_BUSY_TIMEOUT_MS,
  openE2eDatabase,
} from "./e2e-database.mjs";

describe("e2e database opener", () => {
  it("sets a 5000 ms busy timeout before returning the database", () => {
    const tempDir = tamanduaTempDir("tamandua-e2e-db-");
    const dbPath = path.join(tempDir, "tamandua.db");
    const db = openE2eDatabase(dbPath);

    try {
      const row = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      assert.equal(row.timeout, E2E_DATABASE_BUSY_TIMEOUT_MS);
    } finally {
      db.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves DatabaseSync options for non-tamandua SQLite files", () => {
    const tempDir = tamanduaTempDir("tamandua-e2e-state-db-");
    const dbPath = path.join(tempDir, "state.db");
    const writableDb = openE2eDatabase(dbPath);
    writableDb.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY)");
    writableDb.close();

    const readOnlyDb = openE2eDatabase(dbPath, { readOnly: true });
    try {
      const row = readOnlyDb.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      assert.equal(row.timeout, E2E_DATABASE_BUSY_TIMEOUT_MS);
      assert.throws(
        () => readOnlyDb.exec("INSERT INTO sessions VALUES ('unexpected')"),
        /read-only|readonly/i,
      );
    } finally {
      readOnlyDb.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
