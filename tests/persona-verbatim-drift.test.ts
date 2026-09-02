import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * WAVE-A.1 persona drift guard (US-005 auditor §1, US-006 reviewer §2).
 *
 * The `deception_audit` and `test_cmd_review` personas are pinned to the
 * verbatim texts in torture-test/impl-tasks/WAVE-A-approved-prompts.md
 * (sections 1 and 2 respectively). The pinned file is the AUTHORITATIVE
 * wording: any persona rephrasing other than the sanctioned delta(s) named
 * below must fail `npm test`.
 *
 * Documented normalization applied to both sides of every comparison:
 *  1. Whitespace: every run of whitespace (including line breaks) collapses
 *     to a single space, so paragraph re-wrapping never counts as drift.
 *  2. Template-variable syntax: the pinned authoring syntax `{name}` and the
 *     tamandua template renderer's syntax `{{name}}` (resolveTemplate in
 *     src/installer/step-ops.ts) canonicalize to the same token, so a
 *     persona may adapt the placeholder syntax to the renderer without
 *     tripping the diff.
 *
 * Persona files delimit their verbatim prompt body with marker comments
 * (e.g. `<!-- WAVE-A-APPROVED-PROMPT-S1-BEGIN -->`). Everything between the
 * markers must match the pinned text (normalized); everything outside the
 * markers (identity heading, READ-ONLY declaration, output-format and
 * status-line boilerplate) is not part of the pinned prompt and is free-form.
 *
 * Sanctioned deltas:
 *  - §1 deception auditor (US-005): the pinned activation paragraph is
 *    replaced by the WAVE-A.1 always-audit rewording.
 *  - §2 test_cmd_review reviewer (US-006): NONE — the reviewer persona is
 *    verbatim with no sanctioned delta.
 */

const repoRoot = resolve(import.meta.dirname, "..");
const pinnedPromptsPath = resolve(
  repoRoot,
  "torture-test",
  "impl-tasks",
  "WAVE-A-approved-prompts.md",
);
const workflowsRoot = resolve(repoRoot, "workflows");

// ── Normalization ───────────────────────────────────────────────────────

function normalizePromptText(text: string): string {
  return text
    // Template-variable syntax: {{name}} (renderer) and {name} (pinned
    // authoring) are the same material reference.
    .replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, "⟪$1⟫")
    .replace(/\{(\w+(?:\.\w+)*)\}/g, "⟪$1⟫")
    // Whitespace collapsing: wrapping/indentation is not wording.
    .replace(/\s+/g, " ")
    .trim();
}

// ── Pinned-file helpers ────────────────────────────────────────────────

/**
 * Extract the fenced (```) prompt bodies of the pinned file. The file's
 * section 1 body is the first fenced block, section 2 the second.
 */
