/**
 * Daemon lifecycle observability — heartbeat marker + config fingerprint.
 *
 * The daemon cannot catch SIGKILL-class deaths, so unclean termination is
 * proven after the fact: a small heartbeat marker file records the running
 * instance's pid and liveness timestamps, and a clean shutdown removes
 * ("finalizes") it. On the next startup the daemon can detect a stale,
 * unfinalized marker (the prior instance never wrote daemon.shutdown) and
 * journal a daemon.uncleanExit entry.
 *
 * The marker is deliberately tiny (one small JSON file, one line) and every
 * write here is best-effort by contract: never throws, never blocks the
 * daemon. All functions accept DaemonctlPathOptions { homeDir } for test
 * isolation and honor the logger-style test guard (assertStatePathIsolation):
 * a guarded process resolving the production path must neither write
 * production state nor throw.
 *
 * Unclean-death detection (detectUncleanExit) and the shared death reader
 * (getLastDaemonDeath) live here too: they pair the marker with the
 * lifecycle.log journal so the next startup can prove a prior SIGKILL-class
 * death and surface the most recent daemon death for status/dashboard.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { assertStatePathIsolation } from "../lib/test-guard.js";
import { recordLifecycleEvent } from "./daemonctl.js";

/**
 * Default heartbeat interval: 10s. Production constraint — the heartbeat must
 * stay cheap (no busy polling, interval >= 10s by default). Tests override it
 * via TAMANDUA_HEARTBEAT_INTERVAL_MS (e.g. 100ms).
 */
export const HEARTBEAT_INTERVAL_DEFAULT_MS = 10_000;

/** Marker file name inside <state>/.tamandua/. */
export const HEARTBEAT_FILENAME = "daemon-heartbeat.json";

/**
 * Path options mirroring DaemonctlPathOptions: when `homeDir` is set, state
 * files resolve under `<homeDir>/.tamandua/` instead of `~/.tamandua/`.
 * Structurally identical to the daemonctl type, so either can be passed.
 */
export interface DaemonctlPathOptions {
  /** When set, use this directory instead of ~/.tamandua for state files. */
  homeDir?: string;
}

/** Contents of the heartbeat marker file (one-line JSON). */
export interface HeartbeatMarker {
  pid: number;
  /** ISO timestamp of daemon start (when the marker was first written). */
  startedAt: string;
  /** ISO timestamp of the most recent liveness touch. */
  lastHeartbeatAt: string;
}

function defaultTamanduaDir(): string {
  return path.join(process.env.HOME?.trim() || os.homedir(), ".tamandua");
}

function getTamanduaDir(opts?: DaemonctlPathOptions): string {
  return opts?.homeDir ? path.join(opts.homeDir, ".tamandua") : defaultTamanduaDir();
}

/**
 * Absolute path to the heartbeat marker file. Like the daemonctl path
 * getters, this asserts state-path isolation when no homeDir is given and the
 * guard is active (refuses to resolve into the production ~/.tamandua).
 */
export function getHeartbeatPath(opts?: DaemonctlPathOptions): string {
  const filePath = path.join(getTamanduaDir(opts), HEARTBEAT_FILENAME);
  if (!opts?.homeDir) {
    assertStatePathIsolation(filePath, "getHeartbeatPath()");
  }
  return filePath;
}

/**
 * Write a fresh marker for the current process. Tiny, best-effort, never
 * throws; mkdir recursive before write. A guarded process resolving the
 * production path drops the write instead.
 */
export function writeHeartbeatMarker(opts?: DaemonctlPathOptions): void {
  try {
    const file = getHeartbeatPath(opts);
    const now = new Date().toISOString();
    const marker: HeartbeatMarker = {
      pid: process.pid,
      startedAt: now,
      lastHeartbeatAt: now,
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(marker), "utf-8");
  } catch {
    // Best-effort by contract: never throws, never writes production state.
  }
}

/**
 * Read the marker, or null when it is missing, corrupt (unparseable or wrong
 * shape), or when a guarded process resolved the production path.
 */
