import epoch from "../../../config/epoch.json" with { type: "json" };

/** Native and WASM storage binding ABI required by this JavaScript bundle. @internal */
export const EMBEDDED_STORAGE_ABI_VERSION = 21;

/**
 * The package epoch: one identity for everything the package owns — the SQLite layout, the wire
 * messages, the component's tables, and this binding. Bump it in `config/epoch.json`, which Rust
 * reads through `crates/storage/build.rs`, so the two languages cannot drift. Package-owned state
 * from another epoch is unreadable and is reset on open rather than migrated.
 *
 * @internal
 */
export const EMBEDDED_EPOCH = epoch.epoch;
