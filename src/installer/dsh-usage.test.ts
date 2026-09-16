/**
 * Unit tests for dsh-usage.ts — lookupDshSessionTokens.
 *
 * Most fixtures are synthetic session logs (no real dsh, no model calls,
 * zero tokens). zstd fixture compression is feature-gated on node:zlib
 * `zstdCompressSync` (Node >= 23.8); the binary-strategy tests exercise
 * the same parsing through a fake `zstd` shell script so the reader's
 * core logic is covered on every supported Node.
 *
 * The "dsh v3 real multi-frame fixture" suite additionally stages the
 * coordinator-verified dsh 0.1.5 container (copied byte-for-byte into
 * tests/fixtures/dsh-v3/) and — on this host — exercises the genuine
 * `zstd -dc` binary.
 *
 * This file spawns `zstd` (fake shell shim and, for the real-fixture
 * binary-tier test, the real binary), so it is classified in the serial
 * test lane (tests/serial-files.txt).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import {
  lookupDshSessionTokens,
  projectKey,
  resolveDshHome,
  dshSessionProjectDir,
  sumUsageChunks,
  decompressDshSessionLog,
  DSH_SESSION_MTIME_TOLERANCE_MS,
} from "../../dist/installer/dsh-usage.js";

// ── Real dsh 0.1.5 (v3) ground-truth fixture ───────────────────────
//
// Copied byte-for-byte from the coordinator-verified fixture:
//   /root/matchlock-work/dsh-v3-fixture/session-store/
//     session-281fad5b-1fb8-4872-8434-1a29c5fcd8f2/session.v3.jsonl.zstd
// It is a CONCATENATED zstd-frame container; node:zlib
// `zstdDecompressSync` applied to the WHOLE buffer yields only the first
// frame (1 record), while `zstd -dc` yields all 18 records. The reader
// must therefore scan + decode frame by frame.
const FIXTURE_DIR = path.resolve(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "tests",
  "fixtures",
  "dsh-v3",
);
const FIXTURE_ZSTD = path.join(FIXTURE_DIR, "session.v3.jsonl.zstd");
const FIXTURE_LOCK = path.join(FIXTURE_DIR, "session.lock");
const FIXTURE_SHA256 =
  "fe33b4d5081277b083ce6b9563b1f3eaad864c3eff18035ee046f1b42f6361f8";
const FIXTURE_SESSION_NAME = "session-281fad5b-1fb8-4872-8434-1a29c5fcd8f2";
// Hand computation from `zstd -dc <fixture>`: the single usage carrier is
// the `assistant/message` record at seq 15 with
//   inputTokens 7222 + outputTokens 13 = 7235
// cacheReadTokens 0 and reasoningTokens 11 are EXCLUDED (shared policy),
// and the duplicate `data.stream[].chunk.usage` copy is not counted.
const FIXTURE_TOTAL_TOKENS = 7235;

/** Is a real `zstd` CLI on PATH? (v1.4.8 at /usr/bin/zstd on this host.) */
function detectZstdBinary(): boolean {
  try {
    execFileSync("zstd", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const haveZstdBinary = detectZstdBinary();

/**
 * Stage the real fixture as a v3 session directory under a temp
 * `$DSH_HOME` (`sessions/<escaped-workdir>/session-<uuid>`), preserving
 * the file bytes. `mutate` may rewrite the log bytes (e.g. truncation).
 */
function stageFixtureSession(opts: {
  dshHome: string;
  workdir: string;
  sessionName?: string;
  mutate?: (bytes: Buffer) => Buffer;
}): { sessionDir: string; logPath: string } {
  const sessionName = opts.sessionName ?? FIXTURE_SESSION_NAME;
  const sessionsDir = dshSessionProjectDir(opts.dshHome, opts.workdir);
  const sessionDir = path.join(sessionsDir, sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });
  const bytes = fs.readFileSync(FIXTURE_ZSTD);
  const logPath = path.join(sessionDir, "session.v3.jsonl.zstd");
  fs.writeFileSync(logPath, opts.mutate ? opts.mutate(bytes) : bytes);
  fs.copyFileSync(FIXTURE_LOCK, path.join(sessionDir, "session.lock"));
  return { sessionDir, logPath };
}

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
      version: 3,
      id,
      createdAt,
      delegationDepth: 0,
    }) + "\n"
  );
}

