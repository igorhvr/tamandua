/**
 * Tests for the DPID Unix-domain socket daemon identity primitive.
 *
 * Entirely in-process with a private temp state dir: no daemon is spawned, no
 * real ~/.tamandua path is touched, and no production port is bound. The
 * sockets live under the per-test temp home, so the test-isolation guard stays
 * satisfied.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createTempHome, type TempHome } from "../../tests/helpers/test-env.ts";
import {
  bindIdentitySocket,
  getServiceSocketPath,
  IdentitySocketInUseError,
  isDaemonIdentity,
  parseIdentityLine,
  probeIdentitySocket,
  DEFAULT_PROBE_TIMEOUT_MS,
  type BoundIdentitySocket,
  type DaemonIdentity,
} from "../../dist/server/daemon-identity.js";

function makeIdentity(overrides: Partial<DaemonIdentity> = {}): DaemonIdentity {
  return {
    pid: 4242,
    buildVersion: "9.9.9-test",
    controlPort: 45999,
    startedAt: "2026-09-16T02:00:00.000Z",
    ...overrides,
  };
}

describe("daemon-identity", () => {
  let home: TempHome;
  let openSockets: BoundIdentitySocket[];
  let rawServers: net.Server[];

  beforeEach(() => {
    home = createTempHome("tamandua-identity-");
    openSockets = [];
    rawServers = [];
  });

  afterEach(async () => {
    for (const bound of openSockets) {
      await bound.close();
    }
    openSockets = [];
    for (const server of rawServers) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rawServers = [];
    fs.rmSync(home.root, { recursive: true, force: true });
  });

  const socketPath = (service: "daemon" | "dashboard" | "mcp" = "daemon"): string =>
    getServiceSocketPath(service, { homeDir: home.homeDir });

  async function bind(
    identity: DaemonIdentity = makeIdentity(),
    service: "daemon" | "dashboard" | "mcp" = "daemon",
  ): Promise<{ bound: BoundIdentitySocket; identity: DaemonIdentity; p: string }> {
    const p = socketPath(service);
    const bound = await bindIdentitySocket(p, identity);
    openSockets.push(bound);
    return { bound, identity, p };
  }

  async function startRawServer(
    service: "daemon" | "dashboard" | "mcp",
    onConnection?: (socket: net.Socket) => void,
  ): Promise<{ server: net.Server; p: string }> {
    const p = socketPath(service);
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      // Consume the probe request so the peer's FIN is processed and
      // server.close() cannot hang on a half-open socket.
      socket.resume();
      onConnection?.(socket);
    });
    rawServers.push(server);
    await new Promise<void>((resolve) => server.listen(p, () => resolve()));
    return { server, p };
  }

  describe("getServiceSocketPath", () => {
    it("returns <homeDir>/.tamandua/daemon.sock for daemon", () => {
      assert.equal(
        getServiceSocketPath("daemon", { homeDir: home.homeDir }),
        path.join(home.homeDir, ".tamandua", "daemon.sock"),
      );
    });

    it("uses dashboard.sock and mcp.sock for the other services", () => {
      assert.equal(socketPath("dashboard"), path.join(home.homeDir, ".tamandua", "dashboard.sock"));
      assert.equal(socketPath("mcp"), path.join(home.homeDir, ".tamandua", "mcp.sock"));
    });

    it("honors TAMANDUA_STATE_DIR when no homeDir option is given", () => {
      const stateDir = path.join(home.homeDir, "custom-state");
      const prevStateDir = process.env.TAMANDUA_STATE_DIR;
      process.env.TAMANDUA_STATE_DIR = stateDir;
      try {
        assert.equal(
          getServiceSocketPath("daemon"),
          path.join(stateDir, "daemon.sock"),
        );
      } finally {
        if (prevStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
        else process.env.TAMANDUA_STATE_DIR = prevStateDir;
      }
    });
  });

  describe("identity validation", () => {
    it("isDaemonIdentity accepts a complete identity", () => {
      assert.equal(isDaemonIdentity(makeIdentity()), true);
    });

    it("isDaemonIdentity rejects missing/invalid fields", () => {
      assert.equal(isDaemonIdentity(null), false);
      assert.equal(isDaemonIdentity("nope"), false);
      assert.equal(isDaemonIdentity({}), false);
      assert.equal(isDaemonIdentity([]), false);
      assert.equal(isDaemonIdentity(makeIdentity({ pid: 0 })), false);
      assert.equal(isDaemonIdentity(makeIdentity({ pid: -7 })), false);
      assert.equal(isDaemonIdentity(makeIdentity({ pid: 1.5 })), false);
      assert.equal(isDaemonIdentity({ ...makeIdentity(), pid: "42" }), false);
      assert.equal(isDaemonIdentity({ ...makeIdentity(), buildVersion: 7 }), false);
      assert.equal(isDaemonIdentity(makeIdentity({ controlPort: 0 })), false);
      assert.equal(isDaemonIdentity(makeIdentity({ controlPort: 70000 })), false);
      assert.equal(isDaemonIdentity({ ...makeIdentity(), controlPort: "3339" }), false);
      assert.equal(isDaemonIdentity(makeIdentity({ startedAt: "" })), false);
      assert.equal(isDaemonIdentity({ ...makeIdentity(), startedAt: 5 }), false);
    });

    it("isDaemonIdentity accepts an optional non-empty stateDir", () => {
      // Absent (pre-DPID payload) stays valid.
      assert.equal(isDaemonIdentity(makeIdentity()), true);
      assert.equal(isDaemonIdentity({ ...makeIdentity(), stateDir: undefined }), true);
      // Present must be a non-empty string.
      assert.equal(
        isDaemonIdentity({ ...makeIdentity(), stateDir: path.join(home.homeDir, ".tamandua") }),
        true,
      );
      assert.equal(isDaemonIdentity({ ...makeIdentity(), stateDir: "" }), false);
      assert.equal(isDaemonIdentity({ ...makeIdentity(), stateDir: 7 }), false);
      assert.equal(isDaemonIdentity({ ...makeIdentity(), stateDir: null }), false);
    });

    it("parseIdentityLine parses a valid line and returns null otherwise", () => {
      const identity = makeIdentity();
      assert.deepEqual(parseIdentityLine(JSON.stringify(identity)), identity);
      assert.deepEqual(parseIdentityLine(`  ${JSON.stringify(identity)}  `), identity);
      const withStateDir = makeIdentity({ stateDir: path.join(home.homeDir, ".tamandua") });
      assert.deepEqual(parseIdentityLine(JSON.stringify(withStateDir)), withStateDir);
      assert.equal(parseIdentityLine(""), null);
      assert.equal(parseIdentityLine("   "), null);
      assert.equal(parseIdentityLine("not json"), null);
      assert.equal(parseIdentityLine("null"), null);
      assert.equal(parseIdentityLine("[1,2,3]"), null);
      assert.equal(parseIdentityLine(JSON.stringify({ pid: 1 })), null);
    });
  });

  describe("probeIdentitySocket", () => {
    it("round-trips the exact identity after a bind", async () => {
      const { identity, p } = await bind();
      const probed = await probeIdentitySocket(p);
      assert.deepEqual(probed, identity);
      assert.equal(probed?.pid, identity.pid);
      assert.equal(probed?.buildVersion, identity.buildVersion);
      assert.equal(probed?.controlPort, identity.controlPort);
      assert.equal(probed?.startedAt, identity.startedAt);
    });

    it("round-trips a stateDir-bearing identity after a bind", async () => {
      const stateDir = path.join(home.homeDir, ".tamandua");
      const { identity, p } = await bind(makeIdentity({ stateDir }));
      const probed = await probeIdentitySocket(p);
      assert.deepEqual(probed, identity);
      assert.equal(probed?.stateDir, stateDir);
    });

    it("round-trips an identity without stateDir (pre-DPID payload)", async () => {
      const { identity, p } = await bind(makeIdentity());
      const probed = await probeIdentitySocket(p);
      assert.equal(probed?.stateDir, undefined);
      assert.deepEqual(probed, identity);
    });

    it("returns null for a missing path", async () => {
      const missing = path.join(home.homeDir, ".tamandua", "does-not-exist.sock");
      assert.equal(fs.existsSync(missing), false);
      assert.equal(await probeIdentitySocket(missing), null);
      assert.equal(await probeIdentitySocket(missing, 25), null);
    });

    it("returns null when a stale socket file has no listener (ECONNREFUSED)", async () => {
      const { server, p } = await startRawServer("daemon");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Node leaves the Unix socket file behind on close — a crash-shaped stale file.
      if (!fs.existsSync(p)) fs.writeFileSync(p, "stale");
      assert.equal(await probeIdentitySocket(p, 100), null);
    });

    it("returns null for a corrupt identity payload", async () => {
      const { p } = await startRawServer("daemon", (socket) => socket.end("this is not json\n"));
      assert.equal(await probeIdentitySocket(p, 500), null);
    });

    it("returns null for a valid-JSON but invalid identity payload", async () => {
      const { p } = await startRawServer("daemon", (socket) =>
        socket.end(JSON.stringify({ pid: -1, buildVersion: 3 }) + "\n"),
      );
      assert.equal(await probeIdentitySocket(p, 500), null);
    });

    it("returns null when the server accepts but never answers (timeout)", async () => {
      const { p } = await startRawServer("daemon"); // accepts, never writes
      const started = Date.now();
      assert.equal(await probeIdentitySocket(p, 50), null);
      assert.ok(Date.now() - started < 5000, "probe must honor the injected timeout");
    });

    it("uses a short default timeout constant", () => {
      assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 500);
    });
  });

  describe("bindIdentitySocket", () => {
    it("creates the socket file with owner-only mode", async () => {
      const { p } = await bind();
      assert.equal(fs.existsSync(p), true);
      if (process.platform !== "win32") {
        assert.equal(fs.statSync(p).mode & 0o777, 0o600);
      }
    });

    it("creates missing parent directories", async () => {
      const nested = path.join(home.homeDir, ".tamandua", "nested", "daemon.sock");
      const bound = await bindIdentitySocket(nested, makeIdentity());
      openSockets.push(bound);
      assert.equal(fs.existsSync(nested), true);
      assert.deepEqual(await probeIdentitySocket(nested), makeIdentity());
    });

    it("unlinks and rebinds a pre-existing stale socket file", async () => {
      const { server, p } = await startRawServer("daemon");
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (!fs.existsSync(p)) fs.writeFileSync(p, "stale");

      const identity = makeIdentity({ pid: 7777 });
      const bound = await bindIdentitySocket(p, identity);
      openSockets.push(bound);

      assert.deepEqual(await probeIdentitySocket(p), identity);
    });

    it("throws a typed error naming the live pid and leaves the first listener answering", async () => {
      const identity = makeIdentity({ pid: 8888, controlPort: 46123 });
      const { p } = await bind(identity);

      await assert.rejects(
        () => bindIdentitySocket(p, makeIdentity({ pid: 9999 })),
        (err: unknown) => {
          assert.ok(err instanceof IdentitySocketInUseError, "must be IdentitySocketInUseError");
          assert.equal(err.code, "EIDENTITYINUSE");
          assert.equal(err.pid, 8888);
          assert.equal(err.socketPath, p);
          assert.deepEqual(err.identity, identity);
          assert.match(err.message, /8888/);
          return true;
        },
      );

      // The live owner must be untouched and still answer.
      assert.deepEqual(await probeIdentitySocket(p), identity);
    });

    it("close() removes the socket file and a probe afterwards returns null", async () => {
      const { bound, p } = await bind();
      await bound.close();
      assert.equal(fs.existsSync(p), false);
      assert.equal(await probeIdentitySocket(p, 100), null);
      // Idempotent: a second close must not throw.
      await bound.close();
      assert.equal(await probeIdentitySocket(p, 100), null);
    });

    it("rebinds after a close, and the fresh listener wins", async () => {
      const first = makeIdentity({ pid: 1111 });
      const second = makeIdentity({ pid: 2222, controlPort: 46222 });
      const { bound, p } = await bind(first);
      await bound.close();

      const rebound = await bindIdentitySocket(p, second);
      openSockets.push(rebound);
      assert.deepEqual(await probeIdentitySocket(p), second);
    });

    it("rejects an invalid identity", async () => {
      await assert.rejects(
        () => bindIdentitySocket(socketPath(), { pid: 0 } as unknown as DaemonIdentity),
        TypeError,
      );
      assert.equal(fs.existsSync(socketPath()), false);
    });
  });
});
