//! napi bindings exposing the Rust `EmbeddedStore` to the Node package. Convex function
//! execution stays in JavaScript; this binding provides the storage backend. `_creationTime`
//! crosses the boundary as `f64` (its native type); other integers above 2^53 would lose
//! precision.
//!
//! On native targets a dedicated storage thread owns all database work: every method posts a
//! job and awaits its result, so `SQLite` I/O never runs on the JS event loop, calls stay FIFO
//! (a commit is visible to the read awaited after it), and the process-global per-path lock can
//! never park the JS thread. On wasm the methods run inline — the OPFS worker is the dedicated
//! thread in that architecture. `clockRead` is the one synchronous method: it touches
//! only the in-memory clock, never the database.

#[cfg(target_arch = "wasm32")]
use std::{future::Future, pin::Pin, time::Instant};
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex, MutexGuard, PoisonError,
    },
    time::Duration,
};

use convex::AuthenticationToken;
#[cfg(target_arch = "wasm32")]
use futures_channel::oneshot;
#[cfg(target_arch = "wasm32")]
use futures_util::future::{BoxFuture, FutureExt};
#[cfg(target_arch = "wasm32")]
use napi::Status;
use napi::{
    bindgen_prelude::{Promise, Uint8Array},
    threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode},
    Env, JsFunction, JsObject,
};
use napi_derive::napi;
#[cfg(not(target_arch = "wasm32"))]
use remote::RemoteClient;
#[cfg(target_arch = "wasm32")]
use remote::RemoteDriver;
use remote::RemoteStore;
#[cfg(target_arch = "wasm32")]
use remote::{
    transport::{ConnectRequest, TransportEvent},
    upload::{RemoteUploadFuture, RemoteUploadReceipt, RemoteUploadRequest, RemoteUploader},
    RemoteClock, RemoteResult, RemoteTransport,
};
use remote::{
    DeploymentUrl, RemoteAuth, RemoteConfig, RemoteCursor, RemoteError, RemoteScope,
    RemoteSubscription, RemoteTiming,
};
use storage::RemotePageWriteResult;
use storage::{
    Bound, ColValue, ColumnDef, CommitOptions, CommitResult, CountSpec, CrdtFieldDef,
    CrdtFieldKind, CrdtOp, CrdtOperation, CrdtRestore, CrdtSnapshot, CrdtWireOp, DeleteIn,
    DeleteResult, DirtyHeadDebug, DocWrite, EmbeddedStore, FileMetadata, FileStore, IdMapping,
    IdMappingContent, IndexDef, LocalFieldDef, LocalFieldDelete, LocalFieldWrite,
    MigrationCandidate, MigrationStep, MutationCall, MutationRecord, MutationStatus, Order,
    OriginCursor, OriginPage, Page, PendingUpload, ReadSpec, ResultEntry, RowChange, RowHead,
    RowKey, ScheduledFunctionKind, ScheduledJob, ScheduledState, StorageError, StoreSchema,
    TableDef, TablePlacement, UploadLease, UploadLeaseWrite, WriteBatch,
};

#[napi(js_name = "bindingContractId")]
#[must_use]
pub fn binding_contract_id() -> String {
    storage::CURRENT_STORAGE_BINDING_CONTRACT_ID.to_owned()
}

#[napi(js_name = "contractId")]
#[must_use]
pub fn contract_id() -> String {
    storage::CURRENT_WIRE_CONTRACT_ID.to_owned()
}

/// A user-declared index column. Index columns store an order-preserving key (any value type),
/// so they carry no affinity.
#[napi(object)]
pub struct JsColumn {
    pub name: String,
    pub field: Option<String>,
}

#[napi(object)]
pub struct JsIndex {
    pub name: String,
    pub fields: Vec<String>,
    pub columns: Option<Vec<String>>,
}

#[napi(object)]
pub struct JsTable {
    pub name: String,
    pub placement: String,
    pub columns: Vec<JsColumn>,
    pub crdt_fields: Option<Vec<JsCrdtField>>,
    pub local_fields: Option<Vec<JsLocalField>>,
    pub indexes: Vec<JsIndex>,
}

#[napi(object)]
pub struct JsLocalField {
    pub field: String,
}

#[napi(object)]
pub struct JsCrdtField {
    pub field: String,
    pub kind: String,
}

#[napi(object)]
pub struct JsSchema {
    pub hash: String,
    pub setup_hash: Option<String>,
    pub tables: Vec<JsTable>,
}

/// An extracted column value, tagged by which field is set. At most one of
/// `text`/`real`/`int`/`bool`/`commitTs` may be present; `undef = true` means the field was absent
/// (Convex `undefined`); all absent means SQL `null`.
#[napi(object)]
pub struct JsColValue {
    pub name: String,
    pub text: Option<String>,
    pub real: Option<f64>,
    pub int: Option<String>,
    pub r#bool: Option<bool>,
    pub undef: Option<bool>,
    pub commit_ts: Option<bool>,
}

/// A tagged scalar value for bounds and cursor keys. At most one of `text`/`real`/`int`/`bool`
/// /`commitTs` may be present; `undef = true` means Convex `undefined`; all absent means `null`.
#[napi(object)]
pub struct JsScalar {
    pub text: Option<String>,
    pub real: Option<f64>,
    pub int: Option<String>,
    pub r#bool: Option<bool>,
    pub undef: Option<bool>,
    pub commit_ts: Option<bool>,
}

#[napi(object)]
pub struct JsBound {
    pub kind: String,
    pub value: Option<JsScalar>,
    pub lower: Option<JsScalar>,
    pub lower_inclusive: Option<bool>,
    pub upper: Option<JsScalar>,
    pub upper_inclusive: Option<bool>,
}

#[napi(object)]
pub struct JsReadSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<JsBound>>,
    pub order: String,
    /// Max rows in this page, `1..=READ_CAP`. Defaults to `DEFAULT_READ_PAGE`.
    pub page_size: Option<u32>,
    /// Opaque continuation token from a prior page of the same plan shape.
    pub cursor: Option<String>,
    /// Alternative to `cursor`: resume strictly after this explicit key tuple, one value per
    /// physical order column (`index columns…, creationTimeMs, id`).
    pub resume_after_key: Option<Vec<JsScalar>>,
}

#[napi(object)]
pub struct JsCountSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<JsBound>>,
}

#[napi(object)]
pub struct JsDocWrite {
    pub table: String,
    pub id: String,
    pub data: String,
    pub cols: Vec<JsColValue>,
    pub creation_time: f64,
    pub pending_commit_ts: Option<bool>,
}

#[napi(object)]
pub struct JsDelete {
    pub table: String,
    pub id: String,
}

#[napi(object)]
pub struct JsWriteBatch {
    pub doc_writes: Vec<JsDocWrite>,
    pub deletes: Vec<JsDelete>,
    pub local_field_writes: Option<Vec<JsLocalFieldWrite>>,
    pub local_field_deletes: Option<Vec<JsLocalFieldDelete>>,
    pub crdt_ops: Option<Vec<JsCrdtOp>>,
    pub crdt_restores: Option<Vec<JsCrdtRestore>>,
    pub fresh_ids: Option<Vec<JsDelete>>,
    pub data_only_ids: Option<Vec<JsDelete>>,
    pub id_mappings: Option<Vec<JsIdMapping>>,
    pub schedules: Option<Vec<JsScheduledJob>>,
}

#[napi(object)]
pub struct JsLocalFieldWrite {
    pub table: String,
    pub id: String,
    pub field: String,
    pub value_json: String,
    pub pending_commit_ts: Option<bool>,
}

#[napi(object)]
pub struct JsLocalFieldDelete {
    pub table: String,
    pub id: String,
    pub field: String,
}

#[napi(object)]
pub struct JsCrdtRestore {
    pub table: String,
    pub id: String,
    pub field: String,
    pub kind: String,
    pub head_seq: i64,
    pub projection_hash: String,
    pub bytes: Uint8Array,
    pub hash: String,
}

#[napi(object)]
pub struct JsCrdtOp {
    pub table: String,
    pub id: String,
    pub field: String,
    pub kind: String,
    pub delta: Option<f64>,
    pub value_json: Option<String>,
    pub index: Option<i64>,
    pub delete: Option<i64>,
    pub insert: Option<String>,
}

#[napi(object)]
pub struct JsCommitOptions {
    pub commit_ts: Option<bool>,
    pub source: Option<String>,
    pub mutation_id: Option<String>,
    pub mutation_name: Option<String>,
    pub mutation_args: Option<String>,
    pub mutation_result: Option<String>,
    pub mutation_result_commit_ts: Option<bool>,
    pub push_envelope_json: Option<String>,
    pub push_envelope_now_ms: Option<f64>,
    pub push_after_images_commit_ts: Option<bool>,
    pub mutation_is_fresh: Option<bool>,
    pub include_changes: Option<bool>,
}

#[napi(object)]
pub struct JsCommitResult {
    pub changed_tables: Vec<String>,
    pub changes: Vec<JsRowChange>,
    pub commit_seq: i64,
    /// Decimal signed int64 allocated atomically for a commit that used `db.vars.commitTs`.
    pub commit_ts: Option<String>,
    /// CRDT-field edits this commit produced (§1/§8-A). `update` is base64 Loro bytes; the client
    /// carries them on the one push (`crdtOps`) — a pure-CRDT commit forms a `fn:""` push call.
    pub crdt_ops: Vec<JsCrdtWireOp>,
}

#[napi(object)]
pub struct JsCrdtWireOp {
    pub table: String,
    pub id: String,
    pub field: String,
    pub kind: String,
    pub update: String,
}

#[napi(object)]
pub struct JsCrdtSnapshot {
    pub field: String,
    pub kind: String,
    pub head_seq: i64,
    pub projection_hash: String,
    pub bytes: Uint8Array,
    pub hash: String,
}

#[napi(object)]
pub struct JsRowChange {
    pub op: String,
    pub table: String,
    pub id: String,
    pub row: Option<String>,
}

#[napi(object)]
pub struct JsDirtyHeadDebug {
    pub table: String,
    pub id: String,
    pub op: String,
    pub first_commit_seq: i64,
    pub updated_commit_seq: i64,
    pub created_time: i64,
    pub updated_time: i64,
    pub server_document_id: Option<String>,
    pub base_projection_hash: Option<String>,
    pub base_root_id: Option<String>,
    pub base_node_id: Option<String>,
    pub logical_clock: f64,
}

#[napi(object)]
pub struct JsRemoteDocDebug {
    pub table: String,
    pub local_document_id: String,
    pub current_rev_id: String,
    pub server_document_id: String,
    pub projection_hash: String,
    pub current_root_id: Option<String>,
    pub current_node_id: Option<String>,
    pub server_base: Option<String>,
    pub logical_clock: f64,
    pub updated_time: i64,
}

#[napi(object)]
pub struct JsMutationCall {
    pub args: String,
    pub mutation_id: String,
    pub name: String,
}

#[napi(object)]
pub struct JsMutationRecord {
    pub commit_seq: Option<i64>,
    pub error: Option<String>,
    pub mutation_id: String,
    pub result: Option<String>,
    pub status: String,
}

/// One scan page as a single JSON text (see `storage::Page`): one string crossing and one
/// `JSON.parse` per page instead of one per document.
#[napi(object)]
pub struct JsPage {
    pub text: String,
    /// `null` when the scan is exhausted.
    pub cursor: Option<String>,
    /// Sidecar per-row adoption version (`localId -> pull seq`) for §11 D1 read-set capture; empty
    /// for key pages. Absent id => version `0`.
    pub versions: std::collections::HashMap<String, i64>,
    /// JSON object keyed by local row id, then local field name.
    pub local_fields_json: Option<String>,
}

#[napi(object)]
pub struct JsDeleteResult {
    pub commits_deleted: i64,
    pub mutations_deleted: i64,
}

#[napi(object)]
pub struct JsIdMapping {
    pub table: String,
    pub local_id: String,
    pub convex_id: Option<String>,
    pub state: String,
    pub created_time: i64,
    pub updated_time: i64,
}

/// One retained authored-result cache entry crossing the FFI (Cut 7 §3). `skeleton`/`paths` are the
/// stored codec bytes the runtime reconstructs from; the scalar fields carry the rest of the row.
#[napi(object)]
pub struct JsResultEntry {
    pub key: String,
    pub function: String,
    pub args: String,
    pub schema_hash: String,
    pub module_hash: String,
    pub skeleton: Uint8Array,
    pub paths: Uint8Array,
    pub skeleton_hash: String,
    pub clock: f64,
}

#[napi(object)]
pub struct JsFileMetadata {
    pub storage_id: String,
    pub sha256: String,
    pub size: i64,
    pub content_type: Option<String>,
    pub source: Option<String>,
    pub created_time: i64,
    pub updated_time: i64,
}

#[napi(object)]
pub struct JsFileStore {
    pub bytes: Uint8Array,
    pub metadata: JsFileMetadata,
}

#[napi(object)]
pub struct JsPendingUpload {
    pub local_storage_id: String,
    pub sha256: String,
    pub size: i64,
    pub content_type: Option<String>,
    pub state: String,
    pub owner: Option<String>,
    pub lease_until: Option<i64>,
    pub created_time: i64,
    pub updated_time: i64,
}

#[napi(object)]
pub struct JsUploadLeaseWrite {
    pub lease: String,
    pub local_storage_id: Option<String>,
    pub owner: String,
    pub now_ms: i64,
    pub lease_until: Option<i64>,
}

#[napi(object)]
pub struct JsScheduledJob {
    pub job_id: String,
    pub kind: String,
    pub name: String,
    pub args: String,
    pub due_time: i64,
    pub state: String,
    pub lease_until: Option<i64>,
    pub created_time: i64,
    pub updated_time: i64,
}

#[napi(object)]
pub struct JsRemoteStartOptions {
    pub auth: Option<JsFunction>,
    pub client_id: Option<String>,
    pub module_graph_hash: String,
    pub notify: Option<JsFunction>,
    pub operation_timeout_ms: Option<u32>,
    pub contract_id: String,
    pub receive_timeout_ms: Option<u32>,
    pub schema_hash: String,
    pub transport: Option<JsObject>,
    pub url: String,
}

#[napi(object)]
pub struct JsRemoteConnect {
    pub url: String,
}

#[napi(object)]
pub struct JsRemoteSend {
    pub message: String,
}

#[napi(object)]
pub struct JsRemoteReceive {
    pub timeout_ms: u32,
}

#[napi(object)]
pub struct JsRemoteTransportEvent {
    pub kind: String,
    pub message: Option<String>,
    pub reason: Option<String>,
}

#[napi(object)]
pub struct JsRemoteUpload {
    pub bytes: Uint8Array,
    pub content_type: Option<String>,
    pub local_storage_id: String,
    pub sha256: String,
    pub size: f64,
    pub upload_url: String,
}

#[napi(object)]
pub struct JsRemoteUploadReceipt {
    pub storage_id: String,
}

#[napi(object)]
pub struct JsReroot {
    pub table: String,
    pub id: String,
    pub rev_id: String,
    pub server_doc_id: Option<String>,
    pub base_root_id: Option<String>,
    pub base_node_id: Option<String>,
    pub attached_node_id: Option<String>,
    pub current_root_id: Option<String>,
}

#[napi(object)]
pub struct JsRemoteMutationSettlement {
    pub mutation_id: String,
    pub function_name: String,
    pub outcome: String,
    pub code: Option<String>,
    pub retained_revisions: Vec<JsReroot>,
}

#[napi(object)]
pub struct JsRemotePending {
    pub checkpoints: u32,
    pub inflight: u32,
    pub mutations: u32,
    pub scope: u32,
    pub settlements: u32,
    pub uploads: u32,
}

#[napi(object)]
pub struct JsRemoteTick {
    pub connected: Option<bool>,
    pub changed_tables: Vec<String>,
    pub rows_applied: u32,
    pub pull_attempted: u32,
    pub push_accepted: u32,
    pub push_attempted: u32,
    pub received: u32,
    pub reconnected: bool,
    pub pushed: u32,
    pub push_failed: u32,
    pub push_conflicts: u32,
    pub push_rebases: u32,
    pub retained_revisions: Vec<JsReroot>,
    pub settlements: Vec<JsRemoteMutationSettlement>,
    pub sent: u32,
    pub receipts_pushed: u32,
    pub store_jobs: u32,
    pub pull_changes_applied: u32,
    pub pull_snapshots: u32,
    pub pull_diagnostics: u32,
    pub pull_error: Option<String>,
    pub changed_results: Vec<String>,
    pub pending: Option<JsRemotePending>,
}

#[napi(object)]
pub struct JsRemoteDocPush {
    pub actor_queue_depth: u32,
    pub actor_queue_ms: u32,
    pub state: String,
    pub tick: JsRemoteTick,
}

/// A job posted to the dedicated storage thread.
#[cfg(not(target_arch = "wasm32"))]
type Job = Box<dyn FnOnce(&EmbeddedStore) + Send>;

struct Inner {
    /// Shared so `clockRead` (clock-only, no I/O) can stay synchronous on the JS thread.
    /// No database call may run through this handle outside the storage thread.
    store: Arc<EmbeddedStore>,
    #[cfg(not(target_arch = "wasm32"))]
    jobs: std::sync::mpsc::Sender<Job>,
    #[cfg(not(target_arch = "wasm32"))]
    remote: Option<RemoteClient>,
    #[cfg(target_arch = "wasm32")]
    remote: Option<WasmRemoteHandle>,
    #[cfg(not(target_arch = "wasm32"))]
    thread: Option<std::thread::JoinHandle<()>>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Clone)]
struct WasmRemoteHandle {
    state: Arc<Mutex<WasmRemoteState>>,
}

#[cfg(target_arch = "wasm32")]
type WasmRemoteDriver =
    RemoteDriver<NapiBrowserTransport, WasmRemoteStore, NapiRemoteClock, NapiBrowserUploader>;

#[cfg(target_arch = "wasm32")]
struct WasmRemoteState {
    closing: bool,
    driver: Option<WasmRemoteDriver>,
    pending_scope: Option<RemoteScope>,
    running: bool,
    waiters: Vec<WasmRemoteWaiter>,
}