/**
 * A dsh >= 0.1.5 (format v3) `assistant/message` record carrying the
 * request's usage as a TOP-LEVEL `data.usage` object.
 */
function usageLine(opts: {
  input: number;
  output: number;
  cacheRead?: number;
  seq?: number;
  time?: number;
}): string {
  return (
    JSON.stringify({
      type: "assistant/message",
      seq: opts.seq ?? 0,
      time: opts.time ?? 1_700_000_000_000,
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [] },
        usage: {
          inputTokens: opts.input,
          outputTokens: opts.output,
          ...(opts.cacheRead !== undefined
            ? { cacheReadTokens: opts.cacheRead }
            : {}),
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
  /** Session-log filename; defaults to the supported v3 compressed form. */
  fileName?: string;
}): string {
  const sessionsDir = dshSessionProjectDir(opts.dshHome, opts.workdir);
  const sessionDir = path.join(sessionsDir, opts.sessionName);
  fs.mkdirSync(sessionDir, { recursive: true });
  const logPath = path.join(sessionDir, opts.fileName ?? "session.v3.jsonl.zstd");
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
  it("sums input+output across multiple v3 usage records and excludes cache reads", () => {
    const text =
      headerLine("session-a", 1) +
      usageLine({ input: 100, output: 50, cacheRead: 9_000, seq: 1 }) +
      usageLine({ input: 25, output: 75, cacheRead: 1_000, seq: 2 }) +
      usageLine({ input: 7, output: 3, seq: 3 });
    assert.equal(sumUsageChunks(text), 100 + 50 + 25 + 75 + 7 + 3);
  });

  it("tolerates a record whose usage is embedded twice (stream duplicate counted once)", () => {
    const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 9_999 };
    const line = JSON.stringify({
      type: "assistant/message",
      seq: 0,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [] },
        usage,
        // v3 repeats the same usage object inside the embedded stream —
        // recursing into it would double-count this request.
        stream: [{ type: "chunk", chunk: { type: "usage", usage } }],
      },
    });
    assert.equal(sumUsageChunks(line + "\n"), 150);
  });

  it("returns 150 for a bare v3 assistant/message record (cache read excluded)", () => {
    const line = JSON.stringify({
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [] },
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 9_999 },
      },
    });
    assert.equal(sumUsageChunks(line + "\n"), 150);
  });

  it("counts a top-level data.usage on a compaction/summary record", () => {
    const line = JSON.stringify({
      type: "compaction/summary",
      data: {
        compactionId: "c1",
        summary: [],
        provider: "deepseek-official",
        model: "deepseek-flash",
        usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 7 },
      },
    });
    assert.equal(sumUsageChunks(line + "\n"), 15);
  });

  it("does not count usage nested only under data.stream[].chunk.usage", () => {
    const line = JSON.stringify({
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [] },
        stream: [
          {
            type: "chunk",
            chunk: {
              type: "usage",
              usage: { inputTokens: 100, outputTokens: 50 },
            },
          },
        ],
      },
    });
    assert.equal(sumUsageChunks(line + "\n"), null);
  });

  it("does not count the removed legacy assistant/chunk usage record", () => {
    const line = JSON.stringify({
      type: "assistant/chunk",
      data: {
        turn: 0,
        step: 0,
        chunk: { type: "usage", usage: { inputTokens: 10, outputTokens: 20 } },
      },
    });
    assert.equal(sumUsageChunks(line + "\n"), null);
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
  it("sums input+output across multiple v3 usage records via the binary zstd tier", async () => {
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

  // ── Rule-3 mtime tolerance for "created since spawn" (US-010) ───
  //
  // The session-dir mtime is an OS-epoch file instant; the filter ages it
  // against spawnedAtMs through instantAgeMs with the documented
  // DSH_SESSION_MTIME_TOLERANCE_MS slack. These pin the boundary with real
  // os.utimes values (no clock injection needed) and the never-0 contract.

  it("includes a session whose mtime is just older than spawn within the mtime tolerance", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const spawnMs = 1_700_000_000_000;
    const sessionName = "session-within-tolerance";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName,
      content: headerLine(sessionName, 1) + usageLine({ input: 40, output: 2, seq: 1 }),
    });

    const sessionsDir = dshSessionProjectDir(dshHome, workdir);
    const justBeforeSpawn = new Date(
      spawnMs - (DSH_SESSION_MTIME_TOLERANCE_MS - 500),
    );
    fs.utimesSync(
      path.join(sessionsDir, sessionName),
      justBeforeSpawn,
      justBeforeSpawn,
    );

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      spawnedAtMs: spawnMs,
      workdir,
      env: envWithFakeZstd(dshHome, binDir),
      zstdStrategy: "binary",
    });

    assert.ok(result !== null, "a just-before-spawn mtime is within tolerance");
    assert.equal(result.totalTokens, 42);
    assert.equal(result.sessionRef, sessionName);
    assert.doesNotMatch(readTamanduaLog(), /no session created since spawn/);
  });

  it("excludes a session whose mtime is older than spawn beyond the mtime tolerance", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const spawnMs = 1_700_000_000_000;
    const sessionName = "session-too-old";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName,
      content: headerLine(sessionName, 1) + usageLine({ input: 999, output: 9, seq: 1 }),
    });

    const sessionsDir = dshSessionProjectDir(dshHome, workdir);
    const tooOld = new Date(spawnMs - (DSH_SESSION_MTIME_TOLERANCE_MS + 5_000));
    fs.utimesSync(path.join(sessionsDir, sessionName), tooOld, tooOld);

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      spawnedAtMs: spawnMs,
      workdir,
      env: envWithFakeZstd(dshHome, binDir),
      zstdStrategy: "binary",
    });

    assert.equal(result, null, "beyond tolerance must never fabricate a total");
    assert.match(readTamanduaLog(), /no session created since spawn/);
  });

  it("picks the newest eligible session when one is within tolerance and one is after spawn", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const spawnMs = 1_700_000_000_000;

    const tolerated = "session-tolerated";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: tolerated,
      content: headerLine(tolerated, 1) + usageLine({ input: 111, output: 1, seq: 1 }),
    });
    const newer = "session-newer-after-spawn";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: newer,
      content: headerLine(newer, 1) + usageLine({ input: 222, output: 2, seq: 1 }),
    });

    const sessionsDir = dshSessionProjectDir(dshHome, workdir);
    const toleratedMtime = new Date(
      spawnMs - (DSH_SESSION_MTIME_TOLERANCE_MS - 500),
    );
    fs.utimesSync(
      path.join(sessionsDir, tolerated),
      toleratedMtime,
      toleratedMtime,
    );
    const newerMtime = new Date(spawnMs + 1_000);
    fs.utimesSync(path.join(sessionsDir, newer), newerMtime, newerMtime);

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      spawnedAtMs: spawnMs,
      workdir,
      env: envWithFakeZstd(dshHome, binDir),
      zstdStrategy: "binary",
    });

    assert.ok(result !== null);
    assert.equal(result.totalTokens, 224, "the post-spawn session is newest");
    assert.equal(result.sessionRef, newer);
  });

  it("applies the same mtime tolerance to the unsupported-layout probe", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const spawnMs = 1_700_000_000_000;
    const sessionName = "session-legacy-within-tolerance";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName,
      fileName: "session.v2.jsonl.zstd",
      content: headerLine(sessionName, 1) + usageLine({ input: 5, output: 5, seq: 1 }),
    });

    const sessionsDir = dshSessionProjectDir(dshHome, workdir);
    const justBeforeSpawn = new Date(
      spawnMs - (DSH_SESSION_MTIME_TOLERANCE_MS - 500),
    );
    fs.utimesSync(
      path.join(sessionsDir, sessionName),
      justBeforeSpawn,
      justBeforeSpawn,
    );

    const result = await lookupDshSessionTokens({
      spawnedAtMs: spawnMs,
      workdir,
      env: envWith(dshHome),
    });

    assert.equal(result, null);
    assert.match(
      readTamanduaLog(),
      /unsupported session layout .*session\.v2\.jsonl\.zstd/,
      "a tolerated legacy session must reach the upgrade-dsh warning, not the empty-spawn warning",
    );
  });

  it("returns null and warns once for a v1-only session.jsonl.zstd layout", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: "session-v1",
      fileName: "session.jsonl.zstd",
      // Deliberately not a valid zstd stream: the unsupported layout must
      // be rejected before any read, so its bytes never matter.
      content: headerLine("s", 1) + usageLine({ input: 999, output: 9, seq: 1 }),
    });

    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWith(dshHome),
    });

    assert.equal(result, null, "an unsupported v1 layout must never yield a total");
    const log = readTamanduaLog();
    assert.match(log, /found session\.jsonl\.zstd/, "warning must name the found file");
    assert.match(log, /dsh >= 0\.1\.5/, "warning must state the required dsh version");
    assert.match(log, /upgrade dsh/, "warning must give the upgrade-dsh remedy");
    assert.equal(
      log.split("\n").filter((l) => l.includes("unsupported session layout")).length,
      1,
      "the unsupported-layout warning must be emitted exactly once",
    );
  });

  it("returns null and warns once for a v2-only session.v2.jsonl.zstd layout", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: "session-v2",
      fileName: "session.v2.jsonl.zstd",
      content: "not a zstd stream and never read",
    });

    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWith(dshHome),
    });

    assert.equal(result, null);
    const log = readTamanduaLog();
    assert.match(log, /found session\.v2\.jsonl\.zstd/);
    assert.match(log, /upgrade dsh/);
    assert.match(log, /dsh >= 0\.1\.5/);
    assert.equal(
      log.split("\n").filter((l) => l.includes("unsupported session layout")).length,
      1,
    );
  });

  it("returns null and warns for a plain (uncompressed) v1 session.jsonl layout", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: "session-v1-plain",
      fileName: "session.jsonl",
      content: "legacy plain log — never read",
    });

    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWith(dshHome),
    });

    assert.equal(result, null);
    const log = readTamanduaLog();
    assert.match(log, /found session\.jsonl(?!\.zstd)/);
    assert.match(log, /upgrade dsh/);
  });

  it("reads a plain session.v3.jsonl directly without invoking zstd", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const sessionName = "session-plain-v3";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName,
      fileName: "session.v3.jsonl",
      content: headerLine(sessionName, 1) + usageLine({ input: 7, output: 3, seq: 1 }),
    });

    // The "none" tier would warn and return null if the reader touched
    // zstd; a parsed total proves the plain log skipped zstd entirely.
    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWith(dshHome),
      zstdStrategy: "none",
    });

    assert.ok(result !== null);
    assert.equal(result.totalTokens, 10);
    assert.equal(result.sessionRef, sessionName);
    assert.doesNotMatch(readTamanduaLog(), /no zstd support available/);
  });

  it("prefers the .zstd v3 log over the plain v3 log when both exist", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const sessionName = "session-both-v3";
    const sessionDir = path.join(dshSessionProjectDir(dshHome, workdir), sessionName);
    fs.mkdirSync(sessionDir, { recursive: true });
    // Plain form would total 2; the fake `zstd -dc` (cat) exposes the
    // compressed form's bytes, which total 150 — so the observed value
    // identifies which file won.
    fs.writeFileSync(
      path.join(sessionDir, "session.v3.jsonl"),
      headerLine(sessionName, 1) + usageLine({ input: 1, output: 1, seq: 1 }),
    );
    fs.writeFileSync(
      path.join(sessionDir, "session.v3.jsonl.zstd"),
      headerLine(sessionName, 1) + usageLine({ input: 100, output: 50, seq: 1 }),
    );

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      spawnedAtMs: 0,
      workdir,
      env: envWithFakeZstd(dshHome, binDir),
      zstdStrategy: "binary",
    });

    assert.ok(result !== null);
    assert.equal(result.totalTokens, 150, "the .zstd form must win over the plain form");
    assert.equal(result.sessionRef, sessionName);
  });

  it("prefers a v3 session over a newer older-layout sibling", async () => {
    const dshHome = path.join(tmpRoot!, "dsh-home");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const spawnMs = 1_700_000_000_000;

    // The older-layout sibling is NEWER on disk but unsupported: it must
    // be ignored (and not warned about) because a v3 session exists.
    const legacy = "session-older-layout";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: legacy,
      fileName: "session.jsonl.zstd",
      content: "legacy bytes — never read",
    });
    const v3 = "session-v3-wins";
    writeSessionDir({
      dshHome,
      workdir,
      sessionName: v3,
      fileName: "session.v3.jsonl",
      content: headerLine(v3, 1) + usageLine({ input: 42, output: 8, seq: 1 }),
    });

    const sessionsDir = dshSessionProjectDir(dshHome, workdir);
    fs.utimesSync(
      path.join(sessionsDir, legacy),
      new Date(spawnMs + 9_000),
      new Date(spawnMs + 9_000),
    );
    fs.utimesSync(
      path.join(sessionsDir, v3),
      new Date(spawnMs + 1_000),
      new Date(spawnMs + 1_000),
    );

    const result = await lookupDshSessionTokens({
      spawnedAtMs: spawnMs,
      workdir,
      env: envWith(dshHome),
      zstdStrategy: "none",
    });

    assert.ok(result !== null);
    assert.equal(result.sessionRef, v3);
    assert.equal(result.totalTokens, 50);
    assert.doesNotMatch(readTamanduaLog(), /unsupported session layout/);
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

