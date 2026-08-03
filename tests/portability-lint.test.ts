import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

// ── Forbidden-literal constants (composed from fragments so this file
//     doesn't contain any forbidden contiguous literals itself). ────────

const P = "/" + "proc" + "/";
const B = "/" + "bin" + "/" + "false";
const U = "/" + "usr" + B;
const N = "--" + "no-headers";

// ── Banned find flag fragments (composed so this file doesn't trigger itself) ─
//
// Each flag is stored as a { raw, label } pair, both composed by
// concatenation so no literal "-flag" string appears in this file.
// The raw form is used for substring scanning; the label form is used
// for exception-map lookups and violation messages.

const FN = "-" + "newermt";
const FP = "-" + "printf";
const FR = "-" + "regextype";
const FM = "-" + "mindepth";
const FD = "-" + "daystart";
const FA = "-" + "amin";
const FC = "-" + "cmin";
const FU = "-" + "used";
const FF = "-" + "fstype";
const FW = "-" + "wholename";

/** Individual banned find flags, each stored with raw and label forms. */
const BANNED_FIND_FLAGS: { raw: string; label: string }[] = [
  { raw: FN, label: FN },
  { raw: FP, label: FP },
  { raw: FR, label: FR },
  { raw: FM, label: FM },
  { raw: FD, label: FD },
  { raw: FA, label: FA },
  { raw: FC, label: FC },
  { raw: FU, label: FU },
  { raw: FF, label: FF },
  { raw: FW, label: FW },
];

/** Set of all banned flag labels (for exception-map initialization). */
const ALL_FIND_FLAGS = new Set([FN, FP, FR, FM, FD, FA, FC, FU, FF, FW]);

/** Files allowed to use specific banned find flags (keyed by file, value = set of allowed flags). */
const FIND_FLAG_ALLOWED: Map<string, Set<string>> = new Map([
  // The portability-lint test file itself contains banned flag literals in its test content strings.
  ["tests/portability-lint.test.ts", ALL_FIND_FLAGS],
]);

const REPO_ROOT = process.cwd();

// ── Types ─────────────────────────────────────────────────────────────

interface Violation {
  relativePath: string;
  line: number;
  message: string;
}

// ── Hardcoded exceptions ──────────────────────────────────────────────

/** Dedicated process-introspection helpers that are allowed to reference procfs. */
const PROC_ALLOWED = new Set([
  "src/lib/proc-info.ts",
  "src/lib/process-start-identity.ts",
]);

/** Files with a known linux-guarded procfs environ read + lsof fallback. */
const GUARDED_PROC_FILES = new Set([
  "tests/mcp-lifecycle.test.ts",
  "tests/dashboard-status-mcp.test.ts",
]);

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Check whether a procfs line in a guarded-proc-environ file is the known
 * linux-guarded environ block (surrounded by `process.platform === "linux"`
 * above and an `lsof` fallback below).
 */
function isGuardedEnviron(
  relativePath: string,
  lines: string[],
  idx: number,
): boolean {
  if (!GUARDED_PROC_FILES.has(relativePath)) return false;
  const line = lines[idx];
  if (!line.includes(P) || !line.includes("environ")) return false;

  const before = lines.slice(Math.max(0, idx - 8), idx + 1).join("\n");
  const after = lines.slice(idx, Math.min(lines.length, idx + 12)).join("\n");

  return (
    before.includes('process.platform === "linux"') &&
    after.includes("lsof")
  );
}

/**
 * Return true if `line` contains a standalone false binary reference
 * (i.e. NOT /usr/bin/false).
 */
function hasRawBinFalse(line: string): boolean {
  let i = line.indexOf(B);
  while (i !== -1) {
    const prefix = line.slice(Math.max(0, i - 4), i);
    if (prefix !== "/usr") return true;
    i = line.indexOf(B, i + 1);
  }
  return false;
}

// ── Core scanner ──────────────────────────────────────────────────────

/**
 * Scan a file's content for forbidden portability patterns.
 * Returns violations discovered.
 */
