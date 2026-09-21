/**
 * MTLK guest suite component gate (ONE focused test gate, multiple describe
 * blocks). Covers the portable guest test-shim engine + typed suite-transport
 * contract with:
 *
 *   - isolated temp Git fixtures (synthetic identity/config/environment)
 *   - a fake typed transport with recorded calls — NO host admin/DB/service
 *   - real small guest-local /bin/sh + git subprocess fixtures executed as
 *     component tests on vaivm (NOT actualVM)
 *
 * Behaviors exercised: raw output/exit/shell semantics, tracked-dirty /
 * drift / refusal, no-exec cache controls, --force/bypass, malformed and
 * wrong-namespace responses, outage and record failure, exact-token release,
 * single-flight wait + promotion + re-key, bounded tail / stream
 * backpressure, duration-history and suite-event routing, plus contract and
 * git-helper unit checks.
 *
 * Serial lane (spawns git + /bin/sh through the engine and entry); no live
 * daemon, no models, no real VMs.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createTempHome, cleanChildEnv } from "../../../tests/helpers/test-env.ts";
import {
  GUEST_SUITE_TRANSPORT_VERSION,
  SUITE_PERMITTED_EVENTS,
  guestSuiteNamespaceId,
  normalizeGuestSuiteNamespace,
  type GuestSuiteNamespace,
  type GuestSuiteTransport,
} from "../../../dist/installer/matchlock/guest-suite-contract.js";
import {
  runGuestSuiteShim,
  parseGuestSuiteArgs,
  wantsGuestSuiteHelp,
  clampDisplayBytes,
  TREE_DRIFT_EXIT_CODE,
  INTERRUPTED_EXIT_CODE,
  TREE_DIRTY_EXIT_CODE,
  type GuestSuiteShimIo,
} from "../../../dist/installer/matchlock/guest-suite-shim.js";
import {
  committedTreeHash,
  computeCmdHash,
  trackedTreeHash,
  getTrackedDirtyPaths,
} from "../../../dist/installer/matchlock/guest-suite-git.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_ENTRY = join(HERE, "..", "..", "..", "dist", "installer", "matchlock", "guest-suite-cli-entry.js");
const DIST_SHIM = join(HERE, "..", "..", "..", "dist", "installer", "matchlock", "guest-suite-shim.js");
const DIST_CONTRACT = join(HERE, "..", "..", "..", "dist", "installer", "matchlock", "guest-suite-contract.js");

// ── Namespaces (host-attested inputs; NOT actualVM) ───────────────────

const NS_A: GuestSuiteNamespace = {
  imageContentId: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  guestPlatform: "linux/amd64",
  helperContract: "guest-helper-5ffe49f+suite-v1",
  compatibilityFingerprint: "envfp-aaa111",
};
const NS_B: GuestSuiteNamespace = {
  imageContentId: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  guestPlatform: "linux/arm64", // different platform ⇒ different namespace
  helperContract: "guest-helper-5ffe49f+suite-v1",
  compatibilityFingerprint: "envfp-bbb222",
};
const NS_A_ID = guestSuiteNamespaceId(NS_A);
const NS_B_ID = guestSuiteNamespaceId(NS_B);

// ── Fake typed transport (recorded calls; native-like semantics) ──────

interface FakeRow {
  namespaceId: string;
  id: number;
  origin_repo: string;
  tree_hash: string;
  cmd_hash: string;
  cmd_display: string;
  exit_code: number;
  duration_ms: number;
  log_tail: string | null;
  run_id: string | null;
  step_id: string | null;
  created_at: string;
}

interface ClaimRec {
  key: string;
  ownerToken: string;
  runId?: string;
  stepId?: string;
  namespaceId: string;
}

function keyOf(originRepo: string, treeHash: string, cmdHash: string, nsId: string): string {
  return `${nsId}\u0000${originRepo}\u0000${treeHash}\u0000${cmdHash}`;
}

/**
 * In-memory suite ledger mirroring the NATIVE suite service semantics:
 * lookup returns the newest row + flaky counts; claim is single-flight per
 * key (existing claim → wait, else grant); record inserts a row AND clears
 * any claim; release is exact-token (mismatch → refused DENIED). Every op
 * echoes the namespace it served from so the engine can reject
 * wrong-namespace answers.
 */
class FakeSuiteTransport implements GuestSuiteTransport {
  contractVersion = GUEST_SUITE_TRANSPORT_VERSION;
  namespace: GuestSuiteNamespace;
  calls: Array<{ op: string; req: Record<string, unknown> }> = [];
  rows: FakeRow[] = [];
  claims = new Map<string, ClaimRec>();
  events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  private seq = 0;

  // Failure-injection knobs.
  outage = false;
  lookupRefuse: { code: string; message: string } | null = null;
  lookupWrongNs = false;
  claimWrongNs = false;
  recordFailure: "unavailable" | "refused" | null = null;
  recordWrongNs = false;
  noDuration = false;

  /**
   * Overridable op implementations for scripted sequences. Each receives the
   * typed request plus the NATIVE default implementation, so a scripted
   * override can fall back to the ledger semantics without recursion.
   */
  claimOpImpl:
    | ((req: Parameters<GuestSuiteTransport["claim"]>[0], native: (r: Parameters<GuestSuiteTransport["claim"]>[0]) => Promise<ReturnType<GuestSuiteTransport["claim"]>>) => ReturnType<GuestSuiteTransport["claim"]>)
    | null = null;
  lookupOpImpl:
    | ((req: Parameters<GuestSuiteTransport["lookup"]>[0], native: (r: Parameters<GuestSuiteTransport["lookup"]>[0]) => Promise<ReturnType<GuestSuiteTransport["lookup"]>>) => ReturnType<GuestSuiteTransport["lookup"]>)
    | null = null;

  constructor(namespace: GuestSuiteNamespace) {
    this.namespace = namespace;
  }

  private nsId(): string {
    return guestSuiteNamespaceId(this.namespace);
  }

  opCalls(op: string): Array<{ op: string; req: Record<string, unknown> }> {
    return this.calls.filter((c) => c.op === op);
  }

  seedRow(partial: {
    originRepo: string;
    treeHash: string;
    cmdHash: string;
    exitCode: number;
    created_at?: string;
    duration_ms?: number;
    log_tail?: string | null;
    run_id?: string | null;
    step_id?: string | null;
    cmd_display?: string;
  }): void {
    this.rows.push({
      id: ++this.seq,
      namespaceId: this.nsId(),
      origin_repo: partial.originRepo,
      tree_hash: partial.treeHash,
      cmd_hash: partial.cmdHash,
      cmd_display: partial.cmd_display ?? "",
      exit_code: partial.exitCode,
      duration_ms: partial.duration_ms ?? 5000,
      log_tail: partial.log_tail ?? null,
      run_id: partial.run_id ?? null,
      step_id: partial.step_id ?? null,
      created_at: partial.created_at ?? new Date().toISOString(),
    });
  }

  // ── GuestSuiteTransport interface ────────────────────────────────────

