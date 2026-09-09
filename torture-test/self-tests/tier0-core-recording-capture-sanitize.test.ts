// tier0-core-recording-capture-sanitize.test.ts — CORE US-002 designated gate.
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.1, bounded slice CORE-1, story
// US-002: explicit read-only capture/sanitization importer with fail-closed
// guards and a synthetic sentinel corpus regression.
//
// What this gate proves (all pure, zero tokens, zero daemon/model/fs side
// effects beyond caller-owned temp files inside the tests):
//   (a) Sanitized outputs and every emitted US-001 record NEVER contain any
//       synthetic private sentinel value, and redaction evidence is present.
//   (b) The ordered-projection hash is deterministic for identical
//       projections and changes when ANY ordered public field changes.
//   (c) Captured / sanitized / synthetic / unknown labels stay distinct and
//       honest across provenance scenarios. Provenance is an EXPLICIT
//       REQUIRED choice: an omitted/invalid provenance is refused (never
//       silently invented as "captured"), and synthetic provenance retains
//       the synthetic classification even when rows are sanitized.
//   (d) Fail-closed on unknown origin, missing session, unsupported row
//       shapes, truncated/incomplete input, unreadable input (caller-owned
//       temp path) and ambiguous attribution — with useful diagnostics.
//   (h) Complete-value redaction for credential assignment/header shapes
//       (Authorization: Basic/Bearer, multi-token passwords, quoted values
//       AND bare-then-quoted forms, mixed case) with unambiguous-delimiter
//       preservation and normal content controls — never a partial-value
//       leak. Quoted values are scanned conservatively: an escaped quote
//       (backslash + quote) inside a quoted value is NOT a closing delimiter
//       (so password="prefix\"secret tail" is one quoted unit), and a quote
//       that never closes is bounded at the end of the line — the open value
//       is fully removed rather than leaked or ignored. The importer does NOT
//       promise arbitrary-secret detection; that limitation is explicit.
//   (e) No reasoning/auth field ever appears in emitted projections: the
//       extractable public-field vocabulary excludes them, denied names are
//       refused, raw prompts/reasoning fields are never selected, and the
//       structural key/value sweep over emitted records finds no marker.
//   (f) US-001 validateRecordingRecord ACCEPTS every emitted record.
//   (g) Interface pin: the module exports EXACTLY parsePublicProjection,
//       sanitizeProjection, hashPublicProjection and captureRecording, and
//       the module source stays hermetic (imports only node builtins plus
//       the US-001 contract module; no eval / child_process constructs).
//
// Corpus discipline: every row below is a SYNTHETIC fixture modeled on the
// PUBLIC vocabulary of the ORIGINAL coordinator inventory (call ids,
// command sha256 hashes, exit codes, timestamps, dsh event types, hermes
// message-row columns). No real row, credential, hidden reasoning or
// operator-specific content is copied from
// torture-test/var/review-logs/core-recording-source-ZFANtD/ (which lives in
// the ORIGINAL checkout outside this worktree and was read only as a SHAPE
// reference). Private sentinels are synthetic markers (BEGIN PRIVATE KEY
// blocks with fake bodies, sk-/ghp-shaped fake tokens, auth/password
// assignments, tagged hidden-reasoning text, an arbitrary declared secret).
//
// Runs as its own `node --test torture-test/self-tests/tier0-core-recording-
// capture-sanitize.test.ts` (designated focused gate; single file per
// invocation). Node >= 22 runs .ts directly; the .mjs modules are loaded via
// dynamic import with pathToFileURL.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = process.cwd();
const IMPORT_PATH = path.join(repoRoot, "torture-test", "bin", "core-recording-import.mjs");
const CONTRACT_PATH = path.join(repoRoot, "torture-test", "bin", "core-recording-contract.mjs");
const IMPORT_URL = pathToFileURL(IMPORT_PATH).href;
const CONTRACT_URL = pathToFileURL(CONTRACT_PATH).href;

assert.ok(
  fs.existsSync(IMPORT_PATH),
  `cannot find the import module at ${IMPORT_PATH} — run this test from the repo root`,
);
assert.ok(
  fs.existsSync(CONTRACT_PATH),
  `cannot find the US-001 contract module at ${CONTRACT_PATH} — run this test from the repo root`,
);

// ── synthetic fixture vocabulary (nothing from the ORIGINAL inventory) ─────
const RUN_ID = "run-synth-us002-00000000-0000-4000-8000-000000000000";
const SESSION_ID = "session-synth-us002-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const OTHER_SESSION_ID = "session-synth-us002-ffffffff-1111-4222-8333-444444444444";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Synthetic private sentinels — fake markers with no real credential value.
const TOKEN_SENTINEL = "sk-synth-9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const GHP_SENTINEL = "ghp_synthGHPToken111222333444555666777888";
const BEARER_SENTINEL = "Bearer synth-bearer-value-0000000000000000";
const ULTRA_SENTINEL = "synth-ultra-secret-value-9999";
const PASSWORD_SENTINEL = "hunter2-synth";
const PRIVATE_KEY_SENTINEL = [
  "-----BEGIN PRIVATE KEY-----",
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDsynthfixture",
  "-----END PRIVATE KEY-----",
].join("\n");
const REASONING_MARKER = "SYNTH-PRIVATE-REASONING-MARKER-0001";
const ROW_REASONING_MARKER = "SYNTH-ROWLEVEL-REASONING-MARKER-7777"; // only in a non-selected row-level field
const AUTH_HEADER = "Authorization: Bearer synth-bearer-prompt-only-0000";

// Every sentinel that must never appear in sanitized outputs / emitted
// records for the corpora below.
const ALL_SENTINELS = Object.freeze([
  TOKEN_SENTINEL,
  GHP_SENTINEL,
  BEARER_SENTINEL,
  ULTRA_SENTINEL,
  PASSWORD_SENTINEL,
  PRIVATE_KEY_SENTINEL,
  "-----BEGIN PRIVATE KEY-----",
  REASONING_MARKER,
  ROW_REASONING_MARKER,
  AUTH_HEADER,
]);

const DECLARED_SENTINELS = Object.freeze([TOKEN_SENTINEL, ULTRA_SENTINEL]);

// Ordered public fields exercised per origin.
const PI_FIELDS = Object.freeze(["timestamp", "call_id", "tool_name", "command_sha256", "exit_code", "output"]);
const DSH_FIELDS = Object.freeze(["timestamp", "terminal_code", "output"]);
const HERMES_FIELDS = Object.freeze(["row_id", "timestamp", "role", "tool_call_id", "tool_name", "command_sha256", "output"]);

// ── synthetic corpus builders (three origins) ──────────────────────────────

interface RawRow {
  [key: string]: any;
}

/**
 * pi corpus: 7 message rows (tool_call / tool_result / text_message /
 * user_message). Sentinels live in captured public output (r2 token, r3
 * private key, r4 hidden-reasoning tag + declared secret) and in a
 * NEVER-projected operator prompt (r5) and a row-level reasoning field (r1).
 */
