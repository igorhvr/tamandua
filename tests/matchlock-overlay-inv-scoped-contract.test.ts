/**
 * OVERLAY-CONTINUATION US-009 — machine-checked pin for the acceptance-item
 * contract of the invocation-scoped dsh profile-overlay port (bead
 * tamandua-7j6, MTLK-OVERLAY-RACE).
 *
 * The tracked contract lives in the repository at
 * `torture-test/impl-tasks/overlay-inv-scoped-contract.json`. It records, one
 * entry per brief item 1-7, whether the structural proof was actually
 * EXECUTED in this delivering run or is WRITTEN-BUT-NOT-RUN, the test that
 * proves it, and — separately — the real-Matchlock overlap gate, which cannot
 * boot nested VMs in-guest and therefore stays coordinator/host-owned.
 *
 * This file pins that claim so it cannot drift:
 *  - items 1-7 each appear exactly once, with the recorded status;
 *  - every recorded proving-test file exists in-tree and really contains the
 *    recorded test title (so a renamed/deleted test fails the pin);
 *  - no item is simultaneously `executed` and `written-not-run`;
 *  - no `executed` item is proven by a real-VM gate file (nothing under
 *    `e2e-tests/` can have executed in this sandbox);
 *  - every `executed` item's containing-file run is recorded with exitCode 0
 *    and no failures/skips;
 *  - simulated arms are labelled simulated;
 *  - the real overlap gate is recorded as `written-not-run` with the
 *    nested-VM reason, and the gate file's own header still forbids running
 *    it by default.
 *
 * Pure filesystem reads (no `node:child_process`, no daemon, no VM, no
 * network), so this file stays in the parallel lane and needs no
 * `tests/serial-files.txt` entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CONTRACT_PATH = resolve(REPO_ROOT, "torture-test/impl-tasks/overlay-inv-scoped-contract.json");

/** The brief's structural-proof items, exactly once each. */
export const OVERLAY_CONTRACT_ITEMS = [1, 2, 3, 4, 5, 6, 7] as const;

/** The only legal statuses. An item carries exactly one of them. */
export const OVERLAY_CONTRACT_STATUSES = ["executed", "written-not-run"] as const;

/** The real-Matchlock overlap gate and the only accepted reason for not running it. */
export const OVERLAY_REAL_GATE_FILE = "e2e-tests/matchlock-dsh-profile-overlay-gate.test.ts";
export const OVERLAY_REAL_GATE_REASON = "cannot boot nested VMs in-guest; coordinator/host-owned";

