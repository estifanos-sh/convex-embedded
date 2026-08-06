#![cfg(feature = "testkit")]

use std::time::Instant;

use storage::testkit::{doc_writes, tmp_path};
use storage::{
    AuthoritativeRow, ColumnDef, CommitOptions, CommitSource, CountSpec, DocWrite, EmbeddedStore,
    RemoteMember, RemotePageWrite, ResultEntry, StoreSchema, TableDef, TablePlacement,
};

fn schema(indexed_value: bool) -> StoreSchema {
    StoreSchema {
        hash: if indexed_value { "b" } else { "a" }.repeat(64),
        setup_hash: String::new(),
        tables: vec![TableDef {
            name: "documents".to_owned(),
            placement: TablePlacement::Device,
            columns: if indexed_value {
                vec![ColumnDef {
                    name: "value".to_owned(),
                    field: None,
                }]
            } else {
                vec![]
            },
            crdt_fields: vec![],
            local_fields: vec![],
            indexes: vec![],
        }],
    }
}

fn result_schema() -> StoreSchema {
    StoreSchema {
        hash: "c".repeat(64),
        setup_hash: String::new(),
        tables: vec![TableDef {
            name: "issues".to_owned(),
            placement: TablePlacement::Replicated,
            columns: vec![],
            crdt_fields: vec![],
            local_fields: vec![],
            indexes: vec![],
        }],
    }
}

struct CandidateMigrationTiming {
    cold_ms: f64,
    copied_records: usize,
    copy_steps: usize,
    materialized_records: usize,
    materialize_steps: usize,
}

fn seed_candidate_stress_store(rows: usize) -> EmbeddedStore {
    let path = tmp_path(&format!("candidate_stress_{rows}.db"));
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema(false)).unwrap();
    let first = rows / 3;
    let second = rows * 2 / 3;
    for (identity, range) in [
        ("unauthenticated", 0..first),
        ("stress:a", first..second),
        ("stress:b", second..rows),
    ] {
        write_candidate_stress_partition(&store, identity, range);
    }
    store
}

