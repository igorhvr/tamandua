# R4a independent review correction: SGRD (US-014)

## Current recording-only test order — 2026-09-05T06:41Z

The proposed "existing chaos/identity tests" are NOT recording-only:
`torture-test/bin/tt-process-identity.test.mjs` spawns real detached children
and calls child.kill(SIGKILL); `torture-test/self-tests/tier1-mcha-tt-chaos-darwin-kill-guard.test.ts`
invokes the real chaos tool against child PIDs, including SIGKILL actions.
Defer those two compatibility files until the coordinator has independently
reviewed the COMMITTED correction's recording-only proof. This merely makes
the existing no-real-PID/signals boundary explicit; it does not waive their
positive compatibility coverage or authorize removing/weaking assertions.
The ONE synthetic SGRD gate, ordinary isolated build/typecheck and normal
committed-tree npm under the shared lock remain permitted. A node/Bash child
used only to run a recording VM is not a real-target fault experiment.
No broad oracle/self-test battery inside this corrective story.

## Authority and scope

Beads tamandua-6sy.4.1, child of the already approved suite batch
tamandua-6sy.4. This is a correction to MCHA's existing fail-closed signal
guard contract, through the SAME R4a dsh workflow
80049f1f-cd69-4835-a21a-32da90b13ca4. It is not a product change or a KHYG,
permission-profile, sandbox, or command-wrapper decision.

The coordinator briefly paused this run at 2026-09-05T02:00:29Z to deliver
blocking independent review feedback before further integration/merge work.
This pause is not a worker safety incident or a new test failure. The prior
fresh npm ledger1486 and regular self-test battery171/0 remain valid for
their old tree, but do not prove the newly identified negative cases.

## Tester: return the review finding through the normal protocol

Do not mark integration accepted while this finding remains.
Inspect the source and retained recording-only proof below, then use the
normal `tamandua step fail` command ONCE for the step you actually claimed,
with the failure reason beginning `US-014 SGRD:` and naming this task record.
The existing test on_fail.retry_step=implement path preserves that reason
and resets cited stories when normal retries are exhausted. Cite ONLY US-014
as the story needing correction, so unrelated stories are not reopened.
Do not edit the live DB, story rows, retry counters, or run context directly.

Protocol correction to the first version of this addendum: the actual
stored tester expects STATUS: done plus TESTED_TREE. A STATUS: retry
completion is rejected by expects validation BEFORE retry-verdict handling,
and that rejection can replace the useful story-specific reason. Therefore
do NOT submit a retry completion or add a fake done marker to satisfy expects.
Use `step fail`, whose explicit reason survives the failure/reroute path.

Suggested concise failure reason (not a shell command):

    US-014 SGRD: unknown caller pgid or incomplete ancestry is accepted by the signal guard. See /home/igorhvr/idm/tamandua/torture-test/impl-tasks/R4a-SGRD-review-correction.md and its raw VM proof. Correct fail-closed handling before acceptance.

One failure report per legitimately claimed round. If the ordinary response
is retrying/pending, that is the existing bounded retry policy; the next
tester round may report the still-unfixed failure again after checking the
recorded source. Do not repeatedly fail an unclaimed step or manipulate the
counter to accelerate the policy. Finish the worker round with STATUS: failed.

The tester stays read-only. The developer performs the suite correction,
the verifier reviews it, and integration resumes through the workflow.

## Independently reproduced defect

Committed review pin: 11de76f6b2a022de22c46499273ee2f9d6182c66.
Actual tt-process-identity.mjs SHA256:
625683c66961fce682ff1d40c78d6ace0de6c0c04bab73f599b3d006ada4423f.
Actual tt-chaos SHA256:
38208e3207ee18cd0efabd0f20dc488ac4c91d46918202d2b978b28743b29430.

Proof directory in the origin checkout:
torture-test/var/review-logs/r4a-signal-guard-T7yG5O/

- unknown-caller-evidence.jsonl: all seven cases, exact source hashes and
  every synthetic process query.
- unknown-caller-driver.txt: exact coordinator diagnostic driver. It loads
  the COMPLETE committed identity module in a VM, links only recording
  substitutes for fs/child_process, and extracts the actual verifyKillTarget
  function by AST. It is pinned to the RED source, not automatically a test
  of a later changed tree.

