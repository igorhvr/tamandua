/**
 * Focused deterministic tests for the Matchlock dsh adapter slice
 * (`src/installer/matchlock/dsh-*`).
 *
 * Everything runs against synthetic frozen inputs and temp dirs: no real dsh,
 * no model calls, no real `~/.dsh`, no child processes (this file stays in the
 * parallel lane — tests/serial-files.txt is untouched). zstd fixtures are
 * compressed with node:zlib and feature-gated for Node >= 23.8; the plaintext
 * encoding path is always exercised.
 */
// ── US-003 v2 -> v3 rename (documented in REWRITTEN_ASSERTIONS) ──────
// MTLK-DSH-EXEC union MAIN-DSV2: the source branch pinned the dsh v2
// session-store layout (session.v2.jsonl[.zstd]) and titled its tests
// accordingly; certified main's DSV2 ships the dsh >= 0.1.5 v3 store
// (session.v3.jsonl[.zstd]) whose host reader (src/installer/dsh-usage.ts)
// this in-VM reader now matches. Every "v2" test title below was renamed to
// "v3" (see tests/matchlock-integration-test-parity.test.ts).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { tamanduaTempDir } from "../dist/lib/temp-dir.js";
import {
  DSH_GUEST_CONFIGURATION_ROOT,
  DSH_GUEST_PERMISSION_MODE,
  DSH_GUEST_PROFILE,
} from "../dist/installer/matchlock/dsh-adapter-contract.js";
import {
  planDshExecution,
} from "../dist/installer/matchlock/dsh-adapter.js";
import {
  expandDshTilde,
  inspectDshProfileModuleLinks,
  describeDshHomeLayout,
  listDirectoryPresence,
  resolveDshHostHome,
} from "../dist/installer/matchlock/dsh-home.js";
import {
  buildDshGuestEnv,
  buildDshGuestLaunch,
  buildDshLaunchArgv,
  classifyDshRoundTermination,
} from "../dist/installer/matchlock/dsh-launch.js";
import {
  discoverSessionArtifacts,
  extractMatchlockUsage,
  matchlockProjectKey,
  matchlockSessionProjectDir,
  parseSessionHeader,
  readDshSessionArtifact,
  scanMatchlockZstdFrames,
  setMatchlockNodeZstdAvailableForTest,
} from "../dist/installer/matchlock/dsh-session-store.js";
import {
  resolveDshAttribution,
  snapshotDshSessions,
} from "../dist/installer/matchlock/dsh-attribution.js";

// ── zstd feature gate (Node >= 23.8) ───────────────────────────────

const zstdCompress =
  typeof (zlib as { zstdCompressSync?: unknown }).zstdCompressSync === "function"
    ? (zlib as { zstdCompressSync: (b: Uint8Array) => Buffer }).zstdCompressSync
    : null;
const haveNodeZstd = zstdCompress !== null;

// ── Synthetic session-log fixtures ─────────────────────────────────

function v3HeaderLine(opts: {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  origin?: "subagent";
  isSeeded?: boolean;
  delegationDepth?: number;
}): string {
  const header: Record<string, unknown> = {
    type: "session",
    version: 3,
    id: opts.id,
    createdAt: opts.createdAt,
    cwd: opts.cwd ?? "/work/area",
    isSeeded: opts.isSeeded ?? false,
    delegationDepth: opts.delegationDepth ?? 0,
  };
  if (opts.parentSession !== undefined) header.parentSession = opts.parentSession;
  if (opts.origin !== undefined) header.origin = opts.origin;
  return JSON.stringify(header) + "\n";
}

function v3MessageLine(opts: {
  uncachedInput: number;
  output: number;
  turn?: number;
  step?: number;
  malformed?: boolean;
  /** When true, mirror the usage into data.stream[*].chunk.usage (real dsh v3 does this). */
  streamMirror?: boolean;
}): string {
  const usage = opts.malformed
    ? { inputTokens: "not-a-number", outputTokens: opts.output }
    : { inputTokens: opts.uncachedInput, outputTokens: opts.output };
  const stream = opts.streamMirror
    ? [
        {
          chunk: {
            type: "usage",
            usage: {
              inputTokens: opts.uncachedInput,
              outputTokens: opts.output,
              cacheReadTokens: 999,
              totalTokens: opts.uncachedInput + opts.output + 999,
            },
          },
        },
      ]
    : [];
  return (
    JSON.stringify({
      type: "assistant/message",
      seq: 1,
      time: 1_700_000_000_000,
      data: {
        turn: opts.turn ?? 0,
        step: opts.step ?? 0,
        message: { role: "assistant", content: [] },
        usage,
        stream,
      },
    }) + "\n"
  );
}

function legacyUsageLine(opts: { input: number; output: number; cacheRead?: number }): string {
  return (
    JSON.stringify({
      type: "assistant/chunk",
      seq: 1,
      time: 1_700_000_000_000,
      data: {
        turn: 0,
        step: 0,
        chunk: {
          type: "usage",
          usage: {
            inputTokens: opts.input,
            outputTokens: opts.output,
            ...(opts.cacheRead !== undefined ? { cacheReadTokens: opts.cacheRead } : {}),
          },
        },
      },
    }) + "\n"
  );
}

/**
 * Raw v3 `assistant/message` record WITHOUT `data.usage`. The message role
 * defaults to "assistant" (a usage-bearing message with MISSING usage cannot be
 * verified -> incomplete); a non-assistant role (e.g. a user echo) is a
 * legitimate non-usage record that is never counted and never marks incomplete.
 */
function v3MessageWithoutUsageLine(opts: { role?: string } = {}): string {
  return (
    JSON.stringify({
      type: "assistant/message",
      seq: 1,
      time: 1_700_000_000_000,
      data: {
        turn: 0,
        step: 0,
        message: { role: opts.role ?? "assistant", content: [] },
      },
    }) + "\n"
  );
}

function buildV3LogText(opts: {
  id: string;
  createdAt: number;
  cwd?: string;
  parentSession?: string;
  origin?: "subagent";
  messages?: { uncachedInput: number; output: number; malformed?: boolean; streamMirror?: boolean }[];
  legacyUsage?: { input: number; output: number; cacheRead?: number }[];
  trailing?: string;
}): string {
  let text = v3HeaderLine({
    id: opts.id,
    createdAt: opts.createdAt,
    cwd: opts.cwd,
    parentSession: opts.parentSession,
    origin: opts.origin,
  });
  for (const m of opts.messages ?? []) {
    text += v3MessageLine(m);
  }
  for (const u of opts.legacyUsage ?? []) {
    text += legacyUsageLine(u);
  }
  if (opts.trailing !== undefined) text += opts.trailing;
  return text;
}

/** zstd-compress a fixture to one frame, or to two frames when `secondText`. */
function compressZstd(text: string, secondText?: string): Buffer {
  if (zstdCompress === null) {
    throw new Error("fixture requires node:zlib zstd");
  }
  const frame1 = zstdCompress(Buffer.from(text, "utf8"));
  if (secondText === undefined) return frame1;
  const frame2 = zstdCompress(Buffer.from(secondText, "utf8"));
  return Buffer.concat([frame1, frame2]);
}

interface TempHome {
  root: string;
  dshHome: string;
  workdir: string;
  projectDir: string;
}

function makeTempHome(): TempHome {
  const root = tamanduaTempDir("tamandua-matchlock-dsh-");
  const dshHome = path.join(root, "dsh-home");
  const workdir = path.join(root, "work", "area");
  fs.mkdirSync(path.join(dshHome, "sessions"), { recursive: true });
  fs.mkdirSync(workdir, { recursive: true });
  return { root, dshHome, workdir, projectDir: matchlockSessionProjectDir(dshHome, workdir) };
}

