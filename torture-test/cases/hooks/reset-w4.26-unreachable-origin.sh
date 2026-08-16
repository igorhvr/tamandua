#!/usr/bin/env bash
# W4.26 reset hook: rewrite the working clone's `origin` remote to an
# UNREACHABLE ssh URL — the spec's "58-warning production fossil" (08 §F
# W4.26: `ssh://unreachable.invalid/...` on the fixture). The corridor under
# test: NO hang on host-key prompts, NO per-round warning storm, bounded git
# network timeouts, and merges/gates/TSTX fully functional WITHOUT origin
# liveness.
#
# Runs under the controller's spawned tt env (TT_ROOT = torture-test/var),
# AFTER provisionWorkClone has created the work clone. Fails closed (exit 2)
# on any precondition or verification failure — a silently unarmed case is
# never a PASS.
set -euo pipefail

TT_ROOT="${TT_ROOT:?TT_ROOT must be set (spawned tt env)}"
case_id="W4.26-unreachable-origin"
fixture="tt-ts"
remote_url="ssh://unreachable.invalid/tamandua/tt-ts.git"

clone="$TT_ROOT/fixtures/work/$case_id/$fixture"

[ -d "$clone/.git" ] || { echo "W4.26 reset: work clone missing: $clone" >&2; exit 2; }

git -C "$clone" remote set-url origin "$remote_url"
actual="$(git -C "$clone" remote get-url origin)"
[ "$actual" = "$remote_url" ] || {
  echo "W4.26 reset: origin remote rewrite failed (got '$actual')" >&2
  exit 2
}

echo "W4.26 reset: origin remote -> $remote_url (unreachable; corridor armed)"
