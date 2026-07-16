//! sql — SQL/plan compilation shapes, reaching the `sql` module's internals through the
//! `storage::testkit` wrappers (which keep `Projection`/`ReadPlan` private). Run with
//! `--features testkit`.
#![cfg(feature = "testkit")]

use storage::testkit::{
    count_plan, create_commits, create_commits_mutation_index, create_doc_index, create_doc_table,
    page_plan, read_doc_sql, sql_table, write_doc,
};
use storage::{Bound, ColValue, CountSpec, Order, ReadSpec, StorageError};

#[test]
fn builds_schema_with_strict_tables_and_partial_indexes() {
    assert!(create_commits().starts_with("CREATE TABLE IF NOT EXISTS"));
    assert!(create_commits().ends_with(" STRICT"));
    assert!(create_commits_mutation_index().contains("WHERE \"mutation_id\" IS NOT NULL"));
    assert!(create_doc_table(&sql_table()).contains("\"data\" json NOT NULL"));
    assert!(create_doc_table(&sql_table()).ends_with(" STRICT"));
    assert!(create_doc_table(&sql_table()).contains("PRIMARY KEY (\"identity_key\", \"id\")"));
    assert_eq!(
        create_doc_index("issues", "by_id", &["id".to_owned()]).expect("by_id index compiles"),
        "CREATE INDEX IF NOT EXISTS \"ix__issues__by_id\" ON \"doc__issues\" (\"identity_key\", \"id\")"
    );
    let index = create_doc_index(
        "issues",
        "by_status_rank",
        &[
            "status".to_owned(),
            "rank".to_owned(),
            "creation_time_ms".to_owned(),
            "id".to_owned(),
        ],
    )
    .expect("index compiles");
    assert_eq!(
        index,
        "CREATE INDEX IF NOT EXISTS \"ix__issues__by_status_rank\" ON \"doc__issues\" (\"identity_key\", \"status\", \"rank\", \"creation_time_ms\", \"id\")"
    );
    assert!(matches!(
        create_doc_index("issues", "by_status_rank", &["select".to_owned()]),
        Err(StorageError::InvalidIdent(_))
    ));
}

#[test]
fn builds_doc_write_and_read_shapes() {
    let doc_write = write_doc(&sql_table());
    assert!(doc_write.starts_with("INSERT INTO doc__issues"));
    assert!(doc_write.contains("ON CONFLICT(identity_key, id) DO UPDATE SET"));
    assert!(doc_write.contains("creation_time_ms = excluded.creation_time_ms"));
    assert!(doc_write.contains("data = excluded.data"));
    assert!(doc_write.contains("status = excluded.status"));
    assert!(doc_write.contains("rank = excluded.rank"));
    assert_eq!(doc_write.matches('?').count(), 6);
    let read = read_doc_sql("issues");
    assert!(read.contains("FROM \"doc__issues\" INDEXED BY ix__issues__by_id"));
    assert_eq!(read.matches('?').count(), 2);
}

#[test]
fn builds_scan_and_count_shapes() {
    let spec = ReadSpec {
        table: "issues".to_owned(),
        index: Some("by_status_rank".to_owned()),
        bounds: Some(vec![
            Bound::Eq {
                value: ColValue::Text("open".to_owned()),
            },
            Bound::Range {
                lower: Some(ColValue::Integer(1)),
                lower_inclusive: true,
                upper: None,
                upper_inclusive: false,
            },
        ]),
        order: Order::Desc,
        cursor: None,
        resume_after_key: None,
        page_size: Some(8),
    };
    let scan = page_plan(&spec, &sql_table(), false).expect("scan compiles");
    assert!(scan.sql.contains("ORDER BY \"status\" DESC, \"rank\" DESC"));
    assert_eq!(scan.sql.matches('?').count(), 4);

    let resumed = page_plan(&spec, &sql_table(), true).expect("resume scan compiles");
    assert!(resumed.sql.matches('?').count() > scan.sql.matches('?').count());

    let count_spec = CountSpec {
        table: spec.table.clone(),
        index: spec.index.clone(),
        bounds: spec.bounds.clone(),
    };
    let count = count_plan(&count_spec, &sql_table()).expect("count compiles");
    assert!(count.exact);
    assert!(count.sql.contains("COUNT(*)"));
    assert_eq!(count.sql.matches('?').count(), 3);
}
