"""Shared pytest fixtures and configuration for the schedlib test suite.

Registers the ``flaky_probe`` marker per spec 02.  THIS IS THE ARMED
VARIANT — the ``pytest_collection_modifyitems`` default-skip hook has
been **removed**, so tests marked ``@pytest.mark.flaky_probe`` will
execute (and the deterministic alternator will fail on every second
invocation).

This file is applied via the ``seeds/FLAKY-P1/`` overlay when scenario
W4.18 is armed.
"""

from datetime import datetime, timedelta, timezone

import pytest


# ── flaky_probe marker registration ───────────────────────────────
# The marker is defined in pyproject.toml [tool.pytest.ini_options.markers].
# The baseline conftest.py skips flaky_probe tests by default; this
# armed variant intentionally omits that skip so the deterministic
# alternator runs.


def pytest_configure(config: pytest.Config) -> None:
    """Register flaky_probe as an active marker (not skipped)."""
    config.addinivalue_line(
        "markers",
        "flaky_probe: marks a test as a flaky probe (ARMED — not skipped)",
    )


def pytest_sessionfinish(session: pytest.Session, exitstatus: int) -> None:
    """Remove pytest's auto-generated .gitignore from the cache dir.

    pytest auto-creates a ``.pytest_cache/.gitignore`` file that masks the
    directory from ``git status``.  Deleting it after every run keeps
    ``.pytest_cache/`` visible as untracked junk — a load-bearing probe
    per spec 02.
    """
    import os

    cache_gitignore = os.path.join(
        os.path.dirname(__file__), ".pytest_cache", ".gitignore"
    )
    if os.path.exists(cache_gitignore):
        os.remove(cache_gitignore)


# ── shared fixtures ────────────────────────────────────────────────


@pytest.fixture
def utc_now() -> datetime:
    """Return a fixed UTC datetime for deterministic test anchors."""
    return datetime(2026, 7, 1, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def sample_events(utc_now: datetime) -> list[dict]:
    """Return a fixed set of sample event dicts anchored at utc_now."""
    d = utc_now
    return [
        {
            "title": "Morning Standup",
            "start": d + timedelta(hours=9),
            "end": d + timedelta(hours=9, minutes=30),
            "location": "Room A",
        },
        {
            "title": "Project Review",
            "start": d + timedelta(hours=10),
            "end": d + timedelta(hours=11),
            "location": "Room B",
        },
        {
            "title": "Lunch Break",
            "start": d + timedelta(hours=12),
            "end": d + timedelta(hours=13),
            "location": "",
        },
        {
            "title": "Afternoon Workshop",
            "start": d + timedelta(hours=14),
            "end": d + timedelta(hours=16),
            "location": "Room A",
        },
    ]
