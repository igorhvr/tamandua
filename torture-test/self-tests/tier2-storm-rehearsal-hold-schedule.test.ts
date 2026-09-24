// Tier-2 STORM-REHEARSAL-FIX4 US-004 — derive and record the
// SCRIPTED_REHEARSAL hold/phase schedule at prepare (in-process; NO daemon /
// harness / chaos / model).
//
// Attempt-4 SF-8: every live-target Round B chaos phase resolved `run_terminal`
// because the zero-model B runs finished in ~6 minutes while the real phases
// are due at 5400s+. On the tiny fixture the campaign must instead HOLD each
// roster run at a mid-flight checkpoint and DERIVE the Round B offsets from
// that hold schedule, so each phase fires while its target is still live and
// the target is released only after the last phase that structurally depends
// on it.
//
// This file pins the ONE pure derivation (`deriveScriptedHoldSchedule` /
// `scriptedRoundBPhases` in torture-test/bin/tt-storm-rehearsal.mjs) and its
// recording through the REAL `stormPrepare`:
//
//   H1  the schedule is the SCRIPTED_REHEARSAL profile with all 11 real Round B
//       phases in real order, ids equal to ROUND_B_PHASES' ids;
//   H2  derived offsets are strictly increasing, below the real chaos clock
//       (every derived offset is below the smallest POSITIVE real offset);
//   H3  every phase carries a kind:'hold' waitFor (marker 'hold-confirmed')
//       whose targets are exactly the real predicate's targets, and the real
//       action object verbatim;
//   H4  release_targets covers every structural target exactly once, at the
//       LAST derived phase that depends on it (B1..B4 after B-bounce, B5 after
//       B-stopdel; nothing released earlier);
//   H5  the Round A window block names the eight-concurrent-window release of
//       the whole S1..S10 roster;
//   H6  overrides are honored and a non-positive/non-finite hold timeout falls
//       back to the fail-closed bound (never disables it);
//   H7  stormPrepare with rehearsalPrepare records state.rehearsal.hold_schedule
//       AND state.plan.roundBPhases (and descriptor.json), while a
//       non-rehearsal prepare records neither — the real storm keeps
//       ROUND_B_PHASES at dispatch.
//
// Everything runs under fresh owned temp roots (os.tmpdir scratch); the git
// fixture for the rehearsal prepare is created by LOCAL git subprocesses only
// (no network, no credentials). Temp dirs are removed in finally.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { ROUND_A_ROSTER } from "../bin/tt-storm-roster.mjs";
import { spawnCapture } from "../bin/tt-storm-shared.mjs";
import { buildPrivateExecContext, persistableExecIdentity } from "../bin/tt-storm-real.mjs";
import {
  ROUND_B_PHASES,
  phaseTargetRosterIds,
  phaseWaitTargetRosterIds,
  stormPrepare,
} from "../bin/tt-storm-engine.mjs";
import {
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  DESCRIPTOR_NAME,
  HOLD_ID,
  HOLD_TIMEOUT_MS,
  SCRIPTED_HOLD_SCHEDULE_DEFAULTS,
  SCRIPTED_ROUND_A_RELEASE_TARGETS,
  computeGateHashes,
  deriveScriptedHoldSchedule,
  scriptedRoundBPhases,
} from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();
const BUNDLED_WORKFLOWS = path.join(repoRoot, "workflows");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");

