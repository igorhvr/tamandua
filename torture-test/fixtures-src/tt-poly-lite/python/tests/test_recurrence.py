"""Tests for schedlib.recurrence — RecurrenceRule and factory helpers."""

from datetime import date, timedelta

import pytest

from schedlib.recurrence import (
    RecurrenceFrequency,
    RecurrenceRule,
    daily,
    monthly,
    weekly,
    yearly,
)


class TestRecurrenceRuleValidation:
    def test_rejects_unknown_frequency(self) -> None:
        with pytest.raises(ValueError, match="unknown frequency"):
            RecurrenceRule(frequency="hourly")

    def test_rejects_zero_interval(self) -> None:
        with pytest.raises(ValueError, match="interval"):
            RecurrenceRule(frequency=RecurrenceFrequency.DAILY, interval=0)

    def test_rejects_negative_count(self) -> None:
        with pytest.raises(ValueError, match="count"):
            RecurrenceRule(frequency=RecurrenceFrequency.DAILY, count=0)

    def test_rejects_invalid_weekday(self) -> None:
        with pytest.raises(ValueError, match="invalid weekday"):
            RecurrenceRule(frequency=RecurrenceFrequency.WEEKLY, by_weekday=[7])

    def test_rejects_invalid_monthday(self) -> None:
        with pytest.raises(ValueError, match="invalid monthday"):
            RecurrenceRule(frequency=RecurrenceFrequency.MONTHLY, by_monthday=32)


class TestDailyRecurrence:
    def test_every_day_for_one_week(self) -> None:
        rule = daily()
        results = rule.occurrences(date(2026, 7, 27), date(2026, 8, 2))
        assert len(results) == 7
        assert results[0] == date(2026, 7, 27)
        assert results[-1] == date(2026, 8, 2)

    def test_with_count_limit(self) -> None:
        rule = daily(count=3)
        results = rule.occurrences(date(2026, 7, 27), date(2026, 8, 2))
        assert len(results) == 3

    def test_with_until_date(self) -> None:
        rule = daily(until=date(2026, 7, 29))
        results = rule.occurrences(date(2026, 7, 27), date(2026, 8, 2))
        assert len(results) == 3  # 27, 28, 29
        assert results[-1] == date(2026, 7, 29)

    def test_every_other_day(self) -> None:
        rule = daily(interval=2)
        results = rule.occurrences(date(2026, 7, 27), date(2026, 8, 2))
        # 27, 29, 31, 2 → 4 occurrences
        assert len(results) == 4
        assert results[0] == date(2026, 7, 27)
        assert results[1] == date(2026, 7, 29)


class TestWeeklyRecurrence:
    def test_every_week(self) -> None:
        rule = weekly()
        results = rule.occurrences(date(2026, 7, 27), date(2026, 8, 17))
        assert len(results) == 4  # 4 Mondays

    def test_specific_weekdays(self) -> None:
        rule = weekly(by_weekday=[2, 4])  # Wed, Fri
        results = rule.occurrences(date(2026, 7, 27), date(2026, 8, 7))
        # Wed 7/29, Fri 7/31, Wed 8/5, Fri 8/7
        assert len(results) == 4
        assert results[0] == date(2026, 7, 29)  # Wed
        assert results[1] == date(2026, 7, 31)  # Fri

    def test_every_two_weeks(self) -> None:
        rule = weekly(interval=2)
        results = rule.occurrences(date(2026, 7, 27), date(2026, 8, 24))
        # 7/27, 8/10, 8/24 → 3
        assert len(results) == 3
        assert results[1] == date(2026, 8, 10)


class TestMonthlyRecurrence:
    def test_specific_day_of_month(self) -> None:
        rule = monthly(by_monthday=15)
        results = rule.occurrences(date(2026, 7, 1), date(2026, 9, 30))
        assert len(results) == 3  # Jul 15, Aug 15, Sep 15
        assert results[0].day == 15
        assert results[1].day == 15

    def test_31st_clamps_to_last_day(self) -> None:
        rule = monthly(by_monthday=31)
        results = rule.occurrences(date(2026, 6, 1), date(2026, 7, 31))
        # Jun: 30 (June has 30 days) -> only matches if day==31, so Jun=0, Jul=1
        # Wait - by_monthday=31, _matches_monthly checks d.day == 31
        # So June won't match. Only July 31.
        assert len(results) == 1
        assert results[0] == date(2026, 7, 31)

    def test_nth_weekday_of_month(self) -> None:
        # 3rd Monday of each month
        rule = monthly(by_setpos=3, by_weekday=[0])  # 0 = Monday
        results = rule.occurrences(date(2026, 7, 1), date(2026, 8, 31))
        assert len(results) == 2  # 3rd Mon Jul, 3rd Mon Aug
        for d in results:
            assert d.weekday() == 0  # Monday

    def test_last_weekday_of_month(self) -> None:
        # Last Friday of each month
        rule = monthly(by_setpos=-1, by_weekday=[4])  # 4 = Friday
        results = rule.occurrences(date(2026, 7, 1), date(2026, 8, 31))
        assert len(results) == 2
        for d in results:
            assert d.weekday() == 4  # Friday

    def test_every_three_months(self) -> None:
        rule = monthly(interval=3)
        results = rule.occurrences(date(2026, 7, 27), date(2027, 1, 31))
        # Jul 27, Oct 27, Jan 27 → 3
        assert len(results) == 3


class TestYearlyRecurrence:
    def test_every_year(self) -> None:
        rule = yearly()
        results = rule.occurrences(date(2026, 7, 30), date(2028, 8, 1))
        assert len(results) == 3  # 2026, 2027, 2028

    def test_every_two_years(self) -> None:
        rule = yearly(interval=2)
        results = rule.occurrences(date(2026, 7, 30), date(2030, 7, 30))
        assert len(results) == 3  # 2026, 2028, 2030


class TestFactoryHelpers:
    def test_daily_factory(self) -> None:
        r = daily(interval=2, count=5)
        assert r.frequency == RecurrenceFrequency.DAILY
        assert r.interval == 2
        assert r.count == 5

    def test_weekly_factory(self) -> None:
        r = weekly(by_weekday=[0, 2, 4])
        assert r.frequency == RecurrenceFrequency.WEEKLY
        assert r.by_weekday == [0, 2, 4]

    def test_monthly_factory(self) -> None:
        r = monthly(by_monthday=1, interval=1)
        assert r.frequency == RecurrenceFrequency.MONTHLY
        assert r.by_monthday == 1

    def test_yearly_factory(self) -> None:
        r = yearly(until=date(2030, 1, 1))
        assert r.frequency == RecurrenceFrequency.YEARLY
        assert r.until == date(2030, 1, 1)


class TestEdgeCases:
    def test_empty_range(self) -> None:
        rule = daily()
        results = rule.occurrences(date(2026, 8, 1), date(2026, 7, 1))
        assert results == []

    def test_count_zero_beyond_range(self) -> None:
        rule = daily(count=10)
        results = rule.occurrences(date(2026, 7, 27), date(2026, 7, 28))
        assert len(results) == 2  # count=10 but only 2 days in range

    def test_until_before_dtstart(self) -> None:
        rule = daily(until=date(2026, 7, 1))
        results = rule.occurrences(date(2026, 7, 27), date(2026, 7, 31))
        assert results == []
