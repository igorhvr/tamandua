/******************************************************************************
 * ⚠️  REAL-TOKEN REAL-VM CANARY — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-ALL-WORKFLOWS US-010 — the real-model dsh canary for the genuine
 * bundled `feature-dev-merge-worktree` workflow under the Matchlock dsh route.
 *
 * ONE tiny real run through a real ISOLATED daemon → scheduler → Matchlock dsh
 * invocation runner → FRESH VMs, using the REAL operator image
 * `igorhvr/bedlam-ubuntu` (the matchlock-store image that ships dsh 0.1.5-rc.2,
 * hermes and pi) with `--dsh-as-harness`. The guest dsh makes REAL model calls
 * against the operator's own dsh credential home (staged into a fresh
 * gate-owned DSH_HOME and mounted RW through the product's normal DSH_HOME
 * mapping), so this canary SPENDS REAL TOKENS.
 *
 * WHAT IT PROVES (the dsh story/merge seam end-to-end):
 *   - the genuine bundled feature-dev-merge-worktree run reaches real status
 *     "completed" through isolated daemon → fresh dsh VMs;
 *   - a REAL squash landed on the tiny OWNED origin branch (the target tree
 *     advanced to the finalizer's MERGED_TREE; a real merge.landed event);
 *   - runs.tokens_spent > 0 with POSITIVE per-round attribution: every mapped
 *     dsh v3 session for this run carries usage > 0 and the run total equals
 *     the sum over those sessions (input + output, cache_read EXCLUDED,
 *     tolerance 0) read with the PRODUCTION confined in-VM reader;
 *   - every VM the canary created is positively closed and recorded in the
 *     exact-owned cleanup ledger (empty positive owned-VM inventory).
 *
 * It is deliberately NOT part of any default fast lane (npm test /
 * run-all-smoke / run-all-scripted / run-all-e2e-tests). Run it on demand
 * UNDER THE SHARED GATE LOCK:
 *
 *   flock --exclusive /home/kaladin/matchlock-work/vaivm-gate.lock \
 *     ./run-matchlock-dsh-merge-worktree-canary-e2e-test
 *
 * which builds first, resolves the system matchlock pair, creates a NEW
 * never-reused evidence directory
 * <TAMANDUA_GATE_EVIDENCE_ROOT>/dsh-merge-worktree-canary-<...>/ (outside the
 * repo), stages the operator's real dsh credentials into a fresh gate-owned
 * DSH_HOME (credentials are never printed), and runs this file with all logs
 * tee'd into that directory.
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB under the evidence dir, fresh
 * control port, never the live worker daemon, tiny OWNED origin repository
 * under the evidence dir. Never touches live branches or the operator's
 * credential home contents.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanChildEnv, reservePortHandles, type PortHandle } from "../tests/helpers/test-env.ts";
import { openE2eDatabase } from "./helpers/e2e-database.mjs";
import {
  inheritedProcessEnv,
  cliMustSucceed,
  spawnWorkflowRun,
  resolveFullRunId,
  releasePortReservations,
} from "./helpers/smoke-helpers.ts";
import { startIsolatedDaemon, stopIsolatedDaemon } from "./helpers/e2e-helpers.ts";
import {
  assertNoOwnedVms,
  cleanupOwnedVms,
  fabricateVmHome,
  makeFakeMatchlock,
  readRunEvents,
  readRunnerVmEvidenceIds,
  readVmInventory,
} from "./helpers/matchlock-gate-lifecycle.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

const WORKFLOW_ID = "feature-dev-merge-worktree";

// The REAL qualified operator image (never a synthetic fixture). The matchlock
// store copy of this tag is the toolchain image; the plain docker tag is NOT.
const BEDLAM_TAG = "igorhvr/bedlam-ubuntu";

// ── environment: pinned paired runtime + operator sources ─────────────────
// The runner script (run-matchlock-dsh-merge-worktree-canary-e2e-test)
// resolves the system runtime and exports these names before launching this
// file. TAMANDUA_GATE_REAL_DSH_HOME is the operator's real dsh home
// (credentials + profiles) — its `sessions/` is intentionally NEVER copied so
// the attributed store starts empty.
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";
const OPERATOR_CACHE =
  process.env.TAMANDUA_GATE_OPERATOR_CACHE ??
  process.env.TAMANDUA_GATE_FIXTURE_IMAGE_CACHE ??
  "";
const REAL_DSH_HOME = process.env.TAMANDUA_GATE_REAL_DSH_HOME ?? "";

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 90 * 60_000;

const TASK =
  "Implement ONE tiny story in this repository and land it through the normal " +
  "workflow: add an exported function `multiply(a, b)` that returns a * b to " +
  "src/math.mjs, and extend the existing test.mjs to assert multiply(6, 7) === 42. " +
  "Keep the change minimal and do not touch any other file.";

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-dsh-merge-worktree-canary-e2e-test)",
  );
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set");
  assert.ok(GUEST_INIT.length > 0, "MATCHLOCK_GUEST_INIT must be set");
  assert.ok(GUEST_FUSED.length > 0, "MATCHLOCK_GUEST_FUSED must be set");
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    assert.ok(fs.existsSync(p), `paired runtime binary missing: ${p}`);
  }
  assert.ok(
    OPERATOR_CACHE.length > 0,
    "TAMANDUA_GATE_OPERATOR_CACHE (the operator ~/.cache/matchlock store carrying " +
      `the real ${BEDLAM_TAG} image) must be set`,
  );
  assert.ok(
    fs.existsSync(path.join(OPERATOR_CACHE, "images", "metadata.db")),
    `operator matchlock image store missing under ${OPERATOR_CACHE}`,
  );
  assert.ok(
    REAL_DSH_HOME.length > 0,
    "TAMANDUA_GATE_REAL_DSH_HOME (the operator's real dsh home) must be set",
  );
  assert.ok(
    fs.existsSync(path.join(REAL_DSH_HOME, ".credentials.yaml")),
    `operator dsh credentials missing at ${path.join(REAL_DSH_HOME, ".credentials.yaml")}`,
  );
}

function gateEnv(
  homeDir: string,
  controlPort: number,
  dshHome: string,
): Record<string, string> {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  return {
    ...inheritedProcessEnv(),
    HOME: homeDir,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
    TMPDIR: path.join(EVIDENCE_DIR, "tmp"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_HARNESS_PROBE: "1",
    TAMANDUA_PI_BINARY: "/usr/bin/false",
    TAMANDUA_DSH_BINARY: "/usr/bin/false",
    TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN,
    MATCHLOCK_GUEST_INIT: GUEST_INIT,
    MATCHLOCK_GUEST_FUSED: GUEST_FUSED,
    // The frozen submission DSH_HOME the product mounts RW at
    // /workspace/config/dsh: our fresh copy of the operator's credentials +
    // profiles. `sessions/` starts absent so attribution has a clean ledger.
    DSH_HOME: dshHome,
  };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

/**
 * Tiny OWNED origin repo with a deterministic committed test script. The
 * canary's real model story must be implementable with a one-function change.
 */
