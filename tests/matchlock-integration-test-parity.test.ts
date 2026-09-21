/**
 * matchlock-integration-test-parity.test.ts — MTLK-INTEGRATE US-008.
 *
 * Proves the integrated tree (integration/matchlock-20260912) is a TEST-FILE
 * superset of all four Matchlock source branches, and that every contradictory
 * assertion the union had to rewrite carries a comment naming the two source
 * contracts that disagreed:
 *
 *   MTLK-PI-EXEC        feature/matchlock-pi-execution-20260909       a4afa846
 *   MTLK-HERMES-EXEC    feature/matchlock-hermes-execution-20260909   1e49abef
 *   MTLK-DSH-EXEC       feature/matchlock-dsh-execution-20260909      a9fcdafe
 *   MTLK-WORKFLOWS      feature/matchlock-workflow-parity-20260909    745acd75
 *
 * The checks read git objects (no working-tree mutation, no branch edits). This
 * file is SERIAL-LANE classified because it imports node:child_process; the
 * serial-classification guard requires its presence in tests/serial-files.txt.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

/** The four branches all started from this common base. */
const COMMON_BASE = "3e1cfe84821bf40ec60444cf11c9ee08817d479d";

const SOURCE_TIPS = [
  {
    contract: "MTLK-PI-EXEC",
    ref: "feature/matchlock-pi-execution-20260909",
    tip: "a4afa84659f9d1b75d0d5548e4ccf7b45ee74aa9",
  },
  {
    contract: "MTLK-HERMES-EXEC",
    ref: "feature/matchlock-hermes-execution-20260909",
    tip: "1e49abef518a45efdf0c61b81ca616668532acf1",
  },
  {
    contract: "MTLK-DSH-EXEC",
    ref: "feature/matchlock-dsh-execution-20260909",
    tip: "a9fcdafe4fbec79a9338ba05564c14f9b38f3cb5",
  },
  {
    contract: "MTLK-WORKFLOWS",
    ref: "feature/matchlock-workflow-parity-20260909",
    tip: "745acd75a8966f6dc71e7db179e9b1dc2f69ac96",
  },
] as const;

/**
 * The git objects the branch-delta checks need: the common base plus every source
 * tip. They are reachable only in the clone where the integration was performed
 * (and its descendants that still fetch those feature branches); a fresh clone of
 * main/HEAD has none of them, so the delta checks are non-computable there.
 */
const HISTORICAL_OBJECT_REVS: readonly string[] = [COMMON_BASE, ...SOURCE_TIPS.map((source) => source.tip)];

/** A syntactically valid object id that can never exist (the all-zero id). */
const ABSENT_OBJECT_SHA = "0000000000000000000000000000000000000000";

/**
 * Rewritten contradictory assertions. Each entry names the HEAD test title that
 * replaced the losing source assertion and the two source contracts whose
 * assertions disagreed; the file must carry a comment block naming BOTH.
 * A future rewrite must add an entry here (pinned by the dynamic lost-title
 * check below).
 */
