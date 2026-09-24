// aged-core.test.mjs — focused self-test gate for the tt-storm-aged core
// modules (zero-token aged-state generator).  One self-test file at a time,
// per the storm-aged task discipline.
//
// Covers:
//   A. seedcommon hashing/containment/ownership helpers
//   B. manifest allocation + root identity (refuses tampered ownership)
//   C. non-dispatching transport double: health/register/terminate/nudge
//      receipts; pause/resume/suite FAIL CLOSED (501); zero scheduling
//   D. preflight gate is recording-only (zero effects on invalid inputs)
//   E. immutable DB snapshot (VACUUM INTO) opens read-only, correct schema
//   F. volume-only event helper sequence bookkeeping
//   G. census DB counting over a real seeded product DB (real runWorkflow)
//
// The DB-touching tests use a private temp HOME/state (never live state).

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const ROOT = process.env.TT_STORM_AGED_REPO_ROOT
  ?? path.resolve(new URL("..", import.meta.url).pathname, "..", "..");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "aged-selftest-"));
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function httpReq(method, port, pathname, body, secret) {
  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : "";
    const req = http.request(
      {
        method,
        hostname: "127.0.0.1",
        port,
        path: pathname,
        headers: {
          "content-type": "application/json",
          ...(secret ? { "x-tamandua-secret": secret } : {}),
          ...(payload ? { "content-length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch { /* noop */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", () => resolve({ status: 0, body: {} }));
    if (payload) req.write(payload);
    req.end();
  });
}

test("A. seedcommon: hashing, jsonl, exclusive create, containment", async () => {
  const m = await import("../seedcommon.mjs");
  const dir = tmpHome();
  assert.equal(m.sha256Hex("abc"), sha256Hex("abc"));
  const file = path.join(dir, "x.jsonl");
  m.appendJsonl(file, { a: 1 });
  m.appendJsonl(file, { b: 2 });
  const rows = m.readJsonl(file);
  assert.equal(rows.length, 2);
  const w = m.writeExclusive(path.join(dir, "ex.json"), "x");
  assert.equal(w.created, true);
  const w2 = m.writeExclusive(path.join(dir, "ex.json"), "y");
  assert.equal(w2.created, false);
  assert.throws(() => m.requireContained(dir, "/etc/passwd", "escape"));
  assert.throws(() => m.requireContained(dir, path.join(dir, "..", "elsewhere"), "escape"));
});

test("B. manifest: allocation pins ownership; tampered root refuses", async () => {
  const man = await import("../manifest.mjs");
  const base = tmpHome();
  const root = man.allocateSeedRoot({ baseDir: base, kind: "pilot", runId: null });
  const manifest = man.loadManifest(root);
  assert.equal(manifest.seed_kind, "pilot");
  assert.ok(manifest.ownership.ino > 0);
  // Identity check passes on the same root.
  man.assertRootIdentity(root, manifest);
  // Tampering with the manifest's pinned identity must refuse.
  const tampered = JSON.parse(JSON.stringify(manifest));
  tampered.ownership.ino = manifest.ownership.ino + 1;
  assert.throws(() => {
    const { assertRootIdentity } = man;
    assertRootIdentity(root, { ...manifest, ownership: tampered.ownership });
  }, /mismatch/);
});

test("C. transport double: receipts for health/register/terminate/nudge; pause fails closed; no scheduling side effects", async () => {
  const { NonDispatchingTransportServer } = await import("../transport.mjs");
  const dir = tmpHome();
  const receipts = path.join(dir, "receipts");
  const port = await reservePort();
  const secret = "test-secret";
  const server = new NonDispatchingTransportServer({ port, secret, receiptDir: receipts });
  await server.start();
  try {
    const health = await httpReq("GET", port, "/control/health", null, secret);
    assert.equal(health.status, 200);
    const reg = await httpReq("POST", port, "/control/register-run", { runId: "run-11111111-1111-4111-8111-111111111111" }, secret);
    assert.equal(reg.status, 202);
    assert.equal(reg.body.state, "active");
    const term = await httpReq("POST", port, "/control/terminate-run", { runId: "run-11111111-1111-4111-8111-111111111111" }, secret);
    assert.equal(term.status, 200);
    const nudge = await httpReq("POST", port, "/control/nudge", {}, secret);
    assert.equal(nudge.status, 200);
    const pause = await httpReq("POST", port, "/control/pause-run", { runId: "x" }, secret);
    assert.equal(pause.status, 501); // never faked through the double
    assert.ok(server.counts.register >= 1);
    // The double must not have written any DB/state files (no side effects).
    const events = fs.existsSync(path.join(dir, "events")) ? fs.readdirSync(path.join(dir, "events")) : [];
    assert.deepEqual(events, []);
  } finally {
    await server.close();
  }
});

test("D. preflight gate is recording-only: invalid/foreign inputs cause zero effects", async () => {
  const { preflightGate, dirTreeFingerprint } = await import("../preflight.mjs");
  const base = tmpHome();
  // Malformed: nonexistent root.
  const v1 = preflightGate({ candidateRoot: path.join(base, "nope"), manifest: null });
  assert.equal(v1.result, "INVALID");
  assert.deepEqual(v1.effects, []);
  // Foreign root with a manifest whose ownership doesn't match → REFUSE.
  const man = await import("../manifest.mjs");
  const root = man.allocateSeedRoot({ baseDir: base, kind: "pilot", runId: null });
  const manifest = man.loadManifest(root);
  const fake = JSON.parse(JSON.stringify(manifest));
  fake.ownership.ino = -1;
  const before = dirTreeFingerprint(root);
  const v2 = preflightGate({ candidateRoot: root, manifest: fake });
  assert.equal(v2.result, "REFUSE");
  const after = dirTreeFingerprint(root);
  assert.deepEqual(before, after, "gate mutated candidate root");
});

test("E. immutable DB snapshot: read-only, schema version preserved, writes refused", async () => {
  const { createImmutableDbSnapshot, snapshotMeta } = await import("../snapshot.mjs");
  const dir = tmpHome();
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(path.join(stateDir, "tamandua.db"));
  db.exec("CREATE TABLE t (x TEXT)");
  db.prepare("INSERT INTO t VALUES (?)").run("hello");
  db.close();
  const dest = path.join(dir, "evidence");
  const snap = createImmutableDbSnapshot({ stateDir, destDir: dest, tag: "selftest" });
  const meta = snapshotMeta(snap.file);
  assert.equal(meta.userVersion, 0);
  const ro = new DatabaseSync(snap.file, { readOnly: true });
  const row = ro.prepare("SELECT x FROM t").get();
  assert.equal(row.x, "hello");
  ro.close();
  // O12's loader refuses a writable snapshot; the evidence snapshot must be
  // chmod'ed read-only by the generator.  (Opening "r+" is only enforced for
  // non-root; root bypasses file-mode checks, so the mode-bit assertion is
  // the portable check.)
  const st = fs.statSync(snap.file);
  assert.equal(st.mode & 0o222, 0, "snapshot must not be writable");
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    assert.throws(() => fs.openSync(snap.file, "r+"), /EACCES|EPERM/);
  }
});

test("F. volume-only event helper: sequence continuity", async () => {
  const vol = await import("../volume.mjs");
  const emitted = [];
  const fakeEvents = {
    emitEvent: (evt) => {
      assert.equal(evt.event, "aged.volume.seed");
      emitted.push(evt.seed_sequence);
    },
  };
  const a = vol.emitVolumeEvents({ events: fakeEvents, runId: "run-x", workflowId: "do-now", count: 5, sequenceStart: 1 });
  const b = vol.emitVolumeEvents({ events: fakeEvents, runId: "run-x", workflowId: "do-now", count: 3, sequenceStart: 6 });
  assert.equal(a.lastSeq, 5);
  assert.equal(b.lastSeq, 8);
  assert.deepEqual(emitted, [1, 2, 3, 4, 5, 6, 7, 8]);
});

test("G. census counts real product rows (no model, private state)", async (t) => {
  // Only run when a product dist is present.  Runs in a subprocess with a
  // private HOME/state so no live state is ever touched.
  const prod = await import("../product.mjs");
  let dist;
  try {
    dist = prod.resolveProductDist().dist;
  } catch {
    t.skip("no product dist available");
    return;
  }
  const home = tmpHome();
  const stateDir = path.join(home, "state");
  const workRoot = path.join(home, "worktrees");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });
  const script = `
    import { runDbCensus } from ${JSON.stringify(pathToFileURL(path.join(AGED, "census.mjs")).href)};
    const dbMod = await import(${JSON.stringify(pathToFileURL(path.join(dist, "db.js")).href)});
    const db = dbMod.getDb();
    const c = runDbCensus(db);
    process.stdout.write(JSON.stringify(c));
  `;
  const res = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    env: { ...process.env, HOME: home, TAMANDUA_STATE_DIR: stateDir, TAMANDUA_DB_PATH: path.join(stateDir, "tamandua.db"), TAMANDUA_WORKTREE_ROOT: workRoot, TAMANDUA_TEST_GUARD: "1" },
    encoding: "utf8",
  });
  assert.equal(res.status, 0, res.stderr);
  const census = JSON.parse(res.stdout.trim());
  assert.equal(typeof census.runs, "number");
  assert.equal(census.runs, 0);
  assert.equal(census.terminal, 0);
  assert.equal(census.tokensSpentTotal, 0);
});

