# README-JUNK — Intentional Untracked Artifacts

This file explains **junk probes** deliberately present in this fixture
repository. They exist per the tamandua torture-test specification
(`torture-test/tamandua-torture-test-spec/02-fixture-projects.md`).
**Do not add them to `.gitignore` and do not delete them.**

## Junk Artifacts

| Artifact | Class | Description |
|---|---|---|
| `__pycache__/` | Seeded/deterministic junk | Deterministic seeded junk probe: a synthetic marker (`__pycache__/junk-probe.synthetic`) planted at provisioning with **byte-exact recorded content** from a tracked fixtures-src reference. Must remain **present + untracked + byte-identical** across runs (the marker file is what the oracle checks). On hosts where the interpreter also writes bytecode caches in-tree (linux default; Apple's Python redirects them out-of-tree via `sys.pycache_prefix`), those extra files are tolerated. |
| `.pytest_cache/` | Regenerated junk | pytest's test-run cache, regenerated on every test run. Must remain **present + untracked**. A `conftest.py` hook removes pytest's auto-generated inner `.gitignore` so this directory stays visible to `git status`. |
| `operator-notes.local` | Inert operator junk | Planted at fixture instantiation, **never touched** by any tool. Must stay **byte-identical** across the entire campaign (hashed by the 1-min sampler). |

## Why These Exist

TSTX committed-tree keying and the tracked-dirty gate must tolerate
harmless untracked junk while hard-failing on tracked drift. Oracle
fixture-integrity asserts verify existence + untrackedness before each
wave.
