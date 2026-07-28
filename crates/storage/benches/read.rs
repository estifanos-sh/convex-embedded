//! read — throughput of the indexed read paths (point lookup, one page, full keyset pagination,
//! exact count) over a seeded table. Run with `cargo bench -p storage --bench read`.

use criterion::{black_box, criterion_group, criterion_main, Criterion};
use storage::{
    Bound, ColValue, ColumnDef, CommitOptions, CountSpec, DocWrite, EmbeddedStore, IndexDef, Order,
    ReadSpec, StoreSchema, TableDef, TablePlacement, WriteBatch,
};

fn schema() -> StoreSchema {
    StoreSchema {
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

/// A store seeded with `rows` rows on the `by_v` index (non-`local` source — measure the read paths,
/// not local dirty-head writes).
fn seeded(rows: usize) -> EmbeddedStore {
    let name = format!("bench_read_{rows}.db");
    let path = std::env::temp_dir().join(&name);
    for suffix in ["", "-wal", "-shm"] {
        std::fs::remove_file(path.with_file_name(format!("{name}{suffix}"))).ok();
    }
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
                doc_writes,
                local_field_writes: vec![],
                local_field_deletes: vec![],
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

fn read_benches(c: &mut Criterion) {
    const ROWS: usize = 5_000;
    let store = seeded(ROWS);
    let spec = ReadSpec {
        table: "vals".into(),
        index: Some("by_v".into()),
        bounds: None,
        order: Order::Asc,
        page_size: Some(256),
        cursor: None,
        resume_after_key: None,
    };

    c.bench_function("read/point", |b| {
        b.iter(|| black_box(store.doc_read("vals", "r00002500").unwrap()));
    });

    c.bench_function("read/first_page_256", |b| {
        b.iter(|| black_box(store.doc_page_read(&spec).unwrap()));
    });

    c.bench_function("read/paginate_all_page256", |b| {
        b.iter(|| {
            let mut cursor: Option<String> = None;
            loop {
                let page = store
                    .doc_page_read(&ReadSpec {
                        cursor: cursor.clone(),
                        ..spec.clone()
                    })
                    .unwrap();
                match page.cursor {
                    Some(next) => cursor = Some(next),
                    None => break,
                }
            }
        });
    });

    let count = CountSpec {
        table: "vals".into(),
        index: Some("by_v".into()),
        bounds: None,
    };
    c.bench_function("read/count_all", |b| {
        b.iter(|| black_box(store.doc_count_read(&count).unwrap()));
    });

    let selective_count = CountSpec {
        table: "vals".into(),
        index: Some("by_v".into()),
        bounds: Some(vec![Bound::Range {
            lower: Some(ColValue::Integer(2_000)),
            lower_inclusive: true,
            upper: Some(ColValue::Integer(2_050)),
            upper_inclusive: false,
        }]),
    };
    c.bench_function("read/count_by_v_selective", |b| {
        b.iter(|| black_box(store.doc_count_read(&selective_count).unwrap()));
    });
}

criterion_group!(benches, read_benches);
criterion_main!(benches);
