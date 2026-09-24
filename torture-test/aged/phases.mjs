// phases.mjs — phase entrypoints for the tt-storm-aged generator.
//
// Each phase runs as a private subprocess under the containment env built by
// the CLI (see env.mjs).  A phase NEVER touches operator HOME/default state
// and NEVER starts a real daemon/model: the seed phase binds the labeled
// non-dispatching transport double plus a real control-server facade on random
// ports, drives real product APIs, and closes both before exiting.

import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { utcNow, appendJsonl, writeExclusive, RESERVED_CONTEXT_KEYS } from "./seedcommon.mjs";
import { buildPlan } from "./plan.mjs";
import {
  loadManifest,
  assertRootIdentity,
  phaseReceipt,
  journal,
  recordsContainedPaths,
  ensureLayout,
} from "./manifest.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = gitTop(__dirname);
const LIVE_TAMANDUA_CLI = process.env.TAMANDUA_CLI ?? "/opt/tamandua/bin/tamandua";

function gitTop(dir) {
  const res = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8" });
  if (res.status !== 0) throw new Error("phases.mjs must live inside a git worktree");
  return res.stdout.trim();
}

export async function phaseCatalog(root) {
  const manifest = loadManifest(root);
  assertRootIdentity(root, manifest);
  const paths = recordsContainedPaths(root);
  ensureLayout(root);
  journal(root, { phase: "catalog", intent: "install pinned bundled catalog into private state" });

  // Pin the EXECUTED source identity BEFORE the first effect (the CLI pins it
  // at allocation; phases.mjs direct entry pins it here if absent).  Never
  // re-pin an existing pin: the executed identity of the corpus is immutable.
  const { pinExecutedSource } = await import("./manifest.mjs");
  const pinnedSource = pinExecutedSource(REPO_ROOT);
  let source = manifest.source ?? {};
  if (!source.head) {
    source = pinnedSource;
    manifest.source = source;
    save(manifest, root);
    journal(root, { phase: "catalog", source_pinned: source.head });
  } else {
    manifest.source = source;
    journal(root, {
      phase: "catalog",
      source_pin_preserved: source.head,
      note: "executed-source pin recorded at allocation is preserved; catalog does not re-pin",
    });
  }

  const { installCatalogViaRealCli } = await import("./catalog.mjs");
  const env = {
    ...process.env,
    HOME: paths.homeDir,
    TAMANDUA_STATE_DIR: paths.stateDir,
    TAMANDUA_DB_PATH: path.join(paths.stateDir, "tamandua.db"),
    TAMANDUA_TEST_GUARD: "1",
  };
  const outcome = installCatalogViaRealCli({ tamanduaCli: LIVE_TAMANDUA_CLI, env, repoRoot: REPO_ROOT });
  const fresh = loadManifest(root); // reload — never mutate a stale copy
  fresh.catalog = {
    source_workflows_dir: path.join(REPO_ROOT, "workflows"),
    ids: outcome.ids,
    installed_verify: outcome.verify,
    installed_state_workflows: outcome.stateWorkflows,
  };
  save(fresh, root);
  phaseReceipt(root, "catalog", { ids: outcome.ids, ok: true, ts_utc: utcNow() });
  return { ok: true, ids: outcome.ids };
}

