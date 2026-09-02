// US-007 (darwin behavioral proof) — tt-daemon-up daemon_path_has_adapters_bin
// portable process-environment PATH check regression guard.
//
// Darwin defect surfaced by the ensure-up --fresh proof: tt-daemon-up's
// daemon_path_has_adapters_bin read ONLY /proc/<pid>/environ (linux procfs).
// On /proc-less macOS that read always yielded an empty env_path, so the
// function conservatively returned "adapters-bin not on PATH" for EVERY
// started daemon — a false negative that made `tt-daemon-up ensure-up --fresh`
// fail closed with `REASON: tt-daemon-down` (PATH prepend missing) even though
// daemon-control had started the daemon with var/adapters-bin FIRST on PATH
// (the S12/E3.D US-009 invariant). The fix: a Darwin arm reads the daemon's
// environment via BSD `ps eww -p <pid>` (command followed by space-separated
// KEY=VALUE pairs), while the linux arm keeps the /proc/<pid>/environ read
// (MACP3 US-003).
//
// Two hermetic, bounded pins (no campaign, zero tokens):
//   1. STRUCTURAL: daemon_path_has_adapters_bin has BOTH arms — the Darwin
//      `ps eww -p` arm and the linux /proc/<pid>/environ arm (MACP3 US-003
//      marker retained) — so a future regression that drops the Darwin arm
//      fails this test even on a linux runner.
//   2. BEHAVIORAL: spawn a background node process whose PATH carries a
//      sentinel temp adapters-bin dir (positive arm) or omits it (negative
//      arm), write its PID into a temp state-dir tamandua.pid, point a temp
//      env script at that state dir, and source the REAL daemon_pid +
//      daemon_path_has_adapters_bin functions. The positive arm must report
//      HAS_BIN (return 0) and the negative arm LACKS_BIN (return 1) on the
//      HOST's own platform (Darwin -> ps eww arm, linux -> /proc arm).
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob — no run.sh edit.
// Zero tokens; confined to torture-test/; the live 33xx daemon is never
// touched (the spawned process is a short-lived `node -e` idle under a temp
// PID file, killed by exact PID in finally).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const daemonUpTool = path.join(ttRoot, "bin", "tt-daemon-up");
const daemonUpText = fs.readFileSync(daemonUpTool, "utf8");

// ── helpers ────────────────────────────────────────────────────────────

/** Env for every child this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — children operate on loopback + temp dirs only. */
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
 *  apostrophes or quotes that live inside comments. Mirrors the helper in
 *  tier1-tt-daemon-up-portable-probe.test.ts. */
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
 *  function is absent. Mirrors the helper in
 *  tier1-tt-daemon-up-portable-probe.test.ts. */
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

/** Start an idle background `node` process with a specific env; resolve with
 *  its PID (which the test writes into a temp tamandua.pid). */
function startIdleNode(env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], {
      env,
      stdio: "ignore",
      detached: false,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      assert.ok(child.pid, "spawned idle node must have a PID");
      // Detach from this test's exit handling so we control the kill.
      child.unref();
      resolve(child.pid!);
    });
  });
}

/** Kill an exact PID (spawned by this test), ignoring ESRCH. */
function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Run the REAL daemon_pid + daemon_path_has_adapters_bin functions (extracted
 *  from tt-daemon-up) with TT_ENV_REAL/ADAPTERS_BIN_DIR pointed at temp paths.
 *  Returns the child result (stdout carries HAS_BIN or LACKS_BIN). */
function runAdaptorsCheck(
  tempEnvScript: string,
  adaptersBin: string,
): CmdResult {
  const daemonPidFn = extractFunction(daemonUpText, "daemon_pid");
  const hasBinFn = extractFunction(daemonUpText, "daemon_path_has_adapters_bin");
  assert.ok(daemonPidFn, "daemon_pid() must be extractable from tt-daemon-up");
  assert.ok(hasBinFn, "daemon_path_has_adapters_bin() must be extractable from tt-daemon-up");

  const script = path.join(
    os.tmpdir(),
    `tt-du-adapters-${process.pid}-${Math.random().toString(36).slice(2)}.sh`,
  );
  try {
    fs.writeFileSync(
      script,
      [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        `TT_ENV_REAL="${tempEnvScript}"`,
        `ADAPTERS_BIN_DIR="${adaptersBin}"`,
        daemonPidFn,
        hasBinFn,
        'if daemon_path_has_adapters_bin; then echo HAS_BIN; exit 0; else echo LACKS_BIN; exit 1; fi',
        "",
      ].join("\n"),
    );
    return run(["bash", script], { timeoutMs: 30_000 });
  } finally {
    fs.rmSync(script, { force: true });
  }
}

