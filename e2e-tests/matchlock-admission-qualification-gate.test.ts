/******************************************************************************
 * ⚠️  SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * G8 ADMISSION-INTEGRATION US-011 (bead tamandua-7p5.1.8) — the on-demand
 * qualification gate for the Matchlock launch gate. It is deliberately
 * NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand through its driver,
 * which builds first, installs a private HOME/TMPDIR/state, seeds a private
 * image store and holds the shared gate lock:
 *
 *   ./run-matchlock-admission-qualification-e2e-test
 *
 * (The driver takes the shared lock exactly once via
 * scripts/tests/matchlock/lib/lock.sh:
 *   flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock
 * and exports MTLK_GATE_LOCK_HELD=1 so a composed caller never re-acquires.)
 *
 * What this file contains:
 *
 *   1. NO-VM CONTROLS (always run; no VM, no model, no daemon). They drive the
 *      PRODUCTION wiring (dist/installer/matchlock/launch-gate-wiring.js) over
 *      disposable real profile homes, so the qualification evidence shapes are
 *      exercised on every run: refusal-first receipt, the G9 exit code, the
 *      closed ten-code vocabulary, aggregation across every contract store,
 *      the "no receipt before vmCreated" launch rule, the operational
 *      receipt-write refusal, and the shared round-evidence/zero-round refusal
 *      contract. They need `npm run build` first (the driver builds; a bare
 *      `node --test` run needs a prior build).
 *
 *   2. The REAL-VM TIER (opt-in). It is skipped unless the driver exported an
 *      evidence dir and the matchlock CLI: it checks the tier's surroundings
 *      (lock handshake, private HOME/TMPDIR/state, seeded image store, zero
 *      owned VMs), records the observed runtime identity as artifact-binding
 *      evidence, and records the observed in-VM round count through the shared
 *      helper. A zero-round result is a REFUSAL, never a green run. It drives
 *      SCENARIO A (refusal before any VM; admission with a real VM) and
 *      SCENARIO C (mixed native/guest overlap; the transient rollback-journal
 *      refusal) through the real run path.
 *
 * SCOPE AND HONESTY:
 *   - SCENARIO C is the MIXED-OVERLAP qualification. C1 keeps every committed
 *     record and passes `PRAGMA integrity_check` after overlapping NATIVE and
 *     GUEST writers; C2 shows that a nonempty `-journal` refuses with
 *     `sidecar-unresolved` and the rollback-journal remedy, and that the next
 *     observation allows once the journal is removed after quiescence. Neither
 *     unconditional admission during every transaction nor process-lifetime
 *     exclusivity is claimed: the evidence states the no-lease limitation.
 *   - The scenarios that drive the real run path (isolated daemon →
 *     scheduler → Matchlock hermes runner) live in US-012 (A) and US-013 (C);
 *     a VM-less host records the VM-boot block as ENVIRONMENT, so the driver
 *     still exits 92 (zero-round refusal) there.
 *   - Exact-owned teardown is strict: cleanupOwnedVms removes only recorded
 *     `vm-<8hex>` ids and a failed/unknown `matchlock rm` FAILS the gate and
 *     retains the state dir/rows for diagnostics — never erase-to-look-clean.
 *   - Native (non-Matchlock) runs never reach the gate; the qualification
 *     record states the no-lease limitation rather than implying exclusion.
 *   - Never touch /home/kaladin/.hermes: this gate runs with a disposable HOME
 *     and asserts that the operator home is only ever a reference.
 *****************************************************************************/

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";

import { tamanduaShortTempDir } from "../dist/lib/temp-dir.js";
import { LAUNCH_GATE_REFUSAL_EXIT_CODE } from "../dist/installer/matchlock/gate-exit-code.js";
import { NO_LEASE_LIMITATION, parseReceipt } from "../dist/installer/matchlock/gate-receipt.js";
import {
  interactiveStoreMountPlan,
  LAUNCH_GATE_STORE_CONTRACT,
} from "../dist/installer/matchlock/doctor-gate.js";
import {
  REASON_CODE_ORDER,
  evaluateGate,
} from "../dist/installer/matchlock/launch-gate.js";
import { renderGateRemedyText } from "../dist/installer/matchlock/gate-remedy-text.js";
import { adaptStoreObservation } from "../dist/installer/matchlock/store-observation-adapter.js";
import { observeStore } from "../dist/installer/matchlock/store-header.js";
import {
  evaluateAndRecordLaunchGate,
  resolveLaunchGateReceiptPath,
  writeLaunchGateLaunchReceipt,
} from "../dist/installer/matchlock/launch-gate-wiring.js";
import {
  evaluateScheduledAttemptGate,
  evaluateScheduledDispatchGate,
  recordScheduledLaunchGateRefusal,
} from "../dist/installer/matchlock/launch-gate-scheduled.js";
import { buildMatchlockPolicy } from "../dist/installer/matchlock/policy.js";
import {
  GATE_QUALIFICATION_RECORD_KIND,
  captureQualificationRecord,
  resolveQualificationRecordPath,
  writeQualificationRecord,
} from "../dist/installer/matchlock/gate-qualification.js";
import { readQualificationRecord } from "../dist/installer/matchlock/gate-guest-visibility.js";
import {
  assertNoOwnedVms,
  cleanupOwnedVms,
  readRunnerVmEvidenceIds,
  readRunEvents,
  readVmInventory,
  stopIsolatedDaemonScoped,
} from "./helpers/matchlock-gate-lifecycle.ts";
import {
  cliMustSucceed,
  inheritedProcessEnv,
  releasePortReservations,
  resolveFullRunId,
  spawnWorkflowRun,
} from "./helpers/smoke-helpers.ts";
import { startIsolatedDaemon, stopIsolatedDaemon } from "./helpers/e2e-helpers.ts";
import { cleanChildEnv, reservePortHandles } from "../tests/helpers/test-env.ts";
import {
  OBSERVED_ROUNDS_FILE,
  ZERO_ROUND_EXIT_CODE,
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── environment: the driver-installed surroundings ─────────────────────────
// The driver resolves the runtime (system pair by default; optional explicit
// overrides) and validates/exports the three names. This file only requires
// them to be present when the real-VM tier is enabled.
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT = process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED = process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";
const PRIVATE_HOME = process.env.HOME ?? "";
const PRIVATE_STATE_DIR = process.env.TAMANDUA_STATE_DIR ?? "";
const PRIVATE_TMPDIR = process.env.TMPDIR ?? "";
const OPERATOR_HOME = process.env.TAMANDUA_GATE_OPERATOR_HOME ?? "";
const OPERATOR_CACHE = process.env.TAMANDUA_GATE_OPERATOR_CACHE ?? "";
const IMAGE_STORE = process.env.TAMANDUA_GATE_IMAGE_STORE ?? "";
const EVIDENCE_ROOT = process.env.TAMANDUA_GATE_EVIDENCE_ROOT ?? "";

/** The compiled CLI this gate drives (the isolated daemon runs the same dist). */
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

/**
 * The TEST-ONLY synthetic-hermes fixture used for scenario A2. It derives from
 * the qualified base image and ships a deterministic fake `hermes`, so the
 * admitted round needs NO provider credentials and NO model call.
 */
const FIXTURE_IMAGE_TAG = "tamandua-synthetic-hermes:gate-fixture";
const FIXTURE_DOCKERFILE = "Dockerfile.synthetic-hermes";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "hermes-fixture");

/**
 * Optional content-addressed fixture-image cache (a prior run's matchlock image
 * store). When set (or when the evidence root already holds one) its immutable
 * blobs are HARDLINKED into the fresh private home instead of rebuilding the
 * image; the resolved digests are identical either way.
 */
const FIXTURE_IMAGE_CACHE_ENV = process.env.TAMANDUA_GATE_FIXTURE_IMAGE_CACHE?.trim() || "";

function fixtureImageCacheDir(): string {
  if (FIXTURE_IMAGE_CACHE_ENV.length > 0) return FIXTURE_IMAGE_CACHE_ENV;
  if (EVIDENCE_ROOT.length > 0) {
    const candidate = path.join(EVIDENCE_ROOT, "hermes-fixture-image-cache");
    const metadata = path.join(candidate, "images", "metadata.db");
    const blobs = path.join(candidate, "images", "blobs");
    // A cache whose blobs were pruned (metadata still naming tags) is NOT a
    // usable cache: seeding it would produce a store whose tags cannot resolve.
    if (
      fs.existsSync(metadata) &&
      fs.existsSync(blobs) &&
      fs.readdirSync(blobs).length > 0
    ) {
      return candidate;
    }
  }
  return "";
}


/** The observed-rounds evidence / guard label for this gate. The driver passes
 * the SAME label to scripts/observed-rounds-guard.mjs. */
const GATE_LABEL = "admission-qualification";

/**
 * Opt-in guard: the real-VM tier runs only when the driver exported both an
 * evidence dir and the matchlock CLI. A bare `node --test` therefore executes
 * ONLY the no-VM controls (no VM, no model, no daemon).
 */
const REAL_VM_GATE_ENABLED = EVIDENCE_DIR.length > 0 && MATCHLOCK_RPC_BIN.length > 0;

/** Every `vm-<8hex>` id this tier actually observed (finite by construction). */
const observedVmIds: string[] = [];

/**
 * The optional runtime overrides, forwarded only when resolved. When unset,
 * matchlock resolves its own guest-init (nothing is invented here).
 */
function matchlockRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  if (MATCHLOCK_RPC_BIN.length > 0) env.TAMANDUA_MATCHLOCK_RPC_BIN = MATCHLOCK_RPC_BIN;
  if (GUEST_INIT.length > 0) env.MATCHLOCK_GUEST_INIT = GUEST_INIT;
  if (GUEST_FUSED.length > 0) env.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;
  return env;
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// ── no-VM fixtures: real files, disposable, removed afterwards ─────────────
const temporaryDirectories: string[] = [];

function track(directory: string): string {
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A private state dir the receipt path is resolved under. */
function newStateDir(): string {
  return track(tamanduaShortTempDir("tamandua-g8q-state-"));
}

/**
 * A disposable profile home holding a REAL rollback-format SQLite store and a
 * `config.yaml` requesting the given journal mode.
 */
function newProfileHome(journalMode: "delete" | "wal" = "delete"): string {
  const home = track(tamanduaShortTempDir("tamandua-g8q-home-"));
  fs.writeFileSync(path.join(home, "config.yaml"), `database:\n  journal_mode: ${journalMode}\n`);
  const database = openE2eDatabase(path.join(home, "state.db"));
  database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
  database.exec("INSERT INTO t (value) VALUES ('row')");
  database.close();
  return home;
}

/**
 * A byte-exact write-ahead-log store: correct SQLite signature, version pair
 * (2,2), no sidecars. The gate reads bytes only, so this is the same evidence
 * a genuine WAL store presents in its header — and it must be REFUSED.
 */
function writeWalStore(home: string, name = "verification_evidence.db"): string {
  const file = path.join(home, name);
  const header = Buffer.alloc(4096);
  Buffer.from("SQLite format 3\u0000", "latin1").copy(header, 0);
  header[18] = 2;
  header[19] = 2;
  fs.writeFileSync(file, header);
  return file;
}

/** Deterministic stored instants: UTC ISO-Z, one second apart. */
function sequenceNow(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-02T03:04:05.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

/** One scheduled-dispatch scope over a real profile home. */
function scopeFor(home: string, overrides: Record<string, unknown> = {}): any {
  return {
    kind: "scheduled-dispatch",
    invocationId: "run-qualification:round-a1:dispatch",
    runId: "run-qualification",
    roundId: "round-a1",
    profileHome: home,
    mountPlan: interactiveStoreMountPlan(home),
    configOptions: { managedDir: null },
    ...overrides,
  };
}

/**
 * Wiring deps every control starts from: deterministic clock, real receipt
 * writers, the PRODUCTION revalidation (never injected here — it is the code
 * under test) and a private state dir.
 */
function deps(stateDir: string, overrides: Record<string, unknown> = {}): any {
  return {
    now: sequenceNow(),
    stateDir,
    hostRevisions: {
      hermesRevision: "hermes:qualification-gate",
      matchlockRevision: "matchlock:qualification-gate",
      tamanduaRevision: "tamandua:qualification-gate",
    },
    ...overrides,
  };
}

function readReceipt(receiptPath: string): ReturnType<typeof parseReceipt> {
  return parseReceipt(fs.readFileSync(receiptPath, "utf-8").trimEnd());
}

// ===========================================================================
// NO-VM CONTROLS — no VM, no model, no daemon
// ===========================================================================
describe("G8 admission qualification — NO-VM CONTROLS (refusal / allow evidence shapes)", () => {
  it("keeps the refused-decision vocabulary closed at the ten documented reason codes", () => {
    assert.deepEqual([...REASON_CODE_ORDER], [
      "not-delete-config",
      "wal-header",
      "header-unreadable",
      "header-not-sqlite",
      "header-truncated",
      "sidecar-unresolved",
      "store-missing",
      "inventory-incomplete",
      "path-unresolved",
      "permission-denied",
    ]);
  });

  it("refuses a WAL-header disposable profile through the PRODUCTION wiring, receipt first", () => {
    const home = newProfileHome("delete");
    const walPath = writeWalStore(home);
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), deps(stateDir));
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    const { refusal } = decision;
    assert.equal(refusal.kind, "verdict");
    assert.equal(refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(refusal.receiptWritten, true);
    assert.ok(fs.existsSync(refusal.receiptPath), "the refusal receipt must exist before anything else happens");

    const receipt = readReceipt(refusal.receiptPath);
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.verdict, "refuse");
    assert.equal(receipt.stores.length, LAUNCH_GATE_STORE_CONTRACT.entries.length);
    assert.equal(receipt.findings.length, refusal.findings.length);

    const codes = receipt.findings.map((finding) => finding.code);
    assert.ok(codes.includes("wal-header"), `expected wal-header, got ${codes.join(",")}`);
    assert.ok(
      refusal.findings.some((finding) => finding.code === "wal-header" && finding.store === walPath),
      "the finding must name the store it was observed on",
    );
    for (const code of codes) {
      assert.ok(
        (REASON_CODE_ORDER as readonly string[]).includes(code),
        `${code} must be one of the ten closed reason codes (never an invented one)`,
      );
    }

    // ZERO create surface: a refused launch leaves no VM row or state dir.
    const inventory = readVmInventory(home);
    assert.equal(inventory.dbPresent, false);
    assert.deepEqual(inventory.rows, []);
    assert.deepEqual(inventory.dirIds, []);

    // The qualification record is a SIBLING of the receipt; it has not been
    // captured yet, and its reader fails closed on an absent file.
    const qualificationPath = resolveQualificationRecordPath(refusal.receiptPath);
    assert.match(qualificationPath, /\.qualification\.json$/);
    assert.equal(readQualificationRecord(qualificationPath), null);
    assert.equal(resolveQualificationRecordPath("unreadable"), "");
  });

  it("aggregates across every contract store: one unobservable store never hides another store's finding", () => {
    const home = newProfileHome("delete");
    const walPath = writeWalStore(home);
    const statePath = path.join(home, "state.db");
    const stateDir = newStateDir();
    const observed: string[] = [];

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), {
      ...deps(stateDir),
      observeStore: (storePath: string) => {
        observed.push(storePath);
        if (storePath === statePath) throw new Error("simulated observation failure");
        return observeStore(storePath);
      },
    });

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(
      observed.length,
      LAUNCH_GATE_STORE_CONTRACT.entries.length,
      "every contract store must be observed (aggregate, never short-circuit)",
    );
    const codes = decision.refusal.findings.map((finding) => finding.code);
    assert.ok(codes.includes("wal-header"), "the other store's finding must survive");
    assert.ok(codes.includes("path-unresolved"), "the throwing observation must be recorded, never skipped");

    const receipt = readReceipt(decision.refusal.receiptPath);
    assert.equal(
      receipt.stores.length,
      LAUNCH_GATE_STORE_CONTRACT.entries.length,
      "the receipt records every store in the set, present or not",
    );
  });

  it("allows a converted profile and writes the launch receipt ONLY after vmCreated", () => {
    const home = newProfileHome("delete");
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), deps(stateDir));
    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;

    assert.match(decision.binding.storeSetKey, /^sha256:[0-9a-f]{64}$/);
    assert.equal(decision.binding.configJournalMode, "delete");
    assert.equal(
      decision.binding.receiptPath,
      resolveLaunchGateReceiptPath({ stateDir, invocationId: decision.binding.invocationId }),
    );
    assert.equal(
      fs.existsSync(decision.binding.receiptPath),
      false,
      "no receipt may be written before the VM exists",
    );

    const beforeCreate = writeLaunchGateLaunchReceipt(decision, false);
    assert.equal(beforeCreate.ok, false);
    assert.equal(fs.existsSync(decision.binding.receiptPath), false);

    const afterCreate = writeLaunchGateLaunchReceipt(decision, true);
    assert.equal(afterCreate.ok, true);
    const receipt = readReceipt(decision.binding.receiptPath);
    assert.equal(receipt.action, "launched");
    assert.equal(receipt.verdict, "allow");
    assert.deepEqual(receipt.findings, []);
    assert.equal(receipt.stores.length, LAUNCH_GATE_STORE_CONTRACT.entries.length);
  });

  it("treats a receipt-write failure as an OPERATIONAL refusal (never an allow, never a reason code)", () => {
    const home = newProfileHome("delete");
    writeWalStore(home);
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), {
      ...deps(stateDir),
      ensureReceiptDirectory: () => {
        throw new Error("simulated receipt directory failure");
      },
    });

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.receiptWritten, false);
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    // The verdict's own findings are still returned, so an operator sees both
    // why the launch was refused and that the evidence could not be recorded.
    assert.ok(decision.refusal.findings.some((finding) => finding.code === "wal-header"));
    assert.equal(fs.existsSync(path.join(stateDir, "matchlock", "gate")), false);
  });

  it("records round evidence through the shared helper and keeps the zero-round refusal distinct", () => {
    const dir = track(tamanduaShortTempDir("tamandua-g8q-rounds-"));

    assert.equal(OBSERVED_ROUNDS_FILE, "observed-rounds.json");
    assert.equal(ZERO_ROUND_EXIT_CODE, 92);
    assert.notEqual(ZERO_ROUND_EXIT_CODE, 0);

    const written = writeObservedRoundsEvidence(dir, {
      gate: GATE_LABEL,
      observed_rounds: 0,
      observed_vm_ids: [],
      observed_at: "2026-01-02T03:04:05.000Z",
    });
    assert.equal(written.gate, GATE_LABEL);
    assert.equal(written.observed_rounds, 0);

    const evidence = JSON.parse(
      fs.readFileSync(path.join(dir, OBSERVED_ROUNDS_FILE), "utf-8"),
    ) as { gate: string; observed_rounds: number; observed_vm_ids: string[] };
    assert.equal(evidence.gate, GATE_LABEL);
    assert.deepEqual(evidence.observed_vm_ids, []);

    // A zero-round result can never be read as a pass.
    assert.throws(
      () => assertObservedRoundsNonZero(GATE_LABEL, 0, []),
      /no VM round observed/,
    );
  });
});

// ===========================================================================
// SCENARIO A — shared evidence helpers
//
// US-012 qualifies the REAL run path twice: A1 refuses an unconverted (WAL)
// store before any VM, A2 admits a converted (rollback) store and boots a real
// VM. The helpers below are shared by the always-on NO-VM CONTROLS and the
// opt-in real-VM tier so the two produce the SAME evidence shapes and cannot
// drift apart. Nothing here touches the operator home: every profile is a
// disposable directory under the evidence/temp root, and the guard below
// refuses anything under the operator's `.hermes`.
// ===========================================================================

/** The two qualification-A scenarios. */
type ScenarioAName = "A1-refusal" | "A2-allow";

/** Every fact the story requires the evidence directory to carry per scenario. */
interface ScenarioAEvidence {
  scenario: ScenarioAName;
  gate: string;
  mode: "no-vm-control" | "real-run";
  runId: string;
  harness: "hermes";
  start: { commit: string; tree: string };
  delivered: { commit: string; tree: string };
  profileHome: string;
  profileStore: string;
  profileStoreHeader: number[];
  profileStoreSidecars: string[];
  receiptPaths: string[];
  qualificationRecordPath: string;
  image: { tag: string; digest: string; configDigest: string };
  matchlock: { path: string; sha256: string; version: string };
  guestInit: { path: string; sha256: string };
  tamandua: { distRoot: string; distVersionStamp: string };
  findingCodes: string[];
  observedVmIds: string[];
  vmInventory: { dbPresent: boolean; rows: unknown[]; dirIds: string[] };
  operatorHomeGate: { operatorHome: string; checkedPaths: string[]; disposable: true };
  commands: string[];
  notes: string[];
}

