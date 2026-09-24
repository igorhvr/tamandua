// SOGI US-002 — the ONE designated recording-only cleanup-identity regression
// gate (SOGI designated gate). Beads tamandua-6sy.5.1 preflight, US-002.
// Extended by SGBD 9.1.2 (bounded unreleased-child teardown): the extracted
// stop_unreleased_command cases additionally observe the explicit pre-release
// ABORT-marker publish (never the release marker) that makes an unreleased
// child self-exit without any signal when identity is unreadable/changed.
//
// What this gate is:
//   * A single, focused, RECORDING-ONLY regression file auto-discovered by
//     self-tests/run.sh's existing fast `tier0-*.test.ts` glob. It is NOT a
//     heavy campaign test and is deliberately NOT registered in any
//     HEAVY_CAMPAIGN_TESTS lock-step list (run.sh, verify-heavy-campaign-
//     tests.test.sh, e2e-golden-integrity.test.ts all stay unchanged).
//   * It exercises the ACTUAL committed decision code: the current
//     stop_owned_command, group_identity_authorized and stop_unreleased_command
//     are extracted with the balanced-brace technique from the committed
//     torture-test/scenarios/lib/run-scripted-scenario (git show HEAD:file),
//     and are run under /bin/bash with RECORDING substitutes for
//     process_starttime, process_group, kill, wait and sleep. Assertions are
//     made exclusively from the RECORDED operation lines (E2Ihak evidence
//     layout: kind host / kind source / kind case), never from a copied
//     predicate.
//   * No real process query, signal, group operation or scenario/host file
//     write can occur from inside the extracted functions: every dangerous
//     name resolves to a recorder, the extracted text is statically guarded
//     for direct-operation tokens, and the interpreters run under a PATH that
//     contains no executables. The ONLY real filesystem write is the SGBD
//     9.1.2 abort-marker publish, confined to a per-case os.tmpdir fixture
//     path wired in as COMMAND_ABORT_FILE (empty in cases that do not assert
//     the marker).
//   * MACP3 US-004: the only '/proc' text in this file is the
//     static-escape-guard regex literal and its prose (asserting the
//     extracted decision code performs no procfs access) — there is no
//     runtime procfs access of any kind in this recording gate.
//   * Each run retains fresh evidence (command line, source/function sha256,
//     per-case real exits and outcomes, recorded output) under a fresh
//     torture-test/var/review-logs/<fresh-id>/ directory. Evidence is never
//     overwritten or deleted.
//
// Coordination notes (progress.txt PLAN CORRECTION):
//   - Recording interpreters inherit guard protections; this gate does NOT
//     delete NODE_TEST_CONTEXT and does NOT set TAMANDUA_TEST_GUARD=0.
//   - scripted-scenario-harness.test.ts (real children + group signals)
//     remains coordinator-owned and is NOT executed here.
//
// Runs as its own `node --test torture-test/self-tests/tier0-sogi-cleanup-
// identity-gate.test.ts`; passes twice consecutively and leaves git status
// clean (evidence lives under the gitignored var/ tree).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const HARNESS_REL = "torture-test/scenarios/lib/run-scripted-scenario";
const REVIEW_ROOT = path.join(repoRoot, "torture-test", "var", "review-logs");
const BASH = "/bin/bash";

const sha256 = (x: string): string =>
  crypto.createHash("sha256").update(x).digest("hex");

function git(cwd: string, args: string[]): string {
  const r = execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return String(r);
}

