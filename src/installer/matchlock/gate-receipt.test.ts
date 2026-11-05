/**
 * gate-receipt serializer tests (G5 GATE-RECEIPT US-001).
 *
 * These tests exercise the PURE half of src/installer/matchlock/gate-receipt.ts:
 * the schemaVersion 1 type surface plus `serializeReceipt`/`parseReceipt`.
 * They import the COMPILED module from dist/ (repo convention for this
 * directory), so `npm run build` must run first.
 *
 * The receipt is the durable evidence an operator reads after a refusal, so the
 * properties pinned here are the ones that make it trustworthy:
 *
 *  - every required key is present even when its value is `unreadable`;
 *  - the key order is explicit and stable, so byte-identical observations
 *    produce byte-identical receipts;
 *  - caller objects are whitelisted, so file contents, argv, row hashes and
 *    other extras can never ride into the file;
 *  - the no-lease limitation is stated in the receipt itself;
 *  - every observation carries its perspective and provenance, and a guest
 *    transport that was never observed from inside the guest stays
 *    `unmeasured`/`unknown` rather than being inferred from a host fstype.
 *
 * This file performs only test-local temp-file writes for the determinism
 * check. It spawns no process, imports no child_process and therefore belongs
 * in the PARALLEL lane: the final purity test asserts that this file's own
 * repo-relative path is NOT in tests/serial-files.txt.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  GATE_RECEIPT_SCHEMA_VERSION,
  GATE_RECEIPT_UNKNOWN,
  GATE_RECEIPT_UNMEASURED,
  GATE_RECEIPT_UNREADABLE,
  NO_LEASE_LIMITATION,
  parseReceipt,
  serializeReceipt,
  writeLaunchReceipt,
  writeRefusalReceipt,
  type GateReceipt,
  type ReceiptStore,
  type ReceiptWriteResult,
} from "../../../dist/installer/matchlock/gate-receipt.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "gate-receipt.ts");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");

const TOP_LEVEL_KEYS = [
  "schemaVersion",
  "invocation",
  "storeSetKey",
  "inventoryComplete",
  "stores",
  "discoveredUnexpected",
  "holderDetection",
  "verdict",
  "findings",
  "host",
  "action",
  "observationStartedAt",
  "observationFinishedAt",
  "receiptWrittenAt",
];

const INVOCATION_KEYS_WITH_IDS = [
  "kind",
  "runId",
  "roundId",
  "profile",
  "guestConfigDir",
];

const INVOCATION_KEYS_WITHOUT_IDS = ["kind", "profile", "guestConfigDir"];

const STORE_KEYS = [
  "canonicalPath",
  "dev",
  "ino",
  "size",
  "headerBytes",
  "headerFormat",
  "sidecarState",
  "configJournalMode",
  "configSource",
  "readable",
  "findingCodes",
];

const SIDECAR_STATE_KEYS = [
  "wal",
  "shm",
  "journal",
  "perspective",
  "provenance",
];

const FINDING_KEYS_WITH_STORE = ["code", "store", "detail", "remedy"];
const FINDING_KEYS_WITHOUT_STORE = ["code", "detail", "remedy"];
const HOST_KEYS = [
  "hermesRevision",
  "matchlockRevision",
  "tamanduaRevision",
];
const HOLDER_DETECTION_KEYS = [
  "observationComplete",
  "holders",
  "perspective",
  "provenance",
  "limitation",
];

const createdDirs: string[] = [];

function fixtureDir(prefix: string): string {
  const dir = tamanduaShortTempDir(prefix);
  createdDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort; a leftover short temp dir is harmless
    }
  }
});

/** A complete, measurable store fixture. */
function storeFixture(): ReceiptStore {
  return {
    canonicalPath: "/srv/hermes/stores/hermes.db",
    dev: "2049",
    ino: "88123",
    size: 100,
    headerBytes: [1, 1],
    headerFormat: "rollback",
    sidecarState: {
      wal: "absent",
      shm: "absent",
      journal: "absent",
      perspective: "host",
      provenance: "measured",
    },
    configJournalMode: "delete",
    configSource: "host-merged-config",
    readable: true,
    findingCodes: [],
  };
}

