// S57 (US-013, R4a) — golden validity includes a fixtures-src content hash in
// the .hashes ledger; fixtures-src drift invalidates the golden.
//
// Defect: the golden .hashes ledgers (e.g. <fixture>.git.hashes under the
// golden root, written by each fixtures-src/<fixture>/build-golden.sh and
// maintained/verified by bin/tt-golden-bootstrap.mjs + bin/tt-verify-fixture-
// baselines) recorded only git ref hashes. A developer editing a fixture's
// SEEDED SOURCE (fixtures-src/<fixture>/src, seeds/, tests/...) changed what a
// rebuild would produce, but the already-built golden bare kept verifying
// PASS — drift between the golden tree and its source passed silently.
//
// Fix (confined to torture-test/):
//   1. Every fixture builder records a `FIXTURES_SRC <sha256>` /
//      `FIXTURES_SRC=<sha256>` line in its hash ledger — the canonical content
//      hash of the fixture SOURCE tree the golden is built from. The hash is
//      computed by the shared tt-golden-bootstrap.mjs (`--hash-fixtures-src-dir
//      <dir>`, hashFixtureSourceDir) so builders and verifiers never disagree.
//      Excluded from the hash are exactly the files builders never commit
//      (build-golden.sh, operator-notes.local, generated junk dirs) — editing
//      the builder or a provisioning reference cannot drift a golden.
//   2. tt-golden-bootstrap verifyGoldenBare/ensureGoldenBare treat the
//      fixtures-src record as part of VALIDITY: a real fixture (FIXTURE_META)
//      whose ledger lacks the record (golden-fixtures-src-record-missing) or
//      whose recorded hash no longer matches the current source
//      (golden-fixtures-src-drift) is INVALID — fail-closed, naming the
//      drifted fixture. --rebuild-invalid drops the stale ledger and rebuilds
//      from the CURRENT (drifted) source, producing a golden that verifies
//      again; a VALID golden is never rebuilt (no-op, unchanged).
//   3. tt-verify-fixture-baselines special-cases the FIXTURES_SRC key (a
//      64-hex content hash is never a git ref) and FAILs a drifted real
//      fixture, naming it in the evidence (`fixtures_src_check`).
//
// Hermetic (linux-runnable, zero tokens): the test builds tt-python into a
// scratch golden dir from a SCRATCH copy of the fixture source (the whole tool
// under test — bootstrap + verifier + builder + source — is mirrored into a
// scratch tree whose layout mirrors torture-test/, so every path resolves
// against the tree under test). Then it edits the scratch source (a golden-
// content file) and proves: the verifier FAILs naming the fixture, the
// bootstrap fails closed with golden-fixtures-src-drift, and --rebuild-invalid
// regenerates to valid against the drifted source. Nothing is written under
// torture-test/ except the scratch tree under the system temp dir.
//
// RED case (recorded in the progress log): point TT_S57_TOOL_TREE at a temp
// tree holding the PRE-FIX files (git show HEAD blobs of
// bin/tt-golden-bootstrap.mjs, bin/tt-verify-fixture-baselines and
// fixtures-src/tt-python/build-golden.sh plus a copy of the fixture source).
// TT_S57_TOOL_TREE names the torture-test dir of the tree under test, i.e. it
// must mirror <repo>/torture-test/{bin,fixtures-src} (bin/ + fixtures-src/):
//
//   TMPD=$(mktemp -d)
//   mkdir -p "$TMPD/bin" "$TMPD/fixtures-src/tt-python"
//   git show HEAD:torture-test/bin/tt-golden-bootstrap.mjs > "$TMPD/bin/tt-golden-bootstrap.mjs"
//   git show HEAD:torture-test/bin/tt-verify-fixture-baselines > "$TMPD/bin/tt-verify-fixture-baselines"
//   chmod +x "$TMPD/bin/tt-verify-fixture-baselines"
//   cp -r torture-test/fixtures-src/tt-python/. "$TMPD/fixtures-src/tt-python/"
//   git show HEAD:torture-test/fixtures-src/tt-python/build-golden.sh \
//     > "$TMPD/fixtures-src/tt-python/build-golden.sh"
//   TT_S57_TOOL_TREE="$TMPD" node --test \
//     torture-test/self-tests/tier1-s57-fixtures-src-drift.test.ts
//
// Pre-fix every drift-sensitive arm is RED: the built ledger records no
// FIXTURES_SRC (A1 fails), the verifier reports PASS on a drifted golden (A3),
// the bootstrap no-flag verify returns ok on a drifted golden (A4), and
// --rebuild-invalid no-ops instead of regenerating (A5). Green post-fix.
//
// Picked up by self-tests/run.sh's `tier1-*.test.ts` glob (bounded battery —
// no run.sh edit).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, before, after } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
// TT_S57_TOOL_TREE: alternate tool tree (bootstrap + verifier + fixture source
// + builder) the assertions drive — used to demonstrate the RED case against
// the pre-fix tools (see header). Defaults to the working tree.
const toolTree = process.env.TT_S57_TOOL_TREE ?? ttRoot;

