// S29 (US-001) — probe-trigger-vocabulary audit red-arm.
//
// The tier-2 attempt-2 campaign (campaign-20260826T225744158Z-4bf26d7f)
// left five cells TEST_INFRA_FAIL 'probe-trigger-unreached': each probe
// armed on a `when` trigger and waited 4-8 minutes while the run went
// terminal without the trigger ever firing. This test pins the AUDIT of
// those five cells against the ACTUAL event stream the campaign captured
// (contained home var/home/.tamandua/events/<runId>.jsonl, read-only) and
// the workflow vocabulary the trigger must match, and classifies every cell
// as either trigger-vocabulary CALIBRATION (the marker names a step/agent
// that does not exist in the case's workflow, so it can NEVER fire) or
// scenario-premise REDESIGN (the marker names a real product event that the
// run genuinely never emits, so the corridor premise must be re-armed).
//
// It is a RED-ARM: it reproduces the exact campaign failure lines from
// report.txt (INFRA FAILURES) by replicating the controller's probe-marker
// semantics (tt-controller probeStepMarkerSatisfied / probeEventMarkerSatisfied
// / waitForProbeTrigger) against a fabricated bug-fix-merge-worktree steps
// table and the captured event names, so the defect is pinned before any
// manifest calibration (US-002) or premise re-arming (US-004) lands. The
// pinned facts below are CAMPAIGN evidence and stay true regardless of how
// the manifest is later calibrated.
//
// Fast + read-only (temp dirs only under os.tmpdir; no campaign machinery,
// no daemon, zero tokens). Follows the tier2-*.test.ts self-test pattern and
// is picked up by self-tests/run.sh's tier2 glob automatically.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const manifestPath = path.join(ttRoot, "cases", "tier2.jsonl");
const traceabilityPath = path.join(ttRoot, "cases", "tier2-traceability.md");
const bfmwWorkflowYaml = path.join(repoRoot, "workflows", "bug-fix-merge-worktree", "workflow.yml");

// ── Pinned campaign evidence (campaign-20260826T225744158Z-4bf26d7f) ────
// report.txt INFRA FAILURES lines, verbatim. Each line is
// `<id>: probe-trigger-unreached (<message>)` where <message> is the exact
// message the controller's probe sequencer produced (tt-controller:
// `probe action '<op>' armed on '<trigger>' never fired before the run
// reached terminal/deadline (waited <N>ms)`; the W4.10 multi-run variant
// says `before run 1 reached`).
const CAMPAIGN_LINES: Record<string, string> = {
  "W4.10-restart-recovery":
    "W4.10-restart-recovery: probe-trigger-unreached (probe action 'restart_daemon' armed on 'step:developer:running' never fired before run 1 reached terminal/deadline (waited 329508ms))",
  "W4.33a-daemon-restart-resume":
    "W4.33a-daemon-restart-resume: probe-trigger-unreached (probe action 'pause_drain' armed on 'step:developer:running' never fired before the run reached terminal/deadline (waited 340706ms))",
  "W4.33b-update-under-it-resume":
    "W4.33b-update-under-it-resume: probe-trigger-unreached (probe action 'pause' armed on 'step:developer:running' never fired before the run reached terminal/deadline (waited 470945ms))",
  "W4.33d-reroute-exhaustion-resume":
    "W4.33d-reroute-exhaustion-resume: probe-trigger-unreached (probe action 'resume' armed on 'event:run.failed' never fired before the run reached terminal/deadline (waited 263636ms))",
  "W4.48b-pause-rugpull-window":
    "W4.48b-pause-rugpull-window: probe-trigger-unreached (probe action 'pause' armed on 'event:merge.target_moved' never fired before the run reached terminal/deadline (waited 369924ms))",
};

