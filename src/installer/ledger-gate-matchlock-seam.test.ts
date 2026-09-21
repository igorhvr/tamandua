/**
 * US-006 finalizer ledger seam — evaluator + HostSuiteStore evidence source.
 *
 * Proves:
 *   - the source-absent path is the unchanged native ledger query;
 *   - an opted-in source is consulted for the EXACT canonical namespace +
 *     origin/tree/cmd key and maps exit 0 => green, other => red, no row =>
 *     missing, through the SAME gateMode/strict-missing/concession vocabulary;
 *   - there is NO native fallback (a native green row for the exact key is
 *     invisible when the opted-in Matchlock store has no row);
 *   - cross-namespace / foreign-tree / foreign-command rows never satisfy the
 *     gate while a foreign-role row in the canonical namespace does (native
 *     repo-wide evidence semantics);
 *   - invalid/missing exit fails closed (red, never green);
 *   - rewritten TEST_CMD semantics key on the established contract;
 *   - refusal diagnostics never read the native ledger when a source is given.
 *
 * Serial lane: real git fixture + real private native DB + real HostSuiteStore.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import { closeDb, getDb } from "../../dist/db.js";
import {
  evaluateFinalizeMergeLedgerGate,
  formatLedgerGateRefusal,
  type FinalizeMergeEvidenceRow,
  type FinalizeMergeEvidenceSource,
  type LedgerGateDecision,
} from "../../dist/installer/ledger-gate.js";
import {
  guestSuiteNamespaceId,
  type GuestSuiteNamespace,
} from "../../dist/installer/matchlock/guest-suite-contract.js";
import { openHostSuiteStore, type HostSuiteStore } from "../../dist/installer/matchlock/host-suite-store.js";
import { createHostSuiteLedgerEvidenceSource } from "../../dist/installer/matchlock/suite-ledger-source.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { computeCmdHash, getOriginRepo } from "../../dist/suite/tree-hash.js";

const TEST_CMD = "npm test -- --runInBand ";
const TESTED_TREE = "0123456789abcdef0123456789abcdef01234567";
const OTHER_TREE = "fedcba9876543210fedcba9876543210fedcba98";

const NS_CANONICAL: GuestSuiteNamespace = {
  imageContentId: "sha256:canonical-image",
  guestPlatform: "linux/amd64",
  helperContract: "guest-helper-canonical",
  compatibilityFingerprint: "fp-canonical",
};
const NS_FOREIGN: GuestSuiteNamespace = {
  imageContentId: "sha256:foreign-image",
  guestPlatform: "linux/amd64",
  helperContract: "guest-helper-foreign",
  compatibilityFingerprint: "fp-foreign",
};

type GateMode = "default" | "green" | "off";
type Evidence = "green" | "red" | "missing";

describe("US-006 finalizer ledger seam (evaluator + host suite source)", () => {
  let fixtureRoot: string;
  let repo: string;
  let originRepo: string;
  let stateDir: string;
  let suiteStore: HostSuiteStore;
  let storePath: string;
  let clock: number;

  let originalHome: string | undefined;
  let originalStateDir: string | undefined;
  let originalDbPath: string | undefined;

  before(() => {
    fixtureRoot = tamanduaTempDir("tamandua-ledger-seam-repo-");
    repo = path.join(fixtureRoot, "origin");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "ledger-seam@example.test"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Ledger Seam Test"], { cwd: repo });
    fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    originRepo = getOriginRepo(repo);
  });

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    stateDir = tamanduaTempDir("tamandua-ledger-seam-state-");
    process.env.HOME = stateDir;
    process.env.TAMANDUA_STATE_DIR = path.join(stateDir, ".tamandua");
    process.env.TAMANDUA_DB_PATH = path.join(stateDir, ".tamandua", "tamandua.db");
    closeDb();
    getDb();
    clock = Date.parse("2026-08-01T00:00:00.000Z");
    storePath = path.join(stateDir, "matchlock-suite.db");
    suiteStore = openHostSuiteStore(storePath, { now: () => clock });
  });

  afterEach(() => {
    suiteStore.close();
    closeDb();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = originalDbPath;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  after(() => {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function seedEligibleRun(
    mode: GateMode,
    options: { attested?: boolean; stepId?: string; testCmd?: string } = {},
  ): void {
    const db = getDb();
    const testCmd = options.testCmd ?? TEST_CMD;
    const context: Record<string, string> = {
      repo,
      worktree_origin_repository: repo,
      test_cmd: testCmd,
      // Must never be accepted as an attestation.
      tested_tree: "seeded-run-creation-tree",
    };
    if (mode !== "default") context.merge_gate = mode;

    db.prepare(
      `INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at)
       VALUES ('run-current', 'feature-dev-merge-worktree', 'task', 'running', ?, datetime('now'), datetime('now'))`,
    ).run(JSON.stringify(context));
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status, output, created_at, updated_at)
       VALUES ('tester-step', 'run-current', 'test', 'tester', 0, '', '', 'done', ?, datetime('now'), datetime('now'))`,
    ).run(
      options.attested === false
        ? "STATUS: done\nRESULTS: no attestation"
        : `STATUS: done\nTESTED_TREE: ${TESTED_TREE}`,
    );
    db.prepare(
      `INSERT INTO steps
         (id, run_id, step_id, agent_id, step_index, input_template, expects, status, created_at, updated_at)
       VALUES ('finalize-step', 'run-current', ?, 'merger', 1, '', '', 'pending', datetime('now'), datetime('now'))`,
    ).run(options.stepId ?? "finalize_merge");
  }

  function seedNativeLedger(state: Exclude<Evidence, "missing">): { id: number; createdAt: string } {
    const db = getDb();
    const exitCode = state === "green" ? 0 : 7;
    const createdAt = "2026-08-02T00:00:00.000Z";
    const inserted = db.prepare(
      `INSERT INTO suite_results
         (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, ?, 20, 'native log tail', 'native-run', 'native-step', ?)`,
    ).run(originRepo, TESTED_TREE, computeCmdHash(TEST_CMD), TEST_CMD, exitCode, createdAt);
    return { id: Number(inserted.lastInsertRowid), createdAt };
  }

  function recordRow(
    namespace: GuestSuiteNamespace,
    overrides: Partial<{
      originRepo: string;
      treeHash: string;
      cmdHash: string;
      exitCode: number;
      runId: string | null;
      stepId: string | null;
      agentId: string | null;
      invocationId: string;
      durationMs: number;
      logTail: string | null;
    }> = {},
  ): { id: number; createdAt: string } {
    clock += 1000;
    const startedAt = new Date(clock).toISOString();
    const outcome = suiteStore.record({
      namespaceId: guestSuiteNamespaceId(namespace),
      originRepo: overrides.originRepo ?? originRepo,
      treeHash: overrides.treeHash ?? TESTED_TREE,
      cmdHash: overrides.cmdHash ?? computeCmdHash(TEST_CMD),
      cmdDisplay: TEST_CMD,
      exitCode: overrides.exitCode ?? 0,
      durationMs: overrides.durationMs ?? 33,
      logTail: overrides.logTail ?? "matchlock log tail",
      runId: overrides.runId ?? "matchlock-run",
      stepId: overrides.stepId ?? "test",
      startedAt,
      invocationId: overrides.invocationId ?? randomUUID(),
      agentId: overrides.agentId === undefined ? "tester" : overrides.agentId,
      jobId: "job-1",
      force: false,
    });
    const row = suiteStore.queryMergeEvidence({
      namespaceId: guestSuiteNamespaceId(namespace),
      originRepo: overrides.originRepo ?? originRepo,
      treeHash: overrides.treeHash ?? TESTED_TREE,
      cmdHash: overrides.cmdHash ?? computeCmdHash(TEST_CMD),
    });
    return { id: outcome.id, createdAt: row?.created_at ?? startedAt };
  }

  function canonicalSource(): FinalizeMergeEvidenceSource {
    return createHostSuiteLedgerEvidenceSource({ store: suiteStore, namespace: NS_CANONICAL });
  }

  function makeFakeSource(
    row: FinalizeMergeEvidenceRow | null,
    overrides: { onQuery?: (key: { originRepo: string; treeHash: string; cmdHash: string }) => void; namespaceId?: string } = {},
  ): FinalizeMergeEvidenceSource {
    return {
      namespaceId: overrides.namespaceId ?? guestSuiteNamespaceId(NS_CANONICAL),
      queryMergeEvidence(key) {
        overrides.onQuery?.(key);
        return row;
      },
    };
  }

  function assertKey(decision: Exclude<LedgerGateDecision, { status: "inert" }>, testCmd: string = TEST_CMD): void {
    assert.equal(decision.treeHash, TESTED_TREE);
    assert.equal(decision.cmdHash, computeCmdHash(testCmd));
    assert.equal(decision.originRepo, originRepo);
    assert.equal(decision.testCmd, testCmd);
  }

  for (const mode of ["default", "green", "off"] as const) {
    for (const state of ["green", "red", "missing"] as const) {
      it(`native source-absent ${state}/${mode} decision is unchanged`, () => {
        seedEligibleRun(mode);
        const native = state === "missing" ? null : seedNativeLedger(state);

        const decision = evaluateFinalizeMergeLedgerGate("finalize-step");

        if (mode === "off") {
          assert.equal(decision.status, "overridden");
          assertKey(decision);
          return;
        }
        assert.equal(decision.status, state);
        assert.equal(decision.gateMode, mode);
        assertKey(decision);
        if (state === "missing") {
          assert.equal("row" in decision, false);
        } else {
          assert.ok(native);
          assert.equal(decision.row.id, native.id);
          assert.equal(decision.row.createdAt, native.createdAt);
          assert.equal(decision.row.exitCode, state === "green" ? 0 : 7);
        }
      });
    }
  }

  for (const mode of ["default", "green", "off"] as const) {
    for (const state of ["green", "red", "missing"] as const) {
      it(`opted-in Matchlock source ${state}/${mode} decision maps like native`, () => {
        seedEligibleRun(mode);
        // Native ledger holds the OPPOSITE state: the source must win.
        if (state !== "green") seedNativeLedger("green");
        const recorded = state === "missing" ? null : recordRow(NS_CANONICAL, { exitCode: state === "green" ? 0 : 9 });

        const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

        if (mode === "off") {
          assert.equal(decision.status, "overridden");
          assertKey(decision);
          return;
        }
        assert.equal(decision.status, state);
        assert.equal(decision.gateMode, mode);
        assertKey(decision);
        if (state === "missing") {
          assert.equal("row" in decision, false);
        } else {
          assert.ok(recorded);
          assert.equal(decision.row.id, recorded.id);
          assert.equal(decision.row.exitCode, state === "green" ? 0 : 9);
          assert.equal(decision.row.durationMs, 33);
          assert.equal(decision.row.logTail, "matchlock log tail");
          assert.equal(decision.row.runId, "matchlock-run");
          assert.equal(decision.row.stepId, "test");
        }
      });
    }
  }

  it("inert decisions never consult the opted-in source", () => {
    seedEligibleRun("default", { attested: false });
    let queried = false;
    const decision = evaluateFinalizeMergeLedgerGate(
      "finalize-step",
      makeFakeSource(null, { onQuery: () => { queried = true; } }),
    );
    assert.deepEqual(decision, { status: "inert", reason: "no_tested_tree_attestation" });
    assert.equal(queried, false, "an inert gate must not query evidence");
  });

  it("queries the source with the EXACT origin/tree/cmd key and bound namespace", () => {
    seedEligibleRun("green");
    recordRow(NS_CANONICAL, { exitCode: 0 });
    const seen: Array<{ originRepo: string; treeHash: string; cmdHash: string }> = [];
    const source = canonicalSource();
    const wrapped: FinalizeMergeEvidenceSource = {
      namespaceId: source.namespaceId,
      queryMergeEvidence(key) {
        seen.push(key);
        return source.queryMergeEvidence(key);
      },
      nearestEvidence: source.nearestEvidence?.bind(source),
    };

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", wrapped);

    assert.equal(decision.status, "green");
    assert.deepEqual(seen, [{ originRepo, treeHash: TESTED_TREE, cmdHash: computeCmdHash(TEST_CMD) }]);
    assert.equal(wrapped.namespaceId, guestSuiteNamespaceId(NS_CANONICAL));
  });

  it("NEVER falls back to a native green row when the Matchlock store has none", () => {
    seedEligibleRun("green");
    seedNativeLedger("green");

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

    assert.equal(decision.status, "missing");
    assert.equal("row" in decision, false);
  });

  it("ignores a green row recorded under a FOREIGN namespace for the exact key", () => {
    seedEligibleRun("green");
    recordRow(NS_FOREIGN, { exitCode: 0 });

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

    assert.equal(decision.status, "missing");
  });

  it("ignores a green row for a FOREIGN tree under the canonical namespace", () => {
    seedEligibleRun("green");
    recordRow(NS_CANONICAL, { exitCode: 0, treeHash: OTHER_TREE });

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

    assert.equal(decision.status, "missing");
  });

  it("ignores a green row for a FOREIGN command under the canonical namespace", () => {
    seedEligibleRun("green");
    recordRow(NS_CANONICAL, { exitCode: 0, cmdHash: computeCmdHash("some-other-command") });

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

    assert.equal(decision.status, "missing");
  });

  it("accepts a green row recorded by a FOREIGN role/invocation in the canonical namespace", () => {
    seedEligibleRun("green");
    // Native semantics are repository-wide: evidence written by any run/role
    // for the same tree+command counts. A foreign role row is valid when the
    // NAMESPACE matches.
    recordRow(NS_CANONICAL, { exitCode: 0, agentId: "some-other-role", runId: "foreign-run", stepId: "other-step" });

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

    assert.equal(decision.status, "green");
    assert.equal(decision.row.runId, "foreign-run");
  });

  it("picks the LATEST canonical row (created_at DESC) when several match", () => {
    seedEligibleRun("green");
    recordRow(NS_CANONICAL, { exitCode: 7 });
    const latest = recordRow(NS_CANONICAL, { exitCode: 0 });

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

    assert.equal(decision.status, "green");
    assert.equal(decision.row.id, latest.id);
  });

  it("maps a non-zero integer exit to red", () => {
    seedEligibleRun("green");
    recordRow(NS_CANONICAL, { exitCode: 1 });

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

    assert.equal(decision.status, "red");
    assert.equal(decision.row.exitCode, 1);
  });

  it("fails closed (red) on a missing/invalid exit code", () => {
    seedEligibleRun("green");
    const base: FinalizeMergeEvidenceRow = {
      id: 7,
      exitCode: 0,
      durationMs: 1,
      logTail: null,
      runId: null,
      stepId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
    };

    const missingExit = evaluateFinalizeMergeLedgerGate(
      "finalize-step",
      makeFakeSource({ ...base, exitCode: undefined as unknown as number }),
    );
    assert.equal(missingExit.status, "red", "undefined exit must never be green");

    const negative = evaluateFinalizeMergeLedgerGate(
      "finalize-step",
      makeFakeSource({ ...base, exitCode: -1 }),
    );
    assert.equal(negative.status, "red");
  });

  it("keys opted-in evidence on the ESTABLISHED TEST_CMD after a reviewed rewrite", () => {
    seedEligibleRun("default");
    const db = getDb();
    db.prepare("UPDATE runs SET test_cmd_established = ?, test_cmd_source = 'reviewer' WHERE id = 'run-current'")
      .run("npm run build");
    // Matchlock evidence exists for the ESTABLISHED command only.
    recordRow(NS_CANONICAL, { exitCode: 0, cmdHash: computeCmdHash("npm run build") });
    // Native/stale context evidence (if any) must be irrelevant.
    seedNativeLedger("green");

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

    assert.equal(decision.status, "green");
    assert.equal(decision.testCmd, "npm run build");
    assert.equal(decision.cmdHash, computeCmdHash("npm run build"));
  });

  it("does NOT accept opted-in evidence for the stale context TEST_CMD", () => {
    seedEligibleRun("default");
    const db = getDb();
    db.prepare("UPDATE runs SET test_cmd_established = ?, test_cmd_source = 'reviewer' WHERE id = 'run-current'")
      .run("npm run build");
    // Only the stale context command has Matchlock evidence.
    recordRow(NS_CANONICAL, { exitCode: 0 });

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());

    assert.equal(decision.status, "missing");
    assert.equal(decision.testCmd, "npm run build");
  });

  it("source-aware refusal diagnostics never read the native ledger", () => {
    seedEligibleRun("green");
    // Native has a nearest row for a DIFFERENT tree; the Matchlock store has none.
    const db = getDb();
    db.prepare(
      `INSERT INTO suite_results
         (origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at)
       VALUES (?, ?, ?, ?, 0, 10, 'native', 'native-run', 'native-step', '2026-08-03T00:00:00.000Z')`,
    ).run(originRepo, OTHER_TREE, computeCmdHash(TEST_CMD), TEST_CMD);

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());
    assert.equal(decision.status, "missing");
    if (decision.status !== "missing") assert.fail("expected missing");
    const refusal = formatLedgerGateRefusal(decision, canonicalSource());

    assert.match(refusal, /^NEAREST_EVIDENCE: none for this test command$/m);
    assert.doesNotMatch(refusal, /native/, "native nearest evidence must never leak into a Matchlock refusal");
    // The native no-source path still reports the native nearest row.
    const nativeRefusal = formatLedgerGateRefusal(decision);
    assert.match(nativeRefusal, /^NEAREST_EVIDENCE: tree fedcba9 exit 0 recorded 2026-08-03T00:00:00\.000Z$/m);
  });

  it("source-aware refusal diagnostics report the Matchlock nearest row when present", () => {
    seedEligibleRun("green");
    recordRow(NS_CANONICAL, { exitCode: 4, treeHash: OTHER_TREE });

    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", canonicalSource());
    assert.equal(decision.status, "missing");
    if (decision.status !== "missing") assert.fail("expected missing");
    const refusal = formatLedgerGateRefusal(decision, canonicalSource());

    assert.match(refusal, /^NEAREST_EVIDENCE: tree fedcba9 exit 4 recorded /m);
    assert.match(refusal, /^LEDGER_EVIDENCE: missing$/m);
  });

  it("source-aware diagnostics report unavailable when the source has no nearest query", () => {
    seedEligibleRun("green");
    const source = makeFakeSource(null);
    const decision = evaluateFinalizeMergeLedgerGate("finalize-step", source);
    assert.equal(decision.status, "missing");
    const refusal = formatLedgerGateRefusal(decision, source);
    assert.match(refusal, /^NEAREST_EVIDENCE: unavailable for the host-attested Matchlock evidence source$/m);
  });

  it("adapter source exposes the canonical namespace and rejects a mismatched store", () => {
    const source = createHostSuiteLedgerEvidenceSource({ store: suiteStore, namespace: NS_CANONICAL });
    assert.equal(source.namespaceId, guestSuiteNamespaceId(NS_CANONICAL));
    assert.throws(
      () => createHostSuiteLedgerEvidenceSource({ store: suiteStore, namespace: { ...NS_CANONICAL, imageContentId: "bad value" } }),
      /unsupported characters/,
    );
  });
});
