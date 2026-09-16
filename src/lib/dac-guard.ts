/**
 * DAC-fixture guard (RDAC).
 *
 * Some tests exercise product behavior with a 0555 (read-only) fixture
 * directory and rely on the operating system's discretionary access control
 * (DAC) to deny writes. On a uid-0 host the kernel is bypassed by
 * CAP_DAC_OVERRIDE, so the fixture stays writable and the test's premise does
 * not hold. Such tests skip with {@link ROOT_DAC_SKIP_REASON} when the
 * process is uid 0 and run their full body for every non-root uid.
 *
 * This module deliberately has NO product behavior: it only lets tests decide
 * whether their DAC-dependent fixture is meaningful in the current process.
 */

/** Exact skip reason used by every DAC-dependent 0555-fixture test. */
export const ROOT_DAC_SKIP_REASON = "DAC not enforced for uid 0";

/**
 * Parameterized predicate: true exactly when `getuid` is a function and
 * reports uid 0. Passing `undefined` (a platform without `process.getuid`,
 * e.g. Windows) is false. Exposed so the uid-0 branch is unit-testable
 * without actually running as root.
 */
export function isUid0(getuid: (() => number) | undefined): boolean {
  return typeof getuid === "function" && getuid() === 0;
}

/**
 * True when a test that proves behavior via a 0555 fixture must be skipped
 * because the running process is uid 0 and DAC is therefore not enforced.
 */
export function shouldSkipDacFixtureTest(): boolean {
  const getuid =
    typeof process.getuid === "function"
      ? process.getuid.bind(process)
      : undefined;
  return isUid0(getuid);
}
