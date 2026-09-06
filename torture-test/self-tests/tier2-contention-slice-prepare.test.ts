// Tier-2 STORM-I US-001: tt-contention-slice `prepare` — preparation and
// provenance for the interim W3/W4 contention slice (regression-tested against
// the 2026-09-05 coordinator review corrections, including the 00:49Z US-002
// draft-review closures).
//
// Gates (all hermetic; no daemons, no fixed ports, no real models):
//  1. help/no-argument invocations exit 0 with usage and NO filesystem side
//     effects; sample/summarize without their explicit arguments and unknown
//     commands exit non-zero (summarize is implemented since STORM-I US-003);
//  2. the REAL CLI prepare with the four canonical ids writes a 4-row JSONL
//     manifest under a fresh unique directory in torture-test/var whose rows
//     are byte-for-byte equal, in order, to the DISCOVERED current-catalog
//     rows (lines are provenance, never pinned), plus full provenance
//     (actual lines, catalog/row/task hashes, source commit, tracked-tree
//     cleanliness with pinned_clean_candidate only on a clean tree,
//     source_drift null, manifest hash, controller argv --concurrency 4
//     --stagger 10s), and the manifest passes the real tt-controller
//     --validate-only;
//  3. auto mode allocates fresh unique directories and never overwrites or
//     removes a previous preparation directory;
//  4. PURE fixture-catalog injection (runPrepare with a contained mirror
//     catalogRoot under var — the operator CLI has NO catalog substitution
//     option): missing id, duplicate id, missing catalog file, and missing
//     required task source fail leaving NO partial output; a row MOVED to a
//     different line succeeds and records its actual line; a schema-invalid
//     fixture row makes --validate-only fail with exit 1 and RETAINED
//     artifacts; a catalog root outside torture-test/ is refused;
//  5. request-level duplicates and malformed entries are rejected by the pure
//     selection loader;
//  6. destination refusals on the REAL CLI: outside torture-test/var, path
//     traversal, an existing destination symlink, a symlink escape, and an
//     already-existing destination — all non-zero, clear, never touching the
//     target;
//  7. var-root validation is exercised purely against fixture mirrors (a
//     symlinked var root and an escaped var root are rejected; a plain var
//     root is accepted) — the real checkout's var is never touched;
//  8. drift detection is pure: catalog byte snapshots feed every hash and
//     checkCatalogDrift re-hashes the same files afterwards; required task
//     bytes are re-checked by checkTaskDrift; decideSourcePinState pins the
//     semantics — content drift rejects, and a tree dirty at start is never
//     upgraded to pinned-clean when it becomes clean later.
//
// Everything writes only under torture-test/var (git-ignored) in fresh temp
// fixtures owned by this file. The isolation guard is PRESERVED.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  assertVarRootContained,
  checkCatalogDrift,
  checkTaskDrift,
  decideSourcePinState,
  loadSelection,
  requireTaskFileHash,
  runPrepare,
  snapshotCatalogFiles,
} from "../bin/tt-contention-slice-shared.mjs";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const varRoot = path.join(ttRoot, "var");
const cli = path.join(ttRoot, "bin", "tt-contention-slice");
const controller = path.join(ttRoot, "bin", "tt-controller");

// The canonical interim roster (STORM-I US-001). Lines are NOT pinned: they
// are discovered by scanning the catalogs and recorded as provenance.
const CANONICAL = [
  { id: "W3.03-bfmw-hermes-ts", catalog: "cases/tier1.jsonl" },
  { id: "W4.06-colleague-rebase", catalog: "cases/tier2.jsonl" },
  { id: "W4.09-pi-kill-harness", catalog: "cases/tier2.jsonl" },
  { id: "W4.dsh-bfmw", catalog: "cases/tier2.jsonl" },
];

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Guard propagation preserved: spawn env is the caller env (which may carry
// TAMANDUA_TEST_GUARD / NODE_TEST_CONTEXT) plus harmless harness pins.
function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env,
    TAMANDUA_PI_BINARY: "/bin/false",
    TAMANDUA_HERMES_BINARY: "/bin/false",
    TAMANDUA_DSH_BINARY: "/bin/false",
  };
  return { ...env, ...extra };
}

