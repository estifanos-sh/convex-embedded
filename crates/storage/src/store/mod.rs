use std::ops::ControlFlow;
use std::sync::{Arc, LazyLock, Mutex, Weak};
use std::time::Instant;
#[cfg(not(target_arch = "wasm32"))]
use std::{fs::OpenOptions, path::Path};

use rustc_hash::{FxHashMap, FxHashSet};
use sha2::{Digest, Sha256};
use turso_core::Value;

use crate::clock::{wall_ms, Clock};
use crate::driver::TursoDriver;
use crate::error::StorageError;
use crate::sql::{
    self, compile_count, compile_page_read, decode_cursor, encode_cursor, read_count_key,
    read_count_params, read_page_key, read_page_params, read_page_shape, Projection, ReadPlan,
    DEFAULT_READ_PAGE, READ_CAP,
};
#[cfg(any(test, feature = "testkit"))]
use crate::types::RevFrontier;
use crate::types::{
    AuthoritativeApplyResult, AuthoritativeRow, ColValue, CommitOptions, CommitResult,
    CommitSource, CountSpec, CrdtOp, CrdtOperation, DeleteIn, DeleteResult, DirtyHeadDebug,
    DocWrite, FileMetadata, FileStore, IdMapping, IdMappingContent, MembershipRange,
    MigrationCandidate, MigrationDisposition, MigrationProgress, MigrationRecordTarget,
    MutationCall, MutationRecord, MutationStatus, OriginCursor, OriginKind, OriginPage,
    OriginRecord, Page, PendingUpload, ReadSpec, RemoteMember, RemotePageWrite,
    RemotePageWriteResult, RemotePending, RemoteSettlementOutcome, RemoteSettlementWrite,
    RemoteSettlementWriteResult, ResultEntry, RevKey, RevState, RevWriteResult, RowChange,
    RowChangeOp, RowHead, RowKey, ScheduledJob, ScheduledState, StoreContract, StoreSchema,
    TableDef, TablePlacement, UploadLease, UploadLeaseWrite, WriteBatch, ORIGIN_FLAG_DISCARDED,
    ORIGIN_FLAG_QUARANTINED,
};

static PATH_LOCKS: LazyLock<Mutex<FxHashMap<String, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(FxHashMap::default()));
#[cfg(not(target_arch = "wasm32"))]
static PATH_OWNERS: LazyLock<Mutex<FxHashMap<String, Weak<OwnerLease>>>> =
    LazyLock::new(|| Mutex::new(FxHashMap::default()));
static COMMIT_SEQ_CACHE: LazyLock<Mutex<FxHashMap<String, i64>>> =
    LazyLock::new(|| Mutex::new(FxHashMap::default()));
const SCHEMA_SIGNATURE_KEY: &str = "schema_signature";
const SCHEMA_MANIFEST_KEY: &str = "schema_manifest";
const STORE_META_IDENTITY: &str = "";
const REMOTE_PUSH_ENVELOPE_PREFIX: &str = "push_envelope:";
const REMOTE_PUSH_ENVELOPE_PREFIX_END: &str = "push_envelope;";
const IDENTITY_STATE_META: &str = "identity_state";
const REMOTE_RECEIPT_PREFIX: &str = "settlement_ack:";
const REMOTE_RECEIPT_PREFIX_END: &str = "settlement_ack;";
const REMOTE_CURSOR_PREFIX: &str = "pull:";
const ORIGIN_CODEC_V1: i64 = 1;
const ORIGIN_FLAGS_NONE: i64 = 0;

fn remote_cursor_key_encode(subscription: &str) -> String {
    format!("{REMOTE_CURSOR_PREFIX}{subscription}")
}

/// How long a claimed scheduled job holds its lease before another worker may reclaim it. A worker
/// that claims a job stamps `lease_until_ms = now_ms + SCHEDULE_LEASE_MS`; if it dies before
/// completing/failing/canceling, the job stays `Running` but becomes reclaimable once the lease
/// expires. Reclaim re-runs the job (at-least-once, matching Convex scheduler semantics) since the
/// prior attempt's outcome is unknown — scheduled functions must be idempotent.
pub const SCHEDULE_LEASE_MS: i64 = 60_000;

struct ProjectionRemoteIdMapping {
    local_id: String,
    stale_document_ids: FxHashSet<String>,
}

struct LegacyOriginSeed {
    identity_key: String,
    kind: OriginKind,
    record_key: Vec<u8>,
    payload: Vec<u8>,
}

#[cfg(not(target_arch = "wasm32"))]
struct OwnerLease {
    _file: std::fs::File,
}

/// Server rev identity stamped onto an archived conflict rev by `archive_current_rev_unlocked`.
/// `Default` (all `None`) is what the pull dirty-archive and stale-detach callers pass; the push
/// CAS-reject caller fills it from the values it already gathers for the `RetainedRevision`.
/// The shared `_id` postfix mirrors the `RetainedRevision`/`RevState` field names this struct carries
/// verbatim; renaming for the lint would break that one-to-one mapping.
#[allow(clippy::struct_field_names)]
#[derive(Default)]
struct ArchiveServerIds {
    server_rev_id: Option<String>,
    server_root_id: Option<String>,
    server_node_id: Option<String>,
    base_root_id: Option<String>,
    base_node_id: Option<String>,
}

struct DirtyHead {
    row: RowKey,
    change: RowChange,
    first_commit_seq: i64,
    updated_commit_seq: i64,
    created_time: i64,
    updated_time: i64,
    server_document_id: Option<String>,
    base_projection_hash: Option<String>,
    base_root_id: Option<String>,
    base_node_id: Option<String>,
    logical_clock: f64,
}

#[allow(
    clippy::struct_field_names,
    reason = "the base prefix distinguishes server-confirmed state from the visible local edit"
)]
struct PendingLocalEdit {
    base_root_id: Option<String>,
    base_node_id: Option<String>,
    base_projection_hash: Option<String>,
}

struct TableRuntime {
    column_positions: FxHashMap<String, usize>,
    def: Arc<TableDef>,
    delete_sql: String,
    read_sql: String,
    update_data_sql: String,
    doc_write_sql: String,
}

impl TableRuntime {
    fn new(def: TableDef) -> Self {
        let column_positions = def
            .columns
            .iter()
            .enumerate()
            .map(|(index, column)| (column.name.clone(), index))
            .collect();
        let read_sql = sql::read_doc(&def.name);
        let update_data_sql = sql::update_doc_data(&def.name);
        let doc_write_sql = sql::write_doc(&def);
        let delete_sql = sql::delete_doc(&def.name);
        Self {
            column_positions,
            def: Arc::new(def),
            delete_sql,
            read_sql,
            update_data_sql,
            doc_write_sql,
        }
    }
}

pub struct EmbeddedStore {
    driver: TursoDriver,
    identity_key: MutableKey,
    selector_key: String,
    commit_seq_key: MutableKey,
    path_key: String,
    operation_lock: Arc<Mutex<()>>,
    #[cfg(not(target_arch = "wasm32"))]
    _owner_lease: Option<Arc<OwnerLease>>,
    tables: Mutex<FxHashMap<String, Arc<TableRuntime>>>,
    plans: Mutex<FxHashMap<String, Arc<ReadPlan>>>,
    clock: Mutex<Clock>,
    peer_id: Mutex<Option<u64>>,
    absent_mutations: Mutex<FxHashMap<String, MutationCall>>,
}

struct MutableKey(Mutex<String>);

impl MutableKey {
    fn new(value: String) -> Self {
        Self(Mutex::new(value))
    }

    fn clone(&self) -> String {
        lock(&self.0).clone()
    }

    fn write(&self, value: String) {
        *lock(&self.0) = value;
    }
}

impl EmbeddedStore {
    pub fn open(path: &str) -> Result<Self, StorageError> {
        Self::open_with_identity_key(path, "")
    }

    pub fn open_with_identity_key(path: &str, identity_key: &str) -> Result<Self, StorageError> {
        let path_key = lock_key(path);
        let operation_lock = path_lock(path);
        #[cfg(not(target_arch = "wasm32"))]
        let owner_lease = owner_lease(path, &path_key)?;
        let driver = {
            let _guard = lock(&operation_lock);
            TursoDriver::open(path)?
        };
        let mut has_bootstrap = false;
        driver.run_rows(sql::LIST_TABLES, Vec::new(), |row| {
            if text_ref_at(row, 0)? == sql::BOOTSTRAP {
                has_bootstrap = true;
            }
            Ok(())
        })?;
        if has_bootstrap {
            let bootstrap_version =
                bootstrap_i64_read(&driver, sql::BOOTSTRAP_VERSION_KEY)?.ok_or_else(|| {
                    StorageError::IncompatibleStore(
                        "bootstrap has no format version; the store was preserved".to_owned(),
                    )
                })?;
            if bootstrap_version != sql::BOOTSTRAP_VERSION {
                return Err(StorageError::IncompatibleStore(format!(
                    "unsupported bootstrap version {bootstrap_version}; the store was preserved"
                )));
            }
            let generation = bootstrap_i64_read(&driver, sql::ACTIVE_GENERATION_KEY)?
                .ok_or_else(|| {
                    StorageError::IncompatibleStore(
                        "bootstrap has no active generation; the store was preserved".to_owned(),
                    )
                })?;
            driver.generation_write(generation);
        }
        Ok(Self {
            driver,
            identity_key: MutableKey::new(identity_key.to_owned()),
            selector_key: identity_key.to_owned(),
            commit_seq_key: MutableKey::new(commit_seq_key(&path_key, identity_key)),
            path_key,
            operation_lock,
            #[cfg(not(target_arch = "wasm32"))]
            _owner_lease: owner_lease,
            tables: Mutex::new(FxHashMap::default()),
            plans: Mutex::new(FxHashMap::default()),
            clock: Mutex::new(Clock::new()),
            peer_id: Mutex::new(None),
            absent_mutations: Mutex::new(FxHashMap::default()),
        })
    }

    pub fn open_with_cached_identity_key(
        path: &str,
        selector_key: &str,
        default_identity_key: &str,
    ) -> Result<Self, StorageError> {
        let opened = Instant::now();
        let mut store = Self::open_with_identity_key(path, default_identity_key)?;
        selector_key.clone_into(&mut store.selector_key);
        let listed = Instant::now();
        let tables = store.read_tables()?;
        crate::log_open_phase("read_tables", listed);
        let cached = Instant::now();
        let meta_table = sql::generation_identifier(sql::META_TABLE, store.driver.generation());
        if tables.iter().any(|table| table == &meta_table) {
            if let Some(state) =
                store.read_meta_for_identity_unlocked(selector_key, IDENTITY_STATE_META)?
            {
                let (identity_key, identity_json): (String, Option<String>) =
                    serde_json::from_str(&state).map_err(|error| {
                        StorageError::IncompatibleStore(format!(
                            "the cached identity state is corrupt: {error}"
                        ))
                    })?;
                store.identity_write(&identity_key, identity_json.as_deref())?;
            }
        }
        crate::log_open_phase("cached_identity", cached);
        crate::log_open_phase("open_total", opened);
        Ok(store)
    }

    pub fn identity_read(&self) -> Result<(String, Option<String>), StorageError> {
        let _guard = lock(&self.operation_lock);
        let identity_key = self.identity_key.clone();
        let state = self
            .read_meta_for_identity_unlocked(&self.selector_key, IDENTITY_STATE_META)?
            .map(|state| {
                serde_json::from_str::<(String, Option<String>)>(&state).map_err(|error| {
                    StorageError::IncompatibleStore(format!(
                        "the cached identity state is corrupt: {error}"
                    ))
                })
            })
            .transpose()?;
        let identity_json = match state {
            Some((stored_key, identity)) if stored_key == identity_key => identity,
            Some(_) => {
                return Err(StorageError::IncompatibleStore(
                    "the cached identity key does not match the active partition".to_owned(),
                ))
            }
            None => None,
        };
        Ok((identity_key, identity_json))
    }

