# 06 — Wave 2: Full Workflow Catalog (T+8h → T+20h, soft 10M / hard 13M tokens)

Every bundled workflow except the three `*-github-pr` variants runs for real
at least once — 20 workflows. Languages are spread so each fixture hosts ≥3
workflows (cells whose language the host profile lacks fall to the
same-workflow cell on a supported fixture — the workflow coverage
guarantee survives any capability profile; the language spread degrades
honestly and is recorded); harness is pi except where marked (hermes gets
its full duel in W3; here it seeds coverage on two extra families).
Concurrency 3.

## Coverage matrix

| ID | Workflow | Fixture | Harness | Task (from `tasks/`) | Notes / family oracles |
|----|----------|---------|---------|----------------------|------------------------|
| W2.01 | do-now | tt-go | pi | small refactor + test | already smoke-covered; here with a meatier task |
| W2.02 | just-do-it | tt-java | pi | a bug-symptom task (BUG-J3's symptom text) | The meta-dispatcher's second-order failure mode: it launches a child `workflow run` of its own — assert the child run is tracked, terminal, and linked, and the parent's status reflects the dispatch (never a phantom "completed" that orphans a child); record which workflow it selected. Registration-failure class also rides here (W2.21) |
| W2.03 | do-review-do-verify | tt-rust | pi | medium function + adversarial review | reviewer must produce actionable ISSUES at least once across attempts (behavioral) |
| W2.04 | frontend-test | tt-ts | pi | verify expense-form rendering | agent-browser path; visual PASS/FAIL honesty probed by W4 bait variant |
| W2.05 | bug-fix | tt-python | pi | BUG-P2 | direct mode |
| W2.06 | bug-fix-worktree | tt-java | pi | BUG-J2 | worktree create/validate/cleanup; O6 |
| W2.07 | bug-fix-merge | tt-go | pi | BUG-G2 | O2 + O10; merge into non-default target `release/1.x`. Mechanism: working clone **pre-checked-out on `release/1.x`** AND `--context original_branch=release/1.x` seeded at launch (belt-and-suspenders: in the non-worktree variant `ORIGINAL_BRANCH` otherwise depends on the setup agent capturing the right branch at the right moment — a third failure mode where the agent captures a wrong-but-plausible branch and lands there would otherwise masquerade as success until O2 reads the refs). O2 must assert the landing ref is EXACTLY `release/1.x`. Honest expected outcomes: clean landing with zero main-content bleed (patch-id), or a PRODUCT_FAIL against the bundled prompts' hardcoded `main` ("checkout -b from main", `git diff main...`) — a pre-known-candidate finding, NOT an AGENT_FLAKE (DC12/DC45) |
| W2.08 | bug-fix-merge-worktree | tt-rust | pi | BUG-R2 | flagship bfmw; full O2/O9/O10 |
| W2.09 | feature-dev | tt-ts | pi | FEAT-T1 (backend) | loop + verify_each; stories 2–3 |
| W2.10 | feature-dev-worktree | tt-python | pi | FEAT-P1 | |
| W2.11 | feature-dev-merge | tt-java | pi | FEAT-J1 | O2; TESTED_TREE attestation end-to-end |
| W2.12 | feature-dev-merge-worktree | tt-go | pi | FEAT-G1 | flagship fdmw |
| W2.13 | quarantine-broken-tests | tt-java | pi | quarantine BRK-J1..J2 | `--context branch=...` CALLER_PROVIDED key; O8 inverted: ONLY test files may change |
| W2.14 | quarantine-broken-tests-merge | tt-python | pi | BRK-P1..P2 | quarantine + landing |
| W2.15 | quarantine-broken-tests-merge-worktree | tt-ts | pi | BRK-T1..T2 | |
| W2.16 | security-audit | tt-go | pi | audit (VULN-G1..G2 seeded) | scan must find ≥1 seeded vuln (behavioral ≥70%); VULNERABILITY_COUNT contract |
| W2.17 | security-audit-worktree | tt-java | pi | VULN-J1..J2 | |
| W2.18 | security-audit-merge | tt-ts | hermes | VULN-T1..T2 | hermes on a long multi-agent family before W3 |
| W2.19 | security-audit-merge-worktree | tt-rust | pi | VULN-R1..R2 | the known token-churn-prone family — record spend vs baseline |
| W2.20 | skills-normalize-audit | (skills dir fixture) | pi | audit a seeded skills tree with 2 planted near-duplicates | runs against a purpose-built `$TT_ROOT/fixtures/tt-skills` COPY (assert the source it was copied from is untouched — self-referential workflows always run against copies); SKILLS_JSON contract. Same copy-protection rule applies to W2.04's frontend-test if pointed at anything resembling a real checkout |

## CLI-surface conformance thread (interleaved, cheap)

Each W2 launch deliberately varies the launch surface so the whole flag
matrix is exercised by end of wave:

- `--task-file` (all tasks) incl. one task containing `--`-prefixed lines and
  shell metacharacters (arg-parsing hostility);
- `--wait --json` (controller default) and one detached launch harvested via
  `workflow wait <selector> --timeout`;
- `--context key=value` extra keys on two runs — asserted to survive into
  run context verbatim and to appear in any relaunch (context-fidelity
  class DC13);
- `--timeout` with `--wait` on one run sized to NOT hit it (the hit case is
  W4's);
- one launch each of `workflow status --json`, `workflow runs --json`,
  `logs <run>`, `logs-tail`, `worktree list/status` mid-run — outputs must
  parse and agree with the DB (O13 adjunct);
- prefixed (`run-<uuid>`), bare-uuid, and `#N` selectors each used at least
  once across the wave.

## Edge & authoring scenarios (cheap, deliberate)

| ID | Scenario | Assertions |
|----|----------|------------|
| W2.21 `T1` | **Admission edge** (≈0 tokens): launch W2.02 with the TT daemon stopped. | Exactly one run row; success-shaped CLI output; pending-admission state; reconciler admits within one dispatch interval of daemon start. `nudge` with daemon down exits non-zero, spawns nothing. |
| W2.22 `T1` | **Non-`main` default branch** (DC45): bfmw on `tt-python@master` (no `main` ref exists — 02). | Run terminal + landing on `master`, OR a filed PRODUCT_FAIL against the bundled prompts' hardcoded `main` — the likely and legitimate outcome. Structurally invisible to every other fixture; certainty-grade for 2000 users. |
| W2.23a/b/c `T1` | **Hostile custom workflow, split by phase** (≈0 tokens each, DC46 — source review shows the three defects surface at DIFFERENT times, so one combined scenario would mask two of them: install validates only basic shape, `expects` regexes compile only at step completion, missing persona files are today *silently skipped* at provision time): (a) non-compiling `expects` regex; (b) dangling `on_fail.retry_step`; (c) missing persona file. Each: `workflow install <dir>` then `workflow run` (scripted harness — zero tokens). | Per phase: refusal with actionable diagnostics at the EARLIEST phase that can see the defect, and never a doomed run row nor a daemon crash. Where current behavior is silent acceptance (c — and likely a here), the scenario documents it as a PRODUCT_FAIL candidate: a workflow that installs green and dies mid-run at step completion is exactly what a workflow-authoring user hits. |
| W2.24 `T1` | **Docs-drift probe** (DC46): the 2-agent example from `docs/creating-workflows.md` VERBATIM; install; run with pi on tt-ts. **First validated in P1 (pre-campaign)**; in-campaign it runs only if docs or installer changed since the last campaign, and a docs bug found in P1 is filed + registered KNOWN-OPEN rather than left to fail every campaign's W2 gate. | It completes. |
| W2.25 | **Reserved-key behavior pinning at launch** (≈0 tokens, DC47): three separate launches — `--context original_branch=evil`, `--context run_id=bogus`, `--context test_cmd='echo tt-sentinel'` (harmless sentinel; never a destructive string). | Per-key EXPECTED behavior verified against source and pinned by the test: caller `test_cmd` is preserved into context; `original_branch` is later overwritten by the harness seed in worktree mode (assert the seed wins) but flows through in direct mode (assert where it lands); `run_id` is canonically re-injected at claim time (assert the bogus value never renders). The earlier "whatever the behavior, it is documented" phrasing was non-falsifiable; each sub-case now has a concrete expected stored + rendered value, and any deviation is the finding. |
| W2.27 | **MCP smoke** (≈0 tokens): via the TT MCP port — list tools; start one do-now through the MCP run-start tool; one deliberately-wrong call violating the workingDirectory-XOR-worktree-params validation; poll run status through MCP. | MCP is a production entry point the workflow matrix never touches: tool list complete; run starts and terminates; the invalid call is rejected with a diagnostic, not a crash. |
| W2.28 | **Fresh-install & auto-start happy path**: in a THIRD disposable fake-HOME, `get-ready` on default-shaped ports (services must actually come up there — no port juggling), then a plain `workflow run do-now` with **no daemon running**. | The daemon auto-start path (`ensureDaemonControlAvailable`) is observed (pid, detach, ports); the run completes; `daemon stop` is clean; nothing leaks outside the disposable HOME. This is every new user's first command, and it is exercised nowhere else (W0 starts daemons explicitly; W2.21 suppresses auto-start). |
| W2.29 | **AutoResearch bounded session** (small): `autoresearch init` + 2 experiments on a tt-python clone (metric: pytest pass count). | The subsystem is otherwise invisible to the suite; a 2-experiment session catches init/parse/registry breakage cheaply; `status` renders the session. |
| W2.26 | **Webhook notifications** (≈0 tokens, DC50): a custom workflow declaring `notifications.url` pointed at a loopback HTTP sink; scripted harness run through terminal state. | Significant events delivered to the sink; delivery failure is non-blocking; AND the pre-registered suspicion is tested: source review indicates normal CLI/MCP launches never populate `runs.notify_url` from the YAML at all — if confirmed, the advertised feature is dead code from every normal launch path and that is the finding. |

## Platform-conditional additions `[darwin]`

On darwin hosts, W2.20 additionally runs its path assertions in
`/private/var` realpath form, and the worktree/merge/loop cells double as
the BSD/launchd/slow-spawn coverage (WDGM's birthplace) — no extra runs,
the predicate just adds assertions. Deeper darwin-specific scenarios live
in W4's `[darwin]` lanes.

## Wave gate (mechanical outcomes only — 03)

All 20 workflows reached a terminal state; zero unwaived S0/S1; mechanical
PRODUCT_FAIL rate < 20% → open W3 fully (W3's early lanes may already have
started at T+10h if the merge families were green). Any workflow family
that PRODUCT_FAILed is re-run once post-triage (in Triage block A) before
the storm may include it. Behavioral rates recorded, advisory only.
