# G8 Admission Integration — wiring and qualification record

Bead: `tamandua-7p5.1.8` (G8 ADMISSION-INTEGRATION).
Branch: `feature/g8-admission-integration` (local only; nothing pushed, no GitHub).
Run that delivered it: `321f06ae-b6af-40a0-9a0c-0ee467d4f5e6` (run number 185,
workflow `feature-dev-merge-worktree`).

This file is the checked-in record of (a) how the launch gate is wired, (b) what
was qualified through the real run path and what was not, and (c) how gate-only
results differ from combined-tree results. It deliberately separates *product
pass*, *no-VM control pass*, and *ENVIRONMENT block*: a sandbox that cannot boot
a VM is an environment fact, never a product pass.

## Status at a glance

| Item | State | Evidence |
| --- | --- | --- |
| Wiring (three caller paths, four invocation kinds) | Delivered | `src/installer/matchlock/launch-gate-wiring.ts` + the callers in §1 |
| Controller backstop bound to THIS invocation | Delivered | `src/installer/matchlock/controller.ts` `requireLaunchGateVerdict` |
| Refusal: receipt first, zero creates, exit 78 imported | Delivered | §2; `launch-gate-integration.test.ts`, `gate-adoption-guard.test.ts` |
| Revalidation by `(dev, ino)` + config | Delivered | `launch-gate-revalidate.ts`; §4 |
| G9 adoption audit | Complete — nothing missing at the base | §8 |
| Artifact + candidate binding, guest-visible config | Delivered | `gate-qualification.ts`, `gate-config-probe.ts`; §9, §10 |
| Scenario A1 (refusal through the real run path) | **PASS on this host** | §13, §14 (real daemon → scheduler → Matchlock hermes) |
| Scenario A2 (admitted store boots and closes a real VM) | **ENVIRONMENT block on this host** (VM boot) | §11, §13; A1/A2 evidence dirs |
| Scenario C1 (mixed native/guest overlap) | **ENVIRONMENT block on this host** (VM required); its properties run in the fast suite | `tests/matchlock-scenario-c-controls.test.ts` |
| Scenario C2 (transient rollback-journal refusal, then allow) | **PASS on this host** | §11, §14 (no VM needed) |
| Gate-only and combined full-suite sets | Both recorded separately | §12 |

---

## 1. Callers, invocation kinds and the mandated order

There is exactly **one evaluator implementation**
(`evaluateAndRecordLaunchGate` in `src/installer/matchlock/launch-gate-wiring.ts`)
behind four invocation kinds and one controller backstop. The wiring consumes
`launch-gate.ts`, `store-set.ts`, `store-header.ts`, `store-observation-adapter.ts`,
`gate-receipt.ts`, `launch-gate-revalidate.ts` and `gate-exit-code.ts` as they exist; it
does not re-implement any of them.

### 1.1 The order at every caller (no shortcuts)

1. resolve profile + selection;
2. resolve the **final** mount plan (the plan that will be handed to the
   controller — never a rebuilt one);
3. build the store set; an inventory that cannot be built is an operational
   refusal (`StoreSetInputError`), never a partial set;
4. observe headers + sidecars + config for **every** discoverable store
   (aggregate, never short-circuit: a throwing observation becomes
   `path-unresolved` and the other stores are still observed);
5. evaluate, aggregating **all** findings;
6. revalidate membership + config by identity (§4);
7. only then create the VM, mount and run.

### 1.2 The callers

| # | Caller | Where | Kind recorded in the receipt |
| --- | --- | --- | --- |
| 1 | interactive `matchlock hermes` | `interactive-session-plan.ts` (`planInteractiveSession`) calls `evaluateInteractiveLaunchGate` **after** the hermes selection is resolved and **after** `admitMatchlockRun` returns, and **before** the plan is returned to the caller/controller | `interactive-hermes` |
| 2 | interactive `matchlock hermes-shell` | same path; only the subcommand differs | `interactive-hermes-shell` |
| 3 | scheduled dispatch | `scheduler-matchlock.ts` `runMatchlockSchedulerRound` → `applyScheduledLaunchGate` → `evaluateScheduledDispatchGate` (`launch-gate-scheduled.ts`), after the short-HOME alias step and before the route dispatch | `scheduled-dispatch` |
| 4 | scheduled attempt | `runProductionHermesRound` → `applyScheduledAttemptGate` → `evaluateScheduledAttemptGate`, immediately before the invocation (a queued round can wait hours, so a stale dispatch verdict must not launch) | `scheduled-attempt` |
| — | controller backstop | `controller.ts` `prepareAndCreate` → `requireLaunchGateVerdict`, after `requireLifecycleOpen` and before the SUN_LEN guard, `invoked = true` and the dsh overlay staging | not a receipt; it refuses with `matchlock_gate_verdict_missing` |

