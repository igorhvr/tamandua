#!/usr/bin/env node
/**
 * torture-port-verify.mjs — validators for the TORTURE-PORT contract.
 *
 * This file is a port-owned artifact (matches torture-test/impl-tasks/torture-port-*)
 * and is intentionally independent of the product tree: it only reads the
 * committed contract mirror and, when available, the pinned git refs.
 *
 * Usage:
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check contract
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check contract --contract <path>
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check overlay
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check environment
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check aged
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check o12
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check storm
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check core-recording
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check self-tests-alone
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check storm-chain
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check battery
 *   node torture-test/impl-tasks/torture-port-verify.mjs --check product-suite
 *
 * `--check contract` runs the positive validation AND its red arms (a red arm
 * deliberately corrupts a copy of the contract and asserts the validator
 * rejects it). The process exits 0 only when the positive validation passes
 * and every red arm behaves as expected.
 *
 * `--check overlay` proves the torture tree was overlaid wholesale from
 * refs/remotes/src/torture (US-002): the only torture-test paths allowed to
 * differ from the source ref are the port's own torture-test/impl-tasks/
 * torture-port-* artifacts and the paths named by the contract's recorded
 * `adaptations`; no path outside torture-test/ may differ from BASE 6e5f2427;
 * and the 9 base-only paths dropped by the overlay must be absent. A recorded
 * adaptation that no longer differs from SRC is a stale-allowlist error. Its
 * red arms mutate a snapshot of the observed git state so no repository state
 * is harmed.
 *
 * `--check environment` proves the US-003 gate-environment readiness receipt:
 * node/npm, all five fixture toolchains with build+test evidence, the >=60 GiB
 * disk headroom, the tt-verify-environment counts (zero FAIL), the build and
 * check-test-syntax exit codes, and both retained fast-smoke logs on disk. Its
 * red arms mutate a copy of the receipt so no evidence is harmed.
 *
 * `--check aged` proves the US-004 aged/seed adaptation: the O12 CONTENT pin is
 * unchanged, the O12 provenance commit and the committed readiness pointer's
 * source commit resolve to real commits with the recorded subject/tree, and any
 * commit that is not an ancestor of the schema-13 product HEAD is explicitly
 * declared pre-port legacy. It also live-checks that all four aged self-tests
 * recorded exit 0 with retained non-empty logs. Its red arms mutate a snapshot
 * of the collected state so no repository state is harmed.
 *
 * `--check o12` proves the US-005 O12 oracle adaptation: the embedded CONTENT
 * pin equals a LIVE recomputation over the current tree (a re-pin, if ever
 * needed, uses computeO12OracleContentHash and never a commit id), all eight
 * documented O12 entries recorded exit 0 ALONE under the gate env, and the gate
 * runner's fixture matrix is 78/78 all_match with snapshot immutability ok and
 * every correction case green. It also live-checks the retained per-entry logs
 * and the retained gate summary JSON.
 *
 * `--check storm` proves the US-007 storm orchestrator/execution adaptation:
 * the focused storm-machinery self-tests (every non-e2e storm rehearsal/unit
 * test plus the new base-seam conformance test) each recorded exit 0 with no
 * failing test, the base-seam conformance entry is present with a positive test
 * count, no product file differs from BASE 6e5f2427, and the US-007 adaptations
 * are recorded. It live-checks every retained per-file log. Its red arms mutate
 * a copy of the receipt so no evidence is harmed.
 *
 * `--check core-recording` proves the US-008 core-recording/scripted-runtime
 * adaptation: all 18 `tier0-core-recording-*` + `scripted-runtime-*` self-tests
 * recorded exit 0 with no failing test, the four pre-fix red entries are
 * present and green, the ported runtimes carry the base seams they track (dsh
 * v3 session format; pi `stream-die-before-claim`), the US-008 adaptations are
 * recorded, and no product file differs from BASE 6e5f2427. It live-checks
 * every retained per-file log and the seam markers. Its red arms mutate a copy
 * of the receipt so no evidence is harmed.
 *
 * `--check self-tests-alone` proves the US-009 self-tests-alone gate: the
 * retained `self-tests-alone-summary.json` reports 14/14 required entries exit
 * 0 (npf2 2, aged 4, o12 8) plus the informational qualification entry, with
 * `guard_safe_repo_root` true, and the live summary revalidates through the
 * gate's own `validateSelfTestsAloneSummary`. It live-checks the retained
 * summary file and every per-entry stdout/stderr log on disk and that no
 * product file differs from BASE 6e5f2427. Its red arms mutate a copy of the
 * receipt so no evidence is harmed.
 *
 * `--check storm-chain` proves the US-010 49-file storm chain gate: the retained
 * `chain-summary.json` reports the frozen 49-file selection all exit 0 with zero
 * red files, a PASS verdict, the run #7 chain-files byte match, and the lock
 * submit/acquire/release evidence; the live summary revalidates through the
 * chain gate's own `validateChainSummary`, the receipt totals equal the summary
 * totals, the retained per-run artifacts (chain-files.txt, results.tsv,
 * chain-report.md, lock fingerprints, scripts) are present with a 50-line
 * results.tsv, and no product file differs from BASE 6e5f2427. Its red arms
 * mutate a copy of the receipt so no evidence is harmed.
 *
 * `--check battery` proves the US-011 full torture battery gate (the exact
 * `bash torture-test/self-tests/run.sh` outcome, the same battery machinery the
 * pre-arm-gate runners use): the retained battery log reports every non-heavy
 * self-test file PASS with 0 failed and exactly the frozen heavy-campaign
 * exclusions, the receipt's observed counts equal the selection derived live
 * from the tree (globs minus `HEAVY_CAMPAIGN_TESTS`), and every difference from
 * the recorded previous green shape (240 passed / 0 failed / 18 excluded at
 * bc535a44) is enumerated file by file. It live-checks the retained full log,
 * the machine-readable summary, the retained artifacts, and that no product
 * file differs from BASE 6e5f2427. Its red arms mutate a copy of the receipt so
 * no evidence is harmed.
 *
 * `--check product-suite` proves the US-012 product gate: `npm run build` exited
 * 0 and the two-lane product unit suite (`npm test` through the tamandua-test
 * shim) exited 0 with both lanes PASSED and the frozen per-lane counts
 * (serial 4986/4972/0/14, parallel 4110/4105/0/5). When the shim replayed a
 * cached result, the receipt must point at the real green execution that
 * produced it. It live-checks the retained gate log (build/test/overall exit
 * codes, both lane verdicts, cache banner + tree-hash prefix when cached), the
 * recorded per-lane counts against the log, and that no product file differs
 * from BASE 6e5f2427. Its red arms mutate a copy of the receipt so no evidence
 * is harmed.
 *
 * `--check gates` proves the US-013 final contract: every port gate result
 * (US-003..US-012) is recorded with `result: PASS`, the four headline gates keep
 * their counts (self-tests-alone 14/14 with zero red files, storm chain 49 files
 * / 0 red, battery 0 failed with 18 heavy exclusions, product build + both unit
 * lanes green with the frozen counts), and the contract's `finalScopeAudit`
 * agrees with a live `git diff --name-only 6e5f2427 -- . ':(exclude)torture-test'`
 * that must be empty. Its red arms mutate a copy of `gateResults` (including a
 * missing-gate-result arm) so no evidence is harmed.
 *
 * `--check all` runs every check above (contract through gates) in order and
 * exits 0 only when all of them pass, so a single invocation proves the whole
 * TORTURE-PORT deliverable.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateSelfTestsAloneSummary } from "../self-tests/self-tests-alone-report.mjs";
import {
  EXPECTED_CHAIN_FILE_COUNT,
  validateChainSummary,
} from "../self-tests/storm-chain-report.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..");
export const DEFAULT_CONTRACT = path.join(
  REPO_ROOT,
  "torture-test",
  "impl-tasks",
  "torture-port-contract.json",
);

const MERGE_BASE = "12c53f59";
const BASE_REF = "6e5f2427";
const SRC_REF = "refs/remotes/src/torture";
const EXPECTED_PATH_COUNT = 213;
const DECISIONS = new Set(["a", "b", "c"]);

/**
 * The overlay-equality check exempts the port's own artifacts: every path under
 * torture-test/impl-tasks/ named torture-port-* is authored by this port and is
 * intentionally absent from refs/remotes/src/torture.
 */
const PORT_ARTIFACT_PREFIX = "torture-test/impl-tasks/torture-port-";

/**
 * Base-only paths the US-002 overlay drops so torture-test/** matches SRC
 * exactly. Rationale is recorded in the contract (overlay.droppedFiles).
 */
export const DROPPED_PATHS = [
  "torture-test/fixtures-src/tt-poly-lite/python/.gitignore",
  "torture-test/fixtures-src/tt-poly-lite/ts/.gitignore",
  "torture-test/fixtures-src/tt-poly/go/.gitignore",
  "torture-test/fixtures-src/tt-poly/java/.gitignore",
  "torture-test/fixtures-src/tt-poly/python/.gitignore",
  "torture-test/fixtures-src/tt-poly/rust/.gitignore",
  "torture-test/fixtures-src/tt-poly/ts/.gitignore",
  "torture-test/impl-tasks/skill-ux-contract.json",
  "torture-test/self-tests/tier1-daemon-control-bounded-lsof.test.ts",
];

/** BASE -> SRC torture-test name-status inventory (US-002). */
const EXPECTED_OVERLAY = { added: 190, modified: 44, dropped: 9 };

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  }).trim();
}

