/**
 * MTLK host suite: explicit host-owned Matchlock evidence store (SQLite).
 *
 * THIS FILE IS THE "SEPARATE MATCHLOCK-ONLY EVIDENCE STORE" required by the
 * MTLK-SUITE-HOST component: every table below lives in an EXPLICIT SQLite
 * database supplied by host code — never in the native tamandua DB, never
 * with namespace columns bolted onto native suite_results, and never opened
 * against default/live schema-9 state. The native schema/migrate(), native
 * suite_results and the native SQL filters are untouched; a guest row can
 * never be counted as native evidence because it does not exist there.
 *
 * Isolation model (design section 8): the host-chosen namespace is a SEPARATE
 * key axis on every record/claim/event. The exact raw command SHA-256
 * (cmd_hash) and the original repository identity (origin_repo) are preserved
 * as separate fields exactly like the native ledger; the namespace columns
 * (image content id / guest platform / helper contract / nonsecret
 * compatibility fingerprint) are recorded as their own axis so no
 * cross-image/helper/platform/fingerprint evidence can ever answer a lookup.
 *
 * Durability/atomicity: rows are written inside SQLite transactions keyed by
 * unique keys, so interleaving service objects that share this store cannot
 * both acquire one claim, and a duplicate exact record is acknowledged with
 * the ORIGINAL row id instead of a duplicate row. Errors stay bounded and
 * nonsecret (no raw SQL/config/credentials leak out of this module).
 *
 * Claims carry host invocation identity + exact owner token. Only the exact
 * owner token releases a claim; a different invocation's record never consumes
 * an owner's claim (records clear only the recorder's own claim). Stale claims
 * are swept by host-clock expiry (CLAIM_TIMEOUT_MS) or by an EXPLICIT host
 * "owner dead" predicate supplied by the caller (the host invocation registry
 * — never a guest PID). Revocation/recovery is host-owned.
 *
 * Claim-instant authority (TIME-RESIDUE item 4): the ISO-8601 UTC `claimed_at`
 * column is the ONE authoritative claim instant. The redundant
 * `claimed_at_ms INTEGER` companion was removed because the only thing it ever
 * answered — whether the claim has outlived CLAIM_TIMEOUT_MS — is fully
 * answerable from the ISO instant by parsing it (`parseInstant`) and comparing
 * numerically. A duplicated epoch column can only drift from the value it
 * duplicates, so `openHostSuiteStore()` drops it from a legacy store with an
 * idempotent migration (a no-op when the column is already absent), and a
 * `claimed_at` that cannot be parsed is treated as EXPIRED so a corrupt row can
 * never block a key forever.
 *
 * Node-core only + node:sqlite (the host store is NOT part of the portable RO
 * guest pack closure: guest-pack-builder walks only the guest-cli/service
 * entries, which never import this module).
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { instantAgeMs, isOlderThan, parseInstant } from "../../lib/instant.js";
import {
  CLAIM_TIMEOUT_MS,
  FLAKE_WINDOW_MS,
  GUEST_SUITE_TRANSPORT_VERSION,
  guestSuiteNamespaceId,
  isPermittedSuiteEvent,
  normalizeGuestSuiteNamespace,
  type GuestSuiteLatestRow,
  type GuestSuiteNamespace,
} from "./guest-suite-contract.js";

/** Version of this store's table layout. */
export const HOST_SUITE_STORE_VERSION = 1;

/**
 * Tolerance for the FLAKE_WINDOW_MS age comparison (TIME-RESIDUE item 2).
 *
 * The window is a coarse 24h bucket over a ledger written by multiple
 * processes/hosts whose wall clocks may differ by sub-second amounts, so 1s
 * of slack keeps a row written just inside the window from being dropped by
 * skew. The comparison stays strict at the widened boundary
 * (`age > FLAKE_WINDOW_MS + tolerance`). Mirrors dashboard.ts
 * `flakyKeysWithinWindow` (commit 4204af63).
 */
const FLAKE_WINDOW_TOLERANCE_MS = 1_000;

/** Bound on the number of duration-history rows returned by one query. */
export const HOST_SUITE_DURATION_HISTORY_MAX_ROWS = 10_000;

/** Bound on the nearest-evidence diagnostic rows returned by one query. */
export const HOST_SUITE_NEAREST_MAX_ROWS = 3;

