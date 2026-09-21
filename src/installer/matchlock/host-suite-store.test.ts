/**
 * HostSuiteStore component tests (parallel lane — pure in-process SQLite,
 * NO child process spawning; real explicit file + :memory: stores).
 *
 * Covers the explicit host-owned Matchlock evidence store: namespace
 * registration as a separate key axis, native-shaped result rows, exact-key
 * idempotent records (same → original ack; changed → refused), single-flight
 * claims with expiry + explicit owner-death sweep, exact-token/exact-owner
 * release, controller-only per-invocation cleanup, namespace isolation,
 * interruption-87 exclusion from flaky counts and duration history, permitted
 * events, durability across reopen, and closed-store refusal.
 */
import { describe, it } from "node:test";
import { tamanduaTempDir } from "../../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  HOST_SUITE_STORE_VERSION,
  HostSuiteClaimOwnerMismatchError,
  HostSuiteMismatchedRetryError,
  HostSuiteStore,
  HostSuiteStoreError,
  openHostSuiteStore,
  type HostSuiteLedgerKey,
  type HostSuiteNamespaceRow,
} from "../../../dist/installer/matchlock/host-suite-store.js";
import { guestSuiteNamespaceId, type GuestSuiteNamespace } from "../../../dist/installer/matchlock/guest-suite-contract.js";

const NS_A: GuestSuiteNamespace = {
  imageContentId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  guestPlatform: "linux/amd64",
  helperContract: "guest-helper-host+suite-v1",
  compatibilityFingerprint: "envfp-aaa111",
};
const NS_B: GuestSuiteNamespace = {
  imageContentId: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  guestPlatform: "linux/arm64", // different platform ⇒ different namespace axis
  helperContract: "guest-helper-host+suite-v1",
  compatibilityFingerprint: "envfp-bbb222",
};
const NS_A_ID = guestSuiteNamespaceId(NS_A);
const NS_B_ID = guestSuiteNamespaceId(NS_B);

const ORIGIN = "/admitted/origin/repo";
const TREE = "1111111111111111111111111111111111111111";
const TREE2 = "2222222222222222222222222222222222222222";
const CMD = "npm test";
const CMD_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const INV_1 = "11111111-1111-4111-8111-111111111111";
const INV_2 = "22222222-2222-4222-8222-222222222222";

function tempFile(tag: string): string {
  const dir = tamanduaTempDir(`host-suite-${tag}-`);
  return path.join(dir, "matchlock-evidence.db");
}

/** Mutable clock for expiry/window tests. */
function clock(start = Date.parse("2026-09-09T01:00:00.000Z")) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function key(over: Partial<HostSuiteLedgerKey> = {}): HostSuiteLedgerKey {
  return {
    namespaceId: NS_A_ID,
    originRepo: ORIGIN,
    treeHash: TREE,
    cmdHash: CMD_HASH,
    ...over,
  };
}

function recordInput(over: Record<string, unknown> = {}) {
  return {
    ...key(),
    cmdDisplay: "npm test",
    exitCode: 0,
    durationMs: 5_000,
    logTail: null,
    runId: "run-1",
    stepId: "step-1",
    startedAt: "2026-09-09T01:00:00.000Z",
    invocationId: INV_1,
    agentId: "feature-dev-merge_developer",
    jobId: "job-1",
    force: false,
    ...over,
  };
}

function claimInput(over: Record<string, unknown> = {}) {
  return {
    ...key(),
    ownerToken: "token-owner-1",
    runId: "run-1",
    stepId: "step-1",
    invocationId: INV_1,
    agentId: "feature-dev-merge_developer",
    jobId: "job-1",
    ...over,
  };
}

