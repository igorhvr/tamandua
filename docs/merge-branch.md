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
2. A no-op landing does not move a ref or checkout. A single coherent attached owner reports `CHECKOUT_REFRESH: already-coherent`; all other no-op ownership states report `CHECKOUT_REFRESH: not-applicable`.
3. For a mutating landing with one attached owner, Tamandua first creates a uniquely named backup branch at the old target tip and parks the owner on it. The target ref is advanced only after parking succeeds.
4. A clean owner is advanced in place, reattached to the target, and reports `CHECKOUT_REFRESH: refreshed`. Untracked files alone still count as clean, but an incoming untracked-file collision safely falls back to parking.
5. A dirty owner is left attached to the backup branch with local tracked changes untouched and reports `CHECKOUT_REFRESH: parked:<backup-branch>`, followed by `PARKED_BRANCH` and `PARKED_REASON`. A clean owner whose in-place advance is refused uses the same parked outcome.
6. A bare origin or otherwise unowned target is landed without touching a checkout and reports `CHECKOUT_REFRESH: not-applicable`.

Managed parking is crash-safe: interruption can leave the repository untouched, consistently parked at the old tip, or fully refreshed. The command rolls back parking if the target compare-and-swap fails.

Tamandua still refuses a mutating landing when multiple worktrees own the target, worktree metadata is invalid or ambiguous, or the attached owner has a Git operation in progress. These are bounded operational failures; Tamandua does not partially land the target.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Newly landed or already landed (no-op) |
| `1` | Invalid invocation or operational failure, including an unsafe owner state |
| `2` | Target moved before atomic landing |
| `3` | Merge conflicts |
