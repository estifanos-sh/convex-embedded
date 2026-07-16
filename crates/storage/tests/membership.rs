//! Durable remote subscription membership and atomic snapshot reconciliation.
#![cfg(feature = "testkit")]

use storage::testkit::*;
use storage::*;

#[test]
fn revision_lifecycle_rejects_impossible_graph_metadata() {
    assert!(RevLifecycle::decode(
        "current",
        Some("parent".into()),
        None,
        None,
        None,
        None,
        None,
    )
    .is_none());
    assert!(
        RevLifecycle::decode("current", None, Some("rev".into()), None, None, None, None).is_none()
    );
    assert!(RevLifecycle::decode("archived", None, None, None, None, None, None).is_none());
    assert!(RevLifecycle::decode("fork", None, None, None, None, None, None).is_none());
}

const SERVER_ID: &str = "j575pnjjhzf95ze91djp5v26b188xreb";
const STALE_SERVER_ID: &str = "k575pnjjhzf95ze91djp5v26b188xrec";

fn projection(server_id: &str, title: &str, clock: f64, received_time: i64) -> AuthoritativeRow {
    AuthoritativeRow {
        table: "issues".into(),
        local_document_id: None,
        server_document_id: server_id.into(),
        plain_hash: format!("plain:{server_id}:{clock}"),
        projection_hash: format!("projection:{server_id}:{clock}"),
        current_root_id: None,
        current_node_id: None,
        row: Some(format!(
            r#"{{"_id":"{server_id}","_creationTime":1,"status":"open","title":"{title}"}}"#
        )),
        logical_clock: Some(clock),
        received_time,
    }
}

fn snapshot(
    subscription: &str,
    members: Vec<RemoteMember>,
    projections: Vec<AuthoritativeRow>,
    cursor: &str,
    received_time: i64,
) -> RemotePageWrite {
    RemotePageWrite {
        subscription: subscription.into(),
        members,
        projections,
        crdt: Vec::new(),
        blobs: Vec::new(),
        cursor: Some(cursor.into()),
        received_time,
        result: None,
    }
}

fn member(server_id: &str) -> RemoteMember {
    RemoteMember {
        table: "issues".into(),
        server_document_id: server_id.into(),
    }
}

fn rows(store: &EmbeddedStore) -> Vec<serde_json::Value> {
    parse_docs(
        &store
            .doc_page_read(&ReadSpec {
                table: "issues".into(),
                ..ReadSpec::default()
            })
            .unwrap(),
    )
}

fn crdt_schema() -> StoreSchema {
    StoreSchema {
        tables: vec![TableDef {
            name: "issues".into(),
            columns: vec![ColumnDef {
                name: "status".into(),
                field: None,
            }],
            crdt_fields: vec![CrdtFieldDef {
                field: "body".into(),
                kind: CrdtFieldKind::Text,
            }],
            indexes: vec![IndexDef {
                name: "by_status".into(),
                fields: vec!["status".into()],
                columns: None,
            }],
        }],
    }
}

fn text_checkpoint(text: &str) -> CrdtSnapshot {
    let source =
        EmbeddedStore::open(tmp_path("membership_crdt_source.db").to_str().unwrap()).unwrap();
    source.setup(&crdt_schema()).unwrap();
    source
        .commit(
            WriteBatch {
                doc_writes: vec![DocWrite {
                    table: "issues".into(),
                    id: "source".into(),
                    data: r#"{"body":"","title":"source"}"#.into(),
                    cols: vec![("status".into(), ColValue::Text("open".into()))],
                    creation_time: source.clock_read().unwrap(),
                }],
                crdt_ops: vec![CrdtOp {
                    row: RowKey {
                        table: "issues".into(),
                        document_id: "source".into(),
                    },
                    field: "body".into(),
                    operation: CrdtOperation::TextSplice {
                        index: 0,
                        delete: 0,
                        insert: text.into(),
                    },
                }],
                ..WriteBatch::default()
            },
            &CommitOptions::default(),
        )
        .unwrap();
    source
        .crdt_snapshot_read("issues", "source")
        .unwrap()
        .remove(0)
}

fn crdt_pull(
    server_id: &str,
    checkpoint: &CrdtSnapshot,
    projection_hash: String,
    clock: f64,
) -> RemotePageWrite {
    RemotePageWrite {
        subscription: "issues:crdt:{}".into(),
        members: vec![member(server_id)],
        projections: vec![AuthoritativeRow {
            table: "issues".into(),
            local_document_id: None,
            server_document_id: server_id.into(),
            plain_hash: format!("plain:{server_id}"),
            projection_hash: format!("projection:{server_id}"),
            current_root_id: None,
            current_node_id: None,
            row: Some(format!(
                r#"{{"_id":"{server_id}","_creationTime":1,"status":"open","title":"remote","body":""}}"#
            )),
            logical_clock: Some(clock),
            received_time: 10,
        }],
        crdt: vec![RemoteCrdtChange {
            table: "issues".into(),
            document_id: server_id.into(),
            field: "body".into(),
            kind: CrdtFieldKind::Text,
            epoch: 1,
            checkpoint_seq: checkpoint.head_seq,
            head_seq: checkpoint.head_seq,
            projection_hash,
            checkpoint: Some(checkpoint.bytes.clone()),
            updates: Vec::new(),
            checkpoint_request: None,
        }],
        blobs: Vec::new(),
        cursor: Some("cursor:crdt".into()),
        received_time: 10,
        result: None,
    }
}

