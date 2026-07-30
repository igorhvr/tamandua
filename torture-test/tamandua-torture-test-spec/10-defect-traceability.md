# 10 — Defect Catalog & Traceability Matrix

Every class below was mined from the actual history (commit hashes in
parentheses are representative, not exhaustive) or from production-run
archaeology across two long-lived production installs (a linux and a darwin host — provenance, not execution scope; the campaign itself is single-host, 01). Coverage cites scenario IDs; oracles cited
where coverage is ambient (checked on every run).

| DC | Class (representative fossils) | Covered by |
|----|-------------------------------|------------|
| DC01 | Phantom success — accepted verdict not routed; run "completed", nothing merged (0fc16c6, cecf60c) | O2 on every merge run; W4.14 |
| DC02 | Expects rejecting honest verdicts; capitulation pressure (c7258de RSTY) | W1.L3; O11; W3 matrix verify paths |
| DC03 | Clean exit, no STATUS → wedge/orphan (72a9e9a, 0f39de5) | W4.14; O1 wedge bound |
| DC04 | STORIES_JSON corruption, partial inserts, reserved-key collisions (05d2e62, b741bbc) | W4.15; O12 |
| DC05 | Producer omits keys → doomed consumer retries, misattribution (70ea996) | O11 attribution check; W2 catalog breadth |
| DC06 | Dangling/non-atomic claims, claim-then-NO_WORK livelock (3aa9f84, 57b470b) | O4 sweep; W5 storm (S4 kill + singleflight) |
| DC07 | Watchdog false positives AND dead-claim-requeue-vs-live-child (e1b19bc WDGM, f57426a) | W3.26 [darwin]; W3.17; W4.09–W4.10; O4 zero-tolerance |
| DC08 | Recovery sweeps racing token flush / teardown grace (a0a3428, 9e3fcd8) | W3.22; W5 daemon bounce; O3 |
| DC09 | Killed-mid-launch zombies, phantom runs, orphan shapes (c1ee1fc, 79ed371, 92c038c) | W4.11; O1/O6 |
| DC10 | Porcelain/shared-checkout mutation; checkout-refresh; idempotent relanding (a5865f0, 6b974b7, ab1728e) | O2 idempotence; W4.06–07; W5 |
| DC11 | Checked-out-target landing (PARK) crash matrix (a4a5c57, ba871cd) | W4.03/W4.08 park states; O2 "moved XOR clean park" |
| DC12 | Base/branch identity confusion; wrong target; false rugpulls (d67411c OREF, 03fc0b4) | W2.07 non-default target; W4.06 |
| DC13 | Rugpull duplicate merges; relaunch context fidelity (404b6c4, 7a30a59) | W4.08 both variants |
| DC14 | Union defects — untested union of green branches; stale-index landings (01b92a0, ISFO) | W5 union oracle (the storm's raison d'être) |
| DC15 | Worktree/base skew poisoning verification, two-dot ghosts (5aa92d6 WSKW) | W4.06; W5 concurrent verifies; O4 retry-budget checks |
| DC16 | Worktree leak/cleanup bookkeeping lies (46ce789, 92c038c) | O6 every sweep; W4.13 |
| DC17 | TSTX integrity: drift keying, --force replay, mid-run junk (23386ba, 99ddeaa, dba41dc) | W0.4; O9; W4.18; junk probes ambient |
| DC18 | Ledger-gate policy table; missing-vs-slow conflation (28b2abd, 67843df, d49f871 FMIS) | W4.01–02, W4.05; O10 every merge |
| DC19 | test_cmd wrapper growth, double-wrap, shell injection (dbb9fef, 6504fde) | W1.L2 wrap-once check; tt-java `+` path; O9 |
| DC20 | Harness contract drift — fake pinned wrong contract; silent skip (0c3c30d HSID, a7d7c92 HCND) | W0.5 fail-not-skip probes; W0.7 canaries; real-first design |
| DC21 | Token attribution loss/inflation across abnormal outcomes (1a1e01b, 9ba9522) | O3 every run; W3.18/W3.20 kill-path attribution; hermes bands |
| DC22 | Status/observability lies — stale pidfiles, phantom "running" (297f486, 35f6501) | O13; W4.12; W2 CLI thread |
| DC23 | DB concurrency: duplicate run_numbers, non-transactional completion, handle TTL (9d71f0e, 954b795) | W5 storm launches; O12 |
| DC24 | Event-log rotation/growth, double-writer shifts, nudge spam (55be9d6, 7d4618b HUSH) | O7 every sweep; W5 volume |
| DC25 | Pause/resume stranding; workspace fallback contamination (b0f1249, d92c88c, 85890a8 PAUS) | W3.18–19, W3.27; W5 chaos pause |
| DC26 | Admission/registration edges; nudge auto-start orphans (0baf70b, a6f877b) | W2.21; W5 queue math |
| DC27 | Test/production state bleed (5c3d285 ISOL, 6e2a478) | W0.6 + O15; TT-env design |
| DC28 | Process/port leaks, PID-file split-brain, TOCTOU (d67b32a, 6a8f910) | O5; W4.12 |
| DC29 | Parallel-lane hazards: shared fixtures, tree drift mid-suite (59f5350, f9155e1) | W4.24; per-scenario clones (fixture design) |
| DC30 | macOS portability: procfs absence, hidden env, /private/var, bash 3.2 (66626f5, 7fff3a0) | W4.21–23 and the [darwin]-predicated assertions |
| DC31 | Update/install: stale catalog, stale dist, diverged repo, destructive pulls (e554f7c, ff04c86) | W0.1–0.3 gates; W4.19–20 |
| DC32 | Agent behavior: scope bait, fabrication, rationalization (7a40700 SCPB, d15aace, ec3f39b) | W4.16–17; O8 mechanical backstop |
| DC33 | The test suite lying about itself (54d13b2, 0392b7f) | 12: oracle mutation self-tests; controller dry-run W0.8 |
| DC34 | Timestamp format skew corrupting ordering (772/808 production rows) | O12 |
| DC35 | Cancel-path debris: no terminal event, pending stories on terminal runs (production archaeology) | W3.20; W5 S8; O1/O7 |
| DC36 | Empty-runId events → hidden `events/.jsonl` (mac fossil) | O7 |
| DC37 | Worktree accumulation without GC (17GB linux / 3.2GB mac) | O6 prune check; W6 audit |
| DC38 | Zero-token "completed" runs; system-token tripwire (21 production instances) | O3 every run |
| DC39 | Scheduling-error zombie runs idling for hours (run #89, 17.4h) | O1 bound; W2.21 |
| DC40 | Hermes long-round vs worker-timeout interaction (folklore, never reproduced) | W3.17 marathon |
| DC41 | Slow/red suite legitimacy vs gate (hermes-agent 2485-test FMIS incident) | W4.05 |
| DC42 | Agent-writable `merge_gate` self-exemption (puma M1–M4, OPEN) | W4.04 — expected to produce the finding |
| DC43 | HARN update sourcePath containment (OPEN) | W4.20 — expected-fail, filed |
| DC44 | Node-runtime vendor swap under same state dir (mac fossil) | W0.1; W4.23 |
| DC45 | Non-`main` default branches / hardcoded-`main` prompts (bundled setup + verifier templates) | W2.22; W2.07 |
| DC46 | User-authored workflow surface: hostile YAML, dangling retry_step, missing personas (silently skipped today), docs-example drift | W2.23a/b/c; W2.24; W4.14; W1.L2 (tt-shim-probe) |
| DC47 | `--context` reserved-key injection into merge targeting (user-reachable) | W2.25; O12 |
| DC48 | Resource exhaustion (ENOSPC) & weird-git targets (detached-HEAD origin, tree-rewriting hooks, unreachable origin, identical-tree repos) | W4.32; W4.30; W4.31; W4.26; W4.28 |
| DC49 | Upgrade-in-place: DB migrations over aged state; stale CLI vs new daemon | W4.25; W4.34; W5 aged-state seeding |
| DC50 | Advertised-but-unwired features: `notifications.url` webhook never populated from normal launches | W2.26 |
| DC51 | Release-delivery corridor: installer artifact fidelity (shallow clone + fresh `npm install` + symlink + uninstall), update transaction failing AFTER the pull (build failure / SIGINT / post-stop install failure), downgrade-on-revert over a forward-migrated DB (live seam: strict-equality `migrate()` down-stamps `user_version`), custom workflows across versions | W0.9; W4.49; W4.25 legs 2–3 + custom-workflow leg; Tier-0 |
| DC52 | Secret/credential leakage into user-shareable artifacts (logs, events, DB dumps, error messages folding child stderr, forensics bundles) | O18 canary sweep |
| DC53 | Slow resource leaks over long daemon uptime (RSS/fd/DB+WAL growth) — invisible to terminal-state oracles, surfaces at week two in the field | O19 trend oracle |

## Accepted gaps (explicitly NOT covered, with rationale)

1. **github-pr families** — external side effects; excluded by design. Their
   shared plumbing (bug-fix/feature-dev/security chains) is covered by the
   non-PR variants; the `pr` step itself is not. Mitigation: the
   gh-unauthenticated fabrication guard stays a unit-level concern.
2. **Dashboard/MCP behavioral depth** — the storm now pounds the read paths
   continuously against an aged DB (W5) and asserts latency/5xx bounds, but
   UI correctness and the full 14-tool MCP surface remain uncovered. A
   separate cheap MCP conformance pass is worth adding in a future revision.
3. **AutoResearch subsystem** — orthogonal engine, zero production sessions
   observed in production; smoke only (it must not break `status`).
4. **Multi-user / permissions surfaces** — tamandua is single-user today.
5. **True provider-chaos** (deliberate auth revocation, mid-stream 529s) —
   classified and retried by the playbook but not injected; simulating
   providers would violate real-first for marginal value here.
6. **Windows** — unsupported platform, out of scope.
