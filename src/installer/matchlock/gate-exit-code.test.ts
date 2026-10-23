/**
 * gate-exit-code tests (G9 EXIT-CODE-AND-REMEDIES, story US-002).
 *
 * These tests pin the launch-gate exit-status allocation in
 * src/installer/matchlock/gate-exit-code.ts. They import the COMPILED modules
 * from dist/ (repo convention for this directory), so `npm run build` must run
 * first.
 *
 * WHAT MAKES THE ALLOCATION "MEASURED"
 *
 * Three independent legs, each able to fail on its own:
 *
 *  1. RECORDED STATUSES — 78 is asserted against the process statuses this
 *     tree already uses (0, 1, 2, 3, 4, 5, 6, 7, 9, 13, 91, 143) and against
 *     every dedicated named constant, each of which is first asserted to still
 *     hold its documented value (86/87/88/75). A silent constant change fails
 *     here instead of quietly colliding.
 *  2. NAMED CONSTANTS — the four dedicated codes are imported from their real
 *     homes (src/suite/exit-codes.ts and src/installer/workdir-collision.ts),
 *     not copied as literals. workflow.ts is source-asserted to still import
 *     the workdir constant from the same module, so the CLI surface and the
 *     gate cannot drift apart.
 *  3. LIVE TREE SCAN — every other TypeScript file under `src/` is scanned
 *     (comment-blind) for the four ways a process status is claimed:
 *     `process.exit(N)`, `process.exitCode = N`, a bare `exit(N)`, and a
 *     `NAME_EXIT_CODE = N` declaration. The scanner is itself unit-tested with
 *     synthetic sources, so a broken guard cannot pass by finding nothing.
 *
 * The mapping is a pure function of the outcome. `refuse` and
 * `operational-refusal` share the process status (the launch did not proceed)
 * while staying separate union members, so the ten reason codes stay closed.
 *
 * This file reads source text with node:fs and imports only pure dist modules.
 * It spawns no process and therefore belongs in the PARALLEL lane: the last
 * test asserts its own repo-relative path is NOT in tests/serial-files.txt.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "../../../dist/lib/comment-blind.js";
import {
  LAUNCH_GATE_REFUSAL_EXIT_CODE,
  exitCodeForGateOutcome,
  type OperationalRefusal,
} from "../../../dist/installer/matchlock/gate-exit-code.js";
import {
  REASON_CODE_ORDER,
  evaluateGate,
  type EvaluatedStore,
  type GateInput,
  type GateVerdict,
} from "../../../dist/installer/matchlock/launch-gate.js";
import {
  INTERRUPTED_EXIT_CODE,
  TREE_DIRTY_EXIT_CODE,
  TREE_DRIFT_EXIT_CODE,
} from "../../../dist/suite/exit-codes.js";
import { WORKDIR_REFUSAL_EXIT_CODE } from "../../../dist/installer/workdir-collision.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "gate-exit-code.ts");
const MODULE_DIST = path.join(
  REPO_ROOT,
  "dist/installer/matchlock/gate-exit-code.js",
);
const SRC_DIR = path.join(REPO_ROOT, "src");
const SERIAL_FILES = path.join(REPO_ROOT, "tests", "serial-files.txt");
const WORKFLOW_CLI = path.join(REPO_ROOT, "src/cli/commands/workflow.ts");

/** This file's own repo-relative path, always with forward slashes. */
const THIS_FILE = "src/installer/matchlock/gate-exit-code.test.ts";

/** The one module allowed to own the 78 allocation. */
const ALLOCATING_MODULE = "src/installer/matchlock/gate-exit-code.ts";

/**
 * Process statuses already claimed in this tree when 78 was allocated.
 *
 * This is the spec's recorded set (0, 1, 4, 5, 6, 7, 9, 13, 91, 143) plus 2
 * and 3, which `process.exit(...)` also uses in this tree even though the
 * spec's abbreviated list omits them: measured, not assumed.
 */
