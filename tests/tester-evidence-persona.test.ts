import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

// A green exit code is not evidence: these tests pin the tester/verifier persona
// text that requires agents to report what a gate actually exercised.

const root = resolve(import.meta.dirname, "..");

const BULLET_EVIDENCE_RAN =
  "- All tests pass, and the evidence shows they ran. A green exit code is not evidence on its own: before reporting a command as passed, read its output and confirm it exercised the behavior under test. If the output shows the check was skipped, short-circuited, collected zero cases, or failed during setup, report it as NOT RUN with what you observed, never as a pass.";

const BULLET_NOT_COVERAGE =
  "- This is not a coverage requirement. If the project has no tests for the area, say so and base your verdict on the tests the story added or on direct verification of the behavior. Report what ran; never report a pass for something that did not run.";

const STALE_BULLET = "- All tests pass";

const EVIDENCE_LINE =
  "EVIDENCE: For each gate you relied on, what its output shows it actually exercised (cases run, or NOT RUN and why)";

const RULE_UNEXERCISED_GATE =
  "- A story whose test evidence shows a gate exited 0 without exercising the behavior (zero cases, skipped, or setup failure reported as a rejection) is not verified; return it with `STATUS: retry` and name the gate.";

// The do-review-do-verify verifier has no retry verdict: it always reports
// STATUS: done and expresses rejection with VERDICT: not_accomplished.
const RULE_UNEXERCISED_GATE_VERDICT =
  "- A story whose test evidence shows a gate exited 0 without exercising the behavior (zero cases, skipped, or setup failure reported as a rejection) is not verified; return it with `VERDICT: not_accomplished` and name the gate.";

const SHARED_VERIFIER = join(root, "agents/shared/verifier/AGENTS.md");
const QUARANTINE_VERIFIER = join(
  root,
  "workflows/quarantine-broken-tests/agents/verifier/AGENTS.md",
);
const QUARANTINE_MERGE_VERIFIER = join(
  root,
  "workflows/quarantine-broken-tests-merge/agents/verifier/AGENTS.md",
);
const DO_REVIEW_DO_VERIFY_VERIFIER = join(
  root,
  "workflows/do-review-do-verify/agents/verifier/AGENTS.md",
);

const FEATURE_DEV_TESTER = join(root, "workflows/feature-dev/agents/tester/AGENTS.md");
const FEATURE_DEV_MERGE_TESTER = join(root, "workflows/feature-dev-merge/agents/tester/AGENTS.md");
const SECURITY_AUDIT_TESTER = join(root, "workflows/security-audit/agents/tester/AGENTS.md");
const SECURITY_AUDIT_MERGE_TESTER = join(
  root,
  "workflows/security-audit-merge/agents/tester/AGENTS.md",
);
const FRONTEND_TEST_TESTER = join(root, "workflows/frontend-test/agents/tester/AGENTS.md");

// Repository-wide discovery targets: every canonical persona once, deduped by
// realpath so a `-worktree` directory symlink or a symlinked AGENTS.md file
// (e.g. feature-dev-github-pr) never counts as a second persona.
const CANONICAL_TESTER_REALPATHS = [
  FEATURE_DEV_TESTER,
  FEATURE_DEV_MERGE_TESTER,
  SECURITY_AUDIT_TESTER,
  SECURITY_AUDIT_MERGE_TESTER,
  FRONTEND_TEST_TESTER,
]
  .map((path) => realpathSync(path))
  .sort();

const CANONICAL_VERIFIER_REALPATHS = [
  SHARED_VERIFIER,
  DO_REVIEW_DO_VERIFY_VERIFIER,
  QUARANTINE_VERIFIER,
  QUARANTINE_MERGE_VERIFIER,
]
  .map((path) => realpathSync(path))
  .sort();

const WORKFLOWS_DIR = join(root, "workflows");
const DOCS_DIR = join(root, "docs");
const SKILLS_DIR = join(root, "skills");
const CATALOG_SOURCE = join(root, "src/installer/catalog-version.ts");

// Documentation scope that must not still quote the removed tester bullet.
// docs/ and skills/ are walked recursively so a new page cannot reintroduce it.
const ROOT_DOC_FILES = [join(root, "README.md"), join(root, "AGENTS.md"), join(root, "CLAUDE.md")];

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Every regular file under `dir`, following directory symlinks. */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = statSync(path); // follows symlinks
    if (stat.isDirectory()) {
      out.push(...collectFiles(path));
    } else if (stat.isFile()) {
      out.push(path);
    }
  }
  return out;
}

