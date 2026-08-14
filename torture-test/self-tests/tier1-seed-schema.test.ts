// US-001 — seed-ref support in the case manifest schema and validation.
//
// Real-case fixture provisioning reproduces each case's exact starting tree by
// checking a working clone out onto a seed git ref (green base + exactly one
// seeded defect, per spec 02-fixture-projects.md). The `seed` manifest field
// carries that ref NAME and must be strictly validated so the provisioning
// adapter never receives a malformed ref. This test pins the schema contract:
//   * `seed` is OPTIONAL and NULLABLE (absent or null = provision green base);
//   * a non-null `seed` must match the ref-name regex (no bad characters);
//   * every real tier1 manifest (with and without seed present) still
//     validates through the PRODUCTION controller's --validate-only path;
//   * an invalid ref name is REJECTED fail-closed.
//
// Confined to torture-test/ (writes only under gitignored var/). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const schemaPath = path.join(ttRoot, "cases", "case.schema.json");
const tier1Manifest = path.join(ttRoot, "cases", "tier1.jsonl");
const controller = path.join(ttRoot, "bin", "tt-controller");

const REF_NAME_PATTERN = "^[A-Za-z0-9]([A-Za-z0-9._/-]*[A-Za-z0-9])?$";

// Valid ref-name spellings the seed field must accept.
const VALID_SEEDS = ["BUG-P1", "seed/storm", "broken-tests", "v1.2.3", "feature/foo-bar", "main"];
// Bad-character ref names the schema must REJECT (fail-closed).
const INVALID_SEEDS = ["BUG:1", "BUG P1", "~BUG", "BUG^", "BUG?", "BUG*", "BUG[1]", "BUG\\1", "BUG/", "BUG."];

const env = {
  ...process.env,
  TAMANDUA_TEST_GUARD: "0",
  TAMANDUA_PI_BINARY: "/usr/bin/false",
  TAMANDUA_HERMES_BINARY: "/usr/bin/false",
};

