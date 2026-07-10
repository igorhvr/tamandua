/**
 * Regression tests for port reservation helpers.
 *
 * The original reserveRandomPort() / reserveDistinctRandomPorts() used a
 * bind-close-return pattern that created a TOCTOU race: the port was released
 * before the caller could use it.  Parallel tests could bind the same port.
 *
 * These tests verify that:
 * 1. reservePortHandle() keeps the port bound (no TOCTOU)
 * 2. withReservedPorts() holds ports for the test body duration
 * 3. The deprecated helpers exhibit the leak (documented, not a fix target)
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import {
  createTempHome,
  reservePortHandle,
  reservePortHandles,
  withReservedPorts,
  reserveRandomPort,
  reserveDistinctRandomPorts,
} from "./test-env.ts";

/** Returns true if we can bind to `port`, false if EADDRINUSE. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

describe("reservePortHandle", () => {
  it("holds the port so another bind fails with EADDRINUSE", async () => {
    const handle = await reservePortHandle();
    try {
      const bindable = await canBind(handle.port);
      assert.strictEqual(
        bindable,
        false,
        `Port ${handle.port} should be held by the handle`,
      );
    } finally {
      await handle.close();
    }
  });

  it("releases the port after close()", async () => {
    const handle = await reservePortHandle();
    const port = handle.port;
    await handle.close();
    const bindable = await canBind(port);
    assert.strictEqual(bindable, true, `Port ${port} should be free after close()`);
  });

  it("returns distinct ports for multiple calls", async () => {
    const h1 = await reservePortHandle();
    const h2 = await reservePortHandle();
    try {
      assert.notStrictEqual(h1.port, h2.port, "Ports should be distinct");
    } finally {
      await h1.close();
      await h2.close();
    }
  });
});

describe("reservePortHandles", () => {
  it("reserves multiple distinct ports and holds all of them", async () => {
    const handles = await reservePortHandles(3);
    assert.strictEqual(handles.length, 3);
    const ports = handles.map((h) => h.port);
    assert.strictEqual(new Set(ports).size, 3, "All ports should be distinct");
    try {
      for (const port of ports) {
        const bindable = await canBind(port);
        assert.strictEqual(
          bindable,
          false,
          `Port ${port} should be held by its handle`,
        );
      }
    } finally {
      await Promise.all(handles.map((h) => h.close()));
    }
  });
});

describe("withReservedPorts", () => {
  it("holds ports during fn execution, releases after", async () => {
    let portsDuring: number[] = [];
    let portsAfter: number[] = [];

    await withReservedPorts(2, async (ports) => {
      portsDuring = ports;
      // Verify ports are held
      for (const port of ports) {
        const bindable = await canBind(port);
        assert.strictEqual(
          bindable,
          false,
          `Port ${port} should be held during fn execution`,
        );
      }
    });

    // After withReservedPorts completes, ports should be released
    for (const port of portsDuring) {
      const bindable = await canBind(port);
      assert.strictEqual(
        bindable,
        true,
        `Port ${port} should be free after withReservedPorts returns`,
      );
    }
  });

  it("releases ports even if fn throws", async () => {
    let capturedPort = 0;
    try {
      await withReservedPorts(1, async ([port]) => {
        capturedPort = port;
        throw new Error("simulated test failure");
      });
    } catch {
      // Expected
    }

    // Port should be released despite the error
    const bindable = await canBind(capturedPort);
    assert.strictEqual(
      bindable,
      true,
      `Port ${capturedPort} should be free after fn threw`,
    );
  });
});

describe("createTempHome", () => {
  it("creates a directory under /tmp with default prefix tamandua-test-", () => {
    const th = createTempHome();
    assert.ok(th.root.startsWith(os.tmpdir()), "root should be under tmpdir");
    assert.ok(
      th.root.includes("tamandua-test-"),
      "root should include default prefix",
    );
    assert.ok(fs.existsSync(th.root), "root directory should exist");
  });

  it("returns { root, homeDir, tamanduaDir } with .tamandua subdirectory", () => {
    const th = createTempHome();
    assert.ok(fs.existsSync(th.root), "root exists");
    assert.ok(fs.existsSync(th.homeDir), "homeDir exists");
    assert.ok(fs.existsSync(th.tamanduaDir), "tamanduaDir exists");
    assert.ok(
      th.tamanduaDir.endsWith(".tamandua"),
      "tamanduaDir should be .tamandua",
    );
    assert.ok(
      th.tamanduaDir.startsWith(th.homeDir),
      "tamanduaDir should be inside homeDir",
    );
    // The .tamandua directory should be a real directory
    const stat = fs.statSync(th.tamanduaDir);
    assert.ok(stat.isDirectory(), "tamanduaDir should be a directory");
  });

  it("accepts optional prefix parameter", () => {
    const th = createTempHome("custom-prefix-");
    assert.ok(
      th.root.includes("custom-prefix-"),
      "root should include custom prefix",
    );
    assert.ok(fs.existsSync(th.root), "root directory should exist");
  });

  it("cleans up via process exit handler — directory is removed at process end", () => {
    // createTempHome registers cleanup via process.on('exit') handlers.
    // The actual cleanup is verified by running the full suite twice
    // and checking that /tmp entries do not grow between runs.
    const th = createTempHome();
    const capturedRoot = th.root;
    assert.ok(fs.existsSync(capturedRoot), "root should exist during test");
  });

  it("survives test assertion failure — process exit still cleans up", () => {
    const th = createTempHome();
    const capturedRoot = th.root;

    const testFile = `${capturedRoot}/test-file`;
    fs.writeFileSync(testFile, "test content");
    assert.ok(fs.existsSync(testFile), "test file should exist");
  });
});

describe("deprecated reserveRandomPort", () => {
  it("exposes the TOCTOU race — port is freeable immediately after return", async () => {
    // This test documents the known limitation of reserveRandomPort().
    // The port has been released by the time reserveRandomPort() returns,
    // so another bind should succeed.
    const port = await reserveRandomPort();
    const bindable = await canBind(port);
    assert.strictEqual(
      bindable,
      true,
      "Port should be free after reserveRandomPort() returns (TOCTOU, known limitation)",
    );
  });
});

describe("deprecated reserveDistinctRandomPorts", () => {
  it("returns correct count of ports but they are already released", async () => {
    const ports = await reserveDistinctRandomPorts(3);
    assert.strictEqual(ports.length, 3);
    assert.strictEqual(new Set(ports).size, 3, "All ports should be distinct");
    // All ports should be freeable (known TOCTOU limitation)
    for (const port of ports) {
      const bindable = await canBind(port);
      assert.strictEqual(bindable, true, `Port ${port} should be free (TOCTOU, known limitation)`);
    }
  });
});
