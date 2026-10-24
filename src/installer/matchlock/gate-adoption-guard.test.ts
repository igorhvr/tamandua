/**
 * gate-adoption-guard tests (G8 ADMISSION-INTEGRATION, story US-008).
 *
 * WHY THIS FILE EXISTS
 *
 * G9 already owns the launch gate's operator contract: one process status
 * (`src/installer/matchlock/gate-exit-code.ts`) and one remedy renderer
 * (`src/installer/matchlock/gate-remedy-text.ts`). G8 wires that contract into
 * four callers. Consumption is a promise that decays silently: the next
 * surface can spell `78` itself, hand-write "set journal_mode=delete" in its
 * own words, or grow an eleventh reason code, and every behavioural test still
 * passes because each new surface is internally consistent. This guard is the
 * structural pin. It does not re-test the evaluator (G9's suites do that); it
 * proves the WIRING consumes G9 rather than re-inventing it.
 *
 * FOUR PROPERTIES, EACH ABLE TO FAIL ON ITS OWN
 *
 *  1. ONE EXIT-STATUS OWNER. Every non-test TypeScript file under `src/` is
 *     scanned (comment-blind) for the ways this tree spells a process status:
 *     `process.exit(N)`, `process.exitCode = N`, a bare `exit(N)`, a
 *     `NAME_EXIT_CODE = N` declaration, and the refusal-shaped `exitCode: N`,
 *     `exitCode = N` and `exitCode === N` forms. No file except
 *     `gate-exit-code.ts` may claim 78. The allocation itself is verified in
 *     the owner so the scan cannot pass by finding nothing, and the scanner is
 *     unit-tested with synthetic sources so a broken regex cannot pass by
 *     finding nothing either.
 *
 *  2. EVERY GATE SURFACE CONSUMES G9. The set of non-test files that import
 *     `gate-exit-code.js` is pinned to an explicit manifest: the wiring core,
 *     the interactive adapter and the CLI. Each manifest entry names the
 *     symbols it is required to import, and the mapping function
 *     `exitCodeForGateOutcome` may be called from exactly the two modules that
 *     turn a decision into a status — never from a caller that should only
 *     propagate one. A fourth importer is a test failure, not a silent second
 *     owner; the failure message says what to do about it.
 *
 *     The scheduled adapter is deliberately NOT an exit-status surface: it
 *     never turns a verdict into a status, it forwards the wiring's own
 *     `refusal.exitCode` into its receipt-backed event. That "propagate, never
 *     re-derive" property is asserted separately, so the manifest cannot grow
 *     a fake entry just to make the import set match.
 *
 *  3. THE REASON-CODE SET STAYS CLOSED AT TEN. `REASON_CODE_ORDER` is asserted
 *     element for element and in order, declared exactly once in the tree, and
 *     `operational-refusal` is proven to be a separate class: it is not one of
 *     the ten, yet it maps to the same process status. An eleventh code — or
 *     renumbering "receipt write failed" into the vocabulary — fails here.
 *
 *  4. REFUSAL TEXT HAS ONE RENDERER. The interactive adapter must call
 *     `renderGateRemedyText` and return its output first; the CLI must import
 *     the adapter's renderer, must not import the remedy module directly, and
 *     its refusal branch must add no remedy prose of its own (no reason-code
 *     literal, no journal-mode instruction, no duplicated header). The CLI
 *     exits with the refusal's own `exitCode` field, never a number.
 *
 * WHAT IS *NOT* ASSERTED HERE. Behaviour — a refusal creating no VM, the
 * receipt being written first, the backstop binding, the scheduled no-re-dispatch
 * state — belongs to `launch-gate-*.test.ts` and `launch-gate-integration.test.ts`.
 * This file is the adoption pin only, so it reads source text and pure dist
 * modules.
 *
 * LANE. Pure `node:fs` source reads plus pure dist imports: no child_process,
 * no daemon, no VM. It belongs to the PARALLEL lane and the last test asserts
 * it is not listed in `tests/serial-files.txt` (importing the interactive
 * adapter for real would pull its spawn-capable holder probe, which is why the
 * adapter's rendered output is pinned structurally here and behaviourally in
 * `launch-gate-interactive.test.ts`).
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
  type Finding,
  type GateVerdict,
  type ReasonCode,
} from "../../../dist/installer/matchlock/launch-gate.js";
import { renderGateRemedyText } from "../../../dist/installer/matchlock/gate-remedy-text.js";
import type { HolderDetection } from "../../../dist/installer/matchlock/store-holder-detect.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const SERIAL_FILES = path.join(REPO_ROOT, "tests", "serial-files.txt");

/** This file's own repo-relative path, always with forward slashes. */
const THIS_FILE = "src/installer/matchlock/gate-adoption-guard.test.ts";