export async function phaseSeed(root, planFile) {
  const manifest = loadManifest(root);
  assertRootIdentity(root, manifest);
  const paths = recordsContainedPaths(root);
  ensureLayout(root);
  journal(root, { phase: "seed", intent: `seed corpus from plan ${planFile ?? "(default pilot)"}` });

  const { resolveProductDist } = await import("./product.mjs");
  const productDist = resolveProductDist().dist;
  const { loadProduct } = await import("./seedlib.mjs");
  const mods = await loadProduct(productDist);

  // Containment/env fail-closed checks inside the phase.
  const forbidden = ["TAMANDUA_RUN_ID", "TAMANDUA_WORKER_PID", "TAMANDUA_PI_BINARY", "PI_SETTINGS_PATH", "PI_AUTH_PATH"];
  for (const key of forbidden) {
    if (process.env[key] !== undefined && process.env[key] !== "") {
      throw new Error(`phaseSeed: parent authority/provider env leaked in: ${key}`);
    }
  }

  // Secret for the transport double + real control facade (private HOME).
  const { writeDaemonSecret } = await import("./env.mjs");
  const { secretPath } = writeDaemonSecret(paths.homeDir);
  const secret = fs.readFileSync(secretPath, "utf-8").trim();
  const controlPort = Number(process.env.TAMANDUA_CONTROL_PORT);

  const { startBoundaries, stopBoundaries } = await import("./seedlib.mjs");
  const boundaries = await startBoundaries({ productDist, secret, homeDir: paths.homeDir, controlPort });
  journal(root, { phase: "seed", boundaries: { doublePort: controlPort, facadePort: boundaries.facadePort } });

  // Fixture origin.
  const { ensureOrigin } = await import("./fixture.mjs");
  const origin = ensureOrigin({ manifest, root, paths });
  journal(root, { phase: "seed", origin });

  const plan = planFile
    ? JSON.parse(fs.readFileSync(planFile, "utf-8"))
    : buildPlan({ manifest, root, origin });

  const receiptsDir = path.join(root, "receipts");
  const baselineFile = path.join(root, "evidence", "o12-reserved-baseline.jsonl");
  const seededRuns = [];
  const reservedRuns = {};
  const baselineSidecar = path.join(root, "evidence", "o12-reserved-baseline.json");
  let cumulative = loadCumulative(root);

  try {
    const failures = [];
    for (const entry of plan.entries) {
      if (cumulative.done.has(entry.id)) {
        journal(root, { phase: "seed", entry: entry.id, skip: "already-done-on-resume" });
        continue;
      }
      let rec;
      try {
        rec = await seedOneRun({ mods, productDist, root, entry, origin, baselineFile, reservedRuns, paths, secret, boundaries });
      } catch (err) {
        // Preserve partial seed: terminalize any live run through a REAL
        // product function and record the failure; never leave an
        // accidentally runnable leftover.  Do not abort the whole corpus.
        journal(root, {
          phase: "seed",
          entry: entry.id,
          error: String(err?.stack ?? err),
          fallback: "force-fail-and-continue",
        });
        rec = await fallbackTerminalizeRun({ mods, root, entry, err });
        failures.push({ entryId: entry.id, workflowId: entry.workflowId, error: String(err?.message ?? err), fallbackRunId: rec.runId ?? null });
      }
      seededRuns.push({ entryId: entry.id, runId: rec.runId, disposition: entry.disposition, ok: rec.ok });
      cumulative.done.add(entry.id);
      cumulative.runs.push({ entryId: entry.id, runId: rec.runId, disposition: entry.disposition });
      saveCumulative(root, cumulative);
      phaseReceipt(root, "seed-runs", { entry: entry.id, ...rec });
      journal(root, { phase: "seed", entry: entry.id, runId: rec.runId, disposition: entry.disposition, ok: rec.ok });
    }
    if (failures.length > 0 && seededRuns.length === 0) {
      throw new Error(`phaseSeed: all ${failures.length} plan entries failed; no runs seeded`);
    }
    manifest.seed_failures = failures;
  } finally {
    await stopBoundaries(boundaries);
  }

  // Final read-only census of the seeded state (receipt).
  const { runDbCensus, eventStreamCensus, worktreeCensus, writeCensusReceipt } = await import("./census.mjs");
  const census = {
    db: runDbCensus(mods.db.getDb()),
    events: eventStreamCensus(paths.stateDir),
    worktrees: worktreeCensus({ db: mods.db.getDb(), worktreesRoot: paths.worktreesRoot }),
  };
  writeCensusReceipt(root, `seed-${manifest.seed_kind}`, census);
  manifest.counts = census.db;
  manifest.disposition_counts = tallyDispositions(plan.entries, cumulative);
  save(manifest, root);
  return { ok: true, seededRuns, census, cumulativeCount: cumulative.runs.length, failures: manifest.seed_failures ?? [] };
}

