#!/usr/bin/env node
/**
 * synthetic-pi.mjs — MTLK-PI-EXEC US-003/US-004 test-only synthetic pi
 * harness.
 *
 * Installed at /opt/tamandua-synthetic-bin/pi inside the EXPLICITLY TEST-ONLY
 * synthetic fixture image (see Dockerfile.synthetic-pi). The image declares
 * that directory in its (non-default) ENV PATH, so the guest `pi` is reachable
 * ONLY when the host runner preserves the USER IMAGE's effective PATH
 * (admission-captured oci env PATH + helper-pack prepend) — a conservative
 * default PATH would not resolve it. It is a deterministic stand-in for the
 * real pi binary that behaves like the scripted-agent e2e helpers
 * (e2e-tests/helpers/scripted-agent-runtime.mjs) but INSIDE the Matchlock VM:
 *
 *   - reads the prompt (the final argv element — the runner invokes
 *     `pi --print --mode json "<prompt>"`);
 *   - a launch-time harness-probe prompt (the stable
 *     `TAMANDUA_HARNESS_PROBE: skill-path` first line) runs the quoted guest
 *     command (`/workspace/runtime/bin/tamandua skill-path`) for real and
 *     replies with the PATH via a pi-shaped message_end;
 *   - a work prompt parses workflow/agent/run + the packed GUEST CLI path from
 *     the prompt, claims the pending step through the guest CLI (host broker),
 *     performs a harmless OWNED fixture action (write a marker file under the
 *     mounted working directory) and runs the packed `tamandua-test` with a
 *     trivial passing command against the admitted git fixture repo, then
 *     submits a report that satisfies the step's Reply-with/KEY shape and
 *     completes the step through the guest CLI;
 *   - emits pi --mode json frames (tool_execution_end + message_end with
 *     usage.totalTokens) exactly like the scripted runtime so the scheduler's
 *     existing post-round parsing/accounting is reused unchanged.
 *
 * NO provider credentials and NO model calls anywhere in the gate. Node-core
 * only (node >= 22 is image-provided by the fixture base).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ── stable marker + probe handling (mirror scripted-agent-runtime-shared) ──
const HARNESS_PROBE_MARKER = "TAMANDUA_HARNESS_PROBE: skill-path";

// US-006 (H1/D1) TEST-ONLY knob: when the fixture image sets this (via a
// Dockerfile ENV), a WORK round still claims + completes the step through the
// packed guest CLI (the host broker/DB), the marker + packed tamandua-test
// fixture action still run, and the guest progress document is still written —
// but the harness's pi JSON stdout (message_end + tool attribution) is
// deliberately NOT emitted. That reproduces the real-model defect path
// (outcome=empty_output with an authoritatively COMPLETED step) inside a real
// VM, so a gate can prove the scheduler classifies it work_done from the step
// row. The launch probe is never silenced, and the default (unset) keeps the
// shared fixture byte-identical for every existing gate.
const SILENT_WORK_STDOUT = process.env.TAMANDUA_SYNTHETIC_PI_EMPTY_HARNESS_STDOUT === "1";

function isHarnessProbePrompt(prompt) {
  const firstLine = String(prompt ?? "").split(/\r?\n/, 1)[0] ?? "";
  return firstLine.trim() === HARNESS_PROBE_MARKER;
}

function parseHarnessProbeCommand(prompt) {
  const m = String(prompt ?? "").match(
    /Run the exact command "([^"]+)" and reply with the PATH and nothing else\./,
  );
  return m ? m[1] : null;
}

function splitProbeCommand(cmd) {
  const argv = [];
  let current = "";
  let inQuotes = false;
  for (const ch of String(cmd)) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === " " && !inQuotes) {
      if (current.length > 0) {
        argv.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) argv.push(current);
  return argv;
}

// ── pi-shaped JSON event emission (same contract as the scripted runtime) ──
function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function stripIdPrefix(id) {
  return String(id).replace(/^(run-|step-)/, "");
}

function emitToolAttribution(stepId, runId) {
  emit({
    type: "tool_execution_end",
    toolName: "bash",
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            stepId: stripIdPrefix(stepId),
            runId: stripIdPrefix(runId),
          }),
        },
      ],
    },
    isError: false,
  });
}

function emitMessageEnd(text, totalTokens) {
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "scripted",
      provider: "scripted",
      model: "synthetic-matchlock-pi",
      usage: {
        input: Math.max(0, totalTokens - 1),
        output: totalTokens > 0 ? 1 : 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
      responseId: crypto.randomUUID(),
    },
  });
}

// ── guest CLI helper (packed /workspace/runtime/bin/tamandua) ──────────────
function createCli(cliPath) {
  let shellScript = false;
  try {
    const fd = fs.openSync(cliPath, "r");
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    shellScript = buf.toString("utf-8") === "#!";
  } catch {
    shellScript = false;
  }
  const [command, baseArgs] = shellScript ? [cliPath, []] : [process.execPath, [cliPath]];
  return (args, input) =>
    spawnSync(command, [...baseArgs, ...args], {
      encoding: "utf-8",
      cwd: process.cwd(),
      env: process.env,
      input,
      maxBuffer: 16 * 1024 * 1024,
    });
}

function runProbe(prompt) {
  const cmd = parseHarnessProbeCommand(prompt);
  if (cmd === null || cmd.length === 0) {
    emitMessageEnd("probe prompt did not quote a command", 0);
    process.exit(2);
  }
  const argv = splitProbeCommand(cmd);
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: "utf-8",
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = (r.stdout ?? "").trim();
  const ok = r.status === 0 && stdout.length > 0;
  emitMessageEnd(ok ? stdout : `probe command failed (exit ${r.status ?? "signal"}): ${(r.stderr ?? "").slice(0, 400)}`, 0);
  process.exit(ok ? 0 : 1);
}

// ── work prompt parsing (pins the guest-CLI prompt protocol) ──────────────
function parseWorkPrompt(input) {
  const header = input.match(/workflow "([^"]+)", agent "([^"]+)", run "([^"]+)"/);
  if (!header) return null;
  const [, workflowId, agentId, runId] = header;
  const cliMatch = input.match(/(?:node )?"([^"]+)" step (?:claim|peek)/);
  if (!cliMatch) return null;
  const cliPath = cliMatch[1];
  const shortAgent = agentId.startsWith(`${workflowId}_`)
    ? agentId.slice(workflowId.length + 1)
    : agentId;
  return { workflowId, agentId, runId, cliPath, shortAgent };
}

// Extract the "Reply with:" section keys from the claimed step input so the
// report matches EXACTLY the STATUS/KEY shape each workflow step expects
// (STATUS: done + every listed KEY with a non-empty value). Unknown keys get
// a canned truthful value.
function replyKeysFromInput(input) {
  const keys = new Set(["STATUS"]);
  const replyIdx = input.indexOf("Reply with:");
  if (replyIdx >= 0) {
    const block = input.slice(replyIdx + "Reply with:".length);
    for (const line of block.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]{1,30}):/);
      if (m) keys.add(m[1]);
    }
  }
  return [...keys];
}

const KEY_VALUES = {
  STATUS: "done",
  CHANGES: "synthetic-pi: wrote marker and ran packed tamandua-test (fixture action)",
  REPORT: "synthetic-pi completed the harmless owned fixture action inside the fresh Matchlock VM",
  FEEDBACK: "synthetic fixture reviewer: no issues; work satisfies the task",
  ISSUES: "none",
  VERDICT: "accomplished",
  DETAILS: "synthetic-pi fixture verifier confirms the owned fixture action succeeded",
  TESTS: "packed tamandua-test exit recorded in host suite store",
  REASON: "synthetic-pi completed successfully",
};

function buildReport(input) {
  const lines = [];
  for (const key of replyKeysFromInput(input)) {
    lines.push(`${key}: ${KEY_VALUES[key] ?? "synthetic-pi fixture result"}`);
  }
  return lines.join("\n");
}

/** Build a report from the Reply-with keys, applying role-specific overrides. */
function buildReportWithOverrides(input, overrides) {
  const keys = replyKeysFromInput(input);
  const lines = [];
  for (const key of keys) {
    const value = overrides[key] ?? KEY_VALUES[key] ?? "synthetic-pi fixture result";
    lines.push(`${key}: ${value}`);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!keys.includes(key)) lines.push(`${key}: ${value}`);
  }
  return lines.join("\n");
}

