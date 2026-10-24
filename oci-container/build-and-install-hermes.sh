#!/usr/bin/env bash
# Hermes Agent: build + install from THIS source tree.
#
# The script builds the hermes source tree it lives in. Run it again after
# editing or `git pull`ing the tree; it never discards local changes.
#
# System mode (uid 0 -- the image build, or a root shell in the guest):
#   builds the checkout the script lives in; the managed data root (uv,
#   Python 3.14.7, Node, the application venv generations) lives under
#   HERMES_SYSTEM_HOME (default: <checkout parent>/hermes-root). Publishes
#   /usr/local/bin/{hermes,hermes-acp} plus the hermes-agent convenience
#   (`hermes --run-module run_agent`), the same shape upstream publishes.
#
# User mode (any non-root uid):
#   builds the tree it lives in when that tree is writable; otherwise copies
#   the tree to ~/src/hermes-agent once and builds there. The store stays
#   under $HERMES_HOME (default ~/.hermes). Publishes
#   ~/.local/bin/{hermes,hermes-acp,hermes-agent}. First run needs the network
#   for the managed toolchain.
#
# Payload mode (an image build, or any tree that already carries a payload
# manifest -- e.g. a guest rebuilding the image install):
#   makes the install self-contained for ANY caller uid and ANY HERMES_HOME --
#   the VM/guest contract. Three mechanisms, all standard upstream:
#     * a payload manifest beside the checkout naming the built application
#       environment, so a caller whose own data root has never been
#       provisioned selects the shipped environment instead of syncing
#       dependencies;
#     * a stable `hermes-venv` symlink beside the manifest, re-pointed on
#       every build, so rebuilds propagate to those callers automatically;
#     * install-stamp.json gets `updateMechanism: "external"`: updates belong
#       to the image (pull a new image, or rerun this script), never to a
#       launch-time dependency sync.
#     * PM's packaged runtime (`pm-runtime/`, staged with the build and sealed
#       for relocation), so `hermes pm ...` resolves and runs from a caller's
#       data root (mutations still follow ordinary filesystem ownership).
#   Payload mode also proves two fresh-home launches (root and uid 1000) work
#   without any provisioning.
#
# Packaging hygiene (no config/credentials, no telemetry receipts, no
# update-marker debris, shared readability, clean-tree enforcement) runs ONLY
# under the explicit TAMANDUA_IMAGE_BUILD=1 flag: a guest rebuild keeps its
# configuration, edits and locks.
#
# Python pin: 3.14.7 -- the newest Python hermes main supports
# (requires-python >=3.11,<3.15; upstream pm/lock.json names the exact
# 3.14.7+20260901 artifacts). Newest-supported is deliberate: older Pythons
# previously caused sqlite corruption for the maintainer. The script
# fail-closes if the managed interpreter is not exactly 3.14.7.
set -euo pipefail
umask 022

SELF_TREE="$(cd "$(dirname "$0")" && pwd)"
MODE=user
[ "$(id -u)" -eq 0 ] && MODE=system

run_stage() { # $1 = stage name, $2 = install dir, $3 = hermes home
  echo "-- hermes stage: $1"
  bash "$2/scripts/install.sh" --stage "$1" --non-interactive --dir "$2" \
      --hermes-home "$3" --skip-browser --skip-computer-use
}

# Local-only excludes for artifacts THIS script produces in the tree.
ensure_excludes() {
  local excl="$1/.git/info/exclude" p
  [ -d "$1/.git" ] || return 0
  mkdir -p "$(dirname "$excl")"
  for p in "build-and-install" ".hermes/" ".hermes-bootstrap-complete" "install-stamp.json"; do
    grep -qxF "$p" "$excl" 2>/dev/null || echo "$p" >> "$excl"
  done
}

