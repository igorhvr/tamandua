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
    /// The initial token count is set to `config.burst_size()`.
    pub fn new(config: RateLimiterConfig) -> Self {
        let initial = config.burst_size();
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
        // Atomically set tokens back to burst size.
        self.current_tokens
            .store(self.config.burst_size(), Ordering::Release);

        // Bump last_refill to the current elapsed time.
        // This makes `now_ms - last_refill ≈ 0` for the next caller,
        // effectively restarting the refill clock.
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

        // Only refill if the interval has elapsed since last refill.
        let elapsed = now_ms.saturating_sub(last);
        if elapsed < self.config.refill_interval_ms() {
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
        // If another thread beat us, it already refilled from this
        // interval — no double-counting.
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
                // Another thread refilled; nothing to do — the tokens
                // for this interval have already been accounted for.
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

// TokenBucket is Sync because all mutable state is behind atomics
// (current_tokens, last_refill) and config is immutable.
// start is an immutable Instant field — Instant is Send+Sync.
//
// Safety: no unsafe code, no Mutex, no raw pointers — the compiler
// validates Sync automatically for this struct.

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
        assert_eq!(bucket.available(), 10);
    }

    #[test]
    fn new_bucket_with_custom_burst() {
        let cfg = RateLimiterConfig::new(20, 10).with_burst_size(5);
        let bucket = TokenBucket::new(cfg);
        assert_eq!(bucket.available(), 5);
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
        // 100 tokens/sec with a 50ms check interval → ~10 tokens per 100ms.
        let cfg = RateLimiterConfig::new(10, 100).with_refill_interval(50);
        let bucket = TokenBucket::new(cfg);

        // Drain all tokens.
        assert!(bucket.try_consume(10));
        assert_eq!(bucket.available(), 0);

        // Wait for ~1 second — should refill fully (10 max tokens).
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

        // Don't consume anything, just wait. Bucket should stay at max.
        thread::sleep(Duration::from_millis(500));
        assert_eq!(bucket.available(), 5);
    }

    #[test]
    fn refill_partial_between_intervals() {
        // 50 tokens/sec with 100ms interval → 5 tokens per 100ms interval.
        let cfg = RateLimiterConfig::new(20, 50).with_refill_interval(100);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(20)); // drain completely
        assert_eq!(bucket.available(), 0);

        // Wait for ~1.5 intervals — should see some refill.
        thread::sleep(Duration::from_millis(160));
        let av = bucket.available();
        assert!(av > 0, "expected some refill after 160ms, got {}", av);
    }

    // ── burst handling ───────────────────────────────────────────

    #[test]
    fn burst_allows_immediate_full_consumption() {
        let cfg = RateLimiterConfig::new(100, 10);
        let bucket = TokenBucket::new(cfg);
        assert!(bucket.try_consume(100));
    }

    #[test]
    fn burst_is_capped_by_max_tokens_after_refill() {
        let cfg = RateLimiterConfig::new(10, 50);
        let bucket = TokenBucket::new(cfg);

        // After sleeping, tokens should not exceed max.
        thread::sleep(Duration::from_millis(500));
        assert!(bucket.available() <= 10);
    }

    // ── rate limiting ────────────────────────────────────────────

    #[test]
    fn tokens_drain_before_refill_interval() {
        // Large refill interval so refill won't trigger within the test.
        let cfg = RateLimiterConfig::new(5, 100).with_refill_interval(10_000);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(5));
        // No refill within a few ms when interval is 10s.
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
        // Acceptance criterion: Concurrent access from 4+ threads
        // does not cause data races or panics.
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
        let cfg = RateLimiterConfig::new(10, 5).with_burst_size(5);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(5));
        assert_eq!(bucket.available(), 0);

        bucket.reset();
        assert_eq!(bucket.available(), 5);
    }

    #[test]
    fn reset_restores_full_burst() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(20, 10));
        assert!(bucket.try_consume(8));
        assert_eq!(bucket.available(), 12);

        bucket.reset();
        assert_eq!(bucket.available(), 20); // back to burst_size = max_tokens
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
        // After reset, the bucket should not have refilled from old time.
        let cfg = RateLimiterConfig::new(10, 100).with_refill_interval(10_000);
        let bucket = TokenBucket::new(cfg);

        assert!(bucket.try_consume(10)); // drain
        bucket.reset(); // reset — burst restored

        // Immediately try to consume burst — should succeed.
        // But then drain again and no refill should happen.
        assert!(bucket.try_consume(10)); // drain again
        assert!(!bucket.try_consume(1)); // no refill yet (interval is 10s)
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
        // Failed consume doesn't change tokens.
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

        // After ~1.1s, ~1 token should appear.
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

        // After 300ms with 50 tokens/sec, we get ~15 tokens
        // (but capped at max_tokens=10).
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
        // Don't consume; available should stay at 100.
        thread::sleep(Duration::from_millis(200));
        assert_eq!(bucket.available(), 100);
    }

    #[test]
    fn refill_when_saturated() {
        let bucket = TokenBucket::new(RateLimiterConfig::new(10, 1000));
        // Consume 5, leaving 5. Wait — tokens should refill back to 10.
        assert!(bucket.try_consume(5));
        thread::sleep(Duration::from_millis(200));
        assert_eq!(bucket.available(), 10);
    }
}
