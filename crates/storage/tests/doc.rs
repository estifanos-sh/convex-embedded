//! doc — migrated from the former inline `src/tests.rs`, reaching private internals only
//! through `storage::testkit`. Run with `--features testkit`.
#![cfg(feature = "testkit")]
#![allow(
    clippy::too_many_lines,
    clippy::unreadable_literal,
    clippy::similar_names
)]

use storage::testkit::*;
use storage::*;

fn legacy_document_schema() -> StoreSchema {
    StoreSchema {
        tables: vec![TableDef {
            name: "documents".into(),
            columns: vec![
                ColumnDef {
                    name: "idx_slug".into(),
                    field: Some("slug".into()),
                },
                ColumnDef {
                    name: "idx_updatedat".into(),
                    field: Some("updatedAt".into()),
                },
            ],
            crdt_fields: vec![],
            indexes: vec![
                IndexDef {
                    name: "by_slug".into(),
                    fields: vec!["slug".into()],
                    columns: Some(vec!["idx_slug".into()]),
                },
                IndexDef {
                    name: "by_updatedAt".into(),
                    fields: vec!["updatedAt".into()],
                    columns: Some(vec!["idx_updatedat".into()]),
                },
            ],
        }],
    }
}

fn current_document_schema() -> StoreSchema {
    let mut schema = legacy_document_schema();
    let documents = &mut schema.tables[0];
    documents.columns.push(ColumnDef {
        name: "idx_title".into(),
        field: Some("title".into()),
    });
    documents.indexes.push(IndexDef {
        name: "by_title".into(),
        fields: vec!["title".into()],
        columns: Some(vec!["idx_title".into()]),
    });
    schema
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
    assert!(second_ct > first_ct);

    let all = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&all).len(), 2);
    assert!(all.cursor.is_none());
}

