#![cfg(feature = "testkit")]

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use storage::testkit::tmp_path;
use storage::{
    ArchivedRev, AuthoritativeRow, ColumnDef, CommitOptions, CommitPush, CommitSource,
    CrdtFieldDef, CrdtFieldKind, CrdtOp, CrdtOperation, DocWrite, EmbeddedStore, FileMetadata,
    FileStore, IdMapping, IdMappingContent, IndexDef, LocalFieldDef, LocalFieldWrite, MutationCall,
    PendingUpload, RemoteMember, RemotePageWrite, RemoteSettlementOutcome, RemoteSettlementWrite,
    ResultEntry, RevKey, RevLifecycle, RevState, RowKey, ScheduledFunctionKind, ScheduledJob,
    ScheduledState, StoreSchema, TableDef, TablePlacement, UploadLease, WriteBatch,
};

const PERMANENT_KINDS: [i64; 16] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17];

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/preview2")
}

fn fixture_schema() -> StoreSchema {
    StoreSchema {
        hash: "f".repeat(64),
        setup_hash: String::new(),
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
                crdt_fields: vec![CrdtFieldDef {
                    field: "body".to_owned(),
                    kind: CrdtFieldKind::Text,
                }],
                local_fields: vec![LocalFieldDef {
                    field: "expanded".to_owned(),
                }],
                indexes: vec![],
            },
        ],
    }
}

fn fixture_target_schema() -> StoreSchema {
    let mut target = fixture_schema();
    target.hash = "e".repeat(64);
    let issues = target
        .tables
        .iter_mut()
        .find(|table| table.name == "issues")
        .unwrap();
    issues.columns.push(ColumnDef {
        name: "title".to_owned(),
        field: None,
    });
    issues.indexes.push(IndexDef {
        name: "by_title".to_owned(),
        fields: vec!["title".to_owned()],
        columns: None,
    });
    target
}

fn fixture_path() -> PathBuf {
    fixture_dir().join("store.sqlite3")
}

fn semantic_snapshot(store: &EmbeddedStore) -> serde_json::Value {
    let local_id = "issues|11111111111111111111111111111111";
    let remote_local_id = "issues|22222222222222222222222222222222";
    let retained = MutationCall {
        mutation_id: "fixture:retained".to_owned(),
        name: "issues:update".to_owned(),
        args: "{}".to_owned(),
    };
    serde_json::json!({
        "identity": store.identity_read().unwrap(),
        "deviceDocument": store.doc_read("preferences", "preferences:fixture").unwrap(),
        "localDocument": store.doc_read("issues", local_id).unwrap(),
        "remoteDocument": store.doc_read("issues", remote_local_id).unwrap(),
        "localFields": store.local_fields_read("issues", local_id).unwrap(),
        "mutation": format!("{:?}", store.mutation_cache_read(&retained).unwrap()),
        "envelopes": store.remote_push_envelope_read(100).unwrap(),
        "schedules": format!("{:?}", store.schedule_read().unwrap()),
        "settlements": store.remote_receipt_read(100).unwrap(),
        "revisions": origin_kind_hashes(store, 10),
        "crdt": {
            "states": format!("{:?}", store.crdt_read_states("issues", local_id).unwrap()),
            "originHashes": origin_kind_hashes(store, 11),
        },
        "mappings": format!("{:?}", store.id_page_read("issues").unwrap()),
        "uploads": format!("{:?}", store.upload_read().unwrap()),
        "file": format!("{:?}", store.file_read("fixture:file").unwrap()),
        "fileBytes": store.blob_read("fixture:file").unwrap(),
        "remoteProjection": format!("{:?}", store.remote_doc_read("issues", remote_local_id).unwrap()),
        "remoteMembership": format!("{:?}", store.remote_member_read("fixture:subscription").unwrap()),
        "remoteResult": format!("{:?}", store.result_read("fixture:result").unwrap()),
        "remoteCursor": store.remote_cursor_read("fixture:subscription").unwrap(),
    })
}

