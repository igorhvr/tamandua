#!/usr/bin/env node
/**
 * fake-hermes.mjs — MTLK-HERMES-EXEC US-004 TEST-ONLY synthetic Hermes CLI.
 *
 * Installed INSIDE the EXPLICITLY TEST-ONLY derived synthetic-hermes fixture
 * image (e2e-tests/hermes-fixture/Dockerfile.synthetic-hermes) at
 * /usr/local/bin/hermes. It is a deterministic stand-in for the real Hermes
 * CLI that implements the EXACT plain-text guest contract the Matchlock Hermes
 * invocation runner (src/installer/matchlock/hermes-invocation-runner.ts)
 * consumes:
 *
 *   hermes --profile <name> chat --max-turns <n> --yolo -Q -q <prompt>
 *
 * Behaviors (deterministic; NO provider credentials, NO model calls, no
 * network anywhere):
 *
 *  1. LAUNCH-PROBE prompt  — the stable first line
 *     `TAMANDUA_HARNESS_PROBE: skill-path` — runs the quoted packed guest CLI
 *     command (`/workspace/runtime/bin/tamandua skill-path`) for real and
 *     replies on STDOUT with the PATH and nothing else (the runner strips any
 *     trailer; the trailer is emitted on STDERR so probe accounting is exact).
 *  2. WORK prompt — parses workflow/agent/run + the packed GUEST CLI path
 *     from the prompt (the same header/instructions the scheduler builds for
 *     pi), claims the pending step through the guest CLI (host broker),
 *     performs a harmless OWNED fixture action (marker file under the mounted
 *     working directory + packed `tamandua-test` with a trivial passing
 *     command against the admitted git fixture repo), then submits a report
 *     that satisfies the step's Reply-with/KEY shape and completes the step
 *     through the guest CLI. The report is also the plain-text final message
 *     on STDOUT.
 *  2b. WORK prompt for a story/merge workflow (feature-dev-merge-worktree and
 *     the capability-equivalent merge routes) — executes the genuine per-role
 *     protocol ported from e2e-tests/matchlock-fixture/synthetic-pi.mjs:
 *     planner emits STORIES_JSON/BRANCH, setup creates the feature branch and
 *     reports the raw TEST_CMD, developer/fixer commits an owned fixture
 *     change, tester runs the wrapped tamandua-test and attests TESTED_TREE,
 *     verifier attests TESTED_TREE, reviewer accepts, and the merger lands
 *     through the SCOPED guest `merge-branch` command — including a
 *     deterministic first-invocation target_moved -> rebase -> STATUS: retry
 *     loop and a second real landing. The plain-text final-message contract and
 *     the authoritative stderr `session_id:` trailer + mapped-store usage row
 *     are emitted for EVERY invocation including these story roles.
 *  3. Any OTHER prompt (direct runner persistence/concurrency fixtures) — a
 *     canned plain-text "chat" reply. No step is ever claimed.
 *
 * Session/usage semantics (mirrors the real CLI's quiet-mode trailer):
 *  - ONE authoritative `session_id: <id>` trailer line is printed on STDERR
 *    for EVERY invocation (probe AND work), so the runner can recover the
 *    exact session id from the authoritative stderr trailer.
 *  - ONE synthetic `sessions` row (id + input/output/cache_read/cache_write
 *    token columns) is written to `<HERMES_HOME>/state.db` BEFORE the trailer
 *    is emitted, under journal_mode=WAL, so the runner's trusted in-VM usage
 *    helper projects the exact total (input + output + cache_write) from the
 *    selected MAPPED store. cache_read is deliberately large and EXCLUDED
 *    from the total (never double counted).
 *  - Totals are FIXED per kind: probe 30+5+1 = 36; work 100+50+5 = 155;
 *    plain chat 70+20+3 = 93. Sessions persist across fresh VMs (each VM
 *    appends its own row to the SAME mounted state.db), which is exactly what
 *    the gate asserts (SQLite/WAL persistence + two-VM locking outcomes).
 *
 * Node-core only. `hermesHome` (guest HERMES_HOME) is REQUIRED: the fake
 * refuses to run with a host-path fallback or a guest default — the runner
 * always maps the admitted host config dir to the approved guest HERMES_HOME.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const HARNESS_PROBE_MARKER = "TAMANDUA_HARNESS_PROBE: skill-path";

// ── argv ───────────────────────────────────────────────────────────────────
// Runner launch argv: <binary> --profile <name> chat --max-turns <n> --yolo
// -Q -q <prompt>. The prompt is the FINAL argv element (buildHermesGuestLaunch
// always puts the prompt last). Stdin is closed (EOF) by the runner.
const argv = process.argv.slice(2);
const prompt = argv.length > 0 ? String(argv[argv.length - 1] ?? "") : "";

// ── helpers ────────────────────────────────────────────────────────────────
function isHarnessProbePrompt(text) {
  const firstLine = String(text ?? "").split(/\r?\n/, 1)[0] ?? "";
  return firstLine.trim() === HARNESS_PROBE_MARKER;
}

function parseHarnessProbeCommand(text) {
  const m = String(text ?? "").match(
    /Run the exact command "([^"]+)" and reply with the PATH and nothing else\./,
  );
  return m ? m[1] : null;
}

function splitCommand(cmd) {
  const out = [];
  let current = "";
  let inQuotes = false;
  for (const ch of String(cmd)) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === " " && !inQuotes) {
      if (current.length > 0) {
        out.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

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

function stripIdPrefix(id) {
  return String(id).replace(/^(run-|step-)/, "");
}

// Synchronous stdout/stderr writes: the runner closes stdin and captures the
// exec's raw streams; a plain async process.stdout.write followed by
// process.exit(0) can be truncated before the flush drains. fs.writeSync
// guarantees the full plain-text message + trailer reach the capture.
function writeOut(text) {
  fs.writeSync(1, String(text));
}
function writeErr(text) {
  fs.writeSync(2, String(text));
}

/** Extract the "Reply with:" KEY lines so the report matches step expects. */
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
  REPORT: "synthetic-hermes completed the harmless owned fixture action inside the fresh Matchlock VM",
  CHANGES: "synthetic-hermes: wrote marker and ran packed tamandua-test (fixture action)",
  TESTS: "packed tamandua-test exit recorded in host suite store",
  FEEDBACK: "synthetic fixture reviewer: no issues; work satisfies the task",
  ISSUES: "none",
  VERDICT: "accomplished",
  DETAILS: "synthetic-hermes fixture verifier confirms the owned fixture action succeeded",
  REASON: "synthetic-hermes completed successfully",
};

