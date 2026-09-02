// US-001 — shared address-exact port-probe helper
// (torture-test/lib/port-probe.sh) red/green self-test.
//
// Darwin defect: the tt-daemon-up port probe ran `timeout 1 bash -c
// "echo >/dev/tcp/localhost/$port"` — a GNU coreutils `timeout` dependency
// (absent on stock macOS) plus a `localhost` hostname lookup that can resolve
// to the IPv6 loopback (::1) on darwin while the daemon binds 127.0.0.1. The
// fix is a single shared, address-exact helper sourced by every port-checking
// tool: a node net.connect to 127.0.0.1 with a bounded 1-second in-process
// timeout — no `timeout`, no `localhost`, no ::1 fallback.
//
// This file is hermetic and linux-runnable: it sources the helper and drives
// it against live loopback listeners only (127.0.0.1 and, when available,
// ::1), with a `timeout` PATH shim that exits 127 to prove the old probe is
// dead while the new one is alive. Zero tokens, no daemon starts, nothing
// written under torture-test/.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob — no run.sh edit.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const probeScript = path.join(repoRoot, "torture-test", "lib", "port-probe.sh");
const probeText = fs.readFileSync(probeScript, "utf8");

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

/** Extract a top-level `name() { ... }` function body (balanced-brace,
 *  quote-aware) from the helper text, or null when the function is absent. */
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

/** Source the shared helper in a temp bash script and run `invocation`. */
function runProbe(invocation: string, env?: NodeJS.ProcessEnv): CmdResult {
  const script = path.join(
    os.tmpdir(),
    `pp-fn-${process.pid}-${Math.random().toString(36).slice(2)}.sh`,
  );
  try {
    fs.writeFileSync(script, `. "${probeScript}"\n${invocation}\n`);
    return run(["bash", script], { env, timeoutMs: 30_000 });
  } finally {
    fs.rmSync(script, { force: true });
  }
}

/** Start a node TCP listener on an ephemeral port bound to `host`; resolves
 *  with the server and its port. Rejects when the host is unavailable (e.g.
 *  no IPv6 loopback). The test closes it in its finally. */
function startListener(host: string): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
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