The interactive path runs AFTER admission on purpose: the receipt and the
admission anchor name the pinned image identity admission returned, so the
evidence binds a decision to the artifacts that would have executed. A refusal
throws `LaunchGateRefusalError` **unchanged**; no plan object is ever produced
on a refusal, so there is no plan to hand to the controller.

### 1.3 Invocation ids (what "this invocation" means)

| Kind | Id shape |
| --- | --- |
| interactive | `interactive:<subcommand>:pid:<pid>:start:<ISO instant>` (captured before any awaited work, so a slow admission cannot make it drift); an unbound hermes plan that has no verdict uses `interactive:<subcommand>:unbound` and the controller refuses |
| scheduled | `run:<bare-run-id>:round:<jobId>:dispatch` / `...:attempt` — run ids are stored BARE (`run-` stripped) so both spellings produce ONE evidence slot, and the dispatch job id is deterministic per (workflow, run, agent), so a resume re-uses the same receipt path (the newest evaluation overwrites it, which is the honest record) |

## 2. Refusal semantics

- **The receipt is written FIRST.** `writeRefusalReceipt` runs before the refusal
  is returned; the refusal result carries `receiptPath` and `receiptWritten`.
- **Zero create calls, no partial mount.** The wiring never creates, mounts or
  dispatches anything on a refusal, and the controller backstop refuses before
  any state mutation or RPC child spawn. The integration test asserts a
  create-call count of ZERO and an absent fake-RPC transcript (proof that no RPC
  child ran at all, not merely that no `create` frame was sent).
- **Exit status is imported, never spelled.** Every surface calls
  `exitCodeForGateOutcome(...)` or uses `LAUNCH_GATE_REFUSAL_EXIT_CODE` from
  `src/installer/matchlock/gate-exit-code.ts` (78). No gate module contains a
  numeric status literal, and `gate-adoption-guard.test.ts` fails any file other
  than `gate-exit-code.ts` that claims 78.
- **A receipt-write failure is itself a refusal** — an OPERATIONAL refusal
  (`receiptWritten: false`), never an allow and never one of the ten reason codes.
- **A scheduled refusal must not re-dispatch.** The run state machine supports
  exactly one blocking-equivalent for this: `forceFailRun(runId, reason, true)`
  → `runs.status = 'failed'`, `scheduling_status = NULL`, steps canceled, crons
  torn down; every later tick returns at the scheduler's `run_not_running`
  guard. `scheduling_status = 'error'` is NOT a guard (`reconcileOnce()`
  re-admits `NULL|pending_register|active|error|waiting` while the run is
  `running`), so it cannot be used. The refusal records ONE
  `run.matchlock_gate_refused` event (deduped on a matching invocationId) whose
  `findingCodes`/`storeSetKey` are read back from the receipt, then exits the
  round through `gateRefused: true` so no instant-fail / pre-claim / orphan
  accounting sees it — the 18-round retry loop of the incident is not
  reproducible by a refusal.
- **The reason vocabulary is closed at exactly ten codes**, in canonical order
  (`REASON_CODE_ORDER`): `not-delete-config`, `wal-header`, `header-unreadable`,
  `header-not-sqlite`, `header-truncated`, `sidecar-unresolved`, `store-missing`,
  `inventory-incomplete`, `path-unresolved`, `permission-denied`. Operational
  failures (receipt write, revalidation, evaluation crash) are a SEPARATE class
  and are never renumbered into these ten. A revalidation change is therefore
  recorded as `verdict: 'refuse'` with `findings: []`.
- **Never claim the header proves DELETE.** The header proves the file's
  rollback-vs-WAL format; the config check proves the requested mode. A rollback
  header is recorded as `rollback-format`, never as proof of `journal_mode=delete`.

## 3. Evidence paths: receipt, qualification record, admission anchor

