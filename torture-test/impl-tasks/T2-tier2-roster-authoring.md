# T2: author the Tier-2 campaign roster — wave-4 fault cases, storm, dsh lane, --tier2 ladder rung

Tier-1 machinery is complete (E2.x + E3.x all merged). Author Tier-2
per spec (`torture-test/tamandua-torture-test-spec/`, esp.
08-wave-4-fault-injection.md, 09-wave-5-storm.md, 04-campaign-tiers):

1. **cases/tier2.jsonl** — the wave-4 fault-injection roster (~45
   scenarios W4.x per spec; REAL cases use the now-working chaos/probe
   machinery from E3.C/E3.D; scripted W4 cells already in the tier0
   library are referenced, not duplicated) + the capacity-scaled
   wave-5 storm case(s) with the two-round simultaneity check. Every
   case: requires-predicates against host-profile schema (E2.2
   contract), context.test_cmd where workflow-launching (E3.A
   contract), seed fields where bug-fix (E3.A), production duration
   floors + caps per E3.D's calibration table philosophy, probe/chaos
   blocks per E3.C's schema. Honest exclusion list for anything spec'd
   but deliberately out (case -> spec section -> reason); zero silent
   trims.
2. **dsh lane** (operator-directed): add dsh-harness variants for a
   representative subset (at least: one do-now, one bfmw, one fdmw,
   one lifecycle case) so the campaign exercises dsh as a first-class
   harness; predicates must probe dsh presence in host-profile (extend
   tt-verify-environment if it does not probe dsh yet — record, never
   install).
3. **Task archetypes** under cases/tasks/tier2/ aligned with actual
   seeds/probes (the E2/E3.A lesson: task text must describe what the
   fixture actually contains).
4. **tt-run --tier2 rung**: bare mode = scripted-only + pending-real
   GREEN semantics identical to tier1; --include-real wiring identical.
   Fail-closed exit semantics preserved (E2.2).
5. Prove ZERO tokens: schema-validate all cases; bare
   `./run-torture-test --tier2` GREEN x2 (scripted PASS, real
   pending-real, honest NOT_RUN predicates); dry-run stub shows the
   first real W4 case and one dsh-lane case reaching launch argv;
   bare --tier1 still GREEN (no regression); hygiene canary UNCHANGED.

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon untouched.
- Do NOT modify torture-test/self-tests kill-path files (concurrent
  run E3.C.1 owns them) — coordinate by not touching
  self-tests/tier1-*kill*/probe-battery test files; new tier2
  self-tests go in NEW files.
- Spec-faithful: where spec and current machinery disagree, follow
  spec and document the delta; no scope trims without the exclusion
  list.
