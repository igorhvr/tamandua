/**
 * SJSN — story-ingestion structural validation (motor contract C20, see
 * tests/MOTOR-CONTRACT.md).
 *
 * JSON.parse accepts duplicate keys silently (last-one-wins). A planner that
 * omits "},{" separators between stories therefore emits ONE fused object
 * that still parses as valid JSON, passes every per-story field check, and
 * silently discards all but the final story. Run 9672c8dd (LSEM, 2026-07-04)
 * lost 6 of 7 stories exactly this way: the only surviving story was the
 * final "verification" story, so the developer verified unchanged main,
 * declared success, and the run burned 560k tokens delivering nothing.
 *
 * Invariants pinned here:
 * - fused/duplicate-key payloads are rejected with a structural-mismatch
 *   error naming both counts
 * - escaped quotes inside string values (a description that *talks about*
 *   `"id":`) do not trigger false positives
 * - validation is two-phase: a rejected payload inserts ZERO stories
 * - completeStep converts any STORIES_JSON validation failure into a bounded
 *   informed retry (step re-pended, retry_count bumped, reason in output so
 *   claimStep surfaces it as {{retry_feedback}}), never a thrown error
 * - retries exhaust into a failed run, not an infinite loop
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { createTempHome } from "./helpers/test-env.ts";
import { getDb } from "../dist/db.js";
import {
  claimStep,
  completeStep,
  countUnescapedJsonKey,
  detectDuplicateKeys,
  positionToLineCol,
  parseAndInsertStories,
  advancePipeline,
} from "../dist/installer/step-ops.js";

// ── Environment isolation (see step-ops-dispatch-races.test.ts) ─────
// createTempHome sets up an isolated temp home with automatic after() cleanup.

describe("stories-json-validation", () => {
  const { tamanduaDir } = createTempHome("tamandua-sjsn-");
  process.env.TAMANDUA_STATE_DIR = tamanduaDir;
  process.env.TAMANDUA_DB_PATH = path.join(tamanduaDir, "tamandua.db");
  process.env.TAMANDUA_CONTROL_PORT = "1"; // nothing listens; control-plane calls fail fast

// ── Fixtures ─────────────────────────────────────────────────────────

function story(id: string, title = `Title ${id}`) {
  return { id, title, description: `Description for ${id}`, acceptanceCriteria: ["AC1", "AC2"] };
}

/**
 * Build the fused-object payload shape from the LSEM incident: N stories'
 * keys concatenated into ONE object (no "},{" between stories).
 */
function fusedStoriesJson(ids: string[]): string {
  const inner = ids
    .map((id) => `"id":"${id}","title":"T ${id}","description":"D ${id}","acceptanceCriteria":["AC"]`)
    .join(",");
  return `[{${inner}}]`;
}

interface PlanFixture {
  runId: string;
  planAgent: string;
  planStepDbId: string;
  loopStepDbId: string;
}

