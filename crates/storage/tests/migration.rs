#![cfg(feature = "testkit")]

use storage::testkit::{doc_writes, fail_next_commit, read_doc, tmp_path};
use storage::{
    ColValue, CommitChanges, CommitMutation, CommitOptions, CommitSource, DocWrite, EmbeddedStore,
    FileMetadata, FileStore, MigrationDefinition, MigrationDisposition, MigrationRecordTarget,
    StoreSchema, TableDef, TablePlacement,
};

fn schema(hash: char, migrations: Vec<MigrationDefinition>) -> StoreSchema {
    StoreSchema {
        hash: hash.to_string().repeat(64),
        migrations,
        migration_code_hash: "handlers-v1".to_owned(),
        tables: vec![
            TableDef {
                name: "preferences".to_owned(),
                placement: TablePlacement::Device,
                columns: vec![],
                crdt_fields: vec![],
                local_fields: vec![],
                indexes: vec![],
            },
            TableDef {
                name: "issues".to_owned(),
                placement: TablePlacement::Replicated,
                columns: vec![],
                crdt_fields: vec![],
                local_fields: vec![],
                indexes: vec![],
            },
        ],
    }
}

fn options(source: CommitSource) -> CommitOptions {
    CommitOptions {
        source,
        mutation: CommitMutation::None,
        push: None,
        changes: CommitChanges::Include,
    }
}

fn write(table: &str, id: &str, value: &str, creation_time: f64) -> DocWrite {
    DocWrite {
        table: table.to_owned(),
        id: id.to_owned(),
        data: format!(r#"{{"value":"{value}"}}"#),
        cols: Vec::<(String, ColValue)>::new(),
        creation_time,
    }
}

#[test]
fn candidate_preserves_originated_state_and_omits_derived_rows() {
    let path = tmp_path("migration_candidate.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "dark",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "issues",
                "server-1",
                "derived",
                store.clock_read().unwrap(),
            )]),
            &CommitOptions::remote(),
        )
        .unwrap();

    let target = schema(
        '1',
        vec![MigrationDefinition {
            id: "001-contract".to_owned(),
            definition_hash: "definition-v1".to_owned(),
        }],
    );
    let candidate = store.migration_begin(&target).unwrap();
    assert!(candidate.required);
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "dark"
    );

    store
        .migration_step_complete(candidate.candidate_generation, 1)
        .unwrap();
    store
        .migration_commit(&target, candidate.candidate_generation)
        .unwrap();

    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "dark"
    );
    assert!(read_doc(&store, "issues", "server-1").is_none());
    assert!(!store
        .origin_page_read(candidate.active_generation, None, 100)
        .unwrap()
        .records
        .is_empty());
}

#[test]
fn abandoned_candidate_never_changes_the_active_generation() {
    let path = tmp_path("migration_abandon.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "kept",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    let target = schema('1', vec![]);
    let candidate = store.migration_begin(&target).unwrap();
    assert_ne!(candidate.active_generation, candidate.candidate_generation);
    drop(store);

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&schema('0', vec![])).unwrap();
    assert_eq!(
        read_doc(&reopened, "preferences", "device-1").unwrap()["value"],
        "kept"
    );
}

#[test]
fn quarantine_retains_the_candidate_record_without_materializing_it() {
    let path = tmp_path("migration_quarantine.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "legacy",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    let target = schema('1', vec![]);
    let candidate = store.migration_begin(&target).unwrap();
    let record = store
        .origin_page_read(candidate.candidate_generation, None, 100)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 2)
        .unwrap();
    store
        .migration_record_disposition_write(
            candidate.candidate_generation,
            &record.identity_key,
            record.kind,
            &record.record_key,
            "001-remove-preference",
            "unclaimed",
            false,
        )
        .unwrap();
    store
        .migration_commit(&target, candidate.candidate_generation)
        .unwrap();
    assert!(read_doc(&store, "preferences", "device-1").is_none());
}

