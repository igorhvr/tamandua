/**
 * DIAG-PRUNE US-005 — unit tests for the daemon log collector.
 *
 * Pure filesystem fixtures under an isolated temp state dir (no daemon, no
 * child_process, no DB) — stays in the parallel lane. Every fixture writes
 * real `tamandua.log[.N]` files so the collector's rotation order, line
 * numbering, id matching and bound are exercised end to end.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  collectDaemonLog,
  DEFAULT_MAX_DAEMON_LOG_LINES,
} from "../../dist/diagnostics/collect-logs.js";

const BARE = "aaaaaaaa-1111-4111-8111-111111111111";
const OTHER = "bbbbbbbb-2222-4222-8222-222222222222";
const SHORT = BARE.slice(0, 8);

const created: string[] = [];

function makeState(prefix = "diag-logs-"): string {
  const dir = tamanduaTempDir(prefix);
  created.push(dir);
  return dir;
}

function writeLog(stateDir: string, name: string, content: string): string {
  const file = path.join(stateDir, name);
  fs.writeFileSync(file, content);
  return file;
}

/** A realistic daemon log line that carries the run id in its JSON extra. */
function logLine(runId: string, message: string): string {
  return `[2026-01-01 00:00:00Z] INFO  ${message} {"runId":"${runId}"}`;
}

after(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("collectDaemonLog", () => {
  it("matches the full run id across rotations oldest-to-newest with per-file line numbers", () => {
    const state = makeState();
    const oldest = writeLog(
      state,
      "tamandua.log.5",
      `${logLine(BARE, "oldest dispatch")}\n${logLine(OTHER, "unrelated")}\n`,
    );
    writeLog(state, "tamandua.log.3", `${logLine(OTHER, "unrelated")}\n`);    const rotated = writeLog(
      state,
      "tamandua.log.1",
      `${logLine(OTHER, "unrelated")}\n${logLine(BARE, "rotated dispatch")}\n`,
    );
    const current = writeLog(state, "tamandua.log", `${logLine(BARE, "current dispatch")}\n`);

    const result = collectDaemonLog({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "present");
    assert.equal(result.truncated, false);
    assert.deepEqual(
      result.entries.map((entry) => entry.text),
      [logLine(BARE, "oldest dispatch"), logLine(BARE, "rotated dispatch"), logLine(BARE, "current dispatch")],
    );
    assert.deepEqual(
      result.entries.map((entry) => entry.file),
      [oldest, rotated, current],
    );
    assert.deepEqual(
      result.entries.map((entry) => entry.line),
      [1, 2, 1],
    );
    assert.deepEqual(
      result.files,
      [
        { path: oldest, status: "present", lines: 1 },
        { path: path.join(state, "tamandua.log.3"), status: "present", lines: 0 },
        { path: rotated, status: "present", lines: 1 },
        { path: current, status: "present", lines: 1 },
      ],
    );
  });

  it("matches the 8-char short id and a run- prefixed selector without mutating sources", () => {
    const state = makeState();
    const current = writeLog(
      state,
      "tamandua.log",
      `[2026-01-01 00:00:00Z] INFO  short prefix [run-${SHORT}] dispatched\n${logLine(OTHER, "unrelated")}\n`,
    );
    const before = fs.readFileSync(current);

    const shortResult = collectDaemonLog({ stateDir: state, runId: SHORT });
    const prefixedResult = collectDaemonLog({ stateDir: state, bareRunId: `run-${BARE}` });

    assert.equal(shortResult.status, "present");
    assert.equal(shortResult.entries.length, 1);
    assert.equal(prefixedResult.status, "present");
    assert.equal(prefixedResult.entries.length, 1);
    assert.deepEqual(fs.readFileSync(current), before);
  });

  it("caps retained lines at maxLines, keeps the most recent and flags truncation", () => {
    const state = makeState();
    writeLog(state, "tamandua.log.1", `${logLine(BARE, "old match")}\n`);
    writeLog(state, "tamandua.log", `${logLine(BARE, "new match")}\n`);

    const result = collectDaemonLog({ stateDir: state, bareRunId: BARE, maxLines: 1 });

    assert.equal(result.truncated, true);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].text, logLine(BARE, "new match"));
    assert.equal(result.entries[0].file, path.join(state, "tamandua.log"));
  });

  it("honours maxLines: 0 by retaining nothing but flagging the match", () => {
    const state = makeState();
    writeLog(state, "tamandua.log", `${logLine(BARE, "match")}\n`);

    const result = collectDaemonLog({ stateDir: state, bareRunId: BARE, maxLines: 0 });

    assert.equal(result.truncated, true);
    assert.deepEqual(result.entries, []);
    assert.equal(result.status, "empty");
  });

  it("reports 'absent' with a reason when no daemon log files exist", () => {
    const state = makeState();

    const result = collectDaemonLog({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "absent");
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.files, []);
    assert.equal(result.truncated, false);
    assert.match(result.absenceReason ?? "", /no daemon log files present/);
  });

  it("reports 'empty' when logs exist but hold no matching line", () => {
    const state = makeState();
    writeLog(state, "tamandua.log", `${logLine(OTHER, "unrelated")}\n`);

    const result = collectDaemonLog({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "empty");
    assert.deepEqual(result.entries, []);
    assert.equal(result.files.length, 1);
  });

  it("never throws when a candidate path is not a regular file", () => {
    const state = makeState();
    // A directory sitting where a rotated log would be is skipped, not thrown.
    fs.mkdirSync(path.join(state, "tamandua.log.1"));

    const result = collectDaemonLog({ stateDir: state, bareRunId: BARE });

    assert.equal(result.status, "absent");
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.files, []);
  });

  it("defaults the retained line bound to DEFAULT_MAX_DAEMON_LOG_LINES", () => {
    assert.equal(DEFAULT_MAX_DAEMON_LOG_LINES, 5000);

    const state = makeState();
    const lines: string[] = [];
    for (let i = 0; i < DEFAULT_MAX_DAEMON_LOG_LINES + 1; i++) {
      lines.push(logLine(BARE, `match ${i}`));
    }
    writeLog(state, "tamandua.log", `${lines.join("\n")}\n`);

    const result = collectDaemonLog({ stateDir: state, bareRunId: BARE });

    assert.equal(result.truncated, true);
    assert.equal(result.entries.length, DEFAULT_MAX_DAEMON_LOG_LINES);
    assert.match(result.entries[result.entries.length - 1].text, /match 5000/);
  });
});