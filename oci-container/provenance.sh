#!/usr/bin/env bash
# Write /etc/tamandua-image-manifest.json: the image's provenance record.
# Runs at image-build time AFTER all four products are installed. Fail-closed:
# a moved upstream pin, a missing/misplaced interpreter, application
# environment or payload manifest, a failed version probe, or baked
# config/lock residue fails the build.
set -euo pipefail
cd /

HERMES_HOME=/opt/src/hermes-root
ROOT_DIR=/opt/src
INSTALL_DIR=$ROOT_DIR/hermes-agent

HS=$(git -C "$INSTALL_DIR" rev-parse HEAD)
PS=$(git -C /opt/src/pi rev-parse HEAD)
DS=$(git -C /opt/dsh rev-parse HEAD)
TS=$(git -C /opt/tamandua rev-parse HEAD)

# --- pin guards (fail closed; a bump is a deliberate operator change) -------
grep -q 'requires-python = ">=3.11,<3.15"' "$INSTALL_DIR/pyproject.toml" \
  || { echo "FATAL: hermes requires-python no longer declares >=3.11,<3.15" >&2; exit 1; }
grep -q '3\.14\.7' "$INSTALL_DIR/pm/lock.json" \
  || { echo "FATAL: hermes pm/lock.json no longer pins python 3.14.7" >&2; exit 1; }

# --- interpreter + application environment via the upstream resolvers ------
resolved="$(HERMES_HOME="$HERMES_HOME" python3 - "$INSTALL_DIR" <<'PY'
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
PYEXE="$(printf '%s\n' "$resolved" | sed -n 1p)"
VENVPY="$(printf '%s\n' "$resolved" | sed -n 2p)"
[ -x "$PYEXE" ] || { echo "FATAL: store interpreter missing: $PYEXE" >&2; exit 1; }
[ -x "$VENVPY" ] || { echo "FATAL: application interpreter missing: $VENVPY" >&2; exit 1; }
PYVER="$("$PYEXE" -c 'import sys;print(".".join(map(str,sys.version_info[:3])))')"
[ "$PYVER" = "3.14.7" ] || { echo "FATAL: store python is $PYVER, expected 3.14.7" >&2; exit 1; }
"$VENVPY" -c 'import ruamel.yaml' || { echo "FATAL: app environment incomplete (ruamel)" >&2; exit 1; }
SQLITE="$("$PYEXE" -c 'import sqlite3;print(sqlite3.sqlite_version)')"
NODE="$(node -v)"

# --- payload manifest (any-caller-uid contract) -----------------------------
python3 - "$ROOT_DIR" "$INSTALL_DIR" <<'PY' || exit 1
import json, sys
from pathlib import Path
out, root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8-sig"))
for key in ("repo", "venv", "store"):
    if not isinstance(manifest.get(key), str) or not manifest[key]:
        raise SystemExit("FATAL: payload manifest field %r missing" % key)
if (out / manifest["repo"]).resolve() != root:
    raise SystemExit("FATAL: payload manifest repo does not name the checkout")
for key in ("venv", "store"):
    resolved = (out / manifest[key]).resolve()
    if not resolved.is_relative_to(out) or not resolved.exists():
        raise SystemExit("FATAL: payload manifest %s does not resolve inside %s: %s" % (key, out, resolved))
if manifest["venv"] != "hermes-venv" or not (out / "hermes-venv").is_symlink():
    raise SystemExit("FATAL: payload venv symlink missing")
runtime_marker = out / "pm-runtime" / "pm-runtime.json"
if not runtime_marker.is_file():
    raise SystemExit("FATAL: packaged PM runtime missing: %s" % runtime_marker)
print("packaged PM runtime ok: %s" % runtime_marker)
stamp = json.loads((root / "install-stamp.json").read_text(encoding="utf-8-sig"))
if stamp.get("updateMechanism") != "external":
    raise SystemExit("FATAL: install stamp is not external: %r" % stamp.get("updateMechanism"))
print("payload manifest ok: venv -> %s" % (out / manifest["venv"]).resolve())
PY

