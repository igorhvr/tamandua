import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTempHome } from "../../tests/helpers/test-env.ts";

import {
  getHarnessAdapter,
  type HarnessAdapter,
  type HarnessRoundResult,
  type RunHarnessOptions,
} from "../../dist/installer/harness-adapter.js";


// ── HarnessAdapter interface contract ──────────────────────────────

describe("HarnessAdapter interface", () => {
  it("exports HarnessAdapter type", () => {
    // Type-only — existence verified at compile time.
    // Rely on getHarnessAdapter returning objects that satisfy the interface.
  });

  it("exports HarnessRoundResult type", () => {
    const r: HarnessRoundResult = { output: "test", stderrTail: "" };
    assert.equal(r.output, "test");
    assert.equal(r.sessionRef, undefined);
    const rWithSession: HarnessRoundResult = {
      output: "test",
      stderrTail: "",
      sessionRef: "sess-123",
    };
    assert.equal(rWithSession.sessionRef, "sess-123");
  });

  it("exports RunHarnessOptions type", () => {
    const opts: RunHarnessOptions = {
      timeout: 120,
      workdir: "/tmp",
      env: { FOO: "bar" },
      onSpawn: () => {},
      preferTokenSaver: true,
    };
    assert.equal(opts.timeout, 120);
    assert.equal(opts.workdir, "/tmp");
    assert.deepEqual(opts.env, { FOO: "bar" });
    assert.equal(opts.preferTokenSaver, true);
  });
});

// ── getHarnessAdapter factory ──────────────────────────────────────

describe("getHarnessAdapter", () => {
  it('returns a PiHarnessAdapter for "pi"', () => {
    const adapter = getHarnessAdapter("pi");
    assert.equal(adapter.type, "pi");
  });

  it('returns a HermesHarnessAdapter for "hermes"', () => {
    const adapter = getHarnessAdapter("hermes");
    assert.equal(adapter.type, "hermes");
  });

  it("throws for unknown harness type", () => {
    assert.throws(
      () => getHarnessAdapter("unknown"),
      /unknown harness type/,
    );
  });

  it("throws for empty string", () => {
    assert.throws(
      () => getHarnessAdapter(""),
      /unknown harness type/,
    );
  });

  it("throws for arbitrary unrecognized value", () => {
    assert.throws(
      () => getHarnessAdapter("foo-bar"),
      /unknown harness type/,
    );
  });
});

// ── PiHarnessAdapter implementation ────────────────────────────────

