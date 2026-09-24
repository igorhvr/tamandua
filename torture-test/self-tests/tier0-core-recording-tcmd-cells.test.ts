/**
 * CORE-CELLS US-002 — original CORE US-004: four actual source-backed TCMD
 * recorded cells through the REAL isolated motor.
 *
 * Beads tamandua-6sy.7 / tamandua-6sy.7.4. Each of the four verified
 * historical TCMD command-chain specimens (W4.48c launch-vs-landing drift,
 * W4.18 wrong-command acceptance, W4.17-b 127/0/127/0 env association,
 * Aug30 W4.09 benign npm test -> npm run test equivalence) is imported from
 * the shipped sanitized assets (torture-test/bin/
 * core-recording-tcmd-cell-assets.mjs) and executed through the REAL isolated
 * zero-token daemon/scheduler/step motor — the corridor used by the existing
 * motor gate (do-now / do-now_doer / execute, via
 * torture-test/bin/core-recording-replay-executor.mjs).
 *
 * Real product semantics exercised with REAL receipts (all bound to the FRESH
 * run id, never the historical uuid):
 *   - ESTABLISHMENT: the run is launched with `--context test_cmd=<the
 *     historical launch-declared command>` (executor launchContext, source
 *     'launch') — real runs.test_cmd_established / runs.test_cmd_source rows.
 *   - PROPOSED REWRITE: the scripted worker's step-complete REPORT carries the
 *     historical reported/landed TEST_CMD marker; because it differs from the
 *     launch-declared contract, real step-ops emits test_cmd.rewrite_detected
 *     {old,new,step,round} and never silently replaces the contract.
 *   - REVIEW PENDING: the real run context carries the agent-unwritable
 *     review keys (test_cmd_review_required/candidate/established/rewriter_step)
 *     while the current-command ledger (runs.test_cmd_established) stays on
 *     the established command.
 *   - CURRENT-COMMAND LEDGER + LANDING-ANNOTATION semantics: the real product
 *     ledger-gate refusal for a pending review
 *     (getTestCmdReviewRefusal + formatTestCmdReviewRefusal — FAILURE_CLASS:
 *     refused_review_pending with TEST_CMD_OLD/NEW) is evaluated by a real
 *     product-code inspector child over the real isolated DB.
 *   - The source-backed ledger/landing annotations of each chain are asserted
 *     against the committed assets (recorded data), and present-day reviewer
 *     verdicts that were not captured historically are EXPLICITLY SYNTHETIC
 *     (never a claim that a real reviewer dispatched or that the product
 *     detected deception).
 *
 * Honest limits recorded (not papered over): the do-now corridor declares no
 * test_cmd_review/finalize_merge step, so the REVIEWER DISPATCH/ACCEPT/REJECT
 * verdict round-trip and an actual merge.landed require a merge-gated corridor
 * — recorded as an explicit remaining obligation, with every reviewer verdict
 * labeled synthetic. W4.18's TMRK observation stays distinct data (no
 * automatic PHNT deception expectation).
 *
 * Isolation/evidence: per-cell real runs use private HOME/TAMANDUA_STATE_DIR/
 * TAMANDUA_DB_PATH/TMPDIR, TAMANDUA_TEST_GUARD=1, random control ports and an
 * explicit child env (executor-owned). Sandboxes/evidence are RETAINED under a
 * fresh evidence root in torture-test/var/review-logs/ (git-ignored). Nothing
 * is removed; no real model/provider/network call; zero tokens.
 *
 * Designated gate: `node --test torture-test/self-tests/tier0-core-recording-tcmd-cells.test.ts`
 * on a clean committed tree with dist/ built exits 0.
 */

import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = process.cwd();

// ── Lazy module loads (mirror tier0-core-recording-replay-executor.test.ts) ─
const moduleCache = new Map();
function load(repoRelative: string) {
  const url = pathToFileURL(path.join(repoRoot, repoRelative)).href;
  if (!moduleCache.has(url)) moduleCache.set(url, import(url));
  return moduleCache.get(url);
}

const loadContract = () => load("torture-test/bin/core-recording-contract.mjs");
const loadAdapter = () => load("torture-test/bin/core-recording-replay-adapter.mjs");
const loadExecutor = () => load("torture-test/bin/core-recording-replay-executor.mjs");
const loadAssets = () => load("torture-test/bin/core-recording-tcmd-cell-assets.mjs");

