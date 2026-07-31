//! Regression guard: every point read/delete keyed on a composite PRIMARY KEY must seek that key,
//! not scan the partition.
//!
//! turso 0.6 mis-costs the composite `PRIMARY KEY` auto-index against any FULL secondary index that
//! shares the PK's leading column(s): given a free choice it seeks only the shared prefix and
//! residual-filters the remaining key columns across the whole `identity_key` partition — an O(rows)
//! scan on the hottest paths.
//!
//! Two fixes share one mechanism (`INDEXED BY`). Doc tables (`by_v`, the always-present
//! `by_creation_time`, …) build an explicit `by_id` index that `read_doc` pins — storage format 18.
//! Internal tables with overlapping secondary indexes pin the PK auto-index
//! `sqlite_autoindex_<table>_1` directly, with no schema change. These tests prepare the exact SQL
//! and assert the plan seeks every constrained key column and never falls back to the wrong index.
//!
//! Run with: `cargo test -p storage --features testkit --test explain -- --nocapture`
#![cfg(feature = "testkit")]

use std::sync::Arc;

use storage::testkit;
use storage::{
    Bound, ColValue, ColumnDef, CommitOptions, CountSpec, DocWrite, EmbeddedStore, IndexDef,
    StoreSchema, TableDef, TablePlacement, WriteBatch,
};
use turso_core::{
    Connection, Database, DatabaseOpts, OpenFlags, PlatformIO, StepResult, Value, IO,
};