/** Directory holding one scenario's evidence (`<evidence>/scenario-a/<name>`). */
function scenarioADirectory(evidenceRoot: string, scenario: ScenarioAName): string {
  return path.join(evidenceRoot, "scenario-a", scenario);
}

/**
 * Prepare a scenario's OWN evidence directory. A non-empty existing directory is
 * REFUSED, never wiped: it could hold a previous attempt's retained VM state,
 * and erasing that would be an erase-to-look-clean. The driver allocates a fresh
 * evidence dir per run, so this never triggers in a real qualification run.
 */
function prepareEmptyScenarioDirectory(directory: string, label: string): string {
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0) {
    throw new Error(
      `${label}: refusing to reuse a non-empty scenario directory (${directory}); ` +
        "use a fresh evidence dir (a stale dir may hold retained VM state)",
    );
  }
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function prepareScenarioDirectory(evidenceRoot: string, scenario: ScenarioAName): string {
  return prepareEmptyScenarioDirectory(scenarioADirectory(evidenceRoot, scenario), "scenario A");
}

function scenarioGitIdentity(repoDir: string): { commit: string; tree: string } {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf-8" });
  const tree = spawnSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoDir, encoding: "utf-8" });
  if (commit.status !== 0 || tree.status !== 0) {
    throw new Error(
      `scenario A: git identity unavailable in ${repoDir}: ${(commit.stderr ?? "") + (tree.stderr ?? "")}`,
    );
  }
  return { commit: (commit.stdout ?? "").trim(), tree: (tree.stdout ?? "").trim() };
}

/** Write one scenario's evidence (JSON + the exact commands + operator notes). */
function writeScenarioAEvidence(directory: string, evidence: ScenarioAEvidence): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "evidence.json");
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
  fs.writeFileSync(path.join(directory, "commands.txt"), `${evidence.commands.join("\n")}\n`, "utf-8");
  fs.writeFileSync(path.join(directory, "notes.txt"), `${evidence.notes.join("\n")}\n`, "utf-8");
  return file;
}

/** The operator's profile root. The gate must never read or write it. */
function operatorHermesDir(operatorHome: string): string {
  return path.join(operatorHome, ".hermes");
}

/**
 * Refuse any profile path inside the operator's `.hermes`.
 *
 * This is the AC "disposable profiles only" guard: the gate's own fixtures are
 * always disposable, and a future edit that pointed a scenario at the operator
 * home would fail HERE instead of mutating real state.
 */
function assertDisposableProfilePath(candidate: string, operatorHome: string): void {
  if (operatorHome === "") return;
  const resolved = path.resolve(candidate);
  const forbidden = path.resolve(operatorHermesDir(operatorHome));
  if (resolved === forbidden || resolved.startsWith(`${forbidden}${path.sep}`)) {
    throw new Error(
      `scenario A refuses a profile home inside the operator home: ${resolved} ` +
        `(operator .hermes is ${forbidden}); use a disposable profile only`,
    );
  }
}

/** Deterministic file inventory (relative path + size), for the no-mount proof. */
function scenarioProfileInventory(directory: string): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = [];
  const walk = (current: string): void => {
    const entries = fs
      .readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push({ path: path.relative(directory, full), size: fs.statSync(full).size });
    }
  };
  walk(directory);
  return out;
}

interface ScenarioProfile {
  /** The disposable HOME the daemon/CLI runs with. */
  home: string;
  /** The effective Hermes profile that is mounted (`<home>/.hermes`). */
  hermesHome: string;
  /** The contract store the gate observes. */
  storePath: string;
  /** Bytes 18/19 of the SQLite header (the format pair the gate reads). */
  header: number[];
  /** Any sidecars the fixture left behind, `name:size`. */
  sidecars: string[];
}

/**
 * A disposable scenario profile.
 *
 * BOTH scenarios request `database.journal_mode: delete` in `config.yaml`; the
 * difference is the STORE. `wal` builds a REAL write-ahead-log store with
 * `PRAGMA journal_mode=WAL` (the unconverted store A1 must refuse); `rollback`
 * builds a real rollback-format store (the converted store A2 must admit).
 */
function createScenarioProfile(root: string, kind: "wal" | "rollback"): ScenarioProfile {
  const home = path.join(root, "home");
  const hermesHome = path.join(home, ".hermes");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(path.join(hermesHome, "config.yaml"), "database:\n  journal_mode: delete\n", "utf-8");
  const storePath = path.join(hermesHome, "state.db");
  const db = openE2eDatabase(storePath);
  try {
    if (kind === "wal") db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO t (value) VALUES ('owned scenario row')");
  } finally {
    db.close();
  }
  const head = fs.readFileSync(storePath).subarray(0, 20);
  const sidecars = ["-wal", "-shm", "-journal"]
    .map((suffix) => `${storePath}${suffix}`)
    .filter((sidecar) => fs.existsSync(sidecar))
    .map((sidecar) => `${path.basename(sidecar)}:${fs.statSync(sidecar).size}`);
  return { home, hermesHome, storePath, header: [head[18] as number, head[19] as number], sidecars };
}

/** A tiny OWNED git working directory for the harness (never a live branch). */
function prepareScenarioRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# G8 admission-qualification scenario fixture\n", "utf-8");
  fs.writeFileSync(path.join(dir, "test.mjs"), "console.log('scenario fixture ok');\n", "utf-8");
  const git = (args: string[]): string => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf-8" });
    assert.equal(r.status, 0, `git ${args.join(" ")} failed in ${dir}: ${r.stderr || r.stdout}`);
    return (r.stdout ?? "").trim();
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "gate@tamandua.test"]);
  git(["config", "user.name", "G8 admission gate"]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "scenario fixture"]);
  // Detach so no run ever treats the fixture's branch as a landing target.
  git(["checkout", "-q", "--detach"]);
  return dir;
}

/** Child env for one scenario: private HOME/state/db, never the operator's. */
function scenarioEnv(
  home: string,
  controlPort: number,
  extra: Record<string, string> = {},
): Record<string, string> {
  const tamanduaDir = path.join(home, ".tamandua");
  const env: Record<string, string> = {
    ...inheritedProcessEnv(),
    HOME: home,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN,
    ...(GUEST_INIT.length > 0 ? { MATCHLOCK_GUEST_INIT: GUEST_INIT } : {}),
    ...(GUEST_FUSED.length > 0 ? { MATCHLOCK_GUEST_FUSED: GUEST_FUSED } : {}),
    ...extra,
  };
  // OPERATOR-ENV SCRUB: an ambient HERMES_HOME (this agent's own runtime!) or an
  // ambient harness/run marker would be FROZEN into the run's persisted policy
  // and point the round at the operator's real profile. The scenario must run on
  // its own disposable `~/.hermes` only, so these are dropped, never inherited.
  for (const key of [
    "HERMES_HOME",
    "TAMANDUA_PI_BINARY",
    "TAMANDUA_HERMES_BINARY",
    "TAMANDUA_DSH_BINARY",
    "TAMANDUA_RUN_ID",
    "TAMANDUA_WORKER_JOB_ID",
    "TAMANDUA_DAEMON_INSTANCE",
    "TAMANDUA_WORKER_PID",
    "TAMANDUA_DAEMON_PID",
    "TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR",
  ]) {
    delete env[key];
  }
  return env;
}

/** Poll `workflow status` (with nudges) until the run is terminal. */
async function pollScenarioTerminal(
  runId: string,
  env: Record<string, string>,
  tamanduaDir: string,
  timeoutMs = 15 * 60_000,
): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < timeoutMs) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const match = out.match(/^Status:\s+(\S+)/m);
    if (match) {
      lastStatus = match[1];
      if (["completed", "done", "failed", "canceled"].includes(lastStatus)) return lastStatus;
    }
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  let tail = "";
  try {
    const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
    tail = fs.readFileSync(eventsPath, "utf-8").trimEnd().split("\n").slice(-20).join("\n");
  } catch {
    /* no event file */
  }
  throw new Error(
    `scenario A: timeout after ${timeoutMs}ms waiting for a terminal status; last=${lastStatus || "(none)"}\n${tail}`,
  );
}

/** A persisted harness:"hermes" policy for one disposable operator home. */
function scenarioHermesPolicy(operatorHome: string): any {
  return buildMatchlockPolicy({
    requestedImage: FIXTURE_IMAGE_TAG,
    identity: {
      digest: `sha256:${"a".repeat(64)}`,
      config_digest: `sha256:${"b".repeat(64)}`,
      tag: FIXTURE_IMAGE_TAG,
    },
    harness: "hermes",
    workingDirectory: operatorHome,
    originalRepositoryRoot: operatorHome,
    workMounts: [
      { hostPath: operatorHome, hostRealPath: operatorHome, guestPath: operatorHome },
    ],
    gitMetadataRoots: [],
    configurationRoot: operatorHermesDir(operatorHome),
    configurationProfile: "default",
    guestConfigurationRoot: "/workspace/config/hermes",
    hermes: { homeDir: operatorHome, cwd: operatorHome, hermesHomeEnv: null },
  });
}

/** One scheduled work round over a scenario policy. */
function scenarioRound(policy: any, runId: string): any {
  return {
    policy,
    identity: {
      runId,
      agentId: "do-now_doer",
      workflowId: "do-now",
      jobId: "job-do-now_doer",
    },
    kind: "work",
    promptText: "scenario A: execute the harmless owned fixture action.",
    workingDirectoryForHarness: policy.workingDirectory,
    timeoutMs: 60_000,
  };
}

const SCENARIO_A1_RUN_ID = "run-a1a1a1a1-1111-4111-8111-111111111111";
const SCENARIO_A2_RUN_ID = "run-a2a2a2a2-2222-4222-8222-222222222222";

// ===========================================================================
// SCENARIO A — NO-VM CONTROLS (injected seams, same evidence shapes)
// ===========================================================================
describe("G8 admission qualification — SCENARIO A NO-VM CONTROLS (no VM, no model)", () => {
  it("A1: a WAL store refuses before any VM, records ONE event, ends the run failed and writes a parseable receipt", async () => {
    const root = track(tamanduaShortTempDir("tamandua-g8q-a1-"));
    const profile = createScenarioProfile(root, "wal");
    assert.deepEqual(profile.header, [2, 2], "the fixture store must present a WAL header (bytes 18/19 = 2)");
    assertDisposableProfilePath(profile.hermesHome, OPERATOR_HOME || "/home/operator");
    const stateDir = path.join(root, "state");
    const round = scenarioRound(scenarioHermesPolicy(profile.home), SCENARIO_A1_RUN_ID);
    const before = scenarioProfileInventory(profile.hermesHome);

    const decision = evaluateScheduledDispatchGate(round, {
      stateDir,
      configOptions: { managedDir: null },
    } as never);
    assert.ok(decision, "a hermes policy is gated");
    if (!decision || decision.action !== "refuse") {
      assert.fail(`A1 control: a WAL store must refuse, got ${decision ? decision.action : "null"}`);
      return;
    }
    assert.equal(decision.refusal.kind, "verdict");
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(decision.refusal.receiptWritten, true, "the receipt is written FIRST");
    assert.ok(fs.existsSync(decision.refusal.receiptPath));

    const receipt = readReceipt(decision.refusal.receiptPath);
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.verdict, "refuse");
    assert.equal(receipt.invocation.kind, "scheduled-dispatch");
    const codes = receipt.findings.map((finding) => finding.code);
    assert.ok(codes.includes("wal-header"), `expected wal-header, got ${codes.join(",")}`);
    for (const code of codes) {
      assert.ok((REASON_CODE_ORDER as readonly string[]).includes(code), `${code} must be one of the ten codes`);
    }
    const storeRow = receipt.stores.find((store) => store.canonicalPath === profile.storePath);
    assert.ok(storeRow, "the receipt records the observable store it refused on");
    assert.equal(storeRow.headerFormat, "wal");
    assert.ok(storeRow.findingCodes.includes("wal-header"));

    // ONE recorded refusal, then the terminal blocked-equivalent. A second tick
    // for the now-terminal run records nothing and forces nothing.
    const events: Array<Record<string, unknown>> = [];
    let forcedCount = 0;
    let runState: { status: string; scheduling_status: string | null } = {
      status: "running",
      scheduling_status: "active",
    };
    const deps = {
      readRun: () => runState,
      readEvents: () => events as never,
      emit: (event: unknown) => events.push(event as Record<string, unknown>),
      forceFail: async () => {
        forcedCount += 1;
        runState = { status: "failed", scheduling_status: null };
        return { ok: true };
      },
      now: () => "2026-01-02T03:04:05.000Z",
      log: () => {},
    };
    const first = await recordScheduledLaunchGateRefusal(round, decision.refusal, {
      phase: "dispatch",
      ...deps,
    });
    assert.equal(first.recorded, true, "the refusal is recorded durably");
    assert.equal(first.forced, true, "the run is put in its terminal blocked-equivalent state");
    assert.equal(runState.status, "failed");
    assert.equal(runState.scheduling_status, null, "a failed run is not re-admitted by reconcileOnce()");
    assert.equal(events.length, 1, "exactly ONE refusal event (no retry storm)");
    assert.equal(events[0].event, "run.matchlock_gate_refused");
    assert.equal(events[0].runId, SCENARIO_A1_RUN_ID);
    assert.equal(events[0].harness, "hermes");
    assert.equal(events[0].exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(events[0].receiptPath, decision.refusal.receiptPath);
    assert.deepEqual((events[0].findingCodes as string[]).sort(), [...codes].sort());

    const second = await recordScheduledLaunchGateRefusal(round, decision.refusal, {
      phase: "dispatch",
      ...deps,
    });
    assert.equal(second.recorded, false);
    assert.equal(second.reason, "run-not-running");
    assert.equal(events.length, 1, "a later tick cannot add a second event");
    assert.equal(forcedCount, 1, "a later tick cannot force-fail twice");

    // ZERO create surface: no VM state, no runner evidence, and the profile is
    // byte-for-byte the one A1 built (nothing was mounted or written into it).
    const inventory = readVmInventory(profile.home);
    assert.deepEqual(inventory.rows, []);
    assert.deepEqual(inventory.dirIds, []);
    assert.deepEqual(
      readRunnerVmEvidenceIds(path.join(stateDir, "runs"), SCENARIO_A1_RUN_ID),
      [],
      "the hermes runner never ran (no per-VM evidence dir)",
    );
    assert.deepEqual(scenarioProfileInventory(profile.hermesHome), before, "no partial mount");
    assert.deepEqual(profile.header, [2, 2], "the unconverted store is still WAL (never repaired by the gate)");
  });

  it("A2: a converted profile allows, writes the launch receipt only after vmCreated and binds the executed dist + image", () => {
    const root = track(tamanduaShortTempDir("tamandua-g8q-a2-"));
    const profile = createScenarioProfile(root, "rollback");
    assert.deepEqual(profile.header, [1, 1], "a converted store must present a rollback header (bytes 18/19 = 1)");
    assertDisposableProfilePath(profile.hermesHome, OPERATOR_HOME || "/home/operator");
    const stateDir = path.join(root, "state");
    const round = scenarioRound(scenarioHermesPolicy(profile.home), SCENARIO_A2_RUN_ID);

    const decision = evaluateScheduledDispatchGate(round, {
      stateDir,
      configOptions: { managedDir: null },
    } as never);
    assert.ok(decision);
    if (!decision || decision.action !== "allow") {
      assert.fail(`A2 control: a converted store must be admitted, got ${decision ? decision.action : "null"}`);
      return;
    }
    assert.equal(decision.binding.configJournalMode, "delete");
    assert.equal(fs.existsSync(decision.binding.receiptPath), false, "no receipt before vmCreated");
    assert.equal(
      writeLaunchGateLaunchReceipt(decision, false).ok,
      false,
      "a pre-create launch write is refused",
    );
    assert.equal(fs.existsSync(decision.binding.receiptPath), false);

    const launch = writeLaunchGateLaunchReceipt(decision, true);
    assert.equal(launch.ok, true, `launch receipt write failed: ${launch.ok === false ? launch.detail : ""}`);
    const receipt = readReceipt(decision.binding.receiptPath);
    assert.equal(receipt.action, "launched");
    assert.equal(receipt.verdict, "allow");
    assert.deepEqual(receipt.findings, []);
    assert.equal(receipt.invocation.kind, "scheduled-dispatch");

    // The qualification record (US-009/US-010 schema) binds the decision to the
    // artifacts that actually executed: the dist stamp decides the commit, the
    // dist root is MEASURED, and the image is the one the admission pinned.
    const distVersion = fs.readFileSync(path.join(repoRoot, "dist", "version"), "utf-8").trim();
    const imageDigest = `sha256:${"a".repeat(64)}`;
    const record = captureQualificationRecord(decision, {
      invocation: { runId: SCENARIO_A2_RUN_ID, roundId: "job-do-now_doer" },
      receipt: { path: decision.binding.receiptPath, storeSetKey: decision.binding.storeSetKey },
      // A caller's claim must NEVER outrank the executed artifact.
      tamandua: { commit: "0".repeat(40) },
      matchlock: { path: "/usr/local/bin/matchlock", sha256: `sha256:${"c".repeat(64)}`, version: "matchlock version fixture" },
      guestInit: { path: "/usr/local/bin/guest-init", sha256: `sha256:${"d".repeat(64)}` },
      image: { reference: FIXTURE_IMAGE_TAG, digest: imageDigest, configDigest: `sha256:${"e".repeat(64)}` },
      profiles: {
        hostEffectiveDir: profile.hermesHome,
        guestHermesHome: "/workspace/config/hermes",
        configSources: [path.join(profile.hermesHome, "config.yaml")],
      },
      candidate: {
        distRoot: path.join(repoRoot, "dist"),
        executedBinaryPaths: ["/usr/local/bin/matchlock"],
      },
      guestVisibility: [
        {
          storePath: "/workspace/config/hermes/state.db",
          journalMode: "delete",
          source: "guest-observed:config.yaml",
          readable: true,
          provenance: "measured",
        },
      ],
    });
    assert.equal(record.recordKind, GATE_QUALIFICATION_RECORD_KIND);
    assert.equal(record.tamandua.distVersionStamp, distVersion, "the executed dist stamp is recorded");
    assert.match(String(record.tamandua.commit), /^[0-9a-f]{40}$/);
    assert.notEqual(String(record.tamandua.commit), "0".repeat(40), "the artifact outranks the caller's claim");
    assert.equal(record.candidate.distRoot, path.join(repoRoot, "dist"), "the executed dist is measured");
    assert.equal(record.image.digest, imageDigest);
    assert.equal(record.receipt.path, decision.binding.receiptPath);
    assert.equal(record.receipt.verdict, "allow");
    assert.equal(record.invocation.invocationId, decision.binding.invocationId);
    assert.equal(record.guestVisibility.length, 1);
    assert.equal(record.guestVisibility[0].perspective, "guest");
    assert.equal(record.guestVisibility[0].provenance, "measured");
    assert.equal(record.scope.lease, NO_LEASE_LIMITATION, "the record states the no-lease limitation");

    const written = writeQualificationRecord(record);
    assert.equal(written.ok, true, `qualification write failed: ${written.ok === false ? written.detail : ""}`);
    assert.equal(written.path, resolveQualificationRecordPath(decision.binding.receiptPath));
    const reread = readQualificationRecord(written.path);
    assert.ok(reread, "the written record must be readable by the fail-closed reader");
    assert.equal(reread.recordKind, GATE_QUALIFICATION_RECORD_KIND);
    assert.equal(reread.image.digest, imageDigest);
  });

  it("refuses a profile home inside the operator home (disposable profiles only)", () => {
    const operatorHome = "/home/operator";
    const forbidden = path.join(operatorHome, ".hermes");
    assert.throws(
      () => assertDisposableProfilePath(forbidden, operatorHome),
      /operator home/,
      "the operator's own .hermes must be refused",
    );
    assert.throws(
      () => assertDisposableProfilePath(path.join(forbidden, "profiles", "default"), operatorHome),
      /operator home/,
      "a profile INSIDE the operator home must be refused",
    );
    assert.doesNotThrow(() =>
      assertDisposableProfilePath(
        path.join(track(tamanduaShortTempDir("tamandua-g8q-operator-guard-")), "home", ".hermes"),
        operatorHome,
      ),
    );
  });

  it("records the scenario evidence shape (run id, receipts, digests and the exact commands)", () => {
    const root = track(tamanduaShortTempDir("tamandua-g8q-evidence-"));
    const evidence: ScenarioAEvidence = {
      scenario: "A1-refusal",
      gate: GATE_LABEL,
      mode: "no-vm-control",
      runId: SCENARIO_A1_RUN_ID,
      harness: "hermes",
      start: { commit: "1".repeat(40), tree: "2".repeat(40) },
      delivered: { commit: "1".repeat(40), tree: "2".repeat(40) },
      profileHome: path.join(root, "home", ".hermes"),
      profileStore: path.join(root, "home", ".hermes", "state.db"),
      profileStoreHeader: [2, 2],
      profileStoreSidecars: [],
      receiptPaths: [path.join(root, "receipt.json")],
      qualificationRecordPath: path.join(root, "receipt.qualification.json"),
      image: { tag: FIXTURE_IMAGE_TAG, digest: `sha256:${"a".repeat(64)}`, configDigest: `sha256:${"b".repeat(64)}` },
      matchlock: { path: "/usr/local/bin/matchlock", sha256: "c".repeat(64), version: "fixture" },
      guestInit: { path: "/usr/local/bin/guest-init", sha256: "d".repeat(64) },
      tamandua: { distRoot: path.join(repoRoot, "dist"), distVersionStamp: "20260102T030405Z_" + "e".repeat(40) },
      findingCodes: ["wal-header"],
      observedVmIds: [],
      vmInventory: { dbPresent: false, rows: [], dirIds: [] },
      operatorHomeGate: { operatorHome: "/home/operator", checkedPaths: [root], disposable: true },
      commands: ["tamandua workflow run do-now 'task' --hermes-as-harness"],
      notes: ["zero VM: the refusal precedes every create"],
    };
    const file = writeScenarioAEvidence(scenarioADirectory(root, "A1-refusal"), evidence);
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as ScenarioAEvidence;
    assert.equal(parsed.runId, SCENARIO_A1_RUN_ID);
    assert.deepEqual(parsed.findingCodes, ["wal-header"]);
    assert.deepEqual(parsed.observedVmIds, []);
    assert.equal(parsed.receiptPaths.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(file), "commands.txt"), "utf-8").trim(), evidence.commands[0]);
  });
});