#[cfg(target_arch = "wasm32")]
struct WasmRemoteDriverLoan {
    driver: Option<WasmRemoteDriver>,
    state: Arc<Mutex<WasmRemoteState>>,
}

#[cfg(target_arch = "wasm32")]
impl WasmRemoteDriverLoan {
    fn new(driver: WasmRemoteDriver, state: Arc<Mutex<WasmRemoteState>>) -> Self {
        Self {
            driver: Some(driver),
            state,
        }
    }

    fn driver_mut(&mut self) -> &mut WasmRemoteDriver {
        self.driver
            .as_mut()
            .expect("Wasm remote driver loan is live until drop")
    }
}

#[cfg(target_arch = "wasm32")]
impl Drop for WasmRemoteDriverLoan {
    fn drop(&mut self) {
        let Some(driver) = self.driver.take() else {
            return;
        };
        let mut state = lock(&self.state);
        state.driver = Some(driver);
        state.running = false;
        wake_next_wasm_remote_waiter(&mut state);
    }
}

#[cfg(target_arch = "wasm32")]
struct WasmRemoteWaiter {
    kind: WasmRemoteWaiterKind,
    sender: oneshot::Sender<()>,
}

#[cfg(target_arch = "wasm32")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum WasmRemoteWaiterKind {
    Background,
    Close,
    Foreground,
}

#[cfg(target_arch = "wasm32")]
struct WasmStoreJob {
    work: Box<dyn FnOnce(&EmbeddedStore) + Send>,
}

#[cfg(target_arch = "wasm32")]
struct WasmRemoteStore {
    dispatch: ThreadsafeFunction<WasmStoreJob, ErrorStrategy::Fatal>,
    job_count: Arc<AtomicUsize>,
}

#[cfg(target_arch = "wasm32")]
impl WasmRemoteStore {
    fn new(dispatch: ThreadsafeFunction<WasmStoreJob, ErrorStrategy::Fatal>) -> Self {
        Self {
            dispatch,
            job_count: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn run<T, F>(&self, work: F) -> Result<T, StorageError>
    where
        T: Send + 'static,
        F: FnOnce(&EmbeddedStore) -> Result<T, StorageError> + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let status = self.dispatch.call(
            WasmStoreJob {
                work: Box::new(move |store| {
                    tx.send(work(store)).ok();
                }),
            },
            ThreadsafeFunctionCallMode::Blocking,
        );
        if status != Status::Ok {
            return Err(StorageError::Unsatisfiable(format!(
                "browser storage lane rejected remote job: {status:?}"
            )));
        }
        self.job_count.fetch_add(1, Ordering::Relaxed);
        rx.recv().map_err(|_| {
            StorageError::Unsatisfiable("browser storage lane terminated".to_owned())
        })?
    }

    fn queue<T, F>(&self, work: F) -> remote::RemoteStoreFuture<T>
    where
        T: Send + 'static,
        F: FnOnce(&EmbeddedStore) -> Result<T, StorageError> + Send + 'static,
    {
        let (tx, rx) = futures_channel::oneshot::channel();
        let status = self.dispatch.call(
            WasmStoreJob {
                work: Box::new(move |store| {
                    tx.send(work(store)).ok();
                }),
            },
            ThreadsafeFunctionCallMode::NonBlocking,
        );
        if status != Status::Ok {
            return Box::pin(std::future::ready(Err(StorageError::Unsatisfiable(
                format!("browser storage lane rejected remote job: {status:?}"),
            ))));
        }
        self.job_count.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            rx.await.map_err(|_| {
                StorageError::Unsatisfiable("browser storage lane terminated".to_owned())
            })?
        })
    }
}

#[napi]
pub struct Store {
    inner: Arc<Mutex<Option<Inner>>>,
}

/// Native surface: every database method is `async` and posts a job to the dedicated storage
/// thread, so `SQLite` I/O never runs on the JS event loop and calls stay FIFO.
#[cfg(not(target_arch = "wasm32"))]
#[napi]
#[allow(clippy::needless_pass_by_value)]
impl Store {
    #[napi]
    pub async fn open(
        path: String,
        selector_key: Option<String>,
        default_identity_key: Option<String>,
    ) -> napi::Result<Store> {
        let selector_key = selector_key.unwrap_or_default();
        let default_identity_key = default_identity_key.unwrap_or_else(|| selector_key.clone());
        let inner = open_inner(path, selector_key, default_identity_key).await?;
        Ok(Store {
            inner: Arc::new(Mutex::new(Some(inner))),
        })
    }

    /// The next monotonic creation time. Synchronous by design: it touches only the in-memory
    /// clock, never the database.
    #[napi]
    pub fn clock_read(&self) -> napi::Result<f64> {
        self.store()?.clock_read().map_err(map_err)
    }

    #[napi]
    pub async fn leader_fence_write(&self) -> napi::Result<String> {
        self.run(storage::EmbeddedStore::leader_fence_write).await
    }

    #[napi]
    pub async fn setup(&self, schema: JsSchema) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(move |store| store.setup(&schema)).await
    }

    #[napi]
    pub async fn migration_begin(&self, schema: JsSchema) -> napi::Result<String> {
        let schema = to_schema(schema)?;
        self.run(move |store| {
            let candidate = store.migration_prepare(&schema)?;
            migration_candidate_json(&candidate)
        })
        .await
    }

    #[napi]
    pub async fn migration_copy_step(&self, generation: i64) -> napi::Result<String> {
        self.run(move |store| migration_step_json(store.migration_copy_step(generation)?))
            .await
    }

    #[napi]
    pub async fn migration_bind(&self, schema: JsSchema, generation: i64) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(move |store| store.migration_bind_prepare(&schema, generation))
            .await
    }

    #[napi]
    pub async fn migration_materialize_step(&self, generation: i64) -> napi::Result<String> {
        self.run(move |store| migration_step_json(store.migration_materialize_step(generation)?))
            .await
    }

    #[napi]
    pub async fn migration_unbind(&self) -> napi::Result<()> {
        self.run(storage::EmbeddedStore::migration_unbind).await
    }

    #[napi]
    pub async fn migration_setup_complete(&self, generation: i64) -> napi::Result<()> {
        self.run(move |store| store.migration_setup_complete(generation))
            .await
    }

    #[napi]
    pub async fn origin_page_read(
        &self,
        generation: i64,
        cursor_json: Option<String>,
        page_size: u32,
        upper_json: Option<String>,
    ) -> napi::Result<String> {
        let cursor = cursor_json
            .as_deref()
            .map(origin_cursor_from_json)
            .transpose()?;
        let upper = upper_json
            .as_deref()
            .map(origin_cursor_from_json)
            .transpose()?;
        self.run(move |store| {
            let page = store.origin_page_read_bounded(
                generation,
                cursor.as_ref(),
                upper.as_ref(),
                page_size as usize,
            )?;
            origin_page_json(&page)
        })
        .await
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub async fn migration_record_disposition_write(
        &self,
        generation: i64,
        identity_key: String,
        kind: i64,
        record_key: Uint8Array,
        migration_id: String,
        reason: String,
        discard: bool,
    ) -> napi::Result<()> {
        self.run(move |store| {
            store.migration_record_disposition_write(
                generation,
                &identity_key,
                kind,
                record_key.as_ref(),
                &migration_id,
                &reason,
                discard,
            )
        })
        .await
    }

    #[napi]
    pub async fn migration_queue_policy_state_read(&self, generation: i64) -> napi::Result<String> {
        self.run(move |store| store.migration_queue_policy_state_read(generation))
            .await
    }

    #[napi]
    pub async fn migration_queue_policy_write(
        &self,
        generation: i64,
        policy_json: String,
    ) -> napi::Result<bool> {
        self.run(move |store| store.migration_queue_policy_write(generation, &policy_json))
            .await
    }

    #[napi]
    pub async fn migration_finalize_prepare(
        &self,
        schema: JsSchema,
        generation: i64,
    ) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(move |store| store.migration_finalize_prepare(&schema, generation))
            .await
    }

    #[napi]
    pub async fn migration_commit(&self, schema: JsSchema, generation: i64) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(move |store| store.migration_cutover(&schema, generation))
            .await
    }

    #[napi]
    pub async fn migration_retire_step(&self, generation: i64) -> napi::Result<String> {
        self.run(move |store| migration_step_json(store.migration_retire_step(generation)?))
            .await
    }

    #[napi]
    pub async fn migration_retire(&self, generation: i64) -> napi::Result<()> {
        self.run(move |store| store.migration_retire(generation))
            .await
    }

    #[napi]
    pub async fn identity_read(&self) -> napi::Result<String> {
        self.run(|store| {
            let (identity_key, identity) = store.identity_read()?;
            serde_json::to_string(&serde_json::json!({
                "identity": identity
                    .as_deref()
                    .map(serde_json::from_str::<serde_json::Value>)
                    .transpose()
                    .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?
                    .unwrap_or(serde_json::Value::Null),
                "identityKey": identity_key,
            }))
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))
        })
        .await
    }

    #[napi]
    pub async fn identity_write(
        &self,
        identity_key: String,
        identity_json: Option<String>,
    ) -> napi::Result<()> {
        self.run(move |store| store.identity_write(&identity_key, identity_json.as_deref()))
            .await
    }

    #[napi]
    pub async fn mutation_write(&self, call: JsMutationCall) -> napi::Result<JsMutationRecord> {
        let call = to_mutation_call(call);
        self.run(move |store| store.mutation_write(&call).map(js_mutation_record))
            .await
    }

    #[napi]
    pub async fn mutation_cache_read(
        &self,
        call: JsMutationCall,
    ) -> napi::Result<JsMutationRecord> {
        let call = to_mutation_call(call);
        self.run(move |store| store.mutation_cache_read(&call).map(js_mutation_record))
            .await
    }

    #[napi]
    pub async fn mutation_cache_write(
        &self,
        call: JsMutationCall,
    ) -> napi::Result<JsMutationRecord> {
        let call = to_mutation_call(call);
        self.run(move |store| store.mutation_cache_write(&call).map(js_mutation_record))
            .await
    }

    #[napi]
    pub async fn mutation_fail(&self, mutation_id: String, error: String) -> napi::Result<()> {
        self.run(move |store| store.mutation_fail(&mutation_id, &error))
            .await
    }

    #[napi]
    pub async fn commit(
        &self,
        batch: JsWriteBatch,
        options: Option<JsCommitOptions>,
    ) -> napi::Result<JsCommitResult> {
        let batch = to_write_batch(batch)?;
        let include_changes = commit_include_changes(options.as_ref());
        let options = to_commit_options(options)?;
        self.run(move |store| {
            store
                .commit(batch, &options)
                .map(|result| js_commit_result(result, include_changes))
        })
        .await
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub async fn commit_one_doc_write(
        &self,
        table: String,
        id: String,
        data: String,
        cols: Vec<JsColValue>,
        creation_time: f64,
        source: Option<String>,
        mutation_id: Option<String>,
        mutation_name: Option<String>,
        mutation_args: Option<String>,
        mutation_result: Option<String>,
        include_changes: Option<bool>,
        fresh: Option<bool>,
        data_only: Option<bool>,
        mutation_is_fresh: Option<bool>,
    ) -> napi::Result<JsCommitResult> {
        let cols = cols
            .into_iter()
            .map(to_col)
            .collect::<napi::Result<Vec<_>>>()?;
        let doc_write = DocWrite {
            table,
            id,
            data,
            cols,
            creation_time,
        };
        let include_changes = include_changes.unwrap_or(true);
        let options = decode_commit_options(
            source.as_deref(),
            mutation_id,
            mutation_name,
            mutation_args,
            mutation_result,
            None,
            None,
            mutation_is_fresh,
            Some(include_changes),
        )?;
        let fresh = fresh.unwrap_or(false);
        let data_only = data_only.unwrap_or(false);
        self.run(move |store| {
            store
                .commit_one_doc_write(doc_write, &options, fresh, data_only)
                .map(|result| js_commit_result(result, include_changes))
        })
        .await
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub async fn commit_one_doc_write_encoded(
        &self,
        table: String,
        id: String,
        data: String,
        encoded_cols: Uint8Array,
        creation_time: f64,
        source: Option<String>,
        mutation_id: Option<String>,
        mutation_name: Option<String>,
        mutation_args: Option<String>,
        mutation_result: Option<String>,
        fresh: Option<bool>,
        data_only: Option<bool>,
        mutation_is_fresh: Option<bool>,
    ) -> napi::Result<i64> {
        let encoded_cols = decode_encoded_col_keys(&encoded_cols)?;
        let options = decode_commit_options(
            source.as_deref(),
            mutation_id,
            mutation_name,
            mutation_args,
            mutation_result,
            None,
            None,
            mutation_is_fresh,
            Some(false),
        )?;
        let fresh = fresh.unwrap_or(false);
        let data_only = data_only.unwrap_or(false);
        self.run(move |store| {
            store
                .commit_one_doc_write_encoded(
                    table,
                    id,
                    data,
                    encoded_cols,
                    creation_time,
                    &options,
                    fresh,
                    data_only,
                )
                .map(|result| result.commit_seq)
        })
        .await
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn commit_one_doc_write_encoded_deferred(
        &self,
        env: Env,
        table: String,
        id: String,
        data: String,
        encoded_cols: Uint8Array,
        creation_time: f64,
        source: Option<String>,
        mutation_id: Option<String>,
        mutation_name: Option<String>,
        mutation_args: Option<String>,
        mutation_result: Option<String>,
        fresh: Option<bool>,
        data_only: Option<bool>,
        mutation_is_fresh: Option<bool>,
    ) -> napi::Result<JsObject> {
        let encoded_cols = decode_encoded_col_keys(&encoded_cols)?;
        let options = decode_commit_options(
            source.as_deref(),
            mutation_id,
            mutation_name,
            mutation_args,
            mutation_result,
            None,
            None,
            mutation_is_fresh,
            Some(false),
        )?;
        let fresh = fresh.unwrap_or(false);
        let data_only = data_only.unwrap_or(false);
        let jobs = lock(&self.inner)
            .as_ref()
            .map(|inner| inner.jobs.clone())
            .ok_or_else(store_closed)?;
        let (deferred, promise) = env.create_deferred::<i64, _>()?;
        jobs.send(Box::new(move |store| {
            let result = store
                .commit_one_doc_write_encoded(
                    table,
                    id,
                    data,
                    encoded_cols,
                    creation_time,
                    &options,
                    fresh,
                    data_only,
                )
                .map(|commit| commit.commit_seq);
            match result {
                Ok(commit_seq) => deferred.resolve(move |_| Ok(commit_seq)),
                Err(error) => deferred.reject(map_err(error)),
            }
        }))
        .map_err(|_| napi::Error::from_reason("storage thread terminated"))?;
        Ok(promise)
    }

    #[napi]
    pub async fn doc_read(&self, table: String, id: String) -> napi::Result<Option<String>> {
        self.run(move |store| store.doc_read(&table, &id)).await
    }

    #[napi]
    pub async fn local_fields_read(&self, table: String, id: String) -> napi::Result<String> {
        self.run(move |store| {
            serde_json::to_string(&store.local_fields_read(&table, &id)?).map_err(|error| {
                StorageError::Decode {
                    expected: "device fields JSON",
                    index: 0,
                    got: error.to_string(),
                }
            })
        })
        .await
    }

    #[napi]
    pub async fn doc_version_read(&self, table: String, id: String) -> napi::Result<Option<i64>> {
        self.run(move |store| store.doc_version_read(&table, &id))
            .await
    }

    #[napi]
    pub async fn crdt_head_read(
        &self,
        table: String,
        id: String,
        field: String,
    ) -> napi::Result<Option<i64>> {
        self.run(move |store| store.crdt_head_read(&table, &id, &field))
            .await
    }

    #[napi]
    pub async fn crdt_snapshot_read(
        &self,
        table: String,
        id: String,
        ops: Option<Vec<JsCrdtOp>>,
    ) -> napi::Result<Vec<JsCrdtSnapshot>> {
        let ops = ops
            .unwrap_or_default()
            .into_iter()
            .map(to_crdt_op)
            .collect::<napi::Result<Vec<_>>>()?;
        self.run(move |store| store.crdt_snapshot_read_with_ops(&table, &id, &ops))
            .await
            .map(|snapshots| snapshots.into_iter().map(js_crdt_snapshot).collect())
    }

    #[napi]
    pub async fn doc_page_read(&self, spec: JsReadSpec) -> napi::Result<JsPage> {
        let spec = to_read_spec(spec)?;
        self.run(move |store| store.doc_page_read(&spec).map(js_page))
            .await
    }

    #[napi]
    pub async fn key_page_read(&self, spec: JsReadSpec) -> napi::Result<JsPage> {
        let spec = to_read_spec(spec)?;
        self.run(move |store| store.key_page_read(&spec).map(js_page))
            .await
    }

    #[napi]
    pub async fn doc_count_read(&self, spec: JsCountSpec) -> napi::Result<Option<i64>> {
        let spec = to_count_spec(spec)?;
        self.run(move |store| store.doc_count_read(&spec)).await
    }

    #[napi]
    pub async fn ledger_delete(&self, up_to_seq: i64) -> napi::Result<JsDeleteResult> {
        self.run(move |store| store.ledger_delete(up_to_seq).map(js_delete_result))
            .await
    }

    #[napi]
    pub async fn wal_write(&self) -> napi::Result<()> {
        self.run(storage::EmbeddedStore::wal_write).await
    }

    #[napi]
    pub async fn blob_read(&self, key: String) -> napi::Result<Option<Uint8Array>> {
        let bytes = self.run(move |store| store.blob_read(&key)).await?;
        Ok(bytes.map(Uint8Array::from))
    }

    #[napi]
    pub async fn blob_write(&self, key: String, bytes: Uint8Array) -> napi::Result<()> {
        let bytes = bytes.to_vec();
        self.run(move |store| store.blob_write(&key, bytes)).await
    }

    #[napi]
    pub async fn blob_delete(&self, key: String) -> napi::Result<()> {
        self.run(move |store| store.blob_delete(&key)).await
    }

    #[napi]
    pub async fn result_read(&self, key: String) -> napi::Result<Option<JsResultEntry>> {
        self.run(move |store| {
            store
                .result_read(&key)
                .map(|entry| entry.map(js_result_entry))
        })
        .await
    }

    #[napi]
    pub async fn result_write(&self, entry: JsResultEntry) -> napi::Result<bool> {
        let entry = to_result_entry(entry);
        self.run(move |store| store.result_write(&entry)).await
    }

    #[napi]
    pub async fn result_delete(&self, key: String) -> napi::Result<()> {
        self.run(move |store| store.result_delete(&key)).await
    }

    #[napi]
    pub async fn doc_base_read(&self, table: String, id: String) -> napi::Result<Option<String>> {
        self.run(move |store| store.remote_doc_read(&table, &id).map(base_row_of))
            .await
    }

    #[napi]
    pub async fn id_write(&self, mapping: JsIdMapping) -> napi::Result<()> {
        let mapping = to_id_mapping(mapping)?;
        self.run(move |store| store.id_write(&mapping)).await
    }

    #[napi]
    pub async fn id_read(
        &self,
        table: String,
        local_id: String,
    ) -> napi::Result<Option<JsIdMapping>> {
        self.run(move |store| {
            store
                .id_read(&table, &local_id)
                .map(|m| m.map(js_id_mapping))
        })
        .await
    }

    #[napi]
    pub async fn id_page_read(&self, table: String) -> napi::Result<Vec<JsIdMapping>> {
        self.run(move |store| {
            store
                .id_page_read(&table)
                .map(|rows| rows.into_iter().map(js_id_mapping).collect())
        })
        .await
    }

    #[napi]
    pub async fn dirty_heads_debug_read(&self) -> napi::Result<Vec<JsDirtyHeadDebug>> {
        self.run(move |store| {
            store
                .dirty_heads_debug_read()
                .map(|rows| rows.into_iter().map(js_dirty_head_debug).collect())
        })
        .await
    }

    #[napi]
    pub async fn remote_doc_debug_read(
        &self,
        table: String,
        local_id: String,
    ) -> napi::Result<Option<JsRemoteDocDebug>> {
        self.run(move |store| {
            store
                .remote_doc_read(&table, &local_id)
                .map(|row| row.map(js_remote_doc_debug))
        })
        .await
    }

    #[napi]
    pub async fn remote_cursor_debug_read(
        &self,
        subscription: String,
    ) -> napi::Result<Option<String>> {
        self.run(move |store| store.remote_cursor_read(&subscription))
            .await
    }

    #[napi]
    pub async fn remote_member_debug_read(&self, subscription: String) -> napi::Result<String> {
        self.run(move |store| {
            let members = store.remote_member_read(&subscription)?;
            serde_json::to_string(
                &members
                    .iter()
                    .map(|member| {
                        serde_json::json!({
                            "table": member.table,
                            "serverDocumentId": member.server_document_id,
                        })
                    })
                    .collect::<Vec<_>>(),
            )
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))
        })
        .await
    }

    #[napi]
    pub async fn id_delete(&self, table: String, local_id: String) -> napi::Result<()> {
        self.run(move |store| store.id_delete(&table, &local_id))
            .await
    }

    #[napi]
    pub async fn file_meta_write(&self, metadata: JsFileMetadata) -> napi::Result<()> {
        let metadata = to_file_metadata(metadata);
        self.run(move |store| store.file_meta_write(&metadata))
            .await
    }

    #[napi]
    pub async fn file_read(&self, storage_id: String) -> napi::Result<Option<JsFileMetadata>> {
        self.run(move |store| {
            store
                .file_read(&storage_id)
                .map(|m| m.map(js_file_metadata))
        })
        .await
    }

    #[napi]
    pub async fn file_delete(&self, storage_id: String) -> napi::Result<()> {
        self.run(move |store| store.file_delete(&storage_id)).await
    }

    #[napi]
    pub async fn file_write(&self, input: JsFileStore) -> napi::Result<()> {
        let input = to_file_store(input);
        self.run(move |store| store.file_write(&input)).await
    }

    #[napi]
    pub async fn upload_write(&self, upload: JsPendingUpload) -> napi::Result<()> {
        let upload = to_pending_upload(upload)?;
        self.run(move |store| store.upload_write(&upload)).await
    }

    #[napi]
    pub async fn upload_read(&self) -> napi::Result<Vec<JsPendingUpload>> {
        self.run(move |store| {
            store
                .upload_read()
                .map(|rows| rows.into_iter().map(js_pending_upload).collect())
        })
        .await
    }

    #[napi]
    pub async fn upload_lease_write(
        &self,
        args: JsUploadLeaseWrite,
    ) -> napi::Result<Option<JsPendingUpload>> {
        let args = to_upload_lease_write(args)?;
        self.run(move |store| {
            store
                .upload_lease_write(args)
                .map(|row| row.map(js_pending_upload))
        })
        .await
    }

    #[napi]
    pub async fn upload_complete(
        &self,
        local_storage_id: String,
        owner: String,
        convex_id: String,
        now_ms: i64,
    ) -> napi::Result<bool> {
        self.run(move |store| store.upload_complete(&local_storage_id, &owner, &convex_id, now_ms))
            .await
    }

    #[napi]
    pub async fn upload_delete(&self, local_storage_id: String) -> napi::Result<()> {
        self.run(move |store| store.upload_delete(&local_storage_id))
            .await
    }

    #[napi]
    pub async fn schedule_write(&self, job: JsScheduledJob) -> napi::Result<()> {
        let job = to_scheduled_job(job)?;
        self.run(move |store| store.schedule_write(&job)).await
    }

    #[napi]
    pub async fn schedule_read(&self) -> napi::Result<Vec<JsScheduledJob>> {
        self.run(move |store| {
            store
                .schedule_read()
                .map(|rows| rows.into_iter().map(js_scheduled_job).collect())
        })
        .await
    }

    #[napi]
    pub async fn schedule_lease_write(&self, now_ms: i64) -> napi::Result<Option<JsScheduledJob>> {
        self.run(move |store| {
            store
                .schedule_lease_write(now_ms)
                .map(|row| row.map(js_scheduled_job))
        })
        .await
    }

    #[napi]
    pub async fn schedule_complete(
        &self,
        job_id: String,
        now_ms: i64,
    ) -> napi::Result<Option<JsScheduledJob>> {
        self.run(move |store| {
            store
                .schedule_complete(&job_id, now_ms)
                .map(|row| row.map(js_scheduled_job))
        })
        .await
    }

    #[napi]
    pub async fn schedule_fail(
        &self,
        job_id: String,
        now_ms: i64,
    ) -> napi::Result<Option<JsScheduledJob>> {
        self.run(move |store| {
            store
                .schedule_fail(&job_id, now_ms)
                .map(|row| row.map(js_scheduled_job))
        })
        .await
    }

    #[napi]
    pub async fn schedule_cancel(
        &self,
        job_id: String,
        now_ms: i64,
    ) -> napi::Result<Option<JsScheduledJob>> {
        self.run(move |store| {
            store
                .schedule_cancel(&job_id, now_ms)
                .map(|row| row.map(js_scheduled_job))
        })
        .await
    }

    #[napi]
    pub async fn clear(&self) -> napi::Result<()> {
        self.run(EmbeddedStore::clear).await
    }

    #[napi]
    pub fn remote_start(&self, mut options: JsRemoteStartOptions) -> napi::Result<()> {
        let notify = options
            .notify
            .take()
            .map(|notify| {
                notify.create_threadsafe_function::<
                    JsRemoteTick,
                    JsRemoteTick,
                    _,
                    ErrorStrategy::Fatal,
                >(0, |ctx| Ok(vec![ctx.value]))
            })
            .transpose()?;
        let config = remote_config(options)?;
        let mut inner = lock(&self.inner);
        let inner = inner.as_mut().ok_or_else(store_closed)?;
        if inner.remote.is_some() {
            return Err(napi::Error::from_reason("remote client is already started"));
        }
        let remote = RemoteClient::open_with_store(
            config,
            Box::new(NativeRemoteStore {
                jobs: inner.jobs.clone(),
                job_count: Arc::new(AtomicUsize::new(0)),
            }),
        )
        .map_err(map_remote_err)?;
        napi::bindgen_prelude::within_runtime_if_available(|| {
            if let Some(notify) = notify {
                remote.start_with_observer(move |tick| {
                    notify.call(
                        js_remote_tick(tick),
                        ThreadsafeFunctionCallMode::NonBlocking,
                    );
                })
            } else {
                remote.start()
            }
        })
        .map_err(map_remote_err)?;
        inner.remote = Some(remote);
        Ok(())
    }

    #[napi]
    pub async fn remote_close(&self) -> napi::Result<()> {
        let remote = lock(&self.inner)
            .as_mut()
            .and_then(|inner| inner.remote.take());
        if let Some(remote) = remote {
            remote.close().await.map_err(map_remote_err)?;
        }
        Ok(())
    }

    #[napi]
    pub async fn remote_pull(&self, _local_progress: bool) -> napi::Result<JsRemoteTick> {
        let remote = lock(&self.inner)
            .as_ref()
            .and_then(|inner| inner.remote.clone())
            .ok_or_else(|| napi::Error::from_reason("remote client is not started"))?;
        remote
            .pull()
            .await
            .map(js_remote_tick)
            .map_err(map_remote_err)
    }

    #[napi]
    pub async fn remote_identity(&self) -> napi::Result<String> {
        let remote = self.remote_client()?;
        remote.identity().await.map_err(map_remote_err)
    }

    #[napi]
    pub async fn remote_doc_push(
        &self,
        table: String,
        local_document_id: String,
        first_commit_seq: i64,
        updated_commit_seq: i64,
    ) -> napi::Result<JsRemoteDocPush> {
        let remote = lock(&self.inner)
            .as_ref()
            .and_then(|inner| inner.remote.clone())
            .ok_or_else(|| napi::Error::from_reason("remote client is not started"))?;
        remote
            .doc_push(
                &table,
                &local_document_id,
                storage::DirtyHeadToken {
                    first_commit_seq,
                    updated_commit_seq,
                },
            )
            .await
            .map(|pushed| js_remote_doc_push(pushed, 0, 0))
            .map_err(map_remote_err)
    }

    #[napi]
    pub async fn remote_scope_write(&self, scope_json: String) -> napi::Result<()> {
        let scope = parse_remote_scope(&scope_json)?;
        let remote = self.remote_client()?;
        remote.scope_write(scope).await.map_err(map_remote_err)
    }

    /// Close the store. Jobs already posted drain first, then the storage thread is joined.
    #[napi]
    #[allow(
        clippy::unused_async,
        clippy::unused_async_trait_impl,
        reason = "async keeps close() a Promise like every other method, and the body runs (and \
                  joins the storage thread) on the async runtime rather than the JS thread"
    )]
    pub async fn close(&self) -> napi::Result<()> {
        let inner = { lock(&self.inner).take() };
        if let Some(inner) = inner {
            let mut inner = inner;
            let remote_result = if let Some(remote) = inner.remote.take() {
                remote.close().await.map_err(map_remote_err)
            } else {
                Ok(())
            };
            let Inner {
                store,
                jobs,
                thread,
                remote: _,
            } = inner;
            drop(jobs);
            drop(store);
            if let Some(thread) = thread {
                thread.join().ok();
            }
            remote_result?;
        }
        Ok(())
    }
}