if [ "$MODE" = system ]; then
  if [ -f "$SELF_TREE/pyproject.toml" ]; then
    INSTALL_DIR="$SELF_TREE"
  else
    INSTALL_DIR=/opt/src/hermes-agent
    [ -f "$INSTALL_DIR/pyproject.toml" ] || { echo "FATAL: no hermes source tree at $INSTALL_DIR" >&2; exit 1; }
  fi
  ROOT_DIR="$(cd "$INSTALL_DIR/.." && pwd)"
  export HOME="${HOME:-/root}"
  HERMES_HOME="${HERMES_SYSTEM_HOME:-$ROOT_DIR/hermes-root}"
  export HERMES_HOME
  # Keep every managed artifact under HERMES_HOME so the shared-readability
  # pass below covers uv, Python, Node and the venv generations in one tree.
  export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-$HERMES_HOME/python}"
  export XDG_DATA_HOME="$HERMES_HOME/share"
  export XDG_CACHE_HOME="$HERMES_HOME/cache"
else
  if [ -n "${HERMES_USER_SRC:-}" ]; then
    TREE="$HERMES_USER_SRC"
  elif [ -w "$SELF_TREE" ] && [ -f "$SELF_TREE/pyproject.toml" ]; then
    TREE="$SELF_TREE"
  else
    TREE="$HOME/src/hermes-agent"
  fi
  if [ ! -f "$TREE/pyproject.toml" ]; then
    if [ "$TREE" = "$SELF_TREE" ] || [ ! -f "$SELF_TREE/pyproject.toml" ]; then
      echo "FATAL: no hermes source tree at $TREE" >&2; exit 1
    fi
    mkdir -p "$TREE"
    # Plain recursive copy: running as the building user, ownership preservation
    # (cp -a) cannot succeed for another user's files and must not kill the run.
    cp -R "$SELF_TREE"/. "$TREE"/
  fi
  INSTALL_DIR="$TREE"
  ROOT_DIR="$(cd "$INSTALL_DIR/.." && pwd)"
  HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
  export HERMES_HOME
  # Launchers copied from another checkout embed THAT checkout's path; the
  # verification below re-mints any launcher that does not serve this tree.
fi

if [ -n "${EXPECT_HEAD:-}" ]; then
  HAVE="$(git -C "$INSTALL_DIR" rev-parse HEAD)"
  [ "$HAVE" = "$EXPECT_HEAD" ] || { echo "FATAL: HEAD $HAVE != expected $EXPECT_HEAD" >&2; exit 1; }
fi

ensure_excludes "$INSTALL_DIR"

# Two independent modes:
#   IMAGE_BUILD -- explicit (TAMANDUA_IMAGE_BUILD=1): packaging semantics for
#     the distributable image (hygiene, clean-tree enforcement).
#   PAYLOAD -- this tree carries (or is being given) a payload manifest, so
#     the built application environment is refreshed for any caller uid.
#     True in the image build; also true for a guest rebuild of the image
#     install, where packaging hygiene must NOT run (user config, edits and
#     locks stay put).
IMAGE_BUILD=0
if [ "${TAMANDUA_IMAGE_BUILD:-0}" = "1" ]; then IMAGE_BUILD=1; fi
PAYLOAD=0
if [ "$IMAGE_BUILD" = "1" ] || [ -f "$ROOT_DIR/manifest.json" ]; then PAYLOAD=1; fi

