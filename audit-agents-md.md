# Audit: AGENTS.md Issues

## 1. Outdated Workflow Directory References

| Line | Current Text | Issue |
|------|-------------|-------|
| 175 | `feature-dev-merge` | Both `feature-dev-merge` and `feature-dev-merge-worktree` bundles exist, but the worktree variant is the current canonical workflow. The reference is ambiguous about which variant is meant. The README/test enforcement should use `feature-dev-merge-worktree` (or both variants) to match current repository state. |

## 2. Historical / Temporal Language

| Line | Current Text | Issue |
|------|-------------|-------|
| 169 | `now starts dashboard + MCP together` | "now" implies a recent change / temporal state. It will age poorly — readers won't know when "now" was. Replace with "starts dashboard + MCP together". |

## 3. Missing Artifact Types in Change-Review Instructions

The **"Skills and Agent Instructions"** section (line 126) currently only tells developers to check `skills/tamandua-agents/SKILL.md`. The following artifacts are also affected by Tamandua changes and should be included in the review checklist:

| Artifact Type | Path | Why It Should Be Reviewed |
|--------------|------|--------------------------|
| **Documentation** | `docs/creating-workflows.md` | User-facing docs must stay consistent with workflow YAML structure and commands |
| **MCP Server** | `src/server/mcp-server.ts` | MCP tools/responses may need updates when CLI commands or step lifecycle changes |
| **CLI** | `src/cli/cli.ts` | The CLI entry point may need new commands or modified help text |
| **Dashboard UI** | `frontend/` (Vite + React SPA) | UI changes may be needed when new observability data is exposed |
| **README** | `README.md` | Project README should reflect current workflow catalog and features |

None of these artifacts are mentioned in the "Skills and Agent Instructions" section (or anywhere else as a review obligation).

## 4. Verbose Sections with Condensation Suggestions

### 4a. Parallel Test Safety (lines 141-169, 28 lines)

The section has 7 bullet-style entries with significant redundancy. Suggested condensing:

**Current** (28 lines): 7 entries, each with multi-sentence explanations + examples.

**Condensation target** (~12-14 lines): Merge into 4 consolidated rules:
1. Random ports + no probing of defaults (3334/3338/3339)
2. Temp HOME isolation with cleanup in `finally`
3. Scoped daemon/MCP control (never against real HOME)
4. Guard coverage (`tests/test-isolation-guard.test.ts`) + PID ownership verification

The detailed examples can be shortened or merged into the parenthetical notes.

### 4b. Testing section (lines 130-181, 51 lines total)

The "Testing" top-level section (line 130) is the second-largest section after "Project Structure". Much of the content duplicates detailed testing patterns that belong in test files, not the AGENTS.md overview.

**Suggested**: Keep the two-sentence intro and the `npm test` command. Move framework-specific patterns (`src/server/mcp-server.ts` DI, `src/server/daemon.ts` co-lifecycle, `tests/workflow-validation.test.ts` assertions, etc.) into a condensed Testing subsection under the relevant code module's entry in Project Structure, or better yet, into the test files themselves as doc comments.

### 4c. Agent Scheduler subsection (lines 98-111, 14 lines)

The 6 numbered steps are very granular — lines 3 and 6 explain internal implementation details (log event names, token extraction mechanics) that developers don't need in the top-level AGENTS.md. These can be collapsed into 3-4 high-level points.

## 5. "Skills and Agent Instructions" Section Scope (lines 126-138)

This section is named "Skills and Agent Instructions" but only covers `skills/tamandua-agents/SKILL.md`. It should be renamed to reflect that it's about artifact-wide review obligations, not just skills. Suggested rename: **"Artifacts to Review on Changes"** or **"Change Impact Review"**.

---

## Summary

- **1** outdated workflow reference found (line 175)
- **1** instance of temporal language found (line 169)
- **5** artifact types missing from change-review instructions (docs, MCP, CLI, dashboard, README)
- **3** verbose sections identified for condensation (Parallel Test Safety, Testing, Agent Scheduler)
- **1** section scope issue (named "Skills" but should cover all artifacts)