// Per-cell audit record: the campaign's declared trigger (from the campaign
// manifest — identical to the current manifest for these cells), the failing
// run(s) whose captured event stream the audit used, the step/agent ids and
// event names ACTUALLY present in those streams, the run's terminal status
// (probe-evidence.json run_terminal_status), and the classification.
// Stream facts are read from the campaign evidence (contained home
// var/home/.tamandua/events/<uuid>.jsonl); they are pinned here so the
// self-test does not depend on the evidence directory at runtime.
type CellAudit = {
  id: string;
  op: string;
  trigger: string;
  runIds: string[];
  runTerminalStatus: string;
  observedStepIds: string[];
  observedAgentIds: string[];
  observedEvents: string[];
  classification: "calibration" | "premise-redesign";
};

const BFM_WORKFLOW_AGENT_PREFIX = "bug-fix-merge-worktree_";

// The waited duration the campaign report recorded per cell (report.txt
// INFRA FAILURES — the probe polled this long before the run went terminal).
const CAMPAIGN_WAITED_MS: Record<string, number> = {
  "W4.10-restart-recovery": 329508,
  "W4.33a-daemon-restart-resume": 340706,
  "W4.33b-update-under-it-resume": 470945,
  "W4.33d-reroute-exhaustion-resume": 263636,
  "W4.48b-pause-rugpull-window": 369924,
};

const S29_CELLS: CellAudit[] = [
  {
    id: "W4.10-restart-recovery",
    op: "restart_daemon",
    trigger: "step:developer:running",
    runIds: ["13518174-482b-4a93-98cd-dca4e1af0a3d", "216d40ca-f296-4071-b43b-a69dc9a65efb"],
    runTerminalStatus: "completed",
    observedStepIds: ["triage", "investigate", "setup", "fix", "verify", "finalize_merge"],
    observedAgentIds: ["triager", "investigator", "setup", "fixer", "verifier", "merger"],
    observedEvents: [
      "run.started", "pipeline.advanced", "step.pending", "step.running", "step.done",
      "step.rerouted", "step.expects.validated", "dispatch.render.validated",
      "run.tokens.updated", "merge.landed", "run.process_cleanup", "run.completed",
    ],
    // NOTE: `step.rerouted` here is a W4.10 RUN-2 fact — run 216d40ca is the
    // campaign's ONE genuine reroute ("Rerouted to verify (1/8)… the
    // concurrent W4.10 run landed its fix first"); run 1 (13518174) has none.
    // It is NOT a W4.33d fact (see below) and is unrelated to the probe
    // trigger, which never fired because `step:developer:running` is not bfmw
    // vocabulary (calibration).
    classification: "calibration",
  },
  {
    id: "W4.33a-daemon-restart-resume",
    op: "pause_drain",
    trigger: "step:developer:running",
    runIds: ["c07332e7-540b-4530-b02a-c77596c2c397"],
    runTerminalStatus: "completed",
    observedStepIds: ["triage", "investigate", "setup", "fix", "verify", "finalize_merge"],
    observedAgentIds: ["triager", "investigator", "setup", "fixer", "verifier", "merger"],
    observedEvents: [
      "run.started", "pipeline.advanced", "step.pending", "step.running", "step.done",
      "step.expects.validated", "dispatch.render.validated", "run.tokens.updated",
      "merge.landed", "run.process_cleanup", "run.completed",
    ],
    classification: "calibration",
  },
  {
    id: "W4.33b-update-under-it-resume",
    op: "pause",
    trigger: "step:developer:running",
    runIds: ["5c04a539-919a-4ffb-ab03-6a8c9dc0ecfd"],
    runTerminalStatus: "completed",
    observedStepIds: ["triage", "investigate", "setup", "fix", "verify", "finalize_merge"],
    observedAgentIds: ["triager", "investigator", "setup", "fixer", "verifier", "merger"],
    observedEvents: [
      "run.started", "pipeline.advanced", "step.pending", "step.running", "step.done",
      "step.expects.validated", "dispatch.render.validated", "run.tokens.updated",
      "merge.landed", "run.process_cleanup", "run.completed",
    ],
    classification: "calibration",
  },
  {
    id: "W4.33d-reroute-exhaustion-resume",
    op: "resume",
    trigger: "event:run.failed",
    runIds: ["6344ccbd-86b9-4fa0-b71b-dce75fb54caf"],
    runTerminalStatus: "completed",
    observedStepIds: ["triage", "investigate", "setup", "fix", "verify", "finalize_merge"],
    observedAgentIds: ["triager", "investigator", "setup", "fixer", "verifier", "merger"],
    observedEvents: [
      "run.started", "pipeline.advanced", "step.pending", "step.running", "step.done",
      "step.expects.validated", "dispatch.render.validated", "run.tokens.updated",
      "merge.landed", "run.process_cleanup", "run.completed",
    ],
    // NOTE: the captured stream (events/6344ccbd…jsonl) has ZERO
    // step.rerouted events — the run completed cleanly (6 steps done,
    // merge.landed, run.completed). The campaign's one genuine step.rerouted
    // belongs to W4.10 run 2 (216d40ca), not this run. The premise-redesign
    // justification stands on run.completed without run.failed.
    classification: "premise-redesign",
  },
  {
    id: "W4.48b-pause-rugpull-window",
    op: "pause",
    trigger: "event:merge.target_moved",
    runIds: ["dc12e0c7-962d-47c0-b66f-0ce486b712a3"],
    runTerminalStatus: "completed",
    observedStepIds: ["triage", "investigate", "setup", "fix", "verify", "finalize_merge"],
    observedAgentIds: ["triager", "investigator", "setup", "fixer", "verifier", "merger"],
    observedEvents: [
      "run.started", "pipeline.advanced", "step.pending", "step.running", "step.done",
      "step.expects.validated", "dispatch.render.validated", "run.tokens.updated",
      "merge.landed", "run.process_cleanup", "run.completed",
    ],
    classification: "premise-redesign",
  },
];

