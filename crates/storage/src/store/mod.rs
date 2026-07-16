use std::ops::ControlFlow;
use std::sync::{Arc, LazyLock, Mutex, Weak};

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
    DocWrite, FileMetadata, FileStore, IdMapping, IdMappingContent, MembershipRange, MutationCall,
    MutationRecord, MutationStatus, Page, PendingUpload, ReadSpec, RemoteMember, RemotePageWrite,
    RemotePageWriteResult, RemotePending, RemoteSettlementOutcome, RemoteSettlementWrite,
    RemoteSettlementWriteResult, ResultEntry, RevKey, RevState, RevWriteResult, RowChange,
    RowChangeOp, RowHead, RowKey, ScheduledJob, ScheduledState, StoreSchema, TableDef, UploadLease,
    UploadLeaseWrite, WriteBatch,
};

static PATH_LOCKS: LazyLock<Mutex<FxHashMap<String, Weak<Mutex<()>>>>> =
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
        let driver = {
            let _guard = lock(&operation_lock);
            TursoDriver::open(path)?
        };
        Ok(Self {
            driver,
            identity_key: MutableKey::new(identity_key.to_owned()),
            selector_key: identity_key.to_owned(),
            commit_seq_key: MutableKey::new(commit_seq_key(&path_key, identity_key)),
            path_key,
            operation_lock,
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
        let mut store = Self::open_with_identity_key(path, default_identity_key)?;
        selector_key.clone_into(&mut store.selector_key);
        if store
            .read_tables()?
            .iter()
            .any(|table| table == sql::META_TABLE)
        {
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
        self.write_meta_for_identity_unlocked(&self.selector_key, IDENTITY_STATE_META, &state)?;
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
        validate_store_schema(schema)?;
        let current_signature = schema_signature(schema);
        let schema_manifest = serde_json::to_string(schema)
            .map_err(|error| StorageError::Unsatisfiable(error.to_string()))?;
        let _guard = lock(&self.operation_lock);
        let stored_version = self.read_user_version()?;
        let existing_tables = self.read_tables()?;
        if existing_tables.is_empty() || stored_version != sql::STORAGE_FORMAT_VERSION {
            self.replace_store_unlocked(
                schema,
                &current_signature,
                &schema_manifest,
                stored_version,
                &existing_tables,
            )?;
            return self.activate_schema_unlocked(schema);
        }
        let stored_signature = self
            .stored_schema_signature_unlocked(stored_version, &existing_tables)?
            .ok_or_else(|| {
                StorageError::IncompatibleStore(
                    "the current-format store has no schema signature; the existing store was preserved"
                        .to_owned(),
                )
            })?;
        let stored_schema = self.stored_schema_manifest_unlocked()?;
        if stored_signature == current_signature {
            let previous = match stored_schema {
                Some(stored) if schema_signature(&stored) != stored_signature => {
                    return Err(StorageError::IncompatibleStore(
                        "the stored schema manifest does not match its signature; the existing store was preserved"
                            .to_owned(),
                    ));
                }
                Some(stored) => stored,
                None => {
                    self.write_meta_unlocked(SCHEMA_MANIFEST_KEY, &schema_manifest)?;
                    schema.clone()
                }
            };
            if !self.doc_tables_match_schema(schema)? {
                self.reconcile_schema_unlocked(
                    &previous,
                    schema,
                    &current_signature,
                    &schema_manifest,
                    &existing_tables,
                )?;
            }
        } else {
            let stored_schema = stored_schema.ok_or_else(|| {
                StorageError::IncompatibleStore(
                    "schema reconciliation requires the prior schema manifest; the existing store was preserved"
                        .to_owned(),
                )
            })?;
            if schema_signature(&stored_schema) != stored_signature {
                return Err(StorageError::IncompatibleStore(
                    "the stored schema manifest does not match its signature; the existing store was preserved"
                        .to_owned(),
                ));
            }
            self.reconcile_schema_unlocked(
                &stored_schema,
                schema,
                &current_signature,
                &schema_manifest,
                &existing_tables,
            )?;
        }
        self.activate_schema_unlocked(schema)
    }

    fn stored_schema_signature_unlocked(
        &self,
        stored_version: i64,
        existing_tables: &[String],
    ) -> Result<Option<String>, StorageError> {
        let has_meta = existing_tables.iter().any(|name| name == sql::META_TABLE);
        if stored_version == sql::STORAGE_FORMAT_VERSION && has_meta {
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
        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written = (|| {
            for table in existing_tables {
                self.driver.execute(&sql::drop_table(table), Vec::new())?;
            }
            self.create_system_schema_unlocked()?;
            self.create_doc_schema_unlocked(schema)?;
            self.write_meta_unlocked(SCHEMA_SIGNATURE_KEY, schema_signature)?;
            self.write_meta_unlocked(SCHEMA_MANIFEST_KEY, schema_manifest)?;
            if stored_version != sql::STORAGE_FORMAT_VERSION {
                self.driver
                    .execute(&sql::write_user_version(), Vec::new())?;
            }
            Ok(())
        })();
        match written {
            Ok(()) => self.commit_transaction_unlocked()?,
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                return Err(combine_rollback(error, rolled));
            }
        }
        *lock(&self.peer_id) = None;
        self.reset_commit_seq_cache(0);
        self.driver.clear_statements();
        Ok(())
    }

    fn write_doc_column_values_unlocked(
        &self,
        table: &TableDef,
        columns: &FxHashSet<String>,
    ) -> Result<(), StorageError> {
        if columns.is_empty() {
            return Ok(());
        }
        let mut rows = Vec::new();
        self.driver
            .run_rows(&sql::read_doc_rows(&table.name)?, Vec::new(), |row| {
                rows.push((text_at(row, 0)?, text_at(row, 1)?, text_at(row, 2)?));
                Ok(())
            })?;
        for (identity_key, id, data) in rows {
            let data = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&data)
                .map_err(|error| StorageError::Decode {
                    expected: "stored document object",
                    index: 2,
                    got: error.to_string(),
                })?;
            for (column, value) in crate::crdt::extract_cols(table, &data)? {
                if columns.contains(&column) {
                    self.driver.execute(
                        &sql::write_doc_column_value(&table.name, &column)?,
                        vec![
                            Value::Blob(value.encode_key()),
                            text_value(identity_key.clone()),
                            text_value(id.clone()),
                        ],
                    )?;
                }
            }
        }
        Ok(())
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

    fn create_system_schema_unlocked(&self) -> Result<(), StorageError> {
        for statement in [
            sql::create_commits(),
            sql::create_meta(),
            sql::create_mutations(),
            sql::create_commits_mutation_index(),
            sql::create_blobs(),
            sql::create_revs(),
            sql::create_rev_log(),
            sql::create_dirty_heads(),
            sql::create_dirty_heads_seq_index(),
            sql::create_crdt_ops(),
            sql::create_crdt_field(),
            sql::create_projections(),
            sql::create_projections_server_index(),
            sql::create_memberships(),
            sql::create_memberships_row_index(),
            sql::create_results(),
            sql::create_peers(),
            sql::create_files(),
            sql::create_id_mappings(),
            sql::create_id_mappings_convex_index(),
            sql::create_id_mappings_deleted_index(),
            sql::create_uploads(),
            sql::create_remote(),
            sql::create_schedules(),
        ] {
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

    fn reconcile_schema_unlocked(
        &self,
        previous: &StoreSchema,
        current: &StoreSchema,
        signature: &str,
        manifest: &str,
        existing_tables: &[String],
    ) -> Result<(), StorageError> {
        validate_schema_transition(previous, current)?;
        let physical = existing_tables
            .iter()
            .map(String::as_str)
            .collect::<FxHashSet<_>>();

        self.driver.execute(sql::BEGIN_TRANSACTION, Vec::new())?;
        let written = (|| {
            for previous_table in &previous.tables {
                if !current
                    .tables
                    .iter()
                    .any(|table| table.name == previous_table.name)
                {
                    self.delete_doc_indexes_unlocked(previous_table, None)?;
                }
            }
            for table in &current.tables {
                let table_name = sql::doc_table_name(&table.name)?;
                let previous_table = previous
                    .tables
                    .iter()
                    .find(|candidate| candidate.name == table.name);
                if physical.contains(table_name.as_str()) {
                    let previous_table = previous_table.ok_or_else(|| {
                        StorageError::IncompatibleStore(format!(
                            "table {} would reattach preserved data without its prior schema",
                            table.name
                        ))
                    })?;
                    let columns = self.read_doc_columns_unlocked(&table.name)?;
                    require_doc_base_columns(&table.name, &columns)?;
                    self.delete_doc_indexes_unlocked(previous_table, Some(table))?;
                    let current_columns = table
                        .columns
                        .iter()
                        .map(|column| column.name.as_str())
                        .collect::<FxHashSet<_>>();
                    for column in columns.iter().filter(|column| {
                        !matches!(
                            column.as_str(),
                            "id" | "identity_key" | "creation_time_ms" | "data"
                        ) && !current_columns.contains(column.as_str())
                    }) {
                        self.driver
                            .execute(&sql::delete_doc_column(&table.name, column)?, Vec::new())?;
                    }
                    let added = table
                        .columns
                        .iter()
                        .filter(|column| !columns.contains(column.name.as_str()))
                        .map(|column| column.name.clone())
                        .collect::<FxHashSet<_>>();
                    for column in &added {
                        if !columns.contains(column.as_str()) {
                            self.driver.execute(
                                &sql::write_doc_column(&table.name, column)?,
                                Vec::new(),
                            )?;
                        }
                    }
                    self.write_doc_column_values_unlocked(table, &added)?;
                    self.write_doc_indexes_unlocked(table)?;
                } else {
                    self.create_doc_table_unlocked(table)?;
                }
            }
            self.write_meta_unlocked(SCHEMA_SIGNATURE_KEY, signature)?;
            self.write_meta_unlocked(SCHEMA_MANIFEST_KEY, manifest)?;
            Ok(())
        })();
        match written {
            Ok(()) => self.commit_transaction_unlocked()?,
            Err(error) => {
                let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                return Err(combine_rollback(error, rolled));
            }
        }
        self.driver.clear_statements();
        Ok(())
    }

    fn delete_doc_indexes_unlocked(
        &self,
        previous: &TableDef,
        current: Option<&TableDef>,
    ) -> Result<(), StorageError> {
        let mut names = FxHashSet::default();
        names.insert("by_id");
        names.extend(previous.indexes.iter().map(|index| index.name.as_str()));
        if let Some(current) = current {
            names.extend(current.indexes.iter().map(|index| index.name.as_str()));
        }
        for name in names {
            self.driver
                .execute(&sql::delete_doc_index(&previous.name, name)?, Vec::new())?;
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
        Ok(MutationRecord {
            commit_seq: None,
            error: None,
            mutation_id: call.mutation_id.clone(),
            result: None,
            status: MutationStatus::Accepted,
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
            return self.driver.execute(
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
            );
        }
        self.clear_absent_mutation(mutation_id);
        self.driver.execute(
            sql::fail_mutation(),
            vec![
                text_value(MutationStatus::Failed.as_str().to_owned()),
                text_value(error.to_owned()),
                text_value(self.identity_key.clone()),
                text_value(mutation_id.to_owned()),
                text_value(MutationStatus::Committed.as_str().to_owned()),
            ],
        )
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

    fn doc_tables_match_schema(&self, schema: &StoreSchema) -> Result<bool, StorageError> {
        for table in &schema.tables {
            let columns = self.read_doc_columns_unlocked(&table.name)?;
            if require_doc_base_columns(&table.name, &columns).is_err() {
                return Ok(false);
            }
            let mut expected = ["id", "identity_key", "creation_time_ms", "data"]
                .into_iter()
                .collect::<FxHashSet<_>>();
            expected.extend(table.columns.iter().map(|column| column.name.as_str()));
            if columns.iter().map(String::as_str).collect::<FxHashSet<_>>() != expected {
                return Ok(false);
            }
            if self.read_doc_indexes_unlocked(table)? != expected_doc_indexes(table) {
                return Ok(false);
            }
        }
        Ok(true)
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
        let prefix = format!("ix__{}__", table.name).to_ascii_lowercase();
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
        Ok(Page {
            text,
            cursor,
            versions,
        })
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
        }
        for job in &batch.schedules {
            self.schedule_write_unlocked(job)?;
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
        self.write_push_envelope_unlocked(options, &result)?;
        #[cfg(debug_assertions)]
        self.debug_assert_rev_invariants();
        Ok(result)
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
                text_value(envelope_json),
                Value::from_i64(now_ms),
            ],
        )
    }

    fn doc_write_unlocked(
        &self,
        doc_write: &DocWrite,
        table: &TableRuntime,
        data_only: bool,
    ) -> Result<(), StorageError> {
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
        self.driver.execute(
            sql::write_remote_cursor(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(format!("{REMOTE_RECEIPT_PREFIX}{op_id}")),
                Value::from_i64(commit_seq),
                text_value(op_id.to_owned()),
                Value::from_i64(0),
            ],
        )?;
        self.driver.execute(
            sql::delete_remote_cursor(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(push_watermark),
            ],
        )?;
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
        for mutation_id in mutation_ids {
            self.driver.execute(
                sql::delete_remote_cursor(),
                vec![
                    text_value(self.identity_key.clone()),
                    text_value(format!("{REMOTE_RECEIPT_PREFIX}{mutation_id}")),
                ],
            )?;
        }
        Ok(())
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

    /// Write (doc_write) one retained authored-result entry, returning `true` iff a durable write
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

    #[cfg(any(test, feature = "testkit"))]
    pub fn peer_read(&self) -> Result<Option<Vec<u8>>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.run_row(
            sql::read_peer(),
            vec![text_value(self.identity_key.clone())],
            |row| blob_at(row, 0),
        )
    }

    pub fn rev_write(&self, state: &RevState) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.rev_write_unlocked(state, state.updated_time)
    }

    pub fn rev_state_read(&self, key: &RevKey) -> Result<Option<RevState>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.materialize_dirty_heads_unlocked()?;
        self.read_rev_unlocked(key)
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
    /// before this commit's own doc_write materialized the edit into the row (§8-A). A field that
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

    #[cfg(any(test, feature = "testkit"))]
    pub fn remote_doc_write(&self, state: &RowHead) -> Result<(), StorageError> {
        validate_ident(&state.table)?;
        let _guard = lock(&self.operation_lock);
        self.remote_doc_write_unlocked(state)
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

    fn membership_snapshot_write_unlocked(
        &self,
        subscription: &str,
        members: &[RemoteMember],
        retained: &FxHashSet<RemoteMember>,
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

        if previous == current {
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
        for exited in previous.difference(&current) {
            if retained.contains(exited) || self.membership_row_has_edge_unlocked(exited)? {
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
            self.def(&member.table)?;
            if !members.insert((member.table.clone(), member.server_document_id.clone())) {
                return Err(StorageError::Unsatisfiable(
                    "remote pull membership contains a duplicate row".to_owned(),
                ));
            }
        }

        let mut projections = FxHashSet::default();
        for projection in &pull.projections {
            self.def(&projection.table)?;
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
            self.def(&mapping.table)?;
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
            self.def(&projection.table)?;
        }
        let mut crdt_fields = FxHashSet::default();
        for write in crdt {
            self.def(&write.table)?;
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
            self.def(&target.table)?;
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
            self.def(&projection.table)?;
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

            let retained = result_disclosed_rows(pull.result.as_deref());
            let projection_deleted = self.membership_snapshot_write_unlocked(
                &pull.subscription,
                &pull.members,
                &retained,
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
        let row_json = self
            .doc_read_unlocked(&change.table, &local_id)?
            .ok_or_else(|| {
                StorageError::Unsatisfiable(format!(
                    "remote pull CRDT field {}.{} has no authoritative projection",
                    change.table, change.document_id
                ))
            })?;
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
        let mut projection = self
            .remote_doc_read_unlocked(&change.table, &local_id)?
            .ok_or_else(|| {
                StorageError::Unsatisfiable(
                    "accepted remote CRDT state has no projection metadata".to_owned(),
                )
            })?;
        let base_row = projection.server_row.as_deref().unwrap_or(&row_json);
        projection.server_row = Some(patch_row_field(base_row, &change.field, accepted_value)?);
        self.remote_doc_write_unlocked(&projection)?;
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

    /// True if the row has an un-pushed local edit. Such rows are dirty and must never be projection_deleted.
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

    #[cfg(any(test, feature = "testkit"))]
    pub fn crdt_ops_debug_read(&self) -> Result<usize, StorageError> {
        let _guard = lock(&self.operation_lock);
        let mut count = 0usize;
        self.driver.run_rows(
            sql::read_crdt_ops_debug(),
            vec![text_value(self.identity_key.clone())],
            |_| {
                count += 1;
                Ok(())
            },
        )?;
        Ok(count)
    }

    #[cfg(any(test, feature = "testkit"))]
    pub fn rev_state_debug_read(&self, key: &RevKey) -> Result<Option<RevState>, StorageError> {
        let _guard = lock(&self.operation_lock);
        self.read_rev_unlocked(key)
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

fn result_disclosed_rows(result: Option<&ResultEntry>) -> FxHashSet<RemoteMember> {
    let mut rows = FxHashSet::default();
    let Some(entry) = result else {
        return rows;
    };
    let Ok(serde_json::Value::Array(paths)) = serde_json::from_slice(&entry.paths) else {
        return rows;
    };
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
    rows
}

impl EmbeddedStore {
    pub fn id_write(&self, mapping: &IdMapping) -> Result<(), StorageError> {
        validate_ident(&mapping.table)?;
        let _guard = lock(&self.operation_lock);
        self.id_write_unlocked(mapping)
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
        self.id_read_unlocked(table, local_id)
    }

    pub fn id_local_read(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError> {
        validate_ident(table)?;
        let _guard = lock(&self.operation_lock);
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
        self.driver.execute(
            sql::delete_id_mapping(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(table.to_owned()),
                text_value(local_id.to_owned()),
            ],
        )
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
            self.id_write_unlocked(&deleted)
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
        self.upload_write_unlocked(upload)
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
            self.upload_write_unlocked(&upload)
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
    pub fn upload_lease_write(
        &self,
        args: UploadLeaseWrite,
    ) -> Result<Option<PendingUpload>, StorageError> {
        let _guard = lock(&self.operation_lock);
        match args {
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
                Ok(Some(PendingUpload {
                    lease: UploadLease::Claimed { owner, lease_until },
                    updated_time: now_ms,
                    ..candidate
                }))
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
                        text_value(local_storage_id),
                        text_value(owner),
                    ],
                )?;
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
                Ok(row.map(|row| PendingUpload {
                    lease: UploadLease::Claimed { owner, lease_until },
                    updated_time: now_ms,
                    ..row
                }))
            }
        }
    }

    pub fn upload_delete(&self, local_storage_id: &str) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
        self.driver.execute(
            sql::delete_upload(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(local_storage_id.to_owned()),
            ],
        )
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
        self.schedule_write_unlocked(job)
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
        let mut candidates = Vec::new();
        let _guard = lock(&self.operation_lock);
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
                return Ok(Some(ScheduledJob {
                    state: ScheduledState::Running { lease_until },
                    updated_time: now_ms,
                    ..candidate
                }));
            }
        }
        Ok(None)
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
                self.id_write_unlocked(&IdMapping {
                    table: table.to_owned(),
                    local_id: job_id.clone(),
                    mapping: IdMappingContent::Mapped {
                        convex_id: convex_id.clone(),
                    },
                    created_time: now_ms,
                    updated_time: now_ms,
                })?;
            }
            completed.push(
                self.driver
                    .run_row(
                        sql::read_schedule(),
                        vec![
                            text_value(self.identity_key.clone()),
                            text_value(job_id.clone()),
                        ],
                        row_to_scheduled_job,
                    )?
                    .ok_or_else(|| {
                        StorageError::Unsatisfiable(
                            "completed remote schedule disappeared".to_owned(),
                        )
                    })?,
            );
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
            return Ok(Some(job));
        }
        self.schedule_state_unlocked(
            job_id,
            ScheduledState::PENDING,
            ScheduledState::Failed,
            now_ms,
        )
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
        self.schedule_state_unlocked(job_id, expected, state, now_ms)
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
                    text_value("remote".to_owned()),
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

fn require_doc_base_columns(table: &str, columns: &FxHashSet<String>) -> Result<(), StorageError> {
    for expected in ["id", "identity_key", "creation_time_ms", "data"] {
        if !columns.contains(expected) {
            return Err(StorageError::IncompatibleStore(format!(
                "the physical table for {table} is missing column {expected}"
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

fn validate_schema_transition(
    previous: &StoreSchema,
    current: &StoreSchema,
) -> Result<(), StorageError> {
    for table in &current.tables {
        let Some(previous_table) = previous
            .tables
            .iter()
            .find(|candidate| candidate.name == table.name)
        else {
            continue;
        };
        for column in &table.columns {
            let Some(previous_column) = previous_table
                .columns
                .iter()
                .find(|candidate| candidate.name == column.name)
            else {
                continue;
            };
            let previous_field = previous_column
                .field
                .as_deref()
                .unwrap_or(&previous_column.name);
            let current_field = column.field.as_deref().unwrap_or(&column.name);
            if previous_field != current_field {
                return Err(StorageError::IncompatibleStore(format!(
                    "indexed column {}.{} changed field from {previous_field} to {current_field}",
                    table.name, column.name
                )));
            }
        }
        for field in &table.crdt_fields {
            let Some(previous_field) = previous_table
                .crdt_fields
                .iter()
                .find(|candidate| candidate.field == field.field)
            else {
                continue;
            };
            if previous_field.kind != field.kind {
                return Err(StorageError::IncompatibleStore(format!(
                    "CRDT field {}.{} changed kind in place",
                    table.name, field.field
                )));
            }
        }
    }
    Ok(())
}

fn validate_store_schema(schema: &StoreSchema) -> Result<(), StorageError> {
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

mod helpers;

#[cfg(any(debug_assertions, test, feature = "testkit"))]
use helpers::row_to_rev_frontier;
use helpers::{
    append_doc, append_f64, append_json_string, blob_at, changed_tables, cols_are_in_table_order,
    combine_rollback, commit_seq_key, create_peer_id, doc_write_row, hex, int_at,
    is_built_in_index, is_data_only_id, is_fresh_id, is_local_document_id_for_table,
    is_valid_ident, key_positions, lock, lock_key, materialized_row, max_commit_seq_params,
    optional_text_at, order_col_value_at, path_lock, peer_id_from_bytes, physical_index_columns,
    projection_logical_clock, real_at, record_order, remote_doc_encode, remote_doc_id_encode,
    require_terminal_mutation_call, rev_lifecycle_at, row_changes, row_to_dirty_head,
    row_to_file_metadata, row_to_id_mapping, row_to_mutation_record, row_to_pending_upload,
    row_to_rev_state, row_to_scheduled_job, schedule_lease_params, schema_signature, text_at,
    text_ref_at, text_value, validate_ident, RecordOrder,
};
