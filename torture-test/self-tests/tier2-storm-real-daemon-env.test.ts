// Tier-2 STORM-REAL US-004 — REAL campaign daemon env + daemon-control real
// wiring (in-process; NO daemon/harness/model spawned).
//
// A REAL storm boots ONE private contained product daemon from THIS tree under
// the campaign's own roots through daemon-control's `real` kind. This file is
// the focused self-test for that env/wiring:
//
//   R1  renderRealDaemonEnvScript emits the private roots (HOME / state / DB /
//       TMPDIR), the campaign listener ports, the derived plan cap and the
//       resolved real harness binaries, and NEVER TAMANDUA_TEST_GUARD; the
//       shell `print` contract round-trips every value;
//   R2  the real renderer refuses a missing root, an empty/unknown/relative
//       harness pin, an invalid cap and a production port;
//   R3  verifyRehearsalDaemonEnvContract is PROFILE-bound: a valid real script
//       is accepted (from explicit text AND the campaign dir), and a real
//       script is refused when it leaks guard=1, drops/renames a real harness
//       binary, points at a nonexistent binary, diverges from the pinned path,
//       mismatches the cap or the ports, or carries no real harness pins;
//   R4  materializeRehearsalDaemon writes daemon.env.real.sh and returns the
//       TT_DC_ENV_REAL binding for a REAL campaign, and refuses a REAL campaign
//       with no resolved harness pins; ensureRehearsalDaemon records the real
//       daemon kind in state;
//   R5  the SCRIPTED_REHEARSAL renderer output is byte-identical (sha256 pin)
//       and the scripted verifier/materializer behaviour is unchanged.
//
// Everything runs under test-owned scratch dirs (removed in finally). Real
// ports come from bind0 (127.0.0.1, ephemeral) and are pre-seeded where
// determinism matters.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { REAL } from "../bin/tt-storm-profile.mjs";
import {
  REHEARSAL_DAEMON_KIND,
  REAL_DAEMON_ENV_NAME,
  REHEARSAL_DAEMON_ENV_NAME,
  ensureRehearsalDaemon,
  parseRehearsalDaemonEnvScript,
  renderRehearsalDaemonEnvScript,
  renderRealDaemonEnvScript,
  verifyRehearsalDaemonEnvContract,
} from "../bin/tt-storm-rehearsal.mjs";
import { materializeRehearsalDaemon } from "../bin/tt-storm";

