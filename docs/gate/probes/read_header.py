#!/usr/bin/env python3
"""Read a database file's journal format from raw header bytes only.

SQLite's on-disk header stores the write/read format versions at byte offsets
18 and 19 (the convention the SQLite file-format specification uses: bytes 0-15
are the magic, 16-17 the page size).  For a rollback-journal database both are
``1``; for a write-ahead-log database both are ``2``.

This probe deliberately does **not** open the database through the SQLite
library.  Even a read-only connection can checkpoint a WAL and thereby change
the very bytes we are measuring.  It opens the file in binary mode, reads
exactly the first 20 header bytes, hashes the file for preservation evidence,
and prints one JSON object.

Usage:
    read_header.py <path>

Output keys: path, size, sha256, byte18, byte19, mode.

Mode values:
    delete         bytes 18/19 == 1/1
    wal            bytes 18/19 == 2/2
    unknown(a/b)   any other version pair on a valid container
    not-a-database the 16-byte magic is not ``SQLite format 3\\0``
    short          the file is shorter than the 20-byte header

Exit status:
    0  valid database container (including unknown version pairs)
    2  missing/unreadable file, short file, or non-database file
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import Optional

SQLITE_MAGIC = b"SQLite format 3\x00"
HEADER_BYTES = 20
CHUNK_SIZE = 1024 * 1024


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_SIZE), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _mode(header: bytes, byte18: Optional[int], byte19: Optional[int]) -> str:
    if len(header) < HEADER_BYTES:
        return "short"
    if header[:16] != SQLITE_MAGIC:
        return "not-a-database"
    if byte18 is None or byte19 is None:
        return "short"
    if byte18 == 1 and byte19 == 1:
        return "delete"
    if byte18 == 2 and byte19 == 2:
        return "wal"
    return "unknown(%d/%d)" % (byte18, byte19)


def inspect(path: str) -> dict:
    """Return the header report for *path* and whether the file is valid."""
    size = os.path.getsize(path)
    with open(path, "rb") as handle:
        header = handle.read(HEADER_BYTES)

    byte18 = header[18] if len(header) >= 19 else None
    byte19 = header[19] if len(header) >= 20 else None
    mode = _mode(header, byte18, byte19)

    report = {
        "path": os.path.realpath(path),
        "size": size,
        "sha256": _sha256(path),
        "byte18": byte18,
        "byte19": byte19,
        "mode": mode,
    }
    valid = len(header) >= HEADER_BYTES and header[:16] == SQLITE_MAGIC
    return {"report": report, "valid": valid}


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Read SQLite journal format from raw header bytes 18/19 (no database connection)."
    )
    parser.add_argument("path", help="database file to inspect")
    args = parser.parse_args(argv)

    try:
        result = inspect(args.path)
    except OSError as exc:
        print(json.dumps({"path": os.path.realpath(args.path), "error": str(exc)}, sort_keys=True))
        print("read_header: cannot read %s: %s" % (args.path, exc), file=sys.stderr)
        return 2

    print(json.dumps(result["report"], sort_keys=False))
    return 0 if result["valid"] else 2


if __name__ == "__main__":
    sys.exit(main())
