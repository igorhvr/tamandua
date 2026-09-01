// E3.C US-005 — controller probe_sequence semantic validation, fail-closed.
//
// The JSON schema (US-001) already rejects structurally invalid probe
// declarations (unknown ops, malformed `when`, empty actions, run < 1).
// US-005 adds the SEMANTIC layer the schema cannot express and wires it
// fail-closed into BOTH paths:
//   * --validate-only: a semantically-invalid probe_sequence exits non-zero
//     with a DISTINCT reason naming the case id and the offending op/action;
//   * the execute path: a case whose probe_sequence fails semantic validation
//     is persisted as TEST_INFRA_FAIL(category 'probe-sequence-invalid') on a
//     launch-intent evidence attempt BEFORE any launch attempt is created —
//     a malformed probe declaration can never silently degrade into the old
//     launch->wait->snapshot behavior (campaign #7 S3/S4).
//
// Semantic checks (beyond the schema): unknown probe op (defense-in-depth
// below the schema enum), missing/invalid `when`, hold-capable ops (pause,
// sigstop_sigcont) without hold_seconds, run ordinals not starting at 1 or
// non-contiguous, an empty actions array, and probe_sequence declared on a
// local-command case. pause_drain deliberately does NOT require hold_seconds
// (drain is self-terminating — W3.19 declares it without one).
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const resultsRoot = path.join(varRoot, "results");
const controller = path.join(ttRoot, "bin", "tt-controller");
const TIER1 = path.join(ttRoot, "cases", "tier1.jsonl");
const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[A-Za-z0-9._-]+)$/m;

// node:test marks descendant processes; drop NODE_TEST_CONTEXT so the
// TAMANDUA_TEST_GUARD live-state protection does not auto-activate for the
// spawned controller (mirrors tier1-zero-real-launch-infra.test.ts). /bin/false
// backstops guard against any accidental real model invocation.
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

type CommandResult = { status: number | null; stdout: string; stderr: string };

function run(file: string, args: string[], timeout = 300_000): CommandResult {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
}

function runValidate(manifestPath: string): CommandResult {
  return run(controller, ["--manifest", manifestPath, "--validate-only"]);
}

