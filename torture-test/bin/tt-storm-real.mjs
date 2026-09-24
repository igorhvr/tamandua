// tt-storm-real.mjs — STORM-REAL standalone REAL effect adapters.
//
// The recording gate (tier2-storm-orchestrator-recording-gate.test.ts)
// proves decision-code choreography with injected synthetic adapters; it
// cannot prove the REAL adapters work — a bare real launch under the old
// CLI inherited the operator's HOME/STATE/DB (the coordinator's starting
// gap), the DB run-id seam queried bare-uuid columns with public run-<uuid>
// keys, the MCP transport reported not-wired, and sleeps/cleanup could be
// settled without real evidence. This module is the REAL boundary: every
// exported constructor either performs a real effect through explicit
// owned resources or refuses with a machine-parseable code — never an
// operator fallback, never a fabricated success.
//
// Rehearsal-gate posture (STORM-REAL staged authority): the real rehearsal
// runs ONE contained daemon + owned origin with an explicit SCRIPTED_REHEARSAL
// profile AFTER coordinator approval. Before approval this module still
// ships the complete boundary: private exec-context construction, mode
// containment, run-scope canonicalization at the DB seam, and the real
// transport/phase/cleanup wiring the rehearsal will exercise. Absent
// approval, launch-mode entry refuses with TT_REHEARSAL_NOT_APPROVED and
// nothing is spawned.
//
// This module NEVER touches src/, native/, e2e/, product workflows, the live
// install, or another worktree: it is torture-owned suite machinery whose
// effects are contained under the campaign's own var-resident execution
// context.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  ACTIVE_STEP_STATUSES,
  TERMINAL_RUN_STATUSES,
  normalizedStoredRunId,
  refusal,
  sha256,
} from './tt-contention-slice-shared.mjs';
import {
  parseRunKey,
  spawnCapture,
  withRunIdentities,
  withRunParentIdentity,
  PARENT_AUTHORITY_VARS,
  AUTHORITY_VAR_RE,
  PROTECTED_CHILD_ENV_KEYS,
  isProtectedChildEnvKey,
  stripParentAuthorityEnv,
  inheritChildEnvMinimum,
} from './tt-storm-shared.mjs';

// Repo root resolved from THIS module's location (never process.cwd()): the
// product schema path (dist/db.js) is addressed absolutely so a caller's cwd
// can never redirect prepare onto a foreign build.
const MODULE_DIR = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = path.dirname(path.dirname(MODULE_DIR));

export const EXEC_CONTEXT_SCHEMA_VERSION = 2; // v2: owned roots are ALLOCATED and identity-captured at construction
export const TT_REHEARSAL_NOT_APPROVED = 'TT_REHEARSAL_NOT_APPROVED';
export const TT_EXEC_ESCAPE = 'TT_EXEC_ESCAPE';
export const TT_UNRESOLVED_BINARY = 'TT_UNRESOLVED_BINARY';
export const TT_UNKNOWN_BINARY = 'TT_UNKNOWN_BINARY';
export const TT_NOT_OWNED = 'TT_NOT_OWNED';
export const TT_CLEANUP_NOT_EVIDENCED = 'TT_CLEANUP_NOT_EVIDENCED';
// S2 (run #56 abort): a campaign's exec-identity DB must be created FRESH by
// the PRODUCT schema path. A pre-existing file at the private path is a stale/
// hand-rolled DB (e.g. a suite-provisioned runs table without notify_url) and
// is refused, never reused/deleted. When the product schema module itself
// cannot run, the campaign cannot be prepared.
export const TT_EXEC_DB_STALE = 'TT_EXEC_DB_STALE';
export const TT_PRODUCT_DB_UNAVAILABLE = 'TT_PRODUCT_DB_UNAVAILABLE';

// Re-exported from tt-storm-shared.mjs (canonical definition at the spawn
// boundary — see the constant there).
export { PARENT_AUTHORITY_VARS, AUTHORITY_VAR_RE, PROTECTED_CHILD_ENV_KEYS, stripParentAuthorityEnv };

// ─────────────────────────────────────────────────────────────────────
// Private execution context — one admitted, immutable authority for every
// real effect of a campaign. Constructed once per campaign (prepare) and
// reused by run/resume/report/arm; never recomputed from a reason string.
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve an absolute executable. `candidates` are tried in order; the first
 * that exists, is a file, and is executable is returned. A relative name or
 * an unresolved candidate is a refusal (never a silent PATH fallback into an
 * uncontained location — the caller passes ABSOLUTE candidate paths).
 */
export function resolveAbsoluteBinary(candidates, { label = 'binary', fsx = fs } = {}) {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const cand of list) {
    if (typeof cand !== 'string' || cand.length === 0) continue;
    if (!path.isAbsolute(cand)) {
      throw refusal(`${label} must be an absolute path: ${cand}`, TT_UNRESOLVED_BINARY);
    }
    try {
      const st = fsx.statSync(cand);
      if (st.isFile()) {
        // executability probe: access X_OK where supported (linux/mac).
        try { fsx.accessSync(cand, fs.constants?.X_OK); return cand; } catch { /* keep scanning */ }
      }
    } catch {
      // stat failed → not present → keep scanning
    }
  }
  throw refusal(`no executable ${label} among: ${list.join(', ')}`, TT_UNRESOLVED_BINARY);
}

/**
 * Build the immutable private execution context for a campaign.
 *
 * STORM-REAL / root review fixes:
 *  * The owned exec roots (private HOME, TAMANDUA_STATE_DIR, TMPDIR) are
 *    ALLOCATED HERE (mkdir -p) BEFORE any dev/ino identity is captured
 *    (issue D / root defect #3): a context whose roots were never created
 *    recorded null dev/ino and assertOwnershipUnchanged skipped them, so the
 *    "replaced/removed owned root refused" guarantee was vacuous in the real
 *    flow and the real launch cwd did not exist (spawn error). Now every
 *    owned root exists with real dev/ino captured at allocation; the receipt
 *    is persisted into campaign state at prepare (persistableExecIdentity)
 *    and revalidated by later modes (revalidatePersistedExecIdentity).
 *  * The child env is an EXPLICIT MINIMUM (root defect #1): only a tiny
 *    credential-free allowlist is inherited from the operator env (PATH,
 *    locale, ...). Provider credentials, a production control port, foreign
 *    TAMANDUA_WORKTREE_ROOT and the whole TAMANDUA authority family never
 *    enter child_env. extraEnv entries are validated: a protected key
 *    (HOME / TAMANDUA_STATE_DIR / TAMANDUA_DB_PATH / TMPDIR / guard /
 *    authority family) can never be redirected by a caller.
 *
 * @param {object} p
 * @param {string} p.varRoot        torture-test/var (contained root)
 * @param {object} p.fsx            fs adapter (default node:fs; tests inject a mirror)
 * @param {object} p.binaries       { tamandua, tamanduaTest?, ttChaos, daemonControl, git? }
 * @param {string} p.stateRoot      state root (default <varRoot>/home/.tamandua)
 * @param {string} p.dbPath         campaign DB path (default <stateRoot>/tamandua.db)
 * @param {string} p.tmpRoot        temp root (default <varRoot>/tmp)
 * @param {string} [p.homeRoot]     private HOME (default <varRoot>/home)
 * @param {object} [p.extraEnv]     extra explicit child env entries (validated)
 * @param {string} [p.ownerRef]     recorded owner identity (e.g. campaign id)
 * @param {boolean} [p.allocateRoots]  mkdir the owned dirs before capture (default true)
 * @returns {object} frozen context with dev/ino ownership evidence.
 */
export function buildPrivateExecContext({
  varRoot,
  fsx = fs,
  binaries = {},
  stateRoot = null,
  dbPath = null,
  tmpRoot = null,
  homeRoot = null,
  extraEnv = {},
  ownerRef = 'tt-storm',
  allocateRoots = true,
}) {
  if (!varRoot || !path.isAbsolute(varRoot)) {
    throw refusal(`private exec context requires an absolute varRoot (got ${JSON.stringify(varRoot)})`, TT_EXEC_ESCAPE);
  }
  const realVarRoot = safeRealpath(varRoot, fsx, 'varRoot');
  const admitUnder = (candidate, label) => {
    if (!candidate) return null;
    const abs = path.resolve(String(candidate));
    const real = safeRealpath(abs, fsx, label) ?? abs;
    if (!pathIsWithin(realVarRoot, real)) {
      throw refusal(`${label} escapes the contained var root ${realVarRoot}: ${abs}`, TT_EXEC_ESCAPE);
    }
    return abs;
  };
  const home = homeRoot ? path.resolve(String(homeRoot)) : path.join(realVarRoot, 'home');
  const state = stateRoot ? path.resolve(String(stateRoot)) : path.join(home, '.tamandua');
  const db = dbPath ? path.resolve(String(dbPath)) : path.join(state, 'tamandua.db');
  const tmp = tmpRoot ? path.resolve(String(tmpRoot)) : path.join(realVarRoot, 'tmp');
  admitUnder(home, 'private HOME');
  admitUnder(state, 'TAMANDUA_STATE_DIR');
  admitUnder(db, 'TAMANDUA_DB_PATH');
  admitUnder(tmp, 'TMPDIR');

  // Allocate the owned directory roots FIRST so every captured dev/ino is a
  // real identity of a directory THIS context owns (issue D / root defect #3).
  if (allocateRoots) {
    allocateOwnedRoots({ home, state, tmp }, fsx);
  }

  const resolved = {};
  for (const [key, value] of Object.entries(binaries)) {
    if (value === undefined || value === null) continue;
    resolved[key] = resolveAbsoluteBinary(Array.isArray(value) ? value : [value], { label: `binary ${key}`, fsx });
  }
  // tamandua is mandatory for a launch-capable context; ttChaos + daemonControl
  // mandatory for a Round B context. Resolution happens here so a campaign
  // context that cannot act refuses at construction — before any effect.
  if (!resolved.tamandua) throw refusal('private exec context requires an absolute tamandua binary', TT_UNRESOLVED_BINARY);

  const ownership = ownershipEvidenceFor({ home, state, db, tmp }, fsx);

  // extraEnv is validated BEFORE it enters child_env: protected/authority keys
  // cannot be redirected by a caller (root defect #2).
  const sanitizedExtra = {};
  for (const [k, v] of Object.entries(extraEnv ?? {})) {
    if (v === undefined) continue;
    if (isProtectedChildEnvKey(k)) {
      throw refusal(`extraEnv cannot override protected child env key ${k}`, TT_EXEC_ESCAPE);
    }
    sanitizedExtra[k] = String(v);
  }

  // Child env is an EXPLICIT MINIMUM (root defect #1): a small credential-free
  // allowlist from the operator env + the privately owned roots + guard +
  // sanitized explicit extras. NO wholesale process.env copy.
  const childEnv = {
    ...inheritChildEnvMinimum(process.env ?? {}),
    ...sanitizedExtra,
    HOME: home,
    TAMANDUA_STATE_DIR: state,
    TAMANDUA_DB_PATH: db,
    TMPDIR: tmp,
    TAMANDUA_TEST_GUARD: '1',
  };
  const frozenEnv = Object.freeze(stripParentAuthorityEnv(childEnv));

  const ctx = {
    schema_version: EXEC_CONTEXT_SCHEMA_VERSION,
    owner_ref: ownerRef,
    var_root: realVarRoot,
    home_root: home,
    state_root: state,
    db_path: db,
    tmp_root: tmp,
    binaries: Object.freeze(resolved),
    ownership,
    child_env: frozenEnv,
    extra_env: Object.freeze(sanitizedExtra),
  };
  return Object.freeze(ctx);
}

// Create the owned directory roots (private HOME, its .tamandua state dir,
// and TMPDIR). db file is NOT created here: it is created by the daemon when
// it first opens the private state; its identity anchor is the state dir.
// No filesystem DISPOSAL ever happens — allocation is mkdir-only and every
// artifact is retained (no-removal policy).
export function allocateOwnedRoots({ home, state, tmp }, fsx = fs) {
  const mkdirp = fsx?.mkdirSync;
  if (typeof mkdirp !== 'function') return { allocated: [] }; // injected fs mirror without mkdir
  const created = [];
  for (const dir of [home, state, tmp]) {
    if (!dir) continue;
    try {
      mkdirp.call(fsx, dir, { recursive: true });
      created.push(dir);
    } catch (err) {
      throw refusal(`cannot allocate owned exec root ${dir}: ${err.message}`, TT_EXEC_ESCAPE);
    }
  }
  return { allocated: created };
}

