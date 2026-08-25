// MACP6 US-003 — machine-specific home-literal portability lint (hard gate).
//
// The mac's W2 scripted cells instant-failed in ~49ms because the scripted
// shims (torture-test/scripted-runtimes/bin/scripted-pi, scripted-hermes)
// defaulted NODE_BIN to a hardcoded, machine-specific linux volta path
// (`/home/<user>/.volta/tools/image/node/<ver>/bin/node` — "discovered at
// build time"), which does not exist on the mac (nix node). MACP6 US-001
// removed every such literal from the shims; this lint scans the tracked
// torture-test SHELL surface and fails on any absolute /home/<user>/ or
// /Users/<user>/ literal so a linux-volta-host path can never be
// reintroduced and break the mac.
//
// ── Scan surface ─────────────────────────────────────────────────────
//   * Tracked files under torture-test/ (git ls-files — hermetic, no walk
//     of generated state): `.sh` extension OR a bash shebang on the first
//     line, excluding this lint's own source file (same self-exclusion
//     convention as tier0-bash32-compat-lint / tier0-gnu-portability-lint).
//     Generated state (var/, results/, node_modules/) is never committed,
//     so it never appears in git ls-files.
//   * The scan is comment- and single-quote-aware (maskLine, the
//     tier0-bash32-compat-lint convention): a `#` comment or a
//     single-quoted literal may mention a pattern (documentation, not
//     code); double-quoted content IS scanned because real commands live
//     inside double quotes.
//
// ── Pattern (the MACP6 US-001 defect class) ──────────────────────────
//   * /home/<user>/... and /Users/<user>/... where <user> is a bare
//     username (`[A-Za-z0-9._-]+`). The literal must be ABSOLUTE: the
//     `/home` or `/Users` path segment must NOT be preceded by a path
//     character (alphanumeric, `_`, `.`, `/`, `-`) — this is the
//     substring-coincidence exclusion, the same design decision as the
//     procfs-portability lint's '/process' ≠ procfs-mount rule. The
//     contained test home is a RELATIVE path segment —
//     `$TT_VAR/home/.tamandua/...` (the 'home' DIRECTORY under the test's
//     var area, never a machine home) and `/var/home/...` — so it must
//     never count as a hit (and an allowlist entry for a coincidence-only
//     file would be STALE under G2).
//   * The user component is a bare word, so the PORTABLE dynamic
//     resolutions never match: `$(id -un)` / `$USER` contain `$`/`(`/`)`
//     — not username chars — keeping the Darwin home resolution
//     `dscl . -read "/Users/$(id -un)" ...` and the linux
//     `ACCOUNT_HOME="${ACCOUNT_HOME:-/home/$(id -un)}"` green.
//   * A following path separator or end-of-line is required after the user
//     component (`(\/|$)`), so `$HOME`-style variables never match and a
//     bare `/home/user` mid-string without a following separator is not a
//     directory reference.
//
// ── Gates (a violation in any gate fails the suite) ─────────────────
//   G1 Coverage:    a scanned shell file with home-literal hits must have
//                   an ALLOWLIST entry. (Catches NEW machine-specific
//                   home literals.)
//   G2 Staleness:   every ALLOWLIST entry must reference a scanned shell
//                   file that still carries home-literal hits. (Catches
//                   entries orphaned by a portability fix — a stale entry
//                   silently disables linting for a file.)
//   Hard gate:      the live tree must be GREEN — after US-001/002 no
//                   machine-specific home literal remains in the shell
//                   surface. The ALLOWLIST is therefore intentionally
//                   EMPTY on the live tree (asserted below); any future
//                   legitimate use must be added as a sorted, reviewed
//                   entry with a reason, exactly like the GNU-ism lint.
//
// ── Red-then-green (MACP5.1 convention: SYNTHETIC fixtures only) ─────
//   * RED: a temp shell file containing '/home/fakeuser/' and one
//     containing '/Users/fakeuser/' are each flagged with the expected
//     finding.
//   * GREEN: the real tracked tree (hard gate); comment-only or
//     single-quoted mentions of /home/<user> are masked (not flagged); a
//     clean file is not flagged.
//   * NO commit-history resolution (git-log / git-archive style) anywhere —
//     the red arms are fully self-contained (the MACP5.1 history-
//     independence contract); the lint's own file is self-excluded.
//
// Picked up by self-tests/run.sh's `tier0-*.test.ts` glob — no run.sh edit.
// Zero tokens; confined to torture-test/; the live 33xx daemon is never
// touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const LINT_BASENAME = "tier0-home-literal-portability-lint.test.ts";

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