function committedHarnessSource(): { pin: string; source: string } {
  // The extraction IS current-HEAD content — never a historical blob — so it
  // uses the literal `HEAD:<path>` form the tier0-history-independent-red-arms
  // meta-lint (R3/R4) exempts; a `${resolvedPin}:${path}` template trips R4
  // even though the rev is semantically HEAD. The resolved HEAD pin is
  // retained only for identity evidence/assertions below.
  const pin = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  const source = git(repoRoot, ["show", `HEAD:${HARNESS_REL}`]);
  // Union of intent (torture-union US-005): both source branches edited this
  // function. From fix/torture-battery-hermetic-20260909 @ 548aa1e we keep the
  // pin/pinAfter HEAD-moved identity guard below; from
  // input/aasylum/core-recorded-cells-20260909 @ f55e594e (ancestor
  // input/aasylum/core-replay-adapter-20260909 @ c32e6378) we keep the
  // literal-HEAD extraction rationale below. Both edits are retained; neither
  // source is dropped.
  // Extract via the literal HEAD rev, NOT the resolved `${pin}` SHA:
  // tier0-history-independent-red-arms (MACP5.1) rule R4 rejects any non-HEAD
  // `<rev>:<path>` git-show argument because it cannot prove a rev variable
  // equals HEAD — and this file's own contract documents `git show HEAD:file`.
  // `pin` is retained purely as the recorded evidence identity.
  // Before/after HEAD identity check: if HEAD moved between the pin capture
  // and the content read, the recorded pin would not describe the extracted
  // source — refuse an ambiguous pair instead of recording a false identity.
  const pinAfter = git(repoRoot, ["rev-parse", "HEAD"]).trim();
  if (pin !== pinAfter) {
    throw new Error(
      `HEAD moved during committed-source extraction (${pin} -> ${pinAfter}); refusing an ambiguous pin`,
    );
  }
  return { pin, source };
}

/** Extract a top-level `name() { ... }` function body (balanced-brace,
 *  quote-aware) from shell text, or null when the function is absent. */
