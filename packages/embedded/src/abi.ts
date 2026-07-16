/** Native and WASM storage binding ABI required by this JavaScript bundle. @internal */
export const EMBEDDED_STORAGE_ABI_VERSION = 20;

/**
 * Package-owned SQLite layout version, mirrored from the Rust store's `STORAGE_FORMAT_VERSION`
 * (`crates/storage/src/sql.rs`). This is the `storeFormatVersion` field of the generated runtime
 * identity: Embedded checks it before app tables or remote work on open, and an incompatible format
 * is reset transactionally while v5 remains unreleased.
 *
 * @internal
 */
export const EMBEDDED_STORE_FORMAT_VERSION = 41;
