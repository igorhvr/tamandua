/**
 * matchlock-gate-lifecycle.ts — shared, CORRECTED exact-owned VM lifecycle
 * helpers for the real-VM Matchlock whole-path gates.
 *
 * This is the reviewed delta imported from the pi-execution gate-B lineage
 * (ROOT review corrections) and generalized so the workflow-parity
 * whole-path gates can share it:
 *
 *   - strict VM inventory: an ABSENT state DB is DISTINCT from a queried empty
 *     one; a corrupt/unreadable DB or an invalid `vms` row THROWS (never
 *     silently empty/clean);
 *   - exact-owned cleanup: a failed/unknown `matchlock rm` FAILS and RETAINS
 *     the state dir + DB rows for diagnostics — there is deliberately NO
 *     `fs.rmSync` fallback that could erase evidence after a failed disposal;
 *   - every outcome is written to a ledger, even when cleanup throws;
 *   - corrupt run-event JSON is an ERROR, never silently dropped;
 *   - `assertNoOwnedVms` proves strictly that the RUNNER (not the gate) left
 *     no owned VM row/state dir behind after a run, before any gate-side rm;
 *   - `readRunnerVmEvidenceIds` counts the runner's retained per-VM evidence
 *     dirs (the deterministic post-run proof of a fresh VM per invocation
 *     once the VM rows/dirs themselves are correctly gone);
 *   - scoped daemon stop observes the child's real close code/signal.
 *
 * The injected-failure controls (`fabricateVmHome`, `makeFakeMatchlock`) are
 * deterministic and use NO real VM — they are exercised by
 * `tests/matchlock-gate-lifecycle.test.ts` (fast lane) and by the real-VM
 * gates before any VM is created.
 *
 * Node-core only. NEVER treats absent/unknown state as clean evidence.
 */

import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";
import { openE2eDatabase } from "./e2e-database.mjs";

export interface VmRow {
  id: string;
  status: string;
}

export interface VmInventory {
  /** True when the matchlock state DB file EXISTS (queried successfully). */
  dbPresent: boolean;
  /** Rows in the `vms` table (only well-formed vm-<8hex> ids; invalid rows THROW). */
  rows: VmRow[];
  /** State dirs under $HOME/.matchlock/vms that carry an OWNED vm-<8hex> name. */
  dirIds: string[];
}

export const VM_ID_RE = /^vm-[0-9a-f]{8}$/;

/** Path of the per-gate matchlock state DB inside a private HOME. */
export function matchlockStateDbPath(homeDir: string): string {
  return path.join(homeDir, ".matchlock", "state.db");
}

/**
 * Read the actual owned VM inventory STRICTLY:
 *
 *  - a state.db that is ABSENT is a DISTINCT state from one queried empty —
 *    callers decide whether absence is expected (a gate that created VMs must
 *    treat a missing DB as a failure, not as clean);
 *  - a state.db that exists but cannot be opened/queried THROWS;
 *  - an invalid `vms` row id THROWS — inventory is never fabricated;
 *  - directory entries only corroborate exact OWNED `vm-<8hex>` names.
 */