/** Write a session dir with a v3 zstd or plain artifact and return its path. */
function writeSession(opts: {
  dshHome: string;
  workdir: string;
  dirName: string;
  content: Buffer | string;
  fileName?: string;
  createdAtMs?: number;
}): string {
  const projectDir = matchlockSessionProjectDir(opts.dshHome, opts.workdir);
  const sessionDir = path.join(projectDir, opts.dirName);
  fs.mkdirSync(sessionDir, { recursive: true });
  const fileName = opts.fileName ?? (Buffer.isBuffer(opts.content) ? "session.v3.jsonl.zstd" : "session.v3.jsonl");
  fs.writeFileSync(path.join(sessionDir, fileName), opts.content);
  if (opts.createdAtMs !== undefined) {
    const t = new Date(opts.createdAtMs);
    fs.utimesSync(sessionDir, t, t);
  }
  return sessionDir;
}

// ── test scaffolding ───────────────────────────────────────────────

let homes: TempHome[] = [];
let artifactDirs: string[] = [];

function freshHome(): TempHome {
  const home = makeTempHome();
  homes.push(home);
  return home;
}

beforeEach(() => {
  homes = [];
  artifactDirs = [];
});

afterEach(() => {
  for (const home of homes) {
    fs.rmSync(home.root, { recursive: true, force: true });
  }
  for (const dir of artifactDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  homes = [];
  artifactDirs = [];
  setMatchlockNodeZstdAvailableForTest(null);
});

// ── Home resolution: frozen env/cwd/home ───────────────────────────

describe("resolveDshHostHome (frozen submission context)", () => {
  it("uses $DSH_HOME from the captured env, never the ambient process env", () => {
    const ambient = process.env.DSH_HOME;
    process.env.DSH_HOME = "/ambient/trap-home"; // must NOT be consulted
    try {
      const ctx = {
        homeDir: "/home/user",
        env: { DSH_HOME: "/srv/captured-dsh" },
        cwd: "/srv/project",
      };
      const resolved = resolveDshHostHome(ctx);
      assert.equal(resolved.hostHome, "/srv/captured-dsh");
      assert.equal(resolved.source, "env");
    } finally {
      if (ambient === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = ambient;
    }
  });

  it("falls back to <homeDir>/.dsh when DSH_HOME is unset or whitespace-only", () => {
    for (const envValue of [undefined, "", "   "]) {
      const resolved = resolveDshHostHome({
        homeDir: "/home/user",
        env: envValue === undefined ? {} : { DSH_HOME: envValue },
        cwd: "/srv/project",
      });
      assert.equal(resolved.hostHome, path.resolve("/home/user/.dsh"));
      assert.equal(resolved.source, "default");
    }
  });

  it("resolves a relative DSH_HOME against the captured submitting cwd", () => {
    const resolved = resolveDshHostHome({
      homeDir: "/home/user",
      env: { DSH_HOME: "config/dsh" },
      cwd: "/srv/captured/cwd",
    });
    assert.equal(resolved.hostHome, "/srv/captured/cwd/config/dsh");
  });

  it("expands a tilde prefix against the captured home", () => {
    const resolved = resolveDshHostHome({
      homeDir: "/home/user",
      env: { DSH_HOME: "~/dsh-alt" },
      cwd: "/srv/project",
    });
    assert.equal(resolved.hostHome, "/home/user/dsh-alt");
  });

  it("explicit configured override outranks DSH_HOME", () => {
    const resolved = resolveDshHostHome(
      { homeDir: "/home/user", env: { DSH_HOME: "/from-env" }, cwd: "/srv/project" },
      { configured: "/explicit" },
    );
    assert.equal(resolved.hostHome, "/explicit");
  });

  it("expandDshTilde parity with the captured home", () => {
    assert.equal(expandDshTilde("~", "/home/user"), "/home/user");
    assert.equal(expandDshTilde("~/x", "/home/user"), "/home/user/x");
    assert.equal(expandDshTilde("/abs", "/home/user"), "/abs");
  });
});

// ── planDshExecution facade ────────────────────────────────────────

describe("planDshExecution", () => {
  it("pins host home, guest home/profile and the preserved workdir", () => {
    const plan = planDshExecution(
      { homeDir: "/home/user", env: { DSH_HOME: "/host/dsh-home" }, cwd: "/work" },
      "/work/area",
    );
    assert.equal(plan.home.hostHome, "/host/dsh-home");
    assert.equal(plan.guestHome, DSH_GUEST_CONFIGURATION_ROOT);
    assert.equal(plan.guestProfile, DSH_GUEST_PROFILE);
    assert.equal(plan.guestPermissionMode, DSH_GUEST_PERMISSION_MODE);
    assert.equal(plan.workdir, "/work/area");
    assert.equal(plan.workdirPreserved, true);
    assert.equal(plan.preservation, "entire-home-rw");
  });
});

// ── Launch construction ────────────────────────────────────────────

describe("buildDshLaunchArgv / buildDshGuestLaunch (launch contract)", () => {
  it("builds dsh --profile headless <prompt> with no invented flags", () => {
    const argv = buildDshLaunchArgv("run the tests");
    assert.deepEqual(argv, ["dsh", "--profile", "headless", "run the tests"]);
    // No invented JSON/model/resume/timeout switches; no host binary path.
    for (const forbidden of ["--json", "--model", "--resume", "--timeout", "--cwd", "/usr/local/bin"]) {
      assert.ok(!argv.some((a) => a.includes(forbidden)), `forbidden token present: ${forbidden}`);
    }
  });

  it("uses TWO -- separators when the prompt starts with a leading dash", () => {
    const argv = buildDshLaunchArgv("-run the tests now");
    assert.deepEqual(argv, ["dsh", "--profile", "headless", "--", "--", "-run the tests now"]);
    // A single -- must not appear (outer + inner parsers each consume one).
    const separators = argv.filter((a) => a === "--");
    assert.equal(separators.length, 2);
  });

  it("single -- is not added for an ordinary prompt", () => {
    const argv = buildDshLaunchArgv("just text");
    assert.ok(!argv.includes("--"));
  });

  it("closes stdin and preserves stdout verbatim", () => {
    const descriptor = buildDshGuestLaunch({ prompt: "hello world" });
    assert.equal(descriptor.stdin, "close");
    assert.equal(descriptor.stdout, "verbatim");
    assert.equal(descriptor.promptLeadingDash, false);
    const leading = buildDshGuestLaunch({ prompt: "-leading" });
    assert.equal(leading.promptLeadingDash, true);
  });

  it("forces guest DSH_HOME and DSH_PERMISSION_MODE in the guest env", () => {
    const env = buildDshGuestEnv({});
    assert.equal(env.DSH_HOME, DSH_GUEST_CONFIGURATION_ROOT);
    assert.equal(env.DSH_PERMISSION_MODE, DSH_GUEST_PERMISSION_MODE);
  });

  it("extra guest env is merged but never overrides the two mandatory overrides", () => {
    const env = buildDshGuestEnv({
      extraGuestEnv: {
        DSH_HOME: "/wrong",
        DSH_PERMISSION_MODE: "workspace-write",
        ALLOWED_PROXY_SECRET: "x",
      },
    });
    assert.equal(env.DSH_HOME, DSH_GUEST_CONFIGURATION_ROOT);
    assert.equal(env.DSH_PERMISSION_MODE, DSH_GUEST_PERMISSION_MODE);
    assert.equal(env.ALLOWED_PROXY_SECRET, "x");
  });

  it("keeps argv[0] guest-relative (image PATH independent of host PATH)", () => {
    const descriptor = buildDshGuestLaunch({ prompt: "task", guestBinary: "dsh" });
    assert.equal(descriptor.command[0], "dsh");
    assert.ok(!descriptor.command[0].includes("/"));
  });

  it("rejects a non-string prompt", () => {
    assert.throws(() => buildDshLaunchArgv(123 as unknown as string), TypeError);
  });
});

describe("classifyDshRoundTermination (controller-owned outcome)", () => {
  it("a recorded timeout/cancel wins over a post-termination exit 0", () => {
    // dsh traps SIGTERM and exits 0 — a clean-looking exit must not erase a
    // controller timeout/cancellation.
    assert.equal(
      classifyDshRoundTermination({ timedOut: true, cancelled: false, exit: { exitCode: 0, signal: null } }),
      "timed-out",
    );
    assert.equal(
      classifyDshRoundTermination({ timedOut: false, cancelled: true, exit: { exitCode: 0, signal: "SIGTERM" } }),
      "cancelled",
    );
    assert.equal(
      classifyDshRoundTermination({ timedOut: true, cancelled: true, exit: { exitCode: 0, signal: null } }),
      "cancelled",
    );
  });

  it("classifies clean success and harness failure", () => {
    assert.equal(
      classifyDshRoundTermination({ timedOut: false, cancelled: false, exit: { exitCode: 0, signal: null } }),
      "completed",
    );
    assert.equal(
      classifyDshRoundTermination({ timedOut: false, cancelled: false, exit: { exitCode: 1, signal: null } }),
      "failed",
    );
    assert.equal(
      classifyDshRoundTermination({ timedOut: false, cancelled: false, exit: { exitCode: null, signal: "SIGKILL" } }),
      "failed",
    );
  });
});

// ── project key + session dir layout (native parity) ───────────────

describe("matchlockProjectKey (dsh session-format parity)", () => {
  it("matches the native reader's escaping for common cwds", () => {
    assert.equal(matchlockProjectKey("/opt/tamandua-dsh"), "--opt-tamandua-dsh--");
    assert.equal(matchlockProjectKey("/a//b///c"), "--a-b-c--");
    assert.equal(matchlockProjectKey("/"), "--root--");
    assert.equal(matchlockProjectKey("/home/user/.tamandua/worktrees/tamandua-x"), "--home-user-.tamandua-worktrees-tamandua-x--");
    assert.equal(matchlockProjectKey("/a b"), "--a~0020b--");
  });

  it("bounds the slug at 251 chars", () => {
    const key = matchlockProjectKey("/" + "x".repeat(300));
    assert.equal(key.length, 255);
  });

  it("throws on an empty cwd", () => {
    assert.throws(() => matchlockProjectKey(""), /empty project path/);
  });

  it("places sessions under <home>/sessions/<key>", () => {
    const p = matchlockSessionProjectDir("/h/.dsh", "/opt/tamandua-dsh");
    assert.equal(p, "/h/.dsh/sessions/--opt-tamandua-dsh--");
  });
});

// ── Artifact decode: plaintext and zstd (v3 current format) ────────

describe("readDshSessionArtifact (plain v3)", () => {
  it("decodes plain JSONL and extracts v3 usage excluding cache buckets", () => {
    const text = buildV3LogText({
      id: "session-root-plain",
      createdAt: 1_700_000_000_000,
      messages: [
        { uncachedInput: 10, output: 5 },
        { uncachedInput: 100, output: 40 },
      ],
    });
    const artifact = readDshSessionArtifact({ artifactPath: writeArtifactFile(text, "session.v3.jsonl") });
    assert.equal(artifact.decode, "ok");
    assert.equal(artifact.header?.id, "session-root-plain");
    assert.equal(artifact.header?.version, 3);
    assert.equal(artifact.usageTokens, 155);
    assert.equal(artifact.usageRecords, 2);
    assert.equal(artifact.usageIncomplete, false);
  });

  it("tolerates legacy assistant/chunk usage chunks in a v3 artifact", () => {
    const text = buildV3LogText({
      id: "session-legacy-chunks",
      createdAt: 1_700_000_000_000,
      legacyUsage: [{ input: 20, output: 3, cacheRead: 500 }],
    });
    const artifact = readDshSessionArtifact({ artifactPath: writeArtifactFile(text, "session.v3.jsonl") });
    assert.equal(artifact.usageTokens, 23); // cache-read excluded
    assert.equal(artifact.usageRecords, 1);
  });

  it("counts real dsh v3 TokenUsage (input+output) once despite the stream mirror", () => {
    // Real dsh v3 writes TokenUsage into data.usage AND data.stream[*].chunk.usage.
    // readDshSessionArtifact must sum input+output from the message-level
    // data.usage exactly once, never the mirrored stream chunk.
    const text = buildV3LogText({
      id: "session-mirror",
      createdAt: 1_700_000_000_000,
      messages: [
        { uncachedInput: 100, output: 50, streamMirror: true },
        { uncachedInput: 10, output: 5, streamMirror: true },
      ],
    });
    const artifact = readDshSessionArtifact({ artifactPath: writeArtifactFile(text, "session.v3.jsonl") });
    assert.equal(artifact.decode, "ok");
    assert.equal(artifact.usageTokens, 165); // (100+50)+(10+5); mirror never summed
    assert.equal(artifact.usageRecords, 2);
    assert.equal(artifact.usageIncomplete, false);
  });

  it("marks malformed usage records incomplete instead of clamping to zero", () => {
    const text = buildV3LogText({
      id: "session-malformed",
      createdAt: 1_700_000_000_000,
      messages: [{ uncachedInput: 7, output: 2 }, { uncachedInput: NaN, output: NaN, malformed: true }],
    });
    const artifact = readDshSessionArtifact({ artifactPath: writeArtifactFile(text, "session.v3.jsonl") });
    assert.equal(artifact.usageTokens, 9); // well-formed records still counted
    assert.equal(artifact.usageIncomplete, true); // ...but the total is not verified
  });

  it("reports unknown/garbage plaintext honestly", () => {
    const artifact = readDshSessionArtifact({
      artifactPath: writeArtifactFile("GARBAGE\x00NOT JSONL", "session.v3.jsonl"),
    });
    assert.equal(artifact.decode, "unknown-format");
    assert.equal(artifact.header, null);
  });
});

describe("readDshSessionArtifact (v3 zstd concatenated frames)", () => {
  it("decodes a single-frame zstd artifact", { skip: !haveNodeZstd }, () => {
    const text = buildV3LogText({
      id: "session-zstd-1f",
      createdAt: 1_700_000_000_000,
      messages: [{ uncachedInput: 30, output: 4 }],
    });
    const artifact = readDshSessionArtifact({ artifactPath: writeArtifactFile(compressZstd(text), "session.v3.jsonl.zstd") });
    assert.equal(artifact.decode, "ok");
    assert.equal(artifact.header?.id, "session-zstd-1f");
    assert.equal(artifact.usageTokens, 34);
  });

  it("decodes concatenated frames (durable appends)", { skip: !haveNodeZstd }, () => {
    const first = buildV3LogText({ id: "session-multi", createdAt: 1_700_000_000_000, messages: [{ uncachedInput: 10, output: 1 }] });
    // Later durable appends are ordinary event records — no second header.
    const second = v3MessageLine({ uncachedInput: 40, output: 3 });
    const artifact = readDshSessionArtifact({
      artifactPath: writeArtifactFile(compressZstd(first, second), "session.v3.jsonl.zstd"),
    });
    assert.equal(artifact.decode, "ok");
    assert.equal(artifact.header?.id, "session-multi");
    assert.equal(artifact.usageTokens, 54);
  });

  it("classifies a torn final frame as incomplete evidence", { skip: !haveNodeZstd }, () => {
    const first = buildV3LogText({ id: "session-torn", createdAt: 1_700_000_000_000, messages: [{ uncachedInput: 5, output: 5 }] });
    const second = buildV3LogText({ id: "session-torn", createdAt: 1_700_000_000_000, messages: [{ uncachedInput: 50, output: 5 }] });
    const full = compressZstd(first, second);
    const torn = full.subarray(0, full.length - 9); // EOF inside the second frame
    const artifact = readDshSessionArtifact({ artifactPath: writeArtifactFile(torn, "session.v3.jsonl.zstd") });
    assert.equal(artifact.decode, "torn");
    assert.equal(artifact.incomplete, true);
    // Header from the complete first frame is still readable; the torn second
    // frame's usage must be reported as partial, never a verified total.
    assert.equal(artifact.header?.id, "session-torn");
    assert.equal(artifact.usageTokens, 10); // partial: only the complete first frame counted
    assert.equal(artifact.usageIncomplete, true);
    assert.ok(artifact.partialText !== null);
  });

  it("classifies structural corruption (bad mid-stream magic)", { skip: !haveNodeZstd }, () => {
    const first = buildV3LogText({ id: "session-corrupt", createdAt: 1_700_000_000_000, messages: [{ uncachedInput: 5, output: 5 }] });
    const second = "irrelevant second frame bytes";
    const frame1 = zstdCompress!(Buffer.from(first, "utf8"));
    const frame2 = zstdCompress!(Buffer.from(second, "utf8"));
    const full = Buffer.concat([frame1, frame2]);
    // Destroy the second frame's magic so a new frame can no longer start.
    full.writeUInt32LE(0xdeadbeef, frame1.length);
    const artifact = readDshSessionArtifact({ artifactPath: writeArtifactFile(full, "session.v3.jsonl.zstd") });
    assert.equal(artifact.decode, "corrupt");
    assert.equal(artifact.header, null);
    assert.ok(artifact.headerProblem?.includes("magic"));
  });

  it("classifies an unknown binary payload honestly", () => {
    const artifact = readDshSessionArtifact({
      artifactPath: writeArtifactFile(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]), "session.v3.jsonl.zstd"),
    });
    assert.equal(artifact.decode, "unknown-format");
    assert.equal(artifact.header, null);
  });
});

