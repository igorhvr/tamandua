"""Tests for the cross-language integration bridge in integrations.py.

Verifies the ``lookup_calendar_name()`` contract used by the TypeScript
``server.ts`` bridge.  This test is the Python-side verification point
for POLY-BUG-A5: the seed simultaneously changes key names in both
``integrations.py`` and ``server.ts``, and fixing only one subtree
leaves the other broken.

POLY-BUG-A5 seed state: keys are ``calendar_name`` / ``calendar_id``
instead of the baseline ``name`` / ``id``.
"""

from schedlib.integrations import lookup_calendar_name


def test_lookup_calendar_name_contract() -> None:
    """Verify that lookup_calendar_name returns the expected contract keys.

    POLY-BUG-A5: keys are calendar_name / calendar_id (seed state).
    """
    result = lookup_calendar_name(42)
    assert result == {"calendar_name": "Calendar-42", "calendar_id": 42}


def test_lookup_calendar_name_different_ids() -> None:
    """Verify contract holds for multiple calendar IDs."""
    for cid in (1, 7, 999):
        result = lookup_calendar_name(cid)
        assert "calendar_name" in result, f"key 'calendar_name' missing for id={cid}"
        assert "calendar_id" in result, f"key 'calendar_id' missing for id={cid}"
        assert result["calendar_name"] == f"Calendar-{cid}"
        assert result["calendar_id"] == cid
