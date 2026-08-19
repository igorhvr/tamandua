// E3.C US-001 — probe_sequence + typed chaos block in the case manifest schema.
//
// The E3.C lifecycle machinery (probe sequencer, chaos wiring, O16 oracle)
// is declared per case in the manifest: `probe_sequence` carries the ordered
// lifecycle probes the controller executes against the CONTAINED TT instance
// while a case's runs are in flight, and `chaos` is tightened from a loose
// anyOf[null, object] into the typed W3.17b block shape the controller hands
// to bin/tt-chaos. This test pins the schema contract:
//   * `probe_sequence` is OPTIONAL and NULLABLE (absent or null = no probes),
//     an array of per-run probe groups (run ordinal >= 1 + ordered actions);
//   * each action carries `op` (fail-closed enum), `when` (phase marker),
//     optional `hold_seconds` (> 0), optional `expect` (observed-effect
//     contract for O16 — all fields optional);
//   * `chaos` is a typed object (type/target/trigger/hold_seconds/operator)
//     matching the W3.17b block, still nullable;
//   * unknown probe ops, unknown chaos types/operators, unknown properties,
//     run < 1, empty actions, malformed `when`, and non-positive hold
//     durations are REJECTED fail-closed through the PRODUCTION controller's
//     --validate-only path;
//   * every existing manifest (tier1/tier0/cases/smoke) still validates.
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const schemaPath = path.join(ttRoot, "cases", "case.schema.json");
const controller = path.join(ttRoot, "bin", "tt-controller");

