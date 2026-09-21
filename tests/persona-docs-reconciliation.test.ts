import assert from "node:assert/strict";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

/**
 * UNION-PORT US-008 — the merged persona / skill / documentation surface carries
 * BOTH lineages at once:
 *
 *   MAIN  the tester/verifier evidence-persona contract (a green exit code is
 *         not evidence; report what actually ran) and the outage-class
 *         (harnessWallMs / vmSetupMs / pre-claim death) wording;
 *   MTLK  the Matchlock observed-rounds zero-round refusal and the contained
 *         real-dsh boot gate documentation, on the combined v13 schema chain.
 *
 * This is a pure filesystem read (no `dist` import, no child_process, no
 * daemon, no VM, no network), so it stays in the PARALLEL lane and needs no
 * `tests/serial-files.txt` entry. The line-by-line persona contracts stay in
 * tests/tester-evidence-persona.test.ts and tests/bundled-persona-contracts.test.ts;
 * this suite pins that the RECONCILED docs did not drop either lineage.
 */

const root = resolve(import.meta.dirname, "..");

function read(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf-8");
}

/** Drop markdown emphasis/backticks and flatten whitespace for containment. */
function flatten(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function assertMentions(content: string, snippet: string, label: string): void {
  assert.ok(
    flatten(content).includes(flatten(snippet)),
    `${label} must contain: ${flatten(snippet)}`,
  );
}

const EVIDENCE_RAN =
  "A green exit code is not evidence on its own: before reporting a command as passed, read its output and confirm it exercised the behavior under test.";
const EVIDENCE_NOT_RUN =
  "report it as NOT RUN with what you observed, never as a pass";
const NOT_COVERAGE =
  "This is not a coverage requirement";
const EVIDENCE_LINE =
  "EVIDENCE: For each gate you relied on, what its output shows it actually exercised (cases run, or NOT RUN and why)";
const UNEXERCISED_GATE =
  "not verified; return it with `STATUS: retry` and name the gate";
// The do-review-do-verify verifier has no retry verdict: it always reports
// STATUS: done and expresses rejection with VERDICT: not_accomplished.
const UNEXERCISED_GATE_VERDICT =
  "not verified; return it with `VERDICT: not_accomplished` and name the gate";

const TESTER_PERSONAS = [
  "workflows/feature-dev/agents/tester/AGENTS.md",
  "workflows/feature-dev-merge/agents/tester/AGENTS.md",
  "workflows/security-audit/agents/tester/AGENTS.md",
  "workflows/security-audit-merge/agents/tester/AGENTS.md",
  "workflows/frontend-test/agents/tester/AGENTS.md",
] as const;

const VERIFIER_PERSONAS = [
  "agents/shared/verifier/AGENTS.md",
  "workflows/quarantine-broken-tests/agents/verifier/AGENTS.md",
  "workflows/quarantine-broken-tests-merge/agents/verifier/AGENTS.md",
  "workflows/do-review-do-verify/agents/verifier/AGENTS.md",
] as const;

describe("US-008 reconciliation: SKILL.md carries both lineages", () => {
  const skill = read("skills/tamandua-agents/SKILL.md");

  it("keeps main's CRITICAL STATUS line contract", () => {
    assert.ok(
      existsSync(resolve(root, "skills/tamandua-agents/SKILL.md")),
      "skills/tamandua-agents/SKILL.md must exist",
    );
    assertMentions(skill, "STATUS: done` as its own", "SKILL.md");
    assertMentions(skill, "plain-text line", "SKILL.md");
    assertMentions(skill, "is the ONLY thing that completes a step", "SKILL.md");
    assertMentions(
      skill,
      "STATUS: and KEY: contract lines must start at column 0 as plain text: no bold, no backticks, no fences, and no leading bullets",
      "SKILL.md",
    );
  });

  it("carries main's tester/verifier evidence-persona wording", () => {
    assertMentions(skill, EVIDENCE_RAN, "SKILL.md");
    assertMentions(skill, EVIDENCE_NOT_RUN, "SKILL.md");
    assertMentions(skill, NOT_COVERAGE, "SKILL.md");
    assertMentions(skill, EVIDENCE_LINE, "SKILL.md");
    assertMentions(skill, UNEXERCISED_GATE, "SKILL.md");
  });

  it("does not quote the removed standalone '- All tests pass' persona bullet", () => {
    const stale = skill.split(/\r?\n/).some((line) => line.trim() === "- All tests pass");
    assert.ok(!stale, "SKILL.md must not quote the removed tester bullet");
  });
});

describe("US-008 reconciliation: bundled personas carry main's evidence contract", () => {
  it("every canonical tester persona carries both evidence bullets and the EVIDENCE line", () => {
    for (const relPath of TESTER_PERSONAS) {
      const content = read(relPath);
      assertMentions(content, EVIDENCE_RAN, relPath);
      assertMentions(content, EVIDENCE_NOT_RUN, relPath);
      assertMentions(content, NOT_COVERAGE, relPath);
      assertMentions(content, EVIDENCE_LINE, relPath);
      const stale = content.split(/\r?\n/).some((line) => line.trim() === "- All tests pass");
      assert.ok(!stale, `${relPath} must not quote the removed tester bullet`);
    }
  });

  it("every canonical verifier persona rejects an unexercised gate by name", () => {
    for (const relPath of VERIFIER_PERSONAS) {
      const flat = flatten(read(relPath));
      const rejects =
        flat.includes(flatten(UNEXERCISED_GATE)) ||
        flat.includes(flatten(UNEXERCISED_GATE_VERDICT));
      assert.ok(
        rejects,
        `${relPath} must reject an unexercised gate (STATUS: retry or VERDICT: not_accomplished)`,
      );
      assert.ok(flat.includes(flatten("and name the gate")), `${relPath} must name the gate`);
    }
  });

  it("the worktree developer personas stay symlinked to the canonical merge workflow", () => {
    // feature-dev-merge-worktree/agents/* are directory symlinks into
    // feature-dev-merge/agents/*; the STATUS contract therefore comes from the
    // canonical persona and cannot drift.
    for (const role of ["developer", "merger", "planner", "reviewer", "tester"]) {
      const link = resolve(root, "workflows/feature-dev-merge-worktree/agents", role);
      assert.ok(lstatSync(link).isSymbolicLink(), `${link} must remain a symlink`);
      assertMentions(
        read(`workflows/feature-dev-merge-worktree/agents/${role}/AGENTS.md`),
        "CRITICAL — STATUS Line Requirement",
        `workflows/feature-dev-merge-worktree/agents/${role}/AGENTS.md`,
      );
    }
  });
});

describe("US-008 reconciliation: Matchlock observed-rounds + real-boot docs", () => {
  const readme = read("README.md");
  const qualification = read("docs/matchlock-dsh-qualification.md");

  it("README.md documents the observed_rounds zero-round refusal", () => {
    for (const token of [
      "observed_rounds",
      "observed-rounds.json",
      "scripts/observed-rounds-guard.mjs",
      "observed-rounds-guard: PASS",
      "no VM round observed (VM creation or probe failed before any round)",
      "exits **92**",
    ]) {
      assertMentions(readme, token, "README.md");
    }
  });

  it("README.md documents the contained real-dsh boot gate", () => {
    assertMentions(readme, "e2e-tests/matchlock-dsh-real-boot-gate.test.ts", "README.md");
    assertMentions(readme, "./run-matchlock-dsh-real-boot-gate-e2e-test", "README.md");
  });

  it("docs/matchlock-dsh-qualification.md documents the observed_rounds zero-round refusal", () => {
    for (const token of [
      "observed_rounds",
      "observed-rounds.json",
      "scripts/observed-rounds-guard.mjs",
      "observed-rounds-guard: PASS",
      "no VM round observed (VM creation or probe failed before any round)",
      "exits **92**",
    ]) {
      assertMentions(qualification, token, "docs/matchlock-dsh-qualification.md");
    }
  });

  it("docs/matchlock-dsh-qualification.md documents the contained real-dsh boot gate", () => {
    assertMentions(
      qualification,
      "e2e-tests/matchlock-dsh-real-boot-gate.test.ts",
      "docs/matchlock-dsh-qualification.md",
    );
    assertMentions(
      qualification,
      "./run-matchlock-dsh-real-boot-gate-e2e-test",
      "docs/matchlock-dsh-qualification.md",
    );
  });
});

describe("US-008 reconciliation: AGENTS.md documents the combined lineages", () => {
  const agents = read("AGENTS.md");

  it("documents the combined v13 schema chain with lineage detection", () => {
    for (const token of [
      "SCHEMA_VERSION = 13",
      "v9 -> v10",
      "v10 -> v11",
      "v11 -> v12",
      "v12 -> v13",
      "migrateInstantsToIsoZ()",
      "steps.target_moved_reroute_count",
      "steps.preclaim_death_count",
      "runs.matchlock_policy",
      "detectSchemaLineage",
      "PRAGMA table_info",
      "v12 MAIN",
      "v12 UNION",
    ]) {
      assertMentions(agents, token, "AGENTS.md");
    }
  });

  it("keeps main's outage-class wording", () => {
    for (const token of [
      "DEFAULT_INSTANT_FAIL_WALL_THRESHOLD_MS = 6000",
      "harnessWallMs",
      "preclaim_death_backoff",
      "Pre-claim deaths",
      "run.preclaim_death_loop",
    ]) {
      assertMentions(agents, token, "AGENTS.md");
    }
  });

  it("keeps the Matchlock gate documentation (unpinned, real-boot REQUIRED)", () => {
    for (const token of [
      "nine on-demand Matchlock real-VM gate drivers",
      "dsh mount plan changes: the contained real-dsh boot gate is REQUIRED",
      "./run-matchlock-dsh-real-boot-gate-e2e-test",
    ]) {
      assertMentions(agents, token, "AGENTS.md");
    }
  });
});

/**
 * The four -merge developer personas whose agent dirs are the canonical
 * (non-symlink) coding personas; every -worktree variant symlinks back to them.
 * The exact squash-warning sentence is pinned verbatim (same text as
 * tests/coding-persona-commit-squash.test.ts) so a union resolution can never
 * drop the SKILL-UX paragraph or the CRITICAL STATUS contract.
 */
const MERGE_DEVELOPER_PERSONAS = [
  "workflows/bug-fix-merge/agents/fixer/AGENTS.md",
  "workflows/feature-dev-merge/agents/developer/AGENTS.md",
  "workflows/quarantine-broken-tests-merge/agents/quarantiner/AGENTS.md",
  "workflows/security-audit-merge/agents/fixer/AGENTS.md",
] as const;

const COMMIT_SQUASH_WARNING =
  "This run's story commits are squashed at landing, so their ids do not survive. " +
  "If a file you commit must identify a version (a pin, provenance or readiness record), " +
  "use a content hash of the pinned files or a stable upstream id, never " +
  "`git rev-parse HEAD` or a story commit id from this run.";

describe("US-008 reconciliation: union-final Matchlock cleanup/VM-size docs and SKILL-UX personas", () => {
  const readme = read("README.md");
  const skill = read("skills/tamandua-agents/SKILL.md");

  it("README.md links the cleanup policy doc and documents the non-fatal post-harness cleanup", () => {
    for (const token of [
      "docs/matchlock-cleanup-policy.md",
      "serializeMatchlockError",
      "close`/`dispose` failure **after** the harness process has exited",
      "cleanupConfirmed=false",
      "vmCleanupFailure",
      "orphans.json",
      "exact id",
      "never uses `prune`/`gc` and never selects by name or glob",
      "stay fatal",
      "e2e-tests/matchlock-cleanup-gate.test.ts",
      "./run-matchlock-cleanup-e2e-test",
    ]) {
      assertMentions(readme, token, "README.md");
    }
  });

  it("README.md keeps the Matchlock VM-size flags/env/defaults/caps", () => {
    for (const token of [
      "--matchlock-cpus",
      "--matchlock-memory",
      "--matchlock-disk",
      "TAMANDUA_MATCHLOCK_CPUS",
      "TAMANDUA_MATCHLOCK_MEMORY_MB",
      "TAMANDUA_MATCHLOCK_DISK_MB",
      "cpus = min(8, host CPUs)",
      "memory = min(16384 MB, 50% of host RAM)",
      "disk = 20480 MB",
      "cpus <= 16",
    ]) {
      assertMentions(readme, token, "README.md");
    }
  });

  it("SKILL.md keeps the SKILL-UX launcher ergonomics notes", () => {
    assertMentions(skill, "redirect stdin from /dev/null", "SKILL.md");
    assertMentions(skill, "workflow list [--json] [--id <name>]", "SKILL.md");
  });

  it("SKILL.md carries the Matchlock VM-size/cleanup/observed-rounds notes and links the doc", () => {
    for (const token of [
      "--matchlock-cpus",
      "TAMANDUA_MATCHLOCK_CPUS",
      "cpus = min(8, host CPUs)",
      "cpus <= 16",
      "docs/matchlock-cleanup-policy.md",
      "serializeMatchlockError",
      "observed-rounds.json",
      "scripts/observed-rounds-guard.mjs",
      "observed_rounds > 0",
      "./run-matchlock-dsh-real-boot-gate-e2e-test",
    ]) {
      assertMentions(skill, token, "SKILL.md");
    }
  });

  it("the four -merge developer personas keep the SKILL-UX squash warning and the CRITICAL STATUS contract", () => {
    for (const relPath of MERGE_DEVELOPER_PERSONAS) {
      const content = read(relPath);
      assertMentions(content, COMMIT_SQUASH_WARNING, relPath);
      assertMentions(content, "CRITICAL — STATUS Line Requirement", relPath);
      assertMentions(content, "`STATUS: done` must appear as its own plain-text line", relPath);
      assertMentions(content, "STATUS: and KEY: lines must start at column 0", relPath);
    }
  });
});