test("G2. census-snapshot receipt tag is timestamped so a re-run persists a fresh receipt (never frozen by first-write-wins)", async () => {
  const { writeCensusReceipt, postCensusReceiptTag } = await import("../census.mjs");
  const dir = tmpHome();
  // Pre-fix behavior: a FIXED tag freezes the receipt — the second write is
  // refused and the receipt is permanently stale (this is exactly what left
  // the post-volume census, which must record >=500000 events, unrecorded).
  const frozen = writeCensusReceipt(dir, "full-post", { events: 30825 });
  assert.equal(frozen.created, true);
  const refrozen = writeCensusReceipt(dir, "full-post", { events: 505000 });
  assert.equal(refrozen.created, false, "a fixed tag must refuse a rewrite (demonstrating the freeze the fix removes)");
  // Post-fix behavior: the census-snapshot phase stamps its tag, so each run
  // writes a distinct immutable receipt carrying the current counts.
  const t1 = postCensusReceiptTag("full", "2026-09-15T07-00-00-000Z");
  const t2 = postCensusReceiptTag("full", "2026-09-15T07-05-00-000Z");
  assert.notEqual(t1, t2);
  assert.ok(t1.startsWith("full-post-"), `tag should prefix the seed kind: ${t1}`);
  const r1 = writeCensusReceipt(dir, t1, { events: 505000 });
  assert.equal(r1.created, true);
  const r2 = writeCensusReceipt(dir, t2, { events: 505001 });
  assert.equal(r2.created, true);
  assert.notEqual(r1.file, r2.file);
  assert.equal(JSON.parse(fs.readFileSync(r2.file, "utf-8")).events, 505001, "latest receipt carries the latest counts");
  // The old frozen receipt is untouched (historical evidence retained).
  assert.equal(JSON.parse(fs.readFileSync(frozen.file, "utf-8")).events, 30825);
});

function pathToFileURL(p) {
  return new URL(`file://${p}`);
}

// ── H..N: refinement-regression tests (reviewer issues 1-6) ─────────────