  async lookupNative(req: Parameters<GuestSuiteTransport["lookup"]>[0]): Promise<ReturnType<GuestSuiteTransport["lookup"]>> {
    if (this.outage) return { ok: false, reason: "unavailable", message: "transport outage" };
    if (this.lookupRefuse) {
      return { ok: false, reason: "refused", code: this.lookupRefuse.code as never, message: this.lookupRefuse.message };
    }
    if (this.lookupWrongNs) {
      return { ok: true, value: { namespaceId: NS_B_ID, latest: null, passCount: 0, failCount: 0, flaky: false } };
    }
    const matched = this.rows
      .filter(
        (r) =>
          r.namespaceId === this.nsId()
          && r.origin_repo === req.originRepo
          && r.tree_hash === req.treeHash
          && r.cmd_hash === req.cmdHash,
      )
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const now = Date.now();
    const windowMs = 24 * 60 * 60 * 1000;
    let passCount = 0;
    let failCount = 0;
    for (const row of matched) {
      const t = new Date(String(row.created_at)).getTime();
      if (Number.isNaN(t) || now - t > windowMs) continue;
      if (row.exit_code === 87) continue;
      if (row.exit_code === 0) passCount += 1;
      else failCount += 1;
    }
    const latest = matched[0] ? { ...matched[0] } : null;
    return {
      ok: true,
      value: { namespaceId: this.nsId(), latest, passCount, failCount, flaky: passCount > 0 && failCount > 0 },
    };
  }

  async lookup(req: Parameters<GuestSuiteTransport["lookup"]>[0]): Promise<ReturnType<GuestSuiteTransport["lookup"]>> {
    this.calls.push({ op: "suite.lookup", req: { ...req } });
    if (this.lookupOpImpl) {
      return this.lookupOpImpl(req, (r) => this.lookupNative(r));
    }
    return this.lookupNative(req);
  }

  async claimNative(req: Parameters<GuestSuiteTransport["claim"]>[0]): Promise<ReturnType<GuestSuiteTransport["claim"]>> {
    if (this.outage) return { ok: false, reason: "unavailable", message: "transport outage" };
    if (this.claimWrongNs) {
      return { ok: true, value: { namespaceId: NS_B_ID, action: "run" as const } };
    }
    const key = keyOf(req.originRepo, req.treeHash, req.cmdHash, this.nsId());
    const existing = this.claims.get(key);
    if (existing) return { ok: true, value: { namespaceId: this.nsId(), action: "wait" as const } };
    this.claims.set(key, {
      key,
      ownerToken: req.ownerToken,
      runId: req.runId,
      stepId: req.stepId,
      namespaceId: this.nsId(),
    });
    return { ok: true, value: { namespaceId: this.nsId(), action: "run" as const } };
  }

  async claim(req: Parameters<GuestSuiteTransport["claim"]>[0]): Promise<ReturnType<GuestSuiteTransport["claim"]>> {
    this.calls.push({
      op: "suite.claim",
      req: {
        originRepo: req.originRepo,
        treeHash: req.treeHash,
        cmdHash: req.cmdHash,
        ownerToken: req.ownerToken,
        runId: req.runId,
        stepId: req.stepId,
        invocationId: req.invocationId,
      },
    });
    if (this.claimOpImpl) {
      return this.claimOpImpl(req, (r) => this.claimNative(r));
    }
    return this.claimNative(req);
  }

  async record(req: Parameters<GuestSuiteTransport["record"]>[0]): Promise<ReturnType<GuestSuiteTransport["record"]>> {
    this.calls.push({ op: "suite.record", req: { ...req } });
    if (this.recordFailure === "unavailable") {
      return { ok: false, reason: "unavailable", message: "record transport outage" };
    }
    if (this.recordFailure === "refused") {
      return { ok: false, reason: "refused", code: "WRONG_NAMESPACE", message: "record refused" };
    }
    if (this.recordWrongNs) {
      return {
        ok: true,
        value: { namespaceId: NS_B_ID, id: ++this.seq, created_at: new Date().toISOString() },
      };
    }
    const row: FakeRow = {
      id: ++this.seq,
      namespaceId: this.nsId(),
      origin_repo: req.originRepo,
      tree_hash: req.treeHash,
      cmd_hash: req.cmdHash,
      cmd_display: req.cmdDisplay,
      exit_code: req.exitCode,
      duration_ms: req.durationMs,
      log_tail: req.logTail,
      run_id: req.runId,
      step_id: req.stepId,
      created_at: new Date().toISOString(),
    };
    this.rows.push(row);
    // Native server: a record clears any pending claim so waiters can proceed.
    const key = keyOf(req.originRepo, req.treeHash, req.cmdHash, this.nsId());
    this.claims.delete(key);
    return { ok: true, value: { namespaceId: this.nsId(), id: row.id, created_at: row.created_at } };
  }

  async release(req: Parameters<GuestSuiteTransport["release"]>[0]): Promise<ReturnType<GuestSuiteTransport["release"]>> {
    this.calls.push({ op: "suite.release", req: { ...req } });
    if (this.outage) return { ok: false, reason: "unavailable", message: "transport outage" };
    const key = keyOf(req.originRepo, req.treeHash, req.cmdHash, this.nsId());
    const existing = this.claims.get(key);
    if (!existing) return { ok: true, value: { namespaceId: this.nsId(), released: false } };
    if (existing.ownerToken !== req.ownerToken) {
      return { ok: false, reason: "refused", code: "DENIED", message: "suite claim is owned by another caller" };
    }
    this.claims.delete(key);
    return { ok: true, value: { namespaceId: this.nsId(), released: true } };
  }

  async durationHistory(
    req: Parameters<GuestSuiteTransport["durationHistory"]>[0],
  ): Promise<ReturnType<GuestSuiteTransport["durationHistory"]>> {
    this.calls.push({ op: "suite.duration-history", req: { originRepo: req.originRepo, cmdHash: req.cmdHash } });
    if (this.outage || this.noDuration) {
      return { ok: false, reason: "unavailable", message: "duration history unavailable" };
    }
    const durations = this.rows
      .filter(
        (r) =>
          r.namespaceId === this.nsId()
          && r.origin_repo === req.originRepo
          && r.cmd_hash === req.cmdHash
          && r.exit_code !== 87,
      )
      .map((r) => r.duration_ms)
      .filter((n) => Number.isFinite(n));
    return { ok: true, value: { namespaceId: this.nsId(), durations } };
  }

  async emitEvent(req: Parameters<GuestSuiteTransport["emitEvent"]>[0]): Promise<ReturnType<GuestSuiteTransport["emitEvent"]>> {
    this.calls.push({ op: "suite.event", req: { event: req.event, runId: req.runId, ...(req.fields ?? {}) } });
    if (!(SUITE_PERMITTED_EVENTS as readonly string[]).includes(req.event)) {
      return { ok: false, reason: "refused", code: "UNSUPPORTED", message: `${req.event} is not a permitted suite event` };
    }
    this.events.push({ event: req.event, fields: req.fields ?? {} });
    return { ok: true, value: { namespaceId: this.nsId(), emitted: true } };
  }
}

// ── Fixture + io helpers ──────────────────────────────────────────────

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    env: cleanChildEnv({
      HOME: process.env.HOME,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    }),
    stdio: "pipe",
  });
}

/** Initialize a git fixture repo with synthetic identity and a tracked file. */
function initRepo(base: string, name: string): string {
  const repoDir = join(base, name);
  mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-q"]);
  git(repoDir, ["config", "user.email", "guest-suite@test.invalid"]);
  git(repoDir, ["config", "user.name", "Guest Suite Test"]);
  writeFileSync(join(repoDir, "README.md"), "# Guest fixture\n");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-q", "-m", "init"]);
  writeFileSync(join(repoDir, ".gitignore"), "*.log\nignored-dir/\n");
  git(repoDir, ["add", ".gitignore"]);
  git(repoDir, ["commit", "-q", "-m", "gitignore"]);
  return repoDir;
}

function shQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

interface IoCapture {
  io: GuestSuiteShimIo;
  outText: () => string;
  errText: () => string;
  outRaw: () => Buffer;
  errRaw: () => Buffer;
}

function makeIo(
  extraEnv: Record<string, string | undefined> = {},
  cwd: string = process.cwd(),
): IoCapture {
  let outText = "";
  let errText = "";
  const outRawChunks: Buffer[] = [];
  const errRawChunks: Buffer[] = [];
  const io: GuestSuiteShimIo = {
    cwd,
    envGet: (name) => {
      if (name in extraEnv) return extraEnv[name];
      return process.env[name];
    },
    writeOut: (t) => {
      outText += t;
    },
    writeErr: (t) => {
      errText += t;
    },
    writeOutRaw: (b) => {
      outRawChunks.push(b);
      outText += b.toString("utf-8");
    },
    writeErrRaw: (b) => {
      errRawChunks.push(b);
      errText += b.toString("utf-8");
    },
  };
  return {
    io,
    outText: () => outText,
    errText: () => errText,
    outRaw: () => Buffer.concat(outRawChunks),
    errRaw: () => Buffer.concat(errRawChunks),
  };
}

interface ShimRun {
  exitCode: number;
  out: string;
  err: string;
  outRaw: Buffer;
  errRaw: Buffer;
}

async function runShim(
  argv: string[],
  fake: FakeSuiteTransport,
  opts: {
    namespace?: GuestSuiteNamespace | null;
    options?: Record<string, unknown>;
    env?: Record<string, string | undefined>;
    /** Injectable io.cwd for the spawned /bin/sh -c children. */
    ioCwd?: string;
  } = {},
): Promise<ShimRun> {
  const cap = makeIo(opts.env ?? {}, opts.ioCwd);
  const result = await runGuestSuiteShim(argv, cap.io, {
    transport: fake,
    namespace: opts.namespace === undefined ? NS_A : opts.namespace,
    options: {
      requestTimeoutMs: 3000,
      singleflightPollIntervalMs: 15,
      claimTimeoutMs: 1500,
      ttlGreenMs: 60_000,
      redContextWindowMs: 15 * 60 * 1000,
      ...(opts.options ?? {}),
    },
  });
  return { exitCode: result.exitCode, out: cap.outText(), err: cap.errText(), outRaw: cap.outRaw(), errRaw: cap.errRaw() };
}

const ROOT = createTempHome("tamandua-guest-suite-");
const FIXTURE_BASE = join(ROOT.root, "fixtures");

before(() => {
  mkdirSync(FIXTURE_BASE, { recursive: true });
});