/** The recorded status of each item; a status change must update this pin. */
export const OVERLAY_EXPECTED_ITEM_STATUS: ReadonlyArray<[number, string]> = [
  [1, "executed"],
  [2, "executed"],
  [3, "executed"],
  [4, "executed"],
  [5, "executed"],
  [6, "executed"],
  [7, "executed"],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Read the tracked contract as parsed JSON (fails loudly if absent/corrupt). */
export function readOverlayContract(): Record<string, unknown> {
  assert.ok(existsSync(CONTRACT_PATH), `contract file must exist: ${CONTRACT_PATH}`);
  const raw = readFileSync(CONTRACT_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  assert.ok(isRecord(parsed), "contract must parse to a JSON object");
  return parsed;
}

/**
 * Normalise an item's `status` to a list. A string yields a one-element list;
 * an array is accepted so that "both at once" is DETECTABLE (and rejected)
 * rather than silently ignored.
 */
export function statusListOf(entry: Record<string, unknown>): string[] {
  const status = entry.status;
  if (typeof status === "string") return [status];
  if (Array.isArray(status)) return status.filter((s): s is string => typeof s === "string");
  return [];
}

/** Every test reference recorded by an item (primary first, then additional). */
export function provingTestRefsOf(entry: Record<string, unknown>): Array<{ file: string; title: string }> {
  const refs: Array<{ file: string; title: string }> = [];
  const push = (value: unknown): void => {
    if (!isRecord(value)) return;
    if (typeof value.file === "string" && typeof value.title === "string") {
      refs.push({ file: value.file, title: value.title });
    }
  };
  push(entry.provingTest);
  if (Array.isArray(entry.additionalProvingTests)) {
    for (const extra of entry.additionalProvingTests) push(extra);
  }
  return refs;
}

function itemsOf(contract: Record<string, unknown>): Array<Record<string, unknown>> {
  assert.ok(Array.isArray(contract.items), "contract.items must be an array");
  return contract.items.filter(isRecord);
}

describe("invocation-scoped overlay acceptance-item contract", () => {
  it("is a tracked, parseable contract with the expected schema and status vocabulary", () => {
    const contract = readOverlayContract();
    assert.equal(
      contract.schema,
      "overlay-inv-scoped-contract/1",
      "contract.schema must identify the overlay-inv-scoped contract",
    );
    assert.deepEqual(
      contract.statusVocabulary,
      [...OVERLAY_CONTRACT_STATUSES],
      "the status vocabulary is exactly 'executed' | 'written-not-run'",
    );
    assert.equal(contract.bead, "tamandua-7j6", "the contract must name the bead it serves");
    assert.ok(isNonEmptyString(contract.brief), "the contract must name the governing brief");
  });

  it("records brief items 1-7 exactly once each", () => {
    const contract = readOverlayContract();
    const items = itemsOf(contract);
    const numbers = items.map((entry) => entry.item);
    for (const number of numbers) {
      assert.equal(typeof number, "number", `every item must carry a numeric item id, saw ${JSON.stringify(number)}`);
    }
    assert.deepEqual(
      [...numbers].sort((a, b) => (a as number) - (b as number)),
      [...OVERLAY_CONTRACT_ITEMS],
      "items 1-7 must each appear exactly once (no duplicates, no extras)",
    );
  });

  it("gives every item exactly one status and never both at once", () => {
    const contract = readOverlayContract();
    for (const entry of itemsOf(contract)) {
      const statuses = statusListOf(entry);
      assert.equal(
        statuses.length,
        1,
        `item ${String(entry.item)} must record exactly one status (got ${JSON.stringify(entry.status)})`,
      );
      assert.ok(
        (OVERLAY_CONTRACT_STATUSES as readonly string[]).includes(statuses[0]),
        `item ${String(entry.item)} status '${statuses[0]}' must be one of ${OVERLAY_CONTRACT_STATUSES.join(" | ")}`,
      );
      // The explicit disjointness check: an item is never executed AND written-not-run.
      const executed = statuses.includes("executed");
      const writtenNotRun = statuses.includes("written-not-run");
      assert.ok(
        !(executed && writtenNotRun),
        `item ${String(entry.item)} must not be both 'executed' and 'written-not-run'`,
      );
    }
  });

  it("records the status we actually claim for each of items 1-7", () => {
    const contract = readOverlayContract();
    const items = itemsOf(contract);
    const observed = OVERLAY_CONTRACT_ITEMS.map((number) => {
      const entry = items.find((candidate) => candidate.item === number);
      assert.ok(entry, `item ${number} missing from the contract`);
      const statuses = statusListOf(entry);
      assert.equal(statuses.length, 1, `item ${number} must record exactly one status`);
      return [number, statuses[0]] as [number, string];
    });
    assert.deepEqual(
      observed,
      OVERLAY_EXPECTED_ITEM_STATUS.map(([number, status]) => [number, status]),
      "the recorded per-item statuses drifted from the pinned claim",
    );
  });

  it("names only in-tree test files whose recorded title really appears in the file", () => {
    const contract = readOverlayContract();
    const contents = new Map<string, string>();
    const read = (file: string): string => {
      const cached = contents.get(file);
      if (cached !== undefined) return cached;
      assert.ok(!isAbsolute(file), `proving-test path must be repo-relative, saw ${file}`);
      assert.ok(!file.startsWith(".."), `proving-test path must stay inside the repo, saw ${file}`);
      const absolute = resolve(REPO_ROOT, file);
      assert.ok(existsSync(absolute), `proving-test file must exist in-tree: ${file}`);
      const text = readFileSync(absolute, "utf8");
      contents.set(file, text);
      return text;
    };
    for (const entry of itemsOf(contract)) {
      const refs = provingTestRefsOf(entry);
      assert.ok(refs.length >= 1, `item ${String(entry.item)} must name at least one proving test`);
      for (const ref of refs) {
        assert.ok(isNonEmptyString(ref.title), `item ${String(entry.item)} has an empty proving-test title`);
        const text = read(ref.file);
        assert.ok(
          text.includes(ref.title),
          `item ${String(entry.item)} names the test "${ref.title}" but ${ref.file} does not contain that title`,
        );
      }
    }
  });

  it("never proves an EXECUTED item with a real-VM gate file", () => {
    const contract = readOverlayContract();
    for (const entry of itemsOf(contract)) {
      if (!statusListOf(entry).includes("executed")) continue;
      for (const ref of provingTestRefsOf(entry)) {
        assert.ok(
          !ref.file.startsWith("e2e-tests/"),
          `item ${String(entry.item)} is recorded 'executed' but is proven by a real-VM gate file (${ref.file}); ` +
            "no e2e-tests/ gate can execute in this sandbox",
        );
      }
    }
  });

  it("records a real, clean containing-file run for every EXECUTED item", () => {
    const contract = readOverlayContract();
    assert.ok(Array.isArray(contract.executions), "contract.executions must be an array");
    const executions = contract.executions.filter(isRecord);
    for (const entry of itemsOf(contract)) {
      if (!statusListOf(entry).includes("executed")) continue;
      const files = new Set(provingTestRefsOf(entry).map((ref) => ref.file));
      for (const file of files) {
        const run = executions.find((candidate) => candidate.file === file);
        assert.ok(run, `item ${String(entry.item)} executed from ${file} but no execution record exists for it`);
        assert.equal(run.exitCode, 0, `${file} must have exited 0`);
        assert.equal(run.fail, 0, `${file} must have 0 failing tests`);
        assert.equal(run.skipped, 0, `${file} must have 0 skipped tests (a skip is not a pass)`);
        assert.equal(typeof run.tests, "number", `${file} must record the total test count`);
        assert.equal(typeof run.pass, "number", `${file} must record the pass count`);
        assert.equal(run.tests, (run.pass as number) + (run.fail as number) + (run.skipped as number), `${file} counts must add up`);
        assert.ok(isNonEmptyString(run.command), `${file} must record the exact command that was run`);
      }
    }
  });

  it("labels simulated arms as simulated and states the pre-fix state for item 6", () => {
    const contract = readOverlayContract();
    const items = itemsOf(contract);
    const item6 = items.find((entry) => entry.item === 6);
    assert.ok(item6, "item 6 (the regression control) must be recorded");
    assert.ok(isNonEmptyString(item6.preFixState), "item 6 must record the pre-fix state it failed against");
    assert.ok(
      (item6.preFixState as string).includes("dsh-profile-overlays/"),
      "item 6's pre-fix state must name the shared run-scoped overlay root the control failed against",
    );

    const item5 = items.find((entry) => entry.item === 5);
    assert.ok(item5, "item 5 (teardown orders / crashed holder) must be recorded");
    assert.equal(item5.simulated, true, "item 5's crashed-holder arms are simulated and must say so");
    assert.ok(
      isNonEmptyString(item5.simulationNote) && (item5.simulationNote as string).includes("SIMULATED"),
      "item 5 must carry an explicit SIMULATED note",
    );
    assert.ok(
      provingTestRefsOf(item5).some((ref) => ref.title.includes("SIMULATED")),
      "at least one of item 5's recorded test titles must be labelled SIMULATED",
    );
  });

  it("records the real-Matchlock overlap gate as written-not-run with the nested-VM reason", () => {
    const contract = readOverlayContract();
    const gate = contract.realMatchlockOverlapGate;
    assert.ok(isRecord(gate), "contract.realMatchlockOverlapGate must be recorded");
    assert.equal(gate.file, OVERLAY_REAL_GATE_FILE, "the real overlap gate file must be the dsh profile-overlay gate");
    assert.equal(gate.status, "written-not-run", "the real overlap gate must be recorded as written-not-run");
    assert.equal(gate.reason, OVERLAY_REAL_GATE_REASON, "the nested-VM / coordinator-owned reason must be recorded verbatim");
    assert.ok(isNonEmptyString(gate.title), "the real overlap gate must name its test title");
    const gateText = readFileSync(resolve(REPO_ROOT, OVERLAY_REAL_GATE_FILE), "utf8");
    assert.ok(gateText.includes(gate.title as string), "the recorded gate title must appear in the gate file");
    // ...and it must never be smuggled in as an executed item's proof.
    for (const entry of itemsOf(contract)) {
      for (const ref of provingTestRefsOf(entry)) {
        assert.ok(
          ref.file !== OVERLAY_REAL_GATE_FILE,
          `item ${String(entry.item)} must not claim the real-VM gate as its proving test`,
        );
      }
    }
  });

  it("keeps the real gate file's own no-run-by-default header", () => {
    const gateText = readFileSync(resolve(REPO_ROOT, OVERLAY_REAL_GATE_FILE), "utf8");
    assert.ok(gateText.includes("SLOW REAL-VM GATE"), "the gate must keep its SLOW REAL-VM GATE header");
    assert.ok(
      gateText.includes("DO NOT RUN BY DEFAULT"),
      "the gate header must still say it must not be run by default",
    );
    assert.ok(
      gateText.includes("NOT executed in"),
      "the gate must keep its disclosure that the overlap arm was not executed in the delivering run",
    );
  });
});