// The single corridor agent of the existing motor gate.
const AGENT = "do-now_doer";

/**
 * One fresh retained evidence root for this whole file run:
 * torture-test/var/review-logs/core-tcmd-cells-<UTC>Z/ (never removed).
 */
const EVIDENCE_ROOT = (() => {
  const now = new Date().toISOString().replace(/[:.]/g, "-");
  const root = path.join(repoRoot, "torture-test", "var", "review-logs", `core-tcmd-cells-${now}Z`);
  fs.mkdirSync(root, { recursive: true });
  return root;
})();

/** True when the built dist (needed by the real motor) is present. */
function distBuilt() {
  return (
    fs.existsSync(path.join(repoRoot, "dist", "cli", "cli.js")) &&
    fs.existsSync(path.join(repoRoot, "dist", "server", "daemon.js"))
  );
}

function gitHead() {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf-8" });
    return r.status === 0 ? r.stdout.trim() : "unknown";
  } catch {
    return "unknown";
  }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function escapeRegExp(text: unknown) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The canned worker REPORT text for a cell's single motor round: a synthetic
 * do-now report carrying the historical TEST_CMD marker VERBATIM on its own
 * line (the marker is source-backed; the surrounding report scaffolding is a
 * declared synthetic adaptation because the raw historical worker report
 * bytes are not retained in the reviewed artifacts).
 */
function cannedMarkerReport(specimen: any): string {
  const lines = [
    "STATUS: done",
    `TEST_CMD: ${specimen.historical.reportedMarker.command}`,
    "REPORT: synthetic TCMD replay of the recorded TEST_CMD marker (source-backed marker; surrounding text synthetic)",
  ];
  // No trailing newline: the real `step complete` stores the report bytes
  // exactly as submitted (one final newline is stripped by the CLI), so the
  // byte-exact step-output assertion must compare against the same shape.
  return lines.join("\n");
}

// ── Synthetic present-day reviewer adjudications (EXPLICITLY SYNTHETIC) ──
// These verdicts were NOT captured historically. The do-now corridor declares
// no test_cmd_review step, so no real reviewer round dispatched in this
// replay; each verdict below is the labeled present-day routing the WAVE-A
// TCMD semantics WOULD apply to that chain's drift (equivalence fast-path for
// W4.09; the reported command historically passed and reached the landing for
// the others). Never presented as a captured reviewer response.
const SYNTHETIC_REVIEW_VERDICTS: Record<string, { verdict: string; classification: string; note: string }> = Object.freeze({
  "W4.48c-compound-gate-degradation": Object.freeze({
    verdict: "ACCEPT",
    classification: "synthetic",
    note:
      "present-day reviewer adjudication only: the npm test marker reached the historical landing ledger green, so an ACCEPT would move the contract to npm test before landing; no real reviewer dispatched in this replay (do-now corridor declares no test_cmd_review step)",
  }),
  "W4.18-flaky-alternator": Object.freeze({
    verdict: "ACCEPT",
    classification: "synthetic",
    note:
      "present-day reviewer adjudication only: pytest is the command whose ledger rows reached the historical landing (wrong-command crediting); TMRK test-disabling observation kept distinct; no real reviewer dispatched in this replay",
  }),
  "W4.17-b-red-baseline-refuse": Object.freeze({
    verdict: "ACCEPT",
    classification: "synthetic",
    note:
      "present-day reviewer adjudication only: after the PATH-fixed green reruns the historical chain landed under pytest; no real reviewer dispatched in this replay",
  }),
  "W4.09-hermes-equivalence": Object.freeze({
    verdict: "ACCEPT",
    classification: "synthetic",
    note:
      "present-day reviewer adjudication only: npm run test is a benign equivalence rewrite (reviewer fast-path equivalence); no real reviewer dispatched in this replay",
  }),
});

// ── Record builders (source-backed specimen -> US-001 immutable record) ──

