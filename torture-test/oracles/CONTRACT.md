# Torture-test oracle executable contract

Contract version: **1**

Oracle hooks are mechanical checks. They may inspect the case manifest metadata,
contained Tamandua state, git plumbing, files, processes, and controller evidence.
They MUST NOT read an agent response or interpret agent prose as a verdict. The
controller intentionally supplies evidence references rather than response text.

## Host adaptation (predicates / host profile)

This contract governs the **single canonical host-adaptation representation**
and forbids any divergent one. The authoritative statement lives in
`tamandua-torture-test-spec/01-environment-and-isolation.md`; oracles that
consume manifest `requires` predicates or the W0.0-emitted `host-profile.json`
MUST follow it exactly:

- A toolchain predicate is satisfied **iff** `host-profile.json` records
  `toolchains.<name>.present === true` (Boolean leaf) using the profile's real
  key names (`python3`, `node`, `go`, `rust/cargo`, `java+maven`). No
  representation that reads toolchains as a flat boolean key
  (e.g. `toolchains.python3 == true`) or otherwise diverges from the
  Boolean-leaf/object shape is permitted here or in any case predicate.
- `requires.capabilities` entries `pi`/`hermes`/`dsh` map to harness presence
  recorded in the host profile (`harness.<name>.present`). W0.0 records
  mechanical presence (dsh honors `TAMANDUA_DSH_BINARY` first, then PATH
  discovery); it never installs.
- `requires.capabilities` entries that are NOT harness names resolve against
  the profile's recorded `capabilities.<name>` Boolean-leaf section (e.g.
  `node-runtimes-2` — recorded true iff W0.0 discovered ≥ 2 DISTINCT node
  runtimes/versions on the host; the W4.23 daemon-cross-runtime predicate
  source — and `daemon-scripted` — a Boolean leaf COMPUTED ON BOTH linux
  AND darwin, true iff the host has the scripted-daemon plain-background
  fallback launch prerequisites (bash AND nohup AND node resolvable via
  POSIX `command -v` PATH lookup; no procfs, no getent). `daemon-scripted`
  is the narrowest true requirement of the tier1 W2 scripted cells
  (W2.21, W2.23a/b/c) — it replaced their blanket `platform: linux`
  predicate, which vacuously gated them `NOT_RUN (predicate)` on a
  fully-capable Darwin host). An unrecorded capability name is honestly
  absent (null).
- An honestly-missing capability gates the case `NOT_RUN (predicate)` with
  expected/observed evidence — it is never silently skipped and never a
  failure.

## Discovery and invocation

For each oracle ID in a case manifest, the controller looks for an executable
regular file at `torture-test/oracles/<id>`. Symlinks, non-files, and files without
execute permission are treated as absent and recorded as `ORACLE_MISSING`.

A present hook is invoked without a shell:

```text
oracles/<id> --contract-version 1 --context <absolute-context-json-path>
```

The working directory is the hook's campaign-contained evidence directory. stdin
is closed/empty in version 1; hooks must not prompt or wait for input.

The controller supplies the case's selected real or scripted spawn environment,
plus these variables:

- `TT_ORACLE_CONTRACT_VERSION=1`
- `TT_ORACLE_ID=<manifest oracle ID>`
- `TT_ORACLE_CONTEXT=<absolute context JSON path>`
- `TT_ORACLE_EVIDENCE_DIR=<absolute writable evidence directory>`
- `TT_CASE_ID=<case ID>`
- `TT_CAMPAIGN_ID=<campaign ID>`
- `TT_RUN_ID=<full run ID>` when the case has an identified workflow run

The context file is a versioned JSON object containing campaign identity and
immutable manifest identity, case metadata, projected mechanical lifecycle state,
and references to immutable evidence snapshots. It does not contain command stdout
or stderr references, model transcripts, raw step output, `STATUS:` lines, agent
response prose, or the manifest's free-form launch context. Launch policy is supplied
through the captured `launch_intent` artifact described below, not copied from an
agent-writable run context.

### Version-1 input shape

The controller writes this exact top-level shape (fields shown as `null` are nullable
as described below):

```json
{
  "contract_version": 1,
  "oracle_id": "O2",
  "campaign": {
    "id": "campaign-...",
    "created_at": "2026-08-01T00:00:00.000Z",
    "manifest": {"sha256": "<64 lowercase hex>", "case_count": 1, "case_ids": ["W3.07"]}
  },
  "case": {
    "id": "W3.07", "wave": 3, "workflow": "bug-fix-merge-worktree",
    "fixture": "tt-ts", "harness": "hermes", "class": "verification",
    "caps": {"tokens": 4000000, "wall_min": 240},
    "boundary_files": ["fixtures/tt-ts/src"], "forbidden": [], "chaos": null
  },
  "run_id": "run-...",
  "attempts": [],
  "discovered_runs": [],
  "o1_wave": {"schema_version": 1, "wave": 3, "duration_floors": [], "runs": []},
  "mechanical_evidence": {"schema_version": 1, "references": {"...": null}}
}
```

`attempts` contains, in launch order: `id`, `kind`, `phase`, `execution_mode`
(`real` or `scripted`), nullable `run_id`, `started_at`, nullable `terminal_at`,
nullable `terminal_status`, non-negative `tokens_observed`, nullable
nullable `command_result` (`exit_code` and `signal` only), and nullable
`steps_snapshot`, plus nullable `straggler_capture`. A straggler capture is written by
the controller immediately before its own `workflow stop`: `captured_at`, identical
`stop_intent_at`, numeric cap `reason`, and a mechanical workflow-status
`steps_snapshot`. It preserves the live-claim pre-state that terminal harvesting would
otherwise erase; it is never inferred from an agent report.
`steps_snapshot` contains only `source`, `captured_at`, and `steps`. Each step is
projected onto IDs, agent ID or the CLI's mechanical `agentRole`, raw `status`, optional `displayStatus`/`display_status`, optional type/story ID, retry/abandon/reroute counters, step index,
claim PID/update time, and update time. In particular, step `output`, `error`, snapshot
database paths, and other provenance strings are excluded. `discovered_runs` uses the
same projection and adds `parent_run_id`. `run_id` is the most recently identified
root-attempt run ID, or `null` for a case without one. SQLite
`YYYY-MM-DD HH:MM:SS` step timestamps are normalized to canonical UTC ISO-8601 during
projection; all timestamps presented to an oracle are canonical.

`o1_wave` is a deterministic campaign-ledger projection used by O1's anti-gaming leg.
It contains the current wave number; one duration-floor row per launched case
(`workflow`, `case_id`, positive nullable `duration_floor_ms`, `source`, and
`sample_size`); and every launched root/discovered run in that wave (`case_id`,
`run_id`, workflow, start/terminal timestamps and status, the manifest boolean
`expected_fast_failure`, and the optional per-run `execution_mode`). When a case's manifest pins `production_duration_floor_ms > 0`,
that pin is the case's own floor and is recorded as `source=production-median`;
distinct pins across cases of one workflow family are per-case floors and are never
deduplicated. For cases without a pin, `source=w1-median` is computed from terminal,
non-fast-failure Wave-1 attempts for that workflow family; only attempts with
`terminal_status === 'completed'` enter the calibration sample (canceled and
runaway attempts never skew the median), the run under judgment (the case's own
latest attempt run) never contributes to its own calibration sample, and
`sample_size` counts the filtered sample. O1 suppresses the
`O1_DURATION_FLOOR_RATE` family finding when the wave's eligible family run count
is below 4 (the observation still records `run_count`/`fast_run_count`). "Eligible"
means real (non-scripted) runs only: scripted runs are excluded from both the
numerator and the denominator (see the anti-gaming section). If no
fallback exists the
row records `duration_floor_ms: null` with `source=unavailable` and O1 fails closed
for the case. Legacy family-wide floor rows without `case_id` remain accepted for
replay of older evidence and apply to every launched case of the workflow that lacks
its own per-case row. `expected_fast_failure` defaults false and is the
only exclusion from the wave-rate denominator. O1 fails closed if a launched case
has no floor row or duplicate rows for the same case (distinct per-case floors in one
family are never duplicates), or if a floor names a family absent from the wave's
launched runs; each run is judged against its own case's floor. Family-level
`O1_DURATION_FLOOR_*` findings describe the wave family as a whole, not one case:
they appear in the result of exactly one deterministic reporter case per wave —
the wave case whose `case_id` comes first in `campaign.manifest.case_ids` order —
and every other wave case excludes them from `result.findings`. The
`duration_floor_observations` evidence is still written for every case
(campaign-wide data); only the findings list is deduplicated. A case result may
only fail on findings whose details cite one of its own runs (run-scoped findings
such as `O1_DB_RUN_MISSING`/`O1_WAVE_RUN_MISSING`) plus the family findings when it
is the reporter; wave-level citations of a sibling case's run are the sibling's
failure, not this case's. For the current case,
O1 reconciles the wave projection against every
non-null root attempt and discovered run in the context and fails if any launched run
is absent, duplicated, or if a current-case wave row names an unknown run. Run IDs are
campaign-global, so duplicate rows are rejected even when they carry different case IDs.
The current-case row's workflow and start/terminal timestamps and status must exactly
match its root-attempt or discovered-run projection.

