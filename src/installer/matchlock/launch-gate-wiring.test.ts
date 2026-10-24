/**
 * launch-gate wiring tests (G8 ADMISSION-INTEGRATION US-001, bead
 * tamandua-7p5.1.8).
 *
 * These tests exercise src/installer/matchlock/launch-gate-wiring.ts through
 * the COMPILED module in dist/ (repo convention for this directory), so
 * `npm run build` must run first.
 *
 * What is pinned here is the property that makes one wiring module worth having:
 *
 *  - an allow returns a decision BOUND to the observed identities, and writes
 *    nothing — the launch receipt may only be recorded after the VM exists;
 *  - a refusal writes exactly ONE parseable receipt, carries the G9 exit code,
 *    and can never be followed by a create call;
 *  - aggregation: every store is observed and every finding is preserved, so
 *    one bad store (or one store whose observation throws) never hides another;
 *  - an operational failure (store set, revalidation, receipt write) is its own
 *    class, always refuses, and never becomes an allow;
 *  - the store-set key is an identity digest: stable for identical identities,
 *    different when a store's dev or ino changes.
 *
 * The fixtures are REAL filesystem objects: a real delete-mode SQLite database
 * for the compliant store (so "a genuine rollback store passes" is evidence,
 * not an assumption) and a byte-exact write-ahead-log header for the store that
 * must be refused.
 *
 * This file spawns no process and imports no node:child_process, so it belongs
 * in the PARALLEL lane; the last test asserts that, and that the module under
 * test takes its exit status from the G9 allocation instead of spelling it.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import { LAUNCH_GATE_REFUSAL_EXIT_CODE } from "../../../dist/installer/matchlock/gate-exit-code.js";
import {
  NO_LEASE_LIMITATION,
  parseReceipt,
} from "../../../dist/installer/matchlock/gate-receipt.js";
import {
  interactiveStoreMountPlan,
  LAUNCH_GATE_STORE_CONTRACT,
} from "../../../dist/installer/matchlock/doctor-gate.js";
import { observeStore } from "../../../dist/installer/matchlock/store-header.js";
import { StoreSetInputError } from "../../../dist/installer/matchlock/store-set.js";
import {
  LaunchGateRefusalError,
  evaluateAndRecordLaunchGate,
  launchGateStoreSetKey,
  resolveLaunchGateReceiptPath,
  writeLaunchGateLaunchReceipt,
} from "../../../dist/installer/matchlock/launch-gate-wiring.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const MODULE_PATH = path.join(HERE, "launch-gate-wiring.ts");
const SERIAL_FILES_PATH = path.join(REPO_ROOT, "tests", "serial-files.txt");

/** Every temp dir this file creates, removed in `after`. */
const temporaryDirectories: string[] = [];

function track(directory: string): string {
  temporaryDirectories.push(directory);
  return directory;
}

