/**
 * vm-orphans.ts — MTLK-CLEANUP US-003 (bead tamandua-6sy.33.10.42).
 *
 * Bounded, atomic, per-run record of a Matchlock VM that could NOT be disposed
 * (a post-harness close/dispose failure, US-005). The invocation runner hands
 * the VM to this store; the stopped-VM reaper (US-006) and the run's completion
 * cleanup (US-007) read it back and retry the disposal by EXACT vm id.
 *
 * Layout (beside the run's Matchlock evidence):
 *
 *   <runRoot>/<bareRunId>/matchlock/orphans.json      ← this store
 *   <runRoot>/<bareRunId>/matchlock/<vmId>/           ← per-VM evidence
 *
 * The single file is keyed by vmId and holds a bounded JSON array of records.
 *
 * Design constraints (from the story):
 *  - Node-core only (node:fs / node:path + the zero-import runner-error leaf):
 *    this is a leaf other runner code can import without dragging in product
 *    modules or a dependency cycle.
 *  - ATOMIC write: an exclusive temp file in the SAME directory, then a rename
 *    over `orphans.json`, so a crash can never leave a torn JSON file.
 *  - NEVER throws for an absent / unreadable / malformed store: a bounded
 *    diagnostic + an empty (or filtered) list instead. It also never throws
 *    while recording during a runner cleanup path.
 *  - Dedupe by vmId (latest write wins) and bound the record count.
 *  - Refuses an unsafe run id (assertSafeRunId-style guard) so it can never
 *    write outside `<runRoot>/<bareRunId>/matchlock/`; an unsafe vmId is
 *    refused per record and can never traverse the directory.
 */

import fs from "node:fs";
import path from "node:path";

import { resolveRunRoot } from "../paths.js";
import {
  MATCHLOCK_ERROR_TAIL_MAX_BYTES,
  boundMatchlockErrorText,
} from "./runner-error.js";

/** File name of the per-run orphan store (inside the run's `matchlock/` dir). */
export const VM_ORPHAN_STORE_FILE_NAME = "orphans.json";
/** Run-scoped Matchlock directory that holds the store + per-VM evidence. */
export const VM_ORPHAN_MATCHLOCK_DIR_NAME = "matchlock";
/** Default maximum number of orphan records retained (bounded). */
export const MAX_ORPHAN_VM_RECORDS = 256;
/** Byte bound when reading the store (a corrupt/huge file is never trusted). */
export const MAX_ORPHAN_STORE_BYTES = 4 * 1024 * 1024;
/** Maximum accepted vmId length (bounded; real ids are `vm-<hex>`). */
export const MAX_VM_ID_LENGTH = 200;

export type VmOrphanKind = "probe" | "work";
export type VmOrphanLogLevel = "info" | "warn";

/**
 * ONE orphaned-VM record. `vmId`, `matchlockHome`, `runId`, `invocationId`,
 * `phase`, `error` and `recordedAt` are always present; the identity extras
 * (`agentId`, `round`, `kind`) are present only when the runner supplied them.
 */
export interface VmOrphanVmRecord {
  /** Matchlock VM id (`vm-…`); the store key. */
  vmId: string;
  /**
   * The EFFECTIVE Matchlock rpc HOME the VM was created with (the value
   * prefixed to `.matchlock/vms/<vmId>` and exported as HOME to the rm child).
   */
  matchlockHome: string;
  /** Bare run id (no `run-` prefix) the VM belonged to. */
  runId: string;
  /** Host-bound invocation id of the round that owned the VM. */
  invocationId: string;
  /** Workflow agent/role id (e.g. feature-dev-merge_developer). */
  agentId?: string;
  /** Scheduler round/job marker for the owning round. */
  round?: string;
  /** Invocation kind the VM was created for. */
  kind?: VmOrphanKind;
  /** Failing phase (`close` / `dispose` / …). */
  phase: string;
  /** Serialized (US-001) error detail; never `[object Object]`. */
  error: string;
  /** ISO timestamp the record was written. */
  recordedAt: string;
}

/** Input for {@link writeOrphanVm}: the store supplies runId + timestamp. */
export interface VmOrphanWriteInput {
  vmId: string;
  matchlockHome: string;
  invocationId: string;
  phase: string;
  error: string;
  agentId?: string;
  round?: string | number;
  kind?: VmOrphanKind;
  /** Test seam: an explicit ISO timestamp; defaults to now. */
  recordedAt?: string;
}

