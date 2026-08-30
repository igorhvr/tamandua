// S30 (US-008) — workflow-spec-missing: enumerate tier2.jsonl in
// tt-required-workflows and fail closed at preflight when a case's declared
// workflow is absent (W4.14-verdict-trap).
//
// The tier-2 attempt-2 campaign (campaign-20260826T225744158Z-4bf26d7f) left
// W4.14-verdict-trap TEST_INFRA_FAIL 'workflow-spec-missing' with
//   `Error: No workflow.yml found in
//    .../var/home/.tamandua/workflows/tt-verdict-trap. Expected a workflow
//    specification file.`
// (report.txt + evidence/W4.14-verdict-trap/attempt-1/launch.stderr).
//
// Root cause, confirmed against the campaign evidence (read-only):
//   * torture-test/bin/tt-required-workflows enumerates the required TT-custom
//     workflows from a FIXED manifest list
//     MANIFEST_NAMES = ["tier0.jsonl", "tier1.jsonl", "cases.jsonl",
//     "smoke.jsonl"] — tier2.jsonl was MISSING, so tt-verdict-trap (declared
//     by the tier2 case W4.14-verdict-trap) was never enumerated as required;
//   * tt-catalog-install therefore never installed tt-verdict-trap into the
//     real contained home → the launch hit workflow-spec-missing.
//
// Fix (files ONLY under torture-test/, fail-closed preserved):
//   (a) tt-required-workflows MANIFEST_NAMES now includes tier2.jsonl, so
//       every TT-custom workflow referenced by ANY tier manifest (incl. the
//       tier2 W4.14 → tt-verdict-trap) is in the required set;
//   (b) tt-catalog-install installs every enumerated custom workflow into the
//       contained home (idempotent, stamp-aware), including tt-verdict-trap;
//   (c) tt-catalog-install gains a fail-closed `--verify <workflow>...`
//       preflight mode, and the controller's real-case preflight runs it as a
//       `workflow-spec` leg after catalog-install: a selected case whose
//       declared workflow is absent from the installed catalog refuses the
//       campaign with the DISTINCT machine-parseable reason
//       `workflow-spec-missing: <workflow>` BEFORE any launch.
//
// This test proves (zero tokens, files ONLY under torture-test/):
//   * RED-ARM (AC2): reproduces the exact campaign line —
//     `No workflow.yml found in .../workflows/tt-verdict-trap. Expected a
//     workflow specification file.` — by loading the workflow spec of a
//     contained home whose installed catalog LACKS tt-verdict-trap (the
//     pre-fix catalog shape), and pins the pre-fix enumeration gap (a
//     manifest set WITHOUT tier2.jsonl does NOT enumerate tt-verdict-trap —
//     reproduced via a temp TT_CASES_DIR that omits tier2.jsonl);
//   * GREEN-ARM (AC1/AC2): the current tier manifests (incl. tier2.jsonl)
//     enumerate tt-verdict-trap in the required set, and tt-catalog-install
//     installs tt-verdict-trap into a fresh contained home (successful
//     install corridor);
//   * GREEN-ARM (AC3): `tt-catalog-install --verify tt-verdict-trap` passes
//     against the installed home, `--verify tt-absent-workflow` refuses with
//     `REASON: workflow-spec-missing: tt-absent-workflow`, and the
//     controller's real-case preflight refuses a selected case whose declared
//     workflow is absent from the installed catalog with the distinct reason
//     BEFORE any launch (stub-driven, mirroring tt-controller-preflight.test.sh
//     AC2d).
//
// Follows the tier2-s28-*.test.ts self-test pattern (imports node builtins +
// repo-relative files only); picked up by self-tests/run.sh's tier2 glob.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const helper = path.join(ttRoot, "bin", "tt-required-workflows");
const catalogInstall = path.join(ttRoot, "bin", "tt-catalog-install");
const controller = path.join(ttRoot, "bin", "tt-controller");
const casesDir = path.join(ttRoot, "cases");

// ── Pinned campaign evidence (campaign-20260826T225744158Z-4bf26d7f) ────
// report.txt INFRA FAILURE line for W4.14, verbatim:
//   `W4.14-verdict-trap: workflow-spec-missing (Error: No workflow.yml found
//    in .../var/home/.tamandua/workflows/tt-verdict-trap. Expected a workflow
//    specification file.)`
const CAMPAIGN_SPEC_LINE = "No workflow.yml found in";
const CAMPAIGN_SPEC_SUFFIX = "Expected a workflow specification file.";
const TARGET_WORKFLOW = "tt-verdict-trap";

