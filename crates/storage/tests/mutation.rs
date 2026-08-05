//! mutation — migrated from the former inline `src/tests.rs`, reaching private internals only
//! through `storage::testkit`. Run with `--features testkit`.
#![cfg(feature = "testkit")]
#![allow(
    clippy::too_many_lines,
    clippy::unreadable_literal,
    clippy::similar_names
)]

use storage::testkit::*;
use storage::*;

#[test]
fn commit_metadata_rejects_partial_and_cross_source_variants() {
    assert!(CommitOptions::decode(
        Some("local"),
        Some("mutation-1".into()),
        Some("issues:send".into()),
        Some("{}".into()),
        Some("null".into()),
        Some("{}".into()),
        None,
        false,
        false,
    )
    .is_none());
    assert!(CommitOptions::decode(
        Some("local"),
        Some("mutation-1".into()),
        Some("issues:send".into()),
        None,
        Some("null".into()),
        None,
        None,
        false,
        false,
    )
    .is_none());
    assert!(CommitOptions::decode(
        Some("remote"),
        Some("mutation-1".into()),
        None,
        None,
        None,
        None,
        None,
        false,
        true,
    )
    .is_none());
    assert!(CommitOptions::decode(
        Some("seed"),
        None,
        None,
        None,
        None,
        None,
        None,
        false,
        true,
    )
    .is_none());
}

