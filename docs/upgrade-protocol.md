# Tamandua cross-version safe-update protocol

This is the authoritative human design record for cross-version safe updates.
The single machine-readable source of truth is the side-effect-free frozen data
exported by `scripts/update-contract.mjs`. When prose and machine data disagree,
the machine contract wins and production admission remains blocked until the
prose or contract is reviewed and made consistent. This document names contract
paths rather than maintaining competing enums, transition lists, schemas, or
fault matrices.

## Safety status: dormant foundation, not a live safe updater

Tamandua does not currently provide the production lifecycle described here.
Only the dormant database foundation and its internal CLI are implemented.
They are not called by normal `tamandua update`, `build-and-install`, installer,
workflow/catalog, daemon, service, recovery, release, or rollback paths.
Everything under a heading beginning **Normative target-only** is a required
future guarantee, not present behavior. `UPDATE_CONTRACT.implementation` is the
machine authority for this distinction; its production lifecycle has
`productionWired = false` and `claimsLiveSafety = false`.

> **LEGACY HANDOFF DECISION — REVIEW BEFORE HARN:** after read-only admission,
> durable gate/manifest acquisition, detached guardian spawn, and a positive
> guardian immutable-identity and durable-authority handshake, the pulled
> candidate build shell will return reserved nonzero exit `75`. The result means
> `transaction-accepted-detached-not-complete`. The immutable updater's awaited
> `runCommand` rejects, so its old in-memory post-build mutation path cannot run.
> The user sees the public transaction identifier and exactly
> `tamandua update status {publicTransactionId}` and
> `tamandua update recover {publicTransactionId}`; no secret is printed. The
> guardian waits for exact legacy-owner exit and only then becomes sole
> controller. This ordering is the chosen deadlock-free compatibility mechanism.

> **MACOS RELEASE BLOCKER — HARN must not begin production qualification while
> unresolved:** `tamandua.upgx.release-blocker.macos-process-identity` blocks
> production admission on Darwin. The dormant second-resolution `ps lstart`
> identity is not boot-bound or PID-reuse-safe. The chosen resolution is
> `tamandua.upgx.process-identity.macos-native-boot-start`, a native boot-session,
> monotonic process-start, PID, and executable-file identity with no `lstart`
> fallback. Qualification must reject same-PID reuse, same-second replacement,
> host reboot, and executable replacement, and preserve the gate when identity
> resolution fails, on every supported macOS release.

## Canonical machine contract map

Canonical data is exported both through `UPDATE_CONTRACT` and through named
references into that same deeply frozen object. The names below are navigation
paths, not duplicate definitions.

| Contract area | Canonical machine path |
|---|---|
| Identifier vocabulary | `UPDATE_CONTRACT.identifiers` / `IDENTIFIERS` |
| Implemented versus target metadata | `UPDATE_CONTRACT.implementation` / `IMPLEMENTATION` |
| Immutable compatibility anchor | `UPDATE_CONTRACT.legacyRelease` / `LEGACY_RELEASE_SHA` |
| Entrypoints, handoff, outcomes, and re-entry | `UPDATE_CONTRACT.controlFlow` / `CONTROL_FLOW` |
| Ordered admission and refusal | `UPDATE_CONTRACT.admission` / `ADMISSION_CONTRACT` |
| Actor classification | `UPDATE_CONTRACT.actors` / `ACTORS` |
| Authority operations and evidence | `UPDATE_CONTRACT.authority` / `AUTHORITY` |
| Secret capability lifecycle | `UPDATE_CONTRACT.capabilityLifecycle` / `CAPABILITY_LIFECYCLE` |
| Process identity and restart rules | `UPDATE_CONTRACT.processIdentity` / `PROCESS_IDENTITY` |
| Release blockers | `UPDATE_CONTRACT.releaseBlockers` / `RELEASE_BLOCKERS` |
| Lifecycle graph, state policies, and disagreement | `UPDATE_CONTRACT.lifecycle` / `LIFECYCLE` |
| Commit, rollback verification, audit, and release | `UPDATE_CONTRACT.terminalProtocol` / `TERMINAL_PROTOCOL` |
| Total failure and recovery boundaries | `UPDATE_CONTRACT.faultContract` / `FAULT_CONTRACT` |
| Downstream implementation scopes | `UPDATE_CONTRACT.downstreamScopes` / `DOWNSTREAM_SCOPES` |
| Durable files, schemas, and publication | `UPDATE_CONTRACT.artifactContract` / `ARTIFACT_CONTRACT` |
| Version reader/writer behavior | `UPDATE_CONTRACT.compatibilityPolicy` / `COMPATIBILITY_POLICY` |
| Protocol and artifact versions | `UPDATE_CONTRACT.versions` / `VERSIONS` |
| Public identifier and secret separation | `UPDATE_CONTRACT.transactionIdentity` / `TRANSACTION_IDENTITY` |
| Running readiness and stopped absence | `UPDATE_CONTRACT.readiness` / `READINESS_CONTRACT` |
| Legacy and current topology shapes | `UPDATE_CONTRACT.topologies` / `TOPOLOGIES` |