/** The ONE module allowed to own the refusal process status. */
const EXIT_CODE_OWNER = "src/installer/matchlock/gate-exit-code.ts";

/** The ONE module allowed to render operator-facing refusal remedies. */
const REMEDY_OWNER = "src/installer/matchlock/gate-remedy-text.ts";

/** The ONE module allowed to declare the canonical reason-code order. */
const REASON_CODE_OWNER = "src/installer/matchlock/launch-gate.ts";

/**
 * The documented closed vocabulary, in the evaluator's canonical order.
 *
 * Written out rather than imported so this file pins the CONTRACT: importing
 * `REASON_CODE_ORDER` and comparing it to itself would be a tautology, and a
 * silently added eleventh code would sail through.
 */
const DOCUMENTED_REASON_CODES: readonly ReasonCode[] = [
  "not-delete-config",
  "wal-header",
  "header-unreadable",
  "header-not-sqlite",
  "header-truncated",
  "sidecar-unresolved",
  "store-missing",
  "inventory-incomplete",
  "path-unresolved",
  "permission-denied",
];

/** The action string of the operational class: never a reason code. */
const OPERATIONAL_ACTION = "operational-refusal";

/**
 * Every non-test surface allowed to import the exit-code allocation, and the
 * symbols it is required to consume.
 *
 * A surface is listed here when it PRODUCES a process status from a gate
 * outcome: the wiring computes the refusal's `exitCode`, the interactive
 * adapter maps its own anchor-failure refusal, and the CLI exits with the
 * value. Modules that merely forward a decision (the scheduled adapter) or
 * never see one (the revalidation module, the controller backstop) are not
 * entries, and the "never an exit owner" test below pins that.
 */
interface ExitStatusSurface {
  /** Repo-relative path. */
  file: string;
  /** Symbols the file's `gate-exit-code.js` import must provide. */
  symbols: readonly ("exitCodeForGateOutcome" | "LAUNCH_GATE_REFUSAL_EXIT_CODE")[];
  /** Why this surface produces a status at all. */
  responsibility: string;
}

/** The wiring core: computes the refusal's exitCode from the outcome. */
const WIRING_SURFACE = "src/installer/matchlock/launch-gate-wiring.ts";

/** The interactive adapter: maps its own admission-anchor failure. */
const INTERACTIVE_SURFACE = "src/installer/matchlock/launch-gate-interactive.ts";

const EXIT_STATUS_SURFACES: readonly ExitStatusSurface[] = [
  {
    file: WIRING_SURFACE,
    symbols: ["exitCodeForGateOutcome"],
    responsibility: "maps the verdict / operational class to the refusal's exitCode",
  },
  {
    file: INTERACTIVE_SURFACE,
    symbols: ["exitCodeForGateOutcome"],
    responsibility: "maps the interactive admission-anchor failure to its own refusal",
  },
  {
    file: "src/cli/commands/matchlock.ts",
    symbols: ["LAUNCH_GATE_REFUSAL_EXIT_CODE"],
    responsibility: "prints the status in help and exits with the refusal's own code",
  },
];

/**
 * The modules that must never become exit owners.
 *
 * The scheduled adapter propagates; the revalidation module reports a change
 * and lets the wiring refuse; the controller backstop refuses through a typed
 * error and does not evaluate at all. Naming them here means a future edit
 * that reaches for a process status in one of them fails with its own message
 * instead of a generic scan hit.
 */
const NEVER_AN_EXIT_OWNER: readonly { file: string; why: string }[] = [
  {
    file: "src/installer/matchlock/launch-gate-scheduled.ts",
    why: "forwards the wiring's refusal.exitCode into the run event; it must not re-derive a status",
  },
  {
    file: "src/installer/matchlock/launch-gate-revalidate.ts",
    why: "reports whether the store set or config changed; the wiring owns the refusal",
  },
  {
    file: "src/installer/matchlock/controller.ts",
    why: "the backstop refuses via a typed error immediately before VM create; it does not re-evaluate",
  },
];

// ── repo access ────────────────────────────────────────────────────────────

