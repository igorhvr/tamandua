# MACP4: make the tier1 W2 scripted cells Darwin-capable — the mac's bare tier1 is vacuously RED

On the mac, bare `./run-torture-test --tier1` is RED via the vacuity
guard: the four scripted cells (W2.21-admission, W2.23a/b/c) carry a
`requires` predicate `platform: linux`, so with predicates honestly
evaluated (post-MACP3) ZERO cells execute on Darwin and the guard
correctly refuses a vacuous GREEN. Evidence: mac campaign
20260818T163720247Z state.json — the four cells NOT_RUN(predicate) with
{"predicate":"platform","expected":"linux","observed":"darwin"}.

The linux predicate looks over-broad: daemon-control has a mechanical
`has_systemd_scope()` check with a non-systemd fallback launch path
(header: "Where systemd-run --user --scope is available..."), and the
scripted runtime itself ran on macOS in the chasm-era validation (real
e2e 12/12 on Darwin). The cells' actual dependencies must be audited,
not assumed.

1. Audit each W2 scripted cell's true platform dependencies:
   daemon-control fallback vs systemd-scope-only assertions, any
   /proc-era leftovers (MACP3 swept those), pgid/kill semantics, port
   handling, bash-3.2 (KSNT/MACP1 conventions). Fix what is portable-
   fixable; keep genuinely linux-only ASSERTIONS (if any) as separate
   linux-predicated assertion arms rather than gating the whole cell.
2. Replace the blanket `platform: linux` predicates with the narrowest
   true requirement (e.g. a capability predicate like daemon-scripted
   that the host profile computes on both platforms, or drop entirely
   where the fallback suffices). The S24 PATH-invariant reconstruction
   in daemon-control must keep working on the fallback path too.
3. Prove on linux (this run cannot run Darwin): all four cells still
   PASS via the systemd path AND via the FORCED fallback path
   (TT_FORCE_NO_SYSTEMD-style override or equivalent mechanical forcing
   of has_systemd_scope()=false) — red-then-green where you fix
   portability defects; full self-test battery green; bare --tier1
   GREEN x2 (one normal, one forced-fallback) in a quiet window.
4. Document the expected mac outcome in the report: after this merge
   the operator runs bare --tier1 on Darwin expecting GREEN with 4
   executed cells (or NOT_RUN with a precise narrower predicate if a
   cell is proven genuinely linux-only — justify any such cell).

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. No concurrent runs expected; 53xx quiet-window discipline
  for campaign proofs. Do not weaken the vacuity guard or predicate
  fail-closed semantics (MACP3).
