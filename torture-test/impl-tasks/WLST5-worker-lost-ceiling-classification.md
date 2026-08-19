# WLST5: worker_lost counter ticks on healthy at-ceiling rounds — classify round terminations (product fix, authorized)

The run-level `worker lost` counter (wl:N in `workflow runs`, "Worker
lost: N" in `workflow status`) conflates genuinely lost workers with
rounds that the motor itself killed at the worker time ceiling
(timeoutSeconds). Fresh evidence: T2.1 (run-8a2347b6) finished
successfully with wl:6 and E3.C.2 (run-3af479d1) with wl:2 — the majority
of those ticks were 6-hour ceiling expiries of PRODUCTIVE proof rounds
(work committed throughout; outcome empty_output only because the dsh
harness buffers stdout until exit, so a ceiling SIGKILL discards the
narrative but not the work). An operator reading wl:6 cannot distinguish
"harness crashed six times" from "six long rounds hit the configured
ceiling while making progress".

Deliverables (product code, src/):

1. **Classify round terminations at the source.** Where the motor
   records a lost worker, distinguish at minimum:
   - `ceiling_expiry`: the motor's own timeout killed the round;
   - `harness_lost`: the harness process died/vanished without the
     motor killing it (crash, external kill, OOM);
   - keep the existing clean-exit-without-STATUS abandonment accounting
     unchanged (that is a separate, already-working signal).
2. **Separate counters end-to-end.** DB fields/event payloads, then
   `workflow status` (e.g. "Rounds expired at ceiling: N / Workers
   lost: M") and the `workflow runs` compact display (wl:M should count
   ONLY harness_lost). Preserve backward compatibility of any consumed
   event shapes — additive fields, not repurposed ones.
3. **Timeout feedback stays intact.** The existing abandonment counters
   and story-scoped verify budgets (VBUD) must keep functioning with
   unchanged thresholds; only the OBSERVABILITY of why rounds ended
   changes. If the abandonment path treats ceiling expiries and crashes
   differently today, document the current behavior in the report — do
   not change policy in this run.
4. **Tests.** Unit coverage for the classification (simulate a motor
   timeout kill vs an externally killed harness process) and a display
   test for the split counters.

## Hard constraints

- PARKED-MERGE DISCIPLINE: a torture campaign is running against the
  production install. Your merge target is the staging branch this run
  was launched against (NOT main) — never push, merge, or otherwise
  mutate main or the installed catalog during this run.
- Do not restart, signal, or reconfigure the LIVE daemon (33xx).
- Zero changes under torture-test/ — this is a product run; the suite's
  oracles will be recalibrated separately once the new counters exist.
