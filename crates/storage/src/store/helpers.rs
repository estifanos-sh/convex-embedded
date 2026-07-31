//! Stateless free functions supporting `EmbeddedStore`.

use std::fmt::Write as _;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
#[cfg(not(target_arch = "wasm32"))]
use std::{fs, path::Path};

use rustc_hash::FxHashSet;
use sha2::{Digest, Sha256};
use turso_core::{types::Text, Numeric, Row, Value};

use crate::error::StorageError;
use crate::sql::Projection;
#[cfg(any(debug_assertions, test, feature = "testkit"))]
use crate::types::RevFrontier;
use crate::types::{
    AuthoritativeRow, ColValue, CommitOptions, DocWrite, FileMetadata, IdMapping, IdMappingContent,
    MutationRecord, MutationStatus, PendingUpload, RevKey, RevState, RowChange, RowChangeOp,
    RowHead, RowKey, ScheduledFunctionKind, ScheduledJob, ScheduledState, StoreSchema, TableDef,
    UploadLease, WriteBatch,
};

use super::{DirtyHead, TableRuntime, PATH_LOCKS};

fn finite_clock(clock: f64) -> f64 {
    if clock.is_finite() {
        clock
    } else {
        0.0
    }
}

pub(crate) fn projection_logical_clock(
    record: &AuthoritativeRow,
    existing: Option<&RowHead>,
) -> f64 {
    record
        .logical_clock
        .filter(|clock| clock.is_finite())
        .or_else(|| existing.map(|state| finite_clock(state.logical_clock)))
        .unwrap_or(0.0)
}

/// Stable across generations: op ids append `:{generation}` and change sets `:{generation}:{index}`,
/// so any generation of one pending batch shares this prefix.
#[cfg_attr(test, derive(Debug, PartialEq, Eq))]
pub(crate) enum RecordOrder {
    /// Covers both a clock win and a server verdict: token-less `Verdict`-channel records adopt too.
    Adopt,
    Known,
    Stale,
}

/// The client-side mirror of the component's `clockWins`: a record may only move a document
/// forward in LWW order. The comparison is against the last-accepted authoritative base, which
/// `existing` carries even while a local edit is dirty (a local commit never rewrites the
/// projection head's `server_base`/`logical_clock`). Retaining the displaced dirty state before an
/// [`RecordOrder::Adopt`] is the caller's job; `record_order` never suppresses an authoritative row
/// merely because the local row is dirty.
#[allow(
    clippy::float_cmp,
    reason = "logical clocks are persisted protocol values and equality identifies the same clock"
)]
pub(crate) fn record_order(record: &AuthoritativeRow, existing: Option<&RowHead>) -> RecordOrder {
    let Some(existing) = existing else {
        return RecordOrder::Adopt;
    };
    let Some(clock) = record.logical_clock.filter(|clock| clock.is_finite()) else {
        return if record.projection_hash == existing.projection_hash {
            RecordOrder::Known
        } else {
            RecordOrder::Adopt
        };
    };
    let existing_clock = finite_clock(existing.logical_clock);
    if existing.server_base.is_none() {
        return RecordOrder::Adopt;
    }
    if clock > existing_clock {
        return RecordOrder::Adopt;
    }
    if clock == existing_clock {
        return if record.projection_hash == existing.projection_hash {
            RecordOrder::Known
        } else {
            RecordOrder::Adopt
        };
    }
    RecordOrder::Stale
}

pub(crate) fn path_lock(path: &str) -> Arc<Mutex<()>> {
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

pub(crate) fn commit_seq_key(path_key: &str, identity_key: &str) -> String {
    format!("{path_key}\0{identity_key}")
}

pub(crate) fn schema_signature(schema: &StoreSchema) -> String {
    schema.hash.clone()
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const LUT: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(LUT[(byte >> 4) as usize] as char);
        out.push(LUT[(byte & 0x0f) as usize] as char);
    }
    out
}

