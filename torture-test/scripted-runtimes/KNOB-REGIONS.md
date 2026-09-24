# KNOB-REGIONS — Documented fault-injection regions

This file documents every `KNOB-REGION-BEGIN` / `KNOB-REGION-END` block in the
forked scripted runtimes. The `fork-parity-check` script uses these markers to
exclude intentional additions from the diff against the FROZEN_SHA originals.

Line ranges below are the exact `KNOB-REGION-BEGIN` .. `KNOB-REGION-END`
marker lines, inclusive (both markers counted). Keep them in sync with the
markers whenever a region is inserted, moved, or extended — a pure insertion
shifts every later range by the inserted line count.

## runtime-pi.mjs

| Lines (approx) | Story | Description |
|---|---|---|
| 119–240 | US-004 | Fault injection knobs: `emitMalformedMessageEnd`, `emitOversizedStdout`, `handleProviderError`, `scheduleMessageEnd`, `maybeExit`, `_exitPending` |
| 244–266 | IFLB US-007 | Launch-time harness probe support: answer the `TAMANDUA_HARNESS_PROBE: skill-path` probe prompt (before `parsePrompt`) by running the exact quoted `<launcher> skill-path` command for real and replying with the PATH via a pi-shaped `message_end` (zero tokens), never journaled, never consuming a work index |
| 348–361 | US-004 | `provider_error` priority check: if `behavior.provider_error` is set, emit the error shape instead of normal workflow |
| 370–388 | CORE-REPLAY | Die-before-claim preserved public stdout: when `behavior.preservedStdout` is a string (replay.unclaimed_exit outputRefs), write those exact bytes VERBATIM via `fs.writeSync(1, behavior.preservedStdout)` (no appended newline — empty / no-final-newline payloads preserved; synchronous so no queued bytes are lost on the immediate `process.exit`) before `process.exit(behavior.exitCode ?? 3)` in the `die-before-claim` branch |
| 431–446 | STORM US-002 | Campaign-controlled mid-flight hold: on the default `'work'` path, after a successful claim and before `failThisStep`/`applyBehaviorActions`, `await applyHold(behavior, { stateDir, runId, log: logInvocation })` parks the round on the campaign's per-run checkpoint until released (fail-closed bounded timeout) |
| 475–554 | US-004 | `runWorkRound` knob modifications: oversized stdout padding, knob-aware message-end scheduling, hasKnobs path (step complete before delayed/omitted/malformed message_end), return guards |

Total regions: 6

## runtime-hermes.mjs

| Lines (approx) | Story | Description |
|---|---|---|
| 120–255 | US-005 | Fault injection knobs for hermes: `emitOversizedStdout`, `emitMalformedSessionId`, `writeBogusSessionRow`, `handleProviderError`, `scheduleSessionTrailer`, `maybeExit`, `_exitPending` |
| 306–330 | IFLB US-007 | Launch-time harness probe support: answer the `TAMANDUA_HARNESS_PROBE: skill-path` probe prompt (before `parsePrompt`) by running the exact quoted `<launcher> skill-path` command for real and replying with the PATH as the plain-text final message on stdout (no state.db session row, no `session_id` trailer — zero-token round), never journaled, never consuming a work index |
| 418–431 | US-005 | `provider_error` priority check (same pattern as pi, hermes output shape) |
| 440–458 | CORE-REPLAY | Die-before-claim preserved public stdout: when `behavior.preservedStdout` is a string (replay.unclaimed_exit outputRefs), write those exact bytes VERBATIM via `fs.writeSync(1, behavior.preservedStdout)` (no appended newline — empty / no-final-newline payloads preserved; synchronous so no queued bytes are lost on the immediate `process.exit`) before `process.exit(behavior.exitCode ?? 3)` in the `die-before-claim` branch |
| 500–516 | STORM US-002 | Campaign-controlled mid-flight hold: identical insertion to pi, on the default `'work'` path only, using the PARSED `runId` (full `run-...`, not the stripped `inputVars.RUN_ID`) for the checkpoint filename |
| 520–541 | US-005 | `failThisStep` knob-awareness (scheduleSessionTrailer before exit) |
| 552–573 | US-005 | `die-after-claim` knob-awareness (scheduleSessionTrailer before exit) |
| 582–663 | US-005 | `runWorkRound` knob modifications: oversized stdout, knob-aware session trailer scheduling, hasKnobs path, return guards |

Total regions: 8

## runtime-shared.mjs