Every canonical identifier belongs to one family below. New identifiers must be
added to the machine contract and closure tests before this record references
them:

- `IDENTIFIERS.contract`
- `IDENTIFIERS.implementationStatuses`
- `IDENTIFIERS.entryModes`
- `IDENTIFIERS.controlFlow`
- `IDENTIFIERS.actors`
- `IDENTIFIERS.authorityRoles`
- `IDENTIFIERS.authorityOperations`
- `IDENTIFIERS.capabilityTransport`
- `IDENTIFIERS.processIdentities`
- `IDENTIFIERS.releaseBlockers`
- `IDENTIFIERS.admissionPredicates`
- `IDENTIFIERS.lifecycleStates`
- `IDENTIFIERS.compatibilityCases`
- `IDENTIFIERS.transactionIdentity`
- `IDENTIFIERS.topologies`
- `IDENTIFIERS.topologyRoles`
- `IDENTIFIERS.downstreamScopes`

## Implemented-current behavior (dormant foundation only)

The following table is exhaustive for current implementation scope. Nothing in
later target-only sections enlarges it.

| Surface | Implemented now | Explicit limit |
|---|---|---|
| `scripts/update-protocol.mjs` | Node-built-in functions `acquire`, `inspect`, `recordGuardian`, `fail`, `isGateActive`, process-identity capture, and identity validation | Dormant; no updater/build/install/service caller and no guardian spawn, snapshot, apply, readiness, commit, release, recovery, or rollback |
| `scripts/update-coordinator.mjs` | Internal exact-arity commands `acquire`, `inspect`, `record-guardian-cas`, and `fail`, with bounded JSON output and diagnostics | Dormant internal adapter; token-bearing mutation commands use argv and are not production-safe |
| Gate acquisition | Creates and validates the singleton table and two work-blocking triggers under `BEGIN IMMEDIATE`, refuses existing or malformed reserved state, refuses running/paused work, and inserts `ACQUIRED` | This is narrower than target admission and does not establish the target manifest, transaction directory, authority epoch, or guardian |
| Implemented phases | `ACQUIRED`, `GUARDIAN_RECORDED`, and terminal blocking `FAILED` | Only `ACQUIRED -> GUARDIAN_RECORDED`, `ACQUIRED -> FAILED`, and `GUARDIAN_RECORDED -> FAILED` exist; there is no release or generic phase setter |
| Guardian record | `recordGuardian` validates a caller-supplied live identity and performs a token/phase/owner CAS | It does not spawn, detach, handshake, monitor, transfer control to, or recover a guardian |
| Failure record | `fail` atomically records bounded reason/details and enters `FAILED` | `FAILED` remains blocking and has no clear/drop/release path |
| Inspection | `inspect` returns the bounded non-token gate view; `isGateActive` reports gate presence | Inspection is evidence only and cannot authorize mutation or recovery |
| Process identity | Linux uses boot ID plus process start ticks; macOS uses second-resolution `lstart` | macOS identity is not production compatible; process identity on every platform is evidence, never authority |
| Secret handling | Acquisition generates a 256-bit base64url token; inspect redacts it | The internal CLI accepts token arguments through argv and therefore cannot carry production capabilities |
| Production wiring | `IMPLEMENTATION.foundation.productionWired = false` | `build-and-install`, `tamandua update`, service topology, workflows/catalog, and live state remain unchanged |