    pub fn identity_write(
        &self,
        identity_key: &str,
        identity_json: Option<&str>,
    ) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        let state = serde_json::to_string(&(identity_key, identity_json))
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        let has_origin = self.read_tables()?.iter().any(|table| table == sql::ORIGIN);
        self.transaction_unlocked(|| {
            self.write_meta_for_identity_unlocked(&self.selector_key, IDENTITY_STATE_META, &state)?;
            if has_origin {
                self.origin_write_for_identity_unlocked(
                    identity_key,
                    OriginKind::Identity,
                    self.selector_key.as_bytes(),
                    state.as_bytes(),
                )?;
            }
            Ok(())
        })?;
        if self.identity_key.clone() == identity_key {
            return Ok(());
        }
        self.identity_key.write(identity_key.to_owned());
        self.commit_seq_key
            .write(commit_seq_key(&self.path_key, identity_key));
        *lock(&self.peer_id) = None;
        lock(&self.absent_mutations).clear();
        *lock(&self.clock) = Clock::new();
        let max_commit_seq = self
            .driver
            .run_row(
                sql::max_commit_seq(),
                max_commit_seq_params(identity_key),
                |row| int_at(row, 0),
            )?
            .unwrap_or(0);
        self.reset_commit_seq_cache(max_commit_seq);
        let high = self.max_creation_time_unlocked()?;
        lock(&self.clock).observe(high);
        Ok(())
    }

    pub fn setup(&self, schema: &StoreSchema) -> Result<(), StorageError> {
        let started = Instant::now();
        let result = self.setup_inner(schema);
        crate::log_open_phase("setup", started);
        result
    }

    fn setup_inner(&self, schema: &StoreSchema) -> Result<(), StorageError> {
        validate_store_schema(schema)?;
        let current_signature = schema_signature(schema);
        let schema_manifest = serde_json::to_string(schema)
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        let _guard = lock(&self.operation_lock);
        let stored_version = self.read_user_version()?;
        let existing_tables = self.read_tables()?;
        let has_bootstrap = existing_tables.iter().any(|table| table == sql::BOOTSTRAP);
        if has_bootstrap {
            let generation = self
                .driver
                .run_row(
                    sql::READ_BOOTSTRAP,
                    vec![text_value(sql::ACTIVE_GENERATION_KEY.to_owned())],
                    |row| {
                        let bytes = blob_at(row, 0)?;
                        let text = std::str::from_utf8(&bytes).map_err(|error| {
                            StorageError::IncompatibleStore(format!(
                                "active generation is not UTF-8: {error}"
                            ))
                        })?;
                        text.parse::<i64>().map_err(|error| {
                            StorageError::IncompatibleStore(format!(
                                "active generation is invalid: {error}"
                            ))
                        })
                    },
                )?
                .ok_or_else(|| {
                    StorageError::IncompatibleStore(
                        "bootstrap has no active generation; the store was preserved".to_owned(),
                    )
                })?;
            self.driver.generation_write(generation);
        }
        if existing_tables.is_empty() {
            self.replace_store_unlocked(
                schema,
                &current_signature,
                &schema_manifest,
                stored_version,
                &existing_tables,
            )?;
            return self.activate_schema_unlocked(schema);
        }
        if stored_version != sql::EMBEDDED_EPOCH {
            return Err(StorageError::IncompatibleStore(format!(
                "unsupported store epoch {stored_version}; the existing store was preserved"
            )));
        }
        if !has_bootstrap {
            return Err(StorageError::IncompatibleStore(
                "the legacy store requires the device migration runner; the existing store was preserved"
                    .to_owned(),
            ));
        }
        let active = self
            .bootstrap_contract_read_unlocked(sql::ACTIVE_CONTRACT_KEY)?
            .ok_or_else(|| {
                StorageError::IncompatibleStore(
                    "bootstrap has no active contract; the existing store was preserved".to_owned(),
                )
            })?;
        if active != StoreContract::for_schema(schema) {
            return Err(StorageError::IncompatibleStore(
                "the store contract changed; use the device migration runner instead of direct setup"
                    .to_owned(),
            ));
        }
        self.validate_physical_schema_unlocked(schema)?;
        self.activate_schema_unlocked(schema)
    }

    fn stored_schema_signature_unlocked(
        &self,
        stored_version: i64,
        existing_tables: &[String],
    ) -> Result<Option<String>, StorageError> {
        let meta_table = sql::generation_identifier(sql::META_TABLE, self.driver.generation());
        let has_meta = existing_tables.iter().any(|name| name == &meta_table);
        if stored_version == sql::EMBEDDED_EPOCH && has_meta {
            self.read_meta_unlocked(SCHEMA_SIGNATURE_KEY)
        } else {
            Ok(None)
        }
    }

    fn stored_schema_manifest_unlocked(&self) -> Result<Option<StoreSchema>, StorageError> {
        self.read_meta_unlocked(SCHEMA_MANIFEST_KEY)?
            .map(|manifest| {
                serde_json::from_str(&manifest).map_err(|error| {
                    StorageError::IncompatibleStore(format!(
                        "the stored schema manifest is corrupt: {error}; the existing store was preserved"
                    ))
                })
            })
            .transpose()
    }

    fn replace_store_unlocked(
        &self,
        schema: &StoreSchema,
        schema_signature: &str,
        schema_manifest: &str,
        stored_version: i64,
        existing_tables: &[String],
    ) -> Result<(), StorageError> {
        let previous_generation = self.driver.generation();
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written = (|| {
            for table in existing_tables {
                self.driver.execute(&sql::drop_table(table), Vec::new())?;
            }
            self.driver.execute(sql::CREATE_BOOTSTRAP, Vec::new())?;
            self.driver.execute(sql::CREATE_ORIGIN, Vec::new())?;
            self.driver
                .execute(sql::CREATE_ORIGIN_PAYLOAD, Vec::new())?;
            self.write_bootstrap_unlocked(
                sql::BOOTSTRAP_VERSION_KEY,
                sql::BOOTSTRAP_VERSION.to_string().as_bytes(),
            )?;
            self.write_bootstrap_unlocked(sql::NEXT_GENERATION_KEY, b"2")?;
            self.driver.generation_write(1);
            self.create_system_schema_unlocked()?;
            self.create_doc_schema_unlocked(schema)?;
            self.write_meta_unlocked(SCHEMA_SIGNATURE_KEY, schema_signature)?;
            self.write_meta_unlocked(SCHEMA_MANIFEST_KEY, schema_manifest)?;
            self.write_bootstrap_unlocked(sql::ACTIVE_GENERATION_KEY, b"1")?;
            let contract = serde_json::to_vec(&StoreContract::for_schema(schema))
                .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
            self.write_bootstrap_unlocked(sql::ACTIVE_CONTRACT_KEY, &contract)?;
            if stored_version != sql::EMBEDDED_EPOCH {
                self.driver
                    .execute(&sql::write_user_version(), Vec::new())?;
            }
            Ok(())
        })();
        match written {
            Ok(()) => self.commit_transaction_unlocked()?,
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                self.driver.generation_write(previous_generation);
                return Err(combine_rollback(error, rolled));
            }
        }
        *lock(&self.peer_id) = None;
        self.reset_commit_seq_cache(0);
        self.driver.clear_statements();
        Ok(())
    }

    fn write_bootstrap_unlocked(&self, key: &str, value: &[u8]) -> Result<(), StorageError> {
        self.driver.execute(
            sql::WRITE_BOOTSTRAP,
            vec![text_value(key.to_owned()), Value::Blob(value.to_vec())],
        )
    }

    /// Writes one originated semantic record in the caller's transaction.
    fn origin_write_unlocked(
        &self,
        kind: OriginKind,
        record_key: &[u8],
        payload: &[u8],
    ) -> Result<(), StorageError> {
        self.origin_write_for_identity_unlocked(
            &self.identity_key.clone(),
            kind,
            record_key,
            payload,
        )
    }

    fn origin_write_for_identity_unlocked(
        &self,
        identity_key: &str,
        kind: OriginKind,
        record_key: &[u8],
        payload: &[u8],
    ) -> Result<(), StorageError> {
        let kind = kind as i64;
        let payload_hash = origin_hash(
            identity_key,
            kind,
            record_key,
            ORIGIN_CODEC_V1,
            ORIGIN_FLAGS_NONE,
            payload,
        );
        self.driver.execute(
            sql::WRITE_ORIGIN,
            vec![
                Value::from_i64(self.driver.generation()),
                text_value(identity_key.to_owned()),
                Value::from_i64(kind),
                Value::Blob(record_key.to_vec()),
                Value::from_i64(ORIGIN_CODEC_V1),
                Value::from_i64(ORIGIN_FLAGS_NONE),
                Value::Blob(payload.to_vec()),
                Value::Blob(payload_hash),
            ],
        )
    }

    fn origin_delete_unlocked(
        &self,
        kind: OriginKind,
        record_key: &[u8],
    ) -> Result<(), StorageError> {
        self.driver.execute(
            sql::DELETE_ORIGIN,
            vec![
                Value::from_i64(self.driver.generation()),
                text_value(self.identity_key.clone()),
                Value::from_i64(kind as i64),
                Value::Blob(record_key.to_vec()),
            ],
        )
    }

    /// Bounded frozen-ledger read used by the dedicated migration runner.
    pub fn origin_page_read(
        &self,
        generation: i64,
        after: Option<&OriginCursor>,
        page_size: usize,
    ) -> Result<OriginPage, StorageError> {
        self.origin_page_read_bounded(generation, after, None, page_size)
    }

    pub fn origin_page_read_bounded(
        &self,
        generation: i64,
        after: Option<&OriginCursor>,
        upper_bound: Option<&OriginCursor>,
        page_size: usize,
    ) -> Result<OriginPage, StorageError> {
        if page_size == 0 || page_size > READ_CAP {
            return Err(StorageError::Unsatisfiable(format!(
                "origin page size {page_size} outside 1..={READ_CAP}"
            )));
        }
        let after = after.cloned().unwrap_or_default();
        let mut records = Vec::with_capacity(page_size);
        let _guard = lock(&self.operation_lock);
        let has_snapshot = self
            .migration_progress_read_unlocked()?
            .is_some_and(|(_, progress)| progress.snapshot_complete)
            && self.bootstrap_i64_read_unlocked(sql::CANDIDATE_GENERATION_KEY)? == Some(generation);
        let (query, params) = if has_snapshot {
            (
                sql::READ_MIGRATION_SNAPSHOT,
                vec![
                    text_value(after.identity_key.clone()),
                    text_value(after.identity_key.clone()),
                    Value::from_i64(after.kind),
                    text_value(after.identity_key),
                    Value::from_i64(after.kind),
                    Value::Blob(after.record_key),
                    Value::from_i64(page_size as i64),
                ],
            )
        } else if let Some(upper) = upper_bound {
            (
                sql::READ_ORIGIN_BOUNDED,
                vec![
                    Value::from_i64(generation),
                    text_value(after.identity_key.clone()),
                    text_value(after.identity_key.clone()),
                    Value::from_i64(after.kind),
                    text_value(after.identity_key),
                    Value::from_i64(after.kind),
                    Value::Blob(after.record_key),
                    text_value(upper.identity_key.clone()),
                    text_value(upper.identity_key.clone()),
                    Value::from_i64(upper.kind),
                    text_value(upper.identity_key.clone()),
                    Value::from_i64(upper.kind),
                    Value::Blob(upper.record_key.clone()),
                    Value::from_i64(page_size as i64),
                ],
            )
        } else {
            (
                sql::READ_ORIGIN,
                vec![
                    Value::from_i64(generation),
                    text_value(after.identity_key.clone()),
                    text_value(after.identity_key.clone()),
                    Value::from_i64(after.kind),
                    text_value(after.identity_key),
                    Value::from_i64(after.kind),
                    Value::Blob(after.record_key),
                    Value::from_i64(page_size as i64),
                ],
            )
        };
        self.driver.run_rows(query, params, |row| {
            records.push(OriginRecord {
                identity_key: text_at(row, 0)?,
                kind: int_at(row, 1)?,
                record_key: blob_at(row, 2)?,
                codec: int_at(row, 3)?,
                flags: int_at(row, 4)?,
                payload: blob_at(row, 5)?,
                payload_hash: blob_at(row, 6)?,
            });
            Ok(())
        })?;
        for record in &records {
            let expected = origin_hash(
                &record.identity_key,
                record.kind,
                &record.record_key,
                record.codec,
                record.flags,
                &record.payload,
            );
            if record.payload_hash != expected {
                return Err(StorageError::IncompatibleStore(
                    "originated record checksum mismatch; the store was preserved".to_owned(),
                ));
            }
        }
        let cursor = records.last().map(|record| OriginCursor {
            identity_key: record.identity_key.clone(),
            kind: record.kind,
            record_key: record.record_key.clone(),
        });
        Ok(OriginPage { records, cursor })
    }

    fn origin_json_write_unlocked(
        &self,
        kind: OriginKind,
        record_key: &[u8],
        value: &serde_json::Value,
    ) -> Result<(), StorageError> {
        let payload = serde_json::to_vec(value)
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        self.origin_write_unlocked(kind, record_key, &payload)
    }

    fn origin_device_document_write_unlocked(&self, write: &DocWrite) -> Result<(), StorageError> {
        self.origin_json_write_unlocked(
            OriginKind::DeviceDocument,
            &origin_key(&[write.table.as_bytes(), write.id.as_bytes()]),
            &serde_json::json!({
                "table": write.table,
                "id": write.id,
                "data": write.data,
                "columns": write.cols.iter().map(|(name, value)| {
                    serde_json::json!([name, base64::encode(value.encode_key())])
                }).collect::<Vec<_>>(),
                "creationTime": write.creation_time,
            }),
        )
    }

    fn origin_local_field_write_unlocked(
        &self,
        table: &str,
        id: &str,
        field: &str,
        value: &serde_json::Value,
    ) -> Result<(), StorageError> {
        self.origin_json_write_unlocked(
            OriginKind::LocalField,
            &origin_key(&[table.as_bytes(), id.as_bytes(), field.as_bytes()]),
            &serde_json::json!({
                "table": table,
                "id": id,
                "field": field,
                "value": value,
            }),
        )
    }

    fn origin_id_mapping_write_unlocked(&self, mapping: &IdMapping) -> Result<(), StorageError> {
        self.origin_json_write_unlocked(
            OriginKind::IdMapping,
            &origin_key(&[mapping.table.as_bytes(), mapping.local_id.as_bytes()]),
            &serde_json::json!({
                "table": mapping.table,
                "localId": mapping.local_id,
                "state": mapping.mapping.as_str(),
                "convexId": mapping.convex_id(),
                "createdTime": mapping.created_time,
                "updatedTime": mapping.updated_time,
            }),
        )
    }

    fn origin_schedule_write_unlocked(&self, job: &ScheduledJob) -> Result<(), StorageError> {
        self.origin_json_write_unlocked(
            OriginKind::Schedule,
            job.job_id.as_bytes(),
            &serde_json::json!({
                "jobId": job.job_id,
                "kind": job.kind.as_str(),
                "name": job.name,
                "args": job.args,
                "dueTime": job.due_time,
                "state": job.state.as_str(),
                "leaseUntil": job.state.lease_until(),
                "createdTime": job.created_time,
                "updatedTime": job.updated_time,
            }),
        )
    }

    fn origin_upload_write_unlocked(&self, upload: &PendingUpload) -> Result<(), StorageError> {
        self.origin_json_write_unlocked(
            OriginKind::Upload,
            upload.local_storage_id.as_bytes(),
            &serde_json::json!({
                "localStorageId": upload.local_storage_id,
                "sha256": upload.sha256,
                "size": upload.size,
                "contentType": upload.content_type,
                "lease": upload.lease.as_str(),
                "owner": upload.lease.owner(),
                "leaseUntil": upload.lease.lease_until(),
                "createdTime": upload.created_time,
                "updatedTime": upload.updated_time,
            }),
        )
    }

    fn origin_revision_write_unlocked(&self, state: &RevState) -> Result<(), StorageError> {
        let snapshot_hash = self.origin_payload_write_unlocked(&state.snapshot)?;
        let log_hashes = state
            .log
            .iter()
            .map(|delta| self.origin_payload_write_unlocked(delta))
            .collect::<Result<Vec<_>, _>>()?;
        let archived = state.lifecycle.archived();
        self.origin_json_write_unlocked(
            OriginKind::Revision,
            &origin_key(&[
                state.key.row.table.as_bytes(),
                state.key.row.document_id.as_bytes(),
                state.key.rev_id.as_bytes(),
            ]),
            &serde_json::json!({
                "table": state.key.row.table,
                "id": state.key.row.document_id,
                "revId": state.key.rev_id,
                "frontier": base64::encode(&state.frontier),
                "snapshotHash": base64::encode(snapshot_hash),
                "logHashes": log_hashes.into_iter().map(base64::encode).collect::<Vec<_>>(),
                "lifecycle": state.lifecycle.as_str(),
                "parent": archived.map(|value| value.parent.as_str()),
                "serverRevId": archived.and_then(|value| value.server_rev_id.as_deref()),
                "serverRootId": archived.and_then(|value| value.server_root_id.as_deref()),
                "serverNodeId": archived.and_then(|value| value.server_node_id.as_deref()),
                "baseRootId": archived.and_then(|value| value.base_root_id.as_deref()),
                "baseNodeId": archived.and_then(|value| value.base_node_id.as_deref()),
                "updatedTime": state.updated_time,
            }),
        )
    }

    fn origin_blob_write_unlocked(&self, input: &FileStore) -> Result<(), StorageError> {
        let bytes_hash = self.origin_payload_write_unlocked(&input.bytes)?;
        self.origin_json_write_unlocked(
            OriginKind::Blob,
            input.metadata.storage_id.as_bytes(),
            &serde_json::json!({
                "storageId": input.metadata.storage_id,
                "sha256": input.metadata.sha256,
                "size": input.metadata.size,
                "contentType": input.metadata.content_type,
                "source": input.metadata.source,
                "createdTime": input.metadata.created_time,
                "updatedTime": input.metadata.updated_time,
                "bytesHash": base64::encode(bytes_hash),
            }),
        )
    }

    fn origin_mutation_write_unlocked(
        &self,
        call: &MutationCall,
        status: MutationStatus,
        result: Option<&str>,
        error: Option<&str>,
        commit_seq: Option<i64>,
    ) -> Result<(), StorageError> {
        self.origin_json_write_unlocked(
            OriginKind::Mutation,
            call.mutation_id.as_bytes(),
            &serde_json::json!({
                "mutationId": call.mutation_id,
                "name": call.name,
                "args": call.args,
                "status": status.as_str(),
                "result": result,
                "error": error,
                "commitSeq": commit_seq,
            }),
        )
    }

    fn origin_committed_mutation_write_unlocked(
        &self,
        options: &CommitOptions,
        result: &CommitResult,
    ) -> Result<(), StorageError> {
        let Some(mutation_id) = options.mutation_id() else {
            return Ok(());
        };
        let call = self.mutation_call_unlocked(mutation_id)?.ok_or_else(|| {
            StorageError::Unsatisfiable("committed mutation call missing".to_owned())
        })?;
        self.origin_mutation_write_unlocked(
            &call,
            MutationStatus::Committed,
            options.mutation_result(),
            None,
            Some(result.commit_seq),
        )
    }

    fn origin_payload_write_unlocked(&self, bytes: &[u8]) -> Result<Vec<u8>, StorageError> {
        let hash = Sha256::digest(bytes).to_vec();
        self.driver.execute(
            sql::WRITE_ORIGIN_PAYLOAD,
            vec![Value::Blob(hash.clone()), Value::Blob(bytes.to_vec())],
        )?;
        Ok(hash)
    }

    pub fn origin_payload_read(&self, hash: &[u8]) -> Result<Option<Vec<u8>>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.origin_payload_read_unlocked(hash)
    }

    fn bootstrap_read_unlocked(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        self.driver.run_row(
            sql::READ_BOOTSTRAP,
            vec![text_value(key.to_owned())],
            |row| blob_at(row, 0),
        )
    }

    fn bootstrap_i64_read_unlocked(&self, key: &str) -> Result<Option<i64>, StorageError> {
        self.bootstrap_read_unlocked(key)?
            .map(|bytes| {
                std::str::from_utf8(&bytes)
                    .map_err(|error| {
                        StorageError::IncompatibleStore(format!(
                            "bootstrap {key} is not UTF-8: {error}"
                        ))
                    })?
                    .parse::<i64>()
                    .map_err(|error| {
                        StorageError::IncompatibleStore(format!(
                            "bootstrap {key} is not an integer: {error}"
                        ))
                    })
            })
            .transpose()
    }

    fn bootstrap_contract_read_unlocked(
        &self,
        key: &str,
    ) -> Result<Option<StoreContract>, StorageError> {
        self.bootstrap_read_unlocked(key)?
            .map(|bytes| {
                serde_json::from_slice(&bytes).map_err(|error| {
                    StorageError::IncompatibleStore(format!(
                        "bootstrap {key} contract is corrupt: {error}"
                    ))
                })
            })
            .transpose()
    }

    /// Seed the frozen originated ledger from the only generation-zero layout
    /// that existed before the ledger was introduced.
    ///
    /// This is intentionally a one-time adapter. Once the bootstrap table is
    /// present, all later releases locate originated state exclusively through
    /// the frozen ledger rather than through old application tables.
    fn legacy_seed_unlocked(
        &self,
        stored_version: i64,
        existing_tables: &[String],
    ) -> Result<(), StorageError> {
        if stored_version != sql::EMBEDDED_EPOCH {
            return Err(StorageError::IncompatibleStore(format!(
                "unsupported legacy store epoch {stored_version}; the store was preserved"
            )));
        }
        if !existing_tables.iter().any(|table| table == sql::META_TABLE) {
            return Err(StorageError::IncompatibleStore(
                "legacy store has no schema manifest table; the store was preserved".to_owned(),
            ));
        }
        self.driver.generation_write(0);
        let schema = self.stored_schema_manifest_unlocked()?.ok_or_else(|| {
            StorageError::IncompatibleStore(
                "legacy store has no schema manifest; the store was preserved".to_owned(),
            )
        })?;
        let stored_signature = self
            .stored_schema_signature_unlocked(stored_version, existing_tables)?
            .ok_or_else(|| {
                StorageError::IncompatibleStore(
                    "legacy store has no schema signature; the store was preserved".to_owned(),
                )
            })?;
        if schema_signature(&schema) != stored_signature {
            return Err(StorageError::IncompatibleStore(
                "legacy schema manifest does not match its signature; the store was preserved"
                    .to_owned(),
            ));
        }

        let (records, payloads) = self.legacy_origin_records_read_unlocked(&schema)?;
        let mut contract = StoreContract::for_schema(&schema);
        contract.core_layout_hash = hex(&Sha256::digest(b"generation-zero-layout"));
        let contract = serde_json::to_vec(&contract)
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;

        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let seeded = (|| {
            self.driver.execute(sql::CREATE_BOOTSTRAP, Vec::new())?;
            self.driver.execute(sql::CREATE_ORIGIN, Vec::new())?;
            self.driver
                .execute(sql::CREATE_ORIGIN_PAYLOAD, Vec::new())?;
            self.write_bootstrap_unlocked(
                sql::BOOTSTRAP_VERSION_KEY,
                sql::BOOTSTRAP_VERSION.to_string().as_bytes(),
            )?;
            self.write_bootstrap_unlocked(sql::ACTIVE_GENERATION_KEY, b"0")?;
            self.write_bootstrap_unlocked(sql::NEXT_GENERATION_KEY, b"1")?;
            self.write_bootstrap_unlocked(sql::ACTIVE_CONTRACT_KEY, &contract)?;
            for (hash, bytes) in payloads {
                self.driver.execute(
                    sql::WRITE_ORIGIN_PAYLOAD,
                    vec![Value::Blob(hash), Value::Blob(bytes)],
                )?;
            }
            for record in records {
                self.origin_write_for_identity_unlocked(
                    &record.identity_key,
                    record.kind,
                    &record.record_key,
                    &record.payload,
                )?;
            }
            Ok(())
        })();
        match seeded {
            Ok(()) => self.commit_transaction_unlocked(),
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(error, rolled))
            }
        }
    }

    #[allow(clippy::too_many_lines)]
    #[allow(clippy::type_complexity)]
    fn legacy_origin_records_read_unlocked(
        &self,
        schema: &StoreSchema,
    ) -> Result<(Vec<LegacyOriginSeed>, Vec<(Vec<u8>, Vec<u8>)>), StorageError> {
        let mut records = Vec::new();
        let mut payloads = Vec::new();

        self.driver.run_rows(
            "SELECT identity_key, value FROM __embedded_meta \
             WHERE key = 'identity_state' ORDER BY identity_key",
            Vec::new(),
            |row| {
                let selector = text_at(row, 0)?;
                let state = text_at(row, 1)?;
                let (identity_key, _): (String, Option<String>) = serde_json::from_str(&state)
                    .map_err(|error| {
                        StorageError::IncompatibleStore(format!(
                            "legacy identity state is corrupt: {error}"
                        ))
                    })?;
                records.push(legacy_origin_seed(
                    identity_key,
                    OriginKind::Identity,
                    selector.into_bytes(),
                    state.into_bytes(),
                ));
                Ok(())
            },
        )?;

        for table in schema
            .tables
            .iter()
            .filter(|table| table.placement == TablePlacement::Device)
        {
            self.driver
                .run_rows(&sql::read_legacy_doc_rows(table)?, Vec::new(), |row| {
                    let identity_key = text_at(row, 0)?;
                    let id = text_at(row, 1)?;
                    let creation_time = real_at(row, 2)?;
                    let data = text_at(row, 3)?;
                    let mut columns = Vec::with_capacity(table.columns.len());
                    for (index, column) in table.columns.iter().enumerate() {
                        columns.push(serde_json::json!([
                            column.name,
                            base64::encode(blob_at(row, index + 4)?)
                        ]));
                    }
                    records.push(legacy_json_seed(
                        identity_key,
                        OriginKind::DeviceDocument,
                        origin_key(&[table.name.as_bytes(), id.as_bytes()]),
                        serde_json::json!({
                            "table": table.name,
                            "id": id,
                            "data": data,
                            "columns": columns,
                            "creationTime": creation_time,
                        }),
                    )?);
                    Ok(())
                })?;
        }

        self.driver.run_rows(
            "SELECT identity_key, table_name, document_id, field, value_json \
             FROM __embedded_local_fields ORDER BY identity_key, table_name, document_id, field",
            Vec::new(),
            |row| {
                let identity_key = text_at(row, 0)?;
                let table = text_at(row, 1)?;
                let id = text_at(row, 2)?;
                let field = text_at(row, 3)?;
                let value: serde_json::Value =
                    serde_json::from_str(&text_at(row, 4)?).map_err(|error| {
                        StorageError::Decode {
                            expected: "legacy local field JSON",
                            index: 4,
                            got: error.to_string(),
                        }
                    })?;
                records.push(legacy_json_seed(
                    identity_key,
                    OriginKind::LocalField,
                    origin_key(&[table.as_bytes(), id.as_bytes(), field.as_bytes()]),
                    serde_json::json!({
                        "table": table,
                        "id": id,
                        "field": field,
                        "value": value,
                    }),
                )?);
                Ok(())
            },
        )?;

        self.driver.run_rows(
            "SELECT identity_key, mutation_id, name, args, status, result, error, commit_seq \
             FROM __embedded_mutations ORDER BY identity_key, mutation_id",
            Vec::new(),
            |row| {
                let identity_key = text_at(row, 0)?;
                let mutation_id = text_at(row, 1)?;
                records.push(legacy_json_seed(
                    identity_key,
                    OriginKind::Mutation,
                    mutation_id.as_bytes().to_vec(),
                    serde_json::json!({
                        "mutationId": mutation_id,
                        "name": text_at(row, 2)?,
                        "args": text_at(row, 3)?,
                        "status": text_at(row, 4)?,
                        "result": optional_text_at(row, 5)?,
                        "error": optional_text_at(row, 6)?,
                        "commitSeq": optional_int_at(row, 7)?,
                    }),
                )?);
                Ok(())
            },
        )?;

        self.driver.run_rows(
            "SELECT identity_key, watermark, commit_seq, cursor FROM __embedded_remote \
             WHERE cursor IS NOT NULL AND \
             (watermark >= 'push_envelope:' AND watermark < 'push_envelope;' OR \
              watermark >= 'settlement_ack:' AND watermark < 'settlement_ack;') \
             ORDER BY identity_key, watermark",
            Vec::new(),
            |row| {
                let identity_key = text_at(row, 0)?;
                let watermark = text_at(row, 1)?;
                let commit_seq = int_at(row, 2)?;
                let cursor = text_at(row, 3)?;
                if let Some(mutation_id) = watermark.strip_prefix(REMOTE_PUSH_ENVELOPE_PREFIX) {
                    records.push(legacy_origin_seed(
                        identity_key,
                        OriginKind::PushEnvelope,
                        mutation_id.as_bytes().to_vec(),
                        cursor.into_bytes(),
                    ));
                } else if let Some(replay_id) = watermark.strip_prefix(REMOTE_RECEIPT_PREFIX) {
                    records.push(legacy_json_seed(
                        identity_key,
                        OriginKind::SettlementReceipt,
                        replay_id.as_bytes().to_vec(),
                        serde_json::json!({
                            "replayId": replay_id,
                            "mutationId": replay_id,
                            "commitSeq": commit_seq,
                        }),
                    )?);
                }
                Ok(())
            },
        )?;

        self.legacy_schedule_records_read_unlocked(&mut records)?;
        self.legacy_upload_records_read_unlocked(&mut records)?;
        self.legacy_blob_records_read_unlocked(&mut records, &mut payloads)?;
        self.legacy_revision_records_read_unlocked(&mut records, &mut payloads)?;
        self.legacy_crdt_records_read_unlocked(&mut records, &mut payloads)?;
        self.legacy_id_mapping_records_read_unlocked(&mut records)?;
        Ok((records, payloads))
    }

    fn legacy_schedule_records_read_unlocked(
        &self,
        records: &mut Vec<LegacyOriginSeed>,
    ) -> Result<(), StorageError> {
        self.driver.run_rows(
            "SELECT identity_key, job_id, kind, name, args, due_time_ms, state, \
             lease_until_ms, created_time_ms, updated_time_ms \
             FROM __embedded_schedules ORDER BY identity_key, job_id",
            Vec::new(),
            |row| {
                let identity_key = text_at(row, 0)?;
                let job_id = text_at(row, 1)?;
                records.push(legacy_json_seed(
                    identity_key,
                    OriginKind::Schedule,
                    job_id.as_bytes().to_vec(),
                    serde_json::json!({
                        "jobId": job_id,
                        "kind": text_at(row, 2)?,
                        "name": text_at(row, 3)?,
                        "args": text_at(row, 4)?,
                        "dueTime": int_at(row, 5)?,
                        "state": text_at(row, 6)?,
                        "leaseUntil": optional_int_at(row, 7)?,
                        "createdTime": int_at(row, 8)?,
                        "updatedTime": int_at(row, 9)?,
                    }),
                )?);
                Ok(())
            },
        )
    }

    fn legacy_upload_records_read_unlocked(
        &self,
        records: &mut Vec<LegacyOriginSeed>,
    ) -> Result<(), StorageError> {
        self.driver.run_rows(
            "SELECT identity_key, local_storage_id, sha256, size, content_type, state, owner, \
             lease_until_ms, created_time_ms, updated_time_ms \
             FROM __embedded_uploads ORDER BY identity_key, local_storage_id",
            Vec::new(),
            |row| {
                let identity_key = text_at(row, 0)?;
                let local_storage_id = text_at(row, 1)?;
                records.push(legacy_json_seed(
                    identity_key,
                    OriginKind::Upload,
                    local_storage_id.as_bytes().to_vec(),
                    serde_json::json!({
                        "localStorageId": local_storage_id,
                        "sha256": text_at(row, 2)?,
                        "size": int_at(row, 3)?,
                        "contentType": optional_text_at(row, 4)?,
                        "lease": text_at(row, 5)?,
                        "owner": optional_text_at(row, 6)?,
                        "leaseUntil": optional_int_at(row, 7)?,
                        "createdTime": int_at(row, 8)?,
                        "updatedTime": int_at(row, 9)?,
                    }),
                )?);
                Ok(())
            },
        )
    }

    fn legacy_blob_records_read_unlocked(
        &self,
        records: &mut Vec<LegacyOriginSeed>,
        payloads: &mut Vec<(Vec<u8>, Vec<u8>)>,
    ) -> Result<(), StorageError> {
        self.driver.run_rows(
            "SELECT file.identity_key, file.local_storage_id, file.sha256, file.size, \
             file.content_type, file.source, file.created_time_ms, file.updated_time_ms, blob.bytes \
             FROM __embedded_files AS file \
             JOIN __embedded_blobs AS blob \
             ON blob.identity_key = file.identity_key AND blob.key = file.local_storage_id \
             ORDER BY file.identity_key, file.local_storage_id",
            Vec::new(),
            |row| {
                let identity_key = text_at(row, 0)?;
                let storage_id = text_at(row, 1)?;
                let bytes = blob_at(row, 8)?;
                let bytes_hash = Sha256::digest(&bytes).to_vec();
                payloads.push((bytes_hash.clone(), bytes));
                records.push(legacy_json_seed(
                    identity_key,
                    OriginKind::Blob,
                    storage_id.as_bytes().to_vec(),
                    serde_json::json!({
                        "storageId": storage_id,
                        "sha256": text_at(row, 2)?,
                        "size": int_at(row, 3)?,
                        "contentType": optional_text_at(row, 4)?,
                        "source": optional_text_at(row, 5)?,
                        "createdTime": int_at(row, 6)?,
                        "updatedTime": int_at(row, 7)?,
                        "bytesHash": base64::encode(bytes_hash),
                    }),
                )?);
                Ok(())
            },
        )
    }

    fn legacy_revision_records_read_unlocked(
        &self,
        records: &mut Vec<LegacyOriginSeed>,
        payloads: &mut Vec<(Vec<u8>, Vec<u8>)>,
    ) -> Result<(), StorageError> {
        let mut revisions = Vec::new();
        self.driver.run_rows(
            "SELECT identity_key, table_name, document_id, rev_id, snapshot, frontier, status, \
             parent, server_rev_id, rev_root_id, rev_node_id, base_root_id, base_node_id, \
             updated_time_ms FROM __embedded_revs \
             ORDER BY identity_key, table_name, document_id, rev_id",
            Vec::new(),
            |row| {
                revisions.push((
                    text_at(row, 0)?,
                    RevState {
                        key: RevKey {
                            row: RowKey {
                                table: text_at(row, 1)?,
                                document_id: text_at(row, 2)?,
                            },
                            rev_id: text_at(row, 3)?,
                        },
                        snapshot: blob_at(row, 4)?,
                        frontier: blob_at(row, 5)?,
                        lifecycle: rev_lifecycle_at(row, 6)?,
                        log: Vec::new(),
                        updated_time: int_at(row, 13)?,
                    },
                ));
                Ok(())
            },
        )?;
        for (identity_key, mut state) in revisions {
            self.driver.run_rows(
                "SELECT bytes FROM __embedded_rev_log \
                 WHERE identity_key = ? AND table_name = ? AND document_id = ? AND rev_id = ? \
                 ORDER BY seq",
                vec![
                    text_value(identity_key.clone()),
                    text_value(state.key.row.table.clone()),
                    text_value(state.key.row.document_id.clone()),
                    text_value(state.key.rev_id.clone()),
                ],
                |row| {
                    state.log.push(blob_at(row, 0)?);
                    Ok(())
                },
            )?;
            let snapshot_hash = Sha256::digest(&state.snapshot).to_vec();
            payloads.push((snapshot_hash.clone(), state.snapshot.clone()));
            let mut log_hashes = Vec::with_capacity(state.log.len());
            for delta in &state.log {
                let hash = Sha256::digest(delta).to_vec();
                payloads.push((hash.clone(), delta.clone()));
                log_hashes.push(base64::encode(hash));
            }
            let archived = state.lifecycle.archived();
            records.push(legacy_json_seed(
                identity_key,
                OriginKind::Revision,
                origin_key(&[
                    state.key.row.table.as_bytes(),
                    state.key.row.document_id.as_bytes(),
                    state.key.rev_id.as_bytes(),
                ]),
                serde_json::json!({
                    "table": state.key.row.table,
                    "id": state.key.row.document_id,
                    "revId": state.key.rev_id,
                    "frontier": base64::encode(&state.frontier),
                    "snapshotHash": base64::encode(snapshot_hash),
                    "logHashes": log_hashes,
                    "lifecycle": state.lifecycle.as_str(),
                    "parent": archived.map(|value| value.parent.as_str()),
                    "serverRevId": archived.and_then(|value| value.server_rev_id.as_deref()),
                    "serverRootId": archived.and_then(|value| value.server_root_id.as_deref()),
                    "serverNodeId": archived.and_then(|value| value.server_node_id.as_deref()),
                    "baseRootId": archived.and_then(|value| value.base_root_id.as_deref()),
                    "baseNodeId": archived.and_then(|value| value.base_node_id.as_deref()),
                    "updatedTime": state.updated_time,
                }),
            )?);
        }
        Ok(())
    }

    fn legacy_crdt_records_read_unlocked(
        &self,
        records: &mut Vec<LegacyOriginSeed>,
        payloads: &mut Vec<(Vec<u8>, Vec<u8>)>,
    ) -> Result<(), StorageError> {
        self.driver.run_rows(
            "SELECT op.identity_key, op.table_name, op.document_id, op.commit_seq, op.field, \
             field.kind, field.bytes \
             FROM __embedded_crdt_ops AS op \
             JOIN __embedded_crdt_field AS field \
             ON field.identity_key = op.identity_key AND field.table_name = op.table_name \
             AND field.document_id = op.document_id AND field.field = op.field \
             ORDER BY op.identity_key, op.commit_seq, op.ordinal",
            Vec::new(),
            |row| {
                let identity_key = text_at(row, 0)?;
                let table = text_at(row, 1)?;
                let id = text_at(row, 2)?;
                let commit_seq = int_at(row, 3)?;
                let field = text_at(row, 4)?;
                let state = blob_at(row, 6)?;
                let state_hash = Sha256::digest(&state).to_vec();
                payloads.push((state_hash.clone(), state));
                records.push(legacy_json_seed(
                    identity_key,
                    OriginKind::CrdtEffect,
                    origin_key(&[
                        commit_seq.to_be_bytes().as_slice(),
                        table.as_bytes(),
                        id.as_bytes(),
                        field.as_bytes(),
                    ]),
                    serde_json::json!({
                        "commitSeq": commit_seq,
                        "table": table,
                        "id": id,
                        "field": field,
                        "kind": text_at(row, 5)?,
                        "stateHash": base64::encode(state_hash),
                        "update": "",
                        "checkpoint": null,
                    }),
                )?);
                Ok(())
            },
        )
    }

    fn legacy_id_mapping_records_read_unlocked(
        &self,
        records: &mut Vec<LegacyOriginSeed>,
    ) -> Result<(), StorageError> {
        self.driver.run_rows(
            "SELECT identity_key, table_name, local_id, convex_id, state, \
             created_time_ms, updated_time_ms FROM __embedded_id_mappings \
             ORDER BY identity_key, table_name, local_id",
            Vec::new(),
            |row| {
                let identity_key = text_at(row, 0)?;
                let table = text_at(row, 1)?;
                let local_id = text_at(row, 2)?;
                records.push(legacy_json_seed(
                    identity_key,
                    OriginKind::IdMapping,
                    origin_key(&[table.as_bytes(), local_id.as_bytes()]),
                    serde_json::json!({
                        "table": table,
                        "localId": local_id,
                        "convexId": optional_text_at(row, 3)?,
                        "state": text_at(row, 4)?,
                        "createdTime": int_at(row, 5)?,
                        "updatedTime": int_at(row, 6)?,
                    }),
                )?);
                Ok(())
            },
        )
    }

    /// Create or resume an isolated generation carrying the active originated ledger.
    #[allow(clippy::too_many_lines)]
    pub fn migration_begin(
        &self,
        schema: &StoreSchema,
    ) -> Result<MigrationCandidate, StorageError> {
        validate_store_schema(schema)?;
        let target = StoreContract::for_schema(schema);
        let target_contract_hash = target
            .hash()
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        let _guard = lock(&self.operation_lock);
        let existing_tables = self.read_tables()?;
        if existing_tables.is_empty() {
            let stored_version = self.read_user_version()?;
            let signature = schema_signature(schema);
            let manifest = serde_json::to_string(schema)
                .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
            self.replace_store_unlocked(
                schema,
                &signature,
                &manifest,
                stored_version,
                &existing_tables,
            )?;
            self.validate_physical_schema_unlocked(schema)?;
            self.activate_schema_unlocked(schema)?;
            return Ok(MigrationCandidate {
                active_generation: self.driver.generation(),
                candidate_generation: self.driver.generation(),
                source_contract_hash: target_contract_hash.clone(),
                target_contract_hash,
                retired_generations: Vec::new(),
                applied_migrations: schema.migrations.len(),
                required: false,
                resumed: false,
                progress_migration_id: None,
                progress_cursor: None,
            });
        }
        if !existing_tables.iter().any(|table| table == sql::BOOTSTRAP) {
            let stored_version = self.read_user_version()?;
            self.legacy_seed_unlocked(stored_version, &existing_tables)?;
        }
        let resolved_generation = self
            .bootstrap_i64_read_unlocked(sql::ACTIVE_GENERATION_KEY)?
            .ok_or_else(|| {
                StorageError::IncompatibleStore(
                    "bootstrap has no active generation; the store was preserved".to_owned(),
                )
            })?;
        self.driver.generation_write(resolved_generation);
        let active_generation = self.driver.generation();
        let retired_generations = self.retired_generations_read_unlocked()?;
        let active = self
            .bootstrap_contract_read_unlocked(sql::ACTIVE_CONTRACT_KEY)?
            .unwrap_or_else(|| target.clone());
        let source_contract_hash = active
            .hash()
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        if active == target {
            self.validate_physical_schema_unlocked(schema)?;
            self.activate_schema_unlocked(schema)?;
            return Ok(MigrationCandidate {
                active_generation,
                candidate_generation: active_generation,
                source_contract_hash,
                target_contract_hash,
                retired_generations,
                applied_migrations: active.migrations.len(),
                required: false,
                resumed: false,
                progress_migration_id: None,
                progress_cursor: None,
            });
        }
        if target.package_epoch < active.package_epoch {
            return Err(StorageError::IncompatibleStore(format!(
                "store contract epoch {} is newer than runtime epoch {}; the store was preserved",
                active.package_epoch, target.package_epoch
            )));
        }
        if active_generation != 0
            && (target.core_layout_hash != active.core_layout_hash
                || target.codec_set_hash != active.codec_set_hash)
            && target.package_epoch <= active.package_epoch
        {
            return Err(StorageError::IncompatibleStore(
                "the core layout or codec contract changed without advancing the package epoch; the store was preserved"
                    .to_owned(),
            ));
        }
        if !target.has_migration_prefix(&active) {
            return Err(StorageError::IncompatibleStore(
                "MigrationHistoryDiverged: the active migration manifest is not a prefix of the target"
                    .to_owned(),
            ));
        }
        let target_json = serde_json::to_vec(&target)
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        let resume = self
            .bootstrap_i64_read_unlocked(sql::CANDIDATE_GENERATION_KEY)?
            .zip(self.bootstrap_i64_read_unlocked(sql::CANDIDATE_SOURCE_KEY)?)
            .filter(|(_, source)| *source == active_generation)
            .filter(|_| {
                self.bootstrap_read_unlocked(sql::CANDIDATE_CONTRACT_KEY)
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some(target_json.as_slice())
            })
            .filter(|_| {
                self.bootstrap_read_unlocked(sql::CANDIDATE_CODE_HASH_KEY)
                    .ok()
                    .flatten()
                    .as_deref()
                    == Some(schema.migration_code_hash.as_bytes())
            });
        if let Some((candidate_generation, _)) = resume {
            self.candidate_origin_copy_unlocked(active_generation, candidate_generation)?;
            let applied_migrations = self
                .bootstrap_i64_read_unlocked(sql::CANDIDATE_APPLIED_KEY)?
                .and_then(|value| usize::try_from(value).ok())
                .unwrap_or(active.migrations.len());
            let progress = self.migration_progress_read_unlocked()?;
            return Ok(MigrationCandidate {
                active_generation,
                candidate_generation,
                source_contract_hash,
                target_contract_hash,
                retired_generations,
                applied_migrations,
                required: true,
                resumed: true,
                progress_migration_id: progress.as_ref().map(|(id, _)| id.clone()),
                progress_cursor: progress.and_then(|(_, progress)| progress.cursor),
            });
        }

        let stale_candidate = self.bootstrap_i64_read_unlocked(sql::CANDIDATE_GENERATION_KEY)?;
        let candidate_generation = self
            .bootstrap_i64_read_unlocked(sql::NEXT_GENERATION_KEY)?
            .unwrap_or_else(|| active_generation.saturating_add(1));
        if stale_candidate == Some(active_generation) || candidate_generation <= active_generation {
            return Err(StorageError::IncompatibleStore(
                "candidate generation metadata is not ahead of the active generation; the store was preserved"
                    .to_owned(),
            ));
        }
        let schema_manifest = serde_json::to_string(schema)
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        let previous_generation = self.driver.generation();
        if let Some(stale) = stale_candidate {
            self.generation_cleanup_unlocked(stale)?;
        }
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written = (|| {
            self.driver.generation_write(candidate_generation);
            self.create_system_schema_unlocked()?;
            self.create_doc_schema_unlocked(schema)?;
            self.write_meta_unlocked(SCHEMA_SIGNATURE_KEY, &schema.hash)?;
            self.write_meta_unlocked(SCHEMA_MANIFEST_KEY, &schema_manifest)?;
            self.write_bootstrap_unlocked(
                sql::CANDIDATE_GENERATION_KEY,
                candidate_generation.to_string().as_bytes(),
            )?;
            self.write_bootstrap_unlocked(
                sql::CANDIDATE_SOURCE_KEY,
                active_generation.to_string().as_bytes(),
            )?;
            self.write_bootstrap_unlocked(sql::CANDIDATE_CONTRACT_KEY, &target_json)?;
            self.write_bootstrap_unlocked(
                sql::CANDIDATE_CODE_HASH_KEY,
                schema.migration_code_hash.as_bytes(),
            )?;
            self.write_bootstrap_unlocked(sql::CANDIDATE_STATE_KEY, b"created")?;
            self.write_bootstrap_unlocked(
                sql::CANDIDATE_APPLIED_KEY,
                active.migrations.len().to_string().as_bytes(),
            )?;
            self.driver.execute(
                sql::DELETE_BOOTSTRAP,
                vec![text_value(sql::CANDIDATE_PROGRESS_KEY.to_owned())],
            )?;
            self.driver.execute(
                sql::DELETE_BOOTSTRAP,
                vec![text_value(sql::CANDIDATE_COPY_CURSOR_KEY.to_owned())],
            )?;
            self.driver.execute(
                sql::DELETE_BOOTSTRAP,
                vec![text_value(sql::CANDIDATE_MATERIALIZE_CURSOR_KEY.to_owned())],
            )?;
            self.write_bootstrap_unlocked(
                sql::NEXT_GENERATION_KEY,
                candidate_generation
                    .saturating_add(1)
                    .to_string()
                    .as_bytes(),
            )?;
            Ok(())
        })();
        self.driver.generation_write(previous_generation);
        match written {
            Ok(()) => self.commit_transaction_unlocked()?,
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                return Err(combine_rollback(error, rolled));
            }
        }
        self.candidate_origin_copy_unlocked(active_generation, candidate_generation)?;
        Ok(MigrationCandidate {
            active_generation,
            candidate_generation,
            source_contract_hash,
            target_contract_hash,
            retired_generations,
            applied_migrations: active.migrations.len(),
            required: true,
            resumed: false,
            progress_migration_id: None,
            progress_cursor: None,
        })
    }

    fn candidate_origin_copy_unlocked(
        &self,
        source_generation: i64,
        candidate_generation: i64,
    ) -> Result<(), StorageError> {
        if self
            .bootstrap_read_unlocked(sql::CANDIDATE_STATE_KEY)?
            .as_deref()
            == Some(b"copied")
        {
            return Ok(());
        }
        let mut cursor = self
            .bootstrap_read_unlocked(sql::CANDIDATE_COPY_CURSOR_KEY)?
            .map(|bytes| -> Result<OriginCursor, StorageError> {
                let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
                    StorageError::IncompatibleStore(format!(
                        "candidate copy cursor is corrupt: {error}"
                    ))
                })?;
                Ok(OriginCursor {
                    identity_key: json_str(&value, "identityKey")?.to_owned(),
                    kind: json_i64(&value, "kind")?,
                    record_key: decode_base64_field(&value, "recordKey")?,
                })
            })
            .transpose()?
            .unwrap_or_default();
        loop {
            let mut page = Vec::with_capacity(512);
            self.driver.run_rows(
                sql::READ_ORIGIN,
                vec![
                    Value::from_i64(source_generation),
                    text_value(cursor.identity_key.clone()),
                    text_value(cursor.identity_key.clone()),
                    Value::from_i64(cursor.kind),
                    text_value(cursor.identity_key.clone()),
                    Value::from_i64(cursor.kind),
                    Value::Blob(cursor.record_key.clone()),
                    Value::from_i64(512),
                ],
                |row| {
                    page.push(OriginRecord {
                        identity_key: text_at(row, 0)?,
                        kind: int_at(row, 1)?,
                        record_key: blob_at(row, 2)?,
                        codec: int_at(row, 3)?,
                        flags: int_at(row, 4)?,
                        payload: blob_at(row, 5)?,
                        payload_hash: blob_at(row, 6)?,
                    });
                    Ok(())
                },
            )?;
            if page.is_empty() {
                self.transaction_unlocked(|| {
                    self.write_bootstrap_unlocked(sql::CANDIDATE_STATE_KEY, b"copied")?;
                    self.driver.execute(
                        sql::DELETE_BOOTSTRAP,
                        vec![text_value(sql::CANDIDATE_COPY_CURSOR_KEY.to_owned())],
                    )
                })?;
                return Ok(());
            }
            let next = page.last().map(|record| OriginCursor {
                identity_key: record.identity_key.clone(),
                kind: record.kind,
                record_key: record.record_key.clone(),
            });
            let encoded = serde_json::to_vec(
                &next
                    .as_ref()
                    .map(origin_cursor_json)
                    .expect("non-empty candidate copy page"),
            )
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
            self.transaction_unlocked(|| {
                for record in &page {
                    self.driver.execute(
                        sql::WRITE_ORIGIN,
                        vec![
                            Value::from_i64(candidate_generation),
                            text_value(record.identity_key.clone()),
                            Value::from_i64(record.kind),
                            Value::Blob(record.record_key.clone()),
                            Value::from_i64(record.codec),
                            Value::from_i64(record.flags),
                            Value::Blob(record.payload.clone()),
                            Value::Blob(record.payload_hash.clone()),
                        ],
                    )?;
                }
                self.write_bootstrap_unlocked(sql::CANDIDATE_COPY_CURSOR_KEY, &encoded)
            })?;
            cursor = next.expect("non-empty candidate copy page");
        }
    }

    fn generation_cleanup_unlocked(&self, generation: i64) -> Result<(), StorageError> {
        loop {
            let deleted = self.transaction_unlocked(|| {
                self.driver.execute(
                    sql::DELETE_ORIGIN_GENERATION_PAGE,
                    vec![Value::from_i64(generation)],
                )?;
                Ok(self.driver.changes())
            })?;
            if deleted == 0 {
                break;
            }
        }
        let prefix = format!("g{generation}__");
        for table in self
            .read_tables()?
            .into_iter()
            .filter(|table| table.starts_with(&prefix))
        {
            self.transaction_unlocked(|| {
                self.driver.execute(&sql::drop_table(&table), Vec::new())
            })?;
        }
        Ok(())
    }

    pub fn migration_record_write(
        &self,
        generation: i64,
        record: &OriginRecord,
    ) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.ensure_candidate_unlocked(generation)?;
        self.transaction_unlocked(|| self.migration_record_write_unlocked(generation, record))
    }

    fn migration_record_write_unlocked(
        &self,
        generation: i64,
        record: &OriginRecord,
    ) -> Result<(), StorageError> {
        if record.codec <= 0
            || record.flags & !(ORIGIN_FLAG_QUARANTINED | ORIGIN_FLAG_DISCARDED) != 0
        {
            return Err(StorageError::Unsatisfiable(
                "invalid originated record codec or flags".to_owned(),
            ));
        }
        let payload_hash = origin_hash(
            &record.identity_key,
            record.kind,
            &record.record_key,
            record.codec,
            record.flags,
            &record.payload,
        );
        self.driver.execute(
            sql::WRITE_ORIGIN,
            vec![
                Value::from_i64(generation),
                text_value(record.identity_key.clone()),
                Value::from_i64(record.kind),
                Value::Blob(record.record_key.clone()),
                Value::from_i64(record.codec),
                Value::from_i64(record.flags),
                Value::Blob(record.payload.clone()),
                Value::Blob(payload_hash),
            ],
        )
    }

    pub fn migration_record_delete(
        &self,
        generation: i64,
        identity_key: &str,
        kind: i64,
        record_key: &[u8],
    ) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.ensure_candidate_unlocked(generation)?;
        self.transaction_unlocked(|| {
            self.migration_record_delete_unlocked(generation, identity_key, kind, record_key)
        })
    }

    fn migration_record_delete_unlocked(
        &self,
        generation: i64,
        identity_key: &str,
        kind: i64,
        record_key: &[u8],
    ) -> Result<(), StorageError> {
        self.driver.execute(
            sql::DELETE_ORIGIN,
            vec![
                Value::from_i64(generation),
                text_value(identity_key.to_owned()),
                Value::from_i64(kind),
                Value::Blob(record_key.to_vec()),
            ],
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn migration_record_disposition_write(
        &self,
        generation: i64,
        identity_key: &str,
        kind: i64,
        record_key: &[u8],
        migration_id: &str,
        reason: &str,
        discard: bool,
    ) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.ensure_candidate_unlocked(generation)?;
        self.transaction_unlocked(|| {
            self.migration_record_disposition_write_unlocked(
                generation,
                identity_key,
                kind,
                record_key,
                migration_id,
                reason,
                discard,
            )
        })
    }

    #[allow(clippy::too_many_arguments)]
    fn migration_record_disposition_write_unlocked(
        &self,
        generation: i64,
        identity_key: &str,
        kind: i64,
        record_key: &[u8],
        migration_id: &str,
        reason: &str,
        discard: bool,
    ) -> Result<(), StorageError> {
        let record = self
            .origin_record_read_unlocked(generation, identity_key, kind, record_key)?
            .ok_or_else(|| {
                StorageError::Unsatisfiable("originated record is missing".to_owned())
            })?;
        let flags = if discard {
            ORIGIN_FLAG_DISCARDED
        } else {
            ORIGIN_FLAG_QUARANTINED
        };
        let payload = serde_json::to_vec(&serde_json::json!({
            "migrationId": migration_id,
            "reason": reason,
            "priorCodec": record.codec,
            "priorFlags": record.flags,
            "priorPayload": if discard {
                serde_json::Value::Null
            } else {
                serde_json::Value::String(base64::encode(&record.payload))
            },
            "priorPayloadHash": base64::encode(&record.payload_hash),
        }))
        .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        let payload_hash = origin_hash(
            identity_key,
            kind,
            record_key,
            ORIGIN_CODEC_V1,
            flags,
            &payload,
        );
        self.driver.execute(
            sql::WRITE_ORIGIN,
            vec![
                Value::from_i64(generation),
                text_value(identity_key.to_owned()),
                Value::from_i64(kind),
                Value::Blob(record_key.to_vec()),
                Value::from_i64(ORIGIN_CODEC_V1),
                Value::from_i64(flags),
                Value::Blob(payload),
                Value::Blob(payload_hash),
            ],
        )
    }

    /// Commit one migration handler page and its resume cursor atomically.
    pub fn migration_page_write(
        &self,
        generation: i64,
        migration_id: &str,
        cursor: &OriginCursor,
        writes: &[OriginRecord],
        deletes: &[MigrationRecordTarget],
        dispositions: &[MigrationDisposition],
    ) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.ensure_candidate_unlocked(generation)?;
        let (_, mut current_progress) = self
            .migration_progress_read_unlocked()?
            .filter(|(current_id, _)| current_id == migration_id)
            .ok_or_else(|| {
                StorageError::Unsatisfiable(
                    "migration page does not match the active migration step".to_owned(),
                )
            })?;
        current_progress.cursor = Some(cursor.clone());
        self.transaction_unlocked(|| {
            for record in writes {
                self.migration_record_write_unlocked(generation, record)?;
            }
            for target in deletes {
                self.migration_record_delete_unlocked(
                    generation,
                    &target.identity_key,
                    target.kind,
                    &target.record_key,
                )?;
            }
            for disposition in dispositions {
                self.migration_record_disposition_write_unlocked(
                    generation,
                    &disposition.target.identity_key,
                    disposition.target.kind,
                    &disposition.target.record_key,
                    migration_id,
                    &disposition.reason,
                    disposition.discard,
                )?;
            }
            self.migration_progress_write_unlocked(migration_id, &current_progress)
        })
    }

    /// Initialize or resume one migration's immutable ledger scan window.
    pub fn migration_step_begin(
        &self,
        generation: i64,
        migration_id: &str,
    ) -> Result<MigrationProgress, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.ensure_candidate_unlocked(generation)?;
        let progress =
            if let Some((current_id, progress)) = self.migration_progress_read_unlocked()? {
                if current_id != migration_id {
                    return Err(StorageError::Unsatisfiable(format!(
                        "candidate is already running migration {current_id}"
                    )));
                }
                progress
            } else {
                let progress = MigrationProgress {
                    cursor: None,
                    upper_bound: self.origin_tail_read_unlocked(generation)?,
                    snapshot_cursor: None,
                    snapshot_complete: false,
                };
                self.transaction_unlocked(|| {
                    self.driver
                        .execute(sql::CLEAR_MIGRATION_SNAPSHOT, Vec::new())?;
                    self.migration_progress_write_unlocked(migration_id, &progress)
                })?;
                progress
            };
        if progress.snapshot_complete {
            return Ok(progress);
        }
        self.migration_snapshot_write_unlocked(generation, migration_id, progress)
    }

    fn migration_snapshot_write_unlocked(
        &self,
        generation: i64,
        migration_id: &str,
        mut progress: MigrationProgress,
    ) -> Result<MigrationProgress, StorageError> {
        loop {
            let after = progress.snapshot_cursor.clone().unwrap_or_default();
            let mut page = Vec::with_capacity(512);
            self.driver.run_rows(
                sql::READ_ORIGIN,
                vec![
                    Value::from_i64(generation),
                    text_value(after.identity_key.clone()),
                    text_value(after.identity_key.clone()),
                    Value::from_i64(after.kind),
                    text_value(after.identity_key),
                    Value::from_i64(after.kind),
                    Value::Blob(after.record_key),
                    Value::from_i64(512),
                ],
                |row| {
                    page.push(OriginRecord {
                        identity_key: text_at(row, 0)?,
                        kind: int_at(row, 1)?,
                        record_key: blob_at(row, 2)?,
                        codec: int_at(row, 3)?,
                        flags: int_at(row, 4)?,
                        payload: blob_at(row, 5)?,
                        payload_hash: blob_at(row, 6)?,
                    });
                    Ok(())
                },
            )?;
            if page.is_empty() {
                progress.snapshot_complete = true;
                self.transaction_unlocked(|| {
                    self.migration_progress_write_unlocked(migration_id, &progress)
                })?;
                return Ok(progress);
            }
            progress.snapshot_cursor = page.last().map(|record| OriginCursor {
                identity_key: record.identity_key.clone(),
                kind: record.kind,
                record_key: record.record_key.clone(),
            });
            self.transaction_unlocked(|| {
                for record in &page {
                    self.driver.execute(
                        sql::WRITE_MIGRATION_SNAPSHOT,
                        vec![
                            text_value(record.identity_key.clone()),
                            Value::from_i64(record.kind),
                            Value::Blob(record.record_key.clone()),
                            Value::from_i64(record.codec),
                            Value::from_i64(record.flags),
                            Value::Blob(record.payload.clone()),
                            Value::Blob(record.payload_hash.clone()),
                        ],
                    )?;
                }
                self.migration_progress_write_unlocked(migration_id, &progress)
            })?;
        }
    }

    fn origin_tail_read_unlocked(
        &self,
        generation: i64,
    ) -> Result<Option<OriginCursor>, StorageError> {
        self.driver.run_row(
            sql::READ_ORIGIN_TAIL,
            vec![Value::from_i64(generation)],
            |row| {
                Ok(OriginCursor {
                    identity_key: text_at(row, 0)?,
                    kind: int_at(row, 1)?,
                    record_key: blob_at(row, 2)?,
                })
            },
        )
    }

    /// Mark one migration definition complete after its final page.
    pub fn migration_step_complete(
        &self,
        generation: i64,
        applied_migrations: usize,
    ) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.ensure_candidate_unlocked(generation)?;
        let target = self
            .bootstrap_contract_read_unlocked(sql::CANDIDATE_CONTRACT_KEY)?
            .ok_or_else(|| {
                StorageError::IncompatibleStore("candidate contract is missing".to_owned())
            })?;
        let current = self
            .bootstrap_i64_read_unlocked(sql::CANDIDATE_APPLIED_KEY)?
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0);
        if applied_migrations != current.saturating_add(1)
            || applied_migrations > target.migrations.len()
        {
            return Err(StorageError::Unsatisfiable(
                "migration completion is not the next target manifest entry".to_owned(),
            ));
        }
        self.transaction_unlocked(|| {
            self.write_bootstrap_unlocked(
                sql::CANDIDATE_APPLIED_KEY,
                applied_migrations.to_string().as_bytes(),
            )?;
            self.driver.execute(
                sql::DELETE_BOOTSTRAP,
                vec![text_value(sql::CANDIDATE_PROGRESS_KEY.to_owned())],
            )?;
            self.driver
                .execute(sql::CLEAR_MIGRATION_SNAPSHOT, Vec::new())
        })
    }

    fn migration_progress_read_unlocked(
        &self,
    ) -> Result<Option<(String, MigrationProgress)>, StorageError> {
        let Some(bytes) = self.bootstrap_read_unlocked(sql::CANDIDATE_PROGRESS_KEY)? else {
            return Ok(None);
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
            StorageError::IncompatibleStore(format!(
                "candidate migration progress is corrupt: {error}"
            ))
        })?;
        Ok(Some((
            json_str(&value, "migrationId")?.to_owned(),
            MigrationProgress {
                cursor: json_optional_origin_cursor(&value, "cursor")?,
                upper_bound: json_optional_origin_cursor(&value, "upperBound")?,
                snapshot_cursor: json_optional_origin_cursor(&value, "snapshotCursor")?,
                snapshot_complete: value
                    .get("snapshotComplete")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false),
            },
        )))
    }

    fn migration_progress_write_unlocked(
        &self,
        migration_id: &str,
        progress: &MigrationProgress,
    ) -> Result<(), StorageError> {
        let encoded = serde_json::to_vec(&serde_json::json!({
            "migrationId": migration_id,
            "cursor": progress.cursor.as_ref().map(origin_cursor_json),
            "upperBound": progress.upper_bound.as_ref().map(origin_cursor_json),
            "snapshotCursor": progress.snapshot_cursor.as_ref().map(origin_cursor_json),
            "snapshotComplete": progress.snapshot_complete,
        }))
        .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        self.write_bootstrap_unlocked(sql::CANDIDATE_PROGRESS_KEY, &encoded)
    }

    fn ensure_candidate_unlocked(&self, generation: i64) -> Result<(), StorageError> {
        if self.bootstrap_i64_read_unlocked(sql::CANDIDATE_GENERATION_KEY)? == Some(generation)
            && self.bootstrap_i64_read_unlocked(sql::CANDIDATE_SOURCE_KEY)?
                == Some(self.driver.generation())
        {
            return Ok(());
        }
        Err(StorageError::Unsatisfiable(
            "candidate generation is not owned by the active generation".to_owned(),
        ))
    }

    fn origin_record_read_unlocked(
        &self,
        generation: i64,
        identity_key: &str,
        kind: i64,
        record_key: &[u8],
    ) -> Result<Option<OriginRecord>, StorageError> {
        self.driver.run_row(
            sql::READ_ORIGIN_ONE,
            vec![
                Value::from_i64(generation),
                text_value(identity_key.to_owned()),
                Value::from_i64(kind),
                Value::Blob(record_key.to_vec()),
            ],
            |row| {
                Ok(OriginRecord {
                    identity_key: text_at(row, 0)?,
                    kind: int_at(row, 1)?,
                    record_key: blob_at(row, 2)?,
                    codec: int_at(row, 3)?,
                    flags: int_at(row, 4)?,
                    payload: blob_at(row, 5)?,
                    payload_hash: blob_at(row, 6)?,
                })
            },
        )
    }

    /// Materialize and atomically activate a fully transformed candidate generation.
    #[allow(clippy::too_many_lines)]
    pub fn migration_commit(
        &self,
        schema: &StoreSchema,
        generation: i64,
    ) -> Result<(), StorageError> {
        validate_store_schema(schema)?;
        let _guard = lock(&self.operation_lock);
        self.ensure_candidate_unlocked(generation)?;
        let target = StoreContract::for_schema(schema);
        if self.bootstrap_contract_read_unlocked(sql::CANDIDATE_CONTRACT_KEY)?
            != Some(target.clone())
        {
            return Err(StorageError::IncompatibleStore(
                "candidate contract no longer matches the target".to_owned(),
            ));
        }
        let applied_migrations = self
            .bootstrap_i64_read_unlocked(sql::CANDIDATE_APPLIED_KEY)?
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or(0);
        if applied_migrations != target.migrations.len() {
            return Err(StorageError::Unsatisfiable(
                "candidate has unapplied device migrations".to_owned(),
            ));
        }
        let active_generation = self.driver.generation();
        let previous_generation = active_generation;
        let previous_tables = lock(&self.tables).clone();
        *lock(&self.tables) = schema
            .tables
            .iter()
            .map(|table| {
                (
                    table.name.clone(),
                    Arc::new(TableRuntime::new(table.clone())),
                )
            })
            .collect();
        self.driver.generation_write(generation);
        let materialized = self.materialize_candidate_unlocked(generation);
        if let Err(error) = materialized {
            self.driver.generation_write(previous_generation);
            *lock(&self.tables) = previous_tables;
            return Err(error);
        }
        if let Err(error) = self.validate_physical_schema_unlocked(schema) {
            self.driver.generation_write(previous_generation);
            *lock(&self.tables) = previous_tables;
            return Err(error);
        }
        self.driver.generation_write(previous_generation);

        if let Err(error) = self.driver.execute("PRAGMA synchronous = FULL", Vec::new()) {
            *lock(&self.tables) = previous_tables;
            return Err(error);
        }
        let contract = match serde_json::to_vec(&target) {
            Ok(contract) => contract,
            Err(error) => {
                drop(
                    self.driver
                        .execute("PRAGMA synchronous = NORMAL", Vec::new()),
                );
                *lock(&self.tables) = previous_tables;
                return Err(StorageError::Unsatisfiable(error.to_string()));
            }
        };
        let cutover = self.transaction_unlocked(|| {
            if self.bootstrap_i64_read_unlocked(sql::ACTIVE_GENERATION_KEY)?
                != Some(active_generation)
            {
                return Err(StorageError::IncompatibleStore(
                    "active generation changed during migration".to_owned(),
                ));
            }
            self.write_bootstrap_unlocked(
                sql::ACTIVE_GENERATION_KEY,
                generation.to_string().as_bytes(),
            )?;
            self.write_bootstrap_unlocked(sql::ACTIVE_CONTRACT_KEY, &contract)?;
            let mut retired = self.retired_generations_read_unlocked()?;
            if !retired.contains(&active_generation) {
                retired.push(active_generation);
            }
            self.retired_generations_write_unlocked(&retired)?;
            for key in [
                sql::CANDIDATE_GENERATION_KEY,
                sql::CANDIDATE_SOURCE_KEY,
                sql::CANDIDATE_CONTRACT_KEY,
                sql::CANDIDATE_CODE_HASH_KEY,
                sql::CANDIDATE_STATE_KEY,
                sql::CANDIDATE_APPLIED_KEY,
                sql::CANDIDATE_PROGRESS_KEY,
                sql::CANDIDATE_COPY_CURSOR_KEY,
                sql::CANDIDATE_MATERIALIZE_CURSOR_KEY,
            ] {
                self.driver
                    .execute(sql::DELETE_BOOTSTRAP, vec![text_value(key.to_owned())])?;
            }
            Ok(())
        });
        let normal = self
            .driver
            .execute("PRAGMA synchronous = NORMAL", Vec::new());
        if let Err(error) = cutover {
            *lock(&self.tables) = previous_tables;
            return Err(error);
        }
        normal?;
        self.driver.generation_write(generation);
        self.activate_schema_unlocked(schema)?;
        *lock(&self.peer_id) = None;
        self.driver.clear_statements();
        Ok(())
    }

    fn materialize_candidate_unlocked(&self, generation: i64) -> Result<(), StorageError> {
        if self
            .bootstrap_read_unlocked(sql::CANDIDATE_STATE_KEY)?
            .as_deref()
            == Some(b"ready")
        {
            return Ok(());
        }
        let mut cursor = self
            .bootstrap_read_unlocked(sql::CANDIDATE_MATERIALIZE_CURSOR_KEY)?
            .map(|bytes| -> Result<OriginCursor, StorageError> {
                let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|error| {
                    StorageError::IncompatibleStore(format!(
                        "candidate materialization cursor is corrupt: {error}"
                    ))
                })?;
                Ok(OriginCursor {
                    identity_key: json_str(&value, "identityKey")?.to_owned(),
                    kind: json_i64(&value, "kind")?,
                    record_key: decode_base64_field(&value, "recordKey")?,
                })
            })
            .transpose()?
            .unwrap_or_default();
        loop {
            let page = self.origin_page_read_unlocked(generation, &cursor, 512)?;
            if page.is_empty() {
                return self.transaction_unlocked(|| {
                    self.write_bootstrap_unlocked(sql::CANDIDATE_STATE_KEY, b"ready")?;
                    self.driver.execute(
                        sql::DELETE_BOOTSTRAP,
                        vec![text_value(sql::CANDIDATE_MATERIALIZE_CURSOR_KEY.to_owned())],
                    )
                });
            }
            let next = page
                .last()
                .map(|record| OriginCursor {
                    identity_key: record.identity_key.clone(),
                    kind: record.kind,
                    record_key: record.record_key.clone(),
                })
                .expect("non-empty materialization page");
            let encoded = serde_json::to_vec(&origin_cursor_json(&next))
                .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
            self.transaction_unlocked(|| {
                for record in &page {
                    self.materialize_checked_origin_record_unlocked(record)?;
                }
                self.write_bootstrap_unlocked(sql::CANDIDATE_STATE_KEY, b"materializing")?;
                self.write_bootstrap_unlocked(sql::CANDIDATE_MATERIALIZE_CURSOR_KEY, &encoded)
            })?;
            cursor = next;
        }
    }

    fn origin_page_read_unlocked(
        &self,
        generation: i64,
        after: &OriginCursor,
        page_size: usize,
    ) -> Result<Vec<OriginRecord>, StorageError> {
        let mut records = Vec::with_capacity(page_size);
        self.driver.run_rows(
            sql::READ_ORIGIN,
            vec![
                Value::from_i64(generation),
                text_value(after.identity_key.clone()),
                text_value(after.identity_key.clone()),
                Value::from_i64(after.kind),
                text_value(after.identity_key.clone()),
                Value::from_i64(after.kind),
                Value::Blob(after.record_key.clone()),
                Value::from_i64(page_size as i64),
            ],
            |row| {
                records.push(OriginRecord {
                    identity_key: text_at(row, 0)?,
                    kind: int_at(row, 1)?,
                    record_key: blob_at(row, 2)?,
                    codec: int_at(row, 3)?,
                    flags: int_at(row, 4)?,
                    payload: blob_at(row, 5)?,
                    payload_hash: blob_at(row, 6)?,
                });
                Ok(())
            },
        )?;
        Ok(records)
    }

    fn materialize_checked_origin_record_unlocked(
        &self,
        record: &OriginRecord,
    ) -> Result<(), StorageError> {
        let expected = origin_hash(
            &record.identity_key,
            record.kind,
            &record.record_key,
            record.codec,
            record.flags,
            &record.payload,
        );
        if expected != record.payload_hash {
            return Err(StorageError::IncompatibleStore(
                "originated record checksum mismatch; candidate was not activated".to_owned(),
            ));
        }
        if record.flags & (ORIGIN_FLAG_QUARANTINED | ORIGIN_FLAG_DISCARDED) != 0 {
            return Ok(());
        }
        if record.codec != ORIGIN_CODEC_V1 {
            return Err(StorageError::IncompatibleStore(format!(
                "unsupported originated codec {} for kind {}",
                record.codec, record.kind
            )));
        }
        let kind = OriginKind::try_from(record.kind).map_err(|unknown| {
            StorageError::IncompatibleStore(format!("unknown originated record kind {unknown}"))
        })?;
        let value: serde_json::Value =
            serde_json::from_slice(&record.payload).map_err(|error| StorageError::Decode {
                expected: "originated record JSON",
                index: 0,
                got: error.to_string(),
            })?;
        let previous_identity = self.identity_key.clone();
        self.identity_key.write(record.identity_key.clone());
        let materialized = self.materialize_origin_record_unlocked(kind, record, &value);
        self.identity_key.write(previous_identity);
        materialized
    }

    #[allow(clippy::too_many_lines)]
    fn materialize_origin_record_unlocked(
        &self,
        kind: OriginKind,
        record: &OriginRecord,
        value: &serde_json::Value,
    ) -> Result<(), StorageError> {
        match kind {
            OriginKind::Identity => {
                let selector = std::str::from_utf8(&record.record_key).map_err(|error| {
                    StorageError::Decode {
                        expected: "identity selector key",
                        index: 0,
                        got: error.to_string(),
                    }
                })?;
                self.write_meta_for_identity_unlocked(
                    selector,
                    IDENTITY_STATE_META,
                    std::str::from_utf8(&record.payload).map_err(|error| StorageError::Decode {
                        expected: "identity state JSON",
                        index: 0,
                        got: error.to_string(),
                    })?,
                )
            }
            OriginKind::DeviceDocument => {
                let table_name = json_str(value, "table")?;
                let table = self.runtime(table_name)?;
                if table.def.placement != TablePlacement::Device {
                    return Err(StorageError::Unsatisfiable(format!(
                        "originated device document targets non-device table {table_name}"
                    )));
                }
                let data = json_str(value, "data")?;
                let object =
                    serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(data)
                        .map_err(|error| json_decode(&error.to_string()))?;
                let columns = crate::crdt::extract_cols(&table.def, &object)?;
                self.doc_write_unlocked(
                    &DocWrite {
                        table: table_name.to_owned(),
                        id: json_str(value, "id")?.to_owned(),
                        data: data.to_owned(),
                        cols: columns,
                        creation_time: json_f64(value, "creationTime")?,
                    },
                    &table,
                    false,
                )
            }
            OriginKind::LocalField => self.driver.execute(
                sql::write_local_field(),
                vec![
                    text_value(record.identity_key.clone()),
                    text_value(json_str(value, "table")?.to_owned()),
                    text_value(json_str(value, "id")?.to_owned()),
                    text_value(json_str(value, "field")?.to_owned()),
                    text_value(
                        serde_json::to_string(json_value(value, "value")?)
                            .map_err(|error| json_decode(&error.to_string()))?,
                    ),
                    Value::from_f64(0.0),
                ],
            ),
            OriginKind::Mutation => self.materialize_mutation_unlocked(record, value),
            OriginKind::PushEnvelope => {
                let commit_seq = json_i64(value, "commitSeq")?;
                let mutation_id = json_str(value, "mutationId")?;
                let mutation_time = value
                    .get("mutationTime")
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0);
                let local_inserts = value
                    .get("localInserts")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<FxHashSet<_>>();
                for after_image in value
                    .get("afterImages")
                    .and_then(serde_json::Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let table_name = json_str(after_image, "table")?;
                    let document_id = json_str(after_image, "rowId")?;
                    let table = self.runtime(table_name)?;
                    if table.def.placement != TablePlacement::Replicated {
                        return Err(StorageError::Unsatisfiable(format!(
                            "push after-image targets non-replicated table {table_name}"
                        )));
                    }
                    let content = json_str(after_image, "content")?;
                    let op = match content {
                        "value" => {
                            let data = json_value(after_image, "value")?;
                            let object = data
                                .as_object()
                                .ok_or_else(|| json_decode("push after-image value"))?;
                            let doc_write = DocWrite {
                                table: table_name.to_owned(),
                                id: document_id.to_owned(),
                                data: serde_json::to_string(data)
                                    .map_err(|error| json_decode(&error.to_string()))?,
                                cols: crate::crdt::extract_cols(&table.def, object)?,
                                creation_time: after_image
                                    .get("creationTime")
                                    .and_then(serde_json::Value::as_f64)
                                    .unwrap_or(0.0),
                            };
                            self.doc_write_unlocked(&doc_write, &table, false)?;
                            RowChangeOp::Write
                        }
                        "deleted" => RowChangeOp::Delete,
                        other => {
                            return Err(StorageError::Decode {
                                expected: "push after-image content",
                                index: 0,
                                got: other.to_owned(),
                            });
                        }
                    };
                    self.write_dirty_head_unlocked(
                        &RowKey {
                            table: table_name.to_owned(),
                            document_id: document_id.to_owned(),
                        },
                        op,
                        commit_seq,
                        mutation_time as i64,
                        mutation_time,
                        local_inserts.contains(document_id),
                    )?;
                }
                self.driver.execute(
                    sql::write_remote_cursor(),
                    vec![
                        text_value(record.identity_key.clone()),
                        text_value(format!("{REMOTE_PUSH_ENVELOPE_PREFIX}{mutation_id}")),
                        Value::from_i64(commit_seq),
                        text_value(
                            std::str::from_utf8(&record.payload)
                                .map_err(|error| json_decode(&error.to_string()))?
                                .to_owned(),
                        ),
                        Value::from_i64(json_optional_i64(value, "nowMs")?.unwrap_or(0)),
                    ],
                )
            }
            OriginKind::SettlementReceipt => {
                let replay_id = json_str(value, "replayId")?;
                self.driver.execute(
                    sql::write_remote_cursor(),
                    vec![
                        text_value(record.identity_key.clone()),
                        text_value(format!("{REMOTE_RECEIPT_PREFIX}{replay_id}")),
                        Value::from_i64(json_i64(value, "commitSeq")?),
                        text_value(replay_id.to_owned()),
                        Value::from_i64(0),
                    ],
                )
            }
            OriginKind::Schedule => {
                let job = ScheduledJob {
                    job_id: json_str(value, "jobId")?.to_owned(),
                    kind: crate::types::ScheduledFunctionKind::parse(json_str(value, "kind")?)
                        .ok_or_else(|| json_decode("scheduled function kind"))?,
                    name: json_str(value, "name")?.to_owned(),
                    args: json_str(value, "args")?.to_owned(),
                    due_time: json_i64(value, "dueTime")?,
                    state: ScheduledState::decode(
                        json_str(value, "state")?,
                        json_optional_i64(value, "leaseUntil")?,
                    )
                    .ok_or_else(|| json_decode("scheduled state"))?,
                    created_time: json_i64(value, "createdTime")?,
                    updated_time: json_i64(value, "updatedTime")?,
                };
                self.schedule_write_unlocked(&job)
            }
            OriginKind::Upload => {
                let lease = UploadLease::decode(
                    json_str(value, "lease")?,
                    json_optional_str(value, "owner")?.map(str::to_owned),
                    json_optional_i64(value, "leaseUntil")?,
                )
                .ok_or_else(|| json_decode("upload lease"))?;
                self.upload_write_unlocked(&PendingUpload {
                    local_storage_id: json_str(value, "localStorageId")?.to_owned(),
                    sha256: json_str(value, "sha256")?.to_owned(),
                    size: json_i64(value, "size")?,
                    content_type: json_optional_str(value, "contentType")?.map(str::to_owned),
                    lease,
                    created_time: json_i64(value, "createdTime")?,
                    updated_time: json_i64(value, "updatedTime")?,
                })
            }
            OriginKind::Blob => self.materialize_blob_unlocked(record, value),
            OriginKind::Revision => self.materialize_revision_unlocked(record, value),
            OriginKind::CrdtEffect => {
                let state_hash = decode_base64_field(value, "stateHash")?;
                let state_bytes = self
                    .origin_payload_read_unlocked(&state_hash)?
                    .ok_or_else(|| json_decode("CRDT state payload"))?;
                let state = decode_crdt_field_state(&state_bytes)?;
                let kind = crate::types::CrdtFieldKind::parse_wire(json_str(value, "kind")?)
                    .ok_or_else(|| json_decode("CRDT kind"))?;
                self.write_crdt_field_state_unlocked(
                    json_str(value, "table")?,
                    json_str(value, "id")?,
                    json_str(value, "field")?,
                    kind,
                    &state,
                    json_i64(value, "commitSeq")?,
                )
            }
            OriginKind::IdMapping => {
                let convex_id = json_optional_str(value, "convexId")?.map(str::to_owned);
                let mapping = IdMappingContent::decode(json_str(value, "state")?, convex_id)
                    .ok_or_else(|| json_decode("id mapping state"))?;
                self.id_write_unlocked(&IdMapping {
                    table: json_str(value, "table")?.to_owned(),
                    local_id: json_str(value, "localId")?.to_owned(),
                    mapping,
                    created_time: json_i64(value, "createdTime")?,
                    updated_time: json_i64(value, "updatedTime")?,
                })
            }
        }
    }

    fn origin_payload_read_unlocked(&self, hash: &[u8]) -> Result<Option<Vec<u8>>, StorageError> {
        let bytes = self.driver.run_row(
            sql::READ_ORIGIN_PAYLOAD,
            vec![Value::Blob(hash.to_vec())],
            |row| blob_at(row, 0),
        )?;
        if bytes
            .as_ref()
            .is_some_and(|bytes| Sha256::digest(bytes).as_slice() != hash)
        {
            return Err(StorageError::IncompatibleStore(
                "originated payload checksum mismatch; the store was preserved".to_owned(),
            ));
        }
        Ok(bytes)
    }

    fn materialize_mutation_unlocked(
        &self,
        record: &OriginRecord,
        value: &serde_json::Value,
    ) -> Result<(), StorageError> {
        let mutation_id = json_str(value, "mutationId")?;
        let name = json_str(value, "name")?;
        let args = json_str(value, "args")?;
        let status = json_str(value, "status")?;
        match status {
            "accepted" => self.driver.execute(
                sql::write_mutation(),
                vec![
                    text_value(record.identity_key.clone()),
                    text_value(mutation_id.to_owned()),
                    text_value(name.to_owned()),
                    text_value(args.to_owned()),
                    text_value(status.to_owned()),
                ],
            ),
            "committed" => self.driver.execute(
                sql::write_committed_mutation_ok(),
                vec![
                    text_value(record.identity_key.clone()),
                    text_value(mutation_id.to_owned()),
                    text_value(name.to_owned()),
                    text_value(args.to_owned()),
                    text_value(status.to_owned()),
                    json_optional_str(value, "result")?
                        .map_or(Value::Null, |result| text_value(result.to_owned())),
                    Value::from_i64(json_i64(value, "commitSeq")?),
                ],
            ),
            "failed" => self.driver.execute(
                sql::write_failed_mutation(),
                vec![
                    text_value(record.identity_key.clone()),
                    text_value(mutation_id.to_owned()),
                    text_value(name.to_owned()),
                    text_value(args.to_owned()),
                    text_value(status.to_owned()),
                    Value::Null,
                    json_optional_str(value, "error")?
                        .map_or(Value::Null, |error| text_value(error.to_owned())),
                    Value::Null,
                ],
            ),
            _ => Err(json_decode("mutation status")),
        }
    }

    fn materialize_blob_unlocked(
        &self,
        record: &OriginRecord,
        value: &serde_json::Value,
    ) -> Result<(), StorageError> {
        let storage_id = json_str(value, "storageId")?;
        let bytes_hash = decode_base64_field(value, "bytesHash")?;
        let bytes = self
            .origin_payload_read_unlocked(&bytes_hash)?
            .ok_or_else(|| json_decode("blob payload"))?;
        self.driver.execute(
            sql::write_blob(),
            vec![
                text_value(record.identity_key.clone()),
                text_value(storage_id.to_owned()),
                Value::Blob(bytes),
            ],
        )?;
        self.file_meta_write_unlocked(&FileMetadata {
            storage_id: storage_id.to_owned(),
            sha256: json_str(value, "sha256")?.to_owned(),
            size: json_i64(value, "size")?,
            content_type: json_optional_str(value, "contentType")?.map(str::to_owned),
            source: json_optional_str(value, "source")?.map(str::to_owned),
            created_time: json_i64(value, "createdTime")?,
            updated_time: json_i64(value, "updatedTime")?,
        })
    }

    fn materialize_revision_unlocked(
        &self,
        _record: &OriginRecord,
        value: &serde_json::Value,
    ) -> Result<(), StorageError> {
        let snapshot_hash = decode_base64_field(value, "snapshotHash")?;
        let snapshot = self
            .origin_payload_read_unlocked(&snapshot_hash)?
            .ok_or_else(|| json_decode("revision snapshot payload"))?;
        let log = json_array(value, "logHashes")?
            .iter()
            .map(|hash| {
                let hash = hash
                    .as_str()
                    .ok_or_else(|| json_decode("revision log hash"))?;
                let hash = base64::decode(hash).map_err(|error| json_decode(&error.to_string()))?;
                self.origin_payload_read_unlocked(&hash)?
                    .ok_or_else(|| json_decode("revision log payload"))
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        let lifecycle = crate::types::RevLifecycle::decode(
            json_str(value, "lifecycle")?,
            json_optional_str(value, "parent")?.map(str::to_owned),
            json_optional_str(value, "serverRevId")?.map(str::to_owned),
            json_optional_str(value, "serverRootId")?.map(str::to_owned),
            json_optional_str(value, "serverNodeId")?.map(str::to_owned),
            json_optional_str(value, "baseRootId")?.map(str::to_owned),
            json_optional_str(value, "baseNodeId")?.map(str::to_owned),
        )
        .ok_or_else(|| json_decode("revision lifecycle"))?;
        self.rev_write_unlocked(
            &RevState {
                key: RevKey {
                    row: RowKey {
                        table: json_str(value, "table")?.to_owned(),
                        document_id: json_str(value, "id")?.to_owned(),
                    },
                    rev_id: json_str(value, "revId")?.to_owned(),
                },
                frontier: decode_base64_field(value, "frontier")?,
                snapshot,
                log,
                lifecycle,
                updated_time: json_i64(value, "updatedTime")?,
            },
            json_i64(value, "updatedTime")?,
        )
    }

    /// Remove a retired generation after a later active generation has opened successfully.
    pub fn migration_retire(&self, generation: i64) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        if generation == self.driver.generation()
            || self.bootstrap_i64_read_unlocked(sql::CANDIDATE_GENERATION_KEY)? == Some(generation)
        {
            return Err(StorageError::Unsatisfiable(
                "active or candidate generation cannot be retired".to_owned(),
            ));
        }
        self.generation_cleanup_unlocked(generation)?;
        self.origin_payload_cleanup_unlocked()?;
        self.transaction_unlocked(|| {
            let mut retired = self.retired_generations_read_unlocked()?;
            retired.retain(|candidate| *candidate != generation);
            self.retired_generations_write_unlocked(&retired)
        })
    }

    /// Mark every immutable payload reachable from any retained ledger envelope before deleting a
    /// bounded page of unreferenced bytes. A failed mark performs no deletes; a failed delete is
    /// safe to retry from a fresh mark pass.
    fn origin_payload_cleanup_unlocked(&self) -> Result<(), StorageError> {
        self.driver
            .execute(sql::CREATE_ORIGIN_PAYLOAD_REACHABLE, Vec::new())?;
        self.driver
            .execute(sql::CLEAR_ORIGIN_PAYLOAD_REACHABLE, Vec::new())?;
        let mut cursor = 0;
        loop {
            let mut page = Vec::with_capacity(512);
            self.driver.run_rows(
                sql::READ_ORIGIN_PAYLOAD_REFERENCE_PAGE,
                vec![Value::from_i64(cursor)],
                |row| {
                    page.push((
                        int_at(row, 0)?,
                        int_at(row, 1)?,
                        int_at(row, 2)?,
                        int_at(row, 3)?,
                        blob_at(row, 4)?,
                    ));
                    Ok(())
                },
            )?;
            if page.is_empty() {
                break;
            }
            self.transaction_unlocked(|| {
                for (_, kind, codec, flags, payload) in &page {
                    for hash in origin_payload_references(*kind, *codec, *flags, payload)? {
                        self.driver.execute(
                            sql::WRITE_ORIGIN_PAYLOAD_REACHABLE,
                            vec![Value::Blob(hash)],
                        )?;
                    }
                }
                Ok(())
            })?;
            cursor = page.last().map_or(cursor, |record| record.0);
        }
        loop {
            let deleted = self.transaction_unlocked(|| {
                self.driver.execute(
                    sql::DELETE_UNREACHABLE_ORIGIN_PAYLOAD_PAGE,
                    Vec::new(),
                )?;
                Ok(self.driver.changes())
            })?;
            if deleted == 0 {
                return Ok(());
            }
        }
    }

    fn retired_generations_read_unlocked(&self) -> Result<Vec<i64>, StorageError> {
        let Some(bytes) = self.bootstrap_read_unlocked(sql::RETIRED_GENERATIONS_KEY)? else {
            return Ok(Vec::new());
        };
        let generations: Vec<i64> = serde_json::from_slice(&bytes).map_err(|error| {
            StorageError::IncompatibleStore(format!(
                "retired generation metadata is corrupt: {error}"
            ))
        })?;
        if generations.iter().any(|generation| *generation < 0) {
            return Err(StorageError::IncompatibleStore(
                "retired generation metadata contains a negative generation".to_owned(),
            ));
        }
        Ok(generations)
    }

    fn retired_generations_write_unlocked(&self, generations: &[i64]) -> Result<(), StorageError> {
        let encoded = serde_json::to_vec(generations)
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        self.write_bootstrap_unlocked(sql::RETIRED_GENERATIONS_KEY, &encoded)
    }

    fn commit_transaction_unlocked(&self) -> Result<(), StorageError> {
        match self.driver.execute(sql::COMMIT, Vec::new()) {
            Ok(()) => Ok(()),
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(error, rolled))
            }
        }
    }

    fn transaction_unlocked<T>(
        &self,
        write: impl FnOnce() -> Result<T, StorageError>,
    ) -> Result<T, StorageError> {
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        match write() {
            Ok(value) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(value),
                Err(error) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(error, rolled))
                }
            },
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(error, rolled))
            }
        }
    }

    fn create_system_schema_unlocked(&self) -> Result<(), StorageError> {
        for statement in sql::generation_layout_manifest() {
            self.driver.execute(statement, Vec::new())?;
        }
        Ok(())
    }

    fn create_doc_schema_unlocked(&self, schema: &StoreSchema) -> Result<(), StorageError> {
        for table in &schema.tables {
            self.create_doc_table_unlocked(table)?;
        }
        Ok(())
    }

    fn create_doc_table_unlocked(&self, table: &TableDef) -> Result<(), StorageError> {
        self.driver
            .execute(&sql::create_doc_table(table), Vec::new())?;
        self.write_doc_indexes_unlocked(table)
    }

    fn write_doc_indexes_unlocked(&self, table: &TableDef) -> Result<(), StorageError> {
        self.driver.execute(
            &sql::create_doc_index(&table.name, "by_id", &["id".to_owned()])?,
            Vec::new(),
        )?;
        for index in &table.indexes {
            let columns = index.columns.as_ref().unwrap_or(&index.fields);
            if is_built_in_index(&index.name, columns) {
                continue;
            }
            self.driver.execute(
                &sql::create_doc_index(&table.name, &index.name, &physical_index_columns(columns))?,
                Vec::new(),
            )?;
        }
        Ok(())
    }

    fn activate_schema_unlocked(&self, schema: &StoreSchema) -> Result<(), StorageError> {
        let max_commit_seq = self
            .driver
            .run_row(
                sql::max_commit_seq(),
                max_commit_seq_params(&self.identity_key.clone()),
                |row| int_at(row, 0),
            )?
            .unwrap_or(0);
        self.reset_commit_seq_cache(max_commit_seq);

        let tables = schema
            .tables
            .iter()
            .map(|table| {
                (
                    table.name.clone(),
                    Arc::new(TableRuntime::new(table.clone())),
                )
            })
            .collect();
        *lock(&self.tables) = tables;
        lock(&self.plans).clear();
        let high = self.max_creation_time_unlocked()?;
        lock(&self.clock).observe(high);
        Ok(())
    }

    /// The next monotonic creation time. Mirrors `clock.read()`.
    /// Calling this consumes a clock tick immediately, even if no commit follows.
    pub fn clock_read(&self) -> Result<f64, StorageError> {
        let wall = wall_ms()?;
        Ok(lock(&self.clock).now(wall))
    }

    pub fn mutation_write(&self, call: &MutationCall) -> Result<MutationRecord, StorageError> {
        let _guard = lock(&self.operation_lock);
        if let Some(record) = self.mutation_record_unlocked(&call.mutation_id)? {
            self.clear_absent_mutation(&call.mutation_id);
            self.ensure_mutation_call_matches_unlocked(call)?;
            return Ok(record);
        }
        self.clear_absent_mutation(&call.mutation_id);
        self.transaction_unlocked(|| {
            self.driver.execute(
                sql::write_mutation(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(call.mutation_id.clone()),
                    text_value(call.name.clone()),
                    text_value(call.args.clone()),
                    text_value(MutationStatus::Accepted.as_str().to_owned()),
                ],
            )?;
            self.origin_mutation_write_unlocked(call, MutationStatus::Accepted, None, None, None)?;
            Ok(MutationRecord {
                commit_seq: None,
                error: None,
                mutation_id: call.mutation_id.clone(),
                result: None,
                status: MutationStatus::Accepted,
            })
        })
    }

    pub fn mutation_cache_read(&self, call: &MutationCall) -> Result<MutationRecord, StorageError> {
        let _guard = lock(&self.operation_lock);
        if let Some(record) = self.mutation_record_unlocked(&call.mutation_id)? {
            self.clear_absent_mutation(&call.mutation_id);
            self.ensure_mutation_call_matches_unlocked(call)?;
            return Ok(record);
        }
        self.remember_absent_mutation(call)?;
        Ok(MutationRecord {
            commit_seq: None,
            error: None,
            mutation_id: call.mutation_id.clone(),
            result: None,
            status: MutationStatus::Accepted,
        })
    }

    pub fn mutation_cache_write(
        &self,
        call: &MutationCall,
    ) -> Result<MutationRecord, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.remember_absent_mutation(call)?;
        Ok(MutationRecord {
            commit_seq: None,
            error: None,
            mutation_id: call.mutation_id.clone(),
            result: None,
            status: MutationStatus::Accepted,
        })
    }

    pub fn mutation_fail(&self, mutation_id: &str, error: &str) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        if let Some((name, args)) = self.take_absent_mutation_call_for_fail(mutation_id) {
            return self.transaction_unlocked(|| {
                self.driver.execute(
                    sql::write_failed_mutation(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(mutation_id.to_owned()),
                        text_value(name),
                        text_value(args),
                        text_value(MutationStatus::Failed.as_str().to_owned()),
                        Value::Null,
                        text_value(error.to_owned()),
                        Value::Null,
                    ],
                )?;
                self.origin_delete_unlocked(OriginKind::Mutation, mutation_id.as_bytes())
            });
        }
        self.clear_absent_mutation(mutation_id);
        self.transaction_unlocked(|| {
            self.driver.execute(
                sql::fail_mutation(),
                vec![
                    text_value(MutationStatus::Failed.as_str().to_owned()),
                    text_value(error.to_owned()),
                    text_value(self.identity_key.clone()),
                    text_value(mutation_id.to_owned()),
                    text_value(MutationStatus::Committed.as_str().to_owned()),
                ],
            )?;
            self.origin_delete_unlocked(OriginKind::Mutation, mutation_id.as_bytes())
        })
    }

    /// Reads the database's stored format version, defaulting to 0 for a brand-new database.
    fn read_user_version(&self) -> Result<i64, StorageError> {
        Ok(self
            .driver
            .run_row(sql::READ_USER_VERSION, Vec::new(), |row| int_at(row, 0))?
            .unwrap_or(0))
    }

    /// Lists every table name so setup can distinguish a new store from an incompatible one.
    fn read_tables(&self) -> Result<Vec<String>, StorageError> {
        let mut names = Vec::new();
        self.driver.run_rows(sql::LIST_TABLES, Vec::new(), |row| {
            names.push(text_at(row, 0)?);
            Ok(())
        })?;
        Ok(names)
    }

    fn validate_physical_schema_unlocked(&self, schema: &StoreSchema) -> Result<(), StorageError> {
        for table in &schema.tables {
            let columns = self.read_doc_columns_unlocked(&table.name)?;
            require_doc_base_columns(&table.name, &columns)?;
            let mut expected = ["id", "identity_key", "creation_time_ms", "data"]
                .into_iter()
                .collect::<FxHashSet<_>>();
            expected.extend(table.columns.iter().map(|column| column.name.as_str()));
            if columns.iter().map(String::as_str).collect::<FxHashSet<_>>() != expected {
                return Err(StorageError::IncompatibleStore(format!(
                    "the physical columns for {} do not match the active contract; the store was preserved",
                    table.name
                )));
            }
            if self.read_doc_indexes_unlocked(table)? != expected_doc_indexes(table) {
                return Err(StorageError::IncompatibleStore(format!(
                    "the physical indexes for {} do not match the active contract; the store was preserved",
                    table.name
                )));
            }
        }
        Ok(())
    }

    fn read_doc_columns_unlocked(&self, table: &str) -> Result<FxHashSet<String>, StorageError> {
        let mut columns = FxHashSet::default();
        self.driver
            .run_rows(&sql::read_doc_columns(table)?, Vec::new(), |row| {
                columns.insert(text_at(row, 1)?);
                Ok(())
            })?;
        Ok(columns)
    }

    fn read_doc_indexes_unlocked(
        &self,
        table: &TableDef,
    ) -> Result<FxHashMap<String, Vec<String>>, StorageError> {
        let prefix =
            sql::generation_identifier(&format!("ix__{}__", table.name), self.driver.generation())
                .to_ascii_lowercase();
        let mut names = Vec::new();
        self.driver
            .run_rows(&sql::read_doc_indexes(&table.name)?, Vec::new(), |row| {
                let name = text_at(row, 1)?.to_ascii_lowercase();
                if let Some(index) = name.strip_prefix(&prefix) {
                    names.push(index.to_owned());
                }
                Ok(())
            })?;
        let mut indexes = FxHashMap::default();
        for name in names {
            let mut columns = Vec::new();
            self.driver.run_rows(
                &sql::read_doc_index_columns(&table.name, &name)?,
                Vec::new(),
                |row| {
                    columns.push(text_at(row, 2)?);
                    Ok(())
                },
            )?;
            indexes.insert(name, columns);
        }
        Ok(indexes)
    }

    fn read_meta_unlocked(&self, key: &str) -> Result<Option<String>, StorageError> {
        self.read_meta_for_identity_unlocked(STORE_META_IDENTITY, key)
    }

    fn read_meta_for_identity_unlocked(
        &self,
        identity_key: &str,
        key: &str,
    ) -> Result<Option<String>, StorageError> {
        self.driver.run_row(
            sql::read_meta(),
            vec![
                text_value(identity_key.to_owned()),
                text_value(key.to_owned()),
            ],
            |row| text_at(row, 0),
        )
    }

    fn write_meta_unlocked(&self, key: &str, value: &str) -> Result<(), StorageError> {
        self.write_meta_for_identity_unlocked(STORE_META_IDENTITY, key, value)
    }

    fn write_meta_for_identity_unlocked(
        &self,
        identity_key: &str,
        key: &str,
        value: &str,
    ) -> Result<(), StorageError> {
        self.driver.execute(
            sql::write_meta(),
            vec![
                text_value(identity_key.to_owned()),
                text_value(key.to_owned()),
                text_value(value.to_owned()),
            ],
        )
    }

    /// Forces the database's stored format version, to simulate a database written by another
    /// build in tests.
    #[cfg(any(test, feature = "testkit"))]
    #[doc(hidden)]
    pub fn force_user_version_for_test(&self, version: i64) {
        self.driver
            .execute(&format!("PRAGMA user_version = {version}"), Vec::new())
            .unwrap();
    }

    #[cfg(any(test, feature = "testkit"))]
    #[doc(hidden)]
    pub fn execute_sql_for_test(&self, sql: &str) {
        self.driver.execute(sql, Vec::new()).unwrap();
        self.driver.clear_statements();
    }

    /// Test-only: write a retained-result entry inside an explicit transaction, mirroring the
    /// pull-page envelope S3 will call `result_write_unlocked` within, so rollback and the
    /// atomic-ride property can be exercised (with [`crate::testkit::fail_next_commit`]).
    #[cfg(any(test, feature = "testkit"))]
    #[doc(hidden)]
    pub fn result_write_in_page_for_test(&self, entry: &ResultEntry) -> Result<bool, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        match self.result_write_unlocked(entry) {
            Ok(written) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(written),
                Err(error) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(error, rolled))
                }
            },
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(error, rolled))
            }
        }
    }

    fn max_creation_time_unlocked(&self) -> Result<f64, StorageError> {
        let names: Vec<String> = lock(&self.tables).keys().cloned().collect();
        let mut max = 0.0_f64;
        for name in names {
            debug_assert!(is_valid_ident(&name));
            let sql = sql::doc_watermark(&name);
            let params = vec![text_value(self.identity_key.clone())];
            let m = self
                .driver
                .run_row(&sql, params, |row| match row.get_value(0) {
                    Value::Null => Ok(None),
                    _ => real_at(row, 0).map(Some),
                })?;
            if let Some(Some(m)) = m {
                if m > max {
                    max = m;
                }
            }
        }
        Ok(max)
    }

    pub fn clear(&self) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let cleared: Result<(), StorageError> = (|| {
            let names: Vec<String> = lock(&self.tables).keys().cloned().collect();
            for name in names {
                debug_assert!(is_valid_ident(&name));
                self.driver.execute(
                    &sql::clear_docs(&name),
                    vec![text_value(self.identity_key.clone())],
                )?;
            }
            for sql in [
                sql::clear_commits(),
                sql::clear_mutations(),
                sql::clear_blobs(),
                sql::clear_revs(),
                sql::clear_dirty_heads(),
                sql::clear_crdt_ops(),
                sql::clear_crdt_field(),
                sql::clear_local_fields(),
                sql::clear_projections(),
                sql::clear_peers(),
                sql::clear_files(),
                sql::clear_id_mappings(),
                sql::clear_uploads(),
                sql::clear_remote(),
                sql::clear_schedules(),
            ] {
                self.driver
                    .execute(sql, vec![text_value(self.identity_key.clone())])?;
            }
            Ok(())
        })();
        match cleared {
            Ok(()) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => {
                    *lock(&self.peer_id) = None;
                    self.reset_commit_seq_cache(0);
                    Ok(())
                }
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(e, rolled))
                }
            },
            Err(e) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(e, rolled))
            }
        }
    }

    /// Read one document by id, as one materialized JSON object text
    /// (`{"_id":…,"_creationTime":…,…fields}`).
    pub fn doc_read(&self, table: &str, id: &str) -> Result<Option<String>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.doc_read_unlocked(table, id)
    }

    fn doc_read_unlocked(&self, table: &str, id: &str) -> Result<Option<String>, StorageError> {
        let table = self.runtime(table)?;
        debug_assert!(is_valid_ident(&table.def.name));
        let params = vec![
            text_value(self.identity_key.clone()),
            text_value(id.to_owned()),
        ];
        self.driver.run_row(&table.read_sql, params, |row| {
            let mut text = String::new();
            append_doc(&mut text, row)?;
            Ok(text)
        })
    }

    /// The adoption version of one row (the point-read counterpart of the page
    /// `versions` sidecar): the projection's `logical_clock`, i.e. the pull `seq`
    /// the local replica last adopted the row at. `None` when the row has no
    /// projection or its clock is not finite; the push read-set treats that as
    /// version 0 (unversioned → the server re-reads authoritatively, §11-D1).
    pub fn doc_version_read(&self, table: &str, id: &str) -> Result<Option<i64>, StorageError> {
        validate_ident(table)?;
        let _guard = lock(&self.operation_lock);
        Ok(self.remote_doc_read_unlocked(table, id)?.and_then(|state| {
            state
                .logical_clock
                .is_finite()
                .then_some(state.logical_clock as i64)
        }))
    }

    /// One page of documents as a single JSON array text. Scans are total: any bounds the SQL
    /// layer cannot represent exactly were widened at compile time, so callers re-check exact
    /// order/bounds.
    pub fn doc_page_read(&self, spec: &ReadSpec) -> Result<Page, StorageError> {
        self.read_page(spec, Projection::Docs)
    }

    /// One page of document keys as `{"ids":[…],"cts":[…]}`; the `data` payload never leaves
    /// `SQLite`.
    pub fn key_page_read(&self, spec: &ReadSpec) -> Result<Page, StorageError> {
        self.read_page(spec, Projection::Keys)
    }

    /// Count documents. `None` means the bounds were widened (a widened count would over-count),
    /// so the caller must count through `key_page_read` with its exact re-check instead.
    pub fn doc_count_read(&self, spec: &CountSpec) -> Result<Option<i64>, StorageError> {
        let table = self.def(&spec.table)?;
        let plan = self.plan(read_count_key(spec), || compile_count(spec, &table))?;
        if !plan.exact {
            return Ok(None);
        }
        let mut params = vec![text_value(self.identity_key.clone())];
        params.extend(read_count_params(spec, &table)?);
        let _guard = lock(&self.operation_lock);
        let n = self
            .driver
            .run_row(&plan.sql, params, |row| int_at(row, 0))?;
        Ok(Some(n.unwrap_or(0)))
    }

    fn read_page(&self, spec: &ReadSpec, projection: Projection) -> Result<Page, StorageError> {
        let table = self.def(&spec.table)?;
        let page_size = spec.page_size.unwrap_or(DEFAULT_READ_PAGE);
        if page_size == 0 || page_size > READ_CAP {
            return Err(StorageError::Unsatisfiable(format!(
                "scan: page size {page_size} outside 1..={READ_CAP}"
            )));
        }
        let shape = read_page_shape(spec);
        let cursor_values = match (&spec.cursor, &spec.resume_after_key) {
            (Some(_), Some(_)) => {
                return Err(StorageError::InvalidCursor(
                    "cursor and resume_after_key are mutually exclusive".to_owned(),
                ));
            }
            (Some(cursor), None) => Some(decode_cursor(cursor, &shape)?),
            (None, Some(key)) => Some(key.clone()),
            (None, None) => None,
        };
        let resume = cursor_values.is_some();
        let plan = self.plan(read_page_key(spec, projection, resume), || {
            compile_page_read(spec, &table, projection, resume)
        })?;
        let positions = key_positions(&plan.columns, projection);

        let mut params = vec![text_value(self.identity_key.clone())];
        params.extend(read_page_params(
            spec,
            &table,
            cursor_values.as_deref(),
            page_size,
        )?);

        let mut count = 0usize;
        let mut last_keys: Option<Vec<ColValue>> = None;
        let mut docs = String::from("[");
        let mut ids = String::from("[");
        let mut cts = String::from("[");
        let mut page_local_ids: Vec<String> = Vec::new();
        {
            let _guard = lock(&self.operation_lock);
            self.driver.run_rows(&plan.sql, params, |row| {
                if count + 1 == page_size {
                    last_keys = Some(
                        plan.columns
                            .iter()
                            .zip(&positions)
                            .map(|(col, &i)| order_col_value_at(row, i, col))
                            .collect::<Result<_, _>>()?,
                    );
                }
                if count < page_size {
                    match projection {
                        Projection::Docs => {
                            if count > 0 {
                                docs.push(',');
                            }
                            page_local_ids.push(text_ref_at(row, 0)?.to_owned());
                            append_doc(&mut docs, row)?;
                        }
                        Projection::Keys => {
                            if count > 0 {
                                ids.push(',');
                                cts.push(',');
                            }
                            append_json_string(&mut ids, text_ref_at(row, 0)?);
                            append_f64(&mut cts, real_at(row, 1)?)?;
                        }
                    }
                }
                count += 1;
                Ok(())
            })?;
        }

        let text = match projection {
            Projection::Docs => {
                docs.push(']');
                docs
            }
            Projection::Keys => {
                ids.push(']');
                cts.push(']');
                format!("{{\"ids\":{ids},\"cts\":{cts}}}")
            }
        };
        let cursor = if count > page_size {
            let keys = last_keys.ok_or(StorageError::Decode {
                expected: "cursor key values",
                index: 0,
                got: "missing last page row".to_owned(),
            })?;
            Some(encode_cursor(&shape, &keys))
        } else {
            None
        };
        let versions = self.page_versions(&spec.table, &page_local_ids)?;
        let local_fields = self.page_local_fields(&spec.table, &page_local_ids)?;
        Ok(Page {
            text,
            cursor,
            versions,
            local_fields,
        })
    }

    fn page_local_fields(
        &self,
        table: &str,
        local_ids: &[String],
    ) -> Result<
        std::collections::BTreeMap<String, serde_json::Map<String, serde_json::Value>>,
        StorageError,
    > {
        let mut fields = std::collections::BTreeMap::new();
        let _guard = lock(&self.operation_lock);
        for local_id in local_ids {
            let row = self.local_fields_read_unlocked(table, local_id)?;
            if !row.is_empty() {
                fields.insert(local_id.clone(), row);
            }
        }
        Ok(fields)
    }

    /// Read the device-only overlay for one replicated row. The base document is deliberately not
    /// merged here so replicated execution cannot accidentally observe device state.
    pub fn local_fields_read(
        &self,
        table: &str,
        id: &str,
    ) -> Result<serde_json::Map<String, serde_json::Value>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.local_fields_read_unlocked(table, id)
    }

    fn local_fields_read_unlocked(
        &self,
        table: &str,
        id: &str,
    ) -> Result<serde_json::Map<String, serde_json::Value>, StorageError> {
        validate_ident(table)?;
        let definition = self.def(table)?;
        if definition.placement != TablePlacement::Replicated {
            return Ok(serde_json::Map::new());
        }
        let mut fields = serde_json::Map::new();
        self.driver.run_rows(
            sql::read_local_fields(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(id.to_owned()),
            ],
            |row| {
                let field = text_at(row, 0)?;
                let value = serde_json::from_str(&text_at(row, 1)?).map_err(|error| {
                    StorageError::Decode {
                        expected: "device field JSON",
                        index: 1,
                        got: error.to_string(),
                    }
                })?;
                fields.insert(field, value);
                Ok(())
            },
        )?;
        Ok(fields)
    }

    /// The per-row adoption version sidecar (§11 D1): `localId -> pull seq`, read from the
    /// projection row's `logical_clock` (the pull `seq` a `PullPage` change was adopted at).
    fn page_versions(
        &self,
        table: &str,
        local_ids: &[String],
    ) -> Result<std::collections::BTreeMap<String, i64>, StorageError> {
        let mut versions = std::collections::BTreeMap::new();
        for local_id in local_ids {
            if let Some(state) = self.remote_doc_read(table, local_id)? {
                if state.logical_clock.is_finite() {
                    versions.insert(local_id.clone(), state.logical_clock as i64);
                }
            }
        }
        Ok(versions)
    }

    #[allow(
        clippy::needless_pass_by_value,
        reason = "FFI callers transfer the decoded batch into this transaction boundary"
    )]
    pub fn commit(
        &self,
        batch: WriteBatch,
        options: &CommitOptions,
    ) -> Result<CommitResult, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written = self.commit_unlocked(&batch, options);

        match written {
            Ok(result) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(result),
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    if self.commit_has_unlocked(result.commit_seq)? {
                        Ok(result)
                    } else {
                        Err(combine_rollback(e, rolled))
                    }
                }
            },
            Err(e) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(e, rolled))
            }
        }
    }

    #[allow(
        clippy::needless_pass_by_value,
        reason = "FFI callers transfer the decoded write into this transaction boundary"
    )]
    pub fn commit_one_doc_write(
        &self,
        doc_write: DocWrite,
        options: &CommitOptions,
        fresh: bool,
        data_only: bool,
    ) -> Result<CommitResult, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written = self.commit_one_doc_write_unlocked(&doc_write, options, fresh, data_only);

        match written {
            Ok(result) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(result),
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    if self.commit_has_unlocked(result.commit_seq)? {
                        Ok(result)
                    } else {
                        Err(combine_rollback(e, rolled))
                    }
                }
            },
            Err(e) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(e, rolled))
            }
        }
    }

    #[allow(
        clippy::too_many_arguments,
        clippy::needless_pass_by_value,
        reason = "the zero-copy FFI entry mirrors the fixed encoded write wire shape"
    )]
    pub fn commit_one_doc_write_encoded(
        &self,
        table: String,
        id: String,
        data: String,
        encoded_cols: Vec<Vec<u8>>,
        creation_time: f64,
        options: &CommitOptions,
        fresh: bool,
        data_only: bool,
    ) -> Result<CommitResult, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written = self.commit_one_doc_write_encoded_unlocked(
            &table,
            &id,
            &data,
            &encoded_cols,
            creation_time,
            options,
            fresh,
            data_only,
        );

        match written {
            Ok(result) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(result),
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    if self.commit_has_unlocked(result.commit_seq)? {
                        Ok(result)
                    } else {
                        Err(combine_rollback(e, rolled))
                    }
                }
            },
            Err(e) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(e, rolled))
            }
        }
    }

    fn commit_one_doc_write_unlocked(
        &self,
        doc_write: &DocWrite,
        options: &CommitOptions,
        fresh: bool,
        data_only: bool,
    ) -> Result<CommitResult, StorageError> {
        let table = self.runtime(&doc_write.table)?;
        validate_table_commit_source(&table.def, options)?;
        self.doc_write_unlocked(doc_write, &table, data_only)?;
        let changes = if options.includes_changes() {
            vec![RowChange {
                op: RowChangeOp::Write,
                table: doc_write.table.clone(),
                id: doc_write.id.clone(),
                row: Some(doc_write_row(doc_write)?),
            }]
        } else {
            Vec::new()
        };
        let changed_tables = vec![doc_write.table.clone()];
        let result = self.write_commit_unlocked(changed_tables, changes, options)?;
        if options.is_local() {
            let logical_clock = lock(&self.clock).now(wall_ms()?);
            self.write_dirty_head_unlocked(
                &RowKey {
                    document_id: doc_write.id.clone(),
                    table: doc_write.table.clone(),
                },
                RowChangeOp::Write,
                result.commit_seq,
                logical_clock as i64,
                logical_clock,
                fresh,
            )?;
        }
        if table.def.placement == TablePlacement::Device {
            self.origin_device_document_write_unlocked(doc_write)?;
        }
        self.origin_committed_mutation_write_unlocked(options, &result)?;
        self.write_push_envelope_unlocked(options, &result)?;
        Ok(result)
    }

    #[allow(clippy::too_many_arguments)]
    fn commit_one_doc_write_encoded_unlocked(
        &self,
        table_name: &str,
        id: &str,
        data: &str,
        encoded_cols: &[Vec<u8>],
        creation_time: f64,
        options: &CommitOptions,
        fresh: bool,
        data_only: bool,
    ) -> Result<CommitResult, StorageError> {
        let table = self.runtime(table_name)?;
        validate_table_commit_source(&table.def, options)?;
        self.doc_write_encoded_unlocked(
            table_name,
            id,
            data,
            encoded_cols,
            creation_time,
            &table,
            data_only,
        )?;
        let changes = if options.includes_changes() {
            vec![RowChange {
                op: RowChangeOp::Write,
                table: table_name.to_owned(),
                id: id.to_owned(),
                row: Some(materialized_row(id, creation_time, data)?),
            }]
        } else {
            Vec::new()
        };
        let result = self.write_commit_unlocked(vec![table_name.to_owned()], changes, options)?;
        if options.is_local() {
            let logical_clock = lock(&self.clock).now(wall_ms()?);
            self.write_dirty_head_unlocked(
                &RowKey {
                    document_id: id.to_owned(),
                    table: table_name.to_owned(),
                },
                RowChangeOp::Write,
                result.commit_seq,
                logical_clock as i64,
                logical_clock,
                fresh,
            )?;
        }
        if table.def.placement == TablePlacement::Device {
            self.origin_json_write_unlocked(
                OriginKind::DeviceDocument,
                &origin_key(&[table_name.as_bytes(), id.as_bytes()]),
                &serde_json::json!({
                    "table": table_name,
                    "id": id,
                    "data": data,
                    "columns": encoded_cols.iter().map(base64::encode).collect::<Vec<_>>(),
                    "creationTime": creation_time,
                }),
            )?;
        }
        self.origin_committed_mutation_write_unlocked(options, &result)?;
        self.write_push_envelope_unlocked(options, &result)?;
        Ok(result)
    }

    #[allow(
        clippy::too_many_lines,
        reason = "the transaction stages one ordered commit and must remain visibly atomic"
    )]
    fn commit_unlocked(
        &self,
        batch: &WriteBatch,
        options: &CommitOptions,
    ) -> Result<CommitResult, StorageError> {
        self.validate_batch_placement(batch, options)?;
        let changed_tables = changed_tables(batch);
        let changes = if options.includes_changes() {
            row_changes(batch)?
        } else {
            Vec::new()
        };
        for mapping in &batch.id_mappings {
            validate_ident(&mapping.table)?;
        }

        let crdt_seeds = if options.is_local() && !batch.crdt_ops.is_empty() {
            self.pre_capture_crdt_seeds_unlocked(batch)?
        } else {
            FxHashMap::default()
        };

        if batch.deletes.is_empty() && batch.doc_writes.len() == 1 {
            let doc_write = &batch.doc_writes[0];
            let table = self.runtime(&doc_write.table)?;
            let data_only = is_data_only_id(&batch.data_only_ids, &doc_write.table, &doc_write.id);
            self.doc_write_unlocked(doc_write, &table, data_only)?;
        } else if batch.doc_writes.is_empty() && batch.deletes.len() == 1 {
            let delete = &batch.deletes[0];
            let table = self.runtime(&delete.table)?;
            self.write_delete_unlocked(delete, &table)?;
        } else {
            let mut doc_write_tables: FxHashMap<String, Arc<TableRuntime>> = FxHashMap::default();
            for up in &batch.doc_writes {
                if !doc_write_tables.contains_key(&up.table) {
                    let table = self.runtime(&up.table)?;
                    doc_write_tables.insert(up.table.clone(), table);
                }
            }
            let mut delete_tables: FxHashMap<String, Arc<TableRuntime>> = FxHashMap::default();
            for del in &batch.deletes {
                if !delete_tables.contains_key(&del.table) {
                    let table = self.runtime(&del.table)?;
                    delete_tables.insert(del.table.clone(), table);
                }
            }

            for doc_write in &batch.doc_writes {
                let table = &doc_write_tables[&doc_write.table];
                let data_only =
                    is_data_only_id(&batch.data_only_ids, &doc_write.table, &doc_write.id);
                self.doc_write_unlocked(doc_write, table, data_only)?;
            }
            for delete in &batch.deletes {
                let table = &delete_tables[&delete.table];
                self.write_delete_unlocked(delete, table)?;
            }
        }
        for mapping in &batch.id_mappings {
            self.id_write_unlocked(mapping)?;
            self.origin_id_mapping_write_unlocked(mapping)?;
        }
        let logical_clock = if batch.local_field_writes.is_empty() {
            0.0
        } else {
            lock(&self.clock).now(wall_ms()?)
        };
        for write in &batch.local_field_writes {
            let value_json =
                serde_json::to_string(&write.value).map_err(|error| StorageError::Decode {
                    expected: "device field JSON value",
                    index: 0,
                    got: error.to_string(),
                })?;
            self.driver.execute(
                sql::write_local_field(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(write.table.clone()),
                    text_value(write.id.clone()),
                    text_value(write.field.clone()),
                    text_value(value_json),
                    Value::from_f64(logical_clock),
                ],
            )?;
            self.origin_local_field_write_unlocked(
                &write.table,
                &write.id,
                &write.field,
                &write.value,
            )?;
        }
        for delete in &batch.local_field_deletes {
            self.driver.execute(
                sql::delete_local_field(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(delete.table.clone()),
                    text_value(delete.id.clone()),
                    text_value(delete.field.clone()),
                ],
            )?;
            self.origin_delete_unlocked(
                OriginKind::LocalField,
                &origin_key(&[
                    delete.table.as_bytes(),
                    delete.id.as_bytes(),
                    delete.field.as_bytes(),
                ]),
            )?;
        }
        for job in &batch.schedules {
            self.schedule_write_unlocked(job)?;
            self.origin_schedule_write_unlocked(job)?;
        }
        let mut result = self.write_commit_unlocked(changed_tables, changes, options)?;
        for restore in &batch.crdt_restores {
            let definition = self.def(&restore.row.table)?;
            let field = definition
                .crdt_fields
                .iter()
                .find(|field| field.field == restore.field)
                .ok_or_else(|| {
                    StorageError::Unsatisfiable(format!(
                        "CRDT restore targets undeclared field {}.{}",
                        restore.row.table, restore.field
                    ))
                })?;
            if field.kind != restore.kind {
                return Err(StorageError::Unsatisfiable(format!(
                    "CRDT restore kind changed for {}.{}",
                    restore.row.table, restore.field
                )));
            }
            if restore.bytes.is_empty() {
                self.driver.execute(
                    sql::delete_crdt_field(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(restore.row.table.clone()),
                        text_value(restore.row.document_id.clone()),
                        text_value(restore.field.clone()),
                    ],
                )?;
                continue;
            }
            let mut hasher = Sha256::new();
            hasher.update(&restore.bytes);
            if hex(&hasher.finalize()) != restore.hash {
                return Err(StorageError::Unsatisfiable(
                    "CRDT restore checkpoint hash mismatch".to_owned(),
                ));
            }
            let state = crate::crdt::crdt_field_restore(
                &restore.bytes,
                restore.head_seq,
                restore.projection_hash.clone(),
            )?;
            self.write_crdt_field_state_unlocked(
                &restore.row.table,
                &restore.row.document_id,
                &restore.field,
                restore.kind,
                &state,
                result.commit_seq,
            )?;
        }
        if options.is_local() {
            self.write_dirty_heads_for_batch_unlocked(result.commit_seq, batch)?;
            self.write_crdt_ops_unlocked(result.commit_seq, &batch.crdt_ops)?;
            if !batch.crdt_ops.is_empty() {
                let peer_id = self.ensure_peer_id_unlocked(result.commit_seq)?;
                result.crdt_ops = self.capture_crdt_wire_ops_unlocked(
                    batch,
                    peer_id,
                    result.commit_seq,
                    &crdt_seeds,
                )?;
            }
        }
        for write in &batch.doc_writes {
            if self.def(&write.table)?.placement == TablePlacement::Device {
                self.origin_device_document_write_unlocked(write)?;
            }
        }
        for delete in &batch.deletes {
            if self.def(&delete.table)?.placement == TablePlacement::Device {
                self.origin_delete_unlocked(
                    OriginKind::DeviceDocument,
                    &origin_key(&[delete.table.as_bytes(), delete.id.as_bytes()]),
                )?;
            }
        }
        if options.is_local() {
            for op in &result.crdt_ops {
                let state = self
                    .read_crdt_field_state_unlocked(&op.table, &op.id, &op.field)?
                    .ok_or_else(|| {
                        StorageError::Unsatisfiable(
                            "committed CRDT effect has no materialized field state".to_owned(),
                        )
                    })?;
                let state_hash =
                    self.origin_payload_write_unlocked(&encode_crdt_field_state(&state))?;
                self.origin_json_write_unlocked(
                    OriginKind::CrdtEffect,
                    &origin_key(&[
                        result.commit_seq.to_be_bytes().as_slice(),
                        op.table.as_bytes(),
                        op.id.as_bytes(),
                        op.field.as_bytes(),
                    ]),
                    &serde_json::json!({
                        "commitSeq": result.commit_seq,
                        "table": op.table,
                        "id": op.id,
                        "field": op.field,
                        "kind": op.kind.as_wire(),
                        "stateHash": base64::encode(state_hash),
                        "update": base64::encode(&op.update),
                        "checkpoint": op.checkpoint.as_ref().map(|checkpoint| serde_json::json!({
                            "throughSeq": checkpoint.through_seq,
                            "bytes": base64::encode(&checkpoint.bytes),
                            "hash": checkpoint.hash,
                        })),
                    }),
                )?;
            }
        }
        self.origin_committed_mutation_write_unlocked(options, &result)?;
        self.write_push_envelope_unlocked(options, &result)?;
        #[cfg(debug_assertions)]
        self.debug_assert_rev_invariants();
        Ok(result)
    }

    fn validate_batch_placement(
        &self,
        batch: &WriteBatch,
        options: &CommitOptions,
    ) -> Result<(), StorageError> {
        if options.is_device()
            && (!batch.crdt_ops.is_empty()
                || !batch.crdt_restores.is_empty()
                || !batch.fresh_ids.is_empty()
                || !batch.data_only_ids.is_empty()
                || !batch.id_mappings.is_empty()
                || !batch.schedules.is_empty())
        {
            return Err(StorageError::Unsatisfiable(
                "device commits cannot contain replication metadata".to_owned(),
            ));
        }
        if !options.is_device()
            && (!batch.local_field_writes.is_empty() || !batch.local_field_deletes.is_empty())
        {
            return Err(StorageError::Unsatisfiable(
                "device field writes require a device commit".to_owned(),
            ));
        }
        for mapping in &batch.id_mappings {
            self.validate_id_mapping_table(&mapping.table)?;
        }
        for table_name in batch
            .doc_writes
            .iter()
            .map(|write| write.table.as_str())
            .chain(batch.deletes.iter().map(|delete| delete.table.as_str()))
        {
            let definition = self.def(table_name)?;
            validate_table_commit_source(&definition, options)?;
        }
        for (table_name, field) in batch
            .local_field_writes
            .iter()
            .map(|write| (write.table.as_str(), write.field.as_str()))
            .chain(
                batch
                    .local_field_deletes
                    .iter()
                    .map(|delete| (delete.table.as_str(), delete.field.as_str())),
            )
        {
            let definition = self.def(table_name)?;
            if definition.placement != TablePlacement::Replicated
                || !definition
                    .local_fields
                    .iter()
                    .any(|candidate| candidate.field == field)
            {
                return Err(StorageError::Unsatisfiable(format!(
                    "device field write targets undeclared field {table_name}.{field}"
                )));
            }
        }
        Ok(())
    }

    fn write_push_envelope_unlocked(
        &self,
        options: &CommitOptions,
        result: &CommitResult,
    ) -> Result<(), StorageError> {
        let Some(push) = options.push() else {
            return Ok(());
        };
        let envelope_json = push.json.as_str();
        let now_ms = push.now_ms;
        let mutation_id = push.mutation_id.as_str();
        let mut envelope: serde_json::Value =
            serde_json::from_str(envelope_json).map_err(|error| StorageError::Decode {
                expected: "push envelope JSON",
                index: 0,
                got: error.to_string(),
            })?;
        let object = envelope
            .as_object_mut()
            .ok_or_else(|| StorageError::Decode {
                expected: "push envelope object",
                index: 0,
                got: envelope_json.chars().take(32).collect(),
            })?;
        if object.get("mutationId").and_then(serde_json::Value::as_str) != Some(mutation_id) {
            return Err(StorageError::Unsatisfiable(
                "push envelope mutation id does not match commit".to_owned(),
            ));
        }
        object.insert(
            "commitSeq".to_owned(),
            serde_json::Value::from(result.commit_seq),
        );
        let effects = object
            .get_mut("crdt")
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| StorageError::Decode {
                expected: "push envelope crdt array",
                index: 0,
                got: "missing crdt".to_owned(),
            })?;
        if effects.len() != result.crdt_ops.len() {
            return Err(StorageError::Unsatisfiable(format!(
                "push envelope has {} CRDT effects for {} committed operations",
                effects.len(),
                result.crdt_ops.len()
            )));
        }
        for (effect, op) in effects.iter_mut().zip(&result.crdt_ops) {
            let effect = effect.as_object_mut().ok_or_else(|| StorageError::Decode {
                expected: "push envelope CRDT effect object",
                index: 0,
                got: "non-object effect".to_owned(),
            })?;
            let matches = effect.get("table").and_then(serde_json::Value::as_str)
                == Some(op.table.as_str())
                && effect.get("rowId").and_then(serde_json::Value::as_str) == Some(op.id.as_str())
                && effect.get("field").and_then(serde_json::Value::as_str)
                    == Some(op.field.as_str())
                && effect.get("kind").and_then(serde_json::Value::as_str)
                    == Some(op.kind.as_wire());
            if !matches {
                return Err(StorageError::Unsatisfiable(
                    "push envelope CRDT effects do not match committed operations".to_owned(),
                ));
            }
            effect.insert(
                "payload".to_owned(),
                serde_json::json!({ "$bytes": base64::encode(&op.update) }),
            );
            if let Some(checkpoint) = &op.checkpoint {
                effect.insert(
                    "checkpoint".to_owned(),
                    serde_json::json!({
                        "throughSeq": checkpoint.through_seq,
                        "bytes": { "$bytes": base64::encode(&checkpoint.bytes) },
                        "hash": checkpoint.hash,
                    }),
                );
            }
        }
        let envelope_json =
            serde_json::to_string(&envelope).map_err(|error| StorageError::Decode {
                expected: "encoded push envelope",
                index: 0,
                got: error.to_string(),
            })?;
        self.driver.execute(
            sql::write_remote_cursor(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(format!("{REMOTE_PUSH_ENVELOPE_PREFIX}{mutation_id}")),
                Value::from_i64(result.commit_seq),
                text_value(envelope_json.clone()),
                Value::from_i64(now_ms),
            ],
        )?;
        self.origin_write_unlocked(
            OriginKind::PushEnvelope,
            mutation_id.as_bytes(),
            envelope_json.as_bytes(),
        )
    }

    fn doc_write_unlocked(
        &self,
        doc_write: &DocWrite,
        table: &TableRuntime,
        data_only: bool,
    ) -> Result<(), StorageError> {
        validate_replicated_doc_data(&table.def, &doc_write.data)?;
        if data_only {
            self.driver.execute(
                &table.update_data_sql,
                [
                    text_value(doc_write.data.clone()),
                    text_value(self.identity_key.clone()),
                    text_value(doc_write.id.clone()),
                ],
            )?;
            if self.driver.changes() == 0 {
                return Err(StorageError::Unsatisfiable(format!(
                    "data-only update target was missing: {} {}",
                    doc_write.table, doc_write.id
                )));
            }
            return Ok(());
        }
        let mut params = Vec::with_capacity(4 + table.def.columns.len());
        params.push(text_value(doc_write.id.clone()));
        params.push(text_value(self.identity_key.clone()));
        params.push(Value::from_f64(doc_write.creation_time));
        params.push(text_value(doc_write.data.clone()));
        if cols_are_in_table_order(doc_write, table) {
            for (_, value) in &doc_write.cols {
                params.push(Value::Blob(value.encode_key()));
            }
        } else {
            let mut cols = vec![ColValue::Undefined; table.def.columns.len()];
            for (name, value) in &doc_write.cols {
                if let Some(&index) = table.column_positions.get(name) {
                    cols[index] = value.clone();
                }
            }
            for value in cols {
                params.push(Value::Blob(value.encode_key()));
            }
        }
        self.driver.execute(&table.doc_write_sql, params)
    }

    #[allow(clippy::too_many_arguments)]
    fn doc_write_encoded_unlocked(
        &self,
        table_name: &str,
        id: &str,
        data: &str,
        encoded_cols: &[Vec<u8>],
        creation_time: f64,
        table: &TableRuntime,
        data_only: bool,
    ) -> Result<(), StorageError> {
        validate_replicated_doc_data(&table.def, data)?;
        if data_only {
            self.driver.execute(
                &table.update_data_sql,
                [
                    text_value(data.to_owned()),
                    text_value(self.identity_key.clone()),
                    text_value(id.to_owned()),
                ],
            )?;
            if self.driver.changes() == 0 {
                return Err(StorageError::Unsatisfiable(format!(
                    "data-only update target was missing: {table_name} {id}"
                )));
            }
            return Ok(());
        }
        if encoded_cols.len() != table.def.columns.len() {
            return Err(StorageError::Decode {
                expected: "one encoded key per table column",
                index: encoded_cols.len(),
                got: format!("{} columns for {}", table.def.columns.len(), table_name),
            });
        }
        let mut params = Vec::with_capacity(4 + encoded_cols.len());
        params.push(text_value(id.to_owned()));
        params.push(text_value(self.identity_key.clone()));
        params.push(Value::from_f64(creation_time));
        params.push(text_value(data.to_owned()));
        for value in encoded_cols {
            params.push(Value::Blob(value.clone()));
        }
        self.driver.execute(&table.doc_write_sql, params)
    }

    fn write_delete_unlocked(
        &self,
        delete: &DeleteIn,
        table: &TableRuntime,
    ) -> Result<(), StorageError> {
        debug_assert!(is_valid_ident(&delete.table));
        self.driver.execute(
            &table.delete_sql,
            [
                text_value(self.identity_key.clone()),
                text_value(delete.id.clone()),
            ],
        )
    }

    /// Walk every row's rev set and panic if a universal structural invariant (≤1 `Current`,
    /// acyclic parents) is violated. Debug-only (compiled out of release) and unlocked — callers
    /// hold `operation_lock`. Best-effort: a read error here must not mask the real operation, so it
    /// returns quietly rather than reporting a false failure.
    #[cfg(debug_assertions)]
    fn debug_assert_rev_invariants(&self) {
        let mut rows: Vec<RowKey> = Vec::new();
        let mut seen: FxHashSet<RowKey> = FxHashSet::default();
        let collected = self.driver.run_rows(
            sql::read_rev_frontiers(),
            vec![text_value(self.identity_key.clone())],
            |row| {
                let frontier = row_to_rev_frontier(row)?;
                if seen.insert(frontier.key.row.clone()) {
                    rows.push(frontier.key.row);
                }
                Ok(())
            },
        );
        if collected.is_err() {
            return;
        }
        for row in &rows {
            let mut revs: Vec<RevState> = Vec::new();
            let read = self.driver.run_rows(
                sql::read_document_revs(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(row.table.clone()),
                    text_value(row.document_id.clone()),
                ],
                |data| {
                    revs.push(RevState {
                        key: RevKey {
                            rev_id: text_at(data, 0)?,
                            row: row.clone(),
                        },
                        snapshot: blob_at(data, 1)?,
                        log: Vec::new(),
                        frontier: blob_at(data, 2)?,
                        lifecycle: rev_lifecycle_at(data, 3)?,
                        updated_time: int_at(data, 10)?,
                    });
                    Ok(())
                },
            );
            if read.is_err() {
                return;
            }
            if let Err(violation) = crate::invariant::check_rev_set(&revs) {
                panic!("rev-graph invariant violated: {violation}");
            }
        }
    }

    /// Delete ledger rows at or below `up_to_seq`, a consumer watermark. The newest commit row
    /// is always retained so `commit_seq` stays monotonic across deletion; mutations that never
    /// committed (accepted/failed) are never touched. Remote delivery can pass its delivered
    /// watermark as `up_to_seq`; this method remains a generic consumer-watermark deletion.
    pub fn ledger_delete(&self, up_to_seq: i64) -> Result<DeleteResult, StorageError> {
        let _guard = lock(&self.operation_lock);
        let max_seq = self
            .driver
            .run_row(
                sql::max_commit_seq(),
                max_commit_seq_params(&self.identity_key.clone()),
                |row| int_at(row, 0),
            )?
            .unwrap_or(0);
        let bound = up_to_seq.min(max_seq - 1);
        if bound < 1 {
            return Ok(DeleteResult::default());
        }
        self.driver.execute(
            sql::delete_commits(),
            vec![
                text_value(self.identity_key.clone()),
                Value::from_i64(bound),
            ],
        )?;
        let commits_deleted = self.driver.changes();
        let mutations_deleted = if bound >= 1 {
            self.driver.execute(
                sql::delete_mutations(),
                vec![
                    text_value(self.identity_key.clone()),
                    Value::from_i64(bound),
                ],
            )?;
            self.driver.changes()
        } else {
            0
        };
        Ok(DeleteResult {
            commits_deleted,
            mutations_deleted,
        })
    }

    pub fn remote_cursor_read(&self, subscription: &str) -> Result<Option<String>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver
            .run_row(
                sql::read_remote_cursor(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(remote_cursor_key_encode(subscription)),
                ],
                |row| optional_text_at(row, 0),
            )
            .map(Option::flatten)
    }

    pub fn remote_progress_has(&self) -> Result<bool, StorageError> {
        let _guard = lock(&self.operation_lock);
        Ok(self
            .driver
            .run_row(
                sql::remote_progress_has(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(format!("{REMOTE_CURSOR_PREFIX}%")),
                ],
                |_row| Ok(()),
            )?
            .is_some())
    }

    pub fn remote_subscription_read(&self) -> Result<Vec<String>, StorageError> {
        let _guard = lock(&self.operation_lock);
        let mut subscriptions = Vec::new();
        self.driver.run_rows(
            sql::read_subscriptions(),
            vec![text_value(self.identity_key.clone())],
            |row| {
                subscriptions.push(text_at(row, 0)?);
                Ok(())
            },
        )?;
        subscriptions.sort();
        Ok(subscriptions)
    }

    pub fn remote_member_read(
        &self,
        subscription: &str,
    ) -> Result<Vec<RemoteMember>, StorageError> {
        let _guard = lock(&self.operation_lock);
        let mut members = Vec::new();
        self.driver.run_rows(
            sql::read_membership(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(subscription.to_owned()),
            ],
            |row| {
                members.push(RemoteMember {
                    table: text_at(row, 0)?,
                    server_document_id: text_at(row, 1)?,
                });
                Ok(())
            },
        )?;
        members.sort_by(|left, right| {
            (&left.table, &left.server_document_id).cmp(&(&right.table, &right.server_document_id))
        });
        Ok(members)
    }

    #[cfg(any(test, feature = "testkit"))]
    pub fn subscription_membership_read(
        &self,
        subscription: &str,
    ) -> Result<Vec<RemoteMember>, StorageError> {
        self.remote_member_read(subscription)
    }

    /// Inject a queued envelope for protocol tests that need a server-authored or malformed state.
    /// Production callers can enqueue only through [`Self::commit`].
    #[cfg(any(test, feature = "testkit"))]
    #[doc(hidden)]
    pub fn remote_push_envelope_write(
        &self,
        op_id: &str,
        ordinal: i64,
        envelope_json: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(
            sql::write_remote_cursor(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(format!("{REMOTE_PUSH_ENVELOPE_PREFIX}{op_id}")),
                Value::from_i64(ordinal),
                text_value(envelope_json.to_owned()),
                Value::from_i64(now_ms),
            ],
        )
    }

    /// Pending push envelope JSON in local commit order, bounded by `num_items` (§11 D2).
    pub fn remote_push_envelope_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        if num_items == 0 {
            return Ok(Vec::new());
        }
        let _guard = lock(&self.operation_lock);
        let mut envelopes = Vec::with_capacity(num_items);
        self.driver.run_rows_until(
            sql::read_remote_push_envelopes(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(REMOTE_PUSH_ENVELOPE_PREFIX.to_owned()),
                text_value(REMOTE_PUSH_ENVELOPE_PREFIX_END.to_owned()),
            ],
            |row| {
                envelopes.push(text_at(row, 1)?);
                Ok(if envelopes.len() == num_items {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                })
            },
        )?;
        Ok(envelopes)
    }

    /// Atomically rotate only the hosted replay-attempt id for an exact queued mutation.
    ///
    /// The logical mutation id, commit sequence, CRDT payloads, and every local document row stay
    /// unchanged. This is intentionally compare-and-swap shaped so a crashed recovery retries the
    /// already-persisted attempt instead of creating another one.
    pub fn remote_push_replay_write(
        &self,
        mutation_id: &str,
        expected_commit_seq: i64,
        expected_replay_id: &str,
        replay_id: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        if replay_id.is_empty() || replay_id == expected_replay_id {
            return Err(StorageError::Unsatisfiable(
                "remote replay id rotation requires a distinct non-empty id".to_owned(),
            ));
        }
        let _guard = lock(&self.operation_lock);
        let watermark = format!("{REMOTE_PUSH_ENVELOPE_PREFIX}{mutation_id}");
        let commit_seq = self
            .driver
            .run_row(
                sql::read_remote_commit_seq(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(watermark.clone()),
                ],
                |row| int_at(row, 0),
            )?
            .ok_or_else(|| {
                StorageError::Unsatisfiable(format!(
                    "push envelope {mutation_id} must exist before replay rotation"
                ))
            })?;
        if commit_seq != expected_commit_seq {
            return Err(StorageError::Unsatisfiable(format!(
                "push replay commit sequence {expected_commit_seq} does not match queued sequence {commit_seq}"
            )));
        }
        let envelope_json = self
            .driver
            .run_row(
                sql::read_remote_cursor(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(watermark.clone()),
                ],
                |row| optional_text_at(row, 0),
            )?
            .flatten()
            .ok_or_else(|| {
                StorageError::Unsatisfiable(format!(
                    "push envelope {mutation_id} has no replay payload"
                ))
            })?;
        let mut envelope: serde_json::Value =
            serde_json::from_str(&envelope_json).map_err(|error| StorageError::Decode {
                expected: "push envelope JSON",
                index: 0,
                got: error.to_string(),
            })?;
        let object = envelope
            .as_object_mut()
            .ok_or_else(|| StorageError::Decode {
                expected: "push envelope object",
                index: 0,
                got: "non-object".to_owned(),
            })?;
        if object.get("mutationId").and_then(serde_json::Value::as_str) != Some(mutation_id) {
            return Err(StorageError::Unsatisfiable(
                "rotated replay does not match its logical mutation id".to_owned(),
            ));
        }
        let current_replay_id = object
            .get("replayId")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(mutation_id);
        if current_replay_id != expected_replay_id {
            return Err(StorageError::Unsatisfiable(format!(
                "push replay id changed from expected {expected_replay_id}"
            )));
        }
        object.insert(
            "replayId".to_owned(),
            serde_json::Value::String(replay_id.to_owned()),
        );
        let encoded = serde_json::to_string(&envelope).map_err(|error| StorageError::Decode {
            expected: "encoded push envelope",
            index: 0,
            got: error.to_string(),
        })?;
        self.driver.execute(
            sql::write_remote_cursor(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(watermark),
                Value::from_i64(commit_seq),
                text_value(encoded),
                Value::from_i64(now_ms),
            ],
        )
    }

    /// Exact durable work counts used by the remote actor's convergence snapshot.
    pub fn remote_pending_read(&self) -> Result<RemotePending, StorageError> {
        let _guard = lock(&self.operation_lock);
        let range = |start: &str, end: &str| {
            self.driver
                .run_row(
                    sql::read_remote_pending(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(start.to_owned()),
                        text_value(end.to_owned()),
                    ],
                    |row| int_at(row, 0),
                )
                .map(|value| value.unwrap_or(0).max(0) as usize)
        };
        let mutations = range(REMOTE_PUSH_ENVELOPE_PREFIX, REMOTE_PUSH_ENVELOPE_PREFIX_END)?;
        let settlements = range(REMOTE_RECEIPT_PREFIX, REMOTE_RECEIPT_PREFIX_END)?;
        let uploads = self
            .driver
            .run_row(
                sql::read_upload_pending(),
                vec![text_value(self.identity_key.clone())],
                |row| int_at(row, 0),
            )?
            .unwrap_or(0)
            .max(0) as usize;
        Ok(RemotePending {
            mutations,
            settlements,
            uploads,
        })
    }

    /// Apply every local consequence of one terminal hosted push verdict in one transaction.
    pub fn remote_settlement_write(
        &self,
        settlement: &RemoteSettlementWrite,
    ) -> Result<RemoteSettlementWriteResult, StorageError> {
        self.validate_remote_push_settlement(settlement)?;
        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written = self.remote_settlement_write_unlocked(settlement);
        match written {
            Ok(result) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => {
                    self.observe_commit_results(&result.projection.committed);
                    let projections = match &settlement.outcome {
                        RemoteSettlementOutcome::Applied { projections, .. }
                        | RemoteSettlementOutcome::Rejected { projections, .. } => projections,
                    };
                    self.observe_authoritative_clocks(projections);
                    Ok(result)
                }
                Err(error) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(error, rolled))
                }
            },
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(error, rolled))
            }
        }
    }

    fn remote_settlement_write_unlocked(
        &self,
        settlement: &RemoteSettlementWrite,
    ) -> Result<RemoteSettlementWriteResult, StorageError> {
        let commit_seq = self.remote_push_commit_seq_unlocked(settlement)?;
        let projection = match &settlement.outcome {
            RemoteSettlementOutcome::Applied {
                ids,
                schedules,
                projections,
                crdt,
            } => self.remote_push_apply_unlocked(
                settlement,
                commit_seq,
                ids,
                schedules,
                projections,
                crdt,
            )?,
            RemoteSettlementOutcome::Rejected {
                schedules,
                targets,
                projections,
            } => self.remote_push_reject_unlocked(
                settlement,
                commit_seq,
                schedules,
                targets,
                projections,
            )?,
        };
        Ok(RemoteSettlementWriteResult { projection })
    }

    fn remote_push_commit_seq_unlocked(
        &self,
        settlement: &RemoteSettlementWrite,
    ) -> Result<i64, StorageError> {
        let watermark = format!("{REMOTE_PUSH_ENVELOPE_PREFIX}{}", settlement.mutation_id);
        let commit_seq = self
            .driver
            .run_row(
                sql::read_remote_commit_seq(),
                vec![text_value(self.identity_key.clone()), text_value(watermark)],
                |row| int_at(row, 0),
            )?
            .ok_or_else(|| {
                StorageError::Unsatisfiable(format!(
                    "push envelope {} must exist before settlement",
                    settlement.mutation_id
                ))
            })?;
        if commit_seq != settlement.expected_commit_seq {
            return Err(StorageError::Unsatisfiable(format!(
                "push settlement commit sequence {} does not match queued sequence {commit_seq}",
                settlement.expected_commit_seq
            )));
        }
        Ok(commit_seq)
    }

    fn remote_push_apply_unlocked(
        &self,
        settlement: &RemoteSettlementWrite,
        commit_seq: i64,
        ids: &[crate::types::RemoteIdMapping],
        schedules: &[crate::types::RemoteScheduleMapping],
        projections: &[AuthoritativeRow],
        crdt: &[crate::types::CrdtRemoteWrite],
    ) -> Result<AuthoritativeApplyResult, StorageError> {
        self.schedule_remote_complete_unlocked(schedules, settlement.now_ms)?;
        for mapping in ids {
            self.projection_map_remote_id_unlocked(
                &mapping.table,
                &mapping.server_document_id,
                Some(&mapping.local_document_id),
                settlement.now_ms,
            )?;
        }
        for projection in projections
            .iter()
            .filter(|projection| projection.row.is_none())
        {
            let mapping = self.projection_map_remote_id_unlocked(
                &projection.table,
                &projection.server_document_id,
                projection.local_document_id.as_deref(),
                settlement.now_ms,
            )?;
            let confirmed_own_delete = self
                .read_dirty_head_unlocked(&projection.table, &mapping.local_id)?
                .is_some_and(|head| {
                    head.updated_commit_seq == settlement.expected_commit_seq
                        && head.change.op == RowChangeOp::Delete
                });
            if confirmed_own_delete {
                self.driver.execute(
                    sql::delete_local_fields_row(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(projection.table.clone()),
                        text_value(mapping.local_id),
                    ],
                )?;
            }
        }
        let projection =
            self.remote_settle_applied_unlocked(projections, settlement.expected_commit_seq)?;
        self.remote_push_complete_unlocked(
            &settlement.mutation_id,
            crdt,
            settlement.now_ms,
            commit_seq,
        )?;
        Ok(projection)
    }

    fn remote_push_reject_unlocked(
        &self,
        settlement: &RemoteSettlementWrite,
        commit_seq: i64,
        schedules: &[String],
        targets: &[crate::types::RemoteRowTarget],
        projections: &[AuthoritativeRow],
    ) -> Result<AuthoritativeApplyResult, StorageError> {
        for job_id in schedules {
            self.schedule_fail_unlocked(job_id, settlement.now_ms)?;
        }
        let mut committed = Vec::new();
        let mut reroots = Vec::new();
        for target in targets {
            let (reroot, commit) = self.remote_settle_rejected_dirty_unlocked(
                &target.table,
                &target.local_document_id,
                target.server_rev_id.as_deref(),
                target.retain,
                settlement.expected_commit_seq,
                settlement.now_ms,
            )?;
            reroots.extend(reroot);
            committed.extend(commit);
        }
        let authoritative =
            self.remote_settle_applied_unlocked(projections, settlement.expected_commit_seq)?;
        for reroot in &mut reroots {
            if let Some(winner) = projections.iter().find(|projection| {
                projection.table == reroot.table
                    && projection.local_document_id.as_deref()
                        == Some(reroot.local_document_id.as_str())
            }) {
                reroot.server_document_id = Some(winner.server_document_id.clone());
                reroot.current_root_id.clone_from(&winner.current_root_id);
            }
        }
        committed.extend(authoritative.committed);
        reroots.extend(authoritative.reroots);
        self.remote_push_complete_unlocked(
            &settlement.mutation_id,
            &[],
            settlement.now_ms,
            commit_seq,
        )?;
        Ok(AuthoritativeApplyResult { committed, reroots })
    }

    fn remote_push_complete_unlocked(
        &self,
        op_id: &str,
        crdt: &[crate::types::CrdtRemoteWrite],
        now_ms: i64,
        commit_seq: i64,
    ) -> Result<(), StorageError> {
        for write in crdt {
            let mut state = self
                .read_crdt_field_state_unlocked(&write.table, &write.id, &write.field)?
                .ok_or_else(|| {
                    StorageError::Unsatisfiable(format!(
                        "settled CRDT field is missing: {}.{}:{}",
                        write.table, write.field, write.id
                    ))
                })?;
            if state.server_seq > write.head_seq {
                continue;
            }
            if state.server_seq == write.head_seq
                && state.server_projection_hash != write.projection_hash
            {
                return Err(StorageError::Unsatisfiable(format!(
                    "settled CRDT head changed at sequence {}",
                    write.head_seq
                )));
            }
            if state.server_seq == write.head_seq {
                continue;
            }
            crate::crdt::crdt_field_settle(
                &mut state,
                write.kind,
                &write.payload,
                write.head_seq,
                &write.projection_hash,
            )?;
            self.write_crdt_field_state_unlocked(
                &write.table,
                &write.id,
                &write.field,
                write.kind,
                &state,
                now_ms,
            )?;
        }
        let push_watermark = format!("{REMOTE_PUSH_ENVELOPE_PREFIX}{op_id}");
        let replay_id = self
            .driver
            .run_row(
                sql::read_remote_cursor(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(push_watermark.clone()),
                ],
                |row| optional_text_at(row, 0),
            )?
            .flatten()
            .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
            .and_then(|value| {
                value
                    .get("replayId")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| op_id.to_owned());
        self.driver.execute(
            sql::write_remote_cursor(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(format!("{REMOTE_RECEIPT_PREFIX}{replay_id}")),
                Value::from_i64(commit_seq),
                text_value(replay_id.clone()),
                Value::from_i64(0),
            ],
        )?;
        self.origin_json_write_unlocked(
            OriginKind::SettlementReceipt,
            replay_id.as_bytes(),
            &serde_json::json!({
                "replayId": replay_id,
                "mutationId": op_id,
                "commitSeq": commit_seq,
            }),
        )?;
        self.driver.execute(
            sql::delete_remote_cursor(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(push_watermark),
            ],
        )?;
        self.origin_delete_unlocked(OriginKind::PushEnvelope, op_id.as_bytes())?;
        self.origin_delete_unlocked(OriginKind::Mutation, op_id.as_bytes())?;
        for write in crdt {
            self.origin_delete_unlocked(
                OriginKind::CrdtEffect,
                &origin_key(&[
                    commit_seq.to_be_bytes().as_slice(),
                    write.table.as_bytes(),
                    write.id.as_bytes(),
                    write.field.as_bytes(),
                ]),
            )?;
        }
        Ok(())
    }

    pub fn remote_receipt_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        if num_items == 0 {
            return Ok(Vec::new());
        }
        let _guard = lock(&self.operation_lock);
        let mut mutation_ids = Vec::with_capacity(num_items);
        self.driver.run_rows_until(
            sql::read_remote_push_envelopes(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(REMOTE_RECEIPT_PREFIX.to_owned()),
                text_value(REMOTE_RECEIPT_PREFIX_END.to_owned()),
            ],
            |row| {
                mutation_ids.push(text_at(row, 1)?);
                Ok(if mutation_ids.len() == num_items {
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                })
            },
        )?;
        Ok(mutation_ids)
    }

    pub fn remote_receipt_delete(&self, mutation_ids: &[String]) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.transaction_unlocked(|| {
            for mutation_id in mutation_ids {
                self.driver.execute(
                    sql::delete_remote_cursor(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(format!("{REMOTE_RECEIPT_PREFIX}{mutation_id}")),
                    ],
                )?;
                self.origin_delete_unlocked(OriginKind::SettlementReceipt, mutation_id.as_bytes())?;
            }
            Ok(())
        })
    }

    #[cfg(any(test, feature = "testkit"))]
    pub fn remote_cursor_write(
        &self,
        subscription: &str,
        cursor: Option<String>,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(
            sql::write_remote_cursor(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(remote_cursor_key_encode(subscription)),
                Value::from_i64(0),
                cursor.map_or(Value::Null, text_value),
                Value::from_i64(now_ms),
            ],
        )
    }

    /// Read a binary blob by key.
    pub fn blob_read(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.run_row(
            sql::read_blob(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(key.to_owned()),
            ],
            |row| blob_at(row, 0),
        )
    }

    /// Write (insert or replace) a binary blob.
    pub fn blob_write(&self, key: &str, bytes: Vec<u8>) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(
            sql::write_blob(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(key.to_owned()),
                Value::Blob(bytes),
            ],
        )
    }

    /// Delete a binary blob.
    pub fn blob_delete(&self, key: &str) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(
            sql::delete_blob(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(key.to_owned()),
            ],
        )
    }

    /// Point-read one retained authored-result entry by its `ResultKey` hash (§4 pull apply /
    /// cache-serve). The key is a global hash, so no partition filter is required.
    pub fn result_read(&self, key: &str) -> Result<Option<ResultEntry>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.result_read_unlocked(key)
    }

    fn result_read_unlocked(&self, key: &str) -> Result<Option<ResultEntry>, StorageError> {
        self.driver.run_row(
            sql::read_result(),
            vec![text_value(key.to_owned())],
            |row| {
                Ok(ResultEntry {
                    key: key.to_owned(),
                    function: text_at(row, 0)?,
                    args: text_at(row, 1)?,
                    schema_hash: text_at(row, 2)?,
                    module_hash: text_at(row, 3)?,
                    skeleton: blob_at(row, 4)?,
                    paths: blob_at(row, 5)?,
                    skeleton_hash: text_at(row, 6)?,
                    clock: real_at(row, 7)?,
                })
            },
        )
    }

    /// Write (`doc_write`) one retained authored-result entry, returning `true` iff a durable write
    /// occurred (§3/§5): the zero-write fast path skips when the stored `skeleton_hash` already
    /// equals the incoming one. The unlocked variant lets S3 call it inside the pull-page transaction.
    pub fn result_write(&self, entry: &ResultEntry) -> Result<bool, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.result_write_unlocked(entry)
    }

    pub(crate) fn result_write_unlocked(&self, entry: &ResultEntry) -> Result<bool, StorageError> {
        let stored = self.driver.run_row(
            sql::read_result_skeleton_hash(),
            vec![text_value(entry.key.clone())],
            |row| text_at(row, 0),
        )?;
        if stored.as_deref() == Some(entry.skeleton_hash.as_str()) {
            return Ok(false);
        }
        self.driver.execute(
            sql::write_result(),
            vec![
                text_value(entry.key.clone()),
                text_value(entry.function.clone()),
                text_value(entry.args.clone()),
                text_value(self.identity_key.clone()),
                text_value(entry.schema_hash.clone()),
                text_value(entry.module_hash.clone()),
                Value::Blob(entry.skeleton.clone()),
                Value::Blob(entry.paths.clone()),
                text_value(entry.skeleton_hash.clone()),
                Value::from_f64(entry.clock),
            ],
        )?;
        Ok(true)
    }

    /// Delete one retained authored-result entry by key (watch stop / runtime-driven orphan, §6).
    pub fn result_delete(&self, key: &str) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.result_delete_unlocked(key)
    }

    pub(crate) fn result_delete_unlocked(&self, key: &str) -> Result<(), StorageError> {
        self.driver
            .execute(sql::delete_result(), vec![text_value(key.to_owned())])
    }

    /// Delete the identity's retained-result entries (§6), returning the count deleted: an entry goes
    /// if its key is absent from the live-watch `keep` set (edge-orphan) OR its runtime identity no
    /// longer matches the current `schema_hash`/`module_hash` (release rotation).
    pub fn result_stale_delete(
        &self,
        keep: &FxHashSet<String>,
        schema_hash: &str,
        module_hash: &str,
    ) -> Result<usize, StorageError> {
        let _guard = lock(&self.operation_lock);
        let mut stale = Vec::new();
        self.driver.run_rows(
            sql::result_stale_read(),
            vec![text_value(self.identity_key.clone())],
            |row| {
                let key = text_at(row, 0)?;
                let entry_schema = text_at(row, 1)?;
                let entry_module = text_at(row, 2)?;
                if !keep.contains(&key)
                    || entry_schema != schema_hash
                    || entry_module != module_hash
                {
                    stale.push(key);
                }
                Ok(())
            },
        )?;
        for key in &stale {
            self.result_delete_unlocked(key)?;
        }
        Ok(stale.len())
    }

    /// Read a subscription's stored index-range descriptor (§4.5) for S4's range-coverage check. All
    /// of a subscription's edges carry the same descriptor, so the first row answers.
    pub fn membership_range_read(
        &self,
        subscription: &str,
    ) -> Result<Option<MembershipRange>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.run_row(
            sql::read_membership_range(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(subscription.to_owned()),
            ],
            |row| {
                Ok(MembershipRange {
                    lower: optional_text_at(row, 0)?,
                    upper: optional_text_at(row, 1)?,
                    order: optional_text_at(row, 2)?,
                })
            },
        )
    }

    pub fn rev_write(&self, state: &RevState) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.transaction_unlocked(|| {
            self.rev_write_unlocked(state, state.updated_time)?;
            self.origin_revision_write_unlocked(state)
        })
    }

    /// Apply a local CRDT intent to one collaborative field (§8-A). Reads the field's stored
    /// checkpoint+log, applies the intent, re-persists, and returns the Loro update delta the driver
    /// carries verbatim on the one push (`PushCall.crdt_ops`).
    pub fn crdt_field_intent_write(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: crate::types::CrdtFieldKind,
        op: &CrdtOperation,
        now_ms: i64,
    ) -> Result<Vec<u8>, StorageError> {
        let _guard = lock(&self.operation_lock);
        let peer_id = self.ensure_peer_id_unlocked(now_ms)?;
        let seed = self.read_plain_field_value_unlocked(table, id, field)?;
        self.crdt_field_intent_write_unlocked(
            table,
            id,
            field,
            kind,
            op,
            peer_id,
            now_ms,
            seed.as_ref(),
        )
        .map(|(update, _)| update)
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "the parameters are the complete identity and causal state of one CRDT field write"
    )]
    fn crdt_field_intent_write_unlocked(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: crate::types::CrdtFieldKind,
        op: &CrdtOperation,
        peer_id: u64,
        now_ms: i64,
        seed: Option<&serde_json::Value>,
    ) -> Result<(Vec<u8>, Option<crate::types::CrdtCheckpoint>), StorageError> {
        let prev = self.read_crdt_field_state_unlocked(table, id, field)?;
        let first_touch = prev.is_none();
        let seed = if first_touch { seed } else { None };
        let (state, update) =
            crate::crdt::crdt_field_intent_write(prev.as_ref(), kind, op, peer_id, seed)?;
        self.write_crdt_field_state_unlocked(table, id, field, kind, &state, now_ms)?;
        let checkpoint = if first_touch {
            let bytes = crate::crdt::crdt_field_snapshot(&state)?;
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            Some(crate::types::CrdtCheckpoint {
                through_seq: 1,
                bytes,
                hash: hex(&hasher.finalize()),
            })
        } else {
            None
        };
        Ok((update, checkpoint))
    }

    /// Snapshot each first-touch CRDT field's PRE-batch plain value so a seed reflects the value
    /// before this commit's own `doc_write` materialized the edit into the row (§8-A). A field that
    /// already has Loro state is not first-touch and needs no seed; the seed for it stays absent.
    fn pre_capture_crdt_seeds_unlocked(
        &self,
        batch: &WriteBatch,
    ) -> Result<FxHashMap<(String, String, String), serde_json::Value>, StorageError> {
        let mut seeds = FxHashMap::default();
        for op in &batch.crdt_ops {
            let key = (
                op.row.table.clone(),
                op.row.document_id.clone(),
                op.field.clone(),
            );
            if seeds.contains_key(&key) {
                continue;
            }
            if self
                .read_crdt_field_state_unlocked(&op.row.table, &op.row.document_id, &op.field)?
                .is_some()
            {
                continue;
            }
            if let Some(value) =
                self.read_plain_field_value_unlocked(&op.row.table, &op.row.document_id, &op.field)?
            {
                seeds.insert(key, value);
            }
        }
        Ok(seeds)
    }

    /// Read the row's current plain value for a (possibly nested) field from the durable
    /// `doc__<table>.data` column, used to deterministically seed a CRDT field's first Loro op.
    fn read_plain_field_value_unlocked(
        &self,
        table: &str,
        id: &str,
        field: &str,
    ) -> Result<Option<serde_json::Value>, StorageError> {
        let Some(row_json) = self.doc_read_unlocked(table, id)? else {
            return Ok(None);
        };
        let value = parse_json_row(&row_json)?;
        Ok(read_json_path(&value, field).cloned())
    }

    /// Merge a remote CRDT update (a pulled `crdt` `RowChange`, §3) into one field, re-persist, and
    /// return the merged materialized value so the caller writes it into the local replica column.
    pub fn crdt_field_update_write(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: crate::types::CrdtFieldKind,
        update: &[u8],
        now_ms: i64,
    ) -> Result<serde_json::Value, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.crdt_field_update_write_unlocked(table, id, field, kind, update, now_ms)
    }

    fn crdt_field_update_write_unlocked(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: crate::types::CrdtFieldKind,
        update: &[u8],
        now_ms: i64,
    ) -> Result<serde_json::Value, StorageError> {
        let prev = self.read_crdt_field_state_unlocked(table, id, field)?;
        let state = crate::crdt::crdt_field_update_write(prev.as_ref(), update)?;
        self.write_crdt_field_state_unlocked(table, id, field, kind, &state, now_ms)?;
        crate::crdt::crdt_field_value(&state, kind)
    }

    /// Resolve a declared CRDT field's kind from the table schema, or `None` when the field is not a
    /// collaborative field.
    fn crdt_kind_unlocked(
        &self,
        table: &str,
        field: &str,
    ) -> Result<Option<crate::types::CrdtFieldKind>, StorageError> {
        Ok(self
            .def(table)?
            .crdt_fields
            .iter()
            .find(|declared| declared.field == field)
            .map(|declared| declared.kind))
    }

    /// Apply this batch's CRDT intents to their per-field docs and collect the update deltas the
    /// push carries (§1/§8-A). Runs inside the commit transaction so a field's Loro state and its
    /// wire delta commit atomically with the row.
    fn capture_crdt_wire_ops_unlocked(
        &self,
        batch: &WriteBatch,
        peer_id: u64,
        now_ms: i64,
        seeds: &FxHashMap<(String, String, String), serde_json::Value>,
    ) -> Result<Vec<crate::types::CrdtWireOp>, StorageError> {
        let mut out = Vec::with_capacity(batch.crdt_ops.len());
        for op in &batch.crdt_ops {
            let table = &op.row.table;
            let id = &op.row.document_id;
            let Some(kind) = self.crdt_kind_unlocked(table, &op.field)? else {
                return Err(StorageError::Unsatisfiable(format!(
                    "crdt op targets undeclared field {table}.{}",
                    op.field
                )));
            };
            let seed = seeds.get(&(table.clone(), id.clone(), op.field.clone()));
            let (update, checkpoint) = self.crdt_field_intent_write_unlocked(
                table,
                id,
                &op.field,
                kind,
                &op.operation,
                peer_id,
                now_ms,
                seed,
            )?;
            out.push(crate::types::CrdtWireOp {
                table: table.clone(),
                id: id.clone(),
                field: op.field.clone(),
                kind,
                update,
                checkpoint,
            });
        }
        Ok(out)
    }

    /// Read one CRDT field's merged materialized value, or `None` when the field has no ops yet.
    pub fn crdt_field_value(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: crate::types::CrdtFieldKind,
    ) -> Result<Option<serde_json::Value>, StorageError> {
        let _guard = lock(&self.operation_lock);
        let Some(state) = self.read_crdt_field_state_unlocked(table, id, field)? else {
            return Ok(None);
        };
        crate::crdt::crdt_field_value(&state, kind).map(Some)
    }

    pub fn crdt_remote_state(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: crate::types::CrdtFieldKind,
    ) -> Result<Option<crate::types::CrdtRemoteState>, StorageError> {
        let _guard = lock(&self.operation_lock);
        let Some(state) = self.read_crdt_field_state_unlocked(table, id, field)? else {
            return Ok(None);
        };
        Ok(Some(crate::types::CrdtRemoteState {
            epoch: state.server_epoch,
            head_seq: state.server_seq,
            projection_hash: state.server_projection_hash.clone(),
            projection: crate::crdt::crdt_field_value(&state, kind)?,
        }))
    }

    pub fn crdt_remote_effect(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: crate::types::CrdtFieldKind,
        prior_payloads: &[Vec<u8>],
        payload: &[u8],
    ) -> Result<crate::types::CrdtRemoteEffect, StorageError> {
        let _guard = lock(&self.operation_lock);
        let state = self
            .read_crdt_field_state_unlocked(table, id, field)?
            .ok_or_else(|| {
                StorageError::Unsatisfiable(format!(
                    "queued CRDT effect targets missing field {table}.{field}:{id}"
                ))
            })?;
        crate::crdt::crdt_field_remote_effect(&state, kind, prior_payloads, payload)
    }

    pub fn crdt_head_read(
        &self,
        table: &str,
        id: &str,
        field: &str,
    ) -> Result<Option<i64>, StorageError> {
        let _guard = lock(&self.operation_lock);
        Ok(self
            .read_crdt_field_state_unlocked(table, id, field)?
            .map(|state| state.server_seq))
    }

    pub fn crdt_read_states(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<crate::types::CrdtReadState>, StorageError> {
        let _guard = lock(&self.operation_lock);
        let definition = self.def(table)?;
        let mut states = Vec::with_capacity(definition.crdt_fields.len());
        for field in &definition.crdt_fields {
            let Some(state) = self.read_crdt_field_state_unlocked(table, id, &field.field)? else {
                continue;
            };
            states.push(crate::types::CrdtReadState {
                field: field.field.clone(),
                epoch: state.server_epoch,
                head_seq: state.server_seq,
                projection_hash: state.server_projection_hash,
            });
        }
        Ok(states)
    }

    pub fn crdt_snapshot_read(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<crate::types::CrdtSnapshot>, StorageError> {
        self.crdt_snapshot_read_with_ops(table, id, &[])
    }

    /// Read opaque CRDT snapshots after applying an in-memory prefix of local operations.
    ///
    /// The prefix is never stored here. This lets a revision captured inside a mutation refer
    /// to the exact logical state at that point in the transaction without splitting its commit.
    pub fn crdt_snapshot_read_with_ops(
        &self,
        table: &str,
        id: &str,
        ops: &[CrdtOp],
    ) -> Result<Vec<crate::types::CrdtSnapshot>, StorageError> {
        let _guard = lock(&self.operation_lock);
        let definition = self.def(table)?;
        let peer_id = if ops.is_empty() {
            None
        } else {
            Some(self.ensure_peer_id_unlocked(wall_ms()? as i64)?)
        };
        let mut snapshots = Vec::with_capacity(definition.crdt_fields.len());
        for field in &definition.crdt_fields {
            let mut state = self.read_crdt_field_state_unlocked(table, id, &field.field)?;
            for op in ops.iter().filter(|op| {
                op.row.table == table && op.row.document_id == id && op.field == field.field
            }) {
                let seed = if state.is_none() {
                    self.read_plain_field_value_unlocked(table, id, &field.field)?
                } else {
                    None
                };
                let (next, _) = crate::crdt::crdt_field_intent_write(
                    state.as_ref(),
                    field.kind,
                    &op.operation,
                    peer_id.expect("CRDT preview requires a local peer"),
                    seed.as_ref(),
                )?;
                state = Some(next);
            }
            let Some(state) = state else {
                continue;
            };
            let bytes = crate::crdt::crdt_field_snapshot(&state)?;
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            snapshots.push(crate::types::CrdtSnapshot {
                field: field.field.clone(),
                kind: field.kind,
                head_seq: state.server_seq,
                projection_hash: crate::crdt::crdt_field_projection_hash(&state, field.kind)?,
                bytes,
                hash: hex(&hasher.finalize()),
            });
        }
        Ok(snapshots)
    }

    fn read_crdt_field_state_unlocked(
        &self,
        table: &str,
        id: &str,
        field: &str,
    ) -> Result<Option<crate::crdt::CrdtFieldState>, StorageError> {
        self.driver.run_row(
            sql::read_crdt_field(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(id.to_owned()),
                text_value(field.to_owned()),
            ],
            |row| decode_crdt_field_state(&blob_at(row, 0)?),
        )
    }

    fn write_crdt_field_state_unlocked(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: crate::types::CrdtFieldKind,
        state: &crate::crdt::CrdtFieldState,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.driver.execute(
            sql::write_crdt_field(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(id.to_owned()),
                text_value(field.to_owned()),
                text_value(kind.as_wire().to_owned()),
                Value::Blob(encode_crdt_field_state(state)),
                Value::from_i64(now_ms),
            ],
        )
    }

    fn crdt_reject_row_unlocked(
        &self,
        table: &str,
        id: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        for field in &self.def(table)?.crdt_fields {
            let Some(state) = self.read_crdt_field_state_unlocked(table, id, &field.field)? else {
                continue;
            };
            if let Some(accepted) = crate::crdt::crdt_field_reject(&state) {
                self.write_crdt_field_state_unlocked(
                    table,
                    id,
                    &field.field,
                    field.kind,
                    &accepted,
                    now_ms,
                )?;
            } else {
                self.driver.execute(
                    sql::delete_crdt_field(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(table.to_owned()),
                        text_value(id.to_owned()),
                        text_value(field.field.clone()),
                    ],
                )?;
            }
        }
        Ok(())
    }

    pub fn remote_doc_read(
        &self,
        table: &str,
        local_document_id: &str,
    ) -> Result<Option<RowHead>, StorageError> {
        validate_ident(table)?;
        let _guard = lock(&self.operation_lock);
        self.remote_doc_read_unlocked(table, local_document_id)
    }

    fn remote_settle_rejected_dirty_unlocked(
        &self,
        table: &str,
        local_id: &str,
        server_rev_id: Option<&str>,
        retain: bool,
        expected_commit_seq: i64,
        now_ms: i64,
    ) -> Result<(Option<crate::types::RetainedRevision>, Option<CommitResult>), StorageError> {
        validate_ident(table)?;
        if self
            .read_dirty_head_unlocked(table, local_id)?
            .is_some_and(|head| head.updated_commit_seq != expected_commit_seq)
        {
            return Ok((None, None));
        }
        let Some(dirty) = self.read_pending_local_edit_unlocked(table, local_id)? else {
            return Ok((None, None));
        };
        let projection = self.remote_doc_read_unlocked(table, local_id)?;
        let accepted_row = projection
            .as_ref()
            .and_then(|state| state.server_row.clone());
        let current_root_id = projection
            .as_ref()
            .and_then(|state| state.current_root_id.clone());
        let server_document_id = projection
            .as_ref()
            .map(|state| state.server_document_id.clone());
        let base_root_id = dirty.base_root_id.or_else(|| current_root_id.clone());
        let base_node_id = dirty.base_node_id;
        let reroot = if retain {
            self.materialize_dirty_head_for_row_unlocked(table, local_id)?;
            self.archive_current_rev_unlocked(
                table,
                local_id,
                ArchiveServerIds {
                    server_rev_id: server_rev_id.map(str::to_owned),
                    server_root_id: None,
                    server_node_id: None,
                    base_root_id: base_root_id.clone(),
                    base_node_id: base_node_id.clone(),
                },
                now_ms,
            )?
            .map(|archived_rev_id| crate::types::RetainedRevision {
                table: table.to_owned(),
                local_document_id: local_id.to_owned(),
                archived_rev_id,
                server_rev_id: server_rev_id.map(str::to_owned),
                server_document_id,
                base_root_id,
                base_node_id,
                attached_node_id: None,
                current_root_id,
            })
        } else {
            None
        };
        let batch = match accepted_row.as_ref() {
            Some(row) => WriteBatch {
                doc_writes: vec![remote_doc_encode(
                    self.def(table)?.as_ref(),
                    local_id,
                    row,
                    now_ms,
                )?],
                ..WriteBatch::default()
            },
            None => WriteBatch {
                deletes: vec![DeleteIn {
                    table: table.to_owned(),
                    id: local_id.to_owned(),
                }],
                ..WriteBatch::default()
            },
        };
        let restored = self.commit_unlocked(
            &batch,
            &CommitOptions {
                source: CommitSource::Remote,
                ..CommitOptions::default()
            },
        )?;
        if accepted_row.is_some() {
            self.clear_current_rev_unlocked(table, local_id)?;
        } else {
            self.rev_delete_current_unlocked(table, local_id)?;
        }
        self.crdt_reject_row_unlocked(table, local_id, now_ms)?;
        self.clear_pending_row_unlocked(table, local_id)?;
        Ok((reroot, Some(restored)))
    }

    pub fn schema_table_names(&self) -> Vec<String> {
        let mut names: Vec<_> = lock(&self.tables).keys().cloned().collect();
        names.sort();
        names
    }

    #[allow(clippy::too_many_lines)]
    fn remote_doc_page_write_unlocked(
        &self,
        records: &[AuthoritativeRow],
    ) -> Result<AuthoritativeApplyResult, StorageError> {
        let mut committed = Vec::new();
        let mut reroots = Vec::new();
        let mut archived_current_local_ids = FxHashSet::default();
        for record in records {
            let table = self.def(&record.table)?;
            let mapping = self.projection_map_remote_id_unlocked(
                &record.table,
                &record.server_document_id,
                record.local_document_id.as_deref(),
                record.received_time,
            )?;
            let local_id = mapping.local_id;
            let stale_document_ids = mapping.stale_document_ids;
            for stale_id in &stale_document_ids {
                self.detach_stale_projection_document_unlocked(
                    record,
                    stale_id,
                    true,
                    &mut reroots,
                )?;
            }
            let existing_projection = self.remote_doc_read_unlocked(&record.table, &local_id)?;
            let dirty_current = self.read_pending_local_edit_unlocked(&record.table, &local_id)?;
            let remote_matches_dirty_base = dirty_current.as_ref().is_some_and(|dirty| {
                dirty.base_projection_hash.as_deref() == Some(record.plain_hash.as_str())
            });
            let order = if remote_matches_dirty_base {
                RecordOrder::Stale
            } else {
                record_order(record, existing_projection.as_ref())
            };
            // Membership exit deliberately retains the authoritative projection metadata while
            // removing the materialized document. If the same row later re-enters a subscription,
            // an equal projection hash is not a zero-write duplicate: the document must be
            // materialized again. Treat `Known` as a no-op only while its physical row exists.
            let order = if matches!(order, RecordOrder::Known)
                && record.row.is_some()
                && self.doc_read_unlocked(&record.table, &local_id)?.is_none()
            {
                RecordOrder::Adopt
            } else {
                order
            };
            match order {
                RecordOrder::Stale => {
                    if let Some(commit) = self
                        .delete_stale_projection_rows_unlocked(&record.table, &stale_document_ids)?
                    {
                        committed.push(commit);
                    }
                    continue;
                }
                RecordOrder::Known => {
                    self.remote_doc_write_unlocked(&RowHead {
                        current_rev_id: existing_projection.as_ref().map_or_else(
                            || "main".to_owned(),
                            |state| state.current_rev_id.clone(),
                        ),
                        server_base: Some(record.plain_hash.clone()),
                        server_row: record.row.clone(),
                        current_node_id: record.current_node_id.clone(),
                        current_root_id: record.current_root_id.clone(),
                        local_document_id: local_id.clone(),
                        projection_hash: record.projection_hash.clone(),
                        server_document_id: record.server_document_id.clone(),
                        table: record.table.clone(),
                        updated_time: record.received_time,
                        logical_clock: projection_logical_clock(
                            record,
                            existing_projection.as_ref(),
                        ),
                    })?;
                    self.clear_current_rev_unlocked(&record.table, &local_id)?;
                    if let Some(commit) = self
                        .delete_stale_projection_rows_unlocked(&record.table, &stale_document_ids)?
                    {
                        committed.push(commit);
                    }
                    continue;
                }
                RecordOrder::Adopt => {}
            }
            let batch = match &record.row {
                Some(row) => WriteBatch {
                    doc_writes: vec![remote_doc_encode(
                        &table,
                        &local_id,
                        row,
                        record.received_time,
                    )?],
                    local_field_writes: vec![],
                    local_field_deletes: vec![],
                    crdt_ops: vec![],
                    crdt_restores: vec![],
                    fresh_ids: vec![],
                    data_only_ids: vec![],
                    schedules: vec![],
                    id_mappings: vec![IdMapping {
                        created_time: record.received_time,
                        local_id: local_id.clone(),
                        mapping: IdMappingContent::Mapped {
                            convex_id: record.server_document_id.clone(),
                        },
                        table: record.table.clone(),
                        updated_time: record.received_time,
                    }],
                    deletes: stale_document_ids
                        .iter()
                        .map(|id| crate::types::DeleteIn {
                            id: id.clone(),
                            table: record.table.clone(),
                        })
                        .collect(),
                },
                None => WriteBatch {
                    doc_writes: Vec::new(),
                    local_field_writes: vec![],
                    local_field_deletes: vec![],
                    crdt_ops: vec![],
                    crdt_restores: vec![],
                    fresh_ids: vec![],
                    data_only_ids: vec![],
                    schedules: vec![],
                    id_mappings: vec![IdMapping {
                        created_time: record.received_time,
                        local_id: local_id.clone(),
                        mapping: IdMappingContent::Deleted {
                            convex_id: Some(record.server_document_id.clone()),
                        },
                        table: record.table.clone(),
                        updated_time: record.received_time,
                    }],
                    deletes: std::iter::once(local_id.clone())
                        .chain(stale_document_ids.iter().cloned())
                        .collect::<FxHashSet<_>>()
                        .into_iter()
                        .map(|id| crate::types::DeleteIn {
                            id,
                            table: record.table.clone(),
                        })
                        .collect(),
                },
            };
            if let Some(dirty) =
                dirty_current.filter(|_| archived_current_local_ids.insert(local_id.clone()))
            {
                self.materialize_dirty_head_for_row_unlocked(&record.table, &local_id)?;
                let base_root_id = dirty
                    .base_root_id
                    .or_else(|| record.current_root_id.clone());
                let base_node_id = dirty.base_node_id;
                if let Some(archived_rev_id) = self.archive_current_rev_unlocked(
                    &record.table,
                    &local_id,
                    ArchiveServerIds {
                        server_rev_id: None,
                        server_root_id: None,
                        server_node_id: None,
                        base_root_id: base_root_id.clone(),
                        base_node_id: base_node_id.clone(),
                    },
                    record.received_time,
                )? {
                    reroots.push(crate::types::RetainedRevision {
                        table: record.table.clone(),
                        local_document_id: local_id.clone(),
                        archived_rev_id,
                        server_rev_id: None,
                        server_document_id: Some(record.server_document_id.clone()),
                        base_root_id,
                        base_node_id,
                        attached_node_id: None,
                        current_root_id: record.current_root_id.clone(),
                    });
                }
                self.clear_pending_row_unlocked(&record.table, &local_id)?;
            }
            let commit = self.commit_unlocked(
                &batch,
                &CommitOptions {
                    source: CommitSource::Remote,
                    ..CommitOptions::default()
                },
            )?;
            if record.row.is_some() {
                self.remote_doc_write_unlocked(&RowHead {
                    current_rev_id: "main".to_owned(),
                    server_base: Some(record.plain_hash.clone()),
                    server_row: record.row.clone(),
                    current_node_id: record.current_node_id.clone(),
                    current_root_id: record.current_root_id.clone(),
                    local_document_id: local_id.clone(),
                    projection_hash: record.projection_hash.clone(),
                    server_document_id: record.server_document_id.clone(),
                    table: record.table.clone(),
                    updated_time: record.received_time,
                    logical_clock: projection_logical_clock(record, existing_projection.as_ref()),
                })?;
            } else {
                self.rev_delete_current_unlocked(&record.table, &local_id)?;
            }
            self.clear_current_rev_unlocked(&record.table, &local_id)?;
            committed.push(commit);
        }
        Ok(AuthoritativeApplyResult { committed, reroots })
    }

    #[allow(clippy::too_many_arguments)]
    fn membership_snapshot_write_unlocked(
        &self,
        subscription: &str,
        members: &[RemoteMember],
        retained: &FxHashSet<RemoteMember>,
        released: &FxHashSet<RemoteMember>,
        replacing_result_key: Option<&str>,
        now_ms: i64,
        projection: &mut AuthoritativeApplyResult,
    ) -> Result<usize, StorageError> {
        let mut previous = FxHashSet::default();
        self.driver.run_rows(
            sql::read_membership(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(subscription.to_owned()),
            ],
            |row| {
                previous.insert(RemoteMember {
                    table: text_at(row, 0)?,
                    server_document_id: text_at(row, 1)?,
                });
                Ok(())
            },
        )?;

        let current = members.iter().cloned().collect::<FxHashSet<_>>();
        if current.len() != members.len() {
            return Err(StorageError::Unsatisfiable(
                "remote pull membership contains a duplicate row".to_owned(),
            ));
        }
        for member in &current {
            self.def(&member.table)?;
            if self
                .remote_doc_id_read_unlocked(&member.table, &member.server_document_id)?
                .is_none()
            {
                return Err(StorageError::Unsatisfiable(format!(
                    "snapshot member {}:{} has no authoritative projection",
                    member.table, member.server_document_id
                )));
            }
        }

        if previous == current && released.is_empty() {
            return Ok(0);
        }

        self.driver.execute(
            sql::delete_subscription_membership(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(subscription.to_owned()),
            ],
        )?;
        for member in &current {
            self.driver.execute(
                sql::write_membership(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(subscription.to_owned()),
                    text_value(member.table.clone()),
                    text_value(member.server_document_id.clone()),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                ],
            )?;
        }

        let mut projection_deleted = 0;
        let mut exited = previous
            .difference(&current)
            .cloned()
            .collect::<FxHashSet<_>>();
        exited.extend(released.iter().cloned());
        let result_edges = if exited.is_empty() {
            FxHashSet::default()
        } else {
            self.result_edges_read_unlocked(replacing_result_key)?
        };
        for exited in &exited {
            if retained.contains(exited)
                || self.membership_row_has_edge_unlocked(exited)?
                || result_edges.contains(exited)
            {
                continue;
            }
            if self.membership_projection_delete_unlocked(exited, now_ms, projection)? {
                projection_deleted += 1;
            }
        }
        Ok(projection_deleted)
    }

    fn membership_row_has_edge_unlocked(
        &self,
        member: &RemoteMember,
    ) -> Result<bool, StorageError> {
        Ok(self
            .driver
            .run_row(
                sql::membership_has_row(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(member.table.clone()),
                    text_value(member.server_document_id.clone()),
                ],
                |_| Ok(()),
            )?
            .is_some())
    }

    /// Rows disclosed by other retained authored results. Result disclosures are durable ownership
    /// edges just like subscription membership: one subscription can observe a deletion before a
    /// point-result subscription receives its corresponding `null` result. Read the union once per
    /// membership page so releasing many rows does not rescan every retained result for every row.
    /// Ignore the result currently being replaced because its incoming paths are represented by
    /// `retained`; otherwise its stale stored paths would keep the row alive forever.
    fn result_edges_read_unlocked(
        &self,
        replacing_result_key: Option<&str>,
    ) -> Result<FxHashSet<RemoteMember>, StorageError> {
        let mut edges = FxHashSet::default();
        self.driver.run_rows(
            sql::read_result_paths(),
            vec![text_value(self.identity_key.clone())],
            |row| {
                let key = text_at(row, 0)?;
                if replacing_result_key == Some(key.as_str()) {
                    return Ok(());
                }
                let paths = blob_at(row, 1)?;
                edges.extend(result_disclosed_rows_from_paths(&paths)?);
                Ok(())
            },
        )?;
        Ok(edges)
    }

    fn remote_doc_id_read_unlocked(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError> {
        self.driver.run_row(
            sql::read_projection_by_server(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(server_document_id.to_owned()),
            ],
            |row| text_at(row, 0),
        )
    }

    fn membership_projection_delete_unlocked(
        &self,
        member: &RemoteMember,
        now_ms: i64,
        projection: &mut AuthoritativeApplyResult,
    ) -> Result<bool, StorageError> {
        let Some(local_id) =
            self.remote_doc_id_read_unlocked(&member.table, &member.server_document_id)?
        else {
            return Ok(false);
        };
        if let Some(dirty) = self.read_pending_local_edit_unlocked(&member.table, &local_id)? {
            self.materialize_dirty_head_for_row_unlocked(&member.table, &local_id)?;
            if let Some(archived_rev_id) = self.archive_current_rev_unlocked(
                &member.table,
                &local_id,
                ArchiveServerIds {
                    base_root_id: dirty.base_root_id.clone(),
                    base_node_id: dirty.base_node_id.clone(),
                    ..ArchiveServerIds::default()
                },
                now_ms,
            )? {
                projection.reroots.push(crate::types::RetainedRevision {
                    table: member.table.clone(),
                    local_document_id: local_id.clone(),
                    archived_rev_id,
                    server_rev_id: None,
                    server_document_id: Some(member.server_document_id.clone()),
                    base_root_id: dirty.base_root_id,
                    base_node_id: dirty.base_node_id,
                    attached_node_id: None,
                    current_root_id: None,
                });
            }
            self.clear_pending_row_unlocked(&member.table, &local_id)?;
        }
        let commit = self.commit_unlocked(
            &WriteBatch {
                deletes: vec![DeleteIn {
                    table: member.table.clone(),
                    id: local_id.clone(),
                }],
                ..WriteBatch::default()
            },
            &CommitOptions {
                source: CommitSource::Remote,
                ..CommitOptions::default()
            },
        )?;
        self.rev_delete_current_unlocked(&member.table, &local_id)?;
        projection.committed.push(commit);
        Ok(true)
    }

    fn validate_remote_pull_unlocked(&self, pull: &RemotePageWrite) -> Result<(), StorageError> {
        let mut members = FxHashSet::default();
        for member in &pull.members {
            self.replicated_def(&member.table)?;
            if !members.insert((member.table.clone(), member.server_document_id.clone())) {
                return Err(StorageError::Unsatisfiable(
                    "remote pull membership contains a duplicate row".to_owned(),
                ));
            }
        }

        let mut projections = FxHashSet::default();
        for projection in &pull.projections {
            self.replicated_def(&projection.table)?;
            if projection.row.is_none() {
                return Err(StorageError::Unsatisfiable(
                    "complete remote pull pages cannot contain projection tombstones".to_owned(),
                ));
            }
            if !projections.insert((
                projection.table.clone(),
                projection.server_document_id.clone(),
            )) {
                return Err(StorageError::Unsatisfiable(
                    "remote pull contains a duplicate authoritative projection".to_owned(),
                ));
            }
        }
        if !projections.is_subset(&members) {
            return Err(StorageError::Unsatisfiable(
                "remote pull projections must belong to complete membership".to_owned(),
            ));
        }

        let mut crdt_fields = FxHashSet::default();
        for change in &pull.crdt {
            if !members.contains(&(change.table.clone(), change.document_id.clone())) {
                return Err(StorageError::Unsatisfiable(format!(
                    "remote pull CRDT field {}:{} is outside complete membership",
                    change.table, change.document_id
                )));
            }
            if change.epoch < 0 || change.checkpoint_seq < 0 || change.head_seq < 0 {
                return Err(StorageError::Unsatisfiable(
                    "remote pull CRDT coordinates must be nonnegative".to_owned(),
                ));
            }
            let updates = i64::try_from(change.updates.len()).map_err(|_| {
                StorageError::Unsatisfiable(
                    "remote pull CRDT payload tail exceeds local address space".to_owned(),
                )
            })?;
            let valid_complete = change.checkpoint.is_some()
                && change
                    .checkpoint_seq
                    .checked_add(updates)
                    .is_some_and(|head| head == change.head_seq);
            let valid_incremental = change.checkpoint.is_none()
                && change.updates.len() == 1
                && change.checkpoint_seq + 1 == change.head_seq;
            if !valid_complete && !valid_incremental {
                return Err(StorageError::Unsatisfiable(
                    "remote pull CRDT state is neither complete nor a contiguous next-head effect"
                        .to_owned(),
                ));
            }
            if !crdt_fields.insert((
                change.table.clone(),
                change.document_id.clone(),
                change.field.clone(),
            )) {
                return Err(StorageError::Unsatisfiable(
                    "remote pull contains a duplicate CRDT field".to_owned(),
                ));
            }
        }
        let mut blob_keys = FxHashSet::default();
        for blob in &pull.blobs {
            if blob.key.is_empty() || !blob_keys.insert(blob.key.clone()) {
                return Err(StorageError::Unsatisfiable(
                    "remote pull contains an invalid or duplicate blob".to_owned(),
                ));
            }
        }
        Ok(())
    }

    fn validate_remote_push_settlement(
        &self,
        settlement: &RemoteSettlementWrite,
    ) -> Result<(), StorageError> {
        if settlement.mutation_id.is_empty() || settlement.expected_commit_seq < 0 {
            return Err(StorageError::Unsatisfiable(
                "remote push settlement requires a mutation ID and commit sequence".to_owned(),
            ));
        }
        match &settlement.outcome {
            RemoteSettlementOutcome::Applied {
                ids,
                schedules,
                projections,
                crdt,
            } => self.validate_remote_push_applied(ids, schedules, projections, crdt)?,
            RemoteSettlementOutcome::Rejected {
                schedules,
                targets,
                projections,
            } => self.validate_remote_push_rejected(schedules, targets, projections)?,
        }
        Ok(())
    }

    fn validate_remote_push_applied(
        &self,
        ids: &[crate::types::RemoteIdMapping],
        schedules: &[crate::types::RemoteScheduleMapping],
        projections: &[AuthoritativeRow],
        crdt: &[crate::types::CrdtRemoteWrite],
    ) -> Result<(), StorageError> {
        let mut local_ids = FxHashSet::default();
        let mut server_ids = FxHashSet::default();
        for mapping in ids {
            self.replicated_def(&mapping.table)?;
            if mapping.local_document_id.is_empty()
                || mapping.server_document_id.is_empty()
                || !local_ids.insert((mapping.table.clone(), mapping.local_document_id.clone()))
                || !server_ids.insert((mapping.table.clone(), mapping.server_document_id.clone()))
            {
                return Err(StorageError::Unsatisfiable(
                    "remote push settlement contains an invalid or duplicate ID mapping".to_owned(),
                ));
            }
        }
        Self::validate_remote_schedule_mappings(schedules)?;
        for projection in projections {
            self.replicated_def(&projection.table)?;
        }
        let mut crdt_fields = FxHashSet::default();
        for write in crdt {
            self.replicated_def(&write.table)?;
            if write.id.is_empty()
                || write.field.is_empty()
                || write.head_seq < 0
                || !crdt_fields.insert((write.table.clone(), write.id.clone(), write.field.clone()))
            {
                return Err(StorageError::Unsatisfiable(
                    "remote push settlement contains an invalid or duplicate CRDT head".to_owned(),
                ));
            }
        }
        Ok(())
    }

    fn validate_remote_schedule_mappings(
        schedules: &[crate::types::RemoteScheduleMapping],
    ) -> Result<(), StorageError> {
        let mut local_ids = FxHashSet::default();
        let mut server_ids = FxHashSet::default();
        for mapping in schedules {
            if mapping.local_id.is_empty()
                || mapping.server_id.is_empty()
                || !local_ids.insert(mapping.local_id.clone())
                || !server_ids.insert(mapping.server_id.clone())
            {
                return Err(StorageError::Unsatisfiable(
                    "remote push settlement contains an invalid or duplicate schedule mapping"
                        .to_owned(),
                ));
            }
        }
        Ok(())
    }

    fn validate_remote_push_rejected(
        &self,
        schedules: &[String],
        targets: &[crate::types::RemoteRowTarget],
        projections: &[AuthoritativeRow],
    ) -> Result<(), StorageError> {
        let mut schedule_ids = FxHashSet::default();
        for job_id in schedules {
            if job_id.is_empty() || !schedule_ids.insert(job_id.clone()) {
                return Err(StorageError::Unsatisfiable(
                    "remote push rejection contains an invalid or duplicate schedule".to_owned(),
                ));
            }
        }
        let mut row_ids = FxHashSet::default();
        let mut server_rev_ids = FxHashSet::default();
        for target in targets {
            self.replicated_def(&target.table)?;
            if target.local_document_id.is_empty()
                || !row_ids.insert((target.table.clone(), target.local_document_id.clone()))
                || target.server_rev_id.as_ref().is_some_and(|rev_id| {
                    rev_id.is_empty() || !server_rev_ids.insert(rev_id.clone())
                })
            {
                return Err(StorageError::Unsatisfiable(
                    "remote push rejection contains an invalid or duplicate row or rev".to_owned(),
                ));
            }
        }
        for projection in projections {
            self.replicated_def(&projection.table)?;
        }
        Ok(())
    }

    fn observe_authoritative_clocks(&self, records: &[AuthoritativeRow]) {
        let mut clock = lock(&self.clock);
        for value in records
            .iter()
            .filter_map(|record| record.logical_clock)
            .filter(|value| value.is_finite())
        {
            clock.observe(value);
        }
    }

    pub fn remote_page_write(
        &self,
        pull: &RemotePageWrite,
    ) -> Result<RemotePageWriteResult, StorageError> {
        if pull.subscription.is_empty() {
            return Err(StorageError::Unsatisfiable(
                "remote pull subscription must not be empty".to_owned(),
            ));
        }
        let _guard = lock(&self.operation_lock);
        self.validate_remote_pull_unlocked(pull)?;
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let applied: Result<RemotePageWriteResult, StorageError> = (|| {
            self.materialize_dirty_heads_in_tx_unlocked()?;
            let mut projection = self.remote_doc_page_write_unlocked(&pull.projections)?;

            let retained = result_disclosed_rows(pull.result.as_deref())?;
            let (released, replacing_result_key) = match pull.result.as_deref() {
                Some(entry) => {
                    let previous = self
                        .result_read_unlocked(&entry.key)?
                        .as_ref()
                        .map(|entry| result_disclosed_rows(Some(entry)))
                        .transpose()?
                        .unwrap_or_default();
                    (
                        previous
                            .difference(&retained)
                            .cloned()
                            .collect::<FxHashSet<_>>(),
                        Some(entry.key.as_str()),
                    )
                }
                None => (FxHashSet::default(), None),
            };
            let projection_deleted = self.membership_snapshot_write_unlocked(
                &pull.subscription,
                &pull.members,
                &retained,
                &released,
                replacing_result_key,
                pull.received_time,
                &mut projection,
            )?;
            let crdt = self.remote_pull_crdt_unlocked(&pull.crdt, pull.received_time)?;

            for blob in &pull.blobs {
                self.driver.execute(
                    sql::write_blob(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(blob.key.clone()),
                        Value::Blob(blob.bytes.clone()),
                    ],
                )?;
            }

            self.driver.execute(
                sql::write_remote_cursor(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(remote_cursor_key_encode(&pull.subscription)),
                    Value::from_i64(0),
                    pull.cursor.clone().map_or(Value::Null, text_value),
                    Value::from_i64(pull.received_time),
                ],
            )?;

            let result_changed = match &pull.result {
                Some(entry) if self.result_write_unlocked(entry)? => Some(entry.key.clone()),
                _ => None,
            };

            Ok(RemotePageWriteResult {
                rev_write: RevWriteResult {
                    duplicates: 0,
                    written: 0,
                },
                projection,
                projection_deleted,
                crdt,
                result_changed,
            })
        })();
        match applied {
            Ok(result) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => {
                    self.observe_commit_results(&result.projection.committed);
                    self.observe_authoritative_clocks(&pull.projections);
                    #[cfg(debug_assertions)]
                    self.debug_assert_rev_invariants();
                    Ok(result)
                }
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(e, rolled))
                }
            },
            Err(e) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(e, rolled))
            }
        }
    }

    pub fn remote_subscription_delete(
        &self,
        subscription: &str,
        now_ms: i64,
    ) -> Result<RemotePageWriteResult, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let removed: Result<RemotePageWriteResult, StorageError> = (|| {
            self.materialize_dirty_heads_in_tx_unlocked()?;
            let mut projection = AuthoritativeApplyResult {
                committed: Vec::new(),
                reroots: Vec::new(),
            };
            let projection_deleted = self.membership_snapshot_write_unlocked(
                subscription,
                &[],
                &FxHashSet::default(),
                &FxHashSet::default(),
                None,
                now_ms,
                &mut projection,
            )?;
            self.driver.execute(
                sql::delete_remote_cursor(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(remote_cursor_key_encode(subscription)),
                ],
            )?;
            Ok(RemotePageWriteResult {
                rev_write: RevWriteResult {
                    duplicates: 0,
                    written: 0,
                },
                projection,
                projection_deleted,
                crdt: Vec::new(),
                result_changed: None,
            })
        })();
        match removed {
            Ok(result) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => {
                    self.observe_commit_results(&result.projection.committed);
                    Ok(result)
                }
                Err(error) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(error, rolled))
                }
            },
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(error, rolled))
            }
        }
    }

    fn remote_settle_applied_unlocked(
        &self,
        projections: &[AuthoritativeRow],
        expected_commit_seq: i64,
    ) -> Result<AuthoritativeApplyResult, StorageError> {
        let mut applicable = Vec::with_capacity(projections.len());
        for projection in projections {
            self.def(&projection.table)?;
            let local_id = self
                .projection_map_remote_id_unlocked(
                    &projection.table,
                    &projection.server_document_id,
                    projection.local_document_id.as_deref(),
                    projection.received_time,
                )?
                .local_id;
            if self
                .read_dirty_head_unlocked(&projection.table, &local_id)?
                .is_some_and(|head| head.updated_commit_seq != expected_commit_seq)
            {
                self.remote_doc_base_write_unlocked(projection, &local_id)?;
                continue;
            }
            if self
                .read_pending_local_edit_unlocked(&projection.table, &local_id)?
                .is_some()
            {
                self.clear_pending_row_unlocked(&projection.table, &local_id)?;
            }
            applicable.push(projection.clone());
        }
        self.remote_doc_page_write_unlocked(&applicable)
    }

    fn remote_doc_base_write_unlocked(
        &self,
        record: &AuthoritativeRow,
        local_id: &str,
    ) -> Result<(), StorageError> {
        let existing = self.remote_doc_read_unlocked(&record.table, local_id)?;
        let logical_clock = projection_logical_clock(record, existing.as_ref());
        self.remote_doc_write_unlocked(&RowHead {
            table: record.table.clone(),
            local_document_id: local_id.to_owned(),
            current_rev_id: existing
                .as_ref()
                .map_or_else(|| "main".to_owned(), |state| state.current_rev_id.clone()),
            server_document_id: record.server_document_id.clone(),
            projection_hash: existing.as_ref().map_or_else(
                || record.projection_hash.clone(),
                |state| state.projection_hash.clone(),
            ),
            current_root_id: record.current_root_id.clone(),
            current_node_id: record.current_node_id.clone(),
            server_base: Some(record.plain_hash.clone()),
            server_row: record.row.clone(),
            logical_clock,
            updated_time: record.received_time,
        })?;
        Ok(())
    }

    fn remote_pull_crdt_unlocked(
        &self,
        changes: &[crate::types::RemoteCrdtChange],
        now_ms: i64,
    ) -> Result<Vec<RowChange>, StorageError> {
        let mut out = Vec::new();
        for change in changes {
            if let Some(row) = self.remote_pull_crdt_change_unlocked(change, now_ms)? {
                out.push(row);
            }
        }
        Ok(out)
    }

    fn remote_pull_crdt_change_unlocked(
        &self,
        change: &crate::types::RemoteCrdtChange,
        now_ms: i64,
    ) -> Result<Option<RowChange>, StorageError> {
        let definition = self.def(&change.table)?;
        let field = definition
            .crdt_fields
            .iter()
            .find(|field| field.field == change.field)
            .ok_or_else(|| {
                StorageError::Unsatisfiable(format!(
                    "remote pull targets undeclared CRDT field {}.{}",
                    change.table, change.field
                ))
            })?;
        if field.kind != change.kind {
            return Err(StorageError::Unsatisfiable(format!(
                "remote pull changed CRDT kind for {}.{}",
                change.table, change.field
            )));
        }
        let local_id = self
            .projection_map_remote_id_unlocked(&change.table, &change.document_id, None, now_ms)?
            .local_id;
        let mut projection = self
            .remote_doc_read_unlocked(&change.table, &local_id)?
            .ok_or_else(|| {
                StorageError::Unsatisfiable(format!(
                    "remote pull CRDT field {}.{} has no authoritative projection",
                    change.table, change.document_id
                ))
            })?;
        let local_row = self.doc_read_unlocked(&change.table, &local_id)?;
        let pending_delete = local_row.is_none()
            && self
                .read_dirty_head_unlocked(&change.table, &local_id)?
                .is_some_and(|head| head.change.op == RowChangeOp::Delete);
        let row_json = match local_row {
            Some(row) => row,
            None if pending_delete => projection.server_row.clone().ok_or_else(|| {
                StorageError::Unsatisfiable(format!(
                    "remote pull CRDT field {}.{} has no authoritative server row",
                    change.table, change.document_id
                ))
            })?,
            None => {
                return Err(StorageError::Unsatisfiable(format!(
                    "remote pull CRDT field {}.{} has no authoritative projection",
                    change.table, change.document_id
                )));
            }
        };
        let current =
            self.read_crdt_field_state_unlocked(&change.table, &local_id, &change.field)?;
        let (state, changed) = remote_pull_crdt_state(current, change)?;
        if changed {
            self.write_crdt_field_state_unlocked(
                &change.table,
                &local_id,
                &change.field,
                change.kind,
                &state,
                now_ms,
            )?;
        }
        let accepted = crate::crdt::crdt_field_reject(&state).ok_or_else(|| {
            StorageError::Unsatisfiable(
                "accepted remote CRDT state did not retain its authoritative base".to_owned(),
            )
        })?;
        let accepted_value = crate::crdt::crdt_field_value(&accepted, change.kind)?;
        let base_row = projection.server_row.as_deref().unwrap_or(&row_json);
        projection.server_row = Some(patch_row_field(base_row, &change.field, accepted_value)?);
        self.remote_doc_write_unlocked(&projection)?;
        if pending_delete {
            return Ok(None);
        }
        let value = crate::crdt::crdt_field_value(&state, change.kind)?;
        let patched = patch_row_field(&row_json, &change.field, value)?;
        if patched == row_json {
            return Ok(None);
        }
        let table = self.runtime(&change.table)?;
        let doc_write =
            crate::store::helpers::remote_doc_encode(&table.def, &local_id, &patched, now_ms)?;
        self.doc_write_unlocked(&doc_write, &table, false)?;
        Ok(Some(RowChange {
            op: RowChangeOp::Write,
            table: change.table.clone(),
            id: local_id,
            row: Some(crate::store::helpers::doc_write_row(&doc_write)?),
        }))
    }

    #[cfg(any(test, feature = "testkit"))]
    pub fn rev_frontiers_read(&self) -> Result<Vec<RevFrontier>, StorageError> {
        let mut out = Vec::new();
        let _guard = lock(&self.operation_lock);
        self.materialize_dirty_heads_unlocked()?;
        self.driver.run_rows(
            sql::read_rev_frontiers(),
            vec![text_value(self.identity_key.clone())],
            |row| {
                out.push(row_to_rev_frontier(row)?);
                Ok(())
            },
        )?;
        Ok(out)
    }

    /// All revs (histories) of a single application document, including archives and forks.
    pub fn rev_read(&self, row: &RowKey) -> Result<Vec<RevState>, StorageError> {
        let mut out = Vec::new();
        let table = row.table.clone();
        let document_id = row.document_id.clone();
        let _guard = lock(&self.operation_lock);
        self.materialize_dirty_heads_unlocked()?;
        self.driver.run_rows(
            sql::read_document_revs(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.clone()),
                text_value(document_id.clone()),
            ],
            |data| {
                out.push(RevState {
                    key: RevKey {
                        rev_id: text_at(data, 0)?,
                        row: RowKey {
                            table: table.clone(),
                            document_id: document_id.clone(),
                        },
                    },
                    snapshot: blob_at(data, 1)?,
                    log: Vec::new(),
                    frontier: blob_at(data, 2)?,
                    lifecycle: rev_lifecycle_at(data, 3)?,
                    updated_time: int_at(data, 10)?,
                });
                Ok(())
            },
        )?;
        if !out.iter().any(|state| state.key.rev_id == "main") {
            if let Some(current) = self.read_rev_unlocked(&RevKey {
                rev_id: "main".to_owned(),
                row: row.clone(),
            })? {
                out.push(current);
            }
        }
        Ok(out)
    }

    /// Fold the WAL into the main database file and truncate it, so the next open replays nothing.
    pub fn wal_write(&self) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.wal_write()
    }

    /// Run a `PRAGMA` and return its first integer column, for the memory harness to read back the
    /// tuned page-cache bound and to model the wasm ceiling on native hardware.
    #[cfg(any(test, feature = "testkit"))]
    pub fn pragma_read(&self, sql: &str) -> Result<Option<i64>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver
            .run_row(sql, Vec::new(), |row| match row.get_value(0) {
                turso_core::Value::Numeric(turso_core::Numeric::Integer(value)) => Ok(*value),
                _ => Ok(0),
            })
    }

    /// Counts immutable originated payloads for reachability-cleanup tests.
    #[cfg(any(test, feature = "testkit"))]
    pub fn origin_payload_count_debug_read(&self) -> Result<i64, StorageError> {
        let _guard = lock(&self.operation_lock);
        Ok(self
            .driver
            .run_row(
                "SELECT COUNT(*) FROM __embedded_origin_payload",
                Vec::new(),
                |row| int_at(row, 0),
            )?
            .unwrap_or(0))
    }

    /// Corrupts one immutable payload row without changing its content address.
    #[cfg(any(test, feature = "testkit"))]
    pub fn origin_payload_corrupt_debug_write(&self) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(
            "UPDATE __embedded_origin_payload SET bytes = X'00' \
             WHERE rowid = (SELECT rowid FROM __embedded_origin_payload LIMIT 1)",
            Vec::new(),
        )
    }

    /// Overrides the frozen-plane format marker so downgrade tests can prove open fails closed.
    #[cfg(any(test, feature = "testkit"))]
    pub fn bootstrap_version_debug_write(&self, version: i64) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.transaction_unlocked(|| {
            self.write_bootstrap_unlocked(
                sql::BOOTSTRAP_VERSION_KEY,
                version.to_string().as_bytes(),
            )
        })
    }

    /// Overrides the active semantic contract epoch for downgrade tests.
    #[cfg(any(test, feature = "testkit"))]
    pub fn contract_epoch_debug_write(&self, epoch: i64) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        let mut contract = self
            .bootstrap_contract_read_unlocked(sql::ACTIVE_CONTRACT_KEY)?
            .ok_or_else(|| StorageError::Unsatisfiable("active contract is missing".to_owned()))?;
        contract.package_epoch = epoch;
        let encoded = serde_json::to_vec(&contract)
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        self.transaction_unlocked(|| {
            self.write_bootstrap_unlocked(sql::ACTIVE_CONTRACT_KEY, &encoded)
        })
    }

    /// Rewrites a generation-one fixture into the last unreleased flat layout
    /// so integration tests can exercise the one-time ledger seeder.
    #[cfg(any(test, feature = "testkit"))]
    pub fn legacy_layout_debug_write(&self) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        let mut indexes = Vec::new();
        let mut tables = Vec::new();
        self.driver.run_rows(
            "SELECT type, name, tbl_name FROM sqlite_master \
             WHERE (type = 'table' AND name LIKE 'g1__%') \
             OR (type = 'index' AND tbl_name LIKE 'g1__%') \
             ORDER BY type, name",
            Vec::new(),
            |row| {
                let kind = text_at(row, 0)?;
                let name = text_at(row, 1)?;
                if kind == "table" {
                    tables.push(name);
                } else if !name.starts_with("sqlite_autoindex_") {
                    indexes.push(name);
                }
                Ok(())
            },
        )?;
        self.driver.generation_write(0);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let rewritten = (|| {
            for index in indexes {
                self.driver
                    .execute(&format!("DROP INDEX \"{index}\""), Vec::new())?;
            }
            for table in tables {
                let suffix = table.strip_prefix("g1__").ok_or_else(|| {
                    StorageError::Unsatisfiable("unexpected generation-one table".to_owned())
                })?;
                let target = if suffix.starts_with("embedded_") {
                    format!("__{suffix}")
                } else {
                    suffix.to_owned()
                };
                self.driver.execute(
                    &format!("ALTER TABLE \"{table}\" RENAME TO \"{target}\""),
                    Vec::new(),
                )?;
            }
            for table in [sql::BOOTSTRAP, sql::ORIGIN, sql::ORIGIN_PAYLOAD] {
                self.driver
                    .execute(&format!("DROP TABLE \"{table}\""), Vec::new())?;
            }
            Ok(())
        })();
        match rewritten {
            Ok(()) => self.commit_transaction_unlocked()?,
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                self.driver.generation_write(1);
                return Err(combine_rollback(error, rolled));
            }
        }
        self.driver.clear_statements();
        Ok(())
    }

    /// Persist a rev. An empty log is always a full-snapshot checkpoint (every insert and every
    /// checkpoint commit), taking the fast path with no append-detection probes. A non-empty log that
    /// extends an existing `main` rev is appended O(change) — the checkpoint snapshot on disk is left
    /// untouched, only the advanced frontier and the new tail deltas are written. Everything else
    /// (forks, archives, imports, log resets) rewrites the full snapshot via the checkpoint path.
    fn rev_write_unlocked(&self, state: &RevState, now_ms: i64) -> Result<(), StorageError> {
        if state.log.is_empty() {
            return self.rev_checkpoint_write_unlocked(state, now_ms);
        }
        let stored = self.rev_log_count_read_unlocked(&state.key)?;
        if state.log.len() > stored && self.rev_has_unlocked(&state.key)? {
            self.update_rev_meta_unlocked(&state.key, &state.frontier, now_ms)?;
            for (seq, delta) in state.log.iter().enumerate().skip(stored) {
                self.rev_log_write_unlocked(&state.key, seq, delta, now_ms)?;
            }
            Ok(())
        } else {
            self.rev_checkpoint_write_unlocked(state, now_ms)
        }
    }

    fn rev_checkpoint_write_unlocked(
        &self,
        state: &RevState,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let archived = state.lifecycle.archived();
        self.driver.execute(
            sql::write_rev(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(state.key.row.table.clone()),
                text_value(state.key.row.document_id.clone()),
                text_value(state.key.rev_id.clone()),
                Value::Blob(state.snapshot.clone()),
                Value::Blob(state.frontier.clone()),
                text_value(state.lifecycle.as_str().to_owned()),
                archived.map_or(Value::Null, |value| text_value(value.parent.clone())),
                archived
                    .and_then(|value| value.server_rev_id.clone())
                    .map_or(Value::Null, text_value),
                archived
                    .and_then(|value| value.server_root_id.clone())
                    .map_or(Value::Null, text_value),
                archived
                    .and_then(|value| value.server_node_id.clone())
                    .map_or(Value::Null, text_value),
                archived
                    .and_then(|value| value.base_root_id.clone())
                    .map_or(Value::Null, text_value),
                archived
                    .and_then(|value| value.base_node_id.clone())
                    .map_or(Value::Null, text_value),
                Value::from_i64(now_ms),
                Value::from_i64(now_ms),
            ],
        )?;
        self.rev_log_replace_unlocked(&state.key, &state.log, now_ms)
    }

    fn rev_has_unlocked(&self, key: &RevKey) -> Result<bool, StorageError> {
        Ok(self
            .driver
            .run_row(
                sql::exists_rev(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(key.row.table.clone()),
                    text_value(key.row.document_id.clone()),
                    text_value(key.rev_id.clone()),
                ],
                |row| int_at(row, 0),
            )?
            .is_some())
    }

    fn rev_log_count_read_unlocked(&self, key: &RevKey) -> Result<usize, StorageError> {
        let count = self
            .driver
            .run_row(
                sql::rev_log_count_read(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(key.row.table.clone()),
                    text_value(key.row.document_id.clone()),
                    text_value(key.rev_id.clone()),
                ],
                |row| int_at(row, 0),
            )?
            .unwrap_or(0);
        Ok(usize::try_from(count).unwrap_or(0))
    }

    fn update_rev_meta_unlocked(
        &self,
        key: &RevKey,
        frontier: &[u8],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.driver.execute(
            sql::update_rev_meta(),
            vec![
                Value::Blob(frontier.to_vec()),
                Value::from_i64(now_ms),
                text_value(self.identity_key.clone()),
                text_value(key.row.table.clone()),
                text_value(key.row.document_id.clone()),
                text_value(key.rev_id.clone()),
            ],
        )
    }

    /// Replace a rev's durable update-log with `log` (the checkpoint-path write). The append-path
    /// write (`rev_log_append_unlocked`) leaves the checkpoint snapshot untouched and only inserts the
    /// new tail rows, so a high-churn commit stays O(change) instead of rewriting the whole snapshot.
    fn rev_log_replace_unlocked(
        &self,
        key: &RevKey,
        log: &[Vec<u8>],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.driver.execute(
            sql::delete_rev_log(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(key.row.table.clone()),
                text_value(key.row.document_id.clone()),
                text_value(key.rev_id.clone()),
            ],
        )?;
        for (seq, delta) in log.iter().enumerate() {
            self.rev_log_write_unlocked(key, seq, delta, now_ms)?;
        }
        Ok(())
    }

    fn rev_log_write_unlocked(
        &self,
        key: &RevKey,
        seq: usize,
        delta: &[u8],
        now_ms: i64,
    ) -> Result<(), StorageError> {
        self.driver.execute(
            sql::write_rev_log(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(key.row.table.clone()),
                text_value(key.row.document_id.clone()),
                text_value(key.rev_id.clone()),
                Value::from_i64(seq as i64),
                Value::Blob(delta.to_vec()),
                Value::from_i64(now_ms),
            ],
        )
    }

    fn read_rev_log_unlocked(&self, key: &RevKey) -> Result<Vec<Vec<u8>>, StorageError> {
        let mut log = Vec::new();
        self.driver.run_rows(
            sql::read_rev_log(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(key.row.table.clone()),
                text_value(key.row.document_id.clone()),
                text_value(key.rev_id.clone()),
            ],
            |row| {
                log.push(blob_at(row, 0)?);
                Ok(())
            },
        )?;
        Ok(log)
    }

    /// Copy the current rev to a new content-addressed archived rev (status=Archived,
    /// origin=Reset, parent=current) so a server re-root never destroys the local edit. Idempotent.
    ///
    /// `server_ids.server_rev_id` is the hosted revision receipt returned for this exact row.
    /// `base_root_id`/`base_node_id` retain the dirty base metadata when present.
    fn archive_current_rev_unlocked(
        &self,
        table: &str,
        local_id: &str,
        server_ids: ArchiveServerIds,
        now_ms: i64,
    ) -> Result<Option<String>, StorageError> {
        let current_key = RevKey {
            rev_id: "main".to_owned(),
            row: RowKey {
                table: table.to_owned(),
                document_id: local_id.to_owned(),
            },
        };
        let Some(current) = self.read_rev_unlocked(&current_key)? else {
            return Ok(None);
        };
        let archive_id = crate::crdt::archive_rev_id(&current.frontier);
        self.rev_write_unlocked(
            &RevState {
                key: RevKey {
                    rev_id: archive_id.clone(),
                    row: current.key.row,
                },
                snapshot: current.snapshot,
                log: current.log,
                frontier: current.frontier,
                lifecycle: crate::types::RevLifecycle::Archived(crate::types::ArchivedRev {
                    parent: current.key.rev_id,
                    server_rev_id: server_ids.server_rev_id,
                    server_root_id: server_ids.server_root_id,
                    server_node_id: server_ids.server_node_id,
                    base_root_id: server_ids.base_root_id,
                    base_node_id: server_ids.base_node_id,
                }),
                updated_time: now_ms,
            },
            now_ms,
        )?;
        Ok(Some(archive_id))
    }

    fn remote_doc_write_unlocked(&self, state: &RowHead) -> Result<(), StorageError> {
        self.driver.execute(
            sql::write_projection(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(state.table.clone()),
                text_value(state.local_document_id.clone()),
                text_value(state.current_rev_id.clone()),
                text_value(state.server_document_id.clone()),
                text_value(state.projection_hash.clone()),
                state
                    .current_root_id
                    .clone()
                    .map_or(Value::Null, text_value),
                state
                    .current_node_id
                    .clone()
                    .map_or(Value::Null, text_value),
                state.server_base.clone().map_or(Value::Null, text_value),
                state.server_row.clone().map_or(Value::Null, text_value),
                Value::from_i64(state.updated_time),
                Value::from_f64(state.logical_clock),
            ],
        )
    }

    fn detach_stale_projection_document_unlocked(
        &self,
        record: &AuthoritativeRow,
        stale_id: &str,
        emit_reroot: bool,
        reroots: &mut Vec<crate::types::RetainedRevision>,
    ) -> Result<(), StorageError> {
        if let Some(dirty) = self.read_pending_local_edit_unlocked(&record.table, stale_id)? {
            self.materialize_dirty_head_for_row_unlocked(&record.table, stale_id)?;
            if let Some(archived_rev_id) = self.archive_current_rev_unlocked(
                &record.table,
                stale_id,
                ArchiveServerIds::default(),
                record.received_time,
            )? {
                if emit_reroot {
                    reroots.push(crate::types::RetainedRevision {
                        table: record.table.clone(),
                        local_document_id: stale_id.to_owned(),
                        archived_rev_id,
                        server_rev_id: None,
                        server_document_id: Some(record.server_document_id.clone()),
                        base_root_id: dirty.base_root_id,
                        base_node_id: dirty.base_node_id,
                        attached_node_id: None,
                        current_root_id: record.current_root_id.clone(),
                    });
                }
            }
        }
        self.rev_delete_current_unlocked(&record.table, stale_id)
    }

    /// Delete remap records that do not adopt: rows left under ids the mapping just detached
    /// are deleted (the same stale deletes an adopting record's batch carries).
    fn delete_stale_projection_rows_unlocked(
        &self,
        table: &str,
        stale_document_ids: &FxHashSet<String>,
    ) -> Result<Option<CommitResult>, StorageError> {
        if stale_document_ids.is_empty() {
            return Ok(None);
        }
        let runtime = self.runtime(table)?;
        let mut deletes = Vec::new();
        for stale_id in stale_document_ids {
            if self.row_has_pending_edit_unlocked(table, stale_id)? {
                continue;
            }
            let exists = self.driver.run_row(
                &runtime.read_sql,
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(stale_id.clone()),
                ],
                |_| Ok(()),
            )?;
            if exists.is_some() {
                deletes.push(crate::types::DeleteIn {
                    id: stale_id.clone(),
                    table: table.to_owned(),
                });
            }
        }
        if deletes.is_empty() {
            return Ok(None);
        }
        deletes.sort_by(|a, b| a.id.cmp(&b.id));
        let commit = self.commit_unlocked(
            &WriteBatch {
                deletes,
                ..WriteBatch::default()
            },
            &CommitOptions {
                source: CommitSource::Remote,
                ..CommitOptions::default()
            },
        )?;
        Ok(Some(commit))
    }

    /// True if the row has an un-pushed local edit. Such rows are dirty and must never be
    /// `projection_deleted`.
    fn row_has_pending_edit_unlocked(
        &self,
        table: &str,
        document_id: &str,
    ) -> Result<bool, StorageError> {
        let dirty = self.driver.run_row(
            sql::dirty_head_has(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(document_id.to_owned()),
            ],
            |_| Ok(()),
        )?;
        Ok(dirty.is_some())
    }

    fn read_pending_local_edit_unlocked(
        &self,
        table: &str,
        document_id: &str,
    ) -> Result<Option<PendingLocalEdit>, StorageError> {
        let head = self.read_dirty_head_unlocked(table, document_id)?;
        Ok(head.map(|head| PendingLocalEdit {
            base_root_id: head.base_root_id,
            base_node_id: head.base_node_id,
            base_projection_hash: head.base_projection_hash,
        }))
    }

    fn materialize_dirty_head_for_row_unlocked(
        &self,
        table: &str,
        document_id: &str,
    ) -> Result<(), StorageError> {
        let Some(head) = self.read_dirty_head_unlocked(table, document_id)? else {
            return Ok(());
        };
        self.materialize_dirty_head_state_unlocked(&head)
    }

    fn read_dirty_head_unlocked(
        &self,
        table: &str,
        document_id: &str,
    ) -> Result<Option<DirtyHead>, StorageError> {
        self.driver.run_row(
            sql::read_dirty_head(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(document_id.to_owned()),
            ],
            row_to_dirty_head,
        )
    }

    fn clear_pending_row_unlocked(
        &self,
        table: &str,
        document_id: &str,
    ) -> Result<(), StorageError> {
        self.driver.execute(
            sql::delete_crdt_ops_for_row(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(document_id.to_owned()),
            ],
        )?;
        self.driver.execute(
            sql::delete_dirty_head(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(document_id.to_owned()),
            ],
        )?;
        Ok(())
    }

    /// Tombstone a server-deleted document: drop the current rev and projection,
    /// but KEEP archived/fork revs (inspectable until GC). Rev-scoped (BUG-3).
    fn rev_delete_current_unlocked(
        &self,
        table: &str,
        document_id: &str,
    ) -> Result<(), StorageError> {
        self.clear_current_rev_unlocked(table, document_id)?;
        self.clear_pending_row_unlocked(table, document_id)?;
        let params = || {
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(document_id.to_owned()),
            ]
        };
        self.driver
            .execute(sql::delete_projection_row(), params())?;
        Ok(())
    }

    fn clear_current_rev_unlocked(
        &self,
        table: &str,
        document_id: &str,
    ) -> Result<(), StorageError> {
        self.driver.execute(
            sql::delete_rev(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(document_id.to_owned()),
                text_value("main".to_owned()),
            ],
        )
    }

    fn read_rev_unlocked(&self, key: &RevKey) -> Result<Option<RevState>, StorageError> {
        let stored = self.driver.run_row(
            sql::read_rev(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(key.row.table.clone()),
                text_value(key.row.document_id.clone()),
                text_value(key.rev_id.clone()),
            ],
            row_to_rev_state,
        )?;
        if let Some(mut state) = stored {
            state.log = self.read_rev_log_unlocked(key)?;
            return Ok(Some(state));
        }
        if key.rev_id != "main" {
            return Ok(None);
        }
        let Some(projection) =
            self.remote_doc_read_unlocked(&key.row.table, &key.row.document_id)?
        else {
            return Ok(None);
        };
        if projection.current_rev_id != key.rev_id {
            return Ok(None);
        }
        let row = self.materialized_doc_row_unlocked(&key.row)?;
        let table = self.def(&key.row.table)?;
        Ok(Some(crate::crdt::projection_to_state(
            &key.row,
            Some(table.as_ref()),
            row.as_deref(),
            projection.updated_time,
        )?))
    }

    fn remote_doc_read_unlocked(
        &self,
        table: &str,
        local_document_id: &str,
    ) -> Result<Option<RowHead>, StorageError> {
        self.driver.run_row(
            sql::read_projection(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(local_document_id.to_owned()),
            ],
            |row| {
                Ok(RowHead {
                    local_document_id: local_document_id.to_owned(),
                    current_rev_id: text_at(row, 0)?,
                    projection_hash: text_at(row, 2)?,
                    server_document_id: text_at(row, 1)?,
                    current_root_id: optional_text_at(row, 3)?,
                    current_node_id: optional_text_at(row, 4)?,
                    server_base: optional_text_at(row, 5)?,
                    table: table.to_owned(),
                    server_row: optional_text_at(row, 6)?,
                    updated_time: int_at(row, 7)?,
                    logical_clock: real_at(row, 8)?,
                })
            },
        )
    }

    fn local_id_for_server_unlocked(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError> {
        Ok(self
            .driver
            .run_row(
                sql::read_id_mapping_by_convex_id(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(table.to_owned()),
                    text_value(server_document_id.to_owned()),
                    text_value(
                        IdMappingContent::Deleted { convex_id: None }
                            .as_str()
                            .to_owned(),
                    ),
                ],
                |row| {
                    let mapping = row_to_id_mapping(row)?;
                    if is_local_document_id_for_table(table, &mapping.local_id)
                        && mapping.local_id != server_document_id
                    {
                        Ok(Some(mapping.local_id))
                    } else {
                        Ok(None)
                    }
                },
            )?
            .flatten())
    }

    fn projection_map_remote_id_unlocked(
        &self,
        table: &str,
        server_document_id: &str,
        proposed_local_document_id: Option<&str>,
        now_ms: i64,
    ) -> Result<ProjectionRemoteIdMapping, StorageError> {
        validate_ident(table)?;
        let (mapped_local_id, mapped_is_deleted) =
            match self.local_id_for_server_unlocked(table, server_document_id)? {
                Some(local_id) => (Some(local_id), false),
                None => (
                    self.deleted_local_id_for_server_unlocked(table, server_document_id)?,
                    true,
                ),
            };
        let proposed_local_id = proposed_local_document_id
            .filter(|id| is_local_document_id_for_table(table, id))
            .filter(|id| *id != server_document_id);
        let generated_local_id = remote_doc_id_encode(table, server_document_id);
        let local_id = match (mapped_local_id.as_deref(), proposed_local_id) {
            (Some(mapped), Some(proposed)) if mapped == generated_local_id => proposed.to_owned(),
            (Some(mapped), _) => mapped.to_owned(),
            (None, Some(proposed)) => proposed.to_owned(),
            (None, None) => generated_local_id,
        };
        let mut stale_document_ids = FxHashSet::default();
        if server_document_id != local_id {
            stale_document_ids.insert(server_document_id.to_owned());
        }
        for candidate in [mapped_local_id.as_deref(), proposed_local_document_id]
            .into_iter()
            .flatten()
        {
            if candidate != local_id {
                stale_document_ids.insert(candidate.to_owned());
            }
        }
        for stale_document_id in &stale_document_ids {
            self.rekey_local_fields_unlocked(table, stale_document_id, &local_id)?;
            self.driver.execute(
                sql::delete_id_mapping(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(table.to_owned()),
                    text_value(stale_document_id.clone()),
                ],
            )?;
        }
        let mapping = match mapped_local_id.as_deref() {
            Some(mapped) if mapped == local_id && mapped_is_deleted => IdMappingContent::Deleted {
                convex_id: Some(server_document_id.to_owned()),
            },
            _ => IdMappingContent::Mapped {
                convex_id: server_document_id.to_owned(),
            },
        };
        self.id_write_unlocked(&IdMapping {
            created_time: now_ms,
            local_id: local_id.clone(),
            mapping,
            table: table.to_owned(),
            updated_time: now_ms,
        })?;
        Ok(ProjectionRemoteIdMapping {
            local_id,
            stale_document_ids,
        })
    }

    fn rekey_local_fields_unlocked(
        &self,
        table: &str,
        from_id: &str,
        to_id: &str,
    ) -> Result<(), StorageError> {
        if from_id == to_id {
            return Ok(());
        }
        self.driver.execute(
            sql::rekey_local_fields(),
            vec![
                text_value(to_id.to_owned()),
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(from_id.to_owned()),
            ],
        )?;
        self.driver.execute(
            sql::delete_local_fields_row(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(from_id.to_owned()),
            ],
        )
    }

    fn deleted_local_id_for_server_unlocked(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError> {
        let mut local_id = None;
        self.driver.run_rows(
            sql::read_deleted_id_mappings_by_convex_id(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(server_document_id.to_owned()),
            ],
            |row| {
                let mapping = row_to_id_mapping(row)?;
                if is_local_document_id_for_table(table, &mapping.local_id)
                    && mapping.local_id != server_document_id
                    && local_id.is_none()
                {
                    local_id = Some(mapping.local_id);
                }
                Ok(())
            },
        )?;
        Ok(local_id)
    }

    fn read_peer_unlocked(&self) -> Result<Option<Vec<u8>>, StorageError> {
        self.driver.run_row(
            sql::read_peer(),
            vec![text_value(self.identity_key.clone())],
            |row| blob_at(row, 0),
        )
    }

    fn write_peer_unlocked(&self, peer_id: Vec<u8>, now_ms: i64) -> Result<(), StorageError> {
        let cached = peer_id_from_bytes(&peer_id).ok();
        self.driver.execute(
            sql::write_peer(),
            vec![
                text_value(self.identity_key.clone()),
                Value::Blob(peer_id),
                Value::from_i64(now_ms),
                Value::from_i64(now_ms),
            ],
        )?;
        *lock(&self.peer_id) = cached;
        Ok(())
    }

    fn ensure_peer_id_unlocked(&self, now_ms: i64) -> Result<u64, StorageError> {
        if let Some(peer_id) = *lock(&self.peer_id) {
            return Ok(peer_id);
        }
        if let Some(bytes) = self.read_peer_unlocked()? {
            let peer_id = peer_id_from_bytes(&bytes)?;
            *lock(&self.peer_id) = Some(peer_id);
            return Ok(peer_id);
        }
        let peer_id = create_peer_id();
        self.write_peer_unlocked(peer_id.to_be_bytes().to_vec(), now_ms)?;
        Ok(peer_id)
    }

    fn write_dirty_heads_for_batch_unlocked(
        &self,
        commit_seq: i64,
        batch: &WriteBatch,
    ) -> Result<(), StorageError> {
        let logical_clock = lock(&self.clock).now(wall_ms()?);
        let now_ms = logical_clock as i64;
        for doc_write in &batch.doc_writes {
            self.write_dirty_head_unlocked(
                &RowKey {
                    document_id: doc_write.id.clone(),
                    table: doc_write.table.clone(),
                },
                RowChangeOp::Write,
                commit_seq,
                now_ms,
                logical_clock,
                is_fresh_id(&batch.fresh_ids, &doc_write.table, &doc_write.id),
            )?;
        }
        for delete in &batch.deletes {
            self.write_dirty_head_unlocked(
                &RowKey {
                    document_id: delete.id.clone(),
                    table: delete.table.clone(),
                },
                RowChangeOp::Delete,
                commit_seq,
                now_ms,
                logical_clock,
                false,
            )?;
        }
        Ok(())
    }

    fn write_crdt_ops_unlocked(&self, commit_seq: i64, ops: &[CrdtOp]) -> Result<(), StorageError> {
        for (ordinal, op) in ops.iter().enumerate() {
            let (operation, value_json, index, delete, insert, delta) = match &op.operation {
                CrdtOperation::CountAdd { delta } => (
                    "count.add",
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::from_f64(*delta),
                ),
                CrdtOperation::SetAdd { value_json } => (
                    "set.add",
                    text_value(value_json.clone()),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Null,
                ),
                CrdtOperation::SetDelete { value_json } => (
                    "set.delete",
                    text_value(value_json.clone()),
                    Value::Null,
                    Value::Null,
                    Value::Null,
                    Value::Null,
                ),
                CrdtOperation::TextSplice {
                    index,
                    delete,
                    insert,
                } => (
                    "text.splice",
                    Value::Null,
                    Value::from_i64(*index),
                    Value::from_i64(*delete),
                    text_value(insert.clone()),
                    Value::Null,
                ),
            };
            self.driver.execute(
                sql::write_crdt_op(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(op.row.table.clone()),
                    text_value(op.row.document_id.clone()),
                    Value::from_i64(commit_seq),
                    Value::from_i64(ordinal as i64),
                    text_value(op.field.clone()),
                    text_value(operation.to_owned()),
                    value_json,
                    index,
                    delete,
                    insert,
                    delta,
                ],
            )?;
        }
        Ok(())
    }

    fn write_dirty_head_unlocked(
        &self,
        row: &RowKey,
        op: RowChangeOp,
        commit_seq: i64,
        now_ms: i64,
        logical_clock: f64,
        fresh: bool,
    ) -> Result<(), StorageError> {
        if fresh {
            let result = self.driver.execute(
                sql::write_dirty_head_fresh(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(row.table.clone()),
                    text_value(row.document_id.clone()),
                    text_value(op.as_str().to_owned()),
                    Value::from_i64(commit_seq),
                    Value::from_i64(commit_seq),
                    Value::from_i64(now_ms),
                    Value::from_i64(now_ms),
                    Value::from_f64(logical_clock),
                ],
            );
            return result;
        }
        self.driver.execute(
            sql::write_dirty_head_from_projection(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(row.table.clone()),
                text_value(row.document_id.clone()),
                text_value(op.as_str().to_owned()),
                Value::from_i64(commit_seq),
                Value::from_i64(commit_seq),
                Value::from_i64(now_ms),
                Value::from_i64(now_ms),
                Value::from_f64(logical_clock),
                text_value(self.identity_key.clone()),
                text_value(row.table.clone()),
                text_value(row.document_id.clone()),
            ],
        )
    }

    pub fn dirty_heads_debug_read(&self) -> Result<Vec<DirtyHeadDebug>, StorageError> {
        let _guard = lock(&self.operation_lock);
        let mut heads = Vec::new();
        self.driver.run_rows(
            sql::read_dirty_heads(),
            vec![text_value(self.identity_key.clone())],
            |row| {
                let head = row_to_dirty_head(row)?;
                heads.push(DirtyHeadDebug {
                    row: head.row,
                    op: head.change.op,
                    first_commit_seq: head.first_commit_seq,
                    updated_commit_seq: head.updated_commit_seq,
                    created_time: head.created_time,
                    updated_time: head.updated_time,
                    server_document_id: head.server_document_id,
                    base_projection_hash: head.base_projection_hash,
                    base_root_id: head.base_root_id,
                    base_node_id: head.base_node_id,
                    logical_clock: head.logical_clock,
                });
                Ok(())
            },
        )?;
        Ok(heads)
    }

    fn materialize_dirty_heads_unlocked(&self) -> Result<(), StorageError> {
        if !self.dirty_heads_has_unlocked()? {
            return Ok(());
        }
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let materialized = self.materialize_dirty_heads_in_tx_unlocked();
        match materialized {
            Ok(()) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(()),
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(e, rolled))
                }
            },
            Err(e) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(e, rolled))
            }
        }
    }

    fn materialize_dirty_heads_in_tx_unlocked(&self) -> Result<(), StorageError> {
        let mut heads = Vec::new();
        self.driver.run_rows(
            sql::read_dirty_heads(),
            vec![text_value(self.identity_key.clone())],
            |row| {
                heads.push(row_to_dirty_head(row)?);
                Ok(())
            },
        )?;
        let mut start = 0usize;
        while start < heads.len() {
            let commit_seq = heads[start].first_commit_seq;
            let mut end = start + 1;
            while end < heads.len() && heads[end].first_commit_seq == commit_seq {
                end += 1;
            }
            self.materialize_dirty_head_commit_unlocked(&heads[start..end])?;
            start = end;
        }
        Ok(())
    }

    fn dirty_heads_has_unlocked(&self) -> Result<bool, StorageError> {
        let mut found = false;
        self.driver.run_rows_until(
            sql::dirty_heads_has(),
            vec![text_value(self.identity_key.clone())],
            |_| {
                found = true;
                Ok(ControlFlow::Break(()))
            },
        )?;
        Ok(found)
    }

    fn materialize_dirty_head_commit_unlocked(
        &self,
        heads: &[DirtyHead],
    ) -> Result<(), StorageError> {
        for head in heads {
            self.materialize_dirty_head_state_unlocked(head)?;
        }
        Ok(())
    }

    fn materialize_dirty_head_state_unlocked(&self, head: &DirtyHead) -> Result<(), StorageError> {
        let key = RevKey {
            rev_id: "main".to_owned(),
            row: head.row.clone(),
        };
        let projection = match head.change.op {
            RowChangeOp::Write => {
                let Some(row) = self.materialized_doc_row_unlocked(&head.row)? else {
                    return Ok(());
                };
                Some(row)
            }
            RowChangeOp::Delete => None,
        };
        let existing = self.read_rev_unlocked(&key)?;
        if let Some(existing) = existing.as_ref() {
            let current = crate::crdt::rev_doc_read(existing, &head.row.document_id)?;
            if current == projection {
                return Ok(());
            }
        }
        let table_def = self.def(&head.row.table)?;
        let state = crate::crdt::projection_to_state(
            &head.row,
            Some(table_def.as_ref()),
            projection.as_deref(),
            head.updated_time,
        )?;
        self.rev_write_unlocked(&state, head.updated_time)?;
        Ok(())
    }

    fn materialized_doc_row_unlocked(&self, row: &RowKey) -> Result<Option<String>, StorageError> {
        let table = self.runtime(&row.table)?;
        self.driver.run_row(
            &table.read_sql,
            vec![
                text_value(self.identity_key.clone()),
                text_value(row.document_id.clone()),
            ],
            |data| {
                let mut text = String::new();
                append_doc(&mut text, data)?;
                Ok(text)
            },
        )
    }
}

