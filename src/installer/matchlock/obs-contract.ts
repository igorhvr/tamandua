/**
 * obs-contract.ts — MATCHLOCK-OBS US-007 (beads tamandua-6sy.33.10.32 and .33).
 *
 * Pure builder for this run's required external deliverable
 * `/home/kaladin/matchlock-work/matchlock-obs-contract.json`: it documents the
 * two root causes (a symlink-spelled work/evidence path denied by the guest
 * suite transport; stopped-VM accumulation because every Matchlock round called
 * `close` and never `rm`), the fixes with their files/functions, the tests that
 * cover them, the required gate commands with whatever REAL result is recorded,
 * the run-83/union3 baseline comparison copied verbatim, the VM lifecycle and an
 * honest verdict.
 *
 * The core {@link buildMatchlockObsContract} is PURE: it performs no I/O and
 * reads no clock — the caller supplies `generatedAt`, `baselineComparison` and
 * any recorded gate results. A gate without a recorded result stays
 * `status: "pending"` and FORCES a non-green verdict; there is no code path that
 * can fake green (see {@link gateAccepted} / {@link deriveVerdict}).
 *
 * {@link publishMatchlockObsContract} is the thin I/O shell: it reads the union3
 * contract (for `baselineComparison`), optionally reads a gate-results JSON,
 * builds and writes the deliverable. Running this module directly regenerates
 * it (the module is imported by its test, so the orphan-module guard stays
 * green):
 *
 *   node dist/installer/matchlock/obs-contract.js
 *
 * Env overrides: MATCHLOCK_OBS_CONTRACT_OUT, MATCHLOCK_OBS_UNION3_CONTRACT,
 * MATCHLOCK_OBS_GATE_RESULTS, MATCHLOCK_OBS_GENERATED_AT.
 *
 * Releasing with real gate results: write a JSON file shaped either as
 * `{ "gates": { "<gateId>": { status, exitCode, logPath, command?, note? } } }`
 * or directly as the gate map, point MATCHLOCK_OBS_GATE_RESULTS at it (or pass
 * `gateResultsPath`) and re-run the module. A gate whose result is absent stays
 * pending and keeps the verdict non-green.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Schema identifier for the MATCHLOCK-OBS deliverable. */
export const MATCHLOCK_OBS_CONTRACT_SCHEMA = "matchlock-obs-contract/1";

/** Canonical external deliverable path (OUTSIDE the repository; never committed). */
export const DEFAULT_MATCHLOCK_OBS_CONTRACT_PATH =
  "/home/kaladin/matchlock-work/matchlock-obs-contract.json";

/** Canonical union3 contract whose `baselineComparison` is copied verbatim. */
export const DEFAULT_MATCHLOCK_UNION3_CONTRACT_PATH =
  "/home/kaladin/matchlock-work/matchlock-union3-contract.json";

/** The exclusive gate lock the run's real-VM gates and TEST_CMD share. */
export const MATCHLOCK_OBS_GATE_LOCK = "flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock";

/**
 * Optional runtime env file the obs gate commands `source` before a gate; the
 * gate scripts themselves resolve `matchlock` from PATH and treat the three
 * runtime vars as optional overrides (MTLK-UNPIN).
 */
export const MATCHLOCK_OBS_RUNTIME_ENV = "/home/kaladin/matchlock-work/matchlock-runtime.env";

/** Canonical evidence root (the symlink spelling is the /root alias). */
export const MATCHLOCK_OBS_EVIDENCE_ROOT = "/home/kaladin/matchlock-work/evidence";

/** Symlink-spelled evidence root on vaimetal (/root/matchlock-work -> /home/kaladin/matchlock-work). */
export const MATCHLOCK_OBS_EVIDENCE_ROOT_SYMLINK = "/root/matchlock-work/evidence";

/** The four required gates, in the order they are reported. */
export const MATCHLOCK_OBS_REQUIRED_GATES = [
  "npmTest",
  "syntheticCanonical",
  "syntheticSymlink",
  "worktreeMerge",
] as const;

export type MatchlockObsGateId = (typeof MATCHLOCK_OBS_REQUIRED_GATES)[number];

export interface MatchlockObsRunMeta {
  runId: string;
  repo: string;
  worktree: string;
  branch: string;
  integrationBranch: string;
  baseCommit: string;
}

export interface MatchlockObsTask extends MatchlockObsRunMeta {
  id: string;
  title: string;
  beads: string[];
  description: string;
}