/// Wasm surface: the OPFS runtime worker that instantiated the module is the dedicated storage
/// thread — its sync-access handles are unreachable from napi's async-work child threads, so
/// every method is synchronous and runs inline on the calling worker. The TS adapter awaits
/// plain values the same as Promises.
#[cfg(target_arch = "wasm32")]
#[napi]
#[allow(clippy::needless_pass_by_value)]
impl Store {
    #[napi]
    pub fn open(
        path: String,
        selector_key: Option<String>,
        default_identity_key: Option<String>,
    ) -> napi::Result<Store> {
        let selector_key = selector_key.unwrap_or_default();
        let default_identity_key = default_identity_key.unwrap_or_else(|| selector_key.clone());
        let store = EmbeddedStore::open_with_cached_identity_key(
            &path,
            &selector_key,
            &default_identity_key,
        )
        .map_err(map_err)?;
        Ok(Store {
            inner: Arc::new(Mutex::new(Some(Inner {
                store: Arc::new(store),
                remote: None,
            }))),
        })
    }

    /// The next monotonic creation time. It touches only the in-memory clock, never the database.
    #[napi]
    pub fn clock_read(&self) -> napi::Result<f64> {
        self.store()?.clock_read().map_err(map_err)
    }

    #[napi]
    pub fn leader_fence_write(&self) -> napi::Result<String> {
        self.run(storage::EmbeddedStore::leader_fence_write)
    }

