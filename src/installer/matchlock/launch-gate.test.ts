/**
 * launch-gate evaluator tests (G4 LAUNCH-GATE-EVALUATOR US-001..US-005).
 *
 * These tests exercise `evaluateGate` in
 * src/installer/matchlock/launch-gate.ts. They import the COMPILED module from
 * dist/ (repo convention for this directory), so `npm run build` must run
 * first.
 *
 * The module is pure by construction: every fixture below is in-memory
 * observation data. No test here creates a store, calls a driver or touches the
 * filesystem on the gate's behalf. Only this test file reads source text, and
 * only to pin the module's zero-import purity.
 *
 * The (1,1) version pair is described as "rollback-format" throughout. It
 * covers every rollback-journal flavour, so no test name or assertion labels
 * it as a specific journal sub-mode or as proof of a particular sub-mode.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REASON_CODE_ORDER,
  evaluateGate,
  type EvaluatedStore,
  type Finding,
  type GateInput,
} from "../../../dist/installer/matchlock/launch-gate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_PATH = path.join(HERE, "launch-gate.ts");

/** Read the module source text, solely to pin purity and API-shape invariants. */
function moduleSource(): string {
  return fs.readFileSync(MODULE_PATH, "utf8");
}

/** Extract the body of a simple, field-only exported interface. */
function interfaceBody(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export\\s+interface\\s+${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`),
  );
  assert.ok(match, `expected to find interface ${name}`);
  return match[1];
}

const STORE_PATH = "/profile/stores/main.db";

/** A compliant present store: config delete, rollback-format, clean sidecars. */
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

/** A compliant present store with a specific header override. */
function withHeader(
  header: Partial<NonNullable<EvaluatedStore["header"]>>,
): EvaluatedStore {
  return compliantStore({
    header: {
      headerFormat: "rollback",
      rawBytes1819: [1, 1],
      magicOk: true,
      readable: true,
      fileSize: 4096,
      ...header,
    },
  });
}

/** A compliant present store with a specific config override. */
function withConfig(
  config: Partial<NonNullable<EvaluatedStore["config"]>> | null,
): EvaluatedStore {
  if (config === null) return compliantStore({ config: null });
  return compliantStore({
    config: {
      journalMode: "delete",
      source: "guest-config",
      observed: true,
      ...config,
    },
  });
}

function gate(stores: EvaluatedStore[], overrides: Partial<GateInput> = {}): GateInput {
  return {
    inventoryComplete: true,
    incompleteReasons: [],
    stores,
    ...overrides,
  };
}

/**
 * A confirmed-absent optional store. Its config and header are correctly
 * null; only its sidecars are still meaningful.
 */
function absentOptionalStore(
  overrides: Partial<EvaluatedStore> = {},
): EvaluatedStore {
  return compliantStore({
    requestedPath: "/profile/stores/optional.db",
    presence: "confirmed-absent",
    identity: null,
    required: false,
    config: null,
    header: null,
    sidecars: { wal: "absent", shm: "absent", journal: "absent" },
    ...overrides,
  });
}

function codes(findings: Finding[]): string[] {
  return findings.map((finding) => finding.code);
}

describe("launch-gate — API surface and purity", () => {
  it("exports exactly the ten reason codes in the canonical order", () => {
    assert.deepEqual(REASON_CODE_ORDER, [
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
    ]);
  });

  it("has zero import statements and no I/O, clock, random or environment reads", () => {
    const source = moduleSource();
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line));
    assert.deepEqual(importLines, [], "launch-gate.ts must contain no imports");
    assert.doesNotMatch(source, /^\s*import\s*\(/m, "no dynamic import either");

    for (const forbidden of [
      /\bnode:fs\b/,
      /\bnode:fs\/promises\b/,
      /\bnode:child_process\b/,
      /\bnode:os\b/,
      /\bnode:crypto\b/,
      /\bnode:perf_hooks\b/,
      /\brequire\s*\(/,
      /\bprocess\./,
      /\bprocess\.env\b/,
      /\bDate\b/,
      /\bnew\s+Date\b/,
      /\bDate\.now\b/,
      /\bMath\.random\b/,
      /\bperformance\./,
      /\bsetTimeout\b/,
      /\bsetInterval\b/,
    ]) {
      assert.doesNotMatch(source, forbidden);
    }
  });

  it("takes exactly one parameter and exposes no policy override", () => {
    assert.equal(evaluateGate.length, 1);

    const source = moduleSource();
    const declarations = [
      ...source.matchAll(/export\s+function\s+evaluateGate\s*\(([^)]*)\)/g),
    ];
    assert.equal(declarations.length, 1, "exactly one exported declaration");
    const params = declarations[0][1].trim();
    assert.ok(params.length > 0, "evaluateGate must take its input argument");
    assert.ok(
      !params.includes(","),
      "evaluateGate must take exactly one parameter",
    );
    assert.doesNotMatch(params, /\bpolicy\b|\boptions\b|\bconfig\b/i);
    assert.doesNotMatch(source, /function\s+evaluateGate\s*\([^)]*,/);
    assert.doesNotMatch(
      source,
      /function\s+evaluateGate\s*\([^)]*\b(?:policy|options|config)\b/i,
    );

    // Policy is compile-time constants, never a call-site argument.
    for (const name of [
      "REQUIRE_CONFIG_DELETE",
      "REQUIRE_ROLLBACK_HEADER",
      "ALLOW_FRESH_STORE",
    ]) {
      assert.match(source, new RegExp(`\\bconst\\s+${name}\\s*=`));
    }
  });
});

describe("launch-gate — compliant present store", () => {
  it("allows a compliant required present store with no findings", () => {
    const verdict = evaluateGate(gate([compliantStore()]));
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
  });

  it("allows a present store with a null identity because identity is not a decision input", () => {
    // The required observations are config, header and sidecars. Identity is
    // carried for receipt/remedy text, not as a compliance condition.
    const verdict = evaluateGate(gate([compliantStore({ identity: null })]));
    assert.equal(verdict.action, "allow");
  });
});

describe("launch-gate — present-store config decisions", () => {
  for (const config of [
    { journalMode: "wal" as const },
    { journalMode: "unreadable" as const },
    { journalMode: "other" as const },
    { observed: false },
  ]) {
    it(`refuses with not-delete-config for config ${JSON.stringify(config)}`, () => {
      const store = withConfig(config);
      const verdict = evaluateGate(gate([store]));
      assert.equal(verdict.action, "refuse");
      assert.deepEqual(codes(verdict.findings), ["not-delete-config"]);
      assert.equal(verdict.findings[0].store, STORE_PATH);
      assert.ok(verdict.findings[0].remedy.length > 0);
    });
  }

  it("refuses with not-delete-config when config is null", () => {
    const verdict = evaluateGate(gate([compliantStore({ config: null })]));
    assert.deepEqual(codes(verdict.findings), ["not-delete-config"]);
  });
});

describe("launch-gate — present-store header decisions", () => {
  it("refuses with header-unreadable when the header is null", () => {
    const verdict = evaluateGate(gate([compliantStore({ header: null })]));
    assert.deepEqual(codes(verdict.findings), ["header-unreadable"]);
  });

  it("refuses with header-unreadable when the header is not readable", () => {
    const verdict = evaluateGate(gate([withHeader({ readable: false })]));
    assert.deepEqual(codes(verdict.findings), ["header-unreadable"]);
  });

  it("refuses with header-unreadable when the file size could not be observed", () => {
    const verdict = evaluateGate(gate([withHeader({ fileSize: null })]));
    assert.deepEqual(codes(verdict.findings), ["header-unreadable"]);
  });

  it("refuses a write-ahead-log header with wal-header only", () => {
    const verdict = evaluateGate(
      gate([withHeader({ headerFormat: "wal", rawBytes1819: [2, 2] })]),
    );
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), ["wal-header"]);
  });

  it("uses rawBytes1819 as authoritative: [1,1] is rollback-format even if headerFormat says wal", () => {
    const verdict = evaluateGate(
      gate([withHeader({ headerFormat: "wal", rawBytes1819: [1, 1] })]),
    );
    assert.equal(verdict.action, "allow");
  });

  it("reports a mixed pair (2,1) as header-unreadable, names the pair, and never says wal-header", () => {
    const verdict = evaluateGate(
      gate([withHeader({ headerFormat: "unknown", rawBytes1819: [2, 1] })]),
    );
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), ["header-unreadable"]);
    assert.match(verdict.findings[0].detail, /\(2,1\)/);
    assert.doesNotMatch(verdict.findings[0].detail, /wal-header|write-ahead-log/i);
  });

  it("reports an unrecognised pair (3,1) as header-unreadable and names it", () => {
    const verdict = evaluateGate(
      gate([withHeader({ headerFormat: "unknown", rawBytes1819: [3, 1] })]),
    );
    assert.deepEqual(codes(verdict.findings), ["header-unreadable"]);
    assert.match(verdict.findings[0].detail, /\(3,1\)/);
    assert.doesNotMatch(verdict.findings[0].detail, /wal-header/i);
  });

  it("treats headerFormat wal with no raw pair as wal-header", () => {
    const verdict = evaluateGate(
      gate([withHeader({ headerFormat: "wal", rawBytes1819: null })]),
    );
    assert.deepEqual(codes(verdict.findings), ["wal-header"]);
  });

  for (const headerFormat of ["unknown", "rollback"] as const) {
    it(`treats headerFormat ${headerFormat} with no raw pair as header-unreadable, never wal-header`, () => {
      const verdict = evaluateGate(
        gate([withHeader({ headerFormat, rawBytes1819: null })]),
      );
      assert.deepEqual(codes(verdict.findings), ["header-unreadable"]);
      assert.doesNotMatch(verdict.findings[0].detail, /wal-header/i);
    });
  }

  it("reports a 30-byte header with valid magic and (1,1) as header-truncated only", () => {
    const verdict = evaluateGate(
      gate([
        withHeader({
          headerFormat: "unknown",
          rawBytes1819: [1, 1],
          magicOk: true,
          readable: true,
          fileSize: 30,
        }),
      ]),
    );
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), ["header-truncated"]);
    assert.match(verdict.findings[0].detail, /30 bytes/);
    assert.match(verdict.findings[0].detail, /100-byte/);
  });

  it("reports a magic mismatch on a readable complete header as header-not-sqlite only", () => {
    const verdict = evaluateGate(
      gate([withHeader({ magicOk: false, fileSize: 4096 })]),
    );
    assert.deepEqual(codes(verdict.findings), ["header-not-sqlite"]);
  });
});

describe("launch-gate — sidecar and combination decisions", () => {
  it("refuses with sidecar-unresolved when sidecars are null", () => {
    const verdict = evaluateGate(gate([compliantStore({ sidecars: null })]));
    assert.deepEqual(codes(verdict.findings), ["sidecar-unresolved"]);
  });

  it("refuses with sidecar-unresolved when a sidecar is presentNonEmpty or unreadable", () => {
    for (const sidecar of ["presentNonEmpty", "unreadable"] as const) {
      for (const name of ["wal", "shm", "journal"] as const) {
        const verdict = evaluateGate(
          gate([
            compliantStore({
              sidecars: {
                wal: name === "wal" ? sidecar : "absent",
                shm: name === "shm" ? sidecar : "absent",
                journal: name === "journal" ? sidecar : "absent",
              },
            }),
          ]),
        );
        assert.deepEqual(
          codes(verdict.findings),
          ["sidecar-unresolved"],
          `${name}=${sidecar}`,
        );
        assert.match(verdict.findings[0].detail, new RegExp(name));
      }
    }
  });

  it("accepts absent and presentEmpty sidecars for a present store", () => {
    const verdict = evaluateGate(
      gate([
        compliantStore({
          sidecars: {
            wal: "presentEmpty",
            shm: "presentEmpty",
            journal: "presentEmpty",
          },
        }),
      ]),
    );
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
  });

  it("config delete with a WAL header yields wal-header only", () => {
    const verdict = evaluateGate(
      gate([withHeader({ headerFormat: "wal", rawBytes1819: [2, 2] })]),
    );
    assert.deepEqual(codes(verdict.findings), ["wal-header"]);
  });

  it("rollback header with config wal yields not-delete-config only", () => {
    const verdict = evaluateGate(gate([withConfig({ journalMode: "wal" })]));
    assert.deepEqual(codes(verdict.findings), ["not-delete-config"]);
  });

  it("both wrong yields both findings in REASON_CODE_ORDER", () => {
    const verdict = evaluateGate(
      gate([
        compliantStore({
          config: { journalMode: "wal", source: "guest-config", observed: true },
          header: {
            headerFormat: "wal",
            rawBytes1819: [2, 2],
            magicOk: true,
            readable: true,
            fileSize: 4096,
          },
        }),
      ]),
    );
    assert.deepEqual(codes(verdict.findings), [
      "not-delete-config",
      "wal-header",
    ]);
  });

  it("orders multiple per-store findings by REASON_CODE_ORDER", () => {
    const verdict = evaluateGate(
      gate([
        compliantStore({
          config: { journalMode: "wal", source: "guest-config", observed: true },
          header: {
            headerFormat: "wal",
            rawBytes1819: [2, 2],
            magicOk: true,
            readable: true,
            fileSize: 4096,
          },
          sidecars: {
            wal: "absent",
            shm: "absent",
            journal: "presentNonEmpty",
          },
        }),
      ]),
    );
    assert.deepEqual(codes(verdict.findings), [
      "not-delete-config",
      "wal-header",
      "sidecar-unresolved",
    ]);
  });
});

describe("launch-gate — aggregation, ordering and determinism", () => {
  it("continues past a failing store and emits no finding for a compliant store", () => {
    const badPath = "/profile/stores/bad.db";
    const goodPath = "/profile/stores/good.db";
    const bad = compliantStore({
      requestedPath: badPath,
      config: { journalMode: "wal", source: "guest-config", observed: true },
    });
    const good = compliantStore({ requestedPath: goodPath });

    const verdict = evaluateGate(gate([bad, good]));
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), ["not-delete-config"]);
    assert.equal(verdict.findings[0].store, badPath);
    assert.ok(
      verdict.findings.every((finding) => finding.store !== goodPath),
      "the compliant store must have no finding",
    );
  });

  it("emits findings in input store order", () => {
    const first = compliantStore({
      requestedPath: "/profile/stores/first.db",
      config: { journalMode: "wal", source: "guest-config", observed: true },
    });
    const second = compliantStore({
      requestedPath: "/profile/stores/second.db",
      header: {
        headerFormat: "wal",
        rawBytes1819: [2, 2],
        magicOk: true,
        readable: true,
        fileSize: 4096,
      },
    });

    const verdict = evaluateGate(gate([first, second]));
    assert.deepEqual(
      verdict.findings.map((finding) => finding.store),
      ["/profile/stores/first.db", "/profile/stores/second.db"],
    );
  });

  it("returns deeply equal verdicts for the same input, including order", () => {
    const input = gate([
      compliantStore({
        requestedPath: "/profile/stores/one.db",
        config: { journalMode: "wal", source: "guest-config", observed: true },
      }),
      compliantStore({
        requestedPath: "/profile/stores/two.db",
        header: {
          headerFormat: "unknown",
          rawBytes1819: [2, 1],
          magicOk: true,
          readable: true,
          fileSize: 4096,
        },
        sidecars: { wal: "presentNonEmpty", shm: "absent", journal: "unreadable" },
      }),
      compliantStore({ requestedPath: "/profile/stores/three.db" }),
    ]);

    assert.deepEqual(evaluateGate(input), evaluateGate(input));
  });

  it("returns allow exactly when findings is empty", () => {
    assert.equal(evaluateGate(gate([compliantStore()])).action, "allow");
    assert.equal(
      evaluateGate(gate([withConfig({ journalMode: "wal" })])).action,
      "refuse",
    );
  });
});

describe("launch-gate — advisory reader codes never decide the outcome", () => {
  it("allows a compliant store even when the reader mentions other codes or a holder", () => {
    const verdict = evaluateGate(
      gate([
        compliantStore({
          findingCodesFromReader: [
            "permission-denied",
            "sidecar-unresolved",
            "holder-pid-4242",
          ],
        }),
      ]),
    );
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
  });

  it("refuses a bad observation even when the reader reported no codes", () => {
    const verdict = evaluateGate(
      gate([withConfig({ journalMode: "wal", observed: true })]),
    );
    assert.deepEqual(codes(verdict.findings), ["not-delete-config"]);
  });
});

describe("launch-gate — confirmed-absent required and unresolved stores", () => {
  it("refuses a required confirmed-absent store with store-missing", () => {
    const store = compliantStore({
      requestedPath: "/profile/stores/required.db",
      presence: "confirmed-absent",
      identity: null,
      required: true,
      config: null,
      header: null,
      sidecars: null,
    });
    const verdict = evaluateGate(gate([store]));
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), ["store-missing"]);
    assert.equal(verdict.findings[0].store, "/profile/stores/required.db");
  });

  it("keeps the requestedPath and reports no identity for a required confirmed absence", () => {
    const requestedPath = "/profile/stores/required.db";
    const store = compliantStore({
      requestedPath,
      presence: "confirmed-absent",
      identity: null,
      required: true,
      config: null,
      header: null,
      sidecars: { wal: "absent", shm: "absent", journal: "absent" },
    });
    const verdict = evaluateGate(gate([store]));
    assert.deepEqual(codes(verdict.findings), ["store-missing"]);
    assert.equal(verdict.findings[0].store, requestedPath);
    // An absent path has no inode, so no canonical identity may be reported.
    assert.ok(!JSON.stringify(verdict).includes("canonicalPath"));
    assert.deepEqual(Object.keys(verdict.findings[0]).sort(), [
      "code",
      "detail",
      "remedy",
      "store",
    ]);
    assert.ok(
      verdict.findings.every((finding) => finding.code !== "path-unresolved"),
      "a required absence is missing, not unresolved",
    );
  });

  it("adds sidecar-unresolved for a required confirmed-absent store with orphaned sidecars", () => {
    for (const state of ["presentNonEmpty", "unreadable"] as const) {
      for (const name of ["wal", "shm", "journal"] as const) {
        const store = compliantStore({
          requestedPath: "/profile/stores/required.db",
          presence: "confirmed-absent",
          identity: null,
          required: true,
          config: null,
          header: null,
          sidecars: {
            wal: name === "wal" ? state : "absent",
            shm: name === "shm" ? state : "absent",
            journal: name === "journal" ? state : "absent",
          },
        });
        const verdict = evaluateGate(gate([store]));
        assert.equal(verdict.action, "refuse");
        assert.deepEqual(
          codes(verdict.findings),
          ["sidecar-unresolved", "store-missing"],
          `${name}=${state}`,
        );
        assert.ok(
          verdict.findings.every(
            (finding) => finding.store === "/profile/stores/required.db",
          ),
        );
        assert.ok(
          verdict.findings.every((finding) => finding.code !== "path-unresolved"),
        );
      }
    }
  });

  it("adds only store-missing for a required confirmed absence with a null sidecar observation", () => {
    const store = compliantStore({
      requestedPath: "/profile/stores/required.db",
      presence: "confirmed-absent",
      identity: null,
      required: true,
      config: null,
      header: null,
      sidecars: null,
    });
    const verdict = evaluateGate(gate([store]));
    assert.deepEqual(codes(verdict.findings), ["store-missing"]);
  });

  it("adds only store-missing for a required confirmed absence with clean sidecars", () => {
    const store = compliantStore({
      requestedPath: "/profile/stores/required.db",
      presence: "confirmed-absent",
      identity: null,
      required: true,
      config: null,
      header: null,
      sidecars: { wal: "absent", shm: "presentEmpty", journal: "absent" },
    });
    const verdict = evaluateGate(gate([store]));
    assert.deepEqual(codes(verdict.findings), ["store-missing"]);
  });

  it("refuses an unresolved path with path-unresolved only when the reader reports no permission code", () => {
    const store = compliantStore({
      requestedPath: "/profile/stores/unresolved.db",
      presence: "unresolved",
      identity: null,
      config: null,
      header: null,
      sidecars: null,
      findingCodesFromReader: [],
    });
    const verdict = evaluateGate(gate([store]));
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), ["path-unresolved"]);
    assert.equal(verdict.findings[0].store, "/profile/stores/unresolved.db");
  });

  it("refuses an unresolved path with path-unresolved and permission-denied when the reader reports it, never store-missing", () => {
    const store = compliantStore({
      requestedPath: "/profile/stores/unresolved.db",
      presence: "unresolved",
      identity: null,
      config: null,
      header: null,
      sidecars: null,
      findingCodesFromReader: ["permission-denied"],
    });
    const verdict = evaluateGate(gate([store]));
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), [
      "path-unresolved",
      "permission-denied",
    ]);
    assert.ok(
      verdict.findings.every(
        (finding) => finding.store === "/profile/stores/unresolved.db",
      ),
    );
    const permission = verdict.findings.find(
      (finding) => finding.code === "permission-denied",
    );
    assert.ok(permission);
    assert.match(permission.detail, /never absence/);
    assert.ok(
      verdict.findings.every((finding) => finding.code !== "store-missing"),
      "an unresolved path is unknown, never missing",
    );
  });

  it("requires the exact reader code permission-denied to add permission-denied", () => {
    const store = compliantStore({
      requestedPath: "/profile/stores/unresolved.db",
      presence: "unresolved",
      identity: null,
      config: null,
      header: null,
      sidecars: null,
      findingCodesFromReader: [
        "permission",
        "denied",
        "not-permission-denied",
        "PERMISSION-DENIED",
        "holder-pid-4242",
      ],
    });
    const verdict = evaluateGate(gate([store]));
    assert.deepEqual(codes(verdict.findings), ["path-unresolved"]);
  });
});

describe("launch-gate — required regression trio", () => {
  it("(a) allows a compliant required present store plus a genuinely absent optional store with clean sidecars", () => {
    const verdict = evaluateGate(
      gate([
        compliantStore({ requestedPath: "/profile/stores/required.db" }),
        absentOptionalStore({
          requestedPath: "/profile/stores/optional.db",
        }),
      ]),
    );
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
  });

  it("(b) refuses the same fixture when the optional store is unresolved with a reader permission code, never store-missing", () => {
    const optionalPath = "/profile/stores/optional.db";
    const verdict = evaluateGate(
      gate([
        compliantStore({ requestedPath: "/profile/stores/required.db" }),
        absentOptionalStore({
          requestedPath: optionalPath,
          presence: "unresolved",
          findingCodesFromReader: ["permission-denied"],
        }),
      ]),
    );
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), [
      "path-unresolved",
      "permission-denied",
    ]);
    assert.ok(
      verdict.findings.every((finding) => finding.store === optionalPath),
    );
    assert.ok(
      verdict.findings.every((finding) => finding.code !== "store-missing"),
    );
  });

  it("(c) refuses the same fixture with an orphaned nonempty journal for the absent optional store", () => {
    const optionalPath = "/profile/stores/optional.db";
    const verdict = evaluateGate(
      gate([
        compliantStore({ requestedPath: "/profile/stores/required.db" }),
        absentOptionalStore({
          requestedPath: optionalPath,
          sidecars: {
            wal: "absent",
            shm: "absent",
            journal: "presentNonEmpty",
          },
        }),
      ]),
    );
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), ["sidecar-unresolved"]);
    assert.equal(verdict.findings[0].store, optionalPath);
    assert.match(verdict.findings[0].detail, /-journal=presentNonEmpty/);
  });
});

describe("launch-gate — confirmed-absent optional store sidecars", () => {
  it("refuses sidecar-unresolved only for a confirmed-absent optional store with a nonempty wal", () => {
    const store = absentOptionalStore({
      sidecars: { wal: "presentNonEmpty", shm: "absent", journal: "absent" },
    });
    const verdict = evaluateGate(gate([compliantStore(), store]));
    assert.deepEqual(codes(verdict.findings), ["sidecar-unresolved"]);
    assert.equal(verdict.findings[0].store, store.requestedPath);
    assert.match(verdict.findings[0].detail, /-wal=presentNonEmpty/);
  });

  it("allows a compliant required store plus an absent optional store with clean sidecars", () => {
    const verdict = evaluateGate(
      gate([compliantStore(), absentOptionalStore()]),
    );
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
  });

  it("does not demand config/header observations for a confirmed absence", () => {
    const store = absentOptionalStore();
    assert.equal(store.config, null);
    assert.equal(store.header, null);
    const verdict = evaluateGate(gate([compliantStore(), store]));
    assert.equal(verdict.action, "allow");
  });

  for (const state of ["presentNonEmpty", "unreadable"] as const) {
    for (const name of ["wal", "shm", "journal"] as const) {
      it(`refuses sidecar-unresolved for an absent optional store with ${name}=${state}`, () => {
        const store = absentOptionalStore({
          sidecars: {
            wal: name === "wal" ? state : "absent",
            shm: name === "shm" ? state : "absent",
            journal: name === "journal" ? state : "absent",
          },
        });
        const verdict = evaluateGate(gate([compliantStore(), store]));
        assert.equal(verdict.action, "refuse");
        assert.deepEqual(codes(verdict.findings), ["sidecar-unresolved"]);
        assert.equal(verdict.findings[0].store, store.requestedPath);
        assert.match(verdict.findings[0].detail, new RegExp(`-${name}=${state}`));
      });
    }
  }

  it("refuses sidecar-unresolved for a nonempty orphaned journal and reports nothing else for the store", () => {
    const store = absentOptionalStore({
      sidecars: { wal: "absent", shm: "absent", journal: "presentNonEmpty" },
    });
    const verdict = evaluateGate(gate([compliantStore(), store]));
    assert.deepEqual(codes(verdict.findings), ["sidecar-unresolved"]);
    assert.equal(verdict.findings[0].store, store.requestedPath);
    assert.match(verdict.findings[0].detail, /-journal=presentNonEmpty/);
  });

  it("emits exactly one sidecar-unresolved per store even when several sidecars are bad", () => {
    const store = absentOptionalStore({
      sidecars: {
        wal: "presentNonEmpty",
        shm: "unreadable",
        journal: "presentNonEmpty",
      },
    });
    const verdict = evaluateGate(gate([compliantStore(), store]));
    assert.deepEqual(codes(verdict.findings), ["sidecar-unresolved"]);
    assert.match(verdict.findings[0].detail, /-wal=presentNonEmpty/);
    assert.match(verdict.findings[0].detail, /-shm=unreadable/);
    assert.match(verdict.findings[0].detail, /-journal=presentNonEmpty/);
  });

  it("refuses sidecar-unresolved when an absent optional store has no sidecar observation", () => {
    const store = absentOptionalStore({ sidecars: null });
    const verdict = evaluateGate(gate([compliantStore(), store]));
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), ["sidecar-unresolved"]);
    assert.equal(verdict.findings[0].store, store.requestedPath);
  });

  it("accepts presentEmpty sidecars for an absent optional store", () => {
    const store = absentOptionalStore({
      sidecars: {
        wal: "presentEmpty",
        shm: "presentEmpty",
        journal: "presentEmpty",
      },
    });
    const verdict = evaluateGate(gate([compliantStore(), store]));
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
  });
});

describe("launch-gate — inventory completeness", () => {
  it("refuses with one set-scoped inventory-incomplete when inventoryComplete is false", () => {
    const verdict = evaluateGate(
      gate([compliantStore()], { inventoryComplete: false }),
    );
    assert.equal(verdict.action, "refuse");
    assert.deepEqual(codes(verdict.findings), ["inventory-incomplete"]);
    assert.equal(verdict.findings[0].store, undefined);
    assert.ok(!("store" in verdict.findings[0]));
    assert.ok(
      verdict.findings.every((finding) => finding.store !== STORE_PATH),
      "the compliant store must not receive a finding",
    );
  });

  it("refuses with inventory-incomplete when incompleteReasons is non-empty", () => {
    const verdict = evaluateGate(
      gate([compliantStore()], {
        inventoryComplete: true,
        incompleteReasons: ["parent directory unreadable (EACCES)"],
      }),
    );
    assert.deepEqual(codes(verdict.findings), ["inventory-incomplete"]);
    assert.match(verdict.findings[0].detail, /parent directory unreadable/);
  });

  it("keeps per-store findings after an incomplete inventory and orders inventory first", () => {
    const verdict = evaluateGate(
      gate(
        [
          compliantStore({
            config: {
              journalMode: "wal",
              source: "guest-config",
              observed: true,
            },
          }),
        ],
        { inventoryComplete: false, incompleteReasons: ["readdir failed"] },
      ),
    );
    assert.deepEqual(codes(verdict.findings), [
      "inventory-incomplete",
      "not-delete-config",
    ]);
    assert.equal(verdict.findings[0].store, undefined);
    assert.equal(verdict.findings[1].store, STORE_PATH);
  });

  it("never treats an incomplete inventory as an empty profile", () => {
    const empty = evaluateGate(
      gate([], { inventoryComplete: false }),
    );
    assert.deepEqual(codes(empty.findings), ["inventory-incomplete"]);
    assert.ok(
      empty.findings.every((finding) => finding.code !== "store-missing"),
    );

    const absentOnly = evaluateGate(
      gate([absentOptionalStore()], { inventoryComplete: false }),
    );
    assert.deepEqual(codes(absentOnly.findings), ["inventory-incomplete"]);
    assert.ok(
      absentOnly.findings.every((finding) => finding.code !== "store-missing"),
    );
  });
});

describe("launch-gate — fresh profile", () => {
  it("refuses an empty complete inventory with one set-scoped store-missing", () => {
    const verdict = evaluateGate(gate([]));
    assert.equal(verdict.action, "refuse");
    assert.equal(verdict.findings.length, 1);
    assert.equal(verdict.findings[0].code, "store-missing");
    assert.equal(verdict.findings[0].store, undefined);
    assert.ok(!("store" in verdict.findings[0]));
    assert.match(
      verdict.findings[0].remedy.map((step) => step.description).join(" "),
      /initialise natively first/,
    );
  });

  it("refuses when every listed store is optional and confirmed absent with clean sidecars", () => {
    const verdict = evaluateGate(
      gate([
        absentOptionalStore({ requestedPath: "/profile/stores/one.db" }),
        absentOptionalStore({ requestedPath: "/profile/stores/two.db" }),
      ]),
    );
    assert.equal(verdict.action, "refuse");
    assert.equal(verdict.findings.length, 1);
    assert.equal(verdict.findings[0].code, "store-missing");
    assert.equal(verdict.findings[0].store, undefined);
  });

  it("does not add the set-scoped finding when a required store is listed", () => {
    const required = absentOptionalStore({
      requestedPath: "/profile/stores/required.db",
      required: true,
    });
    const verdict = evaluateGate(gate([absentOptionalStore(), required]));
    assert.deepEqual(codes(verdict.findings), ["store-missing"]);
    assert.equal(verdict.findings[0].store, "/profile/stores/required.db");
  });

  it("does not report a fresh profile when a compliant store is present", () => {
    const verdict = evaluateGate(gate([compliantStore()]));
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
  });

  it("does not report a fresh profile when a store path is unresolved", () => {
    const unresolved = absentOptionalStore({
      presence: "unresolved",
      sidecars: null,
    });
    const verdict = evaluateGate(gate([unresolved]));
    assert.deepEqual(codes(verdict.findings), ["path-unresolved"]);
  });

  it("does not report a fresh profile when an absent optional store has a nonempty sidecar", () => {
    const verdict = evaluateGate(
      gate([
        absentOptionalStore({
          sidecars: {
            wal: "absent",
            shm: "absent",
            journal: "presentNonEmpty",
          },
        }),
      ]),
    );
    assert.deepEqual(codes(verdict.findings), ["sidecar-unresolved"]);
    assert.ok(
      verdict.findings.every((finding) => finding.code !== "store-missing"),
    );
  });

  it("is deterministic for the fresh-profile verdict", () => {
    const input = gate([]);
    assert.deepEqual(evaluateGate(input), evaluateGate(input));
  });
});

describe("launch-gate — complete per-code remedies", () => {
  const CANONICAL_PATH = "/canonical/stores/main.db";

  /** Flatten one finding's remedy for substring assertions. */
  function remedyText(finding: Finding): string {
    return finding.remedy
      .map((step) =>
        step.command === undefined
          ? step.description
          : `${step.description} ${step.command}`,
      )
      .join(" ");
  }

  /** Every command carried by a finding's remedy. */
  function commandsFor(finding: Finding): string[] {
    return finding.remedy.flatMap((step) =>
      step.command === undefined ? [] : [step.command],
    );
  }

  /** The single finding for `code`, asserting the fixture produced exactly one. */
  function soleFinding(input: GateInput, code: string): Finding {
    const verdict = evaluateGate(input);
    const matches = verdict.findings.filter((finding) => finding.code === code);
    assert.equal(
      matches.length,
      1,
      `expected exactly one ${code}; got ${codes(verdict.findings).join(", ")}`,
    );
    return matches[0];
  }

  /** A store whose caller spelling differs from its canonical path. */
  function canonicalStore(
    overrides: Partial<EvaluatedStore> = {},
  ): EvaluatedStore {
    return compliantStore({
      requestedPath: "/spelled/stores/main.db",
      identity: {
        canonicalPath: CANONICAL_PATH,
        dev: "2049",
        ino: "424242",
        fstype: "ext4",
      },
      ...overrides,
    });
  }

  /** A required confirmed-absent store (no identity, no header, no config). */
  function requiredAbsentStore(requestedPath: string): EvaluatedStore {
    return compliantStore({
      requestedPath,
      presence: "confirmed-absent",
      identity: null,
      required: true,
      config: null,
      header: null,
      sidecars: { wal: "absent", shm: "absent", journal: "absent" },
    });
  }

  /** An unresolved store (cannot-determine is not absence). */
  function unresolvedStore(
    requestedPath: string,
    findingCodesFromReader: string[] = [],
  ): EvaluatedStore {
    return compliantStore({
      requestedPath,
      presence: "unresolved",
      identity: null,
      config: null,
      header: null,
      sidecars: null,
      findingCodesFromReader,
    });
  }

  /** One fixture that produces every one of the ten reason codes. */
  function comprehensiveRefusal(): GateInput {
    return gate(
      [
        canonicalStore({
          requestedPath: "/profile/stores/config.db",
          config: {
            journalMode: "wal",
            source: "guest-config",
            observed: true,
          },
        }),
        canonicalStore({
          requestedPath: "/profile/stores/wal-header.db",
          header: {
            headerFormat: "wal",
            rawBytes1819: [2, 2],
            magicOk: true,
            readable: true,
            fileSize: 4096,
          },
        }),
        canonicalStore({
          requestedPath: "/profile/stores/header-unknown.db",
          header: {
            headerFormat: "unknown",
            rawBytes1819: [2, 1],
            magicOk: true,
            readable: true,
            fileSize: 4096,
          },
        }),
        canonicalStore({
          requestedPath: "/profile/stores/not-sqlite.db",
          header: {
            headerFormat: "unknown",
            rawBytes1819: [1, 1],
            magicOk: false,
            readable: true,
            fileSize: 4096,
          },
        }),
        canonicalStore({
          requestedPath: "/profile/stores/truncated.db",
          header: {
            headerFormat: "unknown",
            rawBytes1819: [1, 1],
            magicOk: true,
            readable: true,
            fileSize: 30,
          },
        }),
        canonicalStore({
          requestedPath: "/profile/stores/journal.db",
          sidecars: {
            wal: "absent",
            shm: "absent",
            journal: "presentNonEmpty",
          },
        }),
        requiredAbsentStore("/profile/stores/required.db"),
        unresolvedStore("/profile/stores/unresolved.db"),
        unresolvedStore("/profile/stores/permission.db", ["permission-denied"]),
      ],
      {
        inventoryComplete: false,
        incompleteReasons: ["readdir failed (EACCES)"],
      },
    );
  }

  it("gives every one of the ten codes a non-empty, well-formed remedy", () => {
    const verdict = evaluateGate(comprehensiveRefusal());
    assert.equal(verdict.action, "refuse");

    const seen = [...new Set(verdict.findings.map((finding) => finding.code))];
    assert.deepEqual(
      [...seen].sort(),
      [...REASON_CODE_ORDER].sort(),
      "the comprehensive fixture must exercise all ten codes",
    );

    for (const finding of verdict.findings) {
      assert.ok(
        Array.isArray(finding.remedy) && finding.remedy.length > 0,
        `${finding.code} must have a non-empty remedy`,
      );
      for (const step of finding.remedy) {
        assert.equal(typeof step.description, "string");
        assert.ok(
          step.description.trim().length > 0,
          `${finding.code} remedy description must be non-empty`,
        );
        if (step.command !== undefined) {
          assert.equal(typeof step.command, "string");
          assert.ok(
            step.command.trim().length > 0,
            `${finding.code} remedy command must be non-empty`,
          );
        }
      }
    }
  });

  it("generates guest-side not-delete-config remedies with the canonical command path", () => {
    const finding = soleFinding(
      gate([
        canonicalStore({
          config: {
            journalMode: "wal",
            source: "guest-config",
            observed: true,
          },
        }),
      ]),
      "not-delete-config",
    );
    const text = remedyText(finding);
    assert.match(text, /database\.journal_mode: delete/);
    assert.match(text, /guest/);
    assert.match(text, /not in the host's configuration/);
    assert.ok(
      commandsFor(finding).includes(
        `hermes sessions set-journal-mode delete --db '${CANONICAL_PATH}'`,
      ),
      "the delete command must name the canonical path",
    );
    assert.doesNotMatch(text, /pkill|killall|pattern-kill/i);
  });

  it("generates wal-header remedies with holder guidance, both conversions, and a relaunch", () => {
    const finding = soleFinding(
      gate([
        canonicalStore({
          header: {
            headerFormat: "wal",
            rawBytes1819: [2, 2],
            magicOk: true,
            readable: true,
            fileSize: 4096,
          },
        }),
      ]),
      "wal-header",
    );
    const text = remedyText(finding);
    const commands = commandsFor(finding);
    assert.ok(
      commands.includes(
        `hermes sessions set-journal-mode delete --db '${CANONICAL_PATH}'`,
      ),
      "wal-header must name the delete conversion command",
    );
    assert.ok(
      commands.includes(
        `hermes sessions set-journal-mode wal --db '${CANONICAL_PATH}'`,
      ),
      "wal-header must name the reverse wal command for a quiescent native store",
    );
    assert.match(text, /holder by PID/);
    assert.match(text, /sanitized command description/);
    assert.match(text, /never raw argv/);
    assert.match(text, /relaunch/i);
    assert.match(text, /rollback-format/);
  });

  it("names the raw pair and recovery steps in header-unreadable remedies", () => {
    const finding = soleFinding(
      gate([
        canonicalStore({
          header: {
            headerFormat: "unknown",
            rawBytes1819: [2, 1],
            magicOk: true,
            readable: true,
            fileSize: 4096,
          },
        }),
      ]),
      "header-unreadable",
    );
    const text = remedyText(finding);
    assert.match(text, /\(2,1\)/);
    assert.match(text, /known-good copy/);
    assert.match(text, /re-observe/i);
    assert.match(text, /rollback-format/);
    assert.doesNotMatch(text, /wal-header|write-ahead-log/i);
  });

  it("moves a non-SQLite file aside and initialises natively first", () => {
    const finding = soleFinding(
      gate([
        canonicalStore({
          header: {
            headerFormat: "unknown",
            rawBytes1819: [1, 1],
            magicOk: false,
            readable: true,
            fileSize: 4096,
          },
        }),
      ]),
      "header-not-sqlite",
    );
    const text = remedyText(finding);
    assert.match(text, /move[^.]*aside/i);
    assert.match(text, /initialise natively first/);
  });

  it("requires at least 100 header bytes and offers restore or native initialisation", () => {
    const finding = soleFinding(
      gate([
        canonicalStore({
          header: {
            headerFormat: "unknown",
            rawBytes1819: [1, 1],
            magicOk: true,
            readable: true,
            fileSize: 30,
          },
        }),
      ]),
      "header-truncated",
    );
    const text = remedyText(finding);
    assert.match(text, /100 header bytes/);
    assert.match(text, /restore/i);
    assert.match(text, /initialise natively first/);
  });

  it("treats a nonempty -journal as a rollback journal, not a checkpoint, and says the refusal may be transient", () => {
    const finding = soleFinding(
      gate([
        canonicalStore({
          sidecars: {
            wal: "absent",
            shm: "absent",
            journal: "presentNonEmpty",
          },
        }),
      ]),
      "sidecar-unresolved",
    );
    const text = remedyText(finding);
    assert.match(text, /rollback journal/);
    assert.match(text, /may be transient/);
    assert.match(text, /quiescence/);
    assert.doesNotMatch(
      text,
      /checkpoint/i,
      "a checkpoint is not the treatment for a rollback journal",
    );
  });

  it("says a nonempty -wal may be checkpointed after writers are quiesced", () => {
    const finding = soleFinding(
      gate([
        canonicalStore({
          sidecars: {
            wal: "presentNonEmpty",
            shm: "absent",
            journal: "absent",
          },
        }),
      ]),
      "sidecar-unresolved",
    );
    const text = remedyText(finding);
    assert.match(text, /checkpoint/i);
    assert.match(text, /quiesce/i);
  });

  it("reports a nonempty or unreadable -shm without diagnosing it", () => {
    for (const state of ["presentNonEmpty", "unreadable"] as const) {
      const finding = soleFinding(
        gate([
          canonicalStore({
            sidecars: { wal: "absent", shm: state, journal: "absent" },
          }),
        ]),
        "sidecar-unresolved",
      );
      const text = remedyText(finding);
      assert.match(text, /reported/);
      assert.match(text, /not diagnosed/);
      assert.match(text, /-shm/);
    }
  });

  it("fixes permissions or I/O and re-observes an unreadable sidecar", () => {
    const finding = soleFinding(
      gate([
        canonicalStore({
          sidecars: {
            wal: "unreadable",
            shm: "absent",
            journal: "absent",
          },
        }),
      ]),
      "sidecar-unresolved",
    );
    const text = remedyText(finding);
    assert.match(text, /fix permissions or I\/O errors/i);
    assert.match(text, /re-observe/i);
  });

  it("initialises a missing required store natively first", () => {
    const finding = soleFinding(
      gate([requiredAbsentStore("/profile/stores/required.db")]),
      "store-missing",
    );
    assert.match(remedyText(finding), /initialise natively first/);
  });

  it("initialises a fresh profile natively first in a set-scoped remedy", () => {
    const verdict = evaluateGate(gate([]));
    assert.equal(verdict.findings.length, 1);
    const finding = verdict.findings[0];
    assert.equal(finding.code, "store-missing");
    assert.equal(finding.store, undefined);
    const text = remedyText(finding);
    assert.match(text, /initialise natively first/);
    assert.match(text, /profile/);
  });

  it("includes inventory reasons and never calls an incomplete inventory empty or fresh", () => {
    const finding = soleFinding(
      gate([compliantStore()], {
        inventoryComplete: false,
        incompleteReasons: ["readdir failed (EACCES)"],
      }),
      "inventory-incomplete",
    );
    const text = remedyText(finding);
    assert.match(text, /readdir failed \(EACCES\)/);
    assert.match(text, /enumeration/i);
    assert.doesNotMatch(text, /empty|fresh/i);
  });

  it("states that cannot-determine is not absence for an unresolved path", () => {
    const finding = soleFinding(
      gate([unresolvedStore("/profile/stores/unresolved.db")]),
      "path-unresolved",
    );
    assert.match(remedyText(finding), /cannot-determine is not absence/);
  });

  it("states that a permission failure is never absence and names the fix", () => {
    const finding = soleFinding(
      gate([
        unresolvedStore("/profile/stores/permission.db", ["permission-denied"]),
      ]),
      "permission-denied",
    );
    const text = remedyText(finding);
    assert.match(text, /permission failure is never absence/);
    assert.match(text, /grant read access|readable location/i);
  });

  it("falls back to the requestedPath for command paths when identity is absent", () => {
    const finding = soleFinding(
      gate([
        compliantStore({
          identity: null,
          config: {
            journalMode: "wal",
            source: "guest-config",
            observed: true,
          },
        }),
      ]),
      "not-delete-config",
    );
    assert.ok(
      commandsFor(finding).includes(
        `hermes sessions set-journal-mode delete --db '${STORE_PATH}'`,
      ),
      "without an identity the command must name the caller's spelling",
    );
  });

  it("emits no forbidden wording in the module or in generated remedies", () => {
    const verdicts = [evaluateGate(comprehensiveRefusal()), evaluateGate(gate([]))];
    const generated = verdicts
      .flatMap((verdict) =>
        verdict.findings.flatMap((finding) => [
          finding.detail,
          ...finding.remedy.flatMap((step) => [
            step.description,
            ...(step.command === undefined ? [] : [step.command]),
          ]),
        ]),
      )
      .join("\n");
    const source = fs.readFileSync(MODULE_PATH, "utf8");

    for (const [name, text] of [
      ["module source", source],
      ["generated detail and remedy text", generated],
    ] as const) {
      assert.doesNotMatch(
        text,
        /\bpkill\b|\bkillall\b|kill\s+-9|pattern[-\s]?kill/i,
        `${name} must not contain kill instructions`,
      );
      assert.doesNotMatch(
        text,
        /\blease\b|\breservation\b|\bownership\b|one VM per store set|mutual[-\s]?exclusion/i,
        `${name} must not imply mutual exclusion`,
      );
      assert.doesNotMatch(
        text,
        /proves DELETE|proof of DELETE/i,
        `${name} must not claim the version pair proves DELETE`,
      );
    }

    assert.match(source, /rollback-format/);
    assert.doesNotMatch(source, /proves DELETE|proof of DELETE/i);
  });
});

describe("launch-gate — hardening: purity, advisory evidence, determinism and reason-code coverage (US-005)", () => {
  /** An unresolved store: cannot-determine is not absence and has no identity. */
  function unresolvedStore(
    requestedPath: string,
    findingCodesFromReader: string[] = [],
  ): EvaluatedStore {
    return compliantStore({
      requestedPath,
      presence: "unresolved",
      identity: null,
      config: null,
      header: null,
      sidecars: null,
      findingCodesFromReader,
    });
  }

  /** A required confirmed-absent store: no identity, header or config. */
  function requiredAbsentStore(requestedPath: string): EvaluatedStore {
    return absentOptionalStore({
      requestedPath,
      required: true,
      findingCodesFromReader: [],
    });
  }

  /** The smallest all-compliant fixture: one present required store. */
  function allowingFixture(): GateInput {
    return gate([compliantStore({ findingCodesFromReader: [] })]);
  }

  it("never lets an empty advisory reader-code array turn a bad observation into allow", () => {
    const cases: Array<{ name: string; input: GateInput; expected: string }> = [
      {
        name: "config requests wal",
        input: gate([withConfig({ journalMode: "wal" })]),
        expected: "not-delete-config",
      },
      {
        name: "config is null",
        input: gate([compliantStore({ config: null })]),
        expected: "not-delete-config",
      },
      {
        name: "header is null",
        input: gate([compliantStore({ header: null })]),
        expected: "header-unreadable",
      },
      {
        name: "header is unreadable",
        input: gate([withHeader({ readable: false })]),
        expected: "header-unreadable",
      },
      {
        name: "header carries the wal version pair",
        input: gate([withHeader({ headerFormat: "wal", rawBytes1819: [2, 2] })]),
        expected: "wal-header",
      },
      {
        name: "header magic is wrong",
        input: gate([withHeader({ magicOk: false })]),
        expected: "header-not-sqlite",
      },
      {
        name: "header is truncated",
        input: gate([withHeader({ fileSize: 30 })]),
        expected: "header-truncated",
      },
      {
        name: "sidecar is nonempty",
        input: gate([
          compliantStore({
            sidecars: { wal: "presentNonEmpty", shm: "absent", journal: "absent" },
          }),
        ]),
        expected: "sidecar-unresolved",
      },
      {
        name: "required store is confirmed absent",
        input: gate([requiredAbsentStore("/profile/stores/required.db")]),
        expected: "store-missing",
      },
      {
        name: "store path is unresolved",
        input: gate([unresolvedStore("/profile/stores/unresolved.db")]),
        expected: "path-unresolved",
      },
      {
        name: "inventory is incomplete",
        input: gate([compliantStore()], { inventoryComplete: false }),
        expected: "inventory-incomplete",
      },
    ];

    for (const { name, input, expected } of cases) {
      for (const store of input.stores) {
        assert.deepEqual(
          store.findingCodesFromReader,
          [],
          `${name}: fixture must observe no reader codes`,
        );
      }
      const verdict = evaluateGate(input);
      assert.equal(verdict.action, "refuse", `${name} must refuse`);
      assert.ok(
        codes(verdict.findings).includes(expected),
        `${name}: expected ${expected}; got ${codes(verdict.findings).join(", ")}`,
      );
    }
  });

  it("never lets unknown or advisory reader codes turn a compliant observation into refuse", () => {
    const advisoryCodes = [
      "holder-pid-4242",
      "holder-pid-1",
      "holder",
      "unknown-code",
      "not-a-reason-code",
      "wal-header",
      "not-delete-config",
      "sidecar-unresolved",
      "store-missing",
      "inventory-incomplete",
      "path-unresolved",
      "permission-denied",
    ];
    const verdict = evaluateGate(
      gate([compliantStore({ findingCodesFromReader: advisoryCodes })]),
    );
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
  });

  it("has no holder, lease or reservation fields and still allows a holder-mentioning store", () => {
    const input = gate([
      compliantStore({
        findingCodesFromReader: [
          "holder-pid-4242",
          "holder-pid-77",
          "holder",
          "lease",
          "reservation",
        ],
      }),
    ]);

    // Runtime GateInput carries no coordination fields.
    assert.deepEqual(Object.keys(input).sort(), [
      "incompleteReasons",
      "inventoryComplete",
      "stores",
    ]);

    // The declared GateInput interface carries no coordination fields either.
    const fields = [...interfaceBody(moduleSource(), "GateInput").matchAll(
      /^\s*([A-Za-z_$][\w$]*)\s*\??:/gm,
    )].map((match) => match[1]);
    assert.deepEqual(fields.sort(), [
      "incompleteReasons",
      "inventoryComplete",
      "stores",
    ]);
    const body = interfaceBody(moduleSource(), "GateInput");
    assert.doesNotMatch(body, /\bholders?\b/i);
    assert.doesNotMatch(body, /\bleases?\b|\bleasing\b/i);
    assert.doesNotMatch(body, /\breservations?\b|\breserved\b/i);

    // A live holder is never a reason to refuse.
    const verdict = evaluateGate(input);
    assert.equal(verdict.action, "allow");
    assert.deepEqual(verdict.findings, []);
  });

  it("is deterministic and ordered for a multi-store, multi-finding input", () => {
    const one = "/profile/stores/one.db";
    const two = "/profile/stores/two.db";
    const three = "/profile/stores/three.db";
    const four = "/profile/stores/four.db";
    const orphan = "/profile/stores/orphan.db";

    const input = gate(
      [
        compliantStore({
          requestedPath: one,
          config: { journalMode: "wal", source: "guest-config", observed: true },
          header: {
            headerFormat: "unknown",
            rawBytes1819: [2, 1],
            magicOk: true,
            readable: true,
            fileSize: 4096,
          },
          sidecars: {
            wal: "absent",
            shm: "absent",
            journal: "presentNonEmpty",
          },
        }),
        requiredAbsentStore(two),
        unresolvedStore(three, ["permission-denied"]),
        compliantStore({ requestedPath: four }),
        absentOptionalStore({
          requestedPath: orphan,
          sidecars: {
            wal: "presentNonEmpty",
            shm: "absent",
            journal: "absent",
          },
        }),
      ],
      {
        inventoryComplete: false,
        incompleteReasons: ["readdir failed (EACCES)"],
      },
    );

    const first = evaluateGate(input);
    const second = evaluateGate(input);
    assert.deepEqual(first, second, "two calls must be deeply equal");

    assert.deepEqual(codes(first.findings), [
      "inventory-incomplete",
      "not-delete-config",
      "header-unreadable",
      "sidecar-unresolved",
      "store-missing",
      "path-unresolved",
      "permission-denied",
      "sidecar-unresolved",
    ]);

    // Set-scoped findings come first; per-store findings follow input order
    // and the compliant store (four) receives no finding.
    assert.equal(first.findings[0].store, undefined);
    const storeSequence = first.findings
      .filter((finding) => finding.store !== undefined)
      .map((finding) => finding.store);
    assert.deepEqual(storeSequence, [one, one, one, two, three, three, orphan]);
    assert.deepEqual([...new Set(storeSequence)], [one, two, three, orphan]);

    // Per-store codes follow REASON_CODE_ORDER and are not repeated.
    for (const storePath of [one, two, three, orphan]) {
      const storeFindings = first.findings.filter(
        (finding) => finding.store === storePath,
      );
      const ranks = storeFindings.map((finding) =>
        REASON_CODE_ORDER.indexOf(finding.code),
      );
      assert.deepEqual(
        ranks,
        [...ranks].sort((a, b) => a - b),
        `${storePath} codes must follow REASON_CODE_ORDER`,
      );
      const storeCodes = codes(storeFindings);
      assert.equal(
        new Set(storeCodes).size,
        storeCodes.length,
        `${storePath} must not repeat a code`,
      );
    }

    // No (store, code) pair is duplicated anywhere in one verdict.
    const pairs = first.findings.map(
      (finding) => `${finding.store ?? "<set>"}::${finding.code}`,
    );
    assert.equal(new Set(pairs).size, pairs.length);
  });

  /**
   * One negative control per reason code: `baseline` is the closest fixture
   * that does not carry the code, and `mutated` changes only the condition that
   * should produce it.
   */
  const NEGATIVE_CONTROLS: Array<{
    code: string;
    baseline: GateInput;
    baselineCodes: string[];
    mutated: GateInput;
    mutatedCodes: string[];
  }> = [
    {
      code: "not-delete-config",
      baseline: allowingFixture(),
      baselineCodes: [],
      mutated: gate([withConfig({ journalMode: "wal" })]),
      mutatedCodes: ["not-delete-config"],
    },
    {
      code: "wal-header",
      baseline: allowingFixture(),
      baselineCodes: [],
      mutated: gate([
        withHeader({ headerFormat: "wal", rawBytes1819: [2, 2] }),
      ]),
      mutatedCodes: ["wal-header"],
    },
    {
      code: "header-unreadable",
      baseline: allowingFixture(),
      baselineCodes: [],
      mutated: gate([
        withHeader({ headerFormat: "unknown", rawBytes1819: [2, 1] }),
      ]),
      mutatedCodes: ["header-unreadable"],
    },
    {
      code: "header-not-sqlite",
      baseline: allowingFixture(),
      baselineCodes: [],
      mutated: gate([withHeader({ magicOk: false })]),
      mutatedCodes: ["header-not-sqlite"],
    },
    {
      code: "header-truncated",
      baseline: allowingFixture(),
      baselineCodes: [],
      mutated: gate([withHeader({ fileSize: 30 })]),
      mutatedCodes: ["header-truncated"],
    },
    {
      code: "sidecar-unresolved",
      baseline: allowingFixture(),
      baselineCodes: [],
      mutated: gate([
        compliantStore({
          sidecars: {
            wal: "presentNonEmpty",
            shm: "absent",
            journal: "absent",
          },
        }),
      ]),
      mutatedCodes: ["sidecar-unresolved"],
    },
    {
      code: "store-missing",
      baseline: gate([compliantStore(), absentOptionalStore()]),
      baselineCodes: [],
      mutated: gate([
        compliantStore(),
        absentOptionalStore({ required: true }),
      ]),
      mutatedCodes: ["store-missing"],
    },
    {
      code: "inventory-incomplete",
      baseline: allowingFixture(),
      baselineCodes: [],
      mutated: gate([compliantStore()], { inventoryComplete: false }),
      mutatedCodes: ["inventory-incomplete"],
    },
    {
      code: "path-unresolved",
      baseline: allowingFixture(),
      baselineCodes: [],
      mutated: gate([
        compliantStore({
          presence: "unresolved",
          identity: null,
          config: null,
          header: null,
          sidecars: null,
          findingCodesFromReader: [],
        }),
      ]),
      mutatedCodes: ["path-unresolved"],
    },
    {
      code: "permission-denied",
      baseline: gate([unresolvedStore("/profile/stores/permission.db")]),
      baselineCodes: ["path-unresolved"],
      mutated: gate([
        unresolvedStore("/profile/stores/permission.db", ["permission-denied"]),
      ]),
      mutatedCodes: ["path-unresolved", "permission-denied"],
    },
  ];

  it("has one negative control for each of the ten reason codes", () => {
    assert.deepEqual(
      NEGATIVE_CONTROLS.map((control) => control.code).sort(),
      [...REASON_CODE_ORDER].sort(),
    );
  });

  it("emits each reason code when only that condition is mutated", () => {
    for (const control of NEGATIVE_CONTROLS) {
      const baseline = evaluateGate(control.baseline);
      assert.deepEqual(
        codes(baseline.findings),
        control.baselineCodes,
        `${control.code}: baseline codes`,
      );
      assert.ok(
        !codes(baseline.findings).includes(control.code),
        `${control.code} must be absent from the baseline`,
      );

      const verdict = evaluateGate(control.mutated);
      assert.equal(verdict.action, "refuse", `${control.code}: must refuse`);
      assert.deepEqual(
        codes(verdict.findings),
        control.mutatedCodes,
        `${control.code}: mutated codes`,
      );
      assert.ok(
        codes(verdict.findings).includes(control.code),
        `${control.code} must appear when its only condition is mutated`,
      );
    }
  });

  it("never emits a finding code outside REASON_CODE_ORDER", () => {
    const fixtures = [
      ...NEGATIVE_CONTROLS.flatMap((control) => [
        control.baseline,
        control.mutated,
      ]),
      allowingFixture(),
      gate([]),
      gate([compliantStore()], {
        inventoryComplete: false,
        incompleteReasons: ["readdir failed"],
      }),
    ];

    for (const input of fixtures) {
      for (const finding of evaluateGate(input).findings) {
        assert.ok(
          REASON_CODE_ORDER.includes(finding.code),
          `${finding.code} is outside REASON_CODE_ORDER`,
        );
      }
    }
  });

  it("returns action allow exactly when findings is empty", () => {
    const fixtures = [
      ...NEGATIVE_CONTROLS.flatMap((control) => [
        control.baseline,
        control.mutated,
      ]),
      allowingFixture(),
      gate([]),
    ];

    for (const input of fixtures) {
      const verdict = evaluateGate(input);
      assert.equal(
        verdict.action,
        verdict.findings.length === 0 ? "allow" : "refuse",
      );
      assert.equal(verdict.action === "allow", verdict.findings.length === 0);
      if (verdict.findings.length === 0) {
        assert.deepEqual(verdict.findings, []);
      }
    }
  });
});