export interface MatchlockObsRootCause {
  id: string;
  bead: string;
  title: string;
  description: string;
  mechanism: string;
  fixedBy: string[];
}

export interface MatchlockObsFixTestRef {
  file: string;
  lane: "serial" | "parallel";
  cases: string;
}

export interface MatchlockObsFix {
  id: string;
  rootCauseId: string;
  file: string;
  function: string;
  summary: string;
  tests: MatchlockObsFixTestRef[];
}

export interface MatchlockObsTestRef {
  file: string;
  lane: "serial" | "parallel";
  story: string;
  command: string;
  cases: string;
}

export interface MatchlockObsFinding {
  id: string;
  severity: "informational" | "low" | "medium" | "high";
  classification: string;
  title: string;
  description: string;
  evidence: string[];
}

/** A recorded result for one required gate (all fields optional). */
export interface MatchlockObsGateInput {
  status?: string;
  exitCode?: number | null;
  logPath?: string;
  command?: string;
  note?: string;
}

export interface MatchlockObsGate {
  id: MatchlockObsGateId;
  label: string;
  name: string;
  command: string;
  status: string;
  exitCode: number | null;
  logPath: string;
  accepted: boolean;
  note?: string;
}

export interface MatchlockObsVmLifecycle {
  allOwnedVmsClosed: boolean;
  gates: Record<string, unknown>;
  note: string;
}

export interface MatchlockObsVerdict {
  green: boolean;
  readyToInstallOnVaimetal: boolean;
  blockingGate: string | null;
  nonGreenReasons: string[];
  note: string;
}

export interface MatchlockObsContract {
  schema: string;
  generatedAt: string;
  task: MatchlockObsTask;
  rootCauses: MatchlockObsRootCause[];
  fixes: MatchlockObsFix[];
  tests: MatchlockObsTestRef[];
  gates: Record<MatchlockObsGateId, MatchlockObsGate>;
  baselineComparison: unknown;
  vmLifecycle: MatchlockObsVmLifecycle;
  findings: MatchlockObsFinding[];
  verdict: MatchlockObsVerdict;
  noFakeGreen: string;
}

export interface MatchlockObsContractInput {
  /** ISO timestamp supplied by the caller (the builder never reads the clock). */
  generatedAt: string;
  /**
   * The union3 contract's `baselineComparison` object (use
   * {@link baselineComparisonFromUnion3Contract} to extract it). Required so
   * the deliverable's baseline/observed failure sets are never fabricated.
   */
  baselineComparison: unknown;
  /** Recorded gate results; a gate with no entry stays `pending`. */
  gates?: Partial<Record<MatchlockObsGateId, MatchlockObsGateInput>>;
  /** Run metadata overrides (defaults to this run). */
  run?: Partial<MatchlockObsRunMeta>;
  /** VM lifecycle overrides. */
  vmLifecycle?: Partial<MatchlockObsVmLifecycle>;
  /** Extra findings appended after the built-in ones. */
  findings?: MatchlockObsFinding[];
  /** Extra test refs appended after the built-in ones. */
  extraTests?: MatchlockObsTestRef[];
}

/** The run this deliverable documents. */
export const MATCHLOCK_OBS_RUN_META: MatchlockObsRunMeta = {
  runId: "feacfb31-ef3f-4b71-b98e-742621e85239",
  repo: "/home/kaladin/.tamandua/worktrees/tamandua-origin-matchlock-299200b1/24-feacfb31",
  worktree: "/home/kaladin/.tamandua/worktrees/tamandua-origin-matchlock-299200b1/24-feacfb31",
  branch: "feature/matchlock-obs-symlink-admission-vm-removal",
  integrationBranch: "integration/matchlock-20260915",
  baseCommit: "c23f2ed5",
};

const MATCHLOCK_OBS_TASK_BASE: Omit<MatchlockObsTask, keyof MatchlockObsRunMeta> = {
  id: "MATCHLOCK-OBS",
  title: "Symlinked work paths admitted, and VMs removed after positive close",
  beads: ["tamandua-6sy.33.10.32", "tamandua-6sy.33.33"],
  description:
    "Two Matchlock observability findings: (1) the guest suite transport denied a work/evidence path " +
    "spelled through a symlink because it admitted repository roots by canonical path while the guest " +
    "presented its exact cwd spelling, so no host_suite_results row was recorded; (2) every Matchlock " +
    "round called `close` but never `rm`, leaving a stopped VM row + ~/.matchlock/vms/<id>/ dir per " +
    "round (probe + work).",
};

