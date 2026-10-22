#!/usr/bin/env python3
"""G1-B — the four REAL store writers, run with the image's own runtime.

Every G1-B probe seeds and exercises stores through this module so the records
the persistence assertions look for are produced by Hermes' own code paths, not
by hand-written SQL.  The module never writes SQL: it calls the stock writer and
then reads back the store-assigned record identifier.

Writers (all inside the published image, invoked with
``/opt/src/hermes-venv/bin/python``):

    state         ``hermes_state.SessionDB().create_session(session_id=<MARK>)``
    verification  ``agent.verification_evidence.record_verify_run(
                      session_id=<MARK>, ok=True)`` with the opt-in gate ON
                  (``HERMES_VERIFY_ON_STOP=1`` and ``agent.verify_on_stop: true``
                  in the fixture config)
    kanban        ``/usr/local/bin/hermes kanban create "<MARK>" --json``
    projects      ``/usr/local/bin/hermes project create "<MARK>" --slug <MARK>``

``projects`` needs no folder: the stock trigger creates the project row without
one, so no scratch repository and never an operator path is involved.

Output contract (one ``KEY=value`` line per field, stable for the shell
orchestrator and its evidence file)::

    WRITER_STORE=state.db
    WRITER_MARKER=g1b-state-<runid>-1
    WRITER_RECORD_TABLE=sessions
    WRITER_RECORD_COLUMN=id
    WRITER_RECORD_ID=g1b-state-<runid>-1
    WRITER_EXIT=0

``kanban`` additionally prints ``WRITER_RECORD_TITLE`` and ``projects`` prints
``WRITER_RECORD_SLUG``; both also print the store-assigned id
(``t_xxxxxxxx`` / ``p_xxxxxxxx``) as ``WRITER_RECORD_ID`` so the evidence names
the record even when the marker is a title/slug rather than a primary key.

Usage::

    g1b_writers.py <store> <marker> --home <hermes-home> [--scratch <dir>]

Journal format is never read here (that is ``read_header.py``'s job) and no
probe installs packages, patches Hermes or reaches the network.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from typing import Any, Optional

HERMES_BIN = "/usr/local/bin/hermes"
PYTHON_BIN = "/opt/src/hermes-venv/bin/python"

STORE_DB_NAMES = {
    "state": "state.db",
    "verification": "verification_evidence.db",
    "kanban": "kanban.db",
    "projects": "projects.db",
}


def emit(key: str, value: Any) -> None:
    print("%s=%s" % (key, value))


def _run_cli(args: list[str], home: str) -> subprocess.CompletedProcess:
    env = dict(os.environ)
    env["HERMES_HOME"] = home
    return subprocess.run(
        [HERMES_BIN] + args,
        env=env,
        capture_output=True,
        text=True,
        timeout=300,
    )


def write_state(marker: str, home: str, scratch: str) -> dict[str, Any]:
    from hermes_state import SessionDB

    db = SessionDB()
    try:
        record_id = db.create_session(session_id=marker, source="cli")
    finally:
        db.close()
    return {
        "table": "sessions",
        "column": "id",
        "record_id": record_id,
    }


def write_verification(marker: str, home: str, scratch: str) -> dict[str, Any]:
    # The evidence ledger is opt-in: prove the gate is ON for this writer, or
    # record_verify_run() returns None and no identifiable record exists.
    os.environ["HERMES_VERIFY_ON_STOP"] = "1"

    from agent.verification_evidence import record_verify_run
    from agent.verification_stop import verify_on_stop_enabled

    if not verify_on_stop_enabled():
        raise SystemExit(
            "verification writer: verify_on_stop is OFF; the raw default session "
            "never touches verification_evidence.db"
        )

    workspace = os.path.join(scratch, "verification-workspace")
    os.makedirs(workspace, exist_ok=True)
    event = record_verify_run(root=workspace, session_id=marker, ok=True)
    if not event:
        raise SystemExit(
            "verification writer: record_verify_run() returned no event"
        )
    emit("WRITER_VERIFY_ON_STOP", os.environ["HERMES_VERIFY_ON_STOP"])
    emit("WRITER_VERIFY_WORKSPACE", workspace)
    return {
        "table": "verification_events",
        "column": "session_id",
        "record_id": event.get("id"),
    }


def write_kanban(marker: str, home: str, scratch: str) -> dict[str, Any]:
    proc = _run_cli(["kanban", "create", marker, "--json"], home)
    if proc.returncode != 0:
        raise SystemExit(
            "kanban writer: `hermes kanban create` exited %d\nstdout: %s\nstderr: %s"
            % (proc.returncode, proc.stdout.strip(), proc.stderr.strip())
        )
    payload = _json_object(proc.stdout)
    task_id = payload.get("id")
    if not task_id:
        raise SystemExit("kanban writer: no task id in %r" % (proc.stdout,))
    return {
        "table": "tasks",
        "column": "id",
        "record_id": task_id,
        "title": payload.get("title", marker),
    }


def write_projects(marker: str, home: str, scratch: str) -> dict[str, Any]:
    proc = _run_cli(
        ["project", "create", marker, "--slug", marker],
        home,
    )
    if proc.returncode != 0:
        raise SystemExit(
            "projects writer: `hermes project create` exited %d\nstdout: %s\nstderr: %s"
            % (proc.returncode, proc.stdout.strip(), proc.stderr.strip())
        )
    match = re.search(r"\((p_[0-9a-z]+)\)", proc.stdout)
    if not match:
        raise SystemExit(
            "projects writer: no project id in output %r" % (proc.stdout,)
        )
    return {
        "table": "projects",
        "column": "slug",
        "record_id": match.group(1),
        "slug": marker,
        "name": marker,
    }


def _json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    try:
        payload = json.loads(stripped)
        if isinstance(payload, dict):
            return payload
    except json.JSONDecodeError:
        pass
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start >= 0 and end > start:
        payload = json.loads(stripped[start : end + 1])
        if isinstance(payload, dict):
            return payload
    raise SystemExit("writer: expected a JSON object, got %r" % (text,))


WRITERS = {
    "state": write_state,
    "verification": write_verification,
    "kanban": write_kanban,
    "projects": write_projects,
}


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Drive one G1-B store through its real Hermes writer."
    )
    parser.add_argument("store", choices=sorted(WRITERS))
    parser.add_argument("marker", help="unique g1b-<store>-<runid>-<n> marker")
    parser.add_argument(
        "--home",
        required=True,
        help="HERMES_HOME of the disposable fixture (must stay under the scratch root)",
    )
    parser.add_argument(
        "--scratch",
        default="",
        help="scratch directory for writer workspaces (defaults to --home)",
    )
    args = parser.parse_args(argv)

    home = os.path.abspath(args.home)
    scratch = os.path.abspath(args.scratch) if args.scratch else home
    os.environ["HERMES_HOME"] = home
    os.environ.pop("HERMES_JOURNAL_MODE", None)

    if not os.path.isdir(home):
        raise SystemExit("writer: fixture home does not exist: %s" % home)

    writer = WRITERS[args.store]
    result = writer(args.marker, home, scratch)

    emit("WRITER_STORE", STORE_DB_NAMES[args.store])
    emit("WRITER_MARKER", args.marker)
    emit("WRITER_HOME", home)
    emit("WRITER_RECORD_TABLE", result["table"])
    emit("WRITER_RECORD_COLUMN", result["column"])
    emit("WRITER_RECORD_ID", result["record_id"])
    for extra in ("title", "slug", "name"):
        if extra in result:
            emit("WRITER_RECORD_%s" % extra.upper(), result[extra])
    emit("WRITER_EXIT", 0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
