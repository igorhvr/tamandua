"""Recurrence rule engine — daily, weekly, monthly, yearly rules.

Supports:
- Simple intervals: daily, weekly, monthly, yearly
- Nth-weekday-of-month patterns ("3rd Monday")
- End conditions: by count or by end date
- Occurrence generation between two dates
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Optional
import calendar as _calendar


# ── recurrence rule ────────────────────────────────────────────────


class RecurrenceFrequency:
    DAILY = "daily"
    WEEKLY = "weekly"
    MONTHLY = "monthly"
    YEARLY = "yearly"


@dataclass
class RecurrenceRule:
    """Describes how an event repeats.

    Attributes:
        frequency: One of daily/weekly/monthly/yearly.
        interval: Repeat every N units (default 1).
        count: Maximum number of occurrences (None = unlimited).
        until: Stop after this date (None = unlimited).
        by_weekday: For weekly: restrict to these weekdays (0=Mon..6=Sun).
        by_monthday: For monthly: day-of-month (1..31).
        by_setpos: For monthly: nth occurrence, e.g. -1 = last, 1 = first,
                    paired with by_weekday for "3rd Monday".
    """

    frequency: str
    interval: int = 1
    count: Optional[int] = None
    until: Optional[date] = None
    by_weekday: Optional[list[int]] = None
    by_monthday: Optional[int] = None
    by_setpos: Optional[int] = None

    def __post_init__(self) -> None:
        if self.frequency not in (
            RecurrenceFrequency.DAILY,
            RecurrenceFrequency.WEEKLY,
            RecurrenceFrequency.MONTHLY,
            RecurrenceFrequency.YEARLY,
        ):
            raise ValueError(f"unknown frequency: {self.frequency!r}")
        if self.interval < 1:
            raise ValueError("interval must be >= 1")
        if self.count is not None and self.count < 1:
            raise ValueError("count must be >= 1")
        if self.by_weekday is not None:
            for wd in self.by_weekday:
                if not (0 <= wd <= 6):
                    raise ValueError(f"invalid weekday: {wd} (expected 0..6)")
        if self.by_monthday is not None and not (1 <= self.by_monthday <= 31):
            raise ValueError(f"invalid monthday: {self.by_monthday}")

    def occurrences(self, dtstart: date, dtend: date) -> list[date]:
        """Generate all occurrences of this rule between *dtstart* and *dtend* inclusive."""
        results: list[date] = []
        gen_count = 0
        max_count_val: int = self.count if self.count is not None else -1

        # Find the first matching date >= dtstart
        current = dtstart
        while current <= dtend:
            if self._matches(current):
                if self.until is not None and current > self.until:
                    break
                results.append(current)
                gen_count += 1
                if max_count_val > 0 and gen_count >= max_count_val:
                    break
                current = self._advance(current)
            else:
                current += timedelta(days=1)

        return results

    def _advance(self, d: date) -> date:
        """Jump forward by one interval unit from *d*.

        When fine-grained constraints (by_weekday, by_setpos) are
        active, advance by a single day so we don't skip matches
        within the same period (e.g., weekly by_weekday=[2,4]
        needs to find both Wed and Fri in the same week).
        """
        if self._uses_fine_grained():
            return d + timedelta(days=1)
        if self.frequency == RecurrenceFrequency.DAILY:
            return d + timedelta(days=self.interval)
        elif self.frequency == RecurrenceFrequency.WEEKLY:
            return d + timedelta(weeks=self.interval)
        elif self.frequency == RecurrenceFrequency.MONTHLY:
            return _add_months(d, self.interval)
        elif self.frequency == RecurrenceFrequency.YEARLY:
            # BUG-P2: yearly recurrence ignores interval — always
            # advances by 1 year even when interval > 1, causing
            # rules like yearly(interval=2) to produce annual
            # occurrences instead of biennial ones.
            return _add_years(d, 1)
        return d + timedelta(days=1)

    def _uses_fine_grained(self) -> bool:
        """Return True if day-by-day scanning is required."""
        return (
            self.by_weekday is not None
            or self.by_setpos is not None
            or self.by_monthday is not None
        )

    def _matches(self, d: date) -> bool:
        """Check if *d* matches this rule's pattern."""
        if self.frequency == RecurrenceFrequency.DAILY:
            return self._matches_daily(d)
        elif self.frequency == RecurrenceFrequency.WEEKLY:
            return self._matches_weekly(d)
        elif self.frequency == RecurrenceFrequency.MONTHLY:
            return self._matches_monthly(d)
        elif self.frequency == RecurrenceFrequency.YEARLY:
            return self._matches_yearly(d)
        return False

    def _matches_daily(self, d: date) -> bool:
        return True  # every day matches at interval 1; interval slicing done in occurrences

    def _matches_weekly(self, d: date) -> bool:
        if self.by_weekday is not None:
            return d.weekday() in self.by_weekday
        return True  # all days match

    def _matches_monthly(self, d: date) -> bool:
        if self.by_setpos is not None and self.by_weekday is not None:
            return self._matches_nth_weekday_of_month(d)
        if self.by_monthday is not None:
            return d.day == self.by_monthday
        return True  # every day matches

    def _matches_yearly(self, d: date) -> bool:
        return True  # every day matches

    def _matches_nth_weekday_of_month(self, d: date) -> bool:
        """Check if *d* is the nth occurrence of a given weekday in its month."""
        if d.weekday() not in self.by_weekday:
            return False
        target_wd = d.weekday()
        month_days = _calendar.monthcalendar(d.year, d.month)
        # Collect all occurrences of this weekday in the month
        occurrences: list[int] = []
        for week in month_days:
            day = week[target_wd]
            if day != 0:
                occurrences.append(day)

        try:
            pos = occurrences.index(d.day) + 1  # 1-indexed
        except ValueError:
            return False

        if self.by_setpos > 0:
            return pos == self.by_setpos
        else:
            # Negative setpos: count from end.  -1 = last.
            return pos == len(occurrences) + 1 + self.by_setpos


