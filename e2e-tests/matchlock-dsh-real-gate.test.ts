/******************************************************************************
 * ⚠️  REAL-TOKEN REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MATCHLOCK-UNION-3 US-010 — Gate E: the DSV2-in-VM real gate.
 *
 * ONE real `do-now` through a real ISOLATED daemon → scheduler → Matchlock dsh
 * invocation runner → FRESH VMs, using the REAL operator image
 * `igorhvr/bedlam-ubuntu` (the matchlock-store image that ships dsh
 * 0.1.5-rc.2, hermes 0.21.3 and pi 0.85.1) with `--dsh-as-harness`. The guest
 * dsh makes REAL model calls against the operator's own dsh credential home
 * (mounted RW through the product's normal DSH_HOME mapping), so this gate
 * SPENDS REAL TOKENS.
 *
 * WHAT IT PROVES (the DSV2-in-VM seam end-to-end):
 *   - the run reaches real status "completed";
 *   - runs.tokens_spent > 0;
 *   - runs.tokens_spent === the v3 store total under the shared token policy
 *     (input + output, cache_read EXCLUDED), tolerance 0, where the v3 store
 *     total is read from the mapped host store
 *     <DSH_HOME>/sessions/<projectKey>/session-<id>/session.v3.jsonl.zstd with
 *     the PRODUCTION confined in-VM reader (dist dsh-session-store
 *     discoverSessionArtifacts + readDshSessionArtifact), decoding the
 *     concatenated multi-frame zstd container and summing TOP-LEVEL
 *     data.usage only (the data.stream mirror is never counted);
 *   - every VM the gate creates is positively closed and recorded in the
 *     exact-owned cleanup ledger.
 *
 * It is deliberately NOT part of any default fast lane (npm test /
 * run-all-smoke / run-all-scripted / run-all-e2e-tests). Run it on demand:
 *
 *   ./run-matchlock-dsh-real-gate-e2e-test
 *
 * which builds first, resolves and records the observed runtime identity, creates a
 * NEW never-reused evidence directory
 * <TAMANDUA_GATE_EVIDENCE_ROOT>/dsh-real-exec-<UTC-Z ts>/ (outside the repo)
 * and runs this file with a private isolated HOME/STATE/DB/TMPDIR rooted
 * INSIDE that evidence directory.
 *
 * SKIP RULE (never fake it): if the operator image's dsh cannot reach the
 * provider API from the VM, the gate records the bounded observed failure and
 * fails — the coordinator then records the documented skip with the reason.
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
  assertObservedRoundsNonZero,
  writeObservedRoundsEvidence,
} from "./helpers/matchlock-gate-rounds.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

// ── environment: resolved (unpinned) paired runtime + operator sources ─────────────────
// The runner script (run-matchlock-dsh-real-gate-e2e-test) resolves these (or leaves guest-init to
// matchlock) before launching this file; the test only requires any resolved
// paths to exist.
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

// The REAL operator image (never a synthetic fixture). The matchlock store copy
// of this tag is the qualified toolchain image; the plain docker tag is NOT.
const BEDLAM_TAG = "igorhvr/bedlam-ubuntu";

// Evidence root + operator sources supplied by the runner (kanonical
// /home/kaladin/... spelling). TAMANDUA_GATE_REAL_DSH_HOME is the operator's
// real dsh home (credentials + profiles) — its `sessions/` is intentionally
// NEVER copied so the attributed store starts empty.
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";

// Observed-rounds evidence label (TESTER-HONESTY item 3): the runner passes the
// same label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "dsh-real";

const OPERATOR_CACHE =
  process.env.TAMANDUA_GATE_OPERATOR_CACHE ??
  process.env.TAMANDUA_GATE_FIXTURE_IMAGE_CACHE ??
  "";
const REAL_DSH_HOME = process.env.TAMANDUA_GATE_REAL_DSH_HOME ?? "";

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 30 * 60_000;

const TASK =
  "Gate E DSV2-in-VM check: print the current working directory, do not " +
  "modify any files or run any commands other than the tamandua step " +
  "commands you are instructed to use, and report success.";

// MTLK-UNPIN: the paired runtime is resolved (not pinned). The resolved CLI
// is always exported; the guest-init/fused vars are exported only when the
// driver resolved them, so an unset value lets matchlock resolve it itself.
function matchlockRuntimeEnv(): Record<string, string> {
  const env: Record<string, string> = { TAMANDUA_MATCHLOCK_RPC_BIN: MATCHLOCK_RPC_BIN };
  if (GUEST_INIT.length > 0) env.MATCHLOCK_GUEST_INIT = GUEST_INIT;
  if (GUEST_FUSED.length > 0) env.MATCHLOCK_GUEST_FUSED = GUEST_FUSED;
  return env;
}

function assertEnv(): void {
  assert.ok(
    EVIDENCE_DIR.length > 0,
    "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-dsh-real-gate-e2e-test)",
  );
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set (the gate driver resolves matchlock from PATH)");
  // Guest-init/fused are OPTIONAL (MTLK-UNPIN): when unset, matchlock resolves
  // them itself and the gate records whatever it observes.
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    if (p.length > 0) {
      assert.ok(fs.existsSync(p), `resolved runtime binary missing: ${p}`);
    }
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
  extra: Record<string, string> = {},
): Record<string, string> {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  const env: Record<string, string> = {
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
    ...matchlockRuntimeEnv(),
    // The frozen submission DSH_HOME the product mounts RW at
    // /workspace/config/dsh: our fresh copy of the operator's credentials +
    // profiles. `sessions/` starts absent so attribution has a clean ledger.
    DSH_HOME: dshHome,
  };
  return { ...env, ...extra };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Fresh small git repo (clean tracked tree) for the one real run. */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# Gate E DSV2-in-VM fixture\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock DSV2 Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

