"""Tests for schedlib.dates — date parsing, formatting, and utilities."""

from datetime import date, datetime, timedelta, timezone

import pytest

from schedlib.dates import (
    add_business_days,
    add_days,
    business_days_between,
    date_range,
    days_between,
    format_date,
    format_iso,
    is_weekday,
    is_weekend,
    next_weekday,
    parse_date,
    parse_datetime,
    previous_weekday,
)

# ── parse_date ─────────────────────────────────────────────────────


class TestParseDate:
    def test_returns_date_unchanged(self) -> None:
        d = date(2026, 7, 30)
        assert parse_date(d) == d

    def test_extracts_date_from_datetime(self) -> None:
        dt = datetime(2026, 7, 30, 15, 30, tzinfo=timezone.utc)
        assert parse_date(dt) == date(2026, 7, 30)

    def test_parses_iso_format(self) -> None:
        assert parse_date("2026-07-30") == date(2026, 7, 30)

    def test_parses_iso_with_time(self) -> None:
        assert parse_date("2026-07-30T15:30:00") == date(2026, 7, 30)

    def test_parses_us_format(self) -> None:
        assert parse_date("07/30/2026") == date(2026, 7, 30)

    def test_parses_euro_format(self) -> None:
        assert parse_date("30/07/2026") == date(2026, 7, 30)

    def test_parses_dashed_euro(self) -> None:
        assert parse_date("30-07-2026") == date(2026, 7, 30)

    def test_rejects_invalid_string(self) -> None:
        with pytest.raises(ValueError):
            parse_date("not-a-date")

    def test_rejects_unsupported_type(self) -> None:
        with pytest.raises(TypeError):
            parse_date(42)


# ── parse_datetime ─────────────────────────────────────────────────


class TestParseDatetime:
    def test_returns_datetime_unchanged(self) -> None:
        dt = datetime(2026, 7, 30, 15, 30, tzinfo=timezone.utc)
        assert parse_datetime(dt) == dt

    def test_adds_utc_to_naive_datetime(self) -> None:
        dt = datetime(2026, 7, 30, 15, 30)
        result = parse_datetime(dt)
        assert result.tzinfo == timezone.utc
        assert result.hour == 15

    def test_converts_date_to_datetime(self) -> None:
        d = date(2026, 7, 30)
        result = parse_datetime(d)
        assert result == datetime(2026, 7, 30, tzinfo=timezone.utc)

    def test_parses_iso_with_timezone(self) -> None:
        result = parse_datetime("2026-07-30T15:30:00+00:00")
        assert result.year == 2026
        assert result.month == 7
        assert result.day == 30

    def test_parses_space_separated(self) -> None:
        result = parse_datetime("2026-07-30 15:30:00")
        assert result.hour == 15
        assert result.minute == 30

    def test_parses_us_slash_format(self) -> None:
        result = parse_datetime("07/30/2026 14:00")
        assert result.month == 7
        assert result.day == 30

    def test_rejects_invalid_string(self) -> None:
        with pytest.raises(ValueError):
            parse_datetime("garbage")


# ── formatting ─────────────────────────────────────────────────────


class TestFormatting:
    def test_format_iso(self) -> None:
        dt = datetime(2026, 7, 30, 15, 30, 0, tzinfo=timezone.utc)
        result = format_iso(dt)
        assert "2026-07-30" in result

    def test_format_date(self) -> None:
        assert format_date(date(2026, 7, 30)) == "2026-07-30"

    def test_format_date_from_string(self) -> None:
        assert format_date("2026-07-30") == "2026-07-30"


# ── delta helpers ──────────────────────────────────────────────────


class TestDeltaHelpers:
    def test_days_between_same_day(self) -> None:
        assert days_between("2026-07-01", "2026-07-01") == 0

    def test_days_between_consecutive(self) -> None:
        assert days_between("2026-07-01", "2026-07-02") == 1

    def test_days_between_across_months(self) -> None:
        assert days_between("2026-06-01", "2026-07-01") == 30

    def test_days_between_reversed_negative(self) -> None:
        assert days_between("2026-07-02", "2026-07-01") == -1

    def test_add_days_positive(self) -> None:
        assert add_days("2026-07-01", 5) == date(2026, 7, 6)

    def test_add_days_negative(self) -> None:
        assert add_days("2026-07-01", -1) == date(2026, 6, 30)

    def test_add_days_zero(self) -> None:
        assert add_days("2026-07-01", 0) == date(2026, 7, 1)


