// S48 (US-006, 2026-09-03) — O8 test-marker extraction, shared across the
// capture side (bin/oracle-evidence-snapshot.mjs testMarkerCounts), the
// fixture generator (oracles/self-test/generate-o8-fixtures.mjs markerCounts)
// and the oracle's own git-tree rebuild leg (oracles/lib/o8.mjs countMarkers,
// buildMovedTargetInventory).
//
// DEFECT (W4.17-a, 'skipped 07-31'): the O8 checksum inventories counted
// skip/todo/xfail markers by applying whole-text word regexes
// (/\bskip(?:ped)?\b/gi, /\btodo\b/gi, /\bxfail\b/gi) over the FULL test
// file bytes. Prose/docstring/comment content therefore inflated the counts —
// a W4.17-a change whose docstring said 'skipped 07-31' (a date, not a
// marker) tripped O8_TEST_MARKER_INTRODUCED on a legitimately additive
// change.
//
// CONTRACT: markers are counted ONLY in test-definition / decorator
// contexts, NEVER in prose/docstrings/comments:
//   1. comments, docstrings and string literals are MASKED first (per
//      language family), so docstring examples of decorator syntax cannot
//      count either;
//   2. on the masked code, only anchored constructs count:
//      (a) decorator/annotation expressions ending in a marker name —
//          @pytest.mark.skip, @pytest.mark.skipif, @pytest.mark.xfail,
//          @unittest.skip[If/Unless] and any @dotted.marker;
//      (b) python runtime skip calls — pytest.skip(...),
//          self.skipTest(...), unittest.skipTest(...), raise unittest.SkipTest;
//      (c) go runtime skips — t.Skip/t.Skipf/t.SkipNow;
//      (d) JS/TS registration chains — test.skip(/skipIf/todo/xfail),
//          it/describe/specify/context/suite/task/bench … (with a call);
//      (e) JS/TS object-option marker keys at the top level of a
//          registration call's argument list (node:test/jest
//          it('x', { skip: true }, fn)).
//   3. the seeded-test leg (O8_SEEDED_TEST_EXTENDED / CHANGED) is untouched —
//      only the marker counts that feed O8_TEST_MARKER_INTRODUCED change.
//
// Buckets: the marker word sets map onto the O8 marker vocabulary — skip,
// todo, xfail — as recorded in inventory test_markers entries:
//   skip|skipif|skipunless|SkipTest            -> skip
//   todo                                      -> todo
//   xfail                                     -> xfail
// Bare words ('skipped', 'skip' as an identifier, 'todo' in a comment) are
// NEVER markers: an anchored construct cannot be spelled 'skipped'.
//
// countTestMarkers(fileName, content) -> { skip, todo, xfail } — non-negative
// safe integers, extension-driven, deterministic, dependency-free so every
// consumer (capture, fixture generator, oracle rebuild) derives IDENTICAL
// counts for the same (path, bytes).
//
// S52 (US-007, 2026-09-03): countFocusMarkers(fileName, content) -> integer.
// FOCUS markers (test.only / it.only / describe.only / fit / fdescribe — the
// suite-focusing modifiers that make a runner execute ONLY the focused
// definition, hiding every other test) are a test-definition-context signal
// exactly like skip/todo/xfail and use the SAME comment/docstring/string
// masking, so prose that merely says 'test.only(...)' never counts. They are
// NOT part of the checksum inventory test_markers object (the three-bucket
// {skip,todo,xfail} shape is unchanged); O8 computes them at evaluation time
// from the authoritative bytes (see o8.mjs), so no capture-side schema moves.
//
// OMCX (US-006 retry, 2026-09-05): for the JS/TS family the counts are
// derived from a token-level scan of the RAW source (see lexJsTokens and the
// js* helpers below), NOT from masked-text regexes. Comments, template and
// regex literals are opaque tokens, so:
//   * a regex literal spelling an anchored marker shape (/test.only(...)/) is
//     never a registration — the old mask+regex path matched inside it;
//   * quoted option keys ({ 'skip': true }) count exactly like identifier
//     keys (string masking used to erase them);
//   * option keys count ONLY as first-level property keys of an object
//     literal that is a DIRECT argument of a plain `id(` registration call —
//     a `skip:`/`only:` LABEL inside an arrow/function body argument
//     (() => { skip: for(;;){} }) is not an options object and never counts.
// The masked-text helpers (countDecoratorMarkers, countRegistrationChains,
// countRegistrationOptionKeys, countRuntimeSkips) remain for every OTHER
// language family unchanged.
//
// OMCX slash contexts (08a9933a review follow-up, 2026-09-05): the lexer
// decides regex-vs-division for every '/' (jsSlashStartsRegex). Two contexts
// refine the plain "previous token ends an expression" rule:
//   * a '/' after a CONTROL-CONDITION header close (`if (...) /re/`,
//     `while (...) /re/`, `for (...) /re/` …) is a REGEX LITERAL: the header
//     paren is not an expression — the construct after it is a statement,
//     which may itself begin with a regex literal. A '/' after an ordinary
//     call/grouping close (`foo() / 2`) stays division.
//   * a '/' after a POSTFIX ++/-- (`n++ / test.only(...)`, `n-- /
//     test.skip(...)`) is DIVISION: the postfix increment/decrement ends the
//     left-hand expression, so the division's right operand (a real
//     registration) is scanned as code. Only the postfix spelling ends an
//     expression — `n + +/re/` (spaced, binary-plus-unary-plus) keeps the
//     regex. The lexer therefore tracks per-paren control-header context and
//     recognises the postfix ++/-- tail via source adjacency + a preceding
//     expression-ending token (jsIsPostfixIncDecTail).
//
// OMCX operand preservation (f9c2b0dd consolidation, 2026-09-05): the '/'
// after an IDENTIFIER opens a regex literal only when that identifier is a
// GENUINE keyword in keyword position (jsIdOpensRegexLiteral):
//   * keywords are case-sensitive and lowercase — `RETURN` is an ordinary
//     identifier, so `RETURN / test.only(...) / 2` divides (the real
//     registration counts); `return /re/` keeps the regex;
//   * a keyword-spelled MEMBER property (`holder.return / 2`, `obj.in / 2`)
//     is an operand, never a keyword — division;
//   * `of` is CONTEXTUAL: only the for-of / for-await-of header SEPARATOR is
//     keyword-like — a '/' right after it starts the iterable expression,
//     which may itself be a regex literal (`for (const item of /re/.exec(s))`
//     — the regex content stays opaque). Every other `of` is an ordinary
//     identifier operand: a declared/used variable (`const of = 8; of /
//     test.skip(…) / 2` — division), the classic-for declaration/binding
//     (`for (let of = 8; of / test.only(…) / 2; of--)` — all three `of`s are
//     operands, the middle one divides), or a member property (`obj.of`).
//     The lexer records each paren's control-header keyword (recognising the
//     `for await (` header as a 'for' header at ANY nesting depth) and
//     annotates every id token with whether a following '/' starts a regex
//     (token.regexAfter); jsOfIsForHeaderSeparator decides the `of` case from
//     the binding end directly before it (see jsIdOpensRegexLiteral).
//   * `of` may ALSO be a loop-variable BINDING whose name is the contextual
//     word itself (fc303847 review, 2026-09-05): in `for (var of of /re/…)`
//     the FIRST `of` is the declared variable (`of` is the only
//     JS_REGEX_AFTER member that may legally be an identifier), the SECOND is
//     the genuine separator — a fresh `of` directly before the separator is a
//     binding end, so the iterable regex stays opaque (focus 0).

