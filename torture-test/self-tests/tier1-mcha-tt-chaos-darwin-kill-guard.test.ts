// MCHA (R4a US-014) — tt-chaos darwin kill guard uses portable pgid /
// ownership evidence.
//
// Darwin defect: tt-chaos's fire-time guard gathered its disjointness
// evidence ONLY from procfs (tt-process-identity getProcessGroup /
// getProcessParent read /proc/<pid>/stat; tt-chaos verifyProcessProvenance
// and the S33 parent-chain read /proc/<pid>/cwd + cmdline; tt-controller's
// processGroupOf/processStartTimeOf recorded harness/daemon identities from
// /proc). On the mac (no procfs) every pgid/ppid/cwd/cmdline read returned
// null, so mac campaign #1 cells W4.09-pi, W4.09-hermes, W4.10-kill-daemon
// and W4.48a ALL ended chaos-invocation-failed: `chaos operator 'tt-chaos'
// exited 3` with `GUARD_MISS: cannot read the process group of daemon pid N
// (no /proc) — group disjointness from the caller cannot be verified,
// refusing to signal`. Correct fail-closed behavior, wrong evidence source.
//
// Fix (files ONLY under torture-test/):
//   1. tt-process-identity.mjs: getProcessGroup/getProcessParent/getProcess
//      Cwd/getProcessCmdline are now PORTABLE — the platform branch is the
//      existing TT_PROCESS_IDENTITY_PLATFORM seam (linux = /proc unchanged;
//      darwin = `ps -p <pid> -o pgid=` / `ps -p <pid> -o ppid=` /
//      `ps -p <pid> -o command=` / `lsof -a -p <pid> -d cwd -Fn` — the same
//      mechanical evidence daemon-control's ownership check and the identity
//      arm already use). isAncestorOf walks via getProcessParent, so the
//      ancestry gate is portable too. A pid whose evidence is unreadable on
//      EITHER branch still returns null (fail-closed — never a weak accept).
//   2. tt-chaos: verifyProcessProvenance + parentChainOwnershipProof read
//      cwd/cmdline through the portable readers; isProcessAlive degrades to
//      kill(0)-alone on /proc-less hosts (the sigstop hold re-verify); the
//      --target-start-time normalizer no longer mints `proc:darwin:...` for a
//      darwin:<lstart> recorded identity; the daemon pgid-unreadable refusal
//      now names the portable arm.
//   3. tt-controller (probe-sequence engine audit): processGroupOf /
//      processStartTimeOf delegate to the tt-process-identity portable arms,
//      so the explicit harness/daemon target records (var/targets/<run>.json
//      and the launch-hook identities handed to tt-chaos as --target-*) carry
//      a real pgid + start identity on Darwin (the old procfs-only recorders
//      left them null there, silently weakening the fire-time ABA/group gates
//      to "no recorded identity"). Audit note: processIdentity (the durable-
//      runner crash-recovery identity, a distinct 'linux-proc-start-<n>'
//      format) stays /proc-only — on a /proc-less host it degrades to null
//      and crash recovery falls back to persisted-hook-state evidence (never
//      a signal); the MCHA kill corridors do not depend on it.
//
// Hermetic (linux-runnable, zero tokens): Darwin is SIMULATED on linux via
// the TT_PROCESS_IDENTITY_PLATFORM seam (the TT_DC_PLATFORM-style seam the
// MCHA task names), with REAL ps/lsof on this host as the mechanical darwin
// evidence source. Whole-tool arms drive the REAL bin/tt-chaos (spawned
// detached children only — every pid the test spawns is killed in finally).
//
// RED case (recorded in the progress log): point TT_MCHA_TOOL_TREE at a temp
// tree holding the PRE-FIX files (git show HEAD blobs):
//
//   TMPD=$(mktemp -d); mkdir -p "$TMPD/bin"
//   git show HEAD:torture-test/bin/tt-chaos > "$TMPD/bin/tt-chaos"
//   git show HEAD:torture-test/bin/tt-process-identity.mjs > "$TMPD/bin/tt-process-identity.mjs"
//   git show HEAD:torture-test/bin/tt-trigger-vocabulary.mjs > "$TMPD/bin/tt-trigger-vocabulary.mjs"
//   chmod +x "$TMPD/bin/tt-chaos"
//   TT_MCHA_TOOL_TREE="$TMPD" node --test \
//     torture-test/self-tests/tier1-mcha-tt-chaos-darwin-kill-guard.test.ts
//
// Pre-fix every darwin-arm assertion is RED: the tools carry no portable
// pgid/ppid/cwd/cmdline arms (the structural pins fail), getProcessGroup on
// the darwin seam ignores ps entirely (the ps-shim pin fails), and
// tt-process-identity exports no getProcessCwd/getProcessCmdline (the
// function pins fail) — the same evidence gap that GUARD_MISSed every mac
// kill. Green post-fix. (A whole-tool RED cannot be behavioral on linux:
// the pre-fix /proc reads succeed there, so the pgid refusal is only
// reproducible on a real /proc-less host — the mac campaign #2 validates the
// fired corridor there; the campaign #1 failure is pinned verbatim below.)
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded battery —
// no run.sh edit). Confined to torture-test/.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
// TT_MCHA_TOOL_TREE: alternate tool tree (bin/tt-chaos + bin/tt-process-
// identity.mjs + bin/tt-trigger-vocabulary.mjs) the assertions drive — used
// to demonstrate the RED case against the pre-fix tools (see header).
// Defaults to the working tree.
const toolTree = process.env.TT_MCHA_TOOL_TREE ?? ttRoot;
const ttChaos = path.join(toolTree, "bin", "tt-chaos");
const identityTool = path.join(toolTree, "bin", "tt-process-identity.mjs");
const chaosText = fs.readFileSync(path.join(ttRoot, "bin", "tt-chaos"), "utf8");
const identityText = fs.readFileSync(path.join(ttRoot, "bin", "tt-process-identity.mjs"), "utf8");
const controllerText = fs.readFileSync(path.join(ttRoot, "bin", "tt-controller"), "utf8");

