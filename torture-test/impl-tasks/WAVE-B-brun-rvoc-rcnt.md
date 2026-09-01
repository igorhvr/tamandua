# WAVE-B: BRUN scope-2 (instant-fail classifier) + RVOC (respawn event) + RCNT (reroute counter)

Authorized by igorhvr 2026-09-01 (bd memory triage-decisions-2026-09-01).
Three independent small product fixes, one run.

## 1. BRUN scope-2: instant-fail classification misses
Root cause (proven, subagent diagnosis 2026-09-01): `isInstantFailRound`
(src/installer/instant-fail.ts:118-135) requires
`Buffer.byteLength(result.output) === 0` on UNTRIMMED output, but dsh
prints a lone trailing newline even when aborting (e.g. MISSING_CREDENTIAL
in ~490ms, exit 1) — 1 byte => not classified => the streak-RESET branch
(agent-scheduler.ts:1163-1168) wiped the streak every round; 979 such
rounds across four runs never incremented instant_fail_count (archived DB
proof: all zeros). Meanwhile the scheduler's own outcome classifier
(summarizeWorkRoundOutput, agent-scheduler.ts:574) TRIMS first and logged
the same rounds as outcome=empty_output/outputBytes=0.
Fix:
- Align the classifier with the outcome classifier's semantics: measure
  TRIMMED output (whitespace-only stdout cannot carry a STATUS marker).
- Also classify signal-death rounds: exitCode null + signal present +
  no trimmed output + sub-threshold wall => instant-fail (currently the
  `exitCode !== null` requirement excludes SIGKILL/OOM loops entirely).
- Regression tests pinning the exact incident shape (output "\n",
  exitCode 1, wallMs ~490 => classified; streak increments; K=3 backoff
  engages; N=10 force-fails with the legible reason) and the signal
  shape (code null, signal SIGKILL, output "" => classified).
- Do NOT implement the STATUS-marker reformulation (documented follow-up
  only); do not change thresholds.

## 2. RVOC: respawn event vocabulary
When the watchdog/dead-worker recovery respawns work for a step (the
SIGKILL-recovery corridor), the event stream shows a second `step.running`
with no connecting event. Emit a distinct event (e.g. `step.respawned`
with {step, prior_pid/round, reason}) at the point recovery re-dispatches
a claimed step, so consumers can distinguish respawn from anomalous
duplicate. DB retry_count semantics unchanged.

## 3. RCNT: reroute counter/event consistency
Observed (W4.10-restart-recovery re-run): finalize step rerouted once
(step.rerouted event emitted, merger ran twice) but the step row's
terminal_reroute_count stayed 0. Find the reroute path that emits the
event without incrementing the counter (likely the checkout-refresh/PARK
finalize reroute corridor) and make counter and event atomically
consistent. Regression test: drive that corridor; assert event count ==
terminal_reroute_count.

## Prove
Full `npm test` green; new unit/integration tests as above; no behavior
change for legitimately-fast successful rounds (exit 0 fast rounds stay
unclassified).

## Constraints
Product code only; do not touch torture-test/ except honest pin updates.
Preserve all existing escalation thresholds and fail-closed semantics.