/** A complete refusal receipt fixture. */
function receiptFixture(withIds = true): GateReceipt {
  const invocation: GateReceipt["invocation"] = withIds
    ? {
        kind: "interactive-hermes",
        runId: "run-0001",
        roundId: "round-0002",
        profile: "default",
        guestConfigDir: "/guest/.hermes",
      }
    : {
        kind: "interactive-hermes",
        profile: "default",
        guestConfigDir: "/guest/.hermes",
      };

  return {
    schemaVersion: GATE_RECEIPT_SCHEMA_VERSION,
    invocation,
    storeSetKey: "sha256:store-set-key",
    inventoryComplete: true,
    stores: [storeFixture()],
    discoveredUnexpected: ["/srv/hermes/stores/unexpected.db"],
    holderDetection: {
      observationComplete: true,
      holders: [
        {
          pid: 4242,
          startedAt: "2026-01-01T00:00:00.000Z",
          command: "hermes sessions list",
        },
      ],
      perspective: "host",
      provenance: "measured",
      limitation: NO_LEASE_LIMITATION,
    },
    verdict: "refuse",
    findings: [
      {
        code: "wal-header",
        store: "/srv/hermes/stores/hermes.db",
        detail: "header version pair is (2,2): write-ahead-log format",
        remedy: [
          {
            description: "Quiesce writers, then convert the store.",
          },
          {
            description: "Convert the store to rollback-format.",
            command:
              "hermes sessions set-journal-mode delete --db '/srv/hermes/stores/hermes.db'",
          },
        ],
      },
    ],
    host: {
      hermesRevision: "hermes-rev-1",
      matchlockRevision: "matchlock-rev-2",
      tamanduaRevision: "tamandua-rev-3",
    },
    action: "refused",
    observationStartedAt: "2026-01-01T00:00:00.000Z",
    observationFinishedAt: "2026-01-01T00:00:01.000Z",
    receiptWrittenAt: "2026-01-01T00:00:02.000Z",
  };
}

// ---------------------------------------------------------------------------
// writer result helpers
// ---------------------------------------------------------------------------

function expectWriteOk(result: ReceiptWriteResult, expectedPath: string): void {
  assert.deepEqual(result, { ok: true, path: expectedPath });
}

function expectWriteFailure(
  result: ReceiptWriteResult,
  expectedPath: string,
): { code: string; path: string; detail: string } {
  if (result.ok) {
    assert.fail(`expected a typed write failure, got success at ${result.path}`);
  }
  assert.equal(result.code, "receipt-write-failed");
  assert.equal(result.path, expectedPath);
  assert.equal(typeof result.detail, "string");
  assert.ok(result.detail.length > 0, "failure detail must be non-empty");
  return result;
}

// ---------------------------------------------------------------------------
// schema and field order
// ---------------------------------------------------------------------------

describe("gate-receipt: schemaVersion 1 shape", () => {
  it("exports the pinned schema version, sentinel, and no-lease limitation", () => {
    assert.equal(GATE_RECEIPT_SCHEMA_VERSION, 1);
    assert.equal(GATE_RECEIPT_UNREADABLE, "unreadable");
    assert.equal(GATE_RECEIPT_UNMEASURED, "unmeasured");
    assert.equal(GATE_RECEIPT_UNKNOWN, "unknown");
    assert.equal(
      NO_LEASE_LIMITATION,
      "no-lease: concurrent admissions may both pass",
    );
  });

  it("emits one line of minified JSON with no trailing newline", () => {
    const text = serializeReceipt(receiptFixture());

    assert.equal(text.includes("\n"), false, "receipt must be one line");
    assert.equal(text.endsWith("\n"), false, "serializer owns no newline");
    assert.doesNotThrow(() => JSON.parse(text));
  });

  it("pins the top-level key order", () => {
    const parsed = JSON.parse(serializeReceipt(receiptFixture()));

    assert.deepEqual(Object.keys(parsed), TOP_LEVEL_KEYS);
  });

  it("pins the invocation key order with and without optional ids", () => {
    const withIds = JSON.parse(serializeReceipt(receiptFixture(true)));
    const withoutIds = JSON.parse(serializeReceipt(receiptFixture(false)));

    assert.deepEqual(Object.keys(withIds.invocation), INVOCATION_KEYS_WITH_IDS);
    assert.deepEqual(
      Object.keys(withoutIds.invocation),
      INVOCATION_KEYS_WITHOUT_IDS,
    );
  });

  it("pins the store, sidecar state, finding, remedy and host key order", () => {
    const parsed = JSON.parse(serializeReceipt(receiptFixture()));
    const store = parsed.stores[0];
    const finding = parsed.findings[0];

    assert.deepEqual(Object.keys(store), STORE_KEYS);
    assert.deepEqual(Object.keys(store.sidecarState), SIDECAR_STATE_KEYS);
    assert.deepEqual(Object.keys(finding), FINDING_KEYS_WITH_STORE);
    assert.deepEqual(Object.keys(finding.remedy[0]), ["description"]);
    assert.deepEqual(Object.keys(finding.remedy[1]), [
      "description",
      "command",
    ]);
    assert.deepEqual(Object.keys(parsed.host), HOST_KEYS);
    assert.deepEqual(
      Object.keys(parsed.holderDetection),
      HOLDER_DETECTION_KEYS,
    );
  });

  it("omits a finding's store key for a set-scoped finding", () => {
    const receipt = receiptFixture();
    receipt.findings = [
      {
        code: "inventory-incomplete",
        detail: "the store sweep did not complete",
        remedy: [{ description: "Fix the unreadable parent directory." }],
      },
    ];

    const parsed = JSON.parse(serializeReceipt(receipt));
    assert.deepEqual(
      Object.keys(parsed.findings[0]),
      FINDING_KEYS_WITHOUT_STORE,
    );
  });

  it("round-trips a receipt that has runId and roundId", () => {
    const receipt = receiptFixture(true);
    assert.deepEqual(parseReceipt(serializeReceipt(receipt)), receipt);
  });

  it("round-trips a receipt that has neither runId nor roundId", () => {
    const receipt = receiptFixture(false);
    assert.equal("runId" in receipt.invocation, false);
    assert.equal("roundId" in receipt.invocation, false);
    assert.deepEqual(parseReceipt(serializeReceipt(receipt)), receipt);
  });

  it("rejects a file that is not a versioned receipt object", () => {
    assert.throws(() => parseReceipt("not json"));
    assert.throws(() => parseReceipt("[]"));
    assert.throws(() =>
      parseReceipt(JSON.stringify({ schemaVersion: 2 })),
    );
  });
});