// ───────────────────────────────────────────────────────────────────────
// describe 1: argument parsing / help shape
// ───────────────────────────────────────────────────────────────────────
describe("guest-suite arg parsing and help (native exact shape)", () => {
  it("parses --repo/--run/--step/--force and the exact command after --", () => {
    const parsed = parseGuestSuiteArgs([
      "--repo", "/r", "--run", "run-1", "--step", "step-2", "--force",
      "--", "FOO=1", "sh", "-c", "echo hi && true", "|", "cat",
    ]);
    assert.equal(parsed.repo, "/r");
    assert.equal(parsed.runId, "run-1");
    assert.equal(parsed.stepId, "step-2");
    assert.equal(parsed.force, true);
    assert.deepEqual(parsed.cmdArgs, ["FOO=1", "sh", "-c", "echo hi && true", "|", "cat"]);
    assert.equal(parsed.cmdString, 'FOO=1 sh -c echo hi && true | cat');
  });

  it("accepts short -r/-R/-s/-f forms", () => {
    const parsed = parseGuestSuiteArgs(["-r", "/r", "-R", "run-9", "-s", "step-9", "-f", "--", "true"]);
    assert.equal(parsed.repo, "/r");
    assert.equal(parsed.runId, "run-9");
    assert.equal(parsed.stepId, "step-9");
    assert.equal(parsed.force, true);
    assert.equal(parsed.cmdString, "true");
  });

  it("help is detected only before the -- separator", () => {
    assert.equal(wantsGuestSuiteHelp(["--help"]), true);
    assert.equal(wantsGuestSuiteHelp(["-h"]), true);
    assert.equal(wantsGuestSuiteHelp(["--repo", "/r", "--help"]), true);
    assert.equal(wantsGuestSuiteHelp(["--repo", "/r", "--", "echo", "--help"]), false);
    assert.equal(wantsGuestSuiteHelp(["--repo", "/r", "--"]), false);
  });

  it("a token consumed as a flag VALUE is never treated as help (native parseArgs parity)", () => {
    // Native parseArgs consumes the next token as the value of
    // --repo/-r/--run/-R/--step/-s, so `--repo -h` means repo value "-h"
    // (→ "--repo path not found: -h"), NOT help + exit 0.
    assert.equal(wantsGuestSuiteHelp(["--repo", "-h", "--", "echo"]), false);
    assert.equal(wantsGuestSuiteHelp(["-r", "-h", "--", "true"]), false);
    assert.equal(wantsGuestSuiteHelp(["--run", "-h", "--", "true"]), false);
    assert.equal(wantsGuestSuiteHelp(["--step", "-h", "--", "true"]), false);
    assert.equal(wantsGuestSuiteHelp(["--run", "--step", "-s", "-h", "--", "true"]), false);
    assert.equal(wantsGuestSuiteHelp(["--repo", "--help", "--", "true"]), false);
    // A help flag OUTSIDE any value position is still detected before `--`.
    assert.equal(wantsGuestSuiteHelp(["--repo", "/r", "--help", "--", "echo"]), true);
    assert.equal(wantsGuestSuiteHelp(["--repo", "/r", "-h", "--", "echo"]), true);
    assert.equal(wantsGuestSuiteHelp(["--force", "-h", "--", "true"]), true);
    assert.equal(wantsGuestSuiteHelp(["-r", "/r", "-R", "/run", "-s", "/s", "-h", "--", "true"]), true);
  });

  it("engine --help prints help to stderr and exits 0 without any transport work", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(["--help"], fake);
    assert.equal(r.exitCode, 0);
    assert.match(r.err, /Usage: tamandua-test --repo <path> --run <id> --step <id> \[--force\] -- <command\.\.\.>/);
    assert.equal(fake.calls.length, 0);
  });

  it("a help-looking token consumed as the --repo VALUE is not help: passthrough notice + real run", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(
      ["--repo", "-h", "--run", "run-1", "--step", "step-1", "--", "echo help-is-a-value"],
      fake,
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.out, /help-is-a-value/);
    assert.match(r.err, /passthrough mode — --repo path not found: -h/);
    assert.doesNotMatch(r.err, /Usage: tamandua-test/);
    assert.equal(fake.calls.length, 0, "a passthrough must never touch the ledger");
  });

  it("no command is an honest error (exit 1) and nothing executes", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(["--repo", "/nonexistent", "--run", "run-1", "--step", "step-1"], fake);
    assert.equal(r.exitCode, 1);
    assert.match(r.err, /error: no test command provided/);
    assert.equal(fake.calls.length, 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// describe 2: real guest-local shell semantics (NOT actualVM)
// ───────────────────────────────────────────────────────────────────────
describe("guest-local /bin/sh -c execution semantics (NOT actualVM)", () => {
  it("TAMANDUA_TSTX=0 is full guest-local passthrough with a single stderr notice", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-tstx");
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--",
        "printf 'OUT-LINE\\n'", ";", "printf 'ERR-LINE\\n'", ">&2"],
      fake,
      { env: { TAMANDUA_TSTX: "0" } },
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.out, "OUT-LINE\n");
    assert.match(r.err, /tamandua-test: passthrough mode — TAMANDUA_TSTX=0 kill switch active/);
    assert.match(r.err, /ERR-LINE/);
    assert.equal(fake.calls.length, 0); // kill switch never touches the ledger
  });

  it("preserves stdout/stderr separation, raw bytes and exit status on the recording path", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-sep");
    const fake = new FakeSuiteTransport(NS_A);
    const cmd = "printf 'to-out\\n'; printf 'to-err\\n' >&2; printf '\\303\\251\\n'; printf 'err2' >&2; exit 7";
    const r = await runShim(["--repo", repo, "--run", "run-1", "--step", "step-1", "--", cmd], fake);
    assert.equal(r.exitCode, 7);
    // Raw byte fidelity: multi-byte UTF-8 (é = C3 A9) passes through untouched.
    assert.deepEqual(r.outRaw, Buffer.from("to-out\né\n", "utf-8"));
    assert.equal(r.out, "to-out\né\n");
    assert.equal(r.errRaw.toString("utf-8"), "to-err\nerr2");
    const recs = fake.opCalls("suite.record");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].req.exitCode, 7);
  });

  it("preserves shell prefixes, quotes and pipes (exact command string semantics)", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-shell");
    const fake = new FakeSuiteTransport(NS_A);
    const cmd = "X=abc; echo \"$X hi\" | tr ' ' '_'; printf '%s\\n' \"it's fine\"";
    const r = await runShim(["--repo", repo, "--run", "run-1", "--step", "step-1", "--", cmd], fake);
    assert.equal(r.exitCode, 0);
    assert.equal(r.out, "abc_hi\nit's fine\n");
  });

  it("command runs with the shim cwd preserved and can cd into the repo", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-cwd");
    const fake = new FakeSuiteTransport(NS_A);
    const cmd = `cd ${shQuote(repo)} && git rev-parse --is-inside-work-tree && pwd`;
    const r = await runShim(["--repo", repo, "--run", "run-1", "--step", "step-1", "--", cmd], fake);
    assert.equal(r.exitCode, 0);
    assert.match(r.out, /true/);
    assert.match(r.out, new RegExp(repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("an injected io.cwd is honored by the spawned /bin/sh -c child", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-iocwd");
    const fake = new FakeSuiteTransport(NS_A);
    const workDir = join(FIXTURE_BASE, "io-cwd-work");
    mkdirSync(workDir, { recursive: true });
    const cmd = "pwd -P; printf '%s' CWD-OK";
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", cmd],
      fake,
      { ioCwd: workDir },
    );
    assert.equal(r.exitCode, 0);
    assert.equal(r.out, `${workDir}\nCWD-OK`, "the command must execute in the injected io.cwd");
    assert.equal(fake.opCalls("suite.record").length, 1);
  });

  it("a command's own 86/87/88 exit code passes through verbatim", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-exitcodes");
    for (const code of [86, 87, 88]) {
      const fake = new FakeSuiteTransport(NS_A);
      const r = await runShim(
        ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", `exit ${code}`],
        fake,
      );
      assert.equal(r.exitCode, code, `command exit ${code} must pass through`);
      const recs = fake.opCalls("suite.record");
      assert.equal(recs.length, 1);
      assert.equal(recs[0].req.exitCode, code);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────
// describe 3: tracked-dirty / drift / refusal semantics
// ───────────────────────────────────────────────────────────────────────
describe("tracked-dirty, drift and refusal (native exit 86/88 semantics)", () => {
  it("refuses a dirty tracked tree with exit 88 BEFORE any transport work", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-dirty88");
    writeFileSync(join(repo, "README.md"), "# dirty\n");
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", "echo SHOULD NOT RUN"],
      fake,
    );
    assert.equal(r.exitCode, TREE_DIRTY_EXIT_CODE);
    assert.match(r.err, /FAILURE_CLASS: tree_dirty/);
    assert.match(r.err, / README\.md/);
    assert.doesNotMatch(r.out, /SHOULD NOT RUN/);
    assert.equal(fake.calls.length, 0); // dirty refusal is fail-closed before any lookup/claim
  });

  it("untracked artifacts do not cause dirty refusal and are ignored for ledger evidence", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-untracked");
    writeFileSync(join(repo, "untracked.txt"), "new\n");
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--",
        `cd ${shQuote(repo)} && printf 'more' > untracked2.txt && echo ran`],
      fake,
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.out, /ran/);
    const recs = fake.opCalls("suite.record");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].req.exitCode, 0);
    assert.equal(fake.opCalls("suite.release").length, 0);
  });

  it("green run that mutates a tracked file is drift: exact-token release, event, exit 86, never recorded", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-drift86");
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--",
        `cd ${shQuote(repo)} && echo drifted >> README.md && echo done`],
      fake,
    );
    assert.equal(r.exitCode, TREE_DRIFT_EXIT_CODE);
    assert.match(r.err, /result could not be attributed: tree changed during test execution/);
    assert.equal(fake.opCalls("suite.record").length, 0);
    assert.equal(fake.rows.length, 0);
    const releases = fake.opCalls("suite.release");
    assert.equal(releases.length, 1);
    assert.equal(releases[0].req.reason, "tree_drift");
    const claims = fake.opCalls("suite.claim");
    assert.equal(claims.length, 1);
    assert.equal(releases[0].req.ownerToken, claims[0].req.ownerToken, "release uses the exact claimed token");
    const driftEvents = fake.events.filter((e) => e.event === "suite.tree_drift_detected");
    assert.equal(driftEvents.length, 1);
  });

  it("drift with a non-zero command exit preserves the original exit code (not 86)", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-drift-nonzero");
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--",
        `cd ${shQuote(repo)} && echo drifted >> README.md && exit 5`],
      fake,
    );
    assert.equal(r.exitCode, 5);
    assert.equal(fake.opCalls("suite.record").length, 0);
  });

  it("stable-tree failures are recorded as one exact red row; the claim is cleared by record, not released", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-red");
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", "echo boom >&2; exit 3"],
      fake,
    );
    assert.equal(r.exitCode, 3);
    assert.match(r.err, /boom/);
    const recs = fake.opCalls("suite.record");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].req.exitCode, 3);
    assert.equal(recs[0].req.runId, "run-1");
    assert.equal(recs[0].req.stepId, "step-1");
    assert.equal(fake.opCalls("suite.release").length, 0, "record itself clears the single-flight claim");
    assert.equal(fake.claims.size, 0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// describe 4: cache controls, --force and untrusted/outage responses
// ───────────────────────────────────────────────────────────────────────
describe("cache controls, --force, malformed/wrong-namespace and outage handling", () => {
  let repo: string;
  before(() => {
    repo = initRepo(FIXTURE_BASE, "repo-cache");
  });

  const baseCmd = "echo cached-pass";
  const tree = (): string => committedTreeHash(repo)!;
  const cmdHash = (): string => computeCmdHash(baseCmd);
  const baseArgs = (): string[] =>
    ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", baseCmd];
  const seedGreen = (fake: FakeSuiteTransport, createdAt?: string): void => {
    fake.seedRow({
      originRepo: repo,
      treeHash: tree(),
      cmdHash: cmdHash(),
      exitCode: 0,
      created_at: createdAt ?? new Date().toISOString(),
      duration_ms: 12_000,
      log_tail: "OLD GREEN TAIL\n",
      run_id: "run-old",
      step_id: "step-old",
      cmd_display: baseCmd,
    });
  };

  it("replays a fresh same-namespace green without executing (no-exec cache control)", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    seedGreen(fake);
    const r = await runShim(baseArgs(), fake);
    assert.equal(r.exitCode, 0);
    assert.match(r.out, /^TAMANDUA-TEST CACHED: tree /);
    assert.match(r.out, /OLD GREEN TAIL/);
    assert.match(r.out, /exit 0/);
    assert.equal(fake.opCalls("suite.record").length, 0);
    assert.equal(fake.opCalls("suite.claim").length, 0);
    const cacheHits = fake.events.filter((e) => e.event === "suite.cache_hit");
    assert.equal(cacheHits.length, 1);
    assert.equal(fake.rows.length, 1, "no new execution row was created");
  });

  it("--force bypasses a fresh green and executes + records a new row", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    seedGreen(fake);
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--force", "--", baseCmd],
      fake,
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.out, /cached-pass/);
    assert.doesNotMatch(r.out, /TAMANDUA-TEST CACHED/);
    const recs = fake.opCalls("suite.record");
    assert.equal(recs.length, 1);
    assert.equal(fake.rows.length, 2, "a new real row is recorded on top of the seeded one");
  });

  it("an expired green does NOT replay — the real command executes and records", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    seedGreen(fake, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    const r = await runShim(baseArgs(), fake);
    assert.equal(r.exitCode, 0);
    assert.match(r.out, /cached-pass/);
    assert.doesNotMatch(r.out, /TAMANDUA-TEST CACHED/);
    assert.equal(fake.opCalls("suite.record").length, 1);
  });

  it("red entries never replay: command re-executes with a recent-red note", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    fake.seedRow({
      originRepo: repo, treeHash: tree(), cmdHash: cmdHash(), exitCode: 1,
      created_at: new Date().toISOString(), run_id: "run-red", step_id: "step-red", cmd_display: baseCmd,
    });
    const r = await runShim(baseArgs(), fake);
    assert.equal(r.exitCode, 0);
    assert.match(r.err, /note: this tree failed/);
    const recs = fake.opCalls("suite.record");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].req.exitCode, 0);
  });

  it("a wrong-namespace lookup response is never trusted: real execution, explicit warning, no record", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    fake.lookupWrongNs = true;
    const r = await runShim(baseArgs(), fake);
    assert.equal(r.exitCode, 0);
    assert.match(r.err, /not trusting the result/);
    assert.match(r.out, /cached-pass/);
    assert.equal(fake.opCalls("suite.record").length, 0);
    assert.equal(fake.rows.length, 0);
  });

  it("a refused lookup degrades to real execution with a warning (no false green)", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    fake.lookupRefuse = { code: "DENIED", message: "scope binding mismatch" };
    const r = await runShim(baseArgs(), fake);
    assert.equal(r.exitCode, 0);
    assert.match(r.err, /suite transport refused lookup \(DENIED\)/);
    assert.match(r.out, /cached-pass/);
    assert.equal(fake.opCalls("suite.record").length, 0);
  });

  it("transport outage at lookup degrades like native control-plane unreachability", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    fake.outage = true;
    const r = await runShim(baseArgs(), fake);
    assert.equal(r.exitCode, 0);
    assert.match(r.err, /transport outage/);
    assert.match(r.out, /cached-pass/);
    assert.equal(fake.opCalls("suite.record").length, 0);
  });

  it("a record outage warns and preserves the command exit code (never a recorded green)", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    fake.recordFailure = "unavailable";
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", "echo x; exit 4"],
      fake,
    );
    assert.equal(r.exitCode, 4);
    assert.match(r.err, /failed to record suite result to control plane/);
    assert.equal(fake.rows.length, 0);
  });

  it("a refused record is not swallowed as success and the exit code is preserved", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    fake.recordFailure = "refused";
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", "echo x; exit 4"],
      fake,
    );
    assert.equal(r.exitCode, 4);
    assert.match(r.err, /suite transport refused to record \(WRONG_NAMESPACE\)/);
    assert.equal(fake.rows.length, 0);
  });

  it("a record answered from another namespace is NOT treated as recorded for this namespace", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    fake.recordWrongNs = true;
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", "echo x"],
      fake,
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.err, /record was answered from a different environment namespace/);
    assert.equal(fake.rows.length, 0);
  });

  it("without a host-attested namespace NO ledger result is trusted (real execution only)", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(baseArgs(), fake, { namespace: null });
    assert.equal(r.exitCode, 0);
    assert.match(r.err, /no host-attested Matchlock environment namespace/);
    assert.match(r.out, /cached-pass/);
    assert.equal(fake.calls.length, 0);
    assert.equal(fake.rows.length, 0);
  });

  it("a malformed namespace is refused before any ledger use", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    const bad = { ...NS_A, compatibilityFingerprint: "bad fingerprint with space" };
    const r = await runShim(baseArgs(), fake, { namespace: bad });
    assert.equal(r.exitCode, 0);
    assert.match(r.err, /refusing to trust the suite ledger/);
    assert.equal(fake.calls.length, 0);
  });

  it("a dirty replay corridor refuses with exit 88 instead of replaying a stale green", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    seedGreen(fake);
    writeFileSync(join(repo, "README.md"), "# dirty-again\n");
    const r = await runShim(baseArgs(), fake);
    assert.equal(r.exitCode, TREE_DIRTY_EXIT_CODE);
    assert.match(r.err, /FAILURE_CLASS: tree_dirty/);
    assert.doesNotMatch(r.out, /TAMANDUA-TEST CACHED/);
    // restore for later tests in this file's own repo usage
    git(repo, ["checkout", "--", "README.md"]);
  });

  it("namespace normalization and canonicalization are bounded and deterministic (contract unit)", () => {
    const trimmed = { ...NS_A, imageContentId: `  ${NS_A.imageContentId}  ` };
    const norm = normalizeGuestSuiteNamespace({ ...trimmed });
    assert.equal(norm.ok, true);
    if (norm.ok) assert.equal(norm.value.imageContentId, NS_A.imageContentId);
    assert.equal(normalizeGuestSuiteNamespace({ ...NS_A, guestPlatform: "" }).ok, false);
    assert.equal(
      normalizeGuestSuiteNamespace({ ...NS_A, compatibilityFingerprint: "x".repeat(65) }).ok,
      false,
    );
    assert.equal(
      normalizeGuestSuiteNamespace({ ...NS_A, guestPlatform: "linux/amd64\nother" }).ok,
      false,
    );
    assert.notEqual(NS_A_ID, NS_B_ID);
  });
});