const repoRoot = process.cwd();
const SCRIPTED_PI = path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-pi");
const SCRIPTED_HERMES = path.join(repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-hermes");
const CAMPAIGN_PORTS = { dashboard: 43111, mcp: 43112, control: 43113 };
const ACTIVE_CAP = 52;

// The SCRIPTED_REHEARSAL renderer golden pin (fixed fictional inputs so the
// sha256 is host-independent). US-004 promised the scripted output stays
// byte-identical: changing it requires deliberately updating this hash.
const SCRIPTED_RENDER_SHA256 = "d9202896e462f7845a57cdc72e9f24a7b665a77b439cb0b3a93c32bc5d5afa64";

function ownedScratch(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tt-storm-real-env-${label}-`));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

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

function realRenderBase(tmp: string) {
  const home = path.join(tmp, "var", "home");
  const stateDir = path.join(home, ".tamandua");
  const tmpDir = path.join(tmp, "var", "tmp");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  return {
    home,
    stateDir,
    tmpDir,
    dbPath: path.join(stateDir, "tamandua.db"),
    ports: CAMPAIGN_PORTS,
    harnessBinaries: { pi: SCRIPTED_PI, hermes: SCRIPTED_HERMES },
    nodeBinDir: path.dirname(process.execPath),
    pathExtra: [path.join(repoRoot, "bin")],
    repoRoot,
    ttRoot: path.join(repoRoot, "torture-test", "var"),
    maxActiveTimers: ACTIVE_CAP,
  };
}

function realHarnessPins() {
  return {
    pi: { harness: "pi", path: SCRIPTED_PI },
    hermes: { harness: "hermes", path: SCRIPTED_HERMES },
  };
}

describe("STORM-REAL US-004: REAL campaign daemon env + daemon-control real wiring", () => {
  it("R1: the real env script exports the private roots/ports/cap/real harness binaries and NEVER TAMANDUA_TEST_GUARD", () => {
    const tmp = ownedScratch("render");
    try {
      const base = realRenderBase(tmp);
      const script = renderRealDaemonEnvScript(base);
      const vars = parseRehearsalDaemonEnvScript(script);
      assert.equal(vars.HOME, base.home, "private HOME");
      assert.equal(vars.TAMANDUA_STATE_DIR, base.stateDir, "private state dir");
      assert.equal(vars.TAMANDUA_DB_PATH, base.dbPath, "private campaign DB");
      assert.equal(vars.TMPDIR, base.tmpDir, "private TMPDIR");
      assert.equal(vars.TAMANDUA_DASHBOARD_PORT, String(CAMPAIGN_PORTS.dashboard));
      assert.equal(vars.TAMANDUA_MCP_PORT, String(CAMPAIGN_PORTS.mcp));
      assert.equal(vars.TAMANDUA_CONTROL_PORT, String(CAMPAIGN_PORTS.control));
      assert.equal(vars.TAMANDUA_MAX_ACTIVE_TIMERS, String(ACTIVE_CAP), "the derived plan cap is exported");
      assert.equal(vars.TAMANDUA_PI_BINARY, SCRIPTED_PI, "the resolved real pi binary is exported");
      assert.equal(vars.TAMANDUA_HERMES_BINARY, SCRIPTED_HERMES, "the resolved real hermes binary is exported");
      assert.equal(vars.TAMANDUA_TEST_GUARD, undefined, "TAMANDUA_TEST_GUARD is deliberately ABSENT for REAL");
      assert.ok(!/^export TAMANDUA_TEST_GUARD=/m.test(script), "no TAMANDUA_TEST_GUARD export line exists");
      assert.equal(vars.TAMANDUA_SCRIPTED_BEHAVIORS, undefined, "REAL carries no scripted-runtime behaviors");
      assert.equal(vars.TAMANDUA_SCRIPTED_STATE, undefined, "REAL carries no scripted-runtime state");
      // The real `print` contract emits the SAME values (what daemon-control
      // would actually apply under env -i).
      const printed = printEnvScript(script, tmp);
      assert.equal(printed.HOME, base.home);
      assert.equal(printed.TAMANDUA_STATE_DIR, base.stateDir);
      assert.equal(printed.TAMANDUA_DB_PATH, base.dbPath);
      assert.equal(printed.TMPDIR, base.tmpDir);
      assert.equal(printed.TAMANDUA_DASHBOARD_PORT, String(CAMPAIGN_PORTS.dashboard));
      assert.equal(printed.TAMANDUA_MAX_ACTIVE_TIMERS, String(ACTIVE_CAP));
      assert.equal(printed.TAMANDUA_PI_BINARY, SCRIPTED_PI);
      assert.equal(printed.TAMANDUA_HERMES_BINARY, SCRIPTED_HERMES);
      assert.equal(printed.TAMANDUA_TEST_GUARD, undefined, "the printed env carries no forced guard");
      const printLine = script.split("\n").find((l) => l.trim().startsWith("for v in"));
      assert.ok(printLine && printLine.includes("TMPDIR") && printLine.includes("TAMANDUA_MAX_ACTIVE_TIMERS"), "the print contract lists TMPDIR + the cap");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R2: the real renderer refuses missing roots, empty/unknown/relative harness pins, bad cap and production ports", () => {
    const tmp = ownedScratch("render-refuse");
    try {
      const base = realRenderBase(tmp);
      const usage = (args: Record<string, unknown>, why: string) => {
        assert.throws(
          () => renderRealDaemonEnvScript({ ...base, ...args }),
          (e: any) => e?.code === "TT_USAGE",
          `${why} -> TT_USAGE`,
        );
      };
      usage({ home: null }, "missing home");
      usage({ stateDir: null }, "missing stateDir");
      usage({ tmpDir: null }, "missing tmpDir");
      usage({ harnessBinaries: null }, "no harness pins");
      usage({ harnessBinaries: {} }, "empty harness pins");
      usage({ harnessBinaries: { pi: SCRIPTED_PI, bogus: SCRIPTED_HERMES } }, "unknown harness pin");
      usage({ harnessBinaries: { pi: "relative/pi" } }, "relative harness path");
      usage({ harnessBinaries: { pi: "" } }, "empty harness path");
      usage({ maxActiveTimers: 0 }, "non-positive cap");
      usage({ maxActiveTimers: "nope" }, "non-integer cap");
      assert.throws(
        () => renderRealDaemonEnvScript({ ...base, ports: { dashboard: 3334, mcp: 43112, control: 43113 } }),
        (e: any) => e?.code === "TT_REHEARSAL_DAEMON",
        "a production listener port is refused",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R3: verifyRehearsalDaemonEnvContract accepts a valid REAL script and refuses guard leak / missing or bogus binaries / cap+port mismatch / no pins / pin drift", () => {
    const tmp = ownedScratch("verify");
    try {
      const base = realRenderBase(tmp);
      const script = renderRealDaemonEnvScript(base);
      const campaignDir = path.join(tmp, "var", "results", "storm-real-env");
      fs.mkdirSync(campaignDir, { recursive: true });
      fs.writeFileSync(path.join(campaignDir, REAL_DAEMON_ENV_NAME), script);

      const okArgs = {
        daemonPorts: CAMPAIGN_PORTS,
        privateStateDir: base.stateDir,
        activeCap: ACTIVE_CAP,
        profile: REAL,
        realHarnessPins: realHarnessPins(),
        fsx: fs,
      };
      assert.deepEqual(
        verifyRehearsalDaemonEnvContract({ ...okArgs, envScriptText: script }),
        { ok: true },
        "a valid REAL script is accepted from explicit text",
      );
      assert.deepEqual(
        verifyRehearsalDaemonEnvContract({ ...okArgs, campaignDir }),
        { ok: true },
        "a valid REAL script is accepted via the campaignDir read path",
      );

      const deny = (override: Record<string, unknown>, why: string) => {
        const res = verifyRehearsalDaemonEnvContract({ ...okArgs, envScriptText: script, ...override });
        assert.equal(res.ok, false, why);
        assert.equal((res as any).code, "TT_DAEMON_PROVENANCE", `${why} -> TT_DAEMON_PROVENANCE`);
        assert.ok(String((res as any).reason).length > 0, `${why} -> non-empty reason`);
      };
      // Leaked guard=1 (the exact REAL hazard).
      deny({ envScriptText: `${script}export TAMANDUA_TEST_GUARD=1\n` }, "real script leaking TAMANDUA_TEST_GUARD=1");
      // A dropped/renamed real harness binary.
      deny({ envScriptText: script.replace(/^export TAMANDUA_HERMES_BINARY=.*$/m, "") }, "real script missing TAMANDUA_HERMES_BINARY");
      // A real harness binary that does not exist.
      const missingPi = renderRealDaemonEnvScript({ ...base, harnessBinaries: { pi: path.join(tmp, "no-such-pi"), hermes: SCRIPTED_HERMES } });
      deny({ envScriptText: missingPi }, "real script naming a nonexistent pi binary");
      // Drift from the pinned path.
      deny({ envScriptText: script, realHarnessPins: { pi: { path: path.join(tmp, "other-pi") }, hermes: { path: SCRIPTED_HERMES } } }, "real script binary drifting from the pin");
      // No recorded pins.
      deny({ realHarnessPins: null }, "real verify with no campaign harness pins");
      deny({ realHarnessPins: {} }, "real verify with empty campaign harness pins");
      // Cap + ports.
      deny({ activeCap: 50 }, "cap disagreeing with the derived plan cap");
      deny({ daemonPorts: { dashboard: 43119, mcp: 43112, control: 43113 } }, "ports disagreeing with the campaign allocation");
      deny({ activeCap: null }, "missing campaign cap");
      deny({ daemonPorts: null }, "missing campaign ports");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R4: materializeRehearsalDaemon writes the real script + TT_DC_ENV_REAL for a REAL campaign and refuses a REAL campaign with no harness pins", async () => {
    const tmp = ownedScratch("materialize");
    try {
      const campaignDir = path.join(tmp, "var", "results", "storm-real-mat");
      fs.mkdirSync(campaignDir, { recursive: true });
      const homeRoot = path.join(tmp, "var", "home");
      const stateRoot = path.join(homeRoot, ".tamandua");
      const tmpRoot = path.join(tmp, "var", "tmp");
      fs.mkdirSync(stateRoot, { recursive: true });
      fs.mkdirSync(tmpRoot, { recursive: true });
      const execCtx = { home_root: homeRoot, state_root: stateRoot, db_path: path.join(stateRoot, "tamandua.db"), tmp_root: tmpRoot };
      const state: any = {
        source: { active_cap: ACTIVE_CAP },
        daemon_ports: CAMPAIGN_PORTS,
        rehearsal: {
          profile: REAL,
          resource_plan: { daemon: { kind: "real" } },
          runtime_pins: { harnesses: realHarnessPins() },
        },
      };
      const res = await materializeRehearsalDaemon({ state, campaignDir, execCtx });
      assert.equal(res.ok, true, "materialize succeeds for a REAL campaign");
      assert.equal(res.daemonKind, "real");
      assert.equal(res.profile, REAL);
      assert.equal(res.envScript, path.join(campaignDir, REAL_DAEMON_ENV_NAME), "the REAL env script is written under its distinct name");
      assert.equal((res as any).daemonEnv.TT_DC_ENV_REAL, res.envScript, "TT_DC_ENV_REAL points at the real env script");
      assert.equal((res as any).daemonEnv.TT_DC_ENV_SCRIPTED, undefined, "no scripted env binding for a REAL campaign");
      assert.equal((res as any).daemonEnv.TT_FORCE_NO_SYSTEMD, "1");
      const written = fs.readFileSync(res.envScript, "utf8");
      assert.ok(!/^export TAMANDUA_TEST_GUARD=/m.test(written), "the written real script carries no forced guard");
      assert.match(written, /^export TAMANDUA_PI_BINARY=/m);
      // A REAL campaign without resolved harness pins refuses (never a silently
      // harness-less real env).
      const bare: any = {
        source: { active_cap: ACTIVE_CAP },
        daemon_ports: CAMPAIGN_PORTS,
        rehearsal: { profile: REAL, resource_plan: { daemon: { kind: "real" } } },
      };
      const bareDir = path.join(tmp, "var", "results", "storm-real-bare");
      fs.mkdirSync(bareDir, { recursive: true });
      await assert.rejects(
        () => materializeRehearsalDaemon({ state: bare, campaignDir: bareDir, execCtx }),
        (e: any) => e?.code === "TT_USAGE",
        "a REAL campaign with no harness pins refuses",
      );
      assert.equal(fs.existsSync(path.join(bareDir, REAL_DAEMON_ENV_NAME)), false, "no partial real env script is left behind");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R4b: ensureRehearsalDaemon records a real daemon kind and verifies the real env contract", async () => {
    const tmp = ownedScratch("ensure");
    try {
      const campaignDir = path.join(tmp, "var", "results", "storm-real-ensure");
      const provenanceDir = path.join(tmp, "var", "daemon-control");
      const homeRoot = path.join(tmp, "var", "home");
      const stateRoot = path.join(homeRoot, ".tamandua");
      fs.mkdirSync(campaignDir, { recursive: true });
      fs.mkdirSync(stateRoot, { recursive: true });
      const base = {
        home: homeRoot,
        stateDir: stateRoot,
        tmpDir: path.join(tmp, "var", "tmp"),
        dbPath: path.join(stateRoot, "tamandua.db"),
        ports: CAMPAIGN_PORTS,
        harnessBinaries: { pi: SCRIPTED_PI, hermes: SCRIPTED_HERMES },
        maxActiveTimers: ACTIVE_CAP,
      };
      fs.writeFileSync(path.join(campaignDir, REAL_DAEMON_ENV_NAME), renderRealDaemonEnvScript(base));

      const state: any = {
        campaign_id: "storm-real-ensure",
        source: { active_cap: ACTIVE_CAP },
        exec_identity: { state_root: stateRoot },
        daemon_ports: CAMPAIGN_PORTS,
        rehearsal: {
          profile: REAL,
          resource_plan: { daemon: { kind: "real" } },
          runtime_pins: { harnesses: realHarnessPins() },
        },
        rounds: { A: { status: "planned", runs: {} }, B: { status: "planned", runs: {} } },
      };
      const provRecord = {
        name: "real",
        kind: "real",
        pid: 525252,
        ports: [CAMPAIGN_PORTS.dashboard, CAMPAIGN_PORTS.mcp, CAMPAIGN_PORTS.control],
        scopeUnit: "tamandua-tt-real-ffffffff",
        cgroupVerified: false,
        startTime: "proc:99999",
        cwd: stateRoot,
      };
      const proc: any = {
        daemonControl: async (argv: string[]) => {
          const op = argv[2];
          if (op === "start") {
            fs.mkdirSync(provenanceDir, { recursive: true });
            fs.writeFileSync(path.join(provenanceDir, "real.json"), JSON.stringify(provRecord, null, 2) + "\n");
            return { exitCode: 0, stdout: "daemon-control: real daemon started\n", stderr: "" };
          }
          if (op === "status") return { exitCode: 0, stdout: "daemon-control: real daemon RUNNING\n", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        launchWorkflow: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        tamandua: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      };
      const ctx: any = {
        fs,
        clock: { nowUtc: () => new Date().toISOString(), nowMs: () => Date.now() },
        proc,
        campaignDir,
        opts: { rehearsalRun: true, daemonProvenanceDir: provenanceDir, daemonKind: "real" },
      };
      const records: any[] = [];
      const res = await ensureRehearsalDaemon(ctx, state, { record: (kind: string, detail: any) => records.push({ kind, detail }) });
      assert.equal(res.ok, true, "the real daemon is admitted after provenance + env-contract verification");
      assert.equal(res.daemon.kind, "real", "state.daemon.kind is real");
      assert.equal(res.daemon.evidence.pid, 525252);
      assert.ok(records.some((r) => r.kind === "daemon.started"), "daemon.started is recorded");
      assert.ok(!records.some((r) => r.kind === "daemon.env_contract.refused"), "the real env contract was accepted");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("R5: the SCRIPTED_REHEARSAL renderer stays byte-identical and the scripted verifier/materializer behaviour is unchanged", async () => {
    const fixed = renderRehearsalDaemonEnvScript({
      home: "/camp/home",
      stateDir: "/camp/home/.tamandua",
      tmpDir: "/camp/tmp",
      dbPath: "/camp/home/.tamandua/tamandua.db",
      ports: CAMPAIGN_PORTS,
      piBinary: "/camp/scripted-pi",
      hermesBinary: "/camp/scripted-hermes",
      nodeBinDir: "/camp/node/bin",
      pathExtra: ["/camp/repo/bin"],
      repoRoot: "/camp/repo",
      ttRoot: "/camp/tt/var",
      scriptedBehaviors: "/camp/reh/behaviors.json",
      scriptedStateDir: "/camp/home/.tamandua/scripted-state/x",
      maxActiveTimers: 52,
    });
    assert.equal(sha256(fixed), SCRIPTED_RENDER_SHA256, "the SCRIPTED_REHEARSAL renderer output is byte-identical");
    assert.match(fixed, /^export TAMANDUA_TEST_GUARD=1$/m, "the scripted env keeps guard=1");

    const tmp = ownedScratch("scripted");
    try {
      const home = path.join(tmp, "var", "home");
      const stateDir = path.join(home, ".tamandua");
      const tmpDir = path.join(tmp, "var", "tmp");
      const behaviors = path.join(tmp, "var", "reh", "behaviors.json");
      fs.mkdirSync(path.dirname(behaviors), { recursive: true });
      fs.writeFileSync(behaviors, "{}\n");
      const scriptedState = path.join(stateDir, "scripted-state", "storm-x");
      fs.mkdirSync(scriptedState, { recursive: true });
      const script = renderRehearsalDaemonEnvScript({
        home,
        stateDir,
        tmpDir,
        ports: CAMPAIGN_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
        scriptedBehaviors: behaviors,
        scriptedStateDir: scriptedState,
        maxActiveTimers: ACTIVE_CAP,
      });
      // No profile -> the scripted verifier path is exactly the pre-US-004 one.
      assert.deepEqual(
        verifyRehearsalDaemonEnvContract({ envScriptText: script, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateDir, activeCap: ACTIVE_CAP, fsx: fs }),
        { ok: true },
        "a complete scripted script is accepted without a profile",
      );
      const capped50 = renderRehearsalDaemonEnvScript({
        home,
        stateDir,
        tmpDir,
        ports: CAMPAIGN_PORTS,
        piBinary: SCRIPTED_PI,
        hermesBinary: SCRIPTED_HERMES,
        scriptedBehaviors: behaviors,
        scriptedStateDir: scriptedState,
        maxActiveTimers: 50,
      });
      const denied = verifyRehearsalDaemonEnvContract({ envScriptText: capped50, daemonPorts: CAMPAIGN_PORTS, privateStateDir: stateDir, activeCap: ACTIVE_CAP, fsx: fs });
      assert.equal(denied.ok, false, "a scripted cap mismatch is refused");
      assert.equal((denied as any).code, "TT_DAEMON_PROVENANCE");

      // The scripted materializer path is unchanged: daemon.env.sh +
      // TT_DC_ENV_SCRIPTED.
      const campaignDir = path.join(tmp, "var", "results", "storm-scripted-mat");
      fs.mkdirSync(campaignDir, { recursive: true });
      const execCtx = { home_root: home, state_root: stateDir, db_path: path.join(stateDir, "tamandua.db"), tmp_root: tmpDir };
      const state: any = {
        source: { active_cap: ACTIVE_CAP },
        daemon_ports: CAMPAIGN_PORTS,
        rehearsal: { profile: "SCRIPTED_REHEARSAL", resource_plan: { daemon: { kind: REHEARSAL_DAEMON_KIND } }, scripted_runtime: { behaviors_file: behaviors, state_dir: scriptedState } },
      };
      const res = await materializeRehearsalDaemon({ state, campaignDir, execCtx });
      assert.equal(res.envScript, path.join(campaignDir, REHEARSAL_DAEMON_ENV_NAME), "the scripted env keeps the daemon.env.sh name");
      assert.equal((res as any).daemonEnv.TT_DC_ENV_SCRIPTED, res.envScript, "the scripted env keeps the TT_DC_ENV_SCRIPTED binding");
      assert.equal((res as any).daemonEnv.TT_DC_ENV_REAL, undefined, "no real env binding for a scripted campaign");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});