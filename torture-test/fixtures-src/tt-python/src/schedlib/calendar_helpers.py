"""Calendar helpers — business days, holidays, week numbers.

Provides workday calculations, a small configurable holiday calendar,
ISO week-number support, and next/previous business day navigation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

from .dates import AnyDate, is_weekday, parse_date


@dataclass
class HolidayCalendar:
    """A configurable set of holidays (dates treated as non-business days).

    Holidays are stored as ``date`` objects.  Events scheduled on a
    holiday are flagged but not blocked — the calendar is advisory.
    """

    name: str = "default"
    holidays: set[date] = field(default_factory=set)

    def add(self, d: date) -> None:
        """Add a holiday date."""
        self.holidays.add(d)

    def add_recurring(self, month: int, day: int, start_year: int = 2000, end_year: int = 2100) -> None:
        """Add a fixed-date holiday for every year in [*start_year*, *end_year*]."""
        for year in range(start_year, end_year + 1):
            try:
                self.holidays.add(date(year, month, day))
            except ValueError:
                # Feb 29 on non-leap years
                pass

    def is_holiday(self, d: date) -> bool:
        """Return True if *d* is a holiday."""
        return d in self.holidays

    def is_business_day(self, d: date) -> bool:
        """Return True if *d* is a weekday and not a holiday."""
        return is_weekday(d) and not self.is_holiday(d)


# ── US federal holiday factory ────────────────────────────────────


def us_federal_holidays() -> HolidayCalendar:
    """Return a HolidayCalendar populated with standard US federal holidays."""
    cal = HolidayCalendar(name="us-federal")

    # New Year's Day
    cal.add_recurring(1, 1)
    # Independence Day
    cal.add_recurring(7, 4)
    # Veterans Day
    cal.add_recurring(11, 11)
    # Christmas Day
    cal.add_recurring(12, 25)

    # Martin Luther King Jr. Day — 3rd Monday of January
    for year in range(2000, 2101):
        cal.holidays.add(_nth_weekday_of_month(year, 1, 0, 3))  # 0=Monday
    # Presidents Day — 3rd Monday of February
    for year in range(2000, 2101):
        cal.holidays.add(_nth_weekday_of_month(year, 2, 0, 3))
    # Memorial Day — last Monday of May
    for year in range(2000, 2101):
        cal.holidays.add(_nth_weekday_of_month(year, 5, 0, -1))
    # Labor Day — 1st Monday of September
    for year in range(2000, 2101):
        cal.holidays.add(_nth_weekday_of_month(year, 9, 0, 1))
    # Columbus Day — 2nd Monday of October
    for year in range(2000, 2101):
        cal.holidays.add(_nth_weekday_of_month(year, 10, 0, 2))
    # Thanksgiving — 4th Thursday of November
    for year in range(2000, 2101):
        cal.holidays.add(_nth_weekday_of_month(year, 11, 3, 4))  # 3=Thursday

    return cal


def _nth_weekday_of_month(year: int, month: int, weekday: int, n: int) -> date:
    """Return the *n*-th occurrence of *weekday* in *month* of *year*.

    *n* can be negative (-1 = last).  *weekday* is 0=Mon..6=Sun.
    """
    import calendar as _calendar

    cal = _calendar.monthcalendar(year, month)
    occurrences: list[int] = []
    for week in cal:
        day = week[weekday]
        if day != 0:
            occurrences.append(day)

    if not occurrences:
        raise ValueError(f"no {weekday} weekday in {year}-{month:02d}")

    if n > 0:
        idx = n - 1
    else:
        idx = len(occurrences) + n  # n is negative

    if idx < 0 or idx >= len(occurrences):
        raise ValueError(f"no {n}th {weekday} weekday in {year}-{month:02d}")

    return date(year, month, occurrences[idx])


# ── business day navigation ────────────────────────────────────────


def next_business_day(
    d: AnyDate,
    calendar: Optional[HolidayCalendar] = None,
) -> date:
    """Return the next business day strictly after *d*.

    Skips weekends and, if *calendar* is provided, holidays.
    """
    d = parse_date(d) + timedelta(days=1)
    while True:
        if calendar is not None:
            if calendar.is_business_day(d):
                return d
        elif is_weekday(d):
            return d
        d += timedelta(days=1)


def previous_business_day(
    d: AnyDate,
    calendar: Optional[HolidayCalendar] = None,
) -> date:
    """Return the previous business day strictly before *d*."""
    d = parse_date(d) - timedelta(days=1)
    while True:
        if calendar is not None:
            if calendar.is_business_day(d):
                return d
        elif is_weekday(d):
            return d
        d -= timedelta(days=1)


def add_business_days_with_holidays(
    d: AnyDate,
    n: int,
    calendar: Optional[HolidayCalendar] = None,
) -> date:
    """Return *d* plus *n* business days, respecting holidays if provided."""
    from .dates import add_business_days

    if calendar is None:
        return add_business_days(d, n)

    d = parse_date(d)
    if n == 0:
        while not calendar.is_business_day(d):
            d += timedelta(days=1)
        return d

    step = 1 if n > 0 else -1
    remaining = abs(n)
    while remaining > 0:
        d += timedelta(days=step)
        if calendar.is_business_day(d):
            remaining -= 1
    return d


# ── week number ────────────────────────────────────────────────────


def iso_week_number(d: AnyDate) -> int:
    """Return the ISO-8601 week number for *d*."""
    return parse_date(d).isocalendar().week


def iso_year(d: AnyDate) -> int:
    """Return the ISO-8601 year for *d* (may differ from calendar year)."""
    return parse_date(d).isocalendar().year


def week_range(week: int, year: int) -> tuple[date, date]:
    """Return (Monday, Sunday) for the given ISO week and year."""
    # January 4th is always in ISO week 1
    jan4 = date(year, 1, 4)
    # Monday of week 1
    monday_w1 = jan4 - timedelta(days=jan4.weekday())
    monday = monday_w1 + timedelta(weeks=week - 1)
    sunday = monday + timedelta(days=6)
    return (monday, sunday)