// ---------------------------------------------------------------------------
// unreadable completeness
// ---------------------------------------------------------------------------

describe("gate-receipt: unreadable values stay present", () => {
  function allUnreadableReceipt(): GateReceipt {
    const receipt = receiptFixture();
    receipt.inventoryComplete = false;
    receipt.storeSetKey = GATE_RECEIPT_UNREADABLE;
    receipt.stores = [
      {
        canonicalPath: GATE_RECEIPT_UNREADABLE,
        dev: GATE_RECEIPT_UNREADABLE,
        ino: GATE_RECEIPT_UNREADABLE,
        size: GATE_RECEIPT_UNREADABLE,
        headerBytes: GATE_RECEIPT_UNREADABLE,
        headerFormat: GATE_RECEIPT_UNREADABLE,
        sidecarState: {
          wal: GATE_RECEIPT_UNREADABLE,
          shm: GATE_RECEIPT_UNREADABLE,
          journal: GATE_RECEIPT_UNREADABLE,
          perspective: GATE_RECEIPT_UNMEASURED,
          provenance: GATE_RECEIPT_UNKNOWN,
        },
        configJournalMode: GATE_RECEIPT_UNREADABLE,
        configSource: GATE_RECEIPT_UNREADABLE,
        readable: GATE_RECEIPT_UNREADABLE,
        findingCodes: ["header-unreadable"],
      },
    ];
    receipt.discoveredUnexpected = [];
    receipt.findings = [
      {
        code: "header-unreadable",
        store: GATE_RECEIPT_UNREADABLE,
        detail: "the store header could not be read",
        remedy: [{ description: "Fix permissions and re-observe the store." }],
      },
    ];
    receipt.host = {
      hermesRevision: GATE_RECEIPT_UNREADABLE,
      matchlockRevision: GATE_RECEIPT_UNREADABLE,
      tamanduaRevision: GATE_RECEIPT_UNREADABLE,
    };
    receipt.observationStartedAt = GATE_RECEIPT_UNREADABLE;
    receipt.observationFinishedAt = GATE_RECEIPT_UNREADABLE;
    receipt.receiptWrittenAt = GATE_RECEIPT_UNREADABLE;
    return receipt;
  }

  it("serializes every store key even when the value is unreadable", () => {
    const parsed = JSON.parse(serializeReceipt(allUnreadableReceipt()));
    const store = parsed.stores[0];

    assert.deepEqual(Object.keys(store), STORE_KEYS);
    for (const key of STORE_KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(store, key),
        true,
        `store.${key} must be present`,
      );
      assert.notEqual(store[key], undefined, `store.${key} must not be undefined`);
    }

    assert.equal(store.canonicalPath, "unreadable");
    assert.equal(store.dev, "unreadable");
    assert.equal(store.ino, "unreadable");
    assert.equal(store.size, "unreadable");
    assert.equal(store.headerBytes, "unreadable");
    assert.equal(store.headerFormat, "unreadable");
    assert.equal(store.configJournalMode, "unreadable");
    assert.equal(store.configSource, "unreadable");
    assert.equal(store.readable, "unreadable");
    assert.deepEqual(store.findingCodes, ["header-unreadable"]);

    assert.deepEqual(Object.keys(store.sidecarState), SIDECAR_STATE_KEYS);
    assert.equal(store.sidecarState.wal, "unreadable");
    assert.equal(store.sidecarState.shm, "unreadable");
    assert.equal(store.sidecarState.journal, "unreadable");
    assert.equal(store.sidecarState.perspective, "unmeasured");
    assert.equal(store.sidecarState.provenance, "unknown");
  });

  it("serializes every top-level key even when the value is unreadable", () => {
    const parsed = JSON.parse(serializeReceipt(allUnreadableReceipt()));

    assert.deepEqual(Object.keys(parsed), TOP_LEVEL_KEYS);
    for (const key of TOP_LEVEL_KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(parsed, key),
        true,
        `top-level ${key} must be present`,
      );
      assert.notEqual(parsed[key], undefined, `top-level ${key} must not be undefined`);
    }
    assert.equal(parsed.storeSetKey, "unreadable");
    assert.equal(parsed.observationStartedAt, "unreadable");
    assert.equal(parsed.observationFinishedAt, "unreadable");
    assert.equal(parsed.receiptWrittenAt, "unreadable");
    assert.deepEqual(Object.keys(parsed.host), HOST_KEYS);
    assert.equal(parsed.host.hermesRevision, "unreadable");
    assert.equal(parsed.host.matchlockRevision, "unreadable");
    assert.equal(parsed.host.tamanduaRevision, "unreadable");
  });

  it("preserves the unreadable sentinel through a parse round-trip", () => {
    const receipt = allUnreadableReceipt();
    assert.deepEqual(parseReceipt(serializeReceipt(receipt)), receipt);
  });
});

