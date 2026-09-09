// core-recording-import.mjs — CORE US-002 explicit read-only capture /
// sanitization importer (pure ESM, zero product coupling).
//
// Beads tamandua-6sy.7 / tamandua-6sy.7.1, bounded slice CORE-1, story
// US-002. This module REUSES the US-001 recording contract module
// (./core-recording-contract.mjs) and adds the explicit, safe, READ-ONLY
// capture/sanitization boundary that CORE recorded regression cells need:
//
//   parsePublicProjection({origin, input, session, publicFieldOrder})
//     Read selected pi JSONL rows, dsh post-decompression session-JSONL rows
//     or Hermes native public row shapes using an EXPLICIT input (a caller-
//     owned synthetic file path or an in-memory array of parsed rows) and an
//     EXPLICIT session identity. Produce an ordered public-field projection:
//     one entry per input row (in input order) carrying EXACTLY the caller's
//     explicitly ordered public fields. Reasoning/auth fields are never on
//     the extractable vocabulary, so they can never be requested or emitted.
//
//   sanitizeProjection(projection, {sentinels}) -> {sanitized, redactions}
//     Scrub private-value sentinels (declared literals AND built-in generic
//     credential shapes: private-key blocks, sk-/ghp-/AKIA-like tokens,
//     Bearer tokens, password/token/secret assignments, tagged hidden
//     reasoning) from every string leaf of the projection's captured public
//     values and return the sanitized clone plus redaction evidence
//     [{fieldPath, reason, replacedWith}].
//
//   hashPublicProjection(projection) -> sha256 hex
//     Deterministic digest over the EXPLICITLY ORDERED public-field
//     projection (single-read snapshot semantics — see below).
//
//   captureRecording({...}) -> US-001 versioned record
//     Compose the above into a versioned recording record that DISTINCTLY
//     labels captured public output vs sanitized derivative vs synthetic
//     adaptation vs unknown data, embedding source identity (incl. the
//     ordered-projection hash and a sanitized-derivative hash), redaction
//     evidence, retained call/result linkage and accepted reports.
//
// Design invariants (hermetic and read-only):
//   * No subprocess spawning/execution of any kind and no dynamic code
//     evaluation of any kind, no network, no writes of any kind. The only imports are node builtins
//     (node:fs for READ-ONLY input files) plus the US-001 contract module.
//     No new dependency.
//   * Never executes captured shell text: raw command text is only ever
//     hashed (command_sha256); full credential-bearing prompts and operator
//     messages are never projected at all.
//   * NEVER silently rewrites an honest account: missing/unretained facts
//     become explicit unknown entries with a US-001 closed-set reason, and
//     synthetic stand-in input is declared synthetic end-to-end. Sanitized
//     rows are labeled "sanitized", untouched rows "captured".
//   * Provenance is an EXPLICIT REQUIRED choice on captureRecording
//     (captured | synthetic) with a clear missing-value refusal: the
//     importer NEVER infers whether a caller's rows are truthful or
//     synthetic, and an omitted provenance is refused rather than being
//     silently invented as "captured". "captured" is the CALLER'S ASSERTION
//     that the rows are captured public output — the record records that
//     assertion, it cannot verify it (nor does it label the record as a
//     simulation); "synthetic" is a declared synthetic adaptation standing
//     in for unretained data. A synthetic corpus must declare "synthetic"
//     and retain that classification even when its rows are sanitized into
//     derivatives.
//   * Fails closed with a useful diagnostic (never a partial or unlabeled
//     record) on: unknown origin, unsupported row shape, missing input,
//     session or provenance argument, unreadable/truncated/incomplete input
//     and ambiguous attribution (row-declared session identity conflicting
//     with the explicit session argument).
//
// Sanitization limits (honest, finite scanner): this is NOT a promise to
// sanitize arbitrary secrets forever. The built-in shapes cover the
// documented credential/header/token/reasoning families and DECLARED literal
// sentinels; a value whose boundaries are ambiguous is conservatively
// removed (the credential field's remainder is dropped and the loss is
// documented in redaction evidence / transformation metadata), never
// partially kept. For the quoted credential/header forms, the value extent
// is computed by a bounded scanner (findCredentialValueEnd): an escaped
// quote inside a quoted value is NOT a closing delimiter (so a value like
// password="prefix\"secret tail" is taken as one quoted unit), and a quote
// that never closes is conservatively bounded at the end of the line — the
// open value is fully removed rather than leaked or left partially visible.
// The scanner makes no promise about arbitrary secrets OUTSIDE a recognized
// credential value; a properly-closed quote (or an unambiguous delimiter) is
// an honest boundary and the text after it is a separate neighbor field. The
// explicit-public-fields/sentinels contract remains the authoritative
// sanitization boundary for anything outside the finite shape set.
//
// Snapshot semantics (honest boundary): the projection is derived from ONE
// read of ONE explicit input. Its hash is therefore a single-read snapshot —
// never an immutable hash of a concurrently changing whole database or
// stream. Native Hermes specimens live in a readonly state.db whose
// session-file directory is empty; importing them here means the caller
// hands us the readonly row snapshot as an in-memory rows array (or a file
// containing those rows) — this module never opens a database.
//
// Row-shape contract (SYNTHETIC fixture vocabulary, documented so the gate
// is reproducible): the exact shapes this importer accepts are described per
// origin below. They model the PUBLIC vocabulary observed in the ORIGINAL
// coordinator inventory (run ids, call ids, command sha256 hashes, exit
// codes, timestamps, dsh event types, hermes message-row columns) — no real
// row, credential, hidden reasoning or operator-specific content is copied
// into this module or into any shipped fixture. Anything outside the
// documented shape fails closed.

import { readFileSync } from "node:fs";
import { buildRecordingRecord, hashText, validateRecordingRecord } from "./core-recording-contract.mjs";

// ---------------------------------------------------------------------------
// Module-level vocabulary
// ---------------------------------------------------------------------------

const ORIGINS = Object.freeze(["pi", "dsh", "hermes"]);

const PROJECTION_FORMAT = "core-recording-public-projection/1";

// Public-field vocabulary per origin. ONLY these names are extractable; a
// request for anything else (including any reasoning/auth-flavored name) is
// refused. The vocabularies deliberately contain no reasoning, prompt,
// credential or authorization field: those are never selectable public
// fields by construction.
const PUBLIC_VOCAB = Object.freeze({
  pi: Object.freeze([
    "timestamp", // row timestamp (ISO string from the raw row)
    "call_id", // tool call / tool result call id
    "tool_name", // tool invoked (bash etc.)
    "command_sha256", // sha256 of the command text — NEVER the raw command
    "exit_code", // tool result exit code (number)
    "output", // captured public output text (assistant text / tool stdout)
  ]),
  dsh: Object.freeze([
    "timestamp", // event time (ISO string from the raw row)
    "terminal_code", // turn/end data.reason.error.code when present
    "output", // assistant/chunk text (captured public output)
  ]),
  hermes: Object.freeze([
    "row_id", // native messages-table row id (DB public identity)
    "timestamp", // ISO timestamp derived from the raw row (unix seconds)
    "role", // user | assistant | tool
    "tool_call_id", // tool result row -> the call id it answers
    "tool_name", // function/tool name from tool_calls or the tool_name column
    "command_sha256", // sha256 of the tool command text — never the raw text
    "output", // assistant final text / tool result text (captured public output)
  ]),
});

