# TISO.1: last production-port bind in the serial lane (harness-type.test.ts) + child-process ledger attribution

Follow-up to TISO (01bd9117), within its authorization ("fix every violating site"; igorhvr 2026-09-02).
Product test hygiene. bd issue tamandua-6sy.17.

## Evidence
- On every pinned-worktree review run since TISO landed (trees 01bd9117, 741feb3b, c616d8c5), the serial lane fails
  ONLY on 4 guard-ledger entries `[port-bind] 3339 — control plane`, attributed "(unknown)" (testFile null).
- Per-file attribution (each serial-lane file run alone with its own ledger): `src/installer/harness-type.test.ts`
  produces all 4; the other 155 serial files produce none. The file isolates HOME (tempHome) and deletes
  TAMANDUA_DB_PATH but never sets TAMANDUA_CONTROL_PORT / TAMANDUA_STATE_DIR / reserved ports, so whatever it spawns
  (a daemon / control plane child) falls back to the default control port 3339 — the production port.
- The runs' own testers reported an EMPTY ledger on the same trees: their environment inherits
  TAMANDUA_CONTROL_PORT=3339 from the live daemon while the review shell has no TAMANDUA_* vars. Explain this
  difference in the landing note (which code path makes the child bind, and why the explicit-but-equal env value
  changes it) — do not just paper over it.

## Fix
1. harness-type.test.ts: reserve free ports for anything it spawns (the `reservePortHandles` pattern used by
   src/installer/run.test.ts) and set TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH / TAMANDUA_CONTROL_PORT to the temp HOME
   values; restore env in after(); stop the daemon family before removing the temp HOME (stopDaemonFamily).
2. Child-process attribution: when the test runner's ledger env is present, spawned tamandua processes (daemon,
   control-standalone, dashboard-standalone, mcp-standalone) must record the originating test file in their ledger
   entries — pass it through the environment (e.g. TAMANDUA_TEST_GUARD_TEST_FILE set by the guard/harness helpers
   when a test spawns a child) so "(unknown)" entries name their test.
3. Make the guard ledger report list, for each "(unknown)" entry, the child's argv (already available at bind time)
   as a fallback attribution.

## Prove (one gate per story; each proof story fits one worker round)
- `node --test src/installer/harness-type.test.ts` alone with TAMANDUA_TEST_GUARD=1 and a ledger file → 0 entries,
  in BOTH environments: with TAMANDUA_CONTROL_PORT unset and with TAMANDUA_CONTROL_PORT=3339 exported.
- A deliberately violating throwaway child spawn is attributed to its test file in the ledger report (then removed).
- Full `npm test` green with an EMPTY ledger on this tree (serial + parallel).

## Constraints
Product test code + guard/ledger plumbing only; the guard stays a no-op when inactive (no new production behavior).
Kill only pids you spawned. Do not touch torture-test/.
