import assert from "node:assert/strict";
import { describe, it, after } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

import {
  filterPiEvent,
  parsePiOutputStream,
  MAX_TEXT_FALLBACK_BYTES,
} from "../dist/installer/pi-stream-parser.js";

// ── Module-level temp isolation ──────────────────────────────────────
// parsePiOutputStream logs a warning through lib/logger when text-mode
// output exceeds the cap ("pi text-mode output exceeded cap — truncating").
// logger resolves the log path from TAMANDUA_STATE_DIR (falling back to
// ~/.tamandua), so without a temp env the truncation test tripped the
// test-isolation guard at the real ~/.tamandua/tamandua.log and the write
// was silently dropped. Keep HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH
// pointed at a module-scoped temp dir (logger.test.ts pattern) and restore
// the operator's env exactly as it was at load in a module after().
const tempRoot = tamanduaTempDir("tamandua-pi-stream-parser-");
const stateDir = path.join(tempRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
const originalHome = process.env.HOME;
const originalStateDir = process.env.TAMANDUA_STATE_DIR;
const originalDbPath = process.env.TAMANDUA_DB_PATH;
process.env.HOME = path.join(tempRoot, "home");
process.env.TAMANDUA_STATE_DIR = stateDir;
process.env.TAMANDUA_DB_PATH = path.join(stateDir, "tamandua.db");

function restoreOrDelete(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

after(() => {
  restoreOrDelete("HOME", originalHome);
  restoreOrDelete("TAMANDUA_STATE_DIR", originalStateDir);
  restoreOrDelete("TAMANDUA_DB_PATH", originalDbPath);
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ── Helpers ─────────────────────────────────────────────────────────

function cannedMessageEnd(role: string, text: string, totalTokens?: number) {
  return {
    type: "message_end",
    message: {
      role,
      content: [{ type: "text", text }],
      usage: totalTokens !== undefined
        ? { input: 10, output: 5, totalTokens }
        : undefined,
    },
  };
}

function cannedMessageUpdate(text: string) {
  return {
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      content: [{ type: "text", text }],
    },
  };
}

function cannedToolExecutionStart(name: string) {
  return {
    type: "tool_execution_start",
    toolName: name,
    toolCallId: "call_abc",
  };
}

function cannedToolExecutionEnd(name: string) {
  return {
    type: "tool_execution_end",
    toolName: name,
    result: { content: [{ type: "text", text: "ok" }] },
  };
}

function cannedToolExecutionUpdate(toolCallId: string | undefined, partial: string) {
  const ev: Record<string, unknown> = {
    type: "tool_execution_update",
    toolName: "bash",
    partial,
  };
  if (toolCallId !== undefined) {
    ev.toolCallId = toolCallId;
  }
  return ev;
}

// ── filterPiEvent tests ─────────────────────────────────────────────

describe("filterPiEvent", () => {
  // AC 1: keeps message_end with assistant role
  it("returns kept event for message_end with assistant role", () => {
    const event = cannedMessageEnd("assistant", "Hello");
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    assert.equal(typeof result, "object");
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "message_end");
    }
  });

  // AC 2: returns null for message_update text_delta events
  it("returns null for message_update text_delta events", () => {
    const event = cannedMessageUpdate("some accumulating text...");
    const line = JSON.stringify(event);
    assert.equal(filterPiEvent(line), null);
  });

  // AC 3: returns kept event for tool_execution_start, _update, _end
  it("returns kept event for tool_execution_start", () => {
    const event = cannedToolExecutionStart("bash");
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "tool_execution_start");
    }
  });

  it("returns kept event for tool_execution_end", () => {
    const event = cannedToolExecutionEnd("bash");
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "tool_execution_end");
    }
  });

  it("returns kept event for tool_execution_update", () => {
    const event = {
      type: "tool_execution_update",
      toolName: "bash",
      partial: "some output",
    };
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "tool_execution_update");
    }
  });

  // AC 4: returns null for message_end with non-assistant role
  it("returns null for message_end with non-assistant role (user)", () => {
    const event = cannedMessageEnd("user", "hello");
    const line = JSON.stringify(event);
    assert.equal(filterPiEvent(line), null);
  });

  it("returns null for message_end with non-assistant role (system)", () => {
    const event = cannedMessageEnd("system", "system prompt");
    const line = JSON.stringify(event);
    assert.equal(filterPiEvent(line), null);
  });

  // AC 5: returns null for message_start, turn_start, turn_end, agent_start, agent_end
  it("returns null for message_start", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "message_start" })), null);
  });

  it("returns null for turn_start", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "turn_start" })), null);
  });

  it("returns null for turn_end", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "turn_end" })), null);
  });

  it("returns null for agent_start", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "agent_start" })), null);
  });

  it("returns null for agent_end", () => {
    assert.equal(filterPiEvent(JSON.stringify({ type: "agent_end" })), null);
  });

  // AC 6: returns null for malformed JSON lines
  it("returns the original line (text fallback) for malformed JSON lines", () => {
    const line = "{ broken json: oops";
    const result = filterPiEvent(line);
    assert.equal(typeof result, "string");
    assert.equal(result, "{ broken json: oops");
  });

  it("returns null for empty lines", () => {
    assert.equal(filterPiEvent(""), null);
    assert.equal(filterPiEvent("  \t  "), null);
  });

  it("returns the original line (text fallback) for plain non-JSON text", () => {
    const line = "HEARTBEAT_OK";
    const result = filterPiEvent(line);
    assert.equal(result, "HEARTBEAT_OK");
  });

  it("returns text fallback for JSON objects without a type field", () => {
    const line = JSON.stringify({ foo: "bar" });
    const result = filterPiEvent(line);
    assert.equal(typeof result, "string");
  });
});