/** A minimal plan → implement(loop over stories) run. */
function createPlanLoopRun(maxRetries = 4): PlanFixture {
  const db = getDb();
  const now = new Date().toISOString();
  const runId = crypto.randomUUID();
  const wf = `sjsn-wf-${runId.slice(0, 8)}`;
  const planAgent = `${wf}_planner`;

  db.prepare(
    `INSERT INTO runs (id, workflow_id, task, status, context, tokens_spent, created_at, updated_at)
     VALUES (?, ?, 'sjsn test', 'running', '{"task":"sjsn test"}', 0, ?, ?)`,
  ).run(runId, wf, now, now);

  const planStepDbId = crypto.randomUUID();
  const loopStepDbId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, created_at, updated_at)
     VALUES (?, ?, 'plan', ?, 0, ?, 'STATUS: done', 'waiting', 0, ?, 'single', ?, ?)`,
  ).run(planStepDbId, runId, planAgent, "Plan {{task}}.\nRETRY FEEDBACK:\n{{retry_feedback}}", maxRetries, now, now);
  db.prepare(
    `INSERT INTO steps (id, run_id, step_id, agent_id, step_index, input_template, expects, status, retry_count, max_retries, type, loop_config, created_at, updated_at)
     VALUES (?, ?, 'implement', ?, 1, 'do {{current_story}}', 'STATUS: done', 'waiting', 0, ?, 'loop', '{"over":"stories","completion":"all_done"}', ?, ?)`,
  ).run(loopStepDbId, runId, `${wf}_developer`, maxRetries, now, now);
  advancePipeline(runId);

  return { runId, planAgent, planStepDbId, loopStepDbId };
}

function planOutput(storiesJson: string): string {
  return `STATUS: done\nBRANCH: feature/sjsn-test\nSTORIES_JSON: ${storiesJson}`;
}

function storyCount(runId: string): number {
  const row = getDb().prepare("SELECT COUNT(*) AS cnt FROM stories WHERE run_id = ?").get(runId) as { cnt: number };
  return row.cnt;
}

// ── countUnescapedJsonKey ────────────────────────────────────────────

describe("countUnescapedJsonKey", () => {
  it("counts real key occurrences", () => {
    const text = '[{"id":"US-001","title":"A"},{"id":"US-002","title":"B"}]';
    assert.equal(countUnescapedJsonKey(text, "id"), 2);
    assert.equal(countUnescapedJsonKey(text, "title"), 2);
  });

  it("counts duplicate keys inside one fused object", () => {
    assert.equal(countUnescapedJsonKey(fusedStoriesJson(["US-001", "US-002", "US-003"]), "id"), 3);
  });

  it("does not count escaped quotes inside string values", () => {
    // description talks ABOUT the "id": key — JSON-escaped in the raw text
    const text = '[{"id":"US-001","title":"A","description":"the \\"id\\": key is required"}]';
    assert.equal(countUnescapedJsonKey(text, "id"), 1);
  });

  it("does not match longer keys containing the target as a suffix", () => {
    const text = '[{"story_id":"US-001","id":"US-002"}]';
    assert.equal(countUnescapedJsonKey(text, "id"), 1);
  });
});

// ── detectDuplicateKeys ──────────────────────────────────────────────

describe("detectDuplicateKeys", () => {
  it("detects duplicate id in fused objects", () => {
    const fused = '{"id":"US-001","title":"A","id":"US-002","title":"B"}';
    const dups = detectDuplicateKeys(fused);
    assert.equal(dups.length, 2);
    // id duplicate
    const idDup = dups.find((d) => d.key === "id");
    assert.ok(idDup, "should detect duplicate id");
    assert.equal(idDup!.objectIndex, 0);
    // title duplicate
    const titleDup = dups.find((d) => d.key === "title");
    assert.ok(titleDup, "should detect duplicate title");
    assert.equal(titleDup!.objectIndex, 0);
  });

  it("detects duplicate title in same object (non-id duplicate key)", () => {
    const text = '{"id":"US-001","title":"First Title","title":"Second Title"}';
    const dups = detectDuplicateKeys(text);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].key, "title");
    assert.equal(dups[0].objectIndex, 0);
    assert.ok(dups[0].firstPos < dups[0].secondPos);
  });

  it("handles duplicate non-id keys in fused objects (only non-id duplicates)", () => {
    // Two stories fused: "title" and "description" repeat, but "id" doesn't.
    // This is the case the raw-id-count heuristic is blind to.
    const fused =
      '{"id":"US-001","title":"A","description":"D1","title":"B","description":"D2","acceptanceCriteria":["AC"],"acceptanceCriteria":["AC2"]}';
    const dups = detectDuplicateKeys(fused);
    assert.ok(dups.length >= 2, `expected at least 2 duplicates, got ${dups.length}`);
    const dupKeys = dups.map((d) => d.key);
    assert.ok(dupKeys.includes("title"), "should detect duplicate title");
    assert.ok(dupKeys.includes("description"), "should detect duplicate description");
  });

  it("correctly handles nested objects (acceptanceCriteria arrays)", () => {
    // Story with nested acceptanceCriteria containing objects
    const text = JSON.stringify({
      id: "US-001",
      title: "Test",
      description: "A",
      acceptanceCriteria: [
        { id: "ac-1", text: "Do X" },
        { id: "ac-2", text: "Do Y" },
      ],
    });
    const dups = detectDuplicateKeys(text);
    // "id" appears in the story object AND in nested objects — NOT a duplicate
    // because each nested object is separate.
    assert.equal(dups.length, 0, "nested id keys in different objects are not duplicates");
  });

  it("detects duplicates inside nested objects", () => {
    const text = '{"id":"US-001","nested":{"a":1,"a":2}}';
    const dups = detectDuplicateKeys(text);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].key, "a");
    assert.equal(dups[0].objectIndex, 0, "nested duplicate inherits story index");
  });

  it("does not false-positive on escaped quotes in string values", () => {
    // Description mentions the "id" key in prose with escaped quotes.
    const text =
      '{"id":"US-001","title":"A","description":"the \\"id\\" key is important"}';
    const dups = detectDuplicateKeys(text);
    assert.equal(dups.length, 0);
  });

  it("does not false-positive on backslash-escaped sequences in values", () => {
    const text =
      '{"id":"US-001","title":"A","description":"path is C:\\\\foo\\\\bar"}';
    const dups = detectDuplicateKeys(text);
    assert.equal(dups.length, 0);
  });

  it("returns empty array for well-formed multi-object JSON", () => {
    const text = JSON.stringify([
      { id: "US-001", title: "A", description: "D1", acceptanceCriteria: ["AC1"] },
      { id: "US-002", title: "B", description: "D2", acceptanceCriteria: ["AC2"] },
    ]);
    const dups = detectDuplicateKeys(text);
    assert.deepEqual(dups, []);
  });

  it("returns empty array for a single well-formed object", () => {
    const text = '{"id":"US-001","title":"A","description":"D"}';
    const dups = detectDuplicateKeys(text);
    assert.deepEqual(dups, []);
  });

  it("reports correct firstPos and secondPos for a duplicate", () => {
    const text = '{"id":"US-001","title":"A","title":"B"}';
    const dups = detectDuplicateKeys(text);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].key, "title");
    // "title" first appears at position 16, then again at position 30
    const firstIdx = text.indexOf("\"title\"");
    const secondIdx = text.indexOf("\"title\"", firstIdx + 1);
    assert.equal(dups[0].firstPos, firstIdx);
    assert.equal(dups[0].secondPos, secondIdx);
  });

  it("handles multiple duplicates across different objects", () => {
    // Construct raw JSON with intentional duplicate keys (not via JSON.stringify
    // which silently drops duplicates).
    const text =
      '[{"id":"US-001","title":"A","title":"Again"},{"id":"US-002","description":"D1","description":"D2"}]';
    const dups = detectDuplicateKeys(text);
    assert.equal(dups.length, 2);
    const story0Duplicates = dups.filter((d) => d.objectIndex === 0);
    const story1Duplicates = dups.filter((d) => d.objectIndex === 1);
    assert.equal(story0Duplicates.length, 1);
    assert.equal(story0Duplicates[0].key, "title");
    assert.equal(story1Duplicates.length, 1);
    assert.equal(story1Duplicates[0].key, "description");
  });

  it("handles the empty string gracefully", () => {
    const dups = detectDuplicateKeys("");
    assert.deepEqual(dups, []);
  });

  it("handles strings with no objects gracefully", () => {
    const dups = detectDuplicateKeys("just some random text");
    assert.deepEqual(dups, []);
  });

  it("does not false-positive on comma/space inside string values containing braces", () => {
    const text = '{"id":"US-001","title":"A {nested} B"}';
    const dups = detectDuplicateKeys(text);
    assert.equal(dups.length, 0);
  });

  it("detects duplicate in compact single-line fused JSON", () => {
    // Simulates the real incident: 7 stories fused into one object
    const stories = ["US-001", "US-002", "US-003"];
    const inner = stories
      .map(
        (id) =>
          `"id":"${id}","title":"T ${id}","description":"D ${id}","acceptanceCriteria":["AC"]`,
      )
      .join(",");
    const fused = `[{${inner}}]`;
    const dups = detectDuplicateKeys(fused);
    const idDups = dups.filter((d) => d.key === "id");
    assert.equal(idDups.length, 2, "id appears 3 times but only the 2nd and 3rd are dupes after the 1st");
    const titleDups = dups.filter((d) => d.key === "title");
    assert.equal(titleDups.length, 2);
  });
});

// ── positionToLineCol ────────────────────────────────────────────────

describe("positionToLineCol", () => {
  it("returns line 1 col 1 for position 0", () => {
    assert.deepEqual(positionToLineCol("abc", 0), { line: 1, col: 1 });
  });

  it("returns correct line and col for second line", () => {
    assert.deepEqual(positionToLineCol("abc\ndef", 4), { line: 2, col: 1 });
    assert.deepEqual(positionToLineCol("abc\ndef", 5), { line: 2, col: 2 });
  });

  it("returns correct line for position at end of text", () => {
    assert.deepEqual(positionToLineCol("abc\ndef\n", 8), { line: 3, col: 1 });
  });

  it("clamps position beyond text length to last character", () => {
    assert.deepEqual(positionToLineCol("abc", 100), { line: 1, col: 4 });
  });
});

// ── parseAndInsertStories: structural rejection + atomicity ─────────

describe("parseAndInsertStories (SJSN guard)", () => {
  it("rejects the fused-object duplicate-key collapse with both counts in the message", () => {
    const fx = createPlanLoopRun();
    const fused = fusedStoriesJson(["US-001", "US-002", "US-003", "US-004", "US-005", "US-006", "US-007"]);
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${fused}\n`, fx.runId),
      (err: Error) =>
        /structural mismatch/.test(err.message) &&
        /7 "id" keys/.test(err.message) &&
        /only 1 story/.test(err.message) &&
        /fused/.test(err.message),
    );
    assert.equal(storyCount(fx.runId), 0, "rejected payload must insert zero stories");
  });

  it("accepts a properly separated array of the same stories", () => {
    const fx = createPlanLoopRun();
    const stories = ["US-001", "US-002", "US-003", "US-004", "US-005", "US-006", "US-007"].map((id) => story(id));
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 7);
  });

  it("does not false-positive on descriptions that mention the id key", () => {
    const fx = createPlanLoopRun();
    const s = story("US-001");
    s.description = 'This story documents the "id": key convention for STORIES_JSON.';
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify([s])}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 1);
  });

  it("inserts nothing when a later story fails field validation (two-phase atomicity)", () => {
    const fx = createPlanLoopRun();
    const stories = [story("US-001"), { id: "US-002" }]; // second story invalid
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /missing required fields/,
    );
    assert.equal(storyCount(fx.runId), 0, "partial validation failure must not leave partial stories");
  });
});

