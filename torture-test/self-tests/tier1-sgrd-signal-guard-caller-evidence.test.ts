// SGRD (R4a US-014 review correction) — the tt-chaos signal guard must be
// fail-closed on UNREADABLE CALLER evidence, not just on unreadable target
// evidence.
//
// Independent committed-source review (2026-09-05, pin 11de76f6 — Beads
// tamandua-6sy.4.1, torture-test/impl-tasks/R4a-SGRD-review-correction.md,
// retained proof torture-test/var/review-logs/r4a-signal-guard-T7yG5O/
// unknown-caller-evidence.jsonl + extended-unknown-caller-red.jsonl) found
// two fail-open classes in the recorded-target signal guard:
//
//   1. The target pgid is known but reading the CALLER pgid fails.
//      verifyRecordedTarget and verifyKillTarget returned ok:true and even
//      asserted "group disjointness passed" — comparing a number with null
//      is not proof of disjointness. A later unreadable caller observation
//      was accepted because an earlier check had succeeded.
//   2. The caller ancestry query fails (unreadable parent evidence, a ppid
//      cycle, or depth exhaustion). isAncestorOf-style walks returned false,
//      which the guard read as proof the target is NOT an ancestor.
//
// Fix (files ONLY under torture-test/):
//   1. tt-process-identity.mjs: NEW classifyAncestry tri-state verdict —
//      'ancestor' | 'disjoint' (a FULLY OBSERVED ppid walk to the root never
//      met the target — the only verdict a guard may accept) | 'unknown'
//      (unreadable parent evidence / cycle / depth cap). verifyRecordedTarget
//      refuses on 'unknown'. The raw parent read (rawParentPidOf) keeps the
//      "parent is 0" root observation distinct from an unreadable read, which
//      getProcessParent's ppid>0 filter conflates. verifyRecordedTarget also
//      REFUSES a group kill whose CALLER own-pgid read returns null.
//   2. tt-chaos verifyKillTarget: BOTH the daemon branch and the harness
//      branch refuse when the caller's own pgid is unreadable (previously the
//      `pgid === ownProcessGroup()` null comparison vacuous-passed), so a
//      later unreadable caller observation is never excused by an earlier
//      successful one. All existing refusals (known ancestor, same group,
//      ABA mismatch, unknown/dead target, unreadable TARGET pgid,
//      out-of-scope pidfile) are preserved; the known-disjoint accept is
//      preserved.
//
// Designated gate (per the signed task): ONE synthetic recording-only
// regression file exercising the ACTUAL helper (verifyRecordedTarget) and the
// ACTUAL chaos guard (verifyKillTarget, extracted verbatim from bin/tt-chaos)
// with the complete/disjoint control, ancestor, caller-group-missing,
// parent-missing, cycle/depth and the existing refusal controls. The tools
// under test run in a VM with RECORDING substitutes for the process-evidence
// source (spawnSync) and the filesystem — the same methodology as the
// retained coordinator driver; ZERO real processes are queried, ZERO signals
// are fired, ZERO filesystem accesses happen (asserted per scenario). Linux
// and Darwin evidence sources are not required to run: the darwin platform
// seam routes every pgid/ppid/lstart/command read through the synthetic
// spawnSync, which is the same shape as a procfs-less host.
//
// RED (pre-fix actuals, recorded in the progress log): point TT_SGRD_TOOL_TREE
// at a temp tree holding the pre-fix blobs (git show HEAD:... of bin/tt-chaos
// and bin/tt-process-identity.mjs) — the caller-group-missing, parent-missing,
// cycle, depth and late-caller scenarios ACCEPT (ok:true) pre-fix; the same
// file is GREEN post-fix. Default tool tree: the working tree.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (no run.sh edit).
// Confined to torture-test/. No procfs-mount literal appears in this file
// (the procfs-portability lint); the tools it reads are allowlisted there.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { describe, it } from "node:test";
import ts from "typescript";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
// TT_SGRD_TOOL_TREE: alternate tool tree (bin/tt-chaos + bin/tt-process-
// identity.mjs) the assertions drive — used to demonstrate the RED case
// against the pre-fix tools (see header). Defaults to the working tree.
const toolTree = process.env.TT_SGRD_TOOL_TREE ?? ttRoot;
const chaosText = fs.readFileSync(path.join(toolTree, "bin", "tt-chaos"), "utf8");
const identityText = fs.readFileSync(
  path.join(toolTree, "bin", "tt-process-identity.mjs"),
  "utf8",
);

