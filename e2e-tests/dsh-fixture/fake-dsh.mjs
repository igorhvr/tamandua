#!/usr/bin/env node
/**
 * fake-dsh.mjs — MTLK-DSH-EXEC US-003 TEST-ONLY synthetic dsh CLI.
 *
 * Installed INSIDE the EXPLICITLY TEST-ONLY derived synthetic-dsh fixture
 * images (e2e-tests/dsh-fixture/Dockerfile.synthetic-dsh*) at
 * /usr/local/bin/dsh (or /opt/dsh-custom/bin/dsh in the nonstandard-PATH
 * variant). It is a deterministic stand-in for the REAL dsh CLI that
 * implements the EXACT plain-text guest contract the Matchlock dsh invocation
 * runner (src/installer/matchlock/dsh-invocation-runner.ts) consumes:
 *
 *   dsh --profile headless <prompt>     (stdin closed; plain stdout)
 *
 * Behaviors (deterministic; NO provider credentials, NO model calls, no
 * network anywhere):
 *
 *  1. LAUNCH-PROBE prompt — the stable first line
 *     `TAMANDUA_HARNESS_PROBE: skill-path` — runs the quoted packed guest CLI
 *     command (`/workspace/runtime/bin/tamandua skill-path`) for real and
 *     replies on STDOUT with the PATH and NOTHING else (any trailer goes to
 *     STDERR so probe accounting is exact).
 *  2. WORK prompt — parses workflow/agent/run + the packed GUEST CLI path
 *     from the prompt (the same header/instructions the scheduler builds for
 *     every Matchlock backend), claims the pending step through the guest CLI
 *     (host broker), performs a harmless OWNED fixture action (marker file
 *     under the mounted working directory + packed `tamandua-test` with a
 *     trivial passing command against the admitted git fixture repo), then
 *     submits a report that satisfies the step's Reply-with/KEY shape and
 *     completes the step through the guest CLI. The report is also the
 *     plain-text final message on STDOUT.
 *  2b. WORK prompt for a story/merge workflow (feature-dev-merge-worktree and
 *     the capability-equivalent merge routes) — executes the genuine per-role
 *     protocol ported from e2e-tests/matchlock-fixture/synthetic-pi.mjs:
 *     planner emits STORIES_JSON/BRANCH, setup creates the feature branch and
 *     reports the raw TEST_CMD, developer/fixer commits an owned fixture
 *     change, tester runs the wrapped tamandua-test and attests TESTED_TREE,
 *     verifier attests TESTED_TREE, reviewer accepts, and the merger lands
 *     through the SCOPED guest `merge-branch` command — including a
 *     deterministic first-invocation target_moved -> rebase -> STATUS: retry
 *     loop and a second real landing. Non-merge workflows keep the generic
 *     report behavior byte-identically.
 *  3. Any OTHER prompt (direct runner persistence/mapping/concurrency
 *     fixtures) — a canned plain-text "chat" reply; also writes a
 *     whole-home persistence probe file under $DSH_HOME (see below). No step
 *     is ever claimed.
 *
 * Session/usage semantics (mirrors the REAL dsh >= 0.1.5 v3 store shape the
 * host scheduler attributes from the MOUNTED DSH_HOME — see dsh-contract.json
 * and the DSV2 / MTLK-DSH-EXEC v3 contract):
 *  - EVERY invocation (probe/work/chat) creates EXACTLY ONE new ROOT session
 *    directory `$DSH_HOME/sessions/<projectKey(cwd)>/session-<uuid>/` whose
 *    single current-generation artifact is the PLAIN `session.v3.jsonl`
 *    (header `{type:"session",version:3,...}` first line + exactly one
 *    well-formed `assistant/message` record whose `data.usage.inputTokens` +
 *    `outputTokens` is the intended total; the identical usage mirror inside
 *    `data.stream[*].chunk.usage` is included so a double-counting reader
 *    would be caught end-to-end).
 *  - Totals are FIXED per kind: probe 36 (30+6), work 155 (100+55),
 *    chat 90 (70+20). Sessions persist across fresh VMs (each VM appends its
 *    own session dir to the SAME mounted DSH_HOME), which is exactly what the
 *    gate asserts for whole-home RW-mount persistence.
 *  - The fixture refuses to run when DSH_HOME is unset (never a host-default
 *    fallback) — the runner always maps the admitted host config dir to the
 *    guest DSH_HOME /workspace/config/dsh.
 *
 * Whole-home persistence probe (chat mode): every chat invocation also writes
 * `$DSH_HOME/.gate-writes/<invocation-uuid>.json` (metadata marker) and prints
 * `GATE-WRITES-SEEN:<n>` where n is the number of .gate-writes entries that
 * already existed — so a SECOND fresh VM on the same mounted home observes
 * the FIRST VM's write (one RW mount, never a copied/selective subset).
 *
 * Node-core only (node >= 22 in the fixture image).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const HARNESS_PROBE_MARKER = "TAMANDUA_HARNESS_PROBE: skill-path";

// DSH-PROFILE-OVERLAY US-005 deterministic zero-provider probes. Both are
// plain prompt-marker modes (the launch argv is `dsh --profile headless
// <prompt>`), so no guest env injection is needed:
//  - NATIVE heal: run on the HOST by the contained regression gate, standing
//    in for the real `healProfilesModuleFallback`, and rewriting the synthetic
//    host farm to point at the host-side install root;
//  - FIRST REQUEST: run IN THE VM, resolving the request-extension module
//    through the guest's PRIVATE per-run overlay farm and writing only
//    guest-install links there.
const NATIVE_HEAL_MARKER = "SYNTHETIC-DSH-NATIVE-HEAL";
const FIRST_REQUEST_MARKER = "SYNTHETIC-DSH-FIRST-REQUEST";
const NATIVE_INSTALL_ROOT_ENV = "SYNTHETIC_DSH_INSTALL_ROOT";
// The guest install root is fixed inside the VM; the fast helper test overrides
// it to a scratch dir so it never writes to the host's /opt.
const GUEST_INSTALL_ROOT =
  (process.env.SYNTHETIC_DSH_GUEST_INSTALL_ROOT || "").trim() ||
  "/opt/synthetic-guest-install";
const FIRST_REQUEST_PLUGIN = "synthetic-first-request-plugin";
const PROFILE_OWNED_PLUGIN = "synthetic-profile-owned-plugin";
const NATIVE_FARM_PACKAGES = [
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-headless",
  "commander",
  "undici",
];

// Intended synthetic token totals (input + output ONLY; the stream mirror is
// included in the artifact but must never be summed).
const TOKENS = {
  probe: { input: 30, output: 6 }, // 36
  work: { input: 100, output: 55 }, // 155
  chat: { input: 70, output: 20 }, // 90
};

// ── argv ───────────────────────────────────────────────────────────────────
// Runner launch argv: dsh --profile headless <prompt> (a leading-dash prompt
// carries two `--` separators). The prompt is the FINAL argv element. Stdin is
// closed (EOF) by the runner.
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
  REPORT: "synthetic-dsh completed the harmless owned fixture action inside the fresh Matchlock VM",
  CHANGES: "synthetic-dsh: wrote marker and ran packed tamandua-test (fixture action)",
  TESTS: "packed tamandua-test exit recorded in host suite store",
  FEEDBACK: "synthetic fixture reviewer: no issues; work satisfies the task",
  ISSUES: "none",
  VERDICT: "accomplished",
  DETAILS: "synthetic-dsh fixture verifier confirms the owned fixture action succeeded",
  REASON: "synthetic-dsh completed successfully",
};

function buildReport(input) {
  const lines = [];
  for (const key of replyKeysFromInput(input)) {
    lines.push(`${key}: ${KEY_VALUES[key] ?? "synthetic-dsh fixture result"}`);
  }
  return lines.join("\n");
}

/** Build a report from the Reply-with keys, applying role-specific overrides. */
function buildReportWithOverrides(input, overrides) {
  const keys = replyKeysFromInput(input);
  const lines = [];
  for (const key of keys) {
    const value = overrides[key] ?? KEY_VALUES[key] ?? "synthetic-dsh fixture result";
    lines.push(`${key}: ${value}`);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!keys.includes(key)) lines.push(`${key}: ${value}`);
  }
  return lines.join("\n");
}

