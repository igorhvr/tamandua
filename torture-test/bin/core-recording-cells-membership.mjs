// core-recording-cells-membership.mjs — CORE-CELLS US-006 (original CORE
// US-008): registered membership of the zero-token frequent-gate entrypoint.
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.4. This PURE data/validation module
// is the single reviewable source of truth for what the entrypoint
// (core-recording-cells.mjs) must run: the recorded regression cells of
// US-002..US-005 (original CORE US004-US007: TCMD x4, BRUN x2 corridors,
// RVOC/RCNT, PHNT) plus the required foundational regression files
// (contract, capture/sanitize, replay-adapter conformance, replay-executor
// and the CORE-MOTOR conformance gate). The entrypoint reports expected vs
// executed accounting from this registry; a producer that is missing, red or
// interrupted can never make the entrypoint exit green.
//
// Design invariants (pure module):
//   * No imports at all (not even node builtins): nothing here can perform a
//     side effect. The registry is deep-frozen so a producer can never be
//     silently added/removed at runtime.
//   * Every recorded producer declares the exact sub-cell identities
//     (recordedCellIds) it is the designated gate for; every sub-cell carries
//     its public provenance (historical case id and, where a single source
//     run exists, its provenance run id — public provenance, NEVER a fresh
//     run id). For corridor (b) of BRUN there is deliberately NO single
//     historical run: the current K6/N20 instant-fail behavior is what the
//     corridor proves (see the shipped asset module).
//   * validateOverrideManifest is a pure schema/refusal helper used by the
//     entrypoint's TEST-ONLY manifest seam (TT_CORE_CELLS_MANIFEST) so the
//     hermetic membership/exit-propagation test can drive synthetic
//     producers; invalid manifests are refused with structured errors, never
//     partially honored.
//
// Producer `kind` values: "node-test" (run with `node --test
// --test-reporter=tap <file>`) or "gate" (run with
// `node <file> --evidence-dir <fresh owned dir>` — the CORE-MOTOR gate).

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

export const CORE_CELLS_ENTRYPOINT_VERSION = 1;
export const CELL_MANIFEST_VERSION = 1;
export const CELL_KINDS = Object.freeze(["node-test", "gate"]);
export const CELL_SCOPES = Object.freeze(["foundational", "recorded"]);

