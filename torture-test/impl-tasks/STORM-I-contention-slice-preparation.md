# STORM-I: reproducible interim contention slice and read-only observations

## Authority and scope

Beads: tamandua-6sy.6.1, under the approved STORM work in tamandua-6sy.6.
Igor authorized a real W3/W4 slice at case concurrency 3-4 on both Linux and
Mac in the next campaigns, followed by a separate true two-round W5 milestone.
He has delegated suite fixes while away, through Tamandua runs with maximum
dogfooding. This implementation run uses dsh.

Build a small SUITE-ONLY preparation/observation tool for that interim slice.
Do not execute a real campaign in this run. The coordinator will do so after
the target tree is ready and the host's contained campaign slot is free.
All changed files must be inside torture-test/. No product changes.

## Why this is needed

The existing bin/tt-controller already supports --manifest, --concurrency,
and --stagger. The run-torture-test wrapper accepts only one --case and does
not forward case concurrency. Do not extend either engine in this task.
Prepare an ordinary input manifest for the existing controller instead.

An operator should not have to hand-copy changing case definitions or infer
actual simultaneity from a configured cap. Preserve the selected source rows
exactly and record direct observations of campaign-owned claimed steps.

## Canonical interim roster

Copy these complete current rows, in this order, from the named catalogs:

1. cases/tier1.jsonl: W3.03-bfmw-hermes-ts
2. cases/tier2.jsonl: W4.06-colleague-rebase
3. cases/tier2.jsonl: W4.09-pi-kill-harness
4. cases/tier2.jsonl: W4.dsh-bfmw

This mixes pi, hermes, and dsh; bug-fix and feature workflows; and scoped
colleague, worker-kill, and lifecycle/gate pressure. Preserve every row's
caps, predicates, task, context, oracles, and chaos definition. No silent
replacement or relaxation when a harness is unavailable: the controller's
normal capability/functional-harness classification must remain visible.
Four selected cases with one NOT_RUN is not a four-executed-case result.

These cases generally have separate origins. Their shared-daemon contention
is useful interim evidence, but it does NOT prove the single-origin W5 union
contract or its eight-run simultaneity, queue admission, and two-round chaos.

## Small story boundaries: one focused gate per story

### US-001: preparation and source provenance

Provide a portable Node CLI under bin/ (suggestion: tt-contention-slice with
prepare/sample/summarize subcommands; a tiny shared module is fine).

The preparation command reads the current source catalogs, requires each
selected id exactly once, and writes a manifest whose row bytes match those
source lines. Use a fresh unique directory under this checkout's
torture-test/var. Never overwrite or remove a previous preparation/result.
Reject path traversal and symlink escapes; do not accept arbitrary external
output destinations or silently follow an existing destination symlink.

Write provenance alongside the generated manifest: selected ids/order,
relative catalog paths and line numbers, catalog/row/task hashes, source
commit and tracked-tree cleanliness, generated manifest hash, and the exact
controller executable/cwd/argv. A dirty source tree must not be presented as
a pinned clean candidate. The intended argv uses --concurrency 4 and
--stagger 10s. Print the argv legibly, but do not execute the campaign.

Use the existing controller --validate-only path to validate the generated
manifest without launching anything. Return a failure if validation fails;
retain the failure artifacts. No automatic provisioning, credential copying,
daemon startup, catalog refresh, or environment mutation.

Focused gate: isolated preparation/provenance/path-refusal tests, including
missing/duplicate ids and byte-for-byte equality with all four source rows.

### US-002: strictly read-only simultaneity sampler and honest summary

Given an explicit prepared manifest/provenance and controller campaign,
sample every 15 seconds until its selected cases are terminal or an explicit
bounded observation window ends. Inspect the actual controller state schema
and reuse its run-id representation. Scope observations to the exact run ids
recorded for the selected campaign attempts, including replacement attempts
when they are explicitly recorded; never count unrelated background runs.

Use a read-only SQLite connection to the explicitly contained real campaign
DB derived from this checkout's torture-test/var/home state. Resolve and
validate every supplied path before opening it. Never default to the
operator's HOME, create/migrate a DB, bind or contact a listener, or execute
workflow/control commands. Existing helpers may be reused when their
ownership and read-only behavior match this boundary.

Record timestamped samples with the selected case/run mapping, run statuses,
claimed/running step counts, observed active-case and claimed-run counts,
and any unknown/missing/error observations. Read related DB rows in one
read-only snapshot where practical. A read error or missing run is UNKNOWN,
not evidence of zero active work or completion. Capture observation gaps.

The summary reports configured concurrency separately from the observed
claimed-step peak, the actual executable/NOT_RUN/terminal counts, and
coverage gaps. Starting the observer after completion cannot manufacture
simultaneity proof. If the observed peak is below three, or evidence is
insufficient, report that honestly; do not print an unqualified passed-storm
claim. Preserve samples and partial summaries even if observation fails.
The observer must never stop, resume, restart, kill, delete, or otherwise
repair the campaign it observes. An observation-window end is not a run
failure or permission to terminate it.

Focused gate: hermetic toy-DB/campaign tests covering overlapping and serial
states, a decoy run, replacement mapping, missing/corrupt/escaped evidence,
partial observation, and no mutation of input DB/files. Provide a single
sample or bounded fast mode for tests; no real daemons or fixed-port tests.

### US-003: operator recipe and end-to-end hermetic acceptance

Document the safe operator sequence under torture-test/: verify the pinned
build/catalog and functional harnesses, ensure no other contained campaign
is using this host, prepare the input, launch the existing controller with
the recorded argv, attach the read-only observer, and retain reports/logs.
The controller owns its ordinary case lifecycle; this helper only prepares
data and observes it. The real slice spends tokens; the implementation tests
do not. The full W5 orchestrator and true two-round campaign remain pending.

Use a fixture-backed end-to-end preparation/sample/summary test as this
story's gate, plus help/argument handling checks. A no-argument/help request
must have no filesystem, daemon, or model side effects. Do not add a large
battery or tier-ladder proof story. Normal workflow npm test verification
still applies and must be reported with its actual result.

## Boundaries and safety

- Change only new focused tools/modules/tests/docs under torture-test/ and
  any necessary self-test registration. Do not edit product files, the
  existing controller/oracles, source catalog rows, or fixture task behavior.
- R4a #906 and other implementation runs are active. Do not run the torture
  battery, heavy operator corridors, or any tier campaign in this run.
  Proofs here must be hermetic and independent of shared contained ports.
- Tests own fresh temporary fixture paths. No broad recursive cleanup,
  forced worktree removal, global git configuration changes, or name/pattern
  process kills. Preserve existing worktrees, homes, credentials, and logs.
- Never rebuild the origin checkout, refresh its installed catalog, or
  restart the live daemon. Build and test this run's own worktree only.
- Keep shell glue compatible with macOS's default shell tools; prefer Node
  built-ins for paths, hashes, JSON, and read-only SQLite. Do not auto-source
  operator dotfiles or write any operational shim into the user's home.
- Allow npm test at least 30 minutes at the command-runner level. Do not
  weaken assertions or add retries to hide host-load failures.
- Merge locally through the workflow; no origin push, release, Mac source
  synchronization, or real campaign launch. Coordinator acceptance follows.

Test command: npm test
