# WAVE-A: conditional-review step primitive + TCMD rewrite-reviewer + PHNT deception auditor

Authorized by igorhvr 2026-09-01 (bd memories: triage-decisions-2026-09-01,
phnt-design-state — read BOTH first; they carry the adopted designs and the
two reviewer prompts drafted and approved in-session).

Three coupled deliverables, one shared mechanism:

## 1. Conditional-review step primitive (product)
A workflow step kind (or step attribute) that is statically declared in
workflow.yml but conditionally dispatched: when its activation condition
(a run-context flag) is UNSET at claim time, the dispatch motor
auto-completes it with ZERO tokens (no harness spawn — same free path as
the motor's idle peek); when SET, it dispatches normally. Persist enough
on the step row that oracles/observers can distinguish auto-completed
(condition unset) from agent-reviewed. Fail closed: a review step whose
condition is SET can never be auto-completed.

## 2. TCMD: TEST_CMD establishment + rewrite review (product)
- Establishment: launch-declared `--context test_cmd=` wins; else the
  FIRST step-emitted `TEST_CMD:` marker establishes the contract.
  Persist `test_cmd_established` + source on the run.
- Detection: any later `TEST_CMD:` marker differing from the established
  value does NOT silently replace it — record a `test_cmd.rewrite_detected`
  event {old, new, step, round} and set the review flag (the primitive's
  activation condition). Trivially-equivalent forms should still go
  through the reviewer (its fast-path handles them) — do not build a
  second equivalence engine in the detector.
- Reviewer step (`test_cmd_review`) added to the merge-gate workflows,
  READ-ONLY persona, prompt EXACTLY as approved (triage-decisions memory:
  existence/coverage/narrowing-justification/task-relevance/equivalence
  checklist; default ACCEPT; REJECT requires file-grounded evidence;
  classes unjustified-narrowing | task-evasion | contradicted-justification).
  ACCEPT => the new command becomes the contract (event recorded);
  REJECT => the rewriting step retries with the finding named.
- Gate coupling: finalize/ledger-gate keys evidence on the CURRENT
  contract and refuses to finalize while a review is pending/rejected.
- Annotation fix: when a strict gate lands without suite evidence for the
  contract, `merge.landed_without_suite_evidence` MUST be emitted; when a
  reviewed rewrite occurred, the landing metadata names old+new commands.
- Regression tests keyed to the four campaign specimens: polyglot
  narrowing (W4.48c shape), wrong-command crediting (W4.18), env-variant
  nondeterminism (W4.17-b), trivial equivalence (W4.09-hermes).

## 3. PHNT: honest-account contract + deception auditor (product)
- bug-* workflows: fix step expects gain the either/or fourth key —
  `REPRO_EVIDENCE: <pointer to failing output demonstrated on the
  pre-fix tree>` OR `CANNOT_REPRODUCE: <reasons>` (existing
  STATUS/CHANGES/REGRESSION_TEST unchanged; triager's REPRODUCTION:
  narrative unchanged).
- Auditor step (`deception_audit`) after fix in bug-* workflows, on the
  SAME primitive: REPRO_EVIDENCE present => auto-complete free;
  CANNOT_REPRODUCE or contract ignored => dispatch ONE read-only round.
  Prompt EXACTLY as approved (phnt-design-state memory: deception-only
  scope, no execution, premise-fabrication / symptom-silencing /
  claim-mismatch / mechanism-plausibility checklist, DEFAULT HONEST,
  DECEPTION verdict invalid without quotable evidence, classes
  premise-fabrication | symptom-silencing | claim-mismatch | no-mechanism).
  DECEPTION => fix retries with the quoted finding; accumulated
  rejections fail the run legibly (reuse existing retry budgets).

## Prove
- Unit + integration tests for the primitive (auto-complete emits no
  harness spawn and zero tokens; set-condition dispatches; fail-closed
  arm), establishment/detection (declared-wins, first-write, detection
  event), gate coupling (pending review blocks finalize), and both
  reviewer wirings (scripted harness rounds returning ACCEPT/REJECT and
  HONEST/DECEPTION corridors).
- The four TCMD specimen regressions + two PHNT specimen regressions
  (fabricated-file shape, test-only-pin shape) as scripted corridors.
- Full `npm test` green; workflow.yml schema/docs updated; personas added
  to the workflow personas list; e2e scripted lane green.

## Constraints
- Product code (src/, workflows/) — this is an AUTHORIZED product wave.
- Do NOT touch torture-test/ except where a torture self-test hardcodes
  the old workflow step lists (update those pins honestly).
- Reviewer personas are READ-ONLY by contract; never grant them
  write/execute instructions.
- Do not weaken any existing gate semantics; every new path fails closed.