#[test]
fn duplicate_mutation_id_rolls_back_second_batch() {
    let store = EmbeddedStore::open(tmp_path("rs_mutation_id.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .mutation_write(&MutationCall {
            args: "{}".into(),
            mutation_id: "mutation-1".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    let options = CommitOptions::existing("mutation-1", None);

    store
        .commit(
            doc_writes(vec![issue(&store, "first", "first", "open")]),
            &options,
        )
        .unwrap();
    let duplicate = store.commit(
        doc_writes(vec![issue(&store, "second", "second", "open")]),
        &options,
    );

    assert!(matches!(duplicate, Err(StorageError::Unsatisfiable(_))));
    assert!(store.doc_read("issues", "first").unwrap().is_some());
    assert!(store.doc_read("issues", "second").unwrap().is_none());
}

#[test]
fn mutation_id_commit_requires_accepted_record() {
    let store = EmbeddedStore::open(tmp_path("rs_unbegun_mutation.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let err = store.commit(
        doc_writes(vec![issue(&store, "missing", "missing", "open")]),
        &CommitOptions::existing("mutation-missing", None),
    );

    assert!(matches!(err, Err(StorageError::Unsatisfiable(_))));
    assert!(store.doc_read("issues", "missing").unwrap().is_none());
}

#[test]
fn first_seen_mutation_id_commits_terminal_record() {
    let store =
        EmbeddedStore::open(tmp_path("rs_terminal_mutation_commit.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let result = store
        .commit(
            doc_writes(vec![issue(&store, "first-seen", "first", "open")]),
            &CommitOptions::terminal(
                MutationCall {
                    args: r#"{"body":"first"}"#.into(),
                    mutation_id: "mutation-first-seen".into(),
                    name: "issues:send".into(),
                },
                r#""first-seen""#,
                false,
                None,
            ),
        )
        .unwrap();

    let record = store
        .mutation_cache_read(&MutationCall {
            args: r#"{"body":"first"}"#.into(),
            mutation_id: "mutation-first-seen".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    assert_eq!(record.status, MutationStatus::Committed);
    assert_eq!(record.commit_seq, Some(result.commit_seq));
    assert_eq!(record.result.as_deref(), Some(r#""first-seen""#));
    assert!(store.doc_read("issues", "first-seen").unwrap().is_some());
}

#[test]
fn mutation_id_replay_returns_committed_result() {
    let store =
        EmbeddedStore::open(tmp_path("rs_mutation_replay_result.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let call = MutationCall {
        args: r#"{"body":"first"}"#.into(),
        mutation_id: "mutation-replay".into(),
        name: "issues:send".into(),
    };
    store.mutation_write(&call).unwrap();
    let commit = store
        .commit(
            doc_writes(vec![issue(&store, "replayed", "first", "open")]),
            &CommitOptions::terminal(call.clone(), r#"{"ok":true,"id":"replayed"}"#, false, None),
        )
        .unwrap();

    let replay = store.mutation_write(&call).unwrap();
    assert_eq!(replay.status, MutationStatus::Committed);
    assert_eq!(replay.commit_seq, Some(commit.commit_seq));
    assert_eq!(
        replay.result.as_deref(),
        Some(r#"{"ok":true,"id":"replayed"}"#)
    );
    assert!(store.doc_read("issues", "replayed").unwrap().is_some());
}

#[test]
fn lookup_absent_mutation_id_commits_terminal_record() {
    let store = EmbeddedStore::open(
        tmp_path("rs_lookup_terminal_mutation_commit.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    store.setup(&schema()).unwrap();
    let call = MutationCall {
        args: r#"{"body":"first"}"#.into(),
        mutation_id: "mutation-lookup-first-seen".into(),
        name: "issues:send".into(),
    };
    assert_eq!(
        store.mutation_cache_read(&call).unwrap().status,
        MutationStatus::Accepted
    );

    let result = store
        .commit(
            doc_writes(vec![issue(&store, "lookup-first-seen", "first", "open")]),
            &CommitOptions::terminal(call.clone(), r#""lookup-first-seen""#, false, None),
        )
        .unwrap();

    let record = store.mutation_cache_read(&call).unwrap();
    assert_eq!(record.status, MutationStatus::Committed);
    assert_eq!(record.commit_seq, Some(result.commit_seq));
    assert_eq!(record.result.as_deref(), Some(r#""lookup-first-seen""#));
    assert!(store
        .doc_read("issues", "lookup-first-seen")
        .unwrap()
        .is_some());
}

#[test]
fn lookup_absent_mutation_id_fails_terminal_record() {
    let store = EmbeddedStore::open(
        tmp_path("rs_lookup_terminal_mutation_fail.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    store.setup(&schema()).unwrap();
    let call = MutationCall {
        args: r#"{"body":"fail"}"#.into(),
        mutation_id: "mutation-lookup-failed".into(),
        name: "issues:send".into(),
    };
    assert_eq!(
        store.mutation_cache_read(&call).unwrap().status,
        MutationStatus::Accepted
    );

    store
        .mutation_fail(&call.mutation_id, "handler failed")
        .unwrap();

    let record = store.mutation_cache_read(&call).unwrap();
    assert_eq!(record.status, MutationStatus::Failed);
    assert_eq!(record.error.as_deref(), Some("handler failed"));
    assert_eq!(record.result, None);
    assert_eq!(record.commit_seq, None);

    let err = store.commit(
        doc_writes(vec![issue(&store, "failed-lookup", "failed", "open")]),
        &CommitOptions::terminal(call, "null", false, None),
    );

    assert!(matches!(err, Err(StorageError::Unsatisfiable(_))));
    assert!(store.doc_read("issues", "failed-lookup").unwrap().is_none());
}

#[test]
fn failed_mutation_cannot_be_committed() {
    let store =
        EmbeddedStore::open(tmp_path("rs_failed_mutation_commit.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .mutation_write(&MutationCall {
            args: "{}".into(),
            mutation_id: "m1".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    store.mutation_fail("m1", "local failed").unwrap();

    let err = store.commit(
        doc_writes(vec![issue(&store, "failed", "failed", "open")]),
        &CommitOptions::existing("m1", None),
    );

    assert!(matches!(err, Err(StorageError::Unsatisfiable(_))));
    assert!(store.doc_read("issues", "failed").unwrap().is_none());
}

#[test]
fn commit_timestamp_is_substituted_atomically_and_is_monotonic() {
    let store = EmbeddedStore::open(tmp_path("rs_commit_timestamp.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    let timestamp_write = DocWrite {
        table: "issues".into(),
        id: "timestamped".into(),
        data: r#"{"status":{"$commitTs":null},"title":"timestamped"}"#.into(),
        cols: vec![("status".into(), ColValue::PendingCommitTs)],
        creation_time: store.clock_read().unwrap(),
    };
    let options = CommitOptions {
        commit_ts: true,
        ..CommitOptions::default()
    };
    let mut timestamp_batch = doc_writes(vec![timestamp_write]);
    timestamp_batch.commit_ts_doc_writes.push(0);
    let first = store
        .commit(timestamp_batch, &options)
        .unwrap()
        .commit_ts
        .expect("timestamp request must return the allocated i64");

    let row =
        read_doc(&store, "issues", "timestamped").expect("timestamped document must be durable");
    let encoded = row["status"]["$integer"]
        .as_str()
        .expect("timestamp must be encoded as Convex int64 JSON");
    let bytes = base64::decode(encoded).expect("timestamp int64 must be base64");
    let timestamp = i64::from_le_bytes(bytes.try_into().expect("timestamp is eight bytes"));
    assert_eq!(timestamp, first);
    assert!(!row.to_string().contains("$commitTs"));

    let second = store
        .commit(
            doc_writes(vec![issue(&store, "next", "next", "open")]),
            &options,
        )
        .unwrap()
        .commit_ts
        .expect("second timestamp request must return a timestamp");
    assert!(second > first);
}

#[test]
fn commit_timestamp_resolves_flagged_results_and_push_after_images_only() {
    let store =
        EmbeddedStore::open(tmp_path("rs_commit_timestamp_push.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let mutation_id = "timestamp-push";
    let mut options = CommitOptions::terminal(
        MutationCall {
            args: "{}".into(),
            mutation_id: mutation_id.into(),
            name: "issues:timestamp".into(),
        },
        r#"{"first":{"$commitTs":null},"second":{"$commitTs":null}}"#,
        true,
        Some(CommitPush {
            mutation_id: mutation_id.into(),
            json: r#"{"mutationId":"timestamp-push","afterImages":[{"content":"value","table":"issues","rowId":"i1","value":{"stamp":{"$commitTs":null}}}],"crdt":[],"logical":{"$commitTs":null}}"#.into(),
            now_ms: 1,
            after_images_commit_ts: true,
        }),
    );
    options.commit_ts = true;
    options.mutation_result_commit_ts = true;

    let committed = store.commit(WriteBatch::default(), &options).unwrap();
    let timestamp = committed.commit_ts.expect("timestamp allocated");
    let record = store
        .mutation_cache_read(&MutationCall {
            args: "{}".into(),
            mutation_id: mutation_id.into(),
            name: "issues:timestamp".into(),
        })
        .unwrap();
    let result: serde_json::Value =
        serde_json::from_str(record.result.as_deref().unwrap()).unwrap();
    let encoded = base64::encode(timestamp.to_le_bytes());
    assert_eq!(result["first"]["$integer"], encoded);
    assert_eq!(result["second"]["$integer"], encoded);

    let envelope: serde_json::Value =
        serde_json::from_str(&store.remote_push_envelope_read(1).unwrap().remove(0)).unwrap();
    assert_eq!(
        envelope["afterImages"][0]["value"]["stamp"]["$integer"],
        encoded
    );
    assert_eq!(envelope["logical"]["$commitTs"], serde_json::Value::Null);
}

#[test]
fn commit_timestamp_resolution_error_rolls_back_the_open_transaction() {
    let store = EmbeddedStore::open(
        tmp_path("rs_commit_timestamp_rollback.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    store.setup(&schema()).unwrap();
    let mut invalid = WriteBatch::default();
    invalid.commit_ts_doc_writes.push(9);
    let options = CommitOptions {
        commit_ts: true,
        ..CommitOptions::default()
    };
    assert!(matches!(
        store.commit(invalid, &options),
        Err(StorageError::Unsatisfiable(_))
    ));

    store
        .commit(
            doc_writes(vec![issue(&store, "after", "after", "open")]),
            &CommitOptions::default(),
        )
        .expect("a resolver failure must not leave SQLite inside a transaction");
}
