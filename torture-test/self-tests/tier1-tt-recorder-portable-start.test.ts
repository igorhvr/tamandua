// MACP5 US-004 (story US-004) — tt-recorder portable start + GNU-ism sweep.
//
// Darwin defect: `tt-recorder start` detached the record loop with GNU
// `setsid`, canonicalized its own path with GNU `readlink -f`, read file
// sizes with GNU `stat -c%s`, and verified pidfile liveness/cmdline ONLY via
// /proc — all of which fail on macOS (no setsid, BSD readlink has no -f, BSD
// stat rejects -c, and /proc is absent). The fix makes start/stop/status
// portable: a nohup detached spawn (pid captured from $!), `cd`+`pwd -P`
// canonicalization, a BSD-`stat -f%z`+`wc -c` file_size helper, and
// `kill -0` + `ps -p <pid> -o command=` process checks with the guarded
// linux /proc arms preserved.
//
// Hermetic red-then-green guard (no campaign, zero tokens, no 33xx daemon):
//   1. CODE-LINE PINS: the tool contains no `setsid`, no `readlink -f`, and
//      no `stat -c`/`stat --format` on comment- and single-quote-masked code
//      lines (same maskLine as the GNU-ism lint).
//   2. STRUCTURAL PINS: cmd_start detaches via nohup + $! (not setsid),
//      self_script reuses SCRIPT_DIR; the portable helpers _pid_alive /
//      _pid_cmdline / file_size / canonicalize_path exist and use the
//      portable primitives.
//   3. BEHAVIORAL GREEN: with a `setsid`+`timeout` shim on PATH (both exit
//      127 like absent GNU coreutils), `start --interval 30` exits 0, writes
//      a pidfile whose recorded PID is alive via kill -0 and whose ps
//      cmdline contains tt-recorder; a short-interval start→status→stop
//      cycle proves status/stop stay evidence-based and stop is clean.
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

/** Comment- and single-quote-aware line masking (the GNU-ism lint's
 *  convention): comment tails and single-quoted spans are blanked, so only
 *  real code (double-quoted content included) is scanned. */
function maskLine(line: string): string {
  const out: string[] = new Array<string>(line.length).fill("");
  let inSingle = false;
  let inDouble = false;
  let prev = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      out[i] = " ";
      if (ch === "'") inSingle = false;
      prev = ch;
      continue;
    }
    if (inDouble) {
      out[i] = ch;
      if (ch === "\\") {
        if (i + 1 < line.length) {
          out[i + 1] = line[i + 1];
          i++;
        }
      } else if (ch === '"') {
        inDouble = false;
      }
      prev = ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out[i] = " ";
      prev = ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out[i] = ch;
      prev = ch;
      continue;
    }
    if (ch === "#" && (prev === "" || /\s/.test(prev) || /[;|&(){}]/.test(prev))) {
      for (let j = i; j < line.length; j++) out[j] = " ";
      break;
    }
    out[i] = ch;
    prev = ch;
  }
  return out.join("");
}

/** Return every masked code line (preserving line numbers for diagnostics). */
function maskedCodeLines(text: string): Array<{ no: number; line: string }> {
  return text.split(/\r?\n/).map((line, i) => ({ no: i + 1, line: maskLine(line) }));
}

/** Copy the repo tt-recorder into a hermetic temp fixture at
 *  <root>/torture-test/bin/tt-recorder (so its computed TT_ROOT lands under
 *  the temp root, not the real repo). Returns the temp root + tool path. */
function makeToolFixture(): { root: string; tool: string; varDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-recorder-portable-"));
  const binDir = path.join(root, "torture-test", "bin");
  const varDir = path.join(root, "torture-test", "var");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(varDir, { recursive: true });
  const tool = path.join(binDir, "tt-recorder");
  fs.writeFileSync(tool, recorderText, { mode: 0o755 });
  return { root, tool, varDir };
}

/** A PATH shim dir whose `setsid` and `timeout` entries exit 127 (the
 *  command-not-found behavior for the absent GNU coreutils on macOS). */
function makeGnuShimPath(): { dir: string; path: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-recorder-gnu-shim-"));
  for (const name of ["setsid", "timeout"]) {
    fs.writeFileSync(
      path.join(dir, name),
      `#!/bin/sh\necho "${name}: command not found" >&2\nexit 127\n`,
      { mode: 0o755 },
    );
  }
  return { dir, path: `${dir}:${process.env.PATH ?? ""}` };
}