export function scanFileContent(
  relativePath: string,
  content: string,
): Violation[] {
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lno = i + 1;

    // ── procfs ────────────────────────────────────────────────────────
    if (line.includes(P)) {
      if (PROC_ALLOWED.has(relativePath)) continue;
      if (isGuardedEnviron(relativePath, lines, i)) continue;
      violations.push({
        relativePath,
        line: lno,
        message:
          `${relativePath}:${lno}: ${P} is Linux-only; ` +
          `use src/lib/proc-info.ts helpers, or a process.platform === "linux" guarded block with a portable fallback.`,
      });
    }

    // ── false binary path check ──────────────────────────────────────
    if (hasRawBinFalse(line)) {
      violations.push({
        relativePath,
        line: lno,
        message:
          `${relativePath}:${lno}: ${B} is not portable; ` +
          `use ${U}.`,
      });
    }

    // ── GNU ps no-headers flag check ─────────────────────────────────
    if (line.includes(N)) {
      if (relativePath === "src/cli/status-format.ts") continue;
      violations.push({
        relativePath,
        line: lno,
        message:
          `${relativePath}:${lno}: ${N} is a GNU ps flag; ` +
          `use a platform branch (src/cli/status-format.ts pattern) ` +
          `or portable ps flags.`,
      });
    }

    // ── Banned find flags ────────────────────────────────────────────
    for (const flag of BANNED_FIND_FLAGS) {
      if (line.includes(flag.raw)) {
        const allowed = FIND_FLAG_ALLOWED.get(relativePath);
        if (allowed?.has(flag.label)) continue;
        violations.push({
          relativePath,
          line: lno,
          message:
            `${relativePath}:${lno}: ${flag.label} is not portable across GNU find, BSD/macOS find, and bfs. ` +
            `Use portable alternatives: -mmin/-mtime for age filtering, ` +
            `touch -t + -newer for reference timestamps, -exec for formatting, ` +
            `-path instead of -wholename.`,
        });
      }
    }
  }

  return violations;
}

// ── Repository scanner ────────────────────────────────────────────────

const SCAN_ROOTS = ["src", "scripts", "tests", "e2e-tests"];
const SCAN_EXT = new Set([".ts", ".sh", ".mjs"]);
const SKIP_SEG = new Set([".git", "node_modules", "dist"]);

