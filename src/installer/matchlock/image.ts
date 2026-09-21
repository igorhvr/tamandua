/**
 * image.ts — US-002.
 *
 * Resolve and pin the Matchlock image identity. The image-admission handler
 * verifies the `create.image_identity` field against the ACTUAL built image
 * BEFORE any VM is created, fail-closed on any digest/config_digest mismatch.
 * This module resolves the requested tag, validates the non-empty identity,
 * and builds the pinned expectation the controller passes to every `create`
 * (so a retry/replacement that resolved a DIFFERENT image fails closed).
 */

import type { MatchlockImageIdentity } from "./types.js";

export interface PinnedImageIdentity {
  digest: string;
  config_digest: string;
  tag: string;
}

export class MatchlockImageError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MatchlockImageError";
    this.code = code;
  }
}

/**
 * Extract the USER IMAGE's effective guest PATH from a resolve_image result
 * (`oci.env.PATH` when the runtime records the image's OCI config env). The
 * runner prepends only the helper-pack bin to this PATH — never a host
 * default — so a user image whose pi/runtime lives at a NON-default PATH
 * keeps working. Returns undefined when the image declares no PATH (or the
 * result carries no OCI env) — callers then fall back to a conservative
 * default.
 */
export function imageEffectivePathFromResolved(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const oci = r.oci;
  if (typeof oci !== "object" || oci === null) return undefined;
  const env = (oci as Record<string, unknown>).env;
  if (typeof env !== "object" || env === null) return undefined;
  const pathValue = (env as Record<string, unknown>).PATH;
  if (typeof pathValue !== "string") return undefined;
  const trimmed = pathValue.trim();
  if (trimmed === "" || trimmed.length > 8192 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

/**
 * Validate a resolve_image result: the identity must pin a digest and a
 * config_digest — an identity that pins nothing cannot be verified. Returns
 * the pinned expectation to forward to `create.image_identity`.
 */
export function validateResolvedImageIdentity(raw: unknown): PinnedImageIdentity {
  return validatePinnedIdentity(raw, "resolve_image");
}

/**
 * Validate ANY pinned identity (a fresh resolve OR a persisted expected
 * identity read back from run state). The `sourceLabel` names where the
 * identity came from for actionable errors.
 */
export function validatePinnedIdentity(raw: unknown, sourceLabel = "identity"): PinnedImageIdentity {
  if (typeof raw !== "object" || raw === null) {
    throw new MatchlockImageError("image_unusable", `${sourceLabel} returned a non-object identity: ${String(raw)}`);
  }
  const r = raw as Record<string, unknown>;
  const digest = typeof r.digest === "string" ? r.digest : "";
  const config_digest = typeof r.config_digest === "string" ? r.config_digest : "";
  const tag = typeof r.tag === "string" ? r.tag : "";
  if (digest === "" && config_digest === "") {
    throw new MatchlockImageError(
      "image_unusable",
      `${sourceLabel} identity pins nothing (no digest and no config_digest).`,
    );
  }
  if (digest === "" && config_digest !== "") {
    throw new MatchlockImageError("image_unusable", `${sourceLabel} identity has a config_digest but no digest.`);
  }
  if (digest !== "" && config_digest === "") {
    throw new MatchlockImageError("image_unusable", `${sourceLabel} identity has a digest but no config_digest.`);
  }
  return { digest, config_digest, tag };
}

/**
 * Host-side defense-in-depth verification of a resolved/pinned identity
 * against an expected pin. The runtime independently verifies; this is used
 * to reject an obviously mismatched retry before ever issuing `create`.
 */
export function verifyImageIdentity(expected: PinnedImageIdentity, actual: PinnedImageIdentity): void {
  if (expected.digest !== actual.digest) {
    throw new MatchlockImageError(
      "image_identity_mismatch",
      `image identity digest mismatch: expected "${expected.digest}", actual "${actual.digest}"`,
    );
  }
  if (expected.config_digest !== actual.config_digest) {
    throw new MatchlockImageError(
      "image_identity_mismatch",
      `image identity config_digest mismatch: expected "${expected.config_digest}", actual "${actual.config_digest}"`,
    );
  }
  if (expected.tag !== "" && actual.tag !== "" && expected.tag !== actual.tag) {
    throw new MatchlockImageError(
      "image_identity_mismatch",
      `image identity tag mismatch: expected "${expected.tag}", actual "${actual.tag}"`,
    );
  }
}

/**
 * Resolve the image via the RPC client and return the pinned identity. The
 * caller is responsible for passing a configured client whose `start()` has
 * been called.
 */
export async function resolveImageIdentity(
  resolve: (tag: string) => Promise<unknown>,
  tag: string,
): Promise<PinnedImageIdentity> {
  const raw = await resolve(tag);
  return validateResolvedImageIdentity(raw);
}

/**
 * Extract the image's declared effective guest PATH from a resolve_image
 * result (`oci.env.PATH`). Returns null when the image config does not
 * declare a PATH (the caller then falls back to a conservative POSIX default
 * — but never when the image declares one). A malformed declared PATH
 * (control characters) fails closed as image_unusable: silently dropping a
 * nonstandard image PATH could launch the harness against the wrong PATH.
 */
export function imagePathFromOciConfig(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const oci = r.oci;
  if (typeof oci !== "object" || oci === null) return null;
  const env = (oci as Record<string, unknown>).env;
  if (typeof env !== "object" || env === null) return null;
  const declared = (env as Record<string, unknown>).PATH;
  if (typeof declared !== "string") return null;
  const trimmed = declared.trim();
  if (trimmed === "") return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new MatchlockImageError(
      "image_unusable",
      "resolve_image config env PATH is malformed (control characters); refusing to run the guest with an unverifiable PATH.",
    );
  }
  return trimmed;
}

/**
 * Resolve the image and return BOTH the pinned immutable identity and the
 * image's declared OCI-config PATH (when declared). The PATH is captured at
 * admission so dispatch can prepend ONLY the helper-pack bin to the image's
 * own effective PATH (never re-resolved/re-pinned later).
 */
export async function resolveImageIdentityWithConfig(
  resolve: (tag: string) => Promise<unknown>,
  tag: string,
): Promise<{ pin: PinnedImageIdentity; imagePath: string | null }> {
  const raw = await resolve(tag);
  return {
    pin: validateResolvedImageIdentity(raw),
    imagePath: imagePathFromOciConfig(raw),
  };
}