/** Per-gate static identity. */
const REQUIRED_GATE_META: Record<MatchlockObsGateId, { label: string; name: string }> = {
  npmTest: {
    label: "A",
    name: "npm test via the tamandua-test shim (accepted only as a baseline subset)",
  },
  syntheticCanonical: {
    label: "C-1",
    name: "Matchlock synthetic (pi) real-VM gate — canonical evidence root",
  },
  syntheticSymlink: {
    label: "C-1s",
    name: "Matchlock synthetic (pi) real-VM gate — symlink-spelled evidence root",
  },
  worktreeMerge: {
    label: "C-2",
    name: "Matchlock worktree-merge real-VM gate",
  },
};

/** The exact gate command for a gate id, parameterized by the run metadata. */
export function requiredGateCommand(id: MatchlockObsGateId, run: MatchlockObsRunMeta): string {
  const runtime = `source ${MATCHLOCK_OBS_RUNTIME_ENV}`;
  switch (id) {
    case "npmTest":
      return (
        `${MATCHLOCK_OBS_GATE_LOCK} tamandua-test --repo '${run.repo}' ` +
        `--run '${run.runId}' --step 'implement' -- 'npm test'`
      );
    case "syntheticCanonical":
      return (
        `${runtime} && TAMANDUA_GATE_EVIDENCE_ROOT=${MATCHLOCK_OBS_EVIDENCE_ROOT} ` +
        `${MATCHLOCK_OBS_GATE_LOCK} ./run-matchlock-synthetic-e2e-test`
      );
    case "syntheticSymlink":
      return (
        `${runtime} && TAMANDUA_GATE_EVIDENCE_ROOT=${MATCHLOCK_OBS_EVIDENCE_ROOT_SYMLINK} ` +
        `${MATCHLOCK_OBS_GATE_LOCK} ./run-matchlock-synthetic-e2e-test`
      );
    case "worktreeMerge":
      return `${runtime} && ${MATCHLOCK_OBS_GATE_LOCK} ./run-matchlock-worktree-merge-e2e-test`;
  }
}

/**
 * The two root causes this run fixes. Root cause 1 is bead tamandua-6sy.33.10.32,
 * root cause 2 is bead tamandua-6sy.33.33.
 */
export const MATCHLOCK_OBS_ROOT_CAUSES: readonly MatchlockObsRootCause[] = [
  {
    id: "suite-transport-denied-symlink-spelled-work-path",
    bead: "tamandua-6sy.33.10.32",
    title: "Guest suite transport denied a symlink-spelled work/evidence path",
    description:
      "A run whose harness working directory (or evidence root) is spelled through a symlink boots fine " +
      "and claims/completes its step through the guest CLI, but the guest's packed tamandua-test reports " +
      "'passthrough mode — suite transport refused lookup (DENIED): origin_repo is not one of this " +
      "invocation's admitted repository roots', so no host_suite_results row is recorded and the gate's " +
      "assertRunEvidence fails.",
    mechanism:
      "The mount plan admits repository roots by canonical path (realpath) while the guest presents " +
      "origin_repo in the EXACT host spelling of its cwd. HostSuiteService.rootRefusal compared the " +
      "guest-presented origin_repo to binding.admittedRoots with string equality alone, so a symlink " +
      "spelling of an admitted root was refused. Design intent: exact spellings are preserved on both " +
      "sides and canonical targets are recorded separately, so admission must compare by realpath " +
      "identity, never by string equality alone.",
    fixedBy: ["repository-scope.admittedRootMatches", "host-suite-service.rootRefusal"],
  },
  {
    id: "stopped-vm-accumulation-after-close",
    bead: "tamandua-6sy.33.33",
    title: "Every Matchlock round left a stopped VM row + state dir",
    description:
      "Production hosts accumulated stopped VM rows and ~/.matchlock/vms/<id>/ state dirs — two per round " +
      "(the launch-probe VM and the work VM) — because they were stopped but never removed.",
    mechanism:
      "The product called the matchlock rpc 'close' (stops the VM, KEEPS the row and " +
      "~/.matchlock/vms/<id>/) and never 'rm'. There was no post-close reaper that copied the VM's " +
      "retained logs/config into the run's evidence and then removed the VM, so nothing bounded the " +
      "accumulation.",
    fixedBy: [
      "vm-evidence.captureAndRemoveVm",
      "pi-invocation-runner.cleanup",
      "hermes-invocation-runner.cleanup",
      "matchlock-gate-lifecycle.assertNoOwnedVms",
    ],
  },
];

