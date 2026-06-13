use std::fmt::Write as _;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError, Weak};
#[cfg(not(target_arch = "wasm32"))]
use std::{fs, path::Path};

use rustc_hash::{FxHashMap, FxHashSet};
use turso_core::{types::Text, Numeric, Row, Value};

use crate::clock::{wall_ms, Clock};
use crate::driver::TursoDriver;
use crate::error::StorageError;
use crate::sql::{
    self, compile_count, compile_scan, count_key, count_params, decode_cursor, encode_cursor,
    scan_key, scan_params, scan_shape, Projection, ScanPlan, DEFAULT_SCAN_PAGE, SCAN_CAP,
};
use crate::types::{
    ColValue, CommitOptions, CommitResult, CountSpec, MutationCall, MutationRecord,
    MutationStatus, Page, PruneResult, ScanSpec, StoreSchema, TableDef, WriteBatch,
};

static PATH_LOCKS: LazyLock<Mutex<FxHashMap<String, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(FxHashMap::default()));

pub struct EmbeddedStore {
    driver: TursoDriver,
    identity_key: String,
    operation_lock: Arc<Mutex<()>>,
    tables: Mutex<FxHashMap<String, Arc<TableDef>>>,
    plans: Mutex<FxHashMap<String, Arc<ScanPlan>>>,
    clock: Mutex<Clock>,
}

impl EmbeddedStore {
    pub fn open(path: &str) -> Result<Self, StorageError> {
        Self::open_with_identity_key(path, "")
    }

    pub fn open_with_identity_key(path: &str, identity_key: &str) -> Result<Self, StorageError> {
        let operation_lock = path_lock(path);
        let driver = {
            let _guard = lock(&operation_lock);
            TursoDriver::open(path)?
        };
        Ok(Self {
            driver,
            identity_key: identity_key.to_owned(),
            operation_lock,
            tables: Mutex::new(FxHashMap::default()),
            plans: Mutex::new(FxHashMap::default()),
            clock: Mutex::new(Clock::new()),
        })
    }

    pub fn setup(&self, schema: &StoreSchema) -> Result<(), StorageError> {
        // Validate the whole schema before issuing any DDL, so a bad table can never leave a
        // half-created schema or a partially-updated registry.
        for table in &schema.tables {
            validate_ident(&table.name)?;
            for c in &table.columns {
                validate_ident(&c.name)?;
                if sql::RESERVED.contains(&c.name.as_str()) {
                    return Err(StorageError::ReservedColumn(c.name.clone()));
                }
            }
            for index in &table.indexes {
                validate_ident(&index.name)?;
                for column in index.columns.as_ref().unwrap_or(&index.fields) {
                    validate_ident(column)?;
                }
            }
        }

        let _guard = lock(&self.operation_lock);
        // A database whose on-disk format predates the current code is reset wholesale (pre-1.0: no
        // migration). `CREATE TABLE IF NOT EXISTS` never alters an existing table, so without this a
        // stale column type (e.g. an old INTEGER index column vs the current order-key BLOB) would
        // fail every write. Dropping the tables here recreates them in the current format below.
        let stored_version = self.read_user_version()?;
        if stored_version != sql::STORAGE_FORMAT_VERSION {
            for name in self.list_tables()? {
                self.driver.execute(&sql::drop_table(&name), Vec::new())?;
            }
        }
        self.driver.execute(sql::create_commits(), Vec::new())?;
        self.driver.execute(sql::create_mutations(), Vec::new())?;
        self.driver
            .execute(sql::create_commits_mutation_index(), Vec::new())?;
        self.driver.execute(sql::create_blobs(), Vec::new())?;
        for table in &schema.tables {
            self.driver
                .execute(&sql::create_doc_table(table), Vec::new())?;
            for index in &table.indexes {
                let columns = index.columns.as_ref().unwrap_or(&index.fields);
                if is_built_in_index(&index.name, columns) {
                    continue;
                }
                let indexed_columns = physical_index_columns(columns);
                self.driver.execute(
                    &sql::create_doc_index(&table.name, &index.name, &indexed_columns)?,
                    Vec::new(),
                )?;
            }
        }

        if stored_version != sql::STORAGE_FORMAT_VERSION {
            self.driver.execute(&sql::set_user_version(), Vec::new())?;
        }

        // Replace the registry from the incoming schema so a removed table leaves no ghost entry.
        let tables = schema
            .tables
            .iter()
            .map(|table| (table.name.clone(), Arc::new(table.clone())))
            .collect();
        *lock(&self.tables) = tables;
        lock(&self.plans).clear();
        self.driver.clear_statements();
        let high = self.max_creation_time_unlocked()?;
        lock(&self.clock).observe(high);
        Ok(())
    }

