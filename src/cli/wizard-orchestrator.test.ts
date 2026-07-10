/**
 * Tests for wizard-orchestrator.ts
 *
 * Tests import from dist/ (not src/) matching the project convention.
 * All I/O dependencies (terminal, pi spawn, command spawn) are faked.
 * No real pi invocations.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTempHome } from "../../tests/helpers/test-env.ts";

import type { PiSpawnFn } from "../../dist/cli/wizard-evaluator.js";
import {
  runWizard,
  type WizardTerminal,
  type CommandSpawnFn,
} from "../../dist/cli/wizard-orchestrator.js";

// ── Types for fake child processes ──────────────────────────────────

interface FakeChildProcess extends EventEmitter {
  stdout: Readable | null;
  stderr: Readable | null;
}

// ── Fake terminal ──────────────────────────────────────────────────

interface FakeTerminal extends WizardTerminal {
  /** All lines printed via print(). */
  output: string[];
  /**
   * Pre-programmed answers for question/confirm/choice prompts.
   * Each entry is consumed in order. If exhausted, returns "".
   */
  answers: string[];
  /** Record of prompts asked via question(). */
  questionPrompts: string[];
  /** Record of prompts asked via confirm(). */
  confirmPrompts: string[];
  /** Record of prompts asked via choice(). */
  choicePrompts: string[];
}

function createFakeTerminal(answers: string[]): FakeTerminal {
  let answerIndex = 0;

  const t: FakeTerminal = {
    output: [],
    answers,
    questionPrompts: [],
    confirmPrompts: [],
    choicePrompts: [],

    print(line: string): void {
      t.output.push(line);
    },

    async question(prompt: string): Promise<string> {
      t.questionPrompts.push(prompt);
      const a = answerIndex < t.answers.length ? t.answers[answerIndex++] : "";
      return a;
    },

    async confirm(prompt: string): Promise<boolean> {
      t.confirmPrompts.push(prompt);
      const a = answerIndex < t.answers.length ? t.answers[answerIndex++] : "";
      const lower = a.toLowerCase();
      if (lower === "y" || lower === "yes") return true;
      if (lower === "n" || lower === "no") return false;
      // Default: treat as no
      return false;
    },

    async choice(prompt: string, _options: string[]): Promise<string> {
      t.choicePrompts.push(prompt);
      const a = answerIndex < t.answers.length ? t.answers[answerIndex++] : "";
      return a.toLowerCase();
    },

    close(): void {
      // no-op
    },
  };

  return t;
}

// ── Fake pi spawn ──────────────────────────────────────────────────

/** Build a message_end event line for an assistant message. */
function assistantMessageEndLine(text: string): string {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  });
}

function fakeChildProcessWithOutput(jsonlLines: string[]): FakeChildProcess {
  const emitter = new EventEmitter() as FakeChildProcess;
  const stdout = new PassThrough();
  for (const line of jsonlLines) {
    stdout.write(line + "\n");
  }
  stdout.end();
  emitter.stdout = stdout;
  emitter.stderr = new PassThrough();
  (emitter.stderr as PassThrough).end();
  setImmediate(() => emitter.emit("close", 0));
  return emitter;
}

function fakePiSpawn(child: FakeChildProcess): PiSpawnFn {
  return (_command: string, _args: string[], _options: unknown) => {
    return child as unknown as import("node:child_process").ChildProcess;
  };
}

// ── Fake command spawn ─────────────────────────────────────────────

interface FakeCommandSpawn extends CommandSpawnFn {
  /** All commands that were spawned. */
  spawnedCommands: Array<{ command: string; args: string[] }>;
  /** Pre-programmed exit codes for each spawn call. */
  exitCodes: number[];
  callCount: number;
}

function createFakeCommandSpawn(exitCodes: number[]): FakeCommandSpawn {
  const fn = ((command: string, args: string[], _options: unknown) => {
    const code = fn.callCount < fn.exitCodes.length
      ? fn.exitCodes[fn.callCount]
      : 0;
    fn.spawnedCommands.push({ command, args });
    fn.callCount++;

    const emitter = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
    // Emit close on next tick so the orchestrator can attach its
    // "close" listener first.
    setImmediate(() => emitter.emit("close", code));
    return emitter;
  }) as FakeCommandSpawn;

  fn.spawnedCommands = [];
  fn.exitCodes = exitCodes;
  fn.callCount = 0;
  return fn;
}