fn text_increment(checkpoint: &CrdtSnapshot) -> (Vec<u8>, CrdtSnapshot) {
    let source = EmbeddedStore::open(
        tmp_path("membership_crdt_increment_source.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    source.setup(&crdt_schema()).unwrap();
    source
        .remote_page_write(&crdt_pull(
            SERVER_ID,
            checkpoint,
            checkpoint.projection_hash.clone(),
            1.0,
        ))
        .unwrap();
    let source_id = rows(&source)[0]["_id"].as_str().unwrap().to_owned();
    let committed = source
        .commit(
            WriteBatch {
                crdt_ops: vec![CrdtOp {
                    row: RowKey {
                        table: "issues".into(),
                        document_id: source_id.clone(),
                    },
                    field: "body".into(),
                    operation: CrdtOperation::TextSplice {
                        index: 6,
                        delete: 0,
                        insert: "A".into(),
                    },
                }],
                ..WriteBatch::default()
            },
            &CommitOptions::default(),
        )
        .unwrap();
    let snapshot = source
        .crdt_snapshot_read("issues", &source_id)
        .unwrap()
        .remove(0);
    (committed.crdt_ops[0].update.clone(), snapshot)
}

#[test]
fn a_projection_is_deleted_only_after_its_final_membership_edge_exits() {
    let store = EmbeddedStore::open(tmp_path("membership_edges.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    store
        .remote_page_write(&snapshot(
            "issues:all:{}",
            vec![member(SERVER_ID)],
            vec![projection(SERVER_ID, "shared", 1.0, 1)],
            "all:1",
            1,
        ))
        .unwrap();
    assert_eq!(
        store.subscription_membership_read("issues:all:{}").unwrap(),
        vec![member(SERVER_ID)]
    );
    store
        .remote_page_write(&snapshot(
            "issues:open:{}",
            vec![member(SERVER_ID)],
            vec![projection(SERVER_ID, "shared", 1.0, 2)],
            "open:1",
            2,
        ))
        .unwrap();
    assert_eq!(
        store
            .subscription_membership_read("issues:open:{}")
            .unwrap(),
        vec![member(SERVER_ID)]
    );

    let first_exit = store
        .remote_page_write(&snapshot(
            "issues:all:{}",
            Vec::new(),
            Vec::new(),
            "all:2",
            3,
        ))
        .unwrap();
    assert_eq!(first_exit.projection_deleted, 0);
    assert_eq!(rows(&store).len(), 1);
    assert_eq!(
        store
            .remote_cursor_read("issues:all:{}")
            .unwrap()
            .as_deref(),
        Some("all:2")
    );
    assert_eq!(
        store
            .remote_cursor_read("issues:open:{}")
            .unwrap()
            .as_deref(),
        Some("open:1")
    );

    let final_exit = store
        .remote_page_write(&snapshot(
            "issues:open:{}",
            Vec::new(),
            Vec::new(),
            "open:2",
            4,
        ))
        .unwrap();
    assert_eq!(final_exit.projection_deleted, 1);
    assert!(rows(&store).is_empty());
}

#[test]
fn an_unchanged_membership_accepts_only_changed_projections() {
    let store = EmbeddedStore::open(tmp_path("membership_delta.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let members = vec![member(SERVER_ID), member(STALE_SERVER_ID)];

    store
        .remote_page_write(&snapshot(
            "issues:all:{}",
            members.clone(),
            vec![
                projection(SERVER_ID, "before", 1.0, 1),
                projection(STALE_SERVER_ID, "stable", 1.0, 1),
            ],
            "cursor:1",
            1,
        ))
        .unwrap();

    let delta = store
        .remote_page_write(&snapshot(
            "issues:all:{}",
            members.clone(),
            vec![projection(SERVER_ID, "after", 2.0, 2)],
            "cursor:2",
            2,
        ))
        .unwrap();

    assert_eq!(delta.projection.committed.len(), 1);
    assert_eq!(
        store.subscription_membership_read("issues:all:{}").unwrap(),
        members
    );
    let current = rows(&store);
    assert_eq!(current.len(), 2);
    assert!(current.iter().any(|row| row["title"] == "after"));
    assert!(current.iter().any(|row| row["title"] == "stable"));

    let unchanged = store
        .remote_page_write(&snapshot(
            "issues:all:{}",
            vec![member(SERVER_ID), member(STALE_SERVER_ID)],
            Vec::new(),
            "cursor:3",
            3,
        ))
        .unwrap();
    assert!(unchanged.projection.committed.is_empty());
    assert_eq!(rows(&store), current);
}

#[test]
fn an_invalid_snapshot_rolls_back_projection_membership_and_cursor_together() {
    let store = EmbeddedStore::open(tmp_path("membership_atomic.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .remote_page_write(&snapshot(
            "issues:all:{}",
            vec![member(SERVER_ID)],
            vec![projection(SERVER_ID, "before", 1.0, 1)],
            "cursor:1",
            1,
        ))
        .unwrap();

    let missing_id = "jx77missingauthoritativeprojection";
    let rejected = store.remote_page_write(&snapshot(
        "issues:all:{}",
        vec![member(missing_id)],
        vec![projection(SERVER_ID, "must roll back", 2.0, 2)],
        "cursor:2",
        2,
    ));
    assert!(rejected.is_err());
    assert_eq!(rows(&store)[0]["title"], "before");
    assert_eq!(
        store
            .remote_cursor_read("issues:all:{}")
            .unwrap()
            .as_deref(),
        Some("cursor:1")
    );

    let exit = store
        .remote_page_write(&snapshot(
            "issues:all:{}",
            Vec::new(),
            Vec::new(),
            "cursor:3",
            3,
        ))
        .unwrap();
    assert_eq!(
        exit.projection_deleted, 1,
        "the original edge survived the rollback"
    );
}

#[test]
fn final_membership_exit_archives_dirty_state_before_removing_the_projection() {
    let store = EmbeddedStore::open(tmp_path("membership_dirty.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .remote_page_write(&snapshot(
            "issues:all:{}",
            vec![member(SERVER_ID)],
            vec![projection(SERVER_ID, "server", 1.0, 1)],
            "cursor:1",
            1,
        ))
        .unwrap();
    let local_id = rows(&store)[0]["_id"].as_str().unwrap().to_owned();
    store
        .commit(
            doc_writes(vec![issue(&store, &local_id, "local", "dirty")]),
            &CommitOptions::default(),
        )
        .unwrap();

    let exit = store
        .remote_page_write(&snapshot(
            "issues:all:{}",
            Vec::new(),
            Vec::new(),
            "cursor:2",
            2,
        ))
        .unwrap();
    assert_eq!(exit.projection_deleted, 1);
    assert_eq!(exit.projection.reroots.len(), 1);
    assert!(rows(&store).is_empty());
    let revisions = store
        .rev_read(&RowKey {
            table: "issues".into(),
            document_id: local_id,
        })
        .unwrap();
    assert!(revisions
        .iter()
        .any(|revision| matches!(revision.lifecycle, RevLifecycle::Archived(_))));
    assert!(!revisions
        .iter()
        .any(|revision| revision.lifecycle == RevLifecycle::Current));
}

#[test]
fn warm_and_fresh_stores_converge_after_the_same_complete_snapshot() {
    let warm = EmbeddedStore::open(tmp_path("membership_warm.db").to_str().unwrap()).unwrap();
    let fresh = EmbeddedStore::open(tmp_path("membership_fresh.db").to_str().unwrap()).unwrap();
    warm.setup(&schema()).unwrap();
    fresh.setup(&schema()).unwrap();

    warm.remote_page_write(&snapshot(
        "issues:all:{}",
        vec![member(SERVER_ID), member(STALE_SERVER_ID)],
        vec![
            projection(SERVER_ID, "old current", 1.0, 1),
            projection(STALE_SERVER_ID, "stale", 1.0, 1),
        ],
        "cursor:old",
        1,
    ))
    .unwrap();
    let current = snapshot(
        "issues:all:{}",
        vec![member(SERVER_ID)],
        vec![projection(SERVER_ID, "current", 2.0, 2)],
        "cursor:current",
        2,
    );
    warm.remote_page_write(&current).unwrap();
    fresh.remote_page_write(&current).unwrap();

    assert_eq!(rows(&warm), rows(&fresh));
    assert_eq!(rows(&warm).len(), 1);
    assert_eq!(rows(&warm)[0]["title"], "current");
    assert_eq!(
        warm.subscription_membership_read("issues:all:{}").unwrap(),
        fresh.subscription_membership_read("issues:all:{}").unwrap()
    );
    assert_eq!(
        warm.remote_cursor_read("issues:all:{}").unwrap(),
        fresh.remote_cursor_read("issues:all:{}").unwrap()
    );
}

#[test]
fn mixed_projection_membership_crdt_and_invalidation_commit_together() {
    let checkpoint = text_checkpoint("remote");
    let path = tmp_path("membership_crdt_atomic.db");
    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&crdt_schema()).unwrap();
        let applied = store
            .remote_page_write(&crdt_pull(
                SERVER_ID,
                &checkpoint,
                checkpoint.projection_hash.clone(),
                20.0,
            ))
            .unwrap();
        assert_eq!(applied.projection.committed.len(), 1);
        assert_eq!(applied.projection.committed[0].changed_tables, ["issues"]);
        assert_eq!(applied.crdt.len(), 1);
        assert_eq!(applied.crdt[0].table, "issues");
        let documents = rows(&store);
        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0]["body"], "remote");
        let local_id = documents[0]["_id"].as_str().unwrap();
        assert_eq!(
            store.crdt_read_states("issues", local_id).unwrap(),
            vec![CrdtReadState {
                field: "body".into(),
                epoch: 1,
                head_seq: checkpoint.head_seq,
                projection_hash: checkpoint.projection_hash.clone(),
            }]
        );
    }
    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&crdt_schema()).unwrap();
    assert_eq!(rows(&reopened)[0]["body"], "remote");
    assert_eq!(
        reopened
            .subscription_membership_read("issues:crdt:{}")
            .unwrap(),
        vec![member(SERVER_ID)]
    );
    assert_eq!(
        reopened
            .remote_cursor_read("issues:crdt:{}")
            .unwrap()
            .as_deref(),
        Some("cursor:crdt")
    );
}

#[test]
fn duplicate_and_stale_crdt_heads_are_idempotent_and_divergence_fails_closed() {
    let checkpoint = text_checkpoint("remote");
    let (update, next) = text_increment(&checkpoint);

    let store =
        EmbeddedStore::open(tmp_path("membership_crdt_idempotent.db").to_str().unwrap()).unwrap();
    store.setup(&crdt_schema()).unwrap();
    store
        .remote_page_write(&crdt_pull(
            SERVER_ID,
            &checkpoint,
            checkpoint.projection_hash.clone(),
            1.0,
        ))
        .unwrap();
    let local_id = rows(&store)[0]["_id"].as_str().unwrap().to_owned();

    let mut incremental = crdt_pull(SERVER_ID, &checkpoint, next.projection_hash.clone(), 2.0);
    incremental.cursor = Some("cursor:incremental".into());
    incremental.received_time = 20;
    incremental.crdt = vec![RemoteCrdtChange {
        table: "issues".into(),
        document_id: SERVER_ID.into(),
        field: "body".into(),
        kind: CrdtFieldKind::Text,
        epoch: 1,
        checkpoint_seq: checkpoint.head_seq,
        head_seq: checkpoint.head_seq + 1,
        projection_hash: next.projection_hash.clone(),
        checkpoint: None,
        updates: vec![update],
        checkpoint_request: None,
    }];
    store.remote_page_write(&incremental).unwrap();
    assert_eq!(rows(&store)[0]["body"], "remoteA");
    assert_eq!(
        store
            .crdt_remote_state("issues", &local_id, "body", CrdtFieldKind::Text)
            .unwrap()
            .unwrap()
            .head_seq,
        checkpoint.head_seq + 1
    );

    let mut duplicate = incremental.clone();
    duplicate.cursor = Some("cursor:duplicate".into());
    duplicate.received_time = 21;
    store.remote_page_write(&duplicate).unwrap();
    assert_eq!(rows(&store)[0]["body"], "remoteA");

    let mut stale = crdt_pull(
        SERVER_ID,
        &checkpoint,
        checkpoint.projection_hash.clone(),
        1.0,
    );
    stale.cursor = Some("cursor:stale".into());
    stale.received_time = 22;
    store.remote_page_write(&stale).unwrap();
    assert_eq!(rows(&store)[0]["body"], "remoteA");

    let mut divergent = duplicate;
    divergent.cursor = Some("cursor:divergent".into());
    divergent.received_time = 23;
    divergent.crdt[0].projection_hash = "different-projection".into();
    assert!(matches!(
        store.remote_page_write(&divergent),
        Err(StorageError::Unsatisfiable(_))
    ));
    assert_eq!(rows(&store)[0]["body"], "remoteA");
    assert_eq!(
        store
            .remote_cursor_read("issues:crdt:{}")
            .unwrap()
            .as_deref(),
        Some("cursor:stale")
    );
}

#[test]
fn corrupt_crdt_rolls_back_projection_mapping_membership_cursor_and_clock() {
    let checkpoint = text_checkpoint("remote");
    let path = tmp_path("membership_crdt_rollback.db");
    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&crdt_schema()).unwrap();
        let rejected = store.remote_page_write(&crdt_pull(
            SERVER_ID,
            &checkpoint,
            "wrong-projection-hash".into(),
            DOMINATING_CLOCK,
        ));
        assert!(matches!(rejected, Err(StorageError::Unsatisfiable(_))));
        assert!(rows(&store).is_empty());
        assert!(store.id_page_read("issues").unwrap().is_empty());
        assert!(store
            .subscription_membership_read("issues:crdt:{}")
            .unwrap()
            .is_empty());
        assert_eq!(store.remote_cursor_read("issues:crdt:{}").unwrap(), None);
        assert!(store.clock_read().unwrap() < DOMINATING_CLOCK);
    }
    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&crdt_schema()).unwrap();
    assert!(rows(&reopened).is_empty());
    assert!(reopened.id_page_read("issues").unwrap().is_empty());
    assert!(reopened
        .subscription_membership_read("issues:crdt:{}")
        .unwrap()
        .is_empty());
}

