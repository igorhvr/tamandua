// LSOF-EVTA US-006 — bin/daemon-control's shell lsof probes are BOUNDED.
//
// Darwin/DEFECT context: daemon-control ran three shell `lsof` probes
// unbounded (the Darwin cwd ownership evidence `lsof -a -p <pid> -d cwd -Fn`
// and the port-listener pid extractions `lsof -nP -iTCP:<port>
// -sTCP:LISTEN -t`, used twice). lsof walks kernel process/file tables and
// can block FOREVER inside the kernel on a host with a stale FUSE/network
// mount (the 2026 vaivm incident left 24 lsof processes wedged for five
// days). macOS ships no GNU `timeout`, so the fix is a POSIX-safe helper:
// `lsof -b -w <args>` runs in the BACKGROUND with stdout redirected to a
// temp file, is polled for TT_LSOF_TIMEOUT_S seconds (default 5), and is
// SIGKILLed AND reaped (`wait`) on expiry. A timed-out probe yields NO
// evidence (fail-closed) — never a silent empty result treated as
// "no open files" / "no listener".
//
// Pins (all hermetic — temp dirs only, no daemon, no TT ports, zero tokens):
//   1. STRUCTURAL: one raw lsof invocation (inside lsof_bounded) carrying
//      -b -w; the helper backgrounds + polls + `kill -KILL` + `wait`; the
//      bound comes from TT_LSOF_TIMEOUT_S; no GNU timeout command; all three
//      call sites use lsof_bounded.
//   2. BEHAVIORAL (hang-proof cwd probe): a fake lsof that sleeps 60 s makes
//      the extracted Darwin cwd ownership probe return within the bound,
//      refuse ownership, and leave the shim SIGKILLed AND reaped (ESRCH).
//   3. BEHAVIORAL (hang-proof port probe): the same hanging shim makes
//      listener_pid_for_port return within the bound with no fabricated pid.
//   4. POSITIVE: a fake lsof that prints the expected rows is passed through.
//   5. TIMEOUT SEAM: TT_LSOF_TIMEOUT_S default/blank/non-numeric/non-positive
//      fall back to 5; a positive value is honored.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob. Zero tokens;
// confined to torture-test/ (nothing written under it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const dcTool = path.join(ttRoot, "bin", "daemon-control");
const dcText = fs.readFileSync(dcTool, "utf8");

// ── helpers ────────────────────────────────────────────────────────────

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the probe children operate on temp dirs only. */
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

/** Run extracted bash functions in a temp file and return stdout. */
function runExtracted(
  fnTexts: string[],
  prologue: string,
  invocation: string,
  env?: NodeJS.ProcessEnv,
): CmdResult {
  const fnFile = path.join(
    os.tmpdir(),
    `dc-bounded-lsof-${process.pid}-${Math.random().toString(36).slice(2)}.sh`,
  );
  try {
    fs.writeFileSync(fnFile, `${fnTexts.join("\n")}\n${prologue}\n${invocation}\n`);
    return run(["bash", fnFile], { env, timeoutMs: 30_000 });
  } finally {
    fs.rmSync(fnFile, { force: true });
  }
}

