// Tier-2 US-001: dsh is a first-class harness in the case schema and the W0.0
// host-profile, plus the record-only dsh presence probe.
//
// Foundation for the Tier-2 dsh lane: every dsh case would otherwise fail
// schema validation (harness enum) or gate NOT_RUN(predicate) forever (the
// `dsh` capability must resolve against harness.dsh.present like pi/hermes).
//
// Zero-token by construction: tt-verify-environment runs with --fast (never
// --spend, so no live pi/hermes/dsh invocation), the controller only ever
// executes `local`/scripted command hooks (no workflow launch, no model), and
// the dsh probe itself is record-only (it never executes the dsh binary —
// presence is `which`/env resolution only, never an answer probe). The
// TAMANDUA_DSH_BINARY seam is honored so the absent-direction can be proven
// on any host without uninstalling dsh.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const binDir = path.join(ttRoot, "bin");
const verifyEnv = path.join(binDir, "tt-verify-environment");
const controller = path.join(binDir, "tt-controller");
const varRoot = path.join(ttRoot, "var");
const hostProfilePath = path.join(varRoot, "w0", "host-profile.json");
const schemaPath = path.join(ttRoot, "cases", "case.schema.json");

const CAMPAIGN_LINE = /^Campaign:\s+(campaign-[^\s]+)$/m;
const DSH_PRED_CASE_ID = "T2-DSH-PRED";
const DSH_VALIDATE_CASE_ID = "T2-DSH-VALIDATE";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runTt(script: string, args: string[], env?: Record<string, string>): RunResult {
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: { ...process.env, ...(env ?? {}) },
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function envWithoutDSH(): Record<string, string> {
  const env: Record<string, string> = { ...process.env };
  delete env.TAMANDUA_DSH_BINARY;
  return env;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Before/after filesystem snapshot of a directory: sorted relative-path rows
// with size + mtime + content hash for regular files, and a type marker for
// symlinks/special entries. Absent directory -> a distinct marker. The
// `sessions/` subtree is excluded when present: it is the LIVE dsh harness's
// own state (the process running this test writes session.jsonl.zstd there),
// not something tt-verify-environment could touch — including it would make
// the assertion flaky.
function snapshotDir(dir: string): string {
  if (!fs.existsSync(dir)) return "__ABSENT__";
  const rows: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const p = path.join(current, entry.name);
      const rel = path.relative(dir, p);
      if (entry.isDirectory()) {
        if (rel === "sessions") continue; // live harness session state, excluded
        walk(p);
      } else if (entry.isFile()) {
        const st = fs.statSync(p);
        rows.push(`${rel}:file:${st.size}:${st.mtimeMs}:${sha256(p)}`);
      } else if (entry.isSymbolicLink()) {
        rows.push(`${rel}:symlink:${fs.readlinkSync(p)}`);
      } else {
        rows.push(`${rel}:special`);
      }
    }
  };
  walk(dir);
  return rows.sort().join("\n");
}

// Build a local-command case record (zero-token execution path) that carries
// the given requires block. The controller evaluates requires predicates
// against the host profile BEFORE deciding how to execute, so a local case is
// the honest zero-token way to observe the predicate verdict.
function localCaseRecord(id: string, requires: any): any {
  return {
    id,
    wave: 4,
    workflow: "local",
    fixture: "none",
    harness: "local",
    task: `cases/tasks/tier2/${id}.md`,
    context: { execution_mode: "scripted" },
    caps: { tokens: 0, wall_min: 5 },
    requires,
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: ["TIER2"],
    chaos: null,
    shed_ok: false,
    mandatory: true,
    class: "verification",
    reset: { executable: "node", args: ["-e", "process.exit(0)"], cwd: "." },
    command: {
      executable: "node",
      args: ["-e", "console.log(JSON.stringify({status:'done'}));process.exit(0)"],
      cwd: ".",
    },
  };
}

// A real-shaped dsh case record (harness "dsh") — used only for --validate-only.
function dshCaseRecord(): any {
  return {
    id: DSH_VALIDATE_CASE_ID,
    wave: 4,
    workflow: "do-now",
    fixture: "tt-ts",
    harness: "dsh",
    task: `cases/tasks/tier2/${DSH_VALIDATE_CASE_ID}.md`,
    context: { execution_mode: "real", test_cmd: "npm test" },
    caps: { tokens: 0, wall_min: 5 },
    requires: { capabilities: ["dsh"] },
    boundary_files: [],
    forbidden: [],
    oracles: [],
    gates: ["TIER2"],
    chaos: null,
    shed_ok: false,
    mandatory: false,
    class: "verification",
  };
}

