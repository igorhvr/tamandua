// E2.4 US-004 — resolve the `$(sentinel)` entity observed in work clones.
//
// The `$(sentinel)` subdirectory (with a canary check) is SPEC 02's documented
// HOSTILE-FILENAME PROBE (tamandua-torture-test-spec/02-fixture-projects.md ):
// a directory literally named `$(sentinel)` with `canary.py` inside. It is a
// shell-quoting torture: an unquoted repo-path interpolation in a shell script
// would EXECUTE the name as a command substitution (a real injection class).
// The canary firing means something executed the name.
//
// US-004 gathering produced EVIDENCE (see E2.4 decision note) that the entity
// in work clones is the spec'd canary, NOT an unexpanded-shell-substitution
// BUG from E2.3 provisioning:
//   * It is a DIRECTORY (file type `directory`), not a stray literal file —
//     an unexpanded `$(sentinel)` shell artifact would be a single file, not a
//     directory holding canary.py.
//   * canary.py inside it is byte-identical to fixtures-src (cmp IDENTICAL).
//   * It is COMMITTED in the golden tree (`git ls-tree -r HEAD` shows
//     `$(sentinel)/canary.py`) AND TRACKED + clean in the work clone
//     (`git ls-files`, `git status --porcelain` empty) — it arrives in every
//     work clone via ordinary `git clone`/`git checkout`, which treats the
//     literal name `$(sentinel)` as a plain git path. No shell path
//     interpolation is involved in the provisioning code path (tt-fixture-
//     provision.mjs spawns git directly), so there is no quoting to fix.
//
// This regression pins that the spec'd canary SURVIVES provisioning intact
// (present + byte-identical + still delivered via git checkout, not mangled
// into a stray untracked shell artifact) for every fixture whose golden
// carries it.
//
// Zero tokens. Writes only to temp dirs under os.tmpdir() (golden + work).
// Files only inside torture-test/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

const repoRoot = process.cwd();
const ttRoot = path.join(repoRoot, "torture-test");
const provisionCli = path.join(ttRoot, "bin", "tt-fixture-provision.mjs");
const bootstrapCli = path.join(ttRoot, "bin", "tt-golden-bootstrap.mjs");
const e24Doc = path.join(ttRoot, "impl-tasks", "E2.4-junk-probe-provisioning-contract.md");

const env = { ...process.env, TAMANDUA_TEST_GUARD: "0" };

// The `$(sentinel)` canary entry for each fixture whose GOLDEN commits it
// (verified: tt-python, tt-python@master at root; tt-poly, tt-poly-lite under
// python/). The byte-exact reference is the corresponding fixtures-src canary
// (tt-python@master's builder reuses ../tt-python source, so its canary
// reference is the shared tt-python canary).
interface SentinelSite {
  fixture: string;
  relCanary: string; // path inside the work clone
  srcRef: string; // path under fixtures-src used as byte-exact reference
  relDir: string; // the $(sentinel) directory path inside the clone
}
const SENTINEL_SITES: SentinelSite[] = [
  {
    fixture: "tt-python",
    relDir: "$(sentinel)",
    relCanary: "$(sentinel)/canary.py",
    srcRef: path.join(ttRoot, "fixtures-src", "tt-python", "$(sentinel)", "canary.py"),
  },
  {
    fixture: "tt-python@master",
    relDir: "$(sentinel)",
    relCanary: "$(sentinel)/canary.py",
    // Master variant reuses ../tt-python; no source copy of its own.
    srcRef: path.join(ttRoot, "fixtures-src", "tt-python", "$(sentinel)", "canary.py"),
  },
  {
    fixture: "tt-poly",
    relDir: path.join("python", "$(sentinel)"),
    relCanary: path.join("python", "$(sentinel)", "canary.py"),
    srcRef: path.join(ttRoot, "fixtures-src", "tt-poly", "python", "$(sentinel)", "canary.py"),
  },
  {
    fixture: "tt-poly-lite",
    relDir: path.join("python", "$(sentinel)"),
    relCanary: path.join("python", "$(sentinel)", "canary.py"),
    srcRef: path.join(ttRoot, "fixtures-src", "tt-poly-lite", "python", "$(sentinel)", "canary.py"),
  },
];

function runNode(script: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoRoot, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}
function parseVerdict(script: string, args: string[]) {
  const res = runNode(script, args);
  let json: any = null;
  try {
    json = JSON.parse((res.stdout ?? "").trim());
  } catch {
    /* keep null */
  }
  return { status: res.status, stdout: (res.stdout ?? "").trim(), json, stderr: (res.stderr ?? "").trim() };
}
function gitIn(clonePath: string, args: string[]) {
  return spawnSync("git", args, { cwd: clonePath, encoding: "utf8" });
}