function prepareOwnedOrigin(originDir: string): { originalBranch: string; initialTree: string } {
  fs.mkdirSync(path.join(originDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(originDir, "README.md"),
    "# Tiny owned origin (dsh real canary)\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(originDir, "src", "math.mjs"),
    "export function add(a, b) { return a + b; }\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(originDir, "test.mjs"),
    'import { add } from "./src/math.mjs";\n' +
      'if (add(2, 3) !== 5) { console.error("bad add"); process.exit(1); }\n' +
      'console.log("owned fixture tests ok");\n',
    "utf-8",
  );
  fs.writeFileSync(path.join(originDir, ".gitignore"), "*.log\n", "utf-8");
  git(["init", "-q", "-b", "main"], originDir);
  git(["config", "user.email", "canary@tamandua.test"], originDir);
  git(["config", "user.name", "Matchlock dsh Canary"], originDir);
  git(["add", "-A"], originDir);
  git(["commit", "-q", "-m", "initial owned origin fixture"], originDir);
  const initialTree = git(["rev-parse", "HEAD^{tree}"], originDir);
  // Detach the origin checkout so the run's target ref is not the checked-out
  // branch (the merger must never switch the origin checkout).
  git(["checkout", "-q", "--detach"], originDir);
  return { originalBranch: "main", initialTree };
}

function extractKey(output: string | null | undefined, key: string): string {
  const m = String(output ?? "").match(new RegExp(`^${key}:\\s*(\\S+)`, "im"));
  return m ? m[1] : "";
}

// ── operator matchlock image-store seeding ─────────────────────────────────

/**
 * Seed the private matchlock image store from the operator's store via
 * HARDLINKED content-addressed blobs + copied metadata. The REAL qualified
 * `igorhvr/bedlam-ubuntu` image exists ONLY in the operator matchlock store;
 * the plain docker tag is a different, tool-less image. Never mutates the
 * operator store.
 */
function seedOperatorImageStore(operatorCache: string, homeDir: string): void {
  const src = path.join(operatorCache, "images");
  const dst = path.join(homeDir, ".cache", "matchlock", "images");
  fs.mkdirSync(dst, { recursive: true });
  const srcBlobs = path.join(src, "blobs");
  if (fs.existsSync(srcBlobs) && fs.readdirSync(srcBlobs).length > 0) {
    const linked = spawnSync("cp", ["-al", srcBlobs, path.join(dst, "blobs")], {
      encoding: "utf-8",
    });
    if (linked.status !== 0) {
      const copied = spawnSync(
        "cp",
        ["-a", "--reflink=auto", srcBlobs, path.join(dst, "blobs")],
        { encoding: "utf-8" },
      );
      assert.equal(
        copied.status,
        0,
        `seeding operator image blobs failed (hardlink: ${linked.stderr}; copy: ${copied.stderr})`,
      );
    }
  }
  for (const meta of ["metadata.db", "metadata.db-wal", "metadata.db-shm"]) {
    const from = path.join(src, meta);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, meta));
  }
  const local = path.join(src, "local");
  if (fs.existsSync(local)) fs.cpSync(local, path.join(dst, "local"), { recursive: true });
}

