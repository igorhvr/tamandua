/**
 * Test-only helper: exact invocation-ownership survivor cleanup.
 *
 * The describe-level after hooks in tests/mcp-lifecycle.test.ts and
 * tests/get-ready-dashboard-port.test.ts used to scavenge leaked daemon/MCP
 * survivors by matching a shared HOME/log-path PREFIX (for example
 * "tamandua-mcp-lifecycle" or "tamandua-get-ready-port-"). A prefix match
 * cannot tell the current invocation's temp roots apart from a concurrent
 * invocation's roots that merely share the prefix, so both were signalled
 * (see the synthetic-after-hook proof recorded for US-002).
 *
 * This module replaces the prefix check with an ownership decision:
 *
 * - pgrep candidate discovery stays in the calling test files; each
 *   candidate here is a pid whose command line matched the service pattern.
 * - A candidate is signalled only when its CURRENT ownership evidence points
 *   EXACTLY at a temp root created by the current invocation (see
 *   ownedTempRoots() in ./test-env.ts) or at a descendant below it — never a
 *   loose prefix/substring match. Ownership evidence is platform-observed:
 *   on linux the HOME entry from the process environ pseudo-file (procfs);
 *   on darwin the open file paths reported by `lsof -p <pid> -Fn` (the
 *   services keep their log fd open under the temp home, which lsof
 *   reports).
 * - Process identity is re-verified immediately before EACH signal. When the
 *   invocation recorded (pid, getProcessStartIdentity(pid)) at spawn or
 *   PID-file-read time, the recorded and current values are compared with
 *   compareProcessStartIdentities() (the versioned v2 matcher), never with
 *   string equality. A `'different'` verdict (PID reuse / stale identity), an
 *   `'unknown'` verdict (a persisted legacy ps:/proc: value, a non-comparable
 *   v2u: value, or a malformed/empty value) and an unavailable current
 *   identity are all refusals. When nothing was recorded, the decision-time
 *   identity snapshot is re-verified at signal time through the same matcher
 *   so reuse inside the decision→signal window is still caught.
 * - Unavailable evidence is a REFUSAL, never cleanup: an unreadable or
 *   inaccessible observation yields a distinct outcome and no signal.
 *
 * The decision engine (cleanupInvocationOwnedSurvivors) takes injectable
 * observation/signal bindings so it can be proven with recording fakes and
 * no real process selectors or signals (see
 * ./invocation-owned-cleanup.test.ts). This is a tests/ helper only: no
 * product process manager, runtime cleanup, daemonctl, scheduler or DB
 * change participates.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { getEnvironText } from "../../dist/lib/proc-info.js";
import {
  compareProcessStartIdentities,
  getProcessStartIdentity,
} from "../../src/lib/process-start-identity.ts";
import { ownedTempRoots } from "./test-env.ts";

/**
 * Current ownership evidence for one candidate pid.
 *
 * - "ok": the observation succeeded; `paths` holds the observed path
 *   evidence (linux: the HOME value; darwin: the open file paths). A
 *   readable observation with no paths is still "ok" — it just cannot prove
 *   ownership (empty evidence is a refusal, not cleanup).
 * - "unreadable": the observation could not be completed for a reason other
 *   than the process being gone (e.g. EPERM on /proc, lsof failure on a
 *   still-live process). Distinct from an empty proof on purpose: this is
 *   unavailable evidence and therefore a refusal.
 * - "gone": the process no longer exists (no signal needed or possible).
 */
export type OwnershipObservation =
  | { kind: "ok"; paths: readonly string[] }
  | { kind: "unreadable" }
  | { kind: "gone" };

/** Why a candidate was skipped (never signalled). */
export type SkipReason =
  | "gone" // process already exited when first observed
  | "unreadable-evidence" // evidence could not be read → refusal
  | "not-owned" // readable evidence points outside every owned root
  | "identity-unavailable" // recorded identity exists but current identity is unreadable
  | "identity-unknown-format" // recorded/current identity is legacy ps:/proc:, v2u:, malformed or empty → never comparable
  | "identity-mismatch" // recorded identity differs from current (PID reuse / stale identity)
  | "exited-before-signal" // recheck: process exited before the signal
  | "evidence-changed-before-signal" // recheck: evidence no longer proves ownership
  | "identity-changed-before-signal"; // recheck: identity no longer matches the decision baseline

/** Per-candidate disposition returned by {@link cleanupInvocationOwnedSurvivors}. */
export type SurvivorDisposition =
  | { pid: number; outcome: "signalled" }
  | { pid: number; outcome: "skipped"; reason: SkipReason };