fn write_candidate_stress_partition(
    store: &EmbeddedStore,
    identity: &str,
    range: std::ops::Range<usize>,
) {
    store.identity_write(identity, None).unwrap();
    let end_limit = range.end;
    for start in range.step_by(1_000) {
        let end = end_limit.min(start + 1_000);
        let writes = (start..end)
            .map(|index| DocWrite {
                table: "documents".to_owned(),
                id: format!("documents|{index:032x}"),
                data: format!(r#"{{"value":{index}}}"#),
                cols: vec![],
                creation_time: index as f64 + 1.0,
            })
            .collect();
        store
            .commit(
                doc_writes(writes),
                &CommitOptions {
                    source: CommitSource::Device,
                    ..CommitOptions::default()
                },
            )
            .unwrap();
    }
}

fn run_candidate_cold_migration(
    store: &EmbeddedStore,
    target: &StoreSchema,
) -> CandidateMigrationTiming {
    let cold_started = Instant::now();
    let candidate = store.migration_prepare(target).unwrap();
    assert!(candidate.required);
    let mut copy_steps = 0_usize;
    let mut copied_records = 0_usize;
    loop {
        let step = store
            .migration_copy_step(candidate.candidate_generation)
            .unwrap();
        copy_steps += 1;
        copied_records += step.records;
        if step.done {
            break;
        }
    }
    assert!(store
        .migration_queue_policy_write(
            candidate.candidate_generation,
            r#"{"collectComplete":true,"thresholds":[]}"#,
        )
        .unwrap());
    store
        .migration_finalize_prepare(target, candidate.candidate_generation)
        .unwrap();
    store
        .migration_bind_prepare(target, candidate.candidate_generation)
        .unwrap();
    let mut materialize_steps = 0_usize;
    let mut materialized_records = 0_usize;
    loop {
        let step = store
            .migration_materialize_step(candidate.candidate_generation)
            .unwrap();
        materialize_steps += 1;
        materialized_records += step.records;
        if step.done {
            break;
        }
    }
    store.migration_unbind().unwrap();
    store
        .migration_cutover(target, candidate.candidate_generation)
        .unwrap();
    CandidateMigrationTiming {
        cold_ms: cold_started.elapsed().as_secs_f64() * 1_000.0,
        copied_records,
        copy_steps,
        materialized_records,
        materialize_steps,
    }
}

fn result_path_projections(rows: usize) -> Vec<AuthoritativeRow> {
    (0..rows)
        .map(|index| {
            let server_id = format!("{index:032x}");
            AuthoritativeRow {
                table: "issues".to_owned(),
                local_document_id: None,
                server_document_id: server_id.clone(),
                plain_hash: format!("plain:{index}"),
                projection_hash: format!("projection:{index}"),
                current_root_id: None,
                current_node_id: None,
                row: Some(format!(
                    r#"{{"_id":"{server_id}","_creationTime":1,"value":{index}}}"#
                )),
                logical_clock: Some(index as f64),
                received_time: 1,
            }
        })
        .collect()
}

fn result_path_paths(rows: usize) -> Vec<u8> {
    serde_json::to_vec(
        &(0..rows)
            .map(|index| {
                serde_json::json!({
                    "path": format!("/items/{index}"),
                    "rowId": format!("{index:032x}"),
                    "table": "issues",
                })
            })
            .collect::<Vec<_>>(),
    )
    .unwrap()
}

#[test]
#[ignore = "release-only 1k/10k candidate throughput gate"]
fn candidate_cold_and_warm_stress_preserves_every_row() {
    let mut measurements = Vec::new();
    for rows in [1_000_usize, 10_000] {
        let store = seed_candidate_stress_store(rows);
        let first = rows / 3;
        let second = rows * 2 / 3;
        let target = schema(true);
        let timing = run_candidate_cold_migration(&store, &target);
        for (identity, expected) in [
            ("unauthenticated", first),
            ("stress:a", second - first),
            ("stress:b", rows - second),
        ] {
            store.identity_write(identity, None).unwrap();
            let count = store
                .doc_count_read(&CountSpec {
                    table: "documents".to_owned(),
                    ..CountSpec::default()
                })
                .unwrap();
            assert_eq!(count, Some(expected as i64));
        }

        let warm_started = Instant::now();
        let warm = store.migration_begin(&target).unwrap();
        assert!(!warm.required);
        store.setup(&target).unwrap();
        let warm_ms = warm_started.elapsed().as_secs_f64() * 1_000.0;
        let cold_budget_ms = if rows == 1_000 { 5_000.0 } else { 30_000.0 };
        assert!(
            timing.cold_ms < cold_budget_ms,
            "{rows}-row cold candidate took {:.2}ms",
            timing.cold_ms
        );
        assert!(
            warm_ms < 2_000.0,
            "{rows}-row warm open took {warm_ms:.2}ms"
        );
        assert!(
            timing.copied_records >= rows,
            "candidate copy omitted originated documents"
        );
        assert!(
            timing.materialized_records >= rows,
            "candidate materialization omitted originated documents"
        );
        assert_eq!(timing.copy_steps, timing.copied_records.div_ceil(512) + 1);
        assert_eq!(
            timing.materialize_steps,
            timing.materialized_records.div_ceil(512) + 1
        );
        eprintln!(
            "candidate_stress rows={rows} cold_ms={:.2} warm_ms={warm_ms:.2} copy_steps={} materialize_steps={} rows_per_second={:.0}",
            timing.cold_ms,
            timing.copy_steps,
            timing.materialize_steps,
            rows as f64 / (timing.cold_ms / 1_000.0)
        );
        measurements.push((rows, warm_ms));
    }
    let (_, small_warm_ms) = measurements[0];
    let (_, large_warm_ms) = measurements[1];
    assert!(
        large_warm_ms <= small_warm_ms * 15.0 + 5.0,
        "10k warm-open growth regressed beyond the checked 1k baseline"
    );
}

#[test]
#[ignore = "release-only 1k/10k result-path batching gate"]
fn result_only_cursor_updates_batch_projection_dependencies() {
    let mut measurements = Vec::new();
    for rows in [1_000_usize, 10_000] {
        let seed_started = Instant::now();
        let store = EmbeddedStore::open(
            tmp_path(&format!("result_path_stress_{rows}.db"))
                .to_str()
                .unwrap(),
        )
        .unwrap();
        store.setup(&result_schema()).unwrap();
        let projections = result_path_projections(rows);
        let paths = result_path_paths(rows);
        let result = |revision: usize| ResultEntry {
            key: "issues:result-only".to_owned(),
            function: "issues:list".to_owned(),
            args: "{}".to_owned(),
            schema_hash: "c".repeat(64),
            module_hash: "module".to_owned(),
            skeleton: br#"{"items":[]}"#.to_vec(),
            paths: paths.clone(),
            skeleton_hash: format!("skeleton:{revision}"),
            clock: revision as f64,
        };
        store
            .remote_page_write(&RemotePageWrite {
                subscription: "issues:result-only".to_owned(),
                members: (0..rows)
                    .map(|index| RemoteMember {
                        table: "issues".to_owned(),
                        server_document_id: format!("{index:032x}"),
                    })
                    .collect(),
                projections,
                crdt: vec![],
                blobs: vec![],
                cursor: Some("cursor:seed".to_owned()),
                received_time: 1,
                result: Some(Box::new(result(0))),
            })
            .unwrap();
        eprintln!(
            "result_path_stress rows={rows} projection_seed_ms={:.2}",
            seed_started.elapsed().as_secs_f64() * 1_000.0
        );
        store
            .remote_page_write(&RemotePageWrite {
                subscription: "issues:result-only".to_owned(),
                members: vec![],
                projections: vec![],
                crdt: vec![],
                blobs: vec![],
                cursor: Some("cursor:result-only".to_owned()),
                received_time: 2,
                result: Some(Box::new(result(0))),
            })
            .unwrap();
        eprintln!(
            "result_path_stress rows={rows} seed_ms={:.2}",
            seed_started.elapsed().as_secs_f64() * 1_000.0
        );

        let started = Instant::now();
        for revision in 1..=3 {
            store
                .remote_page_write(&RemotePageWrite {
                    subscription: "issues:result-only".to_owned(),
                    members: vec![],
                    projections: vec![],
                    crdt: vec![],
                    blobs: vec![],
                    cursor: Some(format!("cursor:{revision}")),
                    received_time: revision as i64 + 1,
                    result: Some(Box::new(result(revision))),
                })
                .unwrap();
        }
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        eprintln!("result_path_stress rows={rows} updates=3 elapsed_ms={elapsed_ms:.2}");
        measurements.push((rows, elapsed_ms));
    }
    let (_, small) = measurements[0];
    let (_, large) = measurements[1];
    assert!(
        large / 10_000.0 <= (small / 1_000.0) * 3.0,
        "10k per-path cursor validation regressed beyond 3x the checked 1k baseline"
    );
}
