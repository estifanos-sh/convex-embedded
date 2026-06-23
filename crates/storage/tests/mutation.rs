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
        .mutation_begin(&MutationCall {
            args: "{}".into(),
            mutation_id: "mutation-1".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    let options = CommitOptions::existing("mutation-1", None);

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

    assert!(matches!(duplicate, Err(StorageError::Unsatisfiable(_))));
    assert!(store.doc_read("issues", "first").unwrap().is_some());
    assert!(store.doc_read("issues", "second").unwrap().is_none());
}

#[test]
fn mutation_id_commit_requires_accepted_record() {
    let store = EmbeddedStore::open(tmp_path("rs_unbegun_mutation.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let err = store.commit(
        upserts(vec![issue(&store, "missing", "missing", "open")]),
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
            upserts(vec![issue(&store, "first-seen", "first", "open")]),
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
        .mutation_read(&MutationCall {
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
    store.mutation_begin(&call).unwrap();
    let commit = store
        .commit(
            upserts(vec![issue(&store, "replayed", "first", "open")]),
            &CommitOptions::terminal(call.clone(), r#"{"ok":true,"id":"replayed"}"#, false, None),
        )
        .unwrap();

    let replay = store.mutation_begin(&call).unwrap();
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
        store.mutation_read(&call).unwrap().status,
        MutationStatus::Accepted
    );

    let result = store
        .commit(
            upserts(vec![issue(&store, "lookup-first-seen", "first", "open")]),
            &CommitOptions::terminal(call.clone(), r#""lookup-first-seen""#, false, None),
        )
        .unwrap();

    let record = store.mutation_read(&call).unwrap();
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
        store.mutation_read(&call).unwrap().status,
        MutationStatus::Accepted
    );

    store
        .mutation_fail(&call.mutation_id, "handler failed")
        .unwrap();

    let record = store.mutation_read(&call).unwrap();
    assert_eq!(record.status, MutationStatus::Failed);
    assert_eq!(record.error.as_deref(), Some("handler failed"));
    assert_eq!(record.result, None);
    assert_eq!(record.commit_seq, None);

    let err = store.commit(
        upserts(vec![issue(&store, "failed-lookup", "failed", "open")]),
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
        .mutation_begin(&MutationCall {
            args: "{}".into(),
            mutation_id: "m1".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    store.mutation_fail("m1", "local failed").unwrap();

    let err = store.commit(
        upserts(vec![issue(&store, "failed", "failed", "open")]),
        &CommitOptions::existing("m1", None),
    );

    assert!(matches!(err, Err(StorageError::Unsatisfiable(_))));
    assert!(store.doc_read("issues", "failed").unwrap().is_none());
}
