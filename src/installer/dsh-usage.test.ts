/**
 * Unit tests for dsh-usage.ts — the OWNED-store reader (DSH-OWNER).
 *
 * Most fixtures are synthetic session logs (no real dsh, no model calls,
 * zero tokens) staged under an invocation-owned root, the same layout the
 * dispatcher hands to dsh through the `--patch` persistence overlay.
 * zstd fixture compression is feature-gated on node:zlib
 * `zstdCompressSync` (Node >= 23.8); the binary-strategy tests exercise
 * the same parsing through a fake `zstd` shell script so the reader's
 * core logic is covered on every supported Node.
 *
 * The "dsh v3 real multi-frame fixture" suite additionally stages the
 * coordinator-verified dsh 0.1.5 container (copied byte-for-byte into
 * tests/fixtures/dsh-v3/) and — on this host — exercises the genuine
 * `zstd -dc` binary.
 *
 * OWNERSHIP regressions pinned here (from the adversarial review):
 *   - a delayed-start own session (createdAt far outside any old window)
 *     is still selected from its own store — never a foreign session;
 *   - missing own evidence + a foreign session present elsewhere →
 *     UNOBSERVED, never the foreign session;
 *   - two roots, equal instants, unreadable artifacts, legacy layouts and
 *     symlinked entries all refuse (never "whichever entry parses").
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
  encodeDshSessionSegment,
  resolveDshHome,
  dshSessionProjectDir,
  dshOwnedSessionProjectDir,
  prepareDshOwnedStore,
  buildDshSessionRootOverlay,
  readDshOwnedReceipt,
  DSH_OWNED_OVERLAY_FILENAME,
  DSH_OWNED_RECEIPT_FILENAME,
  sumUsageChunks,
  decompressDshSessionLog,
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
 * Stage the real fixture as a v3 session directory under an owned root
 * (`<ownedRoot>/<escaped-workdir>/session-<uuid>`), preserving the file
 * bytes. `mutate` may rewrite the log bytes (e.g. truncation).
 */