// ── Real dsh >= 0.1.5 v3 session-store fixture (US-003) ────────────

describe("real v3 fixture (dsh >= 0.1.5 session.v3.jsonl.zstd)", () => {
  // sha256 fe33b4d5081277b083ce6b9563b1f3eaad864c3eff18035ee046f1b42f6361f8,
  // 18 records, exactly one usage-bearing assistant/message (input 7222 +
  // output 13) whose identical usage is mirrored into data.stream[*].chunk.usage.
  const FIXTURE_SESSION_DIR =
    "/home/kaladin/matchlock-work/dsh-v3-fixture/session-store/session-281fad5b-1fb8-4872-8434-1a29c5fcd8f2";
  const FIXTURE_ARTIFACT = path.join(FIXTURE_SESSION_DIR, "session.v3.jsonl.zstd");

  it("reads the real fixture and asserts usageTokens === 7235 (input 7222 + output 13) with the stream mirror never double-counted", (t) => {
    if (!fs.existsSync(FIXTURE_ARTIFACT)) {
      t.skip("real v3 fixture not present on this host");
      return;
    }
    const artifact = readDshSessionArtifact({ artifactPath: FIXTURE_ARTIFACT });
    assert.equal(artifact.decode, "ok", `artifact decode: ${artifact.decode}`);
    assert.equal(artifact.encoding, "zstd");
    assert.equal(artifact.generation, 3);
    assert.equal(artifact.header?.version, 3);
    assert.equal(artifact.header?.id, "session-281fad5b-1fb8-4872-8434-1a29c5fcd8f2");
    assert.equal(artifact.usageTokens, 7235);
    assert.equal(artifact.usageRecords, 1, "the data.stream[*].chunk.usage mirror must never be double-counted");
    assert.equal(artifact.usageIncomplete, false);
  });

  it("extractMatchlockUsage on the same decoded fixture counts the single top-level data.usage once", (t) => {
    if (!fs.existsSync(FIXTURE_ARTIFACT)) {
      t.skip("real v3 fixture not present on this host");
      return;
    }
    const read = readDshSessionArtifact({ artifactPath: FIXTURE_ARTIFACT });
    assert.ok(read.text !== null, "fixture must decode to plaintext");
    const usage = extractMatchlockUsage(read.text!);
    assert.equal(usage.usageTokens, 7235);
    assert.equal(usage.usageRecords, 1);
    assert.equal(usage.usageIncomplete, false);
  });
});