describe("host-suite-store: open, tables, namespace registration", () => {
  it("creates its tables and meta schema version in an explicit file store", () => {
    const file = tempFile("open");
    const store = openHostSuiteStore(file);
    try {
      assert.ok(store.isOpen);
      assert.equal(store.schemaVersion, HOST_SUITE_STORE_VERSION);
      assert.equal(store.resultCount(), 0);
      assert.equal(store.claimCount(), 0);
    } finally {
      store.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("registerNamespace persists the host-chosen namespace row under the canonical id", () => {
    const file = tempFile("ns");
    const store = openHostSuiteStore(file);
    try {
      const row: HostSuiteNamespaceRow = store.registerNamespace(NS_A);
      assert.equal(row.namespaceId, NS_A_ID);
      assert.equal(store.getNamespace(NS_A_ID)?.imageContentId, NS_A.imageContentId);
      assert.equal(store.getNamespace(NS_B_ID), null, "other namespace not registered");
    } finally {
      store.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("closed stores refuse operations with a bounded CLOSED error", () => {
    const store = openHostSuiteStore(":memory:");
    store.close();
    assert.throws(() => store.lookup(key()), (err: unknown) => {
      assert.ok(err instanceof HostSuiteStoreError);
      assert.equal((err as HostSuiteStoreError).code, "CLOSED");
      return true;
    });
  });
});

describe("host-suite-store: record + lookup (native shapes, namespace axis)", () => {
  it("records one native-shaped row and lookup echoes latest + window counts", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    const rec = store.record(recordInput());
    assert.equal(rec.inserted, true);
    assert.ok(rec.id >= 1);

    const lookup = store.lookup(key());
    assert.equal(lookup.latest?.exit_code, 0);
    assert.equal(lookup.latest?.origin_repo, ORIGIN);
    assert.equal(lookup.latest?.cmd_hash, CMD_HASH);
    assert.equal(lookup.latest?.run_id, "run-1");
    assert.equal(lookup.passCount, 1);
    assert.equal(lookup.failCount, 0);
    assert.equal(lookup.flaky, false);
    assert.equal(store.resultCount(), 1);
    // The guest-facing lookup row is the SELECT subset: identity attribution is
    // persisted for audit but never shipped on this surface (type-honest row).
    assert.equal("invocation_id" in (lookup.latest as Record<string, unknown>), false);
    assert.equal("agent_id" in (lookup.latest as Record<string, unknown>), false);
    assert.equal("started_at" in (lookup.latest as Record<string, unknown>), false);
  });

  it("namespaces are a separate key axis: rows never cross namespace lookups", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    store.registerNamespace(NS_B);
    store.record(recordInput({ namespaceId: NS_A_ID }));
    const bLookup = store.lookup(key({ namespaceId: NS_B_ID }));
    assert.equal(bLookup.latest, null);
    assert.equal(bLookup.passCount, 0);
    assert.equal(store.resultCount(), 1, "one row total, scoped to NS_A");
    // A record under NS_B is a distinct evidence axis.
    store.record(recordInput({ namespaceId: NS_B_ID, invocationId: INV_2 }));
    assert.equal(store.resultCount(), 2);
    assert.equal(store.lookup(key()).passCount, 1);
    assert.equal(store.lookup(key({ namespaceId: NS_B_ID })).passCount, 1);
  });

  it("duplicate EXACT record returns the original id/created_at without a duplicate row", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    const first = store.record(recordInput());
    const second = store.record(recordInput());
    assert.equal(second.inserted, false);
    assert.equal(second.id, first.id);
    assert.equal(second.createdAt, first.createdAt);
    assert.equal(store.resultCount(), 1);
  });

  it("a changed payload for the same invocation/started_at is a refused mismatched retry", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    store.record(recordInput());
    assert.throws(
      () => store.record(recordInput({ exitCode: 7 })),
      (err: unknown) => err instanceof HostSuiteMismatchedRetryError,
    );
    assert.equal(store.resultCount(), 1, "the mismatched retry must not create a row");
  });

  it("the same started_at from a DIFFERENT invocation is its own execution (separate attribution)", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    store.record(recordInput({ invocationId: INV_1 }));
    const other = store.record(recordInput({ invocationId: INV_2 }));
    assert.equal(other.inserted, true);
    assert.equal(store.resultCount(), 2);
  });

  it("lookup counts exclude interruption-87 and honor the 24h flake window", () => {
    const c = clock();
    const store = openHostSuiteStore(":memory:", { now: c.now });
    store.registerNamespace(NS_A);
    // 87 interruption (excluded), one red, one green in the window. Row
    // created_at is the HOST commit clock (native semantics), which here is
    // the fixed clock start; startedAt records the guest execution start.
    store.record(recordInput({ exitCode: 87, durationMs: 100, startedAt: "2026-09-09T01:00:00.000Z", logTail: "interrupted" }));
    store.record(recordInput({ exitCode: 5, durationMs: 200, startedAt: "2026-09-09T01:00:01.000Z" }));
    store.record(recordInput({ exitCode: 0, durationMs: 300, startedAt: "2026-09-09T01:00:02.000Z" }));
    const lookup = store.lookup(key());
    assert.equal(lookup.passCount, 1);
    assert.equal(lookup.failCount, 1, "interruption-87 is never counted as a failure");
    assert.equal(lookup.flaky, true);
    assert.equal(lookup.latest?.exit_code, 0);
    // Age the entire window out: counts drop to zero but the latest row persists.
    c.advance(25 * 60 * 60 * 1000);
    const aged = store.lookup(key());
    assert.equal(aged.passCount, 0);
    assert.equal(aged.failCount, 0);
    assert.equal(aged.flaky, false);
    assert.equal(aged.latest?.exit_code, 0, "recorded evidence remains available after the advisory window");
    assert.equal(aged.latest?.created_at, "2026-09-09T01:00:00.000Z", "created_at is the host commit instant, not guest started_at");
    assert.equal(aged.latest?.namespace_id, NS_A_ID);
  });
});

describe("host-suite-store: single-flight claims", () => {
  it("first claim grants run; a second live claim on the exact key waits", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    const first = store.claim(claimInput({ ownerToken: "t-a" }));
    assert.equal(first.action, "run");
    const second = store.claim(claimInput({ ownerToken: "t-b", invocationId: INV_2 }));
    assert.equal(second.action, "wait");
    assert.equal(store.claimCount(), 1);
  });

  it("expired claims are swept by host clock and the next caller acquires run", () => {
    const c = clock();
    const store = openHostSuiteStore(":memory:", { now: c.now, claimTimeoutMs: 1_000 });
    store.registerNamespace(NS_A);
    assert.equal(store.claim(claimInput({ ownerToken: "t-a" })).action, "run");
    c.advance(1_001);
    const next = store.claim(claimInput({ ownerToken: "t-b", invocationId: INV_2 }));
    assert.equal(next.action, "run", "host-clock expiry frees the stale claim");
    assert.equal(store.claimCount(), 1);
  });

  it("an explicitly-dead owner claim is swept (registry predicate, never a PID)", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    assert.equal(store.claim(claimInput({ ownerToken: "t-a", invocationId: INV_1 })).action, "run");
    // INV_1 is reported dead by the explicit host predicate → INV_2 acquires.
    const next = store.claim(claimInput({ ownerToken: "t-b", invocationId: INV_2 }), (inv) => inv === INV_1);
    assert.equal(next.action, "run");
    // An UNKNOWN owner (other registry scope) is never treated as dead.
    store.claim(claimInput({ ownerToken: "t-c", invocationId: INV_2, ...key({ treeHash: TREE2 }) }), (inv) => inv === INV_1);
    const wait = store.claim(claimInput({ ownerToken: "t-d", invocationId: INV_1, ...key({ treeHash: TREE2 }) }));
    assert.equal(wait.action, "wait");
  });
});