// Persisted trusted allocation receipt (written into campaign state at
// prepare). Later modes revalidate CURRENT dev/ino against THIS receipt —
// not against a fresh capture made in the same invocation — so a replaced
// root cannot be blessed on resume (root defect #3: "Persist trusted
// allocation receipts and revalidate before effects; unresolved ownership is
// UNKNOWN/refusal").
export function persistableExecIdentity(execCtx, { fsx = fs, at = null } = {}) {
  const current = ownershipEvidenceFor(
    { home: execCtx.home_root, state: execCtx.state_root, db: execCtx.db_path, tmp: execCtx.tmp_root },
    fsx,
  );
  return {
    schema_version: execCtx.schema_version ?? EXEC_CONTEXT_SCHEMA_VERSION,
    owner_ref: execCtx.owner_ref ?? null,
    var_root: execCtx.var_root,
    home_root: execCtx.home_root,
    state_root: execCtx.state_root,
    db_path: execCtx.db_path,
    tmp_root: execCtx.tmp_root,
    ownership: current,
    captured_at: at ?? new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────
// S2 (run #56 abort): a PREPARED campaign's exec-identity DB must be created
// by the PRODUCT schema path, fresh, under the campaign's private roots.
// The old prepare captured whatever DB happened to exist at the private path
// — a suite-provisioned hand-rolled `runs` table (no notify_url, user_version
// 9) — and the rehearsal then launched the current product against it,
// dying with `table runs has no column named notify_url`.
//
// provisionProductExecDb is fail-closed:
//   * a pre-existing file at execCtx.db_path is NEVER reused/deleted/rewritten
//     (TT_EXEC_DB_STALE) — the caller must allocate a fresh private root;
//   * a fresh DB is created ONLY by importing the real product getDb() from
//     THIS checkout's absolute dist/db.js under execCtx.child_env (which
//     carries the private HOME/TAMANDUA_STATE_DIR/TAMANDUA_DB_PATH + guard);
//   * a missing/unrunnable product schema module (TT_PRODUCT_DB_UNAVAILABLE)
//     refuses prepare rather than fabricating a hand-rolled schema.
// The returned `receipt` is re-captured AFTER creation so ownership.db
// carries a real dev/ino (the anchor later modes revalidate).
// ─────────────────────────────────────────────────────────────────────
export async function provisionProductExecDb({ execCtx, fsx = fs, spawnProductDb = null } = {}) {
  if (!execCtx?.db_path || !execCtx?.child_env || !execCtx?.home_root) {
    throw refusal('provisionProductExecDb requires a private exec context', TT_EXEC_ESCAPE);
  }
  if (fsx.existsSync(execCtx.db_path)) {
    throw refusal(
      `[${TT_EXEC_DB_STALE}] refusing to reuse a pre-existing exec-identity DB at ${execCtx.db_path}: a prepared campaign's DB must be created fresh by the product schema path (a stale/hand-rolled DB omits product columns such as runs.notify_url) — allocate a fresh private root; never delete or reuse this file`,
      TT_EXEC_DB_STALE,
    );
  }
  // Absolute product schema module (dist/db.js of THIS checkout). Torture code
  // never carries its own CREATE TABLE — the product path is the only schema
  // source.
  const productDbModule = path.join(REPO_ROOT, 'dist', 'db.js');
  if (!fsx.existsSync(productDbModule)) {
    throw refusal(
      `[${TT_PRODUCT_DB_UNAVAILABLE}] product schema module ${productDbModule} is absent — run \`npm run build\` before prepare; the suite never hand-rolls the campaign schema`,
      TT_PRODUCT_DB_UNAVAILABLE,
    );
  }
  const script = `import { getDb } from ${JSON.stringify(productDbModule)}; getDb();`;
  const argv = [process.execPath, '--input-type=module', '-e', script];
  const spawnFn = spawnProductDb ?? ((a, o) => spawnCapture(a, o));
  let result;
  try {
    result = await spawnFn(argv, {
      cwd: execCtx.home_root,
      env: execCtx.child_env,
      mergeParentEnv: false,
      timeoutMs: 120_000,
    });
  } catch (err) {
    throw refusal(
      `[${TT_PRODUCT_DB_UNAVAILABLE}] product schema creation failed to spawn (${String(err?.message ?? err)}) — the campaign DB cannot be provisioned by the product path`,
      TT_PRODUCT_DB_UNAVAILABLE,
    );
  }
  const exitCode = result?.exitCode ?? result?.status ?? null;
  if (exitCode !== 0) {
    const reason = result?.signal ? `signal ${result.signal}` : `exit ${exitCode}`;
    throw refusal(
      `[${TT_PRODUCT_DB_UNAVAILABLE}] product schema creation (getDb from ${productDbModule}) failed: ${reason}: ${String(result?.stderr ?? '').slice(-500)}`,
      TT_PRODUCT_DB_UNAVAILABLE,
    );
  }
  if (!fsx.existsSync(execCtx.db_path)) {
    throw refusal(
      `[${TT_PRODUCT_DB_UNAVAILABLE}] product schema creation reported success but ${execCtx.db_path} was not created — the campaign DB cannot be trusted`,
      TT_PRODUCT_DB_UNAVAILABLE,
    );
  }
  // Re-capture ownership AFTER creation so ownership.db has a real dev/ino.
  return { ok: true, db_path: execCtx.db_path, receipt: persistableExecIdentity(execCtx, { fsx }) };
}

// Revalidate a campaign's persisted allocation receipt against the CURRENT
// filesystem. Refusals: no persisted receipt (campaign prepared before the
// receipt existed) => UNKNOWN/TT_NOT_OWNED with a re-prepare instruction;
// a receipt whose var/home/state/db/tmp paths do not match this context; any
// receipt root whose dev/ino no longer matches (replaced/reused/missing).
export function revalidatePersistedExecIdentity({ execCtx, persisted, fsx = fs }) {
  if (!persisted || typeof persisted !== 'object') {
    throw refusal(
      'campaign carries no persisted exec-identity receipt (prepared before receipts existed) — re-prepare the campaign before real effects; unresolved ownership is refused, never assumed',
      TT_NOT_OWNED,
    );
  }
  for (const [key, p] of Object.entries({
    var_root: execCtx.var_root, home_root: execCtx.home_root, state_root: execCtx.state_root,
    db_path: execCtx.db_path, tmp_root: execCtx.tmp_root,
  })) {
    if (persisted[key] !== p) {
      throw refusal(`exec identity ${key} drifted from the persisted receipt (${JSON.stringify(persisted[key])} != ${p})`, TT_NOT_OWNED);
    }
  }
  const receiptOwnership = persisted.ownership ?? {};
  const changed = [];
  for (const [key, captured] of Object.entries(receiptOwnership)) {
    if (!captured?.path) continue;
    // Roots not-yet-existing at prepare (db FILE before the daemon creates
    // it) carry no identity claim yet — like assertOwnershipUnchanged they
    // are skipped, never treated as a replaced/missing root.
    if (captured.ino === null || captured.ino === undefined) continue;
    let st;
    try {
      st = fsx.statSync(captured.path);
    } catch {
      changed.push({ key, reason: 'missing', expectedIno: captured.ino });
      continue;
    }
    if (st.dev !== captured.dev || st.ino !== captured.ino) {
      changed.push({ key, expectedIno: captured.ino, actualIno: st.ino, reason: 'replaced/reused' });
    }
  }
  if (changed.length > 0) {
    throw refusal(`persisted exec-root identity changed since prepare: ${JSON.stringify(changed)}`, TT_NOT_OWNED);
  }
  return { ok: true };
}

function safeRealpath(p, fsx, label) {
  try {
    return fsx.realpathSync(p);
  } catch {
    // not-yet-existing path (fresh campaign state under var): resolve the
    // nearest existing ancestor so the containment verdict is about where the
    // path WILL live.
    let cur = path.resolve(p);
    const tail = [];
    for (;;) {
      try {
        const real = fsx.realpathSync(cur);
        return path.join(real, ...tail);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return null;
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }
}

export function pathIsWithin(root, candidate) {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Canonical (symlink-free) containment of a path under a root: resolve the
// nearest existing ancestor through realpath and append the missing tail so
// a lexically-nested path whose REAL destination is foreign is refused
// (root defect #3: assertModeContained accepted a lexically nested campaign
// symlink whose real destination was foreign).
export function canonicalPathUnder(root, candidate, fsx = fs) {
  const abs = path.resolve(String(candidate));
  const realRoot = safeRealpath(root, fsx, 'root') ?? path.resolve(root);
  const real = safeRealpath(abs, fsx, 'candidate');
  if (!real || !pathIsWithin(realRoot, real)) {
    throw refusal(`path escapes ${realRoot} via real destination: ${abs}`, TT_EXEC_ESCAPE);
  }
  return abs;
}

// dev/ino ownership evidence for every owned resource root, captured at
// allocation time. A later identity check compares CURRENT dev/ino to these
// to prove the resource was not replaced/reused. Roots captured while
// not-yet-existing carry { dev:null, ino:null, note } — after the issue-D
// allocation fix this only happens for the db FILE (created later by the
// daemon); directory roots are always captured with real identities.
export function ownershipEvidenceFor(paths, fsx = fs) {
  const out = {};
  for (const [key, p] of Object.entries(paths)) {
    if (!p) continue;
    try {
      const st = fsx.statSync(p);
      out[key] = { path: p, dev: st.dev, ino: st.ino, capturedAt: new Date().toISOString() };
    } catch {
      out[key] = { path: p, dev: null, ino: null, capturedAt: new Date().toISOString(), note: 'not-yet-existing at capture (created by an owned allocator later)' };
    }
  }
  return out;
}

// Verify a resource root is still the SAME directory (dev/ino match the
// captured evidence) — refuses a replaced/reused root before any effect.
// Roots captured while not-yet-existing (ino null at allocation) carry no
// identity claim yet and are skipped: there is nothing to have been replaced.
export function assertOwnershipUnchanged(evidence, fsx = fs) {
  const changed = [];
  for (const [key, captured] of Object.entries(evidence ?? {})) {
    if (!captured?.path) continue;
    if (captured.ino === null || captured.ino === undefined) continue; // not-yet-existing at capture: no claim
    let st;
    try {
      st = fsx.statSync(captured.path);
    } catch {
      changed.push({ key, reason: 'missing', expectedIno: captured.ino });
      continue;
    }
    if (st.dev !== captured.dev || st.ino !== captured.ino) {
      changed.push({ key, expectedIno: captured.ino, actualIno: st.ino, expectedDev: captured.dev, actualDev: st.dev, reason: 'replaced/reused' });
    }
  }
  if (changed.length > 0) {
    throw refusal(`owned resource identity changed since allocation: ${JSON.stringify(changed)}`, TT_NOT_OWNED);
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// Mode containment — every tt-storm mode that writes state must pass this
// BEFORE touching state/db/campaign paths (STORM-REAL gap #1: run/resume/
// report/arm previously performed NO containment check before state writes).
// ─────────────────────────────────────────────────────────────────────
export function assertModeContained({ mode, execCtx, campaignDir = null, fsx = fs, persistedOwnership = null }) {
  if (!execCtx?.var_root) {
    throw refusal(`${mode}: no private exec context — real effects require an admitted context`, TT_EXEC_ESCAPE);
  }
  // 1) CURRENT roots must still be the roots this context allocated (fresh
  //    identity captured at construction — after issue D the dirs exist).
  assertOwnershipUnchanged(execCtx.ownership, fsx);
  // 2) When the campaign carries a PERSISTED allocation receipt (prepare-time
  //    identity), revalidate against THAT — a context reconstructed in this
  //    invocation cannot bless a root replaced since prepare (root defect #3).
  if (persistedOwnership) {
    if (persistedOwnership?.ownership && typeof persistedOwnership === 'object') {
      revalidatePersistedExecIdentity({ execCtx, persisted: persistedOwnership, fsx });
    } else {
      throw refusal(`${mode}: persisted exec-identity receipt missing/unusable — re-prepare the campaign; unresolved ownership is refused`, TT_NOT_OWNED);
    }
  }
  // 3) Campaign dir containment is CANONICAL: a lexically nested campaign
  //    whose REAL destination is foreign (symlink escape) is refused.
  if (campaignDir) {
    canonicalPathUnder(execCtx.var_root, campaignDir, fsx);
  }
  return { ok: true, mode, varRoot: execCtx.var_root };
}

// ─────────────────────────────────────────────────────────────────────
// REAL run-scope DB seam (canonicalizing). Thin wrapper over the REAL_DB
// node:sqlite seam that (a) canonicalizes every run key to the stored bare
// uuid before SQL and (b) decorates rows with both identities. Malformed /
// ambiguous / step-scoped keys are refused BEFORE any query.
// ─────────────────────────────────────────────────────────────────────
export function openCanonicalDb(dbPath, { DatabaseSync } = {}) {
  let DBSync = DatabaseSync;
  if (!DBSync) {
    try {
      DBSync = createRequire(import.meta.url)('node:sqlite').DatabaseSync;
    } catch (err) {
      return { ok: false, api: null, error: `node:sqlite unavailable: ${err.message}` };
    }
  }
  let db;
  try {
    db = new DBSync(dbPath, { readOnly: true });
  } catch (err) {
    return { ok: false, api: null, error: `cannot open campaign DB read-only ${dbPath}: ${err.message}` };
  }
  const api = {
    listRuns: () => (db.prepare('SELECT id, workflow_id, status, scheduling_status, created_at, updated_at, tokens_spent, parent_run_id FROM runs ORDER BY created_at').all() ?? []).map((r) => withRunParentIdentity(r)),
    getRun: (runKey) => {
      const parsed = parseRunKey(runKey);
      if (!parsed.ok) throw refusal(`getRun: ${parsed.reason}`, 'TT_BAD_RUN_SCOPE');
      const row = db.prepare('SELECT id, workflow_id, status, scheduling_status, created_at, updated_at, tokens_spent, parent_run_id FROM runs WHERE id = ?').get(parsed.bare);
      return withRunIdentities(row ?? null, { publicId: parsed.public });
    },
    activeStepsForRuns: (runKeys) => {
      if (!Array.isArray(runKeys) || runKeys.length === 0) return [];
      const canonical = runKeys.map((k) => {
        const parsed = parseRunKey(k);
        if (!parsed.ok) throw refusal(`activeStepsForRuns: ${parsed.reason}`, 'TT_BAD_RUN_SCOPE');
        return parsed.bare;
      });
      const ph = canonical.map(() => '?').join(',');
      const rows = db.prepare(`SELECT run_id, status, count(*) AS n FROM steps WHERE run_id IN (${ph}) AND status IN ('claimed','running') GROUP BY run_id, status`).all(...canonical);
      return rows.map((r) => ({ ...r, run_id_public: `run-${String(r.run_id).toLowerCase()}` }));
    },
    // Per-step claimed/running rows — semantics identical to REAL_DB.open's
    // activeStepRows in tt-storm-shared.mjs (both canonicalize run keys to
    // the stored bare uuid; stepIds narrows to product step ids such as
    // 'finalize_merge'/'fix'). Used only by the phase predicates, never by
    // the recording path.
    activeStepRows: (runKeys, { stepIds = null } = {}) => {
      if (!Array.isArray(runKeys) || runKeys.length === 0) return [];
      const canonical = runKeys.map((k) => {
        const parsed = parseRunKey(k);
        if (!parsed.ok) throw refusal(`activeStepRows: ${parsed.reason}`, 'TT_BAD_RUN_SCOPE');
        return parsed.bare;
      });
      const ph = canonical.map(() => '?').join(',');
      // SELECT * (not an explicit column list): the no-op guards (US-008) must
      // read a step row's claim/updated/created clock, but legacy/minimal test
      // schemas carry different timestamp columns. `*` returns whichever
      // columns exist, so a row is never silently dropped for a missing one.
      let sql = `SELECT * FROM steps WHERE run_id IN (${ph}) AND status IN ('claimed','running')`;
      const params = [...canonical];
      if (stepIds !== null) {
        if (!Array.isArray(stepIds) || stepIds.length === 0) {
          throw refusal('activeStepRows: stepIds filter must be a non-empty array or null', 'TT_BAD_STEP_FILTER');
        }
        const sp = stepIds.map(() => '?').join(',');
        sql += ` AND step_id IN (${sp})`;
        params.push(...stepIds);
      }
      const rows = db.prepare(sql).all(...params);
      return rows.map((r) => ({ ...r, run_id_public: `run-${String(r.run_id).toLowerCase()}` }));
    },
    close: () => db.close(),
  };
  return { ok: true, api };
}

// ─────────────────────────────────────────────────────────────────────
// Cleanup inventory — explicit owned resources + positive shutdown evidence.
// cleanupOwned previously accepted an absent handler as success with no
// resource inventory and did not await async cleanup. The real report path
// (rehearsal + campaign) runs runOwnedCleanup: each declared owned resource
// must have a handler that resolves to positive evidence; absent/failed/
// unsettled required cleanup is TT_CLEANUP_NOT_EVIDENCED, never a silent
// PASS. Files/worktrees/state are retained (no-removal policy); "cleanup"
// here means exact process/listener shutdown, not file deletion.
// ─────────────────────────────────────────────────────────────────────
export async function runOwnedCleanup({ execCtx, handlers = {}, inventory = null, fsx = fs, clock = null, resources = null }) {
  const now = () => (clock?.nowUtc ? clock.nowUtc() : new Date().toISOString());
  const ledger = [];
  const failedEntries = [];
  const declared = inventory ?? Object.keys(handlers);
  for (const phase of declared) {
    const entry = { phase, at: now(), ok: false, error: null, evidence: null };
    const handler = handlers[phase];
    if (typeof handler !== 'function') {
      // A DECLARED owned resource with no handler cannot PASS.
      entry.error = `owned cleanup resource '${phase}' has no handler — absent cleanup cannot mean PASS`;
      failedEntries.push(entry);
      ledger.push(entry);
      continue;
    }
    try {
      const res = await handler({ execCtx, fsx, resources });
      // Positive evidence contract (root defect #4 / reviewer): cleanup PASS
      // requires EXPLICIT typed positive settled evidence — a handler result
      // of undefined, {}, false, null, 0, '' or {evidenced:false} can never
      // mean the resource is actually closed. Only { evidenced:true, ... }
      // (or an object explicitly carrying evidenced:true) is accepted.
      const isPositive =
        res !== null && res !== undefined && typeof res === 'object'
        && res.evidenced === true;
      if (!isPositive) {
        const shown = typeof res === 'object' ? JSON.stringify(res) : String(res);
        entry.error = `cleanup handler '${phase}' returned no explicit positive evidence (evidenced:true required), got: ${shown}${typeof res === 'object' && res !== null && res.error ? ` — ${res.error}` : ''}`;
        failedEntries.push(entry);
      } else {
        entry.ok = true;
        entry.evidence = res;
      }
    } catch (err) {
      entry.error = `cleanup handler '${phase}' threw: ${err?.message ?? String(err)}`;
      failedEntries.push(entry);
    }
    ledger.push(entry);
  }
  return { ok: failedEntries.length === 0, failed: failedEntries, ledger };
}

// ─────────────────────────────────────────────────────────────────────
// Real transport seam (mcpTool) + real phase evidence probes. These are the
// REAL implementations the rehearsal gate wires to the contained daemon's
// dashboard + streamable-HTTP MCP endpoint. Before approval they are
// constructible and their refusal paths are exercised by the boundary gate;
// the actual HTTP/MCP calls run only in the approved rehearsal.
// ─────────────────────────────────────────────────────────────────────

// Real dashboard HTTP read (bounded fetch; no 5xx accepted by the caller).
export function makeRealHttpGet({ timeoutMs = 5_000 } = {}) {
  return async (url) => {
    const started = Date.now();
    try {
      const res = await fetch(String(url), { signal: AbortSignal.timeout(timeoutMs) });
      return { ok: res.status < 500, statusCode: res.status, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, statusCode: null, latencyMs: Date.now() - started, error: String(err?.message ?? err) };
    }
  };
}

// Private control-plane read seam (SF-3): a bounded GET + JSON parse used ONLY
// for the campaign's own /control/limits (effective MAX_ACTIVE_TIMERS) and
// /control/jobs (currently scheduled jobs), from which the engine derives a
// numeric freeSlots admission snapshot. `controlUrl` is the campaign's
// bind0-allocated private listener (state.daemon_ports.controlUrl) wired by
// bin/tt-storm; a relative path resolves against it. An absolute target is
// accepted but REFUSED unless loopback — a campaign read can never be pointed
// at a foreign/production host (containment). `secretPath` is the private
// daemon's daemon-secret file (read lazily per request, because the daemon
// only creates it when it starts): when present the x-tamandua-secret header
// is sent so an authenticated private control plane answers. Returns
// { ok, statusCode, body, latencyMs, error }; a non-2xx or non-JSON body is
// ok:false so the caller records an explicit UNKNOWN, never a fabricated
// number.
export function makeRealControlGet({ controlUrl = null, secretPath = null, timeoutMs = 5_000 } = {}) {
  const base = typeof controlUrl === 'string' && controlUrl.length > 0 ? controlUrl.replace(/\/+$/, '') : null;
  const readSecret = () => {
    if (typeof secretPath !== 'string' || secretPath.length === 0) return null;
    try {
      const token = fs.readFileSync(secretPath, 'utf8').trim();
      return token.length > 0 ? token : null;
    } catch {
      return null; // not created yet / unreachable -> unauthenticated probe
    }
  };
  return async (target) => {
    const started = Date.now();
    let raw = String(target ?? '');
    if (raw.length === 0) {
      return { ok: false, statusCode: null, latencyMs: 0, body: null, error: 'control plane GET requires a path/url' };
    }
    if (!/^https?:\/\//i.test(raw)) {
      if (!base) return { ok: false, statusCode: null, latencyMs: 0, body: null, error: 'no private control plane wired for this campaign' };
      raw = `${base}/${raw.replace(/^\/+/, '')}`;
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      return { ok: false, statusCode: null, latencyMs: 0, body: null, error: `control plane GET has an invalid url (${err?.message ?? String(err)})` };
    }
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      return { ok: false, statusCode: null, latencyMs: 0, body: null, error: `control plane GET refused non-loopback host ${host}` };
    }
    const secret = readSecret();
    try {
      const res = await fetch(parsed.toString(), {
        headers: secret ? { 'x-tamandua-secret': secret } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body = null;
      try { body = JSON.parse(text); } catch { body = null; }
      if (res.status >= 200 && res.status < 300 && body && typeof body === 'object') {
        return { ok: true, statusCode: res.status, latencyMs: Date.now() - started, body };
      }
      return {
        ok: false,
        statusCode: res.status,
        latencyMs: Date.now() - started,
        body,
        error: body ? `control plane HTTP ${res.status}` : `control plane response body is not JSON (HTTP ${res.status})`,
      };
    } catch (err) {
      return { ok: false, statusCode: null, latencyMs: Date.now() - started, body: null, error: String(err?.message ?? err) };
    }
  };
}

// Decode a Streamable-HTTP MCP response body. The product's
// StreamableHTTPServerTransport answers `text/event-stream` (SSE frames:
// `event: message` + `data: <json-rpc>`) unless the client opts into JSON, so
// the client MUST read the body as TEXT and decode EITHER an
// application/json body OR the `data:` payload of each SSE frame. Returns
// { ok:true, transport, messages } or { ok:false, transport, error }. A 2xx
// whose body carries no parseable JSON-RPC message is a FAILURE, never a
// fabricated success (attempt-2 finding S7: the endpoint answered SSE while
// the probe called .json(), so every probe failed with 'Unexpected token e').
export function parseMcpStreamableResponseBody(bodyText, contentType = '') {
  const text = bodyText == null ? '' : String(bodyText);
  if (text.trim() === '') return { ok: false, transport: 'empty', error: 'empty response body' };
  const ct = String(contentType ?? '').toLowerCase();
  // SSE bodies begin with a field line (`event:` / `data:` / `id:` / `retry:`),
  // possibly after leading blank/comment lines. `^` with the `m` flag matches
  // any line start. Otherwise treat the body as a single JSON document.
  const looksSse = ct.includes('text/event-stream') || /^(event|data|id|retry)\s*:/m.test(text.replace(/^\uFEFF/, '').trimStart());
  if (!looksSse) {
    try {
      return { ok: true, transport: 'json', messages: [JSON.parse(text)] };
    } catch (err) {
      return { ok: false, transport: 'json', error: `response body is not JSON (${err?.message ?? String(err)})` };
    }
  }
  const messages = [];
  let dataLines = [];
  const flush = () => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join('\n').trim();
    dataLines = [];
    if (payload === '' || payload === '[DONE]') return null;
    try {
      messages.push(JSON.parse(payload));
      return null;
    } catch (err) {
      return err;
    }
  };
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (line === '') {
      const err = flush();
      if (err) return { ok: false, transport: 'sse', error: `malformed SSE data payload (${err?.message ?? String(err)})` };
      continue;
    }
    if (line.startsWith(':')) continue; // SSE comment / keepalive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
  }
  const tailErr = flush();
  if (tailErr) return { ok: false, transport: 'sse', error: `malformed SSE data payload (${tailErr?.message ?? String(tailErr)})` };
  if (messages.length === 0) return { ok: false, transport: 'sse', error: 'SSE response carried no data: JSON-RPC payload' };
  return { ok: true, transport: 'sse', messages };
}

// Choose the JSON-RPC response whose id matches the request. Returns null when
// no message carries that id (a body that only holds unrelated frames is not a
// valid answer to THIS request).
export function selectJsonRpcMessage(messages, id) {
  const list = Array.isArray(messages) ? messages : [];
  return list.find((m) => m && typeof m === 'object' && !Array.isArray(m) && m.id === id) ?? null;
}

// Format an RPC error object into a bounded human-readable string.
function jsonRpcErrorText(error) {
  if (!error || typeof error !== 'object') return JSON.stringify(error);
  const message = error.message ?? error.data ?? JSON.stringify(error);
  return `${error.code != null ? `[${error.code}] ` : ''}${message}`;
}

// Streamable-HTTP MCP tool call. The endpoint is the contained daemon's MCP
// base URL (e.g. http://127.0.0.1:4338/mcp). When no endpoint/tool is
// configured this returns a first-class not-wired result — the pounding
// probe records it as a failure, never as a fabricated success. Tools/call is
// `ok:true` ONLY when the parsed JSON-RPC response carries a genuine result
// (result present and isError !== true); an RPC error or isError:true result
// returns ok:false carrying the error text.
export function makeRealMcpTool({ endpointUrl = null, timeoutMs = 5_000 } = {}) {
  return async ({ tool, args = {}, endpointUrl: perCallEndpoint = null }) => {
    const started = Date.now();
    const endpoint = perCallEndpoint ?? endpointUrl;
    if (!endpoint) {
      return { ok: false, code: 'TT_MCP_TRANSPORT_NOT_WIRED', statusCode: null, latencyMs: 0, error: 'no MCP endpoint configured for this campaign (rehearsal gate wires the contained daemon MCP URL)' };
    }
    if (!tool || typeof tool !== 'string') {
      return { ok: false, code: 'TT_MCP_BAD_TOOL', statusCode: null, latencyMs: 0, error: `MCP tool name required (got ${JSON.stringify(tool)})` };
    }
    try {
      // Streamable-HTTP MCP: initialize -> tools/call. A single POST per
      // message; Accept advertises BOTH application/json and text/event-stream
      // so the server may answer either (the product answers SSE).
      const sessionHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      const init = await fetch(String(endpoint), {
        method: 'POST',
        headers: sessionHeaders,
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'tt-storm-rehearsal', version: '1.0.0' } } }),
      });
      if (!init.ok) {
        return { ok: false, statusCode: init.status, latencyMs: Date.now() - started, error: `MCP initialize HTTP ${init.status}` };
      }
      const initParsed = parseMcpStreamableResponseBody(await init.text(), init.headers.get('content-type'));
      if (!initParsed.ok) {
        return { ok: false, statusCode: init.status, latencyMs: Date.now() - started, error: `MCP initialize response unparseable: ${initParsed.error}` };
      }
      const initMsg = selectJsonRpcMessage(initParsed.messages, 1);
      if (!initMsg) {
        return { ok: false, statusCode: init.status, latencyMs: Date.now() - started, error: 'MCP initialize response carried no JSON-RPC message with id 1' };
      }
      if (initMsg.error) {
        return { ok: false, statusCode: init.status, latencyMs: Date.now() - started, error: `MCP initialize RPC error: ${jsonRpcErrorText(initMsg.error)}` };
      }
      const sessionId = String(init.headers.get('mcp-session-id') ?? initMsg?.result?.sessionId ?? '');
      if (!sessionId) {
        return { ok: false, statusCode: init.status, latencyMs: Date.now() - started, error: 'MCP initialize response carried no mcp-session-id header or result.sessionId (session required for tools/call)' };
      }
      const call = await fetch(String(endpoint), {
        method: 'POST',
        headers: { ...sessionHeaders, 'Mcp-Session-Id': sessionId },
        signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args ?? {} } }),
      });
      if (!call.ok) {
        return { ok: false, statusCode: call.status, latencyMs: Date.now() - started, error: `MCP tools/call HTTP ${call.status}` };
      }
      const callParsed = parseMcpStreamableResponseBody(await call.text(), call.headers.get('content-type'));
      if (!callParsed.ok) {
        return { ok: false, statusCode: call.status, latencyMs: Date.now() - started, error: `MCP tools/call response unparseable: ${callParsed.error}` };
      }
      const callMsg = selectJsonRpcMessage(callParsed.messages, 2);
      if (!callMsg) {
        return { ok: false, statusCode: call.status, latencyMs: Date.now() - started, error: 'MCP tools/call response carried no JSON-RPC message with id 2' };
      }
      const rpcError = callMsg.error ?? null;
      const result = callMsg.result ?? null;
      const resultIsError = result?.isError === true;
      const error = rpcError
        ? `MCP tools/call RPC error: ${jsonRpcErrorText(rpcError)}`
        : (resultIsError
          ? `MCP tool returned isError:true${typeof result?.content?.[0]?.text === 'string' ? `: ${result.content[0].text}` : ''}`
          : (result == null ? 'MCP tools/call response carried no result' : null));
      return {
        ok: !rpcError && !resultIsError && result != null,
        statusCode: call.status,
        latencyMs: Date.now() - started,
        error,
        result,
      };
    } catch (err) {
      return { ok: false, statusCode: null, latencyMs: Date.now() - started, error: String(err?.message ?? err) };
    }
  };
}

