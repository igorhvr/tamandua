/**
 * G1-B stock-runtime qualification — US-002 seeding-harness contract.
 *
 * The delete-mode probes can only prove *persistence of a specific row* if the
 * seeding harness seeds each store with its REAL writer and an identifiable
 * marker.  This file pins that harness: the four writers, the read-only
 * persistence checker, the container-side seeding driver, its captured evidence
 * and the restated required-vs-optional store table.
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
const COMMON = path.join(G1B_PROBES, "g1b_common.sh");
const WRITERS = path.join(G1B_PROBES, "g1b_writers.py");
const READONLY = path.join(G1B_PROBES, "g1b_readonly.py");
const SEED_CONTAINER = path.join(G1B_PROBES, "g1b_seed_container.sh");
const SEED_STORES = path.join(G1B_PROBES, "seed_stores.sh");
const SEEDING_EVIDENCE = path.join(GATE_DIR, "evidence", "g1b", "store-seeding.txt");

const REQUIRED_HERMES_REVISION = "4d04303818b61bf3aa09278af48356315515965b";

interface StoreSpec {
  key: string;
  db: string;
  table: string;
  /** Column the real writer records the marker in. */
  column: string;
}

const STORES: StoreSpec[] = [
  { key: "state", db: "state.db", table: "sessions", column: "id" },
  {
    key: "verification",
    db: "verification_evidence.db",
    table: "verification_events",
    column: "session_id",
  },
  { key: "kanban", db: "kanban.db", table: "tasks", column: "id" },
  { key: "projects", db: "projects.db", table: "projects", column: "slug" },
];

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

function probeSources(): { name: string; text: string }[] {
  return fs
    .readdirSync(G1B_PROBES)
    .filter((name) => /\.(sh|py)$/.test(name))
    .map((name) => ({ name, text: read(path.join(G1B_PROBES, name)) }));
}

/** Evidence for one store: the text between its "## Store <db>" heading and the next heading. */
function evidenceSection(doc: string, db: string): string {
  const marker = `## Store ${db}`;
  const start = doc.indexOf(marker);
  assert.notEqual(start, -1, `seeding evidence is missing a section for ${db}`);
  const after = doc.slice(start + marker.length);
  const end = after.indexOf("\n## ");
  return end === -1 ? after : after.slice(0, end);
}

function evField(section: string, key: string): string {
  const match = section.match(new RegExp(`^\\s*${key}=(.*)$`, "m"));
  assert.ok(match, `seeding evidence is missing ${key}`);
  return (match?.[1] ?? "").trim();
}

function summaryField(section: string, key: string): string {
  const match = section.match(new RegExp(`${key}=(\\S+)`));
  assert.ok(match, `store summary is missing ${key}`);
  return (match?.[1] ?? "").trim();
}

