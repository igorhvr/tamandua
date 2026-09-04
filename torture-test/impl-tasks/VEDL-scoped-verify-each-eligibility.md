# VEDL: narrowly fix named-verifier eligibility across waiting intermediate steps

## Authorization and scope

Igor approved this narrowly scoped product fix on 2026-09-04: "Ok. Do it as you
suggested. Using dsh runs as usual. Maximum dogfooding always."

Beads: tamandua-6sy.19. Implement through this dsh run. The user is specifically
uncomfortable with a complex product change merely to make a test pass. Preserve
the existing lifecycle and safety controls. If the fix requires a schema change,
a lifecycle redesign, or a broader scheduling exception, stop with a precise
explanation instead of expanding the scope.

## Observed defect and existing contract

The public `verify_each` / `verify_step` interface names the verifier; it does not
require adjacency. In `src/installer/step-ops.ts`, story completion already marks
that named verifier pending and pauses the loop. Verifier completion already
returns to the loop, and final loop completion advances to intermediate steps.

The claim eligibility query is inconsistent with that lifecycle: it exempts a
running loop with no current story from the predecessor barrier, but a waiting
step between that loop and its named verifier still blocks the verifier forever.
`autoCompleteConditionalStep` contains a related predecessor query; inspect both
for consistency without broadening conditional-verifier lifecycle semantics.

Concrete fossil: `torture-test/scenarios/w4.35/run-retry-cell.mjs` configures `fix`
as a one-story verify-each loop naming `verify`. The workflow has
`fix -> deception_audit -> verify -> test_cmd_review -> finalize_merge`.
`w4.35-retry-rebased-true-green` then deadlocks: audit waits for the loop, and the
verifier cannot claim past the audit. Bundled ordinary story workflows currently
have adjacent verifiers, so the exposure is custom/scenario workflows using the
existing named-verifier contract.

Read `completeStep`, `handleVerifyEachCompletion`, `checkLoopContinuation`, the
claim eligibility queries, and stale-claim recovery before changing the predicate.
An exploratory in-memory check of the actual query passed 15 candidate-rule cases;
that was not a product implementation or full lifecycle proof.

## Required invariant

Only the paused loop's explicitly designated pending verifier may bypass an
intermediate predecessor, and only when all of these hold:

- The loop and verifier belong to the same running run.
- The loop is running, has no current story, has verify-each enabled, and names
  this exact verifier through the supported normalized configuration.
- The intermediate predecessor is strictly between that loop and the verifier
  in step order, and its status is exactly `waiting`.
- Existing predecessor requirements outside this narrow exception remain intact.

The intermediate steps are NOT completed, skipped, dispatched, or made pending
by this exception. In particular, the deception audit remains waiting throughout
per-story verification and retries, then executes normally after the whole loop
finishes. A running, pending, failed, or canceled intermediate step is NOT covered
by this new exception. Earlier unfinished prerequisites and unrelated verifiers
still block. Adjacent verify-each and non-loop workflows retain their behavior.

## Story-sized work

Plan small stories along these boundaries, each with one focused verification
gate. Do not add a multi-hour torture-ladder proof story. Normal workflow build
and test requirements still apply.

### US-001 — Minimal eligibility correction and direct regression cases

Implement the smallest readable eligibility change in step-ops. Preserve the
existing completion, retry, pipeline-advance, and stale-claim recovery contracts.
Keep duplicated eligibility predicates consistent only where required by this
bug; prefer a small shared predicate if appropriate, not a general graph engine.

Add isolated regression cases proving the old query deadlocks and the fix admits
only the intended verifier. Include multiple waiting intermediate steps, the
supported configuration spellings, ordinary adjacent verification, and negative
cases for active-story loops, a completed loop, verify-each disabled, a wrong
verifier, another run, an earlier unfinished prerequisite, unrelated pending work,
and each non-waiting unfinished intermediate status. Assert the audit's state is
unchanged. A completed intermediate predecessor must remain ordinary behavior.

