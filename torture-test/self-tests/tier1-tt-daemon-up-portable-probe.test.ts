// US-002 — tt-daemon-up adopts the shared address-exact port-probe helper
// (torture-test/lib/port-probe.sh) red/green regression guard.
//
// Darwin defect: tt-daemon-up's is_port_listening ran
// `timeout 1 bash -c "echo >/dev/tcp/localhost/$port"` — a GNU coreutils
// `timeout` dependency (absent on stock macOS) plus a `localhost` hostname
// lookup that can resolve to the IPv6 loopback (::1) on darwin while the
// daemon binds 127.0.0.1. The fix: tt-daemon-up sources the shared
// SOURCE-ONLY torture-test/lib/port-probe.sh (a node net.connect to
// 127.0.0.1 with a bounded 1s in-process timeout) and deletes its local
// GNU-timeout probe body, so `is_port_listening` keeps its name and every
// existing caller (wait_for_daemon_up / stop_daemon_for_restart / cmd_stop /
// cmd_ensure_up) works unchanged.
//
// Two mechanical, bounded, hermetic pins (no campaign, zero tokens):
//   1. STRUCTURAL: tt-daemon-up sources port-probe.sh, no longer defines a
//      local is_port_listening GNU-timeout probe, keeps ports_free as a loop
//      over REAL_PORTS calling is_port_listening, and every existing caller
//      still calls is_port_listening.
//   2. RED/GREEN: with a `timeout` shim exiting 127 prepended to PATH (the
//      command-not-found behavior), the SOURCED is_port_listening detects a
//      live 127.0.0.1 listener and reads a closed port as free. Against the
//      pre-fix tool this arm is RED (the GNU-timeout probe cannot run);
//      against the fixed tool it is GREEN.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob — no run.sh edit.
// Zero tokens; confined to torture-test/; the live 33xx daemon is never
// touched (the hermetic listener binds an ephemeral 127.0.0.1 port only).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const daemonUpTool = path.join(ttRoot, "bin", "tt-daemon-up");
const probeScript = path.join(ttRoot, "lib", "port-probe.sh");
const daemonUpText = fs.readFileSync(daemonUpTool, "utf8");

// ── helpers ────────────────────────────────────────────────────────────

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the probe children operate on loopback + temp dirs only. */
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
    timeout: opts.timeoutMs ?? 30_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

/** Mask comment tails (and comment-only lines) with spaces, preserving line
 *  lengths and newlines, so extraction's quote/brace tracking never sees
 *  apostrophes or quotes that live inside comments. Quoted spans and their
 *  contents are KEPT (braces inside quoted strings still count, and quotes
 *  inside comments are neutralized). */
function maskComments(text: string): string {
  const out: string[] = new Array<string>(text.length).fill("");
  let inSingle = false;
  let inDouble = false;
  let prev = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inSingle) {
      out[i] = ch;
      if (ch === "'") inSingle = false;
      prev = ch;
      continue;
    }
    if (inDouble) {
      out[i] = ch;
      if (ch === "\\") {
        if (i + 1 < text.length) {
          out[i + 1] = text[i + 1];
          i += 1;
        }
      } else if (ch === '"') {
        inDouble = false;
      }
      prev = ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out[i] = ch;
      prev = ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out[i] = ch;
      prev = ch;
      continue;
    }
    // A `#` begins a comment when it starts a word: at line start, or after
    // whitespace / a command separator.
    if (ch === "#" && (prev === "" || /\s/.test(prev) || /[;|&(){}]/.test(prev))) {
      let j = i;
      while (j < text.length && text[j] !== "\n") {
        out[j] = " ";
        j += 1;
      }
      i = j - 1;
      prev = " ";
      continue;
    }
    out[i] = ch;
    prev = ch;
  }
  return out.join("");
}

/** Extract a top-level `name() { ... }` function body (balanced-brace,
 *  quote-aware, comment-masked) from the tool text, or null when the
 *  function is absent. */