// ── home-literal pattern classes (the MACP6 US-001 defect class) ────────

interface HomeLiteralClass {
  name: string;
  re: RegExp;
}

/** Each class is applied to a comment-masked line. The user component is a
 *  bare username (`[A-Za-z0-9._-]+`) — `$`/`(`/`)`/space are NOT username
 *  chars, so the portable dynamic resolutions (`/home/$(id -un)`,
 *  `/Users/$(id -un)`, `$HOME`-style variables) never match. Group 2
 *  captures the matched home path (e.g. `/home/fakeuser/`) for the finding
 *  text. The leading `(^|[^A-Za-z0-9_./-])` boundary requires the `/home` /
 *  `/Users` segment to start an ABSOLUTE path — `var/home/.tamandua` (the
 *  contained test home) and `/var/home/...` are substring coincidences and
 *  must never count as hits. */
const HOME_LITERAL_CLASSES: HomeLiteralClass[] = [
  {
    name: "/home/<user> literal",
    re: /(^|[^A-Za-z0-9_./-])(\/home\/[A-Za-z0-9._-]+(\/|$))/,
  },
  {
    name: "/Users/<user> literal",
    re: /(^|[^A-Za-z0-9_./-])(\/Users\/[A-Za-z0-9._-]+(\/|$))/,
  },
];

const HOME_LITERAL_CLASS_NAMES = HOME_LITERAL_CLASSES.map((c) => c.name);

// ── ALLOWLIST ─────────────────────────────────────────────────────────
// Keyed by the repo-root-relative tracked shell path (git ls-files form,
// matching collectShellFiles). Sorted by path — keep it sorted; a diff is
// the review surface for every future home-literal change. There is no
// per-class granularity: EVERY machine-specific home literal is a
// portability violation, so an entry documents a reviewed, legitimate use
// of an absolute home path (the reason must say why the path is
// legitimate and never executes on Darwin). The list is intentionally
// EMPTY on the live tree — after US-001/002 no such literal remains.
interface AllowEntry {
  reason: string;
}

const ALLOWLIST: Record<string, AllowEntry> = {
  // Intentionally empty: the tracked shell surface has ZERO machine-specific
  // home literals (asserted by the hard gate and by the dedicated test
  // below). Any future legitimate use must be added here as a sorted,
  // reviewed entry with a reason.
};

// ── the scanner ────────────────────────────────────────────────────────

interface Hit {
  line: number;
  cls: string;
  /** The matched home path, e.g. `/home/fakeuser/`. */
  literal: string;
}

/** Scan one shell file's content for every home-literal class on
 *  comment-masked lines. Returns one hit per (line, class) match. */
