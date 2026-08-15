// E3.A US-014 — Final acceptance: bare tier1 GREEN x2, hygiene canary
// unchanged, no leaks.
//
// This test pins the acceptance-battery invariants that are cheap to check
// mechanically on every run (read-only + one --validate-only pass; NO
// campaign machinery):
//   * the branch diff is confined to the intended authoring files —
//     tier1.jsonl, case.schema.json, tier1 task .md files, the traceability
//     doc, bin/tt-fixture-provision.mjs, self-tests, and (since E3.C) the
//     controller/probe/oracle machinery: bin/tt-controller,
//     bin/tt-controller.test.sh, bin/tt-chaos (+ self-test), bin/oracle-*.mjs,
//     oracles/ (E3.C adds the O16 lifecycle oracle and O4 executable) — and
//     never touches probes/, seeds/, or bin/tt-hygiene-canary.mjs;
//   * bin/tt-hygiene-canary.mjs is byte-identical to the merge-base version
//     (the canary itself must remain untouched so its campaign snapshots stay
//     trustworthy);
//   * the authoring-layer end state is pinned: every real case carries a
//     non-empty context.test_cmd; the bug-fix cases carry their real seeds
//     (BUG-P1/BUG-T1/BUG-P2/BUG-T2/BUG-T3) and W2.22 stays unseeded (its
//     master-trap premise requires no seed checkout); W1.X1 keeps its
//     hostile-path fixture alias (space + non-ASCII);
//   * the manifest still validates through the PRODUCTION controller
//     --validate-only path (28 cases).
//
// The campaign-side halves of the acceptance battery (bare --tier1 GREEN
// twice, zero tokens, hygiene canary UNCHANGED in the campaign report,
// scripted daemon STOPPED, ports 5334/5338/5339 free, git status clean) are
// exercised by tier1-repeatability.test.ts in the heavy battery
// (bin/verify-heavy-campaign-tests.test.sh) — keeping this file fast enough
// to stay in self-tests/run.sh.
//
// Confined to torture-test/. Zero tokens.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const controller = path.join(ttRoot, "bin", "tt-controller");
const hygieneCanary = path.join(ttRoot, "bin", "tt-hygiene-canary.mjs");

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function branchBase(): string {
  // The E3.A branch was cut from main; resolve the merge-base at runtime so
  // the pins survive future main advancement (and after merge, when the base
  // becomes HEAD itself and the diff is trivially empty/confined).
  const result = git(["merge-base", "HEAD", "main"]);
  if (result.status !== 0 || !result.stdout.trim()) {
    const origin = git(["merge-base", "HEAD", "origin/main"]);
    if (origin.status === 0 && origin.stdout.trim()) return origin.stdout.trim();
    throw new Error(`cannot resolve branch base: ${result.stderr || "main and origin/main both unavailable"}`);
  }
  return result.stdout.trim();
}

