# Atomic `merge-branch` landing

`tamandua merge-branch` creates a squash commit with Git plumbing and moves an explicit target branch with a compare-and-swap ref update. When the target is attached to a worktree, the command manages that checkout itself without porcelain commands or operator intervention.

## Invocation

```text
tamandua merge-branch \
  --origin <repo-path> \
  --branch <feature-branch> \
  --into <target-branch> \
  --expect-tip <target-commit> \
  --message <commit-message>
```

Every option is required exactly once. Unknown, duplicate, positional, unsupported, or valueless inputs are rejected with exit code 1 before Git mutation.

## Managed checked-out target safety

1. Tamandua verifies `refs/heads/<target-branch>` resolves to `--expect-tip`, then discovers ownership from strict `git worktree list --porcelain -z` metadata.
2. A no-op landing does not move a ref or checkout. When a single owner worktree of the target is known, Tamandua reads that owner's live checkout HEAD: equal to the landed target tip reports `CHECKOUT_REFRESH: already-coherent`; different reports `CHECKOUT_REFRESH: checkout-not-at-tip`; an unowned target or unreadable checkout metadata reports `CHECKOUT_REFRESH: no-checkout-to-refresh`.
3. For a mutating landing with one attached owner, Tamandua first creates a uniquely named backup branch at the old target tip and parks the owner on it. The target ref is advanced only after parking succeeds.
4. A clean owner is advanced in place, reattached to the target, and reports `CHECKOUT_REFRESH: refreshed`. Untracked files alone still count as clean, but an incoming untracked-file collision safely falls back to parking.
5. A dirty owner is left attached to the backup branch with local tracked changes untouched and reports `CHECKOUT_REFRESH: parked:<backup-branch>`, followed by `PARKED_BRANCH` and `PARKED_REASON`. A clean owner whose in-place advance is refused uses the same parked outcome.
6. A bare origin, an origin whose target is not checked out, or an otherwise unowned target is landed without touching a checkout and reports `CHECKOUT_REFRESH: no-checkout-to-refresh`.

Managed parking is crash-safe: interruption can leave the repository untouched, consistently parked at the old tip, or fully refreshed. The command rolls back parking if the target compare-and-swap fails.

Tamandua still refuses a mutating landing when multiple worktrees own the target, worktree metadata is invalid or ambiguous, or the attached owner has a Git operation in progress. These are bounded operational failures; Tamandua does not partially land the target.

## Commit signing

The squash commit honors the operator's configured commit signing (`commit.gpgsign`, `gpg.format`, `user.signingkey`), read from the landing repository's local config first and then the global config — each key resolved independently. `git commit-tree` does not consult `commit.gpgsign`, so when signing is enabled Tamandua passes `-S` and the resolved format/key overrides explicitly on the landing invocation.

A landed result reports the outcome as `SIGNING: signed` (the commit carries a `gpgsig` header), `SIGNING: unsigned` (no signing configured, or a no-op landing with no new commit), or `SIGNING: unsigned-matchlock` (a Matchlock guest-context run, where signing keys are never projected into the guest). When signing is configured but the commit cannot be signed, the landing fails with exit code 1 and a detail that names signing; the target ref is never advanced to a silently unsigned commit.

A landing is treated as a Matchlock guest context when the run context records `matchlock_context=true`, or when the process environment carries `TAMANDUA_MATCHLOCK_GUEST=1`. In that case signing is intentionally skipped even when `commit.gpgsign=true`: the guest env projection forwards the four `GIT_AUTHOR`/`GIT_COMMITTER` identity variables but no signing keys, so there is nothing to sign with. The `merge.landed` event carries a machine-readable `signingSkipped` reason explaining the exemption, and the target still advances with an unsigned squash commit.

## Verified landing report

Every successful landing reports the verified target tips alongside the existing result fields:

```text
STATUS: landed
NOOP: <true | false>
MERGED_COMMIT: <sha>
MERGED_TREE: <tree-sha>
TARGET: refs/heads/<target-branch>
TARGET_TIP_BEFORE: <sha>
TARGET_TIP_AFTER: <sha>
CHECKOUT_REFRESH: <refreshed | already-coherent | no-checkout-to-refresh | checkout-not-at-tip | parked:branch>
PARKED_BRANCH: <branch>              # parked outcomes only
PARKED_REASON: <local-changes | advance-refused: detail>   # parked outcomes only
```

`TARGET_TIP_BEFORE` is the compare-and-swap verified `--expect-tip` the landing was based on. `TARGET_TIP_AFTER` is a live `refs/heads/<target-branch>` read taken immediately before reporting, so a no-op never implies a checkout state that was not inspected. The same two fields are recorded on every `merge.landed` event.

`CHECKOUT_REFRESH` states only what was verified:

| Value | Meaning |
|-------|---------|
| `refreshed` | A clean attached target was advanced in place and remains attached |
| `already-coherent` | An attached no-op target's live checkout HEAD equals the target tip |
| `checkout-not-at-tip` | A live target checkout was read and is not at the target tip |
| `no-checkout-to-refresh` | No usable target checkout was found to verify or refresh |
| `parked:<branch>` | The target landed while its prior checkout stayed safely on `<branch>` |

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Newly landed or already landed (no-op) |
| `1` | Invalid invocation or operational failure, including an unsafe owner state |
| `2` | Target moved before atomic landing |
| `3` | Merge conflicts |
