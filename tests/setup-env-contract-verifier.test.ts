/**
 * Control tests for the TRACKED successor of the frozen setup-env-contract
 * verifier (tamandua-48v): scripts/verify-setup-env-contract.mjs.
 *
 * The frozen predecessor (archived ops artifact
 * accept-wave1/setup-141/ops/verify-setup-env-contract.mjs, sha256
 * f0a5ca9912eb97fc9fc079a6c7b83f08dc049f460a0924da44557a786fad0e0f) pinned
 * the setup module's static imports to exactly ["node:path"]. The 48v
 * consolidation intentionally changed that shape (the module now imports the
 * canonical sibling constant), so the successor re-pins the import list and
 * keeps the predecessor's eight behavioral checks byte-identical (the names
 * asserted below ARE the predecessor's check names).
 *
 * These controls exercise the successor against ISOLATED, COMMITTED fixture
 * copies of the real sources — never the working tree — so the fixed/defect
 * mode semantics and every refusal path are proven:
 *   - fixed mode ACCEPTS a consolidated candidate (exit 0, all checks PASS);
 *   - fixed mode REJECTS the restored legacy env-name defect;
 *   - defect mode ACCEPTS ONLY the two canonical behavioral failures;
 *   - defect mode does NOT accept the fixed candidate;
 *   - wrong commit identity, dirty source, and an unauthorized static import
 *     are each refused.
 *
 * Spawns node subprocesses, so this file lives in the SERIAL lane
 * (tests/serial-files.txt).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tamanduaTempDir } from "../dist/lib/temp-dir.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const VERIFIER = path.join(REPO_ROOT, "scripts", "verify-setup-env-contract.mjs");
const SETUP_REL = "src/installer/matchlock-setup.ts";
const SIBLING_REL = "src/installer/matchlock/standard-image.ts";

/** The predecessor's eight check names, byte-identical (behavioral surface). */
const CANONICAL_CHECK_NAMES = [
  "literal RPC override",
  "literal pull timeout",
  "typo-only RPC diagnostic control",
  "typo-only timeout diagnostic control",
  "unset PATH and timeout defaults unchanged",
  "invalid and empty literal timeout values retain default",
  "empty RPC and no PATH match retain bare fallback",
  "literal image override remains unchanged",
];

const CANONICAL_FAILURES = ["literal RPC override", "literal pull timeout"];

interface VerifierRun {
  status: number | null;
  stdout: string;
  stderr: string;
  json: Record<string, unknown> | null;
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout ?? "").trim();
}

function runVerifier(repo: string, commit: string, mode: "fixed" | "defect"): VerifierRun {
  const result = spawnSync("node", [VERIFIER, repo, commit, mode], {
    encoding: "utf-8",
    timeout: 60_000,
  });
  if (result.error) {
    return { status: null, stdout: result.stdout ?? "", stderr: `${result.stderr ?? ""}\n${String(result.error)}`, json: null };
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse((result.stdout ?? "").trim()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", json };
}

/**
 * Build an isolated committed fixture: the REAL setup + sibling sources
 * (read from the repository), optionally mutated, committed in a fresh repo.
 */
function buildFixture(
  prefix: string,
  mutate?: (files: { setupPath: string; siblingPath: string }) => void,
): { repo: string; commit: string } {
  const repo = tamanduaTempDir(prefix);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "test@tamandua.local"]);
  git(repo, ["config", "user.name", "Tamandua Test"]);
  const setupPath = path.join(repo, SETUP_REL);
  const siblingPath = path.join(repo, SIBLING_REL);
  fs.mkdirSync(path.dirname(setupPath), { recursive: true });
  fs.mkdirSync(path.dirname(siblingPath), { recursive: true });
  fs.copyFileSync(path.join(REPO_ROOT, SETUP_REL), setupPath);
  fs.copyFileSync(path.join(REPO_ROOT, SIBLING_REL), siblingPath);
  if (mutate) mutate({ setupPath, siblingPath });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "fixture"]);
  return { repo, commit: git(repo, ["rev-parse", "HEAD"]) };
}

/** Restore the historical defect class: the typos env-name spelling. */
function introduceLegacyEnvDefect(files: { setupPath: string }): void {
  let source = fs.readFileSync(files.setupPath, "utf-8");
  const before = source;
  source = source.replace(
    '"TAMANDUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS"',
    '"TANDAMUA_MATCHLOCK_SETUP_PULL_TIMEOUT_MS"',
  );
  source = source.replace('"TAMANDUA_MATCHLOCK_RPC_BIN"', '"TANDAMUA_MATCHLOCK_RPC_BIN"');
  assert.notEqual(source, before, "the defect fixture must change both env names");
  fs.writeFileSync(files.setupPath, source, "utf-8");
}

