import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  getControlPlaneHelp,
  getControlPlaneRestartHelp,
  getControlPlaneStartHelp,
  getControlPlaneStatusHelp,
  getControlPlaneStopHelp,
  getDaemonHelp,
  getDaemonRestartHelp,
  getDaemonStartHelp,
  getDaemonStatusHelp,
  getDaemonStopHelp,
  handleDaemon,
} from "../../../dist/cli/commands/daemon.js";
import type { DaemonCommandDeps } from "../../../dist/cli/commands/daemon.js";

/** Capture stdout + stderr for one handler invocation. */
async function captureRun(fn: () => Promise<unknown>): Promise<{ logs: string[]; errs: string[] }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = process.stderr.write;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errs.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    console.log = origLog;
    process.stderr.write = origErr;
  }
  return { logs, errs };
}

const FOREIGN = { pid: 304091, port: 3339, stateDir: "/home/other/.tamandua" };
const FOREIGN_LINE =
  "another Tamandua daemon (pid 304091, port 3339, state dir /home/other/.tamandua)";

describe("SPL2 daemon and control-plane command module", () => {
  it("is backed by a daemon command source module", () => {
    assert.equal(existsSync(join(process.cwd(), "src/cli/commands/daemon.ts")), true);
  });

  it("owns daemon group and lifecycle subcommand help", () => {
    assert.match(getDaemonHelp(), /tamandua daemon <start\|stop\|restart\|status>/);
    assert.match(getDaemonStartHelp(), /tamandua daemon start \[--port N\]/);
    assert.match(getDaemonStopHelp(), /tamandua daemon stop/);
    assert.match(getDaemonRestartHelp(), /tamandua daemon restart \[--port N\]/);
    assert.match(getDaemonStatusHelp(), /tamandua daemon status/);
  });

  it("owns alias-specific control-plane help", () => {
    assert.match(getControlPlaneHelp(), /tamandua control-plane <start\|stop\|restart\|status>/);
    assert.match(getControlPlaneStartHelp(), /Alias for tamandua daemon start/);
    assert.match(getControlPlaneStopHelp(), /Alias for tamandua daemon stop/);
    assert.match(getControlPlaneRestartHelp(), /Alias for tamandua daemon restart/);
    assert.match(getControlPlaneStatusHelp(), /Alias for tamandua daemon status/);
  });

  it("declines commands owned by other command groups", async () => {
    assert.equal(await handleDaemon("dashboard", ["dashboard", "status"]), false);
  });

  it("documents takeover stop/status in help", () => {
    assert.match(getDaemonStopHelp(), /takeover-aware/i);
    assert.match(getDaemonStopHelp(), /SIGKILL/i);
    assert.match(getDaemonStopHelp(), /TAMANDUA_TAKEOVER_GRACE_MS/);
    assert.match(getDaemonStatusHelp(), /source/i);
    assert.match(getDaemonStatusHelp(), /socket/);
    assert.match(getDaemonStatusHelp(), /port-holder/);
  });

  it("daemon stop awaits the takeover stop and prints escalated/port-free state", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const handled = await handleDaemon("daemon", ["daemon", "stop"], {
        stopDaemonAsync: async () => {
          calls.push("stopDaemonAsync");
          return { stopped: true, pid: 4242, escalated: true, portFree: true };
        },
      });
      assert.equal(handled, true);
    } finally {
      console.log = origLog;
    }
    assert.deepEqual(calls, ["stopDaemonAsync"], "stop must use the async takeover path");
    assert.match(logs.join("\n"), /stopped \(PID 4242/);
    assert.match(logs.join("\n"), /escalated to SIGKILL/);
    assert.match(logs.join("\n"), /port free/);
  });

  it("daemon stop reports not-running when nothing was resolved", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await handleDaemon("daemon", ["daemon", "stop"], {
        stopDaemonAsync: async () => ({ stopped: false, escalated: false, portFree: true }),
      });
    } finally {
      console.log = origLog;
    }
    assert.match(logs.join("\n"), /Daemon is not running\./);
  });

  it("daemon status prints the pid and resolution source", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await handleDaemon("daemon", ["daemon", "status"], {
        getDaemonStatusAsync: async () => ({
          running: true,
          pid: 5151,
          port: 4444,
          source: "port-holder",
        }),
      });
    } finally {
      console.log = origLog;
    }
    assert.match(logs.join("\n"), /running \(PID 5151, source port-holder\)/);
  });

  it("control-plane aliases use the same injection seams", async () => {
    let called = 0;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      await handleDaemon("control-plane", ["control-plane", "stop"], {
        stopDaemonAsync: async () => {
          called += 1;
          return { stopped: true, pid: 6161, escalated: false, portFree: true };
        },
      });
    } finally {
      console.log = origLog;
    }
    assert.equal(called, 1);
    assert.match(logs.join("\n"), /Control plane stopped \(PID 6161/);
  });

  it("daemon start --port threads the requested port into the status check and the spawn", async () => {
    const seenOpts: Array<unknown> = [];
    const startedPorts: Array<number | undefined> = [];
    const { logs } = await captureRun(() =>
      handleDaemon("daemon", ["daemon", "start", "--port", "6060"], {
        getDaemonStatusAsync: async (opts) => {
          seenOpts.push(opts);
          return { running: false, pid: null, port: 6060, source: null, foreignHolder: null };
        },
        startDaemon: (async (port?: number) => {
          startedPorts.push(port);
          return { pid: 9001, port: port ?? 3339 };
        }) as unknown as NonNullable<DaemonCommandDeps["startDaemon"]>,
      }),
    );
    // The freshness check inspects exactly the port we are about to bind.
    assert.deepEqual(seenOpts, [{ port: 6060 }]);
    assert.deepEqual(startedPorts, [6060]);
    assert.match(logs.join("\n"), /Daemon started \(PID 9001\)/);
  });

  it("daemon start <port> positional threads the requested port", async () => {
    const seenOpts: Array<unknown> = [];
    const startedPorts: Array<number | undefined> = [];
    const { logs } = await captureRun(() =>
      handleDaemon("daemon", ["daemon", "start", "6061"], {
        getDaemonStatusAsync: async (opts) => {
          seenOpts.push(opts);
          return { running: false, pid: null, port: 6061, source: null, foreignHolder: null };
        },
        startDaemon: (async (port?: number) => {
          startedPorts.push(port);
          return { pid: 9002, port: port ?? 3339 };
        }) as unknown as NonNullable<DaemonCommandDeps["startDaemon"]>,
      }),
    );
    assert.deepEqual(seenOpts, [{ port: 6061 }]);
    assert.deepEqual(startedPorts, [6061]);
    assert.match(logs.join("\n"), /Daemon started \(PID 9002\)/);
  });

  it("daemon start reports a foreign daemon and still starts on the configured port", async () => {
    const startedPorts: Array<number | undefined> = [];
    const { logs, errs } = await captureRun(() =>
      handleDaemon("control-plane", ["control-plane", "start", "--port", "6062"], {
        getDaemonStatusAsync: async () => ({
          running: false,
          pid: null,
          port: 6062,
          source: null,
          foreignHolder: FOREIGN,
        }),
        startDaemon: (async (port?: number) => {
          startedPorts.push(port);
          return { pid: 9003, port: port ?? 3339 };
        }) as unknown as NonNullable<DaemonCommandDeps["startDaemon"]>,
      }),
    );
    // Foreign daemon is reported on stderr but never blocks the start.
    assert.ok(errs.join("\n").includes(FOREIGN_LINE), `Expected foreign line, got: ${errs.join("\n")}`);
    assert.deepEqual(startedPorts, [6062]);
    assert.match(logs.join("\n"), /Control plane started \(PID 9003\)/);
  });

  it("daemon status reports a foreign daemon and stays not running", async () => {
    const { logs, errs } = await captureRun(() =>
      handleDaemon("daemon", ["daemon", "status"], {
        getDaemonStatusAsync: async () => ({
          running: false,
          pid: null,
          port: 3339,
          source: null,
          foreignHolder: FOREIGN,
        }),
      }),
    );
    assert.match(logs.join("\n"), /Daemon is not running\./);
    assert.ok(errs.join("\n").includes(FOREIGN_LINE), `Expected foreign line, got: ${errs.join("\n")}`);
  });

  it("daemon stop reports a foreign daemon without signalling it", async () => {
    let stopCalled = 0;
    const { logs, errs } = await captureRun(() =>
      handleDaemon("control-plane", ["control-plane", "stop"], {
        stopDaemonAsync: async () => {
          stopCalled += 1;
          return { stopped: false, escalated: false, portFree: true, foreignHolder: FOREIGN };
        },
      }),
    );
    assert.equal(stopCalled, 1);
    assert.match(logs.join("\n"), /Control plane is not running\./);
    assert.ok(errs.join("\n").includes(FOREIGN_LINE), `Expected foreign line, got: ${errs.join("\n")}`);
  });
});
