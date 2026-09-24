// Tier-2 STORM-REHEARSAL US-002 (S1 delivery) — the campaign daemon env.
//
// Run #56 Split-Brain/port defect: `materializeRehearsalDaemon` rendered the
// campaign's private `daemon.env.sh` and recorded `state.daemon_ports`, but
// `execCtxFor` ignored `bopts.daemonEnv` and `makeRealProc`'s daemonControl
// channel passed NO per-call env. daemon-control therefore booted under the
// default `var/home-scripted` on the fixed production ports 5334/5338/5339
// instead of the private HOME/STATE/DB and the bind0-allocated ports — a
// split-brain daemon DB vs client DB even after the S2 schema fix.
//
// This file is the ONE focused torture self-test for the S1 delivery fix:
//   E1  makeRealProc({ daemonEnv }) delivers TT_DC_ENV_SCRIPTED +
//       TT_FORCE_NO_SYSTEMD on every daemonControl dispatch (start/status/
//       stop) while the private HOME/STATE/DB/guard stay intact, no parent
//       authority leaks, and mergeParentEnv stays false;
//   E2  the rehearsal daemon-control handle (`makeRehearsalDaemonControl`)
//       drives canonical argv through the recording double and observes the
//       campaign env; protected per-call overrides still refuse TT_EXEC_ESCAPE,
//       an unknown binary still refuses TT_UNKNOWN_BINARY, and a BOUND
//       daemonEnv can never smuggle a protected key;
//   E3  renderRehearsalDaemonEnvScript pins `export TAMANDUA_DB_PATH=<campaign
//       DB>` when dbPath is supplied (and the shell `print` contract exposes
//       it), omits the export when dbPath is null (backwards compatible), and
//       the printed env is byte-for-byte the campaign's private DB;
//   E4  structural wiring: realCtx binds bopts.daemonEnv into makeRealProc and
//       BOTH the rehearse and run paths thread daemonRes.daemonEnv through
//       realCtx; materializeRehearsalDaemon passes execCtx.db_path.
//   E5  (US-002 fix-2, S5/S8) renderRehearsalDaemonEnvScript ALSO emits
//       TAMANDUA_SCRIPTED_BEHAVIORS / TAMANDUA_SCRIPTED_STATE /
//       TAMANDUA_MAX_ACTIVE_TIMERS and lists them in the `print` contract, and
//       omits all three (byte-for-byte legacy semantics) when not supplied;
//   E6  parseRehearsalDaemonEnvScript round-trips the export contract;
//   E7  the REAL frozen scripted-pi + scripted-hermes boot ONCE each with the
//       materialized env and answer the harness probe prompt with a non-empty,
//       non-crashing reply (exit 0);
//   E8  every `process.env.X` read in torture-test/scripted-runtimes/*.mjs is
//       emitted by the materialized env script or documented as
//       daemon/worker-provided (TAMANDUA_WORKER_JOB_ID).
//   E9  (US-002 NPF-2) rehearsalDaemonPathExtra(repoRoot) puts <repo>/bin on
//       the rendered daemon PATH (real campaign renderer + all four e2e harness
//       builders), so the contained scripted worker can resolve and execute the
//       bare `tamandua-test` the shim-wrapped TEST_CMD invokes.
//
// Everything runs under test-owned scratch dirs (removed in finally). No
// daemon/harness/workflow is ever spawned: the spawn boundary is an injected
// recording double (E1/E2/E4); E7 deliberately execs the frozen zero-model
// scripted probe runtimes only.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  TT_EXEC_ESCAPE,
  TT_UNKNOWN_BINARY,
  buildPrivateExecContext,
  makeRealProc,
} from "../bin/tt-storm-real.mjs";
import {
  REHEARSAL_DAEMON_KIND,
  REHEARSAL_DAEMON_PROVIDED_ENV_VARS,
  REHEARSAL_SCRIPTED_RUNTIME_ENV_VARS,
  daemonControlArgv,
  makeRehearsalDaemonControl,
  parseRehearsalDaemonEnvScript,
  rehearsalDaemonPathExtra,
  renderRehearsalDaemonEnvScript,
} from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const DC_BIN = path.join(repoRoot, "torture-test", "bin", "daemon-control");
const TT_STORM_SRC = path.join(repoRoot, "torture-test", "bin", "tt-storm");

const SAFE_PORTS = { dashboard: 43111, mcp: 43112, control: 43113 };

function ownedTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-daemon-env-${label}-`));
}

function makeRecordingProc(execCtx: any, daemonEnv: any) {
  const calls: Array<{ argv: string[]; env: Record<string, string>; cwd: string; mergeParentEnv: boolean }> = [];
  const proc = makeRealProc({
    execCtx,
    daemonEnv,
    spawn: async (argv: string[], opts: any) => {
      calls.push({
        argv: [...argv],
        env: { ...(opts.env ?? {}) },
        cwd: opts.cwd,
        mergeParentEnv: opts.mergeParentEnv,
      });
      return { argv, exitCode: 0, signal: null, stdout: "", stderr: "", pid: 4242 };
    },
  });
  return { proc, calls };
}

// The real scripted runtime binaries + a probe prompt whose quoted command is a
// benign executable that exits 0 and prints a PATH (the daemon's probe contract).
const SCRIPTED_PI = path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-pi");
const SCRIPTED_HERMES = path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-hermes");
const PROBE_PATH = "/opt/tamandua/skill-path";
const PROBE_PROMPT = `TAMANDUA_HARNESS_PROBE: skill-path\nRun the exact command "/bin/echo ${PROBE_PATH}" and reply with the PATH and nothing else.`;

// Run the rendered script's own `print` contract under bash and return the
// KEY=VALUE map it emits (the exact env daemon-control would apply).
function printEnvScript(scriptText: string, dir: string): Record<string, string> {
  const scriptPath = path.join(dir, "daemon.env.sh");
  fs.writeFileSync(scriptPath, scriptText);
  const printed = spawnSync("bash", [scriptPath, "print"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(printed.status, 0, `script print contract exits 0:\nstderr=${printed.stderr}`);
  const env: Record<string, string> = {};
  for (const line of printed.stdout.split("\n")) {
    if (!line) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    env[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return env;
}

describe("STORM-REHEARSAL US-002 (S1): campaign daemon env delivery", () => {
  it("E1: makeRealProc binds daemonEnv and delivers it on every daemonControl dispatch (start/status/stop) under the private roots", async () => {
    const tmp = ownedTmpDir("deliver");
    try {
      const varRoot = path.join(tmp, "var");
      const execCtx = buildPrivateExecContext({
        varRoot,
        binaries: { tamandua: TAMANDUA_BIN, daemonControl: DC_BIN },
        ownerRef: "e1-daemon-env",
      });
      const envScript = path.join(tmp, "results", "storm-x", "daemon.env.sh");
      const daemonEnv = { TT_DC_ENV_SCRIPTED: envScript, TT_FORCE_NO_SYSTEMD: "1" };
      const { proc, calls } = makeRecordingProc(execCtx, daemonEnv);

      for (const op of ["start", "status", "stop"]) {
        await proc.daemonControl(["daemon-control", REHEARSAL_DAEMON_KIND, op], {});
      }

      assert.equal(calls.length, 3, "one spawn per daemon-control dispatch");
      assert.deepEqual(
        calls.map((c) => c.argv[2]),
        ["start", "status", "stop"],
        "start/status/stop are each delivered in order",
      );
      for (const c of calls) {
        assert.equal(c.argv[0], DC_BIN, "argv[0] is rewritten to the context's absolute daemon-control (no binary bypass)");
        assert.equal(c.argv[1], REHEARSAL_DAEMON_KIND, "argv[1] is the rehearsal daemon kind");
        assert.equal(c.env.TT_DC_ENV_SCRIPTED, envScript, "TT_DC_ENV_SCRIPTED names the campaign daemon.env.sh");
        assert.equal(c.env.TT_FORCE_NO_SYSTEMD, "1", "TT_FORCE_NO_SYSTEMD is delivered");
        assert.equal(c.env.HOME, execCtx.home_root, "HOME stays the private root");
        assert.equal(c.env.TAMANDUA_STATE_DIR, execCtx.state_root, "TAMANDUA_STATE_DIR stays the private root");
        assert.equal(c.env.TAMANDUA_DB_PATH, execCtx.db_path, "TAMANDUA_DB_PATH stays the private campaign DB");
        assert.equal(c.env.TAMANDUA_TEST_GUARD, "1", "the isolation guard is pinned");
        assert.equal(c.env.TAMANDUA_RUN_ID, undefined, "no parent TAMANDUA_RUN_ID authority leaked");
        assert.equal(c.env.TAMANDUA_WORKER_PID, undefined, "no parent worker authority leaked");
        assert.equal(c.cwd, execCtx.home_root, "cwd stays locked to the private home root");
        assert.equal(c.mergeParentEnv, false, "process.env is never merged at the spawn boundary");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E2: the rehearsal daemon-control handle observes the campaign env on canonical start/status/stop and still refuses escapes", async () => {
    const tmp = ownedTmpDir("control");
    try {
      const varRoot = path.join(tmp, "var");
      const execCtx = buildPrivateExecContext({
        varRoot,
        binaries: { tamandua: TAMANDUA_BIN, daemonControl: DC_BIN },
        ownerRef: "e2-daemon-control",
      });
      const envScript = path.join(tmp, "results", "storm-y", "daemon.env.sh");
      const daemonEnv = { TT_DC_ENV_SCRIPTED: envScript, TT_FORCE_NO_SYSTEMD: "1" };
      const { proc, calls } = makeRecordingProc(execCtx, daemonEnv);
      const control = makeRehearsalDaemonControl({ proc, kind: REHEARSAL_DAEMON_KIND });

      for (const op of ["start", "status", "stop"]) {
        const built = daemonControlArgv(REHEARSAL_DAEMON_KIND, op);
        assert.equal(built.ok, true, `canonical argv resolves for ${op}`);
        await control.dispatch(op, {});
      }

      assert.equal(calls.length, 3, "the recording double observed start/status/stop");
      for (const c of calls) {
        assert.equal(c.env.TT_DC_ENV_SCRIPTED, envScript, "the control handle's dispatch carries the campaign env script");
        assert.equal(c.env.TT_FORCE_NO_SYSTEMD, "1", "the control handle's dispatch carries TT_FORCE_NO_SYSTEMD");
      }

      // Protected per-call override still refuses (no HOME escape through env).
      await assert.rejects(
        () => proc.daemonControl(["daemon-control", REHEARSAL_DAEMON_KIND, "status"], { env: { HOME: "/evil" } }),
        (e: any) => e.code === TT_EXEC_ESCAPE,
        "a per-call HOME override still throws TT_EXEC_ESCAPE",
      );
      // Unknown executable still refuses (no binary smuggling around admission).
      await assert.rejects(
        () => proc.daemonControl(["/bin/sh", "-c", "id"], {}),
        (e: any) => e.code === TT_UNKNOWN_BINARY,
        "an unknown argv[0] still throws TT_UNKNOWN_BINARY",
      );
      // A BOUND daemonEnv may not smuggle a protected key either: childEnv()
      // validates the merged env, so even campaign-supplied env cannot redirect
      // HOME/STATE/DB.
      const badEnvScript = path.join(tmp, "results", "storm-y", "bad.env.sh");
      const { proc: badProc } = makeRecordingProc(execCtx, { TT_DC_ENV_SCRIPTED: badEnvScript, HOME: "/evil" });
      await assert.rejects(
        () => badProc.daemonControl(["daemon-control", REHEARSAL_DAEMON_KIND, "status"], {}),
        (e: any) => e.code === TT_EXEC_ESCAPE,
        "a daemonEnv carrying a protected key is refused at the env boundary",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E3: renderRehearsalDaemonEnvScript pins TAMANDUA_DB_PATH when dbPath is supplied, prints it, and omits the export when null", () => {
    const tmp = ownedTmpDir("render");
    try {
      const home = path.join(tmp, "var", "home");
      const stateDir = path.join(home, ".tamandua");
      const tmpDir = path.join(tmp, "var", "tmp");
      const dbPath = path.join(stateDir, "tamandua.db");
      const base = {
        home,
        stateDir,
        tmpDir,
        ports: SAFE_PORTS,
        piBinary: path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-pi"),
        hermesBinary: path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-hermes"),
      };

      const withDb = renderRehearsalDaemonEnvScript({ ...base, dbPath });
      assert.match(
        withDb,
        new RegExp(`^export TAMANDUA_DB_PATH='${dbPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'$`, "m"),
        "the export pins the campaign private DB",
      );
      // The line sits immediately after TAMANDUA_STATE_DIR (operator-visible ordering).
      const exportLines = withDb.split("\n");
      const stateIdx = exportLines.findIndex((l) => l.startsWith("export TAMANDUA_STATE_DIR="));
      const dbIdx = exportLines.findIndex((l) => l.startsWith("export TAMANDUA_DB_PATH="));
      assert.ok(stateIdx >= 0 && dbIdx === stateIdx + 1, "TAMANDUA_DB_PATH is emitted right after TAMANDUA_STATE_DIR");
      // The shell `print` contract exposes the DB var.
      const printLine = exportLines.find((l) => l.trim().startsWith("for v in"));
      assert.ok(printLine && printLine.includes("TAMANDUA_DB_PATH"), "the printed vars list includes TAMANDUA_DB_PATH");

      // Running the real script's `print` contract yields the campaign DB.
      const scriptPath = path.join(tmp, "daemon.env.sh");
      fs.writeFileSync(scriptPath, withDb);
      const printed = spawnSync("bash", [scriptPath, "print"], { encoding: "utf8", timeout: 30_000 });
      assert.equal(printed.status, 0, `script print contract exits 0:\nstderr=${printed.stderr}`);
      assert.match(printed.stdout, new RegExp(`^TAMANDUA_DB_PATH=${dbPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));

      // Backwards compatible: no dbPath -> no export line (synthetic callers).
      const withoutDb = renderRehearsalDaemonEnvScript(base);
      assert.ok(!/^export TAMANDUA_DB_PATH=/m.test(withoutDb), "no export TAMANDUA_DB_PATH line when dbPath is null");
      assert.ok(withoutDb.includes("export TAMANDUA_STATE_DIR="), "the rest of the script is unchanged");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E4: realCtx wires bopts.daemonEnv into makeRealProc and materializeRehearsalDaemon passes execCtx.db_path", () => {
    const src = fs.readFileSync(TT_STORM_SRC, "utf8");
    assert.match(
      src,
      /const proc = makeRealProc\(\{ execCtx, daemonEnv: bopts\.daemonEnv \?\? null, controlUrl: bopts\.controlUrl \?\? null \}\)/,
      "realCtx binds the materialized daemonEnv into makeRealProc",
    );
    // US-008 (SF-3): the same realCtx binds the campaign's private
    // control-plane URL so each S9/S10 admission attempt can take a numeric
    // freeSlots snapshot at decision time.
    assert.match(
      src,
      /controlUrl: bopts\.controlUrl \?\? null/,
      "realCtx binds the campaign private control-plane URL into the proc bundle",
    );
    const threaded = src.match(/daemonEnv:\s*daemonRes\.daemonEnv/g) ?? [];
    assert.equal(threaded.length, 2, "BOTH the rehearse and run paths thread daemonRes.daemonEnv through realCtx bopts");
    assert.match(
      src,
      /renderRehearsalDaemonEnvScript\(\{\s*home: execCtx\.home_root,\s*stateDir: execCtx\.state_root,\s*dbPath: execCtx\.db_path,/,
      "materializeRehearsalDaemon passes the campaign exec-context DB path to the renderer",
    );
    // US-002 (NPF-2): the contained env is rendered under `env -i`, so the
    // daemon PATH must carry <repo>/bin or the scripted runtime's bash cannot
    // resolve the bare `tamandua-test` that the shim-wrapped TEST_CMD invokes.
    assert.match(
      src,
      /pathExtra:\s*rehearsalDaemonPathExtra\(REPO_ROOT\)/,
      "materializeRehearsalDaemon puts <repo>/bin on the contained daemon PATH",
    );
    // US-002 fix-2 (S5/S8): the materializer delivers the scripted-runtime
    // contract + derived cap and creates the scripted state dir.
    assert.match(
      src,
      /scriptedBehaviors:\s*scriptedRuntime\?\.behaviors_file\s*\?\?\s*null/,
      "materializeRehearsalDaemon passes state.rehearsal.scripted_runtime.behaviors_file to the renderer",
    );
    assert.match(
      src,
      /scriptedStateDir:\s*scriptedRuntime\?\.state_dir\s*\?\?\s*null/,
      "materializeRehearsalDaemon passes state.rehearsal.scripted_runtime.state_dir to the renderer",
    );
    assert.match(
      src,
      /maxActiveTimers:\s*state\?\.source\?\.active_cap\s*\?\?\s*null/,
      "materializeRehearsalDaemon passes the DERIVED state.source.active_cap to the renderer (S8)",
    );
    assert.match(
      src,
      /fsx\.mkdirSync\(scriptedRuntime\.state_dir,\s*\{\s*recursive:\s*true\s*\}\)/,
      "materializeRehearsalDaemon creates the scripted state dir before the daemon start",
    );
  });

  it("E5: renderRehearsalDaemonEnvScript emits the scripted-runtime contract + derived cap (and omits it when not supplied)", () => {
    const tmp = ownedTmpDir("render-contract");
    try {
      const home = path.join(tmp, "var", "home");
      const stateDir = path.join(home, ".tamandua");
      const tmpDir = path.join(tmp, "var", "tmp");
      const behaviors = path.join(tmp, "var", "rehearsal", "storm-x", "scripted", "behaviors.json");
      fs.mkdirSync(path.dirname(behaviors), { recursive: true });
      fs.writeFileSync(behaviors, JSON.stringify({ agents: {}, heartbeatTokens: 0, defaultTokens: 0 }) + "\n");
      const scriptedState = path.join(stateDir, "scripted-state", "storm-x");
      fs.mkdirSync(scriptedState, { recursive: true });
      const base = {
        home,
        stateDir,
        tmpDir,
        ports: SAFE_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
      };

      const script = renderRehearsalDaemonEnvScript({
        ...base,
        scriptedBehaviors: behaviors,
        scriptedStateDir: scriptedState,
        maxActiveTimers: 52,
      });
      assert.ok(script.includes(`export TAMANDUA_SCRIPTED_BEHAVIORS='${behaviors}'`), "behaviors export emitted");
      assert.ok(script.includes(`export TAMANDUA_SCRIPTED_STATE='${scriptedState}'`), "scripted state export emitted");
      assert.ok(/^export TAMANDUA_MAX_ACTIVE_TIMERS=52$/m.test(script), "derived cap export emitted as a bare integer");
      const printLine = script.split("\n").find((l) => l.trim().startsWith("for v in"));
      assert.ok(printLine, "the script carries a print vars contract");
      for (const key of ["TAMANDUA_SCRIPTED_BEHAVIORS", "TAMANDUA_SCRIPTED_STATE", "TAMANDUA_MAX_ACTIVE_TIMERS"]) {
        assert.ok(printLine!.includes(key), `the printed vars list includes ${key}`);
      }
      // The real `print` contract yields the recorded values.
      const envMap = printEnvScript(script, tmp);
      assert.equal(envMap.TAMANDUA_SCRIPTED_BEHAVIORS, behaviors);
      assert.equal(envMap.TAMANDUA_SCRIPTED_STATE, scriptedState);
      assert.equal(envMap.TAMANDUA_MAX_ACTIVE_TIMERS, "52");

      // Backwards compatible: all three omitted when not supplied (gate H8).
      const plain = renderRehearsalDaemonEnvScript(base);
      assert.ok(!plain.includes("TAMANDUA_SCRIPTED_BEHAVIORS"), "behaviors omitted when not supplied");
      assert.ok(!plain.includes("TAMANDUA_SCRIPTED_STATE"), "scripted state omitted when not supplied");
      assert.ok(!plain.includes("TAMANDUA_MAX_ACTIVE_TIMERS"), "cap omitted when not supplied");
      const plainPrintLine = plain.split("\n").find((l) => l.trim().startsWith("for v in"));
      assert.ok(plainPrintLine && !plainPrintLine.includes("TAMANDUA_SCRIPTED_BEHAVIORS"), "print contract stays legacy when omitted");

      // An invalid cap is refused (never a silent default).
      assert.throws(
        () => renderRehearsalDaemonEnvScript({ ...base, maxActiveTimers: 0 }),
        (e: any) => e.code === "TT_USAGE",
        "maxActiveTimers=0 is refused",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E6: parseRehearsalDaemonEnvScript round-trips the rendered export contract (shell quoting included)", () => {
    const tmp = ownedTmpDir("parse");
    try {
      const home = path.join(tmp, "var", "home");
      const stateDir = path.join(home, ".tamandua");
      const tmpDir = path.join(tmp, "var", "tmp");
      const behaviors = path.join(tmp, "var", "rehearsal", "storm-x", "scripted", "behaviors.json");
      fs.mkdirSync(path.dirname(behaviors), { recursive: true });
      fs.writeFileSync(behaviors, "{}\n");
      const scriptedState = path.join(stateDir, "scripted-state", "storm-x");
      fs.mkdirSync(scriptedState, { recursive: true });
      const script = renderRehearsalDaemonEnvScript({
        home,
        stateDir,
        tmpDir,
        ports: SAFE_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
        scriptedBehaviors: behaviors,
        scriptedStateDir: scriptedState,
        maxActiveTimers: 52,
      });
      const vars = parseRehearsalDaemonEnvScript(script);
      assert.equal(vars.TAMANDUA_SCRIPTED_BEHAVIORS, behaviors);
      assert.equal(vars.TAMANDUA_SCRIPTED_STATE, scriptedState);
      assert.equal(vars.TAMANDUA_MAX_ACTIVE_TIMERS, "52");
      assert.equal(vars.TAMANDUA_PI_BINARY, SCRIPTED_PI);
      assert.equal(vars.TAMANDUA_HERMES_BINARY, SCRIPTED_HERMES);
      assert.equal(vars.HOME, home);
      // Single-quote escaping round-trips.
      assert.equal(parseRehearsalDaemonEnvScript("export X='a'\\''b'\n").X, "a'b");
      // Comments and the print block are ignored.
      assert.deepEqual(parseRehearsalDaemonEnvScript("#!/usr/bin/env bash\n# c\nif [ x ]; then\n  printf hi\nfi\n"), {});
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E7: the real frozen scripted-pi/scripted-hermes boot with the materialized env and answer the harness probe", () => {
    const tmp = ownedTmpDir("boot");
    try {
      const home = path.join(tmp, "var", "home");
      const stateDir = path.join(home, ".tamandua");
      const tmpDir = path.join(tmp, "var", "tmp");
      const behaviors = path.join(tmp, "var", "rehearsal", "storm-x", "scripted", "behaviors.json");
      fs.mkdirSync(path.dirname(behaviors), { recursive: true });
      fs.writeFileSync(behaviors, JSON.stringify({ agents: {}, heartbeatTokens: 0, defaultTokens: 0 }) + "\n");
      const scriptedState = path.join(stateDir, "scripted-state", "storm-x");
      fs.mkdirSync(scriptedState, { recursive: true });
      const script = renderRehearsalDaemonEnvScript({
        home,
        stateDir,
        tmpDir,
        ports: SAFE_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
        scriptedBehaviors: behaviors,
        scriptedStateDir: scriptedState,
        maxActiveTimers: 52,
      });
      const envMap = printEnvScript(script, tmp);

      for (const bin of [SCRIPTED_PI, SCRIPTED_HERMES]) {
        const run = spawnSync(bin, [PROBE_PROMPT], {
          encoding: "utf8",
          cwd: tmp,
          timeout: 30_000,
          env: { ...envMap, TT_NODE_BIN: process.execPath },
        });
        assert.equal(run.status, 0, `${path.basename(bin)} probe exits 0 (stderr: ${run.stderr})`);
        const out = String(run.stdout ?? "").trim();
        assert.ok(out.length > 0, `${path.basename(bin)} produced a non-empty answer`);
        assert.ok(out.includes(PROBE_PATH), `${path.basename(bin)} answer carries the probe PATH`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("E8: every process.env read in the frozen scripted runtimes is emitted by the materialized env or documented daemon/worker-provided", () => {
    const tmp = ownedTmpDir("coverage");
    try {
      const runtimeDir = path.join(repoRoot, "torture-test", "scripted-runtimes");
      const readVars = new Set<string>();
      for (const name of fs.readdirSync(runtimeDir)) {
        if (!name.endsWith(".mjs")) continue;
        const text = fs.readFileSync(path.join(runtimeDir, name), "utf8");
        for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) readVars.add(m[1]);
      }
      assert.ok(readVars.size > 0, "the mechanical extraction found process.env reads");

      // Materialize a real env script and collect the KEYS it emits.
      const home = path.join(tmp, "var", "home");
      const stateDir = path.join(home, ".tamandua");
      const tmpDir = path.join(tmp, "var", "tmp");
      const behaviors = path.join(tmp, "var", "rehearsal", "storm-x", "scripted", "behaviors.json");
      fs.mkdirSync(path.dirname(behaviors), { recursive: true });
      fs.writeFileSync(behaviors, "{}\n");
      const scriptedState = path.join(stateDir, "scripted-state", "storm-x");
      fs.mkdirSync(scriptedState, { recursive: true });
      const script = renderRehearsalDaemonEnvScript({
        home,
        stateDir,
        tmpDir,
        ports: SAFE_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
        scriptedBehaviors: behaviors,
        scriptedStateDir: scriptedState,
        maxActiveTimers: 52,
      });
      const emitted = new Set(Object.keys(printEnvScript(script, tmp)));
      const covered = new Set([...emitted, ...REHEARSAL_DAEMON_PROVIDED_ENV_VARS]);
      const missing = [...readVars].filter((v) => !covered.has(v));
      assert.deepEqual(
        missing,
        [],
        `every runtime process.env read must be emitted or documented daemon/worker-provided; missing: ${missing.join(", ")}`,
      );
      // The declared contract list is actually emitted (not just documented).
      for (const key of REHEARSAL_SCRIPTED_RUNTIME_ENV_VARS) {
        assert.ok(emitted.has(key), `the materialized env emits the declared contract var ${key}`);
      }
      // And the worker-provided var is deliberately not emitted.
      assert.ok(!emitted.has("TAMANDUA_WORKER_JOB_ID"), "the worker-provided job id is not baked into the durable env script");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // US-002 (NPF-2): the contained rehearsal env is rendered under `env -i`, so
  // PATH lacks <repo>/bin and the scripted runtime's bash cannot resolve the
  // bare `tamandua-test` that the shim-wrapped TEST_CMD (US-001) invokes. The
  // fix folds rehearsalDaemonPathExtra(repoRoot) into pathExtra in the real
  // campaign renderer and in every e2e harness that renders the env directly.
  it("E9: the rendered daemon PATH resolves <repo>/bin/tamandua-test (real campaign + every e2e harness)", () => {
    const tmp = ownedTmpDir("path");
    try {
      const extra = rehearsalDaemonPathExtra(repoRoot);
      assert.deepEqual(extra, [path.join(repoRoot, "bin")], "rehearsalDaemonPathExtra is <repo>/bin");
      assert.throws(
        () => rehearsalDaemonPathExtra(""),
        (e: any) => e.code === "TT_USAGE",
        "rehearsalDaemonPathExtra refuses a missing repo root",
      );

      const home = path.join(tmp, "var", "home");
      const stateDir = path.join(home, ".tamandua");
      const tmpDir = path.join(tmp, "var", "tmp");
      const script = renderRehearsalDaemonEnvScript({
        home,
        stateDir,
        tmpDir,
        ports: SAFE_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
        nodeBinDir: path.dirname(process.execPath),
        pathExtra: extra,
      });
      const envMap = printEnvScript(script, tmp);
      const entries = String(envMap.PATH ?? "").split(":").filter(Boolean);
      assert.ok(entries.includes(path.join(repoRoot, "bin")), `PATH entries include <repo>/bin (got ${envMap.PATH})`);

      // Resolve + execute the shim with the rendered PATH exactly as the
      // contained scripted worker would.
      const probe = spawnSync("bash", ["-c", "command -v tamandua-test"], { encoding: "utf8", timeout: 30_000, env: envMap });
      assert.equal(probe.status, 0, `command -v tamandua-test exits 0 (stderr: ${probe.stderr})`);
      assert.equal(probe.stdout.trim(), path.join(repoRoot, "bin", "tamandua-test"), "tamandua-test resolves to <repo>/bin/tamandua-test");

      const exec = spawnSync("bash", ["-c", "tamandua-test --help"], { encoding: "utf8", timeout: 30_000, cwd: tmp, env: envMap });
      assert.equal(exec.status, 0, `tamandua-test executes under the rendered PATH (stderr: ${exec.stderr})`);
      assert.match(exec.stderr, /Usage: tamandua-test/, "the resolved shim executes and prints its usage contract");

      // Every harness that renders the daemon env directly threads the same
      // pathExtra, so its scripted tester can resolve tamandua-test too.
      for (const name of [
        "tier2-storm-rehearsal-hold-e2e.test.ts",
        "tier2-storm-rehearsal-park-e2e.test.ts",
        "tier2-storm-rehearsal-rugpull-e2e.test.ts",
        "tier2-storm-rehearsal-stopdel-e2e.test.ts",
      ]) {
        const text = fs.readFileSync(path.join(repoRoot, "torture-test", "self-tests", name), "utf8");
        assert.match(
          text,
          /pathExtra:\s*rehearsalDaemonPathExtra\(repoRoot\)/,
          `${name} passes pathExtra: rehearsalDaemonPathExtra(repoRoot)`,
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
