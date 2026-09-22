/**
 * MATCHLOCK-UNION-4 US-004 — the merged documentation carries BOTH lineages
 * exactly once, with no duplicated sections and no conflict scars.
 *
 * The union (`c0ae3833`) merged `refs/remotes/src/matchlock` (434771eb) into the
 * main-based branch (5d307302). Where both sides edited the same doc, the rule
 * is "the newer main abstraction wins, Matchlock is adapted to it" — except
 * where the Matchlock side is the only carrier of a documented feature, in
 * which case it must survive. This suite pins the resulting doc set so a future
 * merge cannot silently drop a lineage or leave a duplicated section behind.
 *
 * It is a pure filesystem read (no `dist` import, no `child_process`, no daemon,
 * no VM, no network), so it stays in the PARALLEL lane and needs no
 * `tests/serial-files.txt` entry.
 *
 * The two lineages this pins:
 *   MAIN   instants / TIME-CLOCKS / monotonic clocks, kernel identity (DPID),
 *          state-dir scoping, worker-pid claims, direct-mode post-grace sweep,
 *          paused-kill accounting, commit identity/signing, reroute budget
 *          (`target_moved_reroute_count`), `workdir_collision_policy`, bounded
 *          `lsof`, atomic event appends, schema v12 (`preclaim_death_count`;
 *          the union port renumbers the combined chain to v13 with
 *          `runs.matchlock_policy`).
 *   MTLK   the Matchlock runner/mount plans/guest suite transport,
 *          `matchlock_policy`, capability admission, the real-VM gates and the
 *          dsh qualification recipe.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");

const UNION_DOCS = [
  "AGENTS.md",
  "README.md",
  "skills/tamandua-agents/SKILL.md",
  "tests/MOTOR-CONTRACT.md",
  "docs/creating-workflows.md",
  "docs/native-signal-isolation.md",
  "docs/matchlock-dsh-qualification.md",
] as const;

function readDoc(relPath: string): string {
  const abs = resolve(repoRoot, relPath);
  assert.ok(existsSync(abs), `${relPath} must exist on the merged tree`);
  const content = readFileSync(abs, "utf-8");
  assert.ok(content.trim().length > 0, `${relPath} must not be empty`);
  return content;
}

const docs = new Map<string, string>(UNION_DOCS.map((p) => [p, readDoc(p)]));

function doc(relPath: string): string {
  const content = docs.get(relPath);
  assert.ok(content !== undefined, `unexpected doc ${relPath}`);
  return content!;
}

/** Every markdown heading line, verbatim. */
function headings(content: string): string[] {
  return content.split(/\r?\n/).filter((line) => /^#{1,6}\s+\S/.test(line));
}

/**
 * Table blocks (consecutive `|` rows). Returns each block as an array of raw
 * rows, so duplicate-row detection can be scoped to a single table (repeated
 * header rows across different tables are legitimate).
 */
function tableBlocks(content: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\|/.test(line)) {
      current.push(line.trim());
    } else if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function isSeparatorRow(row: string): boolean {
  return /^\|[\s:|-]+\|$/.test(row) && row.includes("-");
}

describe("US-004 union docs: integrity of the merged documentation", () => {
  it("carries all seven union docs on the merged tree", () => {
    for (const relPath of UNION_DOCS) {
      assert.ok(doc(relPath).length > 0, `${relPath} must be non-empty`);
    }
  });

  it("contains no merge conflict markers in any union doc", () => {
    for (const relPath of UNION_DOCS) {
      const lines = doc(relPath).split(/\r?\n/);
      for (const line of lines) {
        assert.doesNotMatch(
          line,
          /^(<{7}|={7}|>{7})(\s|$)/,
          `${relPath} must not contain a conflict marker: ${line}`,
        );
      }
    }
  });

  it("has no duplicated section heading in any union doc", () => {
    for (const relPath of UNION_DOCS) {
      const seen = new Map<string, number>();
      for (const heading of headings(doc(relPath))) {
        seen.set(heading, (seen.get(heading) ?? 0) + 1);
      }
      const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([h]) => h);
      assert.deepEqual(
        duplicates,
        [],
        `${relPath} has duplicated section headings (the union must document each section once): ${duplicates.join(", ")}`,
      );
    }
  });

  it("has no duplicated table row inside any single table", () => {
    for (const relPath of UNION_DOCS) {
      for (const block of tableBlocks(doc(relPath))) {
        const dataRows = block.filter((row) => !isSeparatorRow(row));
        // The first row of a table is its header; only data rows are compared,
        // so two tables may legitimately share the same header row.
        const body = dataRows.slice(1);
        const seen = new Set<string>();
        for (const row of body) {
          assert.ok(
            !seen.has(row),
            `${relPath} has a duplicated table row: ${row}`,
          );
          seen.add(row);
        }
      }
    }
  });
});