// ---------------------------------------------------------------------------
// whitelist construction
// ---------------------------------------------------------------------------

describe("gate-receipt: whitelist construction excludes caller extras", () => {
  it("never serializes contents, argv, row hashes, credentials or fstype", () => {
    const receipt = receiptFixture();
    const hostileStore = {
      ...storeFixture(),
      contents: "SECRET-STORE-CONTENTS",
      argv: ["--api-key", "sk-test-live"],
      rowHash: "deadbeef-row-hash",
      credentials: { token: "Bearer abc" },
      fstype: "ext4",
    };
    const hostile = {
      ...receipt,
      stores: [hostileStore],
      contents: "SECRET-TOP-LEVEL-CONTENTS",
      argv: ["--api-key", "sk-test-live"],
      rowHash: "deadbeef-row-hash",
      credentials: { token: "Bearer abc" },
      holderDetection: {
        ...receipt.holderDetection,
        argv: ["--token=abc"],
      },
      findings: [
        {
          ...receipt.findings[0],
          contents: "SECRET-FINDING-CONTENTS",
        },
      ],
    };

    const text = serializeReceipt(hostile as unknown as GateReceipt);

    for (const forbidden of [
      "contents",
      "argv",
      "rowHash",
      "credentials",
      "fstype",
      "SECRET-STORE-CONTENTS",
      "SECRET-TOP-LEVEL-CONTENTS",
      "SECRET-FINDING-CONTENTS",
      "sk-test-live",
      "deadbeef-row-hash",
      "Bearer abc",
      "token=abc",
      "ext4",
      "virtiofs",
    ]) {
      assert.equal(
        text.includes(forbidden),
        false,
        `serialized receipt must not contain ${forbidden}`,
      );
    }
  });

  it("does not copy a caller's own schemaVersion", () => {
    const hostile = { ...receiptFixture(), schemaVersion: 999 };
    const parsed = JSON.parse(
      serializeReceipt(hostile as unknown as GateReceipt),
    );

    assert.equal(parsed.schemaVersion, 1);
  });
});

// ---------------------------------------------------------------------------
// evidence safety: credentials and holder non-authority
// ---------------------------------------------------------------------------

