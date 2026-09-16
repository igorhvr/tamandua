/**
 * DPID takeover resolution + stop tests (US-004).
 *
 * Everything here is driven by injected fakes: no real processes are spawned,
 * no real 15 s grace is waited, and no live state dir or production port is
 * touched. Resolution is unit-tested by feeding fixture `ss`/`lsof` output
 * (both platform formats) through the real parsers in src/lib/service-holder.ts.
 *
 * This file is spawn-capable by classification (it imports daemonctl, which
 * owns node:child_process) and is therefore listed in tests/serial-files.txt.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { resolveProcInfoHelperPath } from "../../dist/lib/proc-info.js";
import {
  DEFAULT_TAKEOVER_GRACE_MS,
  canSignalPid,
  getDaemonStatusAsync,
  getPidFile,
  readTakeoverGraceMs,
  resolveLiveDaemon,
  resolveLiveDaemonDetailed,
  stopDaemonTakeover,
  type LiveService,
} from "../../dist/server/daemonctl.js";
import { getServiceSocketPath } from "../../dist/server/daemon-identity.js";

const DAEMON_CMDLINE =
  "/usr/bin/node --disable-warning=ExperimentalWarning /opt/tamandua/dist/server/daemon.js";
const NON_TAMANDUA_CMDLINE = "python3 -m http.server 4444";

/** A Linux `ss -ltnp` row for a process listening on `port`. */
function ssFixture(port: number, pid: number): string {
  return [
    "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process",
    `LISTEN 0      511    0.0.0.0:${port}        0.0.0.0:*         users:(("node",pid=${pid},fd=20))`,
    "",
  ].join("\n");
}

/** A macOS `lsof -nP -iTCP:<port> -sTCP:LISTEN` row for a pid. */
function lsofFixture(port: number, pid: number): string {
  return [
    "COMMAND  PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
    `node    ${pid} igor   20u  IPv4 0x1234567890abcdef      0t0  TCP *:${port} (LISTEN)`,
    "",
  ].join("\n");
}