    #[napi]
    pub fn setup(&self, schema: JsSchema) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(|store| store.setup(&schema))
    }

    #[napi]
    pub fn migration_begin(&self, schema: JsSchema) -> napi::Result<String> {
        let schema = to_schema(schema)?;
        self.run(|store| {
            let candidate = store.migration_prepare(&schema)?;
            migration_candidate_json(&candidate)
        })
    }

    #[napi]
    pub fn migration_copy_step(&self, generation: i64) -> napi::Result<String> {
        self.run(|store| migration_step_json(store.migration_copy_step(generation)?))
    }

    #[napi]
    pub fn migration_bind(&self, schema: JsSchema, generation: i64) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(|store| store.migration_bind_prepare(&schema, generation))
    }

    #[napi]
    pub fn migration_materialize_step(&self, generation: i64) -> napi::Result<String> {
        self.run(|store| migration_step_json(store.migration_materialize_step(generation)?))
    }

    #[napi]
    pub fn migration_unbind(&self) -> napi::Result<()> {
        self.run(|store| store.migration_unbind())
    }

    #[napi]
    pub fn migration_setup_complete(&self, generation: i64) -> napi::Result<()> {
        self.run(|store| store.migration_setup_complete(generation))
    }

    #[napi]
    pub fn origin_page_read(
        &self,
        generation: i64,
        cursor_json: Option<String>,
        page_size: u32,
        upper_json: Option<String>,
    ) -> napi::Result<String> {
        let cursor = cursor_json
            .as_deref()
            .map(origin_cursor_from_json)
            .transpose()?;
        let upper = upper_json
            .as_deref()
            .map(origin_cursor_from_json)
            .transpose()?;
        self.run(|store| {
            let page = store.origin_page_read_bounded(
                generation,
                cursor.as_ref(),
                upper.as_ref(),
                page_size as usize,
            )?;
            origin_page_json(&page)
        })
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn migration_record_disposition_write(
        &self,
        generation: i64,
        identity_key: String,
        kind: i64,
        record_key: Uint8Array,
        migration_id: String,
        reason: String,
        discard: bool,
    ) -> napi::Result<()> {
        self.run(|store| {
            store.migration_record_disposition_write(
                generation,
                &identity_key,
                kind,
                record_key.as_ref(),
                &migration_id,
                &reason,
                discard,
            )
        })
    }

    #[napi]
    pub fn migration_queue_policy_state_read(&self, generation: i64) -> napi::Result<String> {
        self.run(|store| store.migration_queue_policy_state_read(generation))
    }

    #[napi]
    pub fn migration_queue_policy_write(
        &self,
        generation: i64,
        policy_json: String,
    ) -> napi::Result<bool> {
        self.run(|store| store.migration_queue_policy_write(generation, &policy_json))
    }

    #[napi]
    pub fn migration_finalize_prepare(
        &self,
        schema: JsSchema,
        generation: i64,
    ) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(|store| store.migration_finalize_prepare(&schema, generation))
    }

    #[napi]
    pub fn migration_commit(&self, schema: JsSchema, generation: i64) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(|store| store.migration_cutover(&schema, generation))
    }

    #[napi]
    pub fn migration_retire_step(&self, generation: i64) -> napi::Result<String> {
        self.run(|store| migration_step_json(store.migration_retire_step(generation)?))
    }

    #[napi]
    pub fn migration_retire(&self, generation: i64) -> napi::Result<()> {
        self.run(|store| store.migration_retire(generation))
    }

    #[napi]
    pub fn identity_read(&self) -> napi::Result<String> {
        self.run(|store| {
            let (identity_key, identity) = store.identity_read()?;
            serde_json::to_string(&serde_json::json!({
                "identity": identity
                    .as_deref()
                    .map(serde_json::from_str::<serde_json::Value>)
                    .transpose()
                    .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?
                    .unwrap_or(serde_json::Value::Null),
                "identityKey": identity_key,
            }))
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))
        })
    }

    #[napi]
    pub fn identity_write(
        &self,
        identity_key: String,
        identity_json: Option<String>,
    ) -> napi::Result<()> {
        self.run(|store| store.identity_write(&identity_key, identity_json.as_deref()))
    }

    #[napi]
    pub fn wal_write(&self) -> napi::Result<()> {
        self.run(|store| store.wal_write())
    }

    #[napi]
    pub fn mutation_write(&self, call: JsMutationCall) -> napi::Result<JsMutationRecord> {
        let call = to_mutation_call(call);
        self.run(|store| store.mutation_write(&call).map(js_mutation_record))
    }

    #[napi]
    pub fn mutation_cache_read(&self, call: JsMutationCall) -> napi::Result<JsMutationRecord> {
        let call = to_mutation_call(call);
        self.run(|store| store.mutation_cache_read(&call).map(js_mutation_record))
    }

    #[napi]
    pub fn mutation_cache_write(&self, call: JsMutationCall) -> napi::Result<JsMutationRecord> {
        let call = to_mutation_call(call);
        self.run(|store| store.mutation_cache_write(&call).map(js_mutation_record))
    }

    #[napi]
    pub fn mutation_fail(&self, mutation_id: String, error: String) -> napi::Result<()> {
        self.run(|store| store.mutation_fail(&mutation_id, &error))
    }

    #[napi]
    pub fn commit(
        &self,
        batch: JsWriteBatch,
        options: Option<JsCommitOptions>,
    ) -> napi::Result<JsCommitResult> {
        let batch = to_write_batch(batch)?;
        let include_changes = commit_include_changes(options.as_ref());
        let options = to_commit_options(options)?;
        self.run(|store| {
            store
                .commit(batch, &options)
                .map(|result| js_commit_result(result, include_changes))
        })
    }

    #[napi]
    #[allow(clippy::too_many_arguments)]
    pub fn commit_one_doc_write_encoded(
        &self,
        table: String,
        id: String,
        data: String,
        encoded_cols: Uint8Array,
        creation_time: f64,
        source: Option<String>,
        mutation_id: Option<String>,
        mutation_name: Option<String>,
        mutation_args: Option<String>,
        mutation_result: Option<String>,
        fresh: Option<bool>,
        data_only: Option<bool>,
        mutation_is_fresh: Option<bool>,
    ) -> napi::Result<i64> {
        let encoded_cols = decode_encoded_col_keys(&encoded_cols)?;
        let options = decode_commit_options(
            source.as_deref(),
            mutation_id,
            mutation_name,
            mutation_args,
            mutation_result,
            None,
            None,
            mutation_is_fresh,
            Some(false),
        )?;
        self.run(|store| {
            store
                .commit_one_doc_write_encoded(
                    table,
                    id,
                    data,
                    encoded_cols,
                    creation_time,
                    &options,
                    fresh.unwrap_or(false),
                    data_only.unwrap_or(false),
                )
                .map(|result| result.commit_seq)
        })
    }

    #[napi]
    pub fn doc_read(&self, table: String, id: String) -> napi::Result<Option<String>> {
        self.run(|store| store.doc_read(&table, &id))
    }

    #[napi]
    pub fn local_fields_read(&self, table: String, id: String) -> napi::Result<String> {
        self.run(|store| {
            serde_json::to_string(&store.local_fields_read(&table, &id)?).map_err(|error| {
                StorageError::Decode {
                    expected: "device fields JSON",
                    index: 0,
                    got: error.to_string(),
                }
            })
        })
    }

    #[napi]
    pub fn doc_version_read(&self, table: String, id: String) -> napi::Result<Option<i64>> {
        self.run(|store| store.doc_version_read(&table, &id))
    }

    #[napi]
    pub fn crdt_head_read(
        &self,
        table: String,
        id: String,
        field: String,
    ) -> napi::Result<Option<i64>> {
        self.run(|store| store.crdt_head_read(&table, &id, &field))
    }

    #[napi]
    pub fn crdt_snapshot_read(
        &self,
        table: String,
        id: String,
        ops: Option<Vec<JsCrdtOp>>,
    ) -> napi::Result<Vec<JsCrdtSnapshot>> {
        let ops = ops
            .unwrap_or_default()
            .into_iter()
            .map(to_crdt_op)
            .collect::<napi::Result<Vec<_>>>()?;
        self.run(|store| store.crdt_snapshot_read_with_ops(&table, &id, &ops))
            .map(|snapshots| snapshots.into_iter().map(js_crdt_snapshot).collect())
    }

    #[napi]
    pub fn doc_page_read(&self, spec: JsReadSpec) -> napi::Result<JsPage> {
        let spec = to_read_spec(spec)?;
        self.run(|store| store.doc_page_read(&spec).map(js_page))
    }

    #[napi]
    pub fn key_page_read(&self, spec: JsReadSpec) -> napi::Result<JsPage> {
        let spec = to_read_spec(spec)?;
        self.run(|store| store.key_page_read(&spec).map(js_page))
    }

    #[napi]
    pub fn doc_count_read(&self, spec: JsCountSpec) -> napi::Result<Option<i64>> {
        let spec = to_count_spec(spec)?;
        self.run(|store| store.doc_count_read(&spec))
    }

    #[napi]
    pub fn ledger_delete(&self, up_to_seq: i64) -> napi::Result<JsDeleteResult> {
        self.run(|store| store.ledger_delete(up_to_seq).map(js_delete_result))
    }

    #[napi]
    pub fn blob_read(&self, key: String) -> napi::Result<Option<Uint8Array>> {
        let bytes = self.run(|store| store.blob_read(&key))?;
        Ok(bytes.map(Uint8Array::from))
    }

    #[napi]
    pub fn blob_write(&self, key: String, bytes: Uint8Array) -> napi::Result<()> {
        let bytes = bytes.to_vec();
        self.run(|store| store.blob_write(&key, bytes))
    }

    #[napi]
    pub fn blob_delete(&self, key: String) -> napi::Result<()> {
        self.run(|store| store.blob_delete(&key))
    }

    #[napi]
    pub fn result_read(&self, key: String) -> napi::Result<Option<JsResultEntry>> {
        self.run(|store| {
            store
                .result_read(&key)
                .map(|entry| entry.map(js_result_entry))
        })
    }

    #[napi]
    pub fn result_write(&self, entry: JsResultEntry) -> napi::Result<bool> {
        let entry = to_result_entry(entry);
        self.run(|store| store.result_write(&entry))
    }

    #[napi]
    pub fn result_delete(&self, key: String) -> napi::Result<()> {
        self.run(|store| store.result_delete(&key))
    }

    #[napi]
    pub fn doc_base_read(&self, table: String, id: String) -> napi::Result<Option<String>> {
        self.run(|store| store.remote_doc_read(&table, &id).map(base_row_of))
    }

    #[napi]
    pub fn id_write(&self, mapping: JsIdMapping) -> napi::Result<()> {
        let mapping = to_id_mapping(mapping)?;
        self.run(|store| store.id_write(&mapping))
    }

    #[napi]
    pub fn id_read(&self, table: String, local_id: String) -> napi::Result<Option<JsIdMapping>> {
        self.run(|store| {
            store
                .id_read(&table, &local_id)
                .map(|m| m.map(js_id_mapping))
        })
    }

    #[napi]
    pub fn id_page_read(&self, table: String) -> napi::Result<Vec<JsIdMapping>> {
        self.run(|store| {
            store
                .id_page_read(&table)
                .map(|rows| rows.into_iter().map(js_id_mapping).collect())
        })
    }

    #[napi]
    pub fn dirty_heads_debug_read(&self) -> napi::Result<Vec<JsDirtyHeadDebug>> {
        self.run(|store| {
            store
                .dirty_heads_debug_read()
                .map(|rows| rows.into_iter().map(js_dirty_head_debug).collect())
        })
    }

    #[napi]
    pub fn remote_doc_debug_read(
        &self,
        table: String,
        local_id: String,
    ) -> napi::Result<Option<JsRemoteDocDebug>> {
        self.run(|store| {
            store
                .remote_doc_read(&table, &local_id)
                .map(|row| row.map(js_remote_doc_debug))
        })
    }

    #[napi]
    pub fn remote_cursor_debug_read(&self, subscription: String) -> napi::Result<Option<String>> {
        self.run(|store| store.remote_cursor_read(&subscription))
    }

    #[napi]
    pub fn remote_member_debug_read(&self, subscription: String) -> napi::Result<String> {
        self.run(|store| {
            let members = store.remote_member_read(&subscription)?;
            serde_json::to_string(
                &members
                    .iter()
                    .map(|member| {
                        serde_json::json!({
                            "table": member.table,
                            "serverDocumentId": member.server_document_id,
                        })
                    })
                    .collect::<Vec<_>>(),
            )
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))
        })
    }

    #[napi]
    pub fn id_delete(&self, table: String, local_id: String) -> napi::Result<()> {
        self.run(|store| store.id_delete(&table, &local_id))
    }

    #[napi]
    pub fn file_meta_write(&self, metadata: JsFileMetadata) -> napi::Result<()> {
        let metadata = to_file_metadata(metadata);
        self.run(|store| store.file_meta_write(&metadata))
    }

    #[napi]
    pub fn file_read(&self, storage_id: String) -> napi::Result<Option<JsFileMetadata>> {
        self.run(|store| {
            store
                .file_read(&storage_id)
                .map(|m| m.map(js_file_metadata))
        })
    }

    #[napi]
    pub fn file_delete(&self, storage_id: String) -> napi::Result<()> {
        self.run(|store| store.file_delete(&storage_id))
    }

    #[napi]
    pub fn file_write(&self, input: JsFileStore) -> napi::Result<()> {
        let input = to_file_store(input);
        self.run(|store| store.file_write(&input))
    }

    #[napi]
    pub fn upload_write(&self, upload: JsPendingUpload) -> napi::Result<()> {
        let upload = to_pending_upload(upload)?;
        self.run(|store| store.upload_write(&upload))
    }

    #[napi]
    pub fn upload_read(&self) -> napi::Result<Vec<JsPendingUpload>> {
        self.run(|store| {
            store
                .upload_read()
                .map(|rows| rows.into_iter().map(js_pending_upload).collect())
        })
    }

    #[napi]
    pub fn upload_lease_write(
        &self,
        args: JsUploadLeaseWrite,
    ) -> napi::Result<Option<JsPendingUpload>> {
        let args = to_upload_lease_write(args)?;
        self.run(|store| {
            store
                .upload_lease_write(args)
                .map(|row| row.map(js_pending_upload))
        })
    }

    #[napi]
    pub fn upload_complete(
        &self,
        local_storage_id: String,
        owner: String,
        convex_id: String,
        now_ms: i64,
    ) -> napi::Result<bool> {
        self.run(|store| store.upload_complete(&local_storage_id, &owner, &convex_id, now_ms))
    }

    #[napi]
    pub fn upload_delete(&self, local_storage_id: String) -> napi::Result<()> {
        self.run(|store| store.upload_delete(&local_storage_id))
    }

    #[napi]
    pub fn schedule_write(&self, job: JsScheduledJob) -> napi::Result<()> {
        let job = to_scheduled_job(job)?;
        self.run(|store| store.schedule_write(&job))
    }

    #[napi]
    pub fn schedule_read(&self) -> napi::Result<Vec<JsScheduledJob>> {
        self.run(|store| {
            store
                .schedule_read()
                .map(|rows| rows.into_iter().map(js_scheduled_job).collect())
        })
    }

    #[napi]
    pub fn schedule_lease_write(&self, now_ms: i64) -> napi::Result<Option<JsScheduledJob>> {
        self.run(|store| {
            store
                .schedule_lease_write(now_ms)
                .map(|row| row.map(js_scheduled_job))
        })
    }

    #[napi]
    pub fn schedule_complete(
        &self,
        job_id: String,
        now_ms: i64,
    ) -> napi::Result<Option<JsScheduledJob>> {
        self.run(|store| {
            store
                .schedule_complete(&job_id, now_ms)
                .map(|row| row.map(js_scheduled_job))
        })
    }

    #[napi]
    pub fn schedule_fail(
        &self,
        job_id: String,
        now_ms: i64,
    ) -> napi::Result<Option<JsScheduledJob>> {
        self.run(|store| {
            store
                .schedule_fail(&job_id, now_ms)
                .map(|row| row.map(js_scheduled_job))
        })
    }

    #[napi]
    pub fn schedule_cancel(
        &self,
        job_id: String,
        now_ms: i64,
    ) -> napi::Result<Option<JsScheduledJob>> {
        self.run(|store| {
            store
                .schedule_cancel(&job_id, now_ms)
                .map(|row| row.map(js_scheduled_job))
        })
    }

    #[napi]
    pub fn clear(&self) -> napi::Result<()> {
        self.run(EmbeddedStore::clear)
    }

    #[napi]
    pub fn remote_start(&self, _env: Env, mut options: JsRemoteStartOptions) -> napi::Result<()> {
        let transport = options.transport.take().ok_or_else(|| {
            napi::Error::from_reason("browser remote requires an internal transport")
        })?;
        let close: JsFunction = transport.get_named_property("close")?;
        let connect: JsFunction = transport.get_named_property("connect")?;
        let receive: JsFunction = transport.get_named_property("receive")?;
        let run_store_job: JsFunction = transport.get_named_property("runStoreJob")?;
        let send: JsFunction = transport.get_named_property("send")?;
        let upload: JsFunction = transport.get_named_property("upload")?;
        let close = close
            .create_threadsafe_function::<(), (), _, ErrorStrategy::Fatal>(0, |_| {
                Ok(Vec::<()>::new())
            })?;
        let connect = connect.create_threadsafe_function::<
            JsRemoteConnect,
            JsRemoteConnect,
            _,
            ErrorStrategy::Fatal,
        >(0, |ctx| Ok(vec![ctx.value]))?;
        let receive = receive.create_threadsafe_function::<
            JsRemoteReceive,
            JsRemoteReceive,
            _,
            ErrorStrategy::Fatal,
        >(0, |ctx| Ok(vec![ctx.value]))?;
        let send = send
            .create_threadsafe_function::<JsRemoteSend, JsRemoteSend, _, ErrorStrategy::Fatal>(
                0,
                |ctx| Ok(vec![ctx.value]),
            )?;
        let upload = upload
            .create_threadsafe_function::<JsRemoteUpload, JsRemoteUpload, _, ErrorStrategy::Fatal>(
                0,
                |ctx| Ok(vec![ctx.value]),
            )?;
        let config = remote_config(options)?;
        let mut inner = lock(&self.inner);
        let inner = inner.as_mut().ok_or_else(store_closed)?;
        if inner.remote.is_some() {
            return Err(napi::Error::from_reason("remote client is already started"));
        }
        let store = inner.store.clone();
        let store_lane = run_store_job
            .create_threadsafe_function::<WasmStoreJob, (), _, ErrorStrategy::Fatal>(
                0,
                move |ctx| {
                    (ctx.value.work)(&store);
                    Ok(Vec::<()>::new())
                },
            )?;
        let socket = NapiBrowserTransport::new(close, connect, receive, send);
        let clock = NapiRemoteClock::new();
        let uploader = NapiBrowserUploader::new(upload);
        let driver = RemoteDriver::open_with_store_and_uploader(
            config,
            WasmRemoteStore::new(store_lane),
            socket,
            clock,
            uploader,
        );
        inner.remote = Some(start_wasm_remote_actor(driver));
        Ok(())
    }

    #[napi]
    pub fn remote_close(&self, env: Env) -> napi::Result<JsObject> {
        let remote = lock(&self.inner)
            .as_mut()
            .and_then(|inner| inner.remote.take());
        env.execute_tokio_future(
            async move {
                if let Some(remote) = remote {
                    close_wasm_remote(remote).await.map_err(map_remote_err)?;
                } else {
                    return Ok(());
                }
                Ok(())
            },
            |_, value| Ok(value),
        )
    }

    #[napi]
    pub async fn remote_pull(&self, local_progress: bool) -> napi::Result<JsRemoteTick> {
        let remote = self.wasm_remote()?;
        let interrupt = remote.clone();
        run_wasm_remote(&remote, move |driver| {
            Box::pin(async move {
                driver
                    .pull_ready_interruptible(local_progress, move || {
                        wasm_remote_has_foreground_waiter(&interrupt)
                    })
                    .await
            })
        })
        .await
        .map(|(tick, _, _)| js_remote_tick(tick))
        .map_err(map_remote_err)
    }

    #[napi]
    pub fn remote_identity(&self, env: Env) -> napi::Result<JsObject> {
        let remote = self.wasm_remote()?;
        env.execute_tokio_future(
            async move {
                run_wasm_remote_foreground(&remote, move |driver| {
                    Box::pin(async move { driver.identity().await })
                })
                .await
                .map(|(identity, _, _)| identity)
                .map_err(map_remote_err)
            },
            |_, value| Ok(value),
        )
    }

    #[napi]
    pub fn remote_doc_push(
        &self,
        env: Env,
        table: String,
        local_document_id: String,
        first_commit_seq: i64,
        updated_commit_seq: i64,
    ) -> napi::Result<JsObject> {
        let remote = self.wasm_remote()?;
        env.execute_tokio_future(
            async move {
                run_wasm_remote_foreground(&remote, move |driver| {
                    Box::pin(async move {
                        driver
                            .doc_push(
                                &table,
                                &local_document_id,
                                storage::DirtyHeadToken {
                                    first_commit_seq,
                                    updated_commit_seq,
                                },
                            )
                            .await
                    })
                })
                .await
                .map(|(pushed, actor_queue_ms, actor_queue_depth)| {
                    js_remote_doc_push(pushed, actor_queue_ms, actor_queue_depth)
                })
                .map_err(map_remote_err)
            },
            |_, value| Ok(value),
        )
    }

    #[napi]
    pub fn remote_scope_write(&self, scope_json: String) -> napi::Result<()> {
        let scope = parse_remote_scope(&scope_json)?;
        let remote = self.wasm_remote()?;
        lock(&remote.state).pending_scope = Some(scope);
        Ok(())
    }

    #[napi]
    pub fn close(&self, env: Env) -> napi::Result<JsObject> {
        if lock(&self.inner).is_some() {
            let _ = self.run(|store| store.wal_write());
        }
        let inner = lock(&self.inner).take();
        env.execute_tokio_future(
            async move {
                if let Some(mut inner) = inner {
                    let close_result = if let Some(remote) = inner.remote.take() {
                        close_wasm_remote(remote).await
                    } else {
                        Ok(())
                    };
                    close_result.map_err(map_remote_err)?;
                } else {
                    return Ok(());
                }
                Ok(())
            },
            |_, value| Ok(value),
        )
    }
}

impl Store {
    fn store(&self) -> napi::Result<Arc<EmbeddedStore>> {
        lock(&self.inner)
            .as_ref()
            .map(|inner| inner.store.clone())
            .ok_or_else(store_closed)
    }

    #[cfg(not(target_arch = "wasm32"))]
    fn remote_client(&self) -> napi::Result<RemoteClient> {
        lock(&self.inner)
            .as_ref()
            .and_then(|inner| inner.remote.clone())
            .ok_or_else(|| napi::Error::from_reason("remote client is not started"))
    }

