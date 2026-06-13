//! Single-tenant, turso-backed plain-document store, kept byte-parity with the TS `storage` layer.
//! Each table is a `doc__<name>` STRICT table keyed by `(identity_key, id)`, holding a float-ms
//! `creation_time_ms`, a `json` `data` blob, and any user-declared extracted columns; secondary
//! indexes are `ix__<table>__<name> (identity_key, <fields...>, creation_time_ms, id)`. A batch
//! commits inside one `BEGIN IMMEDIATE` transaction and rolls back explicitly on error — there are
//! no version counters or `_meta` table. Creation times come from a monotonic [`clock`] whose
//! high-water mark is recovered on `setup`. `open` tunes the connection to WAL with a busy timeout.
//!
//! Reads are total and paged: [`sql`] compiles every scan shape (widening bounds it cannot
//! represent exactly), rows stream straight off the statement into documents, and pages resume
//! through keyset cursors. The commit/mutation ledgers are pruned by consumer watermark, and a
//! `__embedded_blobs` table stores binary payloads without any text encoding.

pub mod clock;
mod driver;
pub mod error;
#[cfg(target_arch = "wasm32")]
pub mod opfs;
mod sql;
pub mod store;
pub mod types;

#[cfg(test)]
mod tests;

pub use error::StorageError;
pub use sql::{DEFAULT_SCAN_PAGE, SCAN_CAP};
pub use store::EmbeddedStore;
pub use types::{
    Bound, ColValue, ColumnDef, CommitOptions, CommitResult, CountSpec, DeleteIn, IndexDef,
    MutationCall, MutationRecord, MutationStatus, Order, Page, PruneResult, ScanSpec, StoreSchema,
    TableDef, UpsertIn, WriteBatch,
};
