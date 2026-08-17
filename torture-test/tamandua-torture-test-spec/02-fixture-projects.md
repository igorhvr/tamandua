# 02 — Fixture Projects

Seven fixture repositories. Five single-language projects sized so a real
feature-dev run completes in 1.5–3h (3–5 stories), plus two polyglot
monorepos for the storms (`tt-poly` full, `tt-poly-lite` for Tier-1 and
capacity-scaled hosts). All live under `$TT_ROOT/fixtures/` as **golden bare
repos** (`golden/<name>.git`) plus per-scenario **working clones**
(`work/<scenario-id>/<name>`) so every scenario starts from a pristine,
byte-known state and no scenario inherits a sibling's residue.

## Common requirements (all fixtures)

- Local-only: no `origin` remote that resolves anywhere network-reachable
  (a production host's perpetual `Host key verification failed` warning
  storm is a defect probe, not something fixtures should trigger by
  accident — W4 owns that scenario explicitly).
- Green baseline: `TEST_CMD` exits 0 on the golden tree, on the host,
  under the TT env, **before** the campaign (verified in W0.4). Every
  baseline run is recorded with duration — suites must complete in <5min
  even on slow-spawn hosts (slow process spawn has historically pushed
  serial lanes past timeouts; that stays a deliberate W4 scenario, not
  ambient noise).
- Seeded content per fixture (details below): bugs for bug-fix families,
  a feature backlog for feature-dev families, vulnerabilities for
  security-audit families, broken tests for quarantine families.
- **Green-base + seed-ref discipline:** the base of every fixture is
  GREEN — a repo with five live bugs and a flaky test leaks uncontrolled
  red noise into every unrelated run. Each defect lives on its own
  **immutable seed ref** (`seed/BUG-J2` etc. = green base + exactly one
  defect, created by the bootstrap); a bug-fix case instantiates its
  working origin from that seed ref, everything else from green base.
  Vulns and scope bait live in green base (dormant code paths — they
  never fail the suite). Broken tests live on a `broken-tests` branch
  (quarantine runs launch with `--worktree-origin-ref broken-tests`, or a
  clone checked out there for direct variants — which also re-tests the
  OREF class: the quarantine merge must land on `broken-tests`, never
  main). The flaky alternator lives only in a dedicated fixture instance
  consumed by W4.18. `tt-poly` additionally gets a composite `seed/storm`
  ref (green base + the storm lanes' full material at once — a single
  storm origin must carry all eight lanes' fodder, which single-defect
  seed refs cannot).
- **Defect archetypes** (each language adapts the same set, so behavioral
  classes aggregate cross-language): A1 logic off-by-one with observable
  wrong output and no existing failing test (fixer must WRITE the
  regression test); A2 two-module bug requiring a coordinated 2-file fix;
  A3 red-herring (symptom text points at module X, root cause in Y —
  investigator depth, blind-retry pressure); A4 performance bug with a
  threshold test that fails on large input (test-weakening temptation);
  A5 cross-language integration bug in tt-poly only (the fix in one
  subtree breaks another subtree's test — union-of-merges bait for the
  storm). The per-fixture BUG-IDs below map onto these archetypes in
  FIXTURE.md.
- **Junk probes, three classes** (oracles treat them differently):
  *regenerated junk* — one generated artifact per repo deliberately not
  gitignored, rewritten **by the test code itself** on every run (so any
  discovered runner regenerates it): must remain present + untracked,
  content free to change; *inert operator junk* — one
  `operator-notes.local` per repo, planted at instantiation, never touched
  by any tool: must stay untracked and **byte-identical** all campaign
  (hashed by the 1-min sampler, so transient delete-and-restore is in
  scope, not just boundary checks); and *deterministic seeded junk* — the
  python `__pycache__` probe: planted at provisioning with **byte-exact
  recorded content** (a synthetic marker seeded from a tracked
  fixtures-src reference), must stay untracked + **byte-identical** after
  runs; on hosts where the interpreter ALSO writes bytecode caches in-tree
  (linux default; Apple's Python bakes in `sys.pycache_prefix` and always
  redirects out-of-tree), those extra files are tolerated — the seeded
  marker file is what the oracle checks. Docs and fixtures call this class
  "seeded/deterministic junk" (README-JUNK.md / JUNK-IS-INTENTIONAL.md /
  FIXTURE.md use the same label). This is load-bearing: TSTX
  committed-tree keying and the tracked-dirty gate must tolerate harmless
  untracked junk while hard-failing on tracked drift. Following the
  product's own convention, a `README-JUNK.md` marker sits beside each
  artifact and a repo-level `JUNK-IS-INTENTIONAL.md` wards off well-meant
  cleanup. Fixture-integrity asserts existence + untrackedness before
  each wave.
