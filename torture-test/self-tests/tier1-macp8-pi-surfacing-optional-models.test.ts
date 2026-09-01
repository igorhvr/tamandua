// MACP8 US-003 — red-then-green self-test for optional models.json surfacing.
//
// Pins the darwin-parity contract: a fixture operator HOME whose ~/.pi/agent
// has settings.json (+ auth.json + hermes files) but NO models.json was
// fail-closed BEFORE the fix (the pi surfacing enumeration treated the
// optional models.json as mandatory) and is GREEN AFTER it — while a missing
// REQUIRED auth.json still fails closed in BOTH fixture variants (models.json
// absent AND present).
//
// Zero tokens. Hermetic: every fixture lives under os.tmpdir(); the contained
// home is pinned via TT_VAR; the operator copy source is pinned via
// TT_OPERATOR_HOME; the pi answer leg is a FAKE binary via TAMANDUA_PI_BINARY
// (never a real model). No daemon/campaign is started, so self-tests/run.sh
// auto-discovers this file via the tier1-*.test.ts glob (non-heavy — no
// HEAVY_CAMPAIGN_TESTS registration).
//
// History-independent RED arm: the pre-fix pi required enumeration is
// synthesized INLINE (the old list settings.json + models.json + auth.json
// with the exact `missing surfaced file(s): ...` / `copy-missing:...` message
// formats) — no git-log / git-archive / hardcoded-SHA resolution, satisfying
// the tier0-history-independent-red-arms meta-lint.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const binDir = path.join(repoRoot, "torture-test", "bin");
const provisionHome = path.join(binDir, "tt-provision-home");
const authProbe = path.join(binDir, "tt-harness-auth-probe");

// pi API-key env vars materialized by tt-provision-home's surface_env_api_keys.
// Unset them in spawned envs so the test is deterministic and never copies a
// live operator credential into the hermetic contained home.
const PI_API_KEY_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANT_LING_API_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "NVIDIA_API_KEY",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "MINIMAX_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "KIMI_API_KEY",
  "OPENCODE_API_KEY",
];

interface Fixture {
  root: string;
  operator: string;
  varDir: string;
  contained: string;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

const createdRoots: string[] = [];

function testEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TAMANDUA_TEST_GUARD: "0" };
  for (const key of PI_API_KEY_ENV_VARS) delete env[key];
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv): CommandResult {
  const res = spawnSync(file, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function makeTempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  createdRoots.push(root);
  return root;
}

// makeOperatorFixture: a hermetic operator HOME with .pi/agent settings.json,
// optional models.json, optional auth.json, and minimal hermes files. The
// contained home is $varDir/home (TT_VAR seam). models/auth flags drive the
// four fixture variants the contract needs.
function makeOperatorFixture(opts: { models: boolean; auth: boolean }): Fixture {
  const root = makeTempRoot("macp8-operator-");
  const operator = path.join(root, "operator");
  const varDir = path.join(root, "var");

  const agentDir = path.join(operator, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify(
      { defaultProvider: "deepseek", defaultModel: "deepseek-v4-pro", agentDir },
      null,
      2,
    ) + "\n",
  );
  if (opts.models) {
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { "local-dspark": { baseUrl: "http://localhost:1/v1" } } }, null, 2) + "\n",
    );
  }
  if (opts.auth) {
    fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
  }

  const hermesDir = path.join(operator, ".hermes");
  fs.mkdirSync(hermesDir, { recursive: true });
  fs.writeFileSync(path.join(hermesDir, "config.yaml"), "model:\n  default: gpt-5.6-sol\n");
  fs.writeFileSync(path.join(hermesDir, "auth.json"), JSON.stringify({ version: 1 }) + "\n");

  return { root, operator, varDir, contained: path.join(varDir, "home") };
}

// makeContainedFixture: a hermetic CONTAINED home (already surfaced, no
// provision run) for the probe-only fail-closed legs.
function makeContainedFixture(opts: { models: boolean; auth: boolean }): Fixture {
  const root = makeTempRoot("macp8-contained-");
  const varDir = path.join(root, "var");
  const contained = path.join(varDir, "home");
  const agentDir = path.join(contained, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "deepseek" }) + "\n");
  if (opts.models) {
    fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: {} }) + "\n");
  }
  if (opts.auth) {
    fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
  }
  return { root, operator: path.join(root, "operator"), varDir, contained };
}