describe("G1-B US-002 seeding harness", () => {
  it("provides writers, a read-only checker and the seeding driver", () => {
    for (const file of [WRITERS, READONLY, SEED_CONTAINER, SEED_STORES]) {
      assert.ok(fs.existsSync(file), `missing probe file ${path.basename(file)}`);
      assert.ok(read(file).length > 0, `${path.basename(file)} is empty`);
    }
  });

  it("drives all four stores through their REAL writers", () => {
    const writers = read(WRITERS);
    assert.match(writers, /from hermes_state import SessionDB/);
    assert.match(writers, /create_session\(session_id=marker/);
    assert.match(writers, /from agent\.verification_evidence import record_verify_run/);
    assert.match(writers, /record_verify_run\(root=workspace, session_id=marker, ok=True\)/);
    assert.match(writers, /\["kanban", "create", marker, "--json"\]/);
    assert.match(writers, /\["project", "create", marker, "--slug", marker\]/);

    for (const store of STORES) {
      assert.ok(
        writers.includes(`"${store.key}"`),
        `writers do not declare the ${store.key} store`,
      );
      assert.ok(
        writers.includes(`"${store.db}"`),
        `writers do not map the ${store.key} store to ${store.db}`,
      );
    }

    // The identifiable record is what the persistence assertions name.
    assert.match(writers, /WRITER_RECORD_TABLE/);
    assert.match(writers, /WRITER_RECORD_COLUMN/);
    assert.match(writers, /WRITER_RECORD_ID/);
  });

  it("proves the verification writer opts the store in explicitly", () => {
    const writers = read(WRITERS);
    assert.match(writers, /HERMES_VERIFY_ON_STOP/);
    assert.match(writers, /verify_on_stop_enabled/);
    assert.match(writers, /verify_on_stop is OFF/);
    const driver = read(SEED_CONTAINER);
    // The fixture config is written by a printf template, so the newlines are
    // literal `\n` escapes in the script text.
    assert.match(driver, /agent:\\n\s+verify_on_stop: true/);
    assert.match(driver, /database:\\n\s+journal_mode: wal/);
  });

  it("opens fixtures only read-only and prints the exact SQL it ran", () => {
    const readonly = read(READONLY);
    assert.match(readonly, /sqlite3\.connect\(uri, uri=True/);
    assert.match(readonly, /\?mode=ro/);
    assert.match(readonly, /PRAGMA query_only=ON/);
    assert.match(readonly, /FROM sqlite_master WHERE type = 'table'/);
    assert.match(readonly, /READONLY_TABLE_COUNT/);
    assert.match(readonly, /READONLY_SQL/);
    assert.match(readonly, /READONLY_MATCH_COUNT_TOTAL/);
  });

  it("never reads a journal mode through SQLite and never writes store rows", () => {
    const writes = [
      { name: "row insertion", re: /\bINSERT\s+INTO\b/i },
      { name: "row modification", re: /\bUPDATE\s+\w+\s+SET\b/i },
      { name: "row removal", re: /\bDELETE\s+FROM\b/i },
      { name: "journal_mode write pragma", re: /PRAGMA\s+journal_mode/i },
    ];
    for (const { name, text } of probeSources()) {
      for (const { name: kind, re } of writes) {
        assert.doesNotMatch(text, re, `${name} contains a raw ${kind}`);
      }
    }
  });

  it("installs nothing and never runs docker outside the single gateway", () => {
    const installs = [
      /\bapt(-get)?\s+install\b/,
      /\bpip3?\s+install\b/,
      /\bnpm\s+install\b/,
      /\bbrew\s+install\b/,
      /\bdnf\s+install\b/,
    ];
    for (const { name, text } of probeSources()) {
      for (const re of installs) {
        assert.doesNotMatch(text, re, `${name} installs a package`);
      }
      if (name !== "g1b_common.sh") {
        assert.doesNotMatch(text, /docker run/, `${name} bypasses the g1b_container_run gateway`);
      }
    }

    const common = read(COMMON);
    const gateway = common.slice(common.indexOf("g1b_container_run()"));
    for (const flag of ["--rm", "--network none", "--platform", "--user", "-v \""]) {
      assert.ok(gateway.includes(flag), `container gateway is missing ${flag}`);
    }
    assert.match(gateway, /bash -c/);
    assert.doesNotMatch(gateway, /bash -lc/);
  });

  it("keeps its scratch root and cannot exit 0 on a failed assertion", () => {
    const seed = read(SEED_STORES);
    assert.match(seed, /g1b_scratch store-seeding/);
    assert.match(seed, /SCRATCH_ROOT_KEPT=yes/);
    assert.doesNotMatch(seed, /trap\s+'?rm -rf/);
    // `g1b_summary | tee` would make the pipeline status tee's, so a failed
    // assertion still exited 0.  The status must be captured before teeing.
    assert.match(seed, /summary_out="\$\(g1b_summary\)"/);
    assert.doesNotMatch(seed, /if g1b_summary \| tee/);
  });

  it("records WAL seeding evidence for all four stores", () => {
    const doc = read(SEEDING_EVIDENCE);

    for (const store of STORES) {
      const section = evidenceSection(doc, store.db);
      assert.match(section, new RegExp(`CONFIG_EXPECTED=database\\.journal_mode: wal`));
      assert.match(section, /RESOLVED_MODE=wal/);

      // Two real writer runs, both exit 0.
      assert.match(section, /WRITER1_EXIT=0/);
      assert.match(section, /WRITER2_EXIT=0/);

      // Raw header bytes 2,2 after EACH close (journal format never came from SQLite).
      assert.match(section, new RegExp(`HEADER_AFTER_RUN_1 bytes=2,2 mode=wal`));
      assert.match(section, new RegExp(`HEADER_AFTER_RUN_2 bytes=2,2 mode=wal`));

      // Size and sha256 are recorded for both runs and the store actually changed.
      const sha1 = summaryField(section, "HEADER_AFTER_RUN_1[^\\n]*sha256");
      const sha2 = summaryField(section, "HEADER_AFTER_RUN_2[^\\n]*sha256");
      assert.match(sha1, /^[0-9a-f]{64}$/);
      assert.match(sha2, /^[0-9a-f]{64}$/);
      assert.notEqual(sha1, sha2, `${store.db} was not rewritten by the second writer run`);
      for (const key of ["HEADER_AFTER_RUN_1", "HEADER_AFTER_RUN_2"]) {
        const line = section.slice(section.indexOf(key), section.indexOf(key) + 200);
        assert.match(line, /size=[1-9][0-9]*/, `${store.db} size not recorded in ${key}`);
      }

      // All three sidecar states are reported after each close.
      for (const run of ["SIDECARS_AFTER_RUN_1", "SIDECARS_AFTER_RUN_2"]) {
        const line = section.slice(section.indexOf(run), section.indexOf(run) + 120);
        for (const sidecar of ["-wal=", "-shm=", "-journal="]) {
          assert.ok(line.includes(sidecar), `${store.db} ${run} misses ${sidecar}`);
        }
        assert.match(line, /-(wal|shm|journal)=(absent|present)/);
      }

      // The identifiable record (marker + the store's own id) is named.
      assert.match(section, new RegExp(`RECORD_1 table=${store.table} column=${store.column}`));
      assert.match(section, new RegExp(`RECORD_2 table=${store.table} column=${store.column}`));
      assert.match(section, /id=\S+/);

      // Marker scheme and uniqueness: the never-written marker differs from both.
      const marker1 = evField(section, "MARKER_1");
      const marker2 = evField(section, "MARKER_2");
      const absent = evField(section, "NOT_WRITTEN_MARKER");
      assert.match(marker1, new RegExp(`^g1b-${store.key}-[A-Za-z0-9-]+-1$`));
      assert.match(marker2, new RegExp(`^g1b-${store.key}-[A-Za-z0-9-]+-2$`));
      assert.notEqual(marker1, marker2);
      assert.notEqual(absent, marker1);
      assert.notEqual(absent, marker2);

      // Read-only persistence: written markers present, never-written marker absent.
      assert.match(section, /READONLY_MARK1_TABLE_COUNT=1/);
      assert.match(section, /READONLY_MARK2_TABLE_COUNT=1/);
      assert.match(section, /READONLY_NOTWRITTEN_TOTAL=0/);
      assert.match(section, /READONLY_NOTWRITTEN_TABLE_COUNT=0/);

      // Stock purity before AND after the writer runs: revision unchanged,
      // checkout still clean.
      assert.match(
        section,
        new RegExp(
          `STOCK_PURITY revision=${REQUIRED_HERMES_REVISION} porcelain_empty=yes ` +
            `after_revision=${REQUIRED_HERMES_REVISION} after_porcelain_empty=yes`,
        ),
      );
    }

    assert.match(doc, /ASSERT SUMMARY: pass=\d+ fail=0/);
    assert.doesNotMatch(doc, /ASSERT FAIL:/);
    assert.match(doc, /SCRATCH_ROOT_KEPT=yes/);
    assert.match(doc, /MATCHLOCK_ARTIFACT_RELATIONSHIP=UNVERIFIED/);
    assert.ok(
      doc.includes("sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a"),
      "seeding evidence does not name the exercised image id",
    );
  });

  it("records the read-only SQL text and the ro open URI in the evidence", () => {
    const doc = read(SEEDING_EVIDENCE);
    assert.ok((doc.match(/\?mode=ro/g) ?? []).length >= STORES.length);
    assert.match(doc, /READONLY_SQL table=\S+: SELECT COUNT\(\*\) FROM/);
    assert.match(doc, /READONLY_MATCHED_TABLES=/);
  });

  it("records the required-vs-optional store table for the published image", () => {
    const doc = read(G1B_DOC);
    assert.match(
      doc,
      /## Store set and required-vs-optional \(restated for the published image\)/,
    );
    for (const store of STORES) {
      assert.ok(doc.includes(`\`${store.db}\``), `doc store table misses ${store.db}`);
    }
    assert.match(doc, /REQUIRED core/);
    assert.match(doc, /optional \/ gated/);
    assert.match(doc, /record_verify_run/);
    assert.match(doc, /hermes kanban create/);
    assert.match(doc, /hermes project create/);
    assert.match(doc, /## Seeding harness \(US-002\)/);
  });

  it("does not claim a Matchlock artifact relationship from a container run", () => {
    const doc = read(G1B_DOC);
    assert.match(doc, /does \*\*not\*\* qualify Matchlock|does NOT qualify Matchlock/);
    assert.match(doc, /UNVERIFIED/);
  });
});
