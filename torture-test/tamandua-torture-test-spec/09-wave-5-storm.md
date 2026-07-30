# 09 — Wave 5: The Storm (T+38h → T+46h, soft 12M / hard 16M tokens)

Everything at once, on **one project**: `tt-poly`, one origin repo, one
`main`. Eight runs active simultaneously, mixed workflow types and mixed
harnesses, two more launched over the cap to exercise admission queueing,
plus a chaos schedule and a "colleague" committing to main mid-storm. This
is the closest the suite gets to a heavy user's Tuesday.

**Two rounds, not one** (attribution is the point): a failure under
8-concurrency-plus-chaos is uninterpretable — was it the concurrency or
the fault? **Round A (clean, ~4h, hands-off):** the full roster below, NO
injected faults, operators observe only; read-path pounding is the sole
background load. Any Round A failure is attributable to concurrency and
merge contention alone — the highest-value finding shape the storm can
produce. **Round B (chaos, ~3h):** a reduced 5-run roster on fresh
worktrees (tips have moved; same `seed/storm` instantiation discipline)
plus the chaos schedule. Round B proceeds even if Round A had failures
(post-triage), but its findings are then interpreted against Round A's
baseline. Both rounds instantiate worktrees/tasks from the composite
`seed/storm` ref (02) — one ref pinning every storm task's bait, bug, and
sentinel content so reruns are byte-reproducible.

**Simultaneity manipulation check (Round A, gating the storm's claim):**
the controller samples run/step states every 15s and must record at least
one window where **all 8 roster runs simultaneously have a claimed or
running step**. If peak concurrency never reaches 8 (early completions,
serialization), the storm's headline is recorded as the observed peak —
reporting "8-run storm passed" at an actual peak of 5 is
self-manipulation; the roster is then re-tuned (longer tasks) for the
rerun or next campaign.

## Pre-storm arming (zero tokens)

- **Aged-state seeding (DC24/DC37 realism):** before launch, seed the TT DB
  + events with synthetic production-scale history (5k runs / 500k events /
  200 worktree rows). The generator must build runs through the REAL
  createRun/step-ops APIs (never raw SQL — a naive generator violates FKs,
  timestamp discipline, and context-JSON parseability, and would convert
  seeding artifacts into fake storm findings), covering every workflow type
  and a mix of completed/failed/canceled/paused terminal shapes.
  **Seed-validation gate:** the full gating oracle battery + O12 runs
  against the seeded state and must pass BEFORE the first storm launch.
  The dashboard-slowness and worktree-fossil classes came from months of
  accumulation; a fresh DB can't exhibit them.
- **Branch retention pinned** for all storm runs (O2's patch-id union check
  needs the branches alive; controller also polls `git for-each-ref` +
  target ref every 30s).
- `TAMANDUA_MAX_ACTIVE_TIMERS=44` in the storm daemon's spawn env (see
  queue math).

## Timer math (corrected — verified against per-workflow agent counts)

Timers required = COUNT(DISTINCT agent_id) per run: fdmw=6, bfmw=6,
security-audit-mw=7, quarantine-mw=4, do-review-do-verify=3, do-now=1.
Active roster: 3×6 + 2×6 + 7 + 4 + 3 = **44**. (The first draft claimed
"~44–48" from wrong per-workflow counts and, at the real numbers under the
default limit of 50, S9 would admit instantly and the queue assertion would
fail mid-storm as TEST_INFRA_FAIL.) The limit is pinned to 44 and S9/S10
launch **immediately after S8's registration** (30s stagger for S9/S10,
before early completions can free timers — a freed timer during a long
stagger would admit S10 legitimately). The gating assertion is
**admission-decision correctness**, snapshot-based: at each of S9/S10's
admission attempts the controller records `freeSlots`; the decision
(queue vs admit) must match the snapshot exactly. Expected shape: both
queue, then drain as capacity frees; if an early completion makes an
instant admit CORRECT, that is a pass of the correctness assertion, not a
failure of a forced-queue hope.

## The Round A roster (launch order, 90s stagger)

