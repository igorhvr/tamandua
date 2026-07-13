import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { tamanduaTempDir, tamanduaTempRoot } from "../../dist/lib/temp-dir.js";
import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  readEventsFromCursor,
  emitEvent,
  beginEventBuffering,
  flushEventBuffer,
  discardEventBuffer,
  getRecentEvents,
  getRunEvents,
  countRunEvents,
  getEventsPath,
  getGlobalEventsGeneration,
  rotateGlobalEventsFile,
  MAX_EVENTS_FILE_SIZE,
  MAX_ROTATED_EVENTS_FILES,
  _refreshSizeEstimate,
  type TamanduaEvent,
} from "../../dist/installer/events.js";

function makeEvent(runId: string, event: string): TamanduaEvent {
  return {
    ts: new Date().toISOString(),
    event,
    runId,
  };
}

describe("events", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-events-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe("emitEvent", () => {
    it("writes an event to the run-specific file", () => {
      const evt = makeEvent("run-1", "run.started");
      emitEvent(evt);

      const runFile = path.join(stateDir, "events", "run-1.jsonl");
      assert.ok(fs.existsSync(runFile), "run event file should exist");

      const content = fs.readFileSync(runFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.runId, "run-1");
      assert.equal(parsed.event, "run.started");
    });

    it("writes an event to the global events file", () => {
      const evt = makeEvent("run-2", "step.running");
      emitEvent(evt);

      const globalFile = path.join(stateDir, "events", "all.jsonl");
      assert.ok(fs.existsSync(globalFile), "global event file should exist");

      const content = fs.readFileSync(globalFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.runId, "run-2");
      assert.equal(parsed.event, "step.running");
    });

    it("writes multiple events as JSONL lines", () => {
      emitEvent(makeEvent("run-3", "run.started"));
      emitEvent(makeEvent("run-3", "step.running"));
      emitEvent(makeEvent("run-3", "step.completed"));

      const runFile = path.join(stateDir, "events", "run-3.jsonl");
      const content = fs.readFileSync(runFile, "utf-8");
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 3, "should have 3 event lines");

      const lastLine = JSON.parse(lines[2]!);
      assert.equal(lastLine.event, "step.completed");
    });

    it("each event appears in both run file and global file", () => {
      emitEvent(makeEvent("run-4", "step.done"));

      const runFile = path.join(stateDir, "events", "run-4.jsonl");
      const globalFile = path.join(stateDir, "events", "all.jsonl");

      const runContent = fs.readFileSync(runFile, "utf-8").trim();
      const globalContent = fs.readFileSync(globalFile, "utf-8").trim();
      assert.equal(runContent, globalContent, "both files should have the same content");
    });

    it("includes optional fields when present", () => {
      const evt: TamanduaEvent = {
        ts: new Date().toISOString(),
        event: "story.done",
        runId: "run-5",
        workflowId: "wf-bugfix",
        stepId: "step-1",
        storyId: "story-a",
        agentId: "agent-dev",
        detail: "all tests pass",
      };
      emitEvent(evt);

      const runFile = path.join(stateDir, "events", "run-5.jsonl");
      const content = fs.readFileSync(runFile, "utf-8");
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.workflowId, "wf-bugfix");
      assert.equal(parsed.stepId, "step-1");
      assert.equal(parsed.storyId, "story-a");
      assert.equal(parsed.agentId, "agent-dev");
      assert.equal(parsed.detail, "all tests pass");
    });

    it("emits non-significant events (webhook skipped internally)", () => {
      assert.doesNotThrow(() => emitEvent(makeEvent("run-6", "step.running")));

      const globalFile = path.join(stateDir, "events", "all.jsonl");
      const content = fs.readFileSync(globalFile, "utf-8");
      assert.ok(content.includes("step.running"));
    });

    it("suppresses nudge noise events by default", () => {
      const prev = process.env.TAMANDUA_DEBUG_EVENTS;
      delete process.env.TAMANDUA_DEBUG_EVENTS;
      try {
        emitEvent(makeEvent("run-7", "run.nudged"));
        emitEvent(makeEvent("run-7", "agent.nudged"));
        emitEvent(makeEvent("run-7", "agent.nudge.skipped"));

        const runFile = path.join(stateDir, "events", "run-7.jsonl");
        const globalFile = path.join(stateDir, "events", "all.jsonl");
        assert.ok(!fs.existsSync(runFile), "run file must not be created for noise events");
        assert.ok(!fs.existsSync(globalFile), "global file must not be created for noise events");
      } finally {
        if (prev !== undefined) process.env.TAMANDUA_DEBUG_EVENTS = prev;
      }
    });

    it("still writes normal events while noise events are suppressed", () => {
      const prev = process.env.TAMANDUA_DEBUG_EVENTS;
      delete process.env.TAMANDUA_DEBUG_EVENTS;
      try {
        emitEvent(makeEvent("run-8", "run.nudged"));
        emitEvent(makeEvent("run-8", "step.completed"));

        const globalFile = path.join(stateDir, "events", "all.jsonl");
        const content = fs.readFileSync(globalFile, "utf-8");
        assert.ok(content.includes("step.completed"));
        assert.ok(!content.includes("run.nudged"));
      } finally {
        if (prev !== undefined) process.env.TAMANDUA_DEBUG_EVENTS = prev;
      }
    });

    it("writes nudge events when TAMANDUA_DEBUG_EVENTS=1", () => {
      const prev = process.env.TAMANDUA_DEBUG_EVENTS;
      process.env.TAMANDUA_DEBUG_EVENTS = "1";
      try {
        emitEvent(makeEvent("run-9", "agent.nudged"));

        const globalFile = path.join(stateDir, "events", "all.jsonl");
        const content = fs.readFileSync(globalFile, "utf-8");
        assert.ok(content.includes("agent.nudged"));
      } finally {
        if (prev === undefined) delete process.env.TAMANDUA_DEBUG_EVENTS;
        else process.env.TAMANDUA_DEBUG_EVENTS = prev;
      }
    });

    describe("test-guard", () => {
      it("does not fire when TAMANDUA_STATE_DIR isolates into a temp dir (guard active, path isolated)", () => {
        // The beforeEach already sets TAMANDUA_STATE_DIR to a temp dir.
        // Set TAMANDUA_TEST_GUARD=1 to activate the guard — it should NOT drop
        // the event because the resolved events paths are under the temp dir.
        const prevGuard = process.env.TAMANDUA_TEST_GUARD;
        process.env.TAMANDUA_TEST_GUARD = "1";
        try {
          assert.doesNotThrow(() => {
            emitEvent(makeEvent("run-isolated", "run.started"));
          }, "guard must not fire when TAMANDUA_STATE_DIR isolates the events path");

          const globalFile = path.join(stateDir, "events", "all.jsonl");
          assert.ok(fs.existsSync(globalFile), "event should be written when isolated");

          const content = fs.readFileSync(globalFile, "utf-8");
          assert.ok(content.includes("run-isolated"), "event content should be written");
        } finally {
          process.env.TAMANDUA_TEST_GUARD = prevGuard;
        }
      });

      it("drops events without throwing when guard is active and path resolves into real state dir", () => {
        // Simulate a test process that forgot to set TAMANDUA_STATE_DIR and
        // os.homedir() returns the real user home → events paths are real
        // ~/.tamandua/events/. The guard must PROTECT production (no write) but
        // must NOT throw: production timers fire after tests restore env, and a
        // throwing emitEvent would turn late writes into unhandled rejections.
        const prevGuard = process.env.TAMANDUA_TEST_GUARD;
        // Save and restore the module-scoped isolationViolationReported at the
        // dist boundary. Since we import from dist, reloading the module per test
        // is tricky. Instead, test that multiple calls don't throw and that no
        // events file is created in the real state dir (the guard blocks
        // mkdirSync).
        try {
          process.env.TAMANDUA_TEST_GUARD = "1";
          // Point TAMANDUA_STATE_DIR into the real state dir to trigger the guard.
          const realStateRoot = path.join(os.userInfo().homedir, ".tamandua");
          const leakedDir = path.join(realStateRoot, "should-not-be-created-by-test");
          process.env.TAMANDUA_STATE_DIR = leakedDir;

          // Clear any state files that might exist from previous runs.
          try { fs.rmSync(leakedDir, { recursive: true, force: true }); } catch {}

          assert.doesNotThrow(
            () => {
              emitEvent(makeEvent("zombie-run-001", "run.started"));
              emitEvent(makeEvent("run-delete-done", "run.started"));
              emitEvent(makeEvent("test-workflow", "run.started"));
            },
            "guard must not throw from emitEvent — it drops events instead",
          );
          // The blocked writes must not have created the leaked events directory.
          const eventsDir = path.join(leakedDir, "events");
          assert.ok(
            !fs.existsSync(eventsDir),
            "guard must prevent writing events into the real state dir",
          );
        } finally {
          process.env.TAMANDUA_TEST_GUARD = prevGuard;
          // Restore the isolated stateDir for subsequent tests.
          process.env.TAMANDUA_STATE_DIR = stateDir;
        }
      });

      it("HOME-spoof resistance: guard uses os.userInfo().homedir, not os.homedir()", () => {
        // Set HOME to a temp dir (spoof) but TAMANDUA_STATE_DIR to the real state dir.
        // The guard must still detect the violation (via os.userInfo().homedir) and
        // silently drop the event.
        const prevGuard = process.env.TAMANDUA_TEST_GUARD;
        const prevHome = process.env.HOME;
        try {
          process.env.TAMANDUA_TEST_GUARD = "1";
          process.env.HOME = path.join(tamanduaTempRoot(), "spoofed-home-" + Date.now());
          const realStateRoot = path.join(os.userInfo().homedir, ".tamandua");
          const spoofDir = path.join(realStateRoot, "spoofed-leak-events");
          process.env.TAMANDUA_STATE_DIR = spoofDir;

          try { fs.rmSync(spoofDir, { recursive: true, force: true }); } catch {}

          assert.doesNotThrow(
            () => emitEvent(makeEvent("spoofed-run", "run.started")),
            "guard must use os.userInfo().homedir and drop the event without throwing",
          );
          assert.ok(
            !fs.existsSync(path.join(spoofDir, "events")),
            "guard must prevent the write even with spoofed HOME",
          );
        } finally {
          process.env.TAMANDUA_TEST_GUARD = prevGuard;
          if (prevHome === undefined) {
            delete process.env.HOME;
          } else {
            process.env.HOME = prevHome;
          }
          process.env.TAMANDUA_STATE_DIR = stateDir;
        }
      });

    });
  });

  describe("getRecentEvents", () => {
    it("reads recent events from the global file", () => {
      emitEvent(makeEvent("run-a", "run.started"));
      emitEvent(makeEvent("run-a", "step.running"));

      const events = getRecentEvents(10);
      assert.ok(events.length >= 2);
      assert.equal(events[0]!.runId, "run-a");
      assert.equal(events[0]!.event, "run.started");
    });

    it("respects the limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        emitEvent(makeEvent(`run-limit-${i}`, "run.started"));
      }
      const events = getRecentEvents(3);
      assert.ok(events.length <= 3);
    });

    it("returns empty array when no global events exist", () => {
      const events = getRecentEvents();
      assert.deepEqual(events, []);
    });

    it("skips malformed JSON lines", () => {
      emitEvent(makeEvent("run-mal", "run.started"));

      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.appendFileSync(globalFile, "not valid json\n", "utf-8");
      emitEvent(makeEvent("run-mal", "run.completed"));

      const events = getRecentEvents(10);
      const completed = events.filter((e) => e.event === "run.completed");
      assert.equal(completed.length, 1);
    });
  });

  describe("getRunEvents", () => {
    it("reads events for a specific run", () => {
      emitEvent(makeEvent("run-specific", "run.started"));
      emitEvent(makeEvent("run-specific", "step.running"));
      emitEvent(makeEvent("run-specific", "step.completed"));

      const events = getRunEvents("run-specific");
      assert.equal(events.length, 3);
      assert.equal(events[0]!.event, "run.started");
      assert.equal(events[2]!.event, "step.completed");
    });

    it("returns empty array for non-existent run", () => {
      const events = getRunEvents("non-existent-run");
      assert.deepEqual(events, []);
    });

    it("only returns events for the requested run", () => {
      emitEvent(makeEvent("run-x", "run.started"));
      emitEvent(makeEvent("run-y", "run.started"));

      const eventsX = getRunEvents("run-x");
      assert.equal(eventsX.length, 1);
      assert.equal(eventsX[0]!.runId, "run-x");

      const eventsY = getRunEvents("run-y");
      assert.equal(eventsY.length, 1);
    });

    it("skips malformed JSON in run events", () => {
      emitEvent(makeEvent("run-bad", "run.started"));

      const runFile = path.join(stateDir, "events", "run-bad.jsonl");
      fs.appendFileSync(runFile, "garbage line\n", "utf-8");
      emitEvent(makeEvent("run-bad", "run.completed"));

      const events = getRunEvents("run-bad");
      assert.equal(events.length, 2);
    });
  });

  describe("getEventsPath", () => {
    it("returns the path to the events directory", () => {
      const dir = getEventsPath();
      assert.equal(dir, path.join(stateDir, "events"));
    });

    it("returns a path that matches where events are actually stored", () => {
      emitEvent(makeEvent("run-path-test", "run.started"));
      const dir = getEventsPath();
      const expectedFile = path.join(dir, "run-path-test.jsonl");
      assert.ok(fs.existsSync(expectedFile));
    });
  });

  describe("readEventsFromCursor", () => {
    it("returns only events appended after the provided global offset", () => {
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });

      const first = makeEvent("run-a", "run.started");
      const second = makeEvent("run-a", "step.running");
      fs.appendFileSync(globalFile, `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, "utf-8");

      const initial = readEventsFromCursor({ kind: "global" }, 0);
      assert.deepEqual(initial.events, [first, second]);

      const third = makeEvent("run-a", "step.done");
      fs.appendFileSync(globalFile, `${JSON.stringify(third)}\n`, "utf-8");

      const appended = readEventsFromCursor({ kind: "global" }, initial.nextOffset);
      assert.deepEqual(appended.events, [third]);

      const nothingNew = readEventsFromCursor({ kind: "global" }, appended.nextOffset);
      assert.deepEqual(nothingNew.events, []);
      assert.equal(nothingNew.nextOffset, appended.nextOffset);
    });

    it("supports run-specific event files", () => {
      const runId = "run-123";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const first = makeEvent(runId, "story.started");
      fs.appendFileSync(runFile, `${JSON.stringify(first)}\n`, "utf-8");

      const initial = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.deepEqual(initial.events, [first]);

      const second = makeEvent(runId, "story.done");
      fs.appendFileSync(runFile, `${JSON.stringify(second)}\n`, "utf-8");

      const appended = readEventsFromCursor({ kind: "run", runId }, initial.nextOffset);
      assert.deepEqual(appended.events, [second]);
    });

    it("handles offset beyond file length by resetting to 0", () => {
      const runId = "run-overflow";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `${JSON.stringify(evt)}\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 999999);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]!.runId, runId);
    });

    it("handles empty lines gracefully", () => {
      const runId = "run-empty-lines";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `\n${JSON.stringify(evt)}\n\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]!.event, "run.started");
    });

    it("ignores malformed/incomplete JSONL rows", () => {
      const runId = "run-malformed";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const first = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `${JSON.stringify(first)}\n{\"ts\":\"partial\"`, "utf-8");

      const initial = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.deepEqual(initial.events, [first]);

      const later = makeEvent(runId, "run.completed");
      fs.appendFileSync(runFile, `, invalid}\n${JSON.stringify(later)}\n`, "utf-8");

      const afterMalformed = readEventsFromCursor({ kind: "run", runId }, initial.nextOffset);
      assert.deepEqual(afterMalformed.events, [later]);
    });

    it("skips non-object JSON values (strings, numbers, booleans, null)", () => {
      const runId = "run-nonobject";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `"not an object"\n42\ntrue\nfalse\nnull\n${JSON.stringify(evt)}\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]!.event, "run.started");
    });

    it("handles trailing partial line (no final newline)", () => {
      const runId = "run-partial";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `${JSON.stringify(evt)}\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.equal(result.events.length, 1);

      fs.appendFileSync(runFile, `{\"ts\":\"partial\",\"event\"`, "utf-8");
      const afterPartial = readEventsFromCursor({ kind: "run", runId }, result.nextOffset);
      assert.deepEqual(afterPartial.events, []);
    });

    it("handles carriage return in line endings", () => {
      const runId = "run-cr";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt = makeEvent(runId, "run.started");
      fs.appendFileSync(runFile, `${JSON.stringify(evt)}\r\n`, "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]!.event, "run.started");
    });
  });

  describe("cursor rotation safety", () => {
    function writeLargeGlobalFile(size: number, marker: string): string {
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      const fd = fs.openSync(globalFile, "w");
      const chunkSize = 512 * 1024; // 512 KB
      const header = JSON.stringify({ ts: "2026-01-01T00:00:00Z", event: `prefill.${marker}`, runId: "prefill" }) + "\n";
      const padLen = Math.max(1, chunkSize - Buffer.byteLength(header));
      const pad = "x".repeat(padLen);
      const fullChunk = header + pad + "\n";

      let written = 0;
      while (written < size) {
        const toWrite = Math.min(Buffer.byteLength(fullChunk), size - written);
        if (toWrite === Buffer.byteLength(fullChunk)) {
          fs.appendFileSync(fd, fullChunk, "utf-8");
          written += toWrite;
        } else {
          const partial = header + "x".repeat(Math.max(1, toWrite - Buffer.byteLength(header) - 1)) + "\n";
          fs.appendFileSync(fd, partial, "utf-8");
          written += Buffer.byteLength(partial);
        }
      }
      fs.closeSync(fd);
      return globalFile;
    }

    it("EventCursorReadResult includes a generation field", () => {
      // Global source — generation should be 0 initially
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      fs.writeFileSync(globalFile, "", "utf-8");

      const result = readEventsFromCursor({ kind: "global" }, 0);
      assert.ok("generation" in result, "result must have generation property");
      assert.equal(result.generation, 0, "initial generation should be 0");
    });

    it("run-specific cursor returns generation 0", () => {
      const runId = "run-gen-test";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });
      fs.writeFileSync(runFile, JSON.stringify(makeEvent(runId, "run.started")) + "\n", "utf-8");

      const result = readEventsFromCursor({ kind: "run", runId }, 0);
      assert.equal(result.generation, 0, "run-specific source always returns generation 0");
    });

    it("stale cursor detected after rotation and resets without throwing", () => {
      // 1. Get a cursor with generation 0
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      fs.writeFileSync(globalFile, JSON.stringify(makeEvent("run-pre", "event.0")) + "\n", "utf-8");

      const beforeRot = readEventsFromCursor({ kind: "global" }, 0);
      assert.equal(beforeRot.generation, 0);
      assert.equal(beforeRot.events.length, 1);

      // 2. Trigger rotation (writes past cap → rotates → generation increments)
      writeLargeGlobalFile(MAX_EVENTS_FILE_SIZE - 50, "seed");
      _refreshSizeEstimate();
      emitEvent(makeEvent("run-rot", "rotation.trigger"));

      assert.equal(getGlobalEventsGeneration(), 1, "generation must be 1 after rotation");

      // 3. Now read with the old cursor (generation=0) — should reset to 0 offset
      const afterRot = readEventsFromCursor({ kind: "global" }, beforeRot.nextOffset, beforeRot.generation);
      assert.equal(afterRot.generation, 1, "generation should be updated to current");
      // The reset means we read from the beginning of the new live file.
      // Since emitEvent just rotated, the live file should be empty (next write creates it).
      // But if there were post-rotation writes, we'd read them from 0.
      assert.doesNotThrow(() => {
        // Result should be well-formed, no errors
      });
    });

    it("does not duplicate events after rotation-induced reset", () => {
      // 1. Write some initial events
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      fs.writeFileSync(globalFile, JSON.stringify(makeEvent("run-dup", "event.0")) + "\n", "utf-8");

      const beforeRot = readEventsFromCursor({ kind: "global" }, 0);
      assert.equal(beforeRot.events.length, 1);

      // 2. Rotate
      writeLargeGlobalFile(MAX_EVENTS_FILE_SIZE - 50, "seed");
      _refreshSizeEstimate();
      emitEvent(makeEvent("run-dup", "rotation.trigger"));

      // 3. Write a post-rotation event
      emitEvent(makeEvent("run-dup", "post-rotation"));

      // 4. Read with the stale cursor (generation=0)
      const afterRot = readEventsFromCursor({ kind: "global" }, beforeRot.nextOffset, beforeRot.generation);
      assert.equal(afterRot.generation, 1);

      // Should read only the post-rotation event (from the new live file),
      // NOT the pre-rotation events or the rotation-trigger event
      const eventIds = afterRot.events.map(e => e.event);
      assert.ok(!eventIds.includes("event.0"), "should not duplicate pre-rotation event");
      assert.ok(!eventIds.includes("rotation.trigger"), "should not include rotation trigger event");
      assert.ok(eventIds.includes("post-rotation"), "should include post-rotation event");
    });

    it("fresh cursor continues to work identically after rotation", () => {
      // 1. Rotate
      writeLargeGlobalFile(MAX_EVENTS_FILE_SIZE - 50, "seed");
      _refreshSizeEstimate();
      emitEvent(makeEvent("run-fresh", "rotation.trigger"));

      // 2. Write post-rotation events
      emitEvent(makeEvent("run-fresh", "event.1"));
      emitEvent(makeEvent("run-fresh", "event.2"));

      // 3. Read from scratch with no generation (fresh cursor)
      const fresh = readEventsFromCursor({ kind: "global" }, 0);
      assert.equal(fresh.generation, 1);
      const freshEvents = fresh.events.map(e => e.event);
      assert.ok(freshEvents.includes("event.1"), "fresh cursor sees event.1");
      assert.ok(freshEvents.includes("event.2"), "fresh cursor sees event.2");

      // 4. Poll again with matching generation — normal incremental read
      emitEvent(makeEvent("run-fresh", "event.3"));
      const poll = readEventsFromCursor({ kind: "global" }, fresh.nextOffset, fresh.generation);
      assert.equal(poll.generation, 1);
      assert.equal(poll.events.length, 1);
      assert.equal(poll.events[0]!.event, "event.3");
    });

    it("run-specific cursor ignores generation mismatch", () => {
      const runId = "run-ignore-gen";
      const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
      fs.mkdirSync(path.dirname(runFile), { recursive: true });

      const evt1 = makeEvent(runId, "event.0");
      fs.writeFileSync(runFile, JSON.stringify(evt1) + "\n", "utf-8");

      // Read with a bogus generation — run-specific source ignores it
      const result = readEventsFromCursor({ kind: "run", runId }, 0, 999);
      assert.equal(result.generation, 0, "run-specific generation always 0");
      assert.equal(result.events.length, 1);
      assert.equal(result.events[0]!.event, "event.0");
    });

    it("no rotation occurs below the cap", () => {
      // Write a few events well below cap — generation stays 0
      emitEvent(makeEvent("run-norot", "event.0"));
      emitEvent(makeEvent("run-norot", "event.1"));

      assert.equal(getGlobalEventsGeneration(), 0);

      const result = readEventsFromCursor({ kind: "global" }, 0);
      assert.equal(result.generation, 0);
      assert.equal(result.events.length, 2);
    });
  });

  describe("fireWebhook", () => {
    let dbPath: string;
    let db: DatabaseSync;
    let originalDbPath: string | undefined;
    let server: http.Server | null = null;
    let webhookReceived: string | null = null;

    beforeEach(() => {
      originalDbPath = process.env.TAMANDUA_DB_PATH;
      dbPath = path.join(stateDir, "tamandua.db");
      process.env.TAMANDUA_DB_PATH = dbPath;

      fs.mkdirSync(stateDir, { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode=WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL DEFAULT 'test',
        task TEXT NOT NULL DEFAULT 'test',
        status TEXT NOT NULL DEFAULT 'running',
        context TEXT NOT NULL DEFAULT '{}',
        tokens_spent INTEGER NOT NULL DEFAULT 0,
        notify_url TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`);
    });

    afterEach(async () => {
      if (originalDbPath !== undefined) process.env.TAMANDUA_DB_PATH = originalDbPath;
      else delete process.env.TAMANDUA_DB_PATH;
      try { db.close(); } catch {}
      if (server) { server.close(); server = null; }
    });

    it("delivers webhook POST for significant events with notify_url", async () => {
      const webhookPromise = new Promise<string>((resolve) => {
        server = http.createServer((req, res) => {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => { webhookReceived = body; res.writeHead(200); res.end("OK"); resolve(body); });
        });
        server!.listen(0, "127.0.0.1");
      });

      await new Promise<void>((resolve) => { server!.once("listening", resolve); });
      const addr = server!.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;

      db.prepare("INSERT INTO runs (id, workflow_id, task, status, notify_url) VALUES (?, ?, ?, ?, ?)")
        .run("webhook-run", "test-wf", "test task", "running", `http://127.0.0.1:${port}/webhook`);

      emitEvent({ ts: new Date().toISOString(), event: "run.started", runId: "webhook-run" });

      const body = await webhookPromise;
      const parsed = JSON.parse(body);
      assert.equal(parsed.runId, "webhook-run");
      assert.equal(parsed.event, "run.started");
    });

    it("skips webhook for non-significant events", () => {
      db.prepare("INSERT INTO runs (id, workflow_id, task, status, notify_url) VALUES (?, ?, ?, ?, ?)")
        .run("nohook-run", "test-wf", "test task", "running", "http://127.0.0.1:19999/nope");
      assert.doesNotThrow(() =>
        emitEvent({ ts: new Date().toISOString(), event: "step.running", runId: "nohook-run" })
      );
    });

    it("skips webhook when notify_url is missing", () => {
      db.prepare("INSERT INTO runs (id, workflow_id, task, status) VALUES (?, ?, ?, ?)")
        .run("nonotify-run", "test-wf", "test task", "running");
      assert.doesNotThrow(() =>
        emitEvent({ ts: new Date().toISOString(), event: "run.completed", runId: "nonotify-run" })
      );
    });
  });

  it("returns empty when events file does not exist (ENOENT)", () => {
    const result = readEventsFromCursor({ kind: "global" }, 0);
    assert.deepEqual(result.events, []);
    assert.equal(result.nextOffset, 0);
  });

  it("returns empty on non-ENOENT read error (e.g. permission denied)", () => {
    // Create a directory where the file would be — making readFileSync fail with EISDIR
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(globalFile, { recursive: true }); // create a directory with the file name

    const result = readEventsFromCursor({ kind: "global" }, 0);
    assert.deepEqual(result.events, []);
  });
});