function resolveImage(
  tag: string,
  homeDir: string,
): { digest: string; config_digest: string } {
  const r = spawnSync(MATCHLOCK_RPC_BIN, ["image", "resolve", tag], {
    encoding: "utf-8",
    env: cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir }),
  });
  assert.equal(r.status, 0, `matchlock image resolve ${tag} failed: ${r.stderr}`);
  const identity = JSON.parse(r.stdout.trim()) as { digest: string; config_digest: string };
  assert.ok(
    identity.digest.startsWith("sha256:") && identity.config_digest.startsWith("sha256:"),
    `resolved identity for ${tag} incomplete: ${r.stdout.trim()}`,
  );
  return identity;
}

// ── dsh v3 store reader + reconciliation ──────────────────────────────────

interface DshReader {
  discover: (
    dirPath: string,
  ) => { current: string | null; encoding: string | null; problem: string | null };
  read: (opts: { artifactPath: string; admittedRoot: string }) => {
    decode: string;
    usageIncomplete: boolean;
    usageTokens: number | null;
  };
}

let dshReader: DshReader | null = null;

async function loadDshDistReader(): Promise<void> {
  if (dshReader) return;
  const mod = await import(`${repoRoot}/dist/installer/matchlock/dsh-session-store.js`);
  dshReader = {
    discover: (dirPath: string) => mod.discoverSessionArtifacts(dirPath),
    read: (opts: { artifactPath: string; admittedRoot: string }) => {
      const read = mod.readDshSessionArtifact(opts);
      return {
        decode: read.decode,
        usageIncomplete: read.usageIncomplete,
        usageTokens: read.usageTokens,
      };
    },
  };
}

