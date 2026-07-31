"""Date parsing, formatting, and utility functions.

Pure stdlib — no external dependencies.  Handles a range of common
date/datetime formats and provides delta calculations, weekday checks,
and business-day arithmetic.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Optional, Union

AnyDate = Union[date, datetime, str]


# ── parsing ────────────────────────────────────────────────────────

_ISO_FORMATS: list[str] = [
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d",
]

_US_FORMATS: list[str] = [
    "%m/%d/%Y",
    "%m/%d/%Y %H:%M",
    "%m/%d/%y",
]

_EURO_FORMATS: list[str] = [
    "%d/%m/%Y",
    "%d/%m/%Y %H:%M",
    "%d-%m-%Y",
]


def parse_date(value: AnyDate) -> date:
    """Parse a date from string, date, or datetime.

    Returns a ``date`` (no time component).  For strings, tries a
    sequence of common formats and returns the first successful parse.

    Raises ``ValueError`` if no format matches.
    """
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        return _parse_str(value).date()
    raise TypeError(f"unsupported type: {type(value)}")


def parse_datetime(value: AnyDate) -> datetime:
    """Parse a datetime from string, date, or datetime.

    Similar to ``parse_date`` but preserves time and timezone
    information.  Naive datetimes are treated as UTC.
    """
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    if isinstance(value, str):
        return _parse_str(value)
    raise TypeError(f"unsupported type: {type(value)}")


def _parse_str(s: str) -> datetime:
    """Attempt to parse *s* against a priority-ordered list of formats."""
    s = s.strip()
    for fmt_list in (_ISO_FORMATS, _US_FORMATS, _EURO_FORMATS):
        for fmt in fmt_list:
            try:
                dt = datetime.strptime(s, fmt)
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except ValueError:
                continue
    raise ValueError(f"cannot parse date string: {s!r}")


# ── formatting ─────────────────────────────────────────────────────


def format_iso(dt: AnyDate) -> str:
    """Format as ISO-8601 string ``YYYY-MM-DDTHH:MM:SS+HH:MM``."""
    return parse_datetime(dt).isoformat()


def format_date(dt: AnyDate) -> str:
    """Format as a friendly date string ``YYYY-MM-DD``."""
    d = parse_date(dt)
    return d.isoformat()


# ── delta helpers ──────────────────────────────────────────────────


def days_between(start: AnyDate, end: AnyDate) -> int:
    """Return the number of days between *start* and *end* (inclusive of start)."""
    s = parse_date(start)
    e = parse_date(end)
    return (e - s).days


def add_days(dt: AnyDate, n: int) -> date:
    """Return *dt* plus *n* calendar days."""
    return parse_date(dt) + timedelta(days=n)


def date_range(start: AnyDate, end: AnyDate) -> list[date]:
    """Return a list of all dates from *start* through *end* inclusive.

    If *end* < *start* the result is empty.
    """
    s = parse_date(start)
    e = parse_date(end)
    if e < s:
        return []
    count = (e - s).days + 1
    return [s + timedelta(days=i) for i in range(count)]


# ── weekday helpers ────────────────────────────────────────────────


def is_weekday(dt: AnyDate) -> bool:
    """Return True if *dt* is Monday–Friday."""
    return parse_date(dt).weekday() < 5


def is_weekend(dt: AnyDate) -> bool:
    """Return True if *dt* is Saturday or Sunday."""
    return parse_date(dt).weekday() >= 5


def next_weekday(dt: AnyDate) -> date:
    """Return the next weekday on or after *dt*."""
    d = parse_date(dt)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def previous_weekday(dt: AnyDate) -> date:
    """Return the previous weekday on or before *dt*."""
    d = parse_date(dt)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


# ── business days ──────────────────────────────────────────────────


def add_business_days(dt: AnyDate, n: int) -> date:
    """Return *dt* plus *n* business (Monday–Friday) days.

    Positive *n* moves forward; negative moves backward.
    """
    d = parse_date(dt)
    if n == 0:
        return next_weekday(d)
    step = 1 if n > 0 else -1
    remaining = abs(n)
    while remaining > 0:
        d += timedelta(days=step)
        if d.weekday() < 5:
            remaining -= 1
    return d


def business_days_between(start: AnyDate, end: AnyDate) -> int:
    """Count business days (Mon-Fri) from *start* to *end* inclusive."""
    s = parse_date(start)
    e = parse_date(end)
    if e < s:
        return 0
    count = 0
    current = s
    while current <= e:
        if current.weekday() < 5:
            count += 1
        current += timedelta(days=1)
    return count
