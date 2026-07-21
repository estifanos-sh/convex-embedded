//! Single-tenant, turso-backed plain-document store, kept byte-parity with the TS `storage` layer.
//! Each table is a `doc__<name>` STRICT table keyed by `(identity_key, id)`, holding a float-ms
//! `creation_time_ms`, a `json` `data` blob, and any user-declared extracted columns; secondary
//! indexes are `ix__<table>__<name> (identity_key, <fields...>, creation_time_ms, id)`. A batch
//! commits inside one explicit `BEGIN` transaction and rolls back explicitly on error — there are
//! no version counters or `_meta` table. Creation times come from a monotonic [`clock`] whose
//! high-water mark is recovered on `setup`. `open` tunes the connection to WAL with a busy timeout.
//!
//! Reads are total and paged: [`sql`] compiles every scan shape (widening bounds it cannot
//! represent exactly), rows stream straight off the statement into documents, and pages resume
//! through keyset cursors. Commit and mutation ledger rows are deleted by consumer watermark, and a
//! `__embedded_blobs` table stores binary payloads without any text encoding. Local-first service
//! metadata lives beside those document tables: id mappings, file metadata, pending upload leases,
//! and scheduled jobs are all identity-scoped.

pub mod clock;
mod crdt;
mod driver;
pub mod error;
/// The structural oracle: used by the in-flight `debug_assert` (debug builds) and by `testkit`
/// (whole-store checks). Excluded from release builds with the feature off, so it never ships.
#[cfg(any(test, feature = "testkit", debug_assertions))]
mod invariant;
#[cfg(target_arch = "wasm32")]
pub mod opfs;
mod sql;
pub mod store;
pub mod types;

/// Internal test support (oracle + fixtures + fault injection) for this crate's integration tests
/// and the model simulator. `#[doc(hidden)]` and behind the `testkit` feature, so it never enters
/// the shipped binary. Tests run with `--features testkit`.
#[cfg(any(test, feature = "testkit"))]
#[doc(hidden)]
pub mod testkit;

pub use error::StorageError;
pub use sql::{DEFAULT_READ_PAGE, READ_CAP};
pub use store::EmbeddedStore;
pub use types::{
    ArchivedRev, ArgRef, AuthoritativeApplyResult, AuthoritativeChange, AuthoritativeRow,
    BaseVersion, Bound, ColValue, ColumnDef, CommitChanges, CommitMutation, CommitOptions,
    CommitPush, CommitResult, CommitSource, CountSpec, CrdtCheckpoint, CrdtCheckpointRequest,
    CrdtEffect, CrdtFieldDef, CrdtFieldKind, CrdtOp, CrdtOperation, CrdtReadState, CrdtReadWitness,
    CrdtRemoteEffect, CrdtRemoteState, CrdtRemoteWrite, CrdtRestore, CrdtSnapshot, CrdtWireOp,
    DeleteIn, DeleteResult, DirtyHeadDebug, DirtyHeadToken, DocWrite, FileMetadata, FileStore,
    IdMapping, IdMappingContent, IndexDef, InsertRef, LocalFieldDef, LocalFieldDelete,
    LocalFieldWrite, MembershipRange, MutationCall, MutationRecord, MutationStatus, Order, Page,
    PendingUpload, PushEnvelope, PushOutcome, PushResponse, RangeVersion, ReadBound, ReadEquality,
    ReadRange, ReadSpec, RemoteBlob, RemoteCrdtChange, RemoteIdMapping, RemoteMember,
    RemotePageWrite, RemotePageWriteResult, RemotePending, RemoteRowTarget, RemoteScheduleMapping,
    RemoteSettlementOutcome, RemoteSettlementWrite, RemoteSettlementWriteResult, ResultEntry,
    RetainedRevision, RevFrontier, RevKey, RevLifecycle, RevState, RevWriteResult,
    RevisionCandidate, RevisionCheckpoint, RevisionCheckpointOperation, RevisionContent, RowChange,
    RowChangeOp, RowHead, RowKey, RuntimeWireIdentity, ScheduleRef, ScheduledFunctionKind,
    ScheduledJob, ScheduledState, SettledCrdt, SettledInsert, SettledRevision, SettledSchedule,
    SettledUpload, StoreSchema, TableDef, TablePlacement, UploadLease, UploadLeaseWrite, UploadRef,
    WriteBatch,
};

pub use crdt::crdt_checkpoint_response;
