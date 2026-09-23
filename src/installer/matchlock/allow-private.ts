/**
 * MTLK-ALLOW-PRIVATE — shared shape validator for Matchlock allow-private
 * entries.
 *
 * One pure, dependency-free leaf module (node core only; no other matchlock
 * imports) so the CLI flag parser, the persisted-policy parser and admission
 * all enforce EXACTLY one rule set. The rule set is deliberately SHAPE-ONLY:
 * a host name is not resolved and a CIDR is not expanded here — resolution and
 * the rebinding-safe name matching are the matchlock fork's job.
 *
 * Entry grammar (mirrors `matchlock run --allow-private <entry>`, repeatable):
 *   - a host name: `[A-Za-z0-9._-]+` containing at least one alphanumeric;
 *   - an IPv4 literal (strict dotted quad, no leading zeros);
 *   - a bare IPv6 literal (no port — use `[addr]:port` to attach a port);
 *   - an IPv4 or IPv6 CIDR (`<addr>/<prefix>`);
 *   - any of the above with an optional `:port` suffix (1-65535). A bracketed
 *     destination uses `[addr]:port`; brackets are required for an IPv6
 *     literal + port because a bare `fe80::1:8080` is itself a valid IPv6
 *     literal.
 * Reject empty, whitespace/control-bearing, malformed-bracket and
 * invalid-port inputs with a reason that names the offending entry.
 *
 * The list of entries is bounded ({@link MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES});
 * the bound is enforced by {@link assertAllowPrivateEntries} rather than by the
 * per-entry shape check.
 */

import { isIPv6 } from "node:net";

/** Operator env var supplying the allow-private list when the flag is absent. */
export const MATCHLOCK_ALLOW_PRIVATE_ENV = "TAMANDUA_MATCHLOCK_ALLOW_PRIVATE";

/** Maximum number of allow-private entries accepted in one run policy. */
export const MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES = 64;

/** Maximum length of a single allow-private entry (a bounded string). */
export const MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRY_LENGTH = 512;

/**
 * Human-readable shape grammar, shared by the CLI help / usage errors and the
 * admission refusal so the wording cannot drift between callers.
 */
export const MATCHLOCK_ALLOW_PRIVATE_GRAMMAR =
  "a host name, an IPv4/IPv6 literal or CIDR, optionally suffixed with :port " +
  "(a bracketed IPv6 destination uses [addr]:port; a bare IPv6 literal carries no port)";

/** Result of validating one entry's shape. */
export type AllowPrivateEntryValidation = { ok: true } | { ok: false; reason: string };

/** A truncated, quoted rendering of an entry so reasons stay readable. */
function describeEntry(entry: unknown): string {
  if (typeof entry !== "string") return `(${typeof entry})`;
  const preview = entry.length > 120 ? `${entry.slice(0, 120)}…` : entry;
  return JSON.stringify(preview);
}

function reject(entry: unknown, detail: string): AllowPrivateEntryValidation {
  return { ok: false, reason: `invalid allow-private entry ${describeEntry(entry)}: ${detail}` };
}

function isControlFree(v: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(v);
}

function hasWhitespace(v: string): boolean {
  return /\s/.test(v);
}

