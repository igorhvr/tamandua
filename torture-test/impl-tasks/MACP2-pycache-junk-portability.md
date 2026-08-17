# MACP2: __pycache__ junk probe is Darwin-broken (Apple pycache_prefix) + --provision rebuild UX

Mac parity iteration #2 remainder. Diagnosed live on the mac:

1. **tt-python@master's junk probe can never pass on macOS.** Its
   build-golden.sh (line ~282) asserts in-tree `__pycache__/` exists
   after the test run. Apple's Python builds bake in
   `sys.pycache_prefix = ~/Library/Caches/com.apple.python`, so
   bytecode caches are ALWAYS redirected out-of-tree on Darwin (
   verified: plain import + compileall both produce no in-tree
   __pycache__; dont_write_bytecode is False). Fix architecturally,
   per the E2.4 precedent (operator-notes.local): the junk must be a
   DETERMINISTIC PROVISIONING ARTIFACT, not an interpreter side
   effect —
   - builder + provisioning seed the untracked junk dir explicitly
     (byte-exact recorded content, e.g. a synthetic `__pycache__/`
     with fixed pyc-like payload OR rename the probe to a
     platform-neutral junk artifact — follow spec 02's junk-probe
     intent: untracked, agents must not commit/delete/modify,
     byte-identical after runs);
   - every assertion/oracle referencing this junk (builder checks,
     baseline verifier --expect data, O8/junk invariants, probes)
     updated consistently; goldens/hashes regenerated once with
     determinism proof (2 identical builds);
   - if genuine interpreter-generated pycache matters for some case's
     realism, generate it portably (`python -X pycache_prefix= -m
     compileall` — verify this overrides Apple's default; if it does
     not, the synthetic artifact is the only portable option).
2. **--provision rebuild UX**: "golden present but its hash ledger is
   missing" currently refuses fail-closed; give `--provision` a
   `--rebuild-invalid` mode (or auto-rebuild with a loud per-asset
   note) so stale/partial goldens self-heal instead of requiring
   manual rm — keep default fail-closed behavior unchanged.
3. Prove (linux, zero tokens): builder determinism 2x; bare --tier1
   GREEN x2; provisioning self-checks green for all fixtures incl.
   tt-python@master; junk invariants red-team test (commit/delete/
   modify the junk in a scratch clone -> oracles still catch all
   three). Darwin validation is the operator's post-merge step.

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon
  untouched. Do not weaken the junk-probe detection semantics.
- Concurrent runs own scenarios/tier2 (T2.1) and self-test kill files
  (E3.C.1) — avoid those files.

---

# ═══════════════════════════════════════════════════════════════════
# MACP2 US-001 resolution — deterministic synthetic __pycache__ junk
# ═══════════════════════════════════════════════════════════════════

Author: feature-dev-merge-worktree developer (workflow run `run-181102e6-...`)

## Decision

