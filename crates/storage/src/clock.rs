//! Monotonic clock mirroring the TS `storage/clock.ts`. `now()` never goes backward and is unique
//! within a wall-clock millisecond (the float-ms value is the §3.2 HLC's wallClock); `observe()` is
//! its remote-floor rule, reused here to recover the high-water mark on open.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::StorageError;

const EPSILON: f64 = 1.0 / 64.0;

/// A monotonic float-ms clock. Owned by the store.
pub struct Clock {
    last: f64,
}

impl Clock {
    /// Create a clock seeded at `0` (matching the TS `createClock()` default).
    #[must_use]
    pub fn new() -> Self {
        Self { last: 0.0 }
    }

    /// Return the next creation time: `max(wall, last + EPSILON)`. Never goes backward. The wall is
    /// passed in (the store reads [`wall_ms`]; tests and conformance feed a controlled value).
    pub fn now(&mut self, wall: f64) -> f64 {
        let next = if wall > self.last {
            wall
        } else {
            self.last + EPSILON
        };
        self.last = next;
        next
    }

    /// Raise the high-water mark to `t` if it is ahead of the current floor.
    pub fn observe(&mut self, t: f64) {
        if t > self.last {
            self.last = t;
        }
    }
}

impl Default for Clock {
    fn default() -> Self {
        Self::new()
    }
}

/// Wall clock in integer milliseconds since the unix epoch (matching JS `Date.now()`).
pub fn wall_ms() -> Result<f64, StorageError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StorageError::Clock)?
        .as_millis() as f64)
}