// ── parseAndInsertStories: schema tightening (US-002) ────────────────

describe("parseAndInsertStories (schema tightening)", () => {
  // ── id format ──

  it("accepts valid id formats: US-001, fix-001", () => {
    const fx = createPlanLoopRun();
    const stories = [
      { id: "US-001", title: "A", description: "D", acceptanceCriteria: ["AC1"] },
      { id: "fix-002", title: "B", description: "D", acceptanceCriteria: ["AC1"] },
    ];
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 2);
  });

  it("accepts lowercase prefix ids like fix-001 (case-insensitive)", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "fix-001", title: "A", description: "D", acceptanceCriteria: ["AC1"] }];
    // fix-001 matches ^[A-Z]+-\d+$ case-insensitively (security-audit prioritizers)
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 1);
  });

  it("rejects id format 123-abc (digits then letters)", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "123-abc", title: "A", description: "D", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /invalid id "123-abc"/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("rejects id format with no hyphen", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "US001", title: "A", description: "D", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /invalid id "US001"/,
    );
  });

  it("rejects id format with underscore (snake_case prefix)", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "US_A-1", title: "A", description: "D", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /invalid id "US_A-1"/,
    );
  });

  it("rejects id format 'foo' (plain word, no digits or hyphen)", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "foo", title: "A", description: "D", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /invalid id "foo"/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("rejects id format '123' (digits only, no letters)", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "123", title: "A", description: "D", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /invalid id "123"/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("rejects id format 'foo_bar' (underscore without hyphen)", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "foo_bar", title: "A", description: "D", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /invalid id "foo_bar"/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  // ── title ──

  it("rejects whitespace-only title", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "US-001", title: "   ", description: "D", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /empty or whitespace-only title/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("rejects empty string title", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "US-001", title: "", description: "D", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /empty or whitespace-only title/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("rejects whitespace-only description", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "US-001", title: "A", description: "\n\t ", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /empty or whitespace-only description/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  // ── acceptanceCriteria ──

  it("rejects empty acceptanceCriteria item", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "US-001", title: "A", description: "D", acceptanceCriteria: ["AC1", ""] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /empty or non-string acceptanceCriteria\[1\]/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("rejects whitespace-only acceptanceCriteria item", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "US-001", title: "A", description: "D", acceptanceCriteria: ["  "] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /empty or non-string acceptanceCriteria\[0\]/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  // ── zero stories ──

  it("rejects STORIES_JSON with zero stories", () => {
    const fx = createPlanLoopRun();
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: []\n`, fx.runId),
      /contains zero stories/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  // ── unknown extra fields tolerated ──

  it("tolerates unknown extra fields (e.g. severity, effort)", () => {
    const fx = createPlanLoopRun();
    const stories = [
      {
        id: "US-001",
        title: "A",
        description: "D",
        acceptanceCriteria: ["AC1"],
        severity: "high",
        effort: 5,
      },
    ];
    // Should not throw — unknown fields are tolerated.
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 1);
  });

  // ── existing validation still works ──

  it("still rejects missing required fields (no regression)", () => {
    const fx = createPlanLoopRun();
    const stories = [{ id: "US-002" }]; // missing title, description, acceptanceCriteria
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /missing required fields/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("still rejects duplicate ids (no regression)", () => {
    const fx = createPlanLoopRun();
    const stories = [story("US-001"), story("US-001")];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /duplicate story id "US-001"/,
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("two-phase atomicity still holds with schema rejection", () => {
    const fx = createPlanLoopRun();
    const stories = [story("US-001"), { id: "US-002", title: "   ", description: "D", acceptanceCriteria: ["AC1"] }];
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId),
      /empty or whitespace-only title/,
    );
    assert.equal(storyCount(fx.runId), 0, "first story must not be inserted when second fails validation");
  });
});

// ── completeStep: informed bounded retry, not a throw ────────────────

describe("completeStep STORIES_JSON validation (SJSN retry contract)", () => {
  it("fused payload → retrying: step re-pended with feedback, zero stories, run alive", () => {
    const fx = createPlanLoopRun();
    const claim = claimStep(fx.planAgent, fx.runId);
    assert.ok(claim.found, "plan step must be claimable");

    const result = completeStep(fx.planStepDbId, planOutput(fusedStoriesJson(["US-001", "US-002", "US-003"])));
    assert.equal(result.status, "retrying");
    assert.match(result.detail ?? "", /structural mismatch/);

    const db = getDb();
    const step = db.prepare("SELECT status, retry_count, output FROM steps WHERE id = ?").get(fx.planStepDbId) as
      { status: string; retry_count: number; output: string | null };
    assert.equal(step.status, "pending", "step must be re-pended for an informed retry");
    assert.equal(step.retry_count, 1);
    assert.match(step.output ?? "", /structural mismatch/, "reason must be in output for retry_feedback");

    assert.equal(storyCount(fx.runId), 0);
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(fx.runId) as { status: string };
    assert.equal(run.status, "running", "run must stay alive for the retry");

    // The retried planner must see the structural complaint as RETRY FEEDBACK.
    const retryClaim = claimStep(fx.planAgent, fx.runId);
    assert.ok(retryClaim.found, "step must be re-claimable");
    assert.match(
      retryClaim.resolvedInput ?? "",
      /RETRY FEEDBACK:[\s\S]*structural mismatch[\s\S]*fused/i,
      "retry prompt must carry the structural-mismatch feedback",
    );
  });

  it("corrected payload on retry completes the step and inserts all stories", () => {
    const fx = createPlanLoopRun();
    claimStep(fx.planAgent, fx.runId);
    completeStep(fx.planStepDbId, planOutput(fusedStoriesJson(["US-001", "US-002"])));

    claimStep(fx.planAgent, fx.runId);
    const stories = [story("US-001"), story("US-002")];
    const result = completeStep(fx.planStepDbId, planOutput(JSON.stringify(stories)));
    assert.equal(result.status, "advanced");
    assert.equal(storyCount(fx.runId), 2);

    const db = getDb();
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(fx.planStepDbId) as { status: string };
    assert.equal(step.status, "done");
  });

  it("malformed JSON also takes the informed-retry path instead of throwing", () => {
    const fx = createPlanLoopRun();
    claimStep(fx.planAgent, fx.runId);
    const result = completeStep(fx.planStepDbId, planOutput('[{"id":"US-001" this is not json'));
    assert.equal(result.status, "retrying");
    assert.match(result.detail ?? "", /Failed to parse STORIES_JSON/);
    const step = getDb().prepare("SELECT status, retry_count FROM steps WHERE id = ?").get(fx.planStepDbId) as
      { status: string; retry_count: number };
    assert.equal(step.status, "pending");
    assert.equal(step.retry_count, 1);
  });

  it("validation retries exhaust into a failed run", () => {
    const fx = createPlanLoopRun(1); // max_retries=1 → second failure exhausts
    claimStep(fx.planAgent, fx.runId);
    const first = completeStep(fx.planStepDbId, planOutput(fusedStoriesJson(["US-001", "US-002"])));
    assert.equal(first.status, "retrying");

    claimStep(fx.planAgent, fx.runId);
    const second = completeStep(fx.planStepDbId, planOutput(fusedStoriesJson(["US-001", "US-002"])));
    assert.equal(second.status, "failed");

    const db = getDb();
    const step = db.prepare("SELECT status FROM steps WHERE id = ?").get(fx.planStepDbId) as { status: string };
    const run = db.prepare("SELECT status FROM runs WHERE id = ?").get(fx.runId) as { status: string };
    assert.equal(step.status, "failed");
    assert.equal(run.status, "failed");
  });
});

// ── parseAndInsertStories: scanner integration (US-003) ──────────────

describe("parseAndInsertStories (duplicate-key scanner integration)", () => {
  it("rejects duplicate non-id key (title) with key name and object index", () => {
    const fx = createPlanLoopRun();
    // A single story object with duplicate title key.
    // This is NOT caught by the raw-id-count heuristic (only 1 id key).
    const rawJson = '[{"id":"US-001","title":"First","title":"Second","description":"D","acceptanceCriteria":["AC1"]}]';
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${rawJson}\n`, fx.runId),
      (err: Error) =>
        /duplicate key "title"/.test(err.message) &&
        /story object at index 0/.test(err.message) &&
        /lines/.test(err.message),
    );
    assert.equal(storyCount(fx.runId), 0, "rejected payload must insert zero stories");
  });

  it("rejects fused objects with duplicate id key — includes both heuristic and scanner info", () => {
    const fx = createPlanLoopRun();
    const fused = fusedStoriesJson(["US-001", "US-002", "US-003"]);
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${fused}\n`, fx.runId),
      (err: Error) => {
        const msg = err.message;
        return /structural mismatch/.test(msg) &&
               /3 "id" keys/.test(msg) &&
               /only 1 story/.test(msg) &&
               /duplicate key/.test(msg) &&
               /story object at index 0/.test(msg);
      },
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("rejects fused objects with only non-id duplicates (heuristic blind spot)", () => {
    const fx = createPlanLoopRun();
    // Two stories fused: ids are unique but title repeats.
    // The raw-id-count heuristic sees 2 id keys and 2 parsed stories → passes.
    // The scanner must catch the duplicate title.
    const rawJson = '[{"id":"US-001","title":"T1","description":"D1","acceptanceCriteria":["AC"],"id":"US-002","title":"T1","description":"D2","acceptanceCriteria":["AC"]}]';
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${rawJson}\n`, fx.runId),
      (err: Error) => /duplicate key "title"/.test(err.message),
    );
    assert.equal(storyCount(fx.runId), 0);
  });

  it("accepts well-formed JSON with unique keys (heuristic + scanner both pass)", () => {
    const fx = createPlanLoopRun();
    const stories = [
      story("US-001"),
      story("US-002"),
    ];
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 2);
  });

  it("error message includes scanner line positions", () => {
    const fx = createPlanLoopRun();
    // Two-line JSON so line positions are meaningful.
    const rawJson = '["\\n{\\"id\\":\\"US-001\\",\\"title\\":\\"First\\",\\"title\\":\\"Second\\",\\"description\\":\\"D\\",\\"acceptanceCriteria\\":[\\"AC1\\"]}"\\n]';
    // Simpler: just use a multi-line raw JSON string.
    const multiLine = `[
{"id":"US-001","title":"First","title":"Second","description":"D","acceptanceCriteria":["AC1"]}
]`;
    assert.throws(
      () => parseAndInsertStories(`STORIES_JSON: ${multiLine}\n`, fx.runId),
      (err: Error) => {
        const msg = err.message;
        return /duplicate key "title"/.test(msg) &&
               /lines/.test(msg);
      },
    );
  });

  it("scanner does not false-positive on descriptions with quoted key mentions", () => {
    const fx = createPlanLoopRun();
    // Description talks about the "id" key — should pass both heuristic and scanner.
    const s = story("US-001");
    s.description = 'The JSON key known as \\"id\\" must be unique.';
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify([s])}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 1);
  });

  it("accepts stories with deeply nested structures in description field", () => {
    const fx = createPlanLoopRun();
    // The scanner must correctly track object depth through deeply nested braces
    // inside string values without false-positives. Test multiple stories with
    // descriptions containing complex escaped content, multi-level brace nesting,
    // and backslash-escape sequences the scanner must navigate character by char.
    const stories = [
      {
        id: "US-001",
        title: "Deep Nesting Story 1",
        description:
          'The nested config {"settings":{"mode":"strict","options":{"retry":true,"timeout":30}}} ' +
          'must be applied before {"step":"validation","rules":[{"type":"lint"}]} runs.',
        acceptanceCriteria: [
          "The system handles nested configs with embedded JSON-like fragments",
          "Brace tracking correctly skips string content at depth 4+",
        ],
      },
      {
        id: "US-002",
        title: "Deep Nesting Story 2",
        description:
          'Template syntax: {{story.title}} and {{nested.config.options.timeout}}. ' +
          'Escape test: C:\\\\path\\\\to\\\\file with backslash runs.',
        acceptanceCriteria: [
          "Scanner handles double-backslash escape sequences in strings",
          "Brace-like template syntax does not confuse depth tracking",
        ],
      },
      {
        id: "US-003",
        title: "Deep Nesting Story 3",
        description: 'Plain story with standard description — {} braces in prose.',
        acceptanceCriteria: [
          "Basic AC for counting — ensures multi-story parse is correct",
        ],
      },
    ];
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify(stories)}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 3);
  });

  it("scanner does not false-positive on escaped-quote torture case", () => {
    const fx = createPlanLoopRun();
    // A description with multiple layers of escaped quotes, braces, and key-like
    // strings interleaved in prose — the scanner must handle all correctly.
    const s = {
      id: "US-001",
      title: "Torture Test",
      description:
        'This story covers the \\"id\\" and \\"title\\" keys. ' +
        'The format \\"id\\": \\"US-001\\" must be followed. ' +
        'Nested braces like { \\"nested\\": true } appear in prose. ' +
        'Double escapes: \\\\\\"id\\\\\\" for code examples.',
      acceptanceCriteria: [
        'Ensure the \\"id\\" key is unique per story',
        'Validate that \\"title\\" and \\"description\\" are non-empty',
      ],
    };
    parseAndInsertStories(`STORIES_JSON: ${JSON.stringify([s])}\n`, fx.runId);
    assert.equal(storyCount(fx.runId), 1);
  });
});