const FIXTURE = "tt-python";
const FIXTURES_SRC_KEY = "FIXTURES_SRC"; // ledger record key (see tt-golden-bootstrap.mjs)
const GOLDEN_CONTENT_REL = path.join("src", "schedlib", "calendar_helpers.py");
// The eight FIXTURE_META fixtures (KNOWN_FIXTURES in tt-golden-bootstrap.mjs).
const ALL_FIXTURES = [
  "tt-go",
  "tt-java",
  "tt-poly",
  "tt-poly-lite",
  "tt-python",
  "tt-python@master",
  "tt-rust",
  "tt-ts",
];

/** Env for everything this test spawns: strip NODE_TEST_CONTEXT (node:test
 *  auto-activates the isolation guard in every child) and disable the guard
 *  explicitly — the bootstrap/builders operate inside scratch dirs only. */
function cleanEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TAMANDUA_TEST_GUARD;
  if (extra) Object.assign(env, extra);
  return env;
}

interface CmdResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  cmd: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): CmdResult {
  const res = spawnSync(cmd[0], cmd.slice(1), {
    cwd: opts.cwd ?? repoRoot,
    env: opts.env ?? cleanEnv(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function parseVerdict(stdout: string): any {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

function runBootstrap(args: string[], opts: { env?: NodeJS.ProcessEnv } = {}): CmdResult {
  // The tool under test is the SCRATCH copy (its TT_ROOT resolves to the
  // scratch tree, so fixture source + builder resolve against the scratch
  // fixture source that this test drifts). toolBinDir is set in before().
  return run([process.execPath, path.join(toolBinDir, "tt-golden-bootstrap.mjs"), ...args], {
    env: opts.env,
  });
}

function runVerifier(args: string[], env: NodeJS.ProcessEnv): CmdResult {
  return run([path.join(toolBinDir, "tt-verify-fixture-baselines"), ...args], { env });
}

/** Canonical fixtures-src content hash of a source dir, via the SAME helper
 *  the fixture builders invoke (`--hash-fixtures-src-dir`) — never a second
 *  implementation in the test. */
function sourceHash(sourceDir: string): string {
  const res = run([process.execPath, path.join(toolBinDir, "tt-golden-bootstrap.mjs"), "--hash-fixtures-src-dir", sourceDir]);
  assert.equal(res.status, 0, `--hash-fixtures-src-dir must exit 0:\n${res.stdout}\n${res.stderr}`);
  const hex = res.stdout.trim();
  assert.match(hex, /^[0-9a-f]{64}$/, "the canonical source hash must be 64 hex chars");
  return hex;
}

// ── Shared hermetic scratch tree (built once per run) ──────────────────
// The scratch root mirrors an OWNED REPO ROOT so every path the tool under
// test derives resolves INSIDE the freshly created scratch (never the scratch
// parent or any shared location): the bootstrap binary lives at
// <scratch>/torture-test/bin (its TT_ROOT = <scratch>/torture-test), the
// fixture SOURCE the golden is built from lives at
// <scratch>/torture-test/fixtures-src/tt-python (the tt-python builder's
// SCRIPT_DIR/../../.. = <scratch>), and the builders mktemp their
// work/scratch clones under <scratch>/torture-test/var. This mirrors the real
// <owned repo>/torture-test/{bin,fixtures-src,var} depth exactly; the golden
// is built into <scratch>/torture-test/var/fixtures/golden (the bootstrap
// default location) once in before().
let scratch: string; // scratch REPO-ROOT mirror (owned, fresh, per-run)
let toolBinDir: string; // <scratch>/torture-test/bin (the tools under test)
let fixtureSrc: string; // <scratch>/torture-test/fixtures-src/tt-python (the drifted source)
let goldenDir: string; // <scratch>/torture-test/var/fixtures/golden (built once in before())
let ledgerPath: string;

before(function (this: { timeout: number }) {
  // 10 minutes: the before() build runs the REAL tt-python builder (venv
  // bootstrap + pytest verification inside a scratch clone). node:test binds
  // the TestContext as `this`, so the explicit this-param types this.timeout.
  this.timeout = 600_000;
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tt-s57-scratch-"));
  toolBinDir = path.join(scratch, "torture-test", "bin");
  const varDir = path.join(scratch, "torture-test", "var");
  fs.mkdirSync(toolBinDir, { recursive: true });
  fs.mkdirSync(varDir, { recursive: true });
  goldenDir = path.join(varDir, "fixtures", "golden");

  // Tool copies from the tree under test (default: the working tree; RED:
  // pre-fix blobs staged by the operator — see header). Copying into
  // <scratch>/torture-test/bin makes the copied bootstrap resolve its own
  // TT_ROOT inside the scratch (torture-test/bin/..), exactly like the real
  // repo layout.
  fs.copyFileSync(
    path.join(toolTree, "bin", "tt-golden-bootstrap.mjs"),
    path.join(toolBinDir, "tt-golden-bootstrap.mjs"),
  );
  const verifierBlob = fs.readFileSync(path.join(toolTree, "bin", "tt-verify-fixture-baselines"));
  fs.writeFileSync(path.join(toolBinDir, "tt-verify-fixture-baselines"), verifierBlob, { mode: 0o755 });

  // Fixture SOURCE copy (whole dir) from the tree under test, placed at the
  // real depth (<scratch>/torture-test/fixtures-src/tt-python) so the copied
  // builder's REPO_ROOT (SCRIPT_DIR/../../..) resolves to <scratch> and its
  // VAR_DIR to <scratch>/torture-test/var — every builder path stays inside
  // the freshly owned root.
  fixtureSrc = path.join(scratch, "torture-test", "fixtures-src", "tt-python");
  fs.cpSync(path.join(toolTree, "fixtures-src", "tt-python"), fixtureSrc, { recursive: true });

  // Build the golden ONCE from the scratch source with the bootstrap copy.
  const res = runBootstrap(["--fixture", FIXTURE, "--golden-dir", goldenDir]);
  assert.equal(res.status, 0, `scratch golden build must exit 0:\n${res.stdout}\n${res.stderr}`);
  const verdict = parseVerdict(res.stdout);
  assert.ok(verdict?.ok, `scratch golden build verdict must be ok:\n${res.stdout}`);
  assert.equal(verdict.built, true, "the absent scratch golden must be built");
  ledgerPath = path.join(goldenDir, "tt-python.git.hashes");
  assert.ok(fs.existsSync(ledgerPath), "the hash ledger must be produced");
});

after(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe("S57: fixtures-src content hash in the golden .hashes ledger", () => {
  it("A1: a freshly built golden records FIXTURES_SRC matching the current source and verifies clean", () => {
    const ledger = fs.readFileSync(ledgerPath, "utf8");
    const m = ledger.match(new RegExp(`^${FIXTURES_SRC_KEY}[= ]([0-9a-f]{64})$`, "m"));
    assert.ok(m, `ledger must carry a ${FIXTURES_SRC_KEY} record:\n${ledger}`);
    const recorded = m[1];
    const current = sourceHash(fixtureSrc);
    assert.equal(current, recorded, "recorded FIXTURES_SRC must equal the current source content hash");

    const verify = runBootstrap(["--fixture", FIXTURE, "--golden-dir", goldenDir]);
    assert.equal(verify.status, 0, `no-flag verify of a fresh golden must exit 0:\n${verify.stdout}`);
    const v = parseVerdict(verify.stdout);
    assert.equal(v.ok, true);
    assert.equal(v.built, false, "a valid present golden must not be rebuilt");
    assert.equal(v.fixturesSrcHash, recorded, "verify must surface the matched fixtures-src hash");
  });

  it("A2: editing a golden-content source file changes the canonical fixtures-src hash (drift vector)", () => {
    const beforeHash = sourceHash(fixtureSrc);
    const target = path.join(fixtureSrc, GOLDEN_CONTENT_REL);
    fs.appendFileSync(target, "\n# S57 hermetic drift probe (never lands in the real tree)\n");
    const afterHash = sourceHash(fixtureSrc);
    assert.notEqual(afterHash, beforeHash, "editing a golden-content file must change the source hash");
    // The ledger still records the PRE-drift hash (built from the old source).
    const ledger = fs.readFileSync(ledgerPath, "utf8");
    assert.ok(ledger.includes(beforeHash), "ledger must still hold the pre-drift hash");
  });

  it("A3: tt-verify-fixture-baselines FAILs a drifted golden naming the fixture (fail closed)", () => {
    const res = runVerifier([], cleanEnv({ TEST_GOLDEN_ROOT: goldenDir }));
    assert.notEqual(res.status, 0, `drifted golden must fail the verifier:\n${res.stdout}\n${res.stderr}`);
    const ev = parseVerdict(res.stdout);
    assert.equal(ev?.result, "FAIL");
    const fixture = (ev?.fixtures ?? []).find((f: any) => f.name === "tt-python.git");
    assert.ok(fixture, "tt-python.git must appear in the verified set");
    assert.equal(fixture.result, "FAIL", "the drifted tt-python fixture must be FAIL");
    assert.ok(fixture.fixtures_src_check, "fixture evidence must carry fixtures_src_check");
    assert.equal(fixture.fixtures_src_check.matched, false);
    assert.match(fixture.fixtures_src_check.error, /fixtures-src drift for fixture tt-python/, "the failure must NAME the drifted fixture");
  });

  it("A4: bootstrap no-flag verify fails closed on a drifted golden, naming the fixture (golden-fixtures-src-drift)", () => {
    const res = runBootstrap(["--fixture", FIXTURE, "--golden-dir", goldenDir]);
    assert.notEqual(res.status, 0, `drifted golden must fail closed without --rebuild-invalid:\n${res.stdout}`);
    const verdict = parseVerdict(res.stdout);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason?.category, "golden-fixtures-src-drift");
    assert.equal(verdict.reason?.fixture, "tt-python", "the drift reason must name the fixture");
    assert.ok(
      verdict.reason?.recorded && verdict.reason?.current && verdict.reason.recorded !== verdict.reason.current,
      "the reason must carry the recorded vs current source hashes",
    );
  });

  it("A5: --rebuild-invalid regenerates the drifted golden from the CURRENT source to valid again", function (this: { timeout: number }) {
    this.timeout = 600_000;
    const res = runBootstrap(["--fixture", FIXTURE, "--golden-dir", goldenDir, "--rebuild-invalid"]);
    assert.equal(res.status, 0, `--rebuild-invalid must exit 0:\n${res.stdout}\n${res.stderr}`);
    const verdict = parseVerdict(res.stdout);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.built, true, "the drifted golden must be rebuilt");
    assert.equal(verdict.rebuiltInvalid, true, "the verdict must mark the rebuild as rebuiltInvalid");
    assert.equal(verdict.invalidReason, "golden-fixtures-src-drift");
    assert.match(verdict.note, /tt-python/, "the loud note must name the fixture");

    // The regenerated golden verifies clean again (no flag) against the
    // drifted source, and the ledger records the CURRENT source hash.
    const recheck = runBootstrap(["--fixture", FIXTURE, "--golden-dir", goldenDir]);
    assert.equal(recheck.status, 0, `rebuilt golden must verify cleanly:\n${recheck.stdout}`);
    const rv = parseVerdict(recheck.stdout);
    assert.equal(rv.ok, true);
    assert.equal(rv.built, false);
    const ledger = fs.readFileSync(ledgerPath, "utf8");
    const m = ledger.match(new RegExp(`^${FIXTURES_SRC_KEY}[= ]([0-9a-f]{64})$`, "m"));
    assert.ok(m, "regenerated ledger must carry FIXTURES_SRC");
    assert.equal(m[1], sourceHash(fixtureSrc), "regenerated ledger must match the CURRENT (drifted) source");
  });

  it("A6: structural — the tools carry the S57 gate and every FIXTURE_META source resolves", () => {
    const bootstrapText = fs.readFileSync(path.join(toolTree, "bin", "tt-golden-bootstrap.mjs"), "utf8");
    assert.ok(bootstrapText.includes("hashFixtureSourceDir"), "bootstrap must implement the canonical source hash");
    assert.ok(bootstrapText.includes("golden-fixtures-src-drift"), "bootstrap must name the drift defect");
    assert.ok(bootstrapText.includes("golden-fixtures-src-record-missing"), "bootstrap must fail closed on a missing record");
    assert.ok(bootstrapText.includes("--hash-fixtures-src-dir"), "builders must be able to request the canonical hash");

    const verifierText = fs.readFileSync(path.join(toolTree, "bin", "tt-verify-fixture-baselines"), "utf8");
    assert.ok(verifierText.includes("FIXTURES_SRC"), "verifier must special-case the FIXTURES_SRC record");
    assert.ok(verifierText.includes("fixtures-src drift"), "verifier must name drift in its evidence");

    // FIXTURE_META source dirs: every fixture maps to a real source tree
    // under fixtures-src (tt-python@master reuses the shared tt-python tree —
    // its FIXTURE_META entry must declare srcDir 'tt-python', never a phantom
    // source dir).
    for (const fixture of ALL_FIXTURES) {
      const srcDir = path.join(toolTree, "fixtures-src", fixture);
      assert.ok(fs.existsSync(srcDir), `${fixture}: fixtures-src/${fixture} must exist`);
    }
    assert.ok(
      /'tt-python@master':[\s\S]{0,500}?srcDir:\s*'tt-python'/.test(bootstrapText),
      "tt-python@master FIXTURE_META must hash the shared tt-python source",
    );
  });
});