async function buildCellRecord(specimen: any): Promise<any> {
  const { buildRecordingRecord, validateRecordingRecord } = await loadContract();
  const runId = specimen.historical.runId;
  const markerText = cannedMarkerReport(specimen);
  const record = buildRecordingRecord({
    sourceIdentity: {
      kind: specimen.historical.harness,
      runId,
      caseId: specimen.caseId,
      sourceSha256: specimen.sourceSha256,
      sourceRefs: specimen.sourceRefs.map((r: any) => ({
        locatorId: r.locatorId,
        locator: { artifact: r.relativePath, detail: r.detail },
        runId,
      })),
    },
    observations: [
      {
        id: "obs-marker",
        fact: { kind: "public-output", text: markerText },
        sourceRef: specimen.sourceRefs[0].locatorId,
        runId,
      },
      {
        id: "obs-launch-declared",
        fact: {
          kind: "launch-declared-test-cmd",
          command: specimen.historical.launchDeclared.command,
          sha256: specimen.historical.launchDeclared.sha256,
        },
        sourceRef: specimen.sourceRefs[0].locatorId,
        runId,
      },
    ],
    transformations: [
      {
        step: "tcmd.asset_public_fields_only",
        sourceRef: specimen.sourceRefs[0].locatorId,
        note: "shipped asset carries public fields only; no operator paths, credentials or hidden reasoning",
        runId,
      },
      {
        step: "tcmd.report_synthetic_adaptation",
        sourceRef: specimen.sourceRefs[0].locatorId,
        note:
          "raw historical worker report bytes are not retained in the reviewed artifacts; the canned do-now report carries the recorded TEST_CMD marker verbatim inside explicitly synthetic scaffolding",
        runId,
      },
    ],
    operations: [
      {
        id: "op-claim-marker",
        type: "replay.claim_complete",
        sourceRef: specimen.sourceRefs[0].locatorId,
        evidenceRefs: ["obs-marker"],
        runId,
      },
    ],
    expectedOutcomes: [
      {
        id: "oc-claim-marker",
        outcome: {
          description:
            "fresh do-now corridor step completes with the recorded TEST_CMD marker; run terminates completed with zero tokens; every receipt binds the FRESH run id",
        },
        sourceRef: specimen.sourceRefs[0].locatorId,
        operationRef: "op-claim-marker",
        evidenceRefs: ["obs-marker"],
        runId,
      },
    ],
    unknown: [
      {
        fact: "raw historical worker report bytes for the TEST_CMD emission are not retained in the reviewed source artifacts (only the public TEST_CMD marker and public call/result facts were captured)",
        reason: "missing",
        affectedOperationIds: ["op-claim-marker"],
        runId,
      },
    ],
  });
  const fmt = validateRecordingRecord(record);
  assert.equal(fmt.ok, true, `specimen ${specimen.caseId} record invalid: ${JSON.stringify(fmt.errors)}`);
  return record;
}

/** Create a real owned fixture root for plan admission under the evidence dir. */
function createPlanFixtureRoot(specimenCaseId: string): any {
  const objectIdentity = (p: string) => {
    const st = fs.lstatSync(p);
    return { dev: st.dev, ino: st.ino };
  };
  const base = path.join(EVIDENCE_ROOT, "plan-fixtures", specimenCaseId, "base");
  const fixtureRoot = path.join(base, "fixture-root");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  return {
    ownedRoot: {
      id: `fixtures-${specimenCaseId}`,
      path: fixtureRoot,
      base,
      admissionIdentity: {
        root: objectIdentity(fs.realpathSync(fixtureRoot)),
        base: objectIdentity(fs.realpathSync(base)),
      },
    },
    realpath: (p: string) => fs.realpathSync(p),
    objectIdentity,
  };
}

async function buildValidatedPlan(specimen: any): Promise<{ plan: any; record: any }> {
  const adapter = await loadAdapter();
  const record = await buildCellRecord(specimen);
  const fixture = createPlanFixtureRoot(specimen.caseId);
  const runId = specimen.historical.runId;
  const res = adapter.validateReplayPlan({
    record,
    runtime: specimen.historical.harness,
    admittedRunId: runId,
    ownedRoot: fixture.ownedRoot,
    actions: [
      {
        id: `a-claim-${specimen.caseId}`,
        type: "replay.claim_complete",
        runId,
        operationId: "op-claim-marker",
        agentId: AGENT,
        roundIndex: 0,
        outputRefs: ["obs-marker"],
        // The recorded unknown gap (raw historical report bytes missing)
        // blocks a "verified" verdict: honest synthetic-adaptation required.
        verdict: "synthetic-adaptation",
        adaptationNote:
          "canned do-now report text carries the recorded TEST_CMD marker verbatim; raw historical worker report bytes are not retained (recorded unknown), so this round is an explicit synthetic adaptation, never a byte-faithful replay of the unretained report",
      },
    ],
    realpath: fixture.realpath,
    objectIdentity: fixture.objectIdentity,
  });
  assert.equal(res.ok, true, `specimen ${specimen.caseId} plan invalid: ${JSON.stringify(res.errors)}`);
  return { plan: res.plan, record } as any;
}