test("H. validate: O12 pin is the accepted schema-9..14 CONTENT pin; prior/superseded pins labeled; prior runs listed", async () => {
  const { O12_PINNED_CONTENT_SHA256, O12_PINNED_PROVENANCE_COMMIT, O12_PINNED_PROVENANCE_SUBJECT, O12_PINNED_ACCEPTANCE, O12_PINNED_ACCEPTANCE_DETAIL, O12_PIN_IDENTITY, O12_PRIOR_PIN, O12_PRIOR_ACCEPTANCE, O12_SUPERSEDED_PIN, O12_NOT_ACCEPTED_PIN, listPriorO12Runs } = await import("../validate.mjs");
  // NPF-2 Part 2 / Storm O12-REPIN, re-pinned by O12-SCHEMA-13 US-005: the
  // durable pin is the CONTENT hash of the documented O12 oracle set (survives
  // merge-worktree squashes); the provenance commit is the run's base HEAD
  // (7fe9f258), a real ancestor — never a pre-squash story commit.  The
  // acceptance status is carried explicitly and is the ACCEPTED value — no
  // longer NOT_ROOT_ACCEPTED / schema-9-only.  The prior RUN45 close head
  // eb953ca is retained (O12_PRIOR_PIN, schema-9-only, NOT_ROOT_ACCEPTED) for
  // provenance.
  assert.match(O12_PINNED_CONTENT_SHA256, /^[0-9a-f]{64}$/, "content pin must be a 64-hex sha256");
  assert.equal(O12_PIN_IDENTITY, O12_PINNED_CONTENT_SHA256.slice(0, 12), "pin identity is the content-hash prefix");
  assert.equal(O12_PINNED_PROVENANCE_COMMIT, "7fe9f258b066069d3a9c171df311487da6d54594");
  assert.equal(O12_PINNED_PROVENANCE_SUBJECT, "chore(torture): close TU2F torture-union leftovers (NF-6 + NF sweep)");
  assert.equal(O12_PINNED_ACCEPTANCE, "ROOT_ACCEPTED");
  assert.notEqual(O12_PINNED_ACCEPTANCE, "NOT_ROOT_ACCEPTED");
  assert.match(O12_PINNED_ACCEPTANCE_DETAIL, /o12-owned-store-acceptance-/);
  assert.equal(O12_PRIOR_PIN, "eb953ca52e531a2c5725ac2a30e663e9bea5d49e");
  assert.equal(O12_PRIOR_ACCEPTANCE, "NOT_ROOT_ACCEPTED");
  assert.equal(O12_SUPERSEDED_PIN, "e8f912398b461bb2cb40dc7a2b47465264b34a43");
  assert.equal(O12_NOT_ACCEPTED_PIN, "62699fa25aeca9c5ad31d3d6475531caadc6c6f8");
  // listPriorO12Runs over a fake tree: old pin evidence + import dirs are
  // listed provisional; the current CONTENT-pin import dir is not.
  const dir = tmpHome();
  const evBase = path.join(dir, "evidence", "o12", "o12");
  fs.mkdirSync(path.join(evBase, "2026-09-09T19-05-21-009Z"), { recursive: true });
  fs.writeFileSync(path.join(evBase, "2026-09-09T19-05-21-009Z", "o12-run-evidence.json"), "{}\n");
  fs.mkdirSync(path.join(dir, "evidence", "imports", "o12-e8f912398b46"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evidence", "imports", "o12-62699fa25aec"), { recursive: true });
  fs.mkdirSync(path.join(dir, "evidence", "imports", "o12-eb953ca52e53"), { recursive: true });
  const prior = listPriorO12Runs({ seedRoot: dir, evidenceDir: path.join(dir, "evidence"), currentPin: O12_PINNED_CONTENT_SHA256 });
  const runStamps = prior.filter((p) => p.stamp);
  const imports = prior.filter((p) => p.importsDir);
  assert.equal(runStamps.length, 1);
  assert.equal(runStamps[0].provisional, true);
  assert.equal(imports.length, 3);
  const byPin = Object.fromEntries(imports.map((i) => [i.pin, i]));
  assert.equal(byPin["e8f912398b46"].pinIsSuperseded, true);
  assert.equal(byPin["e8f912398b46"].pinIsCurrent, false);
  assert.equal(byPin["62699fa25aec"].pinIsCurrent, false);
  assert.equal(byPin["62699fa25aec"].provisional, true);
  // The prior RUN45 close head is now labeled as the prior (schema-9-only,
  // NOT_ROOT_ACCEPTED) pin and its evidence stays provisional.
  assert.equal(byPin["eb953ca52e53"].pinIsPriorNotRootAccepted, true);
  assert.equal(byPin["eb953ca52e53"].pinIsCurrent, false);
  assert.equal(byPin["eb953ca52e53"].provisional, true);
  // The current content-pin import dir is current, not provisional.
  fs.mkdirSync(path.join(dir, "evidence", "imports", `o12-${O12_PIN_IDENTITY}`), { recursive: true });
  const prior2 = listPriorO12Runs({ seedRoot: dir, evidenceDir: path.join(dir, "evidence"), currentPin: O12_PINNED_CONTENT_SHA256 });
  const current = prior2.find((p) => p.pin === O12_PIN_IDENTITY);
  assert.equal(current.pinIsCurrent, true);
  assert.equal(current.provisional, false);
});

test("H2. validate: O12 pin is the schema-9..14 CONTENT hash, the provenance commit is a real recorded commit, and the imported content matches", async () => {
  const { O12_PINNED_CONTENT_SHA256, O12_PINNED_PROVENANCE_COMMIT, O12_PINNED_PROVENANCE_SUBJECT, O12_PINNED_PROVENANCE_LEGACY, O12_PINNED_PROVENANCE_LEGACY_REASON, computeO12OracleContentHash, materializePinnedOracle } = await import("../validate.mjs");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" });
  assert.equal(top.status, 0, "git rev-parse --show-toplevel must succeed");
  const gitRoot = top.stdout.trim();
  // 1. the working tree hashes to the embedded CONTENT pin
  assert.equal(
    computeO12OracleContentHash({ repoRoot: gitRoot }),
    O12_PINNED_CONTENT_SHA256,
    "computeO12OracleContentHash(repoRoot) must equal the pin",
  );
  // 2. the provenance commit is a REAL commit carrying the recorded subject
  //    (never a pre-squash story commit).  On the TORTURE-PORT product the
  //    historical torture-union provenance commit is NOT an ancestor of HEAD
  //    (the port squashes onto integration/torture-final), so an unreachable
  //    provenance is accepted ONLY when the module explicitly declares it
  //    legacy; the durable pin stays the CONTENT hash above.
  const anc = spawnSync("git", ["merge-base", "--is-ancestor", O12_PINNED_PROVENANCE_COMMIT, "HEAD"], { cwd: gitRoot, encoding: "utf8" });
  if (anc.status !== 0) {
    assert.equal(
      O12_PINNED_PROVENANCE_LEGACY,
      true,
      "a provenance commit that is not reachable from HEAD must be declared legacy",
    );
    assert.ok(
      typeof O12_PINNED_PROVENANCE_LEGACY_REASON === "string" && O12_PINNED_PROVENANCE_LEGACY_REASON.length > 0,
      "an unreachable provenance commit must record why it is legacy",
    );
  }
  const subj = spawnSync("git", ["log", "-1", "--format=%s", O12_PINNED_PROVENANCE_COMMIT], { cwd: gitRoot, encoding: "utf8" });
  assert.equal(subj.status, 0, "provenance commit must resolve to a real commit");
  assert.equal(
    O12_PINNED_PROVENANCE_SUBJECT,
    subj.stdout.trim(),
    "the recorded provenance subject must be the provenance commit's real subject",
  );
  assert.doesNotMatch(
    O12_PINNED_PROVENANCE_SUBJECT,
    /^feat: US-\d{3}/,
    "provenance must not be a pre-squash story commit",
  );
  // 3. the imported (HEAD-materialized) content hash matches the pin
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "aged-o12-import-"));
  try {
    const res = materializePinnedOracle({ gitRepo: gitRoot, destDir: dest, contentSha256: O12_PINNED_CONTENT_SHA256 });
    assert.equal(res.content_sha256, O12_PINNED_CONTENT_SHA256, "imported content hash must match the pin");
    assert.equal(computeO12OracleContentHash({ repoRoot: dest }), O12_PINNED_CONTENT_SHA256);
    // 4. the pinned content carries the whole 9..14 chain (fail-closed on
    //    unknown versions; v11/v12 columns; v13 policy column; v14 ledger diag)
    const source = fs.readFileSync(path.join(dest, "torture-test", "oracles", "lib", "o12.mjs"), "utf8");
    assert.match(source, /O12_SUPPORTED_SCHEMA_VERSIONS = Object\.freeze\(\[9, 10, 11, 12, 13, 14\]\)/);
    assert.match(source, /matchlock_policy/);
    assert.match(source, /preclaim_death_count/);
    assert.match(source, /target_moved_reroute_count/);
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
});

test("H3. aged pin consumers compare the CONTENT pin and share one import-dir identity", async () => {
  const { O12_PIN_IDENTITY } = await import("../validate.mjs");
  const here = path.dirname(new URL(import.meta.url).pathname);
  const agedDir = path.resolve(here, "..");
  const phases = fs.readFileSync(path.join(agedDir, "phases.mjs"), "utf8");
  const seedCopy = fs.readFileSync(path.join(agedDir, "seed-root-copy.mjs"), "utf8");
  const qualification = fs.readFileSync(path.join(agedDir, "qualification.mjs"), "utf8");
  assert.match(O12_PIN_IDENTITY, /^[0-9a-f]{12}$/);
  // phases.mjs: one content-pin import-dir identity; content pin passed to the
  // materializer; content pin + provenance recorded in the row and manifest.
  assert.match(phases, /imports", `o12-\$\{O12_PIN_IDENTITY\}`/);
  assert.match(
    phases,
    /materializePinnedOracle\(\{ gitRepo: REPO_ROOT, destDir: importDest, contentSha256: O12_PINNED_CONTENT_SHA256 \}\)/,
  );
  assert.match(phases, /listPriorO12Runs\(\{ seedRoot: root, evidenceDir, currentPin: O12_PINNED_CONTENT_SHA256 \}\)/);
  assert.match(phases, /pinnedContentSha256: O12_PINNED_CONTENT_SHA256/);
  assert.match(phases, /pinnedProvenanceCommit: O12_PINNED_PROVENANCE_COMMIT/);
  assert.match(phases, /o12PinnedContentSha256: O12_PINNED_CONTENT_SHA256/);
  assert.doesNotMatch(phases, /commit: O12_PINNED_COMMIT/);
  // seed-root-copy.mjs: compares content_sha256 + provenance_commit; expected_pin
  // is content-addressed; the legacy commit is never compared.
  assert.match(seedCopy, /pin\.content_sha256 !== O12_PINNED_CONTENT_SHA256/);
  assert.match(seedCopy, /pin\.provenance_commit !== O12_PINNED_PROVENANCE_COMMIT/);
  assert.match(seedCopy, /o12Row\.pinnedContentSha256 !== O12_PINNED_CONTENT_SHA256/);
  assert.match(seedCopy, /content_sha256: O12_PINNED_CONTENT_SHA256, provenance_commit: O12_PINNED_PROVENANCE_COMMIT/);
  assert.doesNotMatch(seedCopy, /pin\.commit !== O12_PINNED_COMMIT/);
  // qualification.mjs consumes report.o12_pin as-is (content fields included)
  // and its blocker text names the content pin, never the pre-squash commit.
  assert.match(qualification, /report\.o12_pin \?\? null/);
  assert.match(qualification, /O12_PINNED_CONTENT_SHA256/);
  assert.doesNotMatch(qualification, /064e9cb5660c/);
});

test("I. snapshot: reserved-key baseline sidecar written in complete typed v2 schema, read-only (no write bits)", async () => {
  const { writeReservedBaselineSidecar, reservedKeysPinned } = await import("../snapshot.mjs");
  const { RESERVED_CONTEXT_KEYS } = await import("../seedcommon.mjs");
  const dir = tmpHome();
  const dest = path.join(dir, "evidence");
  const expected = {
    "run-x": {
      task: { presence: "present", value: "seed task", provenance: "host" },
    },
  };
  // Sidecar must be complete-typed for the full pin (absent keys are pinned
  // too); the writer itself stores whatever `expected` carries and the caller
  // (phaseCensusSnapshot) guarantees completeness.
  const sidecar = writeReservedBaselineSidecar({ destDir: dest, expected, expectedMutations: { "run-x": { repo: { presence: "absent", source: "host" } } } });
  assert.equal(sidecar.created, undefined); // v2 writer returns file/mode/scopeMode
  const st = fs.statSync(sidecar.file);
  assert.equal(st.mode & 0o222, 0, "baseline sidecar must not be writable (O12 R4 fails closed on writable baselines)");
  const parsed = JSON.parse(fs.readFileSync(sidecar.file, "utf-8"));
  assert.equal(parsed.producer, "host");
  assert.equal(parsed.schema_version, 2);
  assert.equal(parsed.scope.mode, "all-snapshot-runs");
  assert.equal(parsed.supported_reserved_keys.length, RESERVED_CONTEXT_KEYS.length);
  assert.deepEqual(parsed.expected["run-x"].task, { presence: "present", value: "seed task", provenance: "host" });
  assert.deepEqual(parsed.expected_mutations["run-x"].repo, { presence: "absent", source: "host" });
  // sha256 recorded matches the on-disk content (chmod is not a content change).
  const cryptoMod = await import("node:crypto");
  const h = cryptoMod.createHash("sha256").update(fs.readFileSync(sidecar.file)).digest("hex");
  assert.equal(sidecar.sha256, h);
  assert.ok(Array.isArray(reservedKeysPinned()) && reservedKeysPinned().length === RESERVED_CONTEXT_KEYS.length);
});

test("I4. snapshot: re-running the reserved-key sidecar writer replaces a read-only prior sidecar (non-root safe)", async () => {
  const { writeReservedBaselineSidecar } = await import("../snapshot.mjs");
  const dir = tmpHome();
  const dest = path.join(dir, "evidence");
  const expected = {
    "run-x": {
      task: { presence: "present", value: "seed task", provenance: "host" },
    },
  };
  // First write: read-only (0o400), no write bits.
  const first = writeReservedBaselineSidecar({ destDir: dest, expected });
  assert.equal(fs.statSync(first.file).mode & 0o222, 0, "first sidecar must be read-only");
  const firstContent = fs.readFileSync(first.file, "utf-8");
  // Second write over the SAME read-only file must succeed under a non-root
  // operator (the prior content is archived, never silently overwritten).
  const second = writeReservedBaselineSidecar({
    destDir: dest,
    expected,
    expectedMutations: { "run-x": { repo: { presence: "absent", source: "host" } } },
  });
  assert.equal(second.file, first.file);
  assert.equal(fs.statSync(second.file).mode & 0o222, 0, "replacement sidecar must stay read-only");
  const parsed = JSON.parse(fs.readFileSync(second.file, "utf-8"));
  assert.equal(parsed.producer, "host");
  assert.equal(parsed.schema_version, 2);
  assert.deepEqual(parsed.expected_mutations["run-x"].repo, { presence: "absent", source: "host" });
  const archives = fs.readdirSync(dest).filter((f) => f.startsWith("o12-reserved-baseline.pre-"));
  assert.equal(archives.length, 1, "prior sidecar must be archived before replacement");
  assert.equal(fs.readFileSync(path.join(dest, archives[0]), "utf-8"), firstContent, "archive preserves prior content byte-exact");
});

test("I2. seedlib: recordReservedBaseline captures complete typed presence/absence for EVERY reserved key", async () => {
  const { recordReservedBaseline } = await import("../seedlib.mjs");
  const { RESERVED_CONTEXT_KEYS } = await import("../seedcommon.mjs");
  const dir = tmpHome();
  const file = path.join(dir, "baseline.jsonl");
  const context = { repo: "/r", task: "", run_id: "run-1", workspace_mode: "worktree" };
  const rec = recordReservedBaseline({ baselineFile: file, runId: "run-1", context });
  assert.equal(rec.reserved_key_count, RESERVED_CONTEXT_KEYS.length);
  assert.equal(Object.keys(rec.reserved).length, RESERVED_CONTEXT_KEYS.length, "no reserved key may be omitted");
  assert.deepEqual(rec.reserved.repo, { presence: "present", value: "/r", provenance: "host" });
  assert.deepEqual(rec.reserved.task, { presence: "present", value: "", provenance: "host" }, 'empty string is a legitimate distinct present value');
  for (const key of ["working_directory_for_harness", "worktree_path", "original_branch", "merge_gate"]) {
    assert.deepEqual(rec.reserved[key], { presence: "absent", provenance: "host" }, `key ${key} must be pinned absent (not omitted)`);
  }
  const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
});

test("I3. snapshot: computeReservedMutations derives mutations ONLY from recorded native step operations (never circular final-context blessing)", async () => {
  const { computeReservedMutations, reservedKeysPinned } = await import("../snapshot.mjs");
  const dir = tmpHome();
  const dbFile = path.join(dir, "snap.sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec("CREATE TABLE runs (id TEXT PRIMARY KEY, context TEXT)");
  db.exec("CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT, step_index INTEGER, step_id TEXT, status TEXT, output TEXT)");
  // run-a: no recorded TEST_CMD operation → test_cmd_raw stays absent in the
  //        derivation even though the FINAL context introduces it: a final
  //        difference with no recorded operation is NOT blessed (unverified).
  // run-b: a recorded completed step whose output carries TEST_CMD: <value>
  //        establishes context.test_cmd_raw = value (native TEST_CMD
  //        machinery); derivation MUST bless exactly that transition and no
  //        other (repo/task drift stays unverified).
  const exp = (k, v) => ({ presence: "present", value: v, provenance: "host" });
  const absent = () => ({ presence: "absent", provenance: "host" });
  const expectedByRun = {
    // run-a baseline: full pin typed; only repo/task/run_id shown (absent keys
    // are implied absent by the caller's completeness contract in real use).
    "run-a": { repo: exp("a", "/a"), task: exp("a", "t"), run_id: exp("a", "run-a") },
    "run-b": { repo: exp("b", "/b"), task: exp("b", "old"), run_id: exp("b", "run-b") },
    "run-c": { repo: exp("c", "/c"), task: exp("c", "t"), run_id: exp("c", "run-c") },
  };
  // run-a final context UNEXPECTEDLY introduces test_cmd_raw with no recorded
  // operation; run-b final repo/task drift with no recorded operation; run-c
  // has a genuine recorded TEST_CMD establish matching the final context.
  db.prepare("INSERT INTO runs VALUES (?, ?)").run(
    "run-a",
    JSON.stringify({ repo: "/a", task: "t", run_id: "run-a", test_cmd_raw: "CORRUPTED-DRIFT" }),
  );
  db.prepare("INSERT INTO runs VALUES (?, ?)").run(
    "run-b",
    JSON.stringify({ repo: "/CORRUPTED", task: "new", run_id: "run-b" }),
  );
  db.prepare("INSERT INTO runs VALUES (?, ?)").run(
    "run-c",
    JSON.stringify({ repo: "/c", task: "t", run_id: "run-c", test_cmd_raw: "genuine-command" }),
  );
  db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?)").run(
    "s1", "run-c", 0, "setup", "done", "STATUS: done\nTEST_CMD: genuine-command\n",
  );
  db.close();
  const { mutations, coverage } = computeReservedMutations({ snapshotFile: dbFile, expectedByRun });
  // run-a: the unrecorded test_cmd_raw introduction must NOT be blessed.
  assert.equal(mutations["run-a"], undefined, "unexplained final drift must never be blessed as a host mutation");
  // run-b: repo/task drift without a recorded operation must NOT be blessed.
  assert.equal(mutations["run-b"], undefined, "repo/task drift must never be authorized by running the producer on the corrupted snapshot");
  // run-c: the recorded TEST_CMD establish IS the independently expected
  // transition and its value matches the final snapshot → blessed.
  assert.ok(mutations["run-c"], "recorded native operation transition must be ledged");
  assert.deepEqual(mutations["run-c"].test_cmd_raw, { presence: "present", value: "genuine-command", source: "host" });
  // Coverage notes: run-a and run-b carry unverified final differences; run-c
  // is verified.
  assert.ok(Object.keys(coverage["run-a"].unverified).includes("test_cmd_raw"));
  assert.ok(Object.keys(coverage["run-b"].unverified).includes("repo"));
  assert.ok(Object.keys(coverage["run-c"].verified).includes("test_cmd_raw"));
  assert.ok(reservedKeysPinned().includes("test_cmd_raw"));
});

test("J. fixture: sample.test.sh is created under tests/ (no segment-dropping path trick)", async () => {
  const fixture = await import("../fixture.mjs");
  const dir = tmpHome();
  const origin = fixture.buildTinyOrigin(dir);
  const rootSample = path.join(dir, "sample.test.sh");
  const testsSample = path.join(dir, "tests", "sample.test.sh");
  assert.equal(fs.existsSync(rootSample), false, "sample.test.sh must NOT be written to the repo root");
  assert.equal(fs.existsSync(testsSample), true, "sample.test.sh must be written under tests/");
  // The committed HEAD tree carries tests/sample.test.sh and no root one.
  const res = spawnSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: dir, encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const names = res.stdout.trim().split("\n").filter(Boolean);
  assert.ok(names.includes("tests/sample.test.sh"), `HEAD tree should include tests/sample.test.sh; got: ${names.join(",")}`);
  assert.ok(!names.includes("sample.test.sh"), "HEAD tree must not include a root-level sample.test.sh");
  assert.ok(origin.head.sha && origin.head.tree);
});

test("K. plan: full-scale entries deterministic, every catalog id represented, worktree count driven to target", async () => {
  const { fullEntries, WORKTREE_WORKFLOWS, NON_WORKTREE_TWIN } = await import("../plan.mjs");
  const workflowsDir = path.join(ROOT, "workflows");
  const catalogIds = fs.readdirSync(workflowsDir).filter((d) => fs.existsSync(path.join(workflowsDir, d, "workflow.yml"))).sort();
  assert.ok(catalogIds.length >= 23, `expected >=23 bundled workflows, got ${catalogIds.length}`);
  const manifest = { seed_kind: "full", recipe: { runs_total: 5000, worktrees_target: 200 }, catalog: { ids: catalogIds } };
  const plan = fullEntries({ manifest });
  assert.equal(plan.entries.length, 5000);
  // Every worktree-mode catalog id is represented by an un-substituted entry
  // early in the corpus AND the plan reaches the explicit worktree target.
  assert.equal(plan.stats.worktreesPlanned, 200);
  assert.equal(plan.stats.worktreesTargetReached, true);
  // Once the target is reached, later worktree-mode selections are
  // substituted by their non-worktree twins (bounded worktree growth).
  assert.ok(plan.stats.worktreeSubstitutions > 0);
  // All selected workflow ids come from the catalog or a documented twin.
  for (const e of plan.entries) {
    assert.ok(catalogIds.includes(e.workflowId) || NON_WORKTREE_TWIN[e.workflowId] !== undefined, `unexpected workflowId ${e.workflowId}`);
  }
  // Worktree flag only true for genuinely un-substituted worktree-mode runs.
  const wtEntries = plan.entries.filter((e) => e.worktree);
  assert.equal(wtEntries.length, plan.stats.worktreesPlanned);
  assert.ok(wtEntries.every((e) => WORKTREE_WORKFLOWS.has(e.workflowId)));
  // Every pinned catalog id appears at least once across the corpus.
  const seen = new Set(plan.entries.map((e) => e.workflowId));
  for (const id of catalogIds) {
    assert.ok(seen.has(id) || seen.has(NON_WORKTREE_TWIN[id]), `catalog id ${id} not represented (direct or twin)`);
  }
  // Disposition mix sanity: no runnable leftover dispositions for families
  // that cannot be linearly completed, and a completed shape exists.
  const dispositions = new Set(plan.entries.map((e) => e.disposition));
  for (const d of ["completed", "failed-force", "canceled", "paused", "failed-exhaust"]) {
    assert.ok(dispositions.has(d), `disposition ${d} missing`);
  }
  // Plan-intent realism (reviewer issue 2): quarantine-broken-tests cannot
  // genuinely complete in this seed configuration (its setup step template
  // requires a `branch` key that non-worktree synthetic runs never carry —
  // native template validation fails).  Completed intent must NEVER be planned
  // for it; those intents route through dispositionFallback.
  const qEntries = plan.entries.filter((e) => e.workflowId === "quarantine-broken-tests");
  assert.ok(qEntries.length > 0, "quarantine-broken-tests must stay represented in the corpus");
  assert.equal(
    qEntries.filter((e) => e.disposition === "completed").length,
    0,
    "quarantine-broken-tests must never receive completed intent (no branch context in non-worktree synthetic runs)",
  );
  // A small corpus honestly does NOT reach the worktree target (never a
  // fabricated count).
  const small = fullEntries({ manifest: { seed_kind: "full", recipe: { runs_total: 25, worktrees_target: 200 }, catalog: { ids: catalogIds } } });
  assert.equal(small.entries.length, 25);
  assert.ok(small.stats.worktreesPlanned < 200);
  assert.equal(small.stats.worktreesTargetReached, false);
});

test("L. manifest: allocation pins executed source identity (working-tree, not just HEAD)", async () => {
  const man = await import("../manifest.mjs");
  const base = tmpHome();
  const root = man.allocateSeedRoot({ baseDir: base, kind: "pilot", runId: null });
  const manifest = man.loadManifest(root);
  assert.equal(manifest.seed_kind, "pilot");
  // allocateSeedRoot does not pin source (no repo context) — the CLI pins it
  // pre-effect via pinExecutedSource; assert that helper returns a durable,
  // uniquely-identifying record.
  const pin = man.pinExecutedSource(ROOT);
  assert.ok(pin.head && pin.head.sha && pin.head.tree);
  assert.equal(typeof pin.porcelain_sha256, "string");
  assert.ok(pin.porcelain_sha256.length === 64);
  assert.equal(typeof pin.clean, "boolean");
  assert.ok(pin.executed_at_utc);
  // Same tree → same fingerprint (deterministic identity).
  const pin2 = man.pinExecutedSource(ROOT);
  assert.equal(pin.porcelain_sha256, pin2.porcelain_sha256);
  assert.equal(pin.head.sha, pin2.head.sha);
});

test("M. preflight-evidence battery: PASS + negative trials, zero effects, exit codes", async () => {
  const { runPreflightEvidenceBattery } = await import("../preflight.mjs");
  const man = await import("../manifest.mjs");
  const base = tmpHome();
  const root = man.allocateSeedRoot({ baseDir: base, kind: "pilot", runId: null });
  const battery = runPreflightEvidenceBattery({ seedRoot: root, productDist: null });
  assert.equal(battery.allExpected, true, JSON.stringify(battery.results, null, 2));
  const cases = new Map(battery.results.map((r) => [r.case, r]));
  assert.equal(cases.get("pass").result, "PASS");
  assert.equal(cases.get("pass").exitCode, 0);
  for (const name of ["invalid-missing-root", "refuse-malformed-manifest", "refuse-foreign-identity", "refuse-origin-ref-moved", "refuse-resume-identity"]) {
    assert.ok(cases.has(name), `missing negative case ${name}`);
    assert.notEqual(cases.get(name).result, "PASS");
    assert.equal(cases.get(name).exitCode, 3);
    assert.equal(cases.get(name).zeroEffects, true, `${name} must be zero-effects`);
  }
  // Receipts persisted under the seed root evidence dir.
  const receiptDir = path.join(root, "evidence", "preflight");
  assert.equal(fs.readdirSync(receiptDir).filter((f) => f.endsWith(".json")).length >= 7, true);
  assert.ok(fs.existsSync(path.join(receiptDir, "battery-summary.json")));
  // Every trial candidate dir remains pristine (gate wrote nothing inside).
  const foreignFile = fs.readdirSync(receiptDir).find((f) => f.includes("refuse-foreign-identity") && f.endsWith(".json"));
  const foreign = JSON.parse(fs.readFileSync(path.join(receiptDir, foreignFile), "utf-8"));
  assert.equal(foreign.candidate.includes("trials"), true);
});

test("N. snapshot/validate helpers: prior-report archiving is safe on nonexistent files", async () => {
  // writeValidationReport archives an existing report before overwriting.
  const { writeValidationReport } = await import("../validate.mjs");
  const root = tmpHome();
  fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(root, "evidence", "seed-validation-report.json"), "old\n", "utf-8");
  const file = writeValidationReport({ seedRoot: root, matrix: [], o12Evidence: { oracle: "O12", result: "FAIL" } });
  const archived = fs.readdirSync(path.join(root, "evidence")).filter((f) => f.startsWith("seed-validation-report.pre-"));
  assert.equal(archived.length, 1);
  assert.equal(fs.readFileSync(path.join(root, "evidence", archived[0]), "utf-8"), "old\n");
  assert.ok(fs.existsSync(file));
});