// Real product event-name vocabulary. run.failed is emitted by
// src/installer/run.ts / step-ops.ts on a run's permanent failure;
// merge.target_moved is emitted by src/installer/merge-branch.ts when the
// merger's expected-tip check fails. Both are REAL names — a probe armed on
// them is not a vocabulary error; whether the run ever EMITS them is a
// scenario-premise question.
const PINNED_PRODUCT_EVENT_VOCABULARY = [
  "run.started",
  "run.completed",
  "run.failed",
  "run.canceled",
  "run.deleted",
  "run.force_failed",
  "run.process_cleanup",
  "run.paused",
  "run.tokens.updated",
  "step.pending",
  "step.running",
  "step.done",
  "step.failed",
  "step.rerouted",
  "step.expects.validated",
  "pipeline.advanced",
  "dispatch.render.validated",
  "merge.landed",
  "merge.target_moved",
  "merge.conflicts",
  "run.rugpull_detected",
  "run.rugpull_relaunch_suppressed",
];

// ── Minimal helpers ─────────────────────────────────────────────────────

type Case = Record<string, any>;

function readManifest(): Case[] {
  const source = fs.readFileSync(manifestPath, "utf8");
  const records: Case[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    records.push(JSON.parse(line));
  }
  return records;
}

function recordById(records: Case[], id: string): Case {
  const record = records.find((item) => item.id === id);
  assert.ok(record, `${id} must exist in cases/tier2.jsonl`);
  return record;
}

