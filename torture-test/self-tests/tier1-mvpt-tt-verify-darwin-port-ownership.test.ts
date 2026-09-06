// MVPT (US-015) — tt-verify-environment's port-ownership gate must identify
// TT-owned listeners on darwin (portable evidence) and name a listener owned
// by ANOTHER worktree of the same repo instead of reporting 'in use by
// non-TT process'.
//
// Defect (mac stage-2 attempt-2, 2026-09-02): tt-verify-environment's
// isProcessTTOwned read the procfs mount only (`/<pid>/cmdline` +
// `/<pid>/cwd` reads), and its /proc-less (darwin) branch returned 'not
// TT-owned' with NO evidence — so ANY contained daemon on the shared 43xx/
// 53xx ports failed the REQUIRED env-gate port check with 'in use by non-TT
// process', even when the listener was the main checkout's own daemon (its
// provenance recorded) or another worktree of the same repo.
//
// Fix (confined to torture-test/):
//   1. The ownership evidence reader dispatches on the TT_VERIFY_PLATFORM
//      seam (MACP3 injectable-platform pattern): linux (real or seam) reads
//      the procfs cwd + cmdline (unchanged); darwin (real or seam) uses the
//      PORTABLE evidence daemon-control's ownership check uses — `lsof -a -p
//      <pid> -d cwd -Fn` for the cwd and `ps -p <pid> -o command=` for the
//      command line. Unavailable evidence stays fail-closed (not TT-owned),
//      exactly like the linux arm.
//   2. The gate classifies a listener three ways: THIS worktree's TT tree
//      (unchanged PASS 'in use by TT-owned process'), ANOTHER checkout of
//      the same repo carrying a TT daemon marker (cwd under <X>/torture-test
//      + cmdline naming <X>'s dist daemon entry or a tamandua CLI) — reported
//      'TT-owned by <worktree path>, run <id>' and PASSed as in-use-by-TT —
//      and FOREIGN (unchanged FAIL 'in use by non-TT process').
//
// RED case (recorded in the progress log): against the PRE-fix tool the same
// listener (an other-worktree daemon-shaped child) is classified non-TT and
// the REQUIRED TT-port check FAILs. Reproduce:
//
//   TMPD=$(mktemp -d)
//   mkdir -p "$TMPD/torture-test/bin"
//   git show HEAD:torture-test/bin/tt-verify-environment \
//     > "$TMPD/torture-test/bin/tt-verify-environment" && chmod +x "$TMPD/torture-test/bin/tt-verify-environment"
//   TT_MVPT_TOOL="$TMPD/torture-test/bin/tt-verify-environment" node --test \
//     torture-test/self-tests/tier1-mvpt-tt-verify-darwin-port-ownership.test.ts
//
// Hermetic (linux-runnable, zero tokens, no product daemon, no operator
// state): every arm copies the tool under test (TT_MVPT_TOOL seam, default
// the working-tree tool) into a scratch torture-test layout so TT_ROOT
// derives from the SCRATCH location; the "another worktree of the same repo"
// listener is this test's OWN node child (real net listener on one shared
// TT port, real cwd/cmdline evidence — the procfs arm reads the child's real
// linux procfs rows, the darwin seam arm reads real `lsof`/`ps` output on the
// same child). The battery preflight-skips when any shared TT port is busy
// (the documented quiet-host class — never kill another run's pids). Nothing
// is written under torture-test/.
//
// Every '/proc' occurrence in THIS file is linux-only documentation/assertion
// prose (MACP3 US-004 convention) — the runtime procfs reads live inside the
// guarded tool under test.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded battery —
// no run.sh edit).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const repoVerifyTool = path.join(ttRoot, "bin", "tt-verify-environment");

// Scratch staging root. The staged tool's disk-headroom REQUIRED check probes
// df on its own var/ dir (threshold 60 GB), so the scratch MUST live on the
// repo's big filesystem — os.tmpdir() (/tmp is often a small tmpfs) would
// fail the gate before the port row is even read. torture-test/var is
// gitignored generated state; every scratch is removed in its arm's finally.
const scratchRoot = path.join(ttRoot, "var", "mvpt-scratch");