// ── worktree-merge workflow role support (US-006) ─────────────────────────
// The genuine bundled feature-dev-merge-worktree / bug-fix-merge-worktree
// workflows drive a story loop, a tester, and a finalizing squash merge. The
// synthetic dsh executes their per-role protocol deterministically inside the
// fresh VM, ported byte-for-byte from e2e-tests/matchlock-fixture/synthetic-pi.mjs:
// planner emits stories, setup creates the feature branch, developer commits an
// owned fixture change, tester runs the wrapped tamandua-test, verifier
// approves, and the merger lands through the SCOPED guest `merge-branch`
// command with a real target advance — including a deterministic
// target_moved -> rebase -> retest loop on the first merger attempt (an owned
// external-actor advance, never a live branch).

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

// ── dsh v3 store writer (one ROOT session dir per invocation) ─────────────
// Mirrors the real dsh >= 0.1.5 store the host scheduler's confined bounded
// read projects:
// $DSH_HOME/sessions/<projectKey(cwd)>/<session-<uuid>>/session.v3.jsonl
// (PLAIN encoding only — never both encodings, which would be ambiguous).
// The header is a v3 root (no parentSession, no origin) so the created
// session is a verifiable root for attribution.

/** Byte-identical to src/installer/matchlock/dsh-session-store.ts matchlockProjectKey. */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