/// Set the merged value of a CRDT field into a materialized row's JSON, supporting dotted paths for
/// nested collaborative fields, and re-serialize.
fn patch_row_field(
    row_json: &str,
    field: &str,
    value: serde_json::Value,
) -> Result<String, StorageError> {
    let serde_json::Value::Object(mut object) = parse_json_row(row_json)? else {
        return Err(StorageError::Decode {
            expected: "materialized row object",
            index: 0,
            got: row_json.chars().take(16).collect(),
        });
    };
    set_json_path(&mut object, field, value);
    serde_json::to_string(&serde_json::Value::Object(object)).map_err(|e| StorageError::Decode {
        expected: "patched row json",
        index: 0,
        got: e.to_string(),
    })
}

/// Read a (possibly dotted) field path out of a materialized row's JSON, or `None` if absent.
fn read_json_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = value;
    for segment in path.split('.') {
        current = current.as_object()?.get(segment)?;
    }
    Some(current)
}

fn set_json_path(
    object: &mut serde_json::Map<String, serde_json::Value>,
    path: &str,
    value: serde_json::Value,
) {
    match path.split_once('.') {
        None => {
            object.insert(path.to_owned(), value);
        }
        Some((head, rest)) => {
            let child = object
                .entry(head.to_owned())
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(child) = child {
                set_json_path(child, rest, value);
            } else {
                let mut map = serde_json::Map::new();
                set_json_path(&mut map, rest, value);
                *child = serde_json::Value::Object(map);
            }
        }
    }
}

