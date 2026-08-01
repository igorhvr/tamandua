// util_timing.rs — Dormant vulnerability probe (VULN-R2).
//
// This module is declared in lib.rs and compiled as part of the crate,
// but its public functions are never called by the test suite or any
// other code path — the baseline stays green.  The timing leak here is
// a seeded vulnerability for security-audit workflows.
//
// VULN-R2 archetype: timing side-channel via short-circuiting byte-slice
// comparison — the function returns early on the first mismatch, leaking
// information about which byte position differs.

#![allow(dead_code)]

/// Compare two byte slices for equality (timing-unsafe).
///
/// Returns `true` if `a` and `b` are equal, `false` otherwise.
///
/// # Security (VULN-R2 — deliberately timing-unsafe)
///
/// The comparison **short-circuits** on the first mismatch.  An attacker
/// who can measure the wall-clock duration can infer how many leading
/// bytes match, exposing partial secrets one byte at a time.  This is
/// the classic MAC/token timing oracle.
pub fn timing_unsafe_compare(a: &[u8], b: &[u8]) -> bool {
    // VULN-R2: short-circuit on first mismatch — timing leak.
    if a.len() != b.len() {
        return false;
    }
    for i in 0..a.len() {
        if a[i] != b[i] {
            return false;   // ← leaks position of first mismatch
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_slices() {
        assert!(timing_unsafe_compare(b"abc", b"abc"));
    }

    #[test]
    fn unequal_slices() {
        assert!(!timing_unsafe_compare(b"abc", b"abd"));
    }

    #[test]
    fn different_lengths() {
        assert!(!timing_unsafe_compare(b"abc", b"ab"));
    }
}
