#!/usr/bin/env python3
"""G1-B — prove the `verification_evidence.db` opt-in gate BEFORE the experiment.

`verification_evidence.db` is an OPTIONAL, gated store: with the verify-on-stop
guard OFF the ledger does not even exist and
``agent.verification_evidence.record_verify_run()`` returns ``None`` without
touching disk (``_ledger_enabled()`` short-circuits before ``_connect()``).  A
default session therefore proves NOTHING about this store, so US-004 first
proves the gate:

* OFF   (no ``agent.verify_on_stop`` in config, no ``HERMES_VERIFY_ON_STOP`` in
        the environment): the guard resolves to disabled, the stock writer
        returns ``None``, and the store is ABSENT before AND after the call;
* ON    (``agent.verify_on_stop: true`` in the fixture config): the guard
        resolves to enabled, the writer returns a real event id, and the store
        appears;
* ENV   (only ``HERMES_VERIFY_ON_STOP=1`` in the environment, no config key):
        the documented environment form, same enabled/appears observations.

The evidence table is discovered from ``sqlite_master`` (never hard-coded) by
matching the marker against the store's text columns through a short-lived
READ-ONLY connection (``mode=ro`` + ``PRAGMA query_only=ON``).  This checker
never reads a journal mode: journal format is read ONLY from raw header bytes
18/19 by ``read_header.py``.

Usage::

    g1b_verify_gate.py --home <home> --workspace <dir> --marker <marker> \
        --expect enabled|disabled

Output contract (stable for the shell orchestrator)::

    GATE_HERMES_HOME=/work/gate-off/home
    GATE_DB_PATH=/work/gate-off/home/verification_evidence.db
    GATE_ENV_HERMES_VERIFY_ON_STOP=(unset)|1
    GATE_EXPECT=disabled
    GATE_ENABLED=no
    GATE_ENABLED_MATCHES_EXPECT=yes
    GATE_DB_EXISTS_BEFORE=no
    GATE_RECORD_IS_NONE=yes
    GATE_RECORD_ID=(none)
    GATE_DB_EXISTS_AFTER=no
    GATE_EVIDENCE_TABLES=(absent)|meta,sqlite_sequence,verification_events,...
    GATE_EVIDENCE_TABLE=(none)|verification_events
    GATE_MARKER_MATCHED_TABLES=(none)|verification_events,verification_state
    GATE_EXIT=0

Exit status: 0 when the observations match ``--expect``; 2 when the gate
resolves to the wrong state or the writer's return value is wrong.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path
from typing import Optional

_TEXT_TYPE_RE = ("TEXT", "CHAR", "CLOB", "JSON", "UUID", "VARCHAR")


def quote_ident(name: str) -> str:
    return '"%s"' % name.replace('"', '""')


def discover_tables(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [row[0] for row in rows]


def marker_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    columns = conn.execute("PRAGMA table_info(%s)" % quote_ident(table)).fetchall()
    typed = [
        row[1]
        for row in columns
        if any(token in (row[2] or "").upper() for token in _TEXT_TYPE_RE)
    ]
    return typed or [row[1] for row in columns]


def matched_tables(db_path: Path, marker: str) -> tuple[list[str], list[str]]:
    """Return (all tables, tables holding the marker) via a mode=ro connection."""
    uri = "file:%s?mode=ro" % db_path
    conn = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        conn.execute("PRAGMA query_only=ON")
        tables = discover_tables(conn)
        matched: list[str] = []
        for table in tables:
            columns = marker_columns(conn, table)
            if not columns:
                continue
            predicate = " OR ".join(
                "CAST(%s AS TEXT) = ?" % quote_ident(column) for column in columns
            )
            sql = "SELECT COUNT(*) FROM %s WHERE %s" % (quote_ident(table), predicate)
            count = int(conn.execute(sql, [marker] * len(columns)).fetchone()[0])
            if count:
                matched.append(table)
        return tables, matched
    finally:
        conn.close()


def emit(key: str, value: object) -> None:
    print("%s=%s" % (key, value))


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Prove the verification_evidence.db opt-in gate."
    )
    parser.add_argument("--home", required=True, help="fixture HERMES_HOME")
    parser.add_argument("--workspace", required=True, help="workspace root for the event")
    parser.add_argument("--marker", required=True, help="unique gate-probe marker")
    parser.add_argument(
        "--expect",
        required=True,
        choices=("enabled", "disabled"),
        help="expected guard state",
    )
    args = parser.parse_args(argv)

    home = os.path.abspath(args.home)
    workspace = os.path.abspath(args.workspace)
    os.makedirs(home, exist_ok=True)
    os.makedirs(workspace, exist_ok=True)
    os.environ["HERMES_HOME"] = home

    from hermes_constants import get_hermes_home
    from agent.verification_stop import verify_on_stop_enabled
    from agent.verification_evidence import record_verify_run

    db_path = Path(get_hermes_home()) / "verification_evidence.db"

    emit("GATE_HERMES_HOME", home)
    emit("GATE_DB_PATH", db_path)
    emit(
        "GATE_ENV_HERMES_VERIFY_ON_STOP",
        os.environ.get("HERMES_VERIFY_ON_STOP", "(unset)"),
    )
    emit("GATE_EXPECT", args.expect)
    emit("GATE_MARKER", args.marker)

    enabled = bool(verify_on_stop_enabled())
    emit("GATE_ENABLED", "yes" if enabled else "no")
    expect_enabled = args.expect == "enabled"
    emit(
        "GATE_ENABLED_MATCHES_EXPECT",
        "yes" if enabled == expect_enabled else "no",
    )
    emit("GATE_DB_EXISTS_BEFORE", "yes" if db_path.exists() else "no")

    event = record_verify_run(root=workspace, session_id=args.marker, ok=True)
    emit("GATE_RECORD_IS_NONE", "yes" if event is None else "no")
    emit("GATE_RECORD_ID", (event or {}).get("id", "(none)"))
    emit("GATE_RECORD_SESSION_ID", (event or {}).get("session_id", "(none)"))
    emit("GATE_DB_EXISTS_AFTER", "yes" if db_path.exists() else "no")

    if db_path.exists():
        tables, matched = matched_tables(db_path, args.marker)
        emit("GATE_EVIDENCE_TABLES", ",".join(tables) if tables else "(none)")
        # Prefer an event-shaped table name so the evidence names the ledger row,
        # not the per-session state projection.
        preferred = next((name for name in matched if "event" in name), None)
        chosen = preferred or (matched[0] if matched else "(none)")
        emit("GATE_EVIDENCE_TABLE", chosen)
        emit("GATE_MARKER_MATCHED_TABLES", ",".join(matched) if matched else "(none)")
    else:
        emit("GATE_EVIDENCE_TABLES", "(absent)")
        emit("GATE_EVIDENCE_TABLE", "(none)")
        emit("GATE_MARKER_MATCHED_TABLES", "(none)")

    obs_ok = enabled == expect_enabled
    record_ok = (event is None) if not expect_enabled else (event is not None)
    emit("GATE_EXIT", 0 if (obs_ok and record_ok) else 2)
    return 0 if (obs_ok and record_ok) else 2


if __name__ == "__main__":
    sys.exit(main())