// Extract `- id: <x>` entries from a workflow.yml block (agents:/steps:).
// Deliberately dependency-free: self-tests run with node builtins only.
function yamlIdList(block: string): string[] {
  const ids: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    const match = /^\s*-\s+id:\s*(\S+)\s*$/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

function bfmwVocabulary(): { steps: string[]; agents: string[] } {
  assert.ok(fs.existsSync(bfmwWorkflowYaml), `bfmw workflow spec missing: ${bfmwWorkflowYaml}`);
  const source = fs.readFileSync(bfmwWorkflowYaml, "utf8");
  const agentsBlock = source.slice(source.indexOf("agents:"), source.indexOf("steps:"));
  const stepsBlock = source.slice(source.indexOf("steps:"));
  return { steps: yamlIdList(stepsBlock), agents: yamlIdList(agentsBlock) };
}

// ── Faithful replica of tt-controller's probe-marker semantics ──────────
// probeStepMarkerSatisfied (tt-controller ~line 5477):
//   SELECT 1 FROM steps WHERE run_id = ? AND (step_id = ? OR agent_id LIKE ?)
//   AND status = ? LIMIT 1  — matched with the full run id, then the short id.
// probeEventMarkerSatisfied (~line 5509): substring match on event.event.
// waitForProbeTrigger (~line 5564): marker check → terminal-status exit →
//   the failure message template at ~line 5669.

function probeStepMarkerSatisfiedReplica(marker: string, runId: string, dbPath: string): boolean {
  const parts = marker.slice("step:".length).split(":");
  if (parts.length !== 2) return false;
  const [role, state] = parts;
  const shortRunId = runId.startsWith("run-") ? runId.slice(4) : runId;
  const database = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const query = `SELECT 1 FROM steps WHERE run_id = ? AND (step_id = ? OR agent_id LIKE ?) AND status = ? LIMIT 1`;
    let rows = database.prepare(query).all(runId, role, `%${role}%`, state);
    if (rows.length === 0 && shortRunId !== runId) {
      rows = database.prepare(query).all(shortRunId, role, `%${role}%`, state);
    }
    return rows.length > 0;
  } finally {
    database.close();
  }
}

function probeEventMarkerSatisfiedReplica(marker: string, eventsDir: string, runId: string): boolean {
  const eventType = marker.slice("event:".length);
  const shortRunId = runId.startsWith("run-") ? runId.slice(4) : runId;
  const candidates = [
    path.join(eventsDir, `${shortRunId}.jsonl`),
    path.join(eventsDir, `${runId}.jsonl`),
  ];
  const names = new Set<string>();
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        const event = JSON.parse(line);
        if (event !== null && typeof event === "object" && typeof event.event === "string") {
          names.add(event.event);
        }
      } catch {
        // Deliberate guard mirroring tt-controller: a malformed line is not a
        // marker match and does not abort the stream read.
      }
    }
  }
  return Array.from(names).some((name) => name.includes(eventType));
}

// One string-marker wait iteration of waitForProbeTrigger: if the marker is
// not satisfied and the run is terminal, the probe can no longer fire and the
// sequencer emits probe-trigger-unreached. Returns the message exactly as the
// controller formats it.
function waitForProbeTriggerReplica(
  trigger: string,
  op: string,
  runId: string,
  dbPath: string,
  eventsDir: string,
  terminalStatus: string,
  waitedMs: number,
): string {
  const satisfied = trigger === "now"
    ? true
    : trigger.startsWith("step:")
      ? probeStepMarkerSatisfiedReplica(trigger, runId, dbPath)
      : trigger.startsWith("event:")
        ? probeEventMarkerSatisfiedReplica(trigger, eventsDir, runId)
        : false;
  if (satisfied) {
    throw new Error(`red-arm invariant broken: trigger ${trigger} unexpectedly satisfied for ${op}`);
  }
  return `probe action '${op}' armed on '${trigger}' never fired before the run reached terminal/deadline (waited ${waitedMs}ms)`;
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Build a contained-style DB whose steps table carries the bfmw step/agent
// vocabulary exactly as the campaign runs observed it (step_id + agent_id
// with the bug-fix-merge-worktree_ prefix), all 'running'.
function makeBfmwStepsDb(shortRunId: string): string {
  const dir = tempDir("tier2-s29-steps-");
  const dbPath = path.join(dir, "tamandua.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE steps (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL
  )`);
  const insert = db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, status) VALUES (?, ?, ?, ?, 'running')`,
  );
  const { steps, agents } = bfmwVocabulary();
  assert.equal(steps.length, 6, "bfmw must have 6 steps");
  assert.equal(agents.length, 6, "bfmw must have 6 agents");
  for (let i = 0; i < steps.length; i += 1) {
    insert.run(`step-${i}`, shortRunId, steps[i], `${BFM_WORKFLOW_AGENT_PREFIX}${agents[i]}`);
  }
  db.close();
  return dbPath;
}

