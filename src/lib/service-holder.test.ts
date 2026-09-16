/**
 * Tests for src/lib/service-holder.ts — portable listening-port holder
 * resolution (Linux `ss` and macOS `lsof` parsers, Tamandua cmdline proof).
 *
 * Classified serial: service-holder.ts reaches src/lib/proc-info.ts, which
 * imports node:child_process (spawnSync). All command output here is injected
 * via `opts.runCommand` / `opts.getCmdline`, so no real process is spawned.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isTamanduaServiceCmdline,
  parseLsofListenPids,
  parseSsListenPids,
  resolvePortHolder,
  resolvePortHolderPids,
  type RunCommandResult,
  type ServiceHolderOptions,
} from "../../dist/lib/service-holder.js";

// ── Fixtures ────────────────────────────────────────────────────────

const SS_OUTPUT = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      511          0.0.0.0:3339       0.0.0.0:*    users:(("node",pid=304091,fd=22))
LISTEN 0      511             [::]:3339          [::]:*    users:(("node",pid=304091,fd=23))
LISTEN 0      128          0.0.0.0:3334       0.0.0.0:*    users:(("node",pid=555,fd=18))
`;

const LSOF_OUTPUT = `COMMAND    PID     USER   FD      TYPE             DEVICE SIZE/OFF NODE NAME
node    304091 igorhvr   22u     IPv4 0x1234567890abcdef      0t0  TCP *:3339 (LISTEN)
node    304091 igorhvr   23u     IPv6 0xfedcba0987654321      0t0  TCP *:3339 (LISTEN)
node      555 igorhvr   18u     IPv4 0xabcdef0123456789      0t0  TCP *:3334 (LISTEN)
`;

/** RunCommand that always answers with one fixed stdout/status pair. */
function fixedRunner(result: RunCommandResult): {
  run: (command: string, args: string[]) => RunCommandResult;
  calls: Array<{ command: string; args: string[] }>;
} {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run: (command, args) => {
      calls.push({ command, args });
      return result;
    },
  };
}

// ── parseSsListenPids ───────────────────────────────────────────────

describe("parseSsListenPids", () => {
  it("extracts the pid for a listening 3339 row", () => {
    assert.deepEqual(parseSsListenPids(SS_OUTPUT, 3339), [304091]);
  });

  it("extracts the pid for a different requested port", () => {
    assert.deepEqual(parseSsListenPids(SS_OUTPUT, 3334), [555]);
  });

  it("dedupes IPv4/IPv6 rows for the same pid", () => {
    // Two 3339 rows both name 304091 (IPv4 + IPv6) — one pid out.
    assert.deepEqual(parseSsListenPids(SS_OUTPUT, 3339), [304091]);
  });

  it("collects every pid present in one users:((...)) column", () => {
    const multiPid = `${SS_OUTPUT}LISTEN 0      511          0.0.0.0:3339       0.0.0.0:*    users:(("node",pid=304091,fd=24),("node",pid=888,fd=25))
`;
    assert.deepEqual(parseSsListenPids(multiPid, 3339), [888, 304091]);
  });

  it("returns [] for empty output (free port)", () => {
    assert.deepEqual(parseSsListenPids("", 3339), []);
    assert.deepEqual(parseSsListenPids("State Recv-Q Send-Q Local Address:Port\n", 3339), []);
  });

  it("ignores other ports, header, and malformed lines", () => {
    const mixed = `State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process
LISTEN 0      511          0.0.0.0:13339      0.0.0.0:*    users:(("node",pid=1,fd=1))
LISTEN 0      511          0.0.0.0:33391      0.0.0.0:*    users:(("node",pid=2,fd=1))
garbage
LISTEN 0 511
LISTEN 0      511          0.0.0.0:3339       0.0.0.0:*
LISTEN 0      511       [::]:3339     [::]:*    users:(("bad",pid=notanumber,fd=9))
`;
    assert.deepEqual(parseSsListenPids(mixed, 3339), []);
  });
});

