// MACP4 US-006 — W2 cells' requires narrowed: blanket `platform: linux` is
// gone, `daemon-scripted` capability gates the four tier1 W2 scripted cells.
//
// The four tier1 W2 scripted cells (W2.21-admission, W2.23a-expects-regex,
// W2.23b-retry-step, W2.23c-missing-persona) previously carried
//   requires: { platform: "linux", capabilities: ["node-sqlite"], node_min: 22 }
// — a blanket platform predicate that vacuously gated them NOT_RUN(predicate)
// on a fully-capable Darwin host (daemon-control's non-systemd plain-background
// fallback launch path + the MACP4-portable harness make the cells runnable on
// the mac). US-006 replaces it with the narrowest true requirement:
//   requires: { capabilities: ["node-sqlite", "daemon-scripted"], node_min: 22 }
// where `daemon-scripted` is a Boolean-leaf capability W0.0 computes on BOTH
// linux and darwin (true iff bash AND nohup AND node resolve via POSIX
// `command -v` PATH lookup — US-005). This file pins the narrowed predicate
// shape, the doc contract naming the capability, and that the other 24 tier1
// rows are untouched by the change (git-diff proof).
//
// This file contains no procfs references (pure doc/assertion prose about
// predicates — nothing platform-specific to guard).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const controller = path.join(ttRoot, "bin", "tt-controller");
const schema = path.join(ttRoot, "cases", "case.schema.json");
const spec = path.join(ttRoot, "tamandua-torture-test-spec", "01-environment-and-isolation.md");
const contract = path.join(ttRoot, "oracles", "CONTRACT.md");
const traceability = path.join(ttRoot, "cases", "tier1-traceability.md");

// The four tier1 W2 scripted cells whose predicate US-006 narrows.
const W2_CELLS = [
  "W2.21-admission",
  "W2.23a-expects-regex",
  "W2.23b-retry-step",
  "W2.23c-missing-persona",
];
const NARROWED_REQUIRES = { capabilities: ["node-sqlite", "daemon-scripted"], node_min: 22 };