/// Serialize a CRDT field's checkpoint+log into one length-prefixed blob column: snapshot, frontier,
/// then a count and each oldest-first log delta. The inverse is [`decode_crdt_field_state`].
fn encode_crdt_field_state(state: &crate::crdt::CrdtFieldState) -> Vec<u8> {
    let mut out = Vec::new();
    push_len_prefixed(&mut out, &state.snapshot);
    push_len_prefixed(&mut out, &state.frontier);
    out.extend_from_slice(
        &u32::try_from(state.log.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    for delta in &state.log {
        push_len_prefixed(&mut out, delta);
    }
    out.extend_from_slice(&state.server_seq.to_be_bytes());
    push_len_prefixed(&mut out, state.server_projection_hash.as_bytes());
    out.extend_from_slice(&state.server_epoch.to_be_bytes());
    match &state.accepted {
        Some(accepted) => {
            out.push(1);
            push_len_prefixed(&mut out, &accepted.snapshot);
            push_len_prefixed(&mut out, &accepted.frontier);
            out.extend_from_slice(
                &u32::try_from(accepted.log.len())
                    .unwrap_or(u32::MAX)
                    .to_be_bytes(),
            );
            for delta in &accepted.log {
                push_len_prefixed(&mut out, delta);
            }
        }
        None => out.push(0),
    }
    out
}

fn push_len_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u32::try_from(bytes.len()).unwrap_or(u32::MAX).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn decode_crdt_field_state(bytes: &[u8]) -> Result<crate::crdt::CrdtFieldState, StorageError> {
    let mut cursor = 0usize;
    let snapshot = read_len_prefixed(bytes, &mut cursor)?;
    let frontier = read_len_prefixed(bytes, &mut cursor)?;
    let count = read_u32(bytes, &mut cursor)? as usize;
    let mut log = Vec::with_capacity(count);
    for _ in 0..count {
        log.push(read_len_prefixed(bytes, &mut cursor)?);
    }
    let server_seq = read_i64(bytes, &mut cursor)?;
    let server_projection_hash = String::from_utf8(read_len_prefixed(bytes, &mut cursor)?)
        .map_err(|error| StorageError::Decode {
            expected: "crdt server projection hash",
            index: 0,
            got: error.to_string(),
        })?;
    let server_epoch = read_i64(bytes, &mut cursor)?;
    let accepted = match read_byte(bytes, &mut cursor)? {
        0 => None,
        1 => {
            let snapshot = read_len_prefixed(bytes, &mut cursor)?;
            let frontier = read_len_prefixed(bytes, &mut cursor)?;
            let count = read_u32(bytes, &mut cursor)? as usize;
            let mut log = Vec::with_capacity(count);
            for _ in 0..count {
                log.push(read_len_prefixed(bytes, &mut cursor)?);
            }
            Some(crate::crdt::CrdtAcceptedState {
                snapshot,
                log,
                frontier,
            })
        }
        marker => {
            return Err(StorageError::Decode {
                expected: "crdt accepted-state marker",
                index: cursor.saturating_sub(1),
                got: marker.to_string(),
            });
        }
    };
    if cursor != bytes.len() {
        return Err(StorageError::Decode {
            expected: "complete crdt field state",
            index: cursor,
            got: "trailing bytes".to_owned(),
        });
    }
    Ok(crate::crdt::CrdtFieldState {
        snapshot,
        log,
        frontier,
        server_epoch,
        server_seq,
        server_projection_hash,
        accepted,
    })
}

fn read_byte(bytes: &[u8], cursor: &mut usize) -> Result<u8, StorageError> {
    let value = bytes.get(*cursor).copied().ok_or(StorageError::Decode {
        expected: "crdt field byte",
        index: *cursor,
        got: "truncated".to_owned(),
    })?;
    *cursor += 1;
    Ok(value)
}

fn read_i64(bytes: &[u8], cursor: &mut usize) -> Result<i64, StorageError> {
    let end = *cursor + 8;
    let slice = bytes.get(*cursor..end).ok_or(StorageError::Decode {
        expected: "crdt field server sequence",
        index: 0,
        got: "truncated".to_owned(),
    })?;
    *cursor = end;
    Ok(i64::from_be_bytes(slice.try_into().expect("8 byte slice")))
}

fn read_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, StorageError> {
    let end = *cursor + 4;
    let slice = bytes.get(*cursor..end).ok_or(StorageError::Decode {
        expected: "crdt field state length",
        index: 0,
        got: "truncated".to_owned(),
    })?;
    *cursor = end;
    Ok(u32::from_be_bytes(slice.try_into().expect("4 byte slice")))
}

fn read_len_prefixed(bytes: &[u8], cursor: &mut usize) -> Result<Vec<u8>, StorageError> {
    let len = read_u32(bytes, cursor)? as usize;
    let end = *cursor + len;
    let slice = bytes.get(*cursor..end).ok_or(StorageError::Decode {
        expected: "crdt field state payload",
        index: 0,
        got: "truncated".to_owned(),
    })?;
    *cursor = end;
    Ok(slice.to_vec())
}

fn parse_json_row(row: &str) -> Result<serde_json::Value, StorageError> {
    serde_json::from_str(row).map_err(|error| StorageError::Decode {
        expected: "json row",
        index: 0,
        got: error.to_string(),
    })
}

fn result_disclosed_rows(
    result: Option<&ResultEntry>,
) -> Result<FxHashSet<RemoteMember>, StorageError> {
    let Some(entry) = result else {
        return Ok(FxHashSet::default());
    };
    result_disclosed_rows_from_paths(&entry.paths)
}

fn result_disclosed_rows_from_paths(paths: &[u8]) -> Result<FxHashSet<RemoteMember>, StorageError> {
    let paths = serde_json::from_slice::<serde_json::Value>(paths).map_err(|error| {
        StorageError::Decode {
            expected: "retained result paths",
            index: 0,
            got: error.to_string(),
        }
    })?;
    let serde_json::Value::Array(paths) = paths else {
        return Err(StorageError::Decode {
            expected: "retained result paths array",
            index: 0,
            got: "non-array".to_owned(),
        });
    };
    let mut rows = FxHashSet::default();
    for path in paths {
        if let (Some(table), Some(server_document_id)) = (
            path.get("table").and_then(serde_json::Value::as_str),
            path.get("rowId").and_then(serde_json::Value::as_str),
        ) {
            rows.insert(RemoteMember {
                table: table.to_owned(),
                server_document_id: server_document_id.to_owned(),
            });
        }
    }
    Ok(rows)
}

impl EmbeddedStore {
    pub fn id_write(&self, mapping: &IdMapping) -> Result<(), StorageError> {
        validate_ident(&mapping.table)?;
        let _guard = lock(&self.operation_lock);
        self.validate_id_mapping_table(&mapping.table)?;
        self.transaction_unlocked(|| {
            self.id_write_unlocked(mapping)?;
            self.origin_id_mapping_write_unlocked(mapping)
        })
    }

    fn id_write_unlocked(&self, mapping: &IdMapping) -> Result<(), StorageError> {
        self.driver.execute(
            sql::write_id_mapping(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(mapping.table.clone()),
                text_value(mapping.local_id.clone()),
                mapping
                    .convex_id()
                    .map_or(Value::Null, |id| text_value(id.to_owned())),
                text_value(mapping.mapping.as_str().to_owned()),
                Value::from_i64(mapping.created_time),
                Value::from_i64(mapping.updated_time),
            ],
        )
    }

    pub fn id_read(&self, table: &str, local_id: &str) -> Result<Option<IdMapping>, StorageError> {
        validate_ident(table)?;
        let _guard = lock(&self.operation_lock);
        self.validate_id_mapping_table(table)?;
        self.id_read_unlocked(table, local_id)
    }

    pub fn id_local_read(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError> {
        validate_ident(table)?;
        let _guard = lock(&self.operation_lock);
        self.validate_id_mapping_table(table)?;
        self.local_id_for_server_unlocked(table, server_document_id)
    }

    fn id_read_unlocked(
        &self,
        table: &str,
        local_id: &str,
    ) -> Result<Option<IdMapping>, StorageError> {
        self.driver.run_row(
            sql::read_id_mapping(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(local_id.to_owned()),
            ],
            row_to_id_mapping,
        )
    }

    pub fn id_page_read(&self, table: &str) -> Result<Vec<IdMapping>, StorageError> {
        validate_ident(table)?;
        let mut out = Vec::new();
        let _guard = lock(&self.operation_lock);
        self.validate_id_mapping_table(table)?;
        self.driver.run_rows(
            sql::read_id_mappings(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
            ],
            |row| {
                out.push(row_to_id_mapping(row)?);
                Ok(())
            },
        )?;
        Ok(out)
    }

    pub fn id_delete(&self, table: &str, local_id: &str) -> Result<(), StorageError> {
        validate_ident(table)?;
        let _guard = lock(&self.operation_lock);
        self.validate_id_mapping_table(table)?;
        self.transaction_unlocked(|| {
            self.driver.execute(
                sql::delete_id_mapping(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(table.to_owned()),
                    text_value(local_id.to_owned()),
                ],
            )?;
            self.origin_delete_unlocked(
                OriginKind::IdMapping,
                &origin_key(&[table.as_bytes(), local_id.as_bytes()]),
            )
        })
    }

    pub fn file_meta_write(&self, metadata: &FileMetadata) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.file_meta_write_unlocked(metadata)
    }

    fn file_meta_write_unlocked(&self, metadata: &FileMetadata) -> Result<(), StorageError> {
        self.driver.execute(
            sql::write_file(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(metadata.storage_id.clone()),
                text_value(metadata.sha256.clone()),
                Value::from_i64(metadata.size),
                metadata
                    .content_type
                    .clone()
                    .map_or(Value::Null, text_value),
                metadata.source.clone().map_or(Value::Null, text_value),
                Value::from_i64(metadata.created_time),
                Value::from_i64(metadata.updated_time),
            ],
        )
    }

    pub fn file_read(&self, storage_id: &str) -> Result<Option<FileMetadata>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.run_row(
            sql::read_file(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(storage_id.to_owned()),
            ],
            row_to_file_metadata,
        )
    }

    pub fn file_delete(&self, storage_id: &str) -> Result<(), StorageError> {
        let now = wall_ms()? as i64;
        let _guard = lock(&self.operation_lock);
        let existing = self.driver.run_row(
            sql::read_id_mapping(),
            vec![
                text_value(self.identity_key.clone()),
                text_value("_storage".to_owned()),
                text_value(storage_id.to_owned()),
            ],
            row_to_id_mapping,
        )?;
        let deleted = IdMapping {
            table: "_storage".to_owned(),
            local_id: storage_id.to_owned(),
            mapping: IdMappingContent::Deleted {
                convex_id: existing
                    .as_ref()
                    .and_then(|mapping| mapping.convex_id().map(str::to_owned)),
            },
            created_time: existing
                .as_ref()
                .map_or(now, |mapping| mapping.created_time),
            updated_time: now,
        };
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written: Result<(), StorageError> = (|| {
            self.driver.execute(
                sql::delete_blob(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(storage_id.to_owned()),
                ],
            )?;
            self.driver.execute(
                sql::delete_file(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(storage_id.to_owned()),
                ],
            )?;
            self.driver.execute(
                sql::delete_upload(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(storage_id.to_owned()),
                ],
            )?;
            self.id_write_unlocked(&deleted)?;
            self.origin_delete_unlocked(OriginKind::Blob, storage_id.as_bytes())?;
            self.origin_delete_unlocked(OriginKind::Upload, storage_id.as_bytes())?;
            self.origin_id_mapping_write_unlocked(&deleted)
        })();
        match written {
            Ok(()) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(()),
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(e, rolled))
                }
            },
            Err(e) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(e, rolled))
            }
        }
    }

    pub fn upload_write(&self, upload: &PendingUpload) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.transaction_unlocked(|| {
            self.upload_write_unlocked(upload)?;
            self.origin_upload_write_unlocked(upload)
        })
    }

    fn upload_write_unlocked(&self, upload: &PendingUpload) -> Result<(), StorageError> {
        self.driver.execute(
            sql::write_upload(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(upload.local_storage_id.clone()),
                text_value(upload.sha256.clone()),
                Value::from_i64(upload.size),
                upload.content_type.clone().map_or(Value::Null, text_value),
                text_value(upload.lease.as_str().to_owned()),
                upload
                    .lease
                    .owner()
                    .map_or(Value::Null, |owner| text_value(owner.to_owned())),
                upload
                    .lease
                    .lease_until()
                    .map_or(Value::Null, Value::from_i64),
                Value::from_i64(upload.created_time),
                Value::from_i64(upload.updated_time),
            ],
        )
    }

    pub fn file_write(&self, input: &FileStore) -> Result<(), StorageError> {
        let now = input.metadata.updated_time;
        let mapping = IdMapping {
            table: "_storage".to_owned(),
            local_id: input.metadata.storage_id.clone(),
            mapping: IdMappingContent::Local,
            created_time: input.metadata.created_time,
            updated_time: now,
        };
        let upload = PendingUpload {
            local_storage_id: input.metadata.storage_id.clone(),
            sha256: input.metadata.sha256.clone(),
            size: input.metadata.size,
            content_type: input.metadata.content_type.clone(),
            lease: UploadLease::Pending,
            created_time: input.metadata.created_time,
            updated_time: now,
        };

        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written: Result<(), StorageError> = (|| {
            self.driver.execute(
                sql::write_blob(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(input.metadata.storage_id.clone()),
                    Value::Blob(input.bytes.clone()),
                ],
            )?;
            self.file_meta_write_unlocked(&input.metadata)?;
            self.id_write_unlocked(&mapping)?;
            self.upload_write_unlocked(&upload)?;
            self.origin_blob_write_unlocked(input)?;
            self.origin_id_mapping_write_unlocked(&mapping)?;
            self.origin_upload_write_unlocked(&upload)
        })();
        match written {
            Ok(()) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(()),
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(e, rolled))
                }
            },
            Err(e) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(e, rolled))
            }
        }
    }

    pub fn upload_read(&self) -> Result<Vec<PendingUpload>, StorageError> {
        let mut out = Vec::new();
        let _guard = lock(&self.operation_lock);
        self.driver.run_rows(
            sql::read_uploads(),
            vec![text_value(self.identity_key.clone())],
            |row| {
                out.push(row_to_pending_upload(row)?);
                Ok(())
            },
        )?;
        Ok(out)
    }

    pub fn upload_has_pending(&self) -> Result<bool, StorageError> {
        let _guard = lock(&self.operation_lock);
        Ok(self
            .driver
            .run_row(
                sql::uploads_has(),
                vec![text_value(self.identity_key.clone())],
                |_row| Ok(()),
            )?
            .is_some())
    }

    /// Write one exact upload-lease lifecycle target state.
    #[allow(clippy::too_many_lines)]
    pub fn upload_lease_write(
        &self,
        args: UploadLeaseWrite,
    ) -> Result<Option<PendingUpload>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.transaction_unlocked(|| match args {
            UploadLeaseWrite::Claimed {
                local_storage_id: None,
                owner,
                now_ms,
                lease_until,
            } => {
                let candidate = self.driver.run_row(
                    sql::upload_lease_pending_read(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(UploadLease::PENDING.to_owned()),
                        Value::from_i64(now_ms),
                        Value::from_i64(1),
                    ],
                    row_to_pending_upload,
                )?;
                let Some(candidate) = candidate else {
                    return Ok(None);
                };
                self.driver.execute(
                    sql::upload_lease_next_claimed_write(),
                    vec![
                        text_value(UploadLease::CLAIMED.to_owned()),
                        text_value(owner.clone()),
                        Value::from_i64(lease_until),
                        Value::from_i64(now_ms),
                        text_value(self.identity_key.clone()),
                        text_value(candidate.local_storage_id.clone()),
                        text_value(UploadLease::PENDING.to_owned()),
                        Value::from_i64(now_ms),
                    ],
                )?;
                if self.driver.changes() == 0 {
                    return Ok(None);
                }
                let updated = PendingUpload {
                    lease: UploadLease::Claimed { owner, lease_until },
                    updated_time: now_ms,
                    ..candidate
                };
                self.origin_upload_write_unlocked(&updated)?;
                Ok(Some(updated))
            }
            UploadLeaseWrite::Pending {
                local_storage_id,
                owner,
                now_ms,
            } => {
                self.driver.execute(
                    sql::upload_lease_pending_write(),
                    vec![
                        text_value(UploadLease::PENDING.to_owned()),
                        Value::from_i64(now_ms),
                        text_value(self.identity_key.clone()),
                        text_value(local_storage_id.clone()),
                        text_value(owner),
                    ],
                )?;
                if let Some(updated) = self.driver.run_row(
                    sql::read_upload(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(local_storage_id),
                    ],
                    row_to_pending_upload,
                )? {
                    self.origin_upload_write_unlocked(&updated)?;
                }
                Ok(None)
            }
            UploadLeaseWrite::Claimed {
                local_storage_id: Some(local_storage_id),
                owner,
                now_ms,
                lease_until,
            } => {
                let row = self.driver.run_row(
                    sql::read_upload(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(local_storage_id.clone()),
                    ],
                    row_to_pending_upload,
                )?;
                self.driver.execute(
                    sql::upload_lease_claimed_write(),
                    vec![
                        Value::from_i64(lease_until),
                        Value::from_i64(now_ms),
                        text_value(self.identity_key.clone()),
                        text_value(local_storage_id),
                        text_value(owner.clone()),
                        text_value(UploadLease::CLAIMED.to_owned()),
                    ],
                )?;
                if self.driver.changes() == 0 {
                    return Ok(None);
                }
                let updated = row.map(|row| PendingUpload {
                    lease: UploadLease::Claimed { owner, lease_until },
                    updated_time: now_ms,
                    ..row
                });
                if let Some(updated) = &updated {
                    self.origin_upload_write_unlocked(updated)?;
                }
                Ok(updated)
            }
        })
    }

    pub fn upload_delete(&self, local_storage_id: &str) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.transaction_unlocked(|| {
            self.driver.execute(
                sql::delete_upload(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(local_storage_id.to_owned()),
                ],
            )?;
            self.origin_delete_unlocked(OriginKind::Upload, local_storage_id.as_bytes())
        })
    }

    pub fn upload_complete(
        &self,
        local_storage_id: &str,
        owner: &str,
        convex_id: &str,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        if convex_id.is_empty() {
            return Err(StorageError::Unsatisfiable(
                "upload completion requires a hosted _storage id".to_owned(),
            ));
        }

        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written: Result<bool, StorageError> = (|| {
            let existing = self.driver.run_row(
                sql::read_id_mapping(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value("_storage".to_owned()),
                    text_value(local_storage_id.to_owned()),
                ],
                row_to_id_mapping,
            )?;
            self.driver.execute(
                sql::complete_upload(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(local_storage_id.to_owned()),
                    text_value(owner.to_owned()),
                    text_value(UploadLease::CLAIMED.to_owned()),
                ],
            )?;
            let completed = self.driver.changes() > 0;
            if completed {
                let mapping = IdMapping {
                    table: "_storage".to_owned(),
                    local_id: local_storage_id.to_owned(),
                    mapping: IdMappingContent::Mapped {
                        convex_id: convex_id.to_owned(),
                    },
                    created_time: existing
                        .as_ref()
                        .map_or(now_ms, |mapping| mapping.created_time),
                    updated_time: now_ms,
                };
                self.id_write_unlocked(&mapping)?;
                self.origin_id_mapping_write_unlocked(&mapping)?;
                self.origin_delete_unlocked(OriginKind::Upload, local_storage_id.as_bytes())?;
            }
            Ok(completed)
        })();
        match written {
            Ok(completed) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(completed),
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    Err(combine_rollback(e, rolled))
                }
            },
            Err(e) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                Err(combine_rollback(e, rolled))
            }
        }
    }

    pub fn schedule_write(&self, job: &ScheduledJob) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.transaction_unlocked(|| {
            self.schedule_write_unlocked(job)?;
            self.origin_schedule_write_unlocked(job)
        })
    }

    fn schedule_write_unlocked(&self, job: &ScheduledJob) -> Result<(), StorageError> {
        self.driver.execute(
            sql::write_schedule(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(job.job_id.clone()),
                text_value(job.kind.as_str().to_owned()),
                text_value(job.name.clone()),
                text_value(job.args.clone()),
                Value::from_i64(job.due_time),
                text_value(job.state.as_str().to_owned()),
                job.state.lease_until().map_or(Value::Null, Value::from_i64),
                Value::from_i64(job.created_time),
                Value::from_i64(job.updated_time),
            ],
        )
    }

    #[cfg(any(test, feature = "testkit"))]
    pub fn schedule_lease_read(&self, now_ms: i64) -> Result<Vec<ScheduledJob>, StorageError> {
        let mut out = Vec::new();
        let _guard = lock(&self.operation_lock);
        self.driver.run_rows(
            sql::schedule_lease_read(),
            schedule_lease_params(&self.identity_key.clone(), now_ms),
            |row| {
                out.push(row_to_scheduled_job(row)?);
                Ok(())
            },
        )?;
        Ok(out)
    }

    pub fn schedule_read(&self) -> Result<Vec<ScheduledJob>, StorageError> {
        let mut out = Vec::new();
        let _guard = lock(&self.operation_lock);
        self.driver.run_rows(
            sql::read_schedules(),
            vec![text_value(self.identity_key.clone())],
            |row| {
                out.push(row_to_scheduled_job(row)?);
                Ok(())
            },
        )?;
        Ok(out)
    }

    pub fn schedule_lease_write(&self, now_ms: i64) -> Result<Option<ScheduledJob>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.transaction_unlocked(|| {
            let mut candidates = Vec::new();
            self.driver.run_rows(
                sql::schedule_lease_read(),
                schedule_lease_params(&self.identity_key.clone(), now_ms),
                |row| {
                    candidates.push(row_to_scheduled_job(row)?);
                    Ok(())
                },
            )?;
            let lease_until = now_ms.saturating_add(SCHEDULE_LEASE_MS);
            for candidate in candidates {
                self.driver.execute(
                    sql::write_schedule_lease(),
                    vec![
                        text_value(ScheduledState::RUNNING.to_owned()),
                        Value::from_i64(now_ms),
                        Value::from_i64(lease_until),
                        text_value(self.identity_key.clone()),
                        text_value(candidate.job_id.clone()),
                        text_value(ScheduledState::PENDING.to_owned()),
                        Value::from_i64(now_ms),
                        text_value(ScheduledState::RUNNING.to_owned()),
                        Value::from_i64(now_ms),
                    ],
                )?;
                if self.driver.changes() > 0 {
                    let updated = ScheduledJob {
                        state: ScheduledState::Running { lease_until },
                        updated_time: now_ms,
                        ..candidate
                    };
                    self.origin_schedule_write_unlocked(&updated)?;
                    return Ok(Some(updated));
                }
            }
            Ok(None)
        })
    }

    pub fn schedule_complete(
        &self,
        job_id: &str,
        now_ms: i64,
    ) -> Result<Option<ScheduledJob>, StorageError> {
        if let Some(job) = self.schedule_state(
            job_id,
            ScheduledState::RUNNING,
            ScheduledState::Complete,
            now_ms,
        )? {
            return Ok(Some(job));
        }
        self.schedule_state(
            job_id,
            ScheduledState::PENDING,
            ScheduledState::Complete,
            now_ms,
        )
    }

    fn schedule_remote_complete_unlocked(
        &self,
        mappings: &[crate::types::RemoteScheduleMapping],
        now_ms: i64,
    ) -> Result<Vec<ScheduledJob>, StorageError> {
        let table = "_scheduled_functions";
        let mut completed = Vec::with_capacity(mappings.len());
        for mapping in mappings {
            let job_id = &mapping.local_id;
            let convex_id = &mapping.server_id;
            let existing_mapping = self.id_read_unlocked(table, job_id)?;
            if let Some(mapping) = &existing_mapping {
                if mapping.convex_id() != Some(convex_id) {
                    return Err(StorageError::Unsatisfiable(
                        "local schedule id is already bound to a different hosted id".to_owned(),
                    ));
                }
            }

            let current = self.driver.run_row(
                sql::read_schedule(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(job_id.clone()),
                ],
                row_to_scheduled_job,
            )?;
            let Some(current) = current else {
                return Err(StorageError::Unsatisfiable(
                    "remote schedule completion references an unknown local job".to_owned(),
                ));
            };
            match &current.state {
                ScheduledState::Pending | ScheduledState::Running { .. } => {
                    self.driver.execute(
                        sql::write_schedule_state(),
                        vec![
                            text_value(ScheduledState::Complete.as_str().to_owned()),
                            Value::from_i64(now_ms),
                            Value::Null,
                            text_value(self.identity_key.clone()),
                            text_value(job_id.clone()),
                            text_value(current.state.as_str().to_owned()),
                        ],
                    )?;
                    if self.driver.changes() == 0 {
                        return Err(StorageError::Unsatisfiable(
                            "remote schedule state changed during completion".to_owned(),
                        ));
                    }
                }
                ScheduledState::Complete if existing_mapping.is_some() => {}
                ScheduledState::Canceled => {}
                _ => {
                    return Err(StorageError::Unsatisfiable(format!(
                        "cannot remotely complete schedule in {} state",
                        current.state.as_str()
                    )))
                }
            }

            if existing_mapping.is_none() {
                let mapping = IdMapping {
                    table: table.to_owned(),
                    local_id: job_id.clone(),
                    mapping: IdMappingContent::Mapped {
                        convex_id: convex_id.clone(),
                    },
                    created_time: now_ms,
                    updated_time: now_ms,
                };
                self.id_write_unlocked(&mapping)?;
                self.origin_id_mapping_write_unlocked(&mapping)?;
            }
            let job = self
                .driver
                .run_row(
                    sql::read_schedule(),
                    vec![
                        text_value(self.identity_key.clone()),
                        text_value(job_id.clone()),
                    ],
                    row_to_scheduled_job,
                )?
                .ok_or_else(|| {
                    StorageError::Unsatisfiable("completed remote schedule disappeared".to_owned())
                })?;
            self.origin_schedule_write_unlocked(&job)?;
            completed.push(job);
        }
        Ok(completed)
    }

    pub fn schedule_fail(
        &self,
        job_id: &str,
        now_ms: i64,
    ) -> Result<Option<ScheduledJob>, StorageError> {
        if let Some(job) = self.schedule_state(
            job_id,
            ScheduledState::RUNNING,
            ScheduledState::Failed,
            now_ms,
        )? {
            return Ok(Some(job));
        }
        self.schedule_state(
            job_id,
            ScheduledState::PENDING,
            ScheduledState::Failed,
            now_ms,
        )
    }

    fn schedule_fail_unlocked(
        &self,
        job_id: &str,
        now_ms: i64,
    ) -> Result<Option<ScheduledJob>, StorageError> {
        if let Some(job) = self.schedule_state_unlocked(
            job_id,
            ScheduledState::RUNNING,
            ScheduledState::Failed,
            now_ms,
        )? {
            self.origin_schedule_write_unlocked(&job)?;
            return Ok(Some(job));
        }
        let job = self.schedule_state_unlocked(
            job_id,
            ScheduledState::PENDING,
            ScheduledState::Failed,
            now_ms,
        )?;
        if let Some(job) = &job {
            self.origin_schedule_write_unlocked(job)?;
        }
        Ok(job)
    }

    pub fn schedule_cancel(
        &self,
        job_id: &str,
        now_ms: i64,
    ) -> Result<Option<ScheduledJob>, StorageError> {
        if let Some(job) = self.schedule_state(
            job_id,
            ScheduledState::PENDING,
            ScheduledState::Canceled,
            now_ms,
        )? {
            return Ok(Some(job));
        }
        if self
            .id_read("_scheduled_functions", job_id)?
            .and_then(|mapping| mapping.convex_id().map(str::to_owned))
            .is_some()
        {
            return self.schedule_state(
                job_id,
                ScheduledState::COMPLETE,
                ScheduledState::Canceled,
                now_ms,
            );
        }
        Ok(None)
    }

    fn schedule_state(
        &self,
        job_id: &str,
        expected: &str,
        state: ScheduledState,
        now_ms: i64,
    ) -> Result<Option<ScheduledJob>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.transaction_unlocked(|| {
            let updated = self.schedule_state_unlocked(job_id, expected, state, now_ms)?;
            if let Some(updated) = &updated {
                self.origin_schedule_write_unlocked(updated)?;
            }
            Ok(updated)
        })
    }

    fn schedule_state_unlocked(
        &self,
        job_id: &str,
        expected: &str,
        state: ScheduledState,
        now_ms: i64,
    ) -> Result<Option<ScheduledJob>, StorageError> {
        self.driver.execute(
            sql::write_schedule_state(),
            vec![
                text_value(state.as_str().to_owned()),
                Value::from_i64(now_ms),
                Value::Null,
                text_value(self.identity_key.clone()),
                text_value(job_id.to_owned()),
                text_value(expected.to_owned()),
            ],
        )?;
        if self.driver.changes() == 0 {
            return Ok(None);
        }
        self.driver.run_row(
            sql::read_schedule(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(job_id.to_owned()),
            ],
            row_to_scheduled_job,
        )
    }

    fn reserve_commit_seq_unlocked(&self) -> Result<i64, StorageError> {
        let key = self.commit_seq_key.clone();
        if let Some(max_seq) = lock(&COMMIT_SEQ_CACHE).get_mut(&key) {
            *max_seq += 1;
            return Ok(*max_seq);
        }
        let max_seq = self
            .driver
            .run_row(
                sql::max_commit_seq(),
                max_commit_seq_params(&self.identity_key.clone()),
                |row| int_at(row, 0),
            )?
            .ok_or(StorageError::Decode {
                expected: "commit sequence",
                index: 0,
                got: "missing row".to_owned(),
            })?;
        let next = max_seq + 1;
        lock(&COMMIT_SEQ_CACHE).insert(key, next);
        Ok(next)
    }

    fn observe_commit_seq(&self, commit_seq: i64) {
        let mut cache = lock(&COMMIT_SEQ_CACHE);
        let entry = cache.entry(self.commit_seq_key.clone()).or_insert(0);
        if commit_seq > *entry {
            *entry = commit_seq;
        }
    }

    fn observe_commit_results(&self, commits: &[CommitResult]) {
        if let Some(max_seq) = commits.iter().map(|commit| commit.commit_seq).max() {
            self.observe_commit_seq(max_seq);
        }
    }

    fn reset_commit_seq_cache(&self, max_seq: i64) {
        lock(&COMMIT_SEQ_CACHE).insert(self.commit_seq_key.clone(), max_seq);
    }

    fn write_commit_unlocked(
        &self,
        changed_tables: Vec<String>,
        changes: Vec<RowChange>,
        options: &CommitOptions,
    ) -> Result<CommitResult, StorageError> {
        let commit_seq = self.reserve_commit_seq_unlocked()?;
        let mut commit_existing_mutation = false;
        let mut terminal_mutation_call = None;
        if let Some(mutation_id) = options.mutation_id() {
            if let Some(call) = self.take_absent_mutation_call(mutation_id, options) {
                terminal_mutation_call = Some(call);
            } else if options.mutation_is_fresh() {
                terminal_mutation_call =
                    Some(require_terminal_mutation_call(options, mutation_id)?);
            } else {
                match self.mutation_record_unlocked(mutation_id)? {
                    Some(record) if record.status == MutationStatus::Accepted => {
                        commit_existing_mutation = true;
                    }
                    Some(record) => {
                        return Err(StorageError::Unsatisfiable(format!(
                            "mutation id {mutation_id} cannot commit from {:?}",
                            record.status
                        )));
                    }
                    None => {
                        terminal_mutation_call =
                            Some(require_terminal_mutation_call(options, mutation_id)?);
                    }
                }
            }
        }
        let write_commit_row = !options.is_local();
        if write_commit_row {
            self.driver.execute(
                sql::write_commit(),
                [
                    text_value(self.identity_key.clone()),
                    Value::from_i64(commit_seq),
                    text_value(
                        match options.source {
                            CommitSource::Remote => "remote",
                            CommitSource::Device => "device",
                            CommitSource::Local => "local",
                        }
                        .to_owned(),
                    ),
                    options
                        .mutation_id()
                        .map_or(Value::Null, |value| text_value(value.to_owned())),
                    text_value(changed_tables.join("\n")),
                ],
            )?;
        }
        if let Some(mutation_id) = options.mutation_id() {
            if commit_existing_mutation {
                self.driver.execute(
                    sql::commit_mutation(),
                    [
                        text_value(MutationStatus::Committed.as_str().to_owned()),
                        options
                            .mutation_result()
                            .map_or(Value::Null, |value| text_value(value.to_owned())),
                        Value::from_i64(commit_seq),
                        text_value(self.identity_key.clone()),
                        text_value(mutation_id.to_owned()),
                        text_value(MutationStatus::Accepted.as_str().to_owned()),
                    ],
                )?;
                if self.driver.changes() == 0 {
                    return Err(StorageError::Unsatisfiable(format!(
                        "mutation id {mutation_id} was not accepted when committed"
                    )));
                }
            } else {
                let (name, args) = terminal_mutation_call.take().ok_or_else(|| {
                    StorageError::Unsatisfiable(format!(
                        "mutation id {mutation_id} was committed before mutation_write"
                    ))
                })?;
                self.driver.execute(
                    sql::write_committed_mutation_ok(),
                    [
                        text_value(self.identity_key.clone()),
                        text_value(mutation_id.to_owned()),
                        text_value(name),
                        text_value(args),
                        text_value(MutationStatus::Committed.as_str().to_owned()),
                        options
                            .mutation_result()
                            .map_or(Value::Null, |value| text_value(value.to_owned())),
                        Value::from_i64(commit_seq),
                    ],
                )?;
            }
        }
        Ok(CommitResult {
            commit_seq,
            changed_tables,
            changes,
            crdt_ops: Vec::new(),
        })
    }

    fn commit_has_unlocked(&self, commit_seq: i64) -> Result<bool, StorageError> {
        let found = self.driver.run_row(
            sql::commit_has(),
            vec![
                text_value(self.identity_key.clone()),
                Value::from_i64(commit_seq),
            ],
            |_| Ok(()),
        )?;
        if found.is_some() {
            return Ok(true);
        }
        let dirty = self.driver.run_row(
            sql::dirty_head_commit_has(),
            vec![
                text_value(self.identity_key.clone()),
                Value::from_i64(commit_seq),
            ],
            |_| Ok(()),
        )?;
        if dirty.is_some() {
            return Ok(true);
        }
        let mutation = self.driver.run_row(
            sql::mutation_commit_has(),
            vec![
                text_value(self.identity_key.clone()),
                Value::from_i64(commit_seq),
            ],
            |_| Ok(()),
        )?;
        Ok(mutation.is_some())
    }

    fn mutation_record_unlocked(
        &self,
        mutation_id: &str,
    ) -> Result<Option<MutationRecord>, StorageError> {
        self.driver.run_row(
            sql::read_mutation(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(mutation_id.to_owned()),
            ],
            row_to_mutation_record,
        )
    }

    fn mutation_call_unlocked(
        &self,
        mutation_id: &str,
    ) -> Result<Option<MutationCall>, StorageError> {
        self.driver.run_row(
            sql::read_mutation_call(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(mutation_id.to_owned()),
            ],
            |row| {
                Ok(MutationCall {
                    mutation_id: mutation_id.to_owned(),
                    name: text_at(row, 0)?,
                    args: text_at(row, 1)?,
                })
            },
        )
    }

    fn remember_absent_mutation(&self, call: &MutationCall) -> Result<(), StorageError> {
        let mut absent = lock(&self.absent_mutations);
        if let Some(existing) = absent.get(&call.mutation_id) {
            if existing.name != call.name || existing.args != call.args {
                return Err(StorageError::Unsatisfiable(format!(
                    "mutation id {} was reused with a different call",
                    call.mutation_id
                )));
            }
            return Ok(());
        }
        absent.insert(call.mutation_id.clone(), call.clone());
        Ok(())
    }

    fn clear_absent_mutation(&self, mutation_id: &str) {
        lock(&self.absent_mutations).remove(mutation_id);
    }

    fn take_absent_mutation_call(
        &self,
        mutation_id: &str,
        options: &CommitOptions,
    ) -> Option<(String, String)> {
        let mut absent = lock(&self.absent_mutations);
        let absent_call = absent.get(mutation_id)?;
        let terminal_call = options.terminal_call()?;
        if absent_call.name != terminal_call.name || absent_call.args != terminal_call.args {
            return None;
        }
        let call = absent.remove(mutation_id)?;
        Some((call.name, call.args))
    }

    fn take_absent_mutation_call_for_fail(&self, mutation_id: &str) -> Option<(String, String)> {
        let mut absent = lock(&self.absent_mutations);
        let call = absent.remove(mutation_id)?;
        Some((call.name, call.args))
    }

    fn ensure_mutation_call_matches_unlocked(
        &self,
        call: &MutationCall,
    ) -> Result<(), StorageError> {
        let existing = self.driver.run_row(
            sql::read_mutation_call(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(call.mutation_id.clone()),
            ],
            |row| Ok((text_at(row, 0)?, text_at(row, 1)?)),
        )?;
        let Some((existing_name, existing_args)) = existing else {
            return Err(StorageError::Decode {
                expected: "mutation call",
                index: 0,
                got: "missing row".to_owned(),
            });
        };
        if existing_name == call.name && existing_args == call.args {
            return Ok(());
        }
        Err(StorageError::Unsatisfiable(format!(
            "mutation id {} was reused with a different call",
            call.mutation_id
        )))
    }

    fn def(&self, table: &str) -> Result<Arc<TableDef>, StorageError> {
        self.runtime(table).map(|table| table.def.clone())
    }

    fn replicated_def(&self, table: &str) -> Result<Arc<TableDef>, StorageError> {
        let definition = self.def(table)?;
        if definition.placement != TablePlacement::Replicated {
            return Err(StorageError::Unsatisfiable(format!(
                "remote operation targets device table {table}"
            )));
        }
        Ok(definition)
    }

    fn validate_id_mapping_table(&self, table: &str) -> Result<(), StorageError> {
        if matches!(table, "_storage" | "_scheduled_functions") {
            return Ok(());
        }
        self.replicated_def(table).map(|_| ())
    }

    fn runtime(&self, table: &str) -> Result<Arc<TableRuntime>, StorageError> {
        lock(&self.tables)
            .get(table)
            .cloned()
            .ok_or_else(|| StorageError::InvalidIdent(table.to_owned()))
    }

    fn plan(
        &self,
        key: String,
        build: impl FnOnce() -> Result<ReadPlan, StorageError>,
    ) -> Result<Arc<ReadPlan>, StorageError> {
        if let Some(plan) = lock(&self.plans).get(&key) {
            return Ok(plan.clone());
        }
        let plan = Arc::new(build()?);
        lock(&self.plans).insert(key, plan.clone());
        Ok(plan)
    }
}