    #[cfg(target_arch = "wasm32")]
    fn wasm_remote(&self) -> napi::Result<WasmRemoteHandle> {
        lock(&self.inner)
            .as_ref()
            .and_then(|inner| inner.remote.as_ref().map(WasmRemoteHandle::clone))
            .ok_or_else(|| napi::Error::from_reason("remote client is not started"))
    }

    /// Run database work off the JS thread: post a job to the storage thread and await it.
    #[cfg(not(target_arch = "wasm32"))]
    async fn run<T, F>(&self, work: F) -> napi::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&EmbeddedStore) -> Result<T, StorageError> + Send + 'static,
    {
        let jobs = lock(&self.inner)
            .as_ref()
            .map(|inner| inner.jobs.clone())
            .ok_or_else(store_closed)?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        jobs.send(Box::new(move |store| {
            tx.send(work(store)).ok();
        }))
        .map_err(|_| napi::Error::from_reason("storage thread terminated"))?;
        rx.await
            .map_err(|_| napi::Error::from_reason("storage thread terminated"))?
            .map_err(map_err)
    }

    /// Run database work inline on the OPFS runtime worker.
    #[cfg(target_arch = "wasm32")]
    fn run<T, F>(&self, work: F) -> napi::Result<T>
    where
        F: FnOnce(&EmbeddedStore) -> Result<T, StorageError>,
    {
        let store = self.store()?;
        work(&store).map_err(map_err)
    }
}

#[cfg(not(target_arch = "wasm32"))]
async fn open_inner(
    path: String,
    selector_key: String,
    default_identity_key: String,
) -> napi::Result<Inner> {
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (jobs_tx, jobs_rx) = std::sync::mpsc::channel::<Job>();
    let thread = std::thread::Builder::new()
        .name("convex-embedded-storage".to_owned())
        .spawn(move || {
            let store = match EmbeddedStore::open_with_cached_identity_key(
                &path,
                &selector_key,
                &default_identity_key,
            ) {
                Ok(store) => Arc::new(store),
                Err(error) => {
                    ready_tx.send(Err(error)).ok();
                    return;
                }
            };
            ready_tx.send(Ok(store.clone())).ok();
            while let Ok(job) = jobs_rx.recv() {
                job(&store);
            }
        })
        .map_err(|e| napi::Error::from_reason(format!("failed to spawn storage thread: {e}")))?;
    let store = ready_rx
        .await
        .map_err(|_| napi::Error::from_reason("storage thread terminated during open"))?
        .map_err(map_err)?;
    Ok(Inner {
        store,
        jobs: jobs_tx,
        remote: None,
        thread: Some(thread),
    })
}

fn store_closed() -> napi::Error {
    napi::Error::from_reason("Store is closed")
}

#[cfg(not(target_arch = "wasm32"))]
struct NativeRemoteStore {
    jobs: std::sync::mpsc::Sender<Job>,
    job_count: Arc<AtomicUsize>,
}

#[cfg(not(target_arch = "wasm32"))]
impl NativeRemoteStore {
    fn run<T, F>(&self, work: F) -> Result<T, StorageError>
    where
        T: Send + 'static,
        F: FnOnce(&EmbeddedStore) -> Result<T, StorageError> + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        self.jobs
            .send(Box::new(move |store| {
                tx.send(work(store)).ok();
            }))
            .map_err(|_| StorageError::Unsatisfiable("storage thread terminated".to_owned()))?;
        self.job_count.fetch_add(1, Ordering::Relaxed);
        rx.recv()
            .map_err(|_| StorageError::Unsatisfiable("storage thread terminated".to_owned()))?
    }

    fn queue<T, F>(&self, work: F) -> remote::RemoteStoreFuture<T>
    where
        T: Send + 'static,
        F: FnOnce(&EmbeddedStore) -> Result<T, StorageError> + Send + 'static,
    {
        let (tx, rx) = tokio::sync::oneshot::channel();
        let sent = self.jobs.send(Box::new(move |store| {
            tx.send(work(store)).ok();
        }));
        if sent.is_err() {
            return Box::pin(std::future::ready(Err(StorageError::Unsatisfiable(
                "storage thread terminated".to_owned(),
            ))));
        }
        self.job_count.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            rx.await
                .map_err(|_| StorageError::Unsatisfiable("storage thread terminated".to_owned()))?
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl RemoteStore for NativeRemoteStore {
    fn store_job_count(&self) -> usize {
        self.job_count.load(Ordering::Relaxed)
    }

    fn schema_table_names(&self) -> Result<Vec<String>, StorageError> {
        self.run(|store| Ok(store.schema_table_names()))
    }

    fn identity_write(
        &self,
        identity_key: &str,
        identity_json: Option<&str>,
    ) -> Result<(), StorageError> {
        let identity_key = identity_key.to_owned();
        let identity_json = identity_json.map(str::to_owned);
        self.run(move |store| store.identity_write(&identity_key, identity_json.as_deref()))
    }

    fn upload_has_pending(&self) -> Result<bool, StorageError> {
        self.run(EmbeddedStore::upload_has_pending)
    }

    fn upload_lease_write(
        &self,
        args: UploadLeaseWrite,
    ) -> Result<Option<PendingUpload>, StorageError> {
        self.run(move |store| store.upload_lease_write(args))
    }

    fn upload_complete(
        &self,
        local_storage_id: &str,
        owner: &str,
        convex_id: &str,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        let local_storage_id = local_storage_id.to_owned();
        let owner = owner.to_owned();
        let convex_id = convex_id.to_owned();
        self.run(move |store| store.upload_complete(&local_storage_id, &owner, &convex_id, now_ms))
    }

    fn blob_read(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let key = key.to_owned();
        self.run(move |store| store.blob_read(&key))
    }

    fn blob_write(&self, key: &str, bytes: Vec<u8>) -> Result<(), StorageError> {
        let key = key.to_owned();
        self.run(move |store| store.blob_write(&key, bytes))
    }

    fn id_read(&self, table: &str, local_id: &str) -> Result<Option<IdMapping>, StorageError> {
        let table = table.to_owned();
        let local_id = local_id.to_owned();
        self.run(move |store| store.id_read(&table, &local_id))
    }

    fn id_local_read(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let table = table.to_owned();
        let server_document_id = server_document_id.to_owned();
        self.run(move |store| store.id_local_read(&table, &server_document_id))
    }

    fn doc_read(&self, table: &str, local_id: &str) -> Result<Option<String>, StorageError> {
        let table = table.to_owned();
        let local_id = local_id.to_owned();
        self.run(move |store| store.doc_read(&table, &local_id))
    }

    fn remote_doc_read(
        &self,
        table: &str,
        local_id: &str,
    ) -> Result<Option<storage::RowHead>, StorageError> {
        let table = table.to_owned();
        let local_id = local_id.to_owned();
        self.run(move |store| store.remote_doc_read(&table, &local_id))
    }

    fn remote_cursor_read(&self, subscription: &str) -> Result<Option<String>, StorageError> {
        let subscription = subscription.to_owned();
        self.run(move |store| store.remote_cursor_read(&subscription))
    }

    fn remote_progress_has(&self) -> Result<bool, StorageError> {
        self.run(EmbeddedStore::remote_progress_has)
    }

    fn remote_subscription_read(&self) -> Result<Vec<String>, StorageError> {
        self.run(EmbeddedStore::remote_subscription_read)
    }

    fn remote_pending_read(&self) -> Result<storage::RemotePending, StorageError> {
        self.run(EmbeddedStore::remote_pending_read)
    }

    fn remote_push_envelope_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        self.run(move |store| store.remote_push_envelope_read(num_items))
    }

    fn remote_push_replay_write(
        &self,
        mutation_id: &str,
        expected_commit_seq: i64,
        expected_replay_id: &str,
        replay_id: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let mutation_id = mutation_id.to_owned();
        let expected_replay_id = expected_replay_id.to_owned();
        let replay_id = replay_id.to_owned();
        self.run(move |store| {
            store.remote_push_replay_write(
                &mutation_id,
                expected_commit_seq,
                &expected_replay_id,
                &replay_id,
                now_ms,
            )
        })
    }

    fn remote_settlement_write(
        &self,
        settlement: &storage::RemoteSettlementWrite,
    ) -> Result<storage::RemoteSettlementWriteResult, StorageError> {
        let settlement = settlement.clone();
        self.run(move |store| store.remote_settlement_write(&settlement))
    }

    fn remote_receipt_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        self.run(move |store| store.remote_receipt_read(num_items))
    }

    fn remote_receipt_delete(&self, mutation_ids: &[String]) -> Result<(), StorageError> {
        let mutation_ids = mutation_ids.to_vec();
        self.run(move |store| store.remote_receipt_delete(&mutation_ids))
    }

    fn crdt_remote_state(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
    ) -> Result<Option<storage::CrdtRemoteState>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        let field = field.to_owned();
        self.run(move |store| store.crdt_remote_state(&table, &id, &field, kind))
    }

    fn crdt_remote_effect(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
        prior_payloads: &[Vec<u8>],
        payload: &[u8],
    ) -> Result<storage::CrdtRemoteEffect, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        let field = field.to_owned();
        let prior_payloads = prior_payloads.to_vec();
        let payload = payload.to_vec();
        self.run(move |store| {
            store.crdt_remote_effect(&table, &id, &field, kind, &prior_payloads, &payload)
        })
    }

    fn crdt_snapshot_read(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtSnapshot>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |store| store.crdt_snapshot_read(&table, &id))
    }

    fn crdt_read_states(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtReadState>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |store| store.crdt_read_states(&table, &id))
    }

    fn remote_page_write(
        &self,
        pull: storage::RemotePageWrite,
    ) -> remote::RemoteStoreFuture<RemotePageWriteResult> {
        self.queue(move |store| store.remote_page_write(&pull))
    }

    fn remote_subscription_delete_queue(
        &self,
        subscription: String,
        now_ms: i64,
    ) -> remote::RemoteStoreFuture<RemotePageWriteResult> {
        self.queue(move |store| store.remote_subscription_delete(&subscription, now_ms))
    }
}

#[cfg(target_arch = "wasm32")]
impl RemoteStore for WasmRemoteStore {
    fn store_job_count(&self) -> usize {
        self.job_count.load(Ordering::Relaxed)
    }

    fn schema_table_names(&self) -> Result<Vec<String>, StorageError> {
        self.run(|store| Ok(store.schema_table_names()))
    }

    fn identity_write(
        &self,
        identity_key: &str,
        identity_json: Option<&str>,
    ) -> Result<(), StorageError> {
        let identity_key = identity_key.to_owned();
        let identity_json = identity_json.map(str::to_owned);
        self.run(move |store| store.identity_write(&identity_key, identity_json.as_deref()))
    }

    fn remote_progress_has(&self) -> Result<bool, StorageError> {
        self.run(EmbeddedStore::remote_progress_has)
    }

    fn remote_subscription_read(&self) -> Result<Vec<String>, StorageError> {
        self.run(EmbeddedStore::remote_subscription_read)
    }

    fn remote_pending_read(&self) -> Result<storage::RemotePending, StorageError> {
        self.run(EmbeddedStore::remote_pending_read)
    }

    fn remote_push_envelope_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        self.run(move |store| store.remote_push_envelope_read(num_items))
    }

    fn remote_push_replay_write(
        &self,
        mutation_id: &str,
        expected_commit_seq: i64,
        expected_replay_id: &str,
        replay_id: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let mutation_id = mutation_id.to_owned();
        let expected_replay_id = expected_replay_id.to_owned();
        let replay_id = replay_id.to_owned();
        self.run(move |store| {
            store.remote_push_replay_write(
                &mutation_id,
                expected_commit_seq,
                &expected_replay_id,
                &replay_id,
                now_ms,
            )
        })
    }

    fn remote_settlement_write(
        &self,
        settlement: &storage::RemoteSettlementWrite,
    ) -> Result<storage::RemoteSettlementWriteResult, StorageError> {
        let settlement = settlement.clone();
        self.run(move |store| store.remote_settlement_write(&settlement))
    }

    fn remote_receipt_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        self.run(move |store| store.remote_receipt_read(num_items))
    }

    fn remote_receipt_delete(&self, mutation_ids: &[String]) -> Result<(), StorageError> {
        let mutation_ids = mutation_ids.to_vec();
        self.run(move |store| store.remote_receipt_delete(&mutation_ids))
    }

    fn crdt_remote_state(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
    ) -> Result<Option<storage::CrdtRemoteState>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        let field = field.to_owned();
        self.run(move |store| store.crdt_remote_state(&table, &id, &field, kind))
    }

    fn crdt_remote_effect(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
        prior_payloads: &[Vec<u8>],
        payload: &[u8],
    ) -> Result<storage::CrdtRemoteEffect, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        let field = field.to_owned();
        let prior_payloads = prior_payloads.to_vec();
        let payload = payload.to_vec();
        self.run(move |store| {
            store.crdt_remote_effect(&table, &id, &field, kind, &prior_payloads, &payload)
        })
    }

    fn crdt_snapshot_read(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtSnapshot>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |store| store.crdt_snapshot_read(&table, &id))
    }

    fn crdt_read_states(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtReadState>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |store| store.crdt_read_states(&table, &id))
    }

    fn upload_has_pending(&self) -> Result<bool, StorageError> {
        self.run(EmbeddedStore::upload_has_pending)
    }

    fn upload_lease_write(
        &self,
        args: UploadLeaseWrite,
    ) -> Result<Option<PendingUpload>, StorageError> {
        self.run(move |store| store.upload_lease_write(args))
    }

    fn upload_complete(
        &self,
        local_storage_id: &str,
        owner: &str,
        convex_id: &str,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        let local_storage_id = local_storage_id.to_owned();
        let owner = owner.to_owned();
        let convex_id = convex_id.to_owned();
        self.run(move |store| store.upload_complete(&local_storage_id, &owner, &convex_id, now_ms))
    }

    fn blob_read(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let key = key.to_owned();
        self.run(move |store| store.blob_read(&key))
    }

    fn blob_write(&self, key: &str, bytes: Vec<u8>) -> Result<(), StorageError> {
        let key = key.to_owned();
        self.run(move |store| store.blob_write(&key, bytes))
    }

    fn id_read(&self, table: &str, local_id: &str) -> Result<Option<IdMapping>, StorageError> {
        let table = table.to_owned();
        let local_id = local_id.to_owned();
        self.run(move |store| store.id_read(&table, &local_id))
    }

    fn id_local_read(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let table = table.to_owned();
        let server_document_id = server_document_id.to_owned();
        self.run(move |store| store.id_local_read(&table, &server_document_id))
    }

    fn doc_read(&self, table: &str, local_id: &str) -> Result<Option<String>, StorageError> {
        let table = table.to_owned();
        let local_id = local_id.to_owned();
        self.run(move |store| store.doc_read(&table, &local_id))
    }

    fn remote_doc_read(
        &self,
        table: &str,
        local_id: &str,
    ) -> Result<Option<storage::RowHead>, StorageError> {
        let table = table.to_owned();
        let local_id = local_id.to_owned();
        self.run(move |store| store.remote_doc_read(&table, &local_id))
    }

    fn remote_cursor_read(&self, subscription: &str) -> Result<Option<String>, StorageError> {
        let subscription = subscription.to_owned();
        self.run(move |store| store.remote_cursor_read(&subscription))
    }

    fn remote_page_write(
        &self,
        pull: storage::RemotePageWrite,
    ) -> remote::RemoteStoreFuture<RemotePageWriteResult> {
        self.queue(move |store| store.remote_page_write(&pull))
    }

    fn remote_subscription_delete_queue(
        &self,
        subscription: String,
        now_ms: i64,
    ) -> remote::RemoteStoreFuture<RemotePageWriteResult> {
        self.queue(move |store| store.remote_subscription_delete(&subscription, now_ms))
    }
}

#[cfg(target_arch = "wasm32")]
struct NapiBrowserTransport {
    close: ThreadsafeFunction<(), ErrorStrategy::Fatal>,
    connect: ThreadsafeFunction<JsRemoteConnect, ErrorStrategy::Fatal>,
    receive: ThreadsafeFunction<JsRemoteReceive, ErrorStrategy::Fatal>,
    send: ThreadsafeFunction<JsRemoteSend, ErrorStrategy::Fatal>,
}

#[cfg(target_arch = "wasm32")]
impl NapiBrowserTransport {
    fn new(
        close: ThreadsafeFunction<(), ErrorStrategy::Fatal>,
        connect: ThreadsafeFunction<JsRemoteConnect, ErrorStrategy::Fatal>,
        receive: ThreadsafeFunction<JsRemoteReceive, ErrorStrategy::Fatal>,
        send: ThreadsafeFunction<JsRemoteSend, ErrorStrategy::Fatal>,
    ) -> Self {
        Self {
            close,
            connect,
            receive,
            send,
        }
    }

    async fn send_message(&self, message: convex_sync_types::ClientMessage) -> RemoteResult<()> {
        let json = serde_json::Value::try_from(message)
            .map_err(|e| RemoteError::Protocol(e.to_string()))?;
        self.call_send(json.to_string()).await
    }

    async fn call_send(&self, message: String) -> RemoteResult<()> {
        let promise: Promise<()> = self
            .send
            .call_async(JsRemoteSend { message })
            .await
            .map_err(|e| RemoteError::Transport(e.to_string()))?;
        promise
            .await
            .map_err(|e| RemoteError::Transport(e.to_string()))
    }
}

#[cfg(target_arch = "wasm32")]
impl RemoteTransport for NapiBrowserTransport {
    type Connect<'a> = BoxFuture<'a, RemoteResult<()>>;
    type SendMessage<'a> = BoxFuture<'a, RemoteResult<()>>;
    type Receive<'a> = BoxFuture<'a, RemoteResult<TransportEvent>>;
    type Close<'a> = BoxFuture<'a, RemoteResult<()>>;