export interface VmOrphanStoreOptions {
  /** Bare uuid or `run-` prefixed uuid; normalized to bare internally. */
  runId: string;
  /** Optional host run root override (tests); default resolveRunRoot(). */
  runRoot?: string;
  /** Optional record cap override, clamped to 1..MAX_ORPHAN_VM_RECORDS. */
  maxRecords?: number;
  /** Optional structured log sink (warn on malformed/failure; info on absent). */
  onLog?: (
    level: VmOrphanLogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
}

/** Resolved on-disk location + bounds of one run's orphan store. */
export interface VmOrphanStore {
  /** Bare run id. */
  runId: string;
  /** Absolute run root that contains the run directory. */
  runRoot: string;
  /** `<runRoot>/<bareRunId>/matchlock` (created on write). */
  dir: string;
  /** `<dir>/orphans.json`. */
  file: string;
  /** Effective record cap for this store. */
  maxRecords: number;
  onLog?: VmOrphanStoreOptions["onLog"];
}

/** Typed refusal for an unsafe run id (never for a malformed store FILE). */
export class VmOrphanStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VmOrphanStoreError";
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_PREFIX = "run-";

/** Strip a `run-` prefix when present (mirrors progress-resource). */
export function bareOrphanRunId(runId: string): string {
  return runId.startsWith(RUN_PREFIX) ? runId.slice(RUN_PREFIX.length) : runId;
}

/**
 * Validate and normalize a run id for the store path. Accepts a bare uuid or a
 * `run-` prefixed uuid; refuses anything with path separators / dot segments /
 * non-uuid content (an `assertSafeRunId`-style guard).
 */
export function assertSafeOrphanRunId(runId: string): string {
  if (typeof runId !== "string" || runId.length === 0 || runId.length > 64) {
    throw new VmOrphanStoreError("invalid_run_id", `Refusing malformed run id: ${JSON.stringify(runId)}`);
  }
  const bare = bareOrphanRunId(runId);
  if (!UUID_RE.test(bare) || bare !== bare.replace(/[/\\]/g, "")) {
    throw new VmOrphanStoreError(
      "invalid_run_id",
      `Refusing orphan store for non-uuid run id: ${JSON.stringify(runId)}`,
    );
  }
  return bare;
}

/** True when `vmId` is a single safe path segment (never `.`/`..`/separator). */
export function isSafeOrphanVmId(vmId: unknown): vmId is string {
  return (
    typeof vmId === "string" &&
    vmId.length > 0 &&
    vmId.length <= MAX_VM_ID_LENGTH &&
    vmId !== "." &&
    vmId !== ".." &&
    !vmId.includes("\0") &&
    !/[/\\]/.test(vmId)
  );
}

/** Bound a diagnostic string with the shared Matchlock byte bound. */
function bound(text: string): string {
  return boundMatchlockErrorText(text, MATCHLOCK_ERROR_TAIL_MAX_BYTES);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}

/**
 * Resolve (and validate the path of) one run's orphan store. Throws
 * {@link VmOrphanStoreError} for an unsafe run id — every other failure below
 * is reported, never thrown.
 */
export function resolveVmOrphanStore(opts: VmOrphanStoreOptions): VmOrphanStore {
  const bare = assertSafeOrphanRunId(opts?.runId ?? "");
  const runRoot = typeof opts?.runRoot === "string" && opts.runRoot.length > 0 ? opts.runRoot : resolveRunRoot();
  const resolvedRoot = path.resolve(runRoot);
  const dir = path.join(resolvedRoot, bare, VM_ORPHAN_MATCHLOCK_DIR_NAME);
  const relative = path.relative(resolvedRoot, dir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    // Defense-in-depth: a validated uuid cannot reach here, but never allow a
    // path that escapes the run root (AC4).
    throw new VmOrphanStoreError("unsafe_store_path", `Refusing orphan store outside the run root: ${dir}`);
  }
  const rawMax = opts?.maxRecords;
  const maxRecords =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.min(Math.floor(rawMax), MAX_ORPHAN_VM_RECORDS)
      : MAX_ORPHAN_VM_RECORDS;
  return {
    runId: bare,
    runRoot: resolvedRoot,
    dir,
    file: path.join(dir, VM_ORPHAN_STORE_FILE_NAME),
    maxRecords,
    onLog: opts?.onLog,
  };
}

/** Normalize + validate ONE persisted record; null when it is unusable. */
function normalizeOrphanRecord(raw: unknown, fallbackRunId: string): VmOrphanVmRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const vmId = rec.vmId;
  const matchlockHome = rec.matchlockHome;
  const invocationId = rec.invocationId;
  const phase = rec.phase;
  const error = rec.error;
  const recordedAt = rec.recordedAt;
  if (
    !isSafeOrphanVmId(vmId) ||
    typeof matchlockHome !== "string" ||
    matchlockHome.length === 0 ||
    typeof invocationId !== "string" ||
    invocationId.length === 0 ||
    typeof phase !== "string" ||
    phase.length === 0 ||
    typeof error !== "string" ||
    typeof recordedAt !== "string" ||
    recordedAt.length === 0
  ) {
    return null;
  }
  const runId = typeof rec.runId === "string" && rec.runId.length > 0 ? rec.runId : fallbackRunId;
  const out: VmOrphanVmRecord = {
    vmId,
    matchlockHome,
    runId,
    invocationId,
    phase,
    error,
    recordedAt,
  };
  if (typeof rec.agentId === "string" && rec.agentId.length > 0) out.agentId = rec.agentId;
  if (typeof rec.round === "string" && rec.round.length > 0) out.round = rec.round;
  if (rec.kind === "probe" || rec.kind === "work") out.kind = rec.kind;
  return out;
}