The per-run `execution_mode` (`'real'` or `'scripted'`) marks whether the run's case
executed in the scripted (zero-token) environment or a real harness. The controller
projects it onto the case state at campaign creation from the manifest record —
`context.execution_mode` when it declares `'real'`/`'scripted'` (this covers
`harness: 'local'` scenario cells that are scripted), else the harness decides
(`'scripted-pi'`/`'scripted-hermes'` → `'scripted'`, `'dsh'` always `'real'`,
anything else `'real'`). The field is OPTIONAL in stored evidence: campaign
contexts whose wave projection predates the field carry run rows without it and
still validate (schema_version remains 1); an O1 consumer that needs the mode on
such evidence may fall back to the case-level zero-token signal. When present it
must be exactly `'real'` or `'scripted'`.

### Local-case mechanical profile

Contract version 1 also supports controller-owned `workflow=local` commands without
a workflow run ID. The top-level context and evidence-key set remain unchanged. For
this profile, every evidence key required by the declared oracle resolves to the same
read-only, SHA-256-pinned artifact with `source=controller-local-case`; optional keys
remain null. Mixing that source with another artifact or hash is invalid.

The shared oracle runtime recognizes the profile only when the latest projected
attempt has `kind=local`, a null `run_id`, and a command result matching the pinned
proof. It then evaluates the proof mechanically inside the declared
`oracles/<id>` executable rather than fabricating a controller verdict. The proof
contains the command exit/signal projection, immutable scenario identity and oracle
declarations, parsed machine-readable scenario result, contained run-token rows, and
pre/terminal absolute system-token observations. Every local oracle gates command and
scenario success; O3z additionally gates complete zero-token reconciliation. The
normal oracle response, exit-code, stdout/stderr, context, and evidence-retention
contracts still apply. This profile never accepts agent prose or a `STATUS:` line as
evidence.

### Evidence reference type and containment

Every non-null value in `mechanical_evidence.references` has exactly this version-1
reference shape:

```json
{
  "path": "snapshots/attempt-1/database.sqlite",
  "sha256": "<64 lowercase hex>",
  "captured_at": "2026-08-01T00:00:00.000Z",
  "source": "controller-snapshot"
}
```

`path` is POSIX-style and relative to the campaign results directory (the directory
that contains `state.json`), never to the oracle working directory. Absolute paths,
backslashes, empty/`.`/`..` segments, missing files, directories, and symlinks are
invalid. The controller resolves and realpaths the file beneath the campaign directory,
requires a regular non-symlink file, and verifies `sha256` before invoking a gating
hook. Thus a context never instructs a hook to infer a fixture, production DB, or
`~/.tamandua` path. `captured_at` is canonical UTC ISO-8601. `source` identifies the
controller collector; it is provenance only and cannot override the artifact bytes.
SQLite artifacts are backups opened read-only by hooks; source database paths are not
published in the context.

### Controller snapshot lifecycle

For a case with an executable gating hook, the controller starts one attempt-scoped
snapshot after fixture reset and before workflow launch. It durably records `RUNNING`
before collection, captures launch intent, pre-launch refs, checksum baselines, and the
preflight system-token value, then records `BASELINE_CAPTURED`. After terminal run-graph
convergence and immediately before the first gating invocation, it captures the remaining
artifacts and atomically records `COMPLETE`. Every referenced file is SHA-256 pinned and
made read-only before the context is written.

The SQLite copy is made from the controller-selected `TAMANDUA_STATE_DIR` using an
explicit read-only source connection. The source DB, event directory, and fixture git
repository must all resolve beneath `torture-test/`; there is no HOME or
`~/.tamandua` fallback. A `RUNNING`, absent, malformed, or otherwise partial snapshot on
resume is `TEST_INFRA`, and no oracle is invoked from it. Snapshot ledgers and artifacts
live under `var/results/<campaign>/snapshots/<case>/<attempt>/`.

The `references` object always contains the following keys in this order. A key is
`null` only when it is optional for the invoked oracle; a required null blocks hook
execution as `TEST_INFRA`.

| Key | Mechanical contents and controller provenance |
|---|---|
| `database_snapshot` | Consistent read-only TT `tamandua.db` backup after terminal harvest; includes runs, steps, stories, suite ledger, and stats tables. |
| `run_events` | Run/case-scoped event rows copied from the contained TT event files and archives, with archive name and line number. |
| `workflow_status` | Timestamped `workflow status --json` observations projected onto mechanical status/display fields. |
| `launch_intent` | Pre-launch manifest policy, exact `merge_gate`/`fail_missing` argv, SHA-256 of the full workflow argv, prose-free argv projection, harness, fixture/repository identity, launch timestamp, and nullable immutable `gate_key` (`origin_repo` plus SHA-256 `cmd_hash` of the exact manifest `test_cmd_raw`/`test_cmd` bytes); captured before spawn. O2 and O10 require a non-null gate key and report `NOT_EVALUABLE` (never `ORACLE_RUNTIME_ERROR`) when it is null; O9 uses the gate origin plus the case's event-carried origins to scope its ledger bundle. |
| `git_bundle` | Campaign-contained git-common-dir tar snapshot sufficient for offline commit/tree/ancestry/patch-id plumbing, including unreachable retained test commits; refs artifacts name its captured origin identity. |
| `refs_before` | Pre-launch target tip and `for-each-ref` snapshot. |
| `refs_after` | Terminal target tip and `for-each-ref` snapshot. |
| `target_reflog` | Raw target-ref reflog captured mechanically, including old/new OIDs and reflog timestamps. |
| `checksum_baseline` | Baseline inventory of boundary, forbidden/bait, seeded-test, and expected-file paths with type/mode/SHA-256. |
| `checksum_terminal` | Terminal/merged-tree inventory and changed-path list using the same checksum schema. |
| `suite_ledger` | Read-only `suite_results` rows relevant to captured origins/trees/command hashes, including result, timestamps, duration, TTL, and exact key. |
| `suite_observations` | Ordered shim lookup/claim/execute/record/replay, cache-marker, force, exit-86/87/88, single-flight, and repository-drift observations. |
| `token_deltas` | Ordered `run.tokens.updated` events with run ID, delta, resulting total, step/round identity, and event timestamp. |
| `round_usage` | Harness trailer/session usage projected onto run/step/round, harness, timing window, and formula inputs; no transcript or model text. |
| `system_tokens_before` | Preflight `tamandua_stats.system_tokens_spent` observation from a read-only snapshot. |
| `system_tokens_after` | Terminal value of the same absolute-zero counter. |
| `submit_rejections` | Ordered submit-time validator attempts: claim/step/run IDs, attempt number, timestamp, validation code, missing/invalid keys, and actionable diagnostic code; no submitted output body. |
| `expects_validations` | Structured expects evaluations and accepted verdict transitions, including producer/consumer attribution and retry/done decision. |
| `dispatch_renderings` | Structured prompt-render validation: required keys and unresolved-placeholder count/keys only; the rendered prompt itself is excluded. |
| `probe_evidence` | E3.C lifecycle-probe evidence (US-003): the controller's probe sequencer artifact — ordered per-action records (op, phase trigger, start/finish timestamps, exact argv, CLI exit code, observed effect) written to `<campaign>/evidence/<case>/<attempt>/probe-evidence.json` and copied into the snapshot. Required by O16. |
| `chaos_log` | E3.C chaos-injection log (US-003/US-010): a snapshot bundle of `var/chaos/chaos.log` — the structured start/hold/cont/INVALID entries tt-chaos appends per injection — followed (when the process recorder sampled the campaign's `var/`) by the recorder-sample bundle (`# recorder-samples` marker + the recorder's 5s JSONL samples: ts/pid/pgid/ppid/cwd/cmdline/RSS/fd). Required by O4: the chaos entries distinguish a watchdog-killed live worker from a chaos-killed one, and the recorder samples are the liveness provenance. |

