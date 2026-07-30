# 12 — Runner & Automation Design

The suite is executed by a small toolchain living in this directory
(implementation is a follow-up work item; this file is its contract).

## Components

**`tt-run` (controller).** Reads `cases.jsonl` — one line per scenario:

```json
{"id":"W3.07","wave":3,"workflow":"bug-fix-merge-worktree",
 "fixture":"tt-ts","harness":"hermes","task":"tasks/W3.07.md",
 "requires":{"toolchains":["node"]},
 "context":{"...":"..."},"caps":{"tokens":4000000,"wall_min":240},
 "boundary_files":["ts/src/..."],"forbidden":[],"mandatory":true,
 "oracles":["O1","O2","O3z","O4","O8","O9","O10","O11"],"gates":["W2"],
 "chaos":null,"shed_ok":false}
```

(The example is a REAL manifest line — CI validates every example in this
spec against `cases.jsonl`; an earlier draft's example named a nonexistent
scenario with the wrong cap and omitted O8.)

Responsibilities: host-profile predicate evaluation (cases whose
`requires` the host profile fails → `NOT_RUN (predicate)`, recorded),
fixture reset (per 02), launch via
`tamandua workflow run <wf> --task-file ... --wait --json --timeout ...`
under `tt-env.sh`, stagger control,
5-min token polling against caps, harvest of `--json` results + DB rows,
per-run oracle execution, outcome classification (03 taxonomy), budget
ledger, wave-gate evaluation, forensics bundling, report generation.
Controller state is a flat `results/state.json` — resumable after its own
crash (the controller must not be the least reliable component).

**Run-id capture (source-verified mechanics, not hope):** the launcher
prints `Run: run-<uuid>` on stdout early, and an 8-char short id on
stderr BEFORE `git worktree add` begins — the controller captures BOTH
streams from launch, so even a launch killed mid-worktree-add leaves an
identifiable run id (W4.11's forensics depend on it). `--wait --json`
emits its JSON only at wait-exit: a controller (or timeout) that kills
the waiter gets NOTHING on stdout — the DB row, found by the captured
id, is the fallback harvest path, always. Corollary — **the wait-exit ↔
DB cross-check is free coverage on every single run**: the waiter's exit
code and printed JSON must agree with the DB terminal state (a waiter
that exits 0 for a failed run, or prints `completed` while the row says
`failed`, is an O13-class truthfulness finding harvested at zero cost
from all ~110 runs).

**Discovered runs are first-class records:** runs the controller did not
launch but finds in the TT DB (just-do-it children, rugpull relaunches)
get their own case record with `parent_run_id`, a deadline recomputed
from THEIR start time, and token spend attributed to the root case's
budget. An untracked child is how a "completed" campaign leaves a live
run burning tokens after teardown — the W6 sweep asserts zero
non-terminal discovered runs.

**`tt-oracle` (battery).** Each oracle is an independent executable check
(`oracles/o2-merge-truth.sh <run-id>` etc.) emitting PASS/FAIL + evidence
JSON. Two tiers per 03: the gating set (O1, O2, O3z, O4, O8, O9, O10, O11)
built with **mutation self-tests** (a tiny synthetic state where each MUST
fail — e.g. a fabricated completed-run-with-unmoved-ref for O2; `tt-oracle
--self-test` runs in W0.8 and an oracle that can't detect its own synthetic
violation blocks the campaign), and the post-batch hygiene set (O5–O7,
O12, O13) as plain batch scripts with no in-campaign gating. Verification
code with no verifier is how the last three "green" regressions shipped
(DC33).

Beyond per-oracle self-tests, a **calibration pack** of hand-built
evidence states exercises the oracles' *hard* cases (a synthetic
violation proves the happy detection path; these prove the subtle ones):
an O2 phantom-merge state (completed run, annotated events, target ref
genuinely unmoved, plausible-looking branch); an O9 stale-replay state
(green ledger row whose tree hash matches but whose recorded suite
duration predates a committed suite change); an O11 cross-charge state
(two concurrent runs, one round's tokens written to the other's row).
Each must be caught by its oracle in W0.8. The pack is versioned with the
oracles — an oracle change that stops catching its pack member fails CI
before it ever reaches a campaign.