interface SessionUsage {
  dir: string;
  artifact: string;
  usageTokens: number;
}

/**
 * Read EVERY session artifact in the gate-owned mapped dsh home with the
 * PRODUCTION confined reader and sum each session's TOP-LEVEL data.usage
 * total (input + output; cache_read excluded). The gate-owned store starts
 * empty, so every session belongs to this canary (probe + all story rounds).
 */
function reconcileAllSessions(storeRoot: string): { sessions: SessionUsage[]; storeTotal: number } {
  if (!dshReader) throw new Error("dist dsh reader not loaded; call loadDshDistReader() first");
  const evRoot = fs.realpathSync(EVIDENCE_DIR);
  const real = fs.realpathSync(storeRoot);
  if (real !== evRoot && !real.startsWith(evRoot + path.sep)) {
    throw new Error(`refusing to read a dsh store outside the gate evidence root: ${storeRoot}`);
  }
  const sessionsRoot = path.join(storeRoot, "sessions");
  const sessions: SessionUsage[] = [];
  let storeTotal = 0;
  if (fs.existsSync(sessionsRoot)) {
    for (const project of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectDir = path.join(sessionsRoot, project.name);
      for (const entry of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
        const sessionDir = path.join(projectDir, entry.name);
        const discovered = dshReader.discover(sessionDir);
        assert.equal(
          discovered.problem,
          null,
          `session ${entry.name}: no unambiguous current v3 artifact: ${discovered.problem}`,
        );
        assert.ok(discovered.current, `session ${entry.name}: no current v3 artifact`);
        const artifact = path.join(sessionDir, discovered.current!);
        const read = dshReader.read({ artifactPath: artifact, admittedRoot: storeRoot });
        assert.equal(read.decode, "ok", `session ${entry.name} artifact decode: ${read.decode}`);
        assert.equal(read.usageIncomplete, false, `session ${entry.name} usage incomplete`);
        assert.ok(read.usageTokens !== null, `session ${entry.name} has no usage tokens`);
        const usageTokens = Number(read.usageTokens);
        sessions.push({ dir: sessionDir, artifact, usageTokens });
        storeTotal += usageTokens;
      }
    }
  }
  return { sessions, storeTotal };
}

// ── shared state ──────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let dshHome = "";
let originDir = "";
let originalBranch = "main";
let initialTree = "";
let ledgerPath = "";
let assertionsLedgerPath = "";
let observedVmIds: string[] = [];
let imageIdentity: { digest: string; config_digest: string } | null = null;

function writeEvidence(name: string, content: string): string {
  const p = path.join(EVIDENCE_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

function readTokensSpent(tamanduaDirArg: string, runId: string): number {
  const db = openE2eDatabase(path.join(tamanduaDirArg, "tamandua.db"));
  try {
    const row = db.prepare("SELECT tokens_spent FROM runs WHERE id = ?").get(runId) as
      | { tokens_spent: number | null }
      | undefined;
    assert.ok(row, `run ${runId} missing from DB`);
    return Number(row.tokens_spent ?? 0);
  } finally {
    db.close();
  }
}

async function pollTerminalWithNudge(
  runIdArg: string,
  envArg: Record<string, string>,
): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runIdArg], {
      env: cleanChildEnv(envArg),
      encoding: "utf-8",
    });
    const out = result.stdout || result.stderr || "";
    const m = out.match(/^Status:\s+(\S+)/m);
    if (m) {
      lastStatus = m[1];
      if (["completed", "done", "failed", "canceled"].includes(lastStatus)) return lastStatus;
    }
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: cleanChildEnv(envArg),
      encoding: "utf-8",
    });
    await sleep(DEFAULT_POLL_MS);
  }
  let tail = "";
  try {
    const eventsPath = path.join(tamanduaDir, "events", `${runIdArg}.jsonl`);
    const lines = fs.readFileSync(eventsPath, "utf-8").trimEnd().split("\n");
    tail = lines.slice(-30).join("\n");
  } catch {
    /* ignore */
  }
  throw new Error(
    `timeout after ${RUN_TIMEOUT_MS}ms waiting for terminal status; last=${lastStatus || "(none)"}\n${tail}`,
  );
}

