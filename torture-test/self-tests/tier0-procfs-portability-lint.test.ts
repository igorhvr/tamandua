// MACP3 US-005 — procfs-portability lint (hard gate).
//
// Scans the tracked torture-test tree for the literal '/proc' and fails on
// any hit that is not explicitly allowlisted. The purpose is to ban silent
// linux-only procfs usage: the a446deac mac validation (both MACP3 campaigns
// produced /proc ENOENT infrastructure failures) proved /proc does not exist
// on Darwin, so any NEW '/proc' literal that is not portable, not guarded
// for a Darwin branch, not documented as linux-only-and-unreachable, or not
// owned by the concurrent run must be reviewed before merge.
//
// ── Scan surface ─────────────────────────────────────────────────────
//   * Tracked files under torture-test/ (git ls-files — hermetic, no walk of
//     generated state). Excluded: var/, results/, node_modules/ (generated
//     state) and this lint file itself (it necessarily contains many '/proc'
//     literals — same self-exclusion convention as tier0-bash32-compat-lint).
//   * A "hit" is the literal '/proc' NOT followed by 'ess'. '/process',
//     '/processing' and friends are the ENGLISH WORD "process" (per the
//     US-004 header-note convention in every harness: "'/'+'process'
//     substring coincidences ... are the word 'process', not the procfs
//     mount"). Files whose only matches are '/process' carries (e.g.
//     self-tests/scripted-scenario-w4.49-update-transaction.test.ts) contain
//     NO procfs reference and must NOT be allowlisted — an entry for one
//     would be stale.
//
// ── ALLOWLIST (file granularity — design decision) ──────────────────
//   The allowlist is keyed at FILE granularity, not line granularity, for a
//   measured reason: per-line "/proc on line L must be within N lines of a
//   marker" audits were prototyped and rejected as unreliable. In these
//   tools the same conceptual '/proc' text appears in doc block-comment
//   bodies, documentation template-literal strings, and prose echo/pass/fail
//   text that is NOT a procfs access, so a line-based discriminator cannot
//   distinguish "runtime read" from "documentation" without re-deriving a
//   full parser. The US-003/US-004 sweeps therefore established the
//   convention this lint enforces: each guarded FILE carries, once, the
//   marker string 'MACP3 US-003' (runtime tools) or 'MACP3 US-004' (test
//   harnesses) adjacent to / in the sweep headers, declaring the file's
//   linux-only procfs usage fully documented. The lint verifies that marker
//   is present (Guard gate) and that every file with a '/proc' literal is
//   covered by exactly one allowlist entry (Coverage + Staleness gates).
//
// ── Gates (a violation in any gate fails the suite) ─────────────────
//   G1 Coverage:    every scanned file containing a '/proc' hit must have an
//                   ALLOWLIST entry. (Catches NEW unguarded '/proc' usage.)
//   G2 Staleness:   every ALLOWLIST entry must reference a file that is part
//                   of the scanned surface AND still contains a '/proc' hit.
//                   (Catches entries orphaned by a portability fix — a stale
//                   entry silently disables linting for a file.)
//   G3 Guard:       every entry in a 'guarded' category must find its stated
//                   requiredMarker in the file content. (Catches "the guard
//                   the entry claims is no longer present", e.g. someone
//                   stripping the MACP3 sweep markers.)
//   G4 T2.1 naming: the concurrent-run-owned files (bin/daemon-control,
//                   bin/daemon-control.test.sh, scenarios/w4.23/..., and
//                   scenarios/w4.49/run-update-arm.mjs) must be explicitly
//                   allowlisted with category 't21-owned' — enumerated
//                   separately in the test so dropping one is a hard fail.
//   G5 scenarios/lib unguarded reads (MACP5 US-003): every '/proc' literal
//                   on a NON-COMMENT line in a scenarios/lib/ file must be
//                   either a guard-test line (`[ -r|-d|-f|-e|-L "/proc...`)
//                   or within 2 lines below such a guard line. The
//                   file-granularity allowlist cannot catch an unguarded
//                   input-redirection/cat/tr read in an otherwise-legitimately
//                   allowlisted file (the pre-US-002
//                   '/proc/sys/kernel/random/uuid' read at run-scripted-scenario
//                   line ~306 slipped through MACP3's sweep and MACP4's audit
//                   exactly that way), so G5 makes the class mechanical.
//
// ── Mutation proofs (each demonstrated in the tests below) ──────────
//   * New unguarded '/proc' usage in a currently-clean file → G1 violation.
//   * Dropping an allowlist entry → G1 violation.
//   * Stale allowlist entry (hit removed) → G2 violation.
//   * Guard marker stripped from a guarded file → G3 violation.
//   * Removing a T2.1 path from the allowlist → G4 violation.
//   * Unguarded '/proc' read added to a scenarios/lib/ file → G5 violation
//     (the pre-US-002 uuid read is the red case; the guarded /proc/<pid>/stat
//     pattern and comment/prose text are the green pins).
//
// Runs via self-tests/run.sh's tier0-*.test.ts glob (no run.sh edit needed).
// Zero tokens, hermetic, repo-relative scanning only (no live daemon).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const TT_PREFIX = "torture-test/";
const LINT_BASENAME = "tier0-procfs-portability-lint.test.ts";

// ── allowlist categories ──────────────────────────────────────────────

