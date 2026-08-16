// Tier-2 US-010: section-F (weird-git target repos) roster.
//
// Pins the section-F batch of cases/tier2.jsonl:
//   * the 6 new rows exist (W4.26, W4.28, W4.30, W4.31, W4.45-gc-aggressive,
//     W4.45-branch-delete) and tt-controller --manifest cases/tier2.jsonl
//     --validate-only exits 0 (Validated 70 case(s) after US-012);
//   * all 6 are real pi bfmw runs on tt-ts with the canonical TEST_CMD
//     (npm test), E3.D bfmw floors+caps (wall >= 35 p50 floor, tokens 1M
//     p95), and E2.2 requires (toolchains node, node_min 22);
//   * W4.26's reset hook rewrites the working clone's origin remote to an
//     unreachable ssh URL and its task text pins bounded network timeouts +
//     no per-round warning storm + no host-key-prompt hang;
//   * W4.28's reset hook builds the two-INDEPENDENT-bares construction and
//     its task text documents the construction + the zero-cross-repo-replay
//     gate;
//   * W4.30's reset hook detaches the origin HEAD and its task text declares
//     the launch-time diagnosable-refusal expectation (never a mangled ref);
//   * torture-test/fixtures/hooks/pre-commit-amend.sh exists and is
//     executable; W4.31's reset hook installs it into the clone's
//     .git/hooks/pre-commit AND the installation is ASSERTED by an actual
//     execution test (the hook fires and rewrites the marker line into a
//     commit — the case-hook contract, AC2);
//   * W4.45 declares BOTH sub-arms as separate terminal rows whose task
//     texts name the --expect-tip CAS and the never-a-silent-resurrect
//     expectation;
//   * traceability rows: section-F map + exclusion enumeration + machinery
//     deltas + token budget; manifest summary showsTotal Tier-2 cases \(sections A \+ B \+ G \+ C1 \+ C2 \+ D \+ E \+ F \+ H \+ I \+ J \+ K \+ dsh lane \+ W5 storm\) \| \*\*70\*\*.
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const controller = path.join(ttRoot, "bin", "tt-controller");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const tasksDir = path.join(ttRoot, "cases", "tasks", "tier2");
const hooksDir = path.join(ttRoot, "cases", "hooks");
const fixtureHooksDir = path.join(ttRoot, "fixtures", "hooks");
const preCommitAmendAsset = path.join(fixtureHooksDir, "pre-commit-amend.sh");

// The 6 section-F cases (spec 08 §F, US-010). W4.45's two sub-arms are
// separate terminal rows (the established distinct-terminal discipline).
const SECTION_F_IDS = [
  "W4.26-unreachable-origin",
  "W4.28-tstx-cross-repo-collision",
  "W4.30-detached-head-origin",
  "W4.31-precommit-amend",
  "W4.45-gc-aggressive",
  "W4.45-branch-delete",
];

// The reset hook executable each wired case declares.
const RESET_HOOKS: Record<string, string> = {
  "W4.26-unreachable-origin": "cases/hooks/reset-w4.26-unreachable-origin.sh",
  "W4.28-tstx-cross-repo-collision": "cases/hooks/reset-w4.28-independent-bares.sh",
  "W4.30-detached-head-origin": "cases/hooks/reset-w4.30-detached-head-origin.sh",
  "W4.31-precommit-amend": "cases/hooks/reset-w4.31-precommit-amend.sh",
};

type Case = Record<string, any>;

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
  TAMANDUA_DSH_BINARY: "/usr/bin/false",
};

function readManifest(): Case[] {
  const source = fs.readFileSync(manifestPath, "utf8");
  const records: Case[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    records.push(JSON.parse(line));
  }
  return records;
}

function recordById(records: Case[], id: string): Case {
  const record = records.find((item) => item.id === id);
  assert.ok(record, `${id} must exist in the manifest`);
  return record;
}