The implemented gate fields and SQL behavior remain documented by code and
`tests/update-protocol.test.ts`. They must not be reinterpreted as the target
schemas in `VERSIONS` or as target lifecycle states in `LIFECYCLE.states`.

The production lifecycle inventory is explicitly non-live:

| Production behavior | Status |
|---|---|
| entrypoint-interception | Normative target-only |
| guardian-lifecycle | Normative target-only |
| handoff | Normative target-only |
| snapshot | Normative target-only |
| candidate-mutation | Normative target-only |
| topology-restoration | Normative target-only |
| readiness | Normative target-only |
| commit | Normative target-only |
| release | Normative target-only |
| recovery | Normative target-only |
| rollback | Normative target-only |

## Normative target-only: Entrypoints and legacy handoff

The exact entry records are `CONTROL_FLOW.entrypoints`; actor blocking and exit
semantics are `CONTROL_FLOW.paths`; public command results are
`CONTROL_FLOW.userOutcomes`; no-change, force, and existing-transaction behavior
are `CONTROL_FLOW.reentry`. Their canonical IDs come from
`IDENTIFIERS.controlFlow` and their entry modes from `IDENTIFIERS.entryModes`.

The immutable compatibility anchor is commit
`0258feeceeb2ab3934b71463039e6e282700f05a`. Its loaded updater performs a pull,
then awaits the candidate checkout's `./build-and-install`, then would continue
with old in-memory active-work, workflow/catalog, and four-role service logic.
The first candidate-controlled instruction is line one of the pulled
`build-and-install`; candidate coordination must intercept there before shell
setup, dependency installation, compilation, or installation.

The legacy owner blocks on the build shell. The build shell and candidate
coordinator block only through admission and positive guardian handshake, not
through transaction completion. Admission refusal returns without candidate
mutation. Acceptance publishes a public notice, status command, and recovery
command, then exits `75`. The immutable `runCommand` rejects that nonzero result
and the old updater exits rather than entering its post-build stages. The
handshaken detached guardian waits for disappearance of the exact immutable
owner identity. Only after that proof may it continue under the durable current
authority. A spawn result, PID, dead PID, or handshake missing either identity
or authority cannot advance this path.

The current updater enters the coordinator directly before pull, build,
install, workflow/catalog, service, or database-application mutation. It remains
the owner through handoff. It uses the same positive guardian prerequisite but
does not need the legacy escape because it has no old post-build continuation.
Its accepted command may return success while clearly reporting that the
transaction is not complete.

No-change and `--force` behavior is deterministic. Legacy no-change without
force never reaches candidate code. Legacy force reaches full evaluation.
Current direct entry evaluates before deciding no change. A compatible existing
transaction routes only to authenticated deterministic re-entry; it never
creates or adopts a parallel transaction. Force requests evaluation only and
never grants capability, authority, predicate bypass, recovery ownership, or a
terminal disposition.

## Normative target-only: Versions and compatibility

`VERSIONS` assigns explicit version 1 identifiers to protocol, gate schema,
durable manifest, snapshot metadata, rollback metadata, topology schema,
artifact manifest, and readiness evidence. Those values and
`COMPATIBILITY_POLICY.cases` are exhaustive. The shared policy is exact-match,
fail-closed: a canonical same version can be read and written; older, newer,
missing, malformed, partial, or case-conflicting state cannot be read, adopted,
repaired, upgraded in place, or overwritten. A writer emits nothing after an
incompatible read. Unknown fields are rejected where each schema requires exact
shape.