function readManifest(): Array<Record<string, any>> {
  return fs
    .readFileSync(manifest, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function git(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function branchBase(): string {
  const result = git(["merge-base", "HEAD", "main"]);
  if (result.status !== 0 || !result.stdout.trim()) {
    const origin = git(["merge-base", "HEAD", "origin/main"]);
    if (origin.status === 0 && origin.stdout.trim()) return origin.stdout.trim();
    throw new Error(`cannot resolve branch base: ${result.stderr || "main and origin/main both unavailable"}`);
  }
  return result.stdout.trim();
}

// Every +/- line of the tier1.jsonl diff vs the branch base (working tree
// included, so the test is meaningful before AND after the US-006 commit).
function manifestDiffLines(): string[] {
  const base = branchBase();
  const result = git(["diff", base, "--", "torture-test/cases/tier1.jsonl"]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split(/\r?\n/)
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
}

describe("MACP4 US-006 — narrowed W2 predicate (daemon-scripted capability)", () => {
  it("AC1: the four W2 rows carry requires.capabilities [\"node-sqlite\",\"daemon-scripted\"] and NO platform key", () => {
    const records = readManifest();
    assert.equal(records.length, 28, "tier1 manifest must still hold 28 cases");
    for (const id of W2_CELLS) {
      const record = records.find((r) => r.id === id);
      assert.ok(record, `missing manifest case ${id}`);
      assert.equal(record.context?.execution_mode, "scripted", `${id} must stay a scripted cell`);
      assert.deepEqual(record.requires, NARROWED_REQUIRES,
        `${id}: requires must be ${JSON.stringify(NARROWED_REQUIRES)} (platform key dropped, daemon-scripted added)`);
      assert.ok(record.requires.capabilities.includes("daemon-scripted"),
        `${id}: requires.capabilities must include daemon-scripted`);
      assert.ok(record.requires.capabilities.includes("node-sqlite"),
        `${id}: node-sqlite requirement must be retained (no assertion weakened)`);
      assert.equal(record.requires.platform, undefined,
        `${id}: the blanket platform:linux predicate must be gone`);
    }
  });

  it("AC1: no tier1 row carries a blanket `platform` requires predicate (all 28 rows)", () => {
    const records = readManifest();
    const withPlatform = records.filter((r) => r.requires?.platform !== undefined);
    assert.deepEqual(withPlatform.map((r) => r.id), [],
      "no tier1 case may carry a blanket platform requires — platform gating belongs to genuinely linux-only assertion arms, not whole cells");
    const scripted = records.filter((r) => r.context?.execution_mode === "scripted");
    assert.equal(scripted.length, 4, "tier1 must still have exactly 4 scripted cells (the W2 cells)");
  });

  it("AC1 (git-diff proof): the tier1.jsonl change touches ONLY the four W2 rows — the other 24 rows are unchanged", () => {
    const lines = manifestDiffLines();
    const touched = new Set<string>();
    for (const line of lines) {
      const hit = W2_CELLS.find((id) => line.includes(`"id":"${id}"`));
      assert.ok(hit, `tier1.jsonl diff must not touch non-W2 rows — offending line: ${line.slice(0, 120)}`);
      touched.add(hit);
    }
    if (lines.length > 0) {
      assert.deepEqual([...touched].sort(), [...W2_CELLS].sort(),
        "the diff must rewrite exactly the four W2 rows (and only them)");
    }
  });

  it("AC2: the narrowed tier1 manifest still validates through tt-controller --validate-only (28 cases)", () => {
    const result = spawnSync(controller, ["--manifest", manifest, "--validate-only"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Validated 28 case\(s\)/);
  });

  it("AC3: the contract docs name the daemon-scripted Boolean-leaf capability (schema, spec 01, oracles/CONTRACT.md)", () => {
    const schemaText = fs.readFileSync(schema, "utf8");
    assert.match(schemaText, /daemon-scripted/, "case.schema.json must document the daemon-scripted capability");
    assert.match(schemaText, /Boolean leaf/i, "case.schema.json must describe daemon-scripted as a Boolean leaf");
    assert.match(schemaText, /BOTH linux AND darwin/i,
      "case.schema.json must state the capability is computed on both platforms");
    assert.match(schemaText, /fallback/i, "case.schema.json must tie daemon-scripted to the fallback launch prerequisites");

    const specText = fs.readFileSync(spec, "utf8");
    assert.match(specText, /daemon-scripted/, "spec 01 must document the daemon-scripted capability");
    assert.match(specText, /COMPUTED ON BOTH linux AND darwin/i,
      "spec 01 must state the capability is computed on both platforms");
    assert.match(specText, /capabilities\.<name> === true/,
      "spec 01 must state the Boolean-leaf satisfaction rule for non-harness capabilities");

    const contractText = fs.readFileSync(contract, "utf8");
    assert.match(contractText, /daemon-scripted/, "oracles/CONTRACT.md must document the daemon-scripted capability");
    assert.match(contractText, /COMPUTED ON BOTH linux/i,
      "oracles/CONTRACT.md must state the capability is computed on both platforms");
  });

  it("AC4: tier1-traceability.md carries the HOST-ADAPTATION note for the four W2 rows", () => {
    const trace = fs.readFileSync(traceability, "utf8");
    assert.match(trace, /HOST-ADAPTATION note \(MACP4 US-006\)/,
      "traceability must carry the MACP4 US-006 HOST-ADAPTATION note");
    for (const id of W2_CELLS) {
      assert.ok(trace.includes(id), `HOST-ADAPTATION note must name ${id}`);
    }
    assert.match(trace, /daemon-scripted/, "HOST-ADAPTATION note must name the daemon-scripted capability");
    assert.match(trace, /platform: linux/, "HOST-ADAPTATION note must record the dropped platform: linux predicate");
    assert.match(trace, /no assertion was weakened/i,
      "HOST-ADAPTATION note must state no assertion was weakened");
  });
});
