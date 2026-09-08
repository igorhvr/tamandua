# CORE US-002 — explicit read-only capture/sanitization importer: retained evidence

Beads tamandua-6sy.7 / tamandua-6sy.7.1 (bounded slice CORE-1, story US-002).
Run `44a89543-a4fb-485a-8b14-06ca2d55bbe8` (workflow
`feature-dev-merge-worktree`, Linux dsh implementation run). Branch
`feature/core-recording-import`.

This pack documents the committed capture/sanitization proof for the SECOND
story of this bounded slice: the explicit safe read-only importer that reads
selected pi JSONL / dsh compressed-JSONL (post-decompression row shapes) /
Hermes native public rows, hashes an explicitly ordered public-field
projection in a single read, never selects reasoning/auth fields or emits
full credential-bearing prompts, retains call/result linkage and redaction
evidence, and fails closed on unsupported shapes or incomplete reads — proven
with synthetic sentinel fixtures and no real account inputs. It implements
ONLY CORE US-002 (depends on US-001's committed contract module,
`torture-test/bin/core-recording-contract.mjs`). US-003+ and the rest of the
original parent remain open for replay, cells, entrypoint/review integration
and campaign acceptance. No real scenario/recorder/daemon/model execution
occurred in this story's gates; no R4a/full-CORE acceptance is claimed here.

## Tested source files (commit `365b24ad`, US-002 — the tree under test)

| File | SHA256 |
|---|---|
| `torture-test/bin/core-recording-import.mjs` | `8ed4222568b24aed8f86eae9bfee84e0f9e4eca206691fa2b6fac385d5683127` |
| `torture-test/self-tests/tier0-core-recording-capture-sanitize.test.ts` | `c8c0ba439f594240e2e13974c5591e3bbd3287cf32942308f84f0b9cddae96b2` |

Tested source tree: commit `365b24ad8b35745a46aff3d30dc869f141c8cb1f`
(`git rev-parse HEAD` = `365b24ad8b35745a46aff3d30dc869f141c8cb1f`, tree
`2394db2a11cf8ac17f554136f3203a9de62ffe47` at validation time — the clean
committed tree whose focused gate, `npm run build` and full `npm test`
passed). The evidence commit adds only this documentation directory on top of
that tree (no code change).

## What US-002 delivers

- `torture-test/bin/core-recording-import.mjs` — a NEW pure ESM module that
  imports the US-001 contract module (`./core-recording-contract.mjs`) and
  exports exactly `parsePublicProjection`, `sanitizeProjection`,
  `hashPublicProjection` and `captureRecording` (interface pinned by the
  gate):
  - `parsePublicProjection({origin, input, session, publicFieldOrder})`:
    `origin` in pi|dsh|hermes; `input` is an EXPLICIT caller-owned synthetic
    file path or an array of parsed rows; `session` is an EXPLICIT session
    identity. Returns an ordered public-field projection (one entry per
    input row, in input order) over exactly the caller's ordered extractable
    public fields, with retained call/result linkage and a single-read
    snapshot note.
  - `sanitizeProjection(projection, {sentinels})` -> `{sanitized,
    redactions:[{fieldPath, reason, replacedWith}]}`: scrubs declared literal
    sentinels AND built-in generic credential shapes (private-key blocks,
    sk-/pk-/ghp-/gho-/xox-/AKIA-/AIza-shaped tokens, Bearer tokens,
    password/token/secret/api-key assignments, tagged hidden-reasoning
    spans) from every captured public value.
  - `hashPublicProjection(projection)`: deterministic sha256 over the
    explicitly ordered public-field projection (origin, session, declared
    field order, then each row's public values in order with explicit
    `<absent>` markers); identical projections hash identically and ANY
    ordered public-field change flips the hash. It is a single-read snapshot
    — never an immutable hash of a concurrently changing whole DB/stream
    (stated honestly in the projection and record).
  - `captureRecording({...})` -> a deep-frozen US-001 versioned record that
    DISTINCTLY labels captured public output vs sanitized derivative vs
    synthetic adaptation vs unknown data (observations carry
    `classification: "captured" | "sanitized" | "synthetic"`; unknown data
    lives in the US-001 `unknown[]` section and is surfaced as
    `classification: "unknown"` by `validateRecordingRecord`), embedding
    source identity (kind/runId/caseId/sourceRefs/sourceSha256 including the
    ordered-projection hash and the sanitized-derivative hash as locator
    digests), redaction evidence (transformations), retained call/result
    linkage and accepted reports.
  - Fail-closed with useful diagnostics on: unknown origin; missing
    input/session argument; unsupported row shapes (unknown pi message shape,
    non-text dsh chunk, unknown dsh event type, unknown hermes role, invalid
    tool_calls JSON, multi-item content, reasoning-typed content items);
    unreadable / empty / truncated input; ambiguous attribution
    (row-declared session identity mismatch, duplicate call ids); and
    public-field requests that are denied (reasoning/auth-flavoured names)
    or not extractable. Records are self-validated with the US-001 contract
    before being returned — never a partial or unlabeled record.
  - Purity: imports only node builtins (`node:fs`, read-only) plus the US-001
    contract module; the file contains no subprocess spawning, no dynamic
    code evaluation and no import outside that set (grep-checked by the gate
    itself). No new dependency (package.json / package-lock.json
    byte-identical to HEAD).
