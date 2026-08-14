/**
 * Unit tests for dsh-usage.ts — lookupDshSessionTokens.
 *
 * All fixtures are synthetic session logs (no real dsh, no model calls,
 * zero tokens). zstd fixture compression is feature-gated on node:zlib
 * `zstdCompressSync` (Node >= 23.8); the binary-strategy tests exercise
 * the same parsing through a fake `zstd` shell script so the reader's
 * core logic is covered on every supported Node.
 *
 * This file spawns `zstd` via the module's binary fallback, so it is
 * classified in the serial test lane (tests/serial-files.txt).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  lookupDshSessionTokens,
  projectKey,
  resolveDshHome,
  dshSessionProjectDir,
  sumUsageChunks,
} from "../../dist/installer/dsh-usage.js";

// ── Feature gate: node:zlib zstd (Node >= 23.8) ────────────────────

const zstdCompress =
  typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function"
    ? (zlib as { zstdCompressSync: (b: Uint8Array) => Buffer }).zstdCompressSync
    : null;
const haveNodeZstd = zstdCompress !== null;

// ── Fixture helpers ────────────────────────────────────────────────

function headerLine(id: string, createdAt: number): string {
  return (
    JSON.stringify({
      type: "session",
      version: 1,
      id,
      createdAt,
      delegationDepth: 0,
    }) + "\n"
  );
}

function usageLine(opts: {
  input: number;
  output: number;
  cacheRead?: number;
  seq?: number;
  time?: number;
}): string {
  return (
    JSON.stringify({
      type: "assistant/chunk",
      seq: opts.seq ?? 0,
      time: opts.time ?? 1_700_000_000_000,
      data: {
        turn: 0,
        step: 0,
        chunk: {
          type: "usage",
          usage: {
            inputTokens: opts.input,
            outputTokens: opts.output,
            ...(opts.cacheRead !== undefined
              ? { cacheReadTokens: opts.cacheRead }
              : {}),
          },
        },
      },
    }) + "\n"
  );
}

/** Create a session dir under `$DSH_HOME/sessions/<escaped-workdir>` and write its log. */
function writeSessionDir(opts: {
  dshHome: string;
  workdir: string;
  sessionName: string;
  content: Buffer | string;
}): string {
  const sessionsDir = dshSessionProjectDir(opts.dshHome, opts.workdir);
  const sessionDir = path.join(sessionsDir, opts.sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });
  const logPath = path.join(sessionDir, "session.jsonl.zstd");
  fs.writeFileSync(logPath, opts.content);
  return logPath;
}

/** Fake `zstd` binary: `zstd -dc <file>` → cat the file (plain-text fixtures). */
function makeFakeZstdBin(tmp: string): string {
  const binDir = path.join(tmp, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "zstd"), '#!/bin/sh\ncat "$2"\n', {
    mode: 0o755,
  });
  return binDir;
}

function envWith(dshHome: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { DSH_HOME: dshHome, ...extra };
}

function envWithFakeZstd(dshHome: string, binDir: string): NodeJS.ProcessEnv {
  return envWith(dshHome, {
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  });
}

// ── Warning capture (module warns through lib/logger) ─────────────

let tmpRoot: string | null = null;
let stateDir: string | null = null;
let savedStateDir: string | undefined;

beforeEach(() => {
  tmpRoot = tamanduaTempDir("tamandua-test-dsh-usage-");
  stateDir = path.join(tmpRoot, "state");
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  process.env.TAMANDUA_STATE_DIR = stateDir;
});

afterEach(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
  stateDir = null;
  if (savedStateDir === undefined) {
    delete process.env.TAMANDUA_STATE_DIR;
  } else {
    process.env.TAMANDUA_STATE_DIR = savedStateDir;
  }
});

function readTamanduaLog(): string {
  try {
    return fs.readFileSync(path.join(stateDir!, "tamandua.log"), "utf8");
  } catch {
    return "";
  }
}

// ── projectKey: dsh cwd-escaping replication ───────────────────────

describe("projectKey (dsh cwd-escaping replication)", () => {
  it("replaces separators with - and preserves safe units", () => {
    assert.equal(
      projectKey("/home/user/.tamandua/worktrees/tamandua-x"),
      "--home-user-.tamandua-worktrees-tamandua-x--",
    );
  });

  it("collapses consecutive separators into one -", () => {
    assert.equal(projectKey("/a//b///c"), "--a-b-c--");
  });

  it("treats backslashes and colons as separators", () => {
    assert.equal(projectKey("C:\\Users\\bob"), "--C-Users-bob--");
  });

  it("escapes unsafe code units as ~XXXX", () => {
    assert.equal(projectKey("/a b"), "--a~0020b--");
    assert.equal(projectKey("/über"), "--~00FCber--");
    assert.equal(projectKey("~"), "--~007E--");
  });

  it("strips the leading separator run (root for all-separator input)", () => {
    assert.equal(projectKey("/a"), "--a--");
    assert.equal(projectKey("/"), "--root--");
  });

  it("bounds the key at 251 slug characters", () => {
    const key = projectKey("/" + "x".repeat(300));
    assert.equal(key.length, 255); // "--" + 251 + "--"
    assert.ok(key.startsWith("--"));
    assert.ok(key.endsWith("--"));
  });

  it("throws on empty input (dsh parity)", () => {
    assert.throws(() => projectKey(""), /empty project path/);
  });
});