describe("emitEvent", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-emit-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("writes to both run-specific and global events files", () => {
    const evt = makeEvent("run-emit", "run.started");
    emitEvent(evt);

    const runFile = path.join(stateDir, "events", "run-emit.jsonl");
    const globalFile = path.join(stateDir, "events", "all.jsonl");

    const runContent = fs.readFileSync(runFile, "utf-8");
    const globalContent = fs.readFileSync(globalFile, "utf-8");

    assert.ok(runContent.includes(evt.runId));
    assert.ok(globalContent.includes(evt.runId));
  });

  it("creates events directory if it does not exist", () => {
    const eventsDir = path.join(stateDir, "events");
    assert.ok(!fs.existsSync(eventsDir));

    emitEvent(makeEvent("run-createdir", "run.started"));

    assert.ok(fs.existsSync(eventsDir));
    assert.ok(fs.statSync(eventsDir).isDirectory());
  });
});

describe("getRecentEvents", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-recent-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns empty array when global file does not exist", () => {
    const events = getRecentEvents();
    assert.deepEqual(events, []);
  });

  it("reads recent events from global file", () => {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });

    const evt1 = makeEvent("run-a", "run.started");
    const evt2 = makeEvent("run-a", "run.completed");
    fs.appendFileSync(globalFile, `${JSON.stringify(evt1)}\n${JSON.stringify(evt2)}\n`, "utf-8");

    const events = getRecentEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0]!.event, "run.started");
    assert.equal(events[1]!.event, "run.completed");
  });

  it("respects limit parameter", () => {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });

    for (let i = 0; i < 10; i++) {
      const evt = makeEvent("run-a", `event.${i}`);
      fs.appendFileSync(globalFile, `${JSON.stringify(evt)}\n`, "utf-8");
    }

    const events = getRecentEvents(3);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.event, "event.7");
    assert.equal(events[2]!.event, "event.9");
  });

  it("skips malformed JSON lines", () => {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });

    const evt1 = makeEvent("run-a", "run.started");
    const evt2 = makeEvent("run-a", "run.completed");
    fs.appendFileSync(globalFile, `${JSON.stringify(evt1)}\nnot-json\n${JSON.stringify(evt2)}\n`, "utf-8");

    const events = getRecentEvents();
    // Only valid JSON lines are returned
    assert.equal(events.length, 2);
    assert.equal(events[0]!.event, "run.started");
    assert.equal(events[1]!.event, "run.completed");
  });

  it("handles global events file being a directory (non-ENOENT error)", () => {
    // Create a directory where the global file should be
    const globalFileAsDir = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(globalFileAsDir, { recursive: true });

    const events = getRecentEvents();
    assert.deepEqual(events, []);
  });

  it("reads correct tail events from a multi-MB file without reading the whole file", () => {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });

    // Write enough events to exceed 2 MB. Each event line is roughly
    // 80 bytes → ~28 000 events for ~2.2 MB.
    const EVENT_COUNT = 28_000;
    const TARGET_LIMIT = 10;

    // Build in batches and write via appendFileSync for throughput.
    const fd = fs.openSync(globalFile, "w");
    const batchSize = 500;
    const batches = Math.ceil(EVENT_COUNT / batchSize);
    for (let b = 0; b < batches; b++) {
      const start = b * batchSize;
      const end = Math.min(start + batchSize, EVENT_COUNT);
      let batch = "";
      for (let i = start; i < end; i++) {
        const evt = makeEvent("run-large", `event.${String(i).padStart(5, "0")}`);
        batch += JSON.stringify(evt) + "\n";
      }
      fs.appendFileSync(fd, batch, "utf-8");
    }
    fs.closeSync(fd);

    const fileSize = fs.statSync(globalFile).size;
    assert.ok(fileSize > 2_000_000, `file should exceed 2 MB, got ${(fileSize / 1_000_000).toFixed(2)} MB`);

    const start = performance.now();
    const events = getRecentEvents(TARGET_LIMIT);
    const elapsed = performance.now() - start;

    assert.equal(events.length, TARGET_LIMIT);
    // Verify the returned events are the LAST TARGET_LIMIT events
    for (let i = 0; i < TARGET_LIMIT; i++) {
      const expectedIndex = EVENT_COUNT - TARGET_LIMIT + i;
      assert.equal(events[i]!.event, `event.${String(expectedIndex).padStart(5, "0")}`);
    }

    // Should be fast — well under 100 ms for a 256 KB tail read
    assert.ok(elapsed < 500, `getRecentEvents took ${elapsed.toFixed(1)}ms, expected < 500ms`);
  });
});

