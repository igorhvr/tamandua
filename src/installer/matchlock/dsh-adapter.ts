/**
 * Matchlock dsh adapter — facade.
 *
 * A self-contained adapter slice (parallel-implementation delivery, NOT full
 * Matchlock backend readiness). It captures an explicit dsh-home descriptor
 * from frozen submission context, constructs the guest launch, and provides
 * robust mapped-store session attribution — all with explicit inputs and typed
 * outputs. Integration wiring (policy records, the Matchlock controller,
 * guest mounts, VFS persistence proof) is owned by separate follow-on work;
 * this module publishes its contracts for that work.
 */

import {
  DSH_GUEST_CONFIGURATION_ROOT,
  DSH_GUEST_PERMISSION_MODE,
  DSH_GUEST_PROFILE,
  type DshExecutionPlan,
  type DshSubmissionContext,
} from "./dsh-adapter-contract.js";
import { resolveDshHostHome } from "./dsh-home.js";

// Re-export the contract surface so integration imports one module.
export * from "./dsh-adapter-contract.js";
export * from "./dsh-home.js";
export * from "./dsh-launch.js";
export * from "./dsh-session-store.js";
export * from "./dsh-attribution.js";

/**
 * Build the full Matchlock dsh execution plan from a frozen submission
 * context. The host store is captured here (never rediscovered by the daemon
 * later); the guest receives the ENTIRE effective home mounted RW at
 * `/workspace/config/dsh` and runs the `headless` profile with
 * `DSH_PERMISSION_MODE=danger-full-access` inside the VM.
 *
 * @param ctx  submission-time context (env/cwd/home captured at run creation)
 * @param workdir  absolute launch cwd — identical host/guest spelling
 */
export function planDshExecution(
  ctx: DshSubmissionContext,
  workdir: string,
): DshExecutionPlan {
  const home = resolveDshHostHome(ctx);
  return {
    home,
    guestHome: DSH_GUEST_CONFIGURATION_ROOT,
    guestProfile: DSH_GUEST_PROFILE,
    workdir,
    workdirPreserved: true,
    guestPermissionMode: DSH_GUEST_PERMISSION_MODE,
    preservation: "entire-home-rw",
  };
}
