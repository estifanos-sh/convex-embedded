//! doc — throughput of the local commit path (the real `source = "local"` write, which writes the
//! projection plus dirty-head state). Run with `cargo bench -p storage --bench doc`.

use criterion::{black_box, criterion_group, criterion_main, BatchSize, Criterion};
use storage::{
    ColValue, ColumnDef, CommitOptions, DocWrite, EmbeddedStore, IndexDef, StoreSchema, TableDef,
    TablePlacement, WriteBatch,
};

fn schema() -> StoreSchema {
    StoreSchema {
        hash: "0".repeat(64),
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

fn fresh() -> EmbeddedStore {
    let name = format!("bench_doc_{}.db", std::process::id());
    let path = std::env::temp_dir().join(&name);
    for suffix in ["", "-wal", "-shm"] {
        std::fs::remove_file(path.with_file_name(format!("{name}{suffix}"))).ok();
    }
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
}

fn batch(store: &EmbeddedStore, rows: usize) -> WriteBatch {
    batch_from(store, rows, 0)
}

fn batch_from(store: &EmbeddedStore, rows: usize, start: usize) -> WriteBatch {
    let doc_writes = (0..rows)
        .map(|i| doc_write_from(store, start + i))
        .collect();
    WriteBatch {
        crdt_ops: Vec::new(),
        crdt_restores: vec![],
        doc_writes,
        local_field_writes: vec![],
        local_field_deletes: vec![],
        deletes: vec![],
        fresh_ids: vec![],
        data_only_ids: vec![],
        commit_ts_doc_writes: vec![],
        commit_ts_local_field_writes: vec![],
        id_mappings: vec![],
        schedules: vec![],
    }
}

fn doc_write_from(store: &EmbeddedStore, index: usize) -> DocWrite {
    DocWrite {
        table: "vals".into(),
        id: format!("r{index:08}"),
        data: r#"{"v":0}"#.into(),
        cols: vec![("v".into(), ColValue::Integer(index as i64))],
        creation_time: store.clock_read().unwrap(),
    }
}

fn fresh_batch_from(store: &EmbeddedStore, rows: usize, start: usize) -> WriteBatch {
    let mut batch = batch_from(store, rows, start);
    batch.fresh_ids = batch
        .doc_writes
        .iter()
        .map(|doc_write| storage::RowKey {
            table: doc_write.table.clone(),
            document_id: doc_write.id.clone(),
        })
        .collect();
    batch
}

fn rewrite_batch(store: &EmbeddedStore, value: usize, data_only: bool) -> WriteBatch {
    WriteBatch {
        crdt_ops: Vec::new(),
        crdt_restores: vec![],
        doc_writes: vec![DocWrite {
            table: "vals".into(),
            id: "hot-row".into(),
            data: format!(r#"{{"v":{value}}}"#),
            cols: vec![("v".into(), ColValue::Integer(value as i64))],
            creation_time: store.clock_read().unwrap(),
        }],
        local_field_writes: vec![],
        local_field_deletes: vec![],
        deletes: vec![],
        fresh_ids: vec![],
        data_only_ids: if data_only {
            vec![storage::RowKey {
                table: "vals".into(),
                document_id: "hot-row".into(),
            }]
        } else {
            vec![]
        },
        commit_ts_doc_writes: vec![],
        commit_ts_local_field_writes: vec![],
        id_mappings: vec![],
        schedules: vec![],
    }
}

fn options(source: &str) -> CommitOptions {
    if source == "local" {
        CommitOptions::default()
    } else {
        CommitOptions::remote()
    }
}

fn options_no_changes(source: &str) -> CommitOptions {
    options(source).omit_changes()
}

#[allow(
    clippy::too_many_lines,
    reason = "all commit cases share one benchmark group and setup for comparable output"
)]
fn commit_benches(c: &mut Criterion) {
    c.bench_function("doc/commit_1_local", |b| {
        b.iter_batched(
            || {
                let store = fresh();
                let batch = batch(&store, 1);
                (store, batch)
            },
            |(store, batch)| black_box(store.commit(batch, &CommitOptions::default()).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_100_local", |b| {
        b.iter_batched(
            || {
                let store = fresh();
                let batch = batch(&store, 100);
                (store, batch)
            },
            |(store, batch)| black_box(store.commit(batch, &CommitOptions::default()).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_1_remote", |b| {
        b.iter_batched(
            || {
                let store = fresh();
                let batch = batch(&store, 1);
                (store, batch)
            },
            |(store, batch)| black_box(store.commit(batch, &options("remote")).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_100_remote", |b| {
        b.iter_batched(
            || {
                let store = fresh();
                let batch = batch(&store, 100);
                (store, batch)
            },
            |(store, batch)| black_box(store.commit(batch, &options("remote")).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_1_local_hot", |b| {
        let store = fresh();
        let mut next = 0usize;
        b.iter_batched(
            || {
                let batch = batch_from(&store, 1, next);
                next += 1;
                batch
            },
            |batch| black_box(store.commit(batch, &CommitOptions::default()).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_1_local_hot_fresh", |b| {
        let store = fresh();
        let mut next = 0usize;
        b.iter_batched(
            || {
                let batch = fresh_batch_from(&store, 1, next);
                next += 1;
                batch
            },
            |batch| black_box(store.commit(batch, &CommitOptions::default()).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_one_doc_write_local_hot_fresh", |b| {
        let store = fresh();
        let mut next = 0usize;
        b.iter_batched(
            || {
                let doc_write = doc_write_from(&store, next);
                next += 1;
                doc_write
            },
            |doc_write| {
                black_box(
                    store
                        .commit_one_doc_write(doc_write, &CommitOptions::default(), true, false)
                        .unwrap(),
                )
            },
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_one_doc_write_local_hot_fresh_no_changes", |b| {
        let store = fresh();
        let options = options_no_changes("local");
        let mut next = 0usize;
        b.iter_batched(
            || {
                let doc_write = doc_write_from(&store, next);
                next += 1;
                doc_write
            },
            |doc_write| {
                black_box(
                    store
                        .commit_one_doc_write(doc_write, &options, true, false)
                        .unwrap(),
                )
            },
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_1_remote_hot", |b| {
        let store = fresh();
        let mut next = 0usize;
        b.iter_batched(
            || {
                let batch = batch_from(&store, 1, next);
                next += 1;
                batch
            },
            |batch| black_box(store.commit(batch, &options("remote")).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_1_remote_rewrite_same_row", |b| {
        let store = fresh();
        store
            .commit(rewrite_batch(&store, 0, false), &options("remote"))
            .unwrap();
        let mut next = 1usize;
        b.iter_batched(
            || {
                let batch = rewrite_batch(&store, next, false);
                next += 1;
                batch
            },
            |batch| black_box(store.commit(batch, &options("remote")).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_1_local_rewrite_same_row_full_index", |b| {
        let store = fresh();
        store
            .commit(rewrite_batch(&store, 0, false), &options("remote"))
            .unwrap();
        let mut next = 1usize;
        b.iter_batched(
            || {
                let batch = rewrite_batch(&store, next, false);
                next += 1;
                batch
            },
            |batch| black_box(store.commit(batch, &CommitOptions::default()).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_1_local_rewrite_same_row_data_only", |b| {
        let store = fresh();
        store
            .commit(rewrite_batch(&store, 0, false), &options("remote"))
            .unwrap();
        let mut next = 1usize;
        b.iter_batched(
            || {
                let batch = rewrite_batch(&store, next, true);
                next += 1;
                batch
            },
            |batch| black_box(store.commit(batch, &CommitOptions::default()).unwrap()),
            BatchSize::SmallInput,
        );
    });

    c.bench_function("doc/commit_1_local_rewrite_same_row_already_dirty", |b| {
        let store = fresh();
        store
            .commit(rewrite_batch(&store, 0, false), &options("remote"))
            .unwrap();
        store
            .commit(rewrite_batch(&store, 1, true), &CommitOptions::default())
            .unwrap();
        let mut next = 2usize;
        b.iter_batched(
            || {
                let batch = rewrite_batch(&store, next, true);
                next += 1;
                batch
            },
            |batch| black_box(store.commit(batch, &CommitOptions::default()).unwrap()),
            BatchSize::SmallInput,
        );
    });
}

criterion_group!(benches, commit_benches);
criterion_main!(benches);
