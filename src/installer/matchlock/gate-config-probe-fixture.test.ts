/**
 * Host-side fixture test for the PACKED guest config probe
 * (G8 ADMISSION-INTEGRATION US-010, bead tamandua-7p5.1.8).
 *
 * The probe helper ships inside the read-only guest helper pack and is executed
 * with `node` inside the VM. This file runs the SAME compiled artifact with the
 * same `node` binary against real temp profiles on the host — no VM, no RPC, no
 * daemon — so the helper's contract (`one bounded JSON line per store`, exit 0,
 * read-only) is exercised for real and not just through an injected seam.
 *
 * What is pinned:
 *
 *  - `delete` in `config.yaml` is measured as `delete` (including the quoted and
 *    upper-case spellings the stock resolver accepts);
 *  - a missing/empty/absent `journal_mode` leaf falls back to `wal` (the stock
 *    start value), and an unrecognised value fails SAFE to `wal` — the helper
 *    can never invent `delete`;
 *  - the managed layer wins per leaf (managed `wal` over a user `delete`), and
 *    the layer can be disabled explicitly for determinism;
 *  - an unparseable document (flow-style mapping, YAML sequence) is reported as
 *    `journalMode: "unreadable"` with `readable: false` — never as a pass;
 *  - every line carries exactly `{store, journalMode, source, readable}`, the
 *    `source` text is `guest-observed:` prefixed (so it can never be mistaken
 *    for the host observation) and bounded, and the helper writes NOTHING to the
 *    profile it reads;
 *  - a request with no store paths exits non-zero with a bounded stderr line
 *    (the host records that as `unmeasured`).
 *
 * LANE. This file spawns `node`, so it MUST be registered in
 * `tests/serial-files.txt` (asserted here, and enforced by
 * `tests/serial-classification-guard.test.ts`).
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tamanduaShortTempDir } from "../../../dist/lib/temp-dir.js";
import { GUEST_CONFIG_PROBE_MAX_SOURCE_CHARS } from "../../../dist/installer/matchlock/gate-config-probe.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const HELPER = path.join(REPO_ROOT, "dist", "installer", "matchlock", "gate-config-probe.js");
const SERIAL_FILES = path.join(REPO_ROOT, "tests", "serial-files.txt");

/** The one line shape the helper promises. */
const PROBE_KEYS = ["store", "journalMode", "source", "readable"];

const roots: string[] = [];

function makeRoot(): string {
  const dir = tamanduaShortTempDir("gate-probe-fixture-");
  roots.push(dir);
  return dir;
}

after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface ProbeRun {
  status: number | null;
  stdout: string;
  stderr: string;
  lines: Array<Record<string, unknown>>;
}

/** Run the compiled helper exactly as the guest runs it. */
function runProbe(request: unknown, helperPath = HELPER): ProbeRun {
  assert.ok(fs.existsSync(helperPath), `build first: ${helperPath} is missing`);
  const result = spawnSync(process.execPath, [helperPath, "--", JSON.stringify(request)], {
    encoding: "utf8",
    timeout: 30000,
  });
  const stdout = result.stdout ?? "";
  const lines: Array<Record<string, unknown>> = [];
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    lines.push(JSON.parse(line) as Record<string, unknown>);
  }
  return { status: result.status, stdout, stderr: result.stderr ?? "", lines };
}

/** A profile fixture directory holding an optional config.yaml body. */
function profile(root: string, name: string, body: string | null): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (body !== null) fs.writeFileSync(path.join(dir, "config.yaml"), body, "utf8");
  return dir;
}