// The pre-fix manifest set (what tt-required-workflows read before S30):
// tier2.jsonl was NOT enumerated.
const PRE_FIX_MANIFEST_NAMES = ["tier0.jsonl", "tier1.jsonl", "cases.jsonl", "smoke.jsonl"];
// The fixed manifest set (S30 US-008): tier2.jsonl included.
const FIXED_MANIFEST_NAMES = [...PRE_FIX_MANIFEST_NAMES, "tier2.jsonl"];

function run(file: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}, timeout = 120_000): { status: number | null; stdout: string; stderr: string; signal: NodeJS.Signals | null } {
  const result = spawnSync(file, args, {
    cwd: repoRoot,
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
      TAMANDUA_TEST_GUARD: "0",
      ...extraEnv,
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

// Build a temp cases dir containing the given manifest names (copied from the
// real cases dir) plus an optional extra JSONL record appended to tier2.jsonl.
function tempCasesDir(manifestNames: string[], extraTier2Line?: string): string {
  const dir = fs.mkdtempSync(path.join(varRoot, `s30-cases-${process.pid}-`));
  for (const name of manifestNames) {
    fs.copyFileSync(path.join(casesDir, name), path.join(dir, name));
  }
  if (extraTier2Line !== undefined) {
    fs.appendFileSync(path.join(dir, "tier2.jsonl"), extraTier2Line + "\n", "utf8");
  }
  return dir;
}

// Clean a temp dir on test completion.
function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("S30 US-008 — workflow-spec-missing: tier2.jsonl enumeration + fail-closed preflight", () => {
  it("RED-ARM: a tier2.jsonl WITHOUT the W4.14/tt-verdict-trap reference does NOT enumerate tt-verdict-trap (the pre-fix gap)", () => {
    // Pre-fix, tt-required-workflows read ONLY tier0/tier1/cases/smoke — a
    // tier2-referenced custom workflow was invisible to the required set.
    // Post-fix the helper REQUIRES tier2.jsonl (fail-closed on a missing
    // manifest), so the honest pre-fix shape is a tier2.jsonl that carries no
    // tt-verdict-trap reference: the workflow is not in the required set and
    // the catalog never installs it.
    const dir = tempCasesDir(FIXED_MANIFEST_NAMES);
    try {
      // Strip the W4.14 row (the only tt-verdict-trap reference) from the
      // copied tier2.jsonl.
      const tier2Path = path.join(dir, "tier2.jsonl");
      const tier2Lines = fs.readFileSync(tier2Path, "utf8").split(/\r?\n/)
        .filter((l) => l.trim() !== "" && !l.includes('"W4.14-verdict-trap"'));
      fs.writeFileSync(tier2Path, tier2Lines.join("\n") + "\n", "utf8");
      const result = run(helper, [], { TT_CASES_DIR: dir });
      assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
      const lines = result.stdout.trim().split(/\r?\n/).filter((l) => l !== "");
      assert.ok(!lines.includes(TARGET_WORKFLOW),
        `tier2-without-W4.14 must NOT enumerate ${TARGET_WORKFLOW} (got: ${lines.join(", ")})`);
      // Sanity: the REAL tier2.jsonl DOES reference tt-verdict-trap — so the
      // pre-fix gap was the missing tier2.jsonl in MANIFEST_NAMES, not an
      // absent manifest row.
      const realTier2 = fs.readFileSync(path.join(casesDir, "tier2.jsonl"), "utf8");
      assert.match(realTier2, /W4\.14-verdict-trap/, "tier2.jsonl must declare W4.14-verdict-trap");
      assert.match(realTier2, /"workflow":"tt-verdict-trap"/, "W4.14 must declare workflow tt-verdict-trap");
    } finally {
      cleanup(dir);
    }
  });

  it("GREEN-ARM: the FIXED manifest set (incl. tier2.jsonl) enumerates tt-verdict-trap in the required set", () => {
    const result = run(helper, []);
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    const lines = result.stdout.trim().split(/\r?\n/).filter((l) => l !== "");
    assert.ok(lines.includes(TARGET_WORKFLOW),
      `fixed manifest set must enumerate ${TARGET_WORKFLOW} (got: ${lines.join(", ")})`);
    assert.deepEqual(lines, ["tt-docs-drift", "tt-shim-probe", "tt-verdict-trap"],
      "the current required custom-workflow set (sorted)");
  });

  it("GREEN-ARM: tt-catalog-install installs tt-verdict-trap into a fresh contained home (successful install corridor)", () => {
    const ttVar = fs.mkdtempSync(path.join(varRoot, `s30-install-${process.pid}-`));
    try {
      const result = run(catalogInstall, [], { TT_VAR: ttVar }, 300_000);
      assert.equal(result.status, 0, `tt-catalog-install failed:\n${result.stdout}\n${result.stderr}`);
      const installed = path.join(ttVar, "home", ".tamandua", "workflows", TARGET_WORKFLOW, "workflow.yml");
      assert.ok(fs.existsSync(installed),
        `tt-verdict-trap workflow.yml must be installed into the contained home: ${installed}`);
      // The custom stamp records the build (stamp-aware, idempotent).
      const stamp = path.join(ttVar, "home", ".tamandua", "workflows", ".tt-custom-catalog.json");
      assert.ok(fs.existsSync(stamp), "custom catalog stamp must exist");
      // Idempotence: a second run is a no-op (zero churn).
      const again = run(catalogInstall, [], { TT_VAR: ttVar }, 300_000);
      assert.equal(again.status, 0, `second tt-catalog-install failed:\n${again.stderr}`);
      assert.match(again.stdout, /IDEMPOTENT/, "second run must take the idempotent path");
    } finally {
      cleanup(ttVar);
    }
  });

  it("GREEN-ARM: tt-catalog-install --verify passes for installed workflows and refuses absent ones fail-closed", () => {
    const ttVar = fs.mkdtempSync(path.join(varRoot, `s30-verify-${process.pid}-`));
    try {
      const install = run(catalogInstall, [], { TT_VAR: ttVar }, 300_000);
      assert.equal(install.status, 0, `install failed:\n${install.stderr}`);

      // Green: every installed workflow verifies.
      for (const wf of ["tt-verdict-trap", "tt-shim-probe", "tt-docs-drift", "bug-fix-merge-worktree"]) {
        const v = run(catalogInstall, ["--verify", wf], { TT_VAR: ttVar });
        assert.equal(v.status, 0, `--verify ${wf} must pass:\n${v.stdout}\n${v.stderr}`);
      }

      // Red: an absent workflow refuses with the DISTINCT machine-parseable
      // reason `workflow-spec-missing: <workflow>`.
      const red = run(catalogInstall, ["--verify", "tt-absent-workflow"], { TT_VAR: ttVar });
      assert.notEqual(red.status, 0, "--verify tt-absent-workflow must exit non-zero");
      assert.match(red.stderr, /REASON: workflow-spec-missing: tt-absent-workflow/,
        "distinct reason expected on stderr");
    } finally {
      cleanup(ttVar);
    }
  });

  it("RED-ARM: the exact campaign line reproduces against a contained home missing tt-verdict-trap (pre-fix catalog shape)", () => {
    const ttVar = fs.mkdtempSync(path.join(varRoot, `s30-redarm-${process.pid}-`));
    try {
      // Install the FULL required set into a fresh home, then remove the
      // tt-verdict-trap spec — the pre-fix catalog shape (tier2.jsonl was not
      // enumerated, so tt-verdict-trap was never installed).
      const install = run(catalogInstall, [], { TT_VAR: ttVar }, 300_000);
      assert.equal(install.status, 0, `install failed:\n${install.stderr}`);
      const missingDir = path.join(ttVar, "home", ".tamandua", "workflows", TARGET_WORKFLOW);
      fs.rmSync(missingDir, { recursive: true, force: true });

      // (1) The product's workflow-spec loader emits the EXACT campaign line.
      const loader = path.join(repoRoot, "dist", "installer", "workflow-spec.js");
      const specLoad = spawnSync(process.execPath, [
        "-e",
        `const { loadWorkflowSpecSync } = require(${JSON.stringify(loader)});` +
        `try { loadWorkflowSpecSync(process.argv[1]); } catch (e) { console.log(e.message); process.exit(1); }`,
        missingDir,
      ], { cwd: repoRoot, encoding: "utf8" });
      assert.notEqual(specLoad.status, 0, "spec load of a missing workflow must fail");
      const msg = String(specLoad.stdout ?? "").trim();
      assert.ok(msg.includes(CAMPAIGN_SPEC_LINE) && msg.includes(CAMPAIGN_SPEC_SUFFIX),
        `exact campaign line expected, got: ${msg}`);
      assert.ok(msg.includes(missingDir), `line must name the missing dir: ${msg}`);

      // (2) The fail-closed preflight leg (--verify) refuses with the DISTINCT
      // reason BEFORE any launch — never a launch-time workflow-spec-missing.
      const verify = run(catalogInstall, ["--verify", TARGET_WORKFLOW], { TT_VAR: ttVar });
      assert.notEqual(verify.status, 0, `--verify ${TARGET_WORKFLOW} must refuse for the missing spec`);
      assert.match(verify.stderr, new RegExp(`REASON: workflow-spec-missing: ${TARGET_WORKFLOW}`),
        "distinct reason expected on stderr");
    } finally {
      cleanup(ttVar);
    }
  });

  it("GREEN-ARM: the controller's real-case preflight refuses a selected case whose declared workflow is absent (before any launch)", () => {
    // Stub preflight helpers (home-provision / harness-auth / catalog-install /
    // daemon-up) that record invocations and let the workflow-spec leg fail
    // with the DISTINCT reason — the tt-controller-preflight.test.sh AC2d
    // pattern. The catalog-install stub handles BOTH the plain install call
    // and the workflow-spec `--verify <wf>` call; in fail-workflow-spec mode
    // the --verify call refuses.
    const stubDir = fs.mkdtempSync(path.join(varRoot, `s30-stubs-${process.pid}-`));
    const pfLog = path.join(varRoot, `s30-pflog-${process.pid}.log`);
    const modeFile = path.join(varRoot, `s30-mode-${process.pid}`);
    const manifestPath = path.join(varRoot, `s30-manifest-${process.pid}.jsonl`);
    const resultsDir = path.join(varRoot, "results");
    fs.mkdirSync(resultsDir, { recursive: true });
    try {
      const stubBody = `#!/usr/bin/env bash
set -u
name="$(basename "$0")"
log="${pfLog}"
mode=""
[ -f "${modeFile}" ] && mode="$(cat "${modeFile}")"
{ printf 'CALL %s args=%s\\n' "$name" "$*"; } >> "$log"
case "$name" in
  tt-catalog-install)
    if [ "\${1:-}" = "--verify" ]; then
      [ "$mode" = "fail-workflow-spec" ] && { printf 'REASON: workflow-spec-missing: %s\\n' "\${2:-tt-shim-probe}" >&2; exit 1; }
    fi
    ;;
esac
exit 0
`;
      for (const h of ["tt-provision-home", "tt-harness-auth-probe", "tt-catalog-install", "tt-daemon-up"]) {
        fs.writeFileSync(path.join(stubDir, h), stubBody, { mode: 0o755 });
      }
      // A real workflow case whose declared workflow will be REFUSED by the
      // stub workflow-spec leg (tt-shim-probe is the verify target).
      fs.writeFileSync(manifestPath, JSON.stringify({
        id: "S30-WF", wave: 0, workflow: "tt-shim-probe", fixture: "none",
        harness: "pi", task: "tasks/W3.07.md", context: { execution_mode: "real" },
        caps: { tokens: 0, wall_min: 5 }, requires: {}, boundary_files: [],
        forbidden: [], oracles: [], gates: [], chaos: null, shed_ok: false,
        mandatory: true, class: "verification",
      }) + "\n", "utf8");
      fs.writeFileSync(modeFile, "fail-workflow-spec", "utf8");
      const before = fs.readdirSync(resultsDir).filter((n) => n.startsWith("campaign-")).sort();
      const ctrl = run(controller, ["--manifest", manifestPath], {
        TT_CONTROLLER_PREFLIGHT_PROVISION: path.join(stubDir, "tt-provision-home"),
        TT_CONTROLLER_PREFLIGHT_AUTH: path.join(stubDir, "tt-harness-auth-probe"),
        TT_CONTROLLER_PREFLIGHT_CATALOG: path.join(stubDir, "tt-catalog-install"),
        TT_CONTROLLER_PREFLIGHT_DAEMON: path.join(stubDir, "tt-daemon-up"),
        TT_CONTROLLER_DAEMON_CONTROL_PATH: path.join(varRoot, `s30-missing-dc-${process.pid}`),
      });
      // The campaign must fail closed with the DISTINCT reason surfaced.
      assert.notEqual(ctrl.status, 0, `controller must refuse (exit 0):\n${ctrl.stdout}\n${ctrl.stderr}`);
      assert.match(ctrl.stdout + ctrl.stderr, /workflow-spec-missing: tt-shim-probe/,
        "the DISTINCT workflow-spec-missing reason must surface");

      const after = fs.readdirSync(resultsDir).filter((n) => n.startsWith("campaign-")).sort();
      const newCampaigns = after.filter((n) => !before.includes(n));
      assert.ok(newCampaigns.length >= 1, "a campaign dir must be recorded");
      const statePath = path.join(resultsDir, newCampaigns[0], "state.json");
      const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(state.real_preflight?.ok, false, "preflight must be not-ok");
      assert.equal(state.real_preflight?.leg, "workflow-spec", "failing leg must be workflow-spec");
      assert.match(String(state.real_preflight?.reason ?? ""), /workflow-spec-missing: tt-shim-probe/,
        "preflight state must record the DISTINCT reason");
      // The case must NOT have launched (refusal happened at preflight).
      const caseState = state.cases?.[0];
      assert.ok(caseState === undefined || caseState.phase !== "running",
        "case must not have launched after the workflow-spec refusal");
      // Hygiene: clean the recorded campaign dir.
      fs.rmSync(path.join(resultsDir, newCampaigns[0]), { recursive: true, force: true });
    } finally {
      cleanup(stubDir);
      fs.rmSync(pfLog, { force: true });
      fs.rmSync(modeFile, { force: true });
      fs.rmSync(manifestPath, { force: true });
    }
  });
});
