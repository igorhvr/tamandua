# KNOB-REGIONS — Documented fault-injection regions

This file documents every `KNOB-REGION-BEGIN` / `KNOB-REGION-END` block in the
forked scripted runtimes. The `fork-parity-check` script uses these markers to
exclude intentional additions from the diff against the FROZEN_SHA originals.

## runtime-pi.mjs

| Lines (approx) | Story | Description |
|---|---|---|
| 116–237 | US-004 | Fault injection knobs: `emitMalformedMessageEnd`, `emitOversizedStdout`, `handleProviderError`, `scheduleMessageEnd`, `maybeExit`, `_exitPending` |
| 319–332 | US-004 | `provider_error` priority check: if `behavior.provider_error` is set, emit the error shape instead of normal workflow |
| 406–485 | US-004 | `runWorkRound` knob modifications: oversized stdout padding, knob-aware message-end scheduling, hasKnobs path (step complete before delayed/omitted/malformed message_end), return guards |

Total regions: 3

## runtime-hermes.mjs

| Lines (approx) | Story | Description |
|---|---|---|
| 117–252 | US-005 | Fault injection knobs for hermes: `emitOversizedStdout`, `emitMalformedSessionId`, `writeBogusSessionRow`, `handleProviderError`, `scheduleSessionTrailer`, `maybeExit`, `_exitPending` |
| 387–400 | US-005 | `provider_error` priority check (same pattern as pi, hermes output shape) |
| 448–469 | US-005 | `failThisStep` knob-awareness (scheduleSessionTrailer before exit) |
| 480–501 | US-005 | `die-after-claim` knob-awareness (scheduleSessionTrailer before exit) |
| 510–591 | US-005 | `runWorkRound` knob modifications: oversized stdout, knob-aware session trailer scheduling, hasKnobs path, return guards |

Total regions: 5

## Non-knob modifications (outside KNOB-REGION markers)

These intentional changes are also excluded from the fork-parity-check:

### runtime-pi.mjs
- Import path adjustment: `scripted-agent-runtime-shared.mjs` → `runtime-shared.mjs` (US-001)
- `shortAgent` → `agentId` key changes in `nextWorkIndex` (US-003)

### runtime-hermes.mjs
- Import path adjustments: `e2e-database.mjs` → `database.mjs`, `scripted-agent-runtime-shared.mjs` → `runtime-shared.mjs` (US-001)
- `shortAgent` → `agentId` key changes in `nextWorkIndex` (US-003)

### runtime-shared.mjs
- `behaviorForInvocation` priority change: full `workflowId_agentId` key → `shortAgent` fallback (US-003)
