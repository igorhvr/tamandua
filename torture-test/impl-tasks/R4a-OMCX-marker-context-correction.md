# R4a independent review: OMCX shared marker-context correction

## Review of 7d9573d2: new for-header regressions — 2026-09-05T05:05Z

The committed operand correction passes ALL original eight and ALL ten
consolidated slash/operand cases. Preserve those improvements. Source review
of its NEW for-header bookkeeping found two regressions relative to be5d72e0:

- `(function () { for (const item of /test.only(example)/.exec(text) ?? []) {} });`
  contains a regex literal, no focused registration. Old focus=0; new focus=1.
  A genuine for-of header can be nested inside another open parenthesis;
  requiring the entire parenthesis stack to have length one loses it.
- `async function sample() { for await (const item of /test.skip(example)/.exec(text) ?? []) {} }`
  likewise contains no skipped registration. Old skip=0; new skip=1.
  The new header identification does not recognize the for-await header.

One adjacent negative arm in the SAME six-case check remains wrong in BOTH
versions: `for (let of = 8; of / test.only('focus', () => {}) / 2; of--) {}`
must keep focus=1, but returns 0. Here `of` is an ordinary variable in a
semicolon-delimited for header, not the for-of separator. Merely treating
every `of` inside a for header as a keyword is not sufficient. The other
three arms preserve top-level genuine for-of regex opacity, the now-fixed
ordinary `of` division outside a header, and genuine typeof-regex opacity.

Exact current commit: 7d9573d244fc7c0069630d95a157fc845ed8a27a; tree
6ceeb55ac5417d1eba3e7441714fbd385541a719. Actual helper SHA256:
88459a5d2b3ad0b9e7e40b89bf4c166976fca20fbf49c169b7dbed959884231c.
The preceding be5d72e0 helper hash is 437aac6a9445b1b282b193ce902728afa3d830276b9d39e59964f93e2c00818d.
All six inputs were syntax-compiled, NEVER executed. Actual committed modules
were loaded in memory. This is helper proof, not a full-oracle verdict claim.
Retained proof in the origin's r4a-signal-guard-T7yG5O review directory:
`marker-for-context-7d9573d2-{driver.txt,evidence.jsonl}`. Original-eight and
consolidated-ten passing records are `marker-context-7d9573d2-*` and
`marker-slash-operands-7d9573d2-*` in that same directory.

This feedback corrects the newly introduced for-header handling within SAME
US-006. Extend the SAME focused O8 gate with these controls; keep the existing
fixture-backed branches, no additional broad battery or parser project.
Preserve current genuine-keyword regex behavior AND ordinary-identifier
division. Do not edit while the committed-tree npm gate is running. The
normal VERIFIER STATUS: retry / ISSUES: US-006 protocol below still applies
if these failures remain; do not reopen already-fixed cases or US-014 here.
No direct state/counter writes, missing-ledger waiver, product edit, pause,
origin push or live refresh. Scope is bounded regression repair, not a claim
that this hand-written scanner supports every JavaScript grammar production.

## Same slash correction: operand preservation — 2026-09-05T04:22:44Z

A consolidated ten-case differential check of the SAME committed 08a9933a
lexer adds three closely related regressions to the four cases below.
Each is syntax-valid JavaScript; the actual OLD module sees the registration
but 08a9933a wrongly swallows it as regex contents:

- `const RETURN = 8; const ratio = RETURN / test.only('focus', () => {}) / 2;`
  must keep focus=1. JavaScript keywords are case-sensitive; `RETURN` here
  is an ordinary identifier, not the `return` keyword.
- `const of = 8; const ratio = of / test.skip('skip', () => {}) / 2;`
  must keep skip=1. Contextual `of` here is an identifier operand, not
  an operator or the separator of a for-of header.
- `const holder = { return: 8 }; const ratio = holder.return / test.only('focus', () => {}) / 2;`
  must keep focus=1. A keyword-spelled property in a member expression
  is an operand; treating its spelling as an unconditional regex prefix
  hides the actual registration after the division sign.

