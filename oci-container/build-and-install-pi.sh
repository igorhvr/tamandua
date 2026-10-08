#!/usr/bin/env bash
# pi: build + install from THIS source tree.
#
# System mode (uid 0 -- the image build, or a root shell in the guest):
#   builds /opt/src/pi in place; publishes /usr/local/bin/pi (launcher ->
#   packages/coding-agent/dist/bundle/cli.js); makes the tree world-readable so
#   ANY caller uid can run it.
#
# User mode (non-root):
#   copies the tree to ~/src/pi (unless already there), builds it for that user,
#   publishes ~/.local/bin/pi. Network required (npm ci + model data).
#
# The tree tracks main (branch `main` -> origin/main). Rerun after edits.
# PI_OFFLINE_MODEL_DATA=1 rebuilds from the checkout's existing model data
# (fails if that data is absent; a fresh clone carries none).
#
# Native accelerators (TUI clipboard/modifier helpers) are OPTIONAL and ship
# as tracked per-platform prebuilds in packages/tui/native/*/prebuilds; the
# bundle falls back to JavaScript when a helper is absent. The image does not
# rebuild them (a native rebuild would rewrite tracked bytes); a guest that
# wants its own build can run, after installing headers:
#   npm --prefix packages/tui run build:native:linux
set -euo pipefail
umask 022

SELF_TREE="$(cd "$(dirname "$0")" && pwd)"
MODE=user
[ "$(id -u)" -eq 0 ] && MODE=system

if [ "$MODE" = system ]; then
  if [ -f "$SELF_TREE/package.json" ]; then
    TREE="$SELF_TREE"
  else
    TREE=/opt/src/pi
    [ -f "$TREE/package.json" ] || { echo "FATAL: no pi source tree at $TREE" >&2; exit 1; }
  fi
  PREFIX=/usr/local
else
  if [ -n "${PI_USER_SRC:-}" ]; then
    TREE="$PI_USER_SRC"
  elif [ -w "$SELF_TREE" ] && [ -f "$SELF_TREE/package.json" ]; then
    TREE="$SELF_TREE"
  else
    TREE="$HOME/src/pi"
  fi
  if [ ! -f "$TREE/package.json" ]; then
    if [ "$TREE" = "$SELF_TREE" ] || [ ! -f "$SELF_TREE/package.json" ]; then
      echo "FATAL: no pi source tree at $TREE" >&2; exit 1
    fi
    mkdir -p "$(dirname "$TREE")"
    cp -a "$SELF_TREE" "$TREE"
  fi
  PREFIX="$HOME/.local"
fi

cd "$TREE"

if [ -n "${EXPECT_HEAD:-}" ]; then
  HAVE="$(git rev-parse HEAD)"
  [ "$HAVE" = "$EXPECT_HEAD" ] || { echo "FATAL: HEAD $HAVE != expected $EXPECT_HEAD" >&2; exit 1; }
fi

node -e 'const v=process.versions.node.split(".").map(Number);
if (v[0] < 22 || (v[0] === 22 && v[1] < 19)) { console.error("node " + process.versions.node + " is older than the required >=22.19.0"); process.exit(1); }'

echo "== pi build-and-install mode=$MODE tree=$TREE prefix=$PREFIX node=$(node -v)"

# Local-only excludes: outputs of THIS script (never upstream policy).
EXCL="$TREE/.git/info/exclude"
grep -qx 'build-and-install' "$EXCL" 2>/dev/null || echo 'build-and-install' >> "$EXCL"

npm ci --ignore-scripts --no-audit --no-fund

if [ "${PI_OFFLINE_MODEL_DATA:-0}" = "1" ]; then
  npm run build:offline
else
  npm run build
fi

BUNDLE="$TREE/packages/coding-agent/dist/bundle/cli.js"
[ -f "$BUNDLE" ] || { echo "FATAL: bundle missing: $BUNDLE" >&2; exit 1; }

mkdir -p "$PREFIX/bin"
cat > "$PREFIX/bin/pi" <<EOF
#!/bin/sh
exec node "$BUNDLE" "\$@"
EOF
chmod 755 "$PREFIX/bin/pi"

# Image mode only: the shipped tree must be pristine (no build residue).
# A user rebuild legitimately edits sources first; never refuse those.
if [ "${TAMANDUA_IMAGE_BUILD:-0}" = "1" ]; then
  GIT_DIRTY="$(git status --porcelain)"
  [ -z "$GIT_DIRTY" ] || { echo "FATAL: source tree is dirty after build:" >&2; printf '%s\n' "$GIT_DIRTY" >&2; exit 1; }
fi

if [ "$MODE" = system ]; then
  chmod -R a+rX "$TREE" 2>/dev/null || true
fi

echo "== pi version:"
"$PREFIX/bin/pi" --version
echo "pi build-and-install: OK"
