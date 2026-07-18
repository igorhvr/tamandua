import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTORS,
  ARTIFACT_CONTRACT,
  DOWNSTREAM_SCOPES,
  FAULT_CONTRACT,
  IDENTIFIERS,
  IMPLEMENTATION,
  LIFECYCLE,
  READINESS_CONTRACT,
  TERMINAL_PROTOCOL,
  TOPOLOGIES,
  UPDATE_CONTRACT,
  VERSIONS,
} from "../scripts/update-contract.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_IDENTIFIER = /^tamandua\.upgx\.[a-z][a-z0-9.-]*(?:\/v[1-9][0-9]*)?$/u;
const IDENTIFIER_FIELDS = new Set(["identifier", "schemaIdentifier", "contractIdentifier"]);

function flattenStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(flattenStrings);
  return [];
}

function visit(value: unknown, callback: (key: string, value: unknown, location: string) => void, location = "contract"): void {
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childLocation = `${location}.${key}`;
    callback(key, child, childLocation);
    visit(child, callback, childLocation);
  }
}

function objectKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function sha256(relativePath: string): string {
  return createHash("sha256").update(fs.readFileSync(path.join(REPO_ROOT, relativePath))).digest("hex");
}

type LifecycleEdge = {
  id: string;
  from: string;
  to: string;
  actor: string;
  capability: { required: boolean; rule: string };
  preconditions: string[];
  durableEvidence: string[];
  mutationClass: string;
  direction: string;
};

type LifecyclePolicy = {
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
};

type ReadinessRole = {
  requiredPredicates: string[];
};

type DeclaredEntry = { identifier: string };
type Topology = { identifier: string; roles: DeclaredEntry[] };
type Artifact = {
  schemaDefinition: string;
  writers: string[];
  requiredStates: string[];
};
type DownstreamScope = DeclaredEntry & {
  consumedContractSections: string[];
  requiredContractIdentifiers: string[];
  ownedProductionSurfaces: string[];
  blackBoxAcceptanceGates: Array<{ identifier: string; proof: string; preservesInvariants: string[] }>;
};
type VersionEntry = DeclaredEntry & { version: number; compatibilityPolicy: string };

const actorRecord = ACTORS as Record<string, DeclaredEntry>;
const stateRecord = LIFECYCLE.states as Record<string, DeclaredEntry>;
const topologyRecord = TOPOLOGIES as Record<string, Topology>;
const artifactRecord = ARTIFACT_CONTRACT.artifacts as Record<string, Artifact>;
const readinessRoleRecord = READINESS_CONTRACT.roleProfiles as Record<string, ReadinessRole>;
const downstreamScopeRecord = DOWNSTREAM_SCOPES.scopes as Record<string, DownstreamScope>;
const versionRecord = VERSIONS as Record<string, VersionEntry>;