// Any public-field request whose name carries a reasoning/auth/credential
// flavour is refused even if a future vocabulary accidentally grew one.
const DENIED_FIELD_RE =
  /(^|[._-])(reason|reasoning|auth|authorization|password|passwd|secret|credential|token|api[_-]?key)([._-]|$)/i;

// dsh session.jsonl.zstd event types observed in the ORIGINAL shape
// reference (assistant/chunk, turn/end, ...). Rows of any other type are an
// unsupported shape and fail closed. Content-bearing types are handled
// explicitly; metadata-only types are projected as {timestamp} rows so the
// row accounting stays complete and nothing is silently dropped.
const DSH_EVENT_TYPES = Object.freeze([
  "session",
  "permission/preset",
  "sandbox/mode",
  "approval/policy",
  "agent/inbox/spliced",
  "turn/start",
  "step/start",
  "user/message",
  "session/title",
  "request/header",
  "request/context",
  "assistant/chunk",
  "step/end",
  "turn/end",
]);

const HERMES_ROLES = Object.freeze(["user", "assistant", "tool"]);

// US-001 unknown-reason closed set, mirrored here so captureRecording can
// fail fast with a clear diagnostic before emitting an invalid record.
const UNKNOWN_REASONS = Object.freeze([
  "unreadable",
  "truncated",
  "malformed",
  "ambiguous",
  "missing",
]);

// Built-in generic credential-shape detectors. Applied (in list order) to
// every string leaf of the captured public values AFTER the caller-declared
// literal sentinels. Each entry is EITHER a regex detector of the shape
// {reason, re, prefixGroups} (prefixGroups is the number of leading capture
// groups to keep verbatim before inserting the redaction marker, so e.g.
// "password=" stays visible while the secret value is replaced) OR a
// conservative value-extent detector of the shape {reason, prefixRe, scanner}
// whose prefixRe matches the key+separator and whose value extent is computed
// by the bounded scanner scanCredentialValues (scanner: "credential-value",
// used by the authorization-header and auth-assignment entries so an escaped
// inner quote and an unclosed quote are bounded conservatively instead of
// being decided by a fragile regex alternation).
const BUILTIN_PATTERNS = Object.freeze([
  {
    reason: "private-key-block",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    prefixGroups: 0,
  },
  {
    reason: "hidden-reasoning",
    re: /<reasoning>[\s\S]*?<\/reasoning>/g,
    prefixGroups: 0,
  },
  {
    reason: "authorization-header",
    // A dedicated, conservative authorization-header handler. An
    // "Authorization:" header carries a scheme ("Basic", "Bearer", ...)
    // AND the whole credential value after it; both are the secret value. We
    // redact the ENTIRE value (never just the first scheme token) so e.g.
    // "Authorization: Basic dXNlcjpwYXNz" cannot leak the base64 payload. The
    // "Authorization:" label stays visible; the value (including inner
    // spaces and quoted forms) is replaced. The value extent is computed by
    // the bounded scanner (findCredentialValueEnd) so a quote is handled
    // conservatively: a value that starts bare and then contains a quote is
    // consumed through the inner quote to the next unambiguous delimiter or
    // end of the line; a value that STARTS with a quote is consumed as a
    // quoted unit where an escaped quote is NOT a closing delimiter, and a
    // quote that never closes bounds the value at the end of the line — a
    // quoted credential is never partially kept, and an unclosed one is
    // conservatively removed (see module-header limitation).
    prefixRe: /\bAuthorization\b[ \t]*:[ \t]*/gi,
    scanner: "credential-value",
  },
  {
    reason: "credential-token",
    // sk- / pk- / ghp- / gho- / ghs- / xox*- / AKIA... / AIza... shaped
    // token-like secrets, bounded by non-word characters.
    re: /(^|[^A-Za-z0-9])((?:sk|pk|ghp|gho|ghs|xox[baprs]|AKIA|AIza)[A-Za-z0-9_-]{6,})/g,
    prefixGroups: 1,
  },
  {
    reason: "bearer-token",
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
    prefixGroups: 0,
  },
  {
    reason: "auth-assignment",
    // name=value / name: value assignment for known credential keys. The
    // value is replaced with the COMPLETE value (never just the first
    // whitespace-delimited token, and never just the first auth scheme
    // token): a bare value runs to the next unambiguous delimiter (comma,
    // semicolon, newline, closing bracket/brace/paren) or end of line, so
    // multi-token passwords ("password: my secret passphrase 789 done") and
    // token values are fully redacted. The value extent is computed by the
    // bounded scanner (findCredentialValueEnd): a value that starts bare and
    // then contains a quote ("password=pw \"the secret\" rest") is consumed
    // through the inner quote to the next unambiguous delimiter or end of
    // line, so the quoted remainder is never partially kept; a value that
    // STARTS with a quote is consumed as a quoted unit where an escaped
    // quote is NOT a closing delimiter, and a quote that never closes is
    // bounded conservatively at the end of the line — a quoted credential is
    // never partially kept and an unclosed one is conservatively removed
    // (see module-header limitation).
    prefixRe: /\b(password|passwd|token|secret|api[_-]?key|authorization|access_token|auth_token)\b[ \t]*[:=][ \t]*/gi,
    scanner: "credential-value",
  },
]);