type AllowCategory =
  | "us001-portable" // US-001 deliverable: the portable implementation is /proc-free; retained /proc is deliberate legacy/simulation reference
  | "us002-proof" // US-002 proof harness: /proc references are assertions about the (intentionally legacy) /proc-based simulation
  | "us003-runtime-guarded" // runtime tools swept in US-003; every /proc marked 'MACP3 US-003' (Darwin branch or inline linux-only doc)
  | "us004-harness-guarded" // test harnesses swept in US-004; every /proc marked 'MACP3 US-004' (guard or graceful-degradation doc)
  | "t21-owned" // owned by the concurrent run T2.1 (daemon-control + tier2 scenario run files) — out of scope, documented
  | "documentation"; // prose only (.md / .txt / evidence artifacts) — no runtime procfs access

interface AllowEntry {
  category: AllowCategory;
  reason: string;
  /** For guarded categories: exact marker that must appear in the file so
   *  the stated guard is verified, not just claimed. */
  requiredMarker?: string;
}

// ── ALLOWLIST ─────────────────────────────────────────────────────────
// Keyed by torture-test-relative path. Sorted by category then path — keep
// it sorted; a diff is the review surface for every future '/proc' change.
// Populated from the US-001..US-004 outcomes and the T2.1 ownership contract.
const ALLOWLIST: Record<string, AllowEntry> = {
  // ── US-001 portable (no requiredMarker: the /proc text is the retained
  //    legacy simulation arm + the lint guard; the portable writer
  //    oracles/lib/evidence.mjs itself has ZERO /proc literals — enforced by
  //    evidence-portability.test.mjs's own no-literal lint assert). ──────
  "oracles/lib/evidence-procfd-legacy.mjs": {
    category: "us001-portable",
    reason:
      "US-001/002 deliverable: the intentionally preserved /proc/self/fd legacy exclusive-create strategy, kept ONLY as the injectable simulation arm (procAvailable). Portable evidence.mjs has zero /proc literal; these references are the documented legacy behavior under test.",
  },

  // ── US-002 proof harness (no requiredMarker: pure test assertions about
  //    the legacy /proc strategy and the no-litmus guard — see the file's
  //    header narrative). ────────────────────────────────────────────────
  "oracles/lib/evidence-portability.test.mjs": {
    category: "us002-proof",
    reason:
      "US-002 deliverable: hermetic red-then-green proof that models a /proc-less (Darwin) host. Its '/proc' occurrences are assertions about the legacy strategy and the no-/-proc-literal lend guard — the derivation, not runtime procfs access.",
  },

  // ── US-003 runtime tools, fully guarded (requiredMarker verified) ─────
  "bin/oracle-context.mjs": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: every /proc hit carries an inline MACP3 US-003 linux-only guard/doc (Darwin branch or graceful-degradation note).",
  },
  "bin/oracle-evidence-snapshot.mjs": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: the /proc/self/fd path was the real Darwin hard-fail; now under an explicit platform guard (fdPath vs logical realpath) with MACP3 US-003 linux-only markers — linux behavior unchanged.",
  },
  "bin/tt-chaos": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: every /proc read (stat/status/cwd/cmdline) carries a MACP3 US-003 linux-only guarded/Darwin-degradation marker; no silent linux-isms.",
  },
  "bin/tt-controller": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: every /proc read and every '/proc sweep' conceptual comment carries a MACP3 US-003 linux-only marker (graceful null-degradation documented).",
  },
  "bin/tt-daemon-up": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: every /proc/<pid>/environ read is guarded [ -d /proc/... ] / graceful 2>/dev/null with an adjacent MACP3 US-003 linux-only Darwin-behavior note.",
  },
  "bin/tt-kill-sentinel": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: every /proc/$pid/stat presence/zombie probe carries a MACP3 US-003 linux-only marker documenting null-degradation / guard-fails-Darwin behavior.",
  },
  "bin/tt-process-identity.mjs": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc/<pid>/stat reads are linux-only with MACP3 US-003 markers; readers null-degrade and getProcessStartIdentity short-circuits non-linux.",
  },
  "bin/tt-recorder": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: every /proc read (fd dir, cwd/cmdline find scans, status) carries a MACP3 US-003 linux-only guarded or graceful-degradation marker; find/readlink/cat all tolerate /proc absence.",
  },
  "bin/tt-verify-environment": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc/<pid>/cwd read has an explicit darwin branch (pread extended) plus MACP3 US-003 markers; pre-existing darwin handling was extended, not weakened.",
  },
  "oracles/self-test/generate-o4-fixtures.mjs": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc usage documented linux-only with MACP3 US-003 marker; graceful on /proc-less hosts.",
  },
  "oracles/self-test/o4.test.mjs": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc usage documented linux-only with MACP3 US-003 marker; graceful on /proc-less hosts.",
  },
  "oracles/self-test/reap-live-pgids.mjs": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc reads are linux-only process introspection with MACP3 US-003 markers; null/tolerated on Darwin.",
  },
  "oracles/self-test/reap-live-pgids.test.mjs": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc references are linux-only with MACP3 US-003 marker; test tolerates /proc-less hosts.",
  },
  "oracles/self-test/run.sh": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc references documented linux-only with MACP3 US-003 marker.",
  },
  "oracles/self-test/watchdog.test.mjs": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc references documented linux-only with MACP3 US-003 marker; graceful on /proc-less hosts.",
  },
  "scenarios/lib/run-scripted-scenario": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: the remaining /proc hits are the guarded linux-only /proc/<pid>/stat reads (process_starttime/process_group — each preceded by [ -r ] with a portable ps fallback arm) carrying MACP3 US-003 markers; the /proc uuid read was removed in MACP5 US-002 (portable_uuid_suffix() is now the single portable source).",
  },
  "self-tests/tier0-repeatability.test.ts": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc process-introspection hits carry a MACP3 US-003 linux-only marker; real Darwin branches (early empty return on non-linux) where a read would hard-fail.",
  },
  "self-tests/tier1-kill-ancestry-hygiene.test.ts": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc references are static regex/prose documented as linux-only-and-unreachable-as-runtime on Darwin with MACP3 US-003 markers.",
  },
  "self-tests/tier1-kill-sentinel-survival.test.ts": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc references carry MACP3 US-003 markers with explicit non-linux no-op/skip behavior.",
  },
  "self-tests/tier1-scripted-probe-battery.test.ts": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc snapshot/assert helpers carry MACP3 US-003 markers; empty-snapshot no-op on non-linux.",
  },
  "self-tests/tier2-chaos-block-extension.test.ts": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc references carry MACP3 US-003 markers; documented linux-only and unreachable-as-runtime on Darwin.",
  },
  "self-tests/tier2-roster-section-h.test.ts": {
    category: "us003-runtime-guarded",
    requiredMarker: "MACP3 US-003",
    reason: "US-003: /proc references carry MACP3 US-003 markers; documented linux-only and unreachable-as-runtime on Darwin.",
  },

  // ── US-004 test-harness files, fully guarded (requiredMarker verified) ─
  "bin/tt-chaos.test.sh": {
    category: "us004-harness-guarded",
    requiredMarker: "MACP3 US-004",
    reason: "US-004: every /proc read guarded ([ -f /proc/.. ]) or graceful (2>/dev/null) with an adjacent MACP3 US-004 linux-only Darwin-behavior marker; prose covered by the file's US-004 header note.",
  },
  "bin/tt-controller-idempotence.test.sh": {
    category: "us004-harness-guarded",
    requiredMarker: "MACP3 US-004",
    reason: "US-004: remaining /proc text is documentation prose (covered by the US-004 header note) — no unguarded runtime read in this harness.",
  },
  "bin/tt-controller.test.sh": {
    category: "us004-harness-guarded",
    requiredMarker: "MACP3 US-004",
    reason: "US-004: /proc text is documentation prose with a US-004 header note; the sweep concept is unreachable-as-runtime on Darwin.",
  },
  "bin/tt-daemon-up.test.sh": {
    category: "us004-harness-guarded",
    requiredMarker: "MACP3 US-004",
    reason: "US-004: every /proc/$pid/environ read guarded by [ -d /proc/.. ] and marked MACP3 US-004 linux-only with the exact guard-fails->pass-by-note Darwin path.",
  },
  "bin/tt-process-identity.test.mjs": {
    category: "us004-harness-guarded",
    requiredMarker: "MACP3 US-004",
    reason: "US-004: /proc text carries a MACP3 US-004 linux-only marker; harness tolerates /proc-less hosts (reads are mocked/platform-gated).",
  },
  "bin/tt-recorder.test.sh": {
    category: "us004-harness-guarded",
    requiredMarker: "MACP3 US-004",
    reason: "US-004: every /proc runtime read (status/VmRSS, stat, cmdline, fd dirs, /proc/net/tcp) carries an inline MACP3 US-004 linux-only marker; all other /proc text is prose covered by the file's US-004 header note.",
  },
  "self-tests/tier1-daemon-control-darwin-identity.test.ts": {
    category: "us004-harness-guarded",
    requiredMarker: "MACP3 US-004",
    reason: "US-004: /proc references are linux-only documentation/assertion prose (the Darwin identity/ownership pins are simulated via injectable seams); the reads being pinned live inside the guarded tools.",
  },
  "self-tests/scripted-scenario-harness.test.ts": {
    category: "us004-harness-guarded",
    requiredMarker: "MACP3 US-004",
    reason: "US-004: /proc references are linux-only documentation/assertion prose (the MACP4 US-003 Darwin portability pins for the harness's process_starttime/process_group are simulated via the portable ps arms and the failing session-leader-binary seam); no runtime procfs access in this harness test.",
  },
  "self-tests/tier1-host-profile-daemon-scripted.test.ts": {
    category: "us004-harness-guarded",
    requiredMarker: "MACP3 US-004",
    reason: "US-005: /proc references are linux-only documentation/assertion prose — the MACP4 US-005 daemon-scripted capability computation is a pure PATH scan (commandOnPath) that never touches the procfs mount; the structural pin asserts exactly that, and the both-platform proof is a simulated-Darwin run on a /proc-less, getent-less PATH seam.",
  },

  // ── T2.1-owned (concurrent run owns daemon-control + tier2 scenario
  //    run files — no MACP3 markers required; out of scope for this branch,
  //    enumerated explicitly by the T2.1 coverage test below). ──────────
  "bin/daemon-control": {
    category: "t21-owned",
    reason:
      "T2.1-owned (concurrent run): bin/daemon-control is the daemon-control runtime (E3.C.1) — linux-only /proc reads (cgroup, cwd, cmdline, environ, stat) are real but owned/swept by that branch; this run must not touch it.",
  },
  "bin/daemon-control.test.sh": {
    category: "t21-owned",
    reason:
      "T2.1-owned (concurrent run): daemon-control test harness — all /proc text (verify_cgroup/cwd/cmdline, cmd_status existence) is linux-only and owned by the concurrent run; explicitly out of scope for US-003/US-004, allowing its marker-free status.",
  },
  "scenarios/w4.23/daemon-cross-runtime-restart/run-cross-runtime.mjs": {
    category: "t21-owned",
    reason:
      "T2.1-owned (concurrent run): tier2 scenario run file that asserts /proc/<pid>/exe — owned by the concurrent tier2 scenario work; not swept in US-003/US-004.",
  },
  "scenarios/w4.49/run-update-arm.mjs": {
    category: "t21-owned",
    reason:
      "T2.1-owned (concurrent run): tier2 scenario run file reading /proc/<pid>/stat — owned by the concurrent tier2 scenario work; not swept in US-003/US-004.",
  },

  // ── documentation (prose only — .md / .txt / evidence artifacts; no
  //    runtime procfs access; no marker required). ──────────────────────
  "bin/tt-report-legacy-vacuity.mjs": {
    category: "documentation",
    reason:
      "MACP3 US-009 frozen pre-US-008 verdict arm — its single '/proc' occurrence is prose in the header citing the evidence-procfd-legacy.mjs precedent; the module does no procfs access.",
  },
  "cases/tier2-traceability.md": {
    category: "documentation",
    reason: "Spec/traceability markdown — '/proc/<pid>/exe' is prose documenting a scripted-scenario assertion.",
  },
  "impl-tasks/A1-tt-verify-environment.md": {
    category: "documentation",
    reason: "Task documentation — '/proc' mention is prose about the observed-only environment tool.",
  },
  "impl-tasks/E3.C.2-us001-root-cause-note.md": {
    category: "documentation",
    reason: "Task documentation — '/proc' starttime reference is prose.",
  },
  "impl-tasks/E3.C.2-us003-evidence/red-run-prefix-74f4d332.txt": {
    category: "documentation",
    reason: "Captured evidence artifact — '/proc' text is verbatim source/test dump prose.",
  },
  "impl-tasks/E3.C.2-us004-evidence/session2/daemon-control-battery.txt": {
    category: "documentation",
    reason: "Captured evidence artifact — '/proc' pass/fail prose from a daemon-control battery run.",
  },
  "impl-tasks/E3.C.2-us004-implementation-note.md": {
    category: "documentation",
    reason: "Task documentation — '/proc' cwd/env references are implementation-note prose.",
  },
  "impl-tasks/MACP3-procfd-portability-vacuous-green.md": {
    category: "documentation",
    reason: "This task's own description doc — '/proc/self/fd' defect narrative and plan, prose only.",
  },
  "impl-tasks/MACP3.1-salvage-complete-procfd-vacuity.md": {
    category: "documentation",
    reason:
      "MACP3.1 salvage task description doc (landed with the salvage commit) — '/proc' portability narrative and acceptance items, prose only; no runtime procfs access.",
  },
  "impl-tasks/MACP4-darwin-w2-scripted-cells.md": {
    category: "documentation",
    reason:
      "MACP4 task description doc — its '/proc' occurrence ('/proc-era leftovers' in the audit scope) is prose in the task narrative; the doc performs no runtime procfs access.",
  },
  "impl-tasks/MACP5-darwin-fallback-pid-and-portability.md": {
    category: "documentation",
    reason:
      "MACP5 task description doc — its '/proc' occurrences (the '/proc uuid' defect narrative, '/proc-era' sweep scope) are prose in the task narrative; the doc performs no runtime procfs access.",
  },
  "self-tests/tier0-gnu-portability-lint.test.ts": {
    category: "documentation",
    reason:
      "MACP5 US-005 GNU-ism lint — its '/proc' occurrences are prose in the GNU-ism allowlist reasons (tt-chaos/tt-recorder readlink -f canonicalizes /proc/<pid>/cwd) and the header narrative; the lint performs no runtime procfs access.",
  },
  "self-tests/tier1-bare-vacuity-red-green.test.ts": {
    category: "documentation",
    reason:
      "MACP3 US-009 red-then-green proof — its single '/proc' occurrence is prose in the header narrative describing the mac's missing /proc (the defect context, not a runtime read); the proof performs no procfs access.",
  },
  "self-tests/tier1-final-acceptance.test.ts": {
    category: "documentation",
    reason:
      "MACP3 authoring-surface comment in tier1-final-acceptance's allowed[] list mentions '/proc' as documentation prose (the file contains /proc text since the US-005 authoring entry landed) — no runtime procfs access in this battery test.",
  },
  "self-tests/tier1-macp31-salvage-evidence-note.test.ts": {
    category: "documentation",
    reason:
      "MACP3.1 US-006 evidence-note pin — its '/proc' occurrences are prose in the header narrative describing the adopted US-003/US-004 sweeps; the test only reads the MACP3 task doc, no runtime procfs access.",
  },
  "self-tests/tier1-macp31-salvage-landing-report.test.ts": {
    category: "documentation",
    reason:
      "MACP3.1 US-009 landing-report pin — its '/proc' occurrences are prose in the header narrative and the acceptance-item names (portability fix, '/proc sweep completeness'); the test only reads the MACP3.1 salvage doc, no runtime procfs access.",
  },
};

