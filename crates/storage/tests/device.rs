#![cfg(feature = "testkit")]

use storage::testkit::{doc_writes, issue, parse_docs, tmp_path};
use storage::{
    AuthoritativeRow, ColumnDef, CommitChanges, CommitMutation, CommitOptions, CommitSource,
    DeleteIn, DocWrite, EmbeddedStore, IdMapping, IdMappingContent, LocalFieldDef,
    LocalFieldDelete, LocalFieldWrite, ReadSpec, RemoteMember, RemotePageWrite, StoreSchema,
    TableDef, TablePlacement, WriteBatch,
};

fn device_options() -> CommitOptions {
    CommitOptions {
        source: CommitSource::Device,
        mutation: CommitMutation::None,
        push: None,
        changes: CommitChanges::Include,
        commit_ts: false,
        mutation_result_commit_ts: false,
    }
}

fn schema() -> StoreSchema {
    let mut issues = storage::testkit::schema().tables.remove(0);
    issues.local_fields = vec![LocalFieldDef {
        field: "expanded".into(),
    }];
    StoreSchema {
        hash: "0".repeat(64),
        setup_hash: String::new(),
        tables: vec![
            issues,
            TableDef {
                name: "preferences".into(),
                placement: TablePlacement::Device,
                columns: vec![],
                crdt_fields: vec![],
                local_fields: vec![],
                indexes: vec![],
            },
        ],
    }
}

fn complete_empty_queue_policy(store: &EmbeddedStore, generation: i64) {
    assert!(store
        .migration_queue_policy_write(generation, r#"{"collectComplete":true,"thresholds":[]}"#,)
        .unwrap());
}

#[test]
fn overlay_is_a_separate_identity_scoped_page_sidecar() {
    let store = EmbeddedStore::open(tmp_path("device_overlay.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .commit(
            doc_writes(vec![issue(&store, "i1", "first", "open")]),
            &CommitOptions::remote(),
        )
        .unwrap();

    let result = store
        .commit(
            WriteBatch {
                local_field_writes: vec![LocalFieldWrite {
                    table: "issues".into(),
                    id: "i1".into(),
                    field: "expanded".into(),
                    value: serde_json::json!(true),
                }],
                ..WriteBatch::default()
            },
            &device_options(),
        )
        .unwrap();
    assert_eq!(result.changed_tables, ["issues"]);
    assert!(store.dirty_heads_debug_read().unwrap().is_empty());
    assert!(store
        .doc_read("issues", "i1")
        .unwrap()
        .unwrap()
        .find("expanded")
        .is_none());
    assert_eq!(
        store.local_fields_read("issues", "i1").unwrap()["expanded"],
        true
    );

    let page = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            ..ReadSpec::default()
        })
        .unwrap();
    assert_eq!(parse_docs(&page).len(), 1);
    assert_eq!(page.local_fields["i1"]["expanded"], true);

    let original_identity = store.identity_read().unwrap().0;
    store.identity_write("other", Some("null")).unwrap();
    assert!(store.local_fields_read("issues", "i1").unwrap().is_empty());
    store
        .identity_write(&original_identity, Some("null"))
        .unwrap();
    assert_eq!(
        store.local_fields_read("issues", "i1").unwrap()["expanded"],
        true
    );
}

