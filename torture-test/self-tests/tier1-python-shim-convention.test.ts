// Tier-1 self-test (E3.D US-011 / S10 authoring): python-fixture shim PATH
// convention — the explicit `.venv/bin/pytest` test_cmd form.
//
// S10 picks ONE convention for python fixtures and states it in the
// case-authoring docs: every python-fixture `context.test_cmd` MUST use the
// explicit `.venv/bin/pytest -q` form (the fixture's committed `bootstrap`
// creates `.venv` at provisioning — prebootstrapped arming — so the explicit
// path always resolves). NO PATH magic: the shim's spawn env does not put
// `.venv/bin` on PATH, so a bare `pytest -q` (or `python3 -m pytest`) is
// rejected. This is consistent with E3.A's S1 choice for the W1.L1/L2/L3/M1
// python lines (`.venv/bin/pytest -q`) and with the tt-poly fixtures'
// documented TEST_CMD convention.
//
// The two REPLAY lines are E3.D-owned (S9): W1.REPLAY-python must carry the
// explicit form EXACTLY like its pair W1.L2-python (the TSTX cache key is
// (origin_repo, tree_hash, cmd_hash) — a diverging command makes the
// cross-run cache HIT unreachable); the ts pair (W1.REPLAY-ts ↔ W1.L2-ts)
// keeps `npm test` on BOTH lines — tt-ts is a pure TypeScript fixture (its
// suite is `tsx --test` via package.json), the explicit-`.venv` convention is
// python-fixture-scoped by design (S10 is the *python* shim PATH item).
//
// This test pins:
//   * W1.REPLAY-python carries context.test_cmd === ".venv/bin/pytest -q";
//   * W1.REPLAY-ts keeps "npm test" and matches its pair's test_cmd verbatim
//     (replay cmd-key match invariant);
//   * cases/tier1-traceability.md carries the authoring-conventions section
//     with the explicit-form rule (AC1);
//   * the convention check accepts the real manifest and REJECTS a mutated
//     temp manifest whose E3.D-owned python line carries a bare "pytest -q"
//     or a "python3 -m pytest" test_cmd (AC3);
//   * the production controller's --validate-only still accepts the full
//     manifest (28 cases).
//
// Confined to torture-test/. Zero tokens. No daemons, no launches.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const traceabilityDoc = path.join(ttRoot, "cases", "tier1-traceability.md");
const replayPythonTask = path.join(ttRoot, "cases", "tasks", "tier1", "W1.REPLAY-python.md");
const controller = path.join(ttRoot, "bin", "tt-controller");

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function loadTier1(manifestPath: string = tier1Manifest): Record<string, any>[] {
  return fs
    .readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function runValidate(manifestPath: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(controller, ["--manifest", manifestPath, "--validate-only"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

// The E3.D-owned python lines are the REPLAY lines whose fixture is a python
// fixture. (The L2/L3/M1 python lines are E3.A-owned on their branch; on this
// branch they still carry the pre-E3.A values, so the enforcement scope is
// the REPLAY pair — the surface E3.D owns per the E3.D task file.)
function isPythonFixture(record: Record<string, any>): boolean {
  return typeof record.fixture === "string" && record.fixture.startsWith("tt-python");
}

function e3dOwnedPythonLines(records: Record<string, any>[]): Record<string, any>[] {
  return records.filter(
    (record) => typeof record.context?.replay_of === "string" && isPythonFixture(record),
  );
}

/**
 * The S10 authoring convention: every python-fixture line that carries a
 * context.test_cmd MUST use the explicit `.venv/bin/pytest` form. Throws on
 * a bare `pytest` / `python3 -m pytest` (or any non-explicit variant).
 */
function checkPythonTestCmdConvention(record: Record<string, any>): void {
  if (!isPythonFixture(record)) return;
  const cmd = record.context?.test_cmd;
  if (typeof cmd !== "string" || cmd === "") return; // no suite command declared
  if (cmd.startsWith(".venv/bin/pytest")) return;
  throw new Error(
    `python-fixture ${record.id}: context.test_cmd must use the explicit ` +
      `.venv/bin/pytest form (got ${JSON.stringify(cmd)}) — no PATH magic, ` +
      `never a bare pytest / python3 -m pytest`,
  );
}

describe("US-011 python shim PATH convention (S10 authoring)", () => {
  it("AC2: W1.REPLAY-python carries the explicit .venv/bin/pytest -q test_cmd", () => {
    const records = loadTier1();
    const replay = records.find((record) => record.id === "W1.REPLAY-python");
    assert.ok(replay, "W1.REPLAY-python must be in tier1.jsonl");
    assert.equal(replay.context?.test_cmd, ".venv/bin/pytest -q",
      "the E3.D-owned python REPLAY line must carry the explicit form exactly");
    assert.equal(replay.context?.replay_of, "W1.L2-python",
      "the replay_of pairing must be unchanged");
  });

  it("AC2: W1.REPLAY-ts keeps npm test and matches its pair's test_cmd verbatim (replay cmd-key match)", () => {
    const records = loadTier1();
    const replay = records.find((record) => record.id === "W1.REPLAY-ts");
    const pair = records.find((record) => record.id === "W1.L2-ts");
    assert.ok(replay && pair, "W1.REPLAY-ts and W1.L2-ts must be in tier1.jsonl");
    // tt-ts is a pure TypeScript fixture (suite: `tsx --test` via npm test) —
    // the explicit-.venv convention is python-fixture-scoped (S10 is the
    // python shim PATH item).
    assert.equal(replay.context?.test_cmd, "npm test",
      "the ts REPLAY line keeps npm test");
    assert.equal(pair.context?.test_cmd, "npm test",
      "the ts pair line keeps npm test (E3.A-owned)");
    assert.equal(replay.context?.test_cmd, pair.context?.test_cmd,
      "REPLAY test_cmd must match its pair's verbatim (same cmd_hash -> cache HIT reachable)");
  });

  it("AC1: tier1-traceability.md documents the authoring-conventions section with the explicit-form rule", () => {
    const doc = fs.readFileSync(traceabilityDoc, "utf8");
    assert.match(doc, /## Case-Authoring Conventions \(`context\.test_cmd`, S10\)/,
      "the doc must carry the Case-Authoring Conventions section");
    assert.match(doc, /must\s+use the explicit `\.venv\/bin\/pytest -q` form/is,
      "the doc must state the explicit-form rule for python fixtures");
    assert.match(doc, /NEVER a bare `pytest -q`/,
      "the doc must forbid the bare pytest form");
    assert.match(doc, /no PATH magic/i,
      "the doc must state the no-PATH-magic rationale");
    assert.match(doc, /REPLAY lines:\*\* `test_cmd` MUST match the paired probe case's\s+`test_cmd` verbatim/s,
      "the doc must state the REPLAY cmd-key match rule");
  });

  it("AC3 accept: the convention check accepts every E3.D-owned python line in the real manifest", () => {
    const records = loadTier1();
    const owned = e3dOwnedPythonLines(records);
    assert.ok(owned.length > 0, "at least one E3.D-owned python line must exist");
    assert.deepEqual(owned.map((record) => record.id).sort(), ["W1.REPLAY-python"],
      "the E3.D-owned python surface is exactly the python REPLAY line");
    for (const record of owned) {
      checkPythonTestCmdConvention(record);
    }
  });

  it("AC3 reject: a bare 'pytest -q' test_cmd on an E3.D-owned python line is rejected", () => {
    const records = loadTier1();
    const mutated = records.map((record) => {
      if (record.id === "W1.REPLAY-python") {
        const copy = structuredClone(record);
        copy.context.test_cmd = "pytest -q";
        return copy;
      }
      return record;
    });
    assert.throws(
      () => {
        for (const record of e3dOwnedPythonLines(mutated)) {
          checkPythonTestCmdConvention(record);
        }
      },
      (err: Error) => err instanceof Error
        && /W1\.REPLAY-python/.test(err.message)
        && /\.venv\/bin\/pytest/.test(err.message)
        && /pytest -q/.test(err.message),
      "the bare-pytest mutation must be rejected with the line id and the convention",
    );
  });

  it("AC3 reject: a 'python3 -m pytest' test_cmd on an E3.D-owned python line is rejected", () => {
    const records = loadTier1();
    const mutated = records.map((record) => {
      if (record.id === "W1.REPLAY-python") {
        const copy = structuredClone(record);
        copy.context.test_cmd = "python3 -m pytest -q";
        return copy;
      }
      return record;
    });
    assert.throws(
      () => {
        for (const record of e3dOwnedPythonLines(mutated)) {
          checkPythonTestCmdConvention(record);
        }
      },
      /python3 -m pytest/,
      "the python3 -m pytest mutation must be rejected",
    );
  });

  it("AC2/AC3: the W1.REPLAY-python task file documents the explicit form (task/manifest consistency)", () => {
    const task = fs.readFileSync(replayPythonTask, "utf8");
    assert.match(task, /`\.venv\/bin\/pytest -q`/,
      "the task file must name the explicit form");
    assert.doesNotMatch(task, /The TEST_CMD for this fixture is: `pytest -q`/,
      "the task file must not advertise the bare form");
  });

  it("manifest validation passes (28 cases) with the convention change", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0,
      `--validate-only must exit 0:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /28/, "the validation must cover all 28 cases");
  });
});
