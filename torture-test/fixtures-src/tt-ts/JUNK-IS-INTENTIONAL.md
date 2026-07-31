# JUNK IS INTENTIONAL

The untracked files in this repository (`package-lock.json`, `node_modules/`,
`operator-notes.local`) are **intentional probes** for the tamandua torture
test suite.

## DO NOT

- Add them to `.gitignore`
- Delete them
- Clean them up with any tool or script
- Stage or commit them

## WHY

These files serve as regression signals for TSTX committed-tree keying and
the tracked-dirty gate — the system must tolerate harmless untracked junk
while hard-failing on tracked drift.

Violating this will break the torture test campaign.
