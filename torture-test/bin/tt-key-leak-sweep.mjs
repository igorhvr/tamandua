#!/usr/bin/env node
// tt-key-leak-sweep.mjs — CRED-SURF US-006 key-value leak sweep.
//
// Scans a scan root (default torture-test/var) for files whose content
// contains any of the enumerated harness API-key VALUES that
// tt-provision-home surfaced into the contained TT home. The VALUE set is
// resolved AT RUNTIME from the contained home's materializations:
//
//   1. contained ~/.hermes/.env        — every `KEY=VALUE` line's VALUE
//   2. contained ~/.pi/agent/auth.json — every `{type:"api_key",key:...}`
//                                        entry's `key` (pi provider auth)
//
// The sweep source NEVER embeds a key value; only the resolved set is
// scanned for, so a freshly materialized key is covered without any code
// change (the US-006 "newly materialized items" requirement).
//
// The contained credential files themselves (~/.hermes/.env, pi auth.json
// under the contained home) are the value SOURCE, not scan targets: they
// legitimately contain the values, so the sweep excludes them from the scan
// (US-010 gate note). Everything else under the scan root (evidence, logs,
// audit JSON such as provision-audit.json, suite outputs, task artifacts) is
// a target.
//
// Fail-closed semantics: ANY hit → exit 1 naming the offending file(s);
// 0 hits → exit 0. Values are NEVER printed — only file paths and the count.
//
// Usage:
//   tt-key-leak-sweep.mjs [--root <dir>] [--home <dir>] [--help]
//
//   --root <dir>  scan root (default: TT_VAR env, else torture-test/var)
//   --home <dir>  contained TT home = value source (default: resolved)
//   --help        show this help
//
// Env seams (mirror the sibling tools):
//   TT_VAR        override the torture-test var root (scan root + home
//                 derivation: home = $TT_VAR/home)
//
// Exit codes:
//   0 = clean (0 hits)
//   1 = key-value hit(s) found (prints each offending file)
//   2 = usage / infra error
//
// Files only inside torture-test/. Zero tokens: purely local file scanning.
// The live 33xx daemon / ~/.tamandua are never touched.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
export const BIN_DIR = path.dirname(__filename);
export const TT_DIR = path.resolve(BIN_DIR, '..');
export const DEFAULT_VAR_ROOT = path.join(TT_DIR, 'var');

// ── contained-home resolution (mirrors tt-provision-home /
//    tt-harness-auth-probe) ─────────────────────────────────────────────
// Priority: TT_VAR env → $TT_VAR/home; tt-env.sh print → TT_HOME;
// fallback $TT_DIR/var/home. Never resolves to the operator's ~/.tamandua.
export function resolveContainedHome(env = process.env) {
  const ttVar = env.TT_VAR;
  if (ttVar) return path.join(path.resolve(ttVar), 'home');
  const envScript = path.join(TT_DIR, 'env', 'tt-env.sh');
  if (fs.existsSync(envScript)) {
    try {
      const out = spawnEnvPrint(envScript);
      const homeLine = (out.split(/\r?\n/) || []).find((l) => l.startsWith('TT_HOME='));
      if (homeLine) return homeLine.slice('TT_HOME='.length);
    } catch {
      // fall through to the default
    }
  }
  return path.join(DEFAULT_VAR_ROOT, 'home');
}

function spawnEnvPrint(envScript) {
  const res = spawnSync('env', ['-i', 'bash', envScript, 'print'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (res.error) throw res.error;
  return String(res.stdout ?? '');
}

// ── scan root resolution ───────────────────────────────────────────────
// TT_VAR env → itself; tt-env.sh print → TT_ROOT; fallback torture-test/var.
export function resolveScanRoot(env = process.env) {
  const ttVar = env.TT_VAR;
  if (ttVar) return path.resolve(ttVar);
  const envScript = path.join(TT_DIR, 'env', 'tt-env.sh');
  if (fs.existsSync(envScript)) {
    try {
      const out = spawnEnvPrint(envScript);
      const rootLine = (out.split(/\r?\n/) || []).find((l) => l.startsWith('TT_ROOT='));
      if (rootLine) return rootLine.slice('TT_ROOT='.length);
    } catch {
      // fall through to the default
    }
  }
  return DEFAULT_VAR_ROOT;
}

// ── dotenv value parsing (mirrors read_hermes_dotenv_value semantics) ──
// Read every `KEY=VALUE` line's VALUE from a dotenv file: skip blank lines
// and `#` comments; tolerate a leading `export ` prefix and matching
// surrounding quotes; the printed value is the unquoted KEY value.
export function parseDotenvValues(content) {
  const values = [];
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/^export[ \t]/.test(line)) {
      line = line.replace(/^export[ \t]+/, '');
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let val = line.slice(eq + 1);
    // trim surrounding spaces
    val = val.trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      val = val.slice(1, -1);
    }
    if (val !== '') values.push(val);
  }
  return values;
}

// ── pi auth.json value parsing ─────────────────────────────────────────
// Contained pi auth.json: {"<provider>":{"type":"api_key","key":"..."}} —
// collect every api_key entry's key string. Non-api_key entries (oauth
// etc.) carry no enumerated value and are ignored.
export function parsePiAuthKeyValues(content) {
  const values = [];
  let auth;
  try {
    auth = JSON.parse(content);
  } catch {
    return values;
  }
  if (!auth || typeof auth !== 'object') return values;
  for (const entry of Object.values(auth)) {
    if (entry && typeof entry === 'object' && entry.type === 'api_key') {
      if (typeof entry.key === 'string' && entry.key !== '') values.push(entry.key);
    }
  }
  return values;
}