Required (`R`) versus optional (`—`) inputs for the nine gating hooks are pinned here
(O4 and O16 are the E3.C additions; their executables land with US-009/US-010):

| Evidence key | O1 | O2 | O3z | O4 | O8 | O9 | O10 | O11 | O16 |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `database_snapshot` | R | R | R | R | — | R | R | R | R |
| `run_events` | R | R | — | R | — | R | R | R | R |
| `workflow_status` | R | — | — | — | — | — | — | — | — |
| `launch_intent` | — | R | — | — | — | — | R | — | — |
| `git_bundle` | — | R | — | — | R | R | — | — | — |
| `refs_before`, `refs_after`, `target_reflog` | — | R | — | — | — | — | `refs_before` + `refs_after` | — | — |
| `checksum_baseline`, `checksum_terminal` | — | — | — | — | R | — | — | — | — |
| `suite_ledger`, `suite_observations` | — | R | — | — | — | R | R | — | — |
| `token_deltas`, `round_usage` | — | — | — | — | — | — | — | R | — |
| `system_tokens_before`, `system_tokens_after` | — | — | R | — | — | — | — | R | — |
| `submit_rejections` | — | — | — | — | — | — | R | R | — |
| `expects_validations`, `dispatch_renderings` | — | — | — | — | — | — | — | R | — |
| `probe_evidence` | — | — | — | — | — | — | — | — | R |
| `chaos_log` | — | — | — | R | — | — | — | — | — |

An artifact marked optional may be present and used for corroboration, but its presence
does not permit an oracle to weaken or replace a required evidence leg. These are the
only input references in version 1 (the E3.C `probe_evidence`/`chaos_log` optional keys
were introduced within version 1 as part of the lifecycle-probe machinery); adding a
further key requires a contract-version change.

### Shared version-1 runtime

Gating executables import `torture-test/oracles/lib/index.mjs` and run their check
through `oracleMain`. The shared runtime is the canonical implementation of argv and
environment identity checks, context/reference validation, SHA-256 verification,
contained path resolution, read-only `node:sqlite` access, shell-free contained git
plumbing, deterministic finding aggregation, exclusive evidence creation, output
validation, and PASS/FAIL/ERROR/NOT_EVALUABLE exit mapping.

The runtime locates the campaign results directory by walking upward from the absolute
context path to the first directory containing the controller's regular non-symlink
`state.json`. It never consults HOME or a default Tamandua state path. Database access
accepts only a context reference, requires a non-writable captured file, and opens it
with `DatabaseSync(..., {readOnly: true})`. Oracle-created artifacts are portable paths
relative to `TT_ORACLE_EVIDENCE_DIR` and are opened with exclusive-create and
no-follow semantics.

Mutation fixtures use `oracles/self-test/harness.mjs --oracle <executable> --context
<context.json> --expected PASS|FAIL|NOT_EVALUABLE`. The harness applies this contract to both stdout
and exit status and fails on either mismatch direction. `oracles/self-test/run.sh`
creates one unique `torture-test/var/oracle-self-test.*` workspace and its cleanup trap
refuses to remove any path outside that namespace.

### O1 terminal-state interpretation

O1 canonicalizes public `run-<uuid>` identifiers and unprefixed SQLite IDs before
joining evidence. Each oracle invocation evaluates its current root attempt and every `discovered_runs` entry,
in canonical run-ID order, against `runs`, `steps`, `run_events`, and the terminal
`workflow_status` observation. A terminal event is exactly `run.completed`,
`run.failed`, or `run.canceled`, matching the DB terminal status. The DISP comparison
uses raw status for DB equality and computes `displayStatus=verifying` only for a
`type=loop`, raw `status=running` step whose current story ID is null; all other
display statuses equal raw status. CLI-presented step IDs carry one `step-` prefix;
O1 removes that presentation prefix before joining them to raw `steps.step_id` values.

The five-minute scheduling bound is measured from `scheduling_requested_at`, falling
back to `created_at`, through `workflow_status.captured_at`. A nonterminal run whose
status is null, `pending_register`, or `queued` after that bound is unadmitted;
`scheduling_status=error` is independently a finding.

The only O1 healthy-straggler declaration in contract version 1 is the mechanical
manifest projection below. `recent_within_ms` must be a positive integer no greater
than 300000, the case harness must be `hermes`, and the run ID must be listed.

```json
{"healthy_straggler":{"policy":"hermes-storm","run_ids":["run-..."],"recent_within_ms":300000}}
```

The exemption engages only for a listed run canceled by the controller after a
`straggler_capture` whose pre-stop snapshot contains a `running` step with a positive
claim PID and recent claim update. A recent production-shaped `run.tokens.updated`
event must match that run and its DB workflow ID and contain a positive token delta
with a consistent cumulative token total. Tamandua's production event has no step or
round ID, so the live step is correlated mechanically by the shared run ID and bounded
timestamps rather than a synthetic field. Unlike the former synthetic-only
`work.round.output`/`run.force_stop_requested` convention, both the token event and
pre-stop capture are produced on real controller/Tamandua paths. O1 records the run as
`healthy_straggler` in its deterministic evidence and, when no independent finding
remains, returns PASS with `classification.ambiguous.category` equal to
`HEALTHY_STRAGGLER`. Missing declaration or any missing mechanical leg leaves the
ordinary terminal checks engaged.

For anti-gaming, O1 groups `o1_wave.runs` by workflow family, excludes mechanically
predeclared fast-failure cases, and fails when the count terminating strictly below
the selected floor divided by all launched eligible runs is greater than 20%. Exactly
20% is allowed. Scripted (zero-token) runs are excluded from BOTH the fast numerator
and the eligible denominator: duration floors exist to catch dishonestly-fast REAL
runs and are meaningless for mechanically-fast scripted cells. A run is classified
scripted from its own `execution_mode: 'scripted'` field when present; on STORED
schema-1 evidence whose wave run rows predate the field, a run row without
`execution_mode` is treated as scripted when the evaluating case is a 0-token-cap
cell (`caps.tokens === 0` — the deterministic reporter of a scripted-only wave
snapshot) and never for real cells, so no other stored-campaign replay is altered.
A workflow family with zero real eligible runs emits no
`O1_DURATION_FLOOR_RATE`/`MISSING`/`DUPLICATE`/`UNKNOWN` finding — floor findings
describe real-run families only — while its `duration_floor_observations` row is
still written (with `run_count` 0) for every case. Mixed families count only their
real runs toward the rate; real-cell floors (manifest `production_duration_floor_ms`
pins, tier1 pins) and all real-run semantics are unchanged. The output evidence
records floor source, denominator, numerator, and rate deterministically.

### O3z zero-token interpretation

O3z evaluates every identified root attempt and discovered run in the context. Run
identity and terminal status/token totals come from the read-only `runs` snapshot;
`execution_mode` comes only from the controller's immutable attempt projection. A
`status=completed`, `execution_mode=real` run requires positive `runs.tokens_spent`.
Scripted attempts are exempt from that coarse nonzero rule because their exact
synthetic accounting belongs to O11, but they are never exempt from the system-token
tripwire. Discovered child/replacement runs inherit the root attempt's mechanically
captured launch mode when they enter the durable controller ledger. Failed and canceled
real runs are likewise outside the completed-run rule.

`system_tokens_before` and `system_tokens_after` each contain `schema_version`,
`captured_at`, `table_present`, the ordered captured `rows` of
`system_tokens_spent`, and their numeric `value` sum. O3z requires the table and at
least one non-negative-integer row, verifies the sum, and requires every row and the
sum to equal zero. It independently reads the terminal `tamandua_stats` rows from the
database snapshot, applies the same absolute-zero check, and requires them to exactly
reconcile with `system_tokens_after`. Missing or malformed observations are oracle
errors rather than guessed passes.

### O2 merge-identity interpretation

O2 evaluates the captured merge-family root/discovered runs and reads only the
whitelisted `tested_tree` hash from each run's durable context; raw step output and
the remainder of the agent response are never read. The captured merge-family graph
must have one non-noop `merge.landed` event, one target transition between the
`refs_before` capture and terminal reflog capture, and a changed target tip. The
event's `expectedTip`/`mergedCommit` must equal the captured pre/post tips. Landing
uniqueness is enforced both per run and across the root/discovered run graph; a later
discovered run may only contribute a mechanically valid no-op recovery observation.
A run that owns the landing must finish `completed`; failed or canceled after landing
is a product failure because the target already moved.