const MARKER_FAMILIES = Object.freeze({
  python: new Set(['py', 'pyi', 'pyw']),
  js: new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte']),
  go: new Set(['go']),
  javaKotlin: new Set(['java', 'kt', 'kts']),
  rust: new Set(['rs']),
  cLike: new Set(['c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'swift']),
  script: new Set(['sh', 'bash', 'zsh', 'fish', 'ps1']),
});

const DECORATOR = /@([A-Za-z_][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*)*)/g;
// Registration identifiers whose chained marker / option-object skip declares
// a test-definition-level skip/todo/xfail (jest/vitest/node:test/mocha/japa).
const REGISTRATION_IDS = ['test', 'it', 'describe', 'specify', 'context', 'suite', 'task', 'bench', 'benchmark'];
const REGISTRATION = new RegExp(`(?:^|[^\\w$.])(${REGISTRATION_IDS.join('|')})\\s*\\.\\s*(skip|skipif|todo|xfail)\\s*\\(`, 'gi');
const REGISTRATION_OPEN = new RegExp(`(?:^|[^\\w$.])(${REGISTRATION_IDS.join('|')})\\s*\\(`, 'gi');
const OPTION_KEY = /\b(skip|todo|xfail)\s*:/gi;
const PY_RUNTIME_SKIP = /(?:^|[^\w$.])(?:pytest\.skip|(?:self|unittest)\.skipTest)\s*\(|\bSkipTest\b/gi;
const GO_RUNTIME_SKIP = /\bt\.(?:skip|skipf|skipnow)\s*\(/gi;

// S52 (US-007): FOCUS vocabulary. Anchored constructs only — a chained
// `.only` on a registration id (`test.only(`, `it.only(`, `describe.only(` …)
// with a call, or a bare focus registrar (`fit(`, `fdescribe(` — the
// jasmine/mocha spellings) with a call. Option-object focus keys
// (`it('x', { only: true }, fn)` — node:test) are counted by the same
// bracket-depth rule the skip/todo/xfail option keys use.
const FOCUS_REGISTRATION_IDS = REGISTRATION_IDS;
const FOCUS_CHAIN = new RegExp(`(?:^|[^\\w$.])(${FOCUS_REGISTRATION_IDS.join('|')})\\s*\\.\\s*only\\s*\\(`, 'gi');
const FOCUS_REGISTRAR = /(?:^|[^\w$.])(fit|fdescribe)\s*\(/gi;
const FOCUS_OPTION_KEY = /\bonly\s*:/gi;

function finalSegment(word) {
  const lower = word.toLowerCase();
  if (lower === 'skip' || lower === 'skipif' || lower === 'skipunless' || lower === 'skiptest') return 'skip';
  if (lower === 'todo') return 'todo';
  if (lower === 'xfail') return 'xfail';
  return null;
}

function extensionOf(fileName) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(fileName));
  return match === null ? '' : match[1].toLowerCase();
}

// ── language-family comment/docstring/string masking ─────────────────────
// Every masker preserves '\n' (positions of other chars become ' ').

// A quote-run scanner shared by the C-ish families: single/double quoted
// strings with backslash escapes, '//' and '/* */' comments, optional
// backtick raw/template strings and optional triple-double-quoted strings
// (java text blocks / kotlin raw strings).
function maskCLike(text, { backticks = false, tripleDouble = false, single = true, double = true } = {}) {
  const out = new Array(text.length);
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (ch === '/' && next === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n) {
        if (text[i] === '*' && text[i + 1] === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; break; }
        out[i] = text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (tripleDouble && ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3;
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"') { out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3; break; }
        out[i] = text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if (backticks && ch === '`') {
      out[i] = ' '; i += 1;
      while (i < n) {
        if (text[i] === '\\' && i + 1 < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (text[i] === '`') { out[i] = ' '; i += 1; break; }
        out[i] = text[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      continue;
    }
    if ((double && ch === '"') || (single && ch === "'")) {
      const quote = ch;
      out[i] = ' '; i += 1;
      while (i < n) {
        if (text[i] === '\\' && i + 1 < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; continue; }
        if (text[i] === quote) { out[i] = ' '; i += 1; break; }
        if (text[i] === '\n') { out[i] = '\n'; i += 1; break; } // unterminated single-line string
        out[i] = ' ';
        i += 1;
      }
      continue;
    }
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

// Python: '#' comments, '...'/"""...""" (and '''...''') with backslash
// escapes; unterminated single-line strings close at end-of-line. String
// prefixes (r/b/f/u/br/rb/fr/rf) precede the quote and are left in place —
// they are short identifier letters that cannot spell a marker word.
function maskPython(text) {
  const out = new Array(text.length);
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '#') {
      while (i < n && text[i] !== '\n') { out[i] = ' '; i += 1; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const triple = text[i + 1] === quote && text[i + 2] === quote;
      const run = triple ? 3 : 1;
      for (let k = 0; k < run; k += 1) { out[i + k] = ' '; }
      i += run;
      while (i < n) {
        if (text[i] === '\\') { out[i] = ' '; if (i + 1 < n) { out[i + 1] = ' '; } i += 2; continue; }
        if (triple) {
          if (text[i] === quote && text[i + 1] === quote && text[i + 2] === quote) {
            out[i] = ' '; out[i + 1] = ' '; out[i + 2] = ' '; i += 3; break;
          }
          out[i] = text[i] === '\n' ? '\n' : ' ';
          i += 1;
        } else {
          if (text[i] === quote) { out[i] = ' '; i += 1; break; }
          if (text[i] === '\n') { out[i] = '\n'; i += 1; break; }
          out[i] = ' ';
          i += 1;
        }
      }
      continue;
    }
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

// Rust raw strings r"…" / r#"…"# / br#"…"# are masked in a pre-pass; the
// rest of the file then goes through the C-ish masker.
function maskRust(text) {
  const masked = text.replace(/(?:r|rb|br)(#*)"([\s\S]*?)"\1/g, (whole) => whole.replace(/[^\n]/g, ' '));
  return maskCLike(masked, { single: true, double: true });
}

function mask(family, text) {
  if (family === 'python') return maskPython(text);
  if (family === 'js') return maskCLike(text, { backticks: true });
  if (family === 'go') return maskCLike(text, { backticks: true });
  if (family === 'javaKotlin') return maskCLike(text, { tripleDouble: true });
  if (family === 'rust') return maskRust(text);
  if (family === 'script') return maskPython(text); // '#' comments + quotes
  return maskCLike(text);
}

function familyOf(fileName) {
  const ext = extensionOf(fileName);
  for (const [family, extensions] of Object.entries(MARKER_FAMILIES)) {
    if (extensions.has(ext)) return family;
  }
  return 'cLike';
}

function addBucket(counts, marker) {
  const bucket = finalSegment(marker);
  if (bucket !== null) counts[bucket] += 1;
}

// Decorator/annotation expressions (@dotted.path) whose FINAL segment is a
// marker name — applied to the masked code only, so decorator syntax inside
// a docstring/comment can never count.
function countDecoratorMarkers(text, counts) {
  for (const match of text.matchAll(DECORATOR)) {
    const expr = match[1];
    const segments = expr.split('.').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) continue;
    addBucket(counts, segments[segments.length - 1]);
  }
}

// Registration-chain markers — test.skip(...), it.todo(...), describe.skipIf(...
// and friends, each call counted once by its marker token.
function countRegistrationChains(text, counts) {
  for (const match of text.matchAll(REGISTRATION)) {
    addBucket(counts, match[2]);
  }
}

// Object-option marker keys (node:test/jest it('x', { skip: true }, fn)) at
// the TOP level of a registration call's argument list. Nested option objects
// and keys inside the test body (arrow functions) sit at a deeper bracket
// depth and are not options of THIS registration — they are not counted here
// (the registration-chain rule above already covers chained skips, and a key
// on its own is only meaningful as an option of the innermost enclosing
// registration, which sees it at depth 1).
function countRegistrationOptionKeys(text, counts) {
  for (const opener of text.matchAll(REGISTRATION_OPEN)) {
    let depth = 0;
    let cursor = opener.index + opener[0].length;
    while (cursor < text.length) {
      const ch = text[cursor];
      if (ch === '(' || ch === '[' || ch === '{') {
        depth += 1;
        cursor += 1;
        continue;
      }
      if (ch === ')' || ch === ']' || ch === '}') {
        depth -= 1;
        if (depth < 0) break;
        cursor += 1;
        continue;
      }
      if (depth === 1 && (ch === 's' || ch === 't' || ch === 'x')) {
        OPTION_KEY.lastIndex = cursor;
        const key = OPTION_KEY.exec(text);
        if (key !== null && key.index === cursor) {
          addBucket(counts, key[1]);
          cursor = key.index + key[0].length;
          continue;
        }
      }
      cursor += 1;
    }
  }
}

// python runtime skips / go runtime skips.
function countRuntimeSkips(text, counts, family) {
  if (family === 'python') {
    for (const match of text.matchAll(PY_RUNTIME_SKIP)) addBucket(counts, 'skip');
  } else if (family === 'go') {
    for (const match of text.matchAll(GO_RUNTIME_SKIP)) addBucket(counts, 'skip');
  }
}

// ── JS-family lexical scanning (OMCX 2026-09-05) ────────────────────────────
// The masked-text regex approach cannot express the JS marker contexts the
// O8 marker/focus legs must enforce:
//   * a regex LITERAL's contents are not executable registrations — the
//     strings/comments masker never masked `/test.only(example)/`, so the
//     focus chain regex matched inside it;
//   * option keys count only as first-level property keys of an object
//     literal that is a DIRECT argument of a plain `id(` registration call
//     (node:test/jest `it('x', { skip: true }, fn)`) — a label/statement
//     inside an arrow-function BODY (`() => { skip: for(;;){} }`) is not an
//     option key, but a bare bracket-depth rule cannot tell them apart;
//   * QUOTED option keys (`{ 'skip': true }`) are equivalent to identifier
//     keys, yet string masking erased them.
// A small dependency-free lexer therefore tokenizes the raw source
// (comments/templates/regex literals opaque, strings opaque but content-
// readable at object-key positions) and the four marker families count over
// the token stream. All non-JS families keep the mask+regex path unchanged.

// Tokens after which a `/` starts a regex literal rather than division.
const JS_REGEX_AFTER = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await', 'instanceof', 'throw']);
// Keywords whose parenthesized header, when closed, puts the lexer back at
// STATEMENT start: the construct after the `)` is a body statement, which may
// itself begin with a regex literal (`if (enabled) /test.only(example)/.test(text);`
// — the `/` is a regex, not division). An ordinary call/grouping close `)`
// ends an EXPRESSION, where a following `/` is division (`foo() / 2`).
const JS_CONTROL_HEADERS = new Set(['if', 'while', 'for', 'switch', 'catch', 'with']);

// OMCX for-await headers (7d9573d2 review, 2026-09-05): `for await (` is a
// for-of header, but the '(' follows a fresh `await` (not the `for` itself),
// so the plain control-keyword lookbehind would record a NON-header paren and
// the contextual `of` inside would be treated as an ordinary identifier
// (division) — scanning a genuine regex iterable as code. The grammar has
// exactly one `for await (` production (the for-await-of statement), so when
// the '(' directly follows a fresh `await` whose own predecessor is a fresh
// `for`, the header is 'for'.
function jsForHeaderKeywordBeforeOpenParen(text, prev, tokens) {
  if (prev === null || prev.type !== 'id') return null;
  if (!jsFreshIdentifier(text, prev)) return null;
  if (JS_CONTROL_HEADERS.has(prev.value)) return prev.value;
  if (prev.value === 'await' && tokens.length >= 2) {
    const prior = tokens[tokens.length - 2];
    if (prior !== undefined && prior.type === 'id' && prior.value === 'for' && jsFreshIdentifier(text, prior)) return 'for';
  }
  return null;
}

function lexJsTokens(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  let prev = null; // {type:'id'|'num'|'str'|'tmpl'|'re'|'punct', value, start}
  // S48/OMCX follow-up (2026-09-05): per-open-paren control-header KEYWORD
  // (or null) — 'if'/'while'/'for'/'switch'/'catch'/'with' when the '(' is
  // the header of a control statement. The matching ')' then closes a
  // control CONDITION, not an expression, so a following '/' begins a regex
  // literal (statement position) rather than division (see
  // jsSlashStartsRegex below); a 'for' header is also the only place the
  // contextual `of` opens an operand (see jsIdOpensRegexLiteral).
  const parenStack = [];
  const push = (type, value, start, end) => {
    const token = { type, value, start, end };
    tokens.push(token);
    prev = token;
    i = end;
  };
  while (i < n) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') { i += 1; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i = Math.min(i + 2, n);
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let content = '';
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === '\\') { content += text[j + 1] ?? ''; j += 2; continue; }
        if (c === quote) { closed = true; j += 1; break; }
        if (c === '\n') break; // unterminated single-line string
        content += c;
        j += 1;
      }
      push('str', content, i, closed ? j : Math.min(j + 1, n));
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '`') { j += 1; break; }
        j += 1;
      }
      push('tmpl', '', i, j);
      continue;
    }
    if (ch === '/' && jsSlashStartsRegex(text, tokens, prev)) {
      // regex literal vs division: `/` begins a regex when the previous
      // significant token cannot end an expression.
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = text[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') { inClass = true; j += 1; continue; }
        if (c === ']') { inClass = false; j += 1; continue; }
        if (c === '/' && !inClass) { closed = true; break; }
        if (c === '\n') break;
        j += 1;
      }
      if (closed) {
        push('re', '', i, j + 1);
        continue;
      }
    }
    if (ch === '(' || ch === ')') {
      if (ch === '(') {
        // Record whether this '(' is a control-condition header paren: the
        // token before it is a FRESH control keyword (jsFreshIdentifier — an
        // `obj.if(...)` member call is an ordinary call, not a header).
        // Keywords are case-sensitive, so the exact lowercase spelling is
        // required. The stored value is the header keyword or null.
        // `for await (` is ALSO a 'for' header: the '(' follows a fresh
        // `await` whose own predecessor is a fresh `for` (for-await-of is the
        // only grammar production that spells `for await (`, so the two-token
        // lookbehind is unambiguous).
        const header = jsForHeaderKeywordBeforeOpenParen(text, prev, tokens);
        parenStack.push(header);
        push('punct', '(', i, i + 1);
      } else {
        const controlClose = parenStack.pop() !== null;
        push('punct', ')', i, i + 1);
        if (controlClose) prev.controlClose = true;
      }
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j])) j += 1;
      push('id', text.slice(i, j), i, j);
      // OMCX operand preservation (f9c2b0dd, 2026-09-05): record whether this
      // identifier is a GENUINE keyword in keyword position (see
      // jsIdOpensRegexLiteral), so the '/' rule distinguishes
      // `return /re/` / `typeof /re/` from `RETURN / x`, `of / x` (a declared
      // identifier) and `holder.return / x` (a member property) — only the
      // genuine keyword opens a regex literal, an identifier operand divides.
      prev.regexAfter = jsIdOpensRegexLiteral(text, prev, parenStack, tokens);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(text[j])) j += 1;
      push('num', text.slice(i, j), i, j);
      continue;
    }
    push('punct', ch, i, i + 1);
  }
  return tokens;
}

// Does a '/' at the current position start a regex literal (vs division)?
//   * start of file, after an opening punct / operator / ',' / ';' / ':' —
//     the parser expects an operand → regex.
//   * after an identifier in a GENUINE keyword position (`return /re/`,
//     `typeof /re/`, the for-of separator `of`) → regex (see
//     jsIdOpensRegexLiteral — the lexer annotates each id with
//     token.regexAfter at lex time).
//   * after an expression-ender — number/string/template/regex, `]`, `}`,
//     an ordinary call/grouping close `)`, or an IDENTIFIER OPERAND
//     (`RETURN`, a declared `of`, a member property `holder.return`) —
//     division.
// Two contexts refine the plain rule (OMCX follow-up, 2026-09-05):
//   * a ')' that closed a CONTROL-CONDITION header (if/while/for/…) is NOT an
//     expression end — the construct after it is a body STATEMENT, which may
//     itself start with a regex literal, so '/' there is a regex
//     (`if (enabled) /test.only(example)/.test(text);`);
//   * a '/' after a POSTFIX ++/-- (`n++ / test.only(...)`) is division: the
//     increment ends the left-hand expression. Only the postfix spelling ends
//     an expression — the char before the operator is the SAME sign and the
//     token before the pair ends an expression (`n + +/re/` keeps the regex).
function jsSlashStartsRegex(text, tokens, prev) {
  if (prev === null) return true;
  if (prev.type === 'punct') {
    if (prev.value === ')') return prev.controlClose === true;
    if (prev.value === ']' || prev.value === '}') return false;
    if ((prev.value === '+' || prev.value === '-') && jsIsPostfixIncDecTail(text, tokens, prev)) return false;
    return true;
  }
  if (prev.type === 'id') return prev.regexAfter === true;
  return false; // num/str/tmpl/re end an expression → division
}

// OMCX operand preservation (f9c2b0dd consolidation, 2026-09-05): does the
// identifier `token` sit in a GENUINE keyword position, i.e. does a '/' right
// after it open a regex literal rather than division?
//   * JS keywords are lowercase and case-sensitive: `RETURN` (a case-variant
//     identifier) is never `return`, so the spelling must EXACTLY match an
//     entry of JS_REGEX_AFTER.
//   * keyword-spelled MEMBER properties are operands, not keywords: the id
//     must be fresh — the raw char before it may not be a word char, '.', or
//     '$' (`holder.return / 2` divides, `obj.of / 2` divides).
//   * `of` is a CONTEXTUAL keyword: only the SEPARATOR of a for-of /
//     for-await-of header is keyword-like (see jsOfIsForHeaderSeparator). The
//     lexer records each paren's control-header keyword — a 'for' header at
//     ANY nesting depth, including the `for await (` form — and annotates
//     every id token with whether a following '/' starts a regex
//     (token.regexAfter).
function jsIdOpensRegexLiteral(text, token, parenStack, tokens) {
  if (!JS_REGEX_AFTER.has(token.value)) return false;
  if (!jsFreshIdentifier(text, token)) return false;
  if (token.value === 'of') {
    return jsOfIsForHeaderSeparator(text, token, parenStack, tokens);
  }
  return true;
}

// OMCX for-header separator position (7d9573d2 review, 2026-09-05): `of` is
// keyword-like ONLY in the for-of / for-await-of SEPARATOR slot — directly
// inside the for-header paren (parenStack top is the 'for' header, at any
// nesting depth) and immediately after the loop-variable binding:
//   * a genuine for-of header — `for (const item of …)`, `for (item of …)`,
//     `for (x.y of …)`, `for await (const item of …)`, destructuring
//     `for (const [a, b] of …)` — starts the iterable expression after the
//     separator, so a '/' right there is a REGEX LITERAL (`for (const item of
//     /re/.exec(s))` — the regex content is opaque, no marker counts);
//   * an `of` that is a DECLARED/used variable or a classic-for clause
//     operand is an ordinary identifier: `for (let of = 8; of / test.only(…)
//     / 2; of--)` — the binding `of` follows `let`, the clause operands
//     follow `;` — so the '/' after it is DIVISION and the real registration
//     counts; `const of = 8; … of / test.skip(…) / 2;` sits outside any
//     for-header paren and divides the same way.
// Discriminator: the token directly before the separator is the END of the
// loop-variable binding — a non-keyword identifier or the tail of a member
// expression / destructuring LHS (`for (item of …)`, `for (x.y of …)`,
// `for (obj.of of …)`), or a `]`/`}` closing a destructuring pattern
// (`for (const [a, b] of …)`). A `let`/`const`/`var` before `of` means `of`
// is the DECLARED binding name (`let of = 8`) — an operand, not a separator
// (the SEPARATOR itself may still follow such a binding: `for (var of of …)`
// declares a variable NAMED `of`, and the next `of` is the genuine
// separator — see below). Anything else (`(`, `;`, `=`, an operator, or a
// FRESH regex-after keyword such as `typeof of`, which is an operand in
// keyword position) is an operand position — with the one exception that a
// FRESH `of` before the current `of` is itself a binding end
// (`for (var of of /re/…)`, `for (of of /re/…)`), because `of` is the only
// JS_REGEX_AFTER member that may legally be an identifier.
function jsOfIsForHeaderSeparator(text, token, parenStack, tokens) {
  const top = parenStack[parenStack.length - 1];
  if (top !== 'for') return false;
  const prevTok = tokens[tokens.length - 2];
  if (prevTok === undefined || prevTok === null) return false;
  if (prevTok.type === 'punct') {
    return prevTok.value === ']' || prevTok.value === '}';
  }
  if (prevTok.type !== 'id') return false;
  if (prevTok.value === 'const' || prevTok.value === 'let' || prevTok.value === 'var') return false;
  // A keyword-spelled MEMBER tail (`obj.of`, `a.return`) is not fresh and is a
  // valid binding end — the current `of` is the separator. A FRESH
  // regex-after keyword directly before `of` is an OPERAND — EXCEPT `of`
  // itself: `of` is the only JS_REGEX_AFTER member that may legally be an
  // identifier (every other member is a reserved/always-keyword word), so a
  // fresh `of` immediately before the current `of` is a loop-variable BINDING
  // — declared (`for (var of of /re/…)`) or a reference binding
  // (`for (of of /re/…)`) — i.e. a valid binding end, and the current `of`
  // is the genuine for-of separator (the regex iterable stays opaque:
  // `for (var of of /test.only(example)/…` has NO focused registration).
  if (jsFreshIdentifier(text, prevTok) && JS_REGEX_AFTER.has(prevTok.value)) {
    return prevTok.value === 'of';
  }
  return true;
}

// prev is a '+' or '-' punct that is the SECOND char of a `++`/`--` operator
// (the source char immediately before it is the same sign). It is the tail of
// a POSTFIX increment/decrement — which ends an expression, making a
// following '/' division — when the token before the operator pair itself
// ends an expression (`n++ / 2`, `arr[i]-- / 2`). A prefix `++`/`--` or a
// binary/unary single `+`/`-` never ends an expression here, so the '/' after
// it keeps operand (regex) context.
function jsIsPostfixIncDecTail(text, tokens, prev) {
  if (prev.start === 0) return false;
  if (text[prev.start - 1] !== prev.value) return false; // lone + / -, or spaced + +
  const idx = tokens.indexOf(prev);
  if (idx < 2) return false;
  const first = tokens[idx - 1];
  if (first.type !== 'punct' || first.value !== prev.value) return false;
  return jsTokenEndsExpression(tokens[idx - 2]);
}

function jsTokenEndsExpression(token) {
  if (token === undefined || token === null) return false;
  if (token.type === 'id' || token.type === 'num' || token.type === 'str' || token.type === 'tmpl' || token.type === 're') return true;
  if (token.type === 'punct') return token.value === ')' || token.value === ']' || token.value === '}';
  return false;
}

// The registration id must not be the tail of a member expression or a
// longer identifier: the char immediately before it (in the raw source) may
// not be a word char, '.', or '$' — mirrors (?:^|[^\w$.]).
function jsFreshIdentifier(text, token) {
  if (token.start === 0) return true;
  return !/[A-Za-z0-9_$.]/.test(text[token.start - 1]);
}

function jsMarkerWord(word) {
  const lower = String(word).toLowerCase();
  if (lower === 'skip' || lower === 'skipif' || lower === 'todo' || lower === 'xfail') return finalSegment(lower);
  if (lower === 'only') return 'focus';
  return null;
}

// Count first-level property keys of an object literal whose '{' sits at
// tokens[openIdx]. Keys are identifier or string-literal tokens at the
// object's own top level immediately followed by ':' (nested objects, arrays,
// function bodies and template/regex contents never contribute). Returns the
// token index just past the matching '}'.
function jsCountObjectKeys(tokens, openIdx, counts) {
  const n = tokens.length;
  let depth = 0;
  let entry = true;
  for (let i = openIdx + 1; i < n; i += 1) {
    const token = tokens[i];
    if (token.type === 'punct') {
      const v = token.value;
      if (v === '{' || v === '(' || v === '[') {
        depth += 1;
        entry = false;
        continue;
      }
      if (v === '}' || v === ')' || v === ']') {
        if (depth === 0) return i + 1;
        depth -= 1;
        continue;
      }
      if (depth === 0) entry = v === ',';
      continue;
    }
    if (depth !== 0) continue;
    if (entry && (token.type === 'id' || token.type === 'str')) {
      const next = tokens[i + 1];
      if (next !== undefined && next.type === 'punct' && next.value === ':') {
        const marker = jsMarkerWord(token.value);
        if (marker === 'focus') counts.focus += 1;
        else if (marker !== null) counts[marker] += 1;
        entry = false;
        continue;
      }
    }
    entry = false;
  }
  return n;
}

// Scan the argument list of one plain registration call `id(`: option marker
// keys count only in object literals that are DIRECT arguments (a '{' right
// after the call paren or after a top-level comma). Function bodies, nested
// calls/arrays, and deeper object values are not option objects.
function jsScanRegistrationArgs(tokens, openParenIdx, counts) {
  const n = tokens.length;
  let depth = 0;
  let expectArg = true;
  for (let i = openParenIdx + 1; i < n; i += 1) {
    const token = tokens[i];
    if (token.type !== 'punct') {
      if (depth === 0) expectArg = false;
      continue;
    }
    const v = token.value;
    if (v === '(' || v === '[') {
      depth += 1;
      expectArg = false;
      continue;
    }
    if (v === '{') {
      if (depth === 0 && expectArg) {
        i = jsCountObjectKeys(tokens, i, counts) - 1;
        expectArg = false;
        continue;
      }
      depth += 1;
      expectArg = false;
      continue;
    }
    if (v === ')' || v === ']' || v === '}') {
      if (depth === 0) return;
      depth -= 1;
      continue;
    }
    if (depth === 0) expectArg = v === ',';
  }
}

// Count JS-family markers (skip/todo/xfail + focus) over the token stream.
//   * decorators: '@' + dotted path whose final segment is a marker word;
//   * chains: registrationId . (skip|skipif|todo|xfail) ( and .only( focus
//     chains (REGISTRATION / FOCUS_CHAIN vocabulary);
//   * focus registrars: fit( / fdescribe(;
//   * option keys in direct object-literal arguments of plain `id(` calls.
function countJsMarkers(text) {
  const tokens = lexJsTokens(text);
  const counts = { skip: 0, todo: 0, xfail: 0, focus: 0 };
  const n = tokens.length;
  const ids = new Set(REGISTRATION_IDS.map((id) => id.toLowerCase()));
  for (let i = 0; i < n; i += 1) {
    const token = tokens[i];
    if (token.type === 'punct' && token.value === '@') {
      // decorator/annotation path @a.b.c — the FINAL segment is the marker.
      let k = i + 1;
      if (k >= n || tokens[k].type !== 'id') continue;
      let last = tokens[k];
      while (k + 2 < n && tokens[k + 1].type === 'punct' && tokens[k + 1].value === '.' && tokens[k + 2].type === 'id') {
        last = tokens[k + 2];
        k += 2;
      }
      addBucket(counts, last.value);
      continue;
    }
    if (token.type !== 'id' || !jsFreshIdentifier(text, token)) continue;
    const idLower = token.value.toLowerCase();
    const next = tokens[i + 1];
    if (next === undefined || next.type !== 'punct') continue;
    // Focus registrar: fit( / fdescribe( (jasmine/mocha spellings).
    if ((idLower === 'fit' || idLower === 'fdescribe') && next.value === '(') {
      counts.focus += 1;
      continue;
    }
    if (!ids.has(idLower)) continue;
    if (next.value === '.') {
      // registration chain / focus chain: id . marker (
      const markerTok = tokens[i + 2];
      const openTok = tokens[i + 3];
      if (markerTok !== undefined && markerTok.type === 'id' && openTok !== undefined && openTok.type === 'punct' && openTok.value === '(') {
        const marker = jsMarkerWord(markerTok.value);
        if (marker === 'focus') counts.focus += 1;
        else if (marker !== null) counts[marker] += 1;
      }
      continue;
    }
    if (next.value === '(') {
      // plain registration call — option object argument scan.
      jsScanRegistrationArgs(tokens, i + 1, counts);
    }
  }
  return counts;
}

function countJsTestMarkers(text) {
  const counts = countJsMarkers(text);
  return { skip: counts.skip, todo: counts.todo, xfail: counts.xfail };
}

function countJsFocusMarkers(text) {
  return countJsMarkers(text).focus;
}

export function countTestMarkers(fileName, content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const family = familyOf(fileName);
  if (family === 'js') return countJsTestMarkers(text);
  const masked = mask(family, text);
  const counts = { skip: 0, todo: 0, xfail: 0 };
  countDecoratorMarkers(masked, counts);
  countRegistrationChains(masked, counts);
  countRegistrationOptionKeys(masked, counts);
  countRuntimeSkips(masked, counts, family);
  return counts;
}

// S52 (US-007, 2026-09-03): focus-marker counting. FOCUS markers are the
// suite-focusing modifiers — test.only(...) / it.only(...) / describe.only(...)
// (and specify/context/suite/task/bench chains), the bare jasmine/mocha
// registrars fit(...) / fdescribe(...), and the node:test object-option
// `{ only: true }` on a registration call. Any of them makes the runner
// execute ONLY the focused definitions, silently hiding every other test in
// the file (and, for a top-level `.only`, every other test FILE the runner
// sees) — the exact vector a W4.17-class fixer uses to make its red change
// look green without touching the seeded test.
//
// The SAME masking discipline as countTestMarkers applies: comments,
// docstrings and string literals are masked first, so prose that merely
// spells `test.only(...)` (a docstring example, a comment) never counts.
// Only the js family has focus constructs (pytest/jest-core vocabulary:
// python/go/java/rust/script files have no built-in focus registrar) —
// every other family returns 0.
export function countFocusMarkers(fileName, content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const family = familyOf(fileName);
  if (family !== 'js') return 0;
  return countJsFocusMarkers(text);
}

// Masked source text (comments/docstrings/string literals blanked, '\n'
// preserved) shared with the sibling test-definition analyzer
// (test-definitions.mjs) so every O8 byte-level scan uses the SAME masking
// discipline. maskSource(fileName, content) -> masked string.
export function maskSource(fileName, content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  return mask(familyOf(fileName), text);
}

// Language family of a path, exported for the sibling analyzers.
export function sourceFamily(fileName) {
  return familyOf(fileName);
}

// Marker vocabulary exported for tests/docs: every token the extractor maps
// onto the three inventory buckets.
export const MARKER_TOKEN_BUCKETS = Object.freeze({
  skip: ['skip', 'skipif', 'skipunless', 'skiptest'],
  todo: ['todo'],
  xfail: ['xfail'],
});
