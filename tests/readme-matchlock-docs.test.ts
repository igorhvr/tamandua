/**
 * US-014 (MTLK-ALL-WORKFLOWS) — the README and the provisioned
 * skills/tamandua-agents/SKILL.md carry ONE coherent `--matchlock`
 * documentation surface for the all-workflows union.
 *
 * The source contracts this test pins together:
 *   MTLK-PI-EXEC      feature/matchlock-pi-execution-20260909       a4afa846
 *   MTLK-HERMES-EXEC  feature/matchlock-hermes-execution-20260909   1e49abef
 *   MTLK-DSH-EXEC     feature/matchlock-dsh-execution-20260909      a9fcdafe
 *   MTLK-WORKFLOWS    feature/matchlock-workflow-parity-20260909    745acd75
 *   MTLK-ALL-WORKFLOWS  feature/matchlock-all-workflows            (this run)
 *
 * The union decides (US-003/US-004/US-014): there is NO harness axis. `pi`,
 * `hermes` and `dsh` all admit the SAME explicit capability-closed workflow
 * set; shapes outside that closure (`*-github-pr`, `just-do-it`,
 * `frontend-test`, `skills-normalize-audit`, unknown/custom ids) are refused
 * with a precise reason for every harness.
 *
 * Pure filesystem reads (no child_process, no dist import, no daemon, no VM, no
 * network), so this file stays in the parallel lane and needs no
 * tests/serial-files.txt entry. The `workflow run --help` matrix is pinned in
 * the serial-lane src/cli/commands/workflow.test.ts and src/cli/cli.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const readme = readFileSync(resolve(repoRoot, "README.md"), "utf-8");
const skill = readFileSync(resolve(repoRoot, "skills", "tamandua-agents", "SKILL.md"), "utf-8");

// Slice from the single Matchlock heading to the next H5, so the matrix
// assertions cannot pass by matching an unrelated section of the README.
const matchlockHeading = "##### Matchlock Execution (`--matchlock`)";
const matchlockStart = readme.indexOf(matchlockHeading);
const matchlockSection =
  matchlockStart >= 0
    ? readme.slice(matchlockStart, readme.indexOf("##### Doctor Contract Check", matchlockStart))
    : "";

function tableRow(harness: string): string {
  return matchlockSection.match(new RegExp("\\|\\s*`" + harness + "`[^\\n]*"))?.[0] ?? "";
}

const piRow = tableRow("pi");
const hermesRow = tableRow("hermes");
const dshRow = tableRow("dsh");

/**
 * The full admitted capability-closed workflow set (every explicit closure in
 * src/installer/matchlock/capabilities.ts). All three harnesses carry it.
 */
const ADMITTED_WORKFLOW_IDS = [
  "do-now",
  "do-review-do-verify",
  "feature-dev",
  "feature-dev-worktree",
  "bug-fix",
  "bug-fix-worktree",
  "quarantine-broken-tests",
  "security-audit",
  "security-audit-worktree",
  "feature-dev-merge",
  "feature-dev-merge-worktree",
  "bug-fix-merge",
  "bug-fix-merge-worktree",
  "quarantine-broken-tests-merge",
  "quarantine-broken-tests-merge-worktree",
  "security-audit-merge",
  "security-audit-merge-worktree",
] as const;