fn portable_snapshot(store: &EmbeddedStore) -> serde_json::Value {
    let local_id = "issues|11111111111111111111111111111111";
    let remote_local_id = "issues|22222222222222222222222222222222";
    let retained = MutationCall {
        mutation_id: "fixture:retained".to_owned(),
        name: "issues:update".to_owned(),
        args: "{}".to_owned(),
    };
    let mutation = store.mutation_cache_read(&retained).unwrap();
    let mut mappings = store.id_page_read("issues").unwrap();
    mappings.sort_by(|left, right| left.local_id.cmp(&right.local_id));
    let mut schedules = store.schedule_read().unwrap();
    schedules.sort_by(|left, right| left.job_id.cmp(&right.job_id));
    let mut uploads = store.upload_read().unwrap();
    uploads.sort_by(|left, right| left.local_storage_id.cmp(&right.local_storage_id));
    let result = store.result_read("fixture:result").unwrap().unwrap();
    let projection = store
        .remote_doc_read("issues", remote_local_id)
        .unwrap()
        .unwrap();
    let mut membership = store.remote_member_read("fixture:subscription").unwrap();
    membership.sort();
    let file = store.file_read("fixture:file").unwrap().unwrap();
    let crdt = portable_crdt_snapshot(store, local_id);
    serde_json::json!({
        "identityKey": store.identity_read().unwrap().0,
        "deviceDocument": parse_document(store.doc_read("preferences", "preferences:fixture").unwrap()),
        "localDocument": parse_document(store.doc_read("issues", local_id).unwrap()),
        "remoteDocument": parse_document(store.doc_read("issues", remote_local_id).unwrap()),
        "localFields": store.local_fields_read("issues", local_id).unwrap(),
        "mutation": {
            "commitSeq": mutation.commit_seq,
            "error": mutation.error,
            "mutationId": mutation.mutation_id,
            "result": mutation.result,
            "status": mutation.status.as_str(),
        },
        "schedules": schedules.into_iter().map(|job| serde_json::json!({
            "jobId": job.job_id,
            "kind": job.kind.as_str(),
            "name": job.name,
            "args": job.args,
            "dueTime": job.due_time,
            "state": job.state.as_str(),
            "leaseUntil": job.state.lease_until(),
            "createdTime": job.created_time,
            "updatedTime": job.updated_time,
        })).collect::<Vec<_>>(),
        "mappings": mappings.into_iter().map(|mapping| serde_json::json!({
            "table": mapping.table,
            "localId": mapping.local_id,
            "mapping": mapping.mapping.as_str(),
            "convexId": mapping.mapping.convex_id(),
            "createdTime": mapping.created_time,
            "updatedTime": mapping.updated_time,
        })).collect::<Vec<_>>(),
        "uploads": uploads.into_iter().map(|upload| serde_json::json!({
            "localStorageId": upload.local_storage_id,
            "sha256": upload.sha256,
            "size": upload.size,
            "contentType": upload.content_type,
            "lease": upload.lease.as_str(),
            "owner": upload.lease.owner(),
            "leaseUntil": upload.lease.lease_until(),
            "createdTime": upload.created_time,
            "updatedTime": upload.updated_time,
        })).collect::<Vec<_>>(),
        "file": {
            "storageId": file.storage_id,
            "sha256": file.sha256,
            "size": file.size,
            "contentType": file.content_type,
            "source": file.source,
            "createdTime": file.created_time,
            "updatedTime": file.updated_time,
        },
        "fileBytes": store.blob_read("fixture:file").unwrap(),
        "crdt": crdt,
        "remoteProjection": {
            "table": projection.table,
            "localDocumentId": projection.local_document_id,
            "currentRevId": projection.current_rev_id,
            "serverDocumentId": projection.server_document_id,
            "projectionHash": projection.projection_hash,
            "currentRootId": projection.current_root_id,
            "currentNodeId": projection.current_node_id,
            "serverBase": projection.server_base,
            "logicalClock": projection.logical_clock,
            "updatedTime": projection.updated_time,
        },
        "remoteCursor": store.remote_cursor_read("fixture:subscription").unwrap(),
        "remoteMembership": membership.into_iter().map(|member| serde_json::json!({
            "table": member.table,
            "serverDocumentId": member.server_document_id,
        })).collect::<Vec<_>>(),
        "result": portable_result(result),
    })
}