let goldenDir: string;
let workDir: string;

before(function () {
  goldenDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-e24-sentinel-golden-"));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-e24-sentinel-work-"));
  for (const site of SENTINEL_SITES) {
    const res = runNode(bootstrapCli, ["--fixture", site.fixture, "--golden-dir", goldenDir]);
    assert.equal(res.status, 0, `golden bootstrap must build ${site.fixture}:\n${res.stdout}\n${res.stderr}`);
  }
});

after(() => {
  fs.rmSync(goldenDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("E2.4 US-004: $(sentinel) is the spec'd hostile-filename probe and survives provisioning", () => {
  it("AC1: the $(sentinel) entity in every work clone is a DIRECTORY (the spec'd probe), not a stray unexpanded-shell file", function () {
    this.timeout = 120_000;
    for (const site of SENTINEL_SITES) {
      const caseId = `e24-sent-${site.fixture}`;
      const { status, json } = parseVerdict(provisionCli, [
        "--fixture", site.fixture, "--case-id", caseId, "--arming", "raw",
        "--golden-dir", goldenDir, "--work-dir", workDir,
      ]);
      assert.equal(status, 0, `${site.fixture}: provision must succeed:\n${JSON.stringify(json)}`);
      assert.ok(json?.ok, `${site.fixture}: verdict must be ok`);
      const clone = path.join(workDir, caseId, site.fixture);
      const entPath = path.join(clone, site.relDir);
      assert.ok(fs.existsSync(entPath), `${site.fixture}: $(sentinel) entity must be present in the work clone`);
      const st = fs.statSync(entPath);
      assert.ok(st.isDirectory(), `${site.fixture}: $(sentinel) must be a DIRECTORY (spec'd canary dir), not a stray file — stat: ${st.isFile() ? "file" : st.isDirectory() ? "directory" : "other"}`);
      assert.ok(
        fs.existsSync(path.join(clone, site.relCanary)),
        `${site.fixture}: canary.py must be inside the $(sentinel) directory`,
      );
    }
  });

  it("AC2: the clone's canary.py is byte-identical to the fixtures-src canary (spec'd probe, not a mangled artifact)", function () {
    // Byte-identity across every sentinel site was pre-verified (same blob
    // 418dd3d0... in every golden); re-assert on the fresh provision below.
    for (const site of SENTINEL_SITES) {
      const caseId = `e24-sent-${site.fixture}`;
      const clone = path.join(workDir, caseId, site.fixture);
      const dst = fs.readFileSync(path.join(clone, site.relCanary));
      const src = fs.readFileSync(site.srcRef);
      assert.ok(dst.equals(src), `${site.fixture}: canary.py must be byte-identical to fixtures-src`);
    }
  });

  it("AC3: the canary is delivered via git checkout (TRACKED + clean) — not an untracked stray shell artifact", function () {
    for (const site of SENTINEL_SITES) {
      const caseId = `e24-sent-${site.fixture}`;
      const clone = path.join(workDir, caseId, site.fixture);
      // The canary must be a committed path in the clone (it arrives via
      // git clone/checkout, since the golden commits it). A stray
      // unexpanded-shell `$(sentinel)` would be UNTRACKED.
      const ls = gitIn(clone, ["ls-files", "--error-unmatch", site.relCanary]);
      assert.equal(ls.status, 0, `${site.fixture}: $(sentinel)/canary.py must be TRACKED in the work clone (via git checkout)`);
      // And it must be clean — no sentinel dirt in git status. If a buggy
      // provisioning step had created a stray untracked `$(sentinel)`, it
      // would show up here.
      const dirty = gitIn(clone, ["status", "--porcelain"]);
      assert.equal(dirty.status, 0);
      const lines = dirty.stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
      for (const l of lines) {
        assert.ok(!l.includes("$(sentinel)"), `${site.fixture}: $(sentinel) must be clean (no dirt), got status line: ${l}`);
      }
    }
  });

  it("AC4: the E2.4 decision note records the concluding classification (spec'd probe, not a bug) with evidence", function () {
    const doc = fs.readFileSync(e24Doc, "utf8");
    // The decision note must (1) mark US-004 DONE, (2) conclude the SPEC'D
    // hostle-filename probe branch, and (3) explicitly reject the
    // unexpanded-shell-substitution BUG reading.
    assert.ok(doc.includes("US-004 (DONE)"), "decision note must mark US-004 DONE");
    assert.ok(
      doc.toUpperCase().includes("SPEC'D HOSTILE-FILENAME PROBE"),
      "decision note must conclude spec'd hostile-filename probe (not a bug)",
    );
    assert.ok(
      doc.includes("NOT an unexpanded-shell-substitution BUG"),
      "decision note must explicitly reject the unexpanded-shell-substitution BUG reading",
    );
  });
});