describe("README --matchlock union documentation (MTLK-ALL-WORKFLOWS)", () => {
  it("has exactly ONE --matchlock section", () => {
    const headings = readme.match(/^##### Matchlock Execution/gm) ?? [];
    assert.equal(
      headings.length,
      1,
      "README must carry exactly one `##### Matchlock Execution` section",
    );
    assert.ok(matchlockStart >= 0, "README must have the Matchlock Execution section");
  });

  it("describes pi, hermes and dsh in the single section", () => {
    assert.match(matchlockSection, /`--pi-as-harness`/);
    assert.match(matchlockSection, /`--hermes-as-harness`/);
    assert.match(matchlockSection, /`--dsh-as-harness`/);
    // pi is the default; hermes/dsh are the explicit alternatives.
    assert.match(matchlockSection, /`pi` \(default \/ `--pi-as-harness`\)/);
  });

  it("states the mandatory image, fresh VM per invocation and no host fallback", () => {
    assert.match(matchlockSection, /inside a \*\*fresh Matchlock VM\*\*/);
    assert.match(matchlockSection, /never installs a harness or falls back/);
    assert.match(matchlockSection, /Passing the flag is the \*\*only\*\* opt-in/);
    assert.match(matchlockSection, /`--matchlock` is\s+refused with no image/);
  });

  it("documents the per-harness configuration mount", () => {
    // hermes: whole effective config dir at the guest `HERMES_HOME`.
    assert.match(matchlockSection, /guest `HERMES_HOME`/);
    // dsh: whole frozen DSH_HOME at /workspace/config/dsh as ONE mount.
    assert.match(matchlockSection, /read-write at the guest `\/workspace\/config\/dsh` as one mount/);
    assert.match(matchlockSection, /sessions\/`, `profiles\/`, `storages\/`, credentials and unknown/);
  });

  it("says the harness × workflow matrix is exact", () => {
    assert.match(matchlockSection, /The exact harness × workflow matrix in this build is:/);
  });

  it("publishes NO harness-by-workflow allow-list", () => {
    assert.match(matchlockSection, /no harness-by-workflow allow-list/);
    assert.doesNotMatch(matchlockSection, /do-now. and .do-review-do-verify. only/);
    assert.doesNotMatch(matchlockSection, /refused for the `hermes`\/`dsh` harnesses/);
  });

  it("all three matrix rows point at the one shared admitted set and refusal set", () => {
    for (const [harness, row] of [
      ["pi", piRow],
      ["hermes", hermesRow],
      ["dsh", dshRow],
    ] as const) {
      assert.ok(row, `README must have a \`${harness}\` matrix row`);
      assert.match(row, /admitted set|capability-closed set/);
      // No row may claim a harness-specific accepted set.
      assert.doesNotMatch(row, /only/);
    }
  });

  it("lists every admitted workflow id for all three harnesses", () => {
    assert.match(matchlockSection, /Admitted for all three harnesses:/);
    for (const id of ADMITTED_WORKFLOW_IDS) {
      assert.ok(matchlockSection.includes(id), `README must admit ${id} for all harnesses`);
    }
  });

  it("lists the precise per-shape refusals instead of a blanket allow-list", () => {
    assert.match(matchlockSection, /Refused for all three harnesses with a precise reason:/);
    assert.match(matchlockSection, /`\*-github-pr` needs a guest `gh` CLI/);
    assert.match(matchlockSection, /`just-do-it` needs bounded child workflow dispatch/);
    assert.match(matchlockSection, /`frontend-test` needs\s+browser\/visual verification/);
    assert.match(matchlockSection, /`skills-normalize-audit` scans an\s+operator-specified directory/);
    assert.match(matchlockSection, /unknown\/custom workflow id fails closed/);
  });

  it("never claims only pi is supported with --matchlock", () => {
    assert.doesNotMatch(matchlockSection, /only pi|pi only/i);
    assert.doesNotMatch(matchlockSection, /only the pi harness is supported/i);
    assert.doesNotMatch(matchlockSection, /not integrated/i);
  });

  it("records the synthetic-fixture caveat and the remaining real-model work", () => {
    assert.match(matchlockSection, /synthetic-fixture qualification/);
    assert.match(matchlockSection, /coordinator-owned remaining work/);
  });
});

describe("SKILL.md --matchlock union documentation (MTLK-ALL-WORKFLOWS)", () => {
  const hermesStart = skill.indexOf("### Hermes harness support");
  const hermesSection =
    hermesStart >= 0
      ? skill.slice(hermesStart, skill.indexOf("### dsh (DeepSeek Harness)", hermesStart))
      : "";

  it("admits all three harnesses with one shared full capability-closed set", () => {
    assert.match(skill, /All three harnesses are admitted with `--matchlock`/);
    assert.match(skill, /same full capability-closed workflow set/);
    assert.match(skill, /no harness-by-workflow\s+allow-list/);
    assert.doesNotMatch(skill, /`hermes` and `dsh` admit\s+`do-now` and `do-review-do-verify` only/);
  });

  it("does not claim --dsh-as-harness with --matchlock is refused", () => {
    assert.doesNotMatch(skill, /--dsh-as-harness` with `--matchlock` is\s+refused at parse time/);
    assert.doesNotMatch(hermesSection, /--dsh-as-harness[\s\S]{0,80}refused/i);
  });

  it("gives the dsh-under-Matchlock section the same full admitted set", () => {
    const dshStart = skill.indexOf("#### dsh under Matchlock (opt-in, MTLK-DSH-EXEC)");
    const dshSection =
      dshStart >= 0 ? skill.slice(dshStart, skill.indexOf("## Services & maintenance", dshStart)) : "";
    assert.ok(dshSection, "SKILL.md must contain the dsh-under-Matchlock subsection");
    assert.match(dshSection, /the same full capability-closed set as\s+`pi`/);
    assert.match(dshSection, /There is no\s+harness-by-workflow allow-list/);
    assert.doesNotMatch(dshSection, /Supported workflows in this build are `do-now` and `do-review-do-verify`/);
  });
});

describe("docs/matchlock-dsh-qualification.md reflects the union (US-009)", () => {
  const recipe = readFileSync(resolve(repoRoot, "docs", "matchlock-dsh-qualification.md"), "utf-8");

  it("no longer claims --hermes-as-harness is refused under --matchlock", () => {
    assert.doesNotMatch(recipe, /`--hermes-as-harness` refused/);
    assert.match(recipe, /`--hermes-as-harness` and `--dsh-as-harness` are all admitted with `--matchlock`/);
  });

  it("scopes the dsh-slice workflow support instead of claiming global support", () => {
    assert.match(recipe, /Workflows \(this dsh slice\) \| `do-now`, `do-review-do-verify`/);
    assert.match(recipe, /The two-workflow dsh milestone is not\s+completed overall workflow support/);
  });
});
