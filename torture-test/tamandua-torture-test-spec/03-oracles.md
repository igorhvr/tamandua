# 03 — Oracles & Outcome Taxonomy

Oracles are mechanical checks executed by the controller: SQL against the TT
`tamandua.db`, git plumbing against fixtures, filesystem/process probes.
**No oracle consumes agent prose** — pass/fail derives from exit codes, DB
state, git state, filesystem state, and the machine-readable fields of the
case manifest (task boundaries, chaos logs).

**Terminology.** "Dispatch interval" in this spec = the daemon's periodic
sweep/reconciler tick (15s fallback dispatch sweep; the motor is otherwise
nudge-driven). Every wedge bound stated in intervals is falsifiable against
that clock; the controller records the effective value at W0.

## Sweep discipline

- **Snapshot first, mutate last.** A sweep is not fully read-only (probes
  build projects; prune checks reclaim space). Fixed order: (1) consistent
  evidence snapshot — sqlite `.backup`, event-file copies, process census,
  `git bundle` (with reflogs) of every involved repo; (2) read-only checks;
  (3) behavioral probes in throwaway clones; (4) mutating checks last.
  Retention/TTL time-travel checks always run against a **cloned** DB.
- **Expected-mutation ledger.** Chaos injections legitimately violate
  oracles (a colleague commit to main, a deliberately dirtied tree). Every
  injection is pre-registered in the manifest with its expected oracle
  impact; sweeps consume that ledger — an oracle exemption without a
  matching ledger entry is itself a finding.
- **Display-mapping awareness (DISP contract).** A parked `verify_each`
  coordinator is *stored* `running` but *displayed* `verifying` on
  step-presentation surfaces (CLI human, `status --json` `displayStatus`,
  MCP, kanban), while run-summary aggregates count raw statuses. Oracles
  comparing surfaces to the DB apply the designed mapping per surface —
  that divergence is the contract, not a lie (W4.35 pins it once,
  deterministically).

## Case classification (rides with the outcome taxonomy)

Every manifest case carries one of:
- **verification** — one explicit expected outcome; any deviation is a
  finding; these gate waves. Fault-injection cases are verification *with
  respect to their machinery expectation* (the injected fault's designed
  response) even when a real model drives the content.
- **characterization** — records actual behavior where the contract is
  undecided (e.g. W2.25 key pinning, prune age semantics); never gates;
  output is a design finding, not a defect.
- **exploratory** — real-model stochastic content; one-shot failures are
  leads, not convictions; content-level judgments need a 2-of-3 repeat on
  fresh fixture instances before they justify quarantining a lane.
  Mechanical oracle violations are immediate PRODUCT_FAIL regardless of
  class — INVALID or provider trouble on some *other* injection never
  suppresses an independent product finding.

## Tiering (which oracles run when)

- **In-campaign (gating, per-run + wave sweeps):** O1, O2, O3z, O4, O8,
  O9, O10, O11, O16 — the S0/S1 carriers, each with mutation self-tests
  before T+0.
- **Post-batch (non-gating during the campaign, mandatory in W6):** O5,
  O6, O7, O12, O13, O19 — hygiene/truthfulness batch scripts (O14
  retired; O17 gates only concession landings, else post-batch); findings
  become S2 issues. **O18 (secret hygiene) runs at every wave boundary
  and pages on a hit** — the one hygiene oracle that escalates like a
  gate.
- **Bracketing:** O15 runs at W0 and W6 exactly.

## Oracle battery

**O1 — Terminal-state integrity (per run, gating).**
Run status ∈ {completed, failed, canceled}; a completed run has no
non-terminal steps; every terminal run has a terminal event; `workflow
status <id> --json` agrees with direct DB reads (modulo the DISP display
mapping). No run sits `scheduling_status='error'` or unadmitted >5min.
Additions:
- **Transitive run-graph convergence:** `workflow wait` resolves its run
  set ONCE at invocation — the controller re-polls the run graph until no
  new linked run (rugpull replacement, just-do-it child) appears for a
  10-min quiescence window; discovered runs get their own deadline
  (recomputed for their workflow class) and oracle set.
- **Anti-gaming clause:** terminal ≠ healthy — >20% of a wave's runs
  terminal in less than that workflow family's measured duration floor
  (W1 medians, else production medians) auto-flags, excluding cases whose
  expected outcome IS a fast failure.