// Build a schema-valid scratch DB with the tables census + validate read
// (runs/steps/stories/run_worktrees/tamandua_stats/suite_results guarded).
function buildScratchDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, run_number INTEGER, workflow_id TEXT, task TEXT, status TEXT,
      context TEXT, tokens_spent INTEGER, scheduling_status TEXT, scheduling_requested_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE steps (id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, agent_id TEXT, step_index INTEGER,
      status TEXT, claim_pid INTEGER, claim_pgid INTEGER, claim_job_id TEXT, retry_count INTEGER, max_retries INTEGER);
    CREATE TABLE stories (id TEXT PRIMARY KEY);
    CREATE TABLE story_abandonments (id TEXT PRIMARY KEY);
    CREATE TABLE run_worktrees (run_id TEXT, worktree_path TEXT, status TEXT, cleanup_policy TEXT,
      worktree_origin_repository TEXT, worktree_origin_ref TEXT);
    CREATE TABLE tamandua_stats (system_tokens_spent INTEGER);
  `);
  db.prepare("INSERT INTO tamandua_stats (system_tokens_spent) VALUES (0)").run();
  return db;
}

test("O. validate matrix: O1/O4 suite semantics are oracle-faithful (waiting-on-failed is NOT corruption/claim; completed-run nonterminal and real claim evidence ARE violations); O3z is NOT_RUN", async () => {
  const { buildValidationMatrix } = await import("../validate.mjs");
  const dir = tmpHome();
  const db = buildScratchDb(path.join(dir, "scratch.sqlite"));
  // run-1 FAILED with downstream waiting steps (zero claim evidence) → native
  // leftover shape, NOT O1 corruption / O4 dangling claim.
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "r1", 1, "do-now", "t", "failed", "{}", 0, null, null, "t0", "t1",
  );
  db.prepare("INSERT INTO steps VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "s1", "r1", "setup", "a", 0, "waiting", null, null, null, 0, 4,
  );
  db.prepare("INSERT INTO steps VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "s2", "r1", "do", "b", 1, "waiting", null, null, null, 0, 4,
  );
  // run-2 COMPLETED but retains a 'running' step WITH claim evidence → real
  // O1 completed-run nonterminal violation AND real O4 dangling claim.
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "r2", 2, "do-now", "t", "completed", "{}", 0, null, null, "t0", "t1",
  );
  db.prepare("INSERT INTO steps VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "s3", "r2", "verify", "c", 0, "running", 12345, 12345, "job-9", 0, 4,
  );
  // run-3 COMPLETED clean (no leftover steps).
  db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "r3", 3, "do-now", "t", "completed", "{}", 0, null, null, "t0", "t1",
  );
  db.prepare("INSERT INTO steps VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    "s4", "r3", "setup", "a", 0, "done", null, null, null, 0, 4,
  );
  db.close();

  fs.mkdirSync(path.join(dir, "events"), { recursive: true });
  const matrix = buildValidationMatrix({
    db: new DatabaseSync(path.join(dir, "scratch.sqlite"), { readOnly: true }),
    stateDir: dir,
    worktreesRoot: path.join(dir, "worktrees"),
    zeroTokenEvidence: { transportReceipts: path.join(dir, "receipts") },
  });
  const byOracle = new Map(matrix.rows.map((r) => [r.oracle, r]));

  // O1: waiting on the FAILED run must NOT be a finding; the running step on
  // the COMPLETED run IS the finding.
  const o1 = byOracle.get("O1");
  assert.equal(o1.execution_kind, "custom-seed-slice");
  assert.ok(o1.counts.waiting_on_failed_canceled === 2, "waiting-on-failed counted as observation");
  assert.equal(o1.findings.some((f) => f.startsWith("O1_GROUP_NONTERMINAL_STEPS_ON_COMPLETED: 1")), true);
  assert.equal(o1.findings.some((f) => f.startsWith("O1_GROUP_NONTERMINAL_STEPS:")), false, "generic terminal-run finding removed");

  // O4: the claim-bearing running step on the terminal run IS a dangling
  // claim; the unclaimed waiting steps are NOT.
  const o4 = byOracle.get("O4");
  assert.equal(o4.execution_kind, "custom-seed-slice");
  assert.equal(o4.findings.some((f) => f.startsWith("O4_CLAIM_EVIDENCE_ON_TERMINAL: 1")), true);
  assert.equal(o4.findings.some((f) => f.startsWith("O4_LEFTOVER_CLAIMS")), false, "leftover-claims mini-SQL finding removed");

  // O3z: relabeled NOT_RUN (real-run tripwire inapplicable); zero-token
  // receipts attached as evidence but never labeled PASS.
  const o3z = byOracle.get("O3z");
  assert.equal(o3z.status, "NOT_RUN");
  assert.equal(o3z.execution_kind, "custom-seed-slice");
  assert.ok(o3z.zero_token_receipts.runs_tokens_total === 0);
});

test("P. CLI allocate: owned seed root pins executed source; preflight PASS is zero-effects", async () => {
  const cli = path.join(ROOT, "torture-test", "bin", "tt-storm-aged");
  const base = tmpHome();
  const env = { ...process.env, TAMANDUA_TEST_GUARD: "1" };
  delete env.TAMANDUA_RUN_ID;

  // Explicit allocator entrypoint: creates the owned root and pins the
  // executed generator identity WITHOUT running any phase.
  const alloc = spawnSync(
    process.execPath,
    [cli, "allocate", "--kind", "full", "--run-id", "selftest-allocate", "--base", base],
    { cwd: ROOT, encoding: "utf8", env },
  );
  assert.equal(alloc.status, 0, alloc.stderr);
  const allocOut = JSON.parse(alloc.stdout);
  assert.ok(allocOut.root.startsWith(base + path.sep), `root ${allocOut.root} not under ${base}`);
  assert.match(path.basename(allocOut.root), /^storm-aged\./);
  assert.equal(allocOut.kind, "full");
  assert.ok(allocOut.source?.head?.sha, "executed-source HEAD must be pinned");
  assert.equal(typeof allocOut.source.clean, "boolean");
  assert.equal(allocOut.source.porcelain_sha256.length, 64);

  const man = await import("../manifest.mjs");
  const manifest = man.loadManifest(allocOut.root);
  assert.equal(manifest.source.head.sha, allocOut.source.head.sha);
  assert.deepEqual(manifest.phases, {
    catalog: "pending",
    seed: "pending",
    census: "pending",
    validate: "pending",
  });

  // Recording-only preflight of the allocated root: PASS + zero effects
  // (no state mutation, no model dispatch — the gate only reads).
  const gate = spawnSync(process.execPath, [cli, "preflight", "--root", allocOut.root], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(gate.status, 0, gate.stderr);
  const verdict = JSON.parse(gate.stdout);
  assert.equal(verdict.result, "PASS");
  assert.equal(verdict.effectsDetected, false);
  assert.equal(verdict.checks.R2.ok, true);
  assert.equal(verdict.checks.R3.ok, true);
  assert.ok(fs.existsSync(path.join(allocOut.root, "receipts", "preflight-PASS.json")));

  // Adopting the allocated full root as a pilot refuses (no silent re-pin).
  const mismatch = spawnSync(
    process.execPath,
    [cli, "allocate", "--kind", "pilot", "--root", allocOut.root],
    { cwd: ROOT, encoding: "utf8", env },
  );
  assert.equal(mismatch.status, 2);

  // Persisted PASS + negative-trial battery under <root>/evidence/preflight.
  const batt = spawnSync(process.execPath, [cli, "preflight-evidence", allocOut.root], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
  assert.equal(batt.status, 0, batt.stderr);
  const battery = JSON.parse(batt.stdout);
  assert.equal(battery.allExpected, true);
  assert.equal(battery.results.find((r) => r.case === "pass").result, "PASS");
  assert.ok(fs.existsSync(path.join(allocOut.root, "evidence", "preflight", "battery-summary.json")));
});

test("Q. writeDaemonSecret targets the product-effective state dir (resolveStateDir), not only HOME (DPID state-dir scoping)", async () => {
  const envMod = await import("../env.mjs");
  const home = tmpHome();
  const stateDir = path.join(tmpHome(), "state");
  const prev = process.env.TAMANDUA_STATE_DIR;
  process.env.TAMANDUA_STATE_DIR = stateDir;
  try {
    const first = envMod.writeDaemonSecret(home);
    // RED ARM: the pre-fix code returned <home>/.tamandua/daemon-secret, so the
    // product's readDaemonSecret() (resolveStateDir()/daemon-secret) returned
    // null and the transport double rejected every register with 401.
    assert.equal(
      first.secretPath,
      path.join(stateDir, "daemon-secret"),
      "secret must land where defaultDaemonSecretFile() (resolveStateDir) reads it",
    );
    assert.equal(fs.readFileSync(first.secretPath, "utf-8").trim(), first.secret);
    assert.equal(first.created, true);
    assert.equal(
      fs.readFileSync(path.join(home, ".tamandua", "daemon-secret"), "utf-8").trim(),
      first.secret,
    );
    // Idempotent: a second call reuses the authoritative state secret.
    const second = envMod.writeDaemonSecret(home);
    assert.equal(second.secret, first.secret);
    assert.equal(second.created, false);
    // The product's own resolver reads exactly this directory.
    const { resolveStateDir } = await import(
      new URL(`file://${path.join(ROOT, "dist", "lib", "tamandua-config.js")}`).href
    );
    assert.equal(resolveStateDir(), path.resolve(stateDir));
    assert.equal(
      path.join(resolveStateDir(), "daemon-secret"),
      first.secretPath,
      "product secret resolution must match the seed writer",
    );
  } finally {
    if (prev === undefined) delete process.env.TAMANDUA_STATE_DIR;
    else process.env.TAMANDUA_STATE_DIR = prev;
  }
});

