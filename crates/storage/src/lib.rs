//! Single-tenant, turso-backed plain-document store, kept byte-parity with the TS `storage` layer.
//! Each table is a `doc__<name>` STRICT table keyed by `(identity_key, id)`, holding a float-ms
//! `creation_time_ms`, a `json` `data` blob, and any user-declared extracted columns; secondary
//! indexes are `ix__<table>__<name> (identity_key, <fields...>, creation_time_ms, id)`. A batch
//! commits inside one `BEGIN IMMEDIATE` transaction and rolls back explicitly on error — there are
//! no version counters or `_meta` table. Creation times come from a monotonic [`clock`] whose
//! high-water mark is recovered on `setup`. `open` tunes the connection to WAL with a busy timeout.
//! Scans/counts are compiled by [`sql`] with a shape-keyed plan cache and an unbounded-scan cap.

pub mod clock;
pub mod driver;
pub mod error;
pub mod sql;
pub mod store;
pub mod types;

#[cfg(test)]
mod tests;

pub use driver::TursoDriver;
pub use error::StorageError;
pub use sql::{CompileResult, SCAN_CAP};
pub use store::EmbeddedStore;
pub use types::{
    Affinity, Bound, ColValue, ColumnDef, CountSpec, DeleteIn, IndexDef, Order, ReadOutcome,
    ScanSpec, StoreSchema, StoredDoc, TableDef, UpsertIn, WriteBatch,
};
