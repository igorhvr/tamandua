/**
 * Fast, deterministic controls for the TEST-ONLY fake dsh fixture's
 * feature-dev-merge-worktree story/merge role support (MTLK-ALL-WORKFLOWS
 * US-006).
 *
 * `e2e-tests/dsh-fixture/fake-dsh.mjs` is normally executed INSIDE a fresh
 * Matchlock VM by the on-demand dsh whole-path merge gate. This file drives the
 * SAME fixture natively with node against an owned scratch git repository, with
 * a deterministic stand-in guest CLI for the packed `/workspace/runtime/bin`
 * binary, so the role protocol (planner STORIES_JSON/BRANCH, setup branch +
 * raw TEST_CMD, developer commit, tester/verifier TESTED_TREE, reviewer ACCEPT,
 * and the merger's deterministic target_moved -> rebase -> STATUS: retry loop
 * then a real second landing) is pinned with NO VM, NO daemon, NO provider
 * credentials and NO network.
 *
 * It imports `node:child_process` (it spawns the fixture and git), so it is
 * classified in the serial lane.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_DSH = path.join(REPO_ROOT, "e2e-tests", "dsh-fixture", "fake-dsh.mjs");

/**
 * Deterministic stand-in for the packed guest CLI. It answers `step claim`
 * with the canned step input named by `FAKE_DSH_CLAIM_INPUT`, accepts
 * `step complete`/`step fail`, and implements the tiny compare-and-swap
 * `merge-branch` the fixture's merger drives (target_moved on a stale tip,
 * real squash commit-tree + update-ref otherwise).
 */
const STUB_CLI_SOURCE = [
  'import { spawnSync } from "node:child_process";',
  'import fs from "node:fs";',
  "",
  "const args = process.argv.slice(2);",
  "const op = args[0];",
  "",
  "function git(gitArgs) {",
  '  const r = spawnSync("git", gitArgs, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });',
  '  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };',
  "}",
  "",
  'if (op === "step" && args[1] === "claim") {',
  "  const inputFile = process.env.FAKE_DSH_CLAIM_INPUT || \"\";",
  '  const input = inputFile && fs.existsSync(inputFile) ? fs.readFileSync(inputFile, "utf-8") : "";',
  '  const stepId = process.env.FAKE_DSH_STEP_ID || "step-stub";',
  '  const runId = process.env.FAKE_DSH_RUN_ID || "run-stub";',
  "  process.stdout.write(JSON.stringify({ stepId, runId, input }) + \"\\n\");",
  "  process.exit(0);",
  "}",
  "",
  'if (op === "step" && (args[1] === "complete" || args[1] === "fail")) {',
  "  process.exit(0);",
  "}",
  "",
  'if (op === "merge-branch") {',
  "  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };",
  '  const origin = value("--origin");',
  '  const branch = value("--branch");',
  '  const into = value("--into");',
  '  const expectTip = value("--expect-tip");',
  '  const message = value("--message") || "synthetic squash";',
  '  const curr = git(["-C", origin, "rev-parse", `refs/heads/${into}`]);',
  '  if (curr.status !== 0) { process.stdout.write("STATUS: failed\\nREASON: no target\\n"); process.exit(1); }',
  "  if (curr.stdout !== expectTip) {",
  '    process.stdout.write("STATUS: target_moved\\n");',
  '    process.stdout.write(`EXPECTED_TIP: ${expectTip}\\nACTUAL_TIP: ${curr.stdout}\\n`);',
  "    process.exit(2);",
  "  }",
  '  const tree = git(["-C", origin, "rev-parse", `refs/heads/${into}^{tree}`]);',
  "  if (branch === into) {",
  '    process.stdout.write(`STATUS: landed\\nNOOP: true\\nMERGED_COMMIT: ${curr.stdout}\\nMERGED_TREE: ${tree.stdout}\\nTARGET: refs/heads/${into}\\n`);',
  "    process.exit(0);",
  "  }",
  '  const branchTree = git(["-C", origin, "rev-parse", `refs/heads/${branch}^{tree}`]);',
  "  if (branchTree.status !== 0) {",
  '    process.stdout.write(`STATUS: failed\\nREASON: no branch ${branch}\\n`);',
  "    process.exit(1);",
  "  }",
  '  const commit = spawnSync("git", ["-C", origin, "commit-tree", branchTree.stdout, "-p", expectTip, "-m", message], { encoding: "utf-8" });',
  "  if (commit.status !== 0) {",
  '    process.stdout.write(`STATUS: failed\\nREASON: commit-tree failed\\n`);',
  "    process.exit(1);",
  "  }",
  "  const commitSha = (commit.stdout || \"\").trim();",
  '  const upd = git(["-C", origin, "update-ref", `refs/heads/${into}`, commitSha]);',
  "  if (upd.status !== 0) {",
  '    process.stdout.write("STATUS: failed\\nREASON: update-ref failed\\n");',
  "    process.exit(1);",
  "  }",
  '  process.stdout.write(`STATUS: landed\\nNOOP: false\\nMERGED_COMMIT: ${commitSha}\\nMERGED_TREE: ${branchTree.stdout}\\nTARGET: refs/heads/${into}\\n`);',
  "  process.exit(0);",
  "}",
  "",
  'process.stderr.write(`stub-cli: unknown op ${args.join(" ")}\\n`);',
  "process.exit(3);",
  "",
].join("\n");