export function readVmInventory(homeDir: string): VmInventory {
  const stateDb = matchlockStateDbPath(homeDir);
  const dbExists = fs.existsSync(stateDb);
  const rows: VmRow[] = [];
  if (dbExists) {
    const db = openE2eDatabase(stateDb);
    try {
      const raw = db
        .prepare("SELECT id, status FROM vms ORDER BY created_at")
        .all() as Array<{ id: string; status: string }>;
      for (const r of raw) {
        if (typeof r.id !== "string" || !VM_ID_RE.test(r.id)) {
          throw new Error(
            `corrupt matchlock VM inventory: invalid vms row id ${JSON.stringify(r.id)}`,
          );
        }
        rows.push({ id: r.id, status: String(r.status ?? "") });
      }
    } catch (err) {
      if (err instanceof Error && /corrupt matchlock VM inventory/.test(err.message)) throw err;
      throw new Error(
        `matchlock state DB is unreadable/corrupt at ${stateDb}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      db.close();
    }
  }
  const vmsDir = path.join(homeDir, ".matchlock", "vms");
  let dirIds: string[] = [];
  if (fs.existsSync(vmsDir)) {
    dirIds = fs
      .readdirSync(vmsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && VM_ID_RE.test(e.name))
      .map((e) => e.name);
  }
  return { dbPresent: dbExists, rows, dirIds };
}

/** Strict VM id list (throws on corrupt DB, or absent DB unless allowed). */
export function readVmIds(homeDir: string, opts: { allowAbsent?: boolean } = {}): string[] {
  const inv = readVmInventory(homeDir);
  if (!inv.dbPresent && !opts.allowAbsent) {
    throw new Error(
      `matchlock state DB is MISSING at ${matchlockStateDbPath(homeDir)} while owned VMs were expected; ` +
        `refusing to treat absent state as clean`,
    );
  }
  return inv.rows.map((r) => r.id);
}

/** Write a ledger file, creating parent dirs. */
export function writeLedger(ledgerPath: string, ledger: string[]): void {
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, ledger.join("\n") + "\n", "utf-8");
}

/** Append one ledger line (creating parent dirs). Never throws. */
function appendLedgerLine(ledgerPath: string | undefined, line: string): void {
  if (!ledgerPath) return;
  try {
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.appendFileSync(ledgerPath, line + "\n", "utf-8");
  } catch (err) {
    process.stderr.write(`assertNoOwnedVms: ledger append failed: ${String(err)}\n`);
  }
}

/** Synchronous bounded sleep: blocks the thread, spawns nothing. */
function sleepSync(ms: number): void {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin fallback when Atomics.wait is unavailable */
    }
  }
}

/**
 * VM ids the runner positively captured + removed for ONE run: one evidence
 * directory per removed VM at `<runRoot>/<bareRunId>/matchlock/<vmId>` (the
 * US-003/US-004 evidence destination). After US-004/US-005 the VM rows/state
 * dirs are gone by design, so these retained evidence dirs are the
 * deterministic post-run proof that a fresh VM existed per invocation. Only
 * well-formed owned `vm-<8hex>` names count; a missing run dir is an empty
 * list (the run created no VMs).
 */
export function readRunnerVmEvidenceIds(runRoot: string, runId: string): string[] {
  const bare = runId.startsWith("run-") ? runId.slice("run-".length) : runId;
  const dir = path.join(runRoot, bare, "matchlock");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && VM_ID_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

export interface AssertNoOwnedVmsOptions {
  /** Append the result line here (created recursively); existing content kept. */
  ledgerPath?: string;
  /**
   * Optional pinned matchlock CLI. When set, `matchlock list` is run once and
   * its bounded output is recorded; the strict state-DB inventory remains the
   * authority for the pass/fail decision.
   */
  rpcBin?: string;
  /** Extra env for the optional `list` child (HOME is forced to homeDir). */
  env?: NodeJS.ProcessEnv;
  /**
   * Bounded wait (ms) for the runner's teardown to settle before failing.
   * Default 0 = immediate strict assertion (used by the fast controls).
   */
  pollTimeoutMs?: number;
  /** Interval between inventory re-reads while waiting (default 250ms). */
  pollIntervalMs?: number;
  /** Optional log sink (also receives the recorded ledger line). */
  onLog?: (line: string) => void;
}

/** Bounded `matchlock list` capture for the ledger; never affects the decision. */
function readMatchlockList(homeDir: string, rpcBin: string, env?: NodeJS.ProcessEnv): string {
  try {
    const r = spawnSync(rpcBin, ["list"], {
      encoding: "utf-8",
      env: cleanChildEnv({ ...process.env, ...(env ?? {}), HOME: homeDir }),
      timeout: 30_000,
    });
    const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().replace(/\s+/g, " ");
    return `rc=${r.status}${r.signal ? ` signal=${r.signal}` : ""} ${text.slice(0, 500)}`;
  } catch (err) {
    return `spawn failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Strictly assert that the runner left NO owned Matchlock VM behind: every
 * owned `vms` row and every `~/.matchlock/vms/<vm-id>/` state dir must be
 * gone. This is the end-to-end proof of MATCHLOCK-OBS finding 2 (the runner
 * captures evidence then removes each VM after a positively confirmed close),
 * and it is deliberately INDEPENDENT of any gate-side `matchlock rm`.
 *
 * The state-DB/dir inventory reader is strict: a corrupt/unreadable DB THROWS
 * (never read as empty/clean). When `pollTimeoutMs > 0` the inventory is
 * re-read until empty or the bound expires, so a run-completion race with the
 * in-flight runner teardown does not produce a false failure. On any leftover
 * the thrown message names EVERY leftover row id and state-dir id, and the
 * outcome is appended to `ledgerPath` (when supplied) before the throw.
 */
export function assertNoOwnedVms(
  homeDir: string,
  label: string,
  opts: AssertNoOwnedVmsOptions = {},
): void {
  const pollTimeoutMs = Math.max(0, opts.pollTimeoutMs ?? 0);
  const pollIntervalMs = Math.max(1, opts.pollIntervalMs ?? 250);
  const deadline = Date.now() + pollTimeoutMs;

  let inventory = readVmInventory(homeDir);
  while (
    (inventory.rows.length > 0 || inventory.dirIds.length > 0) &&
    Date.now() < deadline
  ) {
    sleepSync(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    inventory = readVmInventory(homeDir);
  }

  const rowIds = [...new Set(inventory.rows.map((r) => r.id))].sort();
  const dirIds = [...new Set(inventory.dirIds)].sort();
  const leftovers = [...new Set([...rowIds, ...dirIds])].sort();
  const listOut = opts.rpcBin ? readMatchlockList(homeDir, opts.rpcBin, opts.env) : "";
  const ts = new Date().toISOString();
  const line =
    leftovers.length === 0
      ? `${ts} assertNoOwnedVms[${label}]: OK — no owned VM rows/state dirs remain (dbPresent=${inventory.dbPresent})${listOut ? `; matchlock list: ${listOut}` : ""}`
      : `${ts} assertNoOwnedVms[${label}]: FAIL — leftover owned VM rows=[${rowIds.join(",")}] dirs=[${dirIds.join(",")}]${listOut ? `; matchlock list: ${listOut}` : ""}`;
  appendLedgerLine(opts.ledgerPath, line);
  opts.onLog?.(line);

  if (leftovers.length > 0) {
    throw new Error(
      `assertNoOwnedVms[${label}]: ${leftovers.length} owned Matchlock VM(s) remain after the run ` +
        `(rows=[${rowIds.join(",")}], dirs=[${dirIds.join(",")}]); the runner must capture + remove every VM after a positively confirmed close`,
    );
  }
}

export interface CleanupResult {
  ledger: string[];
}

/**
 * Positively dispose every VM this gate created. The runner's positive
 * controller close normally already removed the VM rows/state dirs; this
 * function verifies that strictly and, for any id STILL present, performs an
 * EXACT-id `matchlock rm`. A failed/unknown close FAILS the gate and RETAINS
 * the state dir + DB rows for diagnostics (no erase-to-look-clean).
 *
 * Throws on any cleanup failure after flushing the partial ledger to disk.
 */
export function cleanupOwnedVms(
  homeDir: string,
  ledgerPath: string,
  observedIds: string[],
  opts: { rpcBin?: string } = {},
): CleanupResult {
  const ledger: string[] = [];
  const rpcBin = opts.rpcBin;
  if (!rpcBin) {
    throw new Error("cleanupOwnedVms requires an explicit rpcBin (exact-owned matchlock CLI)");
  }
  const clean = cleanChildEnv({ ...process.env, HOME: homeDir });
  const vmsDir = path.join(homeDir, ".matchlock", "vms");

  const flushLedger = (): void => {
    try {
      writeLedger(ledgerPath, ledger);
    } catch (err) {
      // Never mask the underlying cleanup failure; surface the ledger-write
      // failure on stderr so diagnostics are not silently lost.
      process.stderr.write(`cleanupOwnedVms: ledger write failed: ${String(err)}\n`);
    }
  };

  try {
    const inventory = readVmInventory(homeDir);
    const rowIds = inventory.rows.map((r) => r.id);
    const dirIds = inventory.dirIds;
    const rowIdSet = new Set(rowIds);
    const dirIdSet = new Set(dirIds);
    const target = [...new Set([...rowIds, ...dirIds, ...observedIds])].sort();
    ledger.push(
      `${new Date().toISOString()} VM ids observed during the gate (${observedIds.length}): ${observedIds.length > 0 ? observedIds.join(",") : "(none)"}`,
    );
    ledger.push(
      `${new Date().toISOString()} VM ids still present at cleanup (dbPresent=${inventory.dbPresent}, rows=${rowIds.length}, dirs=${dirIds.length}): ${target.length > 0 ? target.join(",") : "(none — runner positively closed every owned VM)"}`,
    );

    for (const id of target) {
      const stateDir = path.join(vmsDir, id);
      if (!rowIdSet.has(id) && !dirIdSet.has(id)) {
        ledger.push(
          `${new Date().toISOString()} vm ${id} already positively closed by the runner (no row and no state dir)`,
        );
        continue;
      }
      const rm = spawnSync(rpcBin, ["rm", id], {
        encoding: "utf-8",
        env: clean,
        timeout: 120_000,
      });
      ledger.push(
        `${new Date().toISOString()} vm ${id} rm rc=${rm.status}${rm.signal ? ` signal=${rm.signal}` : ""} out=${(rm.stdout || rm.stderr || "").trim()}`,
      );
      const after = readVmInventory(homeDir);
      const rowStill = after.rows.some((r) => r.id === id);
      const dirStill = fs.existsSync(stateDir);
      if (rm.status !== 0 || rowStill || dirStill) {
        ledger.push(
          `${new Date().toISOString()} vm ${id} NOT cleanly closed (rm rc=${rm.status}, rowStill=${rowStill}, dirStill=${dirStill}); state RETAINED for diagnostics`,
        );
        flushLedger();
        throw new Error(
          `vm ${id} failed to close cleanly (rm rc=${rm.status}${rm.signal ? ` signal=${rm.signal}` : ""}, rowStill=${rowStill}, dirStill=${dirStill}); state retained at ${stateDir} — see ${ledgerPath}`,
        );
      }
      ledger.push(`${new Date().toISOString()} vm ${id} positively closed (no row and no state dir)`);
    }

    const finalInventory = readVmInventory(homeDir);
    if (finalInventory.rows.length > 0 || finalInventory.dirIds.length > 0) {
      ledger.push(
        `${new Date().toISOString()} LEFTOVER owned VM rows/dirs after cleanup: rows=${finalInventory.rows.map((r) => r.id).join(",")}, dirs=${finalInventory.dirIds.join(",")}`,
      );
      flushLedger();
      throw new Error(
        `leftover owned VM rows/dirs after cleanup: rows=${finalInventory.rows.map((r) => r.id).join(",")}, dirs=${finalInventory.dirIds.join(",")}`,
      );
    }
    if (!finalInventory.dbPresent && observedIds.length > 0) {
      ledger.push(
        `${new Date().toISOString()} matchlock state DB is MISSING after a gate that created VMs — failing (absent ≠ clean)`,
      );
      flushLedger();
      throw new Error("matchlock state DB missing after a gate that created VMs");
    }
    ledger.push(`${new Date().toISOString()} cleanup complete: no owned VM rows/state dirs remain`);
    flushLedger();
    return { ledger };
  } catch (err) {
    flushLedger();
    throw err;
  }
}

/**
 * Read run-scoped event JSON strictly: corrupt JSON is an ERROR (a corrupt
 * events ledger must fail the gate loudly, never be silently skipped).
 */
export function readRunEvents(
  tamanduaDir: string,
  runId: string,
): Array<Record<string, unknown>> {
  const eventsPath = path.join(tamanduaDir, "events", `${runId}.jsonl`);
  if (!fs.existsSync(eventsPath)) return [];
  const events: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(eventsPath, "utf-8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      throw new Error(`corrupt event JSON in ${eventsPath}: ${line.slice(0, 200)}`);
    }
  }
  return events;
}

/**
 * Scoped daemon stop that OBSERVES the child's real close: sends SIGTERM to
 * the exact owned child, waits for `close`, records code/signal, and throws
 * when the child does not close within the bound. Never sweeps foreign PIDs.
 */
export async function stopIsolatedDaemonScoped(
  child: ChildProcess,
  opts: { termGraceMs?: number; killGraceMs?: number } = {},
): Promise<{ code: number | null; signal: string | null }> {
  const termGraceMs = opts.termGraceMs ?? 8_000;
  const killGraceMs = opts.killGraceMs ?? 6_000;
  if (!child || !child.pid) {
    return { code: child?.exitCode ?? null, signal: child?.signalCode ?? null };
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  let timer: NodeJS.Timeout | undefined;
  const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.once("close", (code, signal) =>
      resolve({ code, signal: (signal as string) ?? null }),
    );
    timer = setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, termGraceMs);
  });
  try {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
    const outcome = await Promise.race([
      closed,
      new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        setTimeout(() => resolve({ code: null, signal: "SIGKILL-timeout" }), termGraceMs + killGraceMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome.signal === "SIGKILL-timeout") {
      throw new Error("isolated daemon did not close after SIGTERM + SIGKILL within the scoped bound");
    }
    return outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Injected-failure controls (deterministic, NO real VM). Used by both the
// fast unit test and the real-VM gates before any VM is created.
// ────────────────────────────────────────────────────────────────────────

/** Fabricate a private HOME with a matchlock state DB/dirs for a control. */
export function fabricateVmHome(
  root: string,
  opts: { db?: "absent" | "empty" | "rows" | "corrupt"; dirs?: boolean },
): string {
  const homeDir = fs.mkdtempSync(path.join(root, "home-"));
  const matchlockDir = path.join(homeDir, ".matchlock");
  fs.mkdirSync(path.join(matchlockDir, "vms"), { recursive: true });
  if (opts.db && opts.db !== "absent") {
    const dbPath = path.join(matchlockDir, "state.db");
    if (opts.db === "corrupt") {
      fs.writeFileSync(dbPath, "this is not a sqlite db", "utf-8");
    } else {
      const db = openE2eDatabase(dbPath);
      try {
        db.exec("CREATE TABLE vms (id TEXT PRIMARY KEY, status TEXT, created_at TEXT)");
        if (opts.db === "rows") {
          const now = new Date().toISOString();
          db.prepare("INSERT INTO vms (id, status, created_at) VALUES (?, 'running', ?)").run(
            "vm-11223344",
            now,
          );
          db.prepare("INSERT INTO vms (id, status, created_at) VALUES (?, 'stopped', ?)").run(
            "vm-55667788",
            now,
          );
        }
      } finally {
        db.close();
      }
    }
  }
  if (opts.dirs) {
    for (const id of ["vm-11223344", "vm-55667788"]) {
      fs.mkdirSync(path.join(matchlockDir, "vms", id), { recursive: true });
    }
  }
  return homeDir;
}

/**
 * A deterministic stand-in for `matchlock rm <id>` used ONLY by injected
 * controls (no real runtime, no real VM). "ok" emulates the real rm (deletes
 * the exact row + state dir); "fail" leaves state in place so cleanup must
 * fail loudly and retain diagnostics.
 */
export function makeFakeMatchlock(binPath: string, behavior: "ok" | "fail" | "hang"): void {
  const nodeProbe =
    behavior === "ok"
      ? `const fs=require("node:fs");const path=require("node:path");
const Sqlite=require("node:sqlite").DatabaseSync;
const id=process.argv[3];const home=process.env.HOME;
try{const db=new Sqlite(path.join(home,".matchlock","state.db"));db.exec("DELETE FROM vms WHERE id = '" + id + "'");db.close();}catch(e){}
try{fs.rmSync(path.join(home,".matchlock","vms",id),{recursive:true,force:true});}catch(e){}
console.log("removed "+id);process.exit(0);`
      : behavior === "fail"
        ? `process.stderr.write("rm failed (injected)\\n");process.exit(2);`
        : `setTimeout(()=>process.exit(0), 30000);`;
  fs.writeFileSync(binPath, `#!/usr/bin/env node\n${nodeProbe}\n`, { mode: 0o755 });
}
