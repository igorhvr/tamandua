// MACP5 US-005 (story US-005) — tt-recorder darwin port/fd evidence.
//
// Darwin defect: `_is_production_ports` in torture-test/bin/tt-recorder
// proved a process listened on production ports 3334/3338/3339 ONLY via the
// linux /proc socket-inode arm (/proc/net/tcp + /proc/<pid>/fd symlinks). On
// macOS there is no /proc, so that arm could never produce evidence and the
// function could only ever answer "not production" (a harmless-but-useless
// degradation). The fix adds a darwin arm: when /proc is absent, fall back to
// `lsof -nP -iTCP -sTCP:LISTEN` and match the pid + ports directly; when lsof
// is unavailable or yields no usable evidence, print ONE explicit stderr line
// and return 1 (not production) without ever failing the start path. The
// linux /proc inode-matching arm is preserved unchanged.
//
// Hermetic red-then-green guard (no campaign, zero tokens, no 33xx daemon):
//   1. STRUCTURAL: the function carries the lsof arm (numeric LISTEN query +
//      pid/port matching), the explicit degradation line, and the unchanged
//      linux /proc arm; the file keeps its MACP3 US-003 procfs-lint marker.
//   2. LSOF-DETECTED: a fake `lsof` shim whose LISTEN table proves a
//      production listener (pid + port 3334) makes `_is_production_ports`
//      return 0.
//   3. DEGRADATION: with `lsof` genuinely absent from PATH, the function logs
//      the explicit "port evidence unavailable on this platform" line and
//      returns 1 — and `tt-recorder start` still exits 0 (never fails because
//      of a missing /proc or lsof).
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (no run.sh edit).
// Zero tokens; confined to torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const repoRecorder = path.join(ttRoot, "bin", "tt-recorder");
const recorderText = fs.readFileSync(repoRecorder, "utf8");

// ── helpers ────────────────────────────────────────────────────────────

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the recorder children operate on a temp HOME-free fixture. */
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
    timeout: opts.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

/** Extract a top-level `name() { ... }` function body (balanced-brace,
 *  quote-aware) from the tool text, or null when the function is absent. */
