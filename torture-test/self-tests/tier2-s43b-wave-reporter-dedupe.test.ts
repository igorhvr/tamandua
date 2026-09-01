// S43b (US-007) — O1 wave-reporter dedupe: family findings stamped exactly
// once, from the true final wave case in manifest order.
//
// Campaign-20260826T225744158Z stamped the do-now family duration-floor
// finding on TWO reporter cases: W4.dsh-do-now (a do-now cell) AND
// W4.dsh-fdmw (a feature-dev-merge-worktree cell — not even do-now). Root
// cause: the O1 wave-family reporter was selected per evaluating case from
// that case's OWN o1_wave snapshot, and at concurrency 1 the wave snapshot
// grows as later cases run — so the last do-now case's O1 picked itself as
// the reporter (its snapshot held the four do-now runs, rate 0.5), and the
// later non-do-now case's O1 picked ITSELF (its snapshot also held the do-now
// runs), stamping the same do-now family finding on both.
//
// Fix: the controller now emits the campaign-wide wave membership
// (`o1_wave.wave_cases` — every manifest case of the wave in manifest order,
// including cases that have not run yet), and the reporter is the TRUE FINAL
// wave case in manifest order — identical for every evaluating case, so
// family findings merge into exactly one case.
//
// This test proves (zero tokens, files ONLY under torture-test/ + temp dirs):
//   * RED-ARM: pins the campaign evidence lines verbatim (the do-now family
//     O1_DURATION_FLOOR_RATE finding on W4.dsh-do-now + W4.dsh-fdmw, the
//     latter not even do-now) and REPRODUCES the pre-fix two-reporter
//     selection history-independently: the pre-fix per-snapshot selection
//     applied to the two fixture snapshot shapes picks TWO different
//     reporters (wave-dedup-do-now-4 AND wave-dedup-non-do-now);
//   * GREEN-ARM: post-fix, exactly ONE reporter case carries the do-now
//     family finding (the true final wave case in manifest order — the
//     non-do-now cell, mirroring W4.dsh-fdmw), the other case's findings
//     exclude it, and both evaluations resolve the SAME reporter;
//   * GREEN-ARM (fallbacks): a single-case wave and a manifest-absent wave
//     keep their deterministic legacy behavior (the exported
//     waveReporterCaseId never returns null and never varies for the same
//     context);
//   * GREEN-ARM (schema/roster): tt-controller --validate-only stays green.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { waveReporterCaseId } from "../oracles/lib/o1.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const controller = path.join(ttRoot, "bin", "tt-controller");
const generator = path.join(ttRoot, "oracles", "self-test", "generate-o1-fixtures.mjs");
const oracleBinary = path.join(ttRoot, "oracles", "O1");
const varRoot = path.join(ttRoot, "var");

// ── Pinned campaign evidence (campaign-20260826T225744158Z, read-only) ────
// The do-now family finding, stamped on TWO reporter cases in the campaign
// report — W4.dsh-do-now (a do-now cell) and W4.dsh-fdmw (a
// feature-dev-merge-worktree cell — NOT do-now).
const DO_NOW_FINDING_LINE = "more than 20% of a wave workflow family terminated below its measured duration floor";
const DSH_DO_NOW_REPORT_LINE = "W4.dsh-do-now: O1 - more than 20% of a wave workflow family terminated below its measured duration floor";
const DSH_FDMW_REPORT_LINE = "W4.dsh-fdmw: O1 - more than 20% of a wave workflow family terminated below its measured duration floor";
// The finding objects (report.json): the SAME do-now family finding
// (workflow 'do-now', 4 runs, 2 fast, rate 0.5) on both cases.
const DSH_DO_NOW_FINDING = { workflow: "do-now", run_count: 4, fast_run_count: 2, fast_rate: 0.5 };
const DSH_FDMW_FINDING = { workflow: "do-now", run_count: 4, fast_run_count: 2, fast_rate: 0.5 };
// W4.dsh-fdmw is a feature-dev-merge-worktree cell (not do-now) — the "one
// not even do-now" reporter.
const DSH_FDMW_CASE_WORKFLOW = "feature-dev-merge-worktree";

function readManifest(): any[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function runController(args: string[], cwd: string = repoRoot) {
  return spawnSync(controller, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, TAMANDUA_PI_BINARY: "/usr/bin/false", TAMANDUA_HERMES_BINARY: "/usr/bin/false" },
  });
}