const RECORDED_USED_EXIT_CODES: readonly number[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 9, 13, 91, 143,
];

/**
 * The dedicated codes, each with the literal value its own module must still
 * hold. The literal is asserted FIRST so a silent renumbering is reported as
 * that constant's failure rather than as a confusing "78 collides" one.
 */
const DEDICATED_EXIT_CODES: readonly {
  name: string;
  value: number;
  expected: number;
  home: string;
}[] = [
  {
    name: "TREE_DRIFT_EXIT_CODE",
    value: TREE_DRIFT_EXIT_CODE,
    expected: 86,
    home: "src/suite/exit-codes.ts",
  },
  {
    name: "INTERRUPTED_EXIT_CODE",
    value: INTERRUPTED_EXIT_CODE,
    expected: 87,
    home: "src/suite/exit-codes.ts",
  },
  {
    name: "TREE_DIRTY_EXIT_CODE",
    value: TREE_DIRTY_EXIT_CODE,
    expected: 88,
    home: "src/suite/exit-codes.ts",
  },
  {
    name: "WORKDIR_REFUSAL_EXIT_CODE",
    value: WORKDIR_REFUSAL_EXIT_CODE,
    expected: 75,
    home: "src/installer/workdir-collision.ts",
  },
];

const STORE_PATH = "/profile/stores/main.db";
const SECOND_STORE_PATH = "/profile/stores/other.db";

// ── exit-status claim scanner ───────────────────────────────────────────────
// One regex with alternation so a single site is reported exactly once:
// `process.exit(78)` must not also be counted as a bare `exit(78)`.

const EXIT_CODE_CLAIM_RE = new RegExp(
  [
    String.raw`\bprocess\s*\.\s*exit\s*\(\s*(?<processExit>\d+)\s*\)`,
    String.raw`\bprocess\s*\.\s*exitCode\s*=\s*(?<processExitCode>\d+)\b`,
    String.raw`(?<![\w.$])exit\s*\(\s*(?<exitCall>\d+)\s*\)`,
    String.raw`\b[A-Z][A-Z0-9_]*_EXIT_CODE\s*=\s*(?<namedConstant>\d+)\b`,
  ].join("|"),
  "g",
);

type ExitCodeClaim = {
  /** The numeric status the source claims. */
  code: number;
  /** Which claim form matched (`processExit`, `exitCall`, ...). */
  site: string;
  /** 1-based line number inside the comment-stripped source. */
  line: number;
  /** The exact matched text, for diagnostics. */
  snippet: string;
};

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/**
 * Report every process-status claim in one source string.
 *
 * Comments are stripped first, so prose such as "exit(78) would alias" is not
 * a claim. String literals are deliberately NOT stripped: a status spelled out
 * inside a message string is conservative-vs-loud, and this guard must never
 * miss a real claim to avoid a spurious one.
 */
function findExitCodeClaims(source: string): ExitCodeClaim[] {
  const code = stripComments(source);
  const claims: ExitCodeClaim[] = [];
  EXIT_CODE_CLAIM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXIT_CODE_CLAIM_RE.exec(code)) !== null) {
    const groups = match.groups ?? {};
    const site = Object.keys(groups).find((key) => groups[key] !== undefined);
    if (site === undefined) {
      assert.fail(`exit-code claim matched no named group: ${match[0]}`);
    }
    claims.push({
      code: Number(groups[site]),
      site,
      line: lineOf(code, match.index),
      snippet: match[0],
    });
  }
  return claims;
}

function claimedCodes(source: string): number[] {
  return findExitCodeClaims(source).map((claim) => claim.code);
}

/** All non-test TypeScript sources under `src/`, as repo-relative paths. */
function listScannedSources(dir = SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listScannedSources(abs));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      out.push(path.relative(REPO_ROOT, abs).split(path.sep).join("/"));
    }
  }
  return out.sort();
}

type LocatedClaim = ExitCodeClaim & { file: string };

