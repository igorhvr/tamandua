// RateLimiterConfig — token-bucket rate limiter configuration.
//
// All fields are validated on construction. Public getters provide
// read-only access so that TokenBucket can reference config without
// cloning or copying large structs.

/// Configuration for a token-bucket rate limiter.
#[derive(Debug, Clone)]
pub struct RateLimiterConfig {
    /// Maximum number of tokens the bucket can hold.
    max_tokens: u32,
    /// Tokens added per second during refill.
    refill_rate: u32,
    /// Refill interval in milliseconds (default 100).
    refill_interval_ms: u64,
    /// Initial burst size — how many tokens are available immediately
    /// after construction. Defaults to max_tokens.
    burst_size: u32,
}

impl RateLimiterConfig {
    /// Create a new configuration.
    ///
    /// # Panics
    ///
    /// Panics if `max_tokens` is 0 or if `refill_rate` overflows u32.
    pub fn new(max_tokens: u32, refill_rate: u32) -> Self {
        assert!(max_tokens > 0, "max_tokens must be greater than 0");
        Self {
            max_tokens,
            refill_rate,
            refill_interval_ms: 100,
            burst_size: max_tokens,
        }
    }

    /// Set a custom refill interval in milliseconds.
    pub fn with_refill_interval(mut self, ms: u64) -> Self {
        assert!(ms > 0, "refill_interval_ms must be greater than 0");
        self.refill_interval_ms = ms;
        self
    }

    /// Set a custom burst size (initial tokens).
    ///
    /// # Panics
    ///
    /// Panics if `burst_size` exceeds `max_tokens`.
    pub fn with_burst_size(mut self, burst_size: u32) -> Self {
        assert!(
            burst_size <= self.max_tokens,
            "burst_size must not exceed max_tokens"
        );
        self.burst_size = burst_size;
        self
    }

    /// Maximum number of tokens the bucket can hold.
    pub fn max_tokens(&self) -> u32 {
        self.max_tokens
    }

    /// Tokens added per second during refill.
    pub fn refill_rate(&self) -> u32 {
        self.refill_rate
    }

    /// Refill interval in milliseconds.
    pub fn refill_interval_ms(&self) -> u64 {
        self.refill_interval_ms
    }

    /// Initial burst size — tokens available immediately after construction.
    pub fn burst_size(&self) -> u32 {
        self.burst_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_values() {
        let cfg = RateLimiterConfig::new(10, 5);
        assert_eq!(cfg.max_tokens(), 10);
        assert_eq!(cfg.refill_rate(), 5);
        assert_eq!(cfg.refill_interval_ms(), 100);
        assert_eq!(cfg.burst_size(), 10); // default = max_tokens
    }

    #[test]
    fn custom_interval() {
        let cfg = RateLimiterConfig::new(10, 5).with_refill_interval(200);
        assert_eq!(cfg.refill_interval_ms(), 200);
    }

    #[test]
    fn custom_burst_size() {
        let cfg = RateLimiterConfig::new(10, 5).with_burst_size(5);
        assert_eq!(cfg.burst_size(), 5);
        assert_eq!(cfg.max_tokens(), 10);
    }

    #[test]
    fn builder_chaining() {
        let cfg = RateLimiterConfig::new(20, 10)
            .with_refill_interval(50)
            .with_burst_size(15);
        assert_eq!(cfg.max_tokens(), 20);
        assert_eq!(cfg.refill_rate(), 10);
        assert_eq!(cfg.refill_interval_ms(), 50);
        assert_eq!(cfg.burst_size(), 15);
    }

    #[test]
    #[should_panic(expected = "max_tokens must be greater than 0")]
    fn zero_max_tokens_panics() {
        RateLimiterConfig::new(0, 5);
    }

    #[test]
    #[should_panic(expected = "refill_interval_ms must be greater than 0")]
    fn zero_interval_panics() {
        RateLimiterConfig::new(10, 5).with_refill_interval(0);
    }

    #[test]
    #[should_panic(expected = "burst_size must not exceed max_tokens")]
    fn burst_exceeds_max_panics() {
        RateLimiterConfig::new(10, 5).with_burst_size(11);
    }

    #[test]
    fn burst_equals_max_is_ok() {
        let cfg = RateLimiterConfig::new(10, 5).with_burst_size(10);
        assert_eq!(cfg.burst_size(), 10);
    }
}