function pinnedFencedBodies(): string[] {
  const content = readFileSync(pinnedPromptsPath, "utf-8");
  const bodies: string[] = [];
  let inFence = false;
  let buffer: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (/^```/.test(line.trim())) {
      if (inFence) {
        bodies.push(buffer.join("\n"));
        buffer = [];
      }
      inFence = !inFence;
    } else if (inFence) {
      buffer.push(line);
    }
  }
  return bodies;
}

/**
 * Extract the region of a persona file delimited by the marker comments.
 * Throws with a targeted message when the markers are missing.
 */
function personaPinnedRegion(filePath: string, beginMarker: string, endMarker: string): string {
  const content = readFileSync(filePath, "utf-8");
  const begin = content.indexOf(beginMarker);
  const end = content.indexOf(endMarker);
  assert.ok(
    begin >= 0 && end >= 0 && end > begin,
    `${filePath}: pinned-prompt markers missing or out of order ` +
      `(expected "${beginMarker}" … "${endMarker}")`,
  );
  return content.slice(begin + beginMarker.length, end).trim();
}

function firstWordDivergence(actual: string, expected: string): string {
  const a = actual.split(" ");
  const e = expected.split(" ");
  const n = Math.max(a.length, e.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== e[i]) {
      const ctx = (words: string[], i: number) =>
        `…${words.slice(Math.max(0, i - 6), i + 7).join(" ")}…`;
      return `first divergence at word ${i}:\n  persona: ${ctx(a, i)}\n  pinned:  ${ctx(e, i)}`;
    }
  }
  return "identical under normalization";
}

// ── US-005: PHNT deception auditor (§1) ────────────────────────────────

const PHNT_AUDIT_WORKFLOW_IDS = [
  "bug-fix",
  "bug-fix-worktree",
  "bug-fix-merge",
  "bug-fix-merge-worktree",
  "bug-fix-github-pr",
];

const AUDITOR_BEGIN_MARKER = "<!-- WAVE-A-APPROVED-PROMPT-S1-BEGIN -->";
const AUDITOR_END_MARKER = "<!-- WAVE-A-APPROVED-PROMPT-S1-END -->";

/**
 * The ONE sanctioned delta for the deception-auditor persona (WAVE-A.1
 * "Always audit", igorhvr 2026-09-01/02): the pinned activation paragraph —
 * "You are activated because the fixer reported it COULD NOT REPRODUCE the
 * bug … Default to HONEST." — is replaced by the always-audit rewording.
 * Every other word of the pinned §1 prompt body must appear verbatim.
 */
const ALWAYS_AUDIT_ACTIVATION = [
  "You are activated after every fix. The fixer either reported reproduction",
  "evidence (REPRO_EVIDENCE) or could not reproduce (CANNOT_REPRODUCE) — both",
  "are legitimate; absence of reproduction is NOT evidence of dishonesty, and a",
  "REPRO_EVIDENCE claim is checked under item 3 (claim/artifact mismatch).",
  "Default to HONEST.",
].join("\n");

/** Pinned §1 body with the pinned activation paragraph swapped for the
 * sanctioned WAVE-A.1 always-audit activation paragraph. */
function expectedAuditorPromptBody(): string {
  const [section1Body] = pinnedFencedBodies();
  assert.ok(section1Body, "pinned WAVE-A prompts file must carry a section 1 fenced body");
  const normalizedPinned = normalizePromptText(section1Body);
  const pinnedActivation = /You are activated because[\s\S]*?Default to HONEST\./;
  const match = pinnedActivation.exec(normalizedPinned);
  assert.ok(
    match,
    "pinned §1 must contain the CANNOT_REPRODUCE activation paragraph " +
      "(anchors: 'You are activated because' … 'Default to HONEST.')",
  );
  return normalizedPinned.replace(match[0], normalizePromptText(ALWAYS_AUDIT_ACTIVATION));
}

describe("WAVE-A persona drift guard (US-005: deception auditor §1)", () => {
  for (const workflowId of PHNT_AUDIT_WORKFLOW_IDS) {
    it(`${workflowId} auditor AGENTS.md pinned region matches WAVE-A-approved-prompts.md §1 verbatim (only the always-audit activation delta)`, () => {
      const path = resolve(workflowsRoot, workflowId, "agents", "auditor", "AGENTS.md");
      const region = personaPinnedRegion(path, AUDITOR_BEGIN_MARKER, AUDITOR_END_MARKER);
      const actual = normalizePromptText(region);
      const expected = expectedAuditorPromptBody();
      // assert.ok (not assert.equal) so a drift failure reports the concise
      // divergence message instead of dumping two full normalized texts.
      assert.ok(
        actual === expected,
        `${path}: auditor persona drifted from the pinned §1 prompt ` +
          `(${firstWordDivergence(actual, expected)}). Only the activation ` +
          `paragraph may differ from WAVE-A-approved-prompts.md §1, and only ` +
          `by the sanctioned always-audit rewording.`,
      );
    });
  }

  it("auditor persona region still carries the always-audit activation wording (sanctioned delta is present, not just any delta)", () => {
    const path = resolve(workflowsRoot, "bug-fix-merge", "agents", "auditor", "AGENTS.md");
    const region = personaPinnedRegion(path, AUDITOR_BEGIN_MARKER, AUDITOR_END_MARKER);
    // Whitespace-normalized wording checks: line wrapping is not wording.
    const normalized = normalizePromptText(region);
    assert.match(
      normalized,
      /You are activated after every fix\./,
      `${path}: always-audit activation paragraph missing`,
    );
    assert.match(
      normalized,
      /a REPRO_EVIDENCE claim is checked under item 3 \(claim\/artifact mismatch\)\./,
      `${path}: always-audit activation paragraph must keep the item-3 cross-reference`,
    );
    assert.doesNotMatch(
      normalized,
      /You are activated because the fixer reported it COULD NOT REPRODUCE/,
      `${path}: stale CANNOT_REPRODUCE-only activation paragraph must not remain`,
    );
  });

  it("auditor persona keeps the READ-ONLY contract and status-line boilerplate outside the pinned region", () => {
    const path = resolve(workflowsRoot, "bug-fix-merge", "agents", "auditor", "AGENTS.md");
    const content = readFileSync(path, "utf-8");
    assert.match(content, /READ-ONLY by contract/i, `${path}: must declare READ-ONLY by contract`);
    assert.match(
      content,
      /## CRITICAL — STATUS Line Requirement[\s\S]*`STATUS: done` must appear as its own plain-text line/,
      `${path}: must keep the status-line boilerplate`,
    );
    // The pinned region is exactly one contiguous block: nothing between the
    // markers may be duplicated outside of them.
    const region = personaPinnedRegion(path, AUDITOR_BEGIN_MARKER, AUDITOR_END_MARKER);
    assert.ok(region.startsWith("You are a DECEPTION AUDITOR."), `${path}: region must open the pinned body`);
    assert.ok(region.endsWith("codebase is not."), `${path}: region must close the pinned body`);
  });
});

// ── US-006: TCMD test-command rewrite reviewer (§2) ──────────────────────

// The three REAL reviewer dirs (feature-dev-merge, bug-fix-merge,
// security-audit-merge) plus their merge-worktree symlink variants — the six
// merge-gate workflows that declare a test_cmd_review conditional step. The
// -worktree variants symlink agents/reviewer to the real dirs, so reading via
// any of the six paths resolves to the same three real files (all identical).
const TCMD_REVIEW_WORKFLOW_IDS = [
  "feature-dev-merge",
  "feature-dev-merge-worktree",
  "bug-fix-merge",
  "bug-fix-merge-worktree",
  "security-audit-merge",
  "security-audit-merge-worktree",
];

const REVIEWER_BEGIN_MARKER = "<!-- WAVE-A-APPROVED-PROMPT-S2-BEGIN -->";
const REVIEWER_END_MARKER = "<!-- WAVE-A-APPROVED-PROMPT-S2-END -->";

/** Pinned §2 fenced body — the reviewer persona has NO sanctioned delta. */
function expectedReviewerPromptBody(): string {
  const bodies = pinnedFencedBodies();
  const section2Body = bodies[1];
  assert.ok(
    section2Body,
    "pinned WAVE-A prompts file must carry a section 2 fenced body",
  );
  return normalizePromptText(section2Body);
}

describe("WAVE-A persona drift guard (US-006: test_cmd_review reviewer §2)", () => {
  for (const workflowId of TCMD_REVIEW_WORKFLOW_IDS) {
    it(`${workflowId} reviewer AGENTS.md pinned region matches WAVE-A-approved-prompts.md §2 verbatim (no sanctioned delta)`, () => {
      const path = resolve(workflowsRoot, workflowId, "agents", "reviewer", "AGENTS.md");
      const region = personaPinnedRegion(path, REVIEWER_BEGIN_MARKER, REVIEWER_END_MARKER);
      const actual = normalizePromptText(region);
      const expected = expectedReviewerPromptBody();
      // assert.ok (not assert.equal) so a drift failure reports the concise
      // divergence message instead of dumping two full normalized texts.
      assert.ok(
        actual === expected,
        `${path}: reviewer persona drifted from the pinned §2 prompt ` +
          `(${firstWordDivergence(actual, expected)}). The persona must match ` +
          `WAVE-A-approved-prompts.md §2 verbatim — no wording delta is sanctioned ` +
          `for the reviewer.`,
      );
    });
  }

  it("reviewer persona pinned region opens and closes with the pinned §2 body (markers delimit exactly one contiguous block)", () => {
    for (const workflowId of TCMD_REVIEW_WORKFLOW_IDS) {
      const path = resolve(workflowsRoot, workflowId, "agents", "reviewer", "AGENTS.md");
      const region = personaPinnedRegion(path, REVIEWER_BEGIN_MARKER, REVIEWER_END_MARKER);
      assert.ok(
        region.startsWith("You are a TEST-COMMAND REWRITE REVIEWER."),
        `${path}: region must open the pinned §2 body`,
      );
      assert.ok(region.endsWith("never silent."), `${path}: region must close the pinned §2 body`);
      assert.ok(
        !region.includes(REVIEWER_BEGIN_MARKER) && !region.includes(REVIEWER_END_MARKER),
        `${path}: region must not nest its own markers`,
      );
    }
  });

  it("reviewer persona keeps the READ-ONLY contract and status-line boilerplate outside the pinned region", () => {
    for (const workflowId of TCMD_REVIEW_WORKFLOW_IDS) {
      const path = resolve(workflowsRoot, workflowId, "agents", "reviewer", "AGENTS.md");
      const content = readFileSync(path, "utf-8");
      assert.match(content, /READ-ONLY by contract/i, `${path}: must declare READ-ONLY by contract`);
      assert.match(
        content,
        /## CRITICAL — STATUS Line Requirement[\s\S]*`STATUS: done` must appear as its own plain-text line/,
        `${path}: must keep the status-line boilerplate`,
      );
      assert.match(content, /VERDICT: (ACCEPT|REJECT)/, `${path}: must keep the verdict output format`);
    }
  });

  it("the three real reviewer dirs are byte-identical so all six merge-gate workflows share one verbatim prompt", () => {
    const realDirs = ["feature-dev-merge", "bug-fix-merge", "security-audit-merge"];
    const contents = realDirs.map(
      (wf) => readFileSync(resolve(workflowsRoot, wf, "agents", "reviewer", "AGENTS.md"), "utf-8"),
    );
    assert.ok(
      contents.every((c) => c === contents[0]),
      "real reviewer AGENTS.md files must stay byte-identical:\n" +
        realDirs
          .map((wf, i) => `  ${wf}: ${contents[i].length} bytes`)
          .join("\n"),
    );
  });
});
