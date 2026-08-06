#![cfg(feature = "testkit")]

use storage::testkit::{doc_writes, fail_next_commit, read_doc, tmp_path};
use storage::{
    ArchivedRev, ColValue, CommitChanges, CommitMutation, CommitOptions, CommitPush, CommitSource,
    DeleteIn, DocWrite, EmbeddedStore, FileMetadata, FileStore, MutationCall, OriginKind,
    ResultEntry, RevKey, RevLifecycle, RevState, RowKey, ScheduledFunctionKind, ScheduledJob,
    ScheduledState, StoreSchema, TableDef, TablePlacement, WriteBatch,
};

fn schema(hash: char) -> StoreSchema {
    StoreSchema {
        hash: hash.to_string().repeat(64),
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
        commit_ts: false,
        mutation_result_commit_ts: false,
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

fn queue_mutation(store: &EmbeddedStore, ordinal: i64, with_schedule: bool) -> MutationCall {
    let mutation_id = format!("mutation:{ordinal}");
    let call = MutationCall {
        args: "{}".to_owned(),
        mutation_id: mutation_id.clone(),
        name: "issues:update".to_owned(),
    };
    let job_id = format!("job:{ordinal}");
    let schedules = if with_schedule {
        vec![ScheduledJob {
            job_id: job_id.clone(),
            kind: ScheduledFunctionKind::Mutation,
            name: "issues:followup".to_owned(),
            args: "{}".to_owned(),
            due_time: 100 + ordinal,
            state: ScheduledState::Pending,
            created_time: 80 + ordinal,
            updated_time: 80 + ordinal,
        }]
    } else {
        Vec::new()
    };
    let local_schedules = if with_schedule {
        serde_json::json!([job_id])
    } else {
        serde_json::json!([])
    };
    store
        .commit(
            WriteBatch {
                schedules,
                ..WriteBatch::default()
            },
            &CommitOptions {
                source: CommitSource::Local,
                mutation: CommitMutation::Terminal {
                    call: call.clone(),
                    result: "null".to_owned(),
                    fresh: true,
                },
                push: Some(CommitPush {
                    mutation_id,
                    json: serde_json::json!({
                        "mutationId": call.mutation_id,
                        "mutationTime": 80 + ordinal,
                        "afterImages": [{
                            "content": "value",
                            "table": "issues",
                            "rowId": format!("issues:{ordinal}"),
                            "value": { "value": ordinal.to_string() },
                        }],
                        "crdt": [],
                        "localInserts": [],
                        "localSchedules": local_schedules,
                    })
                    .to_string(),
                    now_ms: 80 + ordinal,
                    after_images_commit_ts: false,
                }),
                changes: CommitChanges::Include,
                commit_ts: false,
                mutation_result_commit_ts: false,
            },
        )
        .unwrap();
    call
}

fn complete_queue_policy(store: &EmbeddedStore, generation: i64, policy: &str) {
    let mut request = policy.to_owned();
    loop {
        if store
            .migration_queue_policy_write(generation, &request)
            .unwrap()
        {
            return;
        }
        r#"{"collectComplete":true,"thresholds":[]}"#.clone_into(&mut request);
    }
}

fn retry_wounded_disposition_write(store: &EmbeddedStore, generation: i64) {
    let device = store
        .origin_page_read(generation, None, 1_000)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == OriginKind::DeviceDocument as i64)
        .unwrap();
    fail_next_commit();
    assert!(store
        .migration_record_disposition_write(
            generation,
            &device.identity_key,
            device.kind,
            &device.record_key,
            "wound-matrix",
            "test quarantine",
            false,
        )
        .is_err());
    store
        .migration_record_disposition_write(
            generation,
            &device.identity_key,
            device.kind,
            &device.record_key,
            "wound-matrix",
            "test quarantine",
            false,
        )
        .unwrap();
}

fn commit_candidate(
    store: &EmbeddedStore,
    schema: &StoreSchema,
    generation: i64,
) -> Result<(), storage::StorageError> {
    complete_queue_policy(
        store,
        generation,
        r#"{"collectComplete":true,"thresholds":[]}"#,
    );
    store.migration_commit(schema, generation)
}

fn write_remote_view(store: &EmbeddedStore, local_id: &str, server_id: &str, result: &ResultEntry) {
    store
        .remote_page_write(&storage::RemotePageWrite {
            subscription: "issues:list:{}".to_owned(),
            members: vec![storage::RemoteMember {
                table: "issues".to_owned(),
                server_document_id: server_id.to_owned(),
            }],
            projections: vec![storage::AuthoritativeRow {
                table: "issues".to_owned(),
                local_document_id: Some(local_id.to_owned()),
                server_document_id: server_id.to_owned(),
                plain_hash: "plain:remote".to_owned(),
                projection_hash: "projection:remote".to_owned(),
                current_root_id: Some("root:remote".to_owned()),
                current_node_id: Some("node:remote".to_owned()),
                row: Some(format!(
                    r#"{{"_id":"{server_id}","_creationTime":1,"value":"offline"}}"#
                )),
                logical_clock: Some(7.0),
                received_time: 100,
            }],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("cursor:remote".to_owned()),
            received_time: 100,
            result: Some(Box::new(result.clone())),
        })
        .unwrap();
}

#[test]
fn remote_authoritative_view_survives_candidate_cutover_without_network() {
    let path = tmp_path("migration_remote_view.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    store
        .identity_write("identity:offline", Some(r#"{"subject":"offline"}"#))
        .unwrap();
    let local_id = "issues|11111111111111111111111111111111";
    let server_id = "j575pnjjhzf95ze91djp5v26b188xreb";
    let result = ResultEntry {
        key: "result:issues:list".to_owned(),
        function: "issues:list".to_owned(),
        args: "{}".to_owned(),
        schema_hash: active.hash.clone(),
        module_hash: "module:preview2".to_owned(),
        skeleton: br#"{"items":[null]}"#.to_vec(),
        paths: serde_json::to_vec(&serde_json::json!([{
            "path": "/items/0",
            "table": "issues",
            "rowId": server_id,
        }]))
        .unwrap(),
        skeleton_hash: "skeleton:issues:list".to_owned(),
        clock: 7.0,
    };
    write_remote_view(&store, local_id, server_id, &result);

    let source = store.origin_page_read(1, None, 1_000).unwrap();
    for kind in 14..=17 {
        assert!(source.records.iter().any(|record| record.kind == kind));
    }
    let mut target = active.clone();
    target.setup_hash = "setup:package-only".to_owned();
    let candidate = store.migration_begin(&target).unwrap();
    let carried = store
        .origin_page_read(candidate.candidate_generation, None, 1_000)
        .unwrap();
    assert!(carried
        .records
        .iter()
        .filter(|record| (14..=17).contains(&record.kind))
        .all(|record| record.flags == 0));
    store
        .migration_bind(&target, candidate.candidate_generation)
        .unwrap();
    store
        .migration_setup_complete(candidate.candidate_generation)
        .unwrap();
    store.migration_unbind().unwrap();
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();

    assert_eq!(
        store
            .remote_cursor_read("issues:list:{}")
            .unwrap()
            .as_deref(),
        Some("cursor:remote")
    );
    assert_eq!(store.remote_member_read("issues:list:{}").unwrap().len(), 1);
    assert_eq!(
        read_doc(&store, "issues", local_id).unwrap()["value"],
        "offline"
    );
    assert_eq!(store.result_read(&result.key).unwrap(), Some(result));
    assert_eq!(store.identity_read().unwrap().0, "identity:offline");
    assert_eq!(store.origin_page_read(1, None, 1_000).unwrap(), source);
    drop(store);

    let reopened =
        EmbeddedStore::open_with_cached_identity_key(path.to_str().unwrap(), "", "").unwrap();
    reopened.setup(&target).unwrap();
    assert_eq!(reopened.identity_read().unwrap().0, "identity:offline");
    assert_eq!(
        read_doc(&reopened, "issues", local_id).unwrap()["value"],
        "offline"
    );
    assert_eq!(
        reopened
            .remote_cursor_read("issues:list:{}")
            .unwrap()
            .as_deref(),
        Some("cursor:remote")
    );
}

#[test]
fn epoch48_contract_separates_setup_plan_and_publishes_it_with_candidate_cutover() {
    let path = tmp_path("migration_epoch48_setup_plan.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let mut current = schema('0');
    current.setup_hash = "setup:one".to_owned();
    // First install seeds an empty base generation, then carries setup through the ordinary
    // candidate path rather than putting it in the durable StoreContract.
    let candidate = store.migration_begin(&current).unwrap();
    if candidate.required {
        store
            .migration_bind(&current, candidate.candidate_generation)
            .unwrap();
        store
            .migration_setup_complete(candidate.candidate_generation)
            .unwrap();
        store.migration_unbind().unwrap();
        commit_candidate(&store, &current, candidate.candidate_generation).unwrap();
    }
    let contract = store.active_contract_debug_read().unwrap();
    assert_eq!(store.store_epoch_debug_read().unwrap(), 48);
    assert_eq!(contract.format, 2);
    assert_eq!(contract.package_epoch, 48);
    assert!(contract.setup_hash.is_none());
    assert_eq!(store.active_setup_hash_debug_read().unwrap(), "setup:one");

    let mut next = current.clone();
    next.setup_hash = "setup:two".to_owned();
    assert!(store.setup(&next).is_err());
    let candidate = store.migration_begin(&next).unwrap();
    assert!(candidate.required);
    store
        .migration_bind(&next, candidate.candidate_generation)
        .unwrap();
    store
        .migration_setup_complete(candidate.candidate_generation)
        .unwrap();
    store.migration_unbind().unwrap();
    commit_candidate(&store, &next, candidate.candidate_generation).unwrap();
    assert_eq!(store.active_setup_hash_debug_read().unwrap(), "setup:two");
    assert!(store
        .active_contract_debug_read()
        .unwrap()
        .setup_hash
        .is_none());
}

#[test]
fn deleting_remote_subscription_deletes_its_carried_cursor_membership_and_projection() {
    let path = tmp_path("migration_remote_delete.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
    let local_id = "issues|22222222222222222222222222222222";
    let server_id = "k575pnjjhzf95ze91djp5v26b188xreb";
    store
        .remote_page_write(&storage::RemotePageWrite {
            subscription: "issues:deleted".to_owned(),
            members: vec![storage::RemoteMember {
                table: "issues".to_owned(),
                server_document_id: server_id.to_owned(),
            }],
            projections: vec![storage::AuthoritativeRow {
                table: "issues".to_owned(),
                local_document_id: Some(local_id.to_owned()),
                server_document_id: server_id.to_owned(),
                plain_hash: "plain:deleted".to_owned(),
                projection_hash: "projection:deleted".to_owned(),
                current_root_id: None,
                current_node_id: None,
                row: Some(format!(r#"{{"_id":"{server_id}","_creationTime":1}}"#)),
                logical_clock: Some(1.0),
                received_time: 10,
            }],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("cursor:deleted".to_owned()),
            received_time: 10,
            result: None,
        })
        .unwrap();
    store
        .remote_subscription_delete("issues:deleted", 20)
        .unwrap();
    let records = store.origin_page_read(1, None, 1_000).unwrap().records;
    assert!(!records
        .iter()
        .any(|record| (14..=17).contains(&record.kind)));
}

#[test]
fn carried_cursor_cannot_publish_without_its_projection_and_source_stays_active() {
    let path = tmp_path("migration_remote_cursor_guard.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    let local_id = "issues|33333333333333333333333333333333";
    let server_id = "m575pnjjhzf95ze91djp5v26b188xreb";
    store
        .remote_page_write(&storage::RemotePageWrite {
            subscription: "issues:guard".to_owned(),
            members: vec![storage::RemoteMember {
                table: "issues".to_owned(),
                server_document_id: server_id.to_owned(),
            }],
            projections: vec![storage::AuthoritativeRow {
                table: "issues".to_owned(),
                local_document_id: Some(local_id.to_owned()),
                server_document_id: server_id.to_owned(),
                plain_hash: "plain:guard".to_owned(),
                projection_hash: "projection:guard".to_owned(),
                current_root_id: None,
                current_node_id: None,
                row: Some(format!(r#"{{"_id":"{server_id}","_creationTime":1}}"#)),
                logical_clock: Some(1.0),
                received_time: 10,
            }],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("cursor:guard".to_owned()),
            received_time: 10,
            result: None,
        })
        .unwrap();
    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    let projection = store
        .origin_page_read(candidate.candidate_generation, None, 1_000)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 14)
        .unwrap();
    store
        .migration_record_disposition_write(
            candidate.candidate_generation,
            &projection.identity_key,
            projection.kind,
            &projection.record_key,
            "bad-migration",
            "attempted projection quarantine",
            false,
        )
        .unwrap();
    let error = commit_candidate(&store, &target, candidate.candidate_generation).unwrap_err();
    assert!(error.to_string().contains("has no carried projection"));
    assert_eq!(
        store.remote_cursor_read("issues:guard").unwrap().as_deref(),
        Some("cursor:guard")
    );
    assert!(read_doc(&store, "issues", local_id).is_some());
}

#[test]
fn carried_cursor_cannot_publish_with_different_retained_result_content() {
    let path = tmp_path("migration_remote_result_guard.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    let result = ResultEntry {
        key: "result:guard".to_owned(),
        function: "issues:list".to_owned(),
        args: "{}".to_owned(),
        schema_hash: active.hash.clone(),
        module_hash: "module:guard".to_owned(),
        skeleton: br#"{"items":[]}"#.to_vec(),
        paths: b"[]".to_vec(),
        skeleton_hash: "skeleton:guard".to_owned(),
        clock: 1.0,
    };
    store
        .remote_page_write(&storage::RemotePageWrite {
            subscription: "issues:result-guard".to_owned(),
            members: vec![],
            projections: vec![],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("cursor:guard".to_owned()),
            received_time: 10,
            result: Some(Box::new(result.clone())),
        })
        .unwrap();

    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    let carried_result = store
        .origin_page_read(candidate.candidate_generation, None, 1_000)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 16)
        .unwrap();
    let mut payload: serde_json::Value = serde_json::from_slice(&carried_result.payload).unwrap();
    payload["clock"] = serde_json::json!(99.0);
    let payload = serde_json::to_vec(&payload).unwrap();
    store
        .origin_payload_debug_write(
            candidate.candidate_generation,
            &carried_result.identity_key,
            carried_result.kind,
            &carried_result.record_key,
            &payload,
        )
        .unwrap();

    let error = commit_candidate(&store, &target, candidate.candidate_generation).unwrap_err();
    assert!(error
        .to_string()
        .contains("does not match retained result result:guard"));
    assert_eq!(
        store
            .remote_cursor_read("issues:result-guard")
            .unwrap()
            .as_deref(),
        Some("cursor:guard")
    );
    assert_eq!(store.result_read("result:guard").unwrap(), Some(result));
}

#[test]
fn result_only_cursor_cannot_publish_without_every_disclosed_projection() {
    let path = tmp_path("migration_result_projection_guard.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    let local_id = "issues|44444444444444444444444444444444";
    let server_id = "n575pnjjhzf95ze91djp5v26b188xreb";
    let result = ResultEntry {
        key: "result:projection-guard".to_owned(),
        function: "issues:read".to_owned(),
        args: "{}".to_owned(),
        schema_hash: active.hash.clone(),
        module_hash: "module:guard".to_owned(),
        skeleton: br#"{"value":null}"#.to_vec(),
        paths: serde_json::to_vec(&serde_json::json!([{
            "path": "/value",
            "table": "issues",
            "rowId": server_id,
        }]))
        .unwrap(),
        skeleton_hash: "skeleton:projection-guard".to_owned(),
        clock: 1.0,
    };
    let projection = storage::AuthoritativeRow {
        table: "issues".to_owned(),
        local_document_id: Some(local_id.to_owned()),
        server_document_id: server_id.to_owned(),
        plain_hash: "plain:result-guard".to_owned(),
        projection_hash: "projection:result-guard".to_owned(),
        current_root_id: None,
        current_node_id: None,
        row: Some(format!(r#"{{"_id":"{server_id}","_creationTime":1}}"#)),
        logical_clock: Some(1.0),
        received_time: 10,
    };
    store
        .remote_page_write(&storage::RemotePageWrite {
            subscription: "issues:result-projection-guard".to_owned(),
            members: vec![storage::RemoteMember {
                table: "issues".to_owned(),
                server_document_id: server_id.to_owned(),
            }],
            projections: vec![projection],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("cursor:member-seed".to_owned()),
            received_time: 9,
            result: None,
        })
        .unwrap();
    store
        .remote_page_write(&storage::RemotePageWrite {
            subscription: "issues:result-projection-guard".to_owned(),
            members: vec![],
            projections: vec![],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("cursor:projection-guard".to_owned()),
            received_time: 10,
            result: Some(Box::new(result.clone())),
        })
        .unwrap();

    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    let projection = store
        .origin_page_read(candidate.candidate_generation, None, 1_000)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 14)
        .unwrap();
    store
        .migration_record_disposition_write(
            candidate.candidate_generation,
            &projection.identity_key,
            projection.kind,
            &projection.record_key,
            "bad-result-migration",
            "attempted result projection quarantine",
            false,
        )
        .unwrap();

    let error = commit_candidate(&store, &target, candidate.candidate_generation).unwrap_err();
    assert!(error
        .to_string()
        .contains("references missing projection issues:"));
    assert_eq!(
        store
            .remote_cursor_read("issues:result-projection-guard")
            .unwrap()
            .as_deref(),
        Some("cursor:projection-guard")
    );
    assert_eq!(store.result_read(&result.key).unwrap(), Some(result));
    assert!(read_doc(&store, "issues", local_id).is_some());
}

#[test]
fn cursorless_result_paths_are_cache_only_and_do_not_claim_projection_dependencies() {
    let path = tmp_path("migration_cursorless_result_paths.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    let result = ResultEntry {
        key: "result:cursorless".to_owned(),
        function: "issues:read".to_owned(),
        args: "{}".to_owned(),
        schema_hash: active.hash.clone(),
        module_hash: "module:cursorless".to_owned(),
        skeleton: br#"{"value":null}"#.to_vec(),
        paths: serde_json::to_vec(&serde_json::json!([{
            "path": "/value",
            "table": "issues",
            "rowId": "n575pnjjhzf95ze91djp5v26b188xreb",
        }]))
        .unwrap(),
        skeleton_hash: "skeleton:cursorless".to_owned(),
        clock: 1.0,
    };
    store
        .remote_page_write(&storage::RemotePageWrite {
            subscription: "issues:cursorless-result".to_owned(),
            members: vec![],
            projections: vec![],
            crdt: vec![],
            blobs: vec![],
            cursor: None,
            received_time: 10,
            result: Some(Box::new(result.clone())),
        })
        .unwrap();

    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();
    assert_eq!(store.result_read(&result.key).unwrap(), Some(result));
    assert_eq!(
        store
            .remote_cursor_read("issues:cursorless-result")
            .unwrap(),
        None,
        "a cursorless cache entry cannot publish a carried cursor"
    );
}

#[test]
#[allow(clippy::too_many_lines)]
fn candidate_quarantines_an_incompatible_queue_bundle_before_materialization() {
    let path = tmp_path("migration_candidate.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
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

    let queued_call = MutationCall {
        args: "{}".to_owned(),
        mutation_id: "mutation:queued".to_owned(),
        name: "preferences:update".to_owned(),
    };
    store
        .commit(
            WriteBatch {
                schedules: vec![ScheduledJob {
                    job_id: "job:queued".to_owned(),
                    kind: ScheduledFunctionKind::Mutation,
                    name: "preferences:cleanup".to_owned(),
                    args: "{}".to_owned(),
                    due_time: 100,
                    state: ScheduledState::Pending,
                    created_time: 80,
                    updated_time: 80,
                }],
                ..WriteBatch::default()
            },
            &CommitOptions {
                source: CommitSource::Local,
                mutation: CommitMutation::Terminal {
                    call: queued_call.clone(),
                    result: "null".to_owned(),
                    fresh: true,
                },
                push: Some(CommitPush {
                    mutation_id: queued_call.mutation_id.clone(),
                    json: r#"{"mutationId":"mutation:queued","mutationTime":80,"afterImages":[{"content":"value","table":"issues","rowId":"local:queued","value":{"value":"optimistic"},"creationTime":80}],"crdt":[],"localInserts":["local:queued"],"localSchedules":["job:queued"]}"#.to_owned(),
                    now_ms: 80,
                    after_images_commit_ts: false,
                }),
                changes: CommitChanges::Include,
                commit_ts: false,
                mutation_result_commit_ts: false,
            },
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

    let mut target = schema('1');
    // The queued envelope cannot be replayed once this release removes its target table. The
    // TypeScript validator phase supplies the first incompatible sequence; storage retires the
    // whole derived bundle atomically while preserving its exact originated bytes in quarantine.
    target.tables.retain(|table| table.name != "issues");
    let candidate = store.migration_begin(&target).unwrap();
    assert!(candidate.required);
    let (queue_identity, queue_seq) = store
        .origin_page_read(candidate.candidate_generation, None, 100)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 5)
        .map(|record| {
            let commit_seq = serde_json::from_slice::<serde_json::Value>(&record.payload).unwrap()
                ["commitSeq"]
                .as_i64()
                .unwrap();
            (record.identity_key, commit_seq)
        })
        .unwrap();
    let policy = serde_json::json!({
        "collectComplete": true,
        "thresholds": [{ "identityKey": queue_identity, "commitSeq": queue_seq }]
    })
    .to_string();
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "dark"
    );

    complete_queue_policy(&store, candidate.candidate_generation, &policy);
    // Reapplying after a restart is a no-op over the already quarantined bundle.
    assert!(store
        .migration_queue_policy_write(candidate.candidate_generation, &policy,)
        .unwrap());
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();

    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "dark"
    );
    assert!(store.doc_read("issues", "server-1").is_err());
    assert!(store.schedule_read().unwrap().is_empty());
    assert_eq!(
        store.mutation_cache_read(&queued_call).unwrap().status,
        storage::MutationStatus::Committed
    );
    assert!(store.remote_push_envelope_read(10).unwrap().is_empty());
    assert!(!store
        .origin_page_read(candidate.active_generation, None, 100)
        .unwrap()
        .records
        .is_empty());
}

#[test]
fn queue_policy_keeps_the_compatible_prefix_and_quarantines_the_causal_suffix() {
    let path = tmp_path("migration_queue_suffix.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
    let first = queue_mutation(&store, 1, false);
    let second = queue_mutation(&store, 2, true);
    let third = queue_mutation(&store, 3, true);

    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    let records = store
        .origin_page_read(candidate.candidate_generation, None, 200)
        .unwrap()
        .records;
    let (identity_key, threshold) = records
        .iter()
        .filter(|record| record.kind == 5)
        .find_map(|record| {
            let value = serde_json::from_slice::<serde_json::Value>(&record.payload).ok()?;
            (value["mutationId"] == second.mutation_id).then(|| {
                (
                    record.identity_key.clone(),
                    value["commitSeq"].as_i64().unwrap(),
                )
            })
        })
        .unwrap();
    let policy = serde_json::json!({
        "collectComplete": true,
        "thresholds": [{ "identityKey": identity_key, "commitSeq": threshold }]
    })
    .to_string();

    // Persist the threshold and stop before the first association page. Reopening must resume from
    // that original boundary even if later pages have already changed flags on another crash.
    assert!(!store
        .migration_queue_policy_write(candidate.candidate_generation, &policy)
        .unwrap());
    assert!(store
        .migration_commit(&target, candidate.candidate_generation)
        .unwrap_err()
        .to_string()
        .contains("queued-mutation policy has not completed"));
    drop(store);
    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let resumed = reopened.migration_begin(&target).unwrap();
    assert!(resumed.resumed);
    complete_queue_policy(
        &reopened,
        resumed.candidate_generation,
        r#"{"collectComplete":true,"thresholds":[]}"#,
    );
    commit_candidate(&reopened, &target, resumed.candidate_generation).unwrap();

    let queue = reopened.remote_push_envelope_read(10).unwrap();
    assert_eq!(queue.len(), 1);
    assert!(queue[0].contains(&first.mutation_id));
    assert!(reopened.schedule_read().unwrap().is_empty());
    assert_eq!(
        reopened.mutation_cache_read(&first).unwrap().status,
        storage::MutationStatus::Committed
    );
    for call in [&second, &third] {
        assert_eq!(
            reopened.mutation_cache_read(call).unwrap().status,
            storage::MutationStatus::Committed
        );
    }
    let quarantined = reopened
        .origin_page_read(candidate.candidate_generation, None, 200)
        .unwrap()
        .records
        .into_iter()
        .filter(|record| record.kind == 5 && record.flags == 1)
        .collect::<Vec<_>>();
    assert_eq!(quarantined.len(), 2);
    for record in quarantined {
        let wrapper: serde_json::Value = serde_json::from_slice(&record.payload).unwrap();
        assert!(wrapper["priorPayload"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
    }
}

#[test]
#[allow(clippy::too_many_lines)]
fn queue_policy_bounds_one_envelope_fanout_and_resumes_its_subpage() {
    let path = tmp_path("migration_queue_fanout.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
    let mutation_id = "mutation:fanout".to_owned();
    let call = MutationCall {
        args: "{}".to_owned(),
        mutation_id: mutation_id.clone(),
        name: "issues:fanout".to_owned(),
    };
    let job_ids = (0..300)
        .map(|ordinal| format!("job:fanout:{ordinal}"))
        .collect::<Vec<_>>();
    let schedules = job_ids
        .iter()
        .enumerate()
        .map(|(ordinal, job_id)| ScheduledJob {
            job_id: job_id.clone(),
            kind: ScheduledFunctionKind::Mutation,
            name: "issues:followup".to_owned(),
            args: "{}".to_owned(),
            due_time: 100 + ordinal as i64,
            state: ScheduledState::Pending,
            created_time: 80,
            updated_time: 80,
        })
        .collect();
    store
        .commit(
            WriteBatch {
                schedules,
                ..WriteBatch::default()
            },
            &CommitOptions {
                source: CommitSource::Local,
                mutation: CommitMutation::Terminal {
                    call: call.clone(),
                    result: "null".to_owned(),
                    fresh: true,
                },
                push: Some(CommitPush {
                    mutation_id,
                    json: serde_json::json!({
                        "mutationId": call.mutation_id,
                        "mutationTime": 80,
                        "afterImages": [],
                        "crdt": [],
                        "localInserts": [],
                        "localSchedules": job_ids,
                    })
                    .to_string(),
                    now_ms: 80,
                    after_images_commit_ts: false,
                }),
                changes: CommitChanges::Include,
                commit_ts: false,
                mutation_result_commit_ts: false,
            },
        )
        .unwrap();

    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    let envelope = store
        .origin_page_read(candidate.candidate_generation, None, 1_000)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 5)
        .unwrap();
    let commit_seq = serde_json::from_slice::<serde_json::Value>(&envelope.payload).unwrap()
        ["commitSeq"]
        .as_i64()
        .unwrap();
    let policy = serde_json::json!({
        "collectComplete": true,
        "thresholds": [{
            "identityKey": envelope.identity_key,
            "commitSeq": commit_seq,
        }],
    })
    .to_string();
    // Collection only transitions phases. The next call writes exactly one 256-marker subpage,
    // not all 300 derived schedule associations in one transaction.
    assert!(!store
        .migration_queue_policy_write(candidate.candidate_generation, &policy)
        .unwrap());
    assert!(!store
        .migration_queue_policy_write(
            candidate.candidate_generation,
            r#"{"collectComplete":true,"thresholds":[]}"#,
        )
        .unwrap());
    assert_eq!(
        store
            .origin_page_read(candidate.candidate_generation, None, 1_000)
            .unwrap()
            .records
            .into_iter()
            .filter(|record| record.kind == 13)
            .count(),
        257
    );
    drop(store);

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let resumed = reopened.migration_begin(&target).unwrap();
    complete_queue_policy(
        &reopened,
        resumed.candidate_generation,
        r#"{"collectComplete":true,"thresholds":[]}"#,
    );
    commit_candidate(&reopened, &target, resumed.candidate_generation).unwrap();
    assert!(reopened.schedule_read().unwrap().is_empty());
    assert!(reopened.remote_push_envelope_read(10).unwrap().is_empty());
    assert_eq!(
        reopened.mutation_cache_read(&call).unwrap().status,
        storage::MutationStatus::Committed
    );
}

#[test]
fn queue_policy_rejects_an_oversized_threshold_page_at_the_store_boundary() {
    let path = tmp_path("migration_queue_threshold_limit.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    let thresholds = (0..257)
        .map(|ordinal| {
            serde_json::json!({
                "identityKey": format!("identity:{ordinal}"),
                "commitSeq": ordinal,
            })
        })
        .collect::<Vec<_>>();
    let error = store
        .migration_queue_policy_write(
            candidate.candidate_generation,
            &serde_json::json!({
                "collectComplete": false,
                "thresholds": thresholds,
            })
            .to_string(),
        )
        .unwrap_err();
    assert!(error.to_string().contains("at most 256 thresholds"));
}

#[test]
fn abandoned_candidate_never_changes_the_active_generation() {
    let path = tmp_path("migration_abandon.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
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
    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    assert_ne!(candidate.active_generation, candidate.candidate_generation);
    drop(store);

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    reopened.setup(&schema('0')).unwrap();
    assert_eq!(
        read_doc(&reopened, "preferences", "device-1").unwrap()["value"],
        "kept"
    );
}

#[test]
fn bound_candidate_routes_ordinary_document_commits_until_cutover() {
    let path = tmp_path("migration_bound_candidate.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "old",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();

    let mut target = schema('0');
    target.setup_hash = "setup:preferences-v2".to_owned();
    let candidate = store.migration_begin(&target).unwrap();
    assert!(candidate.required);
    store
        .migration_bind(&target, candidate.candidate_generation)
        .unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "new",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    store
        .migration_setup_complete(candidate.candidate_generation)
        .unwrap();
    store.migration_unbind().unwrap();

    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "old"
    );
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "new"
    );
}

#[test]
fn skipped_release_can_read_a_dropped_table_in_the_candidate_workspace() {
    let path = tmp_path("migration_dropped_table_workspace.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "from-skipped-release",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();

    // The app skipped an intermediate release that would have copied preferences into its local
    // issues table; its current target has already removed the legacy table.
    let mut target = schema('1');
    target.tables.retain(|table| table.name != "preferences");
    target
        .tables
        .iter_mut()
        .find(|table| table.name == "issues")
        .unwrap()
        .placement = TablePlacement::Device;
    target.setup_hash = "setup:retire-preferences".to_owned();
    let candidate = store.migration_begin(&target).unwrap();
    assert!(candidate.required);
    assert!(candidate
        .source_schema
        .tables
        .iter()
        .any(|table| table.name == "preferences"));

    let mut workspace = target.clone();
    workspace.tables.push(
        candidate
            .source_schema
            .tables
            .iter()
            .find(|table| table.name == "preferences")
            .unwrap()
            .clone(),
    );
    store
        .migration_bind(&workspace, candidate.candidate_generation)
        .unwrap();
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "from-skipped-release"
    );
    store
        .commit(
            doc_writes(vec![write(
                "issues",
                "copied-1",
                "from-skipped-release",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    store
        .commit(
            WriteBatch {
                doc_writes: vec![],
                local_field_writes: vec![],
                local_field_deletes: vec![],
                crdt_ops: vec![],
                crdt_restores: vec![],
                deletes: vec![DeleteIn {
                    table: "preferences".to_owned(),
                    id: "device-1".to_owned(),
                }],
                fresh_ids: vec![],
                data_only_ids: vec![],
                commit_ts_doc_writes: vec![],
                commit_ts_local_field_writes: vec![],
                id_mappings: vec![],
                schedules: vec![],
            },
            &options(CommitSource::Device),
        )
        .unwrap();
    store
        .migration_setup_complete(candidate.candidate_generation)
        .unwrap();
    store.migration_unbind().unwrap();

    // The active generation still has the legacy data until atomic cutover.
    assert!(read_doc(&store, "issues", "copied-1").is_none());
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();
    assert_eq!(
        read_doc(&store, "issues", "copied-1").unwrap()["value"],
        "from-skipped-release"
    );
}

#[test]
fn resumed_setup_does_not_recopy_origins_over_transformed_or_deleted_records() {
    let path = tmp_path("migration_setup_resume_origin_copy.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
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

    let mut target = schema('1');
    target.tables.retain(|table| table.name != "preferences");
    target
        .tables
        .iter_mut()
        .find(|table| table.name == "issues")
        .unwrap()
        .placement = TablePlacement::Device;
    target.setup_hash = "setup:resume-origin-copy".to_owned();
    let first = store.migration_begin(&target).unwrap();
    let mut workspace = target.clone();
    workspace.tables.push(
        first
            .source_schema
            .tables
            .iter()
            .find(|table| table.name == "preferences")
            .unwrap()
            .clone(),
    );
    store
        .migration_bind(&workspace, first.candidate_generation)
        .unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "issues",
                "copied-1",
                "transformed",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    store
        .commit(
            WriteBatch {
                doc_writes: vec![],
                local_field_writes: vec![],
                local_field_deletes: vec![],
                crdt_ops: vec![],
                crdt_restores: vec![],
                deletes: vec![DeleteIn {
                    table: "preferences".to_owned(),
                    id: "device-1".to_owned(),
                }],
                fresh_ids: vec![],
                data_only_ids: vec![],
                commit_ts_doc_writes: vec![],
                commit_ts_local_field_writes: vec![],
                id_mappings: vec![],
                schedules: vec![],
            },
            &options(CommitSource::Device),
        )
        .unwrap();
    store.migration_unbind().unwrap();
    drop(store);

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let resumed = reopened.migration_begin(&target).unwrap();
    assert!(resumed.resumed);
    assert_eq!(resumed.candidate_generation, first.candidate_generation);
    reopened
        .migration_bind(&workspace, resumed.candidate_generation)
        .unwrap();
    assert!(read_doc(&reopened, "preferences", "device-1").is_none());
    assert_eq!(
        read_doc(&reopened, "issues", "copied-1").unwrap()["value"],
        "transformed"
    );
}

#[test]
fn completed_setup_resumes_at_finalization_and_can_be_retired_later() {
    let path = tmp_path("migration_setup_complete.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();

    let mut target = schema('0');
    target.setup_hash = "setup:complete".to_owned();
    let candidate = store.migration_begin(&target).unwrap();
    assert!(!candidate.setup_complete);
    store
        .migration_bind(&target, candidate.candidate_generation)
        .unwrap();
    store
        .migration_setup_complete(candidate.candidate_generation)
        .unwrap();
    store.migration_unbind().unwrap();
    drop(store);

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let resumed = reopened.migration_begin(&target).unwrap();
    assert!(resumed.resumed);
    assert!(resumed.setup_complete);
    commit_candidate(&reopened, &target, resumed.candidate_generation).unwrap();

    let retired = reopened.migration_begin(&active).unwrap();
    assert!(!retired.required);
    reopened.setup(&active).unwrap();
}

#[test]
fn setup_bearing_candidate_cannot_publish_without_setup_completion() {
    let path = tmp_path("migration_setup_required.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    store
        .commit(
            doc_writes(vec![write("preferences", "device-1", "active", 1.0)]),
            &options(CommitSource::Device),
        )
        .unwrap();

    let mut target = active.clone();
    target.setup_hash = "setup:required".to_owned();
    let candidate = store.migration_begin(&target).unwrap();
    let error = commit_candidate(&store, &target, candidate.candidate_generation).unwrap_err();

    assert!(error.to_string().contains("app setup has not completed"));
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "active"
    );
    assert!(!store.migration_begin(&target).unwrap().setup_complete);
}

#[test]
fn every_candidate_transaction_is_retryable_across_deterministic_commit_wounds() {
    let path = tmp_path("migration_phase_wounds.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    store
        .commit(
            doc_writes(vec![write("preferences", "device-1", "active", 1.0)]),
            &options(CommitSource::Device),
        )
        .unwrap();
    let mut target = schema('1');
    target.setup_hash = "setup:wound-matrix".to_owned();
    let candidate = store.migration_prepare(&target).unwrap();
    let generation = candidate.candidate_generation;

    fail_next_commit();
    assert!(store.migration_copy_step(generation).is_err());
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "active"
    );
    while !store.migration_copy_step(generation).unwrap().done {}

    fail_next_commit();
    assert!(store
        .migration_queue_policy_write(
            generation,
            r#"{"collectComplete":true,"thresholds":[],"cursor":null}"#,
        )
        .is_err());
    complete_queue_policy(
        &store,
        generation,
        r#"{"collectComplete":true,"thresholds":[],"cursor":null}"#,
    );

    retry_wounded_disposition_write(&store, generation);

    store.migration_bind_prepare(&target, generation).unwrap();
    while !store.migration_materialize_step(generation).unwrap().done {}
    fail_next_commit();
    assert!(store.migration_setup_complete(generation).is_err());
    store.migration_setup_complete(generation).unwrap();
    store.migration_unbind().unwrap();

    fail_next_commit();
    assert!(store
        .migration_finalize_prepare(&target, generation)
        .is_err());
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "active"
    );
    store
        .migration_finalize_prepare(&target, generation)
        .unwrap();
    store.migration_bind_prepare(&target, generation).unwrap();
    fail_next_commit();
    assert!(store.migration_materialize_step(generation).is_err());
    store.migration_unbind().unwrap();
    store.migration_bind_prepare(&target, generation).unwrap();
    while !store.migration_materialize_step(generation).unwrap().done {}
    store.migration_unbind().unwrap();

    fail_next_commit();
    assert!(store.migration_cutover(&target, generation).is_err());
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "active"
    );
    store.migration_cutover(&target, generation).unwrap();
    assert!(read_doc(&store, "preferences", "device-1").is_none());

    fail_next_commit();
    assert!(store
        .migration_retire_step(candidate.active_generation)
        .is_err());
    while !store
        .migration_retire_step(candidate.active_generation)
        .unwrap()
        .done
    {}
    assert!(store
        .migration_begin(&target)
        .unwrap()
        .retired_generations
        .is_empty());
}

#[test]
fn quarantine_retains_the_candidate_record_without_materializing_it() {
    let path = tmp_path("migration_quarantine.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
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
    let target = schema('1');
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
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();
    assert!(read_doc(&store, "preferences", "device-1").is_none());
}

#[test]
fn pre_baseline_store_is_preserved_and_rejected_without_repair() {
    let path = tmp_path("migration_preview1_cutoff.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let source = schema('0');
    store.setup(&source).unwrap();
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
    let before = store.origin_page_read(1, None, 100).unwrap();
    store.force_user_version_for_test(46);

    let error = store.migration_begin(&schema('1')).unwrap_err();
    assert!(matches!(
        error,
        storage::StorageError::PreBaselineStore {
            found: 46,
            minimum: 47
        }
    ));
    assert_eq!(store.origin_page_read(1, None, 100).unwrap(), before);
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "preserved"
    );
    drop(store);
    assert!(matches!(
        EmbeddedStore::open(path.to_str().unwrap()).err().unwrap(),
        storage::StorageError::PreBaselineStore {
            found: 46,
            minimum: 47
        }
    ));
}

#[test]
fn unknown_origin_codec_stops_candidate_copy_without_mutating_source() {
    let path = tmp_path("migration_unknown_origin_codec.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
    store
        .commit(
            doc_writes(vec![write(
                "preferences",
                "device-1",
                "source",
                store.clock_read().unwrap(),
            )]),
            &options(CommitSource::Device),
        )
        .unwrap();
    let record = store
        .origin_page_read(1, None, 100)
        .unwrap()
        .records
        .into_iter()
        .find(|record| record.kind == 2)
        .unwrap();
    store
        .origin_codec_debug_write(
            1,
            &record.identity_key,
            record.kind,
            &record.record_key,
            999,
        )
        .unwrap();
    let source = store.origin_page_read(1, None, 100).unwrap();

    let error = store.migration_begin(&schema('1')).unwrap_err();
    assert!(error
        .to_string()
        .contains("unsupported originated codec 999"));
    assert_eq!(store.origin_page_read(1, None, 100).unwrap(), source);
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "source"
    );
}

#[test]
#[allow(clippy::too_many_lines)]
fn retained_codec2_blob_and_revision_records_survive_copy_and_disposition_wrappers() {
    let path = tmp_path("migration_retained_codec2.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
    store
        .file_write(&FileStore {
            bytes: vec![1, 2, 3],
            metadata: FileMetadata {
                storage_id: "codec2:file".to_owned(),
                sha256: "sha256:codec2".to_owned(),
                size: 3,
                content_type: None,
                source: None,
                created_time: 1,
                updated_time: 1,
            },
        })
        .unwrap();
    store
        .rev_write(&RevState {
            key: RevKey {
                row: RowKey {
                    table: "issues".to_owned(),
                    document_id: "codec2:row".to_owned(),
                },
                rev_id: "archive:codec2".to_owned(),
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
            updated_time: 1,
        })
        .unwrap();
    let source_records = store.origin_page_read(1, None, 1_000).unwrap().records;
    for record in source_records
        .iter()
        .filter(|record| matches!(record.kind, 9 | 10))
    {
        store
            .origin_codec_debug_write(1, &record.identity_key, record.kind, &record.record_key, 2)
            .unwrap();
    }
    let source = store.origin_page_read(1, None, 1_000).unwrap();
    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    let copied = store
        .origin_page_read(candidate.candidate_generation, None, 1_000)
        .unwrap();
    assert!(copied
        .records
        .iter()
        .filter(|record| matches!(record.kind, 9 | 10))
        .all(|record| record.codec == 1));
    for (kind, discard) in [(9, false), (10, true)] {
        let record = copied
            .records
            .iter()
            .find(|record| record.kind == kind)
            .unwrap();
        store
            .origin_codec_debug_write(
                candidate.candidate_generation,
                &record.identity_key,
                kind,
                &record.record_key,
                2,
            )
            .unwrap();
        store
            .migration_record_disposition_write(
                candidate.candidate_generation,
                &record.identity_key,
                kind,
                &record.record_key,
                "codec2-policy",
                "fixture disposition",
                discard,
            )
            .unwrap();
    }
    let dispositions = store
        .origin_page_read(candidate.candidate_generation, None, 1_000)
        .unwrap();
    for record in dispositions
        .records
        .iter()
        .filter(|record| matches!(record.kind, 9 | 10))
    {
        assert_eq!(
            record.codec, 1,
            "wrapper codec is independent of semantic codec"
        );
        let wrapper: serde_json::Value = serde_json::from_slice(&record.payload).unwrap();
        assert_eq!(wrapper["priorCodec"], 2);
    }
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();
    assert_eq!(store.origin_page_read(1, None, 1_000).unwrap(), source);
    store.migration_retire(candidate.active_generation).unwrap();
}

#[test]
fn missing_active_contract_is_not_fabricated_from_target() {
    let path = tmp_path("migration_missing_active_contract.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let current = schema('0');
    store.setup(&current).unwrap();
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
    store.active_contract_debug_delete().unwrap();

    let error = store.migration_begin(&current).unwrap_err();
    assert!(error.to_string().contains("no active contract"));
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "preserved"
    );
}

#[test]
fn origin_writer_identity_is_distinct_from_retained_reader_coverage() {
    let (writer, readers) = storage::origin_codec_manifest_debug();
    assert_ne!(writer, readers);
    assert_eq!(writer.len(), 64);
    assert_eq!(readers.len(), 64);
    assert!(storage::origin_adapter_applies_debug(47, 49, 51));
    assert!(!storage::origin_adapter_applies_debug(49, 49, 51));
    assert!(!storage::origin_adapter_applies_debug(47, 52, 51));
}

#[test]
fn reader_only_contract_evolution_neither_migrates_nor_rewrites_active_contract() {
    let path = tmp_path("migration_reader_only_contract.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let current = schema('0');
    store.setup(&current).unwrap();
    store
        .contract_reader_hash_debug_write("reader:previous-release")
        .unwrap();

    let before = store.migration_begin(&current).unwrap();
    assert!(!before.required);
    assert_ne!(before.source_contract_hash, before.target_contract_hash);
    store.setup(&current).unwrap();
    let after = store.migration_begin(&current).unwrap();
    assert!(!after.required);
    assert_eq!(after.source_contract_hash, before.source_contract_hash);
    assert_eq!(after.target_contract_hash, before.target_contract_hash);
}

#[test]
fn failed_materialization_page_resumes_without_cutting_over() {
    let path = tmp_path("migration_materialize_resume.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
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
    let pending = MutationCall {
        args: "{}".to_owned(),
        mutation_id: "mutation:resume".to_owned(),
        name: "issues:update".to_owned(),
    };
    store.mutation_write(&pending).unwrap();
    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    complete_queue_policy(
        &store,
        candidate.candidate_generation,
        r#"{"collectComplete":true,"thresholds":[]}"#,
    );

    fail_next_commit();
    assert!(store
        .migration_commit(&target, candidate.candidate_generation)
        .is_err());
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "preserved"
    );
    drop(store);

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let resumed = reopened.migration_begin(&target).unwrap();
    assert!(resumed.resumed);
    reopened
        .migration_bind(&target, resumed.candidate_generation)
        .unwrap();
    assert_eq!(
        read_doc(&reopened, "preferences", "device-1").unwrap()["value"],
        "preserved"
    );
    assert_eq!(
        reopened.mutation_cache_read(&pending).unwrap().status,
        storage::MutationStatus::Accepted
    );
    reopened.migration_unbind().unwrap();
    commit_candidate(&reopened, &target, resumed.candidate_generation).unwrap();
    assert_eq!(
        read_doc(&reopened, "preferences", "device-1").unwrap()["value"],
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
    store.setup(&schema('0')).unwrap();
    store.bootstrap_version_debug_write(2).unwrap();
    drop(store);

    let error = EmbeddedStore::open(path.to_str().unwrap()).err().unwrap();
    assert!(error
        .to_string()
        .contains("unsupported bootstrap version 2"));
}

#[test]
fn an_older_runtime_cannot_rebuild_a_newer_semantic_contract_backward() {
    let path = tmp_path("migration_contract_downgrade.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let current = schema('0');
    store.setup(&current).unwrap();
    let local_id = "issues|11111111111111111111111111111111";
    let server_id = "j575pnjjhzf95ze91djp5v26b188xreb";
    store
        .remote_page_write(&storage::RemotePageWrite {
            subscription: "issues:list:{}".to_owned(),
            members: vec![storage::RemoteMember {
                table: "issues".to_owned(),
                server_document_id: server_id.to_owned(),
            }],
            projections: vec![storage::AuthoritativeRow {
                table: "issues".to_owned(),
                local_document_id: Some(local_id.to_owned()),
                server_document_id: server_id.to_owned(),
                plain_hash: "plain:newer".to_owned(),
                projection_hash: "sha256:newer".to_owned(),
                current_root_id: None,
                current_node_id: None,
                row: Some(format!(
                    r#"{{"_id":"{server_id}","_creationTime":1,"value":"remote"}}"#
                )),
                logical_clock: Some(1.0),
                received_time: 10,
            }],
            crdt: vec![],
            blobs: vec![],
            cursor: Some("newer:cursor".to_owned()),
            received_time: 10,
            result: None,
        })
        .unwrap();
    store.id_delete("issues", local_id).unwrap();
    store.contract_epoch_debug_write(47).unwrap();

    let error = store.migration_begin(&current).err().unwrap();
    assert!(error
        .to_string()
        .contains("supported SQLite/bootstrap/schema contract"));
    assert!(store.id_read("issues", local_id).unwrap().is_none());
}

#[test]
fn retired_generation_cleanup_keeps_reachable_payloads_and_reclaims_orphans() {
    let path = tmp_path("migration_payload_cleanup.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
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

    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();
    store.migration_retire(candidate.active_generation).unwrap();

    assert_eq!(store.origin_payload_count_debug_read().unwrap(), 1);
    assert_eq!(store.blob_read("live").unwrap(), Some(vec![1, 2, 3]));
}

#[test]
fn stale_candidate_cleanup_is_explicit_bounded_and_reprepared() {
    let path = tmp_path("migration_stale_candidate_cleanup.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let active = schema('0');
    store.setup(&active).unwrap();
    store
        .commit(
            doc_writes(vec![write("preferences", "device-1", "active", 1.0)]),
            &options(CommitSource::Device),
        )
        .unwrap();

    let first = store.migration_prepare(&schema('1')).unwrap();
    assert_eq!(first.candidate_generation, 2);
    assert!(store
        .migration_retire_step(first.candidate_generation)
        .unwrap_err()
        .to_string()
        .contains("live candidate"));

    store
        .migration_bind_prepare(&schema('1'), first.candidate_generation)
        .unwrap();
    assert!(store
        .migration_retire_step(first.active_generation)
        .unwrap_err()
        .to_string()
        .contains("published active"));
    store.migration_unbind().unwrap();

    let cleanup = store.migration_prepare(&schema('2')).unwrap();
    assert_eq!(cleanup.cleanup_generation, Some(first.candidate_generation));
    assert!(!cleanup.required);
    assert!(store
        .migration_copy_step(first.candidate_generation)
        .unwrap_err()
        .to_string()
        .contains("authorized only for retirement"));
    while !store
        .migration_retire_step(cleanup.cleanup_generation.unwrap())
        .unwrap()
        .done
    {}

    let second = store.migration_prepare(&schema('2')).unwrap();
    assert_eq!(second.cleanup_generation, None);
    assert_eq!(second.candidate_generation, 3);
    assert!(second.required);
    assert_eq!(
        read_doc(&store, "preferences", "device-1").unwrap()["value"],
        "active"
    );
}

#[test]
fn payload_cleanup_rewinds_marking_after_process_restart() {
    let path = tmp_path("migration_payload_cleanup_restart.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
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
    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();

    loop {
        let step = store
            .migration_retire_step(candidate.active_generation)
            .unwrap();
        assert!(!step.done);
        if step.records == 0 {
            break;
        }
    }
    let marked = store
        .migration_retire_step(candidate.active_generation)
        .unwrap();
    assert!(marked.records >= 1);
    assert_eq!(store.origin_payload_count_debug_read().unwrap(), 2);
    drop(store);

    let reopened = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    let rewound = reopened
        .migration_retire_step(candidate.active_generation)
        .unwrap();
    assert!(!rewound.done);
    assert_eq!(rewound.records, 0);
    assert_eq!(reopened.origin_payload_count_debug_read().unwrap(), 2);
    while !reopened
        .migration_retire_step(candidate.active_generation)
        .unwrap()
        .done
    {}
    assert_eq!(reopened.origin_payload_count_debug_read().unwrap(), 1);
    assert_eq!(reopened.blob_read("live").unwrap(), Some(vec![1, 2, 3]));
}

#[test]
fn every_retirement_cleanup_step_is_retryable_after_commit_wounds() {
    let path = tmp_path("migration_retirement_wounds.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
    store
        .file_write(&FileStore {
            bytes: vec![1, 2, 3],
            metadata: FileMetadata {
                storage_id: "live".to_owned(),
                sha256: "sha256:live".to_owned(),
                size: 3,
                content_type: None,
                source: None,
                created_time: 1,
                updated_time: 1,
            },
        })
        .unwrap();
    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    commit_candidate(&store, &target, candidate.candidate_generation).unwrap();

    loop {
        fail_next_commit();
        assert!(store
            .migration_retire_step(candidate.active_generation)
            .is_err());
        if store
            .migration_retire_step(candidate.active_generation)
            .unwrap()
            .done
        {
            break;
        }
    }
    assert_eq!(store.origin_payload_references_debug_validate().unwrap(), 1);
    assert_eq!(store.blob_read("live").unwrap(), Some(vec![1, 2, 3]));
}

#[test]
fn a_corrupt_content_addressed_payload_cannot_cut_over() {
    let path = tmp_path("migration_payload_corrupt.db");
    let store = EmbeddedStore::open(path.to_str().unwrap()).unwrap();
    store.setup(&schema('0')).unwrap();
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

    let target = schema('1');
    let candidate = store.migration_begin(&target).unwrap();
    complete_queue_policy(
        &store,
        candidate.candidate_generation,
        r#"{"collectComplete":true,"thresholds":[]}"#,
    );
    let error = store
        .migration_commit(&target, candidate.candidate_generation)
        .err()
        .unwrap();
    assert!(error.to_string().contains("payload checksum mismatch"));
    assert_eq!(store.blob_read("file").unwrap(), Some(vec![1, 2, 3]));
}