export function readHeartbeatMarker(opts?: DaemonctlPathOptions): HeartbeatMarker | null {
  try {
    const file = getHeartbeatPath(opts);
    const raw = fs.readFileSync(file, "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<HeartbeatMarker>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.lastHeartbeatAt !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      lastHeartbeatAt: parsed.lastHeartbeatAt,
    };
  } catch {
    return null;
  }
}

/**
 * Update the marker's lastHeartbeatAt, preserving pid and startedAt. No-op
 * when no marker exists (nothing to preserve). Best-effort, never throws.
 */
export function touchHeartbeat(opts?: DaemonctlPathOptions): void {
  try {
    const existing = readHeartbeatMarker(opts);
    if (!existing) return;
    existing.lastHeartbeatAt = new Date().toISOString();
    const file = getHeartbeatPath(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(existing), "utf-8");
  } catch {
    // Best-effort.
  }
}

/**
 * Remove the marker file. Idempotent (missing file is a no-op) and
 * best-effort — never throws.
 */
export function finalizeHeartbeatMarker(opts?: DaemonctlPathOptions): void {
  try {
    const file = getHeartbeatPath(opts);
    fs.rmSync(file, { force: true });
  } catch {
    // Best-effort; rmSync(force) never throws on a missing file.
  }
}

/**
 * sha256 hex fingerprint of <state>/.tamandua/agents.json contents, or the
 * string "none" when the file is missing (or unreadable / guarded). Cheap and
 * best-effort: a config fingerprint rides along in daemon.start journal
 * entries so an operator can see which agent config a daemon booted with.
 */
export function computeConfigFingerprint(opts?: DaemonctlPathOptions): string {
  try {
    const agentsPath = path.join(getTamanduaDir(opts), "agents.json");
    if (!opts?.homeDir) {
      assertStatePathIsolation(agentsPath, "computeConfigFingerprint()");
    }
    const content = fs.readFileSync(agentsPath, "utf-8");
    return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
  } catch {
    return "none";
  }
}

/**
 * Heartbeat interval in milliseconds: HEARTBEAT_INTERVAL_DEFAULT_MS (10s) by
 * default, overridable via TAMANDUA_HEARTBEAT_INTERVAL_MS (positive integer
 * ms; tests use short values like 100). Invalid/absent values fall back to
 * the default.
 */
export function getHeartbeatIntervalMs(): number {
  const raw = process.env.TAMANDUA_HEARTBEAT_INTERVAL_MS?.trim();
  if (raw === undefined || raw === "") return HEARTBEAT_INTERVAL_DEFAULT_MS;
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms <= 0) return HEARTBEAT_INTERVAL_DEFAULT_MS;
  return ms;
}

// ── Unclean-death detection ─────────────────────────────────────────

/**
 * Facts about a prior daemon instance that died uncleanly (SIGKILL-class),
 * returned by detectUncleanExit and journaled in the daemon.uncleanExit entry.
 */
export interface UncleanExitFacts {
  /** pid of the prior (dead) daemon instance. */
  priorPid: number;
  /** ISO timestamp of the prior instance's start (marker.startedAt). */
  startedAt: string;
  /** ISO timestamp of the prior instance's last heartbeat. */
  lastHeartbeatAt: string;
  /** Age of the last heartbeat in ms at detection time (>= 0). */
  lastHeartbeatAgeMs: number;
}

/**
 * A normalized daemon death for surfacing (status / dashboard): the shared
 * reader shape produced by getLastDaemonDeath from lifecycle.log entries.
 */
export interface DaemonDeath {
  kind: "clean" | "unclean";
  /** ISO timestamp of the death journal entry. */
  ts: string;
  /** pid of the daemon instance that died (shutdown targetPid / marker pid). */
  pid: number;
  /** Signal recorded for a clean shutdown (e.g. SIGTERM), when present. */
  signal?: string;
  /** Prior instance pid for an unclean death, when present. */
  priorPid?: number;
  /** Last-heartbeat age in ms for an unclean death, when present. */
  lastHeartbeatAgeMs?: number;
}

/**
 * Read every parseable lifecycle.log entry, newest last (append order).
 * Best-effort: a missing/unreadable log or a guarded process resolving the
 * production path yields []. Never throws.
 */