describe("US-004 union docs: the main lineage is documented once", () => {
  const agents = doc("AGENTS.md");
  const motor = doc("tests/MOTOR-CONTRACT.md");
  const readme = doc("README.md");
  const creating = doc("docs/creating-workflows.md");
  const signal = doc("docs/native-signal-isolation.md");

  it("AGENTS.md documents the instant / TIME-CLOCKS / monotonic-clock contract", () => {
    for (const token of [
      "nowIso",
      "parseInstant",
      "SQL_NOW_ISO",
      "instantAgeMs",
      "isOlderThan",
      "monotonicNow",
      "src/lib/instant.ts",
    ]) {
      assert.ok(agents.includes(token), `AGENTS.md must document ${token}`);
    }
  });

  it("AGENTS.md documents kernel identity, worker-pid claims and DPID state-dir scoping", () => {
    assert.ok(agents.includes("Service identity sockets (DPID)"), "DPID kernel identity section");
    assert.ok(agents.includes("TAMANDUA_WORKER_PID"), "worker-pid claim semantics");
    assert.ok(agents.includes("claim_pid"), "claim_pid recording");
  });

  it("AGENTS.md documents the direct-mode sweep, paused-kill and reroute budget", () => {
    assert.ok(agents.includes("runPostGraceSweep"), "direct-mode post-grace sweep");
    assert.ok(agents.includes("step.paused_kill"), "paused-kill accounting");
    assert.ok(agents.includes("target_moved_reroute_count"), "reroute budget class counter");
    assert.ok(agents.includes("workdir_collision_policy"), "workdir collision policy flags");
  });

  it("AGENTS.md keeps the bounded-lsof and atomic-event sections", () => {
    assert.ok(agents.includes("Bounded process introspection"), "bounded lsof section");
    assert.ok(agents.includes("Event log atomic appends"), "atomic event append section");
  });

  it("MOTOR-CONTRACT.md keeps the newer main invariants (TIME-CLOCKS, PKIL, DSWP)", () => {
    for (const token of [
      "Timing model (TIME-CLOCKS)",
      "C24 (PKIL — operator-pause recovery never charges a retry)",
      "C25 (PKIL — the scheduler classifies an operator-paused round as a pause)",
      "sweepRunProcesses",
      "TAMANDUA_DAEMON_PID",
    ]) {
      assert.ok(motor.includes(token), `tests/MOTOR-CONTRACT.md must keep ${token}`);
    }
  });

  it("MOTOR-CONTRACT.md never regresses to the pre-CPID2 worker-pid self-stop guard", () => {
    assert.doesNotMatch(
      motor,
      /refuse to signal the daemon named by TAMANDUA_WORKER_PID/,
      "the self-stop guard must name TAMANDUA_DAEMON_PID, not the worker pid",
    );
  });

  it("docs/creating-workflows.md keeps the target-moved budget rules", () => {
    assert.ok(creating.includes("max_target_moved_reroutes"), "target-moved budget documented");
    assert.ok(creating.includes("target_moved_reroute_count"), "class-specific counter documented");
  });

  it("docs/native-signal-isolation.md keeps main's once-per-run fallback accounting", () => {
    assert.ok(
      signal.includes("once per run per daemon start"),
      "main's once-per-run fallback rule must survive over the older Matchlock copy",
    );
    assert.ok(signal.includes("unprotected-fallback"), "fallback mode documented");
  });

  it("README.md keeps the workdir-queue admission and bounded logs surfaces", () => {
    assert.ok(readme.includes("TAMANDUA_ALLOW_SHARED_HARNESS_WORKDIR"), "workdir queue/allow flag");
    assert.match(readme, /--tail <N>/, "bounded logs --tail surface");
  });
});

