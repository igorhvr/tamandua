"""Threshold performance tests for schedlib scheduling operations.

These tests measure that scheduling operations on large inputs
complete within reasonable time limits.  A performance regression
(e.g., an O(n²) algorithm where O(n log n) is expected) will cause
these threshold tests to fail.
"""

import time

from datetime import datetime, timedelta, timezone

from schedlib.conflict import find_available_slots
from schedlib.engine import Event

UTC = timezone.utc


class TestFindAvailableSlotsCorrectness:
    """Correctness tests for find_available_slots on small inputs."""

    def test_empty_schedule_returns_whole_window(self) -> None:
        slots = find_available_slots(
            [],
            timedelta(hours=1),
            datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
            datetime(2026, 7, 30, 17, 0, tzinfo=UTC),
        )
        assert slots == [
            (datetime(2026, 7, 30, 9, 0, tzinfo=UTC), datetime(2026, 7, 30, 17, 0, tzinfo=UTC))
        ]

    def test_no_slot_when_duration_too_large(self) -> None:
        e = Event(
            title="Busy",
            start=datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
            end=datetime(2026, 7, 30, 17, 0, tzinfo=UTC),
        )
        slots = find_available_slots(
            [e],
            timedelta(hours=9),  # longer than the whole window
            datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
            datetime(2026, 7, 30, 17, 0, tzinfo=UTC),
        )
        assert slots == []

    def test_slots_between_events(self) -> None:
        events = [
            Event(
                title="A",
                start=datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
            ),
            Event(
                title="B",
                start=datetime(2026, 7, 30, 12, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 13, 0, tzinfo=UTC),
            ),
        ]
        slots = find_available_slots(
            events,
            timedelta(hours=1),
            datetime(2026, 7, 30, 8, 0, tzinfo=UTC),
            datetime(2026, 7, 30, 17, 0, tzinfo=UTC),
        )
        # Expected: 8-9, 10-12, 13-17
        assert len(slots) == 3
        assert slots[0] == (datetime(2026, 7, 30, 8, 0, tzinfo=UTC), datetime(2026, 7, 30, 9, 0, tzinfo=UTC))
        assert slots[1] == (datetime(2026, 7, 30, 10, 0, tzinfo=UTC), datetime(2026, 7, 30, 12, 0, tzinfo=UTC))

    def test_overlapping_events_merged(self) -> None:
        events = [
            Event(
                title="A",
                start=datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 11, 0, tzinfo=UTC),
            ),
            Event(
                title="B",
                start=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 12, 0, tzinfo=UTC),
            ),
        ]
        slots = find_available_slots(
            events,
            timedelta(hours=1),
            datetime(2026, 7, 30, 8, 0, tzinfo=UTC),
            datetime(2026, 7, 30, 17, 0, tzinfo=UTC),
        )
        # Overlapping events merged: busy 9-12, so free: 8-9, 12-17
        assert len(slots) == 2
        assert slots[0] == (datetime(2026, 7, 30, 8, 0, tzinfo=UTC), datetime(2026, 7, 30, 9, 0, tzinfo=UTC))
        assert slots[1] == (datetime(2026, 7, 30, 12, 0, tzinfo=UTC), datetime(2026, 7, 30, 17, 0, tzinfo=UTC))

    def test_events_outside_window_ignored(self) -> None:
        events = [
            Event(
                title="A",
                start=datetime(2026, 7, 30, 7, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 8, 0, tzinfo=UTC),
            ),
            Event(
                title="B",
                start=datetime(2026, 7, 30, 18, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 19, 0, tzinfo=UTC),
            ),
        ]
        slots = find_available_slots(
            events,
            timedelta(hours=1),
            datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
            datetime(2026, 7, 30, 17, 0, tzinfo=UTC),
        )
        assert slots == [
            (datetime(2026, 7, 30, 9, 0, tzinfo=UTC), datetime(2026, 7, 30, 17, 0, tzinfo=UTC))
        ]

    def test_exact_fit_slot(self) -> None:
        e = Event(
            title="A",
            start=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
            end=datetime(2026, 7, 30, 11, 0, tzinfo=UTC),
        )
        slots = find_available_slots(
            [e],
            timedelta(hours=1),
            datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
            datetime(2026, 7, 30, 11, 0, tzinfo=UTC),
        )
        # 9-10 fits exactly
        assert len(slots) == 1
        assert slots[0] == (datetime(2026, 7, 30, 9, 0, tzinfo=UTC), datetime(2026, 7, 30, 10, 0, tzinfo=UTC))


class TestFindAvailableSlotsThreshold:
    """Threshold test: 10,000 events must be processed under 2 seconds.

    This is the performance gate for POLY-BUG-P4 (A4 archetype).  An
    O(n²) implementation will fail this test; the correct O(n log n)
    implementation completes in milliseconds.
    """

    def test_large_event_set_completes_quickly(self) -> None:
        n_events = 10_000
        events: list[Event] = []
        window_start = datetime(2026, 7, 30, 8, 0, tzinfo=UTC)
        # Each event is 1 minute, tightly packed with 1-minute gaps
        for i in range(n_events):
            s = window_start + timedelta(minutes=2 * i)
            e = s + timedelta(minutes=1)
            events.append(Event(title=f"E{i}", start=s, end=e))

        window_end = window_start + timedelta(minutes=2 * n_events)
        duration = timedelta(minutes=1)

        start = time.perf_counter()
        slots = find_available_slots(events, duration, window_start, window_end)
        elapsed = time.perf_counter() - start

        # With tightly-packed 1-min events and 1-min gaps, we expect
        # ~10,000 slots (one gap between each event)
        assert len(slots) == n_events

        # Threshold: must complete in under 2 seconds.  The O(n log n)
        # implementation should take well under 100ms on any modern CPU.
        assert elapsed < 2.0, (
            f"Threshold test failed: {n_events} events took {elapsed:.3f}s "
            f"(limit: 2.0s).  Possible performance regression."
        )
