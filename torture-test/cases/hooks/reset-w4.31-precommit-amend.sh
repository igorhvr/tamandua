#!/usr/bin/env bash
# W4.31 reset hook: install the tree-rewriting pre-commit hook
# (fixtures/hooks/pre-commit-amend.sh) into the working clone's
# .git/hooks/pre-commit and plant the TRACKED marker baseline
# (src/pre-commit-amend.marker.txt, committed) so the hook REWRITES an
# existing line on every commit. Then ASSERT the installation (the case-hook
# contract: hook present, executable, content byte-identical to the asset,
# marker baseline committed) — fail closed, never a silent non-install.
#
# The managed run worktree shares the work clone's git-common-dir, so the
# installed hook fires on the FIXER's commits in the run worktree (spec 08
# §F W4.31: the hook fires on the fixer's commits; the final landing is
# plumbing and runs no hooks).
#
# Runs under the controller's spawned tt env (TT_ROOT = torture-test/var,
# TT_REPO_ROOT = repo root), AFTER provisionWorkClone created the work clone.
set -euo pipefail

TT_ROOT="${TT_ROOT:?TT_ROOT must be set (spawned tt env)}"
TT_REPO_ROOT="${TT_REPO_ROOT:?TT_REPO_ROOT must be set}"
case_id="W4.31-precommit-amend"
fixture="tt-ts"

clone="$TT_ROOT/fixtures/work/$case_id/$fixture"
asset="$TT_REPO_ROOT/torture-test/fixtures/hooks/pre-commit-amend.sh"

[ -d "$clone/.git" ] || { echo "W4.31 reset: work clone missing: $clone" >&2; exit 2; }
[ -f "$asset" ] && [ -x "$asset" ] || {
  echo "W4.31 reset: pre-commit-amend.sh asset missing or not executable: $asset" >&2
  exit 2
}

# Plant the tracked marker baseline FIRST (idempotent; provisioning wipes
# first, so a retry re-plants deterministically) — committed BEFORE the hook
# is installed so the baseline tree carries `pre-commit-amend: 0` and every
# FIXER commit (the hook fires only after this point) rewrites it. The commit
# uses an inline identity so no global/contained git config is ever written.
marker_rel="src/pre-commit-amend.marker.txt"
if ! git -C "$clone" cat-file -e "HEAD:$marker_rel" 2>/dev/null; then
  mkdir -p "$(dirname "$clone/$marker_rel")"
  printf 'pre-commit-amend: 0\n' > "$clone/$marker_rel"
  git -C "$clone" add -- "$marker_rel"
  git -C "$clone" -c user.name="tt-fixture" -c user.email="tt-fixture@tetradactyla.org" \
    commit -q -m "W4.31: plant pre-commit-amend marker baseline"
fi

# Install the hook (mode 0755) — the spec's W4.31 mechanism.
install -m 0755 "$asset" "$clone/.git/hooks/pre-commit"

# Assert the installation (the case-hook contract).
test -x "$clone/.git/hooks/pre-commit" || {
  echo "W4.31 reset: pre-commit hook not executable" >&2
  exit 2
}
cmp -s "$asset" "$clone/.git/hooks/pre-commit" || {
  echo "W4.31 reset: installed pre-commit hook differs from the fixture asset" >&2
  exit 2
}
git -C "$clone" cat-file -e "HEAD:$marker_rel" || {
  echo "W4.31 reset: marker baseline not committed" >&2
  exit 2
}
grep -q "pre-commit-amend" "$clone/.git/hooks/pre-commit" || {
  echo "W4.31 reset: pre-commit hook content mismatch" >&2
  exit 2
}

echo "W4.31 reset: pre-commit-amend hook installed -> $clone/.git/hooks/pre-commit; marker baseline committed (rewrite armed)"