All three live in the same directory (`<stateDir>/matchlock/gate/`) so the
decision and its binding travel together. `stateDir` is the effective
`TAMANDUA_STATE_DIR` (default `~/.tamandua`).

| File | Path rule | Purpose |
| --- | --- | --- |
| Gate receipt | `<stateDir>/matchlock/gate/<sanitized invocationId>.json` (`resolveLaunchGateReceiptPath`) | schemaVersion 1 (`GATE_RECEIPT_SCHEMA_VERSION`); written on BOTH paths (`action: "refused"` before any VM, `action: "launched"` only after `vmCreated: true`) |
| Qualification record | `<receipt stem>.qualification.json` (`resolveQualificationRecordPath`) | schemaVersion 1, `recordKind: "matchlock-gate-qualification"`; artifact + candidate binding (§9) and guest-visible config (§10) |
| Interactive admission anchor | `<receipt stem>.admission.json` (`resolveInteractiveAdmissionAnchorPath`) | `recordKind: "matchlock-admission-anchor"`; the pinned image digest/config digest/tag and profile home admission returned (the G9 receipt schema is closed, so this is a SIBLING file, never an invented receipt field) |

Sanitization: an unsafe invocation id has every character outside the safe set
replaced, is truncated, and (when anything was replaced/truncated, or the result
is empty/`.`/`..`) gains a 16-hex sha256 suffix, so two ids can never share a
receipt. An anchor or qualification record that cannot be written is an
OPERATIONAL refusal, never a silent allow.

## 4. Revalidation by identity: `(dev, ino)` + config, and the accepted window

`launch-gate-revalidate.ts` is the production default of the wiring's
`revalidate` seam. It re-proves exactly two things immediately before the VM
create:

1. **Membership and identity** — every bound canonical path is re-stat'ed with a
   bigint stat and its `(dev, ino)` pair compared as DECIMAL STRINGS (never
   numeric `===`); the current store set is re-resolved for the appeared-store
   direction, so an added path and a removed path are both `store-set-changed`.
   A store swapped for a WAL copy at the same path is caught by
   `store-identity-changed`.
2. **Config** — the effective journal mode is re-read through the injected
   `resolveEffectiveJournalMode` and `journalMode` + observed-ness + source are
   compared; an edited config (`delete` → `wal`) or a config that became
   unobservable is `config-changed`.

**What is NOT re-read, and why that is disclosed:** the store header is not
observed again. The module imports neither `store-header.js` nor
`launch-gate.js` (a source-scan test pins that), so "the bytes changed but the
inode did not" is an accepted, disclosed window. The contract is membership +
config only; anything that cannot be proven counts as a change (fail closed).

A change is an OPERATIONAL refusal (`findings: []`, exit 78), never an eleventh
code: a changed world is not a store condition.

## 5. Controller backstop: bound to THIS invocation

The backstop is not "some earlier verdict exists". It binds a preflight result
to its inputs: `MatchlockControllerOptions.launchGate = { invocationId, binding }`
and `prepareAndCreate` refuses with `matchlock_gate_verdict_missing` unless ALL
three facts hold:

1. `binding` is non-null;
2. `binding.invocationId === launchGate.invocationId` (same run/round/invocation);
3. `binding.storeSetKey` is non-empty (the verdict actually bound a store set).

The controller never re-evaluates the gate and never falls back to a foreign
verdict; a refused launch has no host side effect and does not consume the
single-shot invocation. The controller TYPE-imports `LaunchGateBinding` only, so
the compiled controller has no runtime dependency on any gate module. When
`launchGate` is absent the behaviour is byte-identical (native pi/dsh runs).

## 6. No lease

The gate is a pre-flight check, not an ownership control. There is no
reservation, lock or mutual exclusion:
**no-lease: concurrent admissions may both pass**.
That sentence is emitted inside every receipt and qualification record
(`NO_LEASE_LIMITATION`) so no reader can infer exclusion the gate does not
provide.

## 7. Scope: what is gated, what is explicitly out of scope

Gated kinds (the qualification record's `scope.gatedKinds`, emitted from
constants): `interactive-hermes`, `interactive-hermes-shell`,
`scheduled-dispatch`, `scheduled-attempt`.

