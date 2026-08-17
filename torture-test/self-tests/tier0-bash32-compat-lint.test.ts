// MACP1 US-010 — bash-3.2 compatibility lint (hard gate).
//
// macOS ships /bin/bash 3.2.57, which lacks the bash-4+ feature classes that
// this lint greps the tracked shell surface under torture-test/ for:
//   1. `declare -A` associative arrays            -> parallel arrays / case tables
//   2. `mapfile` / `readarray`                    -> `while IFS= read -r` loops
//   3. `${var,,}` / `${var^^}` case modification  -> tr(1)
//   4. unguarded command-argument `${name[@]}` expansion in a file that sets
//      `set -u` (an EMPTY array then aborts with "unbound variable") — the
//      guarded form `${name[@]+"${name[@]}"}` is a no-op when empty and
//      byte-equivalent to the bare form otherwise (US-001).
//
// Scope notes (documented exemptions — prefer zero, these are structural):
//   * The lint excludes its OWN source file from the scan: the negative
//     self-tests below necessarily contain the pattern literals.
//   * The scan is comment- and single-quote-aware: a `#` comment or a
//     single-quoted literal may mention a pattern (that is documentation,
//     not code); double-quoted content IS scanned because real expansions
//     live inside double quotes.
//   * Class 4 flags only COMMAND-ARGUMENT expansions. `for x in "${arr[@]}"`
//     headers and `arr=( "${other[@]}" )` array-construction contexts are not
//     command arguments and are exempt (the array-assignment case is covered
//     by the golden-determinism proofs; builders' seed arrays are never empty).
//
// Picked up by self-tests/run.sh's `tier0-*.test.ts` glob — no run.sh edit.
// Zero tokens; confined to torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const TT_ROOT = path.join(repoRoot, "torture-test");
const LINT_BASENAME = "tier0-bash32-compat-lint.test.ts";

// ── shell-surface discovery ──────────────────────────────────────────────

/** Tracked files under torture-test/ that are shell scripts (.sh extension
 *  or a bash shebang on the first line), excluding the lint's own file. */
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
 *  expansions live inside double quotes. Handles bash single-quote semantics
 *  (a string ends at the next `'`; the `'\''` idiom is two empty strings
 *  around a literal quote) and `\"` escapes inside double quotes. */
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

// ── class 4 preconditions ───────────────────────────────────────────────

/** Does the file set nounset (set -u) anywhere? Detects combined flags
 *  (-euo), bare -u, `set -o nounset`, and space-separated flags (-e -u). */
function fileSetsSetU(content: string): boolean {
  return (
    /^\s*set\s+-(?:[A-Za-z]*u[A-Za-z]*)/m.test(content) ||
    /^\s*set\s+-o\s+nounset\b/m.test(content) ||
    /^\s*set\s+[^\r\n]*\s-u(?:\s|$)/m.test(content)
  );
}

// ── the scanner ──────────────────────────────────────────────────────────

const DECLARE_A_RE = /\bdeclare\s+-(?:[A-Za-z]*A[A-Za-z]*)\b/;
const MAPFILE_RE = /\b(?:mapfile|readarray)\b/;
const CASE_MOD_RE = /\$\{[A-Za-z_][A-Za-z0-9_]*[,^]{1,2}\}/;
const BARE_ARRAY_RE = /"\$\{[A-Za-z_][A-Za-z0-9_]*\[@\]\}"/g;
const ARRAY_ASSIGN_OPEN_RE = /^\s*(?:(?:local|readonly|declare)\s+(?:-[A-Za-z]+\s+)*)?[A-Za-z_][A-Za-z0-9_]*\+?=\(/;

/** Scan one shell file's content; return violation descriptions
 *  ("<line>: <class>" — the caller prefixes the file path). */
function scanShellFile(filePath: string, content: string): string[] {
  const violations: string[] = [];
  const lines = content.split(/\r?\n/);
  const masked = lines.map(maskLine);

  for (let i = 0; i < masked.length; i++) {
    const lineNo = i + 1;
    const m = masked[i];
    if (DECLARE_A_RE.test(m)) {
      violations.push(`${lineNo}: declare -A associative arrays are bash 4+ — rewrite with parallel arrays or a case table`);
    }
    if (MAPFILE_RE.test(m)) {
      violations.push(`${lineNo}: mapfile/readarray is bash 4+ — use a 'while IFS= read -r' loop`);
    }
    if (CASE_MOD_RE.test(m)) {
      violations.push(`${lineNo}: ${CASE_MOD_RE.exec(m)![0]} case-modifying expansion is bash 4+ — use tr(1)`);
    }
  }

  if (!fileSetsSetU(content)) return violations;

  // Class 4: unguarded command-argument @-expansions under set -u.
  // for-headers and array-construction contexts are exempt (state machines).
  let inForHeader = false;
  let inArrayAssign = false;
  for (let i = 0; i < masked.length; i++) {
    const lineNo = i + 1;
    const m = masked[i];
    if (inForHeader) {
      if (/;\s*do\b/.test(m) || /^\s*do\b/.test(m)) inForHeader = false;
      continue;
    }
    if (/^\s*for\s+\S+\s+in\b/.test(m)) {
      if (!/;\s*do\b/.test(m)) inForHeader = true;
      continue;
    }
    if (inArrayAssign) {
      if (/\)\s*$/.test(m)) inArrayAssign = false;
      continue;
    }
    if (ARRAY_ASSIGN_OPEN_RE.test(m)) {
      if (!/\)/.test(m)) inArrayAssign = true;
      continue;
    }
    BARE_ARRAY_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = BARE_ARRAY_RE.exec(m)) !== null) {
      const before = match.index > 0 ? m[match.index - 1] : "";
      if (before === "+") continue; // guarded form ${name[@]+"${name[@]}"}
      violations.push(
        `${lineNo}: unguarded command-argument expansion ${match[0]} under set -u — an empty array aborts on bash 3.2; use the guarded form \${name[@]+"\${name[@]}"}`,
      );
    }
  }
  return violations;
}