function makeShim(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

/** Whether `pid` is still a live process (ESRCH => dead/reaped). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The extracted bounded-probe helper pair, present in every harness. */
const timeoutFn = extractFunction(dcText, "tt_lsof_timeout_s");
const boundedFn = extractFunction(dcText, "lsof_bounded");
const ownedFn = extractFunction(dcText, "verify_process_tt_owned");
const portFn = extractFunction(dcText, "listener_pid_for_port");

// ── the pins ───────────────────────────────────────────────────────────

describe("LSOF-EVTA US-006 — daemon-control shell lsof probes are bounded", () => {
  it("defines the bounded helper pair and routes every lsof call through it (structural)", () => {
    assert.ok(timeoutFn, "daemon-control must define tt_lsof_timeout_s()");
    assert.ok(boundedFn, "daemon-control must define lsof_bounded()");
    assert.ok(ownedFn, "daemon-control must define verify_process_tt_owned()");
    assert.ok(portFn, "daemon-control must define listener_pid_for_port()");

    // The one raw invocation always carries -b -w.
    assert.match(boundedFn, /lsof -b -w "\$@"/, "lsof_bounded must run `lsof -b -w <args>`");
    // Bounded via background + poll + SIGKILL + wait.
    assert.match(
      boundedFn,
      /lsof -b -w "\$@" > "\$out_file" 2>\/dev\/null &/,
      "lsof_bounded must background the probe with stdout redirected to a temp file",
    );
    assert.match(boundedFn, /kill -KILL "\$child_pid"/, "lsof_bounded must SIGKILL a timed-out child");
    assert.match(boundedFn, /wait "\$child_pid"/, "lsof_bounded must reap the child with wait");
    assert.match(boundedFn, /tt_lsof_timeout_s/, "lsof_bounded must derive its bound from tt_lsof_timeout_s");

    // The bound is configurable, defaults to 5, and never unbounded.
    assert.match(timeoutFn, /TT_LSOF_TIMEOUT_S/, "tt_lsof_timeout_s must read TT_LSOF_TIMEOUT_S");
    assert.match(timeoutFn, /default_s=5/, "the default lsof bound must be 5 seconds");

    // No GNU coreutils `timeout` command (macOS ships none).
    assert.doesNotMatch(
      dcText,
      /(^|[;&|(\s])timeout\s+[0-9]/m,
      "daemon-control must not invoke the GNU timeout command",
    );

    // Exactly ONE raw lsof command in the whole tool — inside lsof_bounded.
    const rawCalls = dcText
      .split(/\r?\n/)
      .filter((line) => /lsof -/.test(line) && !/^\s*#/.test(line) && !/lsof_bounded/.test(line));
    assert.equal(
      rawCalls.length,
      1,
      `expected exactly one raw lsof invocation (inside lsof_bounded), got:\n${rawCalls.join("\n")}`,
    );
    assert.match(rawCalls[0], /lsof -b -w/, "the sole raw lsof invocation must carry -b -w");

    // All three call sites are the bounded helper.
    assert.match(
      ownedFn,
      /lsof_bounded -a -p "\$pid" -d cwd -Fn/,
      "the Darwin cwd ownership probe must use lsof_bounded",
    );
    const portCalls = dcText.match(/lsof_bounded -nP -iTCP:"\$port" -sTCP:LISTEN -t/g) ?? [];
    assert.equal(portCalls.length, 2, "both port-listener pid extractions must use lsof_bounded");
  });

  it("a hanging lsof cannot wedge the Darwin cwd ownership probe: it returns within the bound and reaps the child (behavioral)", () => {
    assert.ok(timeoutFn && boundedFn && ownedFn);
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bounded-owned-"));
    const pidFile = path.join(shimDir, "hang.pid");
    try {
      makeShim(shimDir, "lsof", `echo "$$" > "$LSOF_HANG_PIDFILE"\nexec sleep 60`);
      makeShim(shimDir, "ps", `exit 1`);

      const env = cleanEnv({
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        TT_DC_PLATFORM: "Darwin",
        TT_LSOF_TIMEOUT_S: "1",
        LSOF_HANG_PIDFILE: pidFile,
      });
      const started = Date.now();
      const out = runExtracted(
        [timeoutFn, boundedFn, ownedFn],
        `TT_REPO_ROOT="${repoRoot}"`,
        `if verify_process_tt_owned 12345 /ignored; then echo "rc=0"; else echo "rc=$?"; fi`,
        env,
      );
      const elapsed = Date.now() - started;

      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /rc=1/, `a timed-out cwd probe must refuse ownership. stdout: ${out.stdout}`);
      assert.ok(
        elapsed < 5000,
        `the cwd probe must return within the 1s bound (elapsed ${elapsed}ms) — an unbounded lsof would hang ~60s`,
      );
      assert.match(
        out.stderr,
        /lsof probe timed out/,
        `the timeout must be reported (degradation line). stderr: ${out.stderr}`,
      );

      const hangPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isInteger(hangPid) && hangPid > 0, "the shim must record its pid");
      assert.equal(
        pidAlive(hangPid),
        false,
        `the timed-out lsof child must be SIGKILLed and reaped (pid ${hangPid} still alive)`,
      );
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("a hanging lsof cannot wedge the port-listener probe: it returns within the bound with no fabricated pid (behavioral)", () => {
    assert.ok(timeoutFn && boundedFn && portFn);
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bounded-port-"));
    const pidFile = path.join(shimDir, "hang.pid");
    try {
      makeShim(shimDir, "lsof", `echo "$$" > "$LSOF_HANG_PIDFILE"\nexec sleep 60`);

      const env = cleanEnv({
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        TT_LSOF_TIMEOUT_S: "1",
        LSOF_HANG_PIDFILE: pidFile,
      });
      const started = Date.now();
      const out = runExtracted(
        [timeoutFn, boundedFn, portFn],
        "",
        `pid="$(listener_pid_for_port 59999)"; echo "pid=[$pid]"`,
        env,
      );
      const elapsed = Date.now() - started;

      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /pid=\[\]/, `a timed-out port probe must yield no pid. stdout: ${out.stdout}`);
      assert.ok(
        elapsed < 5000,
        `the port probe must return within the 1s bound (elapsed ${elapsed}ms)`,
      );

      const hangPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      assert.ok(Number.isInteger(hangPid) && hangPid > 0, "the shim must record its pid");
      assert.equal(
        pidAlive(hangPid),
        false,
        `the timed-out lsof child must be SIGKILLed and reaped (pid ${hangPid} still alive)`,
      );
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("a healthy lsof's stdout is passed through (positive control)", () => {
    assert.ok(timeoutFn && boundedFn);
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-bounded-ok-"));
    try {
      makeShim(shimDir, "lsof", `printf 'p123\\nn/repo/work\\n'\nexit 0`);
      const env = cleanEnv({ PATH: `${shimDir}:${process.env.PATH ?? ""}` });
      const out = runExtracted(
        [timeoutFn, boundedFn],
        "",
        `lsof_bounded -a -p 123 -d cwd -Fn`,
        env,
      );
      assert.equal(out.status, 0, out.stderr);
      assert.match(out.stdout, /p123/, `healthy lsof stdout must be passed through. stdout: ${out.stdout}`);
      assert.match(out.stdout, /n\/repo\/work/, `healthy lsof stdout must be passed through. stdout: ${out.stdout}`);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("TT_LSOF_TIMEOUT_S default/blank/non-numeric/non-positive fall back to 5 and a positive value is honored", () => {
    assert.ok(timeoutFn);
    const cases: Array<[string | undefined, string]> = [
      [undefined, "5"],
      ["", "5"],
      ["abc", "5"],
      ["0", "5"],
      ["-3", "5"],
      ["7", "7"],
    ];
    for (const [value, expected] of cases) {
      const env = cleanEnv();
      delete env.TT_LSOF_TIMEOUT_S;
      if (value !== undefined) env.TT_LSOF_TIMEOUT_S = value;
      const out = runExtracted([timeoutFn], "", `tt_lsof_timeout_s; echo`, env);
      assert.equal(out.status, 0, out.stderr);
      assert.equal(
        out.stdout.trim(),
        expected,
        `TT_LSOF_TIMEOUT_S=${JSON.stringify(value)} must resolve to ${expected}, got ${JSON.stringify(out.stdout.trim())}`,
      );
    }
  });
});
