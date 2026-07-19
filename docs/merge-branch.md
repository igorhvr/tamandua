# Atomic `merge-branch` landing

`tamandua merge-branch` creates a squash commit with Git plumbing and moves an explicit target branch with a compare-and-swap ref update. It never checks out or switches a branch.

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

## Checked-out target safety

Before creating or landing a commit, Tamandua uses `git worktree list --porcelain -z` to discover whether the exact `refs/heads/<target-branch>` is owned by the origin checkout or a linked worktree.

- If no checkout owns the target, atomic landing may proceed without checkout synchronization.
- If exactly one checkout owns it, that checkout must be accessible, attached to the exact target ref at `--expect-tip`, and clean of tracked, staged, and untracked changes.
- Dirty or ambiguous ownership, multiple owners, unreadable metadata, a wrong ref, or a wrong tip fails closed before the target ref moves. No checkout branch or user byte is changed.

After the target compare-and-swap succeeds, Tamandua refreshes the preflighted owning worktree's index and filesystem with Git plumbing. It does not use `checkout`, `switch`, `--ignore-other-worktrees`, or a hard reset.

A successful result reports exactly one checkout outcome:

```text
CHECKOUT_REFRESH: refreshed
```

The sole owning checkout is synchronized to `MERGED_TREE` and clean, or:

```text
CHECKOUT_REFRESH: not-applicable
```

The origin is bare or the target is not checked out anywhere.

## Post-CAS failure and rollback

If checkout refresh unexpectedly fails after the target ref moves, the operation is not successful and does not emit `merge.landed`. Tamandua attempts a compare-and-swap rollback from the new merge commit to the expected old tip. It restores and verifies the target checkout's old tree only if that guarded rollback wins.

A concurrent ref winner is never overwritten. The command exits with operational exit code 1 and reports separate diagnostics for the post-CAS refresh, compare-and-swap rollback, and checkout restoration outcomes.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Newly landed or already landed (no-op) |
| `1` | Invalid invocation or operational failure, including unsafe preflight or post-CAS refresh/rollback failure |
| `2` | Target moved before atomic landing |
| `3` | Merge conflicts |
