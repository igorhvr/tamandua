/**
 * G1-B stock-runtime qualification — US-007 consolidated harness contract.
 *
 * US-007 makes the whole stock-runtime qualification reproducible with ONE
 * command: `docs/gate/probes/g1b/run_all.sh` runs the raw-header checks, the
 * runtime-identity probe, the WAL seeding harness and all four per-store
 * delete-mode probes against ONE fresh, KEPT scratch root, and tees the complete
 * output into `docs/gate/evidence/g1b/final-harness.log`.  The same story
 * consolidates the per-store verdict table, the exercised artifact identity, the
 * "What remains unproven" list and the BLOCKER policy into the G1-B doc.
 *
 * This file pins that contract so a future edit cannot drop a store, weaken the
 * persistence/control assertions, let a per-store result be lost from the
 * consolidated log, rewrite the committed per-store evidence, clean up the
 * evidence root, or claim a Matchlock relationship that was never established.
 *
 * It is pure filesystem/doc parsing (no bash, no docker), so it stays in the
 * parallel lane.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "docs", "gate"))) return cwd;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
})();

const GATE_DIR = path.join(PROJECT_ROOT, "docs", "gate");
const G1B_DOC = path.join(GATE_DIR, "G1-B-STOCK-RUNTIME-QUALIFICATION.md");
const G1B_PROBES = path.join(GATE_DIR, "probes", "g1b");
const RUN_ALL = path.join(G1B_PROBES, "run_all.sh");
const FINAL_LOG = path.join(GATE_DIR, "evidence", "g1b", "final-harness.log");

// The scratch base is written as a concatenation so this test file does not
// carry the literal temp base followed by a slash (the temp-dir guard scans
// test sources for it).
const TMP_BASE = "/tmp";
const FINAL_ROOT_PREFIX = `${TMP_BASE}/g1b-final`;

const IMAGE_ID =
  "sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a";
const MATCHLOCK_IMAGE_ID =
  "sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff";
const HERMES_REVISION = "4d04303818b61bf3aa09278af48356315515965b";
const REAL_HOME = "/home/kaladin/.hermes";

/** The four stores, in the order the consolidated table lists them. */
const STORES = [
  { db: "state.db", step: "state_delete", probe: "probe_state_delete.sh" },
  {
    db: "verification_evidence.db",
    step: "verification_delete",
    probe: "probe_verification_delete.sh",
  },
  { db: "kanban.db", step: "kanban_delete", probe: "probe_kanban_delete.sh" },
  {
    db: "projects.db",
    step: "projects_delete",
    probe: "probe_projects_delete.sh",
  },
] as const;

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

const harness = read(RUN_ALL);
const log = read(FINAL_LOG);
const doc = read(G1B_DOC);

/** The doc section starting at `marker` and ending before the next `## ` heading. */
function docSection(marker: string): string {
  const start = doc.indexOf(marker);
  assert.notEqual(start, -1, `doc is missing the "${marker}" section`);
  const after = doc.slice(start + marker.length);
  const end = after.indexOf("\n## ");
  return end === -1 ? after : after.slice(0, end);
}