after(() => {
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

/** A private state dir the receipt path is resolved under. */
function newStateDir(): string {
  return track(tamanduaShortTempDir("tamandua-gw-state-"));
}

/**
 * A disposable profile home holding a REAL rollback-format SQLite store and a
 * `config.yaml` that requests the delete journal mode.
 */
function newProfileHome(journalMode: "delete" | "wal" = "delete"): string {
  const home = track(tamanduaShortTempDir("tamandua-gw-home-"));
  fs.writeFileSync(
    path.join(home, "config.yaml"),
    `database:\n  journal_mode: ${journalMode}\n`,
  );
  const database = new DatabaseSync(path.join(home, "state.db"));
  database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, value TEXT)");
  database.exec("INSERT INTO t (value) VALUES ('row')");
  database.close();
  return home;
}

/**
 * A byte-exact write-ahead-log store: correct SQLite signature, version pair
 * (2,2), no sidecars. The gate reads bytes only, so this is the same evidence a
 * genuine WAL store presents in its header.
 */
function writeWalStore(home: string, name = "verification_evidence.db"): string {
  const file = path.join(home, name);
  const header = Buffer.alloc(4096);
  Buffer.from("SQLite format 3\u0000", "latin1").copy(header, 0);
  header[18] = 2;
  header[19] = 2;
  fs.writeFileSync(file, header);
  return file;
}

/** Deterministic stored instants: UTC ISO-Z, one second apart. */
function sequenceNow(): () => string {
  let tick = 0;
  const base = Date.parse("2026-01-02T03:04:05.000Z");
  return () => new Date(base + tick++ * 1000).toISOString();
}

/** One scheduled-dispatch scope over a real profile home. */
function scopeFor(home: string, overrides: Record<string, unknown> = {}): any {
  return {
    kind: "scheduled-dispatch",
    invocationId: "run-9.round-3.attempt-0",
    runId: "run-9",
    roundId: "round-3",
    profileHome: home,
    mountPlan: interactiveStoreMountPlan(home),
    configOptions: { managedDir: null },
    ...overrides,
  };
}

/** The deps every test starts from: deterministic clock, real writers, allowable revalidation. */
function deps(stateDir: string, overrides: Record<string, unknown> = {}): any {
  return {
    now: sequenceNow(),
    stateDir,
    hostRevisions: {
      hermesRevision: "hermes:test",
      matchlockRevision: "matchlock:test",
      tamanduaRevision: "tamandua:test",
    },
    revalidate: () => ({ unchanged: true }) as const,
    ...overrides,
  };
}

/** Read and parse the one receipt a refusal recorded. */
function readRefusalReceipt(decision: unknown) {
  const refusal = (decision as { refusal: { receiptPath: string } }).refusal;
  const text = fs.readFileSync(refusal.receiptPath, "utf8");
  return parseReceipt(text.trimEnd());
}

/** Every finding recorded for one store, by code. */
function codesForStore(findings: readonly { code: string; store?: string | null }[], storePath: string): string[] {
  return findings.filter((finding) => finding.store === storePath).map((finding) => finding.code);
}

describe("G8 launch-gate wiring (US-001)", () => {
  it("allows a compliant store set and writes NO receipt before the VM exists", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), deps(stateDir));

    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;

    const { binding, receiptInput } = decision;
    assert.equal(binding.invocationId, "run-9.round-3.attempt-0");
    assert.equal(binding.kind, "scheduled-dispatch");
    assert.match(binding.storeSetKey, /^sha256:[0-9a-f]{64}$/);
    assert.match(binding.decidedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // Only the PRESENT store has an inode, so only it can be identity-bound.
    assert.equal(binding.stores.length, 1);
    assert.equal(binding.stores[0].canonicalPath, path.join(home, "state.db"));
    assert.match(binding.stores[0].dev, /^\d+$/);
    assert.match(binding.stores[0].ino, /^\d+$/);

    assert.equal(binding.configJournalMode, "delete");
    assert.ok(binding.configSource.includes("host-observed"));
    assert.equal(
      binding.receiptPath,
      resolveLaunchGateReceiptPath({
        stateDir,
        invocationId: binding.invocationId,
      }),
    );

    // Nothing may be written before the VM exists.
    assert.equal(fs.existsSync(binding.receiptPath), false);

    // The pre-create capture is carried so the post-create writer needs no
    // re-observation; it records every store in the set, present or not.
    assert.equal(receiptInput.verdict, "allow");
    assert.deepEqual(receiptInput.findings, []);
    assert.equal(receiptInput.stores.length, LAUNCH_GATE_STORE_CONTRACT.entries.length);
    assert.equal(receiptInput.inventoryComplete, true);
    assert.equal(receiptInput.host.tamanduaRevision, "tamandua:test");
    assert.equal(receiptInput.holderDetection.observationComplete, false);
    assert.equal(receiptInput.holderDetection.perspective, "unmeasured");
    assert.equal(receiptInput.holderDetection.provenance, "unmeasured");
    assert.equal(receiptInput.holderDetection.limitation, NO_LEASE_LIMITATION);
  });

  it("refuses a WAL-header store with the dedicated exit code and exactly one refused receipt", () => {
    const home = newProfileHome();
    const walPath = writeWalStore(home);
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(scopeFor(home), deps(stateDir));
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    const { refusal } = decision;
    assert.equal(refusal.kind, "verdict");
    assert.equal(refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(refusal.receiptWritten, true);
    assert.ok(refusal.verdict !== null);
    assert.ok(codesForStore(refusal.findings, walPath).includes("wal-header"));
    assert.ok(refusal.detail.includes("wal-header"));

    // Exactly one receipt file: the refusal wrote it, and nothing else did.
    const gateDir = path.dirname(refusal.receiptPath);
    const written = fs.readdirSync(gateDir);
    assert.deepEqual(written, [path.basename(refusal.receiptPath)]);

    const receipt = readRefusalReceipt(decision);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.verdict, "refuse");
    assert.equal(receipt.findings.length, refusal.findings.length);
    assert.match(receipt.storeSetKey, /^sha256:[0-9a-f]{64}$/);
    assert.equal(receipt.invocation.kind, "scheduled-dispatch");
    assert.equal(receipt.invocation.runId, "run-9");
    assert.equal(receipt.invocation.roundId, "round-3");
    assert.equal(receipt.holderDetection.limitation, NO_LEASE_LIMITATION);

    // A refusal never leads to a create: the caller's only branch is the
    // allow branch, and there is none.
    let createCalls = 0;
    const controller = {
      prepareAndCreate() {
        createCalls += 1;
        return { vm: "created" };
      },
    };
    // The only branch that could create a VM is the allow branch, and this is
    // a refusal: nothing else in the decision shape can reach a create.
    if ((decision as { action: string }).action === "allow") {
      controller.prepareAndCreate();
    }
    assert.equal(createCalls, 0);
  });

  it("observes EVERY store: a bad store never hides the others and is recorded from the host", () => {
    const home = newProfileHome();
    const walPath = writeWalStore(home);
    const statePath = path.join(home, "state.db");
    const stateDir = newStateDir();

    const observed: string[] = [];
    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        observeStore: (storePath: string) => {
          observed.push(storePath);
          return observeStore(storePath);
        },
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    // Every contract store was observed, including the ones that are absent.
    assert.equal(observed.length, LAUNCH_GATE_STORE_CONTRACT.entries.length);
    assert.ok(observed.includes(statePath));
    assert.ok(observed.includes(walPath));

    // The good store produces no finding; the bad store's finding survives.
    assert.deepEqual(codesForStore(decision.refusal.findings, statePath), []);
    assert.ok(codesForStore(decision.refusal.findings, walPath).includes("wal-header"));

    const receipt = readRefusalReceipt(decision);
    const receiptWalStore = receipt.stores.find((store) => store.canonicalPath === walPath);
    assert.ok(receiptWalStore !== undefined);
    assert.equal(receiptWalStore.headerFormat, "wal");
    assert.deepEqual(receiptWalStore.headerBytes, [2, 2]);
    assert.equal(receiptWalStore.configJournalMode, "delete");
    assert.equal(receiptWalStore.readable, true);
    assert.equal(receiptWalStore.sidecarState.perspective, "host");
    assert.equal(receiptWalStore.sidecarState.provenance, "measured");
    assert.ok(receiptWalStore.findingCodes.includes("wal-header"));
    assert.equal(receipt.stores.length, LAUNCH_GATE_STORE_CONTRACT.entries.length);
  });

  it("records a failed store observation as path-unresolved and keeps the other store's findings", () => {
    const home = newProfileHome();
    const walPath = writeWalStore(home);
    const statePath = path.join(home, "state.db");
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        observeStore: (storePath: string) => {
          if (storePath === statePath) {
            throw new Error("EACCES: permission denied, open the store");
          }
          return observeStore(storePath);
        },
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    const findings = decision.refusal.findings;
    assert.ok(codesForStore(findings, statePath).includes("path-unresolved"));
    // Cannot-determine is never absence.
    assert.ok(!codesForStore(findings, statePath).includes("store-missing"));
    // The other store's evidence still aggregates.
    assert.ok(codesForStore(findings, walPath).includes("wal-header"));

    const receipt = readRefusalReceipt(decision);
    const failedStore = receipt.stores.find((store) => store.findingCodes.includes("path-unresolved"));
    assert.ok(failedStore !== undefined);
    assert.equal(failedStore.canonicalPath, "unreadable");
    assert.equal(failedStore.readable, "unreadable");
    assert.equal(failedStore.headerFormat, "unreadable");
    assert.equal(failedStore.sidecarState.provenance, "unmeasured");
  });

  it("turns a store-set input error into an operational refusal that still writes a receipt", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        resolveStoreSet: () => {
          throw new StoreSetInputError(
            "profile-home-invalid",
            "profileHome must be an absolute path inside the profile",
          );
        },
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(decision.refusal.receiptWritten, true);
    assert.equal(decision.refusal.verdict, null);
    assert.deepEqual(decision.refusal.findings, []);
    assert.ok(decision.refusal.detail.includes("profile-home-invalid"));

    const receipt = readRefusalReceipt(decision);
    assert.equal(receipt.action, "refused");
    assert.equal(receipt.verdict, "refuse");
    assert.deepEqual(receipt.findings, []);
    assert.deepEqual(receipt.stores, []);
    assert.equal(receipt.storeSetKey, "unreadable");
  });

  it("refuses operationally when revalidation reports a store-set change", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const addedPath = path.join(home, "kanban.db");

    let captured: any = null;
    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        revalidate: (snapshot: unknown) => {
          captured = snapshot;
          return {
            unchanged: false,
            changes: [
              {
                code: "store-set-changed",
                storePath: addedPath,
                field: "membership",
                before: "absent",
                after: "present",
              },
            ],
          };
        },
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(decision.refusal.receiptWritten, true);
    // The ten reason codes are closed: a revalidation failure adds none.
    assert.deepEqual(decision.refusal.findings, []);
    assert.ok(decision.refusal.detail.includes(addedPath));
    assert.ok(decision.refusal.detail.includes("store-set-changed"));
    assert.ok(decision.refusal.detail.includes("membership"));

    // The seam was asked about the identities and config actually observed.
    assert.equal(captured.stores.length, 1);
    assert.equal(captured.stores[0].canonicalPath, path.join(home, "state.db"));
    assert.equal(captured.config.journalMode, "delete");
    assert.equal(captured.config.observed, true);

    const receipt = readRefusalReceipt(decision);
    assert.equal(receipt.verdict, "refuse");
    assert.deepEqual(receipt.findings, []);
    assert.match(receipt.storeSetKey, /^sha256:[0-9a-f]{64}$/);
  });

  it("refuses operationally when a store is replaced at the same canonical path", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const statePath = path.join(home, "state.db");

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        revalidate: () => ({
          unchanged: false,
          changes: [
            {
              code: "store-identity-changed",
              storePath: statePath,
              field: "dev/ino",
              before: "43:1",
              after: "43:2",
            },
          ],
        }),
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.ok(decision.refusal.detail.includes(statePath));
    assert.ok(decision.refusal.detail.includes("dev/ino"));
    assert.ok(decision.refusal.detail.includes("store-identity-changed"));
  });

  it("runs the PRODUCTION revalidation by default and allows an unchanged store set", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();

    // No `revalidate` seam: the production revalidation (US-002) must run on
    // the real identities + the real config, prove them unchanged, and allow.
    const decision = evaluateAndRecordLaunchGate(scopeFor(home), {
      now: sequenceNow(),
      stateDir,
    });

    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;
    assert.match(decision.binding.storeSetKey, /^sha256:[0-9a-f]{64}$/);
    assert.equal(decision.binding.configJournalMode, "delete");
    assert.equal(fs.existsSync(decision.binding.receiptPath), false);
  });

  it("turns a receipt-write failure into an operational refusal and never an allow", () => {
    const home = newProfileHome();
    const walPath = writeWalStore(home);
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        writeRefusalReceipt: () => ({
          ok: false,
          code: "receipt-write-failed",
          path: "<forced>",
          detail: "receipt write failed: EACCES",
        }),
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.receiptWritten, false);
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.ok(decision.refusal.detail.includes("could not be written"));
    assert.ok(decision.refusal.detail.includes("EACCES"));
    // The verdict's findings are still returned: the operator learns both why
    // the launch was refused and that the evidence could not be recorded.
    assert.ok(codesForStore(decision.refusal.findings, walPath).includes("wal-header"));
    assert.equal(fs.existsSync(decision.refusal.receiptPath), false);

    // A directory that cannot be created is the same class of refusal.
    const blocked = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        ensureReceiptDirectory: () => {
          throw new Error("ENOTDIR: not a directory");
        },
      }),
    );
    assert.equal(blocked.action, "refuse");
    if (blocked.action !== "refuse") return;
    assert.equal(blocked.refusal.kind, "operational");
    assert.equal(blocked.refusal.receiptWritten, false);
    assert.equal(blocked.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
  });

  it("keys the store set by identity: stable for identical identities, different on dev/ino", () => {
    const stores = [
      { canonicalPath: "/p/a.db", dev: "1", ino: "2" },
      { canonicalPath: "/p/b.db", dev: "1", ino: "3" },
    ];
    const key = launchGateStoreSetKey({ kind: "scheduled-dispatch", stores });

    assert.match(key, /^sha256:[0-9a-f]{64}$/);
    // Byte-identical across repeated calls and independent of input order.
    assert.equal(launchGateStoreSetKey({ kind: "scheduled-dispatch", stores }), key);
    assert.equal(
      launchGateStoreSetKey({ kind: "scheduled-dispatch", stores: [...stores].reverse() }),
      key,
    );

    // Exactly sha256 over the UTF-8 sorted `canonicalPath|dev|ino` lines.
    const expected =
      "sha256:" +
      crypto
        .createHash("sha256")
        .update(["/p/a.db|1|2", "/p/b.db|1|3"].join("\n"), "utf8")
        .digest("hex");
    assert.equal(key, expected);

    // A replaced inode at the same path, and a changed device, both move it.
    assert.notEqual(
      launchGateStoreSetKey({
        kind: "scheduled-dispatch",
        stores: [stores[0], { ...stores[1], ino: "999" }],
      }),
      key,
    );
    assert.notEqual(
      launchGateStoreSetKey({
        kind: "scheduled-dispatch",
        stores: [{ ...stores[0], dev: "77" }, stores[1]],
      }),
      key,
    );

    // The key answers "which stores"; the invocation identity is bound
    // separately (id + kind), so the kind never perturbs the digest.
    assert.equal(launchGateStoreSetKey({ kind: "interactive-hermes", stores }), key);
  });

  it("sanitizes receipt paths so an invocation id cannot escape the gate directory", () => {
    // A synthetic absolute state dir: this test never touches the filesystem.
    const stateDir = path.join(path.sep, "var", "lib", "tamandua-state");
    const gateDir = path.join(stateDir, "matchlock", "gate");

    assert.equal(
      resolveLaunchGateReceiptPath({ stateDir, invocationId: "inv-1_ok.2" }),
      path.join(gateDir, "inv-1_ok.2.json"),
    );

    const traversal = resolveLaunchGateReceiptPath({
      stateDir,
      invocationId: "../../etc/passwd",
    });
    assert.equal(path.dirname(traversal), gateDir);
    assert.ok(!path.basename(traversal).includes("/"));

    const dots = resolveLaunchGateReceiptPath({ stateDir, invocationId: ".." });
    assert.equal(path.dirname(dots), gateDir);

    // Two distinct ids that sanitize to the same text never share a receipt.
    const slash = resolveLaunchGateReceiptPath({ stateDir, invocationId: "a/b" });
    const colon = resolveLaunchGateReceiptPath({ stateDir, invocationId: "a:b" });
    assert.notEqual(slash, colon);
    assert.equal(
      resolveLaunchGateReceiptPath({ stateDir, invocationId: "a/b" }),
      slash,
    );
  });

  it("records the interactive hermes-shell kind distinctly, without run or round ids", () => {
    const home = newProfileHome();
    writeWalStore(home);
    const stateDir = newStateDir();

    const receipts = new Map<string, any>();
    let index = 0;
    for (const kind of ["interactive-hermes", "interactive-hermes-shell"] as const) {
      index += 1;
      const decision = evaluateAndRecordLaunchGate(
        scopeFor(home, {
          kind,
          invocationId: `pid-${index}.start-${index}`,
          runId: undefined,
          roundId: undefined,
        }),
        deps(stateDir),
      );
      assert.equal(decision.action, "refuse");
      if (decision.action !== "refuse") return;
      receipts.set(kind, readRefusalReceipt(decision));
    }

    const plain = receipts.get("interactive-hermes");
    const shell = receipts.get("interactive-hermes-shell");
    assert.equal(plain.invocation.kind, "interactive-hermes");
    assert.equal(shell.invocation.kind, "interactive-hermes-shell");
    assert.equal(plain.invocation.profile, "unreadable");
    assert.equal(plain.invocation.guestConfigDir, "unreadable");
    // No run/round ids were supplied, so they are omitted, never invented.
    assert.deepEqual(Object.keys(plain.invocation), ["kind", "profile", "guestConfigDir"]);
  });

  it("records holder detection as informational evidence and never as a refusal", () => {
    const home = newProfileHome();
    const statePath = path.join(home, "state.db");
    const stateDir = newStateDir();

    let probedPaths: string[] = [];
    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        holderProbe: (storePaths: string[]) => {
          probedPaths = storePaths;
          return [
            {
              pid: 4242,
              startIdentity: "v2:4242:1000",
              argv: ["hermes", "chat"],
              openPaths: [statePath],
            },
          ];
        },
      }),
    );

    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;

    assert.ok(probedPaths.includes(statePath));
    const detection = decision.receiptInput.holderDetection;
    assert.equal(detection.observationComplete, true);
    assert.equal(detection.perspective, "host");
    assert.equal(detection.provenance, "measured");
    assert.equal(detection.holders.length, 1);
    assert.equal(detection.holders[0].pid, 4242);
    assert.equal(detection.holders[0].startedAt, "v2:4242:1000");
    assert.equal(detection.limitation, NO_LEASE_LIMITATION);
    // A live holder is information, not a reason to refuse.
    assert.deepEqual(decision.receiptInput.findings, []);
  });

  it("writes the launch receipt only after the VM exists", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();
    const decision = evaluateAndRecordLaunchGate(scopeFor(home), deps(stateDir));
    assert.equal(decision.action, "allow");
    if (decision.action !== "allow") return;

    const early = writeLaunchGateLaunchReceipt(decision, false, deps(stateDir));
    assert.equal(early.ok, false);
    assert.equal(fs.existsSync(decision.binding.receiptPath), false);

    const written = writeLaunchGateLaunchReceipt(decision, true, deps(stateDir));
    assert.equal(written.ok, true);

    const receipt = parseReceipt(
      fs.readFileSync(decision.binding.receiptPath, "utf8").trimEnd(),
    );
    assert.equal(receipt.action, "launched");
    assert.equal(receipt.verdict, "allow");
    assert.deepEqual(receipt.findings, []);
    assert.equal(receipt.storeSetKey, decision.binding.storeSetKey);
    assert.equal(receipt.invocation.kind, "scheduled-dispatch");
    assert.match(receipt.receiptWrittenAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

    // A refusal has no launch record to write.
    const homeWal = newProfileHome();
    writeWalStore(homeWal);
    const refused = evaluateAndRecordLaunchGate(scopeFor(homeWal), deps(newStateDir()));
    assert.equal(refused.action, "refuse");
    if (refused.action !== "refuse") return;
    const none = writeLaunchGateLaunchReceipt(refused, true, deps(stateDir));
    assert.equal(none.ok, false);
    assert.equal(fs.readFileSync(refused.refusal.receiptPath, "utf8").includes('"launched"'), false);
  });

  it("refuses operationally when a present store has no established filesystem identity", () => {
    const home = newProfileHome();
    const statePath = path.join(home, "state.db");
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        resolveStoreSet: () => ({
          stores: [
            {
              canonicalPath: statePath,
              pathAliases: [statePath],
              // A resolved store whose dev/ino were never established: the
              // launch cannot be identity-bound to it, so it must fail closed
              // rather than silently drop out of the store-set key.
              dev: null,
              ino: null,
              fstype: "0xef53",
              size: 8192,
              classification: "required",
              origin: "contract",
              resolution: "resolved",
            },
          ],
          discoveredUnexpected: [],
          inventoryComplete: true,
          incompleteReasons: [],
        }),
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.ok(decision.refusal.detail.includes("could not be established"));
    // The observation that WAS made is still recorded.
    const receipt = readRefusalReceipt(decision);
    assert.equal(receipt.stores.length, 1);
    assert.equal(receipt.stores[0].canonicalPath, statePath);
  });

  it("refuses operationally when the effective config cannot be observed", () => {
    const home = newProfileHome();
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(
      scopeFor(home),
      deps(stateDir, {
        resolveEffectiveJournalMode: () => {
          throw new Error("EIO: config layer is unreadable");
        },
      }),
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.receiptWritten, true);
    assert.ok(decision.refusal.detail.includes("journal-mode configuration"));
    assert.ok(decision.refusal.detail.includes("EIO"));
  });

  it("records a refusal even when the caller supplies no scope at all", () => {
    const stateDir = newStateDir();

    const decision = evaluateAndRecordLaunchGate(
      undefined as unknown as any,
      { now: sequenceNow(), stateDir },
    );

    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;
    assert.equal(decision.refusal.kind, "operational");
    assert.equal(decision.refusal.receiptWritten, true);
    const receipt = readRefusalReceipt(decision);
    // Nothing was invented: an unknown invocation kind is `unreadable`.
    assert.equal(receipt.invocation.kind, "unreadable");
    assert.equal(receipt.action, "refused");
  });

  it("exposes a typed refusal error carrying the refusal and its exit code", () => {
    const home = newProfileHome();
    writeWalStore(home);
    const decision = evaluateAndRecordLaunchGate(scopeFor(home), deps(newStateDir()));
    assert.equal(decision.action, "refuse");
    if (decision.action !== "refuse") return;

    const error = new LaunchGateRefusalError(decision.refusal);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "LaunchGateRefusalError");
    assert.equal(error.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(error.refusal, decision.refusal);
    assert.equal(error.message, decision.refusal.detail);
  });

  it("takes its exit status from the G9 allocation and imports no child_process", () => {
    const source = fs.readFileSync(MODULE_PATH, "utf8");

    // The status is never spelled: it comes from exitCodeForGateOutcome.
    assert.equal(/\b78\b/.test(source), false);
    assert.ok(source.includes("exitCodeForGateOutcome"));
    assert.ok(source.includes('from "./gate-exit-code.js"'));

    // The wiring core observes and records; it never spawns or creates a VM.
    // (The module's doc block explains the absence of child_process, so the
    // assertion is about an IMPORT, not a mention.)
    assert.equal(/from\s+["']node:child_process["']/.test(source), false);
    assert.equal(/require\(\s*["']node:child_process["']\s*\)/.test(source), false);
    for (const forbidden of [
      "prepareAndCreate",
      "createVm",
      "spawnSync",
      "execFile",
      "vm-reaper",
    ]) {
      assert.equal(source.includes(forbidden), false, `module must not reference ${forbidden}`);
    }

    // Parallel lane: this test file is not in the serial classification list.
    const serialEntries = fs
      .readFileSync(SERIAL_FILES_PATH, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.equal(
      serialEntries.includes("src/installer/matchlock/launch-gate-wiring.test.ts"),
      false,
    );
  });
});