function extractFunction(text: string, name: string): string | null {
  const masked = maskComments(text);
  const start = masked.indexOf(`${name}()`);
  if (start < 0) return null;
  const open = masked.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
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
      if (depth === 0) return masked.slice(start, i + 1);
    }
  }
  return null;
}

/** The exact `source` directive tt-daemon-up uses to adopt the shared
 *  helper — must be `. "$TT_DIR/lib/port-probe.sh"`. */
function daemonUpSourceDirective(): string {
  const line = daemonUpText
    .split(/\r?\n/)
    .find((l) => l.trim() === '. "$TT_DIR/lib/port-probe.sh"');
  assert.ok(line, "tt-daemon-up must source port-probe.sh via `. \"$TT_DIR/lib/port-probe.sh\"`");
  return line;
}

/** Run tt-daemon-up's exact source directive against the real helper, then
 *  `invocation`, in a temp script under `env`. SCRIPT_DIR/TT_DIR are defined
 *  the same way tt-daemon-up defines them, so the sourced is_port_listening
 *  is the exact one the tool uses. */
function runDaemonUpSourcedProbe(invocation: string, env?: NodeJS.ProcessEnv): CmdResult {
  const script = path.join(
    os.tmpdir(),
    `tt-du-probe-${process.pid}-${Math.random().toString(36).slice(2)}.sh`,
  );
  try {
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        `SCRIPT_DIR="${path.join(ttRoot, "bin")}"`,
        `TT_DIR="${ttRoot}"`,
        daemonUpSourceDirective(),
        invocation,
        "",
      ].join("\n"),
    );
    return run(["bash", script], { env, timeoutMs: 30_000 });
  } finally {
    fs.rmSync(script, { force: true });
  }
}

/** Start a node TCP listener on an ephemeral port bound to 127.0.0.1;
 *  resolves with the server and its port. The test closes it in finally. */
function startListener(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve({ server, port: addr.port });
      else reject(new Error("listener address unavailable"));
    });
  });
}

/** Close a listener and resolve when fully closed (or on error). */
function closeListener(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
    server.once("error", () => resolve());
  });
}

// ── the guard ──────────────────────────────────────────────────────────

