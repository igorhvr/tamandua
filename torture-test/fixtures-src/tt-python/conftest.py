"""Shared pytest fixtures and configuration for the schedlib test suite.

Registers the ``flaky_probe`` marker per spec 02. Tests marked with
``@pytest.mark.flaky_probe`` are **skipped by default** so the baseline
suite stays green. The marker is only activated in its designated W4.18
scenario by arming the seed/FLAKY-P1 overlay (which removes the default
skip via a conftest or pytest.ini change).
"""

from datetime import datetime, timedelta, timezone

import pytest


# ── flaky_probe marker registration ───────────────────────────────
# The marker is defined in pyproject.toml [tool.pytest.ini_options.markers].
# The configured default skip is enforced here so that baseline runs stay
# green; the W4.18 scenario overlays a seed that removes this hook.


def pytest_configure(config: pytest.Config) -> None:
    """Register flaky_probe as skipped by default (spec 02 baseline)."""
    config.addinivalue_line(
        "markers",
        "flaky_probe: marks a test as a flaky probe (skipped by default)",
    )


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Skip all tests marked with flaky_probe by default.

    A seed overlay (seeds/FLAKY-P1/) removes or alters this hook to
    activate the flaky behavior for its designated scenario.
    """
    skip_marker = pytest.mark.skip(reason="flaky_probe: skipped by default (baseline)")
    for item in items:
        if item.get_closest_marker("flaky_probe") is not None:
            item.add_marker(skip_marker)


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