#[test]
fn failed_pull_restores_dirty_projection_and_discards_displacement_archive() {
    let checkpoint = text_checkpoint("remote");
    let store =
        EmbeddedStore::open(tmp_path("membership_dirty_rollback.db").to_str().unwrap()).unwrap();
    store.setup(&crdt_schema()).unwrap();
    store
        .remote_page_write(&crdt_pull(
            SERVER_ID,
            &checkpoint,
            checkpoint.projection_hash.clone(),
            1.0,
        ))
        .unwrap();
    let local_id = rows(&store)[0]["_id"].as_str().unwrap().to_owned();
    store
        .commit(
            doc_writes(vec![DocWrite {
                table: "issues".into(),
                id: local_id.clone(),
                data: r#"{"body":"remote","title":"local dirty"}"#.into(),
                cols: vec![("status".into(), ColValue::Text("open".into()))],
                creation_time: 1.0,
            }]),
            &CommitOptions::default(),
        )
        .unwrap();

    let mut rejected = crdt_pull(
        SERVER_ID,
        &checkpoint,
        "wrong-projection-hash".into(),
        DOMINATING_CLOCK,
    );
    rejected.projections[0].plain_hash = "plain:server-winner".into();
    rejected.projections[0].projection_hash = "projection:server-winner".into();
    rejected.projections[0].row = Some(format!(
        r#"{{"_id":"{SERVER_ID}","_creationTime":1,"status":"open","title":"server winner","body":""}}"#
    ));
    assert!(matches!(
        store.remote_page_write(&rejected),
        Err(StorageError::Unsatisfiable(_))
    ));

    let documents = rows(&store);
    assert_eq!(documents[0]["title"], "local dirty");
    assert_eq!(store.dirty_heads_debug_read().unwrap().len(), 1);
    assert_eq!(
        store
            .remote_cursor_read("issues:crdt:{}")
            .unwrap()
            .as_deref(),
        Some("cursor:crdt")
    );
    let revisions = store
        .rev_read(&RowKey {
            table: "issues".into(),
            document_id: local_id,
        })
        .unwrap();
    assert!(!revisions
        .iter()
        .any(|revision| matches!(revision.lifecycle, RevLifecycle::Archived(_))));
}

