# README-JUNK — Intentional Junk Artifacts

This file explains **junk probes** deliberately present in this fixture
repository. They exist per the tamandua torture-test specification
(`torture-test/tamandua-torture-test-spec/02-fixture-projects.md`).
**Do not add them to `.gitignore` and do not delete them.**

## Junk Artifacts

| Artifact | Class | Description |
|---|---|---|
| `testdata/exec-bit-probe.sh` | Committed inert probe | A committed shell script with the executable bit set (`chmod +x`). Content is a harmless echo statement. Probes tree-hashing exec-bit handling across platforms — oracles verify the exec bit survives `git clone` and `rsync -a`. Must remain **committed + tracked + exec-bit intact** across the entire campaign. |
| `operator-notes.local` | Untracked inert probe | Planted at fixture instantiation, **never touched** by any tool. Must stay **byte-identical** across the entire campaign (hashed by the 1-min sampler). |

## Why These Exist

TSTX committed-tree keying and the tracked-dirty gate must tolerate
harmless untracked junk while hard-failing on tracked drift. Oracle
fixture-integrity asserts verify existence + byte-identity before each
wave.

Go produces no regenerated junk in-tree (`go test` outputs to `GOCACHE`
outside the module), so the spec-designated junk probes for the Go
fixture are the exec-bit probe and the inert operator-notes file.