| # | Run | Workflow | Harness | Task area (tt-poly) |
|---|-----|----------|---------|---------------------|
| S1 | storm-fdmw-1 | feature-dev-merge-worktree | pi | go/ worker-pool feature |
| S2 | storm-fdmw-2 | feature-dev-merge-worktree | hermes | java/ ledger feature |
| S3 | storm-fdmw-3 | feature-dev-merge-worktree | pi | python/ scheduling feature |
| S4 | storm-bfmw-1 | bug-fix-merge-worktree | pi | rust/ POLY-BUG-R |
| S5 | storm-bfmw-2 | bug-fix-merge-worktree | hermes | **ts/src/store.js** (overlap pair A) |
| S6 | storm-sec | security-audit-merge-worktree | pi | repo-wide audit (POLY-VULNs) |
| S7 | storm-quar | quarantine-broken-tests-merge-worktree | pi | POLY-BRK tests, `--context branch=broken-tests` — lands on `broken-tests`, NEVER main |
| S8 | storm-drdv | do-review-do-verify | hermes | docs+code consistency task |
| S9 (queued) | storm-fdmw-4 | feature-dev-merge-worktree | pi | **ts/src/store.js** (overlap pair B — guaranteed conflict with S5's landing) |
| S10 (queued) | storm-donow | do-now | pi | trivial task (queue-drain canary) |

**Eight merge-eligible runs** (S1–S7 active + S9 queued); seven target
`main` — S7 lands on `broken-tests` (quarantine's whole contract is that
broken tests leave main; any quarantine content reaching main, or a
quarantine landing that moves main's ref at all, is an S1 targeting
violation, and O2's union math for main EXCLUDES S7 by design). The
overlap pair (S5/S9) is a **guaranteed** conflict, not a hoped one: both tasks specify mutually incompatible required edits to the same
sentinel line of `ts/src/store.js`, and the controller pre-verifies with
`git merge-tree` (after S5's landing, before S9 merges) that the textual
conflict actually exists — merely "touching the same file" does not
conflict, especially with model-generated diffs. Everything else is
disjoint by design, so **every non-conflicting landing is expected to
succeed** — lost work cannot hide behind "well, it conflicted".

## Round B: reduced roster + chaos schedule

Round B roster (fresh worktrees off post-Round-A main): B1 fdmw pi
(go/), B2 fdmw hermes (java/), B3 bfmw pi (rust/), B4 **union-red bait
bfmw** pi — tt-poly armed with 2 documented pre-existing red tests, task's
change breaks a third (W4.39's scenario under 5-run contention: assert the
`landed_over_red_suite` annotation trail survives storm-level load — the
union defect class was BORN on a concurrent-merge day, so its regression
test belongs under contention, not just in W4's quiet lane), B5 do-now
agitator. Colleague-commit and pause/kill events retarget Round B run ids;
read-path pounding continues throughout.

| T+ (Round B) | Event |
|----|-------|
| 0 → end | **Read-path pounding** (continues from Round A): dashboard HTTP + 2 MCP tool calls every 30s (against the aged DB). Assert: no 5xx, first-byte latency bound (< 2s), no dispatch-round degradation correlated with polling. |
| 15m | Colleague commit #1 to main (unrelated file) — CAS/target_moved pressure. |
| 25m | **Nudge storm:** 20 `tamandua nudge` invocations in <10s against the loaded daemon. The deterministic motor is nudge-driven; assert dispatch idempotence — zero double-dispatched steps, zero duplicate harness spawns, dispatch count uncorrelated with nudge count (the motor rewrite's core invariant under exactly the load that would expose a race). |
| 30m | Pause (no drain) B3; resume at T+45m. |
| 50m | kill -9 the active harness process of B4. |
| 60m | **Leave-dirty PARK bait:** `tt-chaos` dirties the checked-out merge target's working tree (untracked + modified tracked file) just before a landing window (event-triggered on a finalize claim). The PARK managed-landing path must engage: park-first, land crash-safe, dirty files preserved byte-identical — never a refusal loop, never a clobber of the user's dirty state. |
| 75m | Colleague commit #2 — modifies the SAME LINE B3's fix touches (guaranteed content conflict; a merely-nearby edit auto-merges and tests nothing). |
| 90m | **Stop + delete under load:** `workflow stop` B5, then `workflow delete` it while the other four are mid-flight; relaunch an identical do-now. | 
| 105m | **Mass rugpull:** a colleague commit lands on main while EVERY active merge run (B1–B4) is pre-finalize — all rebase-loopbacks fire within the same dispatch window. Assert each run independently detects, rebases, re-tests; no cross-run confusion of target tips; no thundering-herd wedge on the single origin. |
| 2h30m | `tamandua restart` via the daemon-control wrapper (daemon bounce with runs active — the wrapper, not bare restart: containment must survive the bounce, 01). |
| as-needed | Provider-outage playbook (11). |

## Success criteria

Mechanical (gating):
- **O2 union at each round's end:** final `main` contains every landed
  run's patch-id (S7's quarantine content excluded from main and present
  on `broken-tests`); full `./run-all-tests` green on final main (the
  union-defect class is THE storm target); zero phantom merges; zero
  dropped sibling hunks — checked after EVERY landing from ref snapshots.
  Round B additionally: B4's landing carries its red-suite annotation
  trail (union-red bait).
- **Conflict-designated runs assessed separately** (S5/S9 pair; Round B:
  B3 after chaos #2): each must reach the rebase→re-test loop and land
  with re-attested TESTED_TREE, **or fail honestly with the target
  intact**. (First draft's single "≥6 of 8 land" band could go red on two
  honest conflict losses with zero product bugs.)
- **Non-conflict-designated band (Round A):** of S1–S4, S6–S8, at most
  one honest failure; **≥6 of the 8 merge-eligible runs land** overall
  when conflict-designated successes are included — and Round A being
  fault-free, every non-landing needs a named, evidence-backed cause.
- Round A simultaneity: the 8-concurrent window observed and recorded
  (or the reduced peak honestly reported — see the manipulation check).
- Queue behavior (Round A): S9/S10 admitted only as capacity frees; S10
  within 10min of first capacity; nothing lost in `queued`.
- Chaos recoveries (Round B): B3 resumes and finishes; B4 recovers its
  story after the harness kill; B5 reaches stopped, deletes cleanly with
  zero residue (worktree, claims, timers), and its relaunch completes;
  nudge storm shows zero duplicate dispatch; mass rugpull recovers all
  four independently; PARK bait preserves the dirty tree byte-identical;
  daemon bounce loses nothing (all in-flight runs progress within 2
  dispatch intervals).
  Post-bounce single-flight: no stuck waiter loops; the next same-key
  suite executes fresh; exit-87 rows exist for suites whose shims were
  torn down (in-memory claim "release" is unobservable across a restart —
  assert the observable consequences, not the vanished map).
- Hygiene battery (O4, O8, O9 + post-batch O5–O7, O12) clean at storm end.
  **Single-flight is armed by a controlled prelude, not hoped from the
  roster** (storm runs implement different tasks → different committed
  trees → different TSTX keys; the first draft's "7 runs share one suite
  key" was structurally false): immediately before the storm, N=4
  identical-tree worktrees invoke the same wrapped command concurrently —
  assert exactly 1 execution + 3 waiter replays, then kill the owner shim
  PID mid-execution on a second round — assert dead-owner reclaim in
  seconds. During the storm itself, O9 asserts only per-run ledger
  integrity and zero cross-run interference.
- Token accounting: every terminal run attributed (O3z), including the
  canceled and chaos-killed rounds.
- **Wedge deadline within the campaign:** any run non-terminal at T+44h
  (2h before W6) is force-stopped (`workflow stop`, escalating per
  contract) and classified — a run that stops cleanly on command is an
  honest chaos casualty; a run that CANNOT be stopped is the S1 wedge.
  (The first draft's "T+storm+6h" deadline landed at T+52h, after W6 had
  already archived state and torn fixtures down to goldens — the verdict
  would have outlived its evidence.) W6 teardown begins only after the
  final storm harvest completes.

## Capacity-scaled variant (hosts below full-storm capability)

A host whose profile cannot carry the full roster (missing toolchains →
`tt-poly-lite`; measured slow spawn or tight disk) runs the storm scaled:
four simultaneous runs on **tt-poly-lite** — fdmw(pi, ts), bfmw(hermes,
python), quarantine-mw(pi, ts, → `broken-tests`), do-now agitator — with
one colleague commit and one worker kill, same oracles, timer cap
recomputed from the actual roster's agent counts. The scale-down is a
recorded manifest fact (roster, recomputed cap, reason from the host
profile), and the report's headline states the roster that actually ran —
never "the storm passed" unqualified.

## Storm forensics

Snapshot everything regardless of outcome (DB, events, worktrees, logs,
final repo state) into `results/w5/`. A fully green storm is evidence the
storm is too gentle given the defect history — 11's calibration loop
tightens the chaos schedule for the next campaign.