    fn connect(&mut self, request: ConnectRequest) -> Self::Connect<'_> {
        async move {
            let promise: Promise<()> = self
                .connect
                .call_async(JsRemoteConnect {
                    url: request.sync_url.to_string(),
                })
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            promise
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            let connect = convex_sync_types::ClientMessage::Connect {
                session_id: request.session_id,
                connection_count: request.connection_count,
                last_close_reason: request.last_close_reason,
                max_observed_timestamp: request.max_observed_timestamp,
                client_ts: request.client_ts,
            };
            self.send_message(connect).await
        }
        .boxed()
    }

    fn send(&mut self, message: convex_sync_types::ClientMessage) -> Self::SendMessage<'_> {
        async move { self.send_message(message).await }.boxed()
    }

    fn receive(&mut self, timeout: Duration) -> Self::Receive<'_> {
        async move {
            let timeout_ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
            let promise: Promise<JsRemoteTransportEvent> = self
                .receive
                .call_async(JsRemoteReceive { timeout_ms })
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            let event = promise
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            match event.kind.as_str() {
                "message" => {
                    let text = event.message.ok_or_else(|| {
                        RemoteError::Protocol(
                            "transport message event is missing message".to_owned(),
                        )
                    })?;
                    let json: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|e| RemoteError::Protocol(e.to_string()))?;
                    json.try_into()
                        .map(TransportEvent::ServerMessage)
                        .map_err(|e: anyhow::Error| RemoteError::Protocol(e.to_string()))
                }
                "timeout" => Ok(TransportEvent::Timeout),
                "closed" => Ok(TransportEvent::Closed(
                    event
                        .reason
                        .unwrap_or_else(|| "websocket closed".to_owned()),
                )),
                other => Err(RemoteError::Protocol(format!(
                    "unknown transport event kind: {other}"
                ))),
            }
        }
        .boxed()
    }

    fn close(&mut self) -> Self::Close<'_> {
        async move {
            let promise: Promise<()> = self
                .close
                .call_async(())
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            promise
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))
        }
        .boxed()
    }
}

/// Browser remote uploader bridge. The WASM driver's `drain_uploads` claims a pending upload,
/// resolves an upload URL through the `embedded:upload` mutation, then routes the blob transfer
/// back to the worker host through this callback. The host POSTs the bytes (or, in tests, loops
/// them straight into the local upload path) and returns the hosted storage id.
#[cfg(target_arch = "wasm32")]
struct NapiBrowserUploader {
    upload: ThreadsafeFunction<JsRemoteUpload, ErrorStrategy::Fatal>,
}

#[cfg(target_arch = "wasm32")]
impl NapiBrowserUploader {
    fn new(upload: ThreadsafeFunction<JsRemoteUpload, ErrorStrategy::Fatal>) -> Self {
        Self { upload }
    }
}

#[cfg(target_arch = "wasm32")]
impl RemoteUploader for NapiBrowserUploader {
    fn upload(&mut self, request: RemoteUploadRequest) -> RemoteUploadFuture<'_> {
        async move {
            let args = JsRemoteUpload {
                bytes: Uint8Array::new(request.bytes),
                content_type: request.content_type,
                local_storage_id: request.local_storage_id,
                sha256: request.sha256,
                size: request.size as f64,
                upload_url: request.upload_url,
            };
            let promise: Promise<JsRemoteUploadReceipt> = self
                .upload
                .call_async(args)
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            let receipt = promise
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            Ok(RemoteUploadReceipt {
                storage_id: receipt.storage_id,
            })
        }
        .boxed()
    }
}

#[cfg(target_arch = "wasm32")]
struct NapiRemoteClock {
    origin: Instant,
}

#[cfg(target_arch = "wasm32")]
impl NapiRemoteClock {
    fn new() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

#[cfg(target_arch = "wasm32")]
impl RemoteClock for NapiRemoteClock {
    fn monotonic_ms(&self) -> u64 {
        u64::try_from(self.origin.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn now_ms(&self) -> RemoteResult<i64> {
        let wall = storage::clock::wall_ms()
            .map_err(|e| RemoteError::Protocol(format!("host wall clock unavailable: {e}")))?;
        if wall.is_finite() && wall >= 0.0 {
            Ok((wall as i64).min(i64::MAX))
        } else {
            Ok(0)
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn start_wasm_remote_actor(driver: WasmRemoteDriver) -> WasmRemoteHandle {
    WasmRemoteHandle {
        state: Arc::new(Mutex::new(WasmRemoteState {
            closing: false,
            driver: Some(driver),
            pending_scope: None,
            running: false,
            waiters: Vec::new(),
        })),
    }
}

/// Run a single op on the browser remote driver, borrowing it exclusively for the round-trip.
///
/// Mirrors the `remote_pull` actor handshake: it serializes against concurrent pulls/ops via the
/// `running` flag, restores the driver, and wakes any close waiters when the op finishes.
#[cfg(target_arch = "wasm32")]
async fn run_wasm_remote<F, R>(remote: &WasmRemoteHandle, op: F) -> RemoteResult<(R, u64, u32)>
where
    F: for<'a> FnOnce(
        &'a mut WasmRemoteDriver,
    ) -> Pin<Box<dyn Future<Output = RemoteResult<R>> + Send + 'a>>,
{
    run_wasm_remote_with_kind(remote, WasmRemoteWaiterKind::Background, op).await
}

#[cfg(target_arch = "wasm32")]
async fn run_wasm_remote_foreground<F, R>(
    remote: &WasmRemoteHandle,
    op: F,
) -> RemoteResult<(R, u64, u32)>
where
    F: for<'a> FnOnce(
        &'a mut WasmRemoteDriver,
    ) -> Pin<Box<dyn Future<Output = RemoteResult<R>> + Send + 'a>>,
{
    run_wasm_remote_with_kind(remote, WasmRemoteWaiterKind::Foreground, op).await
}

#[cfg(target_arch = "wasm32")]
async fn run_wasm_remote_with_kind<F, R>(
    remote: &WasmRemoteHandle,
    kind: WasmRemoteWaiterKind,
    op: F,
) -> RemoteResult<(R, u64, u32)>
where
    F: for<'a> FnOnce(
        &'a mut WasmRemoteDriver,
    ) -> Pin<Box<dyn Future<Output = RemoteResult<R>> + Send + 'a>>,
{
    let queued_at = Instant::now();
    let mut actor_queue_depth = 0;
    let (driver, pending_scope) = loop {
        let (driver, waiter) = {
            let mut state = lock(&remote.state);
            if state.closing {
                return Err(RemoteError::Command("browser remote is closing".to_owned()));
            }
            if state.running {
                let (tx, rx) = oneshot::channel();
                actor_queue_depth = saturating_u32(state.waiters.len() + 1);
                state.waiters.push(WasmRemoteWaiter { kind, sender: tx });
                (None, Some(rx))
            } else if let Some(driver) = state.driver.take() {
                state.running = true;
                let pending_scope = state.pending_scope.take();
                (Some((driver, pending_scope)), None)
            } else {
                let (tx, rx) = oneshot::channel();
                actor_queue_depth = saturating_u32(state.waiters.len() + 1);
                state.waiters.push(WasmRemoteWaiter { kind, sender: tx });
                (None, Some(rx))
            }
        };
        if let Some(driver) = driver {
            break driver;
        }
        let Some(waiter) = waiter else {
            return Err(RemoteError::Command(
                "browser remote driver unavailable".to_owned(),
            ));
        };
        waiter
            .await
            .map_err(|_| RemoteError::Command("browser remote wait canceled".to_owned()))?;
    };
    let mut loan = WasmRemoteDriverLoan::new(driver, Arc::clone(&remote.state));
    let actor_queue_ms = u64::try_from(queued_at.elapsed().as_millis()).unwrap_or(u64::MAX);
    if let Some(scope) = pending_scope {
        loan.driver_mut().scope_write(scope)?;
    }
    let result = op(loan.driver_mut()).await;
    drop(loan);
    result.map(|value| (value, actor_queue_ms, actor_queue_depth))
}

#[cfg(target_arch = "wasm32")]
fn wake_next_wasm_remote_waiter(state: &mut WasmRemoteState) {
    loop {
        let Some(index) = state
            .waiters
            .iter()
            .position(|waiter| waiter.kind == WasmRemoteWaiterKind::Close)
            .or_else(|| {
                state
                    .waiters
                    .iter()
                    .position(|waiter| waiter.kind == WasmRemoteWaiterKind::Foreground)
            })
            .or_else(|| {
                state
                    .waiters
                    .iter()
                    .position(|waiter| waiter.kind == WasmRemoteWaiterKind::Background)
            })
        else {
            return;
        };
        let waiter = state.waiters.swap_remove(index);
        if waiter.sender.send(()).is_ok() {
            return;
        }
    }
}

#[cfg(target_arch = "wasm32")]
fn wasm_remote_has_foreground_waiter(remote: &WasmRemoteHandle) -> bool {
    let state = lock(&remote.state);
    state.waiters.iter().any(|waiter| {
        matches!(
            waiter.kind,
            WasmRemoteWaiterKind::Close | WasmRemoteWaiterKind::Foreground
        )
    })
}

#[cfg(target_arch = "wasm32")]
async fn close_wasm_remote(remote: WasmRemoteHandle) -> RemoteResult<()> {
    loop {
        let (driver, waiter) = {
            let mut state = lock(&remote.state);
            state.closing = true;
            if let Some(driver) = state.driver.take() {
                (Some(driver), None)
            } else if state.running {
                let (tx, rx) = oneshot::channel();
                state.waiters.push(WasmRemoteWaiter {
                    kind: WasmRemoteWaiterKind::Close,
                    sender: tx,
                });
                (None, Some(rx))
            } else {
                return Ok(());
            }
        };
        if let Some(mut driver) = driver {
            let result = driver.close().await;
            let waiters = {
                let mut state = lock(&remote.state);
                state.running = false;
                std::mem::take(&mut state.waiters)
            };
            for waiter in waiters {
                waiter.sender.send(()).ok();
            }
            return result;
        }
        if let Some(waiter) = waiter {
            waiter.await.ok();
        }
    }
}

fn remote_config(options: JsRemoteStartOptions) -> napi::Result<RemoteConfig> {
    let deployment_url = DeploymentUrl::parse(&options.url).map_err(map_remote_err)?;
    let mut config = RemoteConfig::new(deployment_url);
    if let Some(client_id) = options.client_id {
        let client_id = remote::ClientId::new(client_id).map_err(map_remote_err)?;
        config.client_id = client_id.clone();
        config.author_client_id = client_id;
    }
    if let Some(auth) = options.auth {
        config.auth = remote_auth_fetcher(&auth)?;
    }
    config.runtime = storage::RuntimeWireIdentity {
        schema_hash: options.schema_hash,
        module_graph_hash: options.module_graph_hash,
        contract_id: options.contract_id,
    };
    config.timing = RemoteTiming {
        receive_timeout: options
            .receive_timeout_ms
            .map_or_else(|| RemoteTiming::default().receive_timeout, millis),
        operation_timeout: options
            .operation_timeout_ms
            .map_or_else(|| RemoteTiming::default().operation_timeout, millis),
    };
    Ok(config)
}

fn remote_auth_fetcher(function: &JsFunction) -> napi::Result<RemoteAuth> {
    let tsfn: ThreadsafeFunction<bool, ErrorStrategy::Fatal> = function
        .create_threadsafe_function(0, |ctx| {
            let mut request = ctx.env.create_object()?;
            request.set_named_property("forceRefreshToken", ctx.value)?;
            Ok::<Vec<JsObject>, napi::Error>(vec![request])
        })?;
    Ok(RemoteAuth::Fetcher(Arc::new(Box::new(
        move |force_refresh| {
            let tsfn = tsfn.clone();
            Box::pin(async move {
                let promise: Promise<Option<String>> = tsfn
                    .call_async(force_refresh)
                    .await
                    .map_err(|e| anyhow::anyhow!("auth.fetchToken failed to call: {e}"))?;
                let token = promise
                    .await
                    .map_err(|e| anyhow::anyhow!("auth.fetchToken rejected: {e}"))?;
                Ok(token.map_or(AuthenticationToken::None, AuthenticationToken::User))
            })
        },
    ))))
}

fn millis(value: u32) -> Duration {
    Duration::from_millis(u64::from(value))
}

fn js_remote_tick(tick: remote::RemoteTick) -> JsRemoteTick {
    JsRemoteTick {
        connected: tick.connected,
        changed_tables: tick.changed_tables,
        rows_applied: saturating_u32(tick.rows_applied),
        pull_attempted: saturating_u32(tick.pull_attempted),
        push_accepted: saturating_u32(tick.push_accepted),
        push_attempted: saturating_u32(tick.push_attempted),
        received: saturating_u32(tick.received),
        reconnected: tick.reconnected,
        pushed: saturating_u32(tick.pushed),
        push_failed: saturating_u32(tick.push_failed),
        push_conflicts: saturating_u32(tick.push_conflicts),
        push_rebases: saturating_u32(tick.push_rebases),
        retained_revisions: tick.retained_revisions.into_iter().map(js_reroot).collect(),
        settlements: tick
            .settlements
            .into_iter()
            .map(js_remote_mutation_settlement)
            .collect(),
        sent: saturating_u32(tick.sent),
        receipts_pushed: saturating_u32(tick.receipts_pushed),
        store_jobs: saturating_u32(tick.store_jobs),
        pull_changes_applied: saturating_u32(tick.pull_changes_applied),
        pull_snapshots: saturating_u32(tick.pull_snapshots),
        pull_diagnostics: saturating_u32(tick.pull_diagnostics),
        pull_error: tick.pull_error,
        changed_results: tick.changed_results,
        pending: tick.pending.map(|pending| JsRemotePending {
            checkpoints: saturating_u32(pending.checkpoints),
            inflight: saturating_u32(pending.inflight),
            mutations: saturating_u32(pending.mutations),
            scope: saturating_u32(pending.scope),
            settlements: saturating_u32(pending.settlements),
            uploads: saturating_u32(pending.uploads),
        }),
    }
}

fn js_reroot(reroot: storage::RetainedRevision) -> JsReroot {
    JsReroot {
        table: reroot.table,
        id: reroot.local_document_id,
        rev_id: reroot.server_rev_id.unwrap_or(reroot.archived_rev_id),
        server_doc_id: reroot.server_document_id,
        base_root_id: reroot.base_root_id,
        base_node_id: reroot.base_node_id,
        attached_node_id: reroot.attached_node_id,
        current_root_id: reroot.current_root_id,
    }
}

fn js_remote_mutation_settlement(
    settlement: remote::RemoteMutationSettlement,
) -> JsRemoteMutationSettlement {
    let (mutation_id, function_name, outcome, retained_revisions) = settlement.into_parts();
    JsRemoteMutationSettlement {
        mutation_id,
        function_name,
        outcome: outcome.as_str().to_owned(),
        code: outcome.code().map(str::to_owned),
        retained_revisions: retained_revisions.into_iter().map(js_reroot).collect(),
    }
}

fn js_remote_doc_push(
    pushed: remote::driver::RemoteDocPush,
    actor_queue_ms: u64,
    actor_queue_depth: u32,
) -> JsRemoteDocPush {
    JsRemoteDocPush {
        actor_queue_depth,
        actor_queue_ms: u32::try_from(actor_queue_ms).unwrap_or(u32::MAX),
        state: match pushed.state {
            remote::driver::RemoteDocPushState::Blocked => "blocked",
            remote::driver::RemoteDocPushState::Settled => "settled",
            remote::driver::RemoteDocPushState::Stale => "stale",
        }
        .to_owned(),
        tick: js_remote_tick(pushed.tick),
    }
}

fn saturating_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

/// The guarded state is an Option swap; a poisoned guard is safe to recover.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn to_schema(schema: JsSchema) -> napi::Result<StoreSchema> {
    let hash = schema.hash;
    let setup_hash = schema.setup_hash.unwrap_or_default();
    let mut tables = Vec::with_capacity(schema.tables.len());
    for t in schema.tables {
        let mut columns = Vec::with_capacity(t.columns.len());
        for c in t.columns {
            columns.push(ColumnDef {
                name: c.name,
                field: c.field,
            });
        }
        tables.push(TableDef {
            name: t.name,
            placement: match t.placement.as_str() {
                "replicated" => TablePlacement::Replicated,
                "device" => TablePlacement::Device,
                other => {
                    return Err(napi::Error::from_reason(format!(
                        "unknown embedded table placement {other}"
                    )))
                }
            },
            columns,
            crdt_fields: t
                .crdt_fields
                .unwrap_or_default()
                .into_iter()
                .map(to_crdt_field)
                .collect::<napi::Result<Vec<_>>>()?,
            local_fields: t
                .local_fields
                .unwrap_or_default()
                .into_iter()
                .map(|field| LocalFieldDef { field: field.field })
                .collect(),
            indexes: t
                .indexes
                .into_iter()
                .map(to_index)
                .collect::<napi::Result<Vec<_>>>()?,
        });
    }
    Ok(StoreSchema {
        hash,
        setup_hash,
        tables,
    })
}

fn migration_candidate_json(candidate: &MigrationCandidate) -> Result<String, StorageError> {
    serde_json::to_string(&serde_json::json!({
        "activeGeneration": candidate.active_generation,
        "candidateGeneration": candidate.candidate_generation,
        "cleanupGeneration": candidate.cleanup_generation,
        "sourceSchema": candidate.source_schema,
        "setupComplete": candidate.setup_complete,
        "sourceContractHash": candidate.source_contract_hash,
        "targetContractHash": candidate.target_contract_hash,
        "retiredGenerations": candidate.retired_generations,
        "required": candidate.required,
        "resumed": candidate.resumed,
    }))
    .map_err(|error| StorageError::Unsatisfiable(error.to_string()))
}

fn migration_step_json(step: MigrationStep) -> Result<String, StorageError> {
    serde_json::to_string(&serde_json::json!({
        "done": step.done,
        "records": step.records,
    }))
    .map_err(|error| StorageError::Unsatisfiable(error.to_string()))
}

fn origin_page_json(page: &OriginPage) -> Result<String, StorageError> {
    serde_json::to_string(&serde_json::json!({
        "records": page.records.iter().map(|record| serde_json::json!({
            "identityKey": record.identity_key,
            "kind": record.kind,
            "recordKey": base64::encode(&record.record_key),
            "codec": record.codec,
            "flags": record.flags,
            "payload": base64::encode(&record.payload),
            "payloadHash": base64::encode(&record.payload_hash),
        })).collect::<Vec<_>>(),
        "cursor": page.cursor.as_ref().map(|cursor| serde_json::json!({
            "identityKey": cursor.identity_key,
            "kind": cursor.kind,
            "recordKey": base64::encode(&cursor.record_key),
        })),
    }))
    .map_err(|error| StorageError::Unsatisfiable(error.to_string()))
}

fn origin_cursor_from_json(json: &str) -> napi::Result<OriginCursor> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|error| napi::Error::from_reason(error.to_string()))?;
    Ok(OriginCursor {
        identity_key: json_string(&value, "identityKey")?,
        kind: json_i64(&value, "kind")?,
        record_key: base64::decode(json_str(&value, "recordKey")?)
            .map_err(|error| napi::Error::from_reason(error.to_string()))?,
    })
}

