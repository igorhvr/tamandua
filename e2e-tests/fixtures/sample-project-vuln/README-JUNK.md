# Intentional package-lock.json Junk Probe

This fixture intentionally lets `npm install` generate an untracked,
unignored `package-lock.json`, so tester runs are allowed to dirty their
worktrees. The file is a load-bearing tracked-content ledger-gate regression
probe.

Do not commit or gitignore `package-lock.json`. Do not sanitize it, and do not
add a clean-tree tester contract.

See [`../JUNK-IS-INTENTIONAL.md`](../JUNK-IS-INTENTIONAL.md) for the full
rationale and the deliberate clean counterpart.
