# US-001: Why tier-1 campaign #8 did not drown in O10 reconciliation errors — mechanically determined from on-disk evidence

S26 story US-001: determine, from campaign #8's on-disk evidence, why the
byte-for-field O10 suite-ledger reconciliation (`suite_ledger does not
reconcile byte-for-field with the read-only database snapshot`,
`ORACLE_RUNTIME_ERROR` thrown at `torture-test/oracles/lib/o10.mjs:263-266`)
did not turn tier-1 campaign #8 into a cascade of `TEST_INFRA_FAIL`
verdicts, so that US-002's scope fix honors whatever intended design #8's
immunity reveals.

**Answer in one paragraph:** Campaign #8's O10 "immunity" is **not** an
oracle-level immunity — the byte-for-field check FAILED on every single
case it ran (8/8 `ORACLE_RUNTIME_ERROR`). The campaign did not drown
because of a **classification-precedence mask**: in all 8 O10-ERROR cases,
at least one *other* oracle (O2/O8/O9/O11) returned a genuine product
FAIL, and `classifyAttempt` (`torture-test/bin/tt-classification.mjs:60-79`)
returns `PRODUCT_FAIL` the moment any valid oracle FAILs — **before** it
ever inspects oracle TEST_INFRA status. The O10 ERROR therefore never
decided a single case outcome, so zero `TEST_INFRA_FAIL` rows were
O10-driven. The tier-2 attempt-2 (campaign-20260826T225744158Z) drowned
precisely because there the O10 ERROR was the **only** failing oracle
(18 cases: all other oracles PASS) and classification fell through to
`oracle-infrastructure` → `TEST_INFRA_FAIL`. This reveals **no different
intended design**: #8's immunity is an accident of verdict precedence, and
US-002's scoped reconciliation is the correct fix — the scoped check
matches artifact-vs-scoped-DB byte-for-field on all 8 campaign-#8 O10
ERROR cases, proving the full-table read was the sole defect.

---

## 1. Campaign identification (which dir is campaign #8)

- **Campaign dir (adjudicated, completed):**
  `/home/igorhvr/idm/tamandua/torture-test/var/results/campaign-20260822T073029892Z-48c0215b-537f-45ec-80cc-ccad588775bc`
- `state.json`: `phase: ready`, `resume_count: 0`, `created_at:
  2026-08-22T07:30:29.893Z`, `real_preflight.engaged: true` with legs
  `home-provision / harness-auth / catalog-install / daemon-up` all
  `ok: true` — one shared contained daemon, the "accumulating DB"
  campaign shape described in S26.
- `manifest`: `cases/tier1.jsonl`, sha256
  `9ef494997c9c7f1cfa3945c8f3c76aba531e7b03e03856bab557021ff7fbdab8`,
  28 case ids. This manifest sha matches commit `a0f37e78` of
  `torture-test/cases/tier1.jsonl` (`git show a0f37e78:torture-test/cases/tier1.jsonl | sha256sum`
  → `9ef49499...`), i.e. the manifest actually used by the campaign.
- `report.txt`: `Created: 2026-08-22T07:30:29.893Z`,
  `Completed: 2026-08-22T15:15:39.820Z`; totals `PASS=11
  PRODUCT_FAIL=12 TEST_INFRA_FAIL=5` (no AGENT_FLAKE/PROVIDER_FAIL/
  INVALID/INCONCLUSIVE/NOT_RUN).
- The other candidate (`campaign-20260821T162148475Z-...`) is campaign #8
  attempt-2 (aborted; 5 W1 evidence cases, no report) — not the completed
  28-case adjudicated run. The `SFX-A` task doc
  (`impl-tasks/SFXA-controller-probe-daemon-fixes.md`) names
  `campaign-20260822T073029892Z-...` as "campaign #8 attempt-3 adjudicated
  review", confirming the completed 28-case dir.

## 2. Per-case `launch_intent.gate_key` presence/absence

Mechanical scan (read-only) over all 28 snapshots:

