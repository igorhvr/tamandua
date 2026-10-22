/**
 * G1-B stock-runtime qualification — US-004 `verification_evidence.db`
 * delete-mode contract.
 *
 * `verification_evidence.db` is the OPTIONAL verify-on-stop evidence ledger: a
 * default session never touches it, so the probe must FIRST prove the opt-in
 * gate (OFF -> `record_verify_run()` returns `None` and the store is absent;
 * `agent.verify_on_stop: true` and the `HERMES_VERIFY_ON_STOP=1` env form ->
 * enabled and the store appears), and only then run the decisive experiment:
 * seed WAL with the real writer, copy byte-identically, convert ONLY the copy
 * offline, run the real writer TWICE under a delete-resolving config, and after
 * each close prove an identifiable `verification_events` row through a SEPARATE
 * read-only connection -- not merely that an opener returned.
 *
 * This file pins that deliverable: the gate proof, the probe shape
 * (containerized, one gateway, raw-header measurement, two real writer runs,
 * WAL control), the captured evidence, and the doc section.  It is pure
 * filesystem/doc parsing (no bash, no docker), so it stays in the parallel lane.
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
const PROBE = path.join(G1B_PROBES, "probe_verification_delete.sh");
const CONTAINER = path.join(G1B_PROBES, "g1b_verification_delete_container.sh");
const GATE_PROVE = path.join(G1B_PROBES, "g1b_verify_gate.py");
const COMMON = path.join(G1B_PROBES, "g1b_common.sh");
const WRITERS = path.join(G1B_PROBES, "g1b_writers.py");
const READONLY = path.join(G1B_PROBES, "g1b_readonly.py");
const READ_HEADER = path.join(GATE_DIR, "probes", "read_header.py");
const EVIDENCE = path.join(
  GATE_DIR,
  "evidence",
  "g1b",
  "verification-delete.txt",
);

const IMAGE_ID =
  "sha256:d15b7b377d679c6561315f7054e16f0310b3956cff872c23818d90073b29934a";
const MATCHLOCK_IMAGE_ID =
  "sha256:9140629c9f408a6e9c285434eb6ab0cebd67db146c324db33e2798bac4fb7dff";
const HERMES_REVISION = "4d04303818b61bf3aa09278af48356315515965b";
const EVIDENCE_TABLE = "verification_events";

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
  const marker =
    "## Offline conversion persistence for `verification_evidence.db` (G1-B)";
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
const gateProve = read(GATE_PROVE);

describe("G1-B US-004 verification_evidence.db delete-mode qualification", () => {
  it("ships a fully containerized verification_evidence.db delete-mode probe", () => {
    for (const file of [PROBE, CONTAINER, GATE_PROVE]) {
      assert.ok(fs.existsSync(file), `missing probe file ${path.basename(file)}`);
      assert.ok(read(file).length > 500, `${path.basename(file)} is suspiciously small`);
    }
    assert.ok(
      fs.statSync(PROBE).mode & 0o111,
      "probe_verification_delete.sh is not executable",
    );

    // One kept scratch root, one container gateway, everywhere.
    assert.match(probe, /g1b_scratch verification-delete/);
    assert.match(probe, /SCRATCH_ROOT_KEPT=yes/);
    assert.doesNotMatch(probe, /trap\s+'?"?rm -rf/);
    assert.match(probe, /g1b_container_run "\$ROOT"/);
    // `g1b_summary | tee` would return tee's status; capture the status first.
    assert.match(probe, /summary_out="\$\(g1b_summary\)"/);
    assert.doesNotMatch(probe, /if g1b_summary \| tee/);
    // The scratch root must be refused if it resolves into the operator home.
    assert.match(probe, /g1b_refuse_real_home "\$ROOT"/);
    // The off-gate fixture can never be silently enabled.
    assert.match(container, /unset [^\n]*HERMES_VERIFY_ON_STOP/);
  });

  it("proves the opt-in gate BEFORE asserting anything about the store", () => {
    // The gate prover is the stock guard + stock writer, read through
    // sqlite_master; it is part of the pinned tool set.
    assert.match(gateProve, /verify_on_stop_enabled/);
    assert.match(gateProve, /record_verify_run/);
    assert.match(gateProve, /SELECT name FROM sqlite_master WHERE type = 'table'/);
    assert.match(gateProve, /mode=ro/);
    assert.match(gateProve, /PRAGMA query_only=ON/);
    assert.doesNotMatch(gateProve, /PRAGMA\s+journal_mode/i);

    // The container driver runs all three gate cases before the seed stage.
    const stage0 = container.indexOf("== 0. prove the verify-on-stop opt-in gate");
    const stage1 = container.indexOf("== 1. seed a real");
    assert.ok(stage0 > 0 && stage1 > stage0, "gate stage does not precede seeding");
    assert.match(container, /gate_check OFF "\$GATE_OFF_HOME"[^\n]*disabled ""/);
    assert.match(container, /gate_check CONFIG_ON "\$GATE_ON_HOME"[^\n]*enabled ""/);
    assert.match(container, /gate_check ENV_FORM "\$GATE_ENV_HOME"[^\n]*enabled 1/);
    // The evidence table comes from the discovered sqlite_master listing.
    assert.match(container, /EVENTS_TABLE="\$\(record_field "\$LOGS\/gate\.CONFIG_ON\.log" GATE_EVIDENCE_TABLE\)"/);

    // Host assertions: OFF -> disabled + None + absent; ON -> enabled + appears.
    assert.equal(evField(evidence, "GATE_OFF_ENABLED"), "no");
    assert.equal(evField(evidence, "GATE_OFF_RECORD_IS_NONE"), "yes");
    assert.equal(evField(evidence, "GATE_OFF_DB_EXISTS_BEFORE"), "no");
    assert.equal(evField(evidence, "GATE_OFF_DB_EXISTS_AFTER"), "no");
    assert.equal(evField(evidence, "GATE_OFF_EVIDENCE_TABLES"), "(absent)");
    assert.equal(evField(evidence, "GATE_CONFIG_ON_ENABLED"), "yes");
    assert.equal(evField(evidence, "GATE_CONFIG_ON_RECORD_IS_NONE"), "no");
    assert.equal(evField(evidence, "GATE_CONFIG_ON_DB_EXISTS_BEFORE"), "no");
    assert.equal(evField(evidence, "GATE_CONFIG_ON_DB_EXISTS_AFTER"), "yes");
    assert.equal(evField(evidence, "GATE_ENV_FORM_ENABLED"), "yes");
    assert.equal(evField(evidence, "GATE_ENV_FORM_RECORD_IS_NONE"), "no");
    assert.equal(evField(evidence, "GATE_ENV_FORM_DB_EXISTS_AFTER"), "yes");
    // The env form names the documented variable.
    assert.match(evidence, /GATE_ENV_FORM_CMD=HERMES_VERIFY_ON_STOP=1 /);
    // Gate-on stores were created in delete mode (supplementary observation).
    assert.equal(evField(evidence, "GATE_ON_DB_BYTE18"), "1");
    assert.equal(evField(evidence, "GATE_ON_DB_BYTE19"), "1");
    assert.equal(evField(evidence, "GATE_ENV_DB_BYTE18"), "1");
    assert.equal(evField(evidence, "GATE_ENV_DB_BYTE19"), "1");

    // The evidence table is DISCOVERED, never assumed.
    assert.equal(evField(evidence, "EVIDENCE_TABLE"), EVIDENCE_TABLE);
    assert.match(
      evField(evidence, "GATE_CONFIG_ON_EVIDENCE_TABLES"),
      /verification_events/,
    );
  });

  it("runs the exact decisive experiment stages", () => {
    // 1 seed WAL with the real writer, 2 cp -a + byte identity, 3 offline
    // conversion of the copy only, 4 TWO real writer runs under delete,
    // 5 the WAL control on the SAME converted copy.
    assert.match(container, /g1b_writers\.py/);
    assert.match(container, /cp -a -- "\$SEED_HOME\/\$DB_NAME" "\$CONV_DB"/);
    assert.match(container, /cmp -s -- "\$SEED_HOME\/\$DB_NAME" "\$CONV_DB"/);
    assert.match(container, /sessions set-journal-mode delete --db "\$CONV_DB"/);
    assert.match(container, /write_config "\$SEED_HOME" wal on/);
    assert.match(container, /write_config "\$DELETE_HOME" delete on/);
    assert.match(container, /write_config "\$CONTROL_HOME" wal on/);
    assert.match(container, /writer RUN1 "\$DELETE_HOME" "\$MARK1"/);
    assert.match(container, /writer RUN2 "\$DELETE_HOME" "\$MARK2"/);
    assert.match(container, /writer CONTROL "\$CONTROL_HOME" "\$MARK_CONTROL"/);
    // The writer command is the store's own code path, not hand-written SQL.
    assert.match(container, /WRITERS" "\$STORE" "\$marker"/);
    // Stock purity is recorded around the runs.
    assert.match(container, /check_stock STOCK$/m);
    assert.match(container, /check_stock STOCK_AFTER/);
    // The real writer is the verify-on-stop evidence writer.
    assert.match(read(WRITERS), /from agent\.verification_evidence import record_verify_run/);
    assert.match(read(WRITERS), /record_verify_run\(root=workspace, session_id=marker, ok=True\)/);
  });

  it("measures journal format only from raw header bytes", () => {
    // The header reader is the ONLY mode oracle: no journal_mode pragma, and the
    // read-only checker is never used to inspect a mode.
    for (const text of [
      probe,
      container,
      gateProve,
      read(READONLY),
      read(WRITERS),
    ]) {
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
    assert.match(evidence, /SCRATCH_ROOT=\S*g1b-verification-delete\./);
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
    assert.equal(evField(evidence, "SEED_VERIFY_ON_STOP"), "1");
    assert.equal(evField(evidence, "SEED_RECORD_TABLE"), EVIDENCE_TABLE);
    assert.equal(evField(evidence, "SEED_RECORD_COLUMN"), "session_id");
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

  it("records TWO delete-mode writer runs at header 1,1 with clean sidecars", () => {
    assert.equal(evField(evidence, "DELETE_RESOLVED_MODE"), "delete");
    assert.equal(evField(evidence, "DELETE_BEFORE_BYTE18"), "1");
    assert.equal(evField(evidence, "DELETE_BEFORE_BYTE19"), "1");

    const marker1 = evField(evidence, "MARKER_1");
    const marker2 = evField(evidence, "MARKER_2");
    assert.match(marker1, /^g1b-verification-[A-Za-z0-9-]+-1$/);
    assert.match(marker2, /^g1b-verification-[A-Za-z0-9-]+-2$/);
    assert.notEqual(marker1, marker2);

    for (const run of ["RUN1", "RUN2"]) {
      assert.equal(evField(evidence, `${run}_EXIT`), "0", `${run} writer did not exit 0`);
      assert.equal(evField(evidence, `${run}_VERIFY_ON_STOP`), "1");
      assert.equal(evField(evidence, `${run}_RECORD_TABLE`), EVIDENCE_TABLE);
      assert.equal(evField(evidence, `${run}_RECORD_COLUMN`), "session_id");
      assert.notEqual(evField(evidence, `${run}_RECORD_ID`), "");
      // Raw header bytes after EACH close.
      assert.equal(evField(evidence, `${run}_BYTE18`), "1", `${run} header byte18`);
      assert.equal(evField(evidence, `${run}_BYTE19`), "1", `${run} header byte19`);
      assert.equal(evField(evidence, `${run}_MODE`), "delete", `${run} raw header mode`);
      // The read-only persistence check must not disturb the measured bytes.
      assert.equal(evField(evidence, `${run}_AFTER_READONLY_BYTE18`), "1");
      assert.equal(evField(evidence, `${run}_AFTER_READONLY_BYTE19`), "1");
      assert.match(evField(evidence, `${run}_SIZE`), /^[1-9][0-9]*$/);
      assert.match(evField(evidence, `${run}_SHA256`), /^[0-9a-f]{64}$/);
      // All three sidecar states after the close: nothing may remain.
      for (const sidecar of ["WAL", "SHM", "JOURNAL"]) {
        assert.equal(
          evField(evidence, `${run}_SIDECAR_${sidecar}_STATE`),
          "absent",
          `${run} -${sidecar.toLowerCase()} sidecar not absent`,
        );
      }
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

  it("proves persistence with an identifiable verification_events record after each close", () => {
    // run 1: marker absent before, present after -> absent->present.
    assert.equal(evField(evidence, "RO_RUN1_BEFORE_MARK1_EVENTS_COUNT"), "0");
    assert.equal(evField(evidence, "RO_RUN1_AFTER_MARK1_EVENTS_COUNT"), "1");
    // run 2: marker absent before, present after; run 1's row still there.
    assert.equal(evField(evidence, "RO_RUN2_BEFORE_MARK1_EVENTS_COUNT"), "1");
    assert.equal(evField(evidence, "RO_RUN2_BEFORE_MARK2_EVENTS_COUNT"), "0");
    assert.equal(evField(evidence, "RO_RUN2_AFTER_MARK1_EVENTS_COUNT"), "1");
    assert.equal(evField(evidence, "RO_RUN2_AFTER_MARK2_EVENTS_COUNT"), "1");
    // The verification_state projection makes the marker total 2 per event.
    assert.equal(evField(evidence, "RO_RUN1_AFTER_MARK1_TOTAL"), "2");
    assert.equal(evField(evidence, "RO_RUN2_AFTER_MARK2_TOTAL"), "2");
    // The conversion preserved the seeded row.
    assert.equal(evField(evidence, "RO_DELETE_PRE_SEED_EVENTS_COUNT"), "1");
    // A marker that was never written stays absent.
    assert.equal(evField(evidence, "RO_NEVER_WRITTEN_TOTAL"), "0");

    // The read-only connection is genuinely read-only and prints the exact SQL.
    for (const label of ["RUN1_AFTER_MARK1", "RUN2_AFTER_MARK2"]) {
      const start = evidence.indexOf(`RO_${label}_CMD=`);
      assert.notEqual(start, -1, `evidence is missing the RO_${label} block`);
      const block = evidence.slice(start, start + 20_000);
      assert.match(block, /\?mode=ro/, `${label} did not use a mode=ro URI`);
      assert.match(
        block,
        /READONLY_SQL table=verification_events: SELECT COUNT\(\*\) FROM "verification_events" WHERE/,
        `${label} did not record the exact read-only SQL`,
      );
    }
    assert.equal(evField(evidence, "RO_RUN1_AFTER_MARK1_EXIT"), "0");
    assert.equal(evField(evidence, "RO_RUN2_AFTER_MARK2_EXIT"), "0");
    assert.match(
      evidence,
      /PERSISTENCE_ASSERTION: run 1 marker absent->present, run 2 marker absent->present/,
    );
  });

  it("records the WAL control returning the same converted copy to 2,2", () => {
    assert.equal(evField(evidence, "CONTROL_RESOLVED_MODE"), "wal");
    assert.equal(evField(evidence, "CONTROL_BEFORE_BYTE18"), "1");
    assert.equal(evField(evidence, "CONTROL_BEFORE_BYTE19"), "1");
    assert.equal(evField(evidence, "RO_CONTROL_BEFORE_MARK_EVENTS_COUNT"), "0");
    assert.equal(evField(evidence, "CONTROL_EXIT"), "0");
    assert.equal(evField(evidence, "CONTROL_BYTE18"), "2");
    assert.equal(evField(evidence, "CONTROL_BYTE19"), "2");
    assert.equal(evField(evidence, "CONTROL_MODE"), "wal");
    assert.equal(evField(evidence, "RO_CONTROL_AFTER_MARK_EVENTS_COUNT"), "1");
    assert.match(
      evidence,
      /WAL_CONTROL: converted copy under database\.journal_mode: wal -> header 2,2/,
    );
  });

  it("records the HONOURING verdict and never a weakened result", () => {
    assert.match(evidence, /VERDICT: verification_evidence\.db HONOURING/);
    assert.match(
      evidence,
      /VERDICT_LINE: Verdict: `verification_evidence\.db` HONOURING/,
    );
    assert.match(evidence, /ASSERT SUMMARY: pass=\d+ fail=0/);
    assert.doesNotMatch(evidence, /ASSERT FAIL:/);
    assert.doesNotMatch(evidence, /BLOCKER: /);
    assert.match(
      evidence,
      /STORE_IDENTITY=OPTIONAL verify-on-stop evidence ledger/,
    );
    assert.match(evidence, /OPT_IN_GATE=agent\.verify_on_stop: true/);
  });

  it("documents the experiment with the gate, commands, table and persistence", () => {
    assert.ok(
      section.length > 3_000,
      "verification_evidence.db doc section is too small to be real evidence",
    );
    // Gate proof.
    assert.match(section, /Opt-in gate proven BEFORE the experiment/);
    assert.match(section, /agent\.verify_on_stop: true/);
    assert.match(section, /HERMES_VERIFY_ON_STOP=1/);
    assert.match(section, /`None`/);
    assert.match(section, /ABSENT/);
    assert.match(section, /verification_events/);
    // Exact commands.
    assert.match(section, /sessions set-journal-mode delete/);
    assert.match(section, /g1b_writers\.py verification/);
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
    assert.match(section, /SELECT COUNT\(\*\) FROM "verification_events" WHERE/);
    assert.match(section, /`verification_events` count 0/);
    assert.match(section, /`verification_events` count 1/);
    assert.match(section, /never written/);
    // Control and verdict.
    assert.match(section, /### WAL control/);
    assert.match(section, /Verdict: `verification_evidence\.db` HONOURING/);
    assert.match(section, /apply_wal_with_fallback\(\)/);
    assert.match(section, /evidence ledger/);
    // Evidence pointer + kept scratch root.
    assert.match(section, /docs\/gate\/evidence\/g1b\/verification-delete\.txt/);
    assert.match(section, /128 assertions, 0\nfailures|128 assertions, 0 failures/);
  });

  it("states what would fail on a WAL reversion for every assertion group", () => {
    assert.match(
      section,
      /What these assertions would catch if the store had reverted to WAL/,
    );
    for (const group of [
      "Opt-in gate",
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
    assert.match(
      doc,
      /\| `verification_evidence\.db` \| \*\*HONOURING\*\* \(US-004\) \|/,
    );
    // The pending-store list no longer includes verification_evidence.db (the
    // exact list of remaining stores belongs to the consolidated US-007 doc).
    assert.doesNotMatch(doc, /`verification_evidence\.db` \| not yet probed/);
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
      ["probe_verification_delete.sh", probe],
      ["g1b_verification_delete_container.sh", container],
      ["g1b_verify_gate.py", gateProve],
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
    const gateway = read(COMMON).slice(read(COMMON).indexOf("g1b_container_run()"));
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
