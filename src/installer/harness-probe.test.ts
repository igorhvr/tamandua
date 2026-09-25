/**
 * Launch-time harness probe policy (IFLB US-002) — pure policy + DB helpers.
 *
 * Covers, per the story acceptance criteria:
 *  - pass evaluation: the probe passes when the final message contains the
 *    expected path as a whole line or token; wrong output fails
 *  - normalization: a backtick/code-fence-wrapped path passes after stripping
 *  - the round evaluator: non-zero exit, signal death, wall exceeded, and
 *    wrong output all fail
 *  - config getters: TAMANDUA_HARNESS_PROBE=0 disables, wall override honored
 *  - buildHarnessProbeFailureBlock: every key in order, STDERR_TAIL last,
 *    OBSERVED <= 400 / STDERR_TAIL <= 2000 character caps
 *  - computeExpectedHarnessProbePath: `<launcher> skill-path` really prints
 *    the same path resolveSkillPath() computes (and fails on non-zero exit)
 *  - once-per-run DB helpers: exactly one caller wins the atomic reserve,
 *    a recorded 'ok' persists across a DB re-open (simulated daemon
 *    restart) so a passed run is never re-probed, and stale in-flight
 *    'probing' reservations are re-reservable after the wall.
 *
 * This file lives in the SERIAL lane (tests/serial-files.txt): it imports
 * harness-probe.ts, which owns the child-process expected-value
 * computation (spawnSync of the real `<launcher> skill-path`), matching the
 * classification rule for process-spawning source modules.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { closeDb, getDb } from "../../dist/db.js";
import {
  HARNESS_PROBE_MARKER,
  DEFAULT_HARNESS_PROBE_WALL_MS,
  HARNESS_PROBE_OBSERVED_MAX_CHARS,
  HARNESS_PROBE_STDERR_TAIL_MAX_CHARS,
  HARNESS_PROBE_HINT_MAX_CHARS,
  buildHarnessProbePrompt,
  buildHarnessProbeCommand,
  isHarnessProbeEnabled,
  getHarnessProbeWallMs,
  computeExpectedHarnessProbePath,
  normalizeHarnessProbeMessage,
  passesHarnessProbe,
  evaluateHarnessProbe,
  buildHarnessProbeFailureBlock,
  matchlockProbeHint,
  reserveHarnessProbe,
  recordHarnessProbeResult,
  readHarnessProbeStatus,
  resetFailedHarnessProbeForResume,
  type HarnessProbeAdapterResult,
  type HarnessProbeFailureFields,
} from "../../dist/installer/harness-probe.js";
import { resolveSkillPath, resolveTamanduaCli } from "../../dist/installer/paths.js";
import { tamanduaTempDir } from "../../dist/lib/temp-dir.js";
import { assertStatePathIsolation } from "../../dist/lib/test-guard.js";
import { cleanChildEnv } from "../../tests/helpers/test-env.ts";

// ── env helpers ─────────────────────────────────────────────────────

const savedEnv = new Map<string, string | undefined>();
function saveEnv(name: string): void {
  savedEnv.set(name, process.env[name]);
}
function restoreSavedEnv(): void {
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
}

// ── config getters ──────────────────────────────────────────────────

describe("harness-probe config getters (IFLB)", () => {
  afterEach(() => {
    restoreSavedEnv();
  });

  it("is enabled by default (no TAMANDUA_HARNESS_PROBE set)", () => {
    delete process.env.TAMANDUA_HARNESS_PROBE;
    assert.equal(isHarnessProbeEnabled(), true);
  });

  it("TAMANDUA_HARNESS_PROBE=0 disables the probe", () => {
    saveEnv("TAMANDUA_HARNESS_PROBE");
    process.env.TAMANDUA_HARNESS_PROBE = "0";
    assert.equal(isHarnessProbeEnabled(), false);
  });

  it("any non-'0' TAMANDUA_HARNESS_PROBE value keeps the probe enabled", () => {
    saveEnv("TAMANDUA_HARNESS_PROBE");
    process.env.TAMANDUA_HARNESS_PROBE = "1";
    assert.equal(isHarnessProbeEnabled(), true);
    process.env.TAMANDUA_HARNESS_PROBE = "false";
    assert.equal(isHarnessProbeEnabled(), true, "arbitrary non-zero text stays enabled");
    process.env.TAMANDUA_HARNESS_PROBE = "0 "; // whitespace-padded '0' still disables (value is trimmed)
    assert.equal(isHarnessProbeEnabled(), false, "the value is trimmed before the '0' comparison");
  });

  it("default wall is 180s", () => {
    delete process.env.TAMANDUA_HARNESS_PROBE_WALL_MS;
    assert.equal(getHarnessProbeWallMs(), DEFAULT_HARNESS_PROBE_WALL_MS);
    assert.equal(DEFAULT_HARNESS_PROBE_WALL_MS, 180_000);
  });

  it("TAMANDUA_HARNESS_PROBE_WALL_MS positive-integer override is honored", () => {
    saveEnv("TAMANDUA_HARNESS_PROBE_WALL_MS");
    process.env.TAMANDUA_HARNESS_PROBE_WALL_MS = "30000";
    assert.equal(getHarnessProbeWallMs(), 30000);
  });

  it("invalid TAMANDUA_HARNESS_PROBE_WALL_MS overrides fall back to the default", () => {
    saveEnv("TAMANDUA_HARNESS_PROBE_WALL_MS");
    process.env.TAMANDUA_HARNESS_PROBE_WALL_MS = "not-a-number";
    assert.equal(getHarnessProbeWallMs(), DEFAULT_HARNESS_PROBE_WALL_MS);
    process.env.TAMANDUA_HARNESS_PROBE_WALL_MS = "-5";
    assert.equal(getHarnessProbeWallMs(), DEFAULT_HARNESS_PROBE_WALL_MS);
    process.env.TAMANDUA_HARNESS_PROBE_WALL_MS = "0";
    assert.equal(getHarnessProbeWallMs(), DEFAULT_HARNESS_PROBE_WALL_MS);
  });
});

// ── prompt / command ────────────────────────────────────────────────

describe("harness-probe prompt and command (IFLB)", () => {
  it("buildHarnessProbeCommand uses the absolute launcher, never a bare tamandua", () => {
    const cmd = buildHarnessProbeCommand();
    assert.equal(cmd, `${resolveTamanduaCli()} skill-path`);
    assert.ok(cmd.startsWith("/"), "launcher must be an absolute path");
    assert.ok(cmd.includes("bin/tamandua"), `expected the CLI launcher, got: ${cmd}`);
    assert.ok(!cmd.includes("\n"), "command must be a single line");
  });

  it("buildHarnessProbePrompt has the stable marker on line 1 and quotes the exact command", () => {
    const prompt = buildHarnessProbePrompt();
    const [first, second] = prompt.split("\n");
    assert.equal(first, HARNESS_PROBE_MARKER);
    assert.ok(second.includes(`"${buildHarnessProbeCommand()}"`), `line 2 must quote the exact command: ${second}`);
    assert.ok(second.includes("reply with the PATH and nothing else"));
  });
});

// ── normalization and pass evaluation ───────────────────────────────

describe("harness-probe message normalization (IFLB)", () => {
  it("trims surrounding whitespace", () => {
    assert.equal(normalizeHarnessProbeMessage("  \n /skills/SKILL.md \n  "), "/skills/SKILL.md");
  });

  it("strips a backtick-wrapped path", () => {
    assert.equal(normalizeHarnessProbeMessage("`/skills/SKILL.md`"), "/skills/SKILL.md");
  });

  it("strips a code fence around the path", () => {
    assert.equal(normalizeHarnessProbeMessage("```\n/skills/SKILL.md\n```"), "/skills/SKILL.md");
  });

  it("strips a fenced path carrying a language tag", () => {
    assert.equal(normalizeHarnessProbeMessage("```text\n/skills/SKILL.md\n```"), "/skills/SKILL.md");
  });

  it("strips inline backticks while preserving surrounding text", () => {
    assert.equal(normalizeHarnessProbeMessage("The path is `/skills/SKILL.md` here"), "The path is /skills/SKILL.md here");
  });
});

describe("harness-probe pass evaluation (IFLB)", () => {
  it("passes when the final message is exactly the expected path (whole line)", () => {
    assert.equal(passesHarnessProbe("/skills/SKILL.md", "/skills/SKILL.md"), true);
  });

  it("passes when the expected path appears as a whole token among other text", () => {
    assert.equal(passesHarnessProbe("PATH: /skills/SKILL.md", "/skills/SKILL.md"), true);
    assert.equal(passesHarnessProbe("here you go\n/skills/SKILL.md thanks", "/skills/SKILL.md"), true);
  });

  it("fails on wrong output", () => {
    assert.equal(passesHarnessProbe("/other/path", "/skills/SKILL.md"), false);
    assert.equal(passesHarnessProbe("", "/skills/SKILL.md"), false);
  });

  it("fails when the expected path is only a substring of a longer token", () => {
    // "/skills/SKILL.md-extra" is one token — it must NOT match "/skills/SKILL.md".
    assert.equal(passesHarnessProbe("/skills/SKILL.md-extra", "/skills/SKILL.md"), false);
    // "/skills/SKILL.md." glues the path to a period — one token, no match.
    assert.equal(passesHarnessProbe("found /skills/SKILL.md.", "/skills/SKILL.md"), false);
  });

  it("fails when the expected path is a substring inside a longer whole line without token boundary", () => {
    // No whitespace boundary between the path and its prefix — not a token.
    assert.equal(passesHarnessProbe("x/skills/SKILL.md", "/skills/SKILL.md"), false);
  });

  it("fails on an empty expected path", () => {
    assert.equal(passesHarnessProbe("/anything", ""), false);
  });

  it("a backtick/code-fence-wrapped path passes after normalization", () => {
    const fenced = normalizeHarnessProbeMessage("```\n/skills/SKILL.md\n```");
    assert.equal(fenced, "/skills/SKILL.md");
    assert.equal(passesHarnessProbe(fenced, "/skills/SKILL.md"), true);
    const inline = normalizeHarnessProbeMessage("`/skills/SKILL.md`");
    assert.equal(passesHarnessProbe(inline, "/skills/SKILL.md"), true);
  });
});

// ── round evaluator ─────────────────────────────────────────────────

describe("harness-probe round evaluator (IFLB)", () => {
  const EXPECTED = "/skills/tamandua-agents/SKILL.md";
  const PROBE_CMD = `${resolveTamanduaCli()} skill-path`;

  function evalWith(adapter: HarnessProbeAdapterResult) {
    return evaluateHarnessProbe({
      harness: "pi",
      probeCmd: PROBE_CMD,
      expectedPath: EXPECTED,
      wallMs: 180_000,
      adapter,
    });
  }

  it("passes when the output contains the expected path and the round is clean", () => {
    const outcome = evalWith({
      output: EXPECTED,
      exitCode: 0,
      durationMs: 120,
      stderrTail: "",
    });
    assert.equal(outcome.passed, true);
    assert.equal(outcome.failure, undefined);
  });

  it("passes when a fenced path is returned cleanly", () => {
    const outcome = evalWith({
      output: `\`\`\`\n${EXPECTED}\n\`\`\``,
      exitCode: 0,
      durationMs: 90,
    });
    assert.equal(outcome.passed, true, "fence-wrapped output must normalize and pass");
  });

  it("fails on wrong output, carrying the normalized observed message", () => {
    const outcome = evalWith({
      output: "No API key found for the selected model",
      exitCode: 1,
      durationMs: 310,
      stderrTail: "auth failure",
    });
    assert.equal(outcome.passed, false);
    assert.ok(outcome.failure, "failure fields must be present");
    assert.equal(outcome.failure!.observed, "No API key found for the selected model");
    assert.equal(outcome.failure!.expected, EXPECTED);
    assert.equal(outcome.failure!.harness, "pi");
    assert.equal(outcome.failure!.probeCmd, PROBE_CMD);
    assert.equal(outcome.failure!.exitCode, 1);
    assert.equal(outcome.failure!.stderrTail, "auth failure");
  });

  it("normalizes the observed message for the failure block", () => {
    const outcome = evalWith({
      output: "```\nnot-the-path\n```",
      exitCode: 1,
      durationMs: 5,
    });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.failure!.observed, "not-the-path", "fences must be stripped from OBSERVED");
  });

  it("fails on a non-zero exit even when the output is correct", () => {
    const outcome = evalWith({ output: EXPECTED, exitCode: 2, durationMs: 90 });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.failure!.exitCode, 2);
  });

  it("fails on signal death (no exit code, signal present)", () => {
    const outcome = evalWith({ output: "", exitCode: null, signal: "SIGKILL", durationMs: 40 });
    assert.equal(outcome.passed, false);
    assert.equal(outcome.failure!.signal, "SIGKILL");
    assert.equal(outcome.failure!.exitCode, null);
  });

  it("fails when the wall is exceeded via the adapter timeout flag", () => {
    const outcome = evalWith({
      output: EXPECTED,
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      durationMs: 180_001,
    });
    assert.equal(outcome.passed, false, "a timed-out round must fail even with correct output");
  });

  it("fails when durationMs exceeds the wall budget", () => {
    const outcome = evalWith({ output: EXPECTED, exitCode: 0, durationMs: 180_001 });
    assert.equal(outcome.passed, false, "a round over the wall budget must fail");
    assert.equal(outcome.failure!.durationMs, 180_001);
  });

  it("passes when durationMs sits exactly at the wall budget", () => {
    const outcome = evalWith({ output: EXPECTED, exitCode: 0, durationMs: 180_000 });
    assert.equal(outcome.passed, true);
  });
});

// ── failure keyline block ───────────────────────────────────────────

describe("harness-probe failure keyline block (IFLB)", () => {
  const KEY_PREFIXES = [
    "FAILURE_CLASS: harness_unavailable",
    "HARNESS:",
    "PROBE_CMD:",
    "EXPECTED:",
    "OBSERVED:",
    "EXIT_CODE:",
    "SIGNAL:",
    "DURATION_MS:",
    // MTLK-DIAG: the Matchlock-only identity + guidance keys, in the order
    // they render for an opted-in (Matchlock) probe failure.
    "IMAGE:",
    "IMAGE_DIGEST:",
    "HINT:",
    "STDERR_TAIL:",
  ];

  function fields(overrides: Partial<HarnessProbeFailureFields> = {}): HarnessProbeFailureFields {
    return {
      harness: "dsh",
      probeCmd: "/abs/bin/tamandua skill-path",
      expected: "/skills/SKILL.md",
      observed: "boot error",
      exitCode: 1,
      signal: undefined,
      durationMs: 250,
      stderrTail: "stderr boom",
      ...overrides,
    };
  }

  it("emits every key in order with STDERR_TAIL last", () => {
    const block = buildHarnessProbeFailureBlock(
      fields({
        imageName: "igorhvr/bedlam-ubuntu",
        imageDigest: "sha256:" + "a".repeat(64),
        hint: "bounded guidance",
      }),
    );
    const indexes = KEY_PREFIXES.map((prefix) => block.indexOf(prefix));
    for (let i = 0; i < indexes.length; i++) {
      assert.ok(indexes[i] >= 0, `key ${KEY_PREFIXES[i]} must be present in the block`);
      if (i > 0) assert.ok(indexes[i] > indexes[i - 1], `keys must be ordered; ${KEY_PREFIXES[i]} out of order`);
    }
    const stderrPrefix = "STDERR_TAIL: ";
    const afterStderr = block.slice(block.indexOf(stderrPrefix) + stderrPrefix.length);
    assert.equal(afterStderr.trimEnd(), "stderr boom", "STDERR_TAIL must be the last key with no prose after it");
  });

  it("caps OBSERVED at 400 characters", () => {
    const observed = "x".repeat(HARNESS_PROBE_OBSERVED_MAX_CHARS + 500);
    const block = buildHarnessProbeFailureBlock(fields({ observed }));
    const line = block.split("\n").find((l) => l.startsWith("OBSERVED: "))!;
    const value = line.slice("OBSERVED: ".length);
    assert.equal(value.length, HARNESS_PROBE_OBSERVED_MAX_CHARS);
  });

  it("collapses multi-line OBSERVED to one line before capping", () => {
    const block = buildHarnessProbeFailureBlock(fields({ observed: "line one\nline two\n\nline three" }));
    const line = block.split("\n").find((l) => l.startsWith("OBSERVED: "))!;
    assert.equal(line, "OBSERVED: line one line two line three");
  });

  it("caps STDERR_TAIL at 2000 characters (kept as the tail)", () => {
    const stderrTail = "a".repeat(HARNESS_PROBE_STDERR_TAIL_MAX_CHARS + 999);
    const block = buildHarnessProbeFailureBlock(fields({ stderrTail }));
    const at = block.indexOf("STDERR_TAIL: ");
    const value = block.slice(at + "STDERR_TAIL: ".length);
    assert.equal(value.length, HARNESS_PROBE_STDERR_TAIL_MAX_CHARS);
    assert.equal(value, "a".repeat(HARNESS_PROBE_STDERR_TAIL_MAX_CHARS), "tail chars must be kept from the end");
  });

  it("preserves multi-line STDERR_TAIL verbatim as the final content", () => {
    const block = buildHarnessProbeFailureBlock(fields({ stderrTail: "first line\nsecond line" }));
    assert.ok(block.endsWith("STDERR_TAIL: first line\nsecond line"), "multi-line tail stays the last content");
  });

  it("formats numeric keys and leaves absent ones empty", () => {
    const block = buildHarnessProbeFailureBlock(
      fields({ exitCode: null, signal: "SIGKILL", durationMs: undefined }),
    );
    assert.ok(block.includes("EXIT_CODE: \n"), "absent exit code renders empty");
    assert.ok(block.includes("SIGNAL: SIGKILL\n"));
    assert.ok(block.includes("DURATION_MS: \n"), "absent duration renders empty");
  });

  it("starts with FAILURE_CLASS: harness_unavailable", () => {
    assert.ok(buildHarnessProbeFailureBlock(fields()).startsWith("FAILURE_CLASS: harness_unavailable\n"));
  });

  it("native (non-Matchlock) failure fields render the BYTE-IDENTICAL legacy block (no IMAGE/HINT keys)", () => {
    // Nothing in the native probe path sets imageName/imageDigest/hint, so the
    // optional keylines are absent entirely — not rendered empty.
    assert.equal(
      buildHarnessProbeFailureBlock(fields()),
      [
        "FAILURE_CLASS: harness_unavailable",
        "HARNESS: dsh",
        "PROBE_CMD: /abs/bin/tamandua skill-path",
        "EXPECTED: /skills/SKILL.md",
        "OBSERVED: boot error",
        "EXIT_CODE: 1",
        "SIGNAL: ",
        "DURATION_MS: 250",
        "STDERR_TAIL: stderr boom",
      ].join("\n"),
    );
  });

  it("omits IMAGE_DIGEST when the pinned policy carries no resolved digest (never fabricated)", () => {
    const block = buildHarnessProbeFailureBlock(fields({ imageName: "igorhvr/bedlam-ubuntu" }));
    assert.ok(block.includes("IMAGE: igorhvr/bedlam-ubuntu\n"), "IMAGE is present");
    assert.ok(!block.includes("IMAGE_DIGEST:"), "no digest line when the digest is absent");
    assert.ok(!block.includes("HINT:"), "no hint when none was classified");
  });
});

// ── MTLK-DIAG matchlock probe guidance ──────────────────────────────

describe("matchlock probe failure guidance (MTLK-DIAG)", () => {
  const IMAGE = "igorhvr/bedlam-ubuntu";
  const DIGEST = "sha256:" + "b".repeat(64);

  /**
   * Byte-faithful bounded excerpt of the RECORDED run #98 failure
   * (~/.tamandua/events/e0383930-e458-4e1e-82f4-e4d41189b1df.jsonl): two
   * interleaved console writers, so only the 9-char family prefix `prepare e`
   * survives contiguously, immediately followed by the init panic.
   */
  const RECORDED_98_EXCERPT = [
    "EXT4-fs (vdc): mounted filesystem bda37831-65a0-46bd-a529-b4d34e229924 r/w with ordered data mode. Quota mode: disabled.",
    "FATAL: prepare eKernel panic - not syncing: Attempted to kill init! exitcode=0x00000100",
    "xCaPcUt:  d7e sUtIiDn:a t0i oPnID: 83 Comm: init Not tainted 6.19.8 #1 PREEMPT(none) ",
    "Call Trace:",
    " <TASK>",
    " vpanic+0x2dd/0x2f0",
  ].join("\r\n");

  /** Byte-faithful bounded excerpt of the RECORDED run #99 failure (same shape, different interleave). */
  const RECORDED_99_EXCERPT = [
    "EXT4-fs (vdc): mounted filesystem a887679c-6d91-4131-a7d9-c230b77c551a r/w with ordered data mode. Quota mode: disabled.",
    "FATAL: prepare eKernel panic - not syncing: Attempted to kill init! exitcode=0x00000100",
    "xaCcPtU :d e2s tUiInDa:t i0o nPID: 82 Comm: init Not tainted 6.19.8 #1 PREEMPT(none) ",
    "Call Trace:",
    " <TASK>",
    " vpanic+0x2dd/0x2f0",
  ].join("\r\n");

  /**
   * COMPLETE Case A evidence, synthetic-from-source: guest-init's
   * errx.With(ErrExactMountPrep, " %s already exists and is not empty;
   * refusing to shadow guest content") rendered through fatal()'s
   * `FATAL: %v` (cmd/guest-init/main.go:218,1063).
   */
  const CLEAN_CASE_A = [
    "EXT4-fs (vdc): mounted filesystem synthetic r/w with ordered data mode. Quota mode: disabled.",
    "FATAL: prepare exact destination mount /opt/tamandua already exists and is not empty; refusing to shadow guest content",
    "Kernel panic - not syncing: Attempted to kill init! exitcode=0x00000100",
  ].join("\r\n");

  function hint(overrides: Partial<Parameters<typeof matchlockProbeHint>[0]> = {}) {
    return matchlockProbeHint({
      harness: "pi",
      imageName: IMAGE,
      imageDigest: DIGEST,
      stderrTail: CLEAN_CASE_A,
      exitCode: null,
      ...overrides,
    });
  }

  function failureFields(overrides: Partial<HarnessProbeFailureFields> = {}): HarnessProbeFailureFields {
    return {
      harness: "pi",
      probeCmd: "/workspace/runtime/bin/tamandua skill-path",
      expected: "/workspace/runtime/skills/tamandua-agents/SKILL.md",
      observed: "",
      exitCode: null,
      signal: null,
      durationMs: 12,
      stderrTail: CLEAN_CASE_A,
      imageName: IMAGE,
      imageDigest: DIGEST,
      hint: hint(),
      ...overrides,
    };
  }

  function keyLine(block: string, key: string): string | undefined {
    return block.split("\n").find((l) => l.startsWith(`${key}:`));
  }

  it("complete Case A: block carries IMAGE, IMAGE_DIGEST and a HINT naming the exact-mount refusal + captured path", () => {
    const block = buildHarnessProbeFailureBlock(failureFields());
    assert.ok(block.startsWith("FAILURE_CLASS: harness_unavailable\n"), "FAILURE_CLASS unchanged");
    assert.equal(keyLine(block, "IMAGE"), `IMAGE: ${IMAGE}`);
    assert.equal(keyLine(block, "IMAGE_DIGEST"), `IMAGE_DIGEST: ${DIGEST}`);
    const hintLine = keyLine(block, "HINT");
    assert.ok(hintLine, "a HINT keyline must be present");
    assert.match(hintLine!, /exact destination mount \/opt\/tamandua/, "the captured path is named");
    assert.match(hintLine!, /already exists and is not empty/, "complete evidence may state the refusal");
    assert.match(hintLine!, /use a working directory that does not exist inside/, "the remedy is given");
    // Ordering + caps: the identity/hint keys precede the LAST key, and
    // STDERR_TAIL keeps its existing cap and terminal position.
    const order = ["DURATION_MS:", "IMAGE:", "IMAGE_DIGEST:", "HINT:", "STDERR_TAIL:"].map((k) =>
      block.indexOf(k),
    );
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], "IMAGE/IMAGE_DIGEST/HINT must precede the final STDERR_TAIL key");
    }
    const tail = block.slice(block.indexOf("STDERR_TAIL: ") + "STDERR_TAIL: ".length);
    assert.equal(tail, CLEAN_CASE_A, "STDERR_TAIL stays the final key, verbatim and uncapped below the cap");
  });

  it("recorded run #98 interleaved excerpt: IMAGE lines present + interleaved-style HINT that asserts no cause", () => {
    const h = hint({ stderrTail: RECORDED_98_EXCERPT });
    assert.ok(h, "the recorded #98 shape must classify");
    assert.match(h!, /guest initialization failed at boot/);
    assert.match(h!, /interleaved\/truncated/);
    assert.match(h!, /specific cause is NOT established/);
    assert.ok(
      !h!.includes("already exists and is not empty"),
      "interleaved evidence must not quote the complete-evidence refusal",
    );
    assert.match(
      h!,
      /if the round path collides with a non-empty path baked into image "igorhvr\/bedlam-ubuntu"/,
      "a non-empty-leaf collision may be mentioned ONLY conditionally",
    );
    assert.ok(!h!.includes("/opt/tamandua"), "the interleaved hint never names a path it did not see");
    assert.ok(!h!.includes("working directory is"), "no definitive-cause wording");

    const block = buildHarnessProbeFailureBlock(failureFields({ hint: h, stderrTail: RECORDED_98_EXCERPT }));
    assert.equal(keyLine(block, "IMAGE"), `IMAGE: ${IMAGE}`);
    assert.equal(keyLine(block, "IMAGE_DIGEST"), `IMAGE_DIGEST: ${DIGEST}`);
    assert.ok(keyLine(block, "HINT"));
    assert.ok(
      block.indexOf("HINT:") < block.indexOf("STDERR_TAIL:"),
      "HINT precedes the final STDERR_TAIL key",
    );
  });

  it("recorded run #99 interleaved variant (different interleave) classifies identically — not a lucky match", () => {
    const h = hint({ stderrTail: RECORDED_99_EXCERPT });
    assert.ok(h, "the recorded #99 shape must classify");
    assert.match(h!, /guest initialization failed at boot/);
    assert.match(h!, /specific cause is NOT established/);
    assert.ok(!h!.includes("already exists and is not empty"));
  });

  it("other complete-evidence ErrExactMountPrep members (symlink / not-a-directory / protected runtime root) get NO hint", () => {
    const variants: Record<string, string> = {
      // synthetic-from-source: main.go:1050 / :1053 / :1030 (errx.With prefixes the sentinel).
      symlink: "FATAL: prepare exact destination mount /opt/tamandua is a symlink; refusing an exact mount through a link",
      notADirectory: "FATAL: prepare exact destination mount /opt/tamandua is not a directory",
      protectedRuntimeRoot:
        'FATAL: prepare exact destination mount "/workspace/runtime" shadows the trusted guest runtime /workspace',
    };
    for (const [name, stderrTail] of Object.entries(variants)) {
      assert.equal(hint({ stderrTail }), undefined, `${name} must get no hint`);
      const block = buildHarnessProbeFailureBlock(failureFields({ hint: undefined, stderrTail }));
      assert.equal(keyLine(block, "IMAGE"), `IMAGE: ${IMAGE}`, `${name} still carries IMAGE`);
      assert.equal(keyLine(block, "IMAGE_DIGEST"), `IMAGE_DIGEST: ${DIGEST}`);
      assert.equal(keyLine(block, "HINT"), undefined, `${name} must not render a HINT key`);
    }
  });

  it("negative: a different guest-init FATAL family (with the panic marker) gets NO hint", () => {
    const stderrTail = [
      "FATAL: invalid overlay root config", // errors.go:14 ErrInvalidOverlayCfg
      "Kernel panic - not syncing: Attempted to kill init! exitcode=0x00000100",
    ].join("\r\n");
    assert.equal(hint({ stderrTail }), undefined);
  });

  it("negative: a prepare-looking fragment WITHOUT the FATAL marker gets NO hint", () => {
    const stderrTail = [
      "prepare e",
      "Kernel panic - not syncing: Attempted to kill init! exitcode=0x00000100",
    ].join("\r\n");
    assert.equal(hint({ stderrTail }), undefined);
  });

  it("negative: a panic excerpt without any prepare fragment gets NO hint", () => {
    const stderrTail = [
      "random boot noise",
      "Kernel panic - not syncing: Attempted to kill init! exitcode=0x00000100",
    ].join("\r\n");
    assert.equal(hint({ stderrTail }), undefined);
  });

  it("negative: a wall-timeout / wrong-output failure (empty capture) gets NO hint", () => {
    assert.equal(hint({ stderrTail: "" }), undefined);
    assert.equal(hint({ stderrTail: "not the expected path" }), undefined);
  });

  it("Case B: `sh: 1: pi: not found` (exit 127) gets a HINT naming the harness and the image, phrased conditionally", () => {
    const h = hint({ stderrTail: "sh: 1: pi: not found", exitCode: 127 });
    assert.ok(h, "the Case B shape must classify");
    assert.match(h!, /the selected harness "pi" did not start in image "igorhvr\/bedlam-ubuntu"/);
    assert.ok(h!.includes(DIGEST), "the resolved digest is named");
    assert.ok(h!.includes("sh: 1: pi: not found"), "the observed diagnostic is quoted");
    assert.match(h!, /if this image does not ship pi, use one that does/);
    assert.ok(!h!.includes("image lacks pi"), "the cause is phrased conditionally, never as fact");
    const block = buildHarnessProbeFailureBlock(failureFields({ hint: h, stderrTail: "sh: 1: pi: not found" }));
    assert.equal(keyLine(block, "IMAGE"), `IMAGE: ${IMAGE}`);
    assert.equal(keyLine(block, "IMAGE_DIGEST"), `IMAGE_DIGEST: ${DIGEST}`);
  });

  it("negative: a different missing command (`sh: 1: wget: not found`) gets NO harness hint", () => {
    assert.equal(hint({ stderrTail: "sh: 1: wget: not found", exitCode: 127 }), undefined);
  });

  it("invocation-failure catch path with no signature in the tail: IMAGE lines present, NO hint", () => {
    for (const stderrTail of [
      "matchlock probe invocation failed: transport closed",
      "matchlock probe invocation failed: rpc deadline exceeded",
    ]) {
      assert.equal(hint({ stderrTail }), undefined, `${stderrTail} must get no hint`);
      const block = buildHarnessProbeFailureBlock(failureFields({ hint: undefined, stderrTail }));
      assert.equal(keyLine(block, "IMAGE"), `IMAGE: ${IMAGE}`);
      assert.equal(keyLine(block, "HINT"), undefined);
    }
  });

  it("sanitizes every new value: multi-line / control-character capture yields single-line, control-free keys", () => {
    const stderrTail = `FATAL: prepare\u0007exact destination mount /opt/x\u0000 already exists and is not empty; refusing to shadow guest content\nKernel panic - not syncing: Attempted to kill init! exitcode=0x00000100\n`;
    const h = hint({ stderrTail });
    const block = buildHarnessProbeFailureBlock(
      failureFields({
        hint: h,
        stderrTail,
        imageName: "igorhvr/\r\nbedlam\u0007-ubuntu",
        imageDigest: "sha256:aaa\tbbb",
      }),
    );
    for (const key of ["IMAGE", "IMAGE_DIGEST", "HINT"]) {
      const line = keyLine(block, key);
      assert.ok(line, `${key} must render`);
      assert.ok(
        // eslint-disable-next-line no-control-regex
        !/[\u0000-\u001F\u007F]/.test(line!.slice(key.length + 2)),
        `${key} value must be control-character free`,
      );
      assert.ok(!line!.includes("\n"), `${key} value must stay on one line`);
    }
    assert.match(keyLine(block, "IMAGE")!, /^IMAGE: igorhvr\/ bedlam -ubuntu$/);
    assert.ok(h, "the mangled family line still classifies");
    assert.ok(h!.length <= HARNESS_PROBE_HINT_MAX_CHARS);
  });

  it("bounds the HINT value at its own cap", () => {
    const block = buildHarnessProbeFailureBlock(failureFields({ hint: "x".repeat(HARNESS_PROBE_HINT_MAX_CHARS + 100) }));
    const line = keyLine(block, "HINT")!;
    assert.equal(line.slice("HINT: ".length).length, HARNESS_PROBE_HINT_MAX_CHARS);
  });
});

