//! Internal test support shared by this crate's integration tests (`tests/*.rs`) and the model
//! simulator. `#[doc(hidden)]` and behind the `testkit` feature, so it never enters the shipped
//! napi/wasm/native binary: `storage` is an internal build-input crate with no external consumer.
//! This is the white-box seam that lets out-of-crate integration tests reach the structural oracle,
//! the fixtures, and the few `pub(crate)` internals they need — without widening the real API.
#![allow(clippy::must_use_candidate)]

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::{
    ColValue, ColumnDef, CommitOptions, CommitResult, CountSpec, DocWrite, EmbeddedStore, IndexDef,
    Page, ReadSpec, RevState, StorageError, StoreSchema, TableDef, TablePlacement, WriteBatch,
};

/// A logical clock far above any wall-minted HLC value, for records that must win LWW in tests.
pub const DOMINATING_CLOCK: f64 = 4.0e15;

pub fn dominating_clock() -> Option<f64> {
    Some(DOMINATING_CLOCK)
}

/// A unique temp db path, with any stale WAL/SHM sidecar files removed first. The process id plus a
/// monotonic counter make the name collision-free even when concurrent tests across crates pass the
/// same `name`.
pub fn tmp_path(name: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = format!(
        "{}-{}-{name}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let p = std::env::temp_dir().join(&unique);
    for suffix in ["", "-wal", "-shm"] {
        std::fs::remove_file(p.with_file_name(format!("{unique}{suffix}"))).ok();
    }
    p
}

/// `issues` with a `by_status` index, plus a column-less `t`.
pub fn schema() -> StoreSchema {
    StoreSchema {
        hash: "0".repeat(64),
        setup_hash: String::new(),
        tables: vec![
            TableDef {
                name: "issues".into(),
                placement: TablePlacement::Replicated,
                local_fields: vec![],
                columns: vec![ColumnDef {
                    name: "status".into(),
                    field: None,
                }],
                crdt_fields: vec![],
                indexes: vec![IndexDef {
                    name: "by_status".into(),
                    fields: vec!["status".into()],
                    columns: None,
                }],
            },
            TableDef {
                name: "t".into(),
                placement: TablePlacement::Replicated,
                local_fields: vec![],
                columns: vec![],
                crdt_fields: vec![],
                indexes: vec![],
            },
        ],
    }
}

/// A single `flags` table with a boolean `active` column/index.
pub fn bool_schema() -> StoreSchema {
    StoreSchema {
        hash: "1".repeat(64),
        setup_hash: String::new(),
        tables: vec![TableDef {
            name: "flags".into(),
            placement: TablePlacement::Replicated,
            local_fields: vec![],
            columns: vec![ColumnDef {
                name: "active".into(),
                field: None,
            }],
            crdt_fields: vec![],
            indexes: vec![IndexDef {
                name: "by_active".into(),
                fields: vec!["active".into()],
                columns: None,
            }],
        }],
    }
}

/// A `users` table whose index columns are aliased to Convex field paths.
pub fn alias_schema() -> StoreSchema {
    StoreSchema {
        hash: "2".repeat(64),
        setup_hash: String::new(),
        tables: vec![TableDef {
            name: "users".into(),
            placement: TablePlacement::Replicated,
            local_fields: vec![],
            columns: vec![ColumnDef {
                name: "idx_profile_email".into(),
                field: Some("profile.email".into()),
            }],
            crdt_fields: vec![],
            indexes: vec![
                IndexDef {
                    name: "by_email".into(),
                    fields: vec!["profile.email".into(), "_creationTime".into()],
                    columns: Some(vec!["idx_profile_email".into(), "creation_time_ms".into()]),
                },
                IndexDef {
                    name: "by_creation_time".into(),
                    fields: vec!["_creationTime".into()],
                    columns: Some(vec!["creation_time_ms".into()]),
                },
                IndexDef {
                    name: "by_id".into(),
                    fields: vec!["_id".into()],
                    columns: Some(vec!["id".into()]),
                },
            ],
        }],
    }
}

/// A two-column `issues` table used by the SQL-shape tests.
pub fn sql_table() -> TableDef {
    TableDef {
        name: "issues".to_owned(),
        placement: TablePlacement::Replicated,
        local_fields: vec![],
        columns: vec![
            ColumnDef {
                field: None,
                name: "status".to_owned(),
            },
            ColumnDef {
                field: None,
                name: "rank".to_owned(),
            },
        ],
        crdt_fields: vec![],
        indexes: vec![IndexDef {
            columns: None,
            fields: vec!["status".to_owned(), "rank".to_owned()],
            name: "by_status_rank".to_owned(),
        }],
    }
}

/// A single `vals` table with one indexed `v` column — for total-order/key tests.
pub fn vals_schema() -> StoreSchema {
    StoreSchema {
        hash: "3".repeat(64),
        setup_hash: String::new(),
        tables: vec![TableDef {
            name: "vals".into(),
            placement: TablePlacement::Replicated,
            local_fields: vec![],
            columns: vec![ColumnDef {
                name: "v".into(),
                field: None,
            }],
            crdt_fields: vec![],
            indexes: vec![IndexDef {
                name: "by_v".into(),
                fields: vec!["v".into()],
                columns: None,
            }],
        }],
    }
}

/// Parse a page's JSON text into documents.
pub fn parse_docs(page: &Page) -> Vec<serde_json::Value> {
    serde_json::from_str(&page.text).expect("doc page text is valid JSON")
}

/// The `_id`s of a page, in page order.
pub fn doc_ids(page: &Page) -> Vec<String> {
    parse_docs(page)
        .into_iter()
        .map(|doc| doc["_id"].as_str().expect("doc has _id").to_owned())
        .collect()
}

/// Read a single document as JSON.
pub fn read_doc(store: &EmbeddedStore, table: &str, id: &str) -> Option<serde_json::Value> {
    store
        .doc_read(table, id)
        .unwrap()
        .map(|text| serde_json::from_str(&text).expect("doc text is valid JSON"))
}

/// Commit a batch with default (local) options.
pub fn commit(store: &EmbeddedStore, batch: WriteBatch) -> CommitResult {
    store.commit(batch, &CommitOptions::default()).unwrap()
}

/// A `users` `doc_write` carrying a profile email.
pub fn user(store: &EmbeddedStore, id: &str, email: &str) -> DocWrite {
    DocWrite {
        table: "users".into(),
        id: id.into(),
        data: format!(r#"{{"profile":{{"email":"{email}"}}}}"#),
        cols: vec![("idx_profile_email".into(), ColValue::Text(email.into()))],
        creation_time: store.clock_read().unwrap(),
    }
}

/// A `users` `doc_write` with no email column.
pub fn user_without_email(store: &EmbeddedStore, id: &str) -> DocWrite {
    DocWrite {
        table: "users".into(),
        id: id.into(),
        data: r#"{"profile":{}}"#.into(),
        cols: vec![],
        creation_time: store.clock_read().unwrap(),
    }
}

/// An `issues` `doc_write` with a fresh monotonic creation time.
pub fn issue(store: &EmbeddedStore, id: &str, title: &str, status: &str) -> DocWrite {
    DocWrite {
        table: "issues".into(),
        id: id.into(),
        data: format!(r#"{{"title":"{title}"}}"#),
        cols: vec![("status".into(), ColValue::Text(status.into()))],
        creation_time: store.clock_read().unwrap(),
    }
}

/// A `flags` `doc_write` with the given boolean column value.
pub fn flag(store: &EmbeddedStore, id: &str, active: ColValue) -> DocWrite {
    DocWrite {
        table: "flags".into(),
        id: id.into(),
        data: r#"{"active":true}"#.into(),
        cols: vec![("active".into(), active)],
        creation_time: store.clock_read().unwrap(),
    }
}

/// A write batch of `doc_writes` only.
pub fn doc_writes(rows: Vec<DocWrite>) -> WriteBatch {
    WriteBatch {
        doc_writes: rows,
        local_field_writes: vec![],
        local_field_deletes: vec![],
        crdt_ops: vec![],
        crdt_restores: vec![],
        deletes: vec![],
        fresh_ids: vec![],
        data_only_ids: vec![],
        commit_ts_doc_writes: vec![],
        commit_ts_local_field_writes: vec![],
        id_mappings: vec![],
        schedules: vec![],
    }
}

/// Walk an entire scan through its cursor chain at the given page size, returning every id in page
/// order and asserting page-size invariants along the way.
pub fn paged_ids(store: &EmbeddedStore, spec: &ReadSpec, page_size: usize) -> Vec<String> {
    let mut ids = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = store
            .doc_page_read(&ReadSpec {
                page_size: Some(page_size),
                cursor: cursor.clone(),
                ..spec.clone()
            })
            .unwrap();
        let page_ids = doc_ids(&page);
        assert!(page_ids.len() <= page_size);
        if page.cursor.is_some() {
            assert_eq!(page_ids.len(), page_size);
        }
        ids.extend(page_ids);
        match page.cursor {
            Some(next) => cursor = Some(next),
            None => return ids,
        }
    }
}

/// Arm the driver to fail the next commit — fault injection for rollback tests.
pub fn fail_next_commit() {
    crate::driver::fail_next_commit();
}

/// Apply a staged Loro import to a rev history (crdt internals).
/// Materialize the document a rev projects to, or `None` for a tombstone (crdt internals).
pub fn rev_doc_read(state: &RevState, document_id: &str) -> Result<Option<String>, StorageError> {
    crate::crdt::rev_doc_read(state, document_id)
}

/// Decode a keyset cursor against an expected scan shape (sql internals).
pub fn decode_cursor(cursor: &str, expected_shape: &str) -> Result<Vec<ColValue>, StorageError> {
    crate::sql::decode_cursor(cursor, expected_shape)
}

/// Encode a keyset cursor for the given scan shape (sql internals) — paired with [`decode_cursor`]
/// for round-trip property tests.
pub fn encode_cursor(shape: &str, values: &[ColValue]) -> String {
    crate::sql::encode_cursor(shape, values)
}

/// A read-only view of a compiled plan: the SQL text and whether its bounds are exact.
pub struct ReadPlanView {
    pub sql: String,
    pub exact: bool,
}

pub fn create_commits() -> &'static str {
    crate::sql::create_commits()
}

pub fn create_commits_mutation_index() -> &'static str {
    crate::sql::create_commits_mutation_index()
}