function writeManifest(records: any[]): string {
  const name = `US001-${Date.now()}-${process.pid}.jsonl`;
  const manifestPath = path.join(varRoot, name);
  fs.writeFileSync(manifestPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return manifestPath;
}

function runCampaign(manifestPath: string): { campaignId: string | null; state: any } {
  const rel = path.relative(ttRoot, manifestPath);
  const res = runTt(controller, ["--manifest", rel]);
  const m = CAMPAIGN_LINE.exec(res.stdout);
  const campaignId = m === null ? null : m[1];
  assert.ok(campaignId, `controller did not create a campaign:\n${res.stdout}${res.stderr}`);
  const statePath = path.join(varRoot, "results", campaignId, "state.json");
  assert.ok(fs.existsSync(statePath), `campaign state not found: ${statePath}`);
  return { campaignId, state: loadJson(statePath) };
}

describe("Tier-2 dsh host-profile (US-001)", () => {
  it("case.schema.json harness enum includes dsh", () => {
    const schema = loadJson(schemaPath);
    const harness = schema.properties?.harness;
    assert.ok(Array.isArray(harness?.enum), "schema must declare a harness enum");
    assert.ok(harness.enum.includes("dsh"), "harness enum must include dsh");
    assert.ok(!harness.enum.includes("scripted-dsh"), "scripted-dsh must NOT be added (a dsh case is always real)");
  });

  it("tt-verify-environment --fast records harness.dsh.present boolean, honoring TAMANDUA_DSH_BINARY then PATH", () => {
    // Baseline: PATH discovery (env override removed) — present is a boolean leaf.
    let res = runTt(verifyEnv, ["--fast", "--json"], envWithoutDSH());
    assert.equal(res.status, 0, `tt-verify-environment failed:\n${res.stderr}${res.stdout}`);
    assert.ok(fs.existsSync(hostProfilePath), "host-profile.json must be written");
    const profile = loadJson(hostProfilePath);
    assert.equal(typeof profile.harness?.dsh?.present, "boolean",
      "host-profile must record harness.dsh.present as a boolean leaf");
    const dshOnPath = (() => {
      const r = spawnSync("which", ["dsh"], { encoding: "utf8", timeout: 5000 });
      return r.status === 0 && (r.stdout ?? "").trim().length > 0;
    })();
    assert.equal(profile.harness.dsh.present, dshOnPath,
      "harness.dsh.present must reflect honest PATH discovery");

    // Executable TAMANDUA_DSH_BINARY override wins -> present=true.
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dsh-fake-"));
    const fakeDsh = path.join(fakeBin, "fake-dsh");
    fs.writeFileSync(fakeDsh, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    try {
      res = runTt(verifyEnv, ["--fast", "--json"], { TAMANDUA_DSH_BINARY: fakeDsh });
      assert.equal(res.status, 0, `override run failed:\n${res.stderr}${res.stdout}`);
      assert.equal(loadJson(hostProfilePath).harness?.dsh?.present, true,
        "executable TAMANDUA_DSH_BINARY must record present=true");

      // Set-but-missing override fails closed to absent (no PATH fallback).
      res = runTt(verifyEnv, ["--fast", "--json"], { TAMANDUA_DSH_BINARY: path.join(fakeBin, "does-not-exist") });
      assert.equal(res.status, 0, `missing-override run failed:\n${res.stderr}${res.stdout}`);
      assert.equal(loadJson(hostProfilePath).harness?.dsh?.present, false,
        "set-but-missing TAMANDUA_DSH_BINARY must record present=false (fail closed, no PATH fallback)");
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
      // Restore the honest profile (PATH discovery) so sibling tests see truth.
      runTt(verifyEnv, ["--fast", "--json"], envWithoutDSH());
    }
  });

  it("dsh probe is record-only: no file created or modified under ~/.dsh and no binary installed", () => {
    const realDshHome = path.join(os.homedir(), ".dsh");
    const before = snapshotDir(realDshHome);

    // Run under a fresh temp HOME: the probe must never create .dsh anywhere.
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-dsh-home-"));
    try {
      const res = runTt(verifyEnv, ["--fast", "--json"], { HOME: tempHome });
      assert.equal(res.status, 0, `tt-verify-environment failed:\n${res.stderr}${res.stdout}`);
      assert.ok(!fs.existsSync(path.join(tempHome, ".dsh")),
        "dsh probe must not create ~/.dsh under a fresh HOME (record-only)");

      const after = snapshotDir(realDshHome);
      assert.equal(after, before,
        "dsh probe must not create or modify any file under the real ~/.dsh");
    } finally {
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("tt-controller --manifest <scratch manifest with harness:dsh> --validate-only exits 0", () => {
    const manifestPath = writeManifest([dshCaseRecord()]);
    try {
      const rel = path.relative(ttRoot, manifestPath);
      const res = runTt(controller, ["--manifest", rel, "--validate-only"]);
      assert.equal(res.status, 0, `validate-only failed for harness:dsh record:\n${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /Validated 1 case\(s\)/);
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
  });

  it("requires.capabilities [dsh] evaluates against harness.dsh.present (true -> pass, false/absent -> NOT_RUN(predicate))", () => {
    // 1. Regenerate the honest profile and record whether dsh is present.
    let res = runTt(verifyEnv, ["--fast", "--json"], envWithoutDSH());
    assert.equal(res.status, 0, `host-profile generation failed:\n${res.stderr}`);
    const honestProfile = loadJson(hostProfilePath);
    const dshPresent = honestProfile.harness?.dsh?.present === true;

    const manifestPath = writeManifest([localCaseRecord(DSH_PRED_CASE_ID, { capabilities: ["dsh"] })]);
    const campaignIds: string[] = [];
    try {
      // 2. Honest profile: predicate must pass iff dsh is present.
      const first = runCampaign(manifestPath);
      campaignIds.push(first.campaignId!);
      const caseState = first.state.cases.find((c: any) => c.id === DSH_PRED_CASE_ID);
      assert.ok(caseState, "predicate case missing from campaign state");
      if (dshPresent) {
        assert.notEqual(caseState.outcome, "NOT_RUN",
          "honestly-present dsh capability must NOT be gated (predicate must pass)");
        assert.notEqual(caseState.reason?.category, "predicate",
          "honestly-present dsh capability must not carry a predicate block");
      } else {
        assert.equal(caseState.outcome, "NOT_RUN",
          "honestly-absent dsh capability must gate NOT_RUN (predicate)");
        assert.equal(caseState.reason?.category, "predicate");
        assert.match(JSON.stringify(caseState.reason?.evidence), /capabilities\.dsh/,
          "evidence must name the capabilities.dsh predicate");
      }

      // 3. Force dsh absent via a set-but-missing TAMANDUA_DSH_BINARY: the SAME
      // predicate must now gate NOT_RUN(predicate) with evidence naming dsh.
      res = runTt(verifyEnv, ["--fast", "--json"], { TAMANDUA_DSH_BINARY: "/nonexistent/dsh" });
      assert.equal(res.status, 0, `absent-profile generation failed:\n${res.stderr}`);
      const absentProfile = loadJson(hostProfilePath);
      assert.equal(absentProfile.harness?.dsh?.present, false,
        "missing-override run must record harness.dsh.present=false");

      const second = runCampaign(manifestPath);
      campaignIds.push(second.campaignId!);
      const gated = second.state.cases.find((c: any) => c.id === DSH_PRED_CASE_ID);
      assert.ok(gated, "predicate case missing from gated campaign state");
      assert.equal(gated.outcome, "NOT_RUN",
        "absent dsh capability must yield outcome NOT_RUN");
      assert.equal(gated.reason?.category, "predicate",
        "absent dsh capability must be gated category=predicate");
      const evidence = gated.reason?.evidence ?? [];
      assert.ok(evidence.length > 0, "predicate block must carry non-empty evidence");
      const dshEvidence = evidence.find((e: any) => String(e?.predicate).includes("capabilities.dsh"));
      assert.ok(dshEvidence, `evidence must name capabilities.dsh (got ${JSON.stringify(evidence)})`);
      assert.notEqual(dshEvidence.observed, true,
        "evidence must record an honest observed value for the absent dsh capability");
    } finally {
      // Restore the honest profile so sibling tests see truth.
      runTt(verifyEnv, ["--fast", "--json"], envWithoutDSH());
      fs.rmSync(manifestPath, { force: true });
      for (const campaignId of campaignIds) {
        fs.rmSync(path.join(varRoot, "results", campaignId), { recursive: true, force: true });
      }
    }
  });
});