const REWRITTEN_ASSERTIONS = [
  {
    file: "src/installer/matchlock/scheduler-matchlock.test.ts",
    title: "maps a persisted policy harness to the production invocation runner",
    contracts: ["MTLK-HERMES-EXEC", "MTLK-DSH-EXEC"],
  },
  {
    file: "src/installer/matchlock/dispatch-guard.test.ts",
    title: "advertises the supported workflow capability closure",
    contracts: ["MTLK-HERMES-EXEC", "MTLK-WORKFLOWS"],
  },
  {
    file: "src/installer/matchlock/dispatch-guard.test.ts",
    title: "REFUSES a VALID pinned policy on an UNSUPPORTED workflow (just-do-it child dispatch)",
    contracts: ["MTLK-HERMES-EXEC", "MTLK-WORKFLOWS"],
  },
  {
    file: "src/installer/agent-scheduler-matchlock.test.ts",
    title: "REFUSES a VALID pinned policy on an UNSUPPORTED workflow before any probe/findBinary/spawn",
    contracts: ["MTLK-PI-EXEC", "MTLK-WORKFLOWS"],
  },
  {
    file: "src/cli/cli.test.ts",
    title: "workflow run --matchlock <image> --hermes-as-harness --help is side-effect-free",
    contracts: ["MTLK-HERMES-EXEC", "MTLK-WORKFLOWS"],
  },
  {
    file: "src/cli/commands/workflow.test.ts",
    title: "documents --hermes-as-harness support under --matchlock with the submission-env config resolution",
    contracts: ["MTLK-HERMES-EXEC", "MTLK-DSH-EXEC"],
  },
  {
    file: "src/cli/workflow-run-args.test.ts",
    title: "allows --matchlock combined with --hermes-as-harness (hermes first)",
    contracts: ["MTLK-DSH-EXEC", "MTLK-HERMES-EXEC"],
  },
  {
    file: "src/installer/matchlock/policy.test.ts",
    title: "parse fails closed on a harness-dsh record that lacks its FROZEN submission context",
    contracts: ["MTLK-HERMES-EXEC", "MTLK-DSH-EXEC"],
  },
  {
    file: "tests/matchlock-dsh-adapter.test.ts",
    title: "decodes plain JSONL and extracts v3 usage excluding cache buckets",
    contracts: ["MTLK-DSH-EXEC", "MAIN-DSV2"],
  },
  {
    file: "src/installer/matchlock/dsh-scheduler-seam.test.ts",
    title: "attributes an integer single-count total from a confined plain v3 store (data.stream mirror EXCLUDED)",
    contracts: ["MTLK-DSH-EXEC", "MAIN-DSV2"],
  },
  {
    // DSH-PROFILE-OVERLAY US-002: the source contract mounted the WHOLE
    // effective DSH_HOME RW as one unit; the composed-home contract maps
    // durable top-level entries host RW and sources the WHOLE profiles/
    // directory from the private per-run overlay. DSH-OVERLAY-FSYNC-FIX US-003
    // rewrote it again to ONE real effective-home root (no nested destinations)
    // so the guest `$DSH_HOME` root is fsync-able (see the file comment block).
    file: "src/installer/matchlock/mount-plan.test.ts",
    title:
      "dsh mode: mounts ONE real effective-home root from the private overlay (never the host profiles farm) and sets DSH_HOME (no PI_CODING_AGENT_DIR)",
    contracts: ["MTLK-DSH-EXEC", "DSH-PROFILE-OVERLAY"],
  },
  {
    // Union4: main's NPF-1/REROUTE-BUDGET retired the unverified
    // "not-applicable" checkout label, so the shared Matchlock merge core and
    // its parity test now speak main's five-variant vocabulary.
    file: "src/installer/matchlock/merge-core.test.ts",
    title: "lands into a bare origin identically (no-checkout-to-refresh)",
    contracts: ["MTLK-WORKFLOWS", "MAIN-NPF1"],
  },
  {
    // Union4 MTLK-UNPIN: the MTLK-DSH-EXEC US-004 doc regression originally
    // pinned the accepted paired-runtime sha256 hashes and asserted REFUSAL on
    // mismatch; the unpin replaces that assertion with observed identity.
    file: "src/installer/matchlock/dsh-execution-docs.test.ts",
    title: "documents the unpinned runtime resolution and observed identity",
    contracts: ["MTLK-DSH-EXEC", "MTLK-UNPIN"],
  },
  {
    // Union4 MTLK-UNPIN: same rewrite for the production-recipe doc title.
    file: "src/installer/matchlock/dsh-execution-docs.test.ts",
    title: "documents the unpinned runtime identity",
    contracts: ["MTLK-DSH-EXEC", "MTLK-UNPIN"],
  },
  {
    // MTLK-CLEANUP US-008: the MTLK-HERMES-EXEC source contract asserted that
    // an unconfirmable close ALWAYS surfaces matchlock_cleanup_failed
    // ("cleanup-failure propagation: an unconfirmable close … never a
    // swallow"). The MTLK-PI-EXEC runner's post-harness close/dispose policy
    // (pi US-005) keeps the round and hands the VM to the reaper when the
    // harness has already exited, so the hermes assertion was rewritten to pin
    // only the BEFORE-harness fatal case (see the file comment block naming
    // both contracts).
    file: "src/installer/matchlock/hermes-invocation-runner.test.ts",
    title:
      "US-008: a close failure BEFORE the hermes harness exits remains fatal and surfaces the serialized cause",
    contracts: ["MTLK-HERMES-EXEC", "MTLK-PI-EXEC"],
  },
] as const;

/** Test-ish paths: a `*.test.ts` file or anything under a test directory. */
function isTestPath(p: string): boolean {
  return p.endsWith(".test.ts") || p.startsWith("tests/") || p.startsWith("e2e-tests/");
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: 128 * 1024 * 1024 });
}