#[test]
fn commit_fault_rolls_back_the_complete_mixed_pull_page() {
    let checkpoint = text_checkpoint("remote");
    let blob_key = format!("checkpoint.{}", checkpoint.hash);
    let path = tmp_path("membership_crdt_commit_fault.db");
    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&crdt_schema()).unwrap();
        let mut pull = crdt_pull(
            SERVER_ID,
            &checkpoint,
            checkpoint.projection_hash.clone(),
            DOMINATING_CLOCK,
        );
        pull.blobs.push(RemoteBlob {
            key: blob_key.clone(),
            bytes: checkpoint.bytes.clone(),
        });
        fail_next_commit();
        let rejected = store.remote_page_write(&pull);
        assert!(matches!(rejected, Err(StorageError::Turso(_))));
        assert!(rows(&store).is_empty());
        assert!(store.id_page_read("issues").unwrap().is_empty());
        assert!(store
            .subscription_membership_read("issues:crdt:{}")
            .unwrap()
            .is_empty());
        assert_eq!(store.remote_cursor_read("issues:crdt:{}").unwrap(), None);
        assert_eq!(store.blob_read(&blob_key).unwrap(), None);
        assert!(store.clock_read().unwrap() < DOMINATING_CLOCK);
    }
    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&crdt_schema()).unwrap();
    assert!(rows(&reopened).is_empty());
    assert!(reopened.id_page_read("issues").unwrap().is_empty());
    assert_eq!(reopened.blob_read(&blob_key).unwrap(), None);
}