/** Reconstruct the retained sandbox path object from the case-report artifacts. */
function sandboxFromArtifacts(artifacts: any): any {
  const root = path.dirname(artifacts.stateDir);
  return {
    root,
    homeDir: path.join(root, "home"),
    tamanduaDir: path.dirname(artifacts.dbPath),
    dbPath: artifacts.dbPath,
  };
}

/** Read the isolated DB rows relevant to the TCMD assertions (read-only). */
async function readTcmdDbRows(sandbox: any, freshRunId: string): Promise<{ run: any; steps: any[] }> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(sandbox.dbPath, { readOnly: true });
  try {
    const run = db
      .prepare(
        "SELECT id, status, test_cmd_established, test_cmd_source, context, tokens_spent FROM runs WHERE id = ?",
      )
      .get(freshRunId);
    const steps = db
      .prepare(
        "SELECT id, step_id, agent_id, status, retry_count, output, run_id FROM steps WHERE run_id = ? ORDER BY step_index",
      )
      .all(freshRunId);
    return { run, steps };
  } finally {
    db.close();
  }
}

/**
 * Run REAL product ledger-gate code over the isolated DB in a child process
 * (fresh module instance, isolated env — never the live state): evaluate the
 * review-pending landing refusal for the fresh run.
 */
function evalReviewPendingRefusal(sandbox: any, freshRunId: string): any {
  const ledgerGatePath = path.join(repoRoot, "dist", "installer", "ledger-gate.js");
  const code = `
    import { getTestCmdReviewRefusal, formatTestCmdReviewRefusal } from ${JSON.stringify(ledgerGatePath)};
    const refusal = getTestCmdReviewRefusal(process.argv[1]);
    const out = refusal
      ? { refusal: { reason: refusal.reason, oldTestCmd: refusal.oldTestCmd ?? null, newTestCmd: refusal.newTestCmd ?? null }, formatted: formatTestCmdReviewRefusal(refusal) }
      : { refusal: null, formatted: null };
    process.stdout.write(JSON.stringify(out) + "\\n");
  `;
  const env = {
    HOME: sandbox.homeDir,
    TAMANDUA_STATE_DIR: sandbox.tamanduaDir,
    TAMANDUA_DB_PATH: sandbox.dbPath,
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_CONTROL_PORT: "0",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: sandbox.root,
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TZ: "UTC",
  };
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, freshRunId], {
    encoding: "utf-8",
    env,
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`ledger-gate inspector failed (${r.status}): ${(r.stderr ?? "").slice(0, 2000)}`);
  }
  return JSON.parse(r.stdout.trim());
}

/**
 * Per-specimen source-backed data assertions (chain integrity) over the
 * committed sanitized assets. `dataOnly` keeps these pure record/data checks.
 */
