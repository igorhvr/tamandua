# CORE US-001 — versioned recording/adaptation contract module: retained evidence

Beads tamandua-6sy.7 / tamandua-6sy.7.1 (bounded slice CORE-1, story US-001).
Run `44a89543-a4fb-485a-8b14-06ca2d55bbe8` (workflow
`feature-dev-merge-worktree`, Linux dsh implementation run). Branch
`feature/core-recording-import`.

This pack documents the committed recording proof for the ONE story of this
bounded slice: the minimal versioned recording/adaptation contract module
plus its pure format/validation regression gate. It implements ONLY CORE
US-001. US-002 (explicit read-only capture/sanitization importer) and the
rest of the original parent remain open for replay, cells, entrypoint/review
integration and campaign acceptance. No real scenario/recorder/daemon/model
execution occurred in this story's gates; no R4a/full-CORE acceptance is
claimed here.

## Tested source files (commit `4d10a904`, US-001 — the tree under test)

| File | SHA256 |
|---|---|
| `torture-test/bin/core-recording-contract.mjs` | `686d78da29ea686e07d8ec293ad15f49a3a757f3d1349402ae65817b8d79af29` |
| `torture-test/self-tests/tier0-core-recording-contract.test.ts` | `7056442455d4fbb866492e677586250f342f3b55aff3c1c00a5831f74790282f` |

Tested source tree: commit `4d10a904c9ca41269bcbcb748c1ba335fb6d8835`
(`git rev-parse HEAD` = `4d10a904c9ca41269bcbcb748c1ba335fb6d8835`, tree
`e25812aced22712b589676454dc5fbeae26af396` at validation time — the tree
whose focused gate and full `npm test` passed in this run). The evidence
commit adds only this documentation directory on top of that tree (no code
change).

## What US-001 delivers

- `torture-test/bin/core-recording-contract.mjs` — a NEW pure ESM module
  exporting exactly `RECORD_FORMAT_VERSION` (=1), `hashText(text)` (sha256
  hex), `buildRecordingRecord({sourceIdentity, observations, transformations,
  operations, expectedOutcomes, unknown})` (returns a DEEP-FROZEN versioned
  JSON record with deterministic `payloadSha256` over canonical JSON), and
  `validateRecordingRecord(record)` (`{ok:true}` | `{ok:false,errors:[...]}`).
- Format semantics implemented and pinned by the gate:
  - `sourceIdentity` carries `kind` (`pi`|`dsh`|`hermes`), `runId`, optional
    `caseId`, explicit `sourceRefs` locators and `sourceSha256`.
  - observations = captured public facts; transformations = exactly which
    sanitization/derivation steps occurred (e.g. `redact field X ->
    sanitized`); operations = typed fixture op codes (generalized shell text
    rejected); expectedOutcomes = mechanical outcomes; unknown = explicit
    `{fact, reason}` with `reason` in `unreadable|truncated|malformed|
    ambiguous|missing`.
  - Validation recomputes and compares `payloadSha256` (corrupt-hash error
    NAMES the mismatch), enforces referential integrity (every
    observation/operation/expectedOutcome `sourceRef` must resolve to a
    declared locator, else missing-source), rejects mixed-run claims (any
    section/locator `runId` differing from the record `runId`), rejects
    incomplete claims (operation/expectedOutcome `evidenceRefs`/`operationRef`
    pointing at absent observations/operations), and ACCEPTS records with
    explicit unknown entries, surfacing them as labeled unknowns
    (`classification: "unknown"`) — never silently dropped, never invented
    into fake certainties.
  - Purity: imports only `node:crypto`; the file contains no
    eval/Function/child_process constructs and no import outside node
    builtins (grep-checked by the gate itself). No new dependency
    (package.json / package-lock.json byte-identical to HEAD).
- `torture-test/self-tests/tier0-core-recording-contract.test.ts` — the ONE
  designated focused regression gate (23 passing assertions): interface pin +
  module-purity grep; positive record validates; deep-frozen deterministic
  record; corrupt-hash rejected NAMING the mismatch; payload edit without
  hash update rejected; missing-source rejected (undeclared locator and
  absent sourceRef); mixed-run rejected (section-runId and locator-runId
  variants); incomplete-claim rejected (absent evidence observation and
  absent operation); unknown-evidence record ACCEPTED with labeled surfaced
  unknowns; zero-unknown record validates to exactly `{ok:true}`; unsupported
  version / bad kind / bad unknown reason / duplicate locator / non-array
  section / shell-text operation type fail closed; non-object records
  rejected; builder TypeError on structural misuse. All fixtures are
  SYNTHETIC (run/case ids like `run-synth-a-…`, locators, sha256 hashes,
  facts) — no row, credential, private-reasoning or operator-specific
  content from the ORIGINAL inventory was copied into shipped files.

## Source inventory shape reference (read-only, nothing copied)

The coordinator's retained source review
(`torture-test/var/review-logs/core-recording-source-ZFANtD/` in the ORIGINAL
checkout, outside this worktree) was consulted ONLY as a shape reference for
the public vocabulary — run ids, case ids, explicit record/call locators,
sha256 hashes, exit codes, timestamps, event types — via explicitly selected
`rcnt-interpretation.jsonl`, `tcmd-three-interpretation.jsonl`,
`phnt-interpretation.jsonl` and one native-source-index/inspector pair. No
full-HOME crawl, no newest-session guessing, no real rows were imported.
Private locators stay in retained ignored evidence only; operator-specific
absolute paths do not appear in any shipped/tracked file.

