// SGBD-OWN — recording-only cleanup-selection safety gate for the SGBD 9.1.2
// self-test (tier0-scenario-unreleased-bounds.test.ts). Beads
// tamandua-6sy.9.1.2.1.
//
// Context (SGBD-OWN mandatory root finding): the self-test's pre-fix
// helpers performed a full procfs cmdline substring search and then
// SIGNALLED each selected numeric pid with NO ownership/birth validation.
// A recording-only VM probe (root diagnostic, at 2026-09-09T00:58:23Z)
// showed a synthetic unrelated readonly observer whose argv merely mentioned
// the fixture directory being selected and a SIGTERM recorded. A unique
// substring is NOT ownership, so the self-test now performs NO process
// discovery-and-kill (see the source pin below) and keeps only a READ-ONLY
// observation surface (observeFixtureHolders / leakVerdict, delimited by the
// stable SGBD_OBSERVER markers in the self-test) that never signals and
// reports an explicitly "unsupported" observation on a procfs-less host.
//
// What this gate is:
//   * A single, focused, RECORDING-ONLY regression file, auto-discovered by
//     self-tests/run.sh's existing fast `tier0-*.test.ts` glob (like the
//     SGBD self-test, it is deliberately NOT registered in any
//     HEAVY_CAMPAIGN_TESTS lock-step list). Its SELECTION SCENARIOS spawn no
//     child, make no real process query and send no signal: they evaluate the
//     ACTUAL committed observation functions (extracted verbatim from the
//     committed self-test between the SGBD_OBSERVER markers and
//     type-stripped) inside a VM whose only process/filesystem surface is a
//     recording substitute, so every scenario runs with ZERO real signals and
//     ZERO real process queries (asserted per scenario from the recording
//     journal; the fs/process substitutes record AND throw, so any accidental
//     real access fails the scenario loudly). The gate's evidence retention
//     (writeEvidence and the final tree-cleanliness assertions) spawns only
//     read-only git subprocesses (rev-parse / status) — that is this file's
//     entire process surface outside the mocked scenarios.
//   * Deterministic synthetic selection scenarios:
//       1. an UNRELATED readonly observer whose argv merely mentions the
//          fixture path is observed but NEVER signalled — a substring match
//          is not ownership;
//       2. CHANGED / REUSED pid evidence (a pid that matched on the first
//          scan belongs to a different process by the grace re-scan) is never
//          signalled — a later clean "none" is valid only over fully-read
//          evidence (unreadable === 0); MISSING evidence (a listed pid whose
//          cmdline cannot be read) is never signalled and never claimed
//          clean — it yields the explicit "partial-unknown" disposition;
//       3. PROCFS UNAVAILABLE (a procfs-less host) reports an explicitly
//          unsupported observation — never reinterpreted as clean.
//   * A source pin on the committed self-test proving it contains NO process
//     discovery-and-kill runtime surface: its only real signal sites are the
//     two bounded `child.kill` calls on its OWN retained spawn child handle,
//     each guarded by a live-child check (exitCode === null && signalCode ===
//     null) so a child already exited/reaped is never signalled. The pin is
//     textual — it counts `.kill(` sites, banned identifiers and guard
//     conditions in the committed source; it does not execute the self-test,
//     so the "never after exit/reap" property is pinned as guarded structure,
//     not proven by execution.
//
// Evidence: a fresh torture-test/var/review-logs/<fresh-id>/ directory per
// run (kind host / kind source / kind case), never deleted. Leaves git
// status clean (evidence lives under the gitignored var/ tree).
//
// Runs as its own `node --test torture-test/self-tests/
// tier0-scenario-unreleased-bounds-safety-gate.test.ts`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import vm from "node:vm";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const REVIEW_ROOT = path.join(repoRoot, "torture-test", "var", "review-logs");
const SELF_TEST_REL = "torture-test/self-tests/tier0-scenario-unreleased-bounds.test.ts";
const SELF_TEST_PATH = path.join(repoRoot, SELF_TEST_REL);
const OBSERVER_START = "// SGBD_OBSERVER_START";
const OBSERVER_END = "// SGBD_OBSERVER_END";