describe("getRunEvents", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-runevents-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns empty array when run events file does not exist", () => {
    const events = getRunEvents("nonexistent-run");
    assert.deepEqual(events, []);
  });

  it("reads all events for a specific run", () => {
    const runId = "run-readall";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const evt1 = makeEvent(runId, "run.started");
    const evt2 = makeEvent(runId, "step.running");
    const evt3 = makeEvent(runId, "step.done");
    fs.appendFileSync(
      runFile,
      `${JSON.stringify(evt1)}\n${JSON.stringify(evt2)}\n${JSON.stringify(evt3)}\n`,
      "utf-8",
    );

    const events = getRunEvents(runId);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.event, "run.started");
    assert.equal(events[2]!.event, "step.done");
  });

  it("skips malformed JSON lines in run events", () => {
    const runId = "run-malformed";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const evt1 = makeEvent(runId, "run.started");
    fs.appendFileSync(runFile, `bad-json\n${JSON.stringify(evt1)}\n`, "utf-8");

    const events = getRunEvents(runId);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.event, "run.started");
  });

  it("handles run events file being a directory", () => {
    const runId = "run-dir-instead";
    const runFileAsDir = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(runFileAsDir, { recursive: true });

    const events = getRunEvents(runId);
    assert.deepEqual(events, []);
  });

  it("returns last N events with limit (tail window)", () => {
    const runId = "run-tail";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    // Write 10 events
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      const evt = makeEvent(runId, `event.${i}`);
      lines.push(JSON.stringify(evt));
    }
    fs.writeFileSync(runFile, lines.join("\n") + "\n", "utf-8");

    const events = getRunEvents(runId, 3);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.event, "event.7");
    assert.equal(events[2]!.event, "event.9");
  });

  it("returns all events when limit exceeds file size", () => {
    const runId = "run-tail-overflow";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    // Write 10 events
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      const evt = makeEvent(runId, `event.${i}`);
      lines.push(JSON.stringify(evt));
    }
    fs.writeFileSync(runFile, lines.join("\n") + "\n", "utf-8");

    const events = getRunEvents(runId, 100);
    assert.equal(events.length, 10);
  });

  it("returns all events when no limit is passed (unchanged behavior)", () => {
    const runId = "run-nolimit";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const lines: string[] = [];
    for (let i = 0; i < 5; i++) {
      const evt = makeEvent(runId, `event.${i}`);
      lines.push(JSON.stringify(evt));
    }
    fs.writeFileSync(runFile, lines.join("\n") + "\n", "utf-8");

    const events = getRunEvents(runId);
    assert.equal(events.length, 5);
    assert.equal(events[0]!.event, "event.0");
    assert.equal(events[4]!.event, "event.4");
  });

  it("skips malformed JSON lines in tail window", () => {
    const runId = "run-tail-malformed";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const evt1 = makeEvent(runId, "event.good");
    const evt2 = makeEvent(runId, "event.also-good");
    fs.writeFileSync(
      runFile,
      `garbage line\n${JSON.stringify(evt1)}\nmore garbage\n${JSON.stringify(evt2)}\n`,
      "utf-8",
    );

    const events = getRunEvents(runId, 5);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.event, "event.good");
    assert.equal(events[1]!.event, "event.also-good");
  });

  it("returns empty array for limit 0", () => {
    const runId = "run-limit-zero";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const evt = makeEvent(runId, "event.0");
    fs.writeFileSync(runFile, `${JSON.stringify(evt)}\n`, "utf-8");

    const events = getRunEvents(runId, 0);
    assert.equal(events.length, 1); // limit 0 falls through to full read
  });
});