**`tt-recorder` (process telemetry).** A local sampler (nohup loop, 5s:
PID/PGID/cwd/cmdline of tamandua-family processes → flat file, harvested
into `results/` at wave boundaries). This is O4's liveness-provenance
source. Evidence collection is cmdline/cwd/lsof-based, never env-based
(portable across kernels that hide other processes' env).

**`tt-chaos` (operator).** Executes per-scenario/per-storm schedules:
timed kills (evidence-based PID selection only — cwd/cmdline under TT
paths; never name-match), colleague commits (from a second clone, plain
git), pauses/resumes/cancels via the tamandua CLI, port squatters, TSTX row
deletions. Every action logged with timestamp + target evidence to
`results/chaos.log` (the log is what lets O4 distinguish "watchdog killed a
live worker" from "chaos killed it"). Two hard rules from 08's injection
discipline: **target guards** (re-verify run id / pid provenance /
TT-path containment immediately pre-fire; guard miss = abort + INVALID)
and **`phase_wait`** — a shared library polling DB step-state / event
rows / file markers with a timeout, so every injection is event-triggered
("when finalize claims", "when the park event lands"), never
sleep-timed; the awaited phase marker is logged next to the action. The
evidence-capture-before-destruction protocol (11) is implemented here,
automatically, per destructive action.

**`daemon-control` (wrapper).** The ONLY sanctioned start/stop/restart
path for TT daemons (01): starts each daemon inside its
`systemd-run --user --scope` unit, re-asserts cgroup membership after
every start (including chaos restarts), records pid/port/scope
provenance to the manifest. Bare `tamandua restart` anywhere in the
tooling is a defect in the tooling.

**`tt-fixture`.** Golden management, reset, arming patches, junk
regeneration, integrity checks (02).

**Scripted-runtime forks.** The scripted-pi / scripted-hermes runtimes
are forked from the repo's e2e fakes at a FROZEN SHA recorded in the
manifest, extended with the fault knobs the scenarios need
(`--delayed-trailer`, `--oversized-stdout`, absent/malformed trailer —
W4.40; provider-error rounds — W4.46). A **fork-parity check** runs in
W0.2: the unmodified code paths of the fork must byte-match the frozen
SHA's fakes (diff of the non-knob regions) — a fork that silently drifts
from the contract the product's own e2e suite pins would test a harness
that doesn't exist. Behaviors files per 01's concurrency protocol
(scenario-unique workflow copies, `<workflowId>_<agentId>` keys).

## Design rules

- **The controller never interprets agent prose.** Pass/fail comes from
  exit codes, DB state, git state, filesystem state.
- **Idempotent + resumable:** every case execution is recorded before
  launch; on controller restart, in-flight runs are re-attached via
  `workflow wait`, not relaunched.
- **No hidden caps:** anything the controller sheds, skips, retries, or
  quarantines appears in the report; `NOT_RUN` is a first-class outcome.
- **Clock discipline:** all timestamps UTC ISO-8601; the report's timeline
  is reconstructable from `results/` alone.
- **Single-host, local-only:** the controller and everything it touches
  run on the host; no remote transport exists in the tooling. Running the
  campaign elsewhere = installing and running the whole suite there.

## Manual touchpoints (kept deliberately few)

1. Start campaign (after reviewing `TT_COMMIT`).
2. **Async gate review** — gates auto-open on green mechanical criteria
   (03/11; the controller persists each decision + inputs to
   `results/gates.jsonl`); humans review the decisions asynchronously and
   may retroactively quarantine a lane. (An earlier draft required human
   gate confirmations here while 11 said auto-open — the auto-open policy
   governs; there are no blocking confirmations.)
3. S0 page response (the only blocking human interaction).
4. Triage blocks TrA/TrB: S0/S1 bundle reads + post-triage re-run calls.
5. W6 report review + `bd create` for findings.

**Notification channel (named before T+0):** "pages a human" must bind to
a real mechanism recorded in the manifest (the operator's actual phone /
messaging hook — whatever igorhvr designates), tested once during the
dress rehearsal with a synthetic page. Page-worthy events, exhaustively:
any S0; a SECURITY-ALERT–tagged finding (the control-plane posture
probe's unauthenticated-mutation case, 08 §J, or an isolation breach —
O15); a gate-halt (wave
mechanically blocked with no auto-open path); controller death without
auto-resume. Everything else waits for the async review. An unbound
"page" is a log line nobody reads at 03:00.

## Implementation phasing (pre-campaign work — honest estimates)

- **P0:** host provisioning to the target tier (toolchains the host
  profile lacks; see 01). Own acceptance test. Est. 0–2 days depending on
  the host.
- **P1:** tt-env + fixtures + goldens + baselines + calibration runs +
  task-library generation. The dominant lift: ~5kLOC of idiomatic seeded
  code across five languages, arming patches, known-good fix patches,
  dual-machine baselines. Est. **2–3 weeks** (the first draft said 3–5
  days; reviewer arithmetic says otherwise). Tier-1 needs only tt-ts +
  tt-python + tt-poly-lite ≈ 1 week. Build fixtures via tamandua runs
  where practical — dogfooding included.
- **P2:** controller + gating oracles + self-tests + recorder. Est.
  **1.5–2 weeks** (it is a small distributed system, not a script).
  Post-batch hygiene oracles can trail into the campaign window.
- **P3:** chaos operator + **single-daemon scripted storm harness** (an
  explicit deliverable: the existing stress-concurrent test runs 8
  ISOLATED daemons by design and rehearses nothing about a shared-daemon
  storm) + full storm choreography rehearsed at zero tokens via
  `TAMANDUA_PI_BINARY`-scripted agents. Est. 3–5 days.
- **P4:** the W0 dress-rehearsal day — the acceptance test of all
  tooling, with an explicit **exit gate** (pass it or the campaign date
  slips; "mostly rehearsed" is unrehearsed): (a) a 1-hour miniature
  end-to-end slice — controller launches 2 scripted cases + 1 real
  canary, oracles run, report fragment generates; (b) the
  **known-negative case** end-to-end — a scripted scenario with a
  deliberately-planted product-behavior violation (e.g. the calibration
  pack's phantom-merge state wired as a live case) must traverse
  launch → harvest → oracle → classification and come out the other end
  as a named PRODUCT_FAIL in the report fragment. A pipeline proven only
  on green cases has never demonstrated it can report bad news;
  (c) runner kill/resume mid-slice (kill -9 `tt-run` between launch and
  harvest; restart; the in-flight case re-attaches, nothing double-
  launches); (d) one synthetic page through the real notification
  channel; (e) one predicate-excluded case traversing the pipeline and
  landing in the report fragment as `NOT_RUN (predicate)` — the descope
  path proven, not assumed.

Total pre-campaign investment, honestly sized: **~25–40 person-days**
for Tier-2 readiness (the 4–6-week band above, restated at day
granularity because week-rounding hides the spread; Tier-1 ≈ 10–13
person-days). Tracked under bd (`tamandua-20o` and children); campaigns
are repeatable per release thereafter — marginal cost of a
re-certification ≈ 48h + ~50M tokens (Tier-2) or ~24h + ~15M (Tier-1),
all tooling amortized.
