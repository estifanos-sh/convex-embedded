import epoch from "../../../config/epoch.json" with { type: "json" };

/** Native and WASM storage binding ABI required by this JavaScript bundle. @internal */
// Browser leaders require an atomic durable-fence allocator. Reject an older native/WASM
// artifact rather than permitting a browser runtime to begin remote work without one.
export const EMBEDDED_STORAGE_ABI_VERSION = 33;

/**
 * The package epoch: one identity for everything the package owns — the SQLite layout, the wire
 * messages, the component's tables, and this binding. Bump it in `config/epoch.json`, which Rust
 * reads through `crates/storage/build.rs`, so the two languages cannot drift. Epoch 47 is the first
 * supported library-store baseline. Earlier previews and newer unsupported
 * stores are preserved and rejected rather than reset.
 *
 * @internal
 */
export const EMBEDDED_EPOCH = epoch.epoch;
