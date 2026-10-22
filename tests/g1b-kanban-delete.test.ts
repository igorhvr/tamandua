/**
 * G1-B stock-runtime qualification — US-005 `kanban.db` delete-mode contract.
 *
 * `kanban.db` is the OPTIONAL kanban board store, gated by USE: a default
 * session never touches it, so the writer must be the real record-committing
 * trigger `hermes kanban create "<marker>"` — `kanban list` commits no record
 * and is explicitly NOT the writer.  The probe must also record the store's
 * path resolution (`kanban_home()` = `HERMES_KANBAN_HOME` else
 * `get_default_hermes_root()`; the board root is shared across profiles by
 * design) and use a default-profile fixture root, because a writer that opened
 * a different file would make every later reading meaningless.
 *
 * The decisive experiment: seed WAL with the real trigger, copy byte-identically,
 * convert ONLY the copy offline, run the real trigger TWICE under a
 * delete-resolving config, and after each close prove an identifiable `tasks`
 * row through a SEPARATE read-only connection — not merely that an opener
 * returned.
 *
 * This file pins that deliverable: the probe shape (containerized, one gateway,
 * raw-header measurement, two real trigger runs, WAL control), the captured
 * evidence, and the doc section.  It is pure filesystem/doc parsing (no bash, no
 * docker), so it stays in the parallel lane.
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
const PROBE = path.join(G1B_PROBES, "probe_kanban_delete.sh");
const CONTAINER = path.join(G1B_PROBES, "g1b_kanban_delete_container.sh");
const COMMON = path.join(G1B_PROBES, "g1b_common.sh");
const WRITERS = path.join(G1B_PROBES, "g1b_writers.py");
const READONLY = path.join(G1B_PROBES, "g1b_readonly.py");
const READ_HEADER = path.join(GATE_DIR, "probes", "read_header.py");
const EVIDENCE = path.join(GATE_DIR, "evidence", "g1b", "kanban-delete.txt");

const IMAGE_ID =
  "sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a";
const MATCHLOCK_IMAGE_ID =
  "sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff";
const HERMES_REVISION = "4d04303818b61bf3aa09278af48356315515965b";
const EVIDENCE_TABLE = "tasks";

function read(file: string): string {
  return fs.readFileSync(file, "utf-8");
}

/** First `KEY=value` occurrence in the evidence (container lines are indented). */
function evField(evidence: string, key: string): string {
  const match = evidence.match(new RegExp(`^\\s*${key}=(.*)$`, "m"));
  assert.ok(match, `evidence is missing ${key}`);
  return (match?.[1] ?? "").trim();
}

function evHas(evidence: string, key: string): boolean {
  return new RegExp(`^\\s*${key}=`, "m").test(evidence);
}

/** The doc section for this store, from its heading to the next `## ` heading. */
function docSection(doc: string): string {
  const marker = "## Offline conversion persistence for `kanban.db` (G1-B)";
  const start = doc.indexOf(marker);
  assert.notEqual(start, -1, `doc is missing the ${marker} section`);
  const after = doc.slice(start + marker.length);
  const end = after.indexOf("\n## ");
  return end === -1 ? after : after.slice(0, end);
}

const evidence = read(EVIDENCE);
const doc = read(G1B_DOC);
const section = docSection(doc);
const probe = read(PROBE);
const container = read(CONTAINER);