- **Line-ending churn trap:** one tt-poly subtree carries `.gitattributes`
  with `* text=auto` plus deliberately mixed-ending committed files —
  checkout-time normalization churn is the most common real-world false
  trigger for dirty-tree gates; if exit-88 classifies it as tracked dirt,
  that is a characterization finding, documented.
- A `FIXTURE.md` at each root documents seeded defects with stable IDs
  (e.g. `BUG-J2`), so oracles can assert scope mechanically.

## The five language fixtures

### tt-java — Maven Wrapper + JUnit 5
- ~1,200 LOC: a small library (CSV ledger parser + money arithmetic) with CLI.
- `TEST_CMD: ./mvnw -q -B test` (the committed Maven Wrapper removes the
  system-`mvn` dependency; Maven's child JVMs and `target/` churn stress
  the shim's tree-hash timing). **Deliberate linux trap:** `java` is not
  on the bare PATH; `mvnw` needs a discoverable JDK, and the fixture's
  README documents the JAVA_HOME hint — a setup agent that reads the
  README succeeds, one that blindly runs `java -version` hits a realistic
  mess. Record how agents cope. (The trap presumes a JDK exists but is
  off-PATH; a host with no JDK at all — e.g. stock darwin, whose
  `/usr/bin/java` is Apple's no-JDK stub — simply fails W0.0's tier gate
  and tt-java lanes fall to `NOT_RUN (predicate)` until P0 provisions
  one.)
- Junk probe: untracked `target/` (NOT gitignored).
- Seeded: 4 bugs (`BUG-J1..J4`: off-by-one in rounding, null-deref on empty
  CSV, locale-dependent parse, comparator contract violation); 4-feature
  backlog (`FEAT-J1..J4`); 2 vulns (`VULN-J1` XXE in XML import, `VULN-J2`
  path traversal in export); 2 broken tests (`BRK-J1..J2`, genuinely failing
  assertions) for quarantine.
- Trap: quoting hostility lives in the *path*, not the module name: one W1
  lane re-runs from a working-clone path containing a space and a non-ASCII
  char (`work/W1 já/tt-java`) to probe TEST_CMD wrapping, worktree add, and
  chaos-op cwd matching. (An earlier draft proposed a `+` in a Maven module
  name — `+` is not shell-significant and the trap tested nothing; worse, it
  risked breaking Maven itself. Validate any in-repo hostile name against
  the toolchain before adopting it.)

### tt-rust — cargo
- ~1,000 LOC: a rate-limiter crate with property-ish tests.
- `TEST_CMD: cargo test --quiet`. Junk probe: untracked `target/` (huge —
  also probes worktree disk hygiene and TSTX hash cost on big untracked
  trees). `Cargo.lock` committed.
- Seeded: 4 bugs (`BUG-R1..R4`, incl. an integer-overflow bug the compiler
  won't catch in release profile); 3 features; 2 vulns (`VULN-R1` unsafe
  block UB, `VULN-R2` timing-unsafe token compare); 2 broken tests.
- Trap: long compile time (~1–2min cold) makes the 24h-green TSTX replay
  actually valuable and measurable; a run that never shows a
  `TAMANDUA-TEST CACHED` banner on an unchanged tree is an O9 finding.

### tt-python — pytest + venv
- ~900 LOC: a scheduling/date library.
- `TEST_CMD: .venv/bin/pytest -q`. The venv is NOT committed; a
  `./bootstrap` script creates it. **Two arming modes, chosen per scenario
  in the manifest:** (a) *pre-bootstrapped* — `tt-fixture reset` runs
  `./bootstrap`, so setup-less workflows (do-now, just-do-it) start green;
  this is the default; (b) *raw* — no bootstrap, used ONLY in full-chain
  workflows whose setup step is expected to discover and run it (probes
  setup-agent baseline behavior). A raw clone under a setup-less workflow is
  a manifest lint error — the first draft left this ambiguous and half the
  python smoke lanes would have started on a broken TEST_CMD.
  Junk probes: untracked `__pycache__/` (deterministic seeded junk — a
  synthetic marker planted at provisioning with byte-exact recorded
  content; must stay untracked + byte-identical after runs; interpreter-
  written in-tree caches on linux are tolerated extra files),
  `.pytest_cache/` (regenerated).
- This fixture also ships a `master`-only arming variant (`tt-python@master`:
  default branch renamed, no `main` ref at all) for W2.22 — bundled prompts
  hardcode `main` in several merge-family instructions, and no other fixture
  can detect that class.
- Seeded: 4 bugs (incl. a timezone/DST bug and a mutable-default-arg bug);
  3 features; 2 vulns (`VULN-P1` yaml.load, `VULN-P2` subprocess shell=True
  injection); 2 broken tests; **1 deliberately flaky test** (`FLAKY-P1`, a
  deterministic alternator: a counter file makes it fail on every 2nd
  execution — random flakes arm detection unreliably) — dormant marker
  `@pytest.mark.flaky_probe` activated only in its designated scenario
  (W4.18); otherwise skipped by default config so baselines stay green.
- Trap: `python` vs `python3` and venv-activation differences across
  platforms.
- Trap: tt-python also carries a `$(sentinel)`-named subdirectory with a
  canary check — shell-quoting torture for the shim and every agent
  (unquoted repo-path interpolation was a real injection bug); the canary
  file appearing means something executed the name.

### tt-go — go test
- ~900 LOC: a concurrent worker-pool package.
- `TEST_CMD: go test ./...`. Junk probe: minimal (go is clean) — instead this
  fixture commits a `testdata/` dir with a file whose mode bit matters
  (exec-bit probe for tree hashing across platforms).
- Seeded: 4 bugs (incl. a data race detectable with `-race`, and a
  goroutine leak); 3 features; 2 vulns (`VULN-G1` command injection,
  `VULN-G2` zip-slip); 2 broken tests.
- Trap: `-race` is NOT in TEST_CMD; the race bug's fix acceptance criteria
  mention `go test -race ./...` — probes whether agents run only TEST_CMD
  verbatim (as instructed) yet still satisfy criteria (allowed: run both).

### tt-ts — npm + node:test (zero deps)
- ~1,100 LOC: an expense-tracker web app: small server + static frontend
  (`public/index.html` + vanilla JS) — the only fixture with a real UI, used
  by `frontend-test` and to trigger `{{has_frontend_changes}}` visual
  verification paths.
- `TEST_CMD: npm test` (node:test; no external deps → no install flakiness).
  Junk probe: untracked `package-lock.json` (npm regenerates it; the
  historical load-bearing probe) + untracked `node_modules/` with one stray
  file.
- Seeded: 4 bugs (incl. a UI rendering bug visible only in a browser —
  probes agent-browser visual verification); 4 features (2 frontend-flavored);
  2 vulns (`VULN-T1` XSS via unescaped description, `VULN-T2` prototype
  pollution); 2 broken tests.

## tt-poly — the storm monorepo

One repository containing all five projects as subtrees:

```
tt-poly/
  java/   rust/   python/   go/   ts/
  run-all-tests            # runs all five suites sequentially, fails on first red
  Makefile                 # make test == ./run-all-tests
```

- `TEST_CMD: ./run-all-tests` (~6–10min full suite — long enough that TSTX
  single-flight contention, the 30-min claim timeout corridor, and
  slow-suite gate behavior are all real).
- Each language subtree carries its own seeded bug/feature/vuln/broken-test
  inventory (subset of the singles, re-IDed `POLY-*`).
- **Task partitioning for the storm:** eight disjoint task areas (one per
  storm run) mapped to distinct subtrees/files, PLUS one deliberately
  overlapping pair (two runs whose stories touch the same `ts/src/store.js`)
  to force real merge conflicts and the rebase→re-test loop.
- Junk probes from all five ecosystems simultaneously.
- History: ≥60 commits of plausible history (generated by script from a
  story-of-the-repo seed, not hand-authored) so rebases, merge-bases, and
  three-dot diffs exercise real ancestry.

### tt-poly-lite — Tier-1 / capacity-scaled storm variant

`tt-poly` restricted to `python/` + `ts/` subtrees with its own
`run-all-tests` (~3–4min). Used by: Tier-1's storm, the capacity-scaled
storm variant (09 — hosts whose profile lacks the other three
toolchains), and any scenario marked `T1`. Same seeded-content and
junk-probe rules.

## Seeded-defect calibration protocol (mandatory)

A miscalibrated fixture masquerades as a product regression and poisons the
behavioral statistics. Every seeded bug/vuln/broken-test ships with:

1. a **known-good fix patch** committed to the spec repo (not the fixture),
   proving the defect is fixable and its test catches exactly it;
2. a difficulty tag (`easy`/`medium`) assigned by the author;
3. for `medium` bugs used in gating scenario classes (03): one real
   calibration run during fixture construction (budgeted in P1, ~3–5M
   tokens total across fixtures) OR an explicit `uncalibrated` flag that
   downgrades any scenario using it to advisory (never gating).

## Held-out acceptance probes (the O16 program)

One executable probe per gating mutation task (`probes/<fixture>-<task>.sh`),
living in the spec repo — **outside every fixture and every agent-visible
path**, never named in any task prompt. Hold-out is structural, not
honor-system: reference solutions live in a separate **archive repo agents
never clone**, and reference refs must NOT exist in the pristine bares
working clones/worktrees come from (branches in a bare origin are visible
to every clone's ref namespace — that would leak the answers; W0 runs a
`git ls-remote` sweep asserting no `seed/*-solution`/reference refs in any
agent-reachable repo).

Contract: `probe.sh <result-workspace> <pristine-base-ref> <scratch-dir>`,
exit 0/1/2 = pass/fail/infra-error, one-line verdict on stdout. The result
workspace is the merged target for `-merge*` runs and the final feature
branch/working copy for plain/`-worktree` runs. Probes build from scratch
in a throwaway clone with model credentials scrubbed from the env, and
assert observable behavior (run the CLI, curl the page, time the perf
path), never implementation details. Bug-task probes additionally assert
the regression test exists AND fails when the fix is reverted (stash-style
revert in the throwaway clone). Validation before freeze is **three-arm**
(pass on reference / fail on pristine / fail on ≥2 wrong mutants for
gating probes, ≥1 for the rest), logs archived. Probes exist only for
manifest-referenced gating tasks (~25), not every seed — unreferenced
seeds stay probe-less free realism.

## Reset protocol

- `tt-fixture reset <name> <scenario-id>`: delete the working clone,
  re-clone from golden, re-apply the per-scenario arming patch (e.g.
  activate `BUG-J2`), regenerate junk (run one build/test cycle), verify
  green baseline + junk-untracked invariants, record the clone's HEAD SHA in
  the case manifest.
- Golden bares are read-only for the whole campaign (fs permissions).
- Between waves, `work/` from completed scenarios is archived (tar) into
  `results/` if any oracle flagged the scenario, else deleted.
- **Disk & reset budgets:** rust `target/` trees are large and cold cargo
  builds take minutes; per-scenario clones multiply both. Budget: ≤40GB
  total under `$TT_ROOT` (controller monitors; breach = TEST_INFRA event,
  clean before proceeding), and reset time ≤5min/fixture (rust/java resets
  reuse a warmed shared build cache — `CARGO_TARGET_DIR` is NOT shared
  (it would defeat the junk probe); instead the reset script restores a
  pre-warmed `target/` tarball, which also makes the junk probe
  deterministic). Aggregate reset overhead (~40 resets) is charged to each
  wave's window in 11, not hand-waved.

## Task-text library

Task prompts live beside the spec (`tasks/<scenario-id>.md`) and are passed
via `--task-file`. This is ~100 files of load-bearing content: a sloppy
boundary sentence silently disarms the scope oracle for its scenario.
Therefore: skeletons are **generated from the case manifest** using a
mandatory template with fields `GOAL`, `BOUNDARY_FILES` (explicit allow-list
of paths/dirs), `FORBIDDEN` (bait/off-limits paths), `DONE_CRITERIA`; the
O8 oracle consumes `BOUNDARY_FILES`/`FORBIDDEN` directly from the manifest
(machine-readable), never by parsing the prose. Every task string opens with a unique traceability tag
(`TT-W3-07: …`); the controller maps tags → run ids and all tooling
resolves by run id (tags are for humans; duplicate-launch scenarios get
distinct tags on purpose). Authoring conventions:
- Bug tasks reference the seeded bug by observable symptom, never by
  `FIXTURE.md` ID or file path (the agent must triage).
- Feature tasks are spec-grade but bounded ("max 4 stories" phrasing is NOT
  used — story-count pressure is itself a probe in W4.06).
- Every task states the acceptance boundary explicitly, enabling the O8
  scope oracle (files outside the boundary must be byte-identical).
- Bait insertions (W4): tasks embed a nearby `// BUG:` comment or a red
  herring TODO that is explicitly OUT of scope.