describe("packed guest config probe — host-side fixture run", () => {
  it("measures delete, quoted delete and upper-case DELETE as delete", () => {
    const root = makeRoot();
    const cases: Array<[string, string]> = [
      ["plain", "database:\n  journal_mode: delete\n"],
      ["quoted", 'database:\n  journal_mode: "delete"\n'],
      ["padded", "database:\n  journal_mode:   DELETE  # the writer honours this\n"],
      ["nested-indent", "database:\n    journal_mode: delete\nsupervisor:\n  x: 1\n"],
    ];
    for (const [name, body] of cases) {
      const home = profile(root, name, body);
      const run = runProbe({
        hermesHome: home,
        stores: [`${home}/state.db`],
        managedDir: null,
      });
      assert.equal(run.status, 0, `${name}: ${run.stderr}`);
      assert.equal(run.lines.length, 1, name);
      assert.equal(run.lines[0].journalMode, "delete", `${name}: ${JSON.stringify(run.lines[0])}`);
      assert.equal(run.lines[0].readable, true, name);
    }
  });

  it("falls back to wal for an absent leaf and never invents delete from an unknown value", () => {
    const root = makeRoot();
    const cases: Array<[string, string | null]> = [
      ["no-file", null],
      ["empty", ""],
      ["no-database", "model:\n  name: x\n"],
      ["no-journal-mode", "database:\n  busy_timeout: 5\n"],
      ["null-value", "database:\n  journal_mode:\n"],
      ["truncate", "database:\n  journal_mode: truncate\n"],
      ["numeric", "database:\n  journal_mode: 7\n"],
    ];
    for (const [name, body] of cases) {
      const home = profile(root, name, body);
      const run = runProbe({ hermesHome: home, stores: [`${home}/state.db`], managedDir: null });
      assert.equal(run.status, 0, `${name}: ${run.stderr}`);
      assert.equal(run.lines[0].journalMode, "wal", `${name}: ${JSON.stringify(run.lines[0])}`);
      assert.equal(run.lines[0].readable, true, name);
    }
  });

  it("applies the managed layer LAST (managed wal wins over a user delete)", () => {
    const root = makeRoot();
    const home = profile(root, "prof", "database:\n  journal_mode: delete\n");
    const managed = profile(root, "managed", "database:\n  journal_mode: wal\n");

    const withManaged = runProbe({
      hermesHome: home,
      stores: [`${home}/state.db`],
      managedDir: managed,
    });
    assert.equal(withManaged.lines[0].journalMode, "wal", JSON.stringify(withManaged.lines[0]));
    assert.match(String(withManaged.lines[0].source), /managed layer wins per leaf/);

    // And the managed layer can be removed explicitly (deterministic fixtures).
    const withoutManaged = runProbe({
      hermesHome: home,
      stores: [`${home}/state.db`],
      managedDir: null,
    });
    assert.equal(withoutManaged.lines[0].journalMode, "delete");
    assert.match(String(withoutManaged.lines[0].source), /managed scope: none/);
  });

  it("reports an unparseable document as unreadable/readable:false — never as delete", () => {
    const root = makeRoot();
    const cases: Array<[string, string]> = [
      ["flow-style", "database: {journal_mode: delete}\n"],
      ["sequence", "- database\n- journal_mode: delete\n"],
      ["tab-indented", "database:\n\tjournal_mode: delete\n"],
    ];
    for (const [name, body] of cases) {
      const home = profile(root, name, body);
      const run = runProbe({ hermesHome: home, stores: [`${home}/state.db`], managedDir: null });
      assert.equal(run.status, 0, `${name}: ${run.stderr}`);
      assert.equal(run.lines[0].journalMode, "unreadable", `${name}: ${JSON.stringify(run.lines[0])}`);
      assert.equal(run.lines[0].readable, false, name);
      assert.equal(String(run.lines[0].journalMode) === "delete", false, name);
    }
  });

  it("emits exactly one bounded, guest-prefixed line per requested store and writes nothing", () => {
    const root = makeRoot();
    const home = profile(root, "prof", "database:\n  journal_mode: delete\n");
    const stores = [`${home}/state.db`, `${home}/state.db-wal`, `${home}/alt.db`];

    const before = fs.readdirSync(home, { withFileTypes: true }).map((entry) => entry.name).sort();
    const configBefore = fs.readFileSync(path.join(home, "config.yaml"), "utf8");
    const configStatBefore = fs.statSync(path.join(home, "config.yaml")).mtimeMs;

    const run = runProbe({ hermesHome: home, stores, managedDir: null });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.lines.length, stores.length);
    assert.deepEqual(
      run.lines.map((line) => line.store),
      stores,
      "every requested store is attributed, in request order",
    );
    for (const line of run.lines) {
      assert.deepEqual(Object.keys(line), PROBE_KEYS, "the emitted line has exactly the documented keys");
      assert.equal(line.journalMode, "delete");
      assert.equal(line.readable, true);
      assert.match(String(line.source), /^guest-observed: /);
      assert.ok(
        String(line.source).length <= GUEST_CONFIG_PROBE_MAX_SOURCE_CHARS + 3,
        "the source text is bounded",
      );
      assert.equal(String(line.source).includes("host-observed"), false);
    }

    // Read-only: the directory listing, the config body and its mtime are intact.
    const after = fs.readdirSync(home, { withFileTypes: true }).map((entry) => entry.name).sort();
    assert.deepEqual(after, before, "the probe created and removed nothing");
    assert.equal(fs.readFileSync(path.join(home, "config.yaml"), "utf8"), configBefore);
    assert.equal(fs.statSync(path.join(home, "config.yaml")).mtimeMs, configStatBefore);
  });

  it("exits non-zero with a bounded stderr line when no store path is supplied", () => {
    const root = makeRoot();
    const home = profile(root, "prof", "database:\n  journal_mode: delete\n");
    const run = runProbe({ hermesHome: home, stores: [], managedDir: null });

    assert.notEqual(run.status, 0, "an unusable invocation is not a success");
    assert.equal(run.lines.length, 0);
    assert.match(run.stderr, /no store paths/);
  });

  it("is registered in the serial lane (it spawns node)", () => {
    const serial = fs
      .readFileSync(SERIAL_FILES, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    assert.ok(
      serial.includes("src/installer/matchlock/gate-config-probe-fixture.test.ts"),
      "a spawn-capable test file must be listed in tests/serial-files.txt",
    );
  });
});
