import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  IMPLEMENTATION,
  UPDATE_CONTRACT,
} from "../scripts/update-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN_RECORD = path.join(REPO_ROOT, "docs", "upgrade-protocol.md");
const document = fs.readFileSync(DESIGN_RECORD, "utf8");

const REQUIRED_TOPICS = [
  "Entrypoints and legacy handoff",
  "Versions and compatibility",
  "Actors, ownership, and authority",
  "Identity and capability security",
  "Lifecycle and re-entry",
  "Durable artifacts and atomicity",
  "Admission and refusal",
  "Versioned topology restoration",
  "Readiness evidence",
  "Commit, rollback, and atomic release",
  "Total fault contract",
  "Downstream implementation scopes",
];

const REQUIRED_MATRIX_REFERENCES = [
  "CONTROL_FLOW.entrypoints",
  "CONTROL_FLOW.paths",
  "CONTROL_FLOW.userOutcomes",
  "CONTROL_FLOW.reentry",
  "COMPATIBILITY_POLICY.cases",
  "VERSIONS",
  "TRANSACTION_IDENTITY",
  "ACTORS",
  "AUTHORITY.operations",
  "AUTHORITY.evidenceRules",
  "CAPABILITY_LIFECYCLE",
  "PROCESS_IDENTITY",
  "RELEASE_BLOCKERS",
  "LIFECYCLE.states",
  "LIFECYCLE.edges",
  "LIFECYCLE.statePolicies",
  "LIFECYCLE.evidenceConsistency",
  "ARTIFACT_CONTRACT.artifacts",
  "ARTIFACT_CONTRACT.schemas",
  "ARTIFACT_CONTRACT.atomicPublication",
  "ARTIFACT_CONTRACT.unsafeArtifacts",
  "ADMISSION_CONTRACT.predicates",
  "TOPOLOGIES",
  "READINESS_CONTRACT.runningPredicates",
  "READINESS_CONTRACT.absencePredicates",
  "TERMINAL_PROTOCOL.candidateCommit",
  "TERMINAL_PROTOCOL.rollbackVerification",
  "TERMINAL_PROTOCOL.release",
  "FAULT_CONTRACT.preHandoffAndBuild",
  "FAULT_CONTRACT.mutationServiceAndRelease",
  "FAULT_CONTRACT.rollbackAndRecovery",
  "DOWNSTREAM_SCOPES.scopes",
  "DOWNSTREAM_SCOPES.productionSurfaceOwnership",
];

describe("authoritative upgrade protocol design record", () => {
  it("covers every required target topic under an explicit normative target-only heading", () => {
    for (const topic of REQUIRED_TOPICS) {
      assert.match(document, new RegExp(`^## Normative target-only: ${topic}$`, "mu"), topic);
    }
  });

  it("cross-references every canonical contract section and identifier family", () => {
    for (const section of Object.keys(UPDATE_CONTRACT)) {
      assert.ok(document.includes(`UPDATE_CONTRACT.${section}`), `missing contract section ${section}`);
    }
    for (const family of Object.keys(UPDATE_CONTRACT.identifiers)) {
      assert.ok(document.includes(`IDENTIFIERS.${family}`), `missing identifier family ${family}`);
    }
    for (const reference of REQUIRED_MATRIX_REFERENCES) {
      assert.ok(document.includes(reference), `missing matrix reference ${reference}`);
    }
  });

  it("has an exact implemented-current table and does not present target behavior as live", () => {
    assert.match(document, /^## Implemented-current behavior \(dormant foundation only\)$/mu);
    assert.match(document, /scripts\/update-protocol\.mjs[^\n]*acquire[^\n]*inspect[^\n]*recordGuardian[^\n]*fail[^\n]*isGateActive/iu);
    assert.match(document, /scripts\/update-coordinator\.mjs[^\n]*acquire[^\n]*inspect[^\n]*record-guardian-cas[^\n]*fail/iu);
    assert.match(document, /argv[^\n]*not production-safe/iu);
    assert.match(document, /productionWired[^\n]*false/iu);
    for (const phase of IMPLEMENTATION.foundation.phases) assert.ok(document.includes(`\`${phase}\``));
    for (const scope of IMPLEMENTATION.productionLifecycle.scope) {
      assert.match(document, new RegExp(`\\| ${scope.replaceAll("-", "[- ]")} \\| Normative target-only \\|`, "iu"), scope);
    }
  });

  it("prominently pins reserved exit 75 and its user-visible accepted re-entry result", () => {
    const contractMap = document.indexOf("## Canonical machine contract map");
    const decision = document.indexOf("LEGACY HANDOFF DECISION");
    assert.ok(decision >= 0 && decision < contractMap, "legacy decision must precede the detailed contract");
    assert.match(document, /positive[\s\S]{0,160}guardian[\s\S]{0,80}identity[\s\S]{0,80}authority[\s\S]{0,80}handshake/iu);
    assert.match(document, /reserved[^\n]*nonzero[^\n]*75/iu);
    assert.match(document, /transaction-accepted-detached-not-complete/iu);
    assert.match(document, /tamandua update status \{publicTransactionId\}/u);
    assert.match(document, /tamandua update recover \{publicTransactionId\}/u);
  });

  it("prominently keeps macOS identity as a release blocker with its chosen resolution", () => {
    const contractMap = document.indexOf("## Canonical machine contract map");
    const blocker = document.indexOf("MACOS RELEASE BLOCKER");
    assert.ok(blocker >= 0 && blocker < contractMap, "macOS blocker must precede the detailed contract");
    assert.match(document, /tamandua\.upgx\.release-blocker\.macos-process-identity/u);
    assert.match(document, /tamandua\.upgx\.process-identity\.macos-native-boot-start/u);
    assert.match(document, /same-PID reuse[\s\S]{0,80}same-second replacement[\s\S]{0,80}host reboot[\s\S]{0,80}executable replacement/iu);
    assert.match(document, /HARN[^\n]*must not begin/iu);
  });

  it("contains no unresolved safety-gap vocabulary or duplicate normative source claim", () => {
    assert.doesNotMatch(document, /\b(?:TODO|TBD|implementation-defined)\b/iu);
    assert.doesNotMatch(document, /\bbest[ -]effort\b/iu);
    assert.equal((document.match(/single machine-readable source of truth/giu) ?? []).length, 1);
    assert.doesNotMatch(document, /this (?:table|list|section) (?:is|defines) the authoritative (?:matrix|identifier|state machine)/iu);
  });
});
