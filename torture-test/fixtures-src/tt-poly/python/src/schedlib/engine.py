"""Core scheduling engine — event model and CRUD operations.

Provides ``Event`` (a dataclass) and ``Schedule`` (a collection with
query, filter, and validation).  Events carry a title, time range,
optional location/description/tags, and a unique identifier.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import uuid4


@dataclass
class Event:
    """A scheduled event with required start/end times.

    Attributes:
        title: Short human-readable name.
        start: Start datetime (must be timezone-aware).
        end: End datetime (must be timezone-aware; must be > start).
        location: Optional location string.
        description: Optional longer description.
        tags: Optional set of string tags for filtering.
        event_id: Auto-generated unique identifier.
    """

    title: str
    start: datetime
    end: datetime
    location: str = ""
    description: str = ""
    tags: set[str] = field(default_factory=set)
    event_id: str = field(default_factory=lambda: uuid4().hex)

    def __post_init__(self) -> None:
        if self.start.tzinfo is None:
            raise ValueError("start must be timezone-aware")
        if self.end.tzinfo is None:
            raise ValueError("end must be timezone-aware")
        if self.end <= self.start:
            raise ValueError(
                f"end ({self.end.isoformat()}) must be after start "
                f"({self.start.isoformat()})"
            )

    @property
    def duration(self) -> timedelta:
        """Return event duration as a timedelta."""
        return self.end - self.start

    def overlaps(self, other: Event) -> bool:
        """Return True if this event overlaps *other* in time."""
        return self.start < other.end and other.start < self.end

    def contains(self, dt: datetime) -> bool:
        """Return True if *dt* falls within [start, end)."""
        return self.start <= dt < self.end

    def __repr__(self) -> str:
        return (
            f"Event(title={self.title!r}, "
            f"start={self.start.isoformat()}, "
            f"end={self.end.isoformat()}, "
            f"id={self.event_id[:8]}…)"
        )


@dataclass
class Schedule:
    """A collection of events with query and validation methods.

    Provides CRUD operations: add, remove, get by id, and query by
    time range, tag, or location.
    """

    events: list[Event] = field(default_factory=list)

    def add(self, event: Event) -> None:
        """Add an event to the schedule.

        Raises ``ValueError`` if an event with the same ID already exists.
        """
        if any(e.event_id == event.event_id for e in self.events):
            raise ValueError(f"duplicate event id: {event.event_id}")
        self.events.append(event)

    def remove(self, event_id: str) -> bool:
        """Remove the event with *event_id*.  Returns True if removed."""
        for i, e in enumerate(self.events):
            if e.event_id == event_id:
                self.events.pop(i)
                return True
        return False

    def get(self, event_id: str) -> Optional[Event]:
        """Return the event with *event_id*, or None."""
        for e in self.events:
            if e.event_id == event_id:
                return e
        return None

    def query_range(self, start: datetime, end: datetime) -> list[Event]:
        """Return all events that overlap [*start*, *end*]."""
        if start.tzinfo is None:
            start = start.replace(tzinfo=timezone.utc)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        return [e for e in self.events if e.start < end and start < e.end]

    def query_tag(self, tag: str) -> list[Event]:
        """Return all events tagged with *tag*."""
        return [e for e in self.events if tag in e.tags]

    def query_location(self, location: str) -> list[Event]:
        """Return all events at *location* (case-insensitive)."""
        loc_lower = location.lower()
        return [e for e in self.events if e.location.lower() == loc_lower]

    @property
    def event_count(self) -> int:
        """Return the number of events in the schedule."""
        return len(self.events)

    def clear(self) -> None:
        """Remove all events."""
        self.events.clear()

    def __iter__(self):
        return iter(self.events)

    def __len__(self) -> int:
        return len(self.events)
