# Fix tamandua-n6z: stop agents from killing the test suite with short tool timeouts

Read bd issue `tamandua-n6z` first (`bd show tamandua-n6z`) — it has the
evidence. Summary: this repo's full `npm test` takes ~15.5 minutes
(927-945s measured), but workflow agents invoke the shim-wrapped suite
under 3-10-minute command timeouts, producing exit-87 INTERRUPTED ledger
rows (~5.5h burned across 8 runs on 2026-07-31), zero green evidence for
6 of 8 runs (so TSTX cache replays never fire), and merges landing via
the ledger-gate concession valve untested.

## Deliverables

1. **Persona guidance** — in every bundled workflow persona/prompt that
   instructs an agent to run the test suite (survey `workflows/*/`:
   tester/verifier/fixer/implementer/finalize-adjacent prompts; also
   `skills/tamandua-agents/SKILL.md` if it advises on running tests):
   add a short, forceful, uniform block: the suite may take 15-25+
   minutes; NEVER run it under a command timeout below 30 minutes;
   prefer launching it in the background (nohup/detached, output to a
   file) and polling; an interrupted suite wastes the whole attempt and
   poisons the evidence ledger. Keep the block identical everywhere
   (single source snippet, referenced or copied verbatim) so it can be
   updated in one place later.
2. **Shim duration hint** — in the `tamandua-test` shim
   (`src/suite/shim.ts`): at execution start, when the ledger has prior
   completed durations for this (origin, cmd) — any tree — print ONE
   line to stderr immediately, e.g.
   `TAMANDUA-TEST: expect ~<p50>min based on <n> prior runs — use a timeout comfortably above this`,
   so even an agent that ignored the persona sees the number before the
   suite output starts. No behavior change otherwise; zero new deps.
3. **Interrupted-execution visibility** — when the shim records exit 87
   (interrupted), the message it already emits must state plainly that
   the CALLER's timeout/signal killed the suite and that the attempt
   produced no usable evidence (adjust wording if it already exists;
   verify with a test).

## Hard constraints

- Surgical changes only: persona text additions + the two shim message
  changes. No scheduler/gate/ledger logic changes.
- Repo conventions: update unit tests covering the shim messages; keep
  `npm test` green (run it yourself with an ADEQUATE timeout — practice
  what this fix preaches).
- Do not touch `torture-test/` (this is a product fix, not suite work).

## Acceptance

- Grep proves every bundled persona that mentions running the suite
  carries the uniform timeout block.
- Shim: prior-duration hint line appears on execution start when
  history exists (unit test); exit-87 message names the caller-kill
  cause (unit test).
- Full `npm test` green.
