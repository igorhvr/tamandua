// MACP4 US-002 — daemon-control + tt-process-identity Darwin-capable
// process identity/ownership and operator-home resolution (regression
// guard).
//
// Darwin defects (audited): (1) tt-process-identity getProcessStartIdentity
// returned null on non-linux, so verify_recorded_identity refused EVERY
// signal on the mac (the W2 daemon stop/escalation corridors could never
// pass); (2) daemon-control verify_process_tt_owned read /proc cwd+cmdline
// only, so stop_cli_auto_daemon (the W2.21 CLI-auto-daemon restart
// corridor) refused to stop an unverifiable daemon on Darwin; (3)
// _tt_operator_home fell back from getent straight to $HOME, so on Darwin
// REAL_TAMANDUA_STATE and the S24 operator-bin reorder could be derived
// from a contained/wrong home.
//
// Fixes under pin: a mechanical Darwin identity source (`ps -p <pid>
// -o lstart=` — BSD and procps both support it) behind the
// TT_PROCESS_IDENTITY_PLATFORM / TT_PROCESS_IDENTITY_PS seams; a Darwin
// TT-ownership branch in verify_process_tt_owned using PORTABLE evidence
// (`lsof -a -p <pid> -d cwd -Fn` for the cwd, `ps -p <pid> -o command=`
// for the cmdline) behind the TT_DC_PLATFORM seam; and the
// resolve_operator_home getent -> dscl -> shell-tilde -> $HOME chain.
//
// Everything below is hermetic: no daemon starts, no TT ports touched,
// nothing written under torture-test/. Darwin is SIMULATED on linux via
// the injectable platform/PATH seams (the MACP3 exclusive-create pattern:
// a modeled /proc-less host is the seam, and the pre-fix arms fail the
// same assertions that the real mac failed). The /proc literals here are
// linux-only documentation/assertion prose (MACP3 US-004 harness
// convention) — the reads being pinned live inside the guarded tools.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded battery
// — no run.sh edit). Zero tokens; confined to torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  getDarwinStartIdentity,
  getProcessStartIdentity,
} from "../bin/tt-process-identity.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const dcTool = path.join(ttRoot, "bin", "daemon-control");
const identityTool = path.join(ttRoot, "bin", "tt-process-identity.mjs");
const dcText = fs.readFileSync(dcTool, "utf8");
const identityText = fs.readFileSync(identityTool, "utf8");

// ── helpers ────────────────────────────────────────────────────────────

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the extracted snippets operate on temp dirs only. */
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

/** Run extracted bash functions in a temp file (with a prologue) and
 *  return the result. `prologue` runs BEFORE the function definitions
 *  (e.g. TT_REPO_ROOT setup); `invocation` runs after them. */
function runExtracted(
  fnTexts: string[],
  prologue: string,
  invocation: string,
  env?: NodeJS.ProcessEnv,
): CmdResult {
  const fnFile = path.join(os.tmpdir(), `dc-darwin-fn-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  try {
    fs.writeFileSync(
      fnFile,
      `#!/usr/bin/env bash\nset -euo pipefail\n${prologue}\n${fnTexts.join("\n")}\n${invocation}\n`,
    );
    return run(["bash", fnFile], { env, timeoutMs: 30_000 });
  } finally {
    fs.rmSync(fnFile, { force: true });
  }
}

/** Create a temp bin dir with a shim named `name` that runs `body`; returns
 *  the dir (caller removes it). The shim is executable. */
