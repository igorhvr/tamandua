/**
 * Matchlock launch-gate exit-code allocation (G9 EXIT-CODE-AND-REMEDIES).
 *
 * ONE code, ONE mapping. Every surface that turns a gate decision into a
 * process status imports these exports instead of writing the number by hand:
 * a refusal is {@link LAUNCH_GATE_REFUSAL_EXIT_CODE} and an allow is 0. A
 * caller that hard-codes its own status re-invents the allocation below and
 * can silently alias the exit status of an unrelated surface.
 *
 * THE ALLOCATION IS MEASURED, NOT ASSUMED. 78 was checked against every status
 * this tree already claims — the generic 0, 1, 2, 3, 4, 5, 6, 7, 9, 13, 91 and
 * 143 values, plus the dedicated TREE_DRIFT (86), INTERRUPTED (87),
 * TREE_DIRTY (88) and WORKDIR_REFUSAL (75) codes — by the allocation-proof
 * test next to this module. That test also scans every other TypeScript file
 * under `src/` and fails if a later surface claims 78, so a second owner of
 * the code is a test failure rather than a silent alias.
 *
 * OPERATIONAL REFUSALS ARE A SEPARATE CLASS. The evaluator's reason codes are
 * closed at exactly ten, and an operational failure (a receipt that could not
 * be written, a revalidation that could not run) is never renumbered into
 * them. It maps to the same process status through its own union member, so an
 * operator sees one failure exit while the reason vocabulary stays exactly ten
 * entries.
 *
 * PURITY. The mapping is a pure function of its single argument: no
 * environment read, no clock, no I/O, no randomness, no process exit. Deciding
 * to start or refuse a launch stays with the caller; this module only names
 * the status that decision must produce.
 */

import type { GateVerdict } from "./launch-gate.js";

/**
 * Process exit status for a refused Matchlock launch.
 *
 * Dedicated to the launch gate: 78 is not `EX_CONFIG` by design, it is simply
 * the next free code after the values already allocated in this tree, and it
 * is distinguishable from every one of them.
 */
export const LAUNCH_GATE_REFUSAL_EXIT_CODE = 78;

/**
 * An operational failure of the gate machinery itself.
 *
 * This is NOT a reason code. The ten reason codes describe why a store may not
 * be launched; an operational refusal describes why the gate could not reach
 * a verdict at all (or could not record one). Keeping it a separate union
 * member is what stops it from being renumbered into the closed code set.
 */
export interface OperationalRefusal {
  action: "operational-refusal";
  /** Operator-facing explanation; never a substitute for a reason code. */
  detail: string;
}

/**
 * Map one gate outcome to the process status its caller must exit with.
 *
 * `allow` is the only outcome that is not a refusal. Both refusal classes — a
 * verdict with findings and an operational failure — map to the same dedicated
 * status, because an operator's next action is the same either way: the launch
 * did not proceed. The switch is exhaustive; an outcome outside the union is a
 * loud error rather than a silent 0.
 */
export function exitCodeForGateOutcome(
  outcome: GateVerdict | OperationalRefusal,
): number {
  switch (outcome.action) {
    case "allow":
      return 0;
    case "refuse":
    case "operational-refusal":
      return LAUNCH_GATE_REFUSAL_EXIT_CODE;
  }

  // Exhaustiveness guard. Every union member is handled above, so this is
  // unreachable for typed callers; it exists because a JavaScript caller (or a
  // future union member added without updating this switch) must fail loudly
  // instead of being read as "allow".
  const unreachable: never = outcome;
  throw new Error(
    `exitCodeForGateOutcome: unhandled gate outcome ${JSON.stringify(unreachable)}`,
  );
}
