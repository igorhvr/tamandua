# R4b: repeatable review gates and safe operator tooling

## Authority, launch boundary, and scope

Beads `tamandua-6sy.5` is the durable task. This records the already approved
suite batch; it is not an authorization for new product changes. Launch only
after R4a's independent review, as that issue's dependency requires. Develop
through one normal Linux dsh `feature-dev-merge-worktree` run. The coordinator
may prepare this task record now; preparation is not implementation or launch.

Authority: Beads memories `gevr-s50-2026-09-01`, `ship-tt-2026-09-01`,
`push-policy-2026-09-01`, `macseq-2026-09-01`,
`s63-invalidate-credentials-models-json-2026-09-03`, and
`s65-w09-case-wall-under-load-2026-09-04`, plus the R4b issue's later notes.
Read the CURRENT versions before acting. The present source layout is context,
not permission to hardcode historical commit IDs, line positions or file counts.

Implementation belongs under `torture-test/`. Do not change product source,
product tests, package dependencies, installer behavior, or bundled personas.
RISO and RJSON have separate runs: use their reviewed landed interfaces when
available, and report an integration dependency rather than duplicating them.
TSCP, MSIG and KHYG are separate product decisions, not this batch's scope.

## Non-negotiable operating rules

- No broad removal, forced worktree removal/pruning, reset/checkout discard,
  pattern/name-based process kills, fixed `/tmp` cleanup, or destructive command
  replay from sessions. Preserve all preexisting worktrees, campaigns and logs.
- Allocate fresh owned fixture/output directories, validate the root ITSELF
  and its ancestors against symlink escapes before writing, and retain review
  evidence. Never let inherited test variables choose deletion/signal targets.
- Test helpers may clean only exact fresh roots and verified child identities
  they created. Before exercising dangerous helper paths, prove negative arms
  with write/signal recording stubs. Do not test safety by targeting real data.
- Keep the test-isolation guard and private HOME/state/DB/random ports. No live
  daemon lifecycle/configuration change, real campaign or paid canary during
  this implementation run. Do not copy old guard-bypass conventions.
- Serialize full npm, focused MCP/get-ready and fast e2e gates using the
  coordinator's current shared-lock instructions in Beads/progress. Commit
  before a gate and do not edit its tree while queued or running. Other pure
  checks may parallelize; torture self-test FILES run individually.
- No changes to global/local git configuration or real hooks. Preserve signing
  settings and Beads integration. No origin push, remote sync or deployment.
- Every CLI needs side-effect-free help. Linux and actual macOS system Bash
  3.2 compatibility matter; static lint alone is not a Darwin execution proof.

## Story convention

Keep each story below a separate implementation/proof boundary. Each has ONE
designated verification gate, with a recorded exact command, source tree,
exit/result and retained log. Normal workflow build/npm validation remains
required and is not a second full torture ladder. A story must fit one six-hour
worker round. Do not combine these into a final multi-hour mega-story.

The full independent ladder runs ONCE post-merge on the combined candidate,
under coordinator control. New ladder tooling is tested hermetically here;
writing it does not mean the real ladder has run. No within-run proof-reuse
ledger or new certification-waiver machinery: the former S50 ledger remains
shelved. Existing source-bound npm wrapper behavior is unchanged.

## US-001: enforce one explicit proof gate per new task story

Add a focused task-file lint with a small documented declaration convention.
Reject missing/duplicate designated gates and packed independent full ladders
inside one story. Recognize normal build/npm validation separately. Do not
pretend a regex can infer arbitrary prose intent: unsupported/ambiguous
declarations must produce an actionable diagnostic, not a false approval.

Cover valid one-gate stories, the old packed R4a final-story failure shape,
normal npm alongside a focused gate, malformed declarations and quoted
examples that are not active instructions. Apply to newly authored tasks;
historical signed task records stay unchanged and may be audited separately.
Do not add a runtime product requirement or silently rewrite a planner's DB.

Designated gate: one hermetic task-lint regression test file.

## US-002: safe pinned review runner and per-stage evidence

Check in a coordinator-facing review runner with explicit candidate commit,
checkout and output arguments. Allocate fresh retained, nonnested worktrees
and result directories; refuse dirty input, collisions, symlink escapes and
source drift. Do not reuse the legacy handoff helper's remove/prune logic.
Capture exact stage argv, start/end UTC, actual exit, host, source/tree pin and
log path. A failed stage fails the runner; pipeline tail/tee success must not
mask its command's failure. Interruptions remain interruptions, never passes.

