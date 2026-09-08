// core-recording-contract.mjs — CORE US-001 minimal versioned recording /
// adaptation contract (pure format + validation, no product coupling).
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.1, bounded slice CORE-1. This module
// is the single reviewable container format for source-backed recorded
// regression cells that later CORE stories (US-002+) populate: it separates
// immutable source identity from captured public observations, the exact
// sanitization/derivation steps applied, typed fixture operations, expected
// mechanical outcomes, and an explicit list of facts that are UNKNOWN with
// the reason they could not be established.
//
// Design invariants (pure module):
//   * No dynamic evaluator, no subprocess spawning, no network, no
//     filesystem writes. Imports are node builtins only (node:crypto for the
//     sha256 digest). No new dependency.
//   * Everything is JSON-serializable; the payload hash is deterministic
//     (canonical JSON: object keys sorted, arrays in order) so any two
//     structurally equal records hash identically regardless of key order.
//   * buildRecordingRecord computes payloadSha256 over the canonical payload
//     and returns a DEEP-FROZEN record. validateRecordingRecord recomputes
//     that hash from the record itself (record minus payloadSha256) so a
//     corrupt or edited record is detected by the mismatch.
//   * Referential integrity: every observation / operation / expectedOutcome
//     declares a sourceRef that MUST resolve to a locator declared in
//     sourceIdentity.sourceRefs (missing-source error otherwise).
//   * A record claims ONE run (sourceIdentity.runId). Any section or locator
//     declaring a different runId is a mixed-run claim and is rejected.
//   * Claims that reference evidence (operation.evidenceRefs,
//     expectedOutcome.evidenceRefs / expectedOutcome.operationRef) fail as
//     incomplete when the referenced observation / operation is absent.
//   * Records that declare unknown facts are ACCEPTED and the unknowns are
//     surfaced on the ok result (never silently dropped, never upgraded into
//     fake certainties).

import { createHash } from "node:crypto";

export const RECORD_FORMAT_VERSION = 1;

// Reasons a fact may be recorded as unknown instead of a captured value.
const UNKNOWN_REASONS = Object.freeze([
  "unreadable",
  "truncated",
  "malformed",
  "ambiguous",
  "missing",
]);

const SOURCE_KINDS = Object.freeze(["pi", "dsh", "hermes"]);

// Typed-operation vocabulary guard: operation `type` values are typed op
// codes (lowercase start, then [a-z0-9_.-]), never generalized shell text.
const TYPED_OP_RE = /^[a-z][a-z0-9_.-]*$/;

// ---------------------------------------------------------------------------
// sha256 helper
// ---------------------------------------------------------------------------

/** sha256 hex digest of `text` (UTF-8). Throws TypeError for non-string. */
export function hashText(text) {
  if (typeof text !== "string") {
    throw new TypeError(`hashText expects a string, got ${typeof text}`);
  }
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Canonical JSON (deterministic payload serialization)
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalStringify(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("record contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      if (item === undefined) throw new TypeError("record array contains undefined");
      parts.push(canonicalStringify(item));
    }
    return `[${parts.join(",")}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    const parts = [];
    for (const key of keys) {
      parts.push(`${JSON.stringify(key)}:${canonicalStringify(value[key])}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`record contains a non-JSON value (${t})`);
}