describe("PiHarnessAdapter implementation", () => {
  const adapter = getHarnessAdapter("pi");

  it("has type 'pi'", () => {
    assert.equal(adapter.type, "pi");
  });

  describe("findBinary", () => {
    let savedPiBinary: string | undefined;
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPiBinary = process.env.TAMANDUA_PI_BINARY;
      savedPath = process.env.PATH;
    });

    afterEach(() => {
      if (savedPiBinary === undefined) {
        delete process.env.TAMANDUA_PI_BINARY;
      } else {
        process.env.TAMANDUA_PI_BINARY = savedPiBinary;
      }
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      }
    });

    it("respects TAMANDUA_PI_BINARY env var when set and executable", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-pi-");
      const piPath = path.join(tmpDir, "pi");
      fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });

      process.env.TAMANDUA_PI_BINARY = piPath;

      const result = await adapter.findBinary();
      assert.equal(result, piPath);


    });

    it("throws when TAMANDUA_PI_BINARY is set but not executable", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-pi-");
      const piPath = path.join(tmpDir, "pi-broken");
      fs.writeFileSync(piPath, "#!/bin/sh\necho nope\n", { mode: 0o644 });

      process.env.TAMANDUA_PI_BINARY = piPath;

      await assert.rejects(
        () => adapter.findBinary(),
        /TAMANDUA_PI_BINARY set but not executable/
      );


    });

    it("throws clear error when pi not found in PATH and no env var set", async () => {
      delete process.env.TAMANDUA_PI_BINARY;

      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-pi-");
      process.env.PATH = tmpDir;

      await assert.rejects(
        () => adapter.findBinary(),
        /pi binary not found in PATH/
      );


    });

    it("prefers pi-token-saver over pi when preferTokenSaver is true and both exist", async () => {
      delete process.env.TAMANDUA_PI_BINARY;

      const { root: binDir } = createTempHome("tamandua-test-harness-adapter-ts-");
      const piPath = path.join(binDir, "pi");
      const saverPath = path.join(binDir, "pi-token-saver");
      fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });
      fs.writeFileSync(saverPath, "#!/bin/sh\necho saver\n", { mode: 0o755 });

      process.env.PATH = binDir;

      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), saverPath);
      assert.equal(await adapter.findBinary({ preferTokenSaver: false }), piPath);
      assert.equal(await adapter.findBinary(), piPath);


    });

    it("falls back to pi when pi-token-saver is not installed", async () => {
      delete process.env.TAMANDUA_PI_BINARY;

      const { root: binDir } = createTempHome("tamandua-test-harness-adapter-ts-");
      const piPath = path.join(binDir, "pi");
      fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });

      process.env.PATH = binDir;

      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), piPath);


    });

    it("TAMANDUA_PI_BINARY overrides pi-token-saver preference", async () => {
      const { root: binDir } = createTempHome("tamandua-test-harness-adapter-ts-");
      const piPath = path.join(binDir, "pi");
      const saverPath = path.join(binDir, "pi-token-saver");
      const pinnedPath = path.join(binDir, "pinned-pi");
      fs.writeFileSync(piPath, "#!/bin/sh\necho pi\n", { mode: 0o755 });
      fs.writeFileSync(saverPath, "#!/bin/sh\necho saver\n", { mode: 0o755 });
      fs.writeFileSync(pinnedPath, "#!/bin/sh\necho pinned\n", { mode: 0o755 });

      process.env.PATH = binDir;
      process.env.TAMANDUA_PI_BINARY = pinnedPath;

      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), pinnedPath);


    });
  });

  describe("runRound", () => {
    it("spawns pi with correct argv and returns HarnessRoundResult", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-runround-");
      const fakePi = path.join(tmpDir, "pi");
      fs.writeFileSync(
        fakePi,
        "#!/usr/bin/env node\nprocess.stdout.write('hello-from-adapter');\n",
        "utf-8"
      );
      fs.chmodSync(fakePi, 0o755);

      const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;

      try {
        const result = await adapter.runRound("test prompt", {
          timeout: 3,
          workdir: tmpDir,
        });

        assert.equal(result.output, "hello-from-adapter");
        assert.equal(result.stderrTail, "");
        assert.equal(result.sessionRef, undefined);
      } finally {
        if (originalPiBinary === undefined) {
          delete process.env.TAMANDUA_PI_BINARY;
        } else {
          process.env.TAMANDUA_PI_BINARY = originalPiBinary;
        }

      }
    });

    it("resolves on non-zero exit — returns output with exitCode populated", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-runround-");
      const fakePi = path.join(tmpDir, "pi");
      fs.writeFileSync(
        fakePi,
        "#!/usr/bin/env node\nprocess.exit(7);\n",
        "utf-8"
      );
      fs.chmodSync(fakePi, 0o755);

      const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;

      try {
        // Adapter now resolves on non-zero exit (like hermes) so the scheduler
        // can populate worker_lost events with real exitCode/signal/stderrTail.
        const result = await adapter.runRound("prompt", { timeout: 3, workdir: tmpDir });
        assert.equal(result.exitCode, 7);
        assert.equal(result.signal, undefined);
        assert.equal(result.timedOut, undefined);
        assert.equal(result.stderrTail, "");
      } finally {
        if (originalPiBinary === undefined) {
          delete process.env.TAMANDUA_PI_BINARY;
        } else {
          process.env.TAMANDUA_PI_BINARY = originalPiBinary;
        }

      }
    });

    it("resolves on timeout with an empty string stderrTail when the child writes no stderr", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-runround-");
      const fakePi = path.join(tmpDir, "pi");
      fs.writeFileSync(fakePi, "#!/bin/sh\nsleep 10", "utf-8");
      fs.chmodSync(fakePi, 0o755);

      const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;

      try {
        const result = await adapter.runRound("prompt", { timeout: 0.05, workdir: tmpDir });
        assert.equal(result.exitCode, null);
        assert.equal(result.signal, "SIGTERM");
        assert.equal(result.timedOut, true);
        assert.equal(typeof result.stderrTail, "string");
        assert.equal(result.stderrTail, "");
      } finally {
        if (originalPiBinary === undefined) {
          delete process.env.TAMANDUA_PI_BINARY;
        } else {
          process.env.TAMANDUA_PI_BINARY = originalPiBinary;
        }
      }
    });

    it("resolves on timeout with stderrTail populated from pre-timeout stderr", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-runround-");
      const fakePi = path.join(tmpDir, "pi");
      fs.writeFileSync(
        fakePi,
        "#!/bin/sh\necho 'stderr output' >&2\nsleep 10",
        "utf-8"
      );
      fs.chmodSync(fakePi, 0o755);

      const originalPiBinary = process.env.TAMANDUA_PI_BINARY;
      process.env.TAMANDUA_PI_BINARY = fakePi;

      try {
        const result = await adapter.runRound("prompt", { timeout: 5, workdir: tmpDir });
        assert.equal(result.exitCode, null);
        assert.equal(result.signal, "SIGTERM");
        assert.equal(result.timedOut, true);
        assert.ok(result.stderrTail.includes("stderr output"));
      } finally {
        if (originalPiBinary === undefined) {
          delete process.env.TAMANDUA_PI_BINARY;
        } else {
          process.env.TAMANDUA_PI_BINARY = originalPiBinary;
        }

      }
    });
  });
});

