# Implement `torture-test/bin/tt-recorder` (process + resource telemetry sampler)

Authoritative spec in this repo — READ first:
- `torture-test/tamandua-torture-test-spec/12-runner-automation.md`
  (§tt-recorder — the component contract, including the O19 extension:
  per-daemon RSS, open-fd count, tamandua.db+WAL byte size per sample).
- `torture-test/tamandua-torture-test-spec/03-oracles.md` — O4 (the
  liveness-provenance consumer: ≥2-consecutive-samples rule) and O19
  (resource-trend consumer) define what the samples must support.
- Existing conventions: `torture-test/bin/tt-verify-environment`,
  `torture-test/env/*.sh`.

## Deliverables

1. `torture-test/bin/tt-recorder` — a local sampler:
   `tt-recorder start|stop|status [--interval 5]`.
   - Every interval (default 5s): for every tamandua-family process
     whose cwd/cmdline evidence ties it to `torture-test/var/` (NEVER
     name-only matching, NEVER env reading — cmdline/cwd/fd evidence
     only): record ts (UTC ISO-8601), pid, pgid, ppid, cwd, cmdline,
     RSS kB, open-fd count. For each TT daemon additionally: its
     tamandua.db and -wal byte sizes.
   - Append-only JSONL to
     `torture-test/var/recorder/samples-<startedAt>.jsonl`; rotate at
     50MB; never buffer more than one interval in memory.
   - `start` detaches (nohup-style, pidfile under var/recorder/),
     refuses double-start; `stop` kills only the pidfile's process after
     verifying its cmdline is tt-recorder (evidence-based, like
     everything else); `status` reports running/not + current file +
     sample count.
   - Production processes (state under the real `~/.tamandua`, ports
     33xx) are explicitly OUT of scope — assert the tie to
     torture-test/var before recording a process; a sampler that records
     production activity is a bug.
2. `torture-test/bin/tt-recorder.test.sh` — self-test: start; spawn a
   decoy process whose cwd is OUTSIDE torture-test/var (must NOT be
   sampled) and a dummy process inside it (MUST be sampled with RSS/fd
   fields present); verify ≥2 samples of the dummy across 2 intervals;
   stop; verify clean pidfile removal and valid JSONL throughout.

## Hard constraints

- Files ONLY inside `torture-test/`; state ONLY under `torture-test/var/`.
- No new npm dependencies; node or bash matching existing tool style.
- Zero interaction with production tamandua state or services.

## Acceptance

- Self-test passes twice consecutively; a 60s manual run produces valid
  JSONL with monotone timestamps and plausible RSS/fd values; stop is
  clean; double-start refused.
