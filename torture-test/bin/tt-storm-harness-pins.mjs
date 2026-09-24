// tt-storm-harness-pins.mjs — STORM-REAL REAL-profile harness binary
// resolution + runtime pins (STORM-REAL US-002).
//
// A REAL campaign runs the OPERATOR'S real harnesses (pi/hermes/dsh), so a
// REAL prepare must resolve each harness the active roster uses exactly the
// way the product does — an explicit TAMANDUA_<HARNESS>_BINARY override, else
// a PATH search — and then PIN what it resolved (absolute path + `--version`
// output + sha256) into descriptor.runtime_pins. Resolution is a PIN, never a
// capability test: credentials/config are never read or copied here, only the
// binary is stat()ed and executed once with `--version`.
//
// Safety posture (mirrors the product's harness adapters and the storm's
// fail-closed discipline):
//   * an override MUST be an absolute path; a relative value refuses
//     TT_UNRESOLVED_BINARY (never a silent cwd-relative fallback);
//   * a resolved candidate MUST be an existing executable regular file — a
//     missing/foreign override, or a PATH with no candidate, refuses
//     TT_UNRESOLVED_BINARY naming the env var and the PATH searched;
//   * an unresolvable roster harness refuses the WHOLE prepare before any
//     effect, so a REAL storm can never be armed against a half-missing
//     toolchain;
//   * the `--version` run is bounded and its output/exist-status is recorded
//     verbatim (a non-zero `--version` is reported, not fabricated as a
//     failure). Credentials are untouched.
//
// The resolver is effect-injected (fs + version runner + env) so the
// self-tests exercise env/PATH/missing-harness paths against owned temp
// fixtures with zero reliance on the operator's installed toolchain.

import fs from 'node:fs';
import path from 'node:path';

import { refusal, sha256 } from './tt-contention-slice-shared.mjs';
import { TT_UNRESOLVED_BINARY } from './tt-storm-real.mjs';
import { spawnCapture } from './tt-storm-shared.mjs';

// Re-exported so callers/tests have ONE source for the refusal code.
export { TT_UNRESOLVED_BINARY };

// The admitted roster harnesses and the env override each honors. This is the
// same mapping the product's harness adapters implement
// (src/installer/harness-adapter.ts findBinary): pi -> TAMANDUA_PI_BINARY,
// hermes -> TAMANDUA_HERMES_BINARY, dsh -> TAMANDUA_DSH_BINARY.
export const HARNESS_BINARY_ENV = Object.freeze({
  pi: 'TAMANDUA_PI_BINARY',
  hermes: 'TAMANDUA_HERMES_BINARY',
  dsh: 'TAMANDUA_DSH_BINARY',
});

// The admitted harness names, in canonical order.
export const HARNESS_NAMES = Object.freeze(Object.keys(HARNESS_BINARY_ENV));

// The number of bytes of `--version` output retained in a pin (version
// banners are tiny; the bound keeps a pathological binary from bloating state).
export const MAX_VERSION_BYTES = 4 * 1024;

// The default `--version` runner: a bounded real spawn that returns
// `{ exitCode, signal, stdout, stderr }` (never throws — spawnCapture resolves
// every outcome, including a spawn error).
export function defaultHarnessVersionRunner(binaryPath) {
  return spawnCapture([binaryPath, '--version'], { timeoutMs: 20_000 });
}

function harnessEnvVarFor(harness) {
  const envVar = HARNESS_BINARY_ENV[harness];
  if (!envVar) {
    throw refusal(
      `unknown harness ${JSON.stringify(harness)} (expected one of ${HARNESS_NAMES.join(', ')})`,
      TT_UNRESOLVED_BINARY,
    );
  }
  return envVar;
}

// Distinct harness names used by a roster, in first-appearance order. Pure:
// roster rows are the product's roster identity objects (`{ harness }`).
export function harnessNamesForRoster(rosters) {
  const out = [];
  for (const row of Array.isArray(rosters) ? rosters : []) {
    const harness = row?.harness;
    if (typeof harness === 'string' && harness.length > 0 && !out.includes(harness)) out.push(harness);
  }
  return out;
}

function isExecutableFile(candidate, fsx) {
  try {
    const st = fsx.statSync(candidate);
    if (!st.isFile()) return false;
    fsx.accessSync(candidate, fs.constants?.X_OK ?? 1);
    return true;
  } catch {
    return false;
  }
}

