#!/usr/bin/env python3
"""US-002: which config file/layer decides ``database.journal_mode``?

This probe runs in-process against the installed Hermes runtime
(``/home/kaladin/hermes-agent``) and against fresh, disposable
``/tmp/g1-*`` HERMES_HOME directories.  It never constructs, opens, or
writes ``/home/kaladin/.hermes``.

Five scenarios are measured and asserted:

1. Empty home (a config.yaml with no ``database`` section) -> ``wal``
   (the ``DEFAULT_CONFIG`` default in ``hermes_cli/config_defaults.py``).
2. ``database.journal_mode: delete`` in ``$HERMES_HOME/config.yaml`` ->
   ``delete``.
3. An invalid value (``bogus``) -> ``wal`` (fail-safe; the gate cannot
   trust raw YAML text blindly).
4. ``HERMES_JOURNAL_MODE=delete`` does **not** override a user config of
   ``wal`` (the environment is not a layer for this setting).
5. A managed-scope overlay wins over user config: a scratch managed
   ``config.yaml`` with ``database.journal_mode: delete`` is injected by
   monkeypatching ``hermes_cli.managed_scope.get_managed_dir``; the user
   config says ``wal`` and ``resolve_journal_mode()`` must return
   ``delete``.

For every scenario the probe records the config path, its ``realpath``,
the raw user value, the managed overlay value, the resolved value, and
the winning layer.  It also runs ``hermes config path`` through
``docs/gate/probes/hermes_scratch.sh`` and asserts it agrees with the
in-process ``hermes_cli.config.get_config_path()``.

Usage (the documented invocation, cwd is the Hermes install):

    cd /home/kaladin/hermes-agent
    /home/kaladin/hermes-agent/venv/bin/python \
        <worktree>/docs/gate/probes/probe_config.py

Exit status 0 means every assertion passed.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Optional

SCRATCH_PARENT = Path("/tmp").resolve()
REAL_HOME = Path("/home/kaladin/.hermes")
HERMES_SRC = Path(os.environ.get("HERMES_SRC", "/home/kaladin/hermes-agent")).resolve()
REPO_ROOT = Path(__file__).resolve().parents[3]
WRAPPER = REPO_ROOT / "docs" / "gate" / "probes" / "hermes_scratch.sh"
HERMES_BIN = Path(
    os.environ.get("HERMES_BIN", str(HERMES_SRC / "venv" / "bin" / "hermes"))
)

# A single mktemp-created scratch base, created *before* importing any Hermes
# module so no import-time code can fall back to the operator home.  Every
# scenario home below is a fresh child of this base and therefore matches the
# wrapper's /tmp/g1-* contract.  ``G1_CONFIG_ROOT`` lets the consolidated
# harness (run_all.sh) place this probe under the run's fresh scratch root.
_CONFIG_ROOT = os.environ.pop("G1_CONFIG_ROOT", None)
if _CONFIG_ROOT:
    BASE = Path(_CONFIG_ROOT).resolve()
    BASE.mkdir(parents=True, exist_ok=True)
else:
    BASE = Path(tempfile.mkdtemp(prefix="g1-config-", dir=str(SCRATCH_PARENT)))
_BOOTSTRAP_HOME = BASE / "bootstrap-home"
_BOOTSTRAP_HOME.mkdir()
os.environ["HERMES_HOME"] = str(_BOOTSTRAP_HOME)
os.environ.pop("HERMES_JOURNAL_MODE", None)

if str(REAL_HOME) == str(BASE) or REAL_HOME in BASE.parents:
    raise SystemExit("refusing to run: scratch base resolves inside the real operator home")

if str(HERMES_SRC) not in sys.path:
    sys.path.insert(0, str(HERMES_SRC))

import hermes_cli.config as hconfig  # noqa: E402
import hermes_cli.managed_scope as managed_scope  # noqa: E402
import hermes_state_wal  # noqa: E402


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _reset_caches() -> None:
    """Drop both config caches so each scenario measures its own files."""
    hconfig._LOAD_CONFIG_CACHE.clear()  # noqa: SLF001 - probe, not production
    managed_scope.invalidate_managed_cache()


@contextlib.contextmanager
def _patched_managed_dir(value: Optional[Path]):
    """Monkeypatch the managed-scope seam; nothing is written outside scratch."""
    original = managed_scope.get_managed_dir
    managed_scope.get_managed_dir = lambda: value
    managed_scope.invalidate_managed_cache()
    try:
        yield
    finally:
        managed_scope.get_managed_dir = original
        managed_scope.invalidate_managed_cache()


def _cli_config_path(home: Path) -> dict[str, Any]:
    """Run ``hermes config path`` through the scratch wrapper."""
    env = dict(os.environ)
    env["HERMES_HOME"] = str(home)
    env.pop("HERMES_JOURNAL_MODE", None)
    completed = subprocess.run(
        ["/bin/bash", str(WRAPPER), "config", "path"],
        cwd=str(HERMES_SRC),
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )
    return {
        "argv": ["/bin/bash", str(WRAPPER), "config", "path"],
        "hermes_home": str(home),
        "exit": completed.returncode,
        "stdout": completed.stdout.strip(),
        "stderr": completed.stderr.strip(),
    }


def _write_config(home: Path, body: str) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    path = home / "config.yaml"
    path.write_text(body, encoding="utf-8")
    return path


def _measure(
    *,
    scenario: str,
    home: Path,
    config_body: str,
    raw_user_value: Optional[str],
    expected: str,
    winning_layer: str,
    managed_value: Optional[str] = None,
    managed_dir: Optional[Path] = None,
    env_extra: Optional[dict[str, str]] = None,
    isolate_no_managed: bool = True,
) -> dict[str, Any]:
    """Run one scenario and return its record; raises AssertionError on failure."""
    assert home.is_absolute(), f"{scenario}: home must be absolute"
    real_home = Path(os.path.realpath(home))
    assert str(real_home).startswith(str(SCRATCH_PARENT / "g1-")), (
        f"{scenario}: scratch home must live under /tmp/g1-*, got {real_home}"
    )
    assert real_home != REAL_HOME and REAL_HOME not in real_home.parents, (
        f"{scenario}: refusing to use the real operator home"
    )

    os.environ["HERMES_HOME"] = str(real_home)
    config_path = _write_config(real_home, config_body)
    _reset_caches()

    saved_env: dict[str, Optional[str]] = {}
    for key, value in (env_extra or {}).items():
        saved_env[key] = os.environ.get(key)
        os.environ[key] = value

    managed_keys: list[str] = []
    try:
        if isolate_no_managed and managed_dir is None:
            with _patched_managed_dir(None):
                resolved = hermes_state_wal.resolve_journal_mode()
        elif managed_dir is not None:
            with _patched_managed_dir(managed_dir):
                resolved = hermes_state_wal.resolve_journal_mode()
                # Read the pinned-key set inside the patch: outside it, the seam
                # resolves back to the host's (absent) managed directory.
                managed_keys = sorted(managed_scope.managed_config_keys())
        else:
            resolved = hermes_state_wal.resolve_journal_mode()
    finally:
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    in_process_path = str(hconfig.get_config_path())
    in_process_realpath = os.path.realpath(in_process_path)
    cli = _cli_config_path(real_home)
    cli_realpath = os.path.realpath(cli["stdout"]) if cli["stdout"] else ""

    managed_key_present = "database.journal_mode" in managed_keys

    record = {
        "scenario": scenario,
        "hermes_home": str(real_home),
        "hermes_home_realpath": str(real_home),
        "config_path": in_process_path,
        "config_realpath": in_process_realpath,
        "config_exists": os.path.exists(in_process_path),
        "config_sha256": _sha256(config_path),
        "raw_user_value": raw_user_value,
        "managed_overlay_value": managed_value,
        "managed_overlay_keys": managed_keys,
        "resolved": resolved,
        "expected": expected,
        "winning_layer": winning_layer,
        "cli": cli,
        "cli_realpath": cli_realpath,
        "checks": {
            "cli_exit_zero": cli["exit"] == 0,
            "cli_path_matches_in_process": cli_realpath == in_process_realpath,
            "resolved_matches_expected": resolved == expected,
            "managed_key_present": managed_key_present if managed_dir else None,
        },
    }

    assert cli["exit"] == 0, f"{scenario}: hermes config path failed: {cli}"
    assert cli_realpath == in_process_realpath, (
        f"{scenario}: CLI path {cli_realpath!r} != in-process {in_process_realpath!r}"
    )
    assert resolved == expected, (
        f"{scenario}: resolved {resolved!r}, expected {expected!r}"
    )
    if managed_dir is not None:
        assert managed_key_present, (
            f"{scenario}: database.journal_mode must be a managed key, got {managed_keys}"
        )
    return record


def main() -> int:
    assert str(Path(os.path.realpath(BASE))).startswith(str(SCRATCH_PARENT / "g1-"))
    assert REAL_HOME not in Path(os.path.realpath(BASE)).parents

    host_managed_dir = managed_scope.get_managed_dir()
    host_managed_dir_str = str(host_managed_dir) if host_managed_dir is not None else None

    records: list[dict[str, Any]] = []
    failures: list[str] = []

    def run(**kwargs: Any) -> None:
        try:
            record = _measure(**kwargs)
        except AssertionError as exc:
            failures.append(str(exc))
            print(json.dumps({"scenario": kwargs.get("scenario"), "error": str(exc)}, sort_keys=True))
            return
        records.append(record)
        print(json.dumps(record, sort_keys=True))

    # 1. Default: config.yaml exists but has no database section.
    run(
        scenario="default-no-database-section",
        home=BASE / "scenario-1" / "hermes-home",
        config_body='model: ""\n',
        raw_user_value=None,
        expected="wal",
        winning_layer="default (DEFAULT_CONFIG database.journal_mode=wal)",
    )

    # 2. User config sets delete.
    run(
        scenario="user-config-delete",
        home=BASE / "scenario-2" / "hermes-home",
        config_body="database:\n  journal_mode: delete\n",
        raw_user_value="delete",
        expected="delete",
        winning_layer="user config ($HERMES_HOME/config.yaml)",
    )

    # 3. Invalid value fails safe to wal.
    run(
        scenario="invalid-value-bogus",
        home=BASE / "scenario-3" / "hermes-home",
        config_body="database:\n  journal_mode: bogus\n",
        raw_user_value="bogus",
        expected="wal",
        winning_layer="fail-safe default (invalid user value discarded; resolve_journal_mode returns wal)",
    )

    # 4. Environment is not a layer for database.journal_mode.
    run(
        scenario="env-var-does-not-override",
        home=BASE / "scenario-4" / "hermes-home",
        config_body="database:\n  journal_mode: wal\n",
        raw_user_value="wal",
        expected="wal",
        winning_layer="user config (HERMES_JOURNAL_MODE is not read as a config layer)",
        env_extra={"HERMES_JOURNAL_MODE": "delete"},
    )

    # 5. Managed-scope overlay wins over the user config.
    managed_dir = BASE / "scenario-5" / "managed"
    managed_dir.mkdir(parents=True)
    (managed_dir / "config.yaml").write_text(
        "database:\n  journal_mode: delete\n", encoding="utf-8"
    )
    run(
        scenario="managed-overlay-wins",
        home=BASE / "scenario-5" / "hermes-home",
        config_body="database:\n  journal_mode: wal\n",
        raw_user_value="wal",
        expected="delete",
        winning_layer="managed-scope overlay (admin config.yaml over user config)",
        managed_value="delete",
        managed_dir=managed_dir,
        isolate_no_managed=False,
    )

    summary = {
        "probe": "US-002 config resolution",
        "scratch_base": str(BASE),
        "hermes_src": str(HERMES_SRC),
        "hermes_bin": str(HERMES_BIN),
        "python": sys.version.split()[0],
        "cwd": os.getcwd(),
        "host_managed_dir_observed": host_managed_dir_str,
        "host_managed_dir_note": (
            "get_managed_dir() with this process environment; scenarios 1-4 patch it to None "
            "so each layer is measured in isolation, and scenario 5 patches it to a scratch dir"
        ),
        "scenarios": [r["scenario"] for r in records],
        "all_passed": not failures,
    }
    print(json.dumps(summary, sort_keys=True))

    if failures:
        print(f"probe_config: {len(failures)} scenario(s) failed", file=sys.stderr)
        for failure in failures:
            print(f"  - {failure}", file=sys.stderr)
        return 1
    print(f"probe_config: all {len(records)} scenarios passed")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        # Only the scratch tree is removed; no real home is ever named here.
        import shutil

        shutil.rmtree(BASE, ignore_errors=True)