describe("host-suite-store: exact-token/exact-owner release", () => {
  it("releases only with the exact token AND the exact owner invocation", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    store.claim(claimInput({ ownerToken: "t-a", invocationId: INV_1 }));
    assert.throws(
      () => store.release({ ...key(), ownerToken: "wrong-token", invocationId: INV_1 }),
      (err: unknown) => err instanceof HostSuiteClaimOwnerMismatchError,
    );
    assert.throws(
      () => store.release({ ...key(), ownerToken: "t-a", invocationId: INV_2 }),
      (err: unknown) => err instanceof HostSuiteClaimOwnerMismatchError,
      "a different invocation cannot release with a borrowed token",
    );
    assert.equal(store.claimCount(), 1, "failed releases never consume the owner's claim");
    const released = store.release({ ...key(), ownerToken: "t-a", invocationId: INV_1 });
    assert.equal(released.released, true);
    assert.equal(store.claimCount(), 0);
    assert.equal(store.release({ ...key(), ownerToken: "t-a", invocationId: INV_1 }).released, false);
  });

  it("controller-only exact-owner cleanup releases only that invocation's claims", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    store.claim(claimInput({ ownerToken: "t-a", invocationId: INV_1 }));
    store.claim(claimInput({ ownerToken: "t-a", invocationId: INV_1, ...key({ treeHash: TREE2 }) }));
    store.claim(claimInput({ ownerToken: "t-b", invocationId: INV_2, ...key({ cmdHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }) }));
    assert.equal(store.releaseClaimsByInvocation(INV_1), 2);
    assert.equal(store.claimCount(), 1, "INV_2's claim is untouched by INV_1's cleanup");
  });

  it("record clears only the recorder's OWN claim (never a foreign owner's)", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    store.claim(claimInput({ ownerToken: "t-a", invocationId: INV_1 }));
    // INV_2 records an execution for the same key while INV_1 owns the claim.
    store.record(recordInput({ invocationId: INV_2, startedAt: "2026-09-09T02:00:00.000Z" }));
    assert.equal(store.claimCount(), 1, "a different invocation's record cannot consume the owner's claim");
    // The owner's own record clears its claim (native record-clears-claim semantics).
    store.record(recordInput({ invocationId: INV_1, startedAt: "2026-09-09T02:01:00.000Z" }));
    assert.equal(store.claimCount(), 0);
  });
});

