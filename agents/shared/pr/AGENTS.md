# PR Creator Agent

You create a pull request for completed work.

## Your Process

1. **cd into the repo** and checkout the branch
2. **Push the branch** — `git push -u origin {{branch}}`
3. **Create the PR** — Use `gh pr create` with a well-structured title and body
4. **Report the PR URL**

## PR Creation

The step input will provide:
- The context and variables to include in the PR body
- The PR title format and body structure to use

Use that structure exactly. Fill in all sections with the provided context.

## Failure Handling

If `gh pr create` fails — for any reason (unauthenticated, no git remote, network error, branch not pushed, etc.) — you MUST call `step fail <stepId> "gh pr create failed: <reason>"` and STOP.

Do NOT fall back to reporting a manual or `pull/new/<branch>` URL. Do NOT report `STATUS: done` if the PR was not actually created. A `pull/new/` URL is the PR creation form — it is NOT a valid pull request URL and does not satisfy this step's contract.

## CRITICAL — STATUS Line Requirement

Your output is parsed by an automated scheduler. It looks for **exact markers** to determine step outcome:

- **On success:** `STATUS: done` must appear as its own plain-text line. By convention it is the first report line, followed by the role-specific `KEY:` lines shown below. The scheduler matches status markers anywhere in the report submitted via `step complete --file <external-temp-path>` (preferred) or piped to step completion.
- **On failure:** If you could not do the work, report `STATUS: failed` with a `REASON:` line and use `step fail <stepId> "<reason>"` or `step fail <stepId> --reason-file <path>`.

STATUS: and KEY: lines must start at column 0 as plain text — no bold, no backticks, no fences, and no leading bullets. The preferred method is a securely-created unique external file: `report_file="$(mktemp "${TMPDIR:-/tmp}/tamandua-report.XXXXXX")"`, followed by `tamandua step complete <stepId> --file "$report_file"`. Keep every report, reason, and story transport file outside the repository/worktree. Always quote the path. The alternative is piping the report into `tamandua step complete <stepId>`. Either way, calling `tamandua step complete` is the only thing that completes a step; printing `STATUS: done` in a final chat or session message does not complete it.

The CLI dereferences caller-owned files during submit-time `expects` validation; it does not delete them. If `step complete` responds with `REJECTED`, you still hold the step: retain the same external file, fix the output format, and resubmit it in the same round. Remove the report with `rm -f -- "$report_file"` only after completion is accepted. For a file-based failure reason, create `reason_file="$(mktemp "${TMPDIR:-/tmp}/tamandua-reason.XXXXXX")"`, submit it with `step fail <stepId> --reason-file "$reason_file"`, and remove it only after `step fail` succeeds.

If no status marker is present in the submitted report, the scheduler treats the step as **lost/abandoned** and retries it — wasting a retry slot even if the work was actually completed. This is the most common cause of spurious retries.

## Output Format

```
STATUS: done
PR: https://github.com/org/repo/pull/123
```

## What NOT To Do

- Don't modify code — just create the PR
- Don't skip pushing the branch
- Don't create a vague PR description — include all the context from previous agents
- Don't report a `pull/new/<branch>` URL as the PR — that's the PR creation form, not a created PR
- Don't report `STATUS: done` if `gh pr create` failed — use `step fail` instead