# A tree that already carries a payload manifest must still run the SAME
# ladder the image build runs. PM resolves its own runtime differently in a
# payload tree (it expects the sealed manager runtime there), so the manifest
# -- and the stable venv symlink it names -- are moved aside while the ladder
# runs and a fresh pair is republished afterwards. The trap restores the
# previous metadata pair when the run exits before publishing a replacement
# (a failure after publication leaves the newly published state; dependency
# generations and launchers are not transactionally rolled back). Rebuilds
# should still avoid overlapping heavy guest use.
STASHED_MANIFEST=0
restore_payload_stash(){
  [ "${STASHED_MANIFEST:-0}" = "1" ] || return 0
  if [ -e "$ROOT_DIR/manifest.json" ]; then
    rm -f "$ROOT_DIR/manifest.json.r4-hidden"
  elif [ -e "$ROOT_DIR/manifest.json.r4-hidden" ]; then
    mv -f "$ROOT_DIR/manifest.json.r4-hidden" "$ROOT_DIR/manifest.json"
  fi
  if [ -e "$ROOT_DIR/hermes-venv" ] || [ -L "$ROOT_DIR/hermes-venv" ]; then
    rm -f "$ROOT_DIR/hermes-venv.r4-hidden"
  elif [ -L "$ROOT_DIR/hermes-venv.r4-hidden" ]; then
    mv -f "$ROOT_DIR/hermes-venv.r4-hidden" "$ROOT_DIR/hermes-venv"
  fi
  STASHED_MANIFEST=0
}
if [ "$PAYLOAD" = "1" ] && [ -f "$ROOT_DIR/manifest.json" ] && [ "${TAMANDUA_PAYLOAD_KEEP_MANIFEST:-0}" != "1" ]; then
  STASHED_MANIFEST=1
  trap restore_payload_stash EXIT
  trap 'restore_payload_stash; exit 130' INT TERM
  mv -f "$ROOT_DIR/manifest.json" "$ROOT_DIR/manifest.json.r4-hidden"
  if [ -L "$ROOT_DIR/hermes-venv" ]; then mv -f "$ROOT_DIR/hermes-venv" "$ROOT_DIR/hermes-venv.r4-hidden"; fi
fi

echo "== hermes build-and-install mode=$MODE image_build=$IMAGE_BUILD payload=$PAYLOAD dir=$INSTALL_DIR hermes_home=$HERMES_HOME node=$(node -v 2>/dev/null || echo none)"

run_stage venv "$INSTALL_DIR" "$HERMES_HOME"
run_stage python-deps "$INSTALL_DIR" "$HERMES_HOME"
run_stage products "$INSTALL_DIR" "$HERMES_HOME"

# ---------------------------------------------------------------------------
# Packaging hygiene -- TAMANDUA_IMAGE_BUILD=1 ONLY.
# ---------------------------------------------------------------------------
if [ "$IMAGE_BUILD" = "1" ]; then
  [ ! -e "$HERMES_HOME/.env" ] || { echo "FATAL: $HERMES_HOME/.env must not be baked" >&2; exit 1; }
  [ ! -e "$HERMES_HOME/config.yaml" ] || { echo "FATAL: $HERMES_HOME/config.yaml must not be baked" >&2; exit 1; }
  rm -rf "$HERMES_HOME/telemetry"
  # Disposable residue of the completed build ladder; no update is running now
  # (a single-process image build; the flag is internal and explicit).
  rm -f "$HERMES_HOME/.hermes-update-in-progress" "$HERMES_HOME/.hermes-update-in-progress.lock"
  # Shared readability for everything a caller uid must read back: the data
  # root itself (traversal), the tool store, and the install state (facts +
  # venv generations). Never a blanket pass over a user home: a rebuilt guest
  # may keep private credentials beside them.
  chmod 755 "$HERMES_HOME" 2>/dev/null || true
  for d in tools installs python share; do
    if [ -e "$HERMES_HOME/$d" ]; then chmod -R a+rX "$HERMES_HOME/$d" 2>/dev/null || true; fi
  done
  chmod -R a+rX "$INSTALL_DIR" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# Payload manifest: make the built application environment selectable for ANY
# caller uid and ANY HERMES_HOME. Non-destructive: refreshing a payload never
# touches configuration, credentials, locks or source edits.
# ---------------------------------------------------------------------------
if [ "$PAYLOAD" = "1" ]; then
  python3 - "$INSTALL_DIR" "$HERMES_HOME" "$ROOT_DIR" <<'PY'