- **Healthy-straggler clause:** a run wedge-captured and force-stopped
  while demonstrably mid-round (live claim, recent output) scores
  `INCONCLUSIVE`, not an O1 violation — iff its manifest line predeclared
  the straggler policy (predeclared today: hermes storm lanes only).

**O2 — Merge truth (per merge-family run, gating).** The heart of the suite.
- Target ref moved exactly once per landing; `MERGED_TREE` == recorded
  `TESTED_TREE` (modulo the documented rebase-retest loop) AND
  **`git rev-parse <MERGED_COMMIT>^{tree}` == MERGED_TREE** — without the
  commit-tree leg this is string-equality theater.
- The claimed diff is byte-present on the target (patch-id); target
  contains the merge commit (`merge-base --is-ancestor`).
- **Evidence leg, scoped by landing mode** (reconciled with the FMIS gate —
  a blanket "suite_results row must exist" would false-S1 every sanctioned
  concession landing, and a blanket waiver is a laundering hatch):
  - *ordinary green/red landing:* a `suite_results` row exists for
    (origin, attested MERGED_TREE, cmd_hash) — the attestation came from
    an agent; the row came from the shim; they must corroborate;
  - *default concession* (`merge.landed_without_suite_evidence`): row leg
    waived, but requires source-faithful provenance — exactly one prior
    terminal reroute on finalize, no green/red row for the exact gate key
    (genuinely missing, not a suppressed red — see O10's laundering
    guard), and the landing is promoted to gating O16+O17;
  - *off-mode landing* (`merge.gate_overridden`): row leg waived, but the
    override must trace to **manifest/launch argv**, never agent output
    (O10's launch-intent binding).
  Any no-evidence landing lacking its mode's provenance is S1.
- **No phantom:** completed merge run whose target ref did not move = S0.
- **Bidirectional reconciliation:** every `merge.landed` event and every
  non-noop target-ref transition must reconcile to a terminal run
  disposition — a run that landed and then finished failed/canceled (e.g.
  merger killed after `update-ref`, recoveries exhausted) is PRODUCT_FAIL,
  never an "honest failure": the ref moved. Every landed tree gets its O16
  probe regardless of the run's final status.
- **Ref transitions attributed, not inferred:** target-branch tip history
  == pristine commits + attributed squash merges + ledger-registered
  chaos injections; the **raw reflog is captured into evidence** and
  walked manually on any anomaly (full mechanical reflog attribution is
  v2 — highest-flakiness-risk oracle; must not become the suite's own
  worst component). An unattributable commit is S1.
- Idempotence: no duplicate/empty landings on retries.
- *Implementation prerequisite:* branch retention pinned for the storm;
  controller snapshots `for-each-ref` + target ref every 30s.

**O3 — Token accounting.**
Gating subset **O3z**: a completed real run with `tokens_spent == 0` is S1;
`tamandua_stats.system_tokens_spent` == 0 absolute, before AND after.
**Synthetic ledger:** scripted-daemon runs carry known synthetic token
values from the fake runtimes — O3 asserts synthetic attribution is
*exact* for them (that is the whole point of the late-trailer scenarios)
and excludes them from real-spend reconciliation; a separate ledger, never
"N/A". Advisory subset: per-family/harness bands from W1/W3 measured
medians; hermes uses the adapter's actual formula (input+output+
cache_write, excluding cache_read/reasoning) against `$HERMES_HOME/
state.db`; in waves where at most one hermes run is active, every new
state.db session maps to exactly one (run, step, round) with tokens
matching that run's increment within 1% — under concurrent hermes runs the
check degrades to session-set reconciliation and the missing per-round
session-attribution record is pre-filed as an observability finding.

**O4 — Claim & dispatch hygiene (sweep, gating).**
No step `running` with a dead `claim_pgid` beyond one sweep interval; no
dangling claims after NO_WORK; no `retry_count` > `max_retries`; reroute
counters within budget; abandonment boundary matches source
(`ABANDON_STORY_MAX = 8` survivable losses — a story fails on the 9th).
`retry_count` (honest rejections) and `abandoned_count` (worker loss) move
**independently**; in scripted runs every increment maps 1:1 to a
manifest-logged injection. **Watchdog false-positive check:** zero
`[liveness-detected]` worker_lost events for workers provably alive —
provenance from the host's **process recorder** (local 5s sampler,
harvested at wave boundaries) cross-referenced with the chaos log; ≥2 consecutive
samples required for "provably alive"; kill-and-PID-reuse inside one
window → INCONCLUSIVE + manual review.