/** Enumerate the 213 outside paths from the pinned refs, else from the contract. */
export function expectedOutsidePaths(contract) {
  try {
    const out = git(["diff", "--name-only", MERGE_BASE, SRC_REF]);
    const paths = out
      .split("\n")
      .filter(Boolean)
      .filter((p) => !p.startsWith("torture-test/"));
    if (paths.length > 0) return { paths, source: `git diff --name-only ${MERGE_BASE} ${SRC_REF}` };
  } catch {
    /* fall through to the contract inventory */
  }
  const stored = contract?.inventory?.sourcePaths;
  if (Array.isArray(stored) && stored.length > 0) {
    return { paths: stored.slice(), source: "contract.inventory.sourcePaths (git refs unavailable)" };
  }
  return { paths: [], source: "unavailable" };
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Pure validation of a contract object. Returns a list of human-readable
 * errors; an empty list means the contract is well-formed.
 */
export function validateContract(contract, expectedPaths, opts = {}) {
  const errors = [];
  const label = opts.label ?? "contract";

  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    return [`${label}: root must be a JSON object`];
  }
  if (contract.kind !== "torture-port-contract") {
    errors.push(`${label}: kind must be "torture-port-contract" (got ${JSON.stringify(contract.kind)})`);
  }
  if (!contract.inventory || typeof contract.inventory !== "object") {
    errors.push(`${label}: missing inventory object`);
  }
  if (!Array.isArray(contract.groups) || contract.groups.length === 0) {
    errors.push(`${label}: missing non-empty groups array`);
  }
  if (!Array.isArray(contract.outsideFiles)) {
    errors.push(`${label}: missing outsideFiles array`);
  }
  // The final deliverable (US-013) must carry the adaptation table, the Igor
  // findings and the per-story gate results alongside the outside-files table.
  if (!Array.isArray(contract.adaptations) || contract.adaptations.length === 0) {
    errors.push(`${label}: missing non-empty adaptations array`);
  }
  if (!Array.isArray(contract.findings)) {
    errors.push(`${label}: missing findings array`);
  }
  if (
    !contract.gateResults ||
    typeof contract.gateResults !== "object" ||
    Array.isArray(contract.gateResults)
  ) {
    errors.push(`${label}: missing gateResults object`);
  }
  if (
    !contract.finalScopeAudit ||
    typeof contract.finalScopeAudit !== "object" ||
    Array.isArray(contract.finalScopeAudit)
  ) {
    errors.push(`${label}: missing finalScopeAudit object`);
  }

  const groupNames = new Set();
  const groups = Array.isArray(contract.groups) ? contract.groups : [];
  for (const [i, g] of groups.entries()) {
    const where = `${label}: groups[${i}]${g && g.name ? ` (${g.name})` : ""}`;
    if (!g || typeof g !== "object") {
      errors.push(`${where}: not an object`);
      continue;
    }
    if (!isNonEmptyString(g.name)) errors.push(`${where}: missing name`);
    if (!isNonEmptyString(g.scope)) errors.push(`${where}: missing scope`);
    if (!DECISIONS.has(g.decision)) {
      errors.push(`${where}: decision must be one of a|b|c (got ${JSON.stringify(g.decision)})`);
    }
    if (!isNonEmptyString(g.evidence)) {
      errors.push(`${where}: missing evidence naming the base commit(s)`);
    }
    if (typeof g.fileCount !== "number" || !Number.isFinite(g.fileCount)) {
      errors.push(`${where}: missing numeric fileCount`);
    }
    if (g.name) {
      if (groupNames.has(g.name)) errors.push(`${where}: duplicate group name`);
      groupNames.add(g.name);
    }
  }
  // (b) seams must be recorded as an Igor finding.
  const findings = Array.isArray(contract.findings) ? contract.findings : [];
  for (const [i, g] of groups.entries()) {
    if (g && g.decision === "b") {
      const recorded = findings.some(
        (f) => f && (f.group === g.name || (isNonEmptyString(f.seam) && f.seam.length > 0)),
      );
      if (!recorded) {
        errors.push(
          `${label}: groups[${i}] (${g.name}) is decision b but no matching finding (group/seam) is recorded`,
        );
      }
    }
  }

  const files = Array.isArray(contract.outsideFiles) ? contract.outsideFiles : [];
  const seen = new Set();
  for (const [i, f] of files.entries()) {
    const where = `${label}: outsideFiles[${i}]${f && f.path ? ` (${f.path})` : ""}`;
    if (!f || typeof f !== "object") {
      errors.push(`${where}: not an object`);
      continue;
    }
    if (!isNonEmptyString(f.path)) {
      errors.push(`${where}: missing path`);
    } else if (seen.has(f.path)) {
      errors.push(`${where}: duplicate path`);
    } else {
      seen.add(f.path);
    }
    if (!isNonEmptyString(f.group)) {
      errors.push(`${where}: missing group`);
    } else if (!groupNames.has(f.group)) {
      errors.push(`${where}: group ${JSON.stringify(f.group)} is not declared in groups[]`);
    }
    if (!DECISIONS.has(f.decision)) {
      errors.push(`${where}: decision must be one of a|b|c (got ${JSON.stringify(f.decision)})`);
    } else if (isNonEmptyString(f.group)) {
      const g = groups.find((x) => x && x.name === f.group);
      if (g && DECISIONS.has(g.decision) && g.decision !== f.decision) {
        errors.push(`${where}: decision ${f.decision} disagrees with group ${f.group} decision ${g.decision}`);
      }
    }
  }

  // Every expected path accounted for, exactly once, and no extras.
  const expected = new Set(expectedPaths);
  for (const p of expected) {
    if (!seen.has(p)) errors.push(`${label}: path not accounted for: ${p}`);
  }
  for (const p of seen) {
    if (!expected.has(p)) errors.push(`${label}: unexpected path not in the pinned inventory: ${p}`);
  }

  // Inventory self-consistency.
  if (contract.inventory && typeof contract.inventory === "object") {
    const sp = contract.inventory.sourcePaths;
    if (Array.isArray(sp)) {
      const spSet = new Set(sp);
      if (spSet.size !== expected.size) {
        errors.push(
          `${label}: inventory.sourcePaths has ${spSet.size} unique paths, expected ${expected.size}`,
        );
      }
      for (const p of sp) if (!seen.has(p)) errors.push(`${label}: inventory.sourcePaths path not in outsideFiles: ${p}`);
      for (const p of seen) if (!spSet.has(p)) errors.push(`${label}: outsideFiles path not in inventory.sourcePaths: ${p}`);
    } else {
      errors.push(`${label}: inventory.sourcePaths must be an array`);
    }
    if (contract.inventory.pathCount !== expected.size) {
      errors.push(
        `${label}: inventory.pathCount ${contract.inventory.pathCount} != expected ${expected.size}`,
      );
    }
  }

  // Launcher section.
  const launcher = contract.launcher;
  if (!launcher || typeof launcher !== "object") {
    errors.push(`${label}: missing launcher section`);
  } else {
    if (!isNonEmptyString(launcher.required_additional)) {
      errors.push(`${label}: launcher.required_additional must be a non-empty string (use "none")`);
    }
    const rtt = launcher.run_torture_test;
    if (!rtt || typeof rtt !== "object") {
      errors.push(`${label}: launcher.run_torture_test missing`);
    } else {
      if (rtt.present_on_base !== true) {
        errors.push(`${label}: launcher.run_torture_test.present_on_base must be true`);
      }
      if (rtt.identical_to_src !== true) {
        errors.push(`${label}: launcher.run_torture_test.identical_to_src must be true`);
      }
    }
  }

  return errors;
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Red arms: each mutates a valid contract and must produce at least one error.
 * Returns a list of {name, ok, detail}.
 */
export function runContractRedArms(contract, expectedPaths) {
  const arms = [];
  const firstFile = contract.outsideFiles?.[0];

  const add = (name, mutate, predicate) => {
    const copy = clone(contract);
    mutate(copy);
    const errors = validateContract(copy, expectedPaths, { label: "red-arm:" + name });
    const matched = predicate ? errors.some(predicate) : errors.length > 0;
    arms.push({ name, ok: matched, detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)" });
  };

  add("missing-decision", (c) => {
    delete c.groups[0].decision;
  });
  add("invalid-decision", (c) => {
    c.groups[0].decision = "z";
  });
  add("missing-evidence", (c) => {
    delete c.groups[0].evidence;
  });
  add("missing-group", (c) => {
    c.outsideFiles[0].group = "no-such-group";
  });
  add("unaccounted-path", (c) => {
    const p = c.outsideFiles[0].path;
    c.outsideFiles = c.outsideFiles.filter((f) => f.path !== p);
    c.inventory.sourcePaths = c.inventory.sourcePaths.filter((x) => x !== p);
    c.inventory.pathCount = c.inventory.pathCount - 1;
  });
  add("extra-path", (c) => {
    c.outsideFiles.push({ path: "src/not/in/the/inventory.ts", group: c.groups[0].name, decision: c.groups[0].decision });
  });
  add("duplicate-path", (c) => {
    c.outsideFiles.push(clone(c.outsideFiles[0]));
    c.inventory.sourcePaths.push(c.inventory.sourcePaths[0]);
  });
  add("missing-launcher", (c) => {
    delete c.launcher;
  });
  add("launcher-not-on-base", (c) => {
    c.launcher.run_torture_test.present_on_base = false;
  });
  if (firstFile) {
    add("file-decision-mismatch", (c) => {
      c.outsideFiles[0].decision = c.outsideFiles[0].decision === "a" ? "c" : "a";
    });
  }
  return arms;
}

/**
 * True when a torture-test path is one of the port's own artifacts.
 */
export function isPortArtifact(p) {
  return typeof p === "string" && p.startsWith(PORT_ARTIFACT_PREFIX);
}

/**
 * The port's recorded, deliberate adaptations to the SRC torture tree. The
 * overlay check accepts a torture-test path that differs from SRC only when it
 * is a port artifact OR is named by one of these adaptations; the approved set
 * is read from the contract (see `adaptedPathsFromContract`).
 */
export function adaptedPathsFromContract(contract) {
  const paths = [];
  const adaptations = Array.isArray(contract?.adaptations) ? contract.adaptations : [];
  for (const a of adaptations) {
    if (!a || !Array.isArray(a.paths)) continue;
    for (const p of a.paths) {
      if (typeof p === "string" && p.startsWith("torture-test/") && !paths.includes(p)) paths.push(p);
    }
  }
  return paths;
}

/**
 * Pure validator for the US-002 overlay state. `state` has:
 *   overlayDiffPaths    torture-test paths differing from SRC_REF
 *   extraTorturePaths   untracked (non-ignored) torture-test paths
 *   nonTortureDiffPaths paths outside torture-test/ differing from BASE_REF
 *   presentDroppedPaths dropped paths that still exist on disk
 * An empty error list means the torture tree matches SRC apart from the port's
 * own artifacts and its recorded adaptations, no product path moved, and every
 * dropped path is gone. When `opts.requireAdaptedDiffs` is set, every recorded
 * adaptation must actually differ from SRC (a stale allowlist is an error).
 */
export function validateOverlay(state, opts = {}) {
  const label = opts.label ?? "overlay";
  const errors = [];
  const adaptedPaths = new Set(Array.isArray(opts.adaptedPaths) ? opts.adaptedPaths : []);
  const overlayDiffPaths = Array.isArray(state?.overlayDiffPaths) ? state.overlayDiffPaths : [];
  const extraTorturePaths = Array.isArray(state?.extraTorturePaths) ? state.extraTorturePaths : [];
  const nonTortureDiffPaths = Array.isArray(state?.nonTortureDiffPaths) ? state.nonTortureDiffPaths : [];
  const presentDroppedPaths = Array.isArray(state?.presentDroppedPaths) ? state.presentDroppedPaths : [];

  for (const p of overlayDiffPaths) {
    if (!isPortArtifact(p) && !adaptedPaths.has(p)) {
      errors.push(`${label}: torture-test path differs from ${SRC_REF} and is not a port artifact or recorded adaptation: ${p}`);
    }
  }
  for (const p of extraTorturePaths) {
    if (!isPortArtifact(p) && !adaptedPaths.has(p)) {
      errors.push(`${label}: untracked torture-test path is not in ${SRC_REF} and is not a recorded adaptation: ${p}`);
    }
  }
  for (const p of nonTortureDiffPaths) {
    errors.push(`${label}: path outside torture-test/ differs from BASE ${BASE_REF}: ${p}`);
  }
  for (const p of presentDroppedPaths) {
    errors.push(`${label}: dropped base-only path is still present: ${p}`);
  }
  if (opts.requireAdaptedDiffs) {
    const diffSet = new Set(overlayDiffPaths);
    for (const p of adaptedPaths) {
      if (!diffSet.has(p)) {
        errors.push(`${label}: recorded adaptation does not differ from ${SRC_REF} (stale allowlist entry): ${p}`);
      }
    }
  }
  return errors;
}

/** Collect the live overlay state from git plus the filesystem. */
export function collectOverlayState() {
  const overlayDiffPaths = git(["diff", "--name-only", SRC_REF, "--", "torture-test"])
    .split("\n")
    .filter(Boolean);
  const extraTorturePaths = git(["ls-files", "--others", "--exclude-standard", "--", "torture-test"])
    .split("\n")
    .filter(Boolean);
  const nonTortureDiffPaths = git([
    "diff",
    "--name-only",
    BASE_REF,
    "--",
    ".",
    ":(exclude)torture-test",
  ])
    .split("\n")
    .filter(Boolean);
  const presentDroppedPaths = DROPPED_PATHS.filter((p) => fs.existsSync(path.join(REPO_ROOT, p)));
  return { overlayDiffPaths, extraTorturePaths, nonTortureDiffPaths, presentDroppedPaths };
}

/** BASE -> SRC name-status inventory for torture-test/** (from the pinned refs). */
export function refOverlayInventory() {
  const lines = git(["diff", "--name-status", BASE_REF, SRC_REF, "--", "torture-test"])
    .split("\n")
    .filter(Boolean);
  const inv = { added: 0, modified: 0, dropped: 0, other: 0 };
  for (const line of lines) {
    const status = line.split("\t")[0];
    if (status === "A") inv.added += 1;
    else if (status === "M") inv.modified += 1;
    else if (status === "D") inv.dropped += 1;
    else inv.other += 1;
  }
  return inv;
}

/**
 * Red arms for the overlay validator. Every arm must be rejected except the
 * `port-artifacts-exempt` control, which must be accepted (so a validator that
 * simply rejects everything fails the suite).
 */
export function runOverlayRedArms(state, opts = {}) {
  const arms = [];
  const adaptedPaths = Array.isArray(opts.adaptedPaths) ? opts.adaptedPaths : [];
  const add = (name, mutate, extraOpts = {}) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateOverlay(copy, { label: "red-arm:" + name, adaptedPaths, ...extraOpts });
    arms.push({
      name,
      ok: errors.length > 0,
      detail: errors.length > 0 ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("src-torture-drift", (s) => {
    s.overlayDiffPaths = [...s.overlayDiffPaths, "torture-test/self-tests/not-in-src.test.ts"];
  });
  add("untracked-torture-drift", (s) => {
    s.extraTorturePaths = [...s.extraTorturePaths, "torture-test/self-tests/untracked.test.ts"];
  });
  add("product-path-drift", (s) => {
    s.nonTortureDiffPaths = [...s.nonTortureDiffPaths, "src/server/db.ts"];
  });
  add("dropped-path-present", (s) => {
    s.presentDroppedPaths = [...s.presentDroppedPaths, DROPPED_PATHS[0]];
  });
  add("stale-adaptation-allowlist", (s) => {
    s.overlayDiffPaths = s.overlayDiffPaths.filter((p) => p !== adaptedPaths[0]);
  }, { requireAdaptedDiffs: true });

  // Negative control: only the port's own artifacts may differ.
  {
    const copy = clone(state);
    copy.overlayDiffPaths = ["torture-test/impl-tasks/torture-port-contract.json"];
    copy.extraTorturePaths = [];
    copy.nonTortureDiffPaths = [];
    copy.presentDroppedPaths = [];
    const errors = validateOverlay(copy, { label: "green-arm:port-artifacts-exempt", adaptedPaths });
    arms.push({
      name: "port-artifacts-exempt",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }

  // Negative control: the recorded adaptations may differ from SRC.
  if (adaptedPaths.length > 0) {
    const copy = clone(state);
    copy.overlayDiffPaths = [...adaptedPaths];
    copy.extraTorturePaths = [];
    copy.nonTortureDiffPaths = [];
    copy.presentDroppedPaths = [];
    const errors = validateOverlay(copy, {
      label: "green-arm:recorded-adaptation-exempt",
      adaptedPaths,
      requireAdaptedDiffs: true,
    });
    arms.push({
      name: "recorded-adaptation-exempt",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}

/**
 * US-003: the fixture toolchains the torture environment gate requires. Each
 * must be recorded in the environment receipt with presence + build/test
 * evidence; presence is a fact (a host may lack one), but when present the
 * fixture build/test probes must have passed.
 */
export const REQUIRED_FIXTURE_TOOLCHAINS = ["node", "python3", "go", "rust/cargo", "java+maven"];

/** The two fast torture smokes US-003 must run and retain. */
export const REQUIRED_SMOKES = ["o12-content-pin", "o12-schema-version"];

/**
 * Pure validation of the US-003 environment receipt recorded in the contract.
 *
 * Required shape (see the contract's `environmentReceipt`):
 *   node, npm, inlet_temperature        non-empty strings
 *   fixture_toolchains                  { <name>: { present, version, buildPassed?, testPassed? } }
 *   all_fixture_toolchains_present      boolean, equals the derived all-present fact
 *   disk_headroom                       { availableBytes, thresholdBytes, ok }
 *   verify_environment                  { exit_code: 0, counts: { pass, fail: 0, skipped, total } }
 *   build / check_test_syntax           { exit_code: 0 }
 *   smoke_tests                         one entry per REQUIRED_SMOKES with exit_code 0 + log path
 */
export function validateEnvironmentReceipt(receipt, opts = {}) {
  const errors = [];
  const label = opts.label ?? "environment";
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return [`${label}: environmentReceipt must be a JSON object`];
  }
  for (const key of ["node", "npm", "inlet_temperature"]) {
    if (!isNonEmptyString(receipt[key])) errors.push(`${label}: missing non-empty ${key}`);
  }

  const fixture = receipt.fixture_toolchains;
  if (!fixture || typeof fixture !== "object" || Array.isArray(fixture)) {
    errors.push(`${label}: fixture_toolchains must be an object`);
  } else {
    for (const name of REQUIRED_FIXTURE_TOOLCHAINS) {
      const t = fixture[name];
      if (!t || typeof t !== "object" || Array.isArray(t)) {
        errors.push(`${label}: fixture_toolchains.${name} missing`);
        continue;
      }
      if (typeof t.present !== "boolean") {
        errors.push(`${label}: fixture_toolchains.${name}.present must be boolean`);
        continue;
      }
      if (!isNonEmptyString(t.version)) errors.push(`${label}: fixture_toolchains.${name}.version missing`);
      if (t.present && t.buildPassed !== true) {
        errors.push(`${label}: fixture_toolchains.${name} is present but buildPassed is not true`);
      }
      if (t.present && t.testPassed !== true) {
        errors.push(`${label}: fixture_toolchains.${name} is present but testPassed is not true`);
      }
    }
    const derivedAll = REQUIRED_FIXTURE_TOOLCHAINS.every(
      (n) => fixture[n] && fixture[n].present === true,
    );
    if (typeof receipt.all_fixture_toolchains_present !== "boolean") {
      errors.push(`${label}: all_fixture_toolchains_present must be boolean`);
    } else if (receipt.all_fixture_toolchains_present !== derivedAll) {
      errors.push(
        `${label}: all_fixture_toolchains_present ${receipt.all_fixture_toolchains_present} != derived ${derivedAll}`,
      );
    }
  }

  const disk = receipt.disk_headroom;
  if (!disk || typeof disk !== "object" || Array.isArray(disk)) {
    errors.push(`${label}: disk_headroom missing`);
  } else {
    if (!Number.isFinite(disk.availableBytes) || disk.availableBytes < 0) {
      errors.push(`${label}: disk_headroom.availableBytes must be a non-negative number`);
    }
    if (!Number.isFinite(disk.thresholdBytes) || disk.thresholdBytes <= 0) {
      errors.push(`${label}: disk_headroom.thresholdBytes must be a positive number`);
    }
    if (typeof disk.ok !== "boolean") {
      errors.push(`${label}: disk_headroom.ok must be boolean`);
    } else {
      const derivedOk =
        Number.isFinite(disk.availableBytes) &&
        Number.isFinite(disk.thresholdBytes) &&
        disk.availableBytes >= disk.thresholdBytes;
      if (disk.ok !== derivedOk) {
        errors.push(`${label}: disk_headroom.ok ${disk.ok} != derived ${derivedOk}`);
      }
      if (!disk.ok) errors.push(`${label}: disk headroom is below the torture env threshold`);
    }
  }

  const ve = receipt.verify_environment;
  if (!ve || typeof ve !== "object" || Array.isArray(ve)) {
    errors.push(`${label}: verify_environment missing`);
  } else {
    if (ve.exit_code !== 0) errors.push(`${label}: verify_environment.exit_code must be 0`);
    const c = ve.counts;
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      errors.push(`${label}: verify_environment.counts missing`);
    } else {
      for (const k of ["pass", "fail", "skipped", "total"]) {
        if (!Number.isFinite(c[k]) || c[k] < 0) {
          errors.push(`${label}: verify_environment.counts.${k} must be a non-negative number`);
        }
      }
      if (c.fail !== 0) errors.push(`${label}: verify_environment has ${c.fail} FAIL check(s)`);
      if (
        Number.isFinite(c.pass) &&
        Number.isFinite(c.fail) &&
        Number.isFinite(c.skipped) &&
        Number.isFinite(c.total) &&
        c.pass + c.fail + c.skipped !== c.total
      ) {
        errors.push(
          `${label}: verify_environment counts do not sum (pass+fail+skipped=${c.pass + c.fail + c.skipped} != total=${c.total})`,
        );
      }
    }
  }

  for (const key of ["build", "check_test_syntax"]) {
    const g = receipt[key];
    if (!g || typeof g !== "object" || Array.isArray(g)) {
      errors.push(`${label}: ${key} missing`);
    } else if (g.exit_code !== 0) {
      errors.push(`${label}: ${key}.exit_code must be 0`);
    }
  }

  const smokes = receipt.smoke_tests;
  if (!Array.isArray(smokes) || smokes.length < REQUIRED_SMOKES.length) {
    errors.push(`${label}: smoke_tests must list the ${REQUIRED_SMOKES.length} fast smokes`);
  } else {
    for (const name of REQUIRED_SMOKES) {
      const s = smokes.find((x) => x && x.name === name);
      if (!s) {
        errors.push(`${label}: smoke_tests missing ${name}`);
        continue;
      }
      if (s.exit_code !== 0) errors.push(`${label}: smoke ${name} exit_code must be 0`);
      if (!isNonEmptyString(s.log)) errors.push(`${label}: smoke ${name} log path missing`);
    }
  }
  return errors;
}

/**
 * Red arms for the environment receipt: each mutation must be rejected. The
 * green control is the unmodified receipt, supplied by the caller.
 */
export function runEnvironmentRedArms(receipt) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(receipt);
    mutate(copy);
    const errors = validateEnvironmentReceipt(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("missing-node", (c) => {
    delete c.node;
  });
  add("missing-toolchain", (c) => {
    delete c.fixture_toolchains.go;
  });
  add("toolchain-not-built", (c) => {
    c.fixture_toolchains.python3.buildPassed = false;
  });
  add("all-present-mismatch", (c) => {
    c.all_fixture_toolchains_present = !c.all_fixture_toolchains_present;
  });
  add("disk-ok-mismatch", (c) => {
    c.disk_headroom.ok = !c.disk_headroom.ok;
  });
  add("verify-fail", (c) => {
    c.verify_environment.counts.fail = 1;
  });
  add("verify-count-mismatch", (c) => {
    c.verify_environment.counts.total += 1;
  });
  add("build-nonzero", (c) => {
    c.build.exit_code = 1;
  });
  add("smoke-nonzero", (c) => {
    c.smoke_tests[0].exit_code = 1;
  });
  add("smoke-missing", (c) => {
    c.smoke_tests = c.smoke_tests.filter((s) => s && s.name !== REQUIRED_SMOKES[1]);
  });
  return arms;
}

/**
 * US-004: the four aged/seed self-tests that must each exit 0 on their own under
 * the gate environment, and the content pin the port must NOT re-pin.
 */
export const AGED_SELF_TESTS = ["aged-core", "origin-pins", "seed-root-copy", "seed-readiness"];
export const EXPECTED_O12_CONTENT_SHA256 =
  "d50275466dcb76a1f809ac2321507ab195dc885be0f8347ae200ea1e9a29d75f";

/**
 * US-005: the eight documented O12 entries that must each exit 0 ALONE under the
 * gate environment, plus the gate runner's fixture-matrix shape (78 fixtures,
 * every one matching, immutable snapshots unchanged).
 */
export const O12_DOCUMENTED_ENTRIES = Object.freeze([
  { name: "o12.test.mjs", kind: "test" },
  { name: "o12-schema-version.test.mjs", kind: "test" },
  { name: "o12-seed-snapshot.test.mjs", kind: "test" },
  { name: "o12-gate-self-tests.test.mjs", kind: "test" },
  { name: "o12-reserved-key-probe.mjs", kind: "probe" },
  { name: "o12-run-number-probe.mjs", kind: "probe" },
  { name: "o12-run-number-allocator-calibration.mjs", kind: "probe" },
  { name: "generate-o12-fixtures.mjs", kind: "generator" },
]);
export const EXPECTED_O12_FIXTURE_COUNT = 78;
export const O12_GATE_RUNNER = "run-o12-gate-self-tests.mjs";

/** git helpers that tolerate a non-zero status (unlike `git`). */
function gitStatus(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitOk(args) {
  try {
    gitStatus(args);
    return true;
  } catch {
    return false;
  }
}

function gitTextOrNull(args) {
  try {
    return gitStatus(args).trim();
  } catch {
    return null;
  }
}

/**
 * Collect the live US-004 aged-adaptation state: the O12 content pin and its
 * declared provenance, plus the committed readiness pointer's source record.
 * All ancestry/subject/tree facts are resolved from git so the validator can
 * reject a stale or rewritten provenance.
 */
export async function collectAgedState() {
  const agedPath = path.join(REPO_ROOT, "torture-test", "aged", "validate.mjs");
  const aged = await import(pathToFileURL(agedPath).href);
  const pointerPath = path.join(REPO_ROOT, "torture-test", "storm-seed-readiness.json");
  const pointer = JSON.parse(fs.readFileSync(pointerPath, "utf8"));
  const src = pointer.source ?? {};
  const prov = aged.O12_PINNED_PROVENANCE_COMMIT;
  return {
    contentPin: aged.O12_PINNED_CONTENT_SHA256,
    provenance: {
      commit: prov,
      subject: aged.O12_PINNED_PROVENANCE_SUBJECT,
      resolves: gitOk(["rev-parse", "--verify", `${prov}^{commit}`]),
      isAncestor: gitOk(["merge-base", "--is-ancestor", prov, "HEAD"]),
      legacy: aged.O12_PINNED_PROVENANCE_LEGACY === true,
      legacyReason: aged.O12_PINNED_PROVENANCE_LEGACY_REASON ?? "",
      observedSubject: gitTextOrNull(["log", "-1", "--format=%s", prov]),
    },
    pointer: {
      commit: src.commit,
      tree: src.tree,
      subject: src.subject,
      resolves: isNonEmptyString(src.commit) && gitOk(["cat-file", "-e", `${src.commit}^{commit}`]),
      isAncestor: isNonEmptyString(src.commit) && gitOk(["merge-base", "--is-ancestor", src.commit, "HEAD"]),
      observedTree: isNonEmptyString(src.commit) ? gitTextOrNull(["rev-parse", `${src.commit}^{tree}`]) : null,
      observedSubject: isNonEmptyString(src.commit) ? gitTextOrNull(["log", "-1", "--format=%s", src.commit]) : null,
      legacyNotAncestor: src.legacy_not_ancestor === true,
      legacyReason: src.legacy_reason ?? "",
    },
  };
}

/**
 * Pure validator for the US-004 aged adaptation. The port must not touch the
 * O12 content pin; an unreachable provenance commit (the pre-port torture
 * branches are not ancestors of the schema-13 product HEAD) is acceptable only
 * when it is explicitly declared legacy. An empty error list means the aged
 * tooling's provenance contract is honest for this product.
 */
export function validateAgedAdaptation(state, opts = {}) {
  const label = opts.label ?? "aged";
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${label}: aged state must be an object`];
  }
  if (state.contentPin !== EXPECTED_O12_CONTENT_SHA256) {
    errors.push(
      `${label}: O12 content pin ${JSON.stringify(state.contentPin)} != ${EXPECTED_O12_CONTENT_SHA256} (the port must not re-pin content)`,
    );
  }

  const p = state.provenance ?? {};
  if (!isNonEmptyString(p.commit)) errors.push(`${label}: provenance.commit missing`);
  if (p.resolves !== true) {
    errors.push(`${label}: O12 provenance commit ${p.commit} must resolve to a real commit`);
  }
  if (p.observedSubject !== p.subject) {
    errors.push(
      `${label}: O12 provenance subject ${JSON.stringify(p.subject)} != the commit's real subject ${JSON.stringify(p.observedSubject)}`,
    );
  }
  if (isNonEmptyString(p.subject) && /^feat: US-\d{3}/.test(p.subject)) {
    errors.push(`${label}: O12 provenance must never be a pre-squash story commit`);
  }
  if (p.isAncestor !== true) {
    if (p.legacy !== true) {
      errors.push(
        `${label}: O12 provenance commit ${p.commit} is not an ancestor of HEAD and is not declared legacy`,
      );
    }
    if (!isNonEmptyString(p.legacyReason)) {
      errors.push(`${label}: an unreachable O12 provenance commit must record a legacy_reason`);
    }
  }

  const q = state.pointer ?? {};
  if (!isNonEmptyString(q.commit)) errors.push(`${label}: pointer source.commit missing`);
  if (q.resolves !== true) errors.push(`${label}: pointer source commit ${q.commit} must resolve to a real commit`);
  if (q.observedTree !== q.tree) {
    errors.push(`${label}: pointer source.tree ${q.tree} != commit^{tree} ${q.observedTree}`);
  }
  if (q.observedSubject !== q.subject) {
    errors.push(
      `${label}: pointer source.subject ${JSON.stringify(q.subject)} != the commit's real subject ${JSON.stringify(q.observedSubject)}`,
    );
  }
  if (isNonEmptyString(q.subject) && /^feat: US-\d{3}/.test(q.subject)) {
    errors.push(`${label}: pointer source must never be a pre-squash story commit`);
  }
  if (q.isAncestor !== true) {
    if (q.legacyNotAncestor !== true) {
      errors.push(
        `${label}: pointer source commit ${q.commit} is not an ancestor of HEAD and is not declared legacy_not_ancestor`,
      );
    }
    if (!/pre-port|squash|integration\//i.test(q.legacyReason ?? "")) {
      errors.push(`${label}: pointer legacy_reason must explain the pre-port provenance`);
    }
  }
  return errors;
}

/**
 * Red arms for the aged adaptation: each mutation must be rejected; the
 * unmodified state is the green control.
 */
export function runAgedRedArms(state) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateAgedAdaptation(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("content-pin-drift", (s) => {
    s.contentPin = "0".repeat(64);
  });
  add("provenance-unresolvable", (s) => {
    s.provenance.resolves = false;
  });
  add("provenance-subject-mismatch", (s) => {
    s.provenance.observedSubject = "rewritten subject";
  });
  add("provenance-story-commit", (s) => {
    s.provenance.subject = "feat: US-999 - a pre-squash story commit";
  });
  add("provenance-unreachable-not-legacy", (s) => {
    s.provenance.isAncestor = false;
    s.provenance.legacy = false;
  });
  add("provenance-legacy-no-reason", (s) => {
    s.provenance.isAncestor = false;
    s.provenance.legacy = true;
    s.provenance.legacyReason = "";
  });
  add("pointer-unresolvable", (s) => {
    s.pointer.resolves = false;
  });
  add("pointer-tree-mismatch", (s) => {
    s.pointer.observedTree = "0".repeat(40);
  });
  add("pointer-subject-mismatch", (s) => {
    s.pointer.observedSubject = "rewritten subject";
  });
  add("pointer-unreachable-not-legacy", (s) => {
    s.pointer.isAncestor = false;
    s.pointer.legacyNotAncestor = false;
  });
  add("pointer-legacy-no-reason", (s) => {
    s.pointer.isAncestor = false;
    s.pointer.legacyNotAncestor = true;
    s.pointer.legacyReason = "no explanation";
  });

  // Green control: the unmodified collected state must be accepted.
  {
    const errors = validateAgedAdaptation(state, { label: "green-arm:aged-state" });
    arms.push({
      name: "aged-state-accepted",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}



function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function runContractCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  const { paths, source } = expectedOutsidePaths(contract);
  console.log(`contract: ${contractPath}`);
  console.log(`expected-path-source: ${source}`);
  console.log(`expected-paths: ${paths.length}`);

  const errors = validateContract(contract, paths);
  const arms = runContractRedArms(contract, paths);

  for (const arm of arms) {
    console.log(`red-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }

  const failedArms = arms.filter((a) => !a.ok);
  if (errors.length > 0) {
    console.error(`\ncontract validation FAILED with ${errors.length} error(s):`);
    for (const e of errors) console.error(`  - ${e}`);
  } else {
    console.log("contract validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} red arm(s) failed`);
  } else {
    console.log(`red arms: ${arms.length}/${arms.length} PASS`);
  }
  if (paths.length !== EXPECTED_PATH_COUNT) {
    console.error(
      `expected ${EXPECTED_PATH_COUNT} outside paths but the pinned inventory yielded ${paths.length}`,
    );
    return 1;
  }
  return errors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

function runOverlayCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  let contract = null;
  if (fs.existsSync(contractPath)) {
    try {
      contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
    } catch (err) {
      console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
      return 1;
    }
  }
  const adaptedPaths = adaptedPathsFromContract(contract);

  let state;
  try {
    state = collectOverlayState();
  } catch (err) {
    console.error(`torture-port-verify: cannot collect overlay state: ${err.message}`);
    return 1;
  }

  const nonPortOverlay = state.overlayDiffPaths.filter(
    (p) => !isPortArtifact(p) && !adaptedPaths.includes(p),
  );
  const nonPortUntracked = state.extraTorturePaths.filter(
    (p) => !isPortArtifact(p) && !adaptedPaths.includes(p),
  );
  console.log(`overlay source ref: ${SRC_REF}`);
  console.log(`overlay base ref:   ${BASE_REF}`);
  console.log(`recorded adaptations: ${adaptedPaths.length}`);
  console.log(`overlay diff paths (non-port, non-adaptation): ${nonPortOverlay.length}`);
  console.log(`untracked torture paths (non-port, non-adaptation): ${nonPortUntracked.length}`);
  console.log(`non-torture paths differing from BASE: ${state.nonTortureDiffPaths.length}`);
  console.log(`present dropped paths: ${state.presentDroppedPaths.length}`);

  const errors = validateOverlay(state, { adaptedPaths, requireAdaptedDiffs: true });
  const arms = runOverlayRedArms(state, { adaptedPaths });

  // The BASE -> SRC inventory is a property of the pinned refs; assert it too.
  const inventoryErrors = [];
  try {
    const inv = refOverlayInventory();
    console.log(
      `ref overlay inventory (BASE->SRC): added=${inv.added} modified=${inv.modified} dropped=${inv.dropped}`,
    );
    if (inv.added !== EXPECTED_OVERLAY.added) {
      inventoryErrors.push(`overlay inventory added ${inv.added} != expected ${EXPECTED_OVERLAY.added}`);
    }
    if (inv.modified !== EXPECTED_OVERLAY.modified) {
      inventoryErrors.push(
        `overlay inventory modified ${inv.modified} != expected ${EXPECTED_OVERLAY.modified}`,
      );
    }
    if (inv.dropped !== EXPECTED_OVERLAY.dropped) {
      inventoryErrors.push(`overlay inventory dropped ${inv.dropped} != expected ${EXPECTED_OVERLAY.dropped}`);
    }
  } catch (err) {
    console.warn(`torture-port-verify: pinned refs unavailable, skipping ref inventory: ${err.message}`);
  }

  for (const arm of arms) {
    console.log(`overlay-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);

  const allErrors = [...errors, ...inventoryErrors];
  if (allErrors.length > 0) {
    console.error(`\noverlay validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("overlay validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} overlay arm(s) failed`);
  } else {
    console.log(`overlay arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

function runEnvironmentCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  const receipt = contract.environmentReceipt;
  const errors = validateEnvironmentReceipt(receipt);
  const arms = receipt ? runEnvironmentRedArms(receipt) : [];

  // Live evidence check: every retained smoke log must exist and be non-empty.
  const liveErrors = [];
  if (receipt && Array.isArray(receipt.smoke_tests)) {
    for (const s of receipt.smoke_tests) {
      if (!s || !isNonEmptyString(s.log)) continue;
      const abs = path.isAbsolute(s.log) ? s.log : path.join(REPO_ROOT, s.log);
      if (!fs.existsSync(abs)) {
        liveErrors.push(`environment: retained smoke log missing: ${s.log}`);
      } else if (fs.statSync(abs).size === 0) {
        liveErrors.push(`environment: retained smoke log is empty: ${s.log}`);
      }
    }
  }

  console.log(`contract: ${contractPath}`);
  console.log(`environment node: ${receipt?.node ?? "(missing)"} npm: ${receipt?.npm ?? "(missing)"}`);
  if (receipt?.verify_environment?.counts) {
    const c = receipt.verify_environment.counts;
    console.log(`tt-verify-environment: exit=${receipt.verify_environment.exit_code} pass=${c.pass} fail=${c.fail} skipped=${c.skipped} total=${c.total}`);
  }
  for (const arm of arms) {
    console.log(`environment-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\nenvironment validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("environment validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} environment arm(s) failed`);
  } else {
    console.log(`environment arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

async function runAgedCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  let state;
  try {
    state = await collectAgedState();
  } catch (err) {
    console.error(`torture-port-verify: cannot collect aged state: ${err.message}`);
    return 1;
  }

  const errors = validateAgedAdaptation(state);
  const arms = runAgedRedArms(state);

  // Live self-test evidence: every US-004 aged self-test must be recorded with
  // exit_code 0 and a retained non-empty log.
  const liveErrors = [];
  const selfTests = contract.storyEvidence?.["US-004"]?.selfTests;
  if (!Array.isArray(selfTests)) {
    liveErrors.push("aged: contract.storyEvidence.US-004.selfTests missing");
  } else {
    for (const name of AGED_SELF_TESTS) {
      const e = selfTests.find((x) => x && x.name === name);
      if (!e) {
        liveErrors.push(`aged: self-test ${name} not recorded`);
        continue;
      }
      if (e.exit_code !== 0) liveErrors.push(`aged: self-test ${name} exit_code must be 0`);
      if (!isNonEmptyString(e.log)) {
        liveErrors.push(`aged: self-test ${name} log path missing`);
        continue;
      }
      const abs = path.isAbsolute(e.log) ? e.log : path.join(REPO_ROOT, e.log);
      if (!fs.existsSync(abs)) liveErrors.push(`aged: retained log missing: ${e.log}`);
      else if (fs.statSync(abs).size === 0) liveErrors.push(`aged: retained log is empty: ${e.log}`);
    }
  }

  console.log(`contract: ${contractPath}`);
  console.log(`O12 content pin: ${state.contentPin}`);
  console.log(
    `O12 provenance: ${state.provenance.commit} ancestor=${state.provenance.isAncestor} legacy=${state.provenance.legacy}`,
  );
  console.log(
    `pointer source: ${state.pointer.commit} ancestor=${state.pointer.isAncestor} legacy=${state.pointer.legacyNotAncestor}`,
  );
  for (const arm of arms) {
    console.log(`aged-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\naged validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("aged validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} aged arm(s) failed`);
  } else {
    console.log(`aged arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

/**
 * Collect the live US-005 O12 state: the embedded CONTENT pin recomputed over
 * the current tree (must equal the pin when no pinned file was adapted) plus the
 * contract's recorded O12 gate receipt.
 */
export async function collectO12State(contract) {
  const agedPath = path.join(REPO_ROOT, "torture-test", "aged", "validate.mjs");
  const aged = await import(pathToFileURL(agedPath).href);
  const pin = aged.O12_PINNED_CONTENT_SHA256;
  const recomputed = aged.computeO12OracleContentHash({ repoRoot: REPO_ROOT });
  return {
    pin,
    recomputed,
    receipt: contract?.gateResults?.["US-005"] ?? null,
  };
}

/**
 * Pure validator for the US-005 O12 adaptation. The port must keep the CONTENT
 * pin honest: the embedded pin must equal a LIVE recomputation over the current
 * tree (a re-pin, if ever needed, uses computeO12OracleContentHash and never a
 * commit id). The recorded receipt must show all eight documented entries exit
 * 0 and the gate runner's fixture matrix at 78/78 all_match with snapshot
 * immutability ok.
 */
export function validateO12Adaptation(state, opts = {}) {
  const label = opts.label ?? "o12";
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${label}: o12 state must be an object`];
  }
  if (state.pin !== EXPECTED_O12_CONTENT_SHA256) {
    errors.push(
      `${label}: O12 content pin ${JSON.stringify(state.pin)} != ${EXPECTED_O12_CONTENT_SHA256}`,
    );
  }
  if (state.recomputed !== state.pin) {
    errors.push(
      `${label}: live content hash ${JSON.stringify(state.recomputed)} != pinned ${JSON.stringify(state.pin)} (a pinned file changed without a content re-pin)`,
    );
  }

  const r = state.receipt;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    return [...errors, `${label}: contract.gateResults.US-005 missing`];
  }
  if (r.result !== "PASS") errors.push(`${label}: gateResults.US-005.result must be PASS`);
  if (r.all_exit_zero !== true) errors.push(`${label}: gateResults.US-005.all_exit_zero must be true`);

  const entries = Array.isArray(r.entries) ? r.entries : [];
  for (const definition of O12_DOCUMENTED_ENTRIES) {
    const entry = entries.find((x) => x && x.name === definition.name);
    if (!entry) {
      errors.push(`${label}: documented O12 entry ${definition.name} not recorded`);
      continue;
    }
    if (entry.kind !== definition.kind) {
      errors.push(`${label}: ${definition.name} kind ${JSON.stringify(entry.kind)} != ${definition.kind}`);
    }
    if (entry.exit_code !== 0) {
      errors.push(`${label}: ${definition.name} exit_code must be 0 (got ${JSON.stringify(entry.exit_code)})`);
    }
    if (definition.kind === "test") {
      if (!Number.isInteger(entry.tests) || entry.tests <= 0) {
        errors.push(`${label}: ${definition.name} must record a positive integer tests count`);
      }
      if (entry.fail !== 0) errors.push(`${label}: ${definition.name} fail must be 0`);
    }
    if (!isNonEmptyString(entry.log)) errors.push(`${label}: ${definition.name} log path missing`);
  }

  const gate = r.gate_runner ?? {};
  if (gate.exit_code !== 0) errors.push(`${label}: gate runner exit_code must be 0`);
  if (gate.verdict !== "PASS") errors.push(`${label}: gate runner verdict must be PASS`);
  if (gate.entries_passed !== gate.entries_total) {
    errors.push(
      `${label}: gate runner entries_passed ${gate.entries_passed} != entries_total ${gate.entries_total}`,
    );
  }

  const m = r.matrix ?? {};
  if (m.expected_fixture_count !== EXPECTED_O12_FIXTURE_COUNT) {
    errors.push(
      `${label}: matrix expected_fixture_count ${m.expected_fixture_count} != ${EXPECTED_O12_FIXTURE_COUNT}`,
    );
  }
  if (m.fixture_count !== EXPECTED_O12_FIXTURE_COUNT) {
    errors.push(`${label}: matrix fixture_count ${m.fixture_count} != ${EXPECTED_O12_FIXTURE_COUNT}`);
  }
  if (m.all_match !== true) errors.push(`${label}: matrix all_match must be true`);
  if (m.all_correction_cases_green !== true) {
    errors.push(`${label}: matrix all_correction_cases_green must be true`);
  }
  if (m.snapshot_immutability_ok !== true) {
    errors.push(`${label}: matrix snapshot_immutability_ok must be true`);
  }
  if (m.validation_ok !== true) errors.push(`${label}: matrix validation_ok must be true`);

  const pin = r.content_pin ?? {};
  if (pin.repin_required !== false) {
    errors.push(`${label}: content_pin.repin_required must be false when no pinned file changed`);
  }
  if (pin.embedded !== EXPECTED_O12_CONTENT_SHA256 || pin.recomputed !== EXPECTED_O12_CONTENT_SHA256) {
    errors.push(
      `${label}: recorded content_pin embedded/recomputed must equal ${EXPECTED_O12_CONTENT_SHA256}`,
    );
  }
  const pinTest = pin.self_test ?? {};
  if (pinTest.name !== "o12-content-pin.test.mjs") {
    errors.push(`${label}: content_pin.self_test must be o12-content-pin.test.mjs`);
  }
  if (pinTest.exit_code !== 0) errors.push(`${label}: content_pin.self_test exit_code must be 0`);
  if (pinTest.fail !== 0) errors.push(`${label}: content_pin.self_test fail must be 0`);
  if (!Number.isInteger(pinTest.tests) || pinTest.tests <= 0) {
    errors.push(`${label}: content_pin.self_test must record a positive integer tests count`);
  }
  if (!isNonEmptyString(pinTest.log)) errors.push(`${label}: content_pin.self_test log path missing`);
  return errors;
}

/** Red arms for the O12 adaptation; the unmodified live state is the control. */
export function runO12RedArms(state) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateO12Adaptation(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("content-pin-drift", (s) => {
    s.pin = "0".repeat(64);
  });
  add("live-hash-drift", (s) => {
    s.recomputed = "1".repeat(64);
  });
  add("missing-entry", (s) => {
    s.receipt.entries = s.receipt.entries.filter(
      (e) => e && e.name !== "o12-seed-snapshot.test.mjs",
    );
  });
  add("entry-nonzero", (s) => {
    s.receipt.entries.find((e) => e.name === "o12.test.mjs").exit_code = 1;
  });
  add("entry-no-tests", (s) => {
    s.receipt.entries.find((e) => e.name === "o12.test.mjs").tests = 0;
  });
  add("matrix-count-drift", (s) => {
    s.receipt.matrix.fixture_count = 77;
  });
  add("matrix-not-all-match", (s) => {
    s.receipt.matrix.all_match = false;
  });
  add("matrix-immutability", (s) => {
    s.receipt.matrix.snapshot_immutability_ok = false;
  });
  add("gate-verdict-fail", (s) => {
    s.receipt.gate_runner.verdict = "FAIL";
  });
  add("repin-required", (s) => {
    s.receipt.content_pin.repin_required = true;
  });
  add("recorded-pin-drift", (s) => {
    s.receipt.content_pin.recomputed = "2".repeat(64);
  });
  add("content-pin-test-failed", (s) => {
    s.receipt.content_pin.self_test.exit_code = 1;
  });

  {
    const errors = validateO12Adaptation(state, { label: "green-arm:o12-state" });
    arms.push({
      name: "o12-state-accepted",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}

async function runO12Check() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  let state;
  try {
    state = await collectO12State(contract);
  } catch (err) {
    console.error(`torture-port-verify: cannot collect O12 state: ${err.message}`);
    return 1;
  }

  const errors = validateO12Adaptation(state);
  const arms = runO12RedArms(state);

  // Live evidence: every documented entry's retained log must exist and be
  // non-empty, and the retained gate summary must report the 78/78 matrix.
  const liveErrors = [];
  const selfTests = contract.storyEvidence?.["US-005"]?.selfTests;
  if (!Array.isArray(selfTests)) {
    liveErrors.push("o12: contract.storyEvidence.US-005.selfTests missing");
  } else {
    for (const definition of O12_DOCUMENTED_ENTRIES) {
      const e = selfTests.find((x) => x && x.name === definition.name);
      if (!e) {
        liveErrors.push(`o12: self-test ${definition.name} not recorded`);
        continue;
      }
      if (e.exit_code !== 0) liveErrors.push(`o12: self-test ${definition.name} exit_code must be 0`);
      if (!isNonEmptyString(e.log)) {
        liveErrors.push(`o12: self-test ${definition.name} log path missing`);
        continue;
      }
      const abs = path.isAbsolute(e.log) ? e.log : path.join(REPO_ROOT, e.log);
      if (!fs.existsSync(abs)) liveErrors.push(`o12: retained log missing: ${e.log}`);
      else if (fs.statSync(abs).size === 0) liveErrors.push(`o12: retained log is empty: ${e.log}`);
    }
  }

  const pinLogRel = state.receipt?.content_pin?.self_test?.log;
  if (!isNonEmptyString(pinLogRel)) {
    liveErrors.push("o12: content_pin.self_test log path missing");
  } else {
    const abs = path.isAbsolute(pinLogRel) ? pinLogRel : path.join(REPO_ROOT, pinLogRel);
    if (!fs.existsSync(abs)) liveErrors.push(`o12: retained content-pin log missing: ${pinLogRel}`);
    else if (fs.statSync(abs).size === 0) {
      liveErrors.push(`o12: retained content-pin log is empty: ${pinLogRel}`);
    }
  }

  const summaryRel = state.receipt?.gate_runner?.summary;
  if (!isNonEmptyString(summaryRel)) {
    liveErrors.push("o12: gate_runner.summary path missing");
  } else {
    const abs = path.isAbsolute(summaryRel) ? summaryRel : path.join(REPO_ROOT, summaryRel);
    if (!fs.existsSync(abs)) {
      liveErrors.push(`o12: retained gate summary missing: ${summaryRel}`);
    } else {
      try {
        const summary = JSON.parse(fs.readFileSync(abs, "utf8"));
        const fm = summary.fixture_matrix ?? {};
        if (fm.fixture_count !== EXPECTED_O12_FIXTURE_COUNT) {
          liveErrors.push(`o12: retained summary fixture_count ${fm.fixture_count} != ${EXPECTED_O12_FIXTURE_COUNT}`);
        }
        if (fm.all_match !== true) liveErrors.push("o12: retained summary all_match must be true");
        if (fm.snapshot_immutability_ok !== true) {
          liveErrors.push("o12: retained summary snapshot_immutability_ok must be true");
        }
        if (summary.overall_verdict !== "PASS") {
          liveErrors.push("o12: retained summary overall_verdict must be PASS");
        }
      } catch (err) {
        liveErrors.push(`o12: retained gate summary is not valid JSON: ${err.message}`);
      }
    }
  }

  console.log(`contract: ${contractPath}`);
  console.log(`O12 embedded pin: ${state.pin}`);
  console.log(`O12 computed hash: ${state.recomputed}`);
  if (state.receipt) {
    const g = state.receipt.gate_runner ?? {};
    const m = state.receipt.matrix ?? {};
    console.log(
      `O12 gate: exit=${g.exit_code} entries=${g.entries_passed}/${g.entries_total} verdict=${g.verdict} matrix=${m.fixture_count}/${m.expected_fixture_count} all_match=${m.all_match} immutability=${m.snapshot_immutability_ok}`,
    );
  }
  for (const arm of arms) {
    console.log(`o12-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\no12 validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("o12 validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} o12 arm(s) failed`);
  } else {
    console.log(`o12 arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

/**
 * The new US-007 base-seam conformance test. It is not part of SRC, so it is a
 * recorded adaptation and its entry must appear in the focused storm gate.
 */
export const STORM_BASE_SEAMS_TEST = "torture-test/self-tests/tier2-storm-base-seams.test.ts";

/**
 * Files the US-007 focused storm gate runs: every non-e2e storm-rehearsal
 * self-test plus the storm unit tests plus the base-seam conformance test.
 */
export const EXPECTED_STORM_GATE_FILES = 47;

/** The US-007 adaptations (each path must differ from SRC). */
export const EXPECTED_STORM_ADAPTATION_IDS = Object.freeze(["A-US007-1", "A-US007-2", "A-US007-3"]);

/**
 * Pure validator for the US-007 storm-tooling adaptation. The recorded focused
 * gate must show every selected file exit 0 (no red, no failing test), must
 * include the base-seam conformance entry with its own positive test count, and
 * must record that no product file changed.
 */
export function validateStormAdaptation(state, opts = {}) {
  const label = opts.label ?? "storm";
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${label}: storm state must be an object`];
  }
  const r = state.receipt;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    return [`${label}: contract.gateResults.US-007 missing`];
  }
  if (r.result !== "PASS") errors.push(`${label}: gateResults.US-007.result must be PASS`);
  if (r.all_exit_zero !== true) errors.push(`${label}: gateResults.US-007.all_exit_zero must be true`);
  if (r.product_file_changed !== false) {
    errors.push(`${label}: gateResults.US-007.product_file_changed must be false (no product edit)`);
  }
  const run = r.focused_run ?? {};
  if (run.file_count !== EXPECTED_STORM_GATE_FILES) {
    errors.push(
      `${label}: focused_run.file_count ${run.file_count} != ${EXPECTED_STORM_GATE_FILES}`,
    );
  }
  if (run.red_files !== 0) errors.push(`${label}: focused_run.red_files must be 0`);
  if (run.fail !== 0) errors.push(`${label}: focused_run.fail must be 0`);

  const entries = Array.isArray(r.entries) ? r.entries : [];
  if (entries.length !== run.file_count) {
    errors.push(
      `${label}: ${entries.length} entries recorded but focused_run.file_count is ${run.file_count}`,
    );
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: malformed focused-gate entry`);
      continue;
    }
    if (!isNonEmptyString(entry.name)) errors.push(`${label}: focused-gate entry without a name`);
    if (entry.exit_code !== 0) {
      errors.push(`${label}: focused-gate entry ${entry.name} exit_code must be 0 (got ${JSON.stringify(entry.exit_code)})`);
    }
    if (entry.fail !== 0) errors.push(`${label}: focused-gate entry ${entry.name} fail must be 0`);
    if (!Number.isInteger(entry.tests) || entry.tests < 0) {
      errors.push(`${label}: focused-gate entry ${entry.name} must record a non-negative integer tests count`);
    }
    if (!isNonEmptyString(entry.log)) errors.push(`${label}: focused-gate entry ${entry.name} log path missing`);
  }

  const baseSeam = entries.find((entry) => entry && entry.name === STORM_BASE_SEAMS_TEST);
  if (!baseSeam) {
    errors.push(`${label}: base-seam conformance entry ${STORM_BASE_SEAMS_TEST} not recorded`);
  } else {
    if (baseSeam.exit_code !== 0) errors.push(`${label}: base-seam conformance entry exit_code must be 0`);
    if (baseSeam.fail !== 0) errors.push(`${label}: base-seam conformance entry fail must be 0`);
    if (!Number.isInteger(baseSeam.tests) || baseSeam.tests < 7) {
      errors.push(`${label}: base-seam conformance entry must record at least 7 tests`);
    }
  }

  const ids = Array.isArray(state.adaptationIds) ? state.adaptationIds : [];
  for (const id of EXPECTED_STORM_ADAPTATION_IDS) {
    if (!ids.includes(id)) errors.push(`${label}: US-007 adaptation ${id} not recorded in contract.adaptations`);
  }
  return errors;
}

/** Red arms for the US-007 storm adaptation; the unmodified live state is the control. */
export function runStormRedArms(state) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateStormAdaptation(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("missing-receipt", (s) => {
    s.receipt = null;
  });
  add("result-fail", (s) => {
    s.receipt.result = "FAIL";
  });
  add("red-file", (s) => {
    s.receipt.focused_run.red_files = 1;
  });
  add("failing-test", (s) => {
    s.receipt.focused_run.fail = 1;
  });
  add("file-count-drift", (s) => {
    s.receipt.focused_run.file_count = 45;
  });
  add("entry-nonzero", (s) => {
    s.receipt.entries[0].exit_code = 1;
  });
  add("entry-fail", (s) => {
    s.receipt.entries[0].fail = 1;
  });
  add("entry-no-log", (s) => {
    s.receipt.entries[0].log = "";
  });
  add("missing-base-seam", (s) => {
    s.receipt.entries = s.receipt.entries.filter((e) => e && e.name !== STORM_BASE_SEAMS_TEST);
  });
  add("base-seam-red", (s) => {
    s.receipt.entries.find((e) => e && e.name === STORM_BASE_SEAMS_TEST).exit_code = 1;
  });
  add("product-file-changed", (s) => {
    s.receipt.product_file_changed = true;
  });
  add("all-exit-zero-false", (s) => {
    s.receipt.all_exit_zero = false;
  });
  add("missing-adaptation", (s) => {
    s.adaptationIds = s.adaptationIds.filter((id) => id !== "A-US007-3");
  });

  {
    const errors = validateStormAdaptation(state, { label: "green-arm:storm-state" });
    arms.push({
      name: "storm-state-accepted",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}

async function runStormCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  const receipt = contract?.gateResults?.["US-007"] ?? null;
  const adaptationIds = (Array.isArray(contract?.adaptations) ? contract.adaptations : [])
    .map((a) => a?.id)
    .filter((id) => typeof id === "string");
  const state = { receipt, adaptationIds };

  const errors = validateStormAdaptation(state);
  const arms = runStormRedArms(state);

  // Live evidence: every recorded focused-gate log must exist and be non-empty,
  // the base-seam test file must be present, and no product path may differ
  // from BASE 6e5f2427.
  const liveErrors = [];
  const entries = Array.isArray(receipt?.entries) ? receipt.entries : [];
  for (const entry of entries) {
    if (!entry || !isNonEmptyString(entry.log)) continue;
    const abs = path.isAbsolute(entry.log) ? entry.log : path.join(REPO_ROOT, entry.log);
    if (!fs.existsSync(abs)) liveErrors.push(`storm: retained log missing: ${entry.log}`);
    else if (fs.statSync(abs).size === 0) liveErrors.push(`storm: retained log is empty: ${entry.log}`);
  }
  const baseSeamAbs = path.join(REPO_ROOT, STORM_BASE_SEAMS_TEST);
  if (!fs.existsSync(baseSeamAbs)) {
    liveErrors.push(`storm: base-seam conformance test missing: ${STORM_BASE_SEAMS_TEST}`);
  }
  try {
    const changed = git(["diff", "--name-only", BASE_REF, "--", ".", ":(exclude)torture-test"]);
    if (changed.length > 0) {
      liveErrors.push(`storm: product path differs from BASE ${BASE_REF}: ${changed}`);
    }
  } catch (err) {
    liveErrors.push(`storm: cannot query git against BASE ${BASE_REF}: ${err.message}`);
  }

  console.log(`contract: ${contractPath}`);
  if (receipt) {
    const run = receipt.focused_run ?? {};
    console.log(
      `US-007 focused storm gate: result=${receipt.result} files=${run.file_count} reds=${run.red_files} tests=${run.tests} fail=${run.fail}`,
    );
  }
  for (const arm of arms) {
    console.log(`storm-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\nstorm validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("storm validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} storm arm(s) failed`);
  } else {
    console.log(`storm arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

// ── US-008 core-recording / scripted-runtime adaptation ──────────────

/**
 * The four entries that were RED before US-008 and are the story's target:
 * two recorded-cell gates whose assertions pinned superseded product defaults,
 * and the two fork-parity gates whose torture runtimes lagged the base e2e
 * helpers (dsh v3 session format; pi `stream-die-before-claim`).
 */
export const CORE_RECORDING_KEY_TESTS = Object.freeze([
  "torture-test/self-tests/tier0-core-recording-brun-cell.test.ts",
  "torture-test/self-tests/tier0-core-recording-rvoc-rcnt-cells.test.ts",
  "torture-test/self-tests/scripted-runtime-fork.test.ts",
  "torture-test/self-tests/scripted-runtime-install-parity.test.ts",
]);

export const EXPECTED_CORE_RECORDING_FILES = 18;
export const EXPECTED_CORE_RECORDING_ADAPTATION_IDS = Object.freeze([
  "A-US008-1",
  "A-US008-2",
  "A-US008-3",
  "A-US008-4",
  "A-US008-5",
]);

/**
 * Live seam pins: the ported torture runtimes must carry the base product seam
 * they track, so the check cannot pass on a stale fork that merely recorded a
 * green run.
 */
export const CORE_RECORDING_SEAM_PINS = Object.freeze([
  {
    path: "torture-test/scripted-runtimes/runtime-dsh.mjs",
    marker: "session.v3.jsonl.zstd",
    reason: "dsh >= 0.1.5 v3 session format (base 59f955c5)",
  },
  {
    path: "torture-test/scripted-runtimes/runtime-pi.mjs",
    marker: 'mode === "stream-die-before-claim"',
    reason: "pre-claim death / harness-wall classification (base 098c4f5f)",
  },
]);

/** Pure validation of the US-008 core-recording/scripted-runtime adaptation. */
export function validateCoreRecordingAdaptation(state, opts = {}) {
  const label = opts.label ?? "core-recording";
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${label}: core-recording state must be an object`];
  }
  const r = state.receipt;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    return [`${label}: contract.gateResults.US-008 missing`];
  }
  if (r.result !== "PASS") errors.push(`${label}: gateResults.US-008.result must be PASS`);
  if (r.all_exit_zero !== true) errors.push(`${label}: gateResults.US-008.all_exit_zero must be true`);
  if (r.product_file_changed !== false) {
    errors.push(`${label}: gateResults.US-008.product_file_changed must be false (no product edit)`);
  }
  const run = r.focused_run ?? {};
  if (run.file_count !== EXPECTED_CORE_RECORDING_FILES) {
    errors.push(
      `${label}: focused_run.file_count ${run.file_count} != ${EXPECTED_CORE_RECORDING_FILES}`,
    );
  }
  if (run.red_files !== 0) errors.push(`${label}: focused_run.red_files must be 0`);
  if (run.fail !== 0) errors.push(`${label}: focused_run.fail must be 0`);

  const entries = Array.isArray(r.entries) ? r.entries : [];
  if (entries.length !== run.file_count) {
    errors.push(
      `${label}: ${entries.length} entries recorded but focused_run.file_count is ${run.file_count}`,
    );
  }
  const byName = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: malformed focused-run entry`);
      continue;
    }
    if (!isNonEmptyString(entry.name)) errors.push(`${label}: focused-run entry without a name`);
    else byName.set(entry.name, entry);
    if (entry.exit_code !== 0) {
      errors.push(`${label}: entry ${entry.name} exit_code must be 0 (got ${JSON.stringify(entry.exit_code)})`);
    }
    if (entry.fail !== 0) errors.push(`${label}: entry ${entry.name} fail must be 0`);
    if (!Number.isInteger(entry.tests) || entry.tests < 1) {
      errors.push(`${label}: entry ${entry.name} must record at least 1 test`);
    }
    if (!isNonEmptyString(entry.log)) errors.push(`${label}: entry ${entry.name} log path missing`);
  }
  for (const name of CORE_RECORDING_KEY_TESTS) {
    const entry = byName.get(name);
    if (!entry) {
      errors.push(`${label}: key self-test ${name} not recorded`);
    } else if (entry.exit_code !== 0 || entry.fail !== 0) {
      errors.push(`${label}: key self-test ${name} must be green`);
    }
  }
  const ids = Array.isArray(state.adaptationIds) ? state.adaptationIds : [];
  for (const id of EXPECTED_CORE_RECORDING_ADAPTATION_IDS) {
    if (!ids.includes(id)) errors.push(`${label}: US-008 adaptation ${id} not recorded in contract.adaptations`);
  }
  return errors;
}

/** Red arms for the US-008 adaptation; the unmodified live state is the control. */
export function runCoreRecordingRedArms(state) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateCoreRecordingAdaptation(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("missing-receipt", (s) => {
    s.receipt = null;
  });
  add("result-fail", (s) => {
    s.receipt.result = "FAIL";
  });
  add("red-file", (s) => {
    s.receipt.focused_run.red_files = 1;
  });
  add("failing-test", (s) => {
    s.receipt.focused_run.fail = 1;
  });
  add("file-count-drift", (s) => {
    s.receipt.focused_run.file_count = 17;
  });
  add("entry-nonzero", (s) => {
    s.receipt.entries[0].exit_code = 1;
  });
  add("entry-fail", (s) => {
    s.receipt.entries[0].fail = 1;
  });
  add("entry-no-log", (s) => {
    s.receipt.entries[0].log = "";
  });
  add("entry-zero-tests", (s) => {
    s.receipt.entries[0].tests = 0;
  });
  add("missing-key-test", (s) => {
    s.receipt.entries = s.receipt.entries.filter((e) => e && e.name !== CORE_RECORDING_KEY_TESTS[2]);
  });
  add("key-test-red", (s) => {
    s.receipt.entries.find((e) => e && e.name === CORE_RECORDING_KEY_TESTS[0]).exit_code = 1;
  });
  add("product-file-changed", (s) => {
    s.receipt.product_file_changed = true;
  });
  add("all-exit-zero-false", (s) => {
    s.receipt.all_exit_zero = false;
  });
  add("missing-adaptation", (s) => {
    s.adaptationIds = s.adaptationIds.filter((id) => id !== "A-US008-2");
  });

  {
    const errors = validateCoreRecordingAdaptation(state, { label: "green-arm:core-recording-state" });
    arms.push({
      name: "core-recording-state-accepted",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}

async function runCoreRecordingCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  const receipt = contract?.gateResults?.["US-008"] ?? null;
  const adaptationIds = (Array.isArray(contract?.adaptations) ? contract.adaptations : [])
    .map((a) => a?.id)
    .filter((id) => typeof id === "string");
  const state = { receipt, adaptationIds };

  const errors = validateCoreRecordingAdaptation(state);
  const arms = runCoreRecordingRedArms(state);

  // Live evidence: every recorded focused-run log must exist and be non-empty,
  // the ported runtimes must carry the base seam they track, and no product
  // path may differ from BASE 6e5f2427.
  const liveErrors = [];
  const entries = Array.isArray(receipt?.entries) ? receipt.entries : [];
  for (const entry of entries) {
    if (!entry || !isNonEmptyString(entry.log)) continue;
    const abs = path.isAbsolute(entry.log) ? entry.log : path.join(REPO_ROOT, entry.log);
    if (!fs.existsSync(abs)) liveErrors.push(`core-recording: retained log missing: ${entry.log}`);
    else if (fs.statSync(abs).size === 0) liveErrors.push(`core-recording: retained log is empty: ${entry.log}`);
  }
  for (const seam of CORE_RECORDING_SEAM_PINS) {
    const abs = path.join(REPO_ROOT, seam.path);
    if (!fs.existsSync(abs)) {
      liveErrors.push(`core-recording: ported runtime missing: ${seam.path}`);
      continue;
    }
    const text = fs.readFileSync(abs, "utf8");
    if (!text.includes(seam.marker)) {
      liveErrors.push(
        `core-recording: ${seam.path} does not carry the base seam ${JSON.stringify(seam.marker)} (${seam.reason})`,
      );
    }
  }
  try {
    const changed = git(["diff", "--name-only", BASE_REF, "--", ".", ":(exclude)torture-test"]);
    if (changed.length > 0) {
      liveErrors.push(`core-recording: product path differs from BASE ${BASE_REF}: ${changed}`);
    }
  } catch (err) {
    liveErrors.push(`core-recording: cannot query git against BASE ${BASE_REF}: ${err.message}`);
  }

  console.log(`contract: ${contractPath}`);
  if (receipt) {
    const run = receipt.focused_run ?? {};
    console.log(
      `US-008 core-recording/scripted-runtime gate: result=${receipt.result} files=${run.file_count} reds=${run.red_files} tests=${run.tests} fail=${run.fail}`,
    );
  }
  for (const arm of arms) {
    console.log(`core-recording-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\ncore-recording validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("core-recording validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} core-recording arm(s) failed`);
  } else {
    console.log(`core-recording arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

// ── US-009 self-tests-alone gate ─────────────────────────────────────

/** Expected entry counts per group from the frozen self-tests-alone selection. */
export const EXPECTED_SELF_TESTS_ALONE_COUNTS = Object.freeze({
  npf2: 2,
  aged: 4,
  o12: 8,
  qualification: 1,
});

/** The gating (required) groups. */
export const SELF_TESTS_ALONE_GATING_GROUPS = Object.freeze(["npf2", "aged", "o12"]);

/** The required total (the three gating groups). */
export const EXPECTED_SELF_TESTS_ALONE_REQUIRED = 14;

/** Every entry the gate runs, gating and informational. */
export const EXPECTED_SELF_TESTS_ALONE_ENTRIES = 15;

/**
 * Pure validation of the US-009 self-tests-alone gate receipt recorded in the
 * contract. The receipt must report a green 14/14 gating run from a guard-safe
 * repo root, with the frozen per-group counts, the qualified informational
 * entry, and the retained summary path.
 */
export function validateSelfTestsAloneGate(state, opts = {}) {
  const label = opts.label ?? "self-tests-alone";
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${label}: self-tests-alone state must be an object`];
  }
  const r = state.receipt;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    return [`${label}: contract.gateResults.US-009 missing`];
  }
  if (r.result !== "PASS") errors.push(`${label}: gateResults.US-009.result must be PASS`);
  if (r.all_exit_zero !== true) errors.push(`${label}: gateResults.US-009.all_exit_zero must be true`);
  if (r.product_file_changed !== false) {
    errors.push(`${label}: gateResults.US-009.product_file_changed must be false (no product edit)`);
  }
  if (r.guard_safe_repo_root !== true) {
    errors.push(`${label}: gateResults.US-009.guard_safe_repo_root must be true`);
  }
  if (!isNonEmptyString(r.summary_path)) {
    errors.push(`${label}: gateResults.US-009.summary_path is required`);
  }
  if (r.verdict !== "PASS") errors.push(`${label}: gateResults.US-009.verdict must be PASS`);
  const counts = r.expected_counts ?? {};
  for (const [group, expected] of Object.entries(EXPECTED_SELF_TESTS_ALONE_COUNTS)) {
    if (counts[group] !== expected) {
      errors.push(`${label}: expected_counts.${group} ${counts[group]} != ${expected}`);
    }
  }
  if (r.total_required !== EXPECTED_SELF_TESTS_ALONE_REQUIRED) {
    errors.push(
      `${label}: total_required ${r.total_required} != ${EXPECTED_SELF_TESTS_ALONE_REQUIRED}`,
    );
  }
  if (r.passed_required !== EXPECTED_SELF_TESTS_ALONE_REQUIRED) {
    errors.push(
      `${label}: passed_required ${r.passed_required} != ${EXPECTED_SELF_TESTS_ALONE_REQUIRED}`,
    );
  }
  if (r.failed_required !== 0) errors.push(`${label}: failed_required must be 0`);
  if (!Array.isArray(r.red_files) || r.red_files.length !== 0) {
    errors.push(`${label}: red_files must be an empty array`);
  }
  const byGroup = r.by_group ?? {};
  for (const [group, expected] of Object.entries(EXPECTED_SELF_TESTS_ALONE_COUNTS)) {
    const block = byGroup[group];
    if (!block || typeof block !== "object") {
      errors.push(`${label}: by_group.${group} missing`);
      continue;
    }
    if (block.total !== expected) errors.push(`${label}: by_group.${group}.total ${block.total} != ${expected}`);
    const gating = SELF_TESTS_ALONE_GATING_GROUPS.includes(group);
    if (block.gating !== gating) {
      errors.push(`${label}: by_group.${group}.gating must be ${gating}`);
    }
    // The informational qualification group is executed and retained but never
    // gates the verdict (its colour is owned by the qualification refresh, out
    // of port scope), so only its count is pinned here.
    if (gating) {
      if (block.passed !== expected) errors.push(`${label}: by_group.${group}.passed ${block.passed} != ${expected}`);
      if (block.failed !== 0) errors.push(`${label}: by_group.${group}.failed must be 0`);
      if (block.verdict !== "PASS") errors.push(`${label}: by_group.${group}.verdict must be PASS`);
    }
  }

  const entries = Array.isArray(r.entries) ? r.entries : [];
  if (entries.length !== EXPECTED_SELF_TESTS_ALONE_ENTRIES) {
    errors.push(
      `${label}: ${entries.length} entries recorded but expected ${EXPECTED_SELF_TESTS_ALONE_ENTRIES}`,
    );
  }
  const seenGroups = {};
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: malformed gate entry`);
      continue;
    }
    const group = entry.group;
    seenGroups[group] = (seenGroups[group] ?? 0) + 1;
    if (!isNonEmptyString(entry.name)) errors.push(`${label}: gate entry without a name`);
    // Only the gating groups must exit 0; the informational qualification
    // entry is retained at whatever colour it currently has.
    if (SELF_TESTS_ALONE_GATING_GROUPS.includes(group) && entry.exit_code !== 0) {
      errors.push(`${label}: gate entry ${entry.name} exit_code must be 0 (got ${JSON.stringify(entry.exit_code)})`);
    }
    if (!isNonEmptyString(entry.stdout_log)) errors.push(`${label}: gate entry ${entry.name} stdout_log missing`);
    if (!isNonEmptyString(entry.stderr_log)) errors.push(`${label}: gate entry ${entry.name} stderr_log missing`);
  }
  for (const [group, expected] of Object.entries(EXPECTED_SELF_TESTS_ALONE_COUNTS)) {
    if ((seenGroups[group] ?? 0) !== expected) {
      errors.push(`${label}: ${seenGroups[group] ?? 0} recorded ${group} entries but expected ${expected}`);
    }
  }
  return errors;
}

/** Red arms for the US-009 gate; the unmodified live state is the control. */
export function runSelfTestsAloneRedArms(state) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateSelfTestsAloneGate(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("missing-receipt", (s) => {
    s.receipt = null;
  });
  add("result-fail", (s) => {
    s.receipt.result = "FAIL";
  });
  add("not-all-exit-zero", (s) => {
    s.receipt.all_exit_zero = false;
  });
  add("product-file-changed", (s) => {
    s.receipt.product_file_changed = true;
  });
  add("not-guard-safe", (s) => {
    s.receipt.guard_safe_repo_root = false;
  });
  add("missing-summary-path", (s) => {
    s.receipt.summary_path = "";
  });
  add("verdict-fail", (s) => {
    s.receipt.verdict = "FAIL";
  });
  add("count-drift", (s) => {
    s.receipt.expected_counts.o12 = 7;
  });
  add("total-drift", (s) => {
    s.receipt.total_required = 13;
  });
  add("passed-drift", (s) => {
    s.receipt.passed_required = 13;
  });
  add("failed-nonzero", (s) => {
    s.receipt.failed_required = 1;
  });
  add("red-files", (s) => {
    s.receipt.red_files = ["npf2-negative"];
  });
  add("group-red", (s) => {
    s.receipt.by_group.aged.verdict = "FAIL";
  });
  add("group-total-drift", (s) => {
    s.receipt.by_group.qualification.total = 0;
  });
  add("entry-nonzero", (s) => {
    s.receipt.entries[0].exit_code = 1;
  });
  add("entry-no-log", (s) => {
    s.receipt.entries[0].stdout_log = "";
  });
  add("entry-missing", (s) => {
    s.receipt.entries = s.receipt.entries.slice(1);
  });

  {
    const errors = validateSelfTestsAloneGate(state, { label: "green-arm:self-tests-alone-state" });
    arms.push({
      name: "self-tests-alone-state-accepted",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}

async function runSelfTestsAloneCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  const receipt = contract?.gateResults?.["US-009"] ?? null;
  const state = { receipt };

  const errors = validateSelfTestsAloneGate(state);
  const arms = runSelfTestsAloneRedArms(state);

  // Live evidence: the retained summary must exist, parse, and revalidate
  // through the gate's own validator; every per-entry stdout/stderr log must
  // exist and be non-empty; and no product path may differ from BASE.
  const liveErrors = [];
  const summaryRel = receipt?.summary_path;
  let summary = null;
  if (isNonEmptyString(summaryRel)) {
    const summaryAbs = path.isAbsolute(summaryRel) ? summaryRel : path.join(REPO_ROOT, summaryRel);
    if (!fs.existsSync(summaryAbs)) {
      liveErrors.push(`self-tests-alone: retained summary missing: ${summaryRel}`);
    } else {
      try {
        summary = JSON.parse(fs.readFileSync(summaryAbs, "utf8"));
      } catch (err) {
        liveErrors.push(`self-tests-alone: retained summary is not valid JSON: ${err.message}`);
      }
    }
  }
  if (summary) {
    const validation = validateSelfTestsAloneSummary(summary);
    if (!validation.ok) {
      liveErrors.push(`self-tests-alone: retained summary is not a green honest report: ${validation.problems.join("; ")}`);
    }
    if (summary.total_required !== EXPECTED_SELF_TESTS_ALONE_REQUIRED) {
      liveErrors.push(`self-tests-alone: summary.total_required ${summary.total_required} != ${EXPECTED_SELF_TESTS_ALONE_REQUIRED}`);
    }
    if (summary.passed_required !== EXPECTED_SELF_TESTS_ALONE_REQUIRED) {
      liveErrors.push(`self-tests-alone: summary.passed_required ${summary.passed_required} != ${EXPECTED_SELF_TESTS_ALONE_REQUIRED}`);
    }
    if (summary.environment?.guard_safe_repo_root !== true) {
      liveErrors.push("self-tests-alone: summary.environment.guard_safe_repo_root must be true");
    }
    for (const entry of Array.isArray(summary.entries) ? summary.entries : []) {
      for (const key of ["stdout_log", "stderr_log"]) {
        const logPath = entry?.[key];
        if (!isNonEmptyString(logPath)) {
          liveErrors.push(`self-tests-alone: summary entry ${entry?.name} has no ${key}`);
          continue;
        }
        const abs = path.isAbsolute(logPath) ? logPath : path.join(REPO_ROOT, logPath);
        // Existence is the bar: a clean `node --test` run legitimately writes
        // an empty stderr log, so non-emptiness is not required here (matching
        // the gate's own retained-summary assertions).
        if (!fs.existsSync(abs)) liveErrors.push(`self-tests-alone: retained ${key} missing: ${logPath}`);
      }
    }
  } else if (isNonEmptyString(summaryRel) && !fs.existsSync(path.isAbsolute(summaryRel) ? summaryRel : path.join(REPO_ROOT, summaryRel))) {
    // already recorded above
  } else if (isNonEmptyString(summaryRel)) {
    liveErrors.push(`self-tests-alone: retained summary unreadable: ${summaryRel}`);
  }
  try {
    const changed = git(["diff", "--name-only", BASE_REF, "--", ".", ":(exclude)torture-test"]);
    if (changed.length > 0) {
      liveErrors.push(`self-tests-alone: product path differs from BASE ${BASE_REF}: ${changed}`);
    }
  } catch (err) {
    liveErrors.push(`self-tests-alone: cannot query git against BASE ${BASE_REF}: ${err.message}`);
  }

  console.log(`contract: ${contractPath}`);
  if (receipt) {
    console.log(
      `US-009 self-tests-alone gate: result=${receipt.result} required=${receipt.passed_required}/${receipt.total_required} reds=${(receipt.red_files ?? []).length} guard_safe=${receipt.guard_safe_repo_root}`,
    );
    console.log(`US-009 summary: ${summaryRel}`);
  }
  for (const arm of arms) {
    console.log(`self-tests-alone-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\nself-tests-alone validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("self-tests-alone validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} self-tests-alone arm(s) failed`);
  } else {
    console.log(`self-tests-alone arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

// ── US-010 49-file storm chain gate ─────────────────────────────────

/** The frozen 49-file storm chain the gate must reproduce (run #7 selection). */
export const EXPECTED_STORM_CHAIN_FILE_COUNT = EXPECTED_CHAIN_FILE_COUNT;

/** The run #7 chain shape the port run is compared against (differences explained). */
export const RUN7_CHAIN_SHAPE = Object.freeze({
  file_count: 49,
  red_file_count: 0,
  verdict: "PASS",
  tests: 578,
  pass: 577,
  fail: 0,
  skipped: 1,
});

/**
 * Pure validation of the US-010 storm-chain gate receipt. The receipt must
 * report the frozen 49-file chain all exit 0 with zero red files, no product
 * file changed, a guard-safe repo root, the run #7 chain-files byte match, the
 * consistent totals, and a retained summary path with one row per chain file.
 */
export function validateStormChainGate(state, opts = {}) {
  const label = opts.label ?? "storm-chain";
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${label}: storm-chain state must be an object`];
  }
  const r = state.receipt;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    return [`${label}: contract.gateResults.US-010 missing`];
  }
  if (r.result !== "PASS") errors.push(`${label}: gateResults.US-010.result must be PASS`);
  if (r.all_exit_zero !== true) errors.push(`${label}: gateResults.US-010.all_exit_zero must be true`);
  if (r.product_file_changed !== false) {
    errors.push(`${label}: gateResults.US-010.product_file_changed must be false (no product edit)`);
  }
  if (r.guard_safe_repo_root !== true) {
    errors.push(`${label}: gateResults.US-010.guard_safe_repo_root must be true`);
  }
  if (r.verdict !== "PASS") errors.push(`${label}: gateResults.US-010.verdict must be PASS`);
  if (r.file_count_expected !== EXPECTED_STORM_CHAIN_FILE_COUNT) {
    errors.push(
      `${label}: file_count_expected ${r.file_count_expected} != ${EXPECTED_STORM_CHAIN_FILE_COUNT}`,
    );
  }
  if (r.file_count_observed !== EXPECTED_STORM_CHAIN_FILE_COUNT) {
    errors.push(
      `${label}: file_count_observed ${r.file_count_observed} != ${EXPECTED_STORM_CHAIN_FILE_COUNT}`,
    );
  }
  if (r.red_file_count !== 0) errors.push(`${label}: red_file_count must be 0`);
  const totals = r.totals ?? {};
  for (const key of ["tests", "pass", "skipped"]) {
    if (!Number.isFinite(totals[key]) || totals[key] < 0) {
      errors.push(`${label}: totals.${key} must be a non-negative number`);
    }
  }
  if (totals.fail !== 0) errors.push(`${label}: totals.fail must be 0`);
  if (r.run7_chain_files_byte_match !== true) {
    errors.push(`${label}: run7_chain_files_byte_match must be true`);
  }
  if (!isNonEmptyString(r.summary_path)) {
    errors.push(`${label}: gateResults.US-010.summary_path is required`);
  }
  const entries = Array.isArray(r.entries) ? r.entries : [];
  if (entries.length !== EXPECTED_STORM_CHAIN_FILE_COUNT) {
    errors.push(
      `${label}: ${entries.length} entries recorded but expected ${EXPECTED_STORM_CHAIN_FILE_COUNT}`,
    );
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: malformed chain entry`);
      continue;
    }
    if (!isNonEmptyString(entry.file)) errors.push(`${label}: chain entry without a file`);
    if (entry.rc !== 0) {
      errors.push(`${label}: chain entry ${entry.file} rc must be 0 (got ${JSON.stringify(entry.rc)})`);
    }
    if (entry.fail !== 0) {
      errors.push(`${label}: chain entry ${entry.file} fail must be 0 (got ${JSON.stringify(entry.fail)})`);
    }
  }
  return errors;
}

/** Red arms for the US-010 chain gate; the unmodified live state is the control. */
export function runStormChainRedArms(state) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateStormChainGate(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("missing-receipt", (s) => {
    s.receipt = null;
  });
  add("result-fail", (s) => {
    s.receipt.result = "FAIL";
  });
  add("not-all-exit-zero", (s) => {
    s.receipt.all_exit_zero = false;
  });
  add("product-file-changed", (s) => {
    s.receipt.product_file_changed = true;
  });
  add("not-guard-safe", (s) => {
    s.receipt.guard_safe_repo_root = false;
  });
  add("verdict-fail", (s) => {
    s.receipt.verdict = "FAIL";
  });
  add("file-count-drift", (s) => {
    s.receipt.file_count_observed = 48;
  });
  add("expected-count-drift", (s) => {
    s.receipt.file_count_expected = 47;
  });
  add("red-file-count", (s) => {
    s.receipt.red_file_count = 1;
  });
  add("totals-fail", (s) => {
    s.receipt.totals.fail = 1;
  });
  add("missing-byte-match", (s) => {
    s.receipt.run7_chain_files_byte_match = false;
  });
  add("missing-summary-path", (s) => {
    s.receipt.summary_path = "";
  });
  add("entry-nonzero", (s) => {
    s.receipt.entries[0].rc = 1;
  });
  add("entry-fail", (s) => {
    s.receipt.entries[1].fail = 2;
  });
  add("entry-missing", (s) => {
    s.receipt.entries = s.receipt.entries.slice(1);
  });

  {
    const errors = validateStormChainGate(state, { label: "green-arm:storm-chain-state" });
    arms.push({
      name: "storm-chain-state-accepted",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}

async function runStormChainCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  const receipt = contract?.gateResults?.["US-010"] ?? null;
  const state = { receipt };

  const errors = validateStormChainGate(state);
  const arms = runStormChainRedArms(state);

  // Live evidence: the retained chain-summary.json must exist, parse, and
  // revalidate through the chain gate's own validator; the per-file results
  // must agree with the receipt; the retained artifacts must be present; and
  // no product path may differ from BASE.
  const liveErrors = [];
  const summaryRel = receipt?.summary_path;
  let summary = null;
  if (isNonEmptyString(summaryRel)) {
    const summaryAbs = path.isAbsolute(summaryRel) ? summaryRel : path.join(REPO_ROOT, summaryRel);
    if (!fs.existsSync(summaryAbs)) {
      liveErrors.push(`storm-chain: retained summary missing: ${summaryRel}`);
    } else {
      try {
        summary = JSON.parse(fs.readFileSync(summaryAbs, "utf8"));
      } catch (err) {
        liveErrors.push(`storm-chain: retained summary is not valid JSON: ${err.message}`);
      }
    }
  }
  if (summary) {
    const validation = validateChainSummary(summary);
    if (!validation.ok) {
      liveErrors.push(`storm-chain: retained summary is not a green honest report: ${validation.problems.join("; ")}`);
    }
    if (summary.file_count_observed !== EXPECTED_STORM_CHAIN_FILE_COUNT) {
      liveErrors.push(
        `storm-chain: summary.file_count_observed ${summary.file_count_observed} != ${EXPECTED_STORM_CHAIN_FILE_COUNT}`,
      );
    }
    if (summary.red_file_count !== 0) {
      liveErrors.push(`storm-chain: summary.red_file_count ${summary.red_file_count} != 0`);
    }
    if (summary.verdict !== "PASS") {
      liveErrors.push(`storm-chain: summary.verdict ${JSON.stringify(summary.verdict)} != PASS`);
    }
    if (summary.totals?.fail !== 0) {
      liveErrors.push(`storm-chain: summary.totals.fail ${summary.totals?.fail} != 0`);
    }
    // The receipt totals must equal the retained summary totals exactly.
    if (receipt) {
      const rTotals = receipt.totals ?? {};
      const sTotals = summary.totals ?? {};
      for (const key of ["tests", "pass", "fail", "skipped"]) {
        if (rTotals[key] !== sTotals[key]) {
          liveErrors.push(`storm-chain: receipt totals.${key} ${rTotals[key]} != summary ${sTotals[key]}`);
        }
      }
    }
    const resultsDirRel = receipt?.results_dir ?? path.dirname(summaryRel);
    const resultsDirAbs = path.isAbsolute(resultsDirRel)
      ? resultsDirRel
      : path.join(REPO_ROOT, resultsDirRel);
    for (const artifact of [
      "chain-files.txt",
      "results.tsv",
      "chain-report.md",
      "lock-stat-before.txt",
      "lock-stat-after.txt",
      "chain-wrapper.sh",
      "chain-runner.sh",
    ]) {
      if (!fs.existsSync(path.join(resultsDirAbs, artifact))) {
        liveErrors.push(`storm-chain: retained ${artifact} missing under ${resultsDirRel}`);
      }
    }
    const resultsTsv = path.join(resultsDirAbs, "results.tsv");
    if (fs.existsSync(resultsTsv)) {
      const lines = fs.readFileSync(resultsTsv, "utf8").trim().split("\n");
      if (lines.length !== EXPECTED_STORM_CHAIN_FILE_COUNT + 1) {
        liveErrors.push(
          `storm-chain: results.tsv has ${lines.length} lines; expected ${EXPECTED_STORM_CHAIN_FILE_COUNT + 1}`,
        );
      }
    }
  } else if (isNonEmptyString(summaryRel)) {
    liveErrors.push(`storm-chain: retained summary unreadable: ${summaryRel}`);
  }
  try {
    const changed = git(["diff", "--name-only", BASE_REF, "--", ".", ":(exclude)torture-test"]);
    if (changed.length > 0) {
      liveErrors.push(`storm-chain: product path differs from BASE ${BASE_REF}: ${changed}`);
    }
  } catch (err) {
    liveErrors.push(`storm-chain: cannot query git against BASE ${BASE_REF}: ${err.message}`);
  }

  console.log(`contract: ${contractPath}`);
  if (receipt) {
    console.log(
      `US-010 storm chain gate: result=${receipt.result} files=${receipt.file_count_observed}/${receipt.file_count_expected} reds=${receipt.red_file_count} tests=${receipt.totals?.tests} fail=${receipt.totals?.fail} verdict=${receipt.verdict}`,
    );
    console.log(`US-010 summary: ${summaryRel}`);
  }
  for (const arm of arms) {
    console.log(`storm-chain-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\nstorm-chain validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("storm-chain validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} storm-chain arm(s) failed`);
  } else {
    console.log(`storm-chain arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

// ── US-011 full torture battery gate ────────────────────────────────

/**
 * The glob selection `torture-test/self-tests/run.sh` iterates, in script
 * order. A file is selected when it lives directly under self-tests/ and
 * matches any of these patterns.
 */
export const BATTERY_GLOBS = Object.freeze([
  "scripted-runtime-*.test.ts",
  "scripted-scenario-*.test.ts",
  "tier0-*.test.ts",
  "tier1-*.test.ts",
  "fix10-*.test.ts",
  "tt-poly-*.test.ts",
  "tier2-*.test.ts",
]);

/**
 * The previous green battery shape the port run is compared against. Measured
 * by the union-2 candidate at bc535a44 (2026-09-15); the retained log is
 * /home/kaladin/matchlock-work/torture-union2-battery-rerun-3/battery-full.log.
 */
export const PREVIOUS_BATTERY_SHAPE = Object.freeze({
  commit: "bc535a44583f376570c7792c937674e1330ea48b",
  date: "2026-09-15",
  passed: 240,
  failed: 0,
  excluded_heavy: 18,
});

/**
 * Exactly the files added to the battery selection after the previous shape
 * (four NPF-2 tier2 self-tests landed at 0f305702 plus the port's own
 * storm base-seam conformance test). Every difference from 240 is enumerated
 * here; the port never hard-pins an unexplained total.
 */
export const EXPECTED_BATTERY_NEW_SINCE_PREVIOUS = Object.freeze([
  "torture-test/self-tests/tier2-gate-worktree-provisioning.test.ts",
  "torture-test/self-tests/tier2-npf2-docs.test.ts",
  "torture-test/self-tests/tier2-storm-base-seams.test.ts",
  "torture-test/self-tests/tier2-storm-chain-gate.test.ts",
  "torture-test/self-tests/tier2-storm-rehearsal-suite-ledger-e2e.test.ts",
]);

/** The frozen heavy-campaign exclusion count (must agree with run.sh). */
export const EXPECTED_BATTERY_EXCLUDED_HEAVY = 18;

/**
 * Frozen per-lane shapes for the US-012 product unit suite. The port never
 * edits a product file, so the two lanes against BASE 6e5f2427 are stable;
 * both were independently observed on this tree (serial 4986/4972/0/14,
 * parallel 4110/4105/0/5).
 */
export const EXPECTED_SERIAL_LANE = { tests: 4986, pass: 4972, fail: 0, skipped: 14 };
export const EXPECTED_PARALLEL_LANE = { tests: 4110, pass: 4105, fail: 0, skipped: 5 };
const PRODUCT_SUITE_LANES = {
  serial: EXPECTED_SERIAL_LANE,
  parallel: EXPECTED_PARALLEL_LANE,
};

/** Strip SGR/ANSI colour codes so retained shell logs can be parsed. */
function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Match a single `run.sh` glob (only `*` is meaningful in these patterns). */
function batteryGlobMatches(name, pattern) {
  const star = pattern.indexOf("*");
  if (star === -1) return name === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    name.length >= prefix.length + suffix.length &&
    name.startsWith(prefix) &&
    name.endsWith(suffix)
  );
}

/**
 * Read the `HEAVY_CAMPAIGN_TESTS` array from the live run.sh. Returns the
 * basenames in array order (the exact files the battery excludes).
 */
export function readBatteryHeavyList(repoRoot = REPO_ROOT) {
  const runShPath = path.join(repoRoot, "torture-test", "self-tests", "run.sh");
  const text = fs.readFileSync(runShPath, "utf8");
  const block = text.match(/HEAVY_CAMPAIGN_TESTS=\(([\s\S]*?)\n\)/);
  if (!block) return [];
  return [...block[1].matchAll(/'([^']+\.test\.ts)'/g)].map((m) => m[1]);
}

/**
 * Derive the battery selection from the live tree: every self-tests file that
 * matches a run.sh glob, split into the non-heavy set the script PASSes and the
 * heavy set it excludes. Basenames, sorted.
 */
export function deriveBatterySelection(repoRoot = REPO_ROOT) {
  const dir = path.join(repoRoot, "torture-test", "self-tests");
  const heavy = readBatteryHeavyList(repoRoot);
  const heavySet = new Set(heavy);
  const matched = fs
    .readdirSync(dir)
    .filter((name) => BATTERY_GLOBS.some((pattern) => batteryGlobMatches(name, pattern)));
  const passed = matched.filter((name) => !heavySet.has(name)).sort();
  const excluded = matched.filter((name) => heavySet.has(name)).sort();
  return {
    heavy,
    matched: matched.sort(),
    passed,
    excluded,
    passed_count: passed.length,
    excluded_count: excluded.length,
    total_count: matched.length,
  };
}

/**
 * Pure validation of the US-011 full-battery gate receipt recorded in the
 * contract. The receipt must report a green run.sh with zero failures and the
 * frozen heavy-exclusion count, pin the previous green shape, and enumerate
 * every file added since it.
 */
export function validateTortureBatteryGate(state, opts = {}) {
  const label = opts.label ?? "battery";
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${label}: battery state must be an object`];
  }
  const r = state.receipt;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    return [`${label}: contract.gateResults.US-011 missing`];
  }
  if (r.result !== "PASS") errors.push(`${label}: gateResults.US-011.result must be PASS`);
  if (r.all_exit_zero !== true) errors.push(`${label}: gateResults.US-011.all_exit_zero must be true`);
  if (r.product_file_changed !== false) {
    errors.push(`${label}: gateResults.US-011.product_file_changed must be false (no product edit)`);
  }
  if (r.guard_safe_repo_root !== true) {
    errors.push(`${label}: gateResults.US-011.guard_safe_repo_root must be true`);
  }
  if (r.verdict !== "PASS") errors.push(`${label}: gateResults.US-011.verdict must be PASS`);

  const prev = r.previous_green_shape ?? {};
  if (prev.passed !== PREVIOUS_BATTERY_SHAPE.passed) {
    errors.push(`${label}: previous_green_shape.passed ${prev.passed} != ${PREVIOUS_BATTERY_SHAPE.passed}`);
  }
  if (prev.failed !== PREVIOUS_BATTERY_SHAPE.failed) {
    errors.push(`${label}: previous_green_shape.failed ${prev.failed} != ${PREVIOUS_BATTERY_SHAPE.failed}`);
  }
  if (prev.excluded_heavy !== PREVIOUS_BATTERY_SHAPE.excluded_heavy) {
    errors.push(
      `${label}: previous_green_shape.excluded_heavy ${prev.excluded_heavy} != ${PREVIOUS_BATTERY_SHAPE.excluded_heavy}`,
    );
  }
  if (prev.commit !== PREVIOUS_BATTERY_SHAPE.commit) {
    errors.push(`${label}: previous_green_shape.commit must be ${PREVIOUS_BATTERY_SHAPE.commit}`);
  }

  const observed = r.observed ?? {};
  if (!Number.isFinite(observed.passed) || observed.passed < 0) {
    errors.push(`${label}: observed.passed must be a non-negative number`);
  }
  if (observed.failed !== 0) errors.push(`${label}: observed.failed must be 0`);
  if (observed.excluded_heavy !== EXPECTED_BATTERY_EXCLUDED_HEAVY) {
    errors.push(
      `${label}: observed.excluded_heavy ${observed.excluded_heavy} != ${EXPECTED_BATTERY_EXCLUDED_HEAVY}`,
    );
  }
  if (observed.file_records !== observed.passed + observed.failed) {
    errors.push(
      `${label}: observed.file_records ${observed.file_records} != observed.passed + observed.failed`,
    );
  }
  const expectedDelta = PREVIOUS_BATTERY_SHAPE.passed + EXPECTED_BATTERY_NEW_SINCE_PREVIOUS.length;
  if (observed.passed !== expectedDelta) {
    errors.push(
      `${label}: observed.passed ${observed.passed} != previous ${PREVIOUS_BATTERY_SHAPE.passed} + ${EXPECTED_BATTERY_NEW_SINCE_PREVIOUS.length} enumerated additions (${expectedDelta})`,
    );
  }

  const added = Array.isArray(r.new_since_previous) ? r.new_since_previous : [];
  if (added.length !== EXPECTED_BATTERY_NEW_SINCE_PREVIOUS.length) {
    errors.push(
      `${label}: new_since_previous has ${added.length} entries but expected ${EXPECTED_BATTERY_NEW_SINCE_PREVIOUS.length}`,
    );
  } else {
    for (let i = 0; i < EXPECTED_BATTERY_NEW_SINCE_PREVIOUS.length; i += 1) {
      if (added[i] !== EXPECTED_BATTERY_NEW_SINCE_PREVIOUS[i]) {
        errors.push(
          `${label}: new_since_previous[${i}] is ${JSON.stringify(added[i])}, expected ${EXPECTED_BATTERY_NEW_SINCE_PREVIOUS[i]}`,
        );
        break;
      }
    }
  }

  for (const key of ["summary_path", "full_log_path", "results_dir", "counts_note"]) {
    if (!isNonEmptyString(r[key])) errors.push(`${label}: ${key} is required`);
  }
  if (!Number.isFinite(r.wall_time_seconds) || r.wall_time_seconds <= 0) {
    errors.push(`${label}: wall_time_seconds must be a positive number`);
  }
  return errors;
}

/** Red arms for the US-011 battery gate; the unmodified live state is the control. */
export function runTortureBatteryRedArms(state) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateTortureBatteryGate(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("missing-receipt", (s) => {
    s.receipt = null;
  });
  add("result-fail", (s) => {
    s.receipt.result = "FAIL";
  });
  add("not-all-exit-zero", (s) => {
    s.receipt.all_exit_zero = false;
  });
  add("product-file-changed", (s) => {
    s.receipt.product_file_changed = true;
  });
  add("not-guard-safe", (s) => {
    s.receipt.guard_safe_repo_root = false;
  });
  add("verdict-fail", (s) => {
    s.receipt.verdict = "FAIL";
  });
  add("previous-shape-drift", (s) => {
    s.receipt.previous_green_shape.passed = 239;
  });
  add("previous-commit-drift", (s) => {
    s.receipt.previous_green_shape.commit = "0".repeat(40);
  });
  add("observed-failed", (s) => {
    s.receipt.observed.failed = 1;
  });
  add("observed-passed-drift", (s) => {
    s.receipt.observed.passed = 244;
  });
  add("observed-excluded-drift", (s) => {
    s.receipt.observed.excluded_heavy = 17;
  });
  add("file-records-inconsistent", (s) => {
    s.receipt.observed.file_records = 999;
  });
  add("missing-summary-path", (s) => {
    s.receipt.summary_path = "";
  });
  add("missing-full-log-path", (s) => {
    s.receipt.full_log_path = "";
  });
  add("missing-counts-note", (s) => {
    s.receipt.counts_note = "";
  });
  add("wall-time-nonpositive", (s) => {
    s.receipt.wall_time_seconds = 0;
  });
  add("new-file-dropped", (s) => {
    s.receipt.new_since_previous = s.receipt.new_since_previous.slice(0, -1);
  });
  add("new-file-swapped", (s) => {
    s.receipt.new_since_previous[0] = "torture-test/self-tests/tier2-not-real.test.ts";
  });

  {
    const errors = validateTortureBatteryGate(state, { label: "green-arm:battery-state" });
    arms.push({
      name: "battery-state-accepted",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}

async function runTortureBatteryCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  const receipt = contract?.gateResults?.["US-011"] ?? null;
  const state = { receipt };

  const errors = validateTortureBatteryGate(state);
  const arms = runTortureBatteryRedArms(state);

  const liveErrors = [];

  // The receipt's observed counts must equal the selection derived live from
  // the tree (run.sh globs minus its own HEAVY_CAMPAIGN_TESTS array), and every
  // enumerated addition must be a real non-heavy member of that selection.
  const selection = deriveBatterySelection();
  if (selection.excluded_count !== EXPECTED_BATTERY_EXCLUDED_HEAVY) {
    liveErrors.push(
      `battery: live heavy selection has ${selection.excluded_count} files, expected ${EXPECTED_BATTERY_EXCLUDED_HEAVY}`,
    );
  }
  if (selection.heavy.length !== EXPECTED_BATTERY_EXCLUDED_HEAVY) {
    liveErrors.push(
      `battery: run.sh HEAVY_CAMPAIGN_TESTS lists ${selection.heavy.length} files, expected ${EXPECTED_BATTERY_EXCLUDED_HEAVY}`,
    );
  }
  if (receipt) {
    if (selection.passed_count !== receipt.observed?.passed) {
      liveErrors.push(
        `battery: live non-heavy selection ${selection.passed_count} != receipt observed.passed ${receipt.observed?.passed}`,
      );
    }
    if (selection.excluded_count !== receipt.observed?.excluded_heavy) {
      liveErrors.push(
        `battery: live heavy selection ${selection.excluded_count} != receipt observed.excluded_heavy ${receipt.observed?.excluded_heavy}`,
      );
    }
    const selectionRel = new Set(
      selection.passed.map((name) => `torture-test/self-tests/${name}`),
    );
    for (const rel of EXPECTED_BATTERY_NEW_SINCE_PREVIOUS) {
      if (!selectionRel.has(rel)) {
        liveErrors.push(`battery: enumerated addition is not in the live non-heavy selection: ${rel}`);
      }
      if (!fs.existsSync(path.join(REPO_ROOT, rel))) {
        liveErrors.push(`battery: enumerated addition is missing on disk: ${rel}`);
      }
    }
  }

  // The machine-readable retained summary must exist, parse and agree.
  const summaryRel = receipt?.summary_path;
  let summary = null;
  if (isNonEmptyString(summaryRel)) {
    const summaryAbs = path.isAbsolute(summaryRel) ? summaryRel : path.join(REPO_ROOT, summaryRel);
    if (!fs.existsSync(summaryAbs)) {
      liveErrors.push(`battery: retained summary missing: ${summaryRel}`);
    } else {
      try {
        summary = JSON.parse(fs.readFileSync(summaryAbs, "utf8"));
      } catch (err) {
        liveErrors.push(`battery: retained summary is not valid JSON: ${err.message}`);
      }
    }
  }
  if (summary) {
    if (summary.kind !== "torture-battery-summary") {
      liveErrors.push(`battery: summary.kind must be torture-battery-summary (got ${JSON.stringify(summary.kind)})`);
    }
    if (summary.exit_code !== 0) liveErrors.push(`battery: summary.exit_code ${summary.exit_code} != 0`);
    if (summary.failed !== 0) liveErrors.push(`battery: summary.failed ${summary.failed} != 0`);
    if (summary.verdict !== "PASS") liveErrors.push(`battery: summary.verdict ${JSON.stringify(summary.verdict)} != PASS`);
    if (summary.guard_safe_repo_root !== true) {
      liveErrors.push("battery: summary.guard_safe_repo_root must be true");
    }
    if (summary.passed !== receipt?.observed?.passed) {
      liveErrors.push(`battery: summary.passed ${summary.passed} != receipt observed.passed ${receipt?.observed?.passed}`);
    }
    if (summary.excluded_heavy !== receipt?.observed?.excluded_heavy) {
      liveErrors.push(
        `battery: summary.excluded_heavy ${summary.excluded_heavy} != receipt observed.excluded_heavy ${receipt?.observed?.excluded_heavy}`,
      );
    }
  }

  // The retained full log must exist and carry the exact run.sh outcome.
  const logRel = receipt?.full_log_path;
  if (isNonEmptyString(logRel)) {
    const logAbs = path.isAbsolute(logRel) ? logRel : path.join(REPO_ROOT, logRel);
    if (!fs.existsSync(logAbs)) {
      liveErrors.push(`battery: retained full log missing: ${logRel}`);
    } else {
      const logText = stripAnsi(fs.readFileSync(logAbs, "utf8"));
      if (logText.length === 0) liveErrors.push("battery: retained full log is empty");
      const expectedLine = `=== Results: ${receipt?.observed?.passed} passed, 0 failed ===`;
      if (!logText.includes(expectedLine)) {
        liveErrors.push(`battery: full log is missing the exact results line: ${expectedLine}`);
      }
      const skipCount = (logText.match(/skip \(heavy\/isolated\):/g) ?? []).length;
      if (skipCount !== EXPECTED_BATTERY_EXCLUDED_HEAVY) {
        liveErrors.push(
          `battery: full log has ${skipCount} heavy-skip markers, expected ${EXPECTED_BATTERY_EXCLUDED_HEAVY}`,
        );
      }
      const passMarkers = (logText.match(/^  PASS: /gm) ?? []).length;
      const failMarkers = (logText.match(/^  FAIL: /gm) ?? []).length;
      if (passMarkers !== receipt?.observed?.passed) {
        liveErrors.push(`battery: full log has ${passMarkers} PASS markers, expected ${receipt?.observed?.passed}`);
      }
      if (failMarkers !== 0) {
        liveErrors.push(`battery: full log has ${failMarkers} FAIL markers, expected 0`);
      }
      if (!/Working tree: clean/.test(logText)) {
        liveErrors.push("battery: full log does not record a clean post-run working tree");
      }
    }
  }

  // The retained evidence directory must carry the full artifact set.
  const resultsDirRel = receipt?.results_dir;
  if (isNonEmptyString(resultsDirRel)) {
    const dirAbs = path.isAbsolute(resultsDirRel)
      ? resultsDirRel
      : path.join(REPO_ROOT, resultsDirRel);
    for (const artifact of [
      "full.log",
      "battery-summary.json",
      "battery-meta.log",
      "battery-runner.sh",
    ]) {
      if (!fs.existsSync(path.join(dirAbs, artifact))) {
        liveErrors.push(`battery: retained ${artifact} missing under ${resultsDirRel}`);
      }
    }
  }

  try {
    const changed = git(["diff", "--name-only", BASE_REF, "--", ".", ":(exclude)torture-test"]);
    if (changed.length > 0) {
      liveErrors.push(`battery: product path differs from BASE ${BASE_REF}: ${changed}`);
    }
  } catch (err) {
    liveErrors.push(`battery: cannot query git against BASE ${BASE_REF}: ${err.message}`);
  }

  console.log(`contract: ${contractPath}`);
  if (receipt) {
    console.log(
      `US-011 torture battery gate: result=${receipt.result} passed=${receipt.observed?.passed} failed=${receipt.observed?.failed} excluded=${receipt.observed?.excluded_heavy} verdict=${receipt.verdict}`,
    );
    console.log(`US-011 summary: ${summaryRel}`);
    console.log(`US-011 full log: ${logRel}`);
  }
  console.log(
    `live selection: passed=${selection.passed_count} excluded=${selection.excluded_count} total=${selection.total_count}`,
  );
  for (const arm of arms) {
    console.log(`battery-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\nbattery validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("battery validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} battery arm(s) failed`);
  } else {
    console.log(`battery arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

/**
 * Pure validation of the US-012 product build + two-lane unit-suite gate
 * receipt. The receipt must report a green `npm run build` and a green
 * `npm test` through the tamandua-test shim, both lanes PASSED with the frozen
 * per-lane counts, and an empty product-scope diff against BASE 6e5f2427.
 */
export function validateProductSuiteGate(state, opts = {}) {
  const label = opts.label ?? "product-suite";
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${label}: product-suite state must be an object`];
  }
  const r = state.receipt;
  if (!r || typeof r !== "object" || Array.isArray(r)) {
    return [`${label}: contract.gateResults.US-012 missing`];
  }
  if (r.result !== "PASS") errors.push(`${label}: gateResults.US-012.result must be PASS`);
  if (r.all_exit_zero !== true) errors.push(`${label}: gateResults.US-012.all_exit_zero must be true`);
  if (r.product_file_changed !== false) {
    errors.push(`${label}: gateResults.US-012.product_file_changed must be false (no product edit)`);
  }

  const build = r.build ?? {};
  if (build.exit_code !== 0) errors.push(`${label}: build.exit_code must be 0`);
  if (!isNonEmptyString(build.command)) errors.push(`${label}: build.command is required`);
  if (!/^[0-9a-f]{40}$/.test(build.head ?? "")) {
    errors.push(`${label}: build.head must be a 40-hex commit id`);
  }
  if (!isNonEmptyString(build.log)) errors.push(`${label}: build.log is required`);

  const suite = r.suite ?? {};
  if (suite.exit_code !== 0) errors.push(`${label}: suite.exit_code must be 0`);
  if (!isNonEmptyString(suite.command)) errors.push(`${label}: suite.command is required`);
  if (!/^[0-9a-f]{40}$/.test(suite.tree_hash ?? "")) {
    errors.push(`${label}: suite.tree_hash must be a 40-hex tree hash`);
  }
  if (typeof suite.cached !== "boolean") errors.push(`${label}: suite.cached must be a boolean`);
  if (!isNonEmptyString(suite.counts_note)) errors.push(`${label}: suite.counts_note is required`);
  if (!isNonEmptyString(suite.log)) errors.push(`${label}: suite.log is required`);
  if (!Number.isFinite(suite.duration_seconds) || suite.duration_seconds <= 0) {
    errors.push(`${label}: suite.duration_seconds must be a positive number`);
  }
  if (suite.cached === true) {
    const from = suite.cached_from ?? {};
    if (from.real_execution !== true) {
      errors.push(`${label}: cached suite must record cached_from.real_execution true`);
    }
    if (!isNonEmptyString(from.run_id)) errors.push(`${label}: cached_from.run_id is required`);
    if (!isNonEmptyString(from.step_id)) errors.push(`${label}: cached_from.step_id is required`);
    if (!isNonEmptyString(from.recorded_at_utc)) {
      errors.push(`${label}: cached_from.recorded_at_utc is required`);
    }
  }

  const lanes = suite.lanes ?? {};
  for (const [name, expected] of Object.entries(PRODUCT_SUITE_LANES)) {
    const lane = lanes[name] ?? {};
    for (const key of ["tests", "pass", "fail", "skipped"]) {
      if (lane[key] !== expected[key]) {
        errors.push(`${label}: lanes.${name}.${key} ${lane[key]} != ${expected[key]}`);
      }
    }
    if (lane.verdict !== "PASSED") {
      errors.push(`${label}: lanes.${name}.verdict must be PASSED`);
    }
    if (lane.pass + lane.fail + lane.skipped !== lane.tests) {
      errors.push(`${label}: lanes.${name}.pass + fail + skipped != tests`);
    }
  }

  const scope = r.product_scope ?? {};
  if (scope.base_ref !== BASE_REF) {
    errors.push(`${label}: product_scope.base_ref must be ${BASE_REF}`);
  }
  if (!Array.isArray(scope.changed) || scope.changed.length !== 0) {
    errors.push(`${label}: product_scope.changed must be an empty array`);
  }
  if (scope.clean !== true) errors.push(`${label}: product_scope.clean must be true`);

  if (!Number.isFinite(r.wall_time_seconds) || r.wall_time_seconds <= 0) {
    errors.push(`${label}: wall_time_seconds must be a positive number`);
  }
  return errors;
}

/** Red arms for the US-012 product-suite gate; the live state is the control. */
export function runProductSuiteRedArms(state) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateProductSuiteGate(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  add("missing-receipt", (s) => {
    s.receipt = null;
  });
  add("result-fail", (s) => {
    s.receipt.result = "FAIL";
  });
  add("not-all-exit-zero", (s) => {
    s.receipt.all_exit_zero = false;
  });
  add("product-file-changed", (s) => {
    s.receipt.product_file_changed = true;
  });
  add("build-nonzero", (s) => {
    s.receipt.build.exit_code = 1;
  });
  add("build-command-missing", (s) => {
    s.receipt.build.command = "";
  });
  add("build-head-malformed", (s) => {
    s.receipt.build.head = "not-a-commit";
  });
  add("build-log-missing", (s) => {
    s.receipt.build.log = "";
  });
  add("suite-nonzero", (s) => {
    s.receipt.suite.exit_code = 1;
  });
  add("suite-command-missing", (s) => {
    s.receipt.suite.command = "";
  });
  add("tree-hash-malformed", (s) => {
    s.receipt.suite.tree_hash = "deadbeef";
  });
  add("cached-not-boolean", (s) => {
    s.receipt.suite.cached = "yes";
  });
  add("counts-note-missing", (s) => {
    s.receipt.suite.counts_note = "";
  });
  add("duration-nonpositive", (s) => {
    s.receipt.suite.duration_seconds = 0;
  });
  add("cached-provenance-missing", (s) => {
    s.receipt.suite.cached = true;
    delete s.receipt.suite.cached_from;
  });
  add("cached-provenance-not-real", (s) => {
    s.receipt.suite.cached = true;
    s.receipt.suite.cached_from = {
      real_execution: false,
      run_id: "r",
      step_id: "s",
      recorded_at_utc: "2026-01-01T00:00:00Z",
    };
  });
  add("suite-log-missing", (s) => {
    s.receipt.suite.log = "";
  });
  add("serial-tests-drift", (s) => {
    s.receipt.suite.lanes.serial.tests = 4985;
  });
  add("serial-pass-drift", (s) => {
    s.receipt.suite.lanes.serial.pass = 4971;
  });
  add("serial-skipped-drift", (s) => {
    s.receipt.suite.lanes.serial.skipped = 13;
  });
  add("serial-fail-nonzero", (s) => {
    s.receipt.suite.lanes.serial.fail = 1;
    s.receipt.suite.lanes.serial.pass = 4971;
  });
  add("parallel-tests-drift", (s) => {
    s.receipt.suite.lanes.parallel.tests = 4109;
  });
  add("parallel-skipped-drift", (s) => {
    s.receipt.suite.lanes.parallel.skipped = 4;
  });
  add("parallel-fail-nonzero", (s) => {
    s.receipt.suite.lanes.parallel.fail = 1;
    s.receipt.suite.lanes.parallel.pass = 4104;
  });
  add("lane-verdict-fail", (s) => {
    s.receipt.suite.lanes.parallel.verdict = "FAILED";
  });
  add("lane-sum-inconsistent", (s) => {
    s.receipt.suite.lanes.serial.tests = 4987;
    s.receipt.suite.lanes.serial.pass = 4972;
    s.receipt.suite.lanes.serial.fail = 0;
  });
  add("scope-base-drift", (s) => {
    s.receipt.product_scope.base_ref = "0".repeat(8);
  });
  add("scope-changed-nonempty", (s) => {
    s.receipt.product_scope.changed = ["src/db.ts"];
  });
  add("scope-not-clean", (s) => {
    s.receipt.product_scope.clean = false;
  });
  add("wall-time-nonpositive", (s) => {
    s.receipt.wall_time_seconds = 0;
  });

  {
    const errors = validateProductSuiteGate(state, { label: "green-arm:product-suite-state" });
    arms.push({
      name: "product-suite-state-accepted",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}

async function runProductSuiteCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  const receipt = contract?.gateResults?.["US-012"] ?? null;
  const state = { receipt };

  const errors = validateProductSuiteGate(state);
  const arms = runProductSuiteRedArms(state);

  const liveErrors = [];

  // The retained build log must carry the exact build exit code and command.
  const buildLogRel = receipt?.build?.log;
  if (isNonEmptyString(buildLogRel)) {
    const buildAbs = path.isAbsolute(buildLogRel) ? buildLogRel : path.join(REPO_ROOT, buildLogRel);
    if (!fs.existsSync(buildAbs)) {
      liveErrors.push(`product-suite: retained build log missing: ${buildLogRel}`);
    } else {
      const buildText = stripAnsi(fs.readFileSync(buildAbs, "utf8"));
      if (buildText.length === 0) liveErrors.push("product-suite: retained build log is empty");
      if (!buildText.includes("BUILD_RC=0")) {
        liveErrors.push("product-suite: retained build log is missing BUILD_RC=0");
      }
      if (!/npm run build/.test(buildText)) {
        liveErrors.push("product-suite: retained build log does not show the build command");
      }
    }
  } else {
    liveErrors.push("product-suite: receipt.build.log is required");
  }

  // The retained suite log must carry the exact test exit code, both lane
  // verdicts and the per-lane node:test summaries. A cached replay additionally
  // carries the cache banner naming the recorded tree; a real run must not.
  const suiteLogRel = receipt?.suite?.log;
  if (isNonEmptyString(suiteLogRel)) {
    const suiteAbs = path.isAbsolute(suiteLogRel) ? suiteLogRel : path.join(REPO_ROOT, suiteLogRel);
    if (!fs.existsSync(suiteAbs)) {
      liveErrors.push(`product-suite: retained suite log missing: ${suiteLogRel}`);
    } else {
      const suiteText = stripAnsi(fs.readFileSync(suiteAbs, "utf8"));
      if (suiteText.length === 0) liveErrors.push("product-suite: retained suite log is empty");
      if (!suiteText.includes("TEST_RC=0")) {
        liveErrors.push("product-suite: retained suite log is missing TEST_RC=0");
      }
      if (!/>>> SERIAL lane: PASSED/.test(suiteText) && !/Serial lane:\s+PASSED/.test(suiteText)) {
        liveErrors.push("product-suite: retained suite log does not show the serial lane PASSED");
      }
      if (!/>>> PARALLEL lane: PASSED/.test(suiteText) && !/Parallel lane:\s+PASSED/.test(suiteText)) {
        liveErrors.push("product-suite: retained suite log does not show the parallel lane PASSED");
      }
      for (const [name, lane] of Object.entries(PRODUCT_SUITE_LANES)) {
        for (const key of ["tests", "pass", "fail", "skipped"]) {
          if (!new RegExp(`${key} ${lane[key]}\\b`).test(suiteText)) {
            liveErrors.push(
              `product-suite: retained suite log does not report ${name} ${key} ${lane[key]}`,
            );
          }
        }
      }
      if (receipt?.suite?.cached === true) {
        if (!suiteText.includes("TAMANDUA-TEST CACHED")) {
          liveErrors.push("product-suite: cached suite log is missing the TAMANDUA-TEST CACHED banner");
        }
        const prefix = (receipt?.suite?.tree_hash ?? "").slice(0, 12);
        if (prefix.length === 12 && !suiteText.includes(`tree ${prefix}`)) {
          liveErrors.push(`product-suite: cached suite log does not name tree ${prefix}`);
        }
      } else if (/TAMANDUA-TEST CACHED/.test(suiteText)) {
        liveErrors.push(
          "product-suite: suite.cached is false but the suite log shows a TAMANDUA-TEST CACHED replay",
        );
      }
    }
  } else {
    liveErrors.push("product-suite: receipt.suite.log is required");
  }

  // Live product-scope audit: no path outside torture-test/ may differ from BASE.
  try {
    const changedText = git(["diff", "--name-only", BASE_REF, "--", ".", ":(exclude)torture-test"]);
    const changed = changedText.length === 0
      ? []
      : changedText.split("\n").map((l) => l.trim()).filter(Boolean);
    const recorded = Array.isArray(receipt?.product_scope?.changed)
      ? receipt.product_scope.changed
      : null;
    if (changed.length > 0) {
      liveErrors.push(`product-suite: product path differs from BASE ${BASE_REF}: ${changed}`);
    }
    if (recorded !== null && JSON.stringify(recorded) !== JSON.stringify(changed)) {
      liveErrors.push(
        `product-suite: recorded product_scope.changed ${JSON.stringify(recorded)} != live ${JSON.stringify(changed)}`,
      );
    }
  } catch (err) {
    liveErrors.push(`product-suite: cannot query git against BASE ${BASE_REF}: ${err.message}`);
  }

  console.log(`contract: ${contractPath}`);
  if (receipt) {
    const lanes = receipt.suite?.lanes ?? {};
    console.log(
      `US-012 product gate: result=${receipt.result} build=${receipt.build?.exit_code} suite=${receipt.suite?.exit_code} cached=${receipt.suite?.cached}`,
    );
    console.log(
      `US-012 lanes: serial ${lanes.serial?.pass}/${lanes.serial?.tests} (${lanes.serial?.verdict}), parallel ${lanes.parallel?.pass}/${lanes.parallel?.tests} (${lanes.parallel?.verdict}), product_scope.changed=${JSON.stringify(receipt.product_scope?.changed)}`,
    );
  }
  for (const arm of arms) {
    console.log(`product-suite-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\nproduct-suite validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("product-suite validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} product-suite arm(s) failed`);
  } else {
    console.log(`product-suite arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

// --- US-013 final contract: every gate result + final scope audit -----------

/**
 * Every gate result the port produced. US-003..US-008 carry their story
 * receipts; US-009..US-012 are revalidated against the four headline gate
 * validators (counts and shapes are pinned by those functions).
 */
export const REQUIRED_GATE_IDS = Object.freeze([
  "US-003",
  "US-004",
  "US-005",
  "US-006",
  "US-007",
  "US-008",
  "US-009",
  "US-010",
  "US-011",
  "US-012",
]);

/** The four headline gate counts the US-013 acceptance criteria pin. */
export const EXPECTED_GATE_SUMMARY = Object.freeze({
  self_tests_alone: { total_required: 14, passed_required: 14, failed_required: 0, red_files: 0 },
  storm_chain: { file_count: 49, red_file_count: 0 },
  battery: { failed: 0, excluded_heavy: 18 },
  product_suite: {
    build_exit_code: 0,
    suite_exit_code: 0,
    serial_verdict: "PASSED",
    parallel_verdict: "PASSED",
    serial_fail: 0,
    parallel_fail: 0,
  },
});

/** Extract the headline gate counts from a contract for comparison/logging. */
export function gateSummaryFromContract(contract) {
  const gates = contract?.gateResults ?? {};
  const s9 = gates["US-009"] ?? {};
  const s10 = gates["US-010"] ?? {};
  const s11 = gates["US-011"] ?? {};
  const s12 = gates["US-012"] ?? {};
  const redFiles = s9.red_files;
  return {
    self_tests_alone: {
      total_required: s9.total_required,
      passed_required: s9.passed_required,
      failed_required: s9.failed_required,
      red_files: Array.isArray(redFiles) ? redFiles.length : redFiles,
    },
    storm_chain: {
      file_count: s10.file_count_observed,
      red_file_count: s10.red_file_count,
    },
    battery: {
      failed: s11.observed?.failed,
      excluded_heavy: s11.observed?.excluded_heavy,
    },
    product_suite: {
      build_exit_code: s12.build?.exit_code,
      suite_exit_code: s12.suite?.exit_code,
      serial_verdict: s12.suite?.lanes?.serial?.verdict,
      parallel_verdict: s12.suite?.lanes?.parallel?.verdict,
      serial_fail: s12.suite?.lanes?.serial?.fail,
      parallel_fail: s12.suite?.lanes?.parallel?.fail,
    },
  };
}

/**
 * Validate the US-013 final contract: every required gate result is present
 * with result PASS, the four headline gates keep their counts (reusing the
 * per-story validators), and the final scope audit records an empty product
 * diff against BASE 6e5f2427.
 */
export function validateGates(state, opts = {}) {
  const label = opts.label ?? "gates";
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return [`${label}: gates state must be an object`];
  }
  const gates = state.gateResults;
  if (!gates || typeof gates !== "object" || Array.isArray(gates)) {
    return [`${label}: contract.gateResults must be an object`];
  }
  for (const id of REQUIRED_GATE_IDS) {
    const r = gates[id];
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      errors.push(`${label}: gateResults.${id} missing`);
      continue;
    }
    if (r.result !== "PASS") errors.push(`${label}: gateResults.${id}.result must be PASS`);
    if (!isNonEmptyString(r.story)) errors.push(`${label}: gateResults.${id}.story is required`);
  }

  const headline = [
    ["US-009", validateSelfTestsAloneGate],
    ["US-010", validateStormChainGate],
    ["US-011", validateTortureBatteryGate],
    ["US-012", validateProductSuiteGate],
  ];
  for (const [id, fn] of headline) {
    if (!gates[id]) continue; // already reported as missing above
    for (const e of fn({ receipt: gates[id] }, { label: `${label}:${id}` })) {
      errors.push(e);
    }
  }

  const audit = state.finalScopeAudit;
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) {
    errors.push(`${label}: contract.finalScopeAudit missing`);
  } else {
    if (audit.base_ref !== BASE_REF) {
      errors.push(`${label}: finalScopeAudit.base_ref must be ${BASE_REF}`);
    }
    if (!Array.isArray(audit.changed) || audit.changed.length !== 0) {
      errors.push(`${label}: finalScopeAudit.changed must be an empty array`);
    }
    if (audit.scope_clean !== true) {
      errors.push(`${label}: finalScopeAudit.scope_clean must be true`);
    }
    if (!isNonEmptyString(audit.command)) {
      errors.push(`${label}: finalScopeAudit.command is required`);
    }
  }
  return errors;
}

/** Red arms for the US-013 gates + scope audit; the live state is the control. */
export function runGatesRedArms(state) {
  const arms = [];
  const add = (name, mutate) => {
    const copy = clone(state);
    mutate(copy);
    const errors = validateGates(copy, { label: "red-arm:" + name });
    const matched = errors.length > 0;
    arms.push({
      name,
      ok: matched,
      detail: matched ? "rejected as expected" : "NOT rejected (red arm failed)",
    });
  };

  // The US-013 acceptance red arm: a missing gate result must fail.
  add("missing-gate-result-US-009", (s) => {
    delete s.gateResults["US-009"];
  });
  add("missing-gate-result-US-010", (s) => {
    delete s.gateResults["US-010"];
  });
  add("missing-gate-result-US-011", (s) => {
    delete s.gateResults["US-011"];
  });
  add("missing-gate-result-US-012", (s) => {
    delete s.gateResults["US-012"];
  });
  add("missing-gate-result-US-003", (s) => {
    delete s.gateResults["US-003"];
  });
  add("gate-result-fail", (s) => {
    s.gateResults["US-011"].result = "FAIL";
  });
  add("gate-story-missing", (s) => {
    s.gateResults["US-004"].story = "";
  });
  add("self-tests-count-drift", (s) => {
    s.gateResults["US-009"].total_required = 13;
  });
  add("self-tests-pass-drift", (s) => {
    s.gateResults["US-009"].passed_required = 13;
  });
  add("self-tests-red-file", (s) => {
    s.gateResults["US-009"].red_files = ["some-self-test.test.mjs"];
  });
  add("storm-file-count-drift", (s) => {
    s.gateResults["US-010"].file_count_observed = 48;
  });
  add("storm-red-file-count", (s) => {
    s.gateResults["US-010"].red_file_count = 1;
  });
  add("battery-failed", (s) => {
    s.gateResults["US-011"].observed.failed = 1;
  });
  add("battery-excluded-heavy-drift", (s) => {
    s.gateResults["US-011"].observed.excluded_heavy = 17;
  });
  add("build-exit-nonzero", (s) => {
    s.gateResults["US-012"].build.exit_code = 1;
  });
  add("suite-exit-nonzero", (s) => {
    s.gateResults["US-012"].suite.exit_code = 1;
  });
  add("serial-lane-fail", (s) => {
    s.gateResults["US-012"].suite.lanes.serial.verdict = "FAILED";
  });
  add("parallel-lane-fail", (s) => {
    s.gateResults["US-012"].suite.lanes.parallel.verdict = "FAILED";
  });
  add("scope-audit-missing", (s) => {
    s.finalScopeAudit = null;
  });
  add("scope-audit-base-drift", (s) => {
    s.finalScopeAudit.base_ref = "0".repeat(8);
  });
  add("scope-audit-changed", (s) => {
    s.finalScopeAudit.changed = ["src/db.ts"];
  });
  add("scope-audit-not-clean", (s) => {
    s.finalScopeAudit.scope_clean = false;
  });
  add("scope-audit-command-missing", (s) => {
    s.finalScopeAudit.command = "";
  });

  {
    const errors = validateGates(state, { label: "green-arm:gates-state" });
    arms.push({
      name: "gates-state-accepted",
      ok: errors.length === 0,
      detail: errors.length === 0 ? "accepted as expected" : `NOT accepted: ${errors.join("; ")}`,
    });
  }
  return arms;
}

async function runGatesCheck() {
  const contractPath = getArg("--contract") ?? DEFAULT_CONTRACT;
  if (!fs.existsSync(contractPath)) {
    console.error(`torture-port-verify: contract not found: ${contractPath}`);
    return 1;
  }
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  } catch (err) {
    console.error(`torture-port-verify: contract is not valid JSON: ${err.message}`);
    return 1;
  }

  const state = {
    gateResults: contract?.gateResults ?? {},
    finalScopeAudit: contract?.finalScopeAudit ?? null,
  };
  const errors = validateGates(state);
  const arms = runGatesRedArms(state);
  const liveErrors = [];

  // Live final scope audit: no path outside torture-test/ may differ from BASE,
  // and the recorded audit must agree with the live diff.
  try {
    const changedText = git(["diff", "--name-only", BASE_REF, "--", ".", ":(exclude)torture-test"]);
    const changed = changedText.length === 0
      ? []
      : changedText.split("\n").map((l) => l.trim()).filter(Boolean);
    if (changed.length > 0) {
      liveErrors.push(`gates: product path differs from BASE ${BASE_REF}: ${JSON.stringify(changed)}`);
    }
    const recorded = Array.isArray(contract?.finalScopeAudit?.changed)
      ? contract.finalScopeAudit.changed
      : null;
    if (recorded !== null && JSON.stringify(recorded) !== JSON.stringify(changed)) {
      liveErrors.push(
        `gates: finalScopeAudit.changed ${JSON.stringify(recorded)} != live ${JSON.stringify(changed)}`,
      );
    }
  } catch (err) {
    liveErrors.push(`gates: cannot query git against BASE ${BASE_REF}: ${err.message}`);
  }

  console.log(`contract: ${contractPath}`);
  const summary = gateSummaryFromContract(contract);
  console.log(
    `US-013 gates: ${REQUIRED_GATE_IDS.filter((id) => contract?.gateResults?.[id]).length}/${REQUIRED_GATE_IDS.length} recorded, all PASS=${REQUIRED_GATE_IDS.every((id) => contract?.gateResults?.[id]?.result === "PASS")}`,
  );
  console.log(`US-013 summary: ${JSON.stringify(summary)}`);
  console.log(
    `US-013 final scope: base=${contract?.finalScopeAudit?.base_ref} changed=${JSON.stringify(contract?.finalScopeAudit?.changed)} clean=${contract?.finalScopeAudit?.scope_clean}`,
  );
  for (const arm of arms) {
    console.log(`gates-arm ${arm.ok ? "PASS" : "FAIL"}: ${arm.name} — ${arm.detail}`);
  }
  const failedArms = arms.filter((a) => !a.ok);
  const allErrors = [...errors, ...liveErrors];
  if (allErrors.length > 0) {
    console.error(`\ngates validation FAILED with ${allErrors.length} error(s):`);
    for (const e of allErrors) console.error(`  - ${e}`);
  } else {
    console.log("gates validation: PASS");
  }
  if (failedArms.length > 0) {
    console.error(`${failedArms.length} gates arm(s) failed`);
  } else {
    console.log(`gates arms: ${arms.length}/${arms.length} PASS`);
  }
  return allErrors.length === 0 && failedArms.length === 0 ? 0 : 1;
}

/** Every check, in dependency order; used by `--check all`. */
const ALL_CHECK_ORDER = [
  "contract",
  "overlay",
  "environment",
  "aged",
  "o12",
  "storm",
  "core-recording",
  "self-tests-alone",
  "storm-chain",
  "battery",
  "product-suite",
  "gates",
];

async function runAllChecks() {
  const results = [];
  let failed = 0;
  for (const name of ALL_CHECK_ORDER) {
    console.log(`\n========== --check ${name} ==========`);
    const rc = await CHECKS[name]();
    results.push({ name, rc });
    if (rc !== 0) failed += 1;
  }
  console.log("\n========== --check all summary ==========");
  for (const r of results) {
    console.log(`all-check ${r.rc === 0 ? "PASS" : "FAIL"}: ${r.name}`);
  }
  if (failed > 0) {
    console.error(`--check all: ${failed} of ${results.length} check(s) failed`);
    return 1;
  }
  console.log(`--check all: ${results.length}/${results.length} checks PASS`);
  return 0;
}

const CHECKS = {
  contract: runContractCheck,
  overlay: runOverlayCheck,
  environment: runEnvironmentCheck,
  aged: runAgedCheck,
  o12: runO12Check,
  storm: runStormCheck,
  "core-recording": runCoreRecordingCheck,
  "self-tests-alone": runSelfTestsAloneCheck,
  "storm-chain": runStormChainCheck,
  battery: runTortureBatteryCheck,
  "product-suite": runProductSuiteCheck,
  gates: runGatesCheck,
  all: runAllChecks,
};

async function main() {
  const idx = process.argv.indexOf("--check");
  const check = idx === -1 ? "contract" : process.argv[idx + 1];
  const fn = CHECKS[check];
  if (!fn) {
    console.error(
      `torture-port-verify: unknown check ${JSON.stringify(check)}; known checks: ${Object.keys(CHECKS).join(", ")}`,
    );
    process.exit(2);
  }
  process.exit(await fn());
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) main();