import json, os, sys
from pathlib import Path

root, home, out = (Path(p).resolve() for p in sys.argv[1:4])
sys.path.insert(0, str(root))
from hermes_cli._launchers import resolve_store_python
from pm.environments import committed_venv, site_packages, venv_python

store_py = resolve_store_python(root, publication=True)
venv = committed_venv(root)
if store_py is None or venv is None:
    raise SystemExit("resolver failed: store=%r venv=%r" % (store_py, venv))
venv = venv.resolve()
site = site_packages(venv).resolve()
if not (venv / "pyvenv.cfg").is_file():
    raise SystemExit("committed environment has no pyvenv.cfg: %s" % venv)

def rel(p):
    r = os.path.relpath(str(Path(p).resolve()), str(out))
    if r.startswith(".."):
        raise SystemExit("path escapes the payload root: %s" % p)
    return r

# Stable symlink re-pointed on every build; the manifest names the symlink,
# so fresh-home callers always select the newest generation.
link = out / "hermes-venv"
tmp = out / ".hermes-venv.tmp"
if tmp.is_symlink() or tmp.exists():
    tmp.unlink()
tmp.symlink_to(os.path.relpath(str(venv), str(out)))
os.replace(str(tmp), str(link))

manifest = {
    "schema": 1,
    "repo": rel(root),
    "venv": link.name,
    "store": rel(home / "tools"),
    "runtime": {
        "repoDir": rel(root),
        "toolsDir": rel(home / "tools"),
        "storePython": rel(store_py),
        "sitePackages": rel(site),
        "commands": {"hermes": rel(root / ".hermes/bin/hermes")},
    },
}
mpath = out / "manifest.json"
tmpj = out / ".manifest.json.tmp"
tmpj.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
os.replace(str(tmpj), str(mpath))
print("payload manifest: %s" % mpath)
print("  venv -> %s" % venv)

stamp_path = root / "install-stamp.json"
if not stamp_path.is_file():
    raise SystemExit("FATAL: install-stamp.json was not written by the products stage")
stamp = json.loads(stamp_path.read_text(encoding="utf-8-sig"))
if not isinstance(stamp, dict) or stamp.get("updateMechanism") not in ("self", "external"):
    raise SystemExit("FATAL: unexpected install stamp: %r" % (stamp.get("updateMechanism"),))
stamp["updateMechanism"] = "external"
tmps = root / ".install-stamp.tmp"
tmps.write_text(json.dumps(stamp, indent=2) + "\n", encoding="utf-8")
os.replace(str(tmps), str(stamp_path))
print("install stamp: updateMechanism=external (updates belong to the image)")
PY
fi

# ---------------------------------------------------------------------------
# PM's packaged runtime -- PAYLOAD mode only. A payload manifest makes PM run
# from the payload's pm-runtime; without one, every `hermes pm ...` refuses
# with "packaged PM runtime is missing or invalid". Stage it with the store
# Python (the system python3 lacks PM's dependencies), then seal it for
# relocation -- the same mechanism upstream's Docker build uses.
# ---------------------------------------------------------------------------
if [ "$PAYLOAD" = "1" ]; then
  R4_STORE_PY="$(HERMES_HOME="$HERMES_HOME" python3 - "$INSTALL_DIR" <<'PY'
import sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))
from hermes_cli._launchers import resolve_store_python
store = resolve_store_python(root, publication=True)
if store is None:
    sys.exit("cannot resolve the store interpreter")
print(store)
PY
)" || { echo "FATAL: cannot resolve the store interpreter for the PM runtime" >&2; exit 1; }
  "$R4_STORE_PY" - "$INSTALL_DIR" "$ROOT_DIR" <<'PY'
import json, os, shutil, sys
from pathlib import Path

root, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
sys.path.insert(0, str(root))
from hermes_cli._launchers import resolve_store_python
from pm import stage_manager_runtime
from scripts.bundles.payload import seal_pm_runtime

store = resolve_store_python(root, publication=True)
if store is None:
    raise SystemExit("cannot resolve the store interpreter")

runtime = out / "pm-runtime"
backup = out / "pm-runtime.r4-bak"
staged = False
# Swap-safe restage: the previous runtime is moved aside (never deleted
# first), the replacement is staged and sealed, and only after it verifies
# does the backup go. An error during the restage restores the previous
# runtime. This is an in-process guard, not crash recovery: an external kill
# mid-restage can leave `pm-runtime.r4-bak` beside a partial runtime.
try:
    if backup.is_symlink():
        backup.unlink()
    elif backup.exists():
        shutil.rmtree(backup)
    if runtime.is_symlink():
        runtime.unlink()
    elif runtime.exists():
        os.replace(runtime, backup)
    stage_manager_runtime(python=Path(str(store)), destination=runtime, project=root / "pm")
    seal_pm_runtime(out, Path(str(store)))
    marker = json.loads((runtime / "pm-runtime.json").read_text(encoding="utf-8"))
    py = (runtime / marker["python"]).resolve()
    site = (runtime / marker["sitePackages"]).resolve()
    if not py.is_file() or not site.is_dir():
        raise SystemExit("staged PM runtime failed verification: %r" % marker)
    staged = True
    print("packaged PM runtime: %s" % runtime)
finally:
    if staged:
        shutil.rmtree(backup, ignore_errors=True)
    elif backup.exists():
        shutil.rmtree(runtime, ignore_errors=True)
        os.replace(backup, runtime)
        print("packaged PM runtime: previous runtime restored after a failed restage", file=sys.stderr)
PY
  if [ "$IMAGE_BUILD" = "1" ]; then chmod -R a+rX "$ROOT_DIR/pm-runtime" 2>/dev/null || true; fi
fi

if [ "$STASHED_MANIFEST" = "1" ]; then
  rm -f "$ROOT_DIR/manifest.json.r4-hidden" "$ROOT_DIR/hermes-venv.r4-hidden"
  STASHED_MANIFEST=0
fi

# ---------------------------------------------------------------------------
# Verification (fail closed). Every claim below is exercised for real.
# ---------------------------------------------------------------------------
BIN_SRC="$INSTALL_DIR/.hermes/bin"
for n in hermes hermes-acp; do
  [ -x "$BIN_SRC/$n" ] || { echo "FATAL: launcher missing: $BIN_SRC/$n" >&2; exit 1; }
done

# A user rebuild must run ITS OWN tree: a launcher embeds the checkout it
# serves, and the stages keep a foreign live-bound launcher rather than
# rebinding a shared checkout. The embedded source path is shell-escaped in
# the file, so check the two facts on one line (the insert statement and the
# tree path) and re-mint by dropping the launcher first: publication only
# ever lands on a file it owns or one that is missing.
launcher_serves_tree(){ # $1 launcher file, $2 tree
  grep -F "sys.path.insert(0," "$1" 2>/dev/null | grep -qF "$2"
}
if [ "$MODE" = user ] && ! launcher_serves_tree "$BIN_SRC/hermes" "$INSTALL_DIR"; then
  rm -f "$BIN_SRC/hermes" "$BIN_SRC/hermes-acp"
  python3 - "$INSTALL_DIR" "$BIN_SRC" <<'PY'
import sys
from pathlib import Path
root, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2])
sys.path.insert(0, str(root))
from hermes_cli._launchers import ensure_install_launchers
print("re-minted launchers:", [Path(p).name for p in ensure_install_launchers(root, out)])
PY
  launcher_serves_tree "$BIN_SRC/hermes" "$INSTALL_DIR" \
    || { echo "FATAL: launcher does not serve this tree: $BIN_SRC/hermes" >&2; exit 1; }
fi

