# ORIJ: worktree-run creation must refuse only TRACKED origin changes, not untracked files

Operator-authorized product fix (igorhvr, 2026-08-12; finding ORIJ from
Tier-1 campaign #6). `src/installer/worktree-manager.ts` (~lines
134-143) refuses to create a managed worktree whenever the ORIGIN
repository has ANY `git status --porcelain` output — including
untracked-only files:

    origin repository has uncommitted changes: <originRepo>

Untracked files in the origin repo cannot affect a worktree created
from its committed objects, real user repos routinely contain
untracked scratch files, and the puma-cycle tracked-content gate
(TCH1/LGAT) already established the principle that untracked junk
must not block operations. Campaign #6 evidence: every worktree-family
real case was refused because torture fixtures carry spec-mandated
untracked junk (`operator-notes.local`, `$(sentinel)/`).

## Work

1. Change the origin cleanliness check to refuse ONLY tracked changes:
   parse porcelain output and ignore lines whose XY status is `??`
   (untracked) — and `!!` if ignored entries ever appear. Any other
   status (staged/unstaged modify, delete, rename, copy, conflict)
   still refuses, with the message tightened to say "uncommitted
   changes to tracked files". Keep the check fail-closed on git
   command failure exactly as today.
2. Update `src/installer/worktree-manager.test.ts` (the existing
   /origin repository has uncommitted changes/ expectation) and add
   coverage: (a) origin with untracked-only files -> worktree creation
   SUCCEEDS and the untracked files do NOT appear in the new worktree;
   (b) origin with a modified tracked file -> refused; (c) origin with
   a staged file -> refused; (d) mixed untracked + tracked-modified ->
   refused.
3. Audit for sibling checks: grep the codebase for other
   `status --porcelain`-based refusals on ORIGIN/source repositories
   reachable from run creation (NOT the landing gate, NOT shim/test
   gates — those are correct and out of scope) and align any that
   have the identical untracked-only false-refusal, with tests, or
   explicitly report why none qualify.
4. Prove: full `npm test` green; then the scripted fast e2e lane
   green; then demonstrate the original repro end-to-end WITHOUT
   spending real tokens: create a scratch git repo containing an
   untracked junk file, point a worktree-based workflow's dry
   worktree-creation path at it (unit/integration level is fine —
   the new test in (2a) satisfies this if it exercises the real
   createManagedWorktree path against a junk-bearing origin).

## Hard constraints

- Product scope ONLY: src/installer/worktree-manager.ts + its tests
  (+ any sibling check found in (3)). Do NOT touch torture-test/
  (E2.6 is concurrently fixing suite defects there — avoid overlap).
- Do not weaken the tracked-changes refusal or the landing gate.
- No behavior change for worktree CONTENTS: untracked origin files
  must still be absent from created worktrees (git semantics already
  guarantee this — pin it with the (2a) assertion).
