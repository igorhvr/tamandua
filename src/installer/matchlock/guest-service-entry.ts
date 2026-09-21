/**
 * Guest bridge service process entry (exec'd by the controller with its
 * stdin/stdout attached to the dedicated exec pipe).
 *
 * Node-core only — safe for the guest pack closure.
 */

import { startGuestBridgeService } from "./guest-service.js";
import { GUEST_PACK_LAYOUT_VERSION } from "./guest-protocol.js";

function envGet(name: string): string | undefined {
  return process.env[name];
}

function intEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 120_000);
}

async function main(): Promise<void> {
  const helperBuildVersion = process.env.TAMANDUA_GUEST_BUILD_VERSION?.trim() ?? "unknown";
  const claimedRunId = process.env.TAMANDUA_RUN_ID?.trim() || undefined;
  const claimedInvocationId = process.env.TAMANDUA_INVOCATION_ID?.trim() || undefined;
  const claimedAgentId = process.env.TAMANDUA_WORKER_AGENT_ID?.trim() || undefined;
  // MTLK-SUITE-WIRE: suite ops are served ONLY when the controller launched
  // this bridge service against a suite-capable host broker (env is set by
  // the host wiring alongside the injected host suite transport bridge).
  const suiteEnabled = process.env.TAMANDUA_GUEST_SUITE_ENABLED?.trim() === "1";

  const handle = await startGuestBridgeService({
    helperBuildVersion,
    packLayoutVersion: GUEST_PACK_LAYOUT_VERSION,
    handshakeTimeoutMs: intEnv("TAMANDUA_BRIDGE_HANDSHAKE_TIMEOUT_MS"),
    requestTimeoutMs: intEnv("TAMANDUA_BRIDGE_REQUEST_TIMEOUT_MS"),
    shutdownFlushMs: intEnv("TAMANDUA_BRIDGE_SHUTDOWN_FLUSH_MS"),
    suiteEnabled,
    claimedIdentity: {
      ...(claimedRunId ? { runId: claimedRunId } : {}),
      ...(claimedInvocationId ? { invocationId: claimedInvocationId } : {}),
      ...(claimedAgentId ? { agentId: claimedAgentId } : {}),
    },
  });

  const shutdown = (): void => {
    void handle.shutdown().then((code) => {
      process.exitCode = code;
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);

  const ready = await handle.ready;
  if (!ready.ok) {
    process.stderr.write(`[guest-bridge] handshake failed: ${ready.reason ?? "unknown"}\n`);
    // The service fails closed (no commands served) and shuts itself down.
  }
  const code = await handle.exited;
  process.exitCode = code;
}

main().catch((err: unknown) => {
  process.stderr.write(`[guest-bridge] fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