function dshHomeRequired() {
  const home = process.env.DSH_HOME || "";
  if (!home) {
    process.stderr.write("synthetic-dsh: DSH_HOME unset; refusing host-default fallback\n");
    process.exit(5);
  }
  return home;
}

function writeSessionRecord(kind) {
  const dshHome = dshHomeRequired();
  const cwd = process.cwd();
  const id = newSessionId(kind);
  const t = TOKENS[kind] ?? TOKENS.chat;
  const projectDir = path.join(dshHome, "sessions", projectKey(cwd));
  const sessionDir = path.join(projectDir, `session-${id}`);
  fs.mkdirSync(sessionDir, { recursive: true });
  const artifact = path.join(sessionDir, "session.v3.jsonl");
  const header = {
    type: "session",
    version: 3,
    id,
    createdAt: Date.now(),
    cwd,
    isSeeded: false,
    delegationDepth: 0,
  };
  // usage record: message-level data.usage (counted once) + an identical
  // mirror under data.stream[*].chunk.usage (never summed by the reader).
  const usageRecord = {
    type: "assistant/message",
    data: {
      message: { role: "assistant" },
      usage: { inputTokens: t.input, outputTokens: t.output },
      stream: [
        {
          chunk: {
            type: "usage",
            usage: { inputTokens: t.input, outputTokens: t.output },
          },
        },
      ],
    },
  };
  const text = `${JSON.stringify(header)}\n${JSON.stringify(usageRecord)}\n`;
  fs.writeFileSync(artifact, text, "utf-8");
  return id;
}

