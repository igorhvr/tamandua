"""Conflict detection and resolution for scheduled events.

Detects overlapping events, categorizes conflict severity, and
provides resolution suggestions (reschedule, shorten, cancel).
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional

from .engine import Event


class ConflictSeverity(Enum):
    """Severity of an event conflict."""

    NONE = "none"           # No overlap
    SOFT = "soft"           # Overlap ≤ 15 minutes (minor)
    HARD = "hard"           # Overlap > 15 minutes (significant)
    CONTAINED = "contained"  # One event fully contains the other


@dataclass
class Conflict:
    """Describes a conflict between two events.

    Attributes:
        event_a: First event.
        event_b: Second event.
        severity: How severe the overlap is.
        overlap_start: When the overlap begins.
        overlap_end: When the overlap ends.
        overlap_duration: Duration of the overlap.
    """

    event_a: Event
    event_b: Event
    severity: ConflictSeverity
    overlap_start: datetime
    overlap_end: datetime

    @property
    def overlap_duration(self) -> timedelta:
        """Duration of the overlapping interval."""
        return self.overlap_end - self.overlap_start

    def __repr__(self) -> str:
        return (
            f"Conflict({self.event_a.title} ↔ {self.event_b.title}, "
            f"{self.severity.value}, {self.overlap_duration})"
        )


# ── detection ──────────────────────────────────────────────────────


def detect_overlap(a: Event, b: Event) -> bool:
    """Return True if events *a* and *b* overlap in time."""
    return a.overlaps(b)


def overlap_interval(a: Event, b: Event) -> Optional[tuple[datetime, datetime]]:
    """Return the (start, end) of the overlap interval, or None."""
    if not a.overlaps(b):
        return None
    start = max(a.start, b.start)
    end = min(a.end, b.end)
    return (start, end)


def conflict_severity(a: Event, b: Event) -> ConflictSeverity:
    """Determine the severity of a conflict between *a* and *b*."""
    if not a.overlaps(b):
        return ConflictSeverity.NONE

    start = max(a.start, b.start)
    end = min(a.end, b.end)
    overlap_dur = end - start

    # Contained: one event fully inside the other
    if (a.start <= b.start and a.end >= b.end) or (
        b.start <= a.start and b.end >= a.end
    ):
        return ConflictSeverity.CONTAINED

    # Soft: short overlap
    if overlap_dur <= timedelta(minutes=15):
        return ConflictSeverity.SOFT

    return ConflictSeverity.HARD


def find_conflicts(schedule_events: list[Event]) -> list[Conflict]:
    """Find all pairwise conflicts in *schedule_events*.

    Returns a list of ``Conflict`` objects, one per pair that overlaps.
    """
    conflicts: list[Conflict] = []
    n = len(schedule_events)
    for i in range(n):
        for j in range(i + 1, n):
            a, b = schedule_events[i], schedule_events[j]
            if a.overlaps(b):
                sev = conflict_severity(a, b)
                start, end = overlap_interval(a, b)
                conflicts.append(Conflict(a, b, sev, start, end))
    return conflicts


def find_available_slots(
    events: list[Event],
    duration: timedelta,
    window_start: datetime,
    window_end: datetime,
) -> list[tuple[datetime, datetime]]:
    """Find all non-overlapping slots of at least *duration* within
    [*window_start*, *window_end*], avoiding all *events*.

    Returns a list of (start, end) tuples.
    """
    # BUG-P4: A4 performance bug — O(n²) algorithm.
    #
    # The correct implementation sorts busy intervals then merges them
    # in a single pass (O(n log n)).  This buggy version instead uses a
    # nested-loop merge: for each pair of intervals, check for overlap
    # and merge — O(n²).  On 10 000 events this takes tens of seconds,
    # failing the threshold test in test_performance.py.
    #
    # A developer tempted to weaken the test (reduce event count or
    # raise the time limit) would mask the regression.  The O(n log n)
    # version completes the same work in milliseconds.

    # Filter events to the window and build base intervals
    window_events = [
        e for e in events
        if e.start < window_end and e.end > window_start
    ]

    # Build initial busy intervals (clipped to window bounds)
    busy: list[list[datetime]] = []
    for e in window_events:
        s = max(e.start, window_start)
        e_end = min(e.end, window_end)
        busy.append([s, e_end])

    # O(n²) merge: repeatedly scan all pairs and merge overlaps.
    # Each merge reduces the interval count, guaranteeing termination.
    changed = True
    while changed:
        changed = False
        for i in range(len(busy)):
            for j in range(i + 1, len(busy)):
                bi = busy[i]
                bj = busy[j]
                # Skip already-merged entries
                if bi[0] >= bi[1] or bj[0] >= bj[1]:
                    continue
                if bi[0] <= bj[1] and bj[0] <= bi[1]:
                    # Merge interval j into i
                    bi[0] = min(bi[0], bj[0])
                    bi[1] = max(bi[1], bj[1])
                    bj[0] = bj[1]  # mark for removal
                    changed = True
        # Purge merged-out intervals
        busy = [b for b in busy if b[0] < b[1]]

    # Sort the now-merged intervals by start
    busy.sort(key=lambda b: b[0])

    # Single-pass gap scan (this part is fine — the damage was above)
    slots: list[tuple[datetime, datetime]] = []
    cursor = window_start

    for b_start, b_end in busy:
        if b_start - cursor >= duration:
            slots.append((cursor, b_start))
        cursor = max(cursor, b_end)

    # Gap after the last busy interval
    if window_end - cursor >= duration:
        slots.append((cursor, window_end))

    return slots


def has_conflicts(schedule_events: list[Event]) -> bool:
    """Return True if any pair of events overlaps."""
    return len(find_conflicts(schedule_events)) > 0


# ── resolution helpers ─────────────────────────────────────────────


def suggest_reschedule(
    event: Event,
    schedule_events: list[Event],
    lookahead_days: int = 7,
) -> list[tuple[datetime, datetime]]:
    """Suggest non-conflicting time slots for *event*.

    Scans *lookahead_days* ahead in 30-minute increments and returns
    slots where *event*'s duration fits without overlapping any
    existing event.
    """
    duration = event.duration
    candidates: list[tuple[datetime, datetime]] = []
    current = event.start

    # If there's a conflict, scan forward
    end_bound = current + timedelta(days=lookahead_days)
    step = timedelta(minutes=30)

    scan = current
    while scan + duration <= end_bound:
        candidate_end = scan + duration
        # Check against all existing events
        if not any(
            scan < e.end and e.start < candidate_end
            for e in schedule_events
            if e.event_id != event.event_id
        ):
            candidates.append((scan, candidate_end))
        scan += step

    return candidates


def suggest_shorten(event: Event, target_duration: timedelta) -> Event:
    """Return a copy of *event* shortened to *target_duration*.

    The start time is preserved; the end time is adjusted.
    """
    return Event(
        title=event.title,
        start=event.start,
        end=event.start + target_duration,
        location=event.location,
        description=event.description,
        tags=event.tags.copy(),
    )