describe("HermesHarnessAdapter implementation", () => {
  const adapter = getHarnessAdapter("hermes");

  it("has type 'hermes'", () => {
    assert.equal(adapter.type, "hermes");
  });

  describe("findBinary", () => {
    let savedHermesBinary: string | undefined;
    let savedPath: string | undefined;

    beforeEach(() => {
      savedHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      savedPath = process.env.PATH;
    });

    afterEach(() => {
      if (savedHermesBinary === undefined) {
        delete process.env.TAMANDUA_HERMES_BINARY;
      } else {
        process.env.TAMANDUA_HERMES_BINARY = savedHermesBinary;
      }
      if (savedPath !== undefined) {
        process.env.PATH = savedPath;
      }
    });

    it("respects TAMANDUA_HERMES_BINARY env var when set and executable", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes-custom");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hello\n", { mode: 0o755 });

      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      const result = await adapter.findBinary();
      assert.equal(result, hermesPath);


    });

    it("throws when TAMANDUA_HERMES_BINARY is set but not executable", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes-broken");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hi\n", { mode: 0o644 });

      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      await assert.rejects(
        () => adapter.findBinary(),
        /TAMANDUA_HERMES_BINARY set but not executable/,
      );


    });

    it("searches PATH for hermes executable", async () => {
      delete process.env.TAMANDUA_HERMES_BINARY;

      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      process.env.PATH = `${tmpDir}:${savedPath ?? ""}`;

      const result = await adapter.findBinary();
      assert.equal(result, hermesPath);


    });

    it("throws clear error when hermes not found in PATH and no env var set", async () => {
      delete process.env.TAMANDUA_HERMES_BINARY;

      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      process.env.PATH = tmpDir;

      await assert.rejects(
        () => adapter.findBinary(),
        /hermes binary not found in PATH/,
      );


    });

    it("env var wins over PATH hermes", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const envHermesPath = path.join(tmpDir, "hermes-env");
      fs.writeFileSync(envHermesPath, "#!/bin/sh\necho env-hermes\n", {
        mode: 0o755,
      });

      const { root: tmpDir2 } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const pathHermesPath = path.join(tmpDir2, "hermes");
      fs.writeFileSync(pathHermesPath, "#!/bin/sh\necho path-hermes\n", {
        mode: 0o755,
      });

      process.env.TAMANDUA_HERMES_BINARY = envHermesPath;
      process.env.PATH = `${tmpDir2}:${savedPath ?? ""}`;

      const result = await adapter.findBinary();
      assert.equal(result, envHermesPath);



    });

    // ── preferTokenSaver (hermes-token-saver) ──────────────────────

    it("prefers hermes-token-saver over hermes when preferTokenSaver is true and both exist", async () => {
      delete process.env.TAMANDUA_HERMES_BINARY;

      const { root: binDir } = createTempHome("tamandua-test-harness-adapter-hts-");
      const hermesPath = path.join(binDir, "hermes");
      const saverPath = path.join(binDir, "hermes-token-saver");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });
      fs.writeFileSync(saverPath, "#!/bin/sh\necho saver\n", { mode: 0o755 });

      process.env.PATH = binDir;

      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), saverPath);
      assert.equal(await adapter.findBinary({ preferTokenSaver: false }), hermesPath);
      assert.equal(await adapter.findBinary(), hermesPath);


    });

    it("falls back to hermes when hermes-token-saver is not installed", async () => {
      delete process.env.TAMANDUA_HERMES_BINARY;

      const { root: binDir } = createTempHome("tamandua-test-harness-adapter-hts-");
      const hermesPath = path.join(binDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      process.env.PATH = binDir;

      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), hermesPath);


    });

    it("TAMANDUA_HERMES_BINARY overrides hermes-token-saver preference", async () => {
      const { root: binDir } = createTempHome("tamandua-test-harness-adapter-hts-");
      const hermesPath = path.join(binDir, "hermes");
      const saverPath = path.join(binDir, "hermes-token-saver");
      const pinnedPath = path.join(binDir, "pinned-hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });
      fs.writeFileSync(saverPath, "#!/bin/sh\necho saver\n", { mode: 0o755 });
      fs.writeFileSync(pinnedPath, "#!/bin/sh\necho pinned\n", { mode: 0o755 });

      process.env.PATH = binDir;
      process.env.TAMANDUA_HERMES_BINARY = pinnedPath;

      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), pinnedPath);


    });

    it("per-invocation resolution: hermes-token-saver appearing on PATH between calls takes effect", async () => {
      delete process.env.TAMANDUA_HERMES_BINARY;

      const { root: binDir } = createTempHome("tamandua-test-harness-adapter-hts-");
      const hermesPath = path.join(binDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      process.env.PATH = binDir;

      // First call: wrapper absent → fallback to hermes
      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), hermesPath);

      // "Install" hermes-token-saver between rounds — next resolution must find it
      const saverPath = path.join(binDir, "hermes-token-saver");
      fs.writeFileSync(saverPath, "#!/bin/sh\necho saver\n", { mode: 0o755 });
      assert.equal(await adapter.findBinary({ preferTokenSaver: true }), saverPath);


    });

    it("discovers hermes via login shell when not on regular PATH", async () => {
      delete process.env.TAMANDUA_HERMES_BINARY;

      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(hermesPath, "#!/bin/sh\necho hermes\n", { mode: 0o755 });

      // Create a fake zsh that echoes the hermes path.
      const fakeZshDir = path.join(tmpDir, "fake-zsh");
      fs.mkdirSync(fakeZshDir, { recursive: true });
      const fakeZsh = path.join(fakeZshDir, "zsh");
      fs.writeFileSync(
        fakeZsh,
        `#!/bin/sh\n# Simulate zsh -lic 'command -v hermes'\necho ${hermesPath}\n`,
        { mode: 0o755 },
      );

      // PATH has the fake zsh but NOT the hermes dir.
      process.env.PATH = fakeZshDir;

      const result = await adapter.findBinary();
      assert.equal(fs.realpathSync(result), fs.realpathSync(hermesPath));


    });
  });

  describe("runRound", () => {
    it("returns stdout with session_id lines filtered out", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "Hello from hermes"
echo "Work completed successfully"
echo "session_id: 20260518_103004_cdae11"`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do something", { timeout: 5 });

        assert.ok(!result.output.includes("session_id:"));
        assert.ok(result.output.includes("Hello from hermes"));
        assert.ok(result.output.includes("Work completed successfully"));
        assert.equal(result.sessionRef, "20260518_103004_cdae11");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("filters all session_id lines", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "session_id: early"
echo "useful output here"
echo "session_id: late"`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do something", { timeout: 5 });

        assert.ok(!result.output.includes("session_id:"));
        assert.ok(result.output.includes("useful output here"));
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("returns empty string when output is only session_id", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "session_id: 20260518_103004_cdae11"`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do something", { timeout: 5 });
        assert.equal(result.output, "");
        assert.equal(result.stderrTail, "");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("resolves on timeout — returns partial output and sessionRef from stderr", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
# Write session_id to stderr before sleeping — the adapter can capture it.
echo "session_id: 20260518_103004_cdae11" >&2
sleep 10`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        // After US-002 the adapter always resolves — timeout included.
        // The scheduler runs post-round processing including token attribution.
        const result = await adapter.runRound("do something", { timeout: 2 });
        assert.equal(typeof result.output, "string");
        // SessionRef extracted from stderr even on timeout kill
        assert.equal(result.sessionRef, "20260518_103004_cdae11");
        assert.equal(result.signal, "SIGTERM");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("resolves on non-zero exit — returns output with exitCode and sessionRef from stderr", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "error output" >&2
echo "partial work before crash"
echo "session_id: 20260518_103004_cdae11" >&2
exit 1`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        // After US-002 the adapter always resolves (non-zero exit included).
        // The scheduler decides what to do with the exit status.
        const result = await adapter.runRound("bad task", { timeout: 5 });
        assert.ok(result.output.includes("partial work before crash"));
        assert.ok(!result.output.includes("session_id:"));
        assert.equal(result.sessionRef, "20260518_103004_cdae11");
        assert.equal(result.exitCode, 1);
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("extracts sessionRef from stderr on exit 0 — primary real-hermes path", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      // Real hermes prints session_id to stderr, not stdout.
      // Exit 0 is the normal completion path.
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "Work completed successfully"
echo "STATUS: done"
echo "session_id: 20260706_stderr_zero" >&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do something", { timeout: 5 });

        assert.ok(result.output.includes("Work completed successfully"));
        assert.ok(result.output.includes("STATUS: done"));
        assert.ok(!result.output.includes("session_id:"));
        // SessionRef extracted from stderr (primary source)
        assert.equal(result.sessionRef, "20260706_stderr_zero");
        // Exit code 0 means clean completion
        assert.equal(result.exitCode, 0);
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("extracts sessionRef from stderr on exit 130 — teardown-kill survival", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      // Exit 130 is real hermes' KeyboardInterrupt signal (teardown kill).
      // The adapter must resolve (not reject) and still extract sessionRef
      // from stderr, just like the real canary failure shape.
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "partial work completed"
echo "session_id: 20260706_stderr_130" >&2
echo "hermes interrupted" >&2
exit 130`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        // After US-002 the adapter always resolves — exit 130 included.
        const result = await adapter.runRound("task interrupted mid-round", { timeout: 5 });

        assert.ok(result.output.includes("partial work completed"));
        assert.ok(!result.output.includes("session_id:"));
        // SessionRef extracted from stderr despite non-zero exit
        assert.equal(result.sessionRef, "20260706_stderr_130");
        // Exit code 130 is the teardown-kill signal
        assert.equal(result.exitCode, 130);
        // No signal — the process exited (was not killed externally)
        assert.equal(result.signal, undefined);
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("stderr data does not appear in returned stdout", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "useful stdout" 1>&1
echo "debug stderr" 1>&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("task", { timeout: 5 });
        assert.equal(result.output, "useful stdout");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("preserves multi-line output with mixed content", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "STATUS: done"
echo ""
echo "CHANGES: implemented feature X"
echo "TESTS: all passing"
echo "session_id: 20260518_103004_cdae11"`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do the work", { timeout: 5 });

        assert.ok(result.output.includes("STATUS: done"));
        assert.ok(result.output.includes("CHANGES: implemented feature X"));
        assert.ok(result.output.includes("TESTS: all passing"));
        assert.ok(!result.output.includes("session_id:"));
        const lines = result.output.split("\n");
        assert.ok(lines.length >= 3);
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("sets truncated flag and inserts marker when stdout exceeds 10MB budget", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      // Generate ~11.5MB of stdout to ensure truncation triggers.
      // The head window is 1MB, tail window is 9MB — total budget 10MB.
      // 11.5MB means ~1.5MB of middle is discarded.
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
# Write ~11 MB of noise + session_id on stderr
dd if=/dev/zero bs=1M count=11 2>/dev/null
echo ""
echo "session_id: 20260518_trunc_test" >&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("task", { timeout: 10 });

        // Truncation should be flagged
        assert.equal(result.truncated, true, "truncated flag should be set");
        // Truncation marker should appear in output
        assert.ok(
          result.output.includes("[…output truncated…]"),
          "truncation marker should be present in stdout",
        );
        // Session_id should still be extracted from stderr (even truncated)
        assert.equal(result.sessionRef, "20260518_trunc_test", "sessionRef should survive stderr truncation");
        // Output should still have content (head + tail, not empty)
        assert.ok(result.output.length > 0, "stdout should have content even when truncated");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("not truncated when output is under 10MB budget", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      // A few hundred bytes — well under 10MB
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "some normal output"
echo "STATUS: done"
echo "session_id: 20260518_normal" >&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("task", { timeout: 5 });

        // Should NOT be truncated
        assert.equal(result.truncated, undefined, "truncated flag should not be set");
        // Output should have full content
        assert.ok(result.output.includes("some normal output"));
        assert.ok(result.output.includes("STATUS: done"));
        assert.ok(!result.output.includes("[…output truncated…]"));
        assert.equal(result.sessionRef, "20260518_normal");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("session_id on stderr survives even when stdout is truncated", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      // Write ~11MB stdout noise, but the session_id is on stderr (which is
      // tiny). Both streams have independent head+tail windows.
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
dd if=/dev/zero bs=1M count=11 2>/dev/null
echo "session_id: 20260518_stderr_survives" >&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("task", { timeout: 10 });

        assert.equal(result.truncated, true, "truncated flag should be set (stdout exceeded budget)");
        assert.ok(result.output.includes("[…output truncated…]"));
        // stderr is tiny, session_id should be found
        assert.equal(result.sessionRef, "20260518_stderr_survives");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("truncation preserves session_id on stderr when stderr itself exceeds budget", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      // Write ~11MB stderr (lines of "A" = 2 bytes each, 5.5M lines) with
      // session_id at the very END. The session_id must survive in the stderr
      // tail window despite the middle ~1MB being discarded.
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
# yes outputs "A\\n" repeatedly (2 bytes per line). 5.5M lines = ~11MB.
(yes A | head -n 5500000; echo "session_id: 20260518_tail_survives") >&2
echo "stdout is tiny"`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("task", { timeout: 10 });

        // stderr was truncated, so truncated should be true
        assert.equal(result.truncated, true, "truncated flag should be set (stderr exceeded budget)");
        // Session_id must survive in stderr tail window
        assert.equal(result.sessionRef, "20260518_tail_survives",
          "sessionRef must be extracted from stderr tail window after truncation");
        // stdout is normal
        assert.equal(result.output, "stdout is tiny");
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }

      }
    });

    it("warns when no session_id trailer found on either stream", async () => {
      const { root: tmpStateDir } = createTempHome("tamandua-test-adapter-notrailer-");
      const savedStateDir = process.env.TAMANDUA_STATE_DIR;
      const savedJobId = process.env.TAMANDUA_WORKER_JOB_ID;
      process.env.TAMANDUA_STATE_DIR = tmpStateDir;
      process.env.TAMANDUA_WORKER_JOB_ID =
        "tamandua-test-wf-6d379894-4a5e-4dad-92fb-da66e1093e94-devagent";

      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      // No session_id on either stdout or stderr
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "useful output"
echo "STATUS: done"
echo "debug info" >&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do something", { timeout: 5 });

        // Round must complete normally — sessionRef is undefined, not an error
        assert.equal(result.sessionRef, undefined);
        assert.ok(result.output.includes("useful output"));
        assert.ok(result.output.includes("STATUS: done"));

        // The logger warning must be present
        const logPath = path.join(tmpStateDir, "tamandua.log");
        const logContent = fs.readFileSync(logPath, "utf-8");
        assert.ok(
          logContent.includes("no session_id trailer"),
          "log must contain missing-trailer warning"
        );
        assert.ok(
          logContent.includes("tokens will read 0"),
          "log must explain why tokens read 0"
        );
        // Context fields
        assert.ok(
          logContent.includes("6d379894"),
          "log context must include runId"
        );
        assert.ok(
          logContent.includes("devagent"),
          "log context must include agentId"
        );
        assert.ok(
          logContent.includes("stdoutBytes"),
          "log context must include stdoutBytes"
        );
        assert.ok(
          logContent.includes("stderrBytes"),
          "log context must include stderrBytes"
        );
        assert.ok(
          logContent.includes("exitCode"),
          "log context must include exitCode"
        );
      } finally {
        if (savedStateDir === undefined) {
          delete process.env.TAMANDUA_STATE_DIR;
        } else {
          process.env.TAMANDUA_STATE_DIR = savedStateDir;
        }
        if (savedJobId === undefined) {
          delete process.env.TAMANDUA_WORKER_JOB_ID;
        } else {
          process.env.TAMANDUA_WORKER_JOB_ID = savedJobId;
        }
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }


      }
    });

    it("does not warn when session_id is present", async () => {
      const { root: tmpStateDir } = createTempHome("tamandua-test-adapter-hastrailer-");
      const savedStateDir = process.env.TAMANDUA_STATE_DIR;
      process.env.TAMANDUA_STATE_DIR = tmpStateDir;

      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "useful output"
echo "session_id: 20260518_103004_cdae11" >&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("do something", { timeout: 5 });

        assert.equal(result.sessionRef, "20260518_103004_cdae11");

        // No missing-trailer warning should appear
        const logPath = path.join(tmpStateDir, "tamandua.log");
        const logContent = fs.readFileSync(logPath, "utf-8");
        assert.ok(
          !logContent.includes("no session_id trailer"),
          "log must NOT contain missing-trailer warning when session_id is present"
        );
      } finally {
        if (savedStateDir === undefined) {
          delete process.env.TAMANDUA_STATE_DIR;
        } else {
          process.env.TAMANDUA_STATE_DIR = savedStateDir;
        }
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }


      }
    });

    it("hermes pre-launch log redacts -q prompt payload with commandPreview parity", async () => {
      const { root: tmpStateDir } = createTempHome("tamandua-test-adapter-cmdpreview-");
      const savedStateDir = process.env.TAMANDUA_STATE_DIR;
      process.env.TAMANDUA_STATE_DIR = tmpStateDir;

      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "done"
echo "session_id: 20260518_103004_cdae11" >&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      const secretPrompt = "VERY_SECRET_HERMES_PROMPT";

      try {
        const result = await adapter.runRound(secretPrompt, { timeout: 5 });

        assert.equal(result.output, "done");
        assert.equal(result.sessionRef, "20260518_103004_cdae11");

        // Verify pre-launch log entry via log file
        const logPath = path.join(tmpStateDir, "tamandua.log");
        const logContent = fs.readFileSync(logPath, "utf-8");
        assert.ok(
          logContent.includes("hermes pre-launch"),
          "log must contain hermes pre-launch entry"
        );

        // commandPreview must contain the redaction marker, not the secret
        assert.ok(
          logContent.includes("<prompt elided>"),
          "commandPreview must contain redaction marker"
        );
        assert.ok(
          !logContent.includes(secretPrompt),
          "log must NOT contain the secret prompt"
        );

        // promptElided must be true in the log
        assert.ok(
          logContent.includes('"promptElided":true'),
          "log must show promptElided: true"
        );

        // Result must also carry the fields
        assert.equal(typeof result.commandPreview, "string", "result.commandPreview must be a string");
        assert.ok(
          result.commandPreview!.includes("<prompt elided>"),
          "result.commandPreview must contain redaction marker"
        );
        assert.ok(
          !result.commandPreview!.includes(secretPrompt),
          "result.commandPreview must NOT contain the secret prompt"
        );
        assert.ok(
          Array.isArray(result.redactedIndices),
          "result.redactedIndices must be an array"
        );
        assert.ok(
          result.redactedIndices!.includes(6),
          "result.redactedIndices must include prompt arg index 6"
        );
        assert.equal(
          result.promptElided,
          true,
          "result.promptElided must be true"
        );
      } finally {
        if (savedStateDir === undefined) {
          delete process.env.TAMANDUA_STATE_DIR;
        } else {
          process.env.TAMANDUA_STATE_DIR = savedStateDir;
        }
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }


      }
    });

    it("hermes pre-launch log shows promptElided: true for empty prompt", async () => {
      const { root: tmpStateDir } = createTempHome("tamandua-test-adapter-cmdpreview-empty-");
      const savedStateDir = process.env.TAMANDUA_STATE_DIR;
      process.env.TAMANDUA_STATE_DIR = tmpStateDir;

      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "done"
echo "session_id: 20260518_103004_cdae11" >&2`,
        { mode: 0o755 }
      );

      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      process.env.TAMANDUA_HERMES_BINARY = hermesPath;

      try {
        const result = await adapter.runRound("", { timeout: 5 });

        assert.equal(result.output, "done");

        // Verify pre-launch log
        const logPath = path.join(tmpStateDir, "tamandua.log");
        const logContent = fs.readFileSync(logPath, "utf-8");
        assert.ok(
          logContent.includes("hermes pre-launch"),
          "log must contain hermes pre-launch entry"
        );

        // promptElided should still be true (arg exists at index 6, even if empty)
        assert.ok(
          logContent.includes('"promptElided":true'),
          "log must show promptElided: true even for empty prompt"
        );

        assert.equal(
          result.promptElided,
          true,
          "result.promptElided must be true"
        );
        assert.ok(
          Array.isArray(result.redactedIndices),
          "result.redactedIndices must be an array"
        );
        assert.ok(
          result.redactedIndices!.includes(6),
          "result.redactedIndices must include prompt arg index 6"
        );
      } finally {
        if (savedStateDir === undefined) {
          delete process.env.TAMANDUA_STATE_DIR;
        } else {
          process.env.TAMANDUA_STATE_DIR = savedStateDir;
        }
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }


      }
    });

    it("uses pre-resolved binaryPath without PATH access to hermes", async () => {
      const { root: tmpDir } = createTempHome("tamandua-test-harness-adapter-hermes-");
      const hermesPath = path.join(tmpDir, "hermes");
      fs.writeFileSync(
        hermesPath,
        `#!/bin/sh
echo "work done"
echo "session_id: 20260518_103004_cdae11" >&2`,
        { mode: 0o755 },
      );

      // Ensure PATH does NOT contain the hermes directory.
      const originalPath = process.env.PATH;
      process.env.PATH = tmpDir;
      // Clear env var so no other resolution path exists.
      const originalHermesBinary = process.env.TAMANDUA_HERMES_BINARY;
      delete process.env.TAMANDUA_HERMES_BINARY;

      try {
        // Pass binaryPath directly — runRound must use it, skipping findBinary().
        const result = await adapter.runRound("do the work", {
          timeout: 5,
          binaryPath: hermesPath,
        });

        assert.ok(result.output.includes("work done"));
        assert.equal(result.sessionRef, "20260518_103004_cdae11");
        assert.equal(result.exitCode, 0);
      } finally {
        if (originalHermesBinary === undefined) {
          delete process.env.TAMANDUA_HERMES_BINARY;
        } else {
          process.env.TAMANDUA_HERMES_BINARY = originalHermesBinary;
        }
        if (originalPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = originalPath;
        }
      }
    });
  });
});

// ── Type-level checks that the implement types work ────────────────

describe("HarnessRoundResult shape", () => {
  it("output and stderrTail are required, sessionRef is optional", () => {
    const minimal: HarnessRoundResult = { output: "hello", stderrTail: "" };
    assert.equal(minimal.output, "hello");
    assert.equal(minimal.sessionRef, undefined);

    const full: HarnessRoundResult = {
      output: "hello",
      stderrTail: "stderr",
      sessionRef: "sess-abc",
    };
    assert.equal(full.output, "hello");
    assert.equal(full.sessionRef, "sess-abc");
  });
});
