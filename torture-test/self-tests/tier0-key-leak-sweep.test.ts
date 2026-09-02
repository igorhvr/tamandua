// CRED-SURF US-006 — key-leak sweep red-arm self-test (zero tokens).
//
// Pins the hygiene extension that greps the newly materialized API-key VALUES
// (contained ~/.hermes/.env + contained ~/.pi/agent/auth.json — the surfaced
// materializations) over torture-test/var evidence/logs/audit/suite outputs:
//
//   AC1  red-arm: a planted fake key value in a fixture evidence/log/audit
//        file is DETECTED — the sweep exits non-zero and NAMES the offending
//        file.
//   AC2  clean fixture files (no planted values) → exit 0 with 0 hits.
//   AC3  the sweep's own source contains no literal key values (grep of
//        bin/tt-key-leak-sweep.mjs for the fixture sk-* values is empty).
//   AC4  the scanned-value set covers BOTH contained materialization files:
//        a value that lives only in hermes .env is detected, and a value
//        that lives only in pi auth.json is detected.
//   AC5  the contained credential files themselves (the value SOURCE) are
//        NOT reported as hits — only evidence/log/audit targets are.
//   AC6  fail-closed infra: a missing scan root exits 2; --help exits 0.
//
// Hermetic: every fixture lives under os.tmpdir(); the contained home is a
// fixture (fake sk-test-keyleak-* values only — never an operator key); the
// sweep is spawned with explicit --root/--home so no real env/tt-env.sh state
// is consulted. Zero tokens, no daemon, no campaign machinery — so
// self-tests/run.sh auto-discovers this file via the tier0-*.test.ts glob
// (non-heavy — no HEAVY_CAMPAIGN_TESTS registration).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const sweepTool = path.join(ttRoot, "bin", "tt-key-leak-sweep.mjs");

