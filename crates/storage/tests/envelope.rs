//! envelope + pull primitives — the mutation-replay durable push queue (§11 D2), the per-row
//! adoption-version sidecar (§11 D1), and `logical_clock = seq` on a `PullPage` apply. Run with
//! `--features testkit`.
#![cfg(feature = "testkit")]

use storage::testkit::*;
use storage::*;

const SERVER_ID: &str = "j575pnjjhzf95ze91djp5v26b188xreb";

fn pull_projection(server_id: &str, status: &str, seq: f64) -> AuthoritativeRow {
    AuthoritativeRow {
        current_node_id: None,
        current_root_id: None,
        local_document_id: None,
        plain_hash: format!("plain:{server_id}:{seq}"),
        projection_hash: format!("sha256:{server_id}:{seq}"),
        logical_clock: Some(seq),
        received_time: 5,
        row: Some(format!(
            r#"{{"_id":"{server_id}","_creationTime":1,"status":"{status}"}}"#
        )),
        server_document_id: server_id.into(),
        table: "issues".into(),
    }
}

fn pull(
    projections: Vec<AuthoritativeRow>,
    cursor: Option<&str>,
    received_time: i64,
) -> RemotePull {
    let members = projections
        .iter()
        .filter(|projection| projection.row.is_some())
        .map(|projection| RemoteMember {
            table: projection.table.clone(),
            server_document_id: projection.server_document_id.clone(),
        })
        .collect();
    RemotePull {
        subscription: "issues:list:{}".into(),
        members,
        projections,
        crdt: Vec::new(),
        blobs: Vec::new(),
        cursor: cursor.map(str::to_owned),
        received_time,
        result: None,
    }
}

