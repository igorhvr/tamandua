# RJSON US-002 — isolated emission-level recorder JSONL framing evidence

Beads tamandua-0j7.4.2. Story US-002 of run b74a8b52 (branch
`feature/rjson-recorder-json-escaping`): prove the repaired
`torture-test/bin/tt-recorder` emits valid, one-physical-line-per-record
JSONL end to end — through the real `collect_sample` output path and a real
started recorder's `samples-<startedAt>.jsonl` output file — with freshly
allocated fixtures and exactly owned child processes carrying multiline
command text and a multiline fixture path.

## Tested source trees

| Phase | Source tree | `torture-test/bin/tt-recorder` SHA256 |
|---|---|---|
| RED (pre-fix helper) | US-001 defect blob checked out over the working tree (`git checkout e793324d -- torture-test/bin/tt-recorder`), emission regression file = committed one | `04ccb4292100f4cbe638033ce10feb74891cf41d16a6143ebbfdfa12ba6e454b` |
| GREEN (post-fix helper) | story commit (working tree as committed, guarded chunked helper) | `a650e0988c0764aee2e761b5efbf731949ba23f53895cc36f0c159dabcd4dafa` |

Platform executed on: Linux (bash 5.3.9, node v24.18.0). The emission cases
are linux-only (the recorder's process discovery and per-process reads need a
procfs mount; a procfs-less host yields an empty sample series), so on a
Darwin/macOS host those cases mark themselves explicitly not-applicable
(message + exit 0) while the portable pure-helper round trips (first test)
still execute on every host. **No Darwin/Mac execution happened in this
story, and none is claimed as passed here** — the story records Linux
execution only; the coordinator owns the both-host proof.

Isolation guard: every proof command below ran with the test isolation guard
ENABLED (children inherit the runner's environment untouched — no
`TAMANDUA_TEST_GUARD=0`, no `NODE_TEST_CONTEXT` removal). The emission
regression spawns only plain `bash`/`ps`/`kill` children that source/copy
the recorder and read fixture + procfs paths; they never import tamandua
modules, bind ports, or touch tamandua state, so nothing trips the guard.

## Scope of the helper change carried by US-002

The US-001 pure repair (whole-string 34-pass `${s//pat/rep}` chain, helper
sha `0e2c937f…`) was Linux-green but NOT accepted on Mac for dense
escape-heavy input: Darwin's system Bash 3.2.57 exceeded 10,000 ms on a
47,500-byte mixed record (coordinator Mac red). US-002 therefore integrates
the coordinator-validated guarded chunked helper — the retained prototype
`/tmp/test_guard.sh` (sha
`c8e858ddf0fe3ba0d68144507565eb00637d5ce17da64d9a4c3d54f7b3c5a670`, pure
35/35 on BOTH hosts) — as the tracked `_json_escape` body: the input is
escaped in bounded 512-byte chunks; a pure chunk (no byte needing escape) is
emitted verbatim through one `case` guard, and only chunks containing an
escape byte run the same RFC 8259 substitution chain. Per-chunk work is
bounded regardless of input length or density, all bash builtins under
`LC_ALL=C`, chunk boundaries never corrupt multibyte UTF-8. Same interface,
same callers, same JSON output; the pure regression and every emission
assertion are unchanged by the algorithm swap (verified below).

The change is confined to the `_json_escape` boundary of
`torture-test/bin/tt-recorder` plus this story's new regression + evidence.
`torture-test/bin/tt-recorder.test.sh` and
`torture-test/impl-tasks/RISO-recorder-self-test-isolation.md` (RISO run
910) are untouched.

## Commands and exit codes

Working directory for every command: the worktree repo root
(`/home/igorhvr/.tamandua/worktrees/tamandua-73d5fbc9/912-b74a8b52`).

### RED — emission regression against the unmodified (pre-fix) helper

The pre-fix helper was materialized for the RED run by checking out the
defect commit's blob (`git checkout e793324d -- torture-test/bin/tt-recorder`,
sha `04ccb42…`), running the emission regression, then restoring the fixed
helper from the story working tree. The old whole recorder harness was never
executed; only the new focused emission regression drove the fixture copy.

```
$ node --test torture-test/self-tests/tier1-rjson-recorder-emission-isolation.test.ts
exit code: 1   (3 tests, 0 pass, 3 fail)
```

Full log: `red-emission-run.txt`. All three tests fail on the pre-fix
helper — the fixture's copied `_json_escape` still emits embedded/trailing
LF as raw line breaks, so the emitted cmdline/cwd JSONL records split across
physical lines and `JSON.parse` rejects them (the US-001 defect reproduced
at the emission level).

### GREEN — emission regression after the guarded chunked helper fix

```
$ node --test torture-test/self-tests/tier1-rjson-recorder-emission-isolation.test.ts
exit code: 0   (3 tests, 3 pass, 0 fail)   — run twice consecutively
```

Run 1: `green-emission-run1.txt` (exit 0). Run 2: `green-emission-run2.txt`
(exit 0) — idempotent, passes twice consecutively; every run allocates a
fresh mkdtemp fixture and exact owned children, then cleans only those
exact paths/pids. The three tests:

1. **portable (all hosts):** the fixture recorder copy's pure `_json_escape`
   round-trips empty/plain/quotes+backslash/LF variants/CRLF+tab+controls/
   Unicode/multiline framing through `JSON.parse`, with zero physical
   LF/CR bytes in the escaped output.
2. **collect_sample path (linux):** three exactly owned children — multiline
   command text in argv (child A), a multiline fixture path (LF inside a
   directory name, child B), and a fixture daemon home with a real
   `tamandua.db` (child C, db arm) — are discovered by the recorder's own
   (unchanged) boundary and emitted as one parseable JSONL line each with
   exact fields: pid/pgid/ppid, UTC ISO-8601 ts, cwd/cmdline round-tripping
   byte-exactly (LF escaped as the two-character `\n`, never a raw break),
   integer rss_kb/open_fds, and db_path/db_size_bytes/wal_size_bytes only on
   the detected-daemon record. The raw line equals the canonical JSON of the
   parsed record (no printf-format reconstruction in the test).
3. **started-recorder output-file path (linux):** `start --interval 1`
   writes `var/recorder/samples-<startedAt>.jsonl` through
   `generate_output_filename` + the statefile; after a stop the entire file
   is parsed strictly — every record is one physical line, every line
   parses, and the owned child's records carry the exact expected fields
   with the multiline cmdline escaped.

### Pure regression (US-001) still green on the tracked guarded helper

```
$ node --test torture-test/self-tests/tier0-rjson-json-escape-red-green.test.ts
exit code: 0   (4 tests, 4 pass, 0 fail)   — run twice consecutively
```

Run 1: `green-pure-run1.txt`, Run 2: `green-pure-run2.txt`. The pure
red/green regression sources the live tracked helper, so it automatically
exercises the guarded chunked algorithm: exact round trips for every
representable input, exact escape pins, zero physical LF/CR, and the long
plain/mixed 64 KiB bounded-time cases (measured ~37 ms plain / ~101 ms mixed
on this host; generous 5 s ceiling asserted, separating the bounded class
from the per-byte blowup).

### Bash-3.2 (Linux build) smoke of the tracked guarded helper

```
$ node /tmp/rjson-b32-probe.mjs   (sources the tracked helper under the
                                   retained bash 3.2.0(2) Linux build)
exit code: 0
```

Log: `bash32-tracked-helper-probe.txt` — 8 pure round-trip cases + the dense
47,500-byte mixed record used in the coordinator Mac red: **96.1 ms** on the
Linux bash-3.2 build, exact round trip, escaped output 55,000 bytes with no
physical line breaks. This is a Linux bash-3.2 compatibility/performance
smoke only; actual Darwin Bash 3.2.57 execution is NOT claimed as passed
here (the coordinator owns the Mac recheck of the committed helper).

### Static portability lints (separate commands, all exit 0)

```
$ node --test torture-test/self-tests/tier0-bash32-compat-lint.test.ts      → 0
$ node --test torture-test/self-tests/tier0-gnu-portability-lint.test.ts    → 0
$ node --test torture-test/self-tests/tier0-macp5-gnu-ism-sweep.test.ts     → 0
$ node --test torture-test/self-tests/tier0-procfs-portability-lint.test.ts → 0
$ node --test torture-test/self-tests/tier0-home-literal-portability-lint.test.ts → 0
```

Full logs for the four non-self-referential lints:
`lint-tier0-bash32-compat-lint.txt`, `lint-tier0-gnu-portability-lint.txt`,
`lint-tier0-macp5-gnu-ism-sweep.txt`, `lint-tier0-home-literal-portability-lint.txt`.
(The tier0-procfs-portability-lint output log is intentionally NOT stored in
this evidence directory: that lint scans every tracked file under
torture-test/ for the procfs-mount literal, and its own node --test output
spells that literal in its MUTATION test-case names — a committed copy of
the log would be a self-referential artifact the lint must then allowlist.
The command and its exit code above are the record.)

### Typecheck / build

```
$ npm run build
exit code: 0
```

Log: `typecheck-build.txt`.

### Full TEST_CMD suite

`npm test` (both lanes, isolation guard enabled) on the final committed
tree: serial lane PASSED, parallel lane PASSED, exit 0. Recorded in the
run ledger by the tamandua-test shim; the real run is not cache-replayed.

## Retained earlier-session diagnostic

`zz-probe.test.ts` (an untracked diagnostic probe from the earlier US-002
draft session that reproduced the node spawn argv0 double-prepend
observation documented in the emission regression) is preserved byte-for-byte
in this evidence directory as `zz-probe-retained-source.txt`; an exact
copy also lives in the coordinator diagnostics at
`native-signal-probes.DHNQbp/resume-preexisting-files.8D4sBx/zz-probe.test.ts`.
It is scratch, not suite content: no tier prefix, no assertions, never
executed by `self-tests/run.sh`.

## Scope

Changed under torture-test/ only: the `_json_escape` boundary of
`torture-test/bin/tt-recorder` (guarded chunked algorithm, same interface,
same callers, no discovery / rotation / start-stop / sample-field /
error-behavior changes), the new regression
`torture-test/self-tests/tier1-rjson-recorder-emission-isolation.test.ts`,
and this evidence directory. `torture-test/bin/tt-recorder.test.sh` and
`torture-test/impl-tasks/RISO-recorder-self-test-isolation.md` are
untouched. No product source, no npm dependency, no public knobs.