// ── Registered membership ────────────────────────────────────────────
// `file` is repo-root relative (resolved against the checkout by the
// entrypoint). `cells` is only meaningful for `scope: "recorded"` producers:
// each entry is the recorded sub-cell identity that producer file is the
// designated gate for. Provenance run ids are copied verbatim from the
// shipped sanitized asset modules (public provenance only).
export const CORE_CELLS_MEMBERSHIP = deepFreeze({
  version: CELL_MANIFEST_VERSION,
  producers: [
    // ── Foundational regression files (US-001 / CORE-MOTOR) ────────────
    {
      id: "contract",
      kind: "node-test",
      scope: "foundational",
      story: "US-001",
      title: "CORE US-001 recording/adaptation contract regression",
      file: "torture-test/self-tests/tier0-core-recording-contract.test.ts",
      cells: [],
    },
    {
      id: "capture-sanitize",
      kind: "node-test",
      scope: "foundational",
      story: "US-001",
      title: "CORE capture/sanitize importer regression (public-field projection, redaction, fail-closed)",
      file: "torture-test/self-tests/tier0-core-recording-capture-sanitize.test.ts",
      cells: [],
    },
    {
      id: "replay-adapter-conformance",
      kind: "node-test",
      scope: "foundational",
      story: "US-001",
      title: "CORE replay-adapter (safety/adapter slice) conformance regression",
      file: "torture-test/self-tests/tier0-core-recording-replay-adapter-conformance.test.ts",
      cells: [],
    },
    {
      id: "replay-executor",
      kind: "node-test",
      scope: "foundational",
      story: "US-001",
      title: "CORE-MOTOR replay-executor execution-binding/evidence-verification regression",
      file: "torture-test/self-tests/tier0-core-recording-replay-executor.test.ts",
      cells: [],
    },
    {
      id: "motor-gate",
      kind: "gate",
      scope: "foundational",
      story: "US-001",
      title: "CORE-MOTOR designated conformance gate (staged preflight + actual isolated motor legs)",
      file: "torture-test/bin/core-recording-motor-gate.mjs",
      cells: [],
    },
    // ── Recorded cells US-002..US-005 ──────────────────────────────────
    {
      id: "tcmd-cells",
      kind: "node-test",
      scope: "recorded",
      story: "US-002",
      title: "four actual source-backed TCMD command-chain cells through the real isolated motor",
      file: "torture-test/self-tests/tier0-core-recording-tcmd-cells.test.ts",
      cells: [
        {
          id: "W4.48c-compound-gate-degradation",
          provenanceRunId: "ddaabf73-6d49-4a1a-bdfd-3c23e8fe71b5",
          note: "launch-vs-landing command drift: ./run-all-tests launch, npm test landing ledger",
        },
        {
          id: "W4.18-flaky-alternator",
          provenanceRunId: "d9c849ee-c767-48a8-92d1-04b428af6a84",
          note: "wrong-command crediting: declared .venv/bin/pytest -q, accepted pytest (TMRK observation kept distinct)",
        },
        {
          id: "W4.17-b-red-baseline-refuse",
          provenanceRunId: "dd063570-10a9-426a-8a21-6eb52d511df2",
          note: "environment variant: same-tree exit 127/0/127/0 rows with PATH env association",
        },
        {
          id: "W4.09-hermes-equivalence",
          provenanceRunId: "858f8699-af23-4068-9677-bccf664ccdc5",
          note: "Aug30 Hermes equivalence rerun: npm test -> npm run test benign rewrite control",
        },
      ],
    },
    {
      id: "brun-cell",
      kind: "node-test",
      scope: "recorded",
      story: "US-003",
      title: "BRUN launch-probe versus probe-passing mid-run instant-fail dsh path",
      file: "torture-test/self-tests/tier0-core-recording-brun-cell.test.ts",
      cells: [
        {
          id: "W4.dsh-do-now-missing-credential",
          provenanceRunId: "ba584b54-fbb3-40b4-a7cc-34f5d6843a2d",
          note: "corridor (a) first-dispatch REAL launch-probe failure; exact stdout byte UNKNOWN, newline explicitly declared synthetic",
        },
        {
          id: "current-probe-passing-midrun-instant-fail",
          provenanceRunId: null,
          note: "corridor (b) probe-passing mid-run instant-fail/relaunch/escalation under current K6/N20; no single historical run — the current bounded behavior is what the corridor proves",
        },
      ],
    },
    {
      id: "rvoc-rcnt-cells",
      kind: "node-test",
      scope: "recorded",
      story: "US-004",
      title: "RVOC same-step recovery/respawn ordering and RCNT class-specific reroute counters",
      file: "torture-test/self-tests/tier0-core-recording-rvoc-rcnt-cells.test.ts",
      cells: [
        {
          id: "W4.10-kill-daemon",
          provenanceRunId: "59e8e12c-2a7e-438d-aa48-6a3b99abb750",
          note: "RVOC same-step recovery: two same-row claims surround worker_lost; respawned AFTER the recovery event (worker_lost acknowledged as the historical connecting event)",
        },
        {
          id: "W4.10-restart-recovery",
          provenanceRunId: "f60941b9-6b36-403d-9730-2c7805c8eb7b",
          note: "RCNT class-specific reroute counters: ordinary-rebase reroute consumes the general count only; terminal controls explicitly labeled synthetic",
        },
      ],
    },
    {
      id: "phnt-cells",
      kind: "node-test",
      scope: "recorded",
      story: "US-005",
      title: "faithful PHNT honest records and labeled routing variants",
      file: "torture-test/self-tests/tier0-core-recording-phnt-cells.test.ts",
      cells: [
        {
          id: "W3.01-bfmw-pi-python",
          provenanceRunId: "eb501b9d-61e1-436b-8704-4283c1c406ff",
          note: "honest not-reproducible/tests-only account (archive git-object proof, zero src/ changes) — HONEST control",
        },
        {
          id: "W3.03-bfmw-hermes-ts",
          provenanceRunId: "a0f5ee4f-be3b-4bcb-bfa0-f7dfd6048c9f",
          note: "premise-repair account: prior refusal then disclosed ADD io.ts; NO DECEPTION verdict claimed historically",
        },
      ],
    },
  ],
});

