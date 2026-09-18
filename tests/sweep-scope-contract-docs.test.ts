import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

// SWEEP-SCOPE documentation contract — US-007.
//
// Pins the exclusive leaked-process-sweep ownership model in AGENTS.md and
// tests/MOTOR-CONTRACT.md so a future edit cannot silently reintroduce the
// bead tamandua-6sy.77 CROSS-RUN KILL. The behavior itself is pinned by
// src/installer/sweep-ownership.test.ts, src/installer/run-cleanup.test.ts,
// src/installer/agent-scheduler.test.ts and tests/direct-mode-sweep-e2e.test.ts
// (the cross-run canary regression).
//
// This file reads two markdown documents and (as a drift check) the two
// source modules that own the evidence model. It touches no process table,
// spawns nothing and imports no dist module, so it runs in the parallel lane.

const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "tests", "MOTOR-CONTRACT.md"))) return cwd;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(__dirname, "..");
})();

const AGENTS_PATH = path.join(PROJECT_ROOT, "AGENTS.md");
const CONTRACT_PATH = path.join(PROJECT_ROOT, "tests", "MOTOR-CONTRACT.md");
const OWNERSHIP_SRC_PATH = path.join(PROJECT_ROOT, "src", "installer", "sweep-ownership.ts");
const CLEANUP_SRC_PATH = path.join(PROJECT_ROOT, "src", "installer", "run-cleanup.ts");

// The coordinator review artifact (torture-test/var/ is gitignored) lives on
// the coordinator host; the artifact check SKIPS when it is absent instead of
// failing an unrelated checkout. Override with TAMANDUA_SWEEP_SCOPE_CONTRACT.
const ARTIFACT_PATH =
  process.env.TAMANDUA_SWEEP_SCOPE_CONTRACT ??
  "/home/igorhvr/idm/tamandua/torture-test/var/review-logs/coordinator-20260912/sweep-scope-contract.json";

/** Markdown emphasis/backticks are cosmetic; drop them and flatten whitespace. */
function flatten(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "").replace(/\s+/g, " ");
}