The public operation identifier and secret credential are separate under
`TRANSACTION_IDENTITY`. A public ID is bounded canonical ASCII matching
`^upgx-[0-9a-f]{32}$` and may appear in status output, logs, diagnostics, argv,
and inspection. The secret has at least 256 bits of entropy, canonical unpadded
base64url encoding, is never derived from the public ID, and follows the private
channels described below.

The legacy topology is `tamandua.upgx.topology.legacy-four-role`, anchored to the
immutable commit. The current topology is
`tamandua.upgx.topology.current-consolidated`. Their schema identities, roles,
process units, hosting modes, and endpoint ownership are distinct compatibility
cases in `TOPOLOGIES`; a hybrid or unrecognized shape is incompatible.

## Normative target-only: Actors, ownership, and authority

`ACTORS` is total over immutable legacy updater owner, current updater owner,
build shell, candidate coordinator, detached guardian, recovery coordinator,
service processes, and human operator. Canonical actor and role IDs are
`IDENTIFIERS.actors` and `IDENTIFIERS.authorityRoles`. Each actor record declares
its responsibilities, permitted roles, and forbidden roles. Service processes
provide evidence but never coordinate. A human can request authenticated
recovery but cannot write lifecycle state or choose an unverified outcome.

`AUTHORITY.operations` is the total operation matrix for continuation, adoption,
mutation, recovery, rollback, cleanup, and release. Every authority-bearing
operation requires both the matching secret capability and agreeing non-process
durable gate/manifest authority: transaction ID, phase, authority epoch,
controller immutable identity, operation evidence, and capability digest.
`AUTHORITY.evidenceRules` makes liveness, death, PID reuse, identity mismatch,
host reboot, public ID, and force evidence only. None transfers authority.

Only the controller named by the current agreeing authority peers may write a
legal edge. Transfer to a guardian or recovery coordinator atomically advances
the epoch and capability digest before mutation, invalidates the prior
credential, and records the new immutable controller identity. Missing,
malformed, stale, hybrid, or disagreeing peers preserve blockers and permit only
authenticated read-only diagnosis. Process absence never creates an ownerless
right to adopt, clean up, continue, roll back, or release.

## Normative target-only: Identity and capability security

`PROCESS_IDENTITY` pins Linux boot ID plus start ticks and the required native
macOS replacement. Exact PID and immutable identity are process evidence;
resolution uncertainty, PID reuse, or reboot invalidates the observed
controller and requires authenticated re-entry under durable authority.
`RELEASE_BLOCKERS` keeps the Darwin blocker active until its chosen native
resolution and all acceptance tests pass.

`CAPABILITY_LIFECYCLE` pins generation, transport, optional persistence,
redaction, rotation, destruction, and recovery. A coordinator generates at least
256 OS-CSPRNG bits. It transfers a bounded length-prefixed capability through a
dedicated inherited descriptor 3, inherited only by the intended process, with
unrelated descriptors close-on-exec. The positive handshake binds a fresh nonce,
the expected immutable child identity, authority epoch, and capability digest.
The descriptor is closed after transfer.

If recovery material is retained, it exists only below the owner-controlled
`0700` transaction directory as an owner-UID, no-link `0600` file. Gate and
manifest retain only its digest. Secrets never travel in argv, environment,
ordinary stdin/stdout, logs, diagnostics, inspection, crash reports, or group-
or world-readable files. Output redacts the credential before formatting.
Recovery authenticates the state-root owner, reads through a private descriptor,
requires agreeing durable authority, then rotates before mutation. Release
closes private descriptors, erases owned buffers, removes retained material,
fsyncs the parent directory, and leaves no secret or reversible material in the
audit.

The dormant CLI token arguments are an explicit implemented mismatch, recorded
by `CAPABILITY_LIFECYCLE.implementedMismatch`. They remain available only to
isolated foundation tests and internal callers and are prohibited from
production secret transport.

