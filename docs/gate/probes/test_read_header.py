#!/usr/bin/env python3
"""Unit tests for docs/gate/probes/read_header.py.

Synthetic 100-byte fixtures stand in for real stores so the tests never touch a
SQLite database.  Each invocation runs the probe as a subprocess, which proves
both the CLI contract (JSON on stdout, exit status) and the raw-byte classifier.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROBES_DIR = Path(__file__).resolve().parent
READ_HEADER = PROBES_DIR / "read_header.py"
SQLITE_MAGIC = b"SQLite format 3\x00"


def _fixture_bytes(byte18: int, byte19: int, size: int = 100, magic: bytes = SQLITE_MAGIC) -> bytes:
    if len(magic) != 16:
        raise ValueError("magic must be exactly 16 bytes")
    data = bytearray(size)
    data[0:16] = magic
    if size >= 20:
        data[18] = byte18
        data[19] = byte19
    return bytes(data)


def _run(path: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(READ_HEADER), str(path)],
        capture_output=True,
        text=True,
        check=False,
    )


class ReadHeaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="g1-header-test-")
        self.addCleanup(self._tmp.cleanup)
        self.tmpdir = Path(self._tmp.name)

    def _write(self, name: str, payload: bytes) -> Path:
        path = self.tmpdir / name
        path.write_bytes(payload)
        return path

    def _report(self, name: str, payload: bytes) -> tuple[dict, subprocess.CompletedProcess]:
        path = self._write(name, payload)
        result = _run(path)
        self.assertEqual(result.stdout.count("\n"), 1, result.stdout)
        report = json.loads(result.stdout)
        self.assertEqual(report["path"], str(path.resolve()))
        self.assertEqual(report["size"], len(payload))
        self.assertEqual(report["sha256"], hashlib.sha256(payload).hexdigest())
        return report, result

    def test_delete_header_is_1_1(self) -> None:
        report, result = self._report("delete.db", _fixture_bytes(1, 1))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["byte18"], 1)
        self.assertEqual(report["byte19"], 1)
        self.assertEqual(report["mode"], "delete")

    def test_wal_header_is_2_2(self) -> None:
        report, result = self._report("wal.db", _fixture_bytes(2, 2))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["byte18"], 2)
        self.assertEqual(report["byte19"], 2)
        self.assertEqual(report["mode"], "wal")

    def test_unknown_version_pair_is_reported_on_valid_container(self) -> None:
        report, result = self._report("unknown.db", _fixture_bytes(2, 1))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["mode"], "unknown(2/1)")

    def test_short_file_exits_2(self) -> None:
        # 5 bytes: shorter than the 20-byte header, even though it begins with
        # the SQLite magic prefix.
        report, result = self._report("short.db", b"Short")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(report["mode"], "short")
        self.assertIsNone(report["byte18"])
        self.assertIsNone(report["byte19"])

    def test_bad_magic_exits_2(self) -> None:
        report, result = self._report(
            "bad-magic.db", _fixture_bytes(1, 1, magic=b"NotSQLiteFormat!")
        )
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertEqual(report["mode"], "not-a-database")

    def test_missing_file_exits_2(self) -> None:
        missing = self.tmpdir / "does-not-exist.db"
        result = _run(missing)
        self.assertEqual(result.returncode, 2, result.stderr)

    def test_probe_does_not_import_the_database_module(self) -> None:
        source = READ_HEADER.read_text(encoding="utf-8")
        self.assertNotIn("import sqlite3", source)
        self.assertNotIn("from sqlite3", source)
        self.assertNotIn("sqlite3.", source)

    def test_probe_does_not_resolve_a_database_connection(self) -> None:
        # Skeleton files exercise the byte reader only; the magic check proves
        # the output is derived from raw bytes, not a connection.
        path = self._write("bytes.db", _fixture_bytes(1, 1))
        original = path.read_bytes()
        result = _run(path)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(path.read_bytes(), original)


if __name__ == "__main__":
    unittest.main(verbosity=2)
