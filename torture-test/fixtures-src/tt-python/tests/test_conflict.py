"""Tests for schedlib.conflict — overlap detection and resolution."""

from datetime import datetime, timedelta, timezone

from schedlib.conflict import (
    ConflictSeverity,
    conflict_severity,
    detect_overlap,
    find_conflicts,
    has_conflicts,
    overlap_interval,
    suggest_reschedule,
    suggest_shorten,
)
from schedlib.engine import Event, Schedule

UTC = timezone.utc


def _ev(title: str, start_h: int, end_h: int, start_m: int = 0, end_m: int = 0) -> Event:
    return Event(
        title=title,
        start=datetime(2026, 7, 30, start_h, start_m, tzinfo=UTC),
        end=datetime(2026, 7, 30, end_h, end_m, tzinfo=UTC),
    )


# ── detect_overlap ─────────────────────────────────────────────────


class TestDetectOverlap:
    def test_no_overlap_adjacent(self) -> None:
        a = _ev("A", 9, 10)
        b = _ev("B", 10, 11)
        assert detect_overlap(a, b) is False

    def test_overlap_partial(self) -> None:
        a = _ev("A", 9, 10)
        b = _ev("B", 9, 10, start_m=30, end_m=30)
        assert detect_overlap(a, b) is True

    def test_contained(self) -> None:
        a = _ev("A", 9, 12)
        b = _ev("B", 10, 11)
        assert detect_overlap(a, b) is True


# ── overlap_interval ───────────────────────────────────────────────


class TestOverlapInterval:
    def test_returns_none_for_non_overlap(self) -> None:
        a = _ev("A", 9, 10)
        b = _ev("B", 11, 12)
        assert overlap_interval(a, b) is None

    def test_returns_correct_interval(self) -> None:
        a = _ev("A", 9, 11)
        b = _ev("B", 10, 12)
        start, end = overlap_interval(a, b)
        assert start == datetime(2026, 7, 30, 10, 0, tzinfo=UTC)
        assert end == datetime(2026, 7, 30, 11, 0, tzinfo=UTC)


# ── conflict_severity ──────────────────────────────────────────────


class TestConflictSeverity:
    def test_none_for_non_overlap(self) -> None:
        assert conflict_severity(_ev("A", 9, 10), _ev("B", 11, 12)) == ConflictSeverity.NONE

    def test_soft_for_short_overlap(self) -> None:
        a = Event("A", datetime(2026, 7, 30, 10, 0, tzinfo=UTC), datetime(2026, 7, 30, 11, 0, tzinfo=UTC))
        b = Event("B", datetime(2026, 7, 30, 10, 50, tzinfo=UTC), datetime(2026, 7, 30, 11, 30, tzinfo=UTC))
        assert conflict_severity(a, b) == ConflictSeverity.SOFT

    def test_hard_for_long_overlap(self) -> None:
        a = _ev("A", 9, 11)
        b = _ev("B", 10, 12)
        assert conflict_severity(a, b) == ConflictSeverity.HARD

    def test_contained_when_one_inside_other(self) -> None:
        a = _ev("A", 9, 12)
        b = _ev("B", 10, 11)
        assert conflict_severity(a, b) == ConflictSeverity.CONTAINED

    def test_contained_equal_bounds(self) -> None:
        a = _ev("A", 10, 11)
        b = _ev("B", 10, 11)
        assert conflict_severity(a, b) == ConflictSeverity.CONTAINED


# ── find_conflicts ─────────────────────────────────────────────────


class TestFindConflicts:
    def test_no_conflicts(self) -> None:
        events = [_ev("A", 9, 10), _ev("B", 11, 12), _ev("C", 14, 15)]
        assert find_conflicts(events) == []

    def test_one_conflict(self) -> None:
        events = [_ev("A", 9, 10), _ev("B", 9, 10, start_m=30, end_m=30)]
        conflicts = find_conflicts(events)
        assert len(conflicts) == 1
        assert conflicts[0].event_a.title == "A"
        assert conflicts[0].event_b.title == "B"

    def test_multiple_conflicts(self) -> None:
        events = [_ev("A", 9, 11), _ev("B", 10, 12), _ev("C", 11, 13, start_m=30)]
        conflicts = find_conflicts(events)
        assert len(conflicts) == 2  # A-B and B-C

    def test_has_conflicts_true(self) -> None:
        events = [_ev("A", 9, 10), _ev("B", 9, 11, start_m=30)]
        assert has_conflicts(events) is True

    def test_has_conflicts_false(self) -> None:
        events = [_ev("A", 9, 10), _ev("B", 11, 12)]
        assert has_conflicts(events) is False


# ── suggest_reschedule ─────────────────────────────────────────────


class TestSuggestReschedule:
    def test_finds_slots_in_empty_schedule(self) -> None:
        event = _ev("A", 9, 10)
        slots = suggest_reschedule(event, [])
        assert len(slots) > 0

    def test_avoids_existing_event(self) -> None:
        existing = _ev("B", 9, 10)
        event = _ev("A", 9, 10)
        slots = suggest_reschedule(event, [existing])
        # None of the slots should overlap with existing
        for s, e in slots:
            assert not (s < existing.end and existing.start < e)


# ── suggest_shorten ────────────────────────────────────────────────


class TestSuggestShorten:
    def test_shortens_event(self) -> None:
        event = _ev("A", 9, 11)
        shortened = suggest_shorten(event, timedelta(hours=1))
        assert shortened.start == event.start
        assert shortened.duration == timedelta(hours=1)
        assert shortened.end == event.start + timedelta(hours=1)

    def test_preserves_metadata(self) -> None:
        event = Event(
            title="Meeting",
            start=datetime(2026, 7, 30, 9, 0, tzinfo=UTC),
            end=datetime(2026, 7, 30, 11, 0, tzinfo=UTC),
            location="Room A",
            tags={"important"},
        )
        shortened = suggest_shorten(event, timedelta(minutes=30))
        assert shortened.title == "Meeting"
        assert shortened.location == "Room A"
        assert shortened.tags == {"important"}
