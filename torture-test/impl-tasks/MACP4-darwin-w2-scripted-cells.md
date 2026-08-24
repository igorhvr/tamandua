# MACP4: make the tier1 W2 scripted cells Darwin-capable — the mac's bare tier1 is vacuously RED

On the mac, bare `./run-torture-test --tier1` is RED via the vacuity
guard: the four scripted cells (W2.21-admission, W2.23a/b/c) carry a
`requires` predicate `platform: linux`, so with predicates honestly
evaluated (post-MACP3) ZERO cells execute on Darwin and the guard
correctly refuses a vacuous GREEN. Evidence: mac campaign
20260818T163720247Z state.json — the four cells NOT_RUN(predicate) with
{"predicate":"platform","expected":"linux","observed":"darwin"}.

The linux predicate looks over-broad: daemon-control has a mechanical
`has_systemd_scope()` check with a non-systemd fallback launch path
(header: "Where systemd-run --user --scope is available..."), and the
scripted runtime itself ran on macOS in the chasm-era validation (real
e2e 12/12 on Darwin). The cells' actual dependencies must be audited,
not assumed.

1. Audit each W2 scripted cell's true platform dependencies:
   daemon-control fallback vs systemd-scope-only assertions, any
   /proc-era leftovers (MACP3 swept those), pgid/kill semantics, port
   handling, bash-3.2 (KSNT/MACP1 conventions). Fix what is portable-
   fixable; keep genuinely linux-only ASSERTIONS (if any) as separate
   linux-predicated assertion arms rather than gating the whole cell.
2. Replace the blanket `platform: linux` predicates with the narrowest
   true requirement (e.g. a capability predicate like daemon-scripted
   that the host profile computes on both platforms, or drop entirely
   where the fallback suffices). The S24 PATH-invariant reconstruction
   in daemon-control must keep working on the fallback path too.
3. Prove on linux (this run cannot run Darwin): all four cells still
   PASS via the systemd path AND via the FORCED fallback path
   (TT_FORCE_NO_SYSTEMD-style override or equivalent mechanical forcing
   of has_systemd_scope()=false) — red-then-green where you fix
   portability defects; full self-test battery green; bare --tier1
   GREEN x2 (one normal, one forced-fallback) in a quiet window.
4. Document the expected mac outcome in the report: after this merge
   the operator runs bare --tier1 on Darwin expecting GREEN with 4
   executed cells (or NOT_RUN with a precise narrower predicate if a
   cell is proven genuinely linux-only — justify any such cell).

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. No concurrent runs expected; 53xx quiet-window discipline
  for campaign proofs. Do not weaken the vacuity guard or predicate
  fail-closed semantics (MACP3).

---

## LANDING REPORT (US-001..US-008, branch `feature/macp4-darwin-w2-scripted-cells`)

Status: **implemented, dual-path proven on linux, Darwin outcome documented.**
Merge base: b8a04c46 (task); landed commits: f0de63ff (US-001), 2d8b259a (US-002),
6c8e59b2 (US-003), 35192b4a (US-004), 7a131bc2 (US-005), 5021f577 (US-006),
588f52e1 (US-007), 50443322 (US-008 proofs), 13ca8d6b (US-008 TT_FORCE_NO_SYSTEMD
campaign-path forward fix), 9f565c7b (US-008 propagation structural pin).

On the mac, bare `./run-torture-test --tier1` was RED via the vacuity
guard: the four scripted cells (W2.21-admission, W2.23a/b/c) carried a
`requires` predicate `platform: linux`, so with predicates honestly
evaluated (post-MACP3) ZERO cells executed on Darwin and the guard
correctly refused a vacuous GREEN. Evidence: mac campaign
20260818T163720247Z state.json — the four cells NOT_RUN(predicate) with
{"predicate":"platform","expected":"linux","observed":"darwin"}.

The linux predicate was over-broad. The cells' true dependencies were
audited per layer (not assumed), everything portable was made portable,
and the blanket `platform: linux` gate was replaced by the narrowest true
requirement — a capability predicate (`daemon-scripted`) that the host
profile computes on BOTH platforms. No genuinely linux-only assertion
remains in the W2 cells (none required a separate linux-predicated arm).

## 1. Audit findings and fixes per layer

### daemon-control (US-001, US-002) — `torture-test/bin/daemon-control`