/** Scan every tracked shell file under torture-test/; return
 *  "<relative-path>: <violation>" entries for all findings. */
function scanTree(): string[] {
  const findings: string[] = [];
  for (const rel of collectShellFiles(repoRoot)) {
    const content = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    for (const v of scanShellFile(rel, content)) findings.push(`${rel}: ${v}`);
  }
  return findings;
}

// ── tests ────────────────────────────────────────────────────────────────

describe("tier0 bash-3.2 compatibility lint", () => {
  it("scans the tracked shell surface and finds zero violations (hard gate)", () => {
    const findings = scanTree();
    assert.deepEqual(
      findings,
      [],
      `bash-3.2-unsafe patterns remain in the tracked shell surface:\n${findings.join("\n")}`,
    );
  });

  it("excludes its own source file from the scan", () => {
    const files = collectShellFiles(repoRoot);
    assert.ok(
      !files.some((f) => path.basename(f) === LINT_BASENAME),
      "the lint must not scan itself (it necessarily contains the pattern literals)",
    );
    assert.ok(files.length > 50, `expected the tracked shell surface, got ${files.length} files`);
  });

  it("flags declare -A in a temp file", () => {
    const findings = scanShellFile("neg-declare-A.sh", '#!/usr/bin/env bash\ndeclare -A MAPPING\nMAPPING[x]=y\n');
    assert.ok(findings.some((v) => v.includes("declare -A")), `declare -A must be flagged: ${findings}`);
  });

  it("flags mapfile and readarray in temp files", () => {
    const map = scanShellFile("neg-mapfile.sh", "mapfile -t arr < file\n");
    assert.ok(map.some((v) => v.includes("mapfile")), `mapfile must be flagged: ${map}`);
    const reada = scanShellFile("neg-readarray.sh", "readarray -t arr < file\n");
    assert.ok(reada.some((v) => v.includes("readarray")), `readarray must be flagged: ${reada}`);
  });

  it("flags the case-modifying expansions in temp files", () => {
    const low = scanShellFile("neg-lower.sh", 'x="${var,,}"\n');
    assert.ok(low.some((v) => v.includes("${var,,}")), `${"${var,,}"} must be flagged: ${low}`);
    const up = scanShellFile("neg-upper.sh", 'x="${var^^}"\n');
    assert.ok(up.some((v) => v.includes("${var^^}")), `${"${var^^}"} must be flagged: ${up}`);
  });

  it("flags an unguarded command-argument @-expansion under set -u", () => {
    const content = '#!/usr/bin/env bash\nset -euo pipefail\nprog "${arr[@]}"\n';
    const findings = scanShellFile("neg-bare-arg.sh", content);
    assert.ok(
      findings.some((v) => v.includes("unguarded command-argument") && v.includes('"${arr[@]}"')),
      `bare command-argument expansion must be flagged: ${findings}`,
    );
  });

  it("does NOT flag the guarded expansion form", () => {
    const content = '#!/usr/bin/env bash\nset -euo pipefail\nprog ${arr[@]+"${arr[@]}"}\n';
    const findings = scanShellFile("pos-guarded.sh", content);
    assert.deepEqual(findings, [], `guarded form must be clean: ${findings}`);
  });

  it("does NOT flag @-expansions in `for x in` headers (single- and multi-line)", () => {
    const single = '#!/usr/bin/env bash\nset -u\nfor x in "${arr[@]}"; do echo "$x"; done\n';
    assert.deepEqual(scanShellFile("pos-for-single.sh", single), []);
    const multi = [
      "#!/usr/bin/env bash",
      "set -u",
      'for x in "${arr[@]}" \\',
      '         "${other[@]}"; do',
      "  echo \"$x\"",
      "done",
      "",
    ].join("\n");
    assert.deepEqual(scanShellFile("pos-for-multi.sh", multi), []);
  });

  it("does NOT flag @-expansions in files that do not set -u", () => {
    const content = '#!/usr/bin/env bash\nprog "${arr[@]}"\n';
    assert.deepEqual(scanShellFile("pos-no-setu.sh", content), []);
  });

  it("does NOT flag pattern literals in comments or single-quoted strings", () => {
    const comments = [
      "#!/usr/bin/env bash",
      "set -u",
      "# declare -A associative arrays are bash 4+; use a case table",
      "# mapfile/readarray are bash 4+; use a while-read loop",
      '# "${case_args[@]}" must be guarded with ${case_args[@]+"${case_args[@]}"}',
      'grep -Fc \'"${arr[@]}"\' file || true',
      "",
    ].join("\n");
    assert.deepEqual(scanShellFile("pos-comments.sh", comments), []);
  });
});
