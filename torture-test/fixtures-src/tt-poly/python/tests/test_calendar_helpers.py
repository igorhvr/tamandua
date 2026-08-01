"""Tests for schedlib.calendar_helpers — business days with holidays,
week numbers, and calendar navigation."""

from datetime import date, timedelta

import pytest

from schedlib.calendar_helpers import (
    HolidayCalendar,
    add_business_days_with_holidays,
    iso_week_number,
    iso_year,
    next_business_day,
    previous_business_day,
    us_federal_holidays,
    week_range,
)


# ── HolidayCalendar ────────────────────────────────────────────────


class TestHolidayCalendar:
    def test_empty_calendar_has_no_holidays(self) -> None:
        cal = HolidayCalendar()
        assert cal.is_holiday(date(2026, 7, 4)) is False

    def test_add_and_check_holiday(self) -> None:
        cal = HolidayCalendar()
        cal.add(date(2026, 7, 4))
        assert cal.is_holiday(date(2026, 7, 4)) is True
        assert cal.is_holiday(date(2026, 7, 5)) is False

    def test_add_recurring(self) -> None:
        cal = HolidayCalendar()
        cal.add_recurring(7, 4, start_year=2026, end_year=2028)
        assert cal.is_holiday(date(2026, 7, 4)) is True
        assert cal.is_holiday(date(2027, 7, 4)) is True
        assert cal.is_holiday(date(2028, 7, 4)) is True
        assert cal.is_holiday(date(2025, 7, 4)) is False

    def test_add_recurring_handles_feb29(self) -> None:
        cal = HolidayCalendar()
        # Feb 29 on non-leap years should be silently skipped
        cal.add_recurring(2, 29, start_year=2025, end_year=2028)
        assert cal.is_holiday(date(2028, 2, 29)) is True  # leap year

    def test_is_business_day_normal_weekday(self) -> None:
        cal = HolidayCalendar()
        assert cal.is_business_day(date(2026, 7, 28)) is True  # Tuesday

    def test_is_business_day_weekend(self) -> None:
        cal = HolidayCalendar()
        assert cal.is_business_day(date(2026, 7, 25)) is False  # Saturday

    def test_is_business_day_holiday(self) -> None:
        cal = HolidayCalendar()
        cal.add(date(2026, 7, 4))
        # Jul 4 2026 is a Saturday, so already not a business day
        # Let's test with a weekday holiday
        cal.add(date(2026, 7, 28))  # Tuesday
        assert cal.is_business_day(date(2026, 7, 28)) is False


# ── us_federal_holidays ────────────────────────────────────────────


class TestUSFederalHolidays:
    def test_returns_holiday_calendar(self) -> None:
        cal = us_federal_holidays()
        assert isinstance(cal, HolidayCalendar)
        assert cal.name == "us-federal"

    def test_independence_day(self) -> None:
        cal = us_federal_holidays()
        assert cal.is_holiday(date(2026, 7, 4)) is True

    def test_christmas(self) -> None:
        cal = us_federal_holidays()
        assert cal.is_holiday(date(2026, 12, 25)) is True

    def test_new_years(self) -> None:
        cal = us_federal_holidays()
        assert cal.is_holiday(date(2026, 1, 1)) is True

    def test_thanksgiving_2026(self) -> None:
        cal = us_federal_holidays()
        # Thanksgiving 2026 = 4th Thursday of November = Nov 26, 2026
        assert cal.is_holiday(date(2026, 11, 26)) is True

    def test_mlk_day_2026(self) -> None:
        cal = us_federal_holidays()
        # MLK Day = 3rd Monday of January 2026 = Jan 19
        assert cal.is_holiday(date(2026, 1, 19)) is True

    def test_memorial_day_2026(self) -> None:
        cal = us_federal_holidays()
        # Memorial Day = last Monday of May 2026 = May 25
        assert cal.is_holiday(date(2026, 5, 25)) is True

    def test_labor_day_2026(self) -> None:
        cal = us_federal_holidays()
        # Labor Day = 1st Monday of September 2026 = Sep 7
        assert cal.is_holiday(date(2026, 9, 7)) is True


# ── business day navigation with holidays ─────────────────────────


class TestBusinessDayNavigation:
    def test_next_business_day_skip_weekend(self) -> None:
        # Friday → Monday
        assert next_business_day(date(2026, 7, 24)) == date(2026, 7, 27)

    def test_next_business_day_skip_holiday(self) -> None:
        cal = HolidayCalendar()
        cal.add(date(2026, 7, 28))  # Tuesday is a holiday
        # Monday 7/27 → Tuesday is holiday → Wednesday 7/29
        assert next_business_day(date(2026, 7, 27), calendar=cal) == date(2026, 7, 29)

    def test_previous_business_day_skip_weekend(self) -> None:
        # Monday → Friday
        assert previous_business_day(date(2026, 7, 27)) == date(2026, 7, 24)

    def test_previous_business_day_skip_holiday(self) -> None:
        cal = HolidayCalendar()
        cal.add(date(2026, 7, 28))  # Tuesday is a holiday
        # Wednesday 7/29 → Tuesday is holiday → Monday 7/27
        assert previous_business_day(date(2026, 7, 29), calendar=cal) == date(2026, 7, 27)

    def test_add_business_days_without_calendar(self) -> None:
        result = add_business_days_with_holidays(date(2026, 7, 27), 1)
        assert result == date(2026, 7, 28)

    def test_add_business_days_with_holiday_calendar(self) -> None:
        cal = HolidayCalendar()
        cal.add(date(2026, 7, 28))  # Tuesday holiday
        # Mon 7/27 + 1 biz day = Wed 7/29
        result = add_business_days_with_holidays(date(2026, 7, 27), 1, calendar=cal)
        assert result == date(2026, 7, 29)

    def test_add_zero_business_days_on_holiday(self) -> None:
        cal = HolidayCalendar()
        cal.add(date(2026, 7, 28))  # Tuesday holiday
        result = add_business_days_with_holidays(date(2026, 7, 28), 0, calendar=cal)
        assert result == date(2026, 7, 29)  # next business day


# ── week numbers ───────────────────────────────────────────────────


class TestWeekNumbers:
    def test_iso_week_number(self) -> None:
        # Jan 1, 2026 is a Thursday → ISO week 1
        assert iso_week_number(date(2026, 1, 1)) == 1
        # Dec 31, 2026 is a Thursday → ISO week 53
        assert iso_week_number(date(2026, 12, 31)) == 53

    def test_iso_year(self) -> None:
        # Dec 31, 2026 is in ISO year 2026
        assert iso_year(date(2026, 12, 31)) == 2026

    def test_week_range(self) -> None:
        monday, sunday = week_range(27, 2026)
        assert monday.weekday() == 0  # Monday
        assert sunday.weekday() == 6  # Sunday
        assert (sunday - monday).days == 6

    def test_week_range_known_week(self) -> None:
        # Week 1 of 2026 starts on Monday Dec 29, 2025 (ISO rules)
        monday, sunday = week_range(1, 2026)
        assert monday == date(2025, 12, 29)
        assert sunday == date(2026, 1, 4)
