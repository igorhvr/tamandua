// Tier-0 tracked-tree scenario-assets guard (T2.1 EMERGENCY, US-002).
//
// bin/tt-tier0-assets must verify every manifest-referenced scenario dir
// (scenarios/w0.9, w4.25, w4.35/*, w4.49/*) EXISTS IN THE TRACKED TREE via
// `git ls-files` — filesystem existence alone must never satisfy the check,
// so an untracked-asset GREEN (assets present only under gitignored var/ or
// as untracked files in the authoring worktree) is impossible for any tier.
//
// Green arm: the real cases/tier0.jsonl still exits 0.
// Red arm: a scratch manifest referencing a scenario dir that exists on disk
// but is absent from `git ls-files` exits non-zero naming the dir.
//
// Confined to torture-test/ (scratch under gitignored var/ + scenarios/, both
// cleaned up). Zero tokens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const validator = path.join(ttRoot, "bin", "tt-tier0-assets");
const manifestPath = path.join(ttRoot, "cases", "tier0.jsonl");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    TAMANDUA_TEST_GUARD: "0",
    TAMANDUA_PI_BINARY: "/bin/false",
    TAMANDUA_HERMES_BINARY: "/bin/false",
    TAMANDUA_DSH_BINARY: "/bin/false",
  };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

function run(script: string, args: string[]): RunResult {
  const res = spawnSync(script, args, {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 120_000,
    env: childEnv(),
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

let scratchCounter = 0;
function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("Tier-0 tracked-tree scenario-assets guard (US-002)", () => {
  it("AC3: tt-tier0-assets validates cases/tier0.jsonl with the git ls-files tracked-tree check and exits 0", () => {
    const res = run(validator, [manifestPath]);
    assert.equal(res.status, 0, `tt-tier0-assets must exit 0:\n${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /Validated 29 Tier-0 scenario asset set\(s\)/,
      `expected the 29 tier0 scenario asset sets to validate: ${res.stdout}`);
  });

  it("red arm: a scenario dir on disk but absent from git ls-files fails closed naming the dir", () => {
    scratchCounter += 1;
    const untrackedName = `tt-tier0-untracked-${process.pid}-${scratchCounter}`;
    const untrackedDir = path.join(ttRoot, "scenarios", untrackedName);
    fs.mkdirSync(untrackedDir, { recursive: true });
    fs.writeFileSync(path.join(untrackedDir, "marker.txt"), "untracked marker\n");
    const casesTmp = fs.mkdtempSync(path.join(ttRoot, "cases", `tier0-tracked-${process.pid}-`));
    const scratchManifestPath = path.join(casesTmp, "scratch.jsonl");
    fs.writeFileSync(scratchManifestPath, `${JSON.stringify({
      id: "w0.9-install-shape-fidelity",
      wave: 0,
      workflow: "local",
      fixture: "none",
      harness: "local",
      task: "cases/tasks/tier0/w0.9-install-shape-fidelity.md",
      context: {
        execution_mode: "scripted",
        scenario_id: "w0.9-install-shape-fidelity",
        scenario_path: `scenarios/${untrackedName}`,
      },
      caps: { tokens: 0, wall_min: 1 },
      requires: {},
      boundary_files: [`scenarios/${untrackedName}`],
      forbidden: ["env/tt-env.sh"],
      oracles: ["O1", "O3z", "O11"],
      gates: ["TIER0", "W0"],
      command: { executable: "scenarios/lib/run-scripted-scenario", args: [`scenarios/${untrackedName}`], cwd: "." },
      chaos: null,
      shed_ok: false,
      mandatory: true,
      class: "verification",
    })}\n`);
    try {
      const res = run(validator, [scratchManifestPath]);
      assert.notEqual(res.status, 0, "an on-disk-but-untracked tier0 scenario dir must fail closed");
      assert.match(res.stderr, new RegExp(escaped(`scenarios/${untrackedName}`)),
        "the failure must name the missing tracked scenario dir");
      assert.match(res.stderr, /tracked tree/, "the failure must cite the tracked-tree contract");
    } finally {
      fs.rmSync(casesTmp, { recursive: true, force: true });
      fs.rmSync(untrackedDir, { recursive: true, force: true });
    }
  });
});
