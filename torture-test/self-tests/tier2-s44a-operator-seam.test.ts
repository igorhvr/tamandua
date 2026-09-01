// S44a (US-009) — operator-seam controller actions: fail-closed schema +
// semantic contract pins.
//
// The four operator-seam probe ops (restart_contained_daemon,
// update_contained_install, invalidate_credentials, restore_credentials) wire
// the mid-run operator actions the W4.10/W4.48a/W4.33a/W4.33b/W4.47 premises
// depend on as first-class controller actions (campaign-20260826T225744158Z
// left those cells vacuous/stalled — "operator action in the task text" with
// no machinery). This file pins the fail-closed CONTRACT:
//   * the schema op enum carries the four ops + the optional during_hold
//     marker (the W4.33a/W4.33b "act during the pause hold" shape);
//   * --validate-only ACCEPTS the valid single-run corridor shapes and
//     REJECTS the fail-closed violations (multi-run declarations,
//     restore-without-invalidate, during_hold without a preceding hold);
//   * the traceability doc has the S44a section.
// The EXECUTION proofs (each action fires against a contained stub daemon/
// home, records per-action evidence, fails closed with a distinct category,
// and refuses containment escapes) live in bin/tt-controller.test.sh unit
// arms (the W3.20/W3.22 multi-run pattern). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const schemaPath = path.join(ttRoot, "cases", "case.schema.json");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const controller = path.join(ttRoot, "bin", "tt-controller");

const S44A_OPS = ["restart_contained_daemon", "update_contained_install", "invalidate_credentials", "restore_credentials"];

const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function readSchema(): Record<string, any> {
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

function runValidate(manifestPath: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(controller, ["--manifest", manifestPath, "--validate-only"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function buildCaseManifest(overrides: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(varRoot, "s44a-pin-"));
  const base = JSON.parse(
    fs.readFileSync(path.join(ttRoot, "cases", "tier1.jsonl"), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")[0],
  );
  base.workflow = "feature-dev-merge-worktree";
  Object.assign(base, overrides);
  const manifest = path.join(dir, "case.jsonl");
  fs.writeFileSync(manifest, `${JSON.stringify(base)}\n`);
  return manifest;
}

function expectAccepted(label: string, overrides: Record<string, unknown>): void {
  const manifest = buildCaseManifest(overrides);
  try {
    const res = runValidate(manifest);
    assert.equal(res.status, 0, `${label} must validate:\n${res.stdout}${res.stderr}`);
  } finally {
    fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
  }
}

function expectRejected(label: string, overrides: Record<string, unknown>, needle: RegExp): void {
  const manifest = buildCaseManifest(overrides);
  try {
    const res = runValidate(manifest);
    assert.notEqual(res.status, 0, `${label} must be REJECTED by --validate-only`);
    assert.match(res.stdout + res.stderr, needle, `${label} must name a distinct reason matching ${needle}`);
  } finally {
    fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
  }
}

describe("S44a — operator-seam controller actions (US-009)", () => {
  it("case.schema.json op enum carries the four operator-seam ops + the optional during_hold boolean", () => {
    const schema = readSchema();
    const opEnum = schema.$defs.probeAction.properties.op.enum as string[];
    for (const op of S44A_OPS) {
      assert.ok(opEnum.includes(op), `op enum must include ${op}`);
    }
    const duringHold = schema.$defs.probeAction.properties.during_hold;
    assert.ok(duringHold, "probeAction must define the optional during_hold property (S44a)");
    assert.equal(duringHold.type, "boolean", "during_hold must be typed boolean");
  });

  it("--validate-only accepts the valid single-run corridor shapes", () => {
    expectAccepted("restart during hold (W4.33a shape)", {
      probe_sequence: [{
        run: 1,
        actions: [
          { op: "pause_drain", when: "step:developer:running", hold_seconds: 30 },
          { op: "restart_contained_daemon", when: "now", during_hold: true },
          { op: "resume", when: "now" },
        ],
      }],
    });
    expectAccepted("update during hold (W4.33b shape)", {
      probe_sequence: [{
        run: 1,
        actions: [
          { op: "pause", when: "step:developer:running", hold_seconds: 30 },
          { op: "update_contained_install", when: "now", during_hold: true },
          { op: "resume", when: "now" },
        ],
      }],
    });
    expectAccepted("credential corridor (W4.47 shape)", {
      probe_sequence: [{
        run: 1,
        actions: [
          { op: "invalidate_credentials", when: "now" },
          { op: "restore_credentials", when: "now" },
        ],
      }],
    });
    expectAccepted("single restart action", {
      probe_sequence: [{ run: 1, actions: [{ op: "restart_contained_daemon", when: "now" }] }],
    });
  });

  it("--validate-only rejects the fail-closed operator-seam violations with distinct reasons", () => {
    expectRejected("restart_contained_daemon on a multi-run sequence", {
      probe_sequence: [
        { run: 1, actions: [{ op: "restart_contained_daemon", when: "now" }] },
        { run: 2, actions: [{ op: "cancel", when: "step:developer:running" }] },
      ],
    }, /the S44a operator-seam ops are single-run corridor ops/);
    expectRejected("restore without a prior invalidate", {
      probe_sequence: [{ run: 1, actions: [{ op: "restore_credentials", when: "now" }] }],
    }, /restore_credentials requires a preceding invalidate_credentials action in the same run group/);
    expectRejected("during_hold without a preceding hold-capable action", {
      probe_sequence: [{ run: 1, actions: [{ op: "restart_contained_daemon", when: "now", during_hold: true }] }],
    }, /during_hold requires a PRECEDING action in the same run group to hold against/);
    expectRejected("during_hold on a multi-run sequence", {
      probe_sequence: [
        { run: 1, actions: [{ op: "pause", when: "step:developer:running", hold_seconds: 5 }, { op: "restart_contained_daemon", when: "now", during_hold: true }] },
        { run: 2, actions: [{ op: "cancel", when: "step:developer:running" }] },
      ],
    }, /during_hold is a single-run corridor marker/);
  });

  it("tier2-traceability.md has the S44a section and the operator-seam machinery delta rows name the actions", () => {
    const doc = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(doc, /## S44a Operator-seam controller actions/, "traceability must have the S44a section");
    assert.match(doc, /restart_contained_daemon/, "S44a section must name restart_contained_daemon");
    assert.match(doc, /update_contained_install/, "S44a section must name update_contained_install");
    assert.match(doc, /invalidate_credentials/, "S44a section must name invalidate_credentials");
    assert.match(doc, /restore_credentials/, "S44a section must name restore_credentials");
    assert.match(doc, /operator-action-escape-refused/, "S44a section must document the escape-refusal category");
  });

  it("the existing tier2 manifest still validates with the extended schema + semantic layer", () => {
    const res = runValidate(path.join(ttRoot, "cases", "tier2.jsonl"));
    assert.equal(res.status, 0, `tier2 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 70 case\(s\)/);
  });
});