/**
 * Copy the operator's real dsh credentials + profiles into a fresh gate-owned
 * DSH_HOME (never `sessions/`, so the attributed store starts empty). Uses
 * `cp -a` so symlinked profile modules (including dangling host links) are
 * preserved verbatim. Credentials are copied, never printed.
 */
function stageOperatorDshHome(srcHome: string, dstHome: string): void {
  fs.mkdirSync(dstHome, { recursive: true });
  for (const file of [".credentials.yaml", ".anonymous-user-id"]) {
    const from = path.join(srcHome, file);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dstHome, file));
  }
  const profiles = path.join(srcHome, "profiles");
  assert.ok(fs.existsSync(profiles), `operator dsh profiles missing at ${profiles}`);
  const cp = spawnSync("cp", ["-a", `${profiles}/.`, path.join(dstHome, "profiles")], {
    encoding: "utf-8",
  });
  assert.equal(cp.status, 0, `staging operator dsh profiles failed: ${cp.stderr}`);
  fs.mkdirSync(path.join(dstHome, "sessions"), { recursive: true });
}

/** Best-effort restore of the shared short-HOME alias to the operator home. */
function restoreSharedHomeAlias(): void {
  try {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    const alias = path.join("/tmp", "tamandua", String(uid), "h");
    if (!fs.existsSync(alias) && !fs.lstatSync(alias, { throwIfNoEntry: false })) return;
    const target = fs.readlinkSync(alias);
    const realHome = path.dirname(REAL_DSH_HOME);
    if (target === realHome) return;
    if (!target.startsWith(EVIDENCE_DIR)) return; // not ours — leave it alone
    fs.rmSync(alias, { force: true });
    fs.symlinkSync(realHome, alias);
  } catch {
    /* best-effort hygiene only */
  }
}