const selfTestSource = fs.readFileSync(SELF_TEST_PATH, "utf8");
const selfTestSha = crypto.createHash("sha256").update(selfTestSource).digest("hex");

// ── extract the ACTUAL committed observation surface ────────────────────
// The slice between the stable markers holds exactly the two pure functions
// (observeFixtureHolders + leakVerdict); type annotations are stripped with
// node:module's stripTypeScriptTypes (the same mechanism the root diagnostic
// probe uses) so the text can be evaluated in the recording VM. Keeping the
// extraction on the committed file (never a copy) is what makes the gate
// exercise the exact code the real-child level runs.
function extractObserverJs(): string {
  const from = selfTestSource.indexOf(OBSERVER_START);
  const to = selfTestSource.indexOf(OBSERVER_END, from);
  assert.ok(
    from >= 0 && to > from,
    `committed ${SELF_TEST_REL} must still carry the ${OBSERVER_START} / ${OBSERVER_END} markers`,
  );
  const tsSource = selfTestSource.slice(from + OBSERVER_START.length, to);
  assert.match(
    tsSource,
    /function observeFixtureHolders\(/,
    "the extracted slice must contain the actual observeFixtureHolders",
  );
  assert.match(
    tsSource,
    /function leakVerdict\(/,
    "the extracted slice must contain the actual leakVerdict",
  );
  return stripTypeScriptTypes(tsSource);
}

const observerJs = extractObserverJs();

// ── recording VM (mirrors the root probe methodology; zero real access) ─
interface ScenarioOutcome {
  out: unknown;
  journal: string[];
}

function runScenario(driverExpr: string): ScenarioOutcome {
  const journal: string[] = [];
  const sandbox: Record<string, unknown> = {
    console,
    // The driver may journal synthetic observations/decisions through _record.
    _record: (s: unknown): void => {
      journal.push(String(s));
    },
    // Recording substitutes: any real process signal or filesystem access is
    // journaled AND throws, so a scenario that touches the real OS fails
    // loudly instead of silently passing.
    process: {
      kill: (...args: unknown[]): boolean => {
        journal.push(`PROCESS_KILL:${args.join(",")}`);
        throw new Error("SGBD safety gate: a real process.kill was attempted inside the mocked surface");
      },
    },
    fs: new Proxy(
      {},
      {
        get(_target, prop): (..._a: unknown[]) => never {
          return (..._a: unknown[]): never => {
            journal.push(`FS:${String(prop)}`);
            throw new Error(`SGBD safety gate: a real fs.${String(prop)} access was attempted inside the mocked surface`);
          };
        },
      },
    ),
  };
  sandbox.__scenarioResult = undefined;
  vm.createContext(sandbox);
  const program = `${observerJs}\n__scenarioResult = (${driverExpr})();\n`;
  vm.runInContext(program, sandbox, { filename: "sgbd-observer-gate.mjs" });
  const out = sandbox.__scenarioResult;
  // JSON round-trip so assertions run on host-realm plain data (the VM
  // result is contextified; primitives and JSON shapes survive identically).
  return { out: out === undefined ? undefined : JSON.parse(JSON.stringify(out)), journal };
}

function assertRecordingOnly(scenario: string, journal: string[]): void {
  const banned = journal.filter((e) => e.startsWith("PROCESS_KILL:") || e.startsWith("FS:"));
  assert.deepEqual(
    banned,
    [],
    `${scenario}: the mocked selection function touched the real OS surface (zero real signals/queries required): ${banned.join(" | ")}`,
  );
}

// ── synthetic fixture tokens (deliberately not real paths) ──────────────
const TOKEN_A = "/synthetic/fixture-owned-123";

// ── evidence retention (fresh dir per run; never deleted) ───────────────
let evidenceDir = "";
let runLogPath = "";
const caseLines: string[] = [];

function recordCase(c: Record<string, unknown>): void {
  caseLines.push(JSON.stringify({ kind: "case", ...c }));
}

function writeEvidence(): void {
  fs.mkdirSync(REVIEW_ROOT, { recursive: true });
  const id = crypto.randomBytes(6).toString("hex");
  evidenceDir = path.join(REVIEW_ROOT, `sgbd-9-1-2-selection-safety-gate-${id}`);
  fs.mkdirSync(evidenceDir, { recursive: true });
  const pin = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const lines: string[] = [
    JSON.stringify({
      kind: "host",
      platform: process.platform,
      node: process.version,
      pin,
      execution:
        "SGBD-OWN recording-only safety gate: actual committed observation helpers evaluated in a VM with recording substitutes; zero real signals, zero real process queries, zero real filesystem access; synthetic selection scenarios (unrelated observer mentions path / changed / reused / missing pid evidence / procfs unavailable)",
    }),
    JSON.stringify({
      kind: "source",
      file: SELF_TEST_REL,
      sha256: selfTestSha,
      extracted_surface_sha256: crypto.createHash("sha256").update(observerJs).digest("hex"),
      markers: `${OBSERVER_START} / ${OBSERVER_END}`,
      scope: "exact committed observeFixtureHolders/leakVerdict only; NOT sourcing or running the self-test",
    }),
    ...caseLines,
  ];
  const evidencePath = path.join(evidenceDir, "evidence.jsonl");
  fs.writeFileSync(evidencePath, lines.join("\n") + "\n");
  runLogPath = path.join(evidenceDir, "run.log");
  fs.writeFileSync(
    runLogPath,
    [
      `command: ${process.argv.join(" ")}`,
      `intended: node --test torture-test/self-tests/tier0-scenario-unreleased-bounds-safety-gate.test.ts`,
      `cwd: ${process.cwd()}`,
      `self_test_sha256: ${selfTestSha}`,
      `evidence: ${evidencePath}`,
    ].join("\n") + "\n",
  );
  process.once("exit", (code) => {
    try {
      fs.appendFileSync(runLogPath, `node_test_real_exit: ${code}\n`);
    } catch {
      // best-effort at process exit
    }
  });
}

// ── the gate ────────────────────────────────────────────────────────────
describe("SGBD-OWN — recording-only cleanup-selection safety gate", () => {
  it("extracts the actual committed observation helpers from the self-test", () => {
    assert.match(observerJs, /function observeFixtureHolders\(/);
    assert.match(observerJs, /function leakVerdict\(/);
    assert.ok(selfTestSha.length === 64);
  });

  it("SOURCE PIN: the committed self-test performs no process discovery-and-kill", () => {
    // The banned discovery-and-kill helper identifiers must not exist in the
    // committed self-test at all.
    for (const name of ["leaked" + "Children", "kill" + "Leaked"]) {
      assert.ok(
        !selfTestSource.includes(name),
        `committed ${SELF_TEST_REL} must not contain the banned helper '${name}'`,
      );
    }
    // No arbitrary-pid signalling surface may remain.
    assert.ok(
      !selfTestSource.includes("process." + "kill("),
      `committed ${SELF_TEST_REL} must not call process.kill on a pid`,
    );
    // The ONLY real signal sites are the two bounded kills on the self-test's
    // OWN retained spawn child handle (the anchor exit-race) — every `.kill(`
    // occurrence must be a `child.kill(` and there must be exactly two.
    const dotKillCount = selfTestSource.split(".kill(").length - 1;
    const childKillCount = selfTestSource.split("child.kill(").length - 1;
    assert.equal(
      childKillCount,
      2,
      `committed ${SELF_TEST_REL} must contain exactly the two owned-handle child.kill sites (anchor exit-race), got ${childKillCount}`,
    );
    assert.equal(
      dotKillCount,
      childKillCount,
      `every .kill( in the committed self-test must be a child.kill( on the retained handle (got ${dotKillCount} .kill( sites)`,
    );
    // Each real signal site must be structurally guarded so a child that has
    // already exited/reaped is never signalled: a kill may target the child
    // only while exitCode and signalCode are BOTH still null. The pin counts
    // guard occurrences — it is textual and does not execute the self-test —
    // so it pins the guarded structure (every kill site carries the guard),
    // not a runtime property.
    const liveChildGuard = "child.exitCode === null && child.signalCode === null";
    const liveChildGuardCount = selfTestSource.split(liveChildGuard).length - 1;
    assert.ok(
      liveChildGuardCount >= childKillCount,
      `each of the ${childKillCount} child.kill( sites must be guarded by '${liveChildGuard}' (found ${liveChildGuardCount}) — an exited/reaped child must never be signalled`,
    );
    // The read-only observation surface the gate exercises must be present.
    assert.ok(
      selfTestSource.includes("function observeFixtureHolders("),
      "the committed self-test must keep the read-only observeFixtureHolders",
    );
    assert.ok(
      selfTestSource.includes("function leakVerdict("),
      "the committed self-test must keep the pure leakVerdict disposition",
    );
  });

  it("unrelated observer that merely mentions the path is observed, never signalled", () => {
    // Root-probe scenario: a readonly observer whose argv mentions the
    // fixture token. A substring match is NOT ownership — the observation is
    // retained as evidence with verdict "observed-unowned" and ZERO signals.
    const driver = `
      function () {
        var token = ${JSON.stringify(TOKEN_A)};
        var proc = {
          listPids: function () { _record("listPids"); return ["1234"]; },
          readCmdline: function (pid) { _record("readCmdline:" + pid); return "node\\0readonly-observer\\0--inspect=" + token + "\\0"; }
        };
        var obs = observeFixtureHolders(token, proc);
        var verdict = leakVerdict(obs);
        return { token: token, obs: obs, verdict: verdict };
      }`;
    const { out, journal } = runScenario(driver);
    assertRecordingOnly("unrelated_observer_mentions_path", journal);
    const r = out as {
      obs: { supported: boolean; matched: number[]; unreadable: number };
      verdict: string;
    };
    assert.equal(r.obs.supported, true);
    assert.deepEqual(r.obs.matched, [1234], "the unrelated observer is OBSERVED (evidence only)");
    assert.equal(r.obs.unreadable, 0);
    assert.equal(
      r.verdict,
      "observed-unowned",
      "a substring match alone must never be ownership: verdict must refuse a clean/owned claim",
    );
    assert.ok(
      !journal.some((e) => e.startsWith("PROCESS_KILL:")),
      "no signal may be recorded for the unrelated observer",
    );
    recordCase({
      scenario: "unrelated_observer_mentions_path",
      synthetic_observer_argv_mentions_token: true,
      observed_matched: r.obs.matched,
      verdict: r.verdict,
      real_signals: 0,
      real_process_queries: 0,
    });
  });

  it("changed/reused pid evidence and missing pid evidence are never signalled or claimed clean", () => {
    // Reused pid: the pid matches on the first scan, but by the grace re-scan
    // the pid belongs to a DIFFERENT process (evidence changed). No
    // ownership/birth evidence exists for the pid, so no signal may ever fire.
    // The re-scan's "none" is a clean disposition ONLY because its evidence is
    // fully read (unreadable === 0) and matched nothing — never because a
    // match was "cleaned" by a signal.
    const reusedDriver = `
      function () {
        var token = "/synthetic/fixture-owned-456";
        var queue = [
          "node\\0mine\\0" + token + "\\0",        // first scan: matches
          "node\\0unrelated-now\\0/other\\0"        // grace re-scan: pid reused
        ];
        var proc = {
          listPids: function () { return ["4242"]; },
          readCmdline: function () { return queue.shift() || null; }
        };
        var first = observeFixtureHolders(token, proc);
        var second = observeFixtureHolders(token, proc);
        return {
          first: first,
          second: second,
          verdicts: [leakVerdict(first), leakVerdict(second)]
        };
      }`;
    const reused = runScenario(reusedDriver);
    assertRecordingOnly("reused_pid_evidence", reused.journal);
    const rr = reused.out as {
      first: { supported: boolean; matched: number[]; unreadable: number };
      second: { supported: boolean; matched: number[]; unreadable: number };
      verdicts: string[];
    };
    assert.deepEqual(rr.first.matched, [4242], "first scan observes the transient match (evidence only)");
    assert.equal(rr.verdicts[0], "observed-unowned");
    assert.deepEqual(rr.second.matched, [], "re-scan: the pid now belongs to a different process");
    assert.equal(rr.second.unreadable, 0, "a clean 'none' rests on fully-read evidence (unreadable === 0)");
    assert.equal(rr.verdicts[1], "none");
    assert.ok(
      !reused.journal.some((e) => e.startsWith("PROCESS_KILL:")),
      "a pid that matched transiently must never be signalled (no birth/ownership evidence; pid may have been reused)",
    );

    // Missing evidence: a listed pid whose cmdline cannot be read is recorded
    // as unreadable, never matched and never signalled. Absence-of-holder
    // over PARTIALLY-UNKNOWN evidence is never a clean claim: the disposition
    // must be the explicit "partial-unknown", never "none", and the unreadable
    // count stays in the observation.
    const missingDriver = `
      function () {
        var token = "/synthetic/fixture-owned-789";
        var proc = {
          listPids: function () { return ["7777"]; },
          readCmdline: function () { return null; } // vanished / unreadable
        };
        var obs = observeFixtureHolders(token, proc);
        return { obs: obs, verdict: leakVerdict(obs) };
      }`;
    const missing = runScenario(missingDriver);
    assertRecordingOnly("missing_pid_evidence", missing.journal);
    const mr = missing.out as {
      obs: { supported: boolean; matched: number[]; unreadable: number };
      verdict: string;
    };
    assert.deepEqual(mr.obs.matched, [], "unreadable cmdline must never count as a match");
    assert.equal(mr.obs.unreadable, 1, "missing evidence is recorded, not hidden");
    assert.equal(
      mr.verdict,
      "partial-unknown",
      "missing/unreadable pid evidence must never be claimed clean: the disposition is the explicit partial-unknown, never none",
    );
    assert.ok(
      !missing.journal.some((e) => e.startsWith("PROCESS_KILL:")),
      "missing evidence must never be signalled",
    );

    recordCase({
      scenario: "changed_reused_missing_pid_evidence",
      reused_verdicts: rr.verdicts,
      reused_signals: 0,
      missing_unreadable: mr.obs.unreadable,
      missing_verdict: mr.verdict,
      real_signals: 0,
      real_process_queries: 0,
    });
  });

  it("procfs unavailable is an explicit unsupported observation, never a clean claim", () => {
    // A procfs-less host (e.g. Darwin) has no process table to observe. The
    // observation must report supported:false and the verdict must be
    // "unsupported" — NEVER "none" — so no caller can reinterpret the lack of
    // observation as "no leaks".
    const driver = `
      function () {
        var proc = {
          listPids: function () { return null; }, // procfs mount unavailable
          readCmdline: function () { throw new Error("must not be called"); }
        };
        var obs = observeFixtureHolders("/synthetic/fixture-owned-abc", proc);
        return { obs: obs, verdict: leakVerdict(obs) };
      }`;
    const { out, journal } = runScenario(driver);
    assertRecordingOnly("procfs_unavailable", journal);
    const r = out as {
      obs: { supported: boolean; matched: number[]; unreadable: number };
      verdict: string;
    };
    assert.equal(r.obs.supported, false);
    assert.deepEqual(r.obs.matched, []);
    assert.equal(
      r.verdict,
      "unsupported",
      "unavailable observation must be labelled unsupported, never clean",
    );
    assert.ok(
      !journal.some((e) => e.startsWith("PROCESS_KILL:")),
      "an unsupported observation must never lead to a signal",
    );
    recordCase({
      scenario: "procfs_unavailable",
      supported: r.obs.supported,
      verdict: r.verdict,
      real_signals: 0,
      real_process_queries: 0,
    });
  });

  // Evidence is retained by design (gitignored var tree); write it in a
  // before() of the LAST describe (node:test runs describes sequentially)
  // so it records every scenario above — including failures — and the final
  // it() asserts the tree is clean.
  describe("evidence retention", () => {
    before(() => {
      writeEvidence();
    });

    it("retains fresh evidence under torture-test/var/review-logs", () => {
      assert.ok(evidenceDir.startsWith(REVIEW_ROOT + path.sep), `evidence escaped review-logs: ${evidenceDir}`);
      assert.ok(fs.existsSync(path.join(evidenceDir, "evidence.jsonl")), "evidence.jsonl must exist");
      assert.ok(fs.existsSync(runLogPath), "run.log must exist");
    });

    it("leaves the working tree clean after retaining evidence", () => {
      const status = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim();
      assert.equal(status, "", `gate left the working tree dirty:\n${status}`);
    });
  });
});

after(() => {
  // no-op: retained evidence is deliberately left on disk for coordinator review
});
