/**
 * G8 ADMISSION-INTEGRATION US-013 — the FAST, no-VM scenario-C controls.
 *
 * The on-demand qualification gate (e2e-tests/matchlock-admission-qualification-
 * gate.test.ts) drives the same two outcomes through the real run path, but it
 * is not part of any default lane. These controls pin the properties the story
 * must hold on EVERY `npm test` run:
 *
 *   C1  two independent NATIVE writer PROCESSES commit into one real
 *       rollback-format store concurrently; afterwards every committed record is
 *       retained, no unaccounted row exists, `PRAGMA integrity_check` is ok and
 *       the store is still admissible (rollback header + delete config).
 *
 *   C2  a NONEMPTY `-journal` beside a compliant store refuses with
 *       `sidecar-unresolved` and the ROLLBACK-journal remedy (never a
 *       checkpoint); once the journal is removed after quiescence the next
 *       observation ALLOWS. The gate never deletes the journal, and the refusal
 *       receipt stays on disk as the record of the transient refusal.
 *
 * Neither outcome claims unconditional admission during every transaction or
 * process-lifetime exclusivity: the design accepts BOTH, which is exactly what
 * these two controls demonstrate together.
 *
 * LANE: SERIAL. C1 starts real OS processes (node:child_process), so this file
 * is registered in tests/serial-files.txt.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { tamanduaShortTempDir } from "../dist/lib/temp-dir.js";
import { LAUNCH_GATE_REFUSAL_EXIT_CODE } from "../dist/installer/matchlock/gate-exit-code.js";
import { NO_LEASE_LIMITATION } from "../dist/installer/matchlock/gate-receipt.js";
import { interactiveStoreMountPlan } from "../dist/installer/matchlock/doctor-gate.js";
import { evaluateGate } from "../dist/installer/matchlock/launch-gate.js";
import { renderGateRemedyText } from "../dist/installer/matchlock/gate-remedy-text.js";
import { observeStore } from "../dist/installer/matchlock/store-header.js";
import { adaptStoreObservation } from "../dist/installer/matchlock/store-observation-adapter.js";
import { evaluateAndRecordLaunchGate } from "../dist/installer/matchlock/launch-gate-wiring.js";
import { parseReceipt } from "../dist/installer/matchlock/gate-receipt.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_WRITER = path.join(repoRoot, "e2e-tests", "helpers", "store-native-writer.mjs");
const WRITER_TABLE = "native_writer_rows";

/** Temp dirs created by this file (removed in one place). */
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

/** Open a store for a fixture read/write (busy_timeout matches the writers). */
function openStore(storePath: string): DatabaseSync {
  const db = new DatabaseSync(storePath);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** A disposable profile home with a REAL rollback-format store + delete config. */
function newProfileHome(): { home: string; storePath: string; header: number[] } {
  const home = track(tamanduaShortTempDir("tamandua-us013-home-"));
  fs.writeFileSync(path.join(home, "config.yaml"), "database:\n  journal_mode: delete\n", "utf-8");
  const storePath = path.join(home, "state.db");
  const db = openStore(storePath);
  try {
    db.exec("PRAGMA journal_mode=delete");
    db.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, value TEXT)");
    db.exec("INSERT INTO t (value) VALUES ('owned fixture row')");
  } finally {
    db.close();
  }
  const head = fs.readFileSync(storePath).subarray(18, 20);
  return { home, storePath, header: [head[0] as number, head[1] as number] };
}

interface WriterLedger {
  commits: Array<{ writer: string; seq: number }>;
  errors: Array<{ writer: string; seq: number; message: string }>;
  summary: Record<string, unknown> | null;
}

function readLedger(ledgerPath: string): WriterLedger {
  const ledger: WriterLedger = { commits: [], errors: [], summary: null };
  for (const line of fs.readFileSync(ledgerPath, "utf-8").trimEnd().split("\n")) {
    if (line.trim() === "") continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (entry.kind === "commit") ledger.commits.push({ writer: String(entry.writer), seq: Number(entry.seq) });
    else if (entry.kind === "error") {
      ledger.errors.push({
        writer: String(entry.writer),
        seq: Number(entry.seq),
        message: String(entry.message ?? ""),
      });
    } else if (entry.kind === "summary") ledger.summary = entry;
  }
  return ledger;
}

