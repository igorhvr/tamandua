/**
 * MTLK guest suite: portable guest `tamandua-test` process entry.
 *
 * Compiled into the portable RO helper pack and invoked by the
 * `bin/tamandua-test` launcher. Thin adapter between the process and
 * runGuestSuiteShim:
 *
 *   - io is bound to the real process (cwd, env, stdout/stderr raw bytes)
 *   - the environment namespace is read ONLY from host-supplied env vars
 *     (attested descriptor); when absent the engine refuses to trust any
 *     ledger result and executes the real command with explicit incomplete
 *     evidence
 *   - MTLK-SUITE-WIRE: when the invocation is actually suite-capable — the
 *     host wired a suite-capable broker (TAMANDUA_GUEST_SUITE_ENABLED=1), the
 *     guest bridge socket is configured and an attested namespace was
 *     supplied — the engine is wired to the REAL scoped socket transport
 *     (GuestSuiteSocketTransport): every suite call travels
 *     tamandua-test -> guest-local Unix socket/service -> bounded framed
 *     exec-pipe channel -> host broker -> injected host suite
 *     transport/services bridge.
 *   - Missing/unavailable transport keeps the documented guest-local
 *     execution/warning semantics: the engine runs the real command with an
 *     explicit warning and NEVER records/replays a green, and there is never
 *     a native host fallback. Absence of the host suite service is clearly
 *     exposed instead of advertising a working suite capability by default.
 *     No daemon-admin fallback import exists anywhere in this closure.
 *
 * Node-core only — safe for the guest pack closure.
 */

import {
  createUnavailableSuiteTransport,
  type GuestSuiteNamespace,
  type GuestSuiteTransport,
} from "./guest-suite-contract.js";
import { runGuestSuiteShim } from "./guest-suite-shim.js";
import { GuestSuiteSocketTransport } from "./suite-socket-transport.js";
import {
  ENV_GUEST_ENV_FINGERPRINT,
  ENV_GUEST_HELPER_CONTRACT,
  ENV_GUEST_IMAGE_CONTENT_ID,
  ENV_GUEST_PLATFORM,
  ENV_GUEST_SUITE_ENABLED,
} from "./suite-wire-env.js";

/**
 * Provisional host-supplied env var names for the attested namespace (final
 * names are fixed by the controller/helper integration). The canonical list
 * of reporting env keys + the product-child stripper live in suite-wire-env.ts.
 */

/** Build the namespace from the host-supplied env; null when any part is absent. */
export function guestSuiteNamespaceFromEnv(
  envGet: (name: string) => string | undefined,
): GuestSuiteNamespace | null {
  const imageContentId = envGet(ENV_GUEST_IMAGE_CONTENT_ID)?.trim();
  const guestPlatform = envGet(ENV_GUEST_PLATFORM)?.trim();
  const helperContract = envGet(ENV_GUEST_HELPER_CONTRACT)?.trim();
  const compatibilityFingerprint = envGet(ENV_GUEST_ENV_FINGERPRINT)?.trim();
  if (
    !imageContentId
    || !guestPlatform
    || !helperContract
    || !compatibilityFingerprint
  ) {
    return null;
  }
  return { imageContentId, guestPlatform, helperContract, compatibilityFingerprint };
}

export interface GuestSuiteCliTransportBuild {
  transport: GuestSuiteTransport;
  /** Non-null when the real socket transport could NOT be used (reason). */
  unavailableReason: string | null;
}

/**
 * Choose the transport for one guest `tamandua-test` process.
 *
 * The REAL scoped socket transport is used ONLY when the whole suite path is
 * present: the guest bridge service was launched suite-enabled, a guest
 * bridge socket is configured, an attested namespace was supplied and a
 * helper build identity is known. Any missing piece degrades to the
 * unavailable transport with an explicit reason — the engine then executes
 * the real command with incomplete evidence (never a recorded/replayed green,
 * never a native host fallback), clearly exposing that the host suite service
 * is ABSENT rather than advertising a working suite capability by default.
 */
export function buildGuestSuiteCliTransport(
  envGet: (name: string) => string | undefined,
  namespace: GuestSuiteNamespace | null,
): GuestSuiteCliTransportBuild {
  const suiteEnabled = envGet(ENV_GUEST_SUITE_ENABLED)?.trim() === "1";
  const socketPath = GuestSuiteSocketTransport.socketPathFromEnv(envGet, "TAMANDUA_GUEST_SOCKET_DIR");
  const helperBuildVersion = envGet("TAMANDUA_GUEST_BUILD_VERSION")?.trim() ?? "unknown";

  if (!suiteEnabled) {
    return {
      transport: createUnavailableSuiteTransport(
        "host suite service is ABSENT for this invocation: the host did not wire a suite-capable broker (TAMANDUA_GUEST_SUITE_ENABLED is not 1) — executing the real command with explicit incomplete evidence",
      ),
      unavailableReason: "TAMANDUA_GUEST_SUITE_ENABLED is not 1 (host suite service absent)",
    };
  }
  if (!socketPath) {
    return {
      transport: createUnavailableSuiteTransport(
        "guest suite transport is unavailable: no guest bridge socket is configured (set TAMANDUA_GUEST_SOCKET or TAMANDUA_GUEST_SOCKET_DIR) — executing the real command with explicit incomplete evidence",
      ),
      unavailableReason: "no guest bridge socket configured",
    };
  }
  if (namespace === null) {
    return {
      transport: createUnavailableSuiteTransport(
        "guest suite transport is unavailable: no host-attested environment namespace was supplied — executing the real command with explicit incomplete evidence",
      ),
      unavailableReason: "no host-attested namespace supplied",
    };
  }
  return {
    transport: new GuestSuiteSocketTransport({
      socketPath,
      helperBuildVersion,
      namespace,
      requestTimeoutMs: readTimeoutEnv(envGet),
    }),
    unavailableReason: null,
  };
}

function readTimeoutEnv(envGet: (name: string) => string | undefined): number | undefined {
  const raw = envGet("TAMANDUA_BRIDGE_REQUEST_TIMEOUT_MS")?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 120_000);
}

/** Run the guest suite CLI once; resolves with the process exit code. */
export async function runGuestSuiteCliEntry(argv: string[]): Promise<number> {
  const envGet = (name: string): string | undefined => process.env[name];
  const writeRaw = (stream: NodeJS.WriteStream): ((chunk: Buffer) => void) => {
    return (chunk: Buffer) => stream.write(chunk);
  };
  const io = {
    cwd: process.cwd(),
    envGet,
    writeOut: (text: string) => process.stdout.write(text),
    writeErr: (text: string) => process.stderr.write(text),
    writeOutRaw: writeRaw(process.stdout),
    writeErrRaw: writeRaw(process.stderr),
  };
  const namespace = guestSuiteNamespaceFromEnv(envGet);
  const build = buildGuestSuiteCliTransport(envGet, namespace);
  const result = await runGuestSuiteShim(argv, io, {
    transport: build.transport,
    namespace,
  });
  return result.exitCode;
}

async function main(): Promise<void> {
  const exitCode = await runGuestSuiteCliEntry(process.argv.slice(2));
  process.exitCode = exitCode;
}

main().catch((err: unknown) => {
  process.stderr.write(
    `tamandua-test: internal error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