// Fixture VALUES (fake — never real credentials). Each distinct value is used
// in exactly one materialization file so AC4 can prove per-file coverage.
const HERMES_DOTENV_VALUE = "sk-test-keyleak-hermes-dotenv";
const PI_AUTH_VALUE = "sk-test-keyleak-pi-auth";
const PLANTED_EVIDENCE_VALUE = "sk-test-keyleak-hermes-dotenv";

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runSweep(args: string[]): CommandResult {
  const env: NodeJS.ProcessEnv = { ...process.env, TAMANDUA_TEST_GUARD: "0" };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [sweepTool, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

// ── fixture builders ───────────────────────────────────────────────────

interface Fixture {
  root: string;
  home: string; // contained home = $root/home (mirrors TT_VAR/home)
}

let fixtureRoots: string[] = [];

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tt-keyleak-"));
  fixtureRoots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  // contained ~/.hermes/.env — the hermes materialization (enumerated keys).
  fs.writeFileSync(
    path.join(home, ".hermes", ".env"),
    `DEEPSEEK_API_KEY=${HERMES_DOTENV_VALUE}\nANTHROPIC_API_KEY=sk-test-keyleak-hermes-anthropic\n`,
  );
  // contained ~/.pi/agent/auth.json — the pi materialization (api_key entry).
  fs.writeFileSync(
    path.join(home, ".pi", "agent", "auth.json"),
    `${JSON.stringify({
      deepseek: { type: "api_key", key: PI_AUTH_VALUE },
      openai: { type: "oauth", tokens: {} }, // non-api_key entries never scanned
    }, null, 2)}\n`,
  );
  return { root, home };
}

function writeEvidence(fixture: Fixture, relPath: string, content: string): string {
  const file = path.join(fixture.root, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe("CRED-SURF US-006 — key-leak sweep", () => {
  before(() => {
    fs.mkdirSync(ttRoot, { recursive: true });
  });
  after(() => {
    for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true });
    fixtureRoots = [];
  });

  it("AC1 red-arm: a planted fake value in an evidence file exits non-zero and names the offending file", () => {
    const fx = makeFixture();
    const cleanEvidence = writeEvidence(fx, "results/campaign-clean/state.json", '{"verdict":"GREEN"}\n');
    const planted = writeEvidence(
      fx,
      "results/campaign-leaky/evidence.log",
      `daemon round log\nleaked: ${PLANTED_EVIDENCE_VALUE}\n`,
    );
    const res = runSweep(["--root", fx.root, "--home", fx.home]);
    assert.equal(res.status, 1,
      `a planted key value must fail the sweep (exit 1):\n${res.stdout}\n${res.stderr}`);
    assert.ok(res.stdout.includes(planted),
      `the sweep must NAME the offending evidence file, got:\n${res.stdout}`);
    assert.ok(!res.stdout.includes(cleanEvidence),
      `a clean evidence file must NOT be named:\n${res.stdout}`);
    // Values never appear in output — only file paths + counts.
    assert.ok(!res.stdout.includes(HERMES_DOTENV_VALUE) && !res.stdout.includes(PI_AUTH_VALUE),
      "the sweep must never print key VALUES, only file paths");
  });

  it("AC2 clean: fixture files without planted values exit 0 with 0 hits", () => {
    const fx = makeFixture();
    writeEvidence(fx, "results/campaign-clean/state.json", '{"verdict":"GREEN"}\n');
    writeEvidence(fx, "logs/daemon.log", "no secrets in here\n");
    const res = runSweep(["--root", fx.root, "--home", fx.home]);
    assert.equal(res.status, 0, `clean fixture must exit 0:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /0 hits/);
  });

  it("AC5 the credential SOURCE files themselves are never reported", () => {
    // The contained home legitimately contains the values (they ARE the
    // materializations) — the sweep must exclude them from the scan.
    const fx = makeFixture();
    // Only the source files hold the values; no evidence planted.
    const res = runSweep(["--root", fx.root, "--home", fx.home]);
    assert.equal(res.status, 0,
      `source-only fixture must exit 0 (credential files are sources, not targets):\n${res.stdout}\n${res.stderr}`);
    assert.ok(!res.stdout.includes(".hermes/.env") && !res.stdout.includes("auth.json"),
      `the sweep must never name its own value-source files:\n${res.stdout}`);
  });

  it("AC4 coverage: values from BOTH hermes .env AND pi auth.json are in the scanned set", () => {
    // (a) a value that lives ONLY in the contained pi auth.json (never in
    //     hermes .env) is planted → detected.
    const fxA = makeFixture();
    const plantedPi = writeEvidence(fxA, "evidence-pi/audit.json", `{"note":"${PI_AUTH_VALUE}"}\n`);
    const resA = runSweep(["--root", fxA.root, "--home", fxA.home]);
    assert.equal(resA.status, 1, `pi-auth-only value must be detected:\n${resA.stdout}\n${resA.stderr}`);
    assert.ok(resA.stdout.includes(plantedPi), `sweep must name the pi-auth planted file:\n${resA.stdout}`);

    // (b) a value that lives ONLY in the contained hermes .env is planted →
    //     detected (hermes .env value; distinct from any auth.json value).
    const fxB = makeFixture();
    const plantedEnv = writeEvidence(fxB, "evidence-env/suite-output.txt", `${HERMES_DOTENV_VALUE}\n`);
    const resB = runSweep(["--root", fxB.root, "--home", fxB.home]);
    assert.equal(resB.status, 1, `hermes-dotenv-only value must be detected:\n${resB.stdout}\n${resB.stderr}`);
    assert.ok(resB.stdout.includes(plantedEnv), `sweep must name the hermes-dotenv planted file:\n${resB.stdout}`);
  });

  it("AC6 infra fail-closed: a missing scan root exits 2 with a reason", () => {
    const fx = makeFixture();
    const missing = path.join(fx.root, "does-not-exist");
    const res = runSweep(["--root", missing, "--home", fx.home]);
    assert.equal(res.status, 2, "a missing scan root must exit 2 (infra fail-closed)");
    assert.match(res.stderr, /scan-root-missing/);
  });

  it("--help exits 0 and documents the sweep", () => {
    const res = runSweep(["--help"]);
    assert.equal(res.status, 0, "--help must exit 0");
    assert.match(res.stdout, /tt-key-leak-sweep/);
    assert.match(res.stdout, /hermes\/\.env/);
    assert.match(res.stdout, /auth\.json/);
    assert.match(res.stdout, /0 hits exits 0/);
  });

  it("AC3 source hygiene: bin/tt-key-leak-sweep.mjs contains no literal key values", () => {
    const source = fs.readFileSync(sweepTool, "utf8");
    for (const fixtureValue of [
      HERMES_DOTENV_VALUE,
      PI_AUTH_VALUE,
      "sk-test-keyleak-hermes-anthropic",
      "sk-test-keyleak-",
    ]) {
      assert.ok(!source.includes(fixtureValue),
        `the sweep source must not embed the literal value '${fixtureValue}'`);
    }
  });
});
