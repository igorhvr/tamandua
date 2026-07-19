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

## Checked-out target safety — fail-closed owner policy

1. Target-tip validation happens first: Tamandua verifies `refs/heads/<target-branch>` resolves to `--expect-tip` before any further action.
2. Tamandua then discovers ownership with exact strict `git worktree list --porcelain -z` metadata.
3. Any unique root or linked checkout owning the target causes bounded operational refusal with exit code 1. This applies even to clean targets and would-be no-op targets.
4. Refusal happens **before** candidate resolution, merge-base computation, merge/object creation, target-ref mutation, index/filesystem mutation, or event emission.
5. This is not a partial landing and is not a retryable lock wait.

Every currently reachable successful result reports:

```text
CHECKOUT_REFRESH: not-applicable
```

Success is possible only for bare origins or otherwise unowned targets.

Historical `refreshed` and `already-coherent` values remain valid in the exported `CheckoutRefreshOutcome` type and old persisted events for source and data compatibility, but current production does not emit them.

## Operator remedy

If the target is owned by any checkout, the operator must make the target ref unowned by every worktree (remove the owning worktree or checkout a different branch in that worktree) or use a bare origin. Then re-verify the expected tip and retry.

Do not use bypass flags, direct ref writes, checkout/reset tricks, or manual editing of worktree metadata — those can corrupt the worktree index and are not supported by Tamandua.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Newly landed or already landed (no-op) |
| `1` | Invalid invocation, operational failure, or checked-out target refusal |
| `2` | Target moved before atomic landing |
| `3` | Merge conflicts |
