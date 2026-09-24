# TU2F — US-003 NF sweep table (NF-1..NF-6)

Run: run-c13d1de8-be66-40eb-80f3-f88e66b5083d
Story: US-003 — Sweep NF-1..NF-5: confirm each closed (cite commits) or fix if small and torture-only
Date: 2026-09-18 (VM clock)
Branch: feature/tu2f-torture-union-leftovers-nf6
Base: 0f305702 feat: NPF-2 scripted suite-ledger evidence and O12 content pin

## Source-of-truth / visibility facts

The TORTURE-UNION-2 audit report (`/home/kaladin/vaivm-archive/vaivm-audit/report.md`)
and the bead (`tamandua-6sy.68`, `bd` CLI) are **NOT visible inside the Matchlock VM**
(see `tu2f-recon.md` §1). NF-1..NF-3 are pinned by the task input to the
`feature/torture-union2-lint-defects` fix chain; NF-6 was fixed in US-002 of this run.
NF-4 and NF-5 are therefore **derived from the live tree** (the sanctioned fallback):
each is a still-open, independently verifiable torture-tree defect of the same
portability/containment class as NF-1..NF-3. Because the audit numbering could not be
re-read, the NF-4/NF-5 labels attach to the two concrete remaining defects enumerated
below; the tree evidence for each is exact and reproducible.

## NF sweep table

| Item | Content (tree/audit) | Status | Citing commit | Evidence |
|------|----------------------|--------|---------------|----------|
| NF-1 | gitconfig-containment lint rejects the `/dev/null` `GIT_CONFIG_GLOBAL` pin and unconditionally `sha256()`s the operator `~/.gitconfig` (ENOENT on a host with none) | closed | `7762fdf8` (R1) | `tier0-gitconfig-containment.test.ts` passes alone: 5/5 (TAMANDUA_TEST_GUARD=1, false harnesses, verified this round) |
| NF-2 | procfs-portability lint flags the three torture-union fix-chain `/proc` files with no allowlist entry | closed | `a1121686` (R3) | `tier0-procfs-portability-lint.test.ts` passes alone: 16/16 (verified this round) |
| NF-3 | three FIX10 containment gates (`controller`/`hook`/`scenario`) unconditionally `sha256()` the operator `~/.gitconfig` | closed | `bc535a44` | `tier0-controller-home-containment` 8/8, `tier0-hook-home-containment` 6/6, `tier0-scenario-containment` 7/7 (verified this round) |
| NF-4 | `tier0-repeatability.test.ts` double-gate snapshot unconditionally `sha256(realGitconfig)` (ENOENT on absent `~/.gitconfig`) and asserts the hygiene canary status strictly `UNCHANGED` (vaimetal renders `ABSENT`) | fixed (small, torture-only) | this commit (US-003) | presence-tolerant `gitconfigFingerprint()` + `UNCHANGED\|ABSENT` canary assertions; doc gate passes alone; full double-gate is a 6 h gate deferred to US-004's gate env |
| NF-5 | gnu-portability lint hard gate is RED: `self-tests/storm-chain-runner.sh` (`date +%s.%N` ×4) and `self-tests/storm-chain-wrapper.sh` (`stat -c` + `date +%s.%N`) carry GNU-isms with no allowlist entry | fixed (small, torture-only) | this commit (US-003) | `tier0-gnu-portability-lint.test.ts` passes alone: 18/18 (was 17/18 before the fix; verified this round) |
| NF-6 | redundant nested `.gitignore` files under `tt-poly*` re-declaring parent rules / comment-only | fixed | `009448fd` (US-002) | `git check-ignore -v` byte-identical to the US-001 baseline; affected self-tests pass (US-002 report) |

## NF-1..NF-3 fix-commit reachability (acceptance criterion 2)

All three fixing commits are ancestors of HEAD:

```
$ git merge-base --is-ancestor 7762fdf8 HEAD && echo reachable  # NF-1  -> reachable
$ git merge-base --is-ancestor a1121686 HEAD && echo reachable  # NF-2  -> reachable
$ git merge-base --is-ancestor bc535a44 HEAD && echo reachable  # NF-3  -> reachable
```

## NF-4 evidence (tier0-repeatability absent-operator-gitconfig defect)

Before this story, `torture-test/self-tests/tier0-repeatability.test.ts` took the
real operator `~/.gitconfig` snapshot with the unconditional `sha256(realGitconfig)`
and asserted the hygiene canary status `UNCHANGED` and the rendered report line
`- gitconfig: UNCHANGED`. vaimetal ships no `~/.gitconfig` (verified:
`/root/.gitconfig` absent), so the snapshot throws `ENOENT` and the canary renders
`ABSENT` — the identical defect class NF-1/NF-3 already fixed in the three
containment gates. The fix mirrors the proven `gitconfigFingerprint()` contract
(`present:false -> hash null`, `absent-stays-absent`) and accepts `ABSENT` in the
two canary assertions.

```
$ ls -la /root/.gitconfig  # -> No such file or directory (vaimetal)
```

The double-gate `it("runs the default Tier-0 gate green twice …")` has a 6 h
timeout and runs two full Tier-0 gates, so it is not executed in this round; the
file's parse/import and its fast documentation gate pass (`node --test
--test-name-pattern="documents zero-token default" …`: 1/1). The fingerprint logic
is byte-for-byte the same pattern shipped by `bc535a44` for the containment gates.

## NF-5 evidence (gnu-portability-lint storm-chain allowlist gap)

Before this story, `tier0-gnu-portability-lint.test.ts` hard gate failed with two
unallowlisted tracked shell files introduced by the O12-REPIN/NPF-2 storm-chain
gate machinery:

```
torture-test/self-tests/storm-chain-runner.sh:  date %N ×4 (acquire/start/end/release epoch)
torture-test/self-tests/storm-chain-wrapper.sh: stat -c (lock fingerprint) + date %N (submit epoch)
```

Both scripts are Linux-side-only gate-battery entry points (run the 49-file storm
chain under the held vaivm gate lock; never invoked by `./run-torture-test`, never
on the Darwin campaign). Two file-granularity ALLOWLIST entries were added (kept
sorted), each naming exactly the classes the file carries (G5 class coverage):

- `storm-chain-runner.sh` → `date %N (nanosecond)`
- `storm-chain-wrapper.sh` → `stat -c (GNU format)`, `date %N (nanosecond)`

Verification (this round):

```
$ node --test torture-test/self-tests/tier0-gnu-portability-lint.test.ts
# tests 18, pass 18, fail 0  (was 17/18 before the fix)
```

## Acceptance criteria check for US-003

- [x] Tracked NF sweep table under `torture-test/` (this file, `tu2f-nf-sweep.md`)
- [x] NF-1..NF-3 each cite a concrete fixing commit reachable from HEAD (see above)
- [x] Small torture-only fixes touch only `torture-test/**` (both edits are under `torture-test/self-tests/`)
- [x] `git status` shows no `src/` or non-torture modification
- [x] The relevant self-test for each fixed item passes when run alone (NF-5: gnu-portability-lint 18/18; NF-4: doc gate 1/1 + fingerprint logic mirrors `bc535a44`; the 6 h double-gate is deferred to the US-004 gate environment)