**O5 — Process & port hygiene (post-batch).**
Census layers: (1) **kernel-owned containment** (hosts with systemd user
scopes) — the TT daemon
starts inside a dedicated `systemd-run --user --scope`, making cross-suite
leak census a cgroup membership check. Every daemon start AND restart
(including chaos restarts) goes through the controller's
`daemon-control` wrapper which re-asserts scope membership — a plain
`tamandua restart` would detach the new daemon and silently void this
layer. (Explicitly rejected alternative, do not re-derive at hour 20:
pointing `TAMANDUA_PI_BINARY` at a wrapper — it hijacks binary-override
resolution, breaking token-saver preference and colliding with the
scripted daemon's use of the same lever.) (2) claim-PGID descent;
(3) path/fd evidence (`lsof`); (4) start-time window with an allowlist for
legitimate shared daemons (gradle/maven/pytest helpers) — listed for
disposition, ≤1 survivor per toolchain at W6. Hosts without a scope layer
(e.g. darwin) run layers 2–4 only, with cmdline/cwd/lsof evidence (never
env — kernel-hidden on darwin); the weaker guarantee is recorded in the
host profile. Cross-project containment: a harness child whose
cwd/cgroup belongs to another run's directory is S1.

**O6 — Worktree bookkeeping (post-batch).**
Rows match disk; no orphaned rows/dirs; end-state matches each row's OWN
`cleanup_policy` (default `keep` means retained-after-terminal is today's
contract — the 17GB/3.2GB fossils are a policy/UX finding the suite
forces, not presumes); `worktree prune --completed --older-than 1h`
reclaims and leaves `git worktree list`/`.git/worktrees` bidirectionally
consistent; prune age semantics (creation-age today, terminal-age
proposed) recorded as a characterization design finding; leftover
`feature/*`/`fix/*` branch counts reconcile against non-merged runs;
out-of-band deletion surfaced.

**O7 — Event-log integrity (post-batch).**
v1 scope: every terminal run has a terminal event; no completion event
before its claim event; no empty-runId events / no hidden `events/.jsonl`;
zero occurrences of the HUSH-removed nudge event types (`agent.nudged`,
`agent.nudge.skipped`, `run.nudged` — reappearance IS the regression);
rotation bounds (≤20MB + 3 archives) respected. **Rotation-loss check:** a
scripted burst run with a fully deterministic per-step event count is
driven across ≥3 rotations — the complete event train must be
reconstructible from live file + archives (a single marker across one
rotation proves nothing).

**O8 — Scope & diff audit (per run, gating; mechanics, not prose).**
Changed files ⊆ `BOUNDARY_FILES` ∪ new files under boundary/test dirs;
`FORBIDDEN` (bait) paths byte-identical; seeded-test integrity via known
checksums (no deletion/modification outside quarantine tasks) + grep for
new skip/todo markers in changed test files. No merged tree may contain
progress/report/transport artifacts (denylist grep PLUS per-merge diff
review against the task's expected file set — denylists miss novel names;
a merger once committed 5 progress files to main).

**O9 — TSTX ledger & shim (per run + targeted, gating).**
Modeled as ordered state transitions (lookup → claim → execute →
record/replay), not row existence: every replay names its justifying prior
row (green, same key, within TTL at replay time); rows keyed to real
committed fixture trees; `TAMANDUA-TEST CACHED` observed where trees were
unchanged; exit-86/87/88 semantics on their injections; junk probes
untracked after every run; single-flight one-execution-N-waiters;
dead-owner reclaim in seconds **with** the `suite.claim_dead_owner_
reclaimed` event (owner-death arm) vs release-on-kill without it
(stop/cancel arm) — the two recovery paths are distinct and asserted
separately; `--force` always re-executes; cross-repo separation (identical
trees in independent origins never share evidence); zero evidence rows
ever recorded for drifted trees.

**O10 — Ledger-gate decision contract (per merge run, gating).**
The full mode × evidence table, verified in BOTH directions (permissive
cells must not silently start refusing; refusing cells must not silently
start landing):

| mode | missing evidence | red evidence | green |
|------|------------------|--------------|-------|
| `merge_gate=off` | lands + `merge.gate_overridden` | lands + `merge.gate_overridden` | lands + `merge.gate_overridden` (off short-circuits before row lookup — every off landing is override-attributed) |
| default | **reroutes ONCE** (shim-usage+timeout ACTION feedback), then lands annotated `merge.landed_without_suite_evidence` | lands + `merge.landed_over_red_suite` (advisory) | lands |
| default + `fail_missing=1` | reroute once, then refuse (`LEDGER_EVIDENCE: missing`), no concession event | lands + `merge.landed_over_red_suite` (fail_missing tightens *missing* only — an operator-model gap worth an S2 doc finding) | lands |
| `merge_gate=green` | reroute once, then refuse | reroute once, then refuse (`LEDGER_EVIDENCE: red`) | lands |

Semantics folded from source reconciliation:
- "Refuses" means **reroute once, then fail** — never immediate failure;
  all non-off missing/red paths do exactly one terminal reroute first, and
  that reroute requires finalize to declare `on_fail.retry_step` with
  remaining budget (a merge workflow without it fails on default-missing
  instead of conceding — all bundled fdmw/bfmw have it). Per-cell
  assertions cover terminal status, ref movement, reroute count,
  merger-invocation count, and exact event set.
- `isStrictMissing` = green mode OR `fail_missing` ∈ {1,true,on}
  case-insensitively — not arbitrary-nonempty, not whitespace-padded;
  off dominates and ignores fail_missing.
- **Scope: pre-claim decision only.** At acceptance time an obstructing
  red/missing decision is SKIPPED when the target already equals
  `MERGED_COMMIT` — source emits **`merge.accepted_already_landed`** and
  completes. A legitimate claim→acceptance transition can therefore land
  without the cell's event; O10 must not call that a forbidden landing.
  Deterministic row-flip/delete scenarios exercise it.
- **Launch-intent binding (S1-grade):** `merge_gate`/`fail_missing` are
  NOT in `RESERVED_CONTEXT_KEYS` — a step's `MERGE_GATE:`/`FAIL_MISSING:`
  KEY-line output overwrites the launch-time value, and rugpull
  replacements inherit the mutation. O10 binds to the manifest/launch
  argv, asserts both keys invariant across the run, and W4.04's KEY-line
  arm drives the flip. Standing pre-registered product finding: reserve
  both keys.
- **Red→missing laundering guard (exact-key):** for every concession
  landing, assert no red `suite_results` row exists for the exact gate key
  (origin, attested MERGED_TREE, cmd_hash) at gate-evaluation time. A red
  row for a different (earlier, pre-fix) tree is legitimate and must NOT
  fire; only an exact-key red suppressed into "missing" (shim killed /
  raw-run) is the laundering shape.
- Refusals carry the self-diagnosis block.

**O11 — Output-contract enforcement (per run, gating).**
No step completed without satisfying its expects; no `[missing: <key>]`
rendered into any dispatched prompt; no run completed off a retry verdict;
producer-key failures attributed to the producer; submit-time rejection
texts are informed (distinct per attempt), not generic.

**O12 — DB invariants (post-batch).**
`PRAGMA integrity_check` + `foreign_key_check` clean; explicit orphan
checks per dependent table; unique run_numbers among live rows
(monotonicity across deletes is characterization — MAX+1 allocation can
reuse after deleting the newest; record, decide policy); uniform timestamp
formats with created_at ≤ updated_at; context JSON parses for every row;
reserved keys never overwritten by agent output. **Serial-pipeline
composite-state rule:** the ONE permitted pair of executable non-terminal
steps in a run is a `verify_each` coordinator parked `running` (no current
story) with its declared verifier pending/running; any other pair is a
violation; downstream steps legitimately sit `waiting`.

**O13 — Daemon/status truthfulness (post-batch + targeted).**
Surfaces vs DB with the DISP mapping applied and a stated convergence
deadline (10s; a lie is a *persistent* disagreement re-sampled at +30s);
no stale-pidfile lies; clean EADDRINUSE; never half-up with a live
pidfile. Storm profile: polls every 30s from 2 clients; `/api/runs`
p95 < 2s, error rate 0, ≥500 samples, against the aged DB.

**O14 — RETIRED.** Was cross-machine parity. The spec is
single-host (01); comparing campaigns run on different hosts is an
operator activity over the archived reports, outside the suite. The
number is kept reserved so older references stay unambiguous.

**O15 — Production untouchedness (W0 + W6, gating).**
Per 01's isolation probe. Preferred posture: the production
daemon is STOPPED for the campaign (enables strict zero-write checking);
if it stays up, O15 runs in logical-comparison mode (DB table diffs,
event run-id sets — not mtimes) and the choice is recorded in the
manifest. The dev checkout and inert-junk hashes are watched by a 1-min
sampler for the whole campaign; an unexpected change emits SECURITY-ALERT
and auto-pauses TT launches (transient mutate-and-restore inside one poll
window is a recorded v1 blind spot). Known benign exclusion, recorded not
alarmed: the daemon's background version check performs a quiet
`git fetch` in its install repo on a timer (failures swallowed) — the TT
daemons will do this inside the TT env; O15's watch list treats that
fetch's ref/FETCH_HEAD churn in the TT install repo as expected, while
any such churn in the PRODUCTION checkout still alarms.

**O16 — Held-out acceptance probes (anti-fake-work; per mutation run, gating).**
For every completed run of a mutation workflow — **merging or not** (plain
and `-worktree` variants are probed on their final branch/working copy) —
the held-out probe passes. Probes (02 §probes) are never visible to
agents, run in throwaway clones with model credentials scrubbed from the
env, and were **three-arm validated** before the campaign: pass on the
reference solution, fail on pristine base, fail on ≥2 deliberately-wrong
mutants (arm b kills always-pass probes; arm c kills too-shallow ones).
Coverage is explicit: every gating mutation case carries a `probe_id` in
the manifest — a gating case with a missing/invalid probe is an
execution-validity failure, never a quiet demotion; deliberately
probe-less cases are marked exploratory and reported in a separate
coverage denominator. A probe failure on a completed run gets one manual
look before filing (the probe may be wrong → TEST_INFRA_FAIL, recorded).

**O17 — Test-inventory integrity (characterization, EXCEPT gating for
concession landings).** For every merged tree: the suite's structured
inventory (runner-reported case list where available, else file/case
counts) shows no lost tests and no new skips/xfails beyond task-planned
deletions. Count-based checks are a tripwire — findings get manual diff
review before filing. **Concession landings are the exception:** a tree
landed via `merge.landed_without_suite_evidence` has no green-evidence
backstop, so any new red/skip/xfail beyond planned deletions is a hard
PRODUCT_FAIL — the one structural guard that the FMIS default gate did not
ship broken code (exercised by W4.36).

**O18 — Secret hygiene (wave boundaries + W6; a hit pages).**
At provisioning, every credential the TT env owns gets a **canary**: the
TT daemon secret is generated with a unique greppable prefix
(`TTSECRET-...`), and the copied `.pi` / `.hermes` auth material is
augmented with canary tokens of the same prefix (real values also listed
in a sealed grep set). O18 sweeps every artifact class a user might share
or the suite archives — daemon/dashboard/MCP logs, events JSONL +
archives, a full `tamandua.db` dump, all captured CLI outputs
(`doctor`/`status`/`logs`/error messages), forensics bundles, the final
report — for any canary or sealed-set hit. One hit = S1-security
(error-message paths that fold child stderr into thrown errors are the
expected offender class). Mutation self-test: a canary planted in a
synthetic log must be detected before T+0. Zero tokens, minutes per
sweep.

**O19 — Daemon resource trend (post-batch, W6-mandatory).**
tt-recorder samples each TT daemon's RSS and open-fd count (plus
`tamandua.db`+WAL byte size) every 5s for the whole campaign. O19 flags:
sustained monotonic RSS growth across >=6h after excluding active-run
windows; fd counts that never return to their post-wave baseline; DB+WAL
growth disproportionate to row growth. The 46-hour campaign is the
closest proxy the suite has for users' weeks-long daemon uptimes — a
slow leak passes every terminal-state oracle and ships green without
this. Advisory S2 in the first campaign (calibrates the thresholds),
gating thereafter.