test("R. generated full seed root (when present) records the spec scale and read-only snapshot/sidecar", async (t) => {
  const pointer = path.join(ROOT, "torture-test", "var", "results", "storm-seed-regen-us005-seedroot.txt");
  const seeded = process.env.TT_STORM_AGED_SEED_ROOT
    ?? (fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8").trim() : null);
  if (!seeded || !fs.existsSync(path.join(seeded, "manifest.json"))) {
    t.skip("no generated full seed root present (set TT_STORM_AGED_SEED_ROOT)");
    return;
  }
  const man = await import("../manifest.mjs");
  const manifest = man.loadManifest(seeded);
  assert.equal(manifest.seed_kind, "full");
  const receipts = fs.readdirSync(path.join(seeded, "receipts"))
    .filter((f) => /^census-full-post-.*\.json$/.test(f))
    .sort();
  assert.ok(receipts.length > 0, "a post-volume census receipt must exist");
  const census = JSON.parse(fs.readFileSync(path.join(seeded, "receipts", receipts[receipts.length - 1]), "utf8"));
  assert.equal(census.db.runs, 5000, "spec runs scale");
  assert.equal(census.db.run_worktrees, 200, "spec worktree scale");
  assert.ok(census.events.perRunLogicalLines >= 500000, "spec logical-event scale");
  const snap = manifest.snapshot.db;
  assert.equal(snap.mode & 0o777, 0o444, "immutable DB snapshot must be 0444");
  assert.match(snap.sha256, /^[0-9a-f]{64}$/);
  const sidecar = manifest.snapshot.reservedBaselineSidecar;
  assert.equal(sidecar.mode & 0o777, 0o400, "reserved-key sidecar must be 0o400");
  assert.equal(sidecar.scopeMode, "all-snapshot-runs", "complete typed v2 baseline scope");
});

test("S. generated full seed root records the honest validation classification ledger (US-006)", async (t) => {
  const pointer = path.join(ROOT, "torture-test", "var", "results", "storm-seed-regen-us005-seedroot.txt");
  const seeded = process.env.TT_STORM_AGED_SEED_ROOT
    ?? (fs.existsSync(pointer) ? fs.readFileSync(pointer, "utf8").trim() : null);
  if (!seeded || !fs.existsSync(path.join(seeded, "manifest.json"))) {
    t.skip("no generated full seed root present (set TT_STORM_AGED_SEED_ROOT)");
    return;
  }
  const reportFile = path.join(seeded, "evidence", "seed-validation-report.json");
  const classificationFile = path.join(seeded, "evidence", "seed-validation-classification.json");
  assert.ok(fs.existsSync(reportFile), "validate must have written seed-validation-report.json");
  assert.ok(fs.existsSync(classificationFile), "validate must write seed-validation-classification.json (US-006)");
  const classification = JSON.parse(fs.readFileSync(classificationFile, "utf8"));
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
  assert.equal(classification.kind, "aged-seed-validation-classification");
  // Every routing row is echoed with an explicit classification; NOT_RUN and
  // NOT_EVALUABLE are distinct from PASS and no red is UNCLASSIFIED.
  const legal = new Set(["PASS", "NATIVE", "SUITE", "ENVIRONMENT", "NOT_RUN", "NOT_EVALUABLE"]);
  for (const row of classification.routing_matrix) {
    assert.ok(legal.has(row.classification), `row ${row.oracle} classification ${row.classification} must be legal`);
  }
  // Tally reconciles against the report's own row statuses (never fabricated).
  const tally = classification.matrix_tally;
  const reportRows = report.routing?.rows ?? [];
  for (const status of ["PASS", "FAIL", "NOT_RUN", "NOT_EVALUABLE"]) {
    assert.equal(
      tally[status],
      reportRows.filter((r) => r.status === status).length,
      `matrix_tally.${status} must match the report's routing rows`,
    );
  }
  // O12 is EVALUABLE (real execution with legs/counts), never a whole-oracle ERROR.
  assert.ok(["PASS", "FAIL"].includes(classification.o12_result), `O12 must be evaluable, got ${classification.o12_result}`);
  assert.ok(classification.o12_legs && classification.o12_legs.R1, "O12 legs must be recorded");
  if (classification.o12_result === "PASS") {
    assert.equal(classification.native_reds.length, 0, "a green O12 must not fabricate a NATIVE red");
  } else {
    assert.ok(classification.native_reds.some((r) => r.oracle === "O12"), "a red O12 must be classified");
  }
});

const AGED = path.resolve(new URL(".", import.meta.url).pathname, "..");