## Normative target-only: Lifecycle and re-entry

`LIFECYCLE.states` supplies distinct durable states for idle absence, admission
acquisition, guardian readiness, legacy-owner exit, verified snapshot, active
apply, topology restoration, readiness verification, candidate commit,
rollback in progress, verified rollback, release, and unrecoverable blocking.
`LIFECYCLE.edges` is the closed transition allowlist. Each edge names one actor,
required capability, preconditions, durable evidence, mutation class, and
forward, rollback, or terminal direction. There are no implicit, self, generic,
or observation-selected transitions.

The forward route is dominated by admission, positive guardian handoff, exact
legacy-owner exit when applicable, complete snapshot, journaled apply, topology
restoration, complete readiness, candidate commit, and atomic release. The
rollback route starts only from contract-declared precommit states, becomes
irreversible once its header is durable, restores every snapshot domain in
order, verifies original intent exactly, and reaches release only through
verified rollback. Any state that cannot prove one legal next step enters or
remains in authenticated blocking with the gate preserved.

`LIFECYCLE.statePolicies` is total over every state and actor. It defines sole
writers, forbidden actors, capability and immutable-identity requirements,
entry evidence, durable phase evidence, exact outgoing edge IDs, idempotent
replay, crash/re-entry disposition, and work/service policy. New work remains
blocked after acquisition. Service changes are limited to the next proved
journal action; observations cannot manufacture intent.

`LIFECYCLE.evidenceConsistency` requires gate, manifest, phase artifacts,
process identity, and service observations to agree. No one peer is
independently authoritative. Missing, malformed, partial, stale, hybrid, or
conflicting evidence preserves the gate and enters authenticated diagnosis.
Re-entry resumes only the first operation classified from the last complete
jointly durable boundary. If no deterministic action is provable, the durable
state is unrecoverable blocking and no release edge exists.

The dormant `ACQUIRED`, `GUARDIAN_RECORDED`, and `FAILED` subgraph is separately
marked implemented-foundation in `LIFECYCLE.implementedFoundation`; those names
are not aliases for target states.

## Normative target-only: Durable artifacts and atomicity

`ARTIFACT_CONTRACT.artifacts` pins exact state-root-relative paths, schema ID and
version, maximum bytes, owner-only mode, allowed writers, required states, and
retention for the transaction directory, manifest, snapshot inventory and
objects, apply journal, rollback journal, topology evidence, readiness evidence,
completion audit, and optional retained capability. The transaction directory
is `update-transactions/{publicTransactionId}`, mode `0700`, beneath an
owner-controlled `0700` state root on one supported local filesystem. Files are
`0600`; links and ownership ambiguity are rejected.

`ARTIFACT_CONTRACT.schemas` pins concrete field, size, cardinality, and integer
bounds. Inventory and both journals cover source-before, source-after-pull, and
candidate identities; build/install bytes and hashes; symlink targets and
metadata; workflow/catalog versions, stamps, and installed files; database
identity, schema, and snapshot; topology and hosting; endpoints and ports;
process immutable identities and build identities; and exact originally-running
or originally-stopped intent. Empty domains are explicit. A destructive action
must have durable intent and before evidence, then durable result, after, and
verified evidence before another mutation.

Canonical JSON is bounded UTF-8 without BOM, NFC-normalized, exact-key,
canonical-number data with schema ID and version first, remaining normalized
keys sorted, no duplicate normalized keys, one trailing LF, and a lowercase
SHA-256 digest over exact bytes. Opaque snapshot objects and capability bytes use
their separately bounded encodings.

`ARTIFACT_CONTRACT.atomicPublication` requires: verify path, ownership, mode,
link count, and device; serialize within bounds; create an exclusive no-follow
temporary file in the destination directory; set and verify owner and mode;
write all bytes; fsync and close; atomic rename; fsync the containing directory;
then reopen and verify schema, version, size, mode, owner, and digest. New nested
directories are mode `0700` and parent-fsynced. Journals republish complete
bounded hash-chained documents; in-place append is forbidden. Cross-filesystem
rename, `EXDEV`, or copy fallback refuses while preserving source and gate.