function pathDirsOf(pathValue) {
  return String(pathValue ?? '')
    .split(path.delimiter)
    .filter((dir) => dir.length > 0);
}

// Resolve ONE roster harness to an absolute existing executable. Honors the
// env override first (absolute only), else searches PATH. Returns
// `{ path, resolved_from }`; refuses TT_UNRESOLVED_BINARY otherwise.
export function resolveHarnessExecutable(
  harness,
  { env = {}, fs: fsx = fs, pathEnv = undefined } = {},
) {
  const envVar = harnessEnvVarFor(harness);
  const rawOverride = env?.[envVar];
  const override = typeof rawOverride === 'string' ? rawOverride.trim() : rawOverride == null ? '' : String(rawOverride).trim();
  if (override !== '') {
    if (!path.isAbsolute(override)) {
      throw refusal(
        `${envVar} must be an absolute path to the ${harness} harness (got ${JSON.stringify(rawOverride)})`,
        TT_UNRESOLVED_BINARY,
      );
    }
    if (!isExecutableFile(override, fsx)) {
      throw refusal(
        `${envVar} is not an existing executable file: ${override}`,
        TT_UNRESOLVED_BINARY,
      );
    }
    return { path: override, resolved_from: `env:${envVar}` };
  }
  const effectivePath = pathEnv ?? env?.PATH ?? '';
  for (const dir of pathDirsOf(effectivePath)) {
    const candidate = path.join(dir, harness);
    if (isExecutableFile(candidate, fsx)) {
      return { path: candidate, resolved_from: `path:${dir}` };
    }
  }
  throw refusal(
    `no ${harness} harness executable resolved: ${envVar} is unset and no executable named ${harness} is on PATH (${effectivePath || '<empty PATH>'})`,
    TT_UNRESOLVED_BINARY,
  );
}

// Pin ONE resolved harness: absolute path, sha256 of the file bytes, the
// `--version` output, and where it came from. The version run is bounded and
// its outcome recorded honestly (a non-zero exit is NOT a resolution failure).
export async function pinHarness(
  harness,
  { env = {}, fs: fsx = fs, pathEnv = undefined, runner = defaultHarnessVersionRunner } = {},
) {
  const resolved = resolveHarnessExecutable(harness, { env, fs: fsx, pathEnv });
  let bytes;
  try {
    bytes = fsx.readFileSync(resolved.path);
  } catch (err) {
    throw refusal(
      `cannot read the ${harness} harness at ${resolved.path} for pinning: ${err?.message ?? String(err)}`,
      TT_UNRESOLVED_BINARY,
    );
  }
  const sha = sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes)));
  const version = await captureHarnessVersion(harness, resolved.path, runner);
  return {
    harness,
    path: resolved.path,
    resolved_from: resolved.resolved_from,
    sha256: sha,
    version: version.text,
    version_exit_code: version.exitCode,
    ...(version.error ? { version_error: version.error } : {}),
  };
}

async function captureHarnessVersion(harness, binaryPath, runner) {
  let result;
  try {
    result = await runner(binaryPath);
  } catch (err) {
    return { text: null, exitCode: null, error: `version runner threw: ${err?.message ?? String(err)}` };
  }
  const out = result && typeof result === 'object' ? result : {};
  const pieces = [out.stdout, out.stderr].filter((s) => typeof s === 'string' && s.trim() !== '');
  const text = pieces.join('\n').trim().slice(0, MAX_VERSION_BYTES);
  const exitCode = typeof out.exitCode === 'number' ? out.exitCode : null;
  return { text: text === '' ? null : text, exitCode, error: null };
}

// Resolve + pin EVERY requested roster harness. The returned map preserves
// request order; the FIRST unresolvable harness refuses the whole call with
// TT_UNRESOLVED_BINARY (no partial pin set is ever returned).
export async function resolveRosterHarnessPins(harnessNames, options = {}) {
  const names = [];
  for (const name of Array.isArray(harnessNames) ? harnessNames : []) {
    if (typeof name === 'string' && name.length > 0 && !names.includes(name)) names.push(name);
  }
  const pins = {};
  for (const name of names) {
    pins[name] = await pinHarness(name, options);
  }
  return pins;
}