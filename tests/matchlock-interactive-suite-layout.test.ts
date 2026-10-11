/**
 * MTLK-INTERACTIVE-SUITE US-001/US-011 — suite layout + entrypoint contract.
 *
 * Pins the in-repo home for the four-command interactive acceptance suite under
 * the approved tamandua-79t placement (`scripts/tests/matchlock/`), WITHOUT
 * touching the existing root runners:
 *
 *   - the suite directory and its subdirectories exist;
 *   - `scripts/tests/matchlock/README.md` carries an explicit membership table
 *     that is BIDIRECTIONAL: every suite script has exactly one row and every
 *     row names an existing file;
 *   - the README states the shared "SLOW REAL-VM GATE — DO NOT RUN BY DEFAULT"
 *     convention and the on-demand rule;
 *   - `AGENTS.md` carries the `Matchlock interactive acceptance suite
 *     (MTLK-INTERACTIVE-SUITE)` pointer at the README;
 *   - the one-command entrypoint lives under `scripts/tests/matchlock/` (never a
 *     new root runner), creates a fresh `mktemp -d` evidence dir, installs the
 *     private `HOME`/`TMPDIR`/`TAMANDUA_STATE_DIR`, takes the shared gate lock
 *     exactly once for VM tiers, and invokes the no-fake-green observed-rounds
 *     guard (exit 92) AFTER the VM tier;
 *   - `t1-fixtures.sh` is the no-VM T1 runner over the three T1 controls.
 *
 * Pure filesystem reads (no child_process, no dist import, no daemon, no VM, no
 * network), so this file stays in the parallel lane and needs no
 * tests/serial-files.txt entry.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const suiteDir = path.join(repoRoot, "scripts", "tests", "matchlock");
const readmePath = path.join(suiteDir, "README.md");
const agentsPath = path.join(repoRoot, "AGENTS.md");
const entrypointPath = path.join(suiteDir, "run-interactive-suite.sh");
const t1FixturesPath = path.join(suiteDir, "t1-fixtures.sh");

/** Every script the suite membership table must name, exactly once. */
const MEMBERSHIP_PATHS = [
  "README.md",
  "run-interactive-suite.sh",
  "t1-fixtures.sh",
  "lib/common.sh",
  "lib/manifest.sh",
  "lib/image-store.sh",
  "lib/lock.sh",
  "runner/pty-drive.py",
  "runner/pty-selftest.sh",
  "runner/run-case.sh",
  "runner/run-cases.sh",
  "runner/hygiene.sh",
  "runner/m7-spot-run.sh",
  "fixtures/fixtures-test.sh",
  "fixtures/fixtures-validator.sh",
  "validator/validate-receipts.sh",
] as const;

/** Subdirectories the suite layout must provide. */
const SUITE_SUBDIRS = ["lib", "runner", "fixtures", "validator", "cases"] as const;

function readSuiteReadme(): string {
  assert.ok(existsSync(readmePath), `suite README is missing at ${readmePath}`);
  return readFileSync(readmePath, "utf-8");
}

/** The `## Membership` section of the README (the authoritative table). */
function membershipSection(doc: string): string {
  const marker = "\n## Membership";
  const start = doc.indexOf(marker);
  assert.ok(start >= 0, "README must carry a `## Membership` section");
  return doc.slice(start);
}

/** Data rows of the membership table (no header/separator rows). */
function membershipRows(doc: string): string[] {
  const rows: string[] = [];
  for (const line of membershipSection(doc).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue; // separator row
    if (rowPath(trimmed) === null) continue; // header row (no backticked path)
    rows.push(trimmed);
  }
  return rows;
}

/** The first backticked token of a membership row (the script path). */
function rowPath(row: string): string | null {
  const match = row.match(/^\|\s*`([^`]+)`/);
  return match ? match[1] : null;
}

/**
 * Every script that belongs to the suite, discovered from the tree: shell and
 * Python scripts plus the README index. Case data (`cases/*.json`), `.gitkeep`
 * markers, bytecode caches and non-index markdown (e.g. the port report) are
 * deliberately not scripts.
 */
function discoverSuiteScripts(): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__pycache__") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name === ".gitkeep" || entry.name.endsWith(".pyc")) continue;
      if (
        entry.name === "README.md" ||
        entry.name.endsWith(".sh") ||
        entry.name.endsWith(".py")
      ) {
        out.push(childRel);
      }
    }
  };
  walk(suiteDir, "");
  return out.sort();
}

