# MACP5: real-Darwin W2 run exposed three defects — fallback spawn records a dead wrapper pid; /proc uuid; BSD sed

Mac validation at 3b7922d5 (campaign on the mac, newest tier1 dir): with
the regenerated host profile the four W2 cells EXECUTED on Darwin for the
first time — and all four PRODUCT_FAILed. Evidence
(evidence/W2.21-admission/attempt-1/command.stderr, same on all four):

1. **FATAL — fallback daemon pid is a dead wrapper.** daemon-control's
   plain-background (no-systemd) spawn started the daemon fine (ports
   5334/5338/5339 LISTENING) but recorded "daemon PID 88430" whose
   process is NOT alive afterwards ("pid alive: false, cmdline verified:
   false, ports active: true" -> "scripted daemon did not report
   RUNNING: STATUS: UNKNOWN" -> scenario aborts). On Darwin the
   nohup/background chain double-forks, so the recorded pid is a wrapper
   that exits while the real daemon lives. The status verifier failing
   closed is CORRECT — fix the recording, not the verifier: provenance
   must carry the REAL daemon pid on both paths. Robust approach: have
   the spawned daemon's own pidfile (it writes one — the state dir's
   tamandua.pid) be the authority the fallback start waits on and
   records, with identity verification (the E3.C.1/MACP4 identity tools)
   against that pid before writing provenance; or use a spawn mechanism
   that returns the final pid (node detached spawn already used in
   session-leader-spawn.mjs — reuse it for the daemon launch). Either
   way: identity-verify before recording; fail closed if unverifiable.
   Must remain correct on linux fallback AND systemd paths (regression:
   TT_FORCE_NO_SYSTEMD bare tier1 stays GREEN on linux).
2. **run-scripted-scenario line ~306 reads /proc/sys/kernel/random/uuid**
   ("No such file or directory" on Darwin) — a site both MACP3's sweep
   and MACP4 missed. Replace with the portable UUID helper MACP4 already
   introduced. Then re-run the procfs portability lint and figure out WHY
   it missed this site — extend the lint (G-gates) so /proc literals in
   scenarios/lib are caught; red-then-green the lint fix.
3. **BSD sed incompatibility**: "sed: 1: ... command i expects \ followed
   by text" — GNU-only `i` syntax in the scenario path. Fix portably
   (POSIX sed or a node/bash replacement), then sweep the scripted
   scenario path (scenarios/, env/, bin/ scripts reachable from
   run-scripted-scenario) for other GNU-isms: sed -i / sed i\ / grep -P /
   readlink -f / date %N / timeout / setsid (the last three were fixed by
   MACP4 — verify no stragglers). Add whatever lint arm makes this class
   mechanical (the bash32-compat lint is precedent).

Prove on linux: TT_FORCE_NO_SYSTEMD=1 bare ./run-torture-test --tier1
GREEN (fallback path with the new pid recording), normal bare --tier1
GREEN, full self-test battery green from repo root, lint red-then-green
for the /proc and GNU-ism arms. Document the expected mac outcome (the
operator re-runs bare tier1 on Darwin expecting GREEN with 4 executed
cells).

## Hard constraints
- Files ONLY inside torture-test/. Zero tokens. Live daemon (33xx)
  untouched. No concurrent runs expected; quiet-window discipline for
  campaign proofs. Do not weaken the status verifier's fail-closed
  behavior, the vacuity guard, or predicate semantics.

---
## LANDING REPORT (US-001..US-006, branch `feature/macp5-darwin-fallback-pid-portability`)

