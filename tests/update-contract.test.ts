import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTORS,
  ADMISSION_CONTRACT,
  ARTIFACT_CONTRACT,
  AUTHORITY,
  CAPABILITY_LIFECYCLE,
  UPDATE_CONTRACT,
  COMPATIBILITY_POLICY,
  CONTROL_FLOW,
  DOWNSTREAM_SCOPES,
  FAULT_CONTRACT,
  IMPLEMENTATION,
  IDENTIFIERS,
  LEGACY_RELEASE_SHA,
  LIFECYCLE,
  PROCESS_IDENTITY,
  READINESS_CONTRACT,
  RELEASE_BLOCKERS,
  TERMINAL_PROTOCOL,
  TOPOLOGIES,
  TRANSACTION_IDENTITY,
  VERSIONS,
} from "../scripts/update-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_MODULE = path.join(REPO_ROOT, "scripts", "update-contract.mjs");

function assertDeepFrozen(value: unknown, seen = new Set<unknown>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  assert.ok(Object.isFrozen(value), "every contract object and array must be frozen");
  for (const child of Object.values(value)) assertDeepFrozen(child, seen);
}

function flattenStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(flattenStrings);
  }
  return [];
}

type LifecycleStatePolicy = {
  permittedWriters: string[];
  forbiddenActors: string[];
  requiredCapability: string;
  requiredImmutableIdentities: string[];
  entryPreconditions: string[];
  durableEvidence: string[];
  idempotentReplay: string;
  crashReentryDisposition: string;
  outgoingTransitions: string[];
  workAndServices: { newWork: string; services: string };
};

type DisagreementDisposition = {
  result: string;
  preserveGate: boolean;
  allowNewWork: boolean;
  destructiveRepair: boolean;
  adoptObservedState: boolean;
  nextAction: string;
};

type DurableArtifact = {
  path: string;
  kind: "file" | "directory" | "pattern";
  schemaIdentifier: string;
  schemaVersion: number;
  maximumBytes: number;
  mode: string;
  writers: string[];
  requiredStates: string[];
  retention: string;
  content: string;
  schemaDefinition: string;
};

type UnsafeArtifactRule = {
  disposition: string;
  destructiveRepair: boolean;
  adoptObservedState: boolean;
  automaticCleanup: boolean;
  recoveryAction: string;
};

type AdmissionPredicate = {
  identifier: string;
  order: number;
  appliesTo: string[];
  evaluator: string;
  observationOnly: boolean;
  passEvidence: string[];
  refusalClasses: string[];
  failureDisposition: string;
};

type TopologyRole = {
  identifier: string;
  role: string;
  processUnit: string;
  processModel: string;
  endpoint: null | { transport: string; host: string; defaultPort: number; path: string };
  endpointOwnership: string;
  startOrder: number;
  stopOrder: number;
  originalIntent: { values: string[]; restoreExactly: boolean; sharedWith: string[] };
  readinessProfile: string;
  disagreementDisposition: string;
};

type FaultBoundary = {
  id: string;
  group: string;
  lifecycleState: string;
  durableEvidence: string[];
  detector: string;
  authorizedNextActor: string;
  requiredAuthority: string;
  idempotence: string;
  disposition: string;
  nextAction: string;
  workAdmission: string;
  serviceAdmission: string;
  userVisibleResult: string;
  releaseCondition: string;
  faultClasses: string[];
  faultDispositionByClass: Record<string, { disposition: string; nextAction: string; releaseCondition: string }>;
  mutationAllowed: boolean;
  positiveGuardianHandshakeRequired: boolean;
  immutableLegacyPostBuildPath: string;
  publicationFailureDisposition?: {
    beforeDurablePublication: { disposition: string; nextAction: string; releaseCondition: string };
    afterDurablePublication: { disposition: string; nextAction: string; releaseCondition: string };
  };
};

type DownstreamScope = {
  identifier: string;
  status: string;
  prerequisites: string[];
  obligations: string[];
  exclusions: string[];
  consumedContractSections: string[];
  requiredContractIdentifiers: string[];
  ownedProductionSurfaces: string[];
  blackBoxAcceptanceGates: Array<{
    identifier: string;
    proof: string;
    preservesInvariants: string[];
  }>;
};

type ProductionSurfaceOwnership = {
  owner: string;
  mutatesProduction: boolean;
  productionSurfaces: string[];
  ownershipRule: string;
};

const lifecycleEdges = LIFECYCLE.edges as Array<{ id: string; from: string; actor: string }>;