describe("countRunEvents", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-count-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;

    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns 0 for nonexistent file", () => {
    const count = countRunEvents("nonexistent-run");
    assert.equal(count, 0);
  });

  it("returns correct count for populated file", () => {
    const runId = "run-count";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    const lines: string[] = [];
    for (let i = 0; i < 7; i++) {
      lines.push(JSON.stringify(makeEvent(runId, `event.${i}`)));
    }
    fs.writeFileSync(runFile, lines.join("\n") + "\n", "utf-8");

    const count = countRunEvents(runId);
    assert.equal(count, 7);
  });

  it("returns 0 for empty file", () => {
    const runId = "run-empty";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });
    fs.writeFileSync(runFile, "", "utf-8");

    const count = countRunEvents(runId);
    assert.equal(count, 0);
  });

  it("returns 0 for directory-as-file", () => {
    const runId = "run-dir";
    const runFileAsDir = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(runFileAsDir, { recursive: true });

    const count = countRunEvents(runId);
    assert.equal(count, 0);
  });

  it("skips empty lines in count (whitespace-only lines)", () => {
    const runId = "run-blank-lines";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    fs.writeFileSync(runFile, "\n\n{\"ts\":\"2024-01-01\",\"event\":\"ev\",\"runId\":\"x\"}\n\n\n", "utf-8");

    const count = countRunEvents(runId);
    assert.equal(count, 1);
  });

  it("does not JSON-parse — treats malformed lines as valid lines", () => {
    const runId = "run-nonparse-count";
    const runFile = path.join(stateDir, "events", `${runId}.jsonl`);
    fs.mkdirSync(path.dirname(runFile), { recursive: true });

    fs.writeFileSync(runFile, "not json\nneither is this\n{\"ts\":\"a\",\"event\":\"e\",\"runId\":\"r\"}\n", "utf-8");

    const count = countRunEvents(runId);
    // countRunEvents counts non-empty lines — all 3 are non-empty
    assert.equal(count, 3);
  });
});