    /// The next monotonic creation time. Mirrors `clock.next()`.
    /// Calling this consumes a clock tick immediately, even if no commit follows.
    pub fn clock_next(&self) -> Result<f64, StorageError> {
        let wall = wall_ms()?;
        Ok(lock(&self.clock).now(wall))
    }

    pub fn mutation_begin(&self, call: &MutationCall) -> Result<MutationRecord, StorageError> {
        let _guard = lock(&self.operation_lock);
        if let Some(record) = self.mutation_record_unlocked(&call.mutation_id)? {
            self.ensure_mutation_call_matches_unlocked(call)?;
            return Ok(record);
        }
        self.driver.execute(
            sql::insert_mutation(),
            vec![
                text_value(self.identity_key.clone()),
                text_value(call.mutation_id.clone()),
                text_value(call.name.clone()),
                text_value(call.args.clone()),
                text_value(MutationStatus::Accepted.as_str().to_owned()),
            ],
        )?;
        self.mutation_record_unlocked(&call.mutation_id)?
            .ok_or_else(|| StorageError::Decode {
                expected: "mutation record",
                index: 0,
                got: "missing inserted mutation".to_owned(),
            })
    }

    pub fn mutation_fail(&self, mutation_id: &str, error: &str) -> Result<(), StorageError> {
        let _guard = lock(&self.operation_lock);
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

    /// Lists every table name in the database (used to drop them on a format-version reset).
    fn list_tables(&self) -> Result<Vec<String>, StorageError> {
        let mut names = Vec::new();
        self.driver.run_rows(sql::LIST_TABLES, Vec::new(), |row| {
            names.push(text_at(row, 0)?);
            Ok(())
        })?;
        Ok(names)
    }

    /// Forces the database's stored format version, to simulate a database written by another
    /// build in tests.
    #[cfg(test)]
    pub(crate) fn force_user_version_for_test(&self, version: i64) {
        self.driver
            .execute(&format!("PRAGMA user_version = {version}"), Vec::new())
            .unwrap();
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
        ] {
            self.driver
                .execute(sql, vec![text_value(self.identity_key.clone())])?;
        }
        Ok(())
    }

    /// Read one document by id, as one materialized JSON object text
    /// (`{"_id":…,"_creationTime":…,…fields}`).
    pub fn doc_read(&self, table: &str, id: &str) -> Result<Option<String>, StorageError> {
        self.def(table)?;
        debug_assert!(is_valid_ident(table));
        let sql = sql::read_doc(table);
        let params = vec![
            text_value(self.identity_key.clone()),
            text_value(id.to_owned()),
        ];
        let _guard = lock(&self.operation_lock);
        self.driver.run_row(&sql, params, |row| {
            let mut text = String::new();
            append_doc(&mut text, row)?;
            Ok(text)
        })
    }

    /// One page of documents as a single JSON array text. Scans are total: any bounds the SQL
    /// layer cannot represent exactly were widened at compile time, so callers re-check exact
    /// order/bounds.
    pub fn doc_scan(&self, spec: &ScanSpec) -> Result<Page, StorageError> {
        self.scan_page(spec, Projection::Docs)
    }

    /// One page of document keys as `{"ids":[…],"cts":[…]}`; the `data` payload never leaves
    /// `SQLite`.
    pub fn key_scan(&self, spec: &ScanSpec) -> Result<Page, StorageError> {
        self.scan_page(spec, Projection::Keys)
    }

    /// Count documents. `None` means the bounds were widened (a widened count would over-count),
    /// so the caller must count through `key_scan` with its exact re-check instead.
    pub fn doc_count(&self, spec: &CountSpec) -> Result<Option<i64>, StorageError> {
        let table = self.def(&spec.table)?;
        let plan = self.plan(count_key(spec), || compile_count(spec, &table))?;
        if !plan.exact {
            return Ok(None);
        }
        let mut params = vec![text_value(self.identity_key.clone())];
        params.extend(count_params(spec, &table)?);
        let _guard = lock(&self.operation_lock);
        let n = self
            .driver
            .run_row(&plan.sql, params, |row| int_at(row, 0))?;
        Ok(Some(n.unwrap_or(0)))
    }

