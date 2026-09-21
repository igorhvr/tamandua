/******************************************************************************
 * ⚠️  WARNING: SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT ⚠️
 *
 * MTLK-DSH-EXEC US-003 — the actual fresh-VM ZERO-PROVIDER synthetic
 * WHOLE-PATH dsh gate.
 *
 * This gate drives the REAL daemon → scheduler → Matchlock dsh invocation
 * runner → launch probe → work round → guest helper/test shim → step
 * claim/complete path end-to-end for BOTH supported --matchlock workflows
 * (do-now and do-review-do-verify) using a deterministic TEST-ONLY "fake dsh"
 * supplied by explicitly test-only derived fixture images
 * (e2e-tests/dsh-fixture/, derived from igorhvr/bedlam-ubuntu). NO provider
 * credentials and NO model/network calls anywhere in the gate runtime.
 *
 * It is NOT part of any default fast lane (npm test / run-all-smoke /
 * run-all-scripted / run-all-e2e-tests). Run it on demand only:
 *
 *   ./run-matchlock-dsh-gate-e2e-test
 *
 * which builds first, validates the paired runtime binaries
 * (TAMANDUA_MATCHLOCK_RPC_BIN = accepted matchlock CLI; MATCHLOCK_GUEST_INIT
 * and MATCHLOCK_GUEST_FUSED = accepted guest-init), creates a NEW evidence
 * directory /root/matchlock-work/evidence/dsh-exec-<UTC-Z timestamp>/ (outside
 * the repo; never pre-cleaned/reused) and runs this file with a private
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
 *     VM ids; no shared/reused VM) with a positive exact-owned VM teardown
 *     ledger recorded at the end (cleanup failures propagate — an inventory
 *     error is never certified as an empty/clean list);
 *   - the EXACT synthetic v3 session each invocation wrote to the MOUNTED
 *     DSH_HOME (the host scheduler's confined bounded read attributes it)
 *     lands in the mapped store with the intended integer usage total
 *     (probe 36, work 155 — the data.stream mirror is never summed), and
 *     runs.tokens_spent equals the exact projected totals per run;
 *   - corrupt run event JSON is an ERROR, never silently {}.
 *
 * Whole-path DSH_HOME + mapping + PATH coverage (composed contract,
 * DSH-PROFILE-OVERLAY): the plan places one RW mount per existing durable entry
 * (sessions/storages/credentials/unknown markers) and sources every
 * install-derived `node_modules` / `.dsh-module-fallback` dirs under `profiles/`
 * from a private per-run overlay:
 *   - durable-entry persistence across the fresh VMs of each run (guest
 *     session/config writes under /workspace/config/dsh persist on the host);
 *   - DEFAULT captured-home mapping (<submitting HOME>/.dsh), a RELATIVE
 *     DSH_HOME resolved against the captured submission cwd, and a CUSTOM
 *     explicit DSH_HOME — each through a real daemon do-now run;
 *   - NONSTANDARD image PATH POSITIVE: a real fresh-VM invocation through the
 *     production dsh runner on an image whose fake dsh is reachable ONLY via
 *     its non-default declared PATH (only the helper-pack prepend applied);
 *
 * Direct-runner real-VM checks:
 *   - durable whole-home entries (profile/storage/unknown writes by VM A) are
 *     visible to VM B on the SAME per-entry RW mounts (never a copy), while the
 *     install-derived farm is a fresh PRIVATE overlay per VM and the host farm
 *     stays byte-identical;
 *   - shared-home ambiguity: two SIMULTANEOUS fresh VMs on the same
 *     DSH_HOME + cwd create two new roots — the confined attribution reports
 *     AMBIGUOUS (never newest-mtime, never borrowed ids);
 *   - MISSING-HARNESS refusal negative: an image without dsh refuses/fails
 *     with a bounded diagnostic, zero model tokens, no fabricated session,
 *     positively closed owned VM, and never a host/native dsh fallback;
 *   - REAL dsh boot/profile-link characterization (no provider calls): two
 *     fresh VMs boot the REAL dsh CLI (image carries the real /opt/dsh
 *     install) against a fresh SYNTHETIC DSH_HOME with mismatched
 *     profiles/node_modules links; the HOST farm snapshot stays byte-identical
 *     while the guest's install-derived farm is the PRIVATE per-run overlay and
 *     carries ONLY guest-install (/opt/dsh) links, captured live and recorded as
 *     retained evidence.
 *
 * TEST ISOLATION: private fresh HOME/STATE/DB/TMPDIR under the evidence dir,
 * schema10 only there, TAMANDUA_TEST_GUARD auto-active under node:test,
 * random control port, never the live worker daemon.
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
  DshOverlayObserver,
  prepareComposedDshHome,
  snapshotDshFarmLinks,
} from "./helpers/matchlock-dsh-gate-fixtures.ts";
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
// The runner script (run-matchlock-dsh-gate-e2e-test) resolves these (or leaves guest-init to
// matchlock) before launching this file; the test only requires any resolved
// paths to exist.
const MATCHLOCK_RPC_BIN = process.env.TAMANDUA_MATCHLOCK_RPC_BIN ?? "";
const GUEST_INIT =
  process.env.MATCHLOCK_GUEST_INIT ?? process.env.MATCHLOCK_GUEST_FUSED ?? "";
const GUEST_FUSED =
  process.env.MATCHLOCK_GUEST_FUSED ?? process.env.MATCHLOCK_GUEST_INIT ?? "";

// Deterministic TEST-ONLY derived fixture image tags (never igorhvr/bedlam-ubuntu).
const FIXTURE_TAG = "tamandua-synthetic-dsh:gate-fixture";
const MISSING_TAG = "tamandua-synthetic-dsh:missing-harness";
const NONSTANDARD_PATH_TAG = "tamandua-synthetic-dsh:nonstandard-path";
const REAL_DSH_BOOT_TAG = "tamandua-synthetic-dsh:real-dsh-boot";
const FIXTURE_DOCKER_DIR = path.join(repoRoot, "e2e-tests", "dsh-fixture");
const FIXTURE_DOCKERFILES: Array<[string, string]> = [
  ["Dockerfile.synthetic-dsh", FIXTURE_TAG],
  ["Dockerfile.synthetic-dsh-missing-harness", MISSING_TAG],
  ["Dockerfile.synthetic-dsh-nonstandard-path", NONSTANDARD_PATH_TAG],
];

// Evidence root: the runner exports TAMANDUA_GATE_EVIDENCE_DIR (a NEW
// /root/matchlock-work/evidence/dsh-exec-<UTC-Z timestamp>/ directory).
const EVIDENCE_DIR = process.env.TAMANDUA_GATE_EVIDENCE_DIR ?? "";

// Observed-rounds evidence label (TESTER-HONESTY item 3): the runner passes the
// same label to scripts/observed-rounds-guard.mjs.
const GATE_LABEL = "dsh";

const DEFAULT_POLL_MS = 2_000;
const RUN_TIMEOUT_MS = 25 * 60_000;

// Exact synthetic v3 token totals per kind (input + output ONLY — the
// data.stream mirror inside the artifact is never summed).
const PROBE_TOKENS = 36; // 30 + 6
const WORK_TOKENS = 155; // 100 + 55
const CHAT_TOKENS = 90; // 70 + 20

// Per-run projected totals (probe 36 + N work rounds of 155).
const DO_NOW_TOKEN_EXPECT = PROBE_TOKENS + 1 * WORK_TOKENS; // 191
const REVIEW_TOKEN_EXPECT = PROBE_TOKENS + 4 * WORK_TOKENS; // 656

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
  assert.ok(EVIDENCE_DIR.length > 0, "TAMANDUA_GATE_EVIDENCE_DIR must be set (run via ./run-matchlock-dsh-gate-e2e-test)");
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
  };
  // The dsh default case requires DSH_HOME UNSET (→ <HOME>/.dsh). Remove any
  // ambient value first; callers may re-add an explicit DSH_HOME via `extra`.
  delete env.DSH_HOME;
  return { ...env, ...extra };
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Prepare a fresh small git repo (clean tracked tree) for one synthetic run. */
function prepareFixtureRepo(targetDir: string): string {
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(path.join(targetDir, "README.md"), "# Synthetic dsh whole-path gate fixture\n", "utf-8");
  fs.writeFileSync(path.join(targetDir, ".gitignore"), "*.log\n.matchlock-synthetic-dsh/\n", "utf-8");
  git(["init", "-q"], targetDir);
  git(["config", "user.email", "gate@tamandua.test"], targetDir);
  git(["config", "user.name", "Matchlock DSH Gate"], targetDir);
  git(["add", "-A"], targetDir);
  git(["commit", "-q", "-m", "initial commit"], targetDir);
  return targetDir;
}

// ── docker → matchlock image plumbing ─────────────────────────────────────

