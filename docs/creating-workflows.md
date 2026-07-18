# Creating Workflows

This guide walks through creating a custom workflow for Tamandua.

## Overview

A workflow is a directory containing:
- `workflow.yml` — the workflow specification
- One subdirectory per agent (path set by `workspace.baseDir`) holding the agent's persona files (`AGENTS.md`, `IDENTITY.md`, `SOUL.md`)

When installed, the workflow is copied to `~/.tamandua/workflows/<workflow-id>/` and each agent's workspace is provisioned under `~/.tamandua/workspaces/workflows/<workflow-id>_<agent-id>/`.

## workflow.yml

```yaml
id: my-workflow             # Required. Unique identifier (kebab-case)
name: My Custom Workflow    # Optional. Human-readable name
version: 1                  # Optional. Schema version
description: |              # Optional. Free text — informational only
  A workflow that does something useful.

# Optional initial context. Keys here are merged into every step's template
# context (the `{{task}}` key is always seeded automatically from the CLI arg).
context:
  some_key: some_value

# Optional notification webhook.
notifications:
  url: https://example.com/webhook

agents:
  - id: planner               # Required.
    name: Planner              # Optional.
    description: Decomposes tasks into stories.   # Optional.
    role: analysis             # Optional. analysis|coding|verification|testing|pr|scanning
                               # If omitted, the role is inferred from the agent id.
    model: claude-sonnet       # Optional. Per-agent model override
    timeoutSeconds: 3600       # Optional. Per-step wall-clock budget (seconds).
                               # Defaults: analysis|coding|testing = 5400 (90m);
                               #           verification|pr|scanning = 3600 (60m).
    workspace:
      baseDir: agents/planner  # Required. Directory (relative to workflow.yml) holding
                               # this agent's persona files. AGENTS.md, IDENTITY.md, and
                               # SOUL.md are picked up automatically from here.
      skills:                  # Optional. Skill names to install for this agent.
        - tamandua-agents
      files:                   # Optional. Extra files to copy into the workspace,
                               # or overrides for the persona files. Keys are the
                               # destination filename in the workspace; values are
                               # source paths resolved against the workflow root
                               # (so `../../agents/shared/...` works for shared files).
        EXTRA.md: agents/planner/EXTRA.md

  - id: developer
    name: Developer
    role: coding
    workspace:
      baseDir: agents/developer

steps:
  - id: plan                   # Required. Unique step id within the workflow.
    agent: planner             # Required. Must match an agent id above.
    input: |                   # Required. Template (see Placeholders below).
      Plan the implementation of {{task}}.
      Output the stories as STORIES_JSON.
      Reply with STATUS: done.
    expects: "STATUS: done"    # Required. Substring expected in the agent's output.
    max_retries: 4             # Optional. Step-level retry budget. Default: 4.

  - id: implement
    agent: developer
    type: loop                 # Optional. "single" (default) or "loop".
    loop:
      over: stories            # Required for loops. Currently only "stories".
      completion: all_done     # Required for loops. Currently only "all_done".
      fresh_session: true      # Optional. New agent session per story. (camelCase
                               # `freshSession` also accepted; snake_case preferred.)
      verify_each: true        # Optional. Run verifyStep after each story.
      verify_step: verify      # Optional. Step id of the verifier.
    input: |
      Implement the current story.

      CURRENT STORY:
      {{current_story}}

      Reply with STATUS: done.
    expects: "STATUS: done"
    max_retries: 4
    on_fail:
      retry_step: implement    # Reroute to implement on retry exhaustion

  - id: verify
    agent: verifier
    input: |
      Verify {{current_story_title}} against acceptance criteria.
      Reply with STATUS: done or STATUS: retry.
    expects: "STATUS: done"
```

## Agent Persona Files

Each agent's `baseDir` is automatically scanned for these files; whatever is present is copied into the agent's workspace:

- `AGENTS.md` — system prompt / role brief
- `IDENTITY.md` — optional. Agent identity and background
- `SOUL.md` — optional. Personality and behavior guidelines

You can also list extra files (or override the persona files) under `workspace.files`. Source paths in `files` are resolved against the workflow root, so `../../agents/shared/setup/AGENTS.md` is valid for sharing personas across workflows in the same repo.

Example `AGENTS.md`:

