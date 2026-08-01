# README-JUNK — Intentional Junk Artifacts

This file explains **junk probes** deliberately present in this fixture
repository. They exist per the tamandua torture-test specification
(`torture-test/tamandua-torture-test-spec/02-fixture-projects.md`).
**Do not add them to `.gitignore` and do not delete them.**

## Junk Artifacts

| Artifact | Class | Description |
|---|---|---|
| `target/` | Regenerated junk | Produced by `cargo build` / `cargo test`. Deliberately NOT gitignored — regenerated on every build. Oracles verify untracked presence in `git status` after a test run. Also probes worktree disk hygiene and TSTX hash cost on large untracked trees. |
| `operator-notes.local` | Untracked inert probe | Planted at fixture instantiation, **never touched** by any tool. Must stay **byte-identical** across the entire campaign (hashed by the 1-min sampler). |

## Why These Exist

TSTX committed-tree keying and the tracked-dirty gate must tolerate
harmless untracked junk while hard-failing on tracked drift. Oracle
fixture-integrity asserts verify existence + byte-identity before each
wave.

`Cargo.lock` is a **committed and tracked** file (not junk) — it
ensures deterministic builds across the campaign.
