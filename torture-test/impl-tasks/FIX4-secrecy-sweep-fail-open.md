# Fix secrecy-sweep fail-open default: wrong golden dir + vacuous CLEAN

`torture-test/probes/secrecy-sweep.sh` (landed with the B8 held-out
probes merge) mechanically proves no probe content leaks into fixture
golden bares. Found on first post-merge review (2026-08-01):

1. **Wrong default golden dir.** `DEFAULT_GOLDEN_DIR` is
   `torture-test/var/golden`, but every fixture builder writes to
   `torture-test/var/fixtures/golden/` (where `--golden-dir` makes the
   sweep work today: 6 fixtures scanned, 0 leaks). With no flag, the
   sweep scans a directory that never exists.
2. **Vacuous CLEAN.** With the golden dir missing or empty it prints
   "This is expected if golden bares haven't been created yet" and
   exits 0 with "CLEAN: 0 fixtures scanned". A sweep that scanned
   nothing must NOT report clean — same fail-open class as the
   fixture-baselines gaps being fixed in FIX3 (spec 03-oracles.md O17
   philosophy: absence of evidence is failure, not success).

## Deliverables

1. In `torture-test/probes/secrecy-sweep.sh`:
   - Default `--golden-dir` to `torture-test/var/fixtures/golden`.
   - Missing golden dir OR zero `*.git` fixtures scanned → distinct
     error message + non-zero exit (pick an exit code consistent with
     the probe contract in `torture-test/probes/README.md`; document
     it in the usage text). Remove the "this is expected" soft-pass.
2. Extend the sweep's inline self-tests (currently 8): empty dir fails,
   missing dir fails, populated dir still CLEAN. Green twice
   consecutively.
3. If anything else invokes secrecy-sweep.sh (grep torture-test/ for
   callers, e.g. validate-all.sh or controller cases), confirm callers
   still pass the right dir or rely on the corrected default.

## Hard constraints

- Files ONLY inside `torture-test/`; nothing outside.
- Do not weaken the leak checks; behavior with a populated dir must be
  unchanged (6 fixtures scanned, 0 leaks on this machine today).

## Acceptance (verify before reporting done)

- Bare `bash torture-test/probes/secrecy-sweep.sh` on this machine:
  scans the 6 built fixtures and reports CLEAN, exit 0.
- With `--golden-dir` pointed at an empty temp dir: non-zero exit,
  message names the zero-fixtures condition.
- Self-tests green twice consecutively.
