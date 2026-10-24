// Tier-2 STORM-LATENCY-BOUND-4S US-001/US-002 — the storm read-path
// acceptance bound defaults to 4000 ms (INTERIM threshold, not a fix), and
// US-002 drives the engine's real poundOnce comparison with injected timing.
//
// The operator directive raised the interim storm read-path acceptance bound
// from 2s to 4s. This suite is the deterministic guard rail for that default:
//   * the two exported defaults (roster + rehearsal) are 4_000 ms;
//   * the prepared-campaign A/B metadata agrees with the enforced default;
//   * no 2_000 fallback/default for the pounding bound remains under
//     torture-test/bin, including the tt-storm CLI's operator fallback;
//   * the tt-storm CLI's recorded pounding opts resolve the default from the
//     exported 4_000 ms constant (a missing flag cannot re-tighten it);
//   * the engine still enforces with the INCLUSIVE `latencyMs <= bound`
//     comparison at both pounding sites (exactly 4000 ms must pass);
//   * the deliberate `latencyBoundMs: 2_000` self-test fixtures are preserved
//     (they pin a specific bound on purpose and must not drift with the
//     default);
//   * read-path prose says "at most 4 s" / "<= 4 s" and no longer claims a
//     stricter 2s bound the engine does not enforce.
//
// In-process only: imports the committed modules and reads source text. No
// daemon, network, load campaign, sleep, or real timing is used.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { POUND_LATENCY_BOUND_MS } from "../bin/tt-storm-roster.mjs";
import { REHEARSAL_POUND_LATENCY_BOUND_MS } from "../bin/tt-storm-rehearsal.mjs";
import { newCampaignState, REAL_PROC } from "../bin/tt-storm-shared.mjs";
import {
  makeRealControlGet,
  makeRealHttpGet,
  makeRealMcpTool,
} from "../bin/tt-storm-real.mjs";
import {
  enablePounding,
  poundOnce,
  poundingConfig,
} from "../bin/tt-storm-engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TORTURE_ROOT = path.resolve(HERE, "..");
const BIN_DIR = path.join(TORTURE_ROOT, "bin");

const read = (relPath: string): string =>
  fs.readFileSync(path.join(TORTURE_ROOT, relPath), "utf8");

const lines = (text: string): string[] => text.split(/\r?\n/);

// All files under torture-test/bin (recursive, deterministic order).
function binFiles(dir = BIN_DIR): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...binFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const clock = {
  nowUtc: () => "2026-01-01T00:00:00.000Z",
  nowMs: () => 1767225600000,
};