OUT OF SCOPE, recorded explicitly (`GATE_QUALIFICATION_OUT_OF_SCOPE`): **raw
`matchlock run` with a hermes payload**. It never passes through a wired caller,
so no verdict and no qualification record is produced for it. The G9 receipt
records the invocation KIND it was asked about (it has no out-of-scope field by
design); the qualification record carries the explicit `scope.outOfScope` entry,
which is how the scoping stays visible in the evidence.

Native (non-Matchlock) runs do not call the wiring at all.

## 8. G9 adoption audit

**Nothing was missing at the base.** G9's contract is fully present in
`e6a4cf50` (an ancestor of this branch):

| G9 piece | Present at base | Consumed how |
| --- | --- | --- |
| `LAUNCH_GATE_REFUSAL_EXIT_CODE = 78`, `exitCodeForGateOutcome`, `OperationalRefusal` (`gate-exit-code.ts`) | Yes | imported by `launch-gate-wiring.ts`, `launch-gate-interactive.ts`, `src/cli/commands/matchlock.ts` |
| Ten-code order (`REASON_CODE_ORDER` in `launch-gate.ts`) | Yes | not modified; the closed set the evaluator and renderer share |
| `renderGateRemedyText` (`gate-remedy-text.ts`) | Yes | the interactive adapter returns `remedyText` FIRST; the CLI renders through `renderInteractiveLaunchGateRefusal` and never imports the renderer directly |
| Doctor report-only gate + live holder detection (`0fdd5e50`, `10b5a7bd`) | Yes | unchanged; holder detection is informational and never a reason code |

Adoption is pinned structurally by `src/installer/matchlock/gate-adoption-guard.test.ts`
(comment-blind source scans): exactly one exit-status owner (78 claimed by no
other file), the exact importer set of `gate-exit-code.js`, the two
`exitCodeForGateOutcome` call sites, the single ten-code declaration, and the
single renderer. The guard's efficacy was proven by mutation: appending
`process.exit(78)` to `launch-gate-revalidate.ts` made three independent tests
fail; the file was restored and the tree verified clean. No G9 module was
modified.

## 9. Artifact binding (what a decision is bound to)

Every qualification record binds the decision to the artifacts that actually
executed — not to a checkout that merely exists:

| Field | Value for the recorded real-run evidence | Source |
| --- | --- | --- |
| Tamandua commit (executed dist) | `86ad720d2be50ad4c6f0f1a1575e7127b7c29d6d` (A1/A2); `3ae284b0789dabe6e51b9e126df9be5669cb7e7b` (C2) | `dist/version` stamp read by the record (`distVersionStampCommit`); a caller's conflicting commit is never written as the executed identity |
| Tamandua tree | `94483bbe4d1463cec27d613907fbf6f18d902f47` (A1/A2); `fa4571cc896166db8c6eb9d7a8032e7479409841` (C2) | caller/source identity; an executed dist cannot prove a work tree, so it is `unreadable` when not supplied — never derived |
| Tamandua dist stamp | `20261024T052916Z_86ad720d…` (A1/A2); `20261024T090441Z_3ae284b0…` (C2) | `dist/version` |
| dist root + executed binary paths | measured from the module's own location (`dist/installer/matchlock/x.js` → `dist`) + the resolved absolute binary paths | `candidate` block |
| matchlock path / sha256 / version | `/usr/local/bin/matchlock`; `4b9723359f734f63e2cb52308696c6c52a7b193b2b1858b6e62a58f83c0e3297`; `matchlock version 0.2.18-blip` | resolved from PATH (unpinned by design, MTLK-UNPIN) and hashed |
| guest-init path / sha256 | `/usr/local/bin/guest-init`; `afd6878bf45cd443cda6a8a29c3a153d1cf5cd0b82dc6b26d5fea7ab9312e940` (A1/A2). C2 ran with guest-init UNSET, recorded as `unset => resolved by matchlock` — never a fabricated hash | resolution + `sha256` |
| Selected image | `tamandua-synthetic-hermes:gate-fixture` → `sha256:2b2991ff06ee632c142284fd1ba329ec60fada650bc68d216b7f6323a93bd251`, config `sha256:5c6bfd091542fade3f56f40c0a369f74c378175cfe1fc02121237fbba853a700` (A1/A2); `tamandua-g8-admission-probe:image` → `sha256:818f4fec6635a1249031b05f9949fb7f18fbe69cc693940257a49464e4f8f275`, config `sha256:f200a956995c380d75a6c3e61958c220b2f39264b02a7157db1e3f8f6c0d563a` (C2) | admission's `PinnedImageIdentity`; image digests keep their conventional `sha256:` form |
| Profile / config sources | `profiles.hostEffectiveDir` = the disposable scenario `home/.hermes`; `guestHermesHome` = the guest config dir; `configSources` = deduped, byte-sorted config layers that fed the verdict (e.g. `host-observed: user config <home>/.hermes/config.yaml, then managed scope: none`) | gate selection + the effective-journal-mode observation |
| Run / attempt evaluated | `invocation.runId` / `invocation.roundId` only when the invocation carried one (interactive invocations have neither and are not padded with empty strings); the receipt FILENAME identifies the invocation for `scheduled-*` because the G9 receipt schema has no invocation-id field | decision |