#[test]
fn applied_push_settlement_is_one_crash_atomic_state() {
    let path = tmp_path("push_applied_atomic.db");
    let mutation_id = "push-applied-atomic";
    let local_id = "issues|11111111111111111111111111111111";
    let committed;
    let snapshot;
    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&crdt_schema()).unwrap();
        store
            .schedule_write(&ScheduledJob {
                job_id: "schedule:applied".into(),
                kind: ScheduledFunctionKind::Mutation,
                name: "issues:scheduled".into(),
                args: "{}".into(),
                due_time: 100,
                state: ScheduledState::Pending,
                created_time: 1,
                updated_time: 1,
            })
            .unwrap();
        committed = store
            .commit(
                WriteBatch {
                    doc_writes: vec![DocWrite {
                        table: "issues".into(),
                        id: local_id.into(),
                        data: r#"{"body":"","title":"local"}"#.into(),
                        cols: vec![("status".into(), ColValue::Text("open".into()))],
                        creation_time: 1.0,
                    }],
                    crdt_ops: vec![CrdtOp {
                        row: RowKey {
                            table: "issues".into(),
                            document_id: local_id.into(),
                        },
                        field: "body".into(),
                        operation: CrdtOperation::TextSplice {
                            index: 0,
                            delete: 0,
                            insert: "accepted".into(),
                        },
                    }],
                    ..WriteBatch::default()
                },
                &CommitOptions::default(),
            )
            .unwrap();
        snapshot = store
            .crdt_snapshot_read("issues", local_id)
            .unwrap()
            .remove(0);
        store
            .remote_push_envelope_write(
                mutation_id,
                committed.commit_seq,
                &format!(r#"{{"mutationId":"{mutation_id}"}}"#),
                2,
            )
            .unwrap();

        fail_next_commit();
        let failed = store.remote_settlement_write(&applied_settlement(
            mutation_id,
            committed.commit_seq,
            local_id,
            &snapshot,
            &committed.crdt_ops[0].update,
        ));
        assert!(
            matches!(failed, Err(StorageError::Turso(_))),
            "unexpected settlement result: {failed:?}"
        );
        assert_applied_settlement_before(&store, mutation_id, local_id);
    }

    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&crdt_schema()).unwrap();
        assert_applied_settlement_before(&store, mutation_id, local_id);
        store
            .remote_settlement_write(&applied_settlement(
                mutation_id,
                committed.commit_seq,
                local_id,
                &snapshot,
                &committed.crdt_ops[0].update,
            ))
            .unwrap();
        assert_applied_settlement_after(&store, mutation_id, local_id, snapshot.head_seq + 1);
    }

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&crdt_schema()).unwrap();
    assert_applied_settlement_after(&reopened, mutation_id, local_id, snapshot.head_seq + 1);
}