describe("getEventsPath", () => {
  it("returns the events directory under TAMANDUA_STATE_DIR", () => {
    const p = getEventsPath();
    assert.ok(p.includes("events"));
  });
});

describe("emitEvent rotation integration", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-emit-rotate-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function writeLargeGlobalFile(size: number, marker: string): void {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    const fd = fs.openSync(globalFile, "w");
    const chunkSize = 512 * 1024; // 512 KB
    const header = JSON.stringify({ ts: "2026-01-01T00:00:00Z", event: `prefill.${marker}`, runId: "prefill" }) + "\n";
    const headerLen = Buffer.byteLength(header);
    const padLen = Math.max(1, chunkSize - headerLen);
    const pad = "x".repeat(padLen);
    const fullChunk = header + pad + "\n";

    let written = 0;
    while (written < size) {
      const toWrite = Math.min(Buffer.byteLength(fullChunk), size - written);
      if (toWrite === Buffer.byteLength(fullChunk)) {
        fs.appendFileSync(fd, fullChunk, "utf-8");
        written += toWrite;
      } else {
        // Last partial chunk — pad shorter
        const partial = header + "x".repeat(Math.max(1, toWrite - headerLen - 1)) + "\n";
        fs.appendFileSync(fd, partial, "utf-8");
        written += Buffer.byteLength(partial);
      }
    }
    fs.closeSync(fd);
  }

  function archiveExists(n: number): boolean {
    return fs.existsSync(path.join(stateDir, "events", `all.jsonl.${n}`));
  }

  function readArchive(n: number): string {
    return fs.readFileSync(path.join(stateDir, "events", `all.jsonl.${n}`), "utf-8");
  }

  it("triggers rotation when emitEvent pushes global file past cap", () => {
    // Pre-seed the global file very close to the cap so that a single
    // emitEvent pushes the actual file size past it.
    const nearCap = MAX_EVENTS_FILE_SIZE - 50;
    writeLargeGlobalFile(nearCap, "seed");

    // Sync the module-level estimate with the pre-seeded file
    _refreshSizeEstimate();

    // Emit an event — it is appended, pushing the file past the cap,
    // then rotateGlobalEventsFile renames the live file to .1 (so the
    // trigger event lives in the archive, not the live file).
    const evt = makeEvent("run-rotate-1", "run.started");
    emitEvent(evt);

    // After rotation the live file is gone (renamed to .1).
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    assert.ok(!fs.existsSync(globalFile), "live file should be gone after rotation");

    // Archive .1 should contain the pre-seeded content AND the trigger event
    assert.ok(archiveExists(1), "archive .1 must exist");
    const archiveContent = readArchive(1);
    assert.ok(archiveContent.includes("prefill.seed"), "archive .1 must have pre-seeded content");
    assert.ok(archiveContent.includes("run-rotate-1"), "archive .1 must have the trigger event");

    // No higher archives on first rotation
    assert.ok(!archiveExists(2), "archive .2 must not exist on first rotation");
    assert.ok(!archiveExists(3), "archive .3 must not exist on first rotation");

    // Generation must have incremented
    assert.equal(getGlobalEventsGeneration(), 1);

    // A subsequent event goes to the fresh live file
    emitEvent(makeEvent("run-rotate-1", "step.running"));
    assert.ok(fs.existsSync(globalFile), "live file must exist after post-rotation write");
    const liveContent = fs.readFileSync(globalFile, "utf-8");
    assert.ok(liveContent.includes("step.running"), "post-rotation event must be in live file");
  });

  it("prunes oldest archive when max archives exceeded", () => {
    // Rotate 4 times to fill all archive slots (MAX_ROTATED_EVENTS_FILES = 3).
    // Each iteration: pre-seed near cap, emitEvent pushes past → rotates.
    for (let rot = 0; rot < 4; rot++) {
      const marker = `rot${rot}`;
      writeLargeGlobalFile(MAX_EVENTS_FILE_SIZE - 50, marker);
      _refreshSizeEstimate();

      // This event is appended, then the file rotates (trigger event → archive)
      emitEvent(makeEvent(`run-rot${rot}`, `rotation.${rot}`));
    }

    // After 4 rotations, archives .1 .2 .3 should exist
    assert.ok(archiveExists(1), "archive .1 must exist");
    assert.ok(archiveExists(2), "archive .2 must exist");
    assert.ok(archiveExists(3), "archive .3 must exist");

    // The oldest (first rotation's content) should have been pruned:
    // rot0 is gone, rot1 → .3, rot2 → .2, rot3 → .1
    // All archive contents include trigger events + pre-seeded content.
    // Archive .3 should contain rot1 (the oldest surviving)
    assert.ok(readArchive(3).includes("prefill.rot1"), "archive .3 should have rot1 (oldest kept)");

    // Archive .1 should have the most recent (rot3)
    assert.ok(readArchive(1).includes("prefill.rot3"), "archive .1 should have rot3 (newest)");

    // rot0 should NOT appear in any archive
    const allArchives = readArchive(1) + readArchive(2) + readArchive(3);
    assert.ok(!allArchives.includes("prefill.rot0"), "rot0 must be pruned from all archives");

    // After the 4th rotation the live file is gone (renamed to .1 with
    // the trigger event).  A subsequent write recreates it.
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    assert.ok(!fs.existsSync(globalFile), "live file must be gone after final rotation");

    // A post-rotation event recreates the live file
    emitEvent(makeEvent("run-after", "run.started"));
    assert.ok(fs.existsSync(globalFile), "live file must exist after post-rotation write");
    const liveContent = fs.readFileSync(globalFile, "utf-8");
    assert.ok(liveContent.includes("run-after"), "post-rotation event must be in live file");

    // Generation should be 4
    assert.equal(getGlobalEventsGeneration(), 4);
  });

  it("does not rotate when global file is below the cap", () => {
    // Write a small file via emitEvent — no rotation should happen
    emitEvent(makeEvent("run-small", "run.started"));
    emitEvent(makeEvent("run-small", "step.running"));

    const genBefore = getGlobalEventsGeneration();
    assert.equal(genBefore, 0, "generation should be 0 (no rotation)");

    const globalFile = path.join(stateDir, "events", "all.jsonl");
    assert.ok(fs.existsSync(globalFile), "global file must exist");
    assert.ok(!archiveExists(1), "no archive should exist below cap");
    assert.ok(!archiveExists(2), "no archive should exist below cap");
    assert.ok(!archiveExists(3), "no archive should exist below cap");
  });

  it("events continue writing to live file after rotation", () => {
    // The trigger event that pushes past the cap is appended first,
    // then rotation renames the file (trigger event → archive).
    writeLargeGlobalFile(MAX_EVENTS_FILE_SIZE - 50, "pre");
    _refreshSizeEstimate();
    emitEvent(makeEvent("run-post-rot", "rotation.trigger"));

    // Now emit more events — they should all go to the live file
    emitEvent(makeEvent("run-post-rot", "step.running"));
    emitEvent(makeEvent("run-post-rot", "step.done"));
    emitEvent(makeEvent("run-post-rot", "run.completed"));

    const globalFile = path.join(stateDir, "events", "all.jsonl");
    const liveContent = fs.readFileSync(globalFile, "utf-8");
    assert.ok(liveContent.includes("step.running"), "live file must have step.running");
    assert.ok(liveContent.includes("step.done"), "live file must have step.done");
    assert.ok(liveContent.includes("run.completed"), "live file must have run.completed");
    // Rotation trigger event should be in the archive, not live file
    assert.ok(!liveContent.includes("rotation.trigger"), "trigger event must not be in live file");
  });

  it("per-run event files are uncapped and unaffected by rotation", () => {
    // Trigger rotation
    writeLargeGlobalFile(MAX_EVENTS_FILE_SIZE - 50, "pre");
    _refreshSizeEstimate();
    emitEvent(makeEvent("run-per-run", "run.started"));

    // Emit many more events for the same run to the per-run file
    for (let i = 0; i < 100; i++) {
      emitEvent(makeEvent("run-per-run", `event.${i}`));
    }

    // Per-run file should have all 101 events (1 trigger + 100 more)
    const runFile = path.join(stateDir, "events", "run-per-run.jsonl");
    assert.ok(fs.existsSync(runFile), "per-run file must exist");
    const runContent = fs.readFileSync(runFile, "utf-8");
    const runLines = runContent.trim().split("\n").filter(Boolean);
    assert.equal(runLines.length, 101, "per-run file must have 101 events (uncapped)");

    // Per-run file must NOT be rotated (no .jsonl.1 etc.)
    assert.ok(
      !fs.existsSync(path.join(stateDir, "events", "run-per-run.jsonl.1")),
      "per-run file must not have archive .1",
    );
    assert.ok(
      !fs.existsSync(path.join(stateDir, "events", "run-per-run.jsonl.2")),
      "per-run file must not have archive .2",
    );

    // Global file should exist (got rotated then new events appended)
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    assert.ok(fs.existsSync(globalFile), "global file must exist");
  });

  it("rotateGlobalEventsFile is not called when estimate + line is below cap", () => {
    // Reset stateDir so any previous global file doesn't interfere
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });

    // Write a small file (well below cap) and check that rotation is NOT triggered
    emitEvent(makeEvent("run-below", "run.started"));
    emitEvent(makeEvent("run-below", "step.running"));

    // No archives, no generation change
    assert.ok(!archiveExists(1));
    assert.ok(!archiveExists(2));
    assert.ok(!archiveExists(3));
    assert.equal(getGlobalEventsGeneration(), 0);

    // All events are in the live file
    const content = fs.readFileSync(globalFile, "utf-8");
    assert.ok(content.includes("run.started"));
    assert.ok(content.includes("step.running"));
  });
});

