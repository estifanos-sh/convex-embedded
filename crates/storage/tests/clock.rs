//! clock — migrated from the former inline `src/tests.rs`, reaching private internals only
//! through `storage::testkit`. Run with `--features testkit`.
#![cfg(feature = "testkit")]
#![allow(
    clippy::too_many_lines,
    clippy::unreadable_literal,
    clippy::similar_names
)]

use storage::clock::Clock;

#[test]
fn clock_is_strictly_increasing_within_a_wall_instant() {
    let mut c = Clock::new();
    let a = c.now(1000.0);
    let b = c.now(1000.0);
    let d = c.now(1000.0);
    assert!((a - 1000.0).abs() < f64::EPSILON);
    assert!(a < b && b < d);
}

#[test]
fn clock_never_goes_backward_on_a_stepped_back_wall() {
    let mut c = Clock::new();
    let a = c.now(5000.0);
    let b = c.now(4000.0);
    assert!(b > a);
}

#[test]
fn clock_observe_floors_to_the_high_water_mark() {
    let mut c = Clock::new();
    c.observe(9000.0);
    assert!(c.now(1000.0) >= 9000.0);
}

#[test]
fn clock_advances_after_large_observed_value() {
    let mut c = Clock::new();
    c.observe(4.0e15);
    let next = c.now(1000.0);
    assert!(next > 4.0e15);
}
