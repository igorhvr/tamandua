/**
 * round-timing.test.ts — US-006 (parallel lane; pure logic, no VM/subprocess).
 *
 * A FAKE in-VM runner drives the shared {@link MatchlockRoundTiming} tracker
 * with an INJECTED monotonic clock, so the timing split is proven
 * deterministically without a real VM:
 *
 *   - `harnessWallMs` is the guest exec → exit interval and NEVER includes
 *     the pre-exec VM setup;
 *   - `vmSetupMs` carries the create/boot → harness-exec interval;
 *   - `durationMs` stays the whole-round wall time (admission → teardown);
 *   - an aborted/pre-create round reports NO timing fields (never a fabricated
 *     zero, which the classifier would read as an instant fail).
 *
 * The real pi/hermes runners drive this exact class and their serial round
 * tests additionally assert the fields end-to-end.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MatchlockRoundTiming } from "../../../dist/installer/matchlock/round-timing.js";

/** Controllable monotonic clock: `advance(ms)` moves time forward. */
function scriptedClock(start = 1_000) {
  let now = start;
  return {
    now: (): number => now,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

interface FakeRunnerStages {
  /** Time spent before VM create (admission + pack validation). */
  admissionMs: number;
  /** VM create/boot + bridge/broker handshake (pre-exec setup). */
  setupMs: number;
  /** Guest harness exec → exit. */
  harnessMs: number;
  /** Terminal teardown after the harness settled. */
  teardownMs: number;
}

interface FakeRunnerResult {
  durationMs: number;
  harnessWallMs?: number;
  vmSetupMs?: number;
}

/**
 * Fake in-VM runner mirroring the real runner's stage boundaries exactly:
 * construct tracker → admission → startVmSetup → (create/handshake) →
 * startHarnessExec → (harness) → endHarnessExec → teardown → report.
 */
function fakeInVmRunner(clock: ReturnType<typeof scriptedClock>, stages: FakeRunnerStages): FakeRunnerResult {
  const timing = new MatchlockRoundTiming(clock.now);
  clock.advance(stages.admissionMs);
  timing.startVmSetup();
  clock.advance(stages.setupMs);
  timing.startHarnessExec();
  clock.advance(stages.harnessMs);
  timing.endHarnessExec();
  clock.advance(stages.teardownMs);
  return { durationMs: timing.roundMs, ...timing.harnessFields() };
}

describe("MatchlockRoundTiming (US-006 split timing)", () => {
  it("harnessWallMs excludes VM setup and vmSetupMs carries the setup interval; durationMs is the whole round", () => {
    const clock = scriptedClock(1_000);
    const result = fakeInVmRunner(clock, {
      admissionMs: 50,
      setupMs: 30_000,
      harnessMs: 3,
      teardownMs: 2_000,
    });

    assert.equal(result.vmSetupMs, 30_000, "setup is the create/boot → exec-start interval");
    assert.equal(result.harnessWallMs, 3, "harness is the exec → exit interval, setup excluded");
    // The whole-round wall covers admission + setup + harness + teardown.
    assert.equal(result.durationMs, 50 + 30_000 + 3 + 2_000);
    // The defining property: harness time is NOT whole-round time, and setup
    // is not folded into it.
    assert.notEqual(result.harnessWallMs, result.durationMs);
    assert.equal(result.harnessWallMs, result.durationMs - 30_000 - 50 - 2_000);
  });

  it("harnessWallMs stays independent of VM setup: a long boot never inflates a short harness round", () => {
    const shortSetup = fakeInVmRunner(scriptedClock(), {
      admissionMs: 10,
      setupMs: 1_000,
      harnessMs: 2,
      teardownMs: 0,
    });
    const longSetup = fakeInVmRunner(scriptedClock(), {
      admissionMs: 10,
      setupMs: 120_000,
      harnessMs: 2,
      teardownMs: 0,
    });

    assert.equal(shortSetup.vmSetupMs, 1_000);
    assert.equal(longSetup.vmSetupMs, 120_000);
    // The classification signal is byte-identical across a 1s and a 2min boot.
    assert.equal(shortSetup.harnessWallMs, 2);
    assert.equal(longSetup.harnessWallMs, 2);
  });

  it("reports NO timing fields for an aborted pre-create round (no fabricated zero)", () => {
    const timing = new MatchlockRoundTiming(scriptedClock().now);
    // The harness never started, so neither interval exists.
    assert.equal(timing.vmSetupMs, undefined);
    assert.equal(timing.harnessWallMs, undefined);
    assert.deepEqual(timing.harnessFields(), {}, "harnessFields omits absent timing keys");
    // Even a bare endHarnessExec (e.g. a raced teardown) cannot fabricate one.
    timing.endHarnessExec();
    assert.equal(timing.harnessWallMs, undefined);
    assert.deepEqual(timing.harnessFields(), {});
  });

  it("reports setup only after the harness starts, and never a partial setup", () => {
    const clock = scriptedClock();
    const timing = new MatchlockRoundTiming(clock.now);
    timing.startVmSetup();
    clock.advance(5_000);
    // create/boot finished but the harness exec has not started yet: the setup
    // interval is still open, so nothing is reported.
    assert.equal(timing.vmSetupMs, undefined);
    assert.equal(timing.harnessWallMs, undefined);
    timing.startHarnessExec();
    assert.equal(timing.vmSetupMs, 5_000, "setup closes at harness exec start");
    assert.equal(timing.harnessWallMs, undefined, "harness interval is open");
    clock.advance(7);
    timing.endHarnessExec();
    assert.equal(timing.harnessWallMs, 7);
    assert.equal(timing.vmSetupMs, 5_000, "setup is unchanged by the harness interval");
  });

  it("is idempotent: repeated stage marks never re-base or shrink an interval", () => {
    const clock = scriptedClock();
    const timing = new MatchlockRoundTiming(clock.now);
    timing.startVmSetup();
    clock.advance(1_000);
    timing.startVmSetup(); // retried create must not re-base setup
    clock.advance(1_000);
    timing.startHarnessExec();
    timing.startHarnessExec(); // duplicate mark must not re-base harness
    clock.advance(4);
    timing.endHarnessExec();
    timing.endHarnessExec(); // duplicate end must not extend harness

    assert.equal(timing.vmSetupMs, 2_000);
    assert.equal(timing.harnessWallMs, 4);
  });
});