// ===========================================================================
// SCENARIO C — MIXED NATIVE/GUEST OVERLAP + THE TRANSIENT ROLLBACK JOURNAL
//
// US-013 qualifies the two outcomes the design declares COMPATIBLE:
//
//   C1 mixed overlap  an ADMITTED rollback-format profile is written by a
//                     NATIVE host writer and by the admitted GUEST round at
//                     the same time; afterwards every committed record is
//                     retained and `PRAGMA integrity_check` is ok.
//   C2 journal        a NONEMPTY `-journal` beside a compliant store refuses
//                     with `sidecar-unresolved` and the ROLLBACK-journal
//                     remedy (never a checkpoint), and the next observation
//                     allows once the journal is removed after quiescence.
//
// Neither unconditional admission during EVERY transaction nor process-lifetime
// exclusivity is claimed: the receipt/evidence state the no-lease limitation.
// Every writer is a separate OS process stopped by its RECORDED pid.
// ===========================================================================

/** The two qualification-C scenarios. */
type ScenarioCName = "C1-mixed-overlap" | "C2-journal-transition";

/** One native writer process, as its own ledger summarised it. */
interface NativeWriterSummary {
  label: string;
  /** The pid recorded BEFORE the first commit (and used to stop it). */
  pid: number;
  committed: number;
  attempted: number;
  failed: number;
  stopped: string;
  journalMode: string;
  startedAt: string;
  stoppedAt: string;
  stoppedBy: string;
  exitCode: number | null;
}

/** C1: what the overlapping writers wrote and what survived. */
interface MixedOverlapEvidence {
  writers: NativeWriterSummary[];
  guestWriter: {
    kind: "synthetic-hermes-fixture";
    storePath: string;
    guestStorePath: string;
    /** Sessions rows the in-VM writer left in the SAME store. */
    sessionsRows: number;
    vmIds: string[];
    window: { vmFirstObservedAt: string; terminalAt: string };
  } | null;
  window: { startedAt: string; stoppedAt: string };
  overlapMs: number;
  expectedRecords: number;
  retainedRecords: number;
  missingRecords: string[];
  integrityCheck: string;
  journalModeAtEnd: string;
  headerAtEnd: number[];
}

/** C2: the refusal, its quiescence and the later allow. */
interface JournalTransitionEvidence {
  storePath: string;
  journalPath: string;
  journalSize: number;
  refusal: {
    invocationId: string;
    receiptPath: string;
    findingCodes: string[];
    findingRemedy: string[];
    remedyText: string[];
    /** Codes the G9 renderer was asked to explain (production composition). */
    renderedCodes: string[];
  };
  quiescence: {
    liveWriterPids: number[];
    storeIdentityUnchanged: boolean;
    journalNeverDeletedByGate: boolean;
    removedAt: string;
  };
  allow: { invocationId: string; configJournalMode: string; storeSetKey: string };
}

/** Every fact the story requires under `<evidence>/scenario-c/<name>`. */
interface ScenarioCEvidence {
  scenario: ScenarioCName;
  gate: string;
  mode: "no-vm-control" | "real-run";
  runId: string;
  harness: "hermes" | "native";
  start: { commit: string; tree: string };
  delivered: { commit: string; tree: string };
  profileHome: string;
  profileStore: string;
  profileStoreHeader: number[];
  profileStoreSidecars: string[];
  receiptPaths: string[];
  qualificationRecordPath: string;
  image: { tag: string; digest: string; configDigest: string };
  matchlock: { path: string; sha256: string; version: string };
  guestInit: { path: string; sha256: string };
  tamandua: { distRoot: string; distVersionStamp: string };
  mixedOverlap: MixedOverlapEvidence | null;
  journalTransition: JournalTransitionEvidence | null;
  /** The operator-home reference check (null for the no-VM controls). */
  operatorHomeGate: OperatorHomeGate | null;
  /** The design's TWO accepted outcomes, stated verbatim in the evidence. */
  designAcceptance: string[];
  /** The G9/RECEIPT limitation: there is no lease. */
  noLease: string;
  observedVmIds: string[];
  commands: string[];
  notes: string[];
}

/** C1 keeps every committed record and stays admissible. */
const C1_DESIGN_ACCEPTANCE =
  "C1 ADMITTED OVERLAP: a compliant disposable profile was admitted and the NATIVE host writer and the GUEST round wrote the same mapped store concurrently; every record the native writer COMMITTED is retained and PRAGMA integrity_check returns ok. This does not claim unconditional admission during every transaction.";
/** C2's transient refusal + later allow, neither of which implies exclusion. */
const C2_DESIGN_ACCEPTANCE =
  "C2 TRANSIENT REFUSAL: a nonempty -journal observed at evaluation time refused the launch with sidecar-unresolved (rollback-journal remedy, never a checkpoint) and the next observation allowed after the journal was removed following quiescence. This does not claim process-lifetime exclusivity.";

const SCENARIO_C1_RUN_ID = "run-c1c1c1c1-1111-4111-8111-111111111111";
const SCENARIO_C2_RUN_ID = "run-c2c2c2c2-2222-4222-8222-222222222222";

/** The native writer process (host side of the mixed pair). */
const NATIVE_WRITER_SCRIPT = path.join(
  repoRoot,
  "e2e-tests",
  "helpers",
  "store-native-writer.mjs",
);

/** The table the native writer commits into (one row = one transaction). */
const NATIVE_WRITER_TABLE = "native_writer_rows";

/** Directory holding one C scenario's evidence (`<evidence>/scenario-c/<name>`). */
function scenarioCDirectory(evidenceRoot: string, scenario: ScenarioCName): string {
  return path.join(evidenceRoot, "scenario-c", scenario);
}

function prepareScenarioCDirectory(evidenceRoot: string, scenario: ScenarioCName): string {
  return prepareEmptyScenarioDirectory(scenarioCDirectory(evidenceRoot, scenario), "scenario C");
}

/** Write one C scenario's evidence (JSON + the exact commands + operator notes). */
function writeScenarioCEvidence(directory: string, evidence: ScenarioCEvidence): string {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "evidence.json");
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf-8");
  fs.writeFileSync(path.join(directory, "commands.txt"), `${evidence.commands.join("\n")}\n`, "utf-8");
  fs.writeFileSync(path.join(directory, "notes.txt"), `${evidence.notes.join("\n")}\n`, "utf-8");
  return file;
}

/** The failure classes this story's evidence must record (both outcomes). */
function scenarioCOutcomeSummary(
  evidence: Pick<ScenarioCEvidence, "mixedOverlap" | "journalTransition">,
): string[] {
  const outcomes: string[] = [];
  if (evidence.mixedOverlap !== null) {
    outcomes.push(
      `ADMITTED (C1): ${evidence.mixedOverlap.retainedRecords}/${evidence.mixedOverlap.expectedRecords} ` +
        `committed native records retained, integrity_check=${evidence.mixedOverlap.integrityCheck}, ` +
        `overlap=${evidence.mixedOverlap.overlapMs}ms`,
    );
  }
  if (evidence.journalTransition !== null) {
    outcomes.push(
      `REFUSED (C2): ${evidence.journalTransition.refusal.findingCodes.join(",") || "(no codes)"} ` +
        `at ${evidence.journalTransition.refusal.receiptPath}`,
    );
    outcomes.push(
      `ALLOWED (C2 after quiescence): configJournalMode=${evidence.journalTransition.allow.configJournalMode}`,
    );
  }
  return outcomes;
}

// ── the rollback journal fixture ────────────────────────────────────────────

/**
 * SQLite's rollback-journal magic. A `-journal` file starting with these eight
 * bytes is a rollback journal (the header a delete-journal transaction writes
 * before it touches the database).
 */
const SQLITE_JOURNAL_MAGIC = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

/**
 * Create a NONEMPTY rollback journal beside a store.
 *
 * The gate reads sidecar STATE (absent / presentEmpty / presentNonEmpty /
 * unreadable) and never parses journal content, so this writes the real journal
 * magic plus plausible header fields and zero padding — exactly the evidence a
 * healthy delete-journal transaction in flight presents. Nothing here claims a
 * specific journal body, and the file is NEVER deleted by the gate.
 */
function writeNonEmptyRollbackJournal(journalPath: string): number {
  const size = 4096;
  const header = Buffer.alloc(size);
  SQLITE_JOURNAL_MAGIC.copy(header, 0);
  header.writeUInt32BE(1, 8); // journal format version
  header.writeUInt32BE(1, 12); // page count
  header.writeUInt32BE(4096, 16); // sector size
  header.writeUInt32BE(4096, 20); // page size
  fs.writeFileSync(journalPath, header);
  return size;
}

// ── native writer process (recorded pid, bounded) ────────────────────────────

interface NativeWriterHandle {
  label: string;
  /** The pid recorded BEFORE the first commit. */
  pid: number;
  dbPath: string;
  ledgerPath: string;
  pidFilePath: string;
  startedAt: string;
  child: ReturnType<typeof spawn>;
  output: () => string;
}

/** Start one native writer process and RECORD its pid before any write. */
function startNativeWriter(options: {
  label: string;
  dbPath: string;
  directory: string;
  rows?: number;
  intervalMs?: number;
  durationMs?: number;
}): NativeWriterHandle {
  const ledgerPath = path.join(options.directory, `native-writer-${options.label}.jsonl`);
  const pidFilePath = path.join(options.directory, `native-writer-${options.label}.pid`);
  const args = [
    NATIVE_WRITER_SCRIPT,
    "--db",
    options.dbPath,
    "--writer",
    options.label,
    "--ledger",
    ledgerPath,
    "--table",
    NATIVE_WRITER_TABLE,
    "--rows",
    String(options.rows ?? 200),
    "--interval-ms",
    String(options.intervalMs ?? 25),
    "--duration-ms",
    String(options.durationMs ?? 120_000),
  ];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: cleanChildEnv({ ...inheritedProcessEnv() }) as NodeJS.ProcessEnv,
  });
  let output = "";
  const collect = (data: Buffer | string): void => {
    output += String(data);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const pid = child.pid;
  assert.equal(
    typeof pid,
    "number",
    `native writer ${options.label} must have a pid (spawn failed: ${output.slice(0, 400)})`,
  );
  const startedAt = new Date().toISOString();
  fs.writeFileSync(
    pidFilePath,
    `${JSON.stringify({
      label: options.label,
      pid,
      startedAt,
      db: options.dbPath,
      ledger: ledgerPath,
      table: NATIVE_WRITER_TABLE,
    })}\n`,
    "utf-8",
  );
  return {
    label: options.label,
    pid: pid as number,
    dbPath: options.dbPath,
    ledgerPath,
    pidFilePath,
    startedAt,
    child,
    output: () => output,
  };
}

/** Wait (bounded) for a child to exit. Never unbounded. */
function waitForChildExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", onExit);
  });
}

/**
 * Stop a native writer by its RECORDED pid — never by name, never by pattern —
 * and wait for it to exit. The pid is read back from the pid file this run
 * wrote before the writer's first commit, and is cross-checked against the pid
 * the writer itself announced, so the process stopped is provably the one that
 * was recorded.
 */
async function stopNativeWriterByPid(
  handle: NativeWriterHandle,
  reason: string,
  graceMs = 20_000,
): Promise<{ exitCode: number | null; signal: string | null; stoppedBy: string }> {
  const recorded = JSON.parse(fs.readFileSync(handle.pidFilePath, "utf-8")) as { pid: number };
  assert.equal(recorded.pid, handle.pid, "the recorded pid must be the spawned writer pid");
  const announced = /^pid=(\d+)\s/m.exec(handle.output())?.[1];
  if (announced !== undefined) {
    assert.equal(
      Number(announced),
      handle.pid,
      "the writer must announce the same pid that was recorded",
    );
  }
  let stoppedBy = `already-exited (${reason})`;
  try {
    process.kill(handle.pid, "SIGTERM");
    stoppedBy = `SIGTERM to recorded pid ${handle.pid} (${reason})`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  if (!(await waitForChildExit(handle.child, graceMs))) {
    process.kill(handle.pid, "SIGKILL");
    stoppedBy = `SIGKILL to recorded pid ${handle.pid} after ${graceMs}ms (${reason})`;
    const killed = await waitForChildExit(handle.child, 10_000);
    assert.equal(
      killed,
      true,
      `native writer ${handle.label} (recorded pid ${handle.pid}) could not be stopped`,
    );
  }
  return {
    exitCode: handle.child.exitCode,
    signal: handle.child.signalCode === null ? null : String(handle.child.signalCode),
    stoppedBy,
  };
}

interface WriterLedger {
  commits: Array<{ writer: string; seq: number }>;
  errors: Array<{ writer: string; seq: number; message: string }>;
  summary: Record<string, unknown> | null;
}

/** Read one writer's append-only ledger (its own account of what it committed). */
function readWriterLedger(ledgerPath: string): WriterLedger {
  const ledger: WriterLedger = { commits: [], errors: [], summary: null };
  const text = fs.readFileSync(ledgerPath, "utf-8").trimEnd();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry.kind === "commit") {
      ledger.commits.push({ writer: String(entry.writer), seq: Number(entry.seq) });
    } else if (entry.kind === "error") {
      ledger.errors.push({
        writer: String(entry.writer),
        seq: Number(entry.seq),
        message: String(entry.message ?? ""),
      });
    } else if (entry.kind === "summary") {
      ledger.summary = entry;
    }
  }
  return ledger;
}

/** Summarise one writer from its ledger (+ how it was stopped). */
function nativeWriterSummary(
  handle: NativeWriterHandle,
  ledger: WriterLedger,
  stop: { exitCode: number | null; signal: string | null; stoppedBy: string },
  stoppedAt: string,
): NativeWriterSummary {
  return {
    label: handle.label,
    pid: handle.pid,
    committed: ledger.commits.length,
    attempted: Number(ledger.summary?.attempted ?? ledger.commits.length),
    failed: Number(ledger.summary?.failed ?? ledger.errors.length),
    stopped: String(ledger.summary?.stopped ?? "unknown"),
    journalMode: String(ledger.summary?.journalMode ?? "unknown"),
    startedAt: handle.startedAt,
    stoppedAt,
    stoppedBy: stop.stoppedBy,
    exitCode: stop.exitCode,
  };
}

/**
 * Open the store and prove: integrity ok, every COMMITTED native record still
 * present, no unaccounted native rows, and (when asked) the guest's own rows.
 */
function inspectMixedStore(
  dbPath: string,
  ledgers: WriterLedger[],
  options: { expectSessions: boolean },
): {
  integrityCheck: string;
  journalMode: string;
  retained: Array<{ writer: string; seq: number }>;
  missing: string[];
  sessionsRows: number;
  header: number[];
} {
  const db = openE2eDatabase(dbPath);
  let retained: Array<{ writer: string; seq: number }> = [];
  let sessionsRows = 0;
  let integrityCheck = "unreadable";
  let journalMode = "unreadable";
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    integrityCheck = String(integrity?.integrity_check ?? "unreadable");
    const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    journalMode = String(mode?.journal_mode ?? "unreadable");
    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(NATIVE_WRITER_TABLE) as { name?: string } | undefined;
    if (hasTable !== undefined) {
      retained = db
        .prepare(`SELECT writer, seq FROM ${NATIVE_WRITER_TABLE} ORDER BY writer, seq`)
        .all() as Array<{ writer: string; seq: number }>;
    }
    if (options.expectSessions) {
      const hasSessions = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .get() as { name?: string } | undefined;
      if (hasSessions !== undefined) {
        const count = db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as
          | { n?: number }
          | undefined;
        sessionsRows = Number(count?.n ?? 0);
      }
    }
  } finally {
    db.close();
  }

  const present = new Set(retained.map((row) => `${row.writer}|${row.seq}`));
  const missing: string[] = [];
  let expected = 0;
  for (const ledger of ledgers) {
    for (const commit of ledger.commits) {
      expected += 1;
      const key = `${commit.writer}|${commit.seq}`;
      if (!present.has(key)) missing.push(key);
    }
  }
  assert.equal(
    retained.length,
    expected,
    `the store must hold exactly the ${expected} committed native records (got ${retained.length}); ` +
      "an uncommitted retry must never appear as a row",
  );

  const header = fs.readFileSync(dbPath).subarray(18, 20);
  return {
    integrityCheck,
    journalMode,
    retained,
    missing,
    sessionsRows,
    header: [header[0] as number, header[1] as number],
  };
}