// ── operator matchlock image-store seeding ─────────────────────────────────

/**
 * Seed the private matchlock image store from the operator's store via
 * HARDLINKED content-addressed blobs + copied metadata (the established
 * dev-speed seam). The REAL qualified `igorhvr/bedlam-ubuntu` image exists
 * ONLY in the operator matchlock store; the plain docker tag is a different,
 * tool-less image. Never mutates the operator store: blobs are hardlinked
 * (read-only, content-addressed) and metadata is copied.
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
      // Cross-device evidence roots cannot hardlink; fall back to a real copy
      // (reflink where supported, so still cheap on CoW filesystems).
      const copied = spawnSync("cp", ["-a", "--reflink=auto", srcBlobs, path.join(dst, "blobs")], {
        encoding: "utf-8",
      });
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

function resolveImage(tag: string, homeDir: string): { digest: string; config_digest: string } {
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

// ── strict VM inventory + cleanup (never inventory-error-to-empty) ────────

function readVmIds(homeDir: string): string[] {
  const stateDb = path.join(homeDir, ".matchlock", "state.db");
  if (!fs.existsSync(stateDb)) return [];
  const db = openE2eDatabase(stateDb);
  try {
    const rows = db.prepare("SELECT id FROM vms ORDER BY created_at").all() as Array<{ id: string }>;
    return rows.map((r) => r.id).filter((id) => /^vm-[0-9a-f]{8}$/.test(id));
  } catch (err) {
    throw new Error(`VM inventory read failed (state DB ${stateDb}): ${String(err)}`);
  } finally {
    db.close();
  }
}

/**
 * Positively dispose every VM this gate owns. Any id still present in the
 * matchlock state DB or under $HOME/.matchlock/vms gets an exact-id
 * `matchlock rm`, recorded in the ledger. A failed rm that leaves a state dir
 * is NEVER swept with a recursive delete — it is recorded and throws.
 */
