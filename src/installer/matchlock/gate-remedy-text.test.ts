/**
 * gate-remedy-text tests (G9 EXIT-CODE-AND-REMEDIES, story US-003).
 *
 * These tests exercise `renderGateRemedyText` in
 * src/installer/matchlock/gate-remedy-text.ts. They import the COMPILED module
 * from dist/ (repo convention for this directory), so `npm run build` must run
 * first.
 *
 * WHAT THE TESTS PIN
 *
 *  - One section per failing store, in the evaluator's finding order, with
 *    that store's own path, codes and remedy — never one boilerplate blob.
 *  - Codes inside a section follow the evaluator's REASON_CODE_ORDER. The
 *    renderer cannot import that value (it must stay dependency-free at
 *    runtime), so the behavioural assertion below is what keeps its local copy
 *    honest.
 *  - A holder is attributed to the store it holds by EITHER spelling: a
 *    detection that recorded the canonical path is matched against the store
 *    whose identity carries it, and the real pid is named in that section.
 *  - Command descriptions are re-sanitized at the rendering boundary: `sk-`
 *    credentials, `Bearer` values, credential-named `name=value` pairs and the
 *    space-separated flag form are redacted, control characters are stripped,
 *    the text is bounded, and no `pkill`/`killall` text survives.
 *  - A failed holder probe is INFORMATIONAL: it is reported with its scope and
 *    reason, it adds no finding and it does not change the counts or the
 *    verdict.
 *  - The three sidecar cases stay distinct: a `-wal` checkpoint is legitimate,
 *    a `-journal` is a rollback journal whose refusal may be TRANSIENT and for
 *    which a checkpoint is NOT a treatment, and a `-shm` without `-wal` is
 *    reported only (never diagnosed as corruption or inconsistency).
 *  - All ten reason codes render non-empty remedy text.
 *  - Rendering is deterministic: repeated calls are byte-identical, and the
 *    output carries no timestamp.
 *  - GOLDEN DOCUMENTS: the scenarios in `test-fixtures/gate-remedy-text/` are
 *    compared byte for byte. Their verdicts come from the REAL evaluator
 *    (`evaluateGate`), so the text and the decision cannot drift apart. The
 *    expected documents were AUTHORED from GATE-IMPLEMENTATION-SPEC.md
 *    sections 8 and 11 (see the per-case semantic assertions below, which pin
 *    the phrases each document must carry), never dumped from the renderer and
 *    blessed. Run `UPDATE_GATE_REMEDY_GOLDEN=1 node --test <this file>` to
 *    refresh them deliberately.
 *  - PURITY: a source scan proves the module has exactly two type-only
 *    imports and no I/O, clock, environment, randomness or process-exit use,
 *    and the compiled module carries no import at all.
 *
 * This file reads source text with node:fs and imports only pure dist
 * modules. It spawns no process and therefore belongs in the PARALLEL lane:
 * the last test asserts its own repo-relative path is NOT in
 * tests/serial-files.txt (the executable refusal demo,
 * gate-refusal-demo.test.ts, is a separate spawn-capable file that IS listed
 * there).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "../../../dist/lib/comment-blind.js";
import {
  REASON_CODE_ORDER,
  evaluateGate,
  type EvaluatedStore,
  type Finding,
  type GateVerdict,
  type ReasonCode,
  type SidecarState,
} from "../../../dist/installer/matchlock/launch-gate.js";
import type { HolderDetection } from "../../../dist/installer/matchlock/store-holder-detect.js";
import { renderGateRemedyText } from "../../../dist/installer/matchlock/gate-remedy-text.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "gate-remedy-text.ts");
const COMPILED_PATH = path.join(
  REPO_ROOT,
  "dist/installer/matchlock/gate-remedy-text.js",
);
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");
const THIS_RELATIVE = path
  .relative(REPO_ROOT, path.join(HERE, "gate-remedy-text.test.ts"))
  .split(path.sep)
  .join("/");
const GOLDEN_DIR = new URL("./test-fixtures/gate-remedy-text/", import.meta.url);

const MAIN_STORE = "/profile/stores/main.db";
const SESSIONS_STORE = "/profile/stores/sessions.db";
const RELAUNCH = "tamandua matchlock hermes --profile demo";

/** A compliant present store; every field is overridable per scenario. */
function presentStore(
  overrides: Partial<EvaluatedStore> = {},
): EvaluatedStore {
  return {
    requestedPath: MAIN_STORE,
    presence: "present",
    identity: {
      canonicalPath: MAIN_STORE,
      dev: "2049",
      ino: "424242",
      fstype: "ext4",
    },
    required: true,
    config: { journalMode: "delete", source: "merged-config", observed: true },
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

/** A store at a different spelling with its own identity. */
function storeAt(
  requestedPath: string,
  canonicalPath: string,
  overrides: Partial<EvaluatedStore> = {},
): EvaluatedStore {
  return presentStore({
    requestedPath,
    identity: {
      canonicalPath,
      dev: "2049",
      ino: String(424243 + requestedPath.length),
      fstype: "ext4",
    },
    ...overrides,
  });
}

const DETAILS: Record<ReasonCode, string> = {
  "not-delete-config":
    'The effective journal-mode configuration (source merged-config) requests "wal"; the runtime must request the delete journal mode.',
  "wal-header":
    "The store header carries the write-ahead-log version pair (2,2); rollback-format is required.",
  "header-unreadable":
    "The store header carries the unrecognised version pair (2,1); rollback-format is required.",
  "header-not-sqlite": "The store header does not carry the SQLite file signature.",
  "header-truncated":
    "The store header is 12 bytes; a complete 100-byte header is required.",
  "sidecar-unresolved": "Unresolved sidecar state: -wal=presentNonEmpty.",
  "store-missing":
    "The store is required but definitively absent (ENOENT); an absent path has no identity and no canonical path is synthesized.",
  "inventory-incomplete":
    "Store enumeration did not complete (contract-incomplete:seed); the store set is unknown.",
  "path-unresolved":
    "The store path could not be resolved; cannot-determine is not absence.",
  "permission-denied":
    "Resolving the store path failed with a permission error; a permission failure is never absence.",
};

/** One finding for a code, store-scoped unless `store` is omitted. */
function findingFor(code: ReasonCode, store?: string): Finding {
  const finding: Finding = { code, detail: DETAILS[code], remedy: [] };
  if (store !== undefined) finding.store = store;
  return finding;
}

/** A complete holder detection, empty and complete by default. */
function detection(
  overrides: Partial<HolderDetection> = {},
): HolderDetection {
  return { observationComplete: true, holders: [], probeFailures: [], ...overrides };
}

/** Render a verdict built from explicit findings. */
function renderFindings(
  findings: Finding[],
  stores: readonly EvaluatedStore[],
  overrides: {
    holderDetection?: HolderDetection;
    relaunchCommand?: string;
    guestConfigPath?: string | null;
  } = {},
): string {
  const verdict: GateVerdict = {
    action: findings.length === 0 ? "allow" : "refuse",
    findings,
  };
  return renderGateRemedyText({
    verdict,
    holderDetection: overrides.holderDetection ?? detection(),
    stores,
    relaunchCommand: overrides.relaunchCommand ?? RELAUNCH,
    guestConfigPath: overrides.guestConfigPath ?? null,
  });
}

/** Render the real evaluator's verdict for a store set. */
function renderEvaluation(
  stores: readonly EvaluatedStore[],
  overrides: {
    holderDetection?: HolderDetection;
    inventoryComplete?: boolean;
    incompleteReasons?: string[];
    guestConfigPath?: string | null;
    relaunchCommand?: string;
  } = {},
): { text: string; verdict: GateVerdict } {
  const verdict = evaluateGate({
    inventoryComplete: overrides.inventoryComplete ?? true,
    incompleteReasons: overrides.incompleteReasons ?? [],
    stores: [...stores],
  });
  const text = renderGateRemedyText({
    verdict,
    holderDetection: overrides.holderDetection ?? detection(),
    stores,
    relaunchCommand: overrides.relaunchCommand ?? RELAUNCH,
    guestConfigPath: overrides.guestConfigPath ?? null,
  });
  return { text, verdict };
}

/** Extract one `  codes: ...` line from a rendered document. */
function codesLine(text: string): string {
  const line = text
    .split("\n")
    .find((candidate) => candidate.startsWith("  codes: "));
  assert.ok(line, "expected a codes line in the rendered document");
  return line.slice("  codes: ".length);
}

/** The lines belonging to the section that starts with `header`. */
function sectionLines(text: string, header: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(header);
  assert.notEqual(start, -1, `expected section ${header}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => line.startsWith("STORE ") || line.startsWith("HOLDER PROBE"),
  );
  return end === -1 ? rest : rest.slice(0, end);
}

/** The rendered document for one golden scenario. */
function goldenScenario(name: string): {
  text: string;
  verdict: GateVerdict;
} {
  switch (name) {
    case "wal-header": {
      const store = presentStore({
        config: { journalMode: "wal", source: "merged-config", observed: true },
        header: {
          headerFormat: "wal",
          rawBytes1819: [2, 2],
          magicOk: true,
          readable: true,
          fileSize: 4096,
        },
      });
      return renderEvaluation([store], {
        guestConfigPath: "/guest/.hermes/config.yaml",
        holderDetection: detection({
          holders: [
            {
              pid: 4242,
              startIdentity: "v2:4242:1700000000000",
              commandDescription: "node hermes serve --profile demo",
              storePaths: [MAIN_STORE],
            },
          ],
        }),
      });
    }

    case "not-delete-config": {
      // The store on disk is ALREADY rollback-format; only the effective
      // configuration still requests wal. The remedy must say so (re-apply the
      // delete journal mode and fix the guest-visible config), not claim a
      // conversion is still outstanding.
      const store = presentStore({
        config: { journalMode: "wal", source: "merged-config", observed: true },
      });
      return renderEvaluation([store], {
        guestConfigPath: "/guest/.hermes/config.yaml",
      });
    }

    case "sidecar-journal": {
      const store = storeAt("/profile/stores/journal.db", "/profile/stores/journal.db", {
        sidecars: { wal: "absent", shm: "absent", journal: "presentNonEmpty" },
      });
      return renderEvaluation([store]);
    }

    case "sidecar-wal": {
      const store = storeAt("/profile/stores/wal.db", "/profile/stores/wal.db", {
        sidecars: { wal: "presentNonEmpty", shm: "absent", journal: "absent" },
      });
      return renderEvaluation([store]);
    }

    case "sidecar-shm-without-wal": {
      const store = storeAt("/profile/stores/shm.db", "/profile/stores/shm.db", {
        sidecars: { wal: "absent", shm: "presentNonEmpty", journal: "absent" },
      });
      return renderEvaluation([store]);
    }

    case "store-missing": {
      const store = presentStore({
        presence: "confirmed-absent",
        identity: null,
        config: null,
        header: null,
        sidecars: { wal: "absent", shm: "absent", journal: "absent" },
      });
      return renderEvaluation([store]);
    }

    case "inventory-incomplete":
      return renderEvaluation([], {
        inventoryComplete: false,
        incompleteReasons: ["contract-incomplete:seed"],
      });

    case "path-unresolved": {
      const store = presentStore({
        presence: "unresolved",
        identity: null,
        config: null,
        header: null,
        sidecars: null,
      });
      return renderEvaluation([store]);
    }

    case "permission-denied": {
      const store = presentStore({
        presence: "unresolved",
        identity: null,
        config: null,
        header: null,
        sidecars: null,
        findingCodesFromReader: ["permission-denied"],
      });
      return renderEvaluation([store]);
    }

    case "header-unreadable": {
      const store = presentStore({
        header: {
          headerFormat: "unknown",
          rawBytes1819: [2, 1],
          magicOk: true,
          readable: true,
          fileSize: 4096,
        },
      });
      return renderEvaluation([store]);
    }

    default:
      throw new Error(`unknown golden scenario ${name}`);
  }
}

/** The convert command, verbatim, as it must appear under a store section. */
function convertLine(storePath: string): string {
  return `command: hermes sessions set-journal-mode delete --db ${storePath}`;
}

/** The exact reverse command, verbatim, as it must appear. */
function reverseLine(storePath: string): string {
  return `command: hermes sessions set-journal-mode wal --db ${storePath}`;
}

/** The guest-visible configuration instruction, verbatim. */
const GUEST_CONFIG_INSTRUCTION =
  "Set `database.journal_mode: delete` in the configuration the GUEST reads (/guest/.hermes/config.yaml), not in the host's configuration.";

/**
 * The ten golden documents, in the order the story fixes them, each with the
 * case-specific phrases GATE-IMPLEMENTATION-SPEC.md sections 8 and 11 require.
 *
 * A byte-for-byte match alone is not enough: a renderer that drifted into one
 * vague boilerplate blob could still match a stale golden. These phrases pin
 * the behaviour each document exists to demonstrate, so the goldens cannot be
 * refreshed into agreement with a regression.
 */
interface GoldenCase {
  name: string;
  /** Phrases the rendered document MUST carry for this case. */
  mustInclude: readonly string[];
  /** Phrases this case must NOT carry (it would conflate two cases). */
  mustExclude: readonly string[];
}

const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    name: "wal-header",
    mustInclude: [
      "MATCHLOCK LAUNCH GATE: LAUNCH REFUSED",
      "codes: not-delete-config, wal-header",
      GUEST_CONFIG_INSTRUCTION,
      "Convert the store to rollback-format with the delete journal mode:",
      convertLine(MAIN_STORE),
      reverseLine(MAIN_STORE),
      "For a quiescent NATIVE store, the exact reverse conversion restores the wal journal mode:",
      "pid 4242, start v2:4242:1700000000000",
    ],
    mustExclude: [],
  },
  {
    name: "not-delete-config",
    mustInclude: [
      "codes: not-delete-config",
      GUEST_CONFIG_INSTRUCTION,
      "Apply the delete journal mode to the store so its on-disk format matches the guest-visible configuration:",
      convertLine(MAIN_STORE),
      reverseLine(MAIN_STORE),
    ],
    // The on-disk store is already rollback-format, so this document must not
    // borrow the wal-header or the rollback-journal wording.
    mustExclude: [
      "wal-header",
      "write-ahead-log version pair",
      "ROLLBACK journal",
    ],
  },
  {
    name: "sidecar-wal",
    mustInclude: [
      "codes: sidecar-unresolved",
      "sidecars: -wal=presentNonEmpty -shm=absent -journal=absent",
      "The -wal sidecar is nonempty; checkpointing it is legitimate.",
    ],
    // A -wal sidecar is not a rollback journal: none of the journal wording
    // may leak into this document.
    mustExclude: [
      "TRANSIENT",
      "ROLLBACK journal",
      "checkpoint is NOT a treatment",
      "supported recovery/conversion path",
    ],
  },
  {
    name: "sidecar-journal",
    mustInclude: [
      "codes: sidecar-unresolved",
      "sidecars: -wal=absent -shm=absent -journal=presentNonEmpty",
      "The -journal sidecar is nonempty: this is a ROLLBACK journal, not a write-ahead-log, so a checkpoint is NOT a treatment for it.",
      "The refusal may be TRANSIENT while a healthy delete-journal transaction is in flight",
      "wait for quiescence (every writer stopped)",
      "use the supported recovery/conversion path",
      "The -journal file is never deleted.",
      convertLine("/profile/stores/journal.db"),
      reverseLine("/profile/stores/journal.db"),
    ],
    // The rollback-journal remedy must never present a checkpoint as its
    // treatment, and never advise removing the journal.
    mustExclude: [
      "checkpointing it is legitimate",
      "checkpoint the write-ahead-log",
      "delete the -journal",
    ],
  },
  {
    name: "sidecar-shm-without-wal",
    mustInclude: [
      "The -shm sidecar is reported as observed and is not diagnosed",
      "It is present without a nonempty -wal sidecar.",
      "Collect the store and its sidecars as evidence",
    ],
    // Observation only: no diagnosis and no journal treatment.
    mustExclude: ["ROLLBACK journal", "checkpointing it is legitimate"],
  },
  {
    name: "store-missing",
    mustInclude: [
      "codes: store-missing",
      "A fresh or absent store must be initialised natively first; the gate never creates a store.",
      "Relaunch only after the store exists natively.",
    ],
    // A path with no file is never handed a conversion command.
    mustExclude: ["hermes sessions set-journal-mode"],
  },
  {
    name: "inventory-incomplete",
    mustInclude: [
      "STORE SET",
      "store-set findings: 1",
      "An incomplete inventory means the store set is unknown and is never evidence that no stores exist.",
    ],
    mustExclude: ["--db (store set)", "hermes sessions set-journal-mode"],
  },
  {
    name: "path-unresolved",
    mustInclude: [
      "codes: path-unresolved",
      "presence=unresolved",
      "Cannot-determine is not absence.",
    ],
    // An unresolved path is ignorance, never a missing store.
    mustExclude: ["store-missing", "hermes sessions set-journal-mode"],
  },
  {
    name: "permission-denied",
    mustInclude: [
      "codes: path-unresolved, permission-denied",
      "A permission failure is never absence.",
    ],
    mustExclude: ["store-missing", "hermes sessions set-journal-mode"],
  },
  {
    name: "header-unreadable",
    mustInclude: [
      "codes: header-unreadable",
      "Re-observe the store header with every writer quiescent",
      "it is not rollback-format",
      "restore the store from a known-good copy before relaunching",
    ],
    mustExclude: ["wal-header"],
  },
];

const GOLDEN_SCENARIOS: readonly string[] = GOLDEN_CASES.map(
  (goldenCase) => goldenCase.name,
);

/**
 * Vocabulary that must never reach an operator in ANY case: pattern-kill
 * instructions (recorded pids are named instead), integrity diagnoses the gate
 * is not qualified to make, and the "unsafe"/"broken" framing the spec forbids
 * in favour of launch-scoped wording.
 */
const BANNED_VOCABULARY: readonly RegExp[] = [
  /pkill/i,
  /killall/i,
  /kill\s+-9/i,
  /corrupt/i,
  /inconsistent database/i,
  /\bunsafe\b/i,
  /\bbroken\b/i,
];

function goldenPath(name: string): URL {
  return new URL(`${name}.txt`, GOLDEN_DIR);
}

/** Compare against the golden document, refreshing it only when asked to. */
function assertGolden(name: string, actual: string): void {
  const url = goldenPath(name);
  if (process.env.UPDATE_GATE_REMEDY_GOLDEN === "1") {
    fs.mkdirSync(fileURLToPath(GOLDEN_DIR), { recursive: true });
    fs.writeFileSync(url, actual);
    return;
  }

  assert.ok(fs.existsSync(url), `missing golden document ${fileURLToPath(url)}`);
  const expected = fs.readFileSync(url, "utf8");
  assert.equal(
    actual,
    expected,
    `golden document ${name}.txt does not match; review the change and rerun with UPDATE_GATE_REMEDY_GOLDEN=1`,
  );
}

describe("gate-remedy-text: sections and canonical order", () => {
  it("renders one distinct section per failing store, in finding order", () => {
    const first = presentStore({
      config: { journalMode: "wal", source: "merged-config", observed: true },
      header: {
        headerFormat: "wal",
        rawBytes1819: [2, 2],
        magicOk: true,
        readable: true,
        fileSize: 4096,
      },
    });
    const second = storeAt(SESSIONS_STORE, SESSIONS_STORE, {
      sidecars: { wal: "absent", shm: "presentNonEmpty", journal: "absent" },
    });

    const text = renderFindings(
      [
        findingFor("wal-header", MAIN_STORE),
        findingFor("sidecar-unresolved", SESSIONS_STORE),
      ],
      [first, second],
    );

    assert.match(text, /^MATCHLOCK LAUNCH GATE: LAUNCH REFUSED$/m);
    const firstHeader = `STORE 1/2: ${MAIN_STORE}`;
    const secondHeader = `STORE 2/2: ${SESSIONS_STORE}`;
    assert.ok(text.includes(firstHeader), text);
    assert.ok(text.includes(secondHeader), text);
    assert.ok(text.indexOf(firstHeader) < text.indexOf(secondHeader));

    const firstSection = sectionLines(text, firstHeader).join("\n");
    const secondSection = sectionLines(text, secondHeader).join("\n");
    assert.match(firstSection, /codes: wal-header/);
    assert.ok(!firstSection.includes("sidecar-unresolved"), firstSection);
    assert.match(secondSection, /codes: sidecar-unresolved/);
    assert.ok(!secondSection.includes("wal-header"), secondSection);
    // Each section carries its OWN evidence, not the other store's.
    assert.match(firstSection, /sidecars: -wal=absent -shm=absent -journal=absent/);
    assert.match(secondSection, /sidecars: -wal=absent -shm=presentNonEmpty -journal=absent/);
  });

  it("orders codes inside a section by the evaluator's REASON_CODE_ORDER", () => {
    const scrambled: ReasonCode[] = [...REASON_CODE_ORDER].reverse();
    const findings = scrambled.map((code) => findingFor(code, MAIN_STORE));

    const text = renderFindings(findings, [presentStore()]);

    assert.equal(codesLine(text), REASON_CODE_ORDER.join(", "));

    const renderedOrder = text
      .split("\n")
      .filter((line) => line.startsWith("  finding ["))
      .map((line) => line.slice("  finding [".length, line.indexOf("]")));
    assert.deepEqual(renderedOrder, [...REASON_CODE_ORDER]);
  });

  it("renders set-scoped findings first, under a store-set section", () => {
    const text = renderFindings(
      [
        findingFor("wal-header", MAIN_STORE),
        findingFor("inventory-incomplete"),
      ],
      [presentStore()],
    );

    assert.ok(text.includes("STORE SET"), text);
    assert.ok(text.indexOf("STORE SET") < text.indexOf(`STORE 1/1: ${MAIN_STORE}`));
    assert.match(text, /store-set findings: 1/);
    assert.match(text, /stores failing: 1/);
  });

  it("renders a store-scoped finding whose observation was not supplied", () => {
    const text = renderFindings([findingFor("permission-denied", "/unknown/store.db")], []);

    assert.match(text, /STORE 1\/1: \/unknown\/store\.db/);
    assert.match(text, /evidence: no store observation was supplied for this path/);
    assert.match(text, /A permission failure is never absence/);
    assert.match(text, /findings: 1/);
  });

  it("renders an allow verdict without any store section", () => {
    const text = renderFindings([], [presentStore()]);

    assert.match(text, /^MATCHLOCK LAUNCH GATE: LAUNCH ALLOWED$/m);
    assert.match(text, /findings: 0/);
    assert.match(text, /the launch may proceed/);
    assert.ok(!text.includes("STORE 1/1"), text);
    assert.ok(!text.includes("  remedy:"), text);
  });
});

describe("gate-remedy-text: holders", () => {
  it("attributes a holder recorded by canonical path and names its pid", () => {
    const store = presentStore({
      requestedPath: "/called/state.db",
      identity: {
        canonicalPath: "/real/state.db",
        dev: "2049",
        ino: "77",
        fstype: "ext4",
      },
      config: { journalMode: "wal", source: "merged-config", observed: true },
      header: {
        headerFormat: "wal",
        rawBytes1819: [2, 2],
        magicOk: true,
        readable: true,
        fileSize: 4096,
      },
    });
    const other = storeAt(SESSIONS_STORE, SESSIONS_STORE);

    const text = renderFindings(
      [
        findingFor("wal-header", "/called/state.db"),
        findingFor("sidecar-unresolved", SESSIONS_STORE),
      ],
      [store, other],
      {
        holderDetection: detection({
          holders: [
            {
              pid: 4242,
              startIdentity: "v2:4242:1700000000000",
              commandDescription: "node hermes serve --profile demo",
              storePaths: ["/real/state.db"],
            },
          ],
        }),
      },
    );

    const held = sectionLines(text, "STORE 1/2: /called/state.db").join("\n");
    const unheld = sectionLines(text, `STORE 2/2: ${SESSIONS_STORE}`).join("\n");
    assert.match(held, /holders \(informational\):/);
    assert.match(held, /pid 4242, start v2:4242:1700000000000/);
    assert.match(held, /node hermes serve --profile demo/);
    assert.match(unheld, /holders: none observed/);
  });

  it("redacts credential-shaped descriptions and never renders pattern-kill text", () => {
    const holderDetection = detection({
      holders: [
        {
          pid: 5151,
          startIdentity: "v2:5151:1700000000001",
          commandDescription:
            "node hermes serve --token=SUPERSECRETVALUE --api-key sk-ABCDEF1234567890 -H 'Authorization: Bearer BEARERTOKENVALUE'\nSECOND-LINE\tCONTROL",
          storePaths: [MAIN_STORE],
        },
      ],
    });

    const text = renderFindings([findingFor("wal-header", MAIN_STORE)], [presentStore()], {
      holderDetection,
    });

    assert.ok(text.includes("[redacted]"), text);
    for (const secret of [
      "SUPERSECRETVALUE",
      "sk-ABCDEF1234567890",
      "BEARERTOKENVALUE",
    ]) {
      assert.ok(!text.includes(secret), `secret ${secret} survived: ${text}`);
    }

    const holderLine = text
      .split("\n")
      .find((line) => line.includes("pid 5151")) as string;
    assert.ok(holderLine, text);
    assert.ok(holderLine.length < 400, holderLine);
    // Newlines and control characters are flattened into one bounded line.
    assert.ok(!/[\u0000-\u001f\u007f]/.test(holderLine), holderLine);
    assert.equal(
      text.split("\n").filter((line) => line.includes("pid 5151")).length,
      1,
      text,
    );
  });

  it("keeps pkill and killall out of the rendered text entirely", () => {
    const holderDetection = detection({
      holders: [
        {
          pid: 6161,
          startIdentity: "v2:6161:1700000000002",
          commandDescription: "sh -c 'pkill -f hermes; killall hermes'",
          storePaths: [MAIN_STORE],
        },
      ],
    });

    const text = renderFindings([findingFor("wal-header", MAIN_STORE)], [presentStore()], {
      holderDetection,
    });

    assert.ok(!/pkill/i.test(text), text);
    assert.ok(!/killall/i.test(text), text);
    assert.ok(text.includes("pid 6161"), text);
  });

  it("reports a failed holder probe as informational without adding a finding", () => {
    const verdict: GateVerdict = {
      action: "refuse",
      findings: [findingFor("wal-header", MAIN_STORE)],
    };
    const text = renderGateRemedyText({
      verdict,
      holderDetection: detection({
        observationComplete: false,
        probeFailures: [
          { scope: "pid:7171", reason: "EACCES reading the descriptor directory for pid 7171" },
          { scope: "lsof:timeout", reason: "the bounded lsof probe timed out" },
        ],
      }),
      stores: [presentStore()],
      relaunchCommand: RELAUNCH,
    });

    assert.match(text, /HOLDER PROBE \(informational\)/);
    assert.match(text, /observation complete: no/);
    assert.match(
      text,
      /probe failure \[pid:7171\]: EACCES reading the descriptor directory for pid 7171/,
    );
    assert.match(text, /probe failure \[lsof:timeout\]: the bounded lsof probe timed out/);
    assert.match(text, /adds no finding and it never changes the verdict/);
    // The failed probe never adds a finding or a section of its own.
    assert.equal(text.match(/  finding \[/g)?.length, 1);
    assert.match(text, /findings: 1/);
    assert.match(text, /stores failing: 1/);
  });
});

describe("gate-remedy-text: generated remedies", () => {
  it("renders non-empty remedy text for all ten reason codes", () => {
    for (const code of REASON_CODE_ORDER) {
      const text = renderFindings([findingFor(code, MAIN_STORE)], [presentStore()]);
      const section = sectionLines(text, `STORE 1/1: ${MAIN_STORE}`).join("\n");
      const remedyLines = section
        .split("\n")
        .filter((line) => line.startsWith("    - ") && line.length > "    - ".length);

      assert.ok(
        remedyLines.length > 0,
        `code ${code} rendered no remedy text:\n${text}`,
      );
      assert.ok(!/\bundefined\b/.test(section), `code ${code} rendered undefined: ${section}`);
      assert.ok(!/\bnull\b/.test(section), `code ${code} rendered null: ${section}`);
    }
  });

  it("carries the convert and reverse commands verbatim for a wal-header store", () => {
    const text = renderFindings([findingFor("wal-header", MAIN_STORE)], [presentStore()]);

    assert.ok(
      text.includes(`command: hermes sessions set-journal-mode delete --db ${MAIN_STORE}`),
      text,
    );
    assert.ok(
      text.includes(`command: hermes sessions set-journal-mode wal --db ${MAIN_STORE}`),
      text,
    );
    // Two conversion-bearing codes on one store still render each command once.
    const both = renderFindings(
      [findingFor("wal-header", MAIN_STORE), findingFor("not-delete-config", MAIN_STORE)],
      [presentStore()],
    );
    assert.equal(
      both.split("hermes sessions set-journal-mode delete --db").length - 1,
      1,
      both,
    );
  });

  it("names each failing store's own path in the convert and reverse commands", () => {
    const walHeader = {
      headerFormat: "wal" as const,
      rawBytes1819: [2, 2] as [number, number],
      magicOk: true,
      readable: true,
      fileSize: 4096,
    };
    const config = {
      journalMode: "wal" as const,
      source: "merged-config",
      observed: true,
    };
    const first = presentStore({ config, header: walHeader });
    const second = storeAt("/called/journal.db", "/real/journal.db", {
      config,
      header: walHeader,
    });

    const text = renderFindings(
      [
        findingFor("wal-header", MAIN_STORE),
        findingFor("wal-header", "/called/journal.db"),
      ],
      [first, second],
    );

    const firstSection = sectionLines(text, `STORE 1/2: ${MAIN_STORE}`).join("\n");
    const secondSection = sectionLines(text, "STORE 2/2: /called/journal.db").join(
      "\n",
    );

    assert.ok(firstSection.includes(convertLine(MAIN_STORE)), firstSection);
    assert.ok(firstSection.includes(reverseLine(MAIN_STORE)), firstSection);
    assert.ok(!firstSection.includes("/real/journal.db"), firstSection);

    // A command names the canonical spelling of the store it belongs to, never
    // another store's path and never the caller's alias.
    assert.ok(secondSection.includes(convertLine("/real/journal.db")), secondSection);
    assert.ok(secondSection.includes(reverseLine("/real/journal.db")), secondSection);
    assert.ok(
      !secondSection.includes(`--db /called/journal.db`),
      secondSection,
    );
  });

  it("names the guest-visible config in the not-delete-config remedy", () => {
    const text = renderNotDeleteConfigWithGuestConfig();
    assert.match(
      text,
      /Set `database\.journal_mode: delete` in the configuration the GUEST reads \(\/guest\/\.hermes\/config\.yaml\), not in the host's configuration/,
    );
  });

  it("keeps the three sidecar cases distinct and never diagnoses corruption", () => {
    const journalStore = storeAt("/profile/stores/journal.db", "/profile/stores/journal.db", {
      sidecars: { wal: "absent" as SidecarState, shm: "absent" as SidecarState, journal: "presentNonEmpty" as SidecarState },
    });
    const journal = renderFindings(
      [findingFor("sidecar-unresolved", "/profile/stores/journal.db")],
      [journalStore],
    );
    assert.match(journal, /ROLLBACK journal, not a write-ahead-log/);
    assert.match(journal, /a checkpoint is NOT a treatment for it/);
    assert.match(journal, /may be TRANSIENT while a healthy delete-journal transaction is in flight/);
    assert.match(journal, /supported recovery\/conversion path/);
    assert.ok(!/checkpoint the write-ahead-log/i.test(journal), journal);

    const walStore = storeAt("/profile/stores/wal.db", "/profile/stores/wal.db", {
      sidecars: { wal: "presentNonEmpty", shm: "absent", journal: "absent" },
    });
    const wal = renderFindings(
      [findingFor("sidecar-unresolved", "/profile/stores/wal.db")],
      [walStore],
    );
    assert.match(wal, /checkpointing it is legitimate/);
    assert.ok(!/transient/i.test(wal), wal);

    const shmStore = storeAt("/profile/stores/shm.db", "/profile/stores/shm.db", {
      sidecars: { wal: "absent", shm: "presentNonEmpty", journal: "absent" },
    });
    const shm = renderFindings(
      [findingFor("sidecar-unresolved", "/profile/stores/shm.db")],
      [shmStore],
    );
    assert.match(shm, /present without a nonempty -wal sidecar/);
    assert.match(shm, /reported as observed and is not diagnosed/);
    assert.match(shm, /Collect the store and its sidecars as evidence/);
    assert.ok(!/corrupt/i.test(shm), shm);
    assert.ok(!/inconsistent/i.test(shm), shm);
  });

  it("tells the operator to initialise a fresh or absent store natively first", () => {
    const absent = presentStore({
      presence: "confirmed-absent",
      identity: null,
      config: null,
      header: null,
    });
    const text = renderFindings([findingFor("store-missing", MAIN_STORE)], [absent]);

    assert.match(text, /initialised natively first/);
    assert.match(text, /the gate never creates a store/);
  });

  it("refuses to invent a path for a set-scoped remedy command", () => {
    const text = renderFindings([findingFor("inventory-incomplete")], []);
    assert.match(text, /An incomplete inventory means the store set is unknown/);
    assert.ok(!text.includes("--db (store set)"), text);
    assert.ok(!text.includes("--db undefined"), text);
  });
});

/** Render the not-delete-config scenario with a guest config path. */
function renderNotDeleteConfigWithGuestConfig(): string {
  return renderFindings(
    [findingFor("not-delete-config", MAIN_STORE)],
    [
      presentStore({
        config: { journalMode: "wal", source: "merged-config", observed: true },
      }),
    ],
    { guestConfigPath: "/guest/.hermes/config.yaml" },
  );
}

describe("gate-remedy-text: golden documents", () => {
  for (const goldenCase of GOLDEN_CASES) {
    it(`matches the golden document for ${goldenCase.name}`, () => {
      const { text, verdict } = goldenScenario(goldenCase.name);
      assert.equal(verdict.action, "refuse");
      assertGolden(goldenCase.name, text);

      for (const phrase of goldenCase.mustInclude) {
        assert.ok(
          text.includes(phrase),
          `${goldenCase.name}: rendered text is missing ${JSON.stringify(phrase)}\n${text}`,
        );
      }
      for (const phrase of goldenCase.mustExclude) {
        assert.ok(
          !text.includes(phrase),
          `${goldenCase.name}: rendered text must not carry ${JSON.stringify(phrase)}\n${text}`,
        );
      }

      // Every document ends with the caller's own relaunch command on its own
      // `Relaunch:` line, verbatim (spec section 8).
      assert.ok(
        text.includes(`Relaunch: ${RELAUNCH}`),
        `${goldenCase.name}: missing the relaunch line\n${text}`,
      );
    });
  }

  it("pins exactly the ten named golden documents", () => {
    const files = fs
      .readdirSync(fileURLToPath(GOLDEN_DIR))
      .filter((name) => name.endsWith(".txt"))
      .sort();
    assert.deepEqual(
      files,
      [...GOLDEN_SCENARIOS].map((name) => `${name}.txt`).sort(),
    );
  });

  it("never emits pattern-kill, integrity or unsafe/broken vocabulary", () => {
    for (const goldenCase of GOLDEN_CASES) {
      const { text } = goldenScenario(goldenCase.name);
      const golden = fs.readFileSync(goldenPath(goldenCase.name), "utf8");
      for (const pattern of BANNED_VOCABULARY) {
        assert.ok(
          !pattern.test(text),
          `${goldenCase.name}: rendered text matches ${pattern}`,
        );
        assert.ok(
          !pattern.test(golden),
          `${goldenCase.name}: golden text matches ${pattern}`,
        );
      }
    }
  });
});

describe("gate-remedy-text: determinism and purity", () => {
  it("is byte-identical across repeated calls and carries no timestamp", () => {
    const store = presentStore({
      config: { journalMode: "wal", source: "merged-config", observed: true },
      header: {
        headerFormat: "wal",
        rawBytes1819: [2, 2],
        magicOk: true,
        readable: true,
        fileSize: 4096,
      },
    });
    const first = renderFindings([findingFor("wal-header", MAIN_STORE)], [store]);
    const second = renderFindings([findingFor("wal-header", MAIN_STORE)], [store]);

    assert.equal(first, second);
    assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(first), first);
  });

  it("has exactly two type-only imports and no I/O, clock, env or randomness", () => {
    const source = fs.readFileSync(MODULE_PATH, "utf8");
    const code = stripComments(source);

    const imports = code
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import "));
    assert.equal(imports.length, 2, imports.join("\n"));
    for (const line of imports) {
      assert.ok(line.startsWith("import type "), `not a type-only import: ${line}`);
    }

    for (const forbidden of [
      "process.env",
      "process.exit",
      "Date",
      "Math.random",
      "require(",
      "node:",
      "child_process",
      "fs.",
    ]) {
      assert.ok(!code.includes(forbidden), `module source contains ${forbidden}`);
    }
  });

  it("compiles to a module with no runtime import at all", () => {
    const compiled = fs.readFileSync(COMPILED_PATH, "utf8");
    assert.ok(!/^import\b/m.test(compiled), compiled.split("\n").slice(0, 80).join("\n"));
    assert.ok(!compiled.includes("require("));
    assert.ok(!compiled.includes("node:"));
  });

  it("is classified in the parallel lane, not the serial lane", () => {
    const serial = fs.readFileSync(SERIAL_FILES_PATH, "utf8");
    const entries = serial
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    assert.ok(
      !entries.includes(THIS_RELATIVE),
      `${THIS_RELATIVE} must not be listed in tests/serial-files.txt`,
    );
  });
});