describe("update contract final closure", () => {
  it("makes every canonical identifier unique and every canonical reference resolvable", () => {
    const vocabulary = flattenStrings(IDENTIFIERS);
    assert.equal(new Set(vocabulary).size, vocabulary.length, "vocabulary identifiers are unique");

    const declarations = new Map<string, string>();
    const canonicalReferences = new Set<string>();
    visit(UPDATE_CONTRACT, (key, value, location) => {
      if (typeof value !== "string" || !value.startsWith("tamandua.upgx.")) return;
      assert.match(value, CANONICAL_IDENTIFIER, `${location} is canonical`);
      canonicalReferences.add(value);
      if (IDENTIFIER_FIELDS.has(key)) {
        assert.equal(declarations.has(value), false, `${value} declared once at ${location}`);
        declarations.set(value, location);
      }
    });

    const resolvable = new Set([...vocabulary, ...declarations.keys()]);
    for (const reference of canonicalReferences) {
      assert.ok(resolvable.has(reference), `${reference} resolves to vocabulary or declaration`);
    }

    const declaredVocabularyFamilies = [
      ...(Object.values(actorRecord) as DeclaredEntry[]).map((actor) => actor.identifier),
      ...(Object.values(stateRecord) as DeclaredEntry[]).map((state) => state.identifier),
      ...(Object.values(topologyRecord) as Topology[]).flatMap((topology) => [
        topology.identifier,
        ...topology.roles.map((role) => role.identifier),
      ]),
      ...(Object.values(downstreamScopeRecord) as DownstreamScope[]).map((scope) => scope.identifier),
    ];
    for (const identifier of declaredVocabularyFamilies) {
      assert.ok(vocabulary.includes(identifier), `${identifier} is registered in IDENTIFIERS`);
    }
  });

  it("makes status, phase, actor, state, artifact, and readiness matrices total", () => {
    const statuses: Array<{ value: string; location: string }> = [];
    visit(UPDATE_CONTRACT, (key, value, location) => {
      if (key === "status" && typeof value === "string") statuses.push({ value, location });
    });
    assert.ok(statuses.length > 0);
    for (const { value, location } of statuses) {
      assert.ok(["implemented-foundation", "target-only"].includes(value), `${location} has a declared status`);
    }
    assert.deepEqual(IMPLEMENTATION.foundation.phases, ["ACQUIRED", "GUARDIAN_RECORDED", "FAILED"]);
    assert.deepEqual(LIFECYCLE.implementedFoundation.states, IMPLEMENTATION.foundation.phases);

    const actorNames = objectKeys(actorRecord);
    const stateNames = objectKeys(stateRecord);
    assert.deepEqual(objectKeys(LIFECYCLE.statePolicies), stateNames, "every state has exactly one policy");
    for (const [state, policy] of Object.entries(LIFECYCLE.statePolicies) as Array<[string, LifecyclePolicy]>) {
      assert.deepEqual(
        [...new Set([...policy.permittedWriters, ...policy.forbiddenActors])].sort(),
        actorNames,
        `${state} classifies every actor`,
      );
      assert.equal(policy.permittedWriters.some((actor) => policy.forbiddenActors.includes(actor)), false);
      for (const field of [
        policy.requiredCapability,
        policy.idempotentReplay,
        policy.crashReentryDisposition,
        policy.workAndServices.newWork,
        policy.workAndServices.services,
      ]) assert.ok(field.length > 0, `${state} has a deterministic disposition`);
      assert.ok(policy.requiredImmutableIdentities.length > 0, `${state} identities are explicit`);
      assert.ok(policy.entryPreconditions.length > 0, `${state} entry is explicit`);
      assert.ok(policy.durableEvidence.length > 0, `${state} evidence is explicit`);
    }

    const artifactNames = objectKeys(artifactRecord);
    assert.deepEqual(objectKeys(ARTIFACT_CONTRACT.schemas), artifactNames, "every artifact has exactly one schema");
    for (const [name, artifact] of Object.entries(artifactRecord) as Array<[string, Artifact]>) {
      assert.equal(artifact.schemaDefinition, name, `${name} uses its same-named schema`);
      assert.ok(artifact.writers.length > 0 && artifact.writers.every((actor) => actorNames.includes(actor)));
      assert.ok(artifact.requiredStates.length > 0 && artifact.requiredStates.every((state) => stateNames.includes(state)));
    }

    assert.deepEqual(READINESS_CONTRACT.runningPredicateOrder, Object.keys(READINESS_CONTRACT.runningPredicates));
    assert.deepEqual(READINESS_CONTRACT.absencePredicateOrder, Object.keys(READINESS_CONTRACT.absencePredicates));
    const topologyRoleIds = (Object.values(topologyRecord) as Topology[]).flatMap((topology) => topology.roles.map((role) => role.identifier)).sort();
    assert.deepEqual(objectKeys(readinessRoleRecord), topologyRoleIds);
    for (const role of Object.values(readinessRoleRecord) as ReadinessRole[]) {
      assert.deepEqual(role.requiredPredicates, READINESS_CONTRACT.runningPredicateOrder);
    }
    assert.ok(READINESS_CONTRACT.absencePredicateOrder.length > 0, "stopped intent has a complete shared absence matrix");
  });

  it("closes lifecycle references and requires authority for every mutation", () => {
    const edges = LIFECYCLE.edges as LifecycleEdge[];
    const edgeIds = edges.map((edge) => edge.id);
    const stateNames = objectKeys(stateRecord);
    const actorNames = objectKeys(actorRecord);
    assert.equal(new Set(edgeIds).size, edgeIds.length, "transition IDs are unique");

    for (const edge of edges) {
      assert.ok(stateNames.includes(edge.from), `${edge.id} source exists`);
      assert.ok(stateNames.includes(edge.to), `${edge.id} destination exists`);
      assert.ok(actorNames.includes(edge.actor), `${edge.id} actor exists`);
      assert.notEqual(edge.from, edge.to, `${edge.id} is not a self edge`);
      assert.ok(edge.preconditions.length > 0 && edge.durableEvidence.length > 0, `${edge.id} has proof`);
      assert.ok(edge.capability.rule.length > 0, `${edge.id} has an authority rule`);
      if (edge.mutationClass !== "none") assert.equal(edge.capability.required, true, `${edge.id} mutation requires capability`);
    }

    for (const [state, policy] of Object.entries(LIFECYCLE.statePolicies) as Array<[string, LifecyclePolicy]>) {
      assert.deepEqual(
        policy.outgoingTransitions,
        edges.filter((edge) => edge.from === state).map((edge) => edge.id),
        `${state} documents every and only outgoing edge`,
      );
    }
  });

  it("requires readiness plus commit or verified rollback to dominate every release route", () => {
    const edges = LIFECYCLE.edges as LifecycleEdge[];
    const releaseEdges = edges.filter((edge) => edge.to === "released");
    assert.deepEqual(releaseEdges.map((edge) => edge.from).sort(), ["candidate-committed", "rollback-verified"]);
    assert.deepEqual(TERMINAL_PROTOCOL.release.allowedSourceStates.slice().sort(), ["candidate-committed", "rollback-verified"]);

    const candidateCommitEdges = edges.filter((edge) => edge.to === "candidate-committed");
    assert.deepEqual(candidateCommitEdges.map((edge) => edge.from), ["readiness-verified"]);
    assert.equal(TERMINAL_PROTOCOL.candidateCommit.fromState, "readiness-verified");
    assert.equal(TERMINAL_PROTOCOL.release.readinessOrRollbackBypassAllowed, false);

    const paths: string[][] = [];
    const walk = (state: string, pathSoFar: string[]): void => {
      if (pathSoFar.includes(state)) return;
      const path = [...pathSoFar, state];
      if (state === "released") {
        paths.push(path);
        return;
      }
      for (const edge of edges.filter((candidate) => candidate.from === state)) walk(edge.to, path);
    };
    walk("idle", []);
    assert.ok(paths.length > 0, "release is reachable");
    for (const path of paths) {
      const committed = path.includes("candidate-committed") && path.includes("readiness-verified");
      const rolledBack = path.includes("rollback-verified");
      assert.ok(committed || rolledBack, `release path is terminal-proof dominated: ${path.join(" -> ")}`);
    }
  });

  it("makes every fault boundary unique, resolved, and operationally total", () => {
    const sections = [
      FAULT_CONTRACT.preHandoffAndBuild,
      FAULT_CONTRACT.mutationServiceAndRelease,
      FAULT_CONTRACT.rollbackAndRecovery,
    ];
    const boundaries = sections.flatMap((section) => section.boundaries) as FaultBoundary[];
    const boundaryIds = boundaries.map((boundary) => boundary.id);
    const actorNames = objectKeys(actorRecord);
    const stateNames = objectKeys(stateRecord);
    assert.equal(new Set(boundaryIds).size, boundaryIds.length, "every fault boundary occurs exactly once");

    const requiredFields: Array<keyof FaultBoundary> = [
      "group", "detector", "authorizedNextActor", "requiredAuthority", "idempotence", "disposition",
      "nextAction", "workAdmission", "serviceAdmission", "userVisibleResult", "releaseCondition",
    ];
    for (const boundary of boundaries) {
      assert.ok(stateNames.includes(boundary.lifecycleState), `${boundary.id} state exists`);
      assert.ok(actorNames.includes(boundary.authorizedNextActor), `${boundary.id} authority actor exists`);
      assert.ok(boundary.durableEvidence.length > 0, `${boundary.id} durable evidence`);
      for (const field of requiredFields) assert.ok(String(boundary[field]).length > 0, `${boundary.id}.${field} is nonempty`);
      assert.equal(new Set(boundary.faultClasses).size, boundary.faultClasses.length, `${boundary.id} fault classes unique`);
      assert.deepEqual(objectKeys(boundary.faultDispositionByClass), [...boundary.faultClasses].sort());
      for (const [faultClass, disposition] of Object.entries(boundary.faultDispositionByClass)) {
        assert.ok(disposition.disposition.length > 0, `${boundary.id}/${faultClass} disposition`);
        assert.ok(disposition.nextAction.length > 0, `${boundary.id}/${faultClass} next action`);
        assert.ok(disposition.releaseCondition.length > 0, `${boundary.id}/${faultClass} release condition`);
      }
    }
  });

  it("makes version and downstream-scope references complete and duplicate-free", () => {
    const versionEntries = Object.values(versionRecord) as VersionEntry[];
    assert.equal(new Set(versionEntries.map((version) => version.identifier)).size, versionEntries.length);
    assert.ok(versionEntries.every((version) => version.version === 1));
    assert.ok(versionEntries.every((version) => version.compatibilityPolicy === UPDATE_CONTRACT.compatibilityPolicy.identifier));

    const scopeNames = DOWNSTREAM_SCOPES.scopeOrder;
    assert.deepEqual(objectKeys(downstreamScopeRecord), [...scopeNames].sort());
    assert.equal(new Set(scopeNames).size, scopeNames.length);
    const acceptanceIds: string[] = [];
    for (const [name, scope] of Object.entries(downstreamScopeRecord) as Array<[string, DownstreamScope]>) {
      assert.ok(scope.consumedContractSections.every((section) => Object.hasOwn(UPDATE_CONTRACT, section)), `${name} sections resolve`);
      assert.equal(new Set(scope.consumedContractSections).size, scope.consumedContractSections.length);
      assert.equal(new Set(scope.requiredContractIdentifiers).size, scope.requiredContractIdentifiers.length);
      assert.equal(new Set(scope.ownedProductionSurfaces).size, scope.ownedProductionSurfaces.length);
      for (const gate of scope.blackBoxAcceptanceGates) {
        acceptanceIds.push(gate.identifier);
        assert.ok(gate.proof.length > 0);
        assert.deepEqual(gate.preservesInvariants, DOWNSTREAM_SCOPES.invariantFloor);
      }
    }
    assert.equal(new Set(acceptanceIds).size, acceptanceIds.length, "acceptance gate IDs are globally unique");
  });
});