// fakePi: a zero-token pi stand-in that exits 0 (a successful trivial answer).
function makeFakePi(root: string): string {
  const fakePi = path.join(root, "fake-pi");
  fs.writeFileSync(fakePi, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return fakePi;
}

// ── pre-fix synthesis (history-independent RED arm) ──────────────────
// The pre-fix pi required enumeration treated models.json as mandatory:
// settings.json + models.json + auth.json (the exact old list). The message
// formats are copied verbatim from the fail-closed seams so the RED claim is
// provably the pre-fix behavior, not a restatement.
const PRE_FIX_PI_REQUIRED = [
  ".pi/agent/settings.json",
  ".pi/agent/models.json",
  ".pi/agent/auth.json",
];

function preFixMissingSurfaced(home: string): string {
  const missing = PRE_FIX_PI_REQUIRED
    .filter((rel) => !fs.existsSync(path.join(home, rel)))
    .map((rel) => `${rel};`)
    .join("");
  return missing ? `missing surfaced file(s): ${missing}` : "";
}

function preFixProvisionCopyMissing(operator: string, contained: string): string {
  const legs: string[] = [];
  for (const rel of PRE_FIX_PI_REQUIRED) {
    if (!fs.existsSync(path.join(operator, rel)) || !fs.existsSync(path.join(contained, rel))) {
      legs.push(`copy-missing:${rel};`);
    }
  }
  return legs.join("");
}

describe("MACP8 US-003 — optional models.json surfacing red-then-green proof", () => {
  let fakePi: string;

  before(() => {
    const fakeRoot = makeTempRoot("macp8-fake-pi-");
    fakePi = makeFakePi(fakeRoot);
  });

  after(() => {
    for (const root of createdRoots.reverse()) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("GREEN arm: real tt-provision-home --fail-closed + tt-harness-auth-probe pi are green with models.json absent", () => {
    const fixture = makeOperatorFixture({ models: false, auth: true });

    const provision = run(
      provisionHome,
      ["--fail-closed"],
      testEnv({ HOME: fixture.operator, TT_OPERATOR_HOME: fixture.operator, TT_VAR: fixture.varDir }),
    );
    assert.equal(provision.status, 0, `tt-provision-home --fail-closed must exit 0:\n${provision.stdout}\n${provision.stderr}`);
    const provisionOut = provision.stdout + "\n" + provision.stderr;
    assert.ok(
      !provisionOut.includes("copy-missing:.pi/agent/models.json"),
      "provision must not name models.json copy-missing",
    );
    assert.ok(
      !provisionOut.includes("missing surfaced file(s): .pi/agent/models.json"),
      "provision must not name models.json missing",
    );

    // The contained home must have the REQUIRED surfaced files and no models.json.
    assert.ok(fs.existsSync(path.join(fixture.contained, ".pi", "agent", "settings.json")));
    assert.ok(fs.existsSync(path.join(fixture.contained, ".pi", "agent", "auth.json")));
    assert.ok(!fs.existsSync(path.join(fixture.contained, ".pi", "agent", "models.json")));

    const probe = run(
      authProbe,
      ["pi"],
      testEnv({ TT_VAR: fixture.varDir, TAMANDUA_PI_BINARY: fakePi }),
    );
    assert.equal(probe.status, 0, `tt-harness-auth-probe pi must exit 0:\n${probe.stdout}\n${probe.stderr}`);
    const probeOut = probe.stdout + "\n" + probe.stderr;
    assert.ok(
      !probeOut.includes("missing surfaced file(s): .pi/agent/models.json"),
      "probe must not name models.json missing",
    );
  });

  it("RED arm: the synthesized pre-fix pi enumeration names exactly models.json missing against the same fixture", () => {
    const fixture = makeOperatorFixture({ models: false, auth: true });

    // Materialize the contained home exactly as the post-fix provisioner does
    // (settings.json + auth.json surfaced; models.json skipped), then feed it
    // to the INLINE pre-fix enumeration.
    const containedAgent = path.join(fixture.contained, ".pi", "agent");
    fs.mkdirSync(containedAgent, { recursive: true });
    fs.writeFileSync(
      path.join(containedAgent, "settings.json"),
      JSON.stringify({ defaultProvider: "deepseek" }) + "\n",
    );
    fs.writeFileSync(path.join(containedAgent, "auth.json"), "{}\n");

    const missingSurfaced = preFixMissingSurfaced(fixture.contained);
    // The pre-fix presence loop appended `;` after each missing file, so the
    // single-missing output is the canonical contract string plus one trailing
    // list separator. Both the separator-faithful form and the canonical
    // quoted contract are pinned.
    assert.equal(
      missingSurfaced,
      "missing surfaced file(s): .pi/agent/models.json;",
      "pre-fix probe enumeration must emit exactly the models.json missing message (real format)",
    );
    assert.ok(
      missingSurfaced.includes("missing surfaced file(s): .pi/agent/models.json"),
      "pre-fix probe enumeration must name exactly models.json as the missing file",
    );

    const provisionDetail = preFixProvisionCopyMissing(fixture.operator, fixture.contained);
    assert.ok(
      provisionDetail.includes("copy-missing:.pi/agent/models.json;"),
      `pre-fix provision fail-closed DETAILS must name copy-missing:.pi/agent/models.json, got: ${provisionDetail}`,
    );
  });

  it("auth.json missing + models.json absent: probe fails closed and provision names copy-missing:.pi/agent/auth.json", () => {
    // Probe leg: contained home has settings.json + NO auth.json + NO models.json.
    const probeFixture = makeContainedFixture({ models: false, auth: false });
    const probe = run(
      authProbe,
      ["pi"],
      testEnv({ TT_VAR: probeFixture.varDir, TAMANDUA_PI_BINARY: fakePi }),
    );
    assert.notEqual(probe.status, 0, "probe pi must fail closed when auth.json is absent");
    const probeOut = probe.stdout + "\n" + probe.stderr;
    assert.ok(probeOut.includes("harness-auth-missing: pi"), `probe must emit harness-auth-missing: pi:\n${probeOut}`);
    assert.ok(
      probeOut.includes("missing surfaced file(s): .pi/agent/auth.json"),
      `probe must name .pi/agent/auth.json missing:\n${probeOut}`,
    );
    assert.ok(
      !probeOut.includes("missing surfaced file(s): .pi/agent/models.json"),
      "probe must not name models.json missing (optional)",
    );

    // Provision leg: operator home has settings.json + NO auth.json + NO models.json.
    const provisionFixture = makeOperatorFixture({ models: false, auth: false });
    const provision = run(
      provisionHome,
      ["--fail-closed"],
      testEnv({ HOME: provisionFixture.operator, TT_OPERATOR_HOME: provisionFixture.operator, TT_VAR: provisionFixture.varDir }),
    );
    assert.notEqual(provision.status, 0, "tt-provision-home --fail-closed must fail when auth.json is absent");
    const provisionOut = provision.stdout + "\n" + provision.stderr;
    assert.ok(provisionOut.includes("REASON: tt-home-unprovisioned"), `provision must emit tt-home-unprovisioned:\n${provisionOut}`);
    assert.ok(
      provisionOut.includes("copy-missing:.pi/agent/auth.json"),
      `provision must name copy-missing:.pi/agent/auth.json:\n${provisionOut}`,
    );
  });

  it("auth.json missing + models.json present: both tools still fail closed identically", () => {
    // Probe leg: contained home has settings.json + models.json + NO auth.json.
    const probeFixture = makeContainedFixture({ models: true, auth: false });
    const probe = run(
      authProbe,
      ["pi"],
      testEnv({ TT_VAR: probeFixture.varDir, TAMANDUA_PI_BINARY: fakePi }),
    );
    assert.notEqual(probe.status, 0, "probe pi must fail closed when auth.json is absent (models.json present)");
    const probeOut = probe.stdout + "\n" + probe.stderr;
    assert.ok(probeOut.includes("harness-auth-missing: pi"), `probe must emit harness-auth-missing: pi:\n${probeOut}`);
    assert.ok(
      probeOut.includes("missing surfaced file(s): .pi/agent/auth.json"),
      `probe must name .pi/agent/auth.json missing:\n${probeOut}`,
    );
    assert.ok(
      !probeOut.includes("missing surfaced file(s): .pi/agent/models.json"),
      "probe must not name models.json missing (it is present but optional)",
    );

    // Provision leg: operator home has settings.json + models.json + NO auth.json.
    const provisionFixture = makeOperatorFixture({ models: true, auth: false });
    const provision = run(
      provisionHome,
      ["--fail-closed"],
      testEnv({ HOME: provisionFixture.operator, TT_OPERATOR_HOME: provisionFixture.operator, TT_VAR: provisionFixture.varDir }),
    );
    assert.notEqual(provision.status, 0, "tt-provision-home --fail-closed must fail when auth.json is absent (models.json present)");
    const provisionOut = provision.stdout + "\n" + provision.stderr;
    assert.ok(provisionOut.includes("REASON: tt-home-unprovisioned"), `provision must emit tt-home-unprovisioned:\n${provisionOut}`);
    assert.ok(
      provisionOut.includes("copy-missing:.pi/agent/auth.json"),
      `provision must name copy-missing:.pi/agent/auth.json:\n${provisionOut}`,
    );
  });
});