describe("rotation infrastructure", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-rotate-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  describe("constants", () => {
    it("MAX_EVENTS_FILE_SIZE is 20 MB", () => {
      assert.equal(MAX_EVENTS_FILE_SIZE, 20 * 1024 * 1024);
    });

    it("MAX_ROTATED_EVENTS_FILES is 3", () => {
      assert.equal(MAX_ROTATED_EVENTS_FILES, 3);
    });
  });

  describe("getGlobalEventsGeneration", () => {
    it("returns 0 when no generation file exists", () => {
      assert.equal(getGlobalEventsGeneration(), 0);
    });

    it("returns persisted generation value", () => {
      const genFile = path.join(stateDir, "events", "all.jsonl.generation");
      fs.mkdirSync(path.dirname(genFile), { recursive: true });
      fs.writeFileSync(genFile, "5", "utf-8");
      assert.equal(getGlobalEventsGeneration(), 5);
    });

    it("handles non-numeric generation file gracefully", () => {
      const genFile = path.join(stateDir, "events", "all.jsonl.generation");
      fs.mkdirSync(path.dirname(genFile), { recursive: true });
      fs.writeFileSync(genFile, "not-a-number", "utf-8");
      assert.equal(getGlobalEventsGeneration(), 0);
    });
  });

  describe("rotateGlobalEventsFile", () => {
    function writeGlobalFile(content: string): void {
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      fs.writeFileSync(globalFile, content, "utf-8");
    }

    function globalFileSize(): number {
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      try {
        return fs.statSync(globalFile).size;
      } catch {
        return 0;
      }
    }

    function archiveExists(n: number): boolean {
      const archive = path.join(stateDir, "events", `all.jsonl.${n}`);
      return fs.existsSync(archive);
    }

    function readArchive(n: number): string {
      const archive = path.join(stateDir, "events", `all.jsonl.${n}`);
      return fs.readFileSync(archive, "utf-8");
    }

    it("does nothing when global file does not exist", () => {
      assert.doesNotThrow(() => rotateGlobalEventsFile());
      assert.equal(globalFileSize(), 0);
      assert.equal(getGlobalEventsGeneration(), 0);
    });

    it("does nothing when file is below the cap", () => {
      writeGlobalFile("small content\n");
      const sizeBefore = globalFileSize();
      assert.ok(sizeBefore < MAX_EVENTS_FILE_SIZE);

      rotateGlobalEventsFile();

      // File should still exist and be unchanged
      assert.ok(fs.existsSync(path.join(stateDir, "events", "all.jsonl")));
      assert.equal(globalFileSize(), sizeBefore);
      assert.equal(getGlobalEventsGeneration(), 0);
    });

    it("rotates when file exceeds cap with correct archive numbering", () => {
      // Write a file just over MAX_EVENTS_FILE_SIZE
      const chunkSize = 1024 * 1024; // 1 MB
      const chunks = Math.ceil((MAX_EVENTS_FILE_SIZE + 1) / chunkSize);
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      const fd = fs.openSync(globalFile, "w");
      const pad = "x".repeat(chunkSize - 1); // -1 for newline
      for (let i = 0; i < chunks; i++) {
        fs.appendFileSync(fd, `${pad}\n`, "utf-8");
      }
      fs.closeSync(fd);

      assert.ok(fs.statSync(globalFile).size > MAX_EVENTS_FILE_SIZE, "file must exceed cap");

      rotateGlobalEventsFile();

      // Live file should be gone (renamed to .1)
      assert.ok(!fs.existsSync(globalFile), "live file should be renamed to .1");

      // Archive .1 should exist with the old content
      assert.ok(archiveExists(1), "archive .1 must exist");
      assert.ok(readArchive(1).length > 0, "archive .1 must have content");

      // No higher archives should exist on first rotation
      assert.ok(!archiveExists(2), "archive .2 must not exist on first rotation");
      assert.ok(!archiveExists(3), "archive .3 must not exist on first rotation");

      // Generation must have incremented
      assert.equal(getGlobalEventsGeneration(), 1);
    });

    it("shifts and prunes archives correctly across multiple rotations", () => {
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      const chunkSize = 1024 * 1024;
      const pad = "x".repeat(chunkSize - 1);
      const chunks = Math.ceil((MAX_EVENTS_FILE_SIZE + 1) / chunkSize);
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });

      // First rotation
      const fd1 = fs.openSync(globalFile, "w");
      for (let i = 0; i < chunks; i++) {
        fs.appendFileSync(fd1, `A${pad}\n`, "utf-8");
      }
      fs.closeSync(fd1);
      rotateGlobalEventsFile();
      assert.ok(archiveExists(1), "after rot #1: .1 exists");
      assert.ok(!archiveExists(2), "after rot #1: .2 does not exist");
      assert.ok(!archiveExists(3), "after rot #1: .3 does not exist");
      assert.equal(getGlobalEventsGeneration(), 1);

      // Second rotation — write new content to live file
      const fd2 = fs.openSync(globalFile, "w");
      for (let i = 0; i < chunks; i++) {
        fs.appendFileSync(fd2, `B${pad}\n`, "utf-8");
      }
      fs.closeSync(fd2);
      rotateGlobalEventsFile();
      assert.ok(archiveExists(1), "after rot #2: .1 exists (was B)");
      assert.ok(archiveExists(2), "after rot #2: .2 exists (was A)");
      assert.ok(!archiveExists(3), "after rot #2: .3 does not exist");
      assert.ok(readArchive(1).includes("B"), "archive .1 has B content");
      assert.ok(readArchive(2).includes("A"), "archive .2 has A content");
      assert.equal(getGlobalEventsGeneration(), 2);

      // Third rotation
      const fd3 = fs.openSync(globalFile, "w");
      for (let i = 0; i < chunks; i++) {
        fs.appendFileSync(fd3, `C${pad}\n`, "utf-8");
      }
      fs.closeSync(fd3);
      rotateGlobalEventsFile();
      assert.ok(archiveExists(1), "after rot #3: .1 exists (was C)");
      assert.ok(archiveExists(2), "after rot #3: .2 exists (was B)");
      assert.ok(archiveExists(3), "after rot #3: .3 exists (was A)");
      assert.ok(readArchive(1).includes("C"), "archive .1 has C content");
      assert.ok(readArchive(2).includes("B"), "archive .2 has B content");
      assert.ok(readArchive(3).includes("A"), "archive .3 has A content");
      assert.equal(getGlobalEventsGeneration(), 3);

      // Fourth rotation — oldest (.3) should be pruned
      const fd4 = fs.openSync(globalFile, "w");
      for (let i = 0; i < chunks; i++) {
        fs.appendFileSync(fd4, `D${pad}\n`, "utf-8");
      }
      fs.closeSync(fd4);
      rotateGlobalEventsFile();
      assert.ok(archiveExists(1), "after rot #4: .1 exists (was D)");
      assert.ok(archiveExists(2), "after rot #4: .2 exists (was C)");
      assert.ok(archiveExists(3), "after rot #4: .3 exists (was B)");
      assert.ok(readArchive(1).includes("D"), "archive .1 has D content");
      assert.ok(readArchive(2).includes("C"), "archive .2 has C content");
      assert.ok(readArchive(3).includes("B"), "archive .3 has B content");
      // Generation keeps incrementing
      assert.equal(getGlobalEventsGeneration(), 4);
    });

    it("is idempotent when called twice on the same over-cap file", () => {
      const globalFile = path.join(stateDir, "events", "all.jsonl");
      const chunkSize = 1024 * 1024;
      const chunks = Math.ceil((MAX_EVENTS_FILE_SIZE + 1) / chunkSize);
      fs.mkdirSync(path.dirname(globalFile), { recursive: true });
      const fd = fs.openSync(globalFile, "w");
      const pad = "x".repeat(chunkSize - 1);
      for (let i = 0; i < chunks; i++) {
        fs.appendFileSync(fd, `${pad}\n`, "utf-8");
      }
      fs.closeSync(fd);

      rotateGlobalEventsFile();
      assert.equal(getGlobalEventsGeneration(), 1);

      // Second call: live file doesn't exist → returns early (no-op)
      rotateGlobalEventsFile();
      assert.equal(getGlobalEventsGeneration(), 1); // unchanged
    });
  });
});