// If a run was created but not terminalized before its driver error, send it
// through the REAL forceFailRun so no live row is left behind.
async function fallbackTerminalizeRun({ mods, root, entry, err }) {
  const db = mods.db.getDb();
  const row = db
    .prepare("SELECT id FROM runs WHERE workflow_id = ? AND task LIKE ? ORDER BY created_at DESC LIMIT 1")
    .get(entry.workflowId, `aged-state seed-fixture ${entry.id}%`);
  if (row) {
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(row.id);
    if (run && run.status === "running") {
      try {
        const { failRunViaRealForceFail } = await import("./seedlib.mjs");
        await failRunViaRealForceFail({
          mods,
          runId: row.id,
          reason: `aged-seed-fixture: driver error during ${entry.disposition} (${String(err?.message ?? err)}); genuine force-fail fallback to keep the corpus terminal`,
        });
        return { runId: row.id, disposition: entry.disposition, ok: false, fallback: "force-fail-after-driver-error" };
      } catch (f) {
        journal(root, { phase: "seed", entry: entry.id, fallbackForceFailError: String(f) });
      }
    }
    return { runId: row.id, disposition: entry.disposition, ok: false, fallback: "run-already-terminal-on-error" };
  }
  return { runId: null, disposition: entry.disposition, ok: false, fallback: "no-run-created" };
}

export async function phaseVolume(root, countArg) {
  // Volume-only synthetic event phase (real emitEvent; explicit synthetic
  // non-lifecycle event name; never forges lifecycle records).
  const manifest = loadManifest(root);
  assertRootIdentity(root, manifest);
  const paths = recordsContainedPaths(root);
  const { resolveProductDist } = await import("./product.mjs");
  const productDist = resolveProductDist().dist;
  const { loadProduct, startBoundaries, stopBoundaries } = await import("./seedlib.mjs");
  const mods = await loadProduct(productDist);
  const { writeDaemonSecret } = await import("./env.mjs");
  const { secretPath } = writeDaemonSecret(paths.homeDir);
  const secret = fs.readFileSync(secretPath, "utf-8").trim();
  const boundaries = await startBoundaries({
    productDist,
    secret,
    homeDir: paths.homeDir,
    controlPort: Number(process.env.TAMANDUA_CONTROL_PORT),
  });
  try {
    const db = mods.db.getDb();
    const target = countArg ? Number(countArg) : 0;
    const runs = db.prepare("SELECT id, workflow_id FROM runs WHERE status IN ('completed','failed','canceled') ORDER BY created_at LIMIT ?").all(target > 0 ? 50 : 1);
    if (runs.length === 0) throw new Error("phaseVolume: no terminal runs to bind volume records to");
    const { emitVolumeEvents } = await import("./volume.mjs");
    const per = Math.max(1, Math.ceil(target / runs.length));
    let emitted = 0;
    let seq = 1;
    const receipts = [];
    for (const run of runs) {
      const n = Math.min(per, target - emitted);
      if (n <= 0) break;
      const rec = emitVolumeEvents({ events: mods.events, runId: run.id, workflowId: run.workflow_id, count: n, sequenceStart: seq });
      seq += n;
      emitted += n;
      receipts.push({ runId: run.id, ...rec });
    }
    const { writeCensusReceipt, eventStreamCensus } = await import("./census.mjs");
    writeCensusReceipt(root, "volume", { emitted, receipts, events: eventStreamCensus(paths.stateDir) });
    return { ok: true, emitted, receipts };
  } finally {
    await stopBoundaries(boundaries);
  }
}