// ─────────────────────────────────────────────────────────────────────
// Product merge-event evidence channel (US-004, SF-14/SF-15).
//
// The rugpull and park phases are only REAL when the PRODUCT reacts: the
// merge target moves under a live merge-worktree run (merge.target_moved ->
// relaunch-upon-rugpull) or the park-first managed landing handles a dirty
// target checkout (merge.landed with parking checkoutRefresh). The
// orchestrator's own `tt-chaos` action record (a local colleague commit / a
// dirty tree) is NEVER evidence. This reader is the ONLY source: the private
// product state dir's event JSONL streams, written by src/installer/events.ts
// as `<stateRoot>/events/<bare-uuid>.jsonl` (run-scoped) plus
// `<stateRoot>/events/all.jsonl` (global). The product writes a BARE-uuid
// `runId` while the engine carries the public `run-<uuid>` form, so the run
// scope is canonicalized with parseRunKey before any file/event comparison
// (see readProductMergeEvents).
//
// Returns { ok, targetMoved, landed, parkLanding, error }. A missing/
// unreadable/malformed channel is ok:false with a reason (UNKNOWN upstream),
// never a fabricated empty success. Never throws.
//
// parkLanding is the STRICT park evidence set (SF-15 / NPF-1): a park landing
// is a merge.landed with `noop !== true` AND the product's documented park
// value `checkoutRefresh: "parked:<backup>"` (plus parkedBranch/parkedReason)
// as emitted by the PARK managed landing in src/installer/merge-branch.ts.
// 'refreshed' (refreshed in place) and 'already-coherent' (the no-op landing
// sets it WITHOUT inspecting the checkout) are NOT park evidence, and
// 'not-applicable' (no attached checkout) never is. A merge.target_moved
// counts only through the documented refusal detail (park/dirty/refusal) and
// only when it is not itself `noop: true`.
// ─────────────────────────────────────────────────────────────────────