// ── synthetic process table (recording-only; mirrors the retained driver) ──
// The tools are evaluated in a VM whose spawnSync answers `ps -p <pid> -o
// <field>=` / `lsof -a -p <pid> -d cwd -Fn` deterministically per scenario.
// Every call is RECORDED; the filesystem substitute records AND throws on any
// access (proving the guards never touch the fs); process.kill records and
// throws (proving no signal is ever fired).
const SELF_PID = 9000;
const TARGET_PID = 4242;
const TARGET_START = "Sat Sep 5 00:00:00 2026";
const TT_ROOT_SYNTH = "/synthetic/owned/var";
const PIDFILE_SYNTH = `${TT_ROOT_SYNTH}/home/.tamandua/daemon.pid`;

type ScenarioName =
  | "complete_disjoint_control"
  | "known_ancestor_refused"
  | "own_pgid_unreadable" // caller-group-missing (daemon)
  | "caller_ancestry_unreadable" // parent-missing at the caller
  | "deeper_parent_unreadable" // parent-missing mid-chain
  | "parent_chain_cycle"
  | "parent_chain_depth_exhausted"
  | "late_caller_pgid_unreadable"
  | "target_pgid_unreadable"
  | "identity_unreadable"
  | "identity_mismatch"
  | "same_group_refused"
  | "harness_caller_pgid_unreadable"
  | "harness_complete_disjoint_control"
  | "harness_same_group_refused";

interface Pending {
  record: Record<string, unknown>;
  kind: "daemon" | "harness";
}

/** Scenario -> the recorded target record + kind handed to the guards. */
function recordFor(scenario: ScenarioName): Pending {
  const daemonRecord = {
    pid: TARGET_PID,
    pgid: TARGET_PID,
    startTime: `darwin:${TARGET_START}`,
    pidfile: PIDFILE_SYNTH,
  };
  switch (scenario) {
    case "identity_mismatch":
      return { record: { ...daemonRecord, startTime: "darwin:different" }, kind: "daemon" };
    case "same_group_refused":
      return { record: { ...daemonRecord, pgid: SELF_PID }, kind: "daemon" };
    case "harness_complete_disjoint_control":
      // kill-harness recorded shape: pid + pgid + start identity.
      return { record: { pid: TARGET_PID, pgid: TARGET_PID, startTime: `darwin:${TARGET_START}` }, kind: "harness" };
    case "harness_caller_pgid_unreadable":
      // A pid+identity-only harness record (no recorded pgid): the base
      // helper has no group obligation, so the unreadable CALLER pgid can
      // only be caught by the guard's own harness-branch gate. Synthetic
      // provenance stubs make the pre-fix vacuous pass visible (see below).
      return { record: { pid: TARGET_PID, startTime: `darwin:${TARGET_START}` }, kind: "harness" };
    case "harness_same_group_refused":
      return { record: { pid: TARGET_PID, pgid: SELF_PID, startTime: `darwin:${TARGET_START}` }, kind: "harness" };
    default:
      return { record: { ...daemonRecord }, kind: "daemon" };
  }
}

/** Synthetic spawnSync — deterministic per-scenario process-table answers. */
function makeSynthetic(sp: ScenarioName) {
  const calls: Array<{ bin: string; args: string[] }> = [];
  const fsCalls: string[] = [];
  const signals: unknown[][] = [];
  let ownPgidReads = 0;
  const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" });
  const bad = () => ({ status: 1, stdout: "", stderr: "synthetic unreadable" });
  const spawnSync = (bin: string, args: string[]) => {
    calls.push({ bin, args });
    const pid = Number(args[1]);
    const field = args[3];
    if (field === "lstart=") {
      return sp === "identity_unreadable" ? bad() : ok(TARGET_START);
    }
    if (field === "pgid=") {
      if (pid === SELF_PID) ownPgidReads += 1;
      const callerUnreadable =
        sp === "own_pgid_unreadable" ||
        sp === "harness_caller_pgid_unreadable" ||
        (sp === "late_caller_pgid_unreadable" && ownPgidReads >= 3);
      if (callerUnreadable && pid === SELF_PID) return bad();
      if (sp === "target_pgid_unreadable" && pid === TARGET_PID) return bad();
      const sameGroup =
        sp === "same_group_refused" || sp === "harness_same_group_refused";
      return ok(String(pid === TARGET_PID && !sameGroup ? TARGET_PID : SELF_PID));
    }
    if (field === "ppid=") {
      if (sp === "parent_chain_cycle") {
        if (pid === SELF_PID) return ok("100");
        if (pid === 100) return ok(String(SELF_PID));
      }
      if (sp === "deeper_parent_unreadable" && pid === 100) return bad();
      if (sp === "parent_chain_depth_exhausted") {
        if (pid === SELF_PID) return ok("12000");
        if (pid >= 12000) return ok(String(pid + 1));
      }
      if (sp === "caller_ancestry_unreadable" && pid === SELF_PID) return bad();
      if (pid === SELF_PID) {
        return ok(String(sp === "known_ancestor_refused" ? TARGET_PID : 100));
      }
      if (pid === 100) return ok("1");
      return ok("0"); // pid 1's ppid — the fully-observed root
    }
    if (field === "command=") {
      // harness provenance arm: a TT-owned cmdline (run id inside TT_ROOT).
      return ok(`node ${TT_ROOT_SYNTH}/tt-harness-run-synthetic-run`);
    }
    if (bin === "lsof") {
      // harness provenance arm: a cwd under TT_ROOT.
      return ok(`p${pid}\nn${TT_ROOT_SYNTH}/var/work\n`);
    }
    throw new Error(`unexpected synthetic command: ${bin} ${args.join(" ")}`);
  };
  // The fs substitute: recording + hard-fail on ANY access (recording-only).
  const fakeFs = new Proxy(
    {},
    {
      get(_target, key) {
        return (...callArgs: unknown[]) => {
          fsCalls.push(String(key));
          throw new Error(`no real filesystem access in VM: fs.${String(key)}(${JSON.stringify(callArgs)})`);
        };
      },
    },
  );
  return { calls, fsCalls, signals, spawnSync, fakeFs };
}