Results with a synthetic recorded daemon target, matching start identity and
a pidfile under the synthetic owned var root:

1. The target pgid is known, but reading the CALLER pgid fails. Both
   verifyRecordedTarget and the actual verifyKillTarget return ok:true and
   even assert that group disjointness passed. Comparing a number with null
   is not proof of disjointness.
2. The caller ancestry query fails. isAncestorOf returns false, which the
   signal guard treats as proof the target is not an ancestor. The actual
   daemon guard again accepts.
3. Controls: fully observed disjoint target accepts; known ancestor,
   unreadable TARGET pgid, missing identity and ABA mismatch all refuse.

The VM issued ZERO filesystem calls and ZERO signals. Its ps calls are
synthetic function invocations, not real processes. No real host scan, PID
target, daemon stop, or fault campaign is needed to reproduce either gap.

## Developer: bounded correction and one focused gate

Change only the relevant torture-test identity/chaos guard code and focused
regression coverage. Preserve the Linux and Darwin evidence sources.

Unknown caller pgid must refuse whenever group disjointness is required.
Incomplete ancestry observation must not be treated as a proven non-ancestor.
Distinguish a fully observed traversal ending at the root from unreadable
parent evidence, cycles, or depth exhaustion. Preserve known-disjoint positive
acceptance and self/ancestor/same-group/ABA/unknown-target refusals. Recheck
the actual chaos guard as well as the underlying helper: a later unreadable
caller observation must not be accepted merely because an earlier check
succeeded. Do not require procfs on Darwin or weaken any ownership boundary.

Keep the implementation small; do not redesign process management or change
product files. Preserve public helper behavior where possible and inspect
its callers before adjusting the representation of unknown ancestry.

Designated gate: ONE synthetic recording-only regression file exercising
the actual helper and actual chaos guard with complete/disjoint, ancestor,
caller-group-missing, parent-missing, cycle/depth and existing refusal
controls. Use current source as the subject. No real PID scans/signals,
fake targets that alias live PIDs, shell-shim scratch builds, or ad-hoc
scratch cleanup. The existing retained driver gives the complete reproduction;
there is no need to discover the problem by experimenting on live processes.
Do not add a test that merely reimplements the intended predicate.

Normal build/npm verification still applies, using the EXACT shared lock
already named at the top of canonical progress.txt. Commit before a full
suite starts; never edit its tree while queued or running. Keep all scratch
and complete logs. No broad kills, removals, worktree cleanup or main rebuild.

## Restore the originally declared test-command metadata normally

A separate legacy-run state problem was exposed by the merge gate at
2026-09-05T01:59:27Z. The run's context.test_cmd is npm test, but its
context.test_cmd_raw contains an older worker's explanatory paragraph.
The wrapper and merge gate prefer that stale raw field, producing an invalid
command hash19b36827... unrelated to the green npm ledger. The original
declared task command remains npm test; it is not being replaced with a
different test or weakened gate.

Do NOT execute the prose, disable the ledger gate, consume its no-evidence
fallback, change counters, edit SQLite/context directly, rebuild the live
origin binary, or deploy a product fix. Keep using the existing origin
launcher for the sanctioned step protocol; build/test this run's own worktree.

After the developer has actually fixed and verified the story, include this
exact single-line key in its legitimate successful step report:

    TEST_CMD: npm test

Keep explanations out of that value. The existing live completion handler
updates both canonical command fields from that normal key (origin
dist/installer/step-ops.js context-merge block); the coordinator will verify
the result read-only. This is restoration of the original declared command,
not evidence of a newly executed gate. The corrected tree must still obtain
a matching normal npm ledger row and integration proof.

If the normal report does not restore the command, or the ordinary workflow
does not reopen US-014, stop and report the supported-path failure. Do not
invent a direct-state workaround.

## Acceptance boundary

The coordinator independently repeats the no-signal negative cases against
the corrected committed source. No real signal-injection acceptance before
that is green. Full combined-tree review, original VEDL fossil, heavy/oracle
and bare-tier gates, Mac validation, both-host certification and push
restrictions remain unchanged. The earlier R4a proof-boundary addendum still
governs broad gate ownership; no test is waived here.
