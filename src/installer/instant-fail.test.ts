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
  isPreclaimDeathRound,
  resolveHarnessWallMs,
  instantFailBackoffDelayMs,
  formatInstantFailReason,
  formatPreclaimDeathReason,
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
  harnessWallMs?: number;
  vmSetupMs?: number;
}

/**
 * A fake in-VM runner round (Matchlock seam): reports the harness PROCESS
 * time (`harnessWallMs`, guest exec→exit) and the VM setup time
 * (`vmSetupMs`) separately. The whole-round wall used as the fallback is the
 * sum — VM setup is folded into the fallback ONLY, never into harnessWallMs.
 */
function fakeRunner(
  signals: { harnessWallMs?: number; vmSetupMs?: number },
  resultOverrides: Partial<RoundResultLike> = {},
): { wallMs: number; harnessWallMs?: number; result: RoundResultLike } {
  const vmSetupMs = signals.vmSetupMs ?? 0;
  const harnessWallMs = signals.harnessWallMs;
  return {
    wallMs: (harnessWallMs ?? 0) + vmSetupMs,
    harnessWallMs,
    result: roundResult({ harnessWallMs, vmSetupMs, ...resultOverrides }),
  };
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

  it("default thresholds are conservative (6s wall, K=6 backoff, N=20 escalation)", () => {
    assert.equal(DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS, 6_000);
    assert.equal(DEFAULT_INSTANT_FAIL_BACKOFF_THRESHOLD, 6);
    assert.equal(DEFAULT_INSTANT_FAIL_ESCALATION_THRESHOLD, 20);
    assert.equal(DEFAULT_INSTANT_FAIL_BACKOFF_BASE_MS, 30_000);
  });

  it("returns the 6s default when the wall override is unset", () => {
    delete process.env.TAMANDUA_INSTANT_FAIL_WALL_MS;
    assert.equal(getInstantFailWallThresholdMs(), 6_000);
  });

  it("classifies a 3000ms zero-output nonzero-exit round by default, not a 7000ms one", () => {
    // The outage-rounds boundary: a provider refusal that dies after a
    // network round trip (~3s) must join the instant-fail backoff, while a
    // slow 7s round must not be classified as instant.
    assert.equal(
      isInstantFailRound({
        wallMs: 3_000,
        result: roundResult({ output: "", exitCode: 1 }),
      }),
      true,
      "a 3000ms zero-output exit-1 round must classify under the 6000ms default",
    );
    assert.equal(
      isInstantFailRound({
        wallMs: 7_000,
        result: roundResult({ output: "", exitCode: 1 }),
      }),
      false,
      "a 7000ms round is at/above the 6000ms default and must NOT classify",
    );
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

describe("harness-wall-time classification seam (harnessWallMs / vmSetupMs)", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("resolveHarnessWallMs prefers harnessWallMs, falls back to roundWallMs, else undefined", () => {
    assert.equal(
      resolveHarnessWallMs({ harnessWallMs: 1_000, roundWallMs: 61_000 }),
      1_000,
      "the harness PROCESS time must win over whole-round wall time",
    );
    assert.equal(
      resolveHarnessWallMs({ roundWallMs: 5_000 }),
      5_000,
      "no harnessWallMs must fall back to the round wall time",
    );
    assert.equal(
      resolveHarnessWallMs({}),
      undefined,
      "no duration signal at all must stay undefined (no fabricated 0)",
    );
  });

  it("classifies an in-VM round on harnessWallMs, EXCLUDING a long VM setup", () => {
    // A Matchlock runner whose VM boot took 60s but whose in-guest harness
    // round was a 1s zero-output exit-1 refusal. The whole-round wall (61s)
    // would never classify; the harness wall (1s) must.
    const runner = fakeRunner(
      { vmSetupMs: 60_000, harnessWallMs: 1_000 },
      { output: "", exitCode: 1 },
    );
    assert.equal(runner.wallMs, 61_000, "sanity: whole-round wall includes VM setup");
    assert.equal(
      isInstantFailRound({
        wallMs: runner.wallMs,
        harnessWallMs: runner.harnessWallMs,
        result: runner.result,
      }),
      true,
      "VM setup must be excluded — a 1s in-guest refusal classifies even after 60s of setup",
    );
  });

  it("does NOT classify when the harness itself ran past the threshold", () => {
    // Same fake-runner shape, but the harness process ran 7s: slow in-guest
    // work is not an instant fail even though the VM setup (0 here) is small.
    const runner = fakeRunner(
      { harnessWallMs: 7_000 },
      { output: "", exitCode: 1 },
    );
    assert.equal(
      isInstantFailRound({
        wallMs: runner.wallMs,
        harnessWallMs: runner.harnessWallMs,
        result: runner.result,
      }),
      false,
      "a harness round at/above the wall threshold must NOT classify",
    );
  });

  it("keeps the old whole-round behavior when no harnessWallMs is reported", () => {
    // No runner seam available: the fallback round wall governs, so a round
    // that only looks fast because VM setup is absent still classifies, and
    // one dominated by setup does not.
    assert.equal(
      isInstantFailRound({
        wallMs: 100,
        result: roundResult({ output: "", exitCode: 1 }),
      }),
      true,
    );
    assert.equal(
      isInstantFailRound({
        wallMs: 61_000,
        result: roundResult({ output: "", exitCode: 1, harnessWallMs: undefined, vmSetupMs: 60_000 }),
      }),
      false,
      "without a harnessWallMs signal the whole-round wall (61s) is used",
    );
  });

  it("adapter-throw rounds fall back to the monotonic round elapsed time", () => {
    // Adapter throws never produce a HarnessRoundResult, hence no
    // harnessWallMs: the caller passes the monotonic round elapsed as wallMs
    // and the predicate must still classify fast launch failures.
    assert.equal(
      isInstantFailRound({ wallMs: 100, harnessWallMs: undefined, adapterThrew: true }),
      true,
      "a fast adapter throw with no harnessWallMs must fall back to wallMs",
    );
    assert.equal(
      isInstantFailRound({ wallMs: 61_000, harnessWallMs: undefined, adapterThrew: true }),
      false,
      "a slow adapter throw with no harnessWallMs must fall back to wallMs",
    );
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
    assert.match(reason, /^worker instant-fail loop: 20 consecutive sub-6s exit-1 rounds; last command: pi --print/);
  });

  it("falls back to 'unknown' when no last command is available", () => {
    assert.match(formatInstantFailReason(20), /last command: unknown$/);
  });
});

describe("pre-claim death loop reason (OUTAGE-ROUNDS SCLS US-005)", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("formats a distinct reason naming the slow claim-less shape and the wall threshold", () => {
    const reason = formatPreclaimDeathReason(20, "pi --print --mode json <prompt>");
    assert.match(
      reason,
      /^worker pre-claim death loop: 20 consecutive >=6s rounds that exited\/died without claiming a step; last command: pi --print/,
    );
    // Must be DISTINCT from the instant-fail reason so operators can tell the
    // slow claim-less death loop from the fast zero-output one.
    assert.notEqual(reason, formatInstantFailReason(20, "pi --print --mode json <prompt>"));
  });

  it("falls back to 'unknown' when no last command is available", () => {
    assert.match(formatPreclaimDeathReason(20), /last command: unknown$/);
  });

  it("derives the >=Ns label from the wall-threshold override", () => {
    saveEnv("TAMANDUA_INSTANT_FAIL_WALL_MS");
    process.env.TAMANDUA_INSTANT_FAIL_WALL_MS = "12000";
    assert.match(formatPreclaimDeathReason(7), /^worker pre-claim death loop: 7 consecutive >=12s rounds/);
  });
});

describe("pre-claim death classification (OUTAGE-ROUNDS SCLS US-004)", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("classifies a long nonzero-exit round with a pending unclaimed step", () => {
    assert.equal(
      isPreclaimDeathRound({
        wallMs: getInstantFailWallThresholdMs(),
        hasPendingStep: true,
        exitCode: 1,
      }),
      true,
      "at/above the threshold with a pending step and a nonzero exit is a pre-claim death",
    );
  });

  it("classifies a long signal-death round (no exit code, signal present)", () => {
    assert.equal(
      isPreclaimDeathRound({
        wallMs: getInstantFailWallThresholdMs() + 5_000,
        hasPendingStep: true,
        exitCode: null,
        signal: "SIGKILL",
      }),
      true,
      "a long signal-death with a pending unclaimed step is a pre-claim death",
    );
  });

  it("classifies on harness wall time, excluding VM setup", () => {
    // 61s whole round, 60s of which was VM boot: the in-guest harness ran
    // 1s (above a 500ms threshold) → pre-claim death. Folding setup into the
    // classified time would hide it.
    process.env.TAMANDUA_INSTANT_FAIL_WALL_MS = "500";
    assert.equal(
      isPreclaimDeathRound({
        wallMs: 61_000,
        harnessWallMs: 1_000,
        hasPendingStep: true,
        exitCode: 1,
      }),
      true,
      "harnessWallMs (VM setup excluded) is the classification signal",
    );
    // Converse: a fast in-guest harness below the threshold cannot be a
    // pre-claim death even when the whole round (VM boot) was long.
    assert.equal(
      isPreclaimDeathRound({
        wallMs: 61_000,
        harnessWallMs: 100,
        hasPendingStep: true,
        exitCode: 1,
      }),
      false,
      "a sub-threshold harness round is the instant-fail class, not pre-claim",
    );
  });

  it("does NOT classify sub-threshold rounds (instant-fail class)", () => {
    assert.equal(
      isPreclaimDeathRound({
        wallMs: getInstantFailWallThresholdMs() - 1,
        hasPendingStep: true,
        exitCode: 1,
      }),
      false,
    );
  });

  it("does NOT classify timed-out rounds (ceiling-expiry class)", () => {
    assert.equal(
      isPreclaimDeathRound({
        wallMs: getInstantFailWallThresholdMs() + 5_000,
        hasPendingStep: true,
        exitCode: null,
        signal: "SIGTERM",
        timedOut: true,
      }),
      false,
    );
  });

  it("does NOT classify operator-paused rounds", () => {
    assert.equal(
      isPreclaimDeathRound({
        wallMs: getInstantFailWallThresholdMs() + 5_000,
        hasPendingStep: true,
        exitCode: null,
        signal: "SIGTERM",
        operatorPaused: true,
      }),
      false,
    );
  });

  it("does NOT classify claimed-then-died rounds (worker_lost class)", () => {
    assert.equal(
      isPreclaimDeathRound({
        wallMs: getInstantFailWallThresholdMs() + 5_000,
        hasPendingStep: true,
        exitCode: 1,
        recoveredOrphans: true,
      }),
      false,
    );
  });

  it("does NOT classify long rounds with no pending unclaimed step", () => {
    assert.equal(
      isPreclaimDeathRound({
        wallMs: getInstantFailWallThresholdMs() + 5_000,
        hasPendingStep: false,
        exitCode: 1,
      }),
      false,
    );
  });

  it("does NOT classify clean long exits (exit 0)", () => {
    assert.equal(
      isPreclaimDeathRound({
        wallMs: getInstantFailWallThresholdMs() + 5_000,
        hasPendingStep: true,
        exitCode: 0,
      }),
      false,
    );
  });

  it("does NOT classify rounds with no exit code and no signal (adapter-throw shape)", () => {
    assert.equal(
      isPreclaimDeathRound({
        wallMs: getInstantFailWallThresholdMs() + 5_000,
        hasPendingStep: true,
        exitCode: undefined,
        signal: undefined,
      }),
      false,
    );
  });

  it("does NOT classify rounds with no duration signal", () => {
    assert.equal(
      isPreclaimDeathRound({ hasPendingStep: true, exitCode: 1 }),
      false,
    );
  });
});
