# schedlib — Scheduling & Date Utility Library

A Python library for scheduling events, managing recurring appointments,
detecting conflicts, and working with calendars.

Built for the tamandua torture-test suite.

## Setup

```bash
./bootstrap
.venv/bin/pytest -q
```

## Module Overview

- **schedlib.engine** — Event CRUD and schedule management
- **schedlib.dates** — Date parsing, formatting, and utilities
- **schedlib.recurrence** — Recurrence rule engine (daily, weekly, monthly, yearly)
- **schedlib.conflict** — Overlap detection and conflict resolution
- **schedlib.calendar_helpers** — Business day calculations, holidays, week numbers
