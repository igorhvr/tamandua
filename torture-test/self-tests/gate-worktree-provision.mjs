#!/usr/bin/env node

// gate-worktree-provision.mjs — NPF-2 US-009 owned guard-safe gate worktree
// provisioning.
//
// The product TEST ISOLATION guard treats any state/daemon root under the real
// `~/.tamandua` prefix as production and force-fails contained daemons, so the
// storm self-tests that start contained daemons cannot run from this run's
// worktree (which lives under `~/.tamandua/worktrees/...`). Every heavy gate
// therefore runs from an OWNED checkout OUTSIDE that prefix:
//
//   /home/kaladin/matchlock-work/npf2-gate-71af02c8
//
// Provisioning recipe (run #23's pattern, pinned here so later stories can
// re-sync it):
//
//   1. `git worktree add --detach <gateRoot> <tip>` (or
//      `git -C <gateRoot> checkout --detach <tip>` when the owned worktree
//      already exists) — never the origin's integration branch;
//   2. symlink `<gateRoot>/node_modules -> <runWorktree>/node_modules`;
//   3. `./build` from the gate root (npm install + npm run build);
//   4. verify `bin/tamandua-test` and `dist/suite/shim.js` exist.
//
// The pure half (`isUnderRealState`, `buildGateProvisionPlan`,
// `validateGateWorktreeProvisionReport`, `inspectGateWorktree`) is unit-tested
// by `tier2-gate-worktree-provisioning.test.ts`. The executable half
// (`provisionGateWorktree` + the CLI `main`) actually performs the recipe and
// retains a machine-readable report under the gate root's
// `torture-test/var/results/gate-worktree-provision-<ts>/`.
//
// It never touches an approval file and never executes `tt-storm rehearse` or
// any real storm. `torture-test/**` only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** The module's own repo root (the run worktree when invoked there). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The owned guard-safe gate worktree used by every heavy gate in this run. */
export const DEFAULT_GATE_WORKTREE_ROOT = "/home/kaladin/matchlock-work/npf2-gate-71af02c8";

/** Artifacts the build must have produced before later gates may rely on it. */
export const EXPECTED_BUILD_ARTIFACTS = ["bin/tamandua-test", "dist/suite/shim.js"];

/** The canonical build entrypoint (npm install + npm run build). */
export const GATE_BUILD_COMMAND = "./build";

/** The real-state prefix the product guard treats as production (mirror). */
export const REAL_TAMANDUA_STATE_PREFIX = path.join(os.userInfo().homedir, ".tamandua");

const HEX_TIP = /^[0-9a-f]{7,40}$/;
const REPORT_KIND = "gate-worktree-provision-report";
const REPORT_SCHEMA_VERSION = 1;

export class GateProvisionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GateProvisionError";
    this.code = code;
  }
}

/**
 * Mirror of the product TEST ISOLATION guard's containment predicate: true when
 * `candidate` is the real `~/.tamandua` prefix itself or anything beneath it.
 * Pure; never touches disk.
 */
export function isUnderRealState(candidate, { realStatePrefix = REAL_TAMANDUA_STATE_PREFIX } = {}) {
  if (typeof candidate !== "string" || candidate.trim() === "") return false;
  const normalized = path.resolve(candidate);
  const prefix = path.resolve(realStatePrefix);
  return normalized === prefix || normalized.startsWith(prefix + path.sep);
}

