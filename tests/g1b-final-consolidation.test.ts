/**
 * G1-B stock-runtime qualification — US-008 pinned deliverable contract.
 *
 * US-003 … US-006 ran the decisive per-store experiment (seed WAL → copy →
 * offline-convert the copy → TWO real writer runs under a delete-resolving
 * config → separate read-only persistence assertion → raw header + sidecars →
 * WAL control) for `state.db`, `verification_evidence.db`, `kanban.db` and
 * `projects.db` against the PUBLISHED image's own stock Hermes.  US-007 then
 * consolidated the harness, the evidence log and the doc.
 *
 * This file pins that whole deliverable so a future edit cannot silently:
 *   - drop a store or one of its four required observations,
 *   - weaken the persistence assertion to an opener/listing/header-only check,
 *   - lose the WAL control (which is what makes a `1,1` result meaningful),
 *   - claim a Matchlock artifact relationship that was never established, or
 *   - let a probe write store rows, flip journal mode with a pragma, install a
 *     package, or run a container without `--network none` / `--user`.
 *
 * It only reads the doc, the probe sources and the captured evidence files.  It
 * spawns no bash and no docker process, so it belongs to the parallel lane (and
 * must never be added to tests/serial-files.txt).
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
const EVIDENCE_DIR = path.join(GATE_DIR, "evidence", "g1b");
const SERIAL_FILES = path.join(PROJECT_ROOT, "tests", "serial-files.txt");
const SELF_RELATIVE = "tests/g1b-final-consolidation.test.ts";

// Built at runtime so this file's own source does not carry the literal module
// name it forbids (the purity assertion below reads this very file).
const CHILD_PROCESS_MODULE = ["node", "child_process"].join(":");

// The scratch base is a concatenation so this test source never contains the
// literal temp base followed by a slash (the temp-dir guard scans for it).
const TMP_BASE = "/tmp";

const IMAGE_ID =
  "sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a";
const MATCHLOCK_IMAGE_ID =
  "sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff";
const HERMES_REVISION = "4d04303818b61bf3aa09278af48356315515965b";

interface StoreSpec {
  /** Store file name as used in the doc headings, evidence and verdict lines. */
  db: string;
  /** Evidence file stem; the captured file is `<slug>-delete.txt`. */
  slug: string;
  /** The record table proven by the read-only persistence assertion. */
  table: string;
}

/**
 * The four stores of the G1-B required set.  Dropping any one of them must fail
 * this contract: every entry drives its own doc section AND evidence file.
 */
const STORES: StoreSpec[] = [
  { db: "state.db", slug: "state", table: "sessions" },
  {
    db: "verification_evidence.db",
    slug: "verification",
    table: "verification_events",
  },
  { db: "kanban.db", slug: "kanban", table: "tasks" },
  { db: "projects.db", slug: "projects", table: "projects" },
];

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The doc section starting at `marker` and ending before the next `## ` heading. */
function docSection(marker: string): string {
  const start = doc.indexOf(marker);
  assert.notEqual(start, -1, `doc is missing the "${marker}" section`);
  const after = doc.slice(start + marker.length);
  const end = after.indexOf("\n## ");
  return end === -1 ? after : after.slice(0, end);
}

function storeSection(store: StoreSpec): string {
  return docSection(
    `## Offline conversion persistence for \`${store.db}\` (G1-B)`,
  );
}

function evidenceFor(store: StoreSpec): string {
  const file = path.join(EVIDENCE_DIR, `${store.slug}-delete.txt`);
  assert.ok(fs.existsSync(file), `missing evidence file ${path.basename(file)}`);
  return read(file);
}

/** First `KEY=value` occurrence in the evidence (container lines are indented). */
function evField(evidence: string, key: string): string {
  const match = evidence.match(new RegExp(`^\\s*${key}=(.*)$`, "m"));
  assert.ok(match, `evidence is missing ${key}`);
  return (match?.[1] ?? "").trim();
}

/**
 * A per-stage table row in the doc: `| <label> | ... | <header> | <mode> | ...`.
 * Used for the seed WAL row (2,2/wal), the converted copy (1,1/delete), both
 * post-writer rows (1,1/delete) and the WAL control (2,2/wal).
 */
function stageRow(label: string, header: string, mode: string): RegExp {
  return new RegExp(
    `^\\| ${escapeRegExp(label)} \\|.*\\| ${escapeRegExp(header)} \\| ${escapeRegExp(mode)} \\|`,
    "m",
  );
}

const doc = read(G1B_DOC);