// ── /proc hit detection ───────────────────────────────────────────────

/** True when `content` contains the literal '/proc' (procfs mount), i.e.
 *  NOT the word 'process' ('/process', '/processing', ...). The slash word
 *  coincidences are covered by the US-003/US-004 header notes; they are not
 *  procfs references and must not force an allowlist entry (an entry for a
 *  /process-only file would be stale). */
function hasProcLiteral(content: string): boolean {
  const re = /\/proc/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const tail = content.slice(m.index + 5, m.index + 8);
    if (tail !== "ess") return true; // '/process' → the word 'process'
  }
  return false;
}

// ── scan surface ────────────────────────────────────────────────────

/** Every tracked file under torture-test/ that the lint scans, as
 *  torture-test-relative paths, excluding generated state (var/, results/,
 *  node_modules/) — which are never committed anyway — and this lint's own
 *  source file (it necessarily contains the pattern literal). */
function collectScannedFiles(root: string): string[] {
  const result = spawnSync("git", ["ls-files", TT_PREFIX], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  const files: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw.startsWith(TT_PREFIX)) continue;
    const rel = raw.slice(TT_PREFIX.length);
    if (rel === "") continue;
    if (
      rel.startsWith("var/") ||
      rel.startsWith("results/") ||
      rel.startsWith("node_modules/")
    ) {
      continue; // generated state
    }
    if (path.basename(rel) === LINT_BASENAME) continue; // self-exclusion
    files.push(rel);
  }
  return files.sort();
}

