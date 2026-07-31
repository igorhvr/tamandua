# Build the scripted harness runtimes (scripted-pi / scripted-hermes forks + fault knobs)

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/12-runner-automation.md`
  (§Scripted-runtime forks — frozen-SHA fork, fault knobs, fork-parity
  check) and `01-environment-and-isolation.md` (§two-daemons — behaviors
  concurrency protocol, scenario-unique workflow copies, absolute-node
  wrappers, the W0 binding proof).
- `torture-test/tamandua-torture-test-spec/08-wave-4-fault-injection.md`
  — W4.40 (delayed/absent/malformed trailer, oversized stdout) and W4.46
  (provider-error rounds) name the knobs these runtimes must support.
- SOURCE GROUND TRUTH: the repo's own e2e scripted harness fakes (find
  them under tests/ — the scripted and scripted-hermes e2e suites and
  whatever fake pi/hermes runtimes they use). The torture runtimes are
  FORKS of those fakes: same output contracts the product's own e2e
  suite pins, extended with fault knobs.

## Deliverables

1. `torture-test/scripted-runtimes/` containing:
   - `FROZEN_SHA` — a file recording the repo commit whose e2e fakes you
     forked from (the current HEAD when you do the fork).
   - The forked runtime(s) (`runtime-pi.mjs`, `runtime-hermes.mjs` or
     equivalent — match the fakes' real structure), extended with knobs
     controlled per-round via the behaviors file: `delayed_trailer_ms`,
     `omit_trailer`, `malformed_trailer`, `oversized_stdout_mb`,
     `provider_error` (429 / 529 / mid-stream-drop shapes), plus the
     baseline scripted behaviors the fakes already support.
   - `bin/scripted-pi` and `bin/scripted-hermes` — wrapper scripts with
     ABSOLUTE node paths (daemon PATH is not guaranteed; no shebang
     reliance), matching what `torture-test/env/tt-env-scripted.sh`
     already points at.
   - `behaviors/` — the behaviors-file format implementation per spec
     01: ONE file fixed at daemon start (path via env var), keyed by
     full `<workflowId>_<agentId>` with shared counters; plus
     `install-scenario-workflows` — a tool that installs scenario-unique
     workflow COPIES (`<base>-<scenarioId>`) into the scripted daemon's
     env so no two scripted scenarios ever share a workflow id.
   - `fork-parity-check` — mechanically diffs the fork's non-knob
     regions against the FROZEN_SHA fakes and fails on drift (the W0.2
     re-assertable check; document precisely which regions are knob
     regions).
2. `torture-test/scripted-runtimes/test.sh` — self-test WITHOUT any
   daemon: invoke each runtime directly the way the dispatcher would,
   with a behaviors file exercising: normal done round; STATUS: retry
   round; each fault knob (verify the delayed trailer really arrives
   after stdout close + exit; the oversized round streams without
   buffering it all; provider-error shapes are byte-plausible); and the
   hermes token trailer contract (state.db writes if that is how the
   real fake works — mirror the real contract exactly).
3. The W0.3b binding proof made runnable: a script
   `torture-test/scripted-runtimes/binding-proof.sh` that (given
   daemon-control from Phase A) starts the scripted daemon, runs one
   trivial scripted do-now through it, asserts ZERO real tokens spent
   and output matching the behaviors file, and stops it. If
   daemon-control or workflow-copy installation prerequisites are
   missing at your runtime, the script must fail with a precise message
   (not silently pass) — it will be wired into W0 later.

## Hard constraints

- Files ONLY inside `torture-test/`; state ONLY under `torture-test/var/`.
- Do NOT modify the repo's real e2e fakes or anything outside
  torture-test/ — fork by copying.
- No new npm dependencies.

## Acceptance

- `test.sh` passes twice consecutively; `fork-parity-check` passes
  against FROZEN_SHA and FAILS when you deliberately perturb a non-knob
  line (demonstrate both, restore after).
- Wrappers execute from a bare `env -i PATH=/usr/bin:/bin` shell.
