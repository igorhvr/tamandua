/******************************************************************************
 * ⚠️  WARNING: SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-HERMES-EXEC US-004 — the actual fresh-VM ZERO-MODEL synthetic
 * WHOLE-PATH Hermes gate.
 *
 * This gate drives the REAL daemon → scheduler → Matchlock Hermes invocation
 * runner → launch probe → work round → guest helper/test shim → step
 * claim/complete path end-to-end for BOTH supported --matchlock workflows
 * (do-now and do-review-do-verify) using a deterministic TEST-ONLY "fake
 * hermes" supplied by an explicitly test-only derived fixture image
 * (e2e-tests/hermes-fixture/, derived from igorhvr/bedlam-ubuntu). NO provider
 * credentials and NO model/network calls anywhere in the gate runtime.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand only:
 *
 *   ./run-hermes-synthetic-e2e-test
 *
 * which builds first, resolves the paired runtime binaries (unpinned)
 * (TAMANDUA_MATCHLOCK_RPC_BIN = the matchlock CLI resolved from PATH;
 * MATCHLOCK_GUEST_INIT / MATCHLOCK_GUEST_FUSED = optional guest-init
 * overrides), creates a NEW evidence
 * directory /root/matchlock-work/evidence/hermes-exec-<UTC-Z timestamp>/
 * (outside the repo; never pre-cleaned) and runs this file with a private
 * isolated HOME/STATE/DB rooted INSIDE that evidence directory.
 *
 * Whole-path per-run assertions:
 *   - the run reaches real status "completed";
 *   - the guest progress document persists at
 *     <state>/runs/<runId>/progress-resource/progress.txt;
 *   - typed step claims/completes flowed through the host broker into the real
 *     step DB (every step done with STATUS: done output);
 *   - the packed tamandua-test recorded an integer exit in [0,255] in the
 *     host-owned Matchlock suite SQLite store under the canonical namespace;
 *   - EVERY launch probe AND work round used its OWN fresh VM (distinct owned
 *     VM ids; no shared/reused VM);
 *   - the EXACT session id recovered from the authoritative stderr trailer for
 *     every invocation matches a sessions row in the SELECTED MAPPED store
 *     (per-invocation markers cross-checked against the host-side store), and
 *     runs.tokens_spent equals the exact projected totals
 *     (input+output+cache_write; probe 36, work 155 — cache_read excluded);
 *   - per-invocation teardown is verified and an exact owned-VM cleanup ledger
 *     with POSITIVE bounded teardown is recorded (cleanup failures propagate —
 *     never an inventory-error-to-empty-list certification of closure).
 *
 * Direct-runner config/persistence checks (real VMs, not mocks):
 *   - DEFAULT, NAMED and CUSTOM profile configurations of one admitted
 *     synthetic HERMES_HOME directory, each across ≥2 real fresh VMs, with
 *     SQLite/WAL session persistence retained across VMs;
 *   - SIMULTANEOUS use of the SAME admitted synthetic config directory by two
 *     real VMs (lock/DB/WAL outcomes retained; a concrete runtime locking
 *     dependency failure is PRESERVED as a precise published contract blocker,
 *     never a faked green).
 *
 * Negatives:
 *   - an image WITHOUT hermes (missing-harness) and an image variant with a
 *     NONSTANDARD image PATH both refuse with bounded diagnostics and never
 *     fake a success / never fall back to a host hermes; the old pi gate
 *     (e2e-tests/matchlock-synthetic-gate.test.ts) is never executed and its
 *     helpers are not copied.
 *****************************************************************************/

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanChildEnv, reservePortHandles } from "../tests/helpers/test-env.ts";
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
import type { PortHandle } from "../tests/helpers/test-env.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const cliPath = path.resolve(repoRoot, "dist", "cli", "cli.js");

// ── environment: resolved (unpinned) paired runtime ────────────────────────────────────
// The runner script (run-hermes-synthetic-e2e-test) resolves these (or leaves guest-init to
// matchlock) before launching this file; the test only requires any resolved
// paths to exist.
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED = process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

// Deterministic TEST-ONLY derived fixture image tags (never igorhvr/bedlam-ubuntu).
const FIXTURE_TAG = "tamandua-synthetic-hermes:gate-fixture";
const MISSING_TAG = "tamandua-synthetic-hermes:missing-harness";
const NONSTANDARD_PATH_TAG = "tamandua-synthetic-hermes:nonstandard-path";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "hermes-fixture");
const FIXTURE_DOCKERFILES: Array<[string, string]> = [
  ["Dockerfile.synthetic-hermes", FIXTURE_TAG],
  ["Dockerfile.synthetic-hermes-missing-harness", MISSING_TAG],
  ["Dockerfile.synthetic-hermes-nonstandard-path", NONSTANDARD_PATH_TAG],
];

// Evidence root: the runner exports TAMANDUA_GATE_EVIDENCE_DIR (a NEW
// /root/matchlock-work/evidence/hermes-exec-<UTC-Z timestamp>/ directory).
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";

// Observed-rounds evidence label (TESTER-HONESTY item 3): the runner passes the
// same label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "hermes-synthetic";

// Dev/test-speed seam (NOT the clean acceptance path): when set, the gate
// copies a pre-seeded matchlock image cache (<dir> = a prior run's
// <home>/.cache/matchlock/images) into its fresh private home instead of
// docker-build + docker-save + matchlock image-import. Images are
// content-addressed, so the resolved digests are identical; the clean path
// (unset) always docker-builds and imports fresh.
const FIXTURE_IMAGE_CACHE =
  process.env.TAMANDUA_GATE_FIXTURE_IMAGE_CACHE?.trim() || "";

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 25 * 60_000;

// Exact synthetic token totals per kind (input + output + cache_write ONLY;
// cache_read is deliberately present-but-excluded in the store rows).
const PROBE_TOKENS = 36; // 30 + 5 + 1
const WORK_TOKENS = 155; // 100 + 50 + 5
const CHAT_TOKENS = 93; // 70 + 20 + 3

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
  assert.ok(EVIDENCE_DIR.length > 0, "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-hermes-synthetic-e2e-test)");
  assert.ok(MATCHLOCK_RPC_BIN.length > 0, "TAMANDUA_MATCHLOCK_RPC_BIN must be set (the gate driver resolves matchlock from PATH)");
  // Guest-init/fused are OPTIONAL (MTLK-UNPIN): when unset, matchlock resolves
  // them itself and the gate records whatever it observes.
  for (const p of [MATCHLOCK_RPC_BIN, GUEST_INIT, GUEST_FUSED]) {
    if (p.length > 0) {
      assert.ok(fs.existsSync(p), `resolved runtime binary missing: ${p}`);
    }
  }
}

