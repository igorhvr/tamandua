import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { displayStepStatus } from "../../dist/lib/step-display.js";
import type { StepDisplayInput } from "../../dist/lib/step-display.js";

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
