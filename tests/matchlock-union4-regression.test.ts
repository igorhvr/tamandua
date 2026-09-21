/**
 * MATCHLOCK-UNION-4 US-003 — both-lines union regression matrix.
 *
 * The union4 merge folded the Matchlock line (434771eb) into the main-based
 * branch (5d307302). Its whole risk is silent loss: a later change (or a
 * future re-merge) can keep the tree building while dropping one lineage's
 * contract on the floor. This file pins BOTH lineages in ONE place:
 *
 *   ── MAIN lineage ────────────────────────────────────────────────────────
 *   the instant contract (nowIso / parseInstant / formatInstant / SQL_NOW_ISO)
 *   and the time-clocks guard/wall-jump suites; kernel/process identity;
 *   DPID takeover + state-dir scoping; worker-pid claims (claim_pid records
 *   TAMANDUA_WORKER_PID); the direct-mode post-grace sweep with a null
 *   worktree; paused-kill recovery accounting; commit identity/signing
 *   including the Matchlock signing-skip flag; reroute budget
 *   target_moved_reroute_count accounting; workdir_collision_policy
 *   refuse/queue/allow constants; bounded lsof fail-closed; atomic event
 *   append; monotonic clocks.
 *
 *   ── MATCHLOCK lineage ───────────────────────────────────────────────────
 *   matchlock_policy build/serialize/parse round-trip and its persist/read-back
 *   wiring; runRound through the Matchlock controller for pi/hermes/dsh;
 *   mount-plan admission; guest suite transport; capability admission; the
 *   launch-time probe in the Matchlock context.
 *
 * Two evidence styles are used on purpose:
 *
 *   1. RUNTIME assertions import the compiled module and exercise the public
 *      contract (instant helpers, workdir policy, policy round-trip,
 *      capabilities, guest-suite transport, dispatch guard, atomic append).
 *   2. SOURCE pins for the behaviors that live in modules which own
 *      `node:child_process` (runner/scheduler/daemon/lsof/step-ops): the exact
 *      wiring token must be present at the exact location that owns it. This
 *      keeps the file pure (no child_process, no daemon, no VM) so it stays in
 *      the PARALLEL lane and needs no tests/serial-files.txt entry.
 *
 * Assertions are deliberately tight: they pin the behavior, not the prose, and
 * must never be weakened to make the merge look green.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Deadline,
  SQL_NOW_ISO,
  Stopwatch,
  formatInstant,
  instantAgeMs,
  isOlderThan,
  monotonicNow,
  nowIso,
  parseInstant,
} from "../dist/lib/instant.js";
import {
  WORKDIR_ALLOW_ENV_VAR,
  WORKDIR_COLLISION_POLICY_KEY,
  WORKDIR_REFUSAL_EXIT_CODE,
  WORKDIR_REFUSAL_STATE,
  formatWorkdirRefusalMessage,
  formatSharedWorkdirWarning,
  parseWorkdirCollisionPolicy,
  resolveWorkdirCollisionPolicy,
} from "../dist/installer/workdir-collision.js";
import {
  MATCHLOCK_POLICY_VERSION,
  buildMatchlockPolicy,
  parseMatchlockPolicy,
  serializeMatchlockPolicy,
} from "../dist/installer/matchlock/policy.js";
import {
  MATCHLOCK_AVAILABLE_CAPABILITIES,
  matchlockHarnessSupportsWorkflow,
  matchlockMissingCapabilities,
  matchlockWorkflowCapabilities,
} from "../dist/installer/matchlock/capabilities.js";
import {
  GUEST_SUITE_TRANSPORT_VERSION,
  SUITE_TRANSPORT_OPS,
  guestSuiteNamespaceId,
} from "../dist/installer/matchlock/guest-suite-contract.js";
import { matchlockDispatchDecision } from "../dist/installer/matchlock/dispatch-guard.js";
import { appendEventLine } from "../dist/installer/events.js";
import { tamanduaTempDir } from "../dist/lib/temp-dir.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Read a tracked source file by repo-relative path. */
function readSource(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

/** Assert `source` contains every literal, naming the file and missing token. */
function assertContains(
  relPath: string,
  source: string,
  literals: readonly string[],
): void {
  for (const literal of literals) {
    assert.ok(
      source.includes(literal),
      `${relPath} must still carry the union contract token ${JSON.stringify(literal)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN lineage
// ─────────────────────────────────────────────────────────────────────────────

describe("union4 regression — main lineage: instant + monotonic contracts", () => {
  it("nowIso() emits a canonical ISO-8601 UTC Z instant with milliseconds", () => {
    const value = nowIso();
    assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(parseInstant(value) !== undefined);
  });

  it("SQL_NOW_ISO is the canonical strftime writer and stays a plain literal", () => {
    assert.equal(SQL_NOW_ISO, "strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    assert.equal(typeof SQL_NOW_ISO, "string");
  });

  it("parseInstant() pins legacy naive UTC to UTC and rejects junk", () => {
    const naive = parseInstant("2026-09-15 22:00:00");
    assert.ok(naive instanceof Date);
    assert.equal(naive.getTime(), Date.parse("2026-09-15T22:00:00Z"));
    assert.equal(parseInstant("2026-09-15T22:00:00.123Z")?.getTime(), Date.parse("2026-09-15T22:00:00.123Z"));
    assert.equal(parseInstant("2026-09-15T22:00:00+03:00")?.getTime(), Date.parse("2026-09-15T19:00:00Z"));
    for (const junk of ["", "   ", "not-a-date", "2026-09-15", 42, null, undefined, new Date()]) {
      assert.equal(parseInstant(junk), undefined, `parseInstant(${String(junk)}) must be undefined`);
    }
  });

  it("formatInstant() serializes both styles with an explicit Z", () => {
    assert.equal(
      formatInstant("2026-09-15 22:00:00"),
      "2026-09-15T22:00:00.000Z",
    );
    assert.equal(
      formatInstant("2026-09-15T22:00:00.123Z", { style: "log" }),
      "2026-09-15 22:00:00Z",
    );
    assert.equal(formatInstant(new Date("2026-09-15T22:00:00Z")), "2026-09-15T22:00:00.000Z");
    assert.equal(formatInstant("junk"), undefined);
  });

  it("monotonicNow/Stopwatch/Deadline measure intervals on an injectable clock", () => {
    const first = monotonicNow();
    const second = monotonicNow();
    assert.ok(Number.isFinite(first) && Number.isFinite(second));
    assert.ok(second >= first, "monotonic clock must never go backwards");

    let tick = 0;
    const stopwatch = new Stopwatch(() => tick);
    tick = 250;
    assert.equal(stopwatch.elapsedMs(), 250);
    stopwatch.restart();
    tick = 400;
    assert.equal(stopwatch.elapsedMs(), 150);

    const deadline = new Deadline(1000, () => tick);
    tick = 1200;
    assert.equal(deadline.remainingMs(), 200);
    assert.equal(deadline.expired(), false);
    tick = 1500;
    assert.equal(deadline.expired(), true);
  });

  it("durable-instant ages are numeric and fail safe on unknown input", () => {
    assert.equal(
      instantAgeMs("2026-09-15T22:00:00.000Z", Date.parse("2026-09-15T22:00:01.000Z")),
      1000,
    );
    assert.equal(instantAgeMs("junk", Date.now()), undefined);
    assert.equal(
      isOlderThan("2026-09-15T22:00:00.000Z", 500, Date.parse("2026-09-15T22:00:01.000Z")),
      true,
    );
    assert.equal(
      isOlderThan("2026-09-15T22:00:00.000Z", 5000, Date.parse("2026-09-15T22:00:01.000Z")),
      false,
    );
    assert.equal(isOlderThan("junk", 1, Date.now()), false);
  });

  it("keeps the dedicated time-clocks guard and wall-jump suites on the merged tree", () => {
    for (const suite of [
      "tests/time-clocks-guard.test.ts",
      "tests/time-clocks-wall-jump.test.ts",
    ]) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, suite)), `${suite} must exist`);
      assert.ok(readSource(suite).includes("describe("), `${suite} must carry tests`);
    }
  });

  it("uses the shared instant contract across the merged source tree", () => {
    for (const relPath of [
      "src/installer/events.ts",
      "src/installer/agent-scheduler.ts",
      "src/server/daemonctl.ts",
      "src/installer/step-ops.ts",
    ]) {
      const source = readSource(relPath);
      assert.match(
        source,
        /from "\.\.?\/(?:\.\.\/)*lib\/instant\.js"/,
        `${relPath} must import the shared instant contract`,
      );
    }
  });
});

describe("union4 regression — main lineage: process identity, takeover, sweep", () => {
  it("keeps kernel/process identity and DPID takeover with state-dir scoping", () => {
    const identity = readSource("src/server/daemon-identity.ts");
    assertContains("src/server/daemon-identity.ts", identity, [
      "stateDir?: string",
      "DPID",
      "daemon identity primitive",
    ]);

    const daemonctl = readSource("src/server/daemonctl.ts");
    assertContains("src/server/daemonctl.ts", daemonctl, [
      "identityBelongsToEffectiveStateDir",
      "processHomeMatches",
      "DPID takeover",
      "resolveStateDir(opts)",
    ]);

    const procInfo = readSource("src/lib/proc-info.ts");
    assertContains("src/lib/proc-info.ts", procInfo, [
      "export function getProcessState",
      "export function getPgid",
      "export function listProcessDetails",
      "export function isProcfsPath",
    ]);
  });

  it("records the worker pid from TAMANDUA_WORKER_PID on the claim path", () => {
    const step = readSource("src/cli/commands/step.ts");
    assertContains("src/cli/commands/step.ts", step, [
      "process.env.TAMANDUA_WORKER_PID",
      "process.env.TAMANDUA_WORKER_PGID",
      "claimStep(target, runIdArg, workerOwnership)",
      "claim_job_id",
    ]);
    const stepOps = readSource("src/installer/step-ops.ts");
    assertContains("src/installer/step-ops.ts", stepOps, [
      "claim_job_id = NULL, claim_pid = NULL, claim_pgid = NULL",
    ]);
  });

  it("sweeps direct-mode runs post-grace with a null worktree", () => {
    const scheduler = readSource("src/installer/agent-scheduler.ts");
    assertContains("src/installer/agent-scheduler.ts", scheduler, [
      "export interface PostGraceSweepTarget",
      "export async function runPostGraceSweep",
      "runPostGraceSweep(",
    ]);
    const cleanup = readSource("src/installer/run-cleanup.ts");
    assertContains("src/installer/run-cleanup.ts", cleanup, [
      "export function sweepRunProcesses(",
      "worktreePath: string | null",
      "export function processBelongsToRun(",
      "direct-mode runs",
    ]);
  });

  it("accounts paused-kill recovery without charging a retry", () => {
    const stepOps = readSource("src/installer/step-ops.ts");
    assertContains("src/installer/step-ops.ts", stepOps, [
      'event: "step.paused_kill"',
      "prior worker pid",
    ]);
    assert.match(
      stepOps,
      /no worker_lost\/ceiling counter is bumped/,
      "paused-kill must be documented as not charging the retry budget",
    );
  });

  it("keeps commit identity/signing and the Matchlock signing-skip flag", () => {
    const mergeBranch = readSource("src/installer/merge-branch.ts");
    assertContains("src/installer/merge-branch.ts", mergeBranch, [
      "isMatchlockGuestContext(",
      "MATCHLOCK_SIGNING_SKIP_REASON",
      '"unsigned-matchlock"',
      "const signingEnabled = signingConfig.enabled && !matchlockGuestContext",
    ]);
    const signing = readSource("src/installer/git-signing.ts");
    assertContains("src/installer/git-signing.ts", signing, [
      "export function isMatchlockGuestContext",
      "export const MATCHLOCK_SIGNING_SKIP_REASON",
      "export function resolveGitSigningConfig",
      "MATCHLOCK_CONTEXT_KEY",
    ]);
  });

  it("keeps target_moved_reroute_count accounting for the reroute budget", () => {
    const stepOps = readSource("src/installer/step-ops.ts");
    assertContains("src/installer/step-ops.ts", stepOps, [
      "target_moved_reroute_count",
      "effectiveShared",
    ]);
    const events = readSource("src/installer/events.ts");
    assertContains("src/installer/events.ts", events, [
      "target_moved_reroute_count",
      "no-checkout-to-refresh",
      "checkout-not-at-tip",
    ]);
  });

  it("pins the workdir_collision_policy refuse/queue/allow contract at runtime", () => {
    assert.equal(WORKDIR_COLLISION_POLICY_KEY, "workdir_collision_policy");
    assert.equal(WORKDIR_REFUSAL_EXIT_CODE, 75);
    assert.equal(WORKDIR_REFUSAL_STATE, "refused");
    assert.equal(parseWorkdirCollisionPolicy("refuse"), "refuse");
    assert.equal(parseWorkdirCollisionPolicy("queue"), "queue");
    assert.equal(parseWorkdirCollisionPolicy("allow"), "allow");
    assert.equal(parseWorkdirCollisionPolicy("Refuse"), undefined);
    assert.equal(parseWorkdirCollisionPolicy(""), undefined);

    // Default is refuse; the environment is the `allow` form only at "1"; a
    // valid persisted context value always wins.
    assert.equal(resolveWorkdirCollisionPolicy({}, {}), "refuse");
    assert.equal(
      resolveWorkdirCollisionPolicy({}, { [WORKDIR_ALLOW_ENV_VAR]: "1" }),
      "allow",
    );
    assert.equal(
      resolveWorkdirCollisionPolicy(
        { [WORKDIR_COLLISION_POLICY_KEY]: "queue" },
        { [WORKDIR_ALLOW_ENV_VAR]: "1" },
      ),
      "queue",
    );

    const refusal = formatWorkdirRefusalMessage(
      { runId: "run-1", runNumber: null, workflowId: "do-now", status: "running", since: "2026-09-16T00:00:00.000Z" },
      "/work/dir",
    );
    assert.ok(refusal.includes("/work/dir"));
    assert.ok(refusal.includes("run-1"), "unknown run number must fall back to the run id");
    assert.ok(!refusal.includes("null"));
    assert.ok(formatSharedWorkdirWarning("/work/dir").includes("/work/dir"));
  });

  it("keeps the bounded lsof probe fail-closed (always -b -w, SIGKILL timeout)", () => {
    const source = readSource("src/lib/lsof-probe.ts");
    assertContains("src/lib/lsof-probe.ts", source, [
      'return ["-b", "-w", ...args]',
      'killSignal: "SIGKILL"',
      'kind: "timeout"',
      "NEVER as an empty",
    ]);
    const procInfo = readSource("src/lib/proc-info.ts");
    assertContains("src/lib/proc-info.ts", procInfo, [
      'return "unknown"',
      "Never silently treat a failed probe",
    ]);
  });

  it("appends events atomically through one O_APPEND write path", () => {
    const source = readSource("src/installer/events.ts");
    assertContains("src/installer/events.ts", source, [
      "export function appendEventLine",
      'fs.openSync(filePath, "a")',
      "O_APPEND",
    ]);

    const dir = tamanduaTempDir("union4-events-");
    try {
      const file = path.join(dir, "all.jsonl");
      const first = '{"event":"run.created"}';
      const second = '{"event":"step.claimed"}';
      assert.equal(appendEventLine(file, first), Buffer.byteLength(`${first}\n`, "utf8"));
      assert.equal(appendEventLine(file, second), Buffer.byteLength(`${second}\n`, "utf8"));
      assert.equal(fs.readFileSync(file, "utf8"), `${first}\n${second}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MATCHLOCK lineage
// ─────────────────────────────────────────────────────────────────────────────

const PIN = {
  digest: `sha256:${"a".repeat(64)}`,
  config_digest: `sha256:${"b".repeat(64)}`,
  tag: "vic/ml:latest",
} as const;

function buildPiPolicy(): ReturnType<typeof buildMatchlockPolicy> {
  return buildMatchlockPolicy({
    requestedImage: "vic/ml:latest",
    identity: PIN,
    harness: "pi",
    workingDirectory: "/opt/project",
    originalRepositoryRoot: "/opt/project",
    workMounts: [
      { hostPath: "/opt/project", hostRealPath: "/opt/project", guestPath: "/opt/project" },
    ],
    gitMetadataRoots: [],
  });
}

describe("union4 regression — matchlock lineage: policy + capabilities", () => {
  it("round-trips matchlock_policy through serialize/parse with the pinned identity", () => {
    const policy = buildPiPolicy();
    assert.equal(policy.version, MATCHLOCK_POLICY_VERSION);
    assert.equal(policy.harness, "pi");
    assert.equal(policy.resolvedImageDigest, PIN.digest);
    assert.equal(policy.resolvedImageConfigDigest, PIN.config_digest);

    const json = serializeMatchlockPolicy(policy);
    assert.deepEqual(parseMatchlockPolicy(json), policy);
  });

  it("fails closed on legacy/unpinned or malformed persisted policies", () => {
    assert.throws(
      () => parseMatchlockPolicy(JSON.stringify({ version: 1 })),
      (err: unknown) =>
        typeof err === "object" && err !== null && (err as { code?: string }).code === "policy_legacy_unpinned",
    );
    assert.throws(() => parseMatchlockPolicy("{not json"));
    assert.throws(() => parseMatchlockPolicy("null"));
  });

  it("admits dispatch only for a supported harness x workflow capability", () => {
    // Native (NULL policy) is always allowed.
    assert.equal(matchlockDispatchDecision(null).refused, false);

    const json = serializeMatchlockPolicy(buildPiPolicy());
    assert.equal(
      matchlockDispatchDecision(json, { workflowId: "do-now", harnessType: "pi" }).refused,
      false,
    );
    assert.equal(
      matchlockDispatchDecision(json, { workflowId: "feature-dev-merge-worktree", harnessType: "pi" }).refused,
      false,
    );
    // Cross-harness mismatch refuses before any probe/VM.
    const mismatch = matchlockDispatchDecision(json, { workflowId: "do-now", harnessType: "dsh" });
    assert.equal(mismatch.refused, true);
    // Unknown workflow refuses.
    assert.equal(
      matchlockDispatchDecision(json, { workflowId: "not-a-workflow", harnessType: "pi" }).refused,
      true,
    );
  });

  it("pins the capability admission closure and the harness-independent admission set", () => {
    assert.deepEqual(matchlockWorkflowCapabilities("feature-dev-merge-worktree"), [
      "guest-git",
      "guest-test-suite",
      "merge-branch",
      "run-queries",
    ]);
    assert.deepEqual(matchlockMissingCapabilities("feature-dev-merge-worktree"), []);
    assert.deepEqual(
      matchlockMissingCapabilities("feature-dev-merge-worktree", ["guest-git"]),
      ["guest-test-suite", "merge-branch", "run-queries"],
    );
    assert.equal(
      matchlockMissingCapabilities("feature-dev-merge-worktree").length === 0,
      MATCHLOCK_AVAILABLE_CAPABILITIES.includes("merge-branch"),
    );
    // MTLK-ALL-WORKFLOWS US-003 lifted the harness-by-workflow allow-list:
    // every harness (pi, hermes, dsh) carries the same admitted workflow set,
    // so the harness argument no longer narrows admission. An absent/unknown
    // harness or an unknown/custom workflow still fails closed.
    assert.equal(matchlockHarnessSupportsWorkflow("pi", "feature-dev-merge-worktree"), true);
    assert.equal(matchlockHarnessSupportsWorkflow("hermes", "feature-dev-merge-worktree"), true);
    assert.equal(matchlockHarnessSupportsWorkflow("dsh", "feature-dev-merge-worktree"), true);
    assert.equal(matchlockHarnessSupportsWorkflow("hermes", "do-now"), true);
    assert.equal(matchlockHarnessSupportsWorkflow(undefined, "do-now"), false);
    assert.equal(matchlockHarnessSupportsWorkflow("pi", "not-a-workflow"), false);
    assert.equal(matchlockHarnessSupportsWorkflow("hermes", "not-a-workflow"), false);
  });

  it("pins the guest suite transport version, ops, and namespace identity", () => {
    assert.equal(GUEST_SUITE_TRANSPORT_VERSION, 1);
    assert.deepEqual([...SUITE_TRANSPORT_OPS], [
      "suite.lookup",
      "suite.claim",
      "suite.record",
      "suite.release",
      "suite.duration-history",
      "suite.event",
    ]);
    const namespace = {
      imageContentId: PIN.digest,
      guestPlatform: "linux/amd64",
      helperContract: "build-1+transport-1",
      compatibilityFingerprint: "fp-abc",
    };
    assert.equal(guestSuiteNamespaceId(namespace), guestSuiteNamespaceId({ ...namespace }));
    assert.ok(guestSuiteNamespaceId(namespace).includes(PIN.digest));
  });
});

describe("union4 regression — matchlock lineage: runner, mount plan, probe wiring", () => {
  it("persists matchlock_policy on the run and reads it back", () => {
    const run = readSource("src/installer/run.ts");
    assertContains("src/installer/run.ts", run, [
      "UPDATE runs SET matchlock_policy = ?",
      "serializeMatchlockPolicy(admission.policy)",
      "matchlockPolicy: run.matchlock_policy",
    ]);
    const dashboard = readSource("src/server/dashboard.ts");
    assertContains("src/server/dashboard.ts", dashboard, [
      "matchlock_policy FROM runs",
      "parseMatchlockPolicy(run.matchlock_policy)",
    ]);
    const controlServer = readSource("src/server/control-server.ts");
    assertContains("src/server/control-server.ts", controlServer, [
      "matchlock_policy",
      "matchlockPolicy: run.matchlock_policy",
    ]);
  });

  it("routes the scheduler round through the Matchlock controller for pi/hermes/dsh", () => {
    const scheduler = readSource("src/installer/agent-scheduler.ts");
    assertContains("src/installer/agent-scheduler.ts", scheduler, [
      "runMatchlockSchedulerRound(",
      "buildMatchlockProbeCommand()",
    ]);
    const seam = readSource("src/installer/matchlock/scheduler-matchlock.ts");
    assertContains("src/installer/matchlock/scheduler-matchlock.ts", seam, [
      "export function runMatchlockSchedulerRound",
      "export function matchlockProductionRunnerKind",
      "runMatchlockInvocation({",
      "runHermesInvocation({",
      "runDshSchedulerRound(",
    ]);
    const dsh = readSource("src/installer/matchlock/scheduler-dsh.ts");
    assertContains("src/installer/matchlock/scheduler-dsh.ts", dsh, [
      "export function runDshSchedulerRound",
      "export function buildDshProbeCommand",
    ]);
    const controller = readSource("src/installer/matchlock/controller.ts");
    assertContains("src/installer/matchlock/controller.ts", controller, [
      "export class MatchlockController",
      "async resolveAndAdmitIdentity(",
      "async prepareAndCreate(",
      "async execStream(",
    ]);
  });

  it("keeps mount-plan admission (broad source, protected roots, work mounts)", () => {
    const source = readSource("src/installer/matchlock/mount-plan.ts");
    assertContains("src/installer/matchlock/mount-plan.ts", source, [
      "export function isBroadHostSource",
      "export function shadowsProtectedGuestRoot",
      "export function validateWorkMounts",
      "MATCHLOCK_GUEST_RUNTIME_ROOT",
    ]);
    const admission = readSource("src/installer/matchlock/admission.ts");
    assertContains("src/installer/matchlock/admission.ts", admission, [
      "export async function admitMatchlockRun",
      "MATCHLOCK_RPC_BIN_ENV",
      "TAMANDUA_MATCHLOCK_RPC_BIN",
    ]);
  });

  it("runs the launch-time probe inside the Matchlock guest context", () => {
    const seam = readSource("src/installer/matchlock/scheduler-matchlock.ts");
    assertContains("src/installer/matchlock/scheduler-matchlock.ts", seam, [
      "export function buildMatchlockProbeCommand",
      "export const MATCHLOCK_GUEST_SKILL_FILE",
      "HARNESS_PROBE_MARKER",
    ]);
    const probe = readSource("src/installer/harness-probe.ts");
    assertContains("src/installer/harness-probe.ts", probe, [
      'export const HARNESS_PROBE_MARKER = "TAMANDUA_HARNESS_PROBE: skill-path"',
      "export function passesHarnessProbe",
      "export function evaluateHarnessProbe",
    ]);
  });

  it("coexists with the main-lineage schema chain (v12, both guarded ALTERs)", () => {
    const db = readSource("src/db.ts");
    assertContains("src/db.ts", db, [
      "ALTER TABLE runs ADD COLUMN matchlock_policy TEXT",
      "ALTER TABLE steps ADD COLUMN target_moved_reroute_count INTEGER DEFAULT 0",
      "migrateInstantsToIsoZ(db)",
    ]);
  });
});