fn applied_settlement(
    mutation_id: &str,
    commit_seq: i64,
    local_id: &str,
    snapshot: &CrdtSnapshot,
    payload: &[u8],
) -> RemoteSettlementWrite {
    RemoteSettlementWrite {
        mutation_id: mutation_id.into(),
        expected_commit_seq: commit_seq,
        now_ms: 3,
        outcome: RemoteSettlementOutcome::Applied {
            ids: vec![RemoteIdMapping {
                table: "issues".into(),
                server_document_id: SERVER_ID.into(),
                local_document_id: local_id.into(),
            }],
            schedules: vec![RemoteScheduleMapping {
                local_id: "schedule:applied".into(),
                server_id: "hosted:schedule:applied".into(),
            }],
            projections: vec![AuthoritativeRow {
                table: "issues".into(),
                local_document_id: Some(local_id.into()),
                server_document_id: SERVER_ID.into(),
                plain_hash: "plain:accepted".into(),
                projection_hash: "projection:accepted".into(),
                current_root_id: None,
                current_node_id: None,
                row: Some(format!(
                    r#"{{"_id":"{SERVER_ID}","_creationTime":1,"status":"open","title":"accepted","body":"accepted"}}"#
                )),
                logical_clock: Some(100.0),
                received_time: 3,
            }],
            crdt: vec![CrdtRemoteWrite {
                table: "issues".into(),
                id: local_id.into(),
                field: "body".into(),
                kind: CrdtFieldKind::Text,
                head_seq: snapshot.head_seq + 1,
                projection_hash: snapshot.projection_hash.clone(),
                payload: payload.to_vec(),
            }],
        },
    }
}

fn assert_applied_settlement_before(store: &EmbeddedStore, mutation_id: &str, local_id: &str) {
    assert_eq!(
        store.schedule_read().unwrap()[0].state,
        ScheduledState::Pending
    );
    assert!(store.id_read("issues", local_id).unwrap().is_none());
    assert_eq!(
        store
            .crdt_remote_state("issues", local_id, "body", CrdtFieldKind::Text)
            .unwrap()
            .unwrap()
            .head_seq,
        0
    );
    assert_eq!(store.dirty_heads_debug_read().unwrap().len(), 1);
    assert_eq!(store.remote_push_envelope_read(10).unwrap().len(), 1);
    assert!(store.remote_receipt_read(10).unwrap().is_empty());
    assert!(store.remote_push_envelope_read(10).unwrap()[0].contains(mutation_id));
}

fn assert_applied_settlement_after(
    store: &EmbeddedStore,
    mutation_id: &str,
    local_id: &str,
    head_seq: i64,
) {
    assert_eq!(
        store.schedule_read().unwrap()[0].state,
        ScheduledState::Complete
    );
    assert_eq!(
        store
            .id_read("issues", local_id)
            .unwrap()
            .unwrap()
            .convex_id(),
        Some(SERVER_ID)
    );
    assert_eq!(rows(store)[0]["title"], "accepted");
    assert_eq!(
        store
            .crdt_remote_state("issues", local_id, "body", CrdtFieldKind::Text)
            .unwrap()
            .unwrap()
            .head_seq,
        head_seq
    );
    assert!(store.dirty_heads_debug_read().unwrap().is_empty());
    assert!(store.remote_push_envelope_read(10).unwrap().is_empty());
    assert_eq!(
        store.remote_receipt_read(10).unwrap(),
        vec![mutation_id.to_owned()]
    );
}

