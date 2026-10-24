/**
 * gate-qualification tests (G8 ADMISSION-INTEGRATION US-009, bead
 * tamandua-7p5.1.8).
 *
 * These tests drive the PRODUCTION module
 * (`src/installer/matchlock/gate-qualification.ts` through its compiled module
 * in `dist/`) with REAL files: the matchlock and guest-init fixtures are actual
 * files whose sha256 the default reader must compute, the receipt path is a real
 * directory tree the default writer must create, and the store fixture holds a
 * marker string that must never reach the record.
 *
 * What is pinned:
 *
 *  - a full record: Tamandua commit/tree/dist stamp, both binary digests, the
 *    selected image reference/digest/config digest, the profile home, guest
 *    HERMES home and config sources, the run/attempt ids, the candidate dist
 *    root and executed binary paths;
 *  - the DECISION wins over a caller restatement (an allow binding's invocation
 *    id, kind, store-set key and receipt path are what the record names);
 *  - unmeasurable fields are PRESENT as `unreadable`, never omitted and never
 *    fabricated, and a throwing seam never throws;
 *  - the executed `dist/version` stamp decides the commit (an artifact beats a
 *    claim), while the tree is only ever caller/identity-supplied;
 *  - the write is atomic and mode 0600, and every failure (write, rename, no
 *    receipt path) is a typed result rather than an exception;
 *  - identical inputs serialize byte-identically with a pinned key order;
 *  - a whitelist construction: extra caller properties (raw argv, file
 *    contents, a config body) never reach the file, and credential-shaped text
 *    is scrubbed;
 *  - the record states the out-of-scope raw `matchlock run` case and the
 *    no-lease limitation, and lists the four gated invocation kinds;
 *  - guest visibility is recorded with perspective `guest` only, with an
 *    unmeasured provenance instead of a fabricated mode.
 *
 * LANE. `node:fs`/`node:crypto` only — no child_process, no daemon, no VM — so
 * this file belongs to the PARALLEL lane; its last test asserts it is not
 * registered in `tests/serial-files.txt`.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "../../../dist/lib/comment-blind.js";
import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import {
  GATE_RECEIPT_UNREADABLE,
  NO_LEASE_LIMITATION,
} from "../../../dist/installer/matchlock/gate-receipt.js";
import {
  GATE_QUALIFICATION_GATED_KINDS,
  GATE_QUALIFICATION_OUT_OF_SCOPE,
  GATE_QUALIFICATION_RECORD_KIND,
  GATE_QUALIFICATION_SCHEMA_VERSION,
  captureQualificationRecord,
  distVersionStampCommit,
  resolveQualificationRecordPath,
  serializeQualificationRecord,
  writeQualificationRecord,
} from "../../../dist/installer/matchlock/gate-qualification.js";
import type { QualificationRecord } from "../../../dist/installer/matchlock/gate-qualification.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const SERIAL_FILES = path.join(REPO_ROOT, "tests", "serial-files.txt");
const MODULE_SOURCE = path.join(
  REPO_ROOT,
  "src",
  "installer",
  "matchlock",
  "gate-qualification.ts",
);

/** The executed module's own dist root, for the default-value assertions. */
const EXECUTED_DIST_ROOT = path.resolve(REPO_ROOT, "dist");

const roots: string[] = [];

function makeRoot(): string {
  const dir = tamanduaShortTempDir("gate-qual-");
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A quiet measurement baseline: no stamp, no digests unless a test asks. */
function quietDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha256File: () => null,
    readDistVersionStamp: () => null,
    ...overrides,
  };
}

const COMMIT = "16aba10456925dc523de2db95a7cb9ebcfdc1af2";
const TREE = "e9ae1df9c0e54c8fdb4c2f0e9f1d5e2a5b7c9d10";
const STAMP = `20261024T014144Z_${COMMIT}`;