```markdown
You are a workflow agent in the Tamandua system.
Your role: Planner.
You decompose tasks into implementable stories.

Always reply with KEY: value lines:
STATUS: done
PLAN: your plan summary

For stories, emit a single literal line:
STORIES_JSON: [{"id":"S1","title":"...","description":"...","acceptanceCriteria":["..."]}]
```

## Step Input Templates

Step `input` is rendered with `{{key}}` placeholders before being sent to the agent. The placeholder regex matches `{{word(.word)*}}`, but the resolver does a **flat key lookup** — there are no nested objects. Unknown keys are substituted with the literal text `[missing: <key>]`.

The context for each step is built from:

1. The run's seeded context (the `{{task}}` argument plus any `context:` from `workflow.yml` and `--context` overrides at run time).
2. `KEY: value` pairs parsed from every previous completed step's output. Keys are lowercased; subsequent steps reference them in lowercase (e.g., emitting `BRANCH: feature/foo` makes `{{branch}}` available downstream).
3. Computed values added by the runtime.

### Always available

| Placeholder | Description |
|-------------|-------------|
| `{{task}}` | The task description from `tamandua workflow run` |
| `{{run_id}}` | The run UUID |

### Computed when context allows

| Placeholder | Description |
|-------------|-------------|
| `{{has_frontend_changes}}` | `"true"` or `"false"` — derived from `repo` + `branch` if both are set |
| `{{has_pr}}` | `"true"` if a previous step emitted `PR_URL:` |

### Loop steps only

| Placeholder | Description |
|-------------|-------------|
| `{{current_story}}` | A formatted block: `Story <id>: <title>\n\n<description>\n\nAcceptance Criteria:\n  1. ...` |
| `{{current_story_id}}` | The current story's id |
| `{{current_story_title}}` | The current story's title |
| `{{completed_stories}}` | Bullet list of completed stories, or `(none yet)` |
| `{{stories_remaining}}` | Count of pending + running stories |
| `{{progress}}` | Contents of the progress file (if the agent maintains one) |
| `{{progress_file}}` | Absolute path to the progress file (e.g. `~/.tamandua/runs/<run_id>/progress.txt`) |
| `{{verify_feedback}}` | Feedback from the verify step on retry, else empty |

### From prior step `KEY: value` outputs

Anything a prior step emits as `KEY: value` becomes `{{key}}` (lowercased). Common conventions used in the bundled workflows: `{{repo}}`, `{{branch}}`, `{{build_cmd}}`, `{{test_cmd}}`, `{{changes}}`, `{{tests}}`, `{{retry_feedback}}`, `{{pr}}`, `{{results}}`.

## Step Output Format

The output parser scans line-by-line for `^[A-Z_]+:` to detect the start of a new key. Anything that does not match starts a continuation of the previous key's value. Keys are stored lowercased.

> **CRITICAL — STATUS line.** The scheduler classifies agent output by exact
> markers: `STATUS: done` (success) or `STATUS: failed`/`STATUS: error`
> (failure). If neither marker is present, the step is treated as
> **lost/abandoned** and retried — wasting a retry slot even when the work was
> actually completed. This is the most common cause of spurious retries. When
> writing agent persona files (AGENTS.md), state explicitly that the last line
> of output must be `STATUS: done` on success, or that output must end with
> `STATUS: failed` and a `REASON:` line on failure. The bundled workflows
> include a `## CRITICAL — STATUS Line Requirement` section for this — copy it
> into your own personas.

```
STATUS: done
CHANGES: what was changed
TESTS: what tests were run
```

Continuation lines work — this becomes a single multi-line value:

```
NOTES: first line
second line still part of NOTES
THIRD_KEY: starts here
```

For loop-generating steps, the output must include a `STORIES_JSON:` line (parsed separately and not merged into the KEY: value context):

```
STATUS: done
PLAN: implementation plan summary
STORIES_JSON: [{"id":"S1","title":"Add login","description":"...","acceptanceCriteria":["Users can log in","Tests pass"]}]
```