#[test]
fn rejected_push_settlement_is_one_crash_atomic_state() {
    let path = tmp_path("push_rejected_atomic.db");
    let mutation_id = "push-rejected-atomic";
    let local_id;
    let commit_seq;
    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&schema()).unwrap();
        store
            .remote_page_write(&snapshot(
                "issues:rejected:{}",
                vec![member(SERVER_ID)],
                vec![projection(SERVER_ID, "server base", 1.0, 1)],
                "cursor:rejected",
                1,
            ))
            .unwrap();
        local_id = rows(&store)[0]["_id"].as_str().unwrap().to_owned();
        store
            .schedule_write(&ScheduledJob {
                job_id: "schedule:rejected".into(),
                kind: ScheduledFunctionKind::Mutation,
                name: "issues:scheduled".into(),
                args: "{}".into(),
                due_time: 100,
                state: ScheduledState::Pending,
                created_time: 1,
                updated_time: 1,
            })
            .unwrap();
        commit_seq = store
            .commit(
                doc_writes(vec![DocWrite {
                    table: "issues".into(),
                    id: local_id.clone(),
                    data: r#"{"title":"local rejected"}"#.into(),
                    cols: vec![("status".into(), ColValue::Text("open".into()))],
                    creation_time: 1.0,
                }]),
                &CommitOptions::default(),
            )
            .unwrap()
            .commit_seq;
        store
            .remote_push_envelope_write(
                mutation_id,
                commit_seq,
                &format!(r#"{{"mutationId":"{mutation_id}"}}"#),
                2,
            )
            .unwrap();

        fail_next_commit();
        let failed =
            store.remote_settlement_write(&rejected_settlement(mutation_id, commit_seq, &local_id));
        assert!(
            matches!(failed, Err(StorageError::Turso(_))),
            "unexpected settlement result: {failed:?}"
        );
        assert_rejected_settlement_before(&store, mutation_id, &local_id);
    }

    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&schema()).unwrap();
        assert_rejected_settlement_before(&store, mutation_id, &local_id);
        let result = store
            .remote_settlement_write(&rejected_settlement(mutation_id, commit_seq, &local_id))
            .unwrap();
        assert_eq!(result.projection.reroots.len(), 1);
        assert_rejected_settlement_after(&store, mutation_id, &local_id);
    }

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&schema()).unwrap();
    assert_rejected_settlement_after(&reopened, mutation_id, &local_id);
}

fn rejected_settlement(
    mutation_id: &str,
    commit_seq: i64,
    local_id: &str,
) -> RemoteSettlementWrite {
    RemoteSettlementWrite {
        mutation_id: mutation_id.into(),
        expected_commit_seq: commit_seq,
        now_ms: 3,
        outcome: RemoteSettlementOutcome::Rejected {
            schedules: vec!["schedule:rejected".into()],
            targets: vec![RemoteRowTarget {
                table: "issues".into(),
                local_document_id: local_id.into(),
                server_rev_id: Some("rev:rejected".into()),
                retain: true,
            }],
            projections: Vec::new(),
        },
    }
}

fn assert_rejected_settlement_before(store: &EmbeddedStore, mutation_id: &str, local_id: &str) {
    assert_eq!(rows(store)[0]["title"], "local rejected");
    assert_eq!(store.dirty_heads_debug_read().unwrap().len(), 1);
    assert_eq!(
        store.schedule_read().unwrap()[0].state,
        ScheduledState::Pending
    );
    assert!(store
        .rev_read(&RowKey {
            table: "issues".into(),
            document_id: local_id.into(),
        })
        .unwrap()
        .iter()
        .all(|revision| !matches!(revision.lifecycle, RevLifecycle::Archived(_))));
    assert!(store.remote_push_envelope_read(10).unwrap()[0].contains(mutation_id));
    assert!(store.remote_receipt_read(10).unwrap().is_empty());
}

fn assert_rejected_settlement_after(store: &EmbeddedStore, mutation_id: &str, local_id: &str) {
    assert_eq!(rows(store)[0]["title"], "server base");
    assert!(store.dirty_heads_debug_read().unwrap().is_empty());
    assert_eq!(
        store.schedule_read().unwrap()[0].state,
        ScheduledState::Failed
    );
    let revisions = store
        .rev_read(&RowKey {
            table: "issues".into(),
            document_id: local_id.into(),
        })
        .unwrap();
    assert_eq!(
        revisions
            .iter()
            .filter(|revision| matches!(revision.lifecycle, RevLifecycle::Archived(_)))
            .count(),
        1
    );
    assert!(revisions.iter().any(|revision| matches!(
        &revision.lifecycle,
        RevLifecycle::Archived(metadata)
            if metadata.server_rev_id.as_deref() == Some("rev:rejected")
    )));
    assert!(store.remote_push_envelope_read(10).unwrap().is_empty());
    assert_eq!(
        store.remote_receipt_read(10).unwrap(),
        vec![mutation_id.to_owned()]
    );
}

