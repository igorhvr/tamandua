// Tier-2 STORM-REHEARSAL US-003 — boundary / negative / contract matrix inside
// an INDEPENDENTLY effect-recording AND effect-denying child environment.
//
// The 2026-09-09 19:40:14Z incident (a fabricated /tmp/ap.json approval whose
// buggy validator ENTERED REAL EXECUTION) is the reason this file exists. A
// negative test that only checks the CLI's own exit code is not a safety
// proof: the denial must be recorded by an INDEPENDENT observer that would
// catch a real effect even if the validator under test were buggy. Every child
// process this file drives (the ACTUAL tt-storm CLI entrypoints AND the ACTUAL
// exported gate functions) therefore runs under an effect-recording and
// effect-denying preload (NODE_OPTIONS --import):
//
//   * every non-git process spawn (tamandua / tamandua-test / daemon-control /
//     tt-chaos / scripted runtimes / any node child) is journaled as an
//     `effect` row AND denied — a buggy validator physically cannot start a
//     real daemon/harness/chaos process from inside the child;
//   * every filesystem mutation whose canonical destination escapes the owned
//     var root is journaled as an `effect` row AND denied;
//   * every real OS signal (process.kill with a non-zero signal) is journaled
//     as an `effect` row AND denied (signal-0 existence probes stay allowed).
//
// Each negative therefore asserts THREE independent things: the CLI/function
// refused (non-zero exit / refusal), the campaign state it was allowed to see
// is byte-identical before and after (no write reached it), and the recorder
// journal contains ZERO `effect` rows (no spawn/write/signal reached any real
// target). A validator bug that let a launch through would be caught by the
// third assertion regardless of exit code.
//
// Coverage (one focused torture self-test FILE):
//   N01  harness: the recorder itself denies+journals a launcher spawn, an
//        outside-owned write and a real signal (positive control of the env)
//   N02..N11  approve negatives (no-hash / partial / superset / hash-mismatch
//        approvals; missing/wrong campaign + source ids; unreadable approval;
//        absent campaign dir; foreign campaign dir; replaced-root receipt;
//        escape-symlink campaign under a NEW name)
//   N12..N16  rehearse negatives (no-hash approval through rehearse; missing
//        --approval-file usage; no-approval refusal) and run negatives
//        (unqualified; stale persisted boolean; missing on-disk approval;
//        run-time source re-validation; malformed qualification with planted
//        real-harness/credential env)
//   N17  resume with an unknown run id — classified unknown_run, never
//        relaunched (zero launch effects)
//   N18  function-level exported-gate negatives in-child (verifyCoordinator
//        Approval matrix; missing gate source file -> computeGateHashes
//        refuses; proc.kill of a non-owned/stale pid refused; cleanup with
//        absent/{} evidence refused; env-leak allowlist; ownership replaced/
//        absent through an injected fs mirror)
//   N19  positive controls: canonical-alias campaign path resolves as owned;
//        fresh contained SQLite run-id canonicalization at the real adapter
//        boundary
//
// Retained evidence: every attempt (input argv, approval bytes, stdout,
// stderr, recorder journal, state before/after hashes, the negative symlink
// fixture) is written under
// torture-test/var/rehearsal-boundary-evidence/<run>/ and NEVER deleted — the
// test performs no rm/rmdir/unlink of fixtures, no recursive deletion, and
// every attempt (including failed/negative ones) stays on disk. A negative
// symlink fixture is created under a NEW name; original captured files are
// never modified.
//
// Everything runs under TAMANDUA_TEST_GUARD=1 with fresh owned roots inside
// the gitignored torture-test/var (or a TT_BOUNDARY_EVIDENCE_ROOT scratch for
// local dev runs); no daemon/harness/chaos/model is ever started.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";

import { REAL_FS } from "../bin/tt-storm-roster.mjs";
import { parseRunKey } from "../bin/tt-storm-shared.mjs";
import {
  computeGateHashes,
  DEFAULT_COORDINATOR_APPROVAL_FILE,
  REHEARSAL_PROFILE,
} from "../bin/tt-storm-rehearsal.mjs";
import {
  buildPrivateExecContext,
  persistableExecIdentity,
} from "../bin/tt-storm-real.mjs";

const repoRoot = process.cwd();
const TT_STORM_CLI = path.join(repoRoot, "torture-test", "bin", "tt-storm");
const TAMANDUA_BIN = path.join(repoRoot, "bin", "tamandua");
const DEFAULT_EVIDENCE_ROOT = path.join(repoRoot, "torture-test", "var", "rehearsal-boundary-evidence");

function sha(text: string): string {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}
function shaFile(file: string): string {
  return sha(fs.readFileSync(file, "utf8"));
}
function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

// Planted "credential / real-harness leak" env — every CLI negative child is
// given a credential-free allowlisted base PLUS these fake secrets + real
// harness/authority/worktree-root variables. A real-mode code path that
// inherited them (or that could launch a harness from them) would be a leak;
// every negative asserts zero effects anyway, and N18 proves the private exec
// context never carries them into child_env.
function plantedLeakEnv(): Record<string, string> {
  return {
    FAKE_AWS_ACCESS_KEY_ID: "AKIAFAKE0000000000",
    FAKE_AWS_SECRET_ACCESS_KEY: "fake-secret-000000000000000000000000",
    OPENAI_API_KEY: "sk-fake-openai-key-000000000000",
    ANTHROPIC_API_KEY: "sk-ant-fake-anthropic-key-000000",
    TAMANDUA_RUN_ID: "run-11111111-2222-4333-8444-555555555555",
    TAMANDUA_WORKER_PID: "424242",
    TAMANDUA_WORKER_JOB_ID: "job-fake",
    TAMANDUA_STEP_ID: "step-fake",
    TAMANDUA_WORKTREE_ROOT: "/synthetic-foreign/worktree",
    TAMANDUA_PI_BINARY: "/usr/bin/false",
    TAMANDUA_HERMES_BINARY: "/usr/bin/false",
    TAMANDUA_DSH_BINARY: "/usr/bin/false",
    TT_HOME: "/synthetic-foreign/tt-home",
  };
}