`STORIES_JSON` requirements:
- Must be a valid JSON array — single-line minified JSON or a contiguous block (the parser walks following lines until it hits another `KEY:` line, so multi-line JSON is fine).
- **Maximum 20 stories.**
- Each story must have `id` (matching `^[A-Z]+-\d+$`), `title` (non-empty, non-whitespace), `description` (non-empty string), and a non-empty `acceptanceCriteria` array of non-empty strings (`acceptance_criteria` is also accepted).
- Story `id`s must be unique within the array.
- **Format contract:** one `{...}` object per story, separated by `},{` with no whitespace or newlines between them. Do NOT wrap in code fences or markdown. No comments. No trailing prose after the closing `]`. Malformed payloads (fused objects, duplicate keys, invalid fields) are auto-rejected with specific feedback in the step's next `RETRY FEEDBACK` — the rejection message names the problem (duplicated key, story index, line positions) so the planner can fix it precisely. See `tests/MOTOR-CONTRACT.md` C20 for the full structural validation contract.

### Key Enforcement Contract

When one step consumes `{{key}}` placeholders produced by an earlier step, the **producer** step must enforce that key in its `expects` string — a bare mention of `KEY:` in the `Reply with:` block of the producer's input template is NOT enough.

**The rule:** every `{{key}}` consumed by a step must be:
- in `AUTO_CONTEXT_KEYS` (keys provided by the runtime: `{{task}}`, `{{run_id}}`, etc.), OR
- declared in the workflow-level `context:` block, OR
- supplied by the caller at launch (caller-provided keys, e.g. `{{branch}}` for quarantine workflows), OR
- **enforced** by an upstream producer step via its `expects` string.

A key that is merely *mentioned* in the producer's `Reply with:` instruction (without enforcement in `expects`) causes a **lint failure** at `tdd workflow lint`. The linter (`tests/workflow-contract-lint.test.ts`) verifies this for all bundled workflows.

**Why enforcement matters:** the `MISS` mechanism (Missing Input Step Selector, in `src/installer/step-ops.ts`) blocks a step claim when its consumed `{{key}}` placeholders have not materialized from prior step output. If the producer's `expects` string doesn't declare a key, the agent is free to omit it — and when it does, the downstream step deadlocks. Historically, the "verified" incident burned two real runs: `finalize_merge` consumed `{{verified}}`, `verify`'s `Reply with:` block *mentioned* `VERIFIED:` (so the old mention-satisfies linter was happy), but the agent omitted it in 10–90% of runs, causing producer-retry exhaustion.

**The `expects` regex idiom:** to enforce a key, add a regex line to the step's `expects` string:

```yaml
# Before (mention-only — not enforced):
expects: "STATUS: done"

# After (enforced — the key is pinned):
expects: |
  STATUS: done
  regex:^CHANGES:\s*\S+
  regex:^TESTS:\s*\S+
```

Each regex line is one of:

| Pattern | Example | Meaning |
|---------|---------|---------|
| `regex:^KEY:\s*\S+` | `regex:^CHANGES:\s*\S+` | KEY at start of line, any non-empty value |
| `regex:^KEY:\s*\d+` | `regex:^VULNERABILITY_COUNT:\s*\d+` | KEY at start of line, numeric value |
| `regex:^KEY:\s*(val1\|val2)` | `regex:^SEVERITY:\s*(critical\|high\|medium\|low)` | KEY at start of line, enumerated values |
| `regex:KEY:\s*https?://...` | `regex:PR:\s*https?://\S+` | KEY anywhere on line (no `^` anchor) |

**Guidelines:**
- Always put `STATUS: done` first in the expects string (it resolves the step outcome).
- Use value-shape-aware regexes: closed enums get `(val1|val2|...)`, numeric counts get `\d+`, text fields get `\S+`.
- Multi-line values are fine — only the first line must be non-empty to satisfy `\S+`.
- When a step has both a success and retry path (e.g. `STATUS: done` / `STATUS: retry`), the enforced key fires only on the done path — the agent is expected to produce it on success; MISS blocks the consumer on retry anyway.
- The `expects` regex patterns are consumed by both the linter and the contract module (`src/installer/workflow-contract.ts`), which is the single source of truth shared by `MISS` (step-ops) and the graph simulation.

### Verdict Steps with Multiple STATUS Outcomes

Some steps (e.g., `verify_each` verifiers) offer more than one `STATUS` outcome in their `Reply with:` instructions — typically `STATUS: done` for success and `STATUS: retry` to request a redo. The step's `expects` string MUST accept every variant offered. If it doesn't, the agent's honest verdict is rejected by `validateExpects`, burning a step-level retry and pressuring the agent to emit a false `STATUS: done`.

