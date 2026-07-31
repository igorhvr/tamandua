# Implement `tt-controller` — the torture-test campaign controller (Phase C core)

Authoritative spec in this repo — READ these fully before designing:
- `torture-test/tamandua-torture-test-spec/12-runner-automation.md` — the
  controller contract (manifest format WITH the `requires` predicate,
  run-id dual-stream capture, wait-exit↔DB cross-check, discovered-run
  records, design rules, resumability). This file IS the requirements doc.
- `torture-test/tamandua-torture-test-spec/03-oracles.md` — the outcome
  taxonomy (PASS/PRODUCT_FAIL/AGENT_FLAKE/PROVIDER_FAIL/TEST_INFRA_FAIL/
  INVALID/INCONCLUSIVE/NOT_RUN) the controller must classify into, and the
  case-classification field (verification/characterization/exploratory).
- `torture-test/tamandua-torture-test-spec/01-environment-and-isolation.md`
  — host profile, two-daemon model, spawn-env discipline (the controller
  itself runs under the REAL home and applies spawn envs per-command).
- `torture-test/tamandua-torture-test-spec/11-schedule-budget-abort.md` —
  budget ledger, caps as observed-spend thresholds, wall_min enforcement
  via `workflow stop` (NOT `--wait --timeout`, which only stops the
  waiter).
- Existing conventions: `torture-test/bin/tt-run` (the user-facing
  launcher — it will DELEGATE to your controller; do not break its flag
  contract), `torture-test/bin/tt-verify-environment` (host-profile.json
  producer), `torture-test/env/*.sh`.

## Deliverables

1. `torture-test/bin/tt-controller` (node, no build step, no new npm
   deps) — reads a case manifest and executes a campaign slice:
   - **Manifest**: `torture-test/cases/cases.jsonl` — one JSON object per
     case per the spec-12 format (id, wave, workflow, fixture, harness,
     task file, context, caps{tokens,wall_min}, requires{...}, oracles[],
     gates[], chaos, shed_ok, mandatory, class). Define the JSON Schema in
     `torture-test/cases/case.schema.json` and validate every line on
     load; refuse the campaign on any invalid line.
   - **Predicate evaluation** against
     `torture-test/var/w0/host-profile.json` → unsatisfiable cases become
     `NOT_RUN (predicate)`, recorded, never silently skipped.
   - **Execution**: per case — fixture reset hook (shell out to a
     per-fixture reset command declared in the manifest), launch via the
     tamandua CLI under the appropriate spawn env (`env/tt-env.sh` vs
     `tt-env-scripted.sh` chosen per case), background the run, capture
     BOTH stdout (`Run: run-...`) and stderr (early short id) per spec
     12's run-id capture; concurrency limit + launch stagger from CLI
     flags; poll tokens vs caps every 5 min; wall_min enforcement =
     `workflow stop` + wait for terminal.
   - **Harvest**: terminal state from `workflow status --json` AND the
     wait exit code, cross-checked (disagreement = the free O13-class
     truthfulness finding — record it); tokens; steps table snapshot via
     `--json` surfaces (read-only sqlite fallback allowed per repo
     conventions: `sqlite3 -readonly`).
   - **Oracle execution hook**: run each case's oracles as executables
     from `torture-test/oracles/<id>` if present, else record
     `ORACLE_MISSING` (the oracle battery is a separate task — the hook
     and its evidence-JSON contract are yours: define it in
     `torture-test/oracles/CONTRACT.md`).
   - **Classification** into the 03 taxonomy from mechanical evidence
     only (never agent prose), with the retry rule for PROVIDER_FAIL.
   - **State & resume**: `torture-test/var/results/<campaign-id>/state.json`
     written before every launch and after every harvest; on restart with
     `--resume <campaign-id>`, in-flight runs are re-attached via
     `workflow wait`, never relaunched.
   - **Report**: `report.txt` + `report.json` in the campaign results dir
     (scenario × outcome table, spend ledger, NOT_RUN list with reasons,
     findings list) — `tt-run --report` (already implemented) reads the
     newest results dir, so match its expectations (`report.txt`).
2. `torture-test/cases/smoke.jsonl` — a first real manifest: the W0
   zero-token cases implementable today (W0.0 via tt-verify-environment;
   fixture-baseline checks for the fixtures present under
   `torture-test/var/fixtures/golden/`), enough for
   `tt-controller --manifest torture-test/cases/smoke.jsonl` to execute a
   real (zero-token, no-daemon-needed) campaign slice end to end and
   produce a report.
3. `torture-test/bin/tt-controller.test.sh` — self-test: schema rejection
   of a bad line, predicate NOT_RUN path, the smoke manifest end-to-end,
   resume-after-kill (kill -9 the controller mid-slice, --resume, no
   double execution — use a slow dummy case).

## Hard constraints

- Files ONLY inside `torture-test/`; state ONLY under `torture-test/var/`.
- The controller NEVER interprets agent prose; never mutates production
  state; never starts/stops daemons itself (that is daemon-control's job
  — invoke it if present, skip daemon-needing cases with a recorded
  reason if not).
- Do not launch any token-spending run in your own testing: everything in
  your acceptance path is zero-token (the smoke manifest + dummy cases).
- Do not modify `torture-test/bin/tt-run` beyond (if needed) wiring
  `--smoke` to run the smoke manifest through tt-controller instead of
  calling tt-verify-environment directly — preserve its flag contract and
  exit-code semantics exactly.

## Acceptance (verify before reporting done)

- `tt-controller --manifest torture-test/cases/smoke.jsonl` runs the
  slice, produces report.txt/report.json + state.json; exit code follows
  tt-run's verdict semantics (0 green, 1 findings, 2 infra).
- `./run-torture-test --smoke` still works and now routes through the
  controller; `./run-torture-test --report` renders the new report.
- `tt-controller.test.sh` passes, including the kill/resume leg.
