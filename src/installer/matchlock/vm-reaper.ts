/**
 * vm-reaper.ts — MTLK-CLEANUP US-006 (bead tamandua-6sy.33.10.42).
 *
 * Disposes MATCHLOCK VMs that are provably orphaned, by EXACT id, while never
 * touching a VM whose process is still alive. The incident left six `stopped`
 * VMs behind because a post-harness close/dispose failure handed the VM to the
 * orphan store (US-005) but nothing ever disposed it (observation: the round's
 * own `captureAndRemoveVm` only runs on the success path).
 *
 * What this module does (ONE bounded pass):
 *
 *   1. Read `<matchlockHome>/.matchlock/state.db` READ-ONLY (`readOnly: true`)
 *      and select the `vms` rows whose `status = 'stopped'`. A corrupt,
 *      absent or locked DB is a bounded diagnostic — never a throw.
 *   2. Add the run's recorded orphan VM ids (US-003 `vm-orphans.ts`) to the
 *      candidate set. In RUN-SCOPED mode (`opts.runId` set) ONLY those orphan
 *      ids are eligible; an unrelated `stopped` row is reported
 *      `skipped-unowned` and never touched.
 *   3. Skip any candidate whose recorded pid is a live process. Liveness is
 *      verified from the process command line via the portable
 *      `src/lib/proc-info.ts` helper (`matchlock`/`firecracker`), NEVER from
 *      `matchlock list` (whose status can be stale — observation 7). A pid from
 *      a recycled unrelated process is not this VM's process.
 *   4. Capture the VM's retained evidence first and then remove it by EXACT
 *      id via `vm-evidence.captureAndRemoveVm` (`matchlock rm <vmId>` with
 *      `HOME` forced to `matchlockHome`). This module owns NO
 *      `node:child_process` import; the spawn stays in `vm-evidence.ts`, so the
 *      invocation runners keep no direct child_process dependency.
 *   5. Clear the VM's orphan record after a confirmed removal (run-scoped).
 *
 * Hard constraints: the pass NEVER throws and is bounded in both time (the
 * `matchlock rm` timeout) and count (`maxVms`). It NEVER invokes
 * `matchlock prune`/`gc` and NEVER selects a VM by name or glob — only exact
 * ids read from the state DB / orphan store.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { captureAndRemoveVm, DEFAULT_VM_REMOVAL_TIMEOUT_MS } from "./vm-evidence.js";
import { getCmdline, hasProcfs } from "../../lib/proc-info.js";
import {
  clearOrphanVm,
  isSafeOrphanVmId,
  readOrphanVms,
  resolveVmOrphanStore,
  type VmOrphanVmRecord,
} from "./vm-orphans.js";
import {
  MATCHLOCK_ERROR_TAIL_MAX_BYTES,
  boundMatchlockErrorText,
} from "./runner-error.js";

/** State DB path relative to the Matchlock HOME. */
export const MATCHLOCK_STATE_DB_RELATIVE_PATH = path.join(".matchlock", "state.db");
/** Evidence directory used when the pass has no run context (operator mode). */
export const MATCHLOCK_REAPER_EVIDENCE_DIR_NAME = "reaper-evidence";
/** Default maximum number of candidate VMs considered per pass (bounded). */
export const DEFAULT_VM_REAPER_MAX_VMS = 128;
/** Absolute maximum accepted `maxVms` (bounded). */
export const MAX_VM_REAPER_MAX_VMS = 1024;
/** Maximum number of bounded diagnostics retained per pass. */
export const MAX_VM_REAPER_DIAGNOSTICS = 64;

export type MatchlockVmReaperLogLevel = "info" | "warn";
export type ReapedVmAction = "removed" | "skipped-live" | "skipped-unowned" | "error";

/** ONE `vms` row read from the read-only state DB. */
export interface StoppedVmRow {
  vmId: string;
  pid: number;
  status: string;
}

/** Result of a bounded read-only state DB scan. NEVER thrown. */
export interface StoppedVmReadResult {
  ok: boolean;
  rows: StoppedVmRow[];
  /** Bounded diagnostic when `ok` is false. */
  error?: string;
}

export type StoppedVmRowReader = (dbPath: string) => StoppedVmReadResult;
export type VmProcessAliveProbe = (pid: number) => boolean;

