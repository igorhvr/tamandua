# MACP2: __pycache__ junk probe is Darwin-broken (Apple pycache_prefix) + --provision rebuild UX

Mac parity iteration #2 remainder. Diagnosed live on the mac:

1. **tt-python@master's junk probe can never pass on macOS.** Its
   build-golden.sh (line ~282) asserts in-tree `__pycache__/` exists
   after the test run. Apple's Python builds bake in
   `sys.pycache_prefix = ~/Library/Caches/com.apple.python`, so
   bytecode caches are ALWAYS redirected out-of-tree on Darwin (
   verified: plain import + compileall both produce no in-tree
   __pycache__; dont_write_bytecode is False). Fix architecturally,
   per the E2.4 precedent (operator-notes.local): the junk must be a
   DETERMINISTIC PROVISIONING ARTIFACT, not an interpreter side
   effect —
   - builder + provisioning seed the untracked junk dir explicitly
     (byte-exact recorded content, e.g. a synthetic `__pycache__/`
     with fixed pyc-like payload OR rename the probe to a
     platform-neutral junk artifact — follow spec 02's junk-probe
     intent: untracked, agents must not commit/delete/modify,
     byte-identical after runs);
   - every assertion/oracle referencing this junk (builder checks,
     baseline verifier --expect data, O8/junk invariants, probes)
     updated consistently; goldens/hashes regenerated once with
     determinism proof (2 identical builds);
   - if genuine interpreter-generated pycache matters for some case's
     realism, generate it portably (`python -X pycache_prefix= -m
     compileall` — verify this overrides Apple's default; if it does
     not, the synthetic artifact is the only portable option).
2. **--provision rebuild UX**: "golden present but its hash ledger is
   missing" currently refuses fail-closed; give `--provision` a
   `--rebuild-invalid` mode (or auto-rebuild with a loud per-asset
   note) so stale/partial goldens self-heal instead of requiring
   manual rm — keep default fail-closed behavior unchanged.
3. Prove (linux, zero tokens): builder determinism 2x; bare --tier1
   GREEN x2; provisioning self-checks green for all fixtures incl.
   tt-python@master; junk invariants red-team test (commit/delete/
   modify the junk in a scratch clone -> oracles still catch all
   three). Darwin validation is the operator's post-merge step.

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon
  untouched. Do not weaken the junk-probe detection semantics.
- Concurrent runs own scenarios/tier2 (T2.1) and self-test kill files
  (E3.C.1) — avoid those files.