/** Injectable bindings that make the decision testable without real processes. */
export interface OwnedSurvivorCleanupBindings {
  /** Exact canonical temp roots owned by the current invocation. */
  ownedRoots: readonly string[];
  /** Read the current ownership evidence for `pid`. Must never throw. */
  observe: (pid: number) => OwnershipObservation;
  /**
   * Current process-start identity for `pid` (null when unavailable or on
   * platforms that cannot compute one). Real binding:
   * getProcessStartIdentity from src/lib/process-start-identity.ts.
   */
  identityOf: (pid: number) => string | null;
  /**
   * Identity recorded at spawn/PID-file-read time, or null when the
   * invocation recorded nothing for this pid. Optional; defaults to "never
   * recorded".
   */
  recordedIdentityOf?: (pid: number) => string | null;
  /** Send the real signal. Called only after ownership is re-proven. */
  signal: (pid: number) => void;
}

// ── Pure evidence parsers (platform observation semantics) ────────────

/**
 * Parse NUL-separated Linux process-environ text (as read from the procfs
 * environ pseudo-file) and return the HOME value, or null when the process
 * environment has no HOME entry.
 */
export function parseLinuxEnvironHome(rawEnviron: string): string | null {
  for (const entry of rawEnviron.split("\0")) {
    if (entry.startsWith("HOME=")) return entry.slice("HOME=".length);
  }
  return null;
}

/**
 * Parse `lsof -p <pid> -Fn` output into the list of open file name paths
 * (the lines prefixed with "n"). Non-name lines and empty names are
 * ignored. lsof marks unlinked files with a trailing " (deleted)" — the
 * suffix is stripped because the fd still proves the process held that path.
 */
export function parseDarwinLsofPaths(rawLsof: string): string[] {
  const paths: string[] = [];
  for (const line of rawLsof.split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    let filePath = line.slice(1).trim();
    if (filePath === "") continue;
    if (filePath.endsWith(" (deleted)")) {
      filePath = filePath.slice(0, -" (deleted)".length);
    }
    paths.push(filePath);
  }
  return paths;
}

// ── Exact ownership boundary matching ────────────────────────────────

/**
 * True when `evidencePath` is EXACTLY an owned root or a descendant below it
 * separated by path.sep — never a loose prefix/substring match. This is what
 * refuses prefix-neighbor roots (e.g. .../tamandua-mcp-lifecycle-<B>/home
 * when only .../tamandua-mcp-lifecycle-<A> is owned) and same-prefix roots
 * of other invocations.
 */
export function evidencePathOwned(
  evidencePath: string,
  ownedRoots: readonly string[],
): boolean {
  const normalized = path.normalize(evidencePath);
  for (const root of ownedRoots) {
    const normalizedRoot = path.normalize(root);
    if (normalized === normalizedRoot) return true;
    if (normalized.startsWith(`${normalizedRoot}${path.sep}`)) return true;
  }
  return false;
}

/** True when at least one observed evidence path is owned. */
export function hasOwnedEvidence(
  paths: readonly string[],
  ownedRoots: readonly string[],
): boolean {
  return paths.some((p) => evidencePathOwned(p, ownedRoots));
}

// ── Decision engine ──────────────────────────────────────────────────

/**
 * Decide, for every candidate pid, whether it is a survivor owned by the
 * current invocation and signal it — re-verifying current evidence and
 * process identity immediately before EACH signal.
 *
 * Refusals (never signalled): unreadable evidence, readable evidence outside
 * every owned root, a recorded identity that is legacy/unknown-format
 * (identity-unknown-format), a recorded-identity mismatch (PID reuse / stale
 * identity) and unavailable identity when one was recorded. Between decision
 * and signal the evidence and identity are re-observed: a process that exited
 * or whose evidence/identity changed is skipped, never signalled on stale
 * proof.
 */
