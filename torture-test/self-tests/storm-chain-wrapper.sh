#!/usr/bin/env bash
# storm-chain-wrapper.sh — O12-REPIN US-008 outer wrapper.
#
# Acquires the shared vaivm gate lock for the WHOLE 49-file storm chain (waits
# as long as needed; never bypasses, unlinks, chmods or otherwise alters the
# lock), runs the chain inside the held lock, records submit/acquire/release
# times plus the lock file's before/after stat, and then writes
# `chain-summary.json` / `chain-report.md`.
#
# Env:
#   STORM_CHAIN_REPO   repo root the chain runs from (default: this repo)
#   STORM_CHAIN_EVID   evidence dir (default:
#                      <repo>/torture-test/var/results/storm-chain-<ts>)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${STORM_CHAIN_REPO:-$(cd "$HERE/../.." && pwd)}"
LOCK="${STORM_CHAIN_LOCK:-/home/kaladin/matchlock-work/vaivm-gate.lock}"

if [ -n "${STORM_CHAIN_EVID:-}" ]; then
  EVID="$STORM_CHAIN_EVID"
else
  EVID="$REPO/torture-test/var/results/storm-chain-$(date -u +%Y-%m-%dT%H-%M-%SZ)"
fi

mkdir -p "$EVID/logs"

# Retain the exact wrapper/runner/summarizer scripts that produce the evidence.
cp -a "$HERE/storm-chain-wrapper.sh" "$EVID/chain-wrapper.sh"
cp -a "$HERE/storm-chain-runner.sh" "$EVID/chain-runner.sh"
cp -a "$HERE/storm-chain-summarize.mjs" "$EVID/storm-chain-summarize.mjs"
cp -a "$HERE/storm-chain-report.mjs" "$EVID/storm-chain-report.mjs"
cp -a "$HERE/storm-chain-files.mjs" "$EVID/storm-chain-files.mjs"

# Materialize the canonical chain file list (byte-matches run #7's file).
node "$HERE/storm-chain-files.mjs" > "$EVID/chain-files.txt"

lock_fingerprint() {
  # size, mode, mtime, inode + content hash; never modifies the lock.
  {
    stat -c 'stat %n size=%s mode=%a mtime=%Y inode=%i' "$LOCK" 2>&1 || true
    sha256sum "$LOCK" 2>&1 || true
  } | sed "s#$LOCK#LOCK#g"
}

lock_fingerprint > "$EVID/lock-stat-before.txt"

export STORM_CHAIN_REPO="$REPO"
export STORM_CHAIN_EVID="$EVID"
export STORM_CHAIN_LOCK="$LOCK"
export STORM_CHAIN_SUBMIT_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export STORM_CHAIN_SUBMIT_EPOCH="${EPOCHREALTIME:-$(date +%s.%N)}"

echo "storm-chain: submitting at ${STORM_CHAIN_SUBMIT_ISO} (epoch ${STORM_CHAIN_SUBMIT_EPOCH}); waiting for $LOCK"
echo "storm-chain: repo=$REPO evidence=$EVID"

# --exclusive: blocks until the lock is free; the lock is held for the entire chain.
flock --exclusive "$LOCK" bash "$EVID/chain-runner.sh"
rc=$?

lock_fingerprint > "$EVID/lock-stat-after.txt"
echo "storm-chain: flock returned rc=$rc at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

node "$EVID/storm-chain-summarize.mjs" "$EVID"
summary_rc=$?

if [ "$summary_rc" -ne 0 ]; then
  echo "storm-chain: summary validation failed"
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  echo "storm-chain: chain had red files (rc=$rc)"
  exit "$rc"
fi
echo "storm-chain: STORM_CHAIN_RESULT: PASS (see $EVID/chain-summary.json)"
exit 0
