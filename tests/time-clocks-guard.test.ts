/**
 * TIME-CLOCKS US-014 — fast-tier guard against re-introducing ad-hoc
 * `Date.now()` interval/deadline math.
 *
 * TIME-CLOCKS rule 1 (`src/lib/instant.ts`): every in-process interval or
 * deadline MUST be measured on the monotonic clock (`monotonicNow()` /
 * `Stopwatch` / `Deadline`), never as a difference/comparison of `Date.now()`
 * values, because a wall-clock jump (NTP step, suspend/resume) can make such
 * math negative, inflated, or premature. Rules 2 and 3 deliberately keep
 * wall-epoch reads, but only as bare instants routed through
 * `instantAgeMs()` / `isOlderThan()` — never as raw arithmetic. The scanner
 * therefore looks for the raw wall-clock arithmetic/comparison idioms only:
 *
 *   - `Date.now() -` / `- Date.now()`          (wall interval math)
 *   - `Date.now() +`                           (wall future-deadline arm)
 *   - `Date.now() <` / `>` / `<=` / `>=`       (wall deadline / elapsed gate)
 *   - `new Date(<... Date.now() ...>)`         (wall instant built inline)
 *
 * Bare wall reads that are the sanctioned rule-2/rule-3 forms are NOT flagged,
 * by design: an injectable `nowMs: number = Date.now()` default, a
 * `const now = Date.now()` fed to a shared helper, a `Date.now()` epoch start
 * capture compared to an OS file mtime, and the `nowIso()` / `SQL_NOW_ISO`
 * writers (which never mention `Date.now()`).
 *
 * The scan is comment-blind (`stripComments`) so an explanatory comment may
 * still name the old idiom without tripping the guard. The one legitimate
 * occurrence that DOES match an idiom lives in
 * `tests/time-clocks-guard.allowlist.json` with a per-entry justification;
 * allow-list entries match a file + a stable code snippet (never a line
 * number), so they survive line drift.
 *
 * Pure (fs + dist/lib only, no child_process) — stays in the parallel lane;
 * do NOT add it to tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../dist/lib/comment-blind.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const ALLOWLIST_PATH = path.join(REPO_ROOT, "tests", "time-clocks-guard.allowlist.json");

export type WallIntervalKind =
  | "wall-now-difference"
  | "wall-now-deadline"
  | "wall-now-comparison"
  | "wall-date-from-wall-now";

export type WallIntervalViolation = {
  /** Repo-relative path, e.g. `src/lib/instant.ts`. */
  file: string;
  /** 1-based line number inside the comment-stripped source. */
  line: number;
  /** Stable violation kind. */
  kind: WallIntervalKind;
  /** Stable idiom id (the pattern that matched), for diagnostics. */
  id: string;
  /** The exact matched source text (used for allow-list matching). */
  snippet: string;
};

type WallIntervalPattern = { id: string; kind: WallIntervalKind; re: RegExp };

/**
 * The literal wall-interval idioms, one pattern per documented form. These
 * are `Date.now()` reads used as an interval/deadline value; the sanctioned
 * durable-instant reads (`nowMs: number = Date.now()` etc.) are not matched
 * because they carry no adjacent operator.
 */
const WALL_INTERVAL_PATTERNS: WallIntervalPattern[] = [
  { id: "now-minus", kind: "wall-now-difference", re: /Date\.now\(\)\s*-/g },
  { id: "minus-now", kind: "wall-now-difference", re: /-\s*Date\.now\(\)/g },
  { id: "now-plus", kind: "wall-now-deadline", re: /Date\.now\(\)\s*\+/g },
  // `<=` / `>=` before `<` / `>` so the compound operator is the retained hit.
  { id: "now-lte", kind: "wall-now-comparison", re: /Date\.now\(\)\s*<=/g },
  { id: "now-gte", kind: "wall-now-comparison", re: /Date\.now\(\)\s*>=/g },
  { id: "now-lt", kind: "wall-now-comparison", re: /Date\.now\(\)\s*</g },
  { id: "now-gt", kind: "wall-now-comparison", re: /Date\.now\(\)\s*>/g },
  // `new Date(<expr containing Date.now()>)` covers the documented
  // `new Date(Date.now() - ...)` cutoff and any inline wall instant.
  { id: "date-from-now", kind: "wall-date-from-wall-now", re: /new\s+Date\s*\([^)]*Date\.now\(\)/g },
];

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/**
 * Comment-blind scan of one source string. Exported so the synthetic
 * violation/safe-form assertions exercise exactly the real scan. One
 * violation is reported per match start index (so `Date.now() <=` is not
 * double-reported as both `<=` and `<`).
 */