/** Load the ACTUAL tt-process-identity.mjs source into a VM context with the
 *  synthetic evidence source, then install the ACTUAL verifyKillTarget text
 *  extracted verbatim from bin/tt-chaos (top-level function declaration —
 *  the same extraction the retained coordinator driver uses). Returns the
 *  context with the live guard + helper callable. */
function loadGuard(sp: ScenarioName) {
  const syn = makeSynthetic(sp);
  const moduleSource = identityText
    .replace(/^#![^\n]*\n/, "")
    .split("\n")
    .filter((l) => !/^\s*import\s/.test(l))
    .join("\n")
    .replace(/\bexport function /g, "function ");
  const fakeProcess = {
    pid: SELF_PID,
    platform: "darwin",
    env: { TT_PROCESS_IDENTITY_PLATFORM: "darwin" },
    argv: ["node", "identity.mjs"],
    kill: (...args: unknown[]) => {
      syn.signals.push(args);
      throw new Error("signals forbidden");
    },
    exit: (code: number) => {
      throw new Error(`unexpected exit ${code}`);
    },
  };
  const context: Record<string, unknown> = {
    process: fakeProcess,
    console,
    fs: syn.fakeFs,
    path,
    spawnSync: syn.spawnSync,
    TT_ROOT: TT_ROOT_SYNTH,
    // Synthetic provenance/chain stubs ONLY for the harness-kind scenarios:
    // pre-fix, the harness branch's vacuous group gate falls through to
    // provenance; the stubs make that fall-through ACCEPT so the vacuous
    // pass is observable (post-fix the caller-pgid refusal fires first and
    // the stubs are never reached). The daemon-kind scenarios never reach
    // provenance and ignore the stubs.
    verifyProcessProvenance: () => true,
    verifyHarnessIdentityChain: () => ({ ok: true, detail: "synthetic provenance stub" }),
  };
  vm.createContext(context);
  vm.runInContext(moduleSource, context);
  const parsed = ts.createSourceFile("tt-chaos.mjs", chaosText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const decl = parsed.statements.find(
    (s) => ts.isFunctionDeclaration(s) && s.name !== undefined && s.name.text === "verifyKillTarget",
  );
  if (!decl) throw new Error("missing top-level verifyKillTarget function declaration in tt-chaos");
  const fnText = decl.getText(parsed);
  vm.runInContext(fnText, context);
  return { context, syn };
}

function guardOk(context: Record<string, unknown>, pending: Pending): { ok: boolean; reason: string } {
  context.record = pending.record;
  context.kind = pending.kind;
  return vm.runInContext("verifyKillTarget(record, 'synthetic-run', kind)", context) as {
    ok: boolean;
    reason: string;
  };
}

function helperOk(context: Record<string, unknown>, pending: Pending): { ok: boolean; reason: string } {
  context.record = pending.record;
  return vm.runInContext("verifyRecordedTarget(record)", context) as {
    ok: boolean;
    reason: string;
  };
}

// ── expectations ─────────────────────────────────────────────────────────
// For the daemon-kind scenarios this is the coordinator's extended driver
// matrix (complete/disjoint, ancestor, caller-group-missing, parent-missing,
// cycle/depth, existing refusals, late caller observation). helperExpected
// is what the ACTUAL verifyRecordedTarget must return for the record alone;
// guardExpected is what the ACTUAL verifyKillTarget must return for the same
// record through the full daemon/harness corridor.
const DAEMON_SCENARIOS: Array<{
  name: ScenarioName;
  helperExpected: boolean;
  guardExpected: boolean;
  reasonRe?: RegExp;
}> = [
  { name: "complete_disjoint_control", helperExpected: true, guardExpected: true },
  { name: "known_ancestor_refused", helperExpected: false, guardExpected: false, reasonRe: /ancestor of the caller/ },
  { name: "own_pgid_unreadable", helperExpected: false, guardExpected: false, reasonRe: /caller's own process group/ },
  { name: "caller_ancestry_unreadable", helperExpected: false, guardExpected: false, reasonRe: /not an ancestor of the caller/ },
  { name: "deeper_parent_unreadable", helperExpected: false, guardExpected: false, reasonRe: /not an ancestor of the caller/ },
  { name: "parent_chain_cycle", helperExpected: false, guardExpected: false, reasonRe: /not an ancestor of the caller/ },
  { name: "parent_chain_depth_exhausted", helperExpected: false, guardExpected: false, reasonRe: /not an ancestor of the caller/ },
  { name: "late_caller_pgid_unreadable", helperExpected: true, guardExpected: false, reasonRe: /caller's own process group/ },
  { name: "target_pgid_unreadable", helperExpected: false, guardExpected: false, reasonRe: /cannot read pgid/ },
  { name: "identity_unreadable", helperExpected: false, guardExpected: false, reasonRe: /not alive/ },
  { name: "identity_mismatch", helperExpected: false, guardExpected: false, reasonRe: /startTime mismatch/ },
  { name: "same_group_refused", helperExpected: false, guardExpected: false, reasonRe: /equals the caller's own pgid|shares the caller's own pgid/ },
];

const HARNESS_SCENARIOS: Array<{
  name: ScenarioName;
  helperExpected: boolean;
  guardExpected: boolean;
  reasonRe?: RegExp;
}> = [
  { name: "harness_complete_disjoint_control", helperExpected: true, guardExpected: true },
  { name: "harness_caller_pgid_unreadable", helperExpected: true, guardExpected: false, reasonRe: /caller's own process group/ },
  { name: "harness_same_group_refused", helperExpected: false, guardExpected: false, reasonRe: /equals the caller's own pgid|shares the caller's own pgid/ },
];

describe("SGRD (US-014) — the signal guard is fail-closed on unreadable CALLER evidence", () => {
  it("the sources under test carry the SGRD fix markers (structural)", () => {
    assert.match(
      identityText,
      /export function classifyAncestry/,
      "tt-process-identity.mjs must export the tri-state classifyAncestry",
    );
    assert.match(
      identityText,
      /cannot read the caller's own process group — group disjointness from the caller cannot be verified, refusing to signal pid/,
      "verifyRecordedTarget must refuse a group kill whose caller own-pgid read is null",
    );
    assert.match(
      identityText,
      /cannot establish that target pid .* is not an ancestor of the caller \(parent evidence unreadable, cyclic, or depth-exhausted\)/,
      "verifyRecordedTarget must refuse an unprovable (non-disjoint) ancestry",
    );
    assert.match(
      chaosText,
      /cannot read the caller's own process group \(the portable pgid arm is unavailable\) — group disjointness from the caller cannot be verified, refusing to signal daemon pid/,
      "verifyKillTarget's daemon branch must refuse on an unreadable caller pgid",
    );
    assert.match(
      chaosText,
      /cannot read the caller's own process group \(the portable pgid arm is unavailable\) — group disjointness from the caller cannot be verified, refusing to signal target pid/,
      "verifyKillTarget's harness branch must refuse on an unreadable caller pgid",
    );
  });

  it("daemon-kind: the ACTUAL helper and ACTUAL chaos guard meet the fail-closed matrix (recording-only, zero fs/signals)", () => {
    for (const sc of DAEMON_SCENARIOS) {
      const { context, syn } = loadGuard(sc.name);
      const pending = recordFor(sc.name);
      const helper = helperOk(context, pending);
      const guard = guardOk(context, pending);
      assert.equal(helper.ok, sc.helperExpected, `[${sc.name}] helper verifyRecordedTarget: ${helper.reason}`);
      assert.equal(guard.ok, sc.guardExpected, `[${sc.name}] guard verifyKillTarget: ${guard.reason}`);
      if (sc.reasonRe) {
        assert.match(guard.reason, sc.reasonRe, `[${sc.name}] guard refusal reason: ${guard.reason}`);
      }
      assert.deepEqual(syn.fsCalls, [], `[${sc.name}] the guards must make ZERO filesystem accesses`);
      assert.deepEqual(syn.signals, [], `[${sc.name}] the guards must fire ZERO signals`);
    }
  });

  it("harness-kind: the actual chaos guard's own branch refuses an unreadable caller pgid (provenance stubs make the pre-fix vacuous pass observable)", () => {
    for (const sc of HARNESS_SCENARIOS) {
      const { context, syn } = loadGuard(sc.name);
      const pending = recordFor(sc.name);
      const helper = helperOk(context, pending);
      const guard = guardOk(context, pending);
      assert.equal(helper.ok, sc.helperExpected, `[${sc.name}] helper verifyRecordedTarget: ${helper.reason}`);
      assert.equal(guard.ok, sc.guardExpected, `[${sc.name}] guard verifyKillTarget: ${guard.reason}`);
      if (sc.reasonRe) {
        assert.match(guard.reason, sc.reasonRe, `[${sc.name}] guard refusal reason: ${guard.reason}`);
      }
      assert.deepEqual(syn.fsCalls, [], `[${sc.name}] the guards must make ZERO filesystem accesses`);
      assert.deepEqual(syn.signals, [], `[${sc.name}] the guards must fire ZERO signals`);
    }
  });

  it("classifyAncestry tri-state verdicts on the actual helper (ancestor / disjoint / unknown)", () => {
    // Drive classifyAncestry directly through the VM with a tiny ppid table:
    // caller 9000's parent chain is scripted per case.
    const table: Array<{
      name: string;
      ppid: (pid: number) => string | "unreadable";
      target: number;
      expected: "ancestor" | "disjoint" | "unknown";
    }> = [
      { name: "self is an ancestor", ppid: () => "100", target: SELF_PID, expected: "ancestor" },
      { name: "chain reaches the target", ppid: (p) => (p === SELF_PID ? String(TARGET_PID) : p === TARGET_PID ? "0" : "0"), target: TARGET_PID, expected: "ancestor" },
      { name: "fully observed walk to the root", ppid: (p) => (p === SELF_PID ? "100" : p === 100 ? "1" : "0"), target: TARGET_PID, expected: "disjoint" },
      { name: "unreadable parent evidence", ppid: (p) => (p === SELF_PID ? "unreadable" : "0"), target: TARGET_PID, expected: "unknown" },
      { name: "ppid cycle", ppid: (p) => (p === SELF_PID ? "100" : "9000"), target: TARGET_PID, expected: "unknown" },
      { name: "depth exhausted", ppid: (p) => (p >= SELF_PID ? String(p + 1) : "0"), target: TARGET_PID, expected: "unknown" },
    ];
    for (const row of table) {
      const syn = makeSynthetic("complete_disjoint_control");
      const spawnSync = (bin: string, args: string[]) => {
        syn.calls.push({ bin, args });
        if (args[3] === "ppid=") {
          const pid = Number(args[1]);
          const ppid = row.ppid(pid);
          return ppid === "unreadable"
            ? { status: 1, stdout: "", stderr: "synthetic unreadable" }
            : { status: 0, stdout: ppid, stderr: "" };
        }
        throw new Error(`unexpected synthetic command: ${bin} ${args.join(" ")}`);
      };
      const moduleSource = identityText
        .replace(/^#![^\n]*\n/, "")
        .split("\n")
        .filter((l) => !/^\s*import\s/.test(l))
        .join("\n")
        .replace(/\bexport function /g, "function ");
      const context: Record<string, unknown> = {
        process: { pid: SELF_PID, platform: "darwin", env: { TT_PROCESS_IDENTITY_PLATFORM: "darwin" }, argv: [], kill: () => { throw new Error("signals forbidden"); }, exit: () => { throw new Error("unexpected exit"); } },
        console,
        fs: syn.fakeFs,
        spawnSync,
      };
      vm.createContext(context);
      vm.runInContext(moduleSource, context);
      context.target = row.target;
      context.self = SELF_PID;
      const verdict = vm.runInContext("classifyAncestry(target, self)", context);
      assert.equal(verdict, row.expected, `${row.name} must classify as ${row.expected}`);
      assert.deepEqual(syn.signals, [], `${row.name}: no signals`);
    }
  });
});