// ── worktree-merge workflow role support ──────────────────────────────────
// The genuine bundled feature-dev-merge-worktree / bug-fix-merge-worktree
// workflows drive a story loop, a tester, and a finalizing squash merge. The
// synthetic pi can execute their per-role protocol deterministically inside the
// fresh VM: planner emits stories, setup creates the feature branch, developer
// commits an owned fixture change, tester runs the wrapped tamandua-test,
// verifier approves, and the merger lands through the SCOPED guest
// `merge-branch` command (US-007) with a real target advance — including a
// deterministic target_moved -> rebase -> retest loop on the first merger
// attempt (an owned external-actor advance, never a live branch).

const WORKTREE_MERGE_WORKFLOWS = new Set([
  "feature-dev-merge-worktree",
  "bug-fix-merge-worktree",
  // Capability-equivalent DIRECT merge routes (US-010): the same role protocol
  // applies; only the origin location differs ({{repo}} instead of a managed
  // worktree origin), and the handler reads whichever origin key is present.
  "feature-dev-merge",
  "bug-fix-merge",
]);

function isWorktreeMergeWorkflow(workflowId) {
  return WORKTREE_MERGE_WORKFLOWS.has(workflowId) || workflowId.endsWith("-merge-worktree");
}

/**
 * Merge workflows whose pipeline has NO dedicated tester step: the verifier
 * runs the wrapped TEST_CMD itself and attests TESTED_TREE, which is the ledger
 * key the finalizer seam later looks up. For feature-dev-merge-worktree the
 * tester records that row (and the verifier must NOT pre-record it, so the
 * tester's real evidence is the one that survives).
 */