function runCli(args: string[], env: Record<string, string> = {}): RunResult {
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: ttRoot,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnv(env),
  });
  return {
    status: res.status,
    stdout: String(res.stdout ?? ""),
    stderr: String(res.stderr ?? ""),
  };
}

function runGit(args: string[]): string {
  const res = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")} failed: ${String(res.stderr ?? "")}`);
  return String(res.stdout ?? "").trim();
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(abs: string): string {
  return sha256(fs.readFileSync(abs));
}

function loadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function lineBuffers(absPath: string): Buffer[] {
  const buf = fs.readFileSync(absPath);
  const lines: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] !== 0x0a) continue;
    let end = i;
    if (end > start && buf[end - 1] === 0x0d) end -= 1;
    lines.push(buf.subarray(start, end));
    start = i + 1;
  }
  if (start < buf.length) lines.push(buf.subarray(start));
  return lines;
}

function discoverRow(absCatalog: string, id: string): { line: number; bytes: Buffer } {
  const lines = lineBuffers(absCatalog);
  const hits: Array<{ line: number; bytes: Buffer }> = [];
  lines.forEach((bytes, index) => {
    const text = bytes.toString("utf8");
    if (text.trim() === "") return;
    let record: any;
    try {
      record = JSON.parse(text);
    } catch {
      return;
    }
    if (record?.id === id) hits.push({ line: index + 1, bytes });
  });
  assert.equal(hits.length, 1, `${id} must occur exactly once in ${absCatalog}`);
  return hits[0];
}

function manifestLines(manifestPath: string): Buffer[] {
  return lineBuffers(manifestPath).filter((b) => b.length > 0);
}

let scratchCounter = 0;
function scratchDir(label: string): string {
  scratchCounter += 1;
  return path.join(varRoot, `tier2-contention-prepare-${label}-${process.pid}-${Date.now()}-${scratchCounter}`);
}

function rmrf(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

// Build a fixture catalog-root MIRROR under var: copies the real tier1/tier2
// catalogs under <root>/cases/ (entry catalogs are 'cases/*.jsonl', relative
// to the mirror root). Used ONLY through the pure runPrepare catalogRoot
// parameter — the operator CLI has no catalog substitution option. The root is
// allocated ATOMICALLY (fs.mkdtempSync) so it is verifiably owned by this test
// and safe to remove in its finally block; a failed allocation throws before
// any root is returned, so an unallocated root is never cleaned.
function fixtureCatalogRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(varRoot, `tier2-contention-prepare-fixture-${label}-`));
  fs.mkdirSync(path.join(root, "cases"), { recursive: true });
  for (const name of ["tier1.jsonl", "tier2.jsonl"]) {
    fs.copyFileSync(path.join(ttRoot, "cases", name), path.join(root, "cases", name));
  }
  return root;
}

function fixtureLines(catalogRoot: string, name: string): string[] {
  return lineBuffers(path.join(catalogRoot, "cases", name)).map((b) => b.toString("utf8"));
}

function writeFixtureLines(catalogRoot: string, name: string, lines: string[]): void {
  fs.writeFileSync(path.join(catalogRoot, "cases", name), `${lines.join("\n")}\n`);
}

function rowIndex(lines: string[], id: string): number {
  const index = lines.findIndex((text) => {
    if (text.trim() === "") return false;
    try {
      return JSON.parse(text)?.id === id;
    } catch {
      return false;
    }
  });
  assert.ok(index >= 0, `fixture row ${id} not found`);
  return index;
}