/**
 * Read + validate the store atomically. An absent file is an empty list; an
 * unreadable/oversized/malformed file is a bounded WARN diagnostic + an empty
 * list; individual unusable entries are dropped with one bounded diagnostic.
 * NEVER throws once the store is resolved.
 */
function readStoreRecords(store: VmOrphanStore): VmOrphanVmRecord[] {
  let raw: string;
  try {
    const stat = fs.statSync(store.file);
    if (!stat.isFile()) {
      store.onLog?.("warn", "matchlock orphan store is not a regular file", { file: store.file });
      return [];
    }
    if (stat.size > MAX_ORPHAN_STORE_BYTES) {
      store.onLog?.("warn", "matchlock orphan store is oversized; refusing to read", {
        file: store.file,
        size: stat.size,
        maxBytes: MAX_ORPHAN_STORE_BYTES,
      });
      return [];
    }
    raw = fs.readFileSync(store.file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      store.onLog?.("info", "matchlock orphan store absent", { file: store.file });
      return [];
    }
    store.onLog?.("warn", "matchlock orphan store unreadable", {
      file: store.file,
      error: bound(errMessage(err)),
    });
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    store.onLog?.("warn", "matchlock orphan store is malformed; ignoring", {
      file: store.file,
      error: bound(errMessage(err)),
    });
    return [];
  }
  if (!Array.isArray(parsed)) {
    store.onLog?.("warn", "matchlock orphan store is malformed; ignoring", {
      file: store.file,
      error: "top-level JSON value is not an array",
    });
    return [];
  }

  const records: VmOrphanVmRecord[] = [];
  let dropped = 0;
  for (const entry of parsed) {
    const record = normalizeOrphanRecord(entry, store.runId);
    if (record === null) {
      dropped += 1;
      continue;
    }
    records.push(record);
  }
  if (dropped > 0) {
    store.onLog?.("warn", "matchlock orphan store had unusable records; dropped", {
      file: store.file,
      dropped,
      kept: records.length,
    });
  }
  return records;
}

/** Atomic replace: exclusive temp file in the store dir, then rename over. */
function writeStoreRecords(store: VmOrphanStore, records: readonly VmOrphanVmRecord[]): boolean {
  const serialized = `${JSON.stringify(records, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_ORPHAN_STORE_BYTES) {
    store.onLog?.("warn", "matchlock orphan store write refused: exceeds byte bound", {
      file: store.file,
      maxBytes: MAX_ORPHAN_STORE_BYTES,
    });
    return false;
  }
  const tempFile = path.join(
    store.dir,
    `${VM_ORPHAN_STORE_FILE_NAME}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.mkdirSync(store.dir, { recursive: true });
    fs.writeFileSync(tempFile, serialized, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempFile, store.file);
    return true;
  } catch (err) {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      /* best-effort temp cleanup; the real file is untouched */
    }
    store.onLog?.("warn", "matchlock orphan store write failed", {
      file: store.file,
      error: bound(errMessage(err)),
    });
    return false;
  }
}

/**
 * Record an orphaned VM (dedupe by vmId, latest wins) with an atomic write.
 * Returns the exact record persisted, or null when the VM id is unsafe or the
 * write failed (a bounded WARN diagnostic). NEVER throws except for the
 * documented unsafe-run-id refusal from {@link resolveVmOrphanStore}.
 */