const ROUND_B_PHASE_IDS = ROUND_B_PHASES.map((p: any) => p.id);
// The smallest POSITIVE real phase offset (B-cc1 at 15 min): every derived
// offset must sit below the real chaos clock.
const MIN_POSITIVE_REAL_OFFSET = Math.min(
  ...ROUND_B_PHASES.map((p: any) => p.earliestOffsetMs).filter((o: number) => o > 0),
);

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-hold-schedule-${label}-`));
}

// The structural dependency set of a real phase: the real predicate's targets
// UNION the action's targets (exactly the derivation's rule).
function realDependencySet(ph: any): Set<string> {
  const deps = new Set<string>(phaseWaitTargetRosterIds(ph) as string[]);
  for (const rid of phaseTargetRosterIds(ph.action) as string[]) deps.add(rid);
  return deps;
}

// A real, LOCAL git adapter (spawnCapture with mergeParentEnv:false).
function makeRealGitAdapter() {
  return {
    run: async (cwd: string, args: string[], { env = {} }: { env?: Record<string, string> } = {}) => {
      return await spawnCapture(["git", ...args], {
        cwd,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: cwd, ...env },
        mergeParentEnv: false,
        timeoutMs: 120_000,
      });
    },
  };
}

function makeClock() {
  return { nowMs: () => Date.now(), nowUtc: () => new Date().toISOString(), sleep: async () => {} };
}

describe("STORM-REHEARSAL-FIX4 US-004 — derived SCRIPTED_REHEARSAL hold/phase schedule", () => {
  it("H1: the schedule is SCRIPTED_REHEARSAL with all 11 real Round B phases in real order (ids equal ROUND_B_PHASES)", () => {
    const schedule = deriveScriptedHoldSchedule();
    assert.equal(schedule.profile, "SCRIPTED_REHEARSAL");
    assert.equal(schedule.hold_id, HOLD_ID, "hold id is the runtime's stable HOLD_ID");
    assert.equal(schedule.hold_timeout_ms, HOLD_TIMEOUT_MS, "default hold timeout is the bounded fallback");
    assert.equal(ROUND_B_PHASES.length, 11, "the real table has 11 phases");
    const phases = schedule.round_b.phases;
    assert.equal(phases.length, 11);
    assert.deepEqual(phases.map((p: any) => p.id), ROUND_B_PHASE_IDS, "derived phases stay in real ROUND_B_PHASES order");
    assert.deepEqual(
      phases.map((p: any) => p.real_earliest_offset_ms),
      ROUND_B_PHASES.map((p: any) => p.earliestOffsetMs),
      "each derived phase carries its real earliest offset",
    );
  });

  it("H2: derived offsets are strictly increasing and sit below the real chaos clock", () => {
    const phases = deriveScriptedHoldSchedule().round_b.phases;
    for (let i = 0; i < phases.length; i += 1) {
      const expected = SCRIPTED_HOLD_SCHEDULE_DEFAULTS.startOffsetMs + i * SCRIPTED_HOLD_SCHEDULE_DEFAULTS.phaseStepMs;
      assert.equal(phases[i].earliest_offset_ms, expected, `${phases[i].id} derives start + index*step`);
      if (i > 0) {
        assert.ok(
          phases[i].earliest_offset_ms > phases[i - 1].earliest_offset_ms,
          `${phases[i].id} offset is strictly increasing`,
        );
      }
      // Every derived offset is below the real CHAOS clock (the first real
      // chaos phase, B-cc1, is MIN_POSITIVE_REAL_OFFSET). B-pounding's real
      // offset is 0 — the round-start control action — so no non-negative
      // derived slot can be below it; the derived schedule's origin is that
      // control action and its hold predicate has no targets.
      assert.ok(
        phases[i].earliest_offset_ms < MIN_POSITIVE_REAL_OFFSET,
        `${phases[i].id} derived offset (${phases[i].earliest_offset_ms}) is below the real chaos clock`,
      );
    }
    assert.equal(ROUND_B_PHASES[0].id, "B-pounding");
    assert.equal(ROUND_B_PHASES[0].earliestOffsetMs, 0, "B-pounding is the round-start control action");
    assert.equal(
      phases[0].earliest_offset_ms,
      SCRIPTED_HOLD_SCHEDULE_DEFAULTS.startOffsetMs,
      "B-pounding's derived slot is the schedule origin",
    );
    for (let i = 1; i < phases.length; i += 1) {
      assert.ok(
        phases[i].earliest_offset_ms < phases[i].real_earliest_offset_ms,
        `${phases[i].id} derived offset is far below its real offset`,
      );
    }
  });

  it("H3: every phase carries a kind:'hold' waitFor with the real predicate's targets and the real action verbatim", () => {
    const phases = deriveScriptedHoldSchedule().round_b.phases;
    for (let i = 0; i < phases.length; i += 1) {
      const real = ROUND_B_PHASES[i];
      const ph = phases[i];
      assert.equal(ph.waitFor.kind, "hold", `${ph.id} waitFor is a hold`);
      assert.equal(ph.waitFor.marker, "hold-confirmed", `${ph.id} waits for hold confirmation`);
      assert.ok(Array.isArray(ph.waitFor.targets), `${ph.id} waitFor targets is an explicit array`);
      assert.deepEqual(
        ph.waitFor.targets,
        phaseWaitTargetRosterIds(real),
        `${ph.id} hold predicate observes exactly the real predicate's targets`,
      );
      assert.deepEqual(ph.action, real.action, `${ph.id} action object is copied verbatim from ROUND_B_PHASES`);
      assert.equal(ph.label, real.label, `${ph.id} label is preserved`);
    }
    // The control-only pounding phase targets nothing (held predicate vacuously
    // satisfied); the run-targeting phases name their real targets.
    assert.deepEqual(phases.find((p: any) => p.id === "B-nudge").waitFor.targets, ["B1"]);
    assert.deepEqual(phases.find((p: any) => p.id === "B-stopdel").waitFor.targets, ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(phases.find((p: any) => p.id === "B-park").waitFor.targets, ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(phases.find((p: any) => p.id === "B-pounding").waitFor.targets, []);
  });

  it("H4: release_targets releases every target exactly once, at its LAST dependent phase (nothing earlier)", () => {
    const phases = deriveScriptedHoldSchedule().round_b.phases;
    const lastDependent = new Map<string, number>();
    ROUND_B_PHASES.forEach((ph: any, idx: number) => {
      for (const rid of realDependencySet(ph)) lastDependent.set(rid, idx);
    });
    assert.ok(lastDependent.size > 0, "the real table structurally depends on at least one run");

    const released = new Map<string, number[]>();
    phases.forEach((ph: any, idx: number) => {
      for (const rid of ph.release_targets) {
        assert.ok(realDependencySet(ROUND_B_PHASES[idx]).has(rid), `${ph.id} may only release a phase it depends on (${rid})`);
        assert.equal(lastDependent.get(rid), idx, `${rid} must be released at its LAST dependent phase (${ph.id})`);
        if (!released.has(rid)) released.set(rid, []);
        released.get(rid)!.push(idx);
      }
    });
    // Every structurally-depended target is released exactly once, by the
    // phase that last depends on it — no target is ever stranded.
    for (const [rid, lastIdx] of lastDependent.entries()) {
      assert.deepEqual(released.get(rid), [lastIdx], `${rid} released exactly once by its last dependent phase`);
    }
    assert.equal(released.size, lastDependent.size, "the derived release set covers every dependent target");
    // The documented default outcome: B1..B4 after B-bounce; B5 after B-stopdel.
    assert.deepEqual(phases.find((p: any) => p.id === "B-bounce").release_targets, ["B1", "B2", "B3", "B4"]);
    assert.deepEqual(phases.find((p: any) => p.id === "B-stopdel").release_targets, ["B5"]);
    assert.deepEqual(phases.find((p: any) => p.id === "B-kill").release_targets, [], "B4 is not released at B-kill (it stays held for later predicates)");
    assert.deepEqual(phases.find((p: any) => p.id === "B-rugpull").release_targets, [], "B1..B4 stay held through B-rugpull and release at B-bounce");
  });

  it("H8: B-park and B-rugpull structurally depend on the live merge targets and fire before any release", () => {
    const phases = deriveScriptedHoldSchedule().round_b.phases;
    const byId = new Map<string, any>(phases.map((p: any) => [p.id, p]));
    const mergeTargets = ["B1", "B2", "B3", "B4"];
    for (const id of ["B-park", "B-rugpull"]) {
      const ph = byId.get(id);
      assert.ok(ph, `${id} is present in the derived schedule`);
      assert.deepEqual(
        [...ph.waitFor.targets].sort(),
        mergeTargets,
        `${id} hold predicate structurally depends on the live merge targets B1..B4`,
      );
      assert.deepEqual(ph.release_targets, [], `${id} releases nothing: B1..B4 stay held`);
      assert.ok(
        ph.earliest_offset_ms < byId.get("B-bounce").earliest_offset_ms,
        `${id} fires before B-bounce (the phase that releases B1..B4)`,
      );
    }
    // No derived phase BEFORE B-bounce releases any of B1..B4: the targets are
    // held through both B-park and B-rugpull.
    const bounceIdx = phases.findIndex((p: any) => p.id === "B-bounce");
    assert.ok(bounceIdx > 0, "B-bounce is in the derived order");
    for (const ph of phases.slice(0, bounceIdx)) {
      for (const rid of ph.release_targets) {
        assert.ok(!mergeTargets.includes(rid), `${ph.id} must not release ${rid} before B-bounce`);
      }
    }
    assert.deepEqual(
      byId.get("B-bounce").release_targets,
      mergeTargets,
      "B-bounce is the last dependent phase and releases all of B1..B4",
    );
  });

  it("H5: the Round A block names the eight-concurrent-window release of the whole S1..S10 roster", () => {
    const schedule = deriveScriptedHoldSchedule();
    assert.equal(schedule.round_a.release_trigger, "eight_concurrent_window");
    assert.equal(schedule.round_a.sample_interval_ms, 15_000, "the sampler cadence is 15s");
    assert.equal(schedule.round_a.window_deadline_ms, 2_400_000, "the window has a bounded deadline");
    assert.deepEqual(schedule.round_a.release_targets, SCRIPTED_ROUND_A_RELEASE_TARGETS);
    assert.deepEqual(
      schedule.round_a.release_targets,
      ROUND_A_ROSTER.map((r: any) => r.id),
      "the Round A release set is exactly the roster",
    );
    assert.deepEqual(scriptedRoundBPhases(), schedule.round_b.phases, "scriptedRoundBPhases() projects the same phases");
  });

  it("H6: overrides are honored and an invalid hold timeout can never disable the fail-closed bound", () => {
    const custom = deriveScriptedHoldSchedule({ startOffsetMs: 5_000, phaseStepMs: 1_000, holdTimeoutMs: 12_345 });
    assert.equal(custom.round_b.start_offset_ms, 5_000);
    assert.equal(custom.round_b.phase_step_ms, 1_000);
    assert.equal(custom.hold_timeout_ms, 12_345);
    custom.round_b.phases.forEach((ph: any, idx: number) => {
      assert.equal(ph.earliest_offset_ms, 5_000 + idx * 1_000);
    });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "nope", null, undefined]) {
      const schedule = deriveScriptedHoldSchedule({ holdTimeoutMs: bad });
      assert.equal(schedule.hold_timeout_ms, SCRIPTED_HOLD_SCHEDULE_DEFAULTS.holdTimeoutMs, `invalid hold timeout ${String(bad)} falls back`);
    }
    // Invalid offsets fall back to the documented defaults too.
    const badOffsets = deriveScriptedHoldSchedule({ startOffsetMs: -5, phaseStepMs: 0 });
    assert.equal(badOffsets.round_b.start_offset_ms, SCRIPTED_HOLD_SCHEDULE_DEFAULTS.startOffsetMs);
    assert.equal(badOffsets.round_b.phase_step_ms, SCRIPTED_HOLD_SCHEDULE_DEFAULTS.phaseStepMs);
  });

  it("H7: stormPrepare records the schedule for rehearsalPrepare and records nothing for the real profile", async () => {
    const scratch = ownedScratch("prepare");
    try {
      const varRoot = path.join(scratch, "var");
      fs.mkdirSync(varRoot, { recursive: true });
      const installedRoot = path.join(varRoot, "home", ".tamandua", "workflows");
      const execCtx = buildPrivateExecContext({ varRoot, binaries: { tamandua: TAMANDUA_BIN } });
      const ctx: any = {
        fs: REAL_FS,
        clock: makeClock(),
        proc: {},
        db: null,
        git: makeRealGitAdapter(),
        varRoot,
        campaignDir: null,
        opts: {
          rehearsalPrepare: true,
          installedCatalogRoot: installedRoot,
          bundledCatalogRoot: BUNDLED_WORKFLOWS,
          sourceCommit: "c".repeat(40),
          sourceTree: "t".repeat(40),
          sourceTreeDirty: false,
          execIdentity: persistableExecIdentity(execCtx),
          gitEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.join(scratch, "git-home") },
          gateHashes: computeGateHashes(),
          coordinatorApprovalFile: DEFAULT_COORDINATOR_APPROVAL_FILE,
        },
        argv: ["prepare"],
      };

      const res: any = await stormPrepare(ctx);
      const schedule = deriveScriptedHoldSchedule();
      assert.deepEqual(res.state.rehearsal.hold_schedule, schedule, "rehearsal prepare records the derived schedule in state");
      assert.deepEqual(res.state.plan.roundBPhases, schedule.round_b.phases, "rehearsal prepare records the derived phases in the plan");

      // The persisted state.json carries it too (resume/report read state).
      const onDisk = JSON.parse(fs.readFileSync(path.join(res.campaignDir, "state.json"), "utf8"));
      assert.deepEqual(onDisk.rehearsal.hold_schedule, schedule);
      assert.deepEqual(onDisk.plan.roundBPhases, schedule.round_b.phases);

      // The descriptor builder persists the same schedule (single source).
      const desc = JSON.parse(fs.readFileSync(path.join(res.campaignDir, DESCRIPTOR_NAME), "utf8"));
      assert.deepEqual(desc.hold_schedule, schedule, "descriptor.json carries the derived schedule");

      // The bounded hold timeout is the one baked into the generated runtime
      // behaviors (engine and runtime cannot drift).
      const behaviors = JSON.parse(fs.readFileSync(res.state.rehearsal.scripted_runtime.behaviors_file, "utf8"));
      const holds = Object.values(behaviors.agents)
        .flatMap((b: any) => (Array.isArray(b) ? b : [b]))
        .filter((b: any) => b && b.hold)
        .map((b: any) => b.hold.timeoutMs);
      assert.ok(holds.length > 0, "at least one scripted behavior carries a hold");
      for (const t of holds) assert.equal(t, schedule.hold_timeout_ms, "behavior hold timeout equals the derived schedule timeout");

      // Real profile: a non-rehearsal prepare in a fresh scratch varRoot must
      // NOT record the derived schedule at all (dispatch keeps ROUND_B_PHASES).
      const realVarRoot = path.join(scratch, "var-real");
      fs.mkdirSync(realVarRoot, { recursive: true });
      const realCtx: any = {
        fs: REAL_FS,
        clock: makeClock(),
        proc: {},
        db: null,
        varRoot: realVarRoot,
        campaignDir: null,
        opts: {
          bundledCatalogRoot: BUNDLED_WORKFLOWS,
          sourceCommit: "c".repeat(40),
          sourceTree: "t".repeat(40),
          sourceTreeDirty: false,
        },
        argv: ["prepare"],
      };
      const realRes: any = await stormPrepare(realCtx);
      assert.equal(realRes.state.rehearsal, undefined, "non-rehearsal prepare records no rehearsal block");
      assert.equal(realRes.state.plan.roundBPhases, undefined, "non-rehearsal prepare records no derived phases");
      // intent.jsonl still records the REAL phase intents (ROUND_B_PHASES).
      const lines = fs
        .readFileSync(path.join(realRes.campaignDir, "intent.jsonl"), "utf8")
        .split(/\r?\n/)
        .filter((l: string) => l.trim() !== "")
        .map((l: string) => JSON.parse(l));
      const phaseIntents = lines.filter((l: any) => l.kind === "phase_intent");
      assert.deepEqual(phaseIntents.map((p: any) => p.id), ROUND_B_PHASE_IDS, "real phase intents keep the real phase order");
      assert.equal(phaseIntents[0].earliestOffsetMs, 0, "real B-pounding intent keeps its real 0 offset");
      assert.equal(phaseIntents[1].earliestOffsetMs, ROUND_B_PHASES[1].earliestOffsetMs, "real B-cc1 intent keeps its real offset");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