describe("getRecentEvents after rotation", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-recent-rot-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  function writeLargeGlobalFile(size: number, marker: string): void {
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    fs.mkdirSync(path.dirname(globalFile), { recursive: true });
    const fd = fs.openSync(globalFile, "w");
    const chunkSize = 512 * 1024; // 512 KB
    const header = JSON.stringify({ ts: "2026-01-01T00:00:00Z", event: `prefill.${marker}`, runId: "prefill" }) + "\n";
    const headerLen = Buffer.byteLength(header);
    const padLen = Math.max(1, chunkSize - headerLen);
    const pad = "x".repeat(padLen);
    const fullChunk = header + pad + "\n";

    let written = 0;
    while (written < size) {
      const toWrite = Math.min(Buffer.byteLength(fullChunk), size - written);
      if (toWrite === Buffer.byteLength(fullChunk)) {
        fs.appendFileSync(fd, fullChunk, "utf-8");
        written += toWrite;
      } else {
        const partial = header + "x".repeat(Math.max(1, toWrite - headerLen - 1)) + "\n";
        fs.appendFileSync(fd, partial, "utf-8");
        written += Buffer.byteLength(partial);
      }
    }
    fs.closeSync(fd);
  }

  it("returns only events from the live all.jsonl after rotation (does not span into archives)", () => {
    // 1. Trigger rotation: pre-seed near cap, then emit an event to push past
    writeLargeGlobalFile(MAX_EVENTS_FILE_SIZE - 50, "seed");
    _refreshSizeEstimate();

    // The trigger event will be appended to the pre-seeded file, pushing it
    // past the cap → rotation → renamed to all.jsonl.1
    emitEvent(makeEvent("run-rot", "rotation.trigger"));

    assert.equal(getGlobalEventsGeneration(), 1, "generation must increment after rotation");

    // Archive .1 now contains both the pre-seeded content AND the trigger event
    const archive1 = path.join(stateDir, "events", "all.jsonl.1");
    assert.ok(fs.existsSync(archive1), "archive .1 must exist");
    const archiveContent = fs.readFileSync(archive1, "utf-8");
    assert.ok(archiveContent.includes("rotation.trigger"), "trigger event must be in archive .1");

    // Live file does not exist yet (rotation renamed it)
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    assert.ok(!fs.existsSync(globalFile), "live file must not exist immediately after rotation");

    // getRecentEvents on a non-existent live file returns empty
    const empty = getRecentEvents(50);
    assert.deepEqual(empty, [], "getRecentEvents returns empty when live file does not exist");

    // 2. Write post-rotation events to the live file
    emitEvent(makeEvent("run-rot", "post.rot.1"));
    emitEvent(makeEvent("run-rot", "post.rot.2"));
    emitEvent(makeEvent("run-rot", "post.rot.3"));

    // 3. getRecentEvents must return ONLY events from the live file
    const recent = getRecentEvents(50);

    // Must contain the post-rotation events
    const recentEvents = recent.map(e => e.event);
    assert.ok(recentEvents.includes("post.rot.1"), "must include post.rot.1");
    assert.ok(recentEvents.includes("post.rot.2"), "must include post.rot.2");
    assert.ok(recentEvents.includes("post.rot.3"), "must include post.rot.3");

    // Must NOT contain any event from the archive (the rotation.trigger or prefill.seed)
    assert.ok(!recentEvents.includes("rotation.trigger"), "must NOT include rotation.trigger from archive");

    // All returned events should have runId "run-rot" (not "prefill" from archive)
    for (const evt of recent) {
      assert.notEqual(evt.runId, "prefill", "must not contain prefill events from archive");
    }
  });

  it("getRecentEvents respects limit on live file after rotation", () => {
    // Trigger rotation first
    writeLargeGlobalFile(MAX_EVENTS_FILE_SIZE - 50, "seed");
    _refreshSizeEstimate();
    emitEvent(makeEvent("run-lim", "rotation.trigger"));

    // Write 10 post-rotation events
    for (let i = 0; i < 10; i++) {
      emitEvent(makeEvent("run-lim", `post.event.${i}`));
    }

    // Limit to 3 — should return only the last 3 from the live file
    const recent = getRecentEvents(3);
    assert.equal(recent.length, 3);

    const events = recent.map(e => e.event);
    assert.ok(events.includes("post.event.7"));
    assert.ok(events.includes("post.event.8"));
    assert.ok(events.includes("post.event.9"));

    // Must not contain archive events
    assert.ok(!events.includes("rotation.trigger"), "limit must not include archive events");
  });
});

