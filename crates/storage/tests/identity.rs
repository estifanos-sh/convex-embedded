//! identity — durable identity partition switching. Run with `--features testkit`.
#![cfg(feature = "testkit")]

use storage::testkit::*;
use storage::*;

#[test]
fn id_mapping_content_rejects_impossible_field_combinations() {
    assert_eq!(
        IdMappingContent::decode("mapped", Some("documents|server".to_owned())),
        Some(IdMappingContent::Mapped {
            convex_id: "documents|server".to_owned(),
        })
    );
    assert_eq!(IdMappingContent::decode("mapped", None), None);
    assert_eq!(
        IdMappingContent::decode("local", Some("documents|server".to_owned())),
        None
    );
    assert_eq!(
        IdMappingContent::decode("deleted", None),
        Some(IdMappingContent::Deleted { convex_id: None })
    );
}

#[test]
fn identity_switch_preserves_and_isolates_each_partition() {
    let path = tmp_path("embedded_identity_partitions.db");
    let store =
        EmbeddedStore::open_with_identity_key(path.to_str().unwrap(), "identity:a").unwrap();
    store.setup(&schema()).unwrap();
    let id = "issues|00000000000000000000000000000001";
    store
        .commit(
            doc_writes(vec![issue(&store, id, "from a", "open")]),
            &envelope_options("mutation:a", "a", 1),
        )
        .unwrap();

    store.identity_write("identity:b", None).unwrap();
    assert!(store.doc_read("issues", id).unwrap().is_none());
    assert!(store.remote_push_envelope_read(1).unwrap().is_empty());
    store
        .commit(
            doc_writes(vec![issue(&store, id, "from b", "open")]),
            &envelope_options("mutation:b", "b", 2),
        )
        .unwrap();

    store.identity_write("identity:a", None).unwrap();
    assert!(store
        .doc_read("issues", id)
        .unwrap()
        .unwrap()
        .contains("from a"));
    assert!(store
        .remote_push_envelope_read(1)
        .unwrap()
        .remove(0)
        .contains("\"a\""));

    store.identity_write("identity:b", None).unwrap();
    assert!(store
        .doc_read("issues", id)
        .unwrap()
        .unwrap()
        .contains("from b"));
    assert!(store
        .remote_push_envelope_read(1)
        .unwrap()
        .remove(0)
        .contains("\"b\""));
}

fn envelope_options(mutation_id: &str, partition: &str, now_ms: i64) -> CommitOptions {
    CommitOptions::terminal(
        MutationCall {
            args: "{}".into(),
            mutation_id: mutation_id.into(),
            name: "issues:write".into(),
        },
        "null",
        false,
        Some(CommitPush {
            mutation_id: mutation_id.into(),
            json: format!(
                r#"{{"mutationId":"{mutation_id}","commitSeq":0,"crdt":[],"partition":"{partition}"}}"#
            ),
            now_ms,
            after_images_commit_ts: false,
        }),
    )
}

#[test]
fn cached_identity_reopens_the_last_server_accepted_partition() {
    let path = tmp_path("embedded_cached_identity.db");
    let selector = "browser-storage";
    let pending_id = "issues|00000000000000000000000000000000";
    let id = "issues|00000000000000000000000000000001";
    {
        let store = EmbeddedStore::open_with_cached_identity_key(
            path.to_str().unwrap(),
            selector,
            "unauthenticated",
        )
        .unwrap();
        store.setup(&schema()).unwrap();
        commit(
            &store,
            doc_writes(vec![issue(&store, pending_id, "offline", "pending")]),
        );
        store.identity_write("unauthenticated", None).unwrap();
        assert!(store.doc_read("issues", pending_id).unwrap().is_some());
        let accepted = r#"{"issuer":"issuer","subject":"user","tokenIdentifier":"issuer|user"}"#;
        store
            .identity_write("accepted:unauthenticated", Some(accepted))
            .unwrap();
        assert_eq!(
            store.identity_read().unwrap(),
            (
                "accepted:unauthenticated".to_owned(),
                Some(accepted.to_owned())
            )
        );
        commit(
            &store,
            doc_writes(vec![issue(&store, id, "offline", "open")]),
        );
        store.wal_write().unwrap();
    }

    let reopened = EmbeddedStore::open_with_cached_identity_key(
        path.to_str().unwrap(),
        selector,
        "unauthenticated",
    )
    .unwrap();
    reopened.setup(&schema()).unwrap();
    assert_eq!(
        reopened.identity_read().unwrap().0,
        "accepted:unauthenticated"
    );
    assert!(reopened.identity_read().unwrap().1.is_some());
    assert!(reopened
        .doc_read("issues", id)
        .unwrap()
        .unwrap()
        .contains("offline"));
    assert!(reopened.doc_read("issues", pending_id).unwrap().is_none());

    reopened.identity_write("unauthenticated", None).unwrap();
    assert_eq!(
        reopened.identity_read().unwrap(),
        ("unauthenticated".to_owned(), None)
    );
}

#[test]
fn corrupt_cached_identity_fails_closed() {
    let path = tmp_path("embedded_corrupt_identity.db");
    let selector = "browser-storage";
    {
        let store = EmbeddedStore::open_with_cached_identity_key(
            path.to_str().unwrap(),
            selector,
            "unauthenticated",
        )
        .unwrap();
        store.setup(&schema()).unwrap();
        store.identity_write("accepted", Some("{}")).unwrap();
        store.execute_sql_for_test(
            "UPDATE __embedded_meta SET value = 'not-json' WHERE identity_key = 'browser-storage' AND key = 'identity_state'",
        );
        store.wal_write().unwrap();
    }

    let Err(error) = EmbeddedStore::open_with_cached_identity_key(
        path.to_str().unwrap(),
        selector,
        "unauthenticated",
    ) else {
        panic!("corrupt identity state must fail open");
    };
    assert!(error
        .to_string()
        .contains("cached identity state is corrupt"));
}
