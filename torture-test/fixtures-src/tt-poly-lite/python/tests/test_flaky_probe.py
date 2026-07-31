"""POLY-FLAKY-P1: deterministic alternator test using a counter file.

Fails on every 2nd execution across separate test suite invocations.
When the flaky_probe marker is activated (skip removed by the
seeds/POLY-FLAKY-P1/ arming overlay), this test provides a reproducible
flaky signal for the W4.18 scenario.

Baseline behaviour: test is skipped via ``@pytest.mark.flaky_probe``
and the ``conftest.py`` collection hook (baseline stays green).
"""

import os

import pytest

_COUNTER_FILE = os.path.join(os.path.dirname(__file__), "..", ".flaky_counter")


def _read_count() -> int:
    try:
        with open(_COUNTER_FILE) as fh:
            return int(fh.read().strip())
    except (FileNotFoundError, ValueError):
        return 0


def _write_count(count: int) -> None:
    with open(_COUNTER_FILE, "w") as fh:
        fh.write(str(count))


@pytest.mark.flaky_probe
def test_flaky_alternator() -> None:
    """Deterministic alternator: pass on odd runs, fail on even runs.

    A counter file (``.flaky_counter`` at the project root) tracks how
    many times the test has been invoked across separate ``pytest``
    sessions.  Even-numbered invocations fail intentionally; odd ones
    pass.  This is NOT a random flake — it is deterministic given the
    counter state, which makes it reliable for scenario W4.18.
    """
    count = _read_count() + 1
    _write_count(count)

    if count % 2 == 0:
        pytest.fail(
            f"Flaky alternator: intentional failure on invocation #{count}"
        )
