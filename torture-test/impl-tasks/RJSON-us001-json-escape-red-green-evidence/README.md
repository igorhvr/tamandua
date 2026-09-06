# RJSON US-001 — pure red/green evidence: `_json_escape` repair

Beads tamandua-0j7.4.2. Story US-001 of run b74a8b52 (branch
`feature/rjson-recorder-json-escaping`): repair the faulty JSON-string
escaping boundary of `torture-test/bin/tt-recorder`'s `_json_escape` and
prove it with a focused pure regression against the actual helper.

## Tested source trees

| Phase | Source tree | `torture-test/bin/tt-recorder` SHA256 |
|---|---|---|
| RED (pre-fix) | story commit with the defect blob checked out over the helper (`git checkout e793324d -- torture-test/bin/tt-recorder`); the regression file is the committed one | `04ccb4292100f4cbe638033ce10feb74891cf41d16a6143ebbfdfa12ba6e454b` |
| GREEN (post-fix) | story commit (working tree as committed, bounded-pass helper) | `0e2c937fc11728dad48a49e09172ce868dd9e4dc51e359cb10ec766b6c7a7e46` |

Platform executed on: Linux (bash 5.3.9, node v24.18.0). The repaired helper
is a pure-builtin byte-wise scan written to the system-Bash-3.2 feature set
and is covered by the bash-3.2 / GNU-ism / procfs / home-literal portability
lints below; no Darwin/Mac execution happened in this story, and none is
claimed as passed here.

Isolation guard: every proof command below ran with the test isolation guard
ENABLED. The regression spawns only `bash` children that inherit the runner's
environment untouched (no `TAMANDUA_TEST_GUARD=0`, no `NODE_TEST_CONTEXT`
removal); the child executes pure builtins against argv data and never
imports tamandua modules or touches tamandua state, so nothing trips the
guard.

## Commands and exit codes

Working directory for every command: the worktree repo root.

### RED — regression against the unmodified (broken) helper

The pre-fix helper was materialized for the RED run by checking out the
defect commit's blob (`git checkout e793324d -- torture-test/bin/tt-recorder`,
sha `04ccb42…`), running the regression, then restoring the fixed helper from
HEAD. The old whole recorder harness was never executed.

```
$ node --test torture-test/self-tests/tier0-rjson-json-escape-red-green.test.ts
exit code: 1   (3 tests, 0 pass, 3 fail)
```

Failure excerpt (full log: `red-pre-fix-guard-enabled.txt`):

```
✖ round-trips every representable input exactly through JSON.parse
  AssertionError: leading LF: escaped output contains a physical line-break
  byte: "\nlead"
✖ escapes every C0 control and DEL losslessly in one sweep
  AssertionError: full C0 + DEL sweep: escaped output contains a physical
  line-break byte: "???????\b\t\n?\f\r??????????????????"
✖ emits exactly one physical output line for multiline framing
  AssertionError: multiline framing: escaped output contains a physical
  line-break byte: "first \"line\" \\ here\nsecond line\r\nthird\ttabbed\n"
```

The confirmed LF defect reproduces exactly: embedded/leading/trailing LF
survive as literal line breaks (the line-oriented sed filter never sees
them), and the remaining C0 controls come out as `?` (lossy).

### GREEN — regression after the `_json_escape` boundary fix

```
$ node --test torture-test/self-tests/tier0-rjson-json-escape-red-green.test.ts
exit code: 0   (4 tests, 4 pass, 0 fail)   — run twice consecutively
```