function cleanupOwnedVms(homeDir: string, ledgerPath: string, observedIds: string[]): string[] {
  const ledger: string[] = [];
  const clean = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
  const rowIds = readVmIds(homeDir);
  const vmsDir = path.join(homeDir, ".matchlock", "vms");
  let dirIds: string[] = [];
  if (fs.existsSync(vmsDir)) {
    dirIds = fs
      .readdirSync(vmsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^vm-[0-9a-f]{8}$/.test(e.name))
      .map((e) => e.name);
  }
  const rowIdSet = new Set(rowIds);
  const dirIdSet = new Set(dirIds);
  const target = [...new Set([...rowIds, ...dirIds, ...observedIds])].sort();
  ledger.push(
    `${new Date().toISOString()} VM ids observed during the gate (${observedIds.length}): ${
      observedIds.length > 0 ? observedIds.join(",") : "(none)"
    }`,
  );
  ledger.push(
    `${new Date().toISOString()} VM ids still present at cleanup (rows=${rowIds.length}, dirs=${dirIds.length}): ${
      target.length > 0 ? target.join(",") : "(none — runner positively closed every owned VM)"
    }`,
  );
  for (const id of target) {
    const stateDir = path.join(vmsDir, id);
    if (!rowIdSet.has(id) && !dirIdSet.has(id)) {
      ledger.push(`${new Date().toISOString()} vm ${id} already positively closed by the runner`);
      continue;
    }
    const rm = spawnSync(MATCHLOCK_RPC_BIN, ["rm", id], { encoding: "utf-8", env: clean });
    ledger.push(
      `${new Date().toISOString()} vm ${id} rm rc=${rm.status} out=${(rm.stdout || rm.stderr || "").trim()}`,
    );
    if (rm.status !== 0 && fs.existsSync(stateDir)) {
      ledger.push(
        `${new Date().toISOString()} vm ${id} STATE DIR STILL PRESENT after exact-id rm (rc=${rm.status})`,
      );
      throw new Error(
        `vm ${id} state dir still present after exact-id cleanup (rm rc=${rm.status}): ${(rm.stderr || "").trim()}`,
      );
    }
    if (fs.existsSync(stateDir)) {
      ledger.push(`${new Date().toISOString()} vm ${id} STATE DIR STILL PRESENT after cleanup`);
      throw new Error(`vm ${id} state dir still present after exact-id cleanup`);
    }
  }
  const leftoverRows = readVmIds(homeDir);
  if (leftoverRows.length > 0) {
    ledger.push(`${new Date().toISOString()} LEFTOVER VM ROWS after cleanup: ${leftoverRows.join(",")}`);
    throw new Error(`leftover VM rows after cleanup: ${leftoverRows.join(",")}`);
  }
  ledger.push(`${new Date().toISOString()} cleanup complete: no owned VM rows/state dirs remain`);
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  const prior = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf-8") : "";
  fs.writeFileSync(ledgerPath, `${prior}${ledger.join("\n")}\n`, "utf-8");
  return ledger;
}

// ── events / store helpers ────────────────────────────────────────────────

/** Strict event reader: a corrupt JSON line is an ERROR (never silent {}). */
function readRunEvents(tamanduaDir: string, runId: string): Array<Record<string, unknown>> {
  const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  return fs
    .readFileSync(eventsPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch (err) {
        throw new Error(`run events file ${eventsPath} has a corrupt JSON line: ${String(err)}`);
      }
    });
}

function readTokensSpent(tamanduaDir: string, runId: string): number {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
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

/** Byte-identical to src/installer/matchlock/dsh-session-store.ts matchlockProjectKey. */
function matchlockProjectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}

/** Session dir listing under one mapped dsh home for one workdir project key. */
function sessionDirs(storeRoot: string, workdir: string): string[] {
  const projectDir = path.join(storeRoot, "sessions", matchlockProjectKey(workdir));
  if (!fs.existsSync(projectDir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith("session-")) out.push(e.name);
  }
  return out.sort();
}