describe("tier2-storm-latency-bound (US-001)", () => {
  it("POUND_LATENCY_BOUND_MS is the interim 4000 ms default", () => {
    assert.equal(POUND_LATENCY_BOUND_MS, 4_000);
  });

  it("REHEARSAL_POUND_LATENCY_BOUND_MS is the interim 4000 ms default", () => {
    assert.equal(REHEARSAL_POUND_LATENCY_BOUND_MS, 4_000);
    assert.equal(REHEARSAL_POUND_LATENCY_BOUND_MS, POUND_LATENCY_BOUND_MS);
  });

  it("newCampaignState A/B pounding metadata records the 4000 ms default", () => {
    const state = newCampaignState({
      campaignId: "storm-latency-bound-4s",
      clock,
      source: { kind: "self-test" },
      fixture: {},
    });
    assert.equal(state.rounds.A.pounding.latencyBoundMs, 4_000);
    assert.equal(state.rounds.B.pounding.latencyBoundMs, 4_000);
    assert.equal(state.rounds.A.pounding.latencyBoundMs, POUND_LATENCY_BOUND_MS);
    assert.equal(state.rounds.B.pounding.latencyBoundMs, POUND_LATENCY_BOUND_MS);
  });

  it("no 2_000 fallback/default for the pounding bound remains anywhere under torture-test/bin", () => {
    // Broad enough to catch `latencyBoundMs: 2_000`, `?? 2_000`, `= 2_000`,
    // and a `--pounding-latency-bound-ms` usage/fallback that still says 2000.
    const offenders: string[] = [];
    for (const file of binFiles()) {
      for (const [index, line] of lines(fs.readFileSync(file, "utf8")).entries()) {
        if (
          /latencyBoundMs\s*[:=][^\n]*\b2_?000\b/.test(line) ||
          /pounding-latency-bound-ms[^\n]*\b2_?000\b/.test(line)
        ) {
          offenders.push(`${path.relative(TORTURE_ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, [], `stale 2s pounding-bound default(s):\n${offenders.join("\n")}`);
  });

  it("the tt-storm CLI default fallback resolves to the exported 4000 ms bound", async () => {
    // Importing the CLI is side-effect-free (main() is guarded). poundingOpts
    // is the exact function the operator surface uses to build ctx.opts.pounding,
    // so this pins the recorded/enforced default end to end.
    const cli = await import(pathToFileURL(path.join(BIN_DIR, "tt-storm")).href);
    assert.equal(typeof cli.poundingOpts, "function", "tt-storm must export poundingOpts for the wiring check");
    assert.equal(cli.poundingOpts({}), null, "no pounding flags is first-class NOT_RUN");

    const byUrl = cli.poundingOpts({ "pounding-dashboard-url": "http://127.0.0.1:9/dash/" });
    assert.equal(byUrl.latencyBoundMs, POUND_LATENCY_BOUND_MS);
    assert.equal(byUrl.latencyBoundMs, 4_000);

    const byTools = cli.poundingOpts({ "pounding-mcp-tools": "runs.list" });
    assert.equal(byTools.latencyBoundMs, POUND_LATENCY_BOUND_MS);

    // An explicit operator override still wins over the default.
    const override = cli.poundingOpts({
      "pounding-dashboard-url": "http://127.0.0.1:9/dash/",
      "pounding-latency-bound-ms": "2500",
    });
    assert.equal(override.latencyBoundMs, 2_500);
  });

  it("the tt-storm usage text advertises the enforced 4000 ms default", () => {
    const cli = read("bin/tt-storm");
    assert.match(cli, /--pounding-latency-bound-ms <n> First-byte latency bound \(default 4000 ms;/);
    assert.doesNotMatch(cli, /First-byte latency bound \(default 2000\)/);
  });

  it("the engine keeps the inclusive latency comparison at both pounding sites", () => {
    const engine = read("bin/tt-storm-engine.mjs");
    const inclusive = engine.match(/latencyOk = latencyMs == null \|\| latencyMs <= p\.latencyBoundMs;/g) ?? [];
    assert.equal(inclusive.length, 2, "expected the inclusive comparison at dashboard HTTP and MCP tool sites");
  });

  it("the engine reads the exported defaults (import wiring, not isolated edits)", () => {
    const engine = read("bin/tt-storm-engine.mjs");
    // POUND_LATENCY_BOUND_MS is imported and used for both the config default
    // and the ensure-state (initial metadata) default.
    assert.match(engine, /POUND_LATENCY_BOUND_MS,/);
    assert.match(engine, /latencyBoundMs: cfg\.latencyBoundMs \?\? POUND_LATENCY_BOUND_MS/);
    assert.match(engine, /latencyBoundMs: POUND_LATENCY_BOUND_MS/);
    // The rehearsal default is imported by the engine and wired into the
    // automatic pounding config for a rehearsal run.
    assert.match(engine, /REHEARSAL_POUND_LATENCY_BOUND_MS,/);
    assert.match(engine, /latencyBoundMs: REHEARSAL_POUND_LATENCY_BOUND_MS/);

    const rehearsal = read("bin/tt-storm-rehearsal.mjs");
    assert.match(rehearsal, /latencyBoundMs: REHEARSAL_POUND_LATENCY_BOUND_MS/);
  });

  it("the six deliberate latencyBoundMs: 2_000 self-test fixtures are preserved", () => {
    const fixtures: Array<[string, number]> = [
      ["self-tests/tier2-storm-rehearsal-roundb-live-target.test.ts", 1],
      ["self-tests/tier2-storm-rehearsal-launch-argv-containment.test.ts", 1],
      ["self-tests/tier2-storm-rehearsal-gate.test.ts", 2],
      ["self-tests/tier2-storm-orchestrator-recording-gate.test.ts", 1],
      ["self-tests/tier2-storm-rehearsal-roundb-hold-release.test.ts", 1],
    ];
    let total = 0;
    for (const [relPath, expected] of fixtures) {
      const count = (read(relPath).match(/latencyBoundMs: 2_000/g) ?? []).length;
      assert.equal(count, expected, `${relPath} must keep ${expected} explicit 2_000 pin(s)`);
      total += count;
    }
    assert.equal(total, 6);

    // The simultaneity-window override is a different deliberate pin and must
    // not be swept up by the default change.
    assert.match(
      read("self-tests/tier2-storm-rehearsal-simultaneity-window.test.ts"),
      /latencyBoundMs: 5000/,
    );
  });

  it("read-path prose states the enforced at-most-4s bound, never a stricter 2s claim", () => {
    const sources: Array<[string, RegExp, RegExp]> = [
      // [file, stale-2s-claim, required-4s-wording]
      ["bin/tt-storm-roster.mjs", /first-byte[^\n]*2\s*s/i, /first-byte latency bound at most 4 s/],
      ["bin/tt-storm-engine.mjs", /first-byte[^\n]*2\s*s/i, /first-byte latency <= 4 s/],
      ["bin/tt-storm-shared.mjs", /first-byte[^\n]*2\s*s/i, /first-byte at most 4 s/],
      ["tamandua-torture-test-spec/09-wave-5-storm.md", /first-byte latency bound \(< 2s\)/i, /first-byte latency bound \(at most 4 s\)/],
      ["cases/tasks/tier2/W5.storm-capacity-scaled.md", /first-byte latency bound \(< 2s\)/i, /first-byte latency bound \(at most 4 s\)/],
    ];
    for (const [relPath, stale, required] of sources) {
      const text = read(relPath);
      assert.doesNotMatch(text, stale, `${relPath} still claims a 2s read-path bound`);
      assert.match(text, required, `${relPath} must state the enforced 4s bound`);
    }

    // No bin source at all may retain a 2s first-byte read-path claim.
    for (const file of binFiles()) {
      const text = fs.readFileSync(file, "utf8");
      assert.doesNotMatch(text, /first-byte[^\n]*< ?2\s*s/i, `${file} still claims a <2s read-path bound`);
    }
  });

  it("no user-facing spec/case text still advertises a 2s read-path bound", () => {
    const docs = [
      "tamandua-torture-test-spec/09-wave-5-storm.md",
      "cases/tasks/tier2/W5.storm-capacity-scaled.md",
    ];
    for (const relPath of docs) {
      const staleLines = lines(read(relPath)).filter((line) => /< ?2s/.test(line) && /first-byte latency bound/i.test(line));
      assert.deepEqual(staleLines, [], `${relPath} still advertises a 2s bound`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// US-002 — drive the engine's REAL poundOnce latency comparison with
// injected timings. The point is the enforcement path, not the values in
// isolation: a 3s observation must now pass, exactly 4s must stay
// inclusive, 4_001ms must still fail, and the non-latency conditions
// (5xx / MCP error) must still fail. No sleeps, network, daemon, or real
// timing is used.
// ─────────────────────────────────────────────────────────────────────

const POUND_CAMPAIGN_ID = "storm-latency-bound-enforcement";

interface PoundHarnessCfg {
  latencyMs?: number;
  statusCode?: number;
  httpOk?: boolean;
  mcpOk?: boolean;
  mcpThrows?: boolean;
  dashboardUrl?: string | null;
  mcpToolNames?: string[];
  latencyBoundMs?: number;
}

function poundClock() {
  return {
    nowMs: () => 1_767_225_600_000,
    nowUtc: () => "2026-01-01T00:00:00.000Z",
    sleep: async () => {},
  };
}

function freshPoundState(clock: ReturnType<typeof poundClock>) {
  return newCampaignState({
    campaignId: POUND_CAMPAIGN_ID,
    clock,
    source: { kind: "self-test" },
    fixture: {},
  });
}

// In-memory ctx whose transport adapters return the injected observation.
// Round A is enabled so poundOnce takes the real enforcement branch.
function poundHarness(cfg: PoundHarnessCfg = {}) {
  const {
    latencyMs = 40,
    statusCode = 200,
    httpOk = true,
    mcpOk = true,
    mcpThrows = false,
    dashboardUrl = "http://127.0.0.1:9/dash/",
    mcpToolNames = [],
    latencyBoundMs,
  } = cfg;
  const pounding: Record<string, unknown> = { dashboardUrl, mcpToolNames };
  if (latencyBoundMs !== undefined) pounding.latencyBoundMs = latencyBoundMs;
  const ctx = {
    clock: poundClock(),
    proc: {
      httpGet: async () => ({ ok: httpOk, statusCode, latencyMs }),
      mcpTool: async () => {
        if (mcpThrows) throw new Error("injected MCP transport error");
        return { ok: mcpOk, statusCode, latencyMs };
      },
    },
    opts: { pounding },
  };
  const state = freshPoundState(ctx.clock);
  const enabled = enablePounding(ctx, state, "A");
  assert.equal(enabled.ok, true, enabled.reason ?? "pounding must enable with injected adapters");
  return { ctx, state };
}

describe("tier2-storm-latency-bound (US-002 enforcement)", () => {
  it("(a) a 3_000 ms dashboard observation passes under the 4_000 ms default", async () => {
    const { ctx, state } = poundHarness({ latencyMs: 3_000, mcpToolNames: [] });
    const res = await poundOnce(ctx, state, "A");
    assert.equal(res.failures, 0, "3s is inside the new interim bound");
    assert.equal(res.probes.length, 1);
    assert.equal(res.probes[0].kind, "dashboard_http");
    assert.equal(res.probes[0].ok, true);
    assert.equal(res.probes[0].latencyMs, 3_000);
    assert.equal(state.rounds.A.pounding.assertionFailures, 0);
  });

  it("(b) exactly 4_000 ms passes — the boundary stays inclusive", async () => {
    const { ctx, state } = poundHarness({ latencyMs: 4_000, mcpToolNames: [] });
    const res = await poundOnce(ctx, state, "A");
    assert.equal(res.failures, 0, "latencyMs <= latencyBoundMs means exactly 4s passes");
    assert.equal(res.probes[0].ok, true);
    assert.equal(res.probes[0].latencyMs, 4_000);
    assert.equal(state.rounds.A.pounding.assertionFailures, 0);
  });

  it("(c) 4_001 ms fails — the bound is still enforced, not relaxed away", async () => {
    const { ctx, state } = poundHarness({ latencyMs: 4_001, mcpToolNames: [] });
    const res = await poundOnce(ctx, state, "A");
    assert.equal(res.failures, 1);
    assert.equal(res.probes[0].ok, false);
    assert.equal(res.probes[0].latencyMs, 4_001);
    assert.equal(state.rounds.A.pounding.assertionFailures, 1);
  });

  it("(d) HTTP 5xx still fails even with low latency", async () => {
    const { ctx, state } = poundHarness({ latencyMs: 10, httpOk: false, statusCode: 503, mcpToolNames: [] });
    const res = await poundOnce(ctx, state, "A");
    assert.equal(res.failures, 1, "a 5xx is a failure regardless of the latency bound");
    assert.equal(res.probes[0].ok, false);
    assert.equal(res.probes[0].statusCode, 503);
    assert.equal(state.rounds.A.pounding.assertionFailures, 1);
  });

  it("(d) an MCP result with ok:false still fails even with low latency", async () => {
    const { ctx, state } = poundHarness({
      latencyMs: 10,
      mcpOk: false,
      dashboardUrl: null,
      mcpToolNames: ["tamandua.runs.list"],
    });
    const res = await poundOnce(ctx, state, "A");
    assert.equal(res.failures, 1, "an MCP error is a failure regardless of the latency bound");
    assert.equal(res.probes.length, 1);
    assert.equal(res.probes[0].kind, "mcp_tool");
    assert.equal(res.probes[0].ok, false);
    assert.equal(state.rounds.A.pounding.assertionFailures, 1);
  });

  it("(d) an MCP transport throw still fails even with low latency", async () => {
    const { ctx, state } = poundHarness({
      latencyMs: 10,
      mcpThrows: true,
      dashboardUrl: null,
      mcpToolNames: ["tamandua.runs.list"],
    });
    const res = await poundOnce(ctx, state, "A");
    assert.equal(res.failures, 1);
    assert.equal(res.probes[0].ok, false);
    assert.match(String(res.probes[0].error), /injected MCP transport error/);
  });

  it("(e) an explicit 2_000 ms override rejects 2_001 ms and accepts 2_000 ms", async () => {
    const over = poundHarness({ latencyMs: 2_001, latencyBoundMs: 2_000, mcpToolNames: [] });
    assert.equal(over.state.rounds.A.pounding.latencyBoundMs, 2_000, "the override is recorded, not replaced by the default");
    const overRes = await poundOnce(over.ctx, over.state, "A");
    assert.equal(overRes.failures, 1);
    assert.equal(overRes.probes[0].ok, false);

    const at = poundHarness({ latencyMs: 2_000, latencyBoundMs: 2_000, mcpToolNames: [] });
    const atRes = await poundOnce(at.ctx, at.state, "A");
    assert.equal(atRes.failures, 0, "the override boundary is still inclusive");
    assert.equal(atRes.probes[0].ok, true);
  });

  it("(e) an explicit 10_000 ms override lets 9_000 ms pass", async () => {
    const { ctx, state } = poundHarness({ latencyMs: 9_000, latencyBoundMs: 10_000, mcpToolNames: [] });
    assert.equal(state.rounds.A.pounding.latencyBoundMs, 10_000);
    const res = await poundOnce(ctx, state, "A");
    assert.equal(res.failures, 0);
    assert.equal(res.probes[0].ok, true);
    assert.equal(res.probes[0].latencyMs, 9_000);
  });

  it("(f) poundingConfig applies the 4_000 ms default and enablePounding records it", () => {
    // A pounding config must exist for pounding to be active at all; with no
    // `opts.pounding` the engine reports a first-class NOT_RUN (null config),
    // so the default bound is observed on the provided (empty) config.
    assert.equal(poundingConfig({ opts: {} }), null, "no config is NOT_RUN, not a fabricated bound");
    const cfg = poundingConfig({ opts: { pounding: {} } });
    assert.equal(cfg?.latencyBoundMs, 4_000);
    assert.equal(cfg?.latencyBoundMs, POUND_LATENCY_BOUND_MS);

    const { ctx, state } = poundHarness({ latencyMs: 10, mcpToolNames: [] });
    assert.equal(state.rounds.A.pounding.latencyBoundMs, POUND_LATENCY_BOUND_MS);
    assert.equal(poundingConfig(ctx)?.latencyBoundMs, POUND_LATENCY_BOUND_MS);
    assert.equal(state.rounds.A.pounding.latencyBoundMs, 4_000);
  });

  it("(f) newCampaignState A/B metadata both equal POUND_LATENCY_BOUND_MS", () => {
    const state = freshPoundState(poundClock());
    assert.equal(state.rounds.A.pounding.latencyBoundMs, POUND_LATENCY_BOUND_MS);
    assert.equal(state.rounds.B.pounding.latencyBoundMs, POUND_LATENCY_BOUND_MS);
    assert.equal(state.rounds.A.pounding.latencyBoundMs, 4_000);
    assert.equal(state.rounds.B.pounding.latencyBoundMs, 4_000);
  });

  it("(f) the rehearsal constant is 4_000 and both wiring sites use it", () => {
    assert.equal(REHEARSAL_POUND_LATENCY_BOUND_MS, 4_000);
    assert.equal(REHEARSAL_POUND_LATENCY_BOUND_MS, POUND_LATENCY_BOUND_MS);

    // The engine's automatic rehearsal wiring (tt-storm-engine.mjs, in the
    // rehearsing branch of runStorm) and the rehearsal runner's prepared
    // opts (tt-storm-rehearsal.mjs) must both pass the EXPORTED constant,
    // never a literal. One wiring site per file.
    const engine = read("bin/tt-storm-engine.mjs");
    assert.match(engine, /^\s+REHEARSAL_POUND_LATENCY_BOUND_MS,$/m, "engine imports the rehearsal constant");
    const engineSites = engine.match(/latencyBoundMs: REHEARSAL_POUND_LATENCY_BOUND_MS,/g) ?? [];
    assert.equal(engineSites.length, 1, "engine wires the rehearsal constant into the auto pounding config");
    assert.match(engine, /cadenceMs: REHEARSAL_POUND_INTERVAL_MS,\n\s+latencyBoundMs: REHEARSAL_POUND_LATENCY_BOUND_MS,/);

    const rehearsal = read("bin/tt-storm-rehearsal.mjs");
    const rehearsalSites = rehearsal.match(/latencyBoundMs: REHEARSAL_POUND_LATENCY_BOUND_MS,/g) ?? [];
    assert.equal(rehearsalSites.length, 1, "rehearsal runner wires the exported constant into prepared opts");
    assert.match(rehearsal, /cadenceMs: REHEARSAL_POUND_INTERVAL_MS,\n\s+latencyBoundMs: REHEARSAL_POUND_LATENCY_BOUND_MS,/);

    // No literal 2000/4000 bound may be wired at either site.
    assert.doesNotMatch(engine, /latencyBoundMs: (?:2|4)_?000,/);
    assert.doesNotMatch(rehearsal, /latencyBoundMs: (?:2|4)_?000,/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// US-003 — the acceptance bound must be reachable through the transport.
// A separate 2000 ms request/abort deadline in a probe adapter would cut a
// probe short before the engine's 4000 ms acceptance comparison could ever
// see it, silently making the interim bound unenforceable. These checks
// inspect the REAL adapters' own source (Function#toString) so the default
// timeout is asserted where it is declared, not re-derived from a copy.
// Static/in-process only: no fetch, no daemon, no timing.
// ─────────────────────────────────────────────────────────────────────

interface AdapterDeadline {
  name: string;
  fn: (...args: never[]) => unknown;
}

const REAL_ADAPTERS: AdapterDeadline[] = [
  { name: "makeRealHttpGet", fn: makeRealHttpGet as (...args: never[]) => unknown },
  { name: "makeRealControlGet", fn: makeRealControlGet as (...args: never[]) => unknown },
  { name: "makeRealMcpTool", fn: makeRealMcpTool as (...args: never[]) => unknown },
  { name: "REAL_PROC.httpGet", fn: REAL_PROC.httpGet as (...args: never[]) => unknown },
];

// Parse `timeoutMs = <literal>` out of an adapter's declaration source. The
// default is what the operator CLI actually passes (makeRealProc constructs
// the adapters with no timeout override), so it must not be below the
// acceptance bound or a slow-but-passing probe would be aborted first.
function declaredDefaultTimeoutMs(fn: (...args: never[]) => unknown): number {
  const src = fn.toString();
  const match = src.match(/timeoutMs\s*=\s*([0-9][0-9_]*)/);
  assert.ok(match, `adapter has no declared timeoutMs default:\n${src}`);
  return Number(String(match[1]).replaceAll("_", ""));
}

describe("tier2-storm-latency-bound (US-003 adapter deadlines)", () => {
  it("every real probe adapter's default timeout is at least the 4000 ms bound", () => {
    for (const { name, fn } of REAL_ADAPTERS) {
      const defaultMs = declaredDefaultTimeoutMs(fn);
      assert.ok(
        defaultMs >= POUND_LATENCY_BOUND_MS,
        `${name} default timeout ${defaultMs} ms is below the enforced ${POUND_LATENCY_BOUND_MS} ms bound`,
      );
      // The audited current defaults are 5_000 ms; require at least a full
      // second of headroom over the bound so a probe that legitimately takes
      // just under 4 s is not aborted at the boundary.
      assert.ok(
        defaultMs > POUND_LATENCY_BOUND_MS,
        `${name} must leave headroom over the ${POUND_LATENCY_BOUND_MS} ms bound`,
      );
    }
  });

  it("no real probe adapter carries a separate 2000 ms hard deadline", () => {
    for (const { name, fn } of REAL_ADAPTERS) {
      const src = fn.toString();
      assert.doesNotMatch(src, /\b2_?000\b/, `${name} still contains a 2000 ms deadline:\n${src}`);
    }
    // The adapter modules themselves must be free of any 2000 ms literal
    // (timeout, AbortSignal, or Date.now()+2000 style deadline).
    for (const relPath of ["bin/tt-storm-real.mjs", "bin/tt-storm-shared.mjs"]) {
      const offenders = lines(read(relPath))
        .map((line, index) => [index + 1, line] as const)
        .filter(([, line]) => /\b2_?000\b/.test(line));
      assert.deepEqual(
        offenders,
        [],
        `${relPath} still contains a 2000 ms literal: ${offenders.map(([n, l]) => `${n}: ${l.trim()}`).join(" | ")}`,
      );
    }
  });

  it("the real proc wiring uses the adapters' own defaults (no short override)", () => {
    const real = read("bin/tt-storm-real.mjs");
    // makeRealProc must construct the dashboard/http adapters with no
    // timeoutMs override; the adapter defaults above are then what the
    // approved rehearsal actually runs with.
    assert.match(real, /httpGet: makeRealHttpGet\(\),/);
    assert.match(real, /mcpTool: makeRealMcpTool\(\{ endpointUrl: [^\n]*\}\),/);
    assert.doesNotMatch(real, /makeRealHttpGet\(\{[^}]*timeoutMs\s*:/);
    assert.doesNotMatch(real, /makeRealMcpTool\(\{[^}]*timeoutMs\s*:/);

    // The static shared proc delegates MCP to makeRealMcpTool without a
    // timeout override as well.
    const shared = read("bin/tt-storm-shared.mjs");
    assert.doesNotMatch(shared, /makeRealMcpTool\(\{[^}]*timeoutMs\s*:/);
  });
});
