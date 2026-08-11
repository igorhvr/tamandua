// tt-hygiene-canary.mjs — FIX10 US-005 operator-identity hygiene canary.
//
// Before a campaign starts, snapshot sha256 hashes of the operator's real
// identity files; after the campaign ends, recompute and compare. Any diff
// becomes a campaign-level FINDING (HYGIENE_* diff types) — never silent.
// This is the O18-style canary the FIX10 spec calls for: the 2026-08-05
// breach (a torture-test hook rewrote the operator's real ~/.gitconfig)
// must never again pass unnoticed.
//
// Privacy: only HASHES are stored or recorded — never file contents.
// The real operator home is resolved via os.userInfo().homedir — deliberately
// NOT $HOME, mirroring the product test guard (spec 01 §TAMANDUA_TEST_GUARD).
// The canary NEVER writes operator files; failure to resolve the real home
// fails closed (throws), it does not silently skip.
//
// Test-only override: TT_HYGIENE_CANARY_HOME is honored ONLY when
// TT_CONTROLLER_SELF_TEST=1 (mirrors resolveOraclesRoot in tt-controller),
// so self-tests can point the canary at a temp home and simulate a breach
// deterministically.
//
// NOTE: this file must never contain the literal `git config` + `--global`
// adjacent text — the US-001 audit grep treats it as a write site.

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HYGIENE_CANARY_DIFF_TYPE_GITCONFIG = 'HYGIENE_GITCONFIG';
export const HYGIENE_CANARY_DIFF_TYPE_SSH_CONFIG = 'HYGIENE_SSH_CONFIG';
export const HYGIENE_CANARY_DIFF_TYPE_CRONTAB = 'HYGIENE_CRONTAB';

// Watched operator-identity files (relative to the operator home). The
// .gitconfig is the breach surface (required); ~/.ssh/config and the
// crontab are secondary identity artifacts watched when present.
const WATCHED_FILES = [
  {
    name: 'gitconfig',
    file: '.gitconfig',
    diffType: HYGIENE_CANARY_DIFF_TYPE_GITCONFIG,
  },
  {
    name: 'ssh_config',
    file: path.join('.ssh', 'config'),
    diffType: HYGIENE_CANARY_DIFF_TYPE_SSH_CONFIG,
  },
];

// Resolve the REAL operator home (os.userInfo().homedir — never $HOME).
// A test-only override is honored only under TT_CONTROLLER_SELF_TEST=1.
// Any failure to resolve the home throws (fail closed).
export function resolveHygieneHome() {
  const override = process.env.TT_HYGIENE_CANARY_HOME;
  if (override !== undefined) {
    if (process.env.TT_CONTROLLER_SELF_TEST !== '1') {
      throw new Error('TT_HYGIENE_CANARY_HOME requires TT_CONTROLLER_SELF_TEST=1');
    }
    const candidate = path.resolve(override);
    let details;
    try {
      details = fs.lstatSync(candidate);
    } catch (error) {
      throw new Error(`hygiene canary home is not resolvable: ${candidate} (${error.message})`);
    }
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`hygiene canary home is not a regular directory: ${candidate}`);
    }
    return candidate;
  }
  const home = os.userInfo().homedir;
  if (typeof home !== 'string' || home === '') {
    throw new Error('cannot resolve the operator home for the hygiene canary (os.userInfo().homedir is empty)');
  }
  let details;
  try {
    details = fs.lstatSync(home);
  } catch (error) {
    throw new Error(`cannot resolve the operator home for the hygiene canary: ${home} (${error.message})`);
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error(`the operator home is not a regular directory: ${home}`);
  }
  return home;
}

// sha256 of a regular file. Absent files (and non-regular entries such as
// symlinks or directories) hash to null. Only ever READS the file; never
// writes. Fail closed on any unreadable regular file (loud, not silent).
function fileHash(file) {
  let details;
  try {
    details = fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return { hash: null, present: false };
    throw new Error(`hygiene canary cannot inspect ${file}: ${error.message}`);
  }
  if (!details.isFile() || details.isSymbolicLink()) return { hash: null, present: false };
  let content;
  try {
    content = fs.readFileSync(file);
  } catch (error) {
    throw new Error(`hygiene canary cannot hash ${file}: ${error.message}`);
  }
  return { hash: createHash('sha256').update(content).digest('hex'), present: true };
}

// sha256 of `crontab -l` output. Any non-zero exit / spawn failure means no
// crontab (absent -> null). Read-only; never writes the crontab.
function crontabHash() {
  const result = spawnSync('crontab', ['-l'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
    shell: false,
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    return { hash: null, present: false };
  }
  return { hash: createHash('sha256').update(result.stdout).digest('hex'), present: true };
}

// Snapshot the watched operator-identity files. Returns
// { home, files: [{ name, path, hash, present, diffType }] } — hashes only,
// never file contents. Throws (fail closed) if the home cannot be resolved.
export function snapshotHygieneCanary() {
  const home = resolveHygieneHome();
  const files = WATCHED_FILES.map(({ name, file, diffType }) => {
    const absolute = path.join(home, file);
    const { hash, present } = fileHash(absolute);
    return { name, path: absolute, hash, present, diffType };
  });
  const crontab = crontabHash();
  files.push({
    name: 'crontab',
    path: null,
    hash: crontab.hash,
    present: crontab.present,
    diffType: HYGIENE_CANARY_DIFF_TYPE_CRONTAB,
  });
  return { home, files };
}

function entryStatus(beforeEntry, afterEntry) {
  const beforePresent = beforeEntry?.present === true;
  const afterPresent = afterEntry?.present === true;
  if (!beforePresent && !afterPresent) return 'ABSENT';
  if (beforePresent && afterPresent && beforeEntry.hash === afterEntry.hash) return 'UNCHANGED';
  return 'CHANGED';
}

// Compare a before snapshot against an after snapshot. Returns
// { statuses: [{ name, path, before, after, status }], diffs: [{ type,
// file, before, after }] } where status is UNCHANGED/CHANGED/ABSENT and each
// diff carries a HYGIENE_* type. Pure comparison — never touches the files.
export function verifyHygieneCanary(before, after) {
  const statuses = [];
  const diffs = [];
  const names = new Set([...(before ?? []), ...(after ?? [])].map((entry) => entry?.name).filter(Boolean));
  for (const name of names) {
    const beforeEntry = (before ?? []).find((entry) => entry.name === name);
    const afterEntry = (after ?? []).find((entry) => entry.name === name);
    const status = entryStatus(beforeEntry, afterEntry);
    statuses.push({
      name,
      path: afterEntry?.path ?? beforeEntry?.path ?? null,
      before: beforeEntry?.hash ?? null,
      after: afterEntry?.hash ?? null,
      status,
    });
    if (status === 'CHANGED') {
      diffs.push({
        type: afterEntry?.diffType ?? beforeEntry?.diffType ?? 'HYGIENE_UNKNOWN',
        file: afterEntry?.path ?? beforeEntry?.path ?? name,
        before: beforeEntry?.hash ?? null,
        after: afterEntry?.hash ?? null,
      });
    }
  }
  return { statuses, diffs };
}