Honesty rules baked into the record: unmeasurable values are PRESENT as
`unreadable` (never omitted, never fabricated); the serializer builds objects by
whitelist (no raw argv, no file contents, no config bodies); credential-shaped
text is scrubbed; the `scope` block is emitted from constants so a hand-edited
record cannot claim a different gated-kind set or a lease.

### Docker evidence vs the repository image — labelled, not equated

The stock-Hermes delete-mode qualification in
`docs/gate/G1-B-STOCK-RUNTIME-QUALIFICATION.md` was obtained from the **Docker
artifact** `sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a`
(`linux-amd64`). Matchlock resolves this repository to a **different**
identifier, `sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff`.
That evidence is therefore labelled **Docker evidence** here: different
identifiers are NOT proof of equivalence, and the relationship between the two
artifacts remains UNVERIFIED until it is established by INSPECTION. No gate
claim in this document rests on the Docker evidence.

## 10. Guest-visible effective config per store

A guest's effective config is what is visible INSIDE the guest. Host-side reads
do not establish it, and the record never presents one as the other:

- `src/installer/matchlock/gate-config-probe.ts` is a Node-core-only standalone
  helper shipped in the RO pack (`<pack>/lib/installer/matchlock/gate-config-probe.js`).
  It reads the guest-visible layers (`<HERMES_HOME>/config.yaml`, then the
  managed layer resolved INSIDE the guest: explicit override → `$HERMES_MANAGED_DIR`
  when it is a directory → `/etc/hermes` when it exists → none; the managed leaf
  wins) and prints ONE bounded JSON line per store. It is read-only and never
  creates, converts, repairs or deletes anything.
- Every entry is `perspective: "guest"`; `provenance` is `measured`,
  `unmeasured` or `unknown` — never a fabricated `delete`. An unreachable probe
  records `unmeasured` with no mode.
- Probe sources are `guest-observed:` prefixed (host observations are
  `host-observed:`), so the two perspectives can never be conflated.
- `gate-guest-visibility.ts` performs ONE exec for the whole store set, maps host
  store identities to their guest spellings (a store outside the mount is
  recorded `unmeasured` with its HOST spelling, never a guessed guest path),
  attaches the entries to the existing record, and sets the top-level
  `discrepancy` flag ONLY when a MEASURED guest mode disagrees with a REAL host
  mode. The verdict is never touched; a disagreement is evidence, not a second
  decision.
- The after-boot capture in `hermes-invocation-runner.ts` runs only for gated
  (`opts.launchGate !== undefined`) invocations, after the VM exists and before
  the harness exec; a probe failure is logged and returned, never thrown. On
  this host the round-level MEASURED guest mode is unproven (the sandbox cannot
  boot a VM), so the record carries `unmeasured` entries rather than a guess.

## 11. Mixed overlap outcomes (scenario C)

Both outcomes are compatible with the design: neither unconditional admission
during every transaction nor process-lifetime exclusivity is claimed.

- **C1 — overlapping NATIVE and GUEST writers (real VM required).** A native
  host writer process commits single-row transactions while the admitted guest
  round writes the same mapped store from inside the VM; afterwards every
  committed record must be retained, the guest's sessions row must be present,
  and `PRAGMA integrity_check` must be `ok`, with a measured overlap > 0. A real
  guest round cannot run on this host (ENVIRONMENT, §13), so the C1 *properties*
  are instead exercised on every `npm test` by
  `tests/matchlock-scenario-c-controls.test.ts` (serial lane, real writer
  processes) and by the gate's C1 no-VM control. **Not yet qualified through a
  real VM on this host.**