function emitTrailer(id, kind) {
  process.stderr.write(`\nsynthetic-dsh ${kind} session: ${id}\n`);
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
  if (cmd === null || cmd.length === 0) {
    process.stderr.write("synthetic-dsh: probe prompt did not quote a command\n");
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
  // A session is recorded only for a SUCCESSFUL probe round (a failed probe
  // never fabricates usage; the run fails at the probe gate anyway).
  let sessionId = null;
  if (ok) {
    sessionId = writeSessionRecord("probe");
    // Per-invocation evidence marker (the mounted workdir is RW): lets the gate
    // cross-check the session id against the mapped store.
    try {
      const runEnv = process.env.TAMANDUA_RUN_ID || "";
      const bareRun = stripIdPrefix(runEnv);
      const markerDir = path.join(process.cwd(), ".matchlock-synthetic-dsh");
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(
        path.join(markerDir, bareRun ? `probe-${bareRun}.marker` : `probe-${sessionId}.marker`),
        `synthetic-dsh probe session=${sessionId} run=${runEnv} cwd=${process.cwd()}\n`,
        "utf-8",
      );
    } catch {
      /* best effort — evidence marker is auxiliary */
    }
  }
  if (ok) {
    process.stdout.write(`${stdout}\n`);
  } else {
    process.stderr.write(
      `synthetic-dsh: probe command failed (exit ${r.status ?? "signal"}): ${(r.stderr ?? "").slice(0, 400)}\n`,
    );
  }
  if (sessionId !== null) emitTrailer(sessionId, "probe");
  process.exit(ok ? 0 : 1);
}

function appendProgress(lines) {
  // /workspace/runs/<runId>/progress.txt is the ONLY host run-state export
  // (RW exact mount of the host per-run progress-resource dir).
  try {
    const parsed = parseWorkPrompt(prompt);
    if (!parsed) return;
    const doc = `/workspace/runs/${stripIdPrefix(parsed.runId)}/progress.txt`;
    const entry = [`## ${new Date().toISOString()} - synthetic-dsh (${parsed.agentId}, run ${parsed.runId})`, ...lines, ""].join("\n");
    fs.appendFileSync(doc, entry, "utf-8");
  } catch {
    /* best effort — the gate asserts progress via the real host path */
  }
}

function runWork(parsed) {
  const { workflowId, agentId, runId, cliPath, shortAgent } = parsed;
  const cli = createCli(cliPath);
  const cwd = process.cwd();

  const claim = cli(["step", "claim", agentId, "--run-id", runId]);
  if (claim.status !== 0) {
    appendProgress([`- step claim FAILED: ${(claim.stderr || claim.stdout || "").slice(0, 500)}`]);
    process.stdout.write("STATUS: failed\nREASON: synthetic-dsh step claim failed\n");
    process.stderr.write(`synthetic-dsh: claim failed: ${(claim.stderr || claim.stdout || "").slice(0, 500)}\n`);
    process.exit(0);
  }
  const claimRaw = claim.stdout.trim();
  if (claimRaw.includes("NO_WORK")) {
    process.stdout.write("NO_WORK_AVAILABLE\n");
    process.exit(0);
  }
  let claimed;
  try {
    claimed = JSON.parse(claimRaw);
  } catch {
    appendProgress([`- claim returned unparsable output`]);
    process.stdout.write("STATUS: failed\nREASON: synthetic-dsh claim returned unparsable output\n");
    process.stderr.write(`synthetic-dsh: unparsable claim: ${claimRaw.slice(0, 300)}\n`);
    process.exit(0);
  }
  const stepId = claimed.stepId;
  const bareStepId = stripIdPrefix(stepId);
  const bareRunId = stripIdPrefix(runId);
  // A session is recorded only once the round actually owns a step (a
  // NO_WORK / failed claim round creates no session and no fabricated usage).
  const sessionId = writeSessionRecord("work");
  appendProgress([`- claimed step ${stepId} through the packed guest CLI (host broker)`]);

  try {
    // Harmless OWNED fixture action #1: marker under the mounted working dir.
    const markerDir = path.join(cwd, ".matchlock-synthetic-dsh");
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, `${shortAgent}-${bareStepId}-${bareRunId}.marker`),
      `synthetic-dsh agent=${agentId} run=${runId} step=${stepId} cwd=${cwd} session=${sessionId}\n`,
      "utf-8",
    );

    // Harmless OWNED fixture action #2: packed tamandua-test with a trivial
    // passing command against the admitted git fixture repo (records a real
    // integer-exit row in the host-owned Matchlock suite SQLite store when the
    // host wired a suite-capable broker).
    const suiteArgs = [
      "--repo", cwd,
      "--run", bareRunId,
      "--",
      "printf", "synthetic-dsh-suite-ok\n",
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
      imageContent: process.env.TAMANDUA_GUEST_IMAGE_CONTENT_ID || process.env.TAMANDUA_MATCHLOCK_IMAGE_CONTENT_ID,
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
        `synthetic-dsh: tamandua-test exited ${suite.status ?? "signal"}: ${(suite.stderr ?? "").slice(0, 800)}\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `synthetic-dsh: fixture action failed: ${err instanceof Error ? err.message : String(err)}\n`,
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
      finalReport = `STATUS: failed\nREASON: synthetic dsh ${shortAgent} role failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      appendProgress([`- role ${shortAgent} action FAILED: ${err instanceof Error ? err.message : String(err)}`]);
    }
  }

  appendProgress([`- fixture action done (marker + packed tamandua-test)`]);
  process.stdout.write(`${finalReport}\n`);
  process.stderr.write(`synthetic-dsh: session recorded in mapped store\n`);
  emitTrailer(sessionId, "work");

  // Complete the step through the host broker via the packed guest CLI.
  const complete = cli(["step", "complete", stepId], finalReport);
  if (complete.status !== 0) {
    const errText = (complete.stderr || complete.stdout || "").slice(0, 600);
    process.stderr.write(`synthetic-dsh: step complete failed: ${errText}\n`);
    try {
      const reportFile = `/tmp/tamandua-report.${process.pid}`;
      fs.writeFileSync(reportFile, finalReport, "utf-8");
      const retry = cli(["step", "complete", stepId, "--file", reportFile]);
      fs.rmSync(reportFile, { force: true });
      if (retry.status !== 0) {
        process.stderr.write(`synthetic-dsh: step complete file retry failed: ${(retry.stderr || retry.stdout || "").slice(0, 400)}\n`);
      }
    } catch (err2) {
      process.stderr.write(`synthetic-dsh: step complete file retry threw: ${String(err2).slice(0, 400)}\n`);
    }
  }
  process.exit(0);
}