describe("SWEEP-SCOPE docs: AGENTS.md exclusive ownership evidence", () => {
  let flat: string;

  before(() => {
    flat = flatten(fs.readFileSync(AGENTS_PATH, "utf-8"));
  });

  it("documents the DSWP post-grace sweep section", () => {
    assert.ok(
      flat.includes("Post-grace process sweep (DSWP)"),
      "AGENTS.md must carry the Post-grace process sweep (DSWP) section",
    );
    assert.ok(
      flat.includes("sweepRunProcesses"),
      "AGENTS.md must name sweepRunProcesses",
    );
  });

  it("states exactly two exclusive evidence channels: a recorded pgid or the daemon-scoped marker", () => {
    assert.ok(
      flat.includes("EXCLUSIVE proof the process was spawned by THIS daemon instance for THIS run"),
      "AGENTS.md must state the exclusive-ownership rule",
    );
    assert.ok(
      flat.includes("options.pgids"),
      "AGENTS.md must name the recorded pgid channel (options.pgids)",
    );
    assert.ok(
      flat.includes("pgid owned by run: <pgid>"),
      "AGENTS.md must carry the pgid evidence string",
    );
    assert.ok(
      flat.includes("TAMANDUA_RUN_ID=<runId>"),
      "AGENTS.md must name the TAMANDUA_RUN_ID marker token",
    );
    assert.ok(
      flat.includes("TAMANDUA_DAEMON_INSTANCE=<daemonInstance>"),
      "AGENTS.md must name the TAMANDUA_DAEMON_INSTANCE marker token",
    );
    assert.ok(
      flat.includes("daemon-scoped run marker: run=<runId>"),
      "AGENTS.md must carry the daemon-scoped marker evidence string",
    );
  });

  it("documents the daemon start identity / state dir token derivation", () => {
    assert.ok(
      flat.includes("computeDaemonInstanceToken"),
      "AGENTS.md must name computeDaemonInstanceToken",
    );
    assert.ok(
      flat.includes("state dir") && flat.includes("kernel process-start identity"),
      "AGENTS.md must state the token derives from the state dir + kernel process-start identity",
    );
    assert.ok(
      flat.includes("sha256"),
      "AGENTS.md must state the token is a sha256 digest",
    );
    assert.ok(
      flat.includes("stable for one daemon and different for every other instance"),
      "AGENTS.md must state the token is per-daemon-instance",
    );
  });

  it("names the exclusive kill matcher and the doctor-only report-only matcher", () => {
    assert.ok(
      flat.includes("matchRunEvidence is the ONLY kill matcher"),
      "AGENTS.md must state matchRunEvidence is the ONLY kill matcher",
    );
    assert.ok(
      flat.includes("matchDiagnosticRunEvidence"),
      "AGENTS.md must name matchDiagnosticRunEvidence",
    );
    assert.ok(
      flat.includes("REPORT-ONLY and never kill"),
      "AGENTS.md must state the diagnostic matcher is report-only",
    );
    assert.ok(
      flat.includes("processBelongsToRun"),
      "AGENTS.md must name processBelongsToRun as a diagnostic caller",
    );
    assert.ok(
      flat.includes("tamandua doctor"),
      "AGENTS.md must name tamandua doctor as the diagnostic consumer",
    );
  });

  it("states that cwd / path / worker-job-id / cmdline are never sufficient kill evidence", () => {
    assert.ok(
      flat.includes("NEVER sufficient kill evidence"),
      "AGENTS.md must state the non-exclusive channels are never sufficient",
    );
    assert.ok(
      flat.includes("TAMANDUA_WORKER_JOB_ID"),
      "AGENTS.md must name TAMANDUA_WORKER_JOB_ID as a non-sufficient channel",
    );
    assert.ok(
      flat.includes("cmdline naming the run id/path"),
      "AGENTS.md must name cmdline as a non-sufficient channel",
    );
    assert.ok(
      flat.includes("cwd is NEVER consulted, not even to NARROW a match"),
      "AGENTS.md must state cwd is never consulted, not even to narrow a marker match",
    );
    assert.ok(
      flat.includes("platform-neutral reader"),
      "AGENTS.md must state the marker environ is resolved through the platform-neutral reader",
    );
    assert.ok(
      flat.includes("for EVERY candidate"),
      "AGENTS.md must state the platform-neutral environ reader runs for every candidate",
    );
    assert.ok(
      flat.includes("KERN_PROCARGS2"),
      "AGENTS.md must describe the KERN_PROCARGS2 environ reader on darwin",
    );
  });

  it("records the cross-run kill incident that motivated the model", () => {
    assert.ok(
      flat.includes("tamandua-6sy.77"),
      "AGENTS.md must cite bead tamandua-6sy.77",
    );
    assert.ok(
      flat.includes("once reaped 14 processes belonging to an enclosing run"),
      "AGENTS.md must record the 14-process cross-run kill",
    );
    assert.ok(
      flat.includes("dsh harness round running the test suite"),
      "AGENTS.md must name the killed enclosing harness round",
    );
  });

  it("documents marker hygiene and the daemon survivor/teardown guards", () => {
    assert.ok(
      flat.includes("buildHarnessChildEnv"),
      "AGENTS.md must name buildHarnessChildEnv as the marker-injection point",
    );
    assert.ok(
      flat.includes("TAMANDUA_WORKER_PID: undefined"),
      "AGENTS.md must state the inherited worker pid is dropped with undefined",
    );
    assert.ok(
      flat.includes("cleanChildEnv"),
      "AGENTS.md must name cleanChildEnv as the test-daemon env allowlist",
    );
    assert.ok(
      flat.includes("daemon-survivor-guard"),
      "AGENTS.md must name the runtime daemon survivor guard",
    );
    assert.ok(
      flat.includes("test-daemon-teardown-guard.test.ts"),
      "AGENTS.md must name the static teardown guard",
    );
  });
});