function extractShellFunction(text: string, name: string): string | null {
  const start = text.indexOf(`${name}()`);
  if (start < 0) return null;
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── static escape guard on the EXTRACTED decision code ───────────────────
// The extracted functions may only reach the five substituted operation
// names (process_starttime, process_group, kill, wait, sleep) plus bash
// builtins. Direct-operation tokens must never appear in the extracted text:
// shadow bypasses (builtin/command + name), absolute tool paths, process/
// signal sweeps, eval/exec, and any /proc or $(< read. Bare words like "ps"
// are intentionally NOT banned because the committed code's inline comments
// mention them (e.g. "the portable ps arm"); the guard targets tokens that
// could actually reach a real operation.
const DIRECT_OP_RE =
  /(builtin\s+(?:kill|wait|sleep)|command\s+(?:kill|wait|sleep|process_starttime|process_group)|\/bin\/(?:kill|ps|sleep|sh|cat|dd)\b|\/usr\/bin\/(?:kill|ps|sleep|sh|cat|dd)\b|\bkillall\b|\bpkill\b|\bpgrep\b|\beval\b|\bexec\b|\$\s*\(\s*<|<\/?proc\/)/;

// ── recording substitutes (bash) ─────────────────────────────────────────
// kill/wait/sleep are invoked at top level (not captured), so their
// RECORDED_* lines form the recorded operation log on stdout.
// process_starttime/process_group are invoked inside $() by the decision
// code; their stdout is the identity/pgid value being captured, so they may
// only print that value (per-case policy) — their calls are not directly
// observable, but the kill/wait decision they drive is.
const KILL_REC =
  "kill() {\n" +
  '  printf "RECORDED_KILL"\n' +
  '  for _arg in "$@"; do printf " %s" "$_arg"; done\n' +
  '  printf "\\n"\n' +
  '  if [ "$1" = "-TERM" ]; then _signal_after_term=1; fi\n' +
  '  if [ "$1" = "-0" ]; then return 1; fi\n' +
  "  return 0\n" +
  "}";

const WAIT_REC =
  "wait() {\n" +
  '  printf "RECORDED_WAIT %s\\n" "$*"\n' +
  "  return 0\n" +
  "}";

const SLEEP_REC =
  "sleep() {\n" +
  '  printf "RECORDED_SLEEP %s\\n" "$*"\n' +
  "  return 0\n" +
  "}";

// process_starttime per-case policy bodies (value printed = captured identity).
const PST = {
  // Leader (or any pid) reads as the recorded identity: readable & matching.
  readable_match: "printf '%s\\n' owned-start\n  return 0",
  // Leader reads a DIFFERENT start time (pid reuse).
  readable_changed: "printf '%s\\n' unrelated-new-start\n  return 0",
  // Identity unreadable for every pid.
  unreadable: "return 1",
  // Fast leader exit: leader unreadable; disowned anchor readable & matching.
  leader_unreadable_anchor_match:
    'if [ "$1" = "$COMMAND_LEADER_PID" ]; then return 1; fi\n' +
    "  printf '%s\\n' anchor-start\n  return 0",
  // Fast leader exit with a CHANGED anchor identity.
  leader_unreadable_anchor_changed:
    'if [ "$1" = "$COMMAND_LEADER_PID" ]; then return 1; fi\n' +
    "  printf '%s\\n' unrelated-anchor-start\n  return 0",
  // Leader readable until a TERM is recorded, then unreadable (dies on TERM).
  leader_loss_after_term:
    'if [ "$_signal_after_term" = "1" ]; then return 1; fi\n' +
    "  printf '%s\\n' owned-start\n  return 0",
  // Leader always unreadable; anchor readable until TERM, then unreadable.
  anchor_loss_after_term:
    'if [ "$1" = "$COMMAND_LEADER_PID" ]; then return 1; fi\n' +
    '  if [ "$_signal_after_term" = "1" ]; then return 1; fi\n' +
    "  printf '%s\\n' anchor-start\n  return 0",
} as const;

// process_group per-case bodies (value printed = pgid captured by caller).
const PG = {
  // The pid is still its own group leader (pgid == pid).
  returns_leader: "printf '%s\\n' \"$1\"\n  return 0",
  // The pid is not its own group leader.
  returns_other: "printf '%s\\n' 999999\n  return 0",
} as const;

interface GateCase {
  id: string;
  functionUnderTest: "stop_owned_command" | "stop_unreleased_command";
  description: string;
  groupProven: string;
  leaderPid: string;
  starttime: string; // recorded identity, "" when none
  anchorPid: string;
  anchorStarttime: string;
  pstPolicy: keyof typeof PST;
  pgPolicy: keyof typeof PG;
  expected: string[]; // exact ordered recorded op lines
  cleanedClaimExpected: boolean; // true only when a KILL escalation is recorded
  // SGBD 9.1.2: real temp paths wired into the recording prelude so the
  // ACTUAL committed stop_unreleased_command's abort-marker publish is
  // observable. Empty = no marker configured (the publish is skipped).
  abortFile?: string;
  releaseFile?: string;
  abortMarkerExpected?: boolean; // true when the abort marker must be created
}

// Every case is a pure recording run of the ACTUAL committed functions. Pids
// are fixtures (424242 leader, 424243 direct child/wrapper, 424244 anchor).
const CASES: GateCase[] = [
  {
    id: "known_owned_positive_cleanup",
    functionUnderTest: "stop_owned_command",
    description:
      "matrix (1): leader alive with the recorded start time -> TERM fires, " +
      "identity is re-proven (readable again), then KILL fires on the saved group.",
    groupProven: "1",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "readable_match",
    pgPolicy: "returns_other",
    expected: [
      "RECORDED_KILL -TERM -- -424242",
      "RECORDED_KILL -0 -- -424242",
      "RECORDED_KILL -KILL -- -424242",
      "RECORDED_WAIT 424243",
    ],
    cleanedClaimExpected: true,
  },
  {
    id: "identity_unreadable",
    functionUnderTest: "stop_owned_command",
    description:
      "matrix (2): leader identity unreadable and NO anchor recorded -> ZERO TERM and ZERO KILL " +
      "(unknown identity never authorizes a group signal — the SOGI fix).",
    groupProven: "1",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "unreadable",
    pgPolicy: "returns_other",
    expected: [],
    cleanedClaimExpected: false,
  },
  {
    id: "changed_identity_control",
    functionUnderTest: "stop_owned_command",
    description:
      "matrix (3): leader readable but CHANGED start time -> no signal (pid-reuse control).",
    groupProven: "1",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "readable_changed",
    pgPolicy: "returns_other",
    expected: [],
    cleanedClaimExpected: false,
  },
  {
    id: "leader_identity_loss_after_term",
    functionUnderTest: "stop_owned_command",
    description:
      "matrix (4): leader identity lost between TERM and KILL (dies on TERM) -> " +
      "TERM recorded, NO KILL escalation; outcome does NOT claim survivors were cleaned.",
    groupProven: "1",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "leader_loss_after_term",
    pgPolicy: "returns_other",
    expected: [
      "RECORDED_KILL -TERM -- -424242",
      "RECORDED_KILL -0 -- -424242",
      "RECORDED_WAIT 424243",
    ],
    cleanedClaimExpected: false,
  },
  {
    id: "anchor_identity_loss_after_term",
    functionUnderTest: "stop_owned_command",
    description:
      "matrix (4) via anchor: anchor identity lost between TERM and KILL -> TERM recorded, " +
      "NO KILL escalation; no cleaned-survivor claim.",
    groupProven: "1",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "424244",
    anchorStarttime: "anchor-start",
    pstPolicy: "anchor_loss_after_term",
    pgPolicy: "returns_other",
    expected: [
      "RECORDED_KILL -TERM -- -424242",
      "RECORDED_KILL -0 -- -424242",
      "RECORDED_WAIT 424243",
    ],
    cleanedClaimExpected: false,
  },
  {
    id: "early_exit_anchor_readable_positive",
    functionUnderTest: "stop_owned_command",
    description:
      "matrix (5) viable positive path: fast leader exit with owned descendants; leader " +
      "unreadable but the disowned in-group anchor is alive+unchanged -> TERM fires, " +
      "identity re-proven through the anchor, KILL fires: owned survivors ARE signaled.",
    groupProven: "1",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "424244",
    anchorStarttime: "anchor-start",
    pstPolicy: "leader_unreadable_anchor_match",
    pgPolicy: "returns_other",
    expected: [
      "RECORDED_KILL -TERM -- -424242",
      "RECORDED_KILL -0 -- -424242",
      "RECORDED_KILL -KILL -- -424242",
      "RECORDED_WAIT 424243",
    ],
    cleanedClaimExpected: true,
  },
  {
    id: "early_exit_anchor_changed_refused",
    functionUnderTest: "stop_owned_command",
    description:
      "matrix (5) refusal: fast leader exit but the anchor identity CHANGED -> no signal, " +
      "no cleaned claim (group cannot be re-proven).",
    groupProven: "1",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "424244",
    anchorStarttime: "anchor-start",
    pstPolicy: "leader_unreadable_anchor_changed",
    pgPolicy: "returns_other",
    expected: [],
    cleanedClaimExpected: false,
  },
  {
    id: "early_exit_anchor_unreadable_refused",
    functionUnderTest: "stop_owned_command",
    description:
      "matrix (5) refusal: fast leader exit AND anchor unreadable -> no signal, " +
      "no cleaned claim (unknown identity never authorizes).",
    groupProven: "1",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "424244",
    anchorStarttime: "anchor-start",
    pstPolicy: "unreadable",
    pgPolicy: "returns_other",
    expected: [],
    cleanedClaimExpected: false,
  },
  {
    id: "unreleased_proven_direct_child_term",
    functionUnderTest: "stop_unreleased_command",
    description:
      "matrix (6) positive: interrupted/unreleased branch under PROVEN identity (current " +
      "readable == recorded start); leader pid unknown so the target falls back to the direct " +
      "child (COMMAND_PID) and it is NOT its own group leader -> TERM goes to the direct child " +
      "(positive pid), never a group target.",
    groupProven: "0",
    leaderPid: "",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "readable_match",
    pgPolicy: "returns_other",
    expected: ["RECORDED_KILL -TERM 424243", "RECORDED_WAIT 424243"],
    cleanedClaimExpected: false,
  },
  {
    id: "unreleased_proven_group_leader_term",
    functionUnderTest: "stop_unreleased_command",
    description:
      "matrix (6) group arm: interrupted branch under PROVEN identity with the target still " +
      "its own group leader (pgid == pid) -> TERM on the group form fires (matching identity " +
      "authorizes); no KILL escalation exists in this branch.",
    groupProven: "0",
    leaderPid: "",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "readable_match",
    pgPolicy: "returns_leader",
    expected: ["RECORDED_KILL -TERM -- -424243", "RECORDED_WAIT 424243"],
    cleanedClaimExpected: false,
  },
  {
    id: "unreleased_unknown_no_signal",
    functionUnderTest: "stop_unreleased_command",
    description:
      "matrix (6) negative: interrupted/unreleased branch with UNKNOWN identity (current " +
      "unreadable) -> no TERM and no group signal of any kind; only the unconditional wait.",
    groupProven: "0",
    leaderPid: "",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "unreadable",
    pgPolicy: "returns_leader", // even if it WOULD be a group leader, no signal fires
    expected: ["RECORDED_WAIT 424243"],
    cleanedClaimExpected: false,
  },
  {
    id: "unreleased_changed_no_signal",
    functionUnderTest: "stop_unreleased_command",
    description:
      "matrix (6) negative: interrupted branch with CHANGED identity (readable but != " +
      "recorded start) -> no TERM, no group signal; only the unconditional wait.",
    groupProven: "0",
    leaderPid: "",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "readable_changed",
    pgPolicy: "returns_leader",
    expected: ["RECORDED_WAIT 424243"],
    cleanedClaimExpected: false,
  },
  {
    id: "unreleased_unknown_publishes_abort",
    functionUnderTest: "stop_unreleased_command",
    description:
      "SGBD 9.1.2: unreleased branch with UNKNOWN identity -> no TERM/group signal of " +
      "any kind (SOGI refusal preserved) BUT the explicit pre-release ABORT marker is " +
      "published (never the release marker) so the unreleased leader+anchor self-exit " +
      "and the wait is bounded instead of hanging forever.",
    groupProven: "0",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "unreadable",
    pgPolicy: "returns_leader",
    expected: ["RECORDED_WAIT 424243"],
    cleanedClaimExpected: false,
    abortFile: "ABORT_TMP_PATH",
    abortMarkerExpected: true,
  },
  {
    id: "unreleased_changed_publishes_abort",
    functionUnderTest: "stop_unreleased_command",
    description:
      "SGBD 9.1.2: unreleased branch with CHANGED identity (readable but != recorded " +
      "start) -> no TERM (pid-reuse control) and the abort marker is published.",
    groupProven: "0",
    leaderPid: "424242",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "readable_changed",
    pgPolicy: "returns_leader",
    expected: ["RECORDED_WAIT 424243"],
    cleanedClaimExpected: false,
    abortFile: "ABORT_TMP_PATH",
    abortMarkerExpected: true,
  },
  {
    id: "unreleased_proven_term_publishes_abort_too",
    functionUnderTest: "stop_unreleased_command",
    description:
      "SGBD 9.1.2: unreleased branch under PROVEN identity -> the authorized TERM fires " +
      "as before (leader pid unknown, so the target falls back to the direct child) AND " +
      "the abort marker is still published (it also tears the disowned anchor down " +
      "promptly in the non-group-TERM arm); the release marker is never touched.",
    groupProven: "0",
    leaderPid: "",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "readable_match",
    pgPolicy: "returns_other",
    expected: ["RECORDED_KILL -TERM 424243", "RECORDED_WAIT 424243"],
    cleanedClaimExpected: false,
    abortFile: "ABORT_TMP_PATH",
    abortMarkerExpected: true,
  },
  {
    id: "unreleased_released_never_publishes_abort",
    functionUnderTest: "stop_unreleased_command",
    description:
      "SGBD 9.1.2 refusal: when the release marker ALREADY exists (the scenario was " +
      "released), the abort marker must NOT be published — abort is a pre-release " +
      "control only and must never race a released scenario command.",
    groupProven: "0",
    leaderPid: "",
    starttime: "owned-start",
    anchorPid: "",
    anchorStarttime: "",
    pstPolicy: "readable_match",
    pgPolicy: "returns_other",
    expected: ["RECORDED_KILL -TERM 424243", "RECORDED_WAIT 424243"],
    cleanedClaimExpected: false,
    abortFile: "ABORT_TMP_PATH",
    releaseFile: "RELEASE_TMP_PATH",
    abortMarkerExpected: false,
  },
];

interface CaseResult {
  gateCase: GateCase;
  command: string; // exact /bin/bash -c prelude executed for this case
  recorded: string[]; // exact ordered RECORDED_* lines
  realProcessExit: number; // real /bin/bash exit code
  stdout: string;
  stderr: string;
  meets: boolean;
  cleanedClaimRecorded: boolean; // derived: a -KILL escalation was recorded
  abortMarkerCreated: boolean; // derived: the configured abort marker exists after the run
}

// ── case runner ──────────────────────────────────────────────────────────
function runCase(gateCase: GateCase, extractedFns: string): CaseResult {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sogi-gate-"));
  const emptyBin = path.join(fixtureRoot, "emptybin");
  fs.mkdirSync(emptyBin);
  try {
    // SGBD 9.1.2: real temp marker paths wired into the prelude so the ACTUAL
    // committed stop_unreleased_command's abort-marker publish is observable
    // (and so the extracted function's references are defined under set -u).
    const abortPath = gateCase.abortFile ? path.join(fixtureRoot, "abort.marker") : "";
    const releasePath = gateCase.releaseFile ? path.join(fixtureRoot, "release.marker") : "";
    if (releasePath !== "") fs.writeFileSync(releasePath, "released\n");
    const prelude = [
      "set -u",
      "_signal_after_term=0",
      "COMMAND_PID=424243",
      `COMMAND_LEADER_PID=${gateCase.leaderPid}`,
      `COMMAND_GROUP_PROVEN=${gateCase.groupProven}`,
      gateCase.starttime === "" ? "COMMAND_STARTTIME=" : `COMMAND_STARTTIME=${gateCase.starttime}`,
      gateCase.anchorPid === "" ? "COMMAND_ANCHOR_PID=" : `COMMAND_ANCHOR_PID=${gateCase.anchorPid}`,
      gateCase.anchorStarttime === ""
        ? "COMMAND_ANCHOR_STARTTIME="
        : `COMMAND_ANCHOR_STARTTIME=${gateCase.anchorStarttime}`,
      `COMMAND_ABORT_FILE=${abortPath}`,
      `COMMAND_RELEASE_FILE=${releasePath}`,
      `process_starttime() {\n  ${PST[gateCase.pstPolicy]}\n}`,
      `process_group() {\n  ${PG[gateCase.pgPolicy]}\n}`,
      KILL_REC,
      WAIT_REC,
      SLEEP_REC,
      extractedFns,
      gateCase.functionUnderTest,
    ].join("\n");

    const env: NodeJS.ProcessEnv = { ...process.env, PATH: emptyBin, LC_ALL: "C" };
    let stdout = "";
    let stderr = "";
    let status = 0;
    try {
      const r = execFileSync(BASH, ["--noprofile", "--norc", "-c", prelude], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      stdout = String(r);
    } catch (e) {
      const err = e as { status?: number | null; stdout?: Buffer | string; stderr?: Buffer | string };
      status = err.status ?? 1;
      stdout = String(err.stdout ?? "");
      stderr = String(err.stderr ?? "");
    }

    const recorded = stdout.trim() === "" ? [] : stdout.trim().split("\n").filter((l) => l !== "");
    const recordedKill = recorded.filter((l) => l.startsWith("RECORDED_KILL"));
    const cleanedClaimRecorded = recordedKill.some((l) => l.includes("-KILL"));
    const abortMarkerCreated = abortPath !== "" && fs.existsSync(abortPath);
    const meets =
      status === 0 &&
      JSON.stringify(recorded) === JSON.stringify(gateCase.expected) &&
      cleanedClaimRecorded === gateCase.cleanedClaimExpected;

    return {
      gateCase,
      command: prelude,
      recorded,
      realProcessExit: status,
      stdout,
      stderr,
      meets,
      cleanedClaimRecorded,
      abortMarkerCreated,
    };
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

// ── evidence retention (fresh dir per run; never deleted) ────────────────
let evidenceDir = "";
let runLogPath = "";
let sourceSha = "";
let fnShas: Record<string, string> = { stop_owned_command: "", group_identity_authorized: "", stop_unreleased_command: "" };
let extractedTexts: Record<string, string> = {};
let pin = "";
let results: CaseResult[] = [];

function writeEvidence(): void {
  fs.mkdirSync(REVIEW_ROOT, { recursive: true });
  const id = crypto.randomBytes(6).toString("hex");
  evidenceDir = path.join(REVIEW_ROOT, `sogi-us002-cleanup-identity-gate-${id}`);
  fs.mkdirSync(evidenceDir, { recursive: true });

  const bashVersion = execFileSync(BASH, ["--version"], { encoding: "utf8" })
    .split("\n")[0]
    .trim();
  const workingTreeStatus = git(repoRoot, ["status", "--porcelain"]).trim();
  const lines: string[] = [];

  lines.push(
    JSON.stringify({
      kind: "host",
      platform: process.platform,
      node: process.version,
      bash: bashVersion,
      pin,
      working_tree_status: workingTreeStatus,
      execution:
        "US-002 committed-source extracted-function gate with recording substitutes; " +
        "no live PID queries/signals/group operations or scenario/host file writes inside " +
        "the tested functions",
    }),
  );
  lines.push(
    JSON.stringify({
      kind: "source",
      pin,
      file: HARNESS_REL,
      sha256: sourceSha,
      functions: Object.fromEntries(
        Object.entries(extractedTexts).map(([name, text]) => [name, { sha256: fnShas[name], text }]),
      ),
      scope: "exact committed decision functions only; NOT sourcing or running the full harness",
      static_escape_guard: DIRECT_OP_RE.source,
    }),
  );
  for (const r of results) {
    const c = r.gateCase;
    lines.push(
      JSON.stringify({
        kind: "case",
        scenario: c.id,
        description: c.description,
        function_under_test: c.functionUnderTest,
        command: r.command,
        recorded_output: r.stdout,
        recorded_stderr: r.stderr,
        recorded_ops: r.recorded,
        expected_ops: c.expected,
        real_process_exit: r.realProcessExit,
        meets_expectation: r.meets,
        cleaned_claim_recorded: r.cleanedClaimRecorded,
        cleaned_claim_expected: c.cleanedClaimExpected,
        abort_marker_created: r.abortMarkerCreated,
        abort_marker_expected: c.abortMarkerExpected ?? null,
        real_signals: 0,
        real_process_queries: 0,
        real_filesystem_operations_in_function: r.abortMarkerCreated ? 1 : 0,
      }),
    );
  }

  const evidencePath = path.join(evidenceDir, "evidence.jsonl");
  fs.writeFileSync(evidencePath, lines.join("\n") + "\n");

  const argv = process.argv.join(" ");
  const summary = results.map((r) => `  ${r.gateCase.id}: ${r.meets ? "PASS" : "FAIL"} (real_exit=${r.realProcessExit})`).join("\n");
  runLogPath = path.join(evidenceDir, "run.log");
  fs.writeFileSync(
    runLogPath,
    [
      `command: ${argv}`,
      `intended: node --test torture-test/self-tests/tier0-sogi-cleanup-identity-gate.test.ts`,
      `cwd: ${process.cwd()}`,
      `pin: ${pin}`,
      `source_sha256: ${sourceSha}`,
      `stop_owned_command_sha256: ${fnShas.stop_owned_command}`,
      `group_identity_authorized_sha256: ${fnShas.group_identity_authorized}`,
      `stop_unreleased_command_sha256: ${fnShas.stop_unreleased_command}`,
      `all_cases_meet: ${results.every((r) => r.meets)}`,
      `per_case:`,
      summary,
      `evidence: ${evidencePath}`,
    ].join("\n") + "\n",
  );

  // Append the authoritative node:test process exit code when the process ends.
  process.once("exit", (code) => {
    try {
      fs.appendFileSync(runLogPath, `node_test_real_exit: ${code}\n`);
    } catch {
      // best-effort at process exit
    }
  });
}

// ── node:test ────────────────────────────────────────────────────────────
describe("SOGI US-002 cleanup-identity recording gate", () => {
  let extractionErrors: string[] = [];

  // before() ONLY computes and retains evidence. Assertions live in the it()
  // blocks below so that, if the committed decision code ever changes and a
  // case/guard fails, the fresh evidence dir still records exactly what ran
  // (per-case real exits, recorded ops, mismatch details) for the coordinator.
  before(() => {
    const committed = committedHarnessSource();
    pin = committed.pin;
    const source = committed.source;
    sourceSha = sha256(source);

    for (const name of ["group_identity_authorized", "stop_owned_command", "stop_unreleased_command"]) {
      const fn = extractShellFunction(source, name);
      if (!fn) {
        extractionErrors.push(`could not extract ${name}() from the committed ${HARNESS_REL}`);
        extractedTexts[name] = `# MISSING ${name} at ${pin}`;
        fnShas[name] = sha256(`# MISSING ${name} at ${pin}`);
        continue;
      }
      extractedTexts[name] = fn;
      fnShas[name] = sha256(fn);
    }

    results = CASES.map((c) => runCase(c, Object.values(extractedTexts).join("\n")));
    writeEvidence();
  });

  it("extracts the actual committed decision functions", () => {
    assert.deepEqual(extractionErrors, [], `extraction failures:\n${extractionErrors.join("\n")}`);
    assert.equal(Object.keys(extractedTexts).length, 3);
    assert.ok(sourceSha.length === 64);
  });

  it("passes the static escape guard on the extracted decision code", () => {
    const concat = Object.values(extractedTexts).join("\n");
    const m = DIRECT_OP_RE.exec(concat);
    assert.equal(m, null, `extracted decision code contains a direct-operation escape: ${m?.[0]}`);
    for (const name of ["process_starttime", "process_group", "kill", "wait", "sleep"]) {
      assert.ok(
        !new RegExp(`(^|\\n)${name}\\s*\\(\\)`).test(concat),
        `extracted decision code redefines the substituted operation: ${name}`,
      );
    }
  });

  it("retains fresh evidence under torture-test/var/review-logs", () => {
    assert.ok(evidenceDir.startsWith(REVIEW_ROOT + path.sep), `evidence escaped review-logs: ${evidenceDir}`);
    assert.ok(fs.existsSync(path.join(evidenceDir, "evidence.jsonl")), "evidence.jsonl must exist");
    assert.ok(fs.existsSync(runLogPath), "run.log must exist");
  });

  for (const [i, c] of CASES.entries()) {
    it(`case ${i + 1}: ${c.id} (${c.functionUnderTest})`, () => {
      const r = results[i];
      assert.ok(r, `missing result for ${c.id}`);
      assert.equal(
        r.realProcessExit,
        0,
        `${c.id}: recording interpreter must exit 0 (real exit ${r.realProcessExit})\nstderr: ${r.stderr}`,
      );
      assert.equal(
        r.stderr.trim(),
        "",
        `${c.id}: interpreter stderr must be empty (no command-not-found / real-op error)\n${r.stderr}`,
      );
      assert.deepEqual(r.recorded, c.expected, `${c.id}: recorded ops must match expectation`);
      assert.equal(
        r.cleanedClaimRecorded,
        c.cleanedClaimExpected,
        `${c.id}: cleaned-survivor claim must be recorded exactly when a KILL escalation fires`,
      );
      if (c.abortMarkerExpected !== undefined) {
        assert.equal(
          r.abortMarkerCreated,
          c.abortMarkerExpected,
          `${c.id}: the abort-marker publish must match expectation (created=${r.abortMarkerCreated}, expected=${c.abortMarkerExpected})`,
        );
      }
      assert.ok(r.meets, `${c.id}: case did not meet expectations`);
    });
  }

  it("publishes the pre-release abort marker exactly when no release exists (SGBD 9.1.2)", () => {
    for (const r of results) {
      const c = r.gateCase;
      if (c.functionUnderTest !== "stop_unreleased_command") continue;
      if (c.abortMarkerExpected === undefined) continue;
      if (c.abortMarkerExpected) {
        assert.ok(
          !r.recorded.some((l) => l.startsWith("RECORDED_KILL") && l.includes("-KILL")),
          `${c.id}: the abort-marker publish must never accompany a KILL escalation`,
        );
        assert.ok(
          !r.recorded.some((l) => l.includes("RECORDED_KILL") && l.includes("-TERM") && l.includes("-424242")),
          `${c.id}: an abort-marker publish under UNKNOWN/CHANGED identity must record no group TERM`,
        );
      }
    }
  });

  it("keeps every required refusal/loss case free of a cleaned claim and any KILL escalation", () => {
    for (const r of results) {
      const killLines = r.recorded.filter((l) => l.startsWith("RECORDED_KILL"));
      if (!r.gateCase.cleanedClaimExpected) {
        assert.ok(
          !killLines.some((l) => l.includes("-KILL")),
          `${r.gateCase.id}: a refusal/loss/unreleased case must never record a KILL escalation`,
        );
        assert.equal(r.cleanedClaimRecorded, false, `${r.gateCase.id}: must not claim survivors cleaned`);
      } else {
        // viable positive path: full TERM then re-proven KILL on the saved group
        assert.ok(
          killLines.some((l) => l.includes("-TERM")) && killLines.some((l) => l.includes("-KILL")),
          `${r.gateCase.id}: the viable positive path must record TERM then KILL`,
        );
        assert.equal(r.cleanedClaimRecorded, true, `${r.gateCase.id}: positive path may claim cleanup`);
      }
    }
  });

  it("leaves the working tree clean after retaining evidence", () => {
    // Evidence lives under the gitignored var/ tree; the gate itself must not
    // dirty the working tree.
    const status = git(repoRoot, ["status", "--porcelain"]).trim();
    assert.equal(status, "", `gate left the working tree dirty:\n${status}`);
  });
});

// Keep the fixture directory clean-up registered even if the describe fails
// before completing (evidence dir is retained by design; only os.tmpdir
// fixtures are removed by runCase's finally).
after(() => {
  // no-op: retained evidence is deliberately left on disk for coordinator review
});