function buildPiCorpus(): RawRow[] {
  return [
    {
      type: "message",
      timestamp: "2026-08-27T06:24:45.942Z",
      reasoning: { text: `hidden ${ROW_REASONING_MARKER}` }, // row-level reasoning: never selected
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_synth_pi_0001",
            name: "bash",
            arguments: { command: "npm test 2>&1" },
          },
        ],
      },
    },
    {
      type: "message",
      timestamp: "2026-08-27T06:24:46.059Z",
      message: {
        role: "tool",
        content: [
          {
            type: "toolResult",
            toolCallId: "call_synth_pi_0001",
            exitCode: 0,
            content: [
              { type: "text", text: `tests passed; deploy key printed: ${TOKEN_SENTINEL}\n` },
              { type: "text", text: "status ok" },
            ],
          },
        ],
      },
    },
    {
      type: "message",
      timestamp: "2026-08-27T06:24:47.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `signing material:\n${PRIVATE_KEY_SENTINEL}\nend` }],
      },
    },
    {
      type: "message",
      timestamp: "2026-08-27T06:24:48.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `report: STATUS: retry / REBASED: true\n<reasoning>${REASONING_MARKER}</reasoning>\nsecret note: ${ULTRA_SENTINEL}`,
          },
        ],
      },
    },
    {
      type: "message",
      timestamp: "2026-08-27T06:24:49.000Z",
      message: {
        role: "user",
        content: [{ type: "text", text: `operator prompt carrying ${AUTH_HEADER} and ${TOKEN_SENTINEL}` }],
      },
    },
    {
      type: "message",
      timestamp: "2026-08-27T06:24:50.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_synth_pi_0002",
            name: "bash",
            arguments: { command: "git status" },
          },
        ],
      },
    },
    {
      type: "message",
      timestamp: "2026-08-27T06:24:51.000Z",
      message: {
        role: "tool",
        content: [
          {
            type: "toolResult",
            toolCallId: "call_synth_pi_0002",
            exitCode: 1,
            content: [{ type: "text", text: "fatal: not a git repository" }],
          },
        ],
      },
    },
  ];
}

/**
 * dsh corpus: 8 post-decompression session events (session, turn/start,
 * step/start, assistant/chunk x2, step/end, turn/end, user/message).
 */
function buildDshCorpus(): RawRow[] {
  return [
    { type: "session", time: "2026-08-27T08:23:33.100Z", seq: 1, data: { sessionId: SESSION_ID } },
    { type: "turn/start", time: "2026-08-27T08:23:33.200Z", seq: 2, data: { turn: "turn_1" } },
    { type: "step/start", time: "2026-08-27T08:23:33.300Z", seq: 3, data: { step: "step_1" } },
    {
      type: "assistant/chunk",
      time: "2026-08-27T08:23:34.000Z",
      seq: 4,
      data: {
        turn: "turn_1",
        step: "step_1",
        chunk: { type: "text", text: `provisioning token ${GHP_SENTINEL}; auth ${BEARER_SENTINEL} ok` },
      },
    },
    {
      type: "assistant/chunk",
      time: "2026-08-27T08:23:34.100Z",
      seq: 5,
      data: {
        turn: "turn_1",
        step: "step_1",
        chunk: { type: "text", text: `considering <reasoning>${REASONING_MARKER}</reasoning> then failing` },
      },
    },
    { type: "step/end", time: "2026-08-27T08:23:34.200Z", seq: 6, data: { step: "step_1" } },
    {
      type: "turn/end",
      time: "2026-08-27T08:23:34.456Z",
      seq: 7,
      data: { reason: { error: { code: "MISSING_CREDENTIAL", message: "no credential" } } },
    },
    { type: "user/message", time: "2026-08-27T08:23:34.500Z", seq: 8, data: { text: `prompt ${TOKEN_SENTINEL}` } },
  ];
}

/**
 * hermes corpus: 5 native messages-table public rows (assistant with
 * tool_calls / tool result / user prompt). Sentinels live in captured tool
 * output (r2/r5) and in a NEVER-projected user prompt (r4).
 */
function buildHermesCorpus(): RawRow[] {
  const callJson = (id: string, command: string): string =>
    JSON.stringify([
      {
        id,
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command }) },
      },
    ]);
  return [
    {
      row_id: 1,
      session_id: SESSION_ID,
      role: "assistant",
      content: "investigating test failure",
      tool_call_id: null,
      tool_calls: callJson("call_synth_hm_0001", "npm test"),
      tool_name: null,
      timestamp: 1756000000,
    },
    {
      row_id: 2,
      session_id: SESSION_ID,
      role: "tool",
      content: `stdout ok; API_KEY=${TOKEN_SENTINEL}; login password=${PASSWORD_SENTINEL} end`,
      tool_call_id: "call_synth_hm_0001",
      tool_calls: null,
      tool_name: "bash",
      timestamp: 1756000005,
    },
    {
      row_id: 3,
      session_id: SESSION_ID,
      role: "assistant",
      content: "report: STATUS: done\nCHANGES: capture fix",
      tool_call_id: null,
      tool_calls: callJson("call_synth_hm_0002", "git status"),
      tool_name: null,
      timestamp: 1756000010,
    },
    {
      row_id: 4,
      session_id: SESSION_ID,
      role: "user",
      content: `please fix this; ${AUTH_HEADER}; token ${TOKEN_SENTINEL}`,
      tool_call_id: null,
      tool_calls: null,
      tool_name: null,
      timestamp: 1756000012,
    },
    {
      row_id: 5,
      session_id: SESSION_ID,
      role: "tool",
      content: `result holds ${ULTRA_SENTINEL}`,
      tool_call_id: "call_synth_hm_0002",
      tool_calls: null,
      tool_name: "bash",
      timestamp: 1756000020,
    },
  ];
}

function buildCleanDshCorpus(): RawRow[] {
  return [
    { type: "session", time: "2026-08-27T08:23:33.100Z", seq: 1, data: { sessionId: SESSION_ID } },
    { type: "turn/start", time: "2026-08-27T08:23:33.200Z", seq: 2, data: {} },
    {
      type: "assistant/chunk",
      time: "2026-08-27T08:23:34.000Z",
      seq: 3,
      data: { chunk: { type: "text", text: "plain public output, no secrets" } },
    },
    {
      type: "turn/end",
      time: "2026-08-27T08:23:34.456Z",
      seq: 4,
      data: { reason: { error: { code: "NO_ERROR_CODE" } } },
    },
  ];
}

// ── loaders and small utilities ────────────────────────────────────────────

let importPromise: Promise<any> | null = null;
function loadImporter(): Promise<any> {
  if (importPromise === null) importPromise = import(IMPORT_URL);
  return importPromise;
}

let contractPromise: Promise<any> | null = null;
function loadContract(): Promise<any> {
  if (contractPromise === null) contractPromise = import(CONTRACT_URL);
  return contractPromise;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

async function loadModuleSource(): Promise<string> {
  return fs.readFileSync(IMPORT_PATH, "utf8");
}

function assertNoSentinel(haystack: string, label: string): void {
  for (const sentinel of ALL_SENTINELS) {
    assert.equal(
      haystack.includes(sentinel),
      false,
      `${label} must not contain sentinel ${JSON.stringify(sentinel.slice(0, 40))}`,
    );
  }
}

/** Recursively collect every object key below `value` (for structural scans). */
function collectKeys(value: any, keys: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    keys.add(key);
    collectKeys(value[key], keys);
  }
}

