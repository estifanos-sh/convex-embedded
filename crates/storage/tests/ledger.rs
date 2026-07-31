//! ledger — migrated from the former inline `src/tests.rs`, reaching private internals only
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
fn ledger_delete_keeps_local_dirty_commit_sequence() {
    let store = EmbeddedStore::open(tmp_path("rs_prune.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    for i in 0..3 {
        commit(
            &store,
            doc_writes(vec![issue(&store, &format!("i{i}"), "t", "open")]),
        );
    }

    let deleted = store.ledger_delete(i64::MAX).unwrap();
    assert_eq!(deleted.commits_deleted, 0);

    let next = commit(&store, doc_writes(vec![issue(&store, "i3", "t", "open")]));
    assert_eq!(next.commit_seq, 4);

    assert_eq!(store.ledger_delete(0).unwrap().commits_deleted, 0);
}

#[test]
fn ledger_delete_removes_committed_mutations_only() {
    let store = EmbeddedStore::open(tmp_path("rs_prune_mut.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .mutation_write(&MutationCall {
            args: "{}".into(),
            mutation_id: "committed".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    store
        .commit(
            doc_writes(vec![issue(&store, "i0", "t", "open")]),
            &CommitOptions::existing("committed", None),
        )
        .unwrap();
    store
        .mutation_write(&MutationCall {
            args: "{}".into(),
            mutation_id: "accepted".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    commit(&store, doc_writes(vec![issue(&store, "i1", "t", "open")]));

    let deleted = store.ledger_delete(i64::MAX).unwrap();
    assert_eq!(deleted.commits_deleted, 0);
    assert_eq!(deleted.mutations_deleted, 1);

    let deleted = store.ledger_delete(i64::MAX).unwrap();
    assert_eq!(deleted.commits_deleted, 0);
    assert_eq!(deleted.mutations_deleted, 0);
    let record = store
        .mutation_write(&MutationCall {
            args: "{}".into(),
            mutation_id: "accepted".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    assert_eq!(record.mutation_id, "accepted");
}

#[test]
fn ledger_delete_uses_the_public_consumer_watermark() {
    let store = EmbeddedStore::open(tmp_path("rs_prune_watermark.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    for i in 0..3 {
        commit(
            &store,
            doc_writes(vec![issue(&store, &format!("i{i}"), "t", "open")]),
        );
    }

    let deleted = store.ledger_delete(1).unwrap();
    assert_eq!(deleted.commits_deleted, 0);
}

#[test]
fn remote_cursor_round_trips_and_clears_by_identity() {
    let path = tmp_path("rs_remote_cursor.db");
    let store = EmbeddedStore::open_with_identity_key(path.to_str().unwrap(), "a").unwrap();
    store.setup(&schema()).unwrap();

    assert_eq!(store.remote_cursor_read("issues:list").unwrap(), None);
    assert!(!store.remote_progress_has().unwrap());
    store
        .remote_cursor_write("issues:list", Some("c:1:1".into()), 100)
        .unwrap();
    assert_eq!(
        store.remote_cursor_read("issues:list").unwrap(),
        Some("c:1:1".into())
    );
    assert!(store.remote_progress_has().unwrap());
    store.identity_write("b", None).unwrap();
    assert_eq!(store.remote_cursor_read("issues:list").unwrap(), None);
    assert!(!store.remote_progress_has().unwrap());

    store.identity_write("a", None).unwrap();
    store.clear().unwrap();
    assert_eq!(store.remote_cursor_read("issues:list").unwrap(), None);
    assert!(!store.remote_progress_has().unwrap());
}

#[test]
fn clear_removes_docs_ledger_and_blobs_for_the_identity() {
    let store = EmbeddedStore::open(tmp_path("rs_clear_all.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .mutation_write(&MutationCall {
            args: "{}".into(),
            mutation_id: "m1".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    store.blob_write("frame", vec![1, 2, 3]).unwrap();
    store
        .commit(
            doc_writes(vec![issue(&store, "i1", "t", "open")]),
            &CommitOptions::existing("m1", Some("\"ok\"".into())),
        )
        .unwrap();

    store.clear().unwrap();

    assert!(read_doc(&store, "issues", "i1").is_none());
    assert!(store.blob_read("frame").unwrap().is_none());
    let replay = store
        .mutation_write(&MutationCall {
            args: "{}".into(),
            mutation_id: "m1".into(),
            name: "issues:send".into(),
        })
        .unwrap();
    assert_eq!(replay.status, MutationStatus::Accepted);
    let next = commit(&store, doc_writes(vec![issue(&store, "i2", "t", "open")]));
    assert_eq!(next.commit_seq, 1);
}

#[test]
fn service_metadata_tables_round_trip_and_clear_by_identity() {
    let path = tmp_path("embedded_service_metadata.db");
    let store = EmbeddedStore::open_with_identity_key(path.to_str().unwrap(), "user_a").unwrap();
    store.setup(&schema()).unwrap();

    store
        .id_write(&IdMapping {
            table: "issues".into(),
            local_id: "issues|local".into(),
            mapping: IdMappingContent::Local,
            created_time: 10,
            updated_time: 10,
        })
        .unwrap();
    store
        .id_write(&IdMapping {
            table: "issues".into(),
            local_id: "issues|local".into(),
            mapping: IdMappingContent::Mapped {
                convex_id: "issues|server".into(),
            },
            created_time: 10,
            updated_time: 20,
        })
        .unwrap();
    let mapping = store.id_read("issues", "issues|local").unwrap().unwrap();
    assert_eq!(mapping.convex_id(), Some("issues|server"));
    assert!(matches!(mapping.mapping, IdMappingContent::Mapped { .. }));
    assert_eq!(store.id_page_read("issues").unwrap().len(), 1);

    store.blob_write("_storage|local", vec![1, 2, 3]).unwrap();
    store
        .file_meta_write(&FileMetadata {
            storage_id: "_storage|local".into(),
            sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81".into(),
            size: 3,
            content_type: Some("text/plain".into()),
            source: Some("generateUploadUrl".into()),
            created_time: 30,
            updated_time: 30,
        })
        .unwrap();
    assert_eq!(
        store
            .file_read("_storage|local")
            .unwrap()
            .unwrap()
            .content_type
            .as_deref(),
        Some("text/plain")
    );

    store
        .upload_write(&PendingUpload {
            local_storage_id: "_storage|local".into(),
            sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81".into(),
            size: 3,
            content_type: Some("text/plain".into()),
            lease: UploadLease::Pending,
            created_time: 40,
            updated_time: 40,
        })
        .unwrap();
    assert!(store.upload_has_pending().unwrap());
    let claimed = store
        .upload_lease_write(UploadLeaseWrite::Claimed {
            local_storage_id: None,
            owner: "worker".into(),
            now_ms: 50,
            lease_until: 150,
        })
        .unwrap()
        .unwrap();
    assert_eq!(
        claimed.lease,
        UploadLease::Claimed {
            owner: "worker".into(),
            lease_until: 150,
        }
    );
    assert!(store
        .upload_lease_write(UploadLeaseWrite::Claimed {
            local_storage_id: Some("_storage|local".into()),
            owner: "worker".into(),
            now_ms: 60,
            lease_until: 160,
        })
        .unwrap()
        .is_some());
    assert!(store
        .upload_lease_write(UploadLeaseWrite::Pending {
            local_storage_id: "_storage|local".into(),
            owner: "worker".into(),
            now_ms: 70,
        })
        .unwrap()
        .is_none());
    store.upload_delete("_storage|local").unwrap();
    assert!(!store.upload_has_pending().unwrap());

    store
        .schedule_write(&ScheduledJob {
            job_id: "job:1".into(),
            kind: ScheduledFunctionKind::Mutation,
            name: "tasks:run".into(),
            args: "{}".into(),
            due_time: 100,
            state: ScheduledState::Pending,
            created_time: 80,
            updated_time: 80,
        })
        .unwrap();
    assert_eq!(store.schedule_lease_read(99).unwrap(), Vec::new());
    assert_eq!(store.schedule_lease_read(100).unwrap().len(), 1);
    assert_eq!(
        store.schedule_cancel("job:1", 101).unwrap().unwrap().state,
        ScheduledState::Canceled
    );
    assert_eq!(store.schedule_lease_read(200).unwrap(), Vec::new());

    store.clear().unwrap();
    assert!(store.id_read("issues", "issues|local").unwrap().is_none());
    assert!(store.file_read("_storage|local").unwrap().is_none());
    assert!(store.upload_read().unwrap().is_empty());
    assert!(store.schedule_lease_read(1_000).unwrap().is_empty());
    assert!(store.blob_read("_storage|local").unwrap().is_none());
}
