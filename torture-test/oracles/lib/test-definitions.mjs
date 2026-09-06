// S52 (US-007, 2026-09-03) — same-name test shadowing analyzer for O8.
//
// DEFECT (W4.17-class smuggling): the O8 seeded-test additive carve-out
// (S19) tolerates ANY pure insertion into a seeded test file — including a
// SECOND definition of a test name the seeded file already defines. In the
// runners the fixtures use this silently disables the seeded definition:
// pytest re-binds a module attribute (or a class attribute) at import time,
// so only the LAST same-name `def test_*` is collected; jest/vitest throw on
// duplicate test names in one scope only when the runner happens to fail
// hard, and a duplicate in a file whose scope the runner tolerates shadows
// or ambiguates the earlier case. Either way the seeded red test stops being
// the test that runs, and the additive carve-out reports the change as the
// informational O8_SEEDED_TEST_EXTENDED (PASS).
//
// CONTRACT: a test file must never define the SAME test name twice in ONE
// scope. duplicateTestDefinitionNames(fileName, content) returns one record
// per (scope, name) pair that is defined at least twice in the file:
//   [{ scope, name, count }]
// Scope models where the runner would treat two same-name definitions as
// the same slot:
//   * python (pytest): 'module' for module-level `def test_*` functions and
//     module-level `class Test*` classes (a redefined class re-binds the
//     module attribute and is the only one pytest discovers); 'class:<Name>'
//     for `def test_*` methods of a module-level `class Test*` (a redefined
//     method re-binds the class attribute). Comments/docstrings/strings are
//     masked first, so docstring examples of `def test_x` never count.
//     Accepted conservative limitation: a module-level class nested INSIDE a
//     class body is not tracked as its own scope (defs inside it are charged
//     to the outer module-level class) — no seeded or real fixture uses
//     nested Test classes.
//   * js/ts (jest/vitest/node:test/mocha/japa): registrations of the case
//     ids test/it/specify are charged to the scope of the innermost
//     enclosing describe/context/suite BLOCK they sit in (a scope key built
//     from the nesting path of enclosing suite spans, so two sibling suites
//     with the same title are DIFFERENT scopes); registrations outside any
//     suite use scope ''. A duplicated case name inside the SAME suite path
//     is a shadow/ambiguity. Static names only (a registration whose first
//     argument is a variable or an interpolated template literal is skipped —
//     its slot cannot be compared mechanically). Comments/docstrings/string
//     content is masked for STRUCTURE (opener/brace/arrow detection), while
//     the name literal is read from the original text — a string that merely
//     spells `it('x', ...)` inside prose never opens a registration.
//
// The analyzer is dependency-free and deterministic, mirroring the
// masking discipline of oracles/lib/test-markers.mjs; O8 computes it at
// evaluation time from the authoritative git-HEAD bytes (never from the
// captured inventory), and only reports shadowing whose duplication did NOT
// already exist in the baseline bytes (introduction semantics — see o8.mjs).

import { maskSource, sourceFamily } from './test-markers.mjs';

