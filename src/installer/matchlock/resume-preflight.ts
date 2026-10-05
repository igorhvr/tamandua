/**
 * resume-preflight.ts — MTLK-ISO2-CORRECTIVE (Family B1/B2).
 *
 * The ONE shared ordered consented-resume preflight used by BOTH resume forms
 * (the paused/draining control-plane resume and the failed-run resume). It
 * implements spec C §4.4's executable order up to (but NOT including) the
 * durable commit:
 *
 *   (1) structural validation of the persisted policy — the callers classify
 *       and parse it before invoking this helper (no Matchlock interaction);
 *   (2) effective root permission — recorded inherited consent OR the R13
 *       override supplied to THIS action;
 *   (3) the permitted Matchlock checks — the swap-capability handshake AND the
 *       inherited-image resolve + re-verification — BEFORE any state write;
 *   (4) the caller then commits consent + scheduling coherently.
 *
 * This module performs NO database write and opens no transaction: the RPC /
 * subprocess work above always completes before the caller's short synchronous
 * commit, so no transaction can span subprocess work. Both resume forms import
 * this single helper so they cannot drift.
 */

import {
  MatchlockAdmissionError,
  assertMatchlockSwapSupport,
  matchlockRootUsageRefusalText,
  pinFromPolicy,
  MATCHLOCK_RPC_ARGS_ENV,
} from "./admission.js";
import { MatchlockRpcClient } from "./rpc-client.js";
import {
  MatchlockImageError,
  resolveImageIdentityWithConfig,
  verifyImageIdentity,
} from "./image.js";
import type { MatchlockSwapSupportProbe } from "./swap-support.js";
import type { ExecutionIsolation } from "./policy.js";

/**
 * Inherited-image resolve + re-verify seam. Production uses
 * {@link verifyInheritedMatchlockImageIdentity} over an owned RPC; tests inject
 * a deterministic moved/absent/supporting verifier.
 */
export type InheritedImageVerifier = (
  policy: ExecutionIsolation,
  resolvedBinaryPath: string,
) => Promise<void>;

export interface MatchlockResumePreflightOptions {
  /** The already structurally-validated persisted policy. */
  policy: ExecutionIsolation;
  /** Effective-uid of the process performing THIS resume. */
  effectiveUid: () => number;
  /** Explicit inherited consent recorded on the persisted policy. */
  inheritedRootConsent: boolean;
  /** The R13 override supplied to THIS action. */
  rootUsageOverride: boolean;
  /** Injectable swap-support probe (tests). */
  swapSupportProbe?: MatchlockSwapSupportProbe;
  /** Injectable inherited-image verifier (tests). */
  verifyInheritedImage?: InheritedImageVerifier;
  /** Explicit rpc binary override (tests). */
  rpcBinaryPath?: string;
  /** Explicit rpc args override (tests). */
  rpcArgs?: string[];
}

export type MatchlockResumePreflightResult =
  | {
      ok: true;
      /** True when THIS action grants previously-unrecorded root consent. */
      grantConsent: boolean;
      /** The ONE probed absolute binary path to thread into the transport. */
      resolvedBinaryPath: string;
    }
  | { ok: false; code: string; message: string };

function resolveRpcArgs(rpcArgs?: string[]): string[] {
  if (rpcArgs && rpcArgs.length > 0) return rpcArgs;
  const raw = process.env[MATCHLOCK_RPC_ARGS_ENV]?.trim();
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
        return parsed as string[];
      }
    } catch {
      /* fall through to the default */
    }
  }
  return ["rpc"];
}

/**
 * Production inherited-image verifier: resolve the persisted image over an
 * OWNED bounded RPC transport (resolve_image only, never create), compare the
 * freshly observed identity against the persisted pin, and dispose the
 * transport on every path. A moved/retagged/absent image fails closed with a
 * typed `MatchlockImageError`/`MatchlockAdmissionError`.
 */
export async function verifyInheritedMatchlockImageIdentity(
  policy: ExecutionIsolation,
  resolvedBinaryPath: string,
  rpcArgs?: string[],
): Promise<void> {
  const client = new MatchlockRpcClient({
    binaryPath: resolvedBinaryPath,
    args: resolveRpcArgs(rpcArgs),
    requestTimeoutMs: 45_000,
    stdinDrainTimeoutMs: 5_000,
    readyTimeoutMs: 5_000,
  });
  client.start();
  try {
    const { pin } = await resolveImageIdentityWithConfig(
      (tag) => client.resolveImage(tag),
      policy.requestedImage,
    );
    verifyImageIdentity(pinFromPolicy(policy), pin);
  } catch (err) {
    if (err instanceof MatchlockAdmissionError || err instanceof MatchlockImageError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new MatchlockAdmissionError(
      "image_unusable",
      `Failed to re-verify the inherited Matchlock image pin for "${policy.requestedImage}": ${message}. ` +
        "Refusing to resume; no run state was changed.",
    );
  } finally {
    await client.dispose().catch(() => {});
  }
}

/**
 * Run the shared ordered consented-resume preflight. Returns a typed refusal
 * (no state write) or the consent decision + resolved binary path for the
 * caller's single short commit. Never touches the database.
 */
export async function runMatchlockResumePreflight(
  opts: MatchlockResumePreflightOptions,
): Promise<MatchlockResumePreflightResult> {
  // (2) effective root permission — before any Matchlock invocation.
  if (
    opts.effectiveUid() === 0 &&
    !opts.inheritedRootConsent &&
    !opts.rootUsageOverride
  ) {
    return {
      ok: false,
      code: "matchlock_root_usage_refused",
      message: matchlockRootUsageRefusalText(),
    };
  }

  // (3) permitted check 1: the SAME swap-capability handshake as admission.
  let resolvedBinaryPath: string;
  try {
    resolvedBinaryPath = await assertMatchlockSwapSupport({
      requestedImage: opts.policy.requestedImage,
      ...(opts.swapSupportProbe ? { swapSupportProbe: opts.swapSupportProbe } : {}),
      ...(opts.rpcBinaryPath ? { rpcBinaryPath: opts.rpcBinaryPath } : {}),
      ...(opts.rpcArgs ? { rpcArgs: opts.rpcArgs } : {}),
    });
  } catch (err) {
    if (err instanceof MatchlockAdmissionError) {
      return { ok: false, code: err.code, message: err.message };
    }
    throw err;
  }

  // (3) permitted check 2: inherited-image resolve + re-verification, using
  // the SAME resolved binary the round will launch.
  try {
    await (opts.verifyInheritedImage ?? defaultInheritedImageVerifier)(
      opts.policy,
      resolvedBinaryPath,
    );
  } catch (err) {
    if (err instanceof MatchlockAdmissionError) {
      return { ok: false, code: err.code, message: err.message };
    }
    if (err instanceof MatchlockImageError) {
      return { ok: false, code: err.code, message: err.message };
    }
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "image_unusable",
      message: `Failed to re-verify the inherited Matchlock image pin: ${message}. Refusing to resume; no run state was changed.`,
    };
  }

  return {
    ok: true,
    grantConsent: opts.rootUsageOverride && !opts.inheritedRootConsent,
    resolvedBinaryPath,
  };
}

const defaultInheritedImageVerifier: InheritedImageVerifier = (policy, binaryPath) =>
  verifyInheritedMatchlockImageIdentity(policy, binaryPath);