describe("gate-receipt: evidence safety", () => {
  const SENSITIVE = [
    "sk-test",
    "Bearer abc",
    "token=abc",
    "key=abc",
  ] as const;

  /** A receipt whose human-readable text contains secret-shaped segments. */
  function hostileReceipt(): GateReceipt {
    const receipt = receiptFixture();
    receipt.storeSetKey = "sha256:store-set-key";
    receipt.holderDetection = {
      observationComplete: false,
      holders: [
        {
          pid: 9001,
          startedAt: "2026-01-01T00:00:00.000Z",
          command:
            "hermes --api-key sk-test --auth 'Bearer abc' --token=abc --key=abc",
        },
      ],
      perspective: GATE_RECEIPT_UNMEASURED,
      provenance: GATE_RECEIPT_UNKNOWN,
      limitation: NO_LEASE_LIMITATION,
    };
    receipt.findings = [
      {
        code: "wal-header",
        store: "/srv/hermes/stores/hermes.db",
        detail: "probe failed: sk-test Bearer abc token=abc key=abc",
        remedy: [
          { description: "replace the value after token=abc" },
          {
            description: "quiesce the writer",
            command: "hermes --api-key sk-test --token=abc",
          },
        ],
      },
    ];
    return receipt;
  }

  function assertContainsNoSecrets(text: string): void {
    for (const secret of SENSITIVE) {
      assert.equal(
        text.includes(secret),
        false,
        `receipt must not contain secret-shaped text ${secret}`,
      );
    }
  }

  it("redacts secrets from holder, finding and remedy text in the serialized receipt", () => {
    const base = hostileReceipt();
    const hostile = {
      ...base,
      contents: "SECRET-TOP-LEVEL-CONTENTS",
      argv: ["--token=abc", "sk-test"],
      rowHash: "deadbeef-row-hash",
      holderDetection: {
        ...base.holderDetection,
        argv: ["--key=abc"],
      },
      findings: [
        {
          ...base.findings[0],
          contents: "SECRET-FINDING-CONTENTS",
          argv: ["--token=abc"],
        },
      ],
    };

    const text = serializeReceipt(hostile as unknown as GateReceipt);

    assertContainsNoSecrets(text);
    for (const extra of [
      "contents",
      "argv",
      "rowHash",
      "SECRET-TOP-LEVEL-CONTENTS",
      "SECRET-FINDING-CONTENTS",
    ]) {
      assert.equal(
        text.includes(extra),
        false,
        `serialized receipt must not contain caller extra ${extra}`,
      );
    }

    const parsed = JSON.parse(text);
    assert.match(parsed.holderDetection.holders[0].command, /\[redacted\]/);
    assert.match(parsed.findings[0].detail, /\[redacted\]/);
    assert.match(parsed.findings[0].remedy[1].command, /\[redacted\]/);
  });

  it("writes the redacted receipt file with no secrets or caller extras", () => {
    const dir = fixtureDir("gate-receipt-redaction-");
    const destination = path.join(dir, "receipt.json");
    const base = hostileReceipt();
    const hostile = {
      ...base,
      contents: "SECRET-TOP-LEVEL-CONTENTS",
      argv: ["--token=abc", "sk-test"],
      rowHash: "deadbeef-row-hash",
    };

    expectWriteOk(
      writeRefusalReceipt(hostile as unknown as GateReceipt, {
        path: destination,
      }),
      destination,
    );

    const written = fs.readFileSync(destination, "utf8");
    assertContainsNoSecrets(written);
    for (const extra of [
      "SECRET-TOP-LEVEL-CONTENTS",
      "deadbeef-row-hash",
      '"argv"',
      '"rowHash"',
      '"contents"',
    ]) {
      assert.equal(
        written.includes(extra),
        false,
        `written receipt must not contain caller extra ${extra}`,
      );
    }

    const parsed = parseReceipt(written);
    assert.equal(parsed.holderDetection.observationComplete, false);
    assert.equal(parsed.holderDetection.holders.length, 1);
    assert.equal(parsed.findings.length, 1);
    assert.match(parsed.holderDetection.holders[0].command, /\[redacted\]/);
    assert.match(parsed.findings[0].detail, /\[redacted\]/);
    assert.deepEqual(fs.readdirSync(dir), ["receipt.json"]);
  });

  it("keeps an allow verdict and adds no finding when the holder probe fails", () => {
    const receipt = receiptFixture();
    receipt.verdict = "allow";
    receipt.findings = [];
    receipt.stores[0].findingCodes = [];
    receipt.holderDetection = {
      observationComplete: false,
      holders: [],
      perspective: GATE_RECEIPT_UNMEASURED,
      provenance: GATE_RECEIPT_UNKNOWN,
      limitation: NO_LEASE_LIMITATION,
    };

    const parsed = JSON.parse(serializeReceipt(receipt));

    assert.equal(parsed.holderDetection.observationComplete, false);
    assert.equal(parsed.holderDetection.perspective, "unmeasured");
    assert.equal(parsed.holderDetection.provenance, "unknown");
    assert.equal(parsed.verdict, "allow");
    assert.deepEqual(parsed.findings, []);
    assert.equal(
      parsed.findings.some((finding: { code: string }) =>
        /holder/i.test(finding.code),
      ),
      false,
    );
  });

  it("keeps a refusal verdict and exactly its original findings when the holder probe fails", () => {
    const receipt = receiptFixture();
    const originalFindings = structuredClone(receipt.findings);
    receipt.holderDetection = {
      ...receipt.holderDetection,
      observationComplete: false,
      holders: [],
    };

    const parsed = JSON.parse(serializeReceipt(receipt));

    assert.equal(parsed.holderDetection.observationComplete, false);
    assert.equal(parsed.verdict, "refuse");
    assert.deepEqual(parsed.findings, originalFindings);
    assert.deepEqual(
      parsed.findings.map((finding: { code: string }) => finding.code),
      originalFindings.map((finding) => finding.code),
    );
  });
});

