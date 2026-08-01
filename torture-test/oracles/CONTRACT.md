# Torture-test oracle executable contract

Contract version: **1**

Oracle hooks are mechanical checks. They may inspect the case manifest metadata,
contained Tamandua state, git plumbing, files, processes, and controller evidence.
They MUST NOT read an agent response or interpret agent prose as a verdict. The
controller intentionally supplies evidence references rather than response text.

## Discovery and invocation

For each oracle ID in a case manifest, the controller looks for an executable
regular file at `torture-test/oracles/<id>`. Symlinks, non-files, and files without
execute permission are treated as absent and recorded as `ORACLE_MISSING`.

A present hook is invoked without a shell:

```text
oracles/<id> --contract-version 1 --context <absolute-context-json-path>
```

The working directory is the hook's campaign-contained evidence directory. stdin
is closed/empty in version 1; hooks must not prompt or wait for input.

The controller supplies the case's selected real or scripted spawn environment,
plus these variables:

- `TT_ORACLE_CONTRACT_VERSION=1`
- `TT_ORACLE_ID=<manifest oracle ID>`
- `TT_ORACLE_CONTEXT=<absolute context JSON path>`
- `TT_ORACLE_EVIDENCE_DIR=<absolute writable evidence directory>`
- `TT_CASE_ID=<case ID>`
- `TT_CAMPAIGN_ID=<campaign ID>`
- `TT_RUN_ID=<full run ID>` when the case has an identified workflow run

The context file is a versioned JSON object containing campaign identity and
manifest metadata, case metadata, mechanical attempt evidence references,
terminal/step snapshots, token observations, and discovered-run records. It does
not contain command stdout contents, model transcripts, or agent response prose.
Step snapshots for both root attempts and discovered runs are projected onto
mechanical lifecycle fields (IDs, status/type, counters, claim metadata, and
timestamps); prose-bearing fields such as `output` and `error` are omitted.
Paths stored in the context are relative to the campaign results directory unless
explicitly documented otherwise.

## Output

stdout MUST contain exactly one JSON object (surrounding whitespace is allowed)
with this version-1 shape:

```json
{
  "contract_version": 1,
  "oracle_id": "O1",
  "result": "PASS",
  "started_at": "2026-08-01T00:00:00.000Z",
  "finished_at": "2026-08-01T00:00:01.000Z",
  "findings": [],
  "evidence": [
    {"path": "query-result.json", "kind": "sqlite"}
  ]
}
```

Required field rules:

- `contract_version` is the integer `1`.
- `oracle_id` exactly matches `TT_ORACLE_ID`.
- `result` is one of `PASS`, `FAIL`, or `ERROR`.
- `started_at` and `finished_at` are canonical UTC ISO-8601 timestamps;
  `finished_at` must not precede `started_at`.
- `findings` is an array. Every finding has nonempty string fields `id` and
  `summary`. `PASS` has no findings; `FAIL` has at least one. Additional
  mechanical fields such as `severity`, `expected`, and `observed` are allowed.
- `evidence` is an array of objects with a nonempty `kind` and a relative `path`.
  Each path is resolved beneath `TT_ORACLE_EVIDENCE_DIR` and must name an existing
  regular non-symlink file. Hooks create evidence with exclusive-create semantics
  and must not overwrite controller evidence.
- `classification` is optional structured evidence for the total outcome
  classifier. It may contain `manipulation_checks` (objects with `id`, `engaged`,
  and optional `required` booleans), `provider_failure` (`identified: true`, an
  `injected` boolean, and a nonempty mechanical `kind`), boolean
  `expectation_met` / `agent_task_succeeded`, or `ambiguous` with a nonempty
  `category`. Unknown or malformed classification fields make the oracle result
  `TEST_INFRA`; free-form text is not a classification signal.

stderr is diagnostic evidence only. It is never parsed as a verdict.

## Exit status

The JSON result and process exit status must agree:

| JSON result | Exit status | Meaning |
|---|---:|---|
| `PASS` | 0 | Applicable checks are mechanically green. |
| `FAIL` | 1 | A mechanical product finding was observed. |
| `ERROR` | 2 | The oracle could not make a valid observation. |

Any other exit status, signal, timeout, malformed JSON, schema violation, missing
evidence file, or result/exit contradiction is persisted as `TEST_INFRA` oracle
evidence. The controller does not guess a result from partial output. A validated
`FAIL` contributes `PRODUCT_FAIL`; validated `ERROR` contributes
`TEST_INFRA_FAIL`. An absent hook remains an explicit `ORACLE_MISSING` record so
campaign classification/reporting can distinguish an unavailable battery from a
hook that executed incorrectly.

## Evidence durability

Before invocation, the controller writes the context and a durable `RUNNING`
ledger record. It captures stdout and stderr separately, records the exit code,
signal, argv, start/finish timestamps, and SHA-256 hashes, and then validates the
response. Referenced evidence files are also hashed. Captured files are made
read-only after capture/validation. If the controller is interrupted while an
oracle is in flight, resume records `TEST_INFRA` and does not blindly execute the
hook a second time.

Oracle authors must derive every verdict from mechanical evidence. Agent prose,
`STATUS:` lines, conversational summaries, and claims that tests passed are not
oracle inputs and must never be introduced into the context or parsed by a hook.

The controller classifies each attempt separately. A validated `FAIL` always wins
as `PRODUCT_FAIL`, including when another structured signal says provider failure
or an unrelated manipulation did not engage. A non-injected, mechanically
identified provider failure permits one linked retry after the campaign's durable
backoff deadline. Every attempt classified `PROVIDER_FAIL` has
`counts_toward_gate: false`; the case outcome and case-level gate eligibility
follow the final attempt outcome.