export async function phaseCensusSnapshot(root) {
  // Read-only census + immutable snapshots + reserved-key sidecar.
  const manifest = loadManifest(root);
  assertRootIdentity(root, manifest);
  const paths = recordsContainedPaths(root);
  const { resolveProductDist } = await import("./product.mjs");
  const productDist = resolveProductDist().dist;
  const { loadProduct } = await import("./seedlib.mjs");
  const mods = await loadProduct(productDist);
  const db = mods.db.getDb();
  const { runDbCensus, eventStreamCensus, worktreeCensus, writeCensusReceipt, gitRefCensus, postCensusReceiptTag } = await import("./census.mjs");
  // The DB/event snapshot tag stays fixed ("<kind>-post") so the event-stream
  // copy dir is refreshed in place and DB snapshots keep the clean
  // db-<kind>-post-<stamp> name.  The census RECEIPT tag is timestamped
  // separately: the census-snapshot phase may run more than once (e.g. again
  // after the separate volume phase added events), and each run must persist a
  // FRESH receipt reflecting the current state.  A fixed receipt tag would be
  // frozen by writeExclusive's first-write-wins semantics and silently drop the
  // post-volume census (>=500000 events).
  const tag = `${manifest.seed_kind}-post`;
  const receiptTag = postCensusReceiptTag(manifest.seed_kind, new Date().toISOString().replace(/[:.]/g, "-"));
  const censusReceipt = writeCensusReceipt(root, receiptTag, {
    db: runDbCensus(db),
    events: eventStreamCensus(paths.stateDir),
    worktrees: worktreeCensus({ db, worktreesRoot: paths.worktreesRoot }),
    refs: manifest.origin ? gitRefCensus(manifest.origin.path) : null,
  });
  const { createImmutableDbSnapshot, snapshotEventStreams, writeReservedBaselineSidecar, computeReservedMutations } = await import("./snapshot.mjs");
  const evidenceDir = path.join(root, "evidence");
  const dbSnap = createImmutableDbSnapshot({ stateDir: paths.stateDir, destDir: evidenceDir, tag });
  const evSnap = snapshotEventStreams({ stateDir: paths.stateDir, destDir: evidenceDir, tag });
  // Reserved-key baseline: the durable per-run typed capture was recorded at
  // run-creation time (evidence/o12-reserved-baseline.jsonl).  Aggregate it
  // into the host-owned v2 sidecar `expected` map (complete typed
  // presence/absence for every reserved key of every tracked run) and derive
  // the legitimate host-mutation ledger from the FINAL context stored in the
  // immutable DB snapshot just created (source: host).  Scope is
  // all-snapshot-runs only when every snapshot run carries a complete typed
  // creation-time baseline; otherwise an explicit tracked-run admission is
  // declared so O12 reports out-of-admission runs instead of failing coverage.
  const baselineJsonl = path.join(evidenceDir, "o12-reserved-baseline.jsonl");
  const expectedByRun = {};
  let trackedComplete = true;
  if (fs.existsSync(baselineJsonl)) {
    for (const line of fs.readFileSync(baselineJsonl, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const reserved = rec.reserved ?? {};
        const complete =
          typeof rec.reserved_key_count === "number" &&
          rec.reserved_key_count === RESERVED_CONTEXT_KEYS.length &&
          Object.keys(reserved).length === rec.reserved_key_count &&
          Object.values(reserved).every((v) => v && typeof v.presence === "string" && v.provenance === "host");
        if (!complete) trackedComplete = false;
        expectedByRun[rec.run_id] = reserved;
      } catch {
        trackedComplete = false;
      }
    }
  }
  const snapshotRuns = (() => {
    const snapDb = new DatabaseSync(dbSnap.file, { readOnly: true });
    try {
      return snapDb.prepare("SELECT id FROM runs").all().map((r) => r.id);
    } finally {
      snapDb.close();
    }
  })();
  const trackedIds = Object.keys(expectedByRun);
  const allTracked = snapshotRuns.every((id) => expectedByRun[id]);
  const scopeMode = trackedComplete && allTracked && trackedIds.length === snapshotRuns.length
    ? "all-snapshot-runs"
    : "explicit";
  // ROOT-VALIDATION-NOTICE (2026-09-09T20:38:14Z): allowed reserved-key
  // transitions are derived from the independently RECORDED planned native API
  // operations (the immutable steps table — the exact outputs the driver
  // submitted through real completeStep, in pipeline order) and the product's
  // known TEST_CMD normalization semantics, then VERIFIED against the final
  // snapshot.  computeReservedMutations returns { mutations, coverage } where
  // coverage.unverified lists final-context differences NOT explained by any
  // recorded operation — those are surfaced (never blessed) so O12 reports
  // them as overwrites instead of the producer forgiving drift.
  const { mutations, coverage } = computeReservedMutations({ snapshotFile: dbSnap.file, expectedByRun });
  const expectedMutations = mutations;
  const derivation = {
    method: "recorded-native-step-operations",
    semantics: "completed step output with TEST_CMD marker establishes context.test_cmd_raw on first write (native TEST_CMD machinery); differing markers set review flags without overwriting; no other reserved key is written by step output",
    source: "immutable steps table (real completeStep submissions) + creation-time typed baseline",
    verification: "each predicted transition is readback-verified against the final snapshot; unverified final differences are NOT blessed (O12 overwrite)",
    coverage: {
      runs_with_unverified_differences: Object.keys(coverage).filter((id) => Object.keys(coverage[id]?.unverified ?? {}).length > 0).length,
      unverified_sample: Object.entries(coverage)
        .filter(([, c]) => Object.keys(c?.unverified ?? {}).length > 0)
        .slice(0, 5)
        .map(([id, c]) => ({ run_id: id, keys: Object.keys(c.unverified) })),
    },
  };
  const sidecar = writeReservedBaselineSidecar({
    destDir: evidenceDir,
    expected: expectedByRun,
    expectedMutations,
    scopeMode,
    scopeRunIds: scopeMode === "explicit" ? trackedIds : null,
    derivation,
  });
  manifest.snapshot = {
    db: dbSnap,
    events: evSnap,
    reservedBaselineSidecar: sidecar,
    censusReceipt,
    refs: manifest.origin ? gitRefCensus(manifest.origin.path) : null,
  };
  save(manifest, root);
  phaseReceipt(root, "census-snapshot", { db: dbSnap, sidecar, ts_utc: utcNow() });
  return { ok: true, dbSnap, evSnap, sidecar };
}

