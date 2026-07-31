"""Tests for schedlib.engine — Event model and Schedule CRUD."""

from datetime import datetime, timedelta, timezone

import pytest

from schedlib.engine import Event, Schedule

UTC = timezone.utc


# ── Event ──────────────────────────────────────────────────────────


class TestEvent:
    def test_creation_basic(self) -> None:
        e = Event(
            title="Meeting",
            start=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
            end=datetime(2026, 7, 30, 11, 0, tzinfo=UTC),
        )
        assert e.title == "Meeting"
        assert e.duration == timedelta(hours=1)
        assert e.event_id  # auto-generated

    def test_creation_with_optional_fields(self) -> None:
        e = Event(
            title="Workshop",
            start=datetime(2026, 7, 30, 14, 0, tzinfo=UTC),
            end=datetime(2026, 7, 30, 16, 0, tzinfo=UTC),
            location="Room B",
            description="A hands-on workshop",
            tags={"training", "optional"},
        )
        assert e.location == "Room B"
        assert "training" in e.tags
        assert e.description == "A hands-on workshop"

    def test_rejects_naive_start(self) -> None:
        with pytest.raises(ValueError, match="timezone-aware"):
            Event(
                title="Bad",
                start=datetime(2026, 7, 30, 10, 0),  # naive
                end=datetime(2026, 7, 30, 11, 0, tzinfo=UTC),
            )

    def test_rejects_naive_end(self) -> None:
        with pytest.raises(ValueError, match="timezone-aware"):
            Event(
                title="Bad",
                start=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 11, 0),  # naive
            )

    def test_rejects_end_before_start(self) -> None:
        with pytest.raises(ValueError, match="must be after"):
            Event(
                title="Bad",
                start=datetime(2026, 7, 30, 11, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
            )

    def test_rejects_end_equals_start(self) -> None:
        with pytest.raises(ValueError):
            Event(
                title="Zero-length",
                start=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
                end=datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
            )

    def test_overlaps_true(self) -> None:
        a = Event("A", datetime(2026, 7, 30, 10, 0, tzinfo=UTC), datetime(2026, 7, 30, 11, 0, tzinfo=UTC))
        b = Event("B", datetime(2026, 7, 30, 10, 30, tzinfo=UTC), datetime(2026, 7, 30, 11, 30, tzinfo=UTC))
        assert a.overlaps(b) is True
        assert b.overlaps(a) is True

    def test_overlaps_false_adjacent(self) -> None:
        a = Event("A", datetime(2026, 7, 30, 10, 0, tzinfo=UTC), datetime(2026, 7, 30, 11, 0, tzinfo=UTC))
        b = Event("B", datetime(2026, 7, 30, 11, 0, tzinfo=UTC), datetime(2026, 7, 30, 12, 0, tzinfo=UTC))
        assert a.overlaps(b) is False  # back-to-back, no overlap

    def test_overlaps_false_disjoint(self) -> None:
        a = Event("A", datetime(2026, 7, 30, 9, 0, tzinfo=UTC), datetime(2026, 7, 30, 10, 0, tzinfo=UTC))
        b = Event("B", datetime(2026, 7, 30, 14, 0, tzinfo=UTC), datetime(2026, 7, 30, 15, 0, tzinfo=UTC))
        assert a.overlaps(b) is False

    def test_contains_inside(self) -> None:
        e = Event("E", datetime(2026, 7, 30, 10, 0, tzinfo=UTC), datetime(2026, 7, 30, 11, 0, tzinfo=UTC))
        assert e.contains(datetime(2026, 7, 30, 10, 30, tzinfo=UTC)) is True

    def test_contains_at_start(self) -> None:
        e = Event("E", datetime(2026, 7, 30, 10, 0, tzinfo=UTC), datetime(2026, 7, 30, 11, 0, tzinfo=UTC))
        assert e.contains(datetime(2026, 7, 30, 10, 0, tzinfo=UTC)) is True

    def test_contains_at_end(self) -> None:
        e = Event("E", datetime(2026, 7, 30, 10, 0, tzinfo=UTC), datetime(2026, 7, 30, 11, 0, tzinfo=UTC))
        assert e.contains(datetime(2026, 7, 30, 11, 0, tzinfo=UTC)) is False

    def test_duration(self) -> None:
        e = Event("E", datetime(2026, 7, 30, 9, 0, tzinfo=UTC), datetime(2026, 7, 30, 17, 0, tzinfo=UTC))
        assert e.duration == timedelta(hours=8)


# ── Schedule ───────────────────────────────────────────────────────


class TestSchedule:
    def _mk_event(self, title: str, start_h: int, end_h: int, location: str = "") -> Event:
        return Event(
            title=title,
            start=datetime(2026, 7, 30, start_h, 0, tzinfo=UTC),
            end=datetime(2026, 7, 30, end_h, 0, tzinfo=UTC),
            location=location,
        )

    def test_empty_schedule(self) -> None:
        s = Schedule()
        assert s.event_count == 0
        assert len(s) == 0

    def test_add_and_count(self) -> None:
        s = Schedule()
        s.add(self._mk_event("A", 9, 10))
        s.add(self._mk_event("B", 11, 12))
        assert s.event_count == 2

    def test_add_duplicate_id_raises(self) -> None:
        s = Schedule()
        e = self._mk_event("A", 9, 10)
        s.add(e)
        with pytest.raises(ValueError, match="duplicate"):
            s.add(e)

    def test_remove_existing(self) -> None:
        s = Schedule()
        e = self._mk_event("A", 9, 10)
        s.add(e)
        assert s.remove(e.event_id) is True
        assert s.event_count == 0

    def test_remove_nonexistent(self) -> None:
        s = Schedule()
        assert s.remove("nonexistent") is False

    def test_get_existing(self) -> None:
        s = Schedule()
        e = self._mk_event("A", 9, 10)
        s.add(e)
        assert s.get(e.event_id) is e

    def test_get_nonexistent(self) -> None:
        s = Schedule()
        assert s.get("nonexistent") is None

    def test_query_range_exact(self) -> None:
        s = Schedule()
        e = self._mk_event("A", 10, 11)
        s.add(e)
        results = s.query_range(
            datetime(2026, 7, 30, 10, 0, tzinfo=UTC),
            datetime(2026, 7, 30, 11, 0, tzinfo=UTC),
        )
        assert len(results) == 1

    def test_query_range_partial(self) -> None:
        s = Schedule()
        s.add(self._mk_event("A", 9, 10))
        s.add(self._mk_event("B", 11, 12))
        s.add(self._mk_event("C", 14, 15))
        results = s.query_range(
            datetime(2026, 7, 30, 10, 30, tzinfo=UTC),
            datetime(2026, 7, 30, 14, 0, tzinfo=UTC),
        )
        assert len(results) == 1  # only B

    def test_query_range_none(self) -> None:
        s = Schedule()
        s.add(self._mk_event("A", 9, 10))
        results = s.query_range(
            datetime(2026, 7, 30, 14, 0, tzinfo=UTC),
            datetime(2026, 7, 30, 15, 0, tzinfo=UTC),
        )
        assert len(results) == 0

    def test_query_tag(self) -> None:
        s = Schedule()
        e1 = Event("A", datetime(2026, 7, 30, 9, 0, tzinfo=UTC), datetime(2026, 7, 30, 10, 0, tzinfo=UTC), tags={"urgent"})
        e2 = Event("B", datetime(2026, 7, 30, 11, 0, tzinfo=UTC), datetime(2026, 7, 30, 12, 0, tzinfo=UTC), tags={"optional"})
        s.add(e1)
        s.add(e2)
        assert len(s.query_tag("urgent")) == 1
        assert len(s.query_tag("nonexistent")) == 0

    def test_query_location_case_insensitive(self) -> None:
        s = Schedule()
        s.add(self._mk_event("A", 9, 10, location="Room A"))
        s.add(self._mk_event("B", 11, 12, location="room a"))
        results = s.query_location("Room A")
        assert len(results) == 2

    def test_clear(self) -> None:
        s = Schedule()
        s.add(self._mk_event("A", 9, 10))
        s.add(self._mk_event("B", 11, 12))
        s.clear()
        assert s.event_count == 0

    def test_iteration(self) -> None:
        s = Schedule()
        s.add(self._mk_event("A", 9, 10))
        s.add(self._mk_event("B", 11, 12))
        titles = [e.title for e in s]
        assert titles == ["A", "B"]
