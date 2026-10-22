/**
 * G1 store-control discovery — US-007 consolidated deliverable contract.
 *
 * US-007 closes the investigation. This test pins:
 *   - the final document has every required section, no leftover placeholder,
 *     a consolidated one-row-per-store HONOURING verdict table, a
 *     behaviour-derived required/optional policy, and concrete gate
 *     implications (raw bytes 18/19, resolved config=delete, missing-required
 *     refusal, present-only optional checks, no SQLite mode reads);
 *   - the kanban.db/projects.db conversion evidence matches the document;
 *   - run_all.sh runs the header unit test plus every probe, tees to
 *     final-harness.log, records real-home safety counts, and fails nonzero on
 *     an assertion failure;
 *   - the committed final-harness.log is green and records zero opens under
 *     the real operator home;
 *   - the harness executes end to end green (log redirected to a temp file so
 *     the test never rewrites tracked evidence).
 *
 * Spawns Python/bash and the installed Hermes runtime, so this file is in the
 * serial lane.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { tamanduaTempDir } from "../src/lib/temp-dir.ts";

const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "docs", "gate"))) return cwd;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
})();

const GATE_DIR = path.join(PROJECT_ROOT, "docs", "gate");
const DOC_PATH = path.join(GATE_DIR, "G1-STORE-CONTROL-DISCOVERY.md");
const PROBES_DIR = path.join(GATE_DIR, "probes");
const EVIDENCE_DIR = path.join(GATE_DIR, "evidence");
const RUN_ALL_PATH = path.join(PROBES_DIR, "run_all.sh");
const OPTIONAL_PROBE_PATH = path.join(PROBES_DIR, "probe_optional_conversion.sh");
const OPTIONAL_EVIDENCE_PATH = path.join(
  EVIDENCE_DIR,
  "optional-conversion-persistence.txt",
);
const HARNESS_LOG_PATH = path.join(EVIDENCE_DIR, "final-harness.log");

const HERMES_SRC = "/home/kaladin/hermes-agent";
const HERMES_PYTHON = path.join(HERMES_SRC, "venv", "bin", "python");

const scratchRoots: string[] = [];
after(() => {
  for (const root of scratchRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const hermesAvailable =
  fs.existsSync(HERMES_PYTHON) && fs.existsSync(path.join(HERMES_SRC, "hermes_state_wal.py"));

function readDoc(): string {
  return fs.readFileSync(DOC_PATH, "utf-8");
}

function section(doc: string, startHeading: string, endHeading: string): string {
  const start = doc.indexOf(startHeading);
  const end = doc.indexOf(endHeading, start);
  assert.ok(start >= 0, `document must contain heading ${startHeading}`);
  assert.ok(end > start, `${startHeading} must be followed by ${endHeading}`);
  return doc.slice(start, end);
}

function digestMatches(text: string): string[] {
  return text.match(/[0-9a-f]{64}/g) ?? [];
}

describe("G1 US-007 final document", () => {
  it("has every required section and no leftover placeholder", () => {
    const doc = readDoc();
    for (const heading of [
      "## Status",
      "## Artifact Truth",
      "## Safety Protocol",
      "## Method",
      "## Store Inventory",
      "## Config Resolution",
      "## Per-Store Findings",
      "## Required vs Optional",
      "## Gate Implications",
      "## Command Appendix",
    ]) {
      assert.ok(doc.includes(heading), `document must contain ${heading}`);
    }
    assert.doesNotMatch(doc, /\*\*PLACEHOLDER/);
    assert.match(doc, /COMPLETE — G1 store-control discovery closed/);
  });

  it("has a consolidated one-row-per-store verdict table with no UNKNOWN", () => {
    const doc = readDoc();
    const table = section(
      doc,
      "### Consolidated per-store verdicts (US-007)",
      "### Fresh creation under `database.journal_mode: delete` (US-004)",
    );
    for (const store of ["state.db", "verification_evidence.db", "kanban.db", "projects.db"]) {
      const escaped = store.replace(/\./g, "\\.");
      assert.match(
        table,
        new RegExp(`\\| \`${escaped}\` \\| \\*\\*HONOURING\\*\\* \\|`),
        `consolidated table must give ${store} the HONOURING verdict`,
      );
    }
    assert.doesNotMatch(table, /\|\s*\*\*UNKNOWN\*\*\s*\|/);
    assert.match(table, /No store is left as UNKNOWN/);
    assert.match(table, /US-005\/US-006/);
    assert.match(table, /US-007/);
  });

  it("derives required vs optional from observed behaviour and checks optionals only when present", () => {
    const doc = readDoc();
    const required = section(doc, "## Required vs Optional", "\n## Gate Implications");
    for (const marker of [
      "derived from observed runtime behaviour",
      "not from `*.db` filenames",
      "`state.db` | **Required (core)**",
      "**Optional — verify-on-stop gated**",
      "**Optional — kanban-feature gated**",
      "**Optional — project-feature gated**",
      "**Refuse when missing.**",
      "**Check only when present.**",
      "record_verify_run()` returns `None`",
      "`hermes kanban list`",
      "`hermes project list`",
    ]) {
      assert.ok(required.includes(marker), `Required vs Optional must state ${marker}`);
    }
  });

  it("states concrete, sound gate implications", () => {
    const doc = readDoc();
    const gate = section(doc, "## Gate Implications", "\n## Command Appendix");
    for (const marker of [
      "**Final policy for the hermes-into-Matchlock launch gate.**",
      "**Raw header bytes 18 and 19 are `1` and `1`.**",
      "resolved value must be exactly `delete`",
      "managed-scope `config.yaml`",
      "applied last",
      "fail safe to `wal`",
      "**Refuse.**",
      "Check only when present",
      "must **never** open the store with SQLite",
      "checkpoint can change the",
      "**Config-only**",
      "**Bytes-only**",
      "**No store cannot be converted.**",
      "hermes sessions set-journal-mode delete --db <store>",
      "Never enumerate stores by guessed `*.db` filenames",
    ]) {
      assert.ok(gate.includes(marker), `Gate Implications must state ${marker}`);
    }
  });

  it("records artifact truth and reconciles the derived store set with the live measurement", () => {
    const doc = readDoc();
    for (const marker of [
      "`f2f34c9177ec28a51ae89a48e612baff2b1892b3`",
      "`ebb0bd1b882167f3fbab28e92f8f80c21428fa0c`",
      "`aaf61c1ddca8fc939f16c548219309087c399bc8`",
      "`ef15bd7adf52ae9e261d0d2ce6d46adcd086ce81`",
      "d623a6607e385d9d8024ce960234be47536351f2",
      "Python 3.14.7",
      "SQLite 3.53.3",
      "0::/init.scope",
      "`hermes doctor`",
      "**not** assumed from a list of `*.db` filenames",
      "`~/.hermes/state.db`",
      "no `kanban.db`",
      "feature-gated",
    ]) {
      assert.ok(doc.includes(marker), `Artifact Truth/Inventory must record ${marker}`);
    }
  });
});

describe("G1 US-007 kanban/projects conversion evidence", () => {
  it("document digests and verdicts appear in the saved evidence", () => {
    assert.ok(fs.existsSync(OPTIONAL_EVIDENCE_PATH), `evidence must exist at ${OPTIONAL_EVIDENCE_PATH}`);
    const log = fs.readFileSync(OPTIONAL_EVIDENCE_PATH, "utf-8");
    const docSection = section(
      readDoc(),
      "### Offline conversion persistence for `kanban.db` and `projects.db` (US-007)",
      "\n## Required vs Optional",
    );

    const digests = digestMatches(docSection);
    assert.ok(digests.length >= 8, `expected several recorded sha256 digests, found ${digests.length}`);
    for (const digest of digests) {
      assert.ok(log.includes(digest), `document sha256 ${digest} must appear in the evidence log`);
    }

    const rootToken = docSection.match(/g1-optional\.[A-Za-z0-9]+/)?.[0];
    assert.ok(rootToken, "the US-007 subsection must record the captured scratch root");
    assert.ok(log.includes(rootToken), `document scratch root ${rootToken} must match the evidence log`);

    for (const marker of [
      "KANBAN.DB VERDICT: HONOURING",
      "PROJECTS.DB VERDICT: HONOURING",
      "RESULT: PASS",
      "ASSERT PASS: converted_copy_kanban header is 1,1 (mode delete)",
      "ASSERT PASS: delete_run_1_kanban header is 1,1 (mode delete)",
      "ASSERT PASS: delete_run_2_kanban header is 1,1 (mode delete)",
      "ASSERT PASS: wal_control_run_kanban header is 2,2 (mode wal)",
      "ASSERT PASS: converted_copy_projects header is 1,1 (mode delete)",
      "ASSERT PASS: delete_run_1_projects header is 1,1 (mode delete)",
      "ASSERT PASS: delete_run_2_projects header is 1,1 (mode delete)",
      "ASSERT PASS: wal_control_run_projects header is 2,2 (mode wal)",
      "probe_optional_conversion: real_home=/home/kaladin/.hermes (never opened by design)",
    ]) {
      assert.ok(log.includes(marker), `evidence must contain ${marker}`);
    }
    assert.doesNotMatch(log, /ASSERT FAIL/);
    assert.doesNotMatch(log, /open(at)?\(.*"\/home\/kaladin\/\.hermes/);
  });
});

describe("G1 US-007 consolidated harness", () => {
  it("run_all.sh exists, is executable, and covers every probe with a safety scan", () => {
    assert.ok(fs.existsSync(RUN_ALL_PATH), `run_all.sh must exist at ${RUN_ALL_PATH}`);
    const stat = fs.statSync(RUN_ALL_PATH);
    assert.ok((stat.mode & 0o111) !== 0, "run_all.sh must be executable");
    const source = fs.readFileSync(RUN_ALL_PATH, "utf-8");
    for (const marker of [
      "test_read_header.py",
      "probe_config.py",
      "probe_store_inventory.sh",
      "probe_fresh_modes.sh",
      "probe_conversion_persistence.sh",
      "probe_verification_conversion.sh",
      "probe_optional_conversion.sh",
      "final-harness.log",
      "strace -f -e trace=openat,open,creat",
      "real_home_open_lines",
      "SAFETY RESULT: PASS",
      "RESULT: PASS",
      "exit 1",
      "/home/kaladin/.hermes",
    ]) {
      assert.ok(source.includes(marker), `run_all.sh must reference ${marker}`);
    }
    assert.ok(fs.existsSync(OPTIONAL_PROBE_PATH), "the US-007 optional-store probe must exist");
    assert.ok((fs.statSync(OPTIONAL_PROBE_PATH).mode & 0o111) !== 0, "optional probe must be executable");
  });

  it("the committed final-harness.log is green and records zero real-home opens", () => {
    assert.ok(fs.existsSync(HARNESS_LOG_PATH), `harness log must exist at ${HARNESS_LOG_PATH}`);
    const log = fs.readFileSync(HARNESS_LOG_PATH, "utf-8");
    for (const step of [
      "01-header-unit-test",
      "02-config-resolution",
      "03-store-inventory",
      "04-fresh-store-modes",
      "05-state-conversion",
      "06-verification-conversion",
      "07-optional-conversion",
    ]) {
      assert.ok(log.includes(`STEP RESULT: PASS (${step} exited 0)`), `log must pass step ${step}`);
    }
    for (const marker of [
      "SAFETY SUMMARY: steps=7 straced_steps=7",
      "SAFETY SUMMARY: raw_strace_real_home_open_lines=0",
      "SAFETY SUMMARY: evidence_text_files=",
      "saved_log_real_home_open_lines=0",
      "SAFETY RESULT: PASS",
      "RESULT: PASS (all G1 probes and assertions passed; no real-home opens)",
      "KANBAN.DB VERDICT: HONOURING",
      "PROJECTS.DB VERDICT: HONOURING",
      "STATE.DB VERDICT: HONOURING",
      "VERIFICATION_EVIDENCE.DB VERDICT: HONOURING",
    ]) {
      assert.ok(log.includes(marker), `harness log must contain ${marker}`);
    }
    assert.doesNotMatch(log, /ASSERT FAIL/);
    assert.doesNotMatch(log, /STEP RESULT: FAIL/);
    assert.doesNotMatch(log, /open(at)?\(.*"\/home\/kaladin\/\.hermes/);
  });

  it(
    "runs the full harness end to end green",
    { skip: !hermesAvailable && "installed Hermes runtime is not present on this host" },
    () => {
      const tempRoot = tamanduaTempDir("g1-final-test-");
      scratchRoots.push(tempRoot);
      const logPath = path.join(tempRoot, "final-harness.log");
      const home = path.join(tempRoot, "home");
      fs.mkdirSync(home, { recursive: true });

      const result = spawnSync("/bin/bash", [RUN_ALL_PATH], {
        cwd: PROJECT_ROOT,
        encoding: "utf-8",
        timeout: 1_500_000,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: home,
          HERMES_SRC,
          G1_HARNESS_LOG: logPath,
          G1_HARNESS_STRACE: "0",
        },
      });
      assert.equal(
        result.status,
        0,
        `run_all failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
      assert.match(result.stdout, /RESULT: PASS \(all G1 probes and assertions passed; no real-home opens\)/);
      assert.match(result.stdout, /SAFETY RESULT: PASS/);
      assert.ok(fs.existsSync(logPath), "run_all must write the requested harness log");
      const log = fs.readFileSync(logPath, "utf-8");
      for (const step of [
        "01-header-unit-test",
        "02-config-resolution",
        "03-store-inventory",
        "04-fresh-store-modes",
        "05-state-conversion",
        "06-verification-conversion",
        "07-optional-conversion",
      ]) {
        assert.ok(log.includes(`STEP RESULT: PASS (${step} exited 0)`), `run must pass ${step}`);
      }
      assert.doesNotMatch(log, /ASSERT FAIL/);
    },
  );
});