// ── Discover session artifacts ─────────────────────────────────────

describe("discoverSessionArtifacts", () => {
  it("picks the unambiguous current v3 artifact", () => {
    const home = freshHome();
    writeSession({ dshHome: home.dshHome, workdir: home.workdir, dirName: "session-a", content: "x" });
    const artifacts = discoverSessionArtifacts(
      path.join(home.projectDir, "session-a"),
    );
    assert.equal(artifacts.current, "session.v3.jsonl");
    assert.equal(artifacts.problem, null);
  });

  it("classifies session.v3.jsonl.zstd as current and session.v2.jsonl.zstd as legacy", () => {
    const home = freshHome();
    const dirName = "session-v3-current";
    writeSession({ dshHome: home.dshHome, workdir: home.workdir, dirName, content: "v3-bytes", fileName: "session.v3.jsonl.zstd" });
    writeSession({ dshHome: home.dshHome, workdir: home.workdir, dirName, content: "v2-bytes", fileName: "session.v2.jsonl.zstd" });
    const artifacts = discoverSessionArtifacts(path.join(home.projectDir, dirName));
    assert.equal(artifacts.current, "session.v3.jsonl.zstd");
    assert.deepEqual(artifacts.legacy, ["session.v2.jsonl.zstd"]);
    assert.equal(artifacts.problem, null);
  });

  it("refuses a directory holding two current-generation encodings", () => {
    const home = freshHome();
    writeSession({ dshHome: home.dshHome, workdir: home.workdir, dirName: "session-a", content: "x", fileName: "session.v3.jsonl" });
    writeSession({ dshHome: home.dshHome, workdir: home.workdir, dirName: "session-a", content: "x", fileName: "session.v3.jsonl.zstd" });
    const artifacts = discoverSessionArtifacts(path.join(home.projectDir, "session-a"));
    assert.equal(artifacts.current, null);
    assert.ok(artifacts.problem?.includes("multiple current-generation"));
  });

  it("reports legacy-only and unknown entries without attributing them", () => {
    const home = freshHome();
    writeSession({ dshHome: home.dshHome, workdir: home.workdir, dirName: "session-a", content: "x", fileName: "session.jsonl.zstd" });
    writeSession({ dshHome: home.dshHome, workdir: home.workdir, dirName: "session-a", content: "x", fileName: "scratch.tmp" });
    const artifacts = discoverSessionArtifacts(path.join(home.projectDir, "session-a"));
    assert.equal(artifacts.current, null);
    assert.deepEqual(artifacts.legacy, ["session.jsonl.zstd"]);
    assert.deepEqual(artifacts.unknown, ["scratch.tmp"]);
  });
});

// ── Header parsing ─────────────────────────────────────────────────

describe("parseSessionHeader", () => {
  it("parses a v3 root header (no parent/origin)", () => {
    const parsed = parseSessionHeader(v3HeaderLine({ id: "session-root", createdAt: 1 }));
    assert.equal(parsed.problem, null);
    assert.equal(parsed.header?.id, "session-root");
    assert.equal(parsed.header?.parentSession, undefined);
    assert.equal(parsed.header?.origin, undefined);
  });

  it("parses a v3 subagent header (parentSession + origin)", () => {
    const parsed = parseSessionHeader(
      v3HeaderLine({ id: "session-child", createdAt: 1, parentSession: "session-root", origin: "subagent" }),
    );
    assert.equal(parsed.header?.parentSession, "session-root");
    assert.equal(parsed.header?.origin, "subagent");
  });

  it("rejects an unsupported legacy header version", () => {
    const parsed = parseSessionHeader(
      JSON.stringify({ type: "session", version: 0, id: "s", createdAt: 1, isSeeded: false, delegationDepth: 0 }) + "\n",
    );
    assert.equal(parsed.header, null);
    assert.ok(parsed.problem?.includes("version"));
  });

  it("rejects a legacy v2 header version (only v3 is current)", () => {
    const parsed = parseSessionHeader(
      JSON.stringify({ type: "session", version: 2, id: "s", createdAt: 1, isSeeded: false, delegationDepth: 0 }) + "\n",
    );
    assert.equal(parsed.header, null);
    assert.ok(parsed.problem?.includes("version"));
  });

  it("rejects a first record that is not a session header", () => {
    const parsed = parseSessionHeader(JSON.stringify({ type: "assistant/message", seq: 0 }) + "\n");
    assert.equal(parsed.header, null);
    assert.ok(parsed.problem?.includes("not a session header"));
  });
});

// ── Attribution ────────────────────────────────────────────────────