// The ONLY merge.landed checkoutRefresh value that proves the PARK-FIRST
// managed landing really parked the dirty target checkout is the product's
// `parked:<backup>` (src/installer/merge-branch.ts: the PARK path sets
// `checkoutRefresh = parked:${backupName}` together with parkedBranch +
// parkedReason). 'refreshed' / 'already-coherent' / 'not-applicable' are
// explicitly excluded (the last two are also the no-op shapes).
const PARKING_CHECKOUT_REFRESH_RE = /^parked:.+$/;

// Explicit non-park refresh outcomes. If the product names one of these, the
// event is NOT park evidence even if a stale parked field is also present.
const NON_PARK_CHECKOUT_REFRESH = Object.freeze(['refreshed', 'already-coherent', 'not-applicable']);

// A "documented refusal" to clobber the target checkout: an event carrying
// explicit parking fields, or a park/dirty/refusal diagnostic. A plain
// rugpull `merge.target_moved` (detail: "target ... moved: expected ...")
// carries none of this and is therefore NOT park-landing evidence.
function isParkRefusal(evt) {
  if (!evt || typeof evt !== 'object') return false;
  if (evt.parkedBranch || evt.parkedReason) return true;
  const text = [evt.detail, evt.reason].filter((x) => typeof x === 'string').join(' ');
  return /(park|dirty|local-changes|refus|clobber)/i.test(text);
}

// Strict merge.landed park evidence (NPF-1): the product must have taken a
// REAL action (`noop !== true` — noOpLanding sets 'already-coherent' WITHOUT
// inspecting the checkout) and parked the dirty target checkout via the
// documented `parked:<backup>` value and/or explicit parkedBranch/parkedReason.
// Exported so the evidence validator (tier2-storm-rehearsal-consistency) uses
// the SAME strict predicate as this reader — a landing the reader rejects must
// never satisfy the gate.
export function isLandedParkEvidence(evt) {
  if (!evt || typeof evt !== 'object') return false;
  if (evt.noop === true) return false;
  const refresh = typeof evt.checkoutRefresh === 'string' ? evt.checkoutRefresh : '';
  if (PARKING_CHECKOUT_REFRESH_RE.test(refresh)) return true;
  if (NON_PARK_CHECKOUT_REFRESH.includes(refresh)) return false;
  return Boolean(evt.parkedBranch || evt.parkedReason);
}

// ─────────────────────────────────────────────────────────────────────
// SF-15 (fix-9 US-008) — NO-OP GUARDS for the remaining evidence predicates.
//
// The NPF-1 class fixed for the park landing generalizes: a predicate that
// only asks "does an entry exist?" can be satisfied by a no-op product action
// — a landing that changed nothing, a relaunch record that reuses the
// target's own run id, or a claim observed BEFORE the kill. These pure guards
// name the REAL state transition each predicate requires and reject the no-op
// shape. They are exported so the probe, the audit table and the consistency
// validator share ONE definition.
// ─────────────────────────────────────────────────────────────────────

// A real rugpull replacement/relaunch is a DISTINCT run row, linked by
// parent_run_id to the pulled target, and CREATED AFTER the triggering action
// (B-rugpull) fired. A row that reuses the target's own run id (an alias), is
// unlinked, or predates the action is not recovery evidence. `actionFiredAt`
// is optional so callers without a clock still get the distinctness/linkage
// guard; when present, an unorderable/absent timestamp fails closed.
export function isRelaunchChildRow(child, { parentBare = null, actionFiredAt = null } = {}) {
  if (!child || typeof child !== 'object') return false;
  const parent = parentBare == null ? '' : String(parentBare).trim().toLowerCase();
  if (!parent) return false;
  const childBare = typeof child.run_id_bare === 'string' && child.run_id_bare.trim() !== ''
    ? child.run_id_bare.trim().toLowerCase()
    : (typeof child.id === 'string' ? child.id.trim().toLowerCase() : '');
  if (!childBare) return false;
  if (childBare === parent) return false; // an aliased row is the parent, not a relaunch
  let linkedBare = '';
  if (typeof child.parent_run_id_bare === 'string' && child.parent_run_id_bare.trim() !== '') {
    linkedBare = child.parent_run_id_bare.trim().toLowerCase();
  } else if (child.parent_run_id != null) {
    const parsed = parseRunKey(String(child.parent_run_id));
    linkedBare = parsed.ok ? parsed.bare : String(child.parent_run_id).trim().toLowerCase();
  }
  if (linkedBare !== parent) return false;
  if (actionFiredAt != null && String(actionFiredAt) !== '') {
    const fired = Date.parse(String(actionFiredAt));
    const created = child.created_at == null ? NaN : Date.parse(String(child.created_at));
    if (!Number.isFinite(fired) || !Number.isFinite(created)) return false; // unorderable -> reject
    if (created < fired) return false; // a pre-action row is not post-action recovery
  }
  return true;
}

// A post-kill harness reclaim is a claimed/running step row whose claim stamp
// (claim_updated_at ?? updated_at ?? created_at) is at/after B-kill fired. The
// PRE-kill claim that merely triggered B-kill is never recovery evidence, and
// a row without a usable timestamp cannot prove a post-kill reclaim (unknown
// is never assumed). `actionFiredAt` is required by the caller; without it the
// guard can only prove presence and returns true for a row with an identity.
export function isPostKillReclaimRow(row, { actionFiredAt = null } = {}) {
  if (!row || typeof row !== 'object') return false;
  const hasIdentity = Boolean(row.run_id || row.run_id_bare || row.run_id_public || row.step_id);
  if (!hasIdentity) return false;
  if (actionFiredAt == null || String(actionFiredAt) === '') return true;
  const fired = Date.parse(String(actionFiredAt));
  if (!Number.isFinite(fired)) return false;
  const stamp = row.claim_updated_at ?? row.updated_at ?? row.created_at ?? null;
  if (stamp == null) return false; // no post-kill clock on the row -> cannot prove reclaim
  const claimed = Date.parse(String(stamp));
  if (!Number.isFinite(claimed)) return false;
  return claimed >= fired;
}

