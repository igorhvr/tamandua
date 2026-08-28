# S27: O10's FMIS event-set model has never met a real multi-step workflow — calibrate it without weakening it

S26 (bad9a5b7) unmasked this: O10's reconciliation throw always fired
before its decision-table checks on real cells, so those checks have
never run against a real workflow event stream. Post-S26 replay of
tier-2 attempt-2 (campaign-20260826T225744158Z-4bf26d7f) heals all 23
O10 reconciliation ERRORs to FAIL with a UNIVERSAL
`O10_EVENT_SET_MISMATCH` — every scenario type, both harness families,
even the storm anchor. Sample (W4.03): expected
`merge.landed,run.completed,step.running` (exactly one step.running) vs
observed `merge.landed,run.completed,step.rerouted,step.running x7`.
The model (o10.mjs expectedEventNames, ~:382-386) assumes a
single-step, no-reroute cell — true for scripted FMIS probes, false for
every real multi-step workflow (one step.running per step execution;
legal reroute corridors exist and are already modeled by O11).

A universal finding is a calibration artifact, but do NOT blanket-
tolerate: O10's event discipline is the FMIS merge-gate seal. Model the
LEGAL event multiset for real cells precisely:
- step.running multiplicity = one per step execution recorded in the
  DB steps/events evidence (derive expected count mechanically from the
  captured evidence, not from a constant);
- reroute events must reconcile with terminal_reroute_count and the
  legal corridors O11 already recognizes (reuse/share that discipline
  rather than re-inventing; keep O10_REROUTE_COUNT semantics for FMIS
  cells where the decision table genuinely bounds reroutes);
- merge-gate event subset (merge.*, run.completed/failed) keeps EXACT
  expected-set semantics from the decision table — that is the seal;
  anomalies there must still FAIL.
Scripted FMIS probe cells keep their current exact single-step model.
Document the two-regime contract in oracles/CONTRACT.md.

Also audit the 2 cases whose healed O10 carries findings beyond
EVENT_SET/REROUTE (W4.29 also has MERGER_INVOCATION_COUNT,
REF_MOVEMENT, TERMINAL_DISPOSITION, REFUSAL_DIAGNOSIS): determine per
finding whether the recalibrated model still yields it; these may be
genuine and must not be silently absorbed.

## Prove
- Red-then-green via tt-oracle-replay against attempt-2 evidence:
  the 21 cases whose ONLY post-S26 failure is the calibration-artifact
  O10 findings go to O10 PASS; any O10 finding that survives
  recalibration is listed with its mechanical justification in the
  landing report; all non-O10 findings byte-identical.
- Self-test red-arms: real-cell multi-step stream with legal reroute ->
  PASS; real-cell stream with a genuinely anomalous merge-gate event
  set (e.g. double merge.landed, missing run.completed) -> FAIL;
  scripted probe cell keeps exact-set semantics (existing tests stay
  green unmodified where they encode the seal).
- Full battery green; bare --tier2 GREEN x2; bare --tier1 GREEN.

## Hard constraints
- Files ONLY inside torture-test/. Zero tokens. Live daemon untouched.
- Do NOT modify campaign evidence/snapshots. Do NOT weaken the
  merge-gate exact-set seal or scripted-cell semantics.