describe("G1-B US-008 qualification contract", () => {
  it("ships the consolidated doc and one evidence file per required store", () => {
    assert.ok(fs.existsSync(G1B_DOC), "missing the G1-B doc");
    for (const store of STORES) {
      evidenceFor(store);
      // The per-store doc section exists before any content assertion runs.
      assert.ok(
        storeSection(store).length > 500,
        `doc section for ${store.db} is suspiciously small`,
      );
    }
  });

  for (const store of STORES) {
    it(`pins the ${store.db} delete-mode section and its evidence`, () => {
      const section = storeSection(store);
      const evidence = evidenceFor(store);
      const db = escapeRegExp(store.db);
      const table = escapeRegExp(store.table);

      // ── The verdict line (both in the doc section and the evidence) ──
      assert.match(
        section,
        new RegExp(`^Verdict: \`${db}\` HONOURING$`, "m"),
        `${store.db} section lacks the canonical verdict line`,
      );
      assert.equal(evField(evidence, "STORE"), store.db);
      assert.match(evidence, new RegExp(`^VERDICT: ${db} HONOURING$`, "m"));
      assert.match(
        evidence,
        new RegExp(`^VERDICT_LINE: Verdict: \`${db}\` HONOURING$`, "m"),
      );
      assert.match(evidence, /^ASSERT SUMMARY: pass=[1-9][0-9]* fail=0$/m);

      // ── Seed WAL (2,2) → byte-identical copy → converted copy (1,1) ──
      assert.match(section, stageRow("seed WAL", "2,2", "wal"));
      assert.match(section, stageRow("copy before conversion", "2,2", "wal"));
      assert.match(
        section,
        stageRow("converted copy (offline)", "1,1", "delete"),
      );
      assert.equal(evField(evidence, "SEED_BYTE18"), "2");
      assert.equal(evField(evidence, "SEED_BYTE19"), "2");
      assert.equal(evField(evidence, "SEED_MODE"), "wal");
      assert.equal(evField(evidence, "COPY_BYTE_IDENTICAL"), "yes");
      assert.equal(evField(evidence, "CONVERTED_BYTE18"), "1");
      assert.equal(evField(evidence, "CONVERTED_BYTE19"), "1");
      assert.equal(evField(evidence, "CONVERTED_MODE"), "delete");
      assert.equal(evField(evidence, "CONVERSION_CHANGED_COPY"), "yes");
      assert.equal(evField(evidence, "CONVERSION_SOURCE_UNTOUCHED"), "yes");

      // ── TWO consecutive real writer runs, each 1,1 after close ──
      for (const run of ["run 1", "run 2"]) {
        assert.match(
          section,
          stageRow(`delete home after ${run}`, "1,1", "delete"),
          `${store.db} section lacks the ${run} 1,1 row`,
        );
      }
      for (const prefix of ["RUN1", "RUN2"]) {
        assert.equal(evField(evidence, `${prefix}_BYTE18`), "1");
        assert.equal(evField(evidence, `${prefix}_BYTE19`), "1");
        assert.equal(evField(evidence, `${prefix}_MODE`), "delete");
        // The header is re-read after the read-only check and is still 1,1:
        // the read-only connection did not disturb the bytes.
        assert.equal(evField(evidence, `${prefix}_AFTER_READONLY_BYTE18`), "1");
        assert.equal(evField(evidence, `${prefix}_AFTER_READONLY_BYTE19`), "1");
      }

      // ── All three sidecar states after each close ──
      for (const run of ["after run 1", "after run 2"]) {
        assert.match(
          section,
          new RegExp(`^\\| ${run} \\| absent \\| absent \\| absent \\|$`, "m"),
          `${store.db} section lacks the ${run} sidecar row`,
        );
      }
      assert.match(section, /all three to be absent after each close/);
      for (const prefix of ["RUN1", "RUN2"]) {
        for (const sidecar of ["WAL", "SHM", "JOURNAL"]) {
          assert.equal(
            evField(evidence, `${prefix}_SIDECAR_${sidecar}_STATE`),
            "absent",
            `${store.db} ${prefix} left a -${sidecar.toLowerCase()} sidecar`,
          );
        }
      }

      // ── The identifiable-record before/after assertion, with read-only SQL ──
      assert.match(section, /### Identifiable-record assertion/);
      assert.match(
        section,
        new RegExp(`\`\`\`sql\\nSELECT COUNT\\(\\*\\) FROM "${table}"`),
        `${store.db} section lacks the read-only SQL text`,
      );
      for (const run of ["run 1", "run 2"]) {
        assert.match(
          section,
          new RegExp(
            `^\\| ${run} persistence \\|.*\\| \`${table}\` count 0 \\|.*\`${table}\` count 1`,
            "m",
          ),
          `${store.db} section lacks the ${run} before/after assertion`,
        );
      }
      assert.match(evidence, /READONLY_OPEN_URI=file:.*\?mode=ro/);
      for (const prefix of ["RUN1", "RUN2"]) {
        const n = prefix === "RUN1" ? 1 : 2;
        assert.match(
          evidence,
          new RegExp(`^${prefix} record table=${table}\\b`, "m"),
          `${store.db} ${prefix} does not name its identifiable record`,
        );
        assert.match(
          evidence,
          new RegExp(
            `^\\s+before run ${n}: ${table} count=0 total=0$`,
            "m",
          ),
          `${store.db} ${prefix} lacks the absent baseline`,
        );
        assert.match(
          evidence,
          new RegExp(
            `^\\s+after run ${n} close: ${table} count=1 total=[1-9][0-9]*$`,
            "m",
          ),
          `${store.db} ${prefix} lacks the present assertion`,
        );
        assert.match(
          evidence,
          new RegExp(
            `^\\s+exact SQL: READONLY_SQL table=${table}: SELECT COUNT\\(\\*\\) FROM "${table}"`,
            "m",
          ),
          `${store.db} ${prefix} lacks the exact read-only SQL`,
        );
      }
      assert.match(evidence, /PERSISTENCE_ASSERTION: .*absent->present/);

      // ── The WAL control on the SAME converted copy: 2,2 ──
      assert.match(section, /### WAL control/);
      assert.match(section, /CONTROL_RESOLVED_MODE=wal/);
      assert.match(section, /\*\*`2,2`\*\* \(`wal`\)/);
      assert.match(section, stageRow("wal control after writer", "2,2", "wal"));
      assert.equal(evField(evidence, "CONTROL_RESOLVED_MODE"), "wal");
      assert.equal(evField(evidence, "CONTROL_BYTE18"), "2");
      assert.equal(evField(evidence, "CONTROL_BYTE19"), "2");
      assert.equal(evField(evidence, "CONTROL_MODE"), "wal");
      assert.match(evidence, /WAL_CONTROL: .*header 2,2 \(mode wal\)/);

      // ── Assertion discipline: each stage says what a WAL reversion would do ──
      const reversionStatements = section.match(
        /\*\*What would fail on a WAL reversion:\*\*/g,
      );
      assert.ok(
        (reversionStatements?.length ?? 0) >= 2,
        `${store.db} section lacks the WAL-reversion rationale`,
      );

      // ── The evidence stays attributable and its scratch root is kept ──
      assert.ok(evidence.includes(`IMAGE_ID=${IMAGE_ID}`));
      assert.equal(evField(evidence, "ARCH"), "amd64");
      assert.equal(evField(evidence, "STOCK_HERMES_REVISION"), HERMES_REVISION);
      assert.match(
        evidence,
        new RegExp(
          `SCRATCH_ROOT=${escapeRegExp(TMP_BASE)}/g1b-[a-z-]+\\.[A-Za-z0-9]{6} \\(kept as evidence\\)`,
        ),
        `${store.db} evidence does not record a kept scratch root`,
      );
      assert.match(evidence, /SCOPE: .*does NOT qualify Matchlock/);
      assert.match(evidence, /MATCHLOCK_ARTIFACT_RELATIONSHIP=UNVERIFIED/);
    });
  }

  it("pins the exercised artifact identity and the observed runtime", () => {
    assert.ok(doc.includes(IMAGE_ID), "doc lacks the Docker image digest");
    assert.ok(doc.includes(MATCHLOCK_IMAGE_ID), "doc lacks the Matchlock artifact id");
    assert.ok(doc.includes(HERMES_REVISION), "doc lacks the stock Hermes revision");
    assert.match(doc, /\|\s*Architecture\s*\|\s*`amd64`\s*\|/);
    assert.match(doc, /\|\s*OS\s*\|\s*`linux`\s*\|/);
    // The image ships stock Hermes, not a patched checkout.
    assert.match(doc, /git status --porcelain\*\* empty|`git status --porcelain` \*\*empty\*\*/);
    assert.match(doc, /\/usr\/local\/bin\/hermes/);
    assert.match(doc, /\/opt\/src\/hermes-venv\/bin\/python/);
  });

  it("pins the Matchlock guest-boundary scope and unverified-artifact honesty", () => {
    const scope = docSection("## Scope");
    assert.match(
      scope,
      /does NOT qualify Matchlock's shared-filesystem behaviour across a guest\s+boundary/,
    );
    assert.match(scope, /container run/);

    const artifact = docSection("## Artifact Truth");
    assert.ok(artifact.includes(MATCHLOCK_IMAGE_ID));
    assert.ok(artifact.includes(IMAGE_ID));
    assert.match(artifact, /UNVERIFIED/);
    assert.match(artifact, /no equality claim is made/);
  });

  it("pins the 'What remains unproven' list", () => {
    const unproven = docSection("## What remains unproven");
    assert.match(unproven, /Matchlock guest-boundary shared-filesystem behaviour/);
    assert.match(unproven, /does not qualify Matchlock's shared-filesystem behaviour/);
    assert.match(unproven, /artifact relationship/i);
    assert.match(unproven, /UNVERIFIED/);
    assert.match(unproven, /Concurrency \/ multiple simultaneous writers/);
    assert.match(unproven, /Stores\/features not triggered/);
    assert.match(unproven, /Long-run \/ crash behaviour/);
    assert.match(unproven, /production observer/i);
  });

  it("pins the consolidated verdict table and the COMPLETE status", () => {
    const consolidated = docSection(
      "## Consolidated harness and per-store verdict table (US-007)",
    );
    for (const store of STORES) {
      assert.match(
        consolidated,
        new RegExp(
          `\\| \`${escapeRegExp(store.db)}\` \\| \\*\\*HONOURING\\*\\* \\|.*absent→present.* \\|.*header \`2,2\` \\|`,
        ),
        `consolidated table is missing the ${store.db} row`,
      );
    }
    assert.match(consolidated, /FINAL_HARNESS_RESULT=PASS/);

    const status = docSection("## Status");
    assert.match(status, /COMPLETE/);
    assert.match(status, /FINAL_HARNESS_RESULT=PASS/);
    assert.match(status, /does \*\*not\*\* qualify Matchlock/);
    assert.match(status, /UNVERIFIED/);
  });

  it("rejects raw SQL row writes, journal-mode pragmas and package installs", () => {
    const prohibited = [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /PRAGMA\s+journal_mode/i,
      /\bapt(-get)?\s+install\b/,
      /\bpip3?\s+install\b/,
      /\bnpm\s+install\b/,
      /\bbrew\s+install\b/,
      /\bdnf\s+install\b/,
      /\byum\s+install\b/,
    ];
    for (const name of fs.readdirSync(G1B_PROBES)) {
      const file = path.join(G1B_PROBES, name);
      if (!fs.statSync(file).isFile()) continue;
      const text = read(file);
      for (const re of prohibited) {
        assert.doesNotMatch(text, re, `${name} violates probe hygiene (${re})`);
      }
    }
  });

  it("requires every container invocation to be network-none and user-scoped", () => {
    let invocations = 0;
    for (const name of fs.readdirSync(G1B_PROBES)) {
      const file = path.join(G1B_PROBES, name);
      if (!fs.statSync(file).isFile()) continue;
      const text = read(file);
      let index = text.indexOf("docker run");
      while (index !== -1) {
        // The gateway wraps the flag list over multiple lines, so inspect a
        // forward window rather than a single line.
        const invocation = text.slice(index, index + 400);
        assert.match(
          invocation,
          /--network none/,
          `${name} runs a container without --network none`,
        );
        assert.match(
          invocation,
          /--user/,
          `${name} runs a container without --user`,
        );
        invocations += 1;
        index = text.indexOf("docker run", index + 1);
      }
    }
    assert.ok(invocations >= 1, "no container invocation was found in the harness");
  });

  it("requires the harness and every probe to keep their scratch roots", () => {
    const harness = read(path.join(G1B_PROBES, "run_all.sh"));
    assert.match(harness, /SCRATCH_ROOT_KEPT=yes/);
    assert.match(harness, /FINAL_SCRATCH_ROOT=\$ROOT \(kept as evidence\)/);
    assert.doesNotMatch(harness, /rm\s+-rf?\s+"?\$(?:ROOT|FINAL)/);
    assert.doesNotMatch(harness, /trap\s+'?"?rm -rf/);

    for (const probe of [
      "probe_runtime_identity.sh",
      "seed_stores.sh",
      "probe_state_delete.sh",
      "probe_verification_delete.sh",
      "probe_kanban_delete.sh",
      "probe_projects_delete.sh",
    ]) {
      const text = read(path.join(G1B_PROBES, probe));
      assert.match(text, /SCRATCH_ROOT_KEPT=yes/, `${probe} deletes its fixtures`);
      assert.doesNotMatch(text, /rm\s+-rf?\s+"?\$ROOT/, `${probe} removes its root`);
    }
  });

  it("stays a pure-filesystem test in the parallel lane", () => {
    const serial = read(SERIAL_FILES)
      .split(/\r?\n/)
      .map((line) => line.trim());
    assert.ok(
      !serial.includes(SELF_RELATIVE),
      `${SELF_RELATIVE} spawns nothing and must stay in the parallel lane`,
    );
    // The file must not gain a process-spawning dependency.
    const source = read(path.join(PROJECT_ROOT, SELF_RELATIVE));
    assert.doesNotMatch(source, new RegExp(`from\\s+"${CHILD_PROCESS_MODULE}"`));
    assert.doesNotMatch(
      source,
      new RegExp(`require\\(\\s*["']${CHILD_PROCESS_MODULE}["']`),
    );
  });
});
