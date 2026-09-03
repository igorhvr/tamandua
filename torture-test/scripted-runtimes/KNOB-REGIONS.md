# KNOB-REGIONS — Documented fault-injection regions

This file documents every `KNOB-REGION-BEGIN` / `KNOB-REGION-END` block in the
forked scripted runtimes. The `fork-parity-check` script uses these markers to
exclude intentional additions from the diff against the FROZEN_SHA originals.

## runtime-pi.mjs

| Lines (approx) | Story | Description |
|---|---|---|
| 118–239 | US-004 | Fault injection knobs: `emitMalformedMessageEnd`, `emitOversizedStdout`, `handleProviderError`, `scheduleMessageEnd`, `maybeExit`, `_exitPending` |
| 243–265 | IFLB US-007 | Launch-time harness probe support: answer the `TAMANDUA_HARNESS_PROBE: skill-path` probe prompt (before `parsePrompt`) by running the exact quoted `<launcher> skill-path` command for real and replying with the PATH via a pi-shaped `message_end` (zero tokens), never journaled, never consuming a work index |
| 347–360 | US-004 | `provider_error` priority check: if `behavior.provider_error` is set, emit the error shape instead of normal workflow |
| 434–513 | US-004 | `runWorkRound` knob modifications: oversized stdout padding, knob-aware message-end scheduling, hasKnobs path (step complete before delayed/omitted/malformed message_end), return guards |

Total regions: 4

## runtime-hermes.mjs

| Lines (approx) | Story | Description |
|---|---|---|
| 119–254 | US-005 | Fault injection knobs for hermes: `emitOversizedStdout`, `emitMalformedSessionId`, `writeBogusSessionRow`, `handleProviderError`, `scheduleSessionTrailer`, `maybeExit`, `_exitPending` |
| 305–329 | IFLB US-007 | Launch-time harness probe support: answer the `TAMANDUA_HARNESS_PROBE: skill-path` probe prompt (before `parsePrompt`) by running the exact quoted `<launcher> skill-path` command for real and replying with the PATH as the plain-text final message on stdout (no state.db session row, no `session_id` trailer — zero-token round), never journaled, never consuming a work index |
| 417–430 | US-005 | `provider_error` priority check (same pattern as pi, hermes output shape) |
| 478–499 | US-005 | `failThisStep` knob-awareness (scheduleSessionTrailer before exit) |
| 510–531 | US-005 | `die-after-claim` knob-awareness (scheduleSessionTrailer before exit) |
| 540–621 | US-005 | `runWorkRound` knob modifications: oversized stdout, knob-aware session trailer scheduling, hasKnobs path, return guards |

Total regions: 6

## runtime-shared.mjs

| Lines (approx) | Story | Description |
|---|---|---|
| 102–212 | IFLB US-007 | Launch-time harness probe helpers shared by the pi + hermes runtimes: `HARNESS_PROBE_MARKER`, `isHarnessProbePrompt`, `parseHarnessProbeCommand`, `splitProbeCommand`, `execHarnessProbe` (quote-aware argv split; real `spawnSync` of the quoted `<launcher> skill-path` command in the child env; never journaled, never consuming a work index) |

Total regions: 1

## Non-knob modifications (outside KNOB-REGION markers)

These intentional changes are also excluded from the fork-parity-check:

### runtime-pi.mjs
- Import path adjustment: `scripted-agent-runtime-shared.mjs` → `runtime-shared.mjs` (US-001)
- `shortAgent` → `agentId` key changes in `nextWorkIndex` (US-003)
- IFLB US-007 import specifiers: `isHarnessProbePrompt`, `execHarnessProbe` added to the `./runtime-shared.mjs` import

### runtime-hermes.mjs
- Import path adjustments: `e2e-database.mjs` → `database.mjs`, `scripted-agent-runtime-shared.mjs` → `runtime-shared.mjs` (US-001)
- `shortAgent` → `agentId` key changes in `nextWorkIndex` (US-003)
- IFLB US-007 import specifiers: `isHarnessProbePrompt`, `execHarnessProbe` added to the `./runtime-shared.mjs` import

### runtime-shared.mjs
- `behaviorForInvocation` priority change: full `workflowId_agentId` key → `shortAgent` fallback (US-003)