// ─────────────────────────────────────────────────────────────────────
// Effect-recording / effect-denying preload (loaded via NODE_OPTIONS into
// every child under test). Pure JS; no template-literal syntax inside.
// ─────────────────────────────────────────────────────────────────────
const RECORDER_SOURCE = String.raw`// tt-boundary-recorder.mjs — effect-denying recorder preload (US-003).
// Loaded via NODE_OPTIONS --import into every child under test. It patches
// node:child_process (spawn/spawnSync/exec/execFile/execSync/execFileSync/
// fork), node:fs mutators and process.kill so that ANY attempt by the code
// under test to start a real launcher/harness/daemon, mutate a path outside
// the owned roots, or signal a process is journaled as an 'effect' row AND
// denied. git subprocesses (read-only provenance + owned local fixture work)
// stay allowed and are journaled as 'benign-git' (never an effect). A buggy
// validator can therefore never reach a real daemon/harness from inside this
// environment.
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
const cp = require('node:child_process');
const fsMod = require('node:fs');
const JOURNAL = process.env.TT_EFFECT_JOURNAL || null;
// Journaling uses a pre-opened fd + fs.writeSync (never appendFileSync/
// writeFileSync): node's appendFileSync is implemented on top of the EXPORTED
// writeFileSync, so patching those exports would make the journal write loop
// through the denier (infinite recursion). writeSync is a low-level binding
// that never consults module.exports.
let journalFd = -1;
if (JOURNAL) { try { journalFd = fsMod.openSync(JOURNAL, 'a'); } catch (e) { journalFd = -1; } }
function log(row) { if (journalFd >= 0) { try { fsMod.writeSync(journalFd, JSON.stringify(row) + '\n'); } catch (e) {} } }
const OWNED = (process.env.TT_OWNED_ROOTS || '').split(path.delimiter).filter(Boolean).map(function (p) { return path.resolve(p); });
function realp(p) { try { return fsMod.realpathSync(p); } catch (e) { return path.resolve(p); } }
function insideOwned(p) {
  const r = realp(p);
  return OWNED.some(function (o) { const rr = realp(o); return r === rr || r.indexOf(rr + path.sep) === 0; });
}
function isGit(argv0) { return path.basename(String(argv0 || '')) === 'git'; }
// US-001 (S2) makes a fresh campaign DB ONLY through the PRODUCT schema path:
// a single node --input-type=module -e "exact getDb import" child whose
// TAMANDUA_DB_PATH is contained. That one invocation is a schema-provisioning
// step, not a launcher/harness/daemon effect, so it is allowed but journaled
// as 'benign-product-db' (never class 'effect'). The predicate is deliberately
// exact: same node binary, exactly the three argv tokens, the byte-exact
// product program for TT_REPO_ROOT/dist/db.js, guard set, and a contained DB
// path. A buggy validator cannot smuggle a real launch through it.
function isProductSchemaSpawn(file, args, opts) {
  if (String(file) !== process.execPath) return false;
  if (!Array.isArray(args) || args.length !== 3) return false;
  if (args[0] !== '--input-type=module' || args[1] !== '-e') return false;
  const repo = process.env.TT_REPO_ROOT || '';
  if (!repo) return false;
  const expected = 'import { getDb } from ' + JSON.stringify(path.join(repo, 'dist', 'db.js')) + '; getDb();';
  if (String(args[2]) !== expected) return false;
  const env = (opts && opts.env) || {};
  if (env.TAMANDUA_TEST_GUARD !== '1') return false;
  if (!env.TAMANDUA_DB_PATH || !insideOwned(env.TAMANDUA_DB_PATH)) return false;
  return true;
}
function effect(kind, detail) { log({ ts: new Date().toISOString(), pid: process.pid, kind: kind, detail: String(detail).slice(0, 400), denied: true, class: 'effect' }); }
function benign(kind, detail) { log({ ts: new Date().toISOString(), pid: process.pid, kind: kind, detail: String(detail).slice(0, 400), denied: false, class: 'benign-git' }); }
function benignProductDb(detail) { log({ ts: new Date().toISOString(), pid: process.pid, kind: 'product-db', detail: String(detail).slice(0, 400), denied: false, class: 'benign-product-db' }); }
function denialError(file) { const e = new Error('TT_EFFECT_DENIED: ' + file); e.code = 'TT_EFFECT_DENIED'; return e; }
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function (file, args, opts) {
  if (isGit(file)) { benign('spawnSync-git', file + ' ' + JSON.stringify(Array.isArray(args) ? args : [])); return origSpawnSync.apply(this, arguments); }
  if (isProductSchemaSpawn(file, args, opts)) { benignProductDb('spawnSync product-schema getDb()'); return origSpawnSync.apply(this, arguments); }
  effect('spawnSync', file + ' ' + JSON.stringify(Array.isArray(args) ? args : []));
  const e = denialError(file);
  return { status: 42, signal: null, output: [null, Buffer.alloc(0), Buffer.from('TT_EFFECT_DENIED: ' + file + '\n')], stdout: Buffer.alloc(0), stderr: Buffer.from('TT_EFFECT_DENIED: ' + file + '\n'), pid: null, error: e };
};
const origSpawn = cp.spawn;
cp.spawn = function (file, args, opts) {
  if (isGit(file)) { benign('spawn-git', String(file)); return origSpawn.apply(this, arguments); }
  if (isProductSchemaSpawn(file, args, opts)) { benignProductDb('spawn product-schema getDb()'); return origSpawn.apply(this, arguments); }
  effect('spawn', String(file));
  throw denialError(file);
};
for (const name of ['execFile', 'execFileSync']) {
  const orig = cp[name];
  if (typeof orig !== 'function') continue;
  cp[name] = function (file) {
    if (isGit(file)) { benign(name + '-git', String(file)); return orig.apply(this, arguments); }
    effect(name, String(file));
    const e = denialError(file);
    if (name.endsWith('Sync')) throw e;
    const cb = typeof arguments[arguments.length - 1] === 'function' ? arguments[arguments.length - 1] : null;
    if (cb) { process.nextTick(function () { cb(e); }); return; }
    throw e;
  };
}
for (const name of ['exec', 'execSync']) {
  const orig = cp[name];
  if (typeof orig !== 'function') continue;
  cp[name] = function (cmd) {
    if (/^git([ \t]|$)/.test(String(cmd || '').trim())) { benign(name + '-git', String(cmd)); return orig.apply(this, arguments); }
    effect(name, String(cmd));
    const e = denialError(String(cmd));
    if (name.endsWith('Sync')) throw e;
    const cb = typeof arguments[arguments.length - 1] === 'function' ? arguments[arguments.length - 1] : null;
    if (cb) { process.nextTick(function () { cb(e); }); return; }
    throw e;
  };
}
const origFork = cp.fork;
if (typeof origFork === 'function') {
  cp.fork = function (mod) {
    effect('fork', String(mod));
    const e = denialError(String(mod));
    const cb = typeof arguments[arguments.length - 1] === 'function' ? arguments[arguments.length - 1] : null;
    if (cb) { process.nextTick(function () { cb(e); }); return; }
    throw e;
  };
}
const MUTATORS = { writeFileSync: [0], appendFileSync: [0], renameSync: [0, 1], unlinkSync: [0], rmSync: [0], rmdirSync: [0], mkdirSync: [0], symlinkSync: [0, 1], copyFileSync: [1], chmodSync: [0], truncateSync: [0], linkSync: [0, 1], chownSync: [0], utimesSync: [0], lutimesSync: [0] };
for (const fn of Object.keys(MUTATORS)) {
  const orig = fsMod[fn];
  if (typeof orig !== 'function') continue;
  const argIdx = MUTATORS[fn];
  fsMod[fn] = function () {
    const args = Array.prototype.slice.call(arguments);
    const targets = argIdx.map(function (i) { return typeof args[i] === 'string' ? args[i] : null; }).filter(Boolean);
    const escaped = targets.filter(function (p) { return !insideOwned(p); });
    if (escaped.length > 0) {
      effect('fs-' + fn, escaped.join(' | '));
      const e = denialError('fs.' + fn + ' ' + escaped.join(' | '));
      e.code = 'TT_EFFECT_DENIED';
      throw e;
    }
    return orig.apply(this, arguments);
  };
}
const origKill = process.kill;
process.kill = function (pid, sig) {
  if (sig === 0 || sig === undefined) return origKill.apply(this, arguments);
  effect('kill', String(pid) + ' ' + String(sig));
  throw denialError('process.kill ' + pid + ' ' + sig);
};
console.error('[tt-boundary-recorder] loaded');
`;

// ─────────────────────────────────────────────────────────────────────
// Test-run state (built once in before()).
// ─────────────────────────────────────────────────────────────────────
let evidenceRoot = DEFAULT_EVIDENCE_ROOT;
let runDir = "";
let varRoot = "";
let homeDir = "";
let foreignDir = "";
let var2Root = "";
let recorderPath = "";
let baseCampaignDir = "";
let baseCampaignId = "";
let baseStatePath = "";
let baseFiles: Record<string, string> = {};
const caseRecords: Array<Record<string, any>> = [];

