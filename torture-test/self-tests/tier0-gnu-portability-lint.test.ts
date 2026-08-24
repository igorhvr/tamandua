// MACP5 US-005 — GNU-ism portability lint (hard gate).
//
// The mac's W2 cells broke on GNU-only shell constructs ("sed: 1: ... command
// i expects \ followed by text" from GNU sed `i`/`-i` syntax, grep -P,
// readlink -f, date %N, GNU coreutils timeout, setsid). This lint scans the
// tracked torture-test SHELL surface (git ls-files; .sh extension or a bash
// shebang on the first line) on comment- and single-quote-masked lines and
// fails on any of the seven GNU-ism classes below, unless the file is
// explicitly allowlisted as a linux-side-only tool OUTSIDE the scripted
// scenario path. The bash32-compat lint (tier0-bash32-compat-lint.test.ts) is
// the scan-surface precedent (collectShellFiles/maskLine); the procfs lint
// (tier0-procfs-portability-lint.test.ts) is the allowlist/gate design
// precedent.
//
// MACP5.1: the red-then-green documentation arm is SELF-CONTAINED — the
// pre-US-004 snippets (install-scenario-workflows' `sed -i` id rewrite,
// daemon-control's `grep -oP`) are reproduced inline and scanned directly,
// instead of being materialized from git history. The US-004 commit exists
// only on the authoring branch (finalize-merge lands one squashed commit on
// main), so any git-log resolution would break on a main checkout. The
// history-independent-red-arms meta-lint
// (tier0-history-independent-red-arms.test.ts) locks this class.
//
// ── Gates (a violation in any gate fails the suite) ──────────────────
//   G1 Coverage:    a scanned NON-strict shell file with GNU-ism hits must
//                   have an ALLOWLIST entry. (Catches NEW GNU-ism usage.)
//   G2 Staleness:   every ALLOWLIST entry must reference a scanned shell file
//                   that still carries GNU-ism hits. (Catches entries
//                   orphaned by a portability fix — a stale entry silently
//                   disables linting for a file.)
//   G3 Strict zero- files under scenarios/, env/, scripted-runtimes/ plus
//      tolerance:   bin/daemon-control — the scripted scenario path that
//                   EXECUTES on Darwin — allow ZERO GNU-isms; no allowlist
//                   entry can cover them.
//   G4 Strict       a strict-path file must NOT have an allowlist entry; the
//      enumeration: strict membership is enumerated explicitly (prefixes +
//                   file) so dropping one is a hard fail.
//   G5 Class        an allowlisted file's entry must name EVERY GNU-ism class
//      coverage:    the file carries. (A NEW class in an allowlisted file
//                   still trips — closes the file-granularity blind spot the
//                   /proc lint's G5 addresses per-line for scenarios/lib.)
//
// ── Scan surface ────────────────────────────────────────────────────
//   * Tracked files under torture-test/ (git ls-files — hermetic). Excluded:
//     this lint's own source file (it necessarily contains the pattern
//     literals — same self-exclusion convention as the bash32 and /proc
//     lints). Generated state (var/, results/, node_modules/) is never
//     committed, so it never appears in git ls-files.
//   * The scan is comment- and single-quote-aware (maskLine): a `#` comment
//     or a single-quoted literal may mention a pattern (documentation, not
//     code); double-quoted content IS scanned because real commands live
//     inside double quotes. ONE exception: the `sed i\` (GNU insert) class
//     scans comment-only-masked lines, because the GNU insert script is
//     conventionally a single-quoted sed argument (`sed '3i\text' file`) —
//     those single quotes are CODE, and masking them would make the class
//     unenforceable on its canonical form.
//   * The `timeout` class targets the GNU coreutils `timeout <n> <cmd>`
//     COMMAND (with optional GNU short/long options and an optional s/m/h/d
//     duration unit) — NOT node/CLI `--timeout` flags or prose (those never
//     match the required leading whitespace/operator + numeric-duration
//     shape). Prose that literally spells "timeout 5 ..." in double quotes
//     would be flagged; write such text as a comment or single-quoted string.
//
// ── ALLOWLIST (file granularity — design decision) ──────────────────
//   Only linux-side-only tools OUTSIDE the strict scripted scenario path may
//   be allowlisted, each entry documenting why the file never runs on Darwin
//   (reachability: launched only by real-case cells — which are
//   predicate-excluded on Darwin — or part of the standalone linux-side
//   proof battery that ./run-torture-test never invokes) and why its GNU-isms
//   are confined to it. Entries are keyed by the repo-root-relative tracked
//   path (git ls-files form, matching collectShellFiles). Keep the list
//   sorted by path; a diff is the review surface for every future GNU-ism
//   change.
//
// Picked up by self-tests/run.sh's `tier0-*.test.ts` glob — no run.sh edit.
// Zero tokens; confined to torture-test/; the live 33xx daemon is never
// touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const LINT_BASENAME = "tier0-gnu-portability-lint.test.ts";

