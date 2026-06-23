//! blob — migrated from the former inline `src/tests.rs`, reaching private internals only
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
fn blobs_round_trip() {
    let store = EmbeddedStore::open(tmp_path("rs_blobs.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();

    assert!(store.blob_read("missing").unwrap().is_none());
    let bytes: Vec<u8> = (0..=255).collect();
    store.blob_write("frame", bytes.clone()).unwrap();
    assert_eq!(store.blob_read("frame").unwrap(), Some(bytes));

    store.blob_write("frame", vec![1, 2, 3]).unwrap();
    assert_eq!(store.blob_read("frame").unwrap(), Some(vec![1, 2, 3]));

    store.blob_delete("frame").unwrap();
    assert!(store.blob_read("frame").unwrap().is_none());
}