/** Scan the real tree, excluding the allocating module and every test file. */
function scanRealTree(): { files: string[]; claims: LocatedClaim[] } {
  const files = listScannedSources().filter((rel) => rel !== ALLOCATING_MODULE);
  const claims: LocatedClaim[] = [];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
    for (const claim of findExitCodeClaims(source)) {
      claims.push({ ...claim, file: rel });
    }
  }
  return { files, claims };
}

// ── gate fixtures ──────────────────────────────────────────────────────────

/** A compliant present store: config delete, rollback header, clean sidecars. */
function compliantStore(
  overrides: Partial<EvaluatedStore> = {},
): EvaluatedStore {
  return {
    requestedPath: STORE_PATH,
    presence: "present",
    identity: {
      canonicalPath: STORE_PATH,
      dev: "2049",
      ino: "424242",
      fstype: "ext4",
    },
    required: true,
    config: {
      journalMode: "delete",
      source: "guest-config",
      observed: true,
    },
    header: {
      headerFormat: "rollback",
      rawBytes1819: [1, 1],
      magicOk: true,
      readable: true,
      fileSize: 4096,
    },
    sidecars: { wal: "absent", shm: "absent", journal: "absent" },
    findingCodesFromReader: [],
    ...overrides,
  };
}

/** A present store whose header is write-ahead-log: a real `wal-header` refusal. */
function walStore(
  overrides: Partial<EvaluatedStore> = {},
): EvaluatedStore {
  return compliantStore({
    header: {
      headerFormat: "wal",
      rawBytes1819: [2, 2],
      magicOk: true,
      readable: true,
      fileSize: 4096,
    },
    ...overrides,
  });
}

function gate(
  stores: EvaluatedStore[],
  overrides: Partial<GateInput> = {},
): GateInput {
  return {
    inventoryComplete: true,
    incompleteReasons: [],
    stores,
    ...overrides,
  };
}

function codeBlock(source: string, file: string): string {
  const code = stripComments(source);
  assert.ok(code.length > 0, `${file} read as empty after comment stripping`);
  return code;
}

// ── allocation proof ───────────────────────────────────────────────────────

describe("launch-gate exit-code allocation", () => {
  it("LAUNCH_GATE_REFUSAL_EXIT_CODE is 78", () => {
    assert.equal(LAUNCH_GATE_REFUSAL_EXIT_CODE, 78);
    assert.ok(Number.isInteger(LAUNCH_GATE_REFUSAL_EXIT_CODE));
  });

  it("78 differs from every recorded process status already used in src/", () => {
    for (const code of RECORDED_USED_EXIT_CODES) {
      assert.notEqual(
        LAUNCH_GATE_REFUSAL_EXIT_CODE,
        code,
        `78 must not alias the recorded process status ${code}`,
      );
    }
  });

  it("the four dedicated constants still hold 86, 87, 88 and 75", () => {
    for (const { name, value, expected, home } of DEDICATED_EXIT_CODES) {
      assert.equal(value, expected, `${name} (${home}) must still be ${expected}`);
    }
  });

  it("78 differs from all four dedicated named constants", () => {
    for (const { name, value } of DEDICATED_EXIT_CODES) {
      assert.notEqual(
        LAUNCH_GATE_REFUSAL_EXIT_CODE,
        value,
        `78 must not alias ${name}`,
      );
    }
    // The proof is only meaningful if the four are a real, distinct set.
    const dedicated = new Set(DEDICATED_EXIT_CODES.map((entry) => entry.value));
    assert.equal(dedicated.size, DEDICATED_EXIT_CODES.length);
    assert.ok(!dedicated.has(LAUNCH_GATE_REFUSAL_EXIT_CODE));
  });

  it("no other source module under src/ claims 78 (live tree scan)", () => {
    const { files, claims } = scanRealTree();

    // A broken or empty walk must never be able to pass this test.
    assert.ok(
      files.length >= 150,
      `expected to scan a real source tree, scanned ${files.length} files`,
    );
    assert.ok(
      files.includes("src/cli/commands/workflow.ts"),
      "the scan must include the workflow CLI",
    );
    assert.ok(
      !files.includes(ALLOCATING_MODULE),
      "the allocating module is the one legitimate owner and is excluded",
    );

    const offenders = claims.filter(
      (claim) => claim.code === LAUNCH_GATE_REFUSAL_EXIT_CODE,
    );
    assert.deepEqual(
      offenders,
      [],
      `another surface claims ${LAUNCH_GATE_REFUSAL_EXIT_CODE}: ` +
        offenders
          .map((claim) => `${claim.file}:${claim.line} (${claim.site}: ${claim.snippet})`)
          .join(", "),
    );

    // Sanity: the scan really does observe statuses, so "no offender" is not
    // the same thing as "the scanner found nothing at all".
    const measured = [...new Set(claims.map((claim) => claim.code))].sort(
      (a, b) => a - b,
    );
    assert.ok(measured.length >= 5, `expected several measured statuses, got ${measured}`);
    assert.ok(measured.includes(0), `the scan must observe allow (0), got ${measured}`);
    assert.ok(measured.includes(1), `the scan must observe failure (1), got ${measured}`);
  });
});