function gateEnv(
  homeDir: string,
  controlPort: number,
  extra: Record<string, string> = {},
): Record<string, string> {
  const tamanduaDir = path.join(homeDir, ".tamandua");
  return {
    ...inheritedProcessEnv(),
    HOME: homeDir,
    TAMANDUA_CONTROL_PORT: String(controlPort),
    TAMANDUA_STATE_DIR: tamanduaDir,
    TAMANDUA_DB_PATH: path.join(tamanduaDir, "tamandua.db"),
    TAMANDUA_WORKTREE_ROOT: path.join(tamanduaDir, "worktrees"),
    TAMANDUA_TEST_GUARD: "1",
    TAMANDUA_HARNESS_PROBE: "1",
    TAMANDUA_PI_BINARY: "/usr/bin/false",
    TAMANDUA_DSH_BINARY: "/usr/bin/false",
    ...matchlockRuntimeEnv(),
    ...extra,
  };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Prepare a fresh small git repo (clean tracked tree) for one synthetic run. */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# Synthetic hermes whole-path gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n.matchlock-synthetic-hermes/\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock Hermes Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

// ── docker → matchlock image plumbing ─────────────────────────────────────

function dockerBuild(dockerfile: string, tag: string): void {
  const b = spawnSync(
    "/usr/bin/docker", ["build", "-f", dockerfile, "-t", tag, "."],
    { cwd: FIXTURE_DOCKER_DIR, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(
    b.status,
    0,
    `docker build ${dockerfile} failed (exit ${b.status}, signal ${b.signal}, error ${
      b.error ? b.error.message : "none"
    }):\n${(b.stdout || "").slice(-4000)}\n${(b.stderr || "").slice(-4000)}`,
  );
}

/**
 * Stream `docker save <tag>` straight into `matchlock image import <tag>`
 * (never buffers the multi-GB tar in a spawnSync stdout).
 */
async function importImage(tag: string, homeDir: string): Promise<void> {
  const importEnv = cleanChildEnv({ ...inheritedProcessEnv(), HOME: homeDir });
  const save = spawn("/usr/bin/docker", ["save", tag], { stdio: ["ignore", "pipe", "pipe"] });
  const imp = spawn(MATCHLOCK_RPC_BIN, ["image", "import", tag], {
    stdio: ["pipe", "pipe", "pipe"],
    env: importEnv,
  });
  let saveErr = "";
  let impErr = "";
  save.stderr.on("data", (d) => (saveErr += d));
  imp.stderr.on("data", (d) => (impErr += d));
  save.stdout.pipe(imp.stdin);
  const saveCode = await new Promise<number | null>((res) => save.on("close", res));
  const impCode = await new Promise<number | null>((res) => imp.on("close", res));
  assert.equal(saveCode, 0, `docker save ${tag} failed: ${saveErr.slice(-2000)}`);
  assert.equal(
    impCode,
    0,
    `matchlock image import ${tag} failed: ${impErr.slice(-2000)}`,
  );
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

/** Read the image's declared config env PATH (evidence for the nonstandard-PATH negative). */
function imageDeclaredPath(tag: string): string {
  const r = spawnSync(
    process.execPath,
    ["-e", `
      const { spawnSync } = require("node:child_process");
      const tag = ${JSON.stringify(tag)};
      const out = spawnSync("/usr/bin/docker", ["image", "inspect", tag, "--format", "{{json .Config.Env}}"], { encoding: "utf-8" });
      process.stdout.write(out.stdout || out.stderr || "");
    `],
    { encoding: "utf-8" },
  );
  const text = (r.stdout || "").trim();
  try {
    const arr = JSON.parse(text) as string[];
    const p = arr.find((e) => e.startsWith("PATH="));
    return p ? p.slice("PATH=".length) : "";
  } catch {
    return text;
  }
}

/**
 * Seed a fresh private matchlock image store from a content-addressed fixture
 * cache. The multi-GB image blobs are HARDLINKED into the fresh home (same
 * inode — no extra disk; a copy fallback is used across filesystems), and the
 * small mutable metadata/tag files are COPIED so the fresh home owns its DB.
 * This is what makes the fixture cache seam disk-safe: the 4.8GB bedlam-based
 * positive blob is never duplicated per run.
 */
function seedImageCache(srcCacheDir: string, targetHomeDir: string): void {
  const srcImages = path.join(srcCacheDir, "images");
  assert.ok(fs.existsSync(srcImages), `TAMANDUA_GATE_FIXTURE_IMAGE_CACHE has no images dir: ${srcImages}`);
  const dstImages = path.join(targetHomeDir, ".cache", "matchlock", "images");
  fs.mkdirSync(path.join(dstImages, "blobs"), { recursive: true });
  const linkOrCopy = (src: string, dst: string): void => {
    try {
      fs.linkSync(src, dst);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        fs.rmSync(dst, { force: true });
        fs.linkSync(src, dst);
        return;
      }
      fs.copyFileSync(src, dst); // cross-device / hardlink-unsupported fallback
    }
  };
  const blobsSrc = path.join(srcImages, "blobs");
  if (fs.existsSync(blobsSrc)) {
    for (const name of fs.readdirSync(blobsSrc)) {
      linkOrCopy(path.join(blobsSrc, name), path.join(dstImages, "blobs", name));
    }
  }
  for (const name of fs.readdirSync(srcImages)) {
    if (name === "blobs") continue;
    const src = path.join(srcImages, name);
    const dst = path.join(dstImages, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      fs.cpSync(src, dst, { recursive: true });
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

// ── strict VM inventory + cleanup (never inventory-error-to-empty) ────────

/**
 * STRICT VM inventory reader. An ABSENT state DB is a distinct empty result;
 * an unreadable/corrupt state DB THROWS (an inventory error must never be
 * caught into an empty list and then certified as "clean").
 */
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

const OWNED_VM_ID_RE = /^vm-[0-9a-f]{8}$/;

/**
 * Live owned-VM inventory: the `vms` rows in the matchlock state DB AND the
 * `<home>/.matchlock/vms/<vm-id>` state dirs the runtime creates for an owned
 * VM. With the UNPINNED system runtime (matchlock 0.2.17) the runner
 * POSITIVELY CLOSES each VM as soon as its round ends, deleting the row and
 * the state dir — so an end-of-run read is empty even on a fully successful
 * path. The gate therefore samples this inventory WHILE the runs execute (see
 * the live receipts journal below): the ids observed alive during the run are
 * the authoritative "fresh VM per invocation" receipts, and the strict
 * exact-owned cleanup ledger separately proves each one was closed.
 */
function readVmInventory(homeDir: string): { rowIds: string[]; dirIds: string[]; dbPresent: boolean } {
  const stateDb = path.join(homeDir, ".matchlock", "state.db");
  const dbPresent = fs.existsSync(stateDb);
  let rowIds: string[] = [];
  if (dbPresent) {
    const db = openE2eDatabase(stateDb);
    try {
      const rows = db.prepare("SELECT id FROM vms ORDER BY created_at").all() as Array<{ id: string }>;
      rowIds = rows.map((r) => r.id).filter((id) => OWNED_VM_ID_RE.test(id));
    } catch (err) {
      throw new Error(`VM inventory read failed (state DB ${stateDb}): ${String(err)}`);
    } finally {
      db.close();
    }
  }
  const vmsDir = path.join(homeDir, ".matchlock", "vms");
  let dirIds: string[] = [];
  if (fs.existsSync(vmsDir)) {
    dirIds = fs
      .readdirSync(vmsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && OWNED_VM_ID_RE.test(e.name))
      .map((e) => e.name);
  }
  return { rowIds, dirIds, dbPresent };
}

interface VmReceiptsJournal {
  path: string;
  samples: number;
  firstSeen: Map<string, string>;
  lastSeen: Map<string, string>;
}

function startVmReceiptsJournal(evidenceDir: string, label: string): VmReceiptsJournal {
  return {
    path: path.join(evidenceDir, `vm-receipts-${label}.jsonl`),
    samples: 0,
    firstSeen: new Map(),
    lastSeen: new Map(),
  };
}

/** Sample the live inventory every poll; a corrupt DB THROWS (never silent). */
function sampleVmReceipts(journal: VmReceiptsJournal, homeDir: string): void {
  journal.samples += 1;
  const ts = new Date().toISOString();
  const lines: string[] = [];
  const inv = readVmInventory(homeDir);
  for (const id of [...inv.rowIds, ...inv.dirIds]) {
    if (!journal.firstSeen.has(id)) journal.firstSeen.set(id, ts);
    journal.lastSeen.set(id, ts);
    lines.push(`${ts} ${inv.rowIds.includes(id) ? "row" : "dir"} ${id}`);
  }
  if (lines.length > 0) {
    fs.appendFileSync(journal.path, lines.join("\n") + "\n", "utf-8");
  }
}

function finishVmReceiptsJournal(journal: VmReceiptsJournal): { distinct: number; ids: string[] } {
  const ids = [...journal.firstSeen.keys()].sort();
  const out = [
    `# vm receipts (${ids.length} distinct, ${journal.samples} samples)`,
    ...ids.map(
      (id) =>
        `${id} first=${journal.firstSeen.get(id)} last=${journal.lastSeen.get(id) ?? "(never removed during run)"}`,
    ),
  ].join("\n") + "\n";
  fs.appendFileSync(journal.path, out, "utf-8");
  return { distinct: ids.length, ids };
}

/**
 * Positively dispose every VM this gate owns. The runner's positive controller
 * close stops each VM; the runtime retains the row + state dir until an
 * exact-id `matchlock rm`, so this performs an exact-id rm for every observed /
 * row / state-dir id and records every outcome in the evidence ledger. Throws
 * on any cleanup failure or leftover (the wrapper must propagate cleanup
 * failure — closure is never certified by catching inventory errors into an
 * empty list).
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
    `${new Date().toISOString()} VM ids observed during the gate (${observedIds.length}): ${observedIds.length > 0 ? observedIds.join(",") : "(none)"}`,
  );
  ledger.push(
    `${new Date().toISOString()} VM ids still present at cleanup (rows=${rowIds.length}, dirs=${dirIds.length}): ${target.length > 0 ? target.join(",") : "(none — runner positively closed every owned VM)"}`,
  );
  for (const id of target) {
    const stateDir = path.join(vmsDir, id);
    if (!rowIdSet.has(id) && !dirIdSet.has(id)) {
      ledger.push(
        `${new Date().toISOString()} vm ${id} already positively closed by the runner (no row and no state dir)`,
      );
      continue;
    }
    const rm = spawnSync(MATCHLOCK_RPC_BIN, ["rm", id], {
      encoding: "utf-8",
      env: clean,
    });
    ledger.push(
      `${new Date().toISOString()} vm ${id} rm rc=${rm.status} out=${(rm.stdout || rm.stderr || "").trim()}`,
    );
    if (rm.status !== 0 && fs.existsSync(stateDir)) {
      // matchlock rm failed and the state dir remains: record + surface. NEVER
      // silently sweep the state dir (recursive rm) to mask a teardown failure.
      ledger.push(`${new Date().toISOString()} vm ${id} STATE DIR STILL PRESENT after exact-id rm (rc=${rm.status})`);
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
  fs.writeFileSync(ledgerPath, ledger.join("\n") + "\n", "utf-8");
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

/**
 * Read the synthetic sessions rows of a mapped store DIRECTORY on the host.
 * The gate only ever reads stores it created itself under its OWN evidence
 * root (guarded by realpath), never real/operator Hermes data and never for
 * the runner accounting path (the runner projects usage INSIDE the VM).
 */
function readSessionRows(storeDir: string): Array<{
  id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}> {
  const evRoot = fs.realpathSync(EVIDENCE_DIR);
  const real = fs.realpathSync(storeDir);
  if (real !== evRoot && !real.startsWith(evRoot + path.sep)) {
    throw new Error(`refusing to read a Hermes store outside the gate evidence root: ${storeDir}`);
  }
  const dbPath = path.join(storeDir, "state.db");
  if (!fs.existsSync(dbPath)) return [];
  const db = openE2eDatabase(dbPath);
  try {
    const rows = db
      .prepare("SELECT id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM sessions ORDER BY id")
      .all() as Array<{
        id: string;
        input_tokens: number | null;
        output_tokens: number | null;
        cache_read_tokens: number | null;
        cache_write_tokens: number | null;
      }>;
    return rows;
  } catch (err) {
    throw new Error(`store read failed at ${dbPath}: ${String(err)}`);
  } finally {
    db.close();
  }
}

function storeTotals(rows: Array<{ id: string; input_tokens: number | null; output_tokens: number | null; cache_write_tokens: number | null }>): {
  byId: Map<string, number>;
  probes: number;
  works: number;
  chats: number;
} {
  const byId = new Map<string, number>();
  let probes = 0;
  let works = 0;
  let chats = 0;
  for (const r of rows) {
    assert.ok(r.input_tokens !== null && r.output_tokens !== null && r.cache_write_tokens !== null, `NULL token column on session ${r.id}`);
    const total = Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_write_tokens);
    byId.set(r.id, total);
    if (total === PROBE_TOKENS) probes += 1;
    else if (total === WORK_TOKENS) works += 1;
    else if (total === CHAT_TOKENS) chats += 1;
  }
  return { byId, probes, works, chats };
}

function parseMarkerSessions(markerDir: string): Array<{ file: string; sessionId: string; kind: "probe" | "work"; runId: string }> {
  if (!fs.existsSync(markerDir)) return [];
  const out: Array<{ file: string; sessionId: string; kind: "probe" | "work"; runId: string }> = [];
  for (const f of fs.readdirSync(markerDir)) {
    if (!f.endsWith(".marker")) continue;
    const text = fs.readFileSync(path.join(markerDir, f), "utf-8");
    const sess = text.match(/session=(\S+)/);
    const run = text.match(/run=run-(\S+)/);
    assert.ok(sess, `marker ${f} has no session id: ${text}`);
    out.push({
      file: f,
      sessionId: sess![1],
      kind: f.startsWith("probe-") ? "probe" : "work",
      runId: run ? run[1] : "",
    });
  }
  return out;
}

// ── shared state ──────────────────────────────────────────────────────────
let homeDir = "";
let tamanduaDir = "";
let env: Record<string, string> = {};
let daemon: ChildProcess | null = null;
let controlPort = 0;
let portHandles: PortHandle[] = [];
let fixturesRoot = "";
let wdNow = "";
let wdReview = "";
let runNowId = "";
let runReviewId = "";
let ledgerPath = "";
let observedVmIds: string[] = [];
let fixtureIdentity: { digest: string; config_digest: string };
const imageIdentities = new Map<string, { digest: string; config_digest: string }>();

// Config farm: ONE admitted synthetic HERMES_HOME directory tree.
let hermesHomeRoot = "";

const EVIDENCE_FILES: string[] = [];

function writeEvidence(name: string, content: string): string {
  const p = path.join(EVIDENCE_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  EVIDENCE_FILES.push(p);
  return p;
}

/** Append one JSON record line (never throw — evidence is auxiliary). */
function appendEvidenceJsonl(name: string, obj: unknown): void {
  try {
    const p = path.join(EVIDENCE_DIR, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(obj) + "\n", "utf-8");
  } catch {
    /* best-effort */
  }
}

// ── direct runner imports (dist; built by the runner script first) ───────
// Lazy so module resolution happens only inside the gate (after npm run build).
let directImports: {
  runHermesInvocation: (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
  HostInvocationRegistry: new () => { admitInvocation(o: unknown): { ok: boolean }; revokeInvocation(id: string, r: string): void };
};

async function loadDirectImports(): Promise<void> {
  if (directImports) return;
  const hir = await import(
    `${repoRoot}/dist/installer/matchlock/hermes-invocation-runner.js`
  );
  const nsi = await import(
    `${repoRoot}/dist/installer/matchlock/native-step-invocations.js`
  );
  directImports = {
    runHermesInvocation: hir.runHermesInvocation,
    HostInvocationRegistry: nsi.HostInvocationRegistry,
  };
}

/**
 * Short-HOME alias for the DIRECT runner. Production dispatch resolves the
 * alias before every Matchlock round (home-alias.ts) so the control-process
 * HOME always fits Linux's 107-byte sun_path; a direct invocation passes
 * rpcEnv.HOME verbatim, so on a host whose canonical evidence root makes
 * `<evidence>/home` too long the same PRODUCT helper is applied here (never a
 * weakened assertion, never a hardcoded path). Mirrors the US-006 fix in
 * e2e-tests/matchlock-dsh-gate.test.ts.
 */
let controlHomeAliasMemo: ((realHome: string) => string) | undefined;
async function resolveControlHomeAlias(realHome: string): Promise<string> {
  if (!controlHomeAliasMemo) {
    const mod = await import(`${repoRoot}/dist/installer/matchlock/home-alias.js`);
    controlHomeAliasMemo = (rh) =>
      mod.resolveMatchlockHomeAlias({
        realHome: rh,
        env: { ...inheritedProcessEnv(), HOME: rh },
      });
  }
  return controlHomeAliasMemo(realHome);
}

interface DirectInvocationSpec {
  label: string;
  /** FROZEN submission env HERMES_HOME value (null = unset → ~/.hermes). */
  hermesHomeEnv: string | null;
  kind?: "probe" | "work";
  promptText?: string;
  /**
   * Bounded extra attempts for the deterministic persistence/concurrency
   * fixtures. The accepted runtime intermittently truncates a fast child's
   * final stdout frame; every attempt (including failures) is retained in
   * direct-invocations.jsonl, so a retry is disclosed, never hidden.
   */
  retries?: number;
  /** Fixture image tag (default: the positive synthetic-hermes fixture). */
  imageTag?: string;
}

interface DirectInvocationRecord {
  label: string;
  /** 0-based attempt index (retries are disclosed in evidence). */
  attempt?: number;
  ok: boolean;
  invocationId: string;
  vmId: string | null;
  sessionId: string | null;
  sessionSource: string | null;
  usageStatus: string;
  usageTokens: number | undefined;
  cleanupConfirmed: boolean | undefined;
  exitCode: number | null;
  signal?: string | null;
  timedOut?: boolean;
  error?: string;
  durationMs?: number;
  /** Bounded stderr tail (bounded diagnostics for the negatives). */
  stderrTail?: string;
  /** Bounded stdout preview. */
  outputPreview?: string;
  /** Bounded runner log lines (diagnostics for transient VM/exec failures). */
  logs?: string[];
  /** Bounded raw stdout/stderr artifact tails. */
  rawStdoutTail?: string;
  rawStderrTail?: string;
}

async function directInvocation(spec: DirectInvocationSpec): Promise<DirectInvocationRecord> {
  const attempts = (spec.retries ?? 0) + 1;
  let last: DirectInvocationRecord | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const rec = await directInvocationOnce(spec, attempt);
    last = rec;
    const exact =
      rec.ok &&
      rec.sessionId !== null &&
      rec.usageStatus === "ok" &&
      (rec.outputPreview ?? "").trim().length > 0;
    if (exact) return rec;
  }
  return last as DirectInvocationRecord;
}

async function directInvocationOnce(spec: DirectInvocationSpec, attempt: number): Promise<DirectInvocationRecord> {
  await loadDirectImports();
  const invocationId = randomUUID();
  const record: DirectInvocationRecord = {
    label: spec.label,
    attempt,
    ok: false,
    invocationId,
    vmId: null,
    sessionId: null,
    sessionSource: null,
    usageStatus: "missing",
    usageTokens: undefined,
    cleanupConfirmed: undefined,
    exitCode: null,
    logs: [],
  };
  const submission = {
    homeDir,
    cwd: tamanduaDir,
    env:
      spec.hermesHomeEnv !== null && spec.hermesHomeEnv !== undefined
        ? { HERMES_HOME: spec.hermesHomeEnv }
        : {},
  };
  try {
    // Build a production-shaped hermes policy (immutable image pin + exact
    // work scope) for the requested image. The Hermes CONFIG selection is
    // re-derived by the runner from the FROZEN submission env below (exactly
    // like production dispatch), so one policy shape serves every profile.
    const identity =
      imageIdentities.get(spec.imageTag ?? FIXTURE_TAG) ?? fixtureIdentity;
    const policy = await buildDirectPolicy(
      spec.imageTag ?? FIXTURE_TAG,
      identity,
    );
    const result = (await directImports.runHermesInvocation({
      policy,
      identity: {
        runId: randomUUID(),
        agentId: "do-now_doer",
        workflowId: "do-now",
        jobId: `job-${invocationId.slice(0, 8)}`,
        invocationId,
      },
      kind: spec.kind ?? "work",
      promptText: spec.promptText ?? "synthetic-hermes persistence chat fixture (not a work prompt)",
      workingDirectoryForHarness: wdNow,
      timeoutMs: 150_000,
      helperPackHostPath: await ensureGuestPackHostPath(),
      submission,
      mountAdmission: { home: homeDir, liveStateRoot: tamanduaDir },
      rpcEnv: {
        HOME: await resolveControlHomeAlias(homeDir),
        ...matchlockRuntimeEnv(),
        TAMANDUA_STATE_DIR: tamanduaDir,
      },
      createTimeoutMs: 240_000,
      readyTimeoutMs: 30_000,
      handshakeTimeoutMs: 90_000,
      serviceTimeoutMs: 180_000,
      closeTimeoutSeconds: 60,
      usageHelperTimeoutMs: 30_000,
      onLog: (level: string, msg: string, fields?: Record<string, unknown>) => {
        if ((record.logs?.length ?? 0) < 200) {
          record.logs?.push(`${level} ${msg}${fields ? " " + JSON.stringify(fields) : ""}`);
        }
      },
    })) as Record<string, unknown>;
    record.ok = true;
    record.vmId = (result.vmId as string | null) ?? null;
    record.sessionId = (result.sessionId as string | null) ?? null;
    record.sessionSource = (result.sessionSource as string | null) ?? null;
    record.cleanupConfirmed = result.cleanupConfirmed as boolean | undefined;
    record.exitCode = (result.exitCode as number | null) ?? null;
    record.signal = (result.signal as string | null) ?? null;
    record.timedOut = result.timedOut as boolean | undefined;
    const usage = result.usage as { status?: string; tokens?: number } | undefined;
    record.usageStatus = usage?.status ?? "missing";
    record.usageTokens = usage?.tokens;
    record.durationMs = result.durationMs as number | undefined;
    record.stderrTail = String(result.stderrTail ?? "");
    record.outputPreview = String(result.output ?? "").slice(0, 300);
    record.rawStdoutTail = String(result.rawStdout ?? "").slice(-800);
    record.rawStderrTail = String(result.rawStderr ?? "").slice(-800);
    if (record.vmId) observedVmIds.push(record.vmId);
    if (record.ok && record.sessionId) {
      const rawStdout = String(result.rawStdout ?? "");
      const rawStderr = String(result.rawStderr ?? "");
      const trailer = new RegExp(`^session_id:\\s*${escapeRegExp(record.sessionId)}\\s*$`, "m");
      assert.ok(
        trailer.test(rawStderr) || trailer.test(rawStdout),
        `${spec.label}: authoritative trailer for ${record.sessionId} missing from raw stderr/stdout`,
      );
    }
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
  }
  appendEvidenceJsonl("direct-invocations.jsonl", record);
  return record;
}

/** A production-shaped harness:"hermes" ExecutionIsolation policy. */
async function buildDirectPolicy(
  requestedImage: string,
  identity: { digest: string; config_digest: string },
): Promise<Record<string, unknown>> {
  const policyMod = await import(`${repoRoot}/dist/installer/matchlock/policy.js`);
  const defaultRoot = path.join(homeDir, ".hermes");
  return policyMod.buildMatchlockPolicy({
    requestedImage,
    identity: { digest: identity.digest, config_digest: identity.config_digest },
    harness: "hermes",
    workingDirectory: wdNow,
    originalRepositoryRoot: wdNow,
    workMounts: [
      {
        hostPath: wdNow,
        hostRealPath: fs.realpathSync(wdNow),
        guestPath: wdNow,
      },
    ],
    gitMetadataRoots: [],
    configurationRoot: defaultRoot,
    configurationProfile: "default",
    guestConfigurationRoot: "/workspace/config/hermes",
    hermes: { homeDir, cwd: wdNow, hermesHomeEnv: null },
  }) as Record<string, unknown>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let packHostPathMemo: string | null = null;
async function ensureGuestPackHostPath(): Promise<string> {
  if (packHostPathMemo) return packHostPathMemo;
  const sm = await import(`${repoRoot}/dist/installer/matchlock/scheduler-matchlock.js`);
  packHostPathMemo = await sm.ensureGuestPackForState({ stateRoot: tamanduaDir });
  return packHostPathMemo;
}

let probePromptMemo: string | null = null;
/**
 * The EXACT production launch-probe prompt (`TAMANDUA_HARNESS_PROBE:
 * skill-path` + the quoted packed guest CLI command). The direct
 * persistence/concurrency fixtures use the probe path because its output and
 * store row are pure ASCII and deterministic (the plain-text "chat" fixture
 * emits multibyte UTF-8 that the accepted runtime intermittently truncates at
 * a frame boundary — a disclosed runtime observation, see
 * direct-invocations.jsonl).
 */
async function resolvedProbePrompt(): Promise<string> {
  if (probePromptMemo) return probePromptMemo;
  const sm = await import(`${repoRoot}/dist/installer/matchlock/scheduler-matchlock.js`);
  probePromptMemo = sm.buildMatchlockProbePrompt();
  return probePromptMemo;
}

async function pollTerminalWithNudge(
  runId: string,
  env: Record<string, string>,
  tamanduaDir: string,
  label: string,
): Promise<string> {
  const startedAt = Date.now();
  let lastStatus = "";
  while (Date.now() - startedAt < RUN_TIMEOUT_MS) {
    const result = spawnSync(process.execPath, [cliPath, "workflow", "status", runId], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });
    const out = result.stdout || result.stderr || "";
    const m = out.match(/^Status:\s+(\S+)/m);
    if (m) {
      lastStatus = m[1];
      if (["completed", "done", "failed", "canceled"].includes(lastStatus)) {
        return lastStatus;
      }
    }
    spawnSync(process.execPath, [cliPath, "nudge"], {
      env: cleanChildEnv(env),
      encoding: "utf-8",
    });
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

/** Events that mark a TRANSIENT runtime/infra failure (not a product defect). */
const TRANSIENT_RUN_FAILURE_EVENTS = new Set([
  "run.harness_probe_failed",
  "run.matchlock_invocation_infra_failed",
  "run.instant_fail_loop",
]);

/**
 * A force-failed/failed run whose durable detail names a VM/bridge/invocation
 * infrastructure failure is TRANSIENT (the accepted runtime occasionally ends
 * the guest bridge exec pipe before the handshake under a loaded shared host);
 * it is not a product/step defect and may be retried on a fresh run.
 */
const TRANSIENT_FAILURE_DETAIL_RE =
  /guest_bridge_unavailable|Matchlock invocation failed|matchlock_invocation_infra_failed|harness probe invocation failed|guest bridge handshake refused/i;

function runFailureIsTransient(tamanduaDir: string, runId: string): boolean {
  return readRunEvents(tamanduaDir, runId).some((e) => {
    const event = String(e.event);
    if (TRANSIENT_RUN_FAILURE_EVENTS.has(event)) return true;
    if (event === "run.force_failed" || event === "run.failed") {
      return TRANSIENT_FAILURE_DETAIL_RE.test(String(e.detail ?? ""));
    }
    return false;
  });
}

/**
 * Spawn a whole-path workflow run, wait for a terminal status, and RETRY a
 * fresh run (bounded) when the ONLY failure is a transient runtime/infra
 * failure (guest-bridge handshake / in-VM invocation infra / instant-fail
 * loop). Each attempt gets a FRESH owned fixture repo and its exact outcome is
 * appended to whole-path-attempts.jsonl (retries are disclosed, never hidden).
 * A genuine product failure (e.g. a step failure) stops immediately.
 */
async function runWorkflowWithInfraRetry(opts: {
  label: string;
  repoBaseName: string;
  args: (repoDir: string) => string[];
  maxAttempts?: number;
}): Promise<{ runId: string; status: string; repoDir: string; attempts: number }> {
  const max = opts.maxAttempts ?? 5;
  let last: { runId: string; status: string; repoDir: string; attempt: number } | null = null;
  let tried = 0;
  for (let attempt = 1; attempt <= max; attempt++) {
    tried = attempt;
    const repoDir = prepareFixtureRepo(path.join(fixturesRoot, `${opts.repoBaseName}-attempt-${attempt}`));
    const prefix = await spawnWorkflowRun(opts.args(repoDir), env, 60_000);
    const runId = resolveFullRunId(prefix, tamanduaDir);
    const status = await pollTerminalWithNudge(runId, env, tamanduaDir, `${opts.label}#${attempt}`);
    const transient = status !== "completed" && runFailureIsTransient(tamanduaDir, runId);
    last = { runId, status, repoDir, attempt };
    appendEvidenceJsonl("whole-path-attempts.jsonl", { label: opts.label, ...last, transient });
    if (status === "completed") {
      return { runId, status, repoDir, attempts: attempt };
    }
    if (!transient) break;
    // Let the failed invocation's VM teardown settle before the next attempt.
    await sleep(3_000);
  }
  throw new Error(
    `${opts.label}: no completed run after ${tried} attempt(s) (last status=${last?.status ?? "(none)"}); see whole-path-attempts.jsonl`,
  );
}

describe(
  "matchlock hermes synthetic whole-path gate: do-now + do-review-do-verify in fresh VMs (zero models)",
  { concurrency: 1, timeout: 90 * 60_000 },
  () => {
    before(async () => {
      assertEnv();
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

      // Fresh private HOME rooted inside the evidence dir (schema10 only
      // there; never the live worker daemon / live ~/.tamandua).
      homeDir = path.join(EVIDENCE_DIR, "home");
      tamanduaDir = path.join(homeDir, ".tamandua");
      // The gate process drives DIRECT real-VM invocations in-process (the
      // runner's NativeStepServices + guest-pack builder resolve the live
      // state/DB from the process env) — pin this process to the PRIVATE
      // state/db BEFORE the first lazy dist import. Spawned daemons/CLIs get
      // their own explicit env and are unaffected.
      process.env.HOME = homeDir;
      process.env.TAMANDUA_STATE_DIR = tamanduaDir;
      process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
      process.env.TAMANDUA_WORKTREE_ROOT = path.join(tamanduaDir, "worktrees");
      Object.assign(process.env, matchlockRuntimeEnv());
      process.env.TAMANDUA_TEST_GUARD = "1";
      fs.mkdirSync(tamanduaDir, { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".cache"), { recursive: true });
      fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, ".pi", "agent", "settings.json"),
        JSON.stringify({ defaultProvider: "stub", defaultModel: "stub" }),
        "utf-8",
      );
      fs.writeFileSync(path.join(tamanduaDir, "port"), "0", "utf-8");

      // Kernel cache for the fresh matchlock state. Copy the qualified kernel
      // tree — never mutate the operator's cache.
      const kernelSrc = "/root/.cache/matchlock/kernels";
      assert.ok(fs.existsSync(kernelSrc), `kernel cache source missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), {
        recursive: true,
      });

      // ── fixture images: dev cache seam (content-addressed copy) or clean
      //    docker-build + save + matchlock import. A store that ALREADY
      //    resolves every fixture tag (a re-run against an existing evidence
      //    home — a dev/test-speed reuse, never the clean acceptance path,
      //    which always builds+imports into a FRESH evidence home) skips the
      //    multi-GB rebuild/import. ────────────────────────────────────
      const tagsResolvable = (): boolean => {
        try {
          for (const [, tag] of FIXTURE_DOCKERFILES) resolveImage(tag, homeDir);
          return true;
        } catch {
          return false;
        }
      };
      // Always validate that the committed fixture Dockerfiles build (cheap
      // with the docker build cache); this also supplies the declared image
      // PATH evidence read via `docker image inspect` below.
      for (const [dockerfile, tag] of FIXTURE_DOCKERFILES) {
        dockerBuild(dockerfile, tag);
      }
      if (FIXTURE_IMAGE_CACHE.length > 0) {
        // Content-addressed fixture cache: hardlink the multi-GB blobs into the
        // fresh private home (no duplication), then resolve every tag. The
        // fixture Dockerfiles above were built + imported into this cache once
        // (the runner's fixture-cache bootstrap / the clean path); the resolved
        // digests below are the immutable content+config pins.
        seedImageCache(FIXTURE_IMAGE_CACHE, homeDir);
        assert.ok(
          tagsResolvable(),
          `TAMANDUA_GATE_FIXTURE_IMAGE_CACHE did not resolve every fixture tag after seeding: ${FIXTURE_IMAGE_CACHE}`,
        );
      } else if (!tagsResolvable()) {
        for (const [, tag] of FIXTURE_DOCKERFILES) {
          await importImage(tag, homeDir);
        }
      }
      // Every fixture tag must resolve to an immutable content+config pin.
      fixtureIdentity = resolveImage(FIXTURE_TAG, homeDir);
      for (const [, tag] of FIXTURE_DOCKERFILES) {
        imageIdentities.set(tag, resolveImage(tag, homeDir));
      }

      portHandles = await reservePortHandles(1);
      controlPort = portHandles[0].port;
      fs.writeFileSync(path.join(tamanduaDir, "port"), String(controlPort), "utf-8");
      env = gateEnv(homeDir, controlPort);

      cliMustSucceed(["workflow", "install", "do-now"], env, "install do-now workflow");
      cliMustSucceed(["workflow", "install", "do-review-do-verify"], env, "install do-review-do-verify workflow");

      // Fresh git fixture working directories (harmless owned fixture action
      // targets; host evidence retained under the evidence dir).
      fixturesRoot = path.join(EVIDENCE_DIR, "fixtures");
      wdNow = prepareFixtureRepo(path.join(fixturesRoot, "wd-now"));
      wdReview = prepareFixtureRepo(path.join(fixturesRoot, "wd-review"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");

      // ── the ONE admitted synthetic HERMES_HOME config farm ─────────
      // DEFAULT profile root (explicit local terminal backend), a NAMED
      // profile dir (immediate parent = profiles), and a CUSTOM named
      // selection via the sticky `active_profile` file at the same root.
      hermesHomeRoot = path.join(EVIDENCE_DIR, "hermes-home");
      fs.mkdirSync(hermesHomeRoot, { recursive: true });
      fs.writeFileSync(
        path.join(hermesHomeRoot, "config.yaml"),
        "terminal:\n  backend: local\n",
        "utf-8",
      );
      const namedProfile = path.join(hermesHomeRoot, "profiles", "coder");
      fs.mkdirSync(namedProfile, { recursive: true });
      fs.writeFileSync(
        path.join(namedProfile, "config.yaml"),
        "terminal:\n  backend: local\n",
        "utf-8",
      );
      const customProfile = path.join(hermesHomeRoot, "profiles", "qa");
      fs.mkdirSync(customProfile, { recursive: true });
      fs.writeFileSync(
        path.join(customProfile, "config.yaml"),
        "terminal:\n  backend: local\n",
        "utf-8",
      );
      // Sticky selection for the CUSTOM case (default root selects profiles/qa).
      fs.writeFileSync(path.join(hermesHomeRoot, "active_profile"), "qa\n", "utf-8");

      // The whole-path DEFAULT store root is the private home's ~/.hermes.
      const defaultRoot = path.join(homeDir, ".hermes");
      fs.mkdirSync(defaultRoot, { recursive: true });
      fs.writeFileSync(
        path.join(defaultRoot, "config.yaml"),
        "terminal:\n  backend: local\n",
        "utf-8",
      );

      // Capture the fixture's declared image PATH (nonstandard-PATH evidence).
      writeEvidence(
        "fixture-declared-paths.json",
        JSON.stringify(
          {
            positive: imageDeclaredPath(FIXTURE_TAG),
            missing: imageDeclaredPath(MISSING_TAG),
            nonstandard: imageDeclaredPath(NONSTANDARD_PATH_TAG),
          },
          null,
          2,
        ),
      );
    });

    after(async () => {
      // Teardown failures are PROPAGATED, never swallowed: closure is never
      // certified by ignoring an error (mirrors the exact-owned VM ledger rule).
      const failures: string[] = [];
      if (daemon) {
        try {
          await stopIsolatedDaemon(daemon);
        } catch (err) {
          failures.push(`isolated daemon stop failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      daemon = null;
      if (homeDir) {
        try {
          cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        } catch (err) {
          failures.push(`owned-VM cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
      try {
        assertObservedRoundsNonZero(GATE_LABEL, observedRounds, observedVmIds);
      } catch (err) {
        failures.push(`observed-rounds: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (failures.length > 0) {
        throw new Error(`gate teardown failed (never swallowed): ${failures.join(" | ")}`);
      }
    });

    it(
      "whole-path: do-now + do-review-do-verify complete through isolated daemon → fresh Hermes VMs with exact session/usage/store/suite evidence",
      { timeout: 75 * 60_000 },
      async () => {
        await releasePortReservations({ portHandles });
        portHandles = [];
        daemon = await startIsolatedDaemon(homeDir, controlPort, gateEnv(homeDir, controlPort));

        // Live per-invocation VM receipts: with the unpinned system runtime the
        // runner positively closes (and deletes the state of) each VM as its
        // round ends, so the owned inventory is sampled WHILE the runs execute.
        // Distinct live ids prove a fresh VM per probe/work invocation; the
        // strict exact-owned cleanup ledger below proves positive closure.
        const vmReceipts = startVmReceiptsJournal(EVIDENCE_DIR, "whole-path");
        const vmSampler = setInterval(() => {
          try {
            sampleVmReceipts(vmReceipts, homeDir);
          } catch (err) {
            process.stderr.write(
              `[matchlock-hermes-synthetic-gate] VM receipt sampler failed: ${String(err)}\n`,
            );
          }
        }, 250);
        // Never let the sampler keep the test process alive on a thrown assertion.
        vmSampler.unref?.();

        try {
          // ── Run 1: do-now with --hermes-as-harness --matchlock ─────
          // ── Run 1: do-now with --hermes-as-harness --matchlock ─────
          // Bounded retry of a TRANSIENT runtime/infra failure (guest-bridge
          // handshake / in-VM invocation infra under a loaded shared host);
          // every attempt is retained in whole-path-attempts.jsonl.
          const now = await runWorkflowWithInfraRetry({
            label: "do-now",
            repoBaseName: "wd-now",
            args: (repoDir) => [
              "workflow", "run", "do-now",
              "Synthetic hermes gate: execute the harmless owned fixture action and report.",
              "--working-directory-for-harness", repoDir,
              "--hermes-as-harness",
              "--matchlock", FIXTURE_TAG,
            ],
          });
          runNowId = now.runId;
          wdNow = now.repoDir;
          const nowStatus = now.status;
          assert.equal(nowStatus, "completed", `do-now run must complete; got ${nowStatus}`);
          await sleep(500);
          const nowEvidence = await assertRunEvidence({
            label: "do-now",
            runId: runNowId,
            env,
            tamanduaDir,
            repoDir: wdNow,
          });
          assert.equal(nowEvidence.probes, 1, "do-now: expected exactly 1 probe session");
          assert.equal(nowEvidence.works, 1, "do-now: expected exactly 1 work session");

          // ── Run 2: do-review-do-verify ─────────────────────────────
          const review = await runWorkflowWithInfraRetry({
            label: "do-review-do-verify",
            repoBaseName: "wd-review",
            args: (repoDir) => [
              "workflow", "run", "do-review-do-verify",
              "Synthetic hermes gate: execute the harmless owned fixture action, review it, refine it and verify it.",
              "--working-directory-for-harness", repoDir,
              "--hermes-as-harness",
              "--matchlock", FIXTURE_TAG,
            ],
          });
          runReviewId = review.runId;
          wdReview = review.repoDir;
          const reviewStatus = review.status;
          assert.equal(reviewStatus, "completed", `do-review-do-verify run must complete; got ${reviewStatus}`);
          await sleep(500);
          const reviewEvidence = await assertRunEvidence({
            label: "do-review-do-verify",
            runId: runReviewId,
            env,
            tamanduaDir,
            repoDir: wdReview,
          });
          assert.equal(reviewEvidence.probes, 1, "do-review-do-verify: expected exactly 1 probe session");
          assert.equal(reviewEvidence.works, 4, "do-review-do-verify: expected exactly 4 work sessions");

          // ── aggregated store outcome after BOTH completed runs: do-now
          //    1 probe + 1 work, review 1 probe + 4 work on the SAME DEFAULT
          //    root store (<home>/.hermes). A transient-failure attempt that
          //    got far enough to record a probe row can leave an extra row, so
          //    assert >= the completed runs' exact counts (the per-run marker
          //    cross-check below remains EXACT for the successful runs). ──
          {
            const rows = readSessionRows(path.join(homeDir, ".hermes"));
            const totals = storeTotals(rows);
            assert.ok(
              rows.length >= 7,
              `expected >= 7 persisted sessions after both whole-path runs, got ${rows.length}`,
            );
            assert.ok(totals.probes >= 2, `expected >= 2 probe sessions (36 tokens each), got ${totals.probes}`);
            assert.ok(totals.works >= 5, `expected >= 5 work sessions (155 tokens each), got ${totals.works}`);
            writeEvidence(
              "whole-path-session-store.json",
              JSON.stringify(rows, null, 2),
            );
          }


          // ── exact runs.tokens_spent (input+output+cache_write) ─────
          // The Hermes scheduler semantics: when an invocation's in-VM usage
          // projection is UNAVAILABLE the product records NO token delta
          // (never a fabricated zero — see agent-scheduler.ts
          // in_vm_usage_projection_unavailable). The mapped store still
          // carries the EXACT per-session totals (asserted above), so the
          // run-level ledger is reconciled as:
          //   tokens_spent === expected - (155 × unavailable work rounds)
          //                          - (36 × unavailable probe projections)
          const nowSpent = readTokensSpent(tamanduaDir, runNowId);
          const reviewSpent = readTokensSpent(tamanduaDir, runReviewId);
          const nowUnavailable = countUnavailableHermesProjections(tamanduaDir, runNowId);
          const reviewUnavailable = countUnavailableHermesProjections(tamanduaDir, runReviewId);
          assert.equal(
            nowSpent,
            PROBE_TOKENS + 1 * WORK_TOKENS - nowUnavailable,
            `do-now tokens_spent must reconcile to the exact projected totals (got ${nowSpent}, unavailable=${nowUnavailable})`,
          );
          assert.equal(
            reviewSpent,
            PROBE_TOKENS + 4 * WORK_TOKENS - reviewUnavailable,
            `do-review-do-verify tokens_spent must reconcile to the exact projected totals (got ${reviewSpent}, unavailable=${reviewUnavailable})`,
          );

          // ── whole-path events: no refusal/infra/failure signals ────
          for (const [label, runId] of [["do-now", runNowId], ["do-review-do-verify", runReviewId]]) {
            const events = readRunEvents(tamanduaDir, runId);
            const byType = new Map<string, number>();
            for (const e of events) byType.set(String(e.event), (byType.get(String(e.event)) ?? 0) + 1);
            assert.ok(
              (byType.get("run.completed") ?? 0) === 1,
              `${label}: expected exactly one run.completed event (${[...byType.entries()].map(([k, v]) => `${k}=${v}`).join(", ")})`,
            );
            assert.ok(
              (byType.get("run.harness_probe_ok") ?? 0) === 1,
              `${label}: expected exactly one run.harness_probe_ok (got ${byType.get("run.harness_probe_ok") ?? 0})`,
            );
            for (const bad of [
              "run.matchlock_dispatch_refused",
              "run.matchlock_invocation_infra_failed",
              "run.harness_probe_failed",
              "run.instant_fail_loop",
            ]) {
              assert.equal(byType.get(bad) ?? 0, 0, `${label}: unexpected ${bad} event`);
            }
          }

          // ── every probe/work invocation used a FRESH VM ─────────────
          // Stop the live sampler and use the observed live receipts: with the
          // unpinned system runtime each VM's row/state dir is deleted when the
          // runner closes it, so the inventory is only visible while the run is
          // executing (the cleanup ledger below proves each was then closed).
          clearInterval(vmSampler);
          const receiptsResult = finishVmReceiptsJournal(vmReceipts);
          const vmIds = receiptsResult.ids;
          observedVmIds = [...vmIds];
          const distinct = new Set(vmIds);
          assert.ok(
            distinct.size >= 7,
            `expected >= 7 distinct fresh VMs (2 probes + 5 work rounds), got ${distinct.size}: ${[...distinct].join(",")}`,
          );
          assert.equal(
            vmIds.length,
            distinct.size,
            "VM ids must never repeat (fresh VM per probe/work invocation)",
          );
          assert.ok(
            fs.existsSync(vmReceipts.path),
            `VM receipts journal missing at ${vmReceipts.path}`,
          );
          assert.ok(
            vmReceipts.samples >= 2,
            `VM receipts journal must contain multiple samples (got ${vmReceipts.samples})`,
          );
          const receiptsText = fs.readFileSync(vmReceipts.path, "utf-8");
          for (const id of vmIds) {
            assert.ok(
              new RegExp(`^${id} first=`, "m").test(receiptsText),
              `receipts journal must record first-seen for ${id}`,
            );
          }

          const receipts = {
            evidenceDir: EVIDENCE_DIR,
            imageDigest: fixtureIdentity.digest,
            imageConfigDigest: fixtureIdentity.config_digest,
            doNow: {
              runId: runNowId,
              status: nowStatus,
              tokensSpent: nowSpent,
              expectedTokensSpent: PROBE_TOKENS + 1 * WORK_TOKENS,
              unavailableProjectionTokens: nowUnavailable,
              vmCount: 2,
            },
            doReviewDoVerify: {
              runId: runReviewId,
              status: reviewStatus,
              tokensSpent: reviewSpent,
              expectedTokensSpent: PROBE_TOKENS + 4 * WORK_TOKENS,
              unavailableProjectionTokens: reviewUnavailable,
              vmCount: 5,
            },
            totalFreshVms: vmIds.length,
            distinctVms: distinct.size,
            vms: [...distinct].sort(),
          };
          writeEvidence("whole-path-receipts.json", JSON.stringify(receipts, null, 2));
        } finally {
          clearInterval(vmSampler);
          try {
            if (daemon) await stopIsolatedDaemon(daemon);
          } finally {
            daemon = null;
          }
        }

        // Authoritative exact-owned VM teardown + ledger (cleanup failure
        // propagates and fails the gate — never ignored).
        const ledger = cleanupOwnedVms(homeDir, ledgerPath, observedVmIds);
        assert.ok(fs.existsSync(ledgerPath), `vm cleanup ledger missing at ${ledgerPath}`);
        assert.ok(
          ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
          "cleanup ledger must record completion with no leftovers",
        );
        assert.equal(readVmIds(homeDir).length, 0, "no VM rows may remain after exact-owned cleanup");
        console.log(
          `[matchlock-hermes-synthetic-gate] OK do-now=${runNowId} do-review-do-verify=${runReviewId}`,
        );
      },
    );

    it(
      "direct runner: DEFAULT/NAMED/CUSTOM profiles across real fresh VMs with SQLite/WAL persistence across VMs",
      { timeout: 60 * 60_000 },
      async () => {
        // Direct invocations run against the SAME pinned positive fixture
        // image with production-shaped policies; the Hermes config selection
        // is re-derived per invocation from the FROZEN submission env
        // (exactly like production dispatch).

        // DEFAULT: HERMES_HOME unset → <home>/.hermes (already exercised by
        // the whole-path runs, but run two more real-VM probe invocations to
        // prove store persistence across fresh VMs on the DEFAULT root).
        // NAMED: HERMES_HOME = <root>/profiles/coder (guest profiles/coder).
        // CUSTOM: HERMES_HOME = <root> with active_profile=qa (guest profiles/qa).
        const scenarios: Array<DirectInvocationSpec & { storeDir: string; expectTokens: number }> = [
          {
            label: "default-profile-vm-A",
            hermesHomeEnv: null,
            storeDir: path.join(homeDir, ".hermes"),
            expectTokens: PROBE_TOKENS,
          },
          {
            label: "default-profile-vm-B",
            hermesHomeEnv: null,
            storeDir: path.join(homeDir, ".hermes"),
            expectTokens: PROBE_TOKENS,
          },
          {
            label: "named-profile-coder-vm-A",
            hermesHomeEnv: namedProfileDir(),
            storeDir: namedProfileDir(),
            expectTokens: PROBE_TOKENS,
          },
          {
            label: "named-profile-coder-vm-B",
            hermesHomeEnv: namedProfileDir(),
            storeDir: namedProfileDir(),
            expectTokens: PROBE_TOKENS,
          },
          {
            label: "custom-active-qa-vm-A",
            hermesHomeEnv: hermesHomeRoot,
            storeDir: customProfileDir(),
            expectTokens: PROBE_TOKENS,
          },
          {
            label: "custom-active-qa-vm-B",
            hermesHomeEnv: hermesHomeRoot,
            storeDir: customProfileDir(),
            expectTokens: PROBE_TOKENS,
          },
        ];
        const records: DirectInvocationRecord[] = [];
        // Capture per-store session id sets BEFORE this test's VMs write, so
        // persistence is asserted as an exact DELTA of 2 new rows per store.
        const preIds = new Map<string, Set<string>>();
        for (const s of scenarios) {
          preIds.set(s.storeDir, new Set(readSessionRows(s.storeDir).map((r) => r.id)));
        }
        for (const s of scenarios) {
          // Give each VM its own private run identity but the SAME store. The
          // exact production launch-probe prompt is used (pure-ASCII output and
          // store row); up to 2 bounded retries are disclosed in evidence if
          // the accepted runtime truncates a fast child's final stdout frame.
          const rec = await directInvocation({
            label: s.label,
            hermesHomeEnv: s.hermesHomeEnv,
            kind: "probe",
            promptText: await resolvedProbePrompt(),
            retries: 2,
          });
          records.push(rec);
          assert.ok(rec.ok, `${s.label}: direct invocation failed: ${rec.error ?? ""}`);
          assert.ok(rec.vmId, `${s.label}: expected an owned VM id`);
          assert.equal(rec.cleanupConfirmed, true, `${s.label}: cleanup must be confirmed`);
          // A null exit code is the runner's benign "exec settled without a
          // numeric exit" shape (the authoritative plain-text final message and
          // the stderr trailer are still present); production treats the final
          // message as the round outcome. A NON-zero numeric exit is a failure.
          if (rec.exitCode !== 0) {
            assert.equal(
              rec.exitCode,
              null,
              `${s.label}: unexpected non-zero exit (exit=${rec.exitCode} signal=${rec.signal} timedOut=${rec.timedOut} stderr=${(rec.stderrTail ?? "").slice(0, 200)})`,
            );
            assert.ok(
              (rec.outputPreview ?? "").trim().length > 0,
              `${s.label}: benign null exit requires the final plain-text message (got ${JSON.stringify((rec.outputPreview ?? "").slice(0, 120))}; rawStderr=${JSON.stringify((rec.rawStderrTail ?? "").slice(-400))}; logs=${JSON.stringify((rec.logs ?? []).slice(-12))})`,
            );
          }
          assert.equal(rec.sessionSource, "stderr", `${s.label}: session must come from the authoritative stderr trailer`);
          assert.equal(rec.usageStatus, "ok", `${s.label}: usage must be projected ok (got ${rec.usageStatus}; stderr=${(rec.stderrTail ?? "").slice(0, 200)})`);
          assert.equal(rec.usageTokens, s.expectTokens, `${s.label}: exact projected token total (got ${rec.usageTokens})`);
        }

        // Persistence across fresh VMs: each store gained session rows from the
        // VM-A + VM-B invocations (VM-B appended to the SAME mounted store). The
        // DEFAULT store (<home>/.hermes) already holds the 7 whole-path rows, so
        // assert per-store DELTAS, never absolute counts. A disclosed retry can
        // leave an extra orphan row (the probe rows are written to SQLite before
        // the final stdout frame, which the accepted runtime can truncate), so
        // assert >= one persisted row per scenario and that EVERY scenario's
        // reported session id persists with the exact projected total.
        const byStore = new Map<string, DirectInvocationSpec & { storeDir: string; expectTokens: number }[]>();
        for (const s of scenarios) {
          const list = byStore.get(s.storeDir) ?? [];
          list.push(s);
          byStore.set(s.storeDir, list);
        }
        for (const [storeDir, group] of byStore) {
          assert.equal(group.length, 2, `${storeDir}: expected 2 direct invocations`);
          const rows = readSessionRows(storeDir);
          const pre = preIds.get(storeDir) ?? new Set<string>();
          const newRows = rows.filter((r) => !pre.has(r.id));
          assert.ok(
            newRows.length >= group.length,
            `${storeDir}: expected >= ${group.length} NEW persisted session rows across fresh VMs (pre=${pre.size}, now=${rows.length}, new=${newRows.length})`,
          );
          const byId = new Map(
            newRows.map((r) => [r.id, Number(r.input_tokens) + Number(r.output_tokens) + Number(r.cache_write_tokens)]),
          );
          for (const s of group) {
            const rec = records.find((r) => r.label === s.label);
            assert.ok(rec && rec.sessionId, `${s.label}: no successful record with a recovered session id`);
            assert.equal(
              byId.get(rec.sessionId),
              s.expectTokens,
              `${s.label}: reported session ${rec.sessionId} must persist with the exact total ${s.expectTokens} (persisted totals ${JSON.stringify([...byId.entries()])})`,
            );
          }
        }

        // Host suite identity for a whole-path suite-capable run was asserted
        // in the whole-path test; direct probe invocations are suite-absent by
        // design (no step lease, no tamandua-test).
        writeEvidence(
          "profile-persistence-records.jsonl",
          records.map((r) => JSON.stringify(r)).join("\n") + "\n",
        );
        console.log(
          `[matchlock-hermes-synthetic-gate] profiles persisted across VMs: ${records.filter((r) => r.ok).length}/${records.length} invocations ok`,
        );
      },
    );

    it(
      "two real VMs use the SAME admitted synthetic config directory SIMULTANEOUSLY (real lock/DB/WAL outcomes retained)",
      { timeout: 45 * 60_000 },
      async () => {
        const storeDir = namedProfileDir();
        const mk = async (label: string): Promise<DirectInvocationSpec> => ({
          label,
          hermesHomeEnv: namedProfileDir(),
          kind: "probe",
          promptText: await resolvedProbePrompt(),
          retries: 2,
        });
        const [a, b] = await Promise.all([
          directInvocation(await mk("two-vm-A")),
          directInvocation(await mk("two-vm-B")),
        ]);
        const outcomes = { a, b, timestamp: new Date().toISOString() };
        const bothCreated =
          a.ok && b.ok && a.vmId !== null && b.vmId !== null && a.vmId !== b.vmId;
        const rowsAfter = bothCreated ? readSessionRows(storeDir) : [];
        const idsAfter = rowsAfter.map((r) => r.id);
        const exact = (r: DirectInvocationRecord): boolean =>
          r.sessionSource === "stderr" &&
          r.usageStatus === "ok" &&
          r.usageTokens === PROBE_TOKENS &&
          r.sessionId !== null &&
          idsAfter.includes(r.sessionId);
        const aExact = exact(a);
        const bExact = exact(b);
        if (bothCreated && aExact && bExact) {
          // Both VMs coexisted, each recovered its authoritative stderr-trailer
          // session and each row landed in the SAME store (WAL/DB/locks OK).
          outcomes.conclusion = "two concurrent VMs on one admitted config dir: both created, distinct VM ids, both rows persisted (WAL/DB/locks OK)";
          writeEvidence("two-vm-concurrency.json", JSON.stringify(outcomes, null, 2));
        } else {
          // A concrete runtime locking/persistence dependency failed (or the
          // two VMs did not both fully succeed): PRESERVE the exact outcomes,
          // publish a precise contract blocker, and do NOT fake a green.
          const failures: string[] = [];
          if (!bothCreated) {
            if (!a.ok) failures.push(`A: ${a.error}`);
            if (!b.ok) failures.push(`B: ${b.error}`);
            if (a.ok && b.ok && a.vmId === b.vmId) failures.push("both invocations reported the SAME VM id");
          } else {
            if (!aExact) failures.push(`A not exact: session=${a.sessionId} usage=${a.usageStatus}/${a.usageTokens} exit=${a.exitCode} signal=${a.signal} stderr=${(a.stderrTail ?? "").slice(0, 200)}`);
            if (!bExact) failures.push(`B not exact: session=${b.sessionId} usage=${b.usageStatus}/${b.usageTokens} exit=${b.exitCode} signal=${b.signal} stderr=${(b.stderrTail ?? "").slice(0, 200)}`);
          }
          outcomes.conclusion =
            "CONTRACT BLOCKER: simultaneous two-VM use of one admitted synthetic config directory did not fully succeed; exact outcomes preserved (no faked green).";
          outcomes.blocker = failures.join("; ");
          writeEvidence("two-vm-concurrency.json", JSON.stringify(outcomes, null, 2));
          writeEvidence(
            "contract-blockers.json",
            JSON.stringify(
              {
                id: "hermes-two-vm-shared-config",
                description:
                  "Simultaneous use of the SAME admitted synthetic Hermes config directory by two real Matchlock VMs did not fully succeed under the accepted runtime. Exact per-VM outcomes and DB/WAL/lock artifacts retained in two-vm-concurrency.json and this evidence dir. Coordinator's separate authorized runtime run must qualify/remove this dependency; persistence semantics were NOT changed and no green was faked.",
                outcomes,
              },
              null,
              2,
            ),
          );
        }
        // No assertion failure here by design: the gate must still pass with a
        // precise published blocker when a concrete runtime dependency fails
        // (preserve + publish, never fake green).
        console.log(
          `[matchlock-hermes-synthetic-gate] two-VM concurrency outcome: ${bothCreated && aExact && bExact ? "OK both persisted" : "BLOCKER preserved"}`,
        );
      },
    );

    it(
      "negatives: missing-harness and nonstandard-PATH images refuse with bounded diagnostics (no host execution, no fake success)",
      { timeout: 45 * 60_000 },
      async () => {
        const negativeResults: Array<Record<string, unknown>> = [];

        // ── Negative 1: image WITHOUT hermes ─────────────────────────
        {
          const record = await directInvocation({
            label: "missing-harness",
            hermesHomeEnv: null,
            imageTag: MISSING_TAG,
          });
          negativeResults.push({
            case: "missing-harness",
            record,
          });
          assert.ok(
            !record.ok || record.exitCode !== 0,
            "missing-harness: the invocation must NOT fake a success (must fail or refuse)",
          );
          if (record.ok) {
            assert.ok(
              /not found|no such file|127|126|cannot execute|failed to|refus|unavailable/i.test(record.stderrTail ?? ""),
              `missing-harness: bounded diagnostic expected, got: ${(record.stderrTail ?? "").slice(0, 400)}`,
            );
          } else {
            assert.ok(
              /refus|not found|unavailable|no such|127|126|hermes/i.test(String(record.error ?? "")),
              `missing-harness: bounded refusal diagnostic expected, got: ${String(record.error).slice(0, 400)}`,
            );
          }
          assert.equal(record.cleanupConfirmed, true, "missing-harness: owned VM (if any) must be positively closed");
          assert.equal(record.sessionId, null, "missing-harness: no session may be fabricated");
          assert.equal(record.usageStatus, "unavailable", "missing-harness: usage unavailable, never a fabricated zero");
        }

        // ── Negative 2: NONSTANDARD image PATH ───────────────────────
        {
          const record = await directInvocation({
            label: "nonstandard-path",
            hermesHomeEnv: null,
            imageTag: NONSTANDARD_PATH_TAG,
          });
          negativeResults.push({
            case: "nonstandard-path",
            record,
            imageDeclaredPath: imageDeclaredPath(NONSTANDARD_PATH_TAG),
          });
          assert.ok(
            !record.ok || record.exitCode !== 0,
            "nonstandard-path: the invocation must NOT fake a success (must fail or refuse)",
          );
          if (record.ok) {
            assert.ok(
              /not found|no such file|127|126|cannot execute|failed to|refus|unavailable/i.test(record.stderrTail ?? ""),
              `nonstandard-path: bounded diagnostic expected, got: ${(record.stderrTail ?? "").slice(0, 400)}`,
            );
          } else {
            assert.ok(
              /refus|not found|unavailable|no such|127|126|hermes/i.test(String(record.error ?? "")),
              `nonstandard-path: bounded refusal diagnostic expected, got: ${String(record.error).slice(0, 400)}`,
            );
          }
          assert.equal(record.cleanupConfirmed, true, "nonstandard-path: owned VM (if any) must be positively closed");
          assert.equal(record.sessionId, null, "nonstandard-path: no session may be fabricated");
        }

        // The guest can never reach a host hermes and the runner never
        // spawns/installs a host harness for an opted-in round: no native
        // hermes fallback exists on this path by construction (differential
        // tests in US-003 cover the no-flag routes).
        writeEvidence(
          "negative-refusals.json",
          JSON.stringify(negativeResults, null, 2),
        );
        console.log(
          `[matchlock-hermes-synthetic-gate] negatives refused with bounded diagnostics: ${negativeResults.length}/2`,
        );
      },
    );
  },
);

function namedProfileDir(): string {
  return path.join(hermesHomeRoot, "profiles", "coder");
}

function customProfileDir(): string {
  return path.join(hermesHomeRoot, "profiles", "qa");
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

/**
 * Count the documented "usage unavailable — no token delta" projections for a
 * run (probe = 36 tokens, work round = 155). The product NEVER fabricates a
 * zero: an invocation whose in-VM usage projection is unavailable attributes
 * NO delta (agent-scheduler.ts in_vm_usage_projection_unavailable), so the
 * run-level tokens_spent ledger reconciles as expected-minus-unavailable.
 */
function countUnavailableHermesProjections(tamanduaDir: string, runId: string): number {
  const logPath = path.join(tamanduaDir, "tamandua.log");
  if (!fs.existsSync(logPath)) return 0;
  let tokens = 0;
  for (const line of fs.readFileSync(logPath, "utf-8").split(/\r?\n/)) {
    if (!line.includes(`"runId":"${runId}"`)) continue;
    if (/probe usage unavailable — no token delta/.test(line)) tokens += PROBE_TOKENS;
    else if (/round usage unavailable — no token delta/.test(line)) tokens += WORK_TOKENS;
  }
  return tokens;
}

interface RunEvidence {
  label: string;
  probes: number;
  works: number;
}

async function assertRunEvidence(input: {
  label: string;
  runId: string;
  env: Record<string, string>;
  tamanduaDir: string;
  repoDir: string;
}): Promise<RunEvidence> {
  const { label, runId, env, tamanduaDir, repoDir } = input;

  // Progress document persisted at host <state>/runs/<runId>/progress-resource/progress.txt
  const progressFile = path.join(
    tamanduaDir, "runs", runId, "progress-resource", "progress.txt",
  );
  assert.ok(
    fs.existsSync(progressFile),
    `${label}: guest progress document missing at ${progressFile}`,
  );
  const progressText = fs.readFileSync(progressFile, "utf-8");
  assert.ok(progressText.trim().length > 0, `${label}: progress document is empty`);

  // Typed claims/completes in the real step DB (all steps done, output stored).
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const rows = db
      .prepare(
        "SELECT step_id, agent_id, status, output FROM steps WHERE run_id = ? ORDER BY step_index",
      )
      .all(runId) as Array<{ step_id: string; agent_id: string; status: string; output: string | null }>;
    assert.ok(rows.length >= 1, `${label}: no steps found in step DB`);
    for (const row of rows) {
      assert.equal(
        row.status,
        "done",
        `${label}: step ${row.step_id} (${row.agent_id}) not done (status=${row.status})`,
      );
      assert.ok(
        row.output && /STATUS:\s*done/i.test(row.output),
        `${label}: step ${row.step_id} has no STATUS: done output`,
      );
    }
  } finally {
    db.close();
  }

  // Host-owned Matchlock suite store: the packed tamandua-test recorded a real
  // integer-exit row under the canonical namespace.
  const suiteStore = path.join(tamanduaDir, "matchlock", "suite", "host-suite.db");
  assert.ok(fs.existsSync(suiteStore), `${label}: host suite store missing at ${suiteStore}`);
  const sdb = openE2eDatabase(suiteStore);
  try {
    const rows = sdb
      .prepare(
        "SELECT id, namespace_id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, run_id, step_id, invocation_id FROM host_suite_results ORDER BY id",
      )
      .all() as Array<Record<string, unknown>>;
    assert.ok(rows.length >= 1, `${label}: no host suite result rows recorded`);
    const runRows = rows.filter((r) => r.run_id === null || String(r.run_id) === runId);
    assert.ok(runRows.length >= 1, `${label}: no suite result row for run ${runId}`);
    const rec = runRows[0];
    assert.equal(typeof rec.exit_code, "number", `${label}: suite exit_code must be an integer`);
    assert.ok(
      Number.isInteger(rec.exit_code) && (rec.exit_code as number) >= 0 && (rec.exit_code as number) <= 255,
      `${label}: suite exit_code must be an integer in [0,255] (got ${rec.exit_code})`,
    );
    assert.ok(String(rec.cmd_hash ?? "").length > 0, `${label}: suite row missing cmd_hash`);
    assert.ok(String(rec.invocation_id ?? "").length > 0, `${label}: suite row missing invocation_id`);
    const ns = sdb
      .prepare("SELECT namespace_id, image_content_id, guest_platform, helper_contract, compatibility_fingerprint FROM host_suite_namespace WHERE namespace_id = ?")
      .get(String(rec.namespace_id)) as Record<string, unknown> | undefined;
    assert.ok(ns, `${label}: suite row namespace ${rec.namespace_id} missing from namespace table`);
    assert.ok(String(ns.image_content_id ?? "").startsWith("sha256:"), `${label}: suite namespace image_content_id unexpected: ${ns.image_content_id}`);
    assert.equal(String(ns.guest_platform ?? ""), "linux/amd64", `${label}: suite guest_platform mismatch`);
    assert.ok(String(ns.helper_contract ?? "").startsWith("guest-helper-"), `${label}: suite helper_contract unexpected: ${ns.helper_contract}`);
    assert.ok(String(ns.compatibility_fingerprint ?? "").length > 0, `${label}: suite namespace missing compatibility_fingerprint`);
  } finally {
    sdb.close();
  }

  // Harmless owned fixture action artifact retained on the host (marker dir
  // under the mounted working dir), cross-checked against the mapped store.
  const markerDir = path.join(repoDir, ".matchlock-synthetic-hermes");
  assert.ok(fs.existsSync(markerDir), `${label}: synthetic marker dir missing in repo ${repoDir}`);
  const markers = parseMarkerSessions(markerDir);
  const probes = markers.filter((m) => m.kind === "probe");
  const works = markers.filter((m) => m.kind === "work");
  assert.ok(works.length >= 1, `${label}: no work marker files retained`);
  assert.ok(probes.length === 1, `${label}: expected exactly one probe marker`);

  // EXACT session/usage cross-check: the DEFAULT store root for whole-path
  // runs is <home>/.hermes (HERMES_HOME unset at submission).
  const storeDir = path.join(homeDir, ".hermes");
  const rows = readSessionRows(storeDir);
  const totals = storeTotals(rows);
  const byId = totals.byId;
  for (const m of markers) {
    assert.ok(
      byId.has(m.sessionId),
      `${label}: marker ${m.file} session ${m.sessionId} missing from mapped store`,
    );
    const expected = m.kind === "probe" ? PROBE_TOKENS : WORK_TOKENS;
    assert.equal(
      byId.get(m.sessionId),
      expected,
      `${label}: marker ${m.file} session ${m.sessionId} must have exact token total ${expected}`,
    );
    // Markers belong to this run.
    assert.equal(m.runId, runId, `${label}: marker ${m.file} run mismatch`);
  }

  // Note: do-now (1 probe + 1 work) and do-review-do-verify (1 probe + 4
  // work) are asserted by the CALLER from the returned probe/work counts
  // against the aggregated store totals (both runs share the DEFAULT store).
  return { label, probes: probes.length, works: works.length };
}