// The identical B5 stop/delete/relaunch lineage is real only when the deleted
// B5 record carries NO lineage of its own AND a SEPARATE completed
// 'B5-relaunch' record is linked to it by relaunchOf with a DISTINCT real run
// id. A relaunch record that reuses B5's own run id (the no-op/aliased shape),
// carries no run id, is unlinked, or whose B5 was never deleted is rejected.
export function isB5RelaunchLineage({ b5Record = null, relaunchRecord = null } = {}) {
  if (!b5Record || typeof b5Record !== 'object') return false;
  if (b5Record.terminalStatus !== 'deleted') return false;
  if (b5Record.relaunchOf) return false; // engine shape: the deleted B5 carries no lineage
  if (!relaunchRecord || typeof relaunchRecord !== 'object') return false;
  if (relaunchRecord.rosterId !== 'B5-relaunch') return false;
  if (relaunchRecord.relaunchOf !== 'B5') return false;
  const runId = typeof relaunchRecord.runId === 'string' ? relaunchRecord.runId.trim() : '';
  if (!runId) return false;
  const b5RunId = typeof b5Record.runId === 'string' ? b5Record.runId.trim() : '';
  if (b5RunId && runId === b5RunId) return false; // aliased run id -> no-op, not a relaunch
  if (relaunchRecord.terminalStatus !== 'completed') return false;
  return true;
}

export function readProductMergeEvents({ stateRoot, runIds = null, sinceUtc = null } = {}) {
  const result = { ok: false, targetMoved: [], landed: [], parkLanding: [], error: null };
  if (typeof stateRoot !== 'string' || stateRoot.trim() === '') {
    result.error = 'readProductMergeEvents requires a non-empty stateRoot (the product TAMANDUA_STATE_DIR)';
    return result;
  }
  const eventsDir = path.join(stateRoot, 'events');
  let stat;
  try {
    stat = fs.statSync(eventsDir);
  } catch (err) {
    result.error = `product events dir is missing/unreadable at ${eventsDir}: ${err?.code ?? err?.message ?? err}`;
    return result;
  }
  if (!stat.isDirectory()) {
    result.error = `product events path is not a directory: ${eventsDir}`;
    return result;
  }
  // Canonicalize the run scope at the evidence boundary. The product writes
  // every event with a BARE-uuid `runId` and a run-scoped `<bare>.jsonl` file
  // (src/installer/events.ts), while the engine's state/report renders the
  // same run in the public `run-<uuid>` form. Comparing raw strings therefore
  // silently reads 0 (attempt-8 SF-15 repro: prefixed -> landed 0; bare -> 4).
  // parseRunKey collapses BOTH shapes to the canonical bare uuid. A malformed
  // id (a `step-...` or garbage token) never matches (fail closed, no throw).
  // An explicit runIds list scopes the read; null/undefined keeps the old
  // "no scope" behavior, and an explicit empty list matches nothing.
  const scoped = Array.isArray(runIds);
  const wantedBare = new Set();
  if (scoped) {
    for (const raw of runIds) {
      const parsed = parseRunKey(raw == null ? '' : String(raw));
      if (parsed.ok) wantedBare.add(parsed.bare);
    }
  }
  let sinceMs = null;
  if (sinceUtc != null && String(sinceUtc) !== '') {
    sinceMs = Date.parse(String(sinceUtc));
    if (!Number.isFinite(sinceMs)) {
      result.error = `readProductMergeEvents received an unparseable sinceUtc: ${String(sinceUtc)}`;
      return result;
    }
  }
  const seen = new Set();
  const readJsonl = (file) => {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return []; // a run with no events yet is not an error
      throw new Error(`product events file unreadable at ${file}: ${err?.code ?? err?.message ?? err}`);
    }
    const events = [];
    const lines = String(raw).split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === '') continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch (err) {
        throw new Error(`malformed product event JSONL at ${file}:${i + 1}: ${err?.message ?? err}`);
      }
      if (!evt || typeof evt !== 'object' || Array.isArray(evt)) {
        throw new Error(`malformed product event (not an object) at ${file}:${i + 1}`);
      }
      events.push(evt);
    }
    return events;
  };
  const consider = (evt) => {
    if (scoped) {
      const rid = evt.runId != null ? String(evt.runId) : '';
      const parsed = parseRunKey(rid);
      // Canonical bare-id comparison: a bare product runId and a prefixed
      // state runId for the same run are equivalent; anything unparseable
      // (or a foreign run) is excluded. evt.runId itself is left untouched.
      if (!parsed.ok || !wantedBare.has(parsed.bare)) return;
    }
    if (sinceMs != null) {
      const tsMs = Date.parse(String(evt.ts ?? ''));
      if (!Number.isFinite(tsMs) || tsMs < sinceMs) return;
    }
    const kind = evt.event;
    if (kind !== 'merge.target_moved' && kind !== 'merge.landed') return;
    const key = [kind, String(evt.runId ?? ''), String(evt.ts ?? ''), String(evt.mergedCommit ?? evt.actualTip ?? ''), String(evt.checkoutRefresh ?? '')].join('\u0000');
    if (seen.has(key)) return;
    seen.add(key);
    if (kind === 'merge.target_moved') {
      result.targetMoved.push(evt);
      // A moved target is a documented refusal to clobber the ref the park
      // disturbed — but only count it as PARK evidence when it carries a
      // park/dirty/refusal detail (a plain rugpull tip-move is not) AND it is
      // not itself a no-op.
      if (evt.noop !== true && isParkRefusal(evt)) result.parkLanding.push(evt);
      return;
    }
    result.landed.push(evt);
    // STRICT: only a non-noop merge.landed that parked the dirty checkout
    // (product `parked:<backup>` / explicit parkedBranch+parkedReason) counts.
    if (isLandedParkEvidence(evt)) result.parkLanding.push(evt);
  };

  try {
    // Run-scoped streams first. The product writes each event to BOTH the
    // run-scoped file and all.jsonl; the dedup key keeps each physical event
    // exactly once even when both streams carry it. The documented product
    // filename is `<bare>.jsonl`; the older synthetic `run-<bare>.jsonl`
    // shape is tolerated as a compatibility fallback.
    if (scoped) {
      for (const bare of wantedBare) {
        for (const file of [`${bare}.jsonl`, `run-${bare}.jsonl`]) {
          for (const evt of readJsonl(path.join(eventsDir, file))) consider(evt);
        }
      }
    }
    for (const evt of readJsonl(path.join(eventsDir, 'all.jsonl'))) consider(evt);
  } catch (err) {
    result.ok = false;
    result.targetMoved = [];
    result.landed = [];
    result.parkLanding = [];
    result.error = String(err?.message ?? err);
    return result;
  }
  result.ok = true;
  return result;
}

// Real phase predicates from mechanical evidence. probePhaseMarker's default
// was `return false`; the real orchestrator must decide from DB/event/ref
// evidence, not from a recorded "satisfied". Each predicate takes the
// campaign DB api (canonicalizing) + the phase and returns { satisfied,
// evidence, reason }. Evidence-unreadable => { satisfied:false, reason:
// 'evidence UNKNOWN...' } — never a fabricated true.
// Product step ids used by the merge-worktree workflows (read from the
// bundled workflows; torture-owned constants, never patched into product).
export const FINALIZE_STEP_IDS = Object.freeze(['finalize_merge']);

// Round B merge targets whose DB/ref evidence the phase predicates read.
const MERGE_TARGET_IDS = ['B1', 'B2', 'B3', 'B4'];