function trackedPortableFiles(repoRoot: string): string[] {
  const raw = execFileSync("git", ["ls-files", ...SCAN_ROOTS], {
    cwd: repoRoot,
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return raw
    .split("\n")
    .filter(Boolean)
    .filter((p) => SCAN_ROOTS.some((r) => p === r || p.startsWith(r + "/")))
    .filter((p) => SCAN_EXT.has(extname(p)))
    .filter((p) => !p.split("/").some((seg) => SKIP_SEG.has(seg)));
}

export function scanRepository(repoRoot: string): Violation[] {
  const files = trackedPortableFiles(repoRoot);
  const violations: Violation[] = [];
  for (const rel of files) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf-8");
    violations.push(...scanFileContent(rel, content));
  }
  return violations;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("portability lint - unit", () => {
  it("flags direct procfs reference outside allowed helper", () => {
    const v = scanFileContent("tests/fake.test.ts", 'readFileSync("' + P + 'cpuinfo")');
    assert.equal(v.length, 1);
    assert.match(v[0].message, /tests\/fake\.test\.ts:1:.*Linux-only/);
  });

  it("allows proc helper file", () => {
    const v = scanFileContent(
      "src/lib/proc-info.ts",
      "readFileSync(`" + P + "${pid}/stat`)",
    );
    assert.equal(v.length, 0);
  });

  it("allows the Linux-only process-start identity helper", () => {
    const v = scanFileContent(
      "src/lib/process-start-identity.ts",
      "readFileSync(`" + P + "${pid}/stat`)",
    );
    assert.equal(v.length, 0);
  });

  it("allows known guarded environ block with lsof fallback", () => {
    const content = [
      'if (process.platform === "linux") {',
      "  // read proc env",
      "  execSync(`cat " + P + "${pid}/environ`)",
      "} else {",
      "  // fallback to lsof",
      "  execSync(`lsof -p ${pid}`)",
      "}",
    ].join("\n");
    const v = scanFileContent("tests/mcp-lifecycle.test.ts", content);
    assert.equal(v.length, 0);
  });

  it("rejects procfs in guarded file when guard is missing", () => {
    const content = "execSync(`cat " + P + "${pid}/environ`)";
    const v = scanFileContent("tests/mcp-lifecycle.test.ts", content);
    assert.equal(v.length, 1);
  });

  it("rejects procfs in guarded file when lsof fallback is missing", () => {
    const content = [
      'if (process.platform === "linux") {',
      "  execSync(`cat " + P + "${pid}/environ`)",
      "}",
    ].join("\n");
    const v = scanFileContent("tests/mcp-lifecycle.test.ts", content);
    assert.equal(v.length, 1);
  });

  it("flags exact false binary", () => {
    const v = scanFileContent(
      "scripts/test.sh",
      "TAMANDUA_PI_BINARY=" + B,
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, new RegExp(U));
  });

  it("allows /usr/bin/false", () => {
    const v = scanFileContent(
      "scripts/test.sh",
      "TAMANDUA_PI_BINARY=" + U,
    );
    assert.equal(v.length, 0);
  });

  it("flags no-headers flag outside status-format", () => {
    const v = scanFileContent(
      "tests/fake.test.ts",
      'execSync("ps -eo pid,etime,args ' + N + '")',
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /GNU ps flag/);
  });

  it("allows no-headers flag in status-format", () => {
    const v = scanFileContent(
      "src/cli/status-format.ts",
      'execSync("ps -eo pid,etime,args ' + N + '")',
    );
    assert.equal(v.length, 0);
  });

  // ── Banned find flag tests ─────────────────────────────────────────

  it("flags -newermt in shell scripts", () => {
    const v = scanFileContent(
      "scripts/cleanup.sh",
      'find . -newermt "3 hours ago" -delete',
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-newermt/);
    assert.match(v[0].message, /not portable/);
  });

  it("flags -printf in shell scripts", () => {
    const v = scanFileContent(
      "scripts/list.sh",
      "find . -name '*.ts' -printf '%p\\n'",
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-printf/);
  });

  it("flags -regextype in shell scripts", () => {
    const v = scanFileContent(
      "scripts/search.sh",
      "find . -regextype posix-extended -regex '.*\\.ts'",
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-regextype/);
  });

  it("flags -mindepth in shell scripts", () => {
    const v = scanFileContent(
      "scripts/tree.sh",
      "find . -mindepth 2 -name '*.js'",
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-mindepth/);
  });

  it("flags -daystart in shell scripts", () => {
    const v = scanFileContent(
      "scripts/recent.sh",
      "find . -daystart -mtime 0",
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-daystart/);
  });

  it("flags -amin in shell scripts", () => {
    const v = scanFileContent(
      "scripts/recent.sh",
      "find . -amin -10",
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-amin/);
  });

  it("flags -cmin in shell scripts", () => {
    const v = scanFileContent(
      "scripts/recent.sh",
      "find . -cmin -30",
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-cmin/);
  });

  it("flags -used in shell scripts", () => {
    const v = scanFileContent(
      "scripts/stale.sh",
      "find . -used 7 -delete",
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-used/);
  });

  it("flags -fstype in shell scripts", () => {
    const v = scanFileContent(
      "scripts/fs.sh",
      "find /mnt -fstype nfs -prune -o -print",
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-fstype/);
  });

  it("flags -wholename in shell scripts", () => {
    const v = scanFileContent(
      "scripts/match.sh",
      "find . -wholename '*/node_modules/*' -prune",
    );
    assert.equal(v.length, 1);
    assert.match(v[0].message, /-wholename/);
  });

  it("allows portable find invocations with -name, -type, -maxdepth, -print0, -path, !", () => {
    const v = scanFileContent(
      "scripts/ok.sh",
      'find src tests -name "*.test.ts" ! -path "*/e2e-tests/*" -maxdepth 3 -type f -print0',
    );
    assert.equal(v.length, 0);
  });

  it("allows banned find flag in an explicitly allowed file", () => {
    FIND_FLAG_ALLOWED.set("scripts/legacy.sh", new Set(["-newermt"]));
    try {
      const v = scanFileContent(
        "scripts/legacy.sh",
        'find . -newermt "3 hours ago"',
      );
      assert.equal(v.length, 0);
    } finally {
      FIND_FLAG_ALLOWED.delete("scripts/legacy.sh");
    }
  });

  it("messages name the offending file:line and the portable alternative", () => {
    const v = scanFileContent("src/banana.ts", "cat " + P + "uptime");
    assert.equal(v.length, 1);
    const msg = v[0].message;
    assert.match(msg, /src\/banana\.ts:1:/);
    assert.match(msg, /proc-info\.ts/);
    const v2 = scanFileContent(
      "tests/fake.test.ts",
      '"ps ' + N + '"',
    );
    assert.equal(v2.length, 1);
    assert.match(v2[0].message, /tests\/fake\.test\.ts:1:/);
  });

  it("handle empty content gracefully", () => {
    const v = scanFileContent("tests/empty.test.ts", "");
    assert.equal(v.length, 0);
  });
});

describe("portability lint - repository", () => {
  it("repository source avoids non-portable Linux-only idioms", () => {
    const violations = scanRepository(REPO_ROOT);
    const messages = violations.map((v) => v.message);
    assert.equal(
      messages.length,
      0,
      `Found ${violations.length} non-portable idiom(s):\n${messages.join("\n")}`,
    );
  });
});
