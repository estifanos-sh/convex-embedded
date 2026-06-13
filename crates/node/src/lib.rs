//! napi bindings exposing the Rust `EmbeddedStore` to the Node package. Convex function
//! execution stays in JavaScript; this binding provides the storage backend. `_creationTime`
//! crosses the boundary as `f64` (its native type); other integers above 2^53 would lose
//! precision.
//!
//! On native targets a dedicated storage thread owns all database work: every method posts a
//! job and awaits its result, so `SQLite` I/O never runs on the JS event loop, calls stay FIFO
//! (a commit is visible to the read awaited after it), and the process-global per-path lock can
//! never park the JS thread. On wasm the methods run inline — the OPFS worker is the dedicated
//! thread in that architecture. `clockNext` is the one synchronous method: it touches
//! only the in-memory clock, never the database.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
use storage::{
    Bound, ColValue, ColumnDef, CommitOptions, CommitResult, CountSpec, DeleteIn,
    EmbeddedStore, IndexDef, MutationCall, MutationRecord, MutationStatus, Order, Page,
    PruneResult, ScanSpec, StorageError, StoreSchema, TableDef, UpsertIn, WriteBatch,
};

const API_VERSION: u32 = 6;

#[napi(js_name = "apiVersion")]
#[must_use]
pub fn api_version() -> u32 {
    API_VERSION
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
    pub columns: Vec<JsColumn>,
    pub indexes: Vec<JsIndex>,
}

#[napi(object)]
pub struct JsSchema {
    pub tables: Vec<JsTable>,
}

/// An extracted column value, tagged by which field is set. At most one of
/// `text`/`real`/`int`/`bool` may be present; `undef = true` means the field was absent
/// (Convex `undefined`); all absent means SQL `null`.
#[napi(object)]
pub struct JsColValue {
    pub name: String,
    pub text: Option<String>,
    pub real: Option<f64>,
    pub int: Option<String>,
    pub r#bool: Option<bool>,
    pub undef: Option<bool>,
}

/// A tagged scalar value for bounds and cursor keys. At most one of `text`/`real`/`int`/`bool`
/// may be present; `undef = true` means Convex `undefined`; all absent means `null`.
#[napi(object)]
pub struct JsValue {
    pub text: Option<String>,
    pub real: Option<f64>,
    pub int: Option<String>,
    pub r#bool: Option<bool>,
    pub undef: Option<bool>,
}

#[napi(object)]
pub struct JsBound {
    pub kind: String,
    pub value: Option<JsValue>,
    pub lower: Option<JsValue>,
    pub lower_inclusive: Option<bool>,
    pub upper: Option<JsValue>,
    pub upper_inclusive: Option<bool>,
}

#[napi(object)]
pub struct JsScanSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<JsBound>>,
    pub order: String,
    /// Max rows in this page, `1..=SCAN_CAP`. Defaults to `DEFAULT_SCAN_PAGE`.
    pub page_size: Option<u32>,
    /// Opaque continuation token from a prior page of the same plan shape.
    pub cursor: Option<String>,
    /// Alternative to `cursor`: resume strictly after this explicit key tuple, one value per
    /// physical order column (`index columns…, creationTimeMs, id`).
    pub resume_after_key: Option<Vec<JsValue>>,
}

#[napi(object)]
pub struct JsCountSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<JsBound>>,
}

#[napi(object)]
pub struct JsUpsert {
    pub table: String,
    pub id: String,
    pub data: String,
    pub cols: Vec<JsColValue>,
    pub creation_time: f64,
}

#[napi(object)]
pub struct JsDelete {
    pub table: String,
    pub id: String,
}

#[napi(object)]
pub struct JsWriteBatch {
    pub upserts: Vec<JsUpsert>,
    pub deletes: Vec<JsDelete>,
}

#[napi(object)]
pub struct JsCommitOptions {
    pub source: Option<String>,
    pub mutation_id: Option<String>,
    pub mutation_result: Option<String>,
}

#[napi(object)]
pub struct JsCommitResult {
    pub changed_tables: Vec<String>,
    pub commit_seq: i64,
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
}

#[napi(object)]
pub struct JsPruneResult {
    pub commits_deleted: i64,
    pub mutations_deleted: i64,
}

/// A job posted to the dedicated storage thread.
#[cfg(not(target_arch = "wasm32"))]
type Job = Box<dyn FnOnce(&EmbeddedStore) + Send>;

struct Inner {
    /// Shared so `clockNext` (clock-only, no I/O) can stay synchronous on the JS thread.
    /// No database call may run through this handle outside the storage thread.
    store: Arc<EmbeddedStore>,
    #[cfg(not(target_arch = "wasm32"))]
    jobs: std::sync::mpsc::Sender<Job>,
    #[cfg(not(target_arch = "wasm32"))]
    thread: Option<std::thread::JoinHandle<()>>,
}