// ---------------------------------------------------------------------------
// no-lease limitation
// ---------------------------------------------------------------------------

describe("gate-receipt: no-lease limitation is stated", () => {
  it("serializes the exact limitation inside holderDetection", () => {
    const parsed = JSON.parse(serializeReceipt(receiptFixture()));

    assert.equal(
      parsed.holderDetection.limitation,
      "no-lease: concurrent admissions may both pass",
    );
    assert.match(
      serializeReceipt(receiptFixture()),
      /no-lease: concurrent admissions may both pass/,
    );
  });

  it("replaces an incorrect caller limitation with the constant", () => {
    const receipt = receiptFixture();
    receipt.holderDetection.limitation = "exclusive lease" as never;

    const parsed = JSON.parse(serializeReceipt(receipt));
    assert.equal(parsed.holderDetection.limitation, NO_LEASE_LIMITATION);
  });
});

// ---------------------------------------------------------------------------
// perspective and provenance
// ---------------------------------------------------------------------------

describe("gate-receipt: observation perspective and provenance", () => {
  it("keeps config, sidecar and holder provenance explicit", () => {
    const parsed = JSON.parse(serializeReceipt(receiptFixture()));

    assert.equal(parsed.stores[0].configSource, "host-merged-config");
    assert.equal(parsed.stores[0].sidecarState.perspective, "host");
    assert.equal(parsed.stores[0].sidecarState.provenance, "measured");
    assert.equal(parsed.holderDetection.perspective, "host");
    assert.equal(parsed.holderDetection.provenance, "measured");
  });

  it("records unobserved guest transport as unmeasured/unknown, not host evidence", () => {
    const receipt = receiptFixture();
    receipt.stores = [
      {
        ...storeFixture(),
        configSource: GATE_RECEIPT_UNREADABLE,
        sidecarState: {
          wal: GATE_RECEIPT_UNREADABLE,
          shm: GATE_RECEIPT_UNREADABLE,
          journal: GATE_RECEIPT_UNREADABLE,
          perspective: GATE_RECEIPT_UNMEASURED,
          provenance: GATE_RECEIPT_UNKNOWN,
        },
        // A caller may carry host fstype evidence, but it is not part of the
        // schema and must never become guest evidence.
        ...({ fstype: "virtiofs" } as Record<string, unknown>),
      } as ReceiptStore,
    ];

    const parsed = JSON.parse(serializeReceipt(receipt));
    const store = parsed.stores[0];

    assert.equal(store.sidecarState.perspective, "unmeasured");
    assert.equal(store.sidecarState.provenance, "unknown");
    assert.equal(Object.prototype.hasOwnProperty.call(store, "fstype"), false);
    assert.equal(JSON.stringify(parsed).includes("virtiofs"), false);
  });
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

describe("gate-receipt: determinism", () => {
  it("serializes deep-cloned identical input byte-identically", () => {
    const input = receiptFixture();
    const clone = structuredClone(input);

    assert.equal(serializeReceipt(input), serializeReceipt(clone));
  });

  it("writes two identical receipts to separate temp files with an empty diff", () => {
    const dir = fixtureDir("gate-receipt-determinism-");
    const first = path.join(dir, "first.receipt.json");
    const second = path.join(dir, "second.receipt.json");
    const input = receiptFixture();

    fs.writeFileSync(first, serializeReceipt(input));
    fs.writeFileSync(second, serializeReceipt(structuredClone(input)));

    const firstBytes = fs.readFileSync(first);
    const secondBytes = fs.readFileSync(second);

    assert.deepEqual(firstBytes, secondBytes);
    assert.equal(firstBytes.toString("utf8"), secondBytes.toString("utf8"));
  });
});

// ---------------------------------------------------------------------------
// atomic writer
// ---------------------------------------------------------------------------

describe("gate-receipt: atomic writer", () => {
  it("writes a refusal receipt to disk atomically and re-reads it", () => {
    const dir = fixtureDir("gate-receipt-write-");
    const destination = path.join(dir, "receipt.json");
    const input = receiptFixture();

    const result = writeRefusalReceipt(input, { path: destination });

    expectWriteOk(result, destination);
    assert.equal(fs.existsSync(destination), true);

    const text = fs.readFileSync(destination, "utf8");
    const parsed = parseReceipt(text);

    assert.deepEqual(parsed, { ...structuredClone(input), action: "refused" });
    assert.equal(parsed.action, "refused");

    // Exactly one line of valid JSON, terminated by exactly one newline.
    assert.equal(text.endsWith("\n"), true);
    assert.equal((text.match(/\n/g) ?? []).length, 1);
    assert.equal(text.indexOf("\n"), text.length - 1);
    assert.equal(text.split("\n").length, 2);

    // The destination is the only artifact; no temporary file survives.
    assert.deepEqual(fs.readdirSync(dir), ["receipt.json"]);

    // Receipts are private by construction.
    const mode = fs.statSync(destination).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it("forces refused on the refusal path even when the input says launched", () => {
    const dir = fixtureDir("gate-receipt-refuse-forced-");
    const destination = path.join(dir, "receipt.json");
    const input = { ...receiptFixture(), action: "launched" as const };

    const result = writeRefusalReceipt(input, { path: destination });

    expectWriteOk(result, destination);
    const text = fs.readFileSync(destination, "utf8");
    assert.equal(parseReceipt(text).action, "refused");
    assert.equal(text.includes('"action":"launched"'), false);
  });

  it("writes nothing until the VM exists, then records launched", () => {
    const withoutVmDir = fixtureDir("gate-receipt-launch-gate-");
    const withoutVmPath = path.join(withoutVmDir, "receipt.json");
    const input = { ...receiptFixture(), action: "refused" as const };

    const gated = writeLaunchReceipt(input, { path: withoutVmPath });
    expectWriteFailure(gated, withoutVmPath);
    assert.equal(fs.existsSync(withoutVmPath), false);
    assert.deepEqual(fs.readdirSync(withoutVmDir), []);

    // `vmCreated: false` is not a launch either.
    const explicitFalseDir = fixtureDir("gate-receipt-launch-false-");
    const explicitFalsePath = path.join(explicitFalseDir, "receipt.json");
    const falseResult = writeLaunchReceipt(
      { ...input, vmCreated: false },
      { path: explicitFalsePath },
    );
    expectWriteFailure(falseResult, explicitFalsePath);
    assert.equal(fs.existsSync(explicitFalsePath), false);
    assert.deepEqual(fs.readdirSync(explicitFalseDir), []);

    const createdDir = fixtureDir("gate-receipt-launch-created-");
    const createdPath = path.join(createdDir, "receipt.json");
    const created = writeLaunchReceipt(
      { ...input, vmCreated: true },
      { path: createdPath },
    );
    expectWriteOk(created, createdPath);
    const parsed = parseReceipt(fs.readFileSync(createdPath, "utf8"));
    assert.equal(parsed.action, "launched");
    assert.deepEqual(fs.readdirSync(createdDir), ["receipt.json"]);
  });

  it("returns a typed failure and leaves nothing behind when writeFile throws", () => {
    const dir = fixtureDir("gate-receipt-write-fails-");
    const destination = path.join(dir, "receipt.json");

    const result = writeRefusalReceipt(receiptFixture(), {
      path: destination,
      // Simulate a partial write before the failure: cleanup must remove it.
      writeFile: (temporaryPath, data) => {
        fs.writeFileSync(temporaryPath, data.slice(0, 8));
        throw new Error("disk full");
      },
    });

    const failure = expectWriteFailure(result, destination);
    assert.match(failure.detail, /disk full/);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("returns a typed failure and removes the temporary file when rename throws", () => {
    const dir = fixtureDir("gate-receipt-rename-fails-");
    const destination = path.join(dir, "receipt.json");
    let observedFrom = "";

    const result = writeRefusalReceipt(receiptFixture(), {
      path: destination,
      rename: (from) => {
        observedFrom = from;
        throw new Error("rename denied");
      },
    });

    const failure = expectWriteFailure(result, destination);
    assert.match(failure.detail, /rename denied/);
    // The temporary file is a sibling of the destination, never elsewhere.
    assert.equal(observedFrom, destination + ".tmp");
    assert.equal(path.dirname(observedFrom), dir);
    assert.equal(fs.existsSync(observedFrom), false);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("returns a typed failure when serialization itself throws", () => {
    const dir = fixtureDir("gate-receipt-serialize-fails-");
    const destination = path.join(dir, "receipt.json");
    const input = receiptFixture();
    Object.defineProperty(input, "storeSetKey", {
      enumerable: true,
      configurable: true,
      get() {
        throw new Error("field could not be read");
      },
    });

    const result = writeRefusalReceipt(input, { path: destination });

    const failure = expectWriteFailure(result, destination);
    assert.match(failure.detail, /field could not be read/);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("never throws when cleanup also fails", () => {
    const dir = fixtureDir("gate-receipt-cleanup-fails-");
    const destination = path.join(dir, "receipt.json");

    const result = writeRefusalReceipt(receiptFixture(), {
      path: destination,
      writeFile: () => {
        throw new Error("primary failure");
      },
      unlink: () => {
        throw new Error("cleanup failure");
      },
    });

    const failure = expectWriteFailure(result, destination);
    assert.match(failure.detail, /primary failure/);
    assert.equal(fs.existsSync(destination), false);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  it("creates exactly one file per write and no other artifact", () => {
    const dir = fixtureDir("gate-receipt-single-artifact-");
    const destination = path.join(dir, "receipt.json");

    assert.deepEqual(fs.readdirSync(dir), []);

    expectWriteOk(
      writeRefusalReceipt(receiptFixture(), { path: destination }),
      destination,
    );

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "receipt.json");
    assert.equal(entries[0].isFile(), true);
    assert.equal(entries[0].isDirectory(), false);
    assert.equal(fs.existsSync(destination + ".tmp"), false);
    assert.equal(fs.existsSync(destination + ".tmp.lock"), false);
  });

  it("writes byte-identical receipts for identical observations", () => {
    const dir = fixtureDir("gate-receipt-writer-determinism-");
    const first = path.join(dir, "first.json");
    const second = path.join(dir, "second.json");
    const input = receiptFixture();

    expectWriteOk(writeRefusalReceipt(input, { path: first }), first);
    expectWriteOk(
      writeRefusalReceipt(structuredClone(input), { path: second }),
      second,
    );

    assert.deepEqual(fs.readFileSync(first), fs.readFileSync(second));
    assert.deepEqual(fs.readdirSync(dir).sort(), ["first.json", "second.json"]);
  });
});

// ---------------------------------------------------------------------------
// module purity
// ---------------------------------------------------------------------------

describe("gate-receipt: module purity", () => {
  const source = fs.readFileSync(MODULE_PATH, "utf-8");

  it("uses no child process, database driver, clock, randomness or environment", () => {
    const forbidden = [
      "node:" + "child_process",
      "sqlite",
      "Database" + "Sync",
      "Date",
      "Math" + "." + "random",
      "process" + ".env",
    ];
    for (const token of forbidden) {
      assert.equal(
        source.includes(token),
        false,
        `gate-receipt.ts must not reference ${token}`,
      );
    }
  });

  it("contains no host fstype value as guest evidence", () => {
    assert.equal(source.includes("ext4"), false);
    assert.equal(source.includes("virtiofs"), false);
  });

  it("is not listed in tests/serial-files.txt (parallel lane, no spawns)", () => {
    const ownRelativePath = path.relative(
      REPO_ROOT,
      fileURLToPath(import.meta.url),
    );
    const serialEntries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    assert.equal(
      serialEntries.includes(ownRelativePath),
      false,
      `this parallel test file (${ownRelativePath}) must NOT be in tests/serial-files.txt`,
    );
  });
});