fn portable_crdt_snapshot(store: &EmbeddedStore, local_id: &str) -> Vec<serde_json::Value> {
    store
        .crdt_snapshot_read("issues", local_id)
        .unwrap()
        .into_iter()
        .map(|snapshot| {
            serde_json::json!({
                "field": snapshot.field,
                "kind": snapshot.kind.as_wire(),
                "headSeq": snapshot.head_seq,
                "projectionHash": snapshot.projection_hash,
                "hash": snapshot.hash,
            })
        })
        .collect()
}

fn portable_result(result: ResultEntry) -> serde_json::Value {
    serde_json::json!({
        "key": result.key,
        "function": result.function,
        "args": result.args,
        "schemaHash": result.schema_hash,
        "moduleHash": result.module_hash,
        "skeleton": String::from_utf8(result.skeleton).unwrap(),
        "paths": String::from_utf8(result.paths).unwrap(),
        "skeletonHash": result.skeleton_hash,
        "clock": result.clock,
    })
}

fn parse_document(document: Option<String>) -> serde_json::Value {
    document.map_or(serde_json::Value::Null, |document| {
        serde_json::from_str(&document).unwrap()
    })
}

fn origin_kind_hashes(store: &EmbeddedStore, kind: i64) -> Vec<String> {
    let mut hashes = store
        .origin_page_read(1, None, 10_000)
        .unwrap()
        .records
        .into_iter()
        .filter(|record| record.kind == kind)
        .map(|record| base64::encode(record.payload_hash))
        .collect::<Vec<_>>();
    hashes.sort();
    hashes
}

fn fixture_inventory(store: &EmbeddedStore) -> serde_json::Value {
    let records = store.origin_page_read(1, None, 10_000).unwrap().records;
    let mut inventory = BTreeMap::<(i64, i64, i64), usize>::new();
    for record in records {
        *inventory
            .entry((record.kind, record.codec, record.flags))
            .or_default() += 1;
    }
    serde_json::Value::Array(
        inventory
            .into_iter()
            .map(|((kind, codec, flags), count)| {
                serde_json::json!({"kind":kind,"codec":codec,"flags":flags,"count":count})
            })
            .collect(),
    )
}

#[test]
fn preview2_fixture_matches_checksum_and_semantic_oracle() {
    let manifest_path = fixture_dir().join("manifest.json");
    assert!(
        fixture_path().is_file(),
        "Preview2 fixture is required before publish/tag"
    );
    assert!(
        manifest_path.is_file(),
        "Preview2 fixture manifest is required before publish/tag"
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(manifest_path).unwrap()).unwrap();
    let bytes = std::fs::read(fixture_path()).unwrap();
    assert_eq!(format!("{:x}", Sha256::digest(&bytes)), manifest["sha256"]);
    assert_eq!(manifest["epoch"], 47);
    assert_eq!(manifest["bootstrapVersion"], 1);
    assert_eq!(
        manifest["permanentOriginKinds"],
        serde_json::json!(PERMANENT_KINDS)
    );

    let opened_path = tmp_path("preview2_fixture_gate.sqlite3");
    std::fs::copy(fixture_path(), &opened_path).unwrap();
    let store =
        EmbeddedStore::open_with_identity_key(opened_path.to_str().unwrap(), "unauthenticated")
            .unwrap();
    assert_eq!(
        serde_json::to_value(store.active_contract_debug_read().unwrap()).unwrap(),
        manifest["contract"]
    );
    let target = fixture_target_schema();
    let candidate = store.migration_begin(&target).unwrap();
    if candidate.required {
        while !store
            .migration_queue_policy_write(
                candidate.candidate_generation,
                r#"{"collectComplete":true,"thresholds":[]}"#,
            )
            .unwrap()
        {}
        store
            .migration_commit(&target, candidate.candidate_generation)
            .unwrap();
    }
    let mut kinds = store
        .origin_page_read(candidate.active_generation, None, 1_000)
        .unwrap()
        .records
        .into_iter()
        .map(|record| record.kind)
        .collect::<Vec<_>>();
    kinds.sort_unstable();
    kinds.dedup();
    assert_eq!(kinds, PERMANENT_KINDS);
    let oracle = &manifest["oracle"];
    assert_eq!(store.identity_read().unwrap().0, oracle["identityKey"]);
    let subscription = oracle["subscription"].as_str().unwrap();
    assert_eq!(
        store.remote_cursor_read(subscription).unwrap().as_deref(),
        oracle["cursor"].as_str()
    );
    assert_eq!(store.remote_member_read(subscription).unwrap().len(), 1);
    assert!(store
        .result_read(oracle["resultKey"].as_str().unwrap())
        .unwrap()
        .is_some());
    let snapshot = semantic_snapshot(&store);
    let snapshot_bytes = serde_json::to_vec(&snapshot).unwrap();
    assert_eq!(snapshot, manifest["semanticSnapshot"]);
    assert_eq!(
        format!("{:x}", Sha256::digest(snapshot_bytes)),
        manifest["semanticDigest"]
    );
    assert_eq!(fixture_inventory(&store), manifest["originInventory"]);
    assert_eq!(
        store.origin_payload_references_debug_validate().unwrap(),
        manifest["referencedPayloadCount"].as_u64().unwrap() as usize
    );
    assert_eq!(portable_snapshot(&store), manifest["portableOracle"]);
}