// ── python (pytest) ────────────────────────────────────────────────────────
// Module-level `def test_*` and `class Test*` names, plus `def test_*`
// methods of each module-level `class Test*` (scope 'class:<Name>').
function pythonDefinitionCounts(masked) {
  const counts = new Map(); // `${scope}\u0000${name}` -> count
  const add = (scope, name) => {
    const key = `${scope}\u0000${name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  let currentClass = null; // module-level class currently open
  for (const rawLine of masked.split('\n')) {
    const indent = rawLine.length - rawLine.trimStart().length;
    const line = rawLine.trim();
    if (line === '') continue;
    const classMatch = /^class\s+([A-Za-z_]\w*)/.exec(line);
    const defMatch = /^def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    if (classMatch !== null) {
      if (indent === 0) {
        const name = classMatch[1];
        currentClass = name.startsWith('Test') ? name : null;
        // pytest collects a module-level class whose name starts with Test;
        // two same-name module-level Test classes shadow each other.
        if (name.startsWith('Test')) add('module', name);
      }
      continue;
    }
    if (defMatch !== null) {
      const name = defMatch[1];
      if (indent === 0) {
        currentClass = null;
        if (name.startsWith('test')) add('module', name);
      } else if (currentClass !== null && name.startsWith('test')) {
        // A def deeper than the module-level class keyword is a method (or,
        // conservatively, a def nested inside one — both re-bind the class
        // attribute slot when the name repeats; real seeds never nest
        // test_-prefixed functions inside methods).
        add(`class:${currentClass}`, name);
      }
      continue;
    }
    // Any other top-level statement closes an open module-level class (its
    // body has ended) so a later same-name class/def starts a fresh slot.
    if (indent === 0) currentClass = null;
  }
  return counts;
}

// ── js/ts (jest/vitest/node:test/mocha/japa) ───────────────────────────────
const SUITE_IDS = ['describe', 'context', 'suite'];
const CASE_IDS = ['test', 'it', 'specify'];
const REG_ID = (ids) => `(?:^|[^\\w$.])(${ids.join('|')})(?:\\s*\\.\\s*(?:only|skip|todo|xfail))?\\s*\\(`;

function collectRegistrationOpeners(masked, ids) {
  const regex = new RegExp(REG_ID(ids), 'g');
  const openers = [];
  for (const match of masked.matchAll(regex)) {
    // The regex consumed the optional chain and the '(' — the opener '(' is
    // the regex match's final character.
    openers.push({ at: match.index + match[0].length - 1 });
  }
  return openers;
}

// Suite callback-body span [bodyOpen, bodyClose] for a suite registration
// whose opener '(' sits at `openAt`, or null when the suite has no inline
// arrow/function body (its tests then charge to the enclosing scope).
function suiteBodySpan(masked, openAt) {
  // Balance parens from the opener; the registration's OWN closing ')' is the
  // one that returns the paren depth to 0. The suite's OWN callback arrow is
  // the FIRST '=>' after the opener (name/options precede the callback, and
  // string content — where an arrow could hide — is already masked), so
  // arrows of NESTED suites (which lie inside this suite's body, after the
  // callback already opened) cannot be mistaken for this suite's arrow.
  let depth = 0;
  let cursor = openAt;
  let arrowAt = -1;
  while (cursor < masked.length) {
    const ch = masked[cursor];
    if (ch === '(') {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth < 0) return null;
      cursor += 1;
      if (depth === 0) break; // the registration's own close paren
      continue;
    }
    if (arrowAt < 0 && ch === '=' && masked[cursor + 1] === '>' && depth >= 1) {
      arrowAt = cursor;
      cursor += 2;
      continue;
    }
    cursor += 1;
  }
  if (arrowAt < 0) return null;
  // The callback body brace follows the arrow: skip whitespace.
  let body = arrowAt + 2;
  while (body < masked.length && (masked[body] === ' ' || masked[body] === '\t' || masked[body] === '\r' || masked[body] === '\n')) body += 1;
  if (masked[body] !== '{') return null;
  let braceDepth = 0;
  let i = body;
  while (i < masked.length) {
    const ch = masked[i];
    if (ch === '{') braceDepth += 1;
    else if (ch === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) return { bodyOpen: body, bodyClose: i };
    }
    i += 1;
  }
  return null;
}

function readStaticStringArg(text, afterOpen) {
  let cursor = afterOpen;
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t' || text[cursor] === '\r' || text[cursor] === '\n')) cursor += 1;
  const quote = text[cursor];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  if (quote === '`') {
    // A template literal is static only when it contains no interpolation.
    const rest = text.indexOf('`', cursor + 1);
    if (rest < 0) return null;
    const body = text.slice(cursor + 1, rest);
    if (body.includes('${')) return null;
    return { name: body, end: rest + 1 };
  }
  const bodyStart = cursor + 1;
  let i = bodyStart;
  let escaped = false;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === quote) break;
    if (ch === '\n') return null; // unterminated single-line string
  }
  if (i >= text.length) return null;
  return { name: text.slice(bodyStart, i), end: i + 1 };
}

function jsDefinitionCounts(original, masked) {
  const counts = new Map(); // `${scopeKey}\u0000${name}` -> count
  const suiteSpans = collectRegistrationOpeners(masked, SUITE_IDS)
    .map((opener) => ({ ...opener, span: suiteBodySpan(masked, opener.at) }))
    .filter((entry) => entry.span !== null)
    .sort((a, b) => a.at - b.at);
  const caseOpeners = collectRegistrationOpeners(masked, CASE_IDS).sort((a, b) => a.at - b.at);
  for (const opener of caseOpeners) {
    // The case id may be `.only`/`.skip`/… chained — the name still occupies
    // the slot it would register under.
    const nameArg = readStaticStringArg(original, opener.at + 1);
    if (nameArg === null) continue;
    // Scope = the nesting path of every suite span strictly containing this
    // registration, keyed by span identity (start index), innermost last.
    const path = suiteSpans.filter((suite) => suite.span.bodyOpen < opener.at && opener.at < suite.span.bodyClose)
      .map((suite) => String(suite.at))
      .join('/');
    const key = `${path}\u0000${nameArg.name}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function duplicateTestDefinitionNames(fileName, content) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  const family = sourceFamily(fileName);
  const masked = maskSource(fileName, text);
  let counts;
  if (family === 'python') counts = pythonDefinitionCounts(masked);
  else if (family === 'js') counts = jsDefinitionCounts(text, masked);
  else return [];
  const duplicated = [];
  for (const [key, count] of counts) {
    if (count < 2) continue;
    const separator = key.indexOf('\u0000');
    duplicated.push({ scope: key.slice(0, separator), name: key.slice(separator + 1), count });
  }
  return duplicated.sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope.localeCompare(b.scope)));
}