function gitProbe(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  return { status: r.status, stdout: (r.stdout ?? "").trim(), stderr: (r.stderr ?? "").trim() };
}

function gitMust(args: string[], cwd: string): string {
  const r = gitProbe(args, cwd);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed (cwd=${cwd}): ${r.stderr}`);
  return r.stdout;
}

/** Read the first `KEY: value` line from a fixture report. */
function readOut(text: string, key: string): string {
  const m = text.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

interface FixtureRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface FixtureOptions {
  workflow: string;
  role: string;
  runId: string;
  cwd: string;
  cli: string;
  dshHome: string;
  scratch: string;
  input: string;
}

function runFixture(opts: FixtureOptions): FixtureRun {
  const agent = `${opts.workflow}_${opts.role}`;
  const claimFile = path.join(opts.scratch, `claim-${opts.role}.txt`);
  fs.writeFileSync(claimFile, opts.input, "utf-8");
  const prompt = [
    `You are the work agent for workflow "${opts.workflow}", agent "${agent}", run "${opts.runId}".`,
    "",
    "1. Claim the pending work:",
    `   "${opts.cli}" step claim "${agent}" --run-id "${opts.runId}"`,
    "",
    "Reply with:",
    "STATUS: done",
  ].join("\n");
  const r = spawnSync(process.execPath, [FAKE_DSH, "--profile", "headless", prompt], {
    encoding: "utf-8",
    cwd: opts.cwd,
    // Explicit isolated env (never a spread of the live process env): the
    // fixture and its git children see only the owned scratch HOME/DSH_HOME,
    // a read-only git config, and the canned claim coordinates.
    env: {
      PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      HOME: opts.scratch,
      DSH_HOME: opts.dshHome,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      FAKE_DSH_CLAIM_INPUT: claimFile,
      FAKE_DSH_STEP_ID: `step-${opts.role}`,
      FAKE_DSH_RUN_ID: opts.runId,
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function countSessions(dshHome: string): number {
  const sessions = path.join(dshHome, "sessions");
  if (!fs.existsSync(sessions)) return 0;
  let count = 0;
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = path.join(dir, entry.name);
        walk(full);
        if (entry.name.startsWith("session-")) count += 1;
      }
    }
  };
  walk(sessions);
  return count;
}

describe("fake-dsh feature-dev-merge-worktree story/merge roles (MTLK-ALL-WORKFLOWS US-006)", () => {
  let root = "";
  let ownerOrigin = "";
  let worktree = "";
  let stubCli = "";
  let dshHome = "";
  const runId = "run-mtlkdsh006";

  before(() => {
    assert.ok(fs.existsSync(FAKE_DSH), `fixture dsh must exist: ${FAKE_DSH}`);
    root = tamanduaTempDir("mtlk-dsh-story-roles-");
    dshHome = path.join(root, "dsh-home");
    fs.mkdirSync(dshHome, { recursive: true });
    stubCli = path.join(root, "stub-guest-cli.mjs");
    fs.writeFileSync(stubCli, STUB_CLI_SOURCE, "utf-8");

    ownerOrigin = path.join(root, "origin");
    fs.mkdirSync(ownerOrigin, { recursive: true });
    gitMust(["init", "-q", "-b", "main"], ownerOrigin);
    gitMust(["config", "user.email", "synthetic@tamandua.test"], ownerOrigin);
    gitMust(["config", "user.name", "Synthetic Gate"], ownerOrigin);
    fs.writeFileSync(path.join(ownerOrigin, "README.md"), "# synthetic owned origin\n", "utf-8");
    gitMust(["add", "-A"], ownerOrigin);
    gitMust(["commit", "-q", "-m", "chore: synthetic owned origin initial"], ownerOrigin);

    worktree = path.join(root, "worktree");
    gitMust(["worktree", "add", "--detach", worktree, "main"], ownerOrigin);
    // The canned TEST_CMD (`node test.mjs`) must actually pass in the fixture
    // repo. It is committed by the developer role's owned change.
    fs.writeFileSync(path.join(worktree, "test.mjs"), "process.exit(0);\n", "utf-8");
  });

  after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("is deterministic and node-core only", () => {
    const src = fs.readFileSync(FAKE_DSH, "utf-8");
    const specs: string[] = [];
    const re = /from\s+["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
    assert.ok(specs.length > 0, "fixture has imports");
    for (const spec of specs) {
      assert.ok(spec.startsWith("node:"), `fixture must be node-core only, saw import ${spec}`);
    }
  });

  it("executes every feature-dev-merge-worktree role and lands a real squash on the origin", () => {
    // ── planner ──
    const planner = runFixture({
      workflow: "feature-dev-merge-worktree",
      role: "planner",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input: `TASK: synthetic gate task\n\nReply with:\nSTATUS: done\nREPO: ${worktree}\nBRANCH: <name>\nSTORIES_JSON: []\n`,
    });
    assert.equal(planner.status, 0, `planner fixture failed: ${planner.stderr}`);
    assert.equal(readOut(planner.stdout, "STATUS"), "done");
    const branch = readOut(planner.stdout, "BRANCH");
    assert.match(branch, /^synthetic-gate\/[0-9a-z]+$/, `planner BRANCH: ${branch}`);
    const storiesRaw = readOut(planner.stdout, "STORIES_JSON");
    const stories = JSON.parse(storiesRaw);
    assert.ok(Array.isArray(stories) && stories.length === 1, "planner emits one story");
    assert.equal(stories[0].id, "US-001");

    // ── setup ──
    const setup = runFixture({
      workflow: "feature-dev-merge-worktree",
      role: "setup",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input:
        `REPO: ${worktree}\nBRANCH: ${branch}\nORIGINAL_BRANCH: main\n` +
        "Reply with:\nSTATUS: done\nORIGINAL_BRANCH: main\nBUILD_CMD: node --version\nTEST_CMD: node test.mjs\nCI_NOTES: none\nBASELINE: green\n",
    });
    assert.equal(setup.status, 0, `setup fixture failed: ${setup.stderr}`);
    assert.equal(readOut(setup.stdout, "TEST_CMD"), "node test.mjs");
    assert.equal(readOut(setup.stdout, "ORIGINAL_BRANCH"), "main");
    assert.equal(gitMust(["rev-parse", "--abbrev-ref", "HEAD"], worktree), branch, "setup creates the feature branch");

    // ── developer ──
    const developer = runFixture({
      workflow: "feature-dev-merge-worktree",
      role: "developer",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input: `REPO: ${worktree}\nBRANCH: ${branch}\nReply with:\nSTATUS: done\nCHANGES: x\nTESTS: y\n`,
    });
    assert.equal(developer.status, 0, `developer fixture failed: ${developer.stderr}`);
    assert.equal(readOut(developer.stdout, "STATUS"), "done");
    assert.match(readOut(developer.stdout, "CHANGES"), /src\/gate-feature\.txt/);
    assert.ok(fs.existsSync(path.join(worktree, "src", "gate-feature.txt")), "developer commits the owned fixture change");
    const headSubject = gitMust(["log", "-1", "--pretty=%s"], worktree);
    assert.match(headSubject, /synthetic gate owned fixture change/);

    // ── verifier ──
    const verifierTreeBefore = gitMust(["rev-parse", "HEAD^{tree}"], worktree);
    const verifier = runFixture({
      workflow: "feature-dev-merge-worktree",
      role: "verifier",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input: `REPO: ${worktree}\nTEST_CMD: node test.mjs\nReply with:\nSTATUS: done\nVERIFIED: x\n`,
    });
    assert.equal(verifier.status, 0, `verifier fixture failed: ${verifier.stderr}`);
    assert.equal(readOut(verifier.stdout, "TESTED_TREE"), verifierTreeBefore);

    // ── tester (first validation, tree T1) ──
    const tester1 = runFixture({
      workflow: "feature-dev-merge-worktree",
      role: "tester",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input: `REPO: ${worktree}\nTEST_CMD: node test.mjs\nReply with:\nSTATUS: done\nRESULTS: x\nTESTED_TREE: x\n`,
    });
    assert.equal(tester1.status, 0, `tester fixture failed: ${tester1.stderr}`);
    const testedTree1 = readOut(tester1.stdout, "TESTED_TREE");
    assert.match(testedTree1, /^[0-9a-f]{40}$/);

    // ── reviewer ──
    const reviewer = runFixture({
      workflow: "feature-dev-merge-worktree",
      role: "reviewer",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input: `REPO: ${worktree}\nReply with:\nSTATUS: done\nVERDICT: ACCEPT|REJECT\nFINDING: x\n`,
    });
    assert.equal(reviewer.status, 0, `reviewer fixture failed: ${reviewer.stderr}`);
    assert.equal(readOut(reviewer.stdout, "VERDICT"), "ACCEPT");

    const baseTip = gitMust(["-C", ownerOrigin, "rev-parse", "refs/heads/main"], ownerOrigin);

    // ── merger, first invocation: target_moved -> rebase -> STATUS: retry ──
    const mergerInput =
      `RUN_ID: ${runId}\nREPO: ${worktree}\nBRANCH: ${branch}\nORIGINAL_BRANCH: main\n` +
      `WORKTREE_ORIGIN_REPOSITORY: ${ownerOrigin}\nORIGIN_REPOSITORY: ${ownerOrigin}\n` +
      "Reply with:\nSTATUS: done|retry\nREBASED: true|false\n";
    const merger1 = runFixture({
      workflow: "feature-dev-merge-worktree",
      role: "merger",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input: mergerInput,
    });
    assert.equal(merger1.status, 0, `merger#1 fixture failed: ${merger1.stderr}`);
    assert.match(merger1.stdout, /^STATUS:\s*target_moved\s*$/m, `merger#1 must record the target-moved refusal:\n${merger1.stdout}`);
    assert.match(merger1.stdout, /^STATUS:\s*retry\s*$/m, `merger#1 report:\n${merger1.stdout}`);
    assert.equal(readOut(merger1.stdout, "REBASED"), "true");
    assert.equal(readOut(merger1.stdout, "RETRY_STEP"), "test");
    const movedTip = gitMust(["-C", ownerOrigin, "rev-parse", "refs/heads/main"], ownerOrigin);
    assert.notEqual(movedTip, baseTip, "the owned external-actor advance moves the target");
    const bareRunId = runId.replace(/^run-/, "");
    assert.equal(
      gitMust(["-C", ownerOrigin, "rev-parse", "--verify", `refs/tamandua-synthetic/rebased-${bareRunId}`], ownerOrigin).length,
      40,
    );
    // The rebase re-parents the feature work; the pre-rebase tested tree no
    // longer describes the branch tip.
    const testedTreeAfterRebase = gitMust(["rev-parse", "HEAD^{tree}"], worktree);

    // ── tester re-validation after the rebase (tree T2) ──
    const tester2 = runFixture({
      workflow: "feature-dev-merge-worktree",
      role: "tester",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input: `REPO: ${worktree}\nTEST_CMD: node test.mjs\nReply with:\nSTATUS: done\nRESULTS: x\nTESTED_TREE: x\n`,
    });
    assert.equal(tester2.status, 0, `tester#2 fixture failed: ${tester2.stderr}`);
    const testedTree2 = readOut(tester2.stdout, "TESTED_TREE");
    assert.equal(testedTree2, testedTreeAfterRebase, "the re-validation attests the rebased tree");

    // ── merger, second invocation: real landing ──
    const merger2 = runFixture({
      workflow: "feature-dev-merge-worktree",
      role: "merger",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input: mergerInput,
    });
    assert.equal(merger2.status, 0, `merger#2 fixture failed: ${merger2.stderr}`);
    assert.match(merger2.stdout, /^STATUS:\s*done\s*$/m, `merger#2 report:\n${merger2.stdout}`);
    assert.equal(readOut(merger2.stdout, "REBASED"), "false");
    assert.equal(readOut(merger2.stdout, "MERGED_TREE"), testedTree2, "MERGED_TREE equals the last TESTED_TREE");
    assert.equal(readOut(merger2.stdout, "MERGED_INTO"), "main");
    const landedTree = gitMust(["-C", ownerOrigin, "rev-parse", "refs/heads/main^{tree}"], ownerOrigin);
    assert.equal(landedTree, testedTree2, "the origin target carries the tested squash tree");

    // Exactly one work session per harness invocation (planner/setup/developer/
    // verifier/tester x2/reviewer/merger x2 = 9).
    assert.equal(countSessions(dshHome), 9, "one synthetic v3 session per work invocation");
  });

  it("preserves the generic do-now report byte-identically", () => {
    const run = runFixture({
      workflow: "do-now",
      role: "do",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input: "Reply with:\nSTATUS: done\nREPORT: x\nCHANGES: y\nTESTS: z\n",
    });
    assert.equal(run.status, 0, `do-now fixture failed: ${run.stderr}`);
    assert.equal(readOut(run.stdout, "STATUS"), "done");
    assert.equal(
      readOut(run.stdout, "REPORT"),
      "synthetic-dsh completed the harmless owned fixture action inside the fresh Matchlock VM",
    );
    assert.equal(readOut(run.stdout, "CHANGES"), "synthetic-dsh: wrote marker and ran packed tamandua-test (fixture action)");
    assert.equal(readOut(run.stdout, "TESTS"), "packed tamandua-test exit recorded in host suite store");
    assert.equal(readOut(run.stdout, "STORIES_JSON"), "", "no story role keys leak into do-now");
  });

  it("preserves the generic do-review-do-verify report byte-identically", () => {
    const run = runFixture({
      workflow: "do-review-do-verify",
      role: "reviewer",
      runId,
      cwd: worktree,
      cli: stubCli,
      dshHome,
      scratch: root,
      input:
        "Reply with:\nSTATUS: done\nVERDICT: accomplished\nISSUES: none\n" +
        "DETAILS: x\nFEEDBACK: y\n",
    });
    assert.equal(run.status, 0, `do-review-do-verify fixture failed: ${run.stderr}`);
    assert.equal(readOut(run.stdout, "STATUS"), "done");
    // Generic KEY_VALUES, NOT the worktree role ACCEPT override.
    assert.equal(readOut(run.stdout, "VERDICT"), "accomplished");
    assert.equal(readOut(run.stdout, "ISSUES"), "none");
    assert.equal(readOut(run.stdout, "FEEDBACK"), "synthetic fixture reviewer: no issues; work satisfies the task");
  });
});