// ── resolveDshHome ─────────────────────────────────────────────────

describe("resolveDshHome", () => {
  it("prefers the env override", () => {
    assert.equal(resolveDshHome({ DSH_HOME: "/srv/dsh-home" }), "/srv/dsh-home");
  });
});

// ── sumUsageChunks: pure parsing ───────────────────────────────────

describe("sumUsageChunks", () => {
  it("sums input+output across multiple usage chunks and excludes cache reads", () => {
    const text =
      headerLine("session-a", 1) +
      usageLine({ input: 100, output: 50, cacheRead: 9_000, seq: 1 }) +
      usageLine({ input: 25, output: 75, cacheRead: 1_000, seq: 2 }) +
      usageLine({ input: 7, output: 3, seq: 3 });
    assert.equal(sumUsageChunks(text), 100 + 50 + 25 + 75 + 7 + 3);
  });

  it("tolerates flat usage fields directly on the chunk", () => {
    const line = JSON.stringify({
      type: "assistant/chunk",
      seq: 0,
      time: 1,
      data: {
        turn: 0,
        step: 0,
        chunk: { type: "usage", inputTokens: 10, outputTokens: 20, cacheReadTokens: 99 },
      },
    });
    assert.equal(sumUsageChunks(line + "\n"), 30);
  });

  it("treats non-numeric and negative values as 0", () => {
    const text =
      headerLine("s", 1) +
      usageLine({ input: Number.NaN, output: -5, seq: 1 });
    assert.equal(sumUsageChunks(text), 0);
  });

  it("returns null when the log has no usage chunks", () => {
    assert.equal(sumUsageChunks(headerLine("s", 1)), null);
  });

  it("skips lines that fail to parse", () => {
    const text =
      headerLine("s", 1) +
      "not json at all\n" +
      usageLine({ input: 4, output: 5, seq: 1 }) +
      "{broken\n";
    assert.equal(sumUsageChunks(text), 9);
  });
});

// ── lookupDshSessionTokens ─────────────────────────────────────────

