use crate::clock::Clock;
use crate::driver::fail_next_commit;
use crate::sql::{
    compile_count, compile_scan, create_commits, create_commits_mutation_index, create_doc_index,
    create_doc_table, decode_cursor, read_doc as read_doc_sql, upsert_doc, Projection,
};
use crate::{
    Bound, ColValue, ColumnDef, CommitOptions, CountSpec, DeleteIn, EmbeddedStore,
    IndexDef, MutationCall, Order, Page, ScanSpec, StorageError, StoreSchema, TableDef, UpsertIn,
    WriteBatch,
};

fn parse_docs(page: &Page) -> Vec<serde_json::Value> {
    serde_json::from_str(&page.text).expect("doc page text is valid JSON")
}

fn doc_ids(page: &Page) -> Vec<String> {
    parse_docs(page)
        .into_iter()
        .map(|doc| doc["_id"].as_str().expect("doc has _id").to_owned())
        .collect()
}

fn read_doc(store: &EmbeddedStore, table: &str, id: &str) -> Option<serde_json::Value> {
    store
        .doc_read(table, id)
        .unwrap()
        .map(|text| serde_json::from_str(&text).expect("doc text is valid JSON"))
}

fn commit(store: &EmbeddedStore, batch: WriteBatch) -> crate::CommitResult {
    store.commit(batch, &CommitOptions::default()).unwrap()
}

#[test]
fn clock_is_strictly_increasing_within_a_wall_instant() {
    let mut c = Clock::new();
    let a = c.now(1000.0);
    let b = c.now(1000.0);
    let d = c.now(1000.0);
    assert!((a - 1000.0).abs() < f64::EPSILON);
    assert!(a < b && b < d);
}

#[test]
fn clock_never_goes_backward_on_a_stepped_back_wall() {
    let mut c = Clock::new();
    let a = c.now(5000.0);
    let b = c.now(4000.0);
    assert!(b > a);
}

#[test]
fn clock_observe_floors_to_the_high_water_mark() {
    let mut c = Clock::new();
    c.observe(9000.0);
    assert!(c.now(1000.0) >= 9000.0);
}

fn tmp_path(name: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(name);
    for suffix in ["", "-wal", "-shm"] {
        std::fs::remove_file(p.with_file_name(format!("{name}{suffix}"))).ok();
    }
    p
}

fn schema() -> StoreSchema {
    StoreSchema {
        tables: vec![
            TableDef {
                name: "issues".into(),
                columns: vec![ColumnDef {
                    name: "status".into(),
                    field: None,
                }],
                indexes: vec![IndexDef {
                    name: "by_status".into(),
                    fields: vec!["status".into()],
                    columns: None,
                }],
            },
            TableDef {
                name: "t".into(),
                columns: vec![],
                indexes: vec![],
            },
        ],
    }
}

fn bool_schema() -> StoreSchema {
    StoreSchema {
        tables: vec![TableDef {
            name: "flags".into(),
            columns: vec![ColumnDef {
                name: "active".into(),
                field: None,
            }],
            indexes: vec![IndexDef {
                name: "by_active".into(),
                fields: vec!["active".into()],
                columns: None,
            }],
        }],
    }
}

