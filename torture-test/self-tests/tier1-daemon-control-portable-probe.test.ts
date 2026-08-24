// MACP4 US-001 — daemon-control portable TCP port probe + TT_FORCE_NO_SYSTEMD
// forced-fallback override (red-then-green regression guard).
//
// Darwin defect: daemon-control's port liveness probes
// (wait_for_port/is_port_listening) ran `timeout 1 bash -c
// "echo >/dev/tcp/localhost/$port"` — a GNU-`timeout` dependency that macOS
// does not ship, so EVERY scripted start/status/stop failed on the mac
// ("timeout: command not found"). The fix replaces the probe with a
// portable node net.connect probe (port_probe, bounded 1s) and adds a
// TT_FORCE_NO_SYSTEMD=1 override that makes has_systemd_scope() return
// false so cmd_start uses the platform-neutral plain-background fallback
// (nohup) launch path even on a systemd host — the path Darwin always
// takes.
//
// Three mechanical, bounded, hermetic pins (no campaign, zero tokens):
//   1. PORTABLE PROBE (red-then-green): a node listener on a free high port
//      is detected by is_port_listening/wait_for_port even when `timeout`
//      is HIDDEN behind a PATH seam (a failing shim that exits 127 — the
//      command-not-found behavior). Against the pre-fix tool this arm is
//      RED (the GNU-timeout probe cannot run); against the fixed tool it is
//      GREEN. Reproduce the RED case with the pre-fix blob in a temp tree:
//
//        TMPD=$(mktemp -d)
//        mkdir -p "$TMPD/torture-test/bin"
//        git show <pre-fix-commit>:torture-test/bin/daemon-control \
//          > "$TMPD/torture-test/bin/daemon-control" && chmod +x "$TMPD/torture-test/bin/daemon-control"
//        TT_DC_TOOL="$TMPD/torture-test/bin/daemon-control" node --test \
//          torture-test/self-tests/tier1-daemon-control-portable-probe.test.ts
//
//   2. FORCED-FALLBACK OVERRIDE: has_systemd_scope() honors
//      TT_FORCE_NO_SYSTEMD=1 — with a fake systemd-run that SUCCEEDS on
//      PATH, the override still returns NO_SYSTEMD while the default
//      (no override) returns HAS_SYSTEMD. The override is independent of
//      the mechanical systemd-run result.
//
//   3. FALLBACK-PATH INTEGRITY (structural): cmd_start's fallback branch
//      prints the marker "systemd not available — using plain background
//      spawn", applies the S24/US-006 contained PATH reconstruction
//      (contained_path_for_kind) exactly like the systemd path, and writes
//      provenance with cgroupVerified=false (the cgroup_ok default).
//
// The full forced-fallback start→status→stop daemon cycle lives in
// bin/daemon-control.test.sh (Test 75b) — the behavioral proof that the
// cycle exits 0 on a systemd linux host. This file stays hermetic: no
// daemon starts, no TT ports touched, nothing written under torture-test/.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded battery —
// no run.sh edit). Zero tokens; confined to torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const repoDcTool = path.join(ttRoot, "bin", "daemon-control");