fn remote_pull_crdt_state(
    current: Option<crate::crdt::CrdtFieldState>,
    change: &crate::types::RemoteCrdtChange,
) -> Result<(crate::crdt::CrdtFieldState, bool), StorageError> {
    if let Some(state) = current.as_ref() {
        let newer = state.server_epoch > change.epoch
            || (state.server_epoch == change.epoch && state.server_seq > change.head_seq);
        if newer {
            return Ok((current.expect("a stale CRDT pull has current state"), false));
        }
        let duplicate = state.server_epoch == change.epoch
            && state.server_seq == change.head_seq
            && state.accepted.is_some();
        if duplicate {
            if state.server_projection_hash != change.projection_hash {
                return Err(StorageError::Unsatisfiable(
                    "duplicate CRDT pull head has a different projection hash".to_owned(),
                ));
            }
            return Ok((
                current.expect("a duplicate CRDT pull has current state"),
                false,
            ));
        }
    }

    let state = match &change.checkpoint {
        Some(checkpoint) => crate::crdt::crdt_field_accept(
            current.as_ref(),
            change.kind,
            checkpoint,
            &change.updates,
            change.epoch,
            change.head_seq,
            change.projection_hash.clone(),
        )?,
        None => crate::crdt::crdt_field_accept_incremental(
            current.as_ref().ok_or_else(|| {
                StorageError::Unsatisfiable(
                    "incremental CRDT pull requires an accepted local base".to_owned(),
                )
            })?,
            change.kind,
            &change.updates[0],
            change.epoch,
            change.head_seq,
            change.projection_hash.clone(),
        )?,
    };
    Ok((state, true))
}