# ── factory helpers ────────────────────────────────────────────────


def daily(interval: int = 1, count: Optional[int] = None, until: Optional[date] = None) -> RecurrenceRule:
    """Create a daily recurrence rule."""
    return RecurrenceRule(
        frequency=RecurrenceFrequency.DAILY,
        interval=interval,
        count=count,
        until=until,
    )


def weekly(
    interval: int = 1,
    count: Optional[int] = None,
    until: Optional[date] = None,
    by_weekday: Optional[list[int]] = None,
) -> RecurrenceRule:
    """Create a weekly recurrence rule."""
    return RecurrenceRule(
        frequency=RecurrenceFrequency.WEEKLY,
        interval=interval,
        count=count,
        until=until,
        by_weekday=by_weekday,
    )


def monthly(
    interval: int = 1,
    count: Optional[int] = None,
    until: Optional[date] = None,
    by_monthday: Optional[int] = None,
    by_setpos: Optional[int] = None,
    by_weekday: Optional[list[int]] = None,
) -> RecurrenceRule:
    """Create a monthly recurrence rule."""
    return RecurrenceRule(
        frequency=RecurrenceFrequency.MONTHLY,
        interval=interval,
        count=count,
        until=until,
        by_monthday=by_monthday,
        by_setpos=by_setpos,
        by_weekday=by_weekday,
    )


def yearly(
    interval: int = 1,
    count: Optional[int] = None,
    until: Optional[date] = None,
) -> RecurrenceRule:
    """Create a yearly recurrence rule."""
    return RecurrenceRule(
        frequency=RecurrenceFrequency.YEARLY,
        interval=interval,
        count=count,
        until=until,
    )


# ── internal date arithmetic ──────────────────────────────────────


def _add_months(d: date, n: int) -> date:
    """Add *n* months to *d*, clamping to month end if needed."""
    total_months = d.year * 12 + (d.month - 1) + n
    year = total_months // 12
    month = (total_months % 12) + 1
    max_day = _calendar.monthrange(year, month)[1]
    day = min(d.day, max_day)
    return date(year, month, day)


def _add_years(d: date, n: int) -> date:
    """Add *n* years to *d*, clamping Feb 29 to Feb 28 on non-leap years."""
    year = d.year + n
    try:
        return date(year, d.month, d.day)
    except ValueError:
        # Feb 29 on non-leap year → Feb 28
        return date(year, 2, 28)
