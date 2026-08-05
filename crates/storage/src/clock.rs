//! Monotonic storage clock. `next()` never goes backward and is unique within a wall-clock
//! millisecond (the float-ms value is the §3.2 HLC's wallClock); `observe()` is its remote-floor
//! rule, reused here to recover the high-water mark on open.

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
            let candidate = self.last + EPSILON;
            if candidate > self.last {
                candidate
            } else {
                next_f64(self.last)
            }
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

fn next_f64(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    if value < 0.0 {
        return 0.0;
    }
    f64::from_bits(value.to_bits() + 1)
}

impl Default for Clock {
    fn default() -> Self {
        Self::new()
    }
}

/// Wall clock in integer milliseconds since the Unix epoch.
pub fn wall_ms() -> Result<f64, StorageError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StorageError::Clock)?
        .as_millis() as f64)
}

/// Wall clock in signed nanoseconds since the Unix epoch. Commit timestamps use this only as a
/// lower bound; the durable floor supplies monotonicity across processes and clock regressions.
pub fn wall_ns() -> Result<i64, StorageError> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StorageError::Clock)?
        .as_nanos();
    i64::try_from(nanos).map_err(|_| StorageError::Clock)
}