fn validate_table_commit_source(
    table: &TableDef,
    options: &CommitOptions,
) -> Result<(), StorageError> {
    let valid = match table.placement {
        TablePlacement::Replicated => !options.is_device(),
        TablePlacement::Device => options.is_device(),
    };
    if valid {
        Ok(())
    } else {
        Err(StorageError::Unsatisfiable(format!(
            "{:?} commit cannot write {:?} table {}",
            options.source, table.placement, table.name
        )))
    }
}

fn require_doc_base_columns(table: &str, columns: &FxHashSet<String>) -> Result<(), StorageError> {
    for expected in ["id", "identity_key", "creation_time_ms", "data"] {
        if !columns.contains(expected) {
            return Err(StorageError::IncompatibleStore(format!(
                "the physical table for {table} is missing column {expected}; the store was preserved"
            )));
        }
    }
    Ok(())
}

fn expected_doc_indexes(table: &TableDef) -> FxHashMap<String, Vec<String>> {
    let mut indexes = FxHashMap::default();
    indexes.insert(
        "by_id".to_owned(),
        vec!["identity_key".to_owned(), "id".to_owned()],
    );
    for index in &table.indexes {
        let columns = index.columns.as_ref().unwrap_or(&index.fields);
        if is_built_in_index(&index.name, columns) {
            continue;
        }
        let mut physical = vec!["identity_key".to_owned()];
        physical.extend(physical_index_columns(columns));
        indexes.insert(index.name.to_ascii_lowercase(), physical);
    }
    indexes
}