/** Overlap of two closed windows in milliseconds (0 when either is unmeasured). */
function windowOverlapMs(
  left: { start: string; end: string },
  right: { start: string; end: string },
): number {
  const start = Math.max(Date.parse(left.start), Date.parse(right.start));
  const end = Math.min(Date.parse(left.end), Date.parse(right.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return end - start;
}

/**
 * The operator-facing remedy for a `sidecar-unresolved` refusal over ONE
 * observed store, composed from the SAME production functions the gate uses
 * (observe -> adapt -> evaluate -> render). Nothing here re-decides anything:
 * the verdict and the text come from G9/G8's own modules.
 */
function renderSidecarRemedy(storePath: string, configSource: string): {
  codes: string[];
  remedyText: string;
  storePath: string;
} {
  const observation = observeStore(storePath);
  const evaluated = adaptStoreObservation(observation, "required", {
    config: { journalMode: "delete", source: configSource, observed: true },
  });
  const verdict = evaluateGate({
    inventoryComplete: true,
    incompleteReasons: [],
    stores: [evaluated],
  });
  const codes = verdict.findings.map((finding) => finding.code);
  const remedyText = renderGateRemedyText({
    verdict,
    holderDetection: { observationComplete: true, holders: [], probeFailures: [] },
    stores: [evaluated],
    relaunchCommand: "tamandua matchlock hermes",
  });
  return { codes, remedyText, storePath: evaluated.identity?.canonicalPath ?? storePath };
}

/** The store row a receipt recorded for one store (canonical spelling only). */
function receiptStoreRow(
  receipt: ReturnType<typeof parseReceipt>,
  storePath: string,
): (ReturnType<typeof parseReceipt>)["stores"][number] | undefined {
  const canonical = (() => {
    try {
      return fs.realpathSync(storePath);
    } catch {
      return storePath;
    }
  })();
  return receipt.stores.find(
    (store) => store.canonicalPath === storePath || store.canonicalPath === canonical,
  );
}

/** The finding for one code, scoped to the store (or the set-scoped one). */
function findingFor(
  findings: readonly { code: string; store?: string | null; remedy?: Array<{ description: string }> }[],
  code: string,
  storePath: string,
): { code: string; store?: string | null; remedy?: Array<{ description: string }> } | undefined {
  const canonical = (() => {
    try {
      return fs.realpathSync(storePath);
    } catch {
      return storePath;
    }
  })();
  return findings.find(
    (finding) =>
      finding.code === code &&
      (finding.store === undefined ||
        finding.store === null ||
        finding.store === storePath ||
        finding.store === canonical),
  );
}

/**
 * Every assertion C2 must make about a `sidecar-unresolved` refusal, in ONE
 * place so the no-VM control and the real run path cannot drift apart.
 *
 * It proves: the closed reason-code vocabulary was respected, the finding is
 * scoped to the store carrying the journal, the receipt was written FIRST and
 * records the journal as presentNonEmpty, the operator remedy is the
 * ROLLBACK-journal remedy (quiescence + conversion) and NOT a checkpoint, and
 * the gate never deleted the journal.
 */
function assertSidecarUnresolvedRefusal(options: {
  refusal: {
    kind: string;
    exitCode: number;
    receiptWritten: boolean;
    receiptPath: string;
    findings: ReadonlyArray<{
      code: string;
      store?: string | null;
      remedy?: Array<{ description: string }>;
    }>;
  };
  storePath: string;
  journalPath: string;
  journalSize: number;
  configSource: string;
  label: string;
}): {
  findingCodes: string[];
  findingRemedy: string[];
  remedyText: string[];
  renderedCodes: string[];
  receiptPath: string;
} {
  const { refusal, storePath, journalPath, journalSize, label } = options;

  assert.equal(refusal.kind, "verdict", `${label}: a nonempty -journal is a VERDICT refusal`);
  assert.equal(refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE, `${label}: exit status is G9's`);
  assert.equal(refusal.receiptWritten, true, `${label}: the refusal receipt is written FIRST`);
  assert.ok(fs.existsSync(refusal.receiptPath), `${label}: the refusal receipt must exist`);

  const findingCodes = refusal.findings.map((finding) => finding.code);
  assert.ok(
    findingCodes.includes("sidecar-unresolved"),
    `${label}: expected sidecar-unresolved, got ${findingCodes.join(",")}`,
  );
  for (const code of findingCodes) {
    assert.ok(
      (REASON_CODE_ORDER as readonly string[]).includes(code),
      `${label}: ${code} must be one of the closed ten reason codes`,
    );
  }

  const journalFinding = refusal.findings.find(
    (finding) => finding.code === "sidecar-unresolved" && finding.store === storePath,
  );
  assert.ok(journalFinding, `${label}: the finding is scoped to the store carrying the journal`);
  const findingRemedy = (journalFinding?.remedy ?? []).map((step) => step.description);
  const findingRemedyText = findingRemedy.join(" ");
  assert.match(
    findingRemedyText,
    /rollback journal, not a write-ahead-log/i,
    `${label}: the finding's remedy must name the ROLLBACK journal`,
  );
  assert.doesNotMatch(
    findingRemedyText,
    /checkpoint the write-ahead-log/i,
    `${label}: a -journal must never be given the -wal checkpoint treatment`,
  );
  assert.match(
    findingRemedyText,
    /quiescen/i,
    `${label}: the finding's remedy must direct the operator to quiescence`,
  );

  const receipt = readReceipt(refusal.receiptPath);
  assert.equal(receipt.action, "refused", `${label}: the receipt records a refusal`);
  assert.equal(receipt.verdict, "refuse");
  const storeRow = receiptStoreRow(receipt, storePath);
  assert.ok(storeRow, `${label}: the receipt records the observed store`);
  assert.equal(
    storeRow?.sidecarState.journal,
    "presentNonEmpty",
    `${label}: the receipt records the -journal as presentNonEmpty`,
  );
  assert.equal(
    storeRow?.headerFormat,
    "rollback",
    `${label}: the store itself is compliant; the SIDECAR is the refusal`,
  );

  // G9's operator-facing text, composed from production functions only.
  const remedy = renderSidecarRemedy(storePath, options.configSource);
  assert.deepEqual(remedy.codes, ["sidecar-unresolved"], `${label}: the rendered verdict code set`);
  assert.match(remedy.remedyText, /ROLLBACK journal/, `${label}: the remedy names the rollback journal`);
  assert.match(
    remedy.remedyText,
    /a checkpoint is NOT a treatment for it/,
    `${label}: the remedy refuses the checkpoint treatment explicitly`,
  );
  assert.match(
    remedy.remedyText,
    /may be TRANSIENT/,
    `${label}: the remedy says the refusal may be transient`,
  );
  assert.doesNotMatch(
    remedy.remedyText,
    /checkpointing it is legitimate/,
    `${label}: the -wal checkpoint remedy must not be offered for a -journal`,
  );
  assert.match(
    remedy.remedyText,
    /hermes sessions set-journal-mode delete/,
    `${label}: the remedy names the supported conversion`,
  );

  // The gate OBSERVES sidecars; it never deletes or truncates them.
  assert.equal(fs.existsSync(journalPath), true, `${label}: the gate must NEVER delete the -journal file`);
  assert.equal(
    fs.statSync(journalPath).size,
    journalSize,
    `${label}: the -journal file must be untouched by the gate`,
  );

  return {
    findingCodes,
    findingRemedy,
    remedyText: remedy.remedyText.split("\n"),
    renderedCodes: remedy.codes,
    receiptPath: refusal.receiptPath,
  };
}


// ===========================================================================
// SCENARIO C — NO-VM CONTROLS (always run; no VM, no model, no daemon)
// ===========================================================================
describe("G8 admission qualification — SCENARIO C NO-VM CONTROLS (mixed overlap / transient journal)", () => {
  it("C1: two independent writer processes keep every committed record and pass PRAGMA integrity_check on one admitted store", async () => {
    const root = track(tamanduaShortTempDir("tamandua-g8q-c1-"));
    const profile = createScenarioProfile(root, "rollback");
    assert.deepEqual(profile.header, [1, 1], "the fixture store must be rollback-format (bytes 18/19 = 1)");
    assertDisposableProfilePath(profile.hermesHome, OPERATOR_HOME || "/home/operator");
    const stateDir = path.join(root, "state");

    // Two SEPARATE OS processes on ONE real store: the concurrency property
    // under test is a second independent connection committing while the first
    // is writing. In the real-VM tier the second writer is the admitted GUEST
    // round inside the VM on the identical-path mount (C1); here it is a second
    // host process, which this control states explicitly.
    const ROWS_PER_WRITER = 25;
    const writers = [
      startNativeWriter({
        label: "native-a",
        dbPath: profile.storePath,
        directory: root,
        rows: ROWS_PER_WRITER,
        intervalMs: 12,
        durationMs: 30_000,
      }),
      startNativeWriter({
        label: "native-b",
        dbPath: profile.storePath,
        directory: root,
        rows: ROWS_PER_WRITER,
        intervalMs: 12,
        durationMs: 30_000,
      }),
    ];
    const exitResults = await Promise.all(
      writers.map((writer) => waitForChildExit(writer.child, 60_000)),
    );
    for (const [index, writer] of writers.entries()) {
      assert.equal(
        exitResults[index],
        true,
        `writer ${writer.label} (recorded pid ${writer.pid}) did not exit within the bound: ${writer.output().slice(0, 600)}`,
      );
      assert.equal(
        writer.child.exitCode,
        0,
        `writer ${writer.label} (recorded pid ${writer.pid}) failed: ${writer.output().slice(0, 600)}`,
      );
    }

    const ledgers = writers.map((writer) => readWriterLedger(writer.ledgerPath));
    for (const [index, ledger] of ledgers.entries()) {
      assert.equal(
        ledger.commits.length,
        ROWS_PER_WRITER,
        `writer ${writers[index]?.label} must commit every row it attempted (committed ${ledger.commits.length})`,
      );
      assert.deepEqual(
        ledger.errors,
        [],
        `writer ${writers[index]?.label} recorded write errors: ${JSON.stringify(ledger.errors.slice(0, 3))}`,
      );
    }

    const check = inspectMixedStore(profile.storePath, ledgers, { expectSessions: false });
    assert.equal(check.integrityCheck, "ok", "PRAGMA integrity_check must return ok after the overlap");
    assert.deepEqual(check.missing, [], "every COMMITTED native record must still be present");
    assert.equal(check.retained.length, ROWS_PER_WRITER * 2, "both writers' records are retained");
    assert.deepEqual(check.header, [1, 1], "the store stays rollback-format while no writer requests WAL");

    // The store is still ADMISSIBLE: the mixed writes changed data, not policy.
    const allowed = evaluateScheduledDispatchGate(
      scenarioRound(scenarioHermesPolicy(profile.home), SCENARIO_C1_RUN_ID),
      { stateDir, configOptions: { managedDir: null } } as never,
    );
    assert.ok(allowed && allowed.action === "allow", "the mixed-written store must still allow a launch");
    assert.equal(allowed.binding.configJournalMode, "delete");

    // Evidence shape (no-VM control): the two outcomes are recorded, and the
    // limitation is stated rather than implying exclusion.
    const summaries = writers.map((writer, index) =>
      nativeWriterSummary(
        writer,
        ledgers[index] as WriterLedger,
        { exitCode: writer.child.exitCode, signal: null, stoppedBy: `exited on its own row budget` },
        new Date().toISOString(),
      ),
    );
    const evidence: ScenarioCEvidence = {
      scenario: "C1-mixed-overlap",
      gate: GATE_LABEL,
      mode: "no-vm-control",
      runId: SCENARIO_C1_RUN_ID,
      harness: "native",
      start: { commit: "1".repeat(40), tree: "2".repeat(40) },
      delivered: { commit: "1".repeat(40), tree: "2".repeat(40) },
      profileHome: profile.hermesHome,
      profileStore: profile.storePath,
      profileStoreHeader: profile.header,
      profileStoreSidecars: profile.sidecars,
      receiptPaths: [],
      qualificationRecordPath: "",
      image: { tag: FIXTURE_IMAGE_TAG, digest: "unreadable", configDigest: "unreadable" },
      matchlock: { path: MATCHLOCK_RPC_BIN, sha256: "unreadable", version: "unreadable" },
      guestInit: { path: "unreadable", sha256: "unreadable" },
      tamandua: { distRoot: path.join(repoRoot, "dist"), distVersionStamp: distVersionStamp() },
      mixedOverlap: {
        writers: summaries,
        guestWriter: null,
        window: {
          startedAt: String(summaries[0]?.startedAt ?? ""),
          stoppedAt: String(summaries[summaries.length - 1]?.stoppedAt ?? ""),
        },
        overlapMs: windowOverlapMs(
          { start: String(summaries[0]?.startedAt ?? ""), end: String(summaries[0]?.stoppedAt ?? "") },
          {
            start: String(summaries[1]?.startedAt ?? ""),
            end: String(summaries[1]?.stoppedAt ?? ""),
          },
        ),
        expectedRecords: ROWS_PER_WRITER * 2,
        retainedRecords: check.retained.length,
        missingRecords: check.missing,
        integrityCheck: check.integrityCheck,
        journalModeAtEnd: check.journalMode,
        headerAtEnd: check.header,
      },
      journalTransition: null,
      operatorHomeGate: null,
      designAcceptance: [C1_DESIGN_ACCEPTANCE],
      noLease: NO_LEASE_LIMITATION,
      observedVmIds: [],
      commands: [
        `node e2e-tests/helpers/store-native-writer.mjs --db ${profile.storePath} --writer native-a --rows ${ROWS_PER_WRITER}`,
        `node e2e-tests/helpers/store-native-writer.mjs --db ${profile.storePath} --writer native-b --rows ${ROWS_PER_WRITER}`,
      ],
      notes: [
        "NO-VM CONTROL: both writers are host processes; the real-VM tier's second writer is the admitted GUEST round.",
        ...scenarioCOutcomeSummary({
          mixedOverlap: {
            writers: summaries,
            guestWriter: null,
            window: { startedAt: "", stoppedAt: "" },
            overlapMs: 0,
            expectedRecords: ROWS_PER_WRITER * 2,
            retainedRecords: check.retained.length,
            missingRecords: check.missing,
            integrityCheck: check.integrityCheck,
            journalModeAtEnd: check.journalMode,
            headerAtEnd: check.header,
          },
          journalTransition: null,
        }),
        "Neither unconditional admission during every transaction nor process-lifetime exclusivity is claimed.",
      ],
    };
    const file = writeScenarioCEvidence(scenarioCDirectory(root, "C1-mixed-overlap"), evidence);
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as ScenarioCEvidence;
    assert.equal(parsed.mixedOverlap?.integrityCheck, "ok");
    assert.deepEqual(parsed.mixedOverlap?.missingRecords, []);
    assert.equal(parsed.noLease, NO_LEASE_LIMITATION);
    for (const writer of parsed.mixedOverlap?.writers ?? []) {
      assert.ok(writer.pid > 0, "every writer's pid is recorded in the evidence");
      assert.match(writer.stoppedBy, /recorded pid|exited/i);
    }
  });

  it("C2: a nonempty -journal refuses with sidecar-unresolved and the rollback-journal remedy, then allows after a quiescent removal", () => {
    const root = track(tamanduaShortTempDir("tamandua-g8q-c2-"));
    const profile = createScenarioProfile(root, "rollback");
    const stateDir = path.join(root, "state");
    const journalPath = `${profile.storePath}-journal`;
    const configSource = path.join(profile.hermesHome, "config.yaml");
    const round = scenarioRound(scenarioHermesPolicy(profile.home), SCENARIO_C2_RUN_ID);
    const deps = { stateDir, configOptions: { managedDir: null } };

    // Leg 0 — the compliant store allows. C2's refusal is the JOURNAL, so the
    // same profile must allow while no journal is present.
    const baseline = evaluateScheduledDispatchGate(round, deps as never);
    assert.ok(baseline && baseline.action === "allow", "the quiescent compliant store must allow");
    assert.equal(fs.existsSync(journalPath), false, "a quiescent compliant store has no -journal sidecar");

    // Leg 1 — a NONEMPTY rollback journal appears beside the real store.
    const journalSize = writeNonEmptyRollbackJournal(journalPath);
    const before = scenarioProfileInventory(profile.hermesHome);
    const attempt = evaluateScheduledAttemptGate(round, deps as never);
    assert.ok(attempt && attempt.action === "refuse", "a nonempty -journal must refuse the launch");
    if (!attempt || attempt.action !== "refuse") return;
    const refusal = assertSidecarUnresolvedRefusal({
      refusal: attempt.refusal,
      storePath: profile.storePath,
      journalPath,
      journalSize,
      configSource,
      label: "scenario C2 (no-VM control)",
    });

    // ZERO create surface and no partial mount: the refusal precedes every VM.
    assert.deepEqual(
      readRunnerVmEvidenceIds(path.join(stateDir, "runs"), SCENARIO_C2_RUN_ID),
      [],
      "the hermes runner never ran (no per-VM evidence dir)",
    );
    const inventory = readVmInventory(profile.home);
    assert.deepEqual(inventory.rows, []);
    assert.deepEqual(inventory.dirIds, []);
    assert.deepEqual(scenarioProfileInventory(profile.hermesHome), before, "no partial mount");

    // ── quiescence, then removal ────────────────────────────────────────────
    // No writer process is alive in this control: the fixture created the
    // journal by hand and every connection it opened is closed, so the store is
    // quiescent by construction. RECORDED, never assumed.
    const liveWriterPids: number[] = [];
    const identityBefore = fs.statSync(profile.storePath);
    fs.unlinkSync(journalPath);
    const identityAfter = fs.statSync(profile.storePath);
    assert.equal(identityAfter.ino, identityBefore.ino, "the store is the same file after the removal");
    assert.equal(identityAfter.size, identityBefore.size, "the store content is unchanged by observation");

    // The NEXT observation allows: the refusal was the transient journal, never
    // the store. The same invocation id re-observes and writes nothing on allow,
    // so the refusal receipt stays the durable record of the transient refusal.
    const allowed = evaluateScheduledAttemptGate(round, deps as never);
    assert.ok(allowed && allowed.action === "allow", "the store must allow once the journal is gone");
    if (!allowed || allowed.action !== "allow") return;
    assert.equal(allowed.binding.configJournalMode, "delete");
    assert.equal(
      readReceipt(refusal.receiptPath).action,
      "refused",
      "the refusal receipt remains the record of the transient refusal",
    );

    const evidence: ScenarioCEvidence = {
      scenario: "C2-journal-transition",
      gate: GATE_LABEL,
      mode: "no-vm-control",
      runId: SCENARIO_C2_RUN_ID,
      harness: "hermes",
      start: { commit: "1".repeat(40), tree: "2".repeat(40) },
      delivered: { commit: "1".repeat(40), tree: "2".repeat(40) },
      profileHome: profile.hermesHome,
      profileStore: profile.storePath,
      profileStoreHeader: profile.header,
      profileStoreSidecars: profile.sidecars,
      receiptPaths: [refusal.receiptPath],
      qualificationRecordPath: "",
      image: { tag: FIXTURE_IMAGE_TAG, digest: "unreadable", configDigest: "unreadable" },
      matchlock: { path: MATCHLOCK_RPC_BIN, sha256: "unreadable", version: "unreadable" },
      guestInit: { path: "unreadable", sha256: "unreadable" },
      tamandua: { distRoot: path.join(repoRoot, "dist"), distVersionStamp: distVersionStamp() },
      mixedOverlap: null,
      journalTransition: {
        storePath: profile.storePath,
        journalPath,
        journalSize,
        refusal: {
          invocationId: allowed.binding.invocationId,
          receiptPath: refusal.receiptPath,
          findingCodes: refusal.findingCodes,
          findingRemedy: refusal.findingRemedy,
          remedyText: refusal.remedyText,
          renderedCodes: refusal.renderedCodes,
        },
        quiescence: {
          liveWriterPids,
          storeIdentityUnchanged: true,
          journalNeverDeletedByGate: true,
          removedAt: new Date().toISOString(),
        },
        allow: {
          invocationId: allowed.binding.invocationId,
          configJournalMode: allowed.binding.configJournalMode,
          storeSetKey: allowed.binding.storeSetKey,
        },
      },
      operatorHomeGate: null,
      designAcceptance: [C2_DESIGN_ACCEPTANCE],
      noLease: NO_LEASE_LIMITATION,
      observedVmIds: [],
      commands: [
        `# leg 1: create a nonempty rollback journal beside ${profile.storePath}`,
        `# leg 2: tamandua matchlock hermes (refused: sidecar-unresolved)`,
        `# leg 3: rm -f ${journalPath}   # after quiescence`,
      ],
      notes: [
        "NO-VM CONTROL: the refusal and the later allow are evaluated through the PRODUCTION scheduled gate over a disposable profile.",
        "The gate never deletes the -journal file and the remedy never offers a checkpoint: a rollback journal is not a write-ahead-log.",
        ...scenarioCOutcomeSummary({
          mixedOverlap: null,
          journalTransition: {
            storePath: profile.storePath,
            journalPath,
            journalSize,
            refusal: {
              invocationId: allowed.binding.invocationId,
              receiptPath: refusal.receiptPath,
              findingCodes: refusal.findingCodes,
              findingRemedy: refusal.findingRemedy,
              remedyText: refusal.remedyText,
              renderedCodes: refusal.renderedCodes,
            },
            quiescence: {
              liveWriterPids,
              storeIdentityUnchanged: true,
              journalNeverDeletedByGate: true,
              removedAt: "",
            },
            allow: {
              invocationId: allowed.binding.invocationId,
              configJournalMode: allowed.binding.configJournalMode,
              storeSetKey: allowed.binding.storeSetKey,
            },
          },
        }),
        "Neither unconditional admission during every transaction nor process-lifetime exclusivity is claimed.",
      ],
    };
    const file = writeScenarioCEvidence(scenarioCDirectory(root, "C2-journal-transition"), evidence);
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as ScenarioCEvidence;
    assert.ok(parsed.journalTransition?.refusal.findingCodes.includes("sidecar-unresolved"));
    assert.equal(parsed.journalTransition?.allow.configJournalMode, "delete");
    assert.equal(parsed.noLease, NO_LEASE_LIMITATION);
    assert.ok(
      (parsed.journalTransition?.refusal.remedyText ?? []).some((line) => /ROLLBACK journal/.test(line)),
      "the recorded remedy names the rollback journal",
    );
  });
});


// ===========================================================================
// SCENARIO A — REAL-RUN scenarios (opt-in tier; isolated daemon → scheduler →
// Matchlock hermes runner). Both run with DISPOSABLE homes under the evidence
// dir and never read or write the operator's `.hermes`.
// ===========================================================================

function seedScenarioImageCache(srcCacheDir: string, targetHomeDir: string): void {
  const srcImages = path.join(srcCacheDir, "images");
  assert.ok(fs.existsSync(srcImages), `fixture image cache has no images dir: ${srcImages}`);
  const dstImages = path.join(targetHomeDir, ".cache", "matchlock", "images");
  fs.mkdirSync(path.join(dstImages, "blobs"), { recursive: true });
  const linkOrCopy = (src: string, dst: string): void => {
    try {
      fs.linkSync(src, dst);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        fs.rmSync(dst, { force: true });
        fs.linkSync(src, dst);
        return;
      }
      fs.copyFileSync(src, dst); // cross-device / hardlink-unsupported fallback
    }
  };
  const blobsSrc = path.join(srcImages, "blobs");
  if (fs.existsSync(blobsSrc)) {
    for (const name of fs.readdirSync(blobsSrc)) {
      linkOrCopy(path.join(blobsSrc, name), path.join(dstImages, "blobs", name));
    }
  }
  for (const name of fs.readdirSync(srcImages)) {
    if (name === "blobs") continue;
    const src = path.join(srcImages, name);
    const dst = path.join(dstImages, name);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true });
    else fs.copyFileSync(src, dst);
  }
  // RELOCATE absolute rootfs paths: the copied metadata may still name the SOURCE
  // store's blobs. Blob names are content-addressed, so re-point every row at
  // THIS store's blobs (best effort — `image resolve` remains the authority).
  try {
    const db = openE2eDatabase(path.join(dstImages, "metadata.db"));
    try {
      const rows = db.prepare("SELECT rowid AS rid, rootfs_path FROM images").all() as Array<{
        rid: number;
        rootfs_path: string | null;
      }>;
      const update = db.prepare("UPDATE images SET rootfs_path = ? WHERE rowid = ?");
      for (const row of rows) {
        const name = path.basename(String(row.rootfs_path ?? ""));
        if (name === "") continue;
        update.run(path.join(dstImages, "blobs", name), row.rid);
      }
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } catch {
    /* a store whose schema differs stays as-is; resolve is the authority */
  }
}