Status: **implemented, dual-path proven on linux, Darwin outcome documented.**
Merge base: a3e890b2 (task); landed commits: ac8ce374 (US-001), 7104e5ff (US-002),
6ef452ed (US-003), 7d488d8f (US-004), 5f350b50 (US-005), and the US-006 commit (this story\'s proofs, branch HEAD at merge).

On the mac, bare `./run-torture-test --tier1` executed the four W2 scripted cells
(W2.21-admission, W2.23a-expects-regex, W2.23b-retry-step, W2.23c-missing-persona)
for the first time (regenerated host profile, MACP4) — and all four
PRODUCT_FAILed. Evidence (evidence/W2.21-admission/attempt-1/command.stderr, same
on all four) exposed three defects, fixed here:

1. **FATAL — fallback daemon pid is a dead wrapper.** daemon-control's
   plain-background (no-systemd) spawn started the daemon fine (ports
   5334/5338/5339 LISTENING) but recorded "daemon PID 88430" whose process was
   NOT alive afterwards ("pid alive: false, cmdline verified: false, ports
   active: true" -> "scripted daemon did not report RUNNING: STATUS: UNKNOWN" ->
   scenario aborts). On Darwin the nohup/background chain double-forks, so the
   recorded pid is a wrapper that exits while the real daemon lives. The status
   verifier failing closed was CORRECT — the recording was fixed, not the
   verifier.
2. **run-scripted-scenario line ~306 read /proc/sys/kernel/random/uuid**
   ("No such file or directory" on Darwin) — a site both MACP3's sweep and
   MACP4 missed.
3. **BSD sed incompatibility**: "sed: 1: ... command i expects \ followed by
   text" — GNU-only `i` syntax in the scenario path.

## 1. Fixes per defect

### US-001 — daemon-control: identity-verified real-daemon pid recording on the fallback path + portable status verification (`torture-test/bin/daemon-control`)

- New `verify_launched_daemon_pid` triple gate (kill -0 alive + `tt-process-identity --get`
  non-empty + `verify_process_tt_owned`) — the pidfile (state-dir tamandua.pid, the daemon's
  OWN pidfile) candidate is accepted ONLY after all three; a wrapper/zombie/stale candidate
  (the Darwin double-fork case) is REFUSED, never recorded, and the launch attempt retries
  within the bounded TT_DAEMON_PORT_WAIT_SECONDS deadline. Deadline expiry FAILS CLOSED
  (exit 1, no provenance written) with a diagnostic naming the unverifiable-wrapper class.
- A loop-top re-check in cmd_start accepts a previous fallback attempt's real daemon
  (rewritten pidfile + listening ports) instead of failing on the busy ports it holds.
- `write_provenance` refuses an empty startTime identity (exit non-zero, no provenance
  written) — replaces the old WARNING-and-continue. The E3.C.1 fail-closed corridor
  (verify_recorded_identity before any signal) is byte-identical.
- `cmd_status` is portable: pid liveness via `kill -0` alone (linux-only `[ -d /proc/<pid> ]`
  dropped); cmdline verification rides TT_DC_PLATFORM (`ps -p <pid> -o command=` on Darwin,
  /proc retained on linux). RUNNING still requires alive AND tamandua cmdline AND a listening
  port; unverifiable -> UNKNOWN (fail-closed unchanged).
- MACP5 linux-only markers added beside retained /proc reads.

### US-002 — run-scripted-scenario: replace /proc uuid with the portable helper (`scenarios/lib/run-scripted-scenario`)

- The linux-only `/proc/sys/kernel/random/uuid` read and the `[ -n "$UUID_SUFFIX" ]` fallback
  dance are GONE; `UUID_SUFFIX="$(portable_uuid_suffix)"` unconditionally (node
  crypto.randomUUID 12-hex primary, `$$-$(date +%s)` last resort — MACP4's helper). The
  INVOCATION_ID format is byte-identical. Zero '/proc/sys/kernel/random/uuid' literals remain
  (comments included).

### US-003 — procfs portability lint G5 gate (`self-tests/tier0-procfs-portability-lint.test.ts`, red-then-green)

- New G5 gate: every '/proc' literal on a non-comment line in scenarios/lib/ must be a
  `[ -r|-d|-f|-e|-L "/proc...` guard-test line or within 2 lines below one — an unguarded
  input-redirection read (the pre-fix uuid line) trips. Wired into the hard gate
  (auditLiveTree). The guarded /proc/<pid>/stat reads (each preceded by `if [ -r ... ]`)
  stay green.

### US-004 — GNU-ism sweep fixes in the scripted scenario path (BSD sed -i, grep -oP)

- `scripted-runtimes/install-scenario-workflows` ~line 90: GNU-only `sed -i` id rewrite ->
  portable `sed 's/.../' "$YML" > "$YML.tmp" && mv "$YML.tmp" "$YML"`; post-rewrite grep
  verification unchanged.
- `bin/daemon-control` ~1579/1581: `grep -oP 'pid=\K[0-9]+'` / `grep -oP '\d+'` ->
  portable `grep -Eo 'pid=[0-9]+' | head -1 | sed 's/^pid=//'` / `grep -Eo '[0-9]+'`
  (first-pid semantics verified identical).
- `scripted-runtimes/test.sh`: 4 `date +%s%N` timing sites -> `portable_ns()` helper
  (node process.hrtime.bigint()).
- `bin/tt-provision-home` ~203: `sed -i` -> portable temp+mv. REACHABILITY VERDICT:
  tt-provision-home IS mac-reachable (bare-tier1 preflight home-provision leg runs on ANY
  host — tt-controller's realPreflightRequired is manifest-based), so it was FIXED, not
  allowlisted.

### US-005 — GNU-ism portability lint arm (`self-tests/tier0-gnu-portability-lint.test.ts`, hard gate, red-then-green)

- New hard-gate lint over the TRACKED shell surface (git ls-files; .sh or bash shebang;
  comment/single-quote-masked lines) banning the seven GNU-ism classes: sed -i/--in-place
  (whitespace/end required after the flag — BSD-portable `sed -i.bak` NOT flagged), GNU sed
  insert `i\` (comment-only-masked lines — the single-quoted sed script is code), grep
  -P/--perl-regexp, readlink -f/--canonicalize, date %N, GNU coreutils timeout <n> <cmd>
  COMMAND, setsid.
- Strict scenario-path sub-gate (scenarios/, env/, scripted-runtimes/ + bin/daemon-control):
  ZERO GNU-isms, no allowlist entry can cover them. File-granularity ALLOWLIST (16 entries
  with reasons + allowedClasses pinning which classes each linux-side-only file may carry)
  covers only linux-side-only tools outside the strict path.
- Also fixed a latent dead-code bug in the US-004 sweep test (POSIX [[:space:]] in a JS
  regex) and added a 'documentation' procfs-lint allowlist entry for the new lint's own
  /proc prose.

### US-006 — Linux proofs, campaign-level pid-recording pin, expected-mac-outcome documentation (this story)

- `self-tests/tier1-w2-darwin-capable-proof.test.ts` (NO lock-step list changes): the
  per-cell provenance-pid pin runs after each of the 4 W2 cells on EACH launch path
  (systemd leg + TT_FORCE_NO_SYSTEMD=1 fallback leg): `torture-test/var/daemon-control/
  scripted.json` must record a pid that is (a) alive, (b) carries a non-empty startTime
  identity, and (c) whose CURRENT `tt-process-identity --get` identity still matches the
  recorded startTime (no ABA). Each cell's leftover record (pid + non-empty startTime +
  stoppedAt) is also shape-asserted, then a live self-start on the same launch path
  (marker-verified) pins the full triple. Campaign legs additionally assert the
  "daemon PID <pid> (identity-verified)" acceptance line in each W2 cell's recorded
  evidence + the same live pin once per campaign leg.

## 2. Red-then-green lint arms (recorded red runs)

### G5 /proc gate (US-003) — RED then GREEN

Materialized the ACTUAL pre-US-002 tree (git archive 7104e5ff~1) into a temp tree, ran the
new hard gate — RED (verbatim):

```
torture-test/scenarios/lib/run-scripted-scenario:306: unguarded '/proc' on a non-comment line (not a [ -r|-d|-f|-e|-L guard test, not within 2 lines below one) — scenarios/lib must not read the procfs mount unguarded
```

Live tree (post-US-002): `node --test --test-name-pattern "hard gate"
self-tests/tier0-procfs-portability-lint.test.ts` — GREEN (pass 1, fail 0). The in-test
mutation + git red proofs (G5 tests) pass 5/5.

### GNU-ism lint (US-005) — RED then GREEN

Materialized the ACTUAL pre-US-004 tree (git archive 7d488d8f~1) — the lint flags exactly
the pre-fix GNU-isms (verbatim, from the recorded red run):

```
torture-test/bin/daemon-control:1579: grep -P (perl-regexp) — strict scripted scenario path (scenarios/, env/, scripted-runtimes/, bin/daemon-control) must be GNU-ism-free; NO allowlist entry can cover it
torture-test/bin/daemon-control:1581: grep -P (perl-regexp) — strict scripted scenario path ... NO allowlist entry can cover it
torture-test/bin/tt-provision-home: contains GNU-ism(s) (sed -i (GNU in-place)) but has no ALLOWLIST entry
torture-test/scripted-runtimes/install-scenario-workflows:90: sed -i (GNU in-place) — strict scripted scenario path ... NO allowlist entry can cover it
torture-test/scripted-runtimes/test.sh:223: date %N (nanosecond) — strict scripted scenario path ... NO allowlist entry can cover it
```

Live tree (post-US-004): `node --test --test-name-pattern "hard gate"
self-tests/tier0-gnu-portability-lint.test.ts` — GREEN (pass 1, fail 0).

## 3. Linux proofs (all zero-token, quiet window 2026-08-24T16:09Z..16:14Z)

| leg | command | campaign id | exit | W2 cells | tokens | vacuity |
|-----|---------|-------------|------|----------|--------|---------|
| (a) normal | `./run-torture-test --tier1` | campaign-20260824T161256122Z-9c309d80-ec69-4421-9736-d19d08546cad | 0 (GREEN) | W2.21/W2.23a/W2.23b/W2.23c PASS | 0 | not triggered |
| (b) forced-fallback | `TT_FORCE_NO_SYSTEMD=1 ./run-torture-test --tier1` | campaign-20260824T160930710Z-ce6ebe53-13c5-4c9e-a230-eec6b44e6eb7 | 0 (GREEN) | W2.21/W2.23a/W2.23b/W2.23c PASS | 0 | not triggered |

Both legs: 28-case manifest validated, PASS=4 / NOT_RUN=24 (pending-real), 0 findings,
report verdict GREEN with vacuity.triggered=false. Leg (b) is a GENUINE forced-fallback
proof: every W2 cell's recorded evidence shows
`systemd not available — using plain background spawn`, and the per-cell provenance-pid
pin + campaign-level "daemon PID <pid> (identity-verified)" assertions passed on both
legs. Quiet window held: TT ports 5334/5338/5339 free before/after every leg, no stray
scripted daemons, live 33xx instance untouched, git status clean.

### Mechanical dual-path pin (US-006, `self-tests/tier1-w2-darwin-capable-proof.test.ts`, 4/4)

All four tests pass: AC2 (manifest/predicate pin), (a) normal systemd leg 4/4 cells with
the per-cell provenance-pid pin, (b) forced-fallback leg 4/4 cells with the pin, (c) two
bare tier1 campaigns with campaign-level markers + identity-verified acceptance lines +
the campaign-level live provenance pin.

### Full self-test battery

- `torture-test/self-tests/run.sh` — exit 0 (117 passed, 0 failed; bounded battery, heavy
  campaigns isolated).
- MACP5-scoped heavy tests individually: `tier1-w2-darwin-capable-proof.test.ts` 4/4 with
  the new per-cell pins; the new tier0 lint files (procfs G5, GNU-ism) are in the bounded
  battery.
- `torture-test/bin/daemon-control.test.sh` — ALL TESTS PASSED (exit 0).
- `torture-test/bin/tt-verify-environment.test.sh` — ALL TESTS PASSED (exit 0).
- Typecheck: `npm run build` exit 0.

## 4. EXPECTED MAC OUTCOME (operator verification steps)

After this merge, on the mac the operator runs:

```bash
./run-torture-test --tier1          # bare tier1, normal path (plain-background fallback)
```

Expect **GREEN (exit 0)** with **4 executed scripted cells**:

- W2.21-admission, W2.23a-expects-regex, W2.23b-retry-step, W2.23c-missing-persona all
  **PASS** via the plain-background fallback launch path (the mac has no systemd;
  daemon-control prints `systemd not available — using plain background spawn`); the 24
  real cells are pending-real NOT_RUN (zero-token bare contract).
- The fallback start now records the REAL daemon pid, identity-verified: the pidfile
  candidate must pass the triple gate (alive + tt-process-identity --get non-empty +
  TT-owned) and write_provenance fails closed on an empty identity — so provenance carries
  a live identity-verified daemon pid, `daemon-control scripted status` reports
  **STATUS: RUNNING** (alive + tamandua cmdline via portable ps arm + listening port),
  and the scenario proceeds past the old "pid alive: false ... STATUS: UNKNOWN" abort.
- No 'No such file or directory' (the /proc uuid read is gone — portable_uuid_suffix) and
  no 'sed: ... command i expects \ followed by text' errors (GNU-isms removed) in the W2
  evidence.
- The report's verdict is GREEN with `vacuity.triggered=false`, `tokens_observed: 0`.

Exact operator verification steps:
1. `cd <repo> && git status` — clean; `./run-torture-test --tier1`; observe exit 0 and the
   report `Totals: PASS=4 ... NOT_RUN=24`, `Campaign: campaign-<id>`.
2. `jq '.verdict, .vacuity, .spend' torture-test/var/results/<latest>/report.json` —
   `"GREEN"`, `{"triggered":false,"cause":null}`, `tokens_observed: 0`.
3. `jq -r '.rows[] | select(.id | startswith("W2.")) | [.id, .outcome] | @tsv'
   torture-test/var/results/<latest>/report.json` — the four W2 rows PASS (never NOT_RUN).
4. Grep the W2 cells' `evidence/W2.*/attempt-1/command.stderr` for
   `systemd not available — using plain background spawn` AND
   `daemon PID <pid> (identity-verified)` — the fallback arm ran and the recorded
   provenance pid is the identity-verified real daemon.
5. `jq '.pid, .startTime' torture-test/var/daemon-control/scripted.json` — non-empty
   startTime identity; `node torture-test/bin/tt-process-identity.mjs --get <pid>` returns
   the same identity (no ABA).

## Hard constraints — verified intact

- Files changed ONLY inside torture-test/ (plus the branch itself). Zero tokens (all
  proofs `tokens_observed: 0`; /bin/false harness backstops in the self-test campaigns).
  Live daemon (33xx) untouched. 53xx quiet-window discipline held for every campaign proof.
- Vacuity guard and predicate fail-closed semantics UNCHANGED — pinned by
  tier1-bare-vacuity-red-green.test.ts (3/3) and the tier1-w2-darwin-capable-proof AC2
  manifest/predicate pins. The status verifier's fail-closed behavior (unverifiable ->
  UNKNOWN, never RUNNING on ports alone) is UNWEAKENED — US-001 only made cmd_status
  portable and made the RECORDING correct.