// Real phase predicates from mechanical evidence. probePhaseMarker's default
// was `return false`; the real orchestrator must decide from DB/event/ref
// evidence, not from a recorded "satisfied" (reviewer issue E / root defect
// #6: a single active setup step or an unrelated prior fired phase must never
// satisfy B1-B4 pre-finalize, pause ack, conflict area, landing or recovery).
//
// Outcomes: marker_satisfied | not_yet | evidence_error. not_yet means the
// evidence CHANNEL is healthy but the observed condition has not materialized
// yet (keep polling); evidence_error means the evidence SOURCE itself is
// unavailable/UNKNOWN (never fabricated, reported as UNKNOWN upstream).
//
// Evidence sources (all mechanical, never an orchestrator "recorded
// satisfied"):
//   * campaign DB rows (canonicalizing seam): run rows (status /
//     scheduling_status / workflow_id / parent_run_id), claimed/running step
//     rows optionally narrowed to product step ids;
//   * `refs` channel (optional): real git ref reads on the orchestrator-owned
//     fixture repos (origin main head before/after a colleague commit). When
//     a marker requires refs and no channel is configured, the result is
//     evidence_error UNKNOWN naming the missing native interface.
export async function probePhaseMarkerReal({ dbOpen, dbPath, state, ph, refs = null, stateRoot = null }) {
  const marker = ph?.waitFor?.marker ?? ph?.waitFor?.kind ?? null;
  if (!marker || ph?.waitFor?.kind === 'none') {
    return { satisfied: true, outcome: 'marker_satisfied', marker, evidence: 'no evidence gate (kind none)' };
  }
  let opened;
  try {
    opened = dbOpen(dbPath);
  } catch {
    return { satisfied: false, outcome: 'evidence_error', marker, reason: 'cannot open campaign DB for phase evidence (UNKNOWN, never assumed)' };
  }
  if (!opened?.ok) {
    return { satisfied: false, outcome: 'evidence_error', marker, reason: opened?.error ?? 'db open failed' };
  }
  const mk = (satisfied, outcome, extra = {}) => ({ satisfied, outcome, marker, ...extra });
  const runOf = (rid) => state?.rounds?.B?.runs?.[rid]?.runId ?? null;
  const bMergeTargets = () => MERGE_TARGET_IDS
    .filter((rid) => runOf(rid))
    .map((rid) => ({ rid, runId: runOf(rid) }));
  const rowOf = (runId) => {
    if (!runId) return null;
    const parsed = parseRunKey(runId);
    if (!parsed.ok) return null;
    try { return opened.api.getRun(runId); } catch { return null; }
  };
  const activeRows = async (runId, { stepIds = null } = {}) => {
    if (!runId || typeof opened.api.activeStepRows !== 'function') return [];
    try { return opened.api.activeStepRows([runId], { stepIds }); } catch { return []; }
  };
  const allRows = () => {
    try { return opened.api.listRuns() ?? []; } catch { return null; }
  };
  const readRef = async (repo, ref) => {
    if (!refs || typeof refs.readRef !== 'function') return null;
    try { return await refs.readRef(repo, ref); } catch { return null; }
  };

  try {
    switch (marker) {
      case 'round-b-launches-registered': {
        const all = (allRows() ?? []).filter((r) => r.run_id_bare);
        const bIds = Object.values(state?.rounds?.B?.runs ?? {}).map((r) => r?.runId).filter(Boolean);
        const found = bIds.filter((id) => parseRunKey(id).ok && all.some((r) => r.run_id_bare === parseRunKey(id).bare));
        const satisfied = bIds.length > 0 && found.length === bIds.length;
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', { evidence: `round B registered ${found.length}/${bIds.length} in DB` });
      }
      case 'B3 mid-flight step claimed':
      case 'B4 harness claim recorded': {
        const target = marker.startsWith('B3') ? 'B3' : 'B4';
        const targetId = runOf(target);
        if (!targetId) return mk(false, 'not_yet', { reason: `target ${target} run not launched yet` });
        const rows = await activeRows(targetId);
        const satisfied = rows.length > 0;
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', { evidence: `target ${target} (${targetId}) has ${rows.length} claimed/running DB step row(s)` });
      }
      case 'B4 post-kill harness reclaim': {
        // US-008 no-op guard: kill RECOVERY is only observed when B4 shows a
        // claimed/running step row STAMPED AT/AFTER B-kill fired — the pre-kill
        // claim that merely triggered the kill is never recovery. A row with no
        // usable post-kill clock fails closed (UNKNOWN is never assumed).
        const killPhase = state?.rounds?.B?.phases?.['B-kill'];
        if (killPhase?.status !== 'fired' || !killPhase.firedAt) {
          return mk(false, 'not_yet', { evidence: 'B-kill not dispatched yet' });
        }
        const targetId = runOf('B4');
        if (!targetId) return mk(false, 'not_yet', { reason: 'target B4 run not launched yet' });
        const rows = await activeRows(targetId);
        const satisfied = rows.some((r) => isPostKillReclaimRow(r, { actionFiredAt: killPhase.firedAt }));
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', {
          evidence: satisfied
            ? `target B4 (${targetId}) shows a post-kill claimed/running step row (reclaim after B-kill fired)`
            : `target B4 (${targetId}) shows no post-kill reclaim; only pre-kill/no claim rows (kill recovery not observed)`,
        });
      }
      case 'finalize claim for a Round B merge run': {
        const hits = [];
        for (const { rid, runId } of bMergeTargets()) {
          const rows = await activeRows(runId, { stepIds: FINALIZE_STEP_IDS });
          if (rows.length > 0) hits.push(rid);
        }
        const satisfied = hits.length > 0;
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', {
          evidence: satisfied
            ? `finalize_merge claimed/running on: ${hits.join(',')}`
            : 'no Round B merge run has a claimed/running finalize_merge step yet',
        });
      }
      case 'B1-B4 pre-finalize': {
        // mass_rugpull may fire ONLY while EVERY merge target (B1..B4) is
        // mid-flight and NONE has reached finalize (root defect #6: one
        // active setup step can never stand in for four pre-finalize claims).
        const missing = [];
        const terminal = [];
        const idle = [];
        const finalizing = [];
        for (const { rid, runId } of bMergeTargets()) {
          if (!runId) { missing.push(rid); continue; }
          const row = rowOf(runId);
          if (!row) { missing.push(rid); continue; }
          if (TERMINAL_RUN_STATUSES.includes(row.status)) { terminal.push(rid); continue; }
          const active = await activeRows(runId);
          if (active.length === 0) { idle.push(rid); continue; }
          const fin = await activeRows(runId, { stepIds: FINALIZE_STEP_IDS });
          if (fin.length > 0) { finalizing.push(rid); }
        }
        const satisfied = missing.length === 0 && terminal.length === 0 && idle.length === 0 && finalizing.length === 0;
        if (satisfied) {
          return mk(true, 'marker_satisfied', { evidence: 'B1..B4 all non-terminal with active claimed/running steps and none at finalize_merge (mass-rugpull window open)' });
        }
        const why = [
          missing.length ? `not launched/missing row: ${missing.join(',')}` : null,
          terminal.length ? `already terminal: ${terminal.join(',')}` : null,
          idle.length ? `no active step yet: ${idle.join(',')}` : null,
          finalizing.length ? `already at finalize_merge: ${finalizing.join(',')}` : null,
        ].filter(Boolean).join('; ');
        return mk(false, 'not_yet', { evidence: `B1-B4 pre-finalize not satisfied — ${why}` });
      }
      case 'other-four-mid-flight': {
        // stop_delete_relaunch on B5 requires the OTHER four (B1..B4) to be
        // genuinely mid-flight (each non-terminal with an active claim).
        const notMid = [];
        for (const { rid, runId } of bMergeTargets()) {
          if (!runId) { notMid.push(`${rid}:not-launched`); continue; }
          const row = rowOf(runId);
          if (!row || TERMINAL_RUN_STATUSES.includes(row?.status)) { notMid.push(`${rid}:not-mid-flight`); continue; }
          const active = await activeRows(runId);
          if (active.length === 0) notMid.push(`${rid}:no-active-step`);
        }
        const satisfied = notMid.length === 0;
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', {
          evidence: satisfied ? 'B1..B4 all non-terminal with active claimed/running steps' : `not all four mid-flight: ${notMid.join(', ')}`,
        });
      }
      case 'B5 relaunch lineage': {
        // US-008 no-op guard: the identical stop/delete/relaunch is a real
        // transition only as a SEPARATE completed 'B5-relaunch' record linked
        // to the terminal-DELETED B5 by relaunchOf with a DISTINCT real run id.
        // A record that reuses B5's own run id is a no-op/alias, not a relaunch.
        const stopdel = state?.rounds?.B?.phases?.['B-stopdel'];
        if (stopdel?.status !== 'fired') {
          return mk(false, 'not_yet', { evidence: 'B-stopdel (stop/delete/relaunch B5) not dispatched yet' });
        }
        const b5 = state?.rounds?.B?.runs?.['B5'] ?? null;
        const relaunch = state?.rounds?.B?.runs?.['B5-relaunch'] ?? null;
        const satisfied = isB5RelaunchLineage({ b5Record: b5, relaunchRecord: relaunch });
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', {
          evidence: satisfied
            ? 'deleted B5 plus a distinct completed B5-relaunch record linked by relaunchOf (identical relaunch observed)'
            : 'no real B5-relaunch lineage: a distinct completed parent-linked B5-relaunch record is required (an aliased/no-run-id record is not evidence)',
        });
      }
      case 'pause-b3-acked': {
        // The daemon ACKs a pause by persisting status/scheduling_status
        // 'paused' on the run row (product control-server). A row that is
        // merely running is not an ack; a pause that was never dispatched is
        // not_yet, never satisfied by an unrelated fired phase.
        const pausePhase = state?.rounds?.B?.phases?.['B-pause'];
        const fired = pausePhase?.status === 'fired';
        if (!fired) return mk(false, 'not_yet', { evidence: 'B-pause phase not dispatched yet' });
        const targetId = runOf('B3');
        if (!targetId) return mk(false, 'not_yet', { evidence: 'B3 not launched' });
        const row = rowOf(targetId);
        if (!row) return mk(false, 'not_yet', { evidence: `B3 row ${targetId} missing from campaign DB` });
        const paused = row.status === 'paused' || row.scheduling_status === 'paused';
        return mk(paused, paused ? 'marker_satisfied' : 'not_yet', {
          evidence: paused ? `B3 ${targetId} row status=paused (daemon ack persisted)` : `B3 ${targetId} row status=${row.status} — daemon pause ack not observed yet`,
        });
      }
      case 'b3-fix-area-known': {
        // Same-line fix area known = B3's bug-fix run has a claimed/running
        // 'fix' step (bfmw workflow fix step) AND the campaign owns the cc2
        // colleague file identity the same-line commit will touch. An
        // unrelated active step / fired phase is never sufficient.
        const targetId = runOf('B3');
        if (!targetId) return mk(false, 'not_yet', { evidence: 'B3 not launched' });
        const fixRows = await activeRows(targetId, { stepIds: ['fix'] });
        const cc2File = state?.plan?.fixtureIdentity?.cc2File ?? null;
        if (!cc2File) return mk(false, 'not_yet', { evidence: 'campaign does not own a cc2File fixture identity — same-line area undefined' });
        const satisfied = fixRows.length > 0;
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', {
          evidence: satisfied
            ? `B3 ${targetId} has a claimed/running fix step (cc2 file ${cc2File})`
            : `B3 ${targetId} fix step not claimed yet (cc2 file ${cc2File})`,
        });
      }
      case 'cc1-landed': {
        // Landing = mechanical REF evidence: origin main's current head
        // differs from the head captured immediately BEFORE B-cc1 dispatched
        // (the colleague commit landed). Requires the refs channel; absent
        // channel / unreadable ref is evidence_error UNKNOWN.
        if (!refs || typeof refs.readRef !== 'function' || !refs.originRepo) {
          return mk(false, 'evidence_error', { reason: 'cc1-landed needs a real git ref channel (origin repo) — not available; UNKNOWN, never assumed' });
        }
        const before = state?.rounds?.B?.phases?.['B-cc1']?.refs?.originMainBefore ?? null;
        if (!before?.sha) return mk(false, 'not_yet', { evidence: 'B-cc1 not dispatched yet / no pre-commit origin-main snapshot recorded' });
        const cur = await readRef(refs.originRepo, 'refs/heads/main');
        if (!cur || !cur.ok || !cur.sha) {
          return mk(false, 'evidence_error', { reason: `origin main ref unreadable: ${cur?.error ?? 'no ref channel result'}` });
        }
        const satisfied = cur.sha !== before.sha;
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', {
          evidence: satisfied
            ? `origin main advanced ${before.sha.slice(0, 12)} -> ${cur.sha.slice(0, 12)} (cc1 landed)`
            : `origin main still ${cur.sha.slice(0, 12)} — cc1 landing not observed`,
        });
      }
      case 'rugpull-recovered': {
        // Recovery = mechanical DB evidence: for every mass-rugpull target
        // (B1..B4) a run row exists AND at least one DISTINCT, parent-linked
        // replacement run row CREATED AT/AFTER B-rugpull fired exists in the
        // campaign DB — the same parent/child evidence the engine's own
        // harvest uses. Merely having fired B-rugpull, an unrelated phase, a
        // pre-existing child, or a row that aliases the target's own run id is
        // never recovery (US-008 no-op guard: isRelaunchChildRow).
        const rugPhase = state?.rounds?.B?.phases?.['B-rugpull'];
        const fired = rugPhase?.status === 'fired';
        if (!fired) return mk(false, 'not_yet', { evidence: 'mass rugpull (B-rugpull) not dispatched yet' });
        const all = allRows();
        if (!all) return mk(false, 'evidence_error', { reason: 'campaign DB unreadable for rugpull recovery evidence (UNKNOWN)' });
        const parentBare = (runId) => { const p = parseRunKey(runId); return p.ok ? p.bare : null; };
        const pending = [];
        for (const { rid, runId } of bMergeTargets()) {
          if (!runId) { pending.push(`${rid}:not-launched`); continue; }
          const bare = parentBare(runId);
          const row = all.find((r) => r.run_id_bare === bare);
          if (!row) { pending.push(`${rid}:row-missing`); continue; }
          const children = all.filter((r) => isRelaunchChildRow(r, { parentBare: bare, actionFiredAt: rugPhase.firedAt ?? null }));
          if (children.length === 0) { pending.push(`${rid}:no-post-action-child-run`); }
        }
        const satisfied = pending.length === 0;
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', {
          evidence: satisfied
            ? 'every rugpull target has a distinct post-action child/replacement run row in the campaign DB (recovery relaunch observed)'
            : `recovery not yet observed: ${pending.join(', ')}`,
        });
      }
      case 'rugpull-observed': {
        // SF-14 (US-004): the mass-rugpull is OBSERVED only when the PRODUCT
        // emitted a real merge.target_moved event for one of the targeted
        // merge runs at/after the B-rugpull phase fired. A local colleague
        // commit (the orchestrator's own action) is never evidence.
        const rugPhase = state?.rounds?.B?.phases?.['B-rugpull'];
        if (rugPhase?.status !== 'fired' || !rugPhase.firedAt) {
          return mk(false, 'not_yet', { evidence: 'mass rugpull (B-rugpull) not dispatched yet' });
        }
        const targeted = bMergeTargets().map((t) => t.runId).filter(Boolean);
        const root = stateRoot ?? state?.exec_identity?.state_root ?? null;
        const read = readProductMergeEvents({ stateRoot: root, runIds: targeted, sinceUtc: rugPhase.firedAt });
        if (!read.ok) {
          return mk(false, 'evidence_error', {
            reason: `product merge-event channel unavailable for rugpull: ${read.error}`,
            productEvidence: read,
          });
        }
        const satisfied = read.targetMoved.length > 0;
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', {
          evidence: satisfied
            ? `product merge.target_moved observed for targeted run(s) after B-rugpull fired (${read.targetMoved.length} event(s))`
            : 'no product merge.target_moved event observed after B-rugpull fired (a local commit alone is not evidence)',
          productEvidence: read,
        });
      }
      case 'park-landed': {
        // SF-15 (US-004, tightened by US-005): the PARK landing is OBSERVED
        // only from a STRICT product park event — a non-noop merge.landed with
        // the documented `checkoutRefresh: "parked:<backup>"` (and/or explicit
        // parkedBranch/parkedReason), or the documented park/dirty/refusal
        // detail. A dirty-tree action alone, a mere 'refreshed'/'already-
        // coherent'/'not-applicable' landing, or a noop:true event is NEVER
        // evidence (NPF-1).
        const parkPhase = state?.rounds?.B?.phases?.['B-park'];
        if (parkPhase?.status !== 'fired' || !parkPhase.firedAt) {
          return mk(false, 'not_yet', { evidence: 'B-park not dispatched yet' });
        }
        const targeted = bMergeTargets().map((t) => t.runId).filter(Boolean);
        const root = stateRoot ?? state?.exec_identity?.state_root ?? null;
        const read = readProductMergeEvents({ stateRoot: root, runIds: targeted, sinceUtc: parkPhase.firedAt });
        if (!read.ok) {
          return mk(false, 'evidence_error', {
            reason: `product merge-event channel unavailable for park landing: ${read.error}`,
            productEvidence: read,
          });
        }
        const satisfied = read.parkLanding.length > 0;
        return mk(satisfied, satisfied ? 'marker_satisfied' : 'not_yet', {
          evidence: satisfied
            ? `product park-landing evidence observed for targeted run(s) after B-park fired (${read.parkLanding.length} event(s))`
            : 'no non-noop parked product landing observed after B-park fired (a dirty tree alone, or an already-coherent/refreshed/noop landing, is not evidence)',
          productEvidence: read,
        });
      }
      default:
        return mk(false, 'evidence_error', { reason: `no real phase predicate for marker ${marker} (UNKNOWN)` });
    }
  } finally {
    try { opened.api.close?.(); } catch { /* ignore */ }
  }
}