/** Bounded serialized event field cap (defense in depth after shape checks). */
export const HOST_SUITE_EVENT_FIELDS_MAX_BYTES = 64 * 1024;

export interface HostSuiteNamespaceRow {
  namespaceId: string;
  imageContentId: string;
  guestPlatform: string;
  helperContract: string;
  compatibilityFingerprint: string;
  createdAt: string;
}

/** One persisted host-suite result row (native suite_results shape + namespace axis). */
export interface HostSuiteResultRow extends GuestSuiteLatestRow {
  id: number;
  namespace_id: string;
  origin_repo: string;
  tree_hash: string;
  cmd_hash: string;
  cmd_display: string;
  exit_code: number;
  duration_ms: number;
  log_tail: string | null;
  run_id: string | null;
  step_id: string | null;
  invocation_id: string;
  agent_id: string | null;
  job_id: string | null;
  started_at: string;
  created_at: string;
}

/**
 * Row returned by `lookup()`: the guest-facing, native-shaped SELECT subset
 * (id, namespace axis, key, outcome, run/step attribution, created_at) plus the
 * namespace axis. Identity attribution columns (invocation_id/agent_id/job_id/
 * started_at) are deliberately NOT selected on this surface — they are
 * persisted for audit but never shipped to a guest, exactly like the native
 * transport row shape. `queryMergeEvidence()` (host-side seam) returns the
 * FULL `HostSuiteResultRow` instead.
 */