// ───────────────────────────────────────────────────────────────────────
// describe 5: single-flight wait / promotion / re-key / bounded poll
// ───────────────────────────────────────────────────────────────────────
describe("single-flight claim, waiter promotion, re-key and bounded poll", () => {
  let repo: string;
  before(() => {
    repo = initRepo(FIXTURE_BASE, "repo-singleflight");
  });
  const cmdText = "echo sf";
  const cmdHash = (): string => computeCmdHash(cmdText);

  it("a waiter replays the owner's fresh green without executing (promotion)", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    let claimNo = 0;
    fake.claimOpImpl = async (req, native) => {
      claimNo += 1;
      if (claimNo === 1) {
        // The owner currently holds the key: answer wait, and have the owner
        // record a fresh green so the polling waiter can replay it.
        fake.seedRow({
          originRepo: req.originRepo, treeHash: req.treeHash, cmdHash: req.cmdHash, exitCode: 0,
          duration_ms: 9000, run_id: "run-owner", step_id: "step-owner", cmd_display: cmdText,
        });
        return { ok: true as const, value: { namespaceId: NS_A_ID, action: "wait" as const } };
      }
      return native(req);
    };
    const r = await runShim(
      ["--repo", repo, "--run", "run-waiter", "--step", "step-waiter", "--", cmdText],
      fake,
      { options: { singleflightPollIntervalMs: 10, claimTimeoutMs: 2000 } },
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.out, /TAMANDUA-TEST CACHED/);
    assert.ok(fake.events.some((e) => e.event === "suite.singleflight_wait"));
    assert.equal(fake.events.filter((e) => e.event === "suite.cache_hit").length, 1);
    assert.equal(fake.opCalls("suite.record").length, 0);
    assert.equal(fake.rows.length, 1); // only the owner row exists
  });

  it("bounded poll timeout executes the real command when no result ever arrives", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    let claimNo = 0;
    fake.claimOpImpl = async (req, native) => {
      claimNo += 1;
      if (claimNo === 1) {
        // Simulate a STUCK owner: a foreign claim that never records/releases.
        const key = keyOf(req.originRepo, req.treeHash, req.cmdHash, NS_A_ID);
        fake.claims.set(key, { key, ownerToken: "foreign-owner-token", namespaceId: NS_A_ID });
        return { ok: true as const, value: { namespaceId: NS_A_ID, action: "wait" as const } };
      }
      return native(req);
    };
    const r = await runShim(
      ["--repo", repo, "--run", "run-timeout", "--step", "step-timeout", "--", cmdText],
      fake,
      { options: { singleflightPollIntervalMs: 10, claimTimeoutMs: 150 } },
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.err, /single-flight claim poll timed out — executing/);
    assert.match(r.out, /sf/);
    assert.equal(fake.opCalls("suite.record").length, 1);
  });

  it("HEAD move while waiting re-keys: release the old key with the exact token, record under the NEW tree", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    const treeBefore = committedTreeHash(repo)!;
    let claimNo = 0;
    let lookupNo = 0;
    fake.claimOpImpl = async (req, native) => {
      claimNo += 1;
      if (claimNo === 1) {
        return { ok: true as const, value: { namespaceId: NS_A_ID, action: "wait" as const } };
      }
      // Promotion claim after the HEAD move: served by the native-like path.
      return native(req);
    };
    fake.lookupOpImpl = async (req, native) => {
      lookupNo += 1;
      if (lookupNo === 2) {
        // The waiter is parked in its poll loop: move HEAD deterministically
        // so the promotion re-keys to the new committed tree.
        writeFileSync(join(repo, "rekey-marker.txt"), "moved\n");
        git(repo, ["add", "rekey-marker.txt"]);
        git(repo, ["commit", "-q", "-m", "move head"]);
      }
      return native(req);
    };
    const r = await runShim(
      ["--repo", repo, "--run", "run-rekey", "--step", "step-rekey", "--", cmdText],
      fake,
      { options: { singleflightPollIntervalMs: 15, claimTimeoutMs: 4000 } },
    );
    assert.equal(r.exitCode, 0);
    const treeAfter = committedTreeHash(repo)!;
    assert.notEqual(treeAfter, treeBefore);
    const recs = fake.opCalls("suite.record");
    assert.equal(recs.length, 1);
    assert.equal(recs[0].req.treeHash, treeAfter, "record must describe the tree actually tested");
    const releases = fake.opCalls("suite.release");
    const oldKeyRelease = releases.find((c) => c.req.treeHash === treeBefore);
    assert.ok(oldKeyRelease, "the pre-move claim key must be released with the exact token");
    const claims = fake.opCalls("suite.claim");
    assert.equal(oldKeyRelease!.req.ownerToken, claims[0].req.ownerToken);
  });
});