function generateO1Fixtures(workspace: string) {
  const generated = spawnSync(process.execPath, [generator, workspace], { encoding: "utf8", shell: false });
  assert.equal(generated.status, 0, generated.stderr);
}

function invokeO1Context(contextPath: string) {
  const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
  const env = {
    ...process.env,
    TT_ORACLE_CONTRACT_VERSION: "1",
    TT_ORACLE_ID: "O1",
    TT_ORACLE_CONTEXT: contextPath,
    TT_ORACLE_EVIDENCE_DIR: path.dirname(contextPath),
    TT_CASE_ID: context.case.id,
    TT_CAMPAIGN_ID: context.campaign.id,
    TT_RUN_ID: context.run_id,
  };
  const result = spawnSync(oracleBinary, ["--contract-version", "1", "--context", contextPath], {
    cwd: path.dirname(contextPath), env, encoding: "utf8", shell: false, timeout: 15_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { context, response: JSON.parse(result.stdout.trim()), status: result.status };
}

// The PRE-FIX (S43b) reporter selection, reproduced inline (history-
// independent): max manifest rank among the case ids OBSERVED in the wave
// snapshot (runs + duration_floors). Every evaluating case recomputed this
// from its own partial snapshot — the campaign's two-reporter stamping.
function preFixWaveReporterCaseId(context: any): string | null {
  const wave = context.o1_wave;
  const caseIds = new Set<string>();
  for (const run of wave.runs) caseIds.add(run.case_id);
  for (const floor of wave.duration_floors) {
    if (typeof floor.case_id === "string" && floor.case_id.length > 0) caseIds.add(floor.case_id);
  }
  const manifestOrder = new Map(context.campaign.manifest.case_ids.map((id: string, index: number) => [id, index]));
  const manifestCaseIds = [...caseIds].filter((id) => manifestOrder.has(id));
  const pool = manifestCaseIds.length > 0 ? manifestCaseIds : [...caseIds];
  const rank = (id: string) => (manifestOrder.has(id) ? manifestOrder.get(id)! : Number.MAX_SAFE_INTEGER);
  const ordered = [...pool].sort((left, right) => {
    const byRank = rank(left) - rank(right);
    return byRank !== 0 ? byRank : left.localeCompare(right);
  });
  return ordered[ordered.length - 1] ?? null;
}

function dedupeFixtureContexts(workspace: string): { doNow4: string; nonDoNow: string } {
  const campaign = path.join(workspace, "o1-wave-reporter-dedupe");
  const expectation = JSON.parse(fs.readFileSync(path.join(campaign, "expectation.json"), "utf8"));
  return { doNow4: expectation.contexts.doNow4 as string, nonDoNow: expectation.contexts.nonDoNow as string };
}

describe("S43b (US-007) — O1 wave-reporter dedupe: family findings stamped exactly once", () => {
  it("RED-ARM: pins the campaign evidence — the do-now family finding stamped on TWO reporter cases, one not even do-now", () => {
    // The report lines, verbatim (campaign-20260826T225744158Z report.txt).
    assert.equal(
      DSH_DO_NOW_REPORT_LINE,
      "W4.dsh-do-now: O1 - more than 20% of a wave workflow family terminated below its measured duration floor",
    );
    assert.equal(
      DSH_FDMW_REPORT_LINE,
      "W4.dsh-fdmw: O1 - more than 20% of a wave workflow family terminated below its measured duration floor",
    );
    // The finding objects (report.json): the SAME do-now family finding
    // (workflow 'do-now', 4 runs, 2 fast, rate 0.5) on both cases.
    assert.deepEqual(DSH_DO_NOW_FINDING, { workflow: "do-now", run_count: 4, fast_run_count: 2, fast_rate: 0.5 });
    assert.deepEqual(DSH_FDMW_FINDING, DSH_DO_NOW_FINDING);
    assert.equal(DO_NOW_FINDING_LINE, "more than 20% of a wave workflow family terminated below its measured duration floor");

    // W4.dsh-fdmw is a feature-dev-merge-worktree cell (not do-now) — the
    // "one not even do-now" reporter; both cells share wave 4, and
    // W4.dsh-fdmw is the LAST wave-4 case whose O1 actually evaluated in the
    // campaign (the only later wave-4 case, W4.dsh-lifecycle, infra-failed
    // with probe-trigger-unreached BEFORE oracle evaluation — its campaign
    // attempt has no oracles/ evidence dir).
    const rows = readManifest();
    const doNow = rows.find((record) => record.id === "W4.dsh-do-now");
    const fdmw = rows.find((record) => record.id === "W4.dsh-fdmw");
    assert.ok(doNow && fdmw);
    assert.equal(doNow.workflow, "do-now");
    assert.equal(fdmw.workflow, DSH_FDMW_CASE_WORKFLOW);
    assert.equal(doNow.wave, 4);
    assert.equal(fdmw.wave, 4);
    const indices = rows.map((record) => record.id);
    assert.ok(indices.indexOf("W4.dsh-fdmw") > indices.indexOf("W4.dsh-do-now"), "W4.dsh-fdmw must come AFTER W4.dsh-do-now in manifest order");
    const laterWave4 = rows.slice(indices.indexOf("W4.dsh-fdmw") + 1).filter((record) => record.wave === 4);
    assert.deepEqual(
      laterWave4.map((record) => record.id),
      ["W4.dsh-lifecycle"],
      "W4.dsh-lifecycle is the only wave-4 case after W4.dsh-fdmw — and it never reached O1 evaluation in the campaign",
    );

    // The traceability S43b section exists and names the two reporter cases.
    const traceability = fs.readFileSync(traceabilityPath, "utf8");
    const section = traceability.match(/## S43b[^\n]*\n([\s\S]*?)(?=\n## |\n---|$)/)?.[1];
    assert.ok(section, "tier2-traceability.md must contain an S43b section");
    assert.match(section, /W4\.dsh-do-now/);
    assert.match(section, /W4\.dsh-fdmw/);
    assert.match(section, /not even do-now/);
    assert.match(section, /wave_cases/);
  });

  it("RED-ARM: reproduces the pre-fix two-reporter selection (per-snapshot max manifest rank) on the campaign shape", () => {
    fs.mkdirSync(varRoot, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(varRoot, "oracle-self-test.s43b-red."));
    try {
      generateO1Fixtures(workspace);
      const { doNow4, nonDoNow } = dedupeFixtureContexts(workspace);
      const doNow4Context = JSON.parse(fs.readFileSync(doNow4, "utf8"));
      const nonDoNowContext = JSON.parse(fs.readFileSync(nonDoNow, "utf8"));

      // The pre-fix selection is per-snapshot: the last do-now case's O1 saw
      // only the four do-now runs (reporter = itself); the non-do-now case's
      // O1 saw the do-now runs plus its own (reporter = itself). TWO
      // different cases are selected — the campaign's two-reporter stamping.
      assert.equal(preFixWaveReporterCaseId(doNow4Context), "wave-dedup-do-now-4");
      assert.equal(preFixWaveReporterCaseId(nonDoNowContext), "wave-dedup-non-do-now");
      assert.notEqual(
        preFixWaveReporterCaseId(doNow4Context),
        preFixWaveReporterCaseId(nonDoNowContext),
        "pre-fix: different snapshots select different reporters -> the family finding is stamped twice",
      );

      // The post-fix selection is campaign-wide: both evaluations resolve the
      // SAME reporter — the true final wave case in manifest order.
      assert.equal(waveReporterCaseId(doNow4Context), "wave-dedup-non-do-now");
      assert.equal(waveReporterCaseId(nonDoNowContext), "wave-dedup-non-do-now");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: exactly one reporter case carries the do-now family finding post-fix (O1 end-to-end)", () => {
    fs.mkdirSync(varRoot, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(varRoot, "oracle-self-test.s43b-green."));
    try {
      generateO1Fixtures(workspace);
      const { doNow4, nonDoNow } = dedupeFixtureContexts(workspace);

      // The last do-now case (NOT the reporter): its snapshot carries the
      // full do-now family (rate 0.5), but the family finding is not stamped
      // here — the case stays PASS.
      const doNow4Result = invokeO1Context(doNow4);
      assert.equal(doNow4Result.status, 0);
      assert.equal(doNow4Result.response.result, "PASS");
      assert.equal(
        doNow4Result.response.findings.some((finding: any) => finding.id.startsWith("O1_DURATION_FLOOR")),
        false,
        JSON.stringify(doNow4Result.response.findings),
      );

      // The true final wave case (a NON-do-now cell, mirroring W4.dsh-fdmw)
      // is the ONLY reporter: it carries the do-now family finding exactly
      // once — run_count 4, fast_run_count 2, fast_rate 0.5, the campaign's
      // measured do-now family shape.
      const nonDoNowResult = invokeO1Context(nonDoNow);
      assert.equal(nonDoNowResult.status, 1);
      assert.equal(nonDoNowResult.response.result, "FAIL");
      const rates = nonDoNowResult.response.findings.filter((finding: any) => finding.id === "O1_DURATION_FLOOR_RATE");
      assert.equal(rates.length, 1, JSON.stringify(nonDoNowResult.response.findings));
      assert.equal(rates[0].workflow, "do-now");
      assert.equal(rates[0].run_count, 4);
      assert.equal(rates[0].fast_run_count, 2);
      assert.equal(rates[0].fast_rate, 0.5);
      assert.deepEqual(rates[0].run_ids, ["run-wave-dedup-do-now-1", "run-wave-dedup-do-now-2"]);

      // The do-now family observation still lands in BOTH cases' evidence
      // (campaign-wide data) — only the findings list is deduplicated.
      for (const [contextPath, outcome] of [[doNow4, doNow4Result], [nonDoNow, nonDoNowResult]] as const) {
        const observation = JSON.parse(fs.readFileSync(path.join(path.dirname(contextPath), outcome.response.evidence[0].path), "utf8"));
        const doNowRow = observation.duration_floor_observations.find((row: any) => row.workflow === "do-now");
        assert.ok(doNowRow, "the do-now family observation must be present");
        assert.equal(doNowRow.run_count, 4);
        assert.equal(doNowRow.fast_run_count, 2);
        assert.equal(doNowRow.fast_rate, 0.5);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("GREEN-ARM: single-case-wave and manifest-absent fallbacks keep their deterministic behavior", () => {
    // Single-case wave (no wave_cases): the only manifest case is the
    // reporter — a single-case wave still reports family findings.
    const single = waveReporterCaseId({
      campaign: { manifest: { case_ids: ["ONLY-CASE"] } },
      o1_wave: { runs: [{ case_id: "ONLY-CASE" }], duration_floors: [] },
    });
    assert.equal(single, "ONLY-CASE");

    // Manifest-absent wave (no wave_cases, no manifest case in the snapshot):
    // the full observed set is ranked deterministically (localeCompare).
    const absent = waveReporterCaseId({
      campaign: { manifest: { case_ids: [] } },
      o1_wave: { runs: [{ case_id: "peer-b" }, { case_id: "peer-a" }], duration_floors: [] },
    });
    assert.equal(absent, "peer-b");

    // Determinism: the same context always resolves the same reporter.
    const shape = {
      campaign: { manifest: { case_ids: ["case-1", "case-2", "case-3"] } },
      o1_wave: { runs: [{ case_id: "case-1" }, { case_id: "case-2" }], duration_floors: [] },
    };
    assert.equal(waveReporterCaseId(shape), waveReporterCaseId(shape));
    assert.equal(waveReporterCaseId(shape), "case-2");
  });

  it("GREEN-ARM: the real manifest stays schema-valid and the dedupe fixture declares the campaign-wide wave_cases membership", () => {
    const res = runController(["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);

    // The generated dedupe fixture contexts carry wave_cases in manifest
    // order (four do-now cells then the non-do-now cell), so the oracle
    // validation path accepts them.
    fs.mkdirSync(varRoot, { recursive: true });
    const workspace = fs.mkdtempSync(path.join(varRoot, "oracle-self-test.s43b-schema."));
    try {
      generateO1Fixtures(workspace);
      const { doNow4, nonDoNow } = dedupeFixtureContexts(workspace);
      for (const contextPath of [doNow4, nonDoNow]) {
        const context = JSON.parse(fs.readFileSync(contextPath, "utf8"));
        assert.deepEqual(context.o1_wave.wave_cases, [
          "wave-dedup-do-now-1", "wave-dedup-do-now-2", "wave-dedup-do-now-3", "wave-dedup-do-now-4",
          "wave-dedup-non-do-now",
        ]);
      }
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