export interface HostSuiteLookupRow {
  id: number;
  namespace_id: string;
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

export interface HostSuiteLedgerKey {
  namespaceId: string;
  originRepo: string;
  treeHash: string;
  cmdHash: string;
}

export interface HostSuiteDurationKey {
  namespaceId: string;
  originRepo: string;
  cmdHash: string;
}

/** Bounded nearest-evidence diagnostic row (same namespace + origin + command). */
export interface HostSuiteNearestRow {
  tree_hash: string;
  exit_code: number;
  created_at: string;
}

export interface HostSuiteClaimRow {
  namespace_id: string;
  origin_repo: string;
  tree_hash: string;
  cmd_hash: string;
  owner_token: string;
  run_id: string | null;
  step_id: string | null;
  invocation_id: string;
  agent_id: string | null;
  job_id: string | null;
  claimed_at: string;
}

export interface HostSuiteEventRow {
  id: number;
  namespace_id: string;
  event: string;
  run_id: string | null;
  step_id: string | null;
  fields_json: string | null;
  created_at: string;
}

/** Bounded, nonsecret store error surfaced to the caller (never raw SQL). */
export class HostSuiteStoreError extends Error {
  constructor(
    message: string,
    readonly code: "IO" | "CLOSED" | "CONFLICT" | "BAD_STATE",
  ) {
    super(message);
    this.name = "HostSuiteStoreError";
  }
}

/** A release request did not carry the exact token (or exact owner invocation). */
export class HostSuiteClaimOwnerMismatchError extends HostSuiteStoreError {
  constructor(message: string) {
    super(message, "CONFLICT");
    this.name = "HostSuiteClaimOwnerMismatchError";
  }
}

/** A record retry collided with an already-accepted, DIFFERENT payload. */
export class HostSuiteMismatchedRetryError extends HostSuiteStoreError {
  constructor(message: string) {
    super(message, "CONFLICT");
    this.name = "HostSuiteMismatchedRetryError";
  }
}

export interface HostSuiteClaimOutcome {
  action: "run" | "wait";
  claimedAt: string;
}

export interface HostSuiteRecordOutcome {
  id: number;
  createdAt: string;
  /** True when this call inserted a new row; false = truthful duplicate ack. */
  inserted: boolean;
}

export interface HostSuiteReleaseOutcome {
  released: boolean;
}

export interface HostSuiteLookupOutcome {
  /**
   * Latest native-shaped row for the exact key — the guest-facing SELECT
   * subset only (no identity attribution columns; see HostSuiteLookupRow).
   */
  latest: HostSuiteLookupRow | null;
  passCount: number;
  failCount: number;
  flaky: boolean;
}

/** Canonical insert payload for one suite execution (native record fields). */
export interface HostSuiteRecordInput extends HostSuiteLedgerKey {
  cmdDisplay: string;
  exitCode: number;
  durationMs: number;
  logTail: string | null;
  runId: string | null;
  stepId: string | null;
  startedAt: string;
  invocationId: string;
  agentId: string | null;
  jobId: string | null;
  /**
   * Replay-bypass hint from the guest engine (native parity). The persisted
   * evidence row does NOT store force (native suite_results has no force
   * column either); a forced execution records an ordinary outcome row, and
   * force is deliberately excluded from the idempotency payload digest.
   */
  force: boolean;
}

/**
 * Canonical claim input (owner token is minted by the GUEST invocation).
 *
 * A claim row is single-flight OWNERSHIP state: it persists the exact
 * owner token + host invocation/attribution for the key, never a replay
 * hint. `force` is an engine replay-bypass input, not a claim property, so
 * it is intentionally absent here — nothing about force is recorded on a
 * claim (see HostSuiteRecordInput.force for the record-side note).
 */
export interface HostSuiteClaimInput extends HostSuiteLedgerKey {
  ownerToken: string;
  runId?: string;
  stepId?: string;
  invocationId: string;
  agentId: string | null;
  jobId: string | null;
}

export interface HostSuiteReleaseInput extends HostSuiteLedgerKey {
  ownerToken: string;
  /** Caller invocation identity (must equal the claim's recorded owner). */
  invocationId: string;
  reason?: string;
}

export interface HostSuiteEventInput {
  namespaceId: string;
  event: string;
  runId: string;
  stepId?: string;
  fields?: Record<string, unknown>;
  fieldsJson: string | null;
  createdAt: string;
}

export interface HostSuiteStoreOptions {
  /**
   * Host clock (ms epoch) for claimed_at/expiry and row timestamps.
   * Defaults to Date.now.
   */
  now?: () => number;
  /**
   * Single-flight claim lifetime before host-clock expiry sweep.
   * Defaults to the native CLAIM_TIMEOUT_MS (30 min).
   */
  claimTimeoutMs?: number;
}

const DDL = `
CREATE TABLE IF NOT EXISTS host_suite_namespace (
  namespace_id TEXT PRIMARY KEY,
  image_content_id TEXT NOT NULL,
  guest_platform TEXT NOT NULL,
  helper_contract TEXT NOT NULL,
  compatibility_fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS host_suite_results (
  id INTEGER PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  origin_repo TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  cmd_hash TEXT NOT NULL,
  cmd_display TEXT NOT NULL,
  exit_code INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  log_tail TEXT,
  run_id TEXT,
  step_id TEXT,
  invocation_id TEXT NOT NULL,
  agent_id TEXT,
  job_id TEXT,
  started_at TEXT NOT NULL,
  payload_digest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_suite_results_lookup
  ON host_suite_results(namespace_id, origin_repo, tree_hash, cmd_hash, created_at, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_host_suite_results_idem
  ON host_suite_results(namespace_id, origin_repo, tree_hash, cmd_hash, invocation_id, started_at);
CREATE TABLE IF NOT EXISTS host_suite_claims (
  namespace_id TEXT NOT NULL,
  origin_repo TEXT NOT NULL,
  tree_hash TEXT NOT NULL,
  cmd_hash TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  invocation_id TEXT NOT NULL,
  agent_id TEXT,
  job_id TEXT,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (namespace_id, origin_repo, tree_hash, cmd_hash)
);
CREATE TABLE IF NOT EXISTS host_suite_events (
  id INTEGER PRIMARY KEY,
  namespace_id TEXT NOT NULL,
  event TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  fields_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_suite_events_scope
  ON host_suite_events(namespace_id, created_at, id);
CREATE TABLE IF NOT EXISTS host_suite_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Canonical namespace registration for a host-admitted namespace. The
 * namespace ROW is the host's own chosen fields (immutable at binding time);
 * a request can never register a different namespace here.
 */
export function hostSuiteNamespaceKey(ns: GuestSuiteNamespace): string {
  return guestSuiteNamespaceId(ns);
}

function assertOpen(db: DatabaseSync): void {
  if (!db.isOpen) throw new HostSuiteStoreError("host suite store is closed", "CLOSED");
}

/**
 * Idempotent claim-schema migration (TIME-RESIDUE item 4).
 *
 * The legacy `host_suite_claims` layout carried `claimed_at_ms INTEGER` next to
 * the authoritative ISO-Z `claimed_at`. Expiry is answerable from the ISO
 * instant alone (see the file header), so a store written by an older build is
 * brought forward by dropping the redundant column. This is a NO-OP when the
 * column is already absent (fresh stores and already-migrated stores), which is
 * what makes it safe to run on every open. node:sqlite bundles SQLite 3.53,
 * which supports `ALTER TABLE ... DROP COLUMN`.
 */
function migrateHostSuiteClaims(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(host_suite_claims)").all() as Array<{
    name: unknown;
  }>;
  const hasLegacyColumn = columns.some((col) => String(col.name) === "claimed_at_ms");
  if (!hasLegacyColumn) return;
  db.exec("ALTER TABLE host_suite_claims DROP COLUMN claimed_at_ms");
}

/**
 * Open (create when missing) an explicit host-owned Matchlock evidence store.
 *
 * `path` MUST be an explicit host-chosen location (a fresh isolated file in
 * tests/integration). The special ":memory:" path opens a process-private
 * in-memory store. This store is never the native/global default state and
 * never opens live schema-9 candidate data.
 */
export function openHostSuiteStore(path: string, opts: HostSuiteStoreOptions = {}): HostSuiteStore {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (err) {
    throw new HostSuiteStoreError(
      `cannot open explicit host suite store: ${err instanceof Error ? err.message : String(err)}`,
      "IO",
    );
  }
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.exec(DDL);
    migrateHostSuiteClaims(db);
    db.prepare(
      "INSERT OR IGNORE INTO host_suite_meta (key, value) VALUES (?, ?)",
    ).run("schema_version", String(HOST_SUITE_STORE_VERSION));
  } catch (err) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw new HostSuiteStoreError(
      `cannot initialize explicit host suite store: ${err instanceof Error ? err.message : String(err)}`,
      "IO",
    );
  }
  return new HostSuiteStore(db, path, opts);
}

type RowRecord = Record<string, unknown>;

function toRow(r: RowRecord | undefined): RowRecord | null {
  return r === undefined ? null : r;
}

function fmtIso(ms: number): string {
  return new Date(ms).toISOString();
}

function payloadDigest(input: {
  exitCode: number;
  durationMs: number;
  logTail: string | null;
  cmdDisplay: string;
}): string {
  return createHash("sha256")
    .update(`${input.exitCode}\u0000${input.durationMs}\u0000${input.logTail ?? ""}\u0000${input.cmdDisplay}`)
    .digest("hex");
}

/**
 * Bound JSON for event fields (bytes).
 *
 * Oversized (after successful serialization) throws HostSuiteStoreError
 * CONFLICT. A payload that cannot be serialized at all (e.g. a circular
 * reference or a BigInt value) is NOT a size problem: JSON.stringify itself
 * throws and the error propagates unchanged, so the caller can refuse it as a
 * malformed (BAD_REQUEST) request instead of mislabeling it OVERSIZED.
 */
export function boundEventFieldsJson(fields: Record<string, unknown> | undefined): string | null {
  if (fields === undefined || fields === null) return null;
  const json = JSON.stringify(fields);
  if (json === undefined) return null;
  if (Buffer.byteLength(json, "utf-8") > HOST_SUITE_EVENT_FIELDS_MAX_BYTES) {
    throw new HostSuiteStoreError("suite event fields exceed the bounded size limit", "CONFLICT");
  }
  return json;
}

export class HostSuiteStore {
  readonly schemaVersion = HOST_SUITE_STORE_VERSION;
  private readonly db: DatabaseSync;
  private readonly nowFn: () => number;
  private readonly claimTimeoutMs: number;

  constructor(
    db: DatabaseSync,
    readonly path: string,
    opts: HostSuiteStoreOptions = {},
  ) {
    this.db = db;
    this.nowFn = opts.now ?? Date.now;
    this.claimTimeoutMs = opts.claimTimeoutMs ?? CLAIM_TIMEOUT_MS;
  }

  get isOpen(): boolean {
    return this.db.isOpen;
  }

  close(): void {
    if (this.db.isOpen) {
      try {
        this.db.close();
      } catch {
        /* ignore */
      }
    }
  }

  now(): number {
    return this.nowFn();
  }

  // ── internal transaction helper (synchronous; no await inside) ───────

  private tx<T>(fn: () => T): T {
    assertOpen(this.db);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  // ── namespace registration ───────────────────────────────────────────

  /**
   * Register the HOST-admitted namespace row (INSERT OR IGNORE). A namespace
   * row can never be altered by a request: once the host bound its chosen
   * fields under this canonical id, they are immutable in this store.
   */
  registerNamespace(ns: GuestSuiteNamespace): HostSuiteNamespaceRow {
    const normalized = normalizeGuestSuiteNamespace({ ...ns });
    if (!normalized.ok) {
      throw new HostSuiteStoreError(
        `invalid host-admitted suite namespace: ${normalized.error}`,
        "BAD_STATE",
      );
    }
    const namespaceId = hostSuiteNamespaceKey(normalized.value);
    const createdAt = fmtIso(this.nowFn());
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO host_suite_namespace
         (namespace_id, image_content_id, guest_platform, helper_contract, compatibility_fingerprint, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      namespaceId,
      normalized.value.imageContentId,
      normalized.value.guestPlatform,
      normalized.value.helperContract,
      normalized.value.compatibilityFingerprint,
      createdAt,
    );
    return {
      namespaceId,
      imageContentId: normalized.value.imageContentId,
      guestPlatform: normalized.value.guestPlatform,
      helperContract: normalized.value.helperContract,
      compatibilityFingerprint: normalized.value.compatibilityFingerprint,
      createdAt,
    };
  }

  // ── suite.lookup ─────────────────────────────────────────────────────

  /**
   * Latest evidence row for the exact key plus the pass/fail counts inside the
   * 24h flake window.
   *
   * The window is decided NUMERICALLY from parsed instants (TIME-RESIDUE item
   * 2): the old `created_at >= ?` bound compared stored instants as strings
   * against `fmtIso(now - FLAKE_WINDOW_MS)`, which is format-homogeneous but
   * not the numeric rule and silently dropped legacy naive-UTC rows. Each row's
   * `created_at` is parsed and aged via `instantAgeMs`/`isOlderThan` (mirrors
   * dashboard.ts `flakyKeysWithinWindow`). An unparseable `created_at` is NEVER
   * counted inside the window: `isOlderThan` alone treats an unknown instant as
   * fresh, so the parseability check is explicit. exit_code 87 (interruption)
   * remains neither a pass nor a fail.
   */
  lookup(key: HostSuiteLedgerKey): HostSuiteLookupOutcome {
    assertOpen(this.db);
    const { namespaceId, originRepo, treeHash, cmdHash } = key;
    const latest = toRow(
      this.db.prepare(
        `SELECT id, namespace_id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms,
                log_tail, run_id, step_id, created_at
         FROM host_suite_results
         WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      ).get(namespaceId, originRepo, treeHash, cmdHash) as RowRecord | undefined,
    );
    const nowMs = this.nowFn();
    const rows = this.db.prepare(
      `SELECT exit_code, created_at FROM host_suite_results
       WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?`,
    ).all(namespaceId, originRepo, treeHash, cmdHash) as Array<{
      exit_code: number;
      created_at: string;
    }>;
    let passCount = 0;
    let failCount = 0;
    for (const row of rows) {
      if (instantAgeMs(row.created_at, nowMs) === undefined) continue;
      if (isOlderThan(row.created_at, FLAKE_WINDOW_MS, nowMs, FLAKE_WINDOW_TOLERANCE_MS)) continue;
      if (Number(row.exit_code) === 0) passCount++;
      else if (Number(row.exit_code) !== 87) failCount++;
    }
    return { latest: latest as HostSuiteLookupRow | null, passCount, failCount, flaky: passCount > 0 && failCount > 0 };
  }

  // ── suite.claim ──────────────────────────────────────────────────────

  /**
   * Single-flight claim on the exact key. Atomic: an existing LIVE claim on
   * the key answers "wait"; expired claims (host clock) and claims whose owner
   * the caller's explicit predicate reports dead (host registry revocation —
   * never a PID) are swept first, then this caller may acquire "run".
   *
   * `isOwnerDead` is supplied by the host caller (service). It must return
   * true ONLY for invocations the host authority has explicitly revoked or
   * superseded within the caller's registry scope; unknown ids are NOT dead.
   */
  claim(
    input: HostSuiteClaimInput,
    isOwnerDead?: (invocationId: string) => boolean,
  ): HostSuiteClaimOutcome {
    const nowMs = this.nowFn();
    const { namespaceId, originRepo, treeHash, cmdHash } = input;
    return this.tx(() => {
      const existing = toRow(
        this.db.prepare(
          `SELECT namespace_id, origin_repo, tree_hash, cmd_hash, owner_token, run_id, step_id,
                  invocation_id, agent_id, job_id, claimed_at
           FROM host_suite_claims
           WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?`,
        ).get(namespaceId, originRepo, treeHash, cmdHash) as RowRecord | undefined,
      );
      if (existing !== null) {
        const ownerInvocation = String(existing.invocation_id);
        // Expiry is numeric from the authoritative ISO-Z claimed_at. An
        // UNREADABLE claimed_at defaults to EXPIRED (TIME-RESIDUE item 4): an
        // instant we cannot age is not evidence of a live claim, and treating it
        // as live would let a corrupt row block the key forever.
        const claimedAtMs = parseInstant(existing.claimed_at)?.getTime();
        const expired = claimedAtMs === undefined || nowMs - claimedAtMs > this.claimTimeoutMs;
        const dead = isOwnerDead !== undefined && isOwnerDead(ownerInvocation);
        if (!expired && !dead) {
          return { action: "wait" as const, claimedAt: String(existing.claimed_at) };
        }
        this.db.prepare(
          `DELETE FROM host_suite_claims
           WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?`,
        ).run(namespaceId, originRepo, treeHash, cmdHash);
      }
      const claimedAt = fmtIso(nowMs);
      this.db.prepare(
        `INSERT INTO host_suite_claims
           (namespace_id, origin_repo, tree_hash, cmd_hash, owner_token, run_id, step_id,
            invocation_id, agent_id, job_id, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        namespaceId,
        originRepo,
        treeHash,
        cmdHash,
        input.ownerToken,
        input.runId ?? null,
        input.stepId ?? null,
        input.invocationId,
        input.agentId,
        input.jobId,
        claimedAt,
      );
      return { action: "run" as const, claimedAt };
    });
  }

  /**
   * Claims currently held for one exact key (read-only, host/diagnostic use).
   */
  peekClaim(key: HostSuiteLedgerKey): HostSuiteClaimRow | null {
    assertOpen(this.db);
    const row = toRow(
      this.db.prepare(
        `SELECT namespace_id, origin_repo, tree_hash, cmd_hash, owner_token, run_id, step_id,
                invocation_id, agent_id, job_id, claimed_at
         FROM host_suite_claims
         WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?`,
      ).get(key.namespaceId, key.originRepo, key.treeHash, key.cmdHash) as RowRecord | undefined,
    );
    return row as HostSuiteClaimRow | null;
  }

  // ── suite.record ─────────────────────────────────────────────────────

  /**
   * Append one suite execution row scoped to namespace+origin+tree+cmd and
   * attributed to the host invocation. Idempotent per (key + invocation +
   * startedAt): a duplicate EXACT payload returns the original row id/created_at
   * (truthful acknowledgment, no duplicate row); a retry with a DIFFERENT
   * payload for the same execution key is refused (HostSuiteMismatchedRetryError).
   *
   * Record clears the single-flight claim ONLY when the recorder is the claim's
   * recorded owner (native: a successful record clears the owner's claim so
   * waiters proceed). A different invocation's record NEVER consumes the
   * owner's claim.
   */
  record(input: HostSuiteRecordInput): HostSuiteRecordOutcome {
    const nowMs = this.nowFn();
    const createdAt = fmtIso(nowMs);
    const digest = payloadDigest(input);
    return this.tx(() => {
      const idem = toRow(
        this.db.prepare(
          `SELECT id, created_at, payload_digest FROM host_suite_results
           WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?
             AND invocation_id = ? AND started_at = ?`,
        ).get(
          input.namespaceId,
          input.originRepo,
          input.treeHash,
          input.cmdHash,
          input.invocationId,
          input.startedAt,
        ) as RowRecord | undefined,
      );
      if (idem !== null) {
        if (String(idem.payload_digest) !== digest) {
          throw new HostSuiteMismatchedRetryError(
            "a different suite record for this invocation/execution was already accepted; refusing the mismatched retry",
          );
        }
        return {
          id: Number(idem.id),
          createdAt: String(idem.created_at),
          inserted: false,
        };
      }
      const result = this.db.prepare(
        `INSERT INTO host_suite_results
           (namespace_id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms,
            log_tail, run_id, step_id, invocation_id, agent_id, job_id, started_at, payload_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.namespaceId,
        input.originRepo,
        input.treeHash,
        input.cmdHash,
        input.cmdDisplay,
        input.exitCode,
        input.durationMs,
        input.logTail,
        input.runId,
        input.stepId,
        input.invocationId,
        input.agentId,
        input.jobId,
        input.startedAt,
        digest,
        createdAt,
      );
      const id = Number(result.lastInsertRowid);
      // Clear THIS invocation's own single-flight claim (exact owner only).
      this.db.prepare(
        `DELETE FROM host_suite_claims
         WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?
           AND invocation_id = ?`,
      ).run(input.namespaceId, input.originRepo, input.treeHash, input.cmdHash, input.invocationId);
      return { id, createdAt, inserted: true };
    });
  }

  // ── suite.release (exact-token, exact owner) ─────────────────────────

  release(input: HostSuiteReleaseInput): HostSuiteReleaseOutcome {
    const { namespaceId, originRepo, treeHash, cmdHash } = input;
    return this.tx(() => {
      const existing = toRow(
        this.db.prepare(
          `SELECT owner_token, invocation_id, claimed_at FROM host_suite_claims
           WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?`,
        ).get(namespaceId, originRepo, treeHash, cmdHash) as RowRecord | undefined,
      );
      if (existing === null) return { released: false };
      if (
        String(existing.owner_token) !== input.ownerToken
        || String(existing.invocation_id) !== input.invocationId
      ) {
        throw new HostSuiteClaimOwnerMismatchError(
          "suite claim is owned by another caller (token and/or host invocation mismatch)",
        );
      }
      this.db.prepare(
        `DELETE FROM host_suite_claims
         WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?`,
      ).run(namespaceId, originRepo, treeHash, cmdHash);
      return { released: true };
    });
  }

  /**
   * Controller-only exact-owner cleanup: release EVERY outstanding suite claim
   * recorded for one host invocation. NOT part of the guest transport surface
   * and never reachable from a guest request — the host controller calls this
   * when its own reconciliation/epoch determines an invocation is gone
   * (revocation, supersede, restart reconciliation with evidence). Never
   * inferred from a guest PID.
   */
  releaseClaimsByInvocation(invocationId: string): number {
    return this.tx(() => {
      const result = this.db.prepare(
        "DELETE FROM host_suite_claims WHERE invocation_id = ?",
      ).run(invocationId);
      return Number(result.changes);
    });
  }

  /** Number of live claims in the store (diagnostic/audit). */
  claimCount(): number {
    assertOpen(this.db);
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM host_suite_claims").get() as { cnt: number };
    return Number(row.cnt);
  }

  /** Number of recorded rows in the store (diagnostic/audit). */
  resultCount(): number {
    assertOpen(this.db);
    const row = this.db.prepare("SELECT COUNT(*) AS cnt FROM host_suite_results").get() as { cnt: number };
    return Number(row.cnt);
  }

  // ── suite.duration-history ───────────────────────────────────────────

  durationHistory(key: HostSuiteDurationKey): number[] {
    assertOpen(this.db);
    const rows = this.db.prepare(
      `SELECT duration_ms FROM host_suite_results
       WHERE namespace_id = ? AND origin_repo = ? AND cmd_hash = ?
         AND exit_code != 87
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).all(key.namespaceId, key.originRepo, key.cmdHash, HOST_SUITE_DURATION_HISTORY_MAX_ROWS) as Array<{
      duration_ms: number;
    }>;
    return rows.map((r) => Number(r.duration_ms));
  }

  // ── suite.event (permitted set only) ─────────────────────────────────

  /**
   * Persist one permitted suite event. Non-permitted events are refused by the
   * service boundary; the store re-checks the allowlist as a second line of
   * defense so a disallowed event can never become a persisted row.
   */
  emitEvent(input: HostSuiteEventInput): void {
    if (!isPermittedSuiteEvent(input.event)) {
      throw new HostSuiteStoreError(`suite event "${input.event}" is not a permitted suite event`, "BAD_STATE");
    }
    this.db.prepare(
      `INSERT INTO host_suite_events (namespace_id, event, run_id, step_id, fields_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.namespaceId,
      input.event,
      input.runId,
      input.stepId ?? null,
      input.fieldsJson,
      input.createdAt,
    );
  }

  // ── future Matchlock merge-gate seam (read-only) ─────────────────────

  /**
   * READ-ONLY merge-gate seam: latest evidence row for an exact key in THIS
   * explicit Matchlock store (native ledger-gate suite_results query shape).
   *
   * A future Matchlock merge gate MUST call this (or an equivalent query
   * against this explicit store) and MUST NOT count a guest row as native
   * evidence by reading native suite_results: guest rows only exist here,
   * namespaced by the admitted environment. The caller maps exit_code === 0
   * to green and anything else / no row to red/missing exactly like the native
   * gate. This component does not wire that gate (native ledger-gate.ts is
   * untouched); it only ships the query seam the later integration consumes.
   */
  queryMergeEvidence(key: HostSuiteLedgerKey): HostSuiteResultRow | null {
    assertOpen(this.db);
    // Full persisted row (HostSuiteResultRow): unlike the guest-facing lookup
    // subset, this host-side seam selects the identity attribution columns too
    // so the merge-gate consumer receives the complete evidence record.
    const row = toRow(
      this.db.prepare(
        `SELECT id, namespace_id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms,
                log_tail, run_id, step_id, invocation_id, agent_id, job_id, started_at, created_at
         FROM host_suite_results
         WHERE namespace_id = ? AND origin_repo = ? AND tree_hash = ? AND cmd_hash = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      ).get(key.namespaceId, key.originRepo, key.treeHash, key.cmdHash) as RowRecord | undefined,
    );
    return row as HostSuiteResultRow | null;
  }

  /**
   * READ-ONLY nearest-evidence diagnostic query for the merge-gate refusal
   * text: the most recent rows for a namespace+origin+command, IGNORING tree
   * (mirrors the native `NEAREST_EVIDENCE` diagnostic). Scoped to the SAME
   * explicit store + namespace; never reads native `suite_results`. Bounded to
   * HOST_SUITE_NEAREST_MAX_ROWS rows.
   */
  nearestMergeEvidence(key: HostSuiteDurationKey, limit: number = HOST_SUITE_NEAREST_MAX_ROWS): HostSuiteNearestRow[] {
    assertOpen(this.db);
    const bounded = Math.max(1, Math.min(Math.floor(limit), HOST_SUITE_NEAREST_MAX_ROWS));
    const rows = this.db.prepare(
      `SELECT tree_hash, exit_code, created_at
       FROM host_suite_results
       WHERE namespace_id = ? AND origin_repo = ? AND cmd_hash = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    ).all(key.namespaceId, key.originRepo, key.cmdHash, bounded) as RowRecord[];
    return rows.map((r) => ({
      tree_hash: String(r.tree_hash),
      exit_code: Number(r.exit_code),
      created_at: String(r.created_at),
    }));
  }

  /** Namespace row for a canonical namespace id, when registered (audit). */
  getNamespace(namespaceId: string): HostSuiteNamespaceRow | null {
    assertOpen(this.db);
    const row = toRow(
      this.db.prepare(
        `SELECT namespace_id AS namespaceId,
                image_content_id AS imageContentId,
                guest_platform AS guestPlatform,
                helper_contract AS helperContract,
                compatibility_fingerprint AS compatibilityFingerprint,
                created_at AS createdAt
         FROM host_suite_namespace WHERE namespace_id = ?`,
      ).get(namespaceId) as RowRecord | undefined,
    );
    return row as HostSuiteNamespaceRow | null;
  }
}

/** Convenience: transport contract version the store serves. */
export const HOST_SUITE_TRANSPORT_VERSION = GUEST_SUITE_TRANSPORT_VERSION;