function extractFunction(text: string, name: string): string | null {
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

/** The real PATH with every directory that contains an `lsof` binary removed.
 *  This makes `lsof` genuinely absent for the sourcing child while leaving
 *  bash/awk/ps and the other tools the recorder needs intact. */
function pathWithoutLsof(): string {
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const filtered = entries.filter((dir) => {
    try {
      return !fs.existsSync(path.join(dir, "lsof"));
    } catch {
      return true;
    }
  });
  assert.ok(
    filtered.length > 0,
    "expected a non-empty PATH after removing lsof-bearing directories",
  );
  return filtered.join(path.delimiter);
}

/** A PATH shim dir whose `lsof` prints a fixed numeric LISTEN table proving
 *  the requested pid listens on production port 3334. */
function makeFakeLsofShim(pid: string): { dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-recorder-lsof-shim-"));
  const lsof = [
    "#!/bin/sh",
    'echo "COMMAND   PID   USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME"',
    `echo "node  ${pid}  tester 22u  IPv4 0xdeadbeef      0t0  TCP 127.0.0.1:3334 (LISTEN)"`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(dir, "lsof"), lsof, { mode: 0o755 });
  return { dir, path: `${dir}:${process.env.PATH ?? ""}` };
}

/** Source the repo tt-recorder and invoke `_is_production_ports <pid>` in a
 *  fresh bash. The `$0` sentinel differs from BASH_SOURCE so the tool's
 *  `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` guard does not run main(). The
 *  sourced tool's `set -e` makes the function's return code the process exit
 *  code (0 = production, 1 = not production). */
function callProductionPorts(pid: string, env?: NodeJS.ProcessEnv): CmdResult {
  return run(
    ["bash", "-c", 'source "$1"; _is_production_ports "$2"', "tt-recorder-evidence", repoRecorder, pid],
    { env: env ?? cleanEnv(), timeoutMs: 20_000 },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Copy the repo tt-recorder into a hermetic temp fixture at
 *  <root>/torture-test/bin/tt-recorder (so its computed TT_ROOT lands under
 *  the temp root, not the real repo). Returns the temp root + tool path. */
function makeToolFixture(): { root: string; tool: string; varDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-recorder-evidence-"));
  const binDir = path.join(root, "torture-test", "bin");
  const varDir = path.join(root, "torture-test", "var");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(varDir, { recursive: true });
  const tool = path.join(binDir, "tt-recorder");
  fs.writeFileSync(tool, recorderText, { mode: 0o755 });
  return { root, tool, varDir };
}

/** Kill a pid and its direct children (the detached loop's `sleep` child),
 *  found via `ps -o pid=,ppid=` — avoids leaving a long-interval orphan. */
function killTree(pid: string): void {
  const ps = run(["ps", "-o", "pid=,ppid=", "-ax"], { timeoutMs: 10_000 });
  const childPids: string[] = [];
  for (const line of ps.stdout.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 2 && cols[1] === pid) childPids.push(cols[0]);
  }
  for (const c of childPids) {
    try {
      process.kill(Number(c), "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  try {
    process.kill(Number(pid), "SIGKILL");
  } catch {
    /* already gone */
  }
}

// ── the guard ──────────────────────────────────────────────────────────

describe("MACP5 US-005 (story US-005) — tt-recorder darwin port/fd evidence", () => {
  it("structural: _is_production_ports has the lsof arm, degradation line, and the unchanged /proc arm", () => {
    const fn = extractFunction(recorderText, "_is_production_ports");
    assert.ok(fn, "_is_production_ports must exist");

    // darwin lsof arm: numeric LISTEN query + pid/port matching.
    assert.match(fn, /lsof -nP -iTCP -sTCP:LISTEN/, "the darwin arm must query lsof's numeric LISTEN table");
    assert.match(fn, /-v pid="\$pid"/, "the lsof arm must match on the pid column");
    assert.match(fn, /3334\|3338\|3339/, "the lsof arm must match production ports 3334/3338/3339");
    assert.match(fn, /2>\/dev\/null \|\| true/, "the lsof query must be bounded and never hard-fail on absence");

    // explicit logged degradation.
    assert.match(
      fn,
      /tt-recorder: port evidence unavailable on this platform \(lsof missing or no matches\)/,
      "the darwin arm must log the explicit degradation line",
    );

    // linux /proc inode-matching arm preserved unchanged.
    assert.match(fn, /\/proc\/net\/tcp/, "the linux /proc arm must be preserved");
    assert.match(fn, /\/proc\/net\/tcp6/, "the linux tcp6 arm must be preserved");
    assert.match(fn, /socket:\*/, "the linux socket-inode matching must be preserved");

    // the procfs-lint allowlist marker stays valid (every /proc read guarded).
    assert.match(recorderText, /MACP3 US-003/, "the procfs-lint MACP3 US-003 marker must remain");
  });

  it("fake lsof output proving a production listener makes _is_production_ports return 0", () => {
    const pid = "987654321"; // a pid with no /proc entry on linux; absent /proc on darwin
    const shim = makeFakeLsofShim(pid);
    try {
      const res = callProductionPorts(pid, cleanEnv({ PATH: shim.path }));
      assert.equal(res.status, 0, `lsof-detected production listener must return 0. stderr: ${res.stderr}`);
    } finally {
      fs.rmSync(shim.dir, { recursive: true, force: true });
    }
  });

  it("missing lsof logs the explicit degradation line and returns 1 (not production)", () => {
    const pid = "987654321";
    const env = cleanEnv({ PATH: pathWithoutLsof() });
    const res = callProductionPorts(pid, env);
    assert.equal(res.status, 1, `missing lsof must make _is_production_ports return 1 (not production). rc=${res.status}`);
    assert.match(
      res.stderr,
      /tt-recorder: port evidence unavailable on this platform \(lsof missing or no matches\)/,
      `the degradation line must be printed to stderr. stderr: ${res.stderr}`,
    );
  });

  it("tt-recorder start exits 0 with lsof absent (never fails because of missing /proc or lsof)", async () => {
    const fixture = makeToolFixture();
    const env = cleanEnv({ PATH: pathWithoutLsof() });
    try {
      const out = run(["bash", fixture.tool, "start", "--interval", "30"], {
        env,
        timeoutMs: 20_000,
      });
      assert.equal(out.status, 0, `start must exit 0 with lsof absent. stderr: ${out.stderr}`);
      assert.match(out.stdout, /interval=30s/, `start must echo interval=30s. stdout: ${out.stdout}`);

      const pidfile = path.join(fixture.varDir, "recorder", "tt-recorder.pid");
      assert.ok(fs.existsSync(pidfile), `pidfile must be written at ${pidfile}`);
      const pid = fs.readFileSync(pidfile, "utf8").trim();
      assert.match(pid, /^[0-9]+$/, `pidfile must contain a positive integer, got: ${JSON.stringify(pid)}`);

      await sleep(300); // let the detached loop fork its sleep child
      killTree(pid);
    } finally {
      const pidfile = path.join(fixture.varDir, "recorder", "tt-recorder.pid");
      if (fs.existsSync(pidfile)) {
        const leftover = fs.readFileSync(pidfile, "utf8").trim();
        if (/^[0-9]+$/.test(leftover)) killTree(leftover);
      }
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