#[test]
fn local_field_commit_timestamp_is_resolved_in_the_same_transaction() {
    let store =
        EmbeddedStore::open(tmp_path("device_overlay_commit_ts.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .commit(
            doc_writes(vec![issue(&store, "i1", "first", "open")]),
            &CommitOptions::remote(),
        )
        .unwrap();
    let mut batch = WriteBatch {
        local_field_writes: vec![LocalFieldWrite {
            table: "issues".into(),
            id: "i1".into(),
            field: "expanded".into(),
            value: serde_json::json!({ "at": { "$commitTs": null } }),
        }],
        ..WriteBatch::default()
    };
    batch.commit_ts_local_field_writes.push(0);
    let mut options = device_options();
    options.commit_ts = true;
    let timestamp = store
        .commit(batch, &options)
        .unwrap()
        .commit_ts
        .expect("timestamp allocated");

    assert_eq!(
        store.local_fields_read("issues", "i1").unwrap()["expanded"]["at"]["$integer"],
        base64::encode(timestamp.to_le_bytes())
    );
}

#[test]
fn device_table_crud_requires_device_source_and_creates_no_dirty_head() {
    let store = EmbeddedStore::open(tmp_path("device_table.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let row = DocWrite {
        table: "preferences".into(),
        id: "p1".into(),
        data: serde_json::json!({ "compact": true }).to_string(),
        cols: vec![],
        creation_time: store.clock_read().unwrap(),
    };
    assert!(store
        .commit(doc_writes(vec![row.clone()]), &CommitOptions::remote())
        .is_err());
    store
        .commit(doc_writes(vec![row]), &device_options())
        .unwrap();
    assert!(store.doc_read("preferences", "p1").unwrap().is_some());
    assert!(store.dirty_heads_debug_read().unwrap().is_empty());
}

#[test]
fn removed_local_field_origins_remain_dormant_without_blocking_cutover() {
    let store =
        EmbeddedStore::open(tmp_path("device_schema_cleanup.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .commit(
            WriteBatch {
                local_field_writes: vec![LocalFieldWrite {
                    table: "issues".into(),
                    id: "i1".into(),
                    field: "expanded".into(),
                    value: serde_json::json!(true),
                }],
                ..WriteBatch::default()
            },
            &device_options(),
        )
        .unwrap();
    store.identity_write("other", Some("null")).unwrap();
    store
        .commit(
            WriteBatch {
                local_field_writes: vec![LocalFieldWrite {
                    table: "issues".into(),
                    id: "i1".into(),
                    field: "expanded".into(),
                    value: serde_json::json!(false),
                }],
                ..WriteBatch::default()
            },
            &device_options(),
        )
        .unwrap();

    let mut next = schema();
    next.hash = "1".repeat(64);
    next.tables[0].local_fields.clear();
    let candidate = store.migration_begin(&next).unwrap();
    complete_empty_queue_policy(&store, candidate.candidate_generation);
    store
        .migration_commit(&next, candidate.candidate_generation)
        .unwrap();
    assert!(store.local_fields_read("issues", "i1").unwrap().is_empty());
    store.identity_write("", Some("null")).unwrap();
    assert!(store.local_fields_read("issues", "i1").unwrap().is_empty());
    assert_eq!(
        store
            .origin_page_read(candidate.candidate_generation, None, 100)
            .unwrap()
            .records
            .into_iter()
            .filter(|record| record.kind == 3)
            .count(),
        2
    );
}

#[test]
fn membership_style_remote_delete_preserves_overlay_until_explicit_device_clear() {
    let store = EmbeddedStore::open(tmp_path("device_preserve.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .commit(
            doc_writes(vec![issue(&store, "i1", "first", "open")]),
            &CommitOptions::remote(),
        )
        .unwrap();
    store
        .commit(
            WriteBatch {
                local_field_writes: vec![LocalFieldWrite {
                    table: "issues".into(),
                    id: "i1".into(),
                    field: "expanded".into(),
                    value: serde_json::json!(true),
                }],
                ..WriteBatch::default()
            },
            &device_options(),
        )
        .unwrap();

    store
        .commit(
            WriteBatch {
                deletes: vec![DeleteIn {
                    table: "issues".into(),
                    id: "i1".into(),
                }],
                ..WriteBatch::default()
            },
            &CommitOptions::remote(),
        )
        .unwrap();
    assert!(store.doc_read("issues", "i1").unwrap().is_none());
    assert_eq!(
        store.local_fields_read("issues", "i1").unwrap()["expanded"],
        true
    );

    store
        .commit(
            WriteBatch {
                local_field_deletes: vec![LocalFieldDelete {
                    table: "issues".into(),
                    id: "i1".into(),
                    field: "expanded".into(),
                }],
                ..WriteBatch::default()
            },
            &device_options(),
        )
        .unwrap();
    assert!(store.local_fields_read("issues", "i1").unwrap().is_empty());
}

#[test]
fn placement_is_enforced_at_the_transaction_boundary() {
    let store = EmbeddedStore::open(tmp_path("device_placement.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    let replicated_row = issue(&store, "i1", "first", "open");
    assert!(store
        .commit(doc_writes(vec![replicated_row]), &device_options())
        .is_err());
    assert!(store
        .commit(
            WriteBatch {
                local_field_writes: vec![LocalFieldWrite {
                    table: "issues".into(),
                    id: "i1".into(),
                    field: "missing".into(),
                    value: serde_json::json!(true),
                }],
                ..WriteBatch::default()
            },
            &device_options(),
        )
        .is_err());
    assert!(store
        .commit(
            WriteBatch {
                local_field_writes: vec![LocalFieldWrite {
                    table: "issues".into(),
                    id: "i1".into(),
                    field: "expanded".into(),
                    value: serde_json::json!(true),
                }],
                ..WriteBatch::default()
            },
            &CommitOptions::default(),
        )
        .is_err());
    assert!(store
        .remote_page_write(&RemotePageWrite {
            subscription: "preferences:list".into(),
            members: vec![RemoteMember {
                table: "preferences".into(),
                server_document_id: "server-preference".into(),
            }],
            projections: vec![],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("cursor:device".into()),
            received_time: 1,
            result: None,
        })
        .is_err());
}

#[test]
fn replicated_base_rows_reject_declared_device_fields() {
    let store = EmbeddedStore::open(tmp_path("device_base_field.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let mut row = issue(&store, "i1", "first", "open");
    row.data = serde_json::json!({
        "expanded": true,
        "status": "open",
        "title": "first"
    })
    .to_string();

    assert!(store
        .commit(doc_writes(vec![row.clone()]), &CommitOptions::remote())
        .is_err());
    assert!(store.doc_read("issues", "i1").unwrap().is_none());

    row.id = "i2".into();
    assert!(store
        .commit_one_doc_write(row, &CommitOptions::remote(), false, false)
        .is_err());
    assert!(store.doc_read("issues", "i2").unwrap().is_none());

    assert!(store
        .commit_one_doc_write_encoded(
            "issues".into(),
            "i3".into(),
            serde_json::json!({
                "expanded": true,
                "status": "open",
                "title": "third"
            })
            .to_string(),
            vec![],
            store.clock_read().unwrap(),
            &CommitOptions::remote(),
            false,
            false,
        )
        .is_err());
    assert!(store.doc_read("issues", "i3").unwrap().is_none());
}

#[test]
fn setup_rejects_table_placement_changes_in_place() {
    let path = tmp_path("device_table_flip.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let current = schema();
    store.setup(&current).unwrap();

    let mut flipped = current.clone();
    flipped.tables[1].placement = TablePlacement::Replicated;
    flipped.hash = "1".repeat(64);
    assert!(store.setup(&flipped).is_err());

    let path = tmp_path("device_table_flip_reverse.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let mut replicated = schema();
    replicated.tables[1].placement = TablePlacement::Replicated;
    store.setup(&replicated).unwrap();
    replicated.tables[1].placement = TablePlacement::Device;
    replicated.hash = "1".repeat(64);
    replicated.tables[1].columns = vec![ColumnDef {
        name: "new_column".into(),
        field: None,
    }];
    assert!(store.setup(&replicated).is_err());
}

#[test]
fn device_tables_reject_id_mapping_replication_metadata() {
    let store = EmbeddedStore::open(tmp_path("device_id_mapping.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let mapping = IdMapping {
        table: "preferences".into(),
        local_id: "preferences|local".into(),
        mapping: IdMappingContent::Local,
        created_time: 1,
        updated_time: 1,
    };

    assert!(store.id_write(&mapping).is_err());
    assert!(store.id_read("preferences", "preferences|local").is_err());
    assert!(store
        .id_local_read("preferences", "preferences|server")
        .is_err());
    assert!(store.id_page_read("preferences").is_err());
    assert!(store.id_delete("preferences", "preferences|local").is_err());
    assert!(store
        .commit(
            WriteBatch {
                id_mappings: vec![mapping],
                ..WriteBatch::default()
            },
            &CommitOptions::remote(),
        )
        .is_err());

    let storage_mapping = IdMapping {
        table: "_storage".into(),
        local_id: "_storage|local".into(),
        mapping: IdMappingContent::Local,
        created_time: 1,
        updated_time: 1,
    };
    store.id_write(&storage_mapping).unwrap();
    assert!(store
        .id_read("_storage", "_storage|local")
        .unwrap()
        .is_some());

    let schedule_mapping = IdMapping {
        table: "_scheduled_functions".into(),
        local_id: "job:local".into(),
        mapping: IdMappingContent::Local,
        created_time: 1,
        updated_time: 1,
    };
    store.id_write(&schedule_mapping).unwrap();
    assert!(store
        .id_read("_scheduled_functions", "job:local")
        .unwrap()
        .is_some());
}

#[test]
fn pull_id_adoption_rekeys_the_overlay_in_the_same_transaction() {
    const SERVER_ID: &str = "j575pnjjhzf95ze91djp5v26b188xreb";
    const LOCAL_ID: &str = "issues|11111111111111111111111111111111";
    let store = EmbeddedStore::open(tmp_path("device_rekey.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .commit(
            WriteBatch {
                local_field_writes: vec![LocalFieldWrite {
                    table: "issues".into(),
                    id: SERVER_ID.into(),
                    field: "expanded".into(),
                    value: serde_json::json!(true),
                }],
                ..WriteBatch::default()
            },
            &device_options(),
        )
        .unwrap();

    store
        .remote_page_write(&RemotePageWrite {
            subscription: "issues:list".into(),
            members: vec![RemoteMember {
                table: "issues".into(),
                server_document_id: SERVER_ID.into(),
            }],
            projections: vec![AuthoritativeRow {
                table: "issues".into(),
                local_document_id: Some(LOCAL_ID.into()),
                server_document_id: SERVER_ID.into(),
                plain_hash: "plain:1".into(),
                projection_hash: "projection:1".into(),
                current_root_id: None,
                current_node_id: None,
                row: Some(format!(
                    r#"{{"_id":"{SERVER_ID}","_creationTime":1,"status":"open","title":"first"}}"#
                )),
                logical_clock: Some(1.0),
                received_time: 1,
            }],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("cursor:1".into()),
            received_time: 1,
            result: None,
        })
        .unwrap();

    assert!(store
        .local_fields_read("issues", SERVER_ID)
        .unwrap()
        .is_empty());
    assert_eq!(
        store.local_fields_read("issues", LOCAL_ID).unwrap()["expanded"],
        true
    );
}

#[test]
fn adding_a_device_field_uses_a_new_generation() {
    let path = tmp_path("device_additive_field.db");
    let p = path.to_str().unwrap();
    {
        let store = EmbeddedStore::open(p).unwrap();
        let mut before = schema();
        before.tables[0].local_fields.clear();
        store.setup(&before).unwrap();
        store
            .commit(
                doc_writes(vec![issue(&store, "i1", "first", "open")]),
                &CommitOptions::remote(),
            )
            .unwrap();
    }

    let store = EmbeddedStore::open(p).expect("an existing store reopens");
    let mut after = schema();
    after.hash = "1".repeat(64);
    assert!(matches!(
        store.setup(&after),
        Err(storage::StorageError::IncompatibleStore(_))
    ));
    let candidate = store.migration_begin(&after).unwrap();
    complete_empty_queue_policy(&store, candidate.candidate_generation);
    store
        .migration_commit(&after, candidate.candidate_generation)
        .unwrap();

    assert!(store.doc_read("issues", "i1").unwrap().is_none());
    store
        .commit(
            WriteBatch {
                local_field_writes: vec![LocalFieldWrite {
                    table: "issues".into(),
                    id: "i1".into(),
                    field: "expanded".into(),
                    value: serde_json::json!(true),
                }],
                ..WriteBatch::default()
            },
            &device_options(),
        )
        .unwrap();
    assert_eq!(
        store.local_fields_read("issues", "i1").unwrap()["expanded"],
        serde_json::json!(true)
    );
}

#[test]
fn converting_an_indexed_field_to_device_only_preserves_the_store() {
    let path = tmp_path("device_indexed_conversion.db");
    let p = path.to_str().unwrap();
    {
        let store = EmbeddedStore::open(p).unwrap();
        let mut before = schema();
        before.tables[0].local_fields.clear();
        store.setup(&before).unwrap();
    }

    let store = EmbeddedStore::open(p).unwrap();
    let mut after = schema();
    let indexed = after.tables[0].columns[0].clone();
    let field = indexed.field.clone().unwrap_or(indexed.name.clone());
    after.tables[0].local_fields = vec![LocalFieldDef {
        field: field.clone(),
    }];
    after.hash = "1".repeat(64);
    let error = store
        .setup(&after)
        .expect_err("an indexed field cannot become device-only in place");
    assert!(error.to_string().contains("migration runner"), "{error}");
}