/** Add an unauthorized static dependency to the setup module. */
function introduceUnauthorizedImport(files: { setupPath: string }): void {
  const source = fs.readFileSync(files.setupPath, "utf-8");
  const marker = 'import { STANDARD_MATCHLOCK_IMAGE } from "./matchlock/standard-image.js";';
  assert.ok(source.includes(marker), "fixture mutation anchor must exist");
  fs.writeFileSync(files.setupPath, source.replace(marker, `import os from "node:os";\n${marker}`), "utf-8");
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

describe("setup-env-contract verifier successor (tamandua-48v controls)", { concurrency: 1 }, () => {
  let consolidated: { repo: string; commit: string };
  let legacyDefect: { repo: string; commit: string };

  before(() => {
    consolidated = buildFixture("tamandua-verifier-fixed-");
    legacyDefect = buildFixture("tamandua-verifier-defect-", introduceLegacyEnvDefect);
  });

  after(() => {
    fs.rmSync(consolidated.repo, { recursive: true, force: true });
    fs.rmSync(legacyDefect.repo, { recursive: true, force: true });
  });

  it("fixed mode accepts the consolidated candidate with all eight predecessor checks passing", () => {
    const run = runVerifier(consolidated.repo, consolidated.commit, "fixed");
    assert.equal(run.status, 0, `fixed mode must accept the consolidated candidate: ${run.stderr}`);
    assert.ok(run.json, `verifier must emit its evidence JSON: ${run.stdout}`);
    const json = run.json!;
    assert.equal(json.expectedOutcomeMatched, true);
    assert.equal(json.failed, 0);
    assert.equal(json.passed, 8, "all eight checks must run (no vacuous acceptance)");
    const results = json.results as Array<{ name: string; status: string }>;
    assert.deepEqual(
      results.map((r) => r.name),
      CANONICAL_CHECK_NAMES,
      "check names must be byte-identical to the predecessor's behavioral surface",
    );
    assert.ok(results.every((r) => r.status === "PASS"));
    // Commit-bound identity: the reported source hash is the fixture's real bytes.
    assert.equal(json.sourceSha256, sha256File(path.join(consolidated.repo, SETUP_REL)));
    assert.equal(json.siblingSourceSha256, sha256File(path.join(consolidated.repo, SIBLING_REL)));
  });

  it("defect mode accepts ONLY the two canonical behavioral failures on the legacy defect", () => {
    const defectRun = runVerifier(legacyDefect.repo, legacyDefect.commit, "defect");
    assert.equal(defectRun.status, 0, `defect mode must accept exactly the canonical failures: ${defectRun.stderr}`);
    assert.ok(defectRun.json);
    const failures = (defectRun.json!.results as Array<{ name: string; status: string }>)
      .filter((r) => r.status === "FAIL")
      .map((r) => r.name);
    assert.deepEqual(failures, CANONICAL_FAILURES);
    assert.equal(defectRun.json!.failed, 2);
  });

  it("fixed mode rejects the legacy defect and defect mode rejects the fixed candidate", () => {
    const fixedOnDefect = runVerifier(legacyDefect.repo, legacyDefect.commit, "fixed");
    assert.notEqual(fixedOnDefect.status, 0, "fixed mode must NOT accept the defect");
    assert.ok(fixedOnDefect.json, "the verifier still emits its evidence JSON on a rejected candidate");
    assert.equal(fixedOnDefect.json!.expectedOutcomeMatched, false);

    const defectOnFixed = runVerifier(consolidated.repo, consolidated.commit, "defect");
    assert.notEqual(defectOnFixed.status, 0, "defect mode must NOT accept the fixed candidate");
    assert.equal(defectOnFixed.json!.expectedOutcomeMatched, false);
  });

  it("refuses a wrong candidate identity", () => {
    const wrong = "0".repeat(40);
    const run = runVerifier(consolidated.repo, wrong, "fixed");
    assert.notEqual(run.status, 0);
    assert.match(`${run.stdout}\n${run.stderr}`, /candidate identity mismatch/i);
  });

  it("refuses a dirty candidate tree", () => {
    // Scratch mutation of a TRACKED file, reverted immediately afterwards.
    const setupPath = path.join(consolidated.repo, SETUP_REL);
    const original = fs.readFileSync(setupPath);
    try {
      fs.appendFileSync(setupPath, "\n// dirty\n");
      const run = runVerifier(consolidated.repo, consolidated.commit, "fixed");
      assert.notEqual(run.status, 0);
      assert.match(`${run.stdout}\n${run.stderr}`, /candidate must be clean/i);
    } finally {
      fs.writeFileSync(setupPath, original);
    }
  });

  it("refuses an unauthorized static import in the setup module", () => {
    const fixture = buildFixture("tamandua-verifier-import-", introduceUnauthorizedImport);
    try {
      const run = runVerifier(fixture.repo, fixture.commit, "fixed");
      assert.notEqual(run.status, 0);
      assert.match(
        `${run.stdout}\n${run.stderr}`,
        /static imports must be exactly|unauthorized dependency edge/i,
      );
    } finally {
      fs.rmSync(fixture.repo, { recursive: true, force: true });
    }
  });

  it("refuses a sibling that acquires a dependency (sibling purity is part of the trusted closure)", () => {
    const fixture = buildFixture("tamandua-verifier-sibling-", (files) => {
      const source = fs.readFileSync(files.siblingPath, "utf-8");
      fs.writeFileSync(files.siblingPath, `import fs from "node:fs";\n${source}`, "utf-8");
    });
    try {
      const run = runVerifier(fixture.repo, fixture.commit, "fixed");
      assert.notEqual(run.status, 0);
      assert.match(
        `${run.stdout}\n${run.stderr}`,
        /sibling standard-image module must have no imports\/re-exports/i,
      );
    } finally {
      fs.rmSync(fixture.repo, { recursive: true, force: true });
    }
  });
});