// ─────────────────────────────────────────────────────────────────────
// EVIDENCE PREDICATE AUDIT (US-006 requirement 3).
//
// Attempt 8 found two failure classes in the phase-evidence gate that made a
// red campaign look green:
//   (1) id-shape assumptions — a predicate compared the engine's PREFIXED
//       `run-<uuid>` state ids against the PRODUCT's BARE `<uuid>` event ids,
//       so `readProductMergeEvents` silently read 0 (SF-15); and
//   (2) fixture-only-green paths — a synthetic fixture was built from the
//       engine's own state shape (matching ids on BOTH sides) instead of real
//       product output, so the mismatch above was invisible.
//
// This table is the mechanical audit: one row per marker handled by
// `probePhaseMarkerReal`, classifying the evidence source and naming the
// fixture that pins it. The evidence classes are:
//   * 'db'             — campaign-DB rows read through the dbOpen seam
//                        (getRun / listRuns / activeStepRows);
//   * 'refs'           — real git ref reads through the refs seam;
//   * 'product-events' — the product event channel (readProductMergeEvents).
//
// US-008 (fix-9 requirement 3) adds `noopGuard` to EVERY row: the REAL state
// transition the predicate requires (`realTransition`) and the no-op or
// fabricated shape it must reject (`noopRejected`). This closes the NPF-1
// class (a predicate satisfied by an action that changed nothing) across the
// remaining product-evidence/db predicates; the guards are the shared, pure
// `isRelaunchChildRow` / `isPostKillReclaimRow` / `isB5RelaunchLineage`
// helpers plus the existing `isLandedParkEvidence`.
//
// `idShapeAssumption` is 'canonical' for every predicate: no predicate may
// compare a raw prefixed state id against a raw event id. Product-evidence
// entries canonicalize both sides with `parseRunKey` at the reader boundary;
// DB entries compare `run_id_bare`/`parent_run_id_bare` (withRunIdentities).
// The audit is exercised by
// torture-test/self-tests/tier2-storm-rehearsal-evidence-audit.test.ts, which
// also parses the switch cases out of this module so a NEW marker cannot slip
// in un-audited, and by
// torture-test/self-tests/tier2-storm-rehearsal-noop-evidence.test.ts, which
// pins the positive/negative verdict of each guard.
// ─────────────────────────────────────────────────────────────────────
// US-008: one frozen no-op guard per audited predicate. `realTransition`
// names the REAL state transition the predicate requires; `noopRejected`
// names the no-op/fabricated shape it must reject. Every audit row carries
// one, and the audit self-tests require both to be non-empty.
function noopGuard(realTransition, noopRejected) {
  return Object.freeze({ realTransition, noopRejected });
}

export const EVIDENCE_PREDICATE_AUDIT = Object.freeze([
  Object.freeze({
    marker: 'round-b-launches-registered',
    evidenceClass: 'db',
    fixtureSource: 'mechanical campaign-DB rows: listRuns() rows carrying run_id_bare (fake dbOpen seam)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      'each B1..B5 launch is registered as a real campaign-DB run row carrying its own bare run id',
      'a state-only registration with no DB row, or duplicated/aliased rows standing in for distinct launches',
    ),
  }),
  Object.freeze({
    marker: 'B3 mid-flight step claimed',
    evidenceClass: 'db',
    fixtureSource: "mechanical campaign-DB rows: activeStepRows([B3 runId]) rows (fake dbOpen seam)",
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      "B3's OWN run has a claimed/running step row (real mid-flight claim)",
      "a claim on any other run, or a terminal/idle B3 with no active step",
    ),
  }),
  Object.freeze({
    marker: 'B4 harness claim recorded',
    evidenceClass: 'db',
    fixtureSource: "mechanical campaign-DB rows: activeStepRows([B4 runId]) rows (fake dbOpen seam)",
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      "B4's OWN run has a claimed/running step row (the pre-kill claim that gates B-kill)",
      "a claim on any other run, or a B4 row with no active claimed/running step",
    ),
  }),
  Object.freeze({
    marker: 'finalize claim for a Round B merge run',
    evidenceClass: 'db',
    fixtureSource: 'mechanical campaign-DB rows: activeStepRows(B1..B4, stepIds finalize_merge) rows (fake dbOpen seam)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      'at least one B1..B4 merge run has a claimed/running finalize_merge step',
      'an active step on any other run/step id, or an unclaimed/finished merge run',
    ),
  }),
  Object.freeze({
    marker: 'B1-B4 pre-finalize',
    evidenceClass: 'db',
    fixtureSource: 'mechanical campaign-DB rows: getRun + activeStepRows for B1..B4 (fake dbOpen seam)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      'ALL FOUR B1..B4 are non-terminal with active claimed/running steps and NONE is at finalize_merge',
      'one active setup step standing in for four, or a terminal/finalizing target closing the window',
    ),
  }),
  Object.freeze({
    marker: 'other-four-mid-flight',
    evidenceClass: 'db',
    fixtureSource: 'mechanical campaign-DB rows: getRun + activeStepRows for B1..B4 (fake dbOpen seam)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      'all four B1..B4 are non-terminal, each with its own active claim',
      'a fired phase alone, or a single/terminal run standing in for the four',
    ),
  }),
  Object.freeze({
    marker: 'pause-b3-acked',
    evidenceClass: 'db',
    fixtureSource: 'mechanical campaign-DB row: getRun(B3) status/scheduling_status + state B-pause fired (fake dbOpen seam)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      "B3's row persisted status/scheduling_status 'paused' after B-pause fired (daemon ack)",
      'a merely running row, or an unrelated fired phase with no persisted pause ack',
    ),
  }),
  Object.freeze({
    marker: 'b3-fix-area-known',
    evidenceClass: 'db',
    fixtureSource: 'mechanical campaign-DB rows: activeStepRows(B3, stepIds fix) + plan.fixtureIdentity.cc2File (fake dbOpen seam)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      "B3's bug-fix run has a claimed/running 'fix' step AND the campaign owns the cc2 file identity",
      'an unrelated active step, or a missing cc2 fixture identity (same-line area undefined)',
    ),
  }),
  Object.freeze({
    marker: 'cc1-landed',
    evidenceClass: 'refs',
    fixtureSource: 'mechanical git ref reads: readRef(originRepo, refs/heads/main) + state B-cc1 refs.originMainBefore (refs seam)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      'origin refs/heads/main sha DIFFERS from the pre-B-cc1 snapshot (a real landing)',
      'an unchanged ref (a local colleague commit or a fired phase alone is not a landing)',
    ),
  }),
  Object.freeze({
    marker: 'rugpull-recovered',
    evidenceClass: 'db',
    fixtureSource: 'mechanical campaign-DB rows: listRuns() parent_run_id_bare child rows for B1..B4 (fake dbOpen seam)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      'each B1..B4 has a DISTINCT child/replacement run row linked by parent_run_id and CREATED AT/AFTER B-rugpull fired (isRelaunchChildRow)',
      'a pre-existing child row, a row that aliases the target run id, an unlinked row, or the B-rugpull action alone',
    ),
  }),
  Object.freeze({
    marker: 'rugpull-observed',
    evidenceClass: 'product-events',
    fixtureSource: 'real-product-shaped events dir: bare event runId in <bare>.jsonl + all.jsonl (merge.target_moved line)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      "the PRODUCT emitted merge.target_moved for a targeted run at/after B-rugpull fired (the owned origin ref really advanced)",
      "a local colleague commit, a noop:true target_moved, or an event for a non-targeted run",
    ),
  }),
  Object.freeze({
    marker: 'park-landed',
    evidenceClass: 'product-events',
    fixtureSource: 'real-product-shaped events dir: bare event runId in <bare>.jsonl + all.jsonl (merge.landed parking checkoutRefresh line)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      "the PRODUCT emitted a NON-NOOP parked merge.landed (checkoutRefresh 'parked:<backup>' and/or parkedBranch/parkedReason) (isLandedParkEvidence)",
      "a noop:true / already-coherent / refreshed / not-applicable landing (attempt-9 NPF-1)",
    ),
  }),
  Object.freeze({
    marker: 'B4 post-kill harness reclaim',
    evidenceClass: 'db',
    fixtureSource: 'mechanical campaign-DB rows: activeStepRows([B4 runId]) claim rows carrying a post-kill claim/updated clock (fake dbOpen seam)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      'a B4 claimed/running step row stamped AT/AFTER B-kill firedAt (isPostKillReclaimRow)',
      'the PRE-kill claim that merely triggered B-kill, or a row with no usable post-kill clock',
    ),
  }),
  Object.freeze({
    marker: 'B5 relaunch lineage',
    evidenceClass: 'db',
    fixtureSource: 'mechanical campaign-DB/state rows: terminal-deleted B5 + a separate completed B5-relaunch record linked by relaunchOf (isB5RelaunchLineage)',
    idShapeAssumption: 'canonical',
    noopGuard: noopGuard(
      'a terminal-DELETED B5 with NO lineage of its own PLUS a separate COMPLETED B5-relaunch record linked by relaunchOf with a DISTINCT real run id (isB5RelaunchLineage)',
      "a relaunch record reusing B5's own run id (aliased), missing a run id, unlinked, not completed, or B5 never deleted",
    ),
  }),
]);

// JSON-serializable projection of the audit, so the fix8 readiness artifact
// (US-009) can record the US-006 result without re-deriving it. Pure: no I/O,
// no daemon, no ports.
export function summarizeEvidencePredicateAudit() {
  const seen = new Set();
  const duplicates = [];
  const evidenceClasses = {};
  for (const entry of EVIDENCE_PREDICATE_AUDIT) {
    if (seen.has(entry.marker)) duplicates.push(entry.marker);
    seen.add(entry.marker);
    evidenceClasses[entry.evidenceClass] = (evidenceClasses[entry.evidenceClass] ?? 0) + 1;
  }
  const productEvidenceMarkers = EVIDENCE_PREDICATE_AUDIT
    .filter((entry) => entry.evidenceClass === 'product-events')
    .map((entry) => entry.marker);
  // US-008: every audited predicate must carry a non-empty no-op guard; the
  // readiness artifact records this boolean so a missing guard is visible.
  const noopGuarded = EVIDENCE_PREDICATE_AUDIT.every(
    (entry) =>
      entry.noopGuard &&
      typeof entry.noopGuard.realTransition === 'string' &&
      entry.noopGuard.realTransition.trim() !== '' &&
      typeof entry.noopGuard.noopRejected === 'string' &&
      entry.noopGuard.noopRejected.trim() !== '',
  );
  return {
    ok: duplicates.length === 0 && noopGuarded,
    markerCount: EVIDENCE_PREDICATE_AUDIT.length,
    markers: EVIDENCE_PREDICATE_AUDIT.map((entry) => entry.marker),
    evidenceClasses,
    productEvidenceMarkers,
    noopGuarded,
    duplicates,
    entries: EVIDENCE_PREDICATE_AUDIT.map((entry) => ({ ...entry })),
  };
}