describe("SWEEP-SCOPE docs: MOTOR-CONTRACT.md ownership evidence channels", () => {
  let flat: string;

  before(() => {
    flat = flatten(fs.readFileSync(CONTRACT_PATH, "utf-8"));
  });

  it("carries the SWEEP-SCOPE ownership evidence channels subsection", () => {
    assert.ok(
      flat.includes("Ownership evidence channels (SWEEP-SCOPE"),
      "MOTOR-CONTRACT.md must carry the SWEEP-SCOPE ownership evidence channels bullet",
    );
    assert.ok(
      flat.includes("bead tamandua-6sy.77"),
      "the subsection must cite bead tamandua-6sy.77",
    );
  });

  it("documents the exclusive pgid + daemon-scoped marker channels", () => {
    assert.ok(
      flat.includes("the sweep is EXCLUSIVE"),
      "MOTOR-CONTRACT.md must state the sweep is exclusive",
    );
    assert.ok(
      flat.includes("pgid owned by run: <pgid>"),
      "MOTOR-CONTRACT.md must carry the pgid evidence string",
    );
    assert.ok(
      flat.includes("TAMANDUA_RUN_ID=<runId>"),
      "MOTOR-CONTRACT.md must name the TAMANDUA_RUN_ID marker token",
    );
    assert.ok(
      flat.includes("TAMANDUA_DAEMON_INSTANCE=<daemonInstance>"),
      "MOTOR-CONTRACT.md must name the TAMANDUA_DAEMON_INSTANCE marker token",
    );
    assert.ok(
      flat.includes("daemon-scoped run marker: run=<runId>"),
      "MOTOR-CONTRACT.md must carry the daemon-scoped marker evidence string",
    );
    assert.ok(
      flat.includes("options.daemonInstance"),
      "MOTOR-CONTRACT.md must document the daemonInstance option and its null behavior",
    );
  });

  it("documents that matchRunEvidence is the kill matcher and the diagnostic matcher is report-only", () => {
    assert.ok(
      flat.includes("matchRunEvidence is the ONLY kill matcher"),
      "MOTOR-CONTRACT.md must state matchRunEvidence is the ONLY kill matcher",
    );
    assert.ok(
      flat.includes("matchDiagnosticRunEvidence"),
      "MOTOR-CONTRACT.md must name matchDiagnosticRunEvidence",
    );
    assert.ok(
      flat.includes("REPORT-ONLY matcher"),
      "MOTOR-CONTRACT.md must state the diagnostic matcher is report-only",
    );
    assert.ok(
      flat.includes("NEVER gates a kill"),
      "MOTOR-CONTRACT.md must state the diagnostic matcher never gates a kill",
    );
  });

  it("documents the token derivation and the inherited-outer-instance mismatch", () => {
    assert.ok(
      flat.includes("computeDaemonInstanceToken"),
      "MOTOR-CONTRACT.md must name computeDaemonInstanceToken",
    );
    assert.ok(
      flat.includes("kernel process-start identity"),
      "MOTOR-CONTRACT.md must state the token derives from the kernel process-start identity",
    );
    assert.ok(
      flat.includes("inherited OUTER instance token never matches"),
      "MOTOR-CONTRACT.md must state an inherited outer instance token never matches",
    );
  });

  it("states the non-exclusive channels are never sufficient and cwd is never consulted", () => {
    assert.ok(
      flat.includes("are NEVER sufficient kill evidence and never create a match"),
      "MOTOR-CONTRACT.md must state the broad channels are never sufficient",
    );
    assert.ok(
      flat.includes("cwd is NEVER consulted, not even to NARROW a match"),
      "MOTOR-CONTRACT.md must state cwd is never consulted, not even to narrow a marker match",
    );
    assert.ok(
      flat.includes("platform-neutral reader"),
      "MOTOR-CONTRACT.md must state the marker environ is resolved through the platform-neutral reader",
    );
    assert.ok(
      flat.includes("for EVERY candidate"),
      "MOTOR-CONTRACT.md must state the platform-neutral environ reader runs for every candidate",
    );
    assert.ok(
      flat.includes("SIGKILLed 14 processes belonging to an ENCLOSING run"),
      "MOTOR-CONTRACT.md must record the 14-process cross-run kill",
    );
  });

  it("documents marker hygiene", () => {
    assert.ok(
      flat.includes("Marker hygiene (SWEEP-SCOPE US-002)"),
      "MOTOR-CONTRACT.md must carry the marker-hygiene bullet",
    );
    assert.ok(
      flat.includes("buildHarnessChildEnv"),
      "MOTOR-CONTRACT.md must name buildHarnessChildEnv",
    );
    assert.ok(
      flat.includes("TAMANDUA_WORKER_PID: undefined"),
      "MOTOR-CONTRACT.md must state the inherited worker pid is dropped",
    );
    assert.ok(
      flat.includes("cleanChildEnv"),
      "MOTOR-CONTRACT.md must name cleanChildEnv",
    );
  });

  it("documents the cross-run canary regression", () => {
    assert.ok(
      flat.includes("Cross-run canary regression (SWEEP-SCOPE US-005)"),
      "MOTOR-CONTRACT.md must carry the cross-run canary regression bullet",
    );
    assert.ok(
      flat.includes("tests/direct-mode-sweep-e2e.test.ts"),
      "MOTOR-CONTRACT.md must point at the canary e2e file",
    );
    assert.ok(
      flat.includes("cwd UNDER the run's working directory"),
      "MOTOR-CONTRACT.md must state the canary's cwd is under the run directory",
    );
    assert.ok(
      flat.includes("inherited TAMANDUA_RUN_ID naming an UNRELATED run"),
      "MOTOR-CONTRACT.md must state the canary carries another run's marker",
    );
    assert.ok(
      flat.includes("never in killedPids"),
      "MOTOR-CONTRACT.md must state the canary is never in killedPids",
    );
  });
});