// ── SNIF: prefix fast-path tests ─────────────────────────────────────

describe("filterPiEvent — SNIF discard prefix fast-path", () => {
  // Each discard prefix returns null without JSON.parse
  it("returns null for message_update via prefix fast-path (no JSON.parse)", () => {
    const line = '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","content":[{"type":"text","text":"delta"}]}}';
    assert.equal(filterPiEvent(line), null);
  });

  it("returns null for message_start via prefix fast-path (no JSON.parse)", () => {
    assert.equal(filterPiEvent('{"type":"message_start","extra":"data"}'), null);
  });

  it("returns null for turn_start via prefix fast-path (no JSON.parse)", () => {
    assert.equal(filterPiEvent('{"type":"turn_start","extra":"data"}'), null);
  });

  it("returns null for turn_end via prefix fast-path (no JSON.parse)", () => {
    assert.equal(filterPiEvent('{"type":"turn_end","extra":"data"}'), null);
  });

  it("returns null for agent_start via prefix fast-path (no JSON.parse)", () => {
    assert.equal(filterPiEvent('{"type":"agent_start","extra":"data"}'), null);
  });

  it("returns null for agent_end via prefix fast-path (no JSON.parse)", () => {
    assert.equal(filterPiEvent('{"type":"agent_end","extra":"data"}'), null);
  });

  it("returns null for session via prefix fast-path (no JSON.parse)", () => {
    assert.equal(filterPiEvent('{"type":"session","extra":"data"}'), null);
  });

  // Invalid JSON after discard prefix returns null (not text fallback)
  it("returns null (not text fallback) for discard prefix followed by invalid JSON", () => {
    // message_update prefix followed by garbage
    const line = '{"type":"message_update"garbage{not:json}';
    assert.equal(filterPiEvent(line), null);
  });

  it("returns null (not text fallback) for turn_start followed by malformed JSON", () => {
    assert.equal(filterPiEvent('{"type":"turn_start"][broken'), null);
  });

  // Kept event types are NOT in the discard list — still go through full parse
  it("keeps message_end assistant via full parse (not in discard list)", () => {
    const event = cannedMessageEnd("assistant", "Hello from SNIF test", 42);
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    assert.equal(typeof result, "object");
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "message_end");
    }
  });

  it("keeps tool_execution_start via full parse (not in discard list)", () => {
    const event = cannedToolExecutionStart("bash");
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "tool_execution_start");
    }
  });

  it("keeps tool_execution_update via full parse (not in discard list)", () => {
    const event = { type: "tool_execution_update", toolName: "bash", partial: "output" };
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "tool_execution_update");
    }
  });

  it("keeps tool_execution_end via full parse (not in discard list)", () => {
    const event = cannedToolExecutionEnd("bash");
    const line = JSON.stringify(event);
    const result = filterPiEvent(line);
    assert.notEqual(result, null);
    if (result && typeof result === "object") {
      assert.equal((result as Record<string, unknown>).type, "tool_execution_end");
    }
  });

  // Non-JSON lines still become text fallback (not affected by SNIF)
  it("returns text fallback for plain non-JSON text (SNIF fast-path does not interfere)", () => {
    const line = "HEARTBEAT_OK";
    assert.equal(typeof filterPiEvent(line), "string");
  });

  // Unknown {"type":"..."} events still go through full parse and are discarded by keep-set
  it("returns null for unknown event type via full parse + keep-set (not in discard list)", () => {
    const line = '{"type":"some_unknown_event","data":"value"}';
    // Should be discarded (not a kept type), but goes through full parse first
    assert.equal(filterPiEvent(line), null);
  });

  // Edge: discard prefix is NOT a prefix match if type name differs
  it("does NOT match prefixes with different type names (e.g., message_updateX)", () => {
    // message_updateX is not in DISCARD_PREFIXES, so it goes through full parse
    const line = '{"type":"message_updateX","data":"value"}';
    // Goes through full parse → unknown type → discarded by keep-set → null
    assert.equal(filterPiEvent(line), null);
  });

  // Edge: lines starting with {"type":" but truncating before closing quote
  it('non-prefix-matching {"type":"... line goes through text fallback', () => {
    const line = '{"type":"message_update';
    // Does NOT start with '{"type":"message_update"' (missing closing ") → text fallback
    assert.equal(typeof filterPiEvent(line), "string");
    assert.equal(filterPiEvent(line), '{"type":"message_update');
  });
});

