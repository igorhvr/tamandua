# ttrust — Token-Bucket Rate Limiter

A Rust crate implementing a token-bucket rate limiter with atomic counters,
monotonic clock refill, and thread-safe consumption.

Built for the tamandua torture-test suite — zero external dependencies
beyond the Rust standard library.

## Setup

Requires **Rust >= 1.70** (cargo provided by nix on this host).

```bash
cargo build
cargo test --quiet
```

## Crate Overview

- **`config.rs`** — `RateLimiterConfig`: max_tokens, refill_rate,
  refill_interval_ms, burst_size.
- **`bucket.rs`** — `TokenBucket`: atomic-based token bucket with
  `try_consume`, `refill`, `available`, and `reset` methods.
- **`lib.rs`** — Re-exports public types.