// ── the guard ──────────────────────────────────────────────────────────

describe("US-007 — tt-daemon-up adapters-bin PATH check is portable", () => {
  it("structural: daemon_path_has_adapters_bin has BOTH a Darwin ps-eww arm and a linux /proc arm", () => {
    const fn = extractFunction(daemonUpText, "daemon_path_has_adapters_bin");
    assert.ok(fn, "daemon_path_has_adapters_bin() must exist");

    // Darwin arm: BSD ps reads the process environment without procfs.
    assert.match(fn, /ps\s+eww\s+-p\s+"\$pid"/, "Darwin arm must use `ps eww -p \"$pid\"`");
    // linux arm: the retained procfs read. The MACP3 US-003 marker lives in
    // the adjacent COMMENT (masked out of the extracted body), so pin it on
    // the raw file text instead — the procfs lint requires it there.
    assert.match(fn, /\/proc\/\$pid\/environ/, "linux arm must read /proc/$pid/environ");
    assert.match(daemonUpText, /MACP3 US-003/, "tt-daemon-up must keep the MACP3 US-003 marker (procfs lint)");
    // Platform dispatch must prefer ps-eww on Darwin and procfs otherwise.
    assert.match(fn, /\bDarwin\b/, "function must dispatch on the Darwin platform");
  });

  it("behavioral: a live process with the sentinel dir on PATH is reported HAS_BIN (return 0)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-du-adapters-pos-"));
    const stateDir = path.join(tmp, "state");
    const adaptersBin = path.join(tmp, "adapters-bin");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(adaptersBin, { recursive: true });

    const envScript = path.join(tmp, "env.sh");
    fs.writeFileSync(
      envScript,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "print" ]; then printf "TAMANDUA_STATE_DIR=%s\\n" "' + stateDir + '"; fi\n',
    );
    fs.chmodSync(envScript, 0o755);

    let pid: number | null = null;
    try {
      // The process PATH carries the sentinel adapters-bin dir FIRST.
      const processEnv = cleanEnv({ PATH: `${adaptersBin}:${process.env.PATH ?? ""}` });
      pid = await startIdleNode(processEnv);
      fs.writeFileSync(path.join(stateDir, "tamandua.pid"), `${pid}\n`);

      const res = runAdaptorsCheck(envScript, adaptersBin);
      assert.equal(res.status, 0, `positive arm should exit 0 (HAS_BIN). stderr: ${res.stderr}`);
      assert.match(res.stdout, /HAS_BIN/, `positive arm should report HAS_BIN. stdout: ${res.stdout}`);
    } finally {
      if (pid !== null) killPid(pid);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("behavioral: a live process WITHOUT the sentinel dir on PATH is reported LACKS_BIN (return 1)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tt-du-adapters-neg-"));
    const stateDir = path.join(tmp, "state");
    const adaptersBin = path.join(tmp, "adapters-bin");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(adaptersBin, { recursive: true });

    const envScript = path.join(tmp, "env.sh");
    fs.writeFileSync(
      envScript,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "print" ]; then printf "TAMANDUA_STATE_DIR=%s\\n" "' + stateDir + '"; fi\n',
    );
    fs.chmodSync(envScript, 0o755);

    let pid: number | null = null;
    try {
      // The process PATH does NOT carry the sentinel dir (adaptersBin is a
      // fresh temp dir, so process.env.PATH cannot contain it).
      const processEnv = cleanEnv({ PATH: process.env.PATH ?? "" });
      pid = await startIdleNode(processEnv);
      fs.writeFileSync(path.join(stateDir, "tamandua.pid"), `${pid}\n`);

      const res = runAdaptorsCheck(envScript, adaptersBin);
      assert.equal(res.status, 1, `negative arm should exit 1 (LACKS_BIN). stderr: ${res.stderr}`);
      assert.match(res.stdout, /LACKS_BIN/, `negative arm should report LACKS_BIN. stdout: ${res.stdout}`);
    } finally {
      if (pid !== null) killPid(pid);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