| Lines (approx) | Story | Description |
|---|---|---|
| 102–212 | IFLB US-007 | Launch-time harness probe helpers shared by the pi + hermes runtimes: `HARNESS_PROBE_MARKER`, `isHarnessProbePrompt`, `parseHarnessProbeCommand`, `splitProbeCommand`, `execHarnessProbe` (quote-aware argv split; real `spawnSync` of the quoted `<launcher> skill-path` command in the child env; never journaled, never consuming a work index) |
| 216–403 | STORM US-002 | Campaign-controlled mid-flight hold primitive shared by pi + hermes: suffix constants `HOLD_CONFIRMED_SUFFIX` / `HOLD_RELEASE_SUFFIX` / `HOLD_MISSED_SUFFIX`, `DEFAULT_HOLD_TIMEOUT_MS`, `resolveHoldDir`, and async `applyHold`. Writes `<holdDir>/<runId>.confirmed`, polls every 250 ms for `<holdDir>/<runId>.release`, writes `<holdDir>/<runId>.missed` + returns `timeout` on the bounded fail-closed deadline; never throws and never blocks past the timeout. FIX5 US-003 (SF-10) adds the one-shot rule (lines 341–354): a hold is armed at most once per `(campaign, runId)` (the run-lifecycle checkpoint — one workflow execution, one hold); `applyHold` checks `<runId>.release` / `<runId>.missed` BEFORE mkdir/write, so an existing release returns `{ outcome: 'already_released' }` and an existing missed returns `{ outcome: 'already_missed' }` immediately, journaled as `hold_already_released` / `hold_already_missed`, WITHOUT writing `.confirmed` and WITHOUT waiting. The entry code no longer `rmSync`s release/missed markers, so a later invocation of any agent in the same run (second merger round after a `finalize_merge` reroute, DRDV do-again) never re-arms the hold or deletes an engine marker. Normal `released` / `timeout` outcomes are unchanged |

Total regions: 2

## runtime-dsh.mjs

This file is the CORE-CELLS US-003 (original US-005 BRUN) minimal suite-owned
plain-stdout dsh frozen-runtime fork. It contains NO `KNOB-REGION` blocks
(total regions: 0). Parity basis:

- The e2e original (`e2e-tests/helpers/scripted-dsh-runtime.mjs`) was added to
  the product helpers AFTER the fork's `FROZEN_SHA`, so it has no FROZEN_SHA
  baseline. Its parity is enforced against the CURRENT committed e2e original
  by `fork-parity-check` (dsh section) and
  `self-tests/scripted-runtime-fork.test.ts` (same non-knob diff filter as the
  pi/hermes forks).
- Allowed non-knob differences (identical to the pi/hermes fork conventions):
  - Import path adjustment: `scripted-agent-runtime-shared.mjs` →
    `runtime-shared.mjs` (US-001 convention)
  - `nextWorkIndex` keyed by full `agentId` instead of `shortAgent` (US-003
    convention; keeps the runtime's workcount census keyed `do-now_doer` like
    the other torture forks)
- Everything else is byte-identical to the e2e dsh runtime, including the
  plain-text stdout emission contract (`emitOutput`: exactly the final text
  plus one trailing `\n`, nothing on stderr), the probe-answer block
  (byte-identical to the e2e copy per the live-helper parity rule), and the
  fake `session.v3.jsonl.zstd` writer under `$DSH_HOME` (dsh >= 0.1.5 format
  v3: one `assistant/message` record carrying a TOP-LEVEL `data.usage` object,
  tracking base commit 59f955c5 which updated the product e2e runtime and the
  `src/installer/dsh-usage.ts` reader to the v3 format).

Total regions: 0

## Non-knob modifications (outside KNOB-REGION markers)

These intentional changes are also excluded from the fork-parity-check:

### runtime-pi.mjs
- Import path adjustment: `scripted-agent-runtime-shared.mjs` → `runtime-shared.mjs` (US-001)
- `shortAgent` → `agentId` key changes in `nextWorkIndex` (US-003)
- IFLB US-007 import specifiers: `isHarnessProbePrompt`, `execHarnessProbe` added to the `./runtime-shared.mjs` import
- STORM US-002 import specifier: `applyHold` added to the `./runtime-shared.mjs` import
- STORM US-002 async plumbing: `runWorkRound` becomes `async` and its top-level call site becomes `await runWorkRound()` so the campaign hold can park the round without blocking the event loop (the hold body itself lives in a documented KNOB-REGION)

### runtime-hermes.mjs
- Import path adjustments: `e2e-database.mjs` → `database.mjs`, `scripted-agent-runtime-shared.mjs` → `runtime-shared.mjs` (US-001)
- `shortAgent` → `agentId` key changes in `nextWorkIndex` (US-003)
- IFLB US-007 import specifiers: `isHarnessProbePrompt`, `execHarnessProbe` added to the `./runtime-shared.mjs` import
- STORM US-002 import specifier: `applyHold` added to the `./runtime-shared.mjs` import
- STORM US-002 async plumbing: `runWorkRound` becomes `async` and its top-level call site becomes `await runWorkRound()` (same rationale as pi)

### runtime-shared.mjs
- `behaviorForInvocation` priority change: full `workflowId_agentId` key → `shortAgent` fallback (US-003)
