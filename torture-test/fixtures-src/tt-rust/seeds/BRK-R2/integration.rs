// Integration tests for the ttrust token-bucket rate limiter.
//
// These tests exercise the public API from an external-crate perspective.
// Unit tests in src/config.rs and src/bucket.rs cover internal details.

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use ttrust::{RateLimiterConfig, TokenBucket};

// ── construction & defaults ─────────────────────────────────────

#[test]
fn integration_default_config_values() {
    let cfg = RateLimiterConfig::new(10, 5);
    assert_eq!(cfg.max_tokens(), 10);
    assert_eq!(cfg.refill_rate(), 5);
    assert_eq!(cfg.refill_interval_ms(), 100);
    assert_eq!(cfg.burst_size(), 10);
}

#[test]
fn integration_new_bucket_with_default_config() {
    let bucket = TokenBucket::new(RateLimiterConfig::new(20, 10));
    assert_eq!(bucket.available(), 20);
}

// ── consumption ─────────────────────────────────────────────────

#[test]
fn integration_try_consume_succeeds_with_enough_tokens() {
    let bucket = TokenBucket::new(RateLimiterConfig::new(10, 5));
    assert!(bucket.try_consume(5));
    assert_eq!(bucket.available(), 5);
}

#[test]
fn integration_try_consume_fails_when_insufficient() {
    let bucket = TokenBucket::new(RateLimiterConfig::new(3, 5));
    // BROKEN: inverted assertion — expects true when false is correct
    assert!(bucket.try_consume(4));
    assert_eq!(bucket.available(), 3);
}

#[test]
fn integration_try_consume_zero_always_succeeds() {
    let bucket = TokenBucket::new(RateLimiterConfig::new(1, 1));
    // Even after draining…
    assert!(bucket.try_consume(1));
    assert!(bucket.try_consume(0));
}

// ── refill ──────────────────────────────────────────────────────

#[test]
fn integration_refill_restores_tokens_over_time() {
    let cfg = RateLimiterConfig::new(10, 100).with_refill_interval(50);
    let bucket = TokenBucket::new(cfg);

    assert!(bucket.try_consume(10)); // drain
    assert_eq!(bucket.available(), 0);

    thread::sleep(Duration::from_millis(1100));
    assert!(bucket.available() >= 10);
}

#[test]
fn integration_refill_does_not_exceed_max() {
    let bucket = TokenBucket::new(RateLimiterConfig::new(5, 1000));
    thread::sleep(Duration::from_millis(300));
    assert_eq!(bucket.available(), 5);
}

// ── reset ───────────────────────────────────────────────────────

#[test]
fn integration_reset_restores_burst() {
    let bucket = TokenBucket::new(RateLimiterConfig::new(15, 10).with_burst_size(10));
    assert!(bucket.try_consume(10));
    assert_eq!(bucket.available(), 0);

    bucket.reset();
    assert_eq!(bucket.available(), 10);
}

#[test]
fn integration_reset_then_consume() {
    let bucket = TokenBucket::new(RateLimiterConfig::new(10, 5));
    assert!(bucket.try_consume(10));
    bucket.reset();
    assert!(bucket.try_consume(3));
    assert_eq!(bucket.available(), 7);
}

// ── concurrent access ───────────────────────────────────────────

#[test]
fn integration_concurrent_consumers() {
    let bucket = Arc::new(TokenBucket::new(RateLimiterConfig::new(5_000, 5_000)));

    let handles: Vec<_> = (0..6)
        .map(|_| {
            let b = Arc::clone(&bucket);
            thread::spawn(move || {
                let mut consumed = 0u32;
                while b.try_consume(1) {
                    consumed += 1;
                }
                consumed
            })
        })
        .collect();

    let total: u32 = handles.into_iter().map(|h| h.join().unwrap()).sum();
    assert_eq!(total, 5_000);
}

#[test]
fn integration_concurrent_consumers_and_readers() {
    let bucket = Arc::new(TokenBucket::new(RateLimiterConfig::new(1_000, 1_000)));

    let mut handles = Vec::new();

    for _ in 0..4 {
        let b = Arc::clone(&bucket);
        handles.push(thread::spawn(move || {
            for _ in 0..200 {
                b.try_consume(1);
            }
        }));
    }

    for _ in 0..4 {
        let b = Arc::clone(&bucket);
        handles.push(thread::spawn(move || {
            for _ in 0..200 {
                let _ = b.available();
            }
        }));
    }

    for h in handles {
        h.join().unwrap();
    }
}

// ── rate limiting behavior ──────────────────────────────────────

#[test]
fn integration_rate_limiting_prevents_burst_exceeding_limit() {
    let cfg = RateLimiterConfig::new(5, 100).with_refill_interval(10_000);
    let bucket = TokenBucket::new(cfg);

    // Can consume up to burst size immediately.
    assert!(bucket.try_consume(5));
    // Next attempt fails — no refill within the long interval.
    assert!(!bucket.try_consume(1));
}

// ── available() accuracy ────────────────────────────────────────

#[test]
fn integration_available_accurate_after_partial_consumption() {
    let bucket = TokenBucket::new(RateLimiterConfig::new(50, 10));
    assert!(bucket.try_consume(23));
    assert_eq!(bucket.available(), 27);
}

// ── boundary conditions ─────────────────────────────────────────

#[test]
fn integration_max_u32_config() {
    let bucket = TokenBucket::new(RateLimiterConfig::new(u32::MAX, 1));
    // We can't consume all tokens (test would take too long),
    // but we can verify available() is sane.
    let av = bucket.available();
    assert_eq!(av, u32::MAX);
}

#[test]
fn integration_refill_single_token_per_second() {
    let cfg = RateLimiterConfig::new(10, 1).with_refill_interval(100);
    let bucket = TokenBucket::new(cfg);

    assert!(bucket.try_consume(10));
    assert_eq!(bucket.available(), 0);

    // Wait for ~1 token to refill.
    thread::sleep(Duration::from_millis(1200));
    assert!(bucket.available() >= 1);
}

// ── config validation ───────────────────────────────────────────

#[test]
#[should_panic(expected = "max_tokens must be greater than 0")]
fn integration_zero_max_tokens_panics() {
    RateLimiterConfig::new(0, 5);
}

#[test]
#[should_panic(expected = "burst_size must not exceed max_tokens")]
fn integration_burst_exceeds_max_panics() {
    RateLimiterConfig::new(5, 1).with_burst_size(10);
}