describe("US-002 — tt-daemon-up adopts the shared address-exact port probe", () => {
  it("sources port-probe.sh and no longer defines a local GNU-timeout is_port_listening probe (structural)", () => {
    assert.match(daemonUpText, /\.\s*"\$TT_DIR\/lib\/port-probe\.sh"/, "tt-daemon-up must source the shared helper");

    const localProbe = extractFunction(daemonUpText, "is_port_listening");
    assert.equal(
      localProbe,
      null,
      "tt-daemon-up must NOT define a local is_port_listening() (it is provided by the sourced helper)",
    );
    assert.doesNotMatch(
      daemonUpText,
      /timeout\s+1\s+bash/,
      "tt-daemon-up must have no GNU `timeout 1 bash` probe",
    );
    assert.doesNotMatch(daemonUpText, /\/dev\/tcp/, "tt-daemon-up must have no bash /dev/tcp probe");
  });

  it("grep-pinned: zero timeout//dev/tcp/localhost probe literals remain in tt-daemon-up", () => {
    // The only remaining `timeout` tokens are the comment prose and the
    // wait_for_daemon_up `timeout_sec` variable — never a GNU `timeout` cmd.
    // Comment-only lines are skipped exactly as the GNU-ism lint masks them.
    const lines = daemonUpText.split(/\r?\n/);
    for (const [i, line] of lines.entries()) {
      if (line.trimStart().startsWith("#")) continue; // comment-only line
      assert.doesNotMatch(
        line,
        /(^|[;&|(\s])timeout(\s+-{1,2}[^\s]+)*\s+[0-9]+[smhd]?/,
        `line ${i + 1} still carries a GNU timeout command`,
      );
      assert.doesNotMatch(line, /\/dev\/tcp/, `line ${i + 1} still carries a /dev/tcp probe literal`);
      assert.doesNotMatch(line, /localhost/, `line ${i + 1} still carries a localhost literal`);
    }
  });

  it("ports_free stays a loop over REAL_PORTS calling is_port_listening (callers unchanged)", () => {
    const portsFree = extractFunction(daemonUpText, "ports_free");
    assert.ok(portsFree, "ports_free must exist");
    assert.match(portsFree, /for p in \$REAL_PORTS/, "ports_free must loop over REAL_PORTS");
    assert.match(portsFree, /is_port_listening "\$p"/, "ports_free must call is_port_listening per port");

    for (const fn of ["wait_for_daemon_up", "cmd_ensure_up"]) {
      const body = extractFunction(daemonUpText, fn);
      assert.ok(body, `${fn} must exist`);
      assert.match(body, /is_port_listening/, `${fn} must still call is_port_listening`);
    }
    // stop_daemon_for_restart and cmd_stop call is_port_listening through the
    // ports_free loop (the function-name-preserved seam the story keeps).
    for (const fn of ["stop_daemon_for_restart", "cmd_stop"]) {
      const body = extractFunction(daemonUpText, fn);
      assert.ok(body, `${fn} must exist`);
      assert.match(body, /ports_free/, `${fn} must still call ports_free (→ is_port_listening)`);
    }
  });

  it("passes `bash -n` (bash 3.2 syntax) and resolves the sourced helper", () => {
    const syntax = run(["bash", "-n", daemonUpTool]);
    assert.equal(syntax.status, 0, `bash -n failed on tt-daemon-up: ${syntax.stderr}`);
    assert.ok(fs.existsSync(probeScript), "port-probe.sh must exist at torture-test/lib/port-probe.sh");
  });

  it("RED/GREEN: tt-daemon-up's sourced is_port_listening detects a live 127.0.0.1 listener with `timeout` hidden on PATH", async () => {
    // PATH seam: a `timeout` shim that exits 127 (command-not-found
    // behavior) prepended to the real PATH. The pre-fix GNU-timeout probe
    // cannot run under this seam (RED); the sourced helper ignores it (GREEN).
    const seamDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-du-no-timeout-"));
    const timeoutShim = path.join(seamDir, "timeout");
    fs.writeFileSync(timeoutShim, '#!/bin/sh\necho "timeout: command not found" >&2\nexit 127\n');
    fs.chmodSync(timeoutShim, 0o755);

    let server: net.Server | null = null;
    try {
      const started = await startListener();
      server = started.server;
      const { port } = started;

      const env = cleanEnv({ PATH: `${seamDir}:${process.env.PATH ?? ""}` });

      // The exact old probe tt-daemon-up used. Under the seam it must fail —
      // the darwin false-negative that motivated the fix.
      const oldProbe = run(
        ["bash", "-c", `timeout 1 bash -c "echo >/dev/tcp/localhost/${port}"`],
        { env, timeoutMs: 10_000 },
      );
      assert.notEqual(
        oldProbe.status,
        0,
        `the old GNU timeout//dev/tcp probe must fail with timeout hidden (got status ${oldProbe.status})`,
      );

      // tt-daemon-up's SOURCED is_port_listening must report LISTENING under
      // the SAME seam.
      const live = runDaemonUpSourcedProbe(
        `if is_port_listening "${port}"; then echo LISTENING; else echo NOT_LISTENING; fi`,
        env,
      );
      assert.equal(live.status, 0, `sourced probe failed: ${live.stderr}`);
      assert.match(
        live.stdout,
        /LISTENING/,
        `a live 127.0.0.1 listener must be detected with timeout hidden. stdout: ${live.stdout}`,
      );

      // Negative arm: once closed, the same port must read free.
      await closeListener(server);
      server = null;
      const closed = runDaemonUpSourcedProbe(
        `if is_port_listening "${port}"; then echo CLOSED_LISTENING; else echo CLOSED_FREE; fi`,
        env,
      );
      assert.equal(closed.status, 0, `sourced probe failed: ${closed.stderr}`);
      assert.match(
        closed.stdout,
        /CLOSED_FREE/,
        `a closed port must read free under the timeout-hidden seam. stdout: ${closed.stdout}`,
      );
    } finally {
      if (server) await closeListener(server);
      fs.rmSync(seamDir, { recursive: true, force: true });
    }
  });
});