describe("Matchlock interactive acceptance suite layout (MTLK-INTERACTIVE-SUITE US-001)", () => {
  it("provides the suite directory, its subdirectories and the index README", () => {
    assert.ok(statSync(suiteDir).isDirectory(), `missing suite directory ${suiteDir}`);
    for (const sub of SUITE_SUBDIRS) {
      const dir = path.join(suiteDir, sub);
      assert.ok(existsSync(dir), `missing suite subdirectory ${sub}`);
      assert.ok(statSync(dir).isDirectory(), `${sub} is not a directory`);
    }
    assert.ok(existsSync(readmePath), `missing suite README ${readmePath}`);
    assert.ok(statSync(readmePath).isFile(), "suite README is not a file");
  });

  it("carries an explicit membership table naming every suite script", () => {
    const doc = readSuiteReadme();
    const rows = membershipRows(doc);
    assert.ok(rows.length > 0, "README must carry a markdown membership table");

    for (const member of MEMBERSHIP_PATHS) {
      const token = `\`${member}\``;
      const matching = rows.filter((row) => row.includes(token));
      assert.equal(
        matching.length,
        1,
        `membership table must name \`${member}\` exactly once (found ${matching.length})`,
      );
    }
  });

  it("has BIDIRECTIONAL membership: every suite script has one row and every row names an existing file", () => {
    const doc = readSuiteReadme();
    const rows = membershipRows(doc);
    const paths = rows.map(rowPath);
    assert.ok(
      paths.every((p): p is string => p !== null),
      "every membership row must start with a backticked path",
    );
    const rowed = paths as string[];

    // No duplicate rows.
    assert.equal(
      new Set(rowed).size,
      rowed.length,
      `membership table must not name the same path twice (${rowed.join(", ")})`,
    );

    // Every discovered script has exactly one row.
    const scripts = discoverSuiteScripts();
    for (const script of scripts) {
      const matches = rowed.filter((p) => p === script);
      assert.equal(
        matches.length,
        1,
        `suite script \`${script}\` must have exactly one membership row (found ${matches.length})`,
      );
    }

    // Every row names an existing file, and the two sets are exactly equal.
    for (const p of rowed) {
      assert.ok(
        existsSync(path.join(suiteDir, p)),
        `membership row names a missing file: \`${p}\``,
      );
    }
    assert.deepEqual(
      [...rowed].sort(),
      scripts,
      "the membership table and the suite script tree must agree exactly",
    );
  });

  it("states the do-not-run-by-default convention and the on-demand rule", () => {
    const doc = readSuiteReadme();
    assert.match(doc, /SLOW REAL-VM GATE\s*[—-]\s*DO NOT RUN BY DEFAULT/);
    assert.match(doc, /on demand/i);
    assert.match(doc, /npm test/i);
  });

  it("documents the one-command entrypoint", () => {
    const doc = readSuiteReadme();
    assert.ok(
      doc.includes("scripts/tests/matchlock/run-interactive-suite.sh"),
      "README must name the one-command entrypoint path",
    );
    assert.match(doc, /--tier/);
    assert.match(doc, /--mode/);
    assert.match(doc, /--expect-digest/);
  });

  it("documents the exact one-command invocations and the tier/model/token disclosure", () => {
    const doc = readSuiteReadme();
    // The exact one-command invocations, per tier and per mode.
    for (const invocation of [
      "--tier t1 --mode installed",
      "--tier t2 --mode installed",
      "--tier t3 --mode installed",
      "--tier t4 --mode installed",
      "--tier t2 --tier t3 --mode candidate",
    ]) {
      assert.ok(doc.includes(invocation), `README must document the invocation ${invocation}`);
    }
    assert.match(
      doc,
      /--expect-digest sha256:/,
      "the VM-tier invocations must show the required expected-digest input",
    );
    // The T3 credential gate and the token-spend disclosure.
    assert.match(doc, /MTLK_T3_ENABLED=1/, "T3 must document the enable flag");
    assert.match(doc, /OPENAI_API_KEY/, "T3 must name a credential variable");
    assert.match(doc, /Tier \/ model \/ token disclosure/, "README must carry the disclosure table");
    assert.match(
      doc,
      /TOKEN-SPEND-DISCLOSURE tier=t3/,
      "README must document the token-spend disclosure line",
    );
    assert.match(doc, /billed to the operator/i, "README must disclose who pays the tokens");
    // One-layer gate lock: the entrypoint acquires it, callers must not nest.
    assert.match(doc, /gate lock/i);
    assert.match(
      doc,
      /do NOT wrap this call in another `flock`/i,
      "README must warn callers not to nest the gate lock",
    );
  });

  it("points AGENTS.md at the suite README", () => {
    const agents = readFileSync(agentsPath, "utf-8");
    assert.match(agents, /### Matchlock interactive acceptance suite \(MTLK-INTERACTIVE-SUITE\)/);
    assert.ok(
      agents.includes("scripts/tests/matchlock/README.md"),
      "AGENTS.md must point at scripts/tests/matchlock/README.md",
    );
  });

  it("adds no run-*interactive* runner at the repository root", () => {
    const entries = readdirSync(repoRoot);
    const offenders = entries.filter((name) => /^run-.*interactive/i.test(name));
    assert.deepEqual(
      offenders,
      [],
      `the suite must not add a root-level run-*interactive* runner (found: ${offenders.join(", ")})`,
    );
  });
});

describe("Matchlock interactive entrypoint wiring (MTLK-INTERACTIVE-SUITE US-011)", () => {
  function readEntrypoint(): string {
    assert.ok(existsSync(entrypointPath), `missing entrypoint ${entrypointPath}`);
    return readFileSync(entrypointPath, "utf-8");
  }

  it("lives under scripts/tests/matchlock and documents the one-command usage", () => {
    assert.ok(statSync(entrypointPath).isFile(), "entrypoint is not a regular file");
    assert.ok(
      !existsSync(path.join(repoRoot, path.basename(entrypointPath))),
      "the entrypoint must not also live at the repository root",
    );
    const text = readEntrypoint();
    for (const flag of ["--tier", "--mode", "--expect-digest", "--evidence-dir"]) {
      assert.ok(text.includes(flag), `entrypoint must accept ${flag}`);
    }
  });

  it("creates a fresh mktemp -d evidence dir and refuses a reused one", () => {
    const text = readEntrypoint();
    assert.match(text, /mktemp -d/, "the entrypoint must create a fresh mktemp -d evidence dir");
    assert.match(
      text,
      /evidence-dir-not-fresh/,
      "the entrypoint must refuse an evidence dir that already holds a receipt",
    );
  });

  it("installs private HOME/TMPDIR/TAMANDUA_STATE_DIR and the seeded private image store", () => {
    const text = readEntrypoint();
    assert.match(text, /export HOME="\$EV\/home"/, "private HOME must be installed");
    assert.match(text, /export TMPDIR="\$EV\/tmp"/, "private TMPDIR must be installed");
    assert.match(
      text,
      /export TAMANDUA_STATE_DIR="\$EV\/state"/,
      "private TAMANDUA_STATE_DIR must be installed",
    );
    assert.ok(text.includes("mtlk_image_store_seed"), "the private image store must be seeded");
  });

  it("takes the shared gate lock exactly once and only via lib/lock.sh", () => {
    const text = readEntrypoint();
    const acquire = text.match(/mtlk_gate_lock_acquire/g) ?? [];
    assert.equal(acquire.length, 1, "the entrypoint must acquire the gate lock exactly once");
    assert.doesNotMatch(text, /\bflock\b/, "the entrypoint must not call flock directly");
    assert.ok(text.includes("lib/lock.sh"), "the lock helper must be sourced");
  });

  it("invokes the observed-rounds guard AFTER the VM tier and exits 92 on zero rounds", () => {
    const text = readEntrypoint();
    const iRunCases = text.indexOf('bash "$RUN_CASES_SH"');
    const iGuard = text.indexOf('node "$ROUNDS_GUARD" --dir "$EV" --gate interactive');
    assert.ok(iRunCases >= 0, "the entrypoint must run run-cases.sh for VM tiers");
    assert.ok(iGuard >= 0, "the entrypoint must invoke the observed-rounds guard");
    assert.ok(iRunCases < iGuard, "the guard must run AFTER the VM tier");
    assert.ok(
      text.includes("$MTLK_REPO_ROOT/scripts/observed-rounds-guard.mjs"),
      "the guard must default to the shared scripts/observed-rounds-guard.mjs",
    );
    assert.match(text, /exit 92/, "a zero-round refusal must exit 92");
  });

  it("routes T1 to the no-VM runner and pins the entrypoint's private state", () => {
    const text = readEntrypoint();
    assert.ok(text.includes('bash "$T1_FIXTURES_SH" "$EV"'), "T1 must run t1-fixtures.sh");
  });
});

describe("Matchlock T1 no-VM runner (MTLK-INTERACTIVE-SUITE US-011)", () => {
  it("runs the three T1 controls and fails nonzero on any fail", () => {
    assert.ok(existsSync(t1FixturesPath), `missing T1 runner ${t1FixturesPath}`);
    const text = readFileSync(t1FixturesPath, "utf-8");
    assert.ok(text.includes("runner/pty-selftest.sh") || text.includes("pty-selftest.sh"));
    assert.ok(text.includes("fixtures/fixtures-test.sh") || text.includes("fixtures-test.sh"));
    assert.ok(
      text.includes("fixtures/fixtures-validator.sh") || text.includes("fixtures-validator.sh"),
    );
    assert.match(text, /T1 FIXTURES RESULT: pass=/);
    assert.doesNotMatch(text, /\bflock\b/, "the no-VM T1 runner must take no gate lock");
    assert.match(text, /exit 1/, "T1 must exit nonzero on any fail");
  });
});
