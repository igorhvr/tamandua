// terminal-wait.mjs — shared terminal-state poller for the scripted W2 cells.
//
// MACP7 US-004: a register-run failure ("harness workdir is already set"
// class) must surface as a distinct, IMMEDIATE cell failure with the daemon's
// error captured — not a generic did-not-reach-terminal timeout burned
// minutes later.
//
// The daemon writes that failure class as scheduling_status='error' on the
// runs row (control-server.ts handleRegisterRun catch arm:
// "UPDATE runs SET scheduling_status = 'error', scheduling_error = ?"),
// leaving status 'running' — so a poll that only watches status spins until
// the full poll budget. waitForTerminalRun() watches BOTH: terminal status
// (completed/failed/canceled) and the error class, failing immediately with
// the machine-parseable marker line
//
//   SCRIPTED_RUN_REGISTRATION_FAILED: <daemon error>
//
// (US-005 reclassifies cells whose stderr carries that marker instead of a
// generic local-command-failed PRODUCT_FAIL.)
//
// Fallback: when the row has scheduling_status='error' but scheduling_error
// is empty (log-first write ordering or an older daemon), tail the
// state-dir tamandua.log for the last 'control-server: register-run failed'
// block and capture its `error` field.
//
// Confined to torture-test/. Zero tokens, no daemon control, no live state:
// the helper only READS the contained scripted state dir derived from
// dbPath (<stateDir>/tamandua.db) and never starts or stops anything.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);
const REGISTER_FAILED_LOG_SUBSTR = "control-server: register-run failed";
const REGISTRATION_FAILED_MARKER = "SCRIPTED_RUN_REGISTRATION_FAILED";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// normalizeRunId — the CLI prints "Run: run-<uuid>" but the runs table stores
// the id WITHOUT the "run-" prefix; accept either shape so callers can pass
// the launch output's id verbatim.
function normalizeRunId(runId) {
  return runId.startsWith("run-") ? runId.slice(4) : runId;
}

// tailRegisterFailedError(logPath) — read the state-dir tamandua.log (the
// product caps it at 5MB with rotation, so reading it whole is cheap) and
// return the `error` field of the LAST 'control-server: register-run failed'
// line, or the raw line when the JSON field is unavailable or empty.
// Returns null when the log is missing/unreadable or no such line exists.
function tailRegisterFailedError(logPath) {
  let text;
  try {
    text = fs.readFileSync(logPath, "utf8");
  } catch {
    return null; // log missing/unreadable — nothing to capture
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes(REGISTER_FAILED_LOG_SUBSTR)) continue;
    const jsonStart = line.indexOf("{");
    if (jsonStart !== -1) {
      try {
        const parsed = JSON.parse(line.slice(jsonStart));
        if (parsed && typeof parsed.error === "string" && parsed.error.trim() !== "") {
          return parsed.error;
        }
      } catch {
        // fall through to the raw line
      }
    }
    return line.trim().slice(0, 2000);
  }
  return null;
}

// waitForTerminalRun(options) — poll the runs row for a terminal status,
// failing IMMEDIATELY (well under the poll budget) when the register-run
// failure class is detected:
//
//   options.dbPath    — path to the contained scripted tamandua.db
//   options.runId     — run id as printed by `workflow run` ("run-<uuid>")
//                       or as stored in the db (uuid without the prefix)
//   options.timeoutMs — overall poll budget (default 120_000, the W2 budget)
//   options.pollMs    — poll interval (default 1000)
//
// Returns the terminal status string ("completed" | "failed" | "canceled").
// Throws an Error whose message is exactly
//   SCRIPTED_RUN_REGISTRATION_FAILED: <daemon error>
// for the register-run failure class (the marker line is ALSO written to
// stderr verbatim so captured scenario stderr carries it for US-005's
// classifier), and the usual did-not-reach-terminal message on timeout.
export async function waitForTerminalRun({
  dbPath,
  runId,
  timeoutMs = 120_000,
  pollMs = 1000,
}) {
  const dbRunId = normalizeRunId(runId);
  const stateDir = path.dirname(dbPath);
  const logPath = path.join(stateDir, "tamandua.log");
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let row;
    try {
      row = db
        .prepare(
          "SELECT status, scheduling_status, scheduling_error FROM runs WHERE id = ?",
        )
        .get(dbRunId);
    } finally {
      db.close();
    }

    if (row) {
      if (row.scheduling_status === "error") {
        const captured =
          row.scheduling_error && row.scheduling_error.trim() !== ""
            ? row.scheduling_error
            : tailRegisterFailedError(logPath);
        const detail =
          captured && captured.trim() !== ""
            ? captured
            : `scheduling_status='error' (register-run failure class) but scheduling_error was empty and no '${REGISTER_FAILED_LOG_SUBSTR}' line was found in ${logPath}`;
        const markerLine = `${REGISTRATION_FAILED_MARKER}: ${detail.replace(/\r?\n/g, " ")}`;
        // Emit the marker as a clean stderr line so the scenario's captured
        // stderr carries it verbatim, then throw with the same message.
        process.stderr.write(`${markerLine}\n`);
        throw new Error(markerLine);
      }
      if (TERMINAL_STATUSES.has(row.status)) {
        return row.status;
      }
    }

    await sleep(pollMs);
  }

  throw new Error(`run ${runId} did not reach terminal state within ${timeoutMs}ms`);
}
