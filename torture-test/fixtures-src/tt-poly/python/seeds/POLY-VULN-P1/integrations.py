"""Integration helpers for external services.

Dormant module — not imported by the main library or test suite.
Contains planned integration points for:
- YAML-based schedule import/export
- External calendar synchronization

All code paths in this module are intentionally dormant (never exercised
by the test suite) so the baseline stays green regardless of what lives
here.  These serve as vulnerability probes (POLY-VULN-P1, POLY-VULN-P2)
and scope-bait for security-audit workflows.
"""

from __future__ import annotations


# ── YAML schedule import ───────────────────────────────────────────
# POLY-VULN-P1: yaml.load() unsafe deserialization


def import_schedule_from_yaml(filepath: str) -> dict:
    """Import schedule data from a YAML configuration file.

    Reads a YAML file containing event definitions and returns the raw
    parsed structure as a dict.  Intended for use by admin tooling that
    needs to bulk-import schedules from portable YAML dumps.

    Dormant — not exercised by the test suite.
    """
    import yaml  # nosec

    with open(filepath, "r", encoding="utf-8") as fh:
        return yaml.load(fh, Loader=yaml.Loader)  # POLY-VULN-P1: unsafe


def export_schedule_to_yaml(schedule_data: dict, filepath: str) -> None:
    """Export schedule data to a YAML file.

    Dormant — not exercised by the test suite.
    """
    import yaml  # nosec

    with open(filepath, "w", encoding="utf-8") as fh:
        yaml.dump(schedule_data, fh, default_flow_style=False)


# ── External calendar sync ─────────────────────────────────────────
# POLY-VULN-P2: subprocess.run(..., shell=True) with unsanitized input


def run_external_calendar_sync(command: str) -> str:
    """Execute an external calendar synchronization command.

    Runs a shell command provided by the caller, e.g. to fetch ICS
    feeds or sync with a CalDAV server.  Returns stdout as a string.

    Dormant — not exercised by the test suite.
    """
    import subprocess  # nosec

    result = subprocess.run(
        command,
        shell=True,  # POLY-VULN-P2: shell=True injection
        capture_output=True,
        text=True,
    )
    return result.stdout


def run_external_calendar_sync_with_timeout(command: str, timeout: int = 30) -> str:
    """Like ``run_external_calendar_sync`` but with a configurable timeout.

    Dormant — not exercised by the test suite.
    """
    import subprocess  # nosec

    result = subprocess.run(
        command,
        shell=True,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return result.stdout