// ───────────────────────────────────────────────────────────────────────
// describe 6: bounded tail + streaming fidelity; duration hint; events
// ───────────────────────────────────────────────────────────────────────
describe("bounded tail, stream fidelity, duration hint and event routing", () => {
  let repo: string;
  before(() => {
    repo = initRepo(FIXTURE_BASE, "repo-tail");
  });

  it("streams the full raw output while retaining only a bounded record tail (≤ 20KiB)", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    const line = "0123456789abcdefghijklmnopqrstuvwxyz-0123456789-0123456789\n"; // 58 bytes
    const n = 1000; // ~58 KiB, well over the 20 KiB record bound
    const cmd = `i=0; while [ $i -lt ${n} ]; do printf '%s' '${line}'; i=$((i+1)); done`;
    const r = await runShim(["--repo", repo, "--run", "run-1", "--step", "step-1", "--", cmd], fake);
    assert.equal(r.exitCode, 0);
    const expectedBytes = Buffer.byteLength(line, "utf-8") * n;
    assert.equal(r.outRaw.byteLength, expectedBytes, "all output must stream through untouched");
    const recs = fake.opCalls("suite.record");
    assert.equal(recs.length, 1);
    const logTail = recs[0].req.logTail as string;
    assert.ok(Buffer.byteLength(logTail, "utf-8") <= 20 * 1024, "record tail must stay bounded");
    assert.ok(logTail.endsWith(line), "the tail retains the FINAL output bytes");
  });

  it("clampDisplayBytes keeps a REAL ≤maxBytes UTF-8 bound without splitting code points (unit)", () => {
    assert.equal(clampDisplayBytes("plain command", 200), "plain command");
    assert.equal(clampDisplayBytes("", 200), "");
    // 101 × é = 202 bytes: exactly 100 × é (200 bytes) fits, 101 would not.
    assert.equal(clampDisplayBytes("é".repeat(101), 200), "é".repeat(100));
    assert.ok(Buffer.byteLength(clampDisplayBytes("é".repeat(500), 200), "utf-8") <= 200);
    // Astral code points (4 bytes, 2 code units) are never split: a code-unit
    // slice would cut the pair and silently exceed/mangle the byte bound.
    const astral = "A".repeat(197) + "😀"; // 201 bytes total
    assert.equal(clampDisplayBytes(astral, 200), "A".repeat(197));
    const astral2 = "A".repeat(198) + "😀"; // 202 bytes; prefix(199) would end mid-pair
    assert.equal(clampDisplayBytes(astral2, 200), "A".repeat(198));
    const astral3 = "😀".repeat(60); // 240 bytes, 120 code units
    assert.equal(clampDisplayBytes(astral3, 200), "😀".repeat(50)); // exactly 200 bytes
    assert.equal(Buffer.byteLength(clampDisplayBytes(astral3, 199), "utf-8"), 196); // 49 × 4
  });

  it("cmd_display in the record is clamped to a REAL 200-byte bound (multibyte command)", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    const filler = "é".repeat(200); // 400 bytes — a 200-code-unit slice would exceed the bound
    const cmd = `printf ok; # ${filler}`;
    const r = await runShim(["--repo", repo, "--run", "run-1", "--step", "step-1", "--", cmd], fake);
    assert.equal(r.exitCode, 0);
    assert.equal(r.out, "ok", "the full command still executes");
    const recs = fake.opCalls("suite.record");
    assert.equal(recs.length, 1);
    const display = recs[0].req.cmdDisplay as string;
    assert.ok(Buffer.byteLength(display, "utf-8") <= 200, "display must respect the real byte bound");
    assert.equal(display, `printf ok; # ${"é".repeat(93)}`); // 13 + 186 = 199 bytes
    assert.equal(
      recs[0].req.cmdHash,
      computeCmdHash(cmd),
      "display truncation never changes the exact raw command hash",
    );
  });

  it("routes duration-history into the p50 advisory hint (completed runs only)", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    // Duration history is keyed (origin_repo, cmd_hash) ACROSS trees, while
    // lookup is keyed (origin_repo, tree, cmd) — seed history rows under a
    // DIFFERENT tree so the current run executes for real instead of replaying.
    const otherTree = "0".repeat(40);
    fake.seedRow({
      originRepo: repo, treeHash: otherTree,
      cmdHash: computeCmdHash("echo dur"), exitCode: 0, duration_ms: 120_000, cmd_display: "echo dur",
    });
    fake.seedRow({
      originRepo: repo, treeHash: otherTree,
      cmdHash: computeCmdHash("echo dur"), exitCode: 0, duration_ms: 240_000, cmd_display: "echo dur",
    });
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", "echo dur"],
      fake,
    );
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.out, /TAMANDUA-TEST CACHED/);
    assert.match(r.err, /TAMANDUA-TEST: expect ~3min based on 2 prior runs/);
    assert.equal(fake.opCalls("suite.record").length, 1);
  });

  it("--force skips the duration hint", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    fake.seedRow({
      originRepo: repo, treeHash: "1".repeat(40),
      cmdHash: computeCmdHash("echo dur-f"), exitCode: 0, duration_ms: 120_000, cmd_display: "echo dur-f",
    });
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--force", "--", "echo dur-f"],
      fake,
    );
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.err, /TAMANDUA-TEST: expect ~/);
  });

  it("execute_started is routed and only permitted suite events are ever attempted", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    const r = await runShim(["--repo", repo, "--run", "run-1", "--step", "step-1", "--", "echo routed"], fake);
    assert.equal(r.exitCode, 0);
    const executed = fake.events.filter((e) => e.event === "suite.execute_started");
    assert.equal(executed.length, 1);
    assert.equal(executed[0].fields.run_id, "run-1");
    const attempted = fake.calls.filter((c) => c.op === "suite.event");
    assert.ok(attempted.length >= 1);
    for (const call of attempted) {
      assert.ok((SUITE_PERMITTED_EVENTS as readonly string[]).includes(String(call.req.event)));
    }
  });

  it("duration history unavailable degrades silently (no hint, no failure)", async () => {
    const fake = new FakeSuiteTransport(NS_A);
    fake.noDuration = true;
    const r = await runShim(
      ["--repo", repo, "--run", "run-1", "--step", "step-1", "--", "echo nohint"],
      fake,
    );
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.err, /TAMANDUA-TEST: expect ~/);
  });
});