// ── shell-surface discovery (tier0-bash32-compat-lint convention) ─────

/** Tracked files under torture-test/ that are shell scripts (.sh extension
 *  or a bash shebang on the first line), excluding the lint's own file.
 *  Returns repo-root-relative paths (git ls-files form). */
function collectShellFiles(root: string): string[] {
  const result = spawnSync("git", ["ls-files", "torture-test/"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`);
  const files: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const rel = line.trim();
    if (rel === "") continue;
    if (path.basename(rel) === LINT_BASENAME) continue; // self-exclusion
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    if (rel.endsWith(".sh")) {
      files.push(rel);
      continue;
    }
    const first = fs.readFileSync(abs, "utf8").split(/\r?\n/, 1)[0] ?? "";
    if (/^#!.*\bbash\b/.test(first)) files.push(rel);
  }
  return files.sort();
}

// ── line masking (comment / single-quote awareness) ─────────────────────

/** Return `line` with comment tails and single-quoted spans replaced by
 *  spaces (positions preserved). Double-quoted content is kept — real
 *  commands live inside double quotes. Same helper as
 *  tier0-bash32-compat-lint.test.ts. */
function maskLine(line: string): string {
  const out: string[] = new Array<string>(line.length).fill("");
  let inSingle = false;
  let inDouble = false;
  let prev = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) {
      out[i] = " ";
      if (ch === "'") inSingle = false;
      prev = ch;
      continue;
    }
    if (inDouble) {
      out[i] = ch;
      if (ch === "\\") {
        if (i + 1 < line.length) {
          out[i + 1] = line[i + 1];
          i++;
        }
      } else if (ch === '"') {
        inDouble = false;
      }
      prev = ch;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out[i] = " ";
      prev = ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out[i] = ch;
      prev = ch;
      continue;
    }
    // A `#` begins a comment when it starts a word: at line start, or after
    // whitespace / a command separator.
    if (ch === "#" && (prev === "" || /\s/.test(prev) || /[;|&(){}]/.test(prev))) {
      for (let j = i; j < line.length; j++) out[j] = " ";
      break;
    }
    out[i] = ch;
    prev = ch;
  }
  return out.join("");
}

/** Return `line` with ONLY comment tails replaced by spaces — single-quoted
 *  spans are PRESERVED. Used for the `sed i\` class: the GNU insert script is
 *  conventionally a single-quoted sed argument (`sed '3i\text' file`), so the
 *  single quotes there are CODE, not a documentation literal; this class must
 *  see inside them. Every other class scans full-masked lines (a `#` comment
 *  or single-quoted literal mentioning a pattern is documentation). */
function maskComments(line: string): string {
  const out: string[] = new Array<string>(line.length).fill("");
  let inDouble = false;
  let prev = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inDouble) {
      out[i] = ch;
      if (ch === "\\") {
        if (i + 1 < line.length) {
          out[i + 1] = line[i + 1];
          i++;
        }
      } else if (ch === '"') {
        inDouble = false;
      }
      prev = ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out[i] = ch;
      prev = ch;
      continue;
    }
    // A `#` begins a comment when it starts a word: at line start, or after
    // whitespace / a command separator.
    if (ch === "#" && (prev === "" || /\s/.test(prev) || /[;|&(){}]/.test(prev))) {
      for (let j = i; j < line.length; j++) out[j] = " ";
      break;
    }
    out[i] = ch;
    prev = ch;
  }
  return out.join("");
}

// ── GNU-ism pattern classes (the MACP5 US-005 list) ────────────────────

interface GnuiClass {
  name: string;
  re: RegExp;
}