// ── Isolated temp dir for cwd ──────────────────────────────────────

function makeTempDir(): string {
  return createTempHome("wizard-test-").root;
}

// ── Tests ──────────────────────────────────────────────────────────

describe("runWizard", () => {
  // --- Follow-up question loop ---

  it("loops through follow-up questions when pi returns ready:false", async () => {
    const notReady1 = {
      ready: false,
      question: "What metric do you want to optimize?",
      reason: "Missing metric",
    };
    const notReady2 = {
      ready: false,
      question: "What direction (lower/higher)?",
      reason: "Missing direction",
    };
    const ready = {
      ready: true,
      commentary: "All clear.",
      needsInit: true,
      initArgv: ["autoresearch", "init", "--goal", "speed", "--metric", "ms", "--direction", "lower", "--command", "./bench.sh"],
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };

    // Three pi calls: two not-ready, one ready
    const spawn1 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(notReady1)),
    ]);
    const spawn2 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(notReady2)),
    ]);
    const spawn3 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);

    const spawns = [spawn1, spawn2, spawn3];
    let callIdx = 0;
    const piSpawn: PiSpawnFn = (_cmd, _args, _opts) => {
      return spawns[callIdx++] as unknown as import("node:child_process").ChildProcess;
    };

    const terminal = createFakeTerminal([
      "I want to speed up tests", // first answer
      "ms",                       // metric
      "lower",                    // direction
      "y",                        // confirm launch
    ]);

    const cmdSpawn = createFakeCommandSpawn([0, 0]);

    const tempDir = makeTempDir();
    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should have asked 3 questions (first + 2 follow-up)
    // The "y" is consumed by confirm, not question
    assert.ok(terminal.questionPrompts.length >= 3,
      `Expected >= 3 question prompts, got ${terminal.questionPrompts.length}`);
    assert.ok(terminal.output.some(l => l.includes(notReady1.question)));
    assert.ok(terminal.output.some(l => l.includes(notReady2.question)));
    assert.ok(terminal.output.some(l => l.includes(ready.commentary)));
    assert.ok(terminal.output.some(l => l.includes("Pasteable command line")));
  });

  // --- Ready without init displays commentary and single loop command ---

  it("displays commentary and single loop command when init not needed", async () => {
    // Create a temp dir with a fake autoresearch config to simulate "already initialized"
    const tempDir = makeTempDir();
    fs.writeFileSync(
      path.join(tempDir, "autoresearch.config.json"),
      JSON.stringify({
        goal: "speed",
        metricName: "ms",
        direction: "lower",
        command: "./autoresearch.sh",
      }),
    );

    const ready = {
      ready: true,
      commentary: "Already initialized — proceeding to loop.",
      needsInit: false,
      initArgv: null,
      loopArgv: ["autoresearch", "loop", "--prompt", "--max-iterations", "25"],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "speed up tests", // first answer
      "y",              // confirm launch
    ]);
    const cmdSpawn = createFakeCommandSpawn([0]);

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Display should show single loop command (no init)
    assert.ok(terminal.output.some(l => l.includes(ready.commentary)));
    assert.ok(terminal.output.some(l => l.includes("Pasteable command line")));
    const displayLine = terminal.output.join("\n");
    assert.ok(!displayLine.includes(" ; "), "Should not have init;loop separator");
    assert.ok(displayLine.includes("loop"), "Should include loop command");

    // Should have spawned only the loop command (no init)
    assert.equal(cmdSpawn.spawnedCommands.length, 1);
    assert.deepEqual(cmdSpawn.spawnedCommands[0].args, [
      "autoresearch",
      "loop",
      "--prompt",
      "--max-iterations",
      "25",
    ]);
  });

  // --- Ready with init displays init;loop and executes init before loop ---

  it("displays init;loop and executes init before loop when init needed", async () => {
    const tempDir = makeTempDir();

    const ready = {
      ready: true,
      commentary: "Setting up new AutoResearch session.",
      needsInit: true,
      initArgv: [
        "autoresearch",
        "init",
        "--goal",
        "speed up tests",
        "--metric",
        "total_ms",
        "--direction",
        "lower",
        "--command",
        "./autoresearch.sh",
      ],
      loopArgv: [
        "autoresearch",
        "loop",
        "--prompt",
        "--max-iterations",
        "25",
      ],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "speed up tests with ms metric", // first answer
      "y",                              // confirm launch
    ]);
    const cmdSpawn = createFakeCommandSpawn([0, 0]); // init=0, loop=0

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    assert.ok(terminal.output.some(l => l.includes(ready.commentary)));
    assert.ok(terminal.output.some(l => l.includes("Pasteable command line")));
    const displayLine = terminal.output.join("\n");
    assert.ok(displayLine.includes(" ; "), "Should have init;loop separator");

    // Should have spawned two commands: init then loop
    assert.equal(cmdSpawn.spawnedCommands.length, 2);
    assert.deepEqual(cmdSpawn.spawnedCommands[0].args, [
      "autoresearch",
      "init",
      "--goal",
      "speed up tests",
      "--metric",
      "total_ms",
      "--direction",
      "lower",
      "--command",
      "./autoresearch.sh",
    ]);
    assert.deepEqual(cmdSpawn.spawnedCommands[1].args, [
      "autoresearch",
      "loop",
      "--prompt",
      "--max-iterations",
      "25",
    ]);
  });

  // --- Init failure prevents loop launch ---

  it("stops after init failure and does not start loop", async () => {
    const tempDir = makeTempDir();

    const ready = {
      ready: true,
      commentary: "New session needed.",
      needsInit: true,
      initArgv: ["autoresearch", "init", "--goal", "goal", "--metric", "ms", "--direction", "lower", "--command", "./autoresearch.sh"],
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "speed up tests", // first answer
      "y",              // confirm launch
    ]);
    const cmdSpawn = createFakeCommandSpawn([1]); // init fails

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should have ONLY spawned init (not loop)
    assert.equal(cmdSpawn.spawnedCommands.length, 1);
    assert.deepEqual(cmdSpawn.spawnedCommands[0].args, [
      "autoresearch",
      "init",
      "--goal",
      "goal",
      "--metric",
      "ms",
      "--direction",
      "lower",
      "--command",
      "./autoresearch.sh",
    ]);
    assert.ok(
      terminal.output.some((l) => l.includes("Init failed")),
      "Should print init failure message",
    );
    assert.ok(
      terminal.output.some((l) => l.includes("Not starting loop")),
      "Should indicate loop not started",
    );
  });

  // --- Decline / abort ---

  it("aborts cleanly when user says no then abort", async () => {
    const tempDir = makeTempDir();

    const ready = {
      ready: true,
      commentary: "Ready.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "speed up tests",
      "n",     // don't launch
      "abort", // choice: abort
    ]);
    const cmdSpawn = createFakeCommandSpawn([]);

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    assert.equal(cmdSpawn.spawnedCommands.length, 0);
    assert.ok(
      terminal.output.some((l) => l.includes("Aborting")),
      "Should show abort message",
    );
  });

  // --- Decline / adjust ---

  it("adjusts and re-evaluates when user says no then adjust", async () => {
    const tempDir = makeTempDir();

    const ready1 = {
      ready: true,
      commentary: "First pass.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    const ready2 = {
      ready: true,
      commentary: "Adjusted pass.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt", "--max-iterations", "10"],
    };

    const child1 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready1)),
    ]);
    const child2 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready2)),
    ]);

    const children = [child1, child2];
    let callIdx = 0;
    const piSpawn: PiSpawnFn = (_cmd, _args, _opts) => {
      return children[callIdx++] as unknown as import("node:child_process").ChildProcess;
    };

    const terminal = createFakeTerminal([
      "speed up tests",       // first answer
      "n",                     // don't launch first time
      "adjust",                // choose adjust
      "use fewer iterations",  // adjustment text
      "nothing else to add",   // answer to re-eval question
      "y",                     // confirm launch second time
    ]);
    const cmdSpawn = createFakeCommandSpawn([0]);

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should have spawned the adjusted loop command
    assert.equal(cmdSpawn.spawnedCommands.length, 1);
    assert.deepEqual(cmdSpawn.spawnedCommands[0].args, [
      "autoresearch",
      "loop",
      "--prompt",
      "--max-iterations",
      "10",
    ]);

    // Should have shown both commentaries
    assert.ok(terminal.output.some(l => l.includes("First pass")));
    assert.ok(terminal.output.some(l => l.includes("Adjusted pass")));
  });

  // --- Error recovery: pi returns invalid commands ---

  it("recovers when pi returns invalid loopArgv and re-evaluates", async () => {
    const tempDir = makeTempDir();

    // First: invalid commands (missing --prompt)
    const invalidReady = {
      ready: true,
      commentary: "Invalid pass.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--max-iterations", "25"],
    };
    // Second: valid
    const validReady = {
      ready: true,
      commentary: "Valid pass.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt", "--max-iterations", "25"],
    };

    const child1 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(invalidReady)),
    ]);
    const child2 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(validReady)),
    ]);

    const children = [child1, child2];
    let callIdx = 0;
    const piSpawn: PiSpawnFn = (_cmd, _args, _opts) => {
      return children[callIdx++] as unknown as import("node:child_process").ChildProcess;
    };

    const terminal = createFakeTerminal([
      "speed up tests",
      "let me describe differently",  // re-evaluation response
      "y",                             // confirm launch
    ]);
    const cmdSpawn = createFakeCommandSpawn([0]);

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should have printed error about invalid commands
    assert.ok(
      terminal.output.some(l => l.includes("invalid commands")),
      "Should show invalid command error",
    );

    // Should eventually spawn the valid loop
    assert.equal(cmdSpawn.spawnedCommands.length, 1);
    assert.deepEqual(cmdSpawn.spawnedCommands[0].args, [
      "autoresearch",
      "loop",
      "--prompt",
      "--max-iterations",
      "25",
    ]);
  });

  // --- Error recovery: pi spawn/evaluation fails ---

  it("recovers when pi evaluation throws and re-evaluates", async () => {
    const tempDir = makeTempDir();

    // First pi call: no assistant text (will throw)
    const child1 = fakeChildProcessWithOutput([]);

    // Second pi call: valid
    const ready = {
      ready: true,
      commentary: "Recovered.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    const child2 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);

    const children = [child1, child2];
    let callIdx = 0;
    const piSpawn: PiSpawnFn = (_cmd, _args, _opts) => {
      return children[callIdx++] as unknown as import("node:child_process").ChildProcess;
    };

    const terminal = createFakeTerminal([
      "speed up tests",
      "use a bash script that echoes the metric", // clarification response
      "y",                                        // confirm launch
    ]);
    const cmdSpawn = createFakeCommandSpawn([0]);

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should show error recovery message
    assert.ok(
      terminal.output.some(l => l.includes("Error evaluating response")),
      "Should show evaluation error",
    );

    // Should eventually spawn the valid command
    assert.equal(cmdSpawn.spawnedCommands.length, 1);
  });

  // --- Prints AutoResearch explanation before first question ---

  it("prints AutoResearch explanation before first question", async () => {
    const tempDir = makeTempDir();

    const ready = {
      ready: true,
      commentary: "Done.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "speed up tests",
      "y",
    ]);
    const cmdSpawn = createFakeCommandSpawn([0]);

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // First output lines should contain the explanation
    const firstOutputs = terminal.output.slice(0, 15).join("\n");
    assert.ok(firstOutputs.includes("AutoResearch lets Tamandua"));
    assert.ok(firstOutputs.includes("autoresearch init"));
    assert.ok(firstOutputs.includes("autoresearch loop --prompt"));
  });

  // --- Handles empty answer gracefully ---

  it("handles empty answer by prompting for information", async () => {
    const tempDir = makeTempDir();

    const ready = {
      ready: true,
      commentary: "Done.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "",             // empty first answer
      "speed up tests", // valid second answer
      "y",            // confirm launch
    ]);
    const cmdSpawn = createFakeCommandSpawn([0]);

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should show "no response received" message
    assert.ok(
      terminal.output.some(l => l.includes("No response received")),
      "Should prompt for info on empty answer",
    );

    // Should eventually succeed
    assert.equal(cmdSpawn.spawnedCommands.length, 1);
  });

  // --- adjust with empty changes text re-prompts first question ---

  it("handles adjust with empty changes text and re-prompts", async () => {
    const tempDir = makeTempDir();

    const ready1 = {
      ready: true,
      commentary: "First pass.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };
    const ready2 = {
      ready: true,
      commentary: "Second pass.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt", "--max-iterations", "5"],
    };

    const child1 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready1)),
    ]);
    const child2 = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready2)),
    ]);

    const children = [child1, child2];
    let callIdx = 0;
    const piSpawn: PiSpawnFn = (_cmd, _args, _opts) => {
      return children[callIdx++] as unknown as import("node:child_process").ChildProcess;
    };

    const terminal = createFakeTerminal([
      "speed up tests",
      "n",        // don't launch
      "adjust",   // choose adjust
      "",         // empty adjustment
      "use less iterations", // actual adjustment (after re-prompt)
      "y",        // confirm launch
    ]);
    const cmdSpawn = createFakeCommandSpawn([0]);

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should show "No changes specified" message
    assert.ok(
      terminal.output.some(l => l.includes("No changes specified")),
      "Should note empty adjustment",
    );

    // Should eventually launch
    assert.equal(cmdSpawn.spawnedCommands.length, 1);
  });

  // --- spawnAndWait error handler (command emits error, not close) ---

  it("handles init command spawn error gracefully", async () => {
    const tempDir = makeTempDir();

    const ready = {
      ready: true,
      commentary: "Ready.",
      needsInit: true,
      initArgv: ["autoresearch", "init", "--goal", "speed", "--metric", "ms", "--direction", "lower", "--command", "./autoresearch.sh"],
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "speed up tests",
      "y",
    ]);

    // Command spawn that emits error instead of close
    const cmdSpawn = ((command: string, args: string[], _options: unknown) => {
      const emitter = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
      setImmediate(() => emitter.emit("error", new Error("spawn ENOENT")));
      return emitter;
    }) as CommandSpawnFn;

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should show init failure from error (not exit code)
    assert.ok(
      terminal.output.some((l) => l.includes("Init failed")),
      "Should print init failure message on spawn error",
    );
  });

  // --- Loop command returns non-zero exit code ---

  it("handles loop command non-zero exit code", async () => {
    const tempDir = makeTempDir();

    const ready = {
      ready: true,
      commentary: "Done.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "speed up tests",
      "y",
    ]);
    const cmdSpawn = createFakeCommandSpawn([2]); // loop exits with code 2

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should show loop exit code message
    assert.ok(
      terminal.output.some((l) => l.includes("Loop exited with code 2")),
      "Should print loop exit code",
    );
  });

  // --- Loop command emits error instead of close ---

  it("handles loop command spawn error gracefully", async () => {
    const tempDir = makeTempDir();

    const ready = {
      ready: true,
      commentary: "Done.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "speed up tests",
      "y",
    ]);

    // Spawn that succeeds for pi but errors for loop command
    let spawnCount = 0;
    const cmdSpawn = ((command: string, args: string[], _options: unknown) => {
      spawnCount++;
      const emitter = new EventEmitter() as unknown as import("node:child_process").ChildProcess;
      // Emit error instead of close
      setImmediate(() => emitter.emit("error", new Error("spawn EACCES")));
      return emitter;
    }) as CommandSpawnFn;

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Should show loop failure message
    assert.ok(
      terminal.output.some((l) => l.includes("Loop failed")),
      "Should print loop failure message on spawn error",
    );
  });

  // --- Uses custom binary name ---

  it("uses custom binary name for spawned commands", async () => {
    const tempDir = makeTempDir();

    const ready = {
      ready: true,
      commentary: "Done.",
      needsInit: false,
      loopArgv: ["autoresearch", "loop", "--prompt"],
    };

    const child = fakeChildProcessWithOutput([
      assistantMessageEndLine(JSON.stringify(ready)),
    ]);
    const piSpawn = fakePiSpawn(child);
    const terminal = createFakeTerminal([
      "speed up tests",
      "y",
    ]);
    const cmdSpawn = createFakeCommandSpawn([0]);

    try {
      await runWizard({
        cwd: tempDir,
        binaryName: "my-tamandua",
        piSpawn,
        terminal,
        commandSpawn: cmdSpawn,
      });
    } finally {
    }

    // Spawned command should use custom binary name
    assert.equal(cmdSpawn.spawnedCommands.length, 1);
    assert.equal(cmdSpawn.spawnedCommands[0].command, "my-tamandua");
  });
});
