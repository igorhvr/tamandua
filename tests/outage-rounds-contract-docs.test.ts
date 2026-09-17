import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// OUTAGE-ROUNDS (QFAIL + SCLS) documentation contract — US-010.
//
// Pins the behavioral contract that lives in tests/MOTOR-CONTRACT.md so a
// future edit cannot silently drop the harness-wall seam, the 6 s default
// threshold, or the pre-claim death event/counter/backoff/cap. The behavior
// itself is pinned by src/installer/instant-fail.test.ts,
// src/installer/agent-scheduler.test.ts, tests/step-ops.test.ts,
// src/db.test.ts, src/installer/status.test.ts and the scripted e2e files.
//
// The second describe block validates the external coordinator review
// artifact. That artifact (torture-test/var/ is gitignored) lives on the
// coordinator host, so the check SKIPS when it is absent instead of failing
// an unrelated checkout; a node -e shape assertion is also run as a gate.

const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "tests", "MOTOR-CONTRACT.md"))) return cwd;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "..");
})();

const CONTRACT_PATH = path.join(PROJECT_ROOT, "tests", "MOTOR-CONTRACT.md");

const ARTIFACT_PATH =
  process.env.TAMANDUA_OUTAGE_ROUNDS_CONTRACT ??
  "/home/igorhvr/idm/tamandua/torture-test/var/review-logs/coordinator-20260912/outage-rounds-contract.json";

/** Markdown emphasis/backticks are cosmetic; drop them and flatten whitespace. */
function flatten(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ");
}

describe("OUTAGE-ROUNDS docs: MOTOR-CONTRACT.md instant-fail + pre-claim backoff", () => {
  let contract: string;
  let flat: string;

  before(() => {
    contract = fs.readFileSync(CONTRACT_PATH, "utf-8");
    flat = flatten(contract);
  });

  it("carries the dedicated Instant-fail and pre-claim death backoff subsection", () => {
    assert.ok(
      flat.includes("Instant-fail and pre-claim death backoff"),
      "MOTOR-CONTRACT.md must carry an 'Instant-fail and pre-claim death backoff' subsection",
    );
  });

  it("documents the harness-wall seam (harnessWallMs / vmSetupMs)", () => {
    assert.ok(flat.includes("harnessWallMs"), "must name harnessWallMs");
    assert.ok(flat.includes("vmSetupMs"), "must name vmSetupMs");
    assert.ok(
      flat.includes("harnessWallMs === durationMs"),
      "native rounds must document harnessWallMs === durationMs",
    );
    assert.ok(
      flat.includes("vmSetupMs === 0"),
      "native rounds must document vmSetupMs === 0",
    );
    assert.ok(
      flat.includes("in-guest exec→exit"),
      "in-VM runners must report the in-guest exec→exit interval separately",
    );
    assert.ok(
      flat.includes("resolveHarnessWallMs"),
      "must document the resolveHarnessWallMs seam helper",
    );
    assert.ok(
      flat.includes("harnessWallMs ?? wallMs"),
      "must document the harnessWallMs ?? wallMs precedence",
    );
  });

  it("documents the 6000 ms default threshold and its env override", () => {
    assert.ok(flat.includes("6000 ms"), "must document the 6000 ms default");
    assert.ok(
      flat.includes("DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS"),
      "must name DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS",
    );
    assert.ok(
      flat.includes("TAMANDUA_INSTANT_FAIL_WALL_MS"),
      "must name the TAMANDUA_INSTANT_FAIL_WALL_MS override",
    );
  });

  it("documents the conservative instant-fail predicate shape", () => {
    assert.ok(
      flat.includes("empty TRIMMED stdout"),
      "must document that only empty TRIMMED stdout classifies",
    );
    assert.ok(
      flat.includes("nonzero exit code or a signal death"),
      "must document nonzero exit / signal death",
    );
  });

  it("documents the pre-claim death definition (probe + wall time + no claim)", () => {
    assert.ok(
      flat.includes("PASSED the launch probe"),
      "pre-claim death must require a passed launch probe",
    );
    assert.ok(
      flat.includes("AT LEAST the wall threshold"),
      "pre-claim death must require running at least the wall threshold",
    );
    assert.ok(
      flat.includes("WITHOUT ever claiming the pending step"),
      "pre-claim death must require never claiming the pending step",
    );
    assert.ok(
      flat.includes("TIMING AND CLAIM STATE ONLY"),
      "pre-claim detection must be timing + claim state only",
    );
    assert.ok(
      flat.includes("provider-error taxonomy"),
      "must state that no provider-error taxonomy is parsed",
    );
  });

  it("documents the per-step counter and step.preclaim_round_died event", () => {
    assert.ok(
      flat.includes("step.preclaim_round_died"),
      "must name the step.preclaim_round_died event",
    );
    assert.ok(
      flat.includes("preclaim_death_count"),
      "must name the steps.preclaim_death_count counter",
    );
    assert.ok(
      flat.includes("successful claim resets the counter to 0"),
      "must document the claim reset of the counter",
    );
  });

  it("documents the shared K=6/N=20 backoff and run.preclaim_death_loop cap", () => {
    assert.ok(flat.includes("K = 6"), "must document backoff threshold K = 6");
    assert.ok(flat.includes("N = 20"), "must document escalation threshold N = 20");
    assert.ok(
      flat.includes("armPreclaimDeathBackoff"),
      "must document the monotonic pre-claim backoff arming",
    );
    assert.ok(
      flat.includes("isPreclaimDeathBackoffActive"),
      "must document the pre-claim backoff gate",
    );
    assert.ok(
      flat.includes("run.preclaim_death_loop"),
      "must name the run.preclaim_death_loop cap event",
    );
    assert.ok(
      flat.includes("forceFailRun"),
      "must document the sanctioned forceFailRun cap path",
    );
  });

  it("states that neither class charges retry budget and does not touch WLST5 counters", () => {
    assert.ok(
      flat.includes("never touch retry_count"),
      "must state the no-retry-charge guarantee (retry_count untouched)",
    );
    assert.ok(
      flat.includes("worker_lost_count"),
      "must state WLST5 worker_lost_count is untouched",
    );
    assert.ok(
      flat.includes("ceiling_expiry_count"),
      "must state WLST5 ceiling_expiry_count is untouched",
    );
  });

  it("points at the tests that pin the contract", () => {
    for (const ref of [
      "src/installer/instant-fail.test.ts",
      "src/installer/agent-scheduler.test.ts",
      "tests/step-ops.test.ts",
      "src/db.test.ts",
      "src/installer/status.test.ts",
      "e2e-tests/workflows-preclaim-death-loop.test.ts",
    ]) {
      assert.ok(flat.includes(ref), `contract must reference the pinning test ${ref}`);
    }
  });
});