/** The fixes, each naming its file + function and the tests that cover it. */
export const MATCHLOCK_OBS_FIXES: readonly MatchlockObsFix[] = [
  {
    id: "realpath-identity-admitted-root-matching",
    rootCauseId: "suite-transport-denied-symlink-spelled-work-path",
    file: "src/installer/matchlock/repository-scope.ts",
    function: "admittedRootMatches",
    summary:
      "String-equality fast path, then realpath identity via canonicalRealPath; never throws and never " +
      "accepts a root outside the admitted set. Accompanied by admittedRootsFromPolicy (pi-invocation-runner.ts) " +
      "recording BOTH the exact host spelling and the canonical target for originalRepositoryRoot and every " +
      "workMount entry, deduped.",
    tests: [
      {
        file: "src/installer/matchlock/repository-scope.test.ts",
        lane: "serial",
        cases:
          "symlink both directions, identical string, unrelated root, absent requested path (no throw), " +
          "prefix-sharing sibling rejected, admittedRootsFromPolicy both spellings + dedupe + order",
      },
    ],
  },
  {
    id: "suite-transport-realpath-admission",
    rootCauseId: "suite-transport-denied-symlink-spelled-work-path",
    file: "src/installer/matchlock/host-suite-service.ts",
    function: "rootRefusal",
    summary:
      "Admits a symlink-spelled origin_repo against a canonical-only admitted root (and vice versa) by " +
      "calling admittedRootMatches. The exact DENIED message and every other guard are unchanged, and " +
      "origin_repo is NEVER canonicalized: the guest-presented spelling remains the exact ledger key.",
    tests: [
      {
        file: "src/installer/matchlock/host-suite-service.test.ts",
        lane: "serial",
        cases:
          "symlink spelling admitted against canonical root (claim + record + lookup; stored origin_repo " +
          "equals the request spelling), canonical admitted against symlink-only root, unadmitted root and " +
          "real prefix sibling still refused with the exact DENIED message",
      },
    ],
  },
  {
    id: "bounded-vm-evidence-capture-and-removal",
    rootCauseId: "stopped-vm-accumulation-after-close",
    file: "src/installer/matchlock/vm-evidence.ts",
    function: "captureAndRemoveVm",
    summary:
      "Copies config.json + every regular file under logs/ into the run's evidence destination (bounded, " +
      "symlink-safe, per-file best-effort) BEFORE spawning `matchlock rm <vmId>` with HOME forced to the " +
      "effective matchlock HOME. Never throws; a genuine failure yields removed:false + a bounded " +
      "removalError and never blocks the round.",
    tests: [
      {
        file: "src/installer/matchlock/vm-evidence.test.ts",
        lane: "serial",
        cases:
          "copy-before-rm ordering with exact argv + forced HOME, default prefix, non-zero failure bounded, " +
          "large stderr bounded, already-absent state dir, already-gone rm result, symlink escape skipped, " +
          "missing CLI, unsafe/empty vm ids",
      },
    ],
  },
  {
    id: "pi-runner-reaps-after-confirmed-close",
    rootCauseId: "stopped-vm-accumulation-after-close",
    file: "src/installer/matchlock/pi-invocation-runner.ts",
    function: "cleanup / reapVmEvidence",
    summary:
      "After controller.close(...) resolves with a POSITIVELY confirmed close (isClosed), resolves the " +
      "owned vmId and calls captureAndRemoveVm with destination <runRoot>/<bareRunId>/matchlock/<vmId>; " +
      "records vmRemoved/vmLogsCopiedTo/vmRemovalError on every round result that reached a confirmed " +
      "close. A removal failure never enters the cleanup error list and never changes cleanupConfirmed.",
    tests: [
      {
        file: "src/installer/matchlock/pi-invocation-runner.test.ts",
        lane: "serial",
        cases:
          "probe + work rounds copy evidence and issue exactly one rm with the effective HOME and leave no " +
          "state dir; a failing rm yields vmRemoved:false + bounded error with the round still completing; " +
          "an unconfirmed close and a dispose-only teardown issue no rm",
      },
    ],
  },
  {
    id: "hermes-runner-reaps-after-confirmed-close",
    rootCauseId: "stopped-vm-accumulation-after-close",
    file: "src/installer/matchlock/hermes-invocation-runner.ts",
    function: "cleanup / reapVmEvidence",
    summary:
      "The Hermes runner has its OWN cleanup closure (it does not route through the pi runner), so it " +
      "mirrors the same post-confirmed-close reaper wiring and outcome fields.",
    tests: [
      {
        file: "src/installer/matchlock/hermes-invocation-runner.test.ts",
        lane: "serial",
        cases:
          "source assertion that the runner has no direct child_process import, probe + work rounds copy " +
          "evidence and remove the VM, failing rm is reportable, unconfirmed close and dispose-only issue " +
          "no rm",
      },
    ],
  },
  {
    id: "gates-assert-no-owned-vm-remains",
    rootCauseId: "stopped-vm-accumulation-after-close",
    file: "e2e-tests/helpers/matchlock-gate-lifecycle.ts",
    function: "assertNoOwnedVms / readRunnerVmEvidenceIds",
    summary:
      "The real-VM gates now prove the RUNNER removed every probe/work VM (no gate-side rm needed): " +
      "assertNoOwnedVms fails naming every leftover row/state-dir id and tolerates an already-removed VM; " +
      "readRunnerVmEvidenceIds counts the runner's retained per-VM evidence dirs as the deterministic " +
      "post-run proof of a fresh VM per invocation.",
    tests: [
      {
        file: "tests/matchlock-gate-lifecycle.test.ts",
        lane: "parallel",
        cases:
          "passes on zero rows/dirs and on an absent DB, fails naming every leftover row and dir, records " +
          "the bounded matchlock list result, and readRunnerVmEvidenceIds ownership/prefix/absent behavior",
      },
    ],
  },
];