function makeShim(dir: string, name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

const DARWIN_LSTART = "Sun Aug 23 18:20:05 2026";

// ── the guard ──────────────────────────────────────────────────────────

describe("MACP4 US-002 — daemon-control + tt-process-identity Darwin identity/ownership + operator home", () => {
  // ── 1. tt-process-identity Darwin identity source ────────────────────

  it("tt-process-identity.mjs carries the mechanical Darwin identity source (ps -o lstart=) behind an injectable platform seam (structural)", () => {
    assert.match(
      identityText,
      /getDarwinStartIdentity/,
      "tt-process-identity.mjs must define the Darwin identity source",
    );
    assert.match(
      identityText,
      /-o lstart=/,
      "the Darwin identity source must use `ps -p <pid> -o lstart=` (BSD + procps portable)",
    );
    assert.match(
      identityText,
      /darwin:/,
      "the Darwin identity must be namespaced 'darwin:<lstart>' (distinct from the linux 'proc:<starttime>')",
    );
    assert.match(
      identityText,
      /TT_PROCESS_IDENTITY_PLATFORM/,
      "getProcessStartIdentity must honor the TT_PROCESS_IDENTITY_PLATFORM seam (hermetic Darwin simulation)",
    );
    // The linux /proc path is untouched: proc:<starttime> stays the linux
    // identity source (MACP4 US-002 does not weaken it).
    assert.match(
      identityText,
      /proc:\$\{stat\.starttime\}/,
      "the linux identity must still be proc:<starttime> (unchanged)",
    );
  });

  it("getProcessStartIdentity returns a mechanical darwin:<lstart> identity on the /proc-less simulation and null for an unverifiable pid", () => {
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "tti-darwin-ps-"));
    try {
      const okPs = makeShim(shimDir, "ps", `printf '%s\\n' "${DARWIN_LSTART}"`);
      const deadPs = makeShim(shimDir, "ps-dead", "exit 1");

      const envOk = cleanEnv({
        TT_PROCESS_IDENTITY_PLATFORM: "darwin",
        TT_PROCESS_IDENTITY_PS: okPs,
      });
      const envDead = cleanEnv({
        TT_PROCESS_IDENTITY_PLATFORM: "darwin",
        TT_PROCESS_IDENTITY_PS: deadPs,
      });

      const prevPlatform = process.env.TT_PROCESS_IDENTITY_PLATFORM;
      const prevPs = process.env.TT_PROCESS_IDENTITY_PS;
      try {
        process.env.TT_PROCESS_IDENTITY_PLATFORM = "darwin";
        process.env.TT_PROCESS_IDENTITY_PS = okPs;
        const identity = getProcessStartIdentity(process.pid);
        assert.equal(identity, `darwin:${DARWIN_LSTART}`, "live pid must yield the mechanical darwin identity");
        assert.equal(getProcessStartIdentity(process.pid), identity, "darwin identity must be stable (ABA check relies on determinism)");

        process.env.TT_PROCESS_IDENTITY_PS = deadPs;
        assert.equal(
          getProcessStartIdentity(process.pid),
          null,
          "an unreadable pid must yield null -> every E3.C.1 caller REFUSES to signal (never signals on weak evidence)",
        );
        assert.equal(getDarwinStartIdentity(Number.MAX_SAFE_INTEGER), null, "invalid pid must be null");
      } finally {
        if (prevPlatform === undefined) delete process.env.TT_PROCESS_IDENTITY_PLATFORM;
        else process.env.TT_PROCESS_IDENTITY_PLATFORM = prevPlatform;
        if (prevPs === undefined) delete process.env.TT_PROCESS_IDENTITY_PS;
        else process.env.TT_PROCESS_IDENTITY_PS = prevPs;
      }

      // CLI contract: --get prints the darwin identity (exit 0) and exits 1
      // for an unreadable pid — the daemon-control identity gate consumes it.
      const got = run(["node", identityTool, "--get", String(process.pid)], { env: envOk });
      assert.equal(got.status, 0, got.stderr);
      assert.equal(got.stdout.trim(), `darwin:${DARWIN_LSTART}`);

      const dead = run(["node", identityTool, "--get", String(process.pid)], { env: envDead });
      assert.equal(dead.status, 1, "unreadable pid must refuse (exit 1)");
      assert.match(dead.stderr, /not alive|unreadable/i);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  // ── 2. verify_process_tt_owned Darwin branch ─────────────────────────

  it("verify_process_tt_owned carries the portable Darwin evidence branch and keeps the /proc linux path (structural)", () => {
    const fn = extractFunction(dcText, "verify_process_tt_owned");
    assert.ok(fn, "daemon-control must define verify_process_tt_owned()");
    assert.match(
      fn,
      /TT_DC_PLATFORM/,
      "verify_process_tt_owned must honor the TT_DC_PLATFORM seam (hermetic Darwin simulation)",
    );
    assert.match(
      fn,
      /lsof -a -p "\$pid" -d cwd -Fn/,
      "the Darwin branch must use lsof -a -p <pid> -d cwd -Fn for the cwd (portable)",
    );
    assert.match(
      fn,
      /ps -p "\$pid" -o command=/,
      "the Darwin branch must use ps -p <pid> -o command= for the cmdline (portable)",
    );
    // The linux /proc evidence is unchanged (MACP3 US-003 / MACP4 US-002
    // does not weaken it).
    assert.match(fn, /\/proc\/\$pid\/cwd/, "the linux branch must keep the /proc/$pid/cwd read");
    assert.match(fn, /\/proc\/\$pid\/cmdline/, "the linux branch must keep the /proc/$pid/cmdline read");
    assert.match(fn, /return 1  # cannot verify — refuse/, "unavailable evidence must still refuse (fail-closed)");
  });

  it("verify_process_tt_owned proves TT-ownership via the portable Darwin branch and REFUSES when evidence is unavailable", () => {
    const fn = extractFunction(dcText, "verify_process_tt_owned");
    assert.ok(fn, "verify_process_tt_owned must exist");
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-darwin-own-"));
    try {
      const lsof = makeShim(shimDir, "lsof", `if [ -n "\${TT_FAKE_LSOF_CWD:-}" ]; then printf 'p%s\\nn%s\\n' "$$" "\$TT_FAKE_LSOF_CWD"; exit 0; fi\nexit 1`);
      const ps = makeShim(shimDir, "ps", `if [ -n "\${TT_FAKE_PS_CMDLINE:-}" ]; then printf '%s\\n' "\$TT_FAKE_PS_CMDLINE"; exit 0; fi\nexit 1`);

      const ttRootPath = path.join(repoRoot, "torture-test");
      const baseEnv = cleanEnv({
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        TT_DC_PLATFORM: "Darwin",
      });
      const prologue = `TT_REPO_ROOT="${repoRoot}"`;

      const runOwned = (env: NodeJS.ProcessEnv): CmdResult =>
        runExtracted(
          [fn],
          prologue,
          `if verify_process_tt_owned 12345 /ignored; then echo "rc=0"; else echo "rc=$?"; fi`,
          env,
        );

      // Positive: cwd under TT_REPO_ROOT + cmdline containing tamandua.
      const ok = runOwned(
        cleanEnv({ ...baseEnv, TT_FAKE_LSOF_CWD: ttRootPath, TT_FAKE_PS_CMDLINE: "node /usr/bin/tamandua daemon start" }),
      );
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /rc=0/, `Darwin TT-owned evidence must prove ownership. stdout: ${ok.stdout}`);

      // Fail-closed: lsof unavailable (no cwd evidence) -> refuse.
      const noLsof = runOwned(cleanEnv({ ...baseEnv, TT_FAKE_PS_CMDLINE: "node /usr/bin/tamandua daemon start" }));
      assert.match(noLsof.stdout, /rc=1/, `unavailable cwd evidence must refuse. stdout: ${noLsof.stdout}`);

      // Fail-closed: cwd outside TT_REPO_ROOT -> refuse.
      const foreignCwd = runOwned(
        cleanEnv({ ...baseEnv, TT_FAKE_LSOF_CWD: "/etc", TT_FAKE_PS_CMDLINE: "node /usr/bin/tamandua daemon start" }),
      );
      assert.match(foreignCwd.stdout, /rc=1/, `a foreign cwd must refuse. stdout: ${foreignCwd.stdout}`);

      // Fail-closed: cmdline without tamandua -> refuse.
      const noTamandua = runOwned(
        cleanEnv({ ...baseEnv, TT_FAKE_LSOF_CWD: ttRootPath, TT_FAKE_PS_CMDLINE: "node /usr/bin/server.js" }),
      );
      assert.match(noTamandua.stdout, /rc=1/, `a non-tamandua cmdline must refuse. stdout: ${noTamandua.stdout}`);

      // Fail-closed: ps unavailable (no cmdline evidence) -> refuse.
      const noPs = runOwned(cleanEnv({ ...baseEnv, TT_FAKE_LSOF_CWD: ttRootPath }));
      assert.match(noPs.stdout, /rc=1/, `unavailable cmdline evidence must refuse. stdout: ${noPs.stdout}`);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  // ── 3. resolve_operator_home fallback chain ──────────────────────────

  it("daemon-control resolves the operator home via the getent -> dscl -> shell-tilde -> $HOME chain (structural)", () => {
    assert.match(dcText, /^resolve_operator_home\(\)/m, "daemon-control must define resolve_operator_home()");
    assert.match(dcText, /getent passwd/, "chain step 1 must be getent passwd (linux passwd db)");
    assert.match(dcText, /dscl \. -read/, "chain step 2 must be dscl . -read (macOS NFSHomeDirectory)");
    assert.match(dcText, /eval echo ~/, "chain step 3 must be the shell tilde expansion (eval echo ~<user>)");
    assert.match(dcText, /_tt_operator_home="\$\(resolve_operator_home\)"/, "_tt_operator_home must come from resolve_operator_home");
    assert.match(dcText, /REAL_TAMANDUA_STATE="\$\{_tt_operator_home:-\$\{HOME\}\}\/\.tamandua"/, "REAL_TAMANDUA_STATE must derive from _tt_operator_home (true operator home)");
    assert.match(dcText, /operator_bin_dirs/, "operator_bin_dirs must still exist (S24 operator-bin reorder source)");
  });

  it("resolve_operator_home falls back through dscl then shell-tilde then $HOME when getent is absent (PATH seam)", () => {
    const fn = extractFunction(dcText, "resolve_operator_home");
    assert.ok(fn, "resolve_operator_home must exist");

    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-darwin-home-"));
    try {
      // Failing getent: on linux /usr/bin/getent exists, so the seam SHADOWS
      // it with a failing shim (the mac simply has no getent at all). The
      // fake dscl answers NFSHomeDirectory (the macOS step 2).
      makeShim(shimDir, "getent", "exit 1");
      makeShim(shimDir, "dscl", `printf 'NFSHomeDirectory: /Users/fakehome\\n'`);

      const runHome = (env: NodeJS.ProcessEnv): CmdResult =>
        runExtracted([fn], "", `resolve_operator_home; echo`, env);

      // Step 1 (getent): normal PATH — returns the real passwd home.
      const getentHome = runHome(cleanEnv());
      assert.equal(getentHome.status, 0, getentHome.stderr);
      assert.match(getentHome.stdout.trim(), /^\//, `getent must yield an absolute operator home: ${getentHome.stdout}`);

      // Step 2 (dscl): getent absent -> dscl NFSHomeDirectory.
      const dsclHome = runHome(
        cleanEnv({
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
          // getent shim fails; dscl shim prints the NFS home.
        }),
      );
      // NOTE: fakeDscl is on PATH — but so is failGetent; the getent shim
      // exits 1 so the chain proceeds to dscl.
      assert.equal(dsclHome.stdout.trim(), "/Users/fakehome", `dscl must resolve the macOS home. stdout: ${dsclHome.stdout}`);

      // Step 3 (shell tilde): getent AND dscl absent -> eval echo ~<user>
      // (real id, real user) must resolve the same real home — a contained/
      // wrong $HOME must be IGNORED by the tilde step.
      const tildeDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-darwin-tilde-"));
      try {
        const failGetent2 = makeShim(tildeDir, "getent", "exit 1");
        const failDscl2 = makeShim(tildeDir, "dscl", "exit 1");
        const tilde = runHome(
          cleanEnv({
            PATH: `${tildeDir}:${process.env.PATH ?? ""}`,
            HOME: "/tmp/contained-home",
          }),
        );
        assert.equal(tilde.status, 0, tilde.stderr);
        assert.match(tilde.stdout.trim(), /^\//, `shell tilde must yield an absolute home: ${tilde.stdout}`);
        assert.notEqual(tilde.stdout.trim(), "/tmp/contained-home", "the tilde step must ignore a contained/wrong $HOME");
        // It is the SAME real operator home the getent step resolved.
        assert.equal(tilde.stdout.trim(), getentHome.stdout.trim(), "tilde expansion must equal the passwd home");
      } finally {
        fs.rmSync(tildeDir, { recursive: true, force: true });
      }

      // Step 4 ($HOME): getent/dscl absent AND an unknown user (tilde stays
      // literal) -> $HOME last resort.
      const fallbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-darwin-fb-"));
      try {
        makeShim(fallbackDir, "getent", "exit 1");
        makeShim(fallbackDir, "dscl", "exit 1");
        makeShim(fallbackDir, "id", `if [ "$1" = "-un" ]; then printf 'nosuchuser999\\n'; else printf '99999\\n'; fi`);
        const fb = runHome(
          cleanEnv({
            PATH: `${fallbackDir}:${process.env.PATH ?? ""}`,
            HOME: "/contained/fallback-home",
          }),
        );
        assert.equal(fb.stdout.trim(), "/contained/fallback-home", `$HOME must be the last-resort home. stdout: ${fb.stdout}`);
      } finally {
        fs.rmSync(fallbackDir, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("REAL_TAMANDUA_STATE names the TRUE operator home when getent is absent (dscl arm drives the production-guard source)", () => {
    // The production guard (is_production_cwd) and the S24 operator-bin
    // reorder both derive from REAL_TAMANDUA_STATE/_tt_operator_home. On
    // Darwin with getent absent the dscl arm must supply the operator home,
    // so the guard compares against the REAL ~/.tamandua — never the
    // contained home.
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-darwin-guard-"));
    try {
      makeShim(shimDir, "getent", "exit 1");
      makeShim(shimDir, "dscl", `printf 'NFSHomeDirectory: /Users/macuser\\n'`);
      const env = cleanEnv({
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        HOME: "/var/home-scripted", // the CONTAINED spawn home — must NOT win
      });
      const res = runExtracted(
        [extractFunction(dcText, "resolve_operator_home") ?? ""],
        "",
        `_tt_operator_home="$(resolve_operator_home)"; printf '%s\\n' "\${_tt_operator_home}/.tamandua"`,
        env,
      );
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout.trim(), "/Users/macuser/.tamandua", "REAL_TAMANDUA_STATE must name the true operator home on Darwin (never the contained home)");
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