// ── parsePiOutputStream tests ───────────────────────────────────────

describe("parsePiOutputStream", () => {
  // AC 7: extracts assistant text from kept message_end events
  it("extracts assistant text from kept message_end events", async () => {
    const lines = [
      JSON.stringify(cannedMessageUpdate("accumulating text...")),
      JSON.stringify(cannedMessageUpdate("more text...")),
      JSON.stringify(cannedMessageEnd("assistant", "Hello, world!", 42)),
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.assistantText, "Hello, world!");
    assert.equal(result.events.length, 1); // only message_end kept
    assert.equal(result.textFallback, null);
  });

  it("uses the last assistant message_end text when multiple are present", async () => {
    const lines = [
      JSON.stringify(cannedMessageEnd("assistant", "first reply", 10)),
      JSON.stringify(cannedMessageEnd("assistant", "second reply", 20)),
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.assistantText, "second reply");
    assert.equal(result.events.length, 2);
  });

  it("keeps tool_execution events alongside message_end", async () => {
    const lines = [
      JSON.stringify(cannedToolExecutionStart("read")),
      JSON.stringify(cannedMessageUpdate("thought...")),
      JSON.stringify(cannedToolExecutionEnd("read")),
      JSON.stringify(cannedMessageEnd("assistant", "Done", 30)),
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.events.length, 3);
    assert.equal(result.assistantText, "Done");
    assert.ok(
      result.events.some((e) => e.type === "tool_execution_start"),
    );
    assert.ok(
      result.events.some((e) => e.type === "tool_execution_end"),
    );
    assert.ok(
      result.events.some((e) => e.type === "message_end"),
    );
  });

  // AC 8: handles text-mode output by returning bounded full text
  it("handles text-mode output by returning full text", async () => {
    const lines = [
      "HEARTBEAT_OK",
      "NO_WORK",
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.assistantText, "");
    assert.equal(result.events.length, 0);
    assert.notEqual(result.textFallback, null);
    assert.ok(result.textFallback!.includes("HEARTBEAT_OK"));
    assert.ok(result.textFallback!.includes("NO_WORK"));
    assert.equal(result.textFallbackTruncated, false);
  });

  it("handles mixed JSON and text-mode lines", async () => {
    const lines = [
      "some preamble",
      JSON.stringify(cannedMessageEnd("assistant", "Mixed mode", 50)),
      "trailing text",
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.assistantText, "Mixed mode");
    assert.equal(result.events.length, 1);
    assert.notEqual(result.textFallback, null);
    assert.ok(result.textFallback!.includes("some preamble"));
    assert.ok(result.textFallback!.includes("trailing text"));
  });

  // ── CAPP: tool_execution_update dedup tests ─────────────────────

  it("caps sequential updates for same toolCallId to one (last retained at first position)", async () => {
    const lines = [
      JSON.stringify(cannedMessageEnd("assistant", "Start", 10)),
      JSON.stringify(cannedToolExecutionUpdate("call_1", "chunk 1")),
      JSON.stringify(cannedToolExecutionUpdate("call_1", "chunk 2")),
      JSON.stringify(cannedToolExecutionUpdate("call_1", "chunk 3")),
      JSON.stringify(cannedToolExecutionUpdate("call_1", "chunk 4")),
      JSON.stringify(cannedToolExecutionUpdate("call_1", "chunk 5 — final")),
      JSON.stringify(cannedMessageEnd("assistant", "Done", 20)),
    ];

    const result = await parsePiOutputStream(lines);
    const updates = result.events.filter((e) => e.type === "tool_execution_update");
    assert.equal(updates.length, 1, "exactly one update retained");
    assert.equal(updates[0].toolCallId, "call_1");
    assert.equal(updates[0].partial, "chunk 5 — final");

    // Position check: the update should be at the same index as the first
    // one would have been (right after the first message_end).
    const firstUpdateIdx = result.events.findIndex((e) => e.type === "tool_execution_update");
    // The first message_end is at index 0, so the update should be at index 1
    assert.equal(firstUpdateIdx, 1, "update retained at first occurrence position");

    assert.equal(result.assistantText, "Done");
  });

  it("retains one update per toolCallId when updates are interleaved", async () => {
    const lines = [
      JSON.stringify(cannedToolExecutionUpdate("call_1", "a1")),
      JSON.stringify(cannedToolExecutionUpdate("call_2", "b1")),
      JSON.stringify(cannedToolExecutionUpdate("call_1", "a2")),
      JSON.stringify(cannedToolExecutionUpdate("call_2", "b2")),
      JSON.stringify(cannedToolExecutionUpdate("call_1", "a3 — final a")),
      JSON.stringify(cannedToolExecutionUpdate("call_2", "b3 — final b")),
      JSON.stringify(cannedMessageEnd("assistant", "Interleaved", 30)),
    ];

    const result = await parsePiOutputStream(lines);
    const updates = result.events.filter((e) => e.type === "tool_execution_update");
    assert.equal(updates.length, 2, "exactly two updates retained (one per toolCallId)");

    // Ordered by first occurrence: call_1 first, then call_2
    assert.equal(updates[0].toolCallId, "call_1");
    assert.equal(updates[0].partial, "a3 — final a");
    assert.equal(updates[1].toolCallId, "call_2");
    assert.equal(updates[1].partial, "b3 — final b");

    assert.equal(result.assistantText, "Interleaved");
  });

  it("shares single slot for updates without toolCallId field", async () => {
    const lines = [
      JSON.stringify(cannedToolExecutionUpdate(undefined, "no-id chunk 1")),
      JSON.stringify(cannedToolExecutionUpdate(undefined, "no-id chunk 2")),
      JSON.stringify(cannedToolExecutionUpdate(undefined, "no-id chunk 3 — final")),
      JSON.stringify(cannedMessageEnd("assistant", "No IDs", 15)),
    ];

    const result = await parsePiOutputStream(lines);
    const updates = result.events.filter((e) => e.type === "tool_execution_update");
    assert.equal(updates.length, 1, "exactly one update retained for no-toolCallId");
    assert.equal(updates[0].partial, "no-id chunk 3 — final");
    assert.equal(updates[0].toolCallId, undefined, "no toolCallId field present");
    assert.equal(result.assistantText, "No IDs");
  });

  it("does not cap tool_execution_start and tool_execution_end events", async () => {
    const lines = [
      JSON.stringify(cannedToolExecutionStart("bash")),
      JSON.stringify(cannedToolExecutionStart("read")),
      JSON.stringify(cannedToolExecutionStart("write")),
      JSON.stringify(cannedToolExecutionEnd("bash")),
      JSON.stringify(cannedToolExecutionEnd("read")),
      JSON.stringify(cannedToolExecutionEnd("write")),
      JSON.stringify(cannedMessageEnd("assistant", "All tools", 40)),
    ];

    const result = await parsePiOutputStream(lines);
    const starts = result.events.filter((e) => e.type === "tool_execution_start");
    const ends = result.events.filter((e) => e.type === "tool_execution_end");
    assert.equal(starts.length, 3, "all start events retained");
    assert.equal(ends.length, 3, "all end events retained");
    assert.equal(result.assistantText, "All tools");
  });

  it("end-to-end: mixed events with bounded updates, correct assistantText", async () => {
    const lines = [
      JSON.stringify(cannedToolExecutionStart("bash")),
      JSON.stringify(cannedToolExecutionUpdate("call_a", "a-chunk-1")),
      JSON.stringify(cannedToolExecutionUpdate("call_b", "b-chunk-1")),
      JSON.stringify(cannedToolExecutionUpdate("call_a", "a-chunk-2")),
      JSON.stringify(cannedToolExecutionEnd("bash")),
      JSON.stringify(cannedToolExecutionUpdate("call_b", "b-chunk-2")),
      JSON.stringify(cannedToolExecutionUpdate("call_c", "c-only")),
      JSON.stringify(cannedToolExecutionStart("read")),
      JSON.stringify(cannedToolExecutionUpdate("call_a", "a-chunk-3 — final")),
      JSON.stringify(cannedToolExecutionUpdate("call_b", "b-chunk-3 — final")),
      JSON.stringify(cannedToolExecutionEnd("read")),
      JSON.stringify(cannedMessageEnd("assistant", "E2E result", 60)),
    ];

    const result = await parsePiOutputStream(lines);

    // Assistant text intact
    assert.equal(result.assistantText, "E2E result");

    // All start/end events retained
    assert.equal(result.events.filter((e) => e.type === "tool_execution_start").length, 2);
    assert.equal(result.events.filter((e) => e.type === "tool_execution_end").length, 2);

    // Updates capped: exactly 3 (one per toolCallId: call_a, call_b, call_c)
    const updates = result.events.filter((e) => e.type === "tool_execution_update");
    assert.equal(updates.length, 3);

    // Each has the final value
    const a = updates.find((e) => e.toolCallId === "call_a")!;
    assert.equal(a.partial, "a-chunk-3 — final");
    const b = updates.find((e) => e.toolCallId === "call_b")!;
    assert.equal(b.partial, "b-chunk-3 — final");
    const c = updates.find((e) => e.toolCallId === "call_c")!;
    assert.equal(c.partial, "c-only");

    // message_end present
    assert.ok(result.events.some((e) => e.type === "message_end"));

    // Total events: 2 starts + 2 ends + 3 updates + 1 message_end = 8
    assert.equal(result.events.length, 8);

    // No text fallback
    assert.equal(result.textFallback, null);
  });

  it("keeps event array small when processing large volume of discarded events", async () => {
    // Simulate 10000 message_update lines (text_delta) plus one real message_end
    const lines: string[] = [];
    const largeString = "x".repeat(1000);
    for (let i = 0; i < 10000; i++) {
      lines.push(JSON.stringify(cannedMessageUpdate(`delta ${i}: ${largeString}`)));
    }
    lines.push(JSON.stringify(cannedMessageEnd("assistant", "Final answer", 100)));

    const result = await parsePiOutputStream(lines);
    assert.equal(result.events.length, 1); // only message_end kept
    assert.equal(result.assistantText, "Final answer");
    assert.equal(result.textFallback, null);
  });

  it("caps text-mode fallback at MAX_TEXT_FALLBACK_BYTES", async () => {
    // Create lines that will exceed the text cap
    const bigLine = "x".repeat(2 * 1024 * 1024); // 2MB per line
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`${bigLine}-${i}`);
    }

    const result = await parsePiOutputStream(lines);
    assert.equal(result.textFallbackTruncated, true);
    assert.notEqual(result.textFallback, null);
    // Should be at or under the cap
    const fallbackBytes = Buffer.byteLength(result.textFallback!, "utf-8");
    assert.ok(
      fallbackBytes <= MAX_TEXT_FALLBACK_BYTES,
      `text fallback was ${fallbackBytes} bytes, expected <= ${MAX_TEXT_FALLBACK_BYTES}`,
    );
    // The truncation warning must have landed in the temp log (previously
    // the guard silently dropped this write at the real ~/.tamandua).
    const logFile = path.join(stateDir, "tamandua.log");
    assert.ok(fs.existsSync(logFile), `parser must log truncation into the temp state (${logFile})`);
    const logContent = fs.readFileSync(logFile, "utf-8");
    assert.ok(
      logContent.includes("pi text-mode output exceeded cap"),
      `expected truncation warning in the temp log, got:\n${logContent}`,
    );
  });

  it("handles empty input", async () => {
    const result = await parsePiOutputStream([]);
    assert.equal(result.events.length, 0);
    assert.equal(result.assistantText, "");
    assert.equal(result.textFallback, null);
    assert.equal(result.textFallbackTruncated, false);
  });

  it("discards user and system message_end events but keeps assistant ones", async () => {
    const lines = [
      JSON.stringify(cannedMessageEnd("user", "user msg")),
      JSON.stringify(cannedMessageEnd("system", "system msg")),
      JSON.stringify(cannedMessageEnd("assistant", "actual response", 25)),
    ];

    const result = await parsePiOutputStream(lines);
    assert.equal(result.events.length, 1);
    assert.equal(result.assistantText, "actual response");
  });
});