describe("SPEC production scope preservation", () => {
  it("pins every production interception and mutation surface to its pre-SPEC content", () => {
    const protectedFiles: Record<string, string> = {
      "build-and-install": "4b354d8ada39bf2bf529ab20682b798c0a696a9c15b4891e77804c6f39531d35",
      "src/cli/update.ts": "11e9985cd8a440d4fc56dd1164f1f3bf8349e2ee56e402afa0315201a4641b1b",
      "src/installer/install.ts": "6f6e587670e0f58f4176966c4ffcf8283f79d0366ce69b17b056ab95a6d0c2ef",
      "src/installer/workflow-fetch.ts": "9bb6dda4d795ca5562158edcb2bdf1f603ac793f9b80ed6b4a907503bb69daee",
      "src/installer/workspace-files.ts": "4cc13dd7eebc2232ca9f409530f3f558143e6b251d5839aace11989d36131572",
      "src/server/daemon.ts": "84a708032aa31cea9177552a3e0940dd6c6ea3835c65ac8b76d05c1a6e5c9fc8",
      "src/server/daemonctl.ts": "a53ccd9f515562ea4aa0366bf23c1b20287a4cfd956ea977d2bd0422f9c30661",
      "src/server/control-server.ts": "7121109e5ccbfba58b122b4b3a4e975ea31f4790402ff95d4785a05355a8f45d",
      "src/server/control-client.ts": "654dd635c26883a1e3d224e8b3af3963a42557098625c4b24949f81675f61a68",
      "scripts/update-protocol.mjs": "4788d1b97df99284be748d40549f7adf2192fb3cf31d70bdf9de3d3e0df61af9",
    };
    for (const [relativePath, expectedHash] of Object.entries(protectedFiles)) {
      assert.equal(sha256(relativePath), expectedHash, `${relativePath} remains pre-SPEC exact content`);
    }
  });

  it("keeps the target contract disconnected from production entrypoints", () => {
    const productionRoots = ["build-and-install", "src", "scripts/update-protocol.mjs"];
    const sourceFiles: string[] = [];
    const collect = (relativePath: string): void => {
      const absolutePath = path.join(REPO_ROOT, relativePath);
      const stat = fs.statSync(absolutePath);
      if (stat.isFile()) {
        sourceFiles.push(relativePath);
        return;
      }
      for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
        if (entry.isDirectory() && ["node_modules", "dist"].includes(entry.name)) continue;
        if (entry.isDirectory() || /\.(?:ts|js|mjs|sh)$/u.test(entry.name)) collect(path.join(relativePath, entry.name));
      }
    };
    productionRoots.forEach(collect);

    for (const relativePath of sourceFiles) {
      const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
      assert.doesNotMatch(source, /(?:import|require\s*\()\s*["'][^"']*update-contract\.mjs["']/u, `${relativePath} does not wire the target contract`);
    }
    assert.equal(IMPLEMENTATION.foundation.productionWired, false);
    assert.equal(IMPLEMENTATION.productionLifecycle.productionWired, false);
    assert.equal(IMPLEMENTATION.productionLifecycle.claimsLiveSafety, false);
  });
});