// ── parseLsofListenPids ─────────────────────────────────────────────

describe("parseLsofListenPids", () => {
  it("yields the LISTEN pid for the requested port", () => {
    assert.deepEqual(parseLsofListenPids(LSOF_OUTPUT, 3339), [304091]);
    assert.deepEqual(parseLsofListenPids(LSOF_OUTPUT, 3334), [555]);
  });

  it("skips the header and dedupes repeated fd rows", () => {
    assert.deepEqual(parseLsofListenPids(LSOF_OUTPUT, 3339), [304091]);
  });

  it("accepts a NAME without the trailing (LISTEN)", () => {
    const noListen = `COMMAND    PID     USER   FD      TYPE             DEVICE SIZE/OFF NODE NAME
node    304091 igorhvr   22u     IPv4 0x1234567890abcdef      0t0  TCP *:3339
`;
    assert.deepEqual(parseLsofListenPids(noListen, 3339), [304091]);
  });

  it("returns [] for empty output and ignores other ports/malformed rows", () => {
    assert.deepEqual(parseLsofListenPids("", 3339), []);
    const mixed = `COMMAND    PID     USER   FD      TYPE             DEVICE SIZE/OFF NODE NAME
node    304091 igorhvr   22u     IPv4 0x1234567890abcdef      0t0  TCP *:3334 (LISTEN)
node   notanumber igorhvr  22u     IPv4 0x1234567890abcdef      0t0  TCP *:3339 (LISTEN)
short line
`;
    assert.deepEqual(parseLsofListenPids(mixed, 3339), []);
  });
});

// ── isTamanduaServiceCmdline ────────────────────────────────────────

describe("isTamanduaServiceCmdline", () => {
  it("accepts a node daemon entry point for daemon", () => {
    assert.equal(
      isTamanduaServiceCmdline("node /opt/tamandua/dist/server/daemon.js --with-mcp", "daemon"),
      true,
    );
    assert.equal(isTamanduaServiceCmdline("node dist/server/daemon.js", "daemon"), true);
  });

  it("accepts dashboard/mcp standalone entry points", () => {
    assert.equal(
      isTamanduaServiceCmdline("node /home/u/tamandua/dist/server/dashboard-standalone.js", "dashboard"),
      true,
    );
    assert.equal(
      isTamanduaServiceCmdline("node /home/u/tamandua/dist/server/mcp-standalone.js", "mcp"),
      true,
    );
  });

  it("accepts a daemon holder for mcp (in-process --with-mcp)", () => {
    assert.equal(
      isTamanduaServiceCmdline("node /opt/tamandua/dist/server/daemon.js --with-mcp", "mcp"),
      true,
    );
  });

  it("rejects unrelated processes", () => {
    assert.equal(isTamanduaServiceCmdline("python -m http.server 3339", "daemon"), false);
    assert.equal(isTamanduaServiceCmdline("nginx: master process nginx", "dashboard"), false);
    assert.equal(isTamanduaServiceCmdline("node /home/u/app.js", "daemon"), false);
    assert.equal(isTamanduaServiceCmdline("", "daemon"), false);
  });

  it("does not cross-match one service kind for another", () => {
    assert.equal(
      isTamanduaServiceCmdline("node /opt/tamandua/dist/server/dashboard-standalone.js", "daemon"),
      false,
    );
    assert.equal(
      isTamanduaServiceCmdline("node /opt/tamandua/dist/server/mcp-standalone.js", "dashboard"),
      false,
    );
  });
});

// ── resolvePortHolderPids / resolvePortHolder ───────────────────────

