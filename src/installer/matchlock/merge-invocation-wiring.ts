/**
 * merge-invocation-wiring.ts — MTLK-WORKFLOWS US-008.
 *
 * Host-only production wiring for the scoped merge service of ONE opted-in
 * invocation. This module is deliberately SEPARATE from the invocation runner
 * so the runner keeps no direct `node:child_process` dependency: the scheduler
 * round seam builds the already-host-attested {@link HostMergeServices} here
 * from the immutable run merge context and forwards it to
 * `runMatchlockInvocation`.
 *
 * Executable-Git boundary: the ONLY Git this module performs is the narrow
 * authoritative target-tip read — a fixed
 * `git -C <origin> rev-parse --verify refs/heads/<into>^{commit}` plumbing
 * invocation spawned with an argv array (no shell interpolation, no
 * guest-supplied argv). It cannot enable guest hooks/signing/credential
 * helpers and never reaches an unadmitted checkout (the merge service refuses
 * an origin outside the admitted original repository root BEFORE calling it).
 * Every hook/signing/helper-bearing plumbing operation stays inside the guest
 * VM via the shared pure merge core.
 */

import { spawnSync } from "node:child_process";
import { emitEvent } from "../events.js";
import { createHostMergeService } from "./host-merge-service.js";
import type { HostMergeContext, HostMergeServices } from "./host-merge-services.js";

const MERGE_TARGET_TIP_RE = /^[0-9a-f]{40,64}$/;

/**
 * Production narrow authoritative target-tip read for the merge service.
 * Returns the 40-64 hex commit id of `refs/heads/<into>` in `origin`, or null
 * when the ref does not resolve / the input is not a plain branch name.
 */
export function readAuthoritativeTargetTip(origin: string, into: string): string | null {
  if (into.includes("\0") || into.startsWith("-")) return null;
  const result = spawnSync(
    "git",
    ["-C", origin, "rev-parse", "--verify", `refs/heads/${into}^{commit}`],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
  );
  if (result.status !== 0) return null;
  const tip = (result.stdout ?? "").trim();
  return MERGE_TARGET_TIP_RE.test(tip) ? tip : null;
}

/**
 * Construct the production host merge service for ONE invocation from the
 * host-attested immutable run merge context. The event sink stamps the native
 * run-attributed merge.* event with the binding run id (the service already
 * sets it; this is defense-in-depth).
 */
export function createMergeServiceForContext(context: HostMergeContext): HostMergeServices {
  return createHostMergeService(context, {
    readTargetTip: readAuthoritativeTargetTip,
    emitEvent: (event) => {
      emitEvent({ ...event, runId: context.runId });
    },
  });
}
