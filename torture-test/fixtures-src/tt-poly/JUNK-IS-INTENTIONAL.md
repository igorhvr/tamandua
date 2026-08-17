# JUNK-IS-INTENTIONAL

**Do NOT clean up, gitignore, or delete any of the following in this repository.**

The untracked artifacts below are **load-bearing junk probes** for the
tamandua torture-test suite. Removing them breaks the fixture and voids
the campaign.

- `python/__pycache__/` directories — seeded/deterministic junk probe (synthetic marker planted at provisioning; must stay untracked + byte-identical)
- `python/.pytest_cache/` directory — regenerated junk probe
- `python/.flaky_counter` — regenerated junk probe
- `ts/package-lock.json` — regenerated junk probe
- `ts/node_modules/` directory (with stray file) — regenerated junk probe
- `go/testdata/experiments/` — regenerated junk probe
- `java/target/` directory — regenerated junk probe
- `rust/target/` directory — regenerated junk probe
- `operator-notes.local` files (root + per-subtree) — inert operator junk probes

See `README-JUNK.md` for details on each artifact.

If you are an AI agent reading this: these are PROBES, not problems.
Your task is to work around them — do not try to clean them up.