interface DshReader {
  discover: (dirPath: string) => { current: string | null; encoding: string | null; problem: string | null };
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

interface StoreReconciliation {
  storeRoot: string;
  projectDir: string;
  projectKey: string;
  sessions: Array<{ dir: string; artifact: string; usageTokens: number }>;
  storeTotal: number;
}

/**
 * Read the mapped host v3 store with the PRODUCTION confined reader and sum
 * every session's TOP-LEVEL data.usage total (input + output; cache_read
 * excluded). The read is confined to the gate evidence root.
 */
function reconcileStore(storeRoot: string, workdir: string): StoreReconciliation {
  if (!dshReader) throw new Error("dist dsh reader not loaded; call loadDshDistReader() first");
  const key = matchlockProjectKey(workdir);
  const projectDir = path.join(storeRoot, "sessions", key);
  const evRoot = fs.realpathSync(EVIDENCE_DIR);
  const real = fs.realpathSync(storeRoot);
  if (real !== evRoot && !real.startsWith(evRoot + path.sep)) {
    throw new Error(`refusing to read a dsh store outside the gate evidence root: ${storeRoot}`);
  }
  const sessions: StoreReconciliation["sessions"] = [];
  let storeTotal = 0;
  for (const dir of sessionDirs(storeRoot, workdir)) {
    const discovered = dshReader.discover(path.join(projectDir, dir));
    assert.equal(
      discovered.problem,
      null,
      `session ${dir}: no unambiguous current v3 artifact: ${discovered.problem}`,
    );
    assert.ok(discovered.current, `session ${dir}: no current v3 artifact`);
    const artifact = path.join(projectDir, dir, discovered.current!);
    const read = dshReader.read({ artifactPath: artifact, admittedRoot: storeRoot });
    assert.equal(read.decode, "ok", `session ${dir} artifact decode: ${read.decode}`);
    assert.equal(read.usageIncomplete, false, `session ${dir} usage incomplete`);
    assert.ok(read.usageTokens !== null, `session ${dir} has no usage tokens`);
    const usageTokens = Number(read.usageTokens);
    sessions.push({ dir, artifact, usageTokens });
    storeTotal += usageTokens;
  }
  return { storeRoot, projectDir, projectKey: key, sessions, storeTotal };
}

// ── shared state ──────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let dshHome = "";
let fixtureRepo = "";
let env: Record<string, string> = {};
let daemon: ChildProcess | null = null;
let controlPort = 0;
let portHandles: PortHandle[] = [];
let ledgerPath = "";
let observedVmIds: string[] = [];
let runId = "";
let imageIdentity: { digest: string; config_digest: string } | null = null;

function writeEvidence(name: string, content: string): string {
  const p = path.join(EVIDENCE_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

async function pollTerminalWithNudge(label: string): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
    // Capture transient VM ids while the run dispatches (rows vanish on close).
    try {
      for (const id of readVmIds(homeDir)) {
        if (!observedVmIds.includes(id)) observedVmIds.push(id);
      }
    } catch {
      /* transient inventory read — retried next tick */
    }
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });
    const out = result.stdout || result.stderr || "";
    const m = out.match(/^Status:\s+(\S+)/m);
    if (m) {
      lastStatus = m[1];
      if (["completed", "done", "failed", "canceled"].includes(lastStatus)) return lastStatus;
    }
    spawnSync(process.execPath, [cliPath, "nudge"], { env: cleanChildEnv(env), encoding: "utf-8" });
    await sleep(DEFAULT_POLL_MS);
  }
  const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  let tail = "";
  try {
    const lines = fs.readFileSync(eventsPath, "utf-8").trimEnd().split("\n");
    tail = lines.slice(-30).join("\n");
  } catch {
    /* ignore */
  }
  throw new Error(
    `[${label}] timeout after ${RUN_TIMEOUT_MS}ms waiting for terminal status; last=${lastStatus || "(none)"}\n${tail}`,
  );
}