**Pattern:**

```yaml
# Accepts both STATUS: done and STATUS: retry
expects: |
  regex:^STATUS:\s*(done|retry)\s*$
```

Replace the bare `STATUS: done` string with a regex that matches every variant. `validateExpects` passes either verdict; the completion handler (e.g., `handleVerifyEachCompletion` in `src/installer/step-ops.ts`) branches on the specific verdict after validation.

**Done-path-only keys:** Keys emitted only on success (`VERIFIED:`, `CHANGES:`, `TESTS:`) MUST NOT appear in the `expects` string of a dual-outcome step. A `STATUS: retry` output lacks these keys, so `validateExpects` would reject it. Enforce them in the completion handler instead — for `verify_each` verifiers, `handleVerifyEachCompletion` enforces `VERIFIED:` only on the `done` branch; the `retry` branch resets the story and reads `ISSUES:` from the output.

**Linter enforcement:** The static contract linter (`tests/workflow-contract-lint.test.ts`) checks this invariant across all bundled workflows. It uses `parseStatusVariants()` and `checkExpectsAcceptsVariant()` from `src/installer/workflow-contract.ts` to extract every `STATUS` variant from each step's `Reply with:` block and verify it against the step's `expects` string.

**Caller-provided keys:** for workflows where the caller supplies a key at launch (no step produces it), register the key in `CALLER_PROVIDED` in `src/installer/workflow-contract.ts`. Examples:

```typescript
// quarantine-broken-tests: caller supplies the branch name;
// the workflow has no triage/plan step that produces branch.
"quarantine-broken-tests": ["branch"],
```

**Testing your contract:** after adding regex enforcement, run:

```bash
npm run build && npm test
./run-all-e2e-tests          # scripted agents must satisfy all regex expects
```

The contract lint test (`tests/workflow-contract-lint.test.ts`) iterates every bundled workflow and verifies that no step consumes a key that is only mentioned (in Reply-with) but not enforced (in expects) by its upstream producer. The graph simulation (`tests/workflow-graph-simulation.test.ts`) synthesizes output for every `regex:^KEY:` pattern automatically — no hand-maintained candidate list required.

### Verifier Diff Idiom — Merge-Base Comparison

Verification steps MUST compare the branch against its **merge-base** with main — not against main's current tip. Use three-dot `git diff main...{{branch}}`, never two-dot `git diff main..{{branch}}`.

**Why it matters:** Tamandua runs multiple workflows concurrently against the same repo. When a sibling run merges to main mid-flight, two-dot `main..{{branch}}` picks up the new main tip and makes every not-yet-merged branch appear to *remove* the sibling's changes — verifiers reject honest work as "unclaimed modifications" or "hard constraint violations." The verifier then burns its entire retry budget re-running against the same unchanged diff (deterministic failure) and reroutes to a fixer that doesn't know it needs to rebase.

Three-dot `main...{{branch}}` compares against `merge-base(main, branch)` — Git's answer to "what did this branch change since it forked?" — which is immune to main moving during a run. Worktrees are cut from main's tip at launch, so the merge-base equals the `base_branch_sha` recorded in the run context, making the alignment exact.

**Correct (three-dot — verifier usage):**

```yaml
# In verifier step template or persona AGENTS.md:
git diff main...{{branch}}              # diff against merge-base
git diff --name-only main...{{branch}}  # sensitive-file scan
```

**Wrong (two-dot — DO NOT USE in verifiers):**

```yaml
git diff main..{{branch}}    # diffs against main's CURRENT tip — base-skew trap
```

**Exception — mergers and PR steps:** two-dot `{{original_branch}}..{{branch}}` is **correct** for merger/pr agents preparing an actual rebase or merge onto current main. These steps *intentionally* compare against the current tip to detect real merge conflicts. The merger persona's `git log` and `git diff --stat` idioms using two-dot must stay as-is.

**Linter enforcement:** a contract lint rule (`tests/workflow-contract-lint.test.ts`) scans every bundled workflow's verifier step templates and persona files for two-dot diff patterns against a base ref and fails the build if any are detected. Merger/pr agents are exempt. This rule is the regression net — the catalog must pass it to ship. The detection helper `hasTwoDotBaseComparison()` lives in `src/installer/workflow-contract.ts` alongside the existing key-enforcement and STATUS-variant helpers.