function allowDecision(
  receiptPath: string,
  bindingOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    action: "allow",
    binding: {
      invocationId: "run:abc:round:job-1:dispatch",
      kind: "scheduled-dispatch",
      storeSetKey: "sha256:store-set-key",
      receiptPath,
      decidedAt: "2026-10-24T00:00:00.000Z",
      stores: [
        {
          canonicalPath: "/home/dev/.hermes/state.db",
          dev: "2049",
          ino: "1234",
        },
      ],
      configJournalMode: "delete",
      configSource: "user",
      ...bindingOverrides,
    },
    receiptInput: {},
  };
}

function refuseDecision(receiptPath: string): Record<string, unknown> {
  const findings = [
    {
      code: "wal-header",
      store: "/home/dev/.hermes/state.db",
      detail: "store header is write-ahead-log format",
      remedy: [{ description: "convert the store to journal_mode=delete" }],
    },
  ];
  return {
    action: "refuse",
    refusal: {
      kind: "verdict",
      detail: "store is not a rollback-format store",
      receiptPath,
      receiptWritten: true,
      verdict: { action: "refuse", findings },
      findings,
    },
  };
}

/** Write one fixture file and return its path plus its sha256. */
function fixtureFile(root: string, name: string, content: string): {
  filePath: string;
  sha256: string;
} {
  const filePath = path.join(root, name);
  fs.writeFileSync(filePath, content, "utf8");
  const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  return { filePath, sha256 };
}

