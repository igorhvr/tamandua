#!/usr/bin/env bash
# Icebox image-layer verification driver (HOST side).
#
# Builds ONLY the `icebox-env` stage of oci-container/Dockerfile (pinned base +
# Pillar A/B layer; no product stages, no network) and runs the acceptance
# matrix (icebox/verify-matrix.sh) inside a disposable container started from
# that image. The matrix asserts the AS-BUILT state; the installer idempotence
# rerun happens inside the matrix as its last section.
#
# Usage:  oci-container/icebox/verify-icebox-env.sh [image-tag] [logfile]
# Env:    KEEP=1  keep the container on exit (for inspection)
# Exit:   0 only when the build, the image ENV check and the matrix all pass.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CTX="$(cd "$HERE/.." && pwd)"
IMG="${1:-tamandua-icebox-env:local}"
LOG="${2:-${TMPDIR:-/tmp}/icebox-verify-$(date -u +%Y%m%dT%H%M%SZ).log}"
mkdir -p "$(dirname "$LOG")"
exec > >(tee "$LOG") 2>&1

NAME="icebox-env-verify-$$"
FAIL=0
cleanup(){ [ "${KEEP:-0}" = 1 ] || docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "== verify-icebox-env $(date -u +%FT%TZ)"
echo "== context: $CTX"
echo "== image:   $IMG    log: $LOG"

echo; echo "== build --target icebox-env (no product stages)"
docker build --target icebox-env -t "$IMG" "$CTX" || FAIL=1
if [ "$FAIL" = 0 ]; then
  echo "   arch: $(uname -m)"
  echo "   image id: $(docker image inspect "$IMG" --format '{{.Id}}')"
  echo "   base: $(awk '/^FROM /{print $2; exit}' "$CTX/Dockerfile")"
fi

if [ "$FAIL" = 0 ]; then
  echo; echo "== image ENV check (docker image inspect)"
  PATHCFG=$(docker image inspect "$IMG" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^PATH=')
  echo "   $PATHCFG"
  case "$PATHCFG" in
    PATH=/nix/var/nix/profiles/default/bin:*) echo "  ok: image PATH has the nix profile bin first" ;;
    *) echo "  FAIL: image PATH missing nix profile bin first"; FAIL=1 ;;
  esac
fi

if [ "$FAIL" = 0 ]; then
  echo; echo "== disposable container from the built stage"
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --entrypoint sleep "$IMG" infinity >/dev/null || FAIL=1
fi

if [ "$FAIL" = 0 ]; then
  if docker cp "$HERE/verify-matrix.sh" "$NAME:/opt/icebox/verify-matrix.sh" >/dev/null; then
    docker exec "$NAME" bash /opt/icebox/verify-matrix.sh
    RC=$?
    echo; echo "== matrix exit code: $RC"
    [ "$RC" = 0 ] || FAIL=1
    [ "${KEEP:-0}" = 1 ] && echo "== container kept: $NAME"
  else
    echo "  FAIL: matrix script copy failed; matrix not executed"
    FAIL=1
  fi
fi

echo; echo "== RESULT: $([ "$FAIL" = 0 ] && echo PASS || echo FAIL)  (log: $LOG)"
exit "$FAIL"