function buildReport(input) {
  const lines = [];
  for (const key of replyKeysFromInput(input)) {
    lines.push(`${key}: ${KEY_VALUES[key] ?? "synthetic-hermes fixture result"}`);
  }
  return lines.join("\n");
}

/** Build a report from the Reply-with keys, applying role-specific overrides. */
function buildReportWithOverrides(input, overrides) {
  const keys = replyKeysFromInput(input);
  const lines = [];
  for (const key of keys) {
    const value = overrides[key] ?? KEY_VALUES[key] ?? "synthetic-hermes fixture result";
    lines.push(`${key}: ${value}`);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!keys.includes(key)) lines.push(`${key}: ${value}`);
  }
  return lines.join("\n");
}

// ── worktree-merge workflow role support (US-007) ─────────────────────────
// The genuine bundled feature-dev-merge-worktree / bug-fix-merge-worktree
// workflows drive a story loop, a tester, and a finalizing squash merge. The
// synthetic hermes executes their per-role protocol deterministically inside
// the fresh VM, ported byte-for-byte from e2e-tests/matchlock-fixture/synthetic-pi.mjs
// (and its dsh sibling): planner emits stories, setup creates the feature
// branch, developer commits an owned fixture change, tester runs the wrapped
// tamandua-test, verifier approves, and the merger lands through the SCOPED
// guest `merge-branch` command with a real target advance — including a
// deterministic target_moved -> rebase -> retest loop on the first merger
// attempt (an owned external-actor advance, never a live branch).