/** Test refs for the stories that implemented the two fixes. */
export const MATCHLOCK_OBS_TESTS: readonly MatchlockObsTestRef[] = [
  {
    file: "src/installer/matchlock/repository-scope.test.ts",
    lane: "serial",
    story: "US-001",
    command: "node --test --test-concurrency=1 src/installer/matchlock/repository-scope.test.ts",
    cases: "realpath-identity admitted-root matching + both policy spellings",
  },
  {
    file: "src/installer/matchlock/host-suite-service.test.ts",
    lane: "serial",
    story: "US-002",
    command: "node --test --test-concurrency=1 src/installer/matchlock/host-suite-service.test.ts",
    cases: "suite transport admits a symlink-spelled origin_repo by realpath identity",
  },
  {
    file: "src/installer/matchlock/vm-evidence.test.ts",
    lane: "serial",
    story: "US-003",
    command: "node --test --test-concurrency=1 src/installer/matchlock/vm-evidence.test.ts",
    cases: "bounded VM evidence capture + removal with a fake matchlock CLI",
  },
  {
    file: "src/installer/matchlock/pi-invocation-runner.test.ts",
    lane: "serial",
    story: "US-004",
    command: "node --test --test-concurrency=1 src/installer/matchlock/pi-invocation-runner.test.ts",
    cases: "pi/dsh runner captures evidence + removes the VM after a confirmed close",
  },
  {
    file: "src/installer/matchlock/hermes-invocation-runner.test.ts",
    lane: "serial",
    story: "US-005",
    command: "node --test --test-concurrency=1 src/installer/matchlock/hermes-invocation-runner.test.ts",
    cases: "hermes runner captures evidence + removes the VM after a confirmed close",
  },
  {
    file: "tests/matchlock-gate-lifecycle.test.ts",
    lane: "parallel",
    story: "US-006",
    command: "node --test tests/matchlock-gate-lifecycle.test.ts",
    cases: "gates assert no owned VM remains + already-removed tolerance",
  },
  {
    file: "src/installer/matchlock/obs-contract.test.ts",
    lane: "parallel",
    story: "US-007",
    command: "node --test src/installer/matchlock/obs-contract.test.ts",
    cases:
      "builder shape/keys, pending forces non-green, baseline copy, both root causes, publisher round-trip",
  },
];

