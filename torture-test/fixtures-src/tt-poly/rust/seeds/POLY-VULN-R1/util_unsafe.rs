// util_unsafe.rs — Dormant vulnerability probe (VULN-R1).
//
// This module is declared in lib.rs and compiled as part of the crate,
// but its public functions are never called by the test suite or any
// other code path — the baseline stays green.  The unsafe code here is
// a seeded vulnerability for security-audit workflows.
//
// VULN-R1 archetype: unsafe pointer arithmetic on a Vec without bounds
// checking, leading to undefined behavior when given an out-of-bounds
// index.

#![allow(dead_code)]

/// Access the element at `index` in `data` using unsafe pointer arithmetic.
///
/// # Safety (VULN-R1 — deliberately unsafe)
///
/// This function performs **no** bounds checking.  If `index` is
/// out-of-bounds the behaviour is undefined — Rust guarantees nothing,
/// and the compiler is free to assume this never happens.
pub fn get_unchecked(data: &[i32], index: usize) -> i32 {
    let ptr = data.as_ptr();
    // SAFETY: caller must ensure `index` < data.len().
    // This function does NOT check — it relies on the caller.
    unsafe { *ptr.add(index) }
}

/// Set the element at `index` in `data` using unsafe pointer arithmetic.
///
/// # Safety (VULN-R1 — deliberately unsafe)
///
/// Same as `get_unchecked`: no bounds checking, UB on OOB access.
pub fn set_unchecked(data: &mut [i32], index: usize, value: i32) {
    let ptr = data.as_mut_ptr();
    // SAFETY: caller must ensure `index` < data.len().
    // This function does NOT check — it relies on the caller.
    unsafe { *ptr.add(index) = value }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn get_unchecked_in_bounds() {
        let data = [10, 20, 30];
        assert_eq!(get_unchecked(&data, 0), 10);
        assert_eq!(get_unchecked(&data, 2), 30);
    }

    #[test]
    fn set_unchecked_in_bounds() {
        let mut data = [1, 2, 3];
        set_unchecked(&mut data, 1, 99);
        assert_eq!(data[1], 99);
    }
}