// ── scanner self-test ──────────────────────────────────────────────────────

describe("exit-status claim scanner", () => {
  it("flags every documented claim form", () => {
    const cases: { src: string; code: number; site: string }[] = [
      { src: `process.exit(78);`, code: 78, site: "processExit" },
      { src: `process.exit( 78 );`, code: 78, site: "processExit" },
      { src: `process.exitCode = 78;`, code: 78, site: "processExitCode" },
      { src: `exit(78);`, code: 78, site: "exitCall" },
      { src: `const FOO_EXIT_CODE = 78;`, code: 78, site: "namedConstant" },
      { src: `export const WORKDIR_REFUSAL_EXIT_CODE = 75;`, code: 75, site: "namedConstant" },
      { src: `process.exit(1);`, code: 1, site: "processExit" },
    ];
    for (const { src, code, site } of cases) {
      const found = findExitCodeClaims(src);
      assert.equal(found.length, 1, `expected one claim in: ${src}; got ${JSON.stringify(found)}`);
      assert.equal(found[0].code, code, `wrong code for: ${src}`);
      assert.equal(found[0].site, site, `wrong site for: ${src}`);
    }
  });

  it("reports one claim for process.exit(N), not a second for exit(N)", () => {
    const found = findExitCodeClaims(`process.exit(78);`);
    assert.equal(found.length, 1);
    assert.equal(found[0].site, "processExit");
  });

  it("does not flag a prefix or a different number", () => {
    for (const src of [
      `process.exit(178);`,
      `process.exit(780);`,
      `process.exit(7);`,
      `process.exit(0);`,
      `exit(0);`,
      `const FOO_EXIT_CODE = 178;`,
    ]) {
      const found = findExitCodeClaims(src);
      assert.ok(
        found.every((claim) => claim.code !== 78),
        `must not claim 78 for: ${src}; got ${JSON.stringify(found)}`,
      );
    }
  });

  it("ignores claims that exist only in comments (comment-blind)", () => {
    for (const src of [
      `// process.exit(78) is reserved for the launch gate\nconst a = 1;`,
      `/** NAME_EXIT_CODE = 78 is documented elsewhere */\nconst b = 2;`,
      `/* exit(78) */\nconst c = 3;`,
    ]) {
      assert.deepEqual(findExitCodeClaims(src), [], `comment-only claim in: ${src}`);
    }
  });

  it("still flags a claim spelled inside a string literal (fail closed)", () => {
    const found = findExitCodeClaims(`const message = "process.exit(78)";`);
    assert.equal(found.length, 1);
    assert.equal(found[0].code, 78);
  });

  it("reports several claims with their own line numbers", () => {
    const found = findExitCodeClaims(
      [`process.exit(0);`, `// ignored`, `process.exitCode = 1;`].join("\n"),
    );
    assert.deepEqual(
      found.map((claim) => claim.code),
      [0, 1],
    );
    assert.deepEqual(
      found.map((claim) => claim.line),
      [1, 3],
    );
  });
});

