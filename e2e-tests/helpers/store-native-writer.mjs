/**
 * G8 ADMISSION-INTEGRATION US-013 — the NATIVE (host-side) SQLite writer used by
 * the scenario C mixed-overlap qualification.
 *
 * Scenario C needs two INDEPENDENT writers on ONE store for a bounded, honest
 * period: in the real-VM tier the second writer is the admitted guest harness
 * (inside the VM, on the identical-path mount), and in the always-on no-VM
 * control both writers are host processes. This module is the native side of
 * that pair: a separate OS process, so it has a RECORDED PID the caller can
 * stop directly (never a pattern kill), and so its commits are genuinely
 * concurrent rather than interleaved inside one event loop.
 *
 * CONTRACT
 *   node store-native-writer.mjs --db <path> --writer <label> --ledger <path>
 *        [--table native_writer_rows] [--rows 200] [--interval-ms 25]
 *        [--duration-ms 120000] [--busy-timeout-ms 5000]
 *        [--retry-limit 20]
 *
 *   - Every row is ONE autocommit INSERT (a real committed transaction), so a
 *     later reader can prove that every record the writer COMMITTED is still
 *     present. Each commit is appended to the ledger BEFORE the next attempt, so
 *     the ledger is the writer's own durable account of what it committed.
 *   - The bounded window (`--duration-ms`) and the row budget both end the loop;
 *     SIGTERM (the caller stopping a recorded pid) ends it after the in-flight
 *     INSERT settles. A stopped writer still writes its summary line.
 *   - A `SQLITE_BUSY`/locked error is RETRIED (bounded), never counted as a
 *     commit; an unrecoverable error is written to the ledger and exits 1 so the
 *     gate cannot mistake a broken writer for a clean overlap.
 *   - The database is opened through the e2e helper (`openE2eDatabase`) so the
 *     busy-timeout policy is the same one every other e2e fixture uses.
 *
 * LEDGER (append-only JSON lines)
 *   {"kind":"commit","pid":<pid>,"writer":<label>,"seq":<n>,"at":"<ISO>"}
 *   {"kind":"error","pid":<pid>,"writer":<label>,"seq":<n>,"message":"..."}
 *   {"kind":"summary","pid":<pid>,"writer":<label>,"attempted":<n>,
 *    "committed":<n>,"failed":<n>,"stopped":"completed|duration|signal",
 *    "journalMode":"<mode>","table":"<name>","db":"<path>"}
 *
 * Exit codes: 0 completed/duration/signal, 1 unrecoverable error, 2 bad usage.
 */
import fs from "node:fs";
import path from "node:path";

import { openE2eDatabase } from "./e2e-database.mjs";

const TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function usage(message) {
  process.stderr.write(`store-native-writer: ${message}\n`);
  process.stderr.write(
    "usage: store-native-writer.mjs --db <path> --writer <label> --ledger <path> " +
      "[--table native_writer_rows] [--rows 200] [--interval-ms 25] " +
      "[--duration-ms 120000] [--busy-timeout-ms 5000] [--retry-limit 20]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    db: "",
    writer: "",
    ledger: "",
    table: "native_writer_rows",
    rows: 200,
    intervalMs: 25,
    durationMs: 120_000,
    busyTimeoutMs: 5000,
    retryLimit: 20,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) usage(`missing value for ${flag}`);
    index += 1;
    switch (flag) {
      case "--db":
        options.db = value;
        break;
      case "--writer":
        options.writer = value;
        break;
      case "--ledger":
        options.ledger = value;
        break;
      case "--table":
        options.table = value;
        break;
      case "--rows":
        options.rows = Number.parseInt(value, 10);
        break;
      case "--interval-ms":
        options.intervalMs = Number.parseInt(value, 10);
        break;
      case "--duration-ms":
        options.durationMs = Number.parseInt(value, 10);
        break;
      case "--busy-timeout-ms":
        options.busyTimeoutMs = Number.parseInt(value, 10);
        break;
      case "--retry-limit":
        options.retryLimit = Number.parseInt(value, 10);
        break;
      default:
        usage(`unknown flag ${flag}`);
    }
  }
  if (options.db === "") usage("--db is required");
  if (options.writer === "") usage("--writer is required");
  if (options.ledger === "") usage("--ledger is required");
  if (!TABLE_NAME_RE.test(options.table)) usage(`invalid table name: ${options.table}`);
  for (const key of ["rows", "intervalMs", "durationMs", "busyTimeoutMs", "retryLimit"]) {
    if (!Number.isFinite(options[key]) || options[key] < 0) usage(`invalid ${key}`);
  }
  return options;
}