describe("resolvePortHolderPids", () => {
  it("returns all pids on the port with no cmdline filtering (linux/ss)", () => {
    const { run, calls } = fixedRunner({ stdout: SS_OUTPUT, status: 0 });
    const opts: ServiceHolderOptions = { platform: "linux", runCommand: run };
    assert.deepEqual(resolvePortHolderPids(3339, opts), [304091]);
    assert.deepEqual(calls.map((c) => [c.command, ...c.args]), [["ss", "-ltnp"]]);
  });

  it("falls back to `ss -ltnpH` when `ss -ltnp` is unavailable", () => {
    const calls: string[][] = [];
    const opts: ServiceHolderOptions = {
      platform: "linux",
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        if (args[0] === "-ltnp") return { stdout: "", status: 1 };
        return { stdout: SS_OUTPUT, status: 0 };
      },
    };
    assert.deepEqual(resolvePortHolderPids(3339, opts), [304091]);
    assert.deepEqual(calls, [
      ["ss", "-ltnp"],
      ["ss", "-ltnpH"],
    ]);
  });

  it("uses lsof on darwin with the exact argv", () => {
    const { run, calls } = fixedRunner({ stdout: LSOF_OUTPUT, status: 0 });
    const opts: ServiceHolderOptions = { platform: "darwin", runCommand: run };
    assert.deepEqual(resolvePortHolderPids(3339, opts), [304091]);
    assert.deepEqual(calls, [{ command: "lsof", args: ["-nP", "-iTCP:3339", "-sTCP:LISTEN"] }]);
  });

  it("returns [] when the OS command is unavailable", () => {
    const { run } = fixedRunner({ stdout: "", status: null });
    assert.deepEqual(resolvePortHolderPids(3339, { platform: "linux", runCommand: run }), []);
    assert.deepEqual(resolvePortHolderPids(3339, { platform: "darwin", runCommand: run }), []);
  });
});

describe("resolvePortHolder", () => {
  const cmdlines = new Map<number, string>([
    [304091, "node /opt/tamandua/dist/server/daemon.js --with-mcp"],
    [555, "python -m http.server 3339"],
  ]);
  const getCmdline = (pid: number): string => cmdlines.get(pid) ?? "";

  it("returns the verified daemon holder (linux/ss)", () => {
    const { run } = fixedRunner({ stdout: SS_OUTPUT, status: 0 });
    const holder = resolvePortHolder(3339, "daemon", {
      platform: "linux",
      runCommand: run,
      getCmdline,
    });
    assert.deepEqual(holder, {
      pid: 304091,
      cmdline: "node /opt/tamandua/dist/server/daemon.js --with-mcp",
    });
  });

  it("returns the verified holder on darwin/lsof", () => {
    const { run } = fixedRunner({ stdout: LSOF_OUTPUT, status: 0 });
    const holder = resolvePortHolder(3339, "daemon", {
      platform: "darwin",
      runCommand: run,
      getCmdline,
    });
    assert.equal(holder?.pid, 304091);
  });

  it("returns null for a free port", () => {
    const { run } = fixedRunner({ stdout: "", status: 0 });
    assert.equal(
      resolvePortHolder(3339, "daemon", { platform: "linux", runCommand: run, getCmdline }),
      null,
    );
  });

  it("returns null when the holder cmdline is not a Tamandua service", () => {
    const { run } = fixedRunner({ stdout: SS_OUTPUT, status: 0 });
    assert.equal(
      resolvePortHolder(3334, "daemon", { platform: "linux", runCommand: run, getCmdline }),
      null,
    );
  });

  it("returns null when the holder cmdline cannot be read", () => {
    const { run } = fixedRunner({ stdout: SS_OUTPUT, status: 0 });
    assert.equal(
      resolvePortHolder(3339, "daemon", {
        platform: "linux",
        runCommand: run,
        getCmdline: () => "",
      }),
      null,
    );
  });

  it("returns null when the OS command is unavailable", () => {
    const { run } = fixedRunner({ stdout: "", status: null });
    assert.equal(
      resolvePortHolder(3339, "daemon", { platform: "linux", runCommand: run, getCmdline }),
      null,
    );
  });
});