/** statSync follows symlinks; a missing/broken link is simply not a directory. */
function followsToDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover `workflows/<workflow>/agents/<role>/AGENTS.md`, following directory
 * symlinks (the `-worktree` variants expose the role dir as a symlink) and file
 * symlinks (github-pr variants symlink AGENTS.md), deduping by realpath.
 */
function discoverWorkflowPersonaFiles(role: "tester" | "verifier"): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(WORKFLOWS_DIR, { withFileTypes: true })) {
    const workflowDir = join(WORKFLOWS_DIR, entry.name);
    if (!followsToDirectory(workflowDir)) continue;
    const personaDir = join(workflowDir, "agents", role);
    if (!followsToDirectory(personaDir)) continue;
    const personaFile = join(personaDir, "AGENTS.md");
    if (!existsSync(personaFile) || !statSync(personaFile).isFile()) continue;
    found.add(realpathSync(personaFile));
  }
  return [...found].sort();
}

/** Collapse every run of whitespace (including newlines) to a single space. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Extract the body of a level-2 section up to the next level-2 heading. */
function section(content: string, heading: string): string {
  const start = content.indexOf(heading);
  assert.notEqual(start, -1, `missing heading: ${heading}`);
  const rest = content.slice(start + heading.length);
  const next = rest.search(/^## /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function hasStaleStandaloneBullet(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === STALE_BULLET);
}

/** Extract the body of a level-3 heading up to the next level-3 heading. */
function subsection(content: string, heading: string): string {
  const start = content.indexOf(heading);
  assert.notEqual(start, -1, `missing heading: ${heading}`);
  const rest = content.slice(start + heading.length);
  const next = rest.search(/^### /m);
  return next === -1 ? rest : rest.slice(0, next);
}

function assertEvidenceBullets(path: string): void {
  const content = read(path);
  const check = normalize(section(content, "## What to Check"));

  assert.ok(
    check.includes(normalize(BULLET_EVIDENCE_RAN)),
    `${path}: '## What to Check' must contain the "evidence shows they ran" bullet`,
  );
  assert.ok(
    check.includes(normalize(BULLET_NOT_COVERAGE)),
    `${path}: '## What to Check' must contain the "not a coverage requirement" bullet`,
  );
  assert.ok(
    !hasStaleStandaloneBullet(content),
    `${path}: must not contain a standalone '${STALE_BULLET}' bullet anywhere`,
  );
}

/** Extract the body of the '**Reject (STATUS: retry)** if:' list. */
function rejectList(content: string): string {
  const criteria = section(content, "## Decision Criteria");
  const marker = "**Reject (STATUS: retry)** if:";
  const start = criteria.indexOf(marker);
  assert.notEqual(start, -1, "missing '**Reject (STATUS: retry)** if:' list");
  return criteria.slice(start + marker.length);
}

function assertUnexercisedGateRule(path: string): void {
  const list = normalize(rejectList(read(path)));
  assert.ok(
    list.includes(normalize(RULE_UNEXERCISED_GATE)),
    `${path}: Reject list must contain the exact unexercised-gate rule`,
  );
}

function assertUnexercisedGateVerdictRule(path: string): void {
  const content = read(path);
  const notAccomplished = normalize(subsection(content, "### Not Accomplished"));
  assert.ok(
    notAccomplished.includes(normalize(RULE_UNEXERCISED_GATE_VERDICT)),
    `${path}: '### Not Accomplished' must contain the adapted unexercised-gate rule`,
  );
  // This persona's contract is STATUS: done plus VERDICT; it has no retry verdict.
  assert.ok(
    !/STATUS:\s*retry/.test(content),
    `${path}: must not introduce a STATUS: retry verdict`,
  );
}

/**
 * A verifier may express rejection as `STATUS: retry` or as this persona's
 * `VERDICT: not_accomplished`; both must say a gate that did not run is "not
 * verified" and must name the gate.
 */
function assertGateRule(path: string): void {
  const content = normalize(read(path));
  const namesSomething =
    content.includes(normalize(RULE_UNEXERCISED_GATE)) ||
    content.includes(normalize(RULE_UNEXERCISED_GATE_VERDICT));
  assert.ok(namesSomething, `${path}: must carry an unexercised-gate rejection rule`);
  assert.ok(
    content.includes(normalize("and name the gate")),
    `${path}: unexercised-gate rule must name the gate`,
  );
}

describe("tester persona run-evidence contract", () => {
  it("feature-dev tester requires evidence that the tests ran", () => {
    assertEvidenceBullets(FEATURE_DEV_TESTER);

    const outputFormat = normalize(section(read(FEATURE_DEV_TESTER), "## Output Format"));
    const resultsAt = outputFormat.indexOf("RESULTS:");
    const evidenceAt = outputFormat.indexOf(EVIDENCE_LINE);
    assert.notEqual(resultsAt, -1, `${FEATURE_DEV_TESTER}: pass block must have RESULTS:`);
    assert.notEqual(evidenceAt, -1, `${FEATURE_DEV_TESTER}: pass block must carry the EVIDENCE line`);
    assert.ok(
      evidenceAt > resultsAt,
      `${FEATURE_DEV_TESTER}: EVIDENCE must appear after RESULTS:`,
    );
  });

  it("feature-dev-merge tester requires evidence that the tests ran", () => {
    assertEvidenceBullets(FEATURE_DEV_MERGE_TESTER);

    for (const heading of ["## Output Format", "## Reply with"]) {
      const block = normalize(section(read(FEATURE_DEV_MERGE_TESTER), heading));
      const resultsAt = block.indexOf("RESULTS:");
      const evidenceAt = block.indexOf(EVIDENCE_LINE);
      const testedTreeAt = block.indexOf("TESTED_TREE:");
      assert.notEqual(resultsAt, -1, `${FEATURE_DEV_MERGE_TESTER} ${heading}: missing RESULTS:`);
      assert.notEqual(evidenceAt, -1, `${FEATURE_DEV_MERGE_TESTER} ${heading}: missing EVIDENCE line`);
      assert.notEqual(
        testedTreeAt,
        -1,
        `${FEATURE_DEV_MERGE_TESTER} ${heading}: missing TESTED_TREE:`,
      );
      assert.ok(
        resultsAt < evidenceAt && evidenceAt < testedTreeAt,
        `${FEATURE_DEV_MERGE_TESTER} ${heading}: EVIDENCE must sit between RESULTS: and TESTED_TREE:`,
      );
    }
  });

  it("security-audit tester requires evidence that the tests ran", () => {
    assertEvidenceBullets(SECURITY_AUDIT_TESTER);

    const outputFormat = normalize(section(read(SECURITY_AUDIT_TESTER), "## Output Format"));
    const resultsAt = outputFormat.indexOf("RESULTS:");
    const evidenceAt = outputFormat.indexOf(EVIDENCE_LINE);
    const auditAfterAt = outputFormat.indexOf("AUDIT_AFTER:");
    assert.notEqual(resultsAt, -1, `${SECURITY_AUDIT_TESTER}: pass block must have RESULTS:`);
    assert.notEqual(evidenceAt, -1, `${SECURITY_AUDIT_TESTER}: pass block must carry the EVIDENCE line`);
    assert.notEqual(auditAfterAt, -1, `${SECURITY_AUDIT_TESTER}: pass block must have AUDIT_AFTER:`);
    assert.ok(
      resultsAt < evidenceAt && evidenceAt < auditAfterAt,
      `${SECURITY_AUDIT_TESTER}: EVIDENCE must sit between RESULTS: and AUDIT_AFTER:`,
    );
  });

  it("security-audit-merge tester requires evidence that the tests ran", () => {
    assertEvidenceBullets(SECURITY_AUDIT_MERGE_TESTER);

    for (const heading of ["## Output Format", "## Reply with"]) {
      const block = normalize(section(read(SECURITY_AUDIT_MERGE_TESTER), heading));
      const resultsAt = block.indexOf("RESULTS:");
      const evidenceAt = block.indexOf(EVIDENCE_LINE);
      const testedTreeAt = block.indexOf("TESTED_TREE:");
      assert.notEqual(resultsAt, -1, `${SECURITY_AUDIT_MERGE_TESTER} ${heading}: missing RESULTS:`);
      assert.notEqual(
        evidenceAt,
        -1,
        `${SECURITY_AUDIT_MERGE_TESTER} ${heading}: missing EVIDENCE line`,
      );
      assert.notEqual(
        testedTreeAt,
        -1,
        `${SECURITY_AUDIT_MERGE_TESTER} ${heading}: missing TESTED_TREE:`,
      );
      assert.ok(
        resultsAt < evidenceAt && evidenceAt < testedTreeAt,
        `${SECURITY_AUDIT_MERGE_TESTER} ${heading}: EVIDENCE must sit between RESULTS: and TESTED_TREE:`,
      );
    }
  });

  it("frontend-test tester requires evidence that the tests ran", () => {
    assertEvidenceBullets(FRONTEND_TEST_TESTER);

    const outputFormat = normalize(section(read(FRONTEND_TEST_TESTER), "## Output Format"));
    const checksTotalAt = outputFormat.indexOf("CHECKS_TOTAL:");
    const evidenceAt = outputFormat.indexOf(EVIDENCE_LINE);
    assert.notEqual(checksTotalAt, -1, `${FRONTEND_TEST_TESTER}: pass block must have CHECKS_TOTAL:`);
    assert.notEqual(evidenceAt, -1, `${FRONTEND_TEST_TESTER}: pass block must carry the EVIDENCE line`);
    assert.ok(
      evidenceAt > checksTotalAt,
      `${FRONTEND_TEST_TESTER}: EVIDENCE must appear after CHECKS_TOTAL:`,
    );
  });
});

describe("verifier persona unexercised-gate rejection contract", () => {
  it("shared verifier rejects a gate that exited 0 without exercising the behavior", () => {
    assertUnexercisedGateRule(SHARED_VERIFIER);
  });

  it("quarantine-broken-tests verifier rejects an unexercised gate", () => {
    assertUnexercisedGateRule(QUARANTINE_VERIFIER);
  });

  it("quarantine-broken-tests-merge verifier rejects an unexercised gate", () => {
    assertUnexercisedGateRule(QUARANTINE_MERGE_VERIFIER);
  });

  it("do-review-do-verify verifier rejects an unexercised gate via VERDICT: not_accomplished", () => {
    assertUnexercisedGateVerdictRule(DO_REVIEW_DO_VERIFY_VERIFIER);

    // The verdict-model contract is unchanged: STATUS: done + VERDICT + DETAILS.
    const content = read(DO_REVIEW_DO_VERIFY_VERIFIER);
    assert.match(content, /STATUS:\s*done/);
    assert.match(content, /VERDICT:\s*accomplished\|not_accomplished/);
    assert.match(content, /DETAILS:/);
  });
});

describe("repository-wide persona discovery pins the evidence contract", () => {
  it("discovers exactly the 5 canonical tester personas, deduped by realpath", () => {
    assert.deepEqual(discoverWorkflowPersonaFiles("tester"), CANONICAL_TESTER_REALPATHS);
  });

  it("discovers exactly the 4 canonical verifier personas, deduped by realpath", () => {
    const discovered = [
      ...discoverWorkflowPersonaFiles("verifier"),
      realpathSync(SHARED_VERIFIER),
    ].sort();
    assert.deepEqual(discovered, CANONICAL_VERIFIER_REALPATHS);
  });

  it("every discovered tester persona carries both evidence bullets and the EVIDENCE line", () => {
    const personas = discoverWorkflowPersonaFiles("tester");
    assert.equal(personas.length, 5, "expected the 5 canonical tester personas");
    for (const path of personas) {
      assertEvidenceBullets(path);
      assert.ok(
        normalize(read(path)).includes(normalize(EVIDENCE_LINE)),
        `${path}: must carry the EVIDENCE pass-block line`,
      );
    }
  });

  it("every discovered verifier persona rejects an unexercised gate by name", () => {
    const personas = [
      ...discoverWorkflowPersonaFiles("verifier"),
      realpathSync(SHARED_VERIFIER),
    ];
    assert.equal(personas.length, 4, "expected the 4 canonical verifier personas");
    for (const path of personas) {
      assertGateRule(path);
    }
  });
});

describe("documentation and catalog carry no stale persona text", () => {
  it("no doc or skill file quotes a standalone '- All tests pass' bullet", () => {
    const corpus = [
      ...ROOT_DOC_FILES,
      ...collectFiles(DOCS_DIR),
      ...collectFiles(SKILLS_DIR),
    ];
    // Sanity: the corpus includes the root docs, every docs/ page, and the
    // bundled skill, so a removal of the scan scope would fail loudly here.
    assert.ok(corpus.length >= 8, `expected a non-trivial doc corpus, got ${corpus.length}`);
    for (const path of corpus) {
      assert.ok(
        !hasStaleStandaloneBullet(read(path)),
        `${path}: must not quote the removed '${STALE_BULLET}' persona bullet`,
      );
    }
  });

  it("the bundled catalog has no per-persona content manifest to regenerate", () => {
    // The catalog stamp is version + source path + timestamp only. A content
    // hash over workflows/ + agents/ + skills/ was explicitly rejected (see the
    // CATA-VSN comment in catalog-version.ts), so persona edits need no
    // manifest/hash regeneration. Pin that so a future content-hash manifest
    // cannot be added without this audit being revisited.
    const catalogSource = read(CATALOG_SOURCE);
    assert.ok(
      !/createHash\s*\(|node:crypto|digest\(/i.test(catalogSource),
      `${CATALOG_SOURCE}: catalog stamp must not hash persona content`,
    );
    assert.match(
      catalogSource,
      /interface CatalogStamp \{[\s\S]*?version:[\s\S]*?sourcePath:[\s\S]*?installedAt:/,
      `${CATALOG_SOURCE}: CatalogStamp must remain version/sourcePath/installedAt only`,
    );
  });
});
