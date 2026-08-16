#!/usr/bin/env bash
# W4.31 tree-rewriting pre-commit hook (fixture asset).
#
# Installed by the W4.31 case's reset hook (cases/hooks/reset-w4.31-precommit-amend.sh)
# into the working clone's .git/hooks/pre-commit. On EVERY commit it rewrites
# the single line of the tracked marker file `src/pre-commit-amend.marker.txt`
# (incrementing the counter) and `git add`s it — so every commit carries the
# hook's mutation. The corridor under test (spec 08 §F W4.31): the tree the
# verifier attests (post-hook) is what lands; TESTED_TREE is computed AFTER the
# hook's mutation and the attestation chain stays truthful end-to-end. Any step
# caching a pre-hook tree (agent-reported vs actual) surfaces as a mismatch
# finding. The final landing is plumbing (merge-tree/commit-tree/update-ref)
# and runs no hooks, so the hook fires only on the FIXER's commits.
#
# The hook is intentionally fail-closed: any failure (marker unreadable,
# git add failure) aborts the commit loudly rather than silently committing an
# unattested tree.
set -euo pipefail

marker_rel="src/pre-commit-amend.marker.txt"
repo_root="$(git rev-parse --show-toplevel)"
marker_path="$repo_root/$marker_rel"

if [ ! -f "$marker_path" ]; then
  # No baseline yet: initialize the counter at 1 (the W4.31 reset hook
  # normally plants the committed baseline at 0; this branch keeps the hook
  # self-sufficient on a fresh clone).
  printf 'pre-commit-amend: 1\n' > "$marker_path"
else
  current="$(sed -n '1s/^pre-commit-amend: //p' "$marker_path")"
  case "$current" in
    ''|*[!0-9]*) current=0 ;;
  esac
  next=$(( current + 1 ))
  printf 'pre-commit-amend: %d\n' "$next" > "$marker_path"
fi

git add -- "$marker_rel"