#[test]
fn push_envelope_queue_reads_in_ordinal_order_and_drains_on_complete() {
    let store = EmbeddedStore::open(tmp_path("envelope_order.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    assert!(store.remote_push_envelope_read(1).unwrap().is_empty());
    let mut commit_seqs = Vec::new();
    for (ordinal, op_id) in ["op-a", "op-b"].into_iter().enumerate() {
        let committed = store
            .commit(
                upserts(vec![issue(
                    &store,
                    &format!("row-{ordinal}"),
                    op_id,
                    "open",
                )]),
                &CommitOptions::terminal(
                    MutationCall {
                        args: "{}".into(),
                        mutation_id: op_id.into(),
                        name: "issues:write".into(),
                    },
                    "null",
                    false,
                    Some(CommitPush {
                        mutation_id: op_id.into(),
                        json: format!(r#"{{"mutationId":"{op_id}","commitSeq":0,"crdt":[]}}"#),
                        now_ms: 5,
                    }),
                ),
            )
            .unwrap();
        commit_seqs.push(committed.commit_seq);
    }

    let first = store.remote_push_envelope_read(1).unwrap().remove(0);
    assert!(first.contains(r#""mutationId":"op-a""#));

    store
        .remote_push_settle(&RemotePushSettlement {
            mutation_id: "op-a".to_owned(),
            expected_commit_seq: commit_seqs[0],
            now_ms: 6,
            outcome: RemotePushSettlementOutcome::Applied {
                ids: Vec::new(),
                schedules: Vec::new(),
                projections: Vec::new(),
                crdt: Vec::new(),
            },
        })
        .unwrap();
    assert_eq!(store.remote_settlement_ack_read(10).unwrap(), vec!["op-a"]);
    store
        .remote_settlement_ack_complete(&["op-a".to_owned()])
        .unwrap();
    let second = store.remote_push_envelope_read(1).unwrap().remove(0);
    assert!(second.contains(r#""mutationId":"op-b""#));

    store
        .remote_push_settle(&RemotePushSettlement {
            mutation_id: "op-b".to_owned(),
            expected_commit_seq: commit_seqs[1],
            now_ms: 7,
            outcome: RemotePushSettlementOutcome::Applied {
                ids: Vec::new(),
                schedules: Vec::new(),
                projections: Vec::new(),
                crdt: Vec::new(),
            },
        })
        .unwrap();
    assert!(store.remote_push_envelope_read(1).unwrap().is_empty());
    assert_eq!(store.remote_settlement_ack_read(10).unwrap(), vec!["op-b"]);
    store
        .remote_settlement_ack_complete(&["op-b".to_owned()])
        .unwrap();
    assert!(store.remote_settlement_ack_read(10).unwrap().is_empty());
}

#[test]
fn local_commit_writes_its_push_envelope_atomically() {
    let store = EmbeddedStore::open(tmp_path("envelope_commit.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let options = CommitOptions::terminal(
        MutationCall {
            args: "{}".into(),
            mutation_id: "mutation-1".into(),
            name: "issues:write".into(),
        },
        "null",
        false,
        Some(CommitPush {
            mutation_id: "mutation-1".into(),
            json: r#"{"mutationId":"mutation-1","commitSeq":0,"crdt":[]}"#.into(),
            now_ms: 5,
        }),
    );

    let committed = store
        .commit(
            upserts(vec![issue(&store, "first", "first", "open")]),
            &options,
        )
        .unwrap();
    let envelope: serde_json::Value =
        serde_json::from_str(&store.remote_push_envelope_read(1).unwrap().remove(0)).unwrap();
    assert_eq!(envelope["commitSeq"], committed.commit_seq);
    assert!(store.doc_read("issues", "first").unwrap().is_some());

    let rejected = store.commit(
        upserts(vec![issue(&store, "second", "second", "open")]),
        &CommitOptions::terminal(
            MutationCall {
                args: "{}".into(),
                mutation_id: "mutation-2".into(),
                name: "issues:write".into(),
            },
            "null",
            false,
            Some(CommitPush {
                mutation_id: "mutation-2".into(),
                json: r#"{"mutationId":"mutation-2"}"#.into(),
                now_ms: 6,
            }),
        ),
    );
    assert!(rejected.is_err());
    assert!(store.doc_read("issues", "second").unwrap().is_none());
}

#[test]
fn push_only_commit_does_not_create_a_local_retry_record() {
    let store = EmbeddedStore::open(tmp_path("envelope_push_only.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let options = CommitOptions::decode(
        Some("local"),
        Some("mutation-push-only".into()),
        None,
        None,
        None,
        Some(r#"{"mutationId":"mutation-push-only","commitSeq":0,"crdt":[]}"#.into()),
        Some(5),
        false,
        false,
    )
    .expect("push-only commit metadata must decode");

    store
        .commit(
            upserts(vec![issue(&store, "push-only", "push-only", "open")]),
            &options,
        )
        .unwrap();

    assert!(store.doc_read("issues", "push-only").unwrap().is_some());
    assert_eq!(store.remote_push_envelope_read(1).unwrap().len(), 1);
    assert_eq!(
        store
            .mutation_begin(&MutationCall {
                args: "{}".into(),
                mutation_id: "mutation-push-only".into(),
                name: "issues:write".into(),
            })
            .unwrap()
            .status,
        MutationStatus::Accepted,
    );
}

#[test]
fn pull_apply_stamps_logical_clock_seq_into_the_read_page_versions_sidecar() {
    let store = EmbeddedStore::open(tmp_path("envelope_sidecar.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    store
        .remote_pull_page(&pull(
            vec![pull_projection(SERVER_ID, "open", 41.0)],
            Some("c:1:41"),
            5,
        ))
        .unwrap();

    let page = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            ..ReadSpec::default()
        })
        .unwrap();
    let docs = parse_docs(&page);
    assert_eq!(docs.len(), 1);
    let local_id = docs[0]["_id"].as_str().unwrap();
    assert_eq!(
        page.versions.get(local_id),
        Some(&41),
        "the sidecar carries the pull seq the row was adopted at"
    );
}

#[test]
fn a_higher_seq_pull_change_wins_over_a_lower_one() {
    let store = EmbeddedStore::open(tmp_path("envelope_lww.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    store
        .remote_pull_page(&pull(
            vec![pull_projection(SERVER_ID, "old", 10.0)],
            Some("c:1:10"),
            5,
        ))
        .unwrap();
    store
        .remote_pull_page(&pull(
            vec![pull_projection(SERVER_ID, "new", 20.0)],
            Some("c:1:20"),
            6,
        ))
        .unwrap();

    let page = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            ..ReadSpec::default()
        })
        .unwrap();
    let docs = parse_docs(&page);
    assert_eq!(docs[0]["status"], "new");
    let local_id = docs[0]["_id"].as_str().unwrap();
    assert_eq!(page.versions.get(local_id), Some(&20));
}

#[test]
fn accepted_older_local_write_advances_server_base_without_overwriting_newer_edit() {
    let store = EmbeddedStore::open(tmp_path("envelope_chain.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .remote_pull_page(&pull(
            vec![pull_projection(SERVER_ID, "seed", 1.0)],
            None,
            1,
        ))
        .unwrap();
    let page = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            ..ReadSpec::default()
        })
        .unwrap();
    let local_id = parse_docs(&page)[0]["_id"].as_str().unwrap().to_owned();
    let first = commit(
        &store,
        upserts(vec![issue(&store, &local_id, "first", "first")]),
    );
    commit(
        &store,
        upserts(vec![issue(&store, &local_id, "second", "second")]),
    );
    let original_projection_hash = store
        .projection_read("issues", &local_id)
        .unwrap()
        .unwrap()
        .projection_hash;
    let mut confirmed = pull_projection(SERVER_ID, "first", 2.0);
    confirmed.local_document_id = Some(local_id.clone());
    confirmed.plain_hash = "plain:first".into();
    confirmed.projection_hash = "wire:first".into();
    store
        .remote_push_envelope_write("older-write", first.commit_seq, "{}", 5)
        .unwrap();

    store
        .remote_push_settle(&RemotePushSettlement {
            mutation_id: "older-write".to_owned(),
            expected_commit_seq: first.commit_seq,
            now_ms: 6,
            outcome: RemotePushSettlementOutcome::Applied {
                ids: Vec::new(),
                schedules: Vec::new(),
                projections: vec![confirmed],
                crdt: Vec::new(),
            },
        })
        .unwrap();

    assert_eq!(
        read_doc(&store, "issues", &local_id).unwrap()["title"],
        "second"
    );
    let projection = store.projection_read("issues", &local_id).unwrap().unwrap();
    assert_eq!(projection.server_base.as_deref(), Some("plain:first"));
    assert!((projection.logical_clock - 2.0).abs() < f64::EPSILON);
    assert_eq!(projection.projection_hash, original_projection_hash);
}

#[test]
fn a_complete_membership_exit_removes_the_row() {
    let store = EmbeddedStore::open(tmp_path("envelope_del.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    store
        .remote_pull_page(&pull(
            vec![pull_projection(SERVER_ID, "open", 10.0)],
            Some("c:1:10"),
            5,
        ))
        .unwrap();

    store
        .remote_pull_page(&pull(Vec::new(), Some("c:1:20"), 6))
        .unwrap();

    let page = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            ..ReadSpec::default()
        })
        .unwrap();
    assert_eq!(parse_docs(&page).len(), 0);
}

fn seed_dirty_row(store: &EmbeddedStore) -> (String, CommitResult) {
    store.setup(&schema()).unwrap();
    store
        .remote_pull_page(&pull(
            vec![pull_projection(SERVER_ID, "seed", 1.0)],
            Some("c:1:1"),
            1,
        ))
        .unwrap();
    let local_id = parse_docs(
        &store
            .doc_page_read(&ReadSpec {
                table: "issues".into(),
                ..ReadSpec::default()
            })
            .unwrap(),
    )[0]["_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let edit = commit(
        store,
        upserts(vec![issue(store, &local_id, "local-dirty", "dirty")]),
    );
    store
        .remote_push_envelope_write("dirty-edit", edit.commit_seq, "{}", 2)
        .unwrap();
    (local_id, edit)
}

fn archived_revs(store: &EmbeddedStore, local_id: &str) -> usize {
    store
        .rev_read(&RowKey {
            table: "issues".into(),
            document_id: local_id.into(),
        })
        .unwrap()
        .iter()
        .filter(|revision| matches!(revision.lifecycle, RevLifecycle::Archived(_)))
        .count()
}

#[test]
fn pull_over_a_dirty_row_retains_the_displaced_edit_and_adopts_the_authoritative_row() {
    let store =
        EmbeddedStore::open(tmp_path("envelope_pull_over_dirty.db").to_str().unwrap()).unwrap();
    let (local_id, _edit) = seed_dirty_row(&store);

    let result = store
        .remote_pull_page(&pull(
            vec![pull_projection(SERVER_ID, "hosted", 2.0)],
            Some("c:1:2"),
            3,
        ))
        .unwrap();

    assert_eq!(result.projection.reroots.len(), 1);
    assert_eq!(
        read_doc(&store, "issues", &local_id).unwrap()["status"],
        "hosted"
    );
    assert_eq!(archived_revs(&store, &local_id), 1);
    assert!(store.dirty_heads_debug_read().unwrap().is_empty());
    assert_eq!(
        store.remote_push_envelope_read(10).unwrap().len(),
        1,
        "the displaced operation's push envelope stays durable to settle later"
    );
}

#[test]
fn a_fault_while_adopting_over_a_dirty_row_leaves_no_mixed_state() {
    let path = tmp_path("envelope_pull_over_dirty_fault.db");
    let local_id;
    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        (local_id, _) = seed_dirty_row(&store);
        fail_next_commit();
        assert!(matches!(
            store.remote_pull_page(&pull(
                vec![pull_projection(SERVER_ID, "hosted", 2.0)],
                Some("c:1:2"),
                3,
            )),
            Err(StorageError::Turso(_))
        ));
        assert_eq!(
            read_doc(&store, "issues", &local_id).unwrap()["title"],
            "local-dirty"
        );
        assert_eq!(archived_revs(&store, &local_id), 0);
        assert_eq!(store.dirty_heads_debug_read().unwrap().len(), 1);
    }

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&schema()).unwrap();
    assert_eq!(
        read_doc(&reopened, "issues", &local_id).unwrap()["title"],
        "local-dirty"
    );
    assert_eq!(archived_revs(&reopened, &local_id), 0);
    assert_eq!(reopened.dirty_heads_debug_read().unwrap().len(), 1);
}

#[test]
fn a_pull_echoing_the_accepted_base_leaves_a_newer_dirty_edit_current() {
    let store = EmbeddedStore::open(tmp_path("envelope_pull_echo.db").to_str().unwrap()).unwrap();
    let (local_id, _edit) = seed_dirty_row(&store);

    let result = store
        .remote_pull_page(&pull(
            vec![pull_projection(SERVER_ID, "seed", 1.0)],
            Some("c:1:1b"),
            4,
        ))
        .unwrap();

    assert!(result.projection.reroots.is_empty());
    assert_eq!(
        read_doc(&store, "issues", &local_id).unwrap()["title"],
        "local-dirty"
    );
    assert_eq!(archived_revs(&store, &local_id), 0);
    assert_eq!(store.dirty_heads_debug_read().unwrap().len(), 1);
    assert_eq!(store.remote_push_envelope_read(10).unwrap().len(), 1);
}

#[test]
fn a_higher_clock_echo_of_the_dirty_base_still_leaves_the_dirty_edit_current() {
    let store =
        EmbeddedStore::open(tmp_path("envelope_pull_echo_higher.db").to_str().unwrap()).unwrap();
    let (local_id, _edit) = seed_dirty_row(&store);

    let mut echo = pull_projection(SERVER_ID, "hosted-newer", 3.0);
    echo.plain_hash = format!("plain:{SERVER_ID}:1");

    let result = store
        .remote_pull_page(&pull(vec![echo], Some("c:1:3echo"), 5))
        .unwrap();

    assert!(
        result.projection.reroots.is_empty(),
        "an echo of the accepted base never reroots, even at a higher clock"
    );
    assert_eq!(
        read_doc(&store, "issues", &local_id).unwrap()["title"],
        "local-dirty",
        "the own-echo guard keeps the dirty optimistic value current despite the higher clock"
    );
    assert_eq!(
        archived_revs(&store, &local_id),
        0,
        "the dirty edit must not be archived by an echo of its own accepted base"
    );
    assert_eq!(store.dirty_heads_debug_read().unwrap().len(), 1);
    assert_eq!(
        store.remote_push_envelope_read(10).unwrap().len(),
        1,
        "the displaced operation's push envelope stays durable to settle later"
    );
}