## Outcome taxonomy (per scenario)

| Outcome | Meaning | Counts toward gates? |
|---|---|---|
| `PASS` | Intent achieved, applicable oracles green. An honest run failure with machinery invariants intact is a PASS for its machinery expectation. | yes |
| `PRODUCT_FAIL` | Oracle violation / deviation from a verification case's machinery expectation. The prize. | yes (severity-weighted per S-rules) |
| `AGENT_FLAKE` | Mechanics sound; model failed the task. | class statistics only |
| `PROVIDER_FAIL` | Provider outage/limits, not injected by us. One retry after backoff; excluded. | no |
| `TEST_INFRA_FAIL` | Torture tooling broke. Fix & rerun; excluded; 3+ in a wave = tooling stand-down. | no |
| `INVALID` | An injection's **manipulation check** failed — the fault never engaged; the observed outcome proves nothing. Re-run after injector fix. | no |
| `INCONCLUSIVE` | Ambiguous evidence or predeclared healthy-straggler stop; manual triage. | manual |
| `NOT_RUN` | Skipped (gate/budget/shed, or an event-conditioned injection whose trigger state never materialized). Always reported. | no |

Precedence is mechanically total: attempts are scored individually; the
case outcome is the final attempt's after the retry rule; a mechanical
oracle violation is PRODUCT_FAIL regardless of provider status or a failed
manipulation check on some *other* injection.