const DENIED_KEY_RE =
  /^(reasoning|reasoning_text|password|passwd|authorization|secret|credential|token|api[_-]?key|access_token|auth_token|private_key)$/i;

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-us002-"));
  try {
    return await fn(dir);
  } finally {
    // Exact own-path cleanup of the directory this helper created.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

interface CaptureSummary {
  record: any;
  projection: any;
  sanitized: any;
  redactions: any[];
  projectionSha256: string;
  sanitizedSha256: string;
  validation: any;
}

async function captureCorpus(opts: {
  origin: "pi" | "dsh" | "hermes";
  rows: RawRow[];
  fields: readonly string[];
  provenance?: "captured" | "synthetic";
  sentinels?: readonly string[];
  unknown?: any[];
  reports?: any[];
}): Promise<CaptureSummary> {
  const mod = await loadImporter();
  const contract = await loadContract();
  const projection = mod.parsePublicProjection({
    origin: opts.origin,
    input: cloneJson(opts.rows),
    session: SESSION_ID,
    publicFieldOrder: [...opts.fields],
  });
  const { sanitized, redactions } = mod.sanitizeProjection(projection, {
    sentinels: opts.sentinels ? [...opts.sentinels] : [],
  });
  const projectionSha256 = mod.hashPublicProjection(projection);
  const sanitizedSha256 = mod.hashPublicProjection(sanitized);
  const record = mod.captureRecording({
    origin: opts.origin,
    input: cloneJson(opts.rows),
    session: SESSION_ID,
    publicFieldOrder: [...opts.fields],
    runId: RUN_ID,
    caseId: `SYNTH-CASE-US002-${opts.origin}`,
    provenance: opts.provenance ?? "captured",
    sentinels: opts.sentinels ? [...opts.sentinels] : [],
    unknown: opts.unknown ?? [],
    reports: opts.reports ?? [],
  });
  const validation = contract.validateRecordingRecord(record);
  return {
    record,
    projection,
    sanitized,
    redactions,
    projectionSha256,
    sanitizedSha256,
    validation,
  };
}

function locatorSha(record: any, locatorId: string): string | undefined {
  const ref = record.sourceIdentity.sourceRefs.find((r: any) => r.locatorId === locatorId);
  return ref ? ref.sha256 : undefined;
}

function recordText(record: any): string {
  return JSON.stringify(record);
}

function observationClassifications(record: any): string[] {
  return record.observations.map((o: any) => o.classification);
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("CORE US-002 capture/sanitization importer", () => {
  it("pins the exact module interface and keeps the module hermetic (grep check)", async () => {
    const mod = await loadImporter();
    assert.deepEqual(Object.keys(mod).sort(), [
      "captureRecording",
      "hashPublicProjection",
      "parsePublicProjection",
      "sanitizeProjection",
    ]);
    for (const name of ["parsePublicProjection", "sanitizeProjection", "hashPublicProjection", "captureRecording"]) {
      assert.equal(typeof mod[name], "function", `${name} must be exported as a function`);
    }
    const source = await loadModuleSource();
    const importLines = source.split("\n").filter((line) => /^\s*import\s/.test(line));
    assert.ok(importLines.length > 0, "module must import the US-001 contract module");
    for (const line of importLines) {
      const specifier = /from\s+["']([^"']+)["']/.exec(line);
      assert.ok(specifier, `cannot parse import specifier: ${line}`);
      assert.ok(
        specifier[1].startsWith("node:") || specifier[1] === "./core-recording-contract.mjs",
        `import outside node builtins or the US-001 contract module: ${specifier[1]} (${line.trim()})`,
      );
    }
    const forbidden = [
      /\beval\b/,
      /\bnew\s+Function\b/,
      /\bFunction\s*\(/,
      /child_process/,
      /spawnSync|execSync|execFileSync|fork\s*\(/,
    ];
    for (const re of forbidden) {
      assert.equal(re.test(source), false, `module source matches forbidden construct ${re}`);
    }
  });

  it("parsePublicProjection projects exactly the ordered public fields per origin", async () => {
    const mod = await loadImporter();
    const cases: Array<{ origin: "pi" | "dsh" | "hermes"; rows: RawRow[]; fields: readonly string[] }> = [
      { origin: "pi", rows: buildPiCorpus(), fields: PI_FIELDS },
      { origin: "dsh", rows: buildDshCorpus(), fields: DSH_FIELDS },
      { origin: "hermes", rows: buildHermesCorpus(), fields: HERMES_FIELDS },
    ];
    for (const c of cases) {
      const projection = mod.parsePublicProjection({
        origin: c.origin,
        input: cloneJson(c.rows),
        session: SESSION_ID,
        publicFieldOrder: [...c.fields],
      });
      assert.equal(projection.projectionFormat, "core-recording-public-projection/1");
      assert.equal(projection.origin, c.origin);
      assert.equal(projection.session, SESSION_ID);
      assert.equal(projection.rows.length, c.rows.length, `${c.origin}: one row per input row`);
      assert.match(projection.snapshot, /single-read/);
      assert.equal(projection.input.kind, "parsed-rows");
      for (const row of projection.rows) {
        assert.ok(Number.isInteger(row.seq) && row.seq >= 1, `${c.origin}: row needs a positive seq`);
        assert.ok(typeof row.rowType === "string" && row.rowType.length > 0);
        for (const key of Object.keys(row.public)) {
          assert.ok(c.fields.includes(key), `${c.origin}: row.public key ${key} outside publicFieldOrder`);
          assert.equal(DENIED_KEY_RE.test(key), false, `${c.origin}: denied key ${key} projected`);
        }
      }
    }
  });

  it("(b) the ordered-projection hash is deterministic and changes when any ordered public field changes", async () => {
    const mod = await loadImporter();
    const rows = buildPiCorpus();
    const a = mod.parsePublicProjection({ origin: "pi", input: cloneJson(rows), session: SESSION_ID, publicFieldOrder: [...PI_FIELDS] });
    const b = mod.parsePublicProjection({ origin: "pi", input: cloneJson(rows), session: SESSION_ID, publicFieldOrder: [...PI_FIELDS] });
    const ha = mod.hashPublicProjection(a);
    const hb = mod.hashPublicProjection(b);
    assert.equal(ha, hb, "identical projections must hash identically");
    assert.match(ha, /^[0-9a-f]{64}$/);

    // Change one ordered public field value in one row -> hash must differ.
    const mutated = cloneJson(a);
    mutated.rows[0].public.timestamp = "2026-08-27T06:24:45.999Z";
    assert.notEqual(mod.hashPublicProjection(mutated), ha, "changing an ordered public field must change the hash");

    // Removing a public field (presence change) also changes the hash.
    const removed = cloneJson(a);
    delete removed.rows[0].public.timestamp;
    assert.notEqual(mod.hashPublicProjection(removed), ha, "removing an ordered public field must change the hash");

    // Field order is part of the ordered projection.
    const reordered = mod.parsePublicProjection({
      origin: "pi",
      input: cloneJson(rows),
      session: SESSION_ID,
      publicFieldOrder: [...PI_FIELDS].reverse(),
    });
    assert.notEqual(mod.hashPublicProjection(reordered), ha, "reordering public fields must change the hash");
  });

  it("sanitizeProjection removes every sentinel from captured public values and records redaction evidence", async () => {
    const mod = await loadImporter();
    const rows = buildPiCorpus();
    const projection = mod.parsePublicProjection({ origin: "pi", input: rows, session: SESSION_ID, publicFieldOrder: [...PI_FIELDS] });
    const { sanitized, redactions } = mod.sanitizeProjection(projection, { sentinels: [...DECLARED_SENTINELS] });
    const text = JSON.stringify(sanitized.rows);
    assertNoSentinel(text, "sanitized projection rows");
    assert.ok(redactions.length >= 3, `expected redaction evidence, got ${JSON.stringify(redactions)}`);
    const reasons = new Set(redactions.map((r: any) => r.reason));
    for (const reason of ["declared-sentinel", "private-key-block", "hidden-reasoning"]) {
      assert.ok(reasons.has(reason), `expected a ${reason} redaction, got ${[...reasons]}`);
    }
    for (const r of redactions) {
      assert.match(r.fieldPath, /^rows\[\d+\]\.public\./, `fieldPath shape: ${r.fieldPath}`);
      assert.match(r.replacedWith, /^\[REDACTED:/);
    }
    // Raw captured projection (pre-sanitize) DOES carry sentinels; the
    // sanitized clone must be value-different exactly there.
    assert.notEqual(JSON.stringify(projection.rows), JSON.stringify(sanitized.rows));
  });

  it("(a,f) emitted records for all three origins never contain a sentinel, embed redaction evidence, and validate", async () => {
    const mod = await loadImporter();
    const cases = [
      { origin: "pi" as const, rows: buildPiCorpus(), fields: PI_FIELDS },
      { origin: "dsh" as const, rows: buildDshCorpus(), fields: DSH_FIELDS },
      { origin: "hermes" as const, rows: buildHermesCorpus(), fields: HERMES_FIELDS },
    ];
    for (const c of cases) {
      const summary = await captureCorpus({
        origin: c.origin,
        rows: c.rows,
        fields: c.fields,
        sentinels: DECLARED_SENTINELS,
      });
      assert.equal(summary.validation.ok, true, `${c.origin} record must validate: ${JSON.stringify(summary.validation)}`);
      const text = recordText(summary.record);
      assertNoSentinel(text, `${c.origin} emitted record`);
      assert.match(text, /\[REDACTED:/, `${c.origin} record keeps redaction markers`);
      // Declared literal sentinels appear in the pi/hermes projected content
      // (token + declared secret); the dsh corpus secrets are built-in
      // shapes (ghp/bearer) caught without a declared sentinel.
      if (c.origin === "pi" || c.origin === "hermes") {
        assert.match(text, /\[REDACTED:declared-sentinel\]/, `${c.origin} record keeps declared-sentinel evidence`);
      }
      // Redaction evidence is embedded as transformations.
      const redactTransforms = summary.record.transformations.filter((t: any) => t.step === "sanitize.redact");
      assert.ok(redactTransforms.length > 0, `${c.origin}: transformations must carry redaction evidence`);
      for (const t of redactTransforms) {
        assert.ok(typeof t.fieldPath === "string" && t.fieldPath.length > 0);
        assert.ok(typeof t.reason === "string" && t.reason.length > 0);
      }
      // Distinct honest labels: captured rows coexist with sanitized rows.
      const labels = observationClassifications(summary.record);
      assert.ok(labels.includes("captured"), `${c.origin}: expected captured rows`);
      assert.ok(labels.includes("sanitized"), `${c.origin}: expected sanitized rows`);
      for (const label of labels) {
        assert.ok(["captured", "sanitized", "synthetic"].includes(label), `${c.origin}: unknown label ${label}`);
      }
    }
  });

  it("(a) hermetic corner: private-key block and ghp/bearer/auth/reasoning shapes are caught by the built-in detectors", async () => {
    const dsh = await captureCorpus({ origin: "dsh", rows: buildDshCorpus(), fields: DSH_FIELDS, sentinels: DECLARED_SENTINELS });
    const text = recordText(dsh.record);
    assertNoSentinel(text, "dsh record");
    assert.match(text, /\[REDACTED:credential-token\]/, "dsh ghp-shaped token redacted by built-in detector");
    assert.match(text, /\[REDACTED:bearer-token\]/, "dsh Bearer value redacted by built-in detector");
    assert.match(text, /\[REDACTED:hidden-reasoning\]/, "dsh reasoning span redacted by built-in detector");
    const hermes = await captureCorpus({ origin: "hermes", rows: buildHermesCorpus(), fields: HERMES_FIELDS, sentinels: DECLARED_SENTINELS });
    const hermesText = recordText(hermes.record);
    assertNoSentinel(hermesText, "hermes record");
    assert.match(hermesText, /\[REDACTED:auth-assignment\]/, "hermes password= value redacted by built-in detector");
  });

  it("(b, wiring) record embeds the ordered-projection hash and the sanitized-derivative hash as locator digests", async () => {
    for (const [origin, rows, fields] of [
      ["pi", buildPiCorpus(), PI_FIELDS],
      ["dsh", buildDshCorpus(), DSH_FIELDS],
      ["hermes", buildHermesCorpus(), HERMES_FIELDS],
    ] as Array<["pi" | "dsh" | "hermes", RawRow[], readonly string[]]>) {
      const summary = await captureCorpus({ origin, rows, fields, sentinels: DECLARED_SENTINELS });
      const projectionLocator = summary.record.sourceIdentity.sourceRefs.find((r: any) => r.locatorId === "projection");
      const sanitizedLocator = summary.record.sourceIdentity.sourceRefs.find((r: any) => r.locatorId === "sanitized-projection");
      assert.ok(projectionLocator && sanitizedLocator, `${origin}: projection + sanitized locators present`);
      assert.equal(projectionLocator.sha256, summary.projectionSha256, `${origin}: projection hash embedded`);
      assert.equal(sanitizedLocator.sha256, summary.sanitizedSha256, `${origin}: sanitized hash embedded`);
      assert.equal(locatorSha(summary.record, "input"), summary.projection.input.sha256, `${origin}: input fingerprint embedded`);
      assert.equal(summary.record.sourceIdentity.sourceSha256, summary.projection.input.sha256);
      // Independent recomputation from a fresh parse must match (determinism).
      const mod = await loadImporter();
      const fresh = mod.parsePublicProjection({ origin, input: cloneJson(rows), session: SESSION_ID, publicFieldOrder: [...fields] });
      assert.equal(mod.hashPublicProjection(fresh), summary.projectionSha256, `${origin}: hash reproducible`);
      const freshSanitized = mod.sanitizeProjection(fresh, { sentinels: [...DECLARED_SENTINELS] });
      assert.equal(mod.hashPublicProjection(freshSanitized.sanitized), summary.sanitizedSha256, `${origin}: sanitized hash reproducible`);
    }
  });

  it("(c) synthetic provenance labels every row synthetic and declared unknowns surface as unknown", async () => {
    const summary = await captureCorpus({
      origin: "pi",
      rows: buildPiCorpus(),
      fields: PI_FIELDS,
      provenance: "synthetic",
      sentinels: DECLARED_SENTINELS,
      unknown: [{ fact: "the single raw stdout byte of the historical dsh round is not retained", reason: "missing" }],
    });
    const labels = observationClassifications(summary.record);
    assert.ok(labels.length > 0);
    for (const label of labels) {
      assert.equal(label, "synthetic", "synthetic provenance must label every observation synthetic");
    }
    assert.ok(summary.record.transformations.some((t: any) => t.step === "adapt.declare_synthetic"), "synthetic adaptation declared");
    assert.equal(summary.validation.ok, true, JSON.stringify(summary.validation));
    assert.equal(summary.validation.unknowns.length, 1);
    assert.equal(summary.validation.unknowns[0].classification, "unknown");
    assert.equal(summary.validation.unknowns[0].reason, "missing");
    assertNoSentinel(recordText(summary.record), "synthetic record");
  });

  it("(c) provenance is an explicit required choice; synthetic classification survives sanitization", async () => {
    const mod = await loadImporter();
    // Synthetic rows carrying sentinels that the built-in detectors catch. Under
    // provenance "synthetic" these rows MUST stay classified "synthetic" even
    // though they are sanitized into derivatives — never relabelled
    // "sanitized"/"captured", and never silently treated as real capture.
    const syntheticRows = buildPiCorpus();
    const synth = await captureCorpus({
      origin: "pi",
      rows: syntheticRows,
      fields: PI_FIELDS,
      provenance: "synthetic",
      sentinels: DECLARED_SENTINELS,
    });
    const synthLabels = observationClassifications(synth.record);
    assert.ok(synthLabels.length > 0);
    for (const label of synthLabels) {
      assert.equal(label, "synthetic", "synthetic provenance must label every observation synthetic, even sanitized rows");
    }
    assert.ok(
      synth.record.transformations.some((t: any) => t.step === "adapt.declare_synthetic"),
      "synthetic adaptation must be declared",
    );
    assert.ok(synth.redactions.length > 0, "synthetic corpus was sanitized (redaction evidence retained)");
    assert.equal(synth.validation.ok, true, JSON.stringify(synth.validation));
    assertNoSentinel(recordText(synth.record), "synthetic record");

    // A caller deliberately simulating the captured path declares "captured":
    // the adaptation transform is ABSENT and rows are labelled captured/sanitized
    // (the record records the caller's assertion, never a verified real origin).
    const captured = await captureCorpus({
      origin: "pi",
      rows: syntheticRows,
      fields: PI_FIELDS,
      provenance: "captured",
      sentinels: DECLARED_SENTINELS,
    });
    assert.equal(
      captured.record.transformations.some((t: any) => t.step === "adapt.declare_synthetic"),
      false,
      "captured provenance must not declare a synthetic adaptation",
    );
    assert.ok(
      !observationClassifications(captured.record).includes("synthetic"),
      "captured provenance rows must never be labelled synthetic",
    );
    assert.ok(
      observationClassifications(captured.record).includes("sanitized"),
      "captured provenance rows with sentinels are sanitized derivatives",
    );
    assert.equal(captured.validation.ok, true, JSON.stringify(captured.validation));
  });

  it("auth/credential assignment and header values are redacted completely (no partial-value leak)", async () => {
    const mod = await loadImporter();
    const sanitizeOut = (text: string): { out: string; reasons: string[] } => {
      const rows = [
        {
          type: "message",
          timestamp: "2026-08-27T06:24:46.059Z",
          message: {
            role: "tool",
            content: [
              { type: "toolResult", toolCallId: "call_synth_redact_0001", exitCode: 0, content: [{ type: "text", text }] },
            ],
          },
        },
      ];
      const projection = mod.parsePublicProjection({ origin: "pi", input: rows, session: SESSION_ID, publicFieldOrder: [...PI_FIELDS] });
      const { sanitized, redactions } = mod.sanitizeProjection(projection, { sentinels: [] });
      return { out: sanitized.rows[0].public.output ?? "", reasons: redactions.map((r: any) => r.reason) };
    };

    // Reported defect 1: "Authorization: Basic <base64>" leaked the base64 payload
    // because only the first scheme token ("Basic") was redacted.
    const basic = sanitizeOut("Authorization: Basic dXNlcjpwYXNz");
    assert.equal(basic.out, "Authorization: [REDACTED:authorization-header]");
    assert.equal(basic.out.includes("dXNlcjpwYXNz"), false, "base64 credentials must not leak");
    assert.ok(basic.reasons.includes("authorization-header"), `expected authorization-header redaction, got ${basic.reasons}`);

    // Reported defect 2: "login password: my secret passphrase 789 done" left
    // "secret passphrase 789 done" after redacting only "my".
    const pass = sanitizeOut("login password: my secret passphrase 789 done");
    assert.equal(pass.out, "login password: [REDACTED:auth-assignment]");
    assert.equal(pass.out.includes("secret passphrase"), false, "multi-token password must not leak");
    assert.ok(pass.reasons.includes("auth-assignment"));

    // Quoted multi-token value redacted as a unit; trailing clear content kept.
    const quoted = sanitizeOut('password="my secret passphrase" next=ok');
    assert.equal(quoted.out, 'password=[REDACTED:auth-assignment] next=ok');

    // Bare-then-quoted shape (regression): a quote appearing partway through a
    // value is NOT a delimiter — the rest of the credential field is consumed
    // and redacted, never partially kept. This is the exact partial-value leak
    // class the task asked to close (quoted forms; "do not treat only the first
    // auth scheme token as the secret").
    const bareThenQuoted = sanitizeOut('password=pw "the secret" rest');
    assert.equal(bareThenQuoted.out, 'password=[REDACTED:auth-assignment]');
    assert.equal(bareThenQuoted.out.includes('"the secret"'), false, 'bare-then-quoted password must not partially leak the quoted remainder');
    assert.ok(bareThenQuoted.reasons.includes('auth-assignment'));

    // Authorization header with a quoted base64 payload (regression): the base64
    // of the original reported defect must not leak when the scheme is followed
    // by a quoted token.
    const quotedAuth = sanitizeOut('Authorization: Basic "dXNlcjpwYXNz"');
    assert.equal(quotedAuth.out, 'Authorization: [REDACTED:authorization-header]');
    assert.equal(quotedAuth.out.includes('dXNlcjpwYXNz'), false, 'quoted base64 credentials must not leak');
    assert.ok(quotedAuth.reasons.includes('authorization-header'), `expected authorization-header redaction, got ${quotedAuth.reasons}`);

    // Mixed case folded.
    assert.equal(sanitizeOut("PASSWORD=supersecret").out, "PASSWORD=[REDACTED:auth-assignment]");
    assert.equal(sanitizeOut("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9").out, "Authorization: [REDACTED:authorization-header]");

    // Bearer credential inside a header is fully redacted (not just the scheme).
    assert.equal(sanitizeOut("Authorization: Bearer tok123").out.includes("tok123"), false);

    // Negative controls: adjacent clear fields preserved at an unambiguous delimiter.
    assert.equal(
      sanitizeOut("password=my secret phrase, username=alice").out,
      "password=[REDACTED:auth-assignment], username=alice",
    );
    assert.equal(
      sanitizeOut("api_key=abc; token=def; username=bob").out,
      "api_key=[REDACTED:auth-assignment]; token=[REDACTED:auth-assignment]; username=bob",
    );

    // Newline is an unambiguous boundary: the next line is not swallowed.
    assert.equal(sanitizeOut("password=secret\nnext=foo").out, "password=[REDACTED:auth-assignment]\nnext=foo");

    // Normal-content controls: content that is NOT a credential assignment passes through.
    assert.equal(sanitizeOut("the token lives on the server").out, "the token lives on the server");
    assert.equal(sanitizeOut("the api endpoint is https://example.com").out, "the api endpoint is https://example.com");
  });

  it("escaped-quote and incomplete (unterminated) quoted credential values are fully redacted (no partial/ignored leak)", async () => {
    const mod = await loadImporter();
    const sanitizeOut = (text: string): { out: string; reasons: string[] } => {
      const rows = [
        {
          type: "message",
          timestamp: "2026-08-27T06:24:46.059Z",
          message: {
            role: "tool",
            content: [
              { type: "toolResult", toolCallId: "call_synth_redact_0002", exitCode: 0, content: [{ type: "text", text }] },
            ],
          },
        },
      ];
      const projection = mod.parsePublicProjection({ origin: "pi", input: rows, session: SESSION_ID, publicFieldOrder: [...PI_FIELDS] });
      const { sanitized, redactions } = mod.sanitizeProjection(projection, { sentinels: [] });
      return { out: sanitized.rows[0].public.output ?? "", reasons: redactions.map((r: any) => r.reason) };
    };

    // Escaped DOUBLE quote inside a quoted password: the escaped quote is NOT a
    // closing delimiter, so the whole quoted unit is consumed — never the
    // secret tail left visible after a premature close.
    const escDouble = sanitizeOut(String.raw`password="prefix\"SYNTHETIC_SECRET_TAIL rest"; status=ok`);
    assert.equal(escDouble.out, "password=[REDACTED:auth-assignment]; status=ok");
    assert.equal(escDouble.out.includes("SYNTHETIC_SECRET_TAIL"), false, "escaped double quote must not leak the secret tail");
    assert.ok(escDouble.reasons.includes("auth-assignment"));

    // Escaped SINGLE quote inside a quoted password.
    const escSingle = sanitizeOut(String.raw`password='prefix\'SYNTHETIC_SECRET_TAIL rest'; status=ok`);
    assert.equal(escSingle.out, "password=[REDACTED:auth-assignment]; status=ok");
    assert.equal(escSingle.out.includes("SYNTHETIC_SECRET_TAIL"), false, "escaped single quote must not leak the secret tail");
    assert.ok(escSingle.reasons.includes("auth-assignment"));

    // Incomplete (unterminated) quoted password: no closing quote — redact
    // through the conservative line bound instead of leaking or ignoring.
    const unterminated = sanitizeOut("password=\"SYNTHETIC_SECRET_TAIL rest");
    assert.equal(unterminated.out, "password=[REDACTED:auth-assignment]");
    assert.equal(unterminated.out.includes("SYNTHETIC_SECRET_TAIL"), false, "unterminated quoted password must be fully redacted");
    assert.ok(unterminated.reasons.includes("auth-assignment"));

    // The same boundary rules hold across the other recognized value families
    // (token=, secret=, api_key=): an escaped quote is not a delimiter and an
    // unclosed quote is bounded conservatively.
    const tokenEsc = sanitizeOut(String.raw`token="a\"SYNTHETIC_SECRET_TAIL b"; x=1`);
    assert.equal(tokenEsc.out, "token=[REDACTED:auth-assignment]; x=1");
    assert.equal(tokenEsc.out.includes("SYNTHETIC_SECRET_TAIL"), false, "escaped double quote in token= must not leak");
    const secretEsc = sanitizeOut(String.raw`secret='s\'SYNTHETIC_SECRET_TAIL t'; y=2`);
    assert.equal(secretEsc.out, "secret=[REDACTED:auth-assignment]; y=2");
    assert.equal(secretEsc.out.includes("SYNTHETIC_SECRET_TAIL"), false, "escaped single quote in secret= must not leak");
    const apiKeyUnterm = sanitizeOut('api_key="SYNTHETIC_SECRET_TAIL rest');
    assert.equal(apiKeyUnterm.out, "api_key=[REDACTED:auth-assignment]", "unterminated api_key= must be fully redacted through the line bound");
    assert.equal(apiKeyUnterm.out.includes("SYNTHETIC_SECRET_TAIL"), false, "unterminated api_key= must not leak the secret tail");
    assert.ok(apiKeyUnterm.reasons.includes("auth-assignment"));

    // authorization-header: an escaped quote inside a quoted value and an
    // unterminated quoted value are both fully redacted.
    const headerEsc = sanitizeOut(String.raw`Authorization: "dXNlcjpwYXNz\"tail" rest`);
    assert.equal(headerEsc.out.startsWith("Authorization: [REDACTED:authorization-header]"), true);
    assert.equal(headerEsc.out.includes("dXNlcjpwYXNz"), false, "escaped quote in a quoted authorization header must not leak");
    assert.ok(headerEsc.reasons.includes("authorization-header"));
    const headerUnterm = sanitizeOut('Authorization: "dXNlcjpwYXNz');
    assert.equal(headerUnterm.out, "Authorization: [REDACTED:authorization-header]");
    assert.equal(headerUnterm.out.includes("dXNlcjpwYXNz"), false, "unterminated quoted authorization header must be fully redacted");

    // Normal-content controls: content that is NOT a recognized credential
    // assignment passes through untouched, and a properly-closed quote is an
    // honest delimiter preserving the neighbor field.
    assert.equal(sanitizeOut("the password lives on the server").out, "the password lives on the server");
    assert.equal(sanitizeOut('password="my secret passphrase" next=ok').out, "password=[REDACTED:auth-assignment] next=ok");
    assert.equal(sanitizeOut('password="ab" more').out, "password=[REDACTED:auth-assignment] more");
  });

  it("(c) a clean corpus stays all-captured with zero redactions and identical raw/sanitized hashes", async () => {
    const summary = await captureCorpus({ origin: "dsh", rows: buildCleanDshCorpus(), fields: DSH_FIELDS, sentinels: [] });
    const labels = observationClassifications(summary.record);
    for (const label of labels) {
      assert.equal(label, "captured", "clean corpus rows must be labeled captured, never sanitized");
    }
    assert.equal(summary.redactions.length, 0);
    assert.equal(summary.record.transformations.some((t: any) => t.step === "sanitize.redact"), false);
    assert.equal(summary.sanitizedSha256, summary.projectionSha256, "no redaction -> sanitized hash equals raw hash");
    assert.deepEqual(summary.validation, { ok: true }, "clean record with no unknowns validates to exactly {ok:true}");
    // Every row projected: nothing silently dropped.
    assert.equal(summary.record.observations.length, buildCleanDshCorpus().length);
  });

  it("(linkage) retained call/result linkage and accepted reports; unresolved linkage becomes explicit unknowns", async () => {
    const mod = await loadImporter();
    const pi = await captureCorpus({
      origin: "pi",
      rows: buildPiCorpus(),
      fields: PI_FIELDS,
      sentinels: DECLARED_SENTINELS,
      reports: [
        { callId: "call_synth_pi_0001", note: "agent reported STATUS: retry / REBASED: true" },
        { callId: "call_synth_pi_0001", note: `agent echoed a secret: ${ULTRA_SENTINEL}` },
      ],
    });
    const obs = pi.record.observations;
    const callObs = obs.find((o: any) => o.id === "obs-0001");
    const resultObs = obs.find((o: any) => o.id === "obs-0002");
    assert.ok(callObs && resultObs, "pi call + result observations present");
    assert.deepEqual(callObs.fact.link, { kind: "call", callId: "call_synth_pi_0001", callCount: 1, resultSeq: 2 });
    assert.deepEqual(resultObs.fact.link, { kind: "result", callId: "call_synth_pi_0001", callSeq: 1 });
    const report1 = obs.find((o: any) => o.id === "report-1");
    const report2 = obs.find((o: any) => o.id === "report-2");
    assert.ok(report1 && report2, "accepted-report observations retained");
    assert.equal(report1.classification, "captured");
    assert.equal(report2.classification, "sanitized", "sentinel-bearing report note is a sanitized derivative");
    assert.equal(report2.fact.kind, "accepted-report");
    assertNoSentinel(recordText(pi.record), "pi record with reports");
    assert.equal(pi.validation.ok, true, JSON.stringify(pi.validation));

    // Unresolved linkage (result whose call row lives in an adjacent file).
    const ghostRows: RawRow[] = [
      {
        type: "message",
        timestamp: "2026-08-27T06:24:46.059Z",
        message: {
          role: "tool",
          content: [
            {
              type: "toolResult",
              toolCallId: "call_synth_pi_GHOST",
              exitCode: 1,
              content: [{ type: "text", text: "output of a call made in an earlier session file" }],
            },
          ],
        },
      },
    ];
    const ghost = await captureCorpus({ origin: "pi", rows: ghostRows, fields: PI_FIELDS, sentinels: [] });
    assert.equal(ghost.validation.ok, true, JSON.stringify(ghost.validation));
    const ghostObs = ghost.record.observations[0];
    assert.deepEqual(ghostObs.fact.link, { kind: "result", callId: "call_synth_pi_GHOST", callSeq: null });
    const unknowns = ghost.validation.unknowns ?? [];
    assert.ok(unknowns.length >= 1, "unresolved result linkage must surface as an explicit unknown");
    assert.ok(
      unknowns.some((u: any) => u.reason === "missing" && /no matching call row/.test(u.fact)),
      `expected missing-linkage unknown, got ${JSON.stringify(unknowns)}`,
    );
    assertNoSentinel(recordText(ghost.record), "ghost record");

    // Unresolved call (call row whose result lives in a later file).
    const callOnlyRows: RawRow[] = [
      {
        type: "message",
        timestamp: "2026-08-27T06:24:50.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_synth_pi_0003", name: "bash", arguments: { command: "git log" } },
          ],
        },
      },
    ];
    const callOnly = await captureCorpus({ origin: "pi", rows: callOnlyRows, fields: PI_FIELDS, sentinels: [] });
    assert.equal(callOnly.validation.ok, true, JSON.stringify(callOnly.validation));
    assert.ok(
      (callOnly.validation.unknowns ?? []).some((u: any) => u.reason === "missing" && /no result row/.test(u.fact)),
      "unresolved call linkage must surface as an explicit unknown",
    );
    // dsh rowType / terminal_code projection.
    const dsh = await captureCorpus({ origin: "dsh", rows: buildDshCorpus(), fields: DSH_FIELDS, sentinels: DECLARED_SENTINELS });
    const turnEnd = dsh.record.observations.find((o: any) => o.id === "obs-0007");
    assert.ok(turnEnd, "dsh turn/end observation present");
    assert.equal(turnEnd.fact.public.terminal_code, "MISSING_CREDENTIAL");
    // hermes linkage + command hashes.
    const hermes = await captureCorpus({ origin: "hermes", rows: buildHermesCorpus(), fields: HERMES_FIELDS, sentinels: DECLARED_SENTINELS });
    const h1 = hermes.record.observations.find((o: any) => o.id === "obs-0001");
    assert.deepEqual(h1.fact.link, { kind: "call", callId: "call_synth_hm_0001", callCount: 1, resultSeq: 2 });
    assert.equal(h1.fact.public.command_sha256, sha256Hex("npm test"), "hermes command_sha256 is the sha256 of the command");
    const h2 = hermes.record.observations.find((o: any) => o.id === "obs-0002");
    assert.deepEqual(h2.fact.link, { kind: "result", callId: "call_synth_hm_0001", callSeq: 1 });
  });

  it("(e) reasoning/auth fields never appear in emitted projections (structural assertion)", async () => {
    const mod = await loadImporter();
    // Raw rows carry reasoning at row level (pi r1), in hidden-reasoning
    // spans (pi/dsh), in user prompts (pi r5 / hermes r4) and an auth
    // header — none may reach a projection or an emitted record.
    for (const [origin, rows, fields] of [
      ["pi", buildPiCorpus(), PI_FIELDS],
      ["dsh", buildDshCorpus(), DSH_FIELDS],
      ["hermes", buildHermesCorpus(), HERMES_FIELDS],
    ] as Array<["pi" | "dsh" | "hermes", RawRow[], readonly string[]]>) {
      const summary = await captureCorpus({ origin, rows, fields, sentinels: DECLARED_SENTINELS });
      // 1) The raw projection carries captured public output (which may
      //    embed sentinels pending sanitization) BUT never a row-level
      //    reasoning/auth field: the pi r1 reasoning marker and the prompt
      //    auth header must not appear even in the pre-sanitize projection.
      const rawProjectionText = JSON.stringify(summary.projection.rows);
      assert.equal(rawProjectionText.includes(ROW_REASONING_MARKER), false, `${origin}: row-level reasoning field was projected`);
      assert.equal(rawProjectionText.includes(AUTH_HEADER), false, `${origin}: prompt auth header was projected`);
      for (const row of summary.projection.rows) {
        for (const key of Object.keys(row.public)) {
          assert.equal(DENIED_KEY_RE.test(key), false, `${origin}: denied projection key ${JSON.stringify(key)}`);
        }
      }
      // 2) The sanitized rows and the emitted record never contain ANY
      //    sentinel (captured content sentinels are scrubbed before use).
      assertNoSentinel(JSON.stringify(summary.sanitized.rows), `${origin} sanitized rows`);
      assertNoSentinel(recordText(summary.record), `${origin} record`);
      // 3) No denied key anywhere in the emitted record object graph.
      const keys = new Set<string>();
      collectKeys(summary.record, keys);
      for (const key of keys) {
        assert.equal(DENIED_KEY_RE.test(key), false, `${origin}: denied key ${JSON.stringify(key)} present in record`);
      }
      // 4) Every observation fact key set is confined to the documented
      //    public-fact vocabulary.
      for (const obs of summary.record.observations) {
        for (const key of Object.keys(obs.fact)) {
          assert.ok(
            ["rowType", "position", "public", "link", "kind", "callId", "note"].includes(key),
            `${origin}: unexpected observation fact key ${key}`,
          );
        }
      }
    }
    // 5) Denied field names are refused at the API boundary.
    for (const denied of ["reasoning_text", "password", "authorization", "api_key", "token", "secret"]) {
      assert.throws(
        () =>
          mod.parsePublicProjection({
            origin: "pi",
            input: buildPiCorpus(),
            session: SESSION_ID,
            publicFieldOrder: ["timestamp", denied],
          }),
        /denied|not an extractable public field/,
        `field ${denied} must be refused`,
      );
    }
    // 6) A caller cannot ask for a field outside the origin vocabulary.
    assert.throws(
      () =>
        mod.parsePublicProjection({
          origin: "pi",
          input: buildPiCorpus(),
          session: SESSION_ID,
          publicFieldOrder: ["timestamp", "no_such_field"],
        }),
      /not an extractable public field/,
    );
  });

  it("(d) fails closed on unknown origin, missing session/input and invalid provenance", async () => {
    const mod = await loadImporter();
    const rows = buildPiCorpus();
    const base = { origin: "pi", input: rows, session: SESSION_ID, publicFieldOrder: [...PI_FIELDS] } as any;
    assert.throws(() => mod.parsePublicProjection({ ...base, origin: "claude" }), /unknown origin/);
    assert.throws(() => mod.captureRecording({ ...base, origin: "claude", runId: RUN_ID }), /unknown origin/);
    assert.throws(() => mod.parsePublicProjection({ ...base, session: undefined }), /session argument is required/);
    assert.throws(() => mod.parsePublicProjection({ ...base, input: undefined }), /input argument is required/);
    assert.throws(() => mod.parsePublicProjection({ ...base, publicFieldOrder: [] }), /publicFieldOrder must be a non-empty/);
    assert.throws(
      () => mod.parsePublicProjection({ ...base, publicFieldOrder: ["timestamp", "timestamp"] }),
      /duplicate public field/,
    );
    assert.throws(
      () => mod.captureRecording({ ...base, runId: RUN_ID, provenance: "invented" }),
      /provenance must be one of/,
    );
    assert.throws(() => mod.captureRecording({ ...base }), /runId argument is required/);
    // provenance is an EXPLICIT REQUIRED choice: an omitted provenance is
    // refused (never silently invented as "captured"), and the refusal is
    // issued before any unknown/report validation so a caller must own the
    // origin decision first.
    assert.throws(
      () => mod.captureRecording({ ...base, runId: RUN_ID }),
      /provenance argument is required/,
    );
    assert.throws(
      () => mod.captureRecording({ ...base, runId: RUN_ID, provenance: undefined }),
      /provenance argument is required/,
    );
    assert.throws(
      () =>
        mod.captureRecording({
          ...base,
          runId: RUN_ID,
          provenance: "captured",
          unknown: [{ fact: "x", reason: "invented" }],
        }),
      /unknown\[0\]\.reason must be one of/,
    );
    assert.throws(
      () => mod.sanitizeProjection({ rows: [] }, { sentinels: "not-an-array" }),
      /sentinels must be an array/,
    );
  });

  it("(d) fails closed on unsupported row shapes with useful diagnostics", async () => {
    const mod = await loadImporter();
    const parse = (origin: string, rows: RawRow[], fields: readonly string[]) =>
      mod.parsePublicProjection({ origin, input: rows, session: SESSION_ID, publicFieldOrder: [...fields] });
    // pi parser given a dsh-shaped row.
    assert.throws(() => parse("pi", [{ type: "session", time: "t" }], PI_FIELDS), /unsupported pi row/);
    // pi content item of a reasoning type is never selected.
    assert.throws(
      () =>
        parse("pi", [
          {
            type: "message",
            timestamp: "t",
            message: { role: "assistant", content: [{ type: "reasoning", text: REASONING_MARKER }] },
          },
        ], PI_FIELDS),
      /unsupported pi row.*reasoning/,
    );
    // pi multi-item content rows are an unsupported shape.
    assert.throws(
      () =>
        parse("pi", [
          {
            type: "message",
            timestamp: "t",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "a" },
                { type: "toolCall", id: "call_x", name: "bash", arguments: { command: "ls" } },
              ],
            },
          },
        ], PI_FIELDS),
      /single-item/,
    );
    // dsh unknown event type.
    assert.throws(() => parse("dsh", [{ type: "brand/new/event", time: "t", data: {} }], DSH_FIELDS), /unsupported dsh row/);
    // dsh assistant/chunk of a non-text (reasoning) type.
    assert.throws(
      () =>
        parse("dsh", [
          {
            type: "assistant/chunk",
            time: "t",
            data: { chunk: { type: "reasoning", text: REASONING_MARKER } },
          },
        ], DSH_FIELDS),
      /unsupported dsh row.*chunk type/,
    );
    // hermes unsupported role.
    assert.throws(
      () =>
        parse("hermes", [
          { row_id: 1, session_id: SESSION_ID, role: "supervisor", content: "x", timestamp: 1756000000 },
        ], HERMES_FIELDS),
      /unsupported hermes row/,
    );
    // hermes tool row missing tool_call_id.
    assert.throws(
      () =>
        parse("hermes", [
          { row_id: 1, session_id: SESSION_ID, role: "tool", content: "x", timestamp: 1756000000 },
        ], HERMES_FIELDS),
      /tool row is missing tool_call_id/,
    );
    // hermes tool_calls that are not valid JSON.
    assert.throws(
      () =>
        parse("hermes", [
          {
            row_id: 1,
            session_id: SESSION_ID,
            role: "assistant",
            content: "x",
            tool_calls: "{not json",
            timestamp: 1756000000,
          },
        ], HERMES_FIELDS),
      /tool_calls is not valid JSON/,
    );
  });

  it("(d) fails closed on ambiguous attribution (row-declared session identity mismatch)", async () => {
    const mod = await loadImporter();
    // hermes row whose session_id differs from the explicit session argument.
    assert.throws(
      () =>
        mod.parsePublicProjection({
          origin: "hermes",
          input: [
            { row_id: 1, session_id: OTHER_SESSION_ID, role: "user", content: "x", timestamp: 1756000000 },
          ],
          session: SESSION_ID,
          publicFieldOrder: [...HERMES_FIELDS],
        }),
      /ambiguous attribution/,
    );
    // dsh event whose declared data.sessionId differs.
    assert.throws(
      () =>
        mod.parsePublicProjection({
          origin: "dsh",
          input: [{ type: "session", time: "t", data: { sessionId: OTHER_SESSION_ID } }],
          session: SESSION_ID,
          publicFieldOrder: [...DSH_FIELDS],
        }),
      /ambiguous attribution/,
    );
    // Duplicate call id declared by two rows.
    assert.throws(
      () =>
        mod.parsePublicProjection({
          origin: "pi",
          input: [
            {
              type: "message",
              timestamp: "t1",
              message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "call_dup_0001", name: "bash", arguments: { command: "ls" } }],
              },
            },
            {
              type: "message",
              timestamp: "t2",
              message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "call_dup_0001", name: "bash", arguments: { command: "pwd" } }],
              },
            },
          ],
          session: SESSION_ID,
          publicFieldOrder: [...PI_FIELDS],
        }),
      /ambiguous attribution: call id/,
    );
    // Two result rows for the same call id.
    assert.throws(
      () =>
        mod.parsePublicProjection({
          origin: "pi",
          input: [
            {
              type: "message",
              timestamp: "t1",
              message: {
                role: "assistant",
                content: [{ type: "toolCall", id: "call_dup_0002", name: "bash", arguments: { command: "ls" } }],
              },
            },
            {
              type: "message",
              timestamp: "t2",
              message: {
                role: "tool",
                content: [
                  { type: "toolResult", toolCallId: "call_dup_0002", exitCode: 0, content: [{ type: "text", text: "a" }] },
                ],
              },
            },
            {
              type: "message",
              timestamp: "t3",
              message: {
                role: "tool",
                content: [
                  { type: "toolResult", toolCallId: "call_dup_0002", exitCode: 0, content: [{ type: "text", text: "b" }] },
                ],
              },
            },
          ],
          session: SESSION_ID,
          publicFieldOrder: [...PI_FIELDS],
        }),
      /ambiguous attribution: call id/,
    );
  });

  it("(d) fails closed on unreadable, empty and truncated caller-owned temp files", async () => {
    const mod = await loadImporter();
    await withTempDir(async (dir) => {
      const missing = path.join(dir, "missing.jsonl");
      assert.throws(
        () =>
          mod.parsePublicProjection({
            origin: "pi",
            input: missing,
            session: SESSION_ID,
            publicFieldOrder: [...PI_FIELDS],
          }),
        /cannot read input file/,
      );
      const empty = path.join(dir, "empty.jsonl");
      fs.writeFileSync(empty, "");
      assert.throws(
        () =>
          mod.parsePublicProjection({
            origin: "pi",
            input: empty,
            session: SESSION_ID,
            publicFieldOrder: [...PI_FIELDS],
          }),
        /no JSON rows/,
      );
      const truncated = path.join(dir, "truncated.jsonl");
      const validLine = JSON.stringify(buildPiCorpus()[0]);
      fs.writeFileSync(truncated, `${validLine}\n${'{"type":"message","ti'}`);
      assert.throws(
        () =>
          mod.parsePublicProjection({
            origin: "pi",
            input: truncated,
            session: SESSION_ID,
            publicFieldOrder: [...PI_FIELDS],
          }),
        /final line may be truncated/,
      );
    });
  });

  it("(file input) reads a caller-owned synthetic JSONL file and emits a valid, sentinel-free record", async () => {
    const mod = await loadImporter();
    const contract = await loadContract();
    await withTempDir(async (dir) => {
      const file = path.join(dir, "pi-corpus.jsonl");
      const rows = buildPiCorpus();
      fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
      const fileText = fs.readFileSync(file, "utf8");
      const record = mod.captureRecording({
        origin: "pi",
        input: file,
        session: SESSION_ID,
        publicFieldOrder: [...PI_FIELDS],
        runId: RUN_ID,
        caseId: "SYNTH-CASE-US002-FILE",
        provenance: "captured",
        sentinels: [...DECLARED_SENTINELS],
      });
      const validation = contract.validateRecordingRecord(record);
      assert.equal(validation.ok, true, JSON.stringify(validation));
      assertNoSentinel(recordText(record), "file-input record");
      const inputRef = record.sourceIdentity.sourceRefs.find((r: any) => r.locatorId === "input");
      assert.ok(inputRef, "input locator present");
      assert.equal(inputRef.locator.source, file, "input locator names the caller-owned file");
      assert.equal(inputRef.sha256, sha256Hex(fileText), "input fingerprint is the sha256 of the file text");
      assert.equal(inputRef.locator.rows, rows.length);
      const labels = observationClassifications(record);
      assert.ok(labels.includes("captured") && labels.includes("sanitized"));
    });
  });

  it("(f) every emitted record across all scenarios validates under the US-001 contract", async () => {
    const summaries = [
      await captureCorpus({ origin: "pi", rows: buildPiCorpus(), fields: PI_FIELDS, sentinels: DECLARED_SENTINELS }),
      await captureCorpus({ origin: "dsh", rows: buildDshCorpus(), fields: DSH_FIELDS, sentinels: DECLARED_SENTINELS }),
      await captureCorpus({ origin: "hermes", rows: buildHermesCorpus(), fields: HERMES_FIELDS, sentinels: DECLARED_SENTINELS }),
      await captureCorpus({ origin: "pi", rows: buildPiCorpus(), fields: PI_FIELDS, provenance: "synthetic", sentinels: DECLARED_SENTINELS }),
      await captureCorpus({ origin: "dsh", rows: buildCleanDshCorpus(), fields: DSH_FIELDS, sentinels: [] }),
      await captureCorpus({
        origin: "hermes",
        rows: buildHermesCorpus(),
        fields: HERMES_FIELDS,
        sentinels: DECLARED_SENTINELS,
        reports: [{ callId: "call_synth_hm_0001", note: "report: accepted with no secret" }],
      }),
    ];
    for (const summary of summaries) {
      assert.equal(summary.validation.ok, true, `record must validate: ${JSON.stringify(summary.validation)}`);
      assertNoSentinel(recordText(summary.record), "validated record");
      // Emitted observations always carry an id, classification, fact and a
      // resolving sourceRef.
      for (const obs of summary.record.observations) {
        assert.ok(typeof obs.id === "string" && obs.id.length > 0);
        assert.ok(["captured", "sanitized", "synthetic"].includes(obs.classification));
        assert.ok(obs.fact !== null && typeof obs.fact === "object");
        assert.ok(["projection", "input"].includes(obs.sourceRef), `unexpected observation sourceRef ${obs.sourceRef}`);
      }
    }
  });
});
