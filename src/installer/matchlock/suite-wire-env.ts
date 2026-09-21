/**
 * MTLK-SUITE-WIRE: explicit scoped-environment construction for guest suite
 * reporting (self-dogfood separation, design section 7.4).
 *
 * The outer packed shim (bin/tamandua-test / bin/tamandua) is the reporting
 * CLIENT. A PRODUCT-UNDER-TEST child that this wire spawns must never
 * accidentally inherit the parent's reporting socket/authority and record
 * into the parent ledger. This module lists every env key the reporting path
 * consumes and provides stripGuestSuiteEnv() to build an explicit stripped
 * environment for such children. Native cleanChildEnv is NEVER changed; test
 * failures are never hidden — a stripped child simply has no way to reach the
 * reporting service, exactly like a VM without the host wiring.
 *
 * Node-core only — safe for the guest pack closure (no process side effects).
 */

/** Env switch the host wiring sets ONLY when the broker was injected with a
 *  suite-capable host bridge (see guest-service-entry.ts). */
export const ENV_GUEST_SUITE_ENABLED = "TAMANDUA_GUEST_SUITE_ENABLED";

/** Provisional host-supplied env names for the attested namespace. */
export const ENV_GUEST_IMAGE_CONTENT_ID = "TAMANDUA_GUEST_IMAGE_CONTENT_ID";
export const ENV_GUEST_PLATFORM = "TAMANDUA_GUEST_PLATFORM";
export const ENV_GUEST_HELPER_CONTRACT = "TAMANDUA_GUEST_HELPER_CONTRACT";
export const ENV_GUEST_ENV_FINGERPRINT = "TAMANDUA_GUEST_ENV_FINGERPRINT";

/**
 * Every env key the guest suite reporting path consumes to reach the host:
 * the guest bridge socket location, the suite-enabled switch, the attested
 * namespace and the bridge deadlines/build identity.
 */
export const GUEST_SUITE_ENV_KEYS = [
  ENV_GUEST_SUITE_ENABLED,
  "TAMANDUA_GUEST_SOCKET",
  "TAMANDUA_GUEST_SOCKET_DIR",
  ENV_GUEST_IMAGE_CONTENT_ID,
  ENV_GUEST_PLATFORM,
  ENV_GUEST_HELPER_CONTRACT,
  ENV_GUEST_ENV_FINGERPRINT,
  "TAMANDUA_GUEST_BUILD_VERSION",
  "TAMANDUA_BRIDGE_REQUEST_TIMEOUT_MS",
  "TAMANDUA_BRIDGE_HANDSHAKE_TIMEOUT_MS",
  "TAMANDUA_BRIDGE_SHUTDOWN_FLUSH_MS",
] as const;

/**
 * Explicit scoped-environment construction for product-under-test children:
 * returns a copy of `env` with every reporting socket/suite authority key
 * removed, so a child CLI/engine under test can never inherit the parent's
 * guest bridge socket or suite capability.
 */
export function stripGuestSuiteEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const key of GUEST_SUITE_ENV_KEYS) delete out[key];
  return out;
}