// TT_MVPT_TOOL points the whole-tool arms at an alternate tt-verify-
// environment (used to demonstrate the RED case against the pre-fix tool —
// see the header repro). Default: the working-tree tool.
const verifyTool = process.env.TT_MVPT_TOOL ?? repoVerifyTool;
const verifyText = fs.readFileSync(verifyTool, "utf8");

const TT_PORTS = [4334, 4338, 4339, 5334, 5338, 5339];
const RUN_ID_HEX = "6d6d7670"; // the run-id segment planted in the sibling worktree dir name

// ── helpers ────────────────────────────────────────────────────────────

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the tool under test and its children operate inside scratch
 *  dirs and loopback ports only. */
function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
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
    timeout: opts.timeoutMs ?? 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function portListening(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid: number): void {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Copy the selected tool into `<scratch>/torture-test/bin/tt-verify-environment`
 *  so TT_ROOT derives from the scratch location (never the real repo). */
function stageTool(scratch: string): string {
  const binDir = path.join(scratch, "torture-test", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const staged = path.join(binDir, "tt-verify-environment");
  fs.copyFileSync(verifyTool, staged);
  fs.chmodSync(staged, 0o755);
  return staged;
}

// NOTE: the scratch tree lives under the repo (whose root package.json is
// "type":"module"), so a .js listener FILE must be ESM; the `node -e` inline
// variant defaults to CommonJS. Two sources, same behavior.
const LISTEN_SRC_ESM = (port: number): string =>
  `import net from 'node:net';const s=net.createServer();` +
  `s.on('error',()=>process.exit(2));` +
  `s.listen(${port},'127.0.0.1',()=>{});setInterval(()=>{},1000);`;

const LISTEN_SRC_CJS = (port: number): string =>
  `const net=require('net');const s=net.createServer();` +
  `s.on('error',()=>process.exit(2));` +
  `s.listen(${port},'127.0.0.1',()=>{});setInterval(()=>{},1000);`;

interface VerifyResult {
  status: number | null;
  checks: Array<{ id: string; result: string; evidence: string }>;
  ports: Record<string, string>;
  rawOut: string;
}

/** Run `node <stagedTool> --fast --json` and parse the check row + profile
 *  port status for `port`. */
function runVerifyGate(stagedTool: string, port: number, env: NodeJS.ProcessEnv): VerifyResult {
  const res = run([process.execPath, stagedTool, "--fast", "--json"], { env });
  let parsed: any = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    parsed = null;
  }
  assert.ok(parsed !== null, `tt-verify-environment --json output must parse:\n${res.stdout}\n${res.stderr}`);
  const checks = Array.isArray(parsed.checks) ? parsed.checks : [];
  const row = checks.find((c: any) => c?.id === `port-${port}`);
  assert.ok(row, `port-${port} check must be present:\n${res.stdout}`);
  return {
    status: res.status,
    checks,
    ports: parsed.hostProfile?.ports ?? {},
    rawOut: res.stdout,
  };
}

/** Spawn a real net-listening child whose cwd/cmdline model the listener the
 *  arm wants to classify. Returns { pid, worktreeDir } (worktreeDir null for
 *  foreign/this-worktree shapes). Waits until the port actually listens. */
async function spawnListener(opts: {
  port: number;
  cwd: string;
  argv0Script?: string; // when set: spawn `node <script>` (daemon-entry shape)
}): Promise<{ child: ReturnType<typeof spawn>; pid: number }> {
  const { port, cwd, argv0Script } = opts;
  let child: ReturnType<typeof spawn>;
  if (argv0Script) {
    fs.writeFileSync(argv0Script, LISTEN_SRC_ESM(port), { encoding: "utf8", mode: 0o755 });
    child = spawn(process.execPath, [argv0Script], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: cleanEnv(),
    });
  } else {
    child = spawn(process.execPath, ["-e", LISTEN_SRC_CJS(port)], {
      cwd,
      detached: true,
      stdio: "ignore",
      env: cleanEnv(),
    });
  }
  child.unref();
  const pid = child.pid;
  assert.ok(pid !== undefined && pidAlive(pid), "the listener child must be alive");
  // Wait (bounded) for the listener to actually bind.
  let listening = false;
  for (let i = 0; i < 40; i++) {
    if (await portListening(port)) {
      listening = true;
      break;
    }
    if (!pidAlive(pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(listening, `the listener child (pid ${pid}) must bind port ${port}`);
  return { child, pid };
}

// ── tests ─────────────────────────────────────────────────────────────

describe("MVPT — tt-verify-environment darwin port ownership uses portable evidence", () => {
  // ── 1. structural: the ownership evidence reader + classifier ─────────

  it("the ownership evidence reader dispatches on TT_VERIFY_PLATFORM: lsof cwd + ps command on darwin, procfs cwd+cmdline on linux (structural)", () => {
    // The reader must dispatch on the recorded platform (the MACP3 seam).
    assert.match(
      verifyText,
      /function readProcessEvidence\(pid\)[\s\S]*?detectedPlatform\(\)/,
      "readProcessEvidence must dispatch on detectedPlatform() (TT_VERIFY_PLATFORM seam) — RED pre-fix (function absent)",
    );
    const reader = verifyText.match(/function readProcessEvidence\(pid\)\s*\{([\s\S]*?)\n\}/);
    assert.ok(reader, "readProcessEvidence must be a top-level function");
    const body = reader[1];
    // Darwin arm: daemon-control's portable evidence — lsof cwd (-d cwd -Fn)
    // and ps command line (-o command=).
    assert.match(body, /spawnSync\('lsof'/, "the darwin arm must read the cwd via lsof — RED pre-fix");
    assert.match(body, /-d'\s*,\s*'cwd'|'cwd'/, "the lsof arm must select the cwd descriptor");
    assert.match(body, /'-Fn'/, "the lsof arm must use -Fn (name rows)");
    assert.match(body, /spawnSync\('ps'/, "the darwin arm must read the command line via ps — RED pre-fix");
    assert.match(body, /-o'\s*,\s*'command='/s, "the ps arm must use -o command= (full command line)");
    // Linux arm unchanged: the procfs cwd + cmdline reads are still present.
    assert.match(body, /\/proc\/\$\{pid\}\/cmdline/, "the linux arm must keep the procfs cmdline read (MACP3 US-003 linux-only)");
    assert.match(body, /\/proc\/\$\{pid\}\/cwd/, "the linux arm must keep the procfs cwd read (MACP3 US-003 linux-only)");
    assert.match(body, /MACP3 US-003/, "the linux-only reads must carry the MACP3 US-003 marker");
  });

  it("the port-ownership gate renders the three ownership classes and keeps the foreign refusal (structural)", () => {
    assert.match(
      verifyText,
      /classifyProcessOwnership/,
      "the gate must classify ownership (this worktree / other worktree / foreign) — RED pre-fix (function absent)",
    );
    // AC3: an other-worktree-of-the-same-repo listener is named, never 'non-TT'.
    assert.match(verifyText, /TT-owned by \$\{/s, "the other-worktree evidence must read 'TT-owned by <worktree path>'");
    assert.match(verifyText, /run \$\{ownership\.runId\}|run \$\{runId\}|, run /, "the other-worktree evidence must carry ', run <id>' when derivable");
    // AC4: the pre-existing this-worktree evidence text is preserved.
    assert.match(
      verifyText,
      /in use by TT-owned process/,
      "the this-worktree TT-owned evidence must keep the pre-MVPT wording",
    );
    // Foreign refusal unchanged (fail-closed, never weakened).
    assert.match(verifyText, /in use by non-TT process/, "a foreign listener must still FAIL as 'in use by non-TT process'");
    // Both TT classes record in-use-by-TT in the host profile.
    assert.match(verifyText, /in-use-by-TT/, "TT-owned listeners (any worktree) must record host-profile port status in-use-by-TT");
  });

  // ── 2. whole-tool behavioral arms (real listener children; each arm runs
  //    the staged tool against its OWN child on one shared TT port). ─────

  it("AC1/AC3 darwin seam: a listener owned by another worktree of the same repo is TT-owned (green post-fix; RED pre-fix: 'in use by non-TT process')", async (t) => {
    for (const port of TT_PORTS) {
      if (await portListening(port)) {
        t.skip(`shared TT port ${port} is busy (a concurrent campaign/daemon owns it) — cannot run the MVPT darwin arm`);
        return;
      }
    }
    const port = 5334;
    fs.mkdirSync(scratchRoot, { recursive: true });
    const scratch = fs.mkdtempSync(path.join(scratchRoot, "tt-mvpt-darwin-"));
    let child: ReturnType<typeof spawn> | null = null;
    try {
      // The sibling worktree of the SAME repo: a scratch checkout named with
      // the tamandua run-worktree naming (<num>-<hex> — the run id lives in
      // the directory name, exactly like <catalog>/<num>-<runid> worktrees),
      // holding its own built daemon entry at <X>/dist/server/daemon.js and
      // its own torture-test tree as the daemon cwd.
      const worktreeDir = path.join(scratch, "siblings", `912-${RUN_ID_HEX}`);
      fs.mkdirSync(path.join(worktreeDir, "dist", "server"), { recursive: true });
      fs.mkdirSync(path.join(worktreeDir, "torture-test", "var"), { recursive: true });
      const daemonJs = path.join(worktreeDir, "dist", "server", "daemon.js");

      const listener = await spawnListener({
        port,
        cwd: path.join(worktreeDir, "torture-test", "var"),
        argv0Script: daemonJs,
      });
      child = listener.child;

      const staged = stageTool(scratch);
      const gate = runVerifyGate(staged, port, cleanEnv({ TT_VERIFY_PLATFORM: "darwin" }));

      // Post-fix: the daemon of another worktree of the same repo is TT-owned.
      assert.equal(
        gate.status,
        0,
        `the darwin env gate must PASS when another worktree's daemon holds the TT port (RED pre-fix: exit 1):\n${gate.rawOut}`,
      );
      const row = gate.checks.find((c) => c.id === `port-${port}`);
      assert.equal(row?.result, "PASS", `port-${port} must PASS:\n${gate.rawOut}`);
      assert.match(
        row?.evidence ?? "",
        new RegExp(`TT-owned by ${escapeRegExp(worktreeDir)}, run ${RUN_ID_HEX}`),
        `the evidence must name the owning worktree + run id ('TT-owned by <worktree path>, run <id>'): ${row?.evidence}`,
      );
      assert.equal(gate.ports[String(port)], "in-use-by-TT", "hostProfile.ports must record in-use-by-TT");
    } finally {
      if (child?.pid) killPid(child.pid);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("AC4 linux /proc arm: the same other-worktree listener is TT-owned on linux too (the misclassification was cross-platform)", async (t) => {
    for (const port of TT_PORTS) {
      if (await portListening(port)) {
        t.skip(`shared TT port ${port} is busy — cannot run the MVPT linux other-worktree arm`);
        return;
      }
    }
    const port = 5334;
    fs.mkdirSync(scratchRoot, { recursive: true });
    const scratch = fs.mkdtempSync(path.join(scratchRoot, "tt-mvpt-linux-"));
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const worktreeDir = path.join(scratch, "siblings", `913-${RUN_ID_HEX}`);
      fs.mkdirSync(path.join(worktreeDir, "dist", "server"), { recursive: true });
      fs.mkdirSync(path.join(worktreeDir, "torture-test", "var"), { recursive: true });
      const daemonJs = path.join(worktreeDir, "dist", "server", "daemon.js");

      const listener = await spawnListener({
        port,
        cwd: path.join(worktreeDir, "torture-test", "var"),
        argv0Script: daemonJs,
      });
      child = listener.child;

      const staged = stageTool(scratch);
      // No TT_VERIFY_PLATFORM seam: the REAL linux procfs evidence branch.
      const gate = runVerifyGate(staged, port, cleanEnv());
      assert.equal(
        gate.status,
        0,
        `the linux env gate must PASS for another worktree's daemon (no regression — ADD):\n${gate.rawOut}`,
      );
      const row = gate.checks.find((c) => c.id === `port-${port}`);
      assert.equal(row?.result, "PASS", `port-${port} must PASS:\n${gate.rawOut}`);
      assert.match(
        row?.evidence ?? "",
        new RegExp(`TT-owned by ${escapeRegExp(worktreeDir)}, run ${RUN_ID_HEX}`),
        `the evidence must name the owning worktree + run id on the /proc arm: ${row?.evidence}`,
      );
    } finally {
      if (child?.pid) killPid(child.pid);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("AC4 no-regression: a listener whose cwd lives under THIS worktree's TT tree still reports the pre-MVPT 'TT-owned process' PASS", async (t) => {
    for (const port of TT_PORTS) {
      if (await portListening(port)) {
        t.skip(`shared TT port ${port} is busy — cannot run the MVPT this-worktree arm`);
        return;
      }
    }
    const port = 5334;
    fs.mkdirSync(scratchRoot, { recursive: true });
    const scratch = fs.mkdtempSync(path.join(scratchRoot, "tt-mvpt-here-"));
    let child: ReturnType<typeof spawn> | null = null;
    try {
      // This worktree's own TT tree: the staged tool's TT_ROOT (its scratch
      // torture-test dir) is the cwd of the listener.
      const ttVar = path.join(scratch, "torture-test", "var");
      fs.mkdirSync(ttVar, { recursive: true });
      const listener = await spawnListener({ port, cwd: ttVar });
      child = listener.child;

      const staged = stageTool(scratch);
      const gate = runVerifyGate(staged, port, cleanEnv());
      assert.equal(gate.status, 0, `this-worktree TT-owned port must PASS:\n${gate.rawOut}`);
      const row = gate.checks.find((c) => c.id === `port-${port}`);
      assert.equal(row?.result, "PASS", `port-${port} must PASS:\n${gate.rawOut}`);
      assert.match(
        row?.evidence ?? "",
        /in use by TT-owned process/,
        "the this-worktree evidence must keep the pre-MVPT wording (no regression on the /proc arm)",
      );
      assert.equal(gate.ports[String(port)], "in-use-by-TT", "hostProfile.ports must record in-use-by-TT");
    } finally {
      if (child?.pid) killPid(child.pid);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("AC4 no-regression: a FOREIGN listener (no TT markers anywhere) still FAILs 'in use by non-TT process'", async (t) => {
    for (const port of TT_PORTS) {
      if (await portListening(port)) {
        t.skip(`shared TT port ${port} is busy — cannot run the MVPT foreign arm`);
        return;
      }
    }
    const port = 5334;
    fs.mkdirSync(scratchRoot, { recursive: true });
    const scratch = fs.mkdtempSync(path.join(scratchRoot, "tt-mvpt-foreign-"));
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const foreignCwd = path.join(scratch, "plain-cwd");
      fs.mkdirSync(foreignCwd, { recursive: true });
      const listener = await spawnListener({ port, cwd: foreignCwd });
      child = listener.child;

      const staged = stageTool(scratch);
      const gate = runVerifyGate(staged, port, cleanEnv());
      assert.notEqual(
        gate.status,
        0,
        `a foreign listener must fail the REQUIRED TT-port gate (exit non-zero):\n${gate.rawOut}`,
      );
      const row = gate.checks.find((c) => c.id === `port-${port}`);
      assert.equal(row?.result, "FAIL", `port-${port} must FAIL for a foreign listener:\n${gate.rawOut}`);
      assert.match(
        row?.evidence ?? "",
        /in use by non-TT process/,
        "a foreign listener must keep the exact pre-MVPT refusal wording (fail-closed unchanged)",
      );
      assert.equal(gate.ports[String(port)], "in-use-by-other", "hostProfile.ports must record in-use-by-other");
    } finally {
      if (child?.pid) killPid(child.pid);
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
