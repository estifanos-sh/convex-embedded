import baseline from "../../../config/epoch.json" with { type: "json" };

/**
 * The only durable-layout admission baseline. It is intentionally separate from computed wire,
 * binding, and coordination hashes. Rust reads this same file through `crates/storage/build.rs`.
 * A store with another epoch or format is preserved and rejected rather than reset.
 *
 * @internal
 */
export const EMBEDDED_STORE_EPOCH = baseline.durableBaseline.epoch;