function redactMarker(reason) {
  return `[REDACTED:${reason}]`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function fail(message) {
  return new Error(`core-recording-import: ${message}`);
}

// ---------------------------------------------------------------------------
// Argument validation (shared by parsePublicProjection and captureRecording)
// ---------------------------------------------------------------------------

function assertOrigin(origin) {
  if (!ORIGINS.includes(origin)) {
    throw fail(`unknown origin ${JSON.stringify(origin)}; supported origins: ${ORIGINS.join("|")}`);
  }
}

function assertSession(session) {
  if (typeof session !== "string" || session.length === 0) {
    throw fail("session argument is required: pass an explicit non-empty session/run identity string");
  }
}

function assertInputProvided(input) {
  if (input === undefined || input === null) {
    throw fail("input argument is required: a caller-owned synthetic file path or an array of parsed rows");
  }
}

function assertRunId(runId) {
  if (typeof runId !== "string" || runId.length === 0) {
    throw fail("runId argument is required: a non-empty run identity string for the single-run record");
  }
}

function assertPublicFieldOrder(publicFieldOrder, origin) {
  if (!Array.isArray(publicFieldOrder) || publicFieldOrder.length === 0) {
    throw fail("publicFieldOrder must be a non-empty array of extractable public field names");
  }
  const seen = new Set();
  for (const field of publicFieldOrder) {
    if (typeof field !== "string" || field.length === 0) {
      throw fail("publicFieldOrder entries must be non-empty strings");
    }
    if (seen.has(field)) {
      throw fail(`duplicate public field ${JSON.stringify(field)} in publicFieldOrder`);
    }
    seen.add(field);
    if (DENIED_FIELD_RE.test(field)) {
      throw fail(
        `public field ${JSON.stringify(field)} is denied: reasoning/auth/credential-bearing fields are never projected`,
      );
    }
    if (!PUBLIC_VOCAB[origin].includes(field)) {
      throw fail(
        `public field ${JSON.stringify(field)} is not an extractable public field for origin ${origin}; extractable: ${PUBLIC_VOCAB[origin].join(", ")}`,
      );
    }
  }
}

function assertSentinels(sentinels) {
  if (sentinels === undefined) return Object.freeze([]);
  if (!Array.isArray(sentinels)) {
    throw fail("sentinels must be an array of literal sentinel strings");
  }
  for (const s of sentinels) {
    if (typeof s !== "string" || s.length === 0) {
      throw fail("sentinels entries must be non-empty strings");
    }
  }
  return Object.freeze([...sentinels]);
}

function assertUnknownEntries(unknown) {
  if (unknown === undefined) return [];
  if (!Array.isArray(unknown)) {
    throw fail("unknown must be an array of {fact, reason} entries");
  }
  return unknown.map((u, i) => {
    if (!isPlainObject(u) || typeof u.fact !== "string" || u.fact.length === 0) {
      throw fail(`unknown[${i}] must be an object with a non-empty fact string`);
    }
    if (!UNKNOWN_REASONS.includes(u.reason)) {
      throw fail(
        `unknown[${i}].reason must be one of ${UNKNOWN_REASONS.join("|")}, got ${JSON.stringify(u.reason)}`,
      );
    }
    return { fact: u.fact, reason: u.reason };
  });
}

function assertReports(reports) {
  if (reports === undefined) return [];
  if (!Array.isArray(reports)) {
    throw fail("reports must be an array of {callId, note} accepted-report entries");
  }
  return reports.map((r, i) => {
    if (!isPlainObject(r) || typeof r.callId !== "string" || r.callId.length === 0) {
      throw fail(`reports[${i}] must be an object with a non-empty callId string`);
    }
    if (typeof r.note !== "string" || r.note.length === 0) {
      throw fail(`reports[${i}].note must be a non-empty public summary string`);
    }
    return { callId: r.callId, note: r.note };
  });
}

function assertProvenance(provenance) {
  if (provenance === undefined || provenance === null) {
    throw fail(
      "provenance argument is required: explicitly declare \"captured\" (the caller asserts the rows are captured public output) or \"synthetic\" (a declared synthetic adaptation); origin cannot be inferred, so an omitted provenance is refused",
    );
  }
  if (!PROVENANCES.includes(provenance)) {
    throw fail(`provenance must be one of ${PROVENANCES.join("|")}, got ${JSON.stringify(provenance)}`);
  }
}

// ---------------------------------------------------------------------------
// Input reading (READ-ONLY; single pass over one explicit input)
// ---------------------------------------------------------------------------

/**
 * Read one explicit input and return { parsed, descriptor }.
 * `input` is either a caller-owned file path (read once, UTF-8) or an array
 * of parsed JSON row objects. Returns parsed entries [{row, line}] plus a
 * public descriptor carrying a content fingerprint (sha256). Fails closed on
 * unreadable paths, empty input and lines that are not valid JSON.
 */
function readInputRows(input) {
  if (typeof input === "string") {
    let text;
    try {
      text = readFileSync(input, "utf8");
    } catch (err) {
      throw fail(`cannot read input file ${JSON.stringify(input)}: ${err && err.code ? err.code : err}`);
    }
    const fingerprint = hashText(text);
    const parsed = [];
    const rawLines = text.split("\n");
    for (let i = 0; i < rawLines.length; i += 1) {
      const rawLine = rawLines[i].replace(/\r$/, "");
      if (rawLine.trim() === "") continue;
      let row;
      try {
        row = JSON.parse(rawLine);
      } catch {
        const hint = i === rawLines.length - 1 ? " (final line may be truncated)" : "";
        throw fail(
          `input file ${JSON.stringify(input)} line ${i + 1} is not valid JSON${hint}; refusing a truncated or malformed read`,
        );
      }
      if (!isPlainObject(row)) {
        throw fail(`input file ${JSON.stringify(input)} line ${i + 1} is not a JSON object row`);
      }
      parsed.push({ row, line: i + 1 });
    }
    if (parsed.length === 0) {
      throw fail(`input file ${JSON.stringify(input)} contains no JSON rows (empty or truncated read)`);
    }
    return {
      parsed,
      descriptor: {
        kind: "file",
        path: input,
        bytes: Buffer.byteLength(text, "utf8"),
        lines: rawLines.length,
        sha256: fingerprint,
      },
    };
  }
  if (Array.isArray(input)) {
    if (input.length === 0) {
      throw fail("input rows array is empty; refusing an empty (incomplete) read with nothing to project");
    }
    for (let i = 0; i < input.length; i += 1) {
      if (!isPlainObject(input[i])) {
        throw fail(`input rows array entry at index ${i} is not a JSON object row`);
      }
    }
    // Single-pass content fingerprint over exactly the rows provided.
    const fingerprint = hashText(JSON.stringify(input));
    return {
      parsed: input.map((row, i) => ({ row, line: i + 1 })),
      descriptor: { kind: "parsed-rows", rows: input.length, sha256: fingerprint },
    };
  }
  throw fail("input must be a caller-owned file path string or an array of parsed JSON row objects");
}

// ---------------------------------------------------------------------------
// Per-origin row interpretation (extracts ONLY documented public fields)
// ---------------------------------------------------------------------------

function setPublic(publicOut, field, value) {
  if (value !== undefined && value !== null) publicOut[field] = value;
}

/**
 * Interpret ONE raw row for `origin`. Returns
 * { rowType, public, calls: string[], resultCallId: string|null }.
 * Throws (fail closed) on any unsupported or malformed shape; never returns
 * a partial row. Public output values may embed private sentinels — that is
 * expected and is handled later by sanitizeProjection (they never enter an
 * emitted record unsanitized).
 */
function interpretRow(origin, row, pos, session) {
  if (origin === "pi") return interpretPiRow(row, pos);
  if (origin === "dsh") return interpretDshRow(row, pos, session);
  return interpretHermesRow(row, pos, session);
}

function interpretPiRow(row, pos) {
  // Supported shape: pi native session rows {"type":"message","timestamp",
  // "message":{role, content:[ONE item]}} with one content item of type
  // toolCall (role assistant), toolResult (role tool) or text (roles
  // assistant/user). Multi-item content rows are an unsupported shape and
  // fail closed (documented bound; split such rows before import).
  const rowType = row.type;
  if (rowType !== "message") {
    throw fail(`unsupported pi row at position ${pos}: row type ${JSON.stringify(rowType)} is not the supported "message" shape`);
  }
  const timestamp = row.timestamp;
  if (typeof timestamp !== "string" || timestamp.length === 0) {
    throw fail(`unsupported pi row at position ${pos}: missing message timestamp`);
  }
  const msg = row.message;
  if (!isPlainObject(msg)) {
    throw fail(`unsupported pi row at position ${pos}: message must be an object`);
  }
  const role = msg.role;
  const content = msg.content;
  if (!Array.isArray(content) || content.length !== 1) {
    throw fail(
      `unsupported pi row at position ${pos}: message.content must be a single-item array (multi-item and empty content are unsupported shapes)`,
    );
  }
  const item = content[0];
  if (!isPlainObject(item)) {
    throw fail(`unsupported pi row at position ${pos}: message.content[0] must be an object`);
  }

  const publicOut = {};
  setPublic(publicOut, "timestamp", timestamp);
  let kind = null;
  const calls = [];
  let resultCallId = null;

  switch (item.type) {
    case "toolCall": {
      if (role !== "assistant") {
        throw fail(`unsupported pi row at position ${pos}: toolCall content requires role assistant, got ${JSON.stringify(role)}`);
      }
      kind = "tool_call";
      if (typeof item.id !== "string" || item.id.length === 0) {
        throw fail(`unsupported pi row at position ${pos}: toolCall is missing its call id`);
      }
      calls.push(item.id);
      setPublic(publicOut, "call_id", item.id);
      if (typeof item.name === "string" && item.name.length > 0) {
        setPublic(publicOut, "tool_name", item.name);
      }
      const args = item.arguments;
      if (isPlainObject(args) && hasOwn(args, "command")) {
        if (typeof args.command !== "string") {
          throw fail(`unsupported pi row at position ${pos}: toolCall command must be a string when present`);
        }
        // Raw command text is NEVER projected — only its sha256 digest.
        setPublic(publicOut, "command_sha256", hashText(args.command));
      }
      break;
    }
    case "toolResult": {
      if (role !== "tool") {
        throw fail(`unsupported pi row at position ${pos}: toolResult content requires role tool, got ${JSON.stringify(role)}`);
      }
      kind = "tool_result";
      if (typeof item.toolCallId !== "string" || item.toolCallId.length === 0) {
        throw fail(`unsupported pi row at position ${pos}: toolResult is missing its toolCallId`);
      }
      resultCallId = item.toolCallId;
      setPublic(publicOut, "call_id", item.toolCallId);
      if (hasOwn(item, "exitCode")) {
        if (typeof item.exitCode !== "number" || !Number.isFinite(item.exitCode)) {
          throw fail(`unsupported pi row at position ${pos}: toolResult exitCode must be a finite number when present`);
        }
        setPublic(publicOut, "exit_code", item.exitCode);
      }
      const resultContent = item.content;
      if (resultContent !== undefined) {
        if (!Array.isArray(resultContent)) {
          throw fail(`unsupported pi row at position ${pos}: toolResult content must be an array when present`);
        }
        const texts = [];
        for (const part of resultContent) {
          if (!isPlainObject(part)) {
            throw fail(`unsupported pi row at position ${pos}: toolResult content items must be objects`);
          }
          if (part.type !== "text") {
            throw fail(`unsupported pi row at position ${pos}: toolResult content item type ${JSON.stringify(part.type)} is not projected (only text parts are public output)`);
          }
          if (typeof part.text !== "string") {
            throw fail(`unsupported pi row at position ${pos}: toolResult text part is missing its text string`);
          }
          texts.push(part.text);
        }
        if (texts.length > 0) setPublic(publicOut, "output", texts.join("\n"));
      }
      break;
    }
    case "text": {
      if (role === "assistant") {
        kind = "text_message";
        if (typeof item.text !== "string") {
          throw fail(`unsupported pi row at position ${pos}: assistant text message is missing its text string`);
        }
        if (item.text.length > 0) setPublic(publicOut, "output", item.text);
      } else if (role === "user") {
        kind = "user_message";
        // Operator/user prompt text is NEVER projected (full credential-
        // bearing prompts must not be emitted). The row is retained as a
        // timestamped marker so row accounting stays complete and honest.
      } else {
        throw fail(`unsupported pi row at position ${pos}: text content under role ${JSON.stringify(role)} is not a supported shape`);
      }
      break;
    }
    default:
      throw fail(
        `unsupported pi row at position ${pos}: content item type ${JSON.stringify(item.type)} is not projected (reasoning/auth-bearing content items are never selected)`,
      );
  }

  return { rowType: kind, public: publicOut, calls, resultCallId };
}

function interpretDshRow(row, pos, session) {
  // Supported shape: post-decompression dsh session.jsonl.zstd events
  // {"type":<DSH_EVENT_TYPES>,"time":ISO,"seq":n,"data":{...}}.
  const eventType = row.type;
  if (!DSH_EVENT_TYPES.includes(eventType)) {
    throw fail(
      `unsupported dsh row at position ${pos}: event type ${JSON.stringify(eventType)} is not in the supported set (${DSH_EVENT_TYPES.join("|")})`,
    );
  }
  const time = row.time;
  if (typeof time !== "string" || time.length === 0) {
    throw fail(`unsupported dsh row at position ${pos}: missing event time`);
  }
  const data = row.data;
  if (data !== undefined && !isPlainObject(data)) {
    throw fail(`unsupported dsh row at position ${pos}: data must be an object when present`);
  }
  // Ambiguous attribution: a row that declares a session identity MUST match
  // the explicit session argument.
  if (data !== undefined && data.sessionId !== undefined) {
    if (typeof data.sessionId !== "string" || data.sessionId.length === 0) {
      throw fail(`unsupported dsh row at position ${pos}: declared data.sessionId must be a non-empty string`);
    }
    if (data.sessionId !== session) {
      throw fail(
        `ambiguous attribution at position ${pos}: dsh event declares sessionId ${JSON.stringify(data.sessionId)} which does not match the explicit session argument ${JSON.stringify(session)}`,
      );
    }
  }

  const publicOut = {};
  setPublic(publicOut, "timestamp", time);

  if (eventType === "assistant/chunk") {
    if (!isPlainObject(data) || !isPlainObject(data.chunk)) {
      throw fail(`unsupported dsh row at position ${pos}: assistant/chunk is missing data.chunk`);
    }
    if (data.chunk.type !== "text") {
      throw fail(
        `unsupported dsh row at position ${pos}: assistant/chunk type ${JSON.stringify(data.chunk.type)} is not projected (reasoning/auth chunk content is never selected)`,
      );
    }
    if (typeof data.chunk.text !== "string") {
      throw fail(`unsupported dsh row at position ${pos}: assistant/chunk text is missing`);
    }
    setPublic(publicOut, "output", data.chunk.text);
  } else if (eventType === "turn/end") {
    const code = data && data.reason && data.reason.error ? data.reason.error.code : undefined;
    if (code !== undefined) {
      if (typeof code !== "string" || code.length === 0) {
        throw fail(`unsupported dsh row at position ${pos}: turn/end error code must be a non-empty string when present`);
      }
      setPublic(publicOut, "terminal_code", code);
    }
  }
  // All other supported event types (session, request/header, request/
  // context, user/message, ...) project ONLY {timestamp}: their payload may
  // carry prompts/context and is deliberately never selected.

  return { rowType: eventType, public: publicOut, calls: [], resultCallId: null };
}

function interpretHermesRow(row, pos, session) {
  // Supported shape: a native Hermes messages-table PUBLIC row projection
  // {row_id, session_id, role, content, tool_call_id, tool_calls, tool_name,
  // timestamp}. session-file content is not required (readonly DB snapshot
  // semantics — see the header).
  if (typeof row.session_id !== "string" || row.session_id.length === 0) {
    throw fail(`unsupported hermes row at position ${pos}: missing session_id`);
  }
  if (row.session_id !== session) {
    throw fail(
      `ambiguous attribution at position ${pos}: hermes row declares session_id ${JSON.stringify(row.session_id)} which does not match the explicit session argument ${JSON.stringify(session)}`,
    );
  }
  const rowId = row.row_id;
  if (!Number.isInteger(rowId) || rowId < 0) {
    throw fail(`unsupported hermes row at position ${pos}: row_id must be a non-negative integer`);
  }
  const role = row.role;
  if (!HERMES_ROLES.includes(role)) {
    throw fail(`unsupported hermes row at position ${pos}: role ${JSON.stringify(role)} is not supported (${HERMES_ROLES.join("|")})`);
  }
  if (typeof row.content !== "string" && row.content !== null && row.content !== undefined) {
    throw fail(`unsupported hermes row at position ${pos}: content must be a string, null or absent`);
  }

  const publicOut = {};
  setPublic(publicOut, "row_id", rowId);
  setPublic(publicOut, "role", role);

  const rawTs = row.timestamp;
  if (typeof rawTs === "number" && Number.isFinite(rawTs)) {
    const iso = new Date(rawTs * 1000).toISOString();
    if (Number.isNaN(Date.parse(iso))) {
      throw fail(`unsupported hermes row at position ${pos}: timestamp ${rawTs} does not map to a valid date`);
    }
    setPublic(publicOut, "timestamp", iso);
  } else if (typeof rawTs === "string" && rawTs.length > 0) {
    setPublic(publicOut, "timestamp", rawTs);
  } else {
    throw fail(`unsupported hermes row at position ${pos}: missing timestamp (unix seconds number or ISO string)`);
  }

  const calls = [];
  let resultCallId = null;
  let rowType = `${role}_message`;

  if (role === "tool") {
    if (typeof row.tool_call_id !== "string" || row.tool_call_id.length === 0) {
      throw fail(`unsupported hermes row at position ${pos}: tool row is missing tool_call_id`);
    }
    resultCallId = row.tool_call_id;
    setPublic(publicOut, "tool_call_id", row.tool_call_id);
    if (typeof row.tool_name === "string" && row.tool_name.length > 0) {
      setPublic(publicOut, "tool_name", row.tool_name);
    }
    if (typeof row.content === "string" && row.content.length > 0) {
      setPublic(publicOut, "output", row.content);
    }
  } else if (role === "assistant") {
    if (row.tool_calls !== undefined && row.tool_calls !== null) {
      if (typeof row.tool_calls !== "string") {
        throw fail(`unsupported hermes row at position ${pos}: tool_calls must be a JSON string when present`);
      }
      let parsedCalls;
      try {
        parsedCalls = JSON.parse(row.tool_calls);
      } catch {
        throw fail(`unsupported hermes row at position ${pos}: tool_calls is not valid JSON`);
      }
      if (!Array.isArray(parsedCalls)) {
        throw fail(`unsupported hermes row at position ${pos}: tool_calls JSON must be an array`);
      }
      let firstToolName = null;
      for (const tc of parsedCalls) {
        if (!isPlainObject(tc)) {
          throw fail(`unsupported hermes row at position ${pos}: tool_calls entries must be objects`);
        }
        if (typeof tc.id !== "string" || tc.id.length === 0) {
          throw fail(`unsupported hermes row at position ${pos}: tool_calls entry is missing its id`);
        }
        calls.push(tc.id);
        const fn = tc.function;
        if (isPlainObject(fn)) {
          if (typeof fn.name === "string" && fn.name.length > 0 && firstToolName === null) {
            firstToolName = fn.name;
          }
          if (fn.arguments !== undefined && fn.arguments !== null) {
            let argObj = null;
            if (typeof fn.arguments === "string") {
              try {
                argObj = JSON.parse(fn.arguments);
              } catch {
                throw fail(`unsupported hermes row at position ${pos}: tool_calls function.arguments is not valid JSON`);
              }
            } else if (isPlainObject(fn.arguments)) {
              argObj = fn.arguments;
            } else {
              throw fail(`unsupported hermes row at position ${pos}: tool_calls function.arguments must be a JSON string or object`);
            }
            if (hasOwn(argObj, "command")) {
              if (typeof argObj.command !== "string") {
                throw fail(`unsupported hermes row at position ${pos}: tool command must be a string when present`);
              }
              if (publicOut.command_sha256 === undefined) {
                setPublic(publicOut, "command_sha256", hashText(argObj.command));
              }
            }
          }
        }
      }
      if (firstToolName !== null) setPublic(publicOut, "tool_name", firstToolName);
    }
    if (typeof row.content === "string" && row.content.length > 0) {
      setPublic(publicOut, "output", row.content);
    }
  }
  // role "user": prompt content is NEVER projected; the row is retained as a
  // {row_id, role, timestamp} marker (prompts must not be emitted).

  return { rowType, public: publicOut, calls, resultCallId };
}

// ---------------------------------------------------------------------------
// parsePublicProjection
// ---------------------------------------------------------------------------

/**
 * Parse one explicit input into an ordered public-field projection.
 *
 * Returns:
 * {
 *   projectionFormat: "core-recording-public-projection/1",
 *   origin, session,
 *   input: {kind, ...descriptor, sha256},       // public input descriptor
 *   publicFieldOrder: [...],                    // explicit ordered fields
 *   rows: [{seq, rowType, public: {...}, link}],// one entry per input row
 *   linkage: {resultRows, callRows, resolvedResults, resolvedCalls,
 *             unresolvedResults, unresolvedCalls},
 *   snapshot: <honest single-read note>,
 * }
 *
 * Throws (fail closed, never partial) on unknown origin, missing input or
 * session, an unreadable/empty/truncated/malformed input, an unsupported row
 * shape, a publicFieldOrder that is empty/duplicated/denied/not extractable,
 * or ambiguous row-declared attribution.
 */
export function parsePublicProjection({ origin, input, session, publicFieldOrder } = {}) {
  assertOrigin(origin);
  assertSession(session);
  assertInputProvided(input);
  assertPublicFieldOrder(publicFieldOrder, origin);

  const { parsed, descriptor } = readInputRows(input);

  // Pass 1: interpret every row (fail closed on the first unsupported shape).
  const entries = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const pos = i + 1;
    const interpreted = interpretRow(origin, parsed[i].row, pos, session);
    const publicOut = {};
    // Build row.public by iterating the EXPLICIT publicFieldOrder so the
    // retained key order mirrors the caller's declared order.
    for (const field of publicFieldOrder) {
      if (hasOwn(interpreted.public, field)) publicOut[field] = interpreted.public[field];
    }
    entries.push({
      seq: pos,
      line: parsed[i].line,
      rowType: interpreted.rowType,
      public: publicOut,
      calls: interpreted.calls,
      resultCallId: interpreted.resultCallId,
      link: null,
    });
  }

  // Pass 2: retain call/result linkage visible INSIDE this one input.
  // Call ids must be unambiguous within the input; duplicates are ambiguous
  // attribution and fail closed.
  const callOwner = new Map(); // callId -> seq of the row that declares it
  const resultSeqByCall = new Map(); // callId -> seq of its result row
  for (const entry of entries) {
    for (const callId of entry.calls) {
      if (callOwner.has(callId)) {
        throw fail(
          `ambiguous attribution: call id ${JSON.stringify(callId)} is declared by both position ${callOwner.get(callId)} and position ${entry.seq}`,
        );
      }
      callOwner.set(callId, entry.seq);
    }
    if (entry.resultCallId !== null) {
      if (resultSeqByCall.has(entry.resultCallId)) {
        throw fail(
          `ambiguous attribution: call id ${JSON.stringify(entry.resultCallId)} has result rows at both position ${resultSeqByCall.get(entry.resultCallId)} and position ${entry.seq}`,
        );
      }
      resultSeqByCall.set(entry.resultCallId, entry.seq);
    }
  }

  const unresolvedResults = [];
  const unresolvedCalls = [];
  for (const entry of entries) {
    if (entry.calls.length > 0) {
      const firstCallId = entry.calls[0];
      const resultSeq = resultSeqByCall.get(firstCallId) ?? null;
      entry.link = {
        kind: "call",
        callId: firstCallId,
        callCount: entry.calls.length,
        resultSeq,
      };
      if (resultSeq === null) {
        unresolvedCalls.push({ seq: entry.seq, callId: firstCallId });
      }
    } else if (entry.resultCallId !== null) {
      const callSeq = callOwner.get(entry.resultCallId) ?? null;
      entry.link = { kind: "result", callId: entry.resultCallId, callSeq };
      if (callSeq === null) {
        unresolvedResults.push({ seq: entry.seq, callId: entry.resultCallId });
      }
    }
  }

  const rows = entries.map((entry) => ({
    seq: entry.seq,
    rowType: entry.rowType,
    public: entry.public,
    link: entry.link,
  }));

  const linkage = {
    resultRows: entries.filter((e) => e.resultCallId !== null).length,
    callRows: entries.filter((e) => e.calls.length > 0).length,
    resolvedResults: entries.filter((e) => e.resultCallId !== null && callOwner.has(e.resultCallId)).length,
    resolvedCalls: entries.filter((e) => e.calls.length > 0 && resultSeqByCall.has(e.calls[0])).length,
    unresolvedResults,
    unresolvedCalls,
  };

  return {
    projectionFormat: PROJECTION_FORMAT,
    origin,
    session,
    input: descriptor,
    publicFieldOrder: [...publicFieldOrder],
    rows,
    linkage,
    snapshot:
      "single-read ordered public-field projection: derived in one pass over one explicit input as read; it is a snapshot of that single read, never an immutable hash of a concurrently changing whole database or stream",
  };
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

// Conservative credential-value extent scanner, used by the two quoted-form
// credential detectors (authorization-header / auth-assignment). A plain
// regex cannot tell an escaped inner quote from a closing delimiter, and
// cannot decide how far an unclosed quote should be redacted, without
// becoming a fragile layered alternation. This bounded scanner implements
// the module's finite contract:
//
//   * A value that STARTS with a quote ("", '', `) is consumed as a quoted
//     unit. A backslash-quote (escaped quote) INSIDE that unit is NOT a
//     closing delimiter — it is part of the value. The unit ends only at an
//     UNESCAPED matching quote.
//   * A quote that never closes (end of string before a matching quote) is
//     conservatively bounded at the end of the line: the whole open value is
//     redacted, never leaked and never left partially visible.
//   * A value that does NOT start with a quote (bare value) runs to the next
//     unambiguous delimiter (comma, semicolon, bracket, brace, paren,
//     newline) or end of the line; quotes it contains are value characters.
//   * A value that starts with a delimiter/whitespace has no identifiable
//     value to redact (e.g. "password=" with no value) and is left as-is.
//
// Returns the exclusive end index of the value, or null when there is no
// value to redact. This is deliberately conservative and finite: it is NOT a
// promise to detect arbitrary secrets inside a value — it only ever redacts
// the value extent of a RECOGNIZED credential assignment/header.
function findCredentialValueEnd(text, start) {
  const first = text[start];
  if (first === '"' || first === "'" || first === "`") {
    const quote = first;
    let i = start + 1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === "\\") {
        i += 2; // skip the escaped character (backslash + following char)
        continue;
      }
      if (ch === quote) {
        return i + 1; // unescaped closing quote; the value ends after it
      }
      if (ch === "\n" || ch === "\r") {
        return i; // unterminated quote: conservative line bound
      }
      i += 1;
    }
    return text.length; // unterminated quote to end of string
  }
  if (first === undefined || /[ \t,;"'`\[\]{}()\r\n]/.test(first)) {
    return null; // no value to redact (delimiter/whitespace/value absent)
  }
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (
      ch === "," ||
      ch === ";" ||
      ch === "[" ||
      ch === "]" ||
      ch === "{" ||
      ch === "}" ||
      ch === "(" ||
      ch === ")" ||
      ch === "\n" ||
      ch === "\r"
    ) {
      break;
    }
    i += 1;
  }
  return i;
}