// TT_DC_TOOL points the assertions at an alternate daemon-control tree
// (used to demonstrate the RED case against the pre-fix GNU-timeout tool).
const dcTool = process.env.TT_DC_TOOL ?? repoDcTool;
const dcText = fs.readFileSync(dcTool, "utf8");

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
  invocation: string,
  env?: NodeJS.ProcessEnv,
): CmdResult {
  const fnFile = path.join(os.tmpdir(), `dc-probe-fn-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  try {
    fs.writeFileSync(fnFile, `${fnTexts.join("\n")}\n${invocation}\n`);
    return run(["bash", fnFile], { env, timeoutMs: 30_000 });
  } finally {
    fs.rmSync(fnFile, { force: true });
  }
}

/** Start a node TCP listener on an ephemeral free port (127.0.0.1); resolves
 *  with the server and its port. The test closes it in its finally. */
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

describe("MACP4 US-001 — daemon-control portable port probe + TT_FORCE_NO_SYSTEMD", () => {
  it("wait_for_port and is_port_listening use the portable port_probe with NO GNU-timeout dependency (structural)", () => {
    const probe = extractFunction(dcText, "port_probe");
    assert.ok(probe, "daemon-control must define port_probe() (the portable TCP-connect probe)");
    assert.match(probe, /net\.connect/, "port_probe must use node net.connect (portable, no GNU timeout)");
    assert.doesNotMatch(probe, /timeout 1 bash/, "port_probe must not invoke the GNU timeout utility");

    const waitFn = extractFunction(dcText, "wait_for_port");
    assert.ok(waitFn, "wait_for_port must exist");
    assert.match(waitFn, /port_probe "\$port"/, "wait_for_port must poll with the portable port_probe");
    assert.doesNotMatch(waitFn, /timeout 1 bash/, "wait_for_port must have no GNU-timeout-dependent probe");

    const listenFn = extractFunction(dcText, "is_port_listening");
    assert.ok(listenFn, "is_port_listening must exist");
    assert.match(listenFn, /port_probe/, "is_port_listening must use the portable port_probe");
    assert.doesNotMatch(listenFn, /timeout 1 bash/, "is_port_listening must have no GNU-timeout-dependent probe");
  });

  it("RED/GREEN: is_port_listening and wait_for_port detect a live listener even when `timeout` is hidden (PATH seam)", async () => {
    const probe = extractFunction(dcText, "port_probe");
    const listenFn = extractFunction(dcText, "is_port_listening");
    const waitFn = extractFunction(dcText, "wait_for_port");

    // PATH seam: a `timeout` shim that exits 127 (command-not-found
    // behavior) prepended to the real PATH. The pre-fix GNU-timeout probe
    // cannot run under this seam (RED); the portable probe ignores it (GREEN).
    const seamDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-no-timeout-"));
    const timeoutShim = path.join(seamDir, "timeout");
    fs.writeFileSync(timeoutShim, '#!/bin/sh\necho "timeout: command not found" >&2\nexit 127\n');
    fs.chmodSync(timeoutShim, 0o755);

    let server: net.Server | null = null;
    try {
      assert.ok(probe && listenFn && waitFn, "port_probe/is_port_listening/wait_for_port must all exist");
      const started = await startListener();
      server = started.server;
      const { port } = started;

      const env = cleanEnv({ PATH: `${seamDir}:${process.env.PATH ?? ""}` });
      const out = runExtracted(
        [probe, listenFn, waitFn],
        [
          `if is_port_listening "${port}"; then echo LISTENING; else echo NOT_LISTENING; fi`,
          `if wait_for_port "${port}" 3; then echo WAIT_OK; else echo WAIT_FAIL; fi`,
        ].join("\n"),
        env,
      );
      assert.equal(out.status, 0, `extracted probe script failed: ${out.stderr}`);
      assert.match(
        out.stdout,
        /LISTENING/,
        `a live listener must be detected with timeout hidden (RED against pre-fix, GREEN post-fix). stdout: ${out.stdout}`,
      );
      assert.match(out.stdout, /WAIT_OK/, `wait_for_port must succeed with timeout hidden. stdout: ${out.stdout}`);

      // Negative arm: the SAME port, once the listener is closed, must read
      // as free (no false positive) — again under the timeout-hidden seam.
      await closeListener(server);
      server = null;
      const closedOut = runExtracted(
        [probe, listenFn, waitFn],
        `if is_port_listening "${port}"; then echo CLOSED_LISTENING; else echo CLOSED_FREE; fi`,
        cleanEnv({ PATH: `${seamDir}:${process.env.PATH ?? ""}` }),
      );
      assert.match(
        closedOut.stdout,
        /CLOSED_FREE/,
        `a closed port must read as free under the timeout-hidden seam. stdout: ${closedOut.stdout}`,
      );
    } finally {
      if (server) await closeListener(server);
      fs.rmSync(seamDir, { recursive: true, force: true });
    }
  });

  it("has_systemd_scope honors TT_FORCE_NO_SYSTEMD=1 (forced fallback) with default unchanged", () => {
    const fn = extractFunction(dcText, "has_systemd_scope");
    assert.ok(fn, "has_systemd_scope must exist");
    assert.match(fn, /TT_FORCE_NO_SYSTEMD/, "has_systemd_scope must check the TT_FORCE_NO_SYSTEMD override");

    // Fake systemd-run that SUCCEEDS: without the override the mechanical
    // check returns HAS_SYSTEMD; with TT_FORCE_NO_SYSTEMD=1 it returns
    // NO_SYSTEMD regardless of the systemd-run result.
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "dc-fake-sysd-"));
    const shim = path.join(fakeBin, "systemd-run");
    fs.writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(shim, 0o755);

    try {
      const env = cleanEnv({ PATH: `${fakeBin}:${process.env.PATH ?? ""}` });
      const invocation = 'if has_systemd_scope; then echo HAS_SYSTEMD; else echo NO_SYSTEMD; fi';

      const def = runExtracted([fn], invocation, env);
      assert.equal(def.status, 0, `has_systemd_scope default run failed: ${def.stderr}`);
      assert.match(
        def.stdout,
        /HAS_SYSTEMD/,
        `without the override a succeeding systemd-run must yield HAS_SYSTEMD (default unchanged). stdout: ${def.stdout}`,
      );

      const forced = runExtracted(
        [fn],
        invocation,
        cleanEnv({ PATH: `${fakeBin}:${process.env.PATH ?? ""}`, TT_FORCE_NO_SYSTEMD: "1" }),
      );
      assert.equal(forced.status, 0, `TT_FORCE_NO_SYSTEMD run failed: ${forced.stderr}`);
      assert.match(
        forced.stdout,
        /NO_SYSTEMD/,
        `TT_FORCE_NO_SYSTEMD=1 must force NO_SYSTEMD even when systemd-run succeeds. stdout: ${forced.stdout}`,
      );
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it("cmd_start fallback path keeps the S24 contained PATH reconstruction, the fallback marker, and cgroupVerified=false provenance", () => {
    const cmdStart = extractFunction(dcText, "cmd_start");
    assert.ok(cmdStart, "cmd_start must exist");
    assert.match(
      cmdStart,
      /systemd not available — using plain background spawn/,
      "cmd_start must print the fallback marker on the plain-background path",
    );
    // The fallback launch applies the SAME contained PATH reconstruction as
    // the systemd path (S24/US-006): var/adapters-bin first, operator bin
    // dirs reordered after.
    assert.match(
      cmdStart,
      /nohup env -i \$\(env_for_kind "\$kind"\) PATH="\$\(contained_path_for_kind "\$kind"\)"/,
      "cmd_start fallback branch must launch with the contained_path_for_kind PATH reconstruction (S24/US-006)",
    );
    assert.match(cmdStart, /use_systemd=false/, "cmd_start must default use_systemd to false");
    // cgroup_ok stays false on the fallback path, so provenance records
    // cgroupVerified=false.
    assert.match(cmdStart, /local cgroup_ok=false/, "cmd_start must default cgroup_ok to false (fallback provenance cgroupVerified=false)");
    assert.match(cmdStart, /if \$use_systemd; then/, "cgroup verification must be gated on use_systemd (never claimed on the fallback path)");
  });
});