export function scanWallIntervalSource(source: string, file = "<source>"): WallIntervalViolation[] {
  const code = stripComments(source);
  const violations: WallIntervalViolation[] = [];
  const seenAt = new Set<number>();

  for (const pattern of WALL_INTERVAL_PATTERNS) {
    pattern.re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.re.exec(code)) !== null) {
      const index = match.index;
      if (!seenAt.has(index)) {
        seenAt.add(index);
        violations.push({
          file,
          line: lineOf(code, index),
          kind: pattern.kind,
          id: pattern.id,
          snippet: match[0],
        });
      }
      // Guard against a zero-length match changing lastIndex forever.
      if (match.index === pattern.re.lastIndex) pattern.re.lastIndex++;
    }
  }

  return violations;
}

type AllowEntry = { file: string; match: string; reason: string };

function loadAllowlist(): AllowEntry[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
  assert.ok(Array.isArray(parsed), "allow-list must be a JSON array");
  return parsed as AllowEntry[];
}

function violationIsAllowed(v: WallIntervalViolation, allowlist: AllowEntry[]): boolean {
  return allowlist.some((entry) => entry.file === v.file && v.snippet.includes(entry.match));
}

/** All `src/**\/*.ts` files except `*.test.ts`, as repo-relative paths. */
function listScannedSources(dir = SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listScannedSources(abs));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path.relative(REPO_ROOT, abs).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

function scanRealTree(): WallIntervalViolation[] {
  const violations: WallIntervalViolation[] = [];
  for (const rel of listScannedSources()) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    violations.push(...scanWallIntervalSource(source, rel));
  }
  return violations;
}

describe("US-014 wall-interval guard: detection", () => {
  it("flags every documented wall-interval idiom", () => {
    const cases: { src: string; kind: WallIntervalKind }[] = [
      { src: `const elapsed = Date.now() - startedAt;`, kind: "wall-now-difference" },
      { src: `const elapsed = startedAt - Date.now();`, kind: "wall-now-difference" },
      { src: `const elapsed = Date.now()-startedAt;`, kind: "wall-now-difference" },
      { src: `nextAllowedAt = Date.now() + delayMs;`, kind: "wall-now-deadline" },
      { src: `if (Date.now() < nextAllowedDispatchAt) return;`, kind: "wall-now-comparison" },
      { src: `if (Date.now() > deadline) return;`, kind: "wall-now-comparison" },
      { src: `if (Date.now() >= cutoff) return;`, kind: "wall-now-comparison" },
      { src: `if (Date.now() <= cutoff) return;`, kind: "wall-now-comparison" },
      { src: `const iso = new Date(Date.now() - DAY_MS).toISOString();`, kind: "wall-date-from-wall-now" },
      { src: `const iso = new Date(Date.now()).toISOString();`, kind: "wall-date-from-wall-now" },
    ];
    for (const { src, kind } of cases) {
      const found = scanWallIntervalSource(src);
      assert.ok(found.length > 0, `expected a wall-interval violation in: ${src}`);
      assert.ok(
        found.some((v) => v.kind === kind),
        `expected a ${kind} violation in: ${src}; got ${JSON.stringify(found)}`,
      );
    }
  });

  it("does not double-report Date.now() <= as both <= and <", () => {
    const found = scanWallIntervalSource(`if (Date.now() <= cutoff) return;`);
    assert.equal(found.length, 1, `expected one violation, got ${JSON.stringify(found)}`);
    assert.equal(found[0].id, "now-lte");
  });

  it("does not flag the sanctioned monotonic or durable-instant forms", () => {
    const safe = [
      `const elapsed = monotonicNow() - startedAt;`,
      `const watch = new Stopwatch();`,
      `const watch = new Stopwatch(() => fakeMs);`,
      `const budget = new Deadline(timeoutMs);`,
      `if (!deadline.expired()) continue;`,
      `const nowMs: number = Date.now(),`,
      `nowMs: number = Date.now(),`,
      `const now = Date.now();`,
      `const nowMs = opts?.nowMs ?? Date.now();`,
      `dshRoundStartedAtMs = Date.now();`,
      `const ts = Date.now();`,
      `if (!isOlderThan(row.created_at, WINDOW_MS, Date.now(), TOLERANCE_MS)) return false;`,
      `const nowIso = new Date(nowMs).toISOString();`,
      `const nowIso = opts?.nowMs ? new Date(opts.nowMs).toISOString() : nowIso();`,
      `db.prepare(\`UPDATE runs SET updated_at = \${SQL_NOW_ISO} WHERE id = ?\`);`,
    ];
    for (const src of safe) {
      assert.deepEqual(scanWallIntervalSource(src), [], `must not flag safe form: ${src}`);
    }
  });

  it("is comment-blind (comments may describe the old idiom)", () => {
    const src = [
      `// the old code did Date.now() - startedAt and Date.now() < deadline`,
      `/* nextAllowedAt = Date.now() + delayMs; new Date(Date.now() - DAY_MS) */`,
      `const elapsed = monotonicNow() - startedAt;`,
    ].join("\n");
    assert.deepEqual(scanWallIntervalSource(src), []);
  });

  it("records file, line, kind, id and snippet for every violation", () => {
    const src = ["const a = 1;", `const elapsed = Date.now() - startedAt;`].join("\n");
    const [v] = scanWallIntervalSource(src, "src/example.ts");
    assert.equal(v.file, "src/example.ts");
    assert.equal(v.line, 2);
    assert.equal(v.kind, "wall-now-difference");
    assert.equal(v.id, "now-minus");
    assert.equal(v.snippet, "Date.now() -");
  });

  it("scans the real src/ tree (guard is actually wired to the tree)", () => {
    assert.ok(listScannedSources().length > 0, "scanner must find src/ sources");
  });
});