    fn scan_page(&self, spec: &ScanSpec, projection: Projection) -> Result<Page, StorageError> {
        let table = self.def(&spec.table)?;
        let page_size = spec.page_size.unwrap_or(DEFAULT_SCAN_PAGE);
        if page_size == 0 || page_size > SCAN_CAP {
            return Err(StorageError::Unsatisfiable(format!(
                "scan: page size {page_size} outside 1..={SCAN_CAP}"
            )));
        }
        let shape = scan_shape(spec);
        let cursor_values = match (&spec.cursor, &spec.resume_after_key) {
            (Some(_), Some(_)) => {
                return Err(StorageError::InvalidCursor(
                    "cursor and resume_after_key are mutually exclusive".to_owned(),
                ))
            }
            (Some(cursor), None) => Some(decode_cursor(cursor, &shape)?),
            (None, Some(key)) => Some(key.clone()),
            (None, None) => None,
        };
        let resume = cursor_values.is_some();
        let plan = self.plan(scan_key(spec, projection, resume), || {
            compile_scan(spec, &table, projection, resume)
        })?;
        let positions = key_positions(&plan.columns, projection);

        let mut params = vec![text_value(self.identity_key.clone())];
        params.extend(scan_params(spec, &table, cursor_values.as_deref(), page_size)?);

        let mut count = 0usize;
        let mut last_keys: Option<Vec<ColValue>> = None;
        let mut docs = String::from("[");
        let mut ids = String::from("[");
        let mut cts = String::from("[");
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
                // The +1 overflow row only proves a next page exists; it is never appended.
                if count < page_size {
                    match projection {
                        Projection::Docs => {
                            if count > 0 {
                                docs.push(',');
                            }
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
        Ok(Page { text, cursor })
    }

    pub fn commit(
        &self,
        batch: WriteBatch,
        options: &CommitOptions,
    ) -> Result<CommitResult, StorageError> {
        let changed = changed_tables(&batch);
        let mut upsert_sql: FxHashMap<String, (Arc<TableDef>, String)> = FxHashMap::default();
        for up in &batch.upserts {
            if !upsert_sql.contains_key(&up.table) {
                let def = self.def(&up.table)?;
                let sql = sql::upsert_doc(&def);
                upsert_sql.insert(up.table.clone(), (def, sql));
            }
        }
        for del in &batch.deletes {
            self.def(&del.table)?;
        }

        let _guard = lock(&self.operation_lock);
        self.driver.execute(sql::BEGIN_IMMEDIATE, Vec::new())?;
        let written: Result<CommitResult, StorageError> = (|| {
            for up in batch.upserts {
                let (def, sql) = &upsert_sql[&up.table];
                let mut cols = up.cols;
                let mut params = Vec::with_capacity(4 + def.columns.len());
                params.push(text_value(up.id));
                params.push(text_value(self.identity_key.clone()));
                params.push(Value::from_f64(up.creation_time));
                params.push(text_value(up.data));
                for col in &def.columns {
                    // Absent value → Undefined (Convex orders a missing field before null).
                    let value = cols
                        .iter()
                        .position(|(name, _)| name == &col.name)
                        .map_or(ColValue::Undefined, |i| cols.swap_remove(i).1);
                    // User-extracted columns store the order-preserving key as a BLOB.
                    params.push(Value::Blob(value.encode_key()));
                }
                self.driver.execute(sql, params)?;
            }
            for del in batch.deletes {
                debug_assert!(is_valid_ident(&del.table));
                let sql = sql::delete_doc(&del.table);
                let params = vec![text_value(self.identity_key.clone()), text_value(del.id)];
                self.driver.execute(&sql, params)?;
            }
            self.insert_commit_unlocked(&changed, options)
        })();

        match written {
            Ok(result) => match self.driver.execute(sql::COMMIT, Vec::new()) {
                Ok(()) => Ok(result),
                Err(e) => {
                    let rolled = self.driver.execute(sql::ROLLBACK, Vec::new());
                    if self.commit_exists_unlocked(result.commit_seq)? {
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

    /// Delete ledger rows at or below `up_to_seq`, a consumer watermark. The newest commit row
    /// is always retained so `commit_seq` stays monotonic across the prune; mutations that never
    /// committed (accepted/failed) are never touched. The two deletes are individually atomic
    /// and the prune is idempotent, so no enclosing transaction is needed.
    pub fn ledger_prune(&self, up_to_seq: i64) -> Result<PruneResult, StorageError> {
        let _guard = lock(&self.operation_lock);
        let max_seq = self
            .driver
            .run_row(
                sql::max_commit_seq(),
                vec![text_value(self.identity_key.clone())],
                |row| int_at(row, 0),
            )?
            .unwrap_or(0);
        let bound = up_to_seq.min(max_seq - 1);
        if bound < 1 {
            return Ok(PruneResult::default());
        }
        self.driver.execute(
            sql::prune_commits(),
            vec![
                text_value(self.identity_key.clone()),
                Value::from_i64(bound),
            ],
        )?;
        let commits_deleted = self.driver.changes();
        self.driver.execute(
            sql::prune_mutations(),
            vec![
                text_value(self.identity_key.clone()),
                Value::from_i64(bound),
            ],
        )?;
        let mutations_deleted = self.driver.changes();
        Ok(PruneResult {
            commits_deleted,
            mutations_deleted,
        })
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

    fn next_commit_seq_unlocked(&self) -> Result<i64, StorageError> {
        self.driver
            .run_row(
                sql::next_commit_seq(),
                vec![text_value(self.identity_key.clone())],
                |row| int_at(row, 0),
            )?
            .ok_or(StorageError::Decode {
                expected: "commit sequence",
                index: 0,
                got: "missing row".to_owned(),
            })
    }

    fn insert_commit_unlocked(
        &self,
        changed_tables: &[String],
        options: &CommitOptions,
    ) -> Result<CommitResult, StorageError> {
        let commit_seq = self.next_commit_seq_unlocked()?;
        if let Some(mutation_id) = &options.mutation_id {
            if self.mutation_record_unlocked(mutation_id)?.is_none() {
                return Err(StorageError::Unsatisfiable(format!(
                    "mutation id {mutation_id} was committed before mutation_begin"
                )));
            }
        }
        self.driver.execute(
            sql::insert_commit(),
            vec![
                text_value(self.identity_key.clone()),
                Value::from_i64(commit_seq),
                text_value(options.source.clone()),
                options.mutation_id.clone().map_or(Value::Null, text_value),
                text_value(changed_tables.join("\n")),
            ],
        )?;
        if let Some(mutation_id) = &options.mutation_id {
            self.driver.execute(
                sql::commit_mutation(),
                vec![
                    text_value(MutationStatus::Committed.as_str().to_owned()),
                    options
                        .mutation_result
                        .clone()
                        .map_or(Value::Null, text_value),
                    Value::from_i64(commit_seq),
                    text_value(self.identity_key.clone()),
                    text_value(mutation_id.clone()),
                ],
            )?;
        }
        Ok(CommitResult {
            commit_seq,
            changed_tables: changed_tables.to_vec(),
        })
    }

    fn commit_exists_unlocked(&self, commit_seq: i64) -> Result<bool, StorageError> {
        let found = self.driver.run_row(
            sql::commit_exists(),
            vec![
                text_value(self.identity_key.clone()),
                Value::from_i64(commit_seq),
            ],
            |_| Ok(()),
        )?;
        Ok(found.is_some())
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
        lock(&self.tables)
            .get(table)
            .cloned()
            .ok_or_else(|| StorageError::InvalidIdent(table.to_owned()))
    }

    fn plan(
        &self,
        key: String,
        build: impl FnOnce() -> Result<ScanPlan, StorageError>,
    ) -> Result<Arc<ScanPlan>, StorageError> {
        if let Some(plan) = lock(&self.plans).get(&key) {
            return Ok(plan.clone());
        }
        let plan = Arc::new(build()?);
        lock(&self.plans).insert(key, plan.clone());
        Ok(plan)
    }
}

fn path_lock(path: &str) -> Arc<Mutex<()>> {
    let key = lock_key(path);
    let mut locks = lock(&PATH_LOCKS);
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(existing) = locks.get(&key).and_then(Weak::upgrade) {
        return existing;
    }
    let new_lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&new_lock));
    new_lock
}

/// Guarded state is coherent at every release point, so a poisoned guard is safe to recover.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn changed_tables(batch: &WriteBatch) -> Vec<String> {
    let mut seen = FxHashSet::default();
    let mut tables = Vec::new();
    for table in batch
        .upserts
        .iter()
        .map(|upsert| &upsert.table)
        .chain(batch.deletes.iter().map(|delete| &delete.table))
    {
        if seen.insert(table.as_str()) {
            tables.push(table.clone());
        }
    }
    tables
}

/// The row positions of the physical order columns, given the SELECT layout: documents are
/// `id, creation_time_ms, data, extras…`; keys are `id, creation_time_ms, extras…`.
fn key_positions(order_cols: &[String], projection: Projection) -> Vec<usize> {
    let mut next = match projection {
        Projection::Docs => 3,
        Projection::Keys => 2,
    };
    order_cols
        .iter()
        .map(|col| match col.as_str() {
            "id" => 0,
            "creation_time_ms" => 1,
            _ => {
                let position = next;
                next += 1;
                position
            }
        })
        .collect()
}

#[cfg(not(target_arch = "wasm32"))]
fn lock_key(path: &str) -> String {
    let path = Path::new(path);
    if let Ok(canonical) = fs::canonicalize(path) {
        return canonical.to_string_lossy().into_owned();
    }
    if let (Some(parent), Some(file_name)) = (path.parent(), path.file_name()) {
        if let Ok(parent) = fs::canonicalize(parent) {
            return parent.join(file_name).to_string_lossy().into_owned();
        }
    }
    path.to_string_lossy().into_owned()
}

#[cfg(target_arch = "wasm32")]
fn lock_key(path: &str) -> String {
    path.to_owned()
}

fn validate_ident(name: &str) -> Result<(), StorageError> {
    if is_valid_ident(name) {
        Ok(())
    } else {
        Err(StorageError::InvalidIdent(name.to_owned()))
    }
}

fn is_valid_ident(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && !bytes[0].is_ascii_digit()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

fn is_built_in_index(name: &str, columns: &[String]) -> bool {
    name == "by_id" && matches!(columns, [id] if id == "id")
}

fn physical_index_columns(columns: &[String]) -> Vec<String> {
    let mut out = columns.to_vec();
    for column in ["creation_time_ms", "id"] {
        if !out.iter().any(|candidate| candidate == column) {
            out.push(column.to_owned());
        }
    }
    out
}

fn text_value(value: String) -> Value {
    Value::Text(Text::new(value))
}

/// Splice one materialized document object onto `buf` straight from the row: `{"_id":<id>,
/// "_creationTime":<ct>,<data body>`. The stored `data` column is trusted compact JSON object
/// text (see `UpsertIn::data`), so it is sliced past its leading `{` — never parsed.
fn append_doc(buf: &mut String, row: &Row) -> Result<(), StorageError> {
    let id = text_ref_at(row, 0)?;
    let creation_time = real_at(row, 1)?;
    let data = text_ref_at(row, 2)?;
    let body = data.strip_prefix('{').ok_or_else(|| StorageError::Decode {
        expected: "json object data",
        index: 2,
        got: data.chars().take(16).collect(),
    })?;
    buf.push_str("{\"_id\":");
    append_json_string(buf, id);
    buf.push_str(",\"_creationTime\":");
    append_f64(buf, creation_time)?;
    if body == "}" {
        buf.push('}');
    } else {
        buf.push(',');
        buf.push_str(body);
    }
    Ok(())
}

fn append_json_string(buf: &mut String, value: &str) {
    buf.push('"');
    if value
        .bytes()
        .any(|b| b == b'"' || b == b'\\' || b < 0x20)
    {
        for c in value.chars() {
            match c {
                '"' => buf.push_str("\\\""),
                '\\' => buf.push_str("\\\\"),
                c if (c as u32) < 0x20 => {
                                    write!(buf, "\\u{:04x}", c as u32).expect("writing to a String cannot fail");
                }
                c => buf.push(c),
            }
        }
    } else {
        buf.push_str(value);
    }
    buf.push('"');
}

/// Rust `Display` for f64 is shortest-round-trip and never uses exponent or `.0` forms, so the
/// text is JSON-grammar valid and `JSON.parse` (correctly rounded) reads back the same double.
fn append_f64(buf: &mut String, value: f64) -> Result<(), StorageError> {
    if !value.is_finite() {
        return Err(StorageError::Decode {
            expected: "finite creation time",
            index: 1,
            got: value.to_string(),
        });
    }
    write!(buf, "{value}").expect("writing to a String cannot fail");
    Ok(())
}

fn row_to_mutation_record(row: &Row) -> Result<MutationRecord, StorageError> {
    let mutation_id = text_at(row, 0)?;
    let status_text = text_at(row, 1)?;
    let status = MutationStatus::parse(&status_text).ok_or(StorageError::Decode {
        expected: "mutation status",
        index: 1,
        got: status_text,
    })?;
    Ok(MutationRecord {
        mutation_id,
        status,
        result: optional_text_at(row, 2)?,
        error: optional_text_at(row, 3)?,
        commit_seq: optional_int_at(row, 4)?,
    })
}

/// Read one physical order column back as a `ColValue` for cursor minting: user-extracted columns
/// hold a BLOB order key (decoded via [`ColValue::decode_key`]); the system columns
/// `creation_time_ms`/`id` are native.
fn order_col_value_at(row: &Row, i: usize, col: &str) -> Result<ColValue, StorageError> {
    if col == "creation_time_ms" || col == "id" {
        col_value_at(row, i)
    } else {
        let bytes = blob_at(row, i)?;
        ColValue::decode_key(&bytes).ok_or(StorageError::Decode {
            expected: "order key",
            index: i,
            got: "undecodable order key".to_owned(),
        })
    }
}

/// Combine a root-cause error with a failed ROLLBACK so a stuck transaction is never silent.
fn combine_rollback(cause: StorageError, rollback: Result<(), StorageError>) -> StorageError {
    match rollback {
        Ok(()) => cause,
        Err(rb) => StorageError::Unsatisfiable(format!(
            "operation failed ({cause}) and ROLLBACK failed ({rb}); connection may be mid-transaction"
        )),
    }
}

fn col_value_at(row: &Row, i: usize) -> Result<ColValue, StorageError> {
    match row.get_value(i) {
        Value::Null => Ok(ColValue::Null),
        Value::Numeric(Numeric::Integer(n)) => Ok(ColValue::Integer(*n)),
        Value::Numeric(Numeric::Float(f)) => Ok(ColValue::Real(f64::from(*f))),
        Value::Text(s) => Ok(ColValue::Text(s.as_str().to_owned())),
        v => Err(StorageError::Decode {
            expected: "column value",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

fn text_ref_at(row: &Row, i: usize) -> Result<&str, StorageError> {
    match row.get_value(i) {
        Value::Text(s) => Ok(s.as_str()),
        v => Err(StorageError::Decode {
            expected: "text",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

fn text_at(row: &Row, i: usize) -> Result<String, StorageError> {
    match row.get_value(i) {
        Value::Text(s) => Ok(s.as_str().to_owned()),
        v => Err(StorageError::Decode {
            expected: "text",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

fn optional_text_at(row: &Row, i: usize) -> Result<Option<String>, StorageError> {
    match row.get_value(i) {
        Value::Null => Ok(None),
        Value::Text(s) => Ok(Some(s.as_str().to_owned())),
        v => Err(StorageError::Decode {
            expected: "optional text",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

fn real_at(row: &Row, i: usize) -> Result<f64, StorageError> {
    match row.get_value(i) {
        Value::Numeric(Numeric::Float(n)) => Ok(f64::from(*n)),
        Value::Numeric(Numeric::Integer(n)) => Ok(*n as f64),
        v => Err(StorageError::Decode {
            expected: "real",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

fn optional_int_at(row: &Row, i: usize) -> Result<Option<i64>, StorageError> {
    match row.get_value(i) {
        Value::Null => Ok(None),
        Value::Numeric(Numeric::Integer(n)) => Ok(Some(*n)),
        v => Err(StorageError::Decode {
            expected: "optional integer",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

fn int_at(row: &Row, i: usize) -> Result<i64, StorageError> {
    match row.get_value(i) {
        Value::Numeric(Numeric::Integer(n)) => Ok(*n),
        v => Err(StorageError::Decode {
            expected: "integer",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

fn blob_at(row: &Row, i: usize) -> Result<Vec<u8>, StorageError> {
    match row.get_value(i) {
        Value::Blob(bytes) => Ok(bytes.clone()),
        v => Err(StorageError::Decode {
            expected: "blob",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}