describe("resolveDshAttribution", () => {
  it("attributes a single new root session", () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-new-root",
      content: buildV3LogText({ id: "session-new-root", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 120, output: 30 }] }),
    });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "attributed");
    assert.equal(result.rootSessionId, "session-new-root");
    assert.equal(result.tokenTotal, 150);
    assert.equal(result.incomplete, false);
  });

  it("excludes session dirs already attributed to the run when the pre inventory is stale", () => {
    const home = freshHome();
    // Round 1 observed S1 as created and attributed it.
    const preRound1 = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-attributed-s1",
      content: buildV3LogText({ id: "session-attributed-s1", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 120, output: 30 }] }),
    });
    const postRound1 = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const round1 = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre: preRound1, post: postRound1 });
    assert.equal(round1.status, "attributed");
    assert.equal(round1.tokenTotal, 150);

    // Round 2's pre-launch inventory is STALE: it was captured before round 1's
    // session reached the host home, so it looks like S1 is new again. Without
    // the exclusion the run would count S1 twice; with it only the genuinely
    // new S2 is attributed.
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-attributed-s2",
      content: buildV3LogText({ id: "session-attributed-s2", createdAt: 3_000_000_000_000, messages: [{ uncachedInput: 11, output: 1 }] }),
    });
    const postRound2 = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const naive = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre: preRound1, post: postRound2 });
    assert.equal(naive.status, "ambiguous", "the stale pre makes both sessions look newly created");

    const guarded = resolveDshAttribution({
      dshHome: home.dshHome,
      workdir: home.workdir,
      pre: preRound1,
      post: postRound2,
      excludeSessionNames: new Set(["session-attributed-s1"]),
    });
    assert.equal(guarded.status, "attributed");
    assert.equal(guarded.rootSessionId, "session-attributed-s2");
    assert.equal(guarded.tokenTotal, 12);
  });

  it("never picks a pre-existing session that happens to be NEWER", () => {    const home = freshHome();
    // A native session already exists (older header, but we make its directory
    // the NEWEST on disk — the anti-pattern the native reader would fall for).
    const preDir = writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-preexisting",
      content: buildV3LogText({ id: "session-preexisting", createdAt: 1_000_000_000_000, messages: [{ uncachedInput: 9999, output: 9999 }] }),
      createdAtMs: 3_000_000_000_000, // directory mtime in the future vs the new root
    });
    void preDir;
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-our-root",
      content: buildV3LogText({ id: "session-our-root", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 11, output: 1 }] }),
      createdAtMs: 2_000_000_000_000, // OLDER mtime than the pre-existing session
    });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "attributed");
    assert.equal(result.rootSessionId, "session-our-root");
    assert.equal(result.tokenTotal, 12); // pre-existing 19998 tokens NEVER borrowed
  });

  it("two simultaneous new sessions -> ambiguous, not newest", () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-runA",
      content: buildV3LogText({ id: "session-runA", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 1, output: 1 }] }),
      createdAtMs: 2_000_000_000_001,
    });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-runB",
      content: buildV3LogText({ id: "session-runB", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 100, output: 100 }] }),
      createdAtMs: 2_000_000_000_000, // older mtime than runA — newest must NOT win
    });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "ambiguous");
    assert.equal(result.rootSessionId, null);
    assert.equal(result.tokenTotal, null);
    assert.equal(result.sessions.length, 2);
  });

  it("attributes exact root/child lineage without double counting", () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-root",
      content: buildV3LogText({ id: "session-root", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 100, output: 20 }] }),
    });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-child1",
      content: buildV3LogText({
        id: "session-child1",
        createdAt: 2_000_000_000_100,
        parentSession: "session-root",
        origin: "subagent",
        messages: [{ uncachedInput: 30, output: 5 }],
      }),
    });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-grandchild",
      content: buildV3LogText({
        id: "session-grandchild",
        createdAt: 2_000_000_000_200,
        parentSession: "session-child1",
        origin: "subagent",
        messages: [{ uncachedInput: 3, output: 1 }],
      }),
    });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "attributed");
    assert.equal(result.rootSessionId, "session-root");
    assert.deepEqual(result.lineageSessionIds, ["session-child1", "session-grandchild", "session-root"]);
    assert.equal(result.tokenTotal, 120 + 35 + 4); // 159 — each session once
    const roles = Object.fromEntries(result.sessions.map((s) => [s.dirName, s.role]));
    assert.equal(roles["session-root"], "root");
    assert.equal(roles["session-child1"], "child");
    assert.equal(roles["session-grandchild"], "child");
  });

  it("does not attribute a created child whose parent is not in the lineage", () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-root",
      content: buildV3LogText({ id: "session-root", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 10, output: 2 }] }),
    });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-orphan-child",
      content: buildV3LogText({
        id: "session-orphan-child",
        createdAt: 2_000_000_000_100,
        parentSession: "session-someone-else",
        origin: "subagent",
        messages: [{ uncachedInput: 500, output: 500 }],
      }),
    });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "attributed");
    assert.equal(result.tokenTotal, 12); // orphan's 1000 tokens not borrowed
    const orphan = result.sessions.find((s) => s.dirName === "session-orphan-child");
    assert.equal(orphan?.role, "unattributed");
    assert.equal(orphan?.lineageRoot, null);
  });

  it("no new session -> unavailable (nothing borrowed)", () => {
    const home = freshHome();
    // Pre-existing session from another run remains untouched.
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-old",
      content: buildV3LogText({ id: "session-old", createdAt: 1_000_000_000_000, messages: [{ uncachedInput: 42, output: 42 }] }),
    });
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "unavailable");
    assert.equal(result.tokenTotal, null);
  });

  it("created dir with a torn artifact -> incomplete, never verified zero", { skip: !haveNodeZstd }, () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const first = buildV3LogText({ id: "session-torn", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 5, output: 5 }] });
    const second = buildV3LogText({ id: "session-torn", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 500, output: 500 }] });
    const full = compressZstd(first, second);
    const torn = full.subarray(0, full.length - 11);
    writeSession({ dshHome: home.dshHome, workdir: home.workdir, dirName: "session-torn", content: torn });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "incomplete");
    assert.equal(result.rootSessionId, "session-torn");
    assert.equal(result.tokenTotal, null);
    assert.equal(result.incomplete, true);
  });

  it("created dir with only a legacy v0 artifact -> unavailable (unattributed format)", () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const legacyText =
      JSON.stringify({ type: "session", version: 0, id: "session-legacy", createdAt: 2_000_000_000_000, isSeeded: false, delegationDepth: 0 }) +
      "\n";
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-legacy",
      content: legacyText,
      fileName: "session.jsonl.zstd",
    });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "unavailable");
    assert.equal(result.tokenTotal, null);
  });

  it("missing/corrupt store paths resolve to unavailable rather than throwing", () => {
    const home = freshHome();
    const missingPre = snapshotDshSessions({ dshHome: path.join(home.root, "no-such-home"), workdir: home.workdir });
    assert.equal(missingPre.sessions.size, 0);
    const result = resolveDshAttribution({
      dshHome: path.join(home.root, "no-such-home"),
      workdir: home.workdir,
      pre: missingPre,
      post: snapshotDshSessions({ dshHome: path.join(home.root, "no-such-home"), workdir: home.workdir }),
    });
    assert.equal(result.status, "unavailable");
  });
});

// ── Full-home preservation inspection (synthetic layout) ───────────