The tt-python / tt-python@master `__pycache__` junk probe is now a
**DETERMINISTIC PROVISIONING ARTIFACT**, not an interpreter side effect —
the same architectural shape as the E2.4 `operator-notes.local` precedent
(see `impl-tasks/E2.4-junk-probe-provisioning-contract.md`). The byte-exact
reference payload lives TRACKED in `fixtures-src/tt-python/__pycache__/`
(`junk-probe.synthetic`), is EXCLUDED from every golden commit (both
builders' rsync rules already `--exclude='__pycache__/'`), and is seeded by
the builders into their scratch clone BEFORE the junk-probe test run so the
probe never depends on the interpreter having written bytecode caches
in-tree.

### Why (Darwin diagnosis, verified on the mac)
Apple's Python builds bake in `sys.pycache_prefix =
~/Library/Caches/com.apple.python`, so bytecode caches are ALWAYS redirected
out-of-tree on Darwin. Verified live: a plain import AND `compileall` both
produce no in-tree `__pycache__`; `sys.dont_write_bytecode` is False. The old
`tt-python@master/build-golden.sh` junk-probe section (L282-292) hard-asserted
`__pycache__/` exists after the pytest run — that assertion can never pass on
macOS, so the junk probe was Darwin-broken. `tt-python/build-golden.sh` had no
junk verification at all.

### The synthetic reference (`fixtures-src/tt-python/__pycache__/junk-probe.synthetic`)
- Fixed byte-exact payload: fake pyc header (16 bytes) + stable marker bytes.
- The filename `junk-probe.synthetic` can never collide with an importable
  module name (CPython only reads `__pycache__/<module>.cpython-*.pyc` for
  modules it imports; `junk-probe.synthetic` is not such a name), so CPython
  never tries to read it.
- `fixtures-src/tt-python/.gitignore` does NOT ignore `__pycache__/` (kept
  that way — the reference must stay tracked).

### Builder contract (both tt-python and tt-python@master)
1. Seed BEFORE the test run: `mkdir -p __pycache__` + `cp` the fixtures-src
   reference into the scratch clone.
2. Run the junk-probe pytest run (fail-closed, tail surfaced — US-007).
3. Assert the seeded junk is (1) PRESENT, (2) UNTRACKED (`git ls-files
   --error-unmatch` fails), (3) BYTE-IDENTICAL to the reference (`cmp`).
4. `.pytest_cache` regenerated-junk check and `operator-notes.local` checks
   remain unchanged (`.pytest_cache` is written by pytest itself into the
   rootdir and is Darwin-safe).

No junk-probe detection semantics are weakened: committing, deleting, or
modifying the junk is still catchable (tracked-detection via
`git ls-files --error-unmatch`, presence check, byte-identity check).

## Portability evidence — `-X pycache_prefix=` behavior (verified on linux)

Recorded per the task brief (hard constraint: the architectural fix must NOT
depend on this):

- **Default (no flag):** `sys.pycache_prefix` is `None`; a plain `import`
  and `compileall` both write bytecode caches IN-TREE (`__pycache__/` next to
  the source). `sys.dont_write_bytecode` is `False`. Verified on this host
  (python 3.14, linux) with a pristine dir + `mod.py`:
  `python3 -c "import mod"` → `__pycache__/mod.cpython-314.pyc` appears
  in-tree.
- **`python3 -X pycache_prefix= -m compileall -q mod.py` (EMPTY prefix):**
  restores/keeps in-tree `__pycache__/` on this host — an EMPTY prefix means
  "no redirect", i.e. caches stay next to the source. Verified on this host
  (linux, python 3.14).
- **`python3 -X pycache_prefix=/tmp/out -m compileall` (non-empty prefix):**
  redirects bytecode caches OUT-OF-TREE to the prefix dir and produces NO
  in-tree `__pycache__` — the control case confirming the flag is the
  redirect mechanism.

**Operator's post-merge Darwin step:** whether `-X pycache_prefix=` with an
EMPTY prefix overrides Apple's baked-in `sys.pycache_prefix =
~/Library/Caches/com.apple.python` default is UNVERIFIED on Darwin and is the
operator's post-merge step. The architectural fix does NOT depend on it: the
synthetic seeded junk is the portable oracle on every platform; on hosts
where the interpreter also writes caches in-tree, those extra files are
tolerated (the seeded marker file is what the oracle checks).

## Files changed (US-001)

- `fixtures-src/tt-python/__pycache__/junk-probe.synthetic` (NEW, tracked) —
  the byte-exact synthetic reference.
- `fixtures-src/tt-python@master/build-golden.sh` — junk-probe invariants
  section now seeds the reference BEFORE the test run and asserts present +
  untracked + byte-identical (interpreter-dependence check removed).
- `fixtures-src/tt-python/build-golden.sh` — added the same seeding +
  assertions (previously had NO junk verification).
- `self-tests/tier1-macp2-builder-junk-seeding.test.ts` (NEW) — pins the
  builder junk-seeding contract (reference tracked + both builders seed +
  assert present/untracked/byte-identical).
- `self-tests/tier1-final-acceptance.test.ts` — authorizes the
  `torture-test/impl-tasks/` authoring surface (this task doc) in the
  diff-confinement allowed list.

---

# ═══════════════════════════════════════════════════════════════════
# MACP2 US-002 resolution — provisioning seeds the synthetic junk
# ═══════════════════════════════════════════════════════════════════

Author: feature-dev-merge-worktree developer (workflow run `run-181102e6-...`)

## Decision

US-001 made the BUILDERS seed the deterministic synthetic `__pycache__` junk;
US-002 does the same for PROVISIONING. `bin/tt-fixture-provision.mjs`
`armTtPython` now PLANTS `__pycache__/junk-probe.synthetic` into every
tt-python / tt-python@master work clone from the byte-exact fixtures-src
reference (fixtures-src/tt-python/__pycache__/junk-probe.synthetic) in BOTH
arming modes (prebootstrapped + raw) — probe presence never depends on the
interpreter having generated in-tree bytecode caches, so provisioning stops
failing on macOS (Apple's Python always redirects them out-of-tree).

### What changed

1. **Synthetic junk is seeded in both arming modes.** A new
   `plantSyntheticPycacheJunk` seeds the marker BEFORE the pytest cycle
   (mkdir -p + write from the reference) and a strict VERIFY-ONLY oracle
   (`verifySyntheticPycacheJunk`) checks present + untracked + byte-identical
   at plant time AND re-runs after the test cycle — so a test run that
   deleted/modified/tracked the junk is still caught. `.pytest_cache`
   verification stays prebootstrapped-only (raw has no venv).
2. **tt-python@master routes to the tt-python arm.** The armFixture dispatch
   now sends `tt-python@master` to `armTtPython` (it previously fell to
   `armGeneric`, which plants no pycache junk at all). The variant has no
   source copy of its own, so both the operator-notes and the synthetic-junk
   references fall back to the shared tt-python source — exactly like
   `plantOperatorNotes`.
3. **Fail-closed categories.** `fixture-junk-absent` (missing marker or lost
   reference) and `fixture-junk-tracked` (marker in the index) are kept; a
   NEW byte-identity category `fixture-junk-modified` fires when the marker
   is not byte-identical to the reference. No junk-probe detection semantics
   are weakened: committing, deleting, or modifying the junk is still
   catchable.
4. **junkVerified semantics.** Raw arming now reports `junkVerified: true`
   (the seeded junk IS planted and verified there); the note field clarifies
   that `.pytest_cache` regeneration is still deferred to the harness setup
   step in raw mode.

### Files changed (US-002)

- `bin/tt-fixture-provision.mjs` — armTtPython rework (seeded junk in both
  modes), `plantSyntheticPycacheJunk` / `verifySyntheticPycacheJunk`
  (exported) / `syntheticJunkReference` helpers, armFixture dispatch.
- `self-tests/tier1-fixture-provision.test.ts` — AC4 now asserts the seeded
  marker byte-identical + present + untracked (and `.pytest_cache` still
  present + untracked); the raw re-provision residue expectation includes
  the seeded `?? __pycache__/`.
- `self-tests/tier1-controller-provisioning-wiring.test.ts` — untracked-
  residue allowlist/comment covers the seeded `__pycache__` paths.
- `self-tests/tier1-e24-all-fixture-provision.test.ts` — AC1 loop asserts
  the seeded junk for tt-python + tt-python@master; AC4 re-provision expects
  exactly `?? __pycache__/` + `?? operator-notes.local`.
- `self-tests/tier1-macp2-provision-junk-seeding.test.ts` (NEW) — pins AC1
  (tt-python raw), AC2 (tt-python@master raw + prebootstrapped via shared
  reference), AC3 (fail-closed byte-identity oracle: modify/delete/track/
  drop-reference), AC4 (a golden that tracks the seeded marker fail-closes
  with fixture-junk-tracked).

### Self-test verification (zero tokens, linux)

`tier1-macp2-provision-junk-seeding` 5/5; `tier1-fixture-provision` 7/7;
`tier1-e24-all-fixture-provision` 3/3; `tier1-controller-provisioning-wiring`
5/5; `tier1-macp2-builder-junk-seeding` 4/4; `tier1-final-acceptance` 7/7
(diff confinement green); `tier1-golden-bootstrap` + `tier1-python-shim-ledger-
proof` + `tier1-fixture-provision-alias` green. `npm run build` (typecheck)
green.

---

# ═══════════════════════════════════════════════════════════════════
# MACP2 US-003 resolution — tt-poly / tt-poly-lite builders seed the
# python-subtree synthetic __pycache__ junk
# ═══════════════════════════════════════════════════════════════════

Author: feature-dev-merge-worktree developer (workflow run `run-181102e6-...`)

## Decision

US-001/US-002 made the tt-python family (builders + provisioning) treat the
`__pycache__` junk as a DETERMINISTIC PROVISIONING ARTIFACT. US-003 extends
the same architectural shape to the tt-poly and tt-poly-lite fixtures' python
subtree, closing the last place where the poly junk probe still depended on
the interpreter having generated in-tree bytecode caches: tt-poly-lite's
builder [6c] regenerated `python/__pycache__` via a pytest run and merely
TOLERATED absence, which on macOS (Apple's Python bakes in
`sys.pycache_prefix = ~/Library/Caches/com.apple.python` and ALWAYS redirects
bytecode caches out-of-tree) would silently leave `python/__pycache__`
missing and weaken the probe.

### The synthetic references
- `fixtures-src/tt-poly/python/__pycache__/junk-probe.synthetic` (NEW, tracked)
- `fixtures-src/tt-poly-lite/python/__pycache__/junk-probe.synthetic` (NEW, tracked)
- Both are byte-identical to the canonical tt-python MACP2 marker (fake pyc
  header + stable marker bytes; filename can never collide with an importable
  module name). Like operator-notes.local, the reference lives only in
  fixtures-src — both builders' Phase-1 tar rules already
  `--exclude='__pycache__'`, so it is ABSENT from every golden commit.

### Builder contract (tt-poly-lite [6c] and tt-poly [10d])
1. Seed BEFORE the junk-probe test run: `mkdir -p "$VERIFY_DIR/python/__pycache__"`
   + `cp` the fixtures-src reference.
2. tt-poly-lite still runs a quick pytest cycle afterwards to regenerate the
   interpreter-written junk (`.pytest_cache`, `.flaky_counter`) — Darwin-safe.
3. Assert the seeded junk is (1) PRESENT, (2) UNTRACKED (`git ls-files
   --error-unmatch` fails), (3) BYTE-IDENTICAL to the reference (`cmp`).
   Absence is NO LONGER tolerated — a missing marker is a hard fail
   ("MISSING — seeded junk absent (probe weakened)!").
4. `.pytest_cache` / `.flaky_counter` absence stays tolerated (interpreter
   side effects), the `python/__pycache__` NOT-gitignored check is kept in
   both builders, and the operator-notes.local checks remain.

No junk-probe detection semantics are weakened: committing, deleting, or
modifying the seeded junk is still catchable (tracked-detection via
`git ls-files --error-unmatch`, presence check, byte-identity check).

## Files changed (US-003)

- `fixtures-src/tt-poly/python/__pycache__/junk-probe.synthetic` (NEW, tracked)
- `fixtures-src/tt-poly-lite/python/__pycache__/junk-probe.synthetic` (NEW, tracked)
- `fixtures-src/tt-poly-lite/build-golden.sh` — [6c] now seeds the synthetic
  payload BEFORE the pytest cycle and hard-asserts present + untracked +
  byte-identical; the tolerated-absence loop covers only `.pytest_cache` /
  `.flaky_counter`; `python/__pycache__` NOT-gitignored check kept.
- `fixtures-src/tt-poly/build-golden.sh` — [10d] now seeds and verifies the
  python-subtree synthetic junk (present + untracked + byte-identical +
  reference-retained), keeping the operator-notes checks and the top-level
  NOT-gitignored loop.
- `self-tests/tt-poly-lite-build-golden.test.ts` — AC-9 now seeds the junk
  from the fixture reference before pytest and asserts present + untracked +
  byte-identical (not merely 'if exists').
- `self-tests/tt-poly-junk-probes.test.ts` — added seeded-junk reference
  presence/tracked/not-gitignored + byte-identity-to-canonical tests (all
  NOT-gitignored checks stay).
- `self-tests/tt-poly-structure.test.ts` — added the seeded-junk reference
  presence/tracked/not-gitignored test.
- `self-tests/tt-poly-python-subtree.test.ts` — added the both-fixtures
  reference presence + byte-identical + tracked/not-gitignored test.
- `self-tests/tt-poly-end-to-end-verification.test.ts` — AC6 now also proves
  the golden committed tree contains NO `__pycache__` (git ls-tree HEAD) while
  the fixtures-src reference is retained, and that a planted marker in a work
  clone is present + untracked + byte-identical; the Phase-10 output test
  asserts the seeded-junk verification lines.
- `self-tests/tier1-macp2-poly-builder-junk-seeding.test.ts` (NEW) — pins the
  poly builder junk-seeding contract (AC1 references tracked/byte-identical,
  AC2 both builders seed + assert, AC3 absence no longer tolerated + kept
  tolerance, AC4 tar exclusion, AC5 non-importable filename).

### Self-test verification (zero tokens, linux)
`tier1-macp2-poly-builder-junk-seeding` 5/5; `tt-poly-junk-probes` +
`tt-poly-structure` + `tt-poly-python-subtree` 51/51; `tt-poly-end-to-end-
verification` 22/22 (includes two consecutive deterministic builds);
`tt-poly-lite-build-golden` 11/11 (default) + integration run with
`TT_POLY_LITE_INTEGRATION=1`. `npm run build` / `tsc --noEmit` green.

---

# ═══════════════════════════════════════════════════════════════════
# MACP2 US-004 resolution — reclassify __pycache__ in spec/docs; junk-
# contract inventory regression
# ═══════════════════════════════════════════════════════════════════

Author: feature-dev-merge-worktree developer (workflow run `run-181102e6-...`)

## Decision

US-001..US-003 made the python `__pycache__` junk a DETERMINISTIC SEEDED
ARTIFACT in the builders and provisioning adapter. US-004 aligns every
documentation surface (spec + fixture docs + case prompts) with that
reclassification and adds a grep-grounded inventory regression (the
E2.4 `tier1-e24-junk-contract-inventory` pattern) so the contract stays
consistent.

### Docs now describe `__pycache__` as seeded/deterministic junk
- spec 02 §junk probes is now **three classes** (regenerated / inert /
  deterministic seeded), and the tt-python section describes `__pycache__`
  as a synthetic marker planted at provisioning (untracked + byte-identical;
  interpreter-written in-tree caches on linux are tolerated extra files).
- `README-JUNK.md` / `JUNK-IS-INTENTIONAL.md` / `FIXTURE.md` / `README.md`
  for tt-python, tt-poly, tt-poly-lite (and the tt-poly python subtree)
  reclassify `__pycache__` from "Regenerated (content free to change)" to
  "Seeded/deterministic (byte-identical)". `.gitignore` comments updated to
  match. `validate-e2e.sh` Phase 3 now SEEDS the marker (mirroring the
  builder) and asserts present + untracked + byte-identical instead of
  demanding interpreter-generated in-tree `__pycache__`.
- Case prompts updated where they described provisioning as regenerating
  `__pycache__` (cases/tier1-traceability.md provisioning section;
  W5.storm-capacity-scaled.md junk-probe line now says seeded/deterministic
  + regenerated). tt-go FIXTURE.md's python comparison reworded.

### New inventory regression
`self-tests/tier1-macp2-junk-contract-inventory.test.ts` (mirrors
`tier1-e24-junk-contract-inventory.test.ts`):
- AC1: spec 02 names the deterministic seeded junk class (untracked +
  byte-identical, sys.pycache_prefix cited).
- AC2: enumerates every site asserting/relying on the synthetic junk
  (4 builders, provisioning adapter, validate-e2e.sh, 11 self-tests, 22
  docs) and proves each is RENDERED by a repo grep (`junk-probe.synthetic`
  for code sites, case-insensitive `seeded/deterministic` for doc sites)
  over torture-test/ excluding var/.
- AC3: no tracked file (excluding var/ + intentional decision/negative-
  assertion sites) still describes `__pycache__` as regenerated junk with
  content free to change or demands interpreter-generated in-tree
  `__pycache__`.
- AC3 anchor: every python-bearing builder seeds + verifies the marker and
  no builder demands interpreter-generated `__pycache__`.

## Files changed (US-004)
- `tamandua-torture-test-spec/02-fixture-projects.md` — three-class junk
  probes + tt-python seeded `__pycache__` description.
- `tamandua-torture-test-spec/04-wave-0-preflight.md` — W0.4 junk invariants
  now cover all three classes.
- `fixtures-src/tt-python/{README-JUNK.md,JUNK-IS-INTENTIONAL.md,FIXTURE.md,.gitignore}`
- `fixtures-src/tt-poly/{README-JUNK.md,JUNK-IS-INTENTIONAL.md,README.md,.gitignore}`
  and `fixtures-src/tt-poly/python/{FIXTURE.md,README-JUNK.md,.gitignore}`
- `fixtures-src/tt-poly-lite/{README-JUNK.md,JUNK-IS-INTENTIONAL.md,README.md,.gitignore}`
  and `fixtures-src/tt-poly-lite/python/{FIXTURE.md,.gitignore}`
- `fixtures-src/tt-go/FIXTURE.md` — python comparison reworded (seeded/deterministic).
- `fixtures-src/tt-python/validate-e2e.sh` — Phase 3 seeds + verifies the
  marker (present/untracked/byte-identical) instead of demanding
  interpreter-generated `__pycache__`.
- `fixtures-src/tt-ts/FIXTURE.md`, `fixtures-src/tt-rust/FIXTURE.md`,
  `fixtures-src/tt-poly/ts/FIXTURE.md`, `fixtures-src/tt-poly/go/FIXTURE.md`,
  `fixtures-src/tt-poly-lite/ts/FIXTURE.md` — "two-class junk probe
  requirement" wording updated to "junk-probe requirement" (spec 02 now
  defines three classes).
- `cases/tier1-traceability.md` — provisioning seeds the deterministic
  `__pycache__/` marker (seeded/deterministic junk).
- `cases/tasks/tier2/W5.storm-capacity-scaled.md` — junk-probe line now
  "seeded/deterministic + regenerated junk per JUNK-IS-INTENTIONAL.md".
- `self-tests/tier1-macp2-junk-contract-inventory.test.ts` (NEW).

## Self-test verification (zero tokens, linux)
`tier1-macp2-junk-contract-inventory` 4/4 under `node --test`.
`npm run build` / `tsc --noEmit` green.

## US-005: --provision --rebuild-invalid self-heal mode (default stays fail-closed)

**Decision:** implement `--rebuild-invalid` as an explicit opt-in flag on all
three provisioning CLIs (tt-golden-bootstrap.mjs, tt-fixture-provision.mjs,
tt-run `--provision`). The default (no flag) keeps the fail-closed behavior
byte-identical: a PRESENT but invalid golden (missing/malformed hash ledger,
ref mismatch, non-bare) still exits non-zero with its precise TEST_INFRA
category and never silently rebuilds. With the flag, `ensureGoldenBare` runs
the same `verifyGoldenBare` first; on FAIL it rebuilds from scratch and the
verdict reports `built:true` + `rebuiltInvalid:true` + `invalidReason` (the
per-asset defect category) + `invalidMessage`, plus a LOUD `note` naming the
asset and defect (`REBUILT-INVALID: golden '<fixture>' was present but invalid
(defect: <category> — <message>); rebuilt from scratch`). A VALID golden is
NEVER rebuilt even with the flag — `built:false`, bare untouched (mtime check
pinned in tests).

**Wiring:**
- `bin/tt-golden-bootstrap.mjs` — `ensureGoldenBare({ fixture, goldenDir,
  force, rebuildInvalid = false })`: present && !force && rebuildInvalid →
  verify; on FAIL rebuild + loud note; on PASS no-op. CLI `--rebuild-invalid`
  + usage/help text.
- `bin/tt-fixture-provision.mjs` — `provisionWorkClone` accepts
  `rebuildInvalid` and passes it to `ensureGoldenBare`; CLI `--rebuild-invalid`
  + usage text; verdict echoes `rebuildInvalid:true`.
- `bin/tt-run` — `run_provision <tier> [rebuild_invalid]` appends
  `--rebuild-invalid` to every `tt-golden-bootstrap.mjs --fixture <f>` call;
  a rebuilt-invalid fixture is labelled `OK (rebuilt-invalid)` (distinct from
  `OK (built)` / `OK (present, no rebuild)`); `--rebuild-invalid` requires
  `--provision` (else exit 4) and is documented in usage/help.
- `self-tests/tier1-golden-rebuild-invalid.test.ts` (NEW) — AC (a) no flag
  stays fail-closed golden-hash-file-missing; (b) --rebuild-invalid exits 0
  with built/rebuiltInvalid/invalidReason + defect-naming note, then verifies
  clean; (c) tampered seed ref self-heals (golden-ref-mismatch → rebuild →
  verify OK); (d) valid golden is a no-op, bare mtime untouched; (e)
  tt-fixture-provision --rebuild-invalid provisions a work clone from a
  ledger-missing golden (raw arming, seeded junk verified); (f) help documents
  the flag on all three CLIs.
- `bin/tt-run.test.sh` — delegation (each per-fixture call carries
  `--rebuild-invalid`), the `OK (rebuilt-invalid)` label, usage text, and
  misuse (flag without --provision / with tier flags → exit 4).

**Self-test verification (zero tokens, linux):**
`tier1-golden-rebuild-invalid` 6/6 under `node --test`; `tt-run.test.sh`
provision section green (incl. the new US-005 blocks); regression
`tier1-golden-bootstrap` 8/8 (AC4 fail-closed pins unchanged).
`npm run build` / `tsc --noEmit` green.

## US-006: regenerate goldens once, prove determinism 2x, junk red-team, bare --tier1 GREEN x2

**Decision:** close MACP2 with the E2.4-US-006-style final proof: the goldens +
hash ledgers are regenerated EXACTLY ONCE from the current (US-001..US-005)
builders, a from-scratch rebuild is proven byte-identical (the
`verify-builder-determinism.test.sh` gate), provisioning self-checks are green
for ALL eight fixtures (including tt-python@master's seeded `__pycache__`
junk), a NEW junk-invariants red-team regression proves the fail-closed
detectors still catch committing/deleting/modifying the junk, and the bare
`--tier1` gate is GREEN twice — all zero tokens on linux.

### Goldens regenerated exactly once (8/8)
The stale pre-MACP2 goldens were removed from `var/fixtures/golden/` and all
eight fixtures were rebuilt from source via `tt-golden-bootstrap.mjs --fixture
<f>` (the same per-asset loop `tt-run --provision tier2` runs). Gotcha: the
fixture ledgers include a HIDDEN file (`tt-python@master` →
`.build-hashes-tt-python-master`), which a bare `rm var/fixtures/golden/*`
glob does NOT remove — the leftover stale ledger made the first tt-python@master
rebuild fail-closed with HASH DIVERGENCE (correct behavior: the pre-MACP2
ledger legitimately differs from the current tree, whose fixtures-src docs
changed in US-004). Removed the hidden ledger and rebuilt tt-python@master
once; the fresh ledger then matched. Re-running the bootstrap loop for all
eight fixtures now reports `built:false` (verify-only no-op) for every fixture
— the "regenerated exactly once" invariant: each present golden verifies
byte-exact against its recorded ledger, which is exactly what a from-scratch
build produces.

### Determinism proof (2 consecutive builds byte-identical)
`bin/verify-builder-determinism.test.sh` (the E2.4/MACP1 gate, already
covering all eight fixtures with canonical ledger filenames) PASSES: 16/16 —
every fixture built twice into an isolated temp `TORTURE_GOLDEN_DIR` produces
byte-identical golden dirs + hash ledgers, and each builder reports
`Deterministic build: PASS` on re-run. No MACP2 change to the builders was
needed; the seeded `__pycache__` junk lives only in the scratch clone (cleaned
by the builder EXIT trap) and never enters the golden dir fingerprint.

### Provisioning self-check (ALL fixtures incl. tt-python@master)
`tier1-e24-all-fixture-provision` (3/3) and `tier1-macp2-provision-junk-
seeding` (5/5) green: every work clone carries operator-notes.local present +
untracked + byte-identical, and tt-python / tt-python@master also carry the
seeded `__pycache__/junk-probe.synthetic` present + untracked + byte-identical
to the shared tt-python reference, in both arming modes.

### Junk-invariants red-team regression (NEW)
`self-tests/tier1-macp2-junk-redteam.test.ts` (4/4): builds the tt-python
golden hermetically into a temp golden dir (exercising the current builder
end-to-end), clones it, seeds the junk provisioning-style, proves the CLEAN
clone passes BOTH detector layers (the builder's exact shell predicate chain —
presence → `git ls-files --error-unmatch` tracked check → `cmp -s` byte-
identity — and the provisioning verify-only oracle `verifySyntheticPycacheJunk`),
then in three scratch variants asserts the SAME fail-closed detectors fire:
(a) COMMIT the junk → `git ls-files --error-unmatch` flags it + oracle
fail-closes `fixture-junk-tracked`; (b) DELETE it → presence check flags it +
oracle fail-closes `fixture-junk-absent`; (c) MODIFY its bytes → `cmp -s`
flags it + oracle fail-closes `fixture-junk-modified`. Each variant asserts the
mutation is real (index contains the marker / file gone from disk / bytes
differ), so a green result would be a true catch, never a vacuous pass.

### Bare --tier1 GREEN x2 + zero-token battery
- `./run-torture-test --tier1` twice: verdict GREEN, exit 0, 4 local PASS +
  24 pending-real, 0 tokens, both runs. (Two interim attempts hit
  `daemon-control scripted start failed` — the CONCURRENT tier2 run (worktree
  865) cycles scripted daemons on the shared fixed ports 5334/5338/5339; the
  failures are environmental port contention, reproduced only while that
  daemon is up, and the GREEN runs are clean.)
- `./run-torture-test --smoke`: GREEN (W0.0 + W0.fixture-baselines).
- `probes/validate-all.sh`: 76/76 probes validated (arm1/arm2/arm3), 0 failed.
- `tt-verify-fixture-baselines --expect` over all eight fixtures: PASS (8/8).
- `npm run build` (typecheck): green.

**Files changed (US-006):**
- `self-tests/tier1-macp2-junk-redteam.test.ts` (NEW).
- `impl-tasks/MACP2-pycache-junk-portability.md` (this section).

**Self-test verification (zero tokens, linux):**
`tier1-macp2-junk-redteam` 4/4 under `node --test`; regression
`tier1-macp2-junk-contract-inventory` + `tier1-macp2-builder-junk-seeding` +
`tier1-macp2-poly-builder-junk-seeding` + `tier1-e24-regenerated-goldens` +
`tier1-e24-baseline-verifier-expect` 21/21; `tier1-final-acceptance` +
`tier1-e24-junk-contract-inventory` + `tier1-e24-golden-tree-exclusion` +
`tier1-e24-untracked-contract-assertions` 22/22 (diff confinement green);
`tier1-golden-bootstrap` + `tier1-golden-rebuild-invalid` 14/14;
`tier1-macp2-provision-junk-seeding` 5/5; `tier1-e24-all-fixture-provision`
3/3; `bin/tt-run.test.sh` 38/38; `verify-builder-determinism.test.sh` 16/16.
`npm run build` / `tsc --noEmit` green. Full TEST_CMD (npm test via
tamandua-test shim) run after commit.