# ── date_range ─────────────────────────────────────────────────────


class TestDateRange:
    def test_single_day(self) -> None:
        assert date_range("2026-07-01", "2026-07-01") == [date(2026, 7, 1)]

    def test_three_days(self) -> None:
        result = date_range("2026-07-01", "2026-07-03")
        assert result == [date(2026, 7, 1), date(2026, 7, 2), date(2026, 7, 3)]

    def test_end_before_start(self) -> None:
        assert date_range("2026-07-03", "2026-07-01") == []

    def test_across_month_boundary(self) -> None:
        result = date_range("2026-06-29", "2026-07-02")
        assert len(result) == 4
        assert result[0] == date(2026, 6, 29)
        assert result[-1] == date(2026, 7, 2)


# ── weekday helpers ────────────────────────────────────────────────


class TestWeekdayHelpers:
    def test_is_weekday_monday(self) -> None:
        assert is_weekday(date(2026, 7, 27)) is True  # Monday

    def test_is_weekday_saturday(self) -> None:
        assert is_weekday(date(2026, 7, 25)) is False  # Saturday

    def test_is_weekday_sunday(self) -> None:
        assert is_weekday(date(2026, 7, 26)) is False  # Sunday

    def test_is_weekend_saturday(self) -> None:
        assert is_weekend(date(2026, 7, 25)) is True

    def test_is_weekend_tuesday(self) -> None:
        assert is_weekend(date(2026, 7, 28)) is False

    def test_next_weekday_from_friday(self) -> None:
        assert next_weekday(date(2026, 7, 24)) == date(2026, 7, 24)  # Friday

    def test_next_weekday_from_saturday(self) -> None:
        assert next_weekday(date(2026, 7, 25)) == date(2026, 7, 27)  # Monday

    def test_next_weekday_from_sunday(self) -> None:
        assert next_weekday(date(2026, 7, 26)) == date(2026, 7, 27)  # Monday

    def test_previous_weekday_from_monday(self) -> None:
        assert previous_weekday(date(2026, 7, 27)) == date(2026, 7, 27)  # Monday

    def test_previous_weekday_from_saturday(self) -> None:
        assert previous_weekday(date(2026, 7, 25)) == date(2026, 7, 24)  # Friday

    def test_previous_weekday_from_sunday(self) -> None:
        assert previous_weekday(date(2026, 7, 26)) == date(2026, 7, 24)  # Friday


# ── business days ──────────────────────────────────────────────────


class TestBusinessDays:
    def test_add_zero_from_weekday(self) -> None:
        # 0 business days from a weekday: stays on same day
        assert add_business_days(date(2026, 7, 27), 0) == date(2026, 7, 27)  # Monday

    def test_add_zero_from_saturday(self) -> None:
        # 0 business days from weekend: next weekday
        assert add_business_days(date(2026, 7, 25), 0) == date(2026, 7, 27)  # Sat→Mon

    def test_add_one_business_day(self) -> None:
        assert add_business_days(date(2026, 7, 27), 1) == date(2026, 7, 28)  # Mon→Tue

    def test_add_five_business_days(self) -> None:
        assert add_business_days(date(2026, 7, 27), 5) == date(2026, 8, 3)  # Mon→next Mon

    def test_add_across_weekend(self) -> None:
        assert add_business_days(date(2026, 7, 24), 1) == date(2026, 7, 27)  # Fri→Mon

    def test_add_negative(self) -> None:
        assert add_business_days(date(2026, 7, 28), -1) == date(2026, 7, 27)  # Tue→Mon

    def test_business_days_between_same_day(self) -> None:
        assert business_days_between("2026-07-27", "2026-07-27") == 1  # Monday

    def test_business_days_between_same_weekend_day(self) -> None:
        assert business_days_between("2026-07-25", "2026-07-25") == 0  # Saturday

    def test_business_days_between_monday_to_friday(self) -> None:
        assert business_days_between("2026-07-27", "2026-07-31") == 5

    def test_business_days_between_including_weekend(self) -> None:
        assert business_days_between("2026-07-24", "2026-07-27") == 2  # Fri, Mon

    def test_end_before_start(self) -> None:
        assert business_days_between("2026-07-28", "2026-07-27") == 0
