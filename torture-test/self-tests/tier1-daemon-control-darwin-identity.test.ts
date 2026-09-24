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

// ── MACP5 US-001 — daemon-control identity-verified REAL-daemon pid
//    recording on the fallback path + portable status verification.
//
// The real-Darwin W2 run exposed a FATAL recording defect: the
// plain-background (no-systemd) fallback start recorded a DEAD WRAPPER pid
// in provenance ("daemon PID 88430" whose process was NOT alive afterwards,
// while ports 5334/5338/5339 were LISTENING) — on Darwin the
// nohup/background chain double-forks, so the state-dir tamandua.pid can
// name a wrapper that exits while the real daemon lives. The status
// verifier failing closed ("pid alive: false ... STATUS: UNKNOWN") was
// CORRECT — the fix records the REAL daemon pid, identity-verified BEFORE
// writing provenance, and makes cmd_status portable for /proc-less hosts
// (kill -0 liveness + the ps cmdline arm behind TT_DC_PLATFORM) so a
// correctly-recorded live daemon CAN report RUNNING on Darwin.
//
// Everything below is hermetic: no daemon starts, no TT ports touched,
// nothing written under torture-test/. Darwin is SIMULATED via the
// injectable TT_DC_PLATFORM seam and the node/lsof/ps PATH shims. The
// /proc literals here are linux-only documentation/assertion prose (MACP3
// US-004 harness convention).
describe("MACP5 US-001 — daemon-control identity-verified fallback pid recording + portable status", () => {
  // ── 1. cmd_start pid acceptance: the triple gate ─────────────────────

  it("cmd_start accepts a tamandua.pid candidate only via the triple gate (alive + identity + TT-owned) and fails closed on deadline expiry (structural)", () => {
    const cs = extractFunction(dcText, "cmd_start");
    assert.ok(cs, "cmd_start must exist");
    // The pidfile candidate acceptance (both the reuse detection and the
    // pid-wait) must go through verify_launched_daemon_pid — never a bare
    // kill -0 acceptance.
    assert.match(
      cs,
      /verify_launched_daemon_pid/,
      "cmd_start must gate every tamandua.pid candidate with verify_launched_daemon_pid",
    );
    // The helper itself enforces the three gates in order.
    const helper = extractFunction(dcText, "verify_launched_daemon_pid");
    assert.ok(helper, "verify_launched_daemon_pid must exist");
    assert.match(helper, /kill -0/, "gate (a): the candidate must be alive (kill -0)");
    assert.match(
      helper,
      /IDENTITY_TOOL" --get/,
      "gate (b): the candidate must have a readable process-start identity (tt-process-identity --get)",
    );
    assert.match(
      helper,
      /verify_process_tt_owned/,
      "gate (c): the candidate must be proven TT-owned (verify_process_tt_owned)",
    );
    // Deadline expiry without a verified pid FAILS CLOSED (exit 1, no
    // provenance) with a diagnostic naming the unverifiable-wrapper class.
    assert.match(
      cs,
      /no identity-verified daemon pid appeared/,
      "deadline expiry must fail closed with a diagnostic covering the unverifiable-wrapper class",
    );
    assert.match(cs, /exit 1/, "the deadline-expiry failure path must exit non-zero");
  });

  it("write_provenance refuses an empty startTime identity and cmd_start fails closed instead of WARNING-and-continue (structural)", () => {
    // NOTE: extractFunction's quote-aware brace scanner cannot extract
    // write_provenance (the ports_json line's `printf '"%s",'` gymnastics
    // defeat its quote state machine), so this pin slices the function
    // region directly from the source — bounded well before the next
    // function definition.
    const wpStart = dcText.indexOf("write_provenance() {");
    assert.ok(wpStart >= 0, "write_provenance must exist");
    const wpRegion = dcText.slice(wpStart, wpStart + 3000);
    assert.match(
      wpRegion,
      /empty startTime identity/,
      "write_provenance must explicitly refuse an empty startTime identity",
    );
    assert.match(wpRegion, /exit 1/, "write_provenance must exit non-zero on an empty identity (no provenance written)");
    const cs = extractFunction(dcText, "cmd_start");
    assert.ok(cs, "cmd_start must exist");
    assert.doesNotMatch(
      cs,
      /WARNING — could not read startTime identity/,
      "the old WARNING-and-continue identity recording must be gone",
    );
    assert.match(
      cs,
      /FATAL — cannot read startTime identity/,
      "cmd_start must fail closed when the identity read fails at record time",
    );
  });

  // ── 2. cmd_status portability (kill -0 + TT_DC_PLATFORM ps arm) ──────

  it("cmd_status liveness is portable kill -0 (no /proc dir requirement) and the cmdline check rides the TT_DC_PLATFORM seam (structural)", () => {
    const cs = extractFunction(dcText, "cmd_status");
    assert.ok(cs, "cmd_status must exist");
    assert.match(cs, /kill -0 "\$prov_pid"/, "liveness must be a portable kill -0 probe");
    assert.doesNotMatch(
      cs,
      /\[ -d "\/proc\/\$prov_pid" \]/,
      "the linux-only [ -d /proc/<pid> ] liveness requirement must be dropped (Darwin has no procfs)",
    );
    assert.match(
      cs,
      /TT_DC_PLATFORM/,
      "cmd_status must honor the TT_DC_PLATFORM seam (hermetic Darwin simulation)",
    );
    assert.match(
      cs,
      /ps -p "\$prov_pid" -o command=/,
      "the Darwin arm must read the cmdline via the portable `ps -p <pid> -o command=`",
    );
    assert.match(
      cs,
      /\/proc\/\$prov_pid\/cmdline/,
      "the linux arm must retain the /proc/<pid>/cmdline read (linux-only, MACP5-marked)",
    );
    // Fail-closed unchanged: RUNNING requires cmdline_ok AND ports_active.
    assert.match(cs, /STATUS: RUNNING/, "cmd_status must still report RUNNING");
    assert.match(cs, /STATUS: UNKNOWN/, "cmd_status must still report UNKNOWN");
  });

  it("verify_launched_daemon_pid refuses a dead / unverifiable / non-TT-owned candidate and accepts a live identity-verified TT-owned one (behavioral)", () => {
    const helper = extractFunction(dcText, "verify_launched_daemon_pid");
    const ttOwned = extractFunction(dcText, "verify_process_tt_owned");
    assert.ok(helper, "verify_launched_daemon_pid must exist");
    assert.ok(ttOwned, "verify_process_tt_owned must exist");

    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-macp5-gate-"));
    try {
      // node shim for the identity tool (`node <tool> --get <pid>`): prints
      // TT_FAKE_IDENTITY for a live pid, refuses otherwise.
      makeShim(
        shimDir,
        "node",
        `if [ "$2" = "--get" ]; then pid="$3"; if kill -0 "$pid" 2>/dev/null && [ -n "\${TT_FAKE_IDENTITY:-}" ]; then echo "$TT_FAKE_IDENTITY"; exit 0; fi; echo "not alive or identity unreadable" >&2; exit 1; fi; exit 0`,
      );
      // lsof/ps shims for the Darwin TT-ownership evidence branch.
      makeShim(shimDir, "lsof", `if [ -n "\${TT_FAKE_LSOF_CWD:-}" ]; then printf 'p%s\\nn%s\\n' "$$" "\$TT_FAKE_LSOF_CWD"; exit 0; fi\nexit 1`);
      makeShim(shimDir, "ps", `if [ -n "\${TT_FAKE_PS_CMDLINE:-}" ]; then printf '%s\\n' "\$TT_FAKE_PS_CMDLINE"; exit 0; fi\nexit 1`);

      const baseEnv = cleanEnv({
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        TT_DC_PLATFORM: "Darwin",
        IDENTITY_TOOL: "/tmp/fake-identity.mjs", // resolved by the node shim on PATH
      });
      const prologue = `TT_REPO_ROOT="${repoRoot}"`;

      const runGate = (env: NodeJS.ProcessEnv): CmdResult =>
        runExtracted(
          [ttOwned, helper],
          prologue,
          `if verify_launched_daemon_pid "$$" /ignored; then echo "rc=0"; else echo "rc=$?"; fi`,
          env,
        );
      const runGateDead = (env: NodeJS.ProcessEnv): CmdResult =>
        runExtracted(
          [ttOwned, helper],
          prologue,
          `bash -c 'exit 0' & dead=$!; wait "$dead" 2>/dev/null || true; if verify_launched_daemon_pid "$dead" /ignored; then echo "rc=0"; else echo "rc=$?"; fi`,
          env,
        );

      // (a) A DEAD pid (reaped child) must be refused — the Darwin wrapper
      //     pid that exits while the real daemon lives.
      const dead = runGateDead(
        cleanEnv({ ...baseEnv, TT_FAKE_IDENTITY: "proc:1", TT_FAKE_LSOF_CWD: ttRoot, TT_FAKE_PS_CMDLINE: "node /usr/bin/tamandua daemon start" }),
      );
      assert.equal(dead.status, 0, dead.stderr);
      assert.match(dead.stdout, /rc=1/, `a dead candidate must be refused. stdout: ${dead.stdout}`);

      // (b) Alive but identity UNREADABLE -> refused (gate b).
      const noIdent = runGate(
        cleanEnv({ ...baseEnv, TT_FAKE_LSOF_CWD: ttRoot, TT_FAKE_PS_CMDLINE: "node /usr/bin/tamandua daemon start" }),
      );
      assert.match(noIdent.stdout, /rc=1/, `an identity-unreadable candidate must be refused. stdout: ${noIdent.stdout}`);

      // (c) Alive + identity but FOREIGN cwd -> refused (gate c).
      const foreignCwd = runGate(
        cleanEnv({ ...baseEnv, TT_FAKE_IDENTITY: "proc:1", TT_FAKE_LSOF_CWD: "/etc", TT_FAKE_PS_CMDLINE: "node /usr/bin/tamandua daemon start" }),
      );
      assert.match(foreignCwd.stdout, /rc=1/, `a foreign-cwd candidate must be refused. stdout: ${foreignCwd.stdout}`);

      // (c') Alive + identity + TT cwd but NON-tamandua cmdline -> refused (gate c).
      const noTamandua = runGate(
        cleanEnv({ ...baseEnv, TT_FAKE_IDENTITY: "proc:1", TT_FAKE_LSOF_CWD: ttRoot, TT_FAKE_PS_CMDLINE: "node /usr/bin/server.js" }),
      );
      assert.match(noTamandua.stdout, /rc=1/, `a non-tamandua cmdline candidate must be refused. stdout: ${noTamandua.stdout}`);

      // (d) Alive + identity + TT-owned -> ACCEPTED (the real daemon case).
      const ok = runGate(
        cleanEnv({ ...baseEnv, TT_FAKE_IDENTITY: "proc:1", TT_FAKE_LSOF_CWD: ttRoot, TT_FAKE_PS_CMDLINE: "node /usr/bin/tamandua daemon start" }),
      );
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /rc=0/, `a live identity-verified TT-owned candidate must be accepted. stdout: ${ok.stdout}`);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });

  it("cmd_status reports RUNNING for a live tamandua daemon and UNKNOWN for a dead pid / non-tamandua cmdline / unverifiable cmdline under the Darwin simulation (behavioral)", () => {
    const statusFn = extractFunction(dcText, "cmd_status");
    assert.ok(statusFn, "cmd_status must exist");
    const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-macp5-status-"));
    try {
      makeShim(shimDir, "ps", `if [ -n "\${TT_FAKE_PS_FAIL:-}" ]; then exit 1; fi\nprintf '%s\\n' "\${TT_FAKE_PS_CMDLINE:-}"\nexit 0`);
      // Stubs for cmd_status's callees (never production, ports faked via
      // TT_FAKE_LISTENING_PORTS).
      const stubs = `
is_production_port() { return 1; }
refuse_production() { echo "REFUSED: $1" >&2; exit 1; }
is_production_cwd() { return 1; }
is_port_listening() {
  local port="$1"
  local p
  for p in \${TT_FAKE_LISTENING_PORTS:-}; do
    [ "$p" = "$port" ] && return 0
  done
  return 1
}
`;
      const baseEnv = cleanEnv({
        PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        TT_DC_PLATFORM: "Darwin",
      });
      const provDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-macp5-prov-"));
      // The provenance JSON format string (printf %s = the pid) — the inner
      // double quotes are JSON, safe inside the bash single-quoted format.
      const provJson =
        '{"pid": %s, "ports": [5334, 5338, 5339], "startedAt": "2026-08-24T00:00:00Z", "cmdline": "tamandua daemon start", "cwd": "/tmp", "startTime": "proc:1"}';
      // pidArg is emitted into the bash invocation verbatim: "$$" (double-
      // quoted → the extracted script's own live pid) or a literal dead pid.
      const runStatus = (env: NodeJS.ProcessEnv, pidArg: string): CmdResult =>
        runExtracted(
          [statusFn],
          `${stubs}\nPROV_DIR="${provDir}"`,
          `printf '${provJson}' ${pidArg} > "$PROV_DIR/scripted.json"\ncmd_status scripted`,
          env,
        );

      // RUNNING: live pid + tamandua cmdline + a listening port.
      const running = runStatus(
        cleanEnv({ ...baseEnv, TT_FAKE_PS_CMDLINE: "node /usr/bin/tamandua daemon start", TT_FAKE_LISTENING_PORTS: "5334" }),
        `"$$"`,
      );
      assert.equal(running.status, 0, running.stderr);
      assert.match(running.stdout, /STATUS: RUNNING/, `a live tamandua daemon must report RUNNING on the Darwin simulation. stdout: ${running.stdout}`);

      // UNKNOWN: DEAD pid + port listening — never RUNNING on ports alone.
      const dead = runStatus(
        cleanEnv({ ...baseEnv, TT_FAKE_PS_CMDLINE: "node /usr/bin/tamandua daemon start", TT_FAKE_LISTENING_PORTS: "5334" }),
        `'4194191'`,
      );
      assert.equal(dead.status, 0, dead.stderr);
      assert.match(dead.stdout, /STATUS: UNKNOWN/, `a dead pid must be UNKNOWN even with a listening port. stdout: ${dead.stdout}`);

      // UNKNOWN: live pid + NON-tamandua cmdline + port listening.
      const noTamandua = runStatus(
        cleanEnv({ ...baseEnv, TT_FAKE_PS_CMDLINE: "node /usr/bin/server.js", TT_FAKE_LISTENING_PORTS: "5334" }),
        `"$$"`,
      );
      assert.equal(noTamandua.status, 0, noTamandua.stderr);
      assert.match(noTamandua.stdout, /STATUS: UNKNOWN/, `a non-tamandua cmdline must be UNKNOWN (fail-closed unchanged). stdout: ${noTamandua.stdout}`);

      // UNKNOWN: live pid + UNVERIFIABLE cmdline (ps fails) + port listening.
      const unverifiable = runStatus(
        cleanEnv({ ...baseEnv, TT_FAKE_PS_FAIL: "1", TT_FAKE_LISTENING_PORTS: "5334" }),
        `"$$"`,
      );
      assert.equal(unverifiable.status, 0, unverifiable.stderr);
      assert.match(unverifiable.stdout, /STATUS: UNKNOWN/, `an unverifiable cmdline must be UNKNOWN (never RUNNING on weak evidence). stdout: ${unverifiable.stdout}`);
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
  });
});