function stageFixtureSession(opts: {
  ownedRoot: string;
  workdir: string;
  sessionName?: string;
  mutate?: (bytes: Buffer) => Buffer;
}): { sessionDir: string; logPath: string } {
  const sessionName = opts.sessionName ?? FIXTURE_SESSION_NAME;
  const sessionsDir = dshOwnedSessionProjectDir(opts.ownedRoot, opts.workdir);
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

/** A valid ROOT v3 session header (the shape the reader classifies as root). */
function headerLine(id: string, createdAt: number): string {
  return (
    JSON.stringify({
      type: "session",
      version: 3,
      id,
      createdAt,
      isSeeded: false,
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

/** Create a session dir under `<ownedRoot>/<escaped-workdir>` and write its log. */
function writeOwnedSession(opts: {
  ownedRoot: string;
  workdir: string;
  sessionName: string;
  content: Buffer | string;
  /** Session-log filename; defaults to the supported v3 compressed form. */
  fileName?: string;
}): string {
  const sessionsDir = dshOwnedSessionProjectDir(opts.ownedRoot, opts.workdir);
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

function envWith(binDir?: string): NodeJS.ProcessEnv {
  return binDir === undefined
    ? {}
    : { PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
}

// ── Warning capture (module warns through lib/logger) ─────────────

let tmpRoot: string | null = null;
let stateDir: string | null = null;
let savedStateDir: string | undefined;
let savedDshHome: string | undefined;

beforeEach(() => {
  tmpRoot = tamanduaTempDir("tamandua-test-dsh-usage-");
  stateDir = path.join(tmpRoot, "state");
  savedStateDir = process.env.TAMANDUA_STATE_DIR;
  savedDshHome = process.env.DSH_HOME;
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
  if (savedDshHome === undefined) {
    delete process.env.DSH_HOME;
  } else {
    process.env.DSH_HOME = savedDshHome;
  }
});

function readTamanduaLog(): string {
  try {
    return fs.readFileSync(path.join(stateDir!, "tamandua.log"), "utf8");
  } catch {
    return "";
  }
}

/** A fresh owned root for one synthetic invocation. */
function mkOwnedRoot(tag: string): string {
  const root = path.join(tmpRoot!, `owned-${tag}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
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

// ── encodeDshSessionSegment: dsh session-dir escaping replication ──

describe("encodeDshSessionSegment (dsh sessionDir parity)", () => {
  it("keeps safe [A-Za-z0-9._-] units literal", () => {
    assert.equal(
      encodeDshSessionSegment("session-4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d"),
      "session-4a1b2c3d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
    );
  });

  it("fully escapes . and ..", () => {
    assert.equal(encodeDshSessionSegment("."), "~002E");
    assert.equal(encodeDshSessionSegment(".."), "~002E~002E");
  });

  it("escapes unsafe code units as ~XXXX", () => {
    assert.equal(encodeDshSessionSegment("a/b"), "a~002Fb");
    assert.equal(encodeDshSessionSegment("a b"), "a~0020b");
  });

  it("throws on empty input (dsh parity)", () => {
    assert.throws(() => encodeDshSessionSegment(""), /empty path segment/);
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

// ── prepareDshOwnedStore: the invocation-ownership primitive ───────

describe("prepareDshOwnedStore", () => {
  it("creates a fresh root with the overlay and receipt, and distinct roots per invocation", () => {
    const state = path.join(tmpRoot!, "state");
    const a = prepareDshOwnedStore({
      stateDir: state,
      runId: "run-11111111-1111-4111-8111-111111111111",
      jobId: "job-developer",
      phase: "work",
    });
    const b = prepareDshOwnedStore({
      stateDir: state,
      runId: "run-11111111-1111-4111-8111-111111111111",
      jobId: "job-developer",
      phase: "work",
    });
    const probe = prepareDshOwnedStore({
      stateDir: state,
      runId: "run-11111111-1111-4111-8111-111111111111",
      jobId: "job-developer",
      phase: "probe",
    });
    assert.ok(a && b && probe, "preparation must succeed");

    // Same deterministic job id, three invocations → three DISTINCT roots.
    assert.notEqual(a!.ownedRoot, b!.ownedRoot);
    assert.notEqual(a!.ownedRoot, probe!.ownedRoot);
    assert.notEqual(b!.ownedRoot, probe!.ownedRoot);
    assert.ok(a!.ownedRoot.startsWith(path.join(state, "dsh-sessions")));

    // Overlay content: id-targeted session-persistence-jsonl root redirect.
    const overlay = fs.readFileSync(a!.overlayPath, "utf8");
    assert.match(overlay, /- id: session-persistence-jsonl/);
    assert.ok(
      overlay.includes(`root: ${JSON.stringify(a!.ownedRoot)}`),
      "overlay must name the owned root",
    );
    assert.match(overlay, /compression: zstd/);

    // Receipt: binds the root to this exact invocation.
    const receipt = readDshOwnedReceipt(a!.ownedRoot);
    assert.ok(receipt, "receipt must be readable");
    assert.equal(receipt!.runId, "run-11111111-1111-4111-8111-111111111111");
    assert.equal(receipt!.jobId, "job-developer");
    assert.equal(receipt!.phase, "work");
    assert.equal(receipt!.ownedRoot, a!.ownedRoot);
    assert.ok(fs.existsSync(path.join(a!.ownedRoot, DSH_OWNED_OVERLAY_FILENAME)));
    assert.ok(fs.existsSync(path.join(a!.ownedRoot, DSH_OWNED_RECEIPT_FILENAME)));
  });

  it("refuses (null) for missing identity, never fabricating a root", () => {
    const state = path.join(tmpRoot!, "state");
    assert.equal(
      prepareDshOwnedStore({ stateDir: "", runId: "r", jobId: "j", phase: "work" }),
      null,
    );
    assert.equal(
      prepareDshOwnedStore({ stateDir: state, runId: "", jobId: "j", phase: "work" }),
      null,
    );
    assert.equal(
      prepareDshOwnedStore({ stateDir: state, runId: "r", jobId: "", phase: "work" }),
      null,
    );
    assert.match(readTamanduaLog(), /dsh owned session store preparation failed/);
  });

  it("builds the overlay deterministically for a plain path", () => {
    const text = buildDshSessionRootOverlay("/var/lib/tamandua/owned");
    assert.match(text, /- id: session-persistence-jsonl/);
    assert.match(text, /root: "\/var\/lib\/tamandua\/owned"/);
    assert.match(text, /compression: zstd/);
  });
});

// ── lookupDshSessionTokens: owned-store reader ─────────────────────

describe("lookupDshSessionTokens (owned store)", () => {
  it("sums input+output across multiple v3 usage records via the binary zstd tier", async () => {
    const ownedRoot = mkOwnedRoot("basic");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const sessionName = "session-11111111-2222-4333-8444-555555555555";
    const text =
      headerLine(sessionName, 1_700_000_000_000) +
      usageLine({ input: 100, output: 50, cacheRead: 9_000, seq: 1 }) +
      usageLine({ input: 25, output: 75, cacheRead: 1_000, seq: 2 });
    writeOwnedSession({ ownedRoot, workdir, sessionName, content: text });

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(binDir),
      zstdStrategy: "binary",
    });

    assert.ok(result !== null);
    assert.equal(result.totalTokens, 250); // cache reads (10_000) excluded
    assert.equal(result.sessionRef, sessionName);
    assert.equal(result.sessionDir, path.join(dshOwnedSessionProjectDir(ownedRoot, workdir), sessionName));
  });

  it("returns null (UNOBSERVED) when the owned store is missing (with a warning)", async () => {
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const result = await lookupDshSessionTokens({
      ownedRoot: path.join(tmpRoot!, "never-created"),
      workdir,
      env: envWith(),
    });
    assert.equal(result, null);
    assert.match(readTamanduaLog(), /owned session store missing/);
  });

  it("returns null (UNOBSERVED) when the owned store holds no project dir for the workdir", async () => {
    const ownedRoot = mkOwnedRoot("empty");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
    });
    assert.equal(result, null);
    assert.match(readTamanduaLog(), /no session directory in the owned store/);
  });

  it("returns null and warns for a missing ownedRoot argument", async () => {
    const result = await lookupDshSessionTokens({
      ownedRoot: "",
      workdir: path.join(tmpRoot!, "worktree"),
    });
    assert.equal(result, null);
    assert.match(readTamanduaLog(), /no owned session store for this invocation/);
  });

  it("returns null and warns for an empty workdir", async () => {
    const result = await lookupDshSessionTokens({
      ownedRoot: mkOwnedRoot("empty-workdir"),
      workdir: "",
    });
    assert.equal(result, null);
    assert.match(readTamanduaLog(), /missing worker working directory/);
  });

  it("returns null and warns when no zstd support is available", async () => {
    const ownedRoot = mkOwnedRoot("no-zstd");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-aaa",
      content:
        headerLine("session-aaa", 1) + usageLine({ input: 1, output: 2, seq: 1 }),
    });

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /no zstd support available/);
  });

  it("returns null and warns on a corrupt session log", { skip: !haveNodeZstd }, async () => {
    const ownedRoot = mkOwnedRoot("corrupt");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-bbb",
      content: Buffer.from("this is not a zstd stream"),
    });

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "node",
    });

    // Corruption may be caught at header classification (unreadable
    // artifact) or at the usage decode; either way the lookup must refuse
    // with an UNOBSERVED warning and never a fabricated total.
    assert.equal(result, null);
    assert.match(
      readTamanduaLog(),
      /unreadable session artifact in the owned store|failed to decompress session log/,
    );
  });

  it("returns null and warns when the zstd binary is unavailable", async () => {
    const ownedRoot = mkOwnedRoot("no-binary");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-ccc",
      content:
        headerLine("session-ccc", 1) + usageLine({ input: 1, output: 2, seq: 1 }),
    });

    // PATH containing ONLY an empty directory (the real zstd binary is NOT
    // reachable) and strategy pinned to the binary tier.
    const emptyBinDir = path.join(tmpRoot!, "empty-bin");
    fs.mkdirSync(emptyBinDir, { recursive: true });
    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: { PATH: emptyBinDir },
      zstdStrategy: "binary",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /unreadable session artifact in the owned store/);
  });

  it("reads a plain session.v3.jsonl directly without invoking zstd", async () => {
    const ownedRoot = mkOwnedRoot("plain");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const sessionName = "session-plain-v3";
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName,
      fileName: "session.v3.jsonl",
      content:
        headerLine(sessionName, 1) + usageLine({ input: 7, output: 3, seq: 1 }),
    });

    // The "none" tier would warn and return null if the reader touched
    // zstd; a parsed total proves the plain log skipped zstd entirely.
    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.ok(result !== null);
    assert.equal(result.totalTokens, 10);
    assert.equal(result.sessionRef, sessionName);
    assert.doesNotMatch(readTamanduaLog(), /no zstd support available/);
  });

  it("prefers the .zstd v3 log over the plain v3 log when both exist", async () => {
    const ownedRoot = mkOwnedRoot("both");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const sessionName = "session-both-v3";
    const sessionDir = path.join(dshOwnedSessionProjectDir(ownedRoot, workdir), sessionName);
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
      ownedRoot,
      workdir,
      env: envWith(binDir),
      zstdStrategy: "binary",
    });

    assert.ok(result !== null);
    assert.equal(result.totalTokens, 150, "the .zstd form must win over the plain form");
    assert.equal(result.sessionRef, sessionName);
  });

  it("returns null when the log has no usage chunks", async () => {
    const ownedRoot = mkOwnedRoot("no-usage");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-empty",
      content: headerLine("session-empty", 1),
    });

    const binDir = makeFakeZstdBin(tmpRoot!);
    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(binDir),
      zstdStrategy: "binary",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /found no usage chunks/);
  });

  // ── Ownership regressions (adversarial review counterexamples) ──

  it("OWNERSHIP (S4): a delayed-start own session is selected despite a foreign session in the shared store", async () => {
    const ownedRoot = mkOwnedRoot("s4-own");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const dshHome = path.join(tmpRoot!, "default-dsh-home");
    process.env.DSH_HOME = dshHome;

    // The round's OWN session — its header createdAt is FAR outside every
    // legacy cutoff the previous design used (31s and beyond).
    const ownName = "session-own-delayed";
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: ownName,
      fileName: "session.v3.jsonl",
      content:
        headerLine(ownName, 1_700_000_031_000) +
        usageLine({ input: 100, output: 10, seq: 1 }),
    });

    // The formerly attractive FOREIGN session, in the shared default store
    // (an in-window-looking createdAt and higher usage). Ownership means it
    // is never read: the lookup does not scan $DSH_HOME at all. DSH_HOME is
    // explicitly pointed at it so a regression to shared-store scanning
    // WOULD find it (and fail the assertion below).
    const foreignName = "session-foreign-tempting";
    const foreignDir = path.join(dshSessionProjectDir(dshHome, workdir), foreignName);
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(
      path.join(foreignDir, "session.v3.jsonl"),
      headerLine(foreignName, 1_700_000_005_000) +
        usageLine({ input: 200, output: 20, seq: 1 }),
    );

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.ok(result !== null, "own store session must be readable");
    assert.equal(result.sessionRef, ownName, "must select the OWN session");
    assert.equal(result.totalTokens, 110, "must charge the OWN usage (110), never 220");
  });

  it("OWNERSHIP (S4z): compressed own session beyond the old cutoff is selected over a foreign one", { skip: !haveNodeZstd }, async () => {
    const ownedRoot = mkOwnedRoot("s4z-own");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const dshHome = path.join(tmpRoot!, "default-dsh-home");
    process.env.DSH_HOME = dshHome;

    const ownName = "session-own-delayed-zstd";
    // Multi-frame container (header frame + usage frame), like dsh writes.
    const ownBytes = Buffer.concat([
      zstdCompress!(Buffer.from(headerLine(ownName, 1_700_000_031_000))),
      zstdCompress!(Buffer.from(usageLine({ input: 100, output: 10, seq: 1 }))),
    ]);
    writeOwnedSession({ ownedRoot, workdir, sessionName: ownName, content: ownBytes });

    const foreignName = "session-foreign-tempting-zstd";
    const foreignDir = path.join(dshSessionProjectDir(dshHome, workdir), foreignName);
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(
      path.join(foreignDir, "session.v3.jsonl"),
      headerLine(foreignName, 1_700_000_005_000) +
        usageLine({ input: 200, output: 20, seq: 1 }),
    );

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "auto",
    });

    assert.ok(result !== null);
    assert.equal(result.sessionRef, ownName);
    assert.equal(result.totalTokens, 110);
  });

  it("OWNERSHIP (S1): missing own evidence + a foreign session present elsewhere → UNOBSERVED, never the foreign", async () => {
    const ownedRoot = mkOwnedRoot("s1-no-own");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const dshHome = path.join(tmpRoot!, "default-dsh-home");
    process.env.DSH_HOME = dshHome;

    // The own store exists (prepared, like a real round) but dsh never
    // materialized a session in it.
    const foreignName = "session-foreign-sole";
    const foreignDir = path.join(dshSessionProjectDir(dshHome, workdir), foreignName);
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(
      path.join(foreignDir, "session.v3.jsonl"),
      headerLine(foreignName, 1_700_000_005_000) +
        usageLine({ input: 200, output: 20, seq: 1 }),
    );

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.equal(result, null, "no own evidence must read UNOBSERVED, never a foreign session");
    const log = readTamanduaLog();
    assert.match(log, /no session directory in the owned store/);
    assert.doesNotMatch(log, /session-foreign-sole/, "the foreign session must never be named as read");
  });

  it("refuses when TWO roots exist in the owned store (never ranked)", async () => {
    const ownedRoot = mkOwnedRoot("two-roots");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-root-a",
      fileName: "session.v3.jsonl",
      content: headerLine("session-root-a", 1) + usageLine({ input: 100, output: 10, seq: 1 }),
    });
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-root-b",
      fileName: "session.v3.jsonl",
      content: headerLine("session-root-b", 2) + usageLine({ input: 200, output: 20, seq: 1 }),
    });

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.equal(result, null, "ambiguous roots must refuse");
    assert.match(readTamanduaLog(), /multiple root sessions in the owned store/);
  });

  it("refuses EQUAL-INSTANT roots exactly like any two roots (timestamps grant no privilege)", async () => {
    const ownedRoot = mkOwnedRoot("equal-instant");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    for (const name of ["session-eq-a", "session-eq-b"]) {
      writeOwnedSession({
        ownedRoot,
        workdir,
        sessionName: name,
        fileName: "session.v3.jsonl",
        content: headerLine(name, 1_700_000_000_000) + usageLine({ input: 100, output: 10, seq: 1 }),
      });
    }

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /multiple root sessions in the owned store/);
  });

  it("PRESERVED: a non-root sibling (child/subagent/seeded) is excluded; the root is selected", async () => {
    const ownedRoot = mkOwnedRoot("non-root-sibling");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const ownName = "session-own-root";
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: ownName,
      fileName: "session.v3.jsonl",
      content: headerLine(ownName, 1) + usageLine({ input: 100, output: 10, seq: 1 }),
    });
    // A delegated child session (parentSession set) — not the round's own
    // root accounting.
    const childName = "session-child";
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: childName,
      fileName: "session.v3.jsonl",
      content:
        JSON.stringify({
          type: "session",
          version: 3,
          id: childName,
          createdAt: 2,
          isSeeded: false,
          delegationDepth: 1,
          parentSession: "session-own-root",
        }) + "\n",
    });

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.ok(result !== null);
    assert.equal(result.sessionRef, ownName);
    assert.equal(result.totalTokens, 110);
  });

  it("refuses when the owned store holds ONLY a non-root session (no root accounting)", async () => {
    const ownedRoot = mkOwnedRoot("only-non-root");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-seeded-only",
      fileName: "session.v3.jsonl",
      content:
        JSON.stringify({
          type: "session",
          version: 3,
          id: "session-seeded-only",
          createdAt: 1,
          isSeeded: true,
          delegationDepth: 0,
        }) + "\n",
    });

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /no root session in the owned store/);
  });

  it("refuses when an unreadable artifact sits in the owned store (never 'whichever entry parses')", async () => {
    const ownedRoot = mkOwnedRoot("unreadable");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-readable",
      fileName: "session.v3.jsonl",
      content: headerLine("session-readable", 1) + usageLine({ input: 100, output: 10, seq: 1 }),
    });
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-garbage",
      fileName: "session.v3.jsonl.zstd",
      content: Buffer.from("not a zstd stream at all"),
    });

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "node",
    });

    assert.equal(result, null, "an unreadable artifact must refuse the lookup");
    assert.match(readTamanduaLog(), /unreadable session artifact in the owned store/);
  });

  it("refuses a session directory holding no recognized log", async () => {
    const ownedRoot = mkOwnedRoot("no-artifact");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const sessionDir = path.join(dshOwnedSessionProjectDir(ownedRoot, workdir), "session-empty-dir");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "notes.txt"), "not a session log");

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /unclassifiable artifact in the owned store/);
  });

  it("refuses a symlinked session directory (never follows it)", async () => {
    const ownedRoot = mkOwnedRoot("symlink");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    const sessionsDir = dshOwnedSessionProjectDir(ownedRoot, workdir);
    fs.mkdirSync(sessionsDir, { recursive: true });
    const outside = path.join(tmpRoot!, "outside-session");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(
      path.join(outside, "session.v3.jsonl"),
      headerLine("session-outside", 1) + usageLine({ input: 999, output: 9, seq: 1 }),
    );
    fs.symlinkSync(outside, path.join(sessionsDir, "session-linked"));

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /unclassifiable artifact in the owned store/);
  });

  it("refuses when the winning log's directory name does not match its header id", async () => {
    const ownedRoot = mkOwnedRoot("name-mismatch");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-dir-name",
      fileName: "session.v3.jsonl",
      content: headerLine("session-different-id", 1) + usageLine({ input: 100, output: 10, seq: 1 }),
    });

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /session directory name does not match its header id/);
  });

  it("refuses an unsupported (pre-v3) layout in the owned store with the upgrade-dsh remedy", async () => {
    const ownedRoot = mkOwnedRoot("legacy");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-v1",
      fileName: "session.jsonl.zstd",
      // Deliberately not a valid zstd stream: the unsupported layout must
      // be rejected before any read, so its bytes never matter.
      content: headerLine("session-v1", 1) + usageLine({ input: 999, output: 9, seq: 1 }),
    });

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
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

  it("still refuses when a readable root coexists with a legacy layout (fully-classifiable store required)", async () => {
    const ownedRoot = mkOwnedRoot("root-plus-legacy");
    const workdir = path.join(tmpRoot!, "worktree", "repo");
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-root-ok",
      fileName: "session.v3.jsonl",
      content: headerLine("session-root-ok", 1) + usageLine({ input: 100, output: 10, seq: 1 }),
    });
    writeOwnedSession({
      ownedRoot,
      workdir,
      sessionName: "session-v2-layout",
      fileName: "session.v2.jsonl.zstd",
      content: "not a zstd stream and never read",
    });

    const result = await lookupDshSessionTokens({
      ownedRoot,
      workdir,
      env: envWith(),
      zstdStrategy: "none",
    });

    assert.equal(result, null);
    assert.match(readTamanduaLog(), /unsupported session layout .*session\.v2\.jsonl\.zstd/);
  });

  // ── node:zlib zstd tier (feature-gated on Node >= 23.8) ────────

  it(
    "decompresses a multi-frame concatenated zstd log and sums usage chunks",
    { skip: !haveNodeZstd },
    async () => {
      const ownedRoot = mkOwnedRoot("multiframe");
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
      writeOwnedSession({
        ownedRoot,
        workdir,
        sessionName,
        content: Buffer.concat([frame1, frame2]),
      });

      const result = await lookupDshSessionTokens({
        ownedRoot,
        workdir,
        env: envWith(),
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
      const ownedRoot = mkOwnedRoot("singleframe");
      const workdir = path.join(tmpRoot!, "worktree", "repo");
      const sessionName = "session-33333333-4444-4555-8666-777777777777";
      const compressed = zstdCompress!(
        Buffer.from(
          headerLine(sessionName, 1) +
            usageLine({ input: 5, output: 6, cacheRead: 700, seq: 1 }),
        ),
      );
      writeOwnedSession({ ownedRoot, workdir, sessionName, content: compressed });

      const result = await lookupDshSessionTokens({
        ownedRoot,
        workdir,
        env: envWith(),
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
      const ownedRoot = mkOwnedRoot("fixture");
      const workdir = path.join(tmpRoot!, "worktree", "repo");
      stageFixtureSession({ ownedRoot, workdir });

      const result = await lookupDshSessionTokens({
        ownedRoot,
        workdir,
        env: envWith(),
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
        ownedRoot,
        workdir,
        env: envWith(),
      });
      assert.ok(autoResult !== null, "the auto tier must decode the real fixture");
      assert.equal(autoResult.totalTokens, FIXTURE_TOTAL_TOKENS);
    },
  );

  it(
    "looks up exactly 7235 tokens from the real fixture via the binary zstd tier",
    { skip: !haveZstdBinary },
    async () => {
      const ownedRoot = mkOwnedRoot("fixture-binary");
      const workdir = path.join(tmpRoot!, "worktree", "repo");
      stageFixtureSession({ ownedRoot, workdir });

      const result = await lookupDshSessionTokens({
        ownedRoot,
        workdir,
        // Real PATH so the genuine `zstd -dc` (v1.4.8) is spawned.
        env: envWith(),
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
      const ownedRoot = mkOwnedRoot("fixture-truncated");
      const workdir = path.join(tmpRoot!, "worktree", "repo");
      // Cut bytes off the tail so the final zstd frame is incomplete.
      stageFixtureSession({
        ownedRoot,
        workdir,
        mutate: (bytes) => bytes.subarray(0, bytes.length - 5),
      });

      const result = await lookupDshSessionTokens({
        ownedRoot,
        workdir,
        env: envWith(),
        zstdStrategy: "node",
      });

      assert.equal(result, null, "a truncated container must not fabricate a total");
      assert.match(readTamanduaLog(), /failed to decompress session log/);

      // Direct entry point must also degrade to null instead of throwing.
      const truncatedPath = stageFixtureSession({
        ownedRoot: mkOwnedRoot("fixture-truncated-2"),
        workdir,
        mutate: (bytes) => bytes.subarray(0, bytes.length - 5),
      }).logPath;
      const text = await decompressDshSessionLog(truncatedPath, "node");
      assert.equal(text, null);
    },
  );
});