#[test]
fn commit_reports_row_changes_for_observability() {
    let store = EmbeddedStore::open(tmp_path("rs_commit_changes.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    let result = commit(&store, upserts(vec![issue(&store, "i1", "First", "open")]));
    assert_eq!(result.changed_tables, vec!["issues"]);
    assert_eq!(result.changes.len(), 1);
    let upsert = &result.changes[0];
    assert_eq!(upsert.op, RowChangeOp::Upsert);
    assert_eq!(upsert.table, "issues");
    assert_eq!(upsert.id, "i1");
    let row: serde_json::Value =
        serde_json::from_str(upsert.row.as_deref().expect("upsert carries row body")).unwrap();
    assert_eq!(row["_id"], "i1");
    assert_eq!(row["title"], "First");

    let result = commit(
        &store,
        WriteBatch {
            crdt_ops: Vec::new(),
            crdt_restores: vec![],
            upserts: vec![],
            deletes: vec![DeleteIn {
                table: "issues".into(),
                id: "i1".into(),
            }],
            fresh_ids: vec![],
            data_only_ids: vec![],
            id_mappings: vec![],
            schedules: vec![],
        },
    );
    assert_eq!(result.changes.len(), 1);
    let deleted = &result.changes[0];
    assert_eq!(deleted.op, RowChangeOp::Delete);
    assert_eq!(deleted.table, "issues");
    assert_eq!(deleted.id, "i1");
    assert!(deleted.row.is_none());
}

#[test]
fn data_only_update_changes_body_without_rewriting_index_columns() {
    let store = EmbeddedStore::open(tmp_path("rs_data_only_update.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let first = issue(&store, "i1", "before", "open");
    let creation_time = first.creation_time;
    commit(&store, upserts(vec![first]));

    commit(
        &store,
        WriteBatch {
            crdt_ops: Vec::new(),
            crdt_restores: vec![],
            upserts: vec![UpsertIn {
                table: "issues".into(),
                id: "i1".into(),
                data: r#"{"title":"after"}"#.into(),
                cols: vec![("status".into(), ColValue::Text("open".into()))],
                creation_time,
            }],
            data_only_ids: vec![RowKey {
                table: "issues".into(),
                document_id: "i1".into(),
            }],
            deletes: vec![],
            fresh_ids: vec![],
            id_mappings: vec![],
            schedules: vec![],
        },
    );

    let got = read_doc(&store, "issues", "i1").expect("row");
    assert_eq!(got["title"], "after");
    let indexed = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Text("open".into()),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&indexed), vec!["i1"]);
}

#[test]
fn supports_camel_case_indexed_fields() {
    let store = EmbeddedStore::open(tmp_path("rs_camel_case_index.db").to_str().unwrap()).unwrap();
    let schema = StoreSchema {
        tables: vec![TableDef {
            name: "documents".into(),
            columns: vec![ColumnDef {
                name: "idx_updatedat".into(),
                field: Some("updatedAt".into()),
            }],
            crdt_fields: vec![],
            indexes: vec![IndexDef {
                name: "by_updatedAt".into(),
                fields: vec!["updatedAt".into()],
                columns: Some(vec!["idx_updatedat".into()]),
            }],
        }],
    };
    store.setup(&schema).unwrap();
    commit(
        &store,
        upserts(vec![
            UpsertIn {
                table: "documents".into(),
                id: "documents|old".into(),
                data: r#"{"title":"Old","updatedAt":10}"#.into(),
                cols: vec![("idx_updatedat".into(), ColValue::Integer(10))],
                creation_time: store.clock_read().unwrap(),
            },
            UpsertIn {
                table: "documents".into(),
                id: "documents|new".into(),
                data: r#"{"title":"New","updatedAt":20}"#.into(),
                cols: vec![("idx_updatedat".into(), ColValue::Integer(20))],
                creation_time: store.clock_read().unwrap(),
            },
        ]),
    );
    store.setup(&schema).unwrap();

    let page = store
        .doc_page_read(&ReadSpec {
            table: "documents".into(),
            index: Some("by_updatedAt".into()),
            bounds: Some(vec![Bound::Range {
                lower: Some(ColValue::Integer(15)),
                lower_inclusive: true,
                upper: None,
                upper_inclusive: false,
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&page), vec!["documents|new"]);
}

#[test]
fn setup_resets_nonempty_store_when_format_version_changes() {
    let store = EmbeddedStore::open(tmp_path("rs_format_reset.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(&store, upserts(vec![issue(&store, "i1", "First", "open")]));
    assert!(read_doc(&store, "issues", "i1").is_some());

    store.force_user_version_for_test(0);
    fail_next_commit();
    assert!(matches!(
        store.setup(&schema()),
        Err(StorageError::Turso(_))
    ));
    assert!(read_doc(&store, "issues", "i1").is_some());

    store.setup(&schema()).unwrap();
    assert!(read_doc(&store, "issues", "i1").is_none());
    let next = commit(&store, upserts(vec![issue(&store, "i2", "Second", "open")]));
    assert_eq!(next.commit_seq, 1);

    store.force_user_version_for_test(39);
    store.setup(&schema()).unwrap();
    assert!(read_doc(&store, "issues", "i2").is_none());
    let reseeded = commit(&store, upserts(vec![issue(&store, "i3", "Third", "open")]));
    assert_eq!(reseeded.commit_seq, 1);

    store.setup(&schema()).unwrap();
    assert!(read_doc(&store, "issues", "i3").is_some());
}

#[test]
fn setup_preserves_data_when_format_version_matches() {
    let store = EmbeddedStore::open(tmp_path("rs_format_match.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(&store, upserts(vec![issue(&store, "i1", "First", "open")]));

    store.setup(&schema()).unwrap();
    assert!(read_doc(&store, "issues", "i1").is_some());
}

#[test]
fn setup_reconciles_schema_changes_without_deleting_existing_rows() {
    let store = EmbeddedStore::open(tmp_path("rs_schema_signature.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(&store, upserts(vec![issue(&store, "i1", "First", "open")]));

    let mut changed = schema();
    changed.tables.push(TableDef {
        name: "notes".into(),
        columns: vec![],
        crdt_fields: vec![],
        indexes: vec![],
    });
    fail_next_commit();
    assert!(matches!(store.setup(&changed), Err(StorageError::Turso(_))));
    assert!(read_doc(&store, "issues", "i1").is_some());

    store.setup(&changed).unwrap();
    assert!(read_doc(&store, "issues", "i1").is_some());
    commit(
        &store,
        upserts(vec![UpsertIn {
            table: "notes".into(),
            id: "n1".into(),
            data: r#"{"text":"kept"}"#.into(),
            cols: vec![],
            creation_time: store.clock_read().unwrap(),
        }]),
    );
    assert_eq!(read_doc(&store, "notes", "n1").unwrap()["text"], "kept");
}

#[test]
fn setup_backfills_new_index_columns_from_existing_documents() {
    let store =
        EmbeddedStore::open(tmp_path("rs_schema_index_backfill.db").to_str().unwrap()).unwrap();
    store.setup(&legacy_document_schema()).unwrap();
    commit(
        &store,
        upserts(vec![UpsertIn {
            table: "documents".into(),
            id: "documents|indexed".into(),
            data: r#"{"slug":"indexed","title":"Indexed","updatedAt":36}"#.into(),
            cols: vec![
                ("idx_slug".into(), ColValue::Text("indexed".into())),
                ("idx_updatedat".into(), ColValue::Integer(36)),
            ],
            creation_time: store.clock_read().unwrap(),
        }]),
    );

    store.setup(&current_document_schema()).unwrap();
    let page = store
        .doc_page_read(&ReadSpec {
            table: "documents".into(),
            index: Some("by_title".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Text("Indexed".into()),
            }]),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&page), vec!["documents|indexed"]);
}

#[test]
fn setup_preserves_store_when_physical_doc_columns_do_not_match_signature() {
    let store =
        EmbeddedStore::open(tmp_path("rs_schema_physical_mismatch.db").to_str().unwrap()).unwrap();
    let schema = StoreSchema {
        tables: vec![TableDef {
            name: "documents".into(),
            columns: vec![ColumnDef {
                name: "idx_slug".into(),
                field: Some("slug".into()),
            }],
            crdt_fields: vec![],
            indexes: vec![IndexDef {
                name: "by_slug".into(),
                fields: vec!["slug".into()],
                columns: Some(vec!["idx_slug".into()]),
            }],
        }],
    };
    store.setup(&schema).unwrap();
    commit(
        &store,
        upserts(vec![UpsertIn {
            table: "documents".into(),
            id: "documents|field-notes".into(),
            data: r#"{"slug":"field-notes"}"#.into(),
            cols: vec![("idx_slug".into(), ColValue::Text("field-notes".into()))],
            creation_time: store.clock_read().unwrap(),
        }]),
    );

    store.execute_sql_for_test("ALTER TABLE doc__documents RENAME COLUMN idx_slug TO idx_wrong");

    let error = store
        .setup(&schema)
        .expect_err("physical mismatch must fail");

    assert!(error.to_string().contains("physical schema"));
    store.execute_sql_for_test("ALTER TABLE doc__documents RENAME COLUMN idx_wrong TO idx_slug");
    assert_eq!(
        read_doc(&store, "documents", "documents|field-notes").unwrap()["slug"],
        "field-notes"
    );
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
                commit(
                    &store,
                    upserts(vec![issue(
                        &store,
                        &format!("i{i}"),
                        &format!("issue {i}"),
                        "open",
                    )]),
                );
            })
        })
        .collect();

    for handle in handles {
        handle.join().unwrap();
    }

    let store = EmbeddedStore::open_with_identity_key(&p, "same").unwrap();
    store.setup(&schema()).unwrap();
    let all = store
        .doc_page_read(&ReadSpec {
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
                crdt_fields: vec![],
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
            crdt_fields: vec![],
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
    commit(
        &store,
        upserts(vec![
            flag(&store, "keep", ColValue::Bool(true)),
            flag(&store, "remove", ColValue::Bool(false)),
        ]),
    );
    commit(
        &store,
        WriteBatch {
            crdt_ops: Vec::new(),
            crdt_restores: vec![],
            upserts: vec![flag(&store, "new", ColValue::Bool(true))],
            deletes: vec![DeleteIn {
                table: "flags".into(),
                id: "remove".into(),
            }],
            fresh_ids: vec![],
            data_only_ids: vec![],
            id_mappings: vec![],
            schedules: vec![],
        },
    );
    assert!(store.doc_read("flags", "new").unwrap().is_some());
    assert!(store.doc_read("flags", "remove").unwrap().is_none());

    commit(
        &store,
        upserts(vec![flag(
            &store,
            "mixed",
            ColValue::Text("not-an-integer".into()),
        )]),
    );
    assert!(store.doc_read("flags", "mixed").unwrap().is_some());
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

    commit(
        &store,
        upserts(vec![issue(&store, "after", "after", "open")]),
    );
    assert!(store.doc_read("issues", "after").unwrap().is_some());
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
            creation_time: store.clock_read().unwrap(),
        }]),
    );

    let doc = read_doc(&store, "t", "empty").expect("row");
    assert_eq!(doc["_id"], "empty");
    assert_eq!(doc.as_object().unwrap().len(), 2);

    let page = store
        .doc_page_read(&ReadSpec {
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
            creation_time: store.clock_read().unwrap(),
        }]),
    );

    let doc = read_doc(&store, "t", id).expect("row");
    assert_eq!(doc["_id"], id);
    let page = store
        .doc_page_read(&ReadSpec {
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
    let times = [
        1_749_740_000_000.0 + 1.0 / 128.0,
        0.1 + 0.2,
        1_234_567_890_123.456_7,
    ];
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
    let result = store.commit(
        upserts(vec![UpsertIn {
            table: "t".into(),
            id: "bad".into(),
            data: "[1]".into(),
            cols: vec![],
            creation_time: store.clock_read().unwrap(),
        }]),
        &CommitOptions::default(),
    );

    assert!(matches!(result, Err(StorageError::Decode { .. })));
    assert!(store.doc_read("t", "bad").unwrap().is_none());
}

/// The WAL folds into the main file and truncates on checkpoint, and the data survives a reopen.
#[test]
fn checkpoint_truncates_the_wal_and_preserves_data() {
    let path = tmp_path("checkpoint_truncates_wal.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    for index in 0..50 {
        store
            .commit(
                WriteBatch {
                    upserts: vec![UpsertIn {
                        cols: Vec::new(),
                        creation_time: f64::from(index),
                        data: format!(r#"{{"title":"row {index}"}}"#),
                        id: format!("issues|{index:03}"),
                        table: "issues".into(),
                    }],
                    ..WriteBatch::default()
                },
                &CommitOptions::default(),
            )
            .unwrap();
    }
    let wal = path.with_extension("db-wal");
    let before = std::fs::metadata(&wal).map_or(0, |meta| meta.len());
    assert!(before > 0, "commits should have grown the WAL");

    store.checkpoint().unwrap();

    let after = std::fs::metadata(&wal).map_or(0, |meta| meta.len());
    assert!(
        after < before,
        "checkpoint must shrink the WAL ({before} -> {after})"
    );
    drop(store);
    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&schema()).unwrap();
    let page = reopened
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            ..ReadSpec::default()
        })
        .unwrap();
    assert!(page.text.contains("row 49"));
}