/**
 * Copy the operator's real dsh credentials + profiles into a fresh gate-owned
 * DSH_HOME (never `sessions/`, so the attributed store starts empty). Uses
 * `cp -a` so symlinked profile modules (including dangling host links) are
 * preserved verbatim; the guest dsh profile loader repairs mismatches inside
 * the VM, exactly as the qualified path allows.
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

describe(
  "matchlock DSV2-in-VM real gate: one real do-now through isolated daemon → fresh VMs reconciles the v3 store (REAL tokens)",
  { concurrency: 1, timeout: 90 * 60_000 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      homeDir = path.join(EVIDENCE_DIR, "home");
      tamanduaDir = path.join(homeDir, ".tamandua");
      // Pin this process to the private state/db BEFORE the lazy dist import.
      process.env.HOME = homeDir;
      process.env.TAMANDUA_STATE_DIR = tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
      process.env.TAMANDUA_WORKTREE_ROOT = path.join(tamanduaDir, "worktrees");
      Object.assign(process.env, matchlockRuntimeEnv());
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
        `[matchlock-dsh-real-gate] image ${BEDLAM_TAG} digest=${imageIdentity.digest} config=${imageIdentity.config_digest}`,
      );

      // Fresh gate-owned DSH_HOME carrying the operator's real credentials.
      dshHome = path.join(EVIDENCE_DIR, "dsh-home");
      stageOperatorDshHome(REAL_DSH_HOME, dshHome);

      fixtureRepo = prepareFixtureRepo(path.join(EVIDENCE_DIR, "fixtures", "dsh-real-repo"));

      portHandles = await reservePortHandles(1);
      controlPort = portHandles[0].port;
      fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
      env = gateEnv(homeDir, controlPort, dshHome);

      cliMustSucceed(["workflow", "install", "do-now"], env, "install do-now workflow");
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");
    });

    after(async () => {
      try {
        if (daemon) await stopIsolatedDaemon(daemon);
      } catch {
        /* best-effort */
      }
      daemon = null;
      if (homeDir) {
        try {
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        } catch {
          /* best-effort on failure paths; the test body owns assertions */
        }
      }
      restoreSharedHomeAlias();
      await releasePortReservations({ portHandles }).catch(() => {});
      portHandles = [];
      // ── observed-rounds honesty (TESTER-HONESTY item 3) ─────────────
      // Record the distinct in-VM rounds this gate ACTUALLY observed and
      // refuse to certify a zero-round run (VM creation/probe failed before
      // any round) even if the node --test assertions above were bypassed.
      const observedRounds = new Set(observedVmIds).size;
      if (EVIDENCE_DIR.length > 0) {
        writeObservedRoundsEvidence(EVIDENCE_DIR, {
          gate: GATE_LABEL,
          observed_rounds: observedRounds,
          observed_vm_ids: observedVmIds,
          detail: `${GATE_LABEL}: ${observedRounds} distinct in-VM rounds observed`,
        });
      }
      assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
    });

    it(
      "one real do-now completes and runs.tokens_spent === the v3 store total (tolerance 0)",
      { timeout: 60 * 60_000 },
      async () => {
        await releasePortReservations({ portHandles });
        portHandles = [];
        daemon = await startIsolatedDaemon(homeDir, controlPort, env);

        try {
          const prefix = await spawnWorkflowRun(
            [
              "workflow",
              "run",
              "do-now",
              TASK,
              "--working-directory-for-harness",
              fixtureRepo,
              "--matchlock",
              BEDLAM_TAG,
              "--dsh-as-harness",
            ],
            env,
            120_000,
          );
          runId = resolveFullRunId(prefix, tamanduaDir);
          const status = await pollTerminalWithNudge("do-now");
          assert.equal(status, "completed", `do-now must complete; got ${status}`);
          await sleep(1_000);

          // ── no-fallback / lifecycle assertions ───────────────────────
          const events = readRunEvents(tamanduaDir, runId);
          const byType = new Map<string, number>();
          for (const e of events) byType.set(String(e.event), (byType.get(String(e.event)) ?? 0) + 1);
          assert.ok(
            (byType.get("run.completed") ?? 0) === 1,
            `expected exactly one run.completed event (${[...byType.entries()]
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")})`,
          );
          assert.ok(
            (byType.get("run.harness_probe_ok") ?? 0) === 1,
            `expected exactly one run.harness_probe_ok (got ${byType.get("run.harness_probe_ok") ?? 0})`,
          );
          for (const bad of [
            "run.matchlock_dispatch_refused",
            "run.matchlock_invocation_infra_failed",
            "run.harness_probe_failed",
            "run.instant_fail_loop",
            "run.failed",
          ]) {
            assert.equal(byType.get(bad) ?? 0, 0, `unexpected ${bad} event`);
          }

          // ── token reconciliation (tolerance 0) ───────────────────────
          const tokensSpent = readTokensSpent(tamanduaDir, runId);
          assert.ok(tokensSpent > 0, `runs.tokens_spent must be > 0 (got ${tokensSpent})`);

          const store = reconcileStore(dshHome, fixtureRepo);
          assert.ok(
            store.sessions.length > 0,
            `the mapped v3 store must contain at least one session (${store.projectDir})`,
          );
          assert.equal(
            tokensSpent,
            store.storeTotal,
            `runs.tokens_spent (${tokensSpent}) must equal the v3 store total ` +
              `(${store.storeTotal}) under input+output / cache_read-excluded (tolerance 0); ` +
              `sessions=${JSON.stringify(store.sessions)}`,
          );

          // ── freshness / no-fallback on the VM set ────────────────────
          for (const id of readVmIds(homeDir)) {
            if (!observedVmIds.includes(id)) observedVmIds.push(id);
          }
          const distinct = new Set(observedVmIds);
          assert.ok(
            distinct.size >= 2,
            `expected >= 2 distinct fresh VMs (1 probe + 1 work), got ${distinct.size}: ${[...distinct].join(",")}`,
          );
          assert.equal(
            observedVmIds.length,
            distinct.size,
            "VM ids must never repeat (fresh VM per probe/work invocation)",
          );

          writeEvidence(
            "gate-e-reconciliation.json",
            JSON.stringify(
              {
                gate: "E",
                image: { tag: BEDLAM_TAG, ...imageIdentity },
                runId,
                runsTokensSpent: tokensSpent,
                mappedStoreRoot: store.storeRoot,
                mappedStoreProjectDir: store.projectDir,
                mappedStoreProjectKey: store.projectKey,
                v3StoreTotal: store.storeTotal,
                sessions: store.sessions,
                policy: "input+output, cache_read excluded, tolerance 0",
                matched: tokensSpent === store.storeTotal,
                distinctVms: [...distinct].sort(),
              },
              null,
              2,
            ),
          );
          console.log(
            `[matchlock-dsh-real-gate] Gate E OK run=${runId} runs.tokens_spent=${tokensSpent} ` +
              `v3StoreTotal=${store.storeTotal} matched=${tokensSpent === store.storeTotal} ` +
              `store=${store.projectDir} vms=${distinct.size}`,
          );
        } finally {
          try {
            if (daemon) await stopIsolatedDaemon(daemon);
          } finally {
            daemon = null;
          }
        }

        // Authoritative exact-owned VM teardown + ledger.
        const ledger = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        assert.ok(fs.existsSync(ledgerPath), `vm cleanup ledger missing at ${ledgerPath}`);
        assert.ok(
          ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
          "cleanup ledger must record completion with no leftovers",
        );
        assert.equal(readVmIds(homeDir).length, 0, "no VM rows may remain after exact-owned cleanup");
      },
    );
  },
);