const WORKTREE_MERGE_WORKFLOWS = new Set([
  "feature-dev-merge-worktree",
  "bug-fix-merge-worktree",
  // Capability-equivalent DIRECT merge routes: the same role protocol applies;
  // only the origin location differs and the handler reads whichever origin key
  // is present.
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
    const stories = [
      {
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
    appendProgress([
      `- merger target_moved control: noop(${noopOut.slice(0, 120)}); stale-merge rc=${moved.status} out=${combined.replace(/\s+/g, " ").slice(0, 240)}; rebased onto ${marker}`,
    ]);
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

function newSessionId(kind) {
  return `sess-${kind}-${Date.now().toString(16)}-${crypto.randomBytes(4).toString("hex")}`;
}

// ── store writer (synthetic sessions row, WAL) ─────────────────────────────
// Mirrors the real store the runner's trusted in-VM usage helper projects:
// <HERMES_HOME>/state.db with a `sessions` table carrying the four token
// columns (input/output/cache_read/cache_write). cache_read is written but
// never counted (input + output + cache_write only).
const TOKENS = {
  probe: { input: 30, output: 5, cacheRead: 0, cacheWrite: 1 },
  work: { input: 100, output: 50, cacheRead: 9999, cacheWrite: 5 },
  chat: { input: 70, output: 20, cacheRead: 0, cacheWrite: 3 },
};

function writeSessionRow(id, kind) {
  const hermesHome = process.env.HERMES_HOME || "";
  if (!hermesHome) {
    process.stderr.write("synthetic-hermes: HERMES_HOME unset; refusing host-default fallback\n");
    process.exit(5);
  }
  fs.mkdirSync(hermesHome, { recursive: true });
  const dbPath = path.join(hermesHome, "state.db");
  const t = TOKENS[kind] ?? TOKENS.chat;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec(
      "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER)",
    );
    db.prepare(
      "INSERT OR REPLACE INTO sessions (id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?)",
    ).run(id, t.input, t.output, t.cacheRead, t.cacheWrite);
  } finally {
    db.close();
  }
}

function emitTrailer(id) {
  writeErr(`\nsession_id: ${id}\n`);
}

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

function runProbe(promptText) {
  const cmd = parseHarnessProbeCommand(promptText);
  const sessionId = newSessionId("probe");
  if (cmd === null || cmd.length === 0) {
    writeSessionRow(sessionId, "probe");
    emitTrailer(sessionId);
    process.stderr.write("synthetic-hermes: probe prompt did not quote a command\n");
    process.exit(2);
  }
  const argvList = splitCommand(cmd);
  const r = spawnSync(argvList[0], argvList.slice(1), {
    encoding: "utf-8",
    cwd: process.cwd(),
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = (r.stdout ?? "").trim();
  const ok = r.status === 0 && stdout.length > 0;
  writeSessionRow(sessionId, "probe");
  // Per-invocation evidence marker (the mounted workdir is RW): lets the gate
  // cross-check the EXACT stderr-trailer session id against the mapped store.
  try {
    const runEnv = process.env.TAMANDUA_RUN_ID || "";
    const bareRun = stripIdPrefix(runEnv);
    const markerDir = path.join(process.cwd(), ".matchlock-synthetic-hermes");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, bareRun ? `probe-${bareRun}.marker` : `probe-${sessionId}.marker`),
      `synthetic-hermes probe session=${sessionId} run=${runEnv} cwd=${process.cwd()}\n`,
      "utf-8",
    );
  } catch {
    /* best effort — evidence marker is auxiliary */
  }
  if (ok) {
    writeOut(`${stdout}\n`);
  } else {
    process.stderr.write(
      `synthetic-hermes: probe command failed (exit ${r.status ?? "signal"}): ${(r.stderr ?? "").slice(0, 400)}\n`,
    );
  }
  emitTrailer(sessionId);
  process.exit(ok ? 0 : 1);
}

function appendProgress(lines) {
  // /workspace/runs/<runId>/progress.txt is the ONLY host run-state export
  // (RW exact mount of the host per-run progress-resource dir).
  try {
    const parsed = parseWorkPrompt(prompt);
    if (!parsed) return;
    const doc = `/workspace/runs/${stripIdPrefix(parsed.runId)}/progress.txt`;
    const entry = [`## ${new Date().toISOString()} - synthetic-hermes (${parsed.agentId}, run ${parsed.runId})`, ...lines, ""].join("\n");
    fs.appendFileSync(doc, entry, "utf-8");
  } catch {
    /* best effort — the gate asserts progress via the real host path */
  }
}

function runWork(parsed) {
  const { workflowId, agentId, runId, cliPath, shortAgent } = parsed;
  const sessionId = newSessionId("work");
  const cli = createCli(cliPath);
  const cwd = process.cwd();

  const claim = cli(["step", "claim", agentId, "--run-id", runId]);
  if (claim.status !== 0) {
    appendProgress([`- step claim FAILED: ${(claim.stderr || claim.stdout || "").slice(0, 500)}`]);
    writeOut("STATUS: failed\nREASON: synthetic-hermes step claim failed\n");
    process.stderr.write(`synthetic-hermes: claim failed: ${(claim.stderr || claim.stdout || "").slice(0, 500)}\n`);
    writeSessionRow(sessionId, "work");
    emitTrailer(sessionId);
    process.exit(0);
  }
  const claimRaw = claim.stdout.trim();
  if (claimRaw.includes("NO_WORK")) {
    writeOut("NO_WORK_AVAILABLE\n");
    writeSessionRow(sessionId, "work");
    emitTrailer(sessionId);
    process.exit(0);
  }
  let claimed;
  try {
    claimed = JSON.parse(claimRaw);
  } catch {
    appendProgress([`- claim returned unparsable output`]);
    writeOut("STATUS: failed\nREASON: synthetic-hermes claim returned unparsable output\n");
    process.stderr.write(`synthetic-hermes: unparsable claim: ${claimRaw.slice(0, 300)}\n`);
    writeSessionRow(sessionId, "work");
    emitTrailer(sessionId);
    process.exit(0);
  }
  const stepId = claimed.stepId;
  const bareStepId = stripIdPrefix(stepId);
  const bareRunId = stripIdPrefix(runId);
  appendProgress([`- claimed step ${stepId} through the packed guest CLI (host broker)`]);

  try {
    // Harmless OWNED fixture action #1: marker under the mounted working dir.
    const markerDir = path.join(cwd, ".matchlock-synthetic-hermes");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, `${shortAgent}-${bareStepId}-${bareRunId}.marker`),
      `synthetic-hermes agent=${agentId} run=${runId} step=${stepId} cwd=${cwd} session=${sessionId}\n`,
      "utf-8",
    );

    // Harmless OWNED fixture action #2: packed tamandua-test with a trivial
    // passing command against the admitted git fixture repo (records a real
    // integer-exit row in the host-owned Matchlock suite SQLite store when the
    // host wired a suite-capable broker). NOTE: --step is deliberately NOT
    // passed — the host suite service compares a request step id against the
    // host-bound step id spelling of the current lease and a mismatched
    // spelling is refused (DENIED); synthetic-pi's suite calls omit --step and
    // the host binds the record to the current step lease instead.
    const suiteArgs = [
      "--repo", cwd,
      "--run", bareRunId,
      "--",
      "printf", "synthetic-hermes-suite-ok\n",
    ];
    const suite = spawnSync(path.join("/workspace", "runtime", "bin", "tamandua-test"), suiteArgs, {
      encoding: "utf-8",
      cwd,
      env: process.env,
      maxBuffer: 16 * 1024 * 1024,
    });
    const suiteEnvNote = JSON.stringify({
      enabled: process.env.TAMANDUA_GUEST_SUITE_ENABLED,
      socketDir: process.env.TAMANDUA_GUEST_SOCKET_DIR,
      socket: process.env.TAMANDUA_GUEST_SOCKET,
      imageContent: process.env.TAMANDUA_GUEST_SUITE_IMAGE_CONTENT_ID || process.env.TAMANDUA_GUEST_IMAGE_CONTENT_ID || process.env.TAMANDUA_MATCHLOCK_IMAGE_CONTENT_ID,
      platform: process.env.TAMANDUA_GUEST_PLATFORM,
      helperContract: process.env.TAMANDUA_GUEST_HELPER_CONTRACT,
      fingerprint: process.env.TAMANDUA_GUEST_ENV_FINGERPRINT,
    });
    appendProgress([
      `- packed tamandua-test rc=${suite.status} suiteEnv=${suiteEnvNote}`,
      `  stdout: ${(suite.stdout || "").split("\n").slice(0, 40).join("\n  ").slice(0, 1500)}`,
      `  stderr: ${(suite.stderr || "").split("\n").slice(0, 40).join("\n  ").slice(0, 1500)}`,
    ]);
    if (suite.status !== 0) {
      process.stderr.write(
        `synthetic-hermes: tamandua-test exited ${suite.status ?? "signal"}: ${(suite.stderr ?? "").slice(0, 800)}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `synthetic-hermes: fixture action failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  let finalReport = buildReport(claimed.input ?? "");

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
      appendProgress([`- role ${shortAgent} action complete`]);
    } catch (err) {
      finalReport = `STATUS: failed\nREASON: synthetic hermes ${shortAgent} role failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      appendProgress([`- role ${shortAgent} action FAILED: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }

  appendProgress([`- fixture action done (marker + packed tamandua-test)`]);
  writeOut(`${finalReport}\n`);
  process.stderr.write(`synthetic-hermes: session recorded in mapped store\n`);
  writeSessionRow(sessionId, "work");
  emitTrailer(sessionId);

  // Complete the step through the host broker via the packed guest CLI.
  const complete = cli(["step", "complete", stepId], finalReport);
  if (complete.status !== 0) {
    const errText = (complete.stderr || complete.stdout || "").slice(0, 600);
    process.stderr.write(`synthetic-hermes: step complete failed: ${errText}\n`);
    try {
      const reportFile = `/tmp/tamandua-report.${process.pid}`;
      fs.writeFileSync(reportFile, finalReport, "utf-8");
      const retry = cli(["step", "complete", stepId, "--file", reportFile]);
      fs.rmSync(reportFile, { force: true });
      if (retry.status !== 0) {
        process.stderr.write(`synthetic-hermes: step complete file retry failed: ${(retry.stderr || retry.stdout || "").slice(0, 400)}\n`);
      }
    } catch (err2) {
      process.stderr.write(`synthetic-hermes: step complete file retry threw: ${String(err2).slice(0, 400)}\n`);
    }
  }
  process.exit(0);
}

function runPlainChat() {
  // Canned plain-text chat used by the direct runner persistence/concurrency
  // fixtures (prompts that are neither probe prompts nor parseable work
  // prompts). NO step is ever claimed.
  const sessionId = newSessionId("chat");
  const text =
    "synthetic-hermes plain chat finished — ✓ utf8 é\n" +
    "STATUS: done\n" +
    "CHANGES: persistence fixture\n" +
    "TESTS: synthetic-hermes\n";
  writeOut(text);
  process.stderr.write("synthetic-hermes: chat session recorded in mapped store\n");
  writeSessionRow(sessionId, "chat");
  emitTrailer(sessionId);
  process.exit(0);
}

// ── main dispatch ──────────────────────────────────────────────────────────
if (isHarnessProbePrompt(prompt)) {
  runProbe(prompt);
}

const parsed = parseWorkPrompt(prompt);
if (parsed) {
  runWork(parsed);
} else {
  runPlainChat();
}