- **C2 — the transient rollback-journal refusal (no VM needed, PASS).** With a
  NONEMPTY `-journal` sidecar beside a compliant rollback store, the gate
  refuses through the real run path with `sidecar-unresolved` and the ROLLBACK
  journal remedy (`a checkpoint is NOT a treatment for it`, `may be TRANSIENT`,
  the `hermes sessions set-journal-mode delete` conversion) and zero VMs; the
  journal is preserved (4096 bytes) and never deleted by the gate. After
  quiescence the journal is removed and the SAME run's frozen persisted policy
  re-evaluates to ALLOW (`configJournalMode: delete`, its own store-set key,
  invocation `run:…:round:…:attempt`).

## 12. Results — two SEPARATE result sets

The qualified overlay fix (`926f589d`, line `integration/dev16-overlay-cont`) is
**not** an ancestor of the gate line, so a gate-only pass does not cover it. Both
lines were integrated into ONE identified candidate and each candidate was
built and tested separately. Exact command in every case:

```
tamandua-test --repo '<worktree>' --run '321f06ae-b6af-40a0-9a0c-0ee467d4f5e6' --step implement -- 'npm test'
```

### Gate-only set (no overlay-line code)

- candidate `1583caedc4a17292e51758394bdd54c8471d7d42`, tree
  `84d957ae7936ad7c5143ef71f90effcc8fe80ef8`
  (= `1c7719e2` + the union-merge history-tolerance test fix, nothing else)
- `npm run build` rc=0; dist stamp `20261024T105017Z_1583caed…`
- TEST_CMD **exit 0** — serial lane: tests 5965 / pass 5951 / fail 0 / skipped 14
  (2346.3 s); parallel lane: tests 5776 / pass 5771 / fail 0 / skipped 5 (25.3 s)
- log: `/home/kaladin/matchlock-work/evidence/us014-combined-20261024T095817Z/gate-only-testcmd.log`

### Combined set (gate line + overlay line + combined-tree test + history fix)

- candidate `e9799edcec583175f1c85f5e79d099e3d2107666`, tree
  `897766277c63da17dc307c4e3c0b7dfd6dd3e5f4`
- merges: `1c7719e2` (parents `3ae284b0` + `9961383f`) and `9b0d6631` (parents
  `1c7719e2` + `926f589d`); `git merge-base --is-ancestor` proves `e6a4cf50`,
  `0fdd5e50`, `10b5a7bd`, `9961383f`, `3ae284b0` (and all 13 gate stories),
  `926f589d`, `f54897c1` and `5589eaf3` are ancestors
- `npm run build` rc=0; dist stamp `20261024T105012Z_e9799edc…`
- TEST_CMD run 1 **exit 1** — serial 5983 / pass 5968 / fail 1 / skipped 14,
  parallel 5827 / 5822 / 0 / 5. The single failure is the load-sensitive
  `src/server/daemonctl.test.ts:1233` "startDashboardStandalone() … port is
  already occupied" flake; isolated re-runs were 54/54 green ×3 and the combined
  diff contains no `src/server` change. Both runs are recorded rather than
  re-run until green.
- TEST_CMD run 2 **exit 0** — serial 5983 / pass 5969 / fail 0 / skipped 14,
  parallel 5827 / 5822 / 0 / 5
- logs: `combined-testcmd.log`, `combined-testcmd-rerun.log`; roll-up
  `results.json`, narrative `SUMMARY.md`, ancestry `ancestry.txt`
- targeted at the combined candidate: gate family + combined-tree test 208/208;
  overlay family 281/281; lane/isolation/temp-dir guards 27/27;
  `npx tsc --noEmit -p tsconfig.json` rc=0

The gate-only numbers (5965 serial / 5776 parallel) contain no overlay code, so
they do not cover `926f589d`; the combined numbers (5983 / 5827) are the ones
that exercise both lines.

## 13. ENVIRONMENT: real-VM boot is blocked in the agent sandbox

The developer agent sandbox runs with `NoNewPrivs: 1` and `CapEff: 0`, so
matchlock's file capabilities are suppressed and the first VM create fails:

```
create VM: create TAP device: TUNSETIFF: operation not permitted
reconcile nftables rule: netlink receive: operation not permitted   (matchlock rm)
```

