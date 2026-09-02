# S58: scripted scenario assets must track WAVE-A's workflow contract (reviewer/auditor roster, fixer key, conditional steps) — tier-0 gate unavailable since 09c10ce5

Suite fix (torture-test/ only). Found 2026-09-02 by WAVE-B.1's US-006: `./run-torture-test --tier0` exits 3
("Tier 'tier0' is unavailable because its required assets are not installed or valid"); `tt-tier0-assets` exits 1:
"behavior agent keys must exactly match workflow agents; expected auditor, fixer, investigator, merger, reviewer,
setup, triager, verifier, got fixer, investigator, merger, setup, triager, verifier". WAVE-A (09c10ce5) added the
`reviewer` (test_cmd_review, conditional) and `auditor` (deception_audit) agents to the bundled bug-fix-* /
merge-gate workflows and made the fix step require `REPRO_EVIDENCE:` | `CANNOT_REPRODUCE:`. WAVE-A.1 (in flight) makes
`deception_audit` UNCONDITIONAL (PHNT "always audit") and keeps `test_cmd_review` conditional on a rewrite.
All 24 torture-test/scenarios/w4.35/*/behaviors.json (and any other scripted scenario driving a WAVE-A-changed
workflow — grep scenarios/ and cases/ for bug-fix-merge-worktree, bug-fix-merge, bug-fix-github-pr, bug-fix,
bug-fix-worktree, feature-dev-merge*, security-audit-merge*) still declare the pre-WAVE-A roster and canned outputs.

## Fix
1. behaviors.json roster parity: add `reviewer` and `auditor` behaviors to every affected scenario.
   - auditor (deception_audit): scripted behavior returns `VERDICT: HONEST — <one line>` (the scenarios are honest
     scripted fixes). Must work whether the step is conditional (WAVE-A) or unconditional (WAVE-A.1).
   - reviewer (test_cmd_review): scripted behavior returns `VERDICT: ACCEPT — <one line>`; it should never
     dispatch in these scenarios (no TEST_CMD rewrite), so also assert via the expected route that it auto-completes.
2. Canned fixer outputs: add `CANNOT_REPRODUCE: scripted scenario — no live reproduction; behavior fixed per plan`
   (or REPRO_EVIDENCE where the scenario genuinely demonstrates a failing baseline) so the fix step's expects pass.
3. Expected-route pins: re-derive per scenario against the CORRECTED product (main incl. WAVE-B.1 semantics:
   terminal_reroute_count counts terminal-class reroutes only). Keep the semantic invariants the pins encode
   (expects-reroute-exhausted with reroute_count 8 / reroute_events 8 / terminal_reroute_count 0 / must-not-land etc.);
   adjust ONLY fields that legitimately change because new steps exist (e.g. step counts, auto_completed steps,
   merger_invocations if the corridor changed) and DOCUMENT each pin change with the product reason. Never loosen a
   pin to make a red cell pass — a red cell after parity is a product finding to report, not a pin to edit.
4. Guard: a self-test that fails when any bundled workflow's agent roster or fix-step expects differ from the
   scenario assets that drive it (so the next WAVE-A-class change turns tier-0 red loudly instead of "unavailable"),
   and make `run-torture-test --tierN` treat "assets unavailable" as a RED gate (exit non-zero, named reason) rather
   than a silent skip.
5. Same parity sweep for tier1/tier2 scripted rosters (tt-tier1-assets / tt-tier2-assets) — WAVE-B.1's report notes
   tier1 availability is affected too.

## Prove (one gate per story; each proof story fits one worker round)
- `./run-torture-test --tier0` on the corrected main (after WAVE-B.1 lands) → 33/33 PASS (S56 port-release
  collisions, if any, named explicitly as infra — do not count them as product failures; rerun the affected cell once).
- `./run-torture-test --tier1` GREEN; `--tier2` scripted GREEN (asset availability + no regressions).
- Roster-parity self-test red-arm (mutate a workflow roster → test red) + green.
- Full self-test battery green from repo root.

## Constraints
Files ONLY inside torture-test/. No product code. No pin loosening without a documented product reason. Kill only
pids you spawned. Do not run more than one tier ladder concurrently (shared contained ports).