# Fresh-home launch proof (payload mode): the exact contract -- any caller
# uid, own fresh home, no HERMES_HOME override, no provisioning.
verify_fresh_home() { # $1 uid, $2 gid, $3 home
  local uid="$1" gid="$2" h="$3" out rc
  rm -rf "$h"; mkdir -p "$h"
  if [ "$uid" -ne 0 ]; then chown "$uid:$gid" "$h"; fi
  rc=0
  out="$(setpriv --reuid="$uid" --regid="$gid" --clear-groups \
           env -u HERMES_HOME HOME="$h" "$BIN_SRC/hermes" --version 2>&1)" || rc=$?
  printf '%s\n' "$out" | sed -n '1,3p' | sed 's/^/   fresh-home['"$uid"']: /'
  [ "$rc" -eq 0 ] || { echo "FATAL: fresh-home launch failed for uid $uid (rc=$rc)" >&2; return 1; }
  case "$out" in
    *Installing*|*Traceback*|*"ModuleNotFoundError"*|*"preparing dependencies"*|*"no dependency environment"*)
      echo "FATAL: fresh-home launch for uid $uid needed repair/provisioning" >&2; return 1 ;;
  esac
  rm -rf "$h"
}
if [ "$PAYLOAD" = "1" ]; then
  verify_fresh_home 0 0 /tmp/r4-fresh-root
  if command -v setpriv >/dev/null 2>&1 && getent passwd 1000 >/dev/null 2>&1; then
    verify_fresh_home 1000 1000 /tmp/r4-fresh-1000
  fi
fi

# The interpreter + application environment of the build itself, via the
# upstream resolvers -- never a filesystem guess or bare name match.
RESOLVED="$(HERMES_HOME="$HERMES_HOME" python3 - "$INSTALL_DIR" <<'PY'
import sys
from pathlib import Path
root = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(root))
from hermes_cli._launchers import resolve_store_python
from pm.environments import committed_venv, venv_python
store = resolve_store_python(root, publication=True)
venv = committed_venv(root)
if store is None or venv is None:
    sys.exit("resolver failed: store=%r venv=%r" % (store, venv))
print(store)
print(venv_python(venv))
PY
)" || { echo "FATAL: cannot resolve hermes store python / app environment" >&2; exit 1; }
STORE_PY="$(printf '%s\n' "$RESOLVED" | sed -n 1p)"
VENV_PY="$(printf '%s\n' "$RESOLVED" | sed -n 2p)"
[ -x "$STORE_PY" ] || { echo "FATAL: store interpreter missing: $STORE_PY" >&2; exit 1; }
[ -x "$VENV_PY" ] || { echo "FATAL: application interpreter missing: $VENV_PY" >&2; exit 1; }

PYVER="$("$STORE_PY" -c 'import sys;print(".".join(map(str,sys.version_info[:3])))')"
[ "$PYVER" = "3.14.7" ] || { echo "FATAL: managed python is $PYVER, expected 3.14.7" >&2; exit 1; }
SQLITE="$("$STORE_PY" -c 'import sqlite3;print(sqlite3.sqlite_version)')"
echo "-- store interpreter: $STORE_PY (python $PYVER, sqlite $SQLITE)"
echo "-- application env:   $VENV_PY"
"$VENV_PY" -c 'import ruamel.yaml, sqlite3; print("app-deps-ok")' \
  || { echo "FATAL: application dependencies are incomplete (ruamel missing)" >&2; exit 1; }