describe("SWEEP-SCOPE docs: source/doc drift check", () => {
  it("the documented marker env key matches the source constant", () => {
    const src = fs.readFileSync(OWNERSHIP_SRC_PATH, "utf-8");
    assert.match(
      src,
      /SWEEP_DAEMON_INSTANCE_ENV\s*=\s*"TAMANDUA_DAEMON_INSTANCE"/,
      "sweep-ownership.ts must define SWEEP_DAEMON_INSTANCE_ENV as TAMANDUA_DAEMON_INSTANCE",
    );
    assert.match(
      src,
      /SWEEP_RUN_ID_ENV\s*=\s*"TAMANDUA_RUN_ID"/,
      "sweep-ownership.ts must define SWEEP_RUN_ID_ENV as TAMANDUA_RUN_ID",
    );
  });

  it("the documented matchers exist in run-cleanup.ts and no other matcher is exported as a kill gate", () => {
    const src = fs.readFileSync(CLEANUP_SRC_PATH, "utf-8");
    assert.match(
      src,
      /export function matchRunEvidence\(/,
      "run-cleanup.ts must export matchRunEvidence",
    );
    assert.match(
      src,
      /export function matchDiagnosticRunEvidence\(/,
      "run-cleanup.ts must export matchDiagnosticRunEvidence",
    );
    assert.ok(
      src.includes("NEVER use this to decide a kill"),
      "the diagnostic matcher must carry the never-kill warning",
    );
  });
});

describe("SWEEP-SCOPE coordinator contract artifact", () => {
  const present = fs.existsSync(ARTIFACT_PATH);

  it(
    "parses as JSON and carries the required coordinator shape",
    { skip: present ? false : `artifact absent at ${ARTIFACT_PATH}` },
    () => {
      const raw = fs.readFileSync(ARTIFACT_PATH, "utf-8");
      const doc = JSON.parse(raw) as Record<string, unknown>;

      for (const key of ["task", "beads", "evidenceModel", "filesChanged", "leakingFixtures", "gates"]) {
        assert.ok(key in doc, `artifact must carry a ${key} key`);
        assert.ok(
          doc[key] !== null && doc[key] !== undefined && doc[key] !== "",
          `artifact.${key} must be non-empty`,
        );
      }

      assert.equal(doc.task, "SWEEP-SCOPE");
      assert.equal(doc.runId, "5bf91935-f17b-4fa7-99cd-09b725261036");
      assert.equal(doc.branch, "feature/sweep-scope-daemon-owned-evidence");
      assert.equal(doc.baseBranch, "integration/sweep-scope");

      const beads = doc.beads as string[];
      assert.ok(Array.isArray(beads), "artifact.beads must be an array");
      assert.ok(beads.includes("tamandua-6sy.77"), "beads must include tamandua-6sy.77");

      const model = doc.evidenceModel as Record<string, unknown>;
      assert.equal(model.exclusive, true, "evidenceModel.exclusive must be true");
      const channels = model.killChannels as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(channels), "evidenceModel.killChannels must be an array");
      const channelIds = channels.map((c) => c.channel);
      assert.ok(channelIds.includes("recorded-pgid"), "kill channels must include recorded-pgid");
      assert.ok(
        channelIds.includes("daemon-scoped-marker"),
        "kill channels must include daemon-scoped-marker",
      );
      const matchers = model.matchers as Record<string, Record<string, unknown>>;
      assert.equal(
        matchers.killMatcher.name,
        "matchRunEvidence",
        "evidenceModel.matchers.killMatcher.name must be matchRunEvidence",
      );
      assert.equal(
        matchers.diagnosticMatcher.name,
        "matchDiagnosticRunEvidence",
        "evidenceModel.matchers.diagnosticMatcher.name must be matchDiagnosticRunEvidence",
      );
      assert.ok(
        typeof model.tokenDerivation === "string" && model.tokenDerivation.includes("sha256"),
        "evidenceModel.tokenDerivation must describe the sha256 token",
      );

      const files = doc.filesChanged as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(files) && files.length > 0, "filesChanged must be a non-empty array");
      for (const p of [
        "src/installer/sweep-ownership.ts",
        "src/installer/run-cleanup.ts",
        "src/installer/agent-scheduler.ts",
        "AGENTS.md",
        "tests/MOTOR-CONTRACT.md",
      ]) {
        assert.ok(
          files.some((f) => f.path === p),
          `filesChanged must list ${p}`,
        );
      }

      const leaking = doc.leakingFixtures as Record<string, unknown>;
      assert.equal(leaking.story, "US-006", "leakingFixtures.story must be US-006");
      const runtimeGuard = leaking.runtimeGuard as Record<string, unknown>;
      const staticGuard = leaking.staticGuard as Record<string, unknown>;
      assert.ok(
        typeof runtimeGuard.path === "string" && runtimeGuard.path.length > 0,
        "leakingFixtures.runtimeGuard.path must be set",
      );
      assert.ok(
        typeof staticGuard.path === "string" && staticGuard.path.length > 0,
        "leakingFixtures.staticGuard.path must be set",
      );

      const gates = doc.gates as Array<Record<string, unknown>>;
      assert.ok(Array.isArray(gates) && gates.length > 0, "artifact.gates must be a non-empty array");
      for (const gate of gates) {
        assert.equal(
          typeof gate.exitCode,
          "number",
          `gate ${String(gate.kind)} must carry a numeric exitCode`,
        );
        assert.equal(gate.exitCode, 0, `gate ${String(gate.kind)} must record exitCode 0`);
        assert.ok(typeof gate.command === "string" && gate.command.length > 0, "gate.command must be set");
      }
      const commands = gates.map((g) => g.command as string);
      for (const want of ["npm run build", "npm test", "./run-all-e2e-tests"]) {
        assert.ok(
          commands.some((c) => c.includes(want)),
          `artifact.gates must include a ${want} entry`,
        );
      }

      assert.equal(doc.realTierNotRun, true, "artifact.realTierNotRun must be true");
      assert.equal(
        doc.productionDaemonUntouched,
        true,
        "artifact.productionDaemonUntouched must be true",
      );
    },
  );
});