fn schema() -> StoreSchema {
    StoreSchema {
        hash: "0".repeat(64),
        migrations: vec![],
        migration_code_hash: String::new(),
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

fn db_path(tag: &str) -> std::path::PathBuf {
    let name = format!("explain_diag_{}_{tag}.db", std::process::id());
    let path = std::env::temp_dir().join(&name);
    for suffix in ["", "-wal", "-shm"] {
        std::fs::remove_file(path.with_file_name(format!("{name}{suffix}"))).ok();
    }
    path
}

fn seeded(path: &std::path::Path, rows: usize) -> EmbeddedStore {
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let doc_writes: Vec<DocWrite> = (0..rows)
        .map(|i| DocWrite {
            table: "vals".into(),
            id: format!("r{i:08}"),
            data: r#"{"v":0}"#.into(),
            cols: vec![("v".into(), ColValue::Integer(i as i64))],
            creation_time: store.clock_read().unwrap(),
        })
        .collect();
    store
        .commit(
            WriteBatch {
                crdt_ops: Vec::new(),
                crdt_restores: vec![],
                local_field_writes: vec![],
                local_field_deletes: vec![],
                doc_writes,
                deletes: vec![],
                fresh_ids: vec![],
                data_only_ids: vec![],
                id_mappings: vec![],
                schedules: vec![],
            },
            &CommitOptions::remote(),
        )
        .unwrap();
    store
}

/// A raw turso connection to the db file the store just wrote (reads its WAL).
fn raw_conn(path: &std::path::Path) -> (Arc<dyn IO>, Arc<Database>, Arc<Connection>) {
    let io: Arc<dyn IO> = Arc::new(PlatformIO::new().unwrap());
    let db = Database::open_file_with_flags(
        io.clone(),
        path.to_str().unwrap(),
        OpenFlags::Create,
        DatabaseOpts::new().with_custom_types(true),
        None,
    )
    .unwrap();
    let conn = db.connect().unwrap();
    (io, db, conn)
}

fn rows(io: &Arc<dyn IO>, conn: &Arc<Connection>, sql: &str) -> Vec<Vec<String>> {
    let mut out = Vec::new();
    let mut stmt = conn.prepare(sql).unwrap();
    loop {
        match stmt.step().unwrap() {
            StepResult::Done => break,
            StepResult::IO | StepResult::Yield => {
                io.step().unwrap();
            }
            StepResult::Row => {
                let row = stmt.row().expect("row");
                out.push(
                    (0..stmt.num_columns())
                        .map(|i| text_of(row.get_value(i)))
                        .collect(),
                );
            }
            StepResult::Interrupt | StepResult::Busy => panic!("busy/interrupt on: {sql}"),
        }
    }
    out
}

fn text_of(v: &Value) -> String {
    match v {
        Value::Text(t) => t.as_str().to_owned(),
        other => format!("{other:?}"),
    }
}

/// The `detail` column (index 3) of every `EXPLAIN QUERY PLAN` row, joined.
fn plan(io: &Arc<dyn IO>, conn: &Arc<Connection>, sql: &str) -> String {
    rows(io, conn, &format!("EXPLAIN QUERY PLAN {sql}"))
        .into_iter()
        .map(|r| r.into_iter().last().unwrap_or_default())
        .collect::<Vec<_>>()
        .join(" / ")
}

#[test]
fn point_read_seeks_by_id_index() {
    let path = db_path("point");
    let store = seeded(&path, 5_000);
    assert!(store.doc_read("vals", "r00002500").unwrap().is_some());

    let (io, _db, conn) = raw_conn(&path);

    println!("\nindexes on doc__vals:");
    for r in rows(
        &io,
        &conn,
        "SELECT type, name FROM sqlite_master WHERE tbl_name = 'g1__doc__vals' AND type IN ('index','table') ORDER BY type, name",
    ) {
        println!("  {}", r.join("  "));
    }

    let read_sql = testkit::generation_sql(&testkit::read_doc_sql("vals"));
    let point = plan(&io, &conn, &read_sql);
    println!("\npoint read plan:\n  {read_sql}\n  -> {point}");

    let lower = point.to_lowercase();
    assert!(
        lower.contains("id=?") && lower.contains("identity_key=?"),
        "point read no longer seeks (identity_key, id): {point}"
    );
    assert!(
        !lower.contains("scan doc__vals"),
        "point read fell back to a table scan: {point}"
    );
}

#[test]
fn count_plans_stay_index_backed() {
    let path = db_path("count");
    let store = seeded(&path, 5_000);
    assert_eq!(
        store
            .doc_count_read(&CountSpec {
                table: "vals".into(),
                index: Some("by_v".into()),
                bounds: None,
            })
            .unwrap(),
        Some(5_000)
    );

    let (io, _db, conn) = raw_conn(&path);
    let table = schema().tables.into_iter().next().unwrap();
    let cases = [
        (
            "COUNT_NO_INDEX",
            CountSpec {
                table: "vals".into(),
                index: None,
                bounds: None,
            },
            None,
        ),
        (
            "COUNT_BY_V_ALL",
            CountSpec {
                table: "vals".into(),
                index: Some("by_v".into()),
                bounds: None,
            },
            Some("ix__vals__by_v"),
        ),
        (
            "COUNT_BY_V_SELECTIVE",
            CountSpec {
                table: "vals".into(),
                index: Some("by_v".into()),
                bounds: Some(vec![Bound::Range {
                    lower: Some(ColValue::Integer(2_000)),
                    lower_inclusive: true,
                    upper: Some(ColValue::Integer(2_050)),
                    upper_inclusive: false,
                }]),
            },
            Some("ix__vals__by_v"),
        ),
    ];

    for (label, spec, expected_index) in cases {
        let sql = testkit::generation_sql(&testkit::count_plan(&spec, &table).unwrap().sql);
        let p = plan(&io, &conn, &sql);
        println!("\n{label}:\n  {sql}\n  -> {p}");
        let lower = p.to_lowercase();
        assert!(
            !lower.contains("scan doc__vals"),
            "{label} count fell back to a table scan: {p}"
        );
        if let Some(index) = expected_index {
            assert!(
                lower.contains(index),
                "{label} did not use the requested index {index}: {p}"
            );
        }
    }
}

/// A store with the internal tables (and their secondary indexes) created but no rows. The turso
/// planner chooses an index from schema heuristics, not row counts (no `ANALYZE` is run), and the
/// `INDEXED BY` hint forces the choice regardless — so an empty store exercises the exact plan that
/// ships.
fn setup_only(path: &std::path::Path) -> EmbeddedStore {
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
}

#[test]
fn internal_point_reads_seek_pk_autoindex() {
    let path = db_path("internal");
    let store = setup_only(&path);
    drop(store);

    let (io, _db, conn) = raw_conn(&path);

    let cases = [
        (
            "READ_PROJECTION",
            testkit::generation_sql(testkit::read_projection_sql()),
            "g1__embedded_projections",
            &["identity_key=?", "table_name=?", "document_id=?"],
            "g1__idx__embedded_projections__seen",
        ),
        (
            "DELETE_PROJECTION_ROW",
            testkit::generation_sql(testkit::delete_projection_row_sql()),
            "g1__embedded_projections",
            &["identity_key=?", "table_name=?", "document_id=?"],
            "g1__idx__embedded_projections__seen",
        ),
    ];

    for (label, sql, table, keys, wrong_index) in cases {
        let autoindex = format!("sqlite_autoindex_{table}_1");
        let p = plan(&io, &conn, &sql);
        println!("\n{label}:\n  {sql}\n  -> {p}");
        let lower = p.to_lowercase();
        assert!(
            lower.contains(&autoindex),
            "{label} does not seek the PK auto-index {autoindex}: {p}"
        );
        for key in keys {
            assert!(
                lower.contains(key),
                "{label} no longer constrains {key} in the seek: {p}"
            );
        }
        assert!(
            !lower.contains(&wrong_index.to_lowercase()),
            "{label} still uses the mis-costed secondary index {wrong_index}: {p}"
        );
        assert!(
            !lower.contains(&format!("scan {table}")),
            "{label} fell back to a partition scan: {p}"
        );
    }
}

#[test]
fn deleted_id_mapping_read_seeks_the_deleted_partial_index() {
    let path = db_path("deleted-mapping");
    let _store = seeded(&path, 100);
    let (io, _db, conn) = raw_conn(&path);
    let read_sql = testkit::generation_sql(testkit::read_deleted_id_mappings_sql());
    let point = plan(&io, &conn, &read_sql);
    println!("\ndeleted-mapping read plan:\n  {read_sql}\n  -> {point}");
    let lower = point.to_lowercase();
    assert!(
        lower.contains("g1__ix__embedded_id_mappings__convex_deleted"),
        "deleted-mapping read does not seek the deleted partial index: {point}"
    );
}