Audited platform dependencies:
- `wait_for_port` / `is_port_listening` used `timeout 1 bash -c "echo >/dev/tcp/..."` —
  **`timeout(1)` is absent on macOS**, so every scripted start/status/stop failed on Darwin.
  Fixed: portable TCP-connect probe (`node -e` net.connect, bounded ~1s, hosts 127.0.0.1
  then ::1 — every TT daemon listener binds 127.0.0.1 by default). Same poll semantics,
  same callers; no GNU-`timeout` anywhere.
- The launch path already had a mechanical `has_systemd_scope()` check with a non-systemd
  fallback (nohup plain-background spawn, header "Where systemd-run --user --scope is
  available..."). **Added `TT_FORCE_NO_SYSTEMD=1` (US-001)**: when set, `has_systemd_scope()`
  returns false so `cmd_start` uses the plain-background fallback even on a systemd host —
  the linux-side mechanical forcing of the mac's only launch path. The fallback keeps the
  S24 contained PATH reconstruction (`contained_path_for_kind`) byte-identical to the
  systemd path and writes provenance with cgroupVerified=false.
- **cmd_stop asymmetry (US-001):** on the systemd path the scope teardown
  (`systemctl --user stop`) is what kills the MCP/dashboard standalones; the fallback path
  has no scope, so `cmd_stop` Step 1 graceful stop now ALSO runs the product CLI
  (`tamandua mcp stop` / `tamandua dashboard stop`) — otherwise the MCP survivor held its
  port and the next start refused (the W2 restart-corridor break).
- **Identity/ownership on /proc-less hosts (US-002):** `tt-process-identity.mjs` gained a
  mechanical Darwin identity source — `ps -p <pid> -o lstart=` ('darwin:<lstart>', BSD and
  procps both support it; 1s granularity documented inline) — so `--get`/`--check`/`--verify`
  return a non-null start identity on Darwin. Every E3.C.1 fail-closed refusal is preserved
  (unverifiable pid -> refuse, never signal). `verify_process_tt_owned` gained a Darwin
  evidence branch (`lsof -a -p <pid> -d cwd -Fn` for cwd, `ps -p <pid> -o command=` for
  cmdline) so CLI-auto-daemon stop and escalation still verify TT-ownership on Darwin;
  unavailable evidence -> refuse exactly as on linux.
- **Operator-home derivation (US-002):** `_tt_operator_home` / `operator_bin_dirs` now use
  the portable chain `getent passwd` -> `dscl . -read /Users/<user> NFSHomeDirectory` ->
  `eval echo ~<user>` -> `$HOME` last resort, so `REAL_TAMANDUA_STATE` and the S24
  operator-bin reorder resolve the TRUE operator home on Darwin (never a contained home).

### scenario harness (US-003) — `scenarios/lib/run-scripted-scenario` + `session-leader-spawn.mjs`

Audited platform dependencies:
- `exec setsid "$BASH_BIN" -c ...` — **`setsid(1)` is absent on macOS**. Fixed with a
  portable session-leader spawn (`scenarios/lib/session-leader-spawn.mjs`:
  `child_process.spawn(..., {detached:true})` calls setsid(2) in the child before exec, so
  the scenario command becomes a session/group leader on POSIX). The harness proves
  `pgid == pid` against the REAL leader (`COMMAND_LEADER_PID` from the wrapper's pid file)
  while `COMMAND_PID` stays the direct child for wait/cleanup. Zero `setsid` references.
- `ACCOUNT_HOME="$(getent ...)"` with `/home/$(id -un)` fallback — a Linux-ism yielding a
  nonexistent home on Darwin. Fixed with the same getent -> dscl -> eval-echo -> $HOME chain.
- `UUID_SUFFIX="$-$(date +%s%N)"` — **BSD date has no `%N`**. Fixed with a portable node
  `crypto.randomUUID` (12 hex chars) primary and `$$-$(date +%s)` last resort.
- `/proc`-guarded reads (MACP3) stay byte-identical; new portable `ps -o lstart=` / `-o pgid=`
  arms (BSD + procps, defensive trim) make the group proof work on a /proc-less host.

### W2 scenario cells + env scripts (US-004) — scenarios/w2.{21,23a,23b,23c}/run.mjs, env/tt-env*.sh

Audited: each run.mjs had a local `realAccountHome()` running `getent passwd` with a
`process.env.HOME` fallback — on Darwin getent is absent and the child's HOME is the
CONTAINED `TT_SCRIPTED_HOME`, so `daemonEnv.HOME` handed to daemon-control would have been
the contained home (silently weakening the production-guard derivation + S24 operator-bin
reorder). Fixed: all four cells import ONE shared resolver
(`scenarios/lib/operator-home.mjs`, `realAccountHome()`: getent -> dscl -> `eval echo ~<user>`
-> $HOME last resort, each probe shelling out to bash so PATH seams work). The spawn env
scripts (`env/tt-env.sh`, `env/tt-env-scripted.sh`) carry their own `resolve_operator_home()`
copy so VOLTA_HOME / node PATH resolution survives the HOME override on Darwin.

### Host profile capability (US-005) — `bin/tt-verify-environment`

New REQUIRED check `capability-daemon-scripted` records `capabilities.daemon-scripted`
(Boolean leaf) in BOTH full and `--fast` modes: true iff bash AND nohup AND node resolve on
PATH via `commandOnPath` — a pure fs.accessSync PATH scan with NO /proc, NO getent, NO
platform branch (both-platform by construction). Also added the `TT_VERIFY_PLATFORM`
injectable platform seam (simulated-Darwin runs skip systemd exactly like a real mac) so the
both-platform computation is provable linux-side. `tt-controller` needed NO change: the
`observedCapability` fall-through resolves unknown capability names against
`profile.capabilities[name]`.

### Predicate narrowing (US-006) — cases/tier1.jsonl + contract docs

The four W2 rows' requires narrowed from
`{"platform":"linux","capabilities":["node-sqlite"],"node_min":22}` to
`{"capabilities":["node-sqlite","daemon-scripted"],"node_min":22}` (platform key dropped,
daemon-scripted added). The other 24 tier1 rows are byte-unchanged (git-diff row-level
proof). No assertion weakened: node-sqlite + node_min 22 retained; oracles O1/O3z/O11
unchanged. Contract docs updated to name the capability: `cases/case.schema.json`,
`tamandua-torture-test-spec/01-environment-and-isolation.md`, `oracles/CONTRACT.md`,
plus a HOST-ADAPTATION note in `cases/tier1-traceability.md`. NO tier1 cell carries a
blanket `platform` predicate anymore; a blanket platform gate is reserved for genuinely
linux-only ASSERTION arms (none exist in tier1).

## 2. The forced-fallback override

`TT_FORCE_NO_SYSTEMD=1` (US-001) is checked inside `has_systemd_scope()` and forces the
plain-background (nohup) fallback launch path on any host. It is the mechanical linux-side
forcing of Darwin's only launch path, and it is what makes the Darwin-capability claim
provable without a mac. Default behavior on systemd hosts is unchanged (systemd scope path).

**Campaign-path propagation (US-008 fix):** the override must survive the WHOLE campaign
spawn path (tt-controller -> tt-hook-runner -> run-scripted-scenario -> the W2 run.mjs
daemonEnv -> daemon-control). tt-controller's `operatorEnvironmentWithoutRuntimeRouting()`
strips every `TT_*` key from the child spawn env, so a `TT_FORCE_NO_SYSTEMD=1
./run-torture-test --tier1` campaign silently dropped the override and ran the SYSTEMD path —
the recorded "forced-fallback" campaign (20260824T035020585Z) showed `using systemd scope:`
in every W2 cell's evidence, identical to the normal campaign (verified by the reviewer:
a grep across every campaign dir under var/results/ found ZERO fallback-marker matches).
Fixed in `loadSpawnEnvironment` (MACP4 US-008): the override is forwarded from the
controller's own env into the merged spawn env when set (absent -> no-op, default
unchanged), mirroring the existing `TAMANDUA_SCRIPTED_BEHAVIORS`/`TAMANDUA_SCRIPTED_STATE`
forward. Pinned structurally (`tier0-controller-home-containment.test.ts` — the forward must
sit AFTER the TT_* strip, before the containment assertion) and at campaign level
(`tier1-w2-darwin-capable-proof.test.ts` leg (c) now asserts the launch-path marker per W2
cell from the recorded evidence `command.stderr`).

