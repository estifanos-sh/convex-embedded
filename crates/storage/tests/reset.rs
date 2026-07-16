//! reset — opening a physically-unreadable store (a header written by an incompatible build) resets
//! to the current empty format instead of failing closed, per V5 "Local Store Evolution". Run with
//! `--features testkit`.
#![cfg(feature = "testkit")]

use std::path::Path;

use storage::testkit::{doc_writes, issue, schema, tmp_path};
use storage::{CommitOptions, EmbeddedStore};

/// A 512-byte `SQLite` header with a valid magic string but a zero page-size field (bytes 16..18).
/// turso parses this as `invalid page size in database header: 0` — the exact failure seen in
/// production after the turso 0.6 → 0.7 upgrade opened a 0.6-written OPFS store.
fn write_unreadable_store(path: &Path) {
    let mut header = vec![0u8; 512];
    header[0..16].copy_from_slice(b"SQLite format 3\0");
    std::fs::write(path, &header).unwrap();
}

#[test]
fn open_resets_an_unreadable_store_to_the_current_empty_format() {
    let path = tmp_path("reset-unreadable.db");
    write_unreadable_store(&path);
    let p = path.to_str().unwrap();

    let store =
        EmbeddedStore::open(p).expect("an unreadable store resets rather than failing open");
    store
        .setup(&schema())
        .expect("the reset store accepts the current schema");

    let page = store
        .doc_page_read(&storage::ReadSpec {
            table: "issues".into(),
            ..Default::default()
        })
        .expect("the reset store reads");
    assert_eq!(page.text, "[]", "the reset store starts empty");

    store
        .commit(
            doc_writes(vec![issue(&store, "a", "first", "open")]),
            &CommitOptions::default(),
        )
        .expect("the reset store is writable");
    let page = store
        .doc_page_read(&storage::ReadSpec {
            table: "issues".into(),
            ..Default::default()
        })
        .unwrap();
    assert!(
        page.text.contains("first"),
        "writes to the reset store persist"
    );
}

#[test]
fn open_preserves_a_readable_store_with_data() {
    let path = tmp_path("reset-preserve.db");
    let p = path.to_str().unwrap();
    {
        let store = EmbeddedStore::open(p).unwrap();
        store.setup(&schema()).unwrap();
        store
            .commit(
                doc_writes(vec![issue(&store, "keep", "kept", "open")]),
                &CommitOptions::default(),
            )
            .unwrap();
    }

    let store = EmbeddedStore::open(p).expect("a readable store reopens");
    store.setup(&schema()).unwrap();
    let page = store
        .doc_page_read(&storage::ReadSpec {
            table: "issues".into(),
            ..Default::default()
        })
        .unwrap();
    assert!(
        page.text.contains("kept"),
        "a readable store is never reset: its rows survive reopen",
    );
}