fn validate_replicated_doc_data(table: &TableDef, data: &str) -> Result<(), StorageError> {
    if table.placement != TablePlacement::Replicated || table.local_fields.is_empty() {
        return Ok(());
    }
    let data = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(data).map_err(
        |error| StorageError::Decode {
            expected: "replicated document JSON object",
            index: 0,
            got: error.to_string(),
        },
    )?;
    if let Some(field) = table
        .local_fields
        .iter()
        .find(|field| data.contains_key(&field.field))
    {
        return Err(StorageError::Unsatisfiable(format!(
            "replicated document write contains device-only field {}.{}",
            table.name, field.field
        )));
    }
    Ok(())
}

fn validate_store_schema(schema: &StoreSchema) -> Result<(), StorageError> {
    if schema.hash.len() != 64 || !schema.hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StorageError::Unsatisfiable(
            "store schema hash must be a 64-character hexadecimal SHA-256 digest".to_owned(),
        ));
    }
    let mut tables = FxHashSet::default();
    for table in &schema.tables {
        validate_ident(&table.name)?;
        if !tables.insert(table.name.as_str()) {
            return Err(StorageError::Unsatisfiable(format!(
                "duplicate table definition {}",
                table.name
            )));
        }
        let mut columns = FxHashSet::default();
        for column in &table.columns {
            validate_ident(&column.name)?;
            if sql::RESERVED.contains(&column.name.as_str()) {
                return Err(StorageError::ReservedColumn(column.name.clone()));
            }
            if !columns.insert(column.name.as_str()) {
                return Err(StorageError::Unsatisfiable(format!(
                    "duplicate column definition {}.{}",
                    table.name, column.name
                )));
            }
        }
        let mut crdt_fields = FxHashSet::default();
        for field in &table.crdt_fields {
            if field.field.is_empty() || !crdt_fields.insert(field.field.as_str()) {
                return Err(StorageError::Unsatisfiable(format!(
                    "invalid or duplicate CRDT field definition {}.{}",
                    table.name, field.field
                )));
            }
        }
        let mut local_fields = FxHashSet::default();
        for field in &table.local_fields {
            if table.placement != TablePlacement::Replicated
                || field.field.is_empty()
                || !local_fields.insert(field.field.as_str())
                || crdt_fields.contains(field.field.as_str())
            {
                return Err(StorageError::Unsatisfiable(format!(
                    "invalid, duplicate, or conflicting device field definition {}.{}",
                    table.name, field.field
                )));
            }
        }
        if table.placement == TablePlacement::Device
            && (!table.crdt_fields.is_empty() || !table.local_fields.is_empty())
        {
            return Err(StorageError::Unsatisfiable(format!(
                "device table {} cannot declare replicated CRDT or overlay fields",
                table.name
            )));
        }
        let mut indexes = FxHashSet::default();
        for index in &table.indexes {
            validate_ident(&index.name)?;
            if !indexes.insert(index.name.as_str()) {
                return Err(StorageError::Unsatisfiable(format!(
                    "duplicate index definition {}.{}",
                    table.name, index.name
                )));
            }
            let index_columns = index.columns.as_ref().unwrap_or(&index.fields);
            if index_columns.is_empty() {
                return Err(StorageError::Unsatisfiable(format!(
                    "index {}.{} has no columns",
                    table.name, index.name
                )));
            }
            if index.name == "by_id" && !is_built_in_index(&index.name, index_columns) {
                return Err(StorageError::Unsatisfiable(format!(
                    "index {}.by_id must target only id",
                    table.name
                )));
            }
            for column in index_columns {
                validate_ident(column)?;
                if !matches!(column.as_str(), "id" | "creation_time_ms")
                    && !columns.contains(column.as_str())
                {
                    return Err(StorageError::Unsatisfiable(format!(
                        "index {}.{} references unknown column {column}",
                        table.name, index.name
                    )));
                }
            }
        }
    }
    Ok(())
}