// ── value-set collection from the contained home ───────────────────────
// Returns { home, envValues, piValues, all } where `all` is the deduped
// union in deterministic order (hermes .env values first, then pi auth.json
// values). Missing/unreadable source files yield empty contributions — the
// sweep then trivially scans for zero values (nothing materialized).
export function collectValues(home) {
  const envFile = path.join(home, '.hermes', '.env');
  const authFile = path.join(home, '.pi', 'agent', 'auth.json');
  const envValues = fs.existsSync(envFile)
    ? parseDotenvValues(fs.readFileSync(envFile, 'utf8'))
    : [];
  const piValues = fs.existsSync(authFile)
    ? parsePiAuthKeyValues(fs.readFileSync(authFile, 'utf8'))
    : [];
  const all = [...new Set([...envValues, ...piValues])];
  return { home, envValues, piValues, all };
}

// ── recursive scan ─────────────────────────────────────────────────────
// Walk `root` recursively and return the regular files under it. Skips:
//   * directories named `.git` or ending in `.git` (git internals — bare
//     fixture repos under var/fixtures/golden are not evidence/logs/audit)
//   * symlinks and non-regular entries
// `excludeFiles` (absolute paths) are never reported — the value-source
// credential files (contained .hermes/.env + pi auth.json) live here.
export function walkFiles(root, excludeFiles = []) {
  const excluded = new Set(excludeFiles.map((f) => path.resolve(f)));
  const files = [];
  const stack = [path.resolve(root)];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip (root existence checked by caller)
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const base = entry.name;
        if (base === '.git' || base.endsWith('.git')) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (excluded.has(path.resolve(full))) continue;
        files.push(full);
      }
      // symlinks / sockets / fifos are skipped
    }
  }
  return files.sort();
}

// ── the sweep ──────────────────────────────────────────────────────────
// Returns { hits: [{ file, count }] } — files whose content contains at
// least one scanned value. `count` is the number of DISTINCT scanned values
// present (values themselves are never returned/printed).
export function sweepRoot(root, values, { home } = {}) {
  const excludeFiles = home
    ? [path.join(home, '.hermes', '.env'), path.join(home, '.pi', 'agent', 'auth.json')]
    : [];
  const hits = [];
  for (const file of walkFiles(root, excludeFiles)) {
    let buf;
    try {
      buf = fs.readFileSync(file);
    } catch {
      continue; // unreadable target — not evidence of a leak
    }
    const present = new Set();
    for (const value of values) {
      if (value !== '' && buf.includes(Buffer.from(value, 'utf8'))) present.add(value);
    }
    if (present.size > 0) hits.push({ file, count: present.size });
  }
  return { hits };
}

// ── CLI ────────────────────────────────────────────────────────────────

export function usage() {
  return [
    'tt-key-leak-sweep — scan torture-test/var evidence for materialized API-key VALUES',
    '',
    'Usage: tt-key-leak-sweep.mjs [--root <dir>] [--home <dir>] [--help]',
    '',
    'Resolves the enumerated API-key VALUES at runtime from the contained TT',
    'home (contained ~/.hermes/.env + ~/.pi/agent/auth.json — the surfaced',
    'materializations), then scans the scan root (default torture-test/var)',
    'for files containing any of those VALUES. The contained credential files',
    'are the value SOURCE, not targets — they are excluded from the scan.',
    '',
    'Fail-closed: any hit exits 1 and names each offending file (VALUES are',
    'never printed); 0 hits exits 0.',
    '',
    'Options:',
    '  --root <dir>   scan root (default: TT_VAR env, else torture-test/var)',
    '  --home <dir>   contained TT home = value source (default: resolved',
    '                 via TT_VAR -> env/tt-env.sh print -> var/home)',
    '  --help         show this help',
    '',
    'Env seams:',
    '  TT_VAR         override the var root (scan root + home derivation)',
    '',
    'Exit codes: 0 clean; 1 hit(s); 2 usage/infra error.',
  ].join('\n');
}

export function runCli(argv, env = process.env) {
  let root;
  let home;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (arg === '--root') {
      root = path.resolve(argv[++i]);
    } else if (arg === '--home') {
      home = path.resolve(argv[++i]);
    } else {
      process.stderr.write(`REASON: usage-error: unknown option: ${arg}\n`);
      process.stderr.write(`${usage()}\n`);
      return 2;
    }
  }
  const scanRoot = root ?? resolveScanRoot(env);
  const containedHome = home ?? resolveContainedHome(env);

  if (!fs.existsSync(scanRoot) || !fs.statSync(scanRoot).isDirectory()) {
    process.stderr.write(`REASON: scan-root-missing: ${scanRoot}\n`);
    return 2;
  }

  const { all: values } = collectValues(containedHome);
  const { hits } = sweepRoot(scanRoot, values, { home: containedHome });

  if (hits.length > 0) {
    for (const hit of hits) {
      process.stdout.write(`KEY-LEAK: ${hit.file} (${hit.count} value(s))\n`);
    }
    process.stdout.write(`KEY-LEAK-SWEEP: ${hits.length} file(s) contain materialized key value(s)\n`);
    return 1;
  }
  process.stdout.write(
    `KEY-LEAK-SWEEP: 0 hits over ${scanRoot} (${values.length} value(s) scanned from ${containedHome})\n`,
  );
  return 0;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isCli) {
  process.exitCode = runCli(process.argv.slice(2));
}