fn alias_schema() -> StoreSchema {
    StoreSchema {
        tables: vec![TableDef {
            name: "users".into(),
            columns: vec![ColumnDef {
                name: "idx_profile_email".into(),
                field: Some("profile.email".into()),
            }],
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

fn sql_table() -> TableDef {
    TableDef {
        name: "issues".to_owned(),
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
        indexes: vec![IndexDef {
            columns: None,
            fields: vec!["status".to_owned(), "rank".to_owned()],
            name: "by_status_rank".to_owned(),
        }],
    }
}

#[test]
fn builds_schema_with_strict_tables_and_partial_indexes() {
    assert!(create_commits().starts_with("CREATE TABLE IF NOT EXISTS"));
    assert!(create_commits().ends_with(" STRICT"));
    assert!(create_commits_mutation_index().contains("WHERE \"mutation_id\" IS NOT NULL"));
    assert!(create_doc_table(&sql_table()).contains("\"data\" json NOT NULL"));
    assert!(create_doc_table(&sql_table()).ends_with(" STRICT"));
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
        "CREATE INDEX IF NOT EXISTS ix__issues__by_status_rank ON doc__issues (identity_key, status, rank, creation_time_ms, id)"
    );
    assert!(!index.contains('"'));
    assert!(matches!(
        create_doc_index("issues", "by_status_rank", &["select".to_owned()]),
        Err(StorageError::InvalidIdent(_))
    ));
}

#[test]
fn builds_doc_upsert_and_read_shapes() {
    let upsert = upsert_doc(&sql_table());
    assert!(upsert.starts_with("REPLACE INTO \"doc__issues\""));
    assert_eq!(upsert.matches('?').count(), 6);
    let read = read_doc_sql("issues");
    assert!(read.contains("FROM \"doc__issues\""));
    assert_eq!(read.matches('?').count(), 2);
}

#[test]
fn builds_scan_and_count_shapes() {
    let spec = ScanSpec {
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
    let scan =
        compile_scan(&spec, &sql_table(), Projection::Docs, false).expect("scan compiles");
    assert!(scan.sql.contains("ORDER BY \"status\" DESC, \"rank\" DESC"));
    // identity_key + eq(status) + gte(rank) + LIMIT.
    assert_eq!(scan.sql.matches('?').count(), 4);

    let resumed =
        compile_scan(&spec, &sql_table(), Projection::Docs, true).expect("resume scan compiles");
    // Adds the keyset predicate over the four order columns plus the leading sargable bound.
    assert!(resumed.sql.matches('?').count() > scan.sql.matches('?').count());

    let count_spec = CountSpec {
        table: spec.table.clone(),
        index: spec.index.clone(),
        bounds: spec.bounds.clone(),
    };
    let count = compile_count(&count_spec, &sql_table()).expect("count compiles");
    assert!(count.exact);
    assert!(count.sql.contains("COUNT(*)"));
    assert_eq!(count.sql.matches('?').count(), 3);
}

fn user(store: &EmbeddedStore, id: &str, email: &str) -> UpsertIn {
    UpsertIn {
        table: "users".into(),
        id: id.into(),
        data: format!(r#"{{"profile":{{"email":"{email}"}}}}"#),
        cols: vec![("idx_profile_email".into(), ColValue::Text(email.into()))],
        creation_time: store.clock_next().unwrap(),
    }
}

fn user_without_email(store: &EmbeddedStore, id: &str) -> UpsertIn {
    UpsertIn {
        table: "users".into(),
        id: id.into(),
        data: r#"{"profile":{}}"#.into(),
        cols: vec![],
        creation_time: store.clock_next().unwrap(),
    }
}

fn issue(store: &EmbeddedStore, id: &str, title: &str, status: &str) -> UpsertIn {
    UpsertIn {
        table: "issues".into(),
        id: id.into(),
        data: format!(r#"{{"title":"{title}"}}"#),
        cols: vec![("status".into(), ColValue::Text(status.into()))],
        creation_time: store.clock_next().unwrap(),
    }
}

fn flag(store: &EmbeddedStore, id: &str, active: ColValue) -> UpsertIn {
    UpsertIn {
        table: "flags".into(),
        id: id.into(),
        data: r#"{"active":true}"#.into(),
        cols: vec![("active".into(), active)],
        creation_time: store.clock_next().unwrap(),
    }
}

fn upserts(rows: Vec<UpsertIn>) -> WriteBatch {
    WriteBatch {
        upserts: rows,
        deletes: vec![],
    }
}

/// Walk an entire scan through its cursor chain at the given page size, returning every id in
/// page order and asserting page-size invariants along the way.
fn paged_ids(store: &EmbeddedStore, spec: &ScanSpec, page_size: usize) -> Vec<String> {
    let mut ids = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = store
            .doc_scan(&ScanSpec {
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

#[test]
fn round_trips_and_persists() {
    let path = tmp_path("rs_roundtrip.db");
    let p = path.to_str().unwrap();

    let first_ct;
    {
        let store = EmbeddedStore::open(p).unwrap();
        store.setup(&schema()).unwrap();
        let up = issue(&store, "i1", "hello", "open");
        first_ct = up.creation_time;
        commit(&store, upserts(vec![up]));

        let got = read_doc(&store, "issues", "i1").expect("row");
        assert_eq!(got["_id"], "i1");
        assert!(got["_creationTime"].as_f64().expect("real").is_finite());
        assert_eq!(got["title"], "hello");
        assert!(store.doc_read("issues", "missing").unwrap().is_none());
    }

    let store = EmbeddedStore::open(p).unwrap();
    store.setup(&schema()).unwrap();
    assert_eq!(
        read_doc(&store, "issues", "i1").expect("persists across reopen")["_id"],
        "i1"
    );

    let up2 = issue(&store, "i2", "world", "open");
    let second_ct = up2.creation_time;
    commit(&store, upserts(vec![up2]));
    // The clock recovered the high-water mark on reopen, so the second write is strictly later.
    assert!(second_ct > first_ct);

    let all = store
        .doc_scan(&ScanSpec {
            table: "issues".into(),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&all).len(), 2);
    assert!(all.cursor.is_none());
}

#[test]
fn setup_resets_when_format_version_changes() {
    let store = EmbeddedStore::open(tmp_path("rs_format_reset.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(&store, upserts(vec![issue(&store, "i1", "First", "open")]));
    assert!(read_doc(&store, "issues", "i1").is_some());

    // Simulate a database written by an older, incompatible on-disk format.
    store.force_user_version_for_test(0);
    store.setup(&schema()).unwrap();

    // The version mismatch drops and recreates every table, so prior data is gone...
    assert!(read_doc(&store, "issues", "i1").is_none());
    // ...and the recreated tables accept writes in the current order-key BLOB format.
    commit(&store, upserts(vec![issue(&store, "i2", "Second", "closed")]));
    assert!(read_doc(&store, "issues", "i2").is_some());
}

#[test]
fn setup_preserves_data_when_format_version_matches() {
    let store = EmbeddedStore::open(tmp_path("rs_format_match.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(&store, upserts(vec![issue(&store, "i1", "First", "open")]));

    // A second setup with the version already current must not wipe data.
    store.setup(&schema()).unwrap();
    assert!(read_doc(&store, "issues", "i1").is_some());
}

#[test]
fn identity_keys_are_isolated() {
    let path = tmp_path("rs_identity.db");
    let p = path.to_str().unwrap();
    let a = EmbeddedStore::open_with_identity_key(p, "a").unwrap();
    let b = EmbeddedStore::open_with_identity_key(p, "b").unwrap();
    a.setup(&schema()).unwrap();
    b.setup(&schema()).unwrap();

    commit(&a, upserts(vec![issue(&a, "same", "A", "open")]));
    commit(&b, upserts(vec![issue(&b, "same", "B", "closed")]));

    assert_eq!(read_doc(&a, "issues", "same").expect("a row")["title"], "A");
    assert_eq!(read_doc(&b, "issues", "same").expect("b row")["title"], "B");
}

#[test]
fn concurrent_writers_for_same_identity_are_serialized() {
    let path = tmp_path("rs_concurrent_same_identity.db");
    let p = path.to_string_lossy().into_owned();
    let store = EmbeddedStore::open_with_identity_key(&p, "same").unwrap();
    store.setup(&schema()).unwrap();
    drop(store);

    let handles: Vec<_> = (0..6)
        .map(|i| {
            let p = p.clone();
            std::thread::spawn(move || {
                let store = EmbeddedStore::open_with_identity_key(&p, "same").unwrap();
                store.setup(&schema()).unwrap();
                commit(&store, upserts(vec![issue(
                        &store,
                        &format!("i{i}"),
                        &format!("issue {i}"),
                        "open",
                    )]));
            })
        })
        .collect();

    for handle in handles {
        handle.join().unwrap();
    }

    let store = EmbeddedStore::open_with_identity_key(&p, "same").unwrap();
    store.setup(&schema()).unwrap();
    let all = store
        .doc_scan(&ScanSpec {
            table: "issues".into(),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&all).len(), 6);
}

#[test]
fn setup_rejects_invalid_and_reserved_schema_names() {
    let store = EmbeddedStore::open(tmp_path("rs_idents.db").to_str().unwrap()).unwrap();
    for name in ["issues; DROP TABLE x", "", "1abc"] {
        let bad = StoreSchema {
            tables: vec![TableDef {
                name: name.into(),
                columns: vec![],
                indexes: vec![],
            }],
        };
        assert!(matches!(
            store.setup(&bad),
            Err(StorageError::InvalidIdent(_))
        ));
    }
    let reserved = StoreSchema {
        tables: vec![TableDef {
            name: "issues".into(),
            columns: vec![ColumnDef {
                name: "data".into(),
                field: None,
            }],
            indexes: vec![],
        }],
    };
    assert!(matches!(
        store.setup(&reserved),
        Err(StorageError::ReservedColumn(name)) if name == "data"
    ));
}

#[test]
fn commit_applies_mixed_batch_and_rolls_back_failed_writes() {
    let store = EmbeddedStore::open(tmp_path("rs_commit.db").to_str().unwrap()).unwrap();
    store.setup(&bool_schema()).unwrap();
    commit(&store, upserts(vec![
            flag(&store, "keep", ColValue::Bool(true)),
            flag(&store, "remove", ColValue::Bool(false)),
        ]));
    commit(
        &store,
        WriteBatch {
            upserts: vec![flag(&store, "new", ColValue::Bool(true))],
            deletes: vec![DeleteIn {
                table: "flags".into(),
                id: "remove".into(),
            }],
        },
    );
    assert!(store.doc_read("flags", "new").unwrap().is_some());
    assert!(store.doc_read("flags", "remove").unwrap().is_none());

    // Index columns are order-key BLOBs, so a value of any type is accepted (Convex parity:
    // a union/mixed-type indexed field is legal). What used to be a STRICT type rejection now
    // succeeds. Rollback is covered by `commit_failure_rolls_back_before_checking_commit_existence`
    // and `duplicate_mutation_id_rolls_back_second_batch`.
    commit(
        &store,
        upserts(vec![flag(&store, "mixed", ColValue::Text("not-an-integer".into()))]),
    );
    assert!(store.doc_read("flags", "mixed").unwrap().is_some());
}

#[test]
fn duplicate_mutation_id_rolls_back_second_batch() {
    let store = EmbeddedStore::open(tmp_path("rs_mutation_id.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .mutation_begin(&MutationCall {
            args: "{}".into(),
            mutation_id: "mutation-1".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    let options = CommitOptions {
        mutation_id: Some("mutation-1".into()),
        ..CommitOptions::default()
    };

    store
        .commit(
            upserts(vec![issue(&store, "first", "first", "open")]),
            &options,
        )
        .unwrap();
    let duplicate = store.commit(
        upserts(vec![issue(&store, "second", "second", "open")]),
        &options,
    );

    assert!(matches!(duplicate, Err(StorageError::Turso(_))));
    assert!(store.doc_read("issues", "first").unwrap().is_some());
    assert!(store.doc_read("issues", "second").unwrap().is_none());
}

#[test]
fn mutation_id_commit_requires_accepted_record() {
    let store = EmbeddedStore::open(tmp_path("rs_unbegun_mutation.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let err = store.commit(
        upserts(vec![issue(&store, "missing", "missing", "open")]),
        &CommitOptions {
            mutation_id: Some("mutation-missing".into()),
            ..CommitOptions::default()
        },
    );

    assert!(matches!(err, Err(StorageError::Unsatisfiable(_))));
    assert!(store.doc_read("issues", "missing").unwrap().is_none());
}

#[test]
fn commit_failure_rolls_back_before_checking_commit_existence() {
    let store = EmbeddedStore::open(tmp_path("rs_commit_fail.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    fail_next_commit();
    let failed = store.commit(
        upserts(vec![issue(&store, "phantom", "phantom", "open")]),
        &CommitOptions::default(),
    );
    assert!(matches!(failed, Err(StorageError::Turso(_))));
    assert!(store.doc_read("issues", "phantom").unwrap().is_none());

    commit(&store, upserts(vec![issue(&store, "after", "after", "open")]));
    assert!(store.doc_read("issues", "after").unwrap().is_some());
}

#[test]
fn scans_by_index_bound_and_counts() {
    let store = EmbeddedStore::open(tmp_path("rs_index.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(&store, upserts(vec![
            issue(&store, "a", "A", "open"),
            issue(&store, "b", "B", "closed"),
            issue(&store, "c", "C", "open"),
        ]));

    let only_open = store
        .doc_scan(&ScanSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Text("open".into()),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&only_open), vec!["a", "c"]);

    assert_eq!(
        store
            .doc_count(&CountSpec {
                table: "issues".into(),
                ..Default::default()
            })
            .unwrap(),
        Some(3)
    );
    assert_eq!(
        store
            .doc_count(&CountSpec {
                table: "issues".into(),
                index: Some("by_status".into()),
                bounds: Some(vec![Bound::Eq {
                    value: ColValue::Text("open".into()),
                }]),
            })
            .unwrap(),
        Some(2)
    );
}

#[test]
fn scans_boolean_index_values() {
    let store = EmbeddedStore::open(tmp_path("rs_bool.db").to_str().unwrap()).unwrap();
    store.setup(&bool_schema()).unwrap();
    commit(&store, upserts(vec![
            UpsertIn {
                table: "flags".into(),
                id: "yes".into(),
                data: r#"{"active":true}"#.into(),
                cols: vec![("active".into(), ColValue::Bool(true))],
                creation_time: store.clock_next().unwrap(),
            },
            UpsertIn {
                table: "flags".into(),
                id: "no".into(),
                data: r#"{"active":false}"#.into(),
                cols: vec![("active".into(), ColValue::Bool(false))],
                creation_time: store.clock_next().unwrap(),
            },
        ]));

    let active = store
        .doc_scan(&ScanSpec {
            table: "flags".into(),
            index: Some("by_active".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Bool(true),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&active), vec!["yes"]);
}

#[test]
fn plans_convex_fields_through_storage_columns() {
    let store = EmbeddedStore::open(tmp_path("rs_aliases.db").to_str().unwrap()).unwrap();
    store.setup(&alias_schema()).unwrap();
    let first = user(&store, "users|a", "a@example.com");
    let first_creation_time = first.creation_time;
    commit(&store, upserts(vec![
            first,
            user(&store, "users|b", "b@example.com"),
        ]));

    let by_email = store
        .doc_scan(&ScanSpec {
            table: "users".into(),
            index: Some("by_email".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Text("b@example.com".into()),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_email), vec!["users|b"]);

    let by_creation_time = store
        .doc_scan(&ScanSpec {
            table: "users".into(),
            index: Some("by_creation_time".into()),
            bounds: Some(vec![Bound::Range {
                lower: Some(ColValue::Real(first_creation_time)),
                lower_inclusive: true,
                upper: None,
                upper_inclusive: false,
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_creation_time), vec!["users|a", "users|b"]);

    let by_id = store
        .doc_scan(&ScanSpec {
            table: "users".into(),
            index: Some("by_id".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Text("users|a".into()),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_id), vec!["users|a"]);
}

#[test]
fn scans_are_total_with_exact_null_and_undefined() {
    let store = EmbeddedStore::open(tmp_path("rs_total.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let missing = UpsertIn {
        table: "issues".into(),
        id: "missing".into(),
        data: r#"{"title":"M"}"#.into(),
        cols: vec![], // status absent → ColValue::Undefined
        creation_time: store.clock_next().unwrap(),
    };
    let explicit_null = UpsertIn {
        table: "issues".into(),
        id: "null".into(),
        data: r#"{"title":"N","status":null}"#.into(),
        cols: vec![("status".into(), ColValue::Null)],
        creation_time: store.clock_next().unwrap(),
    };
    commit(
        &store,
        upserts(vec![issue(&store, "open", "O", "open"), missing, explicit_null]),
    );

    let unknown = store.doc_scan(&ScanSpec {
        table: "issues".into(),
        index: Some("nope".into()),
        order: Order::Asc,
        ..Default::default()
    });
    assert!(matches!(unknown, Err(StorageError::Unsatisfiable(_))));

    // eq(Null) is exact: it matches only the explicit null, never the missing field or "open".
    let by_null = store
        .doc_scan(&ScanSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Null,
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_null), vec!["null"]);

    // eq(Undefined) matches only the missing field — distinct from null (Convex orders
    // undefined < null).
    let by_undefined = store
        .doc_scan(&ScanSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Undefined,
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_undefined), vec!["missing"]);

    // Counts are exact now (every value encodes to an exact order key — no widening).
    let null_count = store
        .doc_count(&CountSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Null,
            }]),
        })
        .unwrap();
    assert_eq!(null_count, Some(1));

    let err = store.doc_scan(&ScanSpec {
        table: "issues".into(),
        order: Order::Asc,
        page_size: Some(40_000),
        ..Default::default()
    });
    assert!(matches!(err, Err(StorageError::Unsatisfiable(_))));
}

#[test]
fn paged_scans_walk_the_cursor_chain() {
    let store = EmbeddedStore::open(tmp_path("rs_paging.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let rows: Vec<UpsertIn> = (0..10)
        .map(|i| {
            issue(
                &store,
                &format!("i{i}"),
                &format!("issue {i}"),
                if i % 2 == 0 { "open" } else { "closed" },
            )
        })
        .collect();
    commit(&store, upserts(rows));

    let full = |order: Order| {
        doc_ids(
            &store
                .doc_scan(&ScanSpec {
                    table: "issues".into(),
                    order,
                    ..Default::default()
                })
                .unwrap(),
        )
    };

    for order in [Order::Asc, Order::Desc] {
        let spec = ScanSpec {
            table: "issues".into(),
            order,
            ..Default::default()
        };
        for page_size in [1, 3, 10, 11] {
            assert_eq!(paged_ids(&store, &spec, page_size), full(order));
        }
    }

    let bounded = ScanSpec {
        table: "issues".into(),
        index: Some("by_status".into()),
        bounds: Some(vec![Bound::Eq {
            value: ColValue::Text("open".into()),
        }]),
        order: Order::Asc,
        ..Default::default()
    };
    assert_eq!(
        paged_ids(&store, &bounded, 2),
        vec!["i0", "i2", "i4", "i6", "i8"]
    );
}

#[test]
fn paged_scans_handle_null_key_columns() {
    let store = EmbeddedStore::open(tmp_path("rs_paging_nulls.db").to_str().unwrap()).unwrap();
    store.setup(&alias_schema()).unwrap();
    let mut rows = Vec::new();
    for i in 0..4 {
        rows.push(user_without_email(&store, &format!("users|n{i}")));
    }
    for i in 0..4 {
        rows.push(user(&store, &format!("users|e{i}"), &format!("u{i}@x.com")));
    }
    commit(&store, upserts(rows));

    for order in [Order::Asc, Order::Desc] {
        let spec = ScanSpec {
            table: "users".into(),
            index: Some("by_email".into()),
            order,
            ..Default::default()
        };
        let full = doc_ids(&store.doc_scan(&spec).unwrap());
        assert_eq!(full.len(), 8);
        for page_size in [1, 3, 5] {
            assert_eq!(paged_ids(&store, &spec, page_size), full, "{order:?}");
        }
    }
}

#[test]
fn cursors_reject_a_different_scan_shape_and_resume_after_key_works() {
    let store = EmbeddedStore::open(tmp_path("rs_cursor_shape.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(&store, upserts(vec![
            issue(&store, "a", "A", "open"),
            issue(&store, "b", "B", "open"),
            issue(&store, "c", "C", "open"),
        ]));

    let spec = ScanSpec {
        table: "issues".into(),
        order: Order::Asc,
        page_size: Some(2),
        ..Default::default()
    };
    let first = store.doc_scan(&spec).unwrap();
    let cursor = first.cursor.clone().expect("has next page");

    let mismatched = store.doc_scan(&ScanSpec {
        order: Order::Desc,
        cursor: Some(cursor.clone()),
        ..spec.clone()
    });
    assert!(matches!(mismatched, Err(StorageError::InvalidCursor(_))));

    let docs = parse_docs(&first);
    let last = docs.last().unwrap();
    let resumed = store
        .doc_scan(&ScanSpec {
            cursor: None,
            resume_after_key: Some(vec![
                ColValue::Real(last["_creationTime"].as_f64().unwrap()),
                ColValue::Text(last["_id"].as_str().unwrap().to_owned()),
            ]),
            ..spec.clone()
        })
        .unwrap();
    assert_eq!(doc_ids(&resumed), vec!["c"]);
    assert!(resumed.cursor.is_none());

    let both = store.doc_scan(&ScanSpec {
        cursor: Some(cursor),
        resume_after_key: Some(vec![ColValue::Null, ColValue::Null]),
        ..spec
    });
    assert!(matches!(both, Err(StorageError::InvalidCursor(_))));
}

#[test]
fn malformed_cursors_return_errors_instead_of_panicking() {
    let bad_tag_boundary = decode_cursor("ec1:1:xé", "x");
    assert!(matches!(
        bad_tag_boundary,
        Err(StorageError::InvalidCursor(_))
    ));

    let bad_real_boundary = decode_cursor("ec1:1:xf000000000000000é", "x");
    assert!(matches!(
        bad_real_boundary,
        Err(StorageError::InvalidCursor(_))
    ));
}

#[test]
fn prune_ledger_retains_the_newest_commit() {
    let store = EmbeddedStore::open(tmp_path("rs_prune.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    for i in 0..3 {
        commit(&store, upserts(vec![issue(&store, &format!("i{i}"), "t", "open")]));
    }

    let pruned = store.ledger_prune(i64::MAX).unwrap();
    assert_eq!(pruned.commits_deleted, 2);

    let next = commit(&store, upserts(vec![issue(&store, "i3", "t", "open")]));
    assert_eq!(next.commit_seq, 4);

    assert_eq!(store.ledger_prune(0).unwrap().commits_deleted, 0);
}

#[test]
fn prune_ledger_removes_committed_mutations_only() {
    let store = EmbeddedStore::open(tmp_path("rs_prune_mut.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .mutation_begin(&MutationCall {
            args: "{}".into(),
            mutation_id: "committed".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    store
        .commit(
            upserts(vec![issue(&store, "i0", "t", "open")]),
            &CommitOptions {
                mutation_id: Some("committed".into()),
                ..CommitOptions::default()
            },
        )
        .unwrap();
    store
        .mutation_begin(&MutationCall {
            args: "{}".into(),
            mutation_id: "accepted".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    commit(&store, upserts(vec![issue(&store, "i1", "t", "open")]));

    let pruned = store.ledger_prune(i64::MAX).unwrap();
    assert_eq!(pruned.commits_deleted, 1);
    assert_eq!(pruned.mutations_deleted, 1);

    let record = store
        .mutation_begin(&MutationCall {
            args: "{}".into(),
            mutation_id: "accepted".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    assert_eq!(record.mutation_id, "accepted");
}

#[test]
fn clear_removes_docs_ledger_and_blobs_for_the_identity() {
    let store = EmbeddedStore::open(tmp_path("rs_clear_all.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .mutation_begin(&MutationCall {
            args: "{}".into(),
            mutation_id: "m1".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    store.blob_write("frame", vec![1, 2, 3]).unwrap();
    store
        .commit(
            upserts(vec![issue(&store, "i1", "t", "open")]),
            &CommitOptions {
                mutation_id: Some("m1".into()),
                mutation_result: Some("\"ok\"".into()),
                ..CommitOptions::default()
            },
        )
        .unwrap();

    store.clear().unwrap();

    assert!(read_doc(&store, "issues", "i1").is_none());
    assert!(store.blob_read("frame").unwrap().is_none());
    let replay = store
        .mutation_begin(&MutationCall {
            args: "{}".into(),
            mutation_id: "m1".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    assert_eq!(replay.status, crate::MutationStatus::Accepted);
    let next = commit(&store, upserts(vec![issue(&store, "i2", "t", "open")]));
    assert_eq!(next.commit_seq, 1);
}

#[test]
fn blobs_round_trip() {
    let store = EmbeddedStore::open(tmp_path("rs_blobs.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    assert!(store.blob_read("missing").unwrap().is_none());
    let bytes: Vec<u8> = (0..=255).collect();
    store.blob_write("frame", bytes.clone()).unwrap();
    assert_eq!(store.blob_read("frame").unwrap(), Some(bytes));

    store.blob_write("frame", vec![1, 2, 3]).unwrap();
    assert_eq!(store.blob_read("frame").unwrap(), Some(vec![1, 2, 3]));

    store.blob_delete("frame").unwrap();
    assert!(store.blob_read("frame").unwrap().is_none());
}

#[test]
fn splices_empty_documents_without_a_trailing_comma() {
    let store = EmbeddedStore::open(tmp_path("rs_splice_empty.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(
        &store,
        upserts(vec![UpsertIn {
            table: "t".into(),
            id: "empty".into(),
            data: "{}".into(),
            cols: vec![],
            creation_time: store.clock_next().unwrap(),
        }]),
    );

    let doc = read_doc(&store, "t", "empty").expect("row");
    assert_eq!(doc["_id"], "empty");
    assert_eq!(doc.as_object().unwrap().len(), 2);

    let page = store
        .doc_scan(&ScanSpec {
            table: "t".into(),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&page), vec!["empty"]);
}

#[test]
fn splices_ids_that_need_json_escaping() {
    let store = EmbeddedStore::open(tmp_path("rs_splice_escape.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let id = "t|quote\"back\\slash\u{1}end";
    commit(
        &store,
        upserts(vec![UpsertIn {
            table: "t".into(),
            id: id.into(),
            data: r#"{"v":1}"#.into(),
            cols: vec![],
            creation_time: store.clock_next().unwrap(),
        }]),
    );

    let doc = read_doc(&store, "t", id).expect("row");
    assert_eq!(doc["_id"], id);
    let page = store
        .doc_scan(&ScanSpec {
            table: "t".into(),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&page), vec![id]);
}

#[test]
fn creation_times_round_trip_exactly_through_page_text() {
    let store = EmbeddedStore::open(tmp_path("rs_splice_f64.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    // Awkward doubles: fractional clock ticks and values needing every significand digit.
    let times = [1_749_740_000_000.0 + 1.0 / 128.0, 0.1 + 0.2, 1_234_567_890_123.456_7];
    for (i, ct) in times.iter().enumerate() {
        commit(
            &store,
            upserts(vec![UpsertIn {
                table: "t".into(),
                id: format!("f{i}"),
                data: "{}".into(),
                cols: vec![],
                creation_time: *ct,
            }]),
        );
    }

    for (i, ct) in times.iter().enumerate() {
        let doc = read_doc(&store, "t", &format!("f{i}")).expect("row");
        let parsed = doc["_creationTime"].as_f64().expect("real");
        assert_eq!(parsed.to_bits(), ct.to_bits(), "f{i}");
    }
}

#[test]
fn rejects_corrupt_non_object_data_when_splicing() {
    let store = EmbeddedStore::open(tmp_path("rs_splice_corrupt.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(
        &store,
        upserts(vec![UpsertIn {
            table: "t".into(),
            id: "bad".into(),
            data: "[1]".into(),
            cols: vec![],
            creation_time: store.clock_next().unwrap(),
        }]),
    );

    assert!(matches!(
        store.doc_read("t", "bad"),
        Err(StorageError::Decode { .. })
    ));
}

fn vals_schema() -> StoreSchema {
    StoreSchema {
        tables: vec![TableDef {
            name: "vals".into(),
            columns: vec![ColumnDef {
                name: "v".into(),
                field: None,
            }],
            indexes: vec![IndexDef {
                name: "by_v".into(),
                fields: vec!["v".into()],
                columns: None,
            }],
        }],
    }
}

#[test]
fn order_key_matches_convex_total_order() {
    let store = EmbeddedStore::open(tmp_path("rs_orderkey.db").to_str().unwrap()).unwrap();
    store.setup(&vals_schema()).unwrap();

    // (id, value) in EXACT ascending Convex order: undefined < null < all int64 < all float64
    // (with -0 < +0 and NaN after +Inf) < boolean (false < true) < string.
    let ordered: Vec<(&str, Option<ColValue>)> = vec![
        ("00_undef", None),
        ("01_null", Some(ColValue::Null)),
        ("02_int_neg", Some(ColValue::Integer(-5))),
        ("03_int_pos", Some(ColValue::Integer(10))),
        ("04_real_negzero", Some(ColValue::Real(-0.0))),
        ("05_real_zero", Some(ColValue::Real(0.0))),
        ("06_real_small", Some(ColValue::Real(1.5))),
        ("07_real_inf", Some(ColValue::Real(f64::INFINITY))),
        ("08_real_nan", Some(ColValue::Real(f64::NAN))),
        ("09_bool_false", Some(ColValue::Bool(false))),
        ("10_bool_true", Some(ColValue::Bool(true))),
        ("11_text_a", Some(ColValue::Text("a".into()))),
        ("12_text_b", Some(ColValue::Text("b".into()))),
    ];
    // Insert in reverse to prove the index — not insertion order — drives the result.
    let rows: Vec<UpsertIn> = ordered
        .iter()
        .rev()
        .map(|(id, v)| UpsertIn {
            table: "vals".into(),
            id: (*id).to_owned(),
            data: "{}".into(),
            cols: v.clone().map(|v| vec![("v".to_owned(), v)]).unwrap_or_default(),
            creation_time: store.clock_next().unwrap(),
        })
        .collect();
    commit(&store, upserts(rows));

    let asc = store
        .doc_scan(&ScanSpec {
            table: "vals".into(),
            index: Some("by_v".into()),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    let expected: Vec<&str> = ordered.iter().map(|(id, _)| *id).collect();
    assert_eq!(doc_ids(&asc), expected, "ascending order must match Convex");

    // -0 and +0 are distinct order keys (different ids), proving -0 < +0 is preserved.
    let neg_zero = store
        .doc_scan(&ScanSpec {
            table: "vals".into(),
            index: Some("by_v".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Real(-0.0),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&neg_zero), vec!["04_real_negzero"]);
}

#[test]
fn cursor_rejects_a_different_bound_value() {
    let store = EmbeddedStore::open(tmp_path("rs_cursor_value.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let rows: Vec<UpsertIn> = (0..6)
        .map(|i| issue(&store, &format!("i{i}"), "t", if i < 3 { "open" } else { "closed" }))
        .collect();
    commit(&store, upserts(rows));

    let open = ScanSpec {
        table: "issues".into(),
        index: Some("by_status".into()),
        bounds: Some(vec![Bound::Eq {
            value: ColValue::Text("open".into()),
        }]),
        order: Order::Asc,
        page_size: Some(2),
        ..Default::default()
    };
    let page = store.doc_scan(&open).unwrap();
    let cursor = page.cursor.clone().expect("has next page");

    // Reusing the cursor against a scan with the SAME shape but a DIFFERENT bound value must be
    // rejected — the bound value is folded into the cursor shape.
    let closed = store.doc_scan(&ScanSpec {
        bounds: Some(vec![Bound::Eq {
            value: ColValue::Text("closed".into()),
        }]),
        cursor: Some(cursor.clone()),
        ..open.clone()
    });
    assert!(matches!(closed, Err(StorageError::InvalidCursor(_))));

    // The same cursor against the original scan still resumes fine.
    let resumed = store
        .doc_scan(&ScanSpec {
            cursor: Some(cursor),
            ..open
        })
        .unwrap();
    assert_eq!(doc_ids(&resumed), vec!["i2"]);
}

#[test]
fn decode_cursor_rejects_malformed_input() {
    for bad in [
        "",
        "ec1:0:",                 // old prefix
        "nope",
        "ec2:bad:shape",          // non-numeric length
        "ec2:999:short",          // length past end
        "ec2:0:z",                // unknown value tag
    ] {
        assert!(
            matches!(decode_cursor(bad, ""), Err(StorageError::InvalidCursor(_))),
            "expected InvalidCursor for {bad:?}"
        );
    }
}