function runPlainChat() {
  // Canned plain-text chat used by the direct runner persistence/mapping/
  // concurrency fixtures (prompts that are neither probe prompts nor parseable
  // work prompts). NO step is ever claimed. Writes ONE root session + whole-
  // home persistence markers under $DSH_HOME across the REAL home categories
  // (profiles/storages/credentials/unknown entries — synthetic marker content
  // only, NO real credentials) so a LATER fresh VM observes THIS VM's writes
  // through the same RW mount (one mount, never a copied/selective subset).
  const sessionId = writeSessionRecord("chat");
  const dshHome = process.env.DSH_HOME || "";
  let seen = 0;
  const writeDir = path.join(dshHome, ".gate-writes");
  try {
    if (fs.existsSync(writeDir)) {
      seen = fs.readdirSync(writeDir).filter((f) => f.endsWith(".json")).length;
    }
    fs.mkdirSync(writeDir, { recursive: true });
    fs.writeFileSync(
      path.join(writeDir, `${sessionId}.json`),
      JSON.stringify({ session: sessionId, cwd: process.cwd(), ts: Date.now() }),
      "utf-8",
    );
    // Category-preservation markers (fresh content each VM; never real data):
    // the gate asserts each category dir gained exactly one entry per VM and
    // that VM B sees VM A's entries still present on the same mount.
    const categoryMarkers = [
      ["profiles", path.join("profiles", "headless", `.gate-profile-${sessionId}`)],
      ["storages", path.join("storages", "gate", `${sessionId}.json`)],
      ["credentials", path.join("credentials", "gate", `${sessionId}.marker`)],
      ["unknown", path.join(".gate-unknown-entries", `${sessionId}.marker`)],
    ];
    for (const [, rel] of categoryMarkers) {
      const abs = path.join(dshHome, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, `synthetic-dsh gate persistence marker ${sessionId} (no real credentials)\n`, "utf-8");
    }
  } catch {
    /* best effort — persistence probe is auxiliary */
  }
  const text =
    "synthetic-dsh plain chat finished — ✓ utf8 é\n" +
    `GATE-WRITES-SEEN:${seen}\n` +
    "STATUS: done\n" +
    "CHANGES: persistence fixture\n" +
    "TESTS: synthetic-dsh\n";
  process.stdout.write(text);
  process.stderr.write("synthetic-dsh: chat session recorded in mapped store\n");
  emitTrailer(sessionId, "chat");
  process.exit(0);
}

