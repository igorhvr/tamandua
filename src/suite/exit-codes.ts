/**
 * Dedicated exit codes of the tamandua-test ledger shim.
 *
 * This module imports nothing and has no side effects, so library code can
 * import the real values instead of copying the literals. Copying is exactly
 * how two surfaces drift onto the same code and silently alias each other.
 *
 * The codes are meaningful only when accompanied by the shim's own stderr
 * message: a test command's own 86, 87 or 88 exit code is passed through
 * untouched by src/suite/shim.ts.
 */

/** Dedicated fail-closed exit when a passing command cannot be attributed. */
export const TREE_DRIFT_EXIT_CODE = 86;
/** Dedicated red-ledger exit for executions interrupted by a catchable signal
 *  from the CALLER (e.g., command timeout, external kill). The suite was
 *  terminated before it could finish; no usable evidence was produced. */
export const INTERRUPTED_EXIT_CODE = 87;
/** Dedicated refusal when tracked files are already dirty before testing. */
export const TREE_DIRTY_EXIT_CODE = 88;
