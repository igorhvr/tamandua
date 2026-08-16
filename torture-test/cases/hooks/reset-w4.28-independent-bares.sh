#!/usr/bin/env bash
# W4.28 reset hook: build the SECOND INDEPENDENT bare (the spec's
# construction — `git init --bare` a SECOND time, push the IDENTICAL content
# to it) plus an independent working clone, then verify the construction:
# `getOriginRepo`-equivalent identities resolve to DISTINCT paths and
# `rev-parse HEAD^{tree}` is byte-identical across the two clones.
#
# Construction matters (08 §F W4.28): two clones of the same golden that
# share a git-common-dir ancestry (or a copied bare dir) may normalize to the
# same origin identity — testing nothing. The second bare is created from
# scratch (`git init --bare`), never copied.
#
# Runs under the controller's spawned tt env (TT_ROOT = torture-test/var),
# AFTER provisionWorkClone created the work clone. Fails closed (exit 2) on
# any precondition or verification failure.
set -euo pipefail

TT_ROOT="${TT_ROOT:?TT_ROOT must be set (spawned tt env)}"
case_id="W4.28-tstx-cross-repo-collision"
fixture="tt-ts"

base="$TT_ROOT/fixtures/work/$case_id"
clone="$base/$fixture"           # the provisioned work clone (bare-A lineage)
bare_b="$base/tt-ts-bare-B"      # the second INDEPENDENT bare
clone_b="$base/tt-ts-clone-B"    # its independent working clone

[ -d "$clone/.git" ] || { echo "W4.28 reset: work clone missing: $clone" >&2; exit 2; }

# Build bare-B from scratch — never a directory copy (a copy would share
# git-common-dir ancestry, the spec's trap).
rm -rf "$bare_b" "$clone_b"
git init -q --bare "$bare_b"

# Push the identical content (the provisioned HEAD tree) to bare-B.
head_sha="$(git -C "$clone" rev-parse HEAD)"
head_branch="$(git -C "$clone" branch --show-current)"
[ -n "$head_branch" ] || { echo "W4.28 reset: work clone HEAD is detached" >&2; exit 2; }
git -C "$clone" push -q "$bare_b" "$head_sha:refs/heads/$head_branch"
git -C "$bare_b" symbolic-ref HEAD "refs/heads/$head_branch"

# Clone bare-B (a second independent working clone).
git clone -q "$bare_b" "$clone_b"

# Verify: byte-identical HEAD trees.
tree_a="$(git -C "$clone" rev-parse "HEAD^{tree}")"
tree_b="$(git -C "$clone_b" rev-parse "HEAD^{tree}")"
[ "$tree_a" = "$tree_b" ] || {
  echo "W4.28 reset: HEAD trees differ: $tree_a vs $tree_b" >&2
  exit 2
}

# Verify: distinct origin identities (the git-common-dir realpaths must
# differ; a symlink//private/var normalization collapse is the O9 trap).
# `--git-common-dir` may be RELATIVE to the repo dir — resolve it against
# the clone path, never the hook's own cwd.
resolve_common_dir() {
  local repo="$1" common abs
  common="$(git -C "$repo" rev-parse --git-common-dir)"
  case "$common" in
    /*) abs="$common" ;;
    *) abs="$repo/$common" ;;
  esac
  (cd "$abs" && pwd -P)
}
real_a="$(resolve_common_dir "$clone")"
real_b="$(resolve_common_dir "$clone_b")"
[ "$real_a" != "$real_b" ] || {
  echo "W4.28 reset: origin identities collapsed: $real_a" >&2
  exit 2
}

echo "W4.28 reset: independent bare-B + clone-B built; HEAD trees byte-identical ($tree_a); origins distinct ($real_a vs $real_b)"