// ── DSH-PROFILE-OVERLAY US-005 probes ─────────────────────────────────────
// Validate the synthetic home carries the REAL headless profile layout
// (package.json with dsh.profile.bundles) before either probe touches a farm.
function requireHeadlessProfileLayout(dshHome) {
  const pkgPath = path.join(dshHome, "profiles", "headless", "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  } catch (err) {
    process.stderr.write(
      `synthetic-dsh: headless profile layout missing at ${pkgPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(4);
  }
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || bundles.length === 0) {
    process.stderr.write(
      `synthetic-dsh: headless profile manifest ${pkgPath} declares no dsh.profile.bundles\n`,
    );
    process.exit(4);
  }
}

// Drop every DIRECT symlink in a farm directory so the deterministic native
// heal's result does not depend on whatever mismatched fixture seeds were
// present. Never follows a link and never touches real files/dirs.
function clearDirectLinks(modulesDir) {
  let entries;
  try {
    entries = fs.readdirSync(modulesDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      fs.rmSync(path.join(modulesDir, entry.name), { recursive: true, force: true });
    }
  }
}

// Rewrite one farm directory so every package name points at `installRoot`,
// exactly as the real `healProfilesModuleFallback` retargets its closure. Real
// package dirs + manifests are created under the install root so the links
// RESOLVE (the first-request probe reads the manifest through the link).
function healFarmDir(modulesDir, installRoot, packageNames) {
  fs.mkdirSync(modulesDir, { recursive: true });
  let linked = 0;
  for (const name of packageNames) {
    const packageDir = path.join(installRoot, "node_modules", name);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name, version: "1.0.0" }, null, 2)}\n`,
      "utf-8",
    );
    const link = path.join(modulesDir, name);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(packageDir, link);
    linked += 1;
  }
  return linked;
}

// HOST-side native zero-provider boot: heal the synthetic host farm. NO
// session, NO usage, NO provider/network access — the whole effect is the
// deterministic farm rewrite the real dsh boot would perform.
function runNativeHeal() {
  const dshHome = dshHomeRequired();
  requireHeadlessProfileLayout(dshHome);
  const installRoot = (process.env[NATIVE_INSTALL_ROOT_ENV] || "").trim();
  if (!installRoot || !path.isAbsolute(installRoot)) {
    process.stderr.write(
      `synthetic-dsh: native heal requires an absolute ${NATIVE_INSTALL_ROOT_ENV} (got ${JSON.stringify(installRoot)})\n`,
    );
    process.exit(6);
  }
  const sharedFarm = path.join(dshHome, "profiles", "node_modules");
  const profileFarm = path.join(dshHome, "profiles", "headless", "node_modules");
  clearDirectLinks(sharedFarm);
  clearDirectLinks(profileFarm);
  const shared = healFarmDir(sharedFarm, installRoot, NATIVE_FARM_PACKAGES);
  const profileOwned = healFarmDir(profileFarm, installRoot, [PROFILE_OWNED_PLUGIN]);
  process.stdout.write(
    `NATIVE-HEAL: links=${shared + profileOwned} install=${installRoot} home=${dshHome}\n`,
  );
  process.exit(0);
}

