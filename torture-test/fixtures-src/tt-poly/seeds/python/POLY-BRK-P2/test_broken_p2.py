"""Broken test POLY-BRK-P2 — assertion failure: expected conflict count mismatch.

This is a genuinely failing test used by quarantine workflow scenarios.
The test expects the wrong number of conflicts. Different failure pattern
from POLY-BRK-P1 (integer count mismatch vs date value mismatch).
"""

from datetime import datetime, timezone

from schedlib.conflict import find_conflicts
from schedlib.engine import Event

UTC = timezone.utc


class TestBrokenP2:
    """Broken assertion: conflict count mismatch."""

    def test_conflicts_among_overlapping_events(self) -> None:
        """Fails: the assertion expects the wrong number of conflicts."""
        events = [
            Event(
                title="Morning Standup",
                start=datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
            ),
            Event(
                title="Design Review",
                start=datetime(2026, 7, 30, 9, 30, tzinfo=UTC),
                end=datetime(2026, 7, 30, 11, 0, tzinfo=UTC),  # overlaps Morning Standup
            ),
            Event(
                title="Sprint Planning",
                start=datetime(2026, 7, 30, 10, 30, tzinfo=UTC),
                end=datetime(2026, 7, 30, 12, 0, tzinfo=UTC),  # overlaps Design Review
            ),
            Event(
                title="Lunch Break",
                start=datetime(2026, 7, 30, 12, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 13, 0, tzinfo=UTC),  # no overlap (adjacent)
            ),
        ]

        conflicts = find_conflicts(events)

        # 2 conflicts: Standup↔Review, Review↔Planning. Lunch has none.
        assert len(conflicts) == 1  # BROKEN: should be 2

    def test_no_conflicts_in_empty_list(self) -> None:
        """Fails: expected non-zero conflicts for empty list."""
        conflicts = find_conflicts([])
        assert len(conflicts) == 1  # BROKEN: should be 0

    def test_non_overlapping_events_have_no_conflicts(self) -> None:
        """Fails: expects conflict count for non-overlapping events."""
        events = [
            Event(
                title="Quick Sync",
                start=datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 9, 30, tzinfo=UTC),
            ),
            Event(
                title="Deep Work",
                start=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 12, 0, tzinfo=UTC),
            ),
        ]

        conflicts = find_conflicts(events)
        assert len(conflicts) == 1  # BROKEN: should be 0
