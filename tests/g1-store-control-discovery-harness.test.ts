/**
 * G1 store-control discovery — harness and artifact-truth contract.
 *
 * US-001 establishes the disposable-probe safety harness used by every later
 * G1 story.  This test pins the contract so a future edit cannot weaken the
 * harness (for example by letting the wrapper reach the real operator home) or
 * silently drop the evidence the finding depends on.
 *
 * It spawns Python and bash, so the file is classified in the serial lane.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { tamanduaShortTempDir, tamanduaTempDir } from "../src/lib/temp-dir.ts";

const PROJECT_ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "docs", "gate"))) return cwd;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
})();

const GATE_DIR = path.join(PROJECT_ROOT, "docs", "gate");
const DOC_PATH = path.join(GATE_DIR, "G1-STORE-CONTROL-DISCOVERY.md");
const PROBES_DIR = path.join(GATE_DIR, "probes");
const READ_HEADER = path.join(PROBES_DIR, "read_header.py");
const TEST_READ_HEADER = path.join(PROBES_DIR, "test_read_header.py");
const WRAPPER = path.join(PROBES_DIR, "hermes_scratch.sh");

const PYTHON = (() => {
  const venv = "/home/kaladin/hermes-agent/venv/bin/python";
  return fs.existsSync(venv) ? venv : "python3";
})();

const scratchRoots: string[] = [];
after(() => {
  for (const root of scratchRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function scratchRoot(): string {
  // The wrapper's contract is the short literal g1-* scratch base, so use the
  // helper that deliberately creates under the short /tmp base.
  const root = tamanduaShortTempDir("g1-");
  scratchRoots.push(root);
  return root;
}

describe("G1 US-001 artifact truth", () => {
  let doc: string;

  it("document exists and has every required section", () => {
    assert.ok(fs.existsSync(DOC_PATH), `document must exist at ${DOC_PATH}`);
    doc = fs.readFileSync(DOC_PATH, "utf-8");
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
      assert.ok(doc.includes(heading), `document must contain section ${heading}`);
    }
  });

  it("records starting commit, tree, branch, date and native context", () => {
    doc = fs.readFileSync(DOC_PATH, "utf-8");
    assert.match(doc, /[Ss]tarting commit[^\n]*\b[0-9a-f]{40}\b/);
    assert.match(doc, /[Ss]tarting tree[^\n]*\b[0-9a-f]{40}\b/);
    assert.match(doc, /feature\/g1-store-control-discovery/);
    assert.match(doc, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
    assert.match(doc, /native/i);
    assert.doesNotMatch(doc, /containerized build/i);
  });

  it("records the exercised hermes/python/sqlite runtime", () => {
    doc = fs.readFileSync(DOC_PATH, "utf-8");
    assert.match(doc, /hermes --version/i);
    assert.match(doc, /__version__|vgit\.|hermes[^\n]*\d+\.\d+\.\d+/i);
    assert.match(doc, /Python 3\.\d+\.\d+/);
    assert.match(doc, /sqlite_version/i);
    assert.match(doc, /3\.\d+\.\d+/);
    assert.match(doc, /sqlite_source_id/i);
  });

  it("no analytical section is left as a placeholder", () => {
    doc = fs.readFileSync(DOC_PATH, "utf-8");
    // US-004/US-006 filled Per-Store Findings and Required vs Optional; US-007
    // filled the final Gate Implications policy, so no placeholder may remain.
    assert.doesNotMatch(doc, /\*\*PLACEHOLDER/);
    assert.match(
      doc,
      /## Gate Implications\n\n\*\*Final policy for the hermes-into-Matchlock launch gate/,
    );
  });

  it("no tracked file under src/ was modified by this story", () => {
    const result = spawnSync("git", ["status", "--porcelain", "--", "src"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
  });
});

describe("G1 US-001 header reader", () => {
  it("does not import the database module", () => {
    const source = fs.readFileSync(READ_HEADER, "utf-8");
    assert.ok(!source.includes("import sqlite3"), "header reader must not import the database module");
    assert.ok(!source.includes("from sqlite3"), "header reader must not import the database module");
  });

  it("passes its stdlib unit tests", () => {
    const result = spawnSync(PYTHON, [TEST_READ_HEADER], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
    });
    assert.equal(
      result.status,
      0,
      `header-reader unit tests failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  });
});

describe("G1 US-001 disposable-probe wrapper", () => {
  it("accepts a g1-* scratch home and prints the resolved command", () => {
    const root = scratchRoot();
    const home = path.join(root, "hermes-home");
    fs.mkdirSync(home);
    const result = spawnSync("/bin/bash", [WRAPPER, "config", "path"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HERMES_HOME: home,
        HERMES_BIN: "/bin/true",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /hermes_scratch: HERMES_HOME=/);
    assert.match(result.stderr, /hermes_scratch: exec \/bin\/true config path/);
  });

  it("refuses the real operator home before exec", () => {
    const result = spawnSync("/bin/bash", [WRAPPER, "config", "path"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HERMES_HOME: "/home/kaladin/.hermes",
        HERMES_BIN: "/bin/true",
      },
    });
    assert.equal(result.status, 64, "wrapper must exit 64 for the real operator home");
    assert.match(result.stderr, /REFUSED/);
    assert.match(result.stderr, /real operator home/);
  });

  it("refuses a non-scratch home", () => {
    const nonScratch = tamanduaTempDir("g1-notscratch-");
    scratchRoots.push(nonScratch);
    const result = spawnSync("/bin/bash", [WRAPPER, "config", "path"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HERMES_HOME: nonScratch,
        HERMES_BIN: "/bin/true",
      },
    });
    assert.equal(result.status, 64, "wrapper must reject homes outside the g1-* scratch root");
    assert.match(result.stderr, /REFUSED/);
  });

  it("refuses an unset HERMES_HOME", () => {
    const result = spawnSync("/bin/bash", [WRAPPER, "config", "path"], {
      cwd: PROJECT_ROOT,
      encoding: "utf-8",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HERMES_BIN: "/bin/true",
      },
    });
    assert.equal(result.status, 64, result.stderr);
    assert.match(result.stderr, /HERMES_HOME is not set/);
  });
});
