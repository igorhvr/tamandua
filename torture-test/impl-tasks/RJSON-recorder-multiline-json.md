# RJSON: valid, lossless recorder JSON string escaping

## Authority and narrow scope

Beads: tamandua-0j7.4.2. This is a suite-only repair under Igor's standing
autonomous torture-test authorization. Use dsh and the normal Tamandua
worktree/verification/merge workflow. Change files only under torture-test/.

RISO run 910 separately owns the legacy recorder shell self-test's filesystem,
process, and listener isolation. Do not edit that harness or its RISO task,
change its safety requirements, or execute the unsafe legacy harness here.
This task owns the recorder's JSON escaping defect and focused new regressions.

## Independently confirmed defect

At main e5fae1fbb061107aa9ec12b722343904fd6cc36b, the source file
bin/tt-recorder has SHA256
04ccb4292100f4cbe638033ce10feb74891cf41d16a6143ebbfdfa12ba6e454b.
The coordinator extracted only its pure `_json_escape` function and invoked it
on synthetic strings. Embedded LF and trailing LF remain literal line breaks;
wrapping the output as a JSON string causes JSON.parse to reject it. Plain,
quote/backslash, tab, and CR controls passed. The current line-oriented text
filter never sees the line separators that its LF substitution intends to fix.

Raw proof: var/review-logs/recorder-json-d5tieP/reproduction.log. No runtime
was sourced, host processes scanned, listeners contacted, or state modified
for that proof. Both discover_processes and collect_sample use this helper
for cwd/cmdline, so ordinary multiline shell arguments can corrupt JSON/JSONL.

## Two bounded stories, one acceptance gate each

### US-001: smallest portable escaping repair and pure red/green proof

Replace only the faulty JSON-string escaping boundary, retaining its existing
function interface and callers. Produce valid JSON string content and preserve
the input exactly for strings representable in shell variables: empty/plain,
quotes, backslashes, leading/embedded/trailing and consecutive LF, CRLF, tab,
other C0 controls except NUL, DEL, and non-ASCII Unicode. NUL cannot be carried
in a shell variable; state that limitation instead of inventing a passing test.
Escape controls as JSON rather than silently dropping them or replacing them
with question marks. Preserve JSONL's one-physical-line-per-record contract.

Keep this small, dependency-free, and compatible with the existing Linux and
Darwin shell requirements, including the system Bash 3.2 on Darwin. Avoid a
new external runtime process per field when shell builtins can do the job.
Do not add public knobs, change discovery scope, sample fields, rotation,
start/stop semantics, production exclusion, or error/lifecycle behavior.

Add a focused automated regression that exercises the actual helper, not a
copied rewrite. It must fail on the old helper for the confirmed LF inputs
and pass after the fix with exact JSON.parse round trips. Cover the empty
string, mixed escapes, all representable control boundaries, Unicode, and
multiline framing. Reading/extracting the helper is safe; never run the old
whole recorder harness to obtain a red result. Keep the guard enabled and
tests independent of user state. Gate: focused pure red/green regression.

### US-002: actual emission framing, isolation, and evidence

Add a focused emission-level regression against the actual recorder output
path using a freshly allocated synthetic fixture and an exactly owned child.
Provide a controlled discovery boundary selecting only that child, so there
is no host-wide process scan or production-port observation. Exercise
multiline command text (and a multiline fixture path where supported), parse
all emitted JSON/JSONL, and assert exact expected fields and one physical
line per record. Do not merely reconstruct the printf format in the test.

Keep pure-helper tests portable across Linux and Darwin. If actual emission
depends on Linux-only observations, mark that applicability honestly while
still executing the portable round trips on both hosts. Own every test path
and child handle; no inherited cleanup roots, stale-PID signals, broad kills,
or deletion of pre-existing state. Retain useful failure evidence.

Gate: the focused isolated emission regression plus relevant existing static
portability lints, run as separate test commands. Record commands, source
tree, exit codes, red/green distinction, platform applicability, and results
under torture-test/. Do not claim deferred Mac execution as already passed.

## Workflow boundaries

- No edits outside torture-test/, no npm dependency changes, and no product
  feature or behavior changes. Do not edit RISO's harness or task record.
- No real campaigns, paid e2e, shared-port torture battery/tier ladder,
  credential access, live daemon lifecycle control, or catalog refresh.
- Build only this run's worktree. Normal workflow npm validation remains
  required: both lanes green, isolation guard enabled, no violations. Allow
  at least 30 minutes at the command runner level; do not disguise failures.
- Preserve campaign evidence, other worktrees, and all pre-existing files.
  Any test cleanup must target only exact paths created by that invocation.
- Merge through the workflow to local main only. No origin push or release.
  The coordinator owns final merged recorder/battery and both-host proof.

Test command: npm test