function readLifecycleLogEntries(opts?: DaemonctlPathOptions): Record<string, unknown>[] {
  try {
    const file = path.join(getTamanduaDir(opts), "lifecycle.log");
    if (!opts?.homeDir) {
      assertStatePathIsolation(file, "readLifecycleLogEntries()");
    }
    const raw = fs.readFileSync(file, "utf-8");
    const entries: Record<string, unknown>[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") entries.push(parsed);
      } catch {
        // Skip corrupt lines — the journal must never break detection.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * True when the journal already accounts for the marker's instance: a
 * daemon.shutdown (a clean exit ran) or daemon.uncleanExit (the unclean
 * death was already reported) entry with targetPid === marker.pid and ts >=
 * marker.startedAt. A shutdown journaled before the marker was written (or
 * for a different pid) does not count. Also keeps detectUncleanExit
 * idempotent per stale marker — a death is proven and journaled once.
 */
function markerAccountedFor(marker: HeartbeatMarker, opts?: DaemonctlPathOptions): boolean {
  const startedAtMs = Date.parse(marker.startedAt);
  if (Number.isNaN(startedAtMs)) return false;
  for (const entry of readLifecycleLogEntries(opts)) {
    if (entry.action !== "daemon.shutdown" && entry.action !== "daemon.uncleanExit") continue;
    if (entry.targetPid !== marker.pid) continue;
    const tsMs = typeof entry.ts === "string" ? Date.parse(entry.ts) : NaN;
    if (Number.isNaN(tsMs)) continue;
    if (tsMs >= startedAtMs) return true;
  }
  return false;
}

/** Age of a heartbeat timestamp in ms at now, clamped to >= 0. */
function heartbeatAgeMs(lastHeartbeatAt: string): number {
  const parsed = Date.parse(lastHeartbeatAt);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, Date.now() - parsed);
}

/**
 * Detect whether the previous daemon instance died uncleanly (SIGKILL-class)
 * and, when it did, journal daemon.uncleanExit with the prior instance's
 * facts.
 *
 * - Heartbeat marker absent or finalized (removed by a clean shutdown) →
 *   null, no unclean exit.
 * - Marker present but the journal already accounts for it (a matching
 *   daemon.shutdown — targetPid === marker.pid, ts >= marker.startedAt — or
 *   a prior daemon.uncleanExit for the same marker) → null.
 * - Stale unfinalized marker with no matching shutdown → appends a
 *   daemon.uncleanExit journal entry carrying { priorPid, startedAt,
 *   lastHeartbeatAt, lastHeartbeatAgeMs } and returns the facts.
 *
 * Best-effort by contract: never throws, never blocks daemon startup.
 * Journaling honors the test guard (recordLifecycleEvent drops the line from
 * a guarded process resolving production paths).
 */
export function detectUncleanExit(opts?: DaemonctlPathOptions): UncleanExitFacts | null {
  try {
    const marker = readHeartbeatMarker(opts);
    if (!marker) return null; // absent or finalized → no unclean exit

    if (markerAccountedFor(marker, opts)) return null;

    const facts: UncleanExitFacts = {
      priorPid: marker.pid,
      startedAt: marker.startedAt,
      lastHeartbeatAt: marker.lastHeartbeatAt,
      lastHeartbeatAgeMs: heartbeatAgeMs(marker.lastHeartbeatAt),
    };
    // targetPid is the marker's pid (the dead instance), mirroring how
    // daemon.shutdown entries carry the dying instance's pid.
    recordLifecycleEvent("daemon.uncleanExit", marker.pid, opts, { ...facts });
    return facts;
  } catch {
    return null;
  }
}

/** Normalize one lifecycle.log entry into a DaemonDeath, or null. */
function normalizeDeath(entry: Record<string, unknown>): DaemonDeath | null {
  const ts = typeof entry.ts === "string" ? entry.ts : null;
  if (!ts || Number.isNaN(Date.parse(ts))) return null;

  if (entry.action === "daemon.shutdown") {
    const pid = typeof entry.targetPid === "number" ? entry.targetPid : null;
    if (pid === null) return null;
    const death: DaemonDeath = { kind: "clean", ts, pid };
    if (typeof entry.signal === "string") death.signal = entry.signal;
    return death;
  }

  if (entry.action === "daemon.uncleanExit") {
    const pid = typeof entry.targetPid === "number" ? entry.targetPid : null;
    const priorPid = typeof entry.priorPid === "number" ? entry.priorPid : null;
    if (pid === null && priorPid === null) return null;
    const death: DaemonDeath = { kind: "unclean", ts, pid: pid ?? priorPid! };
    if (priorPid !== null) death.priorPid = priorPid;
    if (typeof entry.lastHeartbeatAgeMs === "number") {
      death.lastHeartbeatAgeMs = entry.lastHeartbeatAgeMs;
    }
    return death;
  }

  return null;
}

/**
 * The most recent daemon death (clean daemon.shutdown or unclean
 * daemon.uncleanExit) from lifecycle.log, normalized to the shared
 * DaemonDeath shape, or null when the journal has no death entries. This is
 * the shared reader for status and dashboard surfacing (US-004/US-005).
 * Best-effort: never throws.
 */
export function getLastDaemonDeath(opts?: DaemonctlPathOptions): DaemonDeath | null {
  try {
    const deaths: DaemonDeath[] = [];
    for (const entry of readLifecycleLogEntries(opts)) {
      const death = normalizeDeath(entry);
      if (death) deaths.push(death);
    }
    if (deaths.length === 0) return null;
    deaths.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return deaths[0];
  } catch {
    return null;
  }
}

// ── Operator acknowledgment (lifecycle-seen.json) ────────────────────

/**
 * File name for the operator acknowledgment marker inside <state>/.tamandua/.
 * `tamandua status` writes the ts of the last death it surfaced so a
 * subsequent run can tell a fresh (unseen) unclean death from one the
 * operator already acknowledged.
 */
export const LIFECYCLE_SEEN_FILENAME = "lifecycle-seen.json";

/**
 * Absolute path to lifecycle-seen.json. Like the other state path getters,
 * asserts state-path isolation when no homeDir is given and the guard is
 * active (refuses to resolve into the production ~/.tamandua).
 */
export function getLifecycleSeenPath(opts?: DaemonctlPathOptions): string {
  const filePath = path.join(getTamanduaDir(opts), LIFECYCLE_SEEN_FILENAME);
  if (!opts?.homeDir) {
    assertStatePathIsolation(filePath, "getLifecycleSeenPath()");
  }
  return filePath;
}

/**
 * The acknowledged (seen) daemon-death ts from lifecycle-seen.json, or null
 * when the file is missing, corrupt, or a guarded process resolved the
 * production path. Best-effort: never throws.
 */
export function getLifecycleSeenTs(opts?: DaemonctlPathOptions): string | null {
  try {
    const file = getLifecycleSeenPath(opts);
    const raw = fs.readFileSync(file, "utf-8").trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts?: unknown };
    if (typeof parsed.ts !== "string" || parsed.ts === "") return null;
    return parsed.ts;
  } catch {
    return null;
  }
}

/**
 * Record that an operator has seen (acknowledged) a daemon death by writing
 * lifecycle-seen.json with its ts. A small atomic JSON write: the payload is
 * written to a temp file and renamed into place, so a crash mid-write never
 * leaves a corrupt seen marker. Best-effort by contract: never throws, and a
 * guarded process resolving the production path drops the write instead.
 */
export function acknowledgeDaemonDeath(ts: string, opts?: DaemonctlPathOptions): void {
  try {
    const file = getLifecycleSeenPath(opts);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ts }), "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    // Best-effort; never throws. A stray temp file is harmless.
  }
}

/**
 * True when a daemon death has not been acknowledged by an operator: an
 * unclean death whose ts is newer than the acknowledged ts in
 * lifecycle-seen.json (or when nothing has been acknowledged yet). Clean
 * deaths are never "unseen". Best-effort: never throws.
 */
export function isUnseenDaemonDeath(death: DaemonDeath, opts?: DaemonctlPathOptions): boolean {
  try {
    if (death.kind !== "unclean") return false;
    const seenTs = getLifecycleSeenTs(opts);
    if (seenTs === null) return true;
    const deathMs = Date.parse(death.ts);
    const seenMs = Date.parse(seenTs);
    if (Number.isNaN(deathMs) || Number.isNaN(seenMs)) return true;
    return deathMs > seenMs;
  } catch {
    return true;
  }
}