`ARTIFACT_CONTRACT.unsafeArtifacts` gives a non-destructive fail-closed action
for unknown, stale, partial, malformed, oversized, unsafe-permission,
case-conflicting, linked, and cross-filesystem artifacts. They are never adopted
or silently removed. Cleanup requires authenticated proof that canonical peers
agree and no active writer or inventory reference exists. Active and blocked
transactions are retained. Terminal collection may occur only after its
contract delay and checks; the redacted completion audit is retained
indefinitely.

## Normative target-only: Admission and refusal

`ADMISSION_CONTRACT.predicates` is an exact-order observational matrix covering
entry context, owner ancestry/immutable identity, platform blockers, runtime
prerequisites, safe state root, source identity, transaction/gate absence,
artifact compatibility, active running/paused work, and resource capacity.
Every predicate must pass before gate/manifest publication or guardian spawn.
No dependency install, compile, build publication, install/symlink, workflow or
catalog change, service action, DB application/schema change, snapshot,
capability persistence, or other candidate mutation may precede admission.

Failure or unreadability refuses immediately and reports a public secret-free
reason and remedy. It preserves work, services and their intent, DB and schema,
installed files and links, workflows/catalog, snapshots, journals, gates, and
transaction artifacts byte-for-byte. The current direct path allows no
refusal-side mutation. On the legacy path, the immutable updater's already
completed pull-only source HEAD movement is the sole allowed refusal-side
mutation; candidate code neither resets nor compensates for it.

A compatible existing transaction refuses new acquisition and routes only to
authenticated deterministic re-entry. Incompatible, partial, case-conflicting,
or unsafe state remains blocked without repair or adoption. Running or paused
work always refuses. `--force` changes only whether evaluation is requested; it
cannot bypass a predicate, blocker, identity, capability, or recovery owner.

## Normative target-only: Versioned topology restoration

`TOPOLOGIES` defines two incompatible versioned shapes. The immutable legacy
shape has dashboard and scheduler roles sharing its dashboard-daemon, control
always hosted by that daemon when it runs but also available standalone when it
does not, and MCP stopped, standalone, or daemon-colocated. The current shape
has a consolidated scheduler/control daemon, standalone dashboard, and MCP whose
recorded mode is standalone or colocated with that exact daemon. Hosting mode,
process unit, build identity, endpoints, and original running/stopped intent are
snapshot data, not observations to infer.

Each topology role record pins endpoint ownership, valid hosting modes, exact
process-unit start and stop order, shared-intent constraints, readiness profile,
and disagreement action. Colocated roles share the owner's PID, immutable
identity, and build identity and are enabled or closed with that process rather
than by fictitious standalone actions. Every recorded running process unit is
started exactly once in contract order; every recorded stopped unit stays
stopped and must pass absence checks. A mixed topology, impossible colocated
intent, endpoint mismatch, duplicate owner, partial action, or unrecognized mode
preserves the gate and enters authenticated recovery.

## Normative target-only: Readiness evidence

`READINESS_CONTRACT.runningPredicates` is a complete conjunction for each
intended-running role: durable role/topology/endpoint/intent match; exact PID;
boot-bound immutable identity; expected build and artifact digest;
fresh authority-bound role health; kernel listener ownership by that exact or
declared colocated process; endpoint uniqueness; workflow/catalog consistency;
DB identity and schema compatibility; duplicate-listener exclusion; and
duplicate-process exclusion. Health reports role, PID, immutable identity,
build, catalog/workflows, DB/schema, authority binding, and role-specific facts.
Scheduler/control health proves new work remains blocked; MCP proves hosting
mode.