// ── mapping ────────────────────────────────────────────────────────────────

describe("verdict-to-exit mapping", () => {
  it("a real allow verdict maps to 0", () => {
    const verdict = evaluateGate(gate([compliantStore()]));
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
    assert.equal(exitCodeForGateOutcome(verdict), 0);
  });

  it("a real refuse verdict maps to 78", () => {
    const verdict = evaluateGate(gate([walStore()]));
    assert.equal(verdict.action, "refuse");
    assert.ok(
      verdict.findings.some((finding) => finding.code === "wal-header"),
      `expected a wal-header finding, got ${JSON.stringify(verdict.findings)}`,
    );
    assert.equal(exitCodeForGateOutcome(verdict), 78);
    assert.equal(exitCodeForGateOutcome(verdict), LAUNCH_GATE_REFUSAL_EXIT_CODE);
  });

  it("an operational refusal maps to 78", () => {
    const outcome: OperationalRefusal = {
      action: "operational-refusal",
      detail: "refusal receipt could not be written: EACCES",
    };
    assert.equal(exitCodeForGateOutcome(outcome), 78);
    assert.equal(exitCodeForGateOutcome(outcome), LAUNCH_GATE_REFUSAL_EXIT_CODE);
  });

  it("maps by action only, never by the number or shape of the findings", () => {
    const single = evaluateGate(gate([walStore()]));
    const double = evaluateGate(
      gate([walStore({ config: null }), walStore({ requestedPath: SECOND_STORE_PATH })]),
    );
    assert.equal(single.findings.length, 1);
    assert.ok(double.findings.length > single.findings.length);
    assert.equal(exitCodeForGateOutcome(single), 78);
    assert.equal(exitCodeForGateOutcome(double), 78);

    // A hand-built verdict is still a function of `action` alone.
    const bare: GateVerdict = { action: "refuse", findings: [] };
    assert.equal(exitCodeForGateOutcome(bare), 78);
    const allowBare: GateVerdict = { action: "allow", findings: [] };
    assert.equal(exitCodeForGateOutcome(allowBare), 0);
  });

  it("is deterministic and does not mutate the outcome", () => {
    const verdict = evaluateGate(gate([walStore()]));
    const snapshot = JSON.stringify(verdict);
    const first = exitCodeForGateOutcome(verdict);
    const second = exitCodeForGateOutcome(verdict);
    assert.equal(first, second);
    assert.equal(JSON.stringify(verdict), snapshot);
  });

  it("uses exactly two statuses across the three outcomes", () => {
    const allow = evaluateGate(gate([compliantStore()]));
    const refuse = evaluateGate(gate([walStore()]));
    const operational: OperationalRefusal = { action: "operational-refusal", detail: "x" };
    const statuses = new Set([
      exitCodeForGateOutcome(allow),
      exitCodeForGateOutcome(refuse),
      exitCodeForGateOutcome(operational),
    ]);
    assert.deepEqual([...statuses].sort((a, b) => a - b), [0, 78]);
  });

  it("throws on an outcome outside the union instead of returning 0", () => {
    const unknown = {
      action: "escalate",
      detail: "not part of the gate outcome union",
    } as unknown as GateVerdict | OperationalRefusal;
    assert.throws(
      () => exitCodeForGateOutcome(unknown),
      /unhandled gate outcome/,
    );
  });
});

// ── closed reason-code vocabulary ──────────────────────────────────────────