/** Canonical payload of a record: every field except payloadSha256. */
function payloadText(record) {
  const payload = {};
  for (const key of Object.keys(record)) {
    if (key === "payloadSha256") continue;
    payload[key] = record[key];
  }
  return canonicalStringify(payload);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// buildRecordingRecord
// ---------------------------------------------------------------------------

/**
 * Build a versioned recording record from its six content sections.
 * Returns a DEEP-FROZEN record carrying recordFormatVersion and a
 * deterministic payloadSha256 over the canonical payload (all fields except
 * payloadSha256 itself).
 *
 * Throws TypeError on a structurally invalid call (sourceIdentity must be an
 * object; the five content sections must be arrays). Semantic integrity is
 * enforced separately by validateRecordingRecord.
 */
export function buildRecordingRecord({
  sourceIdentity,
  observations,
  transformations,
  operations,
  expectedOutcomes,
  unknown,
}) {
  if (!isPlainObject(sourceIdentity)) {
    throw new TypeError("buildRecordingRecord requires sourceIdentity object");
  }
  for (const [name, section] of Object.entries({
    observations,
    transformations,
    operations,
    expectedOutcomes,
    unknown,
  })) {
    if (!Array.isArray(section)) {
      throw new TypeError(`buildRecordingRecord requires ${name} to be an array`);
    }
  }
  const record = {
    recordFormatVersion: RECORD_FORMAT_VERSION,
    sourceIdentity,
    observations,
    transformations,
    operations,
    expectedOutcomes,
    unknown,
  };
  record.payloadSha256 = hashText(payloadText(record));
  return deepFreeze(record);
}

// ---------------------------------------------------------------------------
// validateRecordingRecord
// ---------------------------------------------------------------------------

/**
 * Validate a versioned recording record (built or hand-authored JSON).
 * Returns { ok: true, unknowns: [...] } when the record satisfies the
 * contract — unknowns surfaced (empty array when none declared) — or
 * { ok: false, errors: [...] } with { code, path, message } entries.
 */
export function validateRecordingRecord(record) {
  const errors = [];
  if (!isPlainObject(record)) {
    return {
      ok: false,
      errors: [{ code: "shape", path: "$", message: "record must be a JSON object" }],
    };
  }

  // -- version -----------------------------------------------------------
  const version = record.recordFormatVersion;
  if (typeof version !== "number" || !Number.isInteger(version)) {
    return {
      ok: false,
      errors: [{
        code: "version",
        path: "$.recordFormatVersion",
        message: `recordFormatVersion must be an integer, got ${JSON.stringify(version)}`,
      }],
    };
  }
  if (version !== RECORD_FORMAT_VERSION) {
    return {
      ok: false,
      errors: [{
        code: "version",
        path: "$.recordFormatVersion",
        message: `unsupported record format version ${version}; this validator supports ${RECORD_FORMAT_VERSION}`,
      }],
    };
  }

  // -- payload hash ------------------------------------------------------
  const declared = record.payloadSha256;
  if (typeof declared !== "string") {
    errors.push({
      code: "shape",
      path: "$.payloadSha256",
      message: "payloadSha256 must be a string",
    });
  } else {
    let computed;
    try {
      computed = hashText(payloadText(record));
    } catch (e) {
      return {
        ok: false,
        errors: [{ code: "shape", path: "$", message: `payload not serializable: ${e.message}` }],
      };
    }
    if (computed !== declared) {
      errors.push({
        code: "corrupt-hash",
        path: "$.payloadSha256",
        message: `payloadSha256 mismatch: computed ${computed} != declared ${declared}`,
      });
    }
  }

  // -- sourceIdentity ----------------------------------------------------
  const siPath = "$.sourceIdentity";
  const sourceIdentity = record.sourceIdentity;
  if (!isPlainObject(sourceIdentity)) {
    errors.push({ code: "shape", path: siPath, message: "sourceIdentity must be an object" });
    return { ok: false, errors };
  }
  const { kind, runId, caseId, sourceRefs, sourceSha256 } = sourceIdentity;

  if (!SOURCE_KINDS.includes(kind)) {
    errors.push({
      code: "shape",
      path: `${siPath}.kind`,
      message: `sourceIdentity.kind must be one of ${SOURCE_KINDS.join("|")}, got ${JSON.stringify(kind)}`,
    });
  }
  if (typeof runId !== "string" || runId.length === 0) {
    errors.push({ code: "shape", path: `${siPath}.runId`, message: "sourceIdentity.runId must be a non-empty string" });
  }
  if (caseId !== undefined && (typeof caseId !== "string" || caseId.length === 0)) {
    errors.push({ code: "shape", path: `${siPath}.caseId`, message: "sourceIdentity.caseId must be a non-empty string when present" });
  }
  if (typeof sourceSha256 !== "string" || sourceSha256.length === 0) {
    errors.push({ code: "shape", path: `${siPath}.sourceSha256`, message: "sourceIdentity.sourceSha256 must be a non-empty string" });
  }
  if (!Array.isArray(sourceRefs) || sourceRefs.length === 0) {
    errors.push({ code: "shape", path: `${siPath}.sourceRefs`, message: "sourceIdentity.sourceRefs must be a non-empty array of source locators" });
  }

  const canonicalRunId = runId; // string or undefined (undefined reported above)

  // Declared locator ids for referential integrity.
  const declaredLocatorIds = new Set();
  const declaredRunIds = new Set();
  if (Array.isArray(sourceRefs)) {
    sourceRefs.forEach((ref, i) => {
      const refPath = `${siPath}.sourceRefs[${i}]`;
      if (!isPlainObject(ref)) {
        errors.push({ code: "shape", path: refPath, message: "each sourceRef must be an object" });
        return;
      }
      const locatorId = ref.locatorId;
      if (typeof locatorId !== "string" || locatorId.length === 0) {
        errors.push({ code: "shape", path: `${refPath}.locatorId`, message: "each sourceRef needs a non-empty locatorId" });
      } else if (declaredLocatorIds.has(locatorId)) {
        errors.push({ code: "shape", path: `${refPath}.locatorId`, message: `duplicate sourceRef locatorId ${locatorId}` });
      } else {
        declaredLocatorIds.add(locatorId);
      }
      if (ref.locator === undefined || ref.locator === null || ref.locator === "") {
        errors.push({ code: "shape", path: `${refPath}.locator`, message: `sourceRef ${locatorId} needs an explicit locator` });
      }
      if (ref.runId !== undefined) {
        if (typeof ref.runId !== "string" || ref.runId.length === 0) {
          errors.push({ code: "shape", path: `${refPath}.runId`, message: "sourceRef.runId must be a non-empty string when present" });
        } else {
          declaredRunIds.add(ref.runId);
        }
      }
    });
  }

  // -- section containers -------------------------------------------------
  const sections = ["observations", "transformations", "operations", "expectedOutcomes", "unknown"];
  for (const name of sections) {
    if (!Array.isArray(record[name])) {
      errors.push({ code: "shape", path: `$.${name}`, message: `${name} must be an array` });
    }
  }
  const hasSectionErrors = sections.some((name) => !Array.isArray(record[name]));
  if (hasSectionErrors) {
    return { ok: false, errors };
  }

  // -- section-scoped ids -------------------------------------------------
  const observationIds = new Set();
  const operationIds = new Set();
  const outcomeIds = new Set();

  function collectIds(items, idPath, idSet, kindName) {
    items.forEach((entry, i) => {
      if (!isPlainObject(entry)) return;
      const id = entry.id;
      if (typeof id !== "string" || id.length === 0) {
        errors.push({ code: "shape", path: `${idPath}[${i}].id`, message: `${kindName} entries need a non-empty id` });
        return;
      }
      if (idSet.has(id)) {
        errors.push({ code: "shape", path: `${idPath}[${i}].id`, message: `duplicate ${kindName} id ${id}` });
      }
      idSet.add(id);
    });
  }

  collectIds(record.observations, "$.observations", observationIds, "observation");
  collectIds(record.operations, "$.operations", operationIds, "operation");
  collectIds(record.expectedOutcomes, "$.expectedOutcomes", outcomeIds, "expectedOutcome");

  // -- sourceRef resolution (observations / operations / expectedOutcomes) --
  function checkSourceRef(entry, path, label) {
    const ref = entry.sourceRef;
    if (typeof ref !== "string" || ref.length === 0) {
      errors.push({ code: "missing-source", path: `${path}.sourceRef`, message: `${label} must declare a sourceRef locator id` });
      return;
    }
    if (!declaredLocatorIds.has(ref)) {
      errors.push({
        code: "missing-source",
        path: `${path}.sourceRef`,
        message: `${label} sourceRef ${ref} does not resolve to any declared sourceRef locator`,
      });
    }
  }

  // -- run identity (mixed-run detection) ---------------------------------
  function checkRunId(value, path, label) {
    if (value === undefined) return;
    if (typeof value !== "string" || value.length === 0) {
      errors.push({ code: "shape", path: `${path}.runId`, message: `${label} runId must be a non-empty string when present` });
      return;
    }
    if (canonicalRunId !== undefined && value !== canonicalRunId) {
      errors.push({
        code: "mixed-run",
        path: `${path}.runId`,
        message: `${label} declares runId ${value} but the record runId is ${canonicalRunId}`,
      });
    }
  }

  // -- observations -------------------------------------------------------
  record.observations.forEach((obs, i) => {
    const obsPath = `$.observations[${i}]`;
    if (!isPlainObject(obs)) {
      errors.push({ code: "shape", path: obsPath, message: "observation entries must be objects" });
      return;
    }
    if (obs.fact === undefined || obs.fact === null) {
      errors.push({ code: "shape", path: `${obsPath}.fact`, message: "observation needs a captured public fact" });
    }
    checkSourceRef(obs, obsPath, `observation ${JSON.stringify(obs.id)}`);
    checkRunId(obs.runId, obsPath, `observation ${JSON.stringify(obs.id)}`);
  });

  // -- transformations -----------------------------------------------------
  record.transformations.forEach((tf, i) => {
    const tfPath = `$.transformations[${i}]`;
    if (!isPlainObject(tf)) {
      errors.push({ code: "shape", path: tfPath, message: "transformation entries must be objects" });
      return;
    }
    if (typeof tf.step !== "string" || tf.step.length === 0) {
      errors.push({ code: "shape", path: `${tfPath}.step`, message: "transformation needs a non-empty step describing the sanitization/derivation applied" });
    }
    if (tf.sourceRef !== undefined) checkSourceRef(tf, tfPath, "transformation");
    checkRunId(tf.runId, tfPath, "transformation");
  });

  // -- operations ----------------------------------------------------------
  record.operations.forEach((op, i) => {
    const opPath = `$.operations[${i}]`;
    if (!isPlainObject(op)) {
      errors.push({ code: "shape", path: opPath, message: "operation entries must be objects" });
      return;
    }
    if (typeof op.type !== "string" || !TYPED_OP_RE.test(op.type)) {
      errors.push({
        code: "shape",
        path: `${opPath}.type`,
        message: `operation.type must be a typed op code matching ${TYPED_OP_RE}, got ${JSON.stringify(op.type)}`,
      });
    }
    checkSourceRef(op, opPath, `operation ${JSON.stringify(op.id)}`);
    checkRunId(op.runId, opPath, `operation ${JSON.stringify(op.id)}`);
    if (op.evidenceRefs !== undefined) {
      if (!Array.isArray(op.evidenceRefs)) {
        errors.push({ code: "shape", path: `${opPath}.evidenceRefs`, message: "operation.evidenceRefs must be an array when present" });
      } else {
        op.evidenceRefs.forEach((ref, j) => {
          if (typeof ref !== "string" || ref.length === 0) {
            errors.push({ code: "shape", path: `${opPath}.evidenceRefs[${j}]`, message: "evidenceRef entries must be non-empty strings" });
          } else if (!observationIds.has(ref)) {
            errors.push({
              code: "incomplete-claim",
              path: `${opPath}.evidenceRefs[${j}]`,
              message: `operation ${JSON.stringify(op.id)} references evidence observation ${ref} that is absent`,
            });
          }
        });
      }
    }
  });

  // -- expectedOutcomes ----------------------------------------------------
  record.expectedOutcomes.forEach((outcome, i) => {
    const ocPath = `$.expectedOutcomes[${i}]`;
    if (!isPlainObject(outcome)) {
      errors.push({ code: "shape", path: ocPath, message: "expectedOutcome entries must be objects" });
      return;
    }
    if (outcome.outcome === undefined || outcome.outcome === null) {
      errors.push({ code: "shape", path: `${ocPath}.outcome`, message: "expectedOutcome needs a mechanical outcome" });
    }
    checkSourceRef(outcome, ocPath, `expectedOutcome ${JSON.stringify(outcome.id)}`);
    checkRunId(outcome.runId, ocPath, `expectedOutcome ${JSON.stringify(outcome.id)}`);
    if (outcome.operationRef !== undefined) {
      if (typeof outcome.operationRef !== "string" || outcome.operationRef.length === 0) {
        errors.push({ code: "shape", path: `${ocPath}.operationRef`, message: "expectedOutcome.operationRef must be a non-empty string when present" });
      } else if (!operationIds.has(outcome.operationRef)) {
        errors.push({
          code: "incomplete-claim",
          path: `${ocPath}.operationRef`,
          message: `expectedOutcome ${JSON.stringify(outcome.id)} references operation ${outcome.operationRef} that is absent`,
        });
      }
    }
    if (outcome.evidenceRefs !== undefined) {
      if (!Array.isArray(outcome.evidenceRefs)) {
        errors.push({ code: "shape", path: `${ocPath}.evidenceRefs`, message: "expectedOutcome.evidenceRefs must be an array when present" });
      } else {
        outcome.evidenceRefs.forEach((ref, j) => {
          if (typeof ref !== "string" || ref.length === 0) {
            errors.push({ code: "shape", path: `${ocPath}.evidenceRefs[${j}]`, message: "evidenceRef entries must be non-empty strings" });
          } else if (!observationIds.has(ref)) {
            errors.push({
              code: "incomplete-claim",
              path: `${ocPath}.evidenceRefs[${j}]`,
              message: `expectedOutcome ${JSON.stringify(outcome.id)} references evidence observation ${ref} that is absent`,
            });
          }
        });
      }
    }
  });

  // -- unknown -------------------------------------------------------------
  record.unknown.forEach((u, i) => {
    const uPath = `$.unknown[${i}]`;
    if (!isPlainObject(u)) {
      errors.push({ code: "shape", path: uPath, message: "unknown entries must be objects" });
      return;
    }
    if (typeof u.fact !== "string" || u.fact.length === 0) {
      errors.push({ code: "shape", path: `${uPath}.fact`, message: "unknown entry needs a non-empty fact string" });
    }
    if (!UNKNOWN_REASONS.includes(u.reason)) {
      errors.push({
        code: "shape",
        path: `${uPath}.reason`,
        message: `unknown reason must be one of ${UNKNOWN_REASONS.join("|")}, got ${JSON.stringify(u.reason)}`,
      });
    }
    checkRunId(u.runId, uPath, "unknown");
  });

  // -- locator-level run declarations --------------------------------------
  if (Array.isArray(sourceRefs) && canonicalRunId !== undefined) {
    sourceRefs.forEach((ref, i) => {
      if (ref && ref.runId !== undefined && ref.runId !== canonicalRunId) {
        errors.push({
          code: "mixed-run",
          path: `${siPath}.sourceRefs[${i}].runId`,
          message: `sourceRef ${JSON.stringify(ref.locatorId)} declares runId ${ref.runId} but the record runId is ${canonicalRunId}`,
        });
      }
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  if (record.unknown.length === 0) {
    return { ok: true };
  }
  // Surface every declared unknown as a labeled entry — the ok result carries
  // them explicitly so a caller can see the honest gaps. Never dropped,
  // never upgraded into a captured value.
  return {
    ok: true,
    unknowns: record.unknown.map((u) => ({ fact: u.fact, reason: u.reason, classification: "unknown" })),
  };
}