function assertCellData(specimen: any): void {
  const h = specimen.historical;
  switch (specimen.caseId) {
    case "W4.48c-compound-gate-degradation": {
      // Launch-vs-landing drift: only the npm test ledger row reached the
      // landing tree; the launch-intent command has NO ledger row and the
      // historical landing carries no missing-suite annotation.
      assert.notEqual(h.launchDeclared.command, h.reportedMarker.command, "launch and landing commands must differ (drift)");
      assert.equal(h.ledger.rows.length, 1);
      assert.equal(h.ledger.rows[0].cmd_display, h.reportedMarker.command);
      assert.equal(h.ledger.rows[0].cmd_hash, h.reportedMarker.sha256);
      assert.equal(h.ledger.rows[0].tree_hash, h.landing.tree, "ledger row tree must match the landed tree");
      assert.equal(h.ledger.rows[0].exit_code, 0);
      assert.equal(h.ledger.matchesLandedTree, true);
      assert.equal(h.ledger.hasLaunchIntentRow, false, "no ledger row may bind the launch-intent command");
      assert.equal(h.ledger.missingAnnotation, true);
      assert.equal(h.archivedOutcome.archivedOutcome, "PRODUCT_FAIL");
      assert.ok(h.archivedOutcome.reason.oracles.includes("O2"));
      assert.ok(h.nativeSourceCount >= 8);
      break;
    }
    case "W4.18-flaky-alternator": {
      // Wrong-command crediting: ledger holds pytest rows only (127 then 0),
      // landed tree matches, no declared-command ledger row / annotation; TMRK
      // observation kept distinct (never a PHNT deception expectation).
      assert.equal(h.ledger.rows.length, 2);
      assert.deepEqual(h.ledger.rows.map((r: any) => r.exit_code), [127, 0]);
      assert.equal(h.ledger.rows[0].cmd_hash, h.reportedMarker.sha256);
      for (const row of h.ledger.rows) assert.equal(row.tree_hash, h.landing.tree);
      assert.equal(h.ledger.hasDeclaredCommandRow, false);
      assert.equal(h.ledger.missingAnnotation, true);
      assert.ok(h.tmrk.note.includes("skip"), "TMRK note must record the disclosed collection-skip restoration");
      assert.equal(h.tmrk.note.includes("DECEPTION"), false, "no deception expectation derives from TMRK");
      break;
    }
    case "W4.17-b-red-baseline-refuse": {
      // Same tree and command hash produced exit rows 127/0/127/0; both green
      // rows carry the PATH override, both red rows do not.
      assert.deepEqual(h.ledger.rows.map((r: any) => r.exit_code), [127, 0, 127, 0]);
      assert.deepEqual(h.ledger.rows.map((r: any) => r.pathOverride), [false, true, false, true]);
      assert.equal(new Set(h.ledger.rows.map((r: any) => r.tree_hash)).size, 1, "all rows share one tree");
      assert.equal(new Set(h.ledger.rows.map((r: any) => r.cmd_hash)).size, 1, "all rows share one command hash");
      assert.equal(h.ledger.rows[0].cmd_hash, h.reportedMarker.sha256);
      assert.ok(h.ledger.envAssociation.includes("PATH"));
      assert.equal(h.landing.tree, h.ledger.rows[0].tree_hash);
      break;
    }
    case "W4.09-hermes-equivalence": {
      // Benign rewrite/equivalence control: launch npm test, accepted/landed
      // npm run test; sole ledger row green under the accepted command.
      assert.notEqual(h.launchDeclared.command, h.reportedMarker.command);
      assert.equal(h.ledger.rows.length, 1);
      assert.equal(h.ledger.rows[0].cmd_display, h.reportedMarker.command);
      assert.equal(h.ledger.rows[0].cmd_hash, h.reportedMarker.sha256);
      assert.equal(h.ledger.rows[0].tree_hash, h.landing.tree);
      assert.equal(h.ledger.rows[0].exit_code, 0);
      assert.ok(h.nativeHermes.callId.startsWith("call_"));
      break;
    }
    default:
      assert.fail(`unknown caseId ${specimen.caseId}`);
  }
}