// ────────────────────────────────────────────────────────────────────────
// Injected failure controls (no real VM), run BEFORE the actual-VM path.
// ────────────────────────────────────────────────────────────────────────
describe("matchlock dsh merge-worktree canary injected failure controls (mock/no real VM)", { concurrency: 1 }, () => {
  let ctrlRoot = "";

  before(() => {
    ctrlRoot = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "mtlk-dsh-canary-controls-"));
  });

  after(() => {
    try {
      fs.rmSync(ctrlRoot, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("a corrupt state DB throws from the strict inventory reader", () => {
    const home = fabricateVmHome(ctrlRoot, { db: "corrupt" });
    assert.throws(() => readVmInventory(home), /unreadable\/corrupt/);
  });

  it("readRunEvents treats corrupt event JSON as an error", () => {
    const home = fs.mkdtempSync(path.join(ctrlRoot, "events-"));
    const eventsDir = path.join(home, ".tamandua", "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(path.join(eventsDir, "corrupt.jsonl"), "not-json\n", "utf-8");
    assert.throws(() => readRunEvents(path.join(home, ".tamandua"), "corrupt"), /corrupt event JSON/);
  });

  it("absent state with observed VM ids fails cleanup and writes the ledger", () => {
    const home = fabricateVmHome(ctrlRoot, { db: "absent" });
    const ledger = path.join(ctrlRoot, "absent-ledger.txt");
    assert.throws(
      () =>
        cleanupOwnedVms(home, ledger, ["vm-11223344"], {
          rpcBin: path.join(ctrlRoot, "no-rm"),
        }),
      /state DB missing|state DB is MISSING|state DB missing after/i,
    );
    assert.ok(fs.existsSync(ledger), "ledger written on failure");
  });

  it("a failed exact-id close retains state and records every outcome", () => {
    const home = fabricateVmHome(ctrlRoot, { db: "rows", dirs: true });
    const fakeRm = path.join(ctrlRoot, "rm-fail");
    makeFakeMatchlock(fakeRm, "fail");
    const ledger = path.join(ctrlRoot, "fail-ledger.txt");
    assert.throws(
      () => cleanupOwnedVms(home, ledger, ["vm-11223344"], { rpcBin: fakeRm }),
      /failed to close cleanly/,
    );
    assert.ok(
      fs.existsSync(path.join(home, ".matchlock", "vms", "vm-11223344")),
      "state retained after failed close",
    );
    assert.match(fs.readFileSync(ledger, "utf-8"), /NOT cleanly closed/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// The real-VM real-token canary.
// ────────────────────────────────────────────────────────────────────────

async function runCanaryScenario(): Promise<void> {
  let daemon: ChildProcess | null = null;
  let portHandles: PortHandle[] = [];
  let controlPort = 0;
  let runId = "";
  try {
    portHandles = await reservePortHandles(1);
    controlPort = portHandles[0].port;
    fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
    const scenarioEnv = gateEnv(homeDir, controlPort, dshHome);
    await releasePortReservations({ portHandles });
    portHandles = [];

    daemon = await startIsolatedDaemon(homeDir, controlPort, scenarioEnv);
    try {
      const prefix = await spawnWorkflowRun(
        [
          "workflow",
          "run",
          WORKFLOW_ID,
          TASK,
          "--matchlock",
          BEDLAM_TAG,
          "--dsh-as-harness",
          "--worktree-origin-repository",
          originDir,
          "--worktree-origin-ref",
          originalBranch,
        ],
        scenarioEnv,
        120_000,
      );
      runId = resolveFullRunId(prefix, tamanduaDir);
      const status = await pollTerminalWithNudge(runId, scenarioEnv);
      assert.equal(status, "completed", `dsh canary run must complete; got ${status}`);
      await sleep(1_000);

      // ── no-fallback / lifecycle assertions ───────────────────────
      const events = readRunEvents(tamanduaDir, runId);
      const counts = new Map<string, number>();
      for (const e of events) {
        const name = String((e as { event?: unknown }).event ?? "");
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      assert.ok(
        (counts.get("run.completed") ?? 0) === 1,
        `expected exactly one run.completed event (${[...counts.entries()]
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")})`,
      );
      for (const bad of [
        "run.matchlock_dispatch_refused",
        "run.matchlock_invocation_infra_failed",
        "run.harness_probe_failed",
        "run.instant_fail_loop",
        "run.failed",
      ]) {
        assert.equal(counts.get(bad) ?? 0, 0, `unexpected ${bad} event`);
      }
      assert.ok(
        (counts.get("merge.landed") ?? 0) >= 1,
        `expected a real merge.landed event on the owned origin (events: ${[...counts.entries()]
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")})`,
      );

      // ── real squash landed on the OWNED origin ───────────────────
      const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
      let mergedTree = "";
      let finalizeOutput = "";
      try {
        const rows = db
          .prepare(
            "SELECT step_id, agent_id, status, output FROM steps WHERE run_id = ? ORDER BY step_index, rowid",
          )
          .all(runId) as Array<{
          step_id: string;
          agent_id: string;
          status: string;
          output: string | null;
        }>;
        assert.ok(rows.length >= 6, `expected the full step set, got ${rows.length}`);
        for (const row of rows) {
          assert.equal(
            row.status,
            "done",
            `step ${row.step_id} (${row.agent_id}) not done (status=${row.status})`,
          );
          if (row.step_id === "finalize_merge") {
            finalizeOutput = row.output ?? "";
            mergedTree = extractKey(finalizeOutput, "MERGED_TREE") || "";
          }
        }
      } finally {
        db.close();
      }
      assert.match(
        finalizeOutput,
        /^STATUS: done$/m,
        `finalizer did not accept the landing (no STATUS: done):\n${finalizeOutput}`,
      );
      assert.match(mergedTree, /^[0-9a-f]{40,64}$/, `MERGED_TREE missing/invalid (${mergedTree})`);
      const targetTip = git(["rev-parse", `refs/heads/${originalBranch}`], originDir);
      const targetTree = git(["rev-parse", `refs/heads/${originalBranch}^{tree}`], originDir);
      assert.notEqual(targetTree, initialTree, "the owned origin target tree must have advanced");
      assert.equal(targetTree, mergedTree, "origin target tree must equal the merged (tested) tree");
      assert.notEqual(targetTip, "", "target ref must resolve after landing");

      // ── token reconciliation: positive per-round attribution ─────
      const tokensSpent = readTokensSpent(tamanduaDir, runId);
      assert.ok(tokensSpent > 0, `runs.tokens_spent must be > 0 (got ${tokensSpent})`);
      const store = reconcileAllSessions(dshHome);
      assert.ok(
        store.sessions.length > 0,
        `the mapped v3 store must contain at least one session (${path.join(dshHome, "sessions")})`,
      );
      for (const s of store.sessions) {
        assert.ok(s.usageTokens > 0, `session ${s.dir} has non-positive usage (${s.usageTokens})`);
      }
      assert.equal(
        tokensSpent,
        store.storeTotal,
        `runs.tokens_spent (${tokensSpent}) must equal the v3 store total ` +
          `(${store.storeTotal}) under input+output / cache_read-excluded (tolerance 0); ` +
          `sessions=${JSON.stringify(store.sessions)}`,
      );

      // ── fresh VM per invocation + positive cleanup ───────────────
      const vmIds = readRunnerVmEvidenceIds(path.join(tamanduaDir, "runs"), runId);
      observedVmIds.push(...vmIds);
      const distinct = new Set(vmIds);
      assert.ok(
        distinct.size >= 6,
        `expected >= 6 distinct fresh VMs (probe + story/merge roles), got ${distinct.size}: ${[...distinct].join(",")}`,
      );
      assert.equal(vmIds.length, distinct.size, "VM ids must never repeat (fresh VM per invocation)");

      writeEvidence(
        "canary-receipts.json",
        JSON.stringify(
          {
            workflowId: WORKFLOW_ID,
            harness: "dsh",
            image: { tag: BEDLAM_TAG, ...imageIdentity },
            runId,
            status,
            mergedTree,
            originTargetTree: targetTree,
            initialOriginTree: initialTree,
            runsTokensSpent: tokensSpent,
            v3StoreTotal: store.storeTotal,
            sessions: store.sessions.map((s) => ({ dir: s.dir, usageTokens: s.usageTokens })),
            policy: "input+output, cache_read excluded, tolerance 0",
            matched: tokensSpent === store.storeTotal,
            freshVms: vmIds.length,
            distinctVms: distinct.size,
            vms: [...distinct].sort(),
          },
          null,
          2,
        ),
      );
      console.log(
        `[matchlock-dsh-merge-worktree-canary] OK run=${runId} mergedTree=${mergedTree} ` +
          `tokens=${tokensSpent} storeTotal=${store.storeTotal} rounds=${store.sessions.length} ` +
          `vms=${vmIds.length} distinct=${distinct.size}`,
      );
    } finally {
      if (daemon) {
        await stopIsolatedDaemon(daemon);
      }
      daemon = null;
    }

    // ── empty positive-owned-VM inventory (runner already closed) ─
    assertNoOwnedVms(homeDir, "dsh canary post-run", {
      pollTimeoutMs: 120_000,
      rpcBin: MATCHLOCK_RPC_BIN,
      ledgerPath: assertionsLedgerPath,
    });
    const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, {
      rpcBin: MATCHLOCK_RPC_BIN,
    });
    assert.ok(fs.existsSync(ledgerPath), `vm cleanup ledger missing at ${ledgerPath}`);
    assert.ok(
      ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
      "cleanup ledger must record completion with no leftovers",
    );
    assert.equal(readVmInventory(homeDir).rows.length, 0, "no VM rows may remain after cleanup");
  } finally {
    if (daemon) {
      try {
        await stopIsolatedDaemon(daemon);
      } catch {
        /* best-effort */
      }
      daemon = null;
    }
    await releasePortReservations({ portHandles }).catch(() => {});
    portHandles = [];
  }
}

// The real-VM scenario is opt-in: without the runner-provided environment a
// bare `node --test` of this file still runs the fast injected-failure controls
// above (green, no VM) while the real-VM describe is skipped.
const REAL_VM_CANARY_ENABLED =
  EVIDENCE_DIR.length > 0 && MATCHLOCK_RPC_BIN.length > 0 && REAL_DSH_HOME.length > 0;
const realCanaryDescribe = REAL_VM_CANARY_ENABLED ? describe : describe.skip;

realCanaryDescribe(
  "matchlock dsh merge-worktree real canary: real feature-dev-merge-worktree in fresh VMs (REAL tokens)",
  { concurrency: 1, timeout: 120 * 60_000 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      homeDir = path.join(EVIDENCE_DIR, "home");
      tamanduaDir = path.join(homeDir, ".tamandua");
      process.env.HOME = homeDir;
      process.env.TAMANDUA_STATE_DIR = tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
      process.env.TAMANDUA_WORKTREE_ROOT = path.join(tamanduaDir, "worktrees");
      process.env.TAMANDUA_MATCHLOCK_RPC_BIN = MATCHLOCK_RPC_BIN;
      process.env.MATCHLOCK_GUEST_INIT = GUEST_INIT;
      process.env.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;
      process.env.TAMANDUA_TEST_GUARD = "1";
      process.env.TMPDIR = path.join(EVIDENCE_DIR, "tmp");
      await loadDshDistReader();
      fs.mkdirSync(tamanduaDir, { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
      fs.mkdirSync(path.join(EVIDENCE_DIR, "tmp"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
        "utf-8",
      );
      fs.writeFileSync(path.join(tamanduaDir, "port"), "0", "utf-8");

      // Qualified kernel cache (copied; never mutate the operator's).
      const kernelSrc = path.join(OPERATOR_CACHE, "kernels");
      assert.ok(fs.existsSync(kernelSrc), `operator kernel cache missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), {
        recursive: true,
      });

      // Seed + resolve the REAL operator image in the private store.
      seedOperatorImageStore(OPERATOR_CACHE, homeDir);
      imageIdentity = resolveImage(BEDLAM_TAG, homeDir);
      console.log(
        `[matchlock-dsh-merge-worktree-canary] image ${BEDLAM_TAG} digest=${imageIdentity.digest} config=${imageIdentity.config_digest}`,
      );

      // Fresh gate-owned DSH_HOME carrying the operator's real credentials.
      dshHome = path.join(EVIDENCE_DIR, "dsh-home");
      stageOperatorDshHome(REAL_DSH_HOME, dshHome);

      const fixturesDir = path.join(EVIDENCE_DIR, "fixtures");
      fs.mkdirSync(fixturesDir, { recursive: true });
      originDir = path.join(fixturesDir, "owned-origin-feature-dev");
      const origin = prepareOwnedOrigin(originDir);
      originalBranch = origin.originalBranch;
      initialTree = origin.initialTree;

      const env = gateEnv(homeDir, 0, dshHome);
      cliMustSucceed(["workflow", "install", WORKFLOW_ID], env, `install ${WORKFLOW_ID}`);

      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");
      assertionsLedgerPath = path.join(EVIDENCE_DIR, "vm-no-owned-assertions.txt");
    });

    after(async () => {
      if (homeDir && MATCHLOCK_RPC_BIN) {
        try {
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds, { rpcBin: MATCHLOCK_RPC_BIN });
        } catch {
          /* best-effort; the scenario owns its positive assertions */
        }
      }
      restoreSharedHomeAlias();
    });

    it(
      "feature-dev-merge-worktree completes under the dsh Matchlock route with a real host landing and positive per-round token attribution",
      { timeout: 110 * 60_000 },
      async () => {
        await runCanaryScenario();
      },
    );
  },
);