describe("OUTAGE-ROUNDS coordinator contract artifact", () => {
  const present = fs.existsSync(ARTIFACT_PATH);

  it(
    "parses as JSON and carries the required coordinator shape",
    { skip: present ? false : `artifact absent at ${ARTIFACT_PATH}` },
    () => {
      const raw = fs.readFileSync(ARTIFACT_PATH, "utf-8");
      const doc = JSON.parse(raw) as Record<string, unknown>;

      for (const key of ["task", "beads", "designMapping", "schemaBump", "events", "gates"]) {
        assert.ok(key in doc, `artifact must carry a ${key} key`);
        assert.ok(
          doc[key] !== null && doc[key] !== undefined && doc[key] !== "",
          `artifact.${key} must be non-empty`,
        );
      }

      assert.equal(doc.task, "OUTAGE-ROUNDS");
      const beads = doc.beads as string[];
      assert.ok(Array.isArray(beads), "artifact.beads must be an array");
      assert.ok(beads.includes("tamandua-6sy.61"), "beads must include tamandua-6sy.61 (QFAIL)");
      assert.ok(beads.includes("tamandua-6sy.62"), "beads must include tamandua-6sy.62 (SCLS)");

      const schemaBump = doc.schemaBump as Record<string, unknown>;
      assert.equal(schemaBump.from, 11, "schemaBump.from must be 11");
      assert.equal(schemaBump.to, 12, "schemaBump.to must be 12");
      assert.equal(
        schemaBump.column,
        "steps.preclaim_death_count",
        "schemaBump.column must be steps.preclaim_death_count",
      );

      const events = doc.events as Record<string, unknown>;
      const added = events.added as string[];
      assert.ok(Array.isArray(added), "events.added must be an array");
      assert.ok(
        added.includes("step.preclaim_round_died"),
        "events.added must include step.preclaim_round_died",
      );
      assert.ok(
        added.includes("run.preclaim_death_loop"),
        "events.added must include run.preclaim_death_loop",
      );

      const gates = doc.gates as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(gates) && gates.length > 0, "artifact.gates must be a non-empty array");
      const commands = (gates as Array<Record<string, unknown>>).map((g) => g.command);
      for (const want of ["npm run build", "npm test", "./run-all-e2e-tests"]) {
        assert.ok(
          commands.some((c) => typeof c === "string" && c.includes(want)),
          `artifact.gates must include a ${want} entry`,
        );
      }

      assert.equal(doc.realTierNotRun, true, "artifact.realTierNotRun must be true");
    },
  );
});