// ── Pure helpers ─────────────────────────────────────────────────────

export function expectedProducerCount(membership = CORE_CELLS_MEMBERSHIP) {
  return membership.producers.length;
}

/** ids of every recorded sub-cell across all recorded producers (order-stable). */
export function recordedCellIds(membership = CORE_CELLS_MEMBERSHIP) {
  const ids = [];
  for (const producer of membership.producers) {
    if (producer.scope !== "recorded") continue;
    for (const cell of producer.cells) ids.push(cell.id);
  }
  return ids;
}

export function expectedRecordedCellCount(membership = CORE_CELLS_MEMBERSHIP) {
  return recordedCellIds(membership).length;
}

export function recordedProducerIds(membership = CORE_CELLS_MEMBERSHIP) {
  return membership.producers
    .filter((p) => p.scope === "recorded")
    .map((p) => p.id);
}

// ── Pure schema validation for override manifests (TEST-ONLY seam) ────

const PRODUCER_KEYS = Object.freeze(["id", "kind", "scope", "story", "title", "file", "cells"]);
const CELL_KEYS = Object.freeze(["id", "provenanceRunId", "note"]);

/**
 * validateOverrideManifest(value) -> { ok, errors }
 * Pure refusal helper for the TT_CORE_CELLS_MANIFEST test seam. Returns
 * structured errors (never throws) for malformed manifests so the entrypoint
 * can refuse loudly before executing anything.
 */
export function validateOverrideManifest(value) {
  const errors = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["override manifest must be a JSON object"] };
  }
  if (value.version !== CELL_MANIFEST_VERSION) {
    errors.push(`override manifest version must be ${CELL_MANIFEST_VERSION}`);
  }
  if (!Array.isArray(value.producers)) {
    return { ok: false, errors: [...errors, "override manifest requires a producers array"] };
  }
  const seen = new Set();
  value.producers.forEach((producer, i) => {
    if (producer === null || typeof producer !== "object" || Array.isArray(producer)) {
      errors.push(`producers[${i}] must be an object`);
      return;
    }
    for (const key of PRODUCER_KEYS) {
      if (producer[key] === undefined) errors.push(`producers[${i}] missing key "${key}"`);
    }
    if (typeof producer.id !== "string" || producer.id.length === 0) {
      errors.push(`producers[${i}] id must be a non-empty string`);
    } else if (seen.has(producer.id)) {
      errors.push(`producers[${i}] duplicate id "${producer.id}"`);
    } else {
      seen.add(producer.id);
    }
    if (!CELL_KINDS.includes(producer.kind)) {
      errors.push(`producers[${i}] kind must be one of ${CELL_KINDS.join("|")}`);
    }
    if (!CELL_SCOPES.includes(producer.scope)) {
      errors.push(`producers[${i}] scope must be one of ${CELL_SCOPES.join("|")}`);
    }
    if (typeof producer.file !== "string" || producer.file.length === 0) {
      errors.push(`producers[${i}] file must be a non-empty string`);
    }
    if (!Array.isArray(producer.cells)) {
      errors.push(`producers[${i}] cells must be an array`);
      return;
    }
    const cellIds = new Set();
    producer.cells.forEach((cell, j) => {
      if (cell === null || typeof cell !== "object" || Array.isArray(cell)) {
        errors.push(`producers[${i}].cells[${j}] must be an object`);
        return;
      }
      for (const key of CELL_KEYS) {
        if (cell[key] === undefined) errors.push(`producers[${i}].cells[${j}] missing key "${key}"`);
      }
      if (typeof cell.id !== "string" || cell.id.length === 0) {
        errors.push(`producers[${i}].cells[${j}] id must be a non-empty string`);
      } else if (cellIds.has(cell.id)) {
        errors.push(`producers[${i}].cells[${j}] duplicate cell id "${cell.id}"`);
      } else {
        cellIds.add(cell.id);
      }
      if (cell.provenanceRunId !== null && typeof cell.provenanceRunId !== "string") {
        errors.push(`producers[${i}].cells[${j}] provenanceRunId must be a string or null`);
      }
    });
  });
  return { ok: errors.length === 0, errors };
}