| gate_key state | count | cases |
|---|---|---|
| `present` (non-null) | **24** | W1.L1-python, W1.L1-ts, W1.L2-python, W1.L2-ts, W1.L3-python, W1.L3-ts, W1.X1-ts, W1.M1-python, W1.REPLAY-python, W1.REPLAY-ts, W2.22-non-main-bfmw, W2.24-docs-drift, W3.01-bfmw-pi-python, W3.02-bfmw-pi-ts, W3.03-bfmw-hermes-ts, W3.04-fdmw-pi-ts, W3.17a-marathon-natural, W3.17b-marathon-chaos, W3.18-pause-no-drain, W3.19-pause-drain, W3.20-cancel, W3.21-fail-force-resume, W3.22-daemon-restart, W3.23-token-saver |
| `null` | **0** | — |
| no launch-intent (scripted/local cells) | 4 | W2.21-admission, W2.23a-expects-regex, W2.23b-retry-step, W2.23c-missing-persona |

**Hypothesis (a) — gate_key nullability — is REFUTED for campaign #8.**
`evaluateO10`'s `NOT_EVALUABLE` early-return (o10.mjs:245-257, the
`d84c8558` S13-era design) requires `launch_intent.gate_key === null`;
**zero** campaign-#8 cases have a null gate key, so that guard never
fired. (The null-gate-key era is campaign #7 / pre-E3.A evidence — the
E3.B replay table shows O10 `ERROR → NOT_EVALUABLE` flips on campaign #7
snapshots whose launch-intents carry `gate_key: null`; that is a different
mechanism from #8's.) The 4 no-launch-intent cells never ran O10 (O10 is
not declared for them; they are scripted/local).

## 3. Artifact-vs-DB `suite_results` row counts per case

Read-only scan (`suite-ledger.json` rows vs `database.sqlite`
`SELECT COUNT(*) FROM suite_results`), monotonic through the campaign:

| case | gate_key | artifact rows | DB rows | O10 result |
|---|---|---|---|---|
| W1.L1-python | present | 0 | 50 | not-run |
| W1.L1-ts | present | 0 | 50 | not-run |
| W1.L2-python | present | 3 | 51 | not-run |
| W1.L2-ts | present | 3 | 52 | not-run |
| W1.L3-python | present | 3 | 53 | not-run |
| W1.L3-ts | present | 2 | 54 | not-run |
| W1.X1-ts | present | 0 | 54 | not-run |
| W1.M1-python | present | 0 | 54 | not-run |
| W1.REPLAY-python | present | 3 | 54 | not-run |
| W1.REPLAY-ts | present | 3 | 54 | not-run |
| W2.21-admission | no-launch-intent | — | — | not-run |
| **W2.22-non-main-bfmw** | present | **2** | **55** | **ERROR \| ORACLE_RUNTIME_ERROR** |
| W2.23a-expects-regex | no-launch-intent | — | — | not-run |
| W2.23b-retry-step | no-launch-intent | — | — | not-run |
| W2.23c-missing-persona | no-launch-intent | — | — | not-run |
| W2.24-docs-drift | present | 0 | 55 | not-run |
| **W3.01-bfmw-pi-python** | present | **6** | **60** | **ERROR \| ORACLE_RUNTIME_ERROR** |
| **W3.02-bfmw-pi-ts** | present | **3** | **62** | **ERROR \| ORACLE_RUNTIME_ERROR** |
| **W3.03-bfmw-hermes-ts** | present | **4** | **64** | **ERROR \| ORACLE_RUNTIME_ERROR** |
| **W3.04-fdmw-pi-ts** | present | **9** | **67** | **ERROR \| ORACLE_RUNTIME_ERROR** |
| **W3.17a-marathon-natural** | present | **10** | **73** | **ERROR \| ORACLE_RUNTIME_ERROR** |
| **W3.17b-marathon-chaos** | present | **8** | **78** | **ERROR \| ORACLE_RUNTIME_ERROR** |
| **W3.18-pause-no-drain** | present | **3** | **80** | **ERROR \| ORACLE_RUNTIME_ERROR** |
| W3.19-pause-drain | present | — (no snapshot) | — | not-run (no oracle evidence) |
| W3.20-cancel | present | 7 | 84 | not-run |
| W3.21-fail-force-resume | present | — (no snapshot) | — | not-run (no oracle evidence) |
| W3.22-daemon-restart | present | 16 | 96 | not-run |
| W3.23-token-saver | present | — (no snapshot) | — | not-run (no oracle evidence) |