function run(file: string, args: string[], extraEnv: Record<string, string> = {}, timeout = 300_000) {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: { ...env, ...extraEnv },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function taskText(record: Case): string {
  return fs.readFileSync(path.join(ttRoot, record.task), "utf8");
}

function assertExecutable(file: string, label: string): void {
  const details = fs.lstatSync(file, { throwIfNoEntry: false });
  assert.ok(details?.isFile() && !details.isSymbolicLink(), `${label}: must exist as a regular file: ${file}`);
  assert.ok(fs.accessSync(file, fs.constants.X_OK) === undefined, `${label}: must be executable: ${file}`);
}

describe("Tier-2 US-010 — section-F roster (weird-git target repos)", () => {
  it("cases/tier2.jsonl contains the 6 section-F cases and --validate-only exits 0", () => {
    const records = readManifest();
    const ids = records.map((record) => record.id);
    for (const id of SECTION_F_IDS) {
      assert.ok(ids.includes(id), `section-F case ${id} must be present`);
    }
    const res = run(controller, ["--manifest", manifestPath, "--validate-only"]);
    assert.equal(res.status, 0, `tt-controller --validate-only must exit 0:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });

  it("all 6 section-F cases are real pi bfmw runs on tt-ts with canonical TEST_CMD and E3.D floors+caps", () => {
    for (const id of SECTION_F_IDS) {
      const record = recordById(readManifest(), id);
      assert.equal(record.harness, "pi", `${id} must run on the pi harness`);
      assert.equal(record.workflow, "bug-fix-merge-worktree", `${id} must be a bfmw run`);
      assert.equal(record.fixture, "tt-ts", `${id} must run on tt-ts`);
      assert.equal(record.context.execution_mode, "real", `${id} must be execution_mode real`);
      assert.equal(record.context.test_cmd, "npm test", `${id} test_cmd must be the tt-ts canonical TEST_CMD`);
      assert.ok(record.seed && record.seed.startsWith("BUG-"), `${id} must carry a BUG-* seed`);
      // E3.D: bfmw wall cap at/above the family p50 35-min floor, tokens at
      // family p95 (1M), never below p50.
      assert.ok(record.caps.wall_min >= 35, `${id}: bfmw wall cap must be >= 35 (p50 floor)`);
      assert.ok(record.caps.tokens >= 1000000, `${id}: bfmw token cap must sit at p95 (1M)`);
      assert.ok(record.production_duration_floor_ms > 0, `${id}: must carry production_duration_floor_ms`);
      // E2.2 requires predicates against the canonical host-profile keys.
      assert.deepEqual(record.requires?.toolchains, ["node"], `${id}: requires toolchains node`);
      assert.equal(record.requires?.node_min, 22, `${id}: requires node_min 22`);
      // Shared manifest invariants.
      assert.deepEqual(record.gates, ["TIER2", "W4"], `${id}: gates must be [TIER2, W4]`);
      assert.equal(record.mandatory, true, `${id}: must be mandatory`);
      assert.equal(record.shed_ok, false, `${id}: must not be shed-ok`);
      assert.match(record.spec_ref, /^08-wave-4-fault-injection\.md#W4\./, `${id} spec_ref must point into spec 08`);
    }
  });

  it("W4.26's reset hook rewrites origin to an unreachable ssh URL; task pins bounded timeouts + no warning storm + no hang", () => {
    const record = recordById(readManifest(), "W4.26-unreachable-origin");
    assert.equal(record.reset?.executable, RESET_HOOKS["W4.26-unreachable-origin"],
      "W4.26 must declare its reset hook");
    assert.equal(record.chaos, null, "W4.26 carries chaos null (reset-hook arming, documented delta)");
    const hook = fs.readFileSync(path.join(ttRoot, record.reset.executable), "utf8");
    for (const needle of [
      "remote set-url origin",
      "ssh://unreachable.invalid/tamandua/tt-ts.git",
      "remote get-url origin",           // verification of the rewrite (fail-closed)
      "W4.26",
    ]) {
      assert.ok(hook.includes(needle), `W4.26 reset hook must ${needle}`);
    }
    const task = taskText(record);
    for (const needle of [
      "unreachable",
      "no hang",
      "host-key prompt",
      "warning storm",
      "bounded git network timeouts",
      "without origin liveness",
    ]) {
      assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `W4.26 task must pin ${needle}`);
    }
  });

  it("W4.28's reset hook builds two INDEPENDENT bares; task documents the construction + zero-cross-repo-replay gate", () => {
    const record = recordById(readManifest(), "W4.28-tstx-cross-repo-collision");
    assert.equal(record.reset?.executable, RESET_HOOKS["W4.28-tstx-cross-repo-collision"],
      "W4.28 must declare its reset hook");
    const hook = fs.readFileSync(path.join(ttRoot, record.reset.executable), "utf8");
    for (const needle of [
      "git init -q --bare",              // the spec's `git init --bare` construction
      "refs/heads/",                     // push the identical content
      "HEAD^{tree}",                     // byte-identical tree verification
      "byte-identical",
      "git-common-dir",                  // distinct origin identities (getOriginRepo)
      "never a directory copy",          // the git-common-dir ancestry trap
    ]) {
      assert.ok(hook.includes(needle), `W4.28 reset hook must ${needle}`);
    }
    const task = taskText(record);
    for (const needle of [
      "two INDEPENDENT bares",
      "git init --bare",
      "identical content",
      "distinct origin identities",
      "byte-identical HEAD trees",
      "zero-cross-repo-replay",
      "per origin_repo",
      "catastrophic and silent",
    ]) {
      assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `W4.28 task must document ${needle}`);
    }
  });

  it("W4.30's reset hook detaches the origin HEAD; task declares the launch-time diagnosable refusal", () => {
    const record = recordById(readManifest(), "W4.30-detached-head-origin");
    assert.equal(record.reset?.executable, RESET_HOOKS["W4.30-detached-head-origin"],
      "W4.30 must declare its reset hook");
    const hook = fs.readFileSync(path.join(ttRoot, record.reset.executable), "utf8");
    for (const needle of [
      "checkout -q --detach",
      "branch --show-current",           // empty -> detached verification
      "NOT detached",
    ]) {
      assert.ok(hook.includes(needle), `W4.30 reset hook must ${needle}`);
    }
    const task = taskText(record);
    for (const needle of [
      "detached",
      "diagnosable refusal",
      "launch-time",
      "never a mangled",
      "bogus ref",
      "ORIGINAL_BRANCH",
    ]) {
      assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `W4.30 task must declare ${needle}`);
    }
  });

  it("fixtures/hooks/pre-commit-amend.sh exists and is executable; W4.31's reset hook installs it into .git/hooks/", () => {
    assertExecutable(preCommitAmendAsset, "fixtures/hooks/pre-commit-amend.sh");
    const record = recordById(readManifest(), "W4.31-precommit-amend");
    assert.equal(record.reset?.executable, RESET_HOOKS["W4.31-precommit-amend"],
      "W4.31 must declare its reset hook");
    const hook = fs.readFileSync(path.join(ttRoot, record.reset.executable), "utf8");
    for (const needle of [
      "fixtures/hooks/pre-commit-amend.sh", // the fixture asset
      ".git/hooks/pre-commit",              // the spec's W4.31 mechanism
      "install -m 0755",
      "pre-commit-amend.marker.txt",        // the tracked marker the hook rewrites
      "git -C \"$clone\" add",              // the hook git-adds the rewritten line
      "Assert the installation",            // the case-hook contract (AC2)
      "not executable",
    ]) {
      assert.ok(hook.includes(needle), `W4.31 reset hook must ${needle}`);
    }
    const task = taskText(record);
    for (const needle of [
      "pre-commit",
      "TESTED_TREE",
      "post-hook",
      "attestation chain",
      "MERGED_TREE != TESTED_TREE",
    ]) {
      assert.match(task, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
        `W4.31 task must pin ${needle}`);
    }
  });

  it("W4.31's reset hook ACTUALLY installs the hook and the hook rewrites the marker into a commit (AC2 execution test)", () => {
    // Build a scratch work-clone at the exact path the reset hook expects
    // ($TT_ROOT/fixtures/work/W4.31-precommit-amend/tt-ts) under a temp TT_ROOT
    // inside var/ (gitignored), run the real reset hook, then make a commit
    // and assert the pre-commit hook fired: the marker line was rewritten and
    // is part of the committed tree.
    const scratchRoot = fs.mkdtempSync(path.join(ttRoot, "var", "self-test-f-"));
    const ttRootEnv = path.join(scratchRoot, "var");
    const clone = path.join(ttRootEnv, "fixtures", "work", "W4.31-precommit-amend", "tt-ts");
    try {
      fs.mkdirSync(path.dirname(clone), { recursive: true });
      const seedRepo = path.join(scratchRoot, "seed");
      fs.mkdirSync(path.join(seedRepo, "src"), { recursive: true });
      const init = run("git", ["init", "-q", "-b", "main", seedRepo]);
      assert.equal(init.status, 0, init.stderr);
      fs.writeFileSync(path.join(seedRepo, "src", "store.ts"), "export class InMemoryStore {}\n");
      const stage = run("git", ["-C", seedRepo, "add", "-A"]);
      assert.equal(stage.status, 0, stage.stderr);
      const seedCommit = run("git", ["-C", seedRepo, "-c", "user.name=t", "-c", "user.email=t@t",
        "commit", "-q", "-m", "init"]);
      assert.equal(seedCommit.status, 0, seedCommit.stderr);
      const cloneResult = run("git", ["clone", "-q", seedRepo, clone]);
      assert.equal(cloneResult.status, 0, cloneResult.stderr);

      // Run the REAL reset hook against the scratch layout.
      const resetResult = run(path.join(ttRoot, RESET_HOOKS["W4.31-precommit-amend"]), [], {
        TT_ROOT: ttRootEnv,
        TT_REPO_ROOT: repoRoot,
      });
      assert.equal(resetResult.status, 0, `W4.31 reset hook must exit 0:\n${resetResult.stdout}${resetResult.stderr}`);
      assert.match(resetResult.stdout, /pre-commit-amend hook installed/);

      // Assert the installation (the case-hook contract, AC2): hook present +
      // executable + byte-identical to the asset + marker baseline committed.
      const installed = path.join(clone, ".git", "hooks", "pre-commit");
      assertExecutable(installed, "installed pre-commit hook");
      assert.deepEqual(fs.readFileSync(installed), fs.readFileSync(preCommitAmendAsset),
        "installed hook must be byte-identical to the fixture asset");
      const baseline = run("git", ["-C", clone, "show", "HEAD:src/pre-commit-amend.marker.txt"]);
      assert.equal(baseline.status, 0, "marker baseline must be committed");
      assert.match(baseline.stdout, /pre-commit-amend: 0/, "baseline marker must be pre-commit-amend: 0");

      // Make a commit — the pre-commit hook must fire and rewrite the marker
      // line into the commit (the tree the verifier attests is post-hook).
      fs.appendFileSync(path.join(clone, "src", "store.ts"), "// fix\n");
      const fixCommit = run("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t",
        "commit", "-q", "-a", "-m", "fix: test commit"]);
      assert.equal(fixCommit.status, 0, `commit must succeed (hook must not block): ${fixCommit.stderr}`);
      const marker = run("git", ["-C", clone, "show", "HEAD:src/pre-commit-amend.marker.txt"]);
      assert.equal(marker.status, 0, "committed tree must include the marker");
      assert.match(marker.stdout, /pre-commit-amend: 1/,
        "the fixer commit must carry the REWRITTEN marker line (post-hook tree)");
    } finally {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it("W4.45 declares both sub-arms as separate rows with --expect-tip CAS and never-a-silent-resurrect expectations", () => {
    const records = readManifest();
    const gc = recordById(records, "W4.45-gc-aggressive");
    const del = recordById(records, "W4.45-branch-delete");
    assert.equal(gc.chaos, null, "W4.45-gc-aggressive carries chaos null (operator injection, documented delta)");
    assert.equal(del.chaos, null, "W4.45-branch-delete carries chaos null (operator injection, documented delta)");
    const gcTask = taskText(gc);
    for (const needle of [
      "git gc --aggressive --prune=now",
      "step:developer:running",
      "OPERATOR action",
    ]) {
      assert.match(gcTask, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `W4.45-gc-aggressive task must declare ${needle}`);
    }
    assert.match(gcTask, /machinery\s+delta/i,
      "W4.45-gc-aggressive task must declare the machinery delta");
    assert.match(gcTask, /never\s+a\s+half-landed\s+ref/i,
      "W4.45-gc-aggressive task must pin the never-a-half-landed-ref expectation");
    const delTask = taskText(del);
    for (const needle of [
      "git branch -D",
      "--expect-tip",
      "missing-ref named",
      "never a silent re-create",
      "resurrected wrong tree",
      "step:verifier:running",
      "OPERATOR action",
    ]) {
      assert.match(delTask, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `W4.45-branch-delete task must declare ${needle}`);
    }
    assert.match(delTask, /machinery\s+delta/i,
      "W4.45-branch-delete task must declare the machinery delta");
  });

  it("task files exist for the 6 section-F cases under cases/tasks/tier2/ and name the fixture", () => {
    const records = readManifest();
    for (const id of SECTION_F_IDS) {
      const record = recordById(records, id);
      assert.ok(record.task.startsWith("cases/tasks/tier2/"), `${id}: task must live under cases/tasks/tier2/`);
      const taskPath = path.join(ttRoot, record.task);
      const details = fs.lstatSync(taskPath, { throwIfNoEntry: false });
      assert.ok(details?.isFile() && !details.isSymbolicLink(), `${id}: task file must exist: ${record.task}`);
      const task = taskText(record);
      assert.ok(task.trim().length > 0, `${id}: task must be non-empty`);
      assert.match(task, /tt-ts/, `${id}: task must name the tt-ts fixture`);
    }
  });

  it("the traceability report carries the section-F map, exclusion enumeration, machinery deltas, and token budget", () => {
    const trace = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(trace, /## Case ↔ Spec Reference Map — Wave 4 Section F/, "section-F reference map header");
    assert.match(trace, /## Excluded Scenarios — Complete Enumeration \(section F\)/, "section-F exclusion enumeration");
    assert.match(trace, /## Token Budget Note \(section F\)/, "section-F token budget note");
    assert.match(trace, /Total Tier-2 cases \(sections A \+ B \+ G \+ C1 \+ C2 \+ D \+ E \+ F \+ H \+ I \+ J \+ K \+ dsh lane \+ W5 storm\) \| \*\*70\*\*/,
      "manifest summary must show 70 cases");
    assert.match(trace, /| Wave 4 section F \(weird-git target repos\) \| 6 /,
      "manifest summary must show the 6 section-F rows");
    for (const id of SECTION_F_IDS) {
      assert.match(trace, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        `traceability must carry a row for ${id}`);
    }
    // Machinery deltas for the section-F seams.
    assert.match(trace, /W4\.26-unreachable-origin/, "traceability must document the W4.26 remote-rewrite delta");
    assert.match(trace, /W4\.28-tstx-cross-repo-collision/, "traceability must document the W4.28 two-bare delta");
    assert.match(trace, /W4\.30-detached-head-origin/, "traceability must document the W4.30 detach delta");
    assert.match(trace, /W4\.31-precommit-amend/, "traceability must document the W4.31 hook delta");
    assert.match(trace, /fixtures\/hooks\/pre-commit-amend\.sh/, "traceability must name the fixture asset");
    assert.match(trace, /W4\.45-gc-aggressive \/ W4\.45-branch-delete/, "traceability must document both W4.45 sub-arms");
    // The exclusion enumeration says section F is fully covered.
    assert.match(trace, /none — section F fully covered/, "section-F exclusion enumeration must report full coverage");
    assert.match(trace, /5\/5 — W4\.45's two sub-arms are separate terminal rows/,
      "manifest summary must report 5/5 section-F coverage");
  });
});