## 3. Proofs (all zero-token, quiet window 2026-08-24)

### Mechanical dual-path pin (US-007, `self-tests/tier1-w2-darwin-capable-proof.test.ts`, 4/4)

(a) each of scenarios/w2.21, w2.23a, w2.23b, w2.23c runs via
`scenarios/lib/run-scripted-scenario` under the NORMAL path — exit 0, cell JSON PASS
evidence (result PASS, tokens_spent 0, system_tokens_spent 0, terminal status), daemon-control
stderr shows the `using systemd scope:` marker;
(b) the same four cells repeat under `TT_FORCE_NO_SYSTEMD=1` — identical PASS evidence with
the `systemd not available — using plain background spawn` marker (the mac's only path);
(c) two bare tier1 campaigns (normal + forced-fallback) assert the 4 W2 cells have
attempts > 0 and outcome PASS (never NOT_RUN(predicate)), 24 real cells pending-real, GREEN
exit 0, vacuity silent, zero tokens, AND the campaign-level launch-path marker per W2 cell
from the recorded evidence `command.stderr` (systemd marker on the normal leg, the
`systemd not available — using plain background spawn` marker on the TT_FORCE_NO_SYSTEMD=1
leg — MACP4 US-008 campaign-level marker assertion, which is what catches a dropped
override). Quiet-window discipline per leg (stop stray scripted daemon, ports
5334/5338/5339 free before/after, daemon STOPPED after, git-cleanliness snapshot).
Registered in the three heavy-campaign lock-step lists.

### Final bare --tier1 proofs (US-008, this report)

| leg | command | campaign id | exit | W2 cells | tokens | vacuity |
|-----|---------|-------------|------|----------|--------|---------|
| (a) normal | `./run-torture-test --tier1` | campaign-20260824T055447886Z-18f6a609-e38a-4077-9a74-c0bfdfd06334 | 0 (GREEN) | W2.21/W2.23a/W2.23b/W2.23c PASS (attempts 1 each) | 0 | not triggered |
| (b) forced-fallback | `TT_FORCE_NO_SYSTEMD=1 ./run-torture-test --tier1` | campaign-20260824T055758905Z-4456edc3-3dbf-4be1-9bde-b8bd05e99d89 | 0 (GREEN) | W2.21/W2.23a/W2.23b/W2.23c PASS (attempts 1 each) | 0 | not triggered |

Both legs: 28-case manifest validated, outcomes PASS=4 / NOT_RUN=24 (the 24 real cells are
pending-real — the zero-token bare contract), 0 findings / 0 infra, report verdict GREEN
with `vacuity.triggered=false`. **Leg (b) is a GENUINE forced-fallback proof**: after the
US-008 loadSpawnEnvironment forward fix, every W2 cell's recorded evidence
(`evidence/W2.*/attempt-1/command.stderr`) shows
`systemd not available — using plain background spawn` — grep-confirmed across all four
cells' evidence, and the campaign-level marker assertion in `tier1-w2-darwin-capable-proof`
leg (c) passed 4/4. (The earlier attempt's "forced-fallback" campaign
20260824T035020585Z was the systemd path run twice because the override was stripped by
`operatorEnvironmentWithoutRuntimeRouting`; it is superseded by the fixed campaign above.)
Quiet window held: TT ports 5334/5338/5339 free before and after every leg; no stray
scripted daemons; the live 33xx instance untouched; git status clean.

### Full self-test battery (US-008)

- `torture-test/self-tests/run.sh` — exit 0 (114 passed, 0 failed; the bounded battery, heavy
  campaigns isolated). The previously-missing golden fixtures (tt-poly, tt-poly-lite, tt-go,
  tt-java, tt-rust, tt-python@master) were provisioned once via their `fixtures-src/<f>/build-golden.sh`
  (deterministic, zero-token, gitignored var/), which the e24/tt-poly battery requires — the
  4 pre-existing fixture-provisioning failures reported by US-003/US-004 are gone.
- `torture-test/bin/verify-heavy-campaign-tests.test.sh` — the MACP4-scoped heavy tests pass
  individually under the coordinator's exact per-test invocation: `tier1-bare-vacuity-red-green.test.ts`
  3/3 and `tier1-w2-darwin-capable-proof.test.ts` 4/4 (each its own `node --test` process, quiet
  window held). The full 14-test coordinator is a multi-hour unbounded battery (tier0-repeatability
  alone runs two full tier0 gates, ~2.4h each on this host); the MACP4-scoped members are the ones
  this diff touches and they are green. Pre-existing environmental note (unchanged by this diff):
  `tier1-zero-real-launch-infra.test.ts` cannot pass in this worktree — its include-real campaign's
  harness-auth leg runs the REAL pi (preflight strips TAMANDUA_PI_BINARY) which fails here with
  'Connection error', and the daemon-up leg fails build-version parity (PATH-resolved `tamandua`
  ships a stale dist vs this worktree HEAD). It is not part of run.sh, not part of npm test, and
  not in this story's acceptance list.
- `torture-test/bin/daemon-control.test.sh` — ALL TESTS PASSED (exit 0).
- `torture-test/bin/tt-verify-environment.test.sh` — ALL TESTS PASSED (exit 0).
- Vacuity guard + predicate fail-closed pins: `torture-test/bin/tt-report.test.mjs` 19/19
  (bareVacuityCause + host-profile-missing INFRA precedence + zero-real-launches fail-closed);
  `tier1-bare-vacuity-red-green.test.ts` 3/3 (its GREEN-arm control still EXECUTES the 4 W2
  cells under the narrowed predicate — the vacuity guard's red arm unchanged).
- Propagation pin: `tier0-controller-home-containment.test.ts` 8/8 (the new
  TT_FORCE_NO_SYSTEMD-forward structural assertion sits alongside the containment
  choke-point pins).
- Lock-step integrity: `e2e-golden-integrity.test.ts` 5/5 (AC1 run.sh twice consecutive,
  AC5 heavy-list lock-step — the W2 dual-path test stays in all three heavy lists).
- Typecheck: `npm run build` exit 0.

## 4. EXPECTED MAC OUTCOME (operator verification steps)

After this merge, on the mac the operator runs:

```bash
./run-torture-test --tier1          # bare tier1, normal path (plain-background fallback)
```

Expect **GREEN (exit 0)** with **4 executed scripted cells**:

- W2.21-admission, W2.23a-expects-regex, W2.23b-retry-step, W2.23c-missing-persona all
  **PASS** via the plain-background fallback launch path (the mac has no systemd; daemon-control
  prints `systemd not available — using plain background spawn`); the remaining 24 real cells
  are pending-real NOT_RUN (the zero-token bare contract).
- `W0.0` computes `capabilities.daemon-scripted` **true** on the mac (bash 3.2 + nohup + node
  are all present), so the narrowed predicate
  `{"capabilities":["node-sqlite","daemon-scripted"],"node_min":22}` is satisfiable and the
  cells EXECUTE — **no NOT_RUN(predicate)** for the W2 cells, so the vacuity guard stays silent
  (bareVacuityCause not triggered).
- The report's verdict is GREEN with `vacuity.triggered=false`, `tokens_observed: 0`.

Exact operator verification steps:
1. `cd <repo> && git status` — clean; `./run-torture-test --tier1`; observe exit 0 and the
   report `Totals: PASS=4 ... NOT_RUN=24`, `Campaign: campaign-<id>`.
2. `jq '.verdict, .vacuity, .spend' torture-test/var/results/<latest>/report.json` —
   `"GREEN"`, `{"triggered":false,"cause":null}`, `tokens_observed: 0`.
3. `jq -r '.rows[] | select(.id | startswith("W2.")) | [.id, .outcome] | @tsv'
   torture-test/var/results/<latest>/report.json` — the four W2 rows PASS (never NOT_RUN).
4. On the mac the normal path already IS the plain-background fallback (no systemd), so the
   single bare run above suffices — daemon-control prints
   `systemd not available — using plain background spawn` (grep it in the W2 cells'
   `evidence/W2.*/attempt-1/command.stderr`). The linux-side mechanical proof of the same
   path is the forced-fallback campaign `TT_FORCE_NO_SYSTEMD=1 ./run-torture-test --tier1`
   (GREEN, campaign-20260824T055758905Z-4456edc3-3dbf-4be1-9bde-b8bd05e99d89 — all four W2
   cells' evidence shows the fallback marker). The override reaches daemon-control through
   the whole campaign spawn path only because tt-controller's `loadSpawnEnvironment`
   forwards it (MACP4 US-008 fix) — without that forward the linux forced-fallback campaign
   silently ran the systemd path.

No W2 cell is genuinely linux-only — none required a separate linux-predicated assertion arm;
every audited dependency (port probe, session-leader spawn, process identity/ownership,
operator-home resolution, UUID source, capability leaf) is portable and pinned linux-side by
the dual-path self-test.

## Hard constraints — verified intact

- Files changed ONLY inside torture-test/ (plus the branch itself). Zero tokens (all proofs
  `tokens_observed: 0`; `/bin/false` harness backstops in the self-test campaigns). Live daemon
  (33xx) untouched. 53xx quiet-window discipline held for every campaign proof.
- Vacuity guard (`bareVacuityCause`) and predicate fail-closed semantics (host-profile-missing
  INFRA, zero-real-launches INFRA) are UNCHANGED — pinned by `tier1-bare-vacuity-red-green.test.ts`
  (3/3) and `tt-report.test.mjs` (19/19).