Key observations:

- The shared DB grows monotonically (50 → 96 `suite_results` rows); the
  scoped artifact stays tiny (0-16 rows). The full-table byte-for-field
  mismatch is guaranteed once ANY sibling row exists.
- **O10 ran on exactly 8 cases** — all 8 declared O10 in the campaign-time
  manifest and all 8 produced `stdout.json` with
  `result: ERROR`, finding `ORACLE_RUNTIME_ERROR`, summary
  `suite_ledger does not reconcile byte-for-field with the read-only
  database snapshot`. So the reconciliation check itself was NOT immune —
  it failed 8/8 times it executed.
- Of the 10 manifest-declared O10 cells (W2.22, W3.01-04, W3.17a/b,
  W3.18, W3.19, W3.21), W3.19 and W3.21 never produced oracle evidence:
  their `oracle_evidence.status` is `BASELINE_CAPTURED` (case died
  `TEST_INFRA_FAIL probe-action-failed` — `resume` probe exited 1 —
  before oracle evaluation; no snapshot `suite-ledger.json`/`database.sqlite`
  was captured). So "declared" ≠ "ran".

## 4. The mechanical cause of the immunity: classification-precedence masking

For all 8 O10-ERROR cases, the terminal attempt's `classification_reason`
is `{"category": "oracle-failed", "oracles": [...]}` — **O10 is never in
the list**:

| case | outcome | classification_reason.oracles |
|---|---|---|
| W2.22-non-main-bfmw | PRODUCT_FAIL | O2, O8, O9 |
| W3.01-bfmw-pi-python | PRODUCT_FAIL | O2, O8, O9 |
| W3.02-bfmw-pi-ts | PRODUCT_FAIL | O2, O8, O9 |
| W3.03-bfmw-hermes-ts | PRODUCT_FAIL | O2, O8, O9 |
| W3.04-fdmw-pi-ts | PRODUCT_FAIL | O2, O8, O9 |
| W3.17a-marathon-natural | PRODUCT_FAIL | O2, O9 |
| W3.17b-marathon-chaos | PRODUCT_FAIL | O2, O9, O11 |
| W3.18-pause-no-drain | PRODUCT_FAIL | O2, O8, O9 |

`classifyAttempt` (bin/tt-classification.mjs:60-79) order:

1. `failedOracles` (any VALID oracle with `result: FAIL`) → **PRODUCT_FAIL
   (oracle-failed)** — lines 62-68.
2. Only *after* that, oracle results with `status === 'TEST_INFRA'` or
   `VALID` + `result === 'ERROR'` → **TEST_INFRA_FAIL
   (oracle-infrastructure)** — lines 72-79.

Every campaign-#8 O10-ERROR case carried at least one FAIL oracle (O2
target-ref movement, O8 seeded-test modification, O9 ledger-tree
unresolved — genuine product findings; see per-case `oracles/*/stdout.json`
for `O2_LANDING_EVENT_MISSING` / `O2_REF_TRANSITION_COUNT` /
`O8_SEEDED_TEST_CHANGED` / `O9_LEDGER_TREE_UNRESOLVED`), so the case was
already `PRODUCT_FAIL` on step 1 and O10's ERROR was never consulted.

The campaign's 5 `TEST_INFRA_FAIL` rows are all non-O10:
W1.REPLAY-python / W1.REPLAY-ts (`replay-snapshot-missing`),
W3.19-pause-drain / W3.21-fail-force-resume (`probe-action-failed`),
W3.23-token-saver (`deadline-expired`).

## 5. Contrast: tier-2 attempt-2 drowned because O10 was the ONLY failing oracle

