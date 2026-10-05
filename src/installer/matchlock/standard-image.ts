/**
 * The standard Matchlock image used when the operator opts into Matchlock
 * without naming an image. Multi-arch (linux/amd64 + linux/arm64);
 * provisioned out of band (`tamandua matchlock setup`); admission resolves
 * the host-architecture variant from the local store and pins its
 * content+config identity. The bare reference is the single canonical
 * spelling — never append `:latest` (the registry resolves the bare
 * reference to its default tag; matchlock's store lookup is exact-string).
 * A locally built/imported entry under the same tag shadows the registry
 * image and IS used (accepted operator override; setup warns).
 *
 * Node-core only and deliberately PURE: no `node:child_process`, no `node:fs`,
 * so it stays in the parallel lane and can ride the guest-pack walk closure.
 */
export const STANDARD_MATCHLOCK_IMAGE = "igorhvr/tamandua";

/** Env override for the standard reference (consulted only on opt-in). */
export const MATCHLOCK_IMAGE_ENV = "TAMANDUA_MATCHLOCK_IMAGE";

/** Where the effective image reference came from (persisted provenance). */
export type MatchlockImageSource = "explicit" | "standard";

export function resolveMatchlockImageReference(opts: {
  /** True when an opt-in flag (`--matchlock` or `--matchlock-image`) was seen. */
  requested: boolean;
  /** From `--matchlock-image`; the raw operator string, trimmed here. */
  explicitImage?: string;
  /** Environment snapshot for {@link MATCHLOCK_IMAGE_ENV}; `{}` keeps it pure. */
  env?: NodeJS.ProcessEnv;
}): { image: string; source: MatchlockImageSource } | undefined {
  // Without any opt-in the run stays native: never consult the env at all.
  if (!opts.requested && !opts.explicitImage) return undefined;
  const explicit = opts.explicitImage?.trim();
  if (explicit) return { image: explicit, source: "explicit" };
  const standard =
    (opts.env?.[MATCHLOCK_IMAGE_ENV] ?? "").trim() || STANDARD_MATCHLOCK_IMAGE;
  return { image: standard, source: "standard" };
}
