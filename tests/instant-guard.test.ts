/**
 * TIME-STORAGE US-009 — fast-tier guard against the two-instant-format defect.
 *
 * Scans every `src/**\/*.ts` file (excluding `*.test.ts`), comment-blind, for
 * the writers/readers that re-introduce the mixed instant format:
 *
 *   - SQL `datetime('now')` (any argument list, single or double quoted)
 *   - SQL `CURRENT_TIMESTAMP` (case-insensitive)
 *   - `new Date(<stored instant field>)` / `Date.parse(<stored instant field>)`
 *     where the argument is a bare identifier / member-access chain whose last
 *     segment ends in `_at` or a camelCase `...At` (created_at, updated_at,
 *     claim_updated_at, checked_at, last_seen_at, scheduling_requested_at,
 *     harness_probe_at, createdAt, updatedAt, claimedAt, lastSeenAt, ...).
 *
 * The legitimate remaining occurrences live in `tests/instant-guard.allowlist.json`
 * and each one must carry a specific `match` and a one-line `reason`; whole-file
 * allow-listing is rejected. Comments are stripped first (the `@`-mentioning
 * doc comments in `src/lib/instant.ts` describe the old format and must not trip
 * the guard), so the scan asserts on real code only.
 *
 * Pure (fs + dist/lib only, no child_process) — stays in the parallel lane; do
 * NOT add it to tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../dist/lib/comment-blind.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const ALLOWLIST_PATH = path.join(REPO_ROOT, "tests", "instant-guard.allowlist.json");

export type InstantViolation = {
  /** Repo-relative path, e.g. `src/medic/medic.ts`. */
  file: string;
  /** 1-based line number inside the comment-stripped source. */
  line: number;
  /** Stable violation kind. */
  kind: "datetime-now" | "current-timestamp" | "new-date-stored" | "date-parse-stored";
  /** The exact matched source text (used for allow-list matching). */
  snippet: string;
};

/** `created_at`, `claim_updated_at`, `harness_probe_at`, `createdAt`, `claimedAt`, ... */
function isStoredInstantName(name: string): boolean {
  return /_at$/.test(name) || /[a-z][A-Za-z0-9]*At$/.test(name);
}

/**
 * A bare identifier or member-access chain with no calls/operators, e.g.
 * `created_at`, `row.created_at`, `existing.claimedAt`, `step?.lastSeenAt`.
 */
const STORED_REFERENCE_RE =
  /^[A-Za-z_$][A-Za-z0-9_$]*(?:\s*\??\.\s*[A-Za-z_$][A-Za-z0-9_$]*)*$/;

/** True only for a direct reference to a stored instant field. */
function isStoredInstantReference(argument: string): boolean {
  const arg = argument.trim();
  if (!STORED_REFERENCE_RE.test(arg)) return false;
  const last = arg.split(".").pop()!.trim();
  return isStoredInstantName(last);
}

const SQL_PATTERNS: { kind: InstantViolation["kind"]; re: RegExp }[] = [
  // Writer/comparison call: datetime('now'), datetime('now', '-24 hours'), datetime("now").
  { kind: "datetime-now", re: /datetime\s*\(\s*['"]now['"][^)]*\)/gi },
  // SQLite literal default/update.
  { kind: "current-timestamp", re: /\bCURRENT_TIMESTAMP\b/gi },
];

// `new Date(...)` and `Date.parse(...)`; the captured group is the argument.
const DATE_CTOR_RE = /\b(?:new\s+Date|Date\.parse)\s*\(([^)]*)\)/g;

/**
 * Comment-blind scan of one source string. Exported so the synthetic
 * violation/safe-form assertions exercise exactly the real scan.
 */
export function scanInstantSource(source: string, file = "<source>"): InstantViolation[] {
  const code = stripComments(source);
  const lineOf = (index: number) => code.slice(0, index).split("\n").length;
  const violations: InstantViolation[] = [];

  for (const { kind, re } of SQL_PATTERNS) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(code)) !== null) {
      violations.push({ file, line: lineOf(match.index), kind, snippet: match[0] });
    }
  }

  DATE_CTOR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DATE_CTOR_RE.exec(code)) !== null) {
    if (!isStoredInstantReference(match[1])) continue;
    const kind: InstantViolation["kind"] = match[0].trimStart().startsWith("Date.parse")
      ? "date-parse-stored"
      : "new-date-stored";
    violations.push({ file, line: lineOf(match.index), kind, snippet: match[0] });
  }

  return violations;
}

type AllowEntry = { file: string; match: string; reason: string };

function loadAllowlist(): AllowEntry[] {
  const parsed: unknown = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf8"));
  assert.ok(Array.isArray(parsed), "allow-list must be a JSON array");
  return parsed as AllowEntry[];
}

function violationIsAllowed(v: InstantViolation, allowlist: AllowEntry[]): boolean {
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

function scanRealTree(): InstantViolation[] {
  const violations: InstantViolation[] = [];
  for (const rel of listScannedSources()) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    violations.push(...scanInstantSource(source, rel));
  }
  return violations;
}