describe("G1-B US-005 kanban.db delete-mode qualification", () => {
  it("ships a fully containerized kanban.db delete-mode probe", () => {
    for (const file of [PROBE, CONTAINER]) {
      assert.ok(fs.existsSync(file), `missing probe file ${path.basename(file)}`);
      assert.ok(read(file).length > 500, `${path.basename(file)} is suspiciously small`);
    }
    assert.ok(
      fs.statSync(PROBE).mode & 0o111,
      "probe_kanban_delete.sh is not executable",
    );

    // One kept scratch root, one container gateway, everywhere.
    assert.match(probe, /g1b_scratch kanban-delete/);
    assert.match(probe, /SCRATCH_ROOT_KEPT=yes/);
    assert.doesNotMatch(probe, /trap\s+'?"?rm -rf/);
    assert.match(probe, /g1b_container_run "\$ROOT"/);
    // `g1b_summary | tee` would return tee's status; capture the status first.
    assert.match(probe, /summary_out="\$\(g1b_summary\)"/);
    assert.doesNotMatch(probe, /if g1b_summary \| tee/);
    // The scratch root must be refused if it resolves into the operator home.
    assert.match(probe, /g1b_refuse_real_home "\$ROOT"/);
    // No kanban env override or non-default board may redirect the store.
    assert.match(container, /unset HERMES_KANBAN_HOME HERMES_KANBAN_DB HERMES_KANBAN_BOARD/);
  });

  it("records the kanban path resolution before any writer runs", () => {
    // The driver probes the stock resolver (never an invented path) before the
    // seed stage, for BOTH a default-profile root and a named profile.
    const stage0 = container.indexOf("== 0. prove kanban path resolution");
    const stage1 = container.indexOf("== 1. seed a real kanban.db");
    assert.ok(stage0 > 0 && stage1 > stage0, "path stage does not precede seeding");
    assert.match(container, /from hermes_cli\.kanban_db import kanban_home, boards_root, get_current_board, DEFAULT_BOARD/);
    assert.match(container, /from hermes_constants import get_default_hermes_root/);
    assert.match(container, /path_probe DEFAULT_PROFILE "\$SEED_HOME"/);
    assert.match(container, /path_probe NAMED_PROFILE "\$PROFILE_HOME"/);

    // Evidence: the fixture home IS the board root and the default board store.
    assert.equal(evField(evidence, "KANBAN_FIXTURE_IS_DEFAULT_PROFILE_ROOT"), "yes");
    assert.equal(evField(evidence, "KANBAN_ENV_OVERRIDES_UNSET"), "yes");
    assert.equal(evField(evidence, "DEFAULT_PROFILE_PATH_PROBE_RC"), "0");
    assert.equal(
      evField(evidence, "DEFAULT_PROFILE_PATH_ROOT"),
      evField(evidence, "DEFAULT_PROFILE_HERMES_HOME"),
    );
    assert.equal(
      evField(evidence, "DEFAULT_PROFILE_PATH_KANBAN_HOME"),
      evField(evidence, "DEFAULT_PROFILE_HERMES_HOME"),
    );
    assert.equal(
      evField(evidence, "DEFAULT_PROFILE_PATH_DB"),
      `${evField(evidence, "DEFAULT_PROFILE_HERMES_HOME")}/kanban.db`,
    );
    assert.equal(evField(evidence, "DEFAULT_PROFILE_CURRENT_BOARD"), "default");
    // A named profile shares the ROOT board instead of forking one per profile.
    assert.equal(evField(evidence, "NAMED_PROFILE_PATH_PROBE_RC"), "0");
    assert.equal(
      evField(evidence, "NAMED_PROFILE_PATH_KANBAN_HOME"),
      evField(evidence, "NAMED_PROFILE_PATH_ROOT"),
    );
    assert.notEqual(
      evField(evidence, "NAMED_PROFILE_PATH_KANBAN_HOME"),
      evField(evidence, "NAMED_PROFILE_HERMES_HOME"),
    );
    assert.match(
      evField(evidence, "NAMED_PROFILE_HERMES_HOME"),
      /\/profiles\/named$/,
    );
    // The resolution rule itself is stated in the evidence and the doc.
    assert.match(evidence, /KANBAN_RESOLUTION_RULE=kanban_home\(\) = HERMES_KANBAN_HOME else get_default_hermes_root\(\)/);
    assert.match(evidence, /KANBAN_SHARED_ROOT_NUANCE=the board root is shared across profiles BY DESIGN/);
    assert.match(section, /kanban_home\(\)/);
    assert.match(section, /get_default_hermes_root\(\)/);
    assert.match(section, /shared across profiles by design/i);
    assert.match(section, /default-profile fixture root/);
  });

  it("uses the real record-committing kanban trigger, never `kanban list`", () => {
    assert.match(read(WRITERS), /proc = _run_cli\(\["kanban", "create", marker, "--json"\], home\)/);
    assert.match(container, /WRITERS" "\$STORE" "\$marker"/);
    assert.match(container, /STORE=kanban\b/);
    assert.match(container, /DB_NAME=kanban\.db/);
    // `kanban list` must never be the writer (it commits no record). Only the
    // record-committing create trigger is invoked.
    assert.doesNotMatch(read(WRITERS), /\[\s*"kanban",\s*"list"/);
    assert.doesNotMatch(container, /_run_cli\(\[\s*"kanban",\s*"list"/);
    assert.match(section, /`kanban list` commits no record and is \*\*not\*\* an acceptable writer/);
    // Each run's store-assigned task id and marker title are recorded.
    assert.match(evField(evidence, "SEED_RECORD_ID"), /^t_[0-9a-z]+$/);
    assert.equal(evField(evidence, "SEED_RECORD_TITLE"), evField(evidence, "MARKER_SEED"));
    assert.match(evField(evidence, "RUN1_RECORD_ID"), /^t_[0-9a-z]+$/);
    assert.match(evField(evidence, "RUN2_RECORD_ID"), /^t_[0-9a-z]+$/);
    assert.equal(evField(evidence, "RUN1_RECORD_TITLE"), evField(evidence, "MARKER_1"));
    assert.equal(evField(evidence, "RUN2_RECORD_TITLE"), evField(evidence, "MARKER_2"));
    assert.notEqual(
      evField(evidence, "RUN1_RECORD_ID"),
      evField(evidence, "RUN2_RECORD_ID"),
    );
  });

  it("runs the exact decisive experiment stages", () => {
    // 1 seed WAL with the real trigger, 2 cp -a + byte identity, 3 offline
    // conversion of the copy only, 4 TWO real trigger runs under delete,
    // 5 the WAL control on the SAME converted copy.
    assert.match(container, /cp -a -- "\$SEED_HOME\/\$DB_NAME" "\$CONV_DB"/);
    assert.match(container, /cmp -s -- "\$SEED_HOME\/\$DB_NAME" "\$CONV_DB"/);
    assert.match(container, /sessions set-journal-mode delete --db "\$CONV_DB"/);
    assert.match(container, /write_config "\$SEED_HOME" wal/);
    assert.match(container, /write_config "\$DELETE_HOME" delete/);
    assert.match(container, /write_config "\$CONTROL_HOME" wal/);
    assert.match(container, /writer SEED "\$SEED_HOME" "\$MARK_SEED"/);
    assert.match(container, /writer RUN1 "\$DELETE_HOME" "\$MARK1"/);
    assert.match(container, /writer RUN2 "\$DELETE_HOME" "\$MARK2"/);
    assert.match(container, /writer CONTROL "\$CONTROL_HOME" "\$MARK_CONTROL"/);
    // Stock purity is recorded around the runs.
    assert.match(container, /check_stock STOCK$/m);
    assert.match(container, /check_stock STOCK_AFTER/);
  });

  it("measures journal format only from raw header bytes", () => {
    // The header reader is the ONLY mode oracle: no journal_mode pragma, and the
    // read-only checker is never used to inspect a mode.
    for (const text of [probe, container, read(READONLY), read(WRITERS)]) {
      assert.doesNotMatch(text, /PRAGMA\s+journal_mode/i);
    }
    assert.match(container, /measure\(\) \{/);
    assert.match(container, /"\$PYTHON" "\$READ_HEADER" "\$db"/);
    assert.match(container, /for field in size sha256 byte18 byte19 mode/);
    // The read-only connection is exclusively the persistence assertion.
    assert.match(container, /readonly_check\(\) \{/);
    assert.match(container, /"\$PYTHON" "\$READONLY" --db "\$db" --marker "\$marker"/);
    assert.match(read(READONLY), /\?mode=ro/);
    assert.match(read(READ_HEADER), /SQLite format 3/);
  });

  it("records artifact identity, stock purity and the kept scratch root", () => {
    assert.ok(evidence.includes(`IMAGE_ID=${IMAGE_ID}`), "evidence image id mismatch");
    assert.ok(
      evidence.includes(`MATCHLOCK_ARTIFACT_ID=${MATCHLOCK_IMAGE_ID}`),
      "evidence does not record the Matchlock artifact id",
    );
    assert.match(evidence, /MATCHLOCK_ARTIFACT_RELATIONSHIP=UNVERIFIED/);
    assert.match(evidence, /ARCH=amd64/);
    assert.match(evidence, /OS=linux/);
    assert.match(evidence, /SCRATCH_ROOT=\S*g1b-kanban-delete\./);
    assert.match(evidence, /SCRATCH_ROOT_KEPT=yes/);
    assert.match(
      evidence,
      new RegExp(
        `STOCK_PURITY revision=${HERMES_REVISION} porcelain_empty=yes ` +
          `after_revision=${HERMES_REVISION} after_porcelain_empty=yes`,
      ),
    );
    assert.equal(evField(evidence, "STOCK_REVISION"), HERMES_REVISION);
    assert.equal(evField(evidence, "STOCK_AFTER_REVISION"), HERMES_REVISION);
    assert.equal(evField(evidence, "STOCK_STATUS_PORCELAIN_EMPTY"), "yes");
    assert.equal(evField(evidence, "STOCK_AFTER_STATUS_PORCELAIN_EMPTY"), "yes");
  });

  it("records the WAL seed, byte-identical copy and offline conversion", () => {
    assert.equal(evField(evidence, "SEED_RESOLVED_MODE"), "wal");
    assert.equal(evField(evidence, "SEED_EXIT"), "0");
    assert.equal(evField(evidence, "SEED_RECORD_TABLE"), EVIDENCE_TABLE);
    assert.equal(evField(evidence, "SEED_BYTE18"), "2");
    assert.equal(evField(evidence, "SEED_BYTE19"), "2");
    assert.equal(evField(evidence, "SEED_MODE"), "wal");

    assert.equal(evField(evidence, "COPY_RC"), "0");
    assert.equal(evField(evidence, "COPY_CMP_RC"), "0");
    assert.equal(evField(evidence, "COPY_BYTE_IDENTICAL"), "yes");
    assert.equal(
      evField(evidence, "COPY_SHA256"),
      evField(evidence, "SEED_SHA256"),
      "copy sha256 differs from the seeded store",
    );

    assert.equal(evField(evidence, "CONVERT_EXIT"), "0");
    assert.equal(evField(evidence, "CONVERTED_BYTE18"), "1");
    assert.equal(evField(evidence, "CONVERTED_BYTE19"), "1");
    assert.equal(evField(evidence, "CONVERTED_MODE"), "delete");
    assert.equal(evField(evidence, "CONVERSION_CHANGED_COPY"), "yes");
    assert.match(evidence, /CONVERT_CMD=\S.* sessions set-journal-mode delete --db \S+/);
    // The conversion touched only the copy.
    assert.equal(evField(evidence, "SEED_UNCHANGED_BY_CONVERSION"), "yes");
    assert.equal(
      evField(evidence, "SEED_SHA256_AFTER_CONVERT"),
      evField(evidence, "SEED_SHA256"),
    );
    assert.equal(evField(evidence, "CONVERSION_SOURCE_UNTOUCHED"), "yes");
    assert.equal(evField(evidence, "SEED_UNCHANGED_AT_END"), "yes");
  });

  it("records TWO delete-mode trigger runs at header 1,1 with clean sidecars", () => {
    assert.equal(evField(evidence, "DELETE_RESOLVED_MODE"), "delete");
    assert.equal(evField(evidence, "DELETE_BEFORE_BYTE18"), "1");
    assert.equal(evField(evidence, "DELETE_BEFORE_BYTE19"), "1");

    const marker1 = evField(evidence, "MARKER_1");
    const marker2 = evField(evidence, "MARKER_2");
    assert.match(marker1, /^g1b-kanban-[A-Za-z0-9-]+-1$/);
    assert.match(marker2, /^g1b-kanban-[A-Za-z0-9-]+-2$/);
    assert.notEqual(marker1, marker2);

    for (const run of ["RUN1", "RUN2"]) {
      assert.equal(evField(evidence, `${run}_EXIT`), "0", `${run} trigger did not exit 0`);
      assert.equal(evField(evidence, `${run}_RECORD_TABLE`), EVIDENCE_TABLE);
      // Raw header bytes after EACH close.
      assert.equal(evField(evidence, `${run}_BYTE18`), "1", `${run} header byte18`);
      assert.equal(evField(evidence, `${run}_BYTE19`), "1", `${run} header byte19`);
      assert.equal(evField(evidence, `${run}_MODE`), "delete", `${run} raw header mode`);
      // The read-only persistence check must not disturb the measured bytes.
      assert.equal(evField(evidence, `${run}_AFTER_READONLY_BYTE18`), "1");
      assert.equal(evField(evidence, `${run}_AFTER_READONLY_BYTE19`), "1");
      assert.match(evField(evidence, `${run}_SIZE`), /^[1-9][0-9]*$/);
      assert.match(evField(evidence, `${run}_SHA256`), /^[0-9a-f]{64}$/);
      // All three journal sidecar states after the close: nothing may remain.
      for (const sidecar of ["WAL", "SHM", "JOURNAL"]) {
        assert.equal(
          evField(evidence, `${run}_SIDECAR_${sidecar}_STATE`),
          "absent",
          `${run} -${sidecar.toLowerCase()} sidecar not absent`,
        );
      }
      // The zero-byte init lock is reported separately, never as a sidecar.
      assert.equal(evField(evidence, `${run}_INIT_LOCK_STATE`), "present");
      assert.equal(evField(evidence, `${run}_INIT_LOCK_SIZE`), "0");
    }
    // Two consecutive runs really rewrote the store.
    assert.notEqual(
      evField(evidence, "RUN1_SHA256"),
      evField(evidence, "RUN2_SHA256"),
      "run 2 did not change the store",
    );
    assert.match(evidence, /^stage \| path \| size \| sha256 \| header18\/19 \| mode \| sidecars/m);
    assert.match(evidence, /delete home after run 1 \|[^\n]*\| 1,1 \| delete \|/);
    assert.match(evidence, /delete home after run 2 \|[^\n]*\| 1,1 \| delete \|/);
  });

  it("proves persistence with an identifiable tasks record after each close", () => {
    // run 1: marker absent before, present after -> absent->present.
    assert.equal(evField(evidence, "RO_RUN1_BEFORE_MARK1_TASK_COUNT"), "0");
    assert.equal(evField(evidence, "RO_RUN1_AFTER_MARK1_TASK_COUNT"), "1");
    // run 2: marker absent before, present after; run 1's row still there.
    assert.equal(evField(evidence, "RO_RUN2_BEFORE_MARK1_TASK_COUNT"), "1");
    assert.equal(evField(evidence, "RO_RUN2_BEFORE_MARK2_TASK_COUNT"), "0");
    assert.equal(evField(evidence, "RO_RUN2_AFTER_MARK1_TASK_COUNT"), "1");
    assert.equal(evField(evidence, "RO_RUN2_AFTER_MARK2_TASK_COUNT"), "1");
    // A task marker matches exactly one row (the task table only).
    assert.equal(evField(evidence, "RO_RUN1_AFTER_MARK1_TOTAL"), "1");
    assert.equal(evField(evidence, "RO_RUN2_AFTER_MARK2_TOTAL"), "1");
    // The conversion preserved the seeded task row.
    assert.equal(evField(evidence, "RO_DELETE_PRE_SEED_TASK_COUNT"), "1");
    // A marker that was never written stays absent.
    assert.equal(evField(evidence, "RO_NEVER_WRITTEN_TOTAL"), "0");
    // The task table was both reported by the writer and discovered by the match.
    assert.equal(evField(evidence, "EVIDENCE_TABLE"), EVIDENCE_TABLE);
    assert.equal(evField(evidence, "EVIDENCE_TABLE_WRITER_TABLE"), EVIDENCE_TABLE);

    // The read-only connection is genuinely read-only and prints the exact SQL.
    for (const label of ["RUN1_AFTER_MARK1", "RUN2_AFTER_MARK2"]) {
      const start = evidence.indexOf(`RO_${label}_CMD=`);
      assert.notEqual(start, -1, `evidence is missing the RO_${label} block`);
      const block = evidence.slice(start, start + 40_000);
      assert.match(block, /\?mode=ro/, `${label} did not use a mode=ro URI`);
      assert.match(
        block,
        /READONLY_SQL table=tasks: SELECT COUNT\(\*\) FROM "tasks" WHERE/,
        `${label} did not record the exact read-only SQL`,
      );
      assert.match(
        block,
        /CAST\("title" AS TEXT\) = \?/,
        `${label} does not match the marker against tasks.title`,
      );
    }
    assert.equal(evField(evidence, "RO_RUN1_AFTER_MARK1_EXIT"), "0");
    assert.equal(evField(evidence, "RO_RUN2_AFTER_MARK2_EXIT"), "0");
    assert.match(
      evidence,
      /PERSISTENCE_ASSERTION: run 1 task marker absent->present, run 2 task marker absent->present/,
    );
  });

  it("records the WAL control returning the same converted copy to 2,2", () => {
    assert.equal(evField(evidence, "CONTROL_RESOLVED_MODE"), "wal");
    assert.equal(evField(evidence, "CONTROL_BEFORE_BYTE18"), "1");
    assert.equal(evField(evidence, "CONTROL_BEFORE_BYTE19"), "1");
    assert.equal(evField(evidence, "RO_CONTROL_BEFORE_MARK_TASK_COUNT"), "0");
    assert.equal(evField(evidence, "CONTROL_EXIT"), "0");
    assert.equal(evField(evidence, "CONTROL_BYTE18"), "2");
    assert.equal(evField(evidence, "CONTROL_BYTE19"), "2");
    assert.equal(evField(evidence, "CONTROL_MODE"), "wal");
    assert.equal(evField(evidence, "RO_CONTROL_AFTER_MARK_TASK_COUNT"), "1");
    assert.match(
      evidence,
      /WAL_CONTROL: converted copy under database\.journal_mode: wal -> header 2,2/,
    );
  });

  it("records the HONOURING verdict and never a weakened result", () => {
    assert.match(evidence, /VERDICT: kanban\.db HONOURING/);
    assert.match(evidence, /VERDICT_LINE: Verdict: `kanban\.db` HONOURING/);
    assert.match(evidence, /ASSERT SUMMARY: pass=\d+ fail=0/);
    assert.doesNotMatch(evidence, /ASSERT FAIL:/);
    assert.doesNotMatch(evidence, /BLOCKER: /);
    assert.match(evidence, /STORE_IDENTITY=OPTIONAL kanban board store/);
    assert.match(evidence, /TRIGGER=real \/usr\/local\/bin\/hermes kanban create/);
  });

  it("documents the experiment with the path nuance, commands, table and persistence", () => {
    assert.ok(
      section.length > 3_000,
      "kanban.db doc section is too small to be real evidence",
    );
    // Store identity and path resolution.
    assert.match(section, /OPTIONAL kanban board store/);
    assert.match(section, /default-profile fixture root/);
    assert.match(section, /DEFAULT_PROFILE_CURRENT_BOARD=default/);
    // Exact commands.
    assert.match(section, /sessions set-journal-mode delete/);
    assert.match(section, /g1b_writers\.py kanban/);
    assert.match(section, /hermes kanban create/);
    assert.match(section, /cp -a -- /);
    assert.match(section, /cmp -s/);
    // Per-stage table with path, size, sha256, header, mode, sidecars, runs.
    assert.match(
      section,
      /\| Stage \| Path \(container\) \| Size \| sha256 \| Header 18\/19 \| Mode \| Sidecars/,
    );
    assert.match(section, /seed WAL \|/);
    assert.match(section, /converted copy \(offline\) \|/);
    assert.match(section, /delete home after run 1 \|/);
    assert.match(section, /delete home after run 2 \|/);
    assert.match(section, /wal control after writer \|/);
    assert.match(section, /\| 2,2 \| wal \|/);
    assert.match(section, /\| 1,1 \| delete \|/);
    // Persistence assertion with the exact read-only SQL and before/after counts.
    assert.match(section, /Identifiable-record assertion \(the bead's heart\)/);
    assert.match(section, /SELECT COUNT\(\*\) FROM "tasks" WHERE/);
    assert.match(section, /`tasks` count 0/);
    assert.match(section, /`tasks` count 1/);
    assert.match(section, /never written/);
    // Control and verdict.
    assert.match(section, /### WAL control/);
    assert.match(section, /Verdict: `kanban\.db` HONOURING/);
    // Evidence pointer + kept scratch root + assertion count.
    assert.match(section, /docs\/gate\/evidence\/g1b\/kanban-delete\.txt/);
    assert.match(section, /112 assertions, 0\nfailures|112 assertions, 0 failures/);
  });

  it("states what would fail on a WAL reversion for every assertion group", () => {
    assert.match(
      section,
      /What these assertions would catch if the store had reverted to WAL/,
    );
    for (const group of [
      "Path resolution",
      "Seed stage",
      "Copy stage",
      "Conversion stage",
      "Two delete-mode writer runs",
      "Persistence assertion",
    ]) {
      assert.ok(section.includes(group), `reversion rationale misses the ${group}`);
    }
    // Sidecar and control assertions carry their own reversion statement.
    const reversions = section.match(/What would fail on a WAL reversion/g) ?? [];
    assert.ok(
      reversions.length >= 2,
      "sidecar and control assertions need their own WAL-reversion statement",
    );
    assert.match(section, /a re-opened WAL store leaves a `-wal`/);
    assert.match(section, /nothing here — the control is supposed/);
  });

  it("keeps the scope and artifact honesty of the qualification", () => {
    assert.match(doc, /does \*\*not\*\* qualify Matchlock|does NOT qualify Matchlock/);
    assert.match(doc, /UNVERIFIED/);
    assert.match(section, /\*\*does not\*\* qualify Matchlock|does not qualify Matchlock/);
    assert.match(section, /UNVERIFIED/);
    // The status table now carries the verdict for this store.
    assert.match(doc, /\| `kanban\.db` \| \*\*HONOURING\*\* \(US-005\) \|/);
    // The pending-store list no longer includes it (US-006 later advanced).
    assert.match(doc, /`projects\.db` \| \*\*HONOURING\*\* \(US-006\)/);
  });

  it("never writes store rows, installs packages or bypasses the container gateway", () => {
    const writes = [
      /\bINSERT\s+INTO\b/i,
      /\bUPDATE\s+\w+\s+SET\b/i,
      /\bDELETE\s+FROM\b/i,
      /PRAGMA\s+journal_mode/i,
    ];
    const installs = [
      /\bapt(-get)?\s+install\b/,
      /\bpip3?\s+install\b/,
      /\bnpm\s+install\b/,
      /\bbrew\s+install\b/,
      /\bdnf\s+install\b/,
    ];
    for (const [name, text] of [
      ["probe_kanban_delete.sh", probe],
      ["g1b_kanban_delete_container.sh", container],
    ] as const) {
      for (const re of writes) assert.doesNotMatch(text, re, `${name} writes store rows`);
      for (const re of installs) assert.doesNotMatch(text, re, `${name} installs a package`);
      assert.doesNotMatch(text, /docker run/, `${name} bypasses g1b_container_run`);
      assert.doesNotMatch(
        text,
        /\/home\/kaladin\/\.hermes\//,
        `${name} references a live home path`,
      );
    }
    // The single gateway keeps the mandatory flag set.
    const common = read(COMMON);
    const gateway = common.slice(common.indexOf("g1b_container_run()"));
    for (const flag of ["--rm", "--network none", "--platform", "--user", "-v \""]) {
      assert.ok(gateway.includes(flag), `container gateway is missing ${flag}`);
    }
    assert.doesNotMatch(gateway, /bash -lc/);
    // Evidence records the real container invocation and the image identity.
    assert.match(
      evidence,
      /CONTAINER_INVOCATION: docker run --rm --network none --platform linux\/amd64 --user \d+:\d+ -v \S+:\/work -w \/work -e HOME=\/work\/home igorhvr\/tamandua:latest bash -c/,
    );
    assert.ok(evHas(evidence, "CONTAINER_RC"));
    assert.equal(evField(evidence, "CONTAINER_RC"), "0");
  });
});