// ── Pinned campaign evidence (mac campaign #1 — the MCHA defect) ────────
// Every W4.09-pi / W4.09-hermes / W4.10-kill-daemon / W4.48a cell ended
// chaos-invocation-failed with the SAME operator exit; the chaos.log
// guard_miss reason names the pgid-unreadable refusal (the MCHA task quotes
// it as '(no procfs)' — the operator's '(no /proc)' parenthetical).
const MAC_KILL_CELLS = [
  "W4.09-pi",
  "W4.09-hermes",
  "W4.10-kill-daemon",
  "W4.48a",
];
const CAMPAIGN_INFRA_LINE =
  "chaos-invocation-failed (chaos operator 'tt-chaos' exited 3)";
const CAMPAIGN_GUARD_MISS_REASON =
  "cannot read the process group of daemon pid (no /proc) — group disjointness from the caller cannot be verified, refusing to signal";

// ── helpers ────────────────────────────────────────────────────────────

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the tools operate on temp dirs + test-spawned pids only.
 *  Also drop any ambient TAMANDUA_DB_PATH: each kill-corridor child uses the
 *  contained fake TT var DB at <TT_HOME>/tamandua.db, and an inherited gate DB
 *  path (the battery runner owns one under its outer state dir) would take
 *  precedence and make the guard fail-closed with 'Cannot open TT DB'. */
function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TAMANDUA_DB_PATH;
  env.TAMANDUA_TEST_GUARD = "0";
  if (extra) Object.assign(env, extra);
  return env;
}

interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): CmdResult {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? cleanEnv(),
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

/** Build a throwaway TT var directory with a fake contained DB whose runs
 *  table carries one 'running' row for the given run id. */
function fakeTtVar(runId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mcha-tt-${process.pid}-`));
  fs.mkdirSync(path.join(dir, "chaos"), { recursive: true });
  const db = new DatabaseSync(path.join(dir, "tamandua.db"), { open: true });
  db.exec(`CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    workflow_id TEXT,
    created_at TEXT
  );`);
  db.prepare("INSERT OR REPLACE INTO runs (run_id, status, workflow_id) VALUES (?, ?, ?)")
    .run(runId, "running", "test-wf");
  db.close();
  return dir;
}

/** Spawn a detached (own session + group) long-lived node child. Returns the
 *  pid; callers MUST kill it in finally. */
function spawnDetached(opts: { cwd?: string; argv0?: string } = {}): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    cwd: opts.cwd,
    detached: true,
    argv0: opts.argv0,
    stdio: "ignore",
  });
  assert.ok(child.pid, "detached child must have a pid");
  return child.pid;
}

/** Spawn a NON-detached child (shares the caller's process group). */
function spawnSameGroup(): number {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    stdio: "ignore",
  });
  assert.ok(child.pid, "child must have a pid");
  return child.pid;
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Read a pid's real pgid via ps (the mechanical darwin sim source). */
function realPgidOf(pid: number): number {
  const res = spawnSync("ps", ["-p", String(pid), "-o", "pgid="], {
    encoding: "utf8",
  });
  assert.equal(res.status, 0, `ps pgid failed for ${pid}: ${res.stderr}`);
  const pgid = Number(String(res.stdout ?? "").trim());
  assert.ok(Number.isInteger(pgid) && pgid > 0, `unreadable pgid for ${pid}`);
  return pgid;
}

/** Read a pid's darwin start identity via the tool under test (darwin seam),
 *  exactly as tt-controller's portable recorder would. */
function darwinIdentityOf(pid: number): string {
  const res = run([process.execPath, identityTool, "--get", String(pid)], {
    env: cleanEnv({ TT_PROCESS_IDENTITY_PLATFORM: "darwin" }),
  });
  assert.equal(res.status, 0, `identity --get failed for ${pid}: ${res.stderr}`);
  return res.stdout.trim();
}

/** Kill-corridor env: contained fake TT var + the darwin platform seam. */
function killEnv(varDir: string, extra?: Record<string, string>): NodeJS.ProcessEnv {
  return cleanEnv({
    TT_PROCESS_IDENTITY_PLATFORM: "darwin",
    TT_ROOT: varDir,
    TT_HOME: varDir,
    TAMANDUA_STATE_DIR: varDir,
    ...extra,
  });
}

// ── the guard ──────────────────────────────────────────────────────────

describe("MCHA (US-014) — tt-chaos darwin kill guard uses portable pgid/ownership evidence", () => {
  // ── 1. recorded mac campaign evidence (the defect this story fixes) ──
  it("RED-ARM (recorded): pins the mac campaign #1 kill-cell failures (every cell: chaos operator 'tt-chaos' exited 3)", () => {
    assert.deepEqual(MAC_KILL_CELLS, ["W4.09-pi", "W4.09-hermes", "W4.10-kill-daemon", "W4.48a"]);
    assert.match(CAMPAIGN_INFRA_LINE, /^chaos-invocation-failed \(chaos operator 'tt-chaos' exited 3\)$/);
    assert.match(
      CAMPAIGN_GUARD_MISS_REASON,
      /^cannot read the process group of daemon pid \(no \/proc\) — group disjointness from the caller cannot be verified, refusing to signal$/,
      "the darwin pgid-unreadable refusal the campaign recorded",
    );
  });

  // ── 2. structural pins (green arms — the portable arms exist) ────────
  it("tt-process-identity.mjs carries portable pgid/ppid/cwd/cmdline arms behind the platform seam (structural)", () => {
    // The seam is the SAME TT_PROCESS_IDENTITY_PLATFORM the darwin identity
    // source already uses (a darwin-simulated kill corridor selects the
    // portable arms on linux exactly as a real mac would).
    assert.match(
      identityText,
      /TT_PROCESS_IDENTITY_PLATFORM \?\? process\.platform/,
      "the platform branch must be decided by the TT_PROCESS_IDENTITY_PLATFORM seam",
    );
    assert.match(identityText, /ps -p <pid> -o pgid=|'-p', String\(pid\), '-o', `pgid=`/,
      "getProcessGroup must read `ps -o pgid=` on darwin (the portable pgid arm)");
    assert.match(identityText, /ps -p <pid> -o ppid=|'-p', String\(pid\), '-o', `ppid=`/,
      "getProcessParent must read `ps -o ppid=` on darwin (the portable ppid arm)");
    assert.match(identityText, /lsof -a -p <pid> -d cwd -Fn|lsofBin, \['-a', '-p', String\(pid\), '-d', 'cwd', '-Fn'\]/,
      "getProcessCwd must read `lsof -a -p <pid> -d cwd -Fn` on darwin (the portable cwd arm)");
    assert.match(identityText, /ps -p <pid> -o command=|'-p', String\(pid\), '-o', `command=`/,
      "getProcessCmdline must read `ps -o command=` on darwin (the portable cmdline arm)");
    assert.match(identityText, /export function getProcessCwd/,
      "getProcessCwd must be exported (tt-chaos provenance consumes it)");
    assert.match(identityText, /export function getProcessCmdline/,
      "getProcessCmdline must be exported (tt-chaos provenance consumes it)");
    assert.match(identityText, /export function getProcessParent/,
      "getProcessParent must stay exported");
    // isAncestorOf must walk through the portable getProcessParent so the
    // ancestry gate works on /proc-less hosts too.
    assert.match(identityText, /const parent = getProcessParent\(cur\);/,
      "isAncestorOf must walk via getProcessParent (portable ppid chain)");
  });

  it("tt-chaos gathers its fire-time evidence through the portable arms (structural)", () => {
    assert.match(
      chaosText,
      /getProcessCwd,?\n\s+getProcessCmdline|import \{[^}]*getProcessCwd[^}]*\} from '\.\/tt-process-identity\.mjs'/,
      "tt-chaos must import the portable cwd/cmdline readers",
    );
    // verifyProcessProvenance + parentChainOwnershipProof consume them.
    const provenanceIdx = chaosText.indexOf("function verifyProcessProvenance");
    assert.ok(provenanceIdx >= 0, "verifyProcessProvenance must exist");
    const provenanceFn = chaosText.slice(provenanceIdx, chaosText.indexOf("\n}\n", provenanceIdx) + 3);
    assert.match(provenanceFn, /getProcessCwd\(pid\)/,
      "verifyProcessProvenance must read the cwd portably");
    assert.match(provenanceFn, /getProcessCmdline\(pid\)/,
      "verifyProcessProvenance must read the cmdline portably");
    const chainIdx = chaosText.indexOf("function parentChainOwnershipProof");
    assert.ok(chainIdx >= 0, "parentChainOwnershipProof must exist");
    const chainFn = chaosText.slice(chainIdx, chaosText.indexOf("\n}\n", chainIdx) + 3);
    assert.match(chainFn, /getProcessCwd\(cur\)/,
      "the parent-chain walk must read ancestor cwd portably");
    assert.match(chainFn, /getProcessCmdline\(cur\)/,
      "the parent-chain walk must read ancestor cmdline portably");
    // The sigstop hold re-verify degrades to kill(0)-alone on darwin.
    assert.match(
      chaosText,
      /platform === 'darwin'[\s\S]{0,120}process\.kill\(pid, 0\)/,
      "isProcessAlive must degrade to kill(0)-alone on /proc-less hosts",
    );
    // --target-start-time: a darwin:<lstart> recorded identity must never
    // gain a 'proc:' prefix (the controller passes it through verbatim).
    assert.match(
      chaosText,
      /raw\.startsWith\('proc:'\) \|\| raw\.startsWith\('darwin:'\)/,
      "resolveTargetRecord must keep darwin: identities unprefixed",
    );
    // The pgid-unreadable refusal names the portable arm (no more /proc-only).
    assert.match(
      chaosText,
      /cannot read the process group of daemon pid \$\{record\.pid\} \(no procfs and the portable pgid arm is unavailable\)/,
      "the daemon pgid-unreadable refusal must name the portable arm",
    );
  });

  it("tt-controller (probe-sequence engine) records identities through the portable arms (structural)", () => {
    assert.match(
      controllerText,
      /portableProcessGroupOf|portableProcessStartTimeOf/,
      "tt-controller must delegate to the portable tt-process-identity arms",
    );
    assert.match(controllerText, /from '\.\/tt-process-identity\.mjs'/,
      "the delegation must import bin/tt-process-identity.mjs (single canonical implementation)");
    const startIdx = controllerText.indexOf("function processStartTimeOf");
    assert.ok(startIdx >= 0, "processStartTimeOf must exist (kill-ancestry-hygiene identityRef)");
    const startFn = controllerText.slice(startIdx, startIdx + 300);
    assert.match(startFn, /portableProcessStartTimeOf\(pid\)/,
      "processStartTimeOf must delegate to the portable start-identity arm");
    const groupIdx = controllerText.indexOf("function processGroupOf");
    assert.ok(groupIdx >= 0, "processGroupOf must exist");
    const groupFn = controllerText.slice(groupIdx, groupIdx + 200);
    assert.match(groupFn, /portableProcessGroupOf\(pid\)/,
      "processGroupOf must delegate to the portable pgid arm");
  });

  // ── 3. function-level darwin-sim arms (direct import from the tool tree) ──
  // The pre-fix mirror lacks the portable arms, so these pins are RED there.
  it("getProcessGroup on the darwin seam reads ps (the shim's pgid), never /proc (function-level)", async () => {
    const mod: any = await import(pathToFileURL(identityTool).href);
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcha-ps-"));
    const shim = path.join(shimDir, "ps");
    fs.writeFileSync(shim, `#!/bin/sh\nfor arg in "$@"; do case "$arg" in pgid=*) printf '424242\\n'; exit 0;; esac; done\nexit 1\n`);
    fs.chmodSync(shim, 0o755);
    const childPid = spawnDetached();
    try {
      const prevPlatform = process.env.TT_PROCESS_IDENTITY_PLATFORM;
      const prevPs = process.env.TT_PROCESS_IDENTITY_PS;
      process.env.TT_PROCESS_IDENTITY_PLATFORM = "darwin";
      process.env.TT_PROCESS_IDENTITY_PS = shim;
      try {
        const pgid = mod.getProcessGroup(childPid);
        assert.equal(pgid, 424242,
          "on the darwin seam the pgid MUST come from `ps -o pgid=` (the portable arm), never from a procfs read");
        assert.equal(mod.ownProcessGroup(), 424242,
          "ownProcessGroup must ride the same portable pgid arm");
      } finally {
        if (prevPlatform === undefined) delete process.env.TT_PROCESS_IDENTITY_PLATFORM;
        else process.env.TT_PROCESS_IDENTITY_PLATFORM = prevPlatform;
        if (prevPs === undefined) delete process.env.TT_PROCESS_IDENTITY_PS;
        else process.env.TT_PROCESS_IDENTITY_PS = prevPs;
      }
    } finally {
      killPid(childPid);
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("getProcessParent on the darwin seam reads ps; a failing ps yields null (fail-closed) (function-level)", async () => {
    const mod: any = await import(pathToFileURL(identityTool).href);
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcha-ps-"));
    const okShim = path.join(shimDir, "ps-ok");
    const deadShim = path.join(shimDir, "ps-dead");
    fs.writeFileSync(okShim, `#!/bin/sh\nfor arg in "$@"; do case "$arg" in ppid=*) printf '424243\\n'; exit 0;; esac; done\nexit 1\n`);
    fs.writeFileSync(deadShim, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(okShim, 0o755);
    fs.chmodSync(deadShim, 0o755);
    try {
      const prevPlatform = process.env.TT_PROCESS_IDENTITY_PLATFORM;
      const prevPs = process.env.TT_PROCESS_IDENTITY_PS;
      process.env.TT_PROCESS_IDENTITY_PLATFORM = "darwin";
      try {
        process.env.TT_PROCESS_IDENTITY_PS = okShim;
        assert.equal(mod.getProcessParent(process.pid), 424243,
          "on the darwin seam the ppid MUST come from `ps -o ppid=`");
        process.env.TT_PROCESS_IDENTITY_PS = deadShim;
        assert.equal(mod.getProcessParent(process.pid), null,
          "an unreadable ppid must yield null (fail-closed)");
      } finally {
        if (prevPlatform === undefined) delete process.env.TT_PROCESS_IDENTITY_PLATFORM;
        else process.env.TT_PROCESS_IDENTITY_PLATFORM = prevPlatform;
        if (prevPs === undefined) delete process.env.TT_PROCESS_IDENTITY_PS;
        else process.env.TT_PROCESS_IDENTITY_PS = prevPs;
      }
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("getProcessCwd/getProcessCmdline on the darwin seam read lsof/ps; getProcessStartIdentity stays mechanical (function-level)", async () => {
    const mod: any = await import(pathToFileURL(identityTool).href);
    const childPid = spawnDetached();
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcha-ps-"));
    const psShim = path.join(shimDir, "ps");
    const lsofShim = path.join(shimDir, "lsof");
    fs.writeFileSync(psShim, `#!/bin/sh\nfor arg in "$@"; do case "$arg" in command=*) printf '%s\\n' "node /tt/tt-harness-run-mcha 42"; exit 0;; lstart=*) printf '%s\\n' "Fri Sep  4 11:00:00 2026"; exit 0;; esac; done\nexit 1\n`);
    fs.writeFileSync(lsofShim, `#!/bin/sh\nprintf 'p%s\\nn%s\\n' "$$" "/tt/var/work"\n`);
    fs.chmodSync(psShim, 0o755);
    fs.chmodSync(lsofShim, 0o755);
    try {
      const prevPlatform = process.env.TT_PROCESS_IDENTITY_PLATFORM;
      const prevPs = process.env.TT_PROCESS_IDENTITY_PS;
      const prevLsof = process.env.TT_PROCESS_IDENTITY_LSOF;
      process.env.TT_PROCESS_IDENTITY_PLATFORM = "darwin";
      process.env.TT_PROCESS_IDENTITY_PS = psShim;
      process.env.TT_PROCESS_IDENTITY_LSOF = lsofShim;
      try {
        assert.equal(mod.getProcessCwd(childPid), "/tt/var/work",
          "getProcessCwd must parse the lsof `n<path>` row on darwin");
        assert.equal(mod.getProcessCmdline(childPid), "node /tt/tt-harness-run-mcha 42",
          "getProcessCmdline must read `ps -o command=` on darwin");
        assert.equal(mod.getProcessStartIdentity(childPid), "darwin:Fri Sep  4 11:00:00 2026",
          "the start identity must stay the mechanical darwin:<lstart> source");
      } finally {
        if (prevPlatform === undefined) delete process.env.TT_PROCESS_IDENTITY_PLATFORM;
        else process.env.TT_PROCESS_IDENTITY_PLATFORM = prevPlatform;
        if (prevPs === undefined) delete process.env.TT_PROCESS_IDENTITY_PS;
        else process.env.TT_PROCESS_IDENTITY_PS = prevPs;
        if (prevLsof === undefined) delete process.env.TT_PROCESS_IDENTITY_LSOF;
        else process.env.TT_PROCESS_IDENTITY_LSOF = prevLsof;
      }
    } finally {
      killPid(childPid);
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  // ── 4. whole-tool behavioral arms under the darwin sim ───────────────
  // Real ps/lsof on this host are the mechanical darwin evidence; the seam
  // forces the portable arms (a /proc-less host would take the same branch).
  it("GREEN: kill-daemon fires on a disjoint TT daemon under the darwin sim (exit 0, daemon dies)", async () => {
    const dir = fakeTtVar("run-mcha-kd-green");
    const daemonPid = spawnDetached(); // own session/group — disjoint from the caller
    const exitedPromise = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      // Reap: a SIGKILLed detached child cannot be 'exit'-listened to here
      // (we only kept its pid) — poll liveness instead.
      const iv = setInterval(() => {
        try {
          process.kill(daemonPid, 0);
        } catch {
          clearInterval(iv);
          clearTimeout(t);
          resolve(true);
        }
      }, 50);
    });
    try {
      fs.writeFileSync(path.join(dir, "tamandua.pid"), `${daemonPid}\n`);
      const res = run([ttChaos, "kill-daemon", "--run", "run-mcha-kd-green", "--when", "now"], {
        env: killEnv(dir),
      });
      assert.equal(res.status, 0, `kill-daemon must fire on the darwin sim, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`SIGKILL sent to daemon PID ${daemonPid} \\(run run-mcha-kd-green\\)`),
        `kill-daemon must name the fired PID: ${res.stderr}`);
      assert.equal(await exitedPromise, true, "the daemon-like target must die (the injection fired)");
    } finally {
      killPid(daemonPid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED: kill-daemon refuses a same-group pid under the darwin sim (exit 3 GUARD_MISS, same disjointness guarantee)", () => {
    const dir = fakeTtVar("run-mcha-kd-same");
    const foreign = spawnSameGroup(); // shares the caller's group
    try {
      fs.writeFileSync(path.join(dir, "tamandua.pid"), `${foreign}\n`);
      const res = run([ttChaos, "kill-daemon", "--run", "run-mcha-kd-same", "--when", "now"], {
        env: killEnv(dir),
      });
      assert.equal(res.status, 3, `a same-group pid must refuse on the darwin sim, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, /GUARD_MISS: target pid \d+ shares the caller's own pgid \d+ — refusing to signal own group/,
        `the darwin-arm group gate must refuse: ${res.stderr}`);
      process.kill(foreign, 0); // the target must survive — no signal fired
    } finally {
      killPid(foreign);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GREEN: kill-harness fires on a TT-owned harness under the darwin sim with the explicit recorded target (exit 0, harness dies)", async () => {
    const dir = fakeTtVar("run-mcha-kh-green");
    const varDir = dir; // TT_ROOT
    // TT-owned harness: detached child whose cwd is under TT_ROOT and whose
    // argv[0] is the TT harness shape (`<TT_ROOT>/tt-harness-<run>` — the
    // fake/test harness argv the strict provenance check accepts), so the
    // portable provenance/ownership gates accept it — the exact corridor
    // the mac kill-harness cells need.
    const harnessPid = spawnDetached({
      cwd: varDir,
      argv0: path.join(varDir, "tt-harness-run-mcha-kh-green"),
    });
    const exitedPromise = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      const iv = setInterval(() => {
        try {
          process.kill(harnessPid, 0);
        } catch {
          clearInterval(iv);
          clearTimeout(t);
          resolve(true);
        }
      }, 50);
    });
    try {
      const pgid = realPgidOf(harnessPid);
      assert.equal(pgid, harnessPid, "a detached harness leads its own group");
      const identity = darwinIdentityOf(harnessPid);
      assert.match(identity, /^darwin:/, `the recorded identity must be darwin:<lstart>, got: ${identity}`);
      const res = run([
        ttChaos, "kill-harness", "--run", "run-mcha-kh-green", "--when", "now",
        "--target-pid", String(harnessPid),
        "--target-pgid", String(pgid),
        "--target-start-time", identity,
      ], { env: killEnv(dir) });
      assert.equal(res.status, 0, `kill-harness must fire on the darwin sim, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, new RegExp(`SIGKILL sent to harness PID ${harnessPid} \\(run run-mcha-kh-green\\)`),
        `kill-harness must name the fired PID: ${res.stderr}`);
      // The verification detail must show the group/provenance gates passed
      // (never a silent accept).
      assert.match(res.stderr, /verified \(alive, identity, group/,
        `the fired harness must carry the guard verdict: ${res.stderr}`);
      assert.equal(await exitedPromise, true, "the harness target must die (the injection fired)");
    } finally {
      killPid(harnessPid);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAIL-CLOSED: kill-harness refuses a foreign outside-TT target under the darwin sim (exit 3, strict provenance retained)", () => {
    const dir = fakeTtVar("run-mcha-kh-foreign");
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "mcha-outside-"));
    const foreignPid = spawnDetached({ cwd: outside }); // cwd outside TT_ROOT
    try {
      const res = run([
        ttChaos, "kill-harness", "--run", "run-mcha-kh-foreign", "--when", "now",
        "--target-pid", String(foreignPid),
      ], { env: killEnv(dir) });
      assert.equal(res.status, 3, `an outside-TT harness must still GUARD_MISS on the darwin sim, got ${res.status}: ${res.stderr}`);
      assert.match(res.stderr, /GUARD_MISS: Process \d+ cwd\/cmdline does not contain .+/,
        `the darwin-arm provenance gate must refuse foreign targets: ${res.stderr}`);
      process.kill(foreignPid, 0); // the target must survive — no signal fired
    } finally {
      killPid(foreignPid);
      fs.rmSync(outside, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