**Testing your contract:** after adding a verifier step with the three-dot idiom, run:

```bash
npm run build && npm test
./run-all-e2e-tests          # scripted agents must satisfy all regex expects
```

### Rebase-Loopback + Tree-Hash Attestation Idiom

Merge steps (`finalize_merge`) can validate post-merge correctness by combining three
layers: rebase-loopback, expects regex alternation, and tree-hash attestation. Together
they make post-rebase verification machine-enforced instead of claimed.

**Why it matters:** A conflict-free rebase produces a tree that has never run the test
suite — semantic conflicts are exactly what git does not flag. Without machine
enforcement, nothing structurally distinguishes "I ran tests on the post-rebase tree"
from "tests were green earlier so I said pass." The merger must *never* be the one
running tests; a separate verifier or tester must re-validate the rebased branch.

**The pattern (three layers):**

1. **Rebase-Loopback (merger persona):** IF YOU REBASED, YOU NEVER MERGE IN THIS
   INVOCATION. Any rebase ends the merger invocation with `STATUS: retry` +
   `REBASED: true`, routed via `on_fail.retry_step` to the tester or verifier step.
   The tester re-validates the rebased branch; the merger is re-invoked, finds the
   branch fast-forward-safe, and merges without rebasing. If main moved again, the
   cycle repeats until convergence. Cost: one extra tester/verifier invocation, paid
   only when a rebase actually happened.

2. **Expects Alternation (workflow.yml):** The merge step's `expects` must accept both
   merger reply shapes — `STATUS: done` (success) and `STATUS: retry` (rebase
   loopback) — so neither is rejected by `validateExpects`. Use regex alternation; a
   bare literal `REBASED: false` would reject the honest retry reply (the RSTY lesson
   — `validateExpects` is line-by-line, all-lines-must-match, so a literal line would
   reject the `STATUS: retry` output that lacks it).

   ```yaml
   # finalize_merge expects — accepts both done and retry verdicts:
   expects: |
     regex:^STATUS:\s*(done|retry)\s*$
     regex:^REBASED:\s*(true|false)\s*$
     regex:^(STATUS:\s*retry|REBASED:\s*false)\s*$
   ```

   The conjunction line (``regex:^(STATUS:\s*retry|REBASED:\s*false)\s*$``)
   encodes the implication *done ⇒ REBASED: false* — it rejects the forbidden
   ``STATUS: done + REBASED: true`` combination (merge of an untested rebased
   tree) while still accepting all three valid verdicts: done+false (clean
   merge), retry+true (honest rebase loopback), and retry+false.

   The `on_fail` block routes retry verdicts to the validation step:

   ```yaml
   on_fail:
     retry_step: test        # or verify for workflows without a tester
     max_reroutes: 4         # cycles allowed for convergence
   ```

3. **Tree-Hash Attestation:** Squash-merging a fast-forward-safe branch reproduces
   the branch tip's tree byte-for-byte, so enforce: merged tip tree hash == tree the
   tester validated. The tester or verifier emits
   `TESTED_TREE: $(git rev-parse HEAD^{tree})` in its output; this flows into run
   context as `{{tested_tree}}`. The merger's `done` reply includes a `MERGED_TREE:`
   line, and the merge step instructions require comparing the post-merge tree against
   `{{tested_tree}}`. A mismatch means the merger lied about what it merged — fail
   loudly.

   **Tester/verifier persona (add to Reply with):**

   ```
   TESTED_TREE: $(git rev-parse HEAD^{tree})
   ```

   **Tester/verifier expects (enforce emission):**

   ```yaml
   # test-step or verify-step expects:
   expects: |
     STATUS: done
     regex:^TESTED_TREE:\s*\S+
   ```

   **Merge-step input (make available to merger):**

   ```yaml
   input: |
     ...
     TESTED_TREE: {{tested_tree}}
     ...
   ```

   **Merger persona Phase 3:** after squash merge, compute
   `git rev-parse HEAD^{tree}`, compare against `{{tested_tree}}`, and fail loudly on
   mismatch.

   **Merger Reply with:**

   ```
   MERGED_TREE: $(git rev-parse HEAD^{tree})
   ```

