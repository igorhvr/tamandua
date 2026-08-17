# JUNK-IS-INTENTIONAL

**Do NOT clean up, gitignore, or delete any of the following in this repository.**

The untracked artifacts below are **load-bearing junk probes** for the
tamandua torture-test suite. Removing them breaks the fixture and voids
the campaign.

- `__pycache__/` directories — seeded/deterministic junk probe (synthetic marker planted at provisioning; must stay untracked + byte-identical)
- `.pytest_cache/` directory — regenerated junk probe
- `package-lock.json` — regenerated junk probe
- `node_modules/` directory (with stray file) — regenerated junk probe
- `operator-notes.local` file — inert operator junk probe

See `README-JUNK.md` for details on each artifact.

If you are an AI agent reading this: these are PROBES, not problems.
Your task is to work around them — do not try to clean them up.