describe("closed reason-code vocabulary", () => {
  it("has exactly ten distinct codes", () => {
    const codes = REASON_CODE_ORDER as readonly string[];
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
  });

  it("contains no operational-refusal code", () => {
    const codes = REASON_CODE_ORDER as readonly string[];
    assert.ok(!codes.includes("operational-refusal"));
    for (const code of codes) {
      assert.ok(
        !/operational/i.test(code),
        `reason code "${code}" must not describe an operational failure`,
      );
    }
  });
});

// ── module purity ──────────────────────────────────────────────────────────

describe("gate-exit-code module purity", () => {
  function moduleCode(): string {
    return codeBlock(fs.readFileSync(MODULE_PATH, "utf8"), "gate-exit-code.ts");
  }

  it("has exactly one import and it is a type-only import of GateVerdict", () => {
    const code = moduleCode();
    const imports = code.match(/^[ \t]*import\b.*$/gm) ?? [];
    assert.equal(imports.length, 1, `expected one import, got: ${JSON.stringify(imports)}`);
    assert.match(
      imports[0].trim(),
      /^import\s+type\s+\{\s*GateVerdict\s*\}\s+from\s+"\.\/launch-gate\.js";$/,
    );
    assert.ok(!/\brequire\s*\(/.test(code), "must not call require()");
    assert.ok(!/\bnode:/.test(code), "must not import a node: builtin");
  });

  it("reads no environment, clock or randomness and never exits", () => {
    const code = moduleCode();
    for (const forbidden of [
      /\bprocess\.env\b/,
      /\bDate\b/,
      /\bMath\.random\b/,
      /\bprocess\s*\.\s*exit\b/,
      /\bprocess\s*\.\s*exitCode\b/,
    ]) {
      assert.ok(
        !forbidden.test(code),
        `gate-exit-code.ts must not match ${String(forbidden)}`,
      );
    }
  });

  it("compiled module exports the constant and the mapping, nothing more", async () => {
    const compiled = await import(
      "../../../dist/installer/matchlock/gate-exit-code.js"
    );
    assert.deepEqual(Object.keys(compiled).sort(), [
      "LAUNCH_GATE_REFUSAL_EXIT_CODE",
      "exitCodeForGateOutcome",
    ]);
    const text = fs.readFileSync(MODULE_DIST, "utf8");
    assert.ok(!/\brequire\s*\(/.test(text), "compiled module must not require anything");
    assert.ok(!/process\s*\.\s*exit/.test(text), "compiled module must not exit the process");
    assert.match(text, /LAUNCH_GATE_REFUSAL_EXIT_CODE = 78/);
  });
});

// ── CLI drift guard ────────────────────────────────────────────────────────

describe("workdir refusal code has one definition", () => {
  it("workflow.ts imports WORKDIR_REFUSAL_EXIT_CODE from installer/workdir-collision.js", () => {
    const source = fs.readFileSync(WORKFLOW_CLI, "utf8");
    const block = source.match(
      /import\s*\{[^}]*\}\s*from\s*"\.\.\/\.\.\/installer\/workdir-collision\.js";/,
    );
    assert.ok(
      block,
      "workflow.ts must import from ../../installer/workdir-collision.js",
    );
    assert.match(block[0], /\bWORKDIR_REFUSAL_EXIT_CODE\b/);
    assert.ok(
      !/^\s*(?:export\s+)?const\s+WORKDIR_REFUSAL_EXIT_CODE\b/m.test(source),
      "workflow.ts must not declare its own WORKDIR_REFUSAL_EXIT_CODE",
    );
  });
});

// ── lane classification ────────────────────────────────────────────────────

describe("lane classification", () => {
  it("this test file is NOT listed in tests/serial-files.txt (pure, parallel lane)", () => {
    const listed = fs
      .readFileSync(SERIAL_FILES, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.ok(
      !listed.includes(THIS_FILE),
      `${THIS_FILE} reads source text and imports pure modules; it must stay in the parallel lane`,
    );
    assert.ok(!listed.includes(ALLOCATING_MODULE));
  });
});
