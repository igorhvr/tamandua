/**
 * Instant-fail round classification boundaries (RSPN).
 *
 * The dispatch motor must classify an instant-fail round CONSERVATIVELY —
 * wall time below the threshold AND zero TRIMMED output bytes AND nonzero
 * exit (or signal-death) — so legitimate short rounds (idle checks,
 * no-op verifies, exit-0 rounds, rounds that produce any real output)
 * never match, timed-out rounds (the ceiling-expiry class) never match,
 * and rounds whose worker had claimed a step before dying (the
 * worker_lost class) never match. Output is measured TRIMMED because a
 * lone trailing newline (the dsh MISSING_CREDENTIAL shape) cannot carry a
 * STATUS marker, and signal-death rounds (killed sub-threshold with no
 * output) classify like nonzero exits. These are the exact boundaries the
 * regression net pins; without them the 15s tick respawns a broken
 * harness forever with zero counters, zero backoff, zero escalation.
 */
import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

import {
  isInstantFailRound,
  instantFailBackoffDelayMs,
  formatInstantFailReason,
  getInstantFailWallThresholdMs,
  getInstantFailBackoffThreshold,
  getInstantFailEscalationThreshold,
  getInstantFailBackoffBaseMs,
  DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS,
  DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD,
  DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD,
  DEFAULT_INSTANT_FAIL_BACKOFF_BASE_MS,
} from "../../dist/installer/instant-fail.js";
// Cross-module guard (PRAW US-004): the outcome classifier's `empty_output`
// label must never be wired into the instant-fail detector. Importing the
// pure classifier (not the spawning dispatch path) keeps this test in the
// parallel lane — see tests/serial-classification-guard.test.ts.
import { classifyWorkRoundOutcome } from "../../dist/installer/agent-scheduler.js";

// Local structural stand-in for HarnessRoundResult — deliberately NOT
// imported from harness-adapter (which imports node:child_process and
// would drag this pure test into the serial lane).
interface RoundResultLike {
  output: string;
  stderrTail: string;
  exitCode?: number | null;
  signal?: string;
  timedOut?: boolean;
}

const saved = new Map<string, string | undefined>();
function saveEnv(name: string): void {
  saved.set(name, process.env[name]);
}
function restoreEnv(): void {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
}

function roundResult(overrides: Partial<RoundResultLike> = {}): RoundResultLike {
  return {
    output: "",
    stderrTail: "",
    exitCode: 1,
    ...overrides,
  };
}