describe("US-001 — shared address-exact port-probe helper (torture-test/lib/port-probe.sh)", () => {
  it("defines port_probe, is_port_listening and wait_for_port with an address-exact node net.connect probe (structural)", () => {
    const probe = extractFunction(probeText, "port_probe");
    assert.ok(probe, "port-probe.sh must define port_probe()");
    assert.match(probe, /net\.connect/, "port_probe must use node net.connect");
    assert.match(probe, /127\.0\.0\.1/, "port_probe must connect to 127.0.0.1 only");
    assert.doesNotMatch(probe, /localhost/, "port_probe must not use a `localhost` hostname lookup");
    assert.doesNotMatch(probe, /::1/, "port_probe must not fall back to the IPv6 loopback ::1");
    assert.doesNotMatch(probe, /timeout 1 bash/, "port_probe must not invoke the GNU timeout utility");
    assert.doesNotMatch(probe, /\/dev\/tcp/, "port_probe must not use the bash /dev/tcp host-resolution connect");

    const listenFn = extractFunction(probeText, "is_port_listening");
    assert.ok(listenFn, "is_port_listening must exist");
    assert.match(listenFn, /port_probe/, "is_port_listening must delegate to port_probe");

    const waitFn = extractFunction(probeText, "wait_for_port");
    assert.ok(waitFn, "wait_for_port must exist");
    assert.match(waitFn, /port_probe/, "wait_for_port must poll with port_probe");
    assert.doesNotMatch(waitFn, /timeout 1 bash/, "wait_for_port must have no GNU-timeout probe");
  });

  it("passes `bash -n` (bash 3.2 syntax) and sources without side effects", () => {
    const syntax = run(["bash", "-n", probeScript]);
    assert.equal(syntax.status, 0, `bash -n failed on the helper: ${syntax.stderr}`);

    // Sourcing the helper must only define the functions — no stdout, no exit.
    const sourced = run(["bash", "-c", `. "${probeScript}"\ncommand -v port_probe is_port_listening wait_for_port`]);
    assert.equal(sourced.status, 0, `sourcing the helper failed: ${sourced.stderr}`);
    assert.equal(sourced.stdout.trim(), "port_probe\nis_port_listening\nwait_for_port", "the helper must define exactly the three probe functions on source");
  });

  it("RED/GREEN: with a `timeout` shim exiting 127 on PATH, the old timeout//dev/tcp probe fails while the helper reports LISTENING", async () => {
    // PATH seam: a `timeout` shim that exits 127 (the command-not-found
    // behavior) prepended to the real PATH. The pre-fix GNU-timeout probe
    // cannot run under this seam (RED); the portable helper ignores it (GREEN).
    const seamDir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-no-timeout-"));
    const timeoutShim = path.join(seamDir, "timeout");
    fs.writeFileSync(timeoutShim, '#!/bin/sh\necho "timeout: command not found" >&2\nexit 127\n');
    fs.chmodSync(timeoutShim, 0o755);

    let server: net.Server | null = null;
    try {
      const started = await startListener("127.0.0.1");
      server = started.server;
      const { port } = started;

      const env = cleanEnv({ PATH: `${seamDir}:${process.env.PATH ?? ""}` });

      // Synthetic reproduction of the OLD probe. Against the seam it must
      // fail — the exact darwin false-negative that motivated the fix.
      const oldProbe = run(
        ["bash", "-c", `timeout 1 bash -c "echo >/dev/tcp/localhost/${port}"`],
        { env, timeoutMs: 10_000 },
      );
      assert.notEqual(
        oldProbe.status,
        0,
        `the old GNU timeout//dev/tcp probe must fail with timeout hidden (got status ${oldProbe.status})`,
      );

      // The shared helper must report LISTENING under the SAME seam.
      const helper = runProbe(
        `if is_port_listening "${port}"; then echo LISTENING; else echo NOT_LISTENING; fi`,
        env,
      );
      assert.equal(helper.status, 0, `helper probe failed: ${helper.stderr}`);
      assert.match(
        helper.stdout,
        /LISTENING/,
        `a live 127.0.0.1 listener must be detected with timeout hidden. stdout: ${helper.stdout}`,
      );
    } finally {
      if (server) await closeListener(server);
      fs.rmSync(seamDir, { recursive: true, force: true });
    }
  });

  it("a ::1-only listener is NOT reported listening (address-exact; skips when IPv6 loopback is unavailable)", async (t) => {
    const server = net.createServer();
    let port = 0;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", () => {
          const addr = server.address();
          if (addr && typeof addr === "object") {
            port = addr.port;
            resolve();
          } else {
            reject(new Error("listener address unavailable"));
          }
        });
      });
    } catch {
      t.skip("IPv6 loopback (::1) is unavailable on this host");
      return;
    }
    try {
      const out = runProbe(
        `if is_port_listening "${port}"; then echo LISTENING; else echo NOT_LISTENING; fi`,
      );
      assert.equal(out.status, 0, `helper probe failed: ${out.stderr}`);
      assert.match(
        out.stdout,
        /NOT_LISTENING/,
        `a ::1-only listener must NOT be reported listening on 127.0.0.1 (address-exact). stdout: ${out.stdout}`,
      );
    } finally {
      await closeListener(server);
    }
  });

  it("a closed port reads free and wait_for_port times out", async () => {
    const started = await startListener("127.0.0.1");
    const { port } = started;
    await closeListener(started.server);

    const out = runProbe(
      `if is_port_listening "${port}"; then echo LISTENING; else echo FREE; fi`,
    );
    assert.equal(out.status, 0, `helper probe failed: ${out.stderr}`);
    assert.match(
      out.stdout,
      /FREE/,
      `a closed port must read as free. stdout: ${out.stdout}`,
    );

    const waitOut = runProbe(
      `if wait_for_port "${port}" 2; then echo WAIT_OK; else echo WAIT_TIMEOUT; fi`,
    );
    assert.equal(waitOut.status, 0, `wait_for_port probe failed: ${waitOut.stderr}`);
    assert.match(
      waitOut.stdout,
      /WAIT_TIMEOUT/,
      `wait_for_port must time out on a closed port. stdout: ${waitOut.stdout}`,
    );
  });
});