/** Findings beyond the two root causes (anything else found during the run). */
export const MATCHLOCK_OBS_FINDINGS: readonly MatchlockObsFinding[] = [
  {
    id: "host-origin-advanced-update-warning",
    severity: "informational",
    classification: "host-environment, not code-caused",
    title: "origin/main advanced during the run -> CLI update warning fails two control-plane tests",
    description:
      "While this branch was developed, origin/main (18a3cbe3) moved ahead of the branch base c23f2ed5. " +
      "The CLI version check therefore reports an update and writes the warning " +
      "'WARNING: A new version of tamandua is available!' to stderr, which fails the two " +
      "tests/control-plane-cli.test.ts assertions that expect empty stderr. The producing files " +
      "(tests/control-plane-cli.test.ts, src/server/daemon.ts, src/lib/version-check.ts) are untouched by " +
      "this run, so this is recorded as a host-environment delta rather than a strict baseline subset.",
    evidence: [
      "tests/control-plane-cli.test.ts: status shows running state when up",
      "tests/control-plane-cli.test.ts: stop kills process and prints confirmation",
      "origin/main 18a3cbe3 ahead of branch base c23f2ed5",
    ],
  },
  {
    id: "vm-removal-changes-gate-vm-counting",
    severity: "informational",
    classification: "intended behavior change",
    title: "Removing VMs required gates to count retained evidence dirs, not VM rows",
    description:
      "Once the runner removes each VM after a confirmed close, a real-VM gate can no longer count " +
      "post-run VM rows to prove a fresh VM per invocation. The gates now use readRunnerVmEvidenceIds " +
      "(<runRoot>/<bareRunId>/matchlock/<vmId>/ dirs) as the deterministic replacement, and assertNoOwnedVms " +
      "proves nothing is left. Because run.completed is emitted while the last round's cleanup may still be " +
      "in flight, the post-run assertion polls rather than assuming immediate absence.",
    evidence: [
      "e2e-tests/helpers/matchlock-gate-lifecycle.ts: readRunnerVmEvidenceIds",
      "e2e-tests/helpers/matchlock-gate-lifecycle.ts: assertNoOwnedVms",
    ],
  },
  {
    id: "reaper-duplicated-in-pi-and-hermes-runners",
    severity: "low",
    classification: "known duplication, no follow-up required",
    title: "The post-close reaper wiring is duplicated between the pi and hermes runners",
    description:
      "The Hermes runner has its own cleanup closure, so the same captureAndRemoveVm wiring (destination, " +
      "effective HOME, binary seam, outcome fields, warn logging) is implemented twice. A shared helper " +
      "would remove the duplication; it is left as-is because the two runners' cleanup lifecycles differ " +
      "enough that the shared helper is not a pure lift.",
    evidence: [
      "src/installer/matchlock/pi-invocation-runner.ts: reapVmEvidence",
      "src/installer/matchlock/hermes-invocation-runner.ts: reapVmEvidence",
    ],
  },
];

const NO_FAKE_GREEN =
  "No gate is green unless it recorded a real accepted result. A gate without a recorded result stays " +
  "status 'pending' and forces a non-green verdict; the deliverable is never faked green.";

/** Deep-clone JSON-safe data so the built contract never aliases caller/constant state. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether a settled gate counts as an accepted green result.
 *
 *  - `pending` (or a missing status) is never accepted;
 *  - a settled gate must carry a numeric exitCode and a non-empty logPath;
 *  - `green` requires exitCode 0;
 *  - `baseline-subset` is the accepted npm-test outcome (exitCode may be non-zero).
 *
 * Any other status (red, known-pre-existing-blocker, ...) is NOT accepted and
 * forces a non-green verdict — there is no way to fake green.
 */
export function gateAccepted(
  status: string,
  exitCode: number | null,
  logPath: string,
): boolean {
  if (status === "pending") return false;
  if (typeof exitCode !== "number") return false;
  if (logPath.trim() === "") return false;
  if (status === "baseline-subset") return true;
  if (status === "green") return exitCode === 0;
  return false;
}

function settleGates(
  inputs: Partial<Record<MatchlockObsGateId, MatchlockObsGateInput>> | undefined,
  run: MatchlockObsRunMeta,
): Record<MatchlockObsGateId, MatchlockObsGate> {
  const out = {} as Record<MatchlockObsGateId, MatchlockObsGate>;
  for (const id of MATCHLOCK_OBS_REQUIRED_GATES) {
    const meta = REQUIRED_GATE_META[id];
    const raw = inputs?.[id];
    const status =
      typeof raw?.status === "string" && raw.status.trim() !== "" ? raw.status : "pending";
    const exitCode = typeof raw?.exitCode === "number" ? raw.exitCode : null;
    const logPath = typeof raw?.logPath === "string" ? raw.logPath : "";
    const command =
      typeof raw?.command === "string" && raw.command.trim() !== ""
        ? raw.command
        : requiredGateCommand(id, run);
    const accepted = gateAccepted(status, exitCode, logPath);
    const gate: MatchlockObsGate = {
      id,
      label: meta.label,
      name: meta.name,
      command,
      status,
      exitCode,
      logPath,
      accepted,
    };
    if (typeof raw?.note === "string" && raw.note.trim() !== "") gate.note = raw.note;
    out[id] = gate;
  }
  return out;
}