`campaign-20260826T225744158Z-4bf26d7f-e648-42f1-8274-0011926de7dd`
(70 cases): **18** cases are terminal `TEST_INFRA_FAIL` with
`classification_reason = {"category": "oracle-infrastructure",
"oracles": ["O10"]}` — O10 ERROR as the **only** failing oracle:
W4.03, W4.04a, W4.04b, W4.05, W4.06, W4.07, W4.33c, W4.32, W4.13, W4.15,
W4.16, W4.17, W4.39-b, W4.26, W4.28, W4.31, W4.45, W5.storm-capacity-scaled.
Spot-checked evidence confirms all other oracles PASSed on those cells
(e.g. W4.03/W4.05/W4.28: O1/O2/O3z/O8/O9/O11 all `PASS`, O10 `ERROR`).
With no FAIL oracle to mask it, classification fell through to
`oracle-infrastructure` → `TEST_INFRA_FAIL` → 32 total `TEST_INFRA_FAIL`
("drown"). The tier-1/tier-2 difference is *not* gate_key nullability
(attempt-2's 18 O10-only cases also have non-null gate keys) — it is
whether the case had co-occurring product FAIL findings.

## 6. Does #8's immunity reveal a DIFFERENT intended design? — No

- The byte-for-field check predates #8 (3ae7332c, 08-02) and the *scoped
  artifact capture* landed 08-14 (d84c8558, S13) — yet in campaign #8 the
  check still failed 8/8 times it ran, because `o10.mjs readDatabase()`
  reads the **entire** `suite_results` table while the artifact is scoped
  (oracle-evidence-snapshot.mjs ~:1150-1157: gate-key origin + event
  originRepo). #8's "immunity" is purely the classification-precedence
  mask above — an accident of verdict ordering, **not** a designed
  reconciliation contract.
- **Proof that scoped reconciliation is the right fix (and would have
  healed all 8):** recomputing the case's suite-origin scope from its own
  inputs (launch gate-key origin + captured event origins) and comparing
  artifact rows vs DB rows filtered to that scope gives **8/8
  byte-for-field matches** (W2.22: artifact=2 scopedDb=2 fullDb=55; W3.01:
  6=6/60; W3.02: 3=3/62; W3.03: 4=4/64; W3.04: 9=9/67; W3.17a: 10=10/73;
  W3.17b: 8=8/78; W3.18: 3=3/80). The only defect is the full-table read;
  in-scope tamper detection is preserved by the scoped byte-for-field
  comparison.
- What US-002 must honor from this finding: (a) keep the null-gate_key →
  `NOT_EVALUABLE` early-return unchanged (it is the S13 degraded-evidence
  contract and is orthogonal to the scope fix); (b) keep the existing
  `ORACLE_RUNTIME_ERROR` message and fail-closed behavior for IN-SCOPE
  mismatches; (c) scope BOTH sides of the comparison by the case's
  recomputed suite origins (gate-key origin ∪ captured event origins) so
  foreign-origin rows are foreign (S13 doctrine), not reconciliation
  failures; (d) do not treat #8's immunity as a reason to weaken anything
  — it was masking, not design.

## 7. Reproduction (every number above is reproducible, zero tokens, read-only)

All commands run from any node>=22 shell; they only READ the adjudication
evidence (node:sqlite `readOnly`; no writes, no daemon contact, no git
changes to evidence).

### 7.1 Campaign identity

```bash
C8=/home/igorhvr/idm/tamandua/torture-test/var/results/campaign-20260822T073029892Z-48c0215b-537f-45ec-80cc-ccad588775bc
python3 - "$C8" <<'PY'
import json, sys
st = json.load(open(sys.argv[1] + '/state.json'))
print(st['campaign_id'], st['phase'], 'resume_count=', st['resume_count'])
print([(l['leg'], l['ok']) for l in st['real_preflight']['legs']])
print(st['manifest'])
PY
```

### 7.2 Full per-case table + gate_key counts + scoped-reconciliation check

```bash
C8=/home/igorhvr/idm/tamandua/torture-test/var/results/campaign-20260822T073029892Z-48c0215b-537f-45ec-80cc-ccad588775bc
cat > /tmp/s26-campaign8-analysis.mjs <<'EOF'
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const CAMPAIGN = process.argv[2];
const st = JSON.parse(fs.readFileSync(path.join(CAMPAIGN, 'state.json'), 'utf8'));
let gkPresent = 0, gkNull = 0, gkNoLaunch = 0;
for (const cid of st.manifest.case_ids) {
  const snapDir = path.join(CAMPAIGN, 'snapshots', cid, 'attempt-1');
  const evDir = path.join(CAMPAIGN, 'evidence', cid, 'attempt-1');
  let gateKey = 'no-launch-intent';
  const li = path.join(snapDir, 'launch-intent.json');
  if (fs.existsSync(li)) {
    const d = JSON.parse(fs.readFileSync(li, 'utf8'));
    gateKey = (d.gate_key !== null && d.gate_key !== undefined) ? 'present' : 'null';
  }
  if (gateKey === 'present') gkPresent++; else if (gateKey === 'null') gkNull++; else gkNoLaunch++;
  let artifactRows = null;
  const sl = path.join(snapDir, 'suite-ledger.json');
  if (fs.existsSync(sl)) artifactRows = JSON.parse(fs.readFileSync(sl, 'utf8')).rows.length;
  let dbRows = null;
  const dbPath = path.join(snapDir, 'database.sqlite');
  if (fs.existsSync(dbPath)) {
    try { const db = new DatabaseSync(dbPath, { readOnly: true }); dbRows = db.prepare('SELECT COUNT(*) AS n FROM suite_results').get().n; db.close(); } catch { dbRows = 'ERR'; }
  }
  let o10 = 'not-run';
  const o10f = path.join(evDir, 'oracles', 'O10', 'stdout.json');
  if (fs.existsSync(o10f)) { const d = JSON.parse(fs.readFileSync(o10f, 'utf8')); o10 = d.result + (d.findings.length ? '|' + d.findings.map(f => f.id).join(',') : ''); }
  console.log(`${cid},${gateKey},${artifactRows},${dbRows},${o10}`);
}
console.error(`gate_key: present=${gkPresent} null=${gkNull} no-launch-intent=${gkNoLaunch}`);
EOF
node /tmp/s26-campaign8-analysis.mjs "$C8"
```

Scoped-reconciliation check (US-002 preview; reproduces section 6's 8/8):

```bash
C8=/home/igorhvr/idm/tamandua/torture-test/var/results/campaign-20260822T073029892Z-48c0215b-537f-45ec-80cc-ccad588775bc
for cid in W2.22-non-main-bfmw W3.01-bfmw-pi-python W3.02-bfmw-pi-ts W3.03-bfmw-hermes-ts W3.04-fdmw-pi-ts W3.17a-marathon-natural W3.17b-marathon-chaos W3.18-pause-no-drain; do
node - "$C8" "$cid" <<'EOF'
import fs from 'node:fs'; import path from 'node:path'; import { DatabaseSync } from 'node:sqlite';
const [CAMPAIGN, cid] = process.argv.slice(2);
const snapDir = path.join(CAMPAIGN, 'snapshots', cid, 'attempt-1');
const li = JSON.parse(fs.readFileSync(path.join(snapDir, 'launch-intent.json'), 'utf8'));
const ev = JSON.parse(fs.readFileSync(path.join(snapDir, 'run-events.json'), 'utf8'));
const gkOrigin = li.gate_key?.origin_repo ?? null;
const eventOrigins = new Set((ev.rows ?? []).map(w => w.event?.originRepo).filter(o => typeof o === 'string'));
const suiteOrigins = new Set([...(gkOrigin ? [gkOrigin] : []), ...eventOrigins]);
const artifact = JSON.parse(fs.readFileSync(path.join(snapDir, 'suite-ledger.json'), 'utf8')).rows;
const db = new DatabaseSync(path.join(snapDir, 'database.sqlite'), { readOnly: true });
const all = db.prepare('SELECT id, origin_repo, tree_hash, cmd_hash, cmd_display, exit_code, duration_ms, log_tail, run_id, step_id, created_at FROM suite_results ORDER BY id').all();
db.close();
const scopedDb = all.filter(r => suiteOrigins.has(r.origin_repo));
console.log(`${cid}: artifact=${artifact.length} scopedDb=${scopedDb.length} fullDb=${all.length} scoped_match=${JSON.stringify(artifact) === JSON.stringify(scopedDb)}`);
EOF
done
```

### 7.3 Classification masking (section 4)

```bash
C8=/home/igorhvr/idm/tamandua/torture-test/var/results/campaign-20260822T073029892Z-48c0215b-537f-45ec-80cc-ccad588775bc
python3 - "$C8" <<'PY'
import json, sys
st = json.load(open(sys.argv[1] + '/state.json'))
for c in st['cases']:
    a = (c.get('attempts') or [{}])[0]
    r = a.get('classification_reason') or {}
    if r.get('category') == 'oracle-failed' and any(o in (r.get('oracles') or []) for o in ('O2','O8','O9','O10','O11')):
        print(c['id'], a.get('outcome'), r.get('oracles'))
PY
```

### 7.4 Manifest provenance (campaign-time sha)

```bash
git -C /home/igorhvr/idm/tamandua show a0f37e78:torture-test/cases/tier1.jsonl | sha256sum
# → 9ef494997c9c7f1cfa3945c8f3c76aba531e7b03e03856bab557021ff7fbdab8
# (equals state.json manifest sha256 above; declares O10 for W2.22, W3.01-04,
#  W3.17a/b, W3.18, W3.19, W3.21 — the 10 cells; only 8 produced evidence)
```

### 7.5 attempt-2 O10-only drown count (section 5)

```bash
A2=/home/igorhvr/idm/tamandua/torture-test/var/results/campaign-20260826T225744158Z-4bf26d7f-e648-42f1-8274-0011926de7dd
python3 - "$A2" <<'PY'
import json, sys
st = json.load(open(sys.argv[1] + '/state.json'))
n = 0
for c in st['cases']:
    a = (c.get('attempts') or [{}])[0]
    r = a.get('classification_reason') or {}
    if r.get('category') == 'oracle-infrastructure' and (r.get('oracles') or []) == ['O10']:
        n += 1
print('O10-only TEST_INFRA_FAIL count:', n)
PY
# → 18
```

## 8. Summary for the landing report

- Campaign #8 (campaign-20260822T073029892Z-48c0215b, 28 cases, shared
  contained daemon, resume_count 0, daemon-up preflight OK) did NOT
  exhibit O10 immunity at the oracle layer: O10's byte-for-field check ran
  on 8 cases and threw `ORACLE_RUNTIME_ERROR` on all 8 (artifact 2-16
  scoped rows vs full DB 55-96 accumulating rows).
- It did not drown because `classifyAttempt` returns `PRODUCT_FAIL`
  (oracle-failed) as soon as ANY oracle FAILs, before consulting oracle
  TEST_INFRA; all 8 O10-ERROR cases had genuine O2/O8/O9 (and O11 on
  W3.17b) product findings, so no case was ever classified
  `TEST_INFRA_FAIL` on O10's account. The 5 `TEST_INFRA_FAIL` rows were
  replay-snapshot-missing / probe-action-failed / deadline-expired.
- gate_key nullability plays NO role in #8 (0 null gate keys among 24
  launch-intent cells; 4 scripted cells have no launch-intent); the
  `NOT_EVALUABLE` guard is the campaign-#7/pre-E3.A era mechanism.
- attempt-2 drowned (32 TEST_INFRA_FAIL, 18 O10-only) because there O10's
  ERROR was the ONLY failing oracle — no FAIL oracle masked it.
- Conclusion for US-002: no different intended design is revealed; the
  scoped reconciliation (recompute suite origins from launch gate-key
  origin + captured event origins; compare artifact vs DB rows within that
  scope byte-for-field) is the correct, evidence-backed fix — it matches
  8/8 on campaign-#8 evidence and preserves in-scope fail-closed tamper
  detection. Keep the null-gate_key `NOT_EVALUABLE` path unchanged.