// ── Real dsh 0.1.5 (v3) multi-frame fixture ────────────────────────

describe("dsh v3 real multi-frame fixture", () => {
  it("ships the coordinator-verified fixture bytes (sha256)", () => {
    assert.ok(fs.existsSync(FIXTURE_ZSTD), `fixture missing: ${FIXTURE_ZSTD}`);
    const sha = createHash("sha256").update(fs.readFileSync(FIXTURE_ZSTD)).digest("hex");
    assert.equal(sha, FIXTURE_SHA256);
    assert.ok(fs.existsSync(FIXTURE_LOCK), `fixture lock missing: ${FIXTURE_LOCK}`);
  });

  it(
    "decodes every frame of the concatenated container (18 records, not just the first)",
    { skip: !haveNodeZstd },
    () => {
      const buffer = fs.readFileSync(FIXTURE_ZSTD);

      // Guard against regression to whole-buffer decoding: node:zlib
      // applied to the whole concatenated buffer returns ONLY the first
      // frame — one record. This is the defect the frame scan fixes.
      const firstFrameOnly = zlib.zstdDecompressSync(buffer).toString("utf8");
      const naiveRecords = firstFrameOnly.split("\n").filter((l) => l.trim().length > 0);
      assert.equal(
        naiveRecords.length,
        1,
        "whole-buffer zstdDecompressSync is expected to yield only the first frame",
      );

      return decompressDshSessionLog(FIXTURE_ZSTD, "node").then((text) => {
        assert.ok(text !== null, "node zstd tier must decode the real fixture");
        const records = text!
          .split("\n")
          .filter((l) => l.trim().length > 0);
        assert.equal(records.length, 18, "all 18 frames/records must be decoded");
        // Every decoded record must be valid JSON (proves frames were not
        // concatenated mid-record).
        for (const record of records) {
          assert.doesNotThrow(() => JSON.parse(record));
        }
      });
    },
  );

  it(
    "looks up exactly 7235 tokens from the real fixture via the node tier",
    { skip: !haveNodeZstd },
    async () => {
      const dshHome = path.join(tmpRoot!, "dsh-home");
      const workdir = path.join(tmpRoot!, "worktree", "repo");
      stageFixtureSession({ dshHome, workdir });

      const result = await lookupDshSessionTokens({
        spawnedAtMs: 0,
        workdir,
        env: envWith(dshHome),
        zstdStrategy: "node",
      });

      assert.ok(result !== null, "the real v3 fixture must yield a total");
      // Hand computation: input 7222 + output 13 = 7235. cacheReadTokens
      // (0) and reasoningTokens (11) are excluded by the shared policy,
      // and the duplicate data.stream[].chunk.usage copy is not counted.
      assert.equal(result.totalTokens, FIXTURE_TOTAL_TOKENS);
      assert.equal(result.sessionRef, FIXTURE_SESSION_NAME);

      // The "auto" tier must ALSO decode every frame on a Node that has
      // zlib zstd (it selects the frame-scanning node path) — not just
      // the first frame.
      const autoResult = await lookupDshSessionTokens({
        spawnedAtMs: 0,
        workdir,
        env: envWith(dshHome),
      });
      assert.ok(autoResult !== null, "the auto tier must decode the real fixture");
      assert.equal(autoResult.totalTokens, FIXTURE_TOTAL_TOKENS);
    },
  );

  it(
    "looks up exactly 7235 tokens from the real fixture via the binary zstd tier",
    { skip: !haveZstdBinary },
    async () => {
      const dshHome = path.join(tmpRoot!, "dsh-home");
      const workdir = path.join(tmpRoot!, "worktree", "repo");
      stageFixtureSession({ dshHome, workdir });

      const result = await lookupDshSessionTokens({
        spawnedAtMs: 0,
        workdir,
        // Real PATH so the genuine `zstd -dc` (v1.4.8) is spawned.
        env: envWith(dshHome),
        zstdStrategy: "binary",
      });

      assert.ok(result !== null, "the real v3 fixture must yield a total");
      assert.equal(result.totalTokens, FIXTURE_TOTAL_TOKENS);
      assert.equal(result.sessionRef, FIXTURE_SESSION_NAME);
    },
  );

  it(
    "returns null (never a partial total) for a truncated fixture, without throwing",
    { skip: !haveNodeZstd },
    async () => {
      const dshHome = path.join(tmpRoot!, "dsh-home");
      const workdir = path.join(tmpRoot!, "worktree", "repo");
      // Cut bytes off the tail so the final zstd frame is incomplete.
      stageFixtureSession({
        dshHome,
        workdir,
        mutate: (bytes) => bytes.subarray(0, bytes.length - 5),
      });

      const result = await lookupDshSessionTokens({
        spawnedAtMs: 0,
        workdir,
        env: envWith(dshHome),
        zstdStrategy: "node",
      });

      assert.equal(result, null, "a truncated container must not fabricate a total");
      assert.match(readTamanduaLog(), /failed to decompress session log/);

      // Direct entry point must also degrade to null instead of throwing.
      const truncatedPath = stageFixtureSession({
        dshHome: path.join(tmpRoot!, "dsh-home-2"),
        workdir,
        mutate: (bytes) => bytes.subarray(0, bytes.length - 5),
      }).logPath;
      const text = await decompressDshSessionLog(truncatedPath, "node");
      assert.equal(text, null);
    },
  );
});
