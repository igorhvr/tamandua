/**
 * Fast injected-failure controls for the corrected exact-owned Matchlock VM
 * lifecycle (e2e-tests/helpers/matchlock-gate-lifecycle.ts).
 *
 * These are DETERMINISTIC and use NO real VM: they exercise the strict
 * inventory reader and exact-owned cleanup against fabricated private HOMEs
 * plus a FAKE `matchlock rm` script, proving that corrupt/absent inventory and
 * failed/unknown closes FAIL LOUDLY and RETAIN state — they never fabricate
 * clean evidence. The real-VM gates run the same controls before creating any
 * VM.
 *
 * Isolation: each control gets its own tamanduaTempDir scratch root; no real
 * matchlock runtime, no foreign path, no live state.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";
import {
  assertNoOwnedVms,
  cleanupOwnedVms,
  fabricateVmHome,
  makeFakeMatchlock,
  readRunnerVmEvidenceIds,
  readRunEvents,
  readVmInventory,
} from "../e2e-tests/helpers/matchlock-gate-lifecycle.ts";

describe("matchlock gate cleanup/inventory injected failure controls (no real VM)", () => {
  let root = "";

  before(() => {
    root = tamanduaTempDir("mtlk-gate-lifecycle-");
  });

  after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* owned scratch */
    }
  });

  it("a CORRUPT state DB throws from the strict inventory reader (never empty/clean)", () => {
    const homeDir = fabricateVmHome(root, { db: "corrupt" });
    assert.throws(
      () => readVmInventory(homeDir),
      /unreadable\/corrupt/,
      "corrupt matchlock state DB must throw, not read as empty",
    );
  });

  it("an ABSENT state DB is DISTINCT from a successfully queried empty state", () => {
    const absentHome = fabricateVmHome(root, { db: "absent" });
    const emptyHome = fabricateVmHome(root, { db: "empty" });
    const absent = readVmInventory(absentHome);
    const empty = readVmInventory(emptyHome);
    assert.equal(absent.dbPresent, false, "absent DB is reported absent");
    assert.equal(absent.rows.length, 0);
    assert.equal(empty.dbPresent, true, "empty DB is reported present");
    assert.equal(empty.rows.length, 0);

    // absent ≠ clean: cleanup with an absent DB and observed ids MUST fail.
    const ledgerPath = path.join(root, "absent-ledger.txt");
    assert.throws(
      () =>
        cleanupOwnedVms(absentHome, ledgerPath, ["vm-11223344"], {
          rpcBin: path.join(root, "matchlock-ok"),
        }),
      /state DB (is )?missing|absent ≠ clean/i,
      "an absent DB with observed VM ids must fail the cleanup",
    );
    assert.ok(fs.existsSync(ledgerPath), "ledger is written even when cleanup fails");
  });

  it("a FAILED exact-id close throws, retains state and records every outcome", () => {
    const homeDir = fabricateVmHome(root, { db: "rows", dirs: true });
    const fakeRm = path.join(root, "matchlock-fail");
    makeFakeMatchlock(fakeRm, "fail");
    const ledgerPath = path.join(root, "fail-ledger.txt");
    assert.throws(
      () => cleanupOwnedVms(homeDir, ledgerPath, ["vm-11223344"], { rpcBin: fakeRm }),
      /failed to close cleanly/,
      "a failed rm must fail the gate",
    );
    const stateDir = path.join(homeDir, ".matchlock", "vms", "vm-11223344");
    assert.ok(fs.existsSync(stateDir), "state dir retained after a failed close");
    const ledgerText = fs.readFileSync(ledgerPath, "utf-8");
    assert.match(ledgerText, /vm-11223344/, "ledger records the exact owned id");
    assert.match(ledgerText, /NOT cleanly closed/, "ledger records the failed close");
  });

  it("an UNKNOWN vm id (no row, no dir) is not fabricated into inventory or cleanup targets", () => {
    const homeDir = fabricateVmHome(root, { db: "empty" });
    const fakeRm = path.join(root, "matchlock-ok-unknown");
    makeFakeMatchlock(fakeRm, "ok");
    const ledgerPath = path.join(root, "unknown-ledger.txt");
    const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, ["vm-deadbeef"], { rpcBin: fakeRm });
    assert.ok(
      ledger.some((l) =>
        /vm-deadbeef already positively closed by the runner \(no row and no state dir\)/.test(l),
      ),
      "an id with no row/dir is recorded as already-closed, never fabricated",
    );
    assert.ok(fs.existsSync(ledgerPath));
  });

  it("a SUCCESSFUL exact-id close leaves a clean ledger (rows + dirs gone)", () => {
    const homeDir = fabricateVmHome(root, { db: "rows", dirs: true });
    const fakeRm = path.join(root, "matchlock-ok-clean");
    makeFakeMatchlock(fakeRm, "ok");
    const ledgerPath = path.join(root, "ok-ledger.txt");
    const { ledger } = cleanupOwnedVms(homeDir, ledgerPath, ["vm-11223344", "vm-55667788"], {
      rpcBin: fakeRm,
    });
    assert.ok(
      ledger.some((l) => /cleanup complete: no owned VM rows\/state dirs remain/.test(l)),
      "successful close records completion",
    );
    assert.equal(readVmInventory(homeDir).rows.length, 0, "no rows remain");
  });

  it("readRunEvents treats CORRUPT event JSON as an ERROR (never silent {})", () => {
    const home = fs.mkdtempSync(path.join(root, "home-events-"));
    const eventsDir = path.join(home, ".tamandua", "events");
    fs.mkdirSync(eventsDir, { recursive: true });
    fs.writeFileSync(path.join(eventsDir, "corrupt.jsonl"), '{"event":"ok"}\nnot-json\n', "utf-8");
    assert.throws(
      () => readRunEvents(path.join(home, ".tamandua"), "corrupt"),
      /corrupt event JSON/,
    );
  });

  // ──────────────────────────────────────────────────────────────────────
  // US-006: strict post-run assertion that the runner removed every VM.
  // ──────────────────────────────────────────────────────────────────────

  it("assertNoOwnedVms PASSES on an inventory with zero rows and zero state dirs and records a ledger line", () => {
    const home = fabricateVmHome(root, { db: "empty" });
    const ledgerPath = path.join(root, "assert-empty-ledger.txt");
    const lines: string[] = [];
    assert.doesNotThrow(() =>
      assertNoOwnedVms(home, "empty", { ledgerPath, onLog: (l) => lines.push(l) }),
    );
    assert.match(fs.readFileSync(ledgerPath, "utf-8"), /assertNoOwnedVms\[empty\]: OK/);
    assert.equal(lines.length, 1, "exactly one assertion ledger line");
    assert.match(lines[0], /no owned VM rows\/state dirs remain/);
  });

  it("assertNoOwnedVms PASSES on an ABSENT state DB (no VMs were ever created)", () => {
    const home = fabricateVmHome(root, { db: "absent" });
    assert.doesNotThrow(() => assertNoOwnedVms(home, "absent"));
  });

  it("assertNoOwnedVms FAILS naming every leftover DB row", () => {
    const home = fabricateVmHome(root, { db: "rows" });
    const ledgerPath = path.join(root, "assert-rows-ledger.txt");
    assert.throws(
      () => assertNoOwnedVms(home, "rows", { ledgerPath, pollTimeoutMs: 0 }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return (
          /owned Matchlock VM\(s\) remain/.test(msg) &&
          msg.includes("vm-11223344") &&
          msg.includes("vm-55667788") &&
          /rows=\[vm-11223344,vm-55667788\]/.test(msg)
        );
      },
      "a leftover running/stopped row must fail and name both ids",
    );
    assert.match(fs.readFileSync(ledgerPath, "utf-8"), /assertNoOwnedVms\[rows\]: FAIL/);
  });

  it("assertNoOwnedVms FAILS naming a leftover state dir with no DB row", () => {
    const home = fabricateVmHome(root, { db: "empty", dirs: true });
    assert.throws(
      () => assertNoOwnedVms(home, "dirs", { pollTimeoutMs: 0 }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return (
          /owned Matchlock VM\(s\) remain/.test(msg) &&
          /dirs=\[vm-11223344,vm-55667788\]/.test(msg)
        );
      },
      "a leftover state dir must fail and name the exact ids",
    );
  });

  it("assertNoOwnedVms runs the pinned `matchlock list` once and records its output (inventory stays authoritative)", () => {
    const home = fabricateVmHome(root, { db: "empty" });
    const fakeList = path.join(root, "matchlock-list-ok");
    makeFakeMatchlock(fakeList, "ok");
    const ledgerPath = path.join(root, "assert-list-ledger.txt");
    assert.doesNotThrow(() =>
      assertNoOwnedVms(home, "list", { rpcBin: fakeList, ledgerPath }),
    );
    assert.match(fs.readFileSync(ledgerPath, "utf-8"), /matchlock list: rc=0/);
  });

  // ──────────────────────────────────────────────────────────────────────
  // US-006: evidence-dir VM counting (the runner's retained per-VM evidence).
  // ──────────────────────────────────────────────────────────────────────

  it("readRunnerVmEvidenceIds returns only owned vm-<8hex> evidence dirs for the run", () => {
    const runRoot = tamanduaTempDir("mtlk-run-root-");
    const runId = "11111111-2222-3333-4444-555555555555";
    const dir = path.join(runRoot, runId, "matchlock");
    fs.mkdirSync(path.join(dir, "vm-aaaabbbb"), { recursive: true });
    fs.mkdirSync(path.join(dir, "vm-ccccdddd"), { recursive: true });
    fs.mkdirSync(path.join(dir, "not-a-vm"), { recursive: true });
    fs.writeFileSync(path.join(dir, "vm-eeeeffff"), "file not dir", "utf-8");
    assert.deepEqual(readRunnerVmEvidenceIds(runRoot, runId), ["vm-aaaabbbb", "vm-ccccdddd"]);
    assert.deepEqual(readRunnerVmEvidenceIds(runRoot, "run-" + runId), ["vm-aaaabbbb", "vm-ccccdddd"]);
    assert.deepEqual(readRunnerVmEvidenceIds(runRoot, "99999999-0000-0000-0000-000000000000"), []);
  });
});