/** Each class is applied to a comment-masked line. Notes:
 *  - `sed -i` requires whitespace/end after the `-i` so the BSD-portable
 *    `sed -i.bak` suffix form is NOT flagged (only GNU's no-suffix in-place
 *    — the mac's exact failure — is).
 *  - `sed i\` has NO word boundary before `i\`: the GNU insert address is a
 *    digit/`$`/`,`/`/` word char (`sed '3i\text'`), so `\bi\\` would never
 *    match the canonical form. The class scans comment-only-masked lines
 *    (see scanContent) and may in principle false-positive on an exotic
 *    double-quoted `s/i\\/x/` substitution — no such pattern exists in the
 *    tracked tree, and the strict path is clean.
 *  - the `timeout` class matches the GNU coreutils COMMAND with a numeric
 *    duration (optional s/m/h/d unit and optional GNU options); `--timeout`
 *    flags and `timeout_ms`-style variables never match (a `-` or `_` sits
 *    before the word, or no numeric duration follows). */
const GNU_ISM_CLASSES: GnuiClass[] = [
  { name: "sed -i (GNU in-place)", re: /\bsed\s+(?:-[a-zA-Z]*i|--in-place)(?=\s|$)/ },
  { name: "sed i\\ (GNU insert)", re: /\bsed\b[^|]*i\\/ },
  { name: "grep -P (perl-regexp)", re: /\bgrep\s+-[a-zA-Z]*P[a-zA-Z]*\b|\bgrep\s+--perl-regexp\b/ },
  { name: "readlink -f (canonicalize)", re: /\breadlink\s+-[a-zA-Z]*f[a-zA-Z]*\b|\breadlink\s+--canonicalize\b/ },
  { name: "date %N (nanosecond)", re: /%N/ },
  { name: "GNU timeout cmd", re: /(^|[;&|(\s])timeout(\s+-{1,2}[^\s]+)*\s+[0-9]+[smhd]?/ },
  { name: "setsid cmd", re: /\bsetsid\b/ },
];

const GNU_ISM_CLASS_NAMES = GNU_ISM_CLASSES.map((c) => c.name);

// ── strict scripted scenario path (enumerated, like the /proc lint G4) ──
// The strict path is the shell surface reachable from run-scripted-scenario
// (scenarios/, env/, scripted-runtimes/) plus bin/daemon-control — the
// surface that EXECUTES on Darwin during the mac's bare-tier1 campaign.
// ZERO GNU-isms are tolerated there; no allowlist entry can cover it.
const STRICT_PATH_PREFIXES = ["torture-test/scenarios/", "torture-test/env/", "torture-test/scripted-runtimes/"];
const STRICT_PATH_FILES = ["torture-test/bin/daemon-control"];

/** True when the repo-root-relative path is part of the strict scripted
 *  scenario path. */
function isStrictPathFile(rel: string): boolean {
  return (
    STRICT_PATH_PREFIXES.some((p) => rel.startsWith(p)) || STRICT_PATH_FILES.includes(rel)
  );
}

// ── ALLOWLIST ─────────────────────────────────────────────────────────
// Keyed by the repo-root-relative tracked path (git ls-files form). Sorted
// by path — keep it sorted; a diff is the review surface for every future
// GNU-ism change. Each entry's `allowedClasses` names EVERY GNU-ism class
// the file legitimately carries (G5 — a NEW class in an allowlisted file
// still trips).
interface AllowEntry {
  reason: string;
  allowedClasses: string[];
}

const ALLOWLIST: Record<string, AllowEntry> = {
  // ── Linux-side-only tools / harnesses OUTSIDE the strict path ──────
  "torture-test/bin/daemon-control.test.sh": {
    reason:
      "Linux-side-only test harness for bin/daemon-control (E3.C.1): runs only on the linux campaign host as a standalone bin/*.test.sh proof battery (./run-torture-test never invokes it, so it never executes on the Darwin campaign). Its setsid usages spawn decoy listeners / CLI stand-ins in their own session+group (pgid==pid, disjoint from the test ancestry) to prove the daemon-control PID/ancestry scans — setsid is util-linux-only (no macOS equivalent).",
    allowedClasses: ["setsid cmd"],
  },
  "torture-test/bin/tt-catalog-install.test.sh": {
    reason:
      "Linux-side-only test harness for tt-catalog-install (E2.5 US-002): runs only on the linux campaign host as a standalone bin/*.test.sh proof battery (never on the Darwin campaign). The GNU-only sed -i in-place rewrite plants a deliberately stale .catalog-version.json stamp; confined to this linux-only harness (NOT the mac-reachable tt-provision-home class, which MACP5 US-004 made portable).",
    allowedClasses: ["sed -i (GNU in-place)"],
  },
  "torture-test/bin/tt-chaos.test.sh": {
    reason:
      "Linux-side-only chaos test harness: runs only on the linux campaign host (bin/*.test.sh battery, never on the Darwin campaign). setsid spawns fake harnesses in new sessions (chaos kill-ancestry tests) and readlink -f canonicalizes /proc/<pid>/cwd (linux-only procfs) — both GNU/Linux-only constructs with no macOS equivalent.",
    allowedClasses: ["setsid cmd", "readlink -f (canonicalize)"],
  },
  "torture-test/bin/tt-controller-idempotence.test.sh": {
    reason:
      "Linux-side-only controller idempotence harness: runs real stub campaigns only on the linux campaign host (bin/*.test.sh battery, never on the Darwin campaign). The GNU-only sed -i in-place rewrite plants a deliberately stale catalog stamp; confined to this linux-only harness.",
    allowedClasses: ["sed -i (GNU in-place)"],
  },
  "torture-test/bin/tt-controller.test.sh": {
    reason:
      "Linux-side-only controller test harness: runs only on the linux campaign host (bin/*.test.sh battery). setsid spawns fake harnesses in their own session to test controller kill-ancestry / hostile-process detection — util-linux-only, no macOS equivalent.",
    allowedClasses: ["setsid cmd"],
  },
  "torture-test/bin/tt-daemon-up": {
    reason:
      "Linux-side-only real-daemon preflight helper (E2.5 US-003): invoked only from real-case launches on the linux campaign host — real cells are predicate-excluded on Darwin (MACP5 US-004 reachability verdict). GNU timeout guards the /dev/tcp port probe; GNU coreutils timeout is not on macOS.",
    allowedClasses: ["GNU timeout cmd"],
  },
  "torture-test/bin/tt-daemon-up-schema.test.sh": {
    reason:
      "Linux-side-only test harness for tt-daemon-up's port-probe schema: runs only on the linux campaign host (bin/*.test.sh battery, never on the Darwin campaign). GNU timeout guards the /dev/tcp port probes — util-linux-only.",
    allowedClasses: ["GNU timeout cmd"],
  },
  "torture-test/bin/tt-daemon-up.test.sh": {
    reason:
      "Linux-side-only test harness for tt-daemon-up: runs only on the linux campaign host (bin/*.test.sh battery, never on the Darwin campaign). GNU timeout guards the /dev/tcp port probes — util-linux-only.",
    allowedClasses: ["GNU timeout cmd"],
  },
  "torture-test/bin/tt-kill-sentinel": {
    reason:
      "Linux-side-only kill-sentinel watchdog (E3.C.1): launched only from real-case cells on the linux campaign host (real cells are predicate-excluded on Darwin — MACP5 US-004 reachability verdict). date +%s%N (GNU nanosecond) seeds the sentinel token; BSD date has no %N.",
    allowedClasses: ["date %N (nanosecond)"],
  },
  "torture-test/bin/tt-recorder": {
    reason:
      "Linux-side-only recording tool: launched only from real-case cells on the linux campaign host (MACP5 US-004 reachability verdict). readlink -f canonicalizes TT_ROOT / resolves /proc/<pid>/cwd symlinks (linux-only procfs); setsid detaches the record loop into its own session — both GNU/Linux-only, no macOS equivalent.",
    allowedClasses: ["readlink -f (canonicalize)", "setsid cmd"],
  },
  "torture-test/bin/tt-recorder.test.sh": {
    reason:
      "Linux-side-only test harness for tt-recorder: runs only on the linux campaign host (bin/*.test.sh battery, never on the Darwin campaign). GNU timeout bounds waits on recorder pids (timeout 2/3/5 wait ...); readlink -f canonicalizes TT_ROOT_VAR and resolves cwd realpaths (linux-only /proc) — both GNU/Linux-only.",
    allowedClasses: ["GNU timeout cmd", "readlink -f (canonicalize)"],
  },
  "torture-test/bin/tt-run.test.sh": {
    reason:
      "Linux-side-only test harness for tt-run: runs only on the linux campaign host (bin/*.test.sh battery, never on the Darwin campaign). GNU timeout bounds the --tier2 campaign invocations (180s) — util-linux-only.",
    allowedClasses: ["GNU timeout cmd"],
  },
  "torture-test/cases/hooks/run-w0.1": {
    reason:
      "Linux-side-only case hook: tier0 case W0.1-build-unit's manifest requires platform linux (cases/tier0.jsonl requires: {platform:'linux'}), so the hook never executes on Darwin. readlink -f canonicalizes GIT_CONFIG_GLOBAL in the containment belt-and-suspenders check.",
    allowedClasses: ["readlink -f (canonicalize)"],
  },
  "torture-test/fixtures-src/tt-rust/build-golden.sh": {
    reason:
      "Linux-side-only golden fixture builder for the tt-rust case: invoked via tt-golden-bootstrap on the linux campaign host when the golden bare is absent/invalid (real rust cells are predicate-excluded on Darwin). GNU timeout guards `cargo test` (BUG-R3 hangs by design) — util-linux-only.",
    allowedClasses: ["GNU timeout cmd"],
  },
  "torture-test/oracles/self-test/run.sh": {
    reason:
      "Linux-side-only oracle self-test runner: the oracle battery runs only on the linux campaign host (never invoked by ./run-torture-test, so never on the Darwin campaign). setsid --wait isolates the watchdog / injection sub-processes in their own session (with GNU timeout as the kill-after backstop on the watchdog arm) — util-linux-only.",
    allowedClasses: ["setsid cmd"],
  },
  "torture-test/probes/tt-rust/BUG-R3/probe.sh": {
    reason:
      "Linux-side-only real-case probe for the tt-rust BUG-R3 cell: probes execute inside real-case launches, which are predicate-excluded on Darwin (MACP5 US-004 reachability verdict). GNU timeout guards `cargo test` (BUG-R3 hangs by design) — util-linux-only.",
    allowedClasses: ["GNU timeout cmd"],
  },
};

// ── the scanner ────────────────────────────────────────────────────────

interface Hit {
  line: number;
  cls: string;
}

/** Scan one shell file's content for every GNU-ism class. Returns one hit
 *  per (line, class) match. Every class scans comment- and single-quote-
 *  masked lines EXCEPT `sed i\`, which scans comment-only-masked lines (the
 *  GNU insert script is a single-quoted sed argument — the quotes are code). */
function scanContent(content: string): Hit[] {
  const hits: Hit[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const masked = maskLine(lines[i]);
    const commentMasked = maskComments(lines[i]);
    for (const cls of GNU_ISM_CLASSES) {
      const haystack = cls.name === "sed i\\ (GNU insert)" ? commentMasked : masked;
      if (cls.re.test(haystack)) hits.push({ line: i + 1, cls: cls.name });
    }
  }
  return hits;
}

// ── the gates ─────────────────────────────────────────────────────────

/** Pure integrity audit over an (allowlist, file-contents) snapshot. Returns
 *  every violation as a human-readable string; [] means GREEN. Exposed so
 *  the mutation tests can drive regressions against synthetic snapshots. */
function auditAll(
  entries: Record<string, AllowEntry>,
  contents: Record<string, string>,
): string[] {
  const violations: string[] = [];
  const rels = [...new Set([...Object.keys(contents), ...Object.keys(entries)])].sort();

  for (const rel of rels) {
    const entry = entries[rel];
    const content = contents[rel];
    if (content === undefined) {
      // G2: allowlist entry pointing outside the scanned shell surface.
      violations.push(
        `${rel}: stale ALLOWLIST entry — file is not part of the scanned shell surface`,
      );
      continue;
    }
    const hits = scanContent(content);
    if (isStrictPathFile(rel)) {
      // G3 + G4: the strict scripted scenario path must be GNU-ism-free.
      for (const h of hits) {
        violations.push(
          `${rel}:${h.line}: ${h.cls} — strict scripted scenario path (scenarios/, env/, scripted-runtimes/, bin/daemon-control) must be GNU-ism-free; NO allowlist entry can cover it`,
        );
      }
      if (entry) {
        violations.push(
          `${rel}: strict-path file must NOT have an allowlist entry (no entry can cover the strict path)`,
        );
      }
      continue;
    }
    if (hits.length === 0) {
      if (entry) {
        // G2: the entry's file no longer carries any GNU-ism — a portability
        // fix forgot to delete the now-vacuous entry.
        violations.push(
          `${rel}: stale ALLOWLIST entry — file no longer carries any GNU-ism (remove the entry)`,
        );
      }
      continue;
    }
    if (!entry) {
      // G1: a scanned non-strict file contains GNU-isms with no allowlist
      // entry (and it is not strict-path, so no G3 applies).
      violations.push(
        `${rel}: contains GNU-ism(s) (${hits.map((h) => h.cls).join(", ")}) but has no ALLOWLIST entry`,
      );
      continue;
    }
    for (const h of hits) {
      if (!entry.allowedClasses.includes(h.cls)) {
        // G5: the entry covers the file but not this class — a NEW GNU-ism
        // class in an allowlisted file must still trip.
        violations.push(
          `${rel}:${h.line}: ${h.cls} — class not covered by the ALLOWLIST entry (allowed: ${entry.allowedClasses.join(", ") || "none"})`,
        );
      }
    }
  }
  return violations;
}

/** Audit the live tree. File contents are read from disk for the scanned
 *  shell surface only — repo-relative, zero tokens, no daemon. */
function auditLiveTree(): string[] {
  const contents: Record<string, string> = {};
  for (const rel of collectShellFiles(repoRoot)) {
    const p = path.join(repoRoot, rel);
    if (fs.existsSync(p)) contents[rel] = fs.readFileSync(p, "utf8");
  }
  return auditAll(ALLOWLIST, contents);
}

/** Snapshot the live scanned shell surface (rel → content). */
function liveContents(): Record<string, string> {
  const contents: Record<string, string> = {};
  for (const rel of collectShellFiles(repoRoot)) {
    contents[rel] = fs.readFileSync(path.join(repoRoot, rel), "utf8");
  }
  return contents;
}

// ── tests ──────────────────────────────────────────────────────────────

describe("tier0 GNU-ism portability lint (MACP5 US-005)", () => {
  it("hard gate: the tracked shell surface has zero unallowlisted GNU-isms (live tree, post-US-004)", () => {
    const violations = auditLiveTree();
    assert.deepEqual(
      violations,
      [],
      `GNU-isms in the tracked shell surface:\n${violations.join("\n")}`,
    );
  });

  it("scans the tracked shell surface and excludes itself", () => {
    const files = collectShellFiles(repoRoot);
    assert.ok(
      !files.some((f) => path.basename(f) === LINT_BASENAME),
      "the lint must not scan itself (it necessarily contains the pattern literals)",
    );
    assert.ok(
      files.length > 100,
      `expected the tracked shell surface, got ${files.length} files`,
    );
    for (const rel of Object.keys(ALLOWLIST)) {
      assert.ok(files.includes(rel), `ALLOWLIST key ${rel} is not a tracked shell file`);
    }
  });

  it("the strict scripted scenario path is enumerated explicitly and is GNU-ism-free (G4 live sub-gate)", () => {
    // The strict membership is enumerated: three prefixes + one file. Dropping
    // any of them is a hard fail, and every member must be scanned + clean.
    assert.deepEqual(STRICT_PATH_PREFIXES, [
      "torture-test/scenarios/",
      "torture-test/env/",
      "torture-test/scripted-runtimes/",
    ]);
    assert.deepEqual(STRICT_PATH_FILES, ["torture-test/bin/daemon-control"]);
    const files = collectShellFiles(repoRoot);
    const strictFiles = files.filter(isStrictPathFile);
    assert.ok(
      strictFiles.length >= 10,
      `expected the strict shell surface, got ${strictFiles.length} files`,
    );
    for (const rel of strictFiles) {
      assert.ok(
        STRICT_PATH_PREFIXES.some((p) => rel.startsWith(p)) || STRICT_PATH_FILES.includes(rel),
        `unexpected strict membership: ${rel}`,
      );
    }
    const contents: Record<string, string> = {};
    for (const rel of strictFiles) contents[rel] = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    const violations = auditAll({}, contents); // no allowlist can cover the strict path
    assert.deepEqual(
      violations,
      [],
      `strict scripted scenario path has GNU-isms:\n${violations.join("\n")}`,
    );
  });

  it("MUTATION: flags every GNU-ism class in a synthetic temp shell file", () => {
    const cases: Array<[string, string]> = [
      ["sed -i (GNU in-place)", 'sed -i "s/x/y/" file\n'],
      ["sed i\\ (GNU insert)", "sed '3i\\hello' file\n"],
      ["grep -P (perl-regexp)", 'grep -P "\\d+" file\n'],
      ["readlink -f (canonicalize)", 'x="$(readlink -f "$PWD")"\n'],
      ["date %N (nanosecond)", 'tok="$(date +%s%N)"\n'],
      ["GNU timeout cmd", "timeout 15 cargo test\n"],
      ["setsid cmd", "setsid --wait bash run.sh &\n"],
    ];
    for (const [cls, snippet] of cases) {
      const hits = scanContent(snippet);
      assert.ok(
        hits.some((h) => h.cls === cls),
        `class ${cls} must be flagged in ${JSON.stringify(snippet)}, got: ${JSON.stringify(hits)}`,
      );
    }
  });

  it("POSITIVE PIN: comments, single quotes, --timeout flags, variables and portable forms are NOT flagged", () => {
    const snippet = [
      "#!/usr/bin/env bash",
      "# sed -i and grep -P are GNU-only; readlink -f needs a mac fallback",
      "# date +%s%N is GNU; timeout 5 cmd is GNU coreutils; setsid is linux-only",
      "grep -Fc 'sed -i' file || true",
      "node --test --timeout 30000",
      "prog --timeout=5",
      "timeout_ms=500",
      'x="$(date +%s)"',
      'y="$(readlink "$PWD")"',
      "grep -p pattern file",
      "echo 'timeout 5 cmd'",
      "",
    ].join("\n");
    assert.deepEqual(
      scanContent(snippet),
      [],
      `comments/flags/variables/portable forms must stay green: ${JSON.stringify(scanContent(snippet))}`,
    );
  });

  it("POSITIVE PIN: BSD-portable `sed -i.bak` suffix form is NOT flagged", () => {
    const snippet = 'sed -i.bak "s/x/y/" "$STAMP"\n';
    assert.deepEqual(scanContent(snippet), [], "sed -i.bak is portable (BSD + GNU) and must not trip the GNU -i class");
  });

  it("POSITIVE PIN: `sed i\\` mentioned in a comment is NOT flagged (comment-only masking)", () => {
    const snippet = [
      "#!/usr/bin/env bash",
      "# GNU insert form: sed '3i\\text' file — do not use on Darwin",
      "sed -n '1,3p' file # the i\\ command is GNU-only",
      "",
    ].join("\n");
    assert.deepEqual(
      scanContent(snippet),
      [],
      `a comment mentioning sed i\\ must not trip the insert class: ${JSON.stringify(scanContent(snippet))}`,
    );
  });

  it("MUTATION: a GNU-ism added under env/ trips the strict gate even with an allowlist entry (strict-path escape)", () => {
    const contents = liveContents();
    const target = "torture-test/env/tt-env.sh";
    assert.ok(target in contents, "env/tt-env.sh must be in the scanned shell surface");
    contents[target] += "\n# MUTATION: strict-path escape\nsed -i 's/x/y/' file\n";
    // Even an allowlist entry FOR THE TARGET ITSELF cannot cover the strict
    // path — the zero-tolerance gate fires regardless.
    const entries = {
      ...ALLOWLIST,
      [target]: {
        reason: "MUTATION: bogus strict-path entry — must be rejected by G3/G4",
        allowedClasses: ["sed -i (GNU in-place)"],
      },
    };
    const violations = auditAll(entries, contents);
    assert.ok(
      violations.some((v) => v.includes(target) && v.includes("strict scripted scenario path")),
      `strict-path escape must trip the zero-tolerance gate, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: an allowlist entry for a strict-path file is rejected outright (G4)", () => {
    const contents = liveContents();
    const entries = {
      ...ALLOWLIST,
      "torture-test/scenarios/lib/run-scripted-scenario": {
        reason: "MUTATION: bogus strict-path entry",
        allowedClasses: [],
      },
    };
    const violations = auditAll(entries, contents);
    assert.ok(
      violations.some((v) => v.includes("scenarios/lib/run-scripted-scenario") && v.includes("must NOT have an allowlist entry")),
      `a strict-path entry must be rejected, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: a NEW GNU-ism class in an allowlisted file trips the class-coverage gate (G5)", () => {
    const contents = liveContents();
    const target = "torture-test/bin/tt-kill-sentinel"; // allowlisted for date %N only
    contents[target] += '\ngrep -P "\\d+" file\n';
    const violations = auditAll(ALLOWLIST, contents);
    assert.ok(
      violations.some((v) => v.includes(target) && v.includes("not covered by the ALLOWLIST entry")),
      `a new class in an allowlisted file must trip G5, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: dropping an allowlist entry trips the coverage gate (G1)", () => {
    const contents = liveContents();
    const entries = { ...ALLOWLIST };
    delete entries["torture-test/bin/tt-kill-sentinel"];
    const violations = auditAll(entries, contents);
    assert.ok(
      violations.some((v) => v.includes("torture-test/bin/tt-kill-sentinel") && v.includes("no ALLOWLIST entry")),
      `dropping the tt-kill-sentinel entry must trip G1, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: a stale allowlist entry (GNU-isms removed) trips staleness (G2)", () => {
    const contents = liveContents();
    const fixed = { ...contents };
    // Simulate a future portability fix that removes tt-kill-sentinel's %N
    // token but forgets to delete the now-vacuous allowlist entry.
    fixed["torture-test/bin/tt-kill-sentinel"] = contents["torture-test/bin/tt-kill-sentinel"].replace(
      /date \+%s%N/g,
      "date +%s",
    );
    const violations = auditAll(ALLOWLIST, fixed);
    assert.ok(
      violations.some((v) => v.includes("torture-test/bin/tt-kill-sentinel") && v.includes("stale")),
      `a GNU-ism-removed file must trip G2, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: the pre-US-004 tree's GNU-isms are exactly what the lint flags (synthetic red proof)", () => {
    // Self-contained red-then-green documentation arm (MACP5.1): the ACTUAL
    // pre-US-004 files carried the mac's GNU-isms — install-scenario-workflows
    // line 90's `sed -i` id rewrite and daemon-control line 1579's `grep -oP`
    // pid extraction. The pre-fix snippets are reproduced inline here (NOT
    // materialized from git history: the US-004 commit exists only on the
    // authoring branch and is unreachable on merged main, so any git-log
    // resolution would break on a main checkout). The live tree (post-US-004)
    // is asserted green by the hard gate above.
    const preFixInstaller = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'sed -i "s/^id: ${BASE_WORKFLOW}[[:space:]]*$/id: ${NEW_ID}/" "$YML"',
      "",
    ].join("\n");
    assert.ok(
      preFixInstaller.includes("sed -i "),
      "the pre-fix installer snippet must contain the GNU-only sed -i rewrite",
    );
    const installerHits = scanContent(preFixInstaller);
    assert.ok(
      installerHits.some((h) => h.cls === "sed -i (GNU in-place)"),
      `the pre-fix installer's sed -i must be flagged, got: ${JSON.stringify(installerHits)}`,
    );

    const preFixDaemonControl = [
      'lingering_pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP \'pid=\\K[0-9]+\' | head -1 || true)',
      "",
    ].join("\n");
    assert.ok(
      preFixDaemonControl.includes("grep -oP"),
      "the pre-fix daemon-control snippet must contain the GNU grep perl-regex form",
    );
    const dcHits = scanContent(preFixDaemonControl);
    assert.ok(
      dcHits.some((h) => h.cls === "grep -P (perl-regexp)"),
      `the pre-fix daemon-control's grep -oP must be flagged, got: ${JSON.stringify(dcHits)}`,
    );
  });

  it("allowlist entries are structurally sound and cover only linux-side-only files outside the strict path", () => {
    const files = collectShellFiles(repoRoot);
    assert.ok(Object.keys(ALLOWLIST).length >= 14, `expected a populated allowlist, got ${Object.keys(ALLOWLIST).length} entries`);
    for (const [rel, entry] of Object.entries(ALLOWLIST)) {
      assert.ok(files.includes(rel), `${rel} must be a tracked shell file`);
      assert.ok(!isStrictPathFile(rel), `${rel} is in the strict path and must NOT be allowlisted`);
      assert.ok(entry.reason.length > 40, `${rel} needs a real reason (got ${entry.reason.length} chars)`);
      assert.match(
        entry.reason,
        /linux|Linux/,
        `${rel} reason must document why the file is linux-side-only`,
      );
      for (const cls of entry.allowedClasses) {
        assert.ok(
          GNU_ISM_CLASS_NAMES.includes(cls),
          `${rel} allows unknown class '${cls}' — it must be one of ${GNU_ISM_CLASS_NAMES.join(", ")}`,
        );
      }
      // Every class the file actually carries must be covered by the entry.
      const hits = scanContent(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
      const hitClasses = new Set(hits.map((h) => h.cls));
      assert.ok(hitClasses.size > 0, `${rel} has an allowlist entry but no GNU-ism hits (stale)`);
      for (const cls of hitClasses) {
        assert.ok(
          entry.allowedClasses.includes(cls),
          `${rel} carries ${cls} but its entry does not allow it (allowed: ${entry.allowedClasses.join(", ") || "none"})`,
        );
      }
    }
  });
});
