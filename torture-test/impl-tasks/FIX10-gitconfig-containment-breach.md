# FIX10: torture case escaped containment and overwrote the OPERATOR's ~/.gitconfig

CONFIRMED BREACH (evidence 2026-08-08): the operator's real
`~/.gitconfig` was modified in place at 2026-08-05 16:51 local —
during the first Tier-0 acceptance double-run — replacing user.name/
user.email with `Tamandua Tier-0 <tier0@tetradactyla.invalid>` while
preserving unrelated sections (signingkey, push, merge). 14 subsequent
dev-repo commits carry the wrong author. The operator identity has
been restored by hand; do NOT touch ~/.gitconfig in this task.

This is exactly the containment class spec 01 (TT_HOME isolation) and
the O18 hygiene canaries exist to prevent: a case/hook ran
`git config --global ...` with the REAL HOME in effect (or with
GIT_CONFIG_GLOBAL unset/mis-scoped).

## Work

1. Find the exact writer: audit every place under torture-test/ that
   runs `git config --global` or relies on GIT_CONFIG_GLOBAL /
   HOME containment (cases/hooks/run-w0.1 sets it correctly INSIDE
   its env — check who invokes hooks WITHOUT the contained HOME:
   tt-controller local-case env assembly, scenario setup scripts,
   daemon-control env_for_kind, self-tests). Correlate with what
   executed around 2026-08-05T16:31Z-19:51Z (tier0 campaigns
   campaign-20260805T140754Z and campaign-20260805T163154Z are in
   torture-test/var/results/ with per-case timing evidence). Name the
   culprit in your report with evidence.
2. Fix the leak: every spawned case/hook/scenario must get the
   contained HOME (and GIT_CONFIG_GLOBAL where git identity is
   needed) from the controller env — never the operator's. Fail
   closed: if the contained HOME cannot be established, the case must
   error, not fall through to real HOME.
3. Add the O18-style hygiene canary the spec calls for: before a
   campaign starts, snapshot hash of ~/.gitconfig (and a short list of
   other operator-identity files: ~/.ssh/config if present, crontab);
   after the campaign, verify unchanged; any diff = campaign-level
   FINDING (not silent). Wire it into the controller so every tier
   gets it automatically.
4. Prove: run `./run-torture-test --tier0` (scripted, zero tokens)
   and show the canary section in the report + ~/.gitconfig hash
   unchanged. Grep-prove no remaining `git config --global` in
   torture-test/ executes outside a contained-HOME env.

## Hard constraints

- Files ONLY inside torture-test/. Zero tokens. Live daemon untouched.
- Do not rewrite git history for the 14 mis-authored commits; note
  them and move on.