// ── computeExpectedHarnessProbePath (real child spawn) ──────────────

describe("harness-probe expected-path computation (IFLB)", () => {
  let stateRoot: string;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    stateRoot = tamanduaTempDir("tamandua-harness-probe-expected-");
    process.env.HOME = stateRoot;
    process.env.TAMANDUA_STATE_DIR = path.join(stateRoot, ".tamandua");
    fs.mkdirSync(process.env.TAMANDUA_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it("runs `<launcher> skill-path` for real and returns the same path resolveSkillPath() computes", () => {
    const env = cleanChildEnv({ HOME: stateRoot });
    const result = computeExpectedHarnessProbePath(env, process.cwd());
    assert.equal(result.ok, true, `expected skill-path to succeed: ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.path, resolveSkillPath());
  });

  it("reports ok:false with a non-zero exit when the launcher cannot run (no node on PATH)", () => {
    // The launcher's shebang (/bin/sh) always launches, but `node` is not on
    // this PATH (deliberately points nowhere), so the child exits non-zero —
    // the exact probe-failure shape.
    const env = cleanChildEnv({ HOME: stateRoot, PATH: "/nonexistent-tamandua-probe-dir" });
    const result = computeExpectedHarnessProbePath(env, process.cwd());
    assert.equal(result.ok, false);
    assert.ok(result.exitCode !== 0, `expected non-zero exit, got ${JSON.stringify(result)}`);
    assert.equal(result.signal, null);
  });
});

// ── once-per-run DB helpers ─────────────────────────────────────────

describe("harness-probe once-per-run DB helpers (IFLB)", () => {
  let stateRoot: string;
  let originalHome: string | undefined;
  let originalStateDir: string | undefined;
  let originalDbPath: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalStateDir = process.env.TAMANDUA_STATE_DIR;
    originalDbPath = process.env.TAMANDUA_DB_PATH;
    stateRoot = tamanduaTempDir("tamandua-harness-probe-db-");
    process.env.HOME = stateRoot;
    process.env.TAMANDUA_STATE_DIR = path.join(stateRoot, ".tamandua");
    process.env.TAMANDUA_DB_PATH = path.join(stateRoot, ".tamandua", "tamandua.db");
    assertStatePathIsolation(process.env.TAMANDUA_STATE_DIR, "harness-probe DB test state");
    assertStatePathIsolation(process.env.TAMANDUA_DB_PATH, "harness-probe DB test database");
    fs.mkdirSync(process.env.TAMANDUA_STATE_DIR, { recursive: true });
  });

  afterEach(() => {
    closeDb();
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateDir === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = originalStateDir;
    if (originalDbPath === undefined) delete process.env.TAMANDUA_DB_PATH;
    else process.env.TAMANDUA_DB_PATH = originalDbPath;
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  function insertRun(runId: string, status = "running"): void {
    const now = new Date().toISOString();
    getDb()
      .prepare(
        "INSERT INTO runs (id, workflow_id, task, status, context, created_at, updated_at) VALUES (?, 'feature-dev-merge', 'harness-probe db helper test', ?, '{}', ?, ?)",
      )
      .run(runId, status, now, now);
  }

  it("reads null before any probe and for a missing run", () => {
    assert.equal(readHarnessProbeStatus("no-such-run"), null);
    insertRun("fresh-run");
    assert.equal(readHarnessProbeStatus("fresh-run"), null, "an unprobed run reads NULL");
  });

  it("exactly one caller wins the atomic reserve; a second caller loses", () => {
    insertRun("contended-run");
    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    // Caller 1 wins …
    assert.equal(reserveHarnessProbe("contended-run", { wallMs: 1000, nowMs: T0 }), true);
    assert.equal(readHarnessProbeStatus("contended-run"), "probing");
    // … caller 2 (fresh in-flight reservation) loses — status is no longer NULL.
    assert.equal(reserveHarnessProbe("contended-run", { wallMs: 1000, nowMs: T0 + 500 }), false);
  });

  it("a stale in-flight 'probing' reservation older than the wall is re-reservable", () => {
    insertRun("crashed-daemon-run");
    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(reserveHarnessProbe("crashed-daemon-run", { wallMs: 1000, nowMs: T0 }), true);
    // Still inside the wall: not stale, reserve loses.
    assert.equal(reserveHarnessProbe("crashed-daemon-run", { wallMs: 1000, nowMs: T0 + 999 }), false);
    // Past the wall: a daemon crash mid-probe must not wedge the run.
    assert.equal(reserveHarnessProbe("crashed-daemon-run", { wallMs: 1000, nowMs: T0 + 2000 }), true);
    assert.equal(readHarnessProbeStatus("crashed-daemon-run"), "probing");
  });

  it("a recorded 'ok' status + timestamp persists across a DB re-open and the run is never re-probed", () => {
    insertRun("passed-run");
    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(reserveHarnessProbe("passed-run", { wallMs: 1000, nowMs: T0 }), true);
    recordHarnessProbeResult("passed-run", "ok", { nowMs: T0 + 300 });
    assert.equal(readHarnessProbeStatus("passed-run"), "ok");

    // Simulated daemon restart: close and reopen the same DB file.
    closeDb();
    const row = getDb()
      .prepare("SELECT harness_probe_status, harness_probe_at FROM runs WHERE id = ?")
      .get("passed-run") as { harness_probe_status: string | null; harness_probe_at: string | null };
    assert.equal(row.harness_probe_status, "ok", "'ok' must survive the restart");
    assert.equal(row.harness_probe_at, new Date(T0 + 300).toISOString(), "timestamp must survive the restart");
    assert.equal(readHarnessProbeStatus("passed-run"), "ok");

    // A passed run is never re-probed — even long after the wall.
    assert.equal(
      reserveHarnessProbe("passed-run", { wallMs: 1000, nowMs: T0 + 60_000 }),
      false,
      "an 'ok' run must never be re-probed after a restart",
    );
  });

  it("a recorded 'failed' outcome persists and is never re-probed either", () => {
    insertRun("failed-run");
    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(reserveHarnessProbe("failed-run", { wallMs: 1000, nowMs: T0 }), true);
    recordHarnessProbeResult("failed-run", "failed", { nowMs: T0 + 400 });
    assert.equal(readHarnessProbeStatus("failed-run"), "failed");
    assert.equal(reserveHarnessProbe("failed-run", { wallMs: 1000, nowMs: T0 + 5000 }), false);
  });

  it("uses isOlderThan with the documented tolerance at the wall boundary (US-011)", () => {
    insertRun("boundary-run");
    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(reserveHarnessProbe("boundary-run", { wallMs: 1000, nowMs: T0 }), true);
    // Age exactly equal to the wall is NOT strictly older -> still in flight.
    assert.equal(reserveHarnessProbe("boundary-run", { wallMs: 1000, nowMs: T0 + 1000 }), false);
    // One millisecond past the wall is stale -> re-reservable.
    assert.equal(reserveHarnessProbe("boundary-run", { wallMs: 1000, nowMs: T0 + 1001 }), true);
  });

  it("only one caller wins a stale re-reservation (US-011 single-winner CAS)", () => {
    insertRun("stale-race-run");
    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(reserveHarnessProbe("stale-race-run", { wallMs: 1000, nowMs: T0 }), true);

    const staleNow = T0 + 5000;
    assert.equal(reserveHarnessProbe("stale-race-run", { wallMs: 1000, nowMs: staleNow }), true);
    assert.equal(
      reserveHarnessProbe("stale-race-run", { wallMs: 1000, nowMs: staleNow }),
      false,
      "a second caller must not double-claim the same reservation",
    );
  });

  it("never treats an unparseable reservation stamp as stale (US-011 safe skip)", () => {
    insertRun("bad-stamp-run");
    getDb()
      .prepare("UPDATE runs SET harness_probe_status = 'probing', harness_probe_at = 'not-a-timestamp' WHERE id = ?")
      .run("bad-stamp-run");

    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(
      reserveHarnessProbe("bad-stamp-run", { wallMs: 1000, nowMs: T0 + 1_000_000 }),
      false,
      "an unknown age must never steal the reservation",
    );
    assert.equal(readHarnessProbeStatus("bad-stamp-run"), "probing");
  });

  it("reserving a run that does not exist returns false", () => {
    assert.equal(reserveHarnessProbe("never-created"), false);
  });

  // ── RPRB: explicit-resume re-probe reset ──────────────────────────
  // resetFailedHarnessProbeForResume is the ONLY sanctioned way to clear a
  // definitive probe outcome. Its conditional WHERE is the safety contract:
  // 'failed' -> NULL, 'ok' and 'probing' untouched.

  it("clears a 'failed' outcome (status + timestamp) so a fresh probe can be reserved", () => {
    insertRun("resume-failed-run");
    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(reserveHarnessProbe("resume-failed-run", { wallMs: 1000, nowMs: T0 }), true);
    recordHarnessProbeResult("resume-failed-run", "failed", { nowMs: T0 + 400 });
    assert.equal(readHarnessProbeStatus("resume-failed-run"), "failed");

    // Explicit resume: the definitive failure is cleared.
    assert.equal(resetFailedHarnessProbeForResume("resume-failed-run"), true);
    assert.equal(readHarnessProbeStatus("resume-failed-run"), null, "status must read NULL after resume");

    const row = getDb()
      .prepare("SELECT harness_probe_status, harness_probe_at FROM runs WHERE id = ?")
      .get("resume-failed-run") as { harness_probe_status: string | null; harness_probe_at: string | null };
    assert.equal(row.harness_probe_status, null);
    assert.equal(row.harness_probe_at, null, "the failed outcome timestamp is cleared with the status");

    // A fresh once-per-run probe can now be reserved.
    assert.equal(
      reserveHarnessProbe("resume-failed-run", { wallMs: 1000, nowMs: T0 + 5000 }),
      true,
      "a resumed failed-probe run must be re-reservable",
    );
    assert.equal(readHarnessProbeStatus("resume-failed-run"), "probing");
  });

  it("never resets an 'ok' outcome ('passed stays passed')", () => {
    insertRun("resume-ok-run");
    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(reserveHarnessProbe("resume-ok-run", { wallMs: 1000, nowMs: T0 }), true);
    recordHarnessProbeResult("resume-ok-run", "ok", { nowMs: T0 + 300 });
    assert.equal(readHarnessProbeStatus("resume-ok-run"), "ok");

    assert.equal(resetFailedHarnessProbeForResume("resume-ok-run"), false, "an 'ok' row must never be reset");
    assert.equal(readHarnessProbeStatus("resume-ok-run"), "ok");
    assert.equal(
      reserveHarnessProbe("resume-ok-run", { wallMs: 1000, nowMs: T0 + 1_000_000 }),
      false,
      "a resumed passed run must never be re-probed",
    );
  });

  it("never touches an in-flight 'probing' reservation (staleness protocol unchanged)", () => {
    insertRun("resume-probing-run");
    const T0 = Date.UTC(2026, 8, 3, 12, 0, 0);
    assert.equal(reserveHarnessProbe("resume-probing-run", { wallMs: 1000, nowMs: T0 }), true);
    assert.equal(readHarnessProbeStatus("resume-probing-run"), "probing");

    assert.equal(
      resetFailedHarnessProbeForResume("resume-probing-run"),
      false,
      "a live reservation must not be cleared by resume",
    );
    assert.equal(readHarnessProbeStatus("resume-probing-run"), "probing");
    // Inside the wall the reservation still holds …
    assert.equal(reserveHarnessProbe("resume-probing-run", { wallMs: 1000, nowMs: T0 + 500 }), false);
    // … and only the existing stale CAS can reclaim it, exactly as before.
    assert.equal(reserveHarnessProbe("resume-probing-run", { wallMs: 1000, nowMs: T0 + 2000 }), true);
  });

  it("is a no-op for an unprobed run (and for a missing row)", () => {
    insertRun("resume-null-run");
    assert.equal(readHarnessProbeStatus("resume-null-run"), null);
    assert.equal(resetFailedHarnessProbeForResume("resume-null-run"), false, "NULL is not 'failed'");
    assert.equal(readHarnessProbeStatus("resume-null-run"), null);

    assert.equal(resetFailedHarnessProbeForResume("resume-missing-run"), false);
  });
});
