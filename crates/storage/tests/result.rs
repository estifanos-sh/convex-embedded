//! Retained authored-result cache storage (Cut 7 §3/§6/§10): atomic pull-page write, zero-write
//! fast path, point delete, orphan and stale-runtime deletion, and the membership edge range descriptor.
#![cfg(feature = "testkit")]

use rustc_hash::FxHashSet;
use storage::testkit::*;
use storage::*;

const SERVER_ID: &str = "j575pnjjhzf95ze91djp5v26b188xreb";

fn entry(key: &str, skeleton_hash: &str, clock: f64) -> ResultEntry {
    ResultEntry {
        key: key.into(),
        function: "stats:list".into(),
        args: r#"{"owner":"a"}"#.into(),
        schema_hash: "schema-v1".into(),
        module_hash: "module-v1".into(),
        skeleton: format!("skeleton::{skeleton_hash}").into_bytes(),
        paths: br#"[{"path":"/latest"}]"#.to_vec(),
        skeleton_hash: skeleton_hash.into(),
        clock,
    }
}

fn open(name: &str) -> EmbeddedStore {
    let store = EmbeddedStore::open(tmp_path(name).to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
}

#[test]
fn result_write_reads_back_the_whole_entry() {
    let store = open("result_roundtrip.db");
    let written = entry("key-a", "hash-a", 12.0);
    assert!(store.result_write(&written).unwrap());
    let read = store.result_read("key-a").unwrap().unwrap();
    assert_eq!(read, written);
    assert_eq!(store.result_read("absent").unwrap(), None);
}

#[test]
fn result_write_zero_write_fast_path_skips_matching_skeletonhash() {
    let store = open("result_zero_write.db");
    assert!(store.result_write(&entry("key-a", "hash-a", 1.0)).unwrap());

    let mut same_hash = entry("key-a", "hash-a", 99.0);
    same_hash.skeleton = b"different-bytes-same-hash".to_vec();
    assert!(!store.result_write(&same_hash).unwrap());

    assert_eq!(
        store.result_read("key-a").unwrap().unwrap(),
        entry("key-a", "hash-a", 1.0)
    );

    assert!(store.result_write(&entry("key-a", "hash-b", 2.0)).unwrap());
    assert_eq!(
        store.result_read("key-a").unwrap().unwrap(),
        entry("key-a", "hash-b", 2.0)
    );
}

#[test]
fn result_write_in_page_commit_persists_atomically() {
    let store = open("result_page_commit.db");
    assert!(store
        .result_write_in_page_for_test(&entry("key-a", "hash-a", 5.0))
        .unwrap());
    assert_eq!(
        store.result_read("key-a").unwrap().unwrap(),
        entry("key-a", "hash-a", 5.0)
    );
}

#[test]
fn result_write_in_page_rolls_back_on_commit_fault() {
    let path = tmp_path("result_page_rollback.db");
    {
        let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
        store.setup(&schema()).unwrap();
        store
            .result_write(&entry("key-existing", "hash-old", 1.0))
            .unwrap();
        fail_next_commit();
        let rejected = store.result_write_in_page_for_test(&entry("key-new", "hash-new", 9.0));
        assert!(rejected.is_err());
        assert_eq!(store.result_read("key-new").unwrap(), None);
        assert_eq!(
            store.result_read("key-existing").unwrap().unwrap(),
            entry("key-existing", "hash-old", 1.0)
        );
    }
    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&schema()).unwrap();
    assert_eq!(reopened.result_read("key-new").unwrap(), None);
    assert_eq!(
        reopened.result_read("key-existing").unwrap().unwrap(),
        entry("key-existing", "hash-old", 1.0)
    );
}

#[test]
fn result_delete_removes_one_entry() {
    let store = open("result_delete.db");
    store.result_write(&entry("key-a", "hash-a", 1.0)).unwrap();
    store.result_write(&entry("key-b", "hash-b", 1.0)).unwrap();
    store.result_delete("key-a").unwrap();
    assert_eq!(store.result_read("key-a").unwrap(), None);
    assert!(store.result_read("key-b").unwrap().is_some());
    store.result_delete("absent").unwrap();
}

#[test]
fn result_delete_stale_deletes_orphaned_and_stale_runtime_entries() {
    let store = open("result_stale_delete.db");

    let live = entry("key-live", "hash-live", 1.0);
    store.result_write(&live).unwrap();

    let orphan = entry("key-orphan", "hash-orphan", 1.0);
    store.result_write(&orphan).unwrap();

    let mut stale = entry("key-stale", "hash-stale", 1.0);
    stale.schema_hash = "schema-old".into();
    store.result_write(&stale).unwrap();

    let mut stale_module = entry("key-stale-module", "hash-stale-module", 1.0);
    stale_module.module_hash = "module-old".into();
    store.result_write(&stale_module).unwrap();

    let mut keep = FxHashSet::default();
    keep.insert("key-live".to_owned());
    keep.insert("key-stale".to_owned());
    keep.insert("key-stale-module".to_owned());

    let deleted = store
        .result_stale_delete(&keep, "schema-v1", "module-v1")
        .unwrap();
    assert_eq!(deleted, 3);

    assert!(store.result_read("key-live").unwrap().is_some());
    assert_eq!(store.result_read("key-orphan").unwrap(), None);
    assert_eq!(store.result_read("key-stale").unwrap(), None);
    assert_eq!(store.result_read("key-stale-module").unwrap(), None);
}

fn projection(server_id: &str) -> AuthoritativeRow {
    AuthoritativeRow {
        table: "issues".into(),
        local_document_id: None,
        server_document_id: server_id.into(),
        plain_hash: format!("plain:{server_id}"),
        projection_hash: format!("projection:{server_id}"),
        current_root_id: None,
        current_node_id: None,
        row: Some(format!(
            r#"{{"_id":"{server_id}","_creationTime":1,"status":"open","title":"t"}}"#
        )),
        logical_clock: Some(1.0),
        received_time: 1,
    }
}

#[test]
fn membership_edge_range_descriptor_defaults_null_until_populated() {
    let store = open("result_membership_range.db");
    store
        .remote_page_write(&RemotePageWrite {
            subscription: "issues:list".into(),
            members: vec![RemoteMember {
                table: "issues".into(),
                server_document_id: SERVER_ID.into(),
            }],
            projections: vec![projection(SERVER_ID)],
            crdt: Vec::new(),
            blobs: Vec::new(),
            cursor: Some("cursor-1".into()),
            received_time: 1,
            result: None,
        })
        .unwrap();

    let range = store.membership_range_read("issues:list").unwrap().unwrap();
    assert_eq!(
        range,
        MembershipRange {
            lower: None,
            upper: None,
            order: None,
        }
    );
    assert_eq!(store.membership_range_read("absent").unwrap(), None);
}