function repoPath(relative: string): string {
  return path.join(REPO_ROOT, relative);
}

function readSource(relative: string): string {
  return fs.readFileSync(repoPath(relative), "utf8");
}

/** Comment-stripped source: prose about a status is not a status claim. */
function codeOf(relative: string): string {
  return stripComments(readSource(relative));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** All non-test TypeScript sources under `src/`, as repo-relative paths. */
function listNonTestSources(dir = SRC_DIR): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listNonTestSources(abs));
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

/** Sorted list of `tests/serial-files.txt` entries, comments removed. */
function serialLaneFiles(): string[] {
  return fs
    .readFileSync(SERIAL_FILES, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

// ── process-status claim scanner ───────────────────────────────────────────
//
// One alternation so a single site is reported exactly once:
// `process.exitCode = 78` must not also be counted as `exitCode = 78`.

const EXIT_STATUS_CLAIM_RE = new RegExp(
  [
    // process.exit(78)
    String.raw`\bprocess\s*\.\s*exit\s*\(\s*(?<processExit>\d+)\s*\)`,
    // process.exitCode = 78
    String.raw`\bprocess\s*\.\s*exitCode\s*=\s*(?<processExitCode>\d+)\b`,
    // a bare exit(78) in a CLI surface (lookbehind keeps process.exit(78) single)
    String.raw`(?<![\w.$])exit\s*\(\s*(?<exitCall>\d+)\s*\)`,
    // const NAME_EXIT_CODE = 78
    String.raw`\b[A-Z][A-Z0-9_]*_EXIT_CODE\s*=\s*(?<namedConstant>\d+)\b`,
    // { exitCode: 78 } — the refusal/receipt field shape
    String.raw`\bexitCode\s*:\s*(?<exitCodeField>\d+)\b`,
    // exitCode = 78 (lowercase assignment, not a named constant)
    String.raw`\b(?<!\.)exitCode\s*=\s*(?<exitCodeAssignment>\d+)\b`,
    // exitCode === 78 / exitCode == 78
    String.raw`\bexitCode\s*===?\s*(?<exitCodeComparison>\d+)\b`,
  ].join("|"),
  "g",
);

interface ExitStatusClaim {
  /** The numeric status the source claims. */
  code: number;
  /** Which claim form matched (a named-group name). */
  site: string;
  /** 1-based line number inside the comment-stripped source. */
  line: number;
  /** The exact matched text, for diagnostics. */
  snippet: string;
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

/**
 * Report every process-status claim in one source string.
 *
 * Comments are stripped first. String literals are deliberately NOT stripped:
 * a status spelled out inside a message is conservative-vs-loud, and this
 * guard must never miss a real claim to avoid a spurious one.
 */
function findExitStatusClaims(source: string): ExitStatusClaim[] {
  const code = stripComments(source);
  const claims: ExitStatusClaim[] = [];
  EXIT_STATUS_CLAIM_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = EXIT_STATUS_CLAIM_RE.exec(code)) !== null) {
    const groups = match.groups ?? {};
    const site = Object.keys(groups).find((key) => groups[key] !== undefined);
    if (site === undefined) {
      assert.fail(`process-status claim matched no named group: ${match[0]}`);
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
  return findExitStatusClaims(source).map((claim) => claim.code);
}

/** Format a located claim for an assertion message. */
function describeClaim(file: string, claim: ExitStatusClaim): string {
  return `${file}:${claim.line} (${claim.site}) ${claim.snippet}`;
}

// ── import inspection ──────────────────────────────────────────────────────

/**
 * Symbols one source file imports from a module, matched by the module's file
 * name (`gate-exit-code.js`), so both `./x.js` and `../../installer/x.js`
 * spellings resolve. `import type { ... }` and inline `type` specifiers are
 * unwrapped; aliases report the imported name.
 */
function importedSymbols(relative: string, moduleFile: string): string[] {
  const pattern = new RegExp(
    String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'][^"']*` +
      escapeRegExp(moduleFile) +
      String.raw`["']`,
    "g",
  );
  const symbols: string[] = [];
  for (const match of codeOf(relative).matchAll(pattern)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim() ?? "";
      if (name !== "") symbols.push(name);
    }
  }
  return symbols;
}

/** True when the file imports the module at all (even for a type only). */
function importsModule(relative: string, moduleFile: string): boolean {
  return importedSymbols(relative, moduleFile).length > 0;
}

/** Non-test files whose source imports `gate-exit-code.js`. */
function exitCodeImporters(): string[] {
  return listNonTestSources().filter((file) => importsModule(file, "gate-exit-code.js"));
}

/** Non-test files declaring `const REASON_CODE_ORDER = ...` (local copies included). */
function reasonCodeOrderDeclarations(): string[] {
  const pattern = /(?<![\w$])const\s+REASON_CODE_ORDER\s*=/;
  return listNonTestSources().filter((file) => pattern.test(codeOf(file)));
}

/** Non-test files declaring a function with this exact name. */
function functionDeclarations(name: string): string[] {
  const pattern = new RegExp(String.raw`\b(?:export\s+)?function\s+${escapeRegExp(name)}\s*\(`);
  return listNonTestSources().filter((file) => pattern.test(codeOf(file)));
}

/** Non-test files declaring an `const NAME = <n>` for the given constant. */
function constantDeclarations(name: string): string[] {
  const pattern = new RegExp(String.raw`\b(?:export\s+)?const\s+${escapeRegExp(name)}\b\s*=`);
  return listNonTestSources().filter((file) => pattern.test(codeOf(file)));
}

/**
 * The comment-stripped text from `startMarker` up to (not including)
 * `endMarker`; to end-of-file when no end marker is given.
 *
 * Anchored deliberately: if a surface is restructured so a marker disappears,
 * the guard fails with a message naming the marker rather than silently
 * scanning an empty or wrong window.
 */
function blockBetween(relative: string, startMarker: string, endMarker?: string): string {
  const code = codeOf(relative);
  const start = code.indexOf(startMarker);
  assert.notEqual(
    start,
    -1,
    `${relative} no longer contains ${JSON.stringify(startMarker)}; this guard anchors the ` +
      `adoption assertions on it — update gate-adoption-guard.test.ts deliberately`,
  );
  if (endMarker === undefined) return code.slice(start);
  const end = code.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(
    end,
    -1,
    `${relative} no longer contains ${JSON.stringify(endMarker)} after ` +
      `${JSON.stringify(startMarker)}; update gate-adoption-guard.test.ts deliberately`,
  );
  return code.slice(start, end);
}

/** Vocabulary that only the remedy renderer may own. */
const REMEDY_VOCABULARY: readonly string[] = [
  ...DOCUMENTED_REASON_CODES,
  "journal_mode",
  "PRAGMA",
  "checkpoint",
  "rollback-format",
];

/** Which forbidden words a text contains, for assertion messages. */
function remedyVocabularyHits(text: string): string[] {
  return REMEDY_VOCABULARY.filter((word) => text.includes(word));
}

// ── gate fixtures for the renderer ─────────────────────────────────────────

const NO_HOLDERS: HolderDetection = {
  observationComplete: true,
  holders: [],
  probeFailures: [],
};

/** A finding whose `detail`/remedy carry no extra copy of the code. */
function findingFor(code: ReasonCode): Finding {
  return {
    code,
    store: "/profile/stores/main.db",
    detail: "recorded evidence",
    remedy: [{ description: "apply the documented remedy" }],
  };
}

function verdictWith(findings: Finding[]): GateVerdict {
  return { action: "refuse", findings };
}

function remedyText(findings: Finding[], guestConfigPath: string | null = null): string {
  return renderGateRemedyText({
    verdict: verdictWith(findings),
    holderDetection: NO_HOLDERS,
    stores: [],
    relaunchCommand: "tamandua matchlock hermes",
    guestConfigPath,
  });
}

// ===========================================================================
// 1. ONE EXIT-STATUS OWNER
// ===========================================================================

describe("gate-adoption-guard: one exit-status owner", () => {
  it("the owner still allocates 78 through the constant the wiring imports", () => {
    assert.equal(LAUNCH_GATE_REFUSAL_EXIT_CODE, 78);
    assert.ok(Number.isInteger(LAUNCH_GATE_REFUSAL_EXIT_CODE));

    const claims = findExitStatusClaims(readSource(EXIT_CODE_OWNER));
    assert.ok(
      claims.some(
        (claim) => claim.code === LAUNCH_GATE_REFUSAL_EXIT_CODE && claim.site === "namedConstant",
      ),
      `the scanner must see the allocation in ${EXIT_CODE_OWNER}; found ` +
        JSON.stringify(claims.map((claim) => `${claim.site}:${claim.code}`)),
    );
  });

  it("the scan covers the real tree and is not vacuous", () => {
    const files = listNonTestSources();
    assert.ok(files.length > 100, `expected a real tree, scanned ${files.length} files`);
    for (const mustBeScanned of [
      EXIT_CODE_OWNER,
      REMEDY_OWNER,
      REASON_CODE_OWNER,
      "src/installer/matchlock/launch-gate-wiring.ts",
      "src/installer/matchlock/launch-gate-interactive.ts",
      "src/installer/matchlock/launch-gate-scheduled.ts",
      "src/installer/matchlock/controller.ts",
      "src/cli/commands/matchlock.ts",
    ]) {
      assert.ok(files.includes(mustBeScanned), `${mustBeScanned} must be in the scanned set`);
    }
    assert.equal(
      files.filter((file) => file.endsWith(".test.ts")).length,
      0,
      "test files are excluded from the claim scan",
    );

    // The tree really does claim process statuses elsewhere; a regex that
    // stopped matching would otherwise pass this file by finding nothing.
    const totalClaims = files.reduce(
      (sum, file) => sum + findExitStatusClaims(readSource(file)).length,
      0,
    );
    assert.ok(totalClaims > 10, `expected real exit-status claims in the tree, found ${totalClaims}`);
  });

  it("no non-test source other than gate-exit-code.ts spells 78 as an exit status", () => {
    const offenders: string[] = [];
    for (const file of listNonTestSources()) {
      if (file === EXIT_CODE_OWNER) continue;
      for (const claim of findExitStatusClaims(readSource(file))) {
        if (claim.code === LAUNCH_GATE_REFUSAL_EXIT_CODE) offenders.push(describeClaim(file, claim));
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "the launch-gate refusal status must be spelled ONLY through gate-exit-code.ts; " +
        "import LAUNCH_GATE_REFUSAL_EXIT_CODE / exitCodeForGateOutcome instead of writing " +
        `the number. Offenders:\n  ${offenders.join("\n  ")}`,
    );
  });

  it("LAUNCH_GATE_REFUSAL_EXIT_CODE is declared exactly once in the tree", () => {
    assert.deepEqual(
      constantDeclarations("LAUNCH_GATE_REFUSAL_EXIT_CODE"),
      [EXIT_CODE_OWNER],
      "a second declaration re-allocates the status; the constant has one home",
    );
  });

  it("the scanner detects every claim form and ignores comments and near-misses", () => {
    const detected: readonly { source: string; code: number; site: string }[] = [
      { source: "process.exit(78)", code: 78, site: "processExit" },
      { source: "process.exitCode = 78;", code: 78, site: "processExitCode" },
      { source: "exit(78);", code: 78, site: "exitCall" },
      { source: "const FOO_EXIT_CODE = 78;", code: 78, site: "namedConstant" },
      { source: "const refusal = { exitCode: 78 };", code: 78, site: "exitCodeField" },
      { source: "exitCode = 78;", code: 78, site: "exitCodeAssignment" },
      { source: "if (process.exitCode === 78) {}", code: 78, site: "exitCodeComparison" },
      { source: "if (exitCode == 78) {}", code: 78, site: "exitCodeComparison" },
      { source: "const x = 1; process.exit(3);", code: 3, site: "processExit" },
    ];
    for (const sample of detected) {
      const claims = findExitStatusClaims(sample.source);
      assert.equal(
        claims.length,
        1,
        `expected exactly one claim in ${JSON.stringify(sample.source)}, got ${JSON.stringify(claims)}`,
      );
      const claim = claims[0];
      assert.ok(claim !== undefined, `expected a claim in ${JSON.stringify(sample.source)}`);
      assert.equal(claim.code, sample.code, sample.source);
      assert.equal(claim.site, sample.site, sample.source);
    }

    const notClaims: readonly string[] = [
      "// process.exit(78) is documented elsewhere",
      "/* exit(78) stays owned by gate-exit-code.ts */",
      "const TIMEOUT_PORT = 78;",
      "const status = LAUNCH_GATE_REFUSAL_EXIT_CODE;",
      "exit(error.exitCode);",
      "if (exitCode === LAUNCH_GATE_REFUSAL_EXIT_CODE) {}",
    ];
    for (const source of notClaims) {
      assert.deepEqual(
        claimedCodes(source),
        [],
        `${JSON.stringify(source)} must not be read as a process-status claim`,
      );
    }

    // Near-misses ARE claims of some other status; the guard must not confuse
    // them with the launch gate's own number.
    for (const nearMiss of ["exit(178);", "exit(780);", "process.exit(7_8);"]) {
      assert.equal(
        claimedCodes(nearMiss).includes(LAUNCH_GATE_REFUSAL_EXIT_CODE),
        false,
        `${JSON.stringify(nearMiss)} must not be read as a claim of the launch gate status`,
      );
    }
  });
});

// ===========================================================================
// 2. EVERY GATE SURFACE CONSUMES G9
// ===========================================================================

describe("gate-adoption-guard: every gate surface consumes G9", () => {
  it("exactly the documented surfaces import gate-exit-code.js", () => {
    const expected = EXIT_STATUS_SURFACES.map((surface) => surface.file).sort();
    const actual = exitCodeImporters();
    assert.deepEqual(
      actual,
      expected,
      "the set of files consuming G9's exit-code allocation changed. If this is a NEW gate " +
        "surface, add it to EXIT_STATUS_SURFACES with the symbols it must import, and make it " +
        "consume exitCodeForGateOutcome / LAUNCH_GATE_REFUSAL_EXIT_CODE instead of spelling a " +
        "status. If a surface stopped importing G9, it must not compute a status at all.",
    );
  });

  for (const surface of EXIT_STATUS_SURFACES) {
    it(`${surface.file} imports ${surface.symbols.join(" + ")} (${surface.responsibility})`, () => {
      const imported = importedSymbols(surface.file, "gate-exit-code.js");
      for (const symbol of surface.symbols) {
        assert.ok(
          imported.includes(symbol),
          `${surface.file} must import ${symbol} from gate-exit-code.js; ` +
            `it imports ${JSON.stringify(imported)}`,
        );
      }
    });
  }

  it("the mapping function is called from exactly the two adapters that compute a status", () => {
    // The owner DECLARES the mapping; a caller uses it. Excluding the owner is
    // what makes this a call-site scan rather than a declaration scan.
    const callers = listNonTestSources()
      .filter((file) => file !== EXIT_CODE_OWNER)
      .filter((file) => /\bexitCodeForGateOutcome\s*\(/.test(codeOf(file)));
    assert.deepEqual(
      callers.sort(),
      [
        "src/installer/matchlock/launch-gate-interactive.ts",
        "src/installer/matchlock/launch-gate-wiring.ts",
      ],
      "the outcome -> status mapping has one implementation; only the adapters that produce a " +
        "refusal may call it",
    );
    // Importing the symbol without ever using it would satisfy an import-only
    // check while leaving a surface with no mapping at all.
    assert.ok(
      callers.includes(WIRING_SURFACE) && callers.includes(INTERACTIVE_SURFACE),
      "both adapter entries in the manifest must be real call sites",
    );
  });

  it("the scheduled adapter propagates the wiring's exit code and never re-derives one", () => {
    const file = "src/installer/matchlock/launch-gate-scheduled.ts";
    const code = codeOf(file);
    assert.equal(
      importsModule(file, "gate-exit-code.js"),
      false,
      "the scheduled adapter must forward refusal.exitCode, not compute a status of its own",
    );
    assert.deepEqual(claimedCodes(readSource(file)), [], "no process-status claim belongs here");
    assert.match(
      code,
      /exitCode:\s*typeof\s+refusal\?\.exitCode\s*===\s*"number"\s*\?\s*refusal\.exitCode\s*:\s*undefined/,
      "the refusal event must carry the wiring's own refusal.exitCode (and omit it when absent)",
    );
    assert.match(
      code,
      /exitCode:\s*refusal\?\.exitCode/,
      "the refusal log line must carry the same value the event records",
    );
  });

  it("modules that only report or refuse via a typed error are never exit owners", () => {
    for (const entry of NEVER_AN_EXIT_OWNER) {
      const source = readSource(entry.file);
      assert.equal(
        importsModule(entry.file, "gate-exit-code.js"),
        false,
        `${entry.file} must not import the exit-code allocation: ${entry.why}`,
      );
      assert.deepEqual(
        claimedCodes(source),
        [],
        `${entry.file} must not claim a process status (${entry.why}); found ` +
          JSON.stringify(
            findExitStatusClaims(source).map((claim) => `${claim.site}:${claim.code}`),
          ),
      );
      assert.doesNotMatch(
        stripComments(source),
        /\bprocess\s*\.\s*exit\s*\(/,
        `${entry.file} must not exit the process: ${entry.why}`,
      );
    }
  });

  it("the wiring core and the two non-CLI adapters carry no status literal of any value", () => {
    for (const file of [
      "src/installer/matchlock/launch-gate-wiring.ts",
      "src/installer/matchlock/launch-gate-interactive.ts",
      "src/installer/matchlock/launch-gate-revalidate.ts",
      "src/installer/matchlock/launch-gate-scheduled.ts",
    ]) {
      const claims = findExitStatusClaims(readSource(file));
      assert.deepEqual(
        claims.map((claim) => describeClaim(file, claim)),
        [],
        `${file} must carry no numeric process status; map through G9 instead`,
      );
    }
  });
});

// ===========================================================================
// 3. THE REASON-CODE SET STAYS CLOSED AT TEN
// ===========================================================================

describe("gate-adoption-guard: the reason-code set stays closed at ten", () => {
  it("REASON_CODE_ORDER is exactly the ten documented codes, in order", () => {
    assert.deepEqual([...REASON_CODE_ORDER], [...DOCUMENTED_REASON_CODES]);
    assert.equal(REASON_CODE_ORDER.length, 10);
    assert.equal(new Set(REASON_CODE_ORDER).size, 10, "codes are unique");
    for (const code of REASON_CODE_ORDER) {
      assert.equal(typeof code, "string");
    }
  });

  it("the canonical order is declared exactly once in the tree", () => {
    assert.deepEqual(
      reasonCodeOrderDeclarations(),
      [REASON_CODE_OWNER],
      "a second REASON_CODE_ORDER is a second vocabulary; the evaluator owns the only one",
    );
  });

  it("the operational class is not a reason code but shares the refusal status", () => {
    const codes = REASON_CODE_ORDER as readonly string[];
    assert.equal(codes.includes(OPERATIONAL_ACTION), false);
    for (const code of codes) {
      assert.equal(
        code.includes("operational"),
        false,
        `${code} must not smuggle the operational class into the closed vocabulary`,
      );
    }

    const operational: OperationalRefusal = {
      action: OPERATIONAL_ACTION,
      detail: "the refusal receipt could not be written",
    };
    assert.equal(exitCodeForGateOutcome(operational), LAUNCH_GATE_REFUSAL_EXIT_CODE);
    // ... and it is still not addressable as a reason code.
    assert.equal((codes as readonly string[]).includes(operational.action), false);
  });

  it("every reason code maps to the one refusal status and allow maps to zero", () => {
    assert.equal(exitCodeForGateOutcome({ action: "allow", findings: [] }), 0);
    const allFindings = DOCUMENTED_REASON_CODES.map((code) => findingFor(code));
    assert.equal(exitCodeForGateOutcome(verdictWith(allFindings)), LAUNCH_GATE_REFUSAL_EXIT_CODE);
    for (const code of DOCUMENTED_REASON_CODES) {
      assert.equal(exitCodeForGateOutcome(verdictWith([findingFor(code)])), LAUNCH_GATE_REFUSAL_EXIT_CODE);
    }
  });

  it("the remedy renderer covers every one of the ten codes, in canonical order", () => {
    const all = remedyText(DOCUMENTED_REASON_CODES.map((code) => findingFor(code)));
    const rendered = [...all.matchAll(/finding \[([a-z-]+)\]/g)].map((match) => match[1]);
    assert.deepEqual(rendered, [...DOCUMENTED_REASON_CODES]);
    for (const code of DOCUMENTED_REASON_CODES) {
      assert.ok(all.includes(code), `rendered text must name ${code}`);
    }
    // The header states the closure in the operator's own words, so a refusal
    // never implies an eleventh code could appear later.
    assert.match(all, /The ten reason codes are closed/);
  });
});

// ===========================================================================
// 4. REFUSAL TEXT HAS ONE RENDERER
// ===========================================================================

describe("gate-adoption-guard: refusal text has one renderer", () => {
  it("renderGateRemedyText is declared exactly once in the tree", () => {
    assert.deepEqual(
      functionDeclarations("renderGateRemedyText"),
      [REMEDY_OWNER],
      "a second renderer would produce text that can disagree with the verdict",
    );
  });

  it("the interactive adapter imports G9's renderer and returns its text first", () => {
    const file = "src/installer/matchlock/launch-gate-interactive.ts";
    assert.ok(
      importedSymbols(file, "gate-remedy-text.js").includes("renderGateRemedyText"),
      "the interactive adapter must render refusals through gate-remedy-text.js",
    );

    const renderer = blockBetween(
      file,
      "export function renderInteractiveLaunchGateRefusal",
    );
    assert.match(
      renderer,
      /const remedyText = renderGateRemedyText\(\{/,
      "the renderer's output must be captured from G9, not assembled inline",
    );
    assert.match(
      renderer,
      /return \[\s*remedyText,/,
      "G9's remedy text must be the FIRST section of the refusal output",
    );
    assert.deepEqual(
      remedyVocabularyHits(renderer),
      [],
      "the interactive adapter must add no remedy prose of its own (the ten codes and journal " +
        "instructions belong to gate-remedy-text.ts)",
    );
  });

  it("the CLI imports the adapter's renderer, not the remedy module", () => {
    const file = "src/cli/commands/matchlock.ts";
    assert.ok(
      importedSymbols(file, "launch-gate-interactive.js").includes(
        "renderInteractiveLaunchGateRefusal",
      ),
      "the CLI must render refusals through the interactive adapter's renderer",
    );
    assert.equal(
      importsModule(file, "gate-remedy-text.js"),
      false,
      "the CLI must not reach past the adapter to the remedy renderer",
    );
    assert.deepEqual(
      functionDeclarations("renderGateRemedyText").filter((declared) => declared === file),
      [],
      "the CLI must not declare a renderer of its own",
    );
  });

  it("the CLI refusal branch prints G9's text and exits with the refusal's own code", () => {
    const file = "src/cli/commands/matchlock.ts";
    const branch = blockBetween(
      file,
      "error instanceof LaunchGateRefusalError",
      "error instanceof MatchlockSessionUnavailableError",
    );

    assert.equal(
      [...branch.matchAll(/renderInteractiveLaunchGateRefusal\s*\(/g)].length,
      1,
      "the refusal branch must call the one renderer exactly once",
    );
    assert.match(
      branch,
      /renderInteractiveLaunchGateRefusal\(\s*error\.refusal\b/,
      "the CLI must render the RECORDED refusal, never a re-derived one",
    );
    assert.match(
      branch,
      /exit\(\s*error\.exitCode\s*\)/,
      "the CLI must exit with the refusal's own exitCode field, never a number",
    );
    assert.equal(
      branch.includes("MATCHLOCK LAUNCH GATE"),
      false,
      "the refusal header belongs to gate-remedy-text.ts; the CLI must not duplicate it",
    );
    assert.deepEqual(
      remedyVocabularyHits(branch),
      [],
      "the CLI refusal branch must add no remedy prose (reason codes and journal instructions " +
        "belong to gate-remedy-text.ts)",
    );
  });

  it("G9's renderer is the source of the refusal header the CLI prints", () => {
    const text = remedyText([findingFor("wal-header")]);
    assert.match(text, /^MATCHLOCK LAUNCH GATE: LAUNCH REFUSED/);
    assert.match(text, /wal-header/, "the renderer names the failing code");
    assert.match(text, /RELAUNCH/, "the renderer owns the relaunch section");
    // The adapter appends the refusal detail and receipt AFTER the remedy
    // block; the CLI prints that whole string unchanged. Asserted structurally
    // above because importing the adapter would drag in its process probe.
    const renderer = blockBetween(
      "src/installer/matchlock/launch-gate-interactive.ts",
      "export function renderInteractiveLaunchGateRefusal",
    );
    assert.match(renderer, /`REFUSAL: \$\{detail\}`/);
    assert.match(renderer, /`RECEIPT: \$\{receiptPath\}\$\{receiptState\}`/);
  });
});

// ===========================================================================
// LANE
// ===========================================================================

describe("gate-adoption-guard: lane", () => {
  it("runs in the parallel lane (source reads and pure dist imports only)", () => {
    assert.equal(
      serialLaneFiles().includes(THIS_FILE),
      false,
      `${THIS_FILE} spawns nothing; keep it out of tests/serial-files.txt`,
    );
    // Built by concatenation so this assertion's own source cannot satisfy the
    // needle it searches for (the classifier guard is the authority here; this
    // is a local sanity check).
    const childProcessModule = "node:" + "child_process";
    assert.equal(
      codeOf(THIS_FILE).includes(childProcessModule),
      false,
      "the adoption guard must stay spawn-free (no child_process import)",
    );
  });
});