export function writeOrphanVm(
  input: VmOrphanWriteInput,
  opts: VmOrphanStoreOptions,
): VmOrphanVmRecord | null {
  const store = resolveVmOrphanStore(opts);
  if (!isSafeOrphanVmId(input?.vmId)) {
    store.onLog?.("warn", "refusing matchlock orphan record with unsafe vm id", {
      vmId: typeof input?.vmId === "string" ? input.vmId : String(input?.vmId),
    });
    return null;
  }
  if (typeof input?.matchlockHome !== "string" || input.matchlockHome.length === 0) {
    store.onLog?.("warn", "refusing matchlock orphan record with empty matchlockHome", {
      vmId: input.vmId,
    });
    return null;
  }
  if (typeof input?.invocationId !== "string" || input.invocationId.length === 0) {
    store.onLog?.("warn", "refusing matchlock orphan record with empty invocationId", {
      vmId: input.vmId,
    });
    return null;
  }
  if (typeof input?.phase !== "string" || input.phase.length === 0) {
    store.onLog?.("warn", "refusing matchlock orphan record with empty phase", { vmId: input.vmId });
    return null;
  }
  if (typeof input?.error !== "string") {
    store.onLog?.("warn", "refusing matchlock orphan record with non-string error", { vmId: input.vmId });
    return null;
  }

  const record: VmOrphanVmRecord = {
    vmId: input.vmId,
    matchlockHome: input.matchlockHome,
    runId: store.runId,
    invocationId: input.invocationId,
    phase: input.phase,
    error: input.error,
    recordedAt:
      typeof input.recordedAt === "string" && input.recordedAt.length > 0
        ? input.recordedAt
        : new Date().toISOString(),
  };
  if (typeof input.agentId === "string" && input.agentId.length > 0) record.agentId = input.agentId;
  if (input.round !== undefined && input.round !== null && String(input.round).length > 0) {
    record.round = String(input.round);
  }
  if (input.kind === "probe" || input.kind === "work") record.kind = input.kind;

  const existing = readStoreRecords(store);
  const merged = existing.filter((entry) => entry.vmId !== record.vmId);
  merged.push(record);
  let boundedList = merged;
  if (merged.length > store.maxRecords) {
    const overflow = merged.length - store.maxRecords;
    const dropped = merged.slice(0, overflow);
    boundedList = merged.slice(overflow);
    store.onLog?.("warn", "matchlock orphan store record cap reached; dropping oldest", {
      file: store.file,
      maxRecords: store.maxRecords,
      droppedVmIds: dropped.map((entry) => entry.vmId).join(","),
    });
  }

  if (!writeStoreRecords(store, boundedList)) return null;
  return record;
}

/**
 * Read every orphan record for the run. Absent ⇒ []; unreadable/malformed ⇒
 * a bounded WARN diagnostic + []. NEVER throws once the store is resolved.
 */
export function readOrphanVms(opts: VmOrphanStoreOptions): VmOrphanVmRecord[] {
  const store = resolveVmOrphanStore(opts);
  try {
    return readStoreRecords(store);
  } catch (err) {
    // Defense-in-depth: a malformed store must never break the reaper/cleanup.
    store.onLog?.("warn", "matchlock orphan store read failed; treating as empty", {
      file: store.file,
      error: bound(errMessage(err)),
    });
    return [];
  }
}

/**
 * Remove the record for exactly one vmId. Returns true when a record was
 * removed (and the store was rewritten), false when there was nothing to clear
 * or the rewrite failed. NEVER throws once the store is resolved.
 */
export function clearOrphanVm(vmId: string, opts: VmOrphanStoreOptions): boolean {
  const store = resolveVmOrphanStore(opts);
  try {
    if (!isSafeOrphanVmId(vmId)) {
      store.onLog?.("warn", "refusing to clear matchlock orphan record with unsafe vm id", {
        vmId: typeof vmId === "string" ? vmId : String(vmId),
      });
      return false;
    }
    const existing = readStoreRecords(store);
    const remaining = existing.filter((entry) => entry.vmId !== vmId);
    if (remaining.length === existing.length) return false;
    return writeStoreRecords(store, remaining);
  } catch (err) {
    store.onLog?.("warn", "matchlock orphan store clear failed", {
      file: store.file,
      vmId,
      error: bound(errMessage(err)),
    });
    return false;
  }
}