describe("US-004 union docs: the Matchlock lineage is documented once", () => {
  const agents = doc("AGENTS.md");
  const readme = doc("README.md");
  const skill = doc("skills/tamandua-agents/SKILL.md");
  const qualification = doc("docs/matchlock-dsh-qualification.md");

  it("AGENTS.md documents the Matchlock runner seams and matchlock_policy", () => {
    for (const token of [
      "Shared merge pure core (US-005)",
      "Capability admission + exact linked-worktree wiring (US-008)",
      "matchlock_policy",
      "GuestSuiteNamespace",
      "mount-plan.ts",
      "guest-bridge",
    ]) {
      assert.ok(agents.includes(token), `AGENTS.md must document ${token}`);
    }
  });

  it("README.md carries exactly one Matchlock execution section", () => {
    const matches = readme.match(/^#{1,6}\s+Matchlock Execution/gm) ?? [];
    assert.equal(matches.length, 1, "README must carry exactly one Matchlock Execution section");
    assert.ok(readme.includes("--matchlock"), "--matchlock flag documented");
    assert.match(readme, /Synthetic whole-path gates/, "the synthetic whole-path gates documented");
  });

  it("SKILL.md documents hermes and dsh under Matchlock", () => {
    assert.match(skill, /#### Hermes under Matchlock/, "hermes-under-Matchlock section");
    assert.match(skill, /#### dsh under Matchlock/, "dsh-under-Matchlock section");
    // The per-harness binary-resolution subsections are unique (no duplicated
    // heading) — the dsh copies are namespace-qualified.
    assert.match(skill, /#### dsh Absolute-Path Invocation/, "dsh-namespaced absolute-path heading");
    assert.match(skill, /#### dsh Child-Only PATH Adjustment/, "dsh-namespaced PATH heading");
    assert.match(skill, /#### dsh Zero Filesystem Mutation/, "dsh-namespaced no-mutation heading");
  });

  it("docs/matchlock-dsh-qualification.md records the recipe and its gate", () => {
    assert.match(qualification, /Matchlock dsh Production Qualification Recipe/);
    assert.match(qualification, /matchlock-dsh-profile-overlay-gate\.test\.ts/);
    assert.match(qualification, /Synthetic whole-path gate/);
  });
});

describe("US-004 union docs: the single v14 schema chain", () => {
  const agents = doc("AGENTS.md");

  it("AGENTS.md documents the ONE 9->10->11->12->13->14 chain", () => {
    for (const token of [
      "SCHEMA_VERSION = 14",
      "v9 -> v10",
      "v10 -> v11",
      "v11 -> v12",
      "v12 -> v13",
      "v13 -> v14",
      "migrateInstantsToIsoZ()",
      "steps.target_moved_reroute_count",
      "steps.preclaim_death_count",
      "runs.matchlock_policy",
      "suite_results.log_path",
    ]) {
      assert.ok(agents.includes(token), `AGENTS.md schema history must mention ${token}`);
    }
  });

  it("AGENTS.md documents the lineage detector and every legacy starting state", () => {
    assert.ok(agents.includes("v10 MAIN"), "v10 MAIN lineage documented");
    assert.ok(agents.includes("v10 MATCHLOCK"), "v10 MATCHLOCK lineage documented");
    assert.ok(agents.includes("v12 MAIN"), "v12 MAIN lineage documented");
    assert.ok(agents.includes("v12 UNION"), "v12 UNION lineage documented");
    assert.ok(agents.includes("detectSchemaLineage"), "schema lineage detector documented");
    assert.ok(agents.includes("PRAGMA table_info"), "lineage detection documented");
  });
});