Run 1: `green-run1.txt` (exit 0). Run 2: `green-run2.txt` (exit 0) —
idempotent, passes twice consecutively. Round trips are exact through
`JSON.parse('"' + escaped + '"')` for: empty string, plain ASCII, double
quote, backslash, quote+backslash mix, single quote passthrough, leading /
embedded / trailing / consecutive LF, CRLF, CR, tab, C0 boundaries
(0x01, 0x07, 0x0b VT, 0x0e, 0x1f), DEL 0x7f, the full C0 (0x01–0x1f) + DEL
sweep, non-ASCII UTF-8 multibyte text, a kitchen-sink multiline record, and
trailing LF after Unicode. Exact escape pins: `\b \t \n \f \r \" \\ \u0001
\u001f \u007f`; escaped output contains zero physical LF/CR bytes (JSONL
one-physical-line-per-record contract). NUL (0x00) cannot be carried in a
shell variable; the helper states that limitation in a comment and no fake
NUL test exists.

### Performance (coordinator review, 2026-09-04T23:43Z)

A mid-review of the first repair (commit `aebf9e3a…`) found the byte-wise
substring/append loop too slow for the recorder's ~5 s sampling budget (one
bash statement per input byte). Measured on this Linux host with the helper
sourced in `bash`:

| Input | original sed helper | byte-loop helper (rejected) | bounded-pass helper (landed) |
|---|---|---|---|
| 1 KiB plain | 2 ms | 12 ms | ~2 ms |
| 8 KiB plain | 2 ms | 167 ms | ~3 ms |
| 32 KiB plain | 2 ms | 2 070 ms | ~5 ms |
| 64 KiB plain | 3 ms | 8 601 ms | ~11-15 ms |
| 64 KiB mixed-escape | — | >5 000 ms ceiling | ~42-44 ms |

The landed helper performs one whole-string `${s//pat/rep}` pattern
substitution per escape byte — 34 passes at most, independent of input
length (a bounded pass count), all bash builtins under `LC_ALL=C`, with `\`
doubled first so later-introduced backslashes are never re-doubled. The
regression's long-input test (plain and mixed-escape 64 KiB) records its own
measured timings in the test output (`green-run1.txt`: 14.5 ms plain /
43.8 ms mixed) and asserts only a generous 5 s ceiling that separates the
bounded-pass class from the per-byte blowup — no tight machine-dependent
timing assertions. Fields are never truncated, bytes never dropped, JSON
framing is unchanged, and the recorder interval is untouched.

### Static portability lints (separate commands, all exit 0)

```
$ node --test torture-test/self-tests/tier0-bash32-compat-lint.test.ts      → 0
$ node --test torture-test/self-tests/tier0-gnu-portability-lint.test.ts    → 0
$ node --test torture-test/self-tests/tier0-macp5-gnu-ism-sweep.test.ts     → 0
$ node --test torture-test/self-tests/tier0-procfs-portability-lint.test.ts → 0
$ node --test torture-test/self-tests/tier0-home-literal-portability-lint.test.ts → 0
```

Full logs: `lint-tier0-bash32-compat-lint.txt`, `lint-tier0-gnu-portability-lint.txt`,
`lint-tier0-macp5-gnu-ism-sweep.txt`, `lint-tier0-home-literal-portability-lint.txt`.
(The tier0-procfs-portability-lint output log is intentionally NOT stored in
this evidence directory: that lint scans every tracked file under
torture-test/ for the procfs-mount literal (slash followed by `proc`), and
its own node --test output spells that literal in its MUTATION test-case
names — a committed copy of the log would be a self-referential artifact the
lint must then allowlist. The command and its exit code above are the record;
the verifier re-runs the lint on the tree.)

## Scope

Changed under torture-test/ only: the `_json_escape` boundary of
`torture-test/bin/tt-recorder` (same interface, same callers, no discovery /
rotation / start-stop / sample-field / error-behavior changes) plus this new
regression file `torture-test/self-tests/tier0-rjson-json-escape-red-green.test.ts`
and this evidence directory. `torture-test/bin/tt-recorder.test.sh` and
`torture-test/impl-tasks/RISO-recorder-self-test-isolation.md` (RISO run 910)
are untouched. No product source, no npm dependency, no public knobs.
