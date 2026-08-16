#!/usr/bin/env bash
# W4.30 reset hook: put the worktree-ORIGIN repo (the provisioned working
# clone) into DETACHED-HEAD state, so `git branch --show-current` is empty
# and the launch must refuse diagnosably (08 §F W4.30: empty ORIGINAL_BRANCH
# -> merger target `refs/heads/` garbage corridor -> launch-time or
# setup-time diagnosable refusal; NEVER a mangled/created bogus ref).
#
# Runs under the controller's spawned tt env (TT_ROOT = torture-test/var),
# AFTER provisionWorkClone created the work clone (provisioning guarantees a
# named-branch checkout; the detachment is the injection). Fails closed
# (exit 2) if the detachment cannot be verified.
set -euo pipefail

TT_ROOT="${TT_ROOT:?TT_ROOT must be set (spawned tt env)}"
case_id="W4.30-detached-head-origin"
fixture="tt-ts"

clone="$TT_ROOT/fixtures/work/$case_id/$fixture"

[ -d "$clone/.git" ] || { echo "W4.30 reset: work clone missing: $clone" >&2; exit 2; }

git -C "$clone" checkout -q --detach HEAD
branch="$(git -C "$clone" branch --show-current)"
[ -z "$branch" ] || {
  echo "W4.30 reset: origin HEAD is NOT detached (branch: '$branch')" >&2
  exit 2
}

echo "W4.30 reset: origin HEAD detached at $(git -C "$clone" rev-parse --short HEAD)"