# --- version probes (strict: a failed probe is a failed build) --------------
# Payload path: fresh root home, no HERMES_HOME -> must select the shipped
# environment without provisioning.
HV="$(env -u HERMES_HOME HOME=/root /usr/local/bin/hermes --version 2>&1)" \
  || { printf '%s\n' "$HV" >&2; echo "FATAL: hermes --version failed (fresh-home path)" >&2; exit 1; }
case "$HV" in
  *Traceback*|*"ModuleNotFoundError"*|*Installing*|*"preparing dependencies"*)
    printf '%s\n' "$HV" >&2; echo "FATAL: fresh-home hermes --version is not clean" >&2; exit 1 ;;
esac
HV2="$(HERMES_HOME="$HERMES_HOME" HOME=/root /usr/local/bin/hermes --version 2>&1)" \
  || { printf '%s\n' "$HV2" >&2; echo "FATAL: hermes --version failed (state path)" >&2; exit 1; }
case "$HV2" in
  *Traceback*|*"ModuleNotFoundError"*|*Installing*|*"preparing dependencies"*)
    printf '%s\n' "$HV2" >&2; echo "FATAL: state-home hermes --version is not clean" >&2; exit 1 ;;
esac
PV="$(/usr/local/bin/pi --version 2>&1)" || { printf '%s\n' "$PV" >&2; echo "FATAL: pi --version failed" >&2; exit 1; }
DV="$(/usr/local/bin/dsh --version 2>&1)" || { printf '%s\n' "$DV" >&2; echo "FATAL: dsh --version failed" >&2; exit 1; }
TV="$(/usr/local/bin/tamandua version 2>&1)" || { printf '%s\n' "$TV" >&2; echo "FATAL: tamandua version failed" >&2; exit 1; }

# --- hygiene: probes must never leave config/credentials/lock residue -------
rm -f "$HERMES_HOME/.env" "$HERMES_HOME/config.yaml" \
      "$HERMES_HOME/.hermes-update-in-progress" "$HERMES_HOME/.hermes-update-in-progress.lock"
rm -rf /root/.hermes
[ ! -e "$HERMES_HOME/.env" ] || { echo "FATAL: $HERMES_HOME/.env present" >&2; exit 1; }
[ ! -e "$HERMES_HOME/config.yaml" ] || { echo "FATAL: $HERMES_HOME/config.yaml present" >&2; exit 1; }
[ ! -e "$HERMES_HOME/.hermes-update-in-progress" ] || { echo "FATAL: update marker present" >&2; exit 1; }
[ ! -e /root/.hermes ] || { echo "FATAL: /root/.hermes present" >&2; exit 1; }

echo "-- store python: $PYEXE (python $PYVER, sqlite $SQLITE)"

HS="$HS" PS="$PS" DS="$DS" TS="$TS" PYVER="$PYVER" PYEXE="$PYEXE" SQLITE="$SQLITE" NODE="$NODE" \
HV="$HV" HV2="$HV2" PV="$PV" DV="$DV" TV="$TV" python3 - <<'PY'
import json, os
env = os.environ
manifest = {
    "schemaVersion": 1,
    "image": "igorhvr/tamandua (r4 standard image)",
    "hermesCommit": env["HS"],
    "piCommit": env["PS"],
    "dshCommit": env["DS"],
    "tamanduaCommit": env["TS"],
    "pythonPin": "3.14.7",
    "pythonVersion": env["PYVER"],
    "pythonPath": env["PYEXE"],
    "sqliteVersion": env["SQLITE"],
    "node": env["NODE"],
    "hermesVersionOutputFreshHome": env["HV"].strip().splitlines()[:6],
    "hermesVersionOutput": env["HV2"].strip().splitlines()[:6],
    "piVersionOutput": env["PV"].strip().splitlines()[:3],
    "dshVersionOutput": env["DV"].strip().splitlines()[:3],
    "tamanduaVersionOutput": env["TV"].strip().splitlines()[:3],
}
with open("/etc/tamandua-image-manifest.json", "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2, sort_keys=True)
    fh.write("\n")
PY
cat /etc/tamandua-image-manifest.json