// ── the gates ────────────────────────────────────────────────────────

/** Pure integrity audit over an (allowlist, file-contents) snapshot. Returns
 *  every violation as a human-readable string; [] means GREEN. Exposed so
 *  the mutation tests can drive regressions against synthetic snapshots. */
function gateAll(
  entries: Record<string, AllowEntry>,
  contents: Record<string, string>,
): string[] {
  const violations: string[] = [];
  const rels = [...new Set([...Object.keys(contents), ...Object.keys(entries)])].sort();

  for (const rel of rels) {
    const entry = entries[rel];
    const content = contents[rel];
    if (content === undefined) {
      // G2: allowlist entry pointing outside the scanned surface (file now
      // deleted, or an entry added for a var//results/ excluded file).
      violations.push(
        `${TT_PREFIX}${rel}: stale ALLOWLIST entry (${entry ? entry.category : "unknown"}) — file is not part of the scanned surface`,
      );
      continue;
    }
    if (!hasProcLiteral(content)) {
      if (entry) {
        violations.push(
          `${TT_PREFIX}${rel}: stale ALLOWLIST entry (${entry.category}) — file no longer contains a /proc literal`,
        );
      }
      continue; // no hit → no G1 requirement (and /process-only files stay unlisted)
    }
    if (!entry) {
      // G1: a scanned file contains unguarded '/proc' with no allowlist entry.
      violations.push(
        `${TT_PREFIX}${rel}: contains a /proc literal but has no ALLOWLIST entry`,
      );
      continue;
    }
    if (entry.requiredMarker && !content.includes(entry.requiredMarker)) {
      // G3: the guard the entry claims is actually gone from the file.
      violations.push(
        `${TT_PREFIX}${rel}: guard missing — ALLOWLIST claims '${entry.category}' but required marker '${entry.requiredMarker}' is absent from the file`,
      );
    }
  }
  return violations;
}