function dockerBuildScenarioFixture(): void {
  // DOCKER_BUILDKIT=0: the legacy builder is HERMETIC (local layers only). The
  // default buildx path wants a builder container (and network) and can block
  // indefinitely in a restricted host; the produced image content — and so the
  // matchlock content digest — is identical either way.
  const build = spawnSync(
    "/usr/bin/docker",
    ["build", "-f", FIXTURE_DOCKERFILE, "-t", FIXTURE_IMAGE_TAG, "."],
    {
      cwd: FIXTURE_DOCKER_DIR,
      encoding: "utf-8",
      maxBuffer: 128 * 1024 * 1024,
      timeout: 10 * 60_000,
      env: { ...inheritedProcessEnv(), DOCKER_BUILDKIT: "0" },
    },
  );
  assert.equal(
    build.status,
    0,
    `scenario A2: docker build ${FIXTURE_DOCKERFILE} failed (status=${String(build.status)} signal=${String(build.signal)}):\n${(build.stdout ?? "").slice(-1500)}\n${(build.stderr ?? "").slice(-3000)}`,
  );
}

/** Positive bound for `docker save | matchlock image import` (multi-GB stream). */
const SCENARIO_IMAGE_IMPORT_TIMEOUT_MS = 30 * 60_000;

async function importScenarioImage(
  dockerTag: string,
  storeTag: string,
  homeDir: string,
): Promise<void> {
  const importEnv = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
  const save = spawn("/usr/bin/docker", ["save", dockerTag], { stdio: ["ignore", "pipe", "pipe"] });
  const imp = spawn(MATCHLOCK_RPC_BIN, ["image", "import", storeTag], {
    stdio: ["pipe", "pipe", "pipe"],
    env: importEnv as NodeJS.ProcessEnv,
  });
  let saveErr = "";
  let impErr = "";
  save.stderr.on("data", (data: Buffer | string) => (saveErr += String(data)));
  imp.stderr.on("data", (data: Buffer | string) => (impErr += String(data)));
  save.stdout.pipe(imp.stdin);
  const bounded = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      save.kill("SIGKILL");
      imp.kill("SIGKILL");
      reject(
        new Error(
          `scenario image import: docker save | matchlock image import exceeded ${SCENARIO_IMAGE_IMPORT_TIMEOUT_MS}ms`,
        ),
      );
    }, SCENARIO_IMAGE_IMPORT_TIMEOUT_MS);
    timer.unref?.();
    const saveClose = new Promise<number | null>((res) => save.on("close", res));
    const impClose = new Promise<number | null>((res) => imp.on("close", res));
    Promise.all([saveClose, impClose]).then(([saveCode, impCode]) => {
      clearTimeout(timer);
      if (saveCode !== 0) {
        reject(new Error(`scenario image import: docker save ${dockerTag} failed: ${saveErr.slice(-2000)}`));
        return;
      }
      if (impCode !== 0) {
        reject(new Error(`scenario image import: matchlock image import ${storeTag} failed: ${impErr.slice(-2000)}`));
        return;
      }
      resolve();
    });
  });
  await bounded;
}

function tryResolveScenarioImage(
  tag: string,
  homeDir: string,
): { digest: string; configDigest: string } | null {
  const resolved = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", tag], {
    encoding: "utf-8",
    env: cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir }) as NodeJS.ProcessEnv,
    timeout: 120_000,
  });
  if (resolved.status !== 0) return null;
  try {
    const parsed = JSON.parse((resolved.stdout ?? "").trim()) as {
      digest?: string;
      config_digest?: string;
    };
    if (
      typeof parsed.digest !== "string" ||
      !parsed.digest.startsWith("sha256:") ||
      typeof parsed.config_digest !== "string" ||
      !parsed.config_digest.startsWith("sha256:")
    ) {
      return null;
    }
    return { digest: parsed.digest, configDigest: parsed.config_digest };
  } catch {
    return null;
  }
}

