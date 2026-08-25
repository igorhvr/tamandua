// MACP7 US-004 — terminal-wait helper hermetic unit test.
//
// Pins the shared waitForTerminalRun helper (scenarios/lib/terminal-wait.mjs),
// the loud registration-collision failure surface for the scripted W2 cells:
//   * scheduling_status='error' with scheduling_error FAILS IMMEDIATELY (far
//     under the 120s poll budget) with the machine-parseable marker line
//     `SCRIPTED_RUN_REGISTRATION_FAILED: <captured daemon error>` — the
//     register-run failure class ("harness workdir is already set"),
//     NOT a generic did-not-reach-terminal timeout.
//   * scheduling_status='error' with EMPTY scheduling_error falls back to
//     tailing the state-dir tamandua.log for the last
//     'control-server: register-run failed' block and captures its error.
//   * the error class wins even when the row also carries a terminal status
//     (the register-run failure is the loud, distinct outcome).
//   * the normal terminal path is unchanged: completed/failed/canceled return
//     the terminal status, including when the row only becomes terminal on a
//     LATER poll (the loop actually polls).
//   * a run that never reaches terminal nor error still fails with the usual
//     did-not-reach-terminal timeout message.
//   * the runId may carry the CLI's "run-" prefix (normalized to the db id).
//
// Hermetic: each case gets a scratch SQLite DB in a fresh temp dir; the log
// fallback writes a synthetic state-dir tamandua.log next to the db. Zero
// tokens, no daemon, no live state. Picked up by self-tests/run.sh's
// `tier0-*.test.ts` glob.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";

import { waitForTerminalRun } from "../scenarios/lib/terminal-wait.mjs";

const TERMINAL_BUDGET_MS = 120_000; // the W2 cells' poll budget
const MARKER = "SCRIPTED_RUN_REGISTRATION_FAILED";

let tmpRoot: string;
let scratchDbs: string[] = [];

function scratchStateDir(): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "tt-terminal-wait-"));
  return dir;
}

function makeDb(stateDir: string): string {
  const dbPath = path.join(stateDir, "tamandua.db");
  const db = new DatabaseSync(dbPath);
  db.exec(
    "CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT, scheduling_status TEXT, scheduling_error TEXT)",
  );
  db.close();
  scratchDbs.push(dbPath);
  return dbPath;
}

function insertRun(dbPath: string, row: {
  id: string;
  status: string;
  scheduling_status: string | null;
  scheduling_error: string | null;
}): void {
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO runs (id, status, scheduling_status, scheduling_error) VALUES (?, ?, ?, ?)",
  ).run(row.id, row.status, row.scheduling_status, row.scheduling_error);
  db.close();
}

async function elapsedMsAsync(fn: () => Promise<unknown>): Promise<{ value: unknown; ms: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - start };
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tt-terminal-wait-root-"));
});