// ── DSH-PROFILE-OVERLAY US-003: real boot sibling artifacts ───────────────
// The real dsh boot heals the module fallback under `$DSH_HOME/profiles`:
// `healProfilesModuleFallback` creates `profiles/node_modules` and then takes
// the cross-process writer lock at `profiles/node_modules.lock`
// (`withFileLock` -> `writeFile('<modulesDir>.lock', { flag: 'wx', mode: 0o600 })`),
// whose parent is `profiles/` itself — NOT the mounted `node_modules`
// destination. Run #32's launch probe died with
//   Error: ENOENT: no such file or directory, open '<profiles>/node_modules.lock'
// because the old per-child plan never gave the guest a real writable
// `profiles/` parent. The probe below performs that same exclusive-create
// sibling lock (plus one durable, non-lock sibling write) so the deterministic
// regression fails on the old per-child plan and passes only when `profiles/`
// is a real writable directory.
const BOOT_SIBLING_LOCK_BASENAME = "node_modules.lock";
const BOOT_SIBLING_MARKER_BASENAME = "node_modules.synthetic-boot-marker";
const BOOT_SIBLING_FAILURE_EXIT = 8;
// DSH-PROFILE-OVERLAY US-004: the real dsh holds the `withFileLock` sibling
// lock across the whole `healProfilesModuleFallback` module heal (pnpm work, on
// the order of seconds). The in-VM first-request prompt may ask the fixture to
// hold the lock for an explicit window (`SYNTHETIC-DSH-BOOT-LOCK-HOLD:<ms>`) so
// the on-host DshOverlayObserver can capture the transient lock deterministically.
// Without the marker the lock is released immediately (fast US-003 controls).
const BOOT_SIBLING_HOLD_MARKER = "SYNTHETIC-DSH-BOOT-LOCK-HOLD";
const BOOT_SIBLING_HOLD_MAX_MS = 30_000;

/** Parse `<BOOT_SIBLING_HOLD_MARKER>:<ms>` from the prompt (0 => no hold). */
function parseBootSiblingHoldMs(promptText) {
  const m = String(promptText ?? "").match(
    new RegExp(`${BOOT_SIBLING_HOLD_MARKER}:(\\d+)`),
  );
  if (!m) return 0;
  const ms = Number.parseInt(m[1], 10);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(ms, BOOT_SIBLING_HOLD_MAX_MS);
}

/** Synchronous bounded sleep (Node-core only; no busy spin, no child process). */
function sleepSyncMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The exact production failure text for a boot sibling lock that cannot be
 * created. A genuine `ENOENT` is emitted verbatim; any other non-creatable
 * parent (e.g. `EACCES` on a read-only `profiles/`) keeps the real OS error as
 * a first diagnostic line and then reproduces run #32's exact error shape, so
 * the fixture always speaks the production failure contract.
 */
function bootSiblingLockErrorText(lockPath, err) {
  const real = err instanceof Error ? String(err) : String(err);
  if (/^Error: ENOENT: no such file or directory, open /.test(real)) return real;
  return `${real}\nError: ENOENT: no such file or directory, open '${lockPath}'`;
}

/**
 * Perform the REAL dsh boot sibling write set under `$DSH_HOME/profiles`:
 *   1. exclusively create `profiles/node_modules.lock` (flags `wx`, mode
 *      `0o600`), exactly like `withFileLock`; and
 *   2. write one durable, non-lock sibling marker next to the farm.
 * Both are removed again in a `finally` block (the real lock releases after the
 * heal; the marker only proves the sibling write path). When `holdMs > 0` the
 * lock is HELD for that bounded window before release (the real heal duration),
 * so the on-host observer can capture it. On failure the probe prints the
 * production `Error: ENOENT ... node_modules.lock` shape and exits non-zero, so
 * a layout without a real writable `profiles/` parent reproduces run #32
 * instead of silently succeeding.
 */