describe("daemonctl DPID takeover resolution", () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = tamanduaTempDir("tamandua-takeover-");
    fs.mkdirSync(path.join(homeDir, ".tamandua"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  function writeControlPort(port: number): void {
    fs.writeFileSync(
      path.join(homeDir, ".tamandua", "control-plane-port"),
      String(port),
      "utf-8",
    );
  }

  it("returns source='socket' with the identity fields when daemon.sock answers", async () => {
    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => ({
        pid: 1111,
        buildVersion: "build-abc",
        controlPort: 5555,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
      // Would resolve differently, but the socket is authoritative and returns first.
      canSignal: () => true,
      holder: { platform: "linux", runCommand: () => ({ stdout: ssFixture(5555, 2222), status: 0 }), getCmdline: () => DAEMON_CMDLINE },
    });

    assert.deepEqual(live, {
      service: "daemon",
      pid: 1111,
      port: 5555,
      source: "socket",
      buildVersion: "build-abc",
      startedAt: "2026-01-01T00:00:00.000Z",
    } satisfies LiveService);
  });

  it("resolves a verified Tamandua port holder when the identity socket is stale (Linux ss)", async () => {
    writeControlPort(4444);

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      canSignal: () => true,
      holder: {
        platform: "linux",
        runCommand: () => ({ stdout: ssFixture(4444, 4242), status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.deepEqual(live, {
      service: "daemon",
      pid: 4242,
      port: 4444,
      source: "port-holder",
    } satisfies LiveService);
  });

  it("resolves a verified Tamandua port holder on macOS (lsof format)", async () => {
    writeControlPort(5555);

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      canSignal: () => true,
      holder: {
        platform: "darwin",
        runCommand: () => ({ stdout: lsofFixture(5555, 6363), status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.equal(live?.source, "port-holder");
    assert.equal(live?.pid, 6363);
    assert.equal(live?.port, 5555);
  });

  it("never returns a non-Tamandua port holder (falls through to a null result)", async () => {
    writeControlPort(4444);

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      canSignal: () => true,
      checkPid: () => ({ running: false }),
      holder: {
        platform: "linux",
        runCommand: () => ({ stdout: ssFixture(4444, 5252), status: 0 }),
        getCmdline: () => NON_TAMANDUA_CMDLINE,
      },
    });

    assert.equal(live, null);
  });

  it("refuses a verified Tamandua holder whose pid is outside opts.homeDir", async () => {
    writeControlPort(4444);

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      // Linux: environHasEntry() would reject a foreign HOME.
      canSignal: () => false,
      checkPid: () => ({ running: false }),
      holder: {
        platform: "linux",
        runCommand: () => ({ stdout: ssFixture(4444, 4242), status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.equal(live, null, "a holder outside this home must never be adopted");
  });

  it("falls back to the pidfile hint when the socket is stale and the port is free", async () => {
    writeControlPort(4444);

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      canSignal: () => true,
      checkPid: () => ({ running: true, pid: 7777 }),
      holder: {
        platform: "linux",
        runCommand: () => ({ stdout: "", status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.deepEqual(live, {
      service: "daemon",
      pid: 7777,
      port: 4444,
      source: "pidfile",
    } satisfies LiveService);
  });

  it("rejects a pidfile whose pid does not verify as a Tamandua daemon", async () => {
    writeControlPort(4444);

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      canSignal: () => true,
      checkPid: () => ({ running: true, pid: 7777 }),
      holder: {
        platform: "linux",
        runCommand: () => ({ stdout: "", status: 0 }),
        getCmdline: () => NON_TAMANDUA_CMDLINE,
      },
    });

    assert.equal(live, null);
  });

  it("prefers the verified port holder over the pidfile hint", async () => {
    writeControlPort(4444);

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      canSignal: () => true,
      checkPid: () => ({ running: true, pid: 7777 }),
      holder: {
        platform: "linux",
        runCommand: () => ({ stdout: ssFixture(4444, 4242), status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.equal(live?.source, "port-holder");
    assert.equal(live?.pid, 4242);
  });

  it("returns null when no socket, no holder, and no live pidfile exist", async () => {
    writeControlPort(4444);

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      canSignal: () => true,
      checkPid: () => ({ running: false }),
      holder: { platform: "linux", runCommand: () => ({ stdout: "", status: 0 }), getCmdline: () => "" },
    });

    assert.equal(live, null);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Effective-state-dir scoping (US-003)
// ═══════════════════════════════════════════════════════════════════
//
// The DPID fix: a CLI configured for state dir X must never adopt or signal
// a daemon of state dir Y, even when no explicit opts.homeDir is passed.
// `canSignalPid` binds the candidate to the EFFECTIVE home/state dir
// (opts.homeDir, else HOME / TAMANDUA_STATE_DIR) on every platform.
//
// The "ours" / "foreign" candidates are real long-lived child processes: the
// binding evidence is their exact environ membership (procfs on Linux, the
// native KERN_PROCARGS2 `env` helper on macOS — so a child's HOME /
// TAMANDUA_STATE_DIR is enough), with pidfile/open-file provenance as the
// fallback only when the environment cannot be read. A long-lived child with a
// matching HOME/state-dir env is the portable way to exercise the real guard
// rather than an injected `canSignal` stub.

describe("daemonctl effective-state-dir scoping", () => {
  let homeDir: string;
  let otherHome: string;
  let spawned: number[];
  let savedHome: string | undefined;
  let savedStateDir: string | undefined;

  beforeEach(() => {
    homeDir = tamanduaTempDir("tamandua-scope-");
    otherHome = tamanduaTempDir("tamandua-scope-other-");
    fs.mkdirSync(path.join(homeDir, ".tamandua"), { recursive: true });
    fs.mkdirSync(path.join(otherHome, ".tamandua"), { recursive: true });
    spawned = [];
    savedHome = process.env.HOME;
    savedStateDir = process.env.TAMANDUA_STATE_DIR;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = savedStateDir;
    for (const pid of spawned) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(homeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    fs.rmSync(otherHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** Long-lived child whose process environment names the given HOME. */
  function spawnLongLived(env: Record<string, string>): number {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      stdio: "ignore",
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    const pid = child.pid!;
    spawned.push(pid);
    return pid;
  }

  /** Poll canSignalPid until it reports `expected` or the deadline passes. */
  async function waitForCanSignal(
    pid: number,
    expected: boolean,
    opts?: { homeDir?: string },
    timeoutMs = 3000,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let last = canSignalPid(pid, opts);
    while (Date.now() < deadline && last !== expected) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      last = canSignalPid(pid, opts);
    }
    return last;
  }

  /**
   * A helper wrapper that fails only the `env` subcommand, so on darwin the
   * candidate's environment is unreadable (forcing the provenance fallback)
   * while `pid`/elapsed-time reads keep working through the real helper.
   * Returns null when no native helper exists (Linux uses procfs instead, so
   * the fallback is not reachable and the env path already decides the test).
   */
  function writeEnvBlindHelper(): string | null {
    const realHelper = resolveProcInfoHelperPath();
    if (realHelper === null) return null;
    const wrapper = path.join(homeDir, "proc-info-env-blind.sh");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = "env" ]; then exit 1; fi\nexec ${JSON.stringify(realHelper)} "$@"\n`,
      "utf-8",
    );
    fs.chmodSync(wrapper, 0o755);
    return wrapper;
  }

  it("canSignalPid rejects a foreign-HOME pid and accepts an effective-home pid with opts.homeDir", async () => {
    const foreignPid = spawnLongLived({ HOME: otherHome });
    const ourPid = spawnLongLived({ HOME: homeDir });
    // macOS binds by pidfile provenance, so record the matching child.
    fs.writeFileSync(path.join(homeDir, ".tamandua", "tamandua.pid"), String(ourPid), "utf-8");

    assert.equal(canSignalPid(foreignPid, { homeDir }), false);
    assert.equal(await waitForCanSignal(ourPid, true, { homeDir }), true);
  });

  it("canSignalPid scopes via HOME/TAMANDUA_STATE_DIR even when opts.homeDir is undefined", async () => {
    // The CLI's effective config comes from the environment when no opts are
    // passed — this is exactly the coordinator's failing case.
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = path.join(homeDir, ".tamandua");

    const foreignPid = spawnLongLived({ HOME: otherHome, TAMANDUA_STATE_DIR: path.join(otherHome, ".tamandua") });
    const ourPid = spawnLongLived({ HOME: homeDir });
    fs.writeFileSync(path.join(homeDir, ".tamandua", "tamandua.pid"), String(ourPid), "utf-8");

    assert.equal(canSignalPid(foreignPid), false, "a foreign HOME/TAMANDUA_STATE_DIR must be rejected with no opts");
    assert.equal(await waitForCanSignal(ourPid, true), true);
  });

  it("canSignalPid also accepts a pid whose TAMANDUA_STATE_DIR equals the effective state dir", async () => {
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = path.join(homeDir, ".tamandua");

    // HOME differs but the state-dir override matches: still ours.
    const stateOnlyPid = spawnLongLived({
      HOME: otherHome,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
    });
    // Also record the pid as provenance evidence (non-essential now that
    // environ membership is read on darwin too).
    fs.writeFileSync(path.join(homeDir, ".tamandua", "tamandua.pid"), String(stateOnlyPid), "utf-8");

    assert.equal(await waitForCanSignal(stateOnlyPid, true), true);
  });

  it("binds a pid via HOME + TAMANDUA_STATE_DIR env alone, with no pidfile/open file", async () => {
    // The macOS regression: the guard must read a same-user process's environ
    // block (KERN_PROCARGS2 via the native helper) and accept it on the
    // strength of TAMANDUA_STATE_DIR/HOME alone — exactly as Linux does —
    // without depending on a pidfile or an open file under the state dir.
    const ourPid = spawnLongLived({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(homeDir, ".tamandua"),
    });

    assert.equal(
      await waitForCanSignal(ourPid, true, { homeDir }),
      true,
      "env membership alone must bind the pid to the effective state dir",
    );
  });

  it("rejects a pid whose HOME matches but TAMANDUA_STATE_DIR names another state dir", () => {
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = path.join(homeDir, ".tamandua");

    const foreignStatePid = spawnLongLived({
      HOME: homeDir,
      TAMANDUA_STATE_DIR: path.join(otherHome, ".tamandua"),
    });

    assert.equal(
      canSignalPid(foreignStatePid),
      false,
      "a different TAMANDUA_STATE_DIR must be rejected even when HOME matches",
    );
  });

  it("provenance fallback binds to resolveStateDir(opts), not <home>/.tamandua", async () => {
    // Force the env-unreadable path on darwin (the native helper is the only
    // environ source there) with a wrapper that fails just `env`. On Linux
    // procfs still supplies the env, so the child also names the same state
    // dir and both paths agree.
    const customDir = path.join(homeDir, "custom-state");
    fs.mkdirSync(customDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = customDir;
    const savedHelper = process.env.TAMANDUA_PROC_INFO_HELPER;
    const envBlindHelper = writeEnvBlindHelper();
    if (envBlindHelper !== null) process.env.TAMANDUA_PROC_INFO_HELPER = envBlindHelper;
    try {
      const ourPid = spawnLongLived({ HOME: homeDir, TAMANDUA_STATE_DIR: customDir });
      // Provenance evidence lives ONLY in the effective (custom) state dir.
      fs.writeFileSync(path.join(customDir, "tamandua.pid"), String(ourPid), "utf-8");

      assert.equal(await waitForCanSignal(ourPid, true), true);
    } finally {
      if (savedHelper === undefined) delete process.env.TAMANDUA_PROC_INFO_HELPER;
      else process.env.TAMANDUA_PROC_INFO_HELPER = savedHelper;
    }
  });

  it("provenance fallback refuses a pid whose evidence is only under <home>/.tamandua", async () => {
    const customDir = path.join(homeDir, "custom-state");
    fs.mkdirSync(customDir, { recursive: true });
    process.env.HOME = homeDir;
    process.env.TAMANDUA_STATE_DIR = customDir;
    const savedHelper = process.env.TAMANDUA_PROC_INFO_HELPER;
    const envBlindHelper = writeEnvBlindHelper();
    if (envBlindHelper !== null) process.env.TAMANDUA_PROC_INFO_HELPER = envBlindHelper;
    try {
      // HOME-derived pidfile only, in the default .tamandua dir: the effective
      // state dir is `customDir`, so this evidence must NOT bind.
      const misleadingPid = spawnLongLived({ HOME: homeDir });
      fs.writeFileSync(
        path.join(homeDir, ".tamandua", "tamandua.pid"),
        String(misleadingPid),
        "utf-8",
      );

      assert.equal(canSignalPid(misleadingPid), false);
    } finally {
      if (savedHelper === undefined) delete process.env.TAMANDUA_PROC_INFO_HELPER;
      else process.env.TAMANDUA_PROC_INFO_HELPER = savedHelper;
    }
  });

  it("rejects a foreign port holder on the default port instead of returning a port-holder service", async () => {
    // Fresh private state dir with NO control-plane-port file: the fallback
    // probes the default control port, where the host's production daemon
    // lives. The candidate here is a foreign-HOME process, so it must not be
    // adopted even though it "holds" the default port.
    const foreignPid = spawnLongLived({ HOME: otherHome, TAMANDUA_STATE_DIR: path.join(otherHome, ".tamandua") });

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      checkPid: () => ({ running: false }),
      holder: {
        platform: "linux",
        runCommand: () => ({ stdout: ssFixture(3339, foreignPid), status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.equal(live, null, "a foreign state-dir holder must never be adopted");
  });

  it("resolves a port holder proven to belong to the effective state dir (default canSignalPid)", async () => {
    const ourPid = spawnLongLived({ HOME: homeDir });
    const port = 6444;
    // macOS provenance evidence; Linux uses the child's environ HOME.
    fs.writeFileSync(path.join(homeDir, ".tamandua", "tamandua.pid"), String(ourPid), "utf-8");
    fs.writeFileSync(path.join(homeDir, ".tamandua", "control-plane-port"), String(port), "utf-8");

    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => null,
      checkPid: () => ({ running: false }),
      holder: {
        platform: "linux",
        runCommand: () => ({ stdout: ssFixture(port, ourPid), status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.equal(live?.source, "port-holder");
    assert.equal(live?.pid, ourPid);
  });

  it("rejects an identity-socket payload whose stateDir differs from the effective state dir", async () => {
    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => ({
        pid: 1111,
        buildVersion: "build-abc",
        controlPort: 5555,
        startedAt: "2026-01-01T00:00:00.000Z",
        stateDir: path.join(otherHome, ".tamandua"),
      }),
      holder: { platform: "linux", runCommand: () => ({ stdout: "", status: 0 }), getCmdline: () => "" },
      checkPid: () => ({ running: false }),
    });

    assert.equal(live, null);
  });

  it("accepts an identity-socket payload whose stateDir equals the effective state dir", async () => {
    const live = await resolveLiveDaemon({
      homeDir,
      probeSocket: async () => ({
        pid: 1111,
        buildVersion: "build-abc",
        controlPort: 5555,
        startedAt: "2026-01-01T00:00:00.000Z",
        stateDir: path.join(homeDir, ".tamandua"),
      }),
    });

    assert.equal(live?.source, "socket");
    assert.equal(live?.pid, 1111);
  });
});

describe("daemonctl configured-port scoping and foreign classification", () => {
  let homeDir: string;
  let foreignHome: string;
  let probedPorts: number[];

  beforeEach(() => {
    homeDir = tamanduaTempDir("tamandua-portscope-");
    foreignHome = tamanduaTempDir("tamandua-portscope-foreign-");
    fs.mkdirSync(path.join(homeDir, ".tamandua"), { recursive: true });
    fs.mkdirSync(path.join(foreignHome, ".tamandua"), { recursive: true });
    probedPorts = [];
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(foreignHome, { recursive: true, force: true });
  });

  function writeControlPort(port: number): void {
    fs.writeFileSync(
      path.join(homeDir, ".tamandua", "control-plane-port"),
      String(port),
      "utf-8",
    );
  }

  function holderOn(port: number, pid: number) {
    return {
      platform: "linux" as const,
      runCommand: () => ({ stdout: ssFixture(port, pid), status: 0 }),
      getCmdline: () => DAEMON_CMDLINE,
    };
  }

  it("accepts an explicit opts.port override and probes only that port", async () => {
    // The port file disagrees with the requested port: the override must win
    // and the port file must never be consulted for holder resolution.
    writeControlPort(1234);
    const configuredPort = 7444;

    const live = await resolveLiveDaemon({
      homeDir,
      port: configuredPort,
      probeSocket: async () => null,
      canSignal: () => true,
      probeHealth: async (port) => {
        probedPorts.push(port);
        return null;
      },
      holder: holderOn(configuredPort, 4242),
    });

    assert.equal(live?.source, "port-holder");
    assert.equal(live?.pid, 4242);
    assert.equal(live?.port, configuredPort);
    assert.deepEqual(probedPorts, [configuredPort], "only the configured port may be inspected");
  });

  it("never returns a holder on a port other than the configured port", async () => {
    const configuredPort = 7444;
    // ss output names a listener on 9999 only: the parser is scoped to 7444,
    // so this holder must be invisible.
    const live = await resolveLiveDaemon({
      homeDir,
      port: configuredPort,
      probeSocket: async () => null,
      canSignal: () => true,
      checkPid: () => ({ running: false }),
      probeHealth: async (port) => {
        probedPorts.push(port);
        return null;
      },
      holder: holderOn(9999, 4242),
    });

    assert.equal(live, null, "a holder on another port must never be adopted");
    assert.deepEqual(probedPorts, [], "no health probe may run without a holder on the configured port");
  });

  it("surfaces a foreign holder when /control/health reports a different state dir", async () => {
    const port = 7444;
    const foreignStateDir = path.join(foreignHome, ".tamandua");

    const resolution = await resolveLiveDaemonDetailed({
      homeDir,
      port,
      probeSocket: async () => null,
      probeHealth: async () => ({ pid: 4242, stateDir: foreignStateDir }),
      holder: holderOn(port, 4242),
    });

    assert.equal(resolution.live, null, "a foreign daemon must never be returned as live");
    assert.deepEqual(resolution.foreignHolder, { pid: 4242, port, stateDir: foreignStateDir });

    // The plain resolver stays backward compatible: it returns no live service.
    const live = await resolveLiveDaemon({
      homeDir,
      port,
      probeSocket: async () => null,
      probeHealth: async () => ({ pid: 4242, stateDir: foreignStateDir }),
      holder: holderOn(port, 4242),
    });
    assert.equal(live, null);
  });

  it("accepts the cmdline-verified holder when /control/health reports the effective state dir", async () => {
    const port = 7444;

    const resolution = await resolveLiveDaemonDetailed({
      homeDir,
      port,
      probeSocket: async () => null,
      // Health advertising our own state dir is authoritative: the process
      // guard must not be consulted (and would reject here).
      canSignal: () => false,
      probeHealth: async () => ({ pid: 4242, stateDir: path.join(homeDir, ".tamandua") }),
      holder: holderOn(port, 4242),
    });

    assert.equal(resolution.live?.source, "port-holder");
    assert.equal(resolution.live?.pid, 4242);
    assert.equal(resolution.live?.port, port);
    assert.equal(resolution.foreignHolder, null);
  });

  it("falls back to the effective-state-dir guard when health does not answer", async () => {
    const port = 7444;

    const rejected = await resolveLiveDaemonDetailed({
      homeDir,
      port,
      probeSocket: async () => null,
      canSignal: () => false,
      probeHealth: async () => null,
      holder: holderOn(port, 4242),
    });
    assert.equal(rejected.live, null, "the state-dir guard must still reject a non-owned holder");
    assert.equal(rejected.foreignHolder, null, "without state-dir evidence nothing is claimed foreign");

    const accepted = await resolveLiveDaemonDetailed({
      homeDir,
      port,
      probeSocket: async () => null,
      canSignal: () => true,
      probeHealth: async () => null,
      holder: holderOn(port, 4242),
    });
    assert.equal(accepted.live?.source, "port-holder");
    assert.equal(accepted.live?.pid, 4242);
  });

  it("getDaemonStatusAsync honors opts.port and surfaces the foreign holder", async () => {
    const port = 7444;
    const foreignStateDir = path.join(foreignHome, ".tamandua");
    // A stale port file pointing at the default port must be ignored.
    writeControlPort(3339);

    const status = await getDaemonStatusAsync({
      homeDir,
      port,
      probeSocket: async () => null,
      probeHealth: async () => ({ pid: 4242, stateDir: foreignStateDir }),
      holder: holderOn(port, 4242),
    });

    assert.equal(status.running, false);
    assert.equal(status.pid, null);
    assert.equal(status.port, port);
    assert.deepEqual(status.foreignHolder, { pid: 4242, port, stateDir: foreignStateDir });
  });
});

// ═══════════════════════════════════════════════════════════════════
// US-006 scoping regression: a fake ss/lsof holder is accepted only when
// it holds the CONFIGURED port AND belongs to the EFFECTIVE state dir.
// ═══════════════════════════════════════════════════════════════════
//
// These pin the coordinator's exact certification scenario with pure injected
// fixtures (no processes, no network): the host's production daemon lives on
// the default port with a different state dir, so it must never be adopted.

describe("daemonctl US-006 holder scoping (fake ss/lsof)", () => {
  let homeDir: string;
  let foreignHome: string;

  beforeEach(() => {
    homeDir = tamanduaTempDir("tamandua-us006-");
    foreignHome = tamanduaTempDir("tamandua-us006-foreign-");
    fs.mkdirSync(path.join(homeDir, ".tamandua"), { recursive: true });
    fs.mkdirSync(path.join(foreignHome, ".tamandua"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(foreignHome, { recursive: true, force: true });
  });

  it("AC3 rejects a fake Tamandua holder on a different port", async () => {
    const configuredPort = 8444;
    // macOS lsof output naming a DIFFERENT port: only 8444 is inspected.
    const live = await resolveLiveDaemon({
      homeDir,
      port: configuredPort,
      probeSocket: async () => null,
      canSignal: () => true,
      checkPid: () => ({ running: false }),
      holder: {
        platform: "darwin",
        runCommand: () => ({ stdout: lsofFixture(9999, 5151), status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.equal(live, null, "a holder on another port must never be adopted");
  });

  it("AC4 rejects a fake holder belonging to a different state dir", async () => {
    const port = 8444;
    const foreignStateDir = path.join(foreignHome, ".tamandua");

    const resolution = await resolveLiveDaemonDetailed({
      homeDir,
      port,
      probeSocket: async () => null,
      canSignal: () => true,
      // The holder holds the configured port but serves another state dir.
      probeHealth: async () => ({ pid: 5151, stateDir: foreignStateDir }),
      holder: {
        platform: "linux",
        runCommand: () => ({ stdout: ssFixture(port, 5151), status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.equal(resolution.live, null, "a foreign state-dir holder must never be live");
    assert.deepEqual(resolution.foreignHolder, { pid: 5151, port, stateDir: foreignStateDir });
  });

  it("AC5 accepts a fake holder on the configured port within the effective state dir", async () => {
    const port = 8444;

    const resolution = await resolveLiveDaemonDetailed({
      homeDir,
      port,
      probeSocket: async () => null,
      // Health advertising our own state dir is authoritative: the process
      // guard is not consulted (and would reject here).
      canSignal: () => false,
      probeHealth: async () => ({ pid: 5151, stateDir: path.join(homeDir, ".tamandua") }),
      holder: {
        platform: "darwin",
        runCommand: () => ({ stdout: lsofFixture(port, 5151), status: 0 }),
        getCmdline: () => DAEMON_CMDLINE,
      },
    });

    assert.equal(resolution.live?.source, "port-holder");
    assert.equal(resolution.live?.pid, 5151);
    assert.equal(resolution.live?.port, port);
    assert.equal(resolution.foreignHolder, null);
  });
});

describe("daemonctl DPID takeover stop", () => {
  let homeDir: string;
  let savedDaemonPid: string | undefined;
  let savedGrace: string | undefined;

  beforeEach(() => {
    homeDir = tamanduaTempDir("tamandua-takeover-stop-");
    fs.mkdirSync(path.join(homeDir, ".tamandua"), { recursive: true });
    savedDaemonPid = process.env.TAMANDUA_DAEMON_PID;
    savedGrace = process.env.TAMANDUA_TAKEOVER_GRACE_MS;
    delete process.env.TAMANDUA_TAKEOVER_GRACE_MS;
  });

  afterEach(() => {
    if (savedDaemonPid === undefined) delete process.env.TAMANDUA_DAEMON_PID;
    else process.env.TAMANDUA_DAEMON_PID = savedDaemonPid;
    if (savedGrace === undefined) delete process.env.TAMANDUA_TAKEOVER_GRACE_MS;
    else process.env.TAMANDUA_TAKEOVER_GRACE_MS = savedGrace;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  /** A fake clock where sleep() advances time; deterministic, no real waits. */
  function fakeClock(): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    sleeps: number[];
  } {
    let t = 0;
    const sleeps: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
      sleeps,
    };
  }

  function service(pid: number, overrides?: Partial<LiveService>): LiveService {
    return { service: "daemon", pid, port: 4444, source: "port-holder", ...overrides };
  }

  it("SIGTERMs the resolved pid, verifies the port freed, and unlinks stale files", async () => {
    const clock = fakeClock();
    const signals: string[] = [];
    const unlinked: string[] = [];
    let alive = true;

    const result = await stopDaemonTakeover(
      { homeDir },
      {
        resolve: async () => service(4321),
        kill: (_pid, signal) => {
          signals.push(signal);
          alive = false;
        },
        isAlive: () => alive,
        isPortOpen: async () => false,
        unlink: (file) => unlinked.push(file),
        now: clock.now,
        sleep: clock.sleep,
      },
    );

    assert.deepEqual(signals, ["SIGTERM"]);
    assert.deepEqual(result, { stopped: true, pid: 4321, escalated: false, portFree: true });
    assert.deepEqual(unlinked.sort(), [
      getPidFile({ homeDir }),
      getServiceSocketPath("daemon", { homeDir }),
    ].sort());
  });

  it("escalates to SIGKILL when the pid survives the grace and reports escalated=true", async () => {
    const clock = fakeClock();
    const signals: string[] = [];
    let alive = true;
    let killClock = -1;
    // Grace is read from TAMANDUA_TAKEOVER_GRACE_MS — honored by the test.
    process.env.TAMANDUA_TAKEOVER_GRACE_MS = "200";

    const result = await stopDaemonTakeover(
      { homeDir },
      {
        resolve: async () => service(4321),
        kill: (_pid, signal) => {
          signals.push(signal);
          if (signal === "SIGKILL") {
            killClock = clock.now();
            alive = false;
          }
        },
        isAlive: () => alive,
        isPortOpen: async () => false,
        now: clock.now,
        sleep: clock.sleep,
        pollMs: 100,
      },
    );

    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(result.escalated, true);
    assert.equal(result.stopped, true);
    assert.equal(result.portFree, true);
    // 200 ms env grace with a 100 ms poll: SIGKILL cannot land before 200 ms.
    assert.ok(killClock >= 200, `SIGKILL landed at ${killClock}ms, expected >= 200ms`);
    assert.ok(clock.sleeps.reduce((a, b) => a + b, 0) >= 200, "slept at least the grace window");
  });

  it("does not stop when nothing resolves (no kill, no unlink)", async () => {
    const signals: string[] = [];
    const unlinked: string[] = [];

    const result = await stopDaemonTakeover(
      { homeDir },
      {
        resolve: async () => null,
        kill: (_pid, signal) => signals.push(signal),
        isAlive: () => true,
        unlink: (file) => unlinked.push(file),
      },
    );

    assert.deepEqual(result, { stopped: false, escalated: false, portFree: true });
    assert.deepEqual(signals, []);
    assert.deepEqual(unlinked, []);
  });

  it("reports portFree=false when the control port never stops accepting connections", async () => {
    const clock = fakeClock();
    let alive = true;

    const result = await stopDaemonTakeover(
      { homeDir },
      {
        resolve: async () => service(4321),
        kill: (_pid, signal) => {
          if (signal === "SIGTERM") alive = false;
        },
        isAlive: () => alive,
        isPortOpen: async () => true,
        now: clock.now,
        sleep: clock.sleep,
        graceMs: 50,
        pollMs: 50,
        portVerifyTimeoutMs: 200,
      },
    );

    assert.equal(result.portFree, false);
    assert.equal(result.stopped, true);
  });

  it("never unlinks the socket/pidfile while the pid is still alive", async () => {
    const clock = fakeClock();
    const unlinked: string[] = [];

    const result = await stopDaemonTakeover(
      { homeDir },
      {
        resolve: async () => service(4321),
        kill: () => {
          // Never dies, even after SIGKILL.
        },
        isAlive: () => true,
        isPortOpen: async () => false,
        unlink: (file) => unlinked.push(file),
        now: clock.now,
        sleep: clock.sleep,
        graceMs: 50,
        killWaitMs: 50,
        pollMs: 50,
      },
    );

    assert.equal(result.stopped, false);
    assert.equal(result.escalated, true, "an unkillable pid must have been escalated to SIGKILL");
    assert.deepEqual(unlinked, [], "no file may be unlinked while the pid is alive");
  });

  it("refuses to stop the daemon scheduling the current agent (TAMANDUA_DAEMON_PID)", async () => {
    process.env.TAMANDUA_DAEMON_PID = "4321";
    const signals: string[] = [];

    await assert.rejects(
      () =>
        stopDaemonTakeover(
          { homeDir },
          {
            resolve: async () => service(4321),
            kill: (_pid, signal) => signals.push(signal),
            isAlive: () => true,
            isPortOpen: async () => false,
          },
        ),
      /Refusing to stop the daemon .*scheduling/s,
    );

    assert.deepEqual(signals, [], "the scheduling daemon must never be signalled");
  });

  it("honors TAMANDUA_TAKEOVER_GRACE_MS, a deps override, and the 15 s default", () => {
    process.env.TAMANDUA_TAKEOVER_GRACE_MS = "1234";
    assert.equal(readTakeoverGraceMs(), 1234);
    assert.equal(readTakeoverGraceMs(77), 77, "explicit override wins over the env");

    delete process.env.TAMANDUA_TAKEOVER_GRACE_MS;
    assert.equal(readTakeoverGraceMs(), DEFAULT_TAKEOVER_GRACE_MS);
    assert.equal(readTakeoverGraceMs(), 15_000);
  });
});