# ---------------------------------------------------------------------------
# CA remediation for the APPLICATION environment (eMudhra advisory, 2026-10-20).
#
# The base image's system store is patched, but hermes does NOT use it: it runs on
# its own bundled interpreter and its HTTP clients (httpx/requests) default to
# certifi. The hermes lock pins certifi 2026.5.20, and that bundle was measured to
# ACCEPT chains signed by the compromised eMudhra intermediates (3 of 6 advisory
# chains), while the patched certifi 2026.10.19 rejects all 6. So the system-store
# fix alone does not cover hermes traffic, and this upgrade is required.
#
# Fail closed: an image whose application env still carries a pre-remediation
# bundle must not build.
#
# Residual risk, stated rather than hidden: the upstream lock still pins 2026.5.20,
# so a later `uv sync --locked` (e.g. a user re-running this script against a fresh
# checkout) reverts to the old bundle. That is why the check lives HERE, in the
# installer, and not only in the Dockerfile.
# ---------------------------------------------------------------------------
CERTIFI_FLOOR=2026.10.19
if command -v uv >/dev/null 2>&1; then
  uv pip install --python "$VENV_PY" --upgrade "certifi>=$CERTIFI_FLOOR" >/dev/null 2>&1 || true
fi
CERTIFI_GOT="$("$VENV_PY" -c 'import certifi;print(certifi.__version__)' 2>/dev/null)" || CERTIFI_GOT=""
[ -n "$CERTIFI_GOT" ] || { echo "FATAL: certifi is not importable in the application environment" >&2; exit 1; }
"$VENV_PY" -c "
import sys, certifi
got = tuple(int(x) for x in certifi.__version__.split('.')[:3])
need = tuple(int(x) for x in '${CERTIFI_FLOOR}'.split('.'))
sys.exit(0 if got >= need else 1)
" || { echo "FATAL: certifi in the application env is ${CERTIFI_GOT}, below the CA-remediation floor ${CERTIFI_FLOOR}" >&2; exit 1; }
echo "-- certifi (application env): ${CERTIFI_GOT} (floor ${CERTIFI_FLOOR})"
case "$CERTIFI_GOT" in
  "$CERTIFI_FLOOR"|2026.1[1-9].*|202[7-9].*) : ;;
  *) echo "-- note: certifi ${CERTIFI_GOT} satisfies the floor but differs from the advisory's named release" ;;
esac

# The venv is not the only certifi in the image. Two more copies were measured:
#   * pip's VENDORED bundle (used by pip itself for HTTPS) -- was 2026.6.17;
#   * the uv download cache, which held the SAME stale bundle (identical sha256) and could
#     reinstall it on a later uv run.
# Both are handled here so the image does not ship a second, older trust store that some
# later command could silently fall back to.
PIP_VENDORED=$("$STORE_PY" -c 'import pip._vendor.certifi as c;print(c.where())' 2>/dev/null) || PIP_VENDORED=""
if [ -n "$PIP_VENDORED" ]; then
  PIP_VENDORED_VER=$("$STORE_PY" -c 'import pip._vendor.certifi as c;print(getattr(c,"__version__","0"))' 2>/dev/null) || PIP_VENDORED_VER="0"
  case "$PIP_VENDORED_VER" in
    "$CERTIFI_FLOOR"|2026.1[1-9].*|202[7-9].*) : ;;
    *)
      # Upgrading pip refreshes its vendored bundle as a side effect. Measured: pip 26.2.1
      # carried certifi 2026.6.17; upgrading to pip 26.2.2 yields exactly 2026.10.19.
      "$STORE_PY" -m pip install --no-cache-dir --upgrade pip >/dev/null 2>&1 || true
      PIP_VENDORED_VER=$("$STORE_PY" -c 'import pip._vendor.certifi as c;print(getattr(c,"__version__","0"))' 2>/dev/null) || PIP_VENDORED_VER="0"
      ;;
  esac
  echo "-- certifi (pip vendored): ${PIP_VENDORED_VER} (floor ${CERTIFI_FLOOR})"
  case "$PIP_VENDORED_VER" in
    "$CERTIFI_FLOOR"|2026.1[1-9].*|202[7-9].*) : ;;
    *) echo "FATAL: pip's vendored certifi is ${PIP_VENDORED_VER}, below the CA-remediation floor ${CERTIFI_FLOOR}. pip is a shipped, user-invocable tool in this image, so a pre-remediation bundle in it is not acceptable." >&2; exit 1 ;;
  esac