/** Copy the operator kernel cache into a scenario HOME (never mutating the source). */
function seedScenarioKernelCache(targetHomeDir: string): void {
  if (OPERATOR_CACHE.length === 0) return;
  const source = path.join(OPERATOR_CACHE, "kernels");
  if (!fs.existsSync(source)) return;
  const destination = path.join(targetHomeDir, ".cache", "matchlock", "kernels");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

/** True when a seeded store actually carries immutable blobs (not stale metadata). */
function storeHasImageBlobs(storeDir: string): boolean {
  const blobs = path.join(storeDir, "images", "blobs");
  return fs.existsSync(blobs) && fs.readdirSync(blobs).length > 0;
}

/**
 * The gate-owned fixture-image cache shared by both scenarios (and by repeat
 * driver runs). It is NEVER the operator store: bytes are hardlinked, metadata
 * copied, so a scenario's matchlock can mutate its own store freely.
 */
function scenarioImageCacheRoot(evidenceRoot: string): string {
  return EVIDENCE_ROOT.length > 0
    ? path.join(EVIDENCE_ROOT, "admission-qualification-image-cache")
    : path.join(evidenceRoot, "scenario-a", ".image-cache");
}

/** Resolve the synthetic-hermes fixture image into ONE scenario's private HOME. */
async function provisionScenarioFixtureImage(
  homeDir: string,
  evidenceRoot: string,
): Promise<{ digest: string; configDigest: string }> {
  seedScenarioKernelCache(homeDir);
  const sharedStore = path.join(scenarioImageCacheRoot(evidenceRoot), ".cache", "matchlock");
  const externalCache = fixtureImageCacheDir();
  const candidates = [sharedStore, externalCache].filter(
    (candidate) => candidate.length > 0 && storeHasImageBlobs(candidate),
  );
  for (const candidate of candidates) {
    seedScenarioImageCache(candidate, homeDir);
    const cached = tryResolveScenarioImage(FIXTURE_IMAGE_TAG, homeDir);
    if (cached !== null) return cached;
    // A stale cache must never be a silent pass: fall through to a real build.
  }
  dockerBuildScenarioFixture();
  await importScenarioImage(FIXTURE_IMAGE_TAG, FIXTURE_IMAGE_TAG, homeDir);
  const identity = tryResolveScenarioImage(FIXTURE_IMAGE_TAG, homeDir);
  assert.ok(
    identity !== null,
    `scenario A2: ${FIXTURE_IMAGE_TAG} did not resolve to an immutable identity in the private store`,
  );
  // Share the freshly imported store with the other scenario / later runs.
  try {
    seedScenarioImageCache(path.join(homeDir, ".cache", "matchlock"), scenarioImageCacheRoot(evidenceRoot));
  } catch {
    /* a cache-share failure must never fail the qualification */
  }
  return identity;
}

/**
 * A1 never boots a VM, so its run only needs an image identity that RESOLVES at
 * run creation (admission pins it). The synthetic-hermes fixture is therefore
 * reused when already present; otherwise the SMALLEST save-able real image is
 * imported — the refusal under test is the STORE gate, and the image digest the
 * run pinned is recorded as evidence.
 */
const A1_ADMISSION_PROBE_IMAGE_TAG = "tamandua-g8-admission-probe:image";
const A1_ADMISSION_PROBE_DOCKER_CANDIDATES = [
  "tamandua-synthetic-pi:gate-fixture",
  "tamandua-synthetic-dsh:gate-fixture",
  "igorhvr/bedlam-ubuntu:latest",
] as const;

async function provisionAdmissionProbeImage(
  homeDir: string,
  evidenceRoot: string,
): Promise<{ tag: string; digest: string; configDigest: string }> {
  seedScenarioKernelCache(homeDir);
  const sharedStore = path.join(scenarioImageCacheRoot(evidenceRoot), ".cache", "matchlock");
  const externalCache = fixtureImageCacheDir();
  for (const cacheStore of [sharedStore, externalCache]) {
    if (cacheStore.length === 0 || !storeHasImageBlobs(cacheStore)) continue;
    seedScenarioImageCache(cacheStore, homeDir);
    const fixture = tryResolveScenarioImage(FIXTURE_IMAGE_TAG, homeDir);
    if (fixture !== null) return { tag: FIXTURE_IMAGE_TAG, ...fixture };
  }
  const fixtureHere = tryResolveScenarioImage(FIXTURE_IMAGE_TAG, homeDir);
  if (fixtureHere !== null) return { tag: FIXTURE_IMAGE_TAG, ...fixtureHere };
  const existing = tryResolveScenarioImage(A1_ADMISSION_PROBE_IMAGE_TAG, homeDir);
  if (existing !== null) return { tag: A1_ADMISSION_PROBE_IMAGE_TAG, ...existing };
  const failures: string[] = [];
  for (const dockerTag of A1_ADMISSION_PROBE_DOCKER_CANDIDATES) {
    try {
      await importScenarioImage(dockerTag, A1_ADMISSION_PROBE_IMAGE_TAG, homeDir);
    } catch (error) {
      failures.push(`${dockerTag}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const imported = tryResolveScenarioImage(A1_ADMISSION_PROBE_IMAGE_TAG, homeDir);
    if (imported !== null) return { tag: A1_ADMISSION_PROBE_IMAGE_TAG, ...imported };
    failures.push(`${dockerTag}: imported but did not resolve`);
  }
  throw new Error(
    `scenario A1: no save-able image could be imported for the admission pin:\n${failures.join("\n")}`,
  );
}

/** The exact sandbox signatures that block VM creation (recorded as ENVIRONMENT). */
const SANDBOX_VM_BLOCK_RE =
  /TUNSETIFF: operation not permitted|netlink receive: operation not permitted|create TAP device|nf_tables/i;

/** Find the exact VM-boot block signature in the scenario's own logs/events. */
function findSandboxVmBlockSignature(files: string[]): string | null {
  for (const candidate of files) {
    if (candidate === "" || !fs.existsSync(candidate)) continue;
    let text = "";
    try {
      text = fs.readFileSync(candidate, "utf-8");
    } catch {
      continue;
    }
    const match = SANDBOX_VM_BLOCK_RE.exec(text);
    if (match === null || match.index === undefined) continue;
    // Bounded CONTEXT AROUND the match, not the line start: the signature can
    // sit at the end of a long structured log line, and the evidence must carry
    // the exact text an operator can grep for.
    const start = Math.max(0, match.index - 80);
    const end = Math.min(text.length, match.index + match[0].length + 160);
    const window = text.slice(start, end).replace(/\s+/g, " ").trim();
    return `${path.basename(candidate)}: ${window}`;
  }
  return null;
}

/**
 * The executing process's own portable privilege signature (part of the
 * ENVIRONMENT record). Deliberately NO /proc read: the kernel-level
 * NoNewPrivs/CapEff proof is not portable, and the exact EPERM signature is
 * already recorded verbatim from the run log. What is recorded here is the
 * process identity that cannot be faked by the gate.
 */
function sandboxSelfSignature(): Record<string, string> {
  const euid = typeof process.geteuid === "function" ? process.geteuid() : "unavailable";
  const uid = typeof process.getuid === "function" ? process.getuid() : "unavailable";
  return {
    platform: process.platform,
    arch: process.arch,
    uid: String(uid),
    euid: String(euid),
    node: process.version,
  };
}

function readMatchlockVersion(): string {
  if (MATCHLOCK_RPC_BIN === "") return "unreadable";
  const version = spawnSync(MATCHLOCK_RPC_BIN, ["--version"], {
    encoding: "utf-8",
    env: { ...inheritedProcessEnv(), ...matchlockRuntimeEnv() },
    timeout: 30_000,
  });
  return version.status === 0 ? (version.stdout ?? "").trim() || "no-version" : "unreadable";
}

function distVersionStamp(): string {
  try {
    return fs.readFileSync(path.join(repoRoot, "dist", "version"), "utf-8").trim();
  } catch {
    return "unreadable";
  }
}

/** Boot one isolated daemon for a scenario and return its stop observation. */
async function withScenarioDaemon<T>(
  profile: ScenarioProfile,
  controlPort: number,
  env: Record<string, string>,
  body: () => Promise<T>,
): Promise<T> {
  const tamanduaDir = path.join(profile.home, ".tamandua");
  fs.mkdirSync(tamanduaDir, { recursive: true });
  fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
  const daemon = await startIsolatedDaemon(profile.home, controlPort, env);
  try {
    return await body();
  } finally {
    const observed = await stopIsolatedDaemonScoped(daemon);
    fs.writeFileSync(
      path.join(profile.home, "daemon-close-observed.json"),
      `${JSON.stringify(observed, null, 2)}\n`,
      "utf-8",
    );
  }
}

/**
 * A metadata-only SIGNATURE of the operator's profile root.
 *
 * The gate must never touch it. Its container directory, however, is AMBIENT on
 * this host: the operator home is a LIVE agent home (this very session writes
 * `state.db` there), so the directory's own mtime churns with no gate
 * involvement. The signature therefore keeps the two facts a gate write WOULD
 * change and an ambient writer would not:
 *
 *   - the sorted ENTRY NAME SET (nothing created, removed or renamed), and
 *   - the effective config file's identity (mtime/ino/size).
 *
 * The container directory's metadata is RECORDED, never compared: treating it
 * as gate evidence is exactly how an unrelated agent session gets misread as a
 * gate write. Content is never read.
 */
interface OperatorHomeObservation {
  /** The operator profile root (`.hermes`), or "" when the home is unset. */
  profileRoot: string;
  present: boolean;
  entries: string[];
  config: string;
  directory: string;
}

function observeOperatorProfileRoot(profileRoot: string): OperatorHomeObservation {
  try {
    const directory = fs.statSync(profileRoot);
    const entries = fs.readdirSync(profileRoot).sort();
    let config = "config=absent";
    try {
      const stat = fs.statSync(path.join(profileRoot, "config.yaml"));
      config = `config=mtime=${stat.mtimeMs} ino=${stat.ino} size=${stat.size}`;
    } catch {
      /* an absent config is a state, not an error */
    }
    return {
      profileRoot,
      present: true,
      entries,
      config,
      directory: `dir=mtime=${directory.mtimeMs} ino=${directory.ino}`,
    };
  } catch {
    return {
      profileRoot,
      present: false,
      entries: [],
      config: "config=absent",
      directory: "dir=absent",
    };
  }
}

function operatorHomeSignature(operatorHome: string): OperatorHomeObservation {
  if (operatorHome === "") {
    return {
      profileRoot: "",
      present: false,
      entries: [],
      config: "config=absent",
      directory: "operator-home-unset",
    };
  }
  return observeOperatorProfileRoot(operatorHermesDir(operatorHome));
}

/**
 * Prove the operator profile root is untouched by the gate: no entry created,
 * removed or renamed and no configuration edit. The container mtime is NOT a
 * failure input (see {@link OperatorHomeObservation}); it is returned so the
 * evidence can disclose the ambient churn instead of hiding it.
 */
function assertOperatorHomeUntouched(
  before: OperatorHomeObservation,
  label: string,
): OperatorHomeObservation {
  const after = before.profileRoot === "" ? before : observeOperatorProfileRoot(before.profileRoot);
  assert.equal(
    after.present,
    before.present,
    `${label}: the operator profile root must be untouched (it must not appear or disappear)`,
  );
  assert.deepEqual(
    after.entries,
    before.entries,
    `${label}: the operator profile root must be untouched — the gate creates, removes and renames NOTHING there`,
  );
  assert.equal(
    after.config,
    before.config,
    `${label}: the operator profile root must be untouched — its config must NOT be edited`,
  );
  return after;
}

/** The evidence record for the operator-home gate (ambient churn disclosed). */
interface OperatorHomeGate {
  operatorHome: string;
  profileRoot: string;
  entriesUnchanged: boolean;
  configUnchanged: boolean;
  ambientDirectoryMtimeChanged: boolean;
}

function operatorHomeGateRecord(
  before: OperatorHomeObservation,
  after: OperatorHomeObservation,
): OperatorHomeGate {
  return {
    operatorHome: OPERATOR_HOME || "(unset)",
    profileRoot: before.profileRoot,
    entriesUnchanged: JSON.stringify(after.entries) === JSON.stringify(before.entries),
    configUnchanged: after.config === before.config,
    ambientDirectoryMtimeChanged: after.directory !== before.directory,
  };
}

/** Compare two run-id spellings (either may carry the `run-` prefix). */
function sameRunId(left: unknown, right: string): boolean {
  const bare = (value: unknown): string => String(value ?? "").replace(/^run-/, "");
  return bare(left) === bare(right);
}

/**
 * Defence in depth for "disposable profiles only": read the run's PERSISTED
 * Matchlock policy and prove every profile root it froze points at the
 * scenario's own disposable home — never the operator profile. An ambient
 * HERMES_HOME would otherwise be frozen into the policy and the round would read
 * the operator's real stores.
 */
function assertPersistedPolicyIsDisposable(
  tamanduaDir: string,
  runId: string,
  profile: ScenarioProfile,
): void {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  let raw: string | null = null;
  try {
    const row = db.prepare("SELECT matchlock_policy FROM runs WHERE id = ?").get(runId) as
      | { matchlock_policy: string | null }
      | undefined;
    assert.ok(row, `scenario A: no persisted run row for ${runId}`);
    raw = row.matchlock_policy;
  } finally {
    db.close();
  }
  assert.ok(raw, "scenario A: the run must carry a persisted Matchlock policy");
  const policy = JSON.parse(String(raw)) as {
    configurationRoot?: string;
    hermes?: { homeDir?: string; hermesHomeEnv?: string | null };
  };
  const scenarioRoot = path.resolve(profile.home);
  const forbidden = OPERATOR_HOME === "" ? "" : path.resolve(operatorHermesDir(OPERATOR_HOME));
  const roots: Array<[string, string | null | undefined]> = [
    ["configurationRoot", policy.configurationRoot],
    ["hermes.homeDir", policy.hermes?.homeDir],
    ["hermes.hermesHomeEnv", policy.hermes?.hermesHomeEnv ?? null],
  ];
  for (const [label, value] of roots) {
    if (value === undefined || value === null || value === "") continue;
    const resolved = path.resolve(value);
    assert.ok(
      resolved === scenarioRoot || resolved.startsWith(`${scenarioRoot}${path.sep}`),
      `scenario A: ${label} must point at the DISPOSABLE scenario home (${scenarioRoot}), got ${resolved}`,
    );
    assert.ok(
      forbidden === "" || (resolved !== forbidden && !resolved.startsWith(`${forbidden}${path.sep}`)),
      `scenario A: ${label} must NEVER point at the operator profile (${forbidden}), got ${resolved}`,
    );
  }
}

/** A1: the unconverted (WAL) store must be refused through the REAL run path. */
async function runScenarioA1Refusal(evidenceRoot: string): Promise<string> {
  const directory = prepareScenarioDirectory(evidenceRoot, "A1-refusal");
  const profile = createScenarioProfile(directory, "wal");
  assertDisposableProfilePath(profile.hermesHome, OPERATOR_HOME);
  const repoDir = prepareScenarioRepo(path.join(directory, "repo"));
  const before = scenarioProfileInventory(profile.hermesHome);
  const operatorBefore = operatorHomeSignature(OPERATOR_HOME);
  const commands: string[] = [];
  const notes: string[] = [
    "A1 refuses an UNCONVERTED store: config.yaml requests journal_mode=delete while state.db is a real WAL store (PRAGMA journal_mode=WAL).",
    "The refusal is evaluated at scheduled DISPATCH, before the launch probe and before any VM create.",
    "Evidence is produced by the real isolated daemon -> scheduler -> Matchlock hermes path, never by an ad-hoc shell probe.",
    "The image named here is the identity pinned at run creation only: A1 creates no VM, so the image is never booted. The refusal is the STORE gate.",
    "The operator home is only ever referenced: no entry in it was created, removed or renamed and its config was unchanged (the live home's own directory-mtime churn is recorded, never treated as gate evidence).",
  ];
  const start = scenarioGitIdentity(repoRoot);
  const tamanduaDir = path.join(profile.home, ".tamandua");

  const handles = await reservePortHandles(1);
  const controlPort = handles[0].port;
  const env = scenarioEnv(profile.home, controlPort);
  await releasePortReservations({ portHandles: handles });

  let runId = "";
  // The submitted run PINS an image identity at admission, so A1 needs a
  // RESOLVABLE image — never a bootable one: the refusal under test is the
  // STORE gate and it precedes every image use.
  const image = await provisionAdmissionProbeImage(profile.home, evidenceRoot);
  commands.push(`matchlock image resolve ${image.tag}   # private HOME=${profile.home}`);
  await withScenarioDaemon(profile, controlPort, env, async () => {
    commands.push(`tamandua workflow install do-now   # HOME=${profile.home}`);
    cliMustSucceed(["workflow", "install", "do-now"], env, "scenario A1: install do-now");
    const runArgs = [
      "workflow", "run", "do-now",
      "G8 scenario A1: an unconverted (WAL) store must be refused before any VM.",
      "--hermes-as-harness",
      "--working-directory-for-harness", repoDir,
      "--matchlock-image", image.tag,
    ];
    commands.push(`tamandua ${runArgs.join(" ")}`);
    const prefix = await spawnWorkflowRun(runArgs, env, 120_000);
    runId = resolveFullRunId(prefix, tamanduaDir);
    // The run's policy is FROZEN at submission: prove it targets the
    // disposable profile before allowing the round to reach the gate.
    assertPersistedPolicyIsDisposable(tamanduaDir, runId, profile);
    commands.push(`tamandua workflow status ${runId}`);
    const status = await pollScenarioTerminal(runId, env, tamanduaDir, 10 * 60_000);
    assert.equal(status, "failed", `scenario A1: a refused run must be terminal failed (got ${status})`);
  });

  const events = readRunEvents(tamanduaDir, runId);
  const refusals = events.filter((event) => event.event === "run.matchlock_gate_refused");
  assert.equal(refusals.length, 1, `scenario A1: exactly ONE refusal event (got ${refusals.length})`);
  const refusalEvent = refusals[0] as Record<string, unknown>;
  assert.equal(refusalEvent.harness, "hermes");
  assert.equal(refusalEvent.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
  const findingCodes = (refusalEvent.findingCodes as string[] | undefined) ?? [];
  assert.ok(
    findingCodes.includes("wal-header"),
    `scenario A1: expected wal-header, got ${findingCodes.join(",")}`,
  );
  const receiptPath = String(refusalEvent.receiptPath ?? "");
  assert.ok(receiptPath !== "", "scenario A1: the event must name the refusal receipt");
  assert.ok(fs.existsSync(receiptPath), `scenario A1: refusal receipt missing at ${receiptPath}`);

  const receipt = readReceipt(receiptPath);
  assert.equal(receipt.action, "refused");
  assert.equal(receipt.verdict, "refuse");
  assert.ok(sameRunId(receipt.invocation.runId, runId), "scenario A1: the receipt names THIS run");
  const storeRow = receipt.stores.find(
    (store) =>
      store.canonicalPath === profile.storePath ||
      store.canonicalPath === fs.realpathSync(profile.storePath),
  );
  assert.ok(storeRow, "scenario A1: the receipt records the refused store");
  assert.equal(storeRow.headerFormat, "wal");

  const inventory = readVmInventory(profile.home);
  assert.deepEqual(inventory.rows, [], "scenario A1: zero owned VM rows");
  assert.deepEqual(inventory.dirIds, [], "scenario A1: zero owned VM state dirs");
  assert.deepEqual(
    readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), runId),
    [],
    "scenario A1: the hermes runner never ran",
  );
  assert.deepEqual(scenarioProfileInventory(profile.hermesHome), before, "scenario A1: no partial mount");
  assertOperatorHomeUntouched(operatorBefore, "scenario A1");

  assertNoOwnedVms(profile.home, "scenario A1", {
    rpcBin: MATCHLOCK_RPC_BIN,
    ledgerPath: path.join(directory, "vm-no-owned.txt"),
  });

  const evidence: ScenarioAEvidence = {
    scenario: "A1-refusal",
    gate: GATE_LABEL,
    mode: "real-run",
    runId,
    harness: "hermes",
    start,
    delivered: scenarioGitIdentity(repoRoot),
    profileHome: profile.hermesHome,
    profileStore: profile.storePath,
    profileStoreHeader: profile.header,
    profileStoreSidecars: profile.sidecars,
    receiptPaths: [receiptPath],
    qualificationRecordPath: resolveQualificationRecordPath(receiptPath),
    image: {
      tag: image.tag,
      digest: image.digest,
      configDigest: image.configDigest,
    },
    matchlock: {
      path: MATCHLOCK_RPC_BIN,
      sha256: sha256File(MATCHLOCK_RPC_BIN),
      version: readMatchlockVersion(),
    },
    guestInit:
      GUEST_INIT.length > 0
        ? { path: GUEST_INIT, sha256: sha256File(GUEST_INIT) }
        : { path: "unset => resolved by matchlock", sha256: "unset => resolved by matchlock" },
    tamandua: { distRoot: path.join(repoRoot, "dist"), distVersionStamp: distVersionStamp() },
    findingCodes,
    observedVmIds: [],
    vmInventory: { dbPresent: inventory.dbPresent, rows: inventory.rows, dirIds: inventory.dirIds },
    operatorHomeGate: {
      operatorHome: OPERATOR_HOME || "(unset)",
      checkedPaths: [profile.home, profile.hermesHome, repoDir],
      disposable: true,
    },
    commands,
    notes,
  };
  return writeScenarioAEvidence(directory, evidence);
}

type ScenarioAResult =
  | {
      blocked: false;
      evidencePath: string;
      launchReceiptPath: string;
      qualificationRecordPath: string;
      observedVmIds: string[];
    }
  | { blocked: true; evidencePath: string; signature: string };

/** A2: the converted (rollback) store must be admitted and boot a real VM. */
async function runScenarioA2Allow(evidenceRoot: string): Promise<ScenarioAResult> {
  const directory = prepareScenarioDirectory(evidenceRoot, "A2-allow");
  const profile = createScenarioProfile(directory, "rollback");
  assertDisposableProfilePath(profile.hermesHome, OPERATOR_HOME);
  const repoDir = prepareScenarioRepo(path.join(directory, "repo"));
  const operatorBefore = operatorHomeSignature(OPERATOR_HOME);
  const commands: string[] = [];
  const notes: string[] = [
    "A2 admits a CONVERTED store: config.yaml requests journal_mode=delete and state.db has a rollback-format header.",
    "The launch receipt is written by the hermes runner AFTER the VM exists (action: launched); nothing is written before.",
    "The qualification record binds the decision to the EXECUTED dist stamp, the matchlock/guest-init hashes and the SELECTED image digest.",
    "TAMANDUA_HARNESS_PROBE=0: the synthetic fixture's fake hermes writes its session row under WAL, so a second gate evaluation would (correctly) refuse it; do-now is ONE work round and this scenario qualifies the admitted round.",
    "The operator home is only ever referenced: no entry in it was created, removed or renamed and its config was unchanged (the live home's own directory-mtime churn is recorded, never treated as gate evidence).",
  ];
  const start = scenarioGitIdentity(repoRoot);
  const tamanduaDir = path.join(profile.home, ".tamandua");
  let image = { digest: "unreadable", configDigest: "unreadable" };
  let failure: unknown = null;
  const observed: string[] = [];
  let runId = "";

  const handles = await reservePortHandles(1);
  const controlPort = handles[0].port;
  const env = scenarioEnv(profile.home, controlPort, { TAMANDUA_HARNESS_PROBE: "0" });
  await releasePortReservations({ portHandles: handles });

  try {
    commands.push(`matchlock image resolve ${FIXTURE_IMAGE_TAG}   # private HOME=${profile.home}`);
    image = await provisionScenarioFixtureImage(profile.home, evidenceRoot);
    await withScenarioDaemon(profile, controlPort, env, async () => {
      commands.push(`tamandua workflow install do-now   # HOME=${profile.home}`);
      cliMustSucceed(["workflow", "install", "do-now"], env, "scenario A2: install do-now");
      const runArgs = [
        "workflow", "run", "do-now",
        "G8 scenario A2: a converted (rollback) store must be admitted and boot a real VM.",
        "--hermes-as-harness",
        "--working-directory-for-harness", repoDir,
        "--matchlock-image", FIXTURE_IMAGE_TAG,
      ];
      commands.push(`tamandua ${runArgs.join(" ")}`);
      const prefix = await spawnWorkflowRun(runArgs, env, 120_000);
      runId = resolveFullRunId(prefix, tamanduaDir);
      // The run's policy is FROZEN at submission: prove it targets the
      // disposable profile before allowing the round to reach the gate.
      assertPersistedPolicyIsDisposable(tamanduaDir, runId, profile);
      commands.push(`tamandua workflow status ${runId}`);
      const status = await pollScenarioTerminal(runId, env, tamanduaDir, 15 * 60_000);
      assert.equal(status, "completed", `scenario A2: the admitted run must complete (got ${status})`);
    });

    // ── the launch receipt (action: launched) and its qualification record ──
    const gateDir = path.join(tamanduaDir, "matchlock", "gate");
    const receiptFiles = fs.existsSync(gateDir)
      ? fs
          .readdirSync(gateDir)
          .filter((name) => name.endsWith(".json"))
          .filter((name) => !name.endsWith(".qualification.json") && !name.endsWith(".admission.json"))
          .sort()
      : [];
    const launchReceipts: Array<{ path: string; receipt: ReturnType<typeof parseReceipt> }> = [];
    let refusalReceipts = 0;
    for (const name of receiptFiles) {
      const candidate = path.join(gateDir, name);
      const parsed = readReceipt(candidate);
      if (parsed.action === "launched") launchReceipts.push({ path: candidate, receipt: parsed });
      if (parsed.action === "refused") refusalReceipts += 1;
    }
    assert.equal(refusalReceipts, 0, "scenario A2: an admitted run writes NO refusal receipt");
    assert.ok(launchReceipts.length >= 1, `scenario A2: no launch receipt under ${gateDir}`);
    for (const launch of launchReceipts) {
      assert.equal(launch.receipt.verdict, "allow");
      assert.deepEqual(launch.receipt.findings, []);
      assert.equal(
        launch.receipt.invocation.kind,
        "scheduled-attempt",
        "the launch receipt belongs to the ATTEMPT evaluation that authorised the create",
      );
    }
    const launch = launchReceipts[0];
    const qualificationPath = resolveQualificationRecordPath(launch.path);
    assert.ok(
      fs.existsSync(qualificationPath),
      `scenario A2: qualification record missing at ${qualificationPath}`,
    );
    const qualification = readQualificationRecord(qualificationPath);
    assert.ok(qualification, "scenario A2: the qualification record must parse");
    assert.equal(qualification.recordKind, GATE_QUALIFICATION_RECORD_KIND);
    assert.equal(qualification.receipt.path, launch.path);
    assert.equal(qualification.receipt.verdict, "allow");
    assert.equal(qualification.image.digest, image.digest, "the SELECTED image digest is bound");
    assert.equal(
      qualification.tamandua.distVersionStamp,
      distVersionStamp(),
      "the executed dist stamp is bound",
    );
    assert.equal(
      qualification.candidate.distRoot,
      path.join(repoRoot, "dist"),
      "the executed dist is measured",
    );

    // ── a real VM was created and positively closed ──────────────────────────
    const vmIds = readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), runId);
    assert.ok(
      vmIds.length >= 1,
      `scenario A2: no VM evidence under ${path.join(tamanduaDir, "runs", runId, "matchlock")}`,
    );
    observed.push(...vmIds);
    assertNoOwnedVms(profile.home, "scenario A2", {
      rpcBin: MATCHLOCK_RPC_BIN,
      ledgerPath: path.join(directory, "vm-no-owned.txt"),
      pollTimeoutMs: 120_000,
    });
    assert.ok(
      fs.existsSync(profile.storePath),
      "scenario A2: the mounted profile store must still exist after the round",
    );
    assertOperatorHomeUntouched(operatorBefore, "scenario A2");

    const inventory = readVmInventory(profile.home);
    const evidence: ScenarioAEvidence = {
      scenario: "A2-allow",
      gate: GATE_LABEL,
      mode: "real-run",
      runId,
      harness: "hermes",
      start,
      delivered: scenarioGitIdentity(repoRoot),
      profileHome: profile.hermesHome,
      profileStore: profile.storePath,
      profileStoreHeader: profile.header,
      profileStoreSidecars: profile.sidecars,
      receiptPaths: launchReceipts.map((entry) => entry.path),
      qualificationRecordPath: qualificationPath,
      image: { tag: FIXTURE_IMAGE_TAG, digest: image.digest, configDigest: image.configDigest },
      matchlock: {
        path: MATCHLOCK_RPC_BIN,
        sha256: sha256File(MATCHLOCK_RPC_BIN),
        version: readMatchlockVersion(),
      },
      guestInit:
        GUEST_INIT.length > 0
          ? { path: GUEST_INIT, sha256: sha256File(GUEST_INIT) }
          : { path: "unset => resolved by matchlock", sha256: "unset => resolved by matchlock" },
      tamandua: { distRoot: path.join(repoRoot, "dist"), distVersionStamp: distVersionStamp() },
      findingCodes: [],
      observedVmIds: [...new Set(vmIds)],
      vmInventory: { dbPresent: inventory.dbPresent, rows: inventory.rows, dirIds: inventory.dirIds },
      operatorHomeGate: {
        operatorHome: OPERATOR_HOME || "(unset)",
        checkedPaths: [profile.home, profile.hermesHome, repoDir],
        disposable: true,
      },
      commands,
      notes,
    };
    const evidencePath = writeScenarioAEvidence(directory, evidence);
    return {
      blocked: false,
      evidencePath,
      launchReceiptPath: launch.path,
      qualificationRecordPath: qualificationPath,
      observedVmIds: evidence.observedVmIds,
    };
  } catch (error) {
    failure = error;
  }

  // ── exact-owned cleanup + positive closure, ALWAYS (never swallowed) ────
  // A cleanup failure is captured, NOT thrown yet: the environment signature and
  // the evidence record must be written first, and a RETAINED VM makes the
  // outcome a hard failure (never an erase-to-look-clean, never a skip).
  let cleanupFailure: unknown = null;
  try {
    cleanupOwnedVms(profile.home, path.join(directory, "vm-cleanup-ledger.txt"), observed, {
      rpcBin: MATCHLOCK_RPC_BIN,
    });
  } catch (error) {
    cleanupFailure = error;
  }
  try {
    assertNoOwnedVms(profile.home, "scenario A2 (post-failure)", {
      rpcBin: MATCHLOCK_RPC_BIN,
      ledgerPath: path.join(directory, "vm-no-owned.txt"),
      pollTimeoutMs: 120_000,
    });
  } catch (error) {
    if (cleanupFailure === null) cleanupFailure = error;
  }

  const finalInventory = readVmInventory(profile.home);
  const retainedVmIds = [
    ...new Set([...finalInventory.rows.map((row) => row.id), ...finalInventory.dirIds]),
  ].sort();
  const primaryMessage = failure instanceof Error ? failure.message : String(failure);
  const cleanupMessage =
    cleanupFailure === null
      ? ""
      : cleanupFailure instanceof Error
        ? cleanupFailure.message
        : String(cleanupFailure);

  const signature = findSandboxVmBlockSignature([
    path.join(tamanduaDir, "tamandua.log"),
    ...(runId !== "" ? [path.join(tamanduaDir, "events", `${runId}.jsonl`)] : []),
    path.join(profile.home, "daemon-close-observed.json"),
    cleanupMessage,
  ]);
  if (signature !== null) {
    // ENVIRONMENT, never a product failure and never a pass: zero in-VM rounds
    // were observed, so the observed-rounds assertion refuses a green run.
    fs.writeFileSync(
      path.join(directory, "environment-blocked.json"),
      `${JSON.stringify(
        {
          class: "ENVIRONMENT",
          blocked: "real VM boot/teardown is not permitted in this execution environment",
          signature,
          processSignature: sandboxSelfSignature(),
          message: primaryMessage.slice(0, 4000),
          cleanupFailure: cleanupMessage === "" ? null : cleanupMessage.slice(0, 2000),
          retainedVmIds,
          recordedAt: new Date().toISOString(),
          note: "NOT a product failure and NOT a qualification pass: zero in-VM rounds were observed, so the observed-rounds guard refuses PASS (exit 92).",
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    const blockedEvidence: ScenarioAEvidence = {
      scenario: "A2-allow",
      gate: GATE_LABEL,
      mode: "real-run",
      runId,
      harness: "hermes",
      start,
      delivered: scenarioGitIdentity(repoRoot),
      profileHome: profile.hermesHome,
      profileStore: profile.storePath,
      profileStoreHeader: profile.header,
      profileStoreSidecars: profile.sidecars,
      receiptPaths: [],
      qualificationRecordPath: "",
      image: { tag: FIXTURE_IMAGE_TAG, digest: image.digest, configDigest: image.configDigest },
      matchlock: {
        path: MATCHLOCK_RPC_BIN,
        sha256: sha256File(MATCHLOCK_RPC_BIN),
        version: readMatchlockVersion(),
      },
      guestInit:
        GUEST_INIT.length > 0
          ? { path: GUEST_INIT, sha256: sha256File(GUEST_INIT) }
          : { path: "unset => resolved by matchlock", sha256: "unset => resolved by matchlock" },
      tamandua: { distRoot: path.join(repoRoot, "dist"), distVersionStamp: distVersionStamp() },
      findingCodes: [],
      observedVmIds: retainedVmIds,
      vmInventory: {
        dbPresent: finalInventory.dbPresent,
        rows: finalInventory.rows,
        dirIds: finalInventory.dirIds,
      },
      operatorHomeGate: {
        operatorHome: OPERATOR_HOME || "(unset)",
        checkedPaths: [profile.home, profile.hermesHome, repoDir],
        disposable: true,
      },
      commands,
      notes: [
        ...notes,
        `ENVIRONMENT: ${signature}`,
        ...(cleanupMessage === ""
          ? []
          : [`CLEANUP FAILURE (state retained): ${cleanupMessage.slice(0, 600)}`]),
      ],
    };
    const evidencePath = writeScenarioAEvidence(directory, blockedEvidence);
    if (cleanupFailure !== null) {
      // A retained owned VM is a hard failure for the OPERATOR, even when the
      // environment explains why: the gate must never certify a dirty host.
      throw new Error(
        `scenario A2 could not qualify AND ${retainedVmIds.length} owned VM(s) remain ` +
          `(${retainedVmIds.join(",") || "none"}); state RETAINED at ${profile.home}/.matchlock ` +
          `for privileged disposal. primary=${primaryMessage}; cleanup=${cleanupMessage}; ` +
          `ENVIRONMENT: ${signature}`,
      );
    }
    return { blocked: true, evidencePath, signature };
  }
  if (cleanupFailure !== null) {
    throw new Error(
      `scenario A2: exact-owned cleanup failed (${cleanupMessage}); state RETAINED at ${profile.home}/.matchlock. primary=${primaryMessage}`,
    );
  }
  throw failure instanceof Error ? failure : new Error(primaryMessage);
}

type ScenarioCResult =
  | { blocked: false; evidencePath: string; observedVmIds: string[] }
  | { blocked: true; evidencePath: string; signature: string };

/** Read back the run's FROZEN Matchlock policy (never a rebuilt one). */
function readPersistedPolicy(tamanduaDir: string, runId: string): any {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const row = db.prepare("SELECT matchlock_policy FROM runs WHERE id = ?").get(runId) as
      | { matchlock_policy: string | null }
      | undefined;
    assert.ok(row, `scenario C: no persisted run row for ${runId}`);
    assert.ok(row?.matchlock_policy, `scenario C: run ${runId} carries no persisted Matchlock policy`);
    return JSON.parse(String(row?.matchlock_policy));
  } finally {
    db.close();
  }
}

/**
 * Wait (bounded) until the runner recorded a VM for this run. That instant is
 * when the guest starts writing the mapped store, so a native writer started
 * here overlaps the guest round BY CONSTRUCTION rather than by luck.
 */
async function waitForRunnerVmEvidence(
  tamanduaDir: string,
  runId: string,
  timeoutMs: number,
): Promise<string[]> {
  const startedAt = Date.now();
  const runsRoot = path.join(tamanduaDir, "runs");
  let lastCount = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const ids = readRunnerVmEvidenceIds(runsRoot, runId);
    lastCount = ids.length;
    if (ids.length > 0) return ids;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `scenario C1: no VM evidence appeared under ${path.join(runsRoot, runId)} within ${timeoutMs}ms (last count ${lastCount})`,
  );
}

/**
 * Record a VM-boot/teardown block as ENVIRONMENT (never a product failure and
 * never a pass) and return the evidence path. A RETAINED owned VM stays a HARD
 * failure: the caller throws after this record is written.
 */
function writeScenarioCEnvironmentBlock(options: {
  directory: string;
  scenario: ScenarioCName;
  profile: ScenarioProfile;
  runId: string;
  signature: string;
  message: string;
  cleanupMessage: string;
  retainedVmIds: string[];
  commands: string[];
  notes: string[];
  start: { commit: string; tree: string };
  image: { tag: string; digest: string; configDigest: string };
}): string {
  const inventory = readVmInventory(options.profile.home);
  fs.writeFileSync(
    path.join(options.directory, "environment-blocked.json"),
    `${JSON.stringify(
      {
        class: "ENVIRONMENT",
        blocked: "real VM boot/teardown is not permitted in this execution environment",
        signature: options.signature,
        processSignature: sandboxSelfSignature(),
        message: options.message.slice(0, 4000),
        cleanupFailure: options.cleanupMessage === "" ? null : options.cleanupMessage.slice(0, 2000),
        retainedVmIds: options.retainedVmIds,
        recordedAt: new Date().toISOString(),
        note: "NOT a product failure and NOT a qualification pass: zero in-VM rounds were observed, so the observed-rounds guard refuses PASS (exit 92).",
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
  const evidence: ScenarioCEvidence = {
    scenario: options.scenario,
    gate: GATE_LABEL,
    mode: "real-run",
    runId: options.runId,
    harness: "hermes",
    start: options.start,
    delivered: scenarioGitIdentity(repoRoot),
    profileHome: options.profile.hermesHome,
    profileStore: options.profile.storePath,
    profileStoreHeader: options.profile.header,
    profileStoreSidecars: options.profile.sidecars,
    receiptPaths: [],
    qualificationRecordPath: "",
    image: options.image,
    matchlock: {
      path: MATCHLOCK_RPC_BIN,
      sha256: MATCHLOCK_RPC_BIN === "" ? "unreadable" : sha256File(MATCHLOCK_RPC_BIN),
      version: readMatchlockVersion(),
    },
    guestInit:
      GUEST_INIT.length > 0
        ? { path: GUEST_INIT, sha256: sha256File(GUEST_INIT) }
        : { path: "unset => resolved by matchlock", sha256: "unset => resolved by matchlock" },
    tamandua: { distRoot: path.join(repoRoot, "dist"), distVersionStamp: distVersionStamp() },
    mixedOverlap: null,
    journalTransition: null,
    operatorHomeGate: null,
    designAcceptance: [],
    noLease: NO_LEASE_LIMITATION,
    observedVmIds: options.retainedVmIds,
    commands: options.commands,
    notes: [
      ...options.notes,
      `ENVIRONMENT: ${options.signature}`,
      ...(options.cleanupMessage === ""
        ? []
        : [`CLEANUP FAILURE (state retained): ${options.cleanupMessage.slice(0, 600)}`]),
      `vm inventory rows: ${inventory.rows.length}, dirs: ${inventory.dirIds.length}`,
    ],
  };
  return writeScenarioCEvidence(options.directory, evidence);
}

/**
 * C1 (REAL RUN PATH): an admitted hermes round writes the mapped store from
 * inside the VM while a NATIVE host writer commits into the SAME store; after
 * both settle every committed native record is retained, the guest's own rows
 * are retained and `PRAGMA integrity_check` is ok.
 */
async function runScenarioC1MixedOverlap(evidenceRoot: string): Promise<ScenarioCResult> {
  const directory = prepareScenarioCDirectory(evidenceRoot, "C1-mixed-overlap");
  const profile = createScenarioProfile(directory, "rollback");
  assert.deepEqual(profile.header, [1, 1], "scenario C1: the admitted store must be rollback-format");
  assertDisposableProfilePath(profile.hermesHome, OPERATOR_HOME);
  const repoDir = prepareScenarioRepo(path.join(directory, "repo"));
  const operatorBefore = operatorHomeSignature(OPERATOR_HOME);
  let operatorAfter: OperatorHomeObservation | null = null;
  const commands: string[] = [];
  const notes: string[] = [
    "C1 drives the REAL run path: an isolated daemon admits a compliant disposable profile and the GUEST round writes the mapped store from inside the VM.",
    "While the guest runs, a NATIVE host writer commits single-row transactions into the SAME mapped store; its pid is recorded before its first commit and it is stopped by that recorded pid (never a pattern).",
    "The native writer is started at the instant the runner recorded its VM, so the two writer windows overlap by construction; the measured overlap is recorded.",
    "Neither unconditional admission during every transaction nor process-lifetime exclusivity is claimed: the design accepts the transient -journal refusal exercised by C2.",
    "The operator home is only ever referenced: no entry in it was created, removed or renamed and its config was unchanged (the live home's own directory-mtime churn is recorded, never treated as gate evidence).",
  ];
  const start = scenarioGitIdentity(repoRoot);
  const tamanduaDir = path.join(profile.home, ".tamandua");

  const handles = await reservePortHandles(1);
  const controlPort = handles[0].port;
  const env = scenarioEnv(profile.home, controlPort, { TAMANDUA_HARNESS_PROBE: "0" });
  await releasePortReservations({ portHandles: handles });

  let image = { tag: FIXTURE_IMAGE_TAG, digest: "unreadable", configDigest: "unreadable" };
  let runId = "";
  let writerHandle: NativeWriterHandle | null = null;
  let writerStop: { exitCode: number | null; signal: string | null; stoppedBy: string; stoppedAt: string } | null =
    null;
  const guestWindow = { vmFirstObservedAt: "", terminalAt: "" };
  const observed: string[] = [];
  let failure: unknown = null;

  try {
    commands.push(`matchlock image resolve ${FIXTURE_IMAGE_TAG}   # private HOME=${profile.home}`);
    image = { tag: FIXTURE_IMAGE_TAG, ...(await provisionScenarioFixtureImage(profile.home, evidenceRoot)) };
    await withScenarioDaemon(profile, controlPort, env, async () => {
      commands.push(`tamandua workflow install do-now   # HOME=${profile.home}`);
      cliMustSucceed(["workflow", "install", "do-now"], env, "scenario C1: install do-now");
      const runArgs = [
        "workflow",
        "run",
        "do-now",
        "G8 scenario C1: overlapping native and guest writers on one admitted store.",
        "--hermes-as-harness",
        "--working-directory-for-harness",
        repoDir,
        "--matchlock-image",
        FIXTURE_IMAGE_TAG,
      ];
      commands.push(`tamandua ${runArgs.join(" ")}`);
      const prefix = await spawnWorkflowRun(runArgs, env, 120_000);
      runId = resolveFullRunId(prefix, tamanduaDir);
      assertPersistedPolicyIsDisposable(tamanduaDir, runId, profile);
      try {
        const vmIds = await waitForRunnerVmEvidence(tamanduaDir, runId, 10 * 60_000);
        observed.push(...vmIds);
        guestWindow.vmFirstObservedAt = new Date().toISOString();
        writerHandle = startNativeWriter({
          label: "native-host",
          dbPath: profile.storePath,
          directory,
          rows: 400,
          intervalMs: 250,
          durationMs: 10 * 60_000,
        });
        commands.push(
          `node e2e-tests/helpers/store-native-writer.mjs --db ${profile.storePath} --writer native-host --rows 400 --interval-ms 250`,
        );
        commands.push(`tamandua workflow status ${runId}`);
        const status = await pollScenarioTerminal(runId, env, tamanduaDir, 20 * 60_000);
        guestWindow.terminalAt = new Date().toISOString();
        assert.equal(status, "completed", `scenario C1: the admitted run must complete (got ${status})`);
      } finally {
        if (writerHandle !== null && writerStop === null) {
          const stop = await stopNativeWriterByPid(writerHandle, "the guest round settled");
          writerStop = { ...stop, stoppedAt: new Date().toISOString() };
        }
      }
    });

    const handle = writerHandle as NativeWriterHandle | null;
    assert.ok(handle !== null, "scenario C1: the native writer must have been started");
    assert.ok(writerStop !== null, "scenario C1: the native writer must have been stopped by its recorded pid");
    const nativeLedger = readWriterLedger(handle.ledgerPath);
    assert.ok(
      nativeLedger.commits.length > 0,
      `scenario C1: the native writer must commit at least one record while the guest runs (ledger: ${JSON.stringify(
        readWriterLedger(handle.ledgerPath).summary,
      )})`,
    );

    const check = inspectMixedStore(profile.storePath, [nativeLedger], { expectSessions: true });
    assert.equal(check.integrityCheck, "ok", "scenario C1: PRAGMA integrity_check must return ok");
    assert.deepEqual(check.missing, [], "scenario C1: every COMMITTED native record must be retained");
    assert.ok(
      check.sessionsRows >= 1,
      "scenario C1: the GUEST's sessions row must be retained in the same store",
    );

    const stop = writerStop as { exitCode: number | null; signal: string | null; stoppedBy: string; stoppedAt: string };
    const overlapMs = windowOverlapMs(
      { start: handle.startedAt, end: stop.stoppedAt },
      { start: guestWindow.vmFirstObservedAt, end: guestWindow.terminalAt },
    );
    assert.ok(
      overlapMs > 0,
      `scenario C1: the native writer and the guest round must overlap (got ${overlapMs}ms; native ${handle.startedAt}..${stop.stoppedAt}, guest ${guestWindow.vmFirstObservedAt}..${guestWindow.terminalAt})`,
    );

    assertNoOwnedVms(profile.home, "scenario C1", {
      rpcBin: MATCHLOCK_RPC_BIN,
      ledgerPath: path.join(directory, "vm-no-owned.txt"),
      pollTimeoutMs: 120_000,
    });
    operatorAfter = assertOperatorHomeUntouched(operatorBefore, "scenario C1");

    const inventory = readVmInventory(profile.home);
    const summary = nativeWriterSummary(
      handle,
      nativeLedger,
      { exitCode: stop.exitCode, signal: stop.signal, stoppedBy: stop.stoppedBy },
      stop.stoppedAt,
    );
    const mixedOverlap: MixedOverlapEvidence = {
      writers: [summary],
      guestWriter: {
        kind: "synthetic-hermes-fixture",
        storePath: profile.storePath,
        guestStorePath: "/workspace/config/hermes/state.db",
        sessionsRows: check.sessionsRows,
        vmIds: [...new Set(observed)],
        window: guestWindow,
      },
      window: { startedAt: handle.startedAt, stoppedAt: stop.stoppedAt },
      overlapMs,
      expectedRecords: nativeLedger.commits.length,
      retainedRecords: check.retained.length,
      missingRecords: check.missing,
      integrityCheck: check.integrityCheck,
      journalModeAtEnd: check.journalMode,
      headerAtEnd: check.header,
    };
    const evidence: ScenarioCEvidence = {
      scenario: "C1-mixed-overlap",
      gate: GATE_LABEL,
      mode: "real-run",
      runId,
      harness: "hermes",
      start,
      delivered: scenarioGitIdentity(repoRoot),
      profileHome: profile.hermesHome,
      profileStore: profile.storePath,
      profileStoreHeader: profile.header,
      profileStoreSidecars: profile.sidecars,
      receiptPaths: [],
      qualificationRecordPath: "",
      image,
      matchlock: {
        path: MATCHLOCK_RPC_BIN,
        sha256: MATCHLOCK_RPC_BIN === "" ? "unreadable" : sha256File(MATCHLOCK_RPC_BIN),
        version: readMatchlockVersion(),
      },
      guestInit:
        GUEST_INIT.length > 0
          ? { path: GUEST_INIT, sha256: sha256File(GUEST_INIT) }
          : { path: "unset => resolved by matchlock", sha256: "unset => resolved by matchlock" },
      tamandua: { distRoot: path.join(repoRoot, "dist"), distVersionStamp: distVersionStamp() },
      mixedOverlap,
      journalTransition: null,
      operatorHomeGate:
        operatorAfter === null ? null : operatorHomeGateRecord(operatorBefore, operatorAfter),
      designAcceptance: [C1_DESIGN_ACCEPTANCE],
      noLease: NO_LEASE_LIMITATION,
      observedVmIds: [...new Set(observed)],
      commands,
      notes: [...notes, ...scenarioCOutcomeSummary({ mixedOverlap, journalTransition: null })],
    };
    const evidencePath = writeScenarioCEvidence(directory, evidence);
    return { blocked: false, evidencePath, observedVmIds: evidence.observedVmIds };
  } catch (error) {
    failure = error;
  }

  // ── exact-owned cleanup + positive closure, ALWAYS (never swallowed) ─────
  let cleanupFailure: unknown = null;
  try {
    cleanupOwnedVms(profile.home, path.join(directory, "vm-cleanup-ledger.txt"), observed, {
      rpcBin: MATCHLOCK_RPC_BIN,
    });
  } catch (error) {
    cleanupFailure = error;
  }
  try {
    assertNoOwnedVms(profile.home, "scenario C1 (post-failure)", {
      rpcBin: MATCHLOCK_RPC_BIN,
      ledgerPath: path.join(directory, "vm-no-owned.txt"),
      pollTimeoutMs: 120_000,
    });
  } catch (error) {
    if (cleanupFailure === null) cleanupFailure = error;
  }

  const finalInventory = readVmInventory(profile.home);
  const retainedVmIds = [
    ...new Set([...finalInventory.rows.map((row) => row.id), ...finalInventory.dirIds]),
  ].sort();
  const primaryMessage = failure instanceof Error ? failure.message : String(failure);
  const cleanupMessage =
    cleanupFailure === null
      ? ""
      : cleanupFailure instanceof Error
        ? cleanupFailure.message
        : String(cleanupFailure);
  const signature = findSandboxVmBlockSignature([
    path.join(tamanduaDir, "tamandua.log"),
    ...(runId !== "" ? [path.join(tamanduaDir, "events", `${runId}.jsonl`)] : []),
    path.join(profile.home, "daemon-close-observed.json"),
    cleanupMessage,
  ]);
  if (signature !== null) {
    const evidencePath = writeScenarioCEnvironmentBlock({
      directory,
      scenario: "C1-mixed-overlap",
      profile,
      runId,
      signature,
      message: primaryMessage,
      cleanupMessage,
      retainedVmIds,
      commands,
      notes,
      start,
      image,
    });
    if (cleanupFailure !== null) {
      throw new Error(
        `scenario C1 could not qualify AND ${retainedVmIds.length} owned VM(s) remain ` +
          `(${retainedVmIds.join(",") || "none"}); state RETAINED at ${profile.home}/.matchlock ` +
          `for privileged disposal. primary=${primaryMessage}; cleanup=${cleanupMessage}; ENVIRONMENT: ${signature}`,
      );
    }
    return { blocked: true, evidencePath, signature };
  }
  if (cleanupFailure !== null) {
    throw new Error(
      `scenario C1: exact-owned cleanup failed (${cleanupMessage}); state RETAINED at ${profile.home}/.matchlock. primary=${primaryMessage}`,
    );
  }
  throw failure instanceof Error ? failure : new Error(primaryMessage);
}

/**
 * C2 (REAL RUN PATH): a NONEMPTY rollback journal beside a compliant store
 * refuses through the real run path with `sidecar-unresolved`, and the SAME
 * run's next observation (over the frozen persisted policy) allows once the
 * journal is removed after quiescence. No VM is created on either leg.
 */
async function runScenarioC2JournalTransition(evidenceRoot: string): Promise<ScenarioCResult> {
  const directory = prepareScenarioCDirectory(evidenceRoot, "C2-journal-transition");
  const profile = createScenarioProfile(directory, "rollback");
  assert.deepEqual(profile.header, [1, 1], "scenario C2: the store itself must be rollback-format");
  assertDisposableProfilePath(profile.hermesHome, OPERATOR_HOME);
  const repoDir = prepareScenarioRepo(path.join(directory, "repo"));
  const operatorBefore = operatorHomeSignature(OPERATOR_HOME);
  const journalPath = `${profile.storePath}-journal`;
  const configSource = path.join(profile.hermesHome, "config.yaml");
  const journalSize = writeNonEmptyRollbackJournal(journalPath);
  const commands: string[] = [];
  const notes: string[] = [
    "C2 refuses a COMPLIANT store only because a NONEMPTY rollback journal sits beside it: the finding is sidecar-unresolved, never a header or config code.",
    "The refusal is evaluated at scheduled DISPATCH through the real isolated daemon, so it precedes the launch probe and every VM create.",
    "The operator remedy is the ROLLBACK-journal remedy (quiescence, then the supported conversion) and never a checkpoint: a -journal is not a write-ahead-log.",
    "After the run is terminal, no VM exists and no writer process was ever started, so the store is quiescent; the journal is then removed and the SAME run's policy re-evaluated.",
    "The next observation ALLOWS over the FROZEN persisted policy: the refusal was transient. Process-lifetime exclusivity is never claimed.",
    "The operator home is only ever referenced: no entry in it was created, removed or renamed and its config was unchanged (the live home's own directory-mtime churn is recorded, never treated as gate evidence).",
  ];
  const start = scenarioGitIdentity(repoRoot);
  const tamanduaDir = path.join(profile.home, ".tamandua");

  const handles = await reservePortHandles(1);
  const controlPort = handles[0].port;
  const env = scenarioEnv(profile.home, controlPort);
  await releasePortReservations({ portHandles: handles });

  let image = { tag: FIXTURE_IMAGE_TAG, digest: "unreadable", configDigest: "unreadable" };
  let runId = "";

  commands.push(`matchlock image resolve ${FIXTURE_IMAGE_TAG}   # private HOME=${profile.home}`);
  image = await provisionAdmissionProbeImage(profile.home, evidenceRoot);
  await withScenarioDaemon(profile, controlPort, env, async () => {
    commands.push(`tamandua workflow install do-now   # HOME=${profile.home}`);
    cliMustSucceed(["workflow", "install", "do-now"], env, "scenario C2: install do-now");
    const runArgs = [
      "workflow",
      "run",
      "do-now",
      "G8 scenario C2: a nonempty rollback journal must refuse before any VM.",
      "--hermes-as-harness",
      "--working-directory-for-harness",
      repoDir,
      "--matchlock-image",
      image.tag,
    ];
    commands.push(`tamandua ${runArgs.join(" ")}`);
    const prefix = await spawnWorkflowRun(runArgs, env, 120_000);
    runId = resolveFullRunId(prefix, tamanduaDir);
    assertPersistedPolicyIsDisposable(tamanduaDir, runId, profile);
    commands.push(`tamandua workflow status ${runId}`);
    const status = await pollScenarioTerminal(runId, env, tamanduaDir, 10 * 60_000);
    assert.equal(status, "failed", `scenario C2: a refused run must be terminal failed (got ${status})`);
  });

  const events = readRunEvents(tamanduaDir, runId);
  const refusals = events.filter((event) => event.event === "run.matchlock_gate_refused");
  assert.equal(refusals.length, 1, `scenario C2: exactly ONE refusal event (got ${refusals.length})`);
  const refusalEvent = refusals[0] as Record<string, unknown>;
  assert.equal(refusalEvent.harness, "hermes");
  assert.equal(refusalEvent.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
  const findingCodes = (refusalEvent.findingCodes as string[] | undefined) ?? [];
  assert.ok(
    findingCodes.includes("sidecar-unresolved"),
    `scenario C2: expected sidecar-unresolved, got ${findingCodes.join(",")}`,
  );
  const receiptPath = String(refusalEvent.receiptPath ?? "");
  assert.ok(receiptPath !== "", "scenario C2: the event must name the refusal receipt");
  assert.ok(fs.existsSync(receiptPath), `scenario C2: refusal receipt missing at ${receiptPath}`);

  const receipt = readReceipt(receiptPath);
  assert.ok(sameRunId(receipt.invocation.runId, runId), "scenario C2: the receipt names THIS run");
  const refusalFromReceipt = {
    // The operational class never carries a reason code, so a receipt with
    // findings is a VERDICT refusal by construction.
    kind: receipt.findings.length > 0 ? "verdict" : "operational",
    exitCode: Number(refusalEvent.exitCode),
    receiptWritten: true,
    receiptPath,
    findings: receipt.findings.map((finding) => ({
      code: String(finding.code),
      store: finding.store ?? null,
      remedy: finding.remedy.map((step) => ({ description: String(step.description) })),
    })),
  };
  const refusal = assertSidecarUnresolvedRefusal({
    refusal: refusalFromReceipt,
    storePath: profile.storePath,
    journalPath,
    journalSize,
    configSource,
    label: "scenario C2 (real run path)",
  });

  // ZERO create surface on the refusal leg.
  const inventory = readVmInventory(profile.home);
  assert.deepEqual(inventory.rows, [], "scenario C2: zero owned VM rows");
  assert.deepEqual(inventory.dirIds, [], "scenario C2: zero owned VM state dirs");
  assert.deepEqual(
    readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), runId),
    [],
    "scenario C2: the hermes runner never ran",
  );
  const operatorAfter = assertOperatorHomeUntouched(operatorBefore, "scenario C2");

  // ── quiescence, then removal ─────────────────────────────────────────────
  // The refused run is TERMINAL, no VM exists and this scenario never started a
  // writer, so nothing can be mid-transaction: recorded, not assumed.
  const liveWriterPids: number[] = [];
  const identityBefore = fs.statSync(profile.storePath);
  fs.unlinkSync(journalPath);
  const identityAfter = fs.statSync(profile.storePath);
  const storeIdentityUnchanged =
    identityAfter.ino === identityBefore.ino && identityAfter.size === identityBefore.size;
  assert.equal(storeIdentityUnchanged, true, "scenario C2: the store is unchanged across the removal");

  // The SAME run's next observation, over the FROZEN persisted policy.
  const policy = readPersistedPolicy(tamanduaDir, runId);
  const allowed = evaluateScheduledAttemptGate(scenarioRound(policy, runId), {
    stateDir: tamanduaDir,
    configOptions: { managedDir: null },
  } as never);
  assert.ok(allowed && allowed.action === "allow", "scenario C2: the store must allow once the journal is gone");
  if (!allowed || allowed.action !== "allow") {
    throw new Error("scenario C2: the post-quiescence observation did not allow the launch");
  }
  assert.equal(allowed.binding.configJournalMode, "delete");

  const journalTransition: JournalTransitionEvidence = {
    storePath: profile.storePath,
    journalPath,
    journalSize,
    refusal: {
      invocationId: String(receipt.invocation.kind ?? "scheduled-dispatch"),
      receiptPath: refusal.receiptPath,
      findingCodes: refusal.findingCodes,
      findingRemedy: refusal.findingRemedy,
      remedyText: refusal.remedyText,
      renderedCodes: refusal.renderedCodes,
    },
    quiescence: {
      liveWriterPids,
      storeIdentityUnchanged,
      journalNeverDeletedByGate: true,
      removedAt: new Date().toISOString(),
    },
    allow: {
      invocationId: allowed.binding.invocationId,
      configJournalMode: allowed.binding.configJournalMode,
      storeSetKey: allowed.binding.storeSetKey,
    },
  };
  const evidence: ScenarioCEvidence = {
    scenario: "C2-journal-transition",
    gate: GATE_LABEL,
    mode: "real-run",
    runId,
    harness: "hermes",
    start,
    delivered: scenarioGitIdentity(repoRoot),
    profileHome: profile.hermesHome,
    profileStore: profile.storePath,
    profileStoreHeader: profile.header,
    profileStoreSidecars: profile.sidecars,
    receiptPaths: [refusal.receiptPath],
    qualificationRecordPath: "",
    image,
    matchlock: {
      path: MATCHLOCK_RPC_BIN,
      sha256: MATCHLOCK_RPC_BIN === "" ? "unreadable" : sha256File(MATCHLOCK_RPC_BIN),
      version: readMatchlockVersion(),
    },
    guestInit:
      GUEST_INIT.length > 0
        ? { path: GUEST_INIT, sha256: sha256File(GUEST_INIT) }
        : { path: "unset => resolved by matchlock", sha256: "unset => resolved by matchlock" },
    tamandua: { distRoot: path.join(repoRoot, "dist"), distVersionStamp: distVersionStamp() },
    mixedOverlap: null,
    journalTransition,
    operatorHomeGate: operatorHomeGateRecord(operatorBefore, operatorAfter),
    designAcceptance: [C2_DESIGN_ACCEPTANCE],
    noLease: NO_LEASE_LIMITATION,
    observedVmIds: [],
    commands: [...commands, `rm -f ${journalPath}   # after quiescence`],
    notes: [...notes, ...scenarioCOutcomeSummary({ mixedOverlap: null, journalTransition })],
  };
  const evidencePath = writeScenarioCEvidence(directory, evidence);
  return { blocked: false, evidencePath, observedVmIds: [] };
}

// ===========================================================================
// REAL-VM TIER — opt-in (skipped without the driver-provided environment)
// ===========================================================================
//
// The tier's surroundings are installed by the driver; the tests assert them so
// a half-set environment can never look like a qualification run. The SCENARIO
// A and C tests drive the REAL run path (isolated daemon -> scheduler ->
// Matchlock hermes runner) with disposable profiles:
//
//   A1-refusal  an unconverted (WAL) store -> zero VMs, ONE refusal event,
//               a terminal failed run and a written refusal receipt;
//   A2-allow    a converted (rollback) store -> a real VM, a `launched` receipt
//               and a qualification record binding the executed dist + image;
//   C1-mixed    an admitted store written by a NATIVE host writer and by the
//               GUEST round concurrently -> every committed record retained and
//               `PRAGMA integrity_check` ok;
//   C2-journal  a NONEMPTY `-journal` -> `sidecar-unresolved` with the
//               rollback-journal remedy and zero VMs, then an ALLOW over the
//               frozen policy once the journal is removed after quiescence.
//
// In a sandbox that cannot boot a VM (TUNSETIFF/nf_tables EPERM) A2 and C1
// record the ENVIRONMENT signature and skip; the observed-rounds assertion still
// refuses a green run, so a skipped A2/C1 can never be mistaken for a
// qualification. C2 needs no VM and is therefore never skipped.
const realVmDescribe = REAL_VM_GATE_ENABLED ? describe : describe.skip;

realVmDescribe("G8 admission qualification — REAL-VM TIER", () => {
  // The surroundings, resolved once for the tier.
  const evidenceDir = path.resolve(EVIDENCE_DIR);
  const privateHome = path.resolve(PRIVATE_HOME);
  const privateStateDir = path.resolve(PRIVATE_STATE_DIR);
  const privateTmpDir = path.resolve(PRIVATE_TMPDIR);
  const imageStore = IMAGE_STORE.length > 0
    ? path.resolve(IMAGE_STORE)
    : path.join(privateHome, ".cache", "matchlock");

  after(() => {
    const ledgerPath = path.join(evidenceDir, "owned-vm-ledger.txt");
    // Exact-owned disposal ONLY: recorded vm-<8hex> ids, never a pattern. A
    // failed/unknown `matchlock rm` throws and RETAINS the state dir and DB
    // rows for diagnostics (no erase-to-look-clean).
    cleanupOwnedVms(privateHome, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
    assertNoOwnedVms(privateHome, GATE_LABEL, { ledgerPath, rpcBin: MATCHLOCK_RPC_BIN });
  });

  it("runs under the shared gate lock with a private HOME/TMPDIR/state and a seeded image store", () => {
    assert.equal(
      process.env.MTLK_GATE_LOCK_HELD,
      "1",
      "the gate must run under the shared gate lock (run the driver, not this file directly)",
    );
    assert.ok(path.isAbsolute(evidenceDir), "the evidence dir must be absolute");
    assert.equal(
      evidenceDir === repoRoot || evidenceDir.startsWith(`${repoRoot}${path.sep}`),
      false,
      "the evidence dir must live OUTSIDE the worktree",
    );

    assert.ok(
      privateHome.startsWith(`${evidenceDir}${path.sep}`),
      `HOME must be a private dir under the evidence dir (got ${privateHome})`,
    );
    assert.ok(
      privateStateDir.startsWith(`${evidenceDir}${path.sep}`),
      `TAMANDUA_STATE_DIR must be private (got ${privateStateDir})`,
    );
    assert.ok(
      privateTmpDir.startsWith(`${evidenceDir}${path.sep}`),
      `TMPDIR must be private (got ${privateTmpDir})`,
    );

    if (OPERATOR_HOME.length > 0) {
      const operatorHome = path.resolve(OPERATOR_HOME);
      assert.notEqual(privateHome, operatorHome, "the operator home must never be the gate HOME");
      assert.equal(
        privateHome.startsWith(path.join(operatorHome, ".hermes")),
        false,
        "the gate must never run inside the operator home's .hermes",
      );
    }
    if (OPERATOR_CACHE.length > 0) {
      assert.notEqual(
        imageStore,
        path.resolve(OPERATOR_CACHE),
        "the private image store must never be the operator store",
      );
    }

    assert.ok(
      fs.existsSync(path.join(imageStore, "images", "metadata.db")),
      `the private image store must be seeded (missing ${path.join(imageStore, "images", "metadata.db")})`,
    );

    // The private HOME is fresh: no owned VM may exist before a scenario.
    const inventory = readVmInventory(privateHome);
    assert.deepEqual(inventory.rows, []);
    assert.deepEqual(inventory.dirIds, []);
  });

  it("records the observed runtime identity and artifact binding as evidence", () => {
    const version = spawnSync(MATCHLOCK_RPC_BIN, ["--version"], {
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...inheritedProcessEnv(), ...matchlockRuntimeEnv() },
    });
    assert.equal(version.status, 0, `matchlock --version must succeed: ${version.stderr ?? ""}`);

    const observed = fs.readFileSync(path.join(evidenceDir, "runtime-observed.txt"), "utf-8");
    const driverSha = /^matchlock\.sha256=([0-9a-f]{64})$/m.exec(observed)?.[1] ?? "";
    assert.match(driverSha, /^[0-9a-f]{64}$/, "the driver must have recorded the matchlock sha256");

    // The gate was handed the SAME artifact the driver observed.
    const gateSha = sha256File(MATCHLOCK_RPC_BIN);
    assert.equal(gateSha, driverSha, "driver and gate must observe the same matchlock artifact");

    const guestInitLine = /^guest_init\.sha256=(.*)$/m.exec(observed)?.[1] ?? "";
    let guestInitSha = "unset => resolved by matchlock";
    if (GUEST_INIT.length > 0) {
      guestInitSha = sha256File(GUEST_INIT);
      assert.equal(guestInitSha, guestInitLine, "driver and gate must observe the same guest-init artifact");
    }

    const record = [
      `gate=${GATE_LABEL}`,
      `matchlock.path=${MATCHLOCK_RPC_BIN}`,
      `matchlock.version=${(version.stdout ?? "").trim() || "no-version"}`,
      `matchlock.sha256=${gateSha}`,
      `guest_init.path=${GUEST_INIT || "unset => resolved by matchlock"}`,
      `guest_init.sha256=${guestInitSha}`,
      `guest_fused.path=${GUEST_FUSED || "unset => resolved by matchlock"}`,
      `tamandua.dist_root=${path.join(repoRoot, "dist")}`,
      `tamandua.dist_version=${distVersionStamp()}`,
      `evidence_dir=${evidenceDir}`,
      `private_home=${privateHome}`,
    ].join("\n");
    fs.writeFileSync(path.join(evidenceDir, "gate-runtime-observed.txt"), `${record}\n`);
  });

  // ── scenario A1: refusal before any VM through the REAL run path ────────
  it(
    "scenario A1: an unconverted (WAL) store is refused through the real run path with zero VMs",
    { timeout: 20 * 60_000 },
    async () => {
      const evidencePath = await runScenarioA1Refusal(evidenceDir);
      assert.ok(fs.existsSync(evidencePath), "scenario A1 evidence must be written");
      const parsed = JSON.parse(fs.readFileSync(evidencePath, "utf-8")) as ScenarioAEvidence;
      assert.equal(parsed.mode, "real-run");
      // Run ids are stored BARE (a `run-` prefix is accepted everywhere, but
      // the row/event spelling is the bare uuid).
      assert.match(parsed.runId, /^(run-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.deepEqual(parsed.observedVmIds, [], "A1 creates no VM");
      assert.ok(parsed.findingCodes.includes("wal-header"));
      assert.equal(parsed.receiptPaths.length, 1);
      assert.ok(fs.existsSync(parsed.receiptPaths[0]), "the refusal receipt is on disk");
    },
  );

  // ── scenario A2: admission, a real VM and the artifact binding ──────────
  it(
    "scenario A2: a converted store is admitted, boots and positively closes a real VM, and binds the executed artifacts",
    { timeout: 40 * 60_000 },
    async (t) => {
      const result = await runScenarioA2Allow(evidenceDir);
      if (result.blocked) {
        t.skip(`ENVIRONMENT: ${result.signature}`);
        return;
      }
      observedVmIds.push(...result.observedVmIds);
      const parsed = JSON.parse(fs.readFileSync(result.evidencePath, "utf-8")) as ScenarioAEvidence;
      assert.equal(parsed.mode, "real-run");
      assert.ok(parsed.observedVmIds.length >= 1, "at least one fresh VM must be observed");
      for (const id of parsed.observedVmIds) assert.match(id, /^vm-[0-9a-f]{8}$/);
      assert.ok(fs.existsSync(result.launchReceiptPath), "the launch receipt must exist");
      assert.ok(fs.existsSync(result.qualificationRecordPath), "the qualification record must exist");
    },
  );

  // ── scenario C1: mixed native/guest overlap on an admitted store ────────
  it(
    "scenario C1: overlapping native and guest writers retain every committed record and pass integrity_check",
    { timeout: 40 * 60_000 },
    async (t) => {
      const result = await runScenarioC1MixedOverlap(evidenceDir);
      if (result.blocked) {
        t.skip(`ENVIRONMENT: ${result.signature}`);
        return;
      }
      observedVmIds.push(...result.observedVmIds);
      const parsed = JSON.parse(fs.readFileSync(result.evidencePath, "utf-8")) as ScenarioCEvidence;
      assert.equal(parsed.mode, "real-run");
      const overlap = parsed.mixedOverlap;
      assert.ok(overlap, "scenario C1: the mixed-overlap evidence must be recorded");
      assert.ok((overlap?.overlapMs ?? 0) > 0, "scenario C1: the writers must overlap");
      assert.equal(overlap?.integrityCheck, "ok", "scenario C1: integrity_check must be ok");
      assert.deepEqual(overlap?.missingRecords, [], "scenario C1: no committed record may be lost");
      assert.ok(
        (overlap?.retainedRecords ?? 0) > 0,
        "scenario C1: at least one committed native record must be retained",
      );
      assert.ok(
        (overlap?.guestWriter?.sessionsRows ?? 0) >= 1,
        "scenario C1: the guest's own row must be retained in the same store",
      );
      const writer = overlap?.writers[0];
      assert.ok(writer, "scenario C1: the native writer is recorded");
      assert.ok((writer?.pid ?? 0) > 0, "scenario C1: the writer's pid is recorded");
      assert.match(String(writer?.stoppedBy), /recorded pid/i, "scenario C1: stopped by recorded pid");
      assert.ok(parsed.designAcceptance.some((line) => line.startsWith("C1 ADMITTED OVERLAP")));
      assert.ok(parsed.noLease.length > 0, "scenario C1: the no-lease limitation is stated");
    },
  );

  // ── scenario C2: transient rollback-journal refusal, then allow ─────────
  it(
    "scenario C2: a nonempty rollback journal refuses through the real run path and the next observation allows",
    { timeout: 25 * 60_000 },
    async () => {
      const result = await runScenarioC2JournalTransition(evidenceDir);
      assert.equal(result.blocked, false, "scenario C2 creates no VM, so it can never be ENVIRONMENT-blocked");
      if (result.blocked) return;
      const parsed = JSON.parse(fs.readFileSync(result.evidencePath, "utf-8")) as ScenarioCEvidence;
      assert.equal(parsed.mode, "real-run");
      const transition = parsed.journalTransition;
      assert.ok(transition, "scenario C2: the journal-transition evidence must be recorded");
      assert.ok(
        (transition?.refusal.findingCodes ?? []).includes("sidecar-unresolved"),
        "scenario C2: the refusal code is sidecar-unresolved",
      );
      assert.ok(
        (transition?.refusal.remedyText ?? []).some((line) => /ROLLBACK journal/.test(line)),
        "scenario C2: the remedy names the rollback journal",
      );
      assert.equal(transition?.allow.configJournalMode, "delete", "scenario C2: the later observation allows");
      assert.equal(transition?.quiescence.journalNeverDeletedByGate, true);
      assert.deepEqual(transition?.quiescence.liveWriterPids, [], "scenario C2: no writer was left running");
      assert.ok(parsed.designAcceptance.some((line) => line.startsWith("C2 TRANSIENT REFUSAL")));
      assert.ok(parsed.noLease.length > 0, "scenario C2: the no-lease limitation is stated");
    },
  );

  it("records the observed in-VM round count and refuses a zero-round PASS", () => {
    const observedRounds = new Set(observedVmIds).size;
    writeObservedRoundsEvidence(evidenceDir, {
      gate: GATE_LABEL,
      observed_rounds: observedRounds,
      observed_vm_ids: observedVmIds,
      detail:
        observedRounds === 0
          ? "no in-VM round observed: A1 creates no VM by design and A2 requires a VM-capable environment"
          : `${observedRounds} in-VM round(s) observed (scenario A2)`,
    });
    // A real-VM gate that drove no round must never report green; the driver's
    // observed-rounds guard refuses the same evidence with exit 92.
    assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
  });
});
