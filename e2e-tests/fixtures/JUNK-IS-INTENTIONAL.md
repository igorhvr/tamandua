# Fixture Junk Is Intentional

The fixtures listed below intentionally allow `npm install` to generate an
untracked `package-lock.json`:

- `sample-project/`
- `sample-project-review/`
- `sample-project-vuln/`

This untracked file is a load-bearing regression probe for the tracked-content
ledger gate. Real tester commands can create untracked build or package-manager
artifacts after a commit has been selected for testing. Suite evidence is keyed
to committed and tracked content, so this harmless untracked junk must not make
the tested tree ineligible to land.

For these three fixtures:

- Do not commit `package-lock.json`.
- Do not add `package-lock.json` to `.gitignore` or another ignore rule.
- Do not clean or delete it as part of the fixture workflow.
- Do not add a clean-working-tree contract to tester steps.

`sample-project-concurrent/` is the deliberate clean counterpart. It commits
its `package-lock.json` by design and is therefore excluded from the junk-probe
guard.