/// Guarded state is coherent at every release point, so a poisoned guard is safe to recover.
pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) fn changed_tables(batch: &WriteBatch) -> Vec<String> {
    if batch.local_field_writes.is_empty()
        && batch.local_field_deletes.is_empty()
        && batch.deletes.is_empty()
        && batch.doc_writes.len() == 1
    {
        return vec![batch.doc_writes[0].table.clone()];
    }
    if batch.local_field_writes.is_empty()
        && batch.local_field_deletes.is_empty()
        && batch.doc_writes.is_empty()
        && batch.deletes.len() == 1
    {
        return vec![batch.deletes[0].table.clone()];
    }
    let mut seen = FxHashSet::default();
    let mut tables = Vec::new();
    for table in batch
        .doc_writes
        .iter()
        .map(|doc_write| &doc_write.table)
        .chain(batch.deletes.iter().map(|delete| &delete.table))
        .chain(batch.local_field_writes.iter().map(|write| &write.table))
        .chain(batch.local_field_deletes.iter().map(|delete| &delete.table))
    {
        if seen.insert(table.as_str()) {
            tables.push(table.clone());
        }
    }
    tables
}

pub(crate) fn require_terminal_mutation_call(
    options: &CommitOptions,
    mutation_id: &str,
) -> Result<(String, String), StorageError> {
    let call = options.terminal_call().ok_or_else(|| {
        StorageError::Unsatisfiable(format!(
            "mutation id {mutation_id} was committed before mutation_write"
        ))
    })?;
    Ok((call.name.clone(), call.args.clone()))
}

pub(crate) fn cols_are_in_table_order(doc_write: &DocWrite, table: &TableRuntime) -> bool {
    doc_write.cols.len() == table.def.columns.len()
        && table
            .def
            .columns
            .iter()
            .zip(&doc_write.cols)
            .all(|(column, (name, _))| column.name == *name)
}

pub(crate) fn is_data_only_id(data_only_ids: &[RowKey], table: &str, id: &str) -> bool {
    data_only_ids
        .iter()
        .any(|row| row.table == table && row.document_id == id)
}

pub(crate) fn is_fresh_id(fresh_ids: &[RowKey], table: &str, id: &str) -> bool {
    fresh_ids
        .iter()
        .any(|row| row.table == table && row.document_id == id)
}

pub(crate) fn peer_id_from_bytes(bytes: &[u8]) -> Result<u64, StorageError> {
    Ok(u64::from_be_bytes(bytes.try_into().map_err(|_| {
        StorageError::Decode {
            expected: "u64 peer id",
            index: 0,
            got: format!("{} bytes", bytes.len()),
        }
    })?))
}

pub(crate) fn create_peer_id() -> u64 {
    let peer_id = uuid::Uuid::new_v4().as_u128() as u64;
    match peer_id {
        0 => 1,
        peer_id if peer_id >= crate::crdt::SEED_PEER => crate::crdt::SEED_PEER - 1,
        peer_id => peer_id,
    }
}

pub(crate) fn row_changes(batch: &WriteBatch) -> Result<Vec<RowChange>, StorageError> {
    let mut changes = Vec::with_capacity(batch.doc_writes.len() + batch.deletes.len());
    for doc_write in &batch.doc_writes {
        changes.push(RowChange {
            op: RowChangeOp::Write,
            table: doc_write.table.clone(),
            id: doc_write.id.clone(),
            row: Some(doc_write_row(doc_write)?),
        });
    }
    for delete in &batch.deletes {
        changes.push(RowChange {
            op: RowChangeOp::Delete,
            table: delete.table.clone(),
            id: delete.id.clone(),
            row: None,
        });
    }
    Ok(changes)
}

pub(crate) fn doc_write_row(doc_write: &crate::types::DocWrite) -> Result<String, StorageError> {
    materialized_row(&doc_write.id, doc_write.creation_time, &doc_write.data)
}

pub(crate) fn materialized_row(
    id: &str,
    creation_time: f64,
    data: &str,
) -> Result<String, StorageError> {
    let body = data.strip_prefix('{').ok_or_else(|| StorageError::Decode {
        expected: "json object data",
        index: 2,
        got: data.chars().take(16).collect(),
    })?;
    let mut out = String::new();
    out.push_str("{\"_id\":");
    append_json_string(&mut out, id);
    out.push_str(",\"_creationTime\":");
    append_f64(&mut out, creation_time)?;
    if body == "}" {
        out.push('}');
    } else {
        out.push(',');
        out.push_str(body);
    }
    Ok(out)
}