describe("instant-fail classification boundaries (RSPN)", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("classifies fast + zero output + nonzero exit as an instant fail", () => {
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: 1 }),
      }),
      true,
      "a sub-threshold zero-output exit-1 round must classify as instant fail",
    );
  });

  it("does NOT classify fast rounds that exit 0 (idle checks / no-op verifies)", () => {
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: 0 }),
      }),
      false,
      "fast + exit 0 must NOT classify (legitimate short round)",
    );
  });

  it("does NOT classify fast rounds that produced output", () => {
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "some output", exitCode: 1 }),
      }),
      false,
      "fast + exit 1 + output must NOT classify",
    );
  });

  it("does NOT classify slow rounds even when they exit nonzero with zero output", () => {
    assert.equal(
      isInstantFailRound({
        wallMs: getInstantFailWallThresholdMs() + 1000,
        result: roundResult({ output: "", exitCode: 1 }),
      }),
      false,
      "slow + exit 1 + zero output must NOT classify",
    );
  });

  it("does NOT classify rounds with no duration signal", () => {
    assert.equal(
      isInstantFailRound({ result: roundResult({ output: "", exitCode: 1 }) }),
      false,
      "no wallMs must NOT classify — there is no duration signal to classify on",
    );
  });

  it("does NOT classify timed-out rounds (ceiling-expiry class)", () => {
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: null, signal: "SIGTERM", timedOut: true }),
      }),
      false,
      "timedOut rounds belong to the ceiling-expiry class, never instant-fail",
    );
  });

  it("classifies fast adapter-throw rounds (broken/deleted harness binary)", () => {
    assert.equal(
      isInstantFailRound({ wallMs: 100, adapterThrew: true }),
      true,
      "a launch failure within the wall threshold must classify as instant fail",
    );
  });

  it("does NOT classify slow adapter-throw rounds", () => {
    assert.equal(
      isInstantFailRound({ wallMs: getInstantFailWallThresholdMs() + 1000, adapterThrew: true }),
      false,
      "a slow adapter throw is not an instant fail",
    );
  });

  it("does NOT classify rounds whose worker had claimed a step (worker_lost class)", () => {
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: 1 }),
        recoveredOrphans: true,
      }),
      false,
      "a claimed-then-died round is worker_lost (WLST5), never instant-fail",
    );
  });

  it("classifies signal-death rounds (no exit code, signal present, zero trimmed output)", () => {
    // Killed by a signal that is NOT the timeout guard: no exit code at
    // all, zero output, sub-threshold wall — a SIGKILL/OOM loop is an
    // instant fail, not a legitimate round. (Timed-out rounds carry
    // timedOut: true and stay unclassified — pinned above.)
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: null, signal: "SIGKILL" }),
      }),
      true,
      "a signal-death round with zero output must classify as instant fail",
    );
  });

  it("classifies the dsh MISSING_CREDENTIAL shape: lone trailing newline + exit 1", () => {
    // dsh prints a lone trailing newline even when aborting — output "\n"
    // is 1 untrimmed byte but trims to 0, so it cannot carry a STATUS
    // marker and must classify like a zero-output round.
    assert.equal(
      isInstantFailRound({
        wallMs: 490,
        result: roundResult({ output: "\n", exitCode: 1 }),
      }),
      true,
      'output "\\n" + exit 1 must classify (trimmed-output shape)',
    );
  });

  it("classifies whitespace-only output (tabs/newlines/spaces) as zero output", () => {
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: " \n\t  \r\n", exitCode: 1 }),
      }),
      true,
      "whitespace-only stdout cannot carry a STATUS marker — must classify",
    );
  });

  it("does NOT classify fast rounds whose trimmed output carries real content", () => {
    // Real (non-whitespace) output — even a lone STATUS marker — means the
    // worker produced output, so the round is not an instant fail.
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "STATUS: done", exitCode: 1 }),
      }),
      false,
      "rounds with real output must NOT classify even when exit code is nonzero",
    );
  });

  it("default thresholds are conservative (2s wall, K=6 backoff, N=20 escalation)", () => {
    assert.equal(DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS, 2_000);
    assert.equal(DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD, 6);
    assert.equal(DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD, 20);
    assert.equal(DEFAULT_INSTANT_FAIL_BACKOFF_BASE_MS, 30_000);
  });

  it("env overrides adjust the thresholds", () => {
    process.env.TAMANDUA_INSTANT_FAIL_WALL_MS = "500";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "2";
    process.env.TAMANDUA_INSTANT_FAIL_ESCALATION_N = "4";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_BASE_MS = "1234";
    assert.equal(getInstantFailWallThresholdMs(), 500);
    assert.equal(getInstantFailBackoffThreshold(), 2);
    assert.equal(getInstantFailEscalationThreshold(), 4);
    assert.equal(getInstantFailBackoffBaseMs(), 1234);
    // Boundary now moves with the override.
    assert.equal(isInstantFailRound({ wallMs: 400, result: roundResult({ exitCode: 1 }) }), true);
    assert.equal(isInstantFailRound({ wallMs: 600, result: roundResult({ exitCode: 1 }) }), false);
  });

  it("invalid env overrides fall back to defaults", () => {
    process.env.TAMANDUA_INSTANT_FAIL_WALL_MS = "not-a-number";
    process.env.TAMANDUA_INSTANT_FAIL_BACKOFF_K = "-3";
    assert.equal(getInstantFailWallThresholdMs(), DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS);
    assert.equal(getInstantFailBackoffThreshold(), DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD);
  });
});