function caseJournal(name: string): string {
  return path.join(runDir, "journals", `${name}.jsonl`);
}
function caseDirUnderVar(name: string): string {
  const dir = path.join(varRoot, "results", `boundary-${name}-${stamp()}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// A fresh campaign state for a case: base prepared state + a mutation fn.
function writeCaseState(name: string, mutate: (s: any) => void): { caseDir: string; statePath: string } {
  const caseDir = caseDirUnderVar(name);
  const state = loadJson(baseStatePath);
  mutate(state);
  const statePath = path.join(caseDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  return { caseDir, statePath };
}
function loadBaseState(): any {
  return loadJson(baseStatePath);
}
function makeApproval(name: string, approval: Record<string, any>): string {
  const dir = path.join(runDir, "approvals");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  // STORM-REAL US-003: every approval in this matrix authorizes the
  // SCRIPTED_REHEARSAL campaign profile (the base campaign's persisted
  // profile), so the default carries it; an explicit value in `approval` wins
  // (letting a case pin a different or deliberately absent profile).
  const body = { profile: REHEARSAL_PROFILE, ...approval };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^NODE_TEST_CONTEXT$/.test(k) || /^TAMANDUA_(RUN|WORKER|STEP)_/.test(k)) delete env[k];
  }
  delete env.NODE_OPTIONS;
  return {
    ...env,
    HOME: homeDir,
    TT_VAR: varRoot,
    TT_OWNED_ROOTS: varRoot,
    TT_EFFECT_JOURNAL: caseJournal("__unset__"),
    TAMANDUA_TEST_GUARD: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    NODE_OPTIONS: `--import=${recorderPath}`,
    TT_REPO_ROOT: repoRoot,
    TT_BASE_CAMPAIGN: baseCampaignDir,
    ...extra,
  };
}
function runCli(args: string[], opts: { env?: Record<string, string>; cwd?: string } = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [TT_STORM_CLI, ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnv(opts.env),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}
function runNode(scriptPath: string, opts: { env?: Record<string, string> } = {}): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: childEnv(opts.env),
  });
  return { status: res.status, stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? "") };
}
function writeScenario(name: string, source: string): string {
  const dir = path.join(runDir, "scenarios");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(file, source);
  return file;
}
function journalEffects(journal: string): Array<Record<string, any>> {
  if (!fs.existsSync(journal)) return [];
  return fs.readFileSync(journal, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l)).filter((r) => r.class === "effect");
}
function assertZeroEffects(journal: string, label: string): void {
  const effects = journalEffects(journal);
  assert.deepEqual(effects, [], `${label}: recorder must log ZERO real spawn/write/signal effects (got ${JSON.stringify(effects)})`);
}
function recordCase(name: string, payload: Record<string, any>): void {
  const rec = { name, ts: new Date().toISOString(), ...payload };
  caseRecords.push(rec);
  const dir = path.join(runDir, "cases");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(rec, null, 2) + "\n");
}
function refuseMatches(stderr: string, re: RegExp): void {
  assert.match(stderr, /REFUSED|requires|unknown command/, `stderr must carry a refusal marker: ${stderr.slice(0, 400)}`);
  assert.match(stderr, re, `stderr must match ${re}: ${stderr.slice(0, 400)}`);
}

describe("STORM-REHEARSAL US-003 boundary/negative matrix — ACTUAL gate + CLI inside an effect-recording/denying child environment", () => {
  before(() => {
    if (process.env.TT_BOUNDARY_EVIDENCE_ROOT) {
      evidenceRoot = path.resolve(process.env.TT_BOUNDARY_EVIDENCE_ROOT);
    }
    runDir = path.join(evidenceRoot, `boundary-${stamp()}-${process.pid}`);
    fs.mkdirSync(runDir, { recursive: true });
    fs.mkdirSync(path.join(runDir, "journals"), { recursive: true });
    varRoot = path.join(runDir, "var");
    homeDir = path.join(runDir, "home");
    foreignDir = path.join(runDir, "foreign");
    var2Root = path.join(runDir, "var2");
    fs.mkdirSync(varRoot, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.mkdirSync(var2Root, { recursive: true });
    recorderPath = path.join(runDir, "recorder.mjs");
    fs.writeFileSync(recorderPath, RECORDER_SOURCE);
    // Real tt-storm prepare inside the recorder env: the base campaign every
    // negative reuses. NO daemon/harness/chaos (US-001 contract); the recorder
    // proves zero denied effects even from the real CLI prepare.
    const j = caseJournal("base-prepare");
    const res = runCli(["prepare"], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(res.status, 0, `base prepare must exit 0 inside the recorder env:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
    const m = /Campaign dir: (\S+)/.exec(res.stdout);
    assert.ok(m, "prepare prints the campaign dir");
    baseCampaignDir = m[1];
    baseStatePath = path.join(baseCampaignDir, "state.json");
    const state = loadBaseState();
    baseCampaignId = state.campaign_id;
    assert.ok(baseCampaignId.startsWith("storm-"), "base campaign id is storm-*");
    assertZeroEffects(j, "base prepare");
    for (const name of ["state.json", "descriptor.json", "intent.jsonl", "ops.jsonl"]) {
      const p = path.join(baseCampaignDir, name);
      if (fs.existsSync(p)) baseFiles[name] = shaFile(p);
    }
  });

  after(() => {
    // Retained evidence index — never delete the evidence tree (no-removal).
    const manifest = {
      schema_version: 1,
      kind: "storm-rehearsal-boundary-evidence",
      run: runDir,
      generated_at: new Date().toISOString(),
      base_campaign: { id: baseCampaignId, dir: baseCampaignDir },
      coordinator_approval_file: DEFAULT_COORDINATOR_APPROVAL_FILE,
      coordinator_approval_present: (() => { try { fs.accessSync(DEFAULT_COORDINATOR_APPROVAL_FILE); return true; } catch { return false; } })(),
      cases: caseRecords,
    };
    try {
      fs.writeFileSync(path.join(runDir, "evidence-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    } catch { /* evidence write is best-effort */ }
  });

  // N00 — base-prepare materialization containment (US-001/S5 reconciliation):
  // the new scripted-runtime writes land ONLY under the owned roots, never
  // inside the campaign dir, and the campaign file set stays unchanged.
  it("N00: base prepare materializes the scripted-runtime contract inside the owned roots (never campaignDir) with zero denied effects", () => {
    const state = JSON.parse(fs.readFileSync(baseStatePath, "utf8"));
    const sr = state.rehearsal?.scripted_runtime;
    assert.ok(sr && typeof sr === "object", "base prepare records the scripted-runtime contract (S5)");
    assert.ok(sr.agents > 0, "scripted behaviors cover at least one agent");
    assert.ok(path.isAbsolute(sr.behaviors_file) && fs.existsSync(sr.behaviors_file), "behaviors file exists at an absolute path");
    assert.ok(path.isAbsolute(sr.state_dir) && fs.statSync(sr.state_dir).isDirectory(), "scripted state dir exists");
    assert.ok(!sr.behaviors_file.startsWith(baseCampaignDir + path.sep), "behaviors file is not inside the campaign dir");
    assert.ok(!sr.state_dir.startsWith(baseCampaignDir + path.sep), "scripted state dir is not inside the campaign dir");
    assert.deepEqual(fs.readdirSync(baseCampaignDir).sort(), ["descriptor.json", "intent.jsonl", "ops.jsonl", "results", "state.json"], "campaign dir file set unchanged by materialization");
    assertZeroEffects(caseJournal("base-prepare"), "base prepare");
  });

  // N01 — harness positive control: the recorder independently denies + logs.
  it("N01: effect-denying harness sanity — a launcher spawn, an outside-owned write and a real signal are journaled AND denied; git stays allowed", () => {
    const j = caseJournal("n01-harness");
    const scenario = writeScenario("n01-harness", String.raw`import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const repo = process.env.TT_REPO_ROOT;
// 1) launcher spawn (a hypothetical validator bug reaching the real CLI):
const r = spawnSync(repo + '/bin/tamandua', ['workflow', 'run'], { encoding: 'utf8' });
if (r.status !== 42) throw new Error('launcher spawn was NOT denied: status=' + r.status);
console.log('DENIED_LAUNCHER');
// 2) outside-owned write:
let fsDenied = false;
try { fs.writeFileSync('/root/should-never-exist-us003.txt', 'x'); } catch (e) { fsDenied = e.code === 'TT_EFFECT_DENIED'; }
if (!fsDenied) throw new Error('outside-owned fs write was NOT denied');
console.log('DENIED_FS_WRITE');
// 3) real signal:
let killDenied = false;
try { process.kill(1, 'SIGTERM'); } catch (e) { killDenied = e.code === 'TT_EFFECT_DENIED'; }
if (!killDenied) throw new Error('real signal was NOT denied');
console.log('DENIED_SIGNAL');
// 4) git provenance stays allowed (read-only; benign-git journaled, never an effect):
const g = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repo, encoding: 'utf8' });
if (g.status !== 0) throw new Error('git read-only spawn must stay allowed: ' + g.status + ' ' + g.stderr);
console.log('GIT_ALLOWED');
`);
    const res = runNode(scenario, { env: { TT_EFFECT_JOURNAL: j, ...plantedLeakEnv() } });
    assert.equal(res.status, 0, `harness sanity scenario failed:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
    for (const marker of ["DENIED_LAUNCHER", "DENIED_FS_WRITE", "DENIED_SIGNAL", "GIT_ALLOWED"]) {
      assert.ok(res.stdout.includes(marker), `scenario must print ${marker}`);
    }
    const effects = journalEffects(j);
    assert.equal(effects.filter((e) => e.kind === "spawnSync").length, 1, "one denied launcher spawnSync");
    assert.equal(effects.filter((e) => e.kind === "fs-writeFileSync").length, 1, "one denied outside-owned write");
    assert.equal(effects.filter((e) => e.kind === "kill").length, 1, "one denied real signal");
    recordCase("n01-harness", { status: res.status, stdout: res.stdout, effects: effects.length });
  });

  // N02..N11 — approve negatives (all exit 3, all zero recorder effects, base
  // campaign files byte-identical).
  it("N02: approve — fake approval with NO gate hashes is denied by the strict validator (the exact synthetic receipt of the 19:40 incident)", () => {
    const j = caseJournal("n02-approve-nohash");
    const state = loadBaseState();
    const fake = makeApproval("n02-nohash", {
      real_launch_allowed: true,
      campaign_id: state.campaign_id,
      source_commit: state.source.commit,
      approval_kind: REHEARSAL_PROFILE,
    });
    assert.notEqual(fake, DEFAULT_COORDINATOR_APPROVAL_FILE, "fake approvals never touch the coordinator-owned file");
    const r = runCli(["approve", "--campaign", baseCampaignDir, "--approval-file", fake], { env: { TT_EFFECT_JOURNAL: j, ...plantedLeakEnv() } });
    assert.equal(r.status, 3, `approve must refuse a no-hash synthetic approval:\n${r.stdout}\n${r.stderr}`);
    refuseMatches(r.stderr, /synthetic rehearsal receipt|gate_hashes/);
    assertZeroEffects(j, "n02");
    for (const [name, h] of Object.entries(baseFiles)) {
      assert.equal(shaFile(path.join(baseCampaignDir, name)), h, `base ${name} unchanged after refused approve`);
    }
    assert.equal(loadBaseState().qualification.real_launch_allowed, false, "campaign stays unqualified");
    recordCase("n02-approve-nohash", { status: r.status, stderr: r.stderr, state_unchanged: true });
  });

  it("N03: approve — PARTIAL gate-hash approval is denied (approval omits gate files)", () => {
    const j = caseJournal("n03-approve-partial");
    const state = loadBaseState();
    const gateHashes = computeGateHashes();
    const oneFile = Object.keys(gateHashes)[0];
    const fake = makeApproval("n03-partial", {
      real_launch_allowed: true,
      campaign_id: state.campaign_id,
      source_commit: state.source.commit,
      approval_kind: REHEARSAL_PROFILE,
      gate_hashes: { [oneFile]: gateHashes[oneFile] },
    });
    const r = runCli(["approve", "--campaign", baseCampaignDir, "--approval-file", fake], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r.status, 3, `approve must refuse a partial-hash approval:\n${r.stderr}`);
    refuseMatches(r.stderr, /omits a tested gate file|do not match the tested boundary/);
    assertZeroEffects(j, "n03");
    assert.equal(loadBaseState().qualification.real_launch_allowed, false);
    recordCase("n03-approve-partial", { status: r.status, stderr: r.stderr });
  });

  it("N04: approve — SUPERSET + hash-mismatch approvals are denied (stale approval after gate-code change)", () => {
    const j = caseJournal("n04-approve-mismatch");
    const state = loadBaseState();
    const gateHashes = computeGateHashes();
    const superset = makeApproval("n04-superset", {
      real_launch_allowed: true,
      campaign_id: state.campaign_id,
      source_commit: state.source.commit,
      approval_kind: REHEARSAL_PROFILE,
      gate_hashes: { ...gateHashes, "torture-test/bin/tt-storm-extra.mjs": "0".repeat(64) },
    });
    const r1 = runCli(["approve", "--campaign", baseCampaignDir, "--approval-file", superset], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r1.status, 3, `approve must refuse a superset-hash approval:\n${r1.stderr}`);
    refuseMatches(r1.stderr, /outside the tested gate set/);
    assertZeroEffects(j, "n04-superset");
    assert.equal(loadBaseState().qualification.real_launch_allowed, false);
    const stale = makeApproval("n04-stale", {
      ...loadJson(superset),
      gate_hashes: { ...gateHashes, [Object.keys(gateHashes)[0]]: "f".repeat(64) },
    });
    const r2 = runCli(["approve", "--campaign", baseCampaignDir, "--approval-file", stale], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r2.status, 3, `approve must refuse a hash-mismatch approval:\n${r2.stderr}`);
    refuseMatches(r2.stderr, /hash mismatch/);
    assertZeroEffects(j, "n04-stale");
    recordCase("n04-approve-mismatch", { superset_status: r1.status, stale_status: r2.status });
  });

  it("N05: approve — MISSING campaign_id / MISSING source_commit in the approval are denied (non-empty ids required)", () => {
    const j = caseJournal("n05-approve-missing-ids");
    const state = loadBaseState();
    const gateHashes = computeGateHashes();
    const noCampaign = makeApproval("n05-no-campaign", {
      real_launch_allowed: true,
      source_commit: state.source.commit,
      approval_kind: REHEARSAL_PROFILE,
      gate_hashes: gateHashes,
    });
    const r1 = runCli(["approve", "--campaign", baseCampaignDir, "--approval-file", noCampaign], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r1.status, 3, `approve must refuse an approval without campaign_id:\n${r1.stderr}`);
    refuseMatches(r1.stderr, /approval carries no campaign_id/);
    assertZeroEffects(j, "n05-no-campaign");
    const noSource = makeApproval("n05-no-source", {
      real_launch_allowed: true,
      campaign_id: state.campaign_id,
      approval_kind: REHEARSAL_PROFILE,
      gate_hashes: gateHashes,
    });
    const r2 = runCli(["approve", "--campaign", baseCampaignDir, "--approval-file", noSource], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r2.status, 3, `approve must refuse an approval without source_commit:\n${r2.stderr}`);
    refuseMatches(r2.stderr, /approval carries no source_commit/);
    assertZeroEffects(j, "n05-no-source");
    recordCase("n05-approve-missing-ids", { no_campaign_status: r1.status, no_source_status: r2.status });
  });

  it("N06: approve — WRONG campaign_id and WRONG source_commit are denied (exact identity matching)", () => {
    const j = caseJournal("n06-approve-wrong-ids");
    const state = loadBaseState();
    const gateHashes = computeGateHashes();
    const wrongCampaign = makeApproval("n06-wrong-campaign", {
      real_launch_allowed: true,
      campaign_id: "storm-some-other-campaign",
      source_commit: state.source.commit,
      approval_kind: REHEARSAL_PROFILE,
      gate_hashes: gateHashes,
    });
    const r1 = runCli(["approve", "--campaign", baseCampaignDir, "--approval-file", wrongCampaign], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r1.status, 3, `approve must refuse a wrong-campaign approval:\n${r1.stderr}`);
    refuseMatches(r1.stderr, /does not match campaign/);
    assertZeroEffects(j, "n06-wrong-campaign");
    // Full current hashes but a DIFFERENT (mismatched) source snapshot.
    const wrongSource = makeApproval("n06-wrong-source", {
      real_launch_allowed: true,
      campaign_id: state.campaign_id,
      source_commit: "f".repeat(40),
      approval_kind: REHEARSAL_PROFILE,
      gate_hashes: gateHashes,
    });
    const r2 = runCli(["approve", "--campaign", baseCampaignDir, "--approval-file", wrongSource], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r2.status, 3, `approve must refuse a mismatched-source approval:\n${r2.stderr}`);
    refuseMatches(r2.stderr, /does not match current source/);
    assertZeroEffects(j, "n06-wrong-source");
    recordCase("n06-approve-wrong-ids", { wrong_campaign_status: r1.status, wrong_source_status: r2.status });
  });

  it("N07: approve — an unreadable/missing approval file is denied before any effect", () => {
    const j = caseJournal("n07-approve-unreadable");
    const missing = path.join(runDir, "approvals", "n07-does-not-exist.json");
    const r = runCli(["approve", "--campaign", baseCampaignDir, "--approval-file", missing], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r.status, 3, `approve must refuse an unreadable approval file:\n${r.stderr}`);
    refuseMatches(r.stderr, /approval file unreadable\/invalid/);
    assertZeroEffects(j, "n07");
    recordCase("n07-approve-unreadable", { status: r.status, stderr: r.stderr });
  });

  it("N08: approve — ABSENT campaign dir (missing root+state) is refused with zero effects", () => {
    const j = caseJournal("n08-approve-absent-campaign");
    const missing = path.join(varRoot, "results", `boundary-absent-${stamp()}`);
    const r = runCli(["approve", "--campaign", missing, "--approval-file", makeApproval("n08-any", {})], { env: { TT_EFFECT_JOURNAL: j } });
    assert.notEqual(r.status, 0, "approve with an absent campaign dir must refuse");
    assert.match(r.stderr, /state\.json missing|REFUSED/);
    assertZeroEffects(j, "n08");
    recordCase("n08-approve-absent-campaign", { status: r.status, stderr: r.stderr });
  });

  it("N09: approve — FOREIGN campaign dir (escapes the owned var root) is refused by canonical containment", () => {
    const j = caseJournal("n09-approve-foreign");
    const foreignCampaign = path.join(foreignDir, "foreign-campaign");
    fs.mkdirSync(foreignCampaign, { recursive: true });
    fs.writeFileSync(path.join(foreignCampaign, "state.json"), JSON.stringify(loadBaseState(), null, 2) + "\n");
    const beforeForeign = shaFile(path.join(foreignCampaign, "state.json"));
    const r = runCli(["approve", "--campaign", foreignCampaign, "--approval-file", makeApproval("n09-any", {})], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r.status, 3, `approve with a foreign campaign dir must refuse with TT_EXEC_ESCAPE:\n${r.stderr}`);
    refuseMatches(r.stderr, /escapes|REFUSED/);
    assertZeroEffects(j, "n09");
    assert.equal(shaFile(path.join(foreignCampaign, "state.json")), beforeForeign, "foreign campaign state untouched");
    recordCase("n09-approve-foreign", { status: r.status, stderr: r.stderr });
  });

  it("N10: approve — REPLACED/ABSENT owned root: receipt captured for a different var root is refused (TT_NOT_OWNED), state untouched", () => {
    const j = caseJournal("n10-approve-replaced-root");
    // A receipt captured against var2 (drifted exec identity) written into a
    // campaign under varRoot: revalidation must refuse the drift.
    const ctx2 = buildPrivateExecContext({ varRoot: var2Root, binaries: { tamandua: TAMANDUA_BIN } });
    const receipt2 = persistableExecIdentity(ctx2);
    const { caseDir, statePath } = writeCaseState("n10-replaced-root", (s) => { s.exec_identity = receipt2; });
    const before = shaFile(statePath);
    const r = runCli(["approve", "--campaign", caseDir, "--approval-file", makeApproval("n10-any", {})], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r.status, 3, `approve must refuse a replaced/drifted exec-root receipt:\n${r.stderr}`);
    refuseMatches(r.stderr, /drifted|re-prepare|REFUSED/);
    assertZeroEffects(j, "n10");
    assert.equal(shaFile(statePath), before, "case state untouched after ownership refusal");
    recordCase("n10-approve-replaced-root", { status: r.status, stderr: r.stderr });
  });

  it("N11: approve — safe negative symlink fixture under a NEW name inside the owned var: canonical destination is foreign so it is refused and every original captured file stays intact", () => {
    const j = caseJournal("n11-approve-symlink-escape");
    // NEW-name symlink inside the owned campaign/var area pointing at a
    // foreign real directory (outside var) that carries campaign state. Root
    // defect #3: a lexically nested campaign whose REAL destination is foreign
    // must be refused by canonical containment — even though loadState can
    // read through the symlink, assertModeContained resolves the real
    // destination BEFORE any effect.
    const foreignCampaign = path.join(foreignDir, `symlink-target-${stamp()}`);
    fs.mkdirSync(foreignCampaign, { recursive: true });
    const foreignState = path.join(foreignCampaign, "state.json");
    fs.writeFileSync(foreignState, JSON.stringify(loadBaseState(), null, 2) + "\n");
    const linkPath = path.join(varRoot, "results", `boundary-${baseCampaignId}-escape-link-${stamp()}`);
    fs.symlinkSync(foreignCampaign, linkPath, "dir");
    assert.ok(fs.existsSync(linkPath), "negative symlink fixture exists under a NEW name (never removed)");
    const beforeForeign = shaFile(foreignState);
    const r = runCli(["approve", "--campaign", linkPath, "--approval-file", makeApproval("n11-any", {})], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r.status, 3, `approve through an escape symlink must refuse with canonical containment:\n${r.stderr}`);
    refuseMatches(r.stderr, /escapes|REFUSED/);
    assertZeroEffects(j, "n11");
    // Original captured files intact: base campaign untouched + the foreign
    // real destination (whose state the symlink would have reached) untouched
    // — nothing was written through the link.
    for (const [name, h] of Object.entries(baseFiles)) {
      assert.equal(shaFile(path.join(baseCampaignDir, name)), h, `base ${name} unchanged after symlink-escape negative`);
    }
    assert.equal(shaFile(foreignState), beforeForeign, "foreign real destination state untouched");
    assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, "negative symlink fixture retained (no rm/unlink ever)");
    recordCase("n11-approve-symlink-escape", { status: r.status, link: linkPath, stderr: r.stderr });
  });

  // N12..N16 — rehearse + run negatives.
  it("N12: rehearse — a fake no-hash approval is denied through the rehearse entrypoint (round A) with zero effects", () => {
    const j = caseJournal("n12-rehearse-nohash");
    const state = loadBaseState();
    const fake = makeApproval("n12-nohash", {
      real_launch_allowed: true,
      campaign_id: state.campaign_id,
      source_commit: state.source.commit,
      approval_kind: REHEARSAL_PROFILE,
    });
    const r = runCli(["rehearse", "--campaign", baseCampaignDir, "--round", "A", "--approval-file", fake], { env: { TT_EFFECT_JOURNAL: j, ...plantedLeakEnv() } });
    assert.equal(r.status, 3, `rehearse must refuse a no-hash synthetic approval:\n${r.stderr}`);
    refuseMatches(r.stderr, /synthetic rehearsal receipt|gate_hashes/);
    assertZeroEffects(j, "n12");
    for (const [name, h] of Object.entries(baseFiles)) {
      assert.equal(shaFile(path.join(baseCampaignDir, name)), h, `base ${name} unchanged after refused rehearse`);
    }
    recordCase("n12-rehearse-nohash", { status: r.status, stderr: r.stderr });
  });

  it("N13: rehearse — missing --approval-file is a usage refusal; run on an unqualified campaign is refused (zero effects)", () => {
    const j1 = caseJournal("n13a-rehearse-no-approval");
    const r1 = runCli(["rehearse", "--campaign", baseCampaignDir, "--round", "A"], { env: { TT_EFFECT_JOURNAL: j1 } });
    assert.equal(r1.status, 4, "rehearse without --approval-file is a usage refusal");
    assert.match(r1.stderr, /requires --approval-file/);
    assertZeroEffects(j1, "n13a");
    const j2 = caseJournal("n13b-run-unqualified");
    const r2 = runCli(["run", "--campaign", baseCampaignDir, "--round", "A"], { env: { TT_EFFECT_JOURNAL: j2, ...plantedLeakEnv() } });
    assert.equal(r2.status, 3, "run on an unqualified campaign must refuse");
    refuseMatches(r2.stderr, /not-yet-qualified/);
    assertZeroEffects(j2, "n13b");
    for (const [name, h] of Object.entries(baseFiles)) {
      assert.equal(shaFile(path.join(baseCampaignDir, name)), h, `base ${name} unchanged after refused run`);
    }
    recordCase("n13-rehearse-run-unqualified", { rehearse_status: r1.status, run_status: r2.status });
  });

  it("N14: run — a stale persisted qualification boolean (real_launch_allowed=true with no approval_file) is NOT authority; refused", () => {
    const j = caseJournal("n14-run-stale-boolean");
    const { caseDir, statePath } = writeCaseState("n14-stale-boolean", (s) => {
      s.qualification = { real_launch_allowed: true, note: "stale boolean — no recorded approval file" };
    });
    const before = shaFile(statePath);
    const r = runCli(["run", "--campaign", caseDir, "--round", "A"], { env: { TT_EFFECT_JOURNAL: j, ...plantedLeakEnv() } });
    assert.equal(r.status, 3, `run must refuse a stale persisted boolean:\n${r.stderr}`);
    refuseMatches(r.stderr, /stale state boolean|cannot authorize/);
    assertZeroEffects(j, "n14");
    assert.equal(shaFile(statePath), before, "case state unchanged after stale-boolean refusal");
    recordCase("n14-run-stale-boolean", { status: r.status, stderr: r.stderr });
  });

  it("N15: run — qualification pointing at a missing on-disk approval file is refused (run re-verifies the file, never trusts state)", () => {
    const j = caseJournal("n15-run-missing-approval-file");
    const { caseDir, statePath } = writeCaseState("n15-missing-approval", (s) => {
      s.qualification = {
        real_launch_allowed: true,
        approval_file: path.join(runDir, "approvals", "n15-gone.json"),
      };
    });
    const before = shaFile(statePath);
    const r = runCli(["run", "--campaign", caseDir, "--round", "A"], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r.status, 3, `run must refuse a qualification whose approval file is missing:\n${r.stderr}`);
    refuseMatches(r.stderr, /recorded approval file unreadable/);
    assertZeroEffects(j, "n15");
    assert.equal(shaFile(statePath), before);
    recordCase("n15-run-missing-approval-file", { status: r.status, stderr: r.stderr });
  });

  it("N16: run — on-disk approval with full current hashes but a MISMATCHED source snapshot is refused at run-time re-validation; malformed qualification refused", () => {
    const j = caseJournal("n16-run-source-mismatch");
    const state = loadBaseState();
    const nearValid = makeApproval("n16-source-mismatch", {
      real_launch_allowed: true,
      campaign_id: state.campaign_id,
      source_commit: "c".repeat(40), // wrong snapshot: current source is the real commit
      approval_kind: REHEARSAL_PROFILE,
      gate_hashes: computeGateHashes(),
    });
    const { caseDir, statePath } = writeCaseState("n16-source-mismatch", (s) => {
      s.qualification = { real_launch_allowed: true, approval_file: nearValid };
    });
    const before = shaFile(statePath);
    const r = runCli(["run", "--campaign", caseDir, "--round", "A"], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r.status, 3, `run must refuse a source-mismatched on-disk approval:\n${r.stderr}`);
    refuseMatches(r.stderr, /does not match current source|stale\/changed approval/);
    assertZeroEffects(j, "n16-source");
    assert.equal(shaFile(statePath), before);
    // Malformed (non-object) qualification.
    const j2 = caseJournal("n16-malformed-qual");
    const { caseDir: caseDir2, statePath: statePath2 } = writeCaseState("n16-malformed", (s) => {
      (s as any).qualification = "qualified-later";
    });
    const before2 = shaFile(statePath2);
    const r2 = runCli(["run", "--campaign", caseDir2, "--round", "A"], { env: { TT_EFFECT_JOURNAL: j2, ...plantedLeakEnv() } });
    assert.equal(r2.status, 3, `run must refuse malformed qualification:\n${r2.stderr}`);
    refuseMatches(r2.stderr, /not-yet-qualified/);
    assertZeroEffects(j2, "n16-malformed");
    assert.equal(shaFile(statePath2), before2);
    recordCase("n16-run-source-mismatch", { mismatch_status: r.status, malformed_status: r2.status });
  });

  it("N17: resume — an UNKNOWN run id (row absent from the contained DB) is classified unknown_run and NEVER relaunched; zero launch effects", () => {
    const j = caseJournal("n17-resume-unknown-run");
    const dbDir = path.join(varRoot, "home", ".tamandua");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbFile = path.join(dbDir, "tamandua.db");
    // US-001 (S2): the base prepare already created this DB FRESH through the
    // PRODUCT schema path, so this case must NOT hand-roll a `runs` table (that
    // CREATE would collide). Open the product-schema DB, prove it is the real
    // product schema (notify_url), and ensure it has zero run rows so an
    // unknown run id is genuinely absent.
    assert.ok(fs.existsSync(dbFile), "base prepare created the product-schema campaign DB");
    const db = new DatabaseSync(dbFile);
    try {
      const runCols = (db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map((r) => r.name);
      assert.ok(runCols.includes("notify_url"), "campaign DB carries the product runs schema (notify_url), not a hand-rolled DDL");
      db.exec("DELETE FROM runs;");
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
      assert.equal(Number(remaining.n), 0, "campaign DB has zero run rows before the unknown-run resume");
    } finally {
      db.close();
    }
    const unknownUuid = randomUUID();
    const { caseDir } = writeCaseState("n17-unknown-run", (s) => {
      s.rounds.A.status = "running";
      s.rounds.A.runs.S1 = {
        rosterId: "S1",
        runId: `run-${unknownUuid}`,
        status: "registered",
        workflow: "feature-dev-merge-worktree",
        harness: "pi",
      };
    });
    const beforeState = shaFile(path.join(caseDir, "state.json"));
    const r = runCli(["resume", "--campaign", caseDir, "--round", "A"], { env: { TT_EFFECT_JOURNAL: j, ...plantedLeakEnv() } });
    assert.equal(r.status, 0, `resume must complete while classifying the unknown run:\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    assertZeroEffects(j, "n17");
    const after = loadJson(path.join(caseDir, "state.json"));
    assert.equal(after.rounds.A.runs.S1.status, "unknown_run", "unknown run id is recorded unknown_run, never relaunched");
    const ops = fs.readFileSync(path.join(caseDir, "ops.jsonl"), "utf8");
    assert.match(ops, /resume\.unknown_run/, "ops ledger records the unknown_run classification");
    assert.match(ops, /run row missing from campaign DB on resume/, "unknown_run reason names the missing row");
    assert.notEqual(shaFile(path.join(caseDir, "state.json")), beforeState, "resume rewrites state (mode/unknown_run) — this is the sanctioned engine write");
    recordCase("n17-resume-unknown-run", { status: r.status, unknown_run: after.rounds.A.runs.S1.status });
  });

  // N18 — function-level exported-gate negatives inside the child env.
  it("N18: exported-gate negatives in-child — verifyCoordinatorApproval matrix, missing gate source file, non-owned/stale pid kill, cleanup evidence, env leak allowlist, ownership replaced/absent", () => {
    const j = caseJournal("n18-exported-negatives");
    const scenario = writeScenario("n18-exported", String.raw`import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.env.TT_REPO_ROOT;
const realMod = await import(pathToFileURL(path.join(repo, 'torture-test', 'bin', 'tt-storm-real.mjs')).href);
const sharedMod = await import(pathToFileURL(path.join(repo, 'torture-test', 'bin', 'tt-storm-shared.mjs')).href);
const rehearseMod = await import(pathToFileURL(path.join(repo, 'torture-test', 'bin', 'tt-storm-rehearsal.mjs')).href);
const sharedCsMod = await import(pathToFileURL(path.join(repo, 'torture-test', 'bin', 'tt-contention-slice-shared.mjs')).href);

// (a) verifyCoordinatorApproval strict matrix (pure, real exported function).
const gateHashes = rehearseMod.computeGateHashes();
const base = { real_launch_allowed: true, campaign_id: 'storm-camp-1', source_commit: '55ac724', approval_kind: 'SCRIPTED_REHEARSAL', gate_hashes: gateHashes };
assert.equal(realMod.verifyCoordinatorApproval({ approval: base, campaignId: 'storm-camp-1', sourceCommit: '55ac724', gateHashes }).ok, true);
const noHash = { ...base }; delete noHash.gate_hashes;
assert.equal(realMod.verifyCoordinatorApproval({ approval: noHash, campaignId: 'storm-camp-1', sourceCommit: '55ac724', gateHashes }).ok, false);
const partial = { ...base, gate_hashes: {} };
assert.equal(realMod.verifyCoordinatorApproval({ approval: partial, campaignId: 'storm-camp-1', sourceCommit: '55ac724', gateHashes }).ok, false);
const noCamp = { ...base }; delete noCamp.campaign_id;
assert.equal(realMod.verifyCoordinatorApproval({ approval: noCamp, campaignId: 'storm-camp-1', sourceCommit: '55ac724', gateHashes }).ok, false);
const wrongCamp = { ...base, campaign_id: 'storm-other' };
assert.equal(realMod.verifyCoordinatorApproval({ approval: wrongCamp, campaignId: 'storm-camp-1', sourceCommit: '55ac724', gateHashes }).ok, false);
const noSrc = { ...base }; delete noSrc.source_commit;
assert.equal(realMod.verifyCoordinatorApproval({ approval: noSrc, campaignId: 'storm-camp-1', sourceCommit: '55ac724', gateHashes }).ok, false);
const wrongSrc = { ...base, source_commit: 'deadbee' };
assert.equal(realMod.verifyCoordinatorApproval({ approval: wrongSrc, campaignId: 'storm-camp-1', sourceCommit: '55ac724', gateHashes }).ok, false);
const stale = { ...base, gate_hashes: { ...gateHashes, [Object.keys(gateHashes)[0]]: 'f'.repeat(64) } };
assert.equal(realMod.verifyCoordinatorApproval({ approval: stale, campaignId: 'storm-camp-1', sourceCommit: '55ac724', gateHashes }).ok, false);
const unqualified = { ...base, real_launch_allowed: false };
assert.equal(realMod.verifyCoordinatorApproval({ approval: unqualified, campaignId: 'storm-camp-1', sourceCommit: '55ac724', gateHashes }).ok, false);
console.log('VALIDATOR_MATRIX_OK');

// (b) computeGateHashes refuses a MISSING gate source file (injected fs mirror).
const missingFs = {
  readFileSync: function (p) { throw new Error('no such gate file: ' + p); },
};
let missingRefused = false;
try { rehearseMod.computeGateHashes({ fsx: missingFs }); } catch (e) { missingRefused = e.code === 'TT_GATE_FILE_MISSING'; }
assert.equal(missingRefused, true, 'computeGateHashes must refuse when a gate file is missing');
console.log('GATE_MISSING_REFUSED');

// (c) proc.kill of a NON-OWNED (borrowed/stale) pid is refused before any OS signal.
const varRoot = process.env.TT_VAR;
const ctx = realMod.buildPrivateExecContext({ varRoot: varRoot, binaries: { tamandua: path.join(repo, 'bin', 'tamandua') } });
const proc = realMod.makeRealProc({ execCtx: ctx });
const killRes = await proc.kill(424242, 'SIGTERM');
assert.equal(killRes.ok, false);
assert.equal(killRes.code, realMod.TT_NOT_OWNED);
console.log('FOREIGN_PID_KILL_REFUSED');

// (d) runOwnedCleanup refuses absent handlers / {} results (no positive evidence).
const rc1 = await realMod.runOwnedCleanup({ execCtx: ctx, handlers: {}, inventory: ['declared-resource'] });
assert.equal(rc1.ok, false, 'absent cleanup handler cannot PASS');
const rc2 = await realMod.runOwnedCleanup({ execCtx: ctx, handlers: { 'r': async function () { return {}; } }, inventory: ['r'] });
assert.equal(rc2.ok, false, '{} cleanup result cannot PASS');
console.log('CLEANUP_EVIDENCE_REFUSED');

// (e) child_env is an explicit allowlist — planted creds/harness/authority never leak.
const leaked = ['FAKE_AWS_ACCESS_KEY_ID', 'FAKE_AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TAMANDUA_RUN_ID', 'TAMANDUA_WORKER_PID', 'TAMANDUA_WORKER_JOB_ID', 'TAMANDUA_STEP_ID', 'TAMANDUA_WORKTREE_ROOT', 'TAMANDUA_PI_BINARY', 'TAMANDUA_HERMES_BINARY', 'TAMANDUA_DSH_BINARY', 'TT_HOME'];
for (const k of leaked) {
  assert.equal(k in ctx.child_env, false, 'child_env must not inherit leaked key ' + k);
}
assert.equal(ctx.child_env.TAMANDUA_TEST_GUARD, '1');
console.log('CHILD_ENV_LEAK_FREE');

// (f) ownership: replaced/absent roots refuse via injected fs mirror.
const mirror = {
  statSync: function (p) {
    // Simulate a REPLACED root: same path, different dev/ino.
    if (String(p).indexOf('home') >= 0) return { dev: 999, ino: 888 };
    return { dev: 1, ino: 1 };
  },
};
let replacedRefused = false;
try { realMod.assertOwnershipUnchanged(ctx.ownership, mirror); } catch (e) { replacedRefused = e.code === realMod.TT_NOT_OWNED; }
assert.equal(replacedRefused, true, 'assertOwnershipUnchanged must refuse replaced roots');
const missingOwnership = { home: { path: ctx.home_root, dev: 5, ino: 6 } };
let absentRefused = false;
const absentFs = { statSync: function () { throw new Error('ENOENT'); } };
try { realMod.assertOwnershipUnchanged(missingOwnership, absentFs); } catch (e) { absentRefused = e.code === realMod.TT_NOT_OWNED; }
assert.equal(absentRefused, true, 'assertOwnershipUnchanged must refuse missing roots');
console.log('OWNERSHIP_REPLACED_ABSENT_REFUSED');

// (g) unknown/malformed run scope refuses at the DB adapter boundary (pure).
assert.equal(sharedMod.parseRunKey('garbage').ok, false);
assert.equal(sharedMod.parseRunKey('step-abc').ok, false);
assert.equal(sharedMod.parseRunKey('not-run-' + '0'.repeat(36)).ok, false);
console.log('BAD_RUN_SCOPE_REFUSED');
console.log('SCENARIO_N18_OK');
`);
    const res = runNode(scenario, { env: { TT_EFFECT_JOURNAL: j, ...plantedLeakEnv() } });
    assert.equal(res.status, 0, `exported-gate negative scenario failed:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
    for (const marker of ["VALIDATOR_MATRIX_OK", "GATE_MISSING_REFUSED", "FOREIGN_PID_KILL_REFUSED", "CLEANUP_EVIDENCE_REFUSED", "CHILD_ENV_LEAK_FREE", "OWNERSHIP_REPLACED_ABSENT_REFUSED", "BAD_RUN_SCOPE_REFUSED"]) {
      assert.ok(res.stdout.includes(marker), `scenario must print ${marker}`);
    }
    assertZeroEffects(j, "n18");
    recordCase("n18-exported-negatives", { status: res.status });
  });

  // N19 — positive controls.
  it("N19: positive controls — canonical-alias campaign path resolves as owned (CLI reaches the validator, not containment) and fresh contained SQLite canonicalizes public run-<uuid> <-> bare uuid at the real adapter boundary", () => {
    // (a) alias symlink INSIDE the owned var pointing at the real campaign:
    // containment must pass (canonical destination owned) and the refusal must
    // come from the approval validator, proving the alias resolved as owned.
    const j = caseJournal("n19a-alias");
    const alias = path.join(varRoot, "results", `boundary-${baseCampaignId}-alias-${stamp()}`);
    fs.symlinkSync(baseCampaignDir, alias, "dir");
    const state = loadBaseState();
    const fake = makeApproval("n19a-no-hash", {
      real_launch_allowed: true,
      campaign_id: state.campaign_id,
      source_commit: state.source.commit,
      approval_kind: REHEARSAL_PROFILE,
    });
    const r = runCli(["approve", "--campaign", alias, "--approval-file", fake], { env: { TT_EFFECT_JOURNAL: j } });
    assert.equal(r.status, 3, `approve through an owned alias must reach the validator:\n${r.stderr}`);
    assert.doesNotMatch(r.stderr, /escapes/, "owned alias must NOT trip containment");
    refuseMatches(r.stderr, /synthetic rehearsal receipt|gate_hashes/);
    assertZeroEffects(j, "n19a");
    assert.equal(fs.realpathSync(alias), fs.realpathSync(baseCampaignDir), "alias realpath resolves to the owned campaign");
    // (b) SQLite canonicalization at the real adapter boundary (fresh contained DB).
    const j2 = caseJournal("n19b-sqlite");
    const dbDir = path.join(homeDir, ".tamandua");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbFile = path.join(dbDir, `identity-${randomUUID()}.db`);
    const db = new DatabaseSync(dbFile);
    db.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT, task TEXT, status TEXT, scheduling_status TEXT, tokens_spent INTEGER, parent_run_id TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), step_id TEXT NOT NULL, agent_id TEXT NOT NULL, status TEXT);`);
    const bareUuid = randomUUID();
    db.prepare("INSERT INTO runs (id, run_number, workflow_id, task, status, tokens_spent) VALUES (?, ?, ?, ?, ?, ?)").run(bareUuid, 1, "feature-dev-merge-worktree", "t", "running", 0);
    db.close();
    const scenario = writeScenario("n19b-sqlite", String.raw`import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = process.env.TT_REPO_ROOT;
const sharedMod = await import(pathToFileURL(path.join(repo, 'torture-test', 'bin', 'tt-storm-shared.mjs')).href);
const dbFile = process.env.TT_SQLITE_DB;
const pub = 'run-' + process.env.TT_BARE_UUID;
const bare = process.env.TT_BARE_UUID;
const parsedPub = sharedMod.parseRunKey(pub);
assert.equal(parsedPub.ok, true);
assert.equal(parsedPub.bare, bare);
const parsedBare = sharedMod.parseRunKey(bare);
assert.equal(parsedBare.ok, true);
assert.equal(parsedBare.public, pub);
const opened = sharedMod.REAL_DB.open(dbFile);
assert.equal(opened.ok, true);
const api = opened.api;
try {
  const byPublic = api.getRun(pub);
  assert.ok(byPublic, 'public key resolves');
  assert.equal(byPublic.run_id_bare, bare);
  assert.equal(byPublic.run_id_public, pub);
  const byBare = api.getRun(bare);
  assert.ok(byBare, 'bare key resolves');
  assert.equal(byBare.run_id_public, pub);
  let malformedRefused = false;
  try { api.getRun('garbage'); } catch (e) { malformedRefused = e.code === 'TT_BAD_RUN_SCOPE'; }
  assert.equal(malformedRefused, true, 'malformed run scope refused at the DB boundary');
  console.log('SQLITE_CANONICAL_OK');
} finally {
  try { api.close(); } catch {}
}
`);
    const res = runNode(scenario, { env: { TT_EFFECT_JOURNAL: j2, TT_SQLITE_DB: dbFile, TT_BARE_UUID: bareUuid } });
    assert.equal(res.status, 0, `sqlite canonicalization scenario failed:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
    assert.ok(res.stdout.includes("SQLITE_CANONICAL_OK"));
    assertZeroEffects(j2, "n19b");
    recordCase("n19-positives", { alias_status: r.status, sqlite_ok: true });
  });
});