#[test]
fn last_flat_layout_is_seeded_without_resetting_originated_state() {
    let path = tmp_path("migration_legacy_seed.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let source = schema('0', vec![]);
    store.setup(&source).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "from-legacy",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    store.legacy_layout_debug_write().unwrap();
    drop(store);

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let target = schema(
        '0',
        vec![MigrationDefinition {
            id: "001-ledger".to_owned(),
            definition_hash: "definition-v1".to_owned(),
        }],
    );
    let candidate = reopened.migration_begin(&target).unwrap();
    assert_eq!(candidate.active_generation, 0);
    assert_eq!(candidate.candidate_generation, 1);
    reopened
        .migration_step_complete(candidate.candidate_generation, 1)
        .unwrap();
    reopened
        .migration_commit(&target, candidate.candidate_generation)
        .unwrap();
    assert_eq!(
        read_doc(&reopened, "preferences", "device-1").unwrap()["value"],
        "from-legacy"
    );
}

#[test]
fn migration_page_and_resume_cursor_ride_one_transaction() {
    let path = tmp_path("migration_page_atomic.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "legacy",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    let target = schema(
        '1',
        vec![MigrationDefinition {
            id: "001-page".to_owned(),
            definition_hash: "definition-v1".to_owned(),
        }],
    );
    let candidate = store.migration_begin(&target).unwrap();
    store
        .migration_step_begin(candidate.candidate_generation, "001-page")
        .unwrap();
    let page = store
        .origin_page_read(candidate.candidate_generation, None, 100)
        .unwrap();
    let source = page.records.iter().find(|record| record.kind == 2).unwrap();
    let disposition = MigrationDisposition {
        target: MigrationRecordTarget {
            identity_key: source.identity_key.clone(),
            kind: source.kind,
            record_key: source.record_key.clone(),
        },
        reason: "test".to_owned(),
        discard: false,
    };

    fail_next_commit();
    assert!(store
        .migration_page_write(
            candidate.candidate_generation,
            "001-page",
            page.cursor.as_ref().unwrap(),
            &[],
            &[],
            &[disposition],
        )
        .is_err());

    let resumed = store.migration_begin(&target).unwrap();
    assert!(resumed.progress_cursor.is_none());
    let source = store
        .origin_page_read(candidate.candidate_generation, None, 100)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 2)
        .unwrap();
    assert_eq!(source.flags, 0);
}

#[test]
fn migration_scan_reads_the_frozen_record_snapshot_not_its_own_writes() {
    let path = tmp_path("migration_snapshot.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "before",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    let target = schema(
        '1',
        vec![MigrationDefinition {
            id: "001-snapshot".to_owned(),
            definition_hash: "definition-v1".to_owned(),
        }],
    );
    let candidate = store.migration_begin(&target).unwrap();
    store
        .migration_step_begin(candidate.candidate_generation, "001-snapshot")
        .unwrap();
    let before = store
        .origin_page_read(candidate.candidate_generation, None, 100)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 2)
        .unwrap();
    let mut successor = before.clone();
    successor.payload = br#"{"table":"preferences","id":"device-1","data":"changed"}"#.to_vec();
    store
        .migration_record_write(candidate.candidate_generation, &successor)
        .unwrap();

    let frozen = store
        .origin_page_read(candidate.candidate_generation, None, 100)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 2)
        .unwrap();
    assert_eq!(frozen.payload, before.payload);
}

#[test]
fn failed_materialization_page_resumes_without_cutting_over() {
    let path = tmp_path("migration_materialize_resume.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "preserved",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    let target = schema('1', vec![]);
    let candidate = store.migration_begin(&target).unwrap();

    fail_next_commit();
    assert!(store
        .migration_commit(&target, candidate.candidate_generation)
        .is_err());
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "preserved"
    );

    store
        .migration_commit(&target, candidate.candidate_generation)
        .unwrap();
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "preserved"
    );
}

#[test]
fn one_native_runtime_owns_a_physical_store_for_its_lifetime() {
    let path = tmp_path("migration_owner.db");
    let owner = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let error = EmbeddedStore::open(path.to_str().unwrap()).err().unwrap();
    assert!(error.is_transient());
    drop(owner);
    EmbeddedStore::open(path.to_str().unwrap()).unwrap();
}