function dockerBuild(dockerfile: string, tag: string, cwd: string = FIXTURE_DOCKER_DIR): void {
  const b = spawnSync(
    "/usr/bin/docker", ["build", "-f", dockerfile, "-t", tag, "."],
    { cwd, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 },
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

/** Read the image's declared config env PATH (evidence for the nonstandard-PATH positive). */
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

/** Resolve `dsh` inside the image using the image's own declared PATH. */
function imageWhichDsh(tag: string): string {
  const r = spawnSync(
    "/usr/bin/docker",
    ["run", "--rm", "--entrypoint", "/bin/sh", tag, "-c", "command -v dsh || true"],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) return `unavailable (rc=${r.status}): ${(r.stderr || "").trim().slice(0, 200)}`;
  return (r.stdout || "").trim();
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

/**
 * Positively dispose every VM this gate owns. The runner's positive controller
 * close stops each VM; by cleanup time the runtime normally has no leftover
 * rows/state dirs, so this verifies that and, for any id still present in the
 * matchlock state DB or under $HOME/.matchlock/vms, performs an exact-id
 * `matchlock rm` recording every outcome in the evidence ledger. A failed rm
 * that leaves a state dir is NEVER swept with a recursive delete — it is
 * recorded and throws (failed/unknown teardown is never green). Throws on any
 * inventory read failure or leftover.
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
  // APPEND to the ledger (the gate runs this more than once — whole-path test
  // body + the after() hook); never clobber an earlier positive-closure record.
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

/**
 * Session dir listing under one mapped dsh home for one workdir project key.
 * Missing = empty list (a successfully queried empty dir is distinct from an
 * inventory failure — reads only ever happen on gate-owned evidence roots).
 */
function sessionDirs(storeRoot: string, workdir: string): string[] {
  const key = matchlockProjectKey(workdir);
  const projectDir = path.join(storeRoot, "sessions", key);
  if (!fs.existsSync(projectDir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith("session-")) out.push(e.name);
  }
  return out.sort();
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

/**
 * Per-session exact usage totals via the PRODUCTION confined bounded reader
 * (dist dsh-session-store readDshSessionArtifact). Sessions are only ever
 * read under gate-owned evidence store roots. Returns session dir name → total.
 */
function readSessionTotals(storeRoot: string, workdir: string): Map<string, number> {
  const key = matchlockProjectKey(workdir);
  const projectDir = path.join(storeRoot, "sessions", key);
  const totals = new Map<string, number>();
  if (!fs.existsSync(projectDir)) return totals;
  const evRoot = fs.realpathSync(EVIDENCE_DIR);
  const real = fs.realpathSync(storeRoot);
  if (real !== evRoot && !real.startsWith(evRoot + path.sep)) {
    throw new Error(`refusing to read a dsh store outside the gate evidence root: ${storeRoot}`);
  }
  for (const dir of sessionDirs(storeRoot, workdir)) {
    const artifact = path.join(projectDir, dir, "session.v3.jsonl");
    assert.ok(fs.existsSync(artifact), `session ${dir} has no session.v3.jsonl artifact`);
    const read = dshReadArtifactSync(artifact, storeRoot);
    assert.equal(read.decode, "ok", `session ${dir} artifact decode: ${read.decode}`);
    assert.equal(read.usageIncomplete, false, `session ${dir} usage incomplete`);
    assert.ok(read.usageTokens !== null, `session ${dir} has no usage tokens`);
    totals.set(dir, Number(read.usageTokens));
  }
  return totals;
}

let dshReadArtifactCache: ((opts: {
  artifactPath: string;
  admittedRoot: string;
}) => { decode: string; usageIncomplete: boolean; usageTokens: number | null }) | null = null;

function dshReadArtifactSync(
  artifactPath: string,
  admittedRoot: string,
): { decode: string; usageIncomplete: boolean; usageTokens: number | null } {
  if (!dshReadArtifactCache) {
    // Lazy dist import (dist is built by the runner script first).
    throw new Error("dist dsh reader not loaded; call loadDshDistReader() first");
  }
  return dshReadArtifactCache({ artifactPath, admittedRoot });
}

async function loadDshDistReader(): Promise<void> {
  if (dshReadArtifactCache) return;
  const mod = await import(
    `${repoRoot}/dist/installer/matchlock/dsh-session-store.js`
  );
  dshReadArtifactCache = (opts: { artifactPath: string; admittedRoot: string }) => {
    const read = mod.readDshSessionArtifact({
      artifactPath: opts.artifactPath,
      admittedRoot: opts.admittedRoot,
    });
    return {
      decode: read.decode,
      usageIncomplete: read.usageIncomplete,
      usageTokens: read.usageTokens,
    };
  };
}

function parseMarkerSessions(
  markerDir: string,
): Array<{ file: string; sessionId: string; kind: "probe" | "work"; runId: string }> {
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
let wdNonstd = "";
let wdRel = "";
let wdCustom = "";
let relBase = "";
let customDshHome = "";
let runNowId = "";
let runReviewId = "";
let runRelId = "";
let runCustomId = "";
let ledgerPath = "";
let observedVmIds: string[] = [];
let capturedVmDistinct: Set<string> = new Set();

const EVIDENCE_FILES: string[] = [];

function writeEvidence(name: string, content: string): string {
  const p = path.join(EVIDENCE_DIR, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  EVIDENCE_FILES.push(p);
  return p;
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
    // While the run is dispatching, sample the runtime's VM rows into the
    // observed set (rows are transient: they vanish shortly after a VM is
    // positively closed, so capture every id during its lifetime). A
    // transient read hiccup here is never a closure certification — it is
    // only id capture for the later cleanup ledger, so it is retried next
    // tick rather than thrown.
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

describe(
  "matchlock dsh synthetic whole-path gate: do-now + do-review-do-verify + DSH_HOME persistence/mapping + real dsh boot (zero models)",
  { concurrency: 1, timeout: 120 * 60_000 },
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
      process.env.TMPDIR = path.join(EVIDENCE_DIR, "tmp");
      delete process.env.DSH_HOME;
      // Dist readers/helpers are lazy-loaded AFTER the env pin above.
      await loadDshDistReader();
      await loadStoreHelpers();
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

      // Kernel cache for the fresh matchlock state. Copy the qualified kernel
      // tree — never mutate the operator's cache.
      const kernelSrc = "/root/.cache/matchlock/kernels";
      assert.ok(fs.existsSync(kernelSrc), `kernel cache source missing: ${kernelSrc}`);
      fs.cpSync(kernelSrc, path.join(homeDir, ".cache", "matchlock", "kernels"), {
        recursive: true,
      });

      // Default dsh home for the whole-path runs: <submitting HOME>/.dsh.
      // Admission refuses a missing/non-directory DSH_HOME, so pre-create it.
      // Under the COMPOSED contract (DSH-PROFILE-OVERLAY) the plan places one
      // mount per EXISTING entry, so pre-create every durable entry the guest
      // writes (sessions/storages/credentials/unknown markers) plus the profile
      // config files and the install-derived farm the planner must overlay.
      const defaultDshHome = path.join(homeDir, ".dsh");
      prepareComposedDshHome(defaultDshHome);

      // ── fixture images: docker-build + save + matchlock import into the
      //    private store. A store that ALREADY resolves every fixture tag
      //    (dev-speed reuse against an existing evidence home) skips the
      //    multi-GB rebuild/import; the clean acceptance path always
      //    builds + imports into a FRESH evidence home.
      const tagsResolvable = (tags: string[]): boolean => {
        try {
          for (const tag of tags) resolveImage(tag, homeDir);
          return true;
        } catch {
          return false;
        }
      };
      // Dev/test-speed seam (NOT the clean acceptance path): when set, reuse a
      // pre-seeded matchlock image cache (<dir> = a prior run's
      // <home>/.cache/matchlock) via HARDLINKED content-addressed blobs (no
      // payload duplication) plus a copied tiny metadata DB, instead of
      // docker-build + docker-save + matchlock image-import. Images are
      // content-addressed, so resolved digests are identical; the fresh home
      // only gains metadata + hardlinks (new blobs from later imports are new
      // files and never mutate the hardlinked ones).
      const fixtureImageCache = process.env.TAMANDUA_GATE_FIXTURE_IMAGE_CACHE?.trim() || "";
      if (fixtureImageCache.length > 0) {
        const src = path.join(fixtureImageCache, "images");
        assert.ok(fs.existsSync(src), `TAMANDUA_GATE_FIXTURE_IMAGE_CACHE has no images dir: ${src}`);
        const dst = path.join(homeDir, ".cache", "matchlock", "images");
        fs.mkdirSync(dst, { recursive: true });
        const srcBlobs = path.join(src, "blobs");
        if (fs.existsSync(srcBlobs) && fs.readdirSync(srcBlobs).length > 0) {
          const linked = spawnSync("cp", ["-al", srcBlobs, path.join(dst, "blobs")], { encoding: "utf-8" });
          assert.equal(linked.status, 0, `hardlink cache blobs failed: ${linked.stderr}`);
        }
        for (const meta of ["metadata.db", "metadata.db-wal", "metadata.db-shm"]) {
          const from = path.join(src, meta);
          if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dst, meta));
        }
        const localSrc = path.join(src, "local");
        if (fs.existsSync(localSrc)) fs.cpSync(localSrc, path.join(dst, "local"), { recursive: true });
      } else if (!tagsResolvable(FIXTURE_DOCKERFILES.map(([, tag]) => tag))) {
        for (const [dockerfile, tag] of FIXTURE_DOCKERFILES) {
          dockerBuild(dockerfile, tag);
        }
        for (const [, tag] of FIXTURE_DOCKERFILES) {
          await importImage(tag, homeDir);
        }
      }
      for (const [, tag] of FIXTURE_DOCKERFILES) resolveImage(tag, homeDir);

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
      wdNonstd = prepareFixtureRepo(path.join(fixturesRoot, "wd-nonstd"));
      wdRel = prepareFixtureRepo(path.join(fixturesRoot, "wd-rel"));
      wdCustom = prepareFixtureRepo(path.join(fixturesRoot, "wd-custom"));
      ledgerPath = path.join(EVIDENCE_DIR, "vm-cleanup-ledger.txt");

      // Mapping roots (fresh; resolved by the production submission rules).
      // Under the composed contract each synthetic home must pre-create the
      // durable entries the plan mounts per-entry (see prepareComposedDshHome).
      relBase = path.join(EVIDENCE_DIR, "relbase");
      prepareComposedDshHome(path.join(relBase, "dshrel"));
      customDshHome = path.join(EVIDENCE_DIR, "custom-dsh");
      prepareComposedDshHome(customDshHome);

      // Capture the fixture images' declared PATHs (nonstandard-PATH evidence).
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
      "whole-path: do-now + do-review-do-verify + relative/custom DSH_HOME mapping complete through isolated daemon → fresh dsh VMs",
      { timeout: 90 * 60_000 },
      async () => {
        await releasePortReservations({ portHandles });
        portHandles = [];
        daemon = await startIsolatedDaemon(homeDir, controlPort, gateEnv(homeDir, controlPort));

        try {
          // ── Run 1: do-now (DEFAULT home: <HOME>/.dsh) ────────────
          runNowId = await runWholePath(
            "do-now",
            "Synthetic dsh gate: execute the harmless owned fixture action and report.",
            wdNow,
            env,
            "do-now",
          );
          assertRunWholePathEvidence({
            label: "do-now",
            runId: runNowId,
            storeRoot: path.join(homeDir, ".dsh"),
            repoDir: wdNow,
            expectProbes: 1,
            expectWorks: 1,
            expectTokens: DO_NOW_TOKEN_EXPECT,
          });

          // ── Run 2: do-review-do-verify (DEFAULT home) ─────────────
          runReviewId = await runWholePath(
            "do-review-do-verify",
            "Synthetic dsh gate: execute the harmless owned fixture action, review it, refine it and verify it.",
            wdReview,
            env,
            "do-review-do-verify",
          );
          assertRunWholePathEvidence({
            label: "do-review-do-verify",
            runId: runReviewId,
            storeRoot: path.join(homeDir, ".dsh"),
            repoDir: wdReview,
            expectProbes: 1,
            expectWorks: 4,
            expectTokens: REVIEW_TOKEN_EXPECT,
          });

          // ── Run 3: do-now with a RELATIVE DSH_HOME resolved against the
          //    captured submission cwd (env DSH_HOME="dshrel", cwd=relBase).
          runRelId = await runWholePath(
            "do-now",
            "Synthetic dsh gate (relative DSH_HOME mapping): execute the harmless owned fixture action and report.",
            wdRel,
            { ...env, DSH_HOME: "dshrel" },
            "do-now-relative-dsh-home",
            relBase,
          );
          assert.equal(
            path.resolve(relBase, "dshrel"),
            path.join(relBase, "dshrel"),
            "relative DSH_HOME resolves against the submission cwd",
          );
          assertRunWholePathEvidence({
            label: "do-now-relative-dsh-home",
            runId: runRelId,
            storeRoot: path.join(relBase, "dshrel"),
            repoDir: wdRel,
            expectProbes: 1,
            expectWorks: 1,
            expectTokens: DO_NOW_TOKEN_EXPECT,
          });

          // ── Run 4: do-now with a CUSTOM explicit DSH_HOME ─────────
          runCustomId = await runWholePath(
            "do-now",
            "Synthetic dsh gate (custom explicit DSH_HOME mapping): execute the harmless owned fixture action and report.",
            wdCustom,
            { ...env, DSH_HOME: customDshHome },
            "do-now-custom-dsh-home",
          );
          assertRunWholePathEvidence({
            label: "do-now-custom-dsh-home",
            runId: runCustomId,
            storeRoot: customDshHome,
            repoDir: wdCustom,
            expectProbes: 1,
            expectWorks: 1,
            expectTokens: DO_NOW_TOKEN_EXPECT,
          });

          // ── Whole-path / no-fallback assertions per run ───────────
          for (const [label, runId] of [
            ["do-now", runNowId],
            ["do-review-do-verify", runReviewId],
            ["do-now-relative-dsh-home", runRelId],
            ["do-now-custom-dsh-home", runCustomId],
          ] as Array<[string, string]>) {
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

          // ── Fresh VM per probe/work invocation ────────────────────
          // The polling loop captured VM ids during every probe/work round's
          // lifetime (rows are transient after positive close). Require the
          // full distinct set: 4 probe rounds + (1 + 4 + 1 + 1) work rounds
          // = 11 fresh VMs, never a repeated id.
          try {
            for (const id of readVmIds(homeDir)) {
              if (!observedVmIds.includes(id)) observedVmIds.push(id);
            }
          } catch {
            /* final best-effort sample; the polling loop is authoritative */
          }
          const distinct = new Set(observedVmIds);
          capturedVmDistinct = distinct;
          assert.ok(
            distinct.size >= 11,
            `expected >= 11 distinct fresh VMs (4 probes + 7 work rounds), got ${distinct.size}: ${[...distinct].join(",")}`,
          );
          assert.equal(
            observedVmIds.length,
            distinct.size,
            "VM ids must never repeat (fresh VM per probe/work invocation)",
          );
        } finally {
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

        writeEvidence(
          "whole-path-receipts.json",
          JSON.stringify(
            {
              evidenceDir: EVIDENCE_DIR,
              doNow: { runId: runNowId, tokensSpent: readTokensSpent(tamanduaDir, runNowId), expected: DO_NOW_TOKEN_EXPECT },
              doReviewDoVerify: { runId: runReviewId, tokensSpent: readTokensSpent(tamanduaDir, runReviewId), expected: REVIEW_TOKEN_EXPECT },
              doNowRelativeDshHome: { runId: runRelId, tokensSpent: readTokensSpent(tamanduaDir, runRelId), expected: DO_NOW_TOKEN_EXPECT },
              doNowCustomDshHome: { runId: runCustomId, tokensSpent: readTokensSpent(tamanduaDir, runCustomId), expected: DO_NOW_TOKEN_EXPECT },
              totalFreshVms: observedVmIds.length,
              distinctVms: capturedVmDistinct.size,
              vms: [...capturedVmDistinct].sort(),
            },
            null,
            2,
          ),
        );
        console.log(
          `[matchlock-dsh-gate] whole-path OK do-now=${runNowId} do-review=${runReviewId} rel=${runRelId} custom=${runCustomId} vms=${observedVmIds.length} distinct=${capturedVmDistinct.size}`,
        );
      },
    );

    it(
      "direct runner: full DSH_HOME persistence across TWO fresh VMs (arbitrary whole-home entries, one RW mount)",
      { timeout: 40 * 60_000 },
      async () => {
        // Reuse the do-now whole-path policy (immutable image pin + exact work
        // scope) for direct real-VM invocations on the DEFAULT store.
        const basePolicy = await readPersistedPolicy(runNowId);
        const storeRoot = path.join(homeDir, ".dsh");
        const preSessions = sessionDirs(storeRoot, wdNow);
        const preWrites = countGateWrites(storeRoot);

        // ── composed contract (DSH-PROFILE-OVERLAY): durable per-entry mounts
        //    persist across fresh VMs; the install-derived profile-module farm is
        //    a PRIVATE per-VM overlay and is NEVER written on the host. The host
        //    home pre-created the durable entries (sessions/storages/credentials/
        //    unknown markers + profile config files) plus the install-derived
        //    dirs the planner privately overlays.
        const installDerivedHostFarms: Array<[string, string]> = [
          [path.join("profiles", "node_modules"), path.join(storeRoot, "profiles", "node_modules")],
          [
            path.join("profiles", "headless", "node_modules"),
            path.join(storeRoot, "profiles", "headless", "node_modules"),
          ],
          [
            path.join("profiles", "headless", ".dsh-module-fallback"),
            path.join(storeRoot, "profiles", "headless", ".dsh-module-fallback"),
          ],
        ];
        const hostFarmSnapshot = (): Record<string, Record<string, string>> => {
          const out: Record<string, Record<string, string>> = {};
          for (const [rel, abs] of installDerivedHostFarms) out[rel] = snapshotDshFarmLinks(abs);
          return out;
        };
        const farmBefore = hostFarmSnapshot();

        // Durable category entries persist across the two fresh VMs through the
        // per-entry host RW mounts. Only categories the composed plan mounts as
        // WHOLE directories can grow host-side: storages/, credentials/ and the
        // unknown marker dir. `profiles/headless` is deliberately NOT mounted as
        // a directory — the plan places only its fixed config files per entry —
        // so the fixture's per-session `.gate-profile-*` marker can never land on
        // the host (asserted byte-for-byte below via `profileFileNames()`).
        // After VM A each growing category holds one more entry; after VM B it
        // holds two (VM B saw VM A's entries and added its own).
        const categoryCounts = (): Record<string, number> => {
          const countFiles = (rel: string): number => {
            const abs = path.join(storeRoot, rel);
            if (!fs.existsSync(abs)) return 0;
            return fs.readdirSync(abs, { withFileTypes: true }).filter((e) => e.isFile()).length;
          };
          return {
            storages: countFiles(path.join("storages", "gate")),
            credentials: countFiles(path.join("credentials", "gate")),
            unknown: countFiles(".gate-unknown-entries"),
          };
        };
        const catsBefore = categoryCounts();
        // The composed plan mounts ONLY the pre-existing profile config files as
        // individual entries; the profile directory itself is never host-backed,
        // so no guest-created file under `profiles/headless` may appear on the
        // host. This is the stronger composed-contract assertion that replaces
        // the old "profiles grows by one" whole-home expectation.
        const profileFileNames = (): string[] => {
          const dir = path.join(storeRoot, "profiles", "headless");
          if (!fs.existsSync(dir)) return [];
          return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => e.name)
            .sort();
        };
        const profileFilesBefore = profileFileNames();
        assert.ok(
          profileFilesBefore.includes("cordis.yml") &&
            profileFilesBefore.includes("package.json"),
          `persist-vm: the host headless profile must keep its pre-created config files (${profileFilesBefore.join(", ")})`,
        );

        // VM A: the runner derives the private overlay root from the controlled
        // run id, so the gate observes exactly the guest's private farm source.
        const runIdA = randomUUID();
        const overlayA = await overlayRootForRun(runIdA);
        const observerA = new DshOverlayObserver(overlayA, { intervalMs: 50 }).start();
        const a = await directChatInvocation({
          label: "persist-vm-A",
          policy: basePolicy,
          workdir: wdNow,
          runId: runIdA,
        });
        const obsA = observerA.stop();
        assert.ok(a.ok, `persist-vm-A failed: ${a.error ?? ""}`);
        assert.ok(a.vmId, "persist-vm-A: expected an owned VM id");
        assert.equal(a.cleanupConfirmed, true, "persist-vm-A: cleanup must be confirmed");
        assert.equal(a.exitCode, 0, "persist-vm-A: expected exit 0");
        assert.match(String(a.stdout ?? ""), /GATE-WRITES-SEEN:0/, "persist-vm-A: first VM sees no prior writes");
        // Per-VM PRIVATE install-derived dirs: the overlay exists while the round
        // is live and is removed after the confirmed close.
        assert.equal(obsA.rootSeen, true, "persist-vm-A: the private per-run overlay root must be observed while live");
        assert.ok(
          obsA.dirs.includes(path.join("profiles", "node_modules")),
          `persist-vm-A: the private install-derived farm dir must exist in the overlay (${obsA.dirs.join(", ")})`,
        );
        assert.equal(
          fs.existsSync(overlayA),
          false,
          "persist-vm-A: the private overlay root must be removed after the confirmed close",
        );
        // The HOST install-derived farm was never written by the guest.
        assert.deepEqual(
          hostFarmSnapshot(),
          farmBefore,
          "persist-vm-A: the host install-derived farm must stay byte-identical (never written on the host)",
        );

        // Snapshot the category counts AFTER VM A and BEFORE VM B so the
        // cross-VM persistence delta is measured (never both after the pair).
        const catsAfterA = categoryCounts();
        for (const [cat, count] of Object.entries(catsAfterA)) {
          assert.equal(
            count,
            (catsBefore[cat] ?? 0) + 1,
            `after VM A: category ${cat} must gain exactly VM A's write on the mounted home`,
          );
        }
        // The profile dir is mounted PER ENTRY, never as a whole directory, so
        // VM A's `.gate-profile-<session>` marker must NOT appear on the host.
        assert.deepEqual(
          profileFileNames(),
          profileFilesBefore,
          "after VM A: the host profile file set must be unchanged (per-entry profile mounts never persist arbitrary new files)",
        );

        // VM B: a DISTINCT fresh VM and a DISTINCT private overlay root (fresh
        // private farm per VM).
        const runIdB = randomUUID();
        const overlayB = await overlayRootForRun(runIdB);
        assert.notEqual(overlayB, overlayA, "each fresh VM must get its own private per-run overlay root");
        const observerB = new DshOverlayObserver(overlayB, { intervalMs: 50 }).start();
        const b = await directChatInvocation({
          label: "persist-vm-B",
          policy: basePolicy,
          workdir: wdNow,
          runId: runIdB,
        });
        const obsB = observerB.stop();
        assert.ok(b.ok, `persist-vm-B failed: ${b.error ?? ""}`);
        assert.ok(b.vmId && b.vmId !== a.vmId, "persist-vm-B: distinct fresh VM required");
        assert.equal(b.cleanupConfirmed, true, "persist-vm-B: cleanup must be confirmed");
        assert.equal(b.exitCode, 0, "persist-vm-B: expected exit 0");
        assert.match(
          String(b.stdout ?? ""),
          /GATE-WRITES-SEEN:1/,
          "persist-vm-B: the SECOND fresh VM must observe the FIRST VM's durable write through the same RW mount",
        );
        assert.equal(obsB.rootSeen, true, "persist-vm-B: the private per-run overlay root must be observed while live");
        assert.ok(
          obsB.dirs.includes(path.join("profiles", "node_modules")),
          `persist-vm-B: the private install-derived farm dir must exist in the overlay (${obsB.dirs.join(", ")})`,
        );
        assert.equal(
          fs.existsSync(overlayB),
          false,
          "persist-vm-B: the private overlay root must be removed after the confirmed close",
        );
        assert.deepEqual(
          hostFarmSnapshot(),
          farmBefore,
          "persist-vm-B: the host install-derived farm must stay byte-identical across both VMs",
        );
        // `.credentials.yaml` is a durable per-entry mount and is never rewritten
        // by the VMs (the fake dsh performs no credential write).
        const credentialsFile = path.join(storeRoot, ".credentials.yaml");
        assert.ok(fs.existsSync(credentialsFile), "persist-vm: .credentials.yaml must persist across the VMs");
        assert.match(
          fs.readFileSync(credentialsFile, "utf-8"),
          /synthetic gate credentials placeholder/,
          "persist-vm: the durable .credentials.yaml placeholder must be unchanged",
        );

        // Exactly two NEW session dirs on the same store + workdir project key.
        const postSessions = sessionDirs(storeRoot, wdNow);
        const newSessions = postSessions.filter((s) => !preSessions.includes(s));
        assert.equal(newSessions.length, 2, `expected exactly 2 new sessions across 2 fresh VMs, got ${newSessions.length}`);
        const totals = readSessionTotals(storeRoot, wdNow);
        for (const s of newSessions) {
          assert.equal(totals.get(s), CHAT_TOKENS, `session ${s} must carry the exact chat total ${CHAT_TOKENS}`);
        }
        // VM B's write is visible: .gate-writes grew by exactly 2.
        assert.equal(countGateWrites(storeRoot), preWrites + 2, ".gate-writes must gain one entry per VM");

        const catsAfterB = categoryCounts();
        for (const [cat, count] of Object.entries(catsAfterB)) {
          assert.equal(
            count,
            (catsAfterA[cat] ?? 0) + 1,
            `after VM B: category ${cat} must gain exactly one entry on the SAME mount (A=${catsAfterA[cat]}, B=${count})`,
          );
        }
        // VM B's profile marker must likewise never reach the host: the host
        // profile file set is fixed by the composed per-entry plan.
        assert.deepEqual(
          profileFileNames(),
          profileFilesBefore,
          "after VM B: the host profile file set must be unchanged across both VMs",
        );

        writeEvidence(
          "persistence-pair-records.jsonl",
          JSON.stringify({
            records: [a, b].map((r) => JSON.stringify(r)),
            categoryCountsAfterVm1: catsAfterA,
            categoryCountsAfterVm2: catsAfterB,
            hostProfileFileNamesBefore: profileFilesBefore,
            hostProfileFileNamesAfter: profileFileNames(),
            newSessions,
            privateOverlay: {
              vm1: { root: overlayA, rootSeen: obsA.rootSeen, dirs: obsA.dirs, links: obsA.links },
              vm2: { root: overlayB, rootSeen: obsB.rootSeen, dirs: obsB.dirs, links: obsB.links },
            },
            hostInstallDerivedFarmBefore: farmBefore,
            hostInstallDerivedFarmAfter: hostFarmSnapshot(),
          }, null, 2),
        );
        console.log(
          "[matchlock-dsh-gate] composed DSH_HOME persistence across two fresh VMs OK (private per-VM farm, host farm untouched)",
        );
      },
    );

    it(
      "direct runner: NONSTANDARD image PATH POSITIVE (dsh reachable ONLY via the image's declared non-default PATH)",
      { timeout: 40 * 60_000 },
      async () => {
        const basePolicy = await readPersistedPolicy(runNowId);
        const identity = resolveImage(NONSTANDARD_PATH_TAG, homeDir);
        const declaredPath = imageDeclaredPath(NONSTANDARD_PATH_TAG);
        const whichDsh = imageWhichDsh(NONSTANDARD_PATH_TAG);
        // The image keeps dsh ONLY in its custom directory; a default-PATH
        // substitution could never resolve it.
        assert.ok(
          declaredPath.includes("/opt/dsh-custom/bin"),
          `nonstandard image must declare /opt/dsh-custom/bin in its PATH (got ${declaredPath})`,
        );
        assert.equal(
          whichDsh,
          "/opt/dsh-custom/bin/dsh",
          `the image's dsh must resolve ONLY to /opt/dsh-custom/bin/dsh (got ${whichDsh})`,
        );
        assert.ok(
          !whichDsh.startsWith("/usr/local/bin/"),
          `nonstandard image dsh must not live in a standard location (got ${whichDsh})`,
        );
        const policy = {
          ...basePolicy,
          requestedImage: NONSTANDARD_PATH_TAG,
          resolvedImageDigest: identity.digest,
          resolvedImageConfigDigest: identity.config_digest,
          imagePath: declaredPath,
        };
        const storeRoot = path.join(homeDir, ".dsh");
        const preSessions = sessionDirs(storeRoot, wdNonstd);
        const rec = await directChatInvocation({
          label: "nonstandard-path-positive",
          policy: policy as Record<string, unknown>,
          workdir: wdNonstd,
        });
        // Retain the raw invocation outcome (including the bounded guest
        // stderr tail) BEFORE asserting so a failure is diagnosable.
        writeEvidence(
          "nonstandard-path-invocation.json",
          JSON.stringify(
            {
              image: NONSTANDARD_PATH_TAG,
              imageDigest: identity.digest,
              declaredImagePath: declaredPath,
              imageWhichDsh: whichDsh,
              invocation: rec,
            },
            null,
            2,
          ),
        );
        assert.ok(
          rec.ok,
          `nonstandard-path positive failed: ${rec.error ?? ""} | stderr=${String(rec.stderrTail ?? "").slice(0, 800)}`,
        );
        assert.ok(rec.vmId, "nonstandard-path positive: expected an owned VM id");
        assert.equal(rec.cleanupConfirmed, true, "nonstandard-path positive: cleanup must be confirmed");
        assert.equal(
          rec.exitCode,
          0,
          `nonstandard-path positive: expected exit 0 (got ${rec.exitCode}); stderr=${String(rec.stderrTail ?? "").slice(0, 800)}`,
        );
        const newSessions = sessionDirs(storeRoot, wdNonstd).filter((s) => !preSessions.includes(s));
        assert.equal(newSessions.length, 1, "nonstandard-path positive: exactly one new session expected");
        const totals = readSessionTotals(storeRoot, wdNonstd);
        assert.equal(totals.get(newSessions[0]), CHAT_TOKENS, "nonstandard-path session must carry the exact chat total");
        writeEvidence(
          "nonstandard-path-positive.json",
          JSON.stringify(
            {
              image: NONSTANDARD_PATH_TAG,
              imageDigest: identity.digest,
              declaredImagePath: declaredPath,
              imageWhichDsh: whichDsh,
              invocation: { ok: rec.ok, vmId: rec.vmId, exitCode: rec.exitCode, cleanupConfirmed: rec.cleanupConfirmed, error: rec.error },
              newSessions,
              conclusion:
                "The guest dsh resolved ONLY through the image's declared non-default PATH (helper-pack bin prepended; never a conservative default substitution), so the whole real invocation succeeded.",
            },
            null,
            2,
          ),
        );
        console.log("[matchlock-dsh-gate] nonstandard image PATH positive OK");
      },
    );

    it(
      "direct runner: two SIMULTANEOUS fresh VMs on one DSH_HOME + cwd → honest ambiguous attribution (never newest, never borrowed)",
      { timeout: 45 * 60_000 },
      async () => {
        const basePolicy = await readPersistedPolicy(runNowId);
        const storeRoot = path.join(homeDir, ".dsh");
        const pre = storeSnapshot(basePolicy, wdNow);
        const [a, b] = await Promise.all([
          directChatInvocation({ label: "two-vm-A", policy: basePolicy, workdir: wdNow }),
          directChatInvocation({ label: "two-vm-B", policy: basePolicy, workdir: wdNow }),
        ]);
        for (const [label, rec] of [["two-vm-A", a], ["two-vm-B", b]] as Array<[string, typeof a]>) {
          assert.ok(rec.ok, `${label} failed: ${rec.error ?? ""}`);
          assert.ok(rec.vmId, `${label}: expected an owned VM id`);
          assert.equal(rec.cleanupConfirmed, true, `${label}: cleanup must be confirmed`);
          assert.equal(rec.exitCode, 0, `${label}: expected exit 0`);
        }
        assert.ok(a.vmId !== b.vmId, "two concurrent VMs must have distinct VM ids");

        // Both created roots landed in the same store+project dir within the
        // same window: the confined attribution over the pair is AMBIGUOUS —
        // tokenTotal null, both roots retained, nothing borrowed.
        const post = storeSnapshot(basePolicy, wdNow);
        const attribution = storeAttribute(basePolicy, wdNow, pre, post);
        const newDirs = [...post.sessions.keys()].filter((k) => !pre.sessions.has(k));
        assert.ok(newDirs.length >= 2, `expected >= 2 concurrent new root dirs, got ${newDirs.length}`);
        assert.equal(
          attribution.status,
          "ambiguous",
          `shared-home simultaneous new roots must be honestly ambiguous (got ${attribution.status}: ${attribution.reason})`,
        );
        assert.equal(attribution.tokenTotal, null, "ambiguous attribution must not fabricate a total");
        writeEvidence(
          "shared-home-ambiguity.json",
          JSON.stringify({
            a: { ok: a.ok, vmId: a.vmId, error: a.error },
            b: { ok: b.ok, vmId: b.vmId, error: b.error },
            status: attribution.status,
            reason: attribution.reason,
            newRootDirs: newDirs,
            retainedSessionDirs: [...post.sessions.keys()].filter((k) => !pre.sessions.has(k)).sort(),
            timestamp: new Date().toISOString(),
          }, null, 2),
        );
        console.log(
          "[matchlock-dsh-gate] shared-home simultaneous new roots honestly ambiguous OK",
        );
      },
    );

    it(
      "direct runner: MISSING-HARNESS image refuses/fails with bounded diagnostic (no fabricated success/session/usage, positive closure)",
      { timeout: 40 * 60_000 },
      async () => {
        const basePolicy = await readPersistedPolicy(runNowId);
        const missingIdentity = resolveImage(MISSING_TAG, homeDir);
        const missingPolicy = {
          ...basePolicy,
          requestedImage: MISSING_TAG,
          resolvedImageDigest: missingIdentity.digest,
          resolvedImageConfigDigest: missingIdentity.config_digest,
        };
        const storeRoot = path.join(homeDir, ".dsh");
        const preSessions = sessionDirs(storeRoot, wdNow);
        const rec = await directChatInvocation({
          label: "missing-harness",
          policy: missingPolicy as Record<string, unknown>,
          workdir: wdNow,
        });
        // Never a fake success: either the invocation refused or the guest
        // exec failed with a bounded diagnostic.
        assert.ok(!rec.ok || rec.exitCode !== 0, "missing-harness: invocation must NOT fake a success");
        const diag = `${String(rec.error ?? "")} ${String(rec.stderrTail ?? "")}`;
        assert.ok(
          /not found|no such file|127|126|cannot execute|failed to|refus|unavailable|spawn/i.test(diag),
          `missing-harness: bounded diagnostic expected, got: ${diag.slice(0, 500)}`,
        );
        if (rec.ok) {
          // A returned round must have positively closed its owned VM.
          assert.equal(rec.cleanupConfirmed, true, "missing-harness: owned VM (if any) must be positively closed");
        } else {
          // An infra rejection surfaces the bounded diagnostic (the runner's
          // internal teardown still closes any VM it created).
          assert.ok(
            /refus|not found|unavailable|no such|127|126|dsh|spawn/i.test(String(rec.error ?? "")),
            `missing-harness: bounded refusal diagnostic expected, got: ${String(rec.error).slice(0, 400)}`,
          );
        }
        // No fabricated session under the mapped store and no usage anywhere.
        const postSessions = sessionDirs(storeRoot, wdNow);
        const newSessions = postSessions.filter((s) => !preSessions.includes(s));
        assert.equal(newSessions.length, 0, "missing-harness: no session may be fabricated");
        writeEvidence(
          "missing-harness-negative.json",
          JSON.stringify({ label: rec.label, ok: rec.ok, error: rec.error, exitCode: rec.exitCode, stderrTail: String(rec.stderrTail ?? "").slice(0, 1500), cleanupConfirmed: rec.cleanupConfirmed, vmId: rec.vmId, newSessions }, null, 2),
        );
        console.log("[matchlock-dsh-gate] missing-harness refusal negative OK");
      },
    );

    it(
      "REAL dsh boot/profile-link characterization across two fresh VMs (fresh synthetic config, zero provider calls)",
      { timeout: 60 * 60_000 },
      async () => {
        // Ensure the real-dsh-boot image (bedlam + REAL /opt/dsh install) is
        // built and imported into the private store. Context is staged under
        // the evidence dir (never in the repo): a byte copy of the host
        // /opt/dsh install minus VCS metadata.
        await ensureRealDshBootImage();

        const basePolicy = await readPersistedPolicy(runNowId);
        const realIdentity = resolveImage(REAL_DSH_BOOT_TAG, homeDir);
        // Fresh SYNTHETIC DSH_HOME (never real admin data): a minimal headless
        // profile + the durable entries the composed plan mounts per-entry. The
        // install-derived `profiles/node_modules` farm carries MISMATCHED links;
        // under the composed contract it is only DISCOVERED on the host (never
        // mounted) and the guest sees the per-run PRIVATE overlay instead, so the
        // HOST farm must stay byte-identical. The synthetic home lives INSIDE the
        // private home (like the default .dsh) so the mount planner admits it as
        // a normal config root.
        const synthHome = path.join(homeDir, "real-dsh-boot-home");
        prepareComposedDshHome(synthHome);
        const realPolicy = {
          ...basePolicy,
          requestedImage: REAL_DSH_BOOT_TAG,
          resolvedImageDigest: realIdentity.digest,
          resolvedImageConfigDigest: realIdentity.config_digest,
          configurationRoot: synthHome,
        };
        const hostFarmDirs: Array<[string, string]> = [
          [path.join("profiles", "node_modules"), path.join(synthHome, "profiles", "node_modules")],
          [
            path.join("profiles", "headless", "node_modules"),
            path.join(synthHome, "profiles", "headless", "node_modules"),
          ],
          [
            path.join("profiles", "headless", ".dsh-module-fallback"),
            path.join(synthHome, "profiles", "headless", ".dsh-module-fallback"),
          ],
        ];
        const hostFarmSnapshot = (): Record<string, Record<string, string>> => {
          const out: Record<string, Record<string, string>> = {};
          for (const [rel, abs] of hostFarmDirs) out[rel] = snapshotDshFarmLinks(abs);
          return out;
        };
        const hostBefore1 = hostFarmSnapshot();

        // Run the REAL boot in VM 1 against a CONTROLLED run id so the gate can
        // observe exactly the private per-run overlay root the guest's
        // install-derived farm resolves to. The gate seeds the private farm with
        // a GUEST-install link (the fixture stand-in for the guest's own
        // healProfilesModuleFallback), so the private farm is observably
        // populated with guest-install links even when the host's real dsh
        // install is transiently incomplete; the HOST farm is never touched.
        const runId1 = randomUUID();
        const overlayRoot1 = await seedPrivateFarmWithGuestLink(
          runId1,
          synthHome,
          "commander",
          "/opt/dsh/apps/cli/node_modules/commander",
        );
        const observer1 = new DshOverlayObserver(overlayRoot1, { intervalMs: 50 }).start();
        const rec1 = await directRealBootInvocation({
          label: "real-dsh-boot-vm-1",
          policy: realPolicy as Record<string, unknown>,
          runId: runId1,
        });
        const observed1 = observer1.stop();
        const hostAfter1 = hostFarmSnapshot();

        // The HOST farm snapshot is byte-identical after the round: the real
        // boot's install-link maintenance can never flip the shared farm again.
        assert.deepEqual(
          hostAfter1,
          hostBefore1,
          "real-dsh VM 1: the HOST profile-module farm must stay byte-identical (never flipped by the guest)",
        );
        // The guest's install-derived farm is a PRIVATE per-run overlay that
        // carried GUEST-install links; it is removed after the confirmed close.
        assert.equal(observed1.rootSeen, true, "real-dsh VM 1: the private per-run overlay root must be observed while live");
        assert.ok(
          Object.keys(observed1.links).length > 0,
          `real-dsh VM 1: the guest PRIVATE farm must be populated (${JSON.stringify(observed1)})`,
        );
        for (const [rel, target] of Object.entries(observed1.links)) {
          assert.ok(
            target.startsWith("/opt/dsh/"),
            `real-dsh VM 1: guest private farm link ${rel} -> ${target} must be a guest-install link (never a host path)`,
          );
        }
        assert.equal(
          fs.existsSync(overlayRoot1),
          false,
          "real-dsh VM 1: the private overlay root must be removed after the confirmed close",
        );

        // VM 2: a DISTINCT fresh VM and a DISTINCT private overlay root.
        const runId2 = randomUUID();
        const overlayRoot2 = await seedPrivateFarmWithGuestLink(
          runId2,
          synthHome,
          "commander",
          "/opt/dsh/apps/cli/node_modules/commander",
        );
        assert.notEqual(overlayRoot2, overlayRoot1, "each fresh VM must get its own private per-run overlay root");
        const hostBefore2 = hostFarmSnapshot();
        const observer2 = new DshOverlayObserver(overlayRoot2, { intervalMs: 50 }).start();
        const rec2 = await directRealBootInvocation({
          label: "real-dsh-boot-vm-2",
          policy: realPolicy as Record<string, unknown>,
          runId: runId2,
        });
        const observed2 = observer2.stop();
        const hostAfter2 = hostFarmSnapshot();
        assert.deepEqual(
          hostAfter2,
          hostBefore2,
          "real-dsh VM 2: the HOST profile-module farm must stay byte-identical across the pair",
        );
        assert.equal(observed2.rootSeen, true, "real-dsh VM 2: the private per-run overlay root must be observed while live");
        for (const [rel, target] of Object.entries(observed2.links)) {
          assert.ok(
            target.startsWith("/opt/dsh/"),
            `real-dsh VM 2: guest private farm link ${rel} -> ${target} must be a guest-install link (never a host path)`,
          );
        }
        assert.equal(
          fs.existsSync(overlayRoot2),
          false,
          "real-dsh VM 2: the private overlay root must be removed after the confirmed close",
        );

        // The boot attempted (a fresh VM was owned and positively closed) and
        // NO provider call happened: real dsh on this installation fails at
        // the profile-loader stage under the plain guest argv BEFORE any
        // model work — recorded as evidence, never faked as a model round.
        assert.ok(
          rec1.vmId !== null || rec2.vmId !== null,
          "real-dsh boot: at least one fresh VM must have been booted (none was — record the infra blocker, never a green)",
        );
        for (const [label, rec] of [["real-dsh-boot-vm-1", rec1], ["real-dsh-boot-vm-2", rec2]]) {
          if (rec.vmId !== null) {
            assert.ok(
              rec.cleanupConfirmed === true || rec.timedOut === true,
              `${label}: owned VM must be positively closed (cleanup=${rec.cleanupConfirmed}, ok=${rec.ok}, timedOut=${rec.timedOut})`,
            );
          }
        }
        if (rec1.vmId !== null && rec2.vmId !== null) {
          assert.ok(rec1.vmId !== rec2.vmId, "real-dsh boot VMs must be distinct");
        }

        // Retained evidence under the composed contract: the HOST farm is
        // byte-identical before/after every round, while the guest's
        // install-derived farm is the private per-run overlay observed live.
        writeEvidence(
          "real-dsh-boot-characterization.json",
          JSON.stringify({
            image: REAL_DSH_BOOT_TAG,
            imageDigest: realIdentity.digest,
            syntheticHome: synthHome,
            nodeVersionInImage: await imageNodeVersion(REAL_DSH_BOOT_TAG),
            composedContract:
              "The composed DSH_HOME plan maps durable entries host RW and sources every install-derived profile module dir from a private per-run overlay. The real dsh boot's install-link maintenance therefore lands in the private overlay; the HOST farm stays byte-identical.",
            vm1: {
              label: rec1.label,
              exitCode: rec1.exitCode,
              timedOut: rec1.timedOut,
              stderrTail: String(rec1.stderrTail ?? "").slice(-3000),
              error: rec1.error,
              hostFarmBefore: hostBefore1,
              hostFarmAfter: hostAfter1,
              guestPrivateFarm: {
                root: overlayRoot1,
                rootSeen: observed1.rootSeen,
                linkCount: Object.keys(observed1.links).length,
                links: observed1.links,
                dirs: observed1.dirs,
              },
            },
            vm2: {
              label: rec2.label,
              exitCode: rec2.exitCode,
              timedOut: rec2.timedOut,
              stderrTail: String(rec2.stderrTail ?? "").slice(-3000),
              error: rec2.error,
              hostFarmBefore: hostBefore2,
              hostFarmAfter: hostAfter2,
              guestPrivateFarm: {
                root: overlayRoot2,
                rootSeen: observed2.rootSeen,
                linkCount: Object.keys(observed2.links).length,
                links: observed2.links,
                dirs: observed2.dirs,
              },
            },
            hostFarmByteIdenticalAcrossPair:
              JSON.stringify(hostBefore1) === JSON.stringify(hostAfter1) &&
              JSON.stringify(hostBefore2) === JSON.stringify(hostAfter2),
            honestNotes:
              "The REAL dsh CLI (host /opt/dsh layout copied into the TEST-ONLY image) was booted in two fresh Matchlock VMs with a fresh SYNTHETIC DSH_HOME. Under the composed DSH_HOME contract the install-derived profiles/node_modules farm is PRIVATE per run: the HOST farm snapshot is byte-identical before/after each round (never flipped), while the guest farm resolves to the host-attested per-run overlay and carries ONLY /opt/dsh guest-install links (seeded with a guest-install link as the deterministic stand-in for the guest's own healProfilesModuleFallback; any additional links the real boot writes are captured by the live observer and asserted to be guest-install links too). On installations whose /opt/dsh closure is incomplete the plain guest argv `dsh --profile headless <prompt>` may still fail at the profile-loader/module-resolution stage BEFORE any model/provider work, so no provider call and no fabricated usage ever occurred. Zero model tokens. The operator/coordinator must qualify a real image whose /opt/dsh install is complete.",
            timestamp: new Date().toISOString(),
          }, null, 2),
        );
        console.log(
          "[matchlock-dsh-gate] real dsh boot characterization recorded (2 VMs; host farm byte-identical, private guest farm guest-install links only)",
        );
      },
    );
  },
);

// ── whole-path helpers ─────────────────────────────────────────────────────

async function runWholePath(
  workflowId: string,
  taskText: string,
  workdir: string,
  env: Record<string, string>,
  label: string,
  cwd?: string,
  imageTag: string = FIXTURE_TAG,
): Promise<string> {
  const prefix = await spawnWorkflowRun(
    [
      "workflow", "run", workflowId,
      taskText,
      "--working-directory-for-harness", workdir,
      "--matchlock", imageTag,
      "--dsh-as-harness",
    ],
    env,
    60_000,
    cwd,
  );
  const runId = resolveFullRunId(prefix, tamanduaDir);
  const status = await pollTerminalWithNudge(runId, env, tamanduaDir, label);
  assert.equal(status, "completed", `${label}: run must complete; got ${status}`);
  await sleep(500);
  return runId;
}

interface RunWholePathEvidenceInput {
  label: string;
  runId: string;
  storeRoot: string;
  repoDir: string;
  expectProbes: number;
  expectWorks: number;
  expectTokens: number;
}

/**
 * Assert one completed synthetic dsh whole-path run: progress resource
 * persisted, real step DB rows, host suite store row under the canonical
 * namespace with integer exit, exact per-run session totals in the mapped
 * store (cross-checked against per-invocation markers), and exact
 * runs.tokens_spent.
 */
function assertRunWholePathEvidence(input: RunWholePathEvidenceInput): void {
  const { label, runId, storeRoot, repoDir, expectProbes, expectWorks, expectTokens } = input;

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
    const resultCols = (sdb.prepare("PRAGMA table_info(host_suite_results)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const required of [
      "exit_code", "namespace_id", "origin_repo", "tree_hash", "cmd_hash",
      "cmd_display", "run_id", "step_id", "created_at", "invocation_id",
    ]) {
      assert.ok(resultCols.includes(required), `${label}: host_suite_results missing column ${required}`);
    }
    const nsCols = (sdb.prepare("PRAGMA table_info(host_suite_namespace)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const required of [
      "namespace_id", "image_content_id", "guest_platform", "helper_contract", "compatibility_fingerprint",
    ]) {
      assert.ok(nsCols.includes(required), `${label}: host_suite_namespace missing column ${required}`);
    }
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
  const markerDir = path.join(repoDir, ".matchlock-synthetic-dsh");
  assert.ok(fs.existsSync(markerDir), `${label}: synthetic marker dir missing in repo ${repoDir}`);
  const runMarkers = parseMarkerSessions(markerDir).filter((m) => m.runId === runId);
  const probes = runMarkers.filter((m) => m.kind === "probe");
  const works = runMarkers.filter((m) => m.kind === "work");
  assert.equal(probes.length, expectProbes, `${label}: expected exactly ${expectProbes} probe marker(s)`);
  assert.equal(works.length, expectWorks, `${label}: expected exactly ${expectWorks} work marker(s)`);

  // EXACT session/usage cross-check against the mapped store root. The store
  // root is the effective DSH_HOME for this run's mapping case.
  const totals = readSessionTotals(storeRoot, repoDir);
  for (const m of runMarkers) {
    const sessionDirName = Object.keys(readSessionDirNames(storeRoot, repoDir)).find(
      (dir) => {
        const artifact = path.join(storeRoot, "sessions", matchlockProjectKey(repoDir), dir, "session.v3.jsonl");
        if (!fs.existsSync(artifact)) return false;
        const text = fs.readFileSync(artifact, "utf-8");
        return text.includes(`"id":"${m.sessionId}"`) || text.includes(`"id": "${m.sessionId}"`);
      },
    );
    assert.ok(
      sessionDirName !== undefined,
      `${label}: marker ${m.file} session ${m.sessionId} missing from mapped store ${storeRoot}`,
    );
    const expected = m.kind === "probe" ? PROBE_TOKENS : WORK_TOKENS;
    assert.equal(
      totals.get(sessionDirName),
      expected,
      `${label}: marker ${m.file} session ${m.sessionId} must have exact token total ${expected}`,
    );
  }

  // Exact runs.tokens_spent for the whole run (probe + work rounds).
  const spent = readTokensSpent(tamanduaDir, runId);
  assert.equal(spent, expectTokens, `${label}: runs.tokens_spent must be exact (got ${spent}, expected ${expectTokens})`);
}

function readSessionDirNames(storeRoot: string, workdir: string): Record<string, string> {
  const key = matchlockProjectKey(workdir);
  const projectDir = path.join(storeRoot, "sessions", key);
  const out: Record<string, string> = {};
  if (!fs.existsSync(projectDir)) return out;
  for (const e of fs.readdirSync(projectDir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name.startsWith("session-")) out[e.name] = path.join(projectDir, e.name);
  }
  return out;
}

function countGateWrites(storeRoot: string): number {
  const dir = path.join(storeRoot, ".gate-writes");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
}

// ── direct runner plumbing (dist; built by the runner script first) ───────

async function readPersistedPolicy(runId: string): Promise<Record<string, unknown>> {
  const db = openE2eDatabase(path.join(tamanduaDir, "tamandua.db"));
  try {
    const row = db.prepare("SELECT matchlock_policy FROM runs WHERE id = ?").get(runId) as
      | { matchlock_policy: string | null }
      | undefined;
    assert.ok(row?.matchlock_policy, `no persisted matchlock policy for whole-path run ${runId}`);
    const policy = JSON.parse(row.matchlock_policy) as Record<string, unknown>;
    assert.equal(policy.harness, "dsh", "persisted policy must be harness dsh");
    return policy;
  } finally {
    db.close();
  }
}

interface DirectRecord {
  label: string;
  ok: boolean;
  vmId: string | null;
  cleanupConfirmed: boolean | undefined;
  exitCode: number | null;
  timedOut: boolean | undefined;
  stdout: string;
  stderrTail: string;
  error?: string;
}

let directRunnerMemo:
  | { runDshInvocation: (o: Record<string, unknown>) => Promise<Record<string, unknown>> }
  | undefined;

async function loadDirectRunner(): Promise<{ runDshInvocation: (o: Record<string, unknown>) => Promise<Record<string, unknown>> }> {
  if (directRunnerMemo) return directRunnerMemo;
  const mod = await import(
    `${repoRoot}/dist/installer/matchlock/dsh-invocation-runner.js`
  );
  directRunnerMemo = { runDshInvocation: mod.runDshInvocation };
  return directRunnerMemo;
}

let packPathMemo: string | null = null;
async function ensurePackHostPath(): Promise<string> {
  if (packPathMemo) return packPathMemo;
  const sm = await import(`${repoRoot}/dist/installer/matchlock/scheduler-matchlock.js`);
  packPathMemo = await sm.ensureGuestPackForState({ stateRoot: tamanduaDir });
  return packPathMemo;
}

/**
 * Short-HOME alias for the DIRECT runner. The production scheduler resolves
 * the alias before every Matchlock round (home-alias.ts) so the control
 * process HOME always fits Linux's 107-byte sun_path; a direct invocation
 * passes rpcEnv.HOME verbatim, so on a host whose canonical evidence root
 * makes <HOME> too long the same PRODUCT helper is applied here (never a
 * weakened assertion, never a hardcoded path).
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

/** Production dsh invocation options for one direct real-VM invocation. */
async function buildDirectOptions(
  label: string,
  policy: Record<string, unknown>,
  workdir: string,
  promptText: string,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const invocationId = randomUUID();
  return {
    policy,
    identity: {
      runId: randomUUID(),
      agentId: "do-now_doer",
      workflowId: "do-now",
      jobId: `job-${invocationId.slice(0, 8)}`,
      invocationId,
    },
    kind: "work",
    promptText,
    workingDirectoryForHarness: workdir,
    timeoutMs: 150_000,
    createTimeoutMs: 240_000,
    readyTimeoutMs: 30_000,
    handshakeTimeoutMs: 90_000,
    serviceTimeoutMs: 180_000,
    closeTimeoutSeconds: 60,
    helperPackHostPath: await ensurePackHostPath(),
    rpcEnv: {
      HOME: await resolveControlHomeAlias(homeDir),
      ...matchlockRuntimeEnv(),
      TAMANDUA_STATE_DIR: tamanduaDir,
    },
    ...extra,
  };
}

/**
 * One DIRECT real-VM dsh invocation from the gate process (no daemon, no
 * scheduler): the production dsh invocation runner composes the guest launch
 * over the shared registry/broker/pack/progress lifecycle and positively
 * closes its owned VM. The prompt is a plain "chat" prompt (never a work
 * prompt) so no step is ever claimed. Both a returned failed round (ok=true,
 * exitCode !== 0) and an infra rejection (ok=false, error set) are captured.
 */
async function directChatInvocation(opts: {
  label: string;
  policy: Record<string, unknown>;
  workdir: string;
  promptText?: string;
  /** Controlled bare run id so the private per-run overlay root is known. */
  runId?: string;
  extra?: Record<string, unknown>;
}): Promise<DirectRecord> {
  const runner = await loadDirectRunner();
  const record: DirectRecord = {
    label: opts.label, ok: false, vmId: null, cleanupConfirmed: undefined,
    exitCode: null, timedOut: undefined, stdout: "", stderrTail: "",
  };
  const invocationId = randomUUID();
  try {
    const identity = {
      runId: opts.runId ?? randomUUID(),
      agentId: "do-now_doer",
      workflowId: "do-now",
      jobId: `job-${invocationId.slice(0, 8)}`,
      invocationId,
    };
    const options = await buildDirectOptions(
      opts.label,
      opts.policy,
      opts.workdir,
      opts.promptText ?? `synthetic-dsh direct persistence chat for ${opts.label} (not a work prompt)`,
      { identity, invocationId, ...(opts.extra ?? {}) },
    );
    const result = (await runner.runDshInvocation(options)) as Record<string, unknown>;
    record.ok = true;
    record.vmId = (result.vmId as string | null) ?? null;
    record.cleanupConfirmed = result.cleanupConfirmed as boolean | undefined;
    record.exitCode = (result.exitCode as number | null) ?? null;
    record.timedOut = result.timedOut as boolean | undefined;
    record.stdout = String(result.output ?? "");
    record.stderrTail = String(result.stderrTail ?? "");
    if (record.vmId) observedVmIds.push(record.vmId);
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
  }
  return record;
}

// Snapshot/attribute via the PRODUCTION confined bounded store helpers
// (dist scheduler-dsh snapshotDshRoundStore / attributeDshRoundStore). Pre
// and post are FULL inventory objects (projectDir + sessions map) so the
// production attribution runs unchanged.
interface StoreInventoryLike {
  projectDir: string;
  sessions: Map<string, unknown>;
}

interface StoreHelpers {
  snapshot: (policy: Record<string, unknown>, workdir: string) => StoreInventoryLike;
  attribute: (
    policy: Record<string, unknown>,
    workdir: string,
    pre: StoreInventoryLike,
    post: StoreInventoryLike,
  ) => { status: string; reason: string; tokenTotal: number | null; sessions: unknown[] };
}

let storeHelpersMemo: StoreHelpers | undefined;

async function loadStoreHelpers(): Promise<StoreHelpers> {
  if (storeHelpersMemo) return storeHelpersMemo;
  const mod = await import(`${repoRoot}/dist/installer/matchlock/scheduler-dsh.js`);
  storeHelpersMemo = {
    snapshot: (policy, workdir) =>
      mod.snapshotDshRoundStore(policy, workdir) as StoreInventoryLike,
    attribute: (policy, workdir, pre, post) => {
      const r = mod.attributeDshRoundStore(policy, workdir, pre, post) as {
        status: string;
        reason: string;
        tokenTotal: number | null;
        sessions: unknown[];
      };
      return r;
    },
  };
  return storeHelpersMemo;
}

/**
 * DSH-PROFILE-OVERLAY US-004: production private-overlay geometry. The gate
 * uses the SAME derivation the runner does (`dshProfileOverlayRoot`) so the
 * overlay root it observes while a round is live is exactly the host-attested
 * per-run private root the guest's install-derived farm resolves to.
 */
interface OverlayHelpers {
  prepare: (runId: string, liveStateRoot: string, hostHome: string) => { overlayRoot: string };
  root: (runId: string, liveStateRoot: string) => string;
}

let overlayHelpersMemo: OverlayHelpers | undefined;

async function loadOverlayHelpers(): Promise<OverlayHelpers> {
  if (overlayHelpersMemo) return overlayHelpersMemo;
  const mod = await import(`${repoRoot}/dist/installer/matchlock/dsh-profile-overlay.js`);
  overlayHelpersMemo = {
    prepare: (runId, liveStateRoot, hostHome) =>
      mod.prepareDshProfileOverlay(runId, liveStateRoot, hostHome) as { overlayRoot: string },
    root: (runId, liveStateRoot) => mod.dshProfileOverlayRoot(runId, liveStateRoot) as string,
  };
  return overlayHelpersMemo;
}

/**
 * The host-attested private overlay root the direct runner will use for a
 * controlled run id. Direct invocations pass no `progressResource.runRoot`, so
 * the runner falls back to `resolveLiveStateRoot()` — the process
 * `TAMANDUA_STATE_DIR` pinned in `before()`.
 */
async function overlayRootForRun(runId: string): Promise<string> {
  const helpers = await loadOverlayHelpers();
  return helpers.root(runId, tamanduaDir);
}

/**
 * Seed the private overlay's install-derived farm with a GUEST-install link
 * before an invocation. This is the fixture stand-in for the guest's own
 * `healProfilesModuleFallback` (the composed plan maps the guest's
 * `profiles/node_modules` from exactly this private root); combined with the
 * observer it lets the gate assert the private farm carries GUEST-install links
 * deterministically even when the real dsh install on the host is transiently
 * incomplete.
 */
async function seedPrivateFarmWithGuestLink(
  runId: string,
  hostHome: string,
  linkName: string,
  guestTarget: string,
): Promise<string> {
  const helpers = await loadOverlayHelpers();
  const layout = helpers.prepare(runId, tamanduaDir, hostHome);
  const farmDir = path.join(layout.overlayRoot, "profiles", "node_modules");
  fs.mkdirSync(farmDir, { recursive: true });
  const link = path.join(farmDir, linkName);
  try {
    fs.rmSync(link, { force: true });
  } catch {
    /* absent */
  }
  fs.symlinkSync(guestTarget, link);
  return layout.overlayRoot;
}

function storeSnapshot(
  policy: Record<string, unknown>,
  workdir: string,
): StoreInventoryLike {
  const helpers = storeHelpersMemo;
  if (!helpers) throw new Error("store helpers not loaded (before() must await loadStoreHelpers())");
  return helpers.snapshot(policy, workdir);
}

function storeAttribute(
  policy: Record<string, unknown>,
  workdir: string,
  pre: StoreInventoryLike,
  post: StoreInventoryLike,
): { status: string; reason: string; tokenTotal: number | null; sessions: unknown[] } {
  const helpers = storeHelpersMemo;
  if (!helpers) throw new Error("store helpers not loaded (before() must await loadStoreHelpers())");
  return helpers.attribute(policy, workdir, pre, post);
}

/**
 * One DIRECT real-VM invocation that boots the REAL dsh CLI inside the VM
 * (image carries the real /opt/dsh install). Used by the boot/profile-link
 * characterization: the launch is the production `dsh --profile headless
 * <prompt>` argv with a NON-task prompt, so any boot stops at the profile
 * loader before any model/provider work (zero provider calls by construction).
 */
async function directRealBootInvocation(opts: {
  label: string;
  policy: Record<string, unknown>;
  /**
   * Controlled bare run id. The runner derives the private per-run overlay root
   * from it, so the gate can observe exactly that root while the round is live.
   */
  runId?: string;
}): Promise<DirectRecord> {
  const runner = await loadDirectRunner();
  const record: DirectRecord = {
    label: opts.label, ok: false, vmId: null, cleanupConfirmed: undefined,
    exitCode: null, timedOut: undefined, stdout: "", stderrTail: "",
  };
  const invocationId = randomUUID();
  const runId = opts.runId ?? randomUUID();
  try {
    const options = await buildDirectOptions(
      opts.label,
      opts.policy,
      wdNow,
      "synthetic real-dsh boot characterization (no provider call expected; boot may stop at the profile loader)",
      {
        timeoutMs: 120_000,
        serviceTimeoutMs: 120_000,
        // Controlled identity so the private overlay root is known: the runner
        // derives it from this run id and the pinned live state root.
        identity: {
          runId,
          agentId: "do-now_doer",
          workflowId: "do-now",
          jobId: `job-${invocationId.slice(0, 8)}`,
          invocationId,
        },
        _label: opts.label,
        invocationId,
      },
    );
    const result = (await runner.runDshInvocation(options)) as Record<string, unknown>;
    record.ok = true;
    record.vmId = (result.vmId as string | null) ?? null;
    record.cleanupConfirmed = result.cleanupConfirmed as boolean | undefined;
    record.exitCode = (result.exitCode as number | null) ?? null;
    record.timedOut = result.timedOut as boolean | undefined;
    record.stdout = String(result.output ?? "");
    record.stderrTail = String(result.stderrTail ?? "");
    if (record.vmId) observedVmIds.push(record.vmId);
  } catch (err) {
    record.error = err instanceof Error ? err.message : String(err);
  }
  return record;
}

async function imageNodeVersion(tag: string): Promise<string> {
  const r = spawnSync(
    "/usr/bin/docker",
    ["run", "--rm", "--entrypoint", "/bin/sh", tag, "-c", "node --version || true"],
    { encoding: "utf-8" },
  );
  if (r.status === 0 && (r.stdout || "").trim()) return (r.stdout || "").trim();
  return `unavailable (rc=${r.status}): ${(r.stderr || "").trim().slice(0, 300)}`;
}

let realDshImageEnsured = false;
async function ensureRealDshBootImage(): Promise<void> {
  if (realDshImageEnsured) return;
  // Already resolvable in the private store (dev-speed reuse)? Then skip the
  // multi-GB build/import.
  try {
    resolveImage(REAL_DSH_BOOT_TAG, homeDir);
    realDshImageEnsured = true;
    return;
  } catch {
    /* not yet imported — build + import below */
  }
  // Dev/test-speed seam (NOT the clean acceptance path): the docker tag was
  // already built by a previous gate run, so import it directly instead of
  // re-staging the multi-GB build context and rebuilding.
  if (process.env.TAMANDUA_GATE_REUSE_DSH_IMAGE?.trim() === "1") {
    const have = spawnSync("/usr/bin/docker", ["image", "inspect", REAL_DSH_BOOT_TAG], {
      encoding: "utf-8",
    });
    assert.equal(
      have.status,
      0,
      `TAMANDUA_GATE_REUSE_DSH_IMAGE=1 requires the prebuilt docker image ${REAL_DSH_BOOT_TAG}: ${have.stderr}`,
    );
    await importImage(REAL_DSH_BOOT_TAG, homeDir);
    resolveImage(REAL_DSH_BOOT_TAG, homeDir);
    realDshImageEnsured = true;
    return;
  }
  // Stage the real /opt/dsh install (minus VCS metadata) as the docker build
  // context under the EVIDENCE dir (never in the repo). The staged copy is
  // retained as evidence of exactly what was baked into the image.
  const ctxDir = path.join(EVIDENCE_DIR, "real-dsh-ctx");
  fs.mkdirSync(ctxDir, { recursive: true });
  const dshSrc = "/opt/dsh";
  const dshDst = path.join(ctxDir, "real-dsh");
  fs.mkdirSync(dshDst, { recursive: true });
  // Copy the CONTENTS of /opt/dsh into ctx/real-dsh (cp -a /opt/dsh/. dst/).
  const cp = spawnSync("cp", ["-a", `${dshSrc}/.`, `${dshDst}/`], { encoding: "utf-8" });
  assert.equal(cp.status, 0, `staging real /opt/dsh into the build context failed: ${cp.stderr}`);
  // Remove VCS metadata from the STAGED COPY only (never the source).
  fs.rmSync(path.join(dshDst, ".git"), { recursive: true, force: true });
  fs.copyFileSync(
    path.join(FIXTURE_DOCKER_DIR, "Dockerfile.synthetic-dsh-real-boot"),
    path.join(ctxDir, "Dockerfile"),
  );
  dockerBuild("Dockerfile", REAL_DSH_BOOT_TAG, ctxDir);
  await importImage(REAL_DSH_BOOT_TAG, homeDir);
  resolveImage(REAL_DSH_BOOT_TAG, homeDir);
  realDshImageEnsured = true;
}