/** Start one native writer process (the helper announces + ledgers its pid). */
function startWriter(options: {
  label: string;
  dbPath: string;
  directory: string;
  rows: number;
}): { label: string; pid: number; ledgerPath: string; child: ReturnType<typeof spawn>; output: () => string } {
  const ledgerPath = path.join(options.directory, `writer-${options.label}.jsonl`);
  const child = spawn(
    process.execPath,
    [
      NATIVE_WRITER,
      "--db",
      options.dbPath,
      "--writer",
      options.label,
      "--ledger",
      ledgerPath,
      "--table",
      WRITER_TABLE,
      "--rows",
      String(options.rows),
      "--interval-ms",
      "12",
      "--duration-ms",
      "30000",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const collect = (data: Buffer | string): void => {
    output += String(data);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  assert.equal(typeof child.pid, "number", "the writer process must have a pid");
  return {
    label: options.label,
    pid: child.pid as number,
    ledgerPath,
    child,
    output: () => output,
  };
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

// ===========================================================================
// C1 — two independent writer processes on ONE store
// ===========================================================================
describe("US-013 C1 native concurrency integrity (no VM)", () => {
  it("keeps every committed record and passes PRAGMA integrity_check after two concurrent writers", async () => {
    const root = track(tamanduaShortTempDir("tamandua-us013-c1-"));
    const profile = newProfileHome();
    assert.deepEqual(profile.header, [1, 1], "the fixture store must be rollback-format");

    const ROWS = 20;
    const writers = [
      startWriter({ label: "native-a", dbPath: profile.storePath, directory: root, rows: ROWS }),
      // The second PROCESS stands in for the GUEST writer of the real-VM tier:
      // the property under test is a second independent connection committing
      // while the first is writing, which is what the guest does on the mount.
      startWriter({ label: "native-b", dbPath: profile.storePath, directory: root, rows: ROWS }),
    ];
    const exits = await Promise.all(writers.map((writer) => waitForExit(writer.child, 60_000)));
    for (const [index, writer] of writers.entries()) {
      assert.equal(exits[index], true, `writer ${writer.label} did not exit: ${writer.output().slice(0, 500)}`);
      assert.equal(writer.child.exitCode, 0, `writer ${writer.label} failed: ${writer.output().slice(0, 500)}`);
    }

    const ledgers = writers.map((writer) => readLedger(writer.ledgerPath));
    for (const [index, ledger] of ledgers.entries()) {
      assert.equal(ledger.commits.length, ROWS, `writer ${writers[index]?.label} must commit every row`);
      assert.deepEqual(ledger.errors, [], `writer ${writers[index]?.label} recorded write errors`);
    }

    const db = openStore(profile.storePath);
    let retained: Array<{ writer: string; seq: number }> = [];
    let integrity = "";
    try {
      const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
      integrity = String(row?.integrity_check ?? "");
      retained = db.prepare(`SELECT writer, seq FROM ${WRITER_TABLE}`).all() as Array<{
        writer: string;
        seq: number;
      }>;
    } finally {
      db.close();
    }
    assert.equal(integrity, "ok", "PRAGMA integrity_check must return ok after the overlap");

    const present = new Set(retained.map((entry) => `${entry.writer}|${entry.seq}`));
    const missing = ledgers
      .flatMap((ledger) => ledger.commits)
      .filter((commit) => !present.has(`${commit.writer}|${commit.seq}`));
    assert.deepEqual(missing, [], "every COMMITTED record must be retained");
    assert.equal(retained.length, ROWS * 2, "no unaccounted native row may exist");

    // Still admissible: mixed writes changed data, never policy.
    const evaluated = adaptStoreObservation(observeStore(profile.storePath), "required", {
      config: { journalMode: "delete", source: path.join(profile.home, "config.yaml"), observed: true },
    });
    const verdict = evaluateGate({ inventoryComplete: true, incompleteReasons: [], stores: [evaluated] });
    assert.equal(verdict.action, "allow", "the mixed-written store must still allow a launch");
    const head = fs.readFileSync(profile.storePath).subarray(18, 20);
    assert.deepEqual([head[0], head[1]], [1, 1], "the store stays rollback-format");
  });
});

// ===========================================================================
// C2 — the transient rollback journal
// ===========================================================================
/** SQLite's rollback-journal magic + plausible header fields (nonempty). */
function writeNonEmptyRollbackJournal(journalPath: string): number {
  const header = Buffer.alloc(4096);
  Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]).copy(header, 0);
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(1, 12);
  header.writeUInt32BE(4096, 16);
  header.writeUInt32BE(4096, 20);
  fs.writeFileSync(journalPath, header);
  return header.length;
}

function readReceipt(receiptPath: string): ReturnType<typeof parseReceipt> {
  return parseReceipt(fs.readFileSync(receiptPath, "utf-8").trimEnd());
}

describe("US-013 C2 transient rollback journal (no VM)", () => {
  it("refuses with sidecar-unresolved + the rollback-journal remedy, then allows after a quiescent removal", () => {
    const profile = newProfileHome();
    const stateDir = track(tamanduaShortTempDir("tamandua-us013-c2-state-"));
    const journalPath = `${profile.storePath}-journal`;
    const scope = (invocationId: string): any => ({
      kind: "scheduled-attempt",
      invocationId,
      runId: "run-us013-c2",
      roundId: "round-us013-c2",
      profileHome: profile.home,
      mountPlan: interactiveStoreMountPlan(profile.home),
      configOptions: { managedDir: null },
    });
    const deps = {
      stateDir,
      now: () => "2026-01-02T03:04:05.000Z",
      hostRevisions: {
        hermesRevision: "hermes:us013",
        matchlockRevision: "matchlock:us013",
        tamanduaRevision: "tamandua:us013",
      },
    };

    // Leg 0 — compliant + quiescent allows.
    const baseline = evaluateAndRecordLaunchGate(scope("us013-c2:baseline"), deps);
    assert.equal(baseline.action, "allow", "a compliant store with no journal must allow");
    assert.equal(fs.existsSync(journalPath), false);

    // Leg 1 — a NONEMPTY rollback journal appears.
    const journalSize = writeNonEmptyRollbackJournal(journalPath);
    const refused = evaluateAndRecordLaunchGate(scope("us013-c2:journal"), deps);
    assert.equal(refused.action, "refuse", "a nonempty -journal must refuse the launch");
    if (refused.action !== "refuse") return;
    assert.equal(refused.refusal.kind, "verdict");
    assert.equal(refused.refusal.exitCode, LAUNCH_GATE_REFUSAL_EXIT_CODE);
    assert.equal(refused.refusal.receiptWritten, true, "the receipt is written FIRST");
    const codes = refused.refusal.findings.map((finding) => finding.code);
    assert.deepEqual(codes, ["sidecar-unresolved"], "the journal is the ONLY finding");
    const finding = refused.refusal.findings[0];
    assert.equal(finding?.store, profile.storePath, "the finding is scoped to the store");
    const findingRemedy = (finding?.remedy ?? []).map((step) => step.description).join(" ");
    assert.match(findingRemedy, /rollback journal, not a write-ahead-log/i);
    assert.doesNotMatch(findingRemedy, /checkpoint the write-ahead-log/i);

    const receipt = readReceipt(refused.refusal.receiptPath);
    assert.equal(receipt.action, "refused");
    const storeRow = receipt.stores.find((store) => store.canonicalPath === profile.storePath);
    assert.ok(storeRow, "the receipt records the store");
    assert.equal(storeRow?.sidecarState.journal, "presentNonEmpty");
    assert.equal(storeRow?.headerFormat, "rollback", "the store itself is compliant");
    assert.equal(
      fs.statSync(journalPath).size,
      journalSize,
      "the gate OBSERVES the journal and never deletes or truncates it",
    );

    // G9's operator text over the SAME production composition.
    const evaluated = adaptStoreObservation(observeStore(profile.storePath), "required", {
      config: {
        journalMode: "delete",
        source: path.join(profile.home, "config.yaml"),
        observed: true,
      },
    });
    const verdict = evaluateGate({ inventoryComplete: true, incompleteReasons: [], stores: [evaluated] });
    const remedyText = renderGateRemedyText({
      verdict,
      holderDetection: { observationComplete: true, holders: [], probeFailures: [] },
      stores: [evaluated],
      relaunchCommand: "tamandua matchlock hermes",
    });
    assert.match(remedyText, /ROLLBACK journal/);
    assert.match(remedyText, /a checkpoint is NOT a treatment for it/);
    assert.match(remedyText, /may be TRANSIENT/);
    assert.doesNotMatch(remedyText, /checkpointing it is legitimate/);
    assert.match(remedyText, /hermes sessions set-journal-mode delete/);

    // Leg 2 — quiescence (no writer exists; the fixture opened and closed its
    // connection), then removal. The store file identity is unchanged.
    const before = fs.statSync(profile.storePath);
    fs.unlinkSync(journalPath);
    const afterRemoval = fs.statSync(profile.storePath);
    assert.equal(afterRemoval.ino, before.ino);
    assert.equal(afterRemoval.size, before.size);

    const allowed = evaluateAndRecordLaunchGate(scope("us013-c2:journal"), deps);
    assert.equal(allowed.action, "allow", "the SAME invocation allows once the journal is gone");
    if (allowed.action !== "allow") return;
    assert.equal(allowed.binding.configJournalMode, "delete");
    assert.equal(
      readReceipt(refused.refusal.receiptPath).action,
      "refused",
      "the refusal receipt remains the durable record of the transient refusal",
    );

    // The limitation the design states instead of implying exclusion.
    assert.equal(NO_LEASE_LIMITATION.length > 0, true);
    assert.match(NO_LEASE_LIMITATION, /lease/i);
  });
});