pub fn create_doc_table(def: &TableDef) -> String {
    crate::sql::create_doc_table(def)
}

pub fn create_doc_index(
    table: &str,
    name: &str,
    columns: &[String],
) -> Result<String, StorageError> {
    crate::sql::create_doc_index(table, name, columns)
}

pub fn write_doc(def: &TableDef) -> String {
    crate::sql::write_doc(def)
}

pub fn read_deleted_id_mappings_sql() -> &'static str {
    crate::sql::read_deleted_id_mappings_by_convex_id()
}

pub fn read_doc_sql(table: &str) -> String {
    crate::sql::read_doc(table)
}

pub fn generation_sql(sql: &str) -> String {
    crate::sql::generation_sql(sql, 1).into_owned()
}

/// Point-read SQL on the internal tables that share the composite-PK mis-planning hazard, exposed so
/// the `explain` regression test can assert their query plans seek the intended index.
pub fn read_projection_sql() -> &'static str {
    crate::sql::read_projection()
}

pub fn delete_projection_row_sql() -> &'static str {
    crate::sql::delete_projection_row()
}

/// Compile a page read and return its SQL view (Docs projection).
pub fn page_plan(
    spec: &ReadSpec,
    table: &TableDef,
    resume: bool,
) -> Result<ReadPlanView, StorageError> {
    let plan = crate::sql::compile_page_read(spec, table, crate::sql::Projection::Docs, resume)?;
    Ok(ReadPlanView {
        sql: plan.sql,
        exact: plan.exact,
    })
}

/// Compile a count read and return its SQL view.
pub fn count_plan(spec: &CountSpec, table: &TableDef) -> Result<ReadPlanView, StorageError> {
    let plan = crate::sql::compile_count(spec, table)?;
    Ok(ReadPlanView {
        sql: plan.sql,
        exact: plan.exact,
    })
}