describe("empty_output rounds cannot feed the instant-fail detector (PRAW US-004)", () => {
  // The RSPN instant-fail classifier is deliberately CONSERVATIVE: it needs
  // sub-threshold wall time AND zero TRIMMED output AND (nonzero exit code OR
  // signal death). An `empty_output` work round (a JSON round with no
  // assistant text) is a clean, exit-0 round, so it is structurally excluded
  // on two independent signals. These tests pin the boundary so a future
  // regression cannot wire `classifyWorkRoundOutcome(...) === "empty_output"`
  // into `isInstantFailRound` and start force-failing legitimate no-text
  // rounds (the run-49 shape).
  afterEach(() => {
    restoreEnv();
  });

  it("does NOT classify a long zero-output exit-0 round (the empty_output shape)", () => {
    const threshold = getInstantFailWallThresholdMs();
    assert.equal(
      isInstantFailRound({
        wallMs: threshold + 1_000,
        result: roundResult({ output: "", exitCode: 0 }),
      }),
      false,
      "a long, clean (exit 0), no-output round is empty_output — never an instant fail",
    );
  });

  it("does NOT classify a round whose wall time sits exactly on the threshold", () => {
    // `isInstantFailRound` excludes `wallMs >= threshold`; pin the >= boundary
    // so an off-by-one loosening cannot let a long empty_output round through.
    assert.equal(
      isInstantFailRound({
        wallMs: getInstantFailWallThresholdMs(),
        result: roundResult({ output: "", exitCode: 0 }),
      }),
      false,
      "wallMs === threshold must NOT classify (slow-round guard is inclusive)",
    );
  });

  it("does NOT classify a short zero-output exit-0 round", () => {
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: 0 }),
      }),
      false,
      "a fast exit-0 round is a legitimate no-op, not an instant fail",
    );
  });

  it("still classifies the sub-threshold zero-output nonzero-exit round (unchanged positive)", () => {
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: 1 }),
      }),
      true,
      "the existing RSPN positive case must remain unchanged",
    );
  });

  it("documents that empty_output is independent of isInstantFailRound", () => {
    // The outcome label and the instant-fail verdict are computed from
    // different signals. A long exit-0 no-text round is empty_output AND is
    // not an instant fail, so the label can never be the trigger.
    assert.equal(classifyWorkRoundOutcome(""), "empty_output");
    assert.equal(
      isInstantFailRound({
        wallMs: getInstantFailWallThresholdMs() + 5_000,
        result: roundResult({ output: "", exitCode: 0 }),
      }),
      false,
    );

    // The converse wiring is also impossible: a sub-threshold exit-1 no-output
    // round is empty_output too, yet the detector's `true` comes from the
    // nonzero exit code, not from the outcome label.
    assert.equal(classifyWorkRoundOutcome(""), "empty_output");
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: 1 }),
      }),
      true,
      "the detector keys on exit/signal/wall time — never on the outcome label",
    );
  });
});

describe("instant-fail backoff delays and reason (RSPN)", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("returns zero delay below the backoff threshold K", () => {
    const k = getInstantFailBackoffThreshold();
    assert.equal(instantFailBackoffDelayMs(k - 1), 0);
  });

  it("escalates: base at K, 2x at K+1, 4x at K+2 and beyond", () => {
    const k = getInstantFailBackoffThreshold();
    const base = getInstantFailBackoffBaseMs();
    assert.equal(instantFailBackoffDelayMs(k), base);
    assert.equal(instantFailBackoffDelayMs(k + 1), base * 2);
    assert.equal(instantFailBackoffDelayMs(k + 2), base * 4);
    assert.equal(instantFailBackoffDelayMs(k + 100), base * 4, "delay caps at 4x base");
  });

  it("formats the precise force-fail reason with the wall threshold and last command", () => {
    const reason = formatInstantFailReason(20, "pi --print --mode json <prompt>");
    assert.match(reason, /^worker instant-fail loop: 20 consecutive sub-2s exit-1 rounds; last command: pi --print/);
  });

  it("falls back to 'unknown' when no last command is available", () => {
    assert.match(formatInstantFailReason(20), /last command: unknown$/);
  });
});