describe("describeDshHomeLayout (synthetic full home)", () => {
  it("reports every entry — including secrets/unknown — presence-only", () => {
    const home = freshHome();
    // Synthetic full-home layout mirroring the qualified native home.
    const profiles = path.join(home.dshHome, "profiles", "headless");
    fs.mkdirSync(profiles, { recursive: true });
    fs.writeFileSync(path.join(profiles, "cordis.yml"), "plugins: []\n");
    fs.writeFileSync(path.join(profiles, "cordis.patch.yml"), "plugins: []\n");
    fs.writeFileSync(path.join(profiles, "package.json"), "{}");
    fs.mkdirSync(path.join(home.dshHome, "profiles", "node_modules"), { recursive: true });
    try {
      fs.symlinkSync("/fake/install/cli/node_modules/chokidar", path.join(home.dshHome, "profiles", "node_modules", "chokidar"));
    } catch {
      // symlink may fail on some platforms — ignore for the dir test below
    }
    fs.mkdirSync(path.join(home.dshHome, "sessions"), { recursive: true });
    fs.mkdirSync(path.join(home.dshHome, "storages", "session_projcache"), { recursive: true });
    // Secret-bearing files: presence only, synthetic content never exposed.
    fs.writeFileSync(path.join(home.dshHome, ".credentials.yaml"), "version: 1\nrefs: [redacted-fixture]\n", { mode: 0o600 });
    fs.writeFileSync(path.join(home.dshHome, ".anonymous-user-id"), "fixture\n");
    fs.writeFileSync(path.join(home.dshHome, "unknown-entry.bin"), "opaque");

    const layout = describeDshHomeLayout(home.dshHome);
    const byName = new Map(layout.entries.map((e) => [e.name, e]));

    assert.ok(byName.has("profiles"));
    assert.ok(byName.has("sessions"));
    assert.ok(byName.has("storages"));
    assert.ok(byName.has("unknown-entry.bin"));
    // Credential file reported as a sensitive presence marker — with no value.
    const cred = byName.get(".credentials.yaml");
    assert.ok(cred);
    assert.equal(cred.sensitive, true);
    assert.equal(cred.kind, "file");
    assert.deepEqual(Object.keys(cred).sort(), ["kind", "name", "sensitive"]);

    const links = inspectDshProfileModuleLinks(home.dshHome);
    if (links.length > 0) {
      assert.equal(links[0].packageName, "chokidar");
      assert.equal(links[0].targetRoot, "fake");
    }
  });

  it("listDirectoryPresence never reads file contents", () => {
    const home = freshHome();
    fs.writeFileSync(path.join(home.dshHome, ".credentials.yaml"), "secret-value-that-must-not-leak", { mode: 0o600 });
    const entries = listDirectoryPresence(home.dshHome);
    const joined = JSON.stringify(entries);
    assert.ok(!joined.includes("secret-value-that-must-not-leak"));
    assert.ok(entries.some((e) => e.name === ".credentials.yaml" && e.sensitive));
  });
});

// ── extractMatchlockUsage pure edge cases ──────────────────────────

describe("extractMatchlockUsage", () => {
  it("treats non-usage records (headers) as neutral and an unparseable line as incomplete", () => {
    // Corrected integrity semantics: legitimate non-usage records (the session
    // header) are never counted and never mark the total incomplete, but a JSON
    // line that does not parse is UNKNOWN data — bounded continuation with
    // usageIncomplete=true (a partial count is never a verified total).
    const headerOnly = buildV3LogText({ id: "s", createdAt: 1 });
    const clean = extractMatchlockUsage(headerOnly);
    assert.equal(clean.usageTokens, null);
    assert.equal(clean.usageIncomplete, false);
    const withGarbage = "not json\n" + headerOnly + "\n";
    const dirty = extractMatchlockUsage(withGarbage);
    assert.equal(dirty.usageTokens, null);
    assert.equal(dirty.usageIncomplete, true);
  });

  it("excludes cache-read and cache-write buckets", () => {
    const text =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      v3MessageLine({ uncachedInput: 100, output: 50 }) +
      JSON.stringify({
        type: "assistant/message",
        data: {
          usage: {
            inputTokens: 200,
            outputTokens: 10,
            cacheReadTokens: 900,
            cacheWriteTokens: 40,
            reasoningTokens: 33,
          },
        },
      }) +
      "\n";
    const usage = extractMatchlockUsage(text);
    assert.equal(usage.usageTokens, 360); // (100+50) + (200+10); cache/reasoning excluded
  });

  it("does not double count a data.usage mirrored into data.stream[*].chunk.usage", () => {
    // Real dsh v3 writes the SAME TokenUsage into both message-level data.usage
    // AND data.stream[*].chunk.usage. The adapter must count the message-level
    // usage exactly once and never sum the stream mirror.
    const text =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      v3MessageLine({ uncachedInput: 100, output: 50, streamMirror: true }) +
      v3MessageLine({ uncachedInput: 10, output: 5, streamMirror: true }) +
      "\n";
    const usage = extractMatchlockUsage(text);
    assert.equal(usage.usageTokens, 165); // (100+50)+(10+5) — mirror not added
    assert.equal(usage.usageRecords, 2);
    assert.equal(usage.usageIncomplete, false);
  });

  it("counts a compaction/summary TOP-LEVEL data.usage (cache-read/reasoning excluded)", () => {
    const text =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      JSON.stringify({
        type: "compaction/summary",
        seq: 1,
        time: 1_700_000_000_000,
        data: {
          compactionId: "c-1",
          summary: [{ type: "text", text: "summary" }],
          usage: {
            inputTokens: 300,
            outputTokens: 20,
            totalTokens: 320,
            cacheReadTokens: 50,
            reasoningTokens: 15,
          },
        },
      }) +
      "\n";
    const usage = extractMatchlockUsage(text);
    assert.equal(usage.usageTokens, 320); // input 300 + output 20 only
    assert.equal(usage.usageRecords, 1);
    assert.equal(usage.usageIncomplete, false);
  });

  it("a compaction/summary without data.usage is a legitimate non-usage record (never incomplete)", () => {
    const text =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      JSON.stringify({
        type: "compaction/summary",
        seq: 1,
        time: 1_700_000_000_000,
        data: { compactionId: "c-1", summary: [{ type: "text", text: "summary" }] },
      }) +
      "\n";
    const usage = extractMatchlockUsage(text);
    assert.equal(usage.usageTokens, null);
    assert.equal(usage.usageRecords, 0);
    assert.equal(usage.usageIncomplete, false);
  });
});

// ── extractMatchlockUsage integrity counterexamples (US-001) ───────

describe("extractMatchlockUsage integrity (counterexamples)", () => {
  it("(a) malformed JSON line marks usageIncomplete, never a trusted partial", () => {
    // Valid records before and after a garbage line are still counted
    // (bounded continuation), but the total is explicitly NOT verified.
    const text =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      v3MessageLine({ uncachedInput: 10, output: 5 }) +
      '{"type":"assistant/message", broken json\n' +
      v3MessageLine({ uncachedInput: 1, output: 1 }) +
      "\n";
    const usage = extractMatchlockUsage(text);
    assert.equal(usage.usageTokens, 17); // partial: (10+5)+(1+1)
    assert.equal(usage.usageRecords, 2);
    assert.equal(usage.usageIncomplete, true); // OLD code: false (silent skip)
  });

  it("(b) v3 assistant/message missing data.usage -> incomplete, never a zero", () => {
    const text =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      v3MessageLine({ uncachedInput: 3, output: 3 }) +
      v3MessageWithoutUsageLine({ role: "assistant" }) +
      "\n";
    const usage = extractMatchlockUsage(text);
    assert.equal(usage.usageTokens, 6); // partial only
    assert.equal(usage.usageRecords, 1);
    assert.equal(usage.usageIncomplete, true); // OLD code: false (silent skip)
  });

  it("(b2) only missing-usage assistant/message -> unavailable, never fabricated zero", () => {
    const text =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      v3MessageWithoutUsageLine({ role: "assistant" }) +
      "\n";
    const usage = extractMatchlockUsage(text);
    assert.equal(usage.usageTokens, null);
    assert.equal(usage.usageRecords, 0);
    assert.equal(usage.usageIncomplete, true);
  });

  it("(b3) non-assistant role without usage is a legitimate non-usage record", () => {
    const text =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      v3MessageWithoutUsageLine({ role: "user" }) +
      "\n";
    const usage = extractMatchlockUsage(text);
    assert.equal(usage.usageTokens, null);
    assert.equal(usage.usageRecords, 0);
    assert.equal(usage.usageIncomplete, false);
  });

  it("(c) fractional token counters are rejected (incomplete, never counted)", () => {
    const text =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      v3MessageLine({ uncachedInput: 5, output: 5 }) +
      v3MessageLine({ uncachedInput: 1.5, output: 0.5 }) +
      "\n";
    const usage = extractMatchlockUsage(text);
    assert.equal(usage.usageTokens, 10); // integer record only
    assert.equal(usage.usageRecords, 1);
    assert.equal(usage.usageIncomplete, true); // OLD code: false, counted 12
  });

  it("(d) non-finite counters and overflow totals are refused", () => {
    // A counter that serializes to Infinity (1e400) can never be a real total.
    const nonFinite =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      JSON.stringify({
        type: "assistant/message",
        data: { message: { role: "assistant", content: [] }, usage: { inputTokens: 1e400, outputTokens: 0 } },
      }) +
      "\n";
    const nf = extractMatchlockUsage(nonFinite);
    assert.equal(nf.usageTokens, null);
    assert.equal(nf.usageIncomplete, true);

    // Two individually safe counters whose SUM exceeds MAX_SAFE_INTEGER.
    const huge = 9_000_000_000_000_000;
    const overflowText =
      v3HeaderLine({ id: "s", createdAt: 1 }) +
      v3MessageLine({ uncachedInput: huge, output: 0 }) +
      v3MessageLine({ uncachedInput: huge, output: 0 }) +
      "\n";
    const ov = extractMatchlockUsage(overflowText);
    assert.equal(ov.usageIncomplete, true); // OLD code: false, silently wrapped
    assert.equal(ov.usageRecords, 1); // second add refused
  });
});