function runBootSiblingProbe(dshHome, holdMs = 0) {
  const profilesDir = path.join(dshHome, "profiles");
  const lockPath = path.join(profilesDir, BOOT_SIBLING_LOCK_BASENAME);
  const markerPath = path.join(profilesDir, BOOT_SIBLING_MARKER_BASENAME);
  let lockFd = null;
  let failure = null;
  try {
    lockFd = fs.openSync(lockPath, "wx", 0o600);
    fs.closeSync(lockFd);
    lockFd = null;
    fs.writeFileSync(markerPath, `synthetic-dsh boot sibling marker ${process.pid}\n`, "utf-8");
    sleepSyncMs(holdMs);
  } catch (err) {
    failure = err;
  } finally {
    if (lockFd !== null) {
      try {
        fs.closeSync(lockFd);
      } catch {
        /* best effort */
      }
    }
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* best effort */
    }
    try {
      fs.rmSync(markerPath, { force: true });
    } catch {
      /* best effort */
    }
  }
  if (failure) {
    process.stderr.write(`${bootSiblingLockErrorText(lockPath, failure)}\n`);
    process.exit(BOOT_SIBLING_FAILURE_EXIT);
  }
}

// IN-VM first-request probe: resolve the request-extension provider's module
// through the guest's PRIVATE overlay farm (the composed plan mounts it at
// $DSH_HOME/profiles/node_modules), writing only guest-install links. NO
// session and NO usage are recorded, so the round consumes zero model tokens
// and the host store stays untouched. On a broken/absent farm the probe
// reproduces the real REQUEST_EXTENSION failure and exits non-zero; on a
// guest without a real writable `profiles/` parent it reproduces run #32's
// exact `profiles/node_modules.lock` ENOENT before any farm work.
function runFirstRequestProbe() {
  const dshHome = dshHomeRequired();
  // The boot writer lock is the FIRST profile artifact dsh touches: run it
  // before the profile-manifest read so a missing/unwritable `profiles/`
  // parent fails with run #32's exact ENOENT rather than a later error. The
  // prompt may request a bounded hold so the on-host observer captures it.
  runBootSiblingProbe(dshHome, parseBootSiblingHoldMs(prompt));
  requireHeadlessProfileLayout(dshHome);
  let resolvedName = null;
  try {
    const packageDir = path.join(GUEST_INSTALL_ROOT, "node_modules", FIRST_REQUEST_PLUGIN);
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      `${JSON.stringify({ name: FIRST_REQUEST_PLUGIN, version: "1.0.0" }, null, 2)}\n`,
      "utf-8",
    );
    const farmDir = path.join(dshHome, "profiles", "node_modules");
    fs.mkdirSync(farmDir, { recursive: true });
    const link = path.join(farmDir, FIRST_REQUEST_PLUGIN);
    fs.rmSync(link, { recursive: true, force: true });
    fs.symlinkSync(packageDir, link);
    // Resolve the request-extension provider's module THROUGH the farm, exactly
    // as the real headless request-extension preparation does.
    const resolved = fs.realpathSync(link);
    const manifest = JSON.parse(fs.readFileSync(path.join(resolved, "package.json"), "utf-8"));
    resolvedName = manifest.name;
    if (resolvedName !== FIRST_REQUEST_PLUGIN) {
      throw new Error(`resolved ${JSON.stringify(resolvedName)}`);
    }
  } catch (err) {
    process.stderr.write(
      `dsh: REQUEST_EXTENSION: DeepSeek request extension preparation failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
    process.exit(7);
  }
  const farmDir = path.join(dshHome, "profiles", "node_modules");
  process.stdout.write(
    `FIRST-REQUEST-RESOLVED:${resolvedName}\n` +
      `FIRST-REQUEST-PRIVATE-FARM:${farmDir}\n` +
      "STATUS: done\n",
  );
  process.exit(0);
}

// ── main dispatch ──────────────────────────────────────────────────────────
if (prompt.includes(NATIVE_HEAL_MARKER)) {
  runNativeHeal();
}
if (prompt.includes(FIRST_REQUEST_MARKER)) {
  runFirstRequestProbe();
}
if (isHarnessProbePrompt(prompt)) {
  runProbe(prompt);
}

const parsed = parseWorkPrompt(prompt);
if (parsed) {
  runWork(parsed);
} else {
  runPlainChat();
}