/** Append ONE ledger line (durable before the next attempt). */
function appendLedger(ledgerPath, entry) {
  fs.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`, "utf-8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLockError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(message);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  fs.mkdirSync(path.dirname(options.ledger), { recursive: true });

  let stopRequested = null;
  const onSignal = (signal) => {
    stopRequested = signal;
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  // openE2eDatabase applies the shared e2e busy-timeout policy (5000 ms); the
  // explicit PRAGMA below only raises it when the caller asks for more.
  const db = openE2eDatabase(options.db);
  let journalMode = "unknown";
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(options.busyTimeoutMs))}`);
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${options.table} (` +
        "writer TEXT NOT NULL, seq INTEGER NOT NULL, committed_at TEXT NOT NULL, " +
        "payload TEXT NOT NULL, PRIMARY KEY (writer, seq))",
    );
    const mode = db.prepare("PRAGMA journal_mode").get();
    journalMode = String(mode?.journal_mode ?? "unknown");

    const insert = db.prepare(
      `INSERT INTO ${options.table} (writer, seq, committed_at, payload) VALUES (?, ?, ?, ?)`,
    );

    // Announce the pid BEFORE the first write: the caller records it and can
    // stop exactly this process later.
    process.stdout.write(
      `pid=${process.pid} writer=${options.writer} db=${options.db} journalMode=${journalMode}\n`,
    );

    const deadline = Date.now() + options.durationMs;
    let attempted = 0;
    let committed = 0;
    let failed = 0;
    let stopped = "completed";

    for (let seq = 1; seq <= options.rows; seq += 1) {
      if (stopRequested !== null) {
        stopped = "signal";
        break;
      }
      if (Date.now() >= deadline) {
        stopped = "duration";
        break;
      }
      attempted += 1;
      let written = false;
      let lastError = null;
      for (let retry = 0; retry <= options.retryLimit && !written; retry += 1) {
        try {
          insert.run(options.writer, seq, new Date().toISOString(), `row-${seq}`);
          written = true;
        } catch (error) {
          lastError = error;
          if (!isLockError(error) || stopRequested !== null) break;
          await sleep(Math.min(250, 10 * (retry + 1)));
        }
      }
      if (written) {
        committed += 1;
        appendLedger(options.ledger, {
          kind: "commit",
          pid: process.pid,
          writer: options.writer,
          seq,
          at: new Date().toISOString(),
        });
      } else {
        failed += 1;
        appendLedger(options.ledger, {
          kind: "error",
          pid: process.pid,
          writer: options.writer,
          seq,
          message: lastError instanceof Error ? lastError.message : String(lastError),
        });
        if (lastError !== null && !isLockError(lastError)) {
          // Not a contention outcome: the store itself is unusable.
          appendLedger(options.ledger, {
            kind: "summary",
            pid: process.pid,
            writer: options.writer,
            attempted,
            committed,
            failed,
            stopped: "error",
            journalMode,
            table: options.table,
            db: options.db,
          });
          process.exitCode = 1;
          return;
        }
      }
      if (options.intervalMs > 0) await sleep(options.intervalMs);
    }

    if (stopRequested !== null) stopped = "signal";
    appendLedger(options.ledger, {
      kind: "summary",
      pid: process.pid,
      writer: options.writer,
      attempted,
      committed,
      failed,
      stopped,
      journalMode,
      table: options.table,
      db: options.db,
    });
  } catch (error) {
    appendLedger(options.ledger, {
      kind: "summary",
      pid: process.pid,
      writer: options.writer,
      attempted: 0,
      committed: 0,
      failed: 0,
      stopped: "error",
      journalMode,
      table: options.table,
      db: options.db,
      message: error instanceof Error ? error.message : String(error),
    });
    process.stderr.write(
      `store-native-writer: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  } finally {
    try {
      db.close();
    } catch {
      /* a close failure after a write error is not a new outcome */
    }
  }
}

await main();