This is recorded as an ENVIRONMENT signature — never a product pass and never a
product failure. The gate captures it (`environment-blocked.json`) with bounded
context, fails hard when an owned VM cannot be closed (retained state is never
erased to look clean), and `t.skip()`s only when cleanup succeeded. The
operator/tester runs the real-VM tiers outside the sandbox under the shared gate
lock.

Three stopped VM rows from the sandbox attempts still need privileged disposal:
`vm-5e383f7c` (AOJMsL), `vm-fbaf5f84` (a4Rkra), `vm-b672b943` (us012-a1-debug),
each retained under its evidence dir's `scenario-a/*/home/.matchlock`.

## 14. Dogfooding record

How this bead was dogfooded:

| Field | Value |
| --- | --- |
| Run id | `321f06ae-b6af-40a0-9a0c-0ee467d4f5e6` (run number 185) |
| Workflow / harness | `feature-dev-merge-worktree` / **hermes** (`hermesType: hermes`, Landlock isolation, native — `runs.matchlock_policy = NULL`, `runs.isolation_intent = NULL`, so this run itself is NOT gated: native runs are untouched by design) |
| Start commit + tree | `e6a4cf50235892d811ad8558e2da3a5c63c40c4d` / `55090f94c73d13d8eac83e64ed8e845971868160` (the branch point of the G8 delivery: the G9 exit-code/remedy commit) |
| Delivered (qualified) commit + tree | `e9799edcec583175f1c85f5e79d099e3d2107666` / `897766277c63da17dc307c4e3c0b7dfd6dd3e5f4` — the combined candidate all of §12's combined numbers were produced on. THIS document commit sits on top of it and changes no product code; its own id is recorded in the run's progress log and CHANGES (a commit cannot contain its own hash) |
| Refusal receipt (real run path) | `<EV>/scenario-a/A1-refusal/home/.tamandua/matchlock/gate/run_1f8563c8-ff1a-4dda-9954-1e49e293f34f_round_tamandua-do-now-1f8563c8-ff1a-4dda-9954-1e49e293f-862022f82186f152.json` (`<EV>` = `/home/kaladin/matchlock-work/evidence/us012-a1-debug2`) — `verdict: refuse`, `action: refused`, finding `wal-header`, exit 78, zero owned VMs |
| Refusal receipt (C2, sidecar) | `<EV>/scenario-c/C2-journal-transition/home/.tamandua/matchlock/gate/run_38851dd6-3399-4bc4-80c0-db4b2b7dfa31_round_tamandua-do-now-38851dd6-3399-4bc4-80c0-db4b2b7df-f9ffa50f7ece334f.json` (`<EV>` = `/home/kaladin/matchlock-work/evidence/us013-c2-zEw2Fm`) — finding `sidecar-unresolved` |
| Allow (gate decision) | the C2 allow leg: invocation `run:38851dd6-3399-4bc4-80c0-db4b2b7dfa31:round:job-do-now_doer:attempt`, `configJournalMode: delete`, store-set key `sha256:b1a0169cf102bf51659d56f2a40c352b20f0028b58e5e007fc6bd9954ee2266e`. No `launched` receipt exists on this host: it is written ONLY after `vmCreated: true` (by design), and A2's VM create was blocked by the sandbox — recorded honestly as an ENVIRONMENT block, not as an allow receipt |

Evidence dirs: `admission-qualification-AOJMsL` (US-012 A1/A2 driver run),
`us012-a1-debug2` (A1 debug re-run), `us013-c2-zEw2Fm` (C2 pass),
`us013-c2-UQETQE` (C2 attempt that exposed the operator-home mtime churn —
fixed by comparing entry sets + config identity), `us014-combined-20261024T095817Z`
(combined candidate + both result sets). Each scenario writes
`evidence.json` + `commands.txt` + `notes.txt` with the run id, harness,
start/delivered commit+tree, receipt paths, digests, image identity and the
exact commands.

## 15. Exact commands used