#[test]
fn older_rejection_preserves_a_newer_dirty_head_and_updates_its_server_base() {
    let path = tmp_path("push_rejected_older.db");
    let mutation_id = "push-rejected-older";
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .remote_page_write(&snapshot(
            "issues:rejected-older:{}",
            vec![member(SERVER_ID)],
            vec![projection(SERVER_ID, "server base", 1.0, 1)],
            "cursor:rejected-older",
            1,
        ))
        .unwrap();
    let local_id = rows(&store)[0]["_id"].as_str().unwrap().to_owned();
    let older = store
        .commit(
            doc_writes(vec![DocWrite {
                table: "issues".into(),
                id: local_id.clone(),
                data: r#"{"title":"older local"}"#.into(),
                cols: vec![("status".into(), ColValue::Text("open".into()))],
                creation_time: 1.0,
            }]),
            &CommitOptions::default(),
        )
        .unwrap();
    store
        .remote_push_envelope_write(mutation_id, older.commit_seq, "{}", 2)
        .unwrap();
    let newer = store
        .commit(
            doc_writes(vec![DocWrite {
                table: "issues".into(),
                id: local_id.clone(),
                data: r#"{"title":"newer local"}"#.into(),
                cols: vec![("status".into(), ColValue::Text("open".into()))],
                creation_time: 1.0,
            }]),
            &CommitOptions::default(),
        )
        .unwrap();
    let mut authoritative = projection(SERVER_ID, "new server base", 2.0, 3);
    authoritative.local_document_id = Some(local_id.clone());

    let result = store
        .remote_settlement_write(&RemoteSettlementWrite {
            mutation_id: mutation_id.into(),
            expected_commit_seq: older.commit_seq,
            now_ms: 3,
            outcome: RemoteSettlementOutcome::Rejected {
                schedules: Vec::new(),
                targets: vec![RemoteRowTarget {
                    table: "issues".into(),
                    local_document_id: local_id.clone(),
                    server_rev_id: None,
                    retain: false,
                }],
                projections: vec![authoritative],
            },
        })
        .unwrap();

    assert!(result.projection.reroots.is_empty());
    assert_eq!(rows(&store)[0]["title"], "newer local");
    let dirty = store.dirty_heads_debug_read().unwrap();
    assert_eq!(dirty.len(), 1);
    assert_eq!(dirty[0].updated_commit_seq, newer.commit_seq);
    let projection = store.remote_doc_read("issues", &local_id).unwrap().unwrap();
    assert!(projection
        .server_row
        .as_deref()
        .is_some_and(|row| row.contains("new server base")));
    assert!(store.remote_push_envelope_read(10).unwrap().is_empty());
    assert_eq!(
        store.remote_receipt_read(10).unwrap(),
        vec![mutation_id.to_owned()]
    );
}

#[test]
fn rejected_crdt_settlement_restores_the_accepted_opaque_state() {
    let path = tmp_path("push_rejected_crdt.db");
    let mutation_id = "push-rejected-crdt";
    let checkpoint = text_checkpoint("remote");
    let local_id;
    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&crdt_schema()).unwrap();
        store
            .remote_page_write(&crdt_pull(
                SERVER_ID,
                &checkpoint,
                checkpoint.projection_hash.clone(),
                1.0,
            ))
            .unwrap();
        local_id = rows(&store)[0]["_id"].as_str().unwrap().to_owned();
        let commit_seq = store
            .commit(
                WriteBatch {
                    doc_writes: vec![DocWrite {
                        table: "issues".into(),
                        id: local_id.clone(),
                        data: r#"{"body":"remote-local","title":"local"}"#.into(),
                        cols: vec![("status".into(), ColValue::Text("open".into()))],
                        creation_time: 1.0,
                    }],
                    crdt_ops: vec![CrdtOp {
                        row: RowKey {
                            table: "issues".into(),
                            document_id: local_id.clone(),
                        },
                        field: "body".into(),
                        operation: CrdtOperation::TextSplice {
                            index: 6,
                            delete: 0,
                            insert: "-local".into(),
                        },
                    }],
                    ..WriteBatch::default()
                },
                &CommitOptions::default(),
            )
            .unwrap()
            .commit_seq;
        assert_eq!(rows(&store)[0]["body"], "remote-local");
        store
            .remote_push_envelope_write(mutation_id, commit_seq, "{}", 2)
            .unwrap();
        let result = store
            .remote_settlement_write(&RemoteSettlementWrite {
                mutation_id: mutation_id.into(),
                expected_commit_seq: commit_seq,
                now_ms: 3,
                outcome: RemoteSettlementOutcome::Rejected {
                    schedules: Vec::new(),
                    targets: vec![RemoteRowTarget {
                        table: "issues".into(),
                        local_document_id: local_id.clone(),
                        server_rev_id: None,
                        retain: true,
                    }],
                    projections: Vec::new(),
                },
            })
            .unwrap();
        assert_eq!(result.projection.reroots.len(), 1);
        assert_rejected_crdt_base(&store, &local_id, checkpoint.head_seq);
    }

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&crdt_schema()).unwrap();
    assert_rejected_crdt_base(&reopened, &local_id, checkpoint.head_seq);
}

fn assert_rejected_crdt_base(store: &EmbeddedStore, local_id: &str, head_seq: i64) {
    assert_eq!(rows(store)[0]["body"], "remote");
    let state = store
        .crdt_remote_state("issues", local_id, "body", CrdtFieldKind::Text)
        .unwrap()
        .unwrap();
    assert_eq!(state.head_seq, head_seq);
    assert_eq!(state.projection, serde_json::Value::String("remote".into()));
    assert!(store.dirty_heads_debug_read().unwrap().is_empty());
}
