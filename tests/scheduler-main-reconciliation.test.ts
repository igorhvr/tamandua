/**
 * MATCHLOCK-UNION-4 US-007 — core-motor reconciliation guard.
 *
 * The Matchlock union squash (refs/remotes/src/union = 5729f76d) was cut from
 * an older main, so the union's scheduler/step-ops code was written against
 * pre-`a61e250f` abstractions. During the port those files auto-merged, which
 * means BOTH behavior lines must be verified to coexist: main's worker-pid
 * claim hygiene, exclusive sweep ownership, instant contract, outage-class
 * (harnessWallMs/vmSetupMs + preclaim-death backoff) AND the union's Matchlock
 * dispatch admission/seams.
 *
 * US-001 already resolved the textual conflicts; this guard pins the semantic
 * reconciliation so a future re-merge or careless edit cannot silently drop
 * either line. It reads the source for the structural wiring (there is no
 * runtime seam to introspect for a "the import/call site exists" assertion)
 * and exercises the pure admission gate for the fail-closed half.
 *
 * Parallel-lane safe: no child_process, no daemon, no real HOME.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { matchlockDispatchDecision } from "../dist/installer/matchlock/dispatch-guard.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function source(rel: string): string {
  return readFileSync(path.join(REPO, rel), "utf8");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("US-007 core-motor reconciliation: union Matchlock seams", () => {
  const scheduler = source("src/installer/agent-scheduler.ts");
  const stepOps = source("src/installer/step-ops.ts");
  const status = source("src/installer/status.ts");
  const workflow = source("src/cli/commands/workflow.ts");

  it("agent-scheduler.ts routes persisted policies through the Matchlock admission barrier", () => {
    assert.match(
      scheduler,
      /import \{ matchlockDispatchDecision \} from "\.\/matchlock\/dispatch-guard\.js";/,
      "the dispatch-guard import is the entry point of the admission route",
    );
    assert.match(
      scheduler,
      /if \(row\.matchlock_policy\) \{[\s\S]*?matchlockDispatchDecision\(row\.matchlock_policy, \{/,
      "the persisted policy must be checked at dispatch time",
    );
    assert.match(
      scheduler,
      /runMatchlockSchedulerRound/,
      "the union scheduler seam must be wired into the dispatch motor",
    );
    assert.match(
      scheduler,
      /runMatchlockLaunchTimeHarnessProbe/,
      "the launch-time probe must dispatch through the in-VM runner",
    );
    assert.match(
      scheduler,
      /matchlockWorkflowRequiresCapability/,
      "the merge-branch capability preflight must be present",
    );
    assert.match(
      scheduler,
      /buildMatchlockMergeContext/,
      "the host merge context builder must be present",
    );
  });

  it("agent-scheduler.ts refuses fail-closed (no native fallback) and never fabricates success", () => {
    // The refusal branch emits the distinct refusal event, force-fails the run
    // and returns before the probe/work round.
    assert.match(
      scheduler,
      /event: "run\.matchlock_dispatch_refused",[\s\S]*?forceFailRun\(job\.runId, decision\.message, true\)[\s\S]*?\/\/ Return WITHOUT spawning the probe or any work round\.\s*\n\s*return;/,
      "a refused policy must force-fail and return before any probe/work round",
    );
    // A refused round must not construct a native adapter in that branch. The
    // adapter is only created after the admission block via getHarnessAdapter.
    const admissionStart = scheduler.indexOf("matchlockDispatchDecision(row.matchlock_policy");
    assert.ok(admissionStart > 0, "admission block not found");
    const refusalBranch = scheduler.slice(admissionStart, scheduler.indexOf("// Return WITHOUT spawning"));
    assert.doesNotMatch(
      refusalBranch,
      /getHarnessAdapter\(/,
      "the refusal branch must not fall back to the native harness adapter",
    );
  });

  it("step-ops.ts keeps the structural Matchlock seams (progress resource + attested ledger)", () => {
    assert.match(stepOps, /export interface RunProgressAccessLike \{/, "progress accessor interface missing");
    assert.match(stepOps, /progressAccess\?: RunProgressAccessLike;/, "progressAccess option missing");
    assert.match(
      stepOps,
      /ledgerEvidenceSource\?: FinalizeMergeEvidenceSource;/,
      "host-attested finalizer evidence source missing",
    );
    // The seam must stay structural / opt-in: step-ops never imports the
    // matchlock implementation directly.
    const matchlockImports = stepOps
      .split("\n")
      .filter((line) => line.includes("from") && line.includes("matchlock"));
    assert.deepEqual(matchlockImports, [], "step-ops must not import the matchlock implementation");
  });

  it("workflow.ts delegates the shared status JSON builder (union seam) with main's preclaim field", () => {
    assert.match(
      workflow,
      /const jsonOutput = buildWorkflowStatusJson\(result\);/,
      "workflow.ts must delegate to the shared builder",
    );
    assert.match(
      status,
      /preclaimDeathCount: result\.preclaimDeathCount,/,
      "the shared builder must carry main's preclaimDeathCount field",
    );
  });
});

describe("US-007 core-motor reconciliation: main abstractions survive", () => {
  const scheduler = source("src/installer/agent-scheduler.ts");
  const stepOps = source("src/installer/step-ops.ts");
  const runCleanup = source("src/installer/run-cleanup.ts");

  it("keeps worker-pid claim hygiene (TAMANDUA_WORKER_PID dropped before spawn)", () => {
    assert.match(
      scheduler,
      /TAMANDUA_WORKER_PID: undefined,/,
      "the harness child env must drop an inherited worker pid",
    );
    assert.match(
      scheduler,
      /SWEEP_DAEMON_INSTANCE_ENV/,
      "the daemon-instance sweep marker must be stamped",
    );
    assert.match(
      scheduler,
      /getDaemonInstanceToken\(\)/,
      "the marker must come from the platform-neutral daemon identity",
    );
  });

  it("keeps the outage-class seam (harnessWallMs/vmSetupMs + preclaim backoff)", () => {
    assert.match(scheduler, /export function isPreclaimDeathBackoffActive\(/);
    assert.match(scheduler, /async function trackPreclaimDeathRound\(/);
    assert.match(scheduler, /trackInstantFailRound\(/);
    assert.match(scheduler, /harnessWallMs: result\?\.harnessWallMs,/);
    assert.match(scheduler, /vmSetupMs: result\?\.vmSetupMs,/);
    // The preclaim reset belongs to every successful claim UPDATE.
    assert.ok(
      occurrences(stepOps, "preclaim_death_count = 0") >= 3,
      "every claim path must reset the preclaim death counter",
    );
  });

  it("keeps the exclusive sweep ownership gate (cwd/cmdline never consulted)", () => {
    const start = runCleanup.indexOf("export function matchRunEvidence(");
    assert.ok(start > 0, "matchRunEvidence not found");
    const body = runCleanup.slice(start, runCleanup.indexOf("\n}", start));
    assert.match(
      body,
      /matchesSweepOwnership\(entry\.environ, runId, daemonInstance\)/,
      "the kill gate must require the daemon-scoped ownership marker",
    );
    assert.doesNotMatch(body, /\.cwd|\.cmdline|cwd\b|cmdline\b/, "the kill gate must never consult cwd/cmdline");
    assert.match(
      runCleanup,
      /cwd, environ mentions of the working directory[\s\S]*?NEVER create a match here/,
      "the exclusive-kill doc contract must stay",
    );
  });
});

describe("US-007 core-motor reconciliation: admission fails closed", () => {
  it("a NULL policy is native and never consults Matchlock", () => {
    const decision = matchlockDispatchDecision(null, { workflowId: "do-now", harnessType: "pi" });
    assert.equal(decision.refused, false);
  });

  it("a malformed stored policy is refused as invalid and never allowed", () => {
    const decision = matchlockDispatchDecision("{not json", { workflowId: "do-now", harnessType: "pi" });
    assert.equal(decision.refused, true);
    if (decision.refused) {
      assert.equal(decision.code, "matchlock_policy_invalid");
      assert.match(decision.message, /never fall back to native execution/);
    }
  });

  it("an unsupported workflow is refused before any probe/VM", () => {
    // A structurally valid but legacy/unpinned record must not be mistaken for
    // a working isolated run; the gate parses strictly and refuses.
    const decision = matchlockDispatchDecision("{}", { workflowId: "just-do-it", harnessType: "pi" });
    assert.equal(decision.refused, true);
  });
});