- `torture-test/self-tests/tier0-core-recording-capture-sanitize.test.ts` —
  the ONE designated focused regression gate (17 passing assertions) with
  synthetic corpus builders for all three origins (pi message rows, dsh
  post-decompression session events, Hermes native public-row shapes)
  carrying synthetic private sentinels (fake BEGIN PRIVATE KEY blocks, sk-/
  ghp-shaped fake tokens, Bearer/auth/password assignments, tagged hidden
  reasoning, a declared arbitrary secret). Assertions cover: interface pin +
  module purity grep; projection structure; (a) no sentinel in sanitized
  outputs or emitted records with redaction evidence present; (b)
  deterministic ordered-projection hashing that changes with any ordered
  public-field change (value, presence, order); (c) distinct honest
  captured/sanitized/synthetic labels plus surfaced unknown labels; (d) the
  full fail-closed matrix; (e) structural no-reasoning/auth sweep over
  projections and records plus denied-name refusal; (f) US-001
  `validateRecordingRecord` accepts every emitted record; linkage/report
  retention with explicit unknowns for cross-file unresolved calls; and a
  caller-owned temp-file input path (valid file, unreadable path, empty and
  truncated files). All fixtures are SYNTHETIC — no row, credential,
  private-reasoning or operator-specific content from the ORIGINAL inventory
  was copied into shipped files.

## Source inventory shape reference (read-only, nothing copied)

The coordinator's retained source review
(`torture-test/var/review-logs/core-recording-source-ZFANtD/` in the ORIGINAL
checkout, outside this worktree) was consulted ONLY as a shape reference for
the public vocabulary — run ids, call ids, command sha256 hashes, exit codes,
timestamps, dsh event types (session, turn/start, step/start,
assistant/chunk, turn/end, ...), Hermes messages-table columns, single-read
DB-snapshot semantics — via explicitly selected files
(`brun-native-error-source.jsonl` + `brun-retained-session-inspector.txt`,
and `*-native-source-index.jsonl` / `*-native-inspector.txt` pairs). No
full-HOME crawl, no newest-session guessing, no real rows were imported;
fixtures model the vocabulary synthetically. Private locators stay in
retained ignored evidence only; operator-specific absolute paths do not
appear in any shipped/tracked file.

## Commands and exit codes (UTC/Z)

Working directory for every command: the worktree repo root. Exit codes are
the tested command's own exit (captured directly; complete outputs retained,
no tail/tee false-green). Host: Linux, node v24.18.0, native signal
isolation (landlock) enabled, test isolation guard enabled (never disabled).

```
$ git status --porcelain                                     (clean, at 365b24ad)   exit: 0
$ node --test torture-test/self-tests/tier0-core-recording-capture-sanitize.test.ts   (designated focused gate, run 1, 2026-09-08T20:43:27Z)  exit: 0  (17 tests, 17 pass)
$ node --test torture-test/self-tests/tier0-core-recording-capture-sanitize.test.ts   (designated focused gate, run 2, 2026-09-08T20:43:31Z)  exit: 0  (17 tests, 17 pass)
$ npx tsc --noEmit --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --strict --types node --erasableSyntaxOnly torture-test/self-tests/tier0-core-recording-capture-sanitize.test.ts   (2026-09-08T20:43:36Z)  exit: 0
$ npm run build                                                              (2026-09-08T20:44:03Z)  exit: 0
$ npm test   (canonical TEST_CMD via tamandua-test ledger shim, under the shared flock, env TAMANDUA_PI_BINARY=/usr/bin/false TAMANDUA_HERMES_BINARY=/usr/bin/false TAMANDUA_DSH_BINARY=/usr/bin/false; started 2026-09-08T20:44:12Z, completed 2026-09-08T20:54:47Z with exit 0 — a real fresh run, not a cache replay (log begins "TAMANDUA-TEST: expect ~16min"); serial + parallel lanes PASSED (2336 tests, 2334 pass, 2 skipped, 0 fail))   exit: 0
```