// ── completeStep: scanner detail in step.retry (US-003) ──────────────

describe("completeStep scanner detail in step.retry", () => {
  it("step.retry event detail contains duplicate-key error shape", () => {
    const fx = createPlanLoopRun();
    claimStep(fx.planAgent, fx.runId);

    // A fused payload with a non-id duplicate that only the scanner catches.
    const rawJson = '[{"id":"US-001","title":"A","description":"D1","title":"B","description":"D2","acceptanceCriteria":["AC"]}]';
    const result = completeStep(fx.planStepDbId, planOutput(rawJson));
    assert.equal(result.status, "retrying");

    // The step output (retry_feedback) must contain scanner details.
    const db = getDb();
    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(fx.planStepDbId) as { output: string | null };
    assert.ok(step.output, "step output must be set for retry feedback");
    assert.match(step.output!, /duplicate key "title"/);
    assert.match(step.output!, /story object at index 0/);

    // On retry, the planner gets the scanner detail as retry_feedback.
    const retryClaim = claimStep(fx.planAgent, fx.runId);
    assert.ok(retryClaim.found);
    assert.match(
      retryClaim.resolvedInput ?? "",
      /RETRY FEEDBACK:[\s\S]*duplicate key "title"/i,
      "retry prompt must carry scanner-detected duplicate-key info",
    );
  });

  it("step.retry detail includes both heuristic and scanner info for fused id", () => {
    const fx = createPlanLoopRun();
    claimStep(fx.planAgent, fx.runId);

    const fused = fusedStoriesJson(["US-001", "US-002"]);
    const result = completeStep(fx.planStepDbId, planOutput(fused));
    assert.equal(result.status, "retrying");

    const db = getDb();
    const step = db.prepare("SELECT output FROM steps WHERE id = ?").get(fx.planStepDbId) as { output: string | null };
    assert.ok(step.output);
    assert.match(step.output!, /structural mismatch/);
    assert.match(step.output!, /duplicate key/);
  });
});
});