describe("update contract vocabulary", () => {
  it("is import-only plain data with no side-effect-capable dependencies", () => {
    const source = fs.readFileSync(CONTRACT_MODULE, "utf8");

    assert.doesNotMatch(source, /^\s*import\s/m);
    assert.doesNotMatch(
      source,
      /node:(?:fs|sqlite|child_process|net|http|https|dgram|worker_threads)|\b(?:fetch|process\.|console\.)/,
    );
    assertDeepFrozen(UPDATE_CONTRACT);
    assert.equal(Object.getPrototypeOf(UPDATE_CONTRACT), Object.prototype);
  });

  it("pins implementation status without presenting target lifecycle as live", () => {
    assert.equal(IMPLEMENTATION.foundation.status, "implemented-foundation");
    assert.equal(IMPLEMENTATION.foundation.productionWired, false);
    assert.deepEqual(IMPLEMENTATION.foundation.phases, [
      "ACQUIRED",
      "GUARDIAN_RECORDED",
      "FAILED",
    ]);
    assert.equal(IMPLEMENTATION.productionLifecycle.status, "target-only");
    assert.equal(IMPLEMENTATION.productionLifecycle.productionWired, false);
    assert.equal(IMPLEMENTATION.productionLifecycle.claimsLiveSafety, false);
  });

  it("assigns a unique canonical identifier to every declared vocabulary member", () => {
    const identifiers = flattenStrings(IDENTIFIERS);
    assert.ok(identifiers.length > 0);
    assert.equal(new Set(identifiers).size, identifiers.length);
    for (const identifier of identifiers) {
      assert.match(identifier, /^tamandua\.upgx\.[a-z][a-z0-9.-]*$/);
      assert.equal(identifier, identifier.toLowerCase());
    }
  });

  it("pins all artifact and protocol versions to one explicit compatibility policy", () => {
    const expectedKinds = [
      "protocol",
      "gateSchema",
      "durableManifest",
      "snapshotMetadata",
      "rollbackMetadata",
      "topologySchema",
      "artifactManifest",
      "readinessEvidence",
    ];
    assert.deepEqual(Object.keys(VERSIONS), expectedKinds);

    const versionIdentifiers = Object.values(VERSIONS).map((entry) => entry.identifier);
    assert.equal(new Set(versionIdentifiers).size, expectedKinds.length);
    for (const entry of Object.values(VERSIONS)) {
      assert.match(entry.identifier, /^tamandua\.upgx\.[a-z][a-z0-9-]*\/v[1-9][0-9]*$/);
      assert.equal(entry.version, 1);
      assert.equal(entry.compatibilityPolicy, COMPATIBILITY_POLICY.identifier);
      assert.equal(entry.status, "target-only");
    }
  });

  it("defines total fail-closed compatibility behavior for every required input class", () => {
    const requiredCases = [
      "same",
      "older",
      "newer",
      "missing",
      "malformed",
      "partial",
      "case-conflicting",
    ];
    assert.deepEqual(Object.keys(COMPATIBILITY_POLICY.cases), requiredCases);

    for (const [name, rule] of Object.entries(COMPATIBILITY_POLICY.cases)) {
      assert.ok(rule.readerAction.length > 0, `${name} reader action`);
      assert.ok(rule.writerAction.length > 0, `${name} writer action`);
      assert.equal(rule.destructiveRepair, false);
      assert.equal(rule.adoptExisting, false);
      assert.equal(rule.compatible, name === "same");
      if (name === "same") {
        assert.equal(rule.disposition, "accept");
      } else {
        assert.equal(rule.disposition, "fail-closed");
      }
    }
  });

  it("separates the bounded public transaction id from secret capability material", () => {
    const publicId = TRANSACTION_IDENTITY.publicTransactionId;
    const capability = TRANSACTION_IDENTITY.secretCapability;

    assert.equal(publicId.secret, false);
    assert.equal(publicId.encoding, "ascii");
    assert.ok(publicId.minimumBytes > 0);
    assert.ok(publicId.maximumBytes >= publicId.minimumBytes);
    assert.match(publicId.example, new RegExp(publicId.pattern));
    assert.ok(Buffer.byteLength(publicId.example, "ascii") <= publicId.maximumBytes);

    assert.equal(capability.secret, true);
    assert.equal(capability.public, false);
    assert.equal(capability.distinctFrom, publicId.identifier);
    assert.equal(capability.status, "target-only");
  });

  it("pins the immutable legacy release and distinct versioned topology shapes", () => {
    assert.equal(LEGACY_RELEASE_SHA, "0258feeceeb2ab3934b71463039e6e282700f05a");
    assert.match(LEGACY_RELEASE_SHA, /^[0-9a-f]{40}$/);

    assert.equal(TOPOLOGIES.legacy.sourceCommit, LEGACY_RELEASE_SHA);
    assert.equal(TOPOLOGIES.legacy.shape, "legacy-four-role");
    assert.equal(TOPOLOGIES.current.shape, "current-consolidated");
    assert.notEqual(TOPOLOGIES.legacy.identifier, TOPOLOGIES.current.identifier);
    assert.equal(TOPOLOGIES.legacy.schemaVersion, VERSIONS.topologySchema.identifier);
    assert.equal(TOPOLOGIES.current.schemaVersion, VERSIONS.topologySchema.identifier);

    const legacyRoles = TOPOLOGIES.legacy.roles.map((role) => role.role);
    assert.deepEqual(legacyRoles, ["dashboard", "scheduler", "mcp", "control-plane"]);
    assert.equal(new Set(legacyRoles).size, 4);
    assert.equal(
      TOPOLOGIES.legacy.roles.find((role) => role.role === "control-plane")?.processModel,
      "optional-standalone-or-daemon-colocated",
    );

    const currentRoles = TOPOLOGIES.current.roles.map((role) => role.role);
    assert.deepEqual(currentRoles, ["daemon", "dashboard", "mcp"]);
    assert.equal(new Set(currentRoles).size, 3);
    assert.deepEqual(TOPOLOGIES.current.roles[0].functions, ["scheduler", "control-plane"]);
    assert.notDeepEqual(TOPOLOGIES.legacy.roles, TOPOLOGIES.current.roles);
  });

  it("makes both versioned topology role matrices total and canonical", () => {
    for (const [topologyName, topology] of Object.entries(TOPOLOGIES)) {
      assert.equal(topology.status, "target-only", `${topologyName} status`);
      assert.equal(topology.productionWired, false, `${topologyName} wiring`);
      assert.deepEqual(topology.originalIntentValues, ["running", "stopped"]);

      const roles = topology.roles as TopologyRole[];
      assert.equal(new Set(roles.map((role) => role.identifier)).size, roles.length);
      assert.equal(new Set(roles.map((role) => role.role)).size, roles.length);
      for (const role of roles) {
        assert.ok(role.processUnit.length > 0, `${role.identifier} process owner`);
        assert.ok(role.endpointOwnership.length > 0, `${role.identifier} endpoint ownership`);
        assert.ok(Number.isSafeInteger(role.startOrder) && role.startOrder > 0);
        assert.ok(Number.isSafeInteger(role.stopOrder) && role.stopOrder > 0);
        assert.deepEqual(role.originalIntent.values, ["running", "stopped"]);
        assert.equal(role.originalIntent.restoreExactly, true);
        assert.ok(role.readinessProfile.length > 0);
        assert.equal(role.disagreementDisposition, "fail-closed-preserve-gate-no-observation-adoption");
        if (role.endpoint !== null) {
          assert.equal(role.endpoint.transport, "http");
          assert.equal(role.endpoint.host, "loopback-configured-address");
          assert.ok(role.endpoint.defaultPort > 0 && role.endpoint.defaultPort <= 65535);
          assert.ok(role.endpoint.path.startsWith("/"));
        }
      }
    }
  });

  it("pins complete process-unit restoration ordering and shared-intent constraints", () => {
    for (const topology of Object.values(TOPOLOGIES)) {
      const roles = topology.roles as TopologyRole[];
      const units = topology.restoration.processUnits;
      assert.equal(new Set(units.map((unit: { id: string }) => unit.id)).size, units.length);
      assert.deepEqual(
        [...new Set(roles.map((role) => role.processUnit))].sort(),
        units.map((unit: { id: string }) => unit.id).sort(),
      );
      assert.deepEqual(
        units.map((unit: { startOrder: number }) => unit.startOrder).sort((a: number, b: number) => a - b),
        units.map((_: unknown, index: number) => index + 1),
      );
      assert.deepEqual(
        units.map((unit: { stopOrder: number }) => unit.stopOrder).sort((a: number, b: number) => a - b),
        units.map((_: unknown, index: number) => index + 1),
      );
      assert.equal(topology.restoration.intentSource, "durable-verified-snapshot-inventory-only");
      assert.equal(topology.restoration.runningAction, "start-exact-recorded-process-unit-on-recorded-endpoints");
      assert.equal(topology.restoration.stoppedAction, "prove-process-unit-and-all-endpoints-absent");
      assert.equal(topology.restoration.partialOrHybridDisposition, "fail-closed-preserve-gate-mandatory-authorized-recovery");
      for (const group of topology.intentGroups) {
        assert.ok(group.roles.length > 0);
        assert.ok(group.roles.every((role: string) => roles.some((entry) => entry.role === role)));
        assert.equal(group.mixedIntentAllowed, false);
      }
    }
  });

  it("pins current optional MCP ownership without permitting an impossible mixed colocated intent", () => {
    assert.deepEqual(Object.keys(TOPOLOGIES.current.hostingModeRules), [
      "current-mcp-standalone", "current-daemon-colocated",
    ]);
    assert.equal(TOPOLOGIES.current.hostingModeRules["current-mcp-standalone"].ownerProcessUnit, "current-mcp-service");
    assert.equal(TOPOLOGIES.current.hostingModeRules["current-mcp-standalone"].intentDependency, "independent-recorded-mcp-intent");
    assert.equal(TOPOLOGIES.current.hostingModeRules["current-mcp-standalone"].restoreAction, "start-standalone-at-order-3-stop-at-order-1");
    assert.equal(TOPOLOGIES.current.hostingModeRules["current-daemon-colocated"].ownerProcessUnit, "current-daemon");
    assert.equal(TOPOLOGIES.current.hostingModeRules["current-daemon-colocated"].intentDependency, "mcp-running-requires-daemon-running-and-same-pid-identity-build");
    assert.equal(TOPOLOGIES.current.hostingModeRules["current-daemon-colocated"].restoreAction, "enable-listener-during-daemon-start-order-1-verify-at-order-3-close-listener-at-stop-order-1");
    assert.equal(TOPOLOGIES.current.hostingModeRules["current-daemon-colocated"].daemonStoppedMcpRunningAllowed, false);
  });

  it("pins every immutable legacy control-plane and MCP ownership mode", () => {
    const legacyMcp = TOPOLOGIES.legacy.roles.find((role) => role.role === "mcp");
    const legacyControl = TOPOLOGIES.legacy.roles.find((role) => role.role === "control-plane");
    assert.deepEqual(legacyMcp?.processOwnershipCases, [
      "legacy-mcp-standalone", "legacy-daemon-mcp-colocated",
    ]);
    assert.deepEqual(legacyControl?.processOwnershipCases, [
      "legacy-control-plane-standalone", "legacy-daemon-control-colocated",
    ]);

    assert.deepEqual(Object.keys(TOPOLOGIES.legacy.hostingModeRules), [
      "legacy-mcp-standalone", "legacy-daemon-mcp-colocated",
      "legacy-control-plane-standalone", "legacy-daemon-control-colocated",
    ]);
    assert.equal(TOPOLOGIES.legacy.hostingModeRules["legacy-daemon-mcp-colocated"].ownerProcessUnit, "legacy-dashboard-daemon");
    assert.equal(TOPOLOGIES.legacy.hostingModeRules["legacy-daemon-control-colocated"].ownerProcessUnit, "legacy-dashboard-daemon");
    for (const mode of ["legacy-daemon-mcp-colocated", "legacy-daemon-control-colocated"] as const) {
      assert.equal(
        TOPOLOGIES.legacy.hostingModeRules[mode].intentDependency,
        "role-running-requires-daemon-running-and-same-pid-immutable-identity-build",
      );
      assert.equal(TOPOLOGIES.legacy.hostingModeRules[mode].daemonStoppedRoleRunningAllowed, false);
    }
    for (const roleId of ["tamandua.upgx.role.legacy.mcp", "tamandua.upgx.role.legacy.control-plane"] as const) {
      assert.ok(
        READINESS_CONTRACT.roleProfiles[roleId].authenticatedHealth.requiredClaims.includes("hosting-mode"),
        `${roleId} health must authenticate standalone versus colocated ownership`,
      );
    }
  });

  it("enumerates all and only valid immutable legacy hosting combinations", () => {
    const cases = TOPOLOGIES.legacy.validHostingCases;
    assert.deepEqual(cases.map((entry) => entry.id), [
      "daemon-running-control-colocated-mcp-stopped",
      "daemon-running-control-colocated-mcp-standalone",
      "daemon-running-control-colocated-mcp-colocated",
      "daemon-stopped-control-stopped-mcp-stopped",
      "daemon-stopped-control-stopped-mcp-standalone",
      "daemon-stopped-control-standalone-mcp-stopped",
      "daemon-stopped-control-standalone-mcp-standalone",
    ]);
    assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);

    const usedHostingModes = new Set<string>();
    for (const entry of cases) {
      for (const role of [entry.controlPlane, entry.mcp]) {
        if (role.intent === "running") {
          assert.ok(role.hostingMode !== null);
          usedHostingModes.add(role.hostingMode);
        } else {
          assert.equal(role.hostingMode, null);
        }
      }
    }
    assert.deepEqual([...usedHostingModes].sort(), Object.keys(TOPOLOGIES.legacy.hostingModeRules).sort());

    for (const entry of cases) {
      if (entry.daemonIntent === "running") {
        assert.deepEqual(entry.controlPlane, { intent: "running", hostingMode: "legacy-daemon-control-colocated" });
      } else {
        assert.notEqual(entry.controlPlane.hostingMode, "legacy-daemon-control-colocated");
        assert.notEqual(entry.mcp.hostingMode, "legacy-daemon-mcp-colocated");
      }
    }
    assert.deepEqual(TOPOLOGIES.legacy.impossibleHybrids, [
      "daemon-running-with-control-stopped-or-standalone",
      "daemon-stopped-with-any-daemon-colocated-role-running",
      "one-role-recorded-with-multiple-or-missing-hosting-modes",
      "colocated-role-pid-immutable-identity-or-build-differs-from-daemon",
      "standalone-and-colocated-listeners-or-processes-for-the-same-role",
    ]);
  });

  it("requires every positive readiness predicate for every intended-running role", () => {
    const expectedPredicates = [
      "durable-role-and-intent-match", "pid-equals-durable-evidence",
      "immutable-process-identity-match", "expected-build-identity-match",
      "authenticated-role-health", "listener-owned-by-exact-process",
      "endpoint-uniqueness", "workflow-catalog-consistency",
      "database-schema-compatibility", "duplicate-listener-exclusion",
      "duplicate-process-exclusion",
    ];
    assert.deepEqual(READINESS_CONTRACT.runningPredicateOrder, expectedPredicates);
    assert.deepEqual(Object.keys(READINESS_CONTRACT.runningPredicates), expectedPredicates);
    assert.equal(READINESS_CONTRACT.conjunction, "all-applicable-predicates-must-pass-from-one-bounded-observation");

    const roleIds = Object.values(TOPOLOGIES).flatMap((topology) =>
      topology.roles.map((role: TopologyRole) => role.identifier));
    assert.deepEqual(Object.keys(READINESS_CONTRACT.roleProfiles).sort(), [...roleIds].sort());
    for (const [roleId, profile] of Object.entries(READINESS_CONTRACT.roleProfiles)) {
      assert.deepEqual(profile.requiredPredicates, expectedPredicates, `${roleId} readiness total`);
      assert.ok(profile.authenticatedHealth.request.length > 0);
      assert.ok(profile.authenticatedHealth.requiredClaims.length > 0);
      assert.ok(profile.listenerProof.length > 0);
      assert.ok(profile.buildAndDataProof.length > 0);
    }
  });

  it("proves intended-stopped absence and excludes duplicate listeners and processes", () => {
    assert.deepEqual(READINESS_CONTRACT.absencePredicateOrder, [
      "recorded-intent-is-stopped", "recorded-process-identity-not-live",
      "no-role-process-under-expected-or-conflicting-build", "no-expected-endpoint-listener",
      "no-conflicting-endpoint-listener", "no-authenticated-role-health-response",
      "no-duplicate-role-process", "no-duplicate-listener",
    ]);
    assert.deepEqual(
      Object.keys(READINESS_CONTRACT.absencePredicates),
      READINESS_CONTRACT.absencePredicateOrder,
    );
    assert.equal(READINESS_CONTRACT.duplicateExclusion.listeners.cardinality, "zero-or-one-exact-owner-per-configured-endpoint");
    assert.equal(READINESS_CONTRACT.duplicateExclusion.processes.cardinality, "zero-or-one-exact-process-unit-per-intended-running-unit");
    assert.equal(READINESS_CONTRACT.duplicateExclusion.anyDuplicateDisposition, "fail-closed-preserve-gate-mandatory-authorized-recovery");
  });

  it("never treats spawn, PID liveness, or an open port as readiness", () => {
    assert.deepEqual(READINESS_CONTRACT.insufficientEvidence, [
      "spawn-returned-pid", "pid-file-exists", "pid-is-live", "port-is-open",
      "socket-accepts-connection", "unauthenticated-health-response",
    ]);
    assert.equal(READINESS_CONTRACT.anySingleObservationSufficient, false);
    assert.equal(READINESS_CONTRACT.observationMismatchDisposition, "fail-closed-preserve-gate-no-restart-or-adoption");
  });

  it("pins candidate-controlled entrypoints before candidate mutation", () => {
    assert.equal(CONTROL_FLOW.status, "target-only");
    assert.equal(CONTROL_FLOW.productionWired, false);
    assert.equal(
      CONTROL_FLOW.entrypoints.legacy.firstCandidateInstruction,
      "line-1-of-pulled-checkout/build-and-install",
    );
    assert.deepEqual(CONTROL_FLOW.entrypoints.legacy.legacyActionsBeforeEntry, [
      "read-source-head",
      "git-pull",
      "read-source-head",
      "await-build-and-install",
    ]);
    assert.equal(CONTROL_FLOW.entrypoints.legacy.allowedPriorCandidateMutation, "none");
    assert.equal(
      CONTROL_FLOW.entrypoints.current.firstCandidateInstruction,
      "current-updater-direct-coordinator-entry",
    );
    assert.equal(CONTROL_FLOW.entrypoints.current.beforeCandidateMutation, true);
    assert.ok(
      CONTROL_FLOW.entrypoints.current.precedes.every((action: string) =>
        ["git-pull", "build", "install", "workflow-catalog", "service", "database-application"].includes(action),
      ),
    );
  });

  it("uses a handshaken detached guardian and reserved nonzero escape to stop legacy continuation", () => {
    const legacy = CONTROL_FLOW.paths.legacy;
    const stepIds = legacy.steps.map((step: { id: string }) => step.id);
    assert.equal(new Set(stepIds).size, stepIds.length);
    assert.deepEqual(stepIds, [
      "candidate-entry",
      "admission",
      "guardian-spawn",
      "guardian-positive-handshake",
      "accepted-notice",
      "reserved-handoff-exit",
      "legacy-run-command-rejection",
      "legacy-owner-exit",
      "guardian-sole-control",
    ]);

    const handshakeIndex = stepIds.indexOf("guardian-positive-handshake");
    const escapeIndex = stepIds.indexOf("reserved-handoff-exit");
    assert.ok(handshakeIndex < escapeIndex);
    assert.ok(
      legacy.steps
        .filter((step: { canStrandLegacyPath: boolean; candidateMutation: boolean }) =>
          step.canStrandLegacyPath || step.candidateMutation)
        .every((step: { id: string }) => stepIds.indexOf(step.id) > handshakeIndex),
    );
    assert.equal(legacy.guardian.detached, true);
    assert.equal(legacy.guardian.handshakeRequiresIdentity, true);
    assert.equal(legacy.guardian.handshakeRequiresDurableAuthority, true);
    assert.equal(legacy.guardian.waitsForLegacyOwnerExit, true);
    assert.equal(legacy.buildShell.waitsForGuardianCompletion, false);
    assert.equal(legacy.immutableUpdater.awaitsBuildShell, true);
    assert.equal(legacy.immutableUpdater.runCommandRejectsNonzero, true);
    assert.equal(legacy.immutableUpdater.executesPostBuildCode, false);
    assert.ok(Number.isSafeInteger(legacy.escape.exitCode));
    assert.ok(legacy.escape.exitCode > 0 && legacy.escape.exitCode <= 255);
    assert.equal(legacy.escape.meaning, "transaction-accepted-detached-not-complete");
    assert.equal(legacy.deadlockPrevention.ownerWaitsForGuardian, false);
    assert.equal(legacy.deadlockPrevention.guardianWaitsForOwnerExit, true);
  });

  it("pins honest user outcomes and deterministic no-change and force re-entry", () => {
    const outcomes = CONTROL_FLOW.userOutcomes;
    assert.equal(outcomes.legacyAccepted.commandReturnsSuccess, false);
    assert.equal(outcomes.legacyAccepted.transactionComplete, false);
    assert.match(outcomes.legacyAccepted.noticeTemplate, /\{publicTransactionId\}/);
    assert.match(outcomes.legacyAccepted.statusCommandTemplate, /\{publicTransactionId\}/);
    assert.match(outcomes.legacyAccepted.reentryCommandTemplate, /\{publicTransactionId\}/);
    assert.doesNotMatch(JSON.stringify(outcomes.legacyAccepted), /secret|capability/i);

    const scenarios = CONTROL_FLOW.reentry.scenarios;
    assert.deepEqual(Object.keys(scenarios), [
      "legacy-no-change-no-force",
      "legacy-no-change-force",
      "current-no-change-no-transaction",
      "existing-transaction",
    ]);
    assert.equal(scenarios["legacy-no-change-no-force"].coordinatorEntered, false);
    assert.equal(scenarios["legacy-no-change-force"].coordinatorEntered, true);
    assert.equal(scenarios["current-no-change-no-transaction"].coordinatorEntered, true);
    assert.equal(scenarios["existing-transaction"].action, "authenticated-deterministic-reentry-evaluation");
    for (const scenario of Object.values(scenarios)) {
      assert.equal(scenario.forceGrantsAuthority, false);
      assert.equal(scenario.forceBypassesAdmission, false);
      assert.equal(scenario.forceBypassesRecoveryOwnership, false);
    }
  });

  it("defines a total ordered read-only admission predicate matrix", () => {
    assert.equal(ADMISSION_CONTRACT.status, "target-only");
    assert.equal(ADMISSION_CONTRACT.productionWired, false);
    assert.deepEqual(ADMISSION_CONTRACT.entryModes, ["legacy-post-pull", "current-pre-pull"]);
    assert.deepEqual(ADMISSION_CONTRACT.outcomes, ["pass", "refuse"]);

    const expectedPredicates = [
      "entry-context", "owner-ancestry-and-identity", "platform-release-blockers",
      "runtime-prerequisites", "state-root-safety", "source-identity",
      "transaction-and-gate-absence", "artifact-compatibility", "active-work",
      "resource-capacity",
    ];
    assert.deepEqual(Object.keys(ADMISSION_CONTRACT.predicates), expectedPredicates);

    const predicates = Object.values(ADMISSION_CONTRACT.predicates) as AdmissionPredicate[];
    assert.deepEqual(predicates.map((predicate) => predicate.order), predicates.map((_, index) => index + 1));
    assert.equal(new Set(predicates.map((predicate) => predicate.identifier)).size, predicates.length);
    for (const predicate of predicates) {
      assert.deepEqual(predicate.appliesTo, ADMISSION_CONTRACT.entryModes);
      assert.equal(predicate.evaluator, "candidateCoordinator");
      assert.equal(predicate.observationOnly, true);
      assert.ok(predicate.passEvidence.length > 0);
      assert.ok(predicate.refusalClasses.length > 0);
      assert.equal(predicate.failureDisposition, "refuse-before-acquisition-and-candidate-mutation");
    }
  });

  it("refuses every required unsafe admission class", () => {
    const refusalClasses = new Set(
      (Object.values(ADMISSION_CONTRACT.predicates) as AdmissionPredicate[])
        .flatMap((predicate) => predicate.refusalClasses),
    );
    for (const required of [
      "running-work", "paused-work", "existing-compatible-transaction",
      "existing-incompatible-transaction", "partial-or-case-conflicting-gate",
      "invalid-owner-ancestry", "owner-identity-unresolved-or-mismatched",
      "active-platform-release-blocker", "missing-prerequisite", "insufficient-disk",
      "unsafe-state-root-owner-mode-links-or-filesystem", "source-identity-unresolved-or-moved",
      "unknown-newer-older-malformed-partial-or-case-conflicting-artifact",
    ]) {
      assert.ok(refusalClasses.has(required), `missing refusal class ${required}`);
    }
    assert.equal(ADMISSION_CONTRACT.existingTransactionPolicy.newAdmissionAllowed, false);
    assert.equal(ADMISSION_CONTRACT.existingTransactionPolicy.parallelTransactionAllowed, false);
    assert.equal(ADMISSION_CONTRACT.existingTransactionPolicy.compatibleDisposition, "refuse-new-admission-route-to-authenticated-reentry");
    assert.equal(ADMISSION_CONTRACT.existingTransactionPolicy.incompatibleDisposition, "fail-closed-no-adoption-or-repair");
  });

  it("orders every admission predicate before acquisition and all candidate mutation", () => {
    const ordering = ADMISSION_CONTRACT.ordering;
    assert.equal(ordering.evaluateAllPredicatesBeforeAcquisition, true);
    assert.deepEqual(ordering.afterAllPredicatesPass, [
      "acquire-gate-and-publish-initial-manifest-authority",
      "spawn-detached-guardian",
      "positive-guardian-identity-and-authority-handshake",
    ]);
    assert.deepEqual(ordering.forbiddenBeforeAllPredicatesPass, [
      "gate-or-transaction-publication", "guardian-spawn", "dependency-install",
      "compilation", "build-artifact-publication", "install-or-symlink-change",
      "workflow-or-catalog-change", "service-stop-start-or-signal",
      "database-application-or-schema-change", "snapshot-creation",
      "capability-persistence", "other-candidate-mutation",
    ]);
    assert.equal(ordering.predicatesMayCreateDurableEvidence, false);
    assert.equal(ordering.predicatesMayRepairOrAdopt, false);
  });

  it("preserves live state on refusal and permits only legacy pull HEAD movement", () => {
    const refusal = ADMISSION_CONTRACT.refusal;
    assert.deepEqual(refusal.allowedStateMutationsByMode, {
      "legacy-post-pull": ["already-completed-immutable-legacy-git-pull-source-head-movement"],
      "current-pre-pull": [],
    });
    assert.equal(refusal.pullHeadMovementIsSoleAllowedMutation, true);
    assert.equal(refusal.restoreOrResetPulledHeadOnRefusal, false);
    assert.deepEqual(refusal.mustRemainByteAndIntentPreserved, [
      "gate-and-transaction-artifacts", "build-and-install-artifacts", "install-symlink",
      "workflow-and-catalog", "service-processes-and-listeners", "database-and-schema",
      "snapshots-and-journals", "running-and-paused-work", "original-service-intent",
    ]);
    assert.equal(refusal.guardianSpawned, false);
    assert.equal(refusal.capabilityGeneratedOrPersisted, false);
    assert.equal(refusal.userResult, "refused-not-started-with-failed-predicate-and-public-safe-remedy");
  });

  it("treats force only as an evaluation request and never authority or bypass", () => {
    assert.deepEqual(ADMISSION_CONTRACT.force, {
      meaning: "request-entry-or-reentry-evaluation-only",
      entersEvaluation: true,
      grantsAuthority: false,
      suppliesCapability: false,
      bypassesPredicate: false,
      bypassesActiveWork: false,
      bypassesExistingGateOrTransaction: false,
      bypassesIdentity: false,
      bypassesReleaseBlocker: false,
      bypassesRecoveryOwnership: false,
      changesRefusalMutationLimit: false,
    });
    assert.equal(AUTHORITY.evidenceRules.forceAuthorizesAction, false);
  });

  it("defines total allowed and forbidden authority roles for every target actor", () => {
    const requiredActors = [
      "immutableLegacyUpdaterOwner", "currentUpdaterOwner", "buildShell", "candidateCoordinator",
      "detachedGuardian", "recoveryCoordinator", "serviceProcesses", "humanOperator",
    ];
    assert.deepEqual(Object.keys(ACTORS), requiredActors);
    const actorIds = Object.values(ACTORS).map((actor) => actor.identifier);
    assert.equal(new Set(actorIds).size, actorIds.length);
    const authorityRoles = new Set(AUTHORITY.roles);
    for (const [name, actor] of Object.entries(ACTORS)) {
      assert.ok(actor.responsibilities.length > 0, `${name} responsibilities`);
      assert.ok(actor.allowedAuthorityRoles.length > 0, `${name} allowed roles`);
      assert.ok(actor.forbiddenAuthorityRoles.length > 0, `${name} forbidden roles`);
      assert.deepEqual(
        new Set([...actor.allowedAuthorityRoles, ...actor.forbiddenAuthorityRoles]),
        authorityRoles,
        `${name} must classify every authority role`,
      );
      assert.equal(actor.allowedAuthorityRoles.some(
        (role: string) => actor.forbiddenAuthorityRoles.includes(role)), false);
    }
  });

  it("requires durable non-process authority plus the matching secret for every authority operation", () => {
    assert.deepEqual(Object.keys(AUTHORITY.operations), [
      "continue", "adopt", "mutate", "recover", "rollback", "cleanup", "release",
    ]);
    for (const [name, rule] of Object.entries(AUTHORITY.operations)) {
      assert.equal(rule.durableAuthorityRecordRequired, true, `${name} durable record`);
      assert.equal(rule.matchingSecretCapabilityRequired, true, `${name} matching secret`);
      assert.equal(rule.processEvidenceSufficient, false, `${name} process evidence`);
      assert.ok(rule.allowedActors.length > 0, `${name} allowed actors`);
      assert.ok(rule.requiredRecordFields.length > 0, `${name} record fields`);
    }
    assert.equal(AUTHORITY.evidenceRules.deadPidAuthorizesAction, false);
    assert.equal(AUTHORITY.evidenceRules.identityMismatchAuthorizesAction, false);
    assert.equal(AUTHORITY.evidenceRules.pidReuseAuthorizesAction, false);
    assert.equal(AUTHORITY.evidenceRules.bootChangeAuthorizesAction, false);
    assert.equal(AUTHORITY.evidenceRules.uncertaintyDisposition, "fail-closed-preserve-gate");
  });

  it("pins the complete secret capability lifecycle and forbids disclosure channels", () => {
    assert.equal(CAPABILITY_LIFECYCLE.generation.minimumEntropyBits, 256);
    assert.equal(CAPABILITY_LIFECYCLE.generation.source, "os-csprng");
    assert.equal(CAPABILITY_LIFECYCLE.transport.secretInArgv, false);
    assert.equal(CAPABILITY_LIFECYCLE.transport.secretInEnvironment, false);
    assert.deepEqual(CAPABILITY_LIFECYCLE.forbiddenChannels, [
      "argv", "environment", "logs", "diagnostics", "inspect", "ordinary-stdout",
      "world-readable-files",
    ]);
    assert.equal(CAPABILITY_LIFECYCLE.persistence.optional, true);
    assert.equal(CAPABILITY_LIFECYCLE.persistence.fileMode, "0600");
    assert.equal(CAPABILITY_LIFECYCLE.persistence.parentDirectoryMode, "0700");
    assert.equal(CAPABILITY_LIFECYCLE.redaction.replacement, "[REDACTED:UPGX-CAPABILITY]");
    assert.equal(CAPABILITY_LIFECYCLE.rotation.invalidatesPriorCapability, true);
    assert.equal(CAPABILITY_LIFECYCLE.destruction.requiredBeforeRelease, true);
    assert.equal(CAPABILITY_LIFECYCLE.recovery.requiresAuthenticatedLocalOperator, true);
    assert.equal(CAPABILITY_LIFECYCLE.recovery.requiresDurableAuthorityMatch, true);
  });

  it("blocks production use of dormant token arguments until private transport exists", () => {
    const mismatch = CAPABILITY_LIFECYCLE.implementedMismatch;
    assert.equal(mismatch.status, "implemented-foundation");
    assert.equal(mismatch.productionSafe, false);
    assert.equal(mismatch.tokensCurrentlyAcceptedInArgv, true);
    assert.equal(mismatch.productionUseProhibited, true);
    assert.equal(mismatch.targetTransport, CAPABILITY_LIFECYCLE.transport.identifier);
  });

  it("fails closed on PID reuse and reboot and blocks macOS pending a native identity primitive", () => {
    assert.equal(PROCESS_IDENTITY.processObservationIsAuthority, false);
    assert.equal(PROCESS_IDENTITY.linux.bootBound, true);
    assert.equal(PROCESS_IDENTITY.linux.pidReuseSafe, true);
    assert.equal(PROCESS_IDENTITY.reentry.pidReuseDisposition, "fail-closed-preserve-gate");
    assert.equal(PROCESS_IDENTITY.reentry.hostRebootDisposition, "authenticated-recovery-preserve-gate");
    const mac = PROCESS_IDENTITY.macos;
    assert.equal(mac.implementedFoundationPrimitive, "ps-lstart-second-resolution");
    assert.equal(mac.productionCompatible, false);
    assert.equal(mac.releaseBlocked, true);
    assert.ok(mac.selectedReplacement.fields.includes("boot-session-id"));
    assert.ok(mac.selectedReplacement.fields.includes("process-start-monotonic-nanoseconds"));
    assert.equal(mac.selectedReplacement.nativeImplementationRequired, true);
    const blocker = RELEASE_BLOCKERS.macosProcessIdentity;
    assert.equal(blocker.active, true);
    assert.equal(blocker.platform, "darwin");
    assert.equal(blocker.blocksProductionAdmission, true);
    assert.ok(blocker.acceptanceTests.includes("same-pid-reuse-is-rejected"));
    assert.ok(blocker.acceptanceTests.includes("host-reboot-invalidates-pre-reboot-identity"));
    assert.equal(blocker.resolution, mac.selectedReplacement.identifier);
  });

  it("pins every required target lifecycle stage as one distinct canonical state", () => {
    const expectedStates = [
      "idle", "admission-acquired", "guardian-ready", "legacy-owner-exited",
      "snapshot-ready", "applying", "topology-restored", "readiness-verified",
      "candidate-committed", "rollback-in-progress", "rollback-verified",
      "released", "unrecoverable-blocked",
    ];
    assert.deepEqual(Object.keys(LIFECYCLE.states), expectedStates);
    const stateIds = Object.values(LIFECYCLE.states).map((state) => state.identifier);
    assert.equal(new Set(stateIds).size, stateIds.length);
    assert.equal(LIFECYCLE.status, "target-only");
    assert.equal(LIFECYCLE.productionWired, false);
  });

  it("defines a closed, authority-bearing, forward-or-rollback legal edge set", () => {
    const expectedEdges = [
      "acquire-admission", "record-guardian-ready", "record-legacy-owner-exit",
      "snapshot-current", "snapshot-legacy", "begin-apply", "restore-topology",
      "verify-readiness", "commit-candidate", "begin-rollback-from-snapshot",
      "begin-rollback-from-apply", "begin-rollback-from-topology",
      "begin-rollback-from-readiness", "verify-rollback", "release-candidate",
      "release-rollback", "block-admission", "block-guardian", "block-owner-exit",
      "block-snapshot", "block-apply", "block-topology", "block-readiness",
      "block-commit", "block-rollback", "block-rollback-verified",
    ];
    assert.deepEqual(LIFECYCLE.edges.map((edge) => edge.id), expectedEdges);
    assert.equal(new Set(expectedEdges).size, expectedEdges.length);

    const states = new Set(Object.keys(LIFECYCLE.states));
    const actors = new Set(Object.keys(ACTORS));
    const mutationClasses = new Set(LIFECYCLE.mutationClasses);
    const directions = new Set(["forward", "rollback", "terminal"]);
    for (const edge of LIFECYCLE.edges) {
      assert.ok(states.has(edge.from), `${edge.id} source exists`);
      assert.ok(states.has(edge.to), `${edge.id} destination exists`);
      assert.notEqual(edge.from, edge.to, `${edge.id} is not a self edge`);
      assert.ok(actors.has(edge.actor), `${edge.id} actor exists`);
      assert.ok(mutationClasses.has(edge.mutationClass), `${edge.id} mutation class exists`);
      assert.ok(directions.has(edge.direction), `${edge.id} direction exists`);
      assert.ok(edge.preconditions.length > 0, `${edge.id} preconditions`);
      assert.ok(edge.durableEvidence.length > 0, `${edge.id} durable evidence`);
      assert.equal(edge.capability.required, true, `${edge.id} requires capability authority`);
      assert.ok(edge.capability.rule.length > 0, `${edge.id} capability rule`);
    }
    assert.deepEqual(
      new Set(LIFECYCLE.edges.map((edge) => edge.mutationClass)),
      mutationClasses,
      "every declared mutation class is used by at least one legal edge",
    );
  });

  it("forbids backward edges and makes release depend on commit or verified rollback", () => {
    const rank = Object.fromEntries(
      Object.entries(LIFECYCLE.states).map(([name, state]) => [name, state.forwardRank]),
    );
    for (const edge of LIFECYCLE.edges.filter((edge) => edge.direction === "forward")) {
      assert.ok(rank[edge.to] > rank[edge.from], `${edge.id} moves forward`);
    }
    for (const edge of LIFECYCLE.edges.filter((edge) => edge.to === "released")) {
      assert.ok(["candidate-committed", "rollback-verified"].includes(edge.from));
      assert.equal(edge.mutationClass, "atomic-release");
    }
    assert.deepEqual(
      LIFECYCLE.edges.filter((edge) => edge.to === "released").map((edge) => edge.from),
      ["candidate-committed", "rollback-verified"],
    );
    assert.equal(
      LIFECYCLE.edges.some((edge) => edge.from === "unrecoverable-blocked"),
      false,
    );
    for (const state of Object.keys(LIFECYCLE.states).filter(
      (name) => !["idle", "released", "unrecoverable-blocked"].includes(name),
    )) {
      assert.ok(
        LIFECYCLE.edges.some(
          (edge) => edge.from === state && edge.to === "unrecoverable-blocked",
        ),
        `${state} has an explicit fail-closed terminal edge`,
      );
    }
  });

  it("requires the complete candidate evidence set and current authority before commit", () => {
    assert.equal(TERMINAL_PROTOCOL.status, "target-only");
    assert.equal(TERMINAL_PROTOCOL.productionWired, false);
    assert.equal(TERMINAL_PROTOCOL.candidateCommit.fromState, "readiness-verified");
    assert.equal(TERMINAL_PROTOCOL.candidateCommit.toState, "candidate-committed");
    assert.deepEqual(TERMINAL_PROTOCOL.candidateCommit.requiredDurableEvidence, [
      "complete-apply-journal", "topology-evidence", "readiness-evidence",
      "source-identities", "build-install-artifact-identities",
      "workflow-catalog-identities", "database-identity-and-schema",
    ]);
    assert.deepEqual(TERMINAL_PROTOCOL.candidateCommit.authorityReread, [
      "gate", "manifest", "current-authority-epoch", "capability-digest",
      "matching-secret-capability", "controller-immutable-identity",
    ]);
    assert.equal(TERMINAL_PROTOCOL.candidateCommit.allEvidenceRequired, true);
    assert.deepEqual(TERMINAL_PROTOCOL.candidateCommit.recordSchema, {
      storage: "manifest.terminal-record",
      schemaIdentifier: "tamandua.upgx.candidate-commit-record/v1",
      schemaVersion: 1,
      maximumBytes: 32768,
      unknownFields: "reject",
    });
    assert.equal(TERMINAL_PROTOCOL.candidateCommit.partialOrStaleDisposition, "authenticated-permanent-block-preserve-gate");
  });

  it("makes rollback verification exact and total over original topology intent", () => {
    const rollback = TERMINAL_PROTOCOL.rollbackVerification;
    assert.equal(rollback.fromState, "rollback-in-progress");
    assert.equal(rollback.toState, "rollback-verified");
    assert.equal(rollback.snapshotRestoration, "byte-and-metadata-exact-for-every-inventory-record");
    assert.deepEqual(rollback.requiredRestorationDomains, ARTIFACT_CONTRACT.restorationDomains);
    assert.deepEqual(rollback.intendedRunningPredicates, READINESS_CONTRACT.runningPredicateOrder);
    assert.deepEqual(rollback.intendedStoppedPredicates, READINESS_CONTRACT.absencePredicateOrder);
    assert.deepEqual(rollback.additionalPredicates, [
      "original-source-identity-match", "original-build-install-and-symlink-hashes-match",
      "original-workflow-catalog-identity-match", "original-database-identity-and-schema-match",
      "original-topology-and-hosting-mode-match", "duplicate-listener-and-process-exclusion",
    ]);
    assert.equal(rollback.allEvidenceRequired, true);
    assert.deepEqual(rollback.recordSchema, {
      storage: "manifest.terminal-record",
      schemaIdentifier: "tamandua.upgx.rollback-verification-record/v1",
      schemaVersion: 1,
      maximumBytes: 32768,
      unknownFields: "reject",
    });
    assert.equal(rollback.anyMismatchDisposition, "authenticated-permanent-block-preserve-gate-and-rollback-journal");
  });

  it("makes release paths dominated by commit or verified rollback", () => {
    assert.deepEqual(Object.keys(TERMINAL_PROTOCOL.terminalDispositions), [
      "candidate-committed", "rollback-verified",
    ]);
    assert.deepEqual(TERMINAL_PROTOCOL.release.allowedSourceStates, [
      "candidate-committed", "rollback-verified",
    ]);
    assert.deepEqual(
      LIFECYCLE.edges.filter((edge) => edge.to === "released").map((edge) => edge.from),
      TERMINAL_PROTOCOL.release.allowedSourceStates,
    );
    assert.equal(TERMINAL_PROTOCOL.release.readinessOrRollbackBypassAllowed, false);
  });

  it("pins one atomic release transaction after durable audit and final re-read", () => {
    const release = TERMINAL_PROTOCOL.release;
    assert.deepEqual(release.preTransactionSteps, [
      "publish-immutable-redacted-completion-audit", "fsync-completion-audit",
      "fsync-completion-directory", "reopen-and-verify-completion-audit",
    ]);
    assert.deepEqual(release.atomicDatabaseTransaction, [
      "begin-immediate", "re-read-gate-manifest-terminal-evidence-and-completion-audit-digests",
      "verify-current-authority-epoch-controller-identity-and-matching-capability",
      "insert-immutable-release-ledger-record", "remove-work-admission-blocking-triggers",
      "delete-active-gate-row", "commit",
    ]);
    assert.equal(release.blockersRemovedOutsideTransaction, false);
    assert.equal(release.crashBeforeCommit, "database-rollback-preserves-all-blockers-and-authenticated-reentry-repeats-final-reread");
    assert.equal(release.crashAfterCommit, "release-ledger-and-gate-absence-prove-release-idempotently-without-recreating-authority");
  });

  it("pins an acyclic terminal publication order with the ledger binding the finalized audit", () => {
    const release = TERMINAL_PROTOCOL.release;
    assert.deepEqual(release.publicationOrder, [
      "terminal-evidence-set", "completion-release-intent", "completion-audit",
      "release-ledger", "blocking-authority-removal",
    ]);
    assert.deepEqual(Object.keys(release.publicationDependencies), release.publicationOrder);

    const published = new Set<string>();
    for (const item of release.publicationOrder) {
      for (const dependency of release.publicationDependencies[item]) {
        assert.ok(published.has(dependency), `${item} depends only on an earlier publication: ${dependency}`);
      }
      published.add(item);
    }

    assert.ok(TERMINAL_PROTOCOL.audit.releaseIntent.forbiddenFields.includes("completion-audit-sha256"));
    assert.ok(release.releaseLedger.fields.includes("completion-audit-sha256"));
    assert.ok(release.releaseLedger.fields.includes("release-intent-sha256"));
    assert.ok(TERMINAL_PROTOCOL.audit.requiredFields.includes("release-intent"));
    assert.equal(TERMINAL_PROTOCOL.audit.requiredFields.includes("release-record"), false);
  });

  it("retains a redacted immutable audit and keeps unverifiable outcomes blocked", () => {
    const audit = TERMINAL_PROTOCOL.audit;
    assert.equal(audit.artifact, ARTIFACT_CONTRACT.artifacts.completionAudit.path);
    assert.equal(audit.retention, "indefinite-never-garbage-collected");
    assert.equal(audit.immutableAfterPublication, true);
    assert.deepEqual(audit.forbiddenSecretFields, ARTIFACT_CONTRACT.schemas.completionAudit.forbiddenFields);
    assert.deepEqual(audit.requiredFields, ARTIFACT_CONTRACT.schemas.completionAudit.requiredFields);
    assert.deepEqual(audit.terminalDispositions, ["candidate-committed", "rollback-verified"]);

    const blocked = TERMINAL_PROTOCOL.unverifiableOutcome;
    assert.equal(blocked.state, "unrecoverable-blocked");
    assert.equal(blocked.gateAndBlockersPreserved, true);
    assert.equal(blocked.newWorkAllowed, false);
    assert.equal(blocked.recoveryAction, "tamandua-update-recover-authenticated-deterministic-verify");
    assert.equal(blocked.operatorMayForceReleaseOrChooseDisposition, false);
  });

  it("declares every pre-handoff and build fault boundary exactly once", () => {
    const expected = [
      "before-gate-acquisition", "after-gate-acquisition", "guardian-spawn",
      "guardian-positive-handshake", "guardian-authority-record",
      "owner-escape-result", "legacy-post-build-continuation-defense",
      "legacy-owner-exit", "build-dependency-install", "build-compilation",
      "build-artifact-publication", "symlink-install",
    ];
    const boundaries = FAULT_CONTRACT.preHandoffAndBuild.boundaries as FaultBoundary[];
    assert.deepEqual(FAULT_CONTRACT.preHandoffAndBuild.boundaryOrder, expected);
    assert.deepEqual(boundaries.map((boundary) => boundary.id), expected);
    assert.equal(new Set(boundaries.map((boundary) => boundary.id)).size, expected.length);
    assert.deepEqual(new Set(boundaries.map((boundary) => boundary.group)), new Set(["pre-handoff", "build"]));
  });

  it("makes every pre-handoff and build fault disposition operationally total", () => {
    const actors = new Set(Object.keys(ACTORS));
    const states = new Set(Object.keys(LIFECYCLE.states));
    const dispositions = new Set(["deterministic-forward-recovery", "mandatory-rollback", "authenticated-permanent-block"]);
    for (const boundary of FAULT_CONTRACT.preHandoffAndBuild.boundaries as FaultBoundary[]) {
      assert.ok(states.has(boundary.lifecycleState), `${boundary.id} lifecycle state`);
      assert.ok(boundary.durableEvidence.length > 0, `${boundary.id} durable evidence`);
      assert.ok(boundary.detector.length > 0, `${boundary.id} detector`);
      assert.ok(actors.has(boundary.authorizedNextActor), `${boundary.id} authorized actor`);
      assert.ok(boundary.requiredAuthority.length > 0, `${boundary.id} authority`);
      assert.ok(boundary.idempotence.length > 0, `${boundary.id} idempotence`);
      assert.equal(boundary.disposition, "fault-class-mapped-deterministically", `${boundary.id} disposition`);
      assert.ok(boundary.nextAction.length > 0, `${boundary.id} next action`);
      assert.ok(boundary.workAdmission.length > 0, `${boundary.id} work admission`);
      assert.ok(boundary.serviceAdmission.length > 0, `${boundary.id} service admission`);
      assert.ok(boundary.userVisibleResult.length > 0, `${boundary.id} user result`);
      assert.ok(boundary.releaseCondition.length > 0, `${boundary.id} release condition`);
      assert.ok(boundary.faultClasses.length > 0, `${boundary.id} fault classes`);
      assert.deepEqual(Object.keys(boundary.faultDispositionByClass), boundary.faultClasses, `${boundary.id} fault mapping`);
      for (const [fault, rule] of Object.entries(boundary.faultDispositionByClass)) {
        assert.ok(dispositions.has(rule.disposition), `${boundary.id}/${fault} disposition`);
        assert.ok(rule.nextAction.length > 0, `${boundary.id}/${fault} next action`);
        assert.ok(rule.releaseCondition.length > 0, `${boundary.id}/${fault} release condition`);
      }
    }
  });

  it("covers required process, host, source, resource, database, and evidence faults deterministically", () => {
    const requiredFaults = [
      "guardian-death", "candidate-coordinator-death", "recovery-coordinator-death",
      "sigkill", "power-loss", "source-checkout-movement", "insufficient-disk",
      "insufficient-permissions", "sqlite-busy", "sqlite-io-error",
      "malformed-or-partial-evidence",
    ];
    assert.deepEqual(FAULT_CONTRACT.preHandoffAndBuild.faultClasses, requiredFaults);
    const covered = new Set(
      (FAULT_CONTRACT.preHandoffAndBuild.boundaries as FaultBoundary[])
        .flatMap((boundary) => boundary.faultClasses),
    );
    assert.deepEqual(covered, new Set(requiredFaults));

    const requiredProcessDeathsByBoundary: Record<string, string[]> = {
      "before-gate-acquisition": ["candidate-coordinator-death"],
      "after-gate-acquisition": ["candidate-coordinator-death", "recovery-coordinator-death"],
      "guardian-spawn": ["guardian-death", "candidate-coordinator-death", "recovery-coordinator-death"],
      "guardian-positive-handshake": ["guardian-death", "candidate-coordinator-death", "recovery-coordinator-death"],
      "guardian-authority-record": ["guardian-death", "candidate-coordinator-death", "recovery-coordinator-death"],
      "owner-escape-result": ["guardian-death", "candidate-coordinator-death", "recovery-coordinator-death"],
      "legacy-post-build-continuation-defense": ["guardian-death", "recovery-coordinator-death"],
      "legacy-owner-exit": ["guardian-death", "recovery-coordinator-death"],
      "build-dependency-install": ["guardian-death", "recovery-coordinator-death"],
      "build-compilation": ["guardian-death", "recovery-coordinator-death"],
      "build-artifact-publication": ["guardian-death", "recovery-coordinator-death"],
      "symlink-install": ["guardian-death", "recovery-coordinator-death"],
    };
    for (const boundary of FAULT_CONTRACT.preHandoffAndBuild.boundaries as FaultBoundary[]) {
      const requiredProcessDeaths = requiredProcessDeathsByBoundary[boundary.id];
      assert.ok(requiredProcessDeaths, `${boundary.id} has an explicit process-death requirement`);
      for (const faultClass of requiredProcessDeaths) {
        assert.ok(boundary.faultClasses.includes(faultClass), `${boundary.id} covers ${faultClass}`);
        assert.ok(boundary.faultDispositionByClass[faultClass], `${boundary.id} maps ${faultClass}`);
      }
    }
  });

  it("forbids mutation before positive guardian handshake and old-code continuation", () => {
    const boundaries = FAULT_CONTRACT.preHandoffAndBuild.boundaries as FaultBoundary[];
    const handshakeIndex = FAULT_CONTRACT.preHandoffAndBuild.boundaryOrder.indexOf("guardian-positive-handshake");
    for (const boundary of boundaries.slice(0, handshakeIndex + 1)) {
      assert.equal(boundary.mutationAllowed, false, `${boundary.id} cannot mutate`);
    }
    for (const boundary of boundaries.filter((candidate) => candidate.mutationAllowed)) {
      assert.equal(boundary.positiveGuardianHandshakeRequired, true, `${boundary.id} requires handshake`);
      assert.ok(["snapshot-ready", "applying"].includes(boundary.lifecycleState), `${boundary.id} is post-snapshot`);
    }
    for (const boundary of boundaries) {
      assert.equal(boundary.immutableLegacyPostBuildPath, "must-not-continue");
    }
    assert.equal(FAULT_CONTRACT.preHandoffAndBuild.ownerEscape.successResult, CONTROL_FLOW.paths.legacy.escape.exitCode);
    assert.equal(FAULT_CONTRACT.preHandoffAndBuild.ownerEscape.immutableUpdaterEffect, "run-command-rejects-before-old-post-build-path");
  });

  it("never permits best-effort or ownerless pre-handoff/build recovery", () => {
    const serialized = JSON.stringify(FAULT_CONTRACT.preHandoffAndBuild);
    assert.doesNotMatch(serialized, /best[- ]?effort/i);
    assert.doesNotMatch(serialized, /ownerless/i);
    for (const boundary of FAULT_CONTRACT.preHandoffAndBuild.boundaries as FaultBoundary[]) {
      assert.notEqual(boundary.authorizedNextActor, "none", `${boundary.id} remains owned`);
      assert.notEqual(boundary.requiredAuthority, "none", `${boundary.id} has authority`);
    }
  });

  it("declares every mutation, topology service, readiness, commit, and release boundary exactly once", () => {
    const expected = [
      "snapshot-creation",
      "source-checkout-mutation", "installed-artifact-mutation", "database-schema-mutation",
      "catalog-mutation", "workflow-mutation",
      "legacy-mcp-service-stop", "legacy-control-plane-service-stop", "legacy-dashboard-daemon-stop",
      "legacy-dashboard-daemon-start", "legacy-control-plane-service-start", "legacy-mcp-service-start",
      "current-mcp-service-stop", "current-dashboard-standalone-stop", "current-daemon-stop",
      "current-daemon-start", "current-dashboard-standalone-start", "current-mcp-service-start",
      "topology-restoration-evidence", "readiness-verification", "candidate-commit-record", "atomic-release",
    ];
    const section = FAULT_CONTRACT.mutationServiceAndRelease;
    const boundaries = section.boundaries as FaultBoundary[];
    assert.deepEqual(section.boundaryOrder, expected);
    assert.deepEqual(boundaries.map((boundary) => boundary.id), expected);
    const allIds = [
      ...(FAULT_CONTRACT.preHandoffAndBuild.boundaries as FaultBoundary[]),
      ...boundaries,
    ].map((boundary) => boundary.id);
    assert.equal(new Set(allIds).size, allIds.length, "a fault boundary appears in exactly one matrix row");
  });

  it("covers every destructive mutation class and topology process-unit stop/start", () => {
    const allBoundaries = [
      ...(FAULT_CONTRACT.preHandoffAndBuild.boundaries as FaultBoundary[]),
      ...(FAULT_CONTRACT.mutationServiceAndRelease.boundaries as FaultBoundary[]),
    ];
    const expectedMutationBoundaries = {
      "snapshot-publication": "snapshot-creation",
      "dependency-install": "build-dependency-install",
      compilation: "build-compilation",
      "build-artifact-publication": "build-artifact-publication",
      "install-symlink": "symlink-install",
      "source-checkout": "source-checkout-mutation",
      "installed-artifacts": "installed-artifact-mutation",
      "database-schema": "database-schema-mutation",
      catalog: "catalog-mutation",
      workflows: "workflow-mutation",
    };
    assert.deepEqual(FAULT_CONTRACT.mutationServiceAndRelease.destructiveMutationBoundaries, expectedMutationBoundaries);
    for (const boundaryId of Object.values(expectedMutationBoundaries)) {
      assert.equal(allBoundaries.filter((boundary) => boundary.id === boundaryId).length, 1, boundaryId);
    }

    const section = FAULT_CONTRACT.mutationServiceAndRelease;
    for (const [topologyName, topology] of Object.entries(TOPOLOGIES) as Array<[string, any]>) {
      const processUnits = topology.restoration.processUnits.map((unit: { id: string }) => unit.id);
      assert.deepEqual(Object.keys(section.serviceBoundaries[topologyName]), processUnits);
      for (const unit of processUnits) {
        const pair = section.serviceBoundaries[topologyName][unit];
        assert.equal(pair.stop.endsWith("-stop"), true, `${topologyName}/${unit} stop`);
        assert.equal(pair.start.endsWith("-start"), true, `${topologyName}/${unit} start`);
        assert.equal(allBoundaries.filter((boundary) => boundary.id === pair.stop).length, 1, pair.stop);
        assert.equal(allBoundaries.filter((boundary) => boundary.id === pair.start).length, 1, pair.start);
      }
    }
  });

  it("makes publication timing and post-boundary process death dispositions total", () => {
    const dispositions = new Set(["deterministic-forward-recovery", "mandatory-rollback", "authenticated-permanent-block"]);
    const states = new Set(Object.keys(LIFECYCLE.states));
    const actors = new Set(Object.keys(ACTORS));
    for (const boundary of FAULT_CONTRACT.mutationServiceAndRelease.boundaries as FaultBoundary[]) {
      assert.ok(states.has(boundary.lifecycleState), `${boundary.id} lifecycle state`);
      assert.ok(boundary.durableEvidence.length > 0, `${boundary.id} durable evidence`);
      assert.ok(boundary.detector.length > 0, `${boundary.id} detector`);
      assert.ok(actors.has(boundary.authorizedNextActor), `${boundary.id} authorized next actor`);
      assert.ok(boundary.idempotence.length > 0, `${boundary.id} idempotence`);
      assert.ok(boundary.nextAction.length > 0, `${boundary.id} next action`);
      assert.ok(boundary.serviceAdmission.length > 0, `${boundary.id} service admission`);
      assert.ok(boundary.userVisibleResult.length > 0, `${boundary.id} user-visible result`);
      assert.ok(boundary.releaseCondition.length > 0, `${boundary.id} release condition`);
      assert.ok(boundary.publicationFailureDisposition, `${boundary.id} publication timing`);
      const publication = boundary.publicationFailureDisposition!;
      for (const phase of [publication.beforeDurablePublication, publication.afterDurablePublication]) {
        assert.ok(dispositions.has(phase.disposition), `${boundary.id} publication disposition`);
        assert.ok(phase.nextAction.length > 0, `${boundary.id} publication next action`);
        assert.ok(phase.releaseCondition.length > 0, `${boundary.id} publication release condition`);
      }
      for (const fault of ["guardian-death", "recovery-coordinator-death", "host-reboot", "pid-reuse"]) {
        assert.ok(boundary.faultClasses.includes(fault), `${boundary.id} covers ${fault}`);
        assert.ok(boundary.faultDispositionByClass[fault], `${boundary.id} maps ${fault}`);
      }
      assert.match(boundary.requiredAuthority, /authority-epoch.*secret-capability/);
      assert.equal(boundary.workAdmission, "blocked-by-active-gate");
    }
  });

  it("fails closed on topology disagreement and duplicates and preserves blockers across release failure", () => {
    const section = FAULT_CONTRACT.mutationServiceAndRelease;
    for (const id of ["topology-restoration-evidence", "readiness-verification", "candidate-commit-record", "atomic-release"]) {
      const boundary = (section.boundaries as FaultBoundary[]).find((candidate) => candidate.id === id)!;
      for (const fault of ["old-new-topology-disagreement", "duplicate-listener", "duplicate-process"]) {
        assert.ok(boundary.faultClasses.includes(fault), `${id} covers ${fault}`);
        assert.equal(boundary.faultDispositionByClass[fault].disposition, "authenticated-permanent-block");
      }
    }
    assert.equal(section.releaseFailure.blockersRemovedBeforeAtomicCommit, false);
    assert.equal(section.releaseFailure.terminalDispositionPreserved, true);
    assert.equal(section.releaseFailure.crashBeforeCommit, TERMINAL_PROTOCOL.release.crashBeforeCommit);
    assert.equal(section.releaseFailure.crashAfterCommit, TERMINAL_PROTOCOL.release.crashAfterCommit);
    assert.deepEqual(section.releaseFailure.allowedTerminalDispositions, TERMINAL_PROTOCOL.release.allowedSourceStates);
  });

  it("declares rollback start, every inventory restore class, verification, and completion exactly once", () => {
    const restorationDomains = TERMINAL_PROTOCOL.rollbackVerification.requiredRestorationDomains as string[];
    const expected = [
      "rollback-start",
      ...restorationDomains.map((domain) => `rollback-restore-${domain}`),
      "rollback-verification", "rollback-completion",
    ];
    const section = FAULT_CONTRACT.rollbackAndRecovery;
    const boundaries = section.boundaries as FaultBoundary[];
    assert.deepEqual(section.boundaryOrder, expected);
    assert.deepEqual(boundaries.map((boundary) => boundary.id), expected);
    assert.deepEqual(
      section.restoreActionBoundaries,
      Object.fromEntries(restorationDomains.map((domain) => [domain, `rollback-restore-${domain}`])),
    );

    const allIds = [
      ...(FAULT_CONTRACT.preHandoffAndBuild.boundaries as FaultBoundary[]),
      ...(FAULT_CONTRACT.mutationServiceAndRelease.boundaries as FaultBoundary[]),
      ...boundaries,
    ].map((boundary) => boundary.id);
    assert.equal(new Set(allIds).size, allIds.length, "every fault boundary appears in exactly one row");
  });

  it("makes every rollback and recovery fault row operationally total at process-death boundaries", () => {
    const actors = new Set(Object.keys(ACTORS));
    const states = new Set(Object.keys(LIFECYCLE.states));
    for (const boundary of FAULT_CONTRACT.rollbackAndRecovery.boundaries as FaultBoundary[]) {
      assert.ok(states.has(boundary.lifecycleState), `${boundary.id} lifecycle state`);
      assert.ok(boundary.durableEvidence.length > 0, `${boundary.id} durable evidence`);
      assert.ok(boundary.detector.length > 0, `${boundary.id} detector`);
      assert.ok(actors.has(boundary.authorizedNextActor), `${boundary.id} authorized actor`);
      assert.ok(boundary.requiredAuthority.length > 0, `${boundary.id} authority`);
      assert.ok(boundary.nextAction.length > 0, `${boundary.id} next action`);
      assert.ok(boundary.workAdmission.length > 0, `${boundary.id} work admission`);
      assert.ok(boundary.serviceAdmission.length > 0, `${boundary.id} service admission`);
      assert.ok(boundary.userVisibleResult.length > 0, `${boundary.id} public result`);
      assert.ok(boundary.releaseCondition.length > 0, `${boundary.id} release condition`);
      for (const fault of ["guardian-death", "recovery-coordinator-death", "sigkill", "power-loss", "host-reboot"]) {
        assert.ok(boundary.faultClasses.includes(fault), `${boundary.id} covers ${fault}`);
        assert.ok(boundary.faultDispositionByClass[fault], `${boundary.id} maps ${fault}`);
      }
    }
  });

  it("journals every rollback restore action before and after execution with exact replay rules", () => {
    const section = FAULT_CONTRACT.rollbackAndRecovery;
    const boundaries = section.boundaries as Array<FaultBoundary & {
      restoreDomain?: string;
      journalProtocol?: {
        beforeExecution: string[];
        afterExecution: string[];
        replayClassification: Record<string, string>;
      };
    }>;
    for (const [domain, boundaryId] of Object.entries(section.restoreActionBoundaries)) {
      const boundary = boundaries.find((candidate) => candidate.id === boundaryId)!;
      assert.equal(boundary.restoreDomain, domain);
      assert.ok(boundary.journalProtocol);
      assert.ok(boundary.journalProtocol!.beforeExecution.length > 0, `${domain} before journal`);
      assert.ok(boundary.journalProtocol!.afterExecution.length > 0, `${domain} after journal`);
      assert.deepEqual(Object.keys(boundary.journalProtocol!.replayClassification), [
        "no-before-record", "before-without-after", "after-without-verified", "verified",
        "missing-malformed-or-conflicting",
      ]);
      assert.match(boundary.journalProtocol!.replayClassification["before-without-after"], /snapshot/);
      assert.match(boundary.journalProtocol!.replayClassification["after-without-verified"], /verify/);
      assert.match(boundary.journalProtocol!.replayClassification.verified, /skip/);
      assert.match(boundary.journalProtocol!.replayClassification["missing-malformed-or-conflicting"], /permanent-block/);
    }
  });

  it("routes automatic rollback uncertainty only to authenticated deterministic recovery", () => {
    const section = FAULT_CONTRACT.rollbackAndRecovery;
    assert.equal(section.uncertaintyDisposition.state, "unrecoverable-blocked");
    assert.equal(section.uncertaintyDisposition.recoveryAction, TERMINAL_PROTOCOL.unverifiableOutcome.recoveryAction);
    assert.equal(section.uncertaintyDisposition.authenticatedOperatorRequired, true);
    assert.equal(section.uncertaintyDisposition.gateAndAdmissionBlockersPreserved, true);
    assert.equal(section.uncertaintyDisposition.destructiveAdoptionAllowed, false);
    assert.equal(section.uncertaintyDisposition.silentCleanupAllowed, false);
    assert.equal(section.uncertaintyDisposition.forceAllowed, false);
    assert.equal(section.uncertaintyDisposition.releaseBeforeDeterministicVerification, false);
    assert.doesNotMatch(JSON.stringify(section), /best[- ]?effort/i);
  });

  it("keeps the implemented foundation graph separate from the target lifecycle", () => {
    const implemented = LIFECYCLE.implementedFoundation;
    assert.equal(implemented.status, "implemented-foundation");
    assert.equal(implemented.productionWired, false);
    assert.deepEqual(implemented.states, ["ACQUIRED", "GUARDIAN_RECORDED", "FAILED"]);
    assert.deepEqual(implemented.edges, [
      { id: "record-guardian-cas", from: "ACQUIRED", to: "GUARDIAN_RECORDED" },
      { id: "fail-from-acquired", from: "ACQUIRED", to: "FAILED" },
      { id: "fail-from-guardian-recorded", from: "GUARDIAN_RECORDED", to: "FAILED" },
    ]);
    assert.equal(
      implemented.states.some((state: string) => Object.keys(LIFECYCLE.states).includes(state)),
      false,
    );
    assert.deepEqual(implemented.states, IMPLEMENTATION.foundation.phases);
  });

  it("defines a total actor and authority policy for every lifecycle state", () => {
    const stateNames = Object.keys(LIFECYCLE.states);
    const actorNames = Object.keys(ACTORS);
    assert.deepEqual(Object.keys(LIFECYCLE.statePolicies), stateNames);

    for (const [state, policy] of Object.entries(LIFECYCLE.statePolicies) as Array<[string, LifecycleStatePolicy]>) {
      assert.equal(new Set(policy.permittedWriters).size, policy.permittedWriters.length, `${state} writer uniqueness`);
      assert.ok(policy.forbiddenActors.length > 0, `${state} has forbidden actors`);
      assert.deepEqual(
        new Set([...policy.permittedWriters, ...policy.forbiddenActors]),
        new Set(actorNames),
        `${state} classifies every actor`,
      );
      assert.equal(
        policy.permittedWriters.some((actor: string) => policy.forbiddenActors.includes(actor)),
        false,
        `${state} writer and forbidden sets are disjoint`,
      );
      assert.ok(policy.requiredCapability.length > 0, `${state} capability disposition`);
      assert.ok(policy.requiredImmutableIdentities.length > 0, `${state} identity disposition`);
      for (const edge of lifecycleEdges.filter((candidate) => candidate.from === state)) {
        assert.ok(policy.permittedWriters.includes(edge.actor), `${edge.id} actor may write ${state}`);
      }
    }
  });

  it("makes evidence, replay, crash recovery, and admission policy total for every lifecycle state", () => {
    for (const [state, policy] of Object.entries(LIFECYCLE.statePolicies) as Array<[string, LifecycleStatePolicy]>) {
      assert.ok(policy.entryPreconditions.length > 0, `${state} entry preconditions`);
      assert.ok(policy.durableEvidence.length > 0, `${state} durable evidence`);
      assert.ok(policy.idempotentReplay.length > 0, `${state} replay result`);
      assert.ok(policy.crashReentryDisposition.length > 0, `${state} crash disposition`);
      assert.ok(policy.workAndServices.newWork.length > 0, `${state} work admission`);
      assert.ok(policy.workAndServices.services.length > 0, `${state} services policy`);

      const expectedOutgoing = lifecycleEdges
        .filter((edge) => edge.from === state)
        .map((edge) => edge.id);
      assert.deepEqual(policy.outgoingTransitions, expectedOutgoing, `${state} exact outgoing edges`);
    }
  });

  it("requires jointly consistent gate, manifest, artifacts, and observations", () => {
    const consistency = LIFECYCLE.evidenceConsistency;
    assert.deepEqual(consistency.authoritativePeers, ["gate", "manifest", "phase-artifacts"]);
    assert.deepEqual(consistency.observationalPeers, ["process-identities", "service-observations"]);
    assert.equal(consistency.anySinglePeerSufficient, false);
    assert.equal(consistency.dbGateAloneSufficient, false);
    assert.equal(consistency.manifestAloneSufficient, false);
    assert.equal(consistency.artifactAloneSufficient, false);
    assert.equal(consistency.processObservationAloneSufficient, false);
    assert.equal(consistency.serviceObservationAloneSufficient, false);
    assert.equal(consistency.precedence, "joint-durable-consistency-before-observation");
  });

  it("fails closed for every partial or hybrid disagreement without adoption or repair", () => {
    const requiredCases = [
      "missing-peer", "partial-peer", "malformed-peer", "stale-peer", "hybrid-phase",
      "gate-manifest-disagreement", "artifact-phase-disagreement", "process-identity-disagreement",
      "service-observation-disagreement",
    ];
    assert.deepEqual(Object.keys(LIFECYCLE.evidenceConsistency.disagreements), requiredCases);
    for (const [name, disposition] of Object.entries(LIFECYCLE.evidenceConsistency.disagreements) as Array<[string, DisagreementDisposition]>) {
      assert.equal(disposition.result, "fail-closed-preserve-gate", `${name} result`);
      assert.equal(disposition.preserveGate, true, `${name} gate`);
      assert.equal(disposition.allowNewWork, false, `${name} work`);
      assert.equal(disposition.destructiveRepair, false, `${name} repair`);
      assert.equal(disposition.adoptObservedState, false, `${name} adoption`);
      assert.ok(disposition.nextAction.length > 0, `${name} next action`);
    }
  });

  it("assigns every durable artifact one versioned canonical path and policy", () => {
    assert.equal(ARTIFACT_CONTRACT.status, "target-only");
    assert.equal(ARTIFACT_CONTRACT.productionWired, false);
    assert.equal(ARTIFACT_CONTRACT.compatibilityPolicy, COMPATIBILITY_POLICY.identifier);
    assert.equal(ARTIFACT_CONTRACT.stateRoot.mode, "0700");
    assert.equal(ARTIFACT_CONTRACT.transactionDirectory.path, "update-transactions/{publicTransactionId}");
    assert.equal(ARTIFACT_CONTRACT.transactionDirectory.mode, "0700");

    const requiredArtifacts = [
      "manifest", "snapshotInventory", "snapshotObject", "applyJournal",
      "rollbackJournal", "topologyEvidence", "readinessEvidence",
      "completionAudit", "retainedCapability",
    ];
    assert.deepEqual(Object.keys(ARTIFACT_CONTRACT.artifacts), requiredArtifacts);
    const artifacts = Object.values(ARTIFACT_CONTRACT.artifacts) as DurableArtifact[];
    assert.equal(new Set(artifacts.map((artifact) => artifact.path)).size, artifacts.length);
    assert.equal(new Set(artifacts.map((artifact) => artifact.schemaIdentifier)).size, artifacts.length);
    for (const [name, artifact] of Object.entries(ARTIFACT_CONTRACT.artifacts) as Array<[string, DurableArtifact]>) {
      assert.match(artifact.path, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9{}._/-]+$/u, `${name} safe relative path`);
      assert.match(artifact.schemaIdentifier, /^tamandua\.upgx\.[a-z][a-z0-9-]*\/v1$/);
      assert.equal(artifact.schemaVersion, 1, `${name} schema version`);
      assert.ok(Number.isSafeInteger(artifact.maximumBytes) && artifact.maximumBytes > 0, `${name} size bound`);
      assert.match(artifact.mode, /^0[0-7]{3}$/);
      assert.ok(artifact.writers.length > 0, `${name} writers`);
      assert.ok(artifact.requiredStates.length > 0, `${name} required states`);
      assert.ok(artifact.writers.every((writer) => Object.hasOwn(ACTORS, writer)), `${name} writer references`);
      assert.ok(artifact.requiredStates.every((state) => Object.hasOwn(LIFECYCLE.states, state)), `${name} state references`);
      assert.ok(artifact.retention.length > 0, `${name} retention`);
      assert.ok(artifact.content.length > 0, `${name} content encoding`);
      assert.ok(Object.hasOwn(ARTIFACT_CONTRACT.schemas, artifact.schemaDefinition), `${name} schema definition`);
    }
  });

  it("versions and bounds the transaction directory and every artifact schema", () => {
    const transactionDirectory = ARTIFACT_CONTRACT.transactionDirectory;
    assert.equal(transactionDirectory.contractIdentifier, "tamandua.upgx.transaction-directory/v1");
    assert.equal(transactionDirectory.contractVersion, 1);
    assert.ok(transactionDirectory.maximumPathBytes > 0);
    assert.ok(transactionDirectory.maximumEntries > 0);
    assert.ok(transactionDirectory.writers.every((writer: string) => Object.hasOwn(ACTORS, writer)));
    assert.ok(transactionDirectory.requiredStates.every((state: string) => Object.hasOwn(LIFECYCLE.states, state)));
    assert.ok(transactionDirectory.retention.length > 0);

    const artifactEntries = Object.entries(ARTIFACT_CONTRACT.artifacts) as Array<[string, DurableArtifact]>;
    const expectedSchemas = artifactEntries.map(([, artifact]) => artifact.schemaDefinition);
    assert.equal(new Set(expectedSchemas).size, expectedSchemas.length);
    assert.deepEqual(Object.keys(ARTIFACT_CONTRACT.schemas), expectedSchemas);
    for (const [name, schema] of Object.entries(ARTIFACT_CONTRACT.schemas)) {
      assert.ok(schema.requiredFields.length > 0, `${name} required fields`);
      assert.ok(schema.fieldBounds.length > 0, `${name} field bounds`);
      assert.ok(
        schema.fieldBounds.every((bound: string) => /-(?:bytes|entries|value)-max-\d+$/u.test(bound)),
        `${name} concrete bounds`,
      );
    }
  });

  it("pins canonical JSON and crash-durable same-filesystem publication ordering", () => {
    const json = ARTIFACT_CONTRACT.canonicalJson;
    assert.equal(json.encoding, "utf-8");
    assert.equal(json.bomAllowed, false);
    assert.equal(json.trailingNewline, "exactly-one-lf");
    assert.equal(json.stringNormalization, "unicode-nfc");
    assert.equal(json.objectKeyOrder, "top-level-schema-identifier-then-schema-version-then-ascending-unicode-code-point-after-nfc");
    assert.equal(json.nestedObjectKeyOrder, "ascending-unicode-code-point-after-nfc");
    assert.equal(json.duplicateKeysAfterNormalization, "reject");
    assert.equal(json.unboundedValuesAllowed, false);

    assert.deepEqual(ARTIFACT_CONTRACT.atomicPublication.steps, [
      "validate-owner-modes-no-links-and-same-filesystem",
      "serialize-and-bound-canonical-content",
      "open-exclusive-same-directory-temporary-file",
      "set-and-verify-exact-file-mode-and-owner",
      "write-all-bytes-and-reject-short-write",
      "fsync-temporary-file",
      "close-temporary-file",
      "atomic-rename-temporary-over-canonical-path",
      "fsync-containing-directory",
      "reopen-and-verify-schema-version-size-mode-owner-and-digest",
    ]);
    assert.equal(ARTIFACT_CONTRACT.atomicPublication.temporaryFile.sameDirectory, true);
    assert.equal(ARTIFACT_CONTRACT.atomicPublication.rename.mustBeAtomic, true);
    assert.equal(ARTIFACT_CONTRACT.atomicPublication.crossFilesystem.allowed, false);
    assert.equal(ARTIFACT_CONTRACT.atomicPublication.crossFilesystem.exdevDisposition, "fail-closed-preserve-gate-and-source");
  });

  it("makes snapshot and mutation inventories total over every restoration domain", () => {
    const requiredDomains = [
      "source-identities", "build-install-artifacts", "install-symlink-artifacts",
      "workflow-catalog-state", "database-schema-state", "service-topology",
      "service-endpoints", "process-immutable-identities", "original-service-intent",
    ];
    assert.deepEqual(ARTIFACT_CONTRACT.restorationDomains, requiredDomains);
    assert.deepEqual(ARTIFACT_CONTRACT.schemas.snapshotInventory.requiredDomains, requiredDomains);
    assert.deepEqual(ARTIFACT_CONTRACT.schemas.applyJournal.requiredDomains, requiredDomains);
    assert.deepEqual(ARTIFACT_CONTRACT.schemas.rollbackJournal.requiredDomains, requiredDomains);
    assert.deepEqual(ARTIFACT_CONTRACT.schemas.snapshotInventory.originalIntentValues, ["running", "stopped"]);
    assert.deepEqual(ARTIFACT_CONTRACT.schemas.applyJournal.boundaryRecordOrder, ["intent", "before", "action", "after", "verified"]);
    assert.deepEqual(ARTIFACT_CONTRACT.schemas.rollbackJournal.boundaryRecordOrder, ["intent", "before", "restore", "after", "verified"]);
  });

  it("defines complete schemas for source, artifacts, catalog, database, and services", () => {
    const inventory = ARTIFACT_CONTRACT.schemas.snapshotInventory;
    assert.deepEqual(inventory.sourceIdentityFields, [
      "source-before-commit", "source-after-pull-commit", "candidate-commit", "checkout-device", "checkout-path-digest",
    ]);
    assert.deepEqual(inventory.installArtifactFields, [
      "relative-path", "kind", "sha256", "size", "mode", "uid", "gid", "symlink-target", "source-version",
    ]);
    assert.deepEqual(inventory.catalogFields, ["catalog-version", "workflow-versions", "catalog-stamp-sha256", "installed-files"]);
    assert.deepEqual(inventory.databaseFields, ["database-identity", "schema-version", "schema-sha256", "snapshot-object-sha256", "journal-mode"]);
    assert.deepEqual(inventory.serviceFields, [
      "topology-identifier", "topology-version", "role", "original-intent", "endpoint", "port", "pid", "immutable-identity", "build-identity",
    ]);
    assert.equal(inventory.hashAlgorithm, "sha256");
  });

  it("fails closed non-destructively for every unsafe artifact class", () => {
    const expected = [
      "unknown", "stale", "partial", "malformed", "permission-unsafe",
      "case-conflicting", "symlink-or-hardlink", "cross-filesystem", "oversized",
    ];
    assert.deepEqual(Object.keys(ARTIFACT_CONTRACT.unsafeArtifacts), expected);
    for (const [name, rule] of Object.entries(ARTIFACT_CONTRACT.unsafeArtifacts) as Array<[string, UnsafeArtifactRule]>) {
      assert.equal(rule.disposition, "fail-closed-preserve-gate", `${name} disposition`);
      assert.equal(rule.destructiveRepair, false, `${name} repair`);
      assert.equal(rule.adoptObservedState, false, `${name} adoption`);
      assert.equal(rule.automaticCleanup, false, `${name} cleanup`);
      assert.ok(rule.recoveryAction.length > 0, `${name} recovery action`);
    }
    assert.equal(ARTIFACT_CONTRACT.cleanup.activeTransactionArtifactsRemoved, false);
    assert.equal(ARTIFACT_CONTRACT.cleanup.completionAuditRetained, true);
    assert.equal(ARTIFACT_CONTRACT.cleanup.staleTemporaryRequiresAuthenticatedRecovery, true);
  });

  it("defines each downstream implementation scope exactly once with total gates", () => {
    const expectedScopes = ["HARN", "ADMIT", "HAND", "TOPO", "RECV", "SNAP", "ROLL", "FAULT"];
    assert.deepEqual(DOWNSTREAM_SCOPES.scopeOrder, expectedScopes);
    assert.deepEqual(Object.keys(DOWNSTREAM_SCOPES.scopes), expectedScopes);
    assert.equal(new Set(DOWNSTREAM_SCOPES.scopeOrder).size, expectedScopes.length);
    const canonicalContractIdentifiers = new Set([
      ...flattenStrings(IDENTIFIERS),
      ...flattenStrings(VERSIONS),
    ]);

    for (const [name, scope] of Object.entries(DOWNSTREAM_SCOPES.scopes) as Array<[string, DownstreamScope]>) {
      assert.match(scope.identifier, /^tamandua\.upgx\.downstream\.[a-z]+$/u, `${name} identifier`);
      assert.equal(scope.status, "target-only", `${name} status`);
      for (const field of [
        "prerequisites", "obligations", "exclusions", "consumedContractSections",
        "requiredContractIdentifiers", "ownedProductionSurfaces", "blackBoxAcceptanceGates",
      ] as const) {
        assert.ok(scope[field].length > 0, `${name} ${field}`);
      }
      assert.equal(new Set(scope.consumedContractSections).size, scope.consumedContractSections.length, `${name} section uniqueness`);
      assert.equal(new Set(scope.requiredContractIdentifiers).size, scope.requiredContractIdentifiers.length, `${name} identifier uniqueness`);
      for (const section of scope.consumedContractSections) {
        assert.ok(Object.hasOwn(UPDATE_CONTRACT, section), `${name} consumes existing ${section}`);
      }
      for (const identifier of scope.requiredContractIdentifiers) {
        assert.ok(canonicalContractIdentifiers.has(identifier), `${name} requires declared ${identifier}`);
      }
    }
  });

  it("assigns every production surface once and every mutation to one downstream owner", () => {
    const surfaces = DOWNSTREAM_SCOPES.productionSurfaceOwnership;
    const surfaceIds = Object.keys(surfaces);
    assert.ok(surfaceIds.length > 0);
    assert.equal(new Set(surfaceIds).size, surfaceIds.length);

    for (const [surfaceId, surface] of Object.entries(surfaces) as Array<[string, ProductionSurfaceOwnership]>) {
      assert.match(surfaceId, /^[a-z][a-z0-9-]*$/u);
      assert.ok(DOWNSTREAM_SCOPES.scopeOrder.includes(surface.owner), `${surfaceId} owner exists`);
      assert.ok(surface.productionSurfaces.length > 0, `${surfaceId} surfaces`);
      assert.ok(surface.ownershipRule.length > 0, `${surfaceId} ownership rule`);
      assert.ok(
        (DOWNSTREAM_SCOPES.scopes[surface.owner] as DownstreamScope).ownedProductionSurfaces.includes(surfaceId),
        `${surfaceId} appears in owner scope`,
      );
    }

    const assigned = Object.values(DOWNSTREAM_SCOPES.scopes)
      .flatMap((scope) => (scope as DownstreamScope).ownedProductionSurfaces);
    assert.deepEqual(new Set(assigned), new Set(surfaceIds));
    assert.equal(assigned.length, surfaceIds.length, "no production surface has multiple implicit owners");
    const concreteProductionSurfaces = (Object.values(surfaces) as ProductionSurfaceOwnership[])
      .flatMap((surface) => surface.productionSurfaces);
    assert.equal(
      new Set(concreteProductionSurfaces).size,
      concreteProductionSurfaces.length,
      "no concrete production surface has multiple implicit owners",
    );
    const productionMutations = (Object.values(surfaces) as ProductionSurfaceOwnership[])
      .filter((surface) => surface.mutatesProduction);
    assert.ok(productionMutations.length > 0);
    assert.ok(productionMutations.every((surface) => surface.owner !== "HARN" && surface.owner !== "FAULT"));
  });

  it("requires HARN to consume the contract and exercise the immutable legacy release safely", () => {
    const harness = DOWNSTREAM_SCOPES.scopes.HARN;
    assert.equal(harness.harnessRequirements.contractModule, "scripts/update-contract.mjs");
    assert.equal(harness.harnessRequirements.importContractDirectly, true);
    assert.equal(harness.harnessRequirements.legacyCommit, LEGACY_RELEASE_SHA);
    assert.equal(harness.harnessRequirements.executeImmutableLegacyCheckoutAgainstCandidate, true);
    assert.equal(harness.harnessRequirements.fakeServicesOnly, true);
    assert.equal(harness.harnessRequirements.isolatedTemporaryState, true);
    assert.equal(harness.harnessRequirements.randomPortsOnly, true);
    assert.equal(harness.harnessRequirements.liveUserStateAllowed, false);
    assert.equal(harness.harnessRequirements.modelTokensAllowed, 0);
  });

  it("makes every downstream black-box gate preserve the complete invariant floor", () => {
    const requiredInvariants = [
      "force-never-grants-authority", "durable-authority-and-secret-capability-required",
      "readiness-is-complete-conjunction", "rollback-is-journaled-and-exactly-verified",
      "release-is-atomic-and-terminal-proof-dominated", "artifacts-are-versioned-bounded-and-crash-durable",
      "unknown-partial-or-conflicting-state-fails-closed",
    ];
    assert.deepEqual(DOWNSTREAM_SCOPES.invariantFloor, requiredInvariants);
    for (const [scopeName, scope] of Object.entries(DOWNSTREAM_SCOPES.scopes) as Array<[string, DownstreamScope]>) {
      for (const gate of scope.blackBoxAcceptanceGates) {
        assert.ok(gate.identifier.length > 0, `${scopeName} gate id`);
        assert.ok(gate.proof.length > 0, `${scopeName} gate proof`);
        assert.deepEqual(gate.preservesInvariants, requiredInvariants, `${scopeName}/${gate.identifier} invariant floor`);
      }
    }
    assert.equal(DOWNSTREAM_SCOPES.relaxationPolicy.allowed, false);
    assert.equal(DOWNSTREAM_SCOPES.relaxationPolicy.disposition, "reject-downstream-run-and-preserve-all-admission-blockers");
  });
});