#[napi]
pub struct Store {
    inner: Mutex<Option<Inner>>,
}

/// Native surface: every database method is `async` and posts a job to the dedicated storage
/// thread, so `SQLite` I/O never runs on the JS event loop and calls stay FIFO.
#[cfg(not(target_arch = "wasm32"))]
#[napi]
#[allow(clippy::needless_pass_by_value)]
impl Store {
    #[napi]
    pub async fn open(path: String, identity_key: Option<String>) -> napi::Result<Store> {
        let identity_key = identity_key.unwrap_or_default();
        let inner = open_inner(path, identity_key).await?;
        Ok(Store {
            inner: Mutex::new(Some(inner)),
        })
    }

    /// The next monotonic creation time. Synchronous by design: it touches only the in-memory
    /// clock, never the database.
    #[napi]
    pub fn clock_next(&self) -> napi::Result<f64> {
        self.store()?.clock_next().map_err(map_err)
    }

    #[napi]
    pub async fn setup(&self, schema: JsSchema) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(move |store| store.setup(&schema)).await
    }

    #[napi]
    pub async fn mutation_begin(&self, call: JsMutationCall) -> napi::Result<JsMutationRecord> {
        let call = to_mutation_call(call);
        self.run(move |store| store.mutation_begin(&call).map(js_mutation_record))
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
        let options = to_commit_options(options);
        self.run(move |store| store.commit(batch, &options).map(js_commit_result))
            .await
    }

    #[napi]
    pub async fn doc_read(&self, table: String, id: String) -> napi::Result<Option<String>> {
        self.run(move |store| store.doc_read(&table, &id)).await
    }

    #[napi]
    pub async fn doc_scan(&self, spec: JsScanSpec) -> napi::Result<JsPage> {
        let spec = to_scan_spec(spec)?;
        self.run(move |store| store.doc_scan(&spec).map(js_page))
            .await
    }

    #[napi]
    pub async fn key_scan(&self, spec: JsScanSpec) -> napi::Result<JsPage> {
        let spec = to_scan_spec(spec)?;
        self.run(move |store| store.key_scan(&spec).map(js_page))
            .await
    }

    #[napi]
    pub async fn doc_count(&self, spec: JsCountSpec) -> napi::Result<Option<i64>> {
        let spec = to_count_spec(spec)?;
        self.run(move |store| store.doc_count(&spec)).await
    }

    #[napi]
    pub async fn ledger_prune(&self, up_to_seq: i64) -> napi::Result<JsPruneResult> {
        self.run(move |store| store.ledger_prune(up_to_seq).map(js_prune_result))
            .await
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
    pub async fn clear(&self) -> napi::Result<()> {
        self.run(EmbeddedStore::clear).await
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
        if let Some(inner) = lock(&self.inner).take() {
            let Inner {
                store,
                jobs,
                thread,
            } = inner;
            drop(jobs);
            drop(store);
            if let Some(thread) = thread {
                thread.join().ok();
            }
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
    pub fn open(path: String, identity_key: Option<String>) -> napi::Result<Store> {
        let identity_key = identity_key.unwrap_or_default();
        let store = EmbeddedStore::open_with_identity_key(&path, &identity_key).map_err(map_err)?;
        Ok(Store {
            inner: Mutex::new(Some(Inner {
                store: Arc::new(store),
            })),
        })
    }

    /// The next monotonic creation time. It touches only the in-memory clock, never the database.
    #[napi]
    pub fn clock_next(&self) -> napi::Result<f64> {
        self.store()?.clock_next().map_err(map_err)
    }

    #[napi]
    pub fn setup(&self, schema: JsSchema) -> napi::Result<()> {
        let schema = to_schema(schema)?;
        self.run(|store| store.setup(&schema))
    }

    #[napi]
    pub fn mutation_begin(&self, call: JsMutationCall) -> napi::Result<JsMutationRecord> {
        let call = to_mutation_call(call);
        self.run(|store| store.mutation_begin(&call).map(js_mutation_record))
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
        let options = to_commit_options(options);
        self.run(|store| store.commit(batch, &options).map(js_commit_result))
    }

    #[napi]
    pub fn doc_read(&self, table: String, id: String) -> napi::Result<Option<String>> {
        self.run(|store| store.doc_read(&table, &id))
    }

    #[napi]
    pub fn doc_scan(&self, spec: JsScanSpec) -> napi::Result<JsPage> {
        let spec = to_scan_spec(spec)?;
        self.run(|store| store.doc_scan(&spec).map(js_page))
    }

    #[napi]
    pub fn key_scan(&self, spec: JsScanSpec) -> napi::Result<JsPage> {
        let spec = to_scan_spec(spec)?;
        self.run(|store| store.key_scan(&spec).map(js_page))
    }

    #[napi]
    pub fn doc_count(&self, spec: JsCountSpec) -> napi::Result<Option<i64>> {
        let spec = to_count_spec(spec)?;
        self.run(|store| store.doc_count(&spec))
    }

    #[napi]
    pub fn ledger_prune(&self, up_to_seq: i64) -> napi::Result<JsPruneResult> {
        self.run(|store| store.ledger_prune(up_to_seq).map(js_prune_result))
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
    pub fn clear(&self) -> napi::Result<()> {
        self.run(EmbeddedStore::clear)
    }

    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        lock(&self.inner).take();
        Ok(())
    }
}

impl Store {
    fn store(&self) -> napi::Result<Arc<EmbeddedStore>> {
        lock(&self.inner)
            .as_ref()
            .map(|inner| inner.store.clone())
            .ok_or_else(store_closed)
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
async fn open_inner(path: String, identity_key: String) -> napi::Result<Inner> {
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let (jobs_tx, jobs_rx) = std::sync::mpsc::channel::<Job>();
    let thread = std::thread::Builder::new()
        .name("convex-embedded-storage".to_owned())
        .spawn(move || {
            let store = match EmbeddedStore::open_with_identity_key(&path, &identity_key) {
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
        thread: Some(thread),
    })
}

fn store_closed() -> napi::Error {
    napi::Error::from_reason("Store is closed")
}

/// The guarded state is an Option swap; a poisoned guard is safe to recover.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn to_schema(schema: JsSchema) -> napi::Result<StoreSchema> {
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
            columns,
            indexes: t
                .indexes
                .into_iter()
                .map(to_index)
                .collect::<napi::Result<Vec<_>>>()?,
        });
    }
    Ok(StoreSchema { tables })
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

fn to_scan_spec(spec: JsScanSpec) -> napi::Result<ScanSpec> {
    Ok(ScanSpec {
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
    Ok(WriteBatch {
        upserts: batch
            .upserts
            .into_iter()
            .map(to_upsert)
            .collect::<napi::Result<Vec<_>>>()?,
        deletes: batch
            .deletes
            .into_iter()
            .map(|d| DeleteIn {
                table: d.table,
                id: d.id,
            })
            .collect(),
    })
}

fn to_commit_options(options: Option<JsCommitOptions>) -> CommitOptions {
    match options {
        Some(options) => CommitOptions {
            source: options.source.unwrap_or_else(|| "local".to_owned()),
            mutation_id: options.mutation_id,
            mutation_result: options.mutation_result,
        },
        None => CommitOptions::default(),
    }
}

fn to_upsert(u: JsUpsert) -> napi::Result<UpsertIn> {
    Ok(UpsertIn {
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
    let value = to_value(JsValue {
        text: c.text,
        real: c.real,
        int: c.int,
        r#bool: c.r#bool,
        undef: c.undef,
    })
    .map_err(|e| napi::Error::from_reason(format!("column value {name}: {e}")))?;
    Ok((name, value))
}

fn to_value(v: JsValue) -> napi::Result<ColValue> {
    let set = usize::from(v.text.is_some())
        + usize::from(v.real.is_some())
        + usize::from(v.int.is_some())
        + usize::from(v.r#bool.is_some());
    if set > 1 || (set == 1 && v.undef == Some(true)) {
        return Err(napi::Error::from_reason("multiple value tags set"));
    }
    if v.undef == Some(true) {
        return Ok(ColValue::Undefined);
    }
    let value = match (v.text, v.real, v.int, v.r#bool) {
        (Some(t), None, None, None) => ColValue::Text(t),
        (None, Some(r), None, None) => ColValue::Real(r),
        (None, None, Some(i), None) => ColValue::Integer(
            i.parse()
                .map_err(|_| napi::Error::from_reason(format!("invalid i64 value: {i}")))?,
        ),
        (None, None, None, Some(b)) => ColValue::Bool(b),
        (None, None, None, None) => ColValue::Null,
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
    }
}

fn js_commit_result(result: CommitResult) -> JsCommitResult {
    JsCommitResult {
        changed_tables: result.changed_tables,
        commit_seq: result.commit_seq,
    }
}

fn js_prune_result(result: PruneResult) -> JsPruneResult {
    JsPruneResult {
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

#[expect(
    clippy::needless_pass_by_value,
    reason = "passed as a fn item to Result::map_err, which hands over the error by value"
)]
fn map_err(e: StorageError) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}