#[test]
fn an_older_runtime_preserves_a_store_with_a_newer_bootstrap() {
    let path = tmp_path("migration_bootstrap_downgrade.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    store.bootstrap_version_debug_write(2).unwrap();
    drop(store);

    let error = EmbeddedStore::open(path.to_str().unwrap()).err().unwrap();
    assert!(error.to_string().contains("unsupported bootstrap version 2"));
}

#[test]
fn an_older_runtime_cannot_rebuild_a_newer_semantic_contract_backward() {
    let path = tmp_path("migration_contract_downgrade.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let current = schema('0', vec![]);
    store.setup(&current).unwrap();
    store.contract_epoch_debug_write(44).unwrap();

    let error = store.migration_begin(&current).err().unwrap();
    assert!(error.to_string().contains("newer than runtime epoch"));
}

#[test]
fn retired_generation_cleanup_keeps_reachable_payloads_and_reclaims_orphans() {
    let path = tmp_path("migration_payload_cleanup.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    for (storage_id, bytes) in [("live", vec![1, 2, 3]), ("orphan", vec![4, 5, 6])] {
        store
            .file_write(&FileStore {
                bytes,
                metadata: FileMetadata {
                    storage_id: storage_id.to_owned(),
                    sha256: format!("sha256:{storage_id}"),
                    size: 3,
                    content_type: None,
                    source: None,
                    created_time: 1,
                    updated_time: 1,
                },
            })
            .unwrap();
    }
    store.file_delete("orphan").unwrap();
    assert_eq!(store.origin_payload_count_debug_read().unwrap(), 2);

    let target = schema('1', vec![]);
    let candidate = store.migration_begin(&target).unwrap();
    store
        .migration_commit(&target, candidate.candidate_generation)
        .unwrap();
    store
        .migration_retire(candidate.active_generation)
        .unwrap();

    assert_eq!(store.origin_payload_count_debug_read().unwrap(), 1);
    assert_eq!(store.blob_read("live").unwrap(), Some(vec![1, 2, 3]));
}

#[test]
fn a_corrupt_content_addressed_payload_cannot_cut_over() {
    let path = tmp_path("migration_payload_corrupt.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    store
        .file_write(&FileStore {
            bytes: vec![1, 2, 3],
            metadata: FileMetadata {
                storage_id: "file".to_owned(),
                sha256: "sha256:file".to_owned(),
                size: 3,
                content_type: None,
                source: None,
                created_time: 1,
                updated_time: 1,
            },
        })
        .unwrap();
    store.origin_payload_corrupt_debug_write().unwrap();

    let target = schema('1', vec![]);
    let candidate = store.migration_begin(&target).unwrap();
    let error = store
        .migration_commit(&target, candidate.candidate_generation)
        .err()
        .unwrap();
    assert!(error.to_string().contains("payload checksum mismatch"));
    assert_eq!(store.blob_read("file").unwrap(), Some(vec![1, 2, 3]));
}

#[test]
fn handler_change_restarts_only_an_incomplete_candidate() {
    let path = tmp_path("migration_handler_change.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    let definition = MigrationDefinition {
        id: "001-handler".to_owned(),
        definition_hash: "definition-v1".to_owned(),
    };
    let first_target = schema('1', vec![definition.clone()]);
    let first = store.migration_begin(&first_target).unwrap();
    store
        .migration_step_begin(first.candidate_generation, "001-handler")
        .unwrap();

    let mut fixed_handler = first_target.clone();
    fixed_handler.migration_code_hash = "handlers-v2".to_owned();
    let restarted = store.migration_begin(&fixed_handler).unwrap();
    assert_ne!(restarted.candidate_generation, first.candidate_generation);
    assert!(restarted.progress_migration_id.is_none());
    store
        .migration_step_complete(restarted.candidate_generation, 1)
        .unwrap();
    store
        .migration_commit(&fixed_handler, restarted.candidate_generation)
        .unwrap();

    let mut changed_after_cutover = fixed_handler.clone();
    changed_after_cutover.migration_code_hash = "handlers-v3".to_owned();
    let opened = store.migration_begin(&changed_after_cutover).unwrap();
    assert!(!opened.required);
}

#[test]
fn applied_migration_history_cannot_be_changed() {
    let path = tmp_path("migration_history.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0', vec![])).unwrap();
    let target = schema(
        '1',
        vec![MigrationDefinition {
            id: "001-history".to_owned(),
            definition_hash: "definition-v1".to_owned(),
        }],
    );
    let candidate = store.migration_begin(&target).unwrap();
    store
        .migration_step_complete(candidate.candidate_generation, 1)
        .unwrap();
    store
        .migration_commit(&target, candidate.candidate_generation)
        .unwrap();

    let changed = schema(
        '2',
        vec![MigrationDefinition {
            id: "001-history".to_owned(),
            definition_hash: "definition-v2".to_owned(),
        }],
    );
    assert!(store.migration_begin(&changed).is_err());
}