// ─────────────────────────────────────────────────────────────────────
// Real proc adapters (spawnCapture wired to the private exec context).
// The old REAL_PROC.spawnCapture merged process.env with only a timer-cap
// override and the CLI never constructed a private HOME/STATE/DB authority —
// a bare qualified run inherited operator state. Every real child spawn now
// goes through a proc bundle bound to ONE admitted exec context: argv[0] is
// rewritten to the context's absolute binaries and the child env is the
// context's immutable private env (plus per-call extras, never process.env).
// ─────────────────────────────────────────────────────────────────────
export function makeRealProc({ execCtx, daemonEnv = null, controlUrl = null, spawn = null }) {
  if (!execCtx?.child_env) throw refusal('makeRealProc requires a private exec context', TT_EXEC_ESCAPE);
  // S1 (run #56 wiring): the campaign's rendered daemon env (TT_DC_ENV_SCRIPTED
  // + TT_FORCE_NO_SYSTEMD) must reach EVERY daemon-control dispatch, not just
  // the process that happened to render the script. It is bound here once and
  // merged into the per-call env of the daemonControl channel only; childEnv()
  // still validates it (protected keys refuse TT_EXEC_ESCAPE) and
  // mergeParentEnv stays false, so this is delivery through the existing call
  // seam — no bypass of binary admission or the env allowlist.
  const boundDaemonEnv = daemonEnv && typeof daemonEnv === 'object' ? Object.freeze({ ...daemonEnv }) : null;
  const spawnFn = spawn ?? (async (argv, opts) => {
    const { spawnCapture } = await import('./tt-storm-shared.mjs');
    return spawnCapture(argv, opts);
  });
  // Root defect #2: the ONLY executables a proc bundle may run are the ones
  // the private exec context resolved to ABSOLUTE paths at construction. A
  // caller cannot smuggle an arbitrary argv[0] (e.g. /bin/sh) through an
  // effect channel.
  const KNOWN_NAMES = ['tamandua', 'tamandua-test', 'tt-chaos', 'daemon-control', 'git'];
  const binaryFor = (name) => {
    const binKey = { tamandua: 'tamandua', 'tamandua-test': 'tamanduaTest', 'tt-chaos': 'ttChaos', 'daemon-control': 'daemonControl', git: 'git' }[name];
    const abs = binKey ? execCtx.binaries[binKey] : undefined;
    if (abs === undefined || abs === null) {
      throw refusal(`makeRealProc: unknown/unresolved executable '${name}' — only the context's absolute binaries may run`, TT_UNKNOWN_BINARY);
    }
    return abs;
  };
  // Child env = immutable private env + validated per-call extras. process.env
  // is never merged (mergeParentEnv:false at the spawn boundary): operator
  // credentials / authority / worktree roots cannot leak. Protected keys
  // (HOME, TAMANDUA_STATE_DIR, TAMANDUA_DB_PATH, TMPDIR, guard, authority
  // family) may never be overridden per call (root defect #2).
  const childEnv = (extras = {}) => {
    const merged = { ...execCtx.child_env };
    for (const [k, v] of Object.entries(extras ?? {})) {
      if (v === undefined) continue;
      if (isProtectedChildEnvKey(k)) {
        throw refusal(`makeRealProc: per-call env cannot override protected child env key ${k}`, TT_EXEC_ESCAPE);
      }
      merged[k] = String(v);
    }
    return merged;
  };
  // Owned-children registry: the only pids this proc bundle may signal are
  // pids it spawned itself (or that the rehearsal gate explicitly admitted
  // with evidence). No generic process.kill(pid, signal) endpoint.
  const ownedChildren = new Map(); // pid -> { argv, at, evidence }
  const registerChild = (pid, { argv = null, evidence = 'spawned-by-proc-bundle' } = {}) => {
    const n = Number(pid);
    if (!Number.isInteger(n) || n <= 0) return null;
    ownedChildren.set(n, { pid: n, argv: argv ? [...argv] : null, at: new Date().toISOString(), evidence });
    return n;
  };
  const call = async (rawArgv, opts = {}) => {
    if (!Array.isArray(rawArgv) || rawArgv.length === 0) {
      throw refusal('makeRealProc: empty argv', TT_EXEC_ESCAPE);
    }
    const argv = rawArgv.map((a, i) => (i === 0 ? binaryFor(a) : String(a)));
    const { cwd, timeoutMs, signal, env } = opts;
    // cwd is locked to the private home root unless the caller supplies an
    // EXISTING directory inside the contained var root (root defect #2: a
    // per-call cwd escape was previously accepted and passed to spawn).
    let resolvedCwd = execCtx.home_root;
    if (cwd !== undefined && cwd !== null) {
      const absCwd = path.resolve(String(cwd));
      const realCwd = safeRealpath(absCwd, fs, 'cwd');
      if (!realCwd || !pathIsWithin(execCtx.var_root, realCwd)) {
        throw refusal(`makeRealProc: cwd escapes the contained exec context (${execCtx.var_root}): ${absCwd}`, TT_EXEC_ESCAPE);
      }
      resolvedCwd = absCwd;
    }
    const result = await spawnFn(argv, {
      cwd: resolvedCwd,
      env: childEnv(env),
      timeoutMs: timeoutMs ?? 0,
      signal: signal ?? null,
      mergeParentEnv: false,
    });
    if (result?.pid) registerChild(result.pid, { argv });
    return result;
  };
  const kill = async (pid, signalName) => {
    const n = Number(pid);
    if (!ownedChildren.has(n)) {
      return { ok: false, code: TT_NOT_OWNED, pid: n, signal: signalName, error: `pid ${pid} is not an owned child of this exec context (only exact children spawned by this gate may be signalled)` };
    }
    try {
      process.kill(n, signalName);
      return { ok: true, pid: n, signal: signalName, admitted: ownedChildren.get(n) };
    } catch (err) {
      return { ok: false, pid: n, signal: signalName, error: String(err?.message ?? err) };
    }
  };
  return {
    exec_ctx_ref: execCtx.owner_ref,
    launchWorkflow: (argv, opts) => call(argv, opts),
    tamandua: (argv, opts) => call(argv, opts),
    chaosAction: (argv, opts) => call(argv, opts),
    daemonControl: (argv, opts) => call(argv, {
      ...(opts ?? {}),
      env: { ...(opts?.env ?? {}), ...(boundDaemonEnv ?? {}) },
    }),
    httpGet: makeRealHttpGet(),
    // SF-3: the campaign's private control-plane read seam. controlUrl is the
    // materialized state.daemon_ports.controlUrl (falling back to an explicit
    // TT_STORM_CONTROL_URL extra env entry); with neither, the seam reports
    // "not wired" and the engine records an UNKNOWN snapshot. The private
    // daemon authenticates the control plane with daemon-secret (read lazily,
    // it is created when the daemon starts).
    controlGet: makeRealControlGet({
      controlUrl: controlUrl ?? execCtx.extra_env.TT_STORM_CONTROL_URL ?? null,
      secretPath: path.join(execCtx.state_root, 'daemon-secret'),
    }),
    mcpTool: makeRealMcpTool({ endpointUrl: execCtx.extra_env.TT_STORM_MCP_ENDPOINT ?? null }),
    kill,
    registerChild,
    ownedPids: () => [...ownedChildren.keys()],
    ownedChildren: () => [...ownedChildren.values()],
  };
}

// Cleanup handlers for a real campaign. The owned phase in the real
// (pre-rehearsal / rehearsal) path is the campaign's private exec context:
// cleanup = positive evidence that every owned root is still the SAME
// directory allocated for this campaign (dev/ino unchanged) and no owned
// child process/listener remains alive. Files/worktrees/state are RETAINED
// (no-removal policy); this is process/listener/identity shutdown evidence,
// never a broad filesystem cleanup.
//
// Root defect #4 / reviewer issue: the handler returns evidenced:true ONLY on
// typed positive settled evidence — identity unchanged AND every pid in the
// explicit owned-pid inventory (from the proc bundle's own registry or the
// caller-supplied resources) is confirmed dead. An absent/empty inventory is
// itself evidence ONLY when nothing was ever allocated; callers that DID
// allocate/spawn must pass the real inventory through `resources.ownedPids`
// (runOwnedCleanup resources param) or the handler refutes.
export function makeCampaignCleanupHandlers(execCtx, { fsx = fs, ownedPids = [] } = {}) {
  const probeAlive = (pids) => {
    const alive = [];
    for (const pid of pids) {
      const n = Number(pid);
      if (!Number.isInteger(n) || n <= 0) continue;
      try {
        process.kill(n, 0); // existence probe only
        alive.push(n);
      } catch {
        // ESRCH / EPERM-unknown: not a live owned child (EPERM would mean it
        // exists but belongs to someone else — not ours, so not evidence of
        // an owned leak; recorded as not-alive for OUR inventory).
      }
    }
    return alive;
  };
  return {
    'campaign-owned': async ({ resources = null } = {}) => {
      assertOwnershipUnchanged(execCtx.ownership, fsx);
      const inventory = Array.isArray(resources?.ownedPids)
        ? resources.ownedPids
        : (Array.isArray(ownedPids) ? ownedPids : []);
      const alive = probeAlive(inventory);
      if (alive.length > 0) {
        return { evidenced: false, error: `owned child process(es) still alive: ${alive.join(',')}` };
      }
      return {
        evidenced: true,
        ownership: execCtx.ownership,
        ownedPidsProbed: inventory,
        retained: 'files/worktrees/state retained (no-removal policy)',
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Coordinator approval verification. The FIRST real execution (the actual
// SCRIPTED_REHEARSAL) requires an exact coordinator-owned approval file
// matching the tested boundary/gate hashes and source. This tool NEVER
// creates/alters/fabricates that file — it only CONSUMES it and refuses
// when absent, malformed, or mismatched. verifyCoordinatorApproval is pure
// (no fs writes): given the approval JSON + the campaign identity + the
// current source commit + the gate-file hashes the safety contract pins, it
// returns { ok, reason } with a machine-parseable refusal code.
// ─────────────────────────────────────────────────────────────────────
export function verifyCoordinatorApproval({ approval, campaignId, sourceCommit, gateHashes = {}, expectedProfile = null }) {
  if (!approval || typeof approval !== 'object') {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: 'approval is not a JSON object' };
  }
  if (approval.real_launch_allowed !== true) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: `approval.real_launch_allowed !== true (got ${JSON.stringify(approval.real_launch_allowed)})` };
  }
  // Root defect #5: MISSING ids/source are refused, not tolerated — an
  // approval that does not NAME the exact campaign/source can never be
  // authority for that campaign.
  if (typeof approval.campaign_id !== 'string' || approval.campaign_id.length === 0) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: 'approval carries no campaign_id (exact non-empty campaign identity required)' };
  }
  if (typeof campaignId !== 'string' || campaignId.length === 0) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: 'caller provided no campaign_id — cannot verify a campaign-scoped approval' };
  }
  if (approval.campaign_id !== campaignId) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: `approval.campaign_id ${approval.campaign_id} does not match campaign ${campaignId}` };
  }
  if (typeof approval.source_commit !== 'string' || approval.source_commit.length === 0) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: 'approval carries no source_commit (exact pinned source required)' };
  }
  if (typeof sourceCommit !== 'string' || sourceCommit.length === 0) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: 'caller provided no current source commit — cannot verify source pinning' };
  }
  if (approval.source_commit !== sourceCommit) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: `approval.source_commit ${approval.source_commit} does not match current source ${sourceCommit}` };
  }
  if (approval.approval_kind !== 'SCRIPTED_REHEARSAL' && approval.approval_kind !== 'coordinator') {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: `unrecognized approval_kind ${JSON.stringify(approval.approval_kind)} (SCRIPTED_REHEARSAL|coordinator required)` };
  }
  // Explicit profile pin when the caller requires one (SCRIPTED_REHEARSAL).
  if (expectedProfile != null) {
    if (typeof approval.profile !== 'string' || approval.profile.length === 0) {
      return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: `approval carries no profile (expected ${expectedProfile})` };
    }
    if (approval.profile !== expectedProfile) {
      return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: `approval.profile ${approval.profile} does not match expected ${expectedProfile}` };
    }
  }
  // The approval MUST pin the COMPLETE tested boundary/gate hash set — the
  // exact set this checkout computes (computeGateHashes in the CLI). A
  // SUBSET (approval omitting a gate file) and a SUPERSET (approval pinning a
  // file outside the tested set) are both refused: approval must match the
  // tested boundary byte-for-byte (root defect #5: only a SUBSET was
  // previously required — a stale approval could still qualify after gate
  // code changed).
  const pinned = approval.gate_hashes ?? null;
  if (!pinned || typeof pinned !== 'object' || Array.isArray(pinned)) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: 'approval.gate_hashes must be an object — a synthetic rehearsal receipt cannot authorize real execution' };
  }
  const expectedFiles = Object.keys(gateHashes ?? {}).filter((f) => gateHashes[f] != null);
  const pinnedFiles = Object.keys(pinned).filter((f) => pinned[f] != null);
  if (expectedFiles.length === 0) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: 'caller provided no gate-file hashes — cannot verify the tested boundary' };
  }
  if (pinnedFiles.length === 0) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: 'approval pins no gate_hashes — a synthetic rehearsal receipt cannot authorize real execution' };
  }
  const mismatched = [];
  const missingFromApproval = expectedFiles.filter((f) => !(f in pinned));
  for (const f of missingFromApproval) {
    mismatched.push({ file: f, expected: gateHashes[f], actual: null, reason: 'approval omits a tested gate file (incomplete hash set)' });
  }
  const extraInApproval = pinnedFiles.filter((f) => !(f in gateHashes));
  for (const f of extraInApproval) {
    mismatched.push({ file: f, expected: null, actual: pinned[f], reason: 'approval pins a file outside the tested gate set' });
  }
  for (const f of expectedFiles) {
    if (!(f in pinned)) continue;
    if (pinned[f] !== gateHashes[f]) {
      mismatched.push({ file: f, expected: gateHashes[f], actual: pinned[f], reason: 'hash mismatch — gate/safety code changed since approval' });
    }
  }
  if (mismatched.length > 0) {
    return { ok: false, code: 'TT_REHEARSAL_NOT_APPROVED', reason: `approval gate hashes do not match the tested boundary: ${JSON.stringify(mismatched)}` };
  }
  return { ok: true, code: null, reason: 'approval verified' };
}

export { ACTIVE_STEP_STATUSES, TERMINAL_RUN_STATUSES, normalizedStoredRunId, refusal, sha256 };