function gitLines(args: string[]): string[] {
  return git(args)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function objectExists(rev: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", rev], { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type ObjectProbe = (rev: string) => boolean;

/**
 * Reachability gate: the subset of `revs` the `probe` cannot resolve. Pure so it
 * can be unit-tested against a fake probe; production passes `objectExists`.
 */
function unreachableObjects(revs: readonly string[], probe: ObjectProbe): string[] {
  return revs.filter((rev) => !probe(rev));
}

const missingHistoricalObjects = unreachableObjects(HISTORICAL_OBJECT_REVS, objectExists);

/**
 * `false` when every historical object is reachable (the four delta checks must
 * then execute); otherwise an explicit skip reason naming the missing objects.
 * This is a conditional skip so the checks still run in the integration clone,
 * and a fresh clone reports exactly why they cannot run there instead of failing.
 */
const historicalObjectsSkip: string | false =
  missingHistoricalObjects.length === 0
    ? false
    : `historical source-tip object(s) not reachable in this clone: ` +
      `${missingHistoricalObjects.join(", ")}; the common base and source tips exist only in the ` +
      `one-time integration clone, so the branch-delta checks are not computable here`;

function changedTestPaths(base: string, tip: string): string[] {
  return gitLines(["diff", "--name-only", base, tip, "--", "*.test.ts", "tests/", "e2e-tests/"]).filter(
    isTestPath,
  );
}

function treeTestPaths(rev: string): Set<string> {
  return new Set(gitLines(["ls-tree", "-r", "--name-only", rev]).filter(isTestPath));
}

/** `git show <rev>:<path>`, or "" when the path is absent at that revision. */
function showFile(rev: string, filePath: string): string {
  try {
    return execFileSync("git", ["show", `${rev}:${filePath}`], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      maxBuffer: 128 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

/** `it("…")` / `test("…")` titles, newline/whitespace-normalized. */
function testTitles(text: string): Set<string> {
  const titles = new Set<string>();
  const re = /\b(?:it|test)\s*\(\s*(["'`])([\s\S]*?)\1/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    titles.add(match[2].replace(/\s+/g, " ").trim());
  }
  return titles;
}

/** Maximal runs of `//` comment lines, marker-decorated whitespace stripped. */
function commentBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length > 0) {
      blocks.push(
        current
          .join("\n")
          .replace(/\/\//g, "")
          .replace(/\/\*/g, "")
          .replace(/\*\//g, "")
          .replace(/\s+/g, ""),
      );
    }
    current = [];
  };
  for (const line of text.split("\n")) {
    if (line.includes("//")) {
      current.push(line);
    } else {
      flush();
    }
  }
  flush();
  return blocks;
}

describe("MTLK-INTEGRATE test-file parity", () => {
  it(
    "has all four source tip objects available (distinct full SHAs reachable from this clone)",
    { skip: historicalObjectsSkip },
    () => {
      const seen = new Set<string>();
      for (const source of SOURCE_TIPS) {
        assert.ok(
          objectExists(source.tip),
          `${source.contract} tip ${source.tip} must be reachable for the delta enumeration`,
        );
        assert.ok(!seen.has(source.tip), `${source.contract} tip must be distinct`);
        seen.add(source.tip);
        assert.match(source.tip, /^[0-9a-f]{40}$/);
        // The symbolic ref may have been deleted in a trimmed clone; the object
        // is what the delta checks need, so a missing ref is not fatal.
        if (objectExists(source.ref)) {
          assert.equal(git(["rev-parse", source.ref]).trim(), source.tip);
        }
      }
      assert.ok(objectExists(COMMON_BASE), `common base ${COMMON_BASE} must be reachable`);
    },
  );

  it(
    "every test path changed by any of the four source branches exists on the integrated tree",
    { skip: historicalObjectsSkip },
    () => {
      const missing: string[] = [];
      let checked = 0;
      for (const source of SOURCE_TIPS) {
        const changed = changedTestPaths(COMMON_BASE, source.tip);
        assert.ok(
          changed.length > 0,
          `${source.contract} must have changed at least one test path relative to ${COMMON_BASE.slice(0, 8)}`,
        );
        for (const changedPath of changed) {
          checked += 1;
          if (!objectExists(`HEAD:${changedPath}`)) {
            missing.push(`${source.contract} -> ${changedPath}`);
          }
        }
      }
      assert.equal(missing.length, 0, `test paths absent from the integrated tree:\n${missing.join("\n")}`);
      assert.ok(checked > 0);
    },
  );

  it(
    "the integrated tree's test set is a superset of every source branch's test set",
    { skip: historicalObjectsSkip },
    () => {
      const headTestPaths = treeTestPaths("HEAD");
      const missing: string[] = [];
      for (const source of SOURCE_TIPS) {
        const tipTestPaths = treeTestPaths(source.tip);
        for (const tipPath of tipTestPaths) {
          if (!headTestPaths.has(tipPath)) missing.push(`${source.contract} -> ${tipPath}`);
        }
      }
      assert.equal(
        missing.length,
        0,
        `test files present on a source branch but absent from HEAD:\n${missing.join("\n")}`,
      );
    },
  );

  it("reachability gate: HEAD is reachable, an absent SHA is unreachable", () => {
    // The production probe: HEAD resolves in any real clone.
    assert.equal(objectExists("HEAD"), true, "HEAD must resolve");
    assert.deepEqual(unreachableObjects(["HEAD"], objectExists), []);

    // A syntactically valid but absent object id must be reported unreachable.
    assert.equal(objectExists(ABSENT_OBJECT_SHA), false, "the all-zero object id must not resolve");
    assert.deepEqual(unreachableObjects([ABSENT_OBJECT_SHA], objectExists), [ABSENT_OBJECT_SHA]);

    // The gate is a pure filter over the probe, so a missing required object
    // (and only that object) selects the conditional skip path.
    const fakeProbe: ObjectProbe = (rev) => rev === "HEAD";
    assert.deepEqual(unreachableObjects(["HEAD", ABSENT_OBJECT_SHA], fakeProbe), [ABSENT_OBJECT_SHA]);
    assert.deepEqual(unreachableObjects(HISTORICAL_OBJECT_REVS, () => true), []);
  });

  it("documents every rewritten contradictory assertion with both source contracts", () => {
    for (const entry of REWRITTEN_ASSERTIONS) {
      const text = fs.readFileSync(path.join(REPO_ROOT, entry.file), "utf-8");
      assert.ok(
        text.includes(entry.title),
        `${entry.file} must still contain the rewritten assertion title "${entry.title}"`,
      );
      const blocks = commentBlocks(text);
      const documented = blocks.some((block) =>
        entry.contracts.every((contract) => block.includes(contract.replace(/\s+/g, ""))),
      );
      assert.ok(
        documented,
        `${entry.file} must carry a comment naming BOTH source contracts ` +
          `${entry.contracts.join(" vs ")} for the rewrite of "${entry.title}"`,
      );
    }
  });

  it(
    "every branch-introduced test title absent from HEAD belongs to a documented rewrite",
    { skip: historicalObjectsSkip },
    () => {
      const documentedFiles = new Set(REWRITTEN_ASSERTIONS.map((entry) => entry.file));
      const undocumented = new Set<string>();
      for (const source of SOURCE_TIPS) {
        for (const changedPath of changedTestPaths(COMMON_BASE, source.tip)) {
          const baseTitles = testTitles(showFile(COMMON_BASE, changedPath));
          const tipTitles = testTitles(showFile(source.tip, changedPath));
          const headTitles = testTitles(showFile("HEAD", changedPath));
          for (const title of tipTitles) {
            if (baseTitles.has(title)) continue;
            if (!headTitles.has(title) && !documentedFiles.has(changedPath)) {
              undocumented.add(`${source.contract} -> ${changedPath} :: ${title}`);
            }
          }
        }
      }
      assert.equal(
        undocumented.size,
        0,
        "branch-introduced test titles disappeared without a documented rewrite " +
          "(add an entry to REWRITTEN_ASSERTIONS naming both contracts):\n" +
          [...undocumented].join("\n"),
      );
    },
  );

  it("this reconciliation test is classified in the serial lane", () => {
    const rel = path.relative(REPO_ROOT, fileURLToPath(import.meta.url));
    const serial = new Set(
      fs
        .readFileSync(path.join(REPO_ROOT, "tests", "serial-files.txt"), "utf-8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#")),
    );
    assert.ok(
      serial.has(rel),
      `${rel} imports node:child_process and must be listed in tests/serial-files.txt`,
    );
  });
});