export function cleanupInvocationOwnedSurvivors(
  pids: Iterable<number>,
  bindings: OwnedSurvivorCleanupBindings,
): SurvivorDisposition[] {
  const dispositions: SurvivorDisposition[] = [];
  const recordedIdentityOf = bindings.recordedIdentityOf ?? (() => null);

  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;

    // ── Decision phase: prove CURRENT ownership before any signal. ──
    const decision = bindings.observe(pid);
    if (decision.kind === "gone") {
      dispositions.push({ pid, outcome: "skipped", reason: "gone" });
      continue;
    }
    if (decision.kind === "unreadable") {
      dispositions.push({ pid, outcome: "skipped", reason: "unreadable-evidence" });
      continue;
    }
    if (!hasOwnedEvidence(decision.paths, bindings.ownedRoots)) {
      dispositions.push({ pid, outcome: "skipped", reason: "not-owned" });
      continue;
    }

    // ── Identity gate. ──
    // Recorded-vs-current uses the versioned v2 matcher, never string
    // equality: a persisted legacy ps:/proc: value (or a v2u:/malformed one)
    // is 'unknown' and must refuse, so an upgrade can never signal a process
    // it cannot prove it owns.
    const recorded = recordedIdentityOf(pid);
    let decisionIdentity: string | null;
    if (recorded !== null) {
      const current = bindings.identityOf(pid);
      if (current === null) {
        dispositions.push({ pid, outcome: "skipped", reason: "identity-unavailable" });
        continue;
      }
      const verdict = compareProcessStartIdentities(recorded, current);
      if (verdict === "unknown") {
        dispositions.push({ pid, outcome: "skipped", reason: "identity-unknown-format" });
        continue;
      }
      if (verdict === "different") {
        dispositions.push({ pid, outcome: "skipped", reason: "identity-mismatch" });
        continue;
      }
      // 'same': both sides are well-formed v2 — keep the freshly read value
      // as the recheck baseline.
      decisionIdentity = current;
    } else {
      // No spawn-time record for this pid: snapshot the identity now so the
      // pre-signal recheck can detect PID reuse inside the decision→signal
      // window.
      decisionIdentity = bindings.identityOf(pid);
    }

    // ── Recheck phase: re-verify evidence AND identity immediately before
    // the signal; skip when the process exited or the evidence changed. ──
    const recheck = bindings.observe(pid);
    if (recheck.kind === "gone") {
      dispositions.push({ pid, outcome: "skipped", reason: "exited-before-signal" });
      continue;
    }
    if (
      recheck.kind === "unreadable" ||
      !hasOwnedEvidence(recheck.paths, bindings.ownedRoots)
    ) {
      dispositions.push({ pid, outcome: "skipped", reason: "evidence-changed-before-signal" });
      continue;
    }
    const recheckIdentity = bindings.identityOf(pid);
    if (
      decisionIdentity !== null &&
      compareProcessStartIdentities(decisionIdentity, recheckIdentity) !== "same"
    ) {
      dispositions.push({ pid, outcome: "skipped", reason: "identity-changed-before-signal" });
      continue;
    }

    bindings.signal(pid);
    dispositions.push({ pid, outcome: "signalled" });
  }

  return dispositions;
}

// ── Real platform observers (bound by the after hooks) ───────────────

/**
 * Linux observation: read the HOME entry from the pid's process environ
 * pseudo-file via the portable src/lib/proc-info.ts helper (getEnvironText
 * reads procfs only where it exists). When the read fails, the process
 * liveness probe decides "gone" (no signal needed) vs "unreadable"
 * evidence — unavailable evidence is a refusal, never an empty proof.
 */
export function observeLinuxPid(pid: number): OwnershipObservation {
  const environText = getEnvironText(pid);
  if (environText === null) {
    return pidIsGone(pid) ? { kind: "gone" } : { kind: "unreadable" };
  }
  const home = parseLinuxEnvironHome(environText);
  return { kind: "ok", paths: home === null ? [] : [home] };
}

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: unknown) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/**
 * Darwin observation: read the open file paths via `lsof -p <pid> -Fn`.
 * When lsof fails the process liveness decides "gone" vs "unreadable".
 */
export function observeDarwinPid(pid: number): OwnershipObservation {
  let raw: string;
  try {
    raw = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return pidIsGone(pid) ? { kind: "gone" } : { kind: "unreadable" };
  }
  return { kind: "ok", paths: parseDarwinLsofPaths(raw) };
}

/** Observation binding for the current host; unsupported hosts refuse. */
export function realOwnershipObserver(): (pid: number) => OwnershipObservation {
  if (process.platform === "darwin") return observeDarwinPid;
  if (process.platform === "linux") return observeLinuxPid;
  return () => ({ kind: "unreadable" });
}

/** Real signal binding: SIGKILL, tolerating the pid exiting in between. */
export function sigkillSurvivor(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the recheck and the signal — the goal (no
    // owned survivor left) is already met.
  }
}

/**
 * After-hook entry point for the affected describe-level hooks: sweep pgrep
 * candidates through the invocation-ownership decision bound to the real
 * platform observers, the current invocation's owned temp roots, and SIGKILL.
 *
 * pids may be strings (pgrep output) or numbers; non-positive/non-integer
 * entries are ignored. Unavailable evidence, prefix neighbors, other
 * invocations, legacy/unknown identity formats and stale identities are
 * refused; only survivors whose current evidence points exactly inside an
 * owned root are signalled (after an immediate evidence+identity recheck).
 */
export function sweepInvocationOwnedLeakedSurvivors(
  pids: Iterable<number | string>,
): SurvivorDisposition[] {
  const numericPids: number[] = [];
  for (const raw of pids) {
    const n = typeof raw === "string" ? Number(raw) : raw;
    if (Number.isSafeInteger(n) && n > 0) numericPids.push(n);
  }
  if (numericPids.length === 0) return [];
  return cleanupInvocationOwnedSurvivors(numericPids, {
    ownedRoots: ownedTempRoots(),
    observe: realOwnershipObserver(),
    identityOf: getProcessStartIdentity,
    signal: sigkillSurvivor,
  });
}