function runValidate(manifestPath: string): { status: number; stdout: string; stderr: string } {
  return spawnSync(controller, ["--manifest", manifestPath, "--validate-only"], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Build a single-case manifest with 28 full case fields under a temp dir
// inside torture-test/var (the controller refuses manifests that escape
// torture-test/). The base case is a copy of the first tier1 record; field
// overrides are applied on top (absent otherwise).
function buildCaseManifest(overrides: Record<string, unknown> = {}): string {
  const dir = fs.mkdtempSync(path.join(ttRoot, "var", "seed-schema-"));
  const base = JSON.parse(fs.readFileSync(tier1Manifest, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "")[0]);
  Object.assign(base, overrides);
  const manifest = path.join(dir, "case.jsonl");
  fs.writeFileSync(manifest, `${JSON.stringify(base)}\n`);
  return manifest;
}

describe("Manifest seed schema validation (US-001)", () => {
  it("case.schema.json defines an optional, nullable 'seed' with a ref-name pattern", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    assert.ok(schema.properties?.seed, "schema must define a top-level seed property");
    const seed = schema.properties.seed;
    assert.ok(Array.isArray(seed.anyOf), "seed must be nullable via anyOf(null, string)");
    const strings = seed.anyOf.filter((arm: any) => arm.type === "string");
    assert.equal(strings.length, 1, "seed must have exactly one string alternative");
    assert.equal(strings[0].pattern, REF_NAME_PATTERN, "seed string alternative must carry the ref-name regex");
    const nulls = seed.anyOf.filter((arm: any) => arm.type === "null");
    assert.equal(nulls.length, 1, "seed must have a null alternative");
    // Optional: it must NOT be in the required array.
    assert.ok(!schema.required.includes("seed"), "seed must not be a required field");
  });

  it("accepts manifests with valid seed values (including null) and without seed", () => {
    // No seed field present at all (vanilla real manifest).
    const noSeed = runValidate(tier1Manifest);
    assert.equal(noSeed.status, 0, `vanilla tier1 manifest must validate:\n${noSeed.stdout}${noSeed.stderr}`);
    assert.match(noSeed.stdout, /Validated 28 case\(s\)/);

    for (const seed of [...VALID_SEEDS, null]) {
      const manifest = buildCaseManifest({ seed });
      try {
        const res = runValidate(manifest);
        assert.equal(res.status, 0, `seed ${JSON.stringify(seed)} must validate:\n${res.stdout}${res.stderr}`);
        assert.match(res.stdout, /Validated 1 case\(s\)/);
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
  });

  it("rejects manifests with an invalid seed ref name (bad characters)", () => {
    for (const seed of INVALID_SEEDS) {
      const manifest = buildCaseManifest({ seed });
      try {
        const res = runValidate(manifest);
        assert.notEqual(res.status, 0, `seed ${JSON.stringify(seed)} must be REJECTED`);
        assert.match(res.stdout + res.stderr, /seed/, "rejection must name the seed field");
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
  });

  it("rejects non-string, non-null seed types", () => {
    for (const bad of [42, ["BUG-P1"], { ref: "BUG-P1" }, true]) {
      const manifest = buildCaseManifest({ seed: bad });
      try {
        const res = runValidate(manifest);
        assert.notEqual(res.status, 0, `seed of type ${JSON.stringify(bad)} must be REJECTED`);
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
  });
});

// E3.A US-001 — authoring-layer schema conventions: context.test_cmd must be
// documented (string, minLength 1, per-fixture raw commands feeding
// launchGateKey O2/O9/O10 evidence) and the fixture pattern must admit the
// reserved hostile-path alias 'tt-ts café' (W1.X1: space + Latin-1 letters
// after the first character) while still rejecting control characters.
const TEST_CMD_FIXTURE_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._@\\-\\u00C0-\\u00FF ]*$";

// The base record the throwaway manifests are built from carries a plain
// context; rebuild it with a hostile alias and a test_cmd for the positive
// path.
function buildHostileAliasManifest(): string {
  return buildCaseManifest({ fixture: "tt-ts café", context: { execution_mode: "real", test_cmd: "npm test" } });
}

describe("Context test_cmd + hostile-path fixture alias schema (E3.A US-001)", () => {
  it("case.schema.json defines context.properties.test_cmd as a non-empty string documenting per-fixture commands", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const testCmd = schema.properties?.context?.properties?.test_cmd;
    assert.ok(testCmd, "schema must define context.properties.test_cmd");
    assert.equal(testCmd.type, "string", "test_cmd must be typed string");
    assert.equal(testCmd.minLength, 1, "test_cmd must require a non-empty value");
    // The description documents the RAW per-fixture commands that feed
    // launchGateKey (O2/O9/O10 evidence).
    assert.match(testCmd.description ?? "", /launchGateKey/, "description must name launchGateKey");
    assert.match(testCmd.description ?? "", /tt-python/);
    assert.match(testCmd.description ?? "", /\.venv\/bin\/pytest -q/, "tt-python command must be .venv/bin/pytest -q");
    assert.match(testCmd.description ?? "", /npm test/, "tt-ts command must be npm test");
    assert.match(testCmd.description ?? "", /\.\/run-all-tests/, "tt-poly-lite command must be ./run-all-tests");
  });

  it("fixture pattern admits the reserved hostile alias and rejects control characters", () => {
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const fixturePattern = schema.properties?.fixture?.pattern;
    assert.equal(fixturePattern, TEST_CMD_FIXTURE_PATTERN, "fixture pattern must admit a space + Latin-1 letters after the first character");
    const re = new RegExp(fixturePattern);
    assert.ok(re.test("tt-ts café"), "reserved hostile-path alias 'tt-ts café' must match");
    assert.ok(re.test("tt-ts"), "canonical names must still match");
    assert.ok(re.test("tt-python@master"), "canonical @-suffixed names must still match");
    assert.ok(re.test("tt-poly-lite"), "canonical hyphenated names must still match");
    assert.ok(!re.test("tt-ts\tx"), "tab must be rejected");
    assert.ok(!re.test("tt-ts\nx"), "newline must be rejected");
    assert.ok(!re.test(" café"), "leading space must be rejected (first character stays ASCII alphanumeric)");
  });

  it("production validator accepts a throwaway manifest with fixture 'tt-ts café' and context.test_cmd 'npm test'", () => {
    const manifest = buildHostileAliasManifest();
    try {
      const res = runValidate(manifest);
      assert.equal(res.status, 0, `hostile-alias manifest must validate:\n${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /Validated 1 case\(s\)/);
    } finally {
      fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
    }
  });

  it("production validator rejects fixture values containing control characters", () => {
    for (const fixture of ["tt-ts\tx", "tt-ts\nx"]) {
      const manifest = buildCaseManifest({ fixture });
      try {
        const res = runValidate(manifest);
        assert.notEqual(res.status, 0, `fixture ${JSON.stringify(fixture)} must be REJECTED`);
        assert.match(res.stdout + res.stderr, /fixture/, "rejection must name the fixture field");
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
  });

  it("production validator rejects empty, null, and non-string context.test_cmd values", () => {
    for (const bad of ["", null, 42, ["npm test"], { cmd: "npm test" }, true]) {
      const manifest = buildCaseManifest({ context: { execution_mode: "real", test_cmd: bad } });
      try {
        const res = runValidate(manifest);
        assert.notEqual(res.status, 0, `test_cmd ${JSON.stringify(bad)} must be REJECTED`);
      } finally {
        fs.rmSync(path.dirname(manifest), { recursive: true, force: true });
      }
    }
  });

  it("the full tier1 manifest validates through the production validator (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});

// E3.A US-002 — S1: declare context.test_cmd on every wave-1/2
// workflow-launching tier1 case so launchGateKey produces real evidence
// (O2/O9/O10 chain). Pins the exact canonical per-fixture command on each
// case in cases/tier1.jsonl and asserts the two W1.REPLAY-* lines stay
// byte-identical to their pre-E3.A state (E3.D S9/S10 owns those lines —
// any edit to them must be coordinated, and this test fails loudly).
const US002_EXPECTED_TEST_CMDS: Record<string, string> = {
  "W1.L1-python": ".venv/bin/pytest -q",
  "W1.L1-ts": "npm test",
  "W1.L2-python": ".venv/bin/pytest -q",
  "W1.L3-python": ".venv/bin/pytest -q",
  "W1.L3-ts": "npm test",
  "W1.X1-ts": "npm test",
  "W1.M1-python": ".venv/bin/pytest -q",
  "W2.22-non-main-bfmw": ".venv/bin/pytest -q",
  "W2.24-docs-drift": "npm test",
};

// Byte-exact pre-E3.A lines owned by E3.D (S9/S10) — coordinate only.
const REPLAY_PYTHON_LINE = `{"id":"W1.REPLAY-python","wave":1,"workflow":"tt-shim-probe","fixture":"tt-python","harness":"pi","task":"cases/tasks/tier1/W1.REPLAY-python.md","context":{"execution_mode":"real","test_cmd":"pytest -q"},"caps":{"tokens":100000,"wall_min":3},"requires":{"toolchains":["python3","node"],"node_min":22},"boundary_files":["fixtures-src/tt-python/src"],"forbidden":["fixtures-src/tt-python/operator-notes.local"],"oracles":["O1","O3z","O9","O11"],"gates":["TIER1","W1"],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","spec_ref":"05-wave-1-language-smoke.md#W1.REPLAY"}`;
const REPLAY_TS_LINE = `{"id":"W1.REPLAY-ts","wave":1,"workflow":"tt-shim-probe","fixture":"tt-ts","harness":"pi","task":"cases/tasks/tier1/W1.REPLAY-ts.md","context":{"execution_mode":"real","test_cmd":"npm test"},"caps":{"tokens":100000,"wall_min":3},"requires":{"toolchains":["node"],"node_min":22},"boundary_files":["fixtures-src/tt-ts/src"],"forbidden":["fixtures-src/tt-ts/operator-notes.local"],"oracles":["O1","O3z","O9","O11"],"gates":["TIER1","W1"],"chaos":null,"shed_ok":false,"mandatory":true,"class":"verification","spec_ref":"05-wave-1-language-smoke.md#W1.REPLAY"}`;

function readTier1Cases(): Array<{ raw: string; parsed: any }> {
  const lines = fs
    .readFileSync(tier1Manifest, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "");
  return lines.map((raw) => ({ raw, parsed: JSON.parse(raw) }));
}

describe("Wave-1/2 context.test_cmd declarations (E3.A US-002)", () => {
  it("every wave-1/2 workflow-launching case carries the canonical context.test_cmd", () => {
    const cases = readTier1Cases();
    assert.equal(cases.length, 28, "tier1 manifest must keep 28 lines");
    const byId = new Map(cases.map((c) => [c.parsed.id, c]));
    for (const [id, expected] of Object.entries(US002_EXPECTED_TEST_CMDS)) {
      const c = byId.get(id);
      assert.ok(c, `case ${id} must exist in tier1.jsonl`);
      assert.equal(
        c.parsed.context?.test_cmd,
        expected,
        `${id} must carry context.test_cmd ${JSON.stringify(expected)}`,
      );
    }
  });

  it("W1.REPLAY-python and W1.REPLAY-ts lines are byte-identical to their pre-E3.A state", () => {
    const cases = readTier1Cases();
    const byId = new Map(cases.map((c) => [c.parsed.id, c]));
    const replayPython = byId.get("W1.REPLAY-python");
    const replayTs = byId.get("W1.REPLAY-ts");
    assert.ok(replayPython && replayTs, "both W1.REPLAY-* cases must exist");
    assert.equal(replayPython.raw, REPLAY_PYTHON_LINE, "W1.REPLAY-python line must be unchanged (E3.D S9/S10 owns it)");
    assert.equal(replayTs.raw, REPLAY_TS_LINE, "W1.REPLAY-ts line must be unchanged (E3.D S9/S10 owns it)");
  });

  it("tier1 manifest with the new test_cmd declarations validates (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});

// E3.A US-003 — S1: declare context.test_cmd on every wave-3
// workflow-launching tier1 case so launchGateKey produces real evidence
// (O2/O9/O10 chain). Pins the exact canonical per-fixture command on each
// case in cases/tier1.jsonl: tt-python -> .venv/bin/pytest -q, tt-ts ->
// npm test, tt-poly-lite -> ./run-all-tests (per the fixture README's
// TEST_CMD section). W3.23's test_cmd is ours per S1 (E3.D S12 only wires
// the token-saver launch flags on that line).
const US003_EXPECTED_TEST_CMDS: Record<string, string> = {
  "W3.01-bfmw-pi-python": ".venv/bin/pytest -q",
  "W3.02-bfmw-pi-ts": "npm test",
  "W3.03-bfmw-hermes-ts": "npm test",
  "W3.04-fdmw-pi-ts": "npm test",
  "W3.17a-marathon-natural": "./run-all-tests",
  "W3.17b-marathon-chaos": "./run-all-tests",
  "W3.18-pause-no-drain": "npm test",
  "W3.19-pause-drain": "npm test",
  "W3.20-cancel": "npm test",
  "W3.21-fail-force-resume": "npm test",
  "W3.22-daemon-restart": "npm test",
  "W3.23-token-saver": "npm test",
};

const POLY_LITE_README = path.join(ttRoot, "fixtures-src", "tt-poly-lite", "README.md");

// Extract the literal command from the fixture README's TEST_CMD code block
// so a future README edit that changes the canonical suite command fails
// this test instead of silently desyncing the manifest.
function readPolyLiteTestCmd(): string {
  const text = fs.readFileSync(POLY_LITE_README, "utf8");
  const match = text.match(/## TEST_CMD\s*```[a-z]*\n([^\n]+)\n```/i);
  assert.ok(match, "tt-poly-lite README must contain a TEST_CMD section with a code block");
  return match[1].trim();
}

describe("Wave-3 context.test_cmd declarations (E3.A US-003)", () => {
  it("every wave-3 workflow-launching case carries the canonical context.test_cmd", () => {
    const cases = readTier1Cases();
    assert.equal(cases.length, 28, "tier1 manifest must keep 28 lines");
    const byId = new Map(cases.map((c) => [c.parsed.id, c]));
    for (const [id, expected] of Object.entries(US003_EXPECTED_TEST_CMDS)) {
      const c = byId.get(id);
      assert.ok(c, `case ${id} must exist in tier1.jsonl`);
      assert.equal(
        c.parsed.context?.test_cmd,
        expected,
        `${id} must carry context.test_cmd ${JSON.stringify(expected)}`,
      );
      assert.equal(c.parsed.context?.execution_mode, "real", `${id} must stay a real case`);
    }
  });

  it("the tt-poly-lite test_cmd ./run-all-tests matches the fixture README TEST_CMD section", () => {
    const readmeCmd = readPolyLiteTestCmd();
    assert.equal(readmeCmd, "./run-all-tests", "tt-poly-lite README TEST_CMD must be ./run-all-tests");
    const cases = readTier1Cases();
    const byId = new Map(cases.map((c) => [c.parsed.id, c]));
    for (const id of ["W3.17a-marathon-natural", "W3.17b-marathon-chaos"]) {
      const c = byId.get(id);
      assert.ok(c, `case ${id} must exist in tier1.jsonl`);
      assert.equal(c.parsed.fixture, "tt-poly-lite", `${id} must use the tt-poly-lite fixture`);
      assert.equal(c.parsed.context?.test_cmd, readmeCmd, `${id} test_cmd must match the README TEST_CMD`);
    }
  });

  it("tier1 manifest with the wave-3 test_cmd declarations validates (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});

// E3.A US-004 — S2: arm wave-1 bug-fix seeds. W1.L3-python must carry
// seed BUG-P1 and W1.L3-ts must carry seed BUG-T1 (top-level field, before
// harness) so provisioning lands the clone on the exact seeded tree instead
// of the green baseline. The seed names are cross-checked against what the
// golden builders actually create: tt-python tags each seed (refs/tags/seed/…),
// tt-ts branches each seed (refs/heads/seed/…) — the two must not be swapped.
const US004_EXPECTED_SEEDS: Record<string, { fixture: string; seed: string; builder: string; refKind: "tag" | "branch"; ref: string }> = {
  "W1.L3-python": {
    fixture: "tt-python",
    seed: "BUG-P1",
    builder: "fixtures-src/tt-python/build-golden.sh",
    refKind: "tag",
    ref: "refs/tags/seed/BUG-P1",
  },
  "W1.L3-ts": {
    fixture: "tt-ts",
    seed: "BUG-T1",
    builder: "fixtures-src/tt-ts/build-golden.sh",
    refKind: "branch",
    ref: "refs/heads/seed/BUG-T1",
  },
};

const GOLDEN_DIR = path.join(ttRoot, "var", "fixtures", "golden");

function gitShowRef(barePath: string, ref: string): SpawnSyncReturns<string> {
  // rev-parse (unlike show-ref) peels ^{commit} so an annotated or
  // lightweight tag/branch both resolve to the commit hash.
  return spawnSync("git", ["--git-dir", barePath, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
}

describe("Wave-1 bug-fix seeds armed (E3.A US-004)", () => {
  it("W1.L3-python carries seed BUG-P1 and W1.L3-ts carries seed BUG-T1 (top-level, before harness)", () => {
    const cases = readTier1Cases();
    assert.equal(cases.length, 28, "tier1 manifest must keep 28 lines");
    const byId = new Map(cases.map((c) => [c.parsed.id, c]));
    for (const [id, expected] of Object.entries(US004_EXPECTED_SEEDS)) {
      const c = byId.get(id);
      assert.ok(c, `case ${id} must exist in tier1.jsonl`);
      assert.equal(c.parsed.fixture, expected.fixture, `${id} fixture must stay ${expected.fixture}`);
      assert.equal(c.parsed.seed, expected.seed, `${id} must carry seed ${expected.seed}`);
      assert.equal(c.parsed.workflow, "bug-fix", `${id} must stay a bug-fix case`);
      // The seed field must sit before harness on the serialized line (the
      // story pins the top-level field placement).
      const seedIdx = c.raw.indexOf(`"seed":"${expected.seed}"`);
      const harnessIdx = c.raw.indexOf('"harness"');
      assert.ok(seedIdx > 0 && seedIdx < harnessIdx, `${id} seed must appear before harness`);
    }
  });

  it("seed names match the refs the golden builders create (tt-python tags, tt-ts branches)", () => {
    for (const [id, expected] of Object.entries(US004_EXPECTED_SEEDS)) {
      const builder = fs.readFileSync(path.join(ttRoot, expected.builder), "utf8");
      if (expected.refKind === "tag") {
        assert.match(builder, /git tag "seed\/\$seed_id"/, `${id}: tt-python builder must tag each seed`);
        assert.match(builder, new RegExp(`\\b${expected.seed}\\b`), `${id}: builder must name seed ${expected.seed}`);
      } else {
        assert.match(
          builder,
          /refs\/heads\/seed\/\$seed_id/,
          `${id}: tt-ts builder must push seeds as refs/heads/seed branches`,
        );
        assert.match(builder, new RegExp(`\\b${expected.seed}\\b`), `${id}: builder must name seed ${expected.seed}`);
      }
    }
  });

  it("golden bares (when present) resolve each armed seed at the exact ref", (t) => {
    for (const [id, expected] of Object.entries(US004_EXPECTED_SEEDS)) {
      const bare = path.join(GOLDEN_DIR, `${expected.fixture}.git`);
      if (!fs.existsSync(bare)) {
        t.skip(`golden bare ${bare} not provisioned in this environment`);
        return;
      }
      const res = gitShowRef(bare, expected.ref);
      assert.equal(res.status, 0, `${id}: ${expected.ref} must resolve in the golden bare`);
      assert.match(res.stdout.trim(), /^[0-9a-f]{40}$/, `${id}: ref must resolve to a commit hash`);
    }
  });

  it("tier1 manifest with the armed seeds validates (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});

// E3.A US-005 — S2: arm W3.01 with seed BUG-P2 and rewrite its task text to
// describe the real A2 two-module defect the seed implants, replacing the
// phantom red-herring symptoms (parse_time/schedule_overlap pointing at
// dates.py/conflicts.py) that never matched any seed. Pins: manifest seed +
// probe_id agreement; task text names only the real modules and the exact
// SEEDS.md BUG-P2 symptoms; phantom tokens are gone; the task's described fix
// matches what probes/tt-python/BUG-P2/probe.sh actually checks.
const W301_ID = "W3.01-bfmw-pi-python";
const W301_TASK = path.join(ttRoot, "cases", "tasks", "tier1", "W3.01-bfmw-pi-python.md");
const W301_PROBE = path.join(ttRoot, "probes", "tt-python", "BUG-P2", "probe.sh");

// Tokens from the old phantom red-herring task text — none may survive.
const PHANTOM_TOKENS = ["parse_time", "schedule_overlap", "dates.py", "conflicts.py"];

describe("W3.01 seed BUG-P2 + real-defect task text (E3.A US-005)", () => {
  it("W3.01 carries seed BUG-P2 (top-level, before harness) with matching probe_id", () => {
    const cases = readTier1Cases();
    assert.equal(cases.length, 28, "tier1 manifest must keep 28 lines");
    const c = cases.find((x) => x.parsed.id === W301_ID);
    assert.ok(c, `${W301_ID} must exist in tier1.jsonl`);
    assert.equal(c.parsed.fixture, "tt-python", "W3.01 fixture must stay tt-python");
    assert.equal(c.parsed.workflow, "bug-fix-merge-worktree", "W3.01 must stay a bug-fix-merge-worktree case");
    assert.equal(c.parsed.seed, "BUG-P2", "W3.01 must carry seed BUG-P2");
    assert.equal(c.parsed.probe_id, "BUG-P2", "W3.01 probe_id must match the seed");
    assert.equal(c.parsed.context?.test_cmd, ".venv/bin/pytest -q", "W3.01 test_cmd stays .venv/bin/pytest -q");
    const seedIdx = c.raw.indexOf('"seed":"BUG-P2"');
    const harnessIdx = c.raw.indexOf('"harness"');
    assert.ok(seedIdx > 0 && seedIdx < harnessIdx, "W3.01 seed must appear before harness");
  });

  it("BUG-P2 is in the tt-python golden-builder SEED_ORDER (tagged ref family)", () => {
    const builder = fs.readFileSync(path.join(ttRoot, "fixtures-src", "tt-python", "build-golden.sh"), "utf8");
    assert.match(builder, /git tag "seed\/\$seed_id"/, "tt-python builder must tag each seed");
    const seedOrder = builder.match(/SEED_ORDER=\(([\s\S]*?)\)/);
    assert.ok(seedOrder, "builder must define SEED_ORDER");
    assert.match(seedOrder[1], /\bBUG-P2\b/, "SEED_ORDER must contain BUG-P2");
  });

  it("golden bare (when present) resolves refs/tags/seed/BUG-P2", (t) => {
    const bare = path.join(GOLDEN_DIR, "tt-python.git");
    if (!fs.existsSync(bare)) {
      t.skip(`golden bare ${bare} not provisioned in this environment`);
      return;
    }
    const res = gitShowRef(bare, "refs/tags/seed/BUG-P2");
    assert.equal(res.status, 0, "refs/tags/seed/BUG-P2 must resolve in the golden bare");
    assert.match(res.stdout.trim(), /^[0-9a-f]{40}$/, "ref must resolve to a commit hash");
  });

  it("task text describes the real BUG-P2 two-module defect and none of the phantom tokens", () => {
    const task = fs.readFileSync(W301_TASK, "utf8");
    // The two real modules, exactly per SEEDS.md BUG-P2.
    assert.match(task, /src\/schedlib\/recurrence\.py/, "task must name src/schedlib/recurrence.py");
    assert.match(task, /src\/schedlib\/conflict\.py/, "task must name src/schedlib/conflict.py");
    // Symptom 1: yearly(interval=2) annual instead of biennial via _advance.
    assert.match(task, /yearly\(interval=2\)/, "task must name yearly(interval=2)");
    assert.match(task, /_advance\(\)/, "task must name _advance()");
    assert.match(task, /interval/, "task must mention the ignored interval");
    assert.match(task, /annual/);
    assert.match(task, /biennial/);
    // Symptom 2: conflict_severity equal bounds fall through to HARD.
    assert.match(task, /conflict_severity/, "task must name conflict_severity()");
    assert.match(task, /CONTAINED/, "task must name CONTAINED");
    assert.match(task, /HARD/, "task must name HARD");
    // Both modules required — a single-file fix leaves one red test.
    assert.match(task, /two-module bug/, "task must carry the A2 two-module label");
    assert.match(task, /single-file fix/, "task must state a single-file fix leaves a failure");
    // Suite command stated.
    assert.match(task, /\.venv\/bin\/pytest -q/, "task must state the suite command .venv/bin/pytest -q");
    // Phantom tokens gone + archetype relabeled away from red-herring.
    for (const token of PHANTOM_TOKENS) {
      assert.ok(!task.includes(token), `task must not mention phantom token ${JSON.stringify(token)}`);
    }
    assert.ok(!task.includes("red-herring"), "task must be relabeled away from the red-herring archetype");
  });

  it("the task's described fix matches what probes/tt-python/BUG-P2/probe.sh checks", () => {
    const probe = fs.readFileSync(W301_PROBE, "utf8");
    const task = fs.readFileSync(W301_TASK, "utf8");
    // The probe requires these exact regression tests to exist in the fixed
    // tree; the task must name them so the described fix surface matches.
    assert.match(task, /test_every_two_years/, "task must name the yearly regression test");
    assert.match(task, /test_contained_equal_bounds/, "task must name the equal-bounds regression test");
    // The probe's two symptom checks live in the same modules the task names.
    assert.match(probe, /recurrence/, "probe must cover the recurrence symptom");
    assert.match(probe, /conflict_severity/, "probe must cover the conflict_severity symptom");
    // Both agree the full suite must be green (both files fixed).
    assert.match(probe, /full test suite/, "probe must gate on the full suite");
    assert.match(task, /full suite pass/, "task must gate on the full suite");
  });

  it("tier1 manifest with the W3.01 seed armed validates (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});

// E3.A US-006 — S2: arm W3.02 with seed BUG-T2 and W3.03 with seed BUG-T3,
// and rewrite both task texts to describe the real defects those seeds
// implant (rewrite-to-existing-seed), replacing the phantom red-herring
// symptoms that never matched any seed (date.ts/calculator.ts for W3.02;
// io.ts/export.ts for W3.03). Pins: manifest seed + probe_id agreement on
// both cases; task texts name only the real modules and the exact SEEDS.md
// mechanisms; phantom tokens are gone; each task's described fix matches
// what the tt-ts probes actually grep for.
const W302_ID = "W3.02-bfmw-pi-ts";
const W302_TASK = path.join(ttRoot, "cases", "tasks", "tier1", "W3.02-bfmw-pi-ts.md");
const W302_PROBE = path.join(ttRoot, "probes", "tt-ts", "BUG-T2", "probe.sh");
const W303_ID = "W3.03-bfmw-hermes-ts";
const W303_TASK = path.join(ttRoot, "cases", "tasks", "tier1", "W3.03-bfmw-hermes-ts.md");
const W303_PROBE = path.join(ttRoot, "probes", "tt-ts", "BUG-T3", "probe.sh");

// Tokens from the old phantom red-herring task texts — none may survive.
const W302_PHANTOM_TOKENS = ["src/util/date.ts", "calculator.ts"];
const W303_PHANTOM_TOKENS = ["src/util/io.ts", "export.ts"];

describe("W3.02/W3.03 seeds BUG-T2/BUG-T3 + real-defect task texts (E3.A US-006)", () => {
  it("W3.02 carries seed BUG-T2 and W3.03 carries seed BUG-T3 (top-level, before harness) with matching probe_ids", () => {
    const cases = readTier1Cases();
    assert.equal(cases.length, 28, "tier1 manifest must keep 28 lines");
    const byId = new Map(cases.map((c) => [c.parsed.id, c]));
    for (const [id, seed] of [
      [W302_ID, "BUG-T2"],
      [W303_ID, "BUG-T3"],
    ] as const) {
      const c = byId.get(id);
      assert.ok(c, `case ${id} must exist in tier1.jsonl`);
      assert.equal(c.parsed.fixture, "tt-ts", `${id} fixture must stay tt-ts`);
      assert.equal(c.parsed.workflow, "bug-fix-merge-worktree", `${id} must stay a bug-fix-merge-worktree case`);
      assert.equal(c.parsed.seed, seed, `${id} must carry seed ${seed}`);
      assert.equal(c.parsed.probe_id, seed, `${id} probe_id must match the seed`);
      assert.equal(c.parsed.context?.test_cmd, "npm test", `${id} test_cmd stays npm test`);
      const seedIdx = c.raw.indexOf(`"seed":"${seed}"`);
      const harnessIdx = c.raw.indexOf('"harness"');
      assert.ok(seedIdx > 0 && seedIdx < harnessIdx, `${id} seed must appear before harness`);
    }
  });

  it("BUG-T2 and BUG-T3 are in the tt-ts golden-builder PATCHED_SEEDS (branch ref family)", () => {
    const builder = fs.readFileSync(path.join(ttRoot, "fixtures-src", "tt-ts", "build-golden.sh"), "utf8");
    assert.match(builder, /refs\/heads\/seed\/\$seed_id/, "tt-ts builder must push seeds as refs/heads/seed branches");
    const patched = builder.match(/PATCHED_SEEDS=\(([^)]*)\)/);
    assert.ok(patched, "builder must define PATCHED_SEEDS");
    for (const seed of ["BUG-T2", "BUG-T3"]) {
      assert.match(patched[1], new RegExp(`\\b${seed}\\b`), `PATCHED_SEEDS must contain ${seed}`);
    }
  });

  it("golden bare (when present) resolves refs/heads/seed/BUG-T2 and refs/heads/seed/BUG-T3", (t) => {
    const bare = path.join(GOLDEN_DIR, "tt-ts.git");
    if (!fs.existsSync(bare)) {
      t.skip(`golden bare ${bare} not provisioned in this environment`);
      return;
    }
    for (const seed of ["BUG-T2", "BUG-T3"]) {
      const res = gitShowRef(bare, `refs/heads/seed/${seed}`);
      assert.equal(res.status, 0, `refs/heads/seed/${seed} must resolve in the golden bare`);
      assert.match(res.stdout.trim(), /^[0-9a-f]{40}$/, "ref must resolve to a commit hash");
    }
  });

  it("W3.02 task text describes the real BUG-T2 two-module defect and none of the phantom tokens", () => {
    const task = fs.readFileSync(W302_TASK, "utf8");
    // The two real modules, exactly per SEEDS.md BUG-T2.
    assert.match(task, /src\/server\.ts/, "task must name src/server.ts");
    assert.match(task, /src\/store\.ts/, "task must name src/store.ts");
    // Mechanism: raw toISOString parse in server, localeCompare string compare in store.
    assert.match(task, /toISOString/, "task must name the raw toISOString() parse");
    assert.match(task, /localeCompare/, "task must name the localeCompare string comparison");
    // Described fix: UTC-midnight normalization to YYYY-MM-DD + timestamp comparison.
    assert.match(task, /T00:00:00Z/, "task must describe UTC-midnight date normalization");
    assert.match(task, /split\(/, "task must describe splitting the ISO string to YYYY-MM-DD");
    assert.match(task, /getTime/, "task must describe timestamp comparison");
    // Both modules required — a single-file fix leaves the symptom.
    assert.match(task, /two-module bug/, "task must carry the A2 two-module label");
    assert.match(task, /single-file fix/, "task must state a single-file fix leaves a failure");
    // Suite command stated.
    assert.match(task, /npm test/, "task must state the suite command npm test");
    // Phantom tokens gone + archetype relabeled away from red-herring.
    for (const token of W302_PHANTOM_TOKENS) {
      assert.ok(!task.includes(token), `task must not mention phantom token ${JSON.stringify(token)}`);
    }
    assert.ok(!task.includes("red-herring"), "task must be relabeled away from the red-herring archetype");
  });

  it("the W3.02 task's described fix matches what probes/tt-ts/BUG-T2/probe.sh greps for", () => {
    const probe = fs.readFileSync(W302_PROBE, "utf8");
    const task = fs.readFileSync(W302_TASK, "utf8");
    // Probe requires YYYY-MM-DD normalization in server.ts (T00:00:00Z/split)
    // and forbids a raw toISOString() date assignment.
    assert.match(probe, /T00:00:00Z/, "probe must grep for date normalization");
    assert.match(probe, /parsed\\.toISOString/, "probe must forbid the raw toISOString() assignment");
    // Probe requires timestamp comparison in store.ts and forbids localeCompare.
    assert.match(probe, /getTime/, "probe must grep for timestamp comparison");
    assert.match(probe, /localeCompare/, "probe must forbid localeCompare");
    // Task names the same files the probe checks.
    assert.match(probe, /src\/server\.ts/, "probe must check src/server.ts");
    assert.match(probe, /src\/store\.ts/, "probe must check src/store.ts");
    assert.match(task, /src\/server\.ts/);
    assert.match(task, /src\/store\.ts/);
  });

  it("W3.03 task text describes the real BUG-T3 red-herring defect and none of the phantom tokens", () => {
    const task = fs.readFileSync(W303_TASK, "utf8");
    // The real modules: visible symptom in app.js, root cause in store.ts update().
    assert.match(task, /public\/app\.js/, "task must name public/app.js");
    assert.match(task, /src\/store\.ts/, "task must name src/store.ts");
    // Mechanism: splice out + push to end corrupts order.
    assert.match(task, /splice/, "task must name the splice");
    assert.match(task, /push/, "task must name the push");
    assert.match(task, /update\(\)/, "task must name update()");
    assert.match(task, /getAll\(\)/, "task must name getAll()");
    // Red-herring framing: symptom suggests frontend, root cause in store.
    assert.match(task, /red-herring/, "task must keep the red-herring archetype label");
    // Described fix: in-place assignment + BUG-T3-tagged order-preservation test.
    assert.match(task, /expenses\[index\] = updated/, "task must describe the in-place assignment");
    assert.match(task, /BUG-T3/, "task must instruct the BUG-T3-tagged regression test");
    // Suite command stated.
    assert.match(task, /npm test/, "task must state the suite command npm test");
    // Phantom tokens gone.
    for (const token of W303_PHANTOM_TOKENS) {
      assert.ok(!task.includes(token), `task must not mention phantom token ${JSON.stringify(token)}`);
    }
  });

  it("the W3.03 task's described fix matches what probes/tt-ts/BUG-T3/probe.sh greps for", () => {
    const probe = fs.readFileSync(W303_PROBE, "utf8");
    const task = fs.readFileSync(W303_TASK, "utf8");
    // Probe forbids the splice+push pattern and requires in-place assignment.
    assert.match(probe, /splice.*push/, "probe must forbid the splice+push pattern");
    assert.match(probe, /expenses\[index\] =/, "probe must require in-place assignment");
    // Probe gates on the BUG-T3-tagged regression test — task must instruct it.
    assert.match(probe, /BUG-T3/, "probe must gate on the BUG-T3-tagged regression test");
    assert.match(task, /BUG-T3/, "task must instruct the BUG-T3-tagged regression test");
    // Probe checks store.ts; task names it.
    assert.match(probe, /src\/store\.ts/, "probe must check src/store.ts");
    assert.match(task, /src\/store\.ts/);
  });

  it("tier1 manifest with the W3.02/W3.03 seeds armed validates (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});

// E3.A US-007 — S2: rewrite the W2.22 task so it no longer promises a seeded
// days_between defect (no such seed exists) while preserving the
// non-main-branch (master-trap) premise byte-for-byte. W2.22 must stay
// UNSEEDED in the manifest: any seed checkout replaces the clone's current
// branch, but the whole premise is that the bfmw base branch is exactly
// master (O2 asserts the landing ref is EXACTLY master). Pins: no seed field
// on the W2.22 manifest line (test_cmd from US-002 only); task text names
// the new next_month_start helper with its example conversions; the phantom
// days_between BUG SYMPTOM is gone; the master-trap Setup / Expected Outcome
// / Boundaries sections survive byte-for-byte.
const W222_ID = "W2.22-non-main-bfmw";
const W222_TASK = path.join(ttRoot, "cases", "tasks", "tier1", "W2.22-non-main-bfmw.md");

// The master-trap sections, verbatim from the pre-E3.A task file. These must
// survive the rewrite byte-for-byte (backticks escaped for the template
// literals; em-dashes kept as U+2014).
const W222_SETUP_SECTION = `## Setup

This repository uses \`master\` as its default branch. There is NO \`main\` branch. The agent must:
- Create the feature branch from \`master\` (not \`main\`)
- Target \`master\` for the merge/PR (not \`main\`)
- Run \`git diff master...<branch>\` for scope verification (not \`main\`)`;

const W222_OUTCOME_SECTION = `## Expected Outcome

Either:
1. Run terminal with clean landing on \`master\` (O2 asserts landing ref is EXACTLY \`master\`)
2. PRODUCT_FAIL: the agent attempts to target \`main\` which doesn't exist, or merges to \`master\` but with scope audit failures from referencing \`main\` in diff commands`;

const W222_BOUNDARIES_SECTION = `## Boundaries

- Stay within \`fixtures-src/tt-python@master/src/\`
- Do not modify \`operator-notes.local\`, \`seeds/\`, or \`probes/\` files
- Do not create a \`main\` branch — the repo intentionally has only \`master\``;

describe("W2.22 master-trap task rewrite without a phantom seed (E3.A US-007)", () => {
  it("W2.22 manifest line stays unseeded (test_cmd only, no seed field)", () => {
    const cases = readTier1Cases();
    assert.equal(cases.length, 28, "tier1 manifest must keep 28 lines");
    const c = cases.find((x) => x.parsed.id === W222_ID);
    assert.ok(c, `${W222_ID} must exist in tier1.jsonl`);
    assert.equal(c.parsed.fixture, "tt-python@master", "W2.22 fixture must stay tt-python@master");
    assert.equal(c.parsed.workflow, "bug-fix-merge-worktree", "W2.22 must stay a bug-fix-merge-worktree case");
    assert.equal(c.parsed.context?.test_cmd, ".venv/bin/pytest -q", "W2.22 test_cmd stays .venv/bin/pytest -q (US-002)");
    assert.ok(!("seed" in c.parsed), "W2.22 must carry NO seed field");
    assert.ok(!c.raw.includes('"seed"'), "W2.22 serialized line must not mention seed");
  });

  it("task text no longer claims a seeded defect and mentions days_between nowhere", () => {
    const task = fs.readFileSync(W222_TASK, "utf8");
    assert.ok(!task.includes("days_between"), "task must not mention days_between");
    assert.ok(!task.includes("seeded bug"), "task must not claim a seeded bug");
    assert.ok(!task.includes("BUG SYMPTOM"), "the BUG SYMPTOM section must be gone");
    // The unseeded rationale must be stated: base branch exactly master, and
    // no seed checkout (a seed checkout would replace the clone's current
    // branch, breaking the premise).
    assert.match(task, /UNSEEDED/, "task must state the case is deliberately unseeded");
    assert.match(task, /seed checkout/, "task must explain why no seed checkout is allowed");
    assert.match(task, /EXACTLY `master`/, "task must state O2 asserts the landing ref is EXACTLY master");
  });

  it("task text describes the next_month_start change with its example conversions", () => {
    const task = fs.readFileSync(W222_TASK, "utf8");
    assert.match(task, /next_month_start/, "task must name next_month_start");
    assert.match(task, /src\/schedlib\/dates\.py/, "task must name src/schedlib/dates.py");
    assert.match(task, /tests\/test_dates\.py/, "task must name tests/test_dates.py");
    assert.match(task, /2026-07-15/, "task must carry the mid-month example");
    assert.match(task, /2026-08-01/, "task must carry the mid-month expected result");
    assert.match(task, /2026-12-31/, "task must carry the year-rollover example");
    assert.match(task, /2027-01-01/, "task must carry the year-rollover expected result");
    assert.match(task, /2024-02-29/, "task must carry the leap-day example");
    assert.match(task, /2024-03-01/, "task must carry the leap-day expected result");
    assert.match(task, /\.venv\/bin\/pytest -q/, "task must state the suite command .venv/bin/pytest -q");
    assert.match(task, /full suite passes/, "task must gate on the full suite passing");
  });

  it("master-trap Setup / Expected Outcome / Boundaries sections survive byte-for-byte", () => {
    const task = fs.readFileSync(W222_TASK, "utf8");
    assert.ok(task.includes(W222_SETUP_SECTION), "## Setup section must be preserved byte-for-byte");
    assert.ok(task.includes(W222_OUTCOME_SECTION), "## Expected Outcome section must be preserved byte-for-byte");
    assert.ok(task.includes(W222_BOUNDARIES_SECTION), "## Boundaries section must be preserved byte-for-byte");
    // The scope-check command and the no-main-branch rule survive verbatim.
    assert.match(task, /git diff master\.\.\.<branch>/, "scope check must use git diff master...<branch>");
    assert.match(task, /Do not create a `main` branch/, "the no-main-branch rule must survive");
  });

  it("the described change stays within boundary (src) plus test directories", () => {
    const task = fs.readFileSync(W222_TASK, "utf8");
    // The authored change description lives between ### CHANGE and ## Setup.
    // Every backticked path token in it must be under src/, tests/, or the
    // venv suite command, so O8 scope checks (boundary src + test-dir
    // exemption) cannot flag it.
    const split = task.split("### CHANGE")[1];
    assert.ok(split, "task must keep a ### CHANGE section");
    const changeSection = split.split("## Setup")[0];
    const pathTokens = [...changeSection.matchAll(/`([^`]+)`/g)].map((m) => m[1]).filter((t) => t.includes("/"));
    assert.ok(pathTokens.length > 0, "change section must carry path tokens");
    for (const token of pathTokens) {
      assert.ok(
        token.startsWith("src/") || token.startsWith("tests/") || token.startsWith(".venv/"),
        `change-section token ${JSON.stringify(token)} must be under src/, tests/, or the venv suite command`,
      );
    }
  });

  it("tier1 manifest with the unseeded W2.22 validates (28 cases)", () => {
    const res = runValidate(tier1Manifest);
    assert.equal(res.status, 0, `tier1 manifest must validate:\n${res.stdout}${res.stderr}`);
    assert.match(res.stdout, /Validated 28 case\(s\)/);
  });
});