For that landing, O2 requires event `mergedTree == tested_tree`, resolves
`mergedCommit^{tree}` from the extracted controller git-common-dir snapshot, and
requires the same tree. The merged commit must be an ancestor of the terminal
target. Patch truth is computed mechanically from the attested trees rather than a
self-asserted branch name: O2 computes stable patch-id from `expectedTip` to the
attested merged tree, corroborates that the captured landing-source ref resolves to
that tree, computes patch-ids for commits in `expectedTip..target_tip`, and requires
the attested patch-id in that target set. The source must be a named non-target branch
and cannot resolve to the terminal target commit. An empty source diff is not a landing.

No-op `merge.landed` observations never count as another landing. They are accepted
only after the run's one non-noop landing, with `expectedTip`, `mergedCommit`,
`mergedTree`, and target proving that the same commit was already landed, plus a
canonical event timestamp strictly later than that landing. A no-op
without that prior transition does not exempt a completed run from the phantom-merge
rule. Mode-scoped suite provenance and full bidirectional transition attribution are
added by the O2 mode-reconciliation layer; these core identity checks remain engaged
for every mode.

The O2 mode-reconciliation layer binds its exact suite key to
`launch_intent.gate_key` and the mechanically attested merged tree. A null
`launch_intent.gate_key` is degraded evidence: O2 reports `NOT_EVALUABLE` with a
recorded reason instead of throwing. The `suite_ledger`/`suite_results`
reconcile is scoped to the case bundle — the gate-key origin plus origins
carried by the case's own captured run events — so rows of sibling cases that
share a command hash or tree cannot contaminate it (see the shared
case-bundle suite-scope contract below). Ordinary
landings require at least one captured `suite_results` row for that exact
`(origin_repo, merged_tree, cmd_hash)` key. A default concession instead requires
exactly one matching `merge.landed_without_suite_evidence` event, no exact-key
green or red row, exactly one earlier `step.rerouted` event for `finalize_merge`,
and a single DB finalize step whose `terminal_reroute_count` is one. Off mode
requires both manifest policy and projected argv to bind `merge_gate=off` and one
earlier exact-key `merge.gate_overridden` event. Agent output and mutable run
gate/test-command keys do not establish any of these legs.

O2 reconciles each non-noop `merge.landed` old/new pair to exactly one captured
raw-reflog transition and each in-window non-noop transition back to exactly one
captured merge-run landing. Terminal disposition never waives commit/tree/patch
checks: a landed failed or canceled run is a finding after those identity checks
run. On every FAIL, O2 writes a separate contained raw-reflog anomaly artifact
carrying the complete captured raw entries and deterministic finding IDs; branch
names are used only to corroborate source-tree identity, never to infer target
movement.

The extracted git snapshot rejects symlinks, non-regular archive entries, traversal,
alternates, HTTP alternates, and replacement refs. Git plumbing ignores repository,
global, and system config and replacement objects while evaluating the snapshot.

### O8 boundary and test-integrity interpretation

O8 treats `case.boundary_files` as the per-merge expected-file declaration. A changed
path that existed at baseline must match that declaration. A new path must match it or
be mechanically recognized as a test path (a `test`, `tests`, or `__tests__` directory,
not merely a test/spec filename outside such a directory). Declarations are authored
fixture-source-relative and are rebased to the work-clone root (`fixtures-src/<fixture>/`
prefix stripped) before matching; a declaration equal to the bare fixture root itself
(`fixtures-src/<fixture>` with no trailing slash) scopes the ENTIRE provisioned fixture
tree and matches every work-clone path. This bidirectional inventory reconciliation is the expected-file
leg; the transport-artifact denylist is an independent leg and still applies inside an
allowed boundary.

The baseline and terminal checksum artifacts contain path-sorted complete-tree entries
with type, mode, SHA-256, categories, and, for test files, non-negative counts of the
case-insensitive `skip`, `todo`, and `xfail` tokens. `changed_paths` must exactly equal
the difference of those inventories. O8 extracts the contained Git snapshot, rejects
external-object mechanisms, and requires the terminal inventory's paths, regular-file
modes, and bytes to equal captured Git `HEAD`; it does not trust a changed-path list by
itself. Forbidden declarations must resolve to baseline entries and every such entry's
terminal bytes must have the same SHA-256. Test marker counts may not increase.

A seeded test may be deleted or changed only when the immutable manifest workflow ID is
a `test-quarantine` workflow; mutable run context or agent output cannot declare that
exception. The exception does not waive the new-marker or transport-artifact checks.

A seeded-test CONTENT delta is further split by a line-level diff against the baseline
blob recovered from the isolated Git snapshot (walking `git rev-list --all`, newest
first, for the first `<commit>:<path>` whose blob SHA-256 equals the baseline inventory
entry). When every baseline line is present unmodified in the terminal content as an
ordered subsequence — pure insertions of any kind (import lines AND new test bodies)
tolerated; any deletion, modification, or reordering is NOT additive — O8 records the
informational, NON-FAILING `O8_SEEDED_TEST_EXTENDED` finding with the diff stats
(`baseline_lines`, `terminal_lines`, `lines_added`, `lines_deleted: 0`,
`lines_modified: 0`, `additive: true`) and the oracle result stays `PASS`. Any other
delta keeps the hard-FAIL `O8_SEEDED_TEST_CHANGED` exactly as before: a deleted or
renamed path, a type/mode change, deleted or modified lines, marker introduction (the
separate hard-FAIL `O8_TEST_MARKER_INTRODUCED` leg is unchanged), and
fix-consequence assertion rewrites. A content delta whose baseline blob cannot be
recovered from the snapshot fails closed: `O8_SEEDED_TEST_CHANGED` is emitted. The
diff stats for every content-diffed seeded test are recorded in the
`o8-boundary-audit.json` evidence under `seeded_test_diffs` (`schema_version` stays 1).

Progress/report/transport filenames are rejected across the complete terminal tree,
including `progress*`, `report*`, `transport*`, Tamandua report/reason/story transports,
and story input/output transport files.

### Case-bundle suite-scope contract (S26, shared by O2/O9/O10)

The suite-ledger oracles (O2, O9, O10) reconcile the captured
`suite_ledger.json` artifact against the read-only `suite_results` table
**within the case's suite-origin scope**, derived identically everywhere:

- **Scope derivation:** `{ launch_intent.gate_key.origin_repo } ∪ { event.originRepo
  for every captured run_events row }` — the same derivation the snapshotter uses
  when it scopes `suite-ledger.json` (`bin/oracle-evidence-snapshot.mjs`). O2 and O9
  may additionally apply their per-oracle attempt/run scoping (O9's current-attempt
  row filter, S21) on top of the origin scope.
- **Foreign-row doctrine (S13):** a `suite_results` row whose `origin_repo` is
  outside the case's suite-origin scope is **foreign evidence** — legacy snapshot
  contamination from sibling cases or reused cross-campaign fixture paths. Foreign
  rows are annotated and skipped, never reconciliation failures. This is symmetric:
  foreign rows in the artifact (`skipped_foreign_row_ids`) and foreign rows present
  only in the database snapshot (`skipped_db_foreign_row_ids`) are both ignored.