Each torture self-test file ran individually — never multiple torture
self-test files in one `node --test` invocation. The full `npm test` ran on
the clean committed tree under the EXISTING shared coordinator flock lock
(`…/torture-test/var/review-logs/suite-cleanup-prefix-5nLG3O/linux-npm.lock`;
the lock file already existed and was never unlinked or recreated). Commit
`365b24ad` preceded the npm gate; no tracked edits were made while the suite
was queued/running. Canonical TEST_CMD stays exactly `npm test` through the
`tamandua-test` content-addressed ledger shim with correct run/step
attribution; the retained npm-test.log is the COMPLETE producer output
(ledger shim preamble + serial and parallel lanes).

## Retained full evidence (gitignored — exact paths, with sha256)

All gate outputs are retained (fresh dir, never overwritten, nothing
preexisting under review-logs touched) at:

```
torture-test/var/review-logs/core-us002-20260908T204000Z-run-44a89543/
```

| File | SHA256 |
|---|---|
| `focused-gate.log` | `997b405203cbe35b658f8f86151c6a9bca63459cb284e5e0ee0c1446961f8451` |
| `focused-gate-run2.log` | `9833681987a6abcf3f35d0bd6d4a1599f24575ac93fe448cd19fb842811538fc` |
| `tsc-standalone.log` | `95f9305e784f1b5cdd1d726dd0215ea079d8fc2415cbdf5b8de39f05afa5128b` |
| `npm-build.log` | `59914b696de5a108ae78a496e879d896b28ca1ce299f0205e78bccba00cb6702` |
| `npm-test.log` | 0aa4ee05e0db6882e7b1d1a3eb9b0ed3b76818239292bf945cad067d7049747a |

## Isolation / safety facts

- Implementation confined to `torture-test/`: `git status --porcelain`
  before the feat commit shows exactly
  `torture-test/bin/core-recording-import.mjs` and
  `torture-test/self-tests/tier0-core-recording-capture-sanitize.test.ts`.
- `package.json` / `package-lock.json` byte-identical to HEAD
  (`git diff HEAD -- package.json package-lock.json` empty).
- Native signal isolation and the test guard were NOT disabled; no real
  scenario/recorder/daemon/model execution; no paid canaries; no real e2e;
  no Matchlock work; no storm (including interim slices).
- No `rm -rf`, wildcard/fixed-path removals, git reset/discard/prune,
  git-config changes, origin pushes, or deletion/modification of any
  preexisting file under the review-logs tree.
- The importer never executes captured shell text (raw commands are only
  hashed), never emits full credential-bearing prompts (operator/user
  content is never projected) and never imports credentials/private
  reasoning. Synthetic sentinels only.

## Honest limits / remaining parent dependencies

- This story proves the explicit capture/sanitization boundary ONLY, with
  synthetic fixtures. It does NOT implement or claim US-003 (safe
  deterministic replay adapter), US-004–US-007 (source-backed recorded
  cells), US-008 (frequent-gate entrypoint/integration), US-009 (bounded
  in-run integration) or full CORE acceptance — those remain on the open
  parent (tamandua-6sy.7) for replay, cells, entrypoint/review integration
  and campaign acceptance.
- Real reviewer echo / campaign acceptance is separately owed; a Hermes
  readonly-DB projection hash is a single-read snapshot, not an immutable
  hash of a concurrently changing whole DB (stated in the module and
  records). The BRUN unretained stdout byte stays an explicit unknown/
  declared-synthetic concern for the later BRUN cell story, never invented
  here.
- UTC/Z timestamps: focused gate runs 1+2 at 20:43:27Z/20:43:31Z; standalone
  tsc at 20:43:36Z; `npm run build` at 20:44:03Z; full `npm test`
  started 2026-09-08T20:44:12Z, completed 2026-09-08T20:54:47Z with exit 0 — a real fresh run, not a cache replay (log begins "TAMANDUA-TEST: expect ~16min"); serial + parallel lanes PASSED (2336 tests, 2334 pass, 2 skipped, 0 fail) (all per-file headers in the retained logs).