fi

# Do not ship a download cache holding the pre-remediation bundle (measured identical to the
# old venv bundle). No runtime symlink references it, so purging is safe and also shrinks the image.
UV_CACHE="${HERMES_HOME:-$ROOT_DIR}/cache/uv"
if [ -d "$UV_CACHE" ]; then
  rm -rf "$UV_CACHE" 2>/dev/null || true
  echo "-- purged uv download cache (held the pre-remediation certifi bundle)"
fi

# First launch must NOT self-repair: no dependency installation, no traceback.
VER_OUT="$("$BIN_SRC/hermes" --version 2>&1)" || { printf '%s\n' "$VER_OUT" >&2; echo "FATAL: hermes --version failed" >&2; exit 1; }
printf '%s\n' "$VER_OUT" | head -n 4
case "$VER_OUT" in
  *Installing*|*Traceback*|*"ModuleNotFoundError"*) echo "FATAL: hermes --version self-repaired; the install is incomplete" >&2; exit 1 ;;
esac

# ---------------------------------------------------------------------------
# Packaging finalization -- TAMANDUA_IMAGE_BUILD=1 ONLY.
# ---------------------------------------------------------------------------
if [ "$IMAGE_BUILD" = "1" ]; then
  # --version may materialize defaults; the image must not carry them.
  rm -f "$HERMES_HOME/.env" "$HERMES_HOME/config.yaml" \
        "$HERMES_HOME/.hermes-update-in-progress" "$HERMES_HOME/.hermes-update-in-progress.lock"
  # The shipped tree must be pristine (no build residue). Only image builds
  # enforce it: a user rebuild legitimately edits sources first.
  GIT_DIRTY="$(git -C "$INSTALL_DIR" status --porcelain)"
  [ -z "$GIT_DIRTY" ] || { echo "FATAL: source tree is dirty after build:" >&2; printf '%s\n' "$GIT_DIRTY" >&2; exit 1; }
fi

# ---------------------------------------------------------------------------
# Publish launchers. The hermes-agent convenience wraps the legacy run_agent
# module through the durable hermes launcher (same shape upstream publishes).
# ---------------------------------------------------------------------------
publish() { # $1 = bin dir
  local dir="$1" n
  mkdir -p "$dir"
  for n in hermes hermes-acp; do ln -sfn "$BIN_SRC/$n" "$dir/$n"; done
  rm -f "$dir/hermes-agent"
  {
    echo '#!/bin/sh'
    printf 'exec %s --run-module run_agent "$@"\n' "$BIN_SRC/hermes"
  } > "$dir/hermes-agent"
  chmod 755 "$dir/hermes-agent"
  echo "-- published: $dir/{hermes,hermes-acp,hermes-agent}"
}

if [ "$MODE" = system ]; then
  publish /usr/local/bin
  if [ "$IMAGE_BUILD" = "1" ] && command -v setpriv >/dev/null 2>&1 && getent passwd 1000 >/dev/null 2>&1; then
    FACTS="$(find "$HERMES_HOME/installs" -maxdepth 2 -name facts.json 2>/dev/null | head -n 1 || true)"
    [ -n "$FACTS" ] || { echo "FATAL: no facts.json under $HERMES_HOME/installs" >&2; exit 1; }
    setpriv --reuid=1000 --regid=1000 --clear-groups sh -c "test -x '$STORE_PY' && test -r '$FACTS'" \
      || { echo "FATAL: uid 1000 cannot read the install state ($STORE_PY / $FACTS)" >&2; exit 1; }
    echo "uid1000-install-state-access: ok"
  fi
else
  publish "$HOME/.local/bin"
fi

echo "hermes build-and-install: OK"