// Write the captured event names for a run as the contained per-run stream
// (<state>/events/<shortRunId>.jsonl) with the product's event shape.
function writeCapturedStream(shortRunId: string, eventNames: string[]): string {
  const dir = tempDir("tier2-s29-events-");
  const eventsDir = path.join(dir, "events");
  fs.mkdirSync(eventsDir, { recursive: true });
  const lines = eventNames.map((name, index) =>
    JSON.stringify({
      ts: new Date(Date.UTC(2026, 7, 27, 2, 0, 0, index)).toISOString(),
      event: name,
      runId: shortRunId,
      workflowId: "bug-fix-merge-worktree",
    }));
  fs.writeFileSync(path.join(eventsDir, `${shortRunId}.jsonl`), `${lines.join("\n")}\n`, "utf8");
  return eventsDir;
}

describe("S29 (US-001) — probe-trigger-vocabulary audit vs the campaign event stream", () => {
  const records = readManifest();
  const { steps: bfmwSteps, agents: bfmwAgents } = bfmwVocabulary();

  it("the five S29 cells exist in cases/tier2.jsonl with non-empty probe sequences", () => {
    for (const cell of S29_CELLS) {
      const record = recordById(records, cell.id);
      assert.equal(record.workflow, "bug-fix-merge-worktree", `${cell.id} must run bug-fix-merge-worktree`);
      assert.ok(Array.isArray(record.probe_sequence) && record.probe_sequence.length > 0,
        `${cell.id} must carry a probe_sequence`);
    }
  });

  it("bug-fix-merge-worktree has NO developer step or agent (the S29 calibration premise)", () => {
    assert.deepEqual(bfmwSteps, ["triage", "investigate", "setup", "fix", "verify", "finalize_merge"],
      "bfmw step vocabulary (workflows/bug-fix-merge-worktree/workflow.yml)");
    assert.deepEqual(bfmwAgents, ["triager", "investigator", "setup", "fixer", "verifier", "merger"],
      "bfmw agent vocabulary");
    assert.ok(!bfmwSteps.includes("developer"), "bfmw must not have a 'developer' step");
    assert.ok(!bfmwAgents.includes("developer"), "bfmw must not have a 'developer' agent");
  });

  it("RED-ARM: the campaign failure line for every S29 cell is reproduced verbatim", () => {
    for (const cell of S29_CELLS) {
      const campaignLine = CAMPAIGN_LINES[cell.id];
      assert.ok(campaignLine, `${cell.id}: pinned campaign line must exist`);
      // The report line is `<id>: probe-trigger-unreached (<message>)`.
      assert.ok(campaignLine.startsWith(`${cell.id}: probe-trigger-unreached (`),
        `${cell.id}: campaign line must open with the probe-trigger-unreached category`);
      // The message names the op and the armed trigger exactly as declared.
      assert.ok(campaignLine.includes(`probe action '${cell.op}'`),
        `${cell.id}: campaign line must name op '${cell.op}'`);
      assert.ok(campaignLine.includes(`armed on '${cell.trigger}'`),
        `${cell.id}: campaign line must name trigger '${cell.trigger}'`);
      assert.ok(campaignLine.includes(`(waited ${CAMPAIGN_WAITED_MS[cell.id]}ms)`),
        `${cell.id}: campaign line must carry the waited duration`);
      // The wait loop exited because the run went terminal (probe-evidence.json
      // run_terminal_status) — every one of the five runs COMPLETED, so the
      // probe could no longer fire.
      assert.equal(cell.runTerminalStatus, "completed",
        `${cell.id}: captured run(s) must have gone terminal with status completed`);
      assert.ok(cell.observedEvents.includes("run.completed"),
        `${cell.id}: captured stream must show the run completed`);
    }
    // The pinned lines match the campaign report verbatim (provenance:
    // report.txt INFRA FAILURES). Spot-check the representative W4.33a cell.
    assert.equal(CAMPAIGN_LINES["W4.33a-daemon-restart-resume"],
      "W4.33a-daemon-restart-resume: probe-trigger-unreached (probe action 'pause_drain' armed on 'step:developer:running' never fired before the run reached terminal/deadline (waited 340706ms))");
  });

  it("RED-ARM: 'step:developer:running' can never fire on bfmw while the calibrated spelling fires (W4.33a representative)", () => {
    const cell = S29_CELLS.find((c) => c.id === "W4.33a-daemon-restart-resume")!;
    const shortRunId = cell.runIds[0];
    const dbPath = makeBfmwStepsDb(shortRunId);
    try {
      // Wrong vocabulary: the bfmw steps table has no developer row.
      assert.equal(probeStepMarkerSatisfiedReplica("step:developer:running", `run-${shortRunId}`, dbPath), false,
        "step:developer:running must NOT match the bfmw steps table");
      // The run went terminal (run.completed in the captured stream); the
      // wait loop exits with the exact campaign failure message.
      const eventsDir = writeCapturedStream(shortRunId, cell.observedEvents);
      const message = waitForProbeTriggerReplica(
        "step:developer:running", "pause_drain", `run-${shortRunId}`, dbPath, eventsDir,
        "completed", CAMPAIGN_WAITED_MS[cell.id]);
      assert.equal(message,
        "probe action 'pause_drain' armed on 'step:developer:running' never fired before the run reached terminal/deadline (waited 340706ms)");
      assert.ok(CAMPAIGN_LINES[cell.id].includes(message),
        "the replicated failure message must be exactly the campaign failure line's message");
      // The calibrated spellings (US-002) DO fire: step-id 'fix' and
      // agent-role 'fixer' both match the bfmw coding step.
      assert.equal(probeStepMarkerSatisfiedReplica("step:fix:running", `run-${shortRunId}`, dbPath), true,
        "step:fix:running must match the bfmw fix step");
      assert.equal(probeStepMarkerSatisfiedReplica("step:fixer:running", `run-${shortRunId}`, dbPath), true,
        "step:fixer:running must match the bfmw fixer agent (agent_id LIKE %fixer%)");
      assert.equal(probeStepMarkerSatisfiedReplica("step:triage:running", `run-${shortRunId}`, dbPath), true,
        "step:triage:running must match the bfmw triage step");
    } finally {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    }
  });

  it("RED-ARM: the three step:developer cells are calibration (wrong vocabulary, never firable)", () => {
    for (const cell of S29_CELLS.filter((c) => c.classification === "calibration")) {
      assert.equal(cell.trigger, "step:developer:running",
        `${cell.id}: calibration cells must be the step:developer:running cells`);
      for (const runId of cell.runIds) {
        const dbPath = makeBfmwStepsDb(runId);
        try {
          assert.equal(probeStepMarkerSatisfiedReplica(cell.trigger, `run-${runId}`, dbPath), false,
            `${cell.id} (${runId}): '${cell.trigger}' must never match the bfmw steps table`);
        } finally {
          fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
        }
      }
      // The captured stream shows the run completed without any developer
      // step — the marker cannot fire by construction (calibration).
      assert.ok(!cell.observedStepIds.includes("developer"),
        `${cell.id}: captured stream must show no developer step`);
      assert.ok(!cell.observedAgentIds.includes("developer"),
        `${cell.id}: captured stream must show no developer agent`);
      if (cell.id === "W4.10-restart-recovery") {
        // The campaign's ONE genuine step.rerouted belongs to W4.10 run 2
        // (216d40ca: "Rerouted to verify (1/8)… the concurrent W4.10 run
        // landed its fix first") — it is a stream fact of a CALIBRATION cell,
        // not of W4.33d, and is unrelated to the (wrong-vocabulary) probe
        // trigger.
        assert.ok(cell.observedEvents.includes("step.rerouted"),
          "W4.10: the captured stream facts must include step.rerouted (run 2 216d40ca rerouted to verify once)");
      }
    }
  });

  it("RED-ARM: event:run.failed / event:merge.target_moved are REAL product events but absent from the captured streams (premise redesign)", () => {
    for (const cell of S29_CELLS.filter((c) => c.classification === "premise-redesign")) {
      // The trigger is real product vocabulary — this is NOT a spelling error.
      const eventType = cell.trigger.slice("event:".length);
      assert.ok(PINNED_PRODUCT_EVENT_VOCABULARY.includes(eventType),
        `${cell.id}: '${eventType}' must be a real product event name (src/installer/run.ts / merge-branch.ts)`);
      // But the captured stream genuinely lacks it: the run completed and the
      // target never moved, so the event never fired.
      for (const runId of cell.runIds) {
        const eventsDir = writeCapturedStream(runId, cell.observedEvents);
        try {
          assert.equal(probeEventMarkerSatisfiedReplica(cell.trigger, eventsDir, `run-${runId}`), false,
            `${cell.id} (${runId}): '${cell.trigger}' must NOT be present in the captured event stream`);
        } finally {
          fs.rmSync(path.dirname(eventsDir), { recursive: true, force: true });
        }
      }
      assert.ok(!cell.observedEvents.includes(eventType),
        `${cell.id}: captured events must not include '${eventType}'`);
      if (cell.id === "W4.33d-reroute-exhaustion-resume") {
        assert.ok(cell.observedEvents.includes("run.completed"),
          "W4.33d: the run COMPLETED (no reroute exhaustion, no run.failed)");
        assert.ok(!cell.observedEvents.includes("step.rerouted"),
          "W4.33d: the captured stream (6344ccbd) has ZERO step.rerouted events — the run completed cleanly, the reroute machinery never ran");
        assert.ok(cell.observedEvents.includes("merge.landed"),
          "W4.33d: the run landed (merge.landed) — no persistent target move ever happened");
      }
      if (cell.id === "W4.48b-pause-rugpull-window") {
        assert.ok(cell.observedEvents.includes("merge.landed"),
          "W4.48b: the target never moved — the run landed with merge.landed");
      }
      // Reproduce the exact campaign failure line.
      const message = `probe action '${cell.op}' armed on '${cell.trigger}' never fired before the run reached terminal/deadline (waited ${CAMPAIGN_WAITED_MS[cell.id]}ms)`;
      assert.ok(CAMPAIGN_LINES[cell.id].includes(message),
        `${cell.id}: replicated message must match the campaign failure line`);
    }
  });

  it("per-cell disposition: 3 calibration + 2 premise redesign, documented in tier2-traceability.md", () => {
    const calibration = S29_CELLS.filter((c) => c.classification === "calibration").map((c) => c.id);
    const redesign = S29_CELLS.filter((c) => c.classification === "premise-redesign").map((c) => c.id);
    assert.deepEqual(calibration.sort(), [
      "W4.10-restart-recovery", "W4.33a-daemon-restart-resume", "W4.33b-update-under-it-resume",
    ], "wrong-vocabulary calibration cells (no developer step/agent in bfmw)");
    assert.deepEqual(redesign.sort(), [
      "W4.33d-reroute-exhaustion-resume", "W4.48b-pause-rugpull-window",
    ], "premise-redesign cells (real event names the run genuinely never emits)");

    // The traceability doc carries the disposition section naming all five.
    const doc = fs.readFileSync(traceabilityPath, "utf8");
    assert.match(doc, /## S29 trigger-vocabulary disposition/, "traceability doc must have the S29 disposition section");
    const sectionStart = doc.indexOf("## S29 trigger-vocabulary disposition");
    const section = doc.slice(sectionStart);
    for (const cell of S29_CELLS) {
      assert.ok(section.includes(cell.id), `S29 disposition section must name ${cell.id}`);
    }
    assert.match(section, /\*\*calibration\*\*/i, "section must state the calibration class");
    assert.match(section, /\*\*premise redesign\*\*/i, "section must state the premise-redesign class");
    // The per-cell disposition TABLE row for each cell carries its class in
    // the final Classification column.
    const tableRows = section.split(/\r?\n/).filter((line) => line.trim().startsWith("| W4."));
    for (const cell of S29_CELLS) {
      const row = tableRows.find((line) => line.includes(`| ${cell.id} |`));
      assert.ok(row, `disposition table must have a row for ${cell.id}`);
      const expectedClass = cell.classification === "calibration" ? "**calibration**" : "**premise redesign**";
      assert.ok(row.includes(expectedClass),
        `disposition table row for ${cell.id} must classify as ${expectedClass}: ${row}`);
    }
  });

  it("GREEN-ARM (US-002): the calibrated manifest arms the three calibration cells on step:fixer:running (bfmw vocabulary)", () => {
    // The campaign manifest carried the wrong-vocabulary trigger; US-002
    // calibrated tier2.jsonl so the probes can actually fire. The pinned
    // audit facts above (S29_CELLS) keep the campaign's ORIGINAL declared
    // trigger (step:developer:running) — this test asserts the CURRENT
    // manifest's calibrated value and that it matches bfmw vocabulary.
    const CALIBRATED_TRIGGER = "step:fixer:running";
    const calibrationCells = S29_CELLS.filter((c) => c.classification === "calibration");
    assert.equal(calibrationCells.length, 3, "exactly the three wrong-vocabulary cells are calibration");
    for (const cell of calibrationCells) {
      const record = recordById(records, cell.id);
      assert.ok(Array.isArray(record.probe_sequence) && record.probe_sequence.length > 0,
        `${cell.id}: probe_sequence required`);
      for (const [groupIndex, group] of record.probe_sequence.entries()) {
        assert.ok(Array.isArray(group.actions) && group.actions.length > 0,
          `${cell.id} run group ${groupIndex + 1}: actions required`);
        for (const [actionIndex, action] of group.actions.entries()) {
          // Only the arming markers (`when` starting with `step:`/`event:`)
          // are calibrated — a `now` trigger is the fire-immediately marker
          // and must stay untouched.
          if (typeof action.when !== "string" || !action.when.startsWith("step:")) continue;
          assert.equal(action.when, CALIBRATED_TRIGGER,
            `${cell.id} run group ${groupIndex + 1} action ${actionIndex + 1}: step marker must arm on ${CALIBRATED_TRIGGER} after the US-002 calibration (was step:developer:running)`);
        }
        // No action anywhere in the sequence may still carry the wrong
        // vocabulary.
        for (const action of group.actions) {
          assert.notEqual(action.when, "step:developer:running",
            `${cell.id} run group ${groupIndex + 1}: step:developer:running must be gone after the US-002 calibration`);
        }
      }
      // The calibrated spelling matches the bfmw vocabulary the controller's
      // probeStepMarkerSatisfied contract matches (step_id 'fix' OR
      // agent_id LIKE '%fixer%' — the fixer agent is bug-fix-merge-worktree_fixer).
      assert.ok(bfmwSteps.includes("fix"), `${cell.id}: bfmw must have the fix step`);
      assert.ok(bfmwAgents.includes("fixer"), `${cell.id}: bfmw must have the fixer agent`);
    }
  });
});