`READINESS_CONTRACT.absencePredicates` proves every intended-stopped role has
recorded stopped intent, no live recorded identity, no role process under an
expected or conflicting build, no expected or alias/conflicting listener, no
authenticated role response, and no duplicate role process or listener.
Observations are bounded and taken under one unchanged authority epoch and host
boot. Any authority, identity, listener, build, catalog, workflow, DB, schema,
or boot change invalidates the evidence.

A spawned PID, pidfile, live PID, open port, accepting socket, generic liveness
response, or proper subset of predicates is insufficient. Only canonical,
durable topology and readiness evidence after every running and stopped
predicate succeeds can advance readiness. Duplicates and disagreements preserve
admission blocking.

## Normative target-only: Commit, rollback, and atomic release

`TERMINAL_PROTOCOL.candidateCommit` requires a complete verified apply journal
with no pending boundary; fresh topology/readiness and absence evidence; exact
source-before, source-after-pull, candidate, build/install, symlink,
workflow/catalog, DB/schema, process, listener, and duplicate-exclusion proofs;
and a final gate/manifest/authority/capability/controller re-read. The durable
candidate-commit record binds all evidence digests before the lifecycle edge.

Rollback starts only under matching authority from contract-permitted precommit
states with a verified immutable snapshot and durable rollback disposition. Its
header binds the snapshot and exact apply-journal prefix and permanently closes
the forward route. Every restoration domain uses ordered before, action, after,
and verified records. `TERMINAL_PROTOCOL.rollbackVerification` requires
byte-and-metadata-exact source, artifact, workflow/catalog, DB/schema, topology,
endpoint, immutable identity, and original-intent restoration. Originally
running roles pass the full running conjunction; originally stopped roles pass
the full absence conjunction; both exclude duplicates under one authority
epoch.

There are exactly two terminal release sources: candidate committed and rollback
verified. `TERMINAL_PROTOCOL.release` first revalidates complete terminal peers
and publishes and fsyncs the immutable redacted completion audit. The audit
contains an audit-independent release intent, terminal disposition, source and
evidence digests, but no secret. The later release ledger binds both finalized
audit and release-intent digests, avoiding a digest cycle.

One `BEGIN IMMEDIATE` database transaction performs the final authority and
peer-evidence re-read, inserts the immutable release ledger, removes both work-
admission triggers, and deletes the active gate, then commits. Before commit all
blockers remain; after commit ledger plus audit plus gate absence prove release.
A precommit crash rolls everything back and authenticated recovery repeats the
full final read. A postcommit crash never recreates authority. Capability
destruction follows. Thus candidate success and verified rollback each expose
all release effects or none.

An unverifiable result preserves gate, triggers, snapshot, journals, and
artifacts in authenticated permanent blocking. The named operator action is
`tamandua-update-recover-authenticated-deterministic-verify`: it authenticates
the state-root owner, rotates the epoch capability, inventories peers read-only,
and executes only a contract-proved replay or verification action. Neither the
operator nor force can select an outcome or bypass terminal proof.

## Normative target-only: Total fault contract

The machine rows, not this summary, are operationally exhaustive. Every row
contains one boundary ID, durable state/evidence, detector, authorized next
actor, matching authority requirement, idempotent replay, deterministic fault-
class disposition, next action, work and service admission policy, public
result, and release-or-permanent-block condition. Process death is mapped at
each boundary where that actor can own, detect, or recover; union coverage is
insufficient.

`FAULT_CONTRACT.preHandoffAndBuild` covers before and after gate acquisition;
guardian spawn, positive handshake, and authority record; reserved owner escape;
legacy continuation defense; exact owner exit; dependency installation;
compilation; build artifact publication; and symlink/install. Mutation is
forbidden until positive guardian authority, legacy escape and owner exit when
applicable, and verified snapshot. Admission refusal leaves no transaction;
post-acquisition uncertainty preserves blockers.

`FAULT_CONTRACT.mutationServiceAndRelease` covers snapshot creation; every
source, installed-artifact, DB/schema, catalog, and workflow mutation; every
legacy/current process-unit stop and start in exact order; topology evidence;
full readiness; candidate commit publication; and atomic release. Each row
separates failure before durable publication from failure after publication.
Only the exact idempotent publication may repeat; a destructive boundary that
cannot be verified mandates rollback. Topology disagreement and duplicate
listener/process evidence permanently block rather than being adopted.