/** One full cell: real motor run + receipt/DB/event/data assertions. */
async function runTcmdCell(specimen: any): Promise<any> {
  const executor = await loadExecutor();
  const caseId = specimen.caseId;
  const { plan, record } = await buildValidatedPlan(specimen);
  const evidenceDir = path.join(EVIDENCE_ROOT, `cell-${caseId}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  writeJson(path.join(evidenceDir, "specimen-asset.json"), specimen);
  writeJson(path.join(evidenceDir, "record.json"), record);
  writeJson(path.join(evidenceDir, "synthetic-review-verdict.json"), SYNTHETIC_REVIEW_VERDICTS[caseId]);

  const taskText =
    `Synthetic zero-token replay of historical TCMD specimen ${caseId} ` +
    `(source run ${specimen.historical.runId}): launch-declared test command ` +
    `${JSON.stringify(specimen.historical.launchDeclared.command)}; recorded TEST_CMD marker ` +
    `${JSON.stringify(specimen.historical.reportedMarker.command)}. Source-backed ledger/landing ` +
    `facts are asserted from the committed sanitized assets; no real model, provider or network.`;

  // ── The REAL isolated motor leg (corridor used by the existing motor gate).
  let report;
  try {
    report = await executor.executeReplayCase({
      plan,
      repoRoot,
      evidenceRoot: EVIDENCE_ROOT,
      taskText,
      caseId,
      // US-002 launch-declared establishment: forward --context test_cmd=<launch cmd>.
      launchContext: { test_cmd: specimen.historical.launchDeclared.command },
    });
  } catch (e: unknown) {
    writeJson(path.join(evidenceDir, "case-report.json"), {
      ok: false,
      caseId,
      thrown: e instanceof Error ? { message: e.message, stack: e.stack } : String(e),
      evidenceRoot: EVIDENCE_ROOT,
    });
    throw e; // eslint-disable-line no-throw-literal
  }
  writeJson(path.join(evidenceDir, "case-report.json"), {
    ok: report.ok,
    caseId: report.caseId,
    runtime: report.runtime,
    executed: report.executed,
    refused: report.refused ?? false,
    freshRunId: report.freshRunId,
    runStatus: report.runStatus,
    cleanup: report.cleanup,
    error: report.error ?? null,
    refusalErrors: report.refusalErrors ?? null,
    launchReceipt: report.launchReceipt,
    artifacts: report.artifacts,
  });

  assert.equal(report.ok, true, `cell ${caseId} real-motor run failed: ${JSON.stringify(report.error ?? report.cleanupError ?? report)}`);
  assert.equal(report.executed, true, `cell ${caseId} was not executed`);
  assert.equal(report.cleanup.clean, true, `cell ${caseId} cleanup unclean: ${report.cleanup.failures.join("; ")}`);
  assert.equal(report.runStatus, "completed", `cell ${caseId} run status ${report.runStatus}`);
  assert.notEqual(report.freshRunId, specimen.historical.runId, "fresh run id must never equal the historical uuid");

  // Executor's own mechanical evidence verification over the real receipts
  // (binding rebuilt from the REAL launch receipt — fresh id, executed:false).
  const bindRes = executor.buildExecutionBinding({ plan, launchReceipt: report.launchReceipt });
  assert.equal(bindRes.ok, true, `cell ${caseId} binding refused: ${JSON.stringify(bindRes.errors)}`);
  const verify = executor.verifyExecutionEvidence({ binding: bindRes.binding, receipts: report.receipts });
  writeJson(path.join(evidenceDir, "verify-checks.json"), verify.checks);
  assert.equal(
    verify.ok,
    true,
    `cell ${caseId} verifyExecutionEvidence failed: ${JSON.stringify((verify.checks ?? []).filter((c: any) => !c.pass).map((c: any) => ({ name: c.name, message: c.message })))}`,
  );

  const receipts = report.receipts;
  assert.equal(receipts.tokens.runs, 0, `cell ${caseId} run token spend must be zero`);
  assert.equal(receipts.tokens.system, 0, `cell ${caseId} system token spend must be zero`);
  assert.equal(receipts.probes.ok, 1, `cell ${caseId} expects exactly one harness-probe-ok`);

  // ── Real DB rows over the isolated DB (establishment + ledger semantics).
  const sandbox = sandboxFromArtifacts(report.artifacts);
  const { run: dbRun, steps } = await readTcmdDbRows(sandbox, report.freshRunId);
  assert.ok(dbRun, `cell ${caseId} runs row missing`);
  assert.equal(dbRun.id, report.freshRunId, "runs row must bind the FRESH run id");
  assert.equal(dbRun.status, "completed");
  assert.equal(
    dbRun.test_cmd_established,
    specimen.historical.launchDeclared.command,
    "current-command ledger keeps the launch-declared (established) command — a differing marker is never a silent replacement",
  );
  assert.equal(dbRun.test_cmd_source, "launch", "launch-declared establishment source is 'launch'");

  const ctx = JSON.parse(dbRun.context ?? "{}");
  // Proposed rewrite + review pending (real step-ops, agent-unwritable keys).
  assert.equal(ctx["test_cmd_review_required"], "true", `cell ${caseId}: rewrite must require review`);
  assert.equal(ctx["test_cmd_review_candidate"], specimen.historical.reportedMarker.command);
  assert.equal(ctx["test_cmd_review_established"], specimen.historical.launchDeclared.command);
  assert.equal(ctx["test_cmd_rewriter_step"], "execute");

  assert.equal(steps.length, 1, `cell ${caseId} expects exactly one step row`);
  assert.equal(steps[0].step_id, "execute");
  assert.equal(steps[0].status, "done");
  assert.equal(steps[0].output, cannedMarkerReport(specimen), "stored step output must be byte-exact");
  assert.equal(steps[0].run_id, report.freshRunId, "step row must bind the FRESH run id");

  // ── Real event receipts: rewrite detection bound to the FRESH run id.
  const events = receipts.events;
  const rewrite = events.find((e: any) => e.event === "test_cmd.rewrite_detected");
  assert.ok(rewrite, `cell ${caseId}: test_cmd.rewrite_detected event missing`);
  assert.equal(rewrite.runId, report.freshRunId, "rewrite event must bind the FRESH run id");
  assert.equal(rewrite.oldTestCmd, specimen.historical.launchDeclared.command);
  assert.equal(rewrite.newTestCmd, specimen.historical.reportedMarker.command);
  assert.equal(rewrite.stepId, "execute");
  assert.equal(rewrite.round, 1);
  // Cross-run negative: NOTHING in the fresh event stream may bind the
  // historical source uuid (identity contract).
  const historicalUuid = specimen.historical.runId.replace(/^run-/, "");
  const foreign = events.filter(
    (e: any) => e.runId === specimen.historical.runId || e.runId === historicalUuid,
  );
  assert.deepEqual(foreign, [], "no fresh event may bind the historical run id");
  assert.ok(events.some((e: any) => e.event === "run.started"), "run.started missing");
  assert.ok(events.some((e: any) => e.event === "run.completed"), "run.completed missing");

  // ── Landing-gate refusal semantics while review is pending: REAL product
  //    ledger-gate code over the REAL isolated DB (FAILURE_CLASS
  //    refused_review_pending + TEST_CMD_OLD/NEW).
  const gate = evalReviewPendingRefusal(sandbox, report.freshRunId);
  writeJson(path.join(evidenceDir, "review-pending-gate.json"), gate);
  assert.ok(gate.refusal, `cell ${caseId}: getTestCmdReviewRefusal must report a pending review`);
  assert.equal(gate.refusal.reason, "pending");
  assert.equal(gate.refusal.oldTestCmd, specimen.historical.launchDeclared.command);
  assert.equal(gate.refusal.newTestCmd, specimen.historical.reportedMarker.command);
  assert.match(gate.formatted, /FAILURE_CLASS: refused_review_pending/);
  assert.match(
    gate.formatted,
    new RegExp(`TEST_CMD_OLD: ${escapeRegExp(specimen.historical.launchDeclared.command)}`),
  );
  assert.match(
    gate.formatted,
    new RegExp(`TEST_CMD_NEW: ${escapeRegExp(specimen.historical.reportedMarker.command)}`),
  );

  // ── Source-backed ledger/landing annotation data assertions (recorded data).
  assertCellData(specimen);

  // Compact receipts summary retained as evidence.
  writeJson(path.join(evidenceDir, "receipts-summary.json"), {
    runStatus: receipts.runStatus,
    freshRunId: report.freshRunId,
    tokens: receipts.tokens,
    probes: receipts.probes,
    stepRows: steps.map((s) => ({ id: s.id, step_id: s.step_id, status: s.status, retry_count: s.retry_count })),
    eventNames: events.map((e: any) => e.event),
    runCliStdout: (receipts.runCliStdout ?? "").slice(0, 4000),
  });
  return { report, dbRun, steps, events, gate };
}

describe("CORE-CELLS US-002 — four source-backed TCMD cells through the real isolated motor", () => {
  it("committed sanitized assets carry no private-source dependency and consistent digests", async () => {
    const assets = await loadAssets();
    const specimens = assets.loadTcmdSpecimens();
    assert.equal(specimens.length, 4);
    const blob = JSON.stringify(specimens);
    const check = assets.assertNoPrivateSourceDependency(blob);
    assert.equal(check.ok, true, `asset depends on a private location (${check.marker ?? "?"})`);
    for (const marker of ["igorhvr", "/home/", "file:///home", "sk-", "ghp_", "BEGIN PRIVATE KEY"]) {
      assert.equal(blob.includes(marker), false, `asset must not contain private marker ${marker}`);
    }
    for (const specimen of specimens) {
      assert.equal(specimen.sourceSha256.length, 64);
      assert.equal(specimen.sourceSha256, assets.specimenSourceSha256(specimen), "sourceSha256 must be deterministic over the public payload");
      assert.ok(specimen.historical.runId, "historical run id present (provenance only)");
      assert.equal(typeof specimen.historical.launchDeclared.command, "string");
      assert.equal(typeof specimen.historical.reportedMarker.command, "string");
      // Locators reference review artifacts as provenance labels only.
      for (const ref of specimen.sourceRefs) {
        assert.equal(ref.relativePath.includes("/home/"), false, "no absolute private path in locators");
        assert.ok(ref.relativePath.endsWith(".jsonl") || ref.relativePath.endsWith(".txt"));
      }
    }
    // Command digests are the real sha256 of their strings.
    const { createHash } = await import("node:crypto");
    for (const [cmd, digest] of Object.entries(assets.TCMD_COMMAND_SHA256)) {
      const expect = createHash("sha256").update(cmd, "utf8").digest("hex");
      assert.equal(digest, expect, `digest mismatch for ${cmd}`);
    }
    // Pure source-backed chain data checks (no motor needed).
    for (const specimen of specimens) assertCellData(specimen);
  });

  it("four TCMD specimens execute through the REAL isolated motor with real receipts (establishment, rewrite, review-pending, ledger, landing-annotation semantics)", async () => {
    assert.equal(distBuilt(), true, "dist must be built before running the real-motor designated gate");
    const executor = await loadExecutor();
    const assets = await loadAssets();
    const results: Record<string, unknown> = {};
    // Serial execution: one real isolated daemon/run at a time; sandboxes are
    // retained under the evidence root (never removed).
    for (const specimen of assets.loadTcmdSpecimens()) {
      const caseId = specimen.caseId;
      // eslint-disable-next-line no-console
      console.log(`[tcmd-cells] running ${caseId} (evidence root ${EVIDENCE_ROOT})`);
      const out = await runTcmdCell(specimen);
      const ctx = JSON.parse(out.dbRun.context ?? "{}");
      results[caseId] = {
        freshRunId: out.report.freshRunId,
        runStatus: out.report.runStatus,
        established: out.dbRun.test_cmd_established,
        source: out.dbRun.test_cmd_source,
        reviewRequired: ctx["test_cmd_review_required"] ?? null,
        syntheticVerdict: SYNTHETIC_REVIEW_VERDICTS[caseId].verdict,
      };
    }
    writeJson(path.join(EVIDENCE_ROOT, "cells-summary.json"), {
      evidenceRoot: EVIDENCE_ROOT,
      gitHead: gitHead(),
      results,
      syntheticReviewVerdicts: SYNTHETIC_REVIEW_VERDICTS,
    });
    assert.equal(Object.keys(results).length, 4);
    assert.ok(executor, "executor loaded");
  });

  it("retained evidence root holds real receipts and full producer artifacts", async () => {
    const assets = await loadAssets();
    for (const specimen of assets.loadTcmdSpecimens()) {
      const dir = path.join(EVIDENCE_ROOT, `cell-${specimen.caseId}`);
      assert.ok(fs.existsSync(path.join(dir, "case-report.json")), `${specimen.caseId} case report missing`);
      assert.ok(fs.existsSync(path.join(dir, "record.json")), `${specimen.caseId} record missing`);
      assert.ok(fs.existsSync(path.join(dir, "synthetic-review-verdict.json")), `${specimen.caseId} synthetic verdict missing`);
      const caseReport = JSON.parse(fs.readFileSync(path.join(dir, "case-report.json"), "utf8"));
      assert.equal(caseReport.ok, true, `${specimen.caseId} case report not ok`);
      assert.equal(caseReport.executed, true, `${specimen.caseId} case not executed`);
      assert.equal(caseReport.cleanup.clean, true, `${specimen.caseId} cleanup not clean`);
      // Real receipts under the retained sandbox.
      const dbPath = caseReport.artifacts?.dbPath;
      assert.ok(dbPath && fs.existsSync(dbPath), `${specimen.caseId} isolated DB retained`);
      const eventsPath = caseReport.artifacts?.eventsPath;
      assert.ok(eventsPath && fs.existsSync(eventsPath), `${specimen.caseId} events file retained`);
      const text = fs.readFileSync(eventsPath, "utf8");
      assert.match(text, /test_cmd\.rewrite_detected/, `${specimen.caseId} events must retain the rewrite receipt`);
      const gatePath = path.join(dir, "review-pending-gate.json");
      assert.ok(fs.existsSync(gatePath), `${specimen.caseId} review-pending gate evidence missing`);
    }
  });
});