after(() => {
  for (const dbPath of scratchDbs) {
    try {
      fs.unlinkSync(dbPath);
    } catch {
      // already gone — fine
    }
  }
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("waitForTerminalRun — MACP7 US-004 loud registration-collision failure", () => {
  it("fails IMMEDIATELY with the marker + captured daemon error when scheduling_status='error'", async () => {
    const dbPath = makeDb(scratchStateDir());
    const storedId = "abc123-def456";
    const daemonError =
      "Run abc123-def456 harness workdir is already scheduled for run e2589c60: /repo/torture-test/var/w2";
    insertRun(dbPath, {
      id: storedId,
      status: "running",
      scheduling_status: "error",
      scheduling_error: daemonError,
    });

    let thrown: Error | undefined;
    const { ms } = await elapsedMsAsync(async () => {
      try {
        await waitForTerminalRun({
          dbPath,
          runId: storedId,
          timeoutMs: TERMINAL_BUDGET_MS,
          pollMs: 1000,
        });
      } catch (err) {
        thrown = err as Error;
      }
    });

    assert.ok(thrown, "expected the helper to throw on scheduling_status='error'");
    assert.match(thrown.message, new RegExp(`^${MARKER}: `),
      "the thrown message must carry the machine-parseable marker line");
    assert.ok(thrown.message.includes(daemonError),
      `the thrown message must capture the daemon error, got: ${thrown.message}`);
    assert.ok(thrown.message.includes("harness workdir is already scheduled"),
      "the captured error must be the register-run collision class");
    assert.ok(ms < 5000,
      `the helper must fail immediately (well under the ${TERMINAL_BUDGET_MS}ms budget), took ${ms}ms`);
  });

  it("normalizes a 'run-' prefixed runId to the db id", async () => {
    const dbPath = makeDb(scratchStateDir());
    const storedId = "def456-abc123";
    insertRun(dbPath, {
      id: storedId,
      status: "running",
      scheduling_status: "error",
      scheduling_error: "collision!",
    });

    const { value } = await elapsedMsAsync(async () => {
      try {
        await waitForTerminalRun({
          dbPath,
          runId: `run-${storedId}`,
          timeoutMs: TERMINAL_BUDGET_MS,
          pollMs: 1000,
        });
        return "no-throw";
      } catch (err) {
        return (err as Error).message;
      }
    });

    assert.ok(typeof value === "string" && value.startsWith(`${MARKER}: collision!`),
      `expected marker with the error for the prefixed id, got: ${String(value)}`);
  });

  it("falls back to tailing the state-dir tamandua.log when scheduling_error is empty", async () => {
    const stateDir = scratchStateDir();
    const dbPath = makeDb(stateDir);
    const storedId = "logfallback-001";
    const logError =
      "Run logfallback-001 harness workdir is already scheduled for run stale-run-9: /repo/torture-test/var/w2";
    // A synthetic state-dir log: an older line without the error class, then
    // the LAST 'control-server: register-run failed' block for our run.
    fs.writeFileSync(
      path.join(stateDir, "tamandua.log"),
      [
        '[2026-08-24 00:00:01] INFO  control-server: register-run admitted {"runId":"some-other-run","requiredTimers":1}',
        `[2026-08-24 00:00:02] ERROR control-server: register-run failed {"runId":"${storedId}","error":"${logError}"}`,
        "",
      ].join("\n"),
      "utf8",
    );
    insertRun(dbPath, {
      id: storedId,
      status: "running",
      scheduling_status: "error",
      scheduling_error: null,
    });

    let thrown: Error | undefined;
    await elapsedMsAsync(async () => {
      try {
        await waitForTerminalRun({
          dbPath,
          runId: storedId,
          timeoutMs: TERMINAL_BUDGET_MS,
          pollMs: 1000,
        });
      } catch (err) {
        thrown = err as Error;
      }
    });

    assert.ok(thrown, "expected the helper to throw via the log-tail fallback");
    assert.match(thrown.message, new RegExp(`^${MARKER}: `));
    assert.ok(thrown.message.includes(logError),
      `the log-tail fallback must capture the daemon error, got: ${thrown.message}`);
  });

  it("the error class wins even when the row also carries a terminal status", async () => {
    const dbPath = makeDb(scratchStateDir());
    const storedId = "both-0001";
    insertRun(dbPath, {
      id: storedId,
      status: "failed",
      scheduling_status: "error",
      scheduling_error: "register-run failed: harness workdir is already scheduled",
    });

    let thrown: Error | undefined;
    await elapsedMsAsync(async () => {
      try {
        await waitForTerminalRun({
          dbPath,
          runId: storedId,
          timeoutMs: TERMINAL_BUDGET_MS,
          pollMs: 1000,
        });
      } catch (err) {
        thrown = err as Error;
      }
    });

    assert.ok(thrown, "the register-run error class must surface loudly even on a terminal row");
    assert.match(thrown.message, new RegExp(`^${MARKER}: `));
  });

  it("returns the terminal status on the normal path (completed/failed/canceled)", async () => {
    for (const terminal of ["completed", "failed", "canceled"]) {
      const dbPath = makeDb(scratchStateDir());
      const storedId = `normal-${terminal}`;
      insertRun(dbPath, {
        id: storedId,
        status: terminal,
        scheduling_status: "active",
        scheduling_error: null,
      });

      const { value, ms } = await elapsedMsAsync(async () =>
        waitForTerminalRun({
          dbPath,
          runId: storedId,
          timeoutMs: TERMINAL_BUDGET_MS,
          pollMs: 1000,
        }),
      );
      assert.equal(value, terminal, `expected terminal status ${terminal}`);
      assert.ok(ms < 5000, `normal terminal return must be prompt, took ${ms}ms`);
    }
  });

  it("keeps polling until the run becomes terminal on a later poll", async () => {
    const dbPath = makeDb(scratchStateDir());
    const storedId = "late-terminal";
    insertRun(dbPath, {
      id: storedId,
      status: "running",
      scheduling_status: "active",
      scheduling_error: null,
    });
    // Flip the row to completed after ~300ms; with pollMs=100 the helper must
    // see it on a later poll and return, not time out.
    const flipper = setTimeout(() => {
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE runs SET status = 'completed' WHERE id = ?").run(storedId);
      db.close();
    }, 300);

    try {
      const { value, ms } = await elapsedMsAsync(async () =>
        waitForTerminalRun({
          dbPath,
          runId: storedId,
          timeoutMs: TERMINAL_BUDGET_MS,
          pollMs: 100,
        }),
      );
      assert.equal(value, "completed");
      assert.ok(ms >= 200 && ms < 5000,
        `expected the helper to observe the later terminal transition, took ${ms}ms`);
    } finally {
      clearTimeout(flipper);
    }
  });

  it("still times out with the usual did-not-reach-terminal message when the run never settles", async () => {
    const dbPath = makeDb(scratchStateDir());
    const storedId = "stuck-forever";
    insertRun(dbPath, {
      id: storedId,
      status: "running",
      scheduling_status: "active",
      scheduling_error: null,
    });

    let thrown: Error | undefined;
    const { ms } = await elapsedMsAsync(async () => {
      try {
        await waitForTerminalRun({
          dbPath,
          runId: `run-${storedId}`,
          timeoutMs: 400,
          pollMs: 100,
        });
      } catch (err) {
        thrown = err as Error;
      }
    });

    assert.ok(thrown, "expected a timeout throw for a never-settling run");
    assert.match(thrown.message, /did not reach terminal state within 400ms/,
      `expected the usual did-not-reach-terminal timeout, got: ${thrown.message}`);
    assert.ok(ms >= 400, `the timeout must respect the budget, took ${ms}ms`);
  });
});