function settleVmLifecycle(
  input: Partial<MatchlockObsVmLifecycle> | undefined,
): MatchlockObsVmLifecycle {
  const allOwnedVmsClosed = input?.allOwnedVmsClosed === true;
  const gates = isRecord(input?.gates) ? clone(input.gates) : {};
  const note =
    typeof input?.note === "string" && input.note.trim() !== ""
      ? input.note
      : allOwnedVmsClosed
        ? "Every owned probe/work VM was positively closed and then removed; nothing remains."
        : "No gate has yet reported all owned VMs positively closed and removed.";
  return { allOwnedVmsClosed, gates, note };
}

/**
 * Derive the verdict from the settled gates + VM lifecycle. A pending or
 * non-accepted gate forces `green: false` (never fake green).
 */
export function deriveVerdict(
  gates: Record<MatchlockObsGateId, MatchlockObsGate>,
  vmLifecycle: MatchlockObsVmLifecycle,
): MatchlockObsVerdict {
  const nonGreenReasons: string[] = [];
  let blockingGate: string | null = null;
  for (const id of MATCHLOCK_OBS_REQUIRED_GATES) {
    const gate = gates[id];
    if (gate.status === "pending") {
      nonGreenReasons.push(`gate ${id}: no recorded result (status 'pending')`);
      if (blockingGate === null) blockingGate = id;
    } else if (!gate.accepted) {
      nonGreenReasons.push(
        `gate ${id}: status '${gate.status}' exitCode ${String(gate.exitCode)} is not an accepted green result`,
      );
      if (blockingGate === null) blockingGate = id;
    }
  }
  if (nonGreenReasons.length === 0 && !vmLifecycle.allOwnedVmsClosed) {
    nonGreenReasons.push("vmLifecycle.allOwnedVmsClosed is not true");
    if (blockingGate === null) blockingGate = "vmLifecycle";
  }
  const green = nonGreenReasons.length === 0;
  return {
    green,
    readyToInstallOnVaimetal: green,
    blockingGate: green ? null : blockingGate,
    nonGreenReasons,
    note: green
      ? "Every required gate recorded an accepted result and no owned VM remains."
      : "Not green: at least one required gate has no accepted result. The deliverable reports this honestly and is never faked green.",
  };
}

/**
 * Extract the `baselineComparison` object from a parsed union3 contract so the
 * deliverable copies the baseline/observed failure sets verbatim.
 */
export function baselineComparisonFromUnion3Contract(union3: unknown): unknown {
  if (!isRecord(union3) || !isRecord(union3.baselineComparison)) {
    throw new TypeError("union3 contract has no baselineComparison object to copy");
  }
  return clone(union3.baselineComparison);
}

/**
 * Compose the MATCHLOCK-OBS contract. PURE: no I/O, no clock. `generatedAt`
 * and `baselineComparison` are required; gate results are optional and a gate
 * with no recorded result stays `pending`.
 */
export function buildMatchlockObsContract(input: MatchlockObsContractInput): MatchlockObsContract {
  if (!isRecord(input)) {
    throw new TypeError("buildMatchlockObsContract requires an input object");
  }
  if (typeof input.generatedAt !== "string" || input.generatedAt.trim() === "") {
    throw new TypeError("buildMatchlockObsContract: generatedAt must be a non-empty string");
  }
  if (input.baselineComparison === undefined) {
    throw new TypeError(
      "buildMatchlockObsContract: baselineComparison is required (copy it from the union3 contract)",
    );
  }

  const run: MatchlockObsRunMeta = { ...MATCHLOCK_OBS_RUN_META, ...(input.run ?? {}) };
  const task: MatchlockObsTask = { ...MATCHLOCK_OBS_TASK_BASE, ...run };
  const gates = settleGates(input.gates, run);
  const vmLifecycle = settleVmLifecycle(input.vmLifecycle);
  const findings: MatchlockObsFinding[] = [
    ...MATCHLOCK_OBS_FINDINGS.map((finding) => clone(finding)),
    ...(input.findings ?? []).map((finding) => clone(finding)),
  ];
  const tests: MatchlockObsTestRef[] = [
    ...MATCHLOCK_OBS_TESTS.map((test) => clone(test)),
    ...(input.extraTests ?? []).map((test) => clone(test)),
  ];
  const verdict = deriveVerdict(gates, vmLifecycle);

  return {
    schema: MATCHLOCK_OBS_CONTRACT_SCHEMA,
    generatedAt: input.generatedAt,
    task,
    rootCauses: MATCHLOCK_OBS_ROOT_CAUSES.map((cause) => clone(cause)),
    fixes: MATCHLOCK_OBS_FIXES.map((fix) => clone(fix)),
    tests,
    gates,
    baselineComparison: clone(input.baselineComparison),
    vmLifecycle,
    findings,
    verdict,
    noFakeGreen: NO_FAKE_GREEN,
  };
}

