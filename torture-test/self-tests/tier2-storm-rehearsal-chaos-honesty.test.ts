// Tier-2 STORM-REHEARSAL FIX-4 US-009 — chaos honesty at the subprocess level.
//
// Requirement 1c: a killed/rugpulled/parked scripted run must show the
// PRODUCT's real recovery (a fresh claim/retry path), never a canned
// "recovered" outcome baked into the harness. This file proves that at the
// process boundary:
//
//   (a) the REAL scripted runtime wrappers
//       (torture-test/scripted-runtimes/bin/scripted-pi and scripted-hermes)
//       are spawned as subprocesses in a temp dir with a fake `tamandua` CLI
//       answering the step protocol, a hold behavior, and the state/hold dirs
//       under the temp dir;
//   (b) while the round is parked on the campaign hold checkpoint the child is
//       SIGKILLed — asserting it really died, wrote NO step completion, and
//       wrote no recovery marker (there is no in-process canned recovery);
//   (c) re-invoking the same runtime re-claims the step and re-writes the hold
//       checkpoint — the real product retry path, with the behavior index
//       advancing per invocation;
//   (d) releasing the checkpoint lets the re-invoked runtime proceed to the
//       real `step complete` (real recovery, not a fabricated outcome);
//   (e) no source under torture-test/scripted-runtimes/ or the engine
//       (torture-test/bin/tt-storm-engine.mjs) contains a canned "recovered"
//       status fallback, and the engine's kill / stop+delete+relaunch /
//       mass-rugpull phase adapters build only real operator argv and the
//       report projects only the honest state buckets (red/missing/not_run/
//       inconclusive) — never a fabricated "recovered" state.
//
// Native product finding note (requirement 1c): this file deliberately does
// NOT fix src/. If a future run reveals that the real scheduler fails to
// relaunch a killed harness, the evidence belongs here as a recorded finding.
// Today's observation is the expected one: the harness itself never recovers
// (it is dead), and the only recovery is the product re-invoking it, which
// re-runs the claim protocol from scratch (workIndex 0 -> 1).
//
// Hermetic: temp dirs, a fake CLI, no live daemon, no ports, no model tokens.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildChaosArgv,
  buildStormReport,
} from "../bin/tt-storm-engine.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIMES_DIR = path.resolve(HERE, "..", "scripted-runtimes");
const ENGINE_PATH = path.resolve(HERE, "..", "bin", "tt-storm-engine.mjs");

const SCRIPTED_PI = path.join(RUNTIMES_DIR, "bin", "scripted-pi");
const SCRIPTED_HERMES = path.join(RUNTIMES_DIR, "bin", "scripted-hermes");