## Scenario classes & sample sizes (fixes the n=1 fallacy)

| Class | Members (approx.) | n by end of | Advisory threshold |
|---|---|---|---|
| BUGFIX | W1.L3×5, W2.05–08, W3.01–10, storm bfmw | ~19 (W3) | ≥70% non-mechanical success |
| FEATURE | W2.09–12, W3.11–16, marathon, storm fdmw | ~13 (W5) | ≥60% |
| AUDIT | W2.16–19, storm sec | 5 (W5) | ≥50% (report-only) |
| BAIT | W4.16, W4.17 variants | ≤4 | report-only, never gating |

Until a class reaches n≥8, its rate is **advisory**. Wave gates are
computed over MECHANICAL outcomes only: zero unwaived S0/S1 AND
(PRODUCT_FAIL / (PASS+PRODUCT_FAIL)) below the wave's bound, with all
other outcomes excluded from both terms. Degenerate-denominator rule:
gate additionally requires `PASS+PRODUCT_FAIL ≥ max(6, 50% of the wave's
manifest cases)` and all `mandatory` cases classified; >25% INCONCLUSIVE
holds the gate closed. Gate decisions persist to `results/gates.jsonl`
with inputs; two controllers must compute identical results.

## Severity gates & waivers

- **S0 (stop-the-campaign):** phantom merge; target-branch work loss;
  production contamination; out-of-scope destructive behavior.