pub(crate) fn remote_doc_encode(
    table: &TableDef,
    local_id: &str,
    row: &str,
    now_ms: i64,
) -> Result<crate::types::DocWrite, StorageError> {
    let value: serde_json::Value = serde_json::from_str(row).map_err(|e| StorageError::Decode {
        expected: "remote projection json",
        index: 0,
        got: e.to_string(),
    })?;
    let serde_json::Value::Object(mut object) = value else {
        return Err(StorageError::Decode {
            expected: "remote projection object",
            index: 0,
            got: row.chars().take(16).collect(),
        });
    };
    let creation_time = object
        .remove("_creationTime")
        .and_then(|value| value.as_f64())
        .unwrap_or(now_ms as f64);
    object.remove("_id");
    let cols = crate::crdt::extract_cols(table, &object)?;
    let data = serde_json::to_string(&serde_json::Value::Object(object)).map_err(|e| {
        StorageError::Decode {
            expected: "remote projection data",
            index: 0,
            got: e.to_string(),
        }
    })?;
    Ok(crate::types::DocWrite {
        cols,
        creation_time,
        data,
        id: local_id.to_owned(),
        table: table.name.clone(),
    })
}

pub(crate) fn remote_doc_id_encode(table: &str, server_document_id: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(b"embedded:projection-local-id:v1");
    hash.update([0]);
    hash.update(table.as_bytes());
    hash.update([0]);
    hash.update(server_document_id.as_bytes());
    let digest = hash.finalize();
    let mut suffix = String::with_capacity(32);
    for byte in &digest[..16] {
        write!(&mut suffix, "{byte:02x}").expect("writing to a String cannot fail");
    }
    format!("{table}|{suffix}")
}