fn origin_payload_references(
    kind: i64,
    codec: i64,
    flags: i64,
    payload: &[u8],
) -> Result<Vec<Vec<u8>>, StorageError> {
    if flags == ORIGIN_FLAG_DISCARDED {
        return Ok(Vec::new());
    }
    let (codec, payload) = if flags == ORIGIN_FLAG_QUARANTINED {
        let disposition: serde_json::Value =
            serde_json::from_slice(payload).map_err(|error| json_decode(&error.to_string()))?;
        (
            json_i64(&disposition, "priorCodec")?,
            decode_base64_field(&disposition, "priorPayload")?,
        )
    } else if flags == ORIGIN_FLAGS_NONE {
        (codec, payload.to_vec())
    } else {
        return Err(StorageError::IncompatibleStore(format!(
            "unknown originated record flags {flags}; payload cleanup was skipped"
        )));
    };
    if codec != ORIGIN_CODEC_V1 {
        return Err(StorageError::IncompatibleStore(format!(
            "unsupported originated codec {codec}; payload cleanup was skipped"
        )));
    }
    let kind = OriginKind::try_from(kind).map_err(|unknown| {
        StorageError::IncompatibleStore(format!(
            "unknown originated record kind {unknown}; payload cleanup was skipped"
        ))
    })?;
    let value: serde_json::Value =
        serde_json::from_slice(&payload).map_err(|error| json_decode(&error.to_string()))?;
    let mut references = match kind {
        OriginKind::Blob => vec![decode_base64_field(&value, "bytesHash")?],
        OriginKind::Revision => {
            let mut hashes = vec![decode_base64_field(&value, "snapshotHash")?];
            for hash in json_array(&value, "logHashes")? {
                let hash = hash
                    .as_str()
                    .ok_or_else(|| json_decode("revision log payload hash"))?;
                hashes.push(
                    base64::decode(hash).map_err(|error| json_decode(&error.to_string()))?,
                );
            }
            hashes
        }
        OriginKind::CrdtEffect => vec![decode_base64_field(&value, "stateHash")?],
        OriginKind::Identity
        | OriginKind::DeviceDocument
        | OriginKind::LocalField
        | OriginKind::Mutation
        | OriginKind::PushEnvelope
        | OriginKind::SettlementReceipt
        | OriginKind::Schedule
        | OriginKind::Upload
        | OriginKind::IdMapping => Vec::new(),
    };
    if references.iter().any(|hash| hash.len() != 32) {
        return Err(StorageError::IncompatibleStore(
            "originated payload reference is not a SHA-256 digest; payload cleanup was skipped"
                .to_owned(),
        ));
    }
    references.sort();
    references.dedup();
    Ok(references)
}

fn origin_hash(
    identity_key: &str,
    kind: i64,
    record_key: &[u8],
    codec: i64,
    flags: i64,
    payload: &[u8],
) -> Vec<u8> {
    let mut hash = Sha256::new();
    for bytes in [
        identity_key.as_bytes(),
        &kind.to_be_bytes(),
        record_key,
        &codec.to_be_bytes(),
        &flags.to_be_bytes(),
        payload,
    ] {
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    }
    hash.finalize().to_vec()
}

fn origin_key(parts: &[&[u8]]) -> Vec<u8> {
    let capacity = parts
        .iter()
        .map(|part| std::mem::size_of::<u64>() + part.len())
        .sum();
    let mut key = Vec::with_capacity(capacity);
    for part in parts {
        key.extend_from_slice(&(part.len() as u64).to_be_bytes());
        key.extend_from_slice(part);
    }
    key
}

fn json_decode(got: &str) -> StorageError {
    StorageError::Decode {
        expected: "originated record field",
        index: 0,
        got: got.to_owned(),
    }
}

fn json_value<'a>(
    value: &'a serde_json::Value,
    field: &str,
) -> Result<&'a serde_json::Value, StorageError> {
    value.get(field).ok_or_else(|| json_decode(field))
}

fn json_str<'a>(value: &'a serde_json::Value, field: &str) -> Result<&'a str, StorageError> {
    json_value(value, field)?
        .as_str()
        .ok_or_else(|| json_decode(field))
}

fn json_optional_str<'a>(
    value: &'a serde_json::Value,
    field: &str,
) -> Result<Option<&'a str>, StorageError> {
    match value.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => value.as_str().map(Some).ok_or_else(|| json_decode(field)),
    }
}

fn json_i64(value: &serde_json::Value, field: &str) -> Result<i64, StorageError> {
    json_value(value, field)?
        .as_i64()
        .ok_or_else(|| json_decode(field))
}

fn json_optional_i64(value: &serde_json::Value, field: &str) -> Result<Option<i64>, StorageError> {
    match value.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(value) => value.as_i64().map(Some).ok_or_else(|| json_decode(field)),
    }
}

fn json_f64(value: &serde_json::Value, field: &str) -> Result<f64, StorageError> {
    json_value(value, field)?
        .as_f64()
        .ok_or_else(|| json_decode(field))
}

fn json_array<'a>(
    value: &'a serde_json::Value,
    field: &str,
) -> Result<&'a Vec<serde_json::Value>, StorageError> {
    json_value(value, field)?
        .as_array()
        .ok_or_else(|| json_decode(field))
}

fn decode_base64_field(value: &serde_json::Value, field: &str) -> Result<Vec<u8>, StorageError> {
    base64::decode(json_str(value, field)?).map_err(|error| json_decode(&error.to_string()))
}

fn json_optional_origin_cursor(
    value: &serde_json::Value,
    field: &str,
) -> Result<Option<OriginCursor>, StorageError> {
    match value.get(field) {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(cursor) => Ok(Some(OriginCursor {
            identity_key: json_str(cursor, "identityKey")?.to_owned(),
            kind: json_i64(cursor, "kind")?,
            record_key: decode_base64_field(cursor, "recordKey")?,
        })),
    }
}

fn origin_cursor_json(cursor: &OriginCursor) -> serde_json::Value {
    serde_json::json!({
        "identityKey": cursor.identity_key,
        "kind": cursor.kind,
        "recordKey": base64::encode(&cursor.record_key),
    })
}

mod helpers;

#[cfg(any(debug_assertions, test, feature = "testkit"))]
use helpers::row_to_rev_frontier;
use helpers::{
    append_doc, append_f64, append_json_string, blob_at, changed_tables, cols_are_in_table_order,
    combine_rollback, commit_seq_key, create_peer_id, doc_write_row, hex, int_at,
    is_built_in_index, is_data_only_id, is_fresh_id, is_local_document_id_for_table,
    is_valid_ident, key_positions, lock, lock_key, materialized_row, max_commit_seq_params,
    optional_int_at, optional_text_at, order_col_value_at, path_lock, peer_id_from_bytes,
    physical_index_columns, projection_logical_clock, real_at, record_order, remote_doc_encode,
    remote_doc_id_encode, require_terminal_mutation_call, rev_lifecycle_at, row_changes,
    row_to_dirty_head, row_to_file_metadata, row_to_id_mapping, row_to_mutation_record,
    row_to_pending_upload, row_to_rev_state, row_to_scheduled_job, schedule_lease_params,
    schema_signature, text_at, text_ref_at, text_value, validate_ident, RecordOrder,
};

#[cfg(not(target_arch = "wasm32"))]
fn owner_lease(path: &str, path_key: &str) -> Result<Option<Arc<OwnerLease>>, StorageError> {
    if path == ":memory:" || path.starts_with("file::memory:") {
        return Ok(None);
    }
    let mut owners = lock(&PATH_OWNERS);
    if owners.get(path_key).and_then(Weak::upgrade).is_some() {
        return Err(StorageError::Owner(std::io::Error::new(
            std::io::ErrorKind::WouldBlock,
            "this process already owns the physical store",
        )));
    }
    let owner_extension = Path::new(path_key).extension().map_or_else(
        || "owner".to_owned(),
        |extension| format!("{}.owner", extension.to_string_lossy()),
    );
    let owner_path = Path::new(path_key).with_extension(owner_extension);
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(owner_path)?;
    file.try_lock()
        .map_err(|error| StorageError::Owner(error.into()))?;
    let lease = Arc::new(OwnerLease { _file: file });
    owners.insert(path_key.to_owned(), Arc::downgrade(&lease));
    Ok(Some(lease))
}

fn bootstrap_i64_read(driver: &TursoDriver, key: &str) -> Result<Option<i64>, StorageError> {
    driver.run_row(
        sql::READ_BOOTSTRAP,
        vec![text_value(key.to_owned())],
        |row| {
            let bytes = blob_at(row, 0)?;
            let text = std::str::from_utf8(&bytes).map_err(|error| {
                StorageError::IncompatibleStore(format!(
                    "bootstrap value {key} is not UTF-8: {error}"
                ))
            })?;
            text.parse::<i64>().map_err(|error| {
                StorageError::IncompatibleStore(format!(
                    "bootstrap value {key} is not an integer: {error}"
                ))
            })
        },
    )
}

fn legacy_origin_seed(
    identity_key: String,
    kind: OriginKind,
    record_key: Vec<u8>,
    payload: Vec<u8>,
) -> LegacyOriginSeed {
    LegacyOriginSeed {
        identity_key,
        kind,
        record_key,
        payload,
    }
}

#[allow(clippy::needless_pass_by_value)]
fn legacy_json_seed(
    identity_key: String,
    kind: OriginKind,
    record_key: Vec<u8>,
    value: serde_json::Value,
) -> Result<LegacyOriginSeed, StorageError> {
    let payload = serde_json::to_vec(&value)
        .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
    Ok(legacy_origin_seed(identity_key, kind, record_key, payload))
}
