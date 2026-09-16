/**
 * TIME-OUTPUT US-004 — TZ-variance proof for the serialized instants.
 *
 * The logger prefix (`formatEntry`) and the `logs`/`logs-tail` human formatter
 * (`formatLogsTailTime` / `formatLogsTailLine`) must emit an explicit UTC `Z`
 * regardless of the host timezone. This test spawns a child `node` process for
 * each formatter under `TZ=UTC` and `TZ=America/Sao_Paulo` (UTC-3) and asserts
 * the UTF-8 stdout is byte-identical — so a host timezone can never leak into a
 * serialized instant, and the old host-local `toLocaleTimeString` behavior
 * cannot silently return.
 *
 * Serial lane: imports `node:child_process` (spawnSync). See
 * tests/serial-files.txt.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";
import { cleanChildEnv, createTempHome } from "./helpers/test-env.ts";

const repoRoot = process.cwd();

// The child scripts import dist/lib/logger.js; an isolated HOME +
// TAMANDUA_STATE_DIR guarantees nothing can ever write the live
// ~/.tamandua/tamandua.log (the isolation guard static check requires this).
const tempHome = createTempHome("tamandua-time-output-tz-");

/** The two timezones under comparison; the second is 3 hours behind UTC. */
const TZ_UTC = "UTC";
const TZ_SAO_PAULO = "America/Sao_Paulo";

/**
 * Fixed instants covering every shape the serializers accept:
 * canonical ISO-Z, a legacy naive UTC value, a real numeric offset, and an
 * unparseable value (which must render the stable `?` placeholder).
 */
const LOGGER_SCRIPT = `
  import { formatEntry } from "./dist/lib/logger.js";

  const entries = [
    { timestamp: "2026-09-15T22:00:00.000Z", level: "info", message: "canonical", runId: "run-12345678-aaaa" },
    { timestamp: "2026-09-15 22:00:00", level: "warn", message: "legacy naive" },
    { timestamp: "2026-09-15T22:00:00+03:00", level: "error", message: "numeric offset" },
    { timestamp: "not-a-date", level: "debug", message: "unparseable" },
  ];

  process.stdout.write(entries.map(formatEntry).join("\\n"));
`;

const LOGS_TAIL_SCRIPT = `
  import { formatLogsTailTime, formatLogsTailLine } from "./dist/installer/logs-tail-format.js";

  const times = [
    "2026-09-15T22:00:00.000Z",
    "2026-09-15 22:00:00",
    "2026-09-15T22:00:00+03:00",
    "not-a-date",
    null,
  ];

  const events = [
    {
      ts: "2026-09-15T22:00:00.000Z",
      event: "step.running",
      runId: "run-12345678-aaaa",
      agentId: "wf-time-output_dev",
      storyTitle: "TZ variance",
      detail: "fixed instant",
      tokenDelta: 5,
      tokensSpent: 42,
    },
    {
      ts: "2026-09-15 22:00:00",
      event: "run.completed",
      runId: "run-12345678-bbbb",
      tokensSpent: 100,
    },
  ];

  process.stdout.write(JSON.stringify({
    times: times.map(formatLogsTailTime),
    lines: events.map(formatLogsTailLine),
  }));
`;

interface ChildResult {
  stdout: string;
  stderr: string;
  status: number | null;
}

function runScript(script: string, tz: string): ChildResult {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: repoRoot,
    env: cleanChildEnv({
      HOME: tempHome.homeDir,
      TAMANDUA_STATE_DIR: tempHome.tamanduaDir,
      TZ: tz,
    }),
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function runBothTzs(script: string): { utc: string; saoPaulo: string } {
  const utc = runScript(script, TZ_UTC);
  const saoPaulo = runScript(script, TZ_SAO_PAULO);

  assert.equal(utc.status, 0, `logger/tail script failed under TZ=UTC:\n${utc.stderr}`);
  assert.equal(
    saoPaulo.status,
    0,
    `logger/tail script failed under TZ=${TZ_SAO_PAULO}:\n${saoPaulo.stderr}`,
  );
  assert.ok(utc.stdout.length > 0, "the formatting script produced no stdout");

  return { utc: utc.stdout, saoPaulo: saoPaulo.stdout };
}

describe("TIME-OUTPUT TZ variance", () => {
  it("logger formatEntry stdout is byte-identical under TZ=UTC and TZ=America/Sao_Paulo", () => {
    const { utc, saoPaulo } = runBothTzs(LOGGER_SCRIPT);

    assert.equal(
      Buffer.from(utc, "utf-8").equals(Buffer.from(saoPaulo, "utf-8")),
      true,
      `logger stdout differs across timezones\nUTC:\n${JSON.stringify(utc)}\n` +
        `${TZ_SAO_PAULO}:\n${JSON.stringify(saoPaulo)}`,
    );

    // Sanity: the identical output is the new UTC date+Z shape (not empty and
    // not a host-local time). 22:00Z must never become 19:00 under UTC-3.
    assert.match(utc, /\[2026-09-15 22:00:00Z\] \[INFO\]/);
    assert.match(utc, /\[2026-09-15 22:00:00Z\] \[WARN\]/);
    assert.match(utc, /\[2026-09-15 19:00:00Z\] \[ERROR\]/);
    assert.match(utc, /\[\?\] \[DEBUG\]/);
    assert.doesNotMatch(utc, /AM|PM/);
  });

  it("logs-tail stdout is byte-identical under TZ=UTC and TZ=America/Sao_Paulo", () => {
    const { utc, saoPaulo } = runBothTzs(LOGS_TAIL_SCRIPT);

    assert.equal(
      Buffer.from(utc, "utf-8").equals(Buffer.from(saoPaulo, "utf-8")),
      true,
      `logs-tail stdout differs across timezones\nUTC:\n${JSON.stringify(utc)}\n` +
        `${TZ_SAO_PAULO}:\n${JSON.stringify(saoPaulo)}`,
    );

    const payload = JSON.parse(utc) as { times: string[]; lines: string[] };
    assert.deepEqual(payload.times, [
      "2026-09-15 22:00:00Z",
      "2026-09-15 22:00:00Z",
      "2026-09-15 19:00:00Z",
      "?",
      "?",
    ]);
    assert.match(payload.lines[0], /^2026-09-15 22:00:00Z/);
    assert.match(payload.lines[1], /^2026-09-15 22:00:00Z/);
    assert.doesNotMatch(utc, /AM|PM/);
  });
});
