#!/usr/bin/env node
// W4.41 resolver torture — shared runner for the two scripted-hermes arms
// (login-shell-tier / all-tiers-fail) + the zero-filesystem-mutation check.
//
// The corridor is the PRODUCT's hermes binary resolver
// (src/installer/hermes-resolver.ts, compiled to dist/installer/hermes-resolver.js)
// — three tiers: env override -> PATH search -> login-shell fallback
// (`zsh -lic 'command -v hermes'`). The contained scripted daemon ALWAYS sets
// TAMANDUA_HERMES_BINARY (tier 1 wins), so the login-shell / all-tiers-fail
// corridor cannot be exercised through the daemon's launch path — the cell
// exercises the resolver + the launch-path admission wrapper
// (validateRunHarnessForScheduling) DIRECTLY with a crafted env (machinery
// delta, documented in tier2-traceability.md):
//
//   Arm 1 (login-shell-tier): hermes present ONLY via the login-shell tier —
//     TAMANDUA_HERMES_BINARY unset, PATH stripped of hermes, a MOCK zsh on
//     PATH that answers `command -v hermes` with an off-PATH fake hermes (a
//     copy of the scripted-hermes wrapper). The resolver must return
//     { source: "login-shell", path: <fake hermes> } (tier named + logged),
//     and the launch-path admission wrapper must ACCEPT the run.
//   Arm 2 (all-tiers-fail): every tier fails (fake hermes renamed/absent,
//     mock zsh reports nothing). The resolver must throw HermesResolverError
//     and the launch-path wrapper must produce the DIAGNOSABLE refusal
//     ("Run <id> requests hermes harness but hermes is not available: ...") —
//     never silent worker_lost loops.
//   Both arms: zero-filesystem-mutation — the resolver runs with HOME pointed
//     at a SCRATCH home; after resolution the scratch home tree must be EMPTY
//     (discovery must not write anything; a resolver that caches a wrong path
//     to disk poisons every later run).
//
// Zero tokens. Compact single-line JSON on stdout.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function requiredValue(name) {
  const value = process.env[name];
  assert.ok(typeof value === "string" && value.length > 0, `${name} must be set`);
  return value;
}
function requiredPath(name) {
  const value = requiredValue(name);
  assert.ok(path.isAbsolute(value), `${name} must be an absolute path`);
  return value;
}

const [scenarioArg] = process.argv.slice(2);
if (!scenarioArg) throw new Error("usage: run-resolver-torture.mjs <scenario-directory>");
const scenarioDir = fs.realpathSync(scenarioArg);
const metadata = JSON.parse(fs.readFileSync(path.join(scenarioDir, "scenario.json"), "utf8"));

const repoRoot = requiredPath("TT_REPO_ROOT");
const invocationDir = requiredPath("TT_SCENARIO_STATE_DIR");
const scenarioId = requiredValue("TT_SCENARIO_ID");
assert.equal(process.env.TT_SCENARIO_COMMAND_GROUP_PROVEN, "1",
  "scenario must run in the harness-proven process group");
assert.equal(scenarioId, metadata.id, "scenario id mismatch");

const ARM = scenarioId.replace(/^w4\.41-/, ""); // login-shell-tier | all-tiers-fail
assert.ok(["login-shell-tier", "all-tiers-fail"].includes(ARM), `unknown W4.41 arm: ${ARM}`);

// The resolver + launch-path admission wrapper compiled from the product
// source. dist is built by the campaign's W0.1 build-unit gate; fail closed
// with a clear message when it is missing.
const resolverModule = await import(
  pathToFileURL(path.join(repoRoot, "dist", "installer", "hermes-resolver.js")).href
);
const runHarnessModule = await import(
  pathToFileURL(path.join(repoRoot, "dist", "installer", "run-harness.js")).href
);
const { resolveHermesBinaryDetailed, HermesResolverError } = resolverModule;
const { validateRunHarnessForScheduling, RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY } = runHarnessModule;

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? invocationDir,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

// ── scratch environment ──────────────────────────────────────────────
// scratchBin: the crafted PATH (mock zsh + node/git/coreutils, NO hermes).
// scratchHome: HOME for the resolver calls — the zero-filesystem-mutation
//              assertion surface (must stay EMPTY after resolution).
// fakeHermes: the off-PATH hermes binary only the mock zsh can report.
const scratchBin = path.join(invocationDir, "bin");
const scratchHome = path.join(invocationDir, "home");
const fakeHermes = path.join(invocationDir, "fake-hermes", "hermes");
fs.mkdirSync(scratchBin, { recursive: true });
fs.mkdirSync(scratchHome, { recursive: true });
fs.mkdirSync(path.dirname(fakeHermes), { recursive: true });

const scriptedHermesWrapper = path.join(
  repoRoot, "torture-test", "scripted-runtimes", "bin", "scripted-hermes",
);
assert.ok(fs.existsSync(scriptedHermesWrapper), "scripted-hermes wrapper must exist");

if (ARM === "login-shell-tier") {
  // The fake hermes IS a copy of the scripted-hermes wrapper (off-PATH) —
  // only the login-shell tier can reach it.
  fs.copyFileSync(scriptedHermesWrapper, fakeHermes);
  fs.chmodSync(fakeHermes, 0o755);
} else {
  // all-tiers-fail: the fake hermes does not exist at all (renamed away).
  assert.ok(!fs.existsSync(fakeHermes), "all-tiers-fail arm must have NO hermes binary");
}