const NO_TESTER_MERGE_WORKFLOWS = new Set([
  "bug-fix-merge-worktree",
  "bug-fix-merge",
]);

/** Read the first `NAME: value` line from a step input. */
function readKey(input, name) {
  const m = String(input ?? "").match(new RegExp(`^${name}:[ \\t]*(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

function runProc(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf-8",
    cwd: opts.cwd ?? process.cwd(),
    env: process.env,
    input: opts.input,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function gitProbe(args, cwdArg) {
  return runProc("git", args, { cwd: cwdArg ?? process.cwd() });
}

function gitMust(args, cwdArg) {
  const r = gitProbe(args, cwdArg);
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (rc=${r.status}): ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  }
  return (r.stdout ?? "").trim();
}

function commitAll(repo, message) {
  gitMust(["add", "-A"], repo);
  const dirty = gitProbe(["status", "--porcelain"], repo).stdout.trim();
  if (dirty.length === 0) return false;
  gitMust(["commit", "-q", "-m", message], repo);
  return true;
}

function syntheticBranch(runId) {
  const short = stripIdPrefix(runId).slice(0, 8);
  return `synthetic-gate/${short}`;
}

const COAUTHOR = "Co-Authored-By: Tamandua <tamandua@tetradactyla.org>";

/**
 * Execute the role-specific protocol for the merge-worktree workflow and
 * return either a merged report override map or a full custom report string.
 * Throws are surfaced as a STATUS: failed report by the caller.
 */
function handleWorktreeMergeRole(role, input, cli, runId, workflowId) {
  const repo = readKey(input, "REPO") || process.cwd();

  if (role === "planner") {
    const stories = [      {
        id: "US-001",
        title: "Synthetic whole-path gate story",
        description:
          "Add one committed, owned fixture change to the worktree so the whole-path gate has a real tested tree to squash-merge.",
        acceptanceCriteria: [
          "the owned fixture change is committed on the feature branch",
          "tests pass",
          "Typecheck passes",
        ],
      },
    ];
    return {
      overrides: {
        BRANCH: syntheticBranch(runId),
        REPO: process.cwd(),
        STORIES_JSON: JSON.stringify(stories),
        STATUS: "done",
      },
    };
  }

  if (role === "triager") {
    // bug-fix-merge-worktree: triage emits the branch that setup later creates
    // and a real severity so the step's regex expects are satisfied.
    return {
      overrides: {
        REPO: process.cwd(),
        BRANCH: syntheticBranch(runId),
        SEVERITY: "high",
        AFFECTED_AREA: "src/math.mjs",
        REPRODUCTION: "node test.mjs against the pre-fix tree",
        PROBLEM_STATEMENT: "synthetic owned-fixture bug report for the whole-path gate",
        STATUS: "done",
      },
    };
  }

  if (role === "investigator") {
    return {
      overrides: {
        ROOT_CAUSE: "synthetic root cause: the owned fixture helper mishandles its input",
        FIX_APPROACH: "guard the owned fixture helper and add a regression test",
        STATUS: "done",
      },
    };
  }

  if (role === "setup") {
    const branch = readKey(input, "BRANCH") || syntheticBranch(runId);
    const originalBranch = readKey(input, "ORIGINAL_BRANCH");
    gitMust(["config", "user.email", "synthetic@tamandua.test"], repo);
    gitMust(["config", "user.name", "Synthetic Gate"], repo);
    // Idempotent branch creation at the current detached worktree HEAD.
    gitMust(["checkout", "-B", branch], repo);
    return {
      overrides: {
        ORIGINAL_BRANCH: originalBranch,
        BUILD_CMD: "node --version",
        TEST_CMD: "node test.mjs",
        CI_NOTES: "synthetic fixture: no CI; node-only",
        BASELINE: "synthetic fixture baseline green",
        STATUS: "done",
      },
    };
  }

  if (role === "developer" || role === "fixer" || role === "implementer") {
    const branch = readKey(input, "BRANCH") || syntheticBranch(runId);
    const rel = "src/gate-feature.txt";
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, `synthetic gate change ${stripIdPrefix(runId).slice(0, 8)}\n`, "utf-8");
    commitAll(repo, `feat: synthetic gate owned fixture change on ${branch}\n\n${COAUTHOR}`);
    return {
      overrides: {
        CHANGES: `committed ${rel} on ${branch}`,
        REGRESSION_TEST: `${rel} presence check + test.mjs`,
        REPRO_EVIDENCE: "pre-fix owned fixture tree fails the synthetic regression check",
        TESTS: "test.mjs passes in the guest VM",
        STATUS: "done",
      },
    };
  }

  if (role === "verifier") {
    // bug-fix workflows have no tester step: the verifier runs the wrapped
    // TEST_CMD (per its own instructions) and attests the verified tree, which
    // is the ledger key the finalizer seam later looks up. Feature-dev keeps
    // its dedicated tester as the recorder of that row.
    let outcome = "verifier did not run TEST_CMD (dedicated tester owns the suite row)";
    if (NO_TESTER_MERGE_WORKFLOWS.has(workflowId)) {
      const testCmd = readKey(input, "TEST_CMD");
      if (testCmd) {
        const r = runProc("/bin/sh", ["-c", testCmd], { cwd: repo });
        outcome = `packed tamandua-test rc=${r.status ?? "signal"}`;
        if (r.status !== 0) {
          outcome += ` stderr=${(r.stderr || "").trim().slice(0, 400)}`;
        }
      } else {
        outcome = "no TEST_CMD in prompt";
      }
    }
    const testedTree = gitMust(["rev-parse", "HEAD^{tree}"], repo);
    return {
      overrides: {
        VERIFIED: `owned fixture change exists and is committed; ${outcome}`,
        TESTED_TREE: testedTree,
        STATUS: "done",
      },
    };
  }

  if (role === "auditor") {
    // bug-fix-merge-worktree deception_audit: an honest account of the owned
    // fixture reproduction (never a DECEPTION verdict for the synthetic fix).
    return {
      overrides: {
        VERDICT: "HONEST",
        FINDING: "synthetic audit: the reproduction account matches the owned fixture change",
        STATUS: "done",
      },
    };
  }

  if (role === "tester") {
    const testCmd = readKey(input, "TEST_CMD");
    let outcome = "no TEST_CMD in prompt";
    if (testCmd) {
      const r = runProc("/bin/sh", ["-c", testCmd], { cwd: repo });
      outcome = `packed tamandua-test rc=${r.status ?? "signal"}`;
      if (r.status !== 0) {
        outcome += ` stderr=${(r.stderr || "").trim().slice(0, 400)}`;
      }
    }
    const testedTree = gitMust(["rev-parse", "HEAD^{tree}"], repo);
    return {
      overrides: {
        RESULTS: outcome,
        TESTED_TREE: testedTree,
        STATUS: "done",
      },
    };
  }

  if (role === "merger") {
    return { customReport: runSyntheticMerger(input, cli, repo) };
  }

  if (role === "reviewer") {
    return { overrides: { VERDICT: "ACCEPT", FINDING: "synthetic gate TEST_CMD unchanged", STATUS: "done" } };
  }

  return { overrides: {} };
}

function runMergeBranch(cli, origin, branch, into, expectTip, message) {
  return cli([
    "merge-branch",
    "--origin", origin,
    "--branch", branch,
    "--into", into,
    "--expect-tip", expectTip,
    "--message", message,
  ]);
}

/**
 * Synthetic finalizer. First invocation deterministically exercises the real
 * target_moved -> rebase -> retest loop on OWNED fixture refs:
 *   1. an external-actor advance of the target ref (same-tree commit, owned),
 *   2. a merge-branch attempt with the now-stale expect-tip => exit 2,
 *   3. rebase the feature worktree onto the advanced target and reply
 *      STATUS: retry so the tester re-validates the rebased tree.
 * The second invocation re-reads the (now-FF-safe) target and lands for real.
 * It also runs a recording-only no-op control against the target itself.
 */
function runSyntheticMerger(input, cli, repo) {
  const runId = stripIdPrefix(readKey(input, "RUN_ID"));
  const branch = readKey(input, "BRANCH");
  const originalBranch = readKey(input, "ORIGINAL_BRANCH");
  const origin = readKey(input, "ORIGIN_REPOSITORY") || readKey(input, "WORKTREE_ORIGIN_REPOSITORY");
  if (!origin || !branch || !originalBranch) {
    return `STATUS: failed\nREASON: merger prompt missing origin/branch/original_branch (origin=${origin}, branch=${branch}, into=${originalBranch})`;
  }
  const sentinel = `refs/tamandua-synthetic/rebased-${runId}`;
  const alreadyRebased = gitProbe(["rev-parse", "--verify", "--quiet", sentinel], origin).status === 0;
  const targetRef = `refs/heads/${originalBranch}`;
  const expectTip = gitMust(["rev-parse", targetRef], origin);
  const message = `feat: synthetic whole-path gate squash merge (${branch})\n\n${COAUTHOR}\n`;

  if (!alreadyRebased) {
    // ── recording-only no-op control (branch == target => NOOP landed) ──
    const noop = runMergeBranch(cli, origin, originalBranch, originalBranch, expectTip, `chore: synthetic noop control\n\n${COAUTHOR}\n`);
    const noopOut = (noop.stdout || "").trim();

    // ── external-actor advance of the OWNED target ref ──
    const tree = gitMust(["rev-parse", `${expectTip}^{tree}`], origin);
    const marker = gitMust(
      ["commit-tree", tree, "-p", expectTip, "-m", "synthetic external actor advance (owned fixture)"],
      origin,
    );
    gitMust(["update-ref", targetRef, marker], origin);

    // ── real merge-branch attempt with the stale expect-tip: the host refuses
    // the moved tip (typed MERGE_TIP, before any Git) or the guest core reports
    // target_moved. Either way this is the real target-moved refusal. ──
    const moved = runMergeBranch(cli, origin, branch, originalBranch, expectTip, message);
    const movedOut = (moved.stdout || "").trim();
    const movedErr = (moved.stderr || "").trim();
    const combined = `${movedOut}\n${movedErr}`;
    const isMoved = moved.status === 2 || /target_moved|target tip|MERGE_TIP|moved|tip/i.test(combined);
    if (!isMoved) {
      return `STATUS: failed\nREASON: expected a target-moved refusal after the owned external-actor advance, got rc=${moved.status}: ${combined.slice(0, 400)}`;
    }

    // ── rebase the feature worktree onto the advanced target, retest next ──
    gitMust(["rebase", marker], repo);
    gitMust(["update-ref", sentinel, marker], origin);
    appendProgress(
      `- merger target_moved control: noop(${noopOut.slice(0, 120)}); stale-merge rc=${moved.status} out=${combined.replace(/\s+/g, " ").slice(0, 240)}; rebased onto ${marker}`,
    );
    return [
      movedOut,
      "REBASED: true",
      `CONFLICT_NOTES: target moved to ${marker}; synthetic branch rebased in the worktree`,
      "RETRY_STEP: test",
      "STATUS: retry",
    ].join("\n");
  }

  const landed = runMergeBranch(cli, origin, branch, originalBranch, expectTip, message);
  const out = (landed.stdout || "").trim();
  const mergedTree = (out.match(/^MERGED_TREE:\s*(\S+)/m) || [])[1] || "";
  const mergedCommit = (out.match(/^MERGED_COMMIT:\s*(\S+)/m) || [])[1] || "";
  const ok = landed.status === 0 && /^STATUS:\s*landed/m.test(out);
  return [
    out,
    `REBASED: false`,
    `MERGE_COMMIT: ${mergedCommit.slice(0, 12)}`,
    `MERGED_INTO: ${originalBranch}`,
    `MERGED_TREE: ${mergedTree}`,
    ok ? "STATUS: done" : `STATUS: failed\nREASON: synthetic merge-branch rc=${landed.status}: ${(landed.stderr || out).slice(0, 400)}`,
  ].join("\n");
}

// ── main ──────────────────────────────────────────────────────────────────
const prompt = process.argv[process.argv.length - 1] ?? "";
if (isHarnessProbePrompt(prompt)) runProbe(prompt);

const parsed = parseWorkPrompt(prompt);
if (!parsed) {
  emitMessageEnd("STATUS: failed\nREASON: synthetic pi could not parse a work prompt", 20);
  process.exit(0);
}
const { workflowId, agentId, runId, cliPath, shortAgent } = parsed;
const cli = createCli(cliPath);
const cwd = process.cwd();

const claim = cli(["step", "claim", agentId, "--run-id", runId]);
if (claim.status !== 0) {
  emitMessageEnd("STATUS: failed\nREASON: step claim failed: " + (claim.stderr || claim.stdout || "").slice(0, 500), 20);
  process.exit(0);
}
const claimRaw = claim.stdout.trim();
if (claimRaw.includes("NO_WORK")) {
  emitMessageEnd("NO_WORK_AVAILABLE", 5);
  process.exit(0);
}

let claimed;
try {
  claimed = JSON.parse(claimRaw);
} catch {
  emitMessageEnd("STATUS: failed\nREASON: claim returned unparsable output: " + claimRaw.slice(0, 300), 20);
  process.exit(0);
}
const stepId = claimed.stepId;
const bareStepId = stripIdPrefix(stepId);
const bareRunId = stripIdPrefix(runId);

const report = buildReport(claimed.input ?? "");
let finalReport = report;
const tokens = 111;

// The guest progress document: /workspace/runs/<runId>/progress.txt is the
// ONLY host run-state export (RW exact mount of the host per-run
// progress-resource dir). The agent harness persona updates this document;
// the synthetic pi mirrors that with the harmless owned fixture action so the
// host <state>/runs/<runId>/progress-resource/progress.txt is persisted.
const progressDoc = `/workspace/runs/${bareRunId}/progress.txt`;
function appendProgress(...lines) {
  try {
    const now = new Date().toISOString();
    const entry = [`## ${now} - synthetic-pi (${agentId}, run ${runId}, step ${stepId})`, ...lines, ""].join("\n");
    fs.appendFileSync(progressDoc, entry, "utf-8");
  } catch (err) {
    process.stderr.write(`synthetic-pi: progress write failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
appendProgress(`- claimed step ${stepId} through the packed guest CLI (host broker)`);

try {
  // Harmless OWNED fixture action #1: marker under the mounted working dir
  // (host evidence retained after the VM is disposed).
  const markerDir = path.join(cwd, ".matchlock-synthetic-pi");
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(
    path.join(markerDir, `${shortAgent}-${bareRunId}.marker`),
    `synthetic-pi agent=${agentId} run=${runId} step=${stepId} cwd=${cwd}\n`,
    "utf-8",
  );

  // Harmless OWNED fixture action #2: packed tamandua-test with a trivial
  // passing command against the admitted git fixture repo (records a real
  // integer-exit row in the host-owned Matchlock suite SQLite store when the
  // host wired a suite-capable broker; otherwise real guest-local execution
  // with explicit incomplete evidence — never a recorded green).
  const suiteArgs = [
    "--repo", cwd,
    "--run", bareRunId,
    "--",
    "printf", "synthetic-pi-suite-ok\n",
  ];
  const suite = spawnSync(path.join("/workspace", "runtime", "bin", "tamandua-test"), suiteArgs, {
    encoding: "utf-8",
    cwd,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  {
    const suiteEnv = {
      enabled: process.env.TAMANDUA_GUEST_SUITE_ENABLED,
      socketDir: process.env.TAMANDUA_GUEST_SOCKET_DIR,
      hasSocket: !!process.env.TAMANDUA_GUEST_SOCKET,
      imageContent: process.env.TAMANDUA_GUEST_SUITE_IMAGE_CONTENT_ID || process.env.TAMANDUA_MATCHLOCK_IMAGE_CONTENT_ID,
      helperContract: process.env.TAMANDUA_GUEST_HELPER_CONTRACT,
    };
    appendProgress(
      `- packed tamandua-test rc=${suite.status} env=${JSON.stringify(suiteEnv)}`,
      `  stdout: ${(suite.stdout || "").split("\n").slice(0, 40).join("\n  ").slice(0, 1500)}`,
      `  stderr: ${(suite.stderr || "").split("\n").slice(0, 40).join("\n  ").slice(0, 1500)}`,
    );
  }
  if (suite.status !== 0) {
    process.stderr.write(
      `synthetic-pi: tamandua-test exited ${suite.status ?? "signal"}: ${(suite.stderr ?? "").slice(0, 800)}\n`,
    );
  }
} catch (err) {
  process.stderr.write(
    `synthetic-pi: fixture action failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
}

// Worktree-merge workflow roles: execute the real per-role protocol (stories,
// branch setup, owned commit, wrapped tamandua-test, scoped guest merge) AFTER
// the generic fixture action so the marker/progress evidence is retained.
if (isWorktreeMergeWorkflow(workflowId)) {
  try {
    const roleResult = handleWorktreeMergeRole(shortAgent, claimed.input ?? "", cli, runId, workflowId);
    if (roleResult && roleResult.customReport) {
      finalReport = roleResult.customReport;
    } else if (roleResult && roleResult.overrides) {
      finalReport = buildReportWithOverrides(claimed.input ?? "", roleResult.overrides);
    }
    appendProgress(`- role ${shortAgent} action complete`);
  } catch (err) {
    finalReport = `STATUS: failed\nREASON: synthetic ${shortAgent} role failed: ${
      err instanceof Error ? err.message : String(err)
    }`;
    appendProgress(`- role ${shortAgent} action FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Report through the host broker via the packed guest CLI; the report must
// satisfy the step's submit-time expects (STATUS + the Reply-with KEY lines).
appendProgress(`- fixture action done (marker + packed tamandua-test)`);
if (SILENT_WORK_STDOUT) {
  // US-006 reproduction: the step is completed below, but the harness emits
  // NOTHING on stdout (the lost-final-message defect path).
  appendProgress(`- US-006 knob: suppressing work-round stdout (step is still completed)`);
} else {
  emitToolAttribution(stepId, runId);
  emitMessageEnd(finalReport, tokens);
}
const complete = cli(["step", "complete", stepId], finalReport);
if (complete.status !== 0) {
  const errText = (complete.stderr || complete.stdout || "").slice(0, 600);
  process.stderr.write(`synthetic-pi: step complete failed: ${errText}\n`);
  // Retry via a guest temp file like the work prompt instructs.
  try {
    const reportFile = `/tmp/tamandua-report.${process.pid}`;
    fs.writeFileSync(reportFile, finalReport, "utf-8");
    const retry = cli(["step", "complete", stepId, "--file", reportFile]);
    fs.rmSync(reportFile, { force: true });
    if (retry.status !== 0) {
      if (!SILENT_WORK_STDOUT) emitMessageEnd("STATUS: failed\nREASON: step complete failed twice: " + (retry.stderr || retry.stdout || "").slice(0, 400), tokens);
      process.exit(0);
    }
  } catch (err2) {
    if (!SILENT_WORK_STDOUT) emitMessageEnd("STATUS: failed\nREASON: step complete file retry failed: " + String(err2).slice(0, 400), tokens);
    process.exit(0);
  }
}
process.exit(0);
