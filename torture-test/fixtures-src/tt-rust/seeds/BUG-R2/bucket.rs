// TokenBucket — thread-safe token-bucket rate limiter.
//
// Uses atomic operations for all public methods so that concurrent
// callers do not need external synchronisation. The refill algorithm
// uses a monotonic clock (std::time::Instant) to compute elapsed
// time and add tokens proportionally.
//
// No unsafe blocks. No Mutex. All coordination via atomics.

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::time::Instant;

use crate::config::RateLimiterConfig;

/// A thread-safe token-bucket rate limiter.
///
/// Tokens are consumed via `try_consume`. When tokens are exhausted,
/// the bucket refills automatically based on elapsed wall-clock time,
/// the configured `refill_rate` (tokens/sec), and `refill_interval_ms`.
pub struct TokenBucket {
    /// Current token count (capped at config.max_tokens).
    current_tokens: AtomicU32,
    /// Elapsed-ms-since-start at the most recent refill.
    last_refill: AtomicU64,
    /// Immutable configuration.
    config: RateLimiterConfig,
    /// Monotonic reference instant captured at construction time.
    /// reset() compensates by bumping last_refill rather than
    /// mutating this field, so it stays immutable.
    start: Instant,
}

impl TokenBucket {
    /// Create a new TokenBucket with the given configuration.
    ///
    /// BUG-R2: The initial token count is set to config.max_tokens()
    /// instead of config.burst_size(). Combined with the config.rs bug
    /// (with_burst_size ignores its argument), custom burst sizes are
    /// silently ignored. The bucket always starts with max_tokens.
    pub fn new(config: RateLimiterConfig) -> Self {
        let initial = config.max_tokens();
        Self {
            current_tokens: AtomicU32::new(initial),
            last_refill: AtomicU64::new(0), // 0 ms elapsed from start
            config,
            start: Instant::now(),
        }
    }

    /// Attempt to consume `count` tokens.
    ///
    /// Returns `true` if the tokens were consumed successfully, or
    /// `false` if insufficient tokens are available (even after refill).
    ///
    /// Consuming 0 tokens always succeeds.
    pub fn try_consume(&self, count: u32) -> bool {
        if count == 0 {
            return true;
        }

        // Refill before checking availability.
        self.refill();

        // Atomically subtract count if enough tokens are available.
        // Use a CAS loop to handle concurrent consumers correctly.
        loop {
            let current = self.current_tokens.load(Ordering::Acquire);
            if current < count {
                return false;
            }
            let new = current - count;
            match self
                .current_tokens
                .compare_exchange_weak(current, new, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => return true,
                Err(_) => continue,
            }
        }
    }

    /// Return the number of tokens currently available (after refilling).
    pub fn available(&self) -> u32 {
        self.refill();
        self.current_tokens.load(Ordering::Acquire)
    }

    /// Reset the bucket to its initial burst size and restart the
    /// time reference so that the next refill starts from now.
    ///
    /// This is safe under concurrent access: token count is atomically
    /// reset and the time reference is bumped to the current elapsed
    /// time so that future refills compute intervals from "right now".
    pub fn reset(&self) {
        // BUG-R2: Uses max_tokens instead of burst_size — same as new().
        self.current_tokens
            .store(self.config.max_tokens(), Ordering::Release);

        // Bump last_refill to the current elapsed time.
        let now_ms = self.elapsed_now_ms();
        self.last_refill.store(now_ms, Ordering::Release);
    }

    // ── private ────────────────────────────────────────────────────

    /// Current monotonic-elapsed ms since `start`.
    fn elapsed_now_ms(&self) -> u64 {
        self.start.elapsed().as_millis() as u64
    }

    /// Replenish tokens based on elapsed time since the last refill.
    fn refill(&self) {
        let now_ms = self.elapsed_now_ms();
        let last = self.last_refill.load(Ordering::Acquire);

        // BUG-R2: Hardcoded 100ms interval instead of using
        // config.refill_interval_ms(). Combined with the config.rs bug
        // (with_refill_interval ignores its argument), the config's
        // refill_interval_ms field is never actually used — the bucket
        // always uses 100ms regardless of what the caller configured.
        let elapsed = now_ms.saturating_sub(last);
        if elapsed < 100 {
            return;
        }

        // Compute tokens to add: (elapsed_ms * refill_rate) / 1000.
        // Use u64 for intermediate calculation to avoid overflow
        // and get sub-second precision.
        let tokens_to_add = ((elapsed as u64 * self.config.refill_rate() as u64) / 1_000)
            .min(u32::MAX as u64) as u32;

        if tokens_to_add == 0 {
            return;
        }

        // Claim the refill window by updating last_refill.
        match self.last_refill.compare_exchange(
            last,
            now_ms,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => {
                self.add_tokens(tokens_to_add);
            }
            Err(_new_last) => {
                // Another thread refilled; nothing to do.
            }
        }
    }