describe("US-014 wall-interval guard: allow-list", () => {
  it("has a well-formed, TIME-CLOCKS-justified entry for every legitimate occurrence", () => {
    const allowlist = loadAllowlist();
    assert.ok(allowlist.length > 0, "allow-list must not be empty");
    for (const entry of allowlist) {
      assert.equal(typeof entry.file, "string", "entry.file must be a string");
      assert.equal(typeof entry.match, "string", "entry.match must be a string");
      assert.equal(typeof entry.reason, "string", "entry.reason must be a string");
      assert.match(entry.file, /^src\/.+\.ts$/, `entry.file must be a repo src path: ${entry.file}`);
      assert.ok(fs.existsSync(path.join(REPO_ROOT, entry.file)), `entry.file must exist: ${entry.file}`);
      // A specific literal, never a wildcard or a whole-file/blanket match.
      assert.ok(entry.match.trim().length >= 8, `entry.match too broad: ${JSON.stringify(entry.match)}`);
      assert.ok(!entry.match.includes("*"), `entry.match must not be a glob: ${entry.match}`);
      assert.ok(!/[\r\n]/.test(entry.reason), `entry.reason must be one line: ${entry.file}`);
      // AC2: every justification is tied to the TIME-CLOCKS rule.
      assert.match(entry.reason, /TIME-CLOCKS rule/, `entry.reason must cite the TIME-CLOCKS rule: ${entry.file}`);
    }
  });

  it("uses every allow-list entry (no stale blanket allowances)", () => {
    const allowlist = loadAllowlist();
    const real = scanRealTree();
    for (const entry of allowlist) {
      const used = real.some((v) => v.file === entry.file && v.snippet.includes(entry.match));
      assert.ok(used, `allow-list entry matches nothing and must be removed: ${entry.file} :: ${entry.match}`);
    }
  });

  it("the real src/ tree reports only allow-listed violations", () => {
    const allowlist = loadAllowlist();
    const real = scanRealTree();
    const unexpected = real.filter((v) => !violationIsAllowed(v, allowlist));
    assert.deepEqual(
      unexpected,
      [],
      [
        "unexpected wall-interval violations (use monotonicNow()/Stopwatch/Deadline, or add a",
        "justified tests/time-clocks-guard.allowlist.json entry):",
        ...unexpected.map((v) => `  ${v.file}:${v.line} [${v.kind}] ${v.snippet}`),
      ].join("\n"),
    );
  });

  it("suppresses an allow-listed snippet and rejects the same snippet without the entry", () => {
    const snippet = `const nowIso = new Date(opts?.nowMs ?? Date.now()).toISOString();`;
    const [violation] = scanWallIntervalSource(snippet, "src/example.ts");
    assert.ok(violation, "synthetic serialization snippet must be detected");
    assert.equal(violation.kind, "wall-date-from-wall-now");

    const allowlist = loadAllowlist();
    assert.ok(
      violationIsAllowed(violation, [{ file: "src/example.ts", match: "new Date(opts?.nowMs ?? Date.now()", reason: "synthetic" }]),
      "an explicit allow-list entry must suppress the violation",
    );
    assert.ok(
      !violationIsAllowed(violation, allowlist.filter((e) => e.file !== "src/installer/harness-probe.ts")),
      "without the matching file+match entry the violation must remain unallowed",
    );
  });

  it("finds the pinned harness-probe serialization writer and allows it", () => {
    const allowlist = loadAllowlist();
    const real = scanRealTree();
    const probe = real.filter((v) => v.file === "src/installer/harness-probe.ts");
    assert.ok(probe.length > 0, "the harness-probe epoch-stamp serialization site must be detected");
    assert.ok(probe.every((v) => violationIsAllowed(v, allowlist)), "the harness-probe site must be allow-listed");
  });
});