describe("lookupDshSessionTokens", () => {
  it("sums input+output across multiple usage chunks via the binary zstd tier", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const sessionName = "session-11111111-2222-4333-8444-555555555555";
    const text =
      headerLine(sessionName, 1_700_000_000_000) +
      usageLine({ input: 100, output: 50, cacheRead: 9_000, seq: 1 }) +
      usageLine({ input: 25, output: 75, cacheRead: 1_000, seq: 2 });
    writeSessionDir({ dshHome, workdir, sessionName, content: text });

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWithFakeZstd(dshHome, binDir),
      zstdStrategy: "binary",
    });

    assert.ok(result !== null);
    assert.equal(result.totalTokens, 250); // cache reads (10_000) excluded
    assert.equal(result.sessionRef, sessionName);
  });

  it("returns null when the sessions dir is missing (with a warning)", async () => {
    const dshHome = path.join(tmpRoot!, "empty-home");
    fs.mkdirSync(dshHome, { recursive: true });
    const workdir = path.join(tmpRoot!, "worktree", "repo");

    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWith(dshHome),
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /dsh session token lookup failed: no sessions dir/);
  });

  it("returns null and warns when no zstd support is available", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: "session-aaa",
      content: headerLine("s", 1) + usageLine({ input: 1, output: 2, seq: 1 }),
    });

    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWith(dshHome),
      zstdStrategy: "none",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /no zstd support available/);
  });

  it("returns null and warns on a corrupt session log", { skip: !haveNodeZstd }, async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: "session-bbb",
      content: Buffer.from("this is not a zstd stream"),
    });

    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWith(dshHome),
      zstdStrategy: "node",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /failed to decompress session log/);
  });

  it("returns null and warns when the zstd binary is unavailable (auto on no-node-zstd)", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: "session-ccc",
      content: headerLine("s", 1) + usageLine({ input: 1, output: 2, seq: 1 }),
    });

    // PATH without any zstd binary and strategy pinned to the binary tier.
    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWith(dshHome, { PATH: path.join(tmpRoot!, "empty-bin") }),
      zstdStrategy: "binary",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /zstd binary unavailable or failed/);
  });

  it("picks the newest session since spawn time", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const spawnMs = 1_700_000_000_000;

    const older = "session-older";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: older,
      content: headerLine(older, 1) + usageLine({ input: 111, output: 1, seq: 1 }),
    });
    const newer = "session-newer";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: newer,
      content: headerLine(newer, 1) + usageLine({ input: 222, output: 2, seq: 1 }),
    });

    const sessionsDir = dshSessionProjectDir(dshHome, workdir);
    fs.utimesSync(path.join(sessionsDir, older), new Date(spawnMs + 1_000), new Date(spawnMs + 1_000));
    fs.utimesSync(path.join(sessionsDir, newer), new Date(spawnMs + 5_000), new Date(spawnMs + 5_000));

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      spawnedAtMs: spawnMs,
      workdir,
      env: envWithFakeZstd(dshHome, binDir),
      zstdStrategy: "binary",
    });

    assert.ok(result !== null);
    assert.equal(result.totalTokens, 224); // the newer session wins
    assert.equal(result.sessionRef, newer);
  });

  it("excludes sessions created before spawn time", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const spawnMs = 1_700_000_000_000;

    const old = "session-old";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: old,
      content: headerLine(old, 1) + usageLine({ input: 999, output: 9, seq: 1 }),
    });
    const fresh = "session-fresh";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: fresh,
      content: headerLine(fresh, 1) + usageLine({ input: 42, output: 4, seq: 1 }),
    });

    const sessionsDir = dshSessionProjectDir(dshHome, workdir);
    fs.utimesSync(path.join(sessionsDir, old), new Date(spawnMs - 5_000), new Date(spawnMs - 5_000));
    fs.utimesSync(path.join(sessionsDir, fresh), new Date(spawnMs + 1_000), new Date(spawnMs + 1_000));

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      spawnedAtMs: spawnMs,
      workdir,
      env: envWithFakeZstd(dshHome, binDir),
      zstdStrategy: "binary",
    });

    assert.ok(result !== null);
    assert.equal(result.totalTokens, 46);
    assert.equal(result.sessionRef, fresh);
  });

  it("returns null when the log has no usage chunks", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: "session-empty",
      content: headerLine("s", 1),
    });

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWithFakeZstd(dshHome, binDir),
      zstdStrategy: "binary",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /found no usage chunks/);
  });

  it("returns null and warns for an invalid spawn timestamp", async () => {
    const result = await lookupDshSessionTokens({
      spawnedAtMs: Number.NaN,
      workdir: path.join(tmpRoot!, "worktree"),
      env: envWith(path.join(tmpRoot!, "dsh-home")),
    });
    assert.equal(result, null);
    assert.match(readTamanduaLog(), /invalid spawn timestamp/);
  });

  it("returns null and warns for an empty workdir", async () => {
    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir: "",
      env: envWith(path.join(tmpRoot!, "dsh-home")),
    });
    assert.equal(result, null);
    assert.match(readTamanduaLog(), /missing worker working directory/);
  });

  // ── node:zlib zstd tier (feature-gated on Node >= 23.8) ────────

  it(
    "decompresses a multi-frame concatenated zstd log and sums usage chunks",
    { skip: !haveNodeZstd },
    async () => {
      const dshHome = path.join(tmpRoot!, "dsh-home");
      const workdir = path.join(tmpRoot!, "worktree", "repo");
      const sessionName = "session-22222222-3333-4444-8555-666666666666";

      // dsh writes the header + first batch as one frame and appends one
      // frame per durable batch — replicate that container shape.
      const frame1 = zstdCompress!(
        Buffer.from(
          headerLine(sessionName, 1_700_000_000_000) +
            usageLine({ input: 10, output: 20, cacheRead: 500, seq: 1 }),
        ),
      );
      const frame2 = zstdCompress!(
        Buffer.from(usageLine({ input: 30, output: 40, cacheRead: 600, seq: 2 })),
      );
      writeSessionDir({
        dshHome,
        workdir,
        sessionName,
        content: Buffer.concat([frame1, frame2]),
      });

      const result = await lookupDshSessionTokens({
        spawnedAtMs: 0,
        workdir,
        env: envWith(dshHome),
        zstdStrategy: "node",
      });

      assert.ok(result !== null);
      assert.equal(result.totalTokens, 100); // 10+20+30+40; cache reads excluded
      assert.equal(result.sessionRef, sessionName);
    },
  );

  it(
    "reads a single-frame zstd-compressed log (zstdCompressSync fixture)",
    { skip: !haveNodeZstd },
    async () => {
      const dshHome = path.join(tmpRoot!, "dsh-home");
      const workdir = path.join(tmpRoot!, "worktree", "repo");
      const sessionName = "session-33333333-4444-4555-8666-777777777777";
      const compressed = zstdCompress!(
        Buffer.from(
          headerLine(sessionName, 1) +
            usageLine({ input: 5, output: 6, cacheRead: 700, seq: 1 }),
        ),
      );
      writeSessionDir({ dshHome, workdir, sessionName, content: compressed });

      const result = await lookupDshSessionTokens({
        spawnedAtMs: 0,
        workdir,
        env: envWith(dshHome),
      });

      assert.ok(result !== null);
      assert.equal(result.totalTokens, 11);
      assert.equal(result.sessionRef, sessionName);
    },
  );
});
