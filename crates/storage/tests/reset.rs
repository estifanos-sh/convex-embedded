//! reset — physically unreadable bytes fail closed and remain untouched; only a readable empty
//! path may be initialized. Run with `--features testkit`.
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
fn open_preserves_an_unreadable_store_for_explicit_recovery() {
    let path = tmp_path("reset-unreadable.db");
    write_unreadable_store(&path);
    let before = std::fs::read(&path).unwrap();
    assert!(EmbeddedStore::open(path.to_str().unwrap()).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), before);
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