/** Audit the live tree. File contents are read from disk for the scanned
 *  surface only — repo-relative, zero tokens, no daemon. */
function auditLiveTree(): string[] {
  const contents: Record<string, string> = {};
  for (const rel of collectScannedFiles(repoRoot)) {
    const p = path.join(repoRoot, TT_PREFIX, rel);
    if (fs.existsSync(p)) contents[rel] = fs.readFileSync(p, "utf8");
  }
  return [...gateAll(ALLOWLIST, contents), ...g5UnguardedReadViolations(contents)];
}

// ── G5: unguarded /proc reads in scenarios/lib/ (MACP5 US-003) ──────
// The allowlist is FILE granularity by design, so an otherwise-legitimate
// scenarios/lib/ file can hide ONE unguarded read (the pre-US-002
// '/proc/sys/kernel/random/uuid' input-redirection read in
// run-scripted-scenario slipped through both MACP3's sweep and MACP4's audit
// exactly that way). G5 makes the class mechanical: any '/proc' literal on a
// non-comment line under scenarios/lib/ must be a guard-test line
// (`[ -r|-d|-f|-e|-L "/proc...`) or sit within 2 lines below one. The
// guarded /proc/<pid>/stat reads in process_starttime/process_group (each
// preceded by `if [ -r "/proc/$pid/stat" ]`) satisfy this; unguarded
// input-redirection/cat/tr reads like the pre-fix uuid line do not.

/** True when the line is a /proc guard test: a `[ -r|-d|-f|-e|-L "/proc...`
 *  shell test (with optional leading `if `/`&&`/`||`/whitespace). */
function isProcGuardTestLine(line: string): boolean {
  return /\[\s*-(r|d|f|e|L)\s+["']?\/proc/.test(line);
}

/** True when the line is comment/prose — shell '#' or JS '//'/'/*'/'*'. */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return (
    t.startsWith("#") ||
    t.startsWith("//") ||
    t.startsWith("/*") ||
    t.startsWith("*")
  );
}

/** G5: flag every '/proc' literal on a non-comment line of a scenarios/lib/
 *  file that is NOT itself a guard-test line AND is not within 2 lines below
 *  a guard-test line. Returns violation strings ([] = GREEN). Pure over the
 *  (rel → content) snapshot, like gateAll — the mutation tests drive it
 *  against synthetic snapshots. */
function g5UnguardedReadViolations(contents: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const rel of Object.keys(contents).sort()) {
    if (!rel.startsWith("scenarios/lib/")) continue;
    const lines = contents[rel].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!hasProcLiteral(line)) continue; // no '/proc' (word 'process' excluded)
      if (isCommentLine(line)) continue; // comment/prose text
      if (isProcGuardTestLine(line)) continue; // the guard test itself
      let guarded = false;
      for (let j = Math.max(0, i - 2); j < i; j++) {
        if (isProcGuardTestLine(lines[j])) {
          guarded = true; // within 2 lines below a guard test
          break;
        }
      }
      if (!guarded) {
        violations.push(
          `${TT_PREFIX}${rel}:${i + 1}: unguarded '/proc' on a non-comment line (not a [ -r|-d|-f|-e|-L guard test, not within 2 lines below one) — scenarios/lib must not read the procfs mount unguarded`,
        );
      }
    }
  }
  return violations;
}