const WORKFLOW_ID = "wf-chaos-honesty";
const AGENT_ID = `${WORKFLOW_ID}_developer`;
const RUN_ID = "run-33333333-3333-3333-3333-333333333333";
const STEP_ID = "step-44444444-4444-4444-4444-444444444444";
const HOLD_TIMEOUT_MS = 600_000;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // diagnostics-only cleanup
    }
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${file}`);
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function readCalls(logPath: string): string[] {
  try {
    return fs
      .readFileSync(logPath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function countPrefix(calls: string[], prefix: string): number {
  return calls.filter((c) => c.startsWith(prefix)).length;
}

function readJournal(stateDir: string): any[] {
  try {
    return fs
      .readFileSync(path.join(stateDir, "invocations.jsonl"), "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// A fake `tamandua` CLI: answers the step protocol and journals every call to
// a single log so the test can prove what the runtime actually did (claim,
// complete, fail) — not what its stdout claims. It is a real executable shell
// script so createCli() detects the shebang and execs it directly.
function writeFakeCli(binDir: string, logPath: string): string {
  const cliPath = path.join(binDir, "tamandua");
  const lines = [
    "#!/usr/bin/env bash",
    `LOG="\${TAMANDUA_FAKE_CLI_LOG:-${logPath}}"`,
    'cmd="${1:-}"; sub="${2:-}"',
    "{",
    "  printf '%s %s' \"$cmd\" \"$sub\"",
    "  shift 2 2>/dev/null || true",
    "  for a in \"$@\"; do printf ' %s' \"$a\"; done",
    "  printf '\\n'",
    "} >> \"$LOG\"",
    'case "$cmd $sub" in',
    '  "step peek") echo "HAS_WORK" ;;',
    `  "step claim") echo '{"stepId":"${STEP_ID}","runId":"${RUN_ID}","input":""}' ;;`,
    '  "step complete"|"step fail") cat >/dev/null ;;',
    '  *) echo "fake-tamandua: unhandled: $cmd $sub" >&2; exit 1 ;;',
    "esac",
    "",
  ];
  fs.writeFileSync(cliPath, lines.join("\n"), { mode: 0o755 });
  return cliPath;
}

function writeBehaviors(behaviorsPath: string): void {
  fs.writeFileSync(
    behaviorsPath,
    JSON.stringify({
      agents: {
        developer: {
          hold: { id: "storm-midflight", timeoutMs: HOLD_TIMEOUT_MS },
          output: "STATUS: done\nCHANGES: real held round\n",
        },
      },
      heartbeatTokens: 17,
      defaultTokens: 111,
    }) + "\n",
    "utf-8",
  );
}

function buildPrompt(cliPath: string): string {
  return [
    `You are agent "developer" for workflow "${WORKFLOW_ID}", agent "${AGENT_ID}", run "${RUN_ID}".`,
    "",
    "CLAIM:",
    `"${cliPath}" step claim "${AGENT_ID}" --run-id "${RUN_ID}"`,
    "",
  ].join("\n");
}

interface RoundHandle {
  child: ReturnType<typeof spawn>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  out: () => { stdout: string; stderr: string };
}

// Spawn one real scripted-runtime round against the temp campaign, SIGKILL it
// mid-hold, prove the kill left no completion, re-invoke (real retry), then
// release and prove the re-invoked round reaches step complete.
async function chaosHonestyScenario(
  label: string,
  binPath: string,
  argvFor: (prompt: string) => string[],
): Promise<void> {
  assert.ok(fs.existsSync(binPath), `${label} wrapper must exist at ${binPath}`);

  const root = makeTempDir(`storm-chaos-honesty-${label}-`);
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const logPath = path.join(root, "cli-calls.log");
  fs.writeFileSync(logPath, "");
  const cliPath = writeFakeCli(binDir, logPath);

  const stateDir = path.join(root, "state");
  const holdDir = path.join(root, "holds");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(holdDir, { recursive: true });

  const behaviorsPath = path.join(root, "behaviors.json");
  writeBehaviors(behaviorsPath);
  const prompt = buildPrompt(cliPath);

  const confirmedPath = path.join(holdDir, `${RUN_ID}.confirmed`);
  const releasePath = path.join(holdDir, `${RUN_ID}.release`);
  const missedPath = path.join(holdDir, `${RUN_ID}.missed`);

  const children: ReturnType<typeof spawn>[] = [];

  const spawnRound = (): RoundHandle => {
    const child = spawn(binPath, argvFor(prompt), {
      cwd: root,
      env: {
        ...process.env,
        TAMANDUA_SCRIPTED_STATE: stateDir,
        TAMANDUA_SCRIPTED_BEHAVIORS: behaviorsPath,
        TAMANDUA_SCRIPTED_HOLD_DIR: holdDir,
        TAMANDUA_FAKE_CLI_LOG: logPath,
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    return { child, exited, out: () => ({ stdout, stderr }) };
  };

  try {
    // ── (b) first round: parked on the hold, then SIGKILLed ─────────────
    const first = spawnRound();
    await waitForFile(confirmedPath, 20_000).catch((err) => {
      throw new Error(
        `${label} first round never confirmed its hold: ${err.message}\n` +
          `stderr=${first.out().stderr.slice(0, 800)}\nstdout=${first.out().stdout.slice(0, 400)}`,
      );
    });

    // The round is now claimed and parked (worker alive) — kill it mid-hold.
    first.child.kill("SIGKILL");
    const firstExit = await withTimeout(
      first.exited,
      10_000,
      `${label} first round did not die after SIGKILL`,
    );
    assert.equal(firstExit.signal, "SIGKILL", `${label} first round must die from SIGKILL`);
    assert.equal(firstExit.code, null, `${label} a signal-killed process has no exit code`);

    // Give any (impossible) post-kill write a moment to land before auditing.
    await sleep(150);

    const callsAfterKill = readCalls(logPath);
    assert.equal(countPrefix(callsAfterKill, "step peek"), 1, `${label} first round peeks once`);
    assert.equal(countPrefix(callsAfterKill, "step claim"), 1, `${label} first round claims once`);
    assert.equal(
      countPrefix(callsAfterKill, "step complete"),
      0,
      `${label}: a SIGKILLed held round must NOT report step complete (no in-process canned recovery)`,
    );
    assert.equal(
      countPrefix(callsAfterKill, "step fail"),
      0,
      `${label}: a SIGKILLed held round must NOT report a fabricated failure/recovery`,
    );
    assert.equal(
      fs.existsSync(missedPath),
      false,
      `${label}: a SIGKILLed round must not write a recovery/missed marker`,
    );

    // Drop the checkpoint so the re-invocation genuinely has to re-confirm it.
    fs.rmSync(confirmedPath, { force: true });

    // ── (c) re-invoke: the real product retry path ──────────────────────
    const second = spawnRound();
    await waitForFile(confirmedPath, 20_000).catch((err) => {
      throw new Error(
        `${label} re-invocation never re-confirmed the hold (real retry path failed): ${err.message}\n` +
          `stderr=${second.out().stderr.slice(0, 800)}\nstdout=${second.out().stdout.slice(0, 400)}`,
      );
    });
    const callsAfterRetry = readCalls(logPath);
    assert.equal(
      countPrefix(callsAfterRetry, "step claim"),
      2,
      `${label}: re-invocation must re-claim the step (a fresh process, not a canned recovery)`,
    );

    const journal = readJournal(stateDir);
    const claimed = journal.filter((e) => e.note === "claimed");
    assert.deepEqual(
      claimed.map((e) => e.workIndex),
      [0, 1],
      `${label}: the behavior index must advance across invocations (0 -> 1)`,
    );
    assert.ok(
      journal.some((e) => e.phase === "hold_wait"),
      `${label}: both rounds park on the campaign hold checkpoint`,
    );

    // ── (d) release: the re-invoked round proceeds to step complete ─────
    fs.writeFileSync(releasePath, "go\n", "utf-8");
    const secondExit = await withTimeout(
      second.exited,
      20_000,
      `${label} released round did not finish (stderr=${second.out().stderr.slice(0, 400)})`,
    );
    assert.equal(
      secondExit.code,
      0,
      `${label} released round must exit 0 (stderr: ${second.out().stderr.slice(0, 400)})`,
    );

    const finalCalls = readCalls(logPath);
    assert.equal(
      countPrefix(finalCalls, "step complete"),
      1,
      `${label}: the released re-invoked round must reach the real step complete`,
    );
    assert.ok(
      second.out().stdout.includes("STATUS: done"),
      `${label}: the completed round emits its real STATUS report`,
    );
    assert.equal(
      fs.existsSync(missedPath),
      false,
      `${label}: a released hold must not leave a missed/recovered marker`,
    );
  } finally {
    for (const child of children) {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead
      }
    }
  }
}

describe("tier2-storm-rehearsal-chaos-honesty (US-009)", () => {
  it("scripted-pi: SIGKILL mid-hold -> no completion; re-invoke re-claims; release completes", async () => {
    await chaosHonestyScenario("pi", SCRIPTED_PI, (prompt) => [
      "--print",
      "--mode",
      "json",
      "--no-session",
      prompt,
    ]);
  });

  it("scripted-hermes: SIGKILL mid-hold -> no completion; re-invoke re-claims; release completes", async () => {
    await chaosHonestyScenario("hermes", SCRIPTED_HERMES, (prompt) => [
      "chat",
      "--max-turns",
      "8192",
      "--yolo",
      "-Q",
      "-q",
      prompt,
    ]);
  });

  it("no scripted-runtime source contains a canned 'recovered' fallback", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        let content: string;
        try {
          content = fs.readFileSync(full, "utf-8");
        } catch {
          continue;
        }
        if (content.toLowerCase().includes("recovered")) offenders.push(full);
      }
    };
    walk(RUNTIMES_DIR);
    assert.deepEqual(
      offenders,
      [],
      `chaos recovery must be the product's real recovery, never a canned 'recovered' fallback`,
    );
  });

  it("the engine contains no canned 'recovered' status outside the legitimate rugpull-recovered marker", () => {
    const src = fs.readFileSync(ENGINE_PATH, "utf-8");
    // The engine legitimately names the B-bounce wait marker 'rugpull-recovered'
    // — a predicate label, not a run/phase status. Strip exactly that marker and
    // assert nothing else in the engine fabricates a 'recovered' outcome.
    assert.ok(
      src.includes("rugpull-recovered"),
      "the real B-bounce wait marker must still exist (guard is not vacuous)",
    );
    const withoutMarker = src.replaceAll("rugpull-recovered", "");
    assert.equal(
      /recovered/i.test(withoutMarker),
      false,
      "tt-storm-engine.mjs must not contain any other 'recovered' status/fallback",
    );
  });

  it("kill / stop+delete+relaunch / mass-rugpull adapters build only real operator argv (never 'recovered')", () => {
    const fixtureIdentity = {
      colleagueRepo: "/fixture/colleague",
      cc1File: "src/one.ts",
      cc2File: "src/one.ts",
      parkRepo: "/fixture/origin",
      originRepo: "/fixture/origin",
    };
    const ctx = { opts: { fixtureIdentity } };
    const state = {
      plan: { fixtureIdentity },
      rounds: {
        A: { runs: {} },
        B: {
          runs: {
            B1: { runId: "run-b1" },
            B4: { runId: "run-b4" },
            B5: { runId: "run-b5" },
          },
        },
      },
    };

    const cases = [
      { action: { kind: "kill_harness", target: "B4", signal: "SIGKILL" }, runId: "run-b4", expect: "kill-harness" },
      { action: { kind: "mass_rugpull", targets: ["B1", "B2", "B3", "B4"] }, runId: "run-b1", expect: "colleague-commit" },
      { action: { kind: "colleague_commit", target: "B1", fileRole: "cc1" }, runId: "run-b1", expect: "colleague-commit" },
      { action: { kind: "dirty_tree_park" }, runId: "run-b4", expect: "dirty-tree" },
    ];

    for (const c of cases) {
      const built = buildChaosArgv(ctx as any, state as any, c.action as any, c.runId);
      assert.equal(built.ok, true, `${c.action.kind} must build a real operator argv`);
      assert.equal(built.argv[0], "tt-chaos", `${c.action.kind} dispatches the real tt-chaos operator`);
      assert.ok(
        built.argv.includes(c.expect),
        `${c.action.kind} argv must invoke ${c.expect}: ${JSON.stringify(built.argv)}`,
      );
      assert.ok(
        built.argv.some((a) => a.includes(c.runId)),
        `${c.action.kind} argv must name the real target run id`,
      );
      assert.equal(
        built.argv.some((a) => /recovered/i.test(a)),
        false,
        `${c.action.kind} must never emit a fabricated 'recovered' operator argv`,
      );
    }

    // Inspect the canonical actionPlan source: the stop+delete+relaunch lineage
    // is real (stop, delete, then a real launch step) and none of the
    // kill/stopdel/rugpull branches mention a fabricated 'recovered' outcome.
    const src = fs.readFileSync(ENGINE_PATH, "utf-8");
    const apStart = src.indexOf("function actionPlan(");
    const apEnd = src.indexOf("\nfunction targetRunId", apStart);
    assert.ok(apStart >= 0 && apEnd > apStart, "actionPlan must be present in the engine");
    const actionPlanSrc = src.slice(apStart, apEnd);
    assert.ok(actionPlanSrc.includes("case 'kill_harness'"), "kill_harness adapter present");
    assert.ok(actionPlanSrc.includes("case 'stop_delete_relaunch'"), "stop_delete_relaunch adapter present");
    assert.ok(actionPlanSrc.includes("case 'mass_rugpull'"), "mass_rugpull adapter present");
    assert.ok(actionPlanSrc.includes("'workflow', 'stop'"), "stopdel stops the run");
    assert.ok(actionPlanSrc.includes("'workflow', 'delete'"), "stopdel deletes the run");
    assert.ok(actionPlanSrc.includes("channel: 'launch'"), "stopdel relaunches a real run");
    assert.equal(
      /recovered/i.test(actionPlanSrc),
      false,
      "no chaos phase adapter fabricates a 'recovered' outcome",
    );
  });

  it("the report projects only the honest state buckets and never invents a 'recovered' state", () => {
    const ctx = { clock: { nowUtc: () => "2026-09-12T00:00:00Z" }, fs: {} };
    const state: any = {
      campaign_id: "storm-chaos-honesty",
      source: {},
      qualification: { real_launch_allowed: false },
      cleanup: { ledger: [] },
      sampler: { samples: [], sample_gaps: [] },
      queue: { attempts: [] },
      rounds: {
        A: { status: "round_done", runs: {}, phases: {} },
        B: {
          status: "round_done",
          runs: {
            B1: {
              rosterId: "B1",
              run: "b1",
              workflow: "wf",
              harness: "pi",
              runId: "run-b1",
              status: "running",
              terminalStatus: "completed",
              children: [],
            },
            // A killed B4 shows the product's inconclusive state — never a
            // fabricated recovered state.
            B4: {
              rosterId: "B4",
              run: "b4",
              workflow: "wf",
              harness: "pi",
              runId: "run-b4",
              status: "terminal",
              terminalStatus: "failed",
              children: [],
            },
          },
          phases: {
            "B-kill": { id: "B-kill", status: "fired", firedAt: "2026-09-12T00:00:00Z" },
            "B-stopdel": { id: "B-stopdel", status: "not_run", notRunReason: "target terminal" },
          },
        },
      },
    };

    const report = buildStormReport(ctx as any, state);
    assert.deepEqual(
      Object.keys(report.states).sort(),
      ["inconclusive", "missing", "not_run", "red"],
      "the report exposes only the four honest state buckets",
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(report.states, "recovered"),
      "there must be no fabricated 'recovered' report state",
    );
    assert.ok(
      report.states.inconclusive.some((x: any) => x.rosterId === "B4"),
      "the killed B4 is reported inconclusive, not recovered",
    );
    assert.equal(
      JSON.stringify(report).toLowerCase().includes('"recovered"'),
      false,
      "no report field fabricates a 'recovered' status",
    );
    const phaseStatuses = report.rounds.B.phases.map((p: any) => p.status);
    assert.equal(phaseStatuses.includes("recovered"), false, "no phase reports a 'recovered' status");
  });
});