function scanContent(content: string): Hit[] {
  const hits: Hit[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const masked = maskLine(lines[i]);
    for (const cls of HOME_LITERAL_CLASSES) {
      const m = cls.re.exec(masked);
      if (m) hits.push({ line: i + 1, cls: cls.name, literal: m[2] });
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
    if (hits.length === 0) {
      if (entry) {
        // G2: the entry's file no longer carries any home literal — a
        // portability fix forgot to delete the now-vacuous entry.
        violations.push(
          `${rel}: stale ALLOWLIST entry — file no longer carries a machine-specific home literal (remove the entry)`,
        );
      }
      continue;
    }
    if (!entry) {
      // G1: a scanned shell file contains a machine-specific home literal
      // with no allowlist entry.
      for (const h of hits) {
        violations.push(
          `${rel}:${h.line}: machine-specific absolute home literal '${h.literal}' (${h.cls}) — use a portable resolution ($HOME, $(id -un), or TT_NODE_BIN / command -v node for node binaries); has no ALLOWLIST entry (add one only for a documented, reviewed legitimate use)`,
        );
      }
      continue;
    }
    // Allowlisted: the file's home literals are documented/reviewed — but
    // the entry must name a real reason.
    if (entry.reason.length === 0) {
      violations.push(`${rel}: ALLOWLIST entry needs a real reason`);
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

describe("tier0 home-literal portability lint (MACP6 US-003)", () => {
  it("hard gate: the tracked shell surface has zero machine-specific home literals (live tree, post-US-001/002)", () => {
    const violations = auditLiveTree();
    assert.deepEqual(
      violations,
      [],
      `machine-specific home literals in the tracked shell surface:\n${violations.join("\n")}`,
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

  it("the ALLOWLIST is intentionally empty on the live tree (sorted; every future entry is a reviewed diff)", () => {
    // After US-001/002 no machine-specific home literal remains in the
    // tracked shell surface, so no legitimate use exists to allowlist. Any
    // future entry is a reviewed, documented diff — never silent.
    assert.deepEqual(
      Object.keys(ALLOWLIST),
      [],
      "no legitimate machine-specific home literal exists in the tracked shell surface; add an entry with a reason ONLY for a documented, reviewed legitimate use",
    );
  });

  it("RED (synthetic fixture): a temp shell file containing '/home/fakeuser/' is flagged with the expected finding", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "macp6-home-literal-"));
    try {
      const p = path.join(tmp, "red-home.sh");
      fs.writeFileSync(
        p,
        "#!/usr/bin/env bash\nNODE_BIN=\"/home/fakeuser/.volta/tools/image/node/24.18.0/bin/node\"\n",
      );
      const hits = scanContent(fs.readFileSync(p, "utf8"));
      const homeHits = hits.filter((h) => h.cls === "/home/<user> literal");
      assert.equal(
        homeHits.length,
        1,
        `the /home/fakeuser/ literal must be flagged exactly once, got: ${JSON.stringify(hits)}`,
      );
      assert.equal(
        homeHits[0].literal,
        "/home/fakeuser/",
        "the finding must name the machine-specific home path",
      );
      assert.equal(homeHits[0].line, 2, "the finding must carry the line number");
      // The full audit view (G1) reports the same file as a violation.
      const violations = auditAll({}, { "tmp/red-home.sh": fs.readFileSync(p, "utf8") });
      assert.ok(
        violations.some((v) => v.includes("tmp/red-home.sh") && v.includes("/home/fakeuser/") && v.includes("no ALLOWLIST entry")),
        `expected a G1 violation for the synthetic fixture, got:\n${violations.join("\n") || "(none)"}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("RED (synthetic fixture): a temp shell file containing '/Users/fakeuser/' is flagged with the expected finding", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "macp6-home-literal-"));
    try {
      const p = path.join(tmp, "red-users.sh");
      fs.writeFileSync(
        p,
        "#!/usr/bin/env bash\npw_home=\"/Users/fakeuser/whatever\"\n",
      );
      const hits = scanContent(fs.readFileSync(p, "utf8"));
      const usersHits = hits.filter((h) => h.cls === "/Users/<user> literal");
      assert.equal(
        usersHits.length,
        1,
        `the /Users/fakeuser/ literal must be flagged exactly once, got: ${JSON.stringify(hits)}`,
      );
      assert.equal(
        usersHits[0].literal,
        "/Users/fakeuser/",
        "the finding must name the machine-specific home path",
      );
      assert.equal(usersHits[0].line, 2, "the finding must carry the line number");
      // The full audit view (G1) reports the same file as a violation.
      const violations = auditAll({}, { "tmp/red-users.sh": fs.readFileSync(p, "utf8") });
      assert.ok(
        violations.some((v) => v.includes("tmp/red-users.sh") && v.includes("/Users/fakeuser/") && v.includes("no ALLOWLIST entry")),
        `expected a G1 violation for the synthetic fixture, got:\n${violations.join("\n") || "(none)"}`,
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("POSITIVE PIN: comment-only and single-quoted mentions of /home/<user> are NOT flagged (masking)", () => {
    const snippet = [
      "#!/usr/bin/env bash",
      "# never hardcode /home/fakeuser/ or /Users/fakeuser/ — use $HOME (MACP6 US-003)",
      "echo '/home/fakeuser/.volta/bin/node is machine-specific'",
      "echo '/Users/fakeuser/bin/node is machine-specific'",
      "# the comment tail masks this too: x=/home/fakeuser/",
      "",
    ].join("\n");
    assert.deepEqual(
      scanContent(snippet),
      [],
      `comment/single-quoted mentions must stay green: ${JSON.stringify(scanContent(snippet))}`,
    );
  });

  it("POSITIVE PIN: portable dynamic home resolutions are NOT flagged", () => {
    // The live portable forms: Darwin dscl + $(id -un), linux /home/$(id -un),
    // the contained test home var/home/.tamandua, and $HOME-style variables.
    const snippet = [
      "#!/usr/bin/env bash",
      'pw_home="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null || true)"',
      'ACCOUNT_HOME="${ACCOUNT_HOME:-/home/$(id -un)}"',
      'STAMP="$TT_VAR/home/.tamandua/workflows/.catalog-version.json"',
      'echo "workflows live under torture-test/var/home/.tamandua/workflows"',
      'printf \'%s\\n\' "/home/$(id -un)"',
      'x="$HOME/foo"',
      "",
    ].join("\n");
    assert.deepEqual(
      scanContent(snippet),
      [],
      `portable dynamic home resolutions must stay green: ${JSON.stringify(scanContent(snippet))}`,
    );
  });

  it("POSITIVE PIN: a clean file is not flagged", () => {
    const snippet = [
      "#!/usr/bin/env bash",
      'node_bin="${TT_NODE_BIN:-$(command -v node)}"',
      'exec "$node_bin" runtime.mjs "$@"',
      "",
    ].join("\n");
    assert.deepEqual(scanContent(snippet), [], "a clean file must not be flagged");
  });

  it("MUTATION: a NEW machine-specific home literal in a currently-clean file trips G1 (no allowlist entry)", () => {
    // Simulate a future regression: a tracked shell file that today has no
    // home literal gains a hardcoded volta-style node path and is NOT
    // allowlisted.
    const cleanFiles = collectShellFiles(repoRoot).filter(
      (rel) => scanContent(fs.readFileSync(path.join(repoRoot, rel), "utf8")).length === 0,
    );
    assert.ok(cleanFiles.length > 0, "need at least one currently-clean scanned file for the mutation");
    const target = cleanFiles[0];
    const contents = liveContents();
    contents[target] += '\n# MUTATION (hardcoded home path)\nNODE_BIN="/home/fakeuser/.volta/bin/node"\n';
    const violations = auditAll(ALLOWLIST, contents);
    assert.ok(
      violations.some((v) => v.includes(target) && v.includes("no ALLOWLIST entry")),
      `expected a G1 violation for ${target}, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: a stale allowlist entry (home literals removed) trips G2", () => {
    // Take a real scanned shell file with no home literals and give it a
    // bogus allowlist entry — the entry must be reported stale.
    const contents = liveContents();
    const staleTarget = Object.keys(contents).find(
      (rel) => scanContent(contents[rel]).length === 0,
    );
    assert.ok(staleTarget, "need a scanned shell file with no home literals for the mutation");
    const violations = auditAll(
      { [staleTarget]: { reason: "MUTATION: bogus entry — the file has no home literals" } },
      contents,
    );
    assert.ok(
      violations.some((v) => v.includes(staleTarget) && v.includes("stale")),
      `a home-literal-free file with an entry must trip G2, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: an allowlist entry outside the scanned shell surface trips G2", () => {
    const contents = liveContents();
    const violations = auditAll(
      {
        "torture-test/impl-tasks/MACP6-portable-shim-node-resolution.md": {
          reason: "MUTATION: .md is not part of the shell surface",
        },
      },
      contents,
    );
    assert.ok(
      violations.some(
        (v) =>
          v.includes("MACP6-portable-shim-node-resolution.md") &&
          v.includes("not part of the scanned shell surface"),
      ),
      `an entry outside the shell surface must trip G2, got:\n${violations.join("\n") || "(none)"}`,
    );
  });

  it("the pattern classes are structurally sound (both names resolve, both arms fire on their canonical literal)", () => {
    assert.deepEqual(HOME_LITERAL_CLASS_NAMES, ["/home/<user> literal", "/Users/<user> literal"]);
    const canonical = [
      'NODE_BIN="/home/fakeuser/.volta/bin/node"',
      'pw_home="/Users/fakeuser/whatever"',
    ].join("\n");
    const hits = scanContent(canonical);
    assert.equal(hits.length, 2, `both canonical literals must fire, got: ${JSON.stringify(hits)}`);
  });
});