fn json_str<'a>(value: &'a serde_json::Value, field: &str) -> napi::Result<&'a str> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| napi::Error::from_reason(format!("missing string field {field}")))
}

fn json_string(value: &serde_json::Value, field: &str) -> napi::Result<String> {
    json_str(value, field).map(str::to_owned)
}

fn json_i64(value: &serde_json::Value, field: &str) -> napi::Result<i64> {
    value
        .get(field)
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| napi::Error::from_reason(format!("missing integer field {field}")))
}

fn to_crdt_field(field: JsCrdtField) -> napi::Result<CrdtFieldDef> {
    let kind = match field.kind.as_str() {
        "count" => CrdtFieldKind::Count,
        "set" => CrdtFieldKind::Set,
        "text" => CrdtFieldKind::Text,
        other => {
            return Err(napi::Error::from_reason(format!(
                "unknown embedded CRDT field kind {other}"
            )));
        }
    };
    Ok(CrdtFieldDef {
        field: field.field,
        kind,
    })
}

fn to_index(i: JsIndex) -> napi::Result<IndexDef> {
    if let Some(columns) = &i.columns {
        if columns.len() != i.fields.len() {
            return Err(napi::Error::from_reason(format!(
                "index {} has {} fields but {} storage columns",
                i.name,
                i.fields.len(),
                columns.len(),
            )));
        }
    }
    Ok(IndexDef {
        name: i.name,
        fields: i.fields,
        columns: i.columns,
    })
}

fn parse_order(s: &str) -> napi::Result<Order> {
    match s {
        "asc" => Ok(Order::Asc),
        "desc" => Ok(Order::Desc),
        other => Err(napi::Error::from_reason(format!("invalid order: {other}"))),
    }
}

fn to_read_spec(spec: JsReadSpec) -> napi::Result<ReadSpec> {
    Ok(ReadSpec {
        table: spec.table,
        index: spec.index,
        bounds: spec.bounds.map(to_bounds).transpose()?,
        order: parse_order(&spec.order)?,
        page_size: spec.page_size.map(|n| n as usize),
        cursor: spec.cursor,
        resume_after_key: spec
            .resume_after_key
            .map(|values| values.into_iter().map(to_value).collect())
            .transpose()?,
    })
}

fn to_count_spec(spec: JsCountSpec) -> napi::Result<CountSpec> {
    Ok(CountSpec {
        table: spec.table,
        index: spec.index,
        bounds: spec.bounds.map(to_bounds).transpose()?,
    })
}

fn to_bounds(bounds: Vec<JsBound>) -> napi::Result<Vec<Bound>> {
    bounds.into_iter().map(to_bound).collect()
}

fn to_bound(bound: JsBound) -> napi::Result<Bound> {
    match bound.kind.as_str() {
        "eq" => Ok(Bound::Eq {
            value: bound
                .value
                .map(to_value)
                .transpose()?
                .unwrap_or(ColValue::Null),
        }),
        "range" => Ok(Bound::Range {
            lower: bound.lower.map(to_value).transpose()?,
            lower_inclusive: bound.lower_inclusive.unwrap_or(false),
            upper: bound.upper.map(to_value).transpose()?,
            upper_inclusive: bound.upper_inclusive.unwrap_or(false),
        }),
        other => Err(napi::Error::from_reason(format!(
            "invalid bound kind: {other}"
        ))),
    }
}

fn to_write_batch(batch: JsWriteBatch) -> napi::Result<WriteBatch> {
    let JsWriteBatch {
        crdt_ops,
        crdt_restores,
        data_only_ids,
        deletes,
        local_field_writes,
        local_field_deletes,
        fresh_ids,
        id_mappings,
        schedules,
        doc_writes,
    } = batch;

    let commit_ts_doc_writes = doc_writes
        .iter()
        .enumerate()
        .filter_map(|(index, write)| (write.pending_commit_ts == Some(true)).then_some(index))
        .collect();
    let local_field_writes = local_field_writes.unwrap_or_default();
    let commit_ts_local_field_writes = local_field_writes
        .iter()
        .enumerate()
        .filter_map(|(index, write)| (write.pending_commit_ts == Some(true)).then_some(index))
        .collect();

    Ok(WriteBatch {
        doc_writes: doc_writes
            .into_iter()
            .map(to_upsert)
            .collect::<napi::Result<Vec<_>>>()?,
        deletes: deletes
            .into_iter()
            .map(|delete| DeleteIn {
                id: delete.id,
                table: delete.table,
            })
            .collect(),
        local_field_writes: local_field_writes
            .into_iter()
            .map(|write| {
                Ok(LocalFieldWrite {
                    table: write.table,
                    id: write.id,
                    field: write.field,
                    value: serde_json::from_str(&write.value_json).map_err(|error| {
                        napi::Error::from_reason(format!("invalid device field JSON: {error}"))
                    })?,
                })
            })
            .collect::<napi::Result<Vec<_>>>()?,
        local_field_deletes: local_field_deletes
            .unwrap_or_default()
            .into_iter()
            .map(|delete| LocalFieldDelete {
                table: delete.table,
                id: delete.id,
                field: delete.field,
            })
            .collect(),
        crdt_ops: crdt_ops
            .unwrap_or_default()
            .into_iter()
            .map(to_crdt_op)
            .collect::<napi::Result<Vec<_>>>()?,
        crdt_restores: crdt_restores
            .unwrap_or_default()
            .into_iter()
            .map(to_crdt_restore)
            .collect::<napi::Result<Vec<_>>>()?,
        fresh_ids: fresh_ids
            .unwrap_or_default()
            .into_iter()
            .map(|fresh| storage::RowKey {
                table: fresh.table,
                document_id: fresh.id,
            })
            .collect(),
        data_only_ids: data_only_ids
            .unwrap_or_default()
            .into_iter()
            .map(|row| storage::RowKey {
                table: row.table,
                document_id: row.id,
            })
            .collect(),
        id_mappings: id_mappings
            .unwrap_or_default()
            .into_iter()
            .map(to_id_mapping)
            .collect::<napi::Result<Vec<_>>>()?,
        schedules: schedules
            .unwrap_or_default()
            .into_iter()
            .map(to_scheduled_job)
            .collect::<napi::Result<Vec<_>>>()?,
        commit_ts_doc_writes,
        commit_ts_local_field_writes,
    })
}

fn to_crdt_op(op: JsCrdtOp) -> napi::Result<CrdtOp> {
    let operation = match op.kind.as_str() {
        "count.add" => CrdtOperation::CountAdd {
            delta: op
                .delta
                .ok_or_else(|| napi::Error::from_reason("count.add CRDT op missing delta"))?,
        },
        "set.add" => CrdtOperation::SetAdd {
            value_json: op
                .value_json
                .ok_or_else(|| napi::Error::from_reason("set.add CRDT op missing valueJson"))?,
        },
        "set.delete" => CrdtOperation::SetDelete {
            value_json: op
                .value_json
                .ok_or_else(|| napi::Error::from_reason("set.delete CRDT op missing valueJson"))?,
        },
        "text.splice" => CrdtOperation::TextSplice {
            index: op
                .index
                .ok_or_else(|| napi::Error::from_reason("text.splice CRDT op missing index"))?,
            delete: op
                .delete
                .ok_or_else(|| napi::Error::from_reason("text.splice CRDT op missing delete"))?,
            insert: op
                .insert
                .ok_or_else(|| napi::Error::from_reason("text.splice CRDT op missing insert"))?,
        },
        other => {
            return Err(napi::Error::from_reason(format!(
                "invalid CRDT op kind: {other}"
            )));
        }
    };
    Ok(CrdtOp {
        field: op.field,
        operation,
        row: RowKey {
            document_id: op.id,
            table: op.table,
        },
    })
}

fn to_crdt_restore(restore: JsCrdtRestore) -> napi::Result<CrdtRestore> {
    let kind = CrdtFieldKind::parse_wire(&restore.kind).ok_or_else(|| {
        napi::Error::from_reason(format!("invalid CRDT restore kind: {}", restore.kind))
    })?;
    Ok(CrdtRestore {
        row: RowKey {
            table: restore.table,
            document_id: restore.id,
        },
        field: restore.field,
        kind,
        head_seq: restore.head_seq,
        projection_hash: restore.projection_hash,
        bytes: restore.bytes.to_vec(),
        hash: restore.hash,
    })
}

fn to_commit_options(options: Option<JsCommitOptions>) -> napi::Result<CommitOptions> {
    match options {
        Some(options) => {
            let commit_ts = options.commit_ts.unwrap_or(false);
            let mutation_result_commit_ts = options.mutation_result_commit_ts.unwrap_or(false);
            let push_after_images_commit_ts = options.push_after_images_commit_ts.unwrap_or(false);
            let mut decoded = decode_commit_options(
                options.source.as_deref(),
                options.mutation_id,
                options.mutation_name,
                options.mutation_args,
                options.mutation_result,
                options.push_envelope_json,
                options.push_envelope_now_ms.map(|value| value as i64),
                options.mutation_is_fresh,
                options.include_changes,
            )?;
            decoded.commit_ts = commit_ts;
            decoded.mutation_result_commit_ts = mutation_result_commit_ts;
            if let Some(push) = &mut decoded.push {
                push.after_images_commit_ts = push_after_images_commit_ts;
            }
            Ok(decoded)
        }
        None => Ok(CommitOptions::default()),
    }
}

#[allow(clippy::too_many_arguments)]
fn decode_commit_options(
    source: Option<&str>,
    mutation_id: Option<String>,
    mutation_name: Option<String>,
    mutation_args: Option<String>,
    mutation_result: Option<String>,
    push_json: Option<String>,
    push_now_ms: Option<i64>,
    mutation_is_fresh: Option<bool>,
    include_changes: Option<bool>,
) -> napi::Result<CommitOptions> {
    CommitOptions::decode(
        source,
        mutation_id,
        mutation_name,
        mutation_args,
        mutation_result,
        push_json,
        push_now_ms,
        mutation_is_fresh.unwrap_or(false),
        include_changes.unwrap_or(true),
    )
    .ok_or_else(|| napi::Error::from_reason("invalid exact commit metadata"))
}

fn commit_include_changes(options: Option<&JsCommitOptions>) -> bool {
    options
        .and_then(|options| options.include_changes)
        .unwrap_or(true)
}

fn to_upsert(u: JsDocWrite) -> napi::Result<DocWrite> {
    Ok(DocWrite {
        table: u.table,
        id: u.id,
        data: u.data,
        cols: u
            .cols
            .into_iter()
            .map(to_col)
            .collect::<napi::Result<Vec<_>>>()?,
        creation_time: u.creation_time,
    })
}

fn to_col(c: JsColValue) -> napi::Result<(String, ColValue)> {
    let name = c.name;
    let value = to_value(JsScalar {
        text: c.text,
        real: c.real,
        int: c.int,
        r#bool: c.r#bool,
        undef: c.undef,
        commit_ts: c.commit_ts,
    })
    .map_err(|e| napi::Error::from_reason(format!("column value {name}: {e}")))?;
    Ok((name, value))
}

fn decode_encoded_col_keys(bytes: &Uint8Array) -> napi::Result<Vec<Vec<u8>>> {
    let bytes = bytes.to_vec();
    if bytes.len() < 4 {
        return Err(napi::Error::from_reason(
            "encoded column key payload missing count",
        ));
    }
    let mut cursor = 0usize;
    let count = read_u32_le(&bytes, &mut cursor, "encoded column key count")? as usize;
    let mut cols = Vec::with_capacity(count);
    for index in 0..count {
        let len = read_u32_le(&bytes, &mut cursor, "encoded column key length")? as usize;
        let end = cursor.checked_add(len).ok_or_else(|| {
            napi::Error::from_reason(format!("encoded column key {index} length overflow"))
        })?;
        let value = bytes.get(cursor..end).ok_or_else(|| {
            napi::Error::from_reason(format!("encoded column key {index} truncated"))
        })?;
        cols.push(value.to_vec());
        cursor = end;
    }
    if cursor != bytes.len() {
        return Err(napi::Error::from_reason(format!(
            "encoded column key payload has {} trailing bytes",
            bytes.len() - cursor
        )));
    }
    Ok(cols)
}

fn read_u32_le(bytes: &[u8], cursor: &mut usize, label: &str) -> napi::Result<u32> {
    let end = cursor
        .checked_add(4)
        .ok_or_else(|| napi::Error::from_reason(format!("{label} overflow")))?;
    let chunk = bytes
        .get(*cursor..end)
        .ok_or_else(|| napi::Error::from_reason(format!("{label} truncated")))?;
    *cursor = end;
    Ok(u32::from_le_bytes(chunk.try_into().map_err(|_| {
        napi::Error::from_reason(format!("{label} truncated"))
    })?))
}