export async function phaseValidate(root) {
  const manifest = loadManifest(root);
  assertRootIdentity(root, manifest);
  const paths = recordsContainedPaths(root);
  const { resolveProductDist } = await import("./product.mjs");
  const productDist = resolveProductDist().dist;
  const { loadProduct } = await import("./seedlib.mjs");
  const mods = await loadProduct(productDist);
  const db = mods.db.getDb();

  const { buildValidationMatrix, writeValidationReport, runO12Validation, materializePinnedOracle, O12_PINNED_CONTENT_SHA256, O12_PINNED_PROVENANCE_COMMIT, O12_PINNED_PROVENANCE_SUBJECT, O12_PINNED_ACCEPTANCE, O12_PINNED_ACCEPTANCE_DETAIL, O12_PIN_IDENTITY, O12_PINNED_COMMIT, O12_PINNED_TREE, O12_PINNED_SUBJECT, listPriorO12Runs } = await import("./validate.mjs");
  const zeroTokenEvidence = {
    transportReceipts: path.join(root, "receipts"),
    runsTokensTotal: db.prepare("SELECT COALESCE(SUM(tokens_spent),0) AS c FROM runs").get().c,
    systemTokensTotal: db.prepare("SELECT COALESCE(SUM(system_tokens_spent),0) AS c FROM tamandua_stats").get().c,
    noDispatchBoundary: "non-dispatching transport double; no scheduler timers; no harness spawns (see transport receipts + journal)",
  };
  const matrix = buildValidationMatrix({ db, stateDir: paths.stateDir, worktreesRoot: paths.worktreesRoot, zeroTokenEvidence });

  // O12 leg: needs the immutable DB snapshot + baseline sidecar.
  const evidenceDir = path.join(root, "evidence");
  const snapDir = evidenceDir;
  const snapFile = manifest.snapshot?.db?.file ?? findLatestDbSnapshot(snapDir);
  const baselineFile = manifest.snapshot?.reservedBaselineSidecar?.file
    ?? path.join(evidenceDir, "o12-reserved-baseline.json");

  // Prior O12 runs (older oracle evidence + import dirs) are read-only listed
  // BEFORE this run so the report can label superseded-pin legs provisional
  // instead of silently replacing them.
  const priorO12Runs = listPriorO12Runs({ seedRoot: root, evidenceDir, currentPin: O12_PINNED_CONTENT_SHA256 });

  let o12Evidence = null;
  if (snapFile && fs.existsSync(baselineFile)) {
    try {
      // The import dir is named from the durable CONTENT-pin identity (never a
      // commit): a future squash rewrites commit hashes but not oracle bytes.
      const importDest = path.join(root, "evidence", "imports", `o12-${O12_PIN_IDENTITY}`);
      if (!fs.existsSync(path.join(importDest, "torture-test", "oracles", "O12"))) {
        materializePinnedOracle({ gitRepo: REPO_ROOT, destDir: importDest, contentSha256: O12_PINNED_CONTENT_SHA256 });
      }
      o12Evidence = await runO12Validation({
        seedRoot: root,
        evidenceDir: path.join(evidenceDir, "o12"),
        importedOracleDir: importDest,
        snapshot: snapFile,
        baselineFile,
      });
    } catch (err) {
      o12Evidence = { oracle: "O12", error: String(err), ts_utc: utcNow() };
    }
  } else {
    o12Evidence = {
      oracle: "O12",
      error: "database_snapshot or reserved-key baseline sidecar missing; O12 NOT_EVALUABLE",
      ts_utc: utcNow(),
      snapFile,
      baselineExists: fs.existsSync(baselineFile),
    };
  }

  const o12Row = {
    oracle: "O12",
    leg: "db-integrity",
    semantics: "post-batch DB-integrity oracle over immutable snapshot + host-owned complete typed reserved-key baseline (v2)",
    execution_kind: "real-oracle-execution", // the actual pinned O12 executable is run
    full_oracle_status: o12Evidence?.stdoutJson?.result ?? (o12Evidence?.error ? "NOT_EVALUABLE" : "ERROR"),
    status: o12Evidence?.stdoutJson?.result ?? (o12Evidence?.error ? "NOT_EVALUABLE" : "ERROR"),
    findings: o12Evidence?.stdoutJson?.findings ?? [],
    // Durable content-addressed pin (survives merge-worktree squashes).
    pinnedContentSha256: O12_PINNED_CONTENT_SHA256,
    pinnedProvenanceCommit: O12_PINNED_PROVENANCE_COMMIT,
    pinnedProvenanceSubject: O12_PINNED_PROVENANCE_SUBJECT,
    // Legacy commit fields kept as provenance text only (never compared).
    pinnedCommit: O12_PINNED_COMMIT,
    pinnedTree: O12_PINNED_TREE,
    pinnedSubject: O12_PINNED_SUBJECT,
    acceptance: O12_PINNED_ACCEPTANCE,
    acceptanceDetail: O12_PINNED_ACCEPTANCE_DETAIL,
    priorRunsProvisional: priorO12Runs,
    evidence: o12Evidence,
  };
  matrix.rows.push(o12Row);

  const reportFile = writeValidationReport({ seedRoot: root, matrix, o12Evidence, priorO12: priorO12Runs });

  // Honest red classification ledger (STORM-AGED-FULL US-006): derive it from
  // the real report + real O12 evidence that were just written and persist it
  // next to the report.  The pair breakdown is re-derived read-only from the
  // immutable snapshot (never fabricated).  A validator (SUITE) defect is fixed
  // in torture-test/**; a product (NATIVE) red is recorded, never relabeled.
  const { writeValidationClassification, findLatestO12DbIntegrity } = await import("./validate.mjs");
  const { readPairMismatchBreakdown } = await import("../oracles/self-test/o12-seed-snapshot.mjs");
  const reportObject = JSON.parse(fs.readFileSync(reportFile, "utf-8"));
  const dbIntegrityFile = o12Evidence?.evidenceDir
    ? path.join(o12Evidence.evidenceDir, "o12-db-integrity.json")
    : findLatestO12DbIntegrity(root);
  const o12DbIntegrity = dbIntegrityFile && fs.existsSync(dbIntegrityFile)
    ? JSON.parse(fs.readFileSync(dbIntegrityFile, "utf-8"))
    : null;
  let pairBreakdown = null;
  try {
    if (snapFile && fs.existsSync(snapFile)) pairBreakdown = readPairMismatchBreakdown(snapFile);
  } catch {
    pairBreakdown = null;
  }
  const classificationResult = writeValidationClassification({
    seedRoot: root,
    report: reportObject,
    dbIntegrity: o12DbIntegrity,
    pairBreakdown,
  });

  manifest.validation = {
    matrix: matrix.rows,
    o12Evidence,
    reportFile,
    classificationFile: classificationResult.file,
    o12DbIntegrityFile: dbIntegrityFile ?? null,
    o12FailingLegs: classificationResult.classification.o12_failing_legs,
    classificationTally: classificationResult.classification.matrix_tally,
    o12PinnedContentSha256: O12_PINNED_CONTENT_SHA256,
    o12PinnedProvenanceCommit: O12_PINNED_PROVENANCE_COMMIT,
    o12PinnedProvenanceSubject: O12_PINNED_PROVENANCE_SUBJECT,
    o12PinnedCommit: O12_PINNED_COMMIT,
    o12Acceptance: O12_PINNED_ACCEPTANCE,
    o12AcceptanceDetail: O12_PINNED_ACCEPTANCE_DETAIL,
    priorO12Runs,
  };
  save(manifest, root);
  return { ok: true, matrix: matrix.rows, o12: o12Evidence, reportFile, priorO12Runs };
}

