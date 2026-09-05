# R4a independent review: OMCX shared marker-context correction

Beads tamandua-6sy.4.2. This is suite-only corrective feedback within the
already approved S48/S52 contract. Use the SAME R4a dsh workflow; no product
files, new dependencies, permission profiles, or live fault probes.

## Tester routing

Return this finding to US-006, the shared marker-extraction story. If SGRD
is also still unfixed, the normal step-failure reason must cite BOTH US-006
and US-014, then name this task and R4a-SGRD-review-correction.md.
This supersedes ONLY the earlier SGRD handoff's single-story citation rule.
Keep the two stories separate; each keeps one focused gate. Do not re-plan
or reset unrelated completed stories, and do not edit live state directly.

Use the normal origin-launcher step fail command ONCE for the step actually
claimed. Do not submit STATUS: retry to this tester's done-only completion
contract, fake a done marker, or repeatedly fail an unclaimed step.
Ordinary bounded retries remain ordinary retries before on_fail reroutes.

## Exact independently observed cases

Pinned source11de76f6b2a022de22c46499273ee2f9d6182c66:
torture-test/oracles/lib/test-markers.mjs SHA256
a3dff8629bf89060df49e24a90be755480739372f7833b30313146e711ed78ef.

Retained origin evidence:
torture-test/var/review-logs/r4a-signal-guard-T7yG5O/
marker-context-evidence.jsonl and marker-context-driver.txt.

The whole actual dependency-free module was loaded from git show in memory.
Eight JavaScript samples were syntax-compiled but NEVER executed.
Direct skip/focus and comment/string controls pass. Five cases are wrong:
callback-body skip: and only: labels are falsely counted as option keys;
quoted skip/only keys on actual registration options are missed; a regex
literal containing test.only(example) is falsely counted as a registration.
The supplied evidence records every input and expected/actual count.

This is helper-level evidence, not yet a demonstrated full-oracle false
verdict. Preserve that distinction in all reports.

## Developer correction and gate

Correct the bounded JS lexical/context handling in the shared extractor.
Actual top-level registration option objects must be distinguished from
callback bodies; equivalent quoted/unquoted option keys should agree;
regex-literal contents are not executable test registrations. Preserve
string/comment/docstring exclusions, nested-object exclusions, direct
markers and all existing non-JS language behavior. Do not expand this into
a general dynamic-alias evaluator or a wholesale language-parser project.
The shared focus counter must agree with the same corrected context rules.

ONE designated gate: focused O8 regression coverage using the actual shared
extractor, plus fixture-backed oracle cases showing a benign body/regex
sample stays non-failing and a genuine quoted marker is detected. Reuse
the existing focused O8 test file/fixture infrastructure where practical.
No assertion relaxation or weakened seeded-test checks.

Normal build/npm under the shared advisory lock still applies. No ad-hoc
scratch removal, live PID experiments, or edits while a full suite is queued
or running. Keep logs and scratch. Coordinator independently repeats the
old-red/new-green helper cases against the corrected commit.

SGRD's separate US-014 correction, normal declared-command restoration,
and all deferred combined-tree/Mac/real/certification gates remain required.
Neither this task nor any prior green ledger waives those gates.