function readRecords(manifestPath: string): Record<string, any>[] {
  return fs.readFileSync(manifestPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

function recordById(id: string, manifestPath = TIER1): Record<string, any> {
  const record = readRecords(manifestPath).find((item) => item.id === id);
  assert.ok(record, `manifest must contain case ${id}`);
  return JSON.parse(JSON.stringify(record));
}

// Build a single-case manifest under a temp dir inside torture-test/var (the
// controller refuses manifests that escape torture-test/). The base case is a
// deep copy of a tier1 record; field overrides are applied on top. Returns the
// temp dir so the caller can clean it up.
function buildCaseManifest(baseId: string, overrides: Record<string, unknown>): { dir: string; manifest: string } {
  const dir = fs.mkdtempSync(path.join(varRoot, "probe-seq-semantic-"));
  const base = recordById(baseId);
  Object.assign(base, overrides);
  const manifest = path.join(dir, "case.jsonl");
  fs.writeFileSync(manifest, `${JSON.stringify(base)}\n`);
  return { dir, manifest };
}

// Assert a manifest is REJECTED by --validate-only (exit 2) and that the
// rejection output carries a distinct reason naming the offending op/action.
function expectRejected(
  label: string,
  baseId: string,
  overrides: Record<string, unknown>,
  needle: RegExp,
): void {
  const built = buildCaseManifest(baseId, overrides);
  try {
    const res = runValidate(built.manifest);
    assert.equal(res.status, 2, `${label} must exit 2 (validation failure):\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout + res.stderr, needle, `${label} must name a distinct reason matching ${needle}`);
  } finally {
    fs.rmSync(built.dir, { recursive: true, force: true });
  }
}

describe("E3.C US-005 — controller probe_sequence semantic validation (fail-closed)", () => {
  it("rejects an unknown probe op in --validate-only with a distinct reason naming the case id and the op", () => {
    expectRejected(
      "unknown probe op",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "explode", when: "now" }] }] },
      /case "W3\.18-pause-no-drain": .*action 1 \(op "explode"\): unknown probe op \(known:/,
    );
  });

  it("rejects pause without hold_seconds in --validate-only with a distinct reason naming the action", () => {
    expectRejected(
      "pause without hold_seconds",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "now" }] }] },
      /case "W3\.18-pause-no-drain": .*action 1 \(op 'pause'\): hold-capable op requires hold_seconds > 0/,
    );
  });

  it("rejects sigstop_sigcont without hold_seconds (tt-chaos would refuse it at runtime)", () => {
    expectRejected(
      "sigstop_sigcont without hold_seconds",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "sigstop_sigcont", when: "now" }] }] },
      /action 1 \(op 'sigstop_sigcont'\): hold-capable op requires hold_seconds > 0/,
    );
  });

  it("rejects run ordinals that do not start at 1", () => {
    expectRejected(
      "run ordinal starting at 2",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 2, actions: [{ op: "pause", when: "now", hold_seconds: 5 }] }] },
      /run ordinals must start at 1 and be contiguous \(declared: 2\)/,
    );
  });

  it("rejects non-contiguous run ordinals (gap between run 1 and run 3)", () => {
    expectRejected(
      "non-contiguous run ordinals",
      "W3.18-pause-no-drain",
      {
        probe_sequence: [
          { run: 1, actions: [{ op: "pause", when: "now", hold_seconds: 5 }] },
          { run: 3, actions: [{ op: "resume", when: "now" }] },
        ],
      },
      /run ordinals must start at 1 and be contiguous \(declared: 1, 3\)/,
    );
  });

  it("rejects an empty actions array with a distinct reason", () => {
    expectRejected(
      "empty actions array",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [] }] },
      /actions must contain at least one action/,
    );
  });

  it("rejects an action without a valid when phase marker with a distinct reason", () => {
    expectRejected(
      "missing when",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "pause", hold_seconds: 5 }] }] },
      /action 1 \(op "pause"\): missing or invalid 'when' phase marker/,
    );
    expectRejected(
      "malformed when",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "step:developer", hold_seconds: 5 }] }] },
      /action 1 \(op "pause"\): missing or invalid 'when' phase marker/,
    );
  });

  // S18b: the trigger vocabulary gains AWAITED object forms — a valid object
  // `when` is a plain object with timeout_s > 0 and exactly ONE of status
  // (nonempty string) / event (nonempty string). The semantic layer accepts
  // them (defense-in-depth below the schema) and rejects malformed objects
  // with the SAME distinct 'missing or invalid when' reason.
  it("accepts the awaited object when forms (status and event) in --validate-only (S18b)", () => {
    const builtStatus = buildCaseManifest("W3.18-pause-no-drain", {
      probe_sequence: [{ run: 1, actions: [{ op: "resume", when: { status: "paused", timeout_s: 120 } }] }],
    });
    try {
      const res = runValidate(builtStatus.manifest);
      assert.equal(res.status, 0, `object status when must validate:\n${res.stdout}${res.stderr}`);
    } finally {
      fs.rmSync(builtStatus.dir, { recursive: true, force: true });
    }
    const builtEvent = buildCaseManifest("W3.18-pause-no-drain", {
      probe_sequence: [{ run: 1, actions: [{ op: "resume", when: { event: "run.process_cleanup", timeout_s: 120 } }] }],
    });
    try {
      const res = runValidate(builtEvent.manifest);
      assert.equal(res.status, 0, `object event when must validate:\n${res.stdout}${res.stderr}`);
    } finally {
      fs.rmSync(builtEvent.dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid object when with the distinct 'missing or invalid when' reason (S18b)", () => {
    expectRejected(
      "object when missing timeout_s",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "resume", when: { status: "paused" } }] }] },
      /case "W3\.18-pause-no-drain": .*action 1 \(op "resume"\): missing or invalid 'when' phase marker/,
    );
    expectRejected(
      "object when with both status and event",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "resume", when: { status: "paused", event: "run.process_cleanup", timeout_s: 120 } }] }] },
      /case "W3\.18-pause-no-drain": .*action 1 \(op "resume"\): missing or invalid 'when' phase marker/,
    );
    expectRejected(
      "object when with an unknown key",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "resume", when: { status: "paused", timeout_s: 120, bogus: 1 } }] }] },
      /case "W3\.18-pause-no-drain": .*action 1 \(op "resume"\): missing or invalid 'when' phase marker/,
    );
  });

  it("rejects probe_sequence declared on a local-command case", () => {
    expectRejected(
      "probe_sequence on a local-command case",
      "W2.21-admission",
      { probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "now", hold_seconds: 5 }] }] },
      /case "W2\.21-admission": .*probe_sequence is not supported on local-command cases \(harness 'local'\)/,
    );
  });

  it("accepts the W3.19 pause_drain shape WITHOUT hold_seconds (drain is self-terminating)", () => {
    const built = buildCaseManifest("W3.19-pause-drain", {});
    try {
      const res = runValidate(built.manifest);
      assert.equal(res.status, 0, `W3.19 pause_drain (no hold_seconds) must validate:\n${res.stdout}${res.stderr}`);
    } finally {
      fs.rmSync(built.dir, { recursive: true, force: true });
    }
  });

  it("every existing manifest (tier1/tier0/cases/smoke) still validates under the semantic layer", () => {
    for (const manifestName of ["tier1.jsonl", "tier0.jsonl", "cases.jsonl", "smoke.jsonl"]) {
      const res = runValidate(path.join(ttRoot, "cases", manifestName));
      assert.equal(res.status, 0, `${manifestName} must validate with the semantic probe_sequence layer:\n${res.stdout}${res.stderr}`);
    }
  });

  it("campaign path persists TEST_INFRA_FAIL(probe-sequence-invalid) before launch — local-command case", () => {
    const built = buildCaseManifest("W2.21-admission", {
      id: "T-PROBE-LOCAL-GUARD",
      requires: {},
      oracles: [],
      probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "now", hold_seconds: 5 }] }],
    });
    let campaignId: string | null = null;
    try {
      const res = run(controller, ["--manifest", built.manifest, "--scripted-only"]);
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `campaign must be recorded:\n${res.stdout}\n${res.stderr}`);
      const state = JSON.parse(fs.readFileSync(path.join(resultsRoot, campaignId!, "state.json"), "utf8"));
      const item = state.cases[0];
      assert.equal(item.id, "T-PROBE-LOCAL-GUARD");
      assert.equal(item.phase, "terminal");
      assert.equal(item.outcome, "TEST_INFRA_FAIL");
      assert.equal(item.reason?.category, "probe-sequence-invalid");
      assert.match(item.reason?.message ?? "", /not supported on local-command cases/);
      assert.equal(item.attempts.length, 1, "exactly one launch-intent guard attempt must be persisted");
      const attempt = item.attempts[0];
      assert.equal(attempt.phase, "terminal");
      assert.equal(attempt.outcome, "TEST_INFRA_FAIL");
      assert.equal(attempt.counts_toward_gate, false);
      assert.equal(attempt.command, undefined, "the local command hook must never have been constructed");
      assert.deepEqual(
        attempt.probe_sequence_guard?.errors,
        ["probe_sequence is not supported on local-command cases (harness 'local')"],
        "the guard attempt must carry the distinct semantic errors",
      );
    } finally {
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(built.dir, { recursive: true, force: true });
    }
  });

  it("campaign path persists TEST_INFRA_FAIL(probe-sequence-invalid) before launch — workflow case (pause without hold)", () => {
    const built = buildCaseManifest("W3.18-pause-no-drain", {
      id: "T-PROBE-WORKFLOW-GUARD",
      context: { execution_mode: "scripted", test_cmd: "npm test" },
      requires: {},
      oracles: [],
      probe_sequence: [{ run: 1, actions: [{ op: "pause", when: "now" }] }],
    });
    let campaignId: string | null = null;
    try {
      const res = run(controller, ["--manifest", built.manifest, "--scripted-only"]);
      const m = CAMPAIGN_LINE.exec(res.stdout);
      campaignId = m === null ? null : m[1];
      assert.ok(campaignId, `campaign must be recorded:\n${res.stdout}\n${res.stderr}`);
      const state = JSON.parse(fs.readFileSync(path.join(resultsRoot, campaignId!, "state.json"), "utf8"));
      const item = state.cases[0];
      assert.equal(item.id, "T-PROBE-WORKFLOW-GUARD");
      assert.equal(item.phase, "terminal");
      assert.equal(item.outcome, "TEST_INFRA_FAIL");
      assert.equal(item.reason?.category, "probe-sequence-invalid");
      assert.match(item.reason?.message ?? "", /hold-capable op requires hold_seconds > 0/);
      assert.equal(item.attempts.length, 1, "exactly one launch-intent guard attempt must be persisted");
      const attempt = item.attempts[0];
      assert.equal(attempt.phase, "terminal");
      assert.equal(attempt.outcome, "TEST_INFRA_FAIL");
      assert.equal(attempt.counts_toward_gate, false);
      assert.equal(attempt.kind, "workflow");
      assert.equal(attempt.launch, undefined, "no launch hook may exist — no launch attempt was created");
      assert.equal(attempt.reset, undefined, "no reset hook may exist");
      assert.equal(attempt.command, undefined, "no command hook may exist");
      assert.deepEqual(
        attempt.probe_sequence_guard?.errors,
        ["run group 1 (run 1) action 1 (op 'pause'): hold-capable op requires hold_seconds > 0"],
        "the guard attempt must carry the distinct semantic errors",
      );
    } finally {
      if (campaignId !== null) fs.rmSync(path.join(resultsRoot, campaignId), { recursive: true, force: true });
      fs.rmSync(built.dir, { recursive: true, force: true });
    }
  });

  // E3.C US-007: multi-launch launch-shape contract. restart_daemon is a
  // daemon-level op — it can only be declared on a multi-run sequence and
  // EVERY run group must declare it (each group's restart_daemon action
  // carries that run's recovery contract for O16).
  it("rejects restart_daemon on a single-run probe_sequence (daemon restart needs runs in flight together)", () => {
    expectRejected(
      "restart_daemon single-run",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "restart_daemon", when: "step:developer:running" }] }] },
      /restart_daemon is a daemon-level multi-run op: it requires at least two run groups/,
    );
  });

  it("rejects restart_daemon when a run group omits it (every group carries the per-run recovery contract)", () => {
    expectRejected(
      "restart_daemon missing on a group",
      "W3.18-pause-no-drain",
      {
        probe_sequence: [
          { run: 1, actions: [{ op: "restart_daemon", when: "step:developer:running" }] },
          { run: 2, actions: [{ op: "cancel", when: "step:developer:running" }] },
        ],
      },
      /run group 2 \(run 2\): every run group must declare restart_daemon/,
    );
  });

  it("accepts the W3.22 concurrent shape (three run groups, every group declaring restart_daemon)", () => {
    const built = buildCaseManifest("W3.18-pause-no-drain", {
      probe_sequence: [
        { run: 1, actions: [{ op: "restart_daemon", when: "step:developer:running" }] },
        { run: 2, actions: [{ op: "restart_daemon", when: "step:developer:running" }] },
        { run: 3, actions: [{ op: "restart_daemon", when: "step:developer:running" }] },
      ],
    });
    try {
      const res = runValidate(built.manifest);
      assert.equal(res.status, 0, `the W3.22 concurrent shape must validate:\n${res.stdout}${res.stderr}`);
    } finally {
      fs.rmSync(built.dir, { recursive: true, force: true });
    }
  });

  // ── S44a (US-009): operator-seam probe ops — fail-closed semantic guards ──
  // The operator-seam ops (restart_contained_daemon, update_contained_install,
  // invalidate_credentials, restore_credentials) are SINGLE-RUN corridor ops
  // (each fires once against the contained daemon/install/home mid-run). A
  // multi-run launch shape has no single run to act against; a
  // restore_credentials with no prior invalidate has no backup to restore;
  // and during_hold requires a preceding hold-capable action (the action
  // fires concurrently with that hold). All fail closed at DECLARATION time —
  // never a silent per-run re-fire or a runtime no-backup surprise.
  it("rejects the S44a operator-seam ops on a multi-run probe_sequence", () => {
    expectRejected(
      "restart_contained_daemon multi-run",
      "W3.18-pause-no-drain",
      {
        probe_sequence: [
          { run: 1, actions: [{ op: "restart_contained_daemon", when: "now" }] },
          { run: 2, actions: [{ op: "cancel", when: "step:developer:running" }] },
        ],
      },
      /the S44a operator-seam ops are single-run corridor ops/,
    );
    expectRejected(
      "update_contained_install multi-run",
      "W3.18-pause-no-drain",
      {
        probe_sequence: [
          { run: 1, actions: [{ op: "update_contained_install", when: "now" }] },
          { run: 2, actions: [{ op: "cancel", when: "step:developer:running" }] },
        ],
      },
      /the S44a operator-seam ops are single-run corridor ops/,
    );
  });

  it("rejects restore_credentials without a preceding invalidate_credentials in the same run group", () => {
    expectRejected(
      "restore without invalidate",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "restore_credentials", when: "now" }] }] },
      /restore_credentials requires a preceding invalidate_credentials action in the same run group/,
    );
  });

  it("rejects during_hold without a preceding hold-capable action (and on a group's first action)", () => {
    expectRejected(
      "during_hold as first action",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "restart_contained_daemon", when: "now", during_hold: true }, { op: "resume", when: "now" }] }] },
      /during_hold requires a PRECEDING action in the same run group to hold against/,
    );
    expectRejected(
      "during_hold after a non-hold action",
      "W3.18-pause-no-drain",
      { probe_sequence: [{ run: 1, actions: [{ op: "cancel", when: "step:developer:running" }, { op: "restart_contained_daemon", when: "now", during_hold: true }] }] },
      /during_hold requires the immediately preceding action .* to carry hold_seconds > 0/,
    );
    expectRejected(
      "during_hold on a multi-run sequence",
      "W3.18-pause-no-drain",
      {
        probe_sequence: [
          { run: 1, actions: [{ op: "pause", when: "step:developer:running", hold_seconds: 5 }, { op: "restart_contained_daemon", when: "now", during_hold: true }] },
          { run: 2, actions: [{ op: "cancel", when: "step:developer:running" }] },
        ],
      },
      /during_hold is a single-run corridor marker/,
    );
  });

  it("accepts the valid S44a single-run corridor shapes through --validate-only", () => {
    const shapes: Array<[string, Record<string, unknown>]> = [
      ["restart during hold", {
        probe_sequence: [{
          run: 1,
          actions: [
            { op: "pause_drain", when: "step:developer:running", hold_seconds: 30 },
            { op: "restart_contained_daemon", when: "now", during_hold: true },
            { op: "resume", when: "now" },
          ],
        }],
      }],
      ["update during hold", {
        probe_sequence: [{
          run: 1,
          actions: [
            { op: "pause", when: "step:developer:running", hold_seconds: 30 },
            { op: "update_contained_install", when: "now", during_hold: true },
            { op: "resume", when: "now" },
          ],
        }],
      }],
      ["credential corridor", {
        probe_sequence: [{
          run: 1,
          actions: [
            { op: "invalidate_credentials", when: "now" },
            { op: "restore_credentials", when: "now" },
          ],
        }],
      }],
    ];
    for (const [label, overrides] of shapes) {
      const built = buildCaseManifest("W3.18-pause-no-drain", overrides);
      try {
        const res = runValidate(built.manifest);
        assert.equal(res.status, 0, `${label} must validate:\n${res.stdout}${res.stderr}`);
      } finally {
        fs.rmSync(built.dir, { recursive: true, force: true });
      }
    }
  });
});