describe("US-009 instant guard: detection", () => {
  it("flags datetime('now') regardless of arguments/quoting", () => {
    const cases = [
      `db.prepare("UPDATE runs SET updated_at = datetime('now') WHERE id = ?");`,
      `db.prepare(\`UPDATE medic_checks SET checked_at = datetime('now')\`);`,
      `const sql = "SELECT 1 WHERE checked_at > datetime('now', '-24 hours')";`,
      `const sql = "UPDATE t SET x = datetime(  'now'  )";`,
      `const sql = 'UPDATE t SET x = datetime("now")';`,
    ];
    for (const src of cases) {
      const found = scanInstantSource(src).filter((v) => v.kind === "datetime-now");
      assert.equal(found.length, 1, `expected datetime('now') violation in: ${src}`);
    }
  });

  it("flags CURRENT_TIMESTAMP case-insensitively", () => {
    for (const src of [
      `db.exec("UPDATE t SET updated_at = CURRENT_TIMESTAMP");`,
      `db.exec("UPDATE t SET updated_at = current_timestamp");`,
      `db.exec("UPDATE t SET updated_at = Current_Timestamp");`,
    ]) {
      const found = scanInstantSource(src).filter((v) => v.kind === "current-timestamp");
      assert.equal(found.length, 1, `expected CURRENT_TIMESTAMP violation in: ${src}`);
    }
  });

  it("flags new Date(<stored field>) and Date.parse(<stored field>)", () => {
    const newDateCases = [
      `const t = new Date(row.created_at);`,
      `const t = new Date(row.updated_at).getTime();`,
      `const t = new Date(entry.claim_updated_at);`,
      `const t = new Date(marker.last_seen_at);`,
      `const t = new Date(run.scheduling_requested_at);`,
      `const t = new Date(step.harness_probe_at);`,
      `const t = new Date(existing.claimedAt);`,
      `const t = new Date(existing.updatedAt);`,
      `const t = new Date(x.lastSeenAt);`,
      `const t = new Date(a?.createdAt);`,
    ];
    for (const src of newDateCases) {
      const found = scanInstantSource(src).filter((v) => v.kind === "new-date-stored");
      assert.equal(found.length, 1, `expected stored-field new Date violation in: ${src}`);
    }

    for (const src of [
      `const ms = Date.parse(row.claim_updated_at);`,
      `const ms = Date.parse(entry.last_seen_at);`,
      `const ms = Date.parse(marker.checkedAt);`,
    ]) {
      const found = scanInstantSource(src).filter((v) => v.kind === "date-parse-stored");
      assert.equal(found.length, 1, `expected stored-field Date.parse violation in: ${src}`);
    }
  });

  it("does not flag safe, non-stored date construction", () => {
    const safe = [
      `const now = new Date().toISOString();`,
      `const d = new Date();`,
      `const cutoff = new Date(Date.now() - 1000).toISOString();`,
      `const ts = new Date(runtime.now()).toISOString();`,
      `const t = parseInstant(row.created_at);`,
      `const t = new Date(nowMs);`,
      `const t = new Date(nowMs - wallMs);`,
      `const t = new Date(ts).toLocaleTimeString();`,
      'const t = new Date(`${raw.replace(" ", "T")}Z`);',
      `const t = new Date(opts?.nowMs ?? Date.now());`,
      `const t = new Date(Number(row.created_at));`,
      `existing.lastHeartbeatAt = new Date().toISOString();`,
    ];
    for (const src of safe) {
      assert.deepEqual(scanInstantSource(src), [], `must not flag safe form: ${src}`);
    }
  });

  it("is comment-blind (comments may describe the old format)", () => {
    const src = [
      `// legacy writers used datetime('now') and new Date(row.created_at)`,
      `/* CURRENT_TIMESTAMP and Date.parse(row.updated_at) are the defect */`,
      `const now = new Date().toISOString();`,
    ].join("\n");
    assert.deepEqual(scanInstantSource(src), []);
  });

  it("records file, line, kind and snippet for every violation", () => {
    const src = ["const a = 1;", `const b = new Date(row.created_at);`].join("\n");
    const [v] = scanInstantSource(src, "src/example.ts");
    assert.equal(v.file, "src/example.ts");
    assert.equal(v.line, 2);
    assert.equal(v.kind, "new-date-stored");
    assert.equal(v.snippet, "new Date(row.created_at)");
  });
});

describe("US-009 instant guard: allow-list", () => {
  it("has a well-formed entry for every legitimate occurrence", () => {
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
      assert.ok(entry.reason.trim().length > 0, `entry.reason must be a one-line justification: ${entry.file}`);
      assert.ok(!/[\r\n]/.test(entry.reason), `entry.reason must be one line: ${entry.file}`);
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
        "unexpected instant-format violations (fix the code or add a justified",
        "tests/instant-guard.allowlist.json entry):",
        ...unexpected.map((v) => `  ${v.file}:${v.line} [${v.kind}] ${v.snippet}`),
      ].join("\n"),
    );
  });

  it("scans the real src/ tree and still sees the known legitimate hits", () => {
    const real = scanRealTree();
    assert.ok(real.length > 0, "guard must actually be scanning src/");
    // Sanity: the two pinned occurrences are found so the allow-list is exercised.
    assert.ok(
      real.some((v) => v.file === "src/medic/medic.ts" && v.snippet.includes("datetime('now', '-24 hours')")),
      "medic 24h comparison must be detected",
    );
    assert.ok(
      real.some((v) => v.file === "src/server/control-server.ts" && v.snippet.includes("new Date(existing.claimedAt)")),
      "control-server claimedAt conversion must be detected",
    );
  });
});