// Apply one credential-value detector (authorization-header / auth-assignment)
// to `text`: find every recognized prefix (key + separator), compute its value
// extent with the conservative scanner, and replace [prefixStart, valueEnd)
// with the kept prefix + the redaction marker. Returns {out, count} where
// `count` is the number of redactions applied (for redaction-evidence
// bookkeeping).
function scanCredentialValues(text, prefixRe, marker) {
  const re = new RegExp(prefixRe.source, prefixRe.flags);
  re.lastIndex = 0;
  let out = "";
  let lastEnd = 0;
  let count = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const prefixStart = m.index;
    const prefixEnd = m.index + m[0].length;
    if (prefixStart < lastEnd) continue; // prefix inside an already-redacted value
    const valueEnd = findCredentialValueEnd(text, prefixEnd);
    if (valueEnd === null) continue; // no value to redact — keep the prefix as-is
    out += text.slice(lastEnd, prefixStart);
    out += text.slice(prefixStart, prefixEnd); // keep key/separator prefix
    out += marker;
    lastEnd = valueEnd;
    count += 1;
  }
  out += text.slice(lastEnd);
  return { out, count };
}

function scanText(text, sentinels, hits) {
  let out = text;
  // 1) Caller-declared literal sentinels (deterministic, exact substring).
  for (const sentinel of sentinels) {
    if (!out.includes(sentinel)) continue;
    const marker = redactMarker("declared-sentinel");
    out = out.split(sentinel).join(marker);
    hits.push({ reason: "declared-sentinel", replacedWith: marker });
  }
  // 2) Built-in generic credential-shape detectors.
  for (const pattern of BUILTIN_PATTERNS) {
    const marker = redactMarker(pattern.reason);
    if (pattern.re) {
      const re = new RegExp(pattern.re.source, pattern.re.flags);
      re.lastIndex = 0;
      out = out.replace(re, (...args) => {
        hits.push({ reason: pattern.reason, replacedWith: marker });
        // args[0] is the full match; the first `prefixGroups` capture groups
        // (args[1..prefixGroups]) are the verbatim prefix to keep.
        const kept = args.slice(1, 1 + pattern.prefixGroups).join("");
        return kept + marker;
      });
    } else if (pattern.scanner === "credential-value") {
      const applied = scanCredentialValues(out, pattern.prefixRe, marker);
      out = applied.out;
      for (let i = 0; i < applied.count; i += 1) {
        hits.push({ reason: pattern.reason, replacedWith: marker });
      }
    }
  }
  return out;
}