// ───────────────────────────────────────────────────────────────────────
// describe 7: git helper parity (unit-level on isolated fixtures)
// ───────────────────────────────────────────────────────────────────────
describe("guest-suite git helper parity", () => {
  let repo: string;
  before(() => {
    repo = initRepo(FIXTURE_BASE, "repo-githelp");
  });

  it("committedTreeHash equals git rev-parse HEAD^{tree}", () => {
    const direct = execFileSync("git", ["rev-parse", "HEAD^{tree}"], {
      cwd: repo,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    assert.equal(committedTreeHash(repo), direct);
  });

  it("trackedTreeHash changes on tracked edits but not on untracked/ignored files", () => {
    const base = trackedTreeHash(repo)!;
    writeFileSync(join(repo, "fresh-untracked.txt"), "x\n");
    assert.equal(trackedTreeHash(repo), base, "untracked file must not enter the tracked tree");
    writeFileSync(join(repo, "debug.log"), "ignored\n");
    assert.equal(trackedTreeHash(repo), base, "ignored file must not enter the tracked tree");
    writeFileSync(join(repo, "README.md"), "# changed\n");
    assert.notEqual(trackedTreeHash(repo), base, "tracked edit must change the tracked tree");
    git(repo, ["checkout", "--", "README.md"]);
  });

  it("computeCmdHash hashes the exact raw command bytes (no env decoration)", () => {
    assert.equal(computeCmdHash("npm test"), computeCmdHash("npm test"));
    assert.notEqual(computeCmdHash("npm test"), computeCmdHash("npm test "));
    assert.equal(computeCmdHash("npm test").length, 64);
  });

  it("getTrackedDirtyPaths reports only tracked modifications", () => {
    assert.deepEqual(getTrackedDirtyPaths(repo), []);
    writeFileSync(join(repo, "README.md"), "# dirty-tracked\n");
    const dirty = getTrackedDirtyPaths(repo)!;
    assert.ok(dirty.some((p) => p.includes("README.md")));
    git(repo, ["checkout", "--", "README.md"]);
    writeFileSync(join(repo, "untracked-dirty.txt"), "u\n");
    assert.deepEqual(getTrackedDirtyPaths(repo), []);
  });
});

// ───────────────────────────────────────────────────────────────────────
// describe 8: real subprocess entry + interruption (NOT actualVM)
// ───────────────────────────────────────────────────────────────────────
describe("real subprocess entry: raw semantics and catchable interruption 87 (NOT actualVM)", () => {
  const subHome = createTempHome("tamandua-guest-suite-sub-");

  function collect(
    child: ChildProcess,
    timeoutMs = 20_000,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; err: string }> {
    return new Promise((resolve, reject) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
        reject(new Error("subprocess timed out"));
      }, timeoutMs);
      child.stdout!.on("data", (c: Buffer) => {
        out += c.toString("utf-8");
      });
      child.stderr!.on("data", (c: Buffer) => {
        err += c.toString("utf-8");
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, out, err });
      });
    });
  }

  it("entry passthrough (TAMANDUA_TSTX=0) keeps raw stdout/stderr separation and the exit code", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-entry-tstx");
    const child = spawn(
      process.execPath,
      [
        DIST_ENTRY,
        "--repo", repo, "--run", "run-e", "--step", "step-e",
        "--", "printf 'RAW-OUT\\n'", ";", "printf 'RAW-ERR\\n'", ">&2", ";", "exit 6",
      ],
      {
        env: cleanChildEnv({ HOME: subHome.homeDir, TAMANDUA_TSTX: "0" }),
        cwd: subHome.homeDir,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const res = await collect(child);
    assert.equal(res.code, 6);
    assert.equal(res.out, "RAW-OUT\n");
    assert.match(res.err, /RAW-ERR/);
    assert.match(res.err, /passthrough mode/);
  });

  it("entry without an attested namespace executes for real and never records", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-entry-nons");
    const child = spawn(
      process.execPath,
      [DIST_ENTRY, "--repo", repo, "--run", "run-e", "--step", "step-e", "--", "echo no-ns-run"],
      {
        env: cleanChildEnv({ HOME: subHome.homeDir }),
        cwd: subHome.homeDir,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const res = await collect(child);
    assert.equal(res.code, 0);
    assert.match(res.out, /no-ns-run/);
    assert.match(res.err, /no host-attested Matchlock environment namespace/);
  });

  it("a caller SIGTERM during execution records interruption evidence (87) and releases the exact token", async () => {
    const repo = initRepo(FIXTURE_BASE, "repo-interrupt");
    const evidenceFile = join(ROOT.root, `interrupt-evidence-${process.pid}-${Date.now()}.jsonl`);
    const childCode = `
import { runGuestSuiteShim } from ${JSON.stringify(`file://${DIST_SHIM}`)};
const c = await import(${JSON.stringify(`file://${DIST_CONTRACT}`)});
const fs = await import("node:fs");
const ns = { imageContentId: "sha256:interrupt", guestPlatform: "linux/amd64", helperContract: "guest-helper-int", compatibilityFingerprint: "int-fp" };
const nsId = c.guestSuiteNamespaceId(ns);
const EV = process.env.EVIDENCE_FILE;
const log = (o) => fs.appendFileSync(EV, JSON.stringify(o) + "\\n");
let rows = 0;
const transport = {
  contractVersion: c.GUEST_SUITE_TRANSPORT_VERSION,
  namespace: ns,
  async lookup(req) { log({ op: "lookup", tree: req.treeHash }); return { ok: true, value: { namespaceId: nsId, latest: null, passCount: 0, failCount: 0, flaky: false } }; },
  async claim(req) { log({ op: "claim", token: req.ownerToken }); return { ok: true, value: { namespaceId: nsId, action: "run" } }; },
  async record(req) { rows += 1; log({ op: "record", exitCode: req.exitCode }); return { ok: true, value: { namespaceId: nsId, id: rows, created_at: new Date().toISOString() } }; },
  async release(req) { log({ op: "release", token: req.ownerToken, reason: req.reason }); return { ok: true, value: { namespaceId: nsId, released: true } }; },
  async durationHistory() { return { ok: true, value: { namespaceId: nsId, durations: [] } }; },
  async emitEvent(req) { log({ op: "event", event: req.event }); return { ok: true, value: { namespaceId: nsId, emitted: true } }; },
};
const res = await runGuestSuiteShim(
  ["--repo", process.env.REPO_DIR, "--run", "run-i", "--step", "step-i", "--", "echo INTERRUPTIBLE SUITE STARTED; sleep 30"],
  { cwd: process.env.REPO_DIR, envGet: (n) => process.env[n], writeOut: (t) => process.stdout.write(t), writeErr: (t) => process.stderr.write(t) },
  { transport, namespace: ns, options: { requestTimeoutMs: 2000, singleflightPollIntervalMs: 10, claimTimeoutMs: 2000 } },
);
process.exitCode = res.exitCode;
`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childCode], {
      env: cleanChildEnv({ HOME: subHome.homeDir, EVIDENCE_FILE: evidenceFile, REPO_DIR: repo }),
      cwd: subHome.homeDir,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group: the test signals ONLY this child
    });
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      let out = "";
      let err = "";
      let interrupted = false;
      const timer = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          /* ignore */
        }
        reject(new Error("interrupt fixture timed out"));
      }, 25_000);
      child.stdout!.on("data", (buf: Buffer) => {
        out += buf.toString("utf-8");
        if (!interrupted && out.includes("INTERRUPTIBLE SUITE STARTED") && child.pid !== undefined) {
          interrupted = true;
          try {
            process.kill(-child.pid, "SIGTERM");
            process.kill(-child.pid, "SIGTERM"); // duplicate-signal close race
          } catch {
            /* ignore */
          }
        }
      });
      child.stderr!.on("data", (buf: Buffer) => {
        err += buf.toString("utf-8");
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
    assert.equal(result.code, INTERRUPTED_EXIT_CODE, "interrupted suite exits 87");
    assert.match(result.err, /suite KILLED by external SIGTERM/);
    assert.ok(existsSync(evidenceFile), "evidence file must be written");
    const lines = readFileSync(evidenceFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const recordLine = lines.find((l) => l.op === "record");
    assert.ok(recordLine, "an interrupted record with exit 87 must be attempted");
    assert.equal(recordLine.exitCode, 87);
    const releaseLine = lines.find((l) => l.op === "release");
    assert.ok(releaseLine, "an exact-token cancel release must be attempted");
    assert.equal(releaseLine.reason, "cancel");
    const claimLine = lines.find((l) => l.op === "claim");
    assert.equal(releaseLine.token, claimLine.token, "release uses the exact claimed token");
  });

  it("a standalone waiter parked on a stuck owner finishes polling and RUNS (referenced poll timer, no phantom exit 0)", async () => {
    // Regression for the poll sleep: native shim.ts keeps its sleep timer
    // REFERENCED, so a guest entry whose only pending work is the single-flight
    // waiter poll stays alive until the bounded claim timeout. An unref'd
    // timer lets this child's event loop drain mid-poll and the process exits
    // before the poll deadline with NO suite result (observed as an abort —
    // code 13, unsettled top-level await — rather than the real exit 5; a CJS
    // entry drains to a silent exit 0 instead), because the fake transport
    // holds no referenced socket/handle. The real command exits 5, so any
    // phantom early exit is unambiguously distinguishable.
    const repo = initRepo(FIXTURE_BASE, "repo-pollsleep");
    const childCode = `
import { runGuestSuiteShim } from ${JSON.stringify(`file://${DIST_SHIM}`)};
const c = await import(${JSON.stringify(`file://${DIST_CONTRACT}`)});
const ns = { imageContentId: "sha256:pollsleep", guestPlatform: "linux/amd64", helperContract: "guest-helper-poll", compatibilityFingerprint: "poll-fp" };
const nsId = c.guestSuiteNamespaceId(ns);
const transport = {
  contractVersion: c.GUEST_SUITE_TRANSPORT_VERSION,
  namespace: ns,
  // STUCK owner: every claim answers "wait" and no green is ever recorded,
  // so the waiter must poll until its bounded claimTimeoutMs, then execute.
  async lookup() { return { ok: true, value: { namespaceId: nsId, latest: null, passCount: 0, failCount: 0, flaky: false } }; },
  async claim() { return { ok: true, value: { namespaceId: nsId, action: "wait" } }; },
  async record(req) { return { ok: true, value: { namespaceId: nsId, id: 1, created_at: new Date().toISOString() } }; },
  async release() { return { ok: true, value: { namespaceId: nsId, released: true } }; },
  async durationHistory() { return { ok: true, value: { namespaceId: nsId, durations: [] } }; },
  async emitEvent() { return { ok: true, value: { namespaceId: nsId, emitted: true } }; },
};
const res = await runGuestSuiteShim(
  ["--repo", process.env.REPO_DIR, "--run", "run-p", "--step", "step-p", "--", "exit 5"],
  { cwd: process.env.REPO_DIR, envGet: (n) => process.env[n], writeOut: (t) => process.stdout.write(t), writeErr: (t) => process.stderr.write(t) },
  { transport, namespace: ns, options: { requestTimeoutMs: 1000, singleflightPollIntervalMs: 30, claimTimeoutMs: 400 } },
);
process.exitCode = res.exitCode;
`;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childCode], {
      env: cleanChildEnv({ HOME: subHome.homeDir, REPO_DIR: repo }),
      cwd: subHome.homeDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL"); // retained direct handle; child is not detached
        } catch {
          /* ignore */
        }
        reject(new Error("waiter-poll fixture timed out"));
      }, 15_000);
      child.stdout!.on("data", (buf: Buffer) => {
        out += buf.toString("utf-8");
      });
      child.stderr!.on("data", (buf: Buffer) => {
        err += buf.toString("utf-8");
      });
      child.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err });
      });
    });
    // code 5 (not a phantom early exit — 0 in a CJS entry, 13 in this ESM
    // abort) proves the poll ran to its bounded deadline and the real command
    // executed guest-locally.
    assert.equal(result.code, 5, "waiter must finish polling and execute the real command (exit 5)");
    assert.match(result.err, /single-flight claim poll timed out — executing/);
  });
});