pub(crate) fn is_local_document_id_for_table(table: &str, document_id: &str) -> bool {
    let Some(suffix) = document_id
        .strip_prefix(table)
        .and_then(|rest| rest.strip_prefix('|'))
    else {
        return false;
    };
    suffix.len() == 32
        && suffix
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// The row positions of the physical order columns, given the SELECT layout: documents are
/// `id, creation_time_ms, data, extras…`; keys are `id, creation_time_ms, extras…`.
pub(crate) fn key_positions(order_cols: &[String], projection: Projection) -> Vec<usize> {
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
pub(crate) fn lock_key(path: &str) -> String {
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
pub(crate) fn lock_key(path: &str) -> String {
    path.to_owned()
}

pub(crate) fn validate_ident(name: &str) -> Result<(), StorageError> {
    if is_valid_ident(name) {
        Ok(())
    } else {
        Err(StorageError::InvalidIdent(name.to_owned()))
    }
}

pub(crate) fn is_valid_ident(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && !bytes[0].is_ascii_digit()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

pub(crate) fn is_built_in_index(name: &str, columns: &[String]) -> bool {
    name == "by_id" && matches!(columns, [id] if id == "id")
}

pub(crate) fn physical_index_columns(columns: &[String]) -> Vec<String> {
    let mut out = columns.to_vec();
    for column in ["creation_time_ms", "id"] {
        if !out.iter().any(|candidate| candidate == column) {
            out.push(column.to_owned());
        }
    }
    out
}

pub(crate) fn text_value(value: String) -> Value {
    Value::Text(Text::new(value))
}

/// Splice one materialized document object onto `buf` straight from the row: `{"_id":<id>,
/// "_creationTime":<ct>,<data body>`. The stored `data` column is trusted compact JSON object
/// text (see `DocWrite::data`), so it is sliced past its leading `{` — never parsed.
pub(crate) fn append_doc(buf: &mut String, row: &Row) -> Result<(), StorageError> {
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

pub(crate) fn append_json_string(buf: &mut String, value: &str) {
    buf.push('"');
    if value.bytes().any(|b| b == b'"' || b == b'\\' || b < 0x20) {
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
pub(crate) fn append_f64(buf: &mut String, value: f64) -> Result<(), StorageError> {
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

pub(crate) fn row_to_mutation_record(row: &Row) -> Result<MutationRecord, StorageError> {
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

pub(crate) fn row_to_id_mapping(row: &Row) -> Result<IdMapping, StorageError> {
    let state_text = text_at(row, 3)?;
    let convex_id = optional_text_at(row, 2)?;
    let mapping = IdMappingContent::decode(&state_text, convex_id).ok_or(StorageError::Decode {
        expected: "id mapping state",
        index: 3,
        got: state_text,
    })?;
    Ok(IdMapping {
        table: text_at(row, 0)?,
        local_id: text_at(row, 1)?,
        mapping,
        created_time: int_at(row, 4)?,
        updated_time: int_at(row, 5)?,
    })
}

pub(crate) fn row_to_file_metadata(row: &Row) -> Result<FileMetadata, StorageError> {
    Ok(FileMetadata {
        storage_id: text_at(row, 0)?,
        sha256: text_at(row, 1)?,
        size: int_at(row, 2)?,
        content_type: optional_text_at(row, 3)?,
        source: optional_text_at(row, 4)?,
        created_time: int_at(row, 5)?,
        updated_time: int_at(row, 6)?,
    })
}

pub(crate) fn row_to_pending_upload(row: &Row) -> Result<PendingUpload, StorageError> {
    let state_text = text_at(row, 4)?;
    let owner = optional_text_at(row, 5)?;
    let lease_until = optional_int_at(row, 6)?;
    let lease =
        UploadLease::decode(&state_text, owner, lease_until).ok_or(StorageError::Decode {
            expected: "upload state",
            index: 4,
            got: state_text,
        })?;
    Ok(PendingUpload {
        local_storage_id: text_at(row, 0)?,
        sha256: text_at(row, 1)?,
        size: int_at(row, 2)?,
        content_type: optional_text_at(row, 3)?,
        lease,
        created_time: int_at(row, 7)?,
        updated_time: int_at(row, 8)?,
    })
}

pub(crate) fn row_to_rev_state(row: &Row) -> Result<RevState, StorageError> {
    let lifecycle = rev_lifecycle_at(row, 5)?;
    Ok(RevState {
        key: RevKey {
            row: RowKey {
                table: text_at(row, 0)?,
                document_id: text_at(row, 1)?,
            },
            rev_id: text_at(row, 2)?,
        },
        snapshot: blob_at(row, 3)?,
        log: Vec::new(),
        frontier: blob_at(row, 4)?,
        lifecycle,
        updated_time: int_at(row, 12)?,
    })
}

pub(crate) fn rev_lifecycle_at(
    row: &Row,
    status_index: usize,
) -> Result<crate::types::RevLifecycle, StorageError> {
    let lifecycle_text = text_at(row, status_index)?;
    crate::types::RevLifecycle::decode(
        &lifecycle_text,
        optional_text_at(row, status_index + 1)?,
        optional_text_at(row, status_index + 2)?,
        optional_text_at(row, status_index + 3)?,
        optional_text_at(row, status_index + 4)?,
        optional_text_at(row, status_index + 5)?,
        optional_text_at(row, status_index + 6)?,
    )
    .ok_or(StorageError::Decode {
        expected: "revision lifecycle",
        index: status_index,
        got: lifecycle_text,
    })
}

#[cfg(any(debug_assertions, test, feature = "testkit"))]
pub(crate) fn row_to_rev_frontier(row: &Row) -> Result<RevFrontier, StorageError> {
    Ok(RevFrontier {
        key: RevKey {
            row: RowKey {
                table: text_at(row, 0)?,
                document_id: text_at(row, 1)?,
            },
            rev_id: text_at(row, 2)?,
        },
        frontier: blob_at(row, 3)?,
    })
}

pub(crate) fn row_to_dirty_head(row: &Row) -> Result<DirtyHead, StorageError> {
    let table = text_at(row, 0)?;
    let document_id = text_at(row, 1)?;
    let op_text = text_at(row, 2)?;
    let Some(op) = RowChangeOp::parse(&op_text) else {
        return Err(StorageError::Decode {
            expected: "dirty head operation",
            index: 2,
            got: op_text,
        });
    };
    Ok(DirtyHead {
        row: RowKey {
            table: table.clone(),
            document_id: document_id.clone(),
        },
        change: RowChange {
            op,
            table,
            id: document_id,
            row: None,
        },
        first_commit_seq: int_at(row, 3)?,
        updated_commit_seq: int_at(row, 4)?,
        created_time: int_at(row, 5)?,
        updated_time: int_at(row, 6)?,
        server_document_id: optional_text_at(row, 7)?,
        base_projection_hash: optional_text_at(row, 8)?,
        base_root_id: optional_text_at(row, 9)?,
        base_node_id: optional_text_at(row, 10)?,
        logical_clock: real_at(row, 11)?,
    })
}

/// Bind values for `schedule_lease_read`, matching its predicate placeholder order: `identity_key`,
/// then the Pending-due branch (state, `due_time`) and the Running-expired branch (state,
/// `lease_until`). Both time comparisons use the same `now_ms`.
pub(crate) fn schedule_lease_params(identity_key: &str, now_ms: i64) -> Vec<Value> {
    vec![
        text_value(identity_key.to_owned()),
        text_value(ScheduledState::PENDING.to_owned()),
        Value::from_i64(now_ms),
        text_value(ScheduledState::RUNNING.to_owned()),
        Value::from_i64(now_ms),
    ]
}

pub(crate) fn max_commit_seq_params(identity_key: &str) -> Vec<Value> {
    vec![
        text_value(identity_key.to_owned()),
        text_value(identity_key.to_owned()),
        text_value(identity_key.to_owned()),
        text_value(identity_key.to_owned()),
    ]
}

pub(crate) fn row_to_scheduled_job(row: &Row) -> Result<ScheduledJob, StorageError> {
    let kind_text = text_at(row, 1)?;
    let kind = ScheduledFunctionKind::parse(&kind_text).ok_or(StorageError::Decode {
        expected: "scheduled function kind",
        index: 1,
        got: kind_text,
    })?;
    let state_text = text_at(row, 5)?;
    let lease_until = optional_int_at(row, 6)?;
    let state = ScheduledState::decode(&state_text, lease_until).ok_or(StorageError::Decode {
        expected: "scheduled job state",
        index: 5,
        got: state_text,
    })?;
    Ok(ScheduledJob {
        job_id: text_at(row, 0)?,
        kind,
        name: text_at(row, 2)?,
        args: text_at(row, 3)?,
        due_time: int_at(row, 4)?,
        state,
        created_time: int_at(row, 7)?,
        updated_time: int_at(row, 8)?,
    })
}

/// Read one physical order column back as a `ColValue` for cursor minting: user-extracted columns
/// hold a BLOB order key (decoded via [`ColValue::decode_key`]); the system columns
/// `creation_time_ms`/`id` are native.
pub(crate) fn order_col_value_at(row: &Row, i: usize, col: &str) -> Result<ColValue, StorageError> {
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
pub(crate) fn combine_rollback(
    cause: StorageError,
    rollback: Result<(), StorageError>,
) -> StorageError {
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

pub(crate) fn text_ref_at(row: &Row, i: usize) -> Result<&str, StorageError> {
    match row.get_value(i) {
        Value::Text(s) => Ok(s.as_str()),
        v => Err(StorageError::Decode {
            expected: "text",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

pub(crate) fn text_at(row: &Row, i: usize) -> Result<String, StorageError> {
    match row.get_value(i) {
        Value::Text(s) => Ok(s.as_str().to_owned()),
        v => Err(StorageError::Decode {
            expected: "text",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

pub(crate) fn optional_text_at(row: &Row, i: usize) -> Result<Option<String>, StorageError> {
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

pub(crate) fn real_at(row: &Row, i: usize) -> Result<f64, StorageError> {
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

pub(crate) fn optional_int_at(row: &Row, i: usize) -> Result<Option<i64>, StorageError> {
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

pub(crate) fn int_at(row: &Row, i: usize) -> Result<i64, StorageError> {
    match row.get_value(i) {
        Value::Numeric(Numeric::Integer(n)) => Ok(*n),
        v => Err(StorageError::Decode {
            expected: "integer",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

pub(crate) fn blob_at(row: &Row, i: usize) -> Result<Vec<u8>, StorageError> {
    match row.get_value(i) {
        Value::Blob(bytes) => Ok(bytes.clone()),
        v => Err(StorageError::Decode {
            expected: "blob",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}
