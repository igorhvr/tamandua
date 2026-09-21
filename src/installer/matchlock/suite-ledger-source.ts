/**
 * US-006: host-attested finalizer ledger evidence source over the explicit
 * host-owned Matchlock suite store.
 *
 * This is the ONLY production implementation of the optional
 * `FinalizeMergeEvidenceSource` seam that `evaluateFinalizeMergeLedgerGate`
 * consumes. It is constructed from the SAME host-owned `HostSuiteStore` and
 * the SAME canonical host-admitted `GuestSuiteNamespace` that the suite bridge
 * serves for one invocation, and it is threaded by the controller-attested
 * runner (`pi-invocation-runner` -> `NativeStepServices`) into the finalize
 * claim/acceptance gates.
 *
 * Isolation guarantees:
 *   - the canonical namespace id is bound at construction; a query can never
 *     widen it, and rows recorded under any other namespace are invisible;
 *   - lookups never touch native `suite_results` (there is no native import
 *     here at all), so native evidence can never be mistaken for Matchlock
 *     evidence and vice versa;
 *   - the source is a pure read-only query object: it holds no mutation or
 *     authority of its own (the store's writes stay on the suite bridge path).
 *
 * Node-core only + the host suite store; this module is host-only and is NOT
 * part of the portable RO guest pack closure (only `pi-invocation-runner`
 * imports it).
 */

import {
  GUEST_SUITE_NAMESPACE_FIELDS,
  guestSuiteNamespaceId,
  normalizeGuestSuiteNamespace,
  type GuestSuiteNamespace,
} from "./guest-suite-contract.js";
import type { HostSuiteStore } from "./host-suite-store.js";
import type {
  FinalizeMergeEvidenceRow,
  FinalizeMergeEvidenceSource,
  FinalizeMergeNearestEvidenceRow,
} from "../ledger-gate.js";

export interface HostSuiteLedgerEvidenceSourceOptions {
  /** Open explicit host-owned Matchlock evidence store (never native state). */
  store: HostSuiteStore;
  /** Canonical host-admitted namespace the source is bound to. */
  namespace: GuestSuiteNamespace;
}

/**
 * Build the opt-in finalizer evidence source for one invocation. Throws on
 * invalid host scope (a host configuration error: fail closed, never serve a
 * half-bound source).
 */
export function createHostSuiteLedgerEvidenceSource(
  opts: HostSuiteLedgerEvidenceSourceOptions,
): FinalizeMergeEvidenceSource {
  if (!opts.store || !opts.store.isOpen) {
    throw new Error("host suite ledger evidence source requires an open HostSuiteStore");
  }
  // The namespace must be the canonical host-admitted value: reject an invalid
  // one, and reject one that only normalizes after trimming (which would
  // silently become a DIFFERENT ledger key) — mirrors the suite bridge.
  const normalized = normalizeGuestSuiteNamespace({ ...opts.namespace });
  if (!normalized.ok) {
    throw new Error(`host suite ledger evidence source: invalid namespace: ${normalized.error}`);
  }
  for (const field of GUEST_SUITE_NAMESPACE_FIELDS) {
    if (normalized.value[field] !== opts.namespace[field]) {
      throw new Error(
        `host suite ledger evidence source: namespace field "${field}" must be supplied already canonical (no trim-able padding)`,
      );
    }
  }
  const namespaceId = guestSuiteNamespaceId(normalized.value);
  if (typeof namespaceId !== "string" || namespaceId.length === 0) {
    throw new Error("host suite ledger evidence source requires a canonical namespace");
  }
  return {
    namespaceId,
    queryMergeEvidence(key): FinalizeMergeEvidenceRow | null {
      const row = opts.store.queryMergeEvidence({
        namespaceId,
        originRepo: key.originRepo,
        treeHash: key.treeHash,
        cmdHash: key.cmdHash,
      });
      if (!row) return null;
      return {
        id: row.id,
        exitCode: row.exit_code,
        durationMs: row.duration_ms,
        logTail: row.log_tail,
        runId: row.run_id,
        stepId: row.step_id,
        createdAt: row.created_at,
      };
    },
    nearestEvidence(originRepo, cmdHash): FinalizeMergeNearestEvidenceRow[] {
      return opts.store.nearestMergeEvidence({ namespaceId, originRepo, cmdHash }).map((r) => ({
        treeHash: r.tree_hash,
        exitCode: r.exit_code,
        createdAt: r.created_at,
      }));
    },
  };
}
