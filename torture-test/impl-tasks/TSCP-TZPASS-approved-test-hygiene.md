# TSCP + TZPASS: authorized invocation ownership and test TZ inheritance

## Authority and strict boundary, 2026-09-06 UTC

Igor approved TSCP option A (tamandua-6sy.24) and only the TZ allowlist addition
(tamandua-6sy.27.1). He EXPLICITLY RETRACTED TZPI option A. No change to
src/lib/process-start-identity.ts, runtime clocks/timestamps, process identity
format, DB schema, or global timezone is authorized. Broader time design is
awaiting a separate decision. This run changes TEST code and narrowly necessary
test helpers only, using Linux dsh with the existing workflow.

## US-001 — Preserve TZ through the existing cleanChildEnv allowlist

Add TZ to BASE_ENV_KEYS in tests/helpers/test-env.ts. Preserve all existing
allowlist filtering, explicit overrides, isolated path/guard behavior and
precedence. Do not force UTC or another zone. Add pure helper tests proving:
set TZ passes through, absent TZ remains absent, explicit override replaces it,
explicit undefined removes it, and unrelated environment variables stay filtered.
Keep the helper tests pure and independent of host timezone/global env mutation.
Designated gate: the focused cleanChildEnv test file. No runtime identity fix.

## US-002 — Replace shared-prefix test cleanup with invocation ownership

The after hooks in tests/mcp-lifecycle.test.ts and
tests/get-ready-dashboard-port.test.ts select survivors by shared HOME/log-path
prefix. The actual callbacks, evaluated with recording process bindings for
Linux and Darwin observation paths, selected both invocation A and unrelated B.
Evidence (no real signal was sent by that proof):
/home/igorhvr/idm/tamandua/torture-test/var/review-logs/suite-cleanup-prefix-5nLG3O/synthetic-after-hook-proof.log
Current incidents included random-port socket closures during overlapping gates;
attribution of those particular sockets is inference, not a captured kill trace.

Replace shared-prefix scavenging with exact per-invocation owned roots and
process identities. Verify current evidence before each signal. Preserve actual
cleanup of invocation-owned survivors; simply dropping cleanup is not a fix.
Refuse neighbors with similar prefixes, other invocations, PID reuse/stale
identity, and unreadable ownership evidence. Keep this scoped to these tests
and a small test-only helper if needed, with no product process manager or
runtime cleanup change. The separately deferred RCOB sweep is untouched.

Designated gate: focused actual cleanup-decision regression with recording
bindings for both platform paths; prove own A selected and B refused, exact
path boundaries, stale/PID-reuse and unavailable-identity refusal, and identity
recheck before escalation. No real process selectors/signals in recording proof.

## US-003 — Owned-survivor and concurrent-neighbor lifecycle proof

After the scoped correction is in place, add/run isolated positive and negative
lifecycle tests. Create ALL processes/roots from this invocation and record
their exact identities. Two controlled synthetic invocations overlap: A cleans
its survivors and B's live service remains healthy. Never use a real existing
run/daemon as the negative target. Normal exits and failing test paths must not
leave owned survivors; unavailable evidence is refusal, not claimed cleanup.
Make the regression portable to Linux and actual Mac. Coordinator will repeat
and inspect it on both hosts; do not claim an unexecuted platform passed.

Designated gate: focused isolated invocation-ownership lifecycle regression.
The controlled A/B overlap INSIDE this isolated gate is the deliberate exception
to ordinary test serialization; the outer gate must still acquire the shared
lock. Keep the old lifecycle assertions, random ports, guards and deadlines
unchanged. No polling/retries substituted for absolute deadlines.

## Operational boundaries for every worker

- Normal workflow npm validation is required, not a new repeated heavy gate
  story. Commit before ledger tests; unchanged tree while queued/running;
  exact TEST_CMD: npm test. Full npm needs at least 30-minute command budget.
- Full npm, focused MCP/get-ready and fast e2e gates MUST use this existing
  shared flock around the normal tamandua-test gate; never unlink/recreate it:
  /home/igorhvr/idm/tamandua/torture-test/var/review-logs/suite-cleanup-prefix-5nLG3O/linux-npm.lock
  The lock stays in use until independent both-host acceptance, even after merge.
- Build/test only this run's worktree. Step reporting uses the scheduling CLI
  /home/igorhvr/idm/tamandua/bin/tamandua, not an isolated fixture's binary/state.
  Do not build/install/update/restart the origin/live installation, sync Mac,
  change host dotfiles, access another run, push remotes or run campaigns.
- Keep native isolation on and guards active. Tests get private HOME/state/DB
  and random ports. Register any spawn-capable test under serial-files.txt.
  Until separately approved HTPN is fixed, the existing test-gate workaround is
  TAMANDUA_HERMES_BINARY=/usr/bin/false; do not launch real Hermes during npm
  or change runtime/TEST_CMD to fix that unrelated finding.
- No broad kill/name/pattern commands, recursive ad-hoc deletion, fixed-path
  pre-cleaning, worktree removal/pruning, git discard/reset or evidence removal.
  Only exact newly-created test fixture cleanup with proven ownership is normal.
- Preserve assertions and failure history. Retain complete logs, exact trees,
  actual exit statuses and all negative TAP records; zero unexpected isolation
  violations. No skipping/fail-open tests or retry-budget/DB repairs.
- Current scheduling runtime still has VSRP: emit standalone STATUS: done/retry
  followed by simple VERIFIED: / ISSUES: keys, not annotated or hyphenated keys.
  A different run implements VSRP; do not include it or DRVP in this test run.
- No paid real e2e. No dependency/runtime/source edits or unrelated cleanup
  redesign. Local merge is implementation only; coordinator owns acceptance.

Test command: npm test