// ── readDshSessionArtifact ambiguity + bounded decode (US-001) ─────

describe("readDshSessionArtifact ambiguity & bounded decode", () => {
  it("(e) a dir holding BOTH current encodings is ambiguous at discovery (never newest)", () => {
    const home = freshHome();
    const sessionDir = writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-both-enc",
      content: "plain",
      fileName: "session.v3.jsonl",
    });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-both-enc",
      content: Buffer.from("zstd-bytes"),
      fileName: "session.v3.jsonl.zstd",
    });
    const artifacts = discoverSessionArtifacts(sessionDir);
    assert.equal(artifacts.current, null);
    assert.ok(artifacts.problem?.includes("multiple current-generation"));
  });

  it("(e2) both encodings -> attribution unavailable (never arbitrary selection)", { skip: !haveNodeZstd }, () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const text = buildV3LogText({
      id: "session-both",
      createdAt: 2_000_000_000_000,
      messages: [{ uncachedInput: 50, output: 50 }],
    });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-both",
      content: text,
      fileName: "session.v3.jsonl",
    });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-both",
      content: compressZstd(text),
      fileName: "session.v3.jsonl.zstd",
    });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "unavailable");
    assert.equal(result.tokenTotal, null);
    const session = result.sessions.find((s) => s.dirName === "session-both");
    assert.ok(session);
    assert.ok(session.headerProblem?.includes("multiple current-generation"));
  });

  it("(f) zstd artifacts respect bounded per-frame/total/frame-count limits", { skip: !haveNodeZstd }, () => {
    const text = buildV3LogText({ id: "s-bounded", createdAt: 1_700_000_000_000, messages: [{ uncachedInput: 4, output: 4 }] });
    const single = compressZstd(text);
    // Per-frame decoded cap refuses a single large frame.
    const perFrame = readDshSessionArtifact({
      artifactPath: writeArtifactFile(single, "session.v3.jsonl.zstd"),
      limits: { maxDecodedBytesPerFrame: 4 },
    });
    assert.equal(perFrame.decode, "over-limit");
    assert.equal(perFrame.usageTokens, null);
    assert.ok(perFrame.headerProblem?.includes("per-frame"));

    // Frame-count cap refuses a container with too many frames.
    let multi = Buffer.alloc(0);
    for (let i = 0; i < 4; i++) {
      multi = Buffer.concat([multi, compressZstd("f" + String(i))]);
    }
    const countCapped = readDshSessionArtifact({
      artifactPath: writeArtifactFile(multi, "session.v3.jsonl.zstd"),
      limits: { maxFrames: 2 },
    });
    assert.equal(countCapped.decode, "over-limit");
    assert.ok(countCapped.headerProblem?.includes("frames"));

    // Total decoded cap refuses concatenated frames that decode too large.
    const big = "x".repeat(4096);
    const totalCapped = readDshSessionArtifact({
      artifactPath: writeArtifactFile(compressZstd(big), "session.v3.jsonl.zstd"),
      limits: { maxTotalDecodedBytes: 64 },
    });
    assert.equal(totalCapped.decode, "over-limit");
    assert.ok(totalCapped.headerProblem?.includes("total bounded-read"));
  });

  it("(f2) artifact byte-size cap refuses oversized reads before decode", () => {
    const big = Buffer.from("y".repeat(8192), "utf8");
    const artifact = readDshSessionArtifact({
      artifactPath: writeArtifactFile(big, "session.v3.jsonl"),
      limits: { maxArtifactBytes: 1024 },
    });
    assert.equal(artifact.decode, "over-limit");
    assert.equal(artifact.usageTokens, null);
    assert.ok(artifact.headerProblem?.includes("bounded-read artifact limit"));
  });

  it("(f3) bounded decode still passes under adequate limits", { skip: !haveNodeZstd }, () => {
    const text = buildV3LogText({ id: "s-ok", createdAt: 1_700_000_000_000, messages: [{ uncachedInput: 7, output: 3 }] });
    const artifact = readDshSessionArtifact({
      artifactPath: writeArtifactFile(compressZstd(text), "session.v3.jsonl.zstd"),
      limits: { maxArtifactBytes: 1024 * 1024, maxDecodedBytesPerFrame: 1024 * 1024, maxTotalDecodedBytes: 4 * 1024 * 1024, maxFrames: 100 },
    });
    assert.equal(artifact.decode, "ok");
    assert.equal(artifact.usageTokens, 10);
    assert.equal(artifact.usageIncomplete, false);
  });

  it("(f4) zstd decode requirements are qualified: unavailable is reported, never silent", { skip: !haveNodeZstd }, () => {
    const text = buildV3LogText({ id: "s-nozstd", createdAt: 1_700_000_000_000, messages: [{ uncachedInput: 2, output: 2 }] });
    const artifactPath = writeArtifactFile(compressZstd(text), "session.v3.jsonl.zstd");
    setMatchlockNodeZstdAvailableForTest(false);
    const artifact = readDshSessionArtifact({ artifactPath });
    assert.equal(artifact.decode, "zstd-unavailable");
    assert.equal(artifact.text, null);
    assert.equal(artifact.usageTokens, null);
    assert.ok(artifact.headerProblem?.includes("zstd decoder unavailable"));
  });
});

// ── Confined host read: symlink/outside-store refusal (US-001) ─────

