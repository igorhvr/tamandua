import { DatabaseSync } from "node:sqlite";

export const E2E_DATABASE_BUSY_TIMEOUT_MS = 5_000;

/** Open an e2e SQLite database with the same lock-wait policy as production. */
export function openE2eDatabase(databasePath, options = {}) {
  const db = new DatabaseSync(databasePath, options);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}