function sanitizeValueDeep(value, path, sentinels, redactions, seen) {
  if (typeof value === "string") {
    const hits = [];
    const out = scanText(value, sentinels, hits);
    for (const hit of hits) {
      const dedupeKey = `${path}\u0000${hit.reason}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        redactions.push({ fieldPath: path, reason: hit.reason, replacedWith: hit.replacedWith });
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => sanitizeValueDeep(v, `${path}[${i}]`, sentinels, redactions, seen));
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = sanitizeValueDeep(value[key], `${path}.${key}`, sentinels, redactions, seen);
    }
    return out;
  }
  return value; // numbers / booleans / null pass through untouched
}

/**
 * Sanitize a projection's captured public values.
 *
 * Returns { sanitized, redactions } where `sanitized` is a deep clone of the
 * projection whose rows[].public string leaves have every sentinel replaced
 * with a "[REDACTED:<reason>]" marker, and `redactions` is the evidence list
 * [{fieldPath, reason, replacedWith}] (one entry per field+reason; fieldPath
 * is e.g. "rows[3].public.output"). Every emitted record must be built from
 * the sanitized projection so no sentinel ever reaches a shipped record.
 */
export function sanitizeProjection(projection, options = {}) {
  if (!isPlainObject(projection)) {
    throw fail("sanitizeProjection expects a projection object from parsePublicProjection");
  }
  const sentinels = assertSentinels(options === null || options === undefined ? undefined : options.sentinels);
  const redactions = [];
  const seen = new Set();
  const sanitized = {
    ...projection,
    rows: projection.rows.map((row, i) => {
      const rowClone = { ...row };
      if (rowClone.public !== undefined && rowClone.public !== null) {
        rowClone.public = sanitizeValueDeep(
          rowClone.public,
          `rows[${i}].public`,
          sentinels,
          redactions,
          seen,
        );
      }
      return rowClone;
    }),
  };
  return { sanitized, redactions };
}

// ---------------------------------------------------------------------------
// hashPublicProjection
// ---------------------------------------------------------------------------

function validateProjectionObject(projection) {
  if (!isPlainObject(projection)) {
    throw fail("hashPublicProjection expects a projection object from parsePublicProjection");
  }
  assertOrigin(projection.origin);
  assertSession(projection.session);
  if (!Array.isArray(projection.publicFieldOrder) || projection.publicFieldOrder.length === 0) {
    throw fail("projection.publicFieldOrder must be a non-empty array of public field names");
  }
  if (!Array.isArray(projection.rows)) {
    throw fail("projection.rows must be an array of projection rows");
  }
}

/**
 * sha256 hex over the EXPLICITLY ORDERED public-field projection.
 *
 * Deterministic canonical text: origin, session, the declared public-field
 * order, then one line per projection row in input order carrying the row
 * position, its row type and — for every declared public field IN ORDER — the
 * JSON value or an explicit <absent> marker. Identical projections hash
 * identically; changing ANY ordered public field (value, presence or order)
 * changes the hash. Linkage ids are NOT part of the digest (it is a hash of
 * the public-field projection, not of the linkage bookkeeping).
 */
export function hashPublicProjection(projection) {
  validateProjectionObject(projection);
  const lines = [];
  lines.push(`core-recording-public-projection\t1`);
  lines.push(`origin\t${projection.origin}`);
  lines.push(`session\t${projection.session}`);
  lines.push(`fields\t${projection.publicFieldOrder.map((f) => JSON.stringify(f)).join(",")}`);
  for (const row of projection.rows) {
    if (!isPlainObject(row) || !Number.isInteger(row.seq) || row.seq < 1) {
      throw fail(`projection rows need a positive integer seq, got ${JSON.stringify(row && row.seq)}`);
    }
    if (typeof row.rowType !== "string" || row.rowType.length === 0) {
      throw fail(`projection row ${row.seq} needs a non-empty rowType`);
    }
    if (!isPlainObject(row.public)) {
      throw fail(`projection row ${row.seq} needs a public object`);
    }
    const cells = [`${row.seq}`, row.rowType];
    for (const field of projection.publicFieldOrder) {
      if (hasOwn(row.public, field)) {
        const value = row.public[field];
        cells.push(value === undefined ? "<absent>" : JSON.stringify(value));
      } else {
        cells.push("<absent>");
      }
    }
    lines.push(cells.join("\t"));
  }
  return hashText(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// captureRecording
// ---------------------------------------------------------------------------

const PROVENANCES = Object.freeze(["captured", "synthetic"]);

/**
 * Capture and sanitize one explicit input into a US-001 versioned record.
 *
 * Options (all explicit):
 *   origin           pi | dsh | hermes
 *   input            caller-owned synthetic file path OR parsed rows array
 *   session          explicit non-empty session/run identity string
 *   publicFieldOrder explicit ordered extractable public fields
 *   runId            the record's single run identity (non-empty string)
 *   caseId?          optional case identity for sourceIdentity
 *   provenance       REQUIRED explicit choice: "captured" (the caller
 *                    ASSERTS the rows are captured public output; the record
 *                    records that assertion, it cannot verify a real origin
 *                    and does not label the record as a simulation) |
 *                    "synthetic" (rows are a declared synthetic adaptation
 *                    standing in for unretained data). Omitted/invalid
 *                    provenance is refused — the importer never infers
 *                    {"captured"} for you.
 *   sentinels?       literal private sentinels to scrub (in addition to the
 *                    built-in generic credential shapes)
 *   unknown?         [{fact, reason}] explicit unknown facts (reason in the
 *                    US-001 closed set); auto linkage unknowns are appended
 *   reports?         [{callId, note}] accepted-report public summaries
 *   extraSourceRefs? additional sourceRef locator objects (contract shape)
 *
 * Returns a deep-frozen US-001 recording record (see
 * core-recording-contract.mjs) that DISTINCTLY labels every embedded datum:
 *   observations[].classification: "captured" | "sanitized" | "synthetic"
 *     (one observation per projection row: sanitized rows whose content had a
 *     sentinel removed are "sanitized"; untouched captured rows are
 *     "captured"; under provenance "synthetic" every row is "synthetic"),
 *   unknown[] entries: explicit unknown data (reason-labeled; surfaced as
 *     classification "unknown" by validateRecordingRecord),
 * and embeds source identity (kind/runId/caseId/sourceRefs/sourceSha256
 * including the ordered-projection hash and the sanitized-derivative hash as
 * locator digests), redaction evidence (transformations), retained call/
 * result linkage (observation facts) and accepted reports (observations).
 *
 * The emitted record NEVER contains a sentinel value: observation facts are
 * built exclusively from the SANITIZED projection and sanitized report
 * notes. Throws (fail closed — never a partial or unlabeled record) on any
 * argument, parse, sanitization or internal-validation failure.
 */
export function captureRecording({
  origin,
  input,
  session,
  publicFieldOrder,
  runId,
  caseId,
  provenance,
  sentinels,
  unknown,
  reports,
  extraSourceRefs,
} = {}) {
  assertOrigin(origin);
  assertSession(session);
  assertInputProvided(input);
  assertRunId(runId);
  assertPublicFieldOrder(publicFieldOrder, origin);
  if (caseId !== undefined && (typeof caseId !== "string" || caseId.length === 0)) {
    throw fail("caseId must be a non-empty string when present");
  }
  assertProvenance(provenance);
  const sentinelList = assertSentinels(sentinels);
  const unknownEntries = assertUnknownEntries(unknown);
  const reportEntries = assertReports(reports);

  // -- capture ------------------------------------------------------------
  const projection = parsePublicProjection({ origin, input, session, publicFieldOrder });
  const rowCount = projection.rows.length;
  const { sanitized, redactions } = sanitizeProjection(projection, { sentinels: sentinelList });
  const projectionSha256 = hashPublicProjection(projection);
  const sanitizedSha256 = hashPublicProjection(sanitized);

  // -- sanitize accepted-report notes --------------------------------------
  const reportRedactions = [];
  const seenReportReasons = new Set();
  const sanitizedReports = reportEntries.map((report, k) => {
    const hits = [];
    const note = scanText(report.note, sentinelList, hits);
    for (const hit of hits) {
      const path = `reports[${k}].note`;
      const dedupeKey = `${path}\u0000${hit.reason}`;
      if (!seenReportReasons.has(dedupeKey)) {
        seenReportReasons.add(dedupeKey);
        reportRedactions.push({ fieldPath: path, reason: hit.reason, replacedWith: hit.replacedWith });
      }
    }
    return { callId: report.callId, note };
  });

  // -- observations: one per sanitized projection row -----------------------
  const observations = [];
  const touchedRows = new Set();
  for (const redaction of redactions) {
    const match = /^rows\[(\d+)\]\./.exec(redaction.fieldPath);
    if (match) touchedRows.add(Number(match[1]));
  }
  sanitized.rows.forEach((row, idx) => {
    let classification;
    if (provenance === "synthetic") {
      classification = "synthetic";
    } else {
      classification = touchedRows.has(idx) ? "sanitized" : "captured";
    }
    observations.push({
      id: `obs-${String(row.seq).padStart(4, "0")}`,
      classification,
      fact: {
        rowType: row.rowType,
        position: row.seq,
        public: row.public,
        link: row.link ?? null,
      },
      sourceRef: "projection",
    });
  });

  // -- accepted reports as observations --------------------------------------
  sanitizedReports.forEach((report, k) => {
    const changed = report.note !== reportEntries[k].note;
    let classification;
    if (provenance === "synthetic") {
      classification = "synthetic";
    } else {
      classification = changed ? "sanitized" : "captured";
    }
    observations.push({
      id: `report-${k + 1}`,
      classification,
      fact: { kind: "accepted-report", callId: report.callId, note: report.note },
      sourceRef: "input",
    });
  });

  // -- explicit unknown data (caller-declared + auto unresolved linkage) -----
  const autoUnknown = [];
  for (const gap of projection.linkage.unresolvedResults) {
    autoUnknown.push({
      fact: `tool result at position ${gap.seq} (call id ${JSON.stringify(gap.callId)}) has no matching call row inside this input; the call row may live in an adjacent session file of the same run`,
      reason: "missing",
    });
  }
  for (const gap of projection.linkage.unresolvedCalls) {
    autoUnknown.push({
      fact: `call ${JSON.stringify(gap.callId)} at position ${gap.seq} has no result row inside this input; the result may live in an adjacent session file of the same run`,
      reason: "missing",
    });
  }
  const unknownFinal = [...unknownEntries, ...autoUnknown];

  // -- transformations -------------------------------------------------------
  const transformations = [
    {
      step: "read.single_pass_ordered_projection",
      note: `single-read snapshot: projected ${rowCount} ${origin} rows over ${publicFieldOrder.length} explicitly ordered public fields from one explicit input`,
      sourceRef: "input",
    },
  ];
  for (const redaction of redactions) {
    transformations.push({
      step: "sanitize.redact",
      fieldPath: redaction.fieldPath,
      reason: redaction.reason,
      replacedWith: redaction.replacedWith,
      sourceRef: "projection",
    });
  }
  for (const redaction of reportRedactions) {
    transformations.push({
      step: "sanitize.redact",
      fieldPath: redaction.fieldPath,
      reason: redaction.reason,
      replacedWith: redaction.replacedWith,
      sourceRef: "input",
    });
  }
  transformations.push({
    step: "hash.ordered_public_projection",
    note: "sha256 over the explicitly ordered public-field projection (single-read snapshot semantics)",
    sourceRef: "projection",
  });
  if (provenance === "synthetic") {
    transformations.push({
      step: "adapt.declare_synthetic",
      note: "entire input declared a synthetic adaptation standing in for unretained data; no row claims real captured provenance",
      sourceRef: "input",
    });
  }

  // -- source identity -------------------------------------------------------
  const builtInLocatorIds = new Set(["input", "projection", "sanitized-projection"]);
  const extraRefs = [];
  if (extraSourceRefs !== undefined) {
    if (!Array.isArray(extraSourceRefs)) {
      throw fail("extraSourceRefs must be an array of sourceRef locator objects");
    }
    extraRefs.push(
      ...extraSourceRefs.map((ref, i) => {
        if (!isPlainObject(ref) || typeof ref.locatorId !== "string" || ref.locatorId.length === 0) {
          throw fail(`extraSourceRefs[${i}] needs a non-empty locatorId`);
        }
        if (builtInLocatorIds.has(ref.locatorId)) {
          throw fail(`extraSourceRefs[${i}] locatorId ${JSON.stringify(ref.locatorId)} collides with a built-in locator`);
        }
        if (ref.locator === undefined || ref.locator === null || ref.locator === "") {
          throw fail(`extraSourceRefs[${i}] (${ref.locatorId}) needs an explicit locator`);
        }
        return ref;
      }),
    );
  }

  const sourceRefs = [
    {
      locatorId: "input",
      runId,
      locator: {
        kind: "import-input",
        session,
        source: projection.input.kind === "file" ? projection.input.path : "caller-provided parsed rows",
        rows: rowCount,
      },
      sha256: projection.input.sha256,
    },
    {
      locatorId: "projection",
      runId,
      locator: {
        kind: "ordered-public-projection",
        session,
        fields: publicFieldOrder,
        rows: rowCount,
        singleReadSnapshot: true,
      },
      sha256: projectionSha256,
    },
    {
      locatorId: "sanitized-projection",
      runId,
      locator: {
        kind: "sanitized-derivative",
        session,
        source: "projection",
        redactions: redactions.length + reportRedactions.length,
      },
      sha256: sanitizedSha256,
    },
    ...extraRefs,
  ];

  const sourceIdentity = {
    kind: origin,
    runId,
    sourceRefs,
    sourceSha256: projection.input.sha256,
  };
  if (caseId !== undefined) sourceIdentity.caseId = caseId;

  // -- assemble + self-validate ----------------------------------------------
  const record = buildRecordingRecord({
    sourceIdentity,
    observations,
    transformations,
    operations: [],
    expectedOutcomes: [],
    unknown: unknownFinal,
  });
  const validation = validateRecordingRecord(record);
  if (!validation.ok) {
    throw fail(
      `internal invariant: captureRecording produced an invalid US-001 record: ${JSON.stringify(validation.errors)}`,
    );
  }
  return record;
}