function pidIsAlive(pid: string): boolean {
  const res = run(["kill", "-0", pid], { timeoutMs: 5_000 });
  return res.status === 0;
}

function psCommand(pid: string): string {
  const res = run(["ps", "-p", pid, "-o", "command="], { timeoutMs: 5_000 });
  return res.stdout.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

describe("MACP5 US-004 (story US-004) — tt-recorder portable start + GNU-ism sweep", () => {
  it("code-line pins: no setsid, no readlink -f, no stat -c/--format on masked code lines", () => {
    const bad = maskedCodeLines(recorderText)
      .filter(({ line }) => /\bsetsid\b/.test(line) || /\breadlink\s+--canonicalize\b/.test(line) ||
        /\breadlink\s+-[a-zA-Z]*f[a-zA-Z]*\b/.test(line) ||
        /\bstat\s+--format\b/.test(line) || /\bstat\s+-[a-zA-Z]*c[a-zA-Z]*\b/.test(line))
      .map(({ no, line }) => `${no}: ${line.trim()}`);
    assert.deepEqual(
      bad,
      [],
      `tt-recorder must be free of setsid/readlink -f/stat -c on code lines:\n${bad.join("\n")}`,
    );
  });

  it("cmd_start detaches portably: nohup + $! and SCRIPT_DIR self-path (structural)", () => {
    const cmdStart = extractFunction(recorderText, "cmd_start");
    assert.ok(cmdStart, "cmd_start must exist");
    const maskedStart = cmdStart.split(/\r?\n/).map(maskLine).join("\n");
    assert.doesNotMatch(maskedStart, /\bsetsid\b/, "cmd_start must not use GNU setsid (comments may mention it)");
    assert.match(
      cmdStart,
      /nohup \/bin\/bash -c/,
      "cmd_start must detach with nohup /bin/bash (portable, no setsid)",
    );
    assert.match(
      cmdStart,
      /<\/dev\/null >\/dev\/null 2>&1 &/,
      "cmd_start must redirect stdin/stdout/stderr away before backgrounding",
    );
    assert.match(cmdStart, /local bg_pid=\$!/, "cmd_start must capture the detached pid from $!");
    assert.match(
      cmdStart,
      /self_script="\$SCRIPT_DIR\/\$\(basename "\$\{BASH_SOURCE\[0\]\}"\)"/,
      "cmd_start must reuse the already-computed SCRIPT_DIR (cd+pwd) instead of readlink -f",
    );
    assert.match(cmdStart, /if _pid_alive "\$existing_pid"; then/, "cmd_start must use the portable _pid_alive pidfile check");
    assert.match(cmdStart, /ex_cmdline="\$\(_pid_cmdline "\$existing_pid"\)"/, "cmd_start must use the portable _pid_cmdline verification");
  });

  it("portable helpers exist and use kill -0 / ps / stat -f%z / pwd -P (structural)", () => {
    const alive = extractFunction(recorderText, "_pid_alive");
    assert.ok(alive, "_pid_alive must exist");
    assert.match(alive, /kill -0 "\$pid"/, "_pid_alive must use the portable kill -0 liveness probe");

    const cmdline = extractFunction(recorderText, "_pid_cmdline");
    assert.ok(cmdline, "_pid_cmdline must exist");
    assert.match(cmdline, /\[ -r "\/proc\/\$pid\/cmdline" \]/, "_pid_cmdline must guard its linux /proc read");
    assert.match(cmdline, /ps -p "\$pid" -o command=/, "_pid_cmdline must fall back to ps -o command= on darwin");

    const size = extractFunction(recorderText, "file_size");
    assert.ok(size, "file_size must exist");
    assert.match(size, /stat -f%z/, "file_size must use BSD stat -f%z (macOS)");
    assert.match(size, /wc -c < "\$file"/, "file_size must have the universal wc -c fallback");
    assert.doesNotMatch(size, /stat\s+-[a-zA-Z]*c[a-zA-Z]*\b/, "file_size must not carry GNU stat -c");
    assert.doesNotMatch(size, /stat\s+--format/, "file_size must not carry GNU stat --format");

    const canon = extractFunction(recorderText, "canonicalize_path");
    assert.ok(canon, "canonicalize_path must exist");
    assert.match(canon, /pwd -P/, "canonicalize_path must canonicalize via cd + pwd -P (no readlink -f)");
  });

  it("start --interval 30 exits 0 under a setsid/timeout shim and writes a live pidfile (behavioral)", async () => {
    const fixture = makeToolFixture();
    const shim = makeGnuShimPath();
    try {
      const out = run(["bash", fixture.tool, "start", "--interval", "30"], {
        env: cleanEnv({ PATH: shim.path }),
        timeoutMs: 20_000,
      });
      assert.equal(out.status, 0, `start failed (rc=${out.status}): ${out.stderr}`);
      assert.match(out.stdout, /interval=30s/, `start must echo interval=30s. stdout: ${out.stdout}`);

      const pidfile = path.join(fixture.varDir, "recorder", "tt-recorder.pid");
      assert.ok(fs.existsSync(pidfile), `pidfile must be written at ${pidfile}`);
      const pid = fs.readFileSync(pidfile, "utf8").trim();
      assert.match(pid, /^[0-9]+$/, `pidfile must contain a positive integer, got: ${JSON.stringify(pid)}`);

      await sleep(300); // let the detached loop fork its sleep child
      assert.ok(pidIsAlive(pid), `recorded pid ${pid} must be alive via kill -0`);
      assert.match(
        psCommand(pid),
        /tt-recorder/,
        `recorded pid ${pid} must be a tt-recorder process via ps -o command=`,
      );

      killTree(pid);
    } finally {
      const pidfile = path.join(fixture.varDir, "recorder", "tt-recorder.pid");
      if (fs.existsSync(pidfile)) {
        const leftover = fs.readFileSync(pidfile, "utf8").trim();
        if (/^[0-9]+$/.test(leftover)) killTree(leftover);
      }
      fs.rmSync(shim.dir, { recursive: true, force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("start→status→stop stays evidence-based and stop is clean (behavioral)", async () => {
    const fixture = makeToolFixture();
    const shim = makeGnuShimPath();
    try {
      // Short interval keeps the SIGTERM graceful-shutdown window (the loop
      // sleeps 1s, so the trap fires well within the stop SIGTERM wait).
      const startOut = run(["bash", fixture.tool, "start", "--interval", "1"], {
        env: cleanEnv({ PATH: shim.path }),
        timeoutMs: 20_000,
      });
      assert.equal(startOut.status, 0, `start failed: ${startOut.stderr}`);
      const pidfile = path.join(fixture.varDir, "recorder", "tt-recorder.pid");
      const pid = fs.readFileSync(pidfile, "utf8").trim();
      await sleep(300);

      const statusOut = run(["bash", fixture.tool, "status"], {
        env: cleanEnv({ PATH: shim.path }),
        timeoutMs: 20_000,
      });
      assert.equal(statusOut.status, 0, `status failed: ${statusOut.stderr}`);
      assert.match(statusOut.stdout, /tt-recorder is RUNNING/, `status must report RUNNING. stdout: ${statusOut.stdout}`);
      assert.match(statusOut.stdout, new RegExp(`PID: ${pid}`), `status must report the recorded pid ${pid}`);

      const stopOut = run(["bash", fixture.tool, "stop"], {
        env: cleanEnv({ PATH: shim.path }),
        timeoutMs: 30_000,
      });
      assert.equal(stopOut.status, 0, `stop failed: ${stopOut.stderr}`);
      assert.match(stopOut.stdout, /tt-recorder stopped/, `stop must report stopped. stdout: ${stopOut.stdout}`);
      assert.ok(!fs.existsSync(pidfile), "stop must remove the pidfile");
      assert.ok(!pidIsAlive(pid), `recorded pid ${pid} must be dead after stop`);

      const afterStop = run(["bash", fixture.tool, "status"], {
        env: cleanEnv({ PATH: shim.path }),
        timeoutMs: 20_000,
      });
      assert.match(afterStop.stdout, /tt-recorder is NOT RUNNING/, `status after stop must report NOT RUNNING. stdout: ${afterStop.stdout}`);
    } finally {
      const pidfile = path.join(fixture.varDir, "recorder", "tt-recorder.pid");
      if (fs.existsSync(pidfile)) {
        const leftover = fs.readFileSync(pidfile, "utf8").trim();
        if (/^[0-9]+$/.test(leftover)) killTree(leftover);
      }
      fs.rmSync(shim.dir, { recursive: true, force: true });
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