**Branch safety:** The merger persona must operate on `{{branch}}` ONLY — explicitly
forbid discovering branches by listing. An alphabetical `feature/*` discovery once
squash-merged the wrong run's branch (the XBRC incident, proven via reflogs). If
`{{branch}}` does not exist, the merger must fail loudly with a structured reply,
never substitute another branch. Add this guard as the first step in the merger's
Required Process:

```bash
git rev-parse --verify {{branch}} || exit 1
```

**RETR-rugpull interaction:** When `finalize_merge` declares `on_fail.retry_step`
for rebase-loopback, reroute cycles consume the reroute budget first. If the budget
exhausts, the run still fails at `finalize_merge`, at which point rugpull detection
(`detectRugpull` in `src/installer/rugpull.ts`) still sees a failed `finalize_merge`
+ moved base branch tip and owns true merge-conflict recovery. Reroute cycles handle
rebase-test-merge convergence; rugpull is the last-resort recovery for genuine merge
conflicts. Both mechanisms coexist without conflict.

**Linter enforcement:** The contract lint test
(`tests/workflow-contract-lint.test.ts`) verifies that every `STATUS` variant offered
in the merge step's `Reply with:` block is accepted by the `expects` regex, and that
`REBASED` and `TESTED_TREE` keys are enforced by their upstream producers'
`expects`.

**Testing your contract:** after wiring the merge step with rebase-loopback and
attestation, run:

```bash
npm run build && npm test
./run-all-e2e-tests          # scripted agents must satisfy all regex expects
```

## Roles

| Role | Capabilities | Use For | Default timeout |
|------|--------------|---------|-----------------|
| `analysis`     | Read code, reason — no write/exec restrictions enforced by tamandua, used as a description on pi | Planner, reviewer, investigator, triager | 5400s (90m) |
| `coding`       | Read/write/exec — primary workhorse role            | Developer, fixer, setup        | 5400s (90m) |
| `verification` | Read + exec, no write — independent verification    | Verifier                       | 3600s (60m) |
| `testing`      | Read + exec for E2E, no write                       | Tester                         | 5400s (90m) |
| `pr`           | Read + exec only — runs `gh pr create`              | PR creation                    | 3600s (60m) |
| `scanning`     | Read + exec for security scanning                   | Security scanner               | 3600s (60m) |

If `role` is omitted, the role is inferred from the agent id (e.g., ids containing `planner` → `analysis`, `verifier` → `verification`, `tester` → `testing`, `scanner` → `scanning`, `pr` → `pr`, anything else → `coding`).

## Retry and Rerouting

When a step fails and exhausts its retry budget (`max_retries`), Tamandua consults the `on_fail` block for recovery directives. There are two layers: **retry (in-place)** and **reroute (cross-step)**.

### In-Place Retries

```yaml
- id: fix
  ...
  max_retries: 6          # Step-level retry budget. Default: 4. THIS IS THE
                           # number actually enforced when a step fails.
```

The step-level `max_retries` controls how many times the agent gets to retry _itself_ before the failure is considered permanent. An `on_fail.max_retries` field is accepted by the YAML schema but **not read** by the runtime — leave it out to avoid confusion. For `type: loop` steps, retries are tracked per-story (each story has its own retry budget, currently fixed at 4).

### Cross-Step Rerouting (RETR)

When a step exhausts its retries, Tamandua checks `on_fail.retry_step`. If declared, instead of failing the run, the system **reroutes** to an upstream producer step — giving it fresh context so it can produce a corrected output that the consumer can use.

```yaml
- id: setup
  agent: setup
  on_fail:
    # Setup failures often originate from an incomplete plan; re-planning refreshes understanding of the codebase
    retry_step: plan       # Reroute to the named upstream step.
    max_reroutes: 3        # How many times the CONSUMER may trigger a reroute. Default: 2.
```

When a reroute fires:
1. The **producer** (the step named by `retry_step`) is re-pended with status `pending` — its `retry_count` is _unchanged_. A bounded excerpt of the consumer's failure reason is written into the producer's output as `retry_feedback`, surfaced to the agent on its next run.
2. The **consumer** (the failing step) is reset to `waiting` with `retry_count = 0` — it earns a fresh chance after the producer redo. A per-step `reroute_count` counter (separate from `retry_count`) increments on each reroute.
3. Intermediate `done` steps between producer and consumer are left untouched. The existing pipeline advancement logic (`advancePipeline`) naturally re-pends the consumer when the producer completes again.

