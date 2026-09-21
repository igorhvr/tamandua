/**
 * UNION-FINAL US-007: union seam reconciliation regression for step-ops.
 *
 * The union-port (MTLK-PROGRESS) threaded an opt-in `RunProgressAccessLike`
 * host progress accessor through step-ops so a Matchlock round can serve
 * progress reads/writes/archives through the confined host query seam, while
 * native callers omit it and keep the byte-identical host-path behavior. This
 * file pins that seam plus the pure story-plan rendering it relies on, so a
 * later reconciliation cannot silently drop the union behavior.
 *
 * This module imports step-ops.ts (which imports node:child_process), so it is
 * registered in tests/serial-files.txt and runs in the serial lane.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildStoryPlanSection,
  mergeStoryPlanIntoProgress,
  parseRunContext,
  readProgressFile,
  sanitizeStderrTail,
  type RunProgressAccessLike,
} from "../../dist/installer/step-ops.js";

describe("UNION-FINAL US-007 step-ops union seam", () => {
  it("readProgressFile routes an opted-in accessor through the confined seam and never the host path", () => {
    let reads = 0;
    const access: RunProgressAccessLike = {
      guestFile: "/workspace/runs/run-123/progress.txt",
      readText: () => {
        reads += 1;
        return "## Codebase Patterns\n- union seam\n";
      },
      commitText: () => {
        throw new Error("commitText must not be called by a read");
      },
      updateText: () => {
        throw new Error("updateText must not be called by a read");
      },
      archiveTo: () => {
        throw new Error("archiveTo must not be called by a read");
      },
    };
    assert.equal(readProgressFile("run-123", access), "## Codebase Patterns\n- union seam\n");
    assert.equal(reads, 1, "the confined accessor is the only read path when opted in");
  });

  it("readProgressFile returns the placeholder when the opted-in accessor has no document", () => {
    const access: RunProgressAccessLike = {
      guestFile: "/workspace/runs/run-123/progress.txt",
      readText: () => null,
      commitText: () => {},
      updateText: () => "",
      archiveTo: () => "",
    };
    assert.equal(readProgressFile("run-123", access), "(no progress file)");
  });

  it("buildStoryPlanSection + mergeStoryPlanIntoProgress round-trip the plan without dropping Codebase Patterns", () => {
    const section = buildStoryPlanSection([
      {
        storyId: "US-001",
        title: "Seam",
        description: "Reconcile the union seam",
        acceptanceCriteria: ["a", "b"],
      },
    ]);
    assert.match(section, /^## Story Plan/);

    const merged = mergeStoryPlanIntoProgress(
      "# Progress Log\n\n## Codebase Patterns\n- keep me\n",
      section,
    );
    assert.match(merged, /## Codebase Patterns/);
    assert.match(merged, /### US-001: Seam/);

    // Replacing the plan is idempotent: exactly one Story Plan section remains.
    const twice = mergeStoryPlanIntoProgress(merged, section);
    assert.equal(twice.split("## Story Plan").length - 1, 1);
    assert.match(twice, /## Codebase Patterns/);
  });

  it("parseRunContext passes a valid context through unchanged (union WORKDIR keys included)", () => {
    assert.deepEqual(
      parseRunContext("run-1", JSON.stringify({ workdir_collision: "share", custom: "b" })),
      { workdir_collision: "share", custom: "b" },
    );
  });

  it("sanitizeStderrTail bounds the tail as required by the union outage-class evidence", () => {
    const tail = sanitizeStderrTail("x".repeat(50_000), 1024);
    assert.ok(tail.length <= 1024, `tail must be bounded, got ${tail.length}`);
  });
});