    /// Add tokens up to max_tokens (CAS loop for atomicity).
    fn add_tokens(&self, amount: u32) {
        let max = self.config.max_tokens();
        loop {
            let current = self.current_tokens.load(Ordering::Acquire);
            let capped = max.min(current.saturating_add(amount));
            if current == capped {
                break; // already at max
            }
            match self
                .current_tokens
                .compare_exchange_weak(current, capped, Ordering::AcqRel, Ordering::Acquire)
            {
                Ok(_) => break,
                Err(_) => continue,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;
    use std::time::Duration;

    // ── construction ─────────────────────────────────────────────

    #[test]
    fn new_bucket_starts_with_burst_tokens() {
        let cfg = RateLimiterConfig::new(10, 5);
        let bucket = TokenBucket::new(cfg);
        // BUG-R2: bucket uses max_tokens (10) instead of burst_size (10);
        // they're equal with default config, so this test is dormant.
        assert_eq!(bucket.available(), 10);
    }

    #[test]
    fn new_bucket_with_custom_burst() {
        // BUG-R2: with_burst_size(5) is ignored by config.rs (returns
        // max_tokens=20 instead), and bucket.rs uses max_tokens instead
        // of burst_size — so initial tokens = 20, not 5.
        let cfg = RateLimiterConfig::new(20, 10).with_burst_size(5);
        let bucket = TokenBucket::new(cfg);
        assert_eq!(bucket.available(), 20);
    }

    // ── consumption ──────────────────────────────────────────────

    #[test]
    fn try_consume_single_token() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(10, 5));
        assert!(bucket.try_consume(1));
        assert_eq!(bucket.available(), 9);
    }

    #[test]
    fn try_consume_multiple_tokens() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(10, 5));
        assert!(bucket.try_consume(7));
        assert_eq!(bucket.available(), 3);
    }

    #[test]
    fn try_consume_all_tokens() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(10, 5));
        assert!(bucket.try_consume(10));
        assert_eq!(bucket.available(), 0);
    }

    #[test]
    fn try_consume_more_than_available_fails() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(5, 5));
        assert!(!bucket.try_consume(6));
        assert_eq!(bucket.available(), 5); // unchanged
    }

    #[test]
    fn try_consume_zero_succeeds() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(5, 5));
        assert!(bucket.try_consume(0));
        assert_eq!(bucket.available(), 5);
    }

    #[test]
    fn try_consume_exhaustive_sequence() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(3, 100));
        assert!(bucket.try_consume(1)); // 2 left
        assert!(bucket.try_consume(1)); // 1 left
        assert!(bucket.try_consume(1)); // 0 left
        assert!(!bucket.try_consume(1)); // exhausted
    }

    // ── refill ───────────────────────────────────────────────────

    #[test]
    fn refill_after_sleep_restores_tokens() {
        // 100 tokens/sec. Bucket hardcodes 100ms interval, config
        // returns 100 (buggy with_refill_interval ignored). So
        // effective rate is 10 tokens/interval. Over 1100ms: 11
        // intervals × 10 = 110 tokens, capped at max=10.
        let cfg = RateLimiterConfig::new(10, 100).with_refill_interval(50);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(10));
        assert_eq!(bucket.available(), 0);

        thread::sleep(Duration::from_millis(1100));
        let available = bucket.available();
        assert!(
            available >= 10,
            "expected >= 10 tokens after 1s sleep, got {}",
            available
        );
    }

    #[test]
    fn refill_respects_max_tokens() {
        let cfg = RateLimiterConfig::new(5, 100);
        let bucket = TokenBucket::new(cfg);

        thread::sleep(Duration::from_millis(500));
        assert_eq!(bucket.available(), 5);
    }

    #[test]
    fn refill_partial_between_intervals() {
        // 50 tokens/sec. Bucket hardcodes 100ms interval → 5
        // tokens/interval. After 160ms only one 100ms tick passes,
        // so at most 5 tokens refill.
        let cfg = RateLimiterConfig::new(20, 50).with_refill_interval(100);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(20)); // drain completely
        assert_eq!(bucket.available(), 0);

        thread::sleep(Duration::from_millis(160));
        let av = bucket.available();
        assert!(av > 0, "expected some refill after 160ms, got {}", av);
    }

    // ── burst handling ───────────────────────────────────────────

    #[test]
    fn burst_allows_immediate_full_consumption() {
        let cfg = RateLimiterConfig::new(100, 10);
        let bucket = TokenBucket::new(cfg);
        // BUG-R2: bucket uses max_tokens(100), not burst_size. Both
        // are 100 with default config, so this test is dormant.
        assert!(bucket.try_consume(100));
    }

    #[test]
    fn burst_is_capped_by_max_tokens_after_refill() {
        let cfg = RateLimiterConfig::new(10, 50);
        let bucket = TokenBucket::new(cfg);

        thread::sleep(Duration::from_millis(500));
        assert!(bucket.available() <= 10);
    }

    // ── rate limiting ────────────────────────────────────────────

    #[test]
    fn tokens_drain_before_refill_interval() {
        // BUG-R2: with_refill_interval(10_000) is ignored by config.rs
        // (returns 100), and bucket hardcodes 100ms. Same value, no
        // explicit sleep, elapsed < 100ms → refill doesn't trigger.
        // Test is dormant.
        let cfg = RateLimiterConfig::new(5, 100).with_refill_interval(10_000);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(5));
        assert!(!bucket.try_consume(1));
    }

    // ── concurrent access ────────────────────────────────────────

    #[test]
    fn concurrent_consumers_dont_race() {
        use std::sync::Arc;
        let bucket = Arc::new(TokenBucket::new(RateLimiterConfig::new(10_000, 10_000)));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let bucket_ref = Arc::clone(&bucket);
                thread::spawn(move || {
                    let mut consumed = 0u32;
                    while bucket_ref.try_consume(1) {
                        consumed += 1;
                    }
                    consumed
                })
            })
            .collect();

        let total: u32 = handles.into_iter().map(|h| h.join().unwrap()).sum();
        assert_eq!(total, 10_000);
    }

    #[test]
    fn concurrent_available_never_panics() {
        use std::sync::Arc;
        let bucket = Arc::new(TokenBucket::new(RateLimiterConfig::new(100, 50)));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let bucket_ref = Arc::clone(&bucket);
                thread::spawn(move || {
                    for _ in 0..1000 {
                        let _av = bucket_ref.available();
                    }
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }
    }

    #[test]
    fn concurrent_try_consume_and_available() {
        use std::sync::Arc;
        let bucket = Arc::new(TokenBucket::new(RateLimiterConfig::new(500, 500)));

        let consumers: Vec<_> = (0..4)
            .map(|_| {
                let bucket_ref = Arc::clone(&bucket);
                thread::spawn(move || {
                    for _ in 0..100 {
                        bucket_ref.try_consume(1);
                    }
                })
            })
            .collect();

        let readers: Vec<_> = (0..4)
            .map(|_| {
                let bucket_ref = Arc::clone(&bucket);
                thread::spawn(move || {
                    for _ in 0..100 {
                        let _ = bucket_ref.available();
                    }
                })
            })
            .collect();

        for h in consumers.into_iter().chain(readers) {
            h.join().unwrap();
        }
    }

    #[test]
    fn concurrent_four_plus_threads_no_races() {
        use std::sync::Arc;
        let bucket = Arc::new(TokenBucket::new(RateLimiterConfig::new(2000, 500)));

        let handles: Vec<_> = (0..6)
            .map(|i| {
                let bucket_ref = Arc::clone(&bucket);
                thread::spawn(move || {
                    for _ in 0..200 {
                        if i % 2 == 0 {
                            bucket_ref.try_consume(1);
                        } else {
                            let _ = bucket_ref.available();
                        }
                    }
                })
            })
            .collect();

        for h in handles {
            h.join().unwrap();
        }
    }

    // ── reset ────────────────────────────────────────────────────

    #[test]
    fn reset_restores_burst_tokens() {
        // BUG-R2: with_burst_size(5) is ignored (returns max_tokens=10).
        // Bucket uses max_tokens for reset too. So initial = 10, not 5.
        // After consuming 5, reset restores to 10, not 5.
        let cfg = RateLimiterConfig::new(10, 5).with_burst_size(5);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(10));
        assert_eq!(bucket.available(), 0);

        bucket.reset();
        assert_eq!(bucket.available(), 10);
    }

    #[test]
    fn reset_restores_full_burst() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(20, 10));
        assert!(bucket.try_consume(8));
        assert_eq!(bucket.available(), 12);

        bucket.reset();
        assert_eq!(bucket.available(), 20); // back to max_tokens
    }

    #[test]
    fn reset_then_consume_works() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(10, 5));
        assert!(bucket.try_consume(10));
        assert_eq!(bucket.available(), 0);

        bucket.reset();
        assert_eq!(bucket.available(), 10);
        assert!(bucket.try_consume(5));
        assert_eq!(bucket.available(), 5);
    }

    #[test]
    fn reset_resets_refill_clock() {
        // BUG-R2: with_refill_interval(10_000) is ignored (returns 100).
        // Bucket hardcodes 100ms. Both say 100, so after reset+consume,
        // refill can happen after 100ms. But the test runs immediately,
        // so elapsed < 100ms — no refill. Dormant.
        let cfg = RateLimiterConfig::new(10, 100).with_refill_interval(10_000);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(10)); // drain
        bucket.reset(); // burst restored

        assert!(bucket.try_consume(10)); // drain again
        assert!(!bucket.try_consume(1)); // no refill yet
    }

    // ── available() ──────────────────────────────────────────────

    #[test]
    fn available_reports_exact_after_consumption() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(10, 100));
        assert!(bucket.try_consume(3));
        assert_eq!(bucket.available(), 7);
        assert!(bucket.try_consume(2));
        assert_eq!(bucket.available(), 5);
    }

    #[test]
    fn available_never_exceeds_max() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(5, 1000));
        thread::sleep(Duration::from_millis(200));
        assert_eq!(bucket.available(), 5);
    }

    #[test]
    fn available_never_negative() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(1, 1000));
        assert!(!bucket.try_consume(100));
        let av = bucket.available();
        assert!(av <= 1, "available should not be negative, got {}", av);
    }

    // ── boundary conditions ──────────────────────────────────────

    #[test]
    fn max_u32_tokens() {
        let cfg = RateLimiterConfig::new(u32::MAX, 1);
        let bucket = TokenBucket::new(cfg);
        assert_eq!(bucket.available(), u32::MAX);
    }

    #[test]
    fn consume_one_from_one() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(1, 1));
        assert!(bucket.try_consume(1));
        assert!(!bucket.try_consume(1));
    }

    #[test]
    fn refill_rate_one_per_second() {
        let cfg = RateLimiterConfig::new(10, 1).with_refill_interval(100);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(10)); // drain
        assert_eq!(bucket.available(), 0);

        thread::sleep(Duration::from_millis(1100));
        let av = bucket.available();
        assert!(av >= 1, "expected >= 1 token, got {}", av);
    }

    // ── config validation ────────────────────────────────────────

    #[test]
    #[should_panic(expected = "max_tokens must be greater than 0")]
    fn bucket_new_zero_max_tokens_panics() {
        TokenBucket::new(RateLimiterConfig::new(0, 5));
    }

    // ── monotonic clock ──────────────────────────────────────────

    #[test]
    fn refill_uses_monotonic_clock() {
        let cfg = RateLimiterConfig::new(10, 50).with_refill_interval(100);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(10)); // drain
        assert_eq!(bucket.available(), 0);

        thread::sleep(Duration::from_millis(300));

        let av = bucket.available();
        assert!(av >= 5, "expected monotonic clock refill, got {}", av);
    }

    // ── overflow edge cases ──────────────────────────────────────

    #[test]
    fn consume_exactly_max_tokens() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(100, 10));
        assert!(bucket.try_consume(100));
        assert_eq!(bucket.available(), 0);
    }

    #[test]
    fn refill_at_max_does_not_overflow() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(100, 10));
        thread::sleep(Duration::from_millis(200));
        assert_eq!(bucket.available(), 100);
    }

    #[test]
    fn refill_when_saturated() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(10, 1000));
        assert!(bucket.try_consume(5));
        thread::sleep(Duration::from_millis(200));
        assert_eq!(bucket.available(), 10);
    }
}