describe("gate qualification: record capture", () => {
  it("captures the full artifact and candidate binding for an allow decision", () => {
    const root = makeRoot();
    const matchlock = fixtureFile(root, "matchlock", "matchlock-binary-bytes");
    const guestInit = fixtureFile(root, "guest-init", "guest-init-bytes");
    const receiptPath = path.join(root, "state", "gate", "run-abc-dispatch.json");

    const record = captureQualificationRecord(
      allowDecision(receiptPath) as never,
      {
        invocation: {
          invocationId: "run:abc:round:job-1:dispatch",
          kind: "scheduled-dispatch",
          runId: "run-abc",
          roundId: "job-1",
        },
        tamandua: { tree: TREE },
        matchlock: { path: matchlock.filePath, version: "matchlock 1.2.3 (commit: abc)" },
        guestInit: { path: guestInit.filePath },
        image: {
          reference: "ghcr.io/example/bedlam-ubuntu:latest",
          pinnedIdentity: {
            digest: "sha256:9140629cafebabe",
            config_digest: "sha256:cca820dfdeadbeef",
            tag: "latest",
          },
        },
        profiles: {
          hostEffectiveDir: "/home/dev/.hermes",
          guestHermesHome: "/root/.hermes",
          configSources: ["/home/dev/.hermes/config.yaml", "/etc/hermes/config.yaml"],
        },
        candidate: {
          distRoot: "/opt/tamandua/dist",
          executedBinaryPaths: ["/opt/tamandua/dist/cli/cli.js"],
        },
        guestVisibility: [
          {
            storePath: "/home/dev/.hermes/state.db",
            journalMode: "delete",
            source: "/root/.hermes/config.yaml",
            readable: true,
            provenance: "measured",
          },
        ],
      },
      // No sha256File override here: the DEFAULT reader must hash the real
      // fixture bytes.
      { readDistVersionStamp: () => STAMP },
    );

    assert.equal(record.schemaVersion, GATE_QUALIFICATION_SCHEMA_VERSION);
    assert.equal(record.recordKind, GATE_QUALIFICATION_RECORD_KIND);

    assert.equal(record.invocation.invocationId, "run:abc:round:job-1:dispatch");
    assert.equal(record.invocation.kind, "scheduled-dispatch");
    assert.equal(record.invocation.runId, "run-abc");
    assert.equal(record.invocation.roundId, "job-1");

    assert.equal(record.receipt.path, receiptPath);
    assert.equal(record.receipt.storeSetKey, "sha256:store-set-key");
    assert.equal(record.receipt.verdict, "allow");

    // The executed dist stamp carries the commit; the tree is caller-supplied.
    assert.equal(record.tamandua.commit, COMMIT);
    assert.equal(record.tamandua.tree, TREE);
    assert.equal(record.tamandua.distVersionStamp, STAMP);

    // Digests come from the REAL bytes via the default reader.
    assert.equal(record.matchlock.path, matchlock.filePath);
    assert.equal(record.matchlock.sha256, matchlock.sha256);
    assert.equal(record.matchlock.version, "matchlock 1.2.3 (commit: abc)");
    assert.equal(record.guestInit.path, guestInit.filePath);
    assert.equal(record.guestInit.sha256, guestInit.sha256);

    // Image identity is recorded with its conventional `sha256:` form.
    assert.equal(record.image.reference, "ghcr.io/example/bedlam-ubuntu:latest");
    assert.equal(record.image.digest, "sha256:9140629cafebabe");
    assert.equal(record.image.configDigest, "sha256:cca820dfdeadbeef");

    assert.equal(record.profiles.hostEffectiveDir, "/home/dev/.hermes");
    assert.equal(record.profiles.guestHermesHome, "/root/.hermes");
    assert.deepEqual(record.profiles.configSources, [
      "/etc/hermes/config.yaml",
      "/home/dev/.hermes/config.yaml",
    ]);

    assert.equal(record.candidate.distRoot, "/opt/tamandua/dist");
    assert.deepEqual(record.candidate.executedBinaryPaths, [
      "/opt/tamandua/dist/cli/cli.js",
    ]);

    assert.deepEqual(record.guestVisibility, [
      {
        storePath: "/home/dev/.hermes/state.db",
        journalMode: "delete",
        source: "/root/.hermes/config.yaml",
        readable: true,
        perspective: "guest",
        provenance: "measured",
      },
    ]);
  });

  it("binds a refusal to its receipt and reports verdict refuse", () => {
    const receiptPath = "/var/state/matchlock/gate/run-abc-round-job-2-attempt.json";
    const record = captureQualificationRecord(
      refuseDecision(receiptPath) as never,
      {
        invocation: {
          invocationId: "run:abc:round:job-2:attempt",
          kind: "scheduled-attempt",
          runId: "run-abc",
        },
        // The receipt's own store-set key is supplied out of band: the
        // refusal type carries the receipt path but not the key.
        receipt: { storeSetKey: "sha256:refused-store-set" },
      },
      quietDeps(),
    );

    assert.equal(record.receipt.path, receiptPath);
    assert.equal(record.receipt.verdict, "refuse");
    assert.equal(record.receipt.storeSetKey, "sha256:refused-store-set");
    assert.equal(record.invocation.kind, "scheduled-attempt");
    assert.equal(record.invocation.runId, "run-abc");
    // The refusal takes no findings into the record: the receipt owns them,
    // and the closed reason-code set is not duplicated here.
    assert.equal(
      Object.prototype.hasOwnProperty.call(record, "findings"),
      false,
    );
  });

  it("prefers the decision's own identity over a caller restatement", () => {
    const receiptPath = "/var/state/matchlock/gate/bound.json";
    const record = captureQualificationRecord(
      allowDecision(receiptPath, {
        invocationId: "run:bound:round:job-9:dispatch",
        kind: "interactive-hermes-shell",
        storeSetKey: "sha256:bound-key",
      }) as never,
      {
        invocation: {
          invocationId: "run:other:round:job-0:dispatch",
          kind: "scheduled-dispatch",
        },
        receipt: {
          path: "/var/state/matchlock/gate/other.json",
          storeSetKey: "sha256:other-key",
        },
      },
      quietDeps(),
    );

    assert.equal(record.invocation.invocationId, "run:bound:round:job-9:dispatch");
    assert.equal(record.invocation.kind, "interactive-hermes-shell");
    assert.equal(record.receipt.path, receiptPath);
    assert.equal(record.receipt.storeSetKey, "sha256:bound-key");
  });

  it("records unmeasurable fields as the sentinel, never omitting them", () => {
    const record = captureQualificationRecord(null, null, quietDeps());
    const parsed = JSON.parse(serializeQualificationRecord(record));

    assert.deepEqual(Object.keys(parsed), [
      "schemaVersion",
      "recordKind",
      "invocation",
      "receipt",
      "tamandua",
      "matchlock",
      "guestInit",
      "image",
      "profiles",
      "candidate",
      "guestVisibility",
      "discrepancy",
      "scope",
    ]);

    assert.equal(parsed.invocation.invocationId, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.invocation.kind, GATE_RECEIPT_UNREADABLE);
    assert.equal("runId" in parsed.invocation, false);
    assert.equal("roundId" in parsed.invocation, false);

    assert.equal(parsed.receipt.path, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.receipt.storeSetKey, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.receipt.verdict, GATE_RECEIPT_UNREADABLE);

    assert.equal(parsed.tamandua.commit, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.tamandua.tree, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.tamandua.distVersionStamp, GATE_RECEIPT_UNREADABLE);

    assert.equal(parsed.matchlock.path, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.matchlock.sha256, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.matchlock.version, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.guestInit.path, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.guestInit.sha256, GATE_RECEIPT_UNREADABLE);

    assert.equal(parsed.image.reference, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.image.digest, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.image.configDigest, GATE_RECEIPT_UNREADABLE);

    assert.equal(parsed.profiles.hostEffectiveDir, GATE_RECEIPT_UNREADABLE);
    assert.equal(parsed.profiles.guestHermesHome, GATE_RECEIPT_UNREADABLE);
    assert.deepEqual(parsed.profiles.configSources, []);

    assert.deepEqual(parsed.guestVisibility, []);
    // The dist root IS measurable: it is where the executed code lives.
    assert.equal(path.isAbsolute(parsed.candidate.distRoot), true);
    assert.equal(parsed.candidate.distRoot, EXECUTED_DIST_ROOT);
    assert.deepEqual(parsed.candidate.executedBinaryPaths, []);
  });

  it("never throws when a measurement seam throws", () => {
    const record = captureQualificationRecord(
      allowDecision("/var/state/gate/x.json") as never,
      {
        matchlock: { path: "/does/not/exist/matchlock" },
        guestInit: { path: "/does/not/exist/guest-init" },
      },
      {
        readDistVersionStamp: () => {
          throw new Error("stamp read exploded");
        },
        sha256File: () => {
          throw new Error("digest exploded");
        },
        resolveTamanduaSourceIdentity: () => {
          throw new Error("identity exploded");
        },
      },
    );

    assert.equal(record.tamandua.distVersionStamp, GATE_RECEIPT_UNREADABLE);
    assert.equal(record.tamandua.commit, GATE_RECEIPT_UNREADABLE);
    assert.equal(record.tamandua.tree, GATE_RECEIPT_UNREADABLE);
    assert.equal(record.matchlock.sha256, GATE_RECEIPT_UNREADABLE);
    assert.equal(record.guestInit.sha256, GATE_RECEIPT_UNREADABLE);
  });

  it("takes the commit from the executed stamp and the tree from the source identity", () => {
    const record = captureQualificationRecord(
      allowDecision("/var/state/gate/y.json") as never,
      { tamandua: { commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" } },
      quietDeps({ readDistVersionStamp: () => STAMP }),
    );
    // A claim that disagrees with the executed artifact is not written as the
    // executed identity: the stamp wins.
    assert.equal(record.tamandua.commit, COMMIT);
    assert.equal(record.tamandua.tree, GATE_RECEIPT_UNREADABLE);

    const fromIdentity = captureQualificationRecord(
      allowDecision("/var/state/gate/z.json") as never,
      {},
      quietDeps({
        resolveTamanduaSourceIdentity: () => ({ commit: COMMIT, tree: TREE }),
      }),
    );
    assert.equal(fromIdentity.tamandua.commit, COMMIT);
    assert.equal(fromIdentity.tamandua.tree, TREE);
    assert.equal(fromIdentity.tamandua.distVersionStamp, GATE_RECEIPT_UNREADABLE);
  });

  it("normalizes bare binary digests and rejects malformed ones", () => {
    const upper = crypto
      .createHash("sha256")
      .update("payload")
      .digest("hex")
      .toUpperCase();

    const normalized = captureQualificationRecord(
      allowDecision("/var/state/gate/d.json") as never,
      {
        matchlock: { path: "/opt/bin/matchlock", sha256: `sha256:${upper}` },
        guestInit: { path: "/opt/bin/guest-init", sha256: "not-a-digest" },
      },
      quietDeps(),
    );

    assert.equal(normalized.matchlock.sha256, upper.toLowerCase());
    assert.match(normalized.matchlock.sha256 as string, /^[0-9a-f]{64}$/);
    assert.equal(normalized.guestInit.sha256, GATE_RECEIPT_UNREADABLE);
  });

  it("records guest visibility with a guest perspective only", () => {
    const record = captureQualificationRecord(
      allowDecision("/var/state/gate/g.json") as never,
      {
        guestVisibility: [
          {
            storePath: "/root/.hermes/state.db",
            journalMode: "wal",
            source: "/root/.hermes/config.yaml",
            readable: true,
            // A caller cannot declare a host read to be guest evidence.
            perspective: "host",
            provenance: "measured",
          },
          {
            storePath: "/root/.hermes/other.db",
            rereadable: "nonsense",
            readable: "yes",
            provenance: "guessed",
          },
          null as unknown as { storePath: string },
        ],
      },
      quietDeps(),
    );

    assert.equal(record.guestVisibility.length, 2);
    assert.equal(record.guestVisibility[0].perspective, "guest");
    assert.equal(record.guestVisibility[0].provenance, "measured");
    assert.equal(record.guestVisibility[0].journalMode, "wal");
    assert.equal(record.guestVisibility[1].perspective, "guest");
    assert.equal(record.guestVisibility[1].provenance, "unknown");
    assert.equal(record.guestVisibility[1].readable, GATE_RECEIPT_UNREADABLE);
    assert.equal(
      record.guestVisibility[1].journalMode,
      GATE_RECEIPT_UNREADABLE,
      "an unmeasured mode must never be fabricated as delete",
    );
  });

  it("states the scope, the out-of-scope raw run case and the no-lease limitation", () => {
    const record = captureQualificationRecord(null, null, quietDeps());

    assert.deepEqual(record.scope.gatedKinds, [
      "interactive-hermes",
      "interactive-hermes-shell",
      "scheduled-dispatch",
      "scheduled-attempt",
    ]);
    assert.deepEqual(record.scope.gatedKinds, [...GATE_QUALIFICATION_GATED_KINDS]);
    assert.deepEqual(record.scope.outOfScope, [...GATE_QUALIFICATION_OUT_OF_SCOPE]);
    assert.deepEqual(record.scope.outOfScope, [
      "raw matchlock run with a hermes payload",
    ]);
    assert.equal(record.scope.lease, NO_LEASE_LIMITATION);
    assert.equal(record.scope.lease, "no-lease: concurrent admissions may both pass");

    // The FILE pins the canonical scope too: a hand-edited record cannot claim
    // a different kind set, a covered raw run, or a lease.
    const tampered = {
      ...record,
      scope: {
        gatedKinds: ["scheduled-dispatch"],
        outOfScope: ["raw matchlock run with a hermes payload"],
        lease: "leased: one admission at a time",
      },
    };
    const serialized = JSON.parse(serializeQualificationRecord(tampered));
    assert.deepEqual(serialized.scope.gatedKinds, [
      "interactive-hermes",
      "interactive-hermes-shell",
      "scheduled-dispatch",
      "scheduled-attempt",
    ]);
    assert.deepEqual(serialized.scope.outOfScope, [
      "raw matchlock run with a hermes payload",
    ]);
    assert.equal(serialized.scope.lease, NO_LEASE_LIMITATION);
  });

  it("keeps the image digests in their conventional form and lets explicit win", () => {
    const record = captureQualificationRecord(
      allowDecision("/var/state/gate/i.json") as never,
      {
        image: {
          reference: "local/image:tag",
          digest: "sha256:explicitdigest",
          pinnedIdentity: {
            digest: "sha256:pinneddigest",
            config_digest: "sha256:pinnedconfigdigest",
            tag: "tag",
          },
        },
      },
      quietDeps(),
    );

    assert.equal(record.image.digest, "sha256:explicitdigest");
    assert.equal(record.image.configDigest, "sha256:pinnedconfigdigest");
  });
});

describe("gate qualification: deterministic serialization", () => {
  it("serializes identical inputs byte-identically", () => {
    const root = makeRoot();
    const matchlock = fixtureFile(root, "matchlock", "same-bytes");
    const inputs = {
      invocation: {
        invocationId: "interactive:hermes:pid:1:start:2",
        kind: "interactive-hermes",
      },
      matchlock: { path: matchlock.filePath, version: "matchlock 1.2.3" },
      guestInit: { path: matchlock.filePath },
      profiles: {
        hostEffectiveDir: "/home/dev/.hermes",
        guestHermesHome: "/root/.hermes",
        configSources: ["b/config.yaml", "a/config.yaml", "a/config.yaml"],
      },
      candidate: {
        distRoot: "/opt/tamandua/dist",
        executedBinaryPaths: ["/opt/z.js", "/opt/a.js", "/opt/z.js"],
      },
    };
    const deps = quietDeps({ readDistVersionStamp: () => STAMP });

    const first = captureQualificationRecord(
      allowDecision("/var/state/gate/det.json") as never,
      inputs,
      deps,
    );
    const second = captureQualificationRecord(
      allowDecision("/var/state/gate/det.json") as never,
      inputs,
      deps,
    );

    const firstText = serializeQualificationRecord(first);
    const secondText = serializeQualificationRecord(second);

    assert.equal(firstText, secondText);
    assert.deepEqual(JSON.parse(firstText), JSON.parse(secondText));
    // Sets are deduped and byte-sorted; the ordered guest list keeps its order.
    assert.deepEqual(first.profiles.configSources, [
      "a/config.yaml",
      "b/config.yaml",
    ]);
    assert.deepEqual(first.candidate.executedBinaryPaths, [
      "/opt/a.js",
      "/opt/z.js",
    ]);

    const third = serializeQualificationRecord(
      captureQualificationRecord(
        allowDecision("/var/state/gate/det.json") as never,
        { ...inputs, matchlock: { ...inputs.matchlock, version: "matchlock 9.9.9" } },
        deps,
      ),
    );
    assert.notEqual(third, firstText);
  });

  it("emits the pinned key order for nested blocks", () => {
    const record = captureQualificationRecord(
      allowDecision("/var/state/gate/keys.json") as never,
      { matchlock: { path: "/opt/bin/matchlock", version: "v", sha256: "a".repeat(64) } },
      quietDeps(),
    );
    const parsed = JSON.parse(serializeQualificationRecord(record));

    assert.deepEqual(Object.keys(parsed.invocation), [
      "invocationId",
      "kind",
    ]);
    assert.deepEqual(Object.keys(parsed.tamandua), [
      "commit",
      "tree",
      "distVersionStamp",
    ]);
    assert.deepEqual(Object.keys(parsed.matchlock), ["path", "sha256", "version"]);
    assert.deepEqual(Object.keys(parsed.guestInit), ["path", "sha256"]);
    assert.deepEqual(Object.keys(parsed.image), [
      "reference",
      "digest",
      "configDigest",
    ]);
    assert.deepEqual(Object.keys(parsed.profiles), [
      "hostEffectiveDir",
      "guestHermesHome",
      "configSources",
    ]);
    assert.deepEqual(Object.keys(parsed.candidate), [
      "distRoot",
      "executedBinaryPaths",
    ]);
    assert.deepEqual(Object.keys(parsed.scope), [
      "gatedKinds",
      "outOfScope",
      "lease",
    ]);
  });

  it("serializes a hand-built record through the same whitelist", () => {
    const record = captureQualificationRecord(
      allowDecision("/var/state/gate/wl.json") as never,
      {},
      quietDeps(),
    );
    // Extra properties on the record and its blocks are not fields.
    const polluted = {
      ...record,
      fileContents: "LEAKED-FILE-CONTENT",
      argv: ["--token", "leaked-token"],
      tamandua: { ...record.tamandua, rawGitArgs: ["rev-parse", "HEAD"] },
    } as QualificationRecord;

    const text = serializeQualificationRecord(polluted);
    assert.equal(text.includes("LEAKED-FILE-CONTENT"), false);
    assert.equal(text.includes("leaked-token"), false);
    assert.equal(text.includes("rawGitArgs"), false);
    assert.equal(text.includes("rev-parse"), false);
  });
});

describe("gate qualification: no contents, credentials or raw argv", () => {
  it("never copies unknown inputs or a store's contents into the record", () => {
    const root = makeRoot();
    const store = fixtureFile(root, "state.db", "STORE-CONTENT-MARKER");

    const inputs = {
      invocation: {
        invocationId: "run:abc:round:job-3:attempt",
        kind: "scheduled-attempt",
        runId: "run-abc",
      },
      matchlock: {
        path: "/opt/bin/matchlock",
        sha256: "a".repeat(64),
        version: "matchlock 1.2.3",
        argv: ["matchlock", "--token", "RAW-ARGV-LEAK"],
      },
      guestInit: { path: "/opt/bin/guest-init", sha256: "b".repeat(64) },
      profiles: {
        hostEffectiveDir: "/home/dev/.hermes",
        guestHermesHome: "/root/.hermes",
        configSources: ["/home/dev/.hermes/config.yaml"],
        configBody: "database:\n  journal_mode: delete\n",
      },
      guestVisibility: [
        {
          storePath: store.filePath,
          journalMode: "delete",
          source: "/root/.hermes/config.yaml",
          readable: true,
          provenance: "measured",
          contents: "STORE-CONTENT-MARKER",
        },
      ],
      argv: ["tamandua", "matchlock", "hermes"],
      fileContents: "STORE-CONTENT-MARKER",
    };

    const text = serializeQualificationRecord(
      captureQualificationRecord(
        allowDecision("/var/state/gate/pure.json") as never,
        inputs,
        quietDeps(),
      ),
    );

    assert.equal(text.includes("STORE-CONTENT-MARKER"), false);
    assert.equal(text.includes("RAW-ARGV-LEAK"), false);
    assert.equal(text.includes("journal_mode: delete"), false);
    assert.equal(text.includes('"argv"'), false);
  });

  it("scrubs credential-shaped text from the fields it does record", () => {
    const text = serializeQualificationRecord(
      captureQualificationRecord(
        allowDecision("/var/state/gate/cred.json?token=pathecret") as never,
        {
          matchlock: {
            path: "/opt/bin/matchlock?token=pathsecret123",
            sha256: "a".repeat(64),
            version:
              "matchlock 1.2.3 token=supersecret123 Bearer abcdef123456 sk-live-abcdef123456",
          },
          profiles: { configSources: ["/home/dev/.hermes/config.yaml?key=layerkey123"] },
        },
        quietDeps(),
      ),
    );

    assert.equal(text.includes("supersecret123"), false);
    assert.equal(text.includes("abcdef123456"), false);
    assert.equal(text.includes("sk-live-abcdef123456"), false);
    assert.equal(text.includes("pathsecret123"), false);
    assert.equal(text.includes("layerkey123"), false);
    assert.ok(text.includes("[redacted]"));
  });
});

describe("gate qualification: write", () => {
  it("writes atomically next to the receipt with mode 0600", () => {
    const root = makeRoot();
    const receiptPath = path.join(
      root,
      "state",
      "matchlock",
      "gate",
      "run-abc-round-job-4-dispatch.json",
    );
    const record = captureQualificationRecord(
      allowDecision(receiptPath) as never,
      {
        invocation: {
          invocationId: "run:abc:round:job-4:dispatch",
          kind: "scheduled-dispatch",
        },
      },
      quietDeps({ readDistVersionStamp: () => STAMP }),
    );

    const result = writeQualificationRecord(record);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(
      result.path,
      path.join(
        root,
        "state",
        "matchlock",
        "gate",
        "run-abc-round-job-4-dispatch.qualification.json",
      ),
    );
    const text = fs.readFileSync(result.path, "utf8");
    assert.equal(text, `${serializeQualificationRecord(record)}\n`);
    const parsed = JSON.parse(text);
    assert.equal(parsed.recordKind, GATE_QUALIFICATION_RECORD_KIND);
    assert.equal(parsed.receipt.path, receiptPath);
    assert.equal(parsed.scope.lease, NO_LEASE_LIMITATION);

    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(`${result.path}.tmp-${process.pid}`), false);
  });

  it("returns a typed failure when the write throws and never throws", () => {
    const target = "/var/state/gate/failure.qualification.json";
    const unlinked: string[] = [];
    const record = captureQualificationRecord(
      allowDecision("/var/state/gate/failure.json") as never,
      {},
      quietDeps(),
    );

    const result = writeQualificationRecord(record, {
      path: target,
      mkdir: () => {},
      writeFile: () => {
        throw new Error("ENOSPC: no space left on device");
      },
      rename: () => {},
      unlink: (filePath) => {
        unlinked.push(filePath);
      },
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "qualification-write-failed");
    assert.equal(result.path, target);
    assert.match(result.detail, /ENOSPC/);
    assert.deepEqual(unlinked, [`${target}.tmp-${process.pid}`]);
  });

  it("returns a typed failure when the rename fails and cleans the temporary", () => {
    const target = "/var/state/gate/rename.qualification.json";
    const unlinked: string[] = [];
    const written: string[] = [];

    const result = writeQualificationRecord(
      captureQualificationRecord(
        allowDecision("/var/state/gate/rename.json") as never,
        {},
        quietDeps(),
      ),
      {
        path: target,
        mkdir: () => {},
        writeFile: (filePath) => {
          written.push(filePath);
        },
        rename: () => {
          throw new Error("EXDEV: cross-device link not permitted");
        },
        unlink: (filePath) => {
          unlinked.push(filePath);
        },
      },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "qualification-write-failed");
    assert.match(result.detail, /EXDEV/);
    assert.deepEqual(written, [`${target}.tmp-${process.pid}`]);
    assert.deepEqual(unlinked, [`${target}.tmp-${process.pid}`]);
  });

  it("refuses a record whose receipt path is unreadable", () => {
    const record = captureQualificationRecord(null, null, quietDeps());
    const result = writeQualificationRecord(record);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, "qualification-write-failed");
    assert.equal(result.path, "");
    assert.match(result.detail, /no receipt path/);
  });

  it("derives the record path from the receipt path", () => {
    assert.equal(
      resolveQualificationRecordPath("/s/gate/run-1.json"),
      "/s/gate/run-1.qualification.json",
    );
    assert.equal(
      resolveQualificationRecordPath("/s/gate/attempt-abc.json"),
      "/s/gate/attempt-abc.qualification.json",
    );
    assert.equal(
      resolveQualificationRecordPath("/s/gate/run-1"),
      "/s/gate/run-1.qualification.json",
    );
    assert.equal(resolveQualificationRecordPath(""), "");
    assert.equal(resolveQualificationRecordPath("   "), "");
    // The sentinel is not a path: a record with no measured receipt path has
    // nowhere to go, and must never be written under a fabricated file name.
    assert.equal(resolveQualificationRecordPath(GATE_RECEIPT_UNREADABLE), "");
  });

  it("parses the dist stamp commit only for a git build", () => {
    assert.equal(distVersionStampCommit(STAMP), COMMIT);
    assert.equal(distVersionStampCommit("0.1.0"), null);
    assert.equal(distVersionStampCommit("20261024T014144Z_nothex"), null);
    assert.equal(distVersionStampCommit(""), null);
    assert.equal(distVersionStampCommit(" "), null);
  });
});

describe("gate qualification: module boundary", () => {
  it("imports no child process and carries no raw argv field", () => {
    const code = stripComments(fs.readFileSync(MODULE_SOURCE, "utf8"));
    assert.equal(code.includes("node:child_process"), false);
    assert.equal(code.includes("child_process"), false);
    assert.equal(/\bargv\b/.test(code), false);
  });

  it("stays in the parallel lane", () => {
    const listed = fs.existsSync(SERIAL_FILES)
      ? fs
          .readFileSync(SERIAL_FILES, "utf8")
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line !== "" && !line.startsWith("#"))
      : [];
    assert.equal(
      listed.includes("src/installer/matchlock/gate-qualification.test.ts"),
      false,
      "gate-qualification.test.ts spawns nothing; it must not be serial-listed",
    );
  });
});