/** Accept either `{ gates: {...} }` or the gate map itself. */
export function extractGateInputs(parsed: unknown): Partial<Record<MatchlockObsGateId, MatchlockObsGateInput>> {
  if (!isRecord(parsed)) return {};
  const candidate = isRecord(parsed.gates) ? parsed.gates : parsed;
  const out: Partial<Record<MatchlockObsGateId, MatchlockObsGateInput>> = {};
  for (const id of MATCHLOCK_OBS_REQUIRED_GATES) {
    const raw = candidate[id];
    if (!isRecord(raw)) continue;
    const gate: MatchlockObsGateInput = {};
    if (typeof raw.status === "string") gate.status = raw.status;
    if (typeof raw.exitCode === "number" || raw.exitCode === null) gate.exitCode = raw.exitCode as number | null;
    if (typeof raw.logPath === "string") gate.logPath = raw.logPath;
    if (typeof raw.command === "string") gate.command = raw.command;
    if (typeof raw.note === "string") gate.note = raw.note;
    out[id] = gate;
  }
  return out;
}

export interface PublishMatchlockObsContractOptions {
  /** Output path; defaults to MATCHLOCK_OBS_CONTRACT_OUT then the canonical deliverable. */
  outputPath?: string;
  /** Union3 contract to copy `baselineComparison` from. */
  union3ContractPath?: string;
  /** Optional JSON with recorded gate results. */
  gateResultsPath?: string;
  /** ISO timestamp; defaults to now. */
  generatedAt?: string;
  /** Run metadata overrides. */
  run?: Partial<MatchlockObsRunMeta>;
  /** VM lifecycle overrides (a gate-results file may also carry `vmLifecycle`). */
  vmLifecycle?: Partial<MatchlockObsVmLifecycle>;
  /** Extra findings. */
  findings?: MatchlockObsFinding[];
}

/**
 * Read the union3 baseline + optional gate results, build and write the
 * deliverable. This is the only I/O in this module; the builder it delegates to
 * stays pure.
 */
export function publishMatchlockObsContract(
  opts: PublishMatchlockObsContractOptions = {},
): MatchlockObsContract {
  const union3Path =
    opts.union3ContractPath ??
    process.env.MATCHLOCK_OBS_UNION3_CONTRACT ??
    DEFAULT_MATCHLOCK_UNION3_CONTRACT_PATH;
  const union3 = JSON.parse(fs.readFileSync(union3Path, "utf8"));
  const baselineComparison = baselineComparisonFromUnion3Contract(union3);

  const gateResultsPath = opts.gateResultsPath ?? process.env.MATCHLOCK_OBS_GATE_RESULTS;
  const gateResultsRaw =
    gateResultsPath && gateResultsPath.trim() !== "" && fs.existsSync(gateResultsPath)
      ? (JSON.parse(fs.readFileSync(gateResultsPath, "utf8")) as unknown)
      : undefined;
  const gates = gateResultsRaw === undefined ? undefined : extractGateInputs(gateResultsRaw);
  const vmLifecycle =
    opts.vmLifecycle ??
    (isRecord(gateResultsRaw) && isRecord(gateResultsRaw.vmLifecycle)
      ? (gateResultsRaw.vmLifecycle as Partial<MatchlockObsVmLifecycle>)
      : undefined);

  const contract = buildMatchlockObsContract({
    generatedAt:
      opts.generatedAt ?? process.env.MATCHLOCK_OBS_GENERATED_AT ?? new Date().toISOString(),
    baselineComparison,
    gates,
    run: opts.run,
    vmLifecycle,
    findings: opts.findings,
  });

  const outputPath =
    opts.outputPath ?? process.env.MATCHLOCK_OBS_CONTRACT_OUT ?? DEFAULT_MATCHLOCK_OBS_CONTRACT_PATH;
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  return contract;
}

/** True when this module is the process entry point (enables `node dist/...`). */
function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  const contract = publishMatchlockObsContract();
  process.stdout.write(
    `matchlock-obs-contract written: green=${String(contract.verdict.green)} ` +
      `blockingGate=${String(contract.verdict.blockingGate)}\n`,
  );
}