**Constraints:**
- `retry_step` MUST name an upstream step (lower `step_index`) in the same workflow. A downstream or unknown target is treated as a workflow spec error and fails the run with a clear message.
- `max_reroutes` applies to the consumer's `reroute_count`. When the consumer reaches this budget, the system falls through to normal failure behavior (run fails). Default is `2`.
- The reroute budget is **separate** from `retry_count`: the producer's `retry_count` never changes across reroutes; the consumer's `retry_count` resets to 0 on each reroute.
- Rerouting does **NOT** apply to `verify_each` verify steps (those referenced as `verify_step` in a loop's `loop_config`).
- `finalize_merge` steps **MAY** be wired with `retry_step` for rebase-loopback — reroute cycles consume the reroute budget first; if the budget exhausts and the run still fails at `finalize_merge`, rugpull detection (`detectRugpull` in `src/installer/rugpull.ts`) still owns true merge-conflict recovery. See [Rebase-Loopback + Tree-Hash Attestation Idiom](#rebase-loopback--tree-hash-attestation-idiom) for the full pattern.

**Observability:** Every reroute emits a `step.rerouted` event with `fromStep`, `toStep`, `rerouteCount`, `budget`, and a bounded reason. Budget exhaustion emits `step.reroute_budget_exhausted`. Both are logged with the same structured metadata.

### Complete Example

```yaml
steps:
  - id: plan
    agent: planner
    input: |
      Plan the implementation of {{task}}.
      Reply with STATUS: done.
    expects: "STATUS: done"

  - id: setup
    agent: setup
    input: |
      Set up the repo at {{repo}} for {{task}}.
      Reply with STATUS: done.
    expects: "STATUS: done"
    max_retries: 4
    on_fail:
      retry_step: plan       # Setup failures often stem from a flawed plan; re-planning refreshes context
      max_reroutes: 2        # Allow up to 2 reroutes back to plan before failing the run

  - id: implement
    agent: developer
    input: |
      Implement {{task}}.
      Reply with STATUS: done.
    expects: "STATUS: done"
    max_retries: 4
```

In this example: if `setup` exhausts its 4 retries, it reroutes to `plan` (up to 2 times). The planner gets rerun with `retry_feedback` describing why setup failed, giving it a chance to fix the plan. If both reroutes are exhausted, the run fails — terminally and automatically.

### Summary Table

| Field | Scope | Default | Description |
|-------|-------|---------|-------------|
| `max_retries` (step-level) | Individual step retries | 4 | Times the step retries _itself_ |
| `on_fail.max_retries` | — | — | **Not read** by the runtime — do not use |
| `on_fail.retry_step` | Cross-step reroute trigger | none | Upstream step to reroute to on retry exhaustion |
| `on_fail.max_reroutes` | Reroute budget on the consumer | 2 | How many times the consumer can trigger a reroute |

## Loops

Loop steps repeat over stories generated by a previous step (the planner emits `STORIES_JSON:`).

```yaml
- id: implement
  type: loop
  loop:
    over: stories          # Currently only "stories".
    completion: all_done   # Currently only "all_done".
    verify_each: true      # Optional. Run verify_step after each story.
    verify_step: verify    # Optional. Step id of the verifier.
    fresh_session: true    # Optional. Start a new agent session per story.
```

YAML uses snake_case (`fresh_session`, `verify_each`, `verify_step`); the camelCase variants (`freshSession`, `verifyEach`, `verifyStep`) are also accepted for backward compatibility.

## Installing Workflows

```bash
# List available bundled workflows
tamandua workflow list

# Install a bundled workflow by name
tamandua workflow install <workflow-id>

# Install all bundled workflows at once
tamandua workflow install --all

# Run it
tamandua workflow run <workflow-id> "your task description"
```

`tamandua workflow install` only accepts the **id of a workflow bundled with this repo** (a directory under `workflows/` in the tamandua source checkout). Installing a custom workflow from a filesystem path or a remote URL is not currently supported by the CLI — to add a custom workflow, drop it into the `workflows/` directory of your tamandua checkout and reinstall.