/** Strict dotted-quad IPv4 literal (no leading zeros, matching Go's ParseIP). */
function isIPv4Literal(v: string): boolean {
  const parts = v.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

/**
 * IPv6 literal. `node:net` accepts a zone id (`fe80::1%eth0`), which is not a
 * destination matchlock can honour, so those are rejected here.
 */
function isIPv6Literal(v: string): boolean {
  return isIPv6(v) && !v.includes("%");
}

/** A host-name-shaped token: charset plus at least one alphanumeric character. */
function isHostName(v: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(v) && /[A-Za-z0-9]/.test(v);
}

/** Classify an IPv4 or IPv6 CIDR, or null when it is not one. */
function classifyCidr(v: string): "cidr4" | "cidr6" | null {
  const slash = v.indexOf("/");
  if (slash < 0 || v.indexOf("/", slash + 1) >= 0) return null;
  const addr = v.slice(0, slash);
  const prefixText = v.slice(slash + 1);
  if (!/^\d{1,3}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (isIPv4Literal(addr)) return prefix <= 32 ? "cidr4" : null;
  if (isIPv6Literal(addr)) return prefix <= 128 ? "cidr6" : null;
  return null;
}

type EntryBaseKind = "host" | "ipv4" | "ipv6" | "cidr4" | "cidr6";

/** Classify the base (address/name) part of an entry, ignoring any port. */
function classifyBase(v: string): EntryBaseKind | null {
  if (isIPv6Literal(v)) return "ipv6";
  if (isIPv4Literal(v)) return "ipv4";
  const cidr = classifyCidr(v);
  if (cidr !== null) return cidr;
  if (isHostName(v)) return "host";
  return null;
}

function isValidPortText(portText: string): boolean {
  if (!/^\d{1,5}$/.test(portText)) return false;
  const port = Number(portText);
  return port >= 1 && port <= 65535;
}

/**
 * True when `v` is a string shaped like a valid allow-private entry. Never
 * throws; it is the cheap guard for structured inputs (e.g. a persisted policy
 * record).
 */
export function isAllowPrivateEntryShape(v: unknown): boolean {
  return typeof v === "string" && validateAllowPrivateEntry(v).ok;
}

/**
 * Validate one allow-private entry's SHAPE (no DNS resolution, no CIDR
 * expansion). Returns `{ ok: true }` or `{ ok: false, reason }` where the
 * reason names the offending entry.
 */
export function validateAllowPrivateEntry(entry: string): AllowPrivateEntryValidation {
  if (typeof entry !== "string") {
    return { ok: false, reason: `allow-private entry must be a string (got ${typeof entry})` };
  }
  if (entry.length === 0) {
    return reject(entry, "must be a non-empty string");
  }
  if (entry.length > MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRY_LENGTH) {
    return reject(
      entry,
      `is too long (${entry.length} > ${MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRY_LENGTH} characters)`,
    );
  }
  if (!isControlFree(entry)) {
    return reject(entry, "must not contain control characters");
  }
  if (hasWhitespace(entry)) {
    return reject(entry, "must not contain whitespace");
  }

  // Bracketed form `[addr]:port` (the only form that attaches a port to an
  // IPv6 literal). Wrapping a bracketed host name / IPv4 also works; the
  // address shape still has to be valid.
  if (entry.startsWith("[")) {
    const match = /^\[([^[\]]+)\](.*)$/.exec(entry);
    if (match === null || !match[2].startsWith(":")) {
      return reject(entry, "has malformed brackets; a bracketed destination uses [addr]:port");
    }
    if (classifyBase(match[1]) === null) {
      return reject(entry, "bracketed destination must enclose a valid host name, IP literal or CIDR");
    }
    if (!isValidPortText(match[2].slice(1))) {
      return reject(entry, "port must be an integer in the range 1-65535");
    }
    return { ok: true };
  }
  if (entry.includes("[") || entry.includes("]")) {
    return reject(entry, "has malformed brackets");
  }

  // A bare IPv6 literal or CIDR carries no port (a colon would be part of the
  // address), so recognize it before attempting any port split.
  const bareV6 = isIPv6Literal(entry) ? "ipv6" : classifyCidr(entry);
  if (bareV6 !== null) return { ok: true };

  // CIDR first: a `/` that survives the checks above is a malformed CIDR, or a
  // CIDR with an attached `:port` (e.g. `10.0.0.0/8:8443`).
  if (entry.includes("/")) {
    const colon = entry.lastIndexOf(":");
    if (colon >= 0) {
      const portText = entry.slice(colon + 1);
      if (isValidPortText(portText) && classifyCidr(entry.slice(0, colon)) !== null) {
        return { ok: true };
      }
    }
    return reject(entry, "must be an IPv4/IPv6 CIDR with a prefix in range");
  }

  const colon = entry.lastIndexOf(":");
  if (colon >= 0) {
    const portText = entry.slice(colon + 1);
    if (!isValidPortText(portText)) {
      return reject(entry, "port must be an integer in the range 1-65535");
    }
    const baseKind = classifyBase(entry.slice(0, colon));
    if (baseKind === null) {
      return reject(entry, `must be ${MATCHLOCK_ALLOW_PRIVATE_GRAMMAR}`);
    }
    if (baseKind === "ipv6") {
      return reject(entry, "a bare IPv6 literal carries no port; use [addr]:port");
    }
    return { ok: true };
  }

  if (classifyBase(entry) !== null) return { ok: true };
  return reject(entry, `must be ${MATCHLOCK_ALLOW_PRIVATE_GRAMMAR}`);
}

/**
 * Normalize a list of entries: trim each, drop blanks, and dedupe preserving
 * first-seen order. Non-string elements are dropped defensively; call
 * {@link assertAllowPrivateEntries} when a malformed element must be an error.
 */
export function normalizeAllowPrivateEntries(entries: readonly string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(entries)) return normalized;
  for (const raw of entries) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

/**
 * Parse the comma-separated env default (`TAMANDUA_MATCHLOCK_ALLOW_PRIVATE`):
 * trim segments, drop blanks and dedupe preserving first-seen order. A missing
 * or non-string value yields an empty list.
 */
export function parseAllowPrivateEnv(raw: string | null | undefined): string[] {
  if (typeof raw !== "string") return [];
  return normalizeAllowPrivateEntries(raw.split(","));
}

/**
 * Validate and normalize a caller-supplied entry list. Each entry is trimmed
 * before validation; an entry that fails the shape grammar, an explicit empty
 * entry, an oversized list, or a non-string element throws an Error naming the
 * offending entry and the shape grammar. On success returns the normalized
 * (trimmed, deduped, blank-free) list.
 */
export function assertAllowPrivateEntries(entries: readonly string[], what: string): string[] {
  if (!Array.isArray(entries)) {
    throw new Error(`${what}: allow-private entries must be a list (got ${typeof entries})`);
  }
  if (entries.length > MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES) {
    throw new Error(
      `${what}: too many allow-private entries (${entries.length}); ` +
        `at most ${MATCHLOCK_ALLOW_PRIVATE_MAX_ENTRIES} are supported.`,
    );
  }
  for (const raw of entries) {
    if (typeof raw !== "string") {
      throw new Error(`${what}: allow-private entry must be a string (got ${typeof raw})`);
    }
    const result = validateAllowPrivateEntry(raw.trim());
    if (!result.ok) {
      throw new Error(`${what}: ${result.reason}. Entries are ${MATCHLOCK_ALLOW_PRIVATE_GRAMMAR}.`);
    }
  }
  return normalizeAllowPrivateEntries(entries);
}
