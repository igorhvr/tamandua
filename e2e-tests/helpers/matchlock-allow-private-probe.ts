/**
 * matchlock-allow-private-probe.ts — MTLK-ALLOW-PRIVATE (US-009) shared,
 * pure-filesystem vocabulary + evidence helpers for the on-demand real-VM
 * allow-private gate and its fast no-VM controls.
 *
 * The gate (e2e-tests/matchlock-allow-private-gate.test.ts) drives do-now
 * under --matchlock twice through an isolated daemon → scheduler → fresh VM:
 * once WITH `--matchlock-allow-private <endpoint>` (the synthetic-pi in-guest
 * curl probe must exit 0) and once WITHOUT it (the same probe must record a
 * refusal). This module owns the stable names both runs and the fast controls
 * share, plus the strict marker/argv/daemon-env helpers so the argument and
 * evidence logic can be exercised WITHOUT booting a VM.
 *
 * Node-core only (no child_process, no dist import): the fast controls stay in
 * the parallel lane and need no tests/serial-files.txt entry.
 */

import fs from "node:fs";
import path from "node:path";

/** The private destination the gate proves reachable/refused in the guest. */
export const ALLOW_PRIVATE_PROBE_URL = "192.168.107.74:8888";

/** The repeatable CLI flag this gate proves (MTLK-ALLOW-PRIVATE). */
export const ALLOW_PRIVATE_FLAG = "--matchlock-allow-private";

/** The env default the flag overrides (documented, never used by this gate). */
export const ALLOW_PRIVATE_ENV = "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE";

/** The default-off fixture knob that turns the in-guest curl probe on. */
export const CURL_PROBE_ENV = "TAMANDUA_SYNTHETIC_PI_CURL_URL";

/**
 * The TEMPORARY host-side exemption on vaimetal (dist patch +
 * TAMANDUA_MATCHLOCK_TEMP_ALLOW_PRIVATE). MTLK-ALLOW-PRIVATE must NOT depend
 * on it: the gate daemon env is asserted to exclude it so both rounds exercise
 * the real per-run policy path.
 */
export const TEMP_ALLOW_PRIVATE_ENV = "TAMANDUA_MATCHLOCK_TEMP_ALLOW_PRIVATE";

/** Marker directory + file the synthetic-pi fixture writes under the mount. */
export const PROBE_MARKER_DIR = ".matchlock-synthetic-pi";
export const PROBE_MARKER_FILE = "curl-probe.json";

/** The observed-rounds gate label shared by the runner and the driver. */
export const ALLOW_PRIVATE_GATE_LABEL = "allow-private";

export interface CurlProbeResult {
  /** The destination the guest curl targeted. */
  url: string;
  /** The guest curl process exit code (-1 when it could not be spawned). */
  exitCode: number;
  /** The bounded guest curl stdout (the response body on success). */
  stdout: string;
}

/** Strictly parse a `{ url, exitCode, stdout }` curl-probe marker. Throws. */
export function parseCurlProbeMarker(text: string): CurlProbeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `malformed curl-probe marker JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("malformed curl-probe marker: expected a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.url !== "string" || record.url.trim() === "") {
    throw new Error("malformed curl-probe marker: url must be a non-empty string");
  }
  if (
    typeof record.exitCode !== "number" ||
    !Number.isSafeInteger(record.exitCode)
  ) {
    throw new Error("malformed curl-probe marker: exitCode must be a safe integer");
  }
  if (typeof record.stdout !== "string") {
    throw new Error("malformed curl-probe marker: stdout must be a string");
  }
  return { url: record.url, exitCode: record.exitCode, stdout: record.stdout };
}

/** Absolute path of the curl-probe marker under a mounted working directory. */
export function curlProbeMarkerPath(workDir: string): string {
  return path.join(workDir, PROBE_MARKER_DIR, PROBE_MARKER_FILE);
}

/** Strictly read + parse the curl-probe marker for one mounted working dir. */
export function readCurlProbeMarker(workDir: string): CurlProbeResult {
  const file = curlProbeMarkerPath(workDir);
  if (!fs.existsSync(file)) {
    throw new Error(`curl-probe marker missing at ${file}`);
  }
  return parseCurlProbeMarker(fs.readFileSync(file, "utf-8"));
}

/** Assert the with-flag round reached the endpoint (exit 0 + response body). */
export function assertCurlProbeReached(
  result: CurlProbeResult,
  expectedUrl: string = ALLOW_PRIVATE_PROBE_URL,
): void {
  if (result.url !== expectedUrl) {
    throw new Error(
      `curl probe targeted ${result.url}, expected the allow-private endpoint ${expectedUrl}`,
    );
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `with --matchlock-allow-private ${expectedUrl} the in-guest curl must exit 0, got ${result.exitCode} (stdout=${JSON.stringify(result.stdout.slice(0, 300))})`,
    );
  }
  if (result.stdout.trim() === "") {
    throw new Error(
      `with --matchlock-allow-private ${expectedUrl} the in-guest curl exited 0 but recorded no response body`,
    );
  }
}

/** Assert the without-flag round was refused (nonzero curl exit). */
export function assertCurlProbeRefused(result: CurlProbeResult): void {
  if (result.exitCode === 0) {
    throw new Error(
      `without --matchlock-allow-private the in-guest curl to ${result.url} must fail (refusal), but it exited 0 with stdout=${JSON.stringify(result.stdout.slice(0, 300))}`,
    );
  }
}

/**
 * Return a copy of `env` with the temporary host exemption removed. The gate
 * uses this defensively AND asserts the extracted daemon env excludes the key,
 * so a green round can never be explained by TAMANDUA_MATCHLOCK_TEMP_ALLOW_PRIVATE.
 */
export function withoutTempAllowPrivate(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === TEMP_ALLOW_PRIVATE_ENV) continue;
    if (value !== undefined) copy[key] = value;
  }
  return copy;
}

/** True when a daemon env record leaks the temporary host exemption. */
export function daemonEnvLeaksTempExemption(
  env: Record<string, string | undefined>,
): boolean {
  return Object.prototype.hasOwnProperty.call(env, TEMP_ALLOW_PRIVATE_ENV);
}

export interface DoNowRunArgsInput {
  /** The host-mounted harness working directory for the run. */
  workDir: string;
  /** The do-now task prompt. */
  prompt: string;
  /** The admitted Matchlock image tag. */
  imageTag: string;
  /** Optional per-run private-destination exceptions (run A only). */
  allowPrivate?: readonly string[];
}

/**
 * Build the exact `workflow run do-now --matchlock …` argv for one gate round.
 * Each allow-private entry emits its own repeatable `--matchlock-allow-private`
 * pair, in first-seen order; an empty list emits no flag at all.
 */
export function buildDoNowRunArgs(input: DoNowRunArgsInput): string[] {
  const args = [
    "workflow",
    "run",
    "do-now",
    input.prompt,
    "--working-directory-for-harness",
    input.workDir,
    "--matchlock",
    input.imageTag,
  ];
  for (const entry of input.allowPrivate ?? []) {
    args.push(ALLOW_PRIVATE_FLAG, entry);
  }
  return args;
}