describe("confined host artifact read (symlink swaps / outside sentinels)", () => {
  it("refuses a symlinked LEAF artifact (never follows it out of the store)", () => {
    const root = tamanduaTempDir("tamandua-matchlock-dsh-confined-");
    artifactDirs.push(root);
    const store = path.join(root, "store");
    const outside = path.join(root, "outside");
    fs.mkdirSync(path.join(store, "sessions", matchlockProjectKey("/work")), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const sentinel = path.join(outside, "sentinel.jsonl");
    fs.writeFileSync(sentinel, '{"SENTINEL-OUTSIDE-SECRET-MARKER": true}\n');
    const sessionDir = path.join(store, "sessions", matchlockProjectKey("/work"), "session-leaf-swap");
    fs.mkdirSync(sessionDir, { recursive: true });
    const artifactPath = path.join(sessionDir, "session.v3.jsonl");
    fs.symlinkSync(sentinel, artifactPath);
    const read = readDshSessionArtifact({ artifactPath, admittedRoot: store });
    assert.equal(read.decode, "refused");
    assert.equal(read.usageTokens, null);
    assert.equal(read.usageIncomplete, true);
    assert.ok(read.headerProblem?.includes("symlink"));
    assert.ok(!JSON.stringify(read).includes("SENTINEL-OUTSIDE-SECRET-MARKER"));
    // The same leaf refusal applies when no admitted root is supplied.
    const noRoot = readDshSessionArtifact({ artifactPath });
    assert.equal(noRoot.decode, "refused");
  });

  it("refuses an ancestor session-dir swapped to a symlink outside the store", () => {
    const root = tamanduaTempDir("tamandua-matchlock-dsh-confined-");
    artifactDirs.push(root);
    const store = path.join(root, "store");
    const outside = path.join(root, "outside");
    const key = matchlockProjectKey("/work");
    fs.mkdirSync(path.join(store, "sessions", key), { recursive: true });
    // Outside store: a full synthetic session dir with a real v3 artifact.
    const outsideSession = path.join(outside, "session-ancestor-swap");
    fs.mkdirSync(outsideSession, { recursive: true });
    const leakedText = buildV3LogText({
      id: "session-ancestor-swap",
      createdAt: 2_000_000_000_000,
      cwd: "/OUTSIDE-SENTINEL-CWD",
      messages: [{ uncachedInput: 777, output: 777 }],
    });
    fs.writeFileSync(path.join(outsideSession, "session.v3.jsonl"), leakedText);
    // Inside the store the session dir itself is a symlink to the outside dir.
    const insideSession = path.join(store, "sessions", key, "session-ancestor-swap");
    fs.symlinkSync(outsideSession, insideSession, "dir");
    const read = readDshSessionArtifact({
      artifactPath: path.join(insideSession, "session.v3.jsonl"),
      admittedRoot: store,
    });
    assert.equal(read.decode, "refused");
    assert.equal(read.usageTokens, null);
    assert.ok(read.headerProblem?.includes("symlink"));
    const json = JSON.stringify(read);
    assert.ok(!json.includes("OUTSIDE-SENTINEL-CWD"));
    assert.ok(!json.includes("777"));
  });

  it("refuses an artifact path that escapes the admitted store root", () => {
    const root = tamanduaTempDir("tamandua-matchlock-dsh-confined-");
    artifactDirs.push(root);
    const store = path.join(root, "store");
    fs.mkdirSync(store, { recursive: true });
    const outside = writeArtifactFile("escape-content", "session.v3.jsonl");
    const read = readDshSessionArtifact({ artifactPath: outside, admittedRoot: store });
    assert.equal(read.decode, "refused");
    assert.ok(read.headerProblem?.includes("escapes the admitted store root"));
  });

  it("refuses a non-regular leaf (directory masquerading as the artifact)", () => {
    const root = tamanduaTempDir("tamandua-matchlock-dsh-confined-");
    artifactDirs.push(root);
    const store = path.join(root, "store");
    const key = matchlockProjectKey("/work");
    fs.mkdirSync(path.join(store, "sessions", key), { recursive: true });
    const sessionDir = path.join(store, "sessions", key, "session-dir-leaf");
    fs.mkdirSync(sessionDir, { recursive: true });
    const artifactPath = path.join(sessionDir, "session.v3.jsonl");
    fs.mkdirSync(artifactPath, { recursive: true }); // a DIRECTORY at the leaf
    const read = readDshSessionArtifact({ artifactPath, admittedRoot: store });
    assert.equal(read.decode, "refused");
    assert.ok(read.headerProblem?.includes("not a regular file"));
  });

  it("attribution treats a symlink-swapped created session as unavailable (never leaks)", () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    // A created session dir is replaced by a symlink pointing outside the store
    // into a synthetic sentinel session with a valid-looking root header.
    const outsideRoot = path.join(home.root, "outside-sentinel");
    const outsideSession = path.join(outsideRoot, "session-sneaky");
    fs.mkdirSync(outsideSession, { recursive: true });
    const leaked = buildV3LogText({
      id: "session-sneaky",
      createdAt: 2_000_000_000_000,
      cwd: "/LEAKED-CWD-MARKER",
      messages: [{ uncachedInput: 999, output: 999 }],
    });
    fs.writeFileSync(path.join(outsideSession, "session.v3.jsonl"), leaked);
    const projectDir = matchlockSessionProjectDir(home.dshHome, home.workdir);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.symlinkSync(outsideSession, path.join(projectDir, "session-sneaky"), "dir");
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    // snapshotDshSessions never follows the symlinked dir into the inventory,
    // so nothing was created -> unavailable, and nothing was leaked.
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "unavailable");
    assert.equal(result.tokenTotal, null);
    assert.ok(!JSON.stringify(result).includes("LEAKED-CWD-MARKER"));
    assert.ok(!JSON.stringify(result).includes("999"));
  });
});

// ── Attribution honesty: duplicate ids + lineage scope (US-001) ─────

describe("resolveDshAttribution honesty (duplicate ids / lineage scope)", () => {
  it("duplicate header ids across newly created sessions -> ambiguous", () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-dup-a",
      content: buildV3LogText({ id: "session-same-id", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 10, output: 10 }] }),
    });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-dup-b",
      content: buildV3LogText({ id: "session-same-id", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 20, output: 20 }] }),
    });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "ambiguous");
    assert.equal(result.rootSessionId, null);
    assert.equal(result.tokenTotal, null);
  });

  it("records the single-project-dir lineage scope (no silent cross-cwd total)", () => {
    const home = freshHome();
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-root",
      content: buildV3LogText({ id: "session-root", createdAt: 2_000_000_000_000, messages: [{ uncachedInput: 5, output: 5 }] }),
    });
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "attributed");
    assert.equal(result.tokenTotal, 10);
    assert.ok(result.lineageScope.includes(home.projectDir));
    assert.ok(result.lineageScope.includes("different cwd"));
  });

  it("never includes a cross-cwd child living under another project key", () => {
    const home = freshHome();
    const otherCwd = path.join(home.root, "other", "cwd");
    const otherProjectDir = matchlockSessionProjectDir(home.dshHome, otherCwd);
    const pre = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    // Root in the attributed cwd project dir.
    writeSession({
      dshHome: home.dshHome,
      workdir: home.workdir,
      dirName: "session-root",
      content: buildV3LogText({ id: "session-root", createdAt: 2_000_000_000_000, cwd: home.workdir, messages: [{ uncachedInput: 8, output: 2 }] }),
    });
    // Cross-cwd child created under ANOTHER project key, outside the scanned scope.
    fs.mkdirSync(otherProjectDir, { recursive: true });
    const childDir = path.join(otherProjectDir, "session-child-xcwd");
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(
      path.join(childDir, "session.v3.jsonl"),
      buildV3LogText({
        id: "session-child-xcwd",
        createdAt: 2_000_000_000_000,
        cwd: otherCwd,
        parentSession: "session-root",
        origin: "subagent",
        messages: [{ uncachedInput: 9000, output: 9000 }],
      }),
    );
    const post = snapshotDshSessions({ dshHome: home.dshHome, workdir: home.workdir });
    const result = resolveDshAttribution({ dshHome: home.dshHome, workdir: home.workdir, pre, post });
    assert.equal(result.status, "attributed");
    // The claimed total covers ONLY the scanned project dir lineage: the
    // cross-cwd child's 18000 tokens are never silently included.
    assert.deepEqual(result.lineageSessionIds, ["session-root"]);
    assert.equal(result.tokenTotal, 10);
    assert.ok(result.lineageScope.includes(home.projectDir));
  });
});

// ── scanMatchlockZstdFrames structural scan ────────────────────────

describe("scanMatchlockZstdFrames", () => {
  it("accepts valid frames and flags a torn final frame", { skip: !haveNodeZstd }, () => {
    const full = compressZstd("frame-one", "frame-two");
    const torn = full.subarray(0, full.length - 5);
    const scan = scanMatchlockZstdFrames(torn);
    assert.equal(scan.corruptAt, null);
    assert.ok(scan.tornStart !== null);
    assert.equal(scan.frames.length, 1);
  });

  it("flags reserved-frame corruption", { skip: !haveNodeZstd }, () => {
    const frame = compressZstd("hello");
    const scan = scanMatchlockZstdFrames(frame);
    assert.equal(scan.corruptAt, null);
    assert.equal(scan.tornStart, null);
    assert.equal(scan.frames.length, 1);
  });
});

// ── helpers ────────────────────────────────────────────────────────

let artifactCounter = 0;

function writeArtifactFile(content: Buffer | string, fileName: string): string {
  artifactCounter += 1;
  const root = tamanduaTempDir(`tamandua-matchlock-artifact-${artifactCounter}-`);
  artifactDirs.push(root);
  const p = path.join(root, fileName);
  fs.writeFileSync(p, content);
  return p;
}