function changedFiles(): string[] {
  const base = branchBase();
  const result = git(["diff", "--name-only", `${base}...HEAD`]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
}

function manifestRecords(): Array<Record<string, any>> {
  return fs
    .readFileSync(manifest, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

describe("E3.A US-014 — final acceptance battery pins", () => {
  it("branch diff is confined to the intended authoring files", () => {
    // E3.C extends the E3.A authoring surface with the controller/probe/oracle
    // machinery (probe sequencer, chaos wiring, O16/O4 oracles) — all still
    // confined to torture-test/. The oracle-machinery bin test files
    // (bin/oracle-*.mjs, bin/tt-oracle-replay*, bin/o9-mechanical-harvest.*,
    // bin/o11-production-evidence.*) are part of that surface: they consume
    // oracle-context / oracle-evidence-snapshot, whose version-1 evidence key
    // set and gating registry E3.C extends. bin/tt-chaos (+ its self-test) is
    // the chaos operator the controller's chaos wiring (E3.C US-008) invokes;
    // US-004 adds its sigstop_sigcont action here. US-011 registers the
    // zero-token scripted probe battery in the heavy-campaign lock-step lists
    // (self-tests/run.sh HEAVY_CAMPAIGN_TESTS +
    // bin/verify-heavy-campaign-tests.test.sh + e2e-golden-integrity), so the
    // isolated heavy-test invocation script joins the authoring surface.
    const allowed = [
      "torture-test/cases/tier1.jsonl",
      "torture-test/cases/case.schema.json",
      "torture-test/cases/tier1-traceability.md",
      "torture-test/cases/tasks/tier1/",
      "torture-test/bin/tt-fixture-provision.mjs",
      "torture-test/bin/tt-controller",
      "torture-test/bin/tt-controller.test.sh",
      "torture-test/bin/tt-chaos",
      "torture-test/bin/tt-chaos.test.sh",
      "torture-test/bin/verify-heavy-campaign-tests.test.sh",
      "torture-test/bin/oracle-",
      "torture-test/bin/tt-oracle-replay",
      "torture-test/bin/o9-mechanical-harvest.integration.test.mjs",
      "torture-test/bin/o11-production-evidence.test.mjs",
      "torture-test/oracles/",
      "torture-test/self-tests/",
    ];
    const forbidden = [
      "torture-test/bin/tt-hygiene-canary.mjs",
      "torture-test/probes/",
      "torture-test/seeds/",
    ];
    const files = changedFiles();
    const violations: string[] = [];
    for (const file of files) {
      if (!allowed.some((prefix) => file === prefix || file.startsWith(prefix))) {
        violations.push(`${file}: outside the intended authoring set`);
      }
      const hit = forbidden.find((prefix) => file === prefix || file.startsWith(prefix));
      if (hit) violations.push(`${file}: FORBIDDEN (touches ${hit})`);
    }
    assert.deepEqual(violations, [], `diff confinement violations:\n${violations.join("\n")}`);
  });

  it("bin/tt-hygiene-canary.mjs is byte-identical to the merge-base version", () => {
    const base = branchBase();
    const result = git(["show", `${base}:torture-test/bin/tt-hygiene-canary.mjs`]);
    assert.equal(result.status, 0, `cannot read base canary: ${result.stderr}`);
    assert.equal(sha256(fs.readFileSync(hygieneCanary)), sha256(Buffer.from(result.stdout, "utf8")),
      "tt-hygiene-canary.mjs drifted from the merge-base version — the canary must remain untouched");
  });

  it("every real tier1 case carries a non-empty context.test_cmd", () => {
    const records = manifestRecords();
    const realCases = records.filter((record) => record.context?.execution_mode === "real");
    assert.ok(realCases.length >= 20, `expected the real case population, got ${realCases.length}`);
    const missing: string[] = [];
    for (const record of realCases) {
      const testCmd = record.context?.test_cmd;
      if (typeof testCmd !== "string" || testCmd.trim() === "") missing.push(record.id);
    }
    assert.deepEqual(missing, [], "real cases missing context.test_cmd (S1 launchGateKey feed)");
  });

  it("bug-fix cases carry their real seeds and W2.22 stays unseeded", () => {
    const records = manifestRecords();
    const seeded: Record<string, string> = {
      "W1.L3-python": "BUG-P1",
      "W1.L3-ts": "BUG-T1",
      "W3.01-bfmw-pi-python": "BUG-P2",
      "W3.02-bfmw-pi-ts": "BUG-T2",
      "W3.03-bfmw-hermes-ts": "BUG-T3",
    };
    for (const [id, expectedSeed] of Object.entries(seeded)) {
      const record = records.find((r) => r.id === id);
      assert.ok(record, `missing manifest case ${id}`);
      assert.equal(record.seed, expectedSeed, `${id}: seed must be ${expectedSeed} (S2 arming)`);
    }
    const w222 = records.find((r) => r.id === "W2.22-non-main-bfmw");
    assert.ok(w222, "missing manifest case W2.22-non-main-bfmw");
    assert.equal(w222.seed, undefined,
      "W2.22 must stay unseeded — a seed checkout would replace the clone branch and break its master-trap premise");
  });

  it("W1.X1 keeps its hostile-path fixture alias with root-relative boundaries", () => {
    const records = manifestRecords();
    const w1x1 = records.find((r) => r.id === "W1.X1-ts");
    assert.ok(w1x1, "missing manifest case W1.X1-ts");
    assert.equal(w1x1.fixture, "tt-ts café", "W1.X1 fixture must be the reserved hostile-path alias");
    assert.ok(w1x1.fixture.includes(" ") && /[^\x00-\x7F]/.test(w1x1.fixture),
      "W1.X1 fixture must contain a space and a non-ASCII character");
    assert.deepEqual(w1x1.boundary_files, ["src"], "W1.X1 boundary_files must be work-clone-root-relative");
    assert.deepEqual(w1x1.forbidden, ["operator-notes.local"], "W1.X1 forbidden must be work-clone-root-relative");
  });

  it("tier1 manifest validates through the production controller (28 cases)", () => {
    const result = spawnSync(controller, ["--manifest", manifest, "--validate-only"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Validated 28 case\(s\)/);
  });
});