/// Capture is deliberately ignored: the checked-in database is a release artifact from this exact
/// writer, not a fixture regenerated (or force-stamped) during ordinary CI.
#[test]
#[ignore = "run exactly once from the release candidate when Preview2 runtime changes settle"]
#[allow(clippy::too_many_lines)]
fn capture_preview2_fixture_from_exact_writer() {
    std::fs::create_dir_all(fixture_dir()).unwrap();
    let path = fixture_path();
    for suffix in ["", "-wal", "-shm", ".owner"] {
        let candidate = PathBuf::from(format!("{}{suffix}", path.display()));
        if candidate.exists() {
            std::fs::remove_file(candidate).unwrap();
        }
    }
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let schema = fixture_schema();
    store.setup(&schema).unwrap();
    store.identity_write("unauthenticated", None).unwrap();
    store
        .commit(
            WriteBatch {
                doc_writes: vec![DocWrite {
                    table: "preferences".to_owned(),
                    id: "preferences:fixture".to_owned(),
                    data: r#"{"theme":"dark"}"#.to_owned(),
                    cols: vec![],
                    creation_time: 1.0,
                }],
                ..WriteBatch::default()
            },
            &CommitOptions {
                source: CommitSource::Device,
                ..CommitOptions::default()
            },
        )
        .unwrap();

    let local_id = "issues|11111111111111111111111111111111";
    let retained = MutationCall {
        mutation_id: "fixture:retained".to_owned(),
        name: "issues:update".to_owned(),
        args: "{}".to_owned(),
    };
    store
        .commit(
            WriteBatch {
                doc_writes: vec![DocWrite {
                    table: "issues".to_owned(),
                    id: local_id.to_owned(),
                    data: r#"{"body":"","title":"fixture"}"#.to_owned(),
                    cols: vec![],
                    creation_time: 2.0,
                }],
                crdt_ops: vec![CrdtOp {
                    row: RowKey {
                        table: "issues".to_owned(),
                        document_id: local_id.to_owned(),
                    },
                    field: "body".to_owned(),
                    operation: CrdtOperation::TextSplice {
                        index: 0,
                        delete: 0,
                        insert: "offline".to_owned(),
                    },
                }],
                schedules: vec![ScheduledJob {
                    job_id: "fixture:schedule".to_owned(),
                    kind: ScheduledFunctionKind::Mutation,
                    name: "issues:followup".to_owned(),
                    args: "{}".to_owned(),
                    // Keep the release fixture pending while packaged-client startup pumps due
                    // jobs; the fixture is testing schedule preservation, not execution.
                    due_time: 4_102_444_800_000,
                    state: ScheduledState::Pending,
                    created_time: 3,
                    updated_time: 3,
                }],
                ..WriteBatch::default()
            },
            &CommitOptions::terminal(
                retained.clone(),
                "null",
                true,
                Some(CommitPush {
                    mutation_id: retained.mutation_id.clone(),
                    json: serde_json::json!({
                        "mutationId": retained.mutation_id,
                        "mutationTime": 3,
                        "afterImages": [{
                            "content": "value",
                            "table": "issues",
                            "rowId": local_id,
                            "value": {"body":"","title":"fixture"},
                            "creationTime": 2,
                        }],
                        "crdt": [{"table":"issues","rowId":local_id,"field":"body","kind":"text"}],
                        "localInserts": [local_id],
                        "localSchedules": ["fixture:schedule"],
                    })
                    .to_string(),
                    now_ms: 3,
                    after_images_commit_ts: false,
                }),
            ),
        )
        .unwrap();
    store
        .commit(
            WriteBatch {
                local_field_writes: vec![LocalFieldWrite {
                    table: "issues".to_owned(),
                    id: local_id.to_owned(),
                    field: "expanded".to_owned(),
                    value: serde_json::json!(true),
                }],
                ..WriteBatch::default()
            },
            &CommitOptions {
                source: CommitSource::Device,
                ..CommitOptions::default()
            },
        )
        .unwrap();
    store
        .id_write(&IdMapping {
            table: "issues".to_owned(),
            local_id: local_id.to_owned(),
            mapping: IdMappingContent::Local,
            created_time: 2,
            updated_time: 2,
        })
        .unwrap();
    store
        .rev_write(&RevState {
            key: RevKey {
                row: RowKey {
                    table: "issues".to_owned(),
                    document_id: local_id.to_owned(),
                },
                rev_id: "archive:fixture".to_owned(),
            },
            frontier: vec![1],
            snapshot: vec![2],
            log: vec![vec![3]],
            lifecycle: RevLifecycle::Archived(ArchivedRev {
                parent: "main".to_owned(),
                server_rev_id: None,
                server_root_id: None,
                server_node_id: None,
                base_root_id: None,
                base_node_id: None,
            }),
            updated_time: 4,
        })
        .unwrap();
    store
        .upload_write(&PendingUpload {
            local_storage_id: "_storage|fixture".to_owned(),
            sha256: "sha256:fixture-upload".to_owned(),
            size: 3,
            content_type: Some("text/plain".to_owned()),
            lease: UploadLease::Pending,
            created_time: 4,
            updated_time: 4,
        })
        .unwrap();
    store
        .file_write(&FileStore {
            bytes: vec![1, 2, 3],
            metadata: FileMetadata {
                storage_id: "fixture:file".to_owned(),
                sha256: "sha256:fixture-file".to_owned(),
                size: 3,
                content_type: Some("application/octet-stream".to_owned()),
                source: Some("fixture".to_owned()),
                created_time: 4,
                updated_time: 4,
            },
        })
        .unwrap();

    let settled = MutationCall {
        mutation_id: "fixture:settled".to_owned(),
        name: "issues:settled".to_owned(),
        args: "{}".to_owned(),
    };
    let settlement_seq = store
        .commit(
            WriteBatch::default(),
            &CommitOptions::terminal(
                settled.clone(),
                "null",
                false,
                Some(CommitPush {
                    mutation_id: settled.mutation_id.clone(),
                    json: serde_json::json!({"mutationId":settled.mutation_id,"crdt":[]})
                        .to_string(),
                    now_ms: 5,
                    after_images_commit_ts: false,
                }),
            ),
        )
        .unwrap()
        .commit_seq;
    store
        .remote_settlement_write(&RemoteSettlementWrite {
            mutation_id: settled.mutation_id,
            expected_commit_seq: settlement_seq,
            now_ms: 6,
            outcome: RemoteSettlementOutcome::Applied {
                ids: vec![],
                schedules: vec![],
                projections: vec![],
                crdt: vec![],
            },
        })
        .unwrap();

    let server_id = "j575pnjjhzf95ze91djp5v26b188xreb";
    let remote_local_id = "issues|22222222222222222222222222222222";
    let result = ResultEntry {
        key: "fixture:result".to_owned(),
        function: "issues:list".to_owned(),
        args: "{}".to_owned(),
        schema_hash: schema.hash,
        module_hash: "module:preview2".to_owned(),
        skeleton: br#"{"items":[null]}"#.to_vec(),
        paths: serde_json::to_vec(&serde_json::json!([{
            "path":"/items/0","table":"issues","rowId":server_id
        }]))
        .unwrap(),
        skeleton_hash: "fixture:skeleton".to_owned(),
        clock: 7.0,
    };
    store
        .remote_page_write(&RemotePageWrite {
            subscription: "fixture:subscription".to_owned(),
            members: vec![RemoteMember {
                table: "issues".to_owned(),
                server_document_id: server_id.to_owned(),
            }],
            projections: vec![AuthoritativeRow {
                table: "issues".to_owned(),
                local_document_id: Some(remote_local_id.to_owned()),
                server_document_id: server_id.to_owned(),
                plain_hash: "fixture:plain".to_owned(),
                projection_hash: "fixture:projection".to_owned(),
                current_root_id: None,
                current_node_id: None,
                row: Some(format!(
                    r#"{{"_id":"{server_id}","_creationTime":1,"body":"","title":"remote"}}"#
                )),
                logical_clock: Some(7.0),
                received_time: 7,
            }],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("fixture:cursor".to_owned()),
            received_time: 7,
            result: Some(Box::new(result)),
        })
        .unwrap();

    let mut kinds = store
        .origin_page_read(1, None, 1_000)
        .unwrap()
        .records
        .into_iter()
        .map(|record| record.kind)
        .collect::<Vec<_>>();
    kinds.sort_unstable();
    kinds.dedup();
    assert_eq!(kinds, PERMANENT_KINDS);
    store.fixture_checkpoint().unwrap();
    drop(store);
    for suffix in ["-wal", "-shm", ".owner"] {
        let auxiliary = PathBuf::from(format!("{}{suffix}", path.display()));
        if auxiliary.exists() {
            std::fs::remove_file(auxiliary).unwrap();
        }
    }
    let bytes = std::fs::read(&path).unwrap();
    println!("preview2 sha256={:x}", Sha256::digest(bytes));
    let reopened =
        EmbeddedStore::open_with_identity_key(fixture_path().to_str().unwrap(), "unauthenticated")
            .unwrap();
    reopened.setup(&fixture_schema()).unwrap();
    let snapshot = semantic_snapshot(&reopened);
    let semantic_digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&snapshot).unwrap())
    );
    let manifest = serde_json::json!({
        "name": "preview2",
        "releaseIdentity": "robelest-v0.0.1-preview-2",
        "releasePackage": "@robelest/convex-embedded",
        "releaseVersion": "0.0.1-preview-2",
        "fixtureContractVersion": 1,
        "writer": "storage epoch 47 release candidate",
        "epoch": 47,
        "bootstrapVersion": 1,
        "sha256": format!("{:x}", Sha256::digest(std::fs::read(fixture_path()).unwrap())),
        "permanentOriginKinds": PERMANENT_KINDS,
        "oracle": {
            "identityKey": "unauthenticated",
            "subscription": "fixture:subscription",
            "cursor": "fixture:cursor",
            "resultKey": "fixture:result"
        },
        "semanticSnapshot": snapshot,
        "semanticDigest": semantic_digest,
        "portableOracle": portable_snapshot(&reopened),
        "originInventory": fixture_inventory(&reopened),
        "referencedPayloadCount": reopened.origin_payload_references_debug_validate().unwrap(),
        "contract": reopened.active_contract_debug_read().unwrap(),
    });
    std::fs::write(
        fixture_dir().join("manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap()),
    )
    .unwrap();
    println!(
        "fixture-manifest={}",
        serde_json::to_string_pretty(&manifest).unwrap()
    );
    drop(reopened);
    for suffix in ["-wal", "-shm", ".owner"] {
        let auxiliary = PathBuf::from(format!("{}{suffix}", path.display()));
        if auxiliary.exists() {
            std::fs::remove_file(auxiliary).unwrap();
        }
    }
}