- **S1 (block release):** other O2/O10/O11/O16 violations; WDGM-class
  false kill; zero-token completed run; wedge >2 dispatch intervals +
  5min; claim livelock; cross-run workdir violation.
- **S2 (fix-before-next-campaign):** hygiene oracles, status lies, parity
  splits, laundering shapes, operator-model doc gaps.
- **KNOWN-OPEN (waived):** pre-registered findings (currently: W4.04
  agent-writable gate keys [puma M1–M4], W4.20 HARN containment, W4.29
  finalize retry policy [puma H1], the get-ready dashboard-port bug). A
  reproduced KNOWN-OPEN confirms the register and does not affect
  certification; an S0-severity reproduction still stops the campaign.
- An S1 hot-fix **closes the execution at the old TT_COMMIT** — the fixed
  scenario's confirmation attaches to the finding, but subsequent waves
  run as a new execution against the new SHA; results are never aggregated
  across commits.

## Forensics bundle (on any PRODUCT_FAIL)

Frozen automatically: run row + steps + stories + events slice; harness
invocation logs; working clone tar; worktrees; TT daemon log segment;
oracle output; recorder samples; TT_COMMIT; machine + timestamps.
**Wedge capture before any manual unstick:** rows, last 500 events,
census, `git status` everywhere, worktree list — then, in order, `nudge` →
`resume` → `stop`, recording which step unstuck it (manual-unstick = S1/S2
with forensics captured first). For every real-model MACHINERY failure,
the captured round transcript is translated into a deterministic scripted
replay (behaviors file) and verified to reproduce — that replay, not a
one-line recipe, is the reproduction artifact attached to the finding.
In-campaign human reads are limited to S0/S1 bundles; S2 bundles queue for
post-campaign review.
