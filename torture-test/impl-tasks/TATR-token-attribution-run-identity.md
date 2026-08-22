# TATR: token attribution + run identity in the event stream (authorized product run)

Long-standing authorized finding, now with fresh campaign #8 oracle
evidence. The theme: events and token flushes lose or never carry run
identity, so landings, cancels, and late flushes cannot be attributed.

Facets to fix (product code, src/):

1. **MLID — merge events are identity-less.** merge-branch.ts:322:
   runId = params.runId ?? process.env.TAMANDUA_RUN_ID ?? "" — every
   production and torture landing emits merge.landed/merge.* with
   runId:"", so they never reach events/<runId>.jsonl and no consumer
   can attribute a landing to its run. Thread the real run id through
   every merge-branch caller (finalize_merge step context knows it);
   keep "" only for genuinely runless invocations (manual CLI merge) and
   document that. Campaign evidence: 13/13 landings runId:"" in the
   contained all.jsonl; 8× O2_LANDING_EVENT_MISSING.
2. **Reflog messages.** merge-branch.ts:491,644 call update-ref without
   -m, writing message-less reflog lines. Add a structured message
   (e.g. "tamandua: merge.landed run=<id> tree=<oid>") so the reflog is
   self-describing and parsers need no special-casing.
3. **Cancel-race token loss.** Known: a worker round's parsed tokenUsage
   can lose the race against cancelRun's final flush (campaign #7:
   65,481 parsed but spend 0; campaign #8 W3.20: O11_CONTROLLER_TOTAL_
   MISMATCH + delta anomalies on the cancel probe). Make the cancel path
   settle in-flight token attribution before writing the terminal token
   event (or emit a post-terminal correction event with the run id and a
   reason field — pick the design that keeps run.tokens.updated ordering
   contracts intact and document it in MOTOR-CONTRACT.md).
4. **Post-terminal flush identity.** Late flushes after terminal status
   (W3.21: +18,776 tokens ~10s after run.failed; W2.24: final +66,101
   written in the run's last second) are invisible or mis-ordered for
   consumers that stop reading at the terminal event. Guarantee: either
   flush-before-terminal, or an explicitly identified post-terminal
   token event that consumers can subscribe to; document the contract.
5. **Nested-run metadata hijack.** Known facet: nested/sibling runs'
   metadata_run_id can capture token deltas onto the wrong run
   (campaign #8 W2.24: two sibling tt-docs-drift runs, ~117k tokens,
   invisible to the parent graph; W3.20/W3.22: run.tokens.updated naming
   runs outside the captured graph). Ensure deltas are attributed to the
   run that actually spent them, and that spawned-by/parent linkage is
   recorded on the child run so graph consumers can discover it.

NOT in scope (separate unauthorized findings, do not touch): FFRC
(force-fail spurious run.completed / resume blocking), RSPN (instant-fail
round respawn backoff). Do not modify torture-test/**.

Prove: unit + integration tests per facet (cancel race under load,
post-terminal flush ordering, merge event identity end-to-end incl. a
worktree-workflow merge asserting the event lands in
events/<runId>.jsonl); full npm test green; MOTOR-CONTRACT.md updated
where contracts changed.

## Hard constraints
- Product code only (src/, tests/, docs/MOTOR-CONTRACT.md). Zero
  torture-test/ changes. Do not restart or reconfigure the live daemon
  (33xx); the operator handles install/restart after merge. Concurrent
  suite runs own torture-test/** — no overlap exists; keep it that way.
