// MACP5.1 — history-independent lint red-arms meta-lint (hard gate).
//
// The tier0/tier1 red-then-green "documentation" arms used to materialize the
// pre-fix tree by resolving MACP5/MACP3 story commits from git history
// (`git log -1 --format=%H --grep=<message>` then `git show <sha>~1:<path>`),
// plus a hardcoded authoring-branch SHA (`git show dafa40a7:<path>` in
// tier1-bare-vacuity-red-green). The finalize-merge machinery lands ONE
// squashed commit on main, so those commits exist only on the authoring
// branch — every such test broke on any checkout without the branch (merged
// main, fresh clones, the mac's bare-tier1 campaign). This meta-lint locks
// the class: it scans every self-test (.test.ts) for history-dependent commit
// resolution and fails on:
//   R1  message-based resolution — `git log`/`git rev-list` with `--grep=`
//       (including the spawnSync array form `"--grep=<message>"`).
//   R2  parent-rev resolution — a `<rev>~N:` argument (`git show <sha>~1:path`).
//   R3  hardcoded hex SHAs passed to `git show` (`git show <sha>:path`,
//       `["show", "<sha>:path"]`).
//   R4  a non-HEAD `<rev>:<path>` argument passed to `git show` (catches the
//       `${var}:${path}` template form whose rev is a literal-SHA constant).
// The scan is comment- and single-quote-masked (TS-aware: `//`, `/* */` and
// single-quoted literals are documentation — a comment MAY mention these
// patterns). Double-quoted strings and template literals are preserved: real
// git invocations and rev arguments live there. The lint self-excludes its
// own source (it necessarily contains the pattern literals) — the same
// convention as tier0-bash32-compat-lint / tier0-gnu-portability-lint /
// tier0-procfs-portability-lint.
//
// ── Legitimately history-based tests (documented, exempt) ───────────
//   * tier1-final-acceptance / tier1-w2-predicate-narrow /
//     tier2-repeatability: merge-base diff-confinement pins
//     (`git merge-base HEAD main` → `git show ${base}:...`). They degrade
//     gracefully: on merged main base==HEAD, so the confinement is trivially
//     true. Exempted by filename; each is asserted to still use `merge-base`
//     so an orphaned exemption is a hard fail (staleness guard below).
//   * scripted-runtime-fork: FROZEN_SHA `git merge-base --is-ancestor`
//     check — the recorded SHA is read from a file and must be an ancestor
//     of HEAD; content/HEAD-based, touches no rule above.
//   * HEAD-based extraction (`git show HEAD:<path>`, `git ls-tree HEAD`) —
//     content-based, fine (the HEAD prefix is exempted by R3/R4).
//
// Picked up by self-tests/run.sh's `tier0-*.test.ts` glob — no run.sh edit.
// Zero tokens; confined to torture-test/; the live 33xx daemon is never
// touched.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const SELF_TESTS_DIR = path.join(repoRoot, "torture-test", "self-tests");
const LINT_BASENAME = "tier0-history-independent-red-arms.test.ts";

// ── TS-aware line masking ─────────────────────────────────────────────
// Comments (`//` tails, `/* ... */` spans) and single-quoted literals are
// replaced by spaces (positions preserved) — documentation mentions of the
// patterns must not trip. Double-quoted strings and template literals are
// preserved: real git invocations and rev arguments live there.
function maskTsLine(line: string): string {
  const out: string[] = new Array<string>(line.length).fill("");
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let inBlock = false;
  let prev = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (inBlock) {
      out[i] = " ";
      if (ch === "*" && next === "/") {
        out[i + 1] = " ";
        i++;
        inBlock = false;
      }
      prev = ch;
      continue;
    }
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
    if (inTemplate) {
      out[i] = ch;
      if (ch === "\\") {
        if (i + 1 < line.length) {
          out[i + 1] = line[i + 1];
          i++;
        }
      } else if (ch === "`") {
        inTemplate = false;
      }
      prev = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      for (let j = i; j < line.length; j++) out[j] = " ";
      break;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      out[i] = " ";
      out[i + 1] = " ";
      i++;
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
    if (ch === "`") {
      inTemplate = true;
      out[i] = ch;
      prev = ch;
      continue;
    }
    out[i] = ch;
    prev = ch;
  }
  return out.join("");
}