Keep campaign evidence under its own exact campaign identity. Never flatten
multiple report/state files into one destination or select the newest campaign
by directory mtime. Preserve failure output too. An incomplete stage record
cannot be resumed as green. This is evidence capture, not a proof-reuse waiver.

Designated gate: one hermetic runner orchestration/retention regression file,
using recording child adapters and synthetic directories, no real ladder.

## US-003: declare the complete independent review ladder

Wire the reviewed stage runner to the unchanged regular self-test battery,
controller checks, isolated heavy-campaign runner, oracle mutation/calibration
battery, and the bare `run-torture-test --tier0`, `--tier1`, `--tier2` ladder.
Discover current registered membership; do not pin an old 161/171 file count.
Each heavy file has its own process and generous individual ceiling, never a
single timeout around an aggregate that can orphan its grandchildren.

Declare prerequisites and a quiet contained-port window. Only one torture
ladder may use this host's contained ports. A bare wrapper tier is NOT a full
real campaign; the direct controller's launch behavior also differs from the
wrapper. Preserve the original w4.35 fossil and all oracles. No exclusions
added to make a red green; a diagnostic O9 skip is never accepted proof.
Keep both-host npm/fast/real release certification and full real campaigns
separate and visibly still required.

Designated gate: one hermetic ladder-membership/order/exit-propagation test.

## US-004: read-only native-session unsafe-command audit

Add a tool that reads explicit native session files/directories and reports
candidate broad kills, unsafe cleanup, and cross-run ownership concerns, with
source file, record/line or call identity, UTC timestamp, and bounded evidence.
Support actual dsh compressed JSONL and pi session shapes used here. Never
execute a historical command, source a transcript, mutate sessions or signal
anything. Bound decompression/output and report unreadable/truncated inputs.

Distinguish executable command candidates from comments, quoted examples,
regex search arguments, and observational `kill -0`. Do not call a textual
match a proven kill: report parse/target uncertainty and require correlation
for an impact claim. Default output must not dump credential-bearing prompts
or argv; redact safely while retaining usable local evidence references.

Designated gate: one synthetic-session corpus regression, including genuine
cross-run PID-list/pattern candidates and the observed grep-regex false alarm.

## US-005: cross-worktree contained-owner diagnostics (S53)

Improve readiness evidence so an identity-verified TT daemon belonging to
another worktree of THIS repository is distinguished from a foreign process.
Report owning checkout, associated run if established, listener/PID identity,
and whether the ownership evidence is current. Unknown is not foreign or safe.
Refuse readiness while another live campaign owns the shared ports.

Prefer the narrow existing-provenance lookup over a new global port allocator.
Do not add automatic stale-daemon kills or cleanup. Any later coordinator stop
must use the exact owning checkout's existing daemon-control path, after a
fresh no-live-run/identity check. Tests use synthetic provenance and owned
random-port children only, with negative controls for stale/reused PID,
symlinked owner roots, unrelated repository and active neighboring worktree.

Designated gate: one focused cross-worktree ownership/readiness regression.

## US-006: checked-in macOS login environment and stage recipes

Replace the operational dependence on untracked handoff scripts with reviewed
scripts/docs under `torture-test/`. Use the real login-shell setup for harness
discovery (`zsh -il` with correctly quoted explicit argv); no zsh scalar word
splitting assumptions. Record bounded tool path/version probes, not secrets.

Stage boundaries: verify clean pinned checkout and zero relevant live runs;
build and normal npm/fast gates with honest exits; provision with supported
`--rebuild-invalid` rather than deleting goldens; readiness through the proper
contained daemon-control interface; explicit authorized campaign launch and
exact campaign-ID capture; monitor/report/archive by that identity. No blind
sleep as readiness, fixed overwritten logs, newest-directory guessing, or
historical omission of npm. Preserve the distinction between actual observed
concurrency and configuration, and between initial and post-wave campaigns.

The implementation run tests scripts with recording adapters only. Actual Mac
sync/build/lifecycle/campaign execution belongs to the coordinator in a later
verified zero-run window. Do not hardcode operator-specific credentials.

Designated gate: one hermetic stage/quoting/failure/identity regression file.

## US-007: complete contained credential invalidation (S63)

Review the current minimal credential-surfacing contract, then cover every
credential-bearing source actually supplied to the selected contained pi
process: auth.json, optional models.json provider credentials, and surfaced
environment/provider material. Document exact coverage. Never touch the
operator's originals or print keys; do not disable providers in product code.

Back up only owned contained sources with restrictive permissions and exact
metadata/content restoration. Refuse symlink/escape targets and stale or
foreign backups. Preserve the first authoritative backup, absent-optional-file
state, and crash/partial-operation recovery. Restore on every termination path
without mislabeling compensation as successful workflow recovery. Tests use
synthetic secrets and adjacent sentinels, including credentials surviving via
models/environment, optional absence, failure mid-operation and repeated calls.

