# MACP5.1: MACP5's lint red-arms are history-dependent — red on merged main (squashed history)

Post-merge main (2d386935) fails three self-test suites that were green in
the authoring worktree:

  tier0-gnu-portability-lint.test.ts   ("could not resolve the US-004
    commit (grep found '') — the MACP5 US-004 history is missing", ~:670)
  tier0-macp5-gnu-ism-sweep.test.ts
  tier0-procfs-portability-lint.test.ts (its new G5 red-arm, same class)

Mechanism: the red-then-green arms materialize the pre-fix tree by
resolving MACP5 story commits from git history (git log grep by message +
git archive <commit>~1). The finalize-merge machinery lands ONE squashed
commit on main, so those commits exist only in the authoring branch —
history-dependent tests break on any checkout without the branch (main,
clones, the mac).

Fix: make every red arm SELF-CONTAINED — synthesize the red fixture in a
temp tree (write a file containing the banned construct: an unguarded
/proc read, a GNU `sed -i`, `grep -oP`, `date +%s%N`, etc.), run the lint
against the temp tree, assert RED with the expected finding; then assert
GREEN on the real tracked tree. No `git log`/`git archive` resolution of
non-tag history anywhere in self-tests — add a meta-lint arm (or extend
an existing suite) asserting no self-test resolves commits by message, so
this class stays caught (this is the same lock-in pattern as the other
lint gates).

Sweep: check ALL self-tests (not just these three) for history-dependent
constructs (git log --grep, archive of <sha>~1, branch-name references)
and convert them the same way; document any legitimately history-based
test (e.g. TSTX tree-hash tests are content-based — fine).

Prove: the three suites green from repo root ON MERGED MAIN (the red arms
now synthetic), full battery green, and the meta-lint red-then-green
(synthetic offender file).

## Hard constraints
- Files ONLY inside torture-test/self-tests/ (plus shared lint helpers if
  needed). Zero tokens. Live daemon (33xx) untouched. Do not weaken any
  lint's live-tree hard gate — only the red-arm construction changes.