// ── T2.1-owned paths (enumerated explicitly so dropping one is a hard
//    fail — acceptance criterion 4). ─────────────────────────────────
const T21_OWNED_PATHS: Record<string, string> = {
  "bin/daemon-control": "daemon-control runtime (E3.C.1) — concurrent run T2.1 owns the file",
  "bin/daemon-control.test.sh": "daemon-control test harness — concurrent run T2.1 owns the file",
  "scenarios/w4.23/daemon-cross-runtime-restart/run-cross-runtime.mjs":
    "tier2 scenario run file — concurrent run T2.1 owns the file",
  "scenarios/w4.49/run-update-arm.mjs": "tier2 scenario run file — concurrent run T2.1 owns the file",
};

/** G4: every T2.1-owned path must be allowlisted with category
 *  't21-owned'. Returns violation strings ([] = GREEN) so the live gate and
 *  the mutation test share one implementation. */
function t21CoverageViolations(entries: Record<string, AllowEntry>): string[] {
  const violations: string[] = [];
  for (const [rel, why] of Object.entries(T21_OWNED_PATHS)) {
    const entry = entries[rel];
    if (!entry) {
      violations.push(`${TT_PREFIX}${rel}: T2.1-owned path (${why}) missing from ALLOWLIST`);
      continue;
    }
    if (entry.category !== "t21-owned") {
      violations.push(`${TT_PREFIX}${rel}: T2.1-owned path must be category 't21-owned', got '${entry.category}' (${why})`);
    }
  }
  return violations;
}

// ── tests ────────────────────────────────────────────────────────────

