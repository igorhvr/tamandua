# WAVE-A.1: harden the conditional-review gate (agent-unwritable flag), PHNT always-audit, verbatim prompts, GETRDY

Follow-up to WAVE-A (landed 09c10ce5). Authorized: TCMD/PHNT (igorhvr 2026-09-01), PHNT-CORR "Always audit"
and GETRDY (2026-09-02). Product run. FIRST inspect what 09c10ce5 already does for each item below and
implement only what is missing; do not undo working behavior.

## 1. Activation flag must be agent-unwritable (TCMD)
`test_cmd_review_required` is set in run context by the rewrite detector. Run context is merged from every
step's `KEY: value` output lines except RESERVED_CONTEXT_KEYS (step-ops.ts) — so a rewriting step can emit
`test_cmd_review_required: false` in the same output and the review auto-completes for free, defeating the
gate. Fix: persist the review requirement in a DB column (or add the key to RESERVED_CONTEXT_KEYS AND make
the detector the only writer); the conditional auto-complete must read the persisted value, never an
agent-writable context key. Same for `test_cmd_established`/`test_cmd_source` (already DB columns — verify
no context alias can shadow them). The `test_cmd → test_cmd_raw` alias write in the context merge must be
subordinate to establishment (a differing value records the detection event; it never rewrites the contract).
Corridors: (a) an agent KEY line cannot clear or set the flag; (b) daemon restart between detection and review
preserves the pending review (survives in DB); (c) `merge_gate=off` runs still record `test_cmd.rewrite_detected`.

## 2. PHNT: deception_audit becomes UNCONDITIONAL (igorhvr: "Always audit")
Every bug-* run dispatches `deception_audit` after the fix step regardless of REPRO_EVIDENCE — remove the
conditional gating for this step (the conditional primitive stays for `test_cmd_review`). The fixer's
`REPRO_EVIDENCE:` | `CANNOT_REPRODUCE:` key remains REQUIRED as the account the auditor checks. Auditor prompt:
the pinned text in torture-test/impl-tasks/WAVE-A-approved-prompts.md, with ONLY the activation paragraph
reworded to: "You are activated after every fix. The fixer either reported reproduction evidence
(REPRO_EVIDENCE) or could not reproduce (CANNOT_REPRODUCE) — both are legitimate; absence of reproduction is
NOT evidence of dishonesty, and a REPRO_EVIDENCE claim is checked under item 3 (claim/artifact mismatch).
Default to HONEST." Everything else verbatim.

## 3. Personas verbatim
`test_cmd_review` and `deception_audit` persona prompts must match the pinned file verbatim (whitespace
normalized; template-variable syntax adapted to the renderer). Add a test that diffs the persona files against
the pinned prompts so drift fails `npm test`.

## 4. GETRDY
`src/cli/commands/get-ready.ts` hardcodes `startDashboardStandalone(3334)`; honor `TAMANDUA_DASHBOARD_PORT`
(fallback 3334) exactly like dashboard-standalone.ts does; regression test.

## Prove (one gate per story; each proof story fits one worker round)
- Unit/integration corridors for 1(a-c); scripted round proving an agent-emitted flag line has no effect.
- deception_audit dispatches in a scripted bug-* run even when REPRO_EVIDENCE is present; the persona-diff test
  is green against the pinned prompts.
- GETRDY test; full `npm test` green.

## Constraints
Product code only. Reviewers stay READ-ONLY by contract. Fail closed everywhere. Kill only pids you spawned.