function assertAbsolute(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new GateProvisionError(`GATE_${label.toUpperCase()}_EMPTY`, `${label} is required`);
  }
  if (!path.isAbsolute(value)) {
    throw new GateProvisionError(
      `GATE_${label.toUpperCase()}_NOT_ABSOLUTE`,
      `${label} must be an absolute path, got ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Pure provisioning plan: validate the inputs (gate root must be owned and
 * guard-safe, tip must be a commit, run worktree must differ) and return the
 * ordered steps plus the canonical node_modules/artifact paths. Throws a
 * `GateProvisionError` with a stable `code` on any invalid input.
 */
export function buildGateProvisionPlan({
  gateRoot,
  tip,
  runWorktree = REPO_ROOT,
  realStatePrefix = REAL_TAMANDUA_STATE_PREFIX,
  buildCommand = GATE_BUILD_COMMAND,
} = {}) {
  assertAbsolute("gateRoot", gateRoot);
  assertAbsolute("runWorktree", runWorktree);
  if (typeof tip !== "string" || !HEX_TIP.test(tip.trim())) {
    throw new GateProvisionError(
      "GATE_TIP_INVALID",
      `tip must be a 7-40 character hex commit, got ${JSON.stringify(tip)}`,
    );
  }
  const resolvedGate = path.resolve(gateRoot);
  const resolvedRun = path.resolve(runWorktree);
  const resolvedPrefix = path.resolve(realStatePrefix);
  if (resolvedGate === resolvedRun) {
    throw new GateProvisionError(
      "GATE_ROOT_EQUALS_RUN_WORKTREE",
      "gate root must differ from the run worktree it is provisioned from",
    );
  }
  if (isUnderRealState(resolvedGate, { realStatePrefix: resolvedPrefix })) {
    throw new GateProvisionError(
      "GATE_ROOT_UNSAFE",
      `gate root ${resolvedGate} is under the real tamandua state prefix ${resolvedPrefix}; ` +
        "the product TEST ISOLATION guard would force-fail every contained daemon",
    );
  }
  const nodeModulesTarget = path.join(resolvedGate, "node_modules");
  const nodeModulesSource = path.join(resolvedRun, "node_modules");
  return {
    kind: "gate-worktree-provision-plan",
    gate_root: resolvedGate,
    tip: tip.trim(),
    run_worktree: resolvedRun,
    real_state_prefix: resolvedPrefix,
    guard_safe: true,
    node_modules: { source: nodeModulesSource, target: nodeModulesTarget },
    artifacts: [...EXPECTED_BUILD_ARTIFACTS],
    steps: [
      {
        action: "ensure_worktree",
        gate_root: resolvedGate,
        tip: tip.trim(),
        run_worktree: resolvedRun,
        worktree_exists: fs.existsSync(resolvedGate),
      },
      { action: "link_node_modules", source: nodeModulesSource, target: nodeModulesTarget },
      { action: "build", cwd: resolvedGate, command: [buildCommand] },
      {
        action: "verify_artifacts",
        artifacts: EXPECTED_BUILD_ARTIFACTS.map((rel) => path.join(resolvedGate, rel)),
      },
    ],
  };
}

function git(args, { cwd = undefined } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

/** `node_modules` is `target` iff the canonical owned path — never any other. */
function assertOwnedNodeModules(gateRoot, target) {
  const canonical = path.join(path.resolve(gateRoot), "node_modules");
  if (path.resolve(target) !== canonical) {
    throw new GateProvisionError(
      "GATE_NODE_MODULES_NOT_OWNED",
      `refusing to replace a node_modules outside the owned gate root (${target} != ${canonical})`,
    );
  }
}

/**
 * Ensure `<gateRoot>/node_modules` is a symlink to `source`. Idempotent: when it
 * already is the desired symlink nothing happens; otherwise (missing, a real
 * directory from a prior `npm install`, a symlink to the wrong target) the
 * owned path is replaced. `assertOwnedNodeModules` refuses any other path.
 */
export function linkGateNodeModules({ gateRoot, source, target = null } = {}) {
  const resolvedGate = path.resolve(gateRoot);
  const resolvedSource = path.resolve(source);
  const resolvedTarget = target ? path.resolve(target) : path.join(resolvedGate, "node_modules");
  assertOwnedNodeModules(resolvedGate, resolvedTarget);
  let action = "created";
  try {
    const stat = fs.lstatSync(resolvedTarget);
    if (stat.isSymbolicLink() && fs.readlinkSync(resolvedTarget) === resolvedSource) {
      return { action: "already_linked", source: resolvedSource, target: resolvedTarget, symlink: true };
    }
    action = "replaced";
    fs.rmSync(resolvedTarget, { recursive: true, force: true });
  } catch {
    action = "created";
  }
  fs.symlinkSync(resolvedSource, resolvedTarget, "dir");
  return { action, source: resolvedSource, target: resolvedTarget, symlink: true };
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/**
 * Execute the provisioning plan. Returns a machine-readable report; throws a
 * `GateProvisionError` when a step fails.
 */
export function provisionGateWorktree({
  gateRoot = DEFAULT_GATE_WORKTREE_ROOT,
  tip,
  runWorktree = REPO_ROOT,
  realStatePrefix = REAL_TAMANDUA_STATE_PREFIX,
  buildCommand = GATE_BUILD_COMMAND,
  buildArgs = [],
  resultsDir = null,
  label = null,
  log = () => {},
} = {}) {
  const plan = buildGateProvisionPlan({ gateRoot, tip, runWorktree, realStatePrefix, buildCommand });
  const steps = [];
  const startedAt = new Date().toISOString();

  // 1. ensure the detached worktree at the tip.
  const exists = fs.existsSync(plan.gate_root);
  let argv;
  if (exists) {
    if (!fs.statSync(plan.gate_root).isDirectory()) {
      throw new GateProvisionError("GATE_ROOT_NOT_DIRECTORY", `${plan.gate_root} exists and is not a directory`);
    }
    const inside = git(["-C", plan.gate_root, "rev-parse", "--is-inside-work-tree"]);
    if (inside.status !== 0 || inside.stdout.trim() !== "true") {
      throw new GateProvisionError(
        "GATE_ROOT_NOT_WORKTREE",
        `${plan.gate_root} exists but is not a git worktree: ${inside.stderr.trim() || inside.stdout.trim()}`,
      );
    }
    argv = ["-C", plan.gate_root, "checkout", "--detach", plan.tip];
  } else {
    fs.mkdirSync(path.dirname(plan.gate_root), { recursive: true });
    argv = ["-C", plan.run_worktree, "worktree", "add", "--detach", plan.gate_root, plan.tip];
  }
  log(`[1/4] git ${argv.join(" ")}`);
  const worktree = git(argv);
  steps.push({
    action: "ensure_worktree",
    argv: ["git", ...argv],
    exit_code: worktree.status,
    stdout: worktree.stdout,
    stderr: worktree.stderr,
  });
  if (worktree.status !== 0) {
    throw new GateProvisionError(
      "GATE_WORKTREE_FAILED",
      `git ${argv.join(" ")} failed (${worktree.status}): ${worktree.stderr.trim()}`,
    );
  }

  // 2. node_modules symlink to the run worktree.
  log(`[2/4] link node_modules -> ${plan.node_modules.source}`);
  const link = linkGateNodeModules({ gateRoot: plan.gate_root, source: plan.node_modules.source });
  steps.push({ ...link, action: "link_node_modules", exit_code: 0 });

  // 3. build (npm install + npm run build). npm install turns the symlink into
  //    a real directory, so re-establish the owned symlink afterwards.
  log(`[3/4] ${buildCommand} in ${plan.gate_root}`);
  const build = spawnSync(buildCommand, buildArgs, {
    cwd: plan.gate_root,
    encoding: "utf8",
    shell: false,
    maxBuffer: 256 * 1024 * 1024,
  });
  const buildLog = `${build.stdout ?? ""}${build.stderr ?? ""}`;
  steps.push({
    action: "build",
    argv: [buildCommand, ...buildArgs],
    cwd: plan.gate_root,
    exit_code: build.status,
    log: buildLog,
  });
  if (build.status !== 0) {
    throw new GateProvisionError(
      "GATE_BUILD_FAILED",
      `${buildCommand} failed (${build.status}):\n${buildLog.slice(-4000)}`,
    );
  }
  const relink = linkGateNodeModules({ gateRoot: plan.gate_root, source: plan.node_modules.source });
  steps.push({ ...relink, action: "link_node_modules_post_build", exit_code: 0 });

  // 4. verify the artifacts later gates depend on.
  log(`[4/4] verify ${EXPECTED_BUILD_ARTIFACTS.join(", ")}`);
  const artifacts = EXPECTED_BUILD_ARTIFACTS.map((rel) => {
    const abs = path.join(plan.gate_root, rel);
    const artifactExists = fs.existsSync(abs);
    if (!artifactExists) {
      throw new GateProvisionError("GATE_ARTIFACT_MISSING", `build artifact missing after build: ${abs}`);
    }
    return { rel, path: abs, exists: true };
  });
  steps.push({ action: "verify_artifacts", exit_code: 0, artifacts });

  const head = git(["-C", plan.gate_root, "rev-parse", "HEAD"]);
  const report = {
    kind: REPORT_KIND,
    schema_version: REPORT_SCHEMA_VERSION,
    provisioned_at: startedAt,
    finished_at: new Date().toISOString(),
    label: label ?? null,
    gate_root: plan.gate_root,
    tip: plan.tip,
    head: head.status === 0 ? head.stdout.trim() : null,
    run_worktree: plan.run_worktree,
    real_state_prefix: plan.real_state_prefix,
    guard_safe: !isUnderRealState(plan.gate_root),
    worktree_added: !exists,
    node_modules: {
      source: plan.node_modules.source,
      target: plan.node_modules.target,
      symlink: fs.existsSync(plan.node_modules.target) && fs.lstatSync(plan.node_modules.target).isSymbolicLink(),
      available: fs.existsSync(plan.node_modules.target),
    },
    build: { command: buildCommand, exit_code: 0, log: buildLog },
    artifacts,
    steps,
  };
  report.ok = validateGateWorktreeProvisionReport(report).ok;

  if (resultsDir) {
    fs.mkdirSync(resultsDir, { recursive: true });
    const safeLabel = label ? `${label.replace(/[^A-Za-z0-9_.-]/g, "_")}-` : "";
    const outDir = fs.mkdtempSync(path.join(resultsDir, `gate-worktree-provision-${safeLabel}${timestamp()}.`));
    report.report_path = path.join(outDir, "provision-report.json");
    fs.writeFileSync(report.report_path, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(outDir, "build.log"), buildLog);
  }
  return report;
}

/**
 * Validate a provisioning report (the retained artifact) against the pinned
 * contract. Returns `{ ok, problems }`; never throws.
 */
export function validateGateWorktreeProvisionReport(report, { realStatePrefix = REAL_TAMANDUA_STATE_PREFIX } = {}) {
  const problems = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, problems: ["report is not an object"] };
  }
  if (report.kind !== REPORT_KIND) problems.push(`kind must be ${REPORT_KIND}`);
  if (report.schema_version !== REPORT_SCHEMA_VERSION) {
    problems.push(`schema_version must be ${REPORT_SCHEMA_VERSION}`);
  }
  if (typeof report.gate_root !== "string" || !path.isAbsolute(report.gate_root)) {
    problems.push("gate_root must be an absolute path");
  } else if (isUnderRealState(report.gate_root, { realStatePrefix })) {
    problems.push(`gate_root ${report.gate_root} is under the real tamandua state prefix`);
  }
  if (report.guard_safe !== true) problems.push("guard_safe must be true");
  if (typeof report.tip !== "string" || !HEX_TIP.test(report.tip)) {
    problems.push("tip must be a 7-40 character hex commit");
  }
  if (report.head !== null && (typeof report.head !== "string" || !/^[0-9a-f]{40}$/.test(report.head))) {
    problems.push("head must be a full 40-character hex commit or null");
  }
  if (!report.build || report.build.exit_code !== 0) problems.push("build must have exited 0");
  if (!report.node_modules || report.node_modules.symlink !== true) {
    problems.push("node_modules must be a symlink to the run worktree's node_modules");
  }
  const artifacts = Array.isArray(report.artifacts) ? report.artifacts : [];
  for (const rel of EXPECTED_BUILD_ARTIFACTS) {
    const artifact = artifacts.find((entry) => entry && entry.rel === rel);
    if (!artifact) problems.push(`artifacts must include ${rel}`);
    else if (artifact.exists !== true) problems.push(`artifact ${rel} must exist`);
  }
  const actions = (Array.isArray(report.steps) ? report.steps : []).map((step) => step && step.action);
  for (const required of ["ensure_worktree", "link_node_modules", "build", "verify_artifacts"]) {
    if (!actions.includes(required)) problems.push(`steps must include ${required}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Default retained-report locations (newest first) for the live self-test. */
export function defaultProvisionReportCandidates({
  gateRoot = DEFAULT_GATE_WORKTREE_ROOT,
  env = process.env,
} = {}) {
  const candidates = [];
  if (env.TAMANDUA_GATE_PROVISION_REPORT) candidates.push(path.resolve(env.TAMANDUA_GATE_PROVISION_REPORT));
  const resultsBase = path.join(gateRoot, "torture-test", "var", "results");
  try {
    const dirs = fs
      .readdirSync(resultsBase)
      .filter((name) => name.startsWith("gate-worktree-provision-"))
      .map((name) => path.join(resultsBase, name, "provision-report.json"))
      .filter((candidate) => fs.existsSync(candidate))
      .map((candidate) => ({ candidate, mtime: fs.statSync(candidate).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    candidates.push(...dirs.map((entry) => entry.candidate));
  } catch {
    /* no retained reports */
  }
  return candidates;
}

/**
 * Read-only inspection of a live gate worktree: guard safety, git-worktree
 * linkage, node_modules availability and the build artifacts. Returns
 * `{ ok, problems, ... }`; never throws for a missing root.
 */
export function inspectGateWorktree({
  gateRoot = DEFAULT_GATE_WORKTREE_ROOT,
  runWorktree = REPO_ROOT,
  realStatePrefix = REAL_TAMANDUA_STATE_PREFIX,
} = {}) {
  const resolvedGate = path.resolve(gateRoot);
  const problems = [];
  const guardSafe = !isUnderRealState(resolvedGate, { realStatePrefix });
  if (!guardSafe) problems.push(`gate root is under the real tamandua state prefix: ${resolvedGate}`);
  const exists = fs.existsSync(resolvedGate);
  if (!exists) problems.push(`gate root does not exist: ${resolvedGate}`);
  let head = null;
  let isWorktree = false;
  if (exists) {
    const inside = git(["-C", resolvedGate, "rev-parse", "--is-inside-work-tree"]);
    isWorktree = inside.status === 0 && inside.stdout.trim() === "true";
    if (!isWorktree) problems.push(`gate root is not a git worktree: ${resolvedGate}`);
    const headResult = git(["-C", resolvedGate, "rev-parse", "HEAD"]);
    if (headResult.status === 0 && /^[0-9a-f]{40}$/.test(headResult.stdout.trim())) {
      head = headResult.stdout.trim();
    } else {
      problems.push(`cannot resolve gate worktree HEAD: ${headResult.stderr.trim()}`);
    }
  }
  let symlink = false;
  let available = false;
  let nodeModulesSource = null;
  const nodeModules = path.join(resolvedGate, "node_modules");
  try {
    const stat = fs.lstatSync(nodeModules);
    symlink = stat.isSymbolicLink();
    if (symlink) nodeModulesSource = fs.readlinkSync(nodeModules);
    available = true;
  } catch {
    problems.push(`node_modules is missing: ${nodeModules}`);
  }
  if (available && runWorktree && !symlink) {
    // A real npm-installed node_modules is still "available", but record it.
    nodeModulesSource = null;
  }
  const artifacts = EXPECTED_BUILD_ARTIFACTS.map((rel) => {
    const abs = path.join(resolvedGate, rel);
    const artifactExists = fs.existsSync(abs);
    if (!artifactExists) problems.push(`build artifact missing: ${abs}`);
    return { rel, path: abs, exists: artifactExists };
  });
  return {
    kind: "gate-worktree-inspection",
    gate_root: resolvedGate,
    run_worktree: path.resolve(runWorktree),
    real_state_prefix: path.resolve(realStatePrefix),
    guard_safe: guardSafe,
    exists,
    is_worktree: isWorktree,
    head,
    node_modules: { path: nodeModules, symlink, available, source: nodeModulesSource },
    artifacts,
    ok: problems.length === 0,
    problems,
  };
}

function parseArgs(argv) {
  const args = {
    gateRoot: DEFAULT_GATE_WORKTREE_ROOT,
    runWorktree: REPO_ROOT,
    tip: null,
    resultsDir: null,
    label: null,
    verifyOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new GateProvisionError("GATE_CLI_USAGE", `${flag} requires a value`);
      return argv[i];
    };
    if (flag === "--gate-root") args.gateRoot = next();
    else if (flag === "--run-worktree") args.runWorktree = next();
    else if (flag === "--tip") args.tip = next();
    else if (flag === "--results-dir") args.resultsDir = next();
    else if (flag === "--label") args.label = next();
    else if (flag === "--verify-only") args.verifyOnly = true;
    else if (flag === "--help" || flag === "-h") {
      process.stdout.write(
        "usage: gate-worktree-provision.mjs [--gate-root DIR] [--run-worktree DIR] --tip SHA [--results-dir DIR] [--label L] [--verify-only]\n",
      );
      process.exit(0);
    } else {
      throw new GateProvisionError("GATE_CLI_USAGE", `unknown argument: ${flag}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.verifyOnly) {
    const inspection = inspectGateWorktree({ gateRoot: args.gateRoot, runWorktree: args.runWorktree });
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
    process.exit(inspection.ok ? 0 : 1);
  }
  const report = provisionGateWorktree(args);
  process.stdout.write(
    `gate worktree provisioned: ${report.gate_root} @ ${report.head} (guard_safe=${report.guard_safe}, symlink=${report.node_modules.symlink})\n`,
  );
  if (report.report_path) process.stdout.write(`provision report: ${report.report_path}\n`);
  process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`gate-worktree-provision: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