function findLatestDbSnapshot(evidenceDir) {
  if (!fs.existsSync(evidenceDir)) return null;
  const files = fs.readdirSync(evidenceDir).filter((f) => f.startsWith("db-") && f.endsWith(".sqlite"));
  if (files.length === 0) return null;
  files.sort();
  return path.join(evidenceDir, files[files.length - 1]);
}

function loadCumulative(root) {
  const file = path.join(root, "state", "cumulative.json");
  if (fs.existsSync(file)) {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { done: new Set(data.done ?? []), runs: data.runs ?? [] };
  }
  return { done: new Set(), runs: [] };
}

function saveCumulative(root, cumulative) {
  const file = path.join(root, "state", "cumulative.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ done: [...cumulative.done], runs: cumulative.runs }, null, 2) + "\n", "utf-8");
}

function tallyDispositions(planEntries, cumulative) {
  const counts = {};
  for (const r of cumulative.runs) {
    counts[r.disposition] = (counts[r.disposition] ?? 0) + 1;
  }
  return counts;
}

// ── Plan builders (pure; importable without side effects) ──────────────
// buildPlan / pilotEntries / fullEntries / WORKTREE_WORKFLOWS /
// NON_WORKTREE_TWIN live in plan.mjs so the self-test can exercise plan
// shape deterministically (phases.mjs hosts the phase dispatcher and must
// not run on import).

// ── Single-run seeder ───────────────────────────────────────────────────

import {
  createRunThroughRealApi,
  driveLinearRunToCompletion,
  recordReservedBaseline,
  LINEAR_COMPLETABLE,
} from "./seedlib.mjs";

async function seedOneRun({ mods, productDist, root, entry, origin, baselineFile, reservedRuns, paths, secret, boundaries }) {
  const { workflowId, disposition } = entry;
  const taskTitle = `aged-state seed-fixture ${entry.id}: ${workflowId} — synthetic corpus task text (not a real model task)`;
  const created = await createRunThroughRealApi({
    mods,
    workflowId,
    taskTitle,
    harnessDir: origin.checkout,
    originRepository: origin.checkout,
    originRef: origin.mainRef,
  });
  const runId = created.result.runId;
  journal(root, { phase: "seed", entry: entry.id, runId, workflowId, created: "runWorkflow-ok", runNumber: created.result.runNumber });

  // Host-owned reserved-key baseline at creation (O12 R4 leg).
  const baselineRec = recordReservedBaseline({ baselineFile, runId, context: created.context });
  reservedRuns[runId] = baselineRec.reserved;

  // Drive to the requested disposition through REAL product functions.
  let outcome;
  if (disposition === "completed") {
    if (!LINEAR_COMPLETABLE.has(workflowId)) {
      throw new Error(`seedOneRun: ${workflowId} is not linear-completable; do not force completed`);
    }
    outcome = driveLinearRunToCompletion({ mods, runId, workflowId, seq: entry.id, journal: (r) => journal(root, r) });
  } else if (disposition === "canceled") {
    const { cancelRunViaRealStop } = await import("./seedlib.mjs");
    outcome = await cancelRunViaRealStop({ mods, runId, source: "aged-seed-fixture" });
  } else if (disposition === "failed-force") {
    const { failRunViaRealForceFail } = await import("./seedlib.mjs");
    outcome = await failRunViaRealForceFail({
      mods,
      runId,
      reason: "aged-seed-fixture: forced-failure disposition for synthetic corpus (seed-fixture data; not a real model claim)",
    });
  } else if (disposition === "failed-exhaust") {
    const { failRunViaStepExhaustion } = await import("./seedlib.mjs");
    try {
      // failRunViaStepExhaustion is ASYNC (it awaits every real failStep and
      // asserts the retry budget); it MUST be awaited here or it runs detached
      // from the phase and the process can exit before the final exhaustion
      // lands (observed: probe run left running with the step at retry_count
      // == max_retries).
      outcome = await failRunViaStepExhaustion({ mods, runId, journal: (r) => journal(root, r) });
    } catch (err) {
      // Some workflows reroute rather than fail on exhaustion; fall back to a
      // genuine force-fail and record the fallback.
      journal(root, { phase: "seed", entry: entry.id, runId, exhausted: "fallback-force", error: String(err) });
      const { failRunViaRealForceFail } = await import("./seedlib.mjs");
      outcome = await failRunViaRealForceFail({
        mods,
        runId,
        reason: `aged-seed-fixture: step-exhaustion rerouted rather than failed (${err.message}); genuine force-fail fallback`,
      });
      outcome.fallback = "force-fail-after-exhaustion";
    }
  } else if (disposition === "paused") {
    const r = await boundaries.facade.pauseRun(runId, "aged-seed");
    if (!r || r.status < 200 || r.status >= 300 || r.body.state !== "paused") {
      throw new Error(`seedOneRun: real pause handler did not pause ${runId}: ${JSON.stringify(r)}`);
    }
    outcome = { realControlPause: r.body };
  } else if (disposition === "resumed-canceled") {
    // pause via the real handler, resume via the real handler, then real stop.
    const p = await boundaries.facade.pauseRun(runId, "aged-seed");
    if (!p || p.status < 200 || p.status >= 300) {
      throw new Error(`seedOneRun: real pause failed for ${runId}`);
    }
    const resumed = await boundaries.facade.resumeRun(runId, "aged-seed");
    if (!resumed || resumed.status < 200 || resumed.status >= 300) {
      throw new Error(`seedOneRun: real resume failed for ${runId}: ${JSON.stringify(resumed)}`);
    }
    const { cancelRunViaRealStop } = await import("./seedlib.mjs");
    outcome = await cancelRunViaRealStop({ mods, runId, source: "aged-seed-fixture-resumed" });
    outcome.realResume = resumed.body;
  } else {
    throw new Error(`seedOneRun: unknown disposition ${disposition}`);
  }

  return { runId, disposition, ok: true, runNumber: created.result.runNumber, outcome: summarizeOutcome(outcome) };
}

function summarizeOutcome(outcome) {
  if (!outcome) return null;
  const s = {};
  for (const key of ["finalStatus", "scope", "ok", "realResume", "fallback"]) {
    if (outcome[key] !== undefined) s[key] = outcome[key];
  }
  return s;
}

function save(manifest, root) {
  const { writeFileSync } = fs;
  writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}


// ── Phase dispatch (node phases.mjs <phase> --root <root> [opts]) ───────

async function dispatch(argv) {
  const phase = argv[2];
  if (!phase) {
    process.stderr.write("usage: node phases.mjs <phase> --root <seed-root> [--count N] [--plan FILE] [--origin REPO]\n");
    return 2;
  }
  const argOf = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? null : argv[i + 1] ?? null;
  };
  const root = argOf("--root");
  if (!root) {
    process.stderr.write("phases: --root <seed-root> is required\n");
    return 2;
  }
  let result;
  if (phase === "catalog") {
    result = await phaseCatalog(path.resolve(root));
  } else if (phase === "seed") {
    const planFile = argOf("--plan");
    const originArg = argOf("--origin");
    if (originArg) process.env.TT_POLY_ORIGIN = originArg;
    result = await phaseSeed(path.resolve(root), planFile);
  } else if (phase === "volume") {
    result = await phaseVolume(path.resolve(root), argOf("--count"));
  } else if (phase === "census-snapshot") {
    result = await phaseCensusSnapshot(path.resolve(root));
  } else if (phase === "validate") {
    result = await phaseValidate(path.resolve(root));
  } else {
    process.stderr.write(`phases: unknown phase "${phase}"\n`);
    return 2;
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  return 0;
}

dispatch(process.argv)
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`phases: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