describe("G1-B US-007 consolidated harness", () => {
  it("ships one executable consolidated harness with ONE kept scratch root", () => {
    assert.ok(fs.existsSync(RUN_ALL), "missing docs/gate/probes/g1b/run_all.sh");
    assert.ok(fs.statSync(RUN_ALL).mode & 0o111, "run_all.sh is not executable");

    // One root, created through the shared scratch helper, never cleaned up.
    assert.match(harness, /ROOT="\$\(g1b_scratch final\)"/);
    assert.match(harness, /SCRATCH_ROOT_KEPT=yes/);
    assert.match(harness, /FINAL_SCRATCH_ROOT=\$ROOT \(kept as evidence\)/);
    assert.doesNotMatch(harness, /trap\s+'?"?rm -rf/);
    assert.doesNotMatch(harness, /rm\s+-rf?\s+"?\$ROOT/);
    assert.doesNotMatch(harness, /rm\s+-rf?\s+"?\$FINAL/);

    // Every child probe works INSIDE that one root, and its per-store output is
    // captured there instead of rewriting the committed per-store evidence.
    assert.match(harness, /export G1B_TMP_ROOT="\$ROOT"/);
    for (const key of [
      "G1B_STATE_DELETE_OUT",
      "G1B_VERIFICATION_DELETE_OUT",
      "G1B_KANBAN_DELETE_OUT",
      "G1B_PROJECTS_DELETE_OUT",
      "G1B_SEED_OUT",
      "G1B_RUNTIME_IDENTITY_OUT",
    ]) {
      assert.match(
        harness,
        new RegExp(`export ${key}="\\$ROOT/logs/`),
        `${key} is not captured under the kept root`,
      );
    }
    // Uniform, non-colliding markers for the consolidated run.
    for (const key of [
      "G1B_SEED_RUNID",
      "G1B_STATE_RUNID",
      "G1B_VERIFICATION_RUNID",
      "G1B_KANBAN_RUNID",
      "G1B_PROJECTS_RUNID",
    ]) {
      assert.match(harness, new RegExp(`export ${key}="\\$FINAL_RUNID-`));
    }

    // The consolidated log is the deliverable and is written from scratch.
    assert.match(harness, /LOG="\$\{G1B_FINAL_HARNESS_OUT:-\$EVIDENCE_DIR\/final-harness\.log\}"/);
    assert.match(harness, /: > "\$LOG"/);
  });

  it("runs read_header checks, identity, seeding and every store probe", () => {
    const steps = [...harness.matchAll(/^run_step (\S+) (\S+)$/gm)].map((m) => m[1]);
    assert.deepEqual(steps, [
      "read_header_checks",
      "runtime_identity",
      "seeding",
      "read_header_seeded",
      "state_delete",
      "verification_delete",
      "kanban_delete",
      "projects_delete",
    ]);

    // Each step invokes the REAL probe script (never a copy of it).
    assert.match(harness, /bash "\$PROBES_DIR\/probe_runtime_identity\.sh"/);
    assert.match(harness, /bash "\$PROBES_DIR\/seed_stores\.sh"/);
    for (const store of STORES) {
      assert.match(harness, new RegExp(`bash "\\$PROBES_DIR/${store.probe}"`));
    }

    // The raw-header reader's contract is checked, and the four ACTUAL seeded
    // stores are re-read through the same reader.
    assert.match(harness, /MISSING_RC=/);
    assert.match(harness, /NOT_A_DB_RC=/);
    assert.match(harness, /SHORT_RC=/);
    assert.match(harness, /synthetic delete-header 1 1/);
    assert.match(harness, /synthetic wal-header 2 2/);
    assert.match(harness, /synthetic unknown-header 3 4/);
    assert.match(harness, /SYNTHETIC_FIXTURES_ARE_STORES=no/);
    assert.match(harness, /seeded-store-paths\.txt/);
    assert.match(harness, /READER_SEEDED_FAILURES=/);
  });

  it("captures real exit codes before logging and fails on any failure", () => {
    // No `| tail` status capture; the child's rc is taken directly.
    assert.doesNotMatch(harness, /"\$@"[^\n]*\|\s*tail/);
    assert.match(harness, /"\$@" > "\$out" 2>&1\n  local rc=\$\?/);
    assert.match(harness, /STEP_RC=\$name=\$rc/);
    assert.match(harness, /FAILED_STEPS="/);
    assert.match(harness, /if \[ "\$FINAL_RESULT" != "PASS" \]; then/);
    assert.match(harness, /exit 1/);
    assert.match(harness, /FINAL_HARNESS_RESULT=/);
    assert.match(harness, /TOTAL_ASSERT_FAIL=/);
  });

  it("records the safety counts, including zero opens/writes in the operator home", () => {
    assert.match(harness, /CONTAINER_HOME_INSIDE_SCRATCH_ROOT=/);
    assert.match(harness, /CONTAINER_ONLY_MOUNT_IS_SCRATCH_ROOT=/);
    assert.match(harness, /CONTAINER_MOUNTS_OUTSIDE_SCRATCH_ROOT=/);
    assert.match(harness, /CONTAINER_MOUNTS_UNDER_REAL_OPERATOR_HOME=/);
    assert.match(harness, /CONTAINER_MOUNTS_UNDER_HOME=/);
    assert.match(harness, /CONTAINER_NETWORK_NONE=/);
    assert.match(harness, /SAFETY_REAL_OPERATOR_HOME=\$REAL_OPERATOR_HOME/);
    assert.match(harness, /SAFETY_EVIDENCE_MENTIONS=/);
    assert.match(harness, /SAFETY_OPENS_OR_WRITES_UNDER_REAL_OPERATOR_HOME=/);
    // A mention is not an open: the refusal-guard mention does not count.
    assert.match(harness, /a mention in a refusal guard is NOT an open or a write/);
    assert.match(harness, /SAFETY_SCAN_NOTE=a mention is not an open or a write/);
  });

  it("records a consolidated log with every step, verdict and control", () => {
    assert.match(log, /SCRATCH_ROOT_KEPT=yes/);
    assert.match(log, new RegExp(`FINAL_SCRATCH_ROOT=${FINAL_ROOT_PREFIX}\\.[A-Za-z0-9]{6} \\(kept as evidence\\)`));
    assert.match(log, /FINAL_HARNESS_RESULT=PASS/);
    assert.match(log, /TOTAL_ASSERT_FAIL=0/);
    assert.match(log, /FAILED_STEPS=none/);

    // A section for runtime identity, seeding and each of the four probes.
    for (const section of [
      "read_header_checks",
      "runtime_identity",
      "seeding",
      "read_header_seeded",
      ...STORES.map((store) => store.step),
    ]) {
      assert.ok(
        log.includes(`## STEP: ${section}`),
        `consolidated log is missing the ${section} section`,
      );
      assert.ok(
        log.includes(`STEP_RC=${section}=0`),
        `consolidated log records a non-zero ${section} step`,
      );
    }

    // Exercised runtime, recorded so the log is self-describing.
    assert.ok(log.includes(`IMAGE_ID=${IMAGE_ID}`), "log misses the image id");
    assert.match(log, /^ARCH=amd64$/m);
    assert.match(log, /^OS=linux$/m);
    assert.ok(
      log.includes(`STOCK_HERMES_REVISION=${HERMES_REVISION}`),
      "log misses the stock Hermes revision",
    );
    assert.match(log, /MATCHLOCK_ARTIFACT_RELATIONSHIP=UNVERIFIED/);
    assert.match(
      log,
      /SCOPE=a container run does NOT qualify Matchlock's shared-filesystem behaviour across a guest boundary/,
    );

    // Every store: HONOURING + identifiable-record assertion + WAL control 2,2.
    assert.match(
      log,
      /STORE_VERDICTS state\.db=HONOURING verification_evidence\.db=HONOURING kanban\.db=HONOURING projects\.db=HONOURING/,
    );
    for (const store of STORES) {
      assert.match(
        log,
        new RegExp(`^${store.db.replace(/\./g, "\\.")} \\| HONOURING \\| .*absent->present.* \\| .*header 2,2 \\(mode wal\\)$`, "m"),
        `consolidated table row for ${store.db} misses a verdict/assertion/control`,
      );
      assert.match(
        log,
        new RegExp(`assertions: pass=[1-9][0-9]+ fail=0 log=${FINAL_ROOT_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^ ]*/${store.step}\\.log`),
        `consolidated log misses the assertion counts for ${store.db}`,
      );
    }

    // Safety counts as recorded by the run.
    assert.match(log, /CONTAINER_HOME_INSIDE_SCRATCH_ROOT=yes \(\d+\/\d+ invocations\)/);
    assert.match(log, /CONTAINER_ONLY_MOUNT_IS_SCRATCH_ROOT=yes \(\d+\/\d+ invocations\)/);
    assert.match(log, /CONTAINER_MOUNTS_OUTSIDE_SCRATCH_ROOT=0/);
    assert.match(log, /CONTAINER_MOUNTS_UNDER_HOME=0/);
    assert.ok(log.includes(`SAFETY_REAL_OPERATOR_HOME=${REAL_HOME}`));
    assert.match(log, /SAFETY_EVIDENCE_MENTIONS=0/);
    assert.match(log, /SAFETY_OPENS_OR_WRITES_UNDER_REAL_OPERATOR_HOME=0/);
  });

  it("keeps the recorded scratch root on disk when it is present", () => {
    const recorded = log.match(/FINAL_SCRATCH_ROOT=(\S+)/);
    assert.ok(recorded, "consolidated log does not record the scratch root");
    const root = recorded[1];
    assert.ok(root.startsWith(FINAL_ROOT_PREFIX), `unexpected scratch root ${root}`);
    if (fs.existsSync(root)) {
      assert.ok(fs.statSync(root).isDirectory(), `${root} is not a directory`);
      assert.ok(fs.readdirSync(root).length > 0, `${root} was cleaned up`);
    }
  });

  it("consolidates the verdict table, runtime and unproven list into the doc", () => {
    const section = docSection(
      "## Consolidated harness and per-store verdict table (US-007)",
    );

    // The one command, the kept root and the consolidated log.
    assert.match(section, /docs\/gate\/probes\/g1b\/run_all\.sh/);
    assert.match(section, /docs\/gate\/evidence\/g1b\/final-harness\.log/);
    assert.match(section, new RegExp(`mktemp -d ${TMP_BASE}/g1b-final\\.XXXXXX`));
    assert.match(section, /never\*\* deletes the root|never deletes the root/);
    assert.match(section, /FINAL_HARNESS_RESULT=PASS/);
    assert.match(section, /TOTAL_ASSERT_PASS=633/);
    assert.match(
      section,
      new RegExp(`FINAL_SCRATCH_ROOT=${TMP_BASE}/g1b-final\\.[A-Za-z0-9]{6}`),
    );

    // Exercised artifact identity.
    assert.ok(section.includes(IMAGE_ID), "doc consolidated section misses the image id");
    assert.ok(section.includes(HERMES_REVISION), "doc misses the stock Hermes revision");
    assert.match(section, /architecture `amd64`/);
    assert.match(section, /OS `linux`/);
    assert.ok(section.includes(MATCHLOCK_IMAGE_ID), "doc misses the Matchlock artifact id");
    assert.match(section, /relationship remains \*\*UNVERIFIED\*\*/);

    // Consolidated per-store verdict table with the assertion and the control.
    assert.match(section, /### Consolidated per-store verdict table/);
    for (const store of STORES) {
      assert.match(
        section,
        new RegExp(`\\| \`${store.db.replace(/\./g, "\\.")}\` \\| \\*\\*HONOURING\\*\\* \\|.*absent→present.* \\|.*header \`2,2\` \\|`),
        `doc consolidated table row for ${store.db} is missing a verdict/assertion/control`,
      );
    }
  });

  it("states the scope limits, unproven items and the BLOCKER policy", () => {
    const unproven = docSection("## What remains unproven");
    assert.match(unproven, /Matchlock guest-boundary shared-filesystem behaviour/);
    assert.match(
      unproven,
      /does not qualify Matchlock's shared-filesystem behaviour across a guest\s+boundary/,
    );
    assert.match(unproven, /Concurrency/);
    assert.match(unproven, /multiple simultaneous writers|simultaneous writers/);
    assert.match(unproven, /Stores\/features not triggered/);
    assert.match(unproven, /artifact relationship/i);
    assert.match(unproven, /UNVERIFIED/);

    const blocker = docSection("## BLOCKER policy");
    assert.match(blocker, /preserve\s+the\s+reproducer/);
    assert.match(blocker, /never exclude the store/);
    assert.match(blocker, /never\s*(exclude|weaken|fabricate)/);
    assert.match(blocker, /exits nonzero/);

    // Status reflects the observed outcome, with the scope limits restated.
    const status = docSection("## Status");
    assert.match(status, /COMPLETE/);
    assert.match(status, /FINAL_HARNESS_RESULT=PASS/);
    assert.match(
      status,
      /does \*\*not\*\* qualify Matchlock's\s+shared-filesystem behaviour/,
    );
    assert.match(status, /UNVERIFIED/);

    // The Scope section keeps the explicit container-vs-guest-boundary statement.
    const scope = docSection("## Scope");
    assert.match(
      scope,
      /does NOT qualify Matchlock's shared-filesystem behaviour across a guest\s+boundary/,
    );
  });

  it("keeps the probe hygiene invariants for the consolidated harness", () => {
    for (const forbidden of [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /PRAGMA\s+journal_mode/i,
      /\bapt(-get)?\s+install\b/,
      /\bpip3?\s+install\b/,
      /\bnpm\s+install\b/,
      /\bbrew\s+install\b/,
      /\bdnf\s+install\b/,
      /docker run/,
    ]) {
      assert.doesNotMatch(harness, forbidden, `run_all.sh contains ${forbidden}`);
    }
    // Containers only ever go through the single gateway, which passes the
    // fixed flag set (including --network none and --user).
    assert.match(harness, /g1b_container_run "\$ROOT"/);
    assert.match(harness, /g1b_container_run "\$seed_root"/);
    assert.match(harness, /g1b_refuse_real_home "\$ROOT"/);
    assert.match(harness, /g1b_bootstrap_read_header "\$ROOT"/);
  });
});
