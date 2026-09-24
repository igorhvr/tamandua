// Tier-2 STORM-REHEARSAL US-004 (S6) — owned cleanup of campaign standalone
// listeners by provenance + campaign-port verification.
//
// Attempt-2 finding S6: `tt-storm report` printed `CLEANUP: all owned cleanup
// phases ok` and recorded the daemon stopped (daemon-control stop exit 0,
// provenance stoppedAt), yet the private daemon's standalone
// dashboard-standalone.js (pid 2932425 on 43935) and mcp-standalone.js (pid
// 2932519 on 39675) were orphaned to PID 1 and kept listening on the
// campaign's bind0-allocated ports. The daemon-control wrapper's own stop gate
// checks the kind's FIXED ports (ports_for_kind -> 5334/5338/5339) and only
// waits on pid-file children, so a bind0-allocated campaign's standalone
// children can escape it.
//
// This file is the focused self-test for the fixed cleanup handler:
//   C1  readRehearsalStatePidFile reads dashboard.pid/mcp.pid; garbage/missing
//       yields null;
//   C2  probeTcpPortFree is true for a free port and false for a bound one;
//   C3  classifyRehearsalCampaignListenerPid accepts ONLY a pid tied to the
//       campaign state dir and refuses a foreign/unverifiable one;
//   C4  collectRehearsalDescendantPids captures a real grandchild chain;
//   C5  a real child listener recorded in dashboard.pid plus a fake
//       daemon-control stop that exits 0 but leaves it (an unverifiable pid)
//       yields evidenced:false NAMING the survivor pid + busy campaign port;
//   C6  an identity-verified real child listener recorded in dashboard.pid is
//       stopped (SIGTERM) and with all three campaign ports free yields
//       evidenced:true;
//   C7  a missing private state dir / daemon_ports makes the port check
//       impossible -> evidenced:false (never a silent PASS);
//   C8  a production port (3334/3338/3339) is refused before any signal.
//
// Only pids THIS test spawned are ever signalled; the state dir and every
// child are test-owned scratch removed in finally. Ports are OS-allocated on
// 127.0.0.1 (never 3334/3338/3339). No daemon/harness/workflow is spawned.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  REHEARSAL_DAEMON_KIND,
  classifyRehearsalCampaignListenerPid,
  collectRehearsalDescendantPids,
  makeRehearsalDaemonCleanupHandler,
  makeRehearsalProcessOps,
  probeTcpPortFree,
  readRehearsalStatePidFile,
} from "../bin/tt-storm-rehearsal.mjs";

const repoRoot = process.cwd();

const scratchDirs: string[] = [];
const childPids: number[] = [];

function ownedTmpDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tt-reh-cleanup-${label}-`));
  scratchDirs.push(dir);
  return dir;
}

function allocFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function waitPortListening(port: number, timeoutMs = 8_000): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const s = net.connect({ host: "127.0.0.1", port });
      s.setTimeout(500, () => { s.destroy(); retry(); });
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => retry());
    };
    const retry = () => {
      if (Date.now() >= deadline) resolve(false);
      else setTimeout(attempt, 100);
    };
    attempt();
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (err: any) { return err?.code === "EPERM"; }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const idx = stat.lastIndexOf(")");
    if (idx >= 0) {
      const st = stat.slice(idx + 2).trim().split(/\s+/)[0];
      if (st === "Z" || st === "X") return false;
    }
  } catch { /* no procfs */ }
  return true;
}

const LISTENER_SOURCE = `
  const net = require('net');
  const port = Number(process.argv[1]);
  const s = net.createServer();
  s.listen(port, '127.0.0.1', () => process.stdout.write('LISTENING\\n'));
  const stop = () => { try { s.close(() => process.exit(0)); } catch { process.exit(0); } setTimeout(() => process.exit(0), 500); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  setInterval(() => {}, 1000);
`;

function spawnListener({ port, cwd, stateDirEnv, home }: { port: number; cwd: string; stateDirEnv: string; home: string }): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TAMANDUA_STATE_DIR: stateDirEnv, TAMANDUA_TEST_GUARD: "0" };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ["-e", LISTENER_SOURCE, String(port)], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (child.pid) childPids.push(child.pid);
  return child;
}

function killOwned(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

after(() => {
  for (const pid of childPids) killOwned(pid);
  for (const dir of scratchDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function fakeControl({ daemonPid, ports, stopExit = 0 }: { daemonPid: number; ports: any; stopExit?: number }) {
  const calls: string[] = [];
  const control: any = {
    kind: REHEARSAL_DAEMON_KIND,
    dispatch: async (op: string) => {
      calls.push(op);
      if (op === "stop") return { exitCode: stopExit, stdout: "stopped", stderr: "" };
      return { exitCode: 0, stdout: "daemon-control: scripted daemon not running", stderr: "" };
    },
    provenance: () => ({ found: true, file: "/tmp/tt-fake-scripted.json", record: { pid: daemonPid, ports: Object.values(ports).map(String) } }),
    calls,
  };
  return control;
}

const DEAD_DAEMON_PID = 999_999; // never captured: no live process, no chain

describe("US-004 rehearsal cleanup: provenance-only standalone listener reap + campaign port verification", () => {
  it("C1: readRehearsalStatePidFile reads a positive pid and refuses missing/garbage", () => {
    const stateDir = ownedTmpDir("pidfile");
    fs.writeFileSync(path.join(stateDir, "dashboard.pid"), "4242\n");
    assert.equal(readRehearsalStatePidFile({ fsx: fs, privateStateDir: stateDir, name: "dashboard.pid" }), 4242);
    assert.equal(readRehearsalStatePidFile({ fsx: fs, privateStateDir: stateDir, name: "mcp.pid" }), null, "missing pidfile -> null");
    fs.writeFileSync(path.join(stateDir, "mcp.pid"), "not-a-pid");
    assert.equal(readRehearsalStatePidFile({ fsx: fs, privateStateDir: stateDir, name: "mcp.pid" }), null, "garbage -> null");
    assert.equal(readRehearsalStatePidFile({ fsx: fs, privateStateDir: null, name: "dashboard.pid" }), null, "no state dir -> null");
  });

  it("C2: probeTcpPortFree is true for a free port and false for a bound one", async () => {
    const freePort = await allocFreePort();
    assert.equal(await probeTcpPortFree(freePort), true, "a freshly released port is free");
    const srv = net.createServer();
    await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
    const boundPort = (srv.address() as net.AddressInfo).port;
    try {
      assert.equal(await probeTcpPortFree(boundPort), false, "a bound port is not free");
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it("C3: classifyRehearsalCampaignListenerPid accepts only a pid tied to the campaign state dir", async () => {
    const stateDir = ownedTmpDir("classify-state");
    const foreignDir = ownedTmpDir("classify-foreign");
    const portA = await allocFreePort();
    const portB = await allocFreePort();
    const tied = spawnListener({ port: portA, cwd: stateDir, stateDirEnv: stateDir, home: path.dirname(stateDir) });
    const foreign = spawnListener({ port: portB, cwd: foreignDir, stateDirEnv: foreignDir, home: foreignDir });
    try {
      assert.ok(await waitPortListening(portA), "tied listener bound");
      assert.ok(await waitPortListening(portB), "foreign listener bound");
      const tiedVerdict = classifyRehearsalCampaignListenerPid(tied.pid, { privateStateDir: stateDir, repoRoot });
      assert.equal(tiedVerdict.ok, true, `tied pid accepted: ${tiedVerdict.reason ?? ""}`);
      const foreignVerdict = classifyRehearsalCampaignListenerPid(foreign.pid, { privateStateDir: stateDir, repoRoot });
      assert.equal(foreignVerdict.ok, false, "a pid tied to a different state dir is refused");
      assert.match(String(foreignVerdict.reason), /different state dir|not tied/);
    } finally {
      killOwned(tied.pid);
      killOwned(foreign.pid);
    }
  });

  it("C4: collectRehearsalDescendantPids captures a real grandchild chain", async () => {
    const parentSource = `
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.stdout.write(String(child.pid) + '\\n');
      setInterval(() => {}, 1000);
    `;
    const parent = spawn(process.execPath, ["-e", parentSource], { stdio: ["ignore", "pipe", "ignore"] });
    if (parent.pid) childPids.push(parent.pid);
    const childPid: number = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("parent did not report its child pid")), 8_000);
      parent.stdout!.on("data", (d) => {
        buf += String(d);
        const m = /^(\d+)/.exec(buf);
        if (m) { clearTimeout(timer); resolve(Number(m[1])); }
      });
    });
    childPids.push(childPid);
    try {
      const ops = makeRehearsalProcessOps({ fsx: fs });
      const chain = collectRehearsalDescendantPids(parent.pid!, ops);
      assert.ok(chain.includes(childPid), `grandchild ${childPid} captured in chain ${JSON.stringify(chain)}`);
    } finally {
      killOwned(childPid);
      killOwned(parent.pid);
    }
  });

  it("C5: a fake stop that exits 0 but leaves an unverifiable child listener yields evidenced:false naming the survivor", async () => {
    const stateDir = ownedTmpDir("leak-state");
    const foreignDir = ownedTmpDir("leak-foreign");
    const dashboardPort = await allocFreePort();
    const mcpPort = await allocFreePort();
    const controlPort = await allocFreePort();
    const ports = { dashboard: dashboardPort, mcp: mcpPort, control: controlPort };
    // A REAL listener NOT tied to the campaign state dir: recorded in
    // dashboard.pid but unverifiable, so cleanup must refuse to signal it.
    const child = spawnListener({ port: dashboardPort, cwd: foreignDir, stateDirEnv: foreignDir, home: foreignDir });
    fs.writeFileSync(path.join(stateDir, "dashboard.pid"), String(child.pid));
    assert.ok(await waitPortListening(dashboardPort), "leaked listener bound");
    const record: any = { kind: REHEARSAL_DAEMON_KIND, status: "running", evidence: { pid: DEAD_DAEMON_PID } };
    const control = fakeControl({ daemonPid: DEAD_DAEMON_PID, ports, stopExit: 0 });
    const handler = makeRehearsalDaemonCleanupHandler({ control, record, fsx: fs, privateStateDir: stateDir, daemonPorts: ports });
    let res: any;
    try {
      res = await handler({ resources: {} });
      assert.equal(res.evidenced, false, "a surviving campaign-owned listener cannot PASS");
      assert.match(String(res.error), /un-closed/);
      assert.ok((res.survivors ?? []).some((s: any) => s.kind === "pid" && s.pid === child.pid), "the survivor names the refused pid");
      assert.ok((res.survivors ?? []).some((s: any) => s.kind === "port" && s.port === dashboardPort), "the survivor names the busy campaign port");
      assert.deepEqual(control.calls, ["stop", "status"], "the fake daemon stop ran; the refused child was never signalled");
      assert.ok(alive(child.pid!), "the unverifiable child was NOT killed");
    } finally {
      killOwned(child.pid);
    }
  });

  it("C6: an identity-verified child listener is stopped and free ports yield evidenced:true", async () => {
    const home = ownedTmpDir("verified-home");
    const stateDir = path.join(home, ".tamandua");
    fs.mkdirSync(stateDir, { recursive: true });
    const dashboardPort = await allocFreePort();
    const mcpPort = await allocFreePort();
    const controlPort = await allocFreePort();
    const ports = { dashboard: dashboardPort, mcp: mcpPort, control: controlPort };
    const child = spawnListener({ port: dashboardPort, cwd: stateDir, stateDirEnv: stateDir, home });
    fs.writeFileSync(path.join(stateDir, "dashboard.pid"), String(child.pid));
    assert.ok(await waitPortListening(dashboardPort), "verified listener bound");
    const record: any = { kind: REHEARSAL_DAEMON_KIND, status: "running", evidence: { pid: DEAD_DAEMON_PID } };
    const control = fakeControl({ daemonPid: DEAD_DAEMON_PID, ports, stopExit: 0 });
    const handler = makeRehearsalDaemonCleanupHandler({ control, record, fsx: fs, privateStateDir: stateDir, daemonPorts: ports });
    const res: any = await handler({ resources: {} });
    assert.equal(res.evidenced, true, `verified listener reaped and ports free: ${res.error ?? ""}`);
    assert.ok((res.stoppedListenerPids ?? []).some((s: any) => s.pid === child.pid), "the verified child is recorded as stopped");
    assert.equal(alive(child.pid!), false, "the verified child exited after the identity-verified signal");
    assert.equal(await probeTcpPortFree(dashboardPort), true, "the campaign dashboard port was released");
  });

  it("C7: missing state dir / daemon_ports makes the port check impossible -> evidenced:false", async () => {
    const record: any = { kind: REHEARSAL_DAEMON_KIND, status: "stopped", evidence: { pid: DEAD_DAEMON_PID } };
    const control = fakeControl({ daemonPid: DEAD_DAEMON_PID, ports: { dashboard: 1, mcp: 2, control: 3 } });
    const noStateDir = await makeRehearsalDaemonCleanupHandler({ control, record })({ resources: {} });
    assert.equal(noStateDir.evidenced, false);
    assert.match(String(noStateDir.error), /port check cannot run/);
    const noPorts = await makeRehearsalDaemonCleanupHandler({ control, record, privateStateDir: "/tmp/x" })({ resources: {} });
    assert.equal(noPorts.evidenced, false);
    assert.match(String(noPorts.error), /port check cannot run/);
  });

  it("C8: a production port is refused before any signal", async () => {
    const stateDir = ownedTmpDir("prod-state");
    const record: any = { kind: REHEARSAL_DAEMON_KIND, status: "stopped", evidence: { pid: DEAD_DAEMON_PID } };
    const control = fakeControl({ daemonPid: DEAD_DAEMON_PID, ports: { dashboard: 3334, mcp: 3338, control: 3339 } });
    const res = await makeRehearsalDaemonCleanupHandler({ control, record, fsx: fs, privateStateDir: stateDir, daemonPorts: { dashboard: 3334, mcp: 3338, control: 3339 } })({ resources: {} });
    assert.equal(res.evidenced, false);
    assert.match(String(res.error), /production/);
  });
});