// Mock zsh: answers `zsh -lic 'command -v hermes'` for the login-shell tier.
const mockZsh = path.join(scratchBin, "zsh");
fs.writeFileSync(mockZsh, `#!/usr/bin/env bash
# mock zsh — login-shell tier stand-in (the real zsh -lic reads ~/.zshrc; the
# mock keeps the corridor hermetic: no real shell init is ever evaluated).
if [[ "$*" == *"command -v hermes"* ]]; then
  if [ -x "$TT_MOCK_HERMES" ]; then
    printf '%s\\n' "$TT_MOCK_HERMES"
  fi
  exit 0
fi
exit 0
`, "utf8");
fs.chmodSync(mockZsh, 0o755);

// PATH: scratchBin (mock zsh) + node/git/coreutils — hermes deliberately absent.
const nodeDir = path.dirname(process.execPath);
const craftedPathDirs = [scratchBin, nodeDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const hermesOnCraftedPath = craftedPathDirs.some((dir) => fs.existsSync(path.join(dir, "hermes")));
assert.equal(hermesOnCraftedPath, false,
  `the crafted PATH must have no hermes binary (self-verified; found one in ${craftedPathDirs.find((d) => fs.existsSync(path.join(d, "hermes")))})`);
const resolverEnv = {
  ...process.env,
  PATH: craftedPathDirs.join(path.delimiter),
  HOME: scratchHome,
  TAMANDUA_HERMES_BINARY: "", // tier 1 (env override) must NOT engage
  TT_MOCK_HERMES: ARM === "login-shell-tier" ? fakeHermes : "/nonexistent/hermes",
};
delete resolverEnv.TAMANDUA_HERMES_BINARY;

// The launch-path admission context (direct mode at a scratch workdir).
const workdir = path.join(invocationDir, "workdir");
fs.mkdirSync(workdir, { recursive: true });
const context = JSON.stringify({
  workspace_mode: "direct",
  [RUN_CONTEXT_WORKING_DIRECTORY_FOR_HARNESS_KEY]: workdir,
  harness_type: "hermes",
});

// ── zero-filesystem-mutation snapshot ────────────────────────────────
function treeSnapshot(root) {
  const entries = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else entries.push({ p, size: st.size, mtimeMs: st.mtimeMs });
    }
  };
  if (fs.existsSync(root)) walk(root);
  return entries.sort((a, b) => a.p.localeCompare(b.p));
}

const beforeSnapshot = treeSnapshot(scratchHome);

// ── the corridor ─────────────────────────────────────────────────────
// The resolver reads process.env — swap the crafted env in for the duration
// of the resolution (the corridor runs with HOME at the SCRATCH home so the
// zero-filesystem-mutation check is deterministic; concurrent daemon writes
// to the real contained home can never pollute it).
const savedEnv = { ...process.env };
Object.assign(process.env, resolverEnv);
delete process.env.TAMANDUA_HERMES_BINARY; // tier 1 (env override) must NOT engage — the corridor needs tiers 2/3
let resolved = null;
let admissionError = null;
try {
  if (ARM === "login-shell-tier") {
    resolved = await resolveHermesBinaryDetailed({}); // runs under resolverEnv
    assert.equal(resolved.source, "login-shell",
      `tier 3 (login-shell) must win when tiers 1-2 fail: got source=${resolved.source}`);
    assert.equal(resolved.path, fakeHermes, "resolved path must be the login-shell-reported hermes");
    // The launch-path admission wrapper must ACCEPT the run with the resolved harness.
    const admission = await validateRunHarnessForScheduling("run-w4-41-login-shell", context);
    assert.equal(admission.workingDirectoryForHarness, workdir, "admission must accept the resolved run");
  } else {
    let threw = null;
    try {
      await resolveHermesBinaryDetailed({});
    } catch (err) {
      threw = err;
    }
    assert.ok(threw instanceof HermesResolverError, "all-tiers-fail must throw HermesResolverError");
    assert.equal(threw.code, "not_found", "all-tiers-fail must carry code not_found");
    assert.match(threw.message, /hermes binary not found in PATH/,
      "the refusal must name the missing hermes binary");
    try {
      await validateRunHarnessForScheduling("run-w4-41-all-tiers-fail", context);
      admissionError = null;
    } catch (err) {
      admissionError = err instanceof Error ? err.message : String(err);
    }
    assert.ok(admissionError, "launch-path admission must refuse the hermes run");
    assert.match(admissionError, /requests hermes harness but hermes is not available/,
      "the launch-path refusal must be the diagnosable 'hermes is not available' refusal (never silent worker_lost loops)");
    assert.match(admissionError, /hermes binary not found in PATH/,
      "the refusal must name the missing binary");
  }
} finally {
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
}

// ── zero-filesystem-mutation assertion ───────────────────────────────
const afterSnapshot = treeSnapshot(scratchHome);
assert.equal(afterSnapshot.length, 0,
  `resolution must be filesystem-read-only — the scratch HOME must stay empty (got ${afterSnapshot.length} entries)`);
assert.deepEqual(afterSnapshot, beforeSnapshot, "resolution must not create/delete/alter any file");

process.stdout.write(`${JSON.stringify({
  scenario_id: metadata.id,
  arm: ARM,
  resolved_source: resolved?.source ?? null,
  resolved_path: resolved?.path ?? null,
  refusal_code: ARM === "all-tiers-fail" ? "not_found" : null,
  admission_refusal: admissionError ?? null,
  filesystem_mutation: afterSnapshot.length,
  result: "PASS",
})}\n`);