// Run the REAL prepare algorithm against a fixture mirror (pure injection).
function runPrepareFixture(catalogRoot: string, outArg: string | null): {
  code: number;
  stdout: string;
  stderr: string;
} {
  let stdout = "";
  let stderr = "";
  const code = runPrepare({
    outArg,
    catalogRoot,
    env: childEnv(),
    onStdout: (text) => { stdout += text; },
    onStderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr };
}

fs.mkdirSync(varRoot, { recursive: true });

describe("tier-2 STORM-I US-001 — tt-contention-slice prepare + provenance (corrected)", () => {
  it("no-argument invocation and --help/-h exit 0 with usage text and no filesystem side effects", () => {
    const baseline = fs.readdirSync(varRoot).sort();
    for (const args of [[], ["--help"], ["-h"]]) {
      const res = runCli(args);
      assert.equal(res.status, 0, `args ${JSON.stringify(args)} must exit 0`);
      assert.match(res.stdout, /Usage: tt-contention-slice <command> \[options\]/,
        `args ${JSON.stringify(args)} must print usage`);
      assert.match(res.stdout, /prepare/, "usage must name the prepare subcommand");
      const after = fs.readdirSync(varRoot).sort();
      assert.deepEqual(after, baseline,
        `args ${JSON.stringify(args)} must have no filesystem side effects under var`);
    }
  });

  it("sample and summarize require explicit arguments; unknown commands exit non-zero", () => {
    const sample = runCli(["sample"]);
    assert.notEqual(sample.status, 0, "sample without arguments must exit non-zero");
    assert.match(sample.stderr, /requires --prep/);
    const summarize = runCli(["summarize"]);
    assert.notEqual(summarize.status, 0, "summarize without arguments must exit non-zero");
    assert.match(summarize.stderr, /summarize requires --prep/);
    const unknown = runCli(["frobnicate"]);
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown command: frobnicate/);
  });

  it("prepare writes a byte-identical 4-row manifest with full provenance under a fresh --out directory and passes the controller --validate-only", () => {
    const outDir = scratchDir("ok");
    const res = runCli(["prepare", "--out", outDir]);
    assert.equal(res.status, 0, `prepare must exit 0:\n${res.stdout}${res.stderr}`);
    try {
      // Rows byte-for-byte equal, in order, to the DISCOVERED catalog rows.
      const manifestPath = path.join(outDir, "manifest.jsonl");
      assert.ok(fs.existsSync(manifestPath), "manifest.jsonl must exist");
      const expectedSources = CANONICAL.map((entry) =>
        discoverRow(path.join(ttRoot, entry.catalog), entry.id));
      const actualLines = manifestLines(manifestPath);
      assert.equal(actualLines.length, 4, "manifest must contain exactly 4 rows");
      expectedSources.forEach((expected, index) => {
        assert.ok(actualLines[index].equals(expected.bytes),
          `manifest row ${index + 1} must be byte-identical to its discovered source line`);
      });
      const rows = actualLines.map((b) => JSON.parse(b.toString("utf8")));
      assert.deepEqual(rows.map((r) => r.id), CANONICAL.map((c) => c.id),
        "manifest ids must appear in the canonical order");

      const provenancePath = path.join(outDir, "provenance.json");
      assert.ok(fs.existsSync(provenancePath), "provenance.json must exist");
      const prov = loadJson(provenancePath);
      assert.equal(prov.subcommand, "prepare");
      assert.equal(prov.tool, "tt-contention-slice");
      // Selected ids/order and the ACTUAL discovered line (provenance).
      assert.deepEqual(prov.selection.map((s: any) => s.id), CANONICAL.map((c) => c.id));
      prov.selection.forEach((entry: any, index: number) => {
        assert.equal(entry.catalog, CANONICAL[index].catalog);
        assert.equal(entry.line, expectedSources[index].line,
          "provenance must record the ACTUAL discovered line");
      });
      assert.equal(prov.catalog_root, "torture-test/");
      // Catalog hashes over the same bytes that produced the rows.
      assert.deepEqual(Object.keys(prov.catalogs).sort(), ["cases/tier1.jsonl", "cases/tier2.jsonl"]);
      for (const [rel, hash] of Object.entries<any>(prov.catalogs)) {
        const fileBytes = fs.readFileSync(path.join(ttRoot, rel));
        assert.equal(hash.sha256, sha256(fileBytes), `catalog hash mismatch for ${rel}`);
        assert.equal(hash.bytes, fileBytes.length);
      }
      // Row + task hashes (tasks are REQUIRED: never null-hash success).
      prov.rows.forEach((row: any, index: number) => {
        const src = expectedSources[index];
        assert.equal(row.sha256, sha256(src.bytes), `row hash mismatch for ${row.id}`);
        assert.equal(row.bytes, src.bytes.length);
        const record = JSON.parse(src.bytes.toString("utf8"));
        assert.equal(row.task, record.task);
        assert.ok(typeof row.task === "string" && row.task.length > 0, `${row.id} must name a task file`);
        const taskBytes = fs.readFileSync(path.join(ttRoot, row.task));
        assert.equal(row.task_sha256, sha256(taskBytes), `task hash mismatch for ${row.id}`);
        assert.equal(row.task_bytes, taskBytes.length);
        assert.equal(row.task_error, null, `${row.id} task must hash without error`);
      });
      // Manifest hash.
      const manifestBytes = fs.readFileSync(manifestPath);
      assert.equal(prov.manifest.sha256, sha256(manifestBytes));
      assert.equal(prov.manifest.bytes, manifestBytes.length);
      assert.equal(prov.manifest.rows, 4);
      // Source commit + tracked-tree cleanliness (pinned only on clean).
      const head = runGit(["rev-parse", "HEAD"]);
      assert.equal(prov.source.commit, head);
      const porcelain = runGit(["status", "--porcelain"]);
      assert.equal(prov.source.tracked_tree_clean, porcelain === "");
      assert.equal(prov.source.pinned_clean_candidate, porcelain === "",
        "pinned_clean_candidate must be true ONLY for a clean tracked tree");
      if (porcelain === "") assert.equal(prov.source.unpinned_reason, null);
      assert.equal(prov.source_drift, null, "no drift expected on a quiescent tree");
      // Controller executable/cwd/argv with --concurrency 4 --stagger 10s.
      assert.equal(prov.controller.executable, controller);
      assert.equal(prov.controller.cwd, ttRoot);
      assert.equal(prov.controller.concurrency, 4);
      assert.equal(prov.controller.stagger, "10s");
      assert.deepEqual(prov.controller.argv.slice(0, 2), [controller, "--manifest"]);
      assert.equal(prov.controller.argv[2], manifestPath);
      assert.ok(prov.controller.argv.includes("--concurrency"));
      assert.ok(prov.controller.argv.includes("4"));
      assert.ok(prov.controller.argv.includes("--stagger"));
      assert.ok(prov.controller.argv.includes("10s"));
      assert.ok(prov.controller.command.includes("--concurrency 4"));
      assert.ok(prov.controller.command.includes("--stagger 10s"));
      assert.equal(prov.validation.ok, true, "controller --validate-only must pass");
      assert.equal(prov.validation.exit_code, 0);
      assert.match(prov.validation.stdout, /Validated 4 case\(s\)/);
      // The argv is printed legibly on stdout and never executed.
      assert.match(res.stdout, /Controller launch argv/);
      assert.match(res.stdout, /--concurrency 4/);
      assert.match(res.stdout, /--stagger 10s/);
      assert.ok(res.stdout.includes(manifestPath), "stdout must show the generated manifest path");
      assert.match(res.stdout, /Prepared manifest: /);
      assert.match(res.stdout, /Provenance: /);
    } finally {
      rmrf(outDir);
    }
  });

  it("auto mode allocates a fresh unique directory under var per run and never overwrites or removes a previous one", () => {
    const first = runCli(["prepare"]);
    assert.equal(first.status, 0, `first prepare must exit 0:\n${first.stdout}${first.stderr}`);
    const firstManifest = /^Prepared manifest: (.+)$/m.exec(first.stdout)?.[1];
    assert.ok(firstManifest, "first stdout must name the manifest");
    const firstDir = path.dirname(firstManifest);
    try {
      const second = runCli(["prepare"]);
      assert.equal(second.status, 0, `second prepare must exit 0:\n${second.stdout}${second.stderr}`);
      const secondManifest = /^Prepared manifest: (.+)$/m.exec(second.stdout)?.[1];
      assert.ok(secondManifest, "second stdout must name the manifest");
      const secondDir = path.dirname(secondManifest);
      try {
        assert.ok(firstDir.startsWith(`${varRoot}${path.sep}`), "first dir must live under var");
        assert.ok(secondDir.startsWith(`${varRoot}${path.sep}`), "second dir must live under var");
        assert.notEqual(firstDir, secondDir, "each prepare must use a fresh unique directory");
        assert.match(path.basename(firstDir), /^contention-slice-/);
        assert.ok(fs.existsSync(firstManifest), "the first preparation must still exist after the second run");
        assert.equal(manifestLines(firstManifest).length, 4, "first manifest must be untouched");
        assert.equal(manifestLines(secondManifest).length, 4);
        assert.ok(fs.readFileSync(firstManifest).equals(fs.readFileSync(secondManifest)),
          "both runs copy the same canonical rows byte-identically");
      } finally {
        rmrf(secondDir);
      }
    } finally {
      rmrf(firstDir);
    }
  });

  it("pure fixture-catalog failures leave no partial output; a moved row succeeds and records its actual line", () => {
    // (a) missing id in the fixture mirror.
    const missingRoot = fixtureCatalogRoot("missing");
    const missingLines = fixtureLines(missingRoot, "tier2.jsonl");
    missingLines.splice(rowIndex(missingLines, "W4.dsh-bfmw"), 1);
    writeFixtureLines(missingRoot, "tier2.jsonl", missingLines);
    const missingOut = scratchDir("missing-out");
    try {
      assert.throws(() => runPrepareFixture(missingRoot, missingOut), /W4\.dsh-bfmw is MISSING/);
      assert.ok(!fs.existsSync(missingOut), "no partial output dir may be left behind");
    } finally {
      rmrf(missingRoot);
    }

    // (b) duplicate id within the fixture mirror.
    const dupRoot = fixtureCatalogRoot("dup");
    const dupLines = fixtureLines(dupRoot, "tier2.jsonl");
    dupLines.splice(rowIndex(dupLines, "W4.dsh-bfmw"), 0, dupLines[rowIndex(dupLines, "W4.dsh-bfmw")]);
    writeFixtureLines(dupRoot, "tier2.jsonl", dupLines);
    const dupOut = scratchDir("dup-out");
    try {
      assert.throws(() => runPrepareFixture(dupRoot, dupOut), /W4\.dsh-bfmw occurs 2 times/);
      assert.ok(!fs.existsSync(dupOut), "no partial output dir may be left behind");
    } finally {
      rmrf(dupRoot);
    }

    // (c) a MISSING catalog file in the mirror.
    const noCatRoot = scratchDir("nocat");
    fs.mkdirSync(path.join(noCatRoot, "cases"), { recursive: true });
    fs.copyFileSync(path.join(ttRoot, "cases", "tier1.jsonl"), path.join(noCatRoot, "cases", "tier1.jsonl"));
    const noCatOut = scratchDir("nocat-out");
    try {
      assert.throws(() => runPrepareFixture(noCatRoot, noCatOut), /catalog does not exist: cases\/tier2\.jsonl/);
      assert.ok(!fs.existsSync(noCatOut), "no partial output dir may be left behind");
    } finally {
      rmrf(noCatRoot);
    }

    // (d) a MISSING REQUIRED task source fails with no output dir (no
    // null-hash success).
    const taskRoot = fixtureCatalogRoot("task");
    const taskLines = fixtureLines(taskRoot, "tier2.jsonl");
    const badTask = JSON.stringify({
      id: "W4.06-colleague-rebase",
      wave: 4,
      workflow: "feature-dev-merge-worktree",
      fixture: "tt-go",
      harness: "pi",
      task: `var/${path.basename(taskRoot)}/no-such-task.md`,
      caps: { tokens: 1, wall_min: 1 },
      class: "verification",
    });
    taskLines[rowIndex(taskLines, "W4.06-colleague-rebase")] = badTask;
    writeFixtureLines(taskRoot, "tier2.jsonl", taskLines);
    const taskOut = scratchDir("task-out");
    try {
      assert.throws(() => runPrepareFixture(taskRoot, taskOut), /required task source does not exist/);
      assert.ok(!fs.existsSync(taskOut), "no partial output dir may be left behind");
    } finally {
      rmrf(taskRoot);
    }

    // (e) a row MOVED to a different physical line is not a failure: prepare
    // succeeds, copies the full row at its actual line, records that line.
    const movedRoot = fixtureCatalogRoot("moved");
    const movedLines = fixtureLines(movedRoot, "tier2.jsonl");
    const [dshRow] = movedLines.splice(rowIndex(movedLines, "W4.dsh-bfmw"), 1);
    movedLines.push('{"id":"filler-row","wave":9,"workflow":"local","fixture":"none","harness":"local","task":"cases/tasks/tier1/W3.03-bfmw-hermes-ts.md","caps":{"tokens":0,"wall_min":1},"class":"verification"}');
    movedLines.push(dshRow);
    writeFixtureLines(movedRoot, "tier2.jsonl", movedLines);
    const movedOut = scratchDir("moved-out");
    try {
      const moved = runPrepareFixture(movedRoot, movedOut);
      assert.equal(moved.code, 0, `a moved row must still prepare successfully:\n${moved.stdout}${moved.stderr}`);
      const prov = loadJson(path.join(movedOut, "provenance.json"));
      const entry = prov.selection.find((s: any) => s.id === "W4.dsh-bfmw");
      const realLine = discoverRow(path.join(movedRoot, "cases", "tier2.jsonl"), "W4.dsh-bfmw").line;
      assert.equal(entry.line, realLine, "provenance must record the moved row's actual line");
      const manifestPath = path.join(movedOut, "manifest.jsonl");
      const realBytes = discoverRow(path.join(movedRoot, "cases", "tier2.jsonl"), "W4.dsh-bfmw").bytes;
      assert.ok(manifestLines(manifestPath)[3].equals(realBytes),
        "manifest must carry the moved row byte-identically");
    } finally {
      rmrf(movedRoot);
      rmrf(movedOut);
    }

    // (f) a catalog root outside torture-test/ is refused (pure, no output).
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-root-"));
    const rootOut = scratchDir("rootout");
    try {
      assert.throws(() => runPrepareFixture(outsideRoot, rootOut), /catalog root outside this checkout's torture-test/);
      assert.ok(!fs.existsSync(rootOut), "no output dir may be created");
    } finally {
      rmrf(outsideRoot);
    }
  });

  it("validation failures through the pure prepare core return non-zero and RETAIN manifest + provenance artifacts", () => {
    const fixtureRoot = fixtureCatalogRoot("valfail");
    const lines = fixtureLines(fixtureRoot, "tier2.jsonl");
    lines[rowIndex(lines, "W4.06-colleague-rebase")] = JSON.stringify({
      id: "W4.06-colleague-rebase",
      task: "cases/tasks/tier2/W4.06-colleague-rebase.md",
    });
    writeFixtureLines(fixtureRoot, "tier2.jsonl", lines);
    const outDir = scratchDir("valfail-out");
    try {
      const res = runPrepareFixture(fixtureRoot, outDir);
      assert.equal(res.code, 1, "a schema-invalid manifest row must make prepare fail");
      assert.match(res.stderr, /manifest validation FAILED/);
      assert.ok(fs.existsSync(outDir), "the failure artifacts must be retained");
      const manifestPath = path.join(outDir, "manifest.jsonl");
      const provenancePath = path.join(outDir, "provenance.json");
      assert.ok(fs.existsSync(manifestPath), "the manifest must be retained on validation failure");
      assert.ok(fs.existsSync(provenancePath), "the provenance must be retained on validation failure");
      assert.equal(manifestLines(manifestPath).length, 4);
      const bad = discoverRow(path.join(fixtureRoot, "cases", "tier2.jsonl"), "W4.06-colleague-rebase");
      const badIndex = CANONICAL.findIndex((entry) => entry.id === "W4.06-colleague-rebase");
      assert.ok(manifestLines(manifestPath)[badIndex].equals(bad.bytes),
        "the retained manifest row must be byte-identical to the fixture source");
      const prov = loadJson(provenancePath);
      assert.equal(prov.validation.ok, false);
      assert.notEqual(prov.validation.exit_code, 0);
      assert.ok(prov.validation.stderr.length > 0, "validation stderr must be captured in provenance");
    } finally {
      rmrf(fixtureRoot);
      rmrf(outDir);
    }
  });

  it("request-level duplicates and malformed entries are rejected by the pure selection loader", () => {
    assert.throws(() => loadSelection([
      { id: "W4.dsh-bfmw", catalog: "cases/tier2.jsonl" },
      { id: "W4.dsh-bfmw", catalog: "cases/tier2.jsonl" },
    ]), /duplicate selected id in request: W4\.dsh-bfmw/);
    assert.throws(() => loadSelection([{ id: "bad id!", catalog: "cases/tier2.jsonl" }]), /invalid id/);
    assert.throws(() => loadSelection([{ id: "W4.dsh-bfmw" }]), /invalid catalog/);
    assert.throws(() => loadSelection("nope" as any), /selection must be an array/);
    assert.equal(loadSelection().length, 4);
  });

  it("the REAL CLI refuses outside-var, traversal, existing-destination, and symlink destinations without touching them", () => {
    // (a) outside torture-test/var.
    const outsideScratch = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-outside-"));
    const outside = path.join(outsideScratch, "target");
    let res = runCli(["prepare", "--out", outside]);
    assert.notEqual(res.status, 0, "a destination outside var must be refused");
    assert.match(res.stderr, /outside torture-test\/var/);
    assert.ok(!fs.existsSync(outside), "nothing may be created outside var");
    rmrf(outsideScratch);

    // (b) path traversal.
    const traversalBase = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-trav-"));
    const traversal = `${traversalBase}/../escape-${process.pid}-${Date.now()}`;
    res = runCli(["prepare", "--out", traversal]);
    assert.notEqual(res.status, 0, "a path-traversal destination must be refused");
    assert.match(res.stderr, /path-traversal/);
    assert.ok(!fs.existsSync(traversal), "nothing may be created at the traversal target");
    rmrf(traversalBase);

    // (c) an already-existing directory (previous preparation must survive).
    const existing = scratchDir("existing");
    fs.mkdirSync(existing, { recursive: true });
    const marker = path.join(existing, "keep-me.txt");
    fs.writeFileSync(marker, "previous result");
    try {
      res = runCli(["prepare", "--out", existing]);
      assert.notEqual(res.status, 0, "an existing destination must be refused");
      assert.match(res.stderr, /already exists/);
      assert.ok(fs.existsSync(marker), "the previous result must be untouched");
      assert.equal(fs.readFileSync(marker, "utf8"), "previous result");
      assert.ok(!fs.existsSync(path.join(existing, "manifest.jsonl")),
        "no manifest may be written into the existing directory");
    } finally {
      rmrf(existing);
    }

    // (d) an existing destination symlink (never silently followed).
    const realTarget = scratchDir("realtarget");
    fs.mkdirSync(realTarget, { recursive: true });
    const destLink = scratchDir("destlink");
    try {
      fs.symlinkSync(realTarget, destLink);
      res = runCli(["prepare", "--out", destLink]);
      assert.notEqual(res.status, 0, "an existing destination symlink must be refused");
      assert.match(res.stderr, /existing symlink/);
      assert.ok(fs.existsSync(realTarget), "the symlink target must remain untouched");
      assert.deepEqual(fs.readdirSync(realTarget), [], "the symlink target must stay empty");
    } finally {
      rmrf(destLink);
      rmrf(realTarget);
    }

    // (e) a symlink escape through an existing ancestor inside var.
    const escapeScratch = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-escape-"));
    const escapeTarget = path.join(escapeScratch, "target");
    fs.mkdirSync(escapeTarget, { recursive: true });
    const escapeLink = path.join(varRoot, `tier2-cs-escape-${process.pid}-${Date.now()}`);
    try {
      fs.symlinkSync(escapeTarget, escapeLink);
      res = runCli(["prepare", "--out", path.join(escapeLink, "fresh")]);
      assert.notEqual(res.status, 0, "a symlink escape destination must be refused");
      assert.match(res.stderr, /symlink/);
      assert.deepEqual(fs.readdirSync(escapeTarget), [], "nothing may be created through the escaping symlink");
    } finally {
      rmrf(escapeLink);
      rmrf(escapeScratch);
    }
  });

  it("var-root validation is fail-closed and exercised purely against fixture mirrors (never the real var)", () => {
    const mirror = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-varmirror-"));
    try {
      const ok = assertVarRootContained({ varRoot: path.join(mirror, "var"), ttDir: mirror });
      assert.equal(ok, path.join(mirror, "var"));

      const target = path.join(mirror, "elsewhere");
      fs.mkdirSync(target, { recursive: true });
      const symlinkVar = path.join(mirror, "var-link");
      fs.symlinkSync(target, symlinkVar);
      assert.throws(
        () => assertVarRootContained({ varRoot: symlinkVar, ttDir: mirror }),
        (error: any) => error.code === "TT_SYMLINK",
      );

      const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tier2-cs-otherroot-"));
      try {
        fs.mkdirSync(path.join(otherRoot, "var"), { recursive: true });
        assert.throws(
          () => assertVarRootContained({ varRoot: path.join(otherRoot, "var"), ttDir: mirror }),
          (error: any) => error.code === "TT_ESCAPE",
        );
      } finally {
        rmrf(otherRoot);
      }

      fs.mkdirSync(path.join(mirror, "var"), { recursive: true });
      assert.equal(assertVarRootContained({ varRoot: path.join(mirror, "var"), ttDir: mirror }), path.join(mirror, "var"));
    } finally {
      rmrf(mirror);
    }
  });

  it("drift detection is pure: catalog + required-task byte re-checks and honest pin-state decisions", () => {
    const fixtureRoot = fixtureCatalogRoot("drift");
    try {
      const selection = loadSelection();
      const snapshots = snapshotCatalogFiles(selection, { catalogRoot: fixtureRoot });
      assert.deepEqual(checkCatalogDrift(snapshots), []);
      // Catalog drift after mutation of the same source bytes.
      const tier2 = path.join(fixtureRoot, "cases", "tier2.jsonl");
      fs.appendFileSync(tier2, '\n{"id":"drift-row","wave":9,"workflow":"local","fixture":"none","harness":"local","task":"cases/tasks/tier1/W3.03-bfmw-hermes-ts.md","caps":{"tokens":0,"wall_min":1},"class":"verification"}\n');
      const drifted = checkCatalogDrift(snapshots);
      assert.equal(drifted.length, 1);
      assert.equal(drifted[0].catalog, "cases/tier2.jsonl");
      assert.notEqual(drifted[0].actual_sha256, drifted[0].expected_sha256);

      // Required-task drift: hash a task file, mutate it, re-check.
      const taskPath = path.join(fixtureRoot, "tasks", "sample-task.md");
      fs.mkdirSync(path.dirname(taskPath), { recursive: true });
      fs.writeFileSync(taskPath, "task v1\n");
      const taskHash = requireTaskFileHash({ id: "X", task: path.relative(ttRoot, taskPath) });
      assert.deepEqual(checkTaskDrift([taskHash]), []);
      fs.writeFileSync(taskPath, "task v2 — mutated\n");
      const taskDrifted = checkTaskDrift([taskHash]);
      assert.equal(taskDrifted.length, 1);
      assert.equal(taskDrifted[0].task, taskHash.task);
      assert.notEqual(taskDrifted[0].actual_sha256, taskHash.task_sha256);

      // Pin-state semantics (pure): a tree dirty at start is NEVER upgraded
      // to pinned-clean just because it becomes clean later.
      const commit = "a".repeat(40);
      const clean = { commit, tracked_tree_clean: true };
      const dirtySameCommit = { commit, tracked_tree_clean: false };
      const noDrift = decideSourcePinState({ sourceBefore: clean, sourceAfter: clean });
      assert.equal(noDrift.pinnedCleanCandidate, true);
      assert.equal(noDrift.contentDrift, false);
      assert.equal(noDrift.driftEvidence, null);

      const dirtyStart = decideSourcePinState({ sourceBefore: dirtySameCommit, sourceAfter: clean });
      assert.equal(dirtyStart.pinnedCleanCandidate, false, "dirty-at-start must never upgrade to pinned-clean");
      assert.equal(dirtyStart.contentDrift, false, "becoming clean is not content drift");
      assert.match(dirtyStart.unpinned_reason, /not clean when preparation began/);

      const cleanToDirty = decideSourcePinState({ sourceBefore: clean, sourceAfter: dirtySameCommit });
      assert.equal(cleanToDirty.contentDrift, true, "tree worsening is content drift");
      assert.equal(cleanToDirty.pinnedCleanCandidate, false);

      const commitMoved = decideSourcePinState({
        sourceBefore: { commit: "a".repeat(40), tracked_tree_clean: true },
        sourceAfter: { commit: "c".repeat(40), tracked_tree_clean: true },
      });
      assert.equal(commitMoved.contentDrift, true, "a moved commit is content drift");

      const taskDriftPin = decideSourcePinState({ sourceBefore: clean, sourceAfter: clean, taskDrift: taskDrifted });
      assert.equal(taskDriftPin.contentDrift, true, "required-task drift is content drift");
      assert.equal(taskDriftPin.pinnedCleanCandidate, false);
    } finally {
      rmrf(fixtureRoot);
    }
  });
});