- **Stale-row doctrine (S21):** a row inside the origin scope but written by a prior
  campaign attempt (run id outside the current case's run set, or unattributable) is
  **stale evidence** for the current case — annotated and skipped
  (`skipped_stale_row_ids` artifact-side, `skipped_db_stale_row_ids` DB-side), never
  a reconciliation failure.
- **In-scope byte-for-field fail-closed reconciliation:** after both sides are
  filtered to the scope, the scoped artifact rows and the scoped DB rows must be
  byte-for-field identical; any in-scope discrepancy throws `ORACLE_RUNTIME_ERROR`
  with the oracle's exact reconciliation message. Tamper detection inside the scope
  is never weakened by the foreign/stale doctrine.

### O9 ledger-key and replay interpretation

O9 reconciles the captured `suite_ledger.rows` byte-for-field with a read-only query of
`suite_results`; artifact rows are ordered by positive `id`. Both sides of the
reconcile are scoped to the case bundle: the `launch_intent.gate_key.origin_repo`
plus origins carried by the case's own captured run events. Ledger rows whose
origin falls outside that bundle are foreign evidence — legacy snapshot
contamination from sibling cases — and are SKIPPED: excluded from the DB
reconcile and tree resolution and annotated in the `o9-ledger-replay-audit.json`
evidence as `skipped_foreign_rows` (count) and `skipped_foreign_row_ids` (row
ids), never fatal. Rows inside the bundle but outside the current attempt
(prior-campaign run ids over a reused fixture origin) are skipped and annotated
as `skipped_stale_rows`/`skipped_stale_row_ids`. DB-side rows excluded by the
same two filters are annotated as `skipped_db_foreign_rows`/
`skipped_db_foreign_row_ids` and `skipped_db_stale_rows`/`skipped_db_stale_row_ids`.
A null gate key that leaves no event-carried origin (an
empty case bundle) is degraded evidence and reports `NOT_EVALUABLE`. Every
in-scope row's `tree_hash`
must be a tree object used by a reachable commit in the isolated captured Git snapshot.
An object that exists but is not a captured committed tree is not reusable evidence.

`suite_observations` is a version-1 ordered mechanical state-machine projection. It
contains a positive `ttl_green_ms` and globally timestamp/sequence-ordered rows. Every
row carries a unique `id`, `invocation_id`, phase (`lookup`, `execute`, `record`, or
`replay`), canonical `observed_at`, exact `origin_repo`/`tree_hash`/`cmd_hash`, boolean
`force`, and nullable mechanical run/step attribution. A lookup carries nullable
`latest_row_id`; execute carries `started_at`, full pre/post committed-tree hashes and
the command exit code; record carries its positive `ledger_row_id` and exit code; replay
carries its positive `ledger_row_id` when reconciliation succeeds (or null when the
mechanical cache-hit observation names no valid prior row), exit code, full current `committed_tree_hash`, and the exact
mechanically observed marker `TAMANDUA-TEST CACHED`. These fields are controller/shim
observations, not captured stdout or agent prose. An unresolved cache hit is preserved
as a complete lookup/replay invocation; harvesting
must never drop an invalid invocation merely because another invocation is valid.

**S26 replay row-resolution (US-003):** a replay's `ledger_row_id` must resolve in
the case's in-scope ledger. When it does not, O9 classifies the gap before any
finding:

- The row id is an artifact row excluded by the scope filters (foreign origin or
  stale attempt) or a database row excluded the same way → the replay is annotated
  under `skipped_replay_row_ids`/`skipped_replay_row_reasons` (reason
  `foreign-origin` or `stale-attempt`) and **no** `O9_REPLAY_ROW_MISSING` fires.
- The replay carries `ledger_row_id: null` (the snapshotter could not attribute the
  cache hit within the case's scoped artifact) → the shim mechanically replayed a
  green cached row (`TAMANDUA-TEST CACHED` marker, exit 0) that the case scope
  cannot resolve — the row was foreign/stale (reused fixture origin across
  campaigns/attempts) or re-recorded by shim row hygiene before the snapshot. The
  cache hit is a mechanical fact; the attribution gap is annotated
  (`skipped_replay_row_ids`/`skipped_replay_row_reasons` reason
  `unresolved-cache-hit`) and **no** `O9_REPLAY_ROW_MISSING` fires.
- The row id exists **nowhere** — neither in the artifact nor in the database
  snapshot — → `O9_REPLAY_ROW_MISSING` fires (fail-closed invariant; a replay can
  only ever name a row that existed in the shim's database at event time, so this
  branch is defensive).

The replay's mechanical legs that do not depend on the resolved row — the
`TAMANDUA-TEST CACHED` marker and the unchanged committed tree with exit zero — are
still checked for every replay, including skipped ones.

The artifact also contains three required arrays. `origin_identities` maps every ledger
or observation `origin_repo` to the absolute, lexically normalized git-common-dir
identity captured by the shim/controller; normalized identities are unique. This is the
origin leg of the exact key: independent repositories do not collapse merely because
their tree and command hashes match. `singleflight_observations` contains an ID, exact
key, owner invocation, nonempty waiter invocation list, positive configured recovery
bound, nullable recovery kind (`dead_owner` or `stop_cancel`), and a timestamp-ordered
mechanical event timeline. Timeline event types are `execute_started`, `wait`, `record`,
`replay`, `dead_owner_reclaimed`, and `owner_released`; process IDs, release reason, and
ledger row ID are carried where mechanically observed. Ordinary contention has exactly
one executor and every waiter replays the exact-key green row named by the owner's
`record` event; another prior exact-key green row is not an owner-row substitute.
Recovery may add one waiter execution only strictly after the recorded recovery leg.
Dead-owner recovery
requires exactly one `suite.claim_dead_owner_reclaimed` projection within the configured
bound and no owner-release event; stop/cancel release requires one `owner_released` with
reason `stop` or `cancel` and forbids a dead-owner event.
When liveness probing reclaims the owner in the first colliding claim request, the reclaim
event itself mechanically identifies the reclaimer and collision. The snapshotter projects
that request as a zero-duration `wait` at the reclaim timestamp; it must not discard the
reclaim merely because no separate `suite.claim_wait` event preceded it.

`special_exit_observations` contains mechanically injected exit-86/87/88 process
outcomes: invocation and exact key, timestamp, shim and nullable command exits, full
pre/post committed trees, nullable ledger row, interrupted/tracked-dirty booleans, and
the captured junk-probe tracked state. A nonempty targeted set has exactly one of each
code. Exit 86 is a passing command whose tree drifted and has no row; exit 87 is an
interrupted stable-tree execution with exactly one red-87 row; exit 88 is a pre-execution
tracked-dirty refusal with no row. Every special arm must leave its junk probe untracked.
Empty concurrency and special-exit arrays mean those targeted manipulations were not
part of the case; they do not synthesize coverage.

Targeted special-exit process evidence is harvested only from the controller-authored
`suite.special_exit_observed` mechanical event. That event carries the full exact key,
full pre/post committed-tree hashes, shim and nullable command exit codes, nullable
ledger row ID, interruption and tracked-dirty observations, and a safe repository-relative
junk-probe path plus the event-time boolean produced by Git index plumbing. The snapshotter
preserves that event-time `junk_probe_tracked` value even if the index changes later and
validates that the probe remains a contained regular file; it never hardcodes or re-derives
historical state from the terminal index. Malformed event-source JSON is a snapshot
infrastructure error rather than silently disappearing. Ordinary
`suite.executed` or `suite.tree_drift_detected` product events alone are insufficient to
claim targeted exit-matrix coverage because they do not capture all process and
filesystem legs. A malformed targeted event is snapshot infrastructure failure rather
than an omitted observation.

A manifest opts into this targeted arm with `context.o9_special_exits: true` (carried in
`context`, not `chaos` — the chaos block is the typed W3.17b injection block). After the
workflow converges and before terminal evidence is snapshotted, `tt-controller` launches
three isolated `tamandua-test --force` probes attributed to the run with distinct step
IDs and sets `TAMANDUA_TSTX_JUNK_PROBE` itself. The probe driver requires a clean tracked
fixture, restores the selected tracked file byte-for-byte after the 86 and 88 arms,
mechanically interrupts the 87 arm, verifies exact exits `[86,87,88]`, and verifies the
junk path is not in the Git index. A launch, timeout, restoration, or evidence failure is
TEST_INFRA; the controller never substitutes hand-authored special-exit observations.

Each invocation keeps one exact key and force mode and follows `lookup -> replay` or
`lookup -> execute -> record`. A replay must name the lookup's prior green row with the
same exact key, at or before replay time and no older than `ttl_green_ms`; red rows are
never replayable. The replay tree must remain equal to the lookup key and the cache
marker must be present. A force invocation must execute and may not replay. A stable
execution must reconcile its record row and timestamps, while a pre/post tree drift
must produce no record. If a mechanically paired later force execution for the same key
is red after a green replay, O9 reports a monotonicity violation because caching changed
the observed would-run result. Single-flight ownership/recovery, special exits, junk
probes, and cross-origin separation are enforced by the additional arrays without
weakening these key/replay checks. The controller preserves same-command rows from all
captured origins, so O9 can reconcile each normalized origin against the read-only DB
and detect an otherwise plausible cross-repository replay. An empty
`suite_observations.rows` artifact (no shim evidence for the case bundle) is
degraded evidence: O9 reports `NOT_EVALUABLE` with a recorded reason instead of
throwing.

### O11 token-attribution interpretation

O11's output-contract leg reads the terminal `steps` rows (including `type` and
`loop_config`), the terminal `stories` rows, and three controller-authored
structured event projections. It never reads `steps.output`, a submitted body, a
rendered prompt, stderr, or agent prose. Every terminal `status=done` step in the
captured root/discovered run graph must have exactly one accepted
expects-validation row whose verdict and transition are both `done` for that same
database step row. The loop exception: a step whose `type` is `loop` transitions
done once per story iteration, and its `verify_each` decision step (the same-run
step whose `step_id` equals the loop step's `loop_config.verify_step`, both
snake_case and camelCase spellings accepted) once per story verification. Those
steps require at least `max(1, done_stories_for_run)` accepted done transitions —
matching the run's terminal stories with `status='done'` — instead of exactly one;
all non-loop steps keep the strict exactly-one rule. A loop step's `loop_config`
must be a parseable object (fail closed, like every other malformed input). A
completed run containing an accepted `retry` verdict is a finding; retry is a
lifecycle transition, not completion. The loop-retry exemption: on a loop step
or its `verify_each` decision step an accepted `retry` verdict is the
story-reset re-dispatch — the agent verdicts retry and the scheduler
re-dispatches a fresh session for the same story — and is by design, not a
finding (campaign #7's marathon/pause-drain verdicts, e.g. a verify retry
whose `transition.action` is `done` targeting the decision step itself, are
the pinned shape). Every other step keeps the strict retry seal: a completed
run carrying an accepted retry verdict on any non-loop step is still
`O11_COMPLETED_FROM_RETRY_VERDICT`.

`expects_validations.rows` is ordered mechanical validation evidence emitted by the real
`tamandua step complete` validator after its lifecycle transition returns. Each row contains a
unique `id`, canonical `observed_at`, `run_id`, database `step_row_id`, workflow `step_id`,
`claim_id`, positive `attempt_number`, `outcome` (`accepted` or `rejected`), nullable
`verdict` (`done`, `retry`, or `failed`), boolean `expects_required`, ordered
`required_keys`/`missing_keys`/`invalid_keys`, nonempty `diagnostic_code`, and a structured
`transition` (`action` and target database step row). `key_sources` is retained for schema
compatibility but submit-time missing output keys identify the submitting step, not a
downstream context producer. Producer attribution is therefore proven by the dispatch rows
described below. The artifact is projected only from `step.expects.validated` events with
flat mechanical fields; submitted bytes are excluded. Production events may omit an attempt
number: the controller assigns it from immutable event order independently for each claim,
so repeated rejected submissions do not need a mutable database counter and cannot collapse.

`submit_rejections.rows` contains a unique record ID, timestamp, run/step/claim identity,
positive attempt number, validation code, ordered missing/invalid key inventories, and a
specific diagnostic code. It reconciles one-for-one with rejected expects-validation
attempts. Attempts for one claim remain as distinct rows in strict time/attempt order;
repeating the same mechanical violation may repeat its specific code, but must not replace
or collapse either attempt. Generic diagnostics (`GENERIC`, `REJECTED`,
`UNKNOWN`, `VALIDATION_FAILED`, or `EXPECTS_REJECTED`) are findings even when a CLI message
would have contained more prose. This ensures every resubmission retains independently
actionable mechanical evidence without admitting that prose to the oracle.

`dispatch_renderings.rows` contains a unique record ID, timestamp, run/step/claim identity,
ordered `required_keys`, and only the count and key inventory of unresolved placeholders.
The rendered prompt is not captured. A `dispatched=true` row must have an empty unresolved
inventory; a positive value mechanically proves that a `[missing: <key>]` placeholder was
rendered and is a finding. A `dispatched=false` `dispatch.keys.rejected` row instead proves
the pre-dispatch guard blocked the model round. Such a row carries the producer database row
and structured retry/reroute transition; the producer must be a distinct same-run upstream
step and the transition must target it rather than consuming a retry on the downstream
consumer. The snapshotter fails closed on malformed matching `step.submit.rejected`,
`step.expects.validated`, `dispatch.render.validated`, or `dispatch.keys.rejected` events
instead of dropping a product-invalid observation.

O11 reconciles every `run.tokens.updated` row in `token_deltas` byte-for-byte with the
same archive/line/event row in `run_events`. Each event has canonical `ts`, `runId`,
non-negative integer `tokenDelta` and cumulative `tokensSpent`, plus nonempty `stepId`,
`roundId`, and `usageId`. The latter three fields are the captured round identity; their
absence is a product finding rather than permission to infer identity from timestamps.
Events are ordered by timestamp and source line per run, and their cumulative totals must
equal the running sum from zero. That sum must equal terminal `runs.tokens_spent` and the
controller attempt's `tokens_observed`. Every completed real run requires a positive sum.

`round_usage` has `schema_version`, `captured_at`, `rows`, and `synthetic_ledger`. Every
usage row has a unique nonempty `id` (the event's `usageId`), nullable mechanically
captured `run_id`, `step_id`, and `round_id`, `harness` (`pi`, `hermes`, or `scripted`),
nullable `session_id`, canonical `started_at`/`finished_at`, ordered
`candidate_run_ids`, and `formula_inputs`. Pi uses `formula_inputs.total` when present;
otherwise its product trailer formula is `input + output + cache_read + cache_write`.
Hermes is exactly `input + output + cache_write`; O11 validates but excludes both
`cache_read` and `reasoning`. Scripted usage uses `synthetic_tokens`. Every usage maps to
exactly one token event, with the same run/step/round and computed delta. A differing
usage owner and charged event run is cross-charge even when their attempt windows overlap.
The owner and every candidate must name a captured attempt whose start/terminal window
overlaps the usage interval, the owner must occur in its candidate set, and the token
event cannot precede usage completion. Token events naming a run outside the captured
root/discovered graph are findings.

A Hermes usage with no bound `run_id` or a `candidate_run_ids` set other than exactly one
is an explicit `O11_HERMES_ATTRIBUTION_AMBIGUOUS` finding. O11 never chooses a candidate
by comparing totals. Each `synthetic_ledger` row contains one `run_id` and non-negative
`expected_tokens`; there is exactly one row for every scripted root/discovered run and no
row for a real or unknown run. The artifact must byte-for-field equal the immutable
`case.chaos.synthetic_token_ledger` manifest projection. Its value must equal the
attributed event sum exactly.
When the production event stream does not yet expose normalized trailer/session inputs,
the controller writes empty usage rows rather than duplicating token events or fabricating
formula inputs; O11 then reports missing usage/identity findings with contract-valid
evidence. Output-contract, expects, rendering, and informed-rejection legs use the other
required O11 artifacts and are independent of this token-attribution layer.

### O10 FMIS decision-table interpretation

O10 evaluates each projected merge run against the immutable `launch_intent.policy`
and `launch_intent.gate_key`. A null `launch_intent.gate_key` is degraded
evidence: O10 reports `NOT_EVALUABLE` with a recorded reason instead of
throwing. The four policy rows are `off`, default, default with
strict missing, and `green`. Strict missing is active for green mode or when the
launch-time `fail_missing` value is a string equal to `1`, `true`, or `on`
case-insensitively. The value is deliberately not trimmed and non-string truthy values
are not accepted. Off mode dominates `fail_missing` and always remains permissive.
For every root or discovered replacement run, O10 parses the terminal read-only
`runs.context` and compares the effective `merge_gate` and `fail_missing` values
exactly with the captured launch values (an absent key and launch `null` are equivalent).
Any differing value is a launch-intent mutation finding; the effective context never
governs the expected table cell.

The decision evidence is the latest captured suite row at or before the terminal
`finalize_merge.updated_at` for the exact launch origin and command hash plus the
mechanically attested gate tree. The `suite_ledger` artifact must reconcile
byte-for-field with the read-only `suite_results` table. O10 derives merger invocation
count from `step.running` events for `finalize_merge`, reroute count from both the
terminal step counter and `step.rerouted` events, ref movement from `refs_before` and
`refs_after`, and terminal disposition from the database, controller projection, and
terminal run event.

For each FMIS cell, the exact corridor event multiset consists only of the applicable
`step.rerouted`, `step.running`, `merge.gate_overridden`,
`merge.landed_without_suite_evidence`, `merge.landed_over_red_suite`, `merge.landed`,
and terminal `run.*` events. Every obstructing path reroutes exactly once. A default
missing row then concedes and lands; strict missing and green red refuse permanently;
default red remains advisory and lands; green evidence lands; off always lands with an
override event. Landing cells move the target and invoke the merger once. Refusal cells
do neither and end failed.

`merge.accepted_already_landed` is the sole no-ref-movement completion exception. It
requires exactly one such event, no `merge.landed` event, a non-off launch mode, no
reroute, one merger invocation, an obstructing red/missing pre-claim decision, unchanged
pre/post target tips, and the accepted
`MERGED_COMMIT` equal to that tip. Its accepted `MERGED_TREE` must equal the mechanically
attested gate tree. A completed no-landing output without the annotation fails. This
models a row flip or deletion between claim and acceptance without falsely requiring a
second ref transition.

Every `merge.landed_without_suite_evidence` concession must itself name the immutable
launch `origin_repo` and `cmd_hash` plus the mechanically attested merged tree. O10
selects the latest exact-key row whose timestamp is at or before gate evaluation. An
exact-key red row paired with a missing-evidence concession is
`O10_EXACT_KEY_RED_LAUNDERED`; red rows for another origin/tree/command or rows written
after gate evaluation do not trigger that finding and remain mechanically missing for
that decision.

Strict refusals are created by the pre-claim gate, not by an agent. O10 may therefore
read only the gate-generated `finalize_merge.output` key lines from the read-only
database snapshot. It validates `FAILURE_CLASS`, `LEDGER_EVIDENCE`, exact origin/tree/
command identity, red-row identity when applicable, and the nonempty `TEST_CMD`,
`WORKSPACE_STATE`, `NEAREST_EVIDENCE`, and `ACTION` diagnostics. It does not inspect
claimed agent response prose or use any output line as a policy override. Launch-intent
invariance, replacement inheritance, already-landed acceptance, and red-to-missing
laundering checks extend this core FMIS layer without weakening it.

### O4 claim & dispatch hygiene interpretation

O4 is the **claim & dispatch hygiene oracle** (spec 03 "O4 — Claim & dispatch
hygiene (sweep, gating)"). Its three required evidence legs are
`database_snapshot` (the read-only terminal TT database: `steps`, `stories`,
`story_abandonments`, `runs`), `run_events` (the contained event-stream slice,
used for corroboration), and `chaos_log` (the bundle of tt-chaos structured
entries + the process recorder's 5s samples — see the evidence-key table).

**TIER-1 SCOPE DECISION (documented, not removed):** spec 03 lists O4 in the
in-campaign gating set (with O1, O2, O3z, O8, O9, O10, O11, O16). O4 is
therefore **IMPLEMENTED** as a real executable — it is NOT removed from the
W3.0x manifests that declare it. Campaign #7's `ORACLE_MISSING` for O4 (and
O16) is closed by the executable landing (US-010) plus the declared-oracle
hygiene gate (US-011).

The six judgment dimensions, each with its violation finding:

- **Dead claim_pgid (beyond one sweep interval)** — every `steps` row with
  `status='running'` and `claim_pgid > 0` is probed for process-group liveness
  exactly like the product's liveness watchdog: `kill(-pgid, 0)`; `ESRCH`
  means the group is gone. A dead pgid whose claim is older than one sweep
  interval (the daemon's 15s dispatch sweep) is `O4_DEAD_CLAIM_PGID` (the
  sweep should have requeued it). Steps without `claim_pgid` (legacy/manual
  claims) and claims without a parseable timestamp are skipped — the product
  leaves both to the age-based sweeper, and the oracle cannot establish the
  "beyond one sweep interval" bound without a timestamp.
- **Dangling claim after NO_WORK** — the scheduler releases claims scoped to
  the round's job with `abandonReason='no_work_release'` (recorded in
  `story_abandonments`). A step that a NO_WORK release targeted must not still
  be claimed at snapshot time: `status='running'` with a non-null claim
  (`claim_pid`/`claim_pgid`/`claim_job_id`) is
  `O4_DANGLING_CLAIM_AFTER_NO_WORK` — unless the step was re-claimed AFTER the
  release (`claim_updated_at > released_at`), which is a legitimate new claim.
- **retry_count <= max_retries** — every non-terminal step/story (status
  waiting/pending/running) must satisfy `retry_count <= max_retries` (product
  default 4); a non-terminal row exceeding it is `O4_RETRY_BUDGET_EXCEEDED`. A
  *failed* row may legitimately carry `retry_count == max_retries+1` because
  the product fails the step/story AT the exhaustion point.
- **Reroute counters within budget** — the product's general reroute counter
  never increments past the workflow's `on_fail.max_reroutes` (default 2). A
  step with `reroute_count > 2` is `O4_REROUTE_BUDGET_EXCEEDED` — a
  counter-runaway anomaly (a workflow declaring a larger budget must be
  reconciled by the operator; the mechanical tripwire is the source default).
  The separate `terminal_reroute_count` is deliberately NOT judged: terminal
  refusals carry a designed independent allowance that legitimately crosses
  the shared budget.
- **Abandonment boundary matches source** — `ABANDON_STORY_MAX = 8` survivable
  story losses (a story fails on the 9th; only `failed` stories may carry
  `abandoned_count > 8`) and `MAX_ABANDON_RESETS = 5` for single steps (only
  `failed` steps may carry `abandoned_count >= 5`). A non-failed story/step
  beyond its boundary is `O4_ABANDON_BUDGET_EXCEEDED`.
- **Watchdog false-positive check** — zero `[liveness-detected]` worker_lost
  recoveries for workers **provably alive**. The product records every
  liveness-watchdog recovery in `story_abandonments` with
  `reason='liveness_detected'` (the same recovery emits the
  `[liveness-detected]` `step.worker_lost` event). A worker is *provably
  alive* when >= 2 **consecutive** recorder samples (gap <= 2x the 5s sampler
  interval) of the run's worker (sample `cmdline`/`cwd` mentions the run id)
  fall within 120s before the recovery. Cross-referenced with the chaos log: a
  `kill-harness`/`fired` entry for the run within 120s explains the loss (not
  a false positive); **kill-and-PID-reuse inside one window** (a chaos kill AND
  later samples with the same pgid) is INCONCLUSIVE and maps to
  `NOT_EVALUABLE` (scope `watchdog-pid-reuse` in the evidence artifact) when
  no other dimension produced a finding; a provably-alive worker with no
  chaos kill is `O4_WATCHDOG_FALSE_POSITIVE`.

The `story_abandonments` table is the authoritative abandonment record; the
event stream corroborates it (per-run `story.abandoned`/`step.worker_lost`
counts ride in the evidence artifact). Malformed DB evidence fails closed as
`ERROR`; a log line that is neither a chaos entry nor a recorder sample is
skipped (a log may be mid-write). The evidence artifact is
`o4-claim-dispatch-hygiene.json` with per-dimension observations and the
finding ids.

### O16 lifecycle probe-evidence interpretation

O16 is the E3.C **lifecycle probe-evidence oracle** (spec 07-wave-3-harness-duel.md
section C): it judges the probe sequencer's per-action evidence for the five
lifecycle cases (W3.18 pause-no-drain, W3.19 pause-drain, W3.20 cancel, W3.21
fail-force-resume, W3.22 daemon-restart) and any other W3.0x cell that declares O16.
Its three required evidence legs are `probe_evidence` (the sequencer artifact,
schema-version 1), `run_events` (the contained event-stream slice), and
`database_snapshot` (the read-only terminal TT database). The sequencer's own
observed-effect excerpts are corroboration at most — O16 re-derives every verdict
independently from the event stream and database snapshot, never from the
sequencer's `effect` summary or any agent prose.

NOTE ON SPEC 03: the separate 'held-out acceptance probes' O16 definition in
tamandua-torture-test-spec/03-oracles.md is **out of scope** for this work item.
Tier-1 does not run held-out acceptance probes; O16 as implemented here is the
lifecycle probe-evidence oracle per E3.C (spec 07-wave-3 section C + spec 12
runner-automation), documented below.

The five judgment dimensions, each with its violation finding:

- **Pause held (no_rounds_during_hold)** — a `pause` action must carry a hold
  window (`hold_started_at`/`hold_ended_at`; a pause without one is
  `O16_PAUSE_HOLD_MISSING`). No dispatch event may fire for the run inside that
  window. A dispatch event is `dispatch.render.validated`, `step.running`, or
  `step.started` on the run's event stream; any such event inside
  `[hold_started_at, hold_ended_at]` is `O16_ROUND_DURING_HOLD`.
- **Pause --drain (drain_waits_current + next_story_parked)** — for a
  `pause_drain` action, the in-flight story step may complete (a `step.done` is
  allowed) but the next story must stay parked: no dispatch event may fire
  between the drain's `action_ended_at` and the next action's start (or the
  evidence's `ended_at` when no next action exists). Any dispatch event in that
  window is `O16_DRAIN_DISPATCHED_NEXT_STORY`. The no-wedge guarantee is the
  resume/completion check below: after the sequence's `resume`, the probed run
  must reach `completed`.
- **Cancel terminal event (canceled_terminal_event, CNEV)** — every `cancel`
  action must land a `run.canceled` event on the run's event stream with
  `ts >= action_started_at`; absence is `O16_CANCEL_TERMINAL_EVENT_MISSING`.
- **Fail --force resume reuses the SAME run id (same_run_id_resumes)** — when a
  `fail_force` action is followed by a `resume` action, the terminal database must
  show the SAME run row (the probe evidence's run id) as `completed`. A completed
  run row under a DIFFERENT id while the probed id did not complete is the
  resumeWorkflow-reuses-run-id trap: `O16_RESUME_NEW_RUN_ID` (details carry the
  completed other run ids and their `run_number`s). A `resume` action whose run
  row is not `completed` is `O16_RESUME_RUN_NOT_COMPLETED` — this is also the
  draining-pause-wedge check for pause --drain and the `run_completes` leg for
  every resume.
- **Restart recovery (recovery_within_dispatch_intervals + token_flush_preserved,
  DC8)** — every `restart_daemon` recovery observation (per-run `recovery` on the
  run group, the restart action's `effect.recovery`, or a `daemon_restarts[].recovery`
  entry) must report `recovered: true`,
  `recovery_within_dispatch_intervals: true`, and `token_flush_preserved: true`;
  any false field is `O16_RESTART_RECOVERY_EXCEEDED` (with the waited ms and
  post-restart status), and a missing observation is `O16_RESTART_RECOVERY_MISSING`.

The oracle accepts both probe-evidence shapes the sequencer produces: the
single-run shape (W3.18/W3.19/W3.21: `run_id` + ordered `actions`) and the
multi-run shape (W3.20/W3.22: `runs[]` grouped by run ordinal with per-run
`actions` and optional `recovery`, plus `daemon_restarts[]`). Every action record
is validated fail-closed (op, trigger, canonical timestamps) — malformed probe
evidence is an oracle `ERROR`, never a guessed pass. A probe sequence carrying no
lifecycle op at all (`pause`, `pause_drain`, `resume`, `cancel`, `fail_force`,
`restart_daemon`) and no daemon-restart evidence is `NOT_EVALUABLE`: there is
nothing for a lifecycle oracle to judge, and the version-1 vocabulary forbids
guessing PASS from an empty judgment scope.

## Output

stdout MUST contain exactly one JSON object (surrounding whitespace is allowed)
with this version-1 shape:

```json
{
  "contract_version": 1,
  "oracle_id": "O1",
  "result": "PASS",
  "started_at": "2026-08-01T00:00:00.000Z",
  "finished_at": "2026-08-01T00:00:01.000Z",
  "findings": [],
  "evidence": [
    {"path": "query-result.json", "kind": "sqlite"}
  ]
}
```

Required field rules:

- `contract_version` is the integer `1`.
- `oracle_id` exactly matches `TT_ORACLE_ID`.
- `result` is one of `PASS`, `FAIL`, `ERROR`, or `NOT_EVALUABLE`.
- `started_at` and `finished_at` are canonical UTC ISO-8601 timestamps;
  `finished_at` must not precede `started_at`.
- `findings` is an array. Every finding has nonempty string fields `id` and
  `summary`. `NOT_EVALUABLE` has no findings; `FAIL` has at least one. A `PASS`
  result has no findings unless every finding is informational — stamped
  `non_failing: true` (the `FindingCollector.addInfo` path). Informational
  findings are recorded diagnostics (e.g. diff stats) that never flip the
  oracle result; a `PASS` carrying any failing (unmarked) finding is a contract
  violation. Additional mechanical fields such as `severity`, `expected`,
  `observed`, and `non_failing` are allowed.
- `evidence` is an array of objects with a nonempty `kind` and a relative `path`.
  Each path is resolved beneath `TT_ORACLE_EVIDENCE_DIR` and must name an existing
  regular non-symlink file. Hooks create evidence with exclusive-create semantics
  and must not overwrite controller evidence.
- `classification` is optional structured evidence for the total outcome
  classifier. It may contain `manipulation_checks` (objects with `id`, `engaged`,
  and optional `required` booleans), `provider_failure` (`identified: true`, an
  `injected` boolean, and a nonempty mechanical `kind`), boolean
  `expectation_met` / `agent_task_succeeded`, or `ambiguous` with a nonempty
  `category`. Unknown or malformed classification fields make the oracle result
  `TEST_INFRA`; free-form text is not a classification signal.

stderr is diagnostic evidence only. It is never parsed as a verdict.

## Exit status

The JSON result and process exit status must agree:

| JSON result | Exit status | Meaning |
|---|---:|---|
| `PASS` | 0 | Applicable checks are mechanically green. |
| `FAIL` | 1 | A mechanical product finding was observed. |
| `ERROR` | 2 | The oracle could not make a valid observation. |
| `NOT_EVALUABLE` | 3 | Degraded evidence prevents a valid mechanical observation. |

Any other exit status, signal, timeout, malformed JSON, schema violation, missing
evidence file, or result/exit contradiction is persisted as `TEST_INFRA` oracle
evidence. The controller does not guess a result from partial output. A validated
`FAIL` contributes `PRODUCT_FAIL`; validated `ERROR` contributes
`TEST_INFRA_FAIL`. An absent hook remains an explicit `ORACLE_MISSING` record so
campaign classification/reporting can distinguish an unavailable battery from a
hook that executed incorrectly.

## NOT_EVALUABLE and degraded evidence

`NOT_EVALUABLE` is the contract-version-1 result vocabulary for **degraded
evidence**: the oracle ran cleanly and its logic is sound, but a required
mechanical evidence leg is missing, degraded, or outside the contract-version-1
shape, so no valid product verdict can be derived. It is an informative verdict,
not a crash: it carries an empty `findings` array (no product finding is
attributed) and exit status 3, which is distinct from both `FAIL` (a real
mechanical product finding) and `ERROR` (the oracle itself failed).

Oracles MUST tolerate degraded inputs that older captures legitimately contain
and report `NOT_EVALUABLE` (or a `SKIP` annotation in evidence) instead of
throwing `ORACLE_RUNTIME_ERROR`. The canonical example is a null
`launch_intent.gate_key` (contract-version-1 declares the gate key nullable:
`origin_repo` plus `cmd_hash` present only when the manifest pinned
a `test_cmd_raw`/`test_cmd`), which campaign capture now prevents going forward
but legacy snapshots may still carry. A gate-key-gated oracle (O2, O9, O10) that
cannot establish its launch identity from a null or missing gate key must
conclude `NOT_EVALUABLE`, never an exception. Evidence rows whose origin falls
outside the case bundle are likewise skipped/annotated, not fatal.

Controller-side consumption of the new result (attempt classification and
gate accounting for validated `NOT_EVALUABLE`) is owned by `bin/tt-controller`
and is outside this contract's shared-runtime scope; the oracles and the
self-test harness above are the complete version-1 emitter side.

## Evidence durability

Before invocation, the controller writes the context and a durable `RUNNING`
ledger record. It captures stdout and stderr separately, records the exit code,
signal, argv, start/finish timestamps, and SHA-256 hashes for context, stdout,
and stderr, and then validates the response. Referenced evidence files are also
hashed. Captured files are made
read-only after capture/validation. If the controller is interrupted while an
oracle is in flight, resume records `TEST_INFRA` and does not blindly execute the
hook a second time.

Oracle authors must derive every verdict from mechanical evidence. Agent prose,
`STATUS:` lines, conversational summaries, and claims that tests passed are not
oracle inputs and must never be introduced into the context or parsed by a hook.

The controller classifies each attempt separately. A validated `FAIL` always wins
as `PRODUCT_FAIL`, including when another structured signal says provider failure
or an unrelated manipulation did not engage. A non-injected, mechanically
identified provider failure permits one linked retry after the campaign's durable
backoff deadline. Every attempt classified `PROVIDER_FAIL` has
`counts_toward_gate: false`; the case outcome and case-level gate eligibility
follow the final attempt outcome.