describe("tier0 procfs-portability lint", () => {
  it("scans the tracked torture-test surface and finds zero violations (hard gate)", () => {
    const violations = auditLiveTree();
    assert.deepEqual(
      violations,
      [],
      `unguarded '/proc' usage is not fully allowlisted:\n${violations.join("\n")}`,
    );
  });

  it("scans only the tracked surface and excludes generated state and itself", () => {
    const files = collectScannedFiles(repoRoot);
    assert.ok(!files.some((f) => path.basename(f) === LINT_BASENAME), "lint must not scan its own source");
    for (const f of files) {
      assert.ok(
        !f.startsWith("var/") && !f.startsWith("results/") && !f.startsWith("node_modules/"),
        `generated state leaked into the scan surface: ${f}`,
      );
    }
    assert.ok(files.length > 100, `expected the tracked torture-test surface, got ${files.length} files`);
  });

  it("allowlists every file that actually contains a /proc literal", () => {
    const contents: Record<string, string> = {};
    for (const rel of collectScannedFiles(repoRoot)) {
      contents[rel] = fs.readFileSync(path.join(repoRoot, TT_PREFIX, rel), "utf8");
    }
    const violationText = gateAll(ALLOWLIST, contents).join("\n");
    for (const rel of Object.keys(contents)) {
      if (!hasProcLiteral(contents[rel])) continue;
      assert.ok(
        rel in ALLOWLIST,
        `${TT_PREFIX}${rel} contains a /proc literal but is missing from the allowlist — add an entry with category+reason (see scan shown by the hard gate)`,
      );
    }
    assert.ok(true, `all ${Object.keys(contents).filter((r) => hasProcLiteral(contents[r])).length} /proc-bearing files allowlisted`);
  });

  it("has no stale or guard-less allowlist entries (G2/G3 on the live tree)", () => {
    const contents: Record<string, string> = {};
    for (const rel of collectScannedFiles(repoRoot)) {
      if (fs.existsSync(path.join(repoRoot, TT_PREFIX, rel))) {
        contents[rel] = fs.readFileSync(path.join(repoRoot, TT_PREFIX, rel), "utf8");
      }
    }
    const violations = gateAll(ALLOWLIST, contents).filter((v) => v.includes("stale") || v.includes("guard missing"));
    assert.deepEqual(violations, [], `stale/guard violations:\n${violations.join("\n")}`);
  });

  it("explicitly names the T2.1-owned files as out-of-scope (acceptance criterion 4)", () => {
    const violations = t21CoverageViolations(ALLOWLIST);
    assert.deepEqual(
      violations,
      [],
      `T2.1-owned paths must be allowlisted as 't21-owned':\n${violations.join("\n")}`,
    );
  });

  it("treats '/process' as the word 'process', not procfs (no stale entries for /process-only files)", () => {
    assert.ok(!hasProcLiteral("a file about /process and /processing paths"), "'/process' must not count as a procfs literal");
    assert.ok(hasProcLiteral("a file reading /proc/$pid/stat"), "'/proc/<pid>' is a procfs literal");
    assert.ok(hasProcLiteral("/proc/self/fd/11/o3z-token-gate.json"), "'/proc/self/fd' is the original mac defect literal");
    // /process-only files must not be allowlisted (an entry would be stale).
    const processOnly = new Set([
      "self-tests/scripted-scenario-w4.49-update-transaction.test.ts",
      "self-tests/tier0-controller-home-containment.test.ts",
      "tamandua-torture-test-spec/03-oracles.md",
    ]);
    for (const rel of processOnly) {
      assert.ok(!(rel in ALLOWLIST), `${TT_PREFIX}${rel} only contains the word '/process' and must not carry an allowlist entry`);
    }
  });

  it("MUTATION: flags a NEW unguarded '/proc' usage in a currently-clean file (G1)", () => {
    // Simulate a future regression: a tracked file that today has no /proc
    // gains an unguarded '/proc/$pid/stat' read and is NOT allowlisted.
    const cleanFiles = collectScannedFiles(repoRoot).filter((rel) => !hasProcLiteral(fs.readFileSync(path.join(repoRoot, TT_PREFIX, rel), "utf8")));
    assert.ok(cleanFiles.length > 0, "need at least one currently-clean scanned file for the mutation");
    const target = cleanFiles[0];
    const contents: Record<string, string> = {};
    for (const rel of collectScannedFiles(repoRoot)) {
      contents[rel] = fs.readFileSync(path.join(repoRoot, TT_PREFIX, rel), "utf8");
    }
    contents[target] +=
      '\n# MUTATION (unguarded /proc)\nval="$(cat /proc/$pid/stat 2>/dev/null || true)"\n';
    const violations = gateAll(ALLOWLIST, contents);
    assert.ok(
      violations.some((v) => v.includes(target) && v.includes("no ALLOWLIST entry")),
      `expected a G1 gap violation for ${TT_PREFIX}${target}, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: flags a dropped allowlist entry (G1 re-fire) and a stripped guard marker (G3)", () => {
    const contents: Record<string, string> = {};
    for (const rel of collectScannedFiles(repoRoot)) {
      contents[rel] = fs.readFileSync(path.join(repoRoot, TT_PREFIX, rel), "utf8");
    }
    // (a) Drop the tt-recorder harness entry → its file still has hits → G1.
    const withoutEntry = { ...ALLOWLIST };
    delete withoutEntry["bin/tt-recorder.test.sh"];
    const gapViolations = gateAll(withoutEntry, contents);
    assert.ok(
      gapViolations.some((v) => v.includes("bin/tt-recorder.test.sh") && v.includes("no ALLOWLIST entry")),
      `dropping the bin/tt-recorder.test.sh entry must trip G1, got:\n${gapViolations.join("\n") || "(none)"}`,
    );
    // (b) Strip every US-004 marker out of the harness content → G3 must fire
    //     even though the file still contains /proc and is allowlisted.
    const stripped = { ...contents };
    stripped["bin/tt-recorder.test.sh"] = contents["bin/tt-recorder.test.sh"].replace(/MACP3 US-004/g, "");
    const guardViolations = gateAll(ALLOWLIST, stripped);
    assert.ok(
      guardViolations.some((v) => v.includes("bin/tt-recorder.test.sh") && v.includes("guard missing")),
      `stripping the US-004 markers must trip G3, got:\n${guardViolations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: flags a stale allowlist entry (G2)", () => {
    // Take a real /proc-bearing file, remove every real hit, and show the
    // allowlist entry for it becomes stale — simulating a future portability
    // fix that forgets to delete the now-vacuous allowlist entry.
    const contents: Record<string, string> = {};
    for (const rel of collectScannedFiles(repoRoot)) {
      contents[rel] = fs.readFileSync(path.join(repoRoot, TT_PREFIX, rel), "utf8");
    }
    const fixed = { ...contents };
    fixed["bin/tt-daemon-up.test.sh"] = contents["bin/tt-daemon-up.test.sh"]
      .replace(/\/proc\b/g, "/dev/sample") // careful: not the word '/process'
      .replace(/\/process\b/g, "/process"); // keep the word 'process' intact
    const violations = gateAll(ALLOWLIST, fixed);
    assert.ok(
      violations.some((v) => v.includes("bin/tt-daemon-up.test.sh") && v.includes("stale")),
      `a hit-removed file must trip the stale check, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: dropping a T2.1-owned entry fails the explicit naming gate (G4)", () => {
    const reduced = { ...ALLOWLIST };
    delete reduced["scenarios/w4.49/run-update-arm.mjs"];
    // The generic gates must at least flag the /proc-bearing scenario file
    // (G1) while unlisted …
    const contents: Record<string, string> = {};
    for (const rel of collectScannedFiles(repoRoot)) {
      contents[rel] = fs.readFileSync(path.join(repoRoot, TT_PREFIX, rel), "utf8");
    }
    const genericGap = gateAll(reduced, contents).some((v) => v.includes("scenarios/w4.49/run-update-arm.mjs"));
    assert.ok(genericGap, "the /proc-bearing T2.1 file must at least trip the generic gap gate when unlisted");
    // … and the EXPLICIT G4 naming gate must fire hard and specifically.
    const g4 = t21CoverageViolations(reduced);
    assert.ok(
      g4.some((v) => v.includes("scenarios/w4.49/run-update-arm.mjs") && v.includes("T2.1-owned")),
      `the explicit G4 naming gate must flag the dropped path, got:\n${g4.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION (G5): flags the unguarded '/proc/sys/kernel/random/uuid' read class in a scenarios/lib file", () => {
    // The pre-US-002 tree read the linux-only uuid via unguarded input
    // redirection (run-scripted-scenario line ~306). Re-introducing that
    // exact line into a scenarios/lib/ file must trip G5 — the red case of
    // the red-then-green proof (the mutation test is the reproducible red
    // run; the live tree post-US-002 is the green run).
    const contents: Record<string, string> = {};
    for (const rel of collectScannedFiles(repoRoot)) {
      contents[rel] = fs.readFileSync(path.join(repoRoot, TT_PREFIX, rel), "utf8");
    }
    const target = "scenarios/lib/run-scripted-scenario";
    contents[target] +=
      '\nUUID_SUFFIX="$(tr -d \'-\' </proc/sys/kernel/random/uuid 2>/dev/null | cut -c1-12)"\n';
    const violations = g5UnguardedReadViolations(contents);
    const expectedLine = contents[target].split(/\r?\n/).length - 1; // the appended line (0-based → +1)
    assert.ok(
      violations.some(
        (v) => v.includes(target) && v.includes(`:${expectedLine}:`) && v.includes("unguarded"),
      ),
      `expected a G5 unguarded-read violation for ${TT_PREFIX}${target}:${expectedLine}, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION (G5): the pre-US-002 tree's line 306 is exactly what G5 flags (red proof via git)", () => {
    // Red-then-green documentation arm: materialize the ACTUAL pre-US-002
    // run-scripted-scenario (the parent of the US-002 fix commit, whose line
    // ~306 carries the unguarded uuid read) and assert G5 flags that exact
    // read. The live tree (post-US-002) is asserted green by the hard gate
    // and the dedicated live-surface test below. The pre-fix commit is
    // resolved by message so the pin survives history edits.
    const log = spawnSync(
      "git",
      ["log", "-1", "--format=%H", "--grep=US-002 - run-scripted-scenario"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(log.status, 0, `git log failed: ${log.stderr}`);
    const us002Commit = log.stdout.trim();
    assert.ok(
      /^[0-9a-f]{40}$/.test(us002Commit),
      `could not resolve the US-002 commit (grep found '${us002Commit}') — the MACP5 US-002 history is missing`,
    );
    const git = spawnSync(
      "git",
      ["show", `${us002Commit}~1:torture-test/scenarios/lib/run-scripted-scenario`],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(git.status, 0, `git show of the pre-US-002 tree failed: ${git.stderr}`);
    const preFixContent = git.stdout;
    assert.ok(
      preFixContent.includes("</proc/sys/kernel/random/uuid"),
      "pre-fix tree must contain the unguarded uuid input-redirection read",
    );
    const violations = g5UnguardedReadViolations({
      "scenarios/lib/run-scripted-scenario": preFixContent,
    });
    const lineNo = preFixContent.split(/\r?\n/).findIndex((l) => l.includes("</proc/sys/kernel/random/uuid")) + 1;
    assert.ok(
      violations.some(
        (v) => v.includes("scenarios/lib/run-scripted-scenario") && v.includes(`:${lineNo}:`) && v.includes("unguarded"),
      ),
      `G5 must flag the pre-fix uuid read at line ${lineNo}, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("G5 POSITIVE PIN: guarded /proc/$pid/stat reads (with [ -r ... ] + portable ps fallback) do NOT trip G5", () => {
    // The legitimate pattern in process_starttime/process_group: the read is
    // on the line directly below the `if [ -r "/proc/$pid/stat" ]` guard.
    const snippet = [
      "process_starttime() {",
      "  local pid=\"$1\" details rest ps_out",
      "  # linux-only /proc/<pid>/stat read (MACP3 US-003): guarded for Darwin by",
      "  # [ -r ] + 2>/dev/null — a /proc-less host falls through to the portable",
      "  # ps arm below.",
      '  if [ -r "/proc/$pid/stat" ]; then',
      '    details="$(<"/proc/$pid/stat")" || return 1',
      "    rest=\"${details##*) }\"",
      "    set -- $rest",
      '    printf \'%s\\n\' "${20:-}"',
      "    return 0",
      "  fi",
      '  ps_out="$(ps -p "$pid" -o lstart= 2>/dev/null | sed \'s/^[[:space:]]*//\' || true)"',
      '  [ -n "$ps_out" ] || return 1',
      "  printf '%s\\n' \"$ps_out\"",
      "}",
    ].join("\n");
    const violations = g5UnguardedReadViolations({
      "scenarios/lib/run-scripted-scenario": snippet,
    });
    assert.deepEqual(
      violations,
      [],
      `guarded /proc/<pid>/stat reads must stay green under G5, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("G5 POSITIVE PIN: comment/prose /proc text does NOT trip G5", () => {
    const contents: Record<string, string> = {
      "scenarios/lib/run-scripted-scenario": [
        "# /proc/sys/kernel/random/uuid is linux-only (MACP3 US-003); on Darwin the",
        "# read fails and portable_uuid_suffix() below generates a portable unique",
        '# suffix (node crypto.randomUUID, `$$-$(date +%s)` last resort) —',
        "# guarded Darwin branch (MACP4 US-003).",
        '  # "scenario-owned" (conservative) exactly as the /proc-less empty result.',
        "// JS comment prose mentioning /proc/sys/kernel/random/uuid",
        "/* block comment prose: /proc/<pid>/stat reads are linux-only */",
      ].join("\n"),
    };
    const violations = g5UnguardedReadViolations(contents);
    assert.deepEqual(
      violations,
      [],
      `comment/prose /proc text must not trip G5, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("G5 LIVE: the scenarios/lib surface passes the unguarded-read gate (post-US-002)", () => {
    const contents: Record<string, string> = {};
    for (const rel of collectScannedFiles(repoRoot)) {
      if (rel.startsWith("scenarios/lib/")) {
        contents[rel] = fs.readFileSync(path.join(repoRoot, TT_PREFIX, rel), "utf8");
      }
    }
    assert.ok(Object.keys(contents).length > 0, "expected scenarios/lib files in the scanned surface");
    const violations = g5UnguardedReadViolations(contents);
    assert.deepEqual(
      violations,
      [],
      `live scenarios/lib surface must pass G5:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("allowlist entries are structurally sound", () => {
    for (const [rel, entry] of Object.entries(ALLOWLIST)) {
      assert.ok(rel.startsWith("bin/") || rel.startsWith("oracles/") || rel.startsWith("scenarios/") || rel.startsWith("self-tests/") || rel.startsWith("cases/") || rel.startsWith("impl-tasks/"), `allowlist key outside expected tree: ${rel}`);
      assert.ok(entry.reason.length > 10, `allowlist entry ${rel} needs a real reason`);
      if (entry.requiredMarker) {
        assert.ok(
          entry.requiredMarker === "MACP3 US-003" || entry.requiredMarker === "MACP3 US-004",
          `unexpected requiredMarker ${entry.requiredMarker} on ${rel}`,
        );
      }
    }
  });
});