The added genuine-regex control `const kind = typeof /test.only(example)/;`
correctly returns focus=0 on 08a9933a; keep it correct. The consolidated
driver also retains all six previous slash cases. Old/new source hashes
are unchanged; all inputs were syntax-compiled, NEVER executed. Proof:
r4a-signal-guard-T7yG5O/marker-slash-operands-08a9933a-{driver.txt,evidence.jsonl}.
This is still actual-helper evidence, not a full-oracle verdict claim.

These are additional regression arms in the SAME bounded US-006 slash/token
correction and SAME designated focused O8 gate, not extra stories or a
request for a general JS parser. Add these unit controls alongside the four
below and existing original eight. The two requested fixture-backed branches
below remain sufficient for that gate; do not add a broad battery here.
The same normal verifier retry protocol below applies if any remain broken.

## Follow-up on committed correction 08a9933a — 2026-09-05T04:07:59Z

The first correction passes ALL eight original examples. Independent review
of signed commit 08a9933a55cfad31143af1b764b8f4f99efd20e8, tree
609072cd9a6ac7a7221327820a78b2a27a3fcd28, nevertheless finds two NEW
regressions and two remaining regex-context miscounts. Actual helper SHA256:
fde1dab3ab1af2863bc82d1dfb7789cd774aaf0a7fd98c5bbeea330753c84afe.

Exact retained proofs in the same r4a-signal-guard-T7yG5O review directory:
marker-context-08a9933a-{driver.txt,evidence.jsonl} (8/8 original controls),
marker-slash-08a9933a-{driver.txt,evidence.jsonl} (old/new actual modules).
All six additional JavaScript samples were syntax-compiled, NEVER executed.
The diagnostic runs only the actual dependency-free marker module in memory.
These are helper-level findings, not claimed full-oracle verdicts.

- `n++ / test.only('focus', () => {}) / 2` contains a REAL registration.
  The old module counts focus=1; the new module wrongly returns focus=0.
- `n-- / test.skip('skip', () => {}) / 2` likewise changes from correct
  skip=1 to incorrect skip=0. The preceding postfix token makes the new
  slash heuristic swallow division operands as a regex literal.
- `if (enabled) /test.only(example)/.test(text);` is a regex literal,
  not a focused registration; both versions wrongly count focus=1.
- `while (enabled) /test.skip(example)/.test(text);` similarly wrongly
  counts skip=1. Closing a control-condition parenthesis does not have
  the same slash context as closing an ordinary call/expression.
- Ordinary division retains its real registration, and the original
  assignment-regex example is now correctly opaque: keep these controls.

This remains US-006, not a new story or general JavaScript parser project.
Correct the bounded token/context handling; do not mask all slashes, drop
real registrations, weaken assertions, or claim universal regex exclusion
while these cases remain. Extend the SAME designated focused O8 gate with
these controls and oracle-backed cases for a genuine divided registration
and a benign control-statement regex. Keep the original eight cases green.
No broad oracle battery in this corrective story. Normal build/npm and
source-pinned evidence remain required.

VERIFIER routing for the current per-story loop: read-only DB inspection
at04:07:59 confirms this run's verify step explicitly accepts STATUS: retry
(unlike its done-only integration tester). If these defects are still
present, submit the normal verifier completion with STATUS: retry and
ISSUES naming US-006 plus this signed task. Do not approve this commit or
edit implementation as verifier. Use the actually claimed step only.
This lets the existing verify-each loop return US-006 normally; no direct
story/DB/counter writes or coordinator pause are needed. US-014 remains
separately pending. If the finding reaches the integration TESTER instead,
its done-only expects still requires the step-fail protocol below.

Canonical progress remains at:
/home/igorhvr/.tamandua/runs/80049f1f-cd69-4835-a21a-32da90b13ca4/progress.txt
Read its current top notices and preserve ALL history. The whole-file-write
persona convention does not authorize discarding existing entries. Restore
the declared command only through a legitimate TEST_CMD: npm test report;
do not directly repair context or use the missing-ledger concession.

## Original correction and routing

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
