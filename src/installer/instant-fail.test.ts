/**
 * Instant-fail round classification boundaries (RSPN).
 *
 * The dispatch motor must classify an instant-fail round CONSERVATIVELY —
 * wall time below the threshold AND zero output bytes AND nonzero exit —
 * so legitimate short rounds (idle checks, no-op verifies, exit-0 rounds,
 * rounds that produce any output) never match, timed-out rounds (the
 * ceiling-expiry class) never match, and rounds whose worker had claimed
 * a step before dying (the worker_lost class) never match. These are the
 * exact boundaries the regression net pins; without them the 15s tick
 * respawns a broken harness forever with zero counters, zero backoff,
 * zero escalation.
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

  it("classifies exit-1 zero-output rounds with a null-exitCode signal-kill only when not timed out", () => {
    // Killed by a signal that is NOT the timeout guard: not a clean exit,
    // so it is not classified (no exit code signal at all).
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: null, signal: "SIGKILL" }),
      }),
      false,
      "signal-killed rounds carry no exit code and must not classify",
    );
  });

  it("default thresholds are conservative (2s wall, K=3 backoff, N=10 escalation)", () => {
    assert.equal(DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS, 2_000);
    assert.equal(DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD, 3);
    assert.equal(DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD, 10);
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
    const reason = formatInstantFailReason(10, "pi --print --mode json <prompt>");
    assert.match(reason, /^worker instant-fail loop: 10 consecutive sub-2s exit-1 rounds; last command: pi --print/);
  });

  it("falls back to 'unknown' when no last command is available", () => {
    assert.match(formatInstantFailReason(10), /last command: unknown$/);
  });
});