fn to_value(v: JsScalar) -> napi::Result<ColValue> {
    let set = usize::from(v.text.is_some())
        + usize::from(v.real.is_some())
        + usize::from(v.int.is_some())
        + usize::from(v.r#bool.is_some())
        + usize::from(v.commit_ts.is_some());
    if set > 1 || (set == 1 && v.undef == Some(true)) {
        return Err(napi::Error::from_reason("multiple value tags set"));
    }
    if v.undef == Some(true) {
        return Ok(ColValue::Undefined);
    }
    let value = match (v.text, v.real, v.int, v.r#bool, v.commit_ts) {
        (Some(t), None, None, None, None) => ColValue::Text(t),
        (None, Some(r), None, None, None) => ColValue::Real(r),
        (None, None, Some(i), None, None) => ColValue::Integer(
            i.parse()
                .map_err(|_| napi::Error::from_reason(format!("invalid i64 value: {i}")))?,
        ),
        (None, None, None, Some(b), None) => ColValue::Bool(b),
        (None, None, None, None, Some(true)) => ColValue::PendingCommitTs,
        (None, None, None, None, None) => ColValue::Null,
        (None, None, None, None, Some(false)) => {
            return Err(napi::Error::from_reason("commitTs marker must be true"));
        }
        _ => unreachable!("multiple JsColValue tags already rejected"),
    };
    Ok(value)
}

fn to_mutation_call(call: JsMutationCall) -> MutationCall {
    MutationCall {
        args: call.args,
        mutation_id: call.mutation_id,
        name: call.name,
    }
}

fn js_page(page: Page) -> JsPage {
    JsPage {
        text: page.text,
        cursor: page.cursor,
        versions: page.versions.into_iter().collect(),
        local_fields_json: (!page.local_fields.is_empty())
            .then(|| serde_json::to_string(&page.local_fields))
            .transpose()
            .expect("device field values were decoded from JSON"),
    }
}

fn js_commit_result(result: CommitResult, include_changes: bool) -> JsCommitResult {
    JsCommitResult {
        changed_tables: result.changed_tables,
        changes: if include_changes {
            result.changes.into_iter().map(js_row_change).collect()
        } else {
            Vec::new()
        },
        commit_seq: result.commit_seq,
        commit_ts: result.commit_ts.map(|timestamp| timestamp.to_string()),
        crdt_ops: result.crdt_ops.into_iter().map(js_crdt_wire_op).collect(),
    }
}

fn js_crdt_wire_op(op: CrdtWireOp) -> JsCrdtWireOp {
    JsCrdtWireOp {
        table: op.table,
        id: op.id,
        field: op.field,
        kind: op.kind.as_wire().to_owned(),
        update: base64::encode(&op.update),
    }
}

fn js_crdt_snapshot(snapshot: CrdtSnapshot) -> JsCrdtSnapshot {
    JsCrdtSnapshot {
        field: snapshot.field,
        kind: snapshot.kind.as_wire().to_owned(),
        head_seq: snapshot.head_seq,
        projection_hash: snapshot.projection_hash,
        bytes: snapshot.bytes.into(),
        hash: snapshot.hash,
    }
}

fn js_row_change(change: RowChange) -> JsRowChange {
    JsRowChange {
        op: change.op.as_str().to_owned(),
        table: change.table,
        id: change.id,
        row: change.row,
    }
}

fn js_dirty_head_debug(head: DirtyHeadDebug) -> JsDirtyHeadDebug {
    JsDirtyHeadDebug {
        table: head.row.table,
        id: head.row.document_id,
        op: head.op.as_str().to_owned(),
        first_commit_seq: head.first_commit_seq,
        updated_commit_seq: head.updated_commit_seq,
        created_time: head.created_time,
        updated_time: head.updated_time,
        server_document_id: head.server_document_id,
        base_projection_hash: head.base_projection_hash,
        base_root_id: head.base_root_id,
        base_node_id: head.base_node_id,
        logical_clock: head.logical_clock,
    }
}

fn js_remote_doc_debug(state: RowHead) -> JsRemoteDocDebug {
    JsRemoteDocDebug {
        table: state.table,
        local_document_id: state.local_document_id,
        current_rev_id: state.current_rev_id,
        server_document_id: state.server_document_id,
        projection_hash: state.projection_hash,
        current_root_id: state.current_root_id,
        current_node_id: state.current_node_id,
        server_base: state.server_base,
        logical_clock: state.logical_clock,
        updated_time: state.updated_time,
    }
}

fn js_delete_result(result: DeleteResult) -> JsDeleteResult {
    JsDeleteResult {
        commits_deleted: result.commits_deleted,
        mutations_deleted: result.mutations_deleted,
    }
}

fn js_mutation_record(record: MutationRecord) -> JsMutationRecord {
    JsMutationRecord {
        commit_seq: record.commit_seq,
        error: record.error,
        mutation_id: record.mutation_id,
        result: record.result,
        status: match record.status {
            MutationStatus::Accepted => "accepted",
            MutationStatus::Committed => "committed",
            MutationStatus::Failed => "failed",
        }
        .to_owned(),
    }
}

fn to_id_mapping(mapping: JsIdMapping) -> napi::Result<IdMapping> {
    let content = IdMappingContent::decode(&mapping.state, mapping.convex_id).ok_or_else(|| {
        napi::Error::from_reason(format!(
            "invalid id mapping content for state {}",
            mapping.state
        ))
    })?;
    Ok(IdMapping {
        table: mapping.table,
        local_id: mapping.local_id,
        mapping: content,
        created_time: mapping.created_time,
        updated_time: mapping.updated_time,
    })
}

/// The last accepted authoritative row JSON a projection retains (`server_row`), for reconstructing
/// a locally dirty-deleted referenced row from its base (Cut 7 §4.3 [V5-BASE]).
fn base_row_of(head: Option<RowHead>) -> Option<String> {
    head.and_then(|state| state.server_row)
}

fn js_result_entry(entry: ResultEntry) -> JsResultEntry {
    JsResultEntry {
        key: entry.key,
        function: entry.function,
        args: entry.args,
        schema_hash: entry.schema_hash,
        module_hash: entry.module_hash,
        skeleton: Uint8Array::from(entry.skeleton),
        paths: Uint8Array::from(entry.paths),
        skeleton_hash: entry.skeleton_hash,
        clock: entry.clock,
    }
}

fn to_result_entry(entry: JsResultEntry) -> ResultEntry {
    ResultEntry {
        key: entry.key,
        function: entry.function,
        args: entry.args,
        schema_hash: entry.schema_hash,
        module_hash: entry.module_hash,
        skeleton: entry.skeleton.to_vec(),
        paths: entry.paths.to_vec(),
        skeleton_hash: entry.skeleton_hash,
        clock: entry.clock,
    }
}

fn js_id_mapping(mapping: IdMapping) -> JsIdMapping {
    let convex_id = mapping.convex_id().map(str::to_owned);
    let state = mapping.mapping.as_str().to_owned();
    JsIdMapping {
        table: mapping.table,
        local_id: mapping.local_id,
        convex_id,
        state,
        created_time: mapping.created_time,
        updated_time: mapping.updated_time,
    }
}

fn to_file_metadata(metadata: JsFileMetadata) -> FileMetadata {
    FileMetadata {
        storage_id: metadata.storage_id,
        sha256: metadata.sha256,
        size: metadata.size,
        content_type: metadata.content_type,
        source: metadata.source,
        created_time: metadata.created_time,
        updated_time: metadata.updated_time,
    }
}

fn to_file_store(input: JsFileStore) -> FileStore {
    FileStore {
        bytes: input.bytes.to_vec(),
        metadata: to_file_metadata(input.metadata),
    }
}

fn js_file_metadata(metadata: FileMetadata) -> JsFileMetadata {
    JsFileMetadata {
        storage_id: metadata.storage_id,
        sha256: metadata.sha256,
        size: metadata.size,
        content_type: metadata.content_type,
        source: metadata.source,
        created_time: metadata.created_time,
        updated_time: metadata.updated_time,
    }
}

fn to_pending_upload(upload: JsPendingUpload) -> napi::Result<PendingUpload> {
    let lease =
        UploadLease::decode(&upload.state, upload.owner, upload.lease_until).ok_or_else(|| {
            napi::Error::from_reason(format!("invalid upload lease for state {}", upload.state))
        })?;
    Ok(PendingUpload {
        local_storage_id: upload.local_storage_id,
        sha256: upload.sha256,
        size: upload.size,
        content_type: upload.content_type,
        lease,
        created_time: upload.created_time,
        updated_time: upload.updated_time,
    })
}

fn to_upload_lease_write(args: JsUploadLeaseWrite) -> napi::Result<UploadLeaseWrite> {
    match (args.lease.as_str(), args.local_storage_id, args.lease_until) {
        ("claimed", local_storage_id, Some(lease_until)) => Ok(UploadLeaseWrite::Claimed {
            local_storage_id,
            owner: args.owner,
            now_ms: args.now_ms,
            lease_until,
        }),
        ("pending", Some(local_storage_id), None) => Ok(UploadLeaseWrite::Pending {
            local_storage_id,
            owner: args.owner,
            now_ms: args.now_ms,
        }),
        _ => Err(napi::Error::from_reason(format!(
            "invalid upload lease {} command payload",
            args.lease
        ))),
    }
}

fn js_pending_upload(upload: PendingUpload) -> JsPendingUpload {
    let state = upload.lease.as_str().to_owned();
    let owner = upload.lease.owner().map(str::to_owned);
    let lease_until = upload.lease.lease_until();
    JsPendingUpload {
        local_storage_id: upload.local_storage_id,
        sha256: upload.sha256,
        size: upload.size,
        content_type: upload.content_type,
        state,
        owner,
        lease_until,
        created_time: upload.created_time,
        updated_time: upload.updated_time,
    }
}

fn to_scheduled_job(job: JsScheduledJob) -> napi::Result<ScheduledJob> {
    let state = ScheduledState::decode(&job.state, job.lease_until).ok_or_else(|| {
        napi::Error::from_reason(format!("invalid scheduled job state: {}", job.state))
    })?;
    let kind = to_scheduled_kind(&job.kind)?;
    Ok(ScheduledJob {
        job_id: job.job_id,
        kind,
        name: job.name,
        args: job.args,
        due_time: job.due_time,
        state,
        created_time: job.created_time,
        updated_time: job.updated_time,
    })
}

fn to_scheduled_kind(value: &str) -> napi::Result<ScheduledFunctionKind> {
    ScheduledFunctionKind::parse(value).ok_or_else(|| {
        napi::Error::from_reason(format!("invalid scheduled function kind: {value}"))
    })
}

fn js_scheduled_job(job: ScheduledJob) -> JsScheduledJob {
    let lease_until = job.state.lease_until();
    JsScheduledJob {
        job_id: job.job_id,
        kind: job.kind.as_str().to_owned(),
        name: job.name,
        args: job.args,
        due_time: job.due_time,
        state: job.state.as_str().to_owned(),
        lease_until,
        created_time: job.created_time,
        updated_time: job.updated_time,
    }
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "passed as a fn item to Result::map_err, which hands over the error by value"
)]
fn map_err(e: StorageError) -> napi::Error {
    napi::Error::from_reason(format!("[convex-embedded:{}] {e}", e.code()))
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "passed as a fn item to Result::map_err, which hands over the error by value"
)]
fn map_remote_err(e: RemoteError) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}

/// Decode the exact set of hosted query subscriptions published by the JS runtime.
fn parse_remote_scope(scope_json: &str) -> napi::Result<RemoteScope> {
    let parsed: serde_json::Value = serde_json::from_str(scope_json)
        .map_err(|error| napi::Error::from_reason(format!("scope was not JSON: {error}")))?;
    let serde_json::Value::Object(fields) = parsed else {
        return Err(napi::Error::from_reason("scope must be a JSON object"));
    };
    let Some(serde_json::Value::Array(values)) = fields.get("subscriptions") else {
        return Err(napi::Error::from_reason(
            "scope subscriptions must be an array",
        ));
    };
    let subscriptions = values
        .iter()
        .map(|value| {
            let serde_json::Value::Object(subscription) = value else {
                return Err(napi::Error::from_reason(
                    "scope subscription must be an object",
                ));
            };
            let Some(pull_fn) = subscription.get("fn").and_then(serde_json::Value::as_str) else {
                return Err(napi::Error::from_reason(
                    "scope subscription fn must be a string",
                ));
            };
            let Some(pull_args) = subscription.get("args") else {
                return Err(napi::Error::from_reason(
                    "scope subscription args are required",
                ));
            };
            let cursor = match subscription.get("cursor") {
                None => None,
                Some(serde_json::Value::Object(cursor)) => {
                    let Some(path) = cursor.get("path").and_then(serde_json::Value::as_str) else {
                        return Err(napi::Error::from_reason(
                            "scope subscription cursor path must be a string",
                        ));
                    };
                    let Some(boundary) = cursor.get("boundary") else {
                        return Err(napi::Error::from_reason(
                            "scope subscription cursor boundary is required",
                        ));
                    };
                    Some(RemoteCursor {
                        path: path.to_owned(),
                        boundary: boundary.clone(),
                    })
                }
                Some(_) => {
                    return Err(napi::Error::from_reason(
                        "scope subscription cursor must be an object",
                    ))
                }
            };
            let result_cache_key = match subscription.get("resultCacheKey") {
                None | Some(serde_json::Value::Null) => None,
                Some(serde_json::Value::String(key)) => Some(key.clone()),
                Some(_) => {
                    return Err(napi::Error::from_reason(
                        "scope subscription resultCacheKey must be a string",
                    ))
                }
            };
            Ok(RemoteSubscription {
                pull_fn: pull_fn.to_owned(),
                pull_args: pull_args.clone(),
                result_cache_key,
                cursor,
            })
        })
        .collect::<napi::Result<Vec<_>>>()?;
    Ok(RemoteScope { subscriptions })
}

#[cfg(test)]
mod tests {
    use storage::{
        AuthoritativeRow, ColValue, ColumnDef, CommitOptions, DocWrite, EmbeddedStore, IndexDef,
        Order, ReadSpec, RevLifecycle, RowKey, StorageError, StoreSchema, TableDef, TablePlacement,
        WriteBatch,
    };

    #[test]
    fn prebaseline_storage_error_keeps_its_cross_binding_marker() {
        let error = super::map_err(StorageError::PreBaselineStore {
            found: 46,
            minimum: 47,
        });
        assert!(error.reason.contains("EMBEDDED_PRE_BASELINE_STORE"));
    }

    fn reroot_schema() -> StoreSchema {
        StoreSchema {
            hash: "0".repeat(64),
            setup_hash: String::new(),
            tables: vec![TableDef {
                name: "issues".into(),
                placement: TablePlacement::Replicated,
                local_fields: vec![],
                columns: vec![ColumnDef {
                    name: "status".into(),
                    field: None,
                }],
                crdt_fields: Vec::new(),
                indexes: vec![IndexDef {
                    name: "by_status".into(),
                    fields: vec!["status".into()],
                    columns: None,
                }],
            }],
        }
    }

    fn parse_docs(text: &str) -> Vec<serde_json::Value> {
        serde_json::from_str(text).unwrap()
    }

    fn pull(projections: Vec<AuthoritativeRow>, received_time: i64) -> storage::RemotePageWrite {
        let members = projections
            .iter()
            .filter(|projection| projection.row.is_some())
            .map(|projection| storage::RemoteMember {
                table: projection.table.clone(),
                server_document_id: projection.server_document_id.clone(),
            })
            .collect();
        storage::RemotePageWrite {
            subscription: "issues:list:{}".into(),
            members,
            projections,
            crdt: Vec::new(),
            blobs: Vec::new(),
            cursor: None,
            received_time,
            result: None,
        }
    }

    /// Drives one authoritative rejection settlement through storage. The hosted winner, local
    /// archive, and hosted rev receipt commit together before the resulting conflict crosses the
    /// `js_remote_tick` -> `JsReroot` boundary.
    #[test]
    #[allow(clippy::too_many_lines)]
    fn js_remote_tick_maps_a_revision_produced_by_real_rejection_settlement() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!(
            "node_real_pull_reroot_{}.db",
            u64::from(std::process::id()) * 1_000
                + u64::from(storage::clock::wall_ms().unwrap() as u32,)
        ));
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&reroot_schema()).unwrap();
        let server_id = "j575pnjjhzf95ze91djp5v26b188xreb";

        store
            .remote_page_write(&pull(
                vec![AuthoritativeRow {
                    current_node_id: Some("node:server-v1".into()),
                    current_root_id: Some("root:server-v1".into()),
                    local_document_id: None,
                    plain_hash: "plain:server-v1".into(),
                    projection_hash: "sha256:server-v1".into(),
                    logical_clock: Some(0.0),
                    received_time: 5,
                    row: Some(format!(
                        r#"{{"_id":"{server_id}","_creationTime":1,"status":"open","title":"server v1"}}"#
                    )),
                    server_document_id: server_id.into(),
                    table: "issues".into(),
                }],
                5,
            ))
            .unwrap();
        let docs = parse_docs(
            &store
                .doc_page_read(&ReadSpec {
                    table: "issues".into(),
                    order: Order::Asc,
                    ..Default::default()
                })
                .unwrap()
                .text,
        );
        let local_id = docs[0]["_id"].as_str().unwrap().to_owned();

        let local_commit = store
            .commit(
                WriteBatch {
                    doc_writes: vec![DocWrite {
                        cols: vec![("status".into(), ColValue::Text("local".into()))],
                        creation_time: store.clock_read().unwrap(),
                        data: r#"{"title":"local dirty"}"#.into(),
                        id: local_id.clone(),
                        table: "issues".into(),
                    }],
                    ..WriteBatch::default()
                },
                &CommitOptions::default(),
            )
            .unwrap();

        store
            .remote_push_envelope_write("rejected-dirty", local_commit.commit_seq, "{}", 10)
            .unwrap();
        let produced = store
            .remote_settlement_write(&storage::RemoteSettlementWrite {
                mutation_id: "rejected-dirty".to_owned(),
                expected_commit_seq: local_commit.commit_seq,
                now_ms: 10,
                outcome: storage::RemoteSettlementOutcome::Rejected {
                    schedules: Vec::new(),
                    targets: vec![storage::RemoteRowTarget {
                        table: "issues".to_owned(),
                        local_document_id: local_id.clone(),
                        server_rev_id: Some("rev:server-retained".to_owned()),
                        retain: true,
                    }],
                    projections: vec![AuthoritativeRow {
                        current_node_id: Some("node:server-current".into()),
                        current_root_id: Some("root:server-current".into()),
                        local_document_id: Some(local_id.clone()),
                        plain_hash: "plain:server-current".into(),
                        projection_hash: "sha256:server-current".into(),
                        logical_clock: storage::testkit::dominating_clock(),
                        received_time: 10,
                        row: Some(format!(
                            r#"{{"_id":"{server_id}","_creationTime":1,"status":"open","title":"server current"}}"#
                        )),
                        server_document_id: server_id.into(),
                        table: "issues".into(),
                    }],
                },
            })
            .unwrap()
            .projection
            .reroots
            .into_iter()
            .next()
            .expect("a rejected dirty edit must retain one revision");
        let revs = store
            .rev_read(&RowKey {
                table: "issues".into(),
                document_id: local_id.clone(),
            })
            .unwrap();
        let archived = revs
            .iter()
            .find(|entry| entry.key.rev_id == produced.archived_rev_id)
            .expect("dirty rev should be archived");
        assert!(matches!(
            &archived.lifecycle,
            RevLifecycle::Archived(metadata)
                if metadata.server_rev_id.as_deref() == Some("rev:server-retained")
        ));

        let tick = remote::RemoteTick {
            retained_revisions: vec![produced.clone()],
            ..remote::RemoteTick::default()
        };
        let js = super::js_remote_tick(tick);

        assert_eq!(js.retained_revisions.len(), 1);
        let mapped = &js.retained_revisions[0];
        assert_eq!(mapped.table, produced.table);
        assert_eq!(mapped.id, produced.local_document_id);
        assert_eq!(mapped.rev_id, "rev:server-retained");
        assert_eq!(mapped.server_doc_id, produced.server_document_id);
        assert_eq!(mapped.base_root_id, produced.base_root_id);
        assert_eq!(mapped.base_node_id, produced.base_node_id);
        assert_eq!(mapped.attached_node_id, produced.attached_node_id);
        assert_eq!(mapped.current_root_id, produced.current_root_id);
        assert_eq!(mapped.id, local_id);
        assert_eq!(mapped.server_doc_id.as_deref(), Some(server_id));
        assert_eq!(
            mapped.current_root_id.as_deref(),
            Some("root:server-current")
        );
        assert_eq!(mapped.base_root_id.as_deref(), Some("root:server-v1"));
        assert_eq!(mapped.base_node_id.as_deref(), Some("node:server-v1"));

        drop(store);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn js_remote_tick_maps_rev_reroots() {
        let tick = remote::RemoteTick {
            retained_revisions: vec![storage::RetainedRevision {
                table: "todos".to_owned(),
                local_document_id: "todos|local".to_owned(),
                archived_rev_id: "archive:lost".to_owned(),
                server_rev_id: Some("rev:server".to_owned()),
                server_document_id: Some("todos|server".to_owned()),
                base_root_id: Some("root:client".to_owned()),
                base_node_id: Some("node:client-base".to_owned()),
                attached_node_id: Some("node:loser".to_owned()),
                current_root_id: Some("root:server".to_owned()),
            }],
            ..remote::RemoteTick::default()
        };

        let js = super::js_remote_tick(tick);

        assert_eq!(js.retained_revisions.len(), 1);
        let reroot = &js.retained_revisions[0];
        assert_eq!(reroot.table, "todos");
        assert_eq!(reroot.id, "todos|local");
        assert_eq!(reroot.rev_id, "rev:server");
        assert_eq!(reroot.server_doc_id.as_deref(), Some("todos|server"));
        assert_eq!(reroot.base_root_id.as_deref(), Some("root:client"));
        assert_eq!(reroot.base_node_id.as_deref(), Some("node:client-base"));
        assert_eq!(reroot.attached_node_id.as_deref(), Some("node:loser"));
        assert_eq!(reroot.current_root_id.as_deref(), Some("root:server"));
    }

    #[test]
    fn js_remote_tick_keeps_the_required_settlement_vector() {
        let js = super::js_remote_tick(remote::RemoteTick::default());

        assert!(js.settlements.is_empty());
    }
}