Designated gate: one focused hermetic credential lifecycle red/green file.
Its simulated coverage is not a claim that a real pi auth-expiry cell ran;
the actual fail-without-key/restored operation remains a later campaign proof.

## US-008: current-product auth-expiry choreography and caps

Integrate R4a S62/S61 with current first-dispatch harness probing and the
instant-fail defaults K=6/N=20. Keep launch-time invalid credentials and MID-RUN
expiry distinct. The mid-run case must establish the real pre-expiry phase,
then invalidate, observe the relevant failure/backoff evidence, restore and
demonstrate the intended recovery. A first probe failure followed only by
terminal compensation is not that result. Preserve an explicit negative arm.

Derive wall caps from the current backoff/scheduler path and measured fixture
timing with margin, not stale K3/N10 arithmetic. Do not disable the probe,
revert product defaults, weaken a failure assertion, or conceal NOT_RUN.
Track live e2e/frozen torture harness probe contracts where applicable.

Designated gate: one isolated scripted auth-expiry corridor regression file,
with launch-failure and genuinely mid-run branches in that one scoped gate.

## US-009: W0.9 wall calibration and load evidence (S65)

Calibrate the W0.9 install-shape case ceiling against actual natural duration
on a clean pinned candidate, retaining wall/load evidence and a bounded
justification. The prior one-minute overrun is not automatically a product
regression. The TFLK-approved 600-second PRODUCT installation test is a
different deadline; do not edit it here or claim it fixes W0.9's case wall.

Preserve install-shape assertions. Keep load observations explicit (unknown
when unavailable) and useful for adjudication, not as a blanket reason to
retry or reclassify every failure. Do not inject artificial global host load.

Designated gate: one isolated W0.9 calibration/coverage gate with retained
natural timing and the selected suite-only cap's rationale.

## US-010: SHIP-TT note and mechanical Tier-0 push-gate adapter

Add `torture-test/README.md` explaining deliberate adversarial/vulnerable seed
fixtures, why they ship, and that product installation/normal product tests
do not execute those seed programs. Document the reviewed operator entrypoints
and evidence/authority boundaries; no install.sh exclusion or behavior change.

Wire the spec's REAL Tier-0 push gate, not merely a bare scripted tier: W0
checks/delivery corridors, zero-token verdict matrix, one real pi bfmw with
full gating oracles and one real Hermes do-now attribution canary. Retain the
<=3h/<=2M budget contract and actual executed/expected outcome checks. Missing
real cells, stale pin, incomplete/red outcomes, or interrupted stages fail
closed. No paid execution in this implementation run; use recording adapters.

Build/test the pre-push integration in fresh fixture repositories. Preserve
preexisting hook behavior, argv/stdin, failures and Beads managed blocks; do
not silently replace core.hooksPath or assume .git/hooks. The current live
hook is `.beads/hooks/pre-push`, managed by Beads. Real hook installation is
coordinator work after reviewing the exact existing target; no network push
or live hook/config mutation here. Distinguish release-origin main from
non-release remotes/refs; never block an unrelated ref based on a substring.

A green Tier-0 is NECESSARY, not sufficient for pushing stacked product
commits: both-machine npm + fast e2e + real e2e with zero refusals remain
required by the user's certification policy. Do not fabricate certificates,
add a bypass variable, or claim this adapter enforces proof it never checked.
Document the remaining coordinator-controlled release boundary explicitly.

Designated gate: one hermetic push-adapter/hook-chain regression file; its
fixtures also validate the README's separation of bare, real and release gates.

## US-011: bounded in-run integration evidence

Run the unchanged regular `bash torture-test/self-tests/run.sh` battery on the
clean committed implementation tree, with truthful discovered membership and
retained output. Preserve its existing exclusions as separately owed heavy
gates. Do not stack heavy/controller/oracles/all bare tiers into this story.
Any focused story proof already recorded remains bound to its actual tree;
the coordinator will execute the full independent combined-tree ladder later.

Designated gate: `bash torture-test/self-tests/run.sh`.

## Handoff and acceptance

Report exact commits, changed scope, each story's real gate result, evidence
locations, actual Darwin checks performed versus still owed, and unresolved
findings/dependencies. Keep canonical progress history; do not overwrite a
coordinator red with an internal approval. Local merge is an implementation
milestone, never certification or origin-push permission. R4b's Beads issue
stays open until the independent reviewer has accepted the landed candidate.