Briefly clarify the existing named-verifier ordering semantics in
`docs/creating-workflows.md`. Do not add an adjacency rejection or change the
deception-auditor prompt/contract. Verification gate: the focused eligibility
regression test file(s), plus typecheck.

### US-002 — Real scripted lifecycle: multiple stories, retry, and audit ordering

Using the product's scripted e2e infrastructure, exercise the actual isolated
daemon, scheduler, harness, and step protocol with at least two stories and a
non-adjacent ordinary named verifier. Include one verifier retry followed by
success. Demonstrate that the audit remains waiting after each story attempt and
verification round, then runs exactly once after the final successful story, with
normal downstream completion. Assert event/step/story ordering, bounded retry
accounting, no early intermediate claims or conditional auto-completion, and zero
real model tokens. Include the equivalent adjacent layout as a regression control.

Use fixture workflows and probe-aware scripted harnesses; do not add production
test switches or bypasses. Verification gate: the focused scripted lifecycle test.

### US-003 — Durable pause/restart checkpoint

Extend the isolated scripted coverage to restart the test-owned daemon while the
loop is paused with its verifier pending and the intermediate audit waiting.
After restart/resume, the verifier must claim, verification must return to the
correct loop/story, and the audit must execute only after the loop finishes.
Prove no stale-claim recovery incorrectly abandons that paused loop. Include a
retry across the checkpoint if this fits the same focused scenario.

Control only exact test-owned processes using existing helpers. Do not introduce
production lifecycle changes merely to stage the test. Verification gate: the
focused restart regression, plus typecheck.

### US-004 — Product regression acceptance

Run `npm test` with both lanes passing and an empty test-isolation violation
ledger. Do not mask unrelated failures, weaken assertions, or classify an
unexecuted test as passing. Record exact command, tree, exit status, and evidence.
This is the sole broad proof gate in this story.

The workflow's integration-test step must also run `./run-all-e2e-tests` (the fast
smoke + scripted suite) on its own built worktree. No paid real e2e in this run.

## Boundaries and operational safety

- Product implementation scope: the minimal step-ops eligibility correction,
  focused tests/fixtures, test registration where needed, and the short workflow
  documentation clarification. No schema migration, new state, scheduler
  redesign, event-schema change, general dependency-graph feature, or broad
  refactor. Arbitrary conditional verifiers and multiple/nested-loop redesign
  are not part of this task.
- Do not remove/reorder the audit, relax a gate, reject the previously accepted
  layout, edit scenario expected-route pins, or alter torture-test source/assets.
  The original w4.35 fossil must remain an independent acceptance check.
- R4a run #906 is active on this host and may be using the fixed contained ports.
  Do NOT launch the torture self-test battery or tier campaigns in this run.
  The coordinator will run the original affected cell and full Tier-0 on a pinned
  merged tree in a quiet window, retaining the full evidence. That deferred gate
  must not be represented as already passed.
- Build and test inside this run's worktree, using its own launcher/dist. The
  live coordinator intentionally runs an older matching binary/catalog while
  existing runs are active. Never rebuild the origin checkout, refresh its live
  catalog, or restart/stop its daemon from this run.
- All tests use isolated state/DB/home and random listener ports with the test
  guard enabled. Register new process-spawning tests in the serial lane as
  required by AGENTS.md. Never use production ports or the live user state.
- No broad name/pattern process kills. Terminate only an exact child whose
  ownership by this test/run has been verified. Preserve existing worktrees,
  user files, and campaign evidence; no forced worktree cleanup or broad recursive
  removal. Use fresh test-specific temporary directories.
- Allow the full npm suite at least 30 minutes at the command runner level and
  observe progress; a short tool deadline must not abort a valid proof. TFLK
  installation-test load sensitivity is a separately pending decision, not scope
  to silently change this test or its assertions here.
- Merge only into local main through the workflow. Do not push origin or publish
  a release. Certification and any safe live refresh remain coordinator work.
- Final report: exact changed behavior, source/test files, actual evidence and
  unresolved limitations. If the bounded design fails, report that honestly;
  never claim full confidence from the earlier query-only exploration.

Test command: npm test
