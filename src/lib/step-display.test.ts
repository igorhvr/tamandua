import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { displayStepStatus, displayStoryStatus } from "../../dist/lib/step-display.js";
import type { StepDisplayInput, StoryDisplayInput } from "../../dist/lib/step-display.js";

describe("displayStepStatus", () => {
  describe("parked loop (type=loop, status=running, currentStoryId=null)", () => {
    it("returns verifying", () => {
      const input: StepDisplayInput = {
        type: "loop",
        status: "running",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "verifying");
    });
  });

  describe("active loop (type=loop, status=running, currentStoryId set)", () => {
    it("returns running", () => {
      const input: StepDisplayInput = {
        type: "loop",
        status: "running",
        currentStoryId: "US-001",
      };
      assert.strictEqual(displayStepStatus(input), "running");
    });

    it("returns running for any non-null currentStoryId", () => {
      const input: StepDisplayInput = {
        type: "loop",
        status: "running",
        currentStoryId: "US-042",
      };
      assert.strictEqual(displayStepStatus(input), "running");
    });
  });

  describe("loop with non-running status", () => {
    it("returns done unchanged", () => {
      const input: StepDisplayInput = {
        type: "loop",
        status: "done",
        currentStoryId: "US-001",
      };
      assert.strictEqual(displayStepStatus(input), "done");
    });

    it("returns done unchanged even with null currentStoryId", () => {
      const input: StepDisplayInput = {
        type: "loop",
        status: "done",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "done");
    });

    it("returns failed unchanged", () => {
      const input: StepDisplayInput = {
        type: "loop",
        status: "failed",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "failed");
    });

    it("returns waiting unchanged", () => {
      const input: StepDisplayInput = {
        type: "loop",
        status: "waiting",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "waiting");
    });

    it("returns pending unchanged", () => {
      const input: StepDisplayInput = {
        type: "loop",
        status: "pending",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "pending");
    });
  });

  describe("single step (type != loop)", () => {
    it("returns running unchanged for single step type=single", () => {
      const input: StepDisplayInput = {
        type: "single",
        status: "running",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "running");
    });

    it("returns done unchanged for single step", () => {
      const input: StepDisplayInput = {
        type: "single",
        status: "done",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "done");
    });

    it("returns failed unchanged for single step", () => {
      const input: StepDisplayInput = {
        type: "single",
        status: "failed",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "failed");
    });

    it("returns pending unchanged for single step", () => {
      const input: StepDisplayInput = {
        type: "single",
        status: "pending",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "pending");
    });

    it("returns waiting unchanged for single step", () => {
      const input: StepDisplayInput = {
        type: "single",
        status: "waiting",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "waiting");
    });

    it("returns raw status for any type other than loop", () => {
      const input: StepDisplayInput = {
        type: "custom_type",
        status: "running",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "running");
    });
  });

  describe("edge cases", () => {
    it("handles empty string status", () => {
      const input: StepDisplayInput = {
        type: "loop",
        status: "",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "");
    });

    it("handles empty string type", () => {
      const input: StepDisplayInput = {
        type: "",
        status: "running",
        currentStoryId: null,
      };
      assert.strictEqual(displayStepStatus(input), "running");
    });

    it("handles undefined-like empty string currentStoryId", () => {
      // Empty string is not null, so it won't trigger the parked-loop rule
      const input: StepDisplayInput = {
        type: "loop",
        status: "running",
        currentStoryId: "",
      };
      assert.strictEqual(displayStepStatus(input), "running");
    });
  });
});

describe("displayStoryStatus (YSE US-005)", () => {
  describe("pending story reset on resume (resumeResetCount > 0)", () => {
    it("returns the annotated label for 1 prior failure (singular)", () => {
      const input: StoryDisplayInput = { status: "pending", resumeResetCount: 1 };
      assert.strictEqual(displayStoryStatus(input), "pending (reset on resume, 1 prior failure)");
    });

    it("returns the annotated label for 2 prior failures (plural)", () => {
      const input: StoryDisplayInput = { status: "pending", resumeResetCount: 2 };
      assert.strictEqual(displayStoryStatus(input), "pending (reset on resume, 2 prior failures)");
    });

    it("matches the operator-facing annotation shape", () => {
      const input: StoryDisplayInput = { status: "pending", resumeResetCount: 1 };
      assert.match(displayStoryStatus(input), /reset on resume, 1 prior failure/);
    });
  });

  describe("story never reset on resume (resumeResetCount 0 / absent)", () => {
    it("returns plain pending for resumeResetCount 0", () => {
      const input: StoryDisplayInput = { status: "pending", resumeResetCount: 0 };
      assert.strictEqual(displayStoryStatus(input), "pending");
    });

    it("returns plain pending when resumeResetCount is absent", () => {
      const input: StoryDisplayInput = { status: "pending" };
      assert.strictEqual(displayStoryStatus(input), "pending");
    });

    it("returns raw status for other statuses even with resumeResetCount > 0", () => {
      // The stored status is NEVER changed — only pending stories that a
      // resume re-queued get the annotation label.
      assert.strictEqual(displayStoryStatus({ status: "done", resumeResetCount: 1 }), "done");
      assert.strictEqual(displayStoryStatus({ status: "running", resumeResetCount: 1 }), "running");
      assert.strictEqual(displayStoryStatus({ status: "failed", resumeResetCount: 1 }), "failed");
    });
  });
});