describe("host-suite-store: duration history, events, merge seam, durability", () => {
  it("duration history is namespace-scoped and excludes interruption-87", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    store.registerNamespace(NS_B);
    store.record(recordInput({ exitCode: 87, durationMs: 999, startedAt: "2026-09-09T01:00:00.000Z" }));
    store.record(recordInput({ durationMs: 5_000, startedAt: "2026-09-09T01:00:01.000Z" }));
    store.record(recordInput({ durationMs: 6_000, startedAt: "2026-09-09T01:00:02.000Z", ...key({ treeHash: TREE2 }) }));
    store.record(recordInput({ durationMs: 7_000, startedAt: "2026-09-09T01:00:03.000Z", namespaceId: NS_B_ID, invocationId: INV_2 }));
    const durations = store.durationHistory({ namespaceId: NS_A_ID, originRepo: ORIGIN, cmdHash: CMD_HASH });
    assert.deepEqual(durations.sort((a, b) => a - b), [5_000, 6_000], "87 excluded; cross-namespace rows excluded");
  });

  it("events are persisted only for the permitted suite-event set", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    store.emitEvent({
      namespaceId: NS_A_ID,
      event: "suite.execute_started",
      runId: "run-1",
      fieldsJson: JSON.stringify({ tree_hash: "abc" }),
      createdAt: "2026-09-09T01:00:00.000Z",
    });
    assert.throws(
      () => store.emitEvent({ namespaceId: NS_A_ID, event: "suite.owner_release", runId: "run-1", fieldsJson: null, createdAt: "2026-09-09T01:00:00.000Z" }),
      (err: unknown) => err instanceof HostSuiteStoreError,
    );
  });

  it("queryMergeEvidence returns the exact-key latest FULL evidence row (native merge-gate seam)", () => {
    const store = openHostSuiteStore(":memory:");
    store.registerNamespace(NS_A);
    store.record(recordInput({ exitCode: 1, startedAt: "2026-09-09T01:00:00.000Z" }));
    store.record(recordInput({ exitCode: 0, startedAt: "2026-09-09T01:01:00.000Z" }));
    const row = store.queryMergeEvidence(key());
    assert.equal(row?.exit_code, 0);
    // The host-side merge seam returns the COMPLETE persisted row — identity
    // attribution included — unlike the guest-facing lookup subset.
    assert.equal(row?.invocation_id, INV_1);
    assert.equal(row?.agent_id, "feature-dev-merge_developer");
    assert.equal(row?.job_id, "job-1");
    assert.equal(row?.started_at, "2026-09-09T01:01:00.000Z");
    assert.equal(store.queryMergeEvidence(key({ cmdHash: "c".repeat(64) })), null);
  });

  it("durability: closing and reopening the SAME file preserves namespace-bound records and ack identity", () => {
    const file = tempFile("durable");
    const keyOf = key();
    const startedAt = "2026-09-09T03:00:00.000Z";
    let ackId: number;
    {
      const store = openHostSuiteStore(file);
      store.registerNamespace(NS_A);
      const rec = store.record(recordInput({ startedAt }));
      ackId = rec.id;
      store.claim(claimInput({ ownerToken: "t-a", invocationId: INV_1 }));
      store.close();
    }
    {
      const reopened = openHostSuiteStore(file);
      assert.equal(reopened.resultCount(), 1);
      assert.equal(reopened.claimCount(), 1, "claims are persisted rows, reopened like evidence");
      const lookup = reopened.lookup(keyOf);
      assert.equal(lookup.latest?.id, ackId);
      assert.equal(lookup.latest?.namespace_id, NS_A_ID);
      const dup = reopened.record(recordInput({ startedAt }));
      assert.equal(dup.id, ackId, "reopen still returns the original acknowledgment");
      assert.equal(dup.inserted, false);
      // Host authority state (invocation admission) is NOT restored from guest
      // fields — the caller re-admits via its registry; only evidence survives.
      assert.equal(reopened.getNamespace(NS_B_ID), null);
      reopened.close();
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it("two SEPARATE store files are fully independent", () => {
    const fileA = tempFile("isoA");
    const fileB = tempFile("isoB");
    const storeA = openHostSuiteStore(fileA);
    const storeB = openHostSuiteStore(fileB);
    storeA.registerNamespace(NS_A);
    storeB.registerNamespace(NS_B);
    storeA.record(recordInput());
    storeB.record(recordInput({ namespaceId: NS_B_ID, invocationId: INV_2, exitCode: 9 }));
    assert.equal(storeA.resultCount(), 1);
    assert.equal(storeB.resultCount(), 1);
    assert.equal(storeA.lookup(key()).latest?.exit_code, 0);
    assert.equal(storeB.lookup(key({ namespaceId: NS_B_ID })).latest?.exit_code, 9);
    assert.equal(storeB.lookup(key()).latest, null, "cross-file rows never contaminate");
    storeA.close();
    storeB.close();
    fs.rmSync(path.dirname(fileA), { recursive: true, force: true });
    fs.rmSync(path.dirname(fileB), { recursive: true, force: true });
  });
});