const PROBE_OPS = ["pause", "pause_drain", "resume", "cancel", "fail_force", "restart_daemon", "sigstop_sigcont"];
const WHEN_PATTERN = "^(now|step:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+|event:[A-Za-z0-9._-]+)$";

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function readSchema(): Record<string, any> {
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

function runValidate(manifestPath: string): { status: number; stdout: string; stderr: string } {
  return spawnSync(controller, ["--manifest", manifestPath, "--validate-only"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Build a single-case manifest under a temp dir inside torture-test/var (the
// controller refuses manifests that escape torture-test/). The base case is a
// copy of the first tier1 record; field overrides are applied on top.
function buildCaseManifest(overrides: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(ttRoot, "var", "probe-seq-schema-"));
  const base = JSON.parse(fs.readFileSync(path.join(ttRoot, "cases", "tier1.jsonl"), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")[0]);
  Object.assign(base, overrides);
  const manifest = path.join(dir, "case.jsonl");
  fs.writeFileSync(manifest, `${JSON.stringify(base)}\n`);
  return manifest;
}

function expectRejected(label: string, overrides: Record<string, unknown>, needle?: RegExp): void {
  const manifest = buildCaseManifest(overrides);
  try {
    const res = runValidate(manifest);
    assert.notEqual(res.status, 0, `${label} must be REJECTED by schema validation`);
    if (needle) {
      assert.match(res.stdout + res.stderr, needle, `${label} rejection must name ${needle}`);
    }
  } finally {
    fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
  }
}

describe("E3.C US-001 — probe_sequence + typed chaos schema contract", () => {
  it("case.schema.json defines probe_sequence as an optional nullable array of per-run probe groups", () => {
    const schema = readSchema();
    assert.ok(schema.properties?.probe_sequence, "schema must define a top-level probe_sequence property");
    assert.ok(!schema.required.includes("probe_sequence"), "probe_sequence must NOT be required (existing manifests omit it)");

    const probeSequence = schema.properties.probe_sequence;
    assert.ok(Array.isArray(probeSequence.anyOf), "probe_sequence must be nullable via anyOf(null, array)");
    const nulls = probeSequence.anyOf.filter((arm: any) => arm.type === "null");
    const arrays = probeSequence.anyOf.filter((arm: any) => arm.type === "array");
    assert.equal(nulls.length, 1, "probe_sequence must have a null alternative");
    assert.equal(arrays.length, 1, "probe_sequence must have exactly one array alternative");
    assert.equal(arrays[0].items.$ref, "#/$defs/probeGroup", "array items must reference the probeGroup def");

    const group = schema.$defs.probeGroup;
    assert.ok(group, "schema must define $defs.probeGroup");
    assert.equal(group.additionalProperties, false, "probeGroup must forbid unknown properties");
    assert.deepEqual(group.required, ["run", "actions"], "probeGroup must require run + actions");
    assert.equal(group.properties.run.type, "integer", "run must be typed integer");
    assert.equal(group.properties.run.minimum, 1, "run ordinal must be >= 1");
    assert.equal(group.properties.actions.type, "array", "actions must be an array");
    assert.equal(group.properties.actions.minItems, 1, "actions must contain at least one action");
  });

  it("probe actions carry the fail-closed op enum, a phase-marker when, optional hold_seconds and expect", () => {
    const schema = readSchema();
    const action = schema.$defs.probeAction;
    assert.ok(action, "schema must define $defs.probeAction");
    assert.equal(action.additionalProperties, false, "probeAction must forbid unknown properties");
    assert.deepEqual(action.required, ["op", "when"], "probeAction must require op + when");
    assert.deepEqual(action.properties.op.enum, PROBE_OPS, "op enum must be exactly the seven E3.C probe verbs");
    assert.equal(action.properties.when.pattern, WHEN_PATTERN, "when must enforce the phase-marker format");
    assert.equal(action.properties.hold_seconds.type, "number", "hold_seconds must be typed number");
    assert.equal(action.properties.hold_seconds.exclusiveMinimum, 0, "hold_seconds must be > 0");

    const expect = schema.$defs.probeExpect;
    assert.ok(expect, "schema must define $defs.probeExpect");
    assert.equal(expect.additionalProperties, false, "probeExpect must forbid unknown properties");
    for (const field of [
      "run_completes",
      "no_rounds_during_hold",
      "drain_waits_current",
      "next_story_parked",
      "canceled_terminal_event",
      "same_run_id_resumes",
      "recovery_within_dispatch_intervals",
      "token_flush_preserved",
    ]) {
      assert.ok(expect.properties[field], `probeExpect must define the ${field} observed-effect field`);
    }
  });

  it("chaos is the typed W3.17b block shape extended with kill/delete actions (US-003, still nullable)", () => {
    const schema = readSchema();
    const chaos = schema.properties.chaos;
    assert.ok(chaos, "schema must keep the top-level chaos property");
    const nulls = chaos.anyOf.filter((arm: any) => arm.type === "null");
    const refs = chaos.anyOf.filter((arm: any) => arm.$ref !== undefined);
    assert.equal(nulls.length, 1, "chaos must stay nullable (null = no injection)");
    assert.equal(refs.length, 1, "chaos must reference exactly one typed def");
    assert.equal(refs[0].$ref, "#/$defs/chaosBlock", "non-null chaos must reference the chaosBlock def");

    const block = schema.$defs.chaosBlock;
    assert.ok(block, "schema must define $defs.chaosBlock");
    assert.equal(block.additionalProperties, false, "chaosBlock must forbid unknown properties");
    // US-003: hold_seconds is no longer universally required (it is
    // sigstop_sigcont-only); the per-type target/param constraints live in
    // the controller's semantic validator, which stays fail-closed.
    // T2.1 US-010: the block's requirement set is SPLIT into an allOf/anyOf
    // pair so the TYPED injection arm (type/target/trigger/operator) and the
    // O11 DECLARATION-ONLY arm (synthetic_token_ledger — the run id is
    // unknowable at authoring time; the controller materializes it at oracle
    // time) are mutually exclusive but at least one is always required. The
    // top-level `required` is therefore empty; the per-arm requirements live
    // in allOf.
    assert.deepEqual(block.required, [], "chaosBlock top-level required must be empty (per-arm requirements in allOf)");
    const arms = block.allOf?.[0]?.anyOf;
    assert.ok(Array.isArray(arms) && arms.length === 2,
      "chaosBlock must carry exactly two requirement arms (typed injection + O11 declaration-only)");
    const typedArm = arms.find((arm: any) => arm.required?.includes("type"));
    const ledgerArm = arms.find((arm: any) => arm.required?.includes("synthetic_token_ledger"));
    assert.ok(typedArm, "chaosBlock must require type/target/trigger/operator on the typed injection arm");
    assert.deepEqual(typedArm.required, ["type", "target", "trigger", "operator"],
      "typed chaos arm must require type/target/trigger/operator (hold_seconds is per-type)");
    assert.ok(ledgerArm, "chaosBlock must require synthetic_token_ledger on the O11 declaration-only arm");
    assert.deepEqual(ledgerArm.required, ["synthetic_token_ledger"],
      "O11 declaration-only arm must require exactly synthetic_token_ledger");
    assert.deepEqual(
      block.properties.type.enum,
      ["sigstop_sigcont", "kill-harness", "kill-daemon", "delete-tstx-row"],
      "chaos type must be the four-action enum (sigstop + US-003 kill/delete)",
    );
    assert.deepEqual(
      block.properties.target.enum,
      ["harness_process", "daemon_process", "tstx_row"],
      "chaos target must be the per-type target enum",
    );
    assert.equal(block.properties.trigger.type, "string", "chaos trigger must be a string");
    assert.equal(block.properties.hold_seconds.type, "number", "chaos hold_seconds must be typed number");
    assert.equal(block.properties.hold_seconds.exclusiveMinimum, 0, "chaos hold_seconds must be > 0");
    // US-003: kill actions take an optional signal (default SIGKILL).
    assert.ok(Array.isArray(block.properties.signal?.enum), "chaos signal must be an enum");
    assert.ok(block.properties.signal.enum.includes("SIGKILL"), "chaos signal enum must include SIGKILL");
    assert.equal(block.properties.tree.type, "string", "chaos tree must be typed string (delete-tstx-row)");
    assert.deepEqual(block.properties.operator.enum, ["tt-chaos"], "chaos operator must be enum [tt-chaos]");
  });

  it("accepts a full valid probe_sequence (all seven ops)", () => {
    // The full seven-op sequence spans TWO run groups (restart_daemon is a
    // daemon-level op requiring >= 2 groups per the US-007 launch-shape
    // contract). The chaos block is deliberately NOT combined here: US-008's
    // semantic rule forbids chaos with a multi-run probe_sequence (the
    // injection has no run ordinal) — the typed chaos block's acceptance is
    // pinned by the tier1.jsonl manifest validation test (W3.17b).
    const valid = buildCaseManifest({
      id: "T-VALID-FULL",
      probe_sequence: [
        {
          run: 1,
          actions: [
            { op: "pause", when: "step:developer:running", hold_seconds: 600, expect: { no_rounds_during_hold: true } },
            { op: "resume", when: "now", expect: { run_completes: true } },
            { op: "sigstop_sigcont", when: "event:run.completed", hold_seconds: 30 },
            { op: "restart_daemon", when: "step:developer:running", expect: { recovery_within_dispatch_intervals: 2, token_flush_preserved: true } },
          ],
        },
        {
          run: 2,
          actions: [
            { op: "cancel", when: "step:finalize_merge:running", expect: { canceled_terminal_event: true } },
            { op: "fail_force", when: "step:implement:running", expect: { same_run_id_resumes: true } },
            { op: "restart_daemon", when: "now", expect: { recovery_within_dispatch_intervals: 2, token_flush_preserved: true } },
          ],
        },
      ],
    });
    try {
      const res = runValidate(valid);
      assert.equal(res.status, 0, `full probe_sequence must validate:\n${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /Validated 1 case\(s\)/);
    } finally {
      fs.rmSync(path.dirname(valid), { recursive: true, force: true });
    }
  });

  it("accepts probe_sequence: null and chaos: null (existing manifest shape)", () => {
    const res = runValidate(path.join(ttRoot, "cases", "tier1.jsonl"));
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });

  it("carries the O9 special-exit opt-in in context (typed) and rejects the old chaos carrier", () => {
    const schema = readSchema();
    const o9 = schema.properties?.context?.properties?.o9_special_exits;
    assert.ok(o9, "schema must define context.properties.o9_special_exits");
    assert.equal(o9.type, "boolean", "o9_special_exits must be typed boolean");

    const valid = buildCaseManifest({ id: "T-O9-CTX", context: { execution_mode: "real", test_cmd: "npm test", o9_special_exits: true } });
    try {
      const res = runValidate(valid);
      assert.equal(res.status, 0, `context.o9_special_exits must validate:\n${res.stdout}${res.stderr}`);
    } finally {
      fs.rmSync(path.dirname(valid), { recursive: true, force: true });
    }

    // The old loose carrier must NOT silently pass the typed chaos schema.
    expectRejected(
      "legacy chaos.o9_special_exits carrier",
      { chaos: { o9_special_exits: true } },
      /chaos/,
    );
  });

  it("rejects a probe_sequence with an unknown op", () => {
    expectRejected(
      "unknown probe op",
      { probe_sequence: [{ run: 1, actions: [{ op: "explode", when: "now" }] }] },
      /probe_sequence/,
    );
  });

  it("rejects a typed chaos block with an unknown type", () => {
    expectRejected(
      "unknown chaos type",
      { chaos: { type: "sigkill", target: "harness_process", trigger: "mid_round", hold_seconds: 600, operator: "tt-chaos" } },
      /chaos/,
    );
  });

  it("rejects a typed chaos block with an unknown operator or unknown property", () => {
    expectRejected("unknown chaos operator", {
      chaos: { type: "sigstop_sigcont", target: "harness_process", trigger: "mid_round", hold_seconds: 600, operator: "other" },
    });
    expectRejected("unknown chaos property", {
      chaos: { type: "sigstop_sigcont", target: "harness_process", trigger: "mid_round", hold_seconds: 600, operator: "tt-chaos", extra: 1 },
    });
  });

  it("rejects a chaos block missing a required field", () => {
    expectRejected("chaos missing hold_seconds", {
      chaos: { type: "sigstop_sigcont", target: "harness_process", trigger: "mid_round", operator: "tt-chaos" },
    });
  });

  it("rejects malformed probe groups and actions fail-closed", () => {
    expectRejected("run ordinal below 1", { probe_sequence: [{ run: 0, actions: [{ op: "pause", when: "now" }] }] });
    expectRejected("empty actions array", { probe_sequence: [{ run: 1, actions: [] }] });
    expectRejected("malformed when marker", { probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "step:developer" }] }] });
    expectRejected("non-positive hold_seconds", { probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "now", hold_seconds: 0 }] }] });
    expectRejected("unknown probe group property", { probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "now" }], bogus: true }] });
    expectRejected("unknown probe action property", { probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "now", bogus: 1 }] }] });
    expectRejected("unknown expect property", {
      probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "now", expect: { bogus: true } }] }],
    });
  });

  it("every existing manifest (tier1/tier0/cases/smoke) still validates", () => {
    for (const manifestName of ["tier1.jsonl", "tier0.jsonl", "cases.jsonl", "smoke.jsonl"]) {
      const manifestPath = path.join(ttRoot, "cases", manifestName);
      const res = runValidate(manifestPath);
      assert.equal(res.status, 0, `${manifestName} must validate with the new schema:\n${res.stdout}${res.stderr}`);
    }
  });
});