export interface MatchlockVmReaperOptions {
  /** The EFFECTIVE Matchlock rpc HOME the VMs were created under. Required. */
  matchlockHome: string;
  /**
   * Optional host run root (tests / explicit callers); defaults to the host
   * run root when reading this run's orphan store.
   */
  runRoot?: string;
  /**
   * When set, the pass is RUN-SCOPED: only this run's recorded orphan VMs are
   * eligible. A `stopped` row that is not one of the run's orphans is reported
   * `skipped-unowned` and never touched.
   */
  runId?: string;
  /** Explicit orphan records (test seam / caller-provided) instead of reading the store. */
  orphanRecords?: readonly VmOrphanVmRecord[];
  /** Restrict the candidate set to exactly these VM ids (operator entry point). */
  vmIds?: readonly string[];
  /** Matchlock CLI binary seam; defaults to TAMANDUA_MATCHLOCK_RPC_BIN or "matchlock". */
  cliBinaryPath?: string;
  /** Optional argv prefix inserted BEFORE "rm" (default []). */
  cliArgsPrefix?: readonly string[];
  /** Extra env merged over process.env for the rm child; HOME is forced to matchlockHome. */
  env?: Record<string, string | undefined>;
  /** Base dir for per-VM evidence; defaults to the run's matchlock dir or the home's reaper-evidence. */
  evidenceBaseDir?: string;
  /** Injectable process-alive probe; default reads the process command line. */
  isProcessAlive?: VmProcessAliveProbe;
  /** Injectable state DB reader (test seam); default {@link readStoppedVmRows}. */
  readStoppedRows?: StoppedVmRowReader;
  /** Positive candidate cap, clamped to 1..MAX_VM_REAPER_MAX_VMS (default 128). */
  maxVms?: number;
  /** Positive wall-clock budget (ms) for each `matchlock rm` child. */
  timeoutMs?: number;
  /** Optional structured log sink (never used by default; tests inject a sink). */
  onLog?: (
    level: MatchlockVmReaperLogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

/**
 * MTLK-CLEANUP US-007: options for the operator / run-teardown entry point.
 *
 * `matchlockHome` is OPTIONAL here: the operator/gate supplies it explicitly
 * (with `vmIds`), while the run-teardown path supplies only `runId` and lets
 * the entry point derive the effective Matchlock HOME(s) from the run's
 * recorded orphan VMs (US-003), so the scheduler never needs to know which
 * HOME a round created its VM under.
 */
export interface MatchlockOrphanReapOptions
  extends Omit<MatchlockVmReaperOptions, "matchlockHome" | "runId" | "orphanRecords"> {
  /**
   * Explicit Matchlock HOME. When absent, the home(s) are derived from the
   * run's recorded orphan VMs; required when no run context is given.
   */
  matchlockHome?: string;
  /** Bare uuid or `run-` prefixed run id; set for a RUN-SCOPED pass. */
  runId?: string;
  /** Explicit orphan records (test seam / caller-provided) instead of reading the store. */
  orphanRecords?: readonly VmOrphanVmRecord[];
}

/**
 * Aggregate result of {@link reapOrphanedMatchlockVms}: the union of the
 * per-home passes' results plus the distinct homes a pass ran against.
 */
export interface MatchlockOrphanReapResult {
  /** True when every attempted pass read its state DB (or nothing needed doing). */
  ok: boolean;
  /** Distinct Matchlock homes the entry point ran a pass against. */
  homes: string[];
  scanned: number;
  eligible: number;
  results: ReapedVmResult[];
  diagnostics: string[];
}

/** Per-VM outcome of one reaper pass. */
export interface ReapedVmResult {
  vmId: string;
  action: ReapedVmAction;
  /** The recorded pid (0 when unknown/already gone). */
  pid?: number;
  /** Exit code of the `matchlock rm` child, when one ran. */
  removalExitCode?: number | null;
  /** Bounded removal failure description (only for `action: "error"`). */
  removalError?: string;
  /** Evidence destination when anything was captured. */
  logsCopiedTo?: string | null;
}

/** Aggregate result of one bounded reaper pass. */
export interface MatchlockVmReapResult {
  /** True when the state DB was read successfully (explicit orphans still work when false). */
  ok: boolean;
  /** Number of `stopped` rows read from the state DB. */
  scanned: number;
  /** Number of VMs that passed the guard and received a removal attempt. */
  eligible: number;
  results: ReapedVmResult[];
  /** Bounded diagnostics (DB unavailable, mismatched homes, cap reached, …). */
  diagnostics: string[];
}

function bound(text: string): string {
  return boundMatchlockErrorText(text, MATCHLOCK_ERROR_TAIL_MAX_BYTES);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/**
 * Default liveness probe. A VM's recorded pid is considered alive ONLY when its
 * command line looks like a Matchlock/Firecracker process — a recycled pid
 * belonging to an unrelated process is NOT this VM's process, so the VM's
 * runtime is genuinely gone.
 *
 * The command line comes from the portable `proc-info` helper (procfs on Linux,
 * `ps` elsewhere). A pid of 0 (Matchlock's stopped marker) is never alive. When
 * the command line is unavailable the probe stays conservative: on a platform
 * without procfs a signal-0 existence check treats any live pid as alive, so
 * the reaper never removes a VM it cannot prove is dead.
 */
export function defaultVmProcessAliveProbe(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const cmdline = getCmdline(pid);
  if (cmdline.length > 0) return /firecracker|matchlock/i.test(cmdline);
  // Empty command line: the process is gone (or an unreadable/zombie entry).
  // On Linux that is conclusive; elsewhere fall back to a signal-0 check so a
  // live-but-uninspectable process is never reaped.
  if (hasProcfs()) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Read the `stopped` rows from a Matchlock state DB READ-ONLY. A corrupt,
 * absent, locked or schema-less DB resolves to `ok: false` + a bounded
 * diagnostic; this function NEVER throws.
 */
export function readStoppedVmRows(dbPath: string): StoppedVmReadResult {
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    return { ok: false, rows: [], error: "state.db path is empty" };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dbPath);
  } catch (err) {
    return { ok: false, rows: [], error: `state.db unavailable: ${bound(errMessage(err))}` };
  }
  if (!stat.isFile()) {
    return { ok: false, rows: [], error: "state.db is not a regular file" };
  }

  let db: DatabaseSync | null = null;
  try {
    // READ-ONLY open: the reaper must never create/repair the DB (or a journal).
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 5_000 });
    const rawRows = db
      .prepare("SELECT id, pid, status FROM vms WHERE status = 'stopped'")
      .all() as Array<Record<string, unknown>>;
    const rows: StoppedVmRow[] = [];
    for (const raw of rawRows) {
      const vmId = typeof raw.id === "string" ? raw.id : "";
      if (!isSafeOrphanVmId(vmId)) continue;
      const pidValue = typeof raw.pid === "number" ? raw.pid : Number(raw.pid);
      const pid = Number.isFinite(pidValue) && pidValue > 0 ? Math.trunc(pidValue) : 0;
      rows.push({ vmId, pid, status: "stopped" });
    }
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, rows: [], error: `state.db read failed: ${bound(errMessage(err))}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close; the pass never throws */
    }
  }
}

/** Bounded, throw-proof log sink wrapper. */
function makeSafeLog(
  sink: MatchlockVmReaperOptions["onLog"],
): (level: MatchlockVmReaperLogLevel, message: string, fields?: Record<string, unknown>) => void {
  if (typeof sink !== "function") return () => {};
  return (level, message, fields) => {
    try {
      sink(level, message, fields);
    } catch {
      /* logging must never affect the pass */
    }
  };
}

function clampMaxVms(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.min(Math.floor(value), MAX_VM_REAPER_MAX_VMS)
    : DEFAULT_VM_REAPER_MAX_VMS;
}

/** Evidence base dir for the pass: explicit, then the run's matchlock dir, then a home-local dir. */
function resolveEvidenceBaseDir(
  opts: MatchlockVmReaperOptions,
  matchlockHome: string,
  runScoped: boolean,
): string {
  if (typeof opts.evidenceBaseDir === "string" && opts.evidenceBaseDir.length > 0) {
    return opts.evidenceBaseDir;
  }
  if (runScoped && typeof opts.runId === "string" && opts.runId.length > 0) {
    try {
      return resolveVmOrphanStore({ runId: opts.runId, runRoot: opts.runRoot }).dir;
    } catch {
      /* unsafe run id: fall through to the home-local evidence dir */
    }
  }
  return path.join(matchlockHome, ".matchlock", MATCHLOCK_REAPER_EVIDENCE_DIR_NAME);
}

/**
 * ONE bounded reaper pass. Disposes the stopped VMs that are provably
 * orphaned, by exact id, never a live-pid VM, never by name/glob, never with
 * prune/gc. NEVER throws.
 *
 * Mode:
 *  - `opts.runId` set  → RUN-SCOPED: only that run's recorded orphan VMs are
 *    eligible; other stopped rows are reported `skipped-unowned`.
 *  - no `opts.runId`   → OPERATOR/GLOBAL: every `stopped` row with a dead pid
 *    is eligible (this is how the six incident leftovers are reaped).
 *  - `opts.vmIds` set  → the candidate set is restricted to exactly those ids
 *    (the liveness guard still applies).
 */
export function reapStoppedMatchlockVms(
  opts: MatchlockVmReaperOptions,
): MatchlockVmReapResult {
  const diagnostics: string[] = [];
  const results: ReapedVmResult[] = [];
  const log = makeSafeLog(opts?.onLog);
  const pushDiag = (message: string): void => {
    if (diagnostics.length >= MAX_VM_REAPER_DIAGNOSTICS) return;
    diagnostics.push(bound(message));
  };
  const pushResult = (result: ReapedVmResult): void => {
    results.push(result);
  };

  try {
    const matchlockHome = typeof opts?.matchlockHome === "string" ? opts.matchlockHome : "";
    if (matchlockHome.length === 0) {
      pushDiag("matchlockHome is required; nothing to reap");
      return { ok: false, scanned: 0, eligible: 0, results, diagnostics };
    }

    const runScoped = typeof opts.runId === "string" && opts.runId.length > 0;
    const runId = runScoped ? (opts.runId as string) : undefined;

    // --- 1. read the stopped rows (read-only, never throws) ------------------
    const dbPath = path.join(matchlockHome, MATCHLOCK_STATE_DB_RELATIVE_PATH);
    const reader =
      typeof opts.readStoppedRows === "function" ? opts.readStoppedRows : readStoppedVmRows;
    let db: StoppedVmReadResult;
    try {
      db = reader(dbPath);
    } catch (err) {
      db = { ok: false, rows: [], error: `state.db read failed: ${bound(errMessage(err))}` };
    }
    if (!db || !Array.isArray(db.rows)) {
      db = { ok: false, rows: [], error: "state.db reader returned an unusable result" };
    }
    const rows = db.rows;
    if (!db.ok) {
      const detail = db.error ?? "state.db unavailable";
      pushDiag(detail);
      log("warn", "matchlock vm reaper could not read state.db", { matchlockHome, detail });
    }

    // --- 2. resolve the eligible orphan records ------------------------------
    const orphanById = new Map<string, VmOrphanVmRecord>();
    const explicitOrphans = Array.isArray(opts.orphanRecords) ? opts.orphanRecords : null;
    let orphanRecords: readonly VmOrphanVmRecord[] = explicitOrphans ?? [];
    if (explicitOrphans === null && runScoped) {
      try {
        orphanRecords = readOrphanVms({ runId: runId as string, runRoot: opts.runRoot, onLog: log });
      } catch (err) {
        pushDiag(`orphan store read failed: ${bound(errMessage(err))}`);
      }
    }
    for (const record of orphanRecords) {
      if (!record || !isSafeOrphanVmId(record.vmId)) continue;
      if (
        typeof record.matchlockHome === "string" &&
        record.matchlockHome.length > 0 &&
        path.resolve(record.matchlockHome) !== path.resolve(matchlockHome)
      ) {
        pushDiag(`ignoring orphan ${record.vmId}: matchlockHome does not match the pass`);
        continue;
      }
      orphanById.set(record.vmId, record);
    }

    // --- 3. build the candidate set ------------------------------------------
    const rowById = new Map<string, StoppedVmRow>();
    for (const row of rows) {
      if (isSafeOrphanVmId(row.vmId)) rowById.set(row.vmId, row);
    }

    const considered = new Set<string>();
    if (Array.isArray(opts.vmIds) && opts.vmIds.length > 0) {
      for (const id of opts.vmIds) {
        if (isSafeOrphanVmId(id)) considered.add(id);
      }
    } else {
      for (const id of rowById.keys()) considered.add(id);
      for (const id of orphanById.keys()) considered.add(id);
    }

    const probe =
      typeof opts.isProcessAlive === "function" ? opts.isProcessAlive : defaultVmProcessAliveProbe;
    const isAlive = (pid: number): boolean => {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        return probe(pid) === true;
      } catch (err) {
        // A failing probe is treated as ALIVE (skip): never remove on doubt.
        pushDiag(`process probe failed for pid ${pid}: ${bound(errMessage(err))}`);
        return true;
      }
    };

    const maxVms = clampMaxVms(opts.maxVms);
    const cliBinaryPath =
      typeof opts.cliBinaryPath === "string" && opts.cliBinaryPath.length > 0
        ? opts.cliBinaryPath
        : process.env.TAMANDUA_MATCHLOCK_RPC_BIN?.trim() || "matchlock";
    const timeoutMs =
      typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : DEFAULT_VM_REMOVAL_TIMEOUT_MS;

    // Deterministic order; the pass is capped before any spawn.
    const candidateIds = [...considered].sort();
    let eligible = 0;
    let processed = 0;

    for (const vmId of candidateIds) {
      if (processed >= maxVms) {
        pushDiag(`reaper cap reached (${maxVms}); remaining VMs were not considered`);
        break;
      }
      processed += 1;

      const row = rowById.get(vmId);
      const orphan = orphanById.get(vmId);

      // Run-scoped mode: an unrelated stopped row is never touched.
      if (runScoped && orphan === undefined) {
        pushResult({ vmId, action: "skipped-unowned", pid: row?.pid ?? 0 });
        continue;
      }

      const pid = row && Number.isFinite(row.pid) && row.pid > 0 ? Math.trunc(row.pid) : 0;
      if (isAlive(pid)) {
        pushResult({ vmId, action: "skipped-live", pid });
        log("warn", "matchlock vm reaper skipped a live VM", { vmId, pid });
        continue;
      }

      // No DB row AND an unreadable DB: we cannot prove this VM is not running.
      if (!row && !db.ok) {
        const removalError = "state.db unavailable; cannot verify the VM process is dead";
        pushResult({ vmId, action: "error", pid, removalError });
        pushDiag(`skipped ${vmId}: ${removalError}`);
        continue;
      }

      // --- 4. capture evidence first, then remove by EXACT id ----------------
      eligible += 1;
      const destinationDir = path.join(
        resolveEvidenceBaseDir(opts, matchlockHome, runScoped),
        vmId,
      );
      const outcome = captureAndRemoveVm({
        vmId,
        matchlockHome,
        destinationDir,
        cliBinaryPath,
        cliArgsPrefix: opts.cliArgsPrefix,
        env: opts.env,
        timeoutMs,
        onLog: opts.onLog
          ? (level, message, fields) => {
              try {
                opts.onLog?.(level, message, fields);
              } catch {
                /* logging must never affect the pass */
              }
            }
          : undefined,
      });

      if (outcome.removed) {
        pushResult({
          vmId,
          action: "removed",
          pid,
          removalExitCode: outcome.removalExitCode,
          logsCopiedTo: outcome.logsCopiedTo,
        });
        log("info", "matchlock vm reaper removed an orphaned VM", {
          vmId,
          pid,
          logsCopiedTo: outcome.logsCopiedTo,
        });
        // --- 5. clear the run's orphan record after a confirmed removal ------
        if (runScoped && orphan !== undefined && runId !== undefined) {
          try {
            clearOrphanVm(vmId, { runId, runRoot: opts.runRoot, onLog: log });
          } catch (err) {
            pushDiag(`orphan record clear failed for ${vmId}: ${bound(errMessage(err))}`);
          }
        }
      } else {
        pushResult({
          vmId,
          action: "error",
          pid,
          removalExitCode: outcome.removalExitCode,
          removalError: outcome.removalError,
          logsCopiedTo: outcome.logsCopiedTo,
        });
        log("warn", "matchlock vm reaper failed to remove a VM", {
          vmId,
          pid,
          removalError: outcome.removalError,
        });
      }
    }

    return { ok: db.ok, scanned: rows.length, eligible, results, diagnostics };
  } catch (err) {
    // Defense-in-depth: this function NEVER throws.
    pushDiag(`matchlock vm reaper failed: ${bound(errMessage(err))}`);
    return { ok: false, scanned: 0, eligible: 0, results, diagnostics };
  }
}

/**
 * MTLK-CLEANUP US-007: the operator / run-teardown entry point.
 *
 * Two modes, both delegating the actual disposal to
 * {@link reapStoppedMatchlockVms} (so the live-process guard, exact-id `rm` and
 * never-prune/glob constraints are enforced in ONE place):
 *
 *  - OPERATOR/GATE MODE (`matchlockHome` set, optionally `vmIds`): exactly ONE
 *    pass against that home. The reaper's own `runId`-less operator semantics
 *    apply (every stopped, dead-pid row + explicit `vmIds`).
 *  - RUN-TEARDOWN MODE (`runId` set, no `matchlockHome`): the effective
 *    Matchlock HOME(s) are derived from the run's recorded US-003 orphan VMs
 *    and ONE run-scoped pass runs per distinct home. A run with no recorded
 *    orphans is a bounded NO-OP (no state DB is even opened), which is what
 *    makes the teardown hook safe for every run.
 *
 * NEVER throws and never changes a run's dispatch/classification; a caller
 * (the scheduler teardown or the runner handoff) can invoke it best-effort.
 */
export function reapOrphanedMatchlockVms(
  opts: MatchlockOrphanReapOptions,
): MatchlockOrphanReapResult {
  const diagnostics: string[] = [];
  const results: ReapedVmResult[] = [];
  const homes: string[] = [];
  try {
    const options = opts ?? ({} as MatchlockOrphanReapOptions);
    const explicitHome =
      typeof options.matchlockHome === "string" && options.matchlockHome.length > 0
        ? options.matchlockHome
        : "";
    const runScoped = typeof options.runId === "string" && options.runId.length > 0;

    // --- operator/gate mode: explicit home, exactly one pass ---------------
    if (explicitHome) {
      const pass = reapStoppedMatchlockVms({ ...options, matchlockHome: explicitHome });
      homes.push(path.resolve(explicitHome));
      results.push(...pass.results);
      diagnostics.push(...pass.diagnostics);
      return {
        ok: pass.ok,
        homes,
        scanned: pass.scanned,
        eligible: pass.eligible,
        results,
        diagnostics,
      };
    }

    // --- no home and no run context: nothing to do, never a throw ----------
    if (!runScoped) {
      diagnostics.push("matchlockHome is required when no run context is given; nothing to reap");
      return { ok: true, homes, scanned: 0, eligible: 0, results, diagnostics };
    }

    // --- run-teardown mode: derive the home(s) from the run's orphans ------
    const explicitRecords = Array.isArray(options.orphanRecords);
    let records: readonly VmOrphanVmRecord[] = explicitRecords
      ? (options.orphanRecords as readonly VmOrphanVmRecord[])
      : [];
    if (!explicitRecords) {
      try {
        records = readOrphanVms({
          runId: options.runId as string,
          runRoot: options.runRoot,
          onLog: options.onLog,
        });
      } catch (err) {
        // An unsafe run id (or an unexpected store failure) is a bounded
        // diagnostic: the teardown pass must never throw.
        diagnostics.push(bound(`orphan store read failed: ${errMessage(err)}`));
      }
    }

    const homeSet = new Set<string>();
    for (const record of records) {
      if (record && typeof record.matchlockHome === "string" && record.matchlockHome.length > 0) {
        homeSet.add(path.resolve(record.matchlockHome));
      }
    }
    if (homeSet.size === 0) {
      // A run with no recorded orphans is a NO-OP: no state.db is opened and
      // no unrelated stopped VM can even be considered.
      diagnostics.push(`no recorded orphan VMs for run ${options.runId}`);
      return { ok: true, homes, scanned: 0, eligible: 0, results, diagnostics };
    }

    let ok = true;
    let scanned = 0;
    let eligible = 0;
    for (const home of [...homeSet].sort()) {
      const recordsForHome = records.filter(
        (record) =>
          record &&
          typeof record.matchlockHome === "string" &&
          path.resolve(record.matchlockHome) === home,
      );
      const pass = reapStoppedMatchlockVms({
        ...options,
        matchlockHome: home,
        orphanRecords: recordsForHome,
      });
      homes.push(home);
      results.push(...pass.results);
      diagnostics.push(...pass.diagnostics);
      scanned += pass.scanned;
      eligible += pass.eligible;
      if (!pass.ok) ok = false;
    }
    return { ok, homes, scanned, eligible, results, diagnostics };
  } catch (err) {
    // Defense-in-depth: this entry point NEVER throws.
    diagnostics.push(bound(`matchlock orphan reap failed: ${errMessage(err)}`));
    return { ok: false, homes, scanned: 0, eligible: 0, results, diagnostics };
  }
}