## Commands and exit codes (UTC/Z)

Working directory for every command: the worktree repo root. Exit codes are
the tested command's own exit (captured directly; complete outputs retained,
no tail/tee false-green). Host: Linux, node v24.18.0, native signal
isolation (landlock) enabled, test isolation guard enabled (never disabled).

```
$ git status --porcelain                                     (clean, at 4d10a904)   exit: 0
$ node --test torture-test/self-tests/tier0-core-recording-contract.test.ts   (designated focused gate, run 1, 2026-09-08T20:13:48Z)  exit: 0  (23 tests, 23 pass)
$ node --test torture-test/self-tests/tier0-core-recording-contract.test.ts   (designated focused gate, run 2, 2026-09-08T20:13:51Z)  exit: 0  (23 tests, 23 pass)
$ npm run build                                                              (2026-09-08T20:13:54Z)  exit: 0
$ npx tsc --noEmit --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --strict --types node --erasableSyntaxOnly torture-test/self-tests/tier0-core-recording-contract.test.ts   (2026-09-08T20:13:20Z)  exit: 0
$ npm test   (canonical TEST_CMD via tamandua-test ledger shim, under the shared flock, env TAMANDUA_PI_BINARY=/usr/bin/false TAMANDUA_HERMES_BINARY=/usr/bin/false TAMANDUA_DSH_BINARY=/usr/bin/false; started 2026-09-08T20:02:33Z, completed with exit 0 — serial + parallel lanes PASSED)   exit: 0
```

Each torture self-test file ran individually — never multiple torture
self-test files in one `node --test` invocation. The full `npm test` ran on
the clean committed tree under the EXISTING shared coordinator flock lock
(`…/torture-test/var/review-logs/suite-cleanup-prefix-5nLG3O/linux-npm.lock`;
the lock file already existed and was never unlinked or recreated). Commit
`4d10a904` preceded the npm gate; no tracked edits were made while the suite
was queued/running. Canonical TEST_CMD stays exactly `npm test` through the
`tamandua-test` content-addressed ledger shim with correct run/step
attribution (output begins `TAMANDUA-TEST: expect ~16min …`, then the npm
test producer output; exit 0 recorded).

## Retained full evidence (gitignored — exact paths, with sha256)

All gate outputs are retained (fresh dir, never overwritten, nothing
preexisting under review-logs touched) at:

```
torture-test/var/review-logs/core-us001-20260908T200100Z-run-44a89543/
```

| File | SHA256 |
|---|---|
| `focused-gate.log` | `eb793bfb3a641ff85f13626beccad627b21767ce10364ad989cda19d75de86d6` |
| `focused-gate-run2.log` | `f4fb7936ec4e0f60add2b5c9a67e993e9fea74179d339f577115f32fb21535d4` |
| `npm-build.log` | `80e6c40904bd03343ece39627ef21ee06a5101c2947d2fcacb7cca53482ae67c` |
| `npm-test.log` | `c3123adde827db845427332e8d7a6966439bc61fedb820d8ac6ed86b14ba57c7` |
| `tsc-standalone.log` | `acee5d155ce7861cd6c1c9b1b53a298c4d39eeea6dba71aca3ff015885b5705f` |

The retained npm-test.log is the COMPLETE producer output (serial + parallel
lanes), including the ledger shim preamble and the npm test suite stream.

## Isolation / safety facts

- Implementation confined to `torture-test/`: `git status --porcelain`
  before the evidence commit shows exactly
  `torture-test/bin/core-recording-contract.mjs` and
  `torture-test/self-tests/tier0-core-recording-contract.test.ts`.
- `package.json` / `package-lock.json` byte-identical to HEAD
  (`git diff HEAD -- package.json package-lock.json` empty).
- Native signal isolation and the test guard were NOT disabled; no real
  scenario/recorder/daemon/model execution; no paid canaries; no real e2e;
  no Matchlock work; no storm (including interim slices).
- No `rm -rf`, wildcard/fixed-path removals, git reset/discard/prune,
  git-config changes, origin pushes, or deletion/modification of any
  preexisting file under the review-logs tree.
- The module never executes recorded shell text and never imports
  credentials/private reasoning. Synthetic sentinels only (US-002 fixtures
  will follow the same rule).

## Honest limits / remaining parent dependencies

- This story proves the PURE format/validation contract only. It does NOT
  implement or claim US-002 (explicit read-only capture/sanitization
  importer), US-003+ (replay adapter, TCMD/BRUN/RVOC/RCNT/PHNT recorded
  cells, frequent-gate entrypoint), or full CORE acceptance — those remain
  on the open parent (tamandua-6sy.7) for replay, cells, entrypoint/review
  integration and campaign acceptance.
- No real source-backed cell is imported or replayed here; real reviewer
  echo / campaign acceptance is separately owed.
- UTC/Z timestamps: full `npm test` ran 2026-09-08T20:02:33Z–~20:13Z
  (exit 0); focused gate runs 1+2 at 20:13:48Z/20:13:51Z; `npm run build`
  at 20:13:54Z; standalone tsc at 20:13:20Z (all per-file headers in the
  retained logs).