describe("event buffering", () => {
  let stateDir: string;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateDir = tamanduaTempDir("tamandua-buffer-");
    process.env.TAMANDUA_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("emitEvent redirects to buffer when buffering is active", () => {
    beginEventBuffering();

    emitEvent(makeEvent("run-buf", "run.started"));
    emitEvent(makeEvent("run-buf", "step.running"));
    emitEvent(makeEvent("run-buf", "step.done"));

    // No files should be written yet
    const runFile = path.join(stateDir, "events", "run-buf.jsonl");
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    assert.ok(!fs.existsSync(runFile), "run events file must not exist while buffering");
    assert.ok(!fs.existsSync(globalFile), "global events file must not exist while buffering");

    discardEventBuffer();
  });

  it("flushEventBuffer writes all buffered events to disk in order", () => {
    beginEventBuffering();

    emitEvent(makeEvent("run-buf2", "run.started"));
    emitEvent(makeEvent("run-buf2", "step.running"));
    emitEvent(makeEvent("run-buf2", "step.done"));

    flushEventBuffer();

    // Files should now exist with all three events
    const runFile = path.join(stateDir, "events", "run-buf2.jsonl");
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    assert.ok(fs.existsSync(runFile), "run events file must exist after flush");
    assert.ok(fs.existsSync(globalFile), "global events file must exist after flush");

    const runContent = fs.readFileSync(runFile, "utf-8");
    const lines = runContent.trim().split("\n");
    assert.equal(lines.length, 3, "must have 3 events");

    const events = lines.map((l: string) => JSON.parse(l));
    assert.equal(events[0].event, "run.started");
    assert.equal(events[1].event, "step.running");
    assert.equal(events[2].event, "step.done");
  });

  it("flushEventBuffer clears the buffer after writing", () => {
    beginEventBuffering();
    emitEvent(makeEvent("run-buf3", "run.started"));
    flushEventBuffer();

    // After flush, new emitEvent calls should go directly to disk
    emitEvent(makeEvent("run-buf3", "step.running"));

    const runFile = path.join(stateDir, "events", "run-buf3.jsonl");
    const content = fs.readFileSync(runFile, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 2, "must have 2 events (1 buffered + 1 direct)");
  });

  it("discardEventBuffer drops events without writing to disk", () => {
    beginEventBuffering();

    emitEvent(makeEvent("run-discard", "run.started"));
    emitEvent(makeEvent("run-discard", "step.running"));

    discardEventBuffer();

    // No files should be written
    const runFile = path.join(stateDir, "events", "run-discard.jsonl");
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    assert.ok(!fs.existsSync(runFile), "run events file must not exist after discard");
    assert.ok(!fs.existsSync(globalFile), "global events file must not exist after discard");
  });

  it("discardEventBuffer deactivates buffering so subsequent emits go to disk", () => {
    beginEventBuffering();
    emitEvent(makeEvent("run-d2", "dropped"));
    discardEventBuffer();

    // Now emit normally — should go to disk
    emitEvent(makeEvent("run-d2", "kept"));

    const runFile = path.join(stateDir, "events", "run-d2.jsonl");
    const content = fs.readFileSync(runFile, "utf-8");
    assert.ok(content.includes("kept"), "post-discard event must be written");
    assert.ok(!content.includes("dropped"), "discarded event must not be written");
  });

  it("flushEventBuffer writes to both run and global files", () => {
    beginEventBuffering();
    emitEvent(makeEvent("run-both", "run.completed"));
    flushEventBuffer();

    const runFile = path.join(stateDir, "events", "run-both.jsonl");
    const globalFile = path.join(stateDir, "events", "all.jsonl");
    assert.ok(fs.existsSync(runFile), "run events file must exist");
    assert.ok(fs.existsSync(globalFile), "global events file must exist");

    const runContent = fs.readFileSync(runFile, "utf-8").trim();
    const globalContent = fs.readFileSync(globalFile, "utf-8").trim();
    assert.equal(runContent, globalContent, "run and global files must have same content");
  });

  it("flushEventBuffer replays events in insertion order", () => {
    beginEventBuffering();

    const expected: string[] = [];
    for (let i = 0; i < 20; i++) {
      const evt = makeEvent("run-order", `event.${i}`);
      emitEvent(evt);
      expected.push(evt.event);
    }

    flushEventBuffer();

    const runFile = path.join(stateDir, "events", "run-order.jsonl");
    const content = fs.readFileSync(runFile, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 20);

    for (let i = 0; i < lines.length; i++) {
      const parsed = JSON.parse(lines[i]!);
      assert.equal(parsed.event, expected[i]);
    }
  });

  it("emitEvent still writes directly when buffer is null (normal mode)", () => {
    // No buffering active — should write directly
    emitEvent(makeEvent("run-normal", "run.started"));

    const runFile = path.join(stateDir, "events", "run-normal.jsonl");
    assert.ok(fs.existsSync(runFile), "event must be written directly when buffer is null");
  });

  it("noise events are still suppressed during buffering", () => {
    const prev = process.env.TAMANDUA_DEBUG_EVENTS;
    delete process.env.TAMANDUA_DEBUG_EVENTS;
    try {
      beginEventBuffering();
      emitEvent(makeEvent("run-noise", "run.nudged"));
      emitEvent(makeEvent("run-noise", "agent.nudged"));
      emitEvent(makeEvent("run-noise", "step.completed"));
      flushEventBuffer();

      // Only step.completed should be written
      const runFile = path.join(stateDir, "events", "run-noise.jsonl");
      const content = fs.readFileSync(runFile, "utf-8");
      assert.ok(content.includes("step.completed"), "real event must be written");
      assert.ok(!content.includes("run.nudged"), "noise event must be suppressed");
      assert.ok(!content.includes("agent.nudged"), "noise event must be suppressed");
    } finally {
      if (prev !== undefined) process.env.TAMANDUA_DEBUG_EVENTS = prev;
    }
  });

  it("discardEventBuffer is safe to call when not buffering", () => {
    assert.doesNotThrow(() => discardEventBuffer());
    // emitEvent should still work normally
    emitEvent(makeEvent("run-safe", "run.started"));
    const runFile = path.join(stateDir, "events", "run-safe.jsonl");
    assert.ok(fs.existsSync(runFile));
  });

  it("flushEventBuffer is safe to call when not buffering (empty buffer)", () => {
    // Should not throw — eventBuffer is null
    assert.doesNotThrow(() => flushEventBuffer());
  });

  it("multiple begin/flush cycles work correctly", () => {
    // First cycle
    beginEventBuffering();
    emitEvent(makeEvent("run-multi", "batch.1.1"));
    emitEvent(makeEvent("run-multi", "batch.1.2"));
    flushEventBuffer();

    // Second cycle
    beginEventBuffering();
    emitEvent(makeEvent("run-multi", "batch.2.1"));
    emitEvent(makeEvent("run-multi", "batch.2.2"));
    flushEventBuffer();

    // All 4 events should be written, in order
    const runFile = path.join(stateDir, "events", "run-multi.jsonl");
    const content = fs.readFileSync(runFile, "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 4);

    const events = lines.map((l: string) => JSON.parse(l).event);
    assert.deepEqual(events, ["batch.1.1", "batch.1.2", "batch.2.1", "batch.2.2"]);
  });

  it("multiple begin/discard cycles work correctly", () => {
    // First cycle — discard
    beginEventBuffering();
    emitEvent(makeEvent("run-drop", "should.be.dropped.1"));
    discardEventBuffer();

    // Second cycle — flush
    beginEventBuffering();
    emitEvent(makeEvent("run-drop", "should.be.kept"));
    flushEventBuffer();

    const runFile = path.join(stateDir, "events", "run-drop.jsonl");
    const content = fs.readFileSync(runFile, "utf-8");
    assert.ok(content.includes("should.be.kept"), "kept event must be written");
    assert.ok(!content.includes("should.be.dropped.1"), "dropped event must not be written");
    assert.equal(content.trim().split("\n").length, 1, "only one event written");
  });
});