// ── the rules ─────────────────────────────────────────────────────────

interface MetaRule {
  name: string;
  re: RegExp;
}

const META_RULES: MetaRule[] = [
  {
    name: "message-based commit resolution (git log/rev-list --grep=)",
    // Both the single-line form (`git log ... --grep=`) and the spawnSync
    // array form (`"--grep=<message>"`).
    re: /git\s+(?:log|rev-list)\b[^\n]*--grep\s*=|["']--grep\s*=/,
  },
  {
    name: "parent-rev resolution (<rev>~N: in a git rev argument)",
    // The `<rev>~N:` signature is unambiguous (a comment-only `~N` like
    // "~10s" or "~300ms" has no colon and is masked anyway).
    re: /~[0-9]+\s*:/,
  },
  {
    name: "hardcoded hex SHA passed to git show",
    re: /git\s+show\b(?!\s*HEAD\b)[^\n]{0,80}?[0-9a-f]{7,40}\b|["']show["']\s*,\s*["'`](?!\s*HEAD\b)[0-9a-f]{7,40}\b/,
  },
  {
    name: "non-HEAD rev:path argument passed to git show",
    // Catches `["show", `${COMMIT}:${PATH}`]` — the rev is a variable holding
    // a literal SHA (the dafa40a7 class). HEAD:path is exempt; parent-rev
    // HEAD~N: forms are already caught by R2.
    re: /["']show["']\s*,\s*["'`](?!\s*HEAD\b)[^"'`]*:/,
  },
];

// ── legitimately history-based files (documented, exempt) ────────────
// merge-base diff-confinement pins: `git merge-base HEAD main` then
// `git show ${base}:...`. They degrade gracefully on merged main
// (base==HEAD ⇒ trivially confined). The staleness guard below asserts each
// exempt file still uses `merge-base`, so a conversion that removes the
// merge-base usage must also drop the exemption.
const HISTORY_BASED_EXEMPT: Record<string, string> = {
  "tier1-final-acceptance.test.ts":
    "merge-base diff-confinement pin (git merge-base HEAD main → git show ${base}:...); degrades gracefully on merged main (base==HEAD)",
  "tier1-w2-predicate-narrow.test.ts":
    "merge-base diff-confinement pin; degrades gracefully on merged main (base==HEAD)",
  "tier2-repeatability.test.ts":
    "merge-base diff-confinement pin; degrades gracefully on merged main (base==HEAD)",
};

// ── the scanner ───────────────────────────────────────────────────────

interface Violation {
  file: string;
  line: number;
  rule: string;
}

/** Scan one file's content for every rule. Returns one violation per
 *  (line, rule) match on comment- and single-quote-masked lines. Pure — the
 *  mutation tests drive regressions against synthetic offender content. */
function scanContent(content: string): Violation[] {
  const violations: Violation[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const masked = maskTsLine(lines[i]);
    for (const rule of META_RULES) {
      if (rule.re.test(masked)) violations.push({ line: i + 1, rule: rule.name });
    }
  }
  return violations;
}

/** Scan every self-test (except this lint's own source and the documented
 *  merge-base exemption files) for history-dependent commit resolution. */
function scanSelfTests(): Violation[] {
  const violations: Violation[] = [];
  const files = fs.readdirSync(SELF_TESTS_DIR).filter((f) => f.endsWith(".test.ts")).sort();
  for (const file of files) {
    if (file === LINT_BASENAME) continue; // self-exclusion (pattern literals)
    if (file in HISTORY_BASED_EXEMPT) continue; // documented, exempt
    const src = fs.readFileSync(path.join(SELF_TESTS_DIR, file), "utf8");
    for (const v of scanContent(src)) {
      violations.push({ file, line: v.line, rule: v.rule });
    }
  }
  return violations;
}

// ── tests ─────────────────────────────────────────────────────────────

describe("tier0 history-independent red-arms meta-lint (MACP5.1)", () => {
  it("hard gate: no self-test resolves commits from git history (live tree)", () => {
    const violations = scanSelfTests();
    assert.deepEqual(
      violations,
      [],
      `history-dependent commit resolution in self-tests:\n${violations
        .map((v) => `${v.file}:${v.line}: ${v.rule}`)
        .join("\n") || "(none)"}`,
    );
  });

  it("MUTATION: flags every history-dependent form in a synthetic offender file", () => {
    const offenders: Array<[string, string]> = [
      [
        "message-based resolution (single-line)",
        'const sha = execSync("git log -1 --format=%H --grep=US-004 - GNU-ism sweep fixes");',
      ],
      [
        "message-based resolution (spawnSync array form)",
        'spawnSync("git", ["log", "-1", "--format=%H", "--grep=US-002 - run-scripted-scenario"]);',
      ],
      [
        "parent-rev resolution",
        'const pre = execSync(`git show ${us004Commit}~1:torture-test/scripted-runtimes/install-scenario-workflows`);',
      ],
      [
        "hardcoded hex SHA passed to git show (single-line)",
        'const pre = execSync("git show dafa40a7:torture-test/bin/tt-report.mjs");',
      ],
      [
        "hardcoded hex SHA passed to git show (array form)",
        'spawnSync("git", ["show", "7104e5ff:torture-test/scenarios/lib/run-scripted-scenario"]);',
      ],
      [
        "non-HEAD rev:path via a literal-SHA constant",
        'const hist = run("git", ["show", `${LEGACY_SOURCE_COMMIT}:${LEGACY_SOURCE_PATH}`], process.env);',
      ],
    ];
    for (const [name, line] of offenders) {
      const violations = scanContent(line);
      assert.ok(
        violations.length > 0,
        `synthetic offender '${name}' must be flagged, got none for: ${line}`,
      );
    }
  });

  it("POSITIVE PIN: HEAD-based extraction, merge-base usage and comment mentions are NOT flagged", () => {
    const snippet = [
      'const head = execSync("git show HEAD:torture-test/bin/tt-report.mjs");',
      'const base = execSync("git merge-base HEAD main");',
      'execSync("git merge-base --is-ancestor ${recorded} HEAD");',
      'const m = execSync(`git show ${base}:torture-test/bin/tt-hygiene-canary.mjs`);',
      'run("git", ["-C", clone, "show", "HEAD:src/pre-commit-amend.marker.txt"]);',
      "// comment: git show dafa40a7:path, git log --grep=US-004, ~1: forms are documentation",
      "/* block comment: git show <pre-fix-commit>:torture-test/bin/daemon-control */",
      "echo 'single-quoted --grep= dafa40a7:path ~1: mention'",
      'assert.equal(head.status, 0, `git show HEAD: build-golden.sh failed: ${head.stderr}`);',
      'fs.writeFileSync(shaBackup, "0000000000000000000000000000000000000000");',
      "",
    ].join("\n");
    assert.deepEqual(
      scanContent(snippet),
      [],
      `HEAD/merge-base/comment forms must stay green: ${JSON.stringify(scanContent(snippet))}`,
    );
  });

  it("documented history-based exemptions still use merge-base (staleness guard)", () => {
    for (const [file, why] of Object.entries(HISTORY_BASED_EXEMPT)) {
      const abs = path.join(SELF_TESTS_DIR, file);
      assert.ok(fs.existsSync(abs), `${file}: exemption file missing (${why})`);
      const src = fs.readFileSync(abs, "utf8");
      assert.ok(
        /merge-base/.test(src),
        `${file}: exemption requires merge-base usage but none found — drop the exemption (${why})`,
      );
    }
  });
});