`FAULT_CONTRACT.rollbackAndRecovery` covers rollback start, one ordered restore
boundary for each inventory domain, rollback verification, rollback completion,
and guardian/recovery death at every durable boundary. Replay classification is
exclusively snapshot-and-journal based: no-before, before-without-after,
after-without-verified, verified, or malformed/conflicting. Uncertainty keeps
admission blocked and permits only authenticated deterministic recovery.

Across all groups, rows explicitly cover SIGKILL and power loss, candidate/
guardian/recovery death, PID reuse, host reboot, SQLite BUSY and I/O failures,
malformed or partially published evidence, insufficient disk and permissions,
source movement, old/new topology disagreement, and duplicate listeners or
processes. Every outcome is deterministic forward recovery, mandatory journaled
rollback, exact rollback recovery, or authenticated permanent blocking. No
unowned half-upgrade can be released.

## Normative target-only: Downstream implementation scopes

`DOWNSTREAM_SCOPES.scopes` defines the only eight planned scopes and
`DOWNSTREAM_SCOPES.productionSurfaceOwnership` assigns each abstract and
concrete production surface exactly once. Every scope declares prerequisites,
obligations, exclusions, consumed contract sections and identifiers, owned
surfaces, black-box gates, and the same invariant floor. A downstream change
cannot relax force, authority, readiness, rollback, atomic release, artifact
durability, or fail-closed disagreement behavior locally.

| Scope | Bounded obligation and black-box gate |
|---|---|
| HARN | Import `scripts/update-contract.mjs` directly; execute the unmodified immutable legacy commit against a candidate using fake services, isolated temporary state, random ports, no live user state, and zero model tokens; cover no-change, force, refusal, acceptance, reserved exit, and re-entry observations. |
| ADMIT | Implement entry routing, ordered observational admission, gate/manifest acquisition, and the sole atomic release primitive; prove no pre-admission mutation and no force bypass. |
| HAND | Implement detached guardian spawn/positive handshake, reserved exit `75`, exact owner-exit proof, forward orchestration, and candidate commit; prove old in-memory continuation cannot run and no pre-handoff mutation occurs. |
| TOPO | Implement the two versioned process-unit lifecycle plans and exact original-intent restoration; prove hosting, order, endpoint ownership, and hybrid rejection. |
| RECV | Implement authenticated authority rotation, crash classification, replay delegation, readiness/absence collection, and deterministic recovery; prove process absence and observations never grant authority. |
| SNAP | Implement the sole artifact codec, bounded atomic publication, complete snapshot, and apply/rollback journals; prove every restoration domain and cross-filesystem refusal. |
| ROLL | Implement irreversible rollback start, all ordered restore actions, exact verification, completion, and a call to the ADMIT-owned release primitive; prove no skipped/reordered restore or forward re-entry. |
| FAULT | Implement isolated injection and total boundary/disposition auditing with test-only hooks; prove all rows against fake services and temporary state without production backdoors, live state, real services, model tokens, or retry masking. |

HARN is the next acceptance gate, but contract-only SPEC does not implement it.
The macOS blocker above must remain visible to HARN and prevent Darwin production
qualification until its native identity resolution is complete. Later scopes
must consume the canonical source directly and reject any missing identifier,
matrix row, evidence field, or invariant rather than inventing a local default.

## Review and change control

A protocol change is acceptable only when machine-contract closure tests,
document coverage tests, focused behavior tests, typecheck/build, and the exact
regular suite pass on the same committed tree. Contract-only work must not wire
production entrypoints, touch live state, start or stop real services, install
workflows, or run model-token E2E tests. Unknown safety behavior is resolved by
preserving blockers and requiring authenticated deterministic recovery; it is
never filled in by local inference.