```
# the qualification driver (builds, takes the shared gate lock, private HOME/TMPDIR/state,
# seeds a private image store, runs the gate, then refuses a zero-round PASS with exit 92)
./run-matchlock-admission-qualification-e2e-test

# C2 through the real run path without a VM (the no-VM half of scenario C): the driver
# surroundings replicated by hand — private HOME/state/TMPDIR, mtlk_image_store_seed,
# mtlk_gate_lock_acquire in the CURRENT shell + MTLK_GATE_LOCK_HELD=1 — then:
node --test --test-name-pattern 'scenario C2: a nonempty rollback journal' \
  e2e-tests/matchlock-admission-qualification-gate.test.ts

# builds and the two full-suite sets (see §12; exact transcript in commands.txt)
npm run build
tamandua-test --repo '<worktree>' --run '321f06ae-b6af-40a0-9a0c-0ee467d4f5e6' --step implement -- 'npm test'
node --test --test-concurrency=1 <gate family + launch-gate-overlay-combined>
node --test --test-concurrency=1 <overlay family + matchlock-union4-merge>
npx tsc --noEmit -p tsconfig.json
```

## What remains open

1. **A2 and C1 need a VM-capable host.** Run
   `./run-matchlock-admission-qualification-e2e-test` outside the agent sandbox
   (privileged session, shared gate lock) to qualify the admitted real-VM boot,
   the `launched` receipt, the qualification record bound to a booted VM, and
   the mixed native/guest overlap.
2. **Privileged disposal** of the three stopped VM rows listed in §13.
3. The driver header still describes the pre-US-012 state of its scenarios; the
   scenarios now exist (A1 always runs; A2/C1 require a VM-capable host and
   otherwise record ENVIRONMENT and the zero-round guard refuses PASS with exit
   92). Update it when the driver is next touched.
4. **The AGENTS.md G8 section has NOT been applied.** The write was blocked by
   the harness protection on agent-instruction files (the approval prompt timed
   out; silence is not consent, and this agent does not retry a blocked write or
   route it through another path). The exact section text is in Appendix A so an
   interactive session can apply it with one paste. `tests/g8-admission-docs.test.ts`
   pins this disclosure: it fails if AGENTS.md lacks the anchor AND the document
   stops recording the gap, so the requirement can neither be forgotten nor
   silently claimed.

## Appendix A — AGENTS.md G8 section (text to apply; currently NOT applied)

```markdown
### G8 launch-gate admission (G8-ADMISSION-INTEGRATION)

The Matchlock launch gate (bead `tamandua-7p5.1.8`) refuses a hermes launch
BEFORE any VM create when a store cannot be launched against the
delete-journal contract. ONE evaluator
(`src/installer/matchlock/launch-gate-wiring.ts` `evaluateAndRecordLaunchGate`)
runs the mandated order — profile+selection, final caller-supplied mount plan,
store set, observe EVERY store, aggregate all findings, `(dev, ino)`+config
revalidation, then create — and there are exactly four gated invocation kinds
plus one backstop:

- `interactive-hermes` / `interactive-hermes-shell` —
  `planInteractiveSession` (`launch-gate-interactive.ts`), after admission and
  before the plan is handed to the controller;
- `scheduled-dispatch` / `scheduled-attempt` — `scheduler-matchlock.ts`
  (`evaluateScheduledDispatchGate` / `evaluateScheduledAttemptGate`); a queued
  round can wait hours, so the ATTEMPT re-evaluates instead of trusting the
  dispatch verdict, and a refused round force-fails the run
  (`status='failed'`, `scheduling_status=NULL`, one
  `run.matchlock_gate_refused`) rather than re-dispatching;
- the controller backstop (`controller.ts` `requireLaunchGateVerdict`) refuses
  `matchlock_gate_verdict_missing` unless the binding belongs to THIS
  invocation id and carries a non-empty store-set key; it never re-evaluates.

Refusal is receipt-first (zero create calls, no partial mount) and exits
`LAUNCH_GATE_REFUSAL_EXIT_CODE` (78) imported from
`src/installer/matchlock/gate-exit-code.ts` — never a numeric status literal.
Receipts, qualification records and interactive admission anchors all live in
`<stateDir>/matchlock/gate/` (`<id>.json`, `<id>.qualification.json`,
`<id>.admission.json`); the reason vocabulary is closed at ten codes and
operational failures (receipt write, revalidation) are a separate class. There
is NO lease: concurrent admissions may both pass (`NO_LEASE_LIMITATION`). Raw
`matchlock run` with a hermes payload is explicitly OUT OF SCOPE. Full record:
`docs/gate/G8-ADMISSION-INTEGRATION.md`.
```

