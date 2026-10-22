#!/usr/bin/env python3
"""G1-B — read-only persistence checker for the fixture stores.

This is the bead's *identifiable-record* assertion.  After a writer has closed,
a SEPARATE short-lived read-only connection asks whether the specific marker
that writer produced is present (and, in a baseline run, that a marker which was
never written is absent).  A listing that opens, an opener that returns
normally, or unchanged header bytes are weaker evidence and are never used as a
substitute.

Rules encoded here:

* the connection is opened as ``sqlite3.connect('file:<path>?mode=ro', uri=True)``
  and additionally pinned with ``PRAGMA query_only=ON`` — this checker cannot
  write a row even if the file permissions would allow it;
* table names are DISCOVERED from ``sqlite_master`` (nothing is hard-coded);
* the marker is matched against the table's text columns, and the EXACT SQL text
  that ran is printed next to its row count;
* it never reads a journal mode.  Journal format is read only from raw header
  bytes 18/19 by ``read_header.py``; a connection (even read-only) can checkpoint
  a WAL and disturb the bytes being measured.

Usage::

    g1b_readonly.py --db <store path> --marker <g1b-... marker>

Output contract (stable for the shell orchestrator and its evidence file)::

    READONLY_DB=/work/homes/state/state.db
    READONLY_OPEN_URI=file:/work/homes/state/state.db?mode=ro
    READONLY_MARKER=g1b-state-<runid>-1
    READONLY_TABLES=sessions,messages,...
    READONLY_TABLE_COUNT table=sessions count=1
    READONLY_SQL table=sessions: SELECT COUNT(*) FROM "sessions" WHERE ...
    READONLY_MATCH_COUNT_TOTAL=1
    READONLY_MATCHED_TABLES=sessions

Exit status: 0 when the store was readable and the counts were printed; 2 when
the file is missing, unreadable, empty of tables, or not a SQLite database.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from typing import Optional

# Columns whose declared type can hold the marker text; a table with no declared
# text-ish column falls back to every column cast to TEXT.
_TEXT_TYPE_RE = (
    "TEXT",
    "CHAR",
    "CLOB",
    "JSON",
    "UUID",
    "VARCHAR",
)


def quote_ident(name: str) -> str:
    return '"%s"' % name.replace('"', '""')


def table_names(conn: sqlite3.Connection) -> list[str]:
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [row[0] for row in rows]


def table_columns(conn: sqlite3.Connection, table: str) -> list[tuple[str, str]]:
    rows = conn.execute("PRAGMA table_info(%s)" % quote_ident(table)).fetchall()
    return [(row[1], row[2] or "") for row in rows]


def marker_columns(columns: list[tuple[str, str]]) -> list[str]:
    typed = [
        name
        for name, declared in columns
        if any(token in (declared or "").upper() for token in _TEXT_TYPE_RE)
    ]
    if typed:
        return typed
    return [name for name, _ in columns]


def build_sql(table: str, columns: list[str]) -> str:
    predicate = " OR ".join(
        "CAST(%s AS TEXT) = ?" % quote_ident(column) for column in columns
    )
    return 'SELECT COUNT(*) FROM %s WHERE %s' % (quote_ident(table), predicate)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Count marker-matched rows in a fixture store via a read-only connection."
    )
    parser.add_argument("--db", required=True, help="fixture store path")
    parser.add_argument("--marker", required=True, help="unique marker to look for")
    args = parser.parse_args(argv)

    db_path = os.path.realpath(args.db)
    if not os.path.isfile(db_path):
        print("READONLY_ERROR=missing:%s" % db_path)
        return 2

    uri = "file:%s?mode=ro" % db_path
    print("READONLY_DB=%s" % db_path)
    print("READONLY_OPEN_URI=%s" % uri)
    print("READONLY_MARKER=%s" % args.marker)

    try:
        conn = sqlite3.connect(uri, uri=True, timeout=30)
    except sqlite3.Error as exc:
        print("READONLY_ERROR=connect:%s" % exc)
        return 2

    try:
        conn.execute("PRAGMA query_only=ON")
        tables = table_names(conn)
        if not tables:
            print("READONLY_ERROR=no-tables")
            return 2
        print("READONLY_TABLES=%s" % ",".join(tables))

        total = 0
        matched: list[str] = []
        for table in tables:
            columns = marker_columns(table_columns(conn, table))
            if not columns:
                print("READONLY_TABLE_COUNT table=%s count=0" % table)
                print("READONLY_SQL table=%s: (no columns)" % table)
                continue
            sql = build_sql(table, columns)
            try:
                count = int(conn.execute(sql, [args.marker] * len(columns)).fetchone()[0])
            except sqlite3.Error as exc:
                print("READONLY_ERROR=query:%s:%s" % (table, exc))
                return 2
            total += count
            if count:
                matched.append(table)
            print("READONLY_TABLE_COUNT table=%s count=%d" % (table, count))
            print("READONLY_SQL table=%s: %s" % (table, sql))

        print("READONLY_MATCH_COUNT_TOTAL=%d" % total)
        print("READONLY_MATCHED_TABLES=%s" % (",".join(matched) if matched else "(none)"))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
