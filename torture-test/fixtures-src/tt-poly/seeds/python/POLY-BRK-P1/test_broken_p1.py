"""Broken test POLY-BRK-P1 — assertion failure: expected vs actual date mismatch.

This is a genuinely failing test used by quarantine workflow scenarios.
The expected value is deliberately wrong (off by 3 days, confuses calendar
days with business days). The fix.patch corrects the expected date.
"""

from datetime import date

from schedlib.dates import add_business_days


class TestBrokenP1:
    """Broken assertion: add_business_days with wrong expected value."""

    def test_add_business_days_returns_correct_date(self) -> None:
        """Fails: expected date is off by 3 days (calendar vs business)."""
        start = date(2026, 7, 27)  # Monday
        # add_business_days(start, 5) adds 5 business days skipping weekend
        # Mon 7/27 + 5 business days = Mon 8/3 (skips Sat 8/1, Sun 8/2)
        # The broken expectation uses 5 calendar days = Fri 7/31
        result = add_business_days(start, 5)
        assert result == date(2026, 7, 31)  # BROKEN

    def test_add_business_days_across_weekend(self) -> None:
        """Fails: expected date does not skip weekend."""
        start = date(2026, 7, 30)  # Thursday
        # add_business_days(thu, 2): Thu 7/30 + 1 = Fri 7/31, + 1 = Mon 8/3
        result = add_business_days(start, 2)
        assert result == date(2026, 8, 1)  # BROKEN
