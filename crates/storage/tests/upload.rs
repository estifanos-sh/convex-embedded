//! upload — migrated from the former inline `src/tests.rs`, reaching private internals only
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
fn upload_complete_sets_storage_mapping_and_removes_upload() {
    let store =
        EmbeddedStore::open(tmp_path("embedded_upload_complete.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
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
    store
        .id_write(&IdMapping {
            table: "_storage".into(),
            local_id: "_storage|local".into(),
            mapping: IdMappingContent::Local,
            created_time: 40,
            updated_time: 40,
        })
        .unwrap();
    store
        .upload_lease_write(UploadLeaseWrite::Claim {
            owner: "worker".into(),
            now_ms: 50,
            lease_until: 150,
        })
        .unwrap()
        .unwrap();
    assert!(!store
        .upload_complete("_storage|local", "other", "_storage|server", 60)
        .unwrap());
    assert_eq!(
        store
            .id_read("_storage", "_storage|local")
            .unwrap()
            .unwrap()
            .mapping,
        IdMappingContent::Local
    );
    assert!(store
        .upload_complete("_storage|local", "worker", "_storage|server", 70)
        .unwrap());
    assert!(store.upload_read().unwrap().is_empty());
    let uploaded = store
        .id_read("_storage", "_storage|local")
        .unwrap()
        .unwrap();
    assert_eq!(uploaded.convex_id(), Some("_storage|server"));
    assert_eq!(uploaded.created_time, 40);
    assert_eq!(uploaded.updated_time, 70);
}

#[test]
fn upload_lease_write_reclaims_expired_claimed_upload() {
    let store = EmbeddedStore::open(
        tmp_path("embedded_upload_missing_lease.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    store.setup(&schema()).unwrap();
    store
        .upload_write(&PendingUpload {
            local_storage_id: "_storage|local".into(),
            sha256: "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81".into(),
            size: 3,
            content_type: Some("text/plain".into()),
            lease: UploadLease::Claimed {
                owner: "dead-worker".into(),
                lease_until: 49,
            },
            created_time: 40,
            updated_time: 40,
        })
        .unwrap();

    let claimed = store
        .upload_lease_write(UploadLeaseWrite::Claim {
            owner: "worker".into(),
            now_ms: 50,
            lease_until: 150,
        })
        .unwrap()
        .expect("expired claimed upload must be recoverable");

    assert_eq!(claimed.local_storage_id, "_storage|local");
    assert_eq!(
        claimed.lease,
        UploadLease::Claimed {
            owner: "worker".into(),
            lease_until: 150,
        }
    );
    assert_eq!(claimed.updated_time, 50);
}
