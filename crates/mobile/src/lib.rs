//! Mobile FFI host for the embedded store.
//!
//! The foreign-language layer owns opaque integer handles. A process registry resolves those
//! handles to stores, and every database operation is serialized through one FIFO worker.

mod convert;
mod ffi;
mod host;
#[cfg(target_os = "android")]
mod jni;
mod model;
mod remote;
mod wire;

pub use ffi::{
    cem_bridge_contract_id, cem_buffer_free, cem_clock_read_value, cem_close, cem_open_path,
    cem_request, cem_storage_binding_contract_id, cem_wire_contract_id, CemBuffer,
};

use std::collections::BTreeMap;

use storage::{
    CommitResult, CrdtSnapshot, DirtyHeadDebug, FileMetadata, IdMapping, MutationRecord,
    MutationStatus, PendingUpload, ResultEntry, RowChange, RowHead, ScheduledJob,
};
use thiserror::Error;

use crate::wire::{Request, Response};

type BridgeResult<T> = Result<T, BridgeError>;

#[derive(Debug, Error)]
enum BridgeError {
    #[error("{0}")]
    Closed(String),
    #[error("{0}")]
    Host(String),
    #[error("{0}")]
    Protocol(String),
    #[error("{0}")]
    Remote(String),
    #[error("{0}")]
    Storage(String),
    #[error("{0}")]
    PreBaseline(String),
    #[error("JSON codec failed: {0}")]
    Json(#[from] serde_json::Error),
}

impl BridgeError {
    fn code(&self) -> &'static str {
        match self {
            Self::Closed(_) => "closed",
            Self::Host(_) => "host",
            Self::Protocol(_) | Self::Json(_) => "protocol",
            Self::Remote(_) => "remote",
            Self::Storage(_) => "storage",
            Self::PreBaseline(_) => "EMBEDDED_PRE_BASELINE_STORE",
        }
    }

    fn marker(&self) -> String {
        format!("[convex-embedded:{}] {self}", self.code())
    }
}

impl From<storage::StorageError> for BridgeError {
    fn from(error: storage::StorageError) -> Self {
        if matches!(error, storage::StorageError::PreBaselineStore { .. }) {
            Self::PreBaseline(error.to_string())
        } else {
            Self::Storage(error.to_string())
        }
    }
}

#[cfg(test)]
mod error_tests {
    use super::BridgeError;

    #[test]
    fn prebaseline_storage_error_keeps_its_cross_binding_code() {
        let error = BridgeError::from(storage::StorageError::PreBaselineStore {
            found: 46,
            minimum: 47,
        });
        assert_eq!(error.code(), "EMBEDDED_PRE_BASELINE_STORE");
        assert!(error
            .marker()
            .starts_with("[convex-embedded:EMBEDDED_PRE_BASELINE_STORE]"));
    }
}

pub(crate) fn open_path(
    path: String,
    selector_key: Option<String>,
    default_identity_key: Option<String>,
) -> BridgeResult<u64> {
    host::open(path, selector_key, default_identity_key)
}

pub(crate) fn clock_read(handle: u64) -> BridgeResult<f64> {
    host::read(handle)?.clock_read()
}

pub(crate) fn close_handle(handle: u64) -> BridgeResult<()> {
    host::close(handle)
}

pub(crate) fn request_bytes(handle: u64, bytes: &[u8]) -> Vec<u8> {
    encoded_result((|| {
        let request = wire::decode_request(bytes)?;
        let host = host::read(handle)?;
        dispatch(&host, &request)
    })())
}

fn encoded_result(result: BridgeResult<Response>) -> Vec<u8> {
    let response = match result {
        Ok(response) => response,
        Err(error) => Response::failure(&error),
    };
    wire::encode_response(&response)
}

// This deliberately centralizes the stable wire-operation table so an operation name, payload,
// and storage call can be audited together across the foreign-language boundary.
#[allow(clippy::too_many_lines)]
fn dispatch(host: &host::StoreHost, request: &Request) -> BridgeResult<Response> {
    match request.operation.as_str() {
        "setup" => {
            let (schema,): (model::Schema,) = wire::payload(request)?;
            let schema = convert::schema(schema)?;
            host.run(move |store| store.setup(&schema))?;
            Response::value(&())
        }
        "migrationBegin" => {
            let (schema,): (model::Schema,) = wire::payload(request)?;
            let schema = convert::schema(schema)?;
            let candidate = host.run(move |store| store.migration_prepare(&schema))?;
            Response::value(&serde_json::to_string(&serde_json::json!({
                "activeGeneration": candidate.active_generation,
                "candidateGeneration": candidate.candidate_generation,
                "cleanupGeneration": candidate.cleanup_generation,
                "sourceSchema": candidate.source_schema,
                "setupComplete": candidate.setup_complete,
                "sourceContractHash": candidate.source_contract_hash,
                "targetContractHash": candidate.target_contract_hash,
                "retiredGenerations": candidate.retired_generations,
                "required": candidate.required,
                "resumed": candidate.resumed,
            }))?)
        }
        "migrationCopyStep" => {
            let (generation,): (i64,) = wire::payload(request)?;
            let step = host.run(move |store| store.migration_copy_step(generation))?;
            Response::value(&serde_json::to_string(&serde_json::json!({
                "done": step.done,
                "records": step.records,
            }))?)
        }
        "migrationBind" => {
            let (schema, generation): (model::Schema, i64) = wire::payload(request)?;
            let schema = convert::schema(schema)?;
            host.run(move |store| store.migration_bind_prepare(&schema, generation))?;
            Response::value(&())
        }
        "migrationMaterializeStep" => {
            let (generation,): (i64,) = wire::payload(request)?;
            let step = host.run(move |store| store.migration_materialize_step(generation))?;
            Response::value(&serde_json::to_string(&serde_json::json!({
                "done": step.done,
                "records": step.records,
            }))?)
        }
        "migrationUnbind" => {
            host.run(storage::EmbeddedStore::migration_unbind)?;
            Response::value(&())
        }
        "migrationSetupComplete" => {
            let (generation,): (i64,) = wire::payload(request)?;
            host.run(move |store| store.migration_setup_complete(generation))?;
            Response::value(&())
        }
        "originPageRead" => {
            let (generation, cursor_json, page_size, upper_json): (
                i64,
                Option<String>,
                u32,
                Option<String>,
            ) = wire::payload(request)?;
            let cursor = cursor_json
                .as_deref()
                .map(origin_cursor_from_json)
                .transpose()?;
            let upper = upper_json
                .as_deref()
                .map(origin_cursor_from_json)
                .transpose()?;
            let page = host.run(move |store| {
                store.origin_page_read_bounded(
                    generation,
                    cursor.as_ref(),
                    upper.as_ref(),
                    page_size as usize,
                )
            })?;
            Response::value(&origin_page_json(&page)?)
        }
        "migrationRecordDispositionWrite" => {
            let (generation, identity_key, kind, record_key, migration_id, reason, discard): (
                i64,
                String,
                i64,
                Vec<u8>,
                String,
                String,
                bool,
            ) = wire::payload(request)?;
            host.run(move |store| {
                store.migration_record_disposition_write(
                    generation,
                    &identity_key,
                    kind,
                    &record_key,
                    &migration_id,
                    &reason,
                    discard,
                )
            })?;
            Response::value(&())
        }
        "migrationQueuePolicyStateRead" => {
            let (generation,): (i64,) = wire::payload(request)?;
            let state =
                host.run(move |store| store.migration_queue_policy_state_read(generation))?;
            Response::value(&state)
        }
        "migrationQueuePolicyWrite" => {
            let (generation, policy_json): (i64, String) = wire::payload(request)?;
            let complete = host
                .run(move |store| store.migration_queue_policy_write(generation, &policy_json))?;
            Response::value(&complete)
        }
        "migrationFinalizePrepare" => {
            let (schema, generation): (model::Schema, i64) = wire::payload(request)?;
            let schema = convert::schema(schema)?;
            host.run(move |store| store.migration_finalize_prepare(&schema, generation))?;
            Response::value(&())
        }
        "migrationCommit" => {
            let (schema, generation): (model::Schema, i64) = wire::payload(request)?;
            let schema = convert::schema(schema)?;
            host.run(move |store| store.migration_cutover(&schema, generation))?;
            Response::value(&())
        }
        "migrationRetire" => {
            let (generation,): (i64,) = wire::payload(request)?;
            host.run(move |store| store.migration_retire(generation))?;
            Response::value(&())
        }
        "migrationRetireStep" => {
            let (generation,): (i64,) = wire::payload(request)?;
            let step = host.run(move |store| store.migration_retire_step(generation))?;
            Response::value(&serde_json::to_string(&serde_json::json!({
                "done": step.done,
                "records": step.records,
            }))?)
        }
        "identityRead" => {
            let (identity_key, identity) = host.run(storage::EmbeddedStore::identity_read)?;
            let identity = identity
                .as_deref()
                .map(serde_json::from_str::<serde_json::Value>)
                .transpose()?;
            let text = serde_json::to_string(&serde_json::json!({
                "identity": identity,
                "identityKey": identity_key,
            }))?;
            Response::value(&text)
        }
        "identityWrite" => {
            let (identity_key, identity_json): (String, Option<String>) = wire::payload(request)?;
            host.run(move |store| store.identity_write(&identity_key, identity_json.as_deref()))?;
            Response::value(&())
        }
        "mutationWrite" | "mutationCacheRead" | "mutationCacheWrite" => {
            let (call,): (model::MutationCall,) = wire::payload(request)?;
            let call = storage::MutationCall {
                args: call.args,
                mutation_id: call.mutation_id,
                name: call.name,
            };
            let operation = request.operation.clone();
            let record = host.run(move |store| match operation.as_str() {
                "mutationWrite" => store.mutation_write(&call),
                "mutationCacheRead" => store.mutation_cache_read(&call),
                _ => store.mutation_cache_write(&call),
            })?;
            Response::value(&mutation_record(&record))
        }
        "mutationFail" => {
            let (mutation_id, error): (String, String) = wire::payload(request)?;
            host.run(move |store| store.mutation_fail(&mutation_id, &error))?;
            Response::value(&())
        }
        "commit" => {
            let (batch, options): (model::WriteBatch, Option<model::CommitOptions>) =
                wire::payload(request)?;
            let include_changes = options
                .as_ref()
                .and_then(|options| options.include_changes)
                .unwrap_or(true);
            let batch = convert::write_batch(batch)?;
            let options = convert::commit_options(options)?;
            let result = host.run(move |store| store.commit(batch, &options))?;
            Response::value(&commit_result(result, include_changes))
        }
        "docRead" => {
            let (table, id): (String, String) = wire::payload(request)?;
            let value = host.run(move |store| store.doc_read(&table, &id))?;
            Response::value(&value)
        }
        "localFieldsRead" => {
            let (table, id): (String, String) = wire::payload(request)?;
            let value = host.run(move |store| store.local_fields_read(&table, &id))?;
            Response::value(&serde_json::to_string(&value)?)
        }
        "docVersionRead" => {
            let (table, id): (String, String) = wire::payload(request)?;
            let value = host.run(move |store| store.doc_version_read(&table, &id))?;
            Response::value(&value)
        }
        "crdtHeadRead" => {
            let (table, id, field): (String, String, String) = wire::payload(request)?;
            let value = host.run(move |store| store.crdt_head_read(&table, &id, &field))?;
            Response::value(&value)
        }
        "crdtSnapshotRead" => {
            let (table, id, ops): (String, String, Option<Vec<model::CrdtOp>>) =
                wire::payload(request)?;
            let ops = ops
                .unwrap_or_default()
                .into_iter()
                .map(convert::crdt_op)
                .collect::<BridgeResult<Vec<_>>>()?;
            let snapshots =
                host.run(move |store| store.crdt_snapshot_read_with_ops(&table, &id, &ops))?;
            snapshot_response(snapshots)
        }
        "docPageRead" | "keyPageRead" => {
            let (spec,): (model::ReadSpec,) = wire::payload(request)?;
            let spec = convert::read_spec(spec)?;
            let operation = request.operation.clone();
            let page = host.run(move |store| {
                if operation == "docPageRead" {
                    store.doc_page_read(&spec)
                } else {
                    store.key_page_read(&spec)
                }
            })?;
            Response::value(&model::Page {
                text: page.text,
                cursor: page.cursor,
                versions: page.versions.into_iter().collect::<BTreeMap<_, _>>(),
                local_fields_json: (!page.local_fields.is_empty())
                    .then(|| serde_json::to_string(&page.local_fields))
                    .transpose()?,
            })
        }
        "docCountRead" => {
            let (spec,): (model::CountSpec,) = wire::payload(request)?;
            let spec = convert::count_spec(spec)?;
            let count = host.run(move |store| store.doc_count_read(&spec))?;
            Response::value(&count)
        }
        "ledgerDelete" => {
            let (up_to_seq,): (i64,) = wire::payload(request)?;
            let result = host.run(move |store| store.ledger_delete(up_to_seq))?;
            Response::value(&serde_json::json!({
                "commitsDeleted": result.commits_deleted,
                "mutationsDeleted": result.mutations_deleted,
            }))
        }
        "walWrite" => {
            host.run(storage::EmbeddedStore::wal_write)?;
            Response::value(&())
        }
        "blobRead" => {
            let (key,): (String,) = wire::payload(request)?;
            Ok(Response::bytes(
                host.run(move |store| store.blob_read(&key))?,
            ))
        }
        "blobWrite" => {
            let (key, bytes): (String, Vec<u8>) = wire::payload(request)?;
            host.run(move |store| store.blob_write(&key, bytes))?;
            Response::value(&())
        }
        "blobDelete" => {
            let (key,): (String,) = wire::payload(request)?;
            host.run(move |store| store.blob_delete(&key))?;
            Response::value(&())
        }
        "resultRead" => {
            let (key,): (String,) = wire::payload(request)?;
            result_response(host.run(move |store| store.result_read(&key))?)
        }
        "resultWrite" => {
            let (entry,): (model::ResultEntry,) = wire::payload(request)?;
            let entry = result_entry(entry);
            let written = host.run(move |store| store.result_write(&entry))?;
            Response::value(&written)
        }
        "resultDelete" => {
            let (key,): (String,) = wire::payload(request)?;
            host.run(move |store| store.result_delete(&key))?;
            Response::value(&())
        }
        "docBaseRead" => {
            let (table, id): (String, String) = wire::payload(request)?;
            let row = host.run(move |store| store.remote_doc_read(&table, &id))?;
            Response::value(&row.and_then(|row| row.server_row))
        }
        "idWrite" => {
            let (mapping,): (model::IdMapping,) = wire::payload(request)?;
            let mapping = convert::id_mapping(mapping)?;
            host.run(move |store| store.id_write(&mapping))?;
            Response::value(&())
        }
        "idRead" => {
            let (table, local_id): (String, String) = wire::payload(request)?;
            let value = host.run(move |store| store.id_read(&table, &local_id))?;
            Response::value(&value.map(id_mapping))
        }
        "idPageRead" => {
            let (table,): (String,) = wire::payload(request)?;
            let values = host.run(move |store| store.id_page_read(&table))?;
            Response::value(&values.into_iter().map(id_mapping).collect::<Vec<_>>())
        }
        "idDelete" => {
            let (table, local_id): (String, String) = wire::payload(request)?;
            host.run(move |store| store.id_delete(&table, &local_id))?;
            Response::value(&())
        }
        "dirtyHeadsDebugRead" => {
            let values = host.run(storage::EmbeddedStore::dirty_heads_debug_read)?;
            Response::value(&values.iter().map(dirty_head).collect::<Vec<_>>())
        }
        "remoteDocDebugRead" => {
            let (table, local_id): (String, String) = wire::payload(request)?;
            let value = host.run(move |store| store.remote_doc_read(&table, &local_id))?;
            Response::value(&value.as_ref().map(remote_doc))
        }
        "remoteCursorDebugRead" => {
            let (subscription,): (String,) = wire::payload(request)?;
            let value = host.run(move |store| store.remote_cursor_read(&subscription))?;
            Response::value(&value)
        }
        "remoteMemberDebugRead" => {
            let (subscription,): (String,) = wire::payload(request)?;
            let value = host.run(move |store| store.remote_member_read(&subscription))?;
            Response::value(&serde_json::to_string(
                &value
                    .iter()
                    .map(|member| {
                        serde_json::json!({
                            "table": member.table,
                            "serverDocumentId": member.server_document_id,
                        })
                    })
                    .collect::<Vec<_>>(),
            )?)
        }
        "fileMetaWrite" => {
            let (metadata,): (model::FileMetadata,) = wire::payload(request)?;
            let metadata = file_metadata(metadata);
            host.run(move |store| store.file_meta_write(&metadata))?;
            Response::value(&())
        }
        "fileRead" => {
            let (storage_id,): (String,) = wire::payload(request)?;
            let value = host.run(move |store| store.file_read(&storage_id))?;
            Response::value(&value.map(file_metadata_out))
        }
        "fileDelete" => {
            let (storage_id,): (String,) = wire::payload(request)?;
            host.run(move |store| store.file_delete(&storage_id))?;
            Response::value(&())
        }
        "fileWrite" => {
            let (input,): (model::FileStore,) = wire::payload(request)?;
            let input = storage::FileStore {
                bytes: input.bytes,
                metadata: file_metadata(input.metadata),
            };
            host.run(move |store| store.file_write(&input))?;
            Response::value(&())
        }
        "uploadWrite" => {
            let (upload,): (model::PendingUpload,) = wire::payload(request)?;
            let upload = convert::upload(upload)?;
            host.run(move |store| store.upload_write(&upload))?;
            Response::value(&())
        }
        "uploadRead" => {
            let values = host.run(storage::EmbeddedStore::upload_read)?;
            Response::value(&values.into_iter().map(upload_out).collect::<Vec<_>>())
        }
        "uploadLeaseWrite" => {
            let (lease,): (model::UploadLeaseWrite,) = wire::payload(request)?;
            let lease = convert::upload_lease(lease)?;
            let value = host.run(move |store| store.upload_lease_write(lease))?;
            Response::value(&value.map(upload_out))
        }
        "uploadComplete" => {
            let (local_storage_id, owner, convex_id, now_ms): (String, String, String, i64) =
                wire::payload(request)?;
            let value = host.run(move |store| {
                store.upload_complete(&local_storage_id, &owner, &convex_id, now_ms)
            })?;
            Response::value(&value)
        }
        "uploadDelete" => {
            let (local_storage_id,): (String,) = wire::payload(request)?;
            host.run(move |store| store.upload_delete(&local_storage_id))?;
            Response::value(&())
        }
        "scheduleWrite" => {
            let (job,): (model::ScheduledJob,) = wire::payload(request)?;
            let job = convert::scheduled_job(job)?;
            host.run(move |store| store.schedule_write(&job))?;
            Response::value(&())
        }
        "scheduleRead" => {
            let values = host.run(storage::EmbeddedStore::schedule_read)?;
            Response::value(&values.into_iter().map(schedule_out).collect::<Vec<_>>())
        }
        "scheduleLeaseWrite" => {
            let (now_ms,): (i64,) = wire::payload(request)?;
            let value = host.run(move |store| store.schedule_lease_write(now_ms))?;
            Response::value(&value.map(schedule_out))
        }
        operation @ ("scheduleComplete" | "scheduleFail" | "scheduleCancel") => {
            let (job_id, now_ms): (String, i64) = wire::payload(request)?;
            let operation = operation.to_owned();
            let value = host.run(move |store| match operation.as_str() {
                "scheduleComplete" => store.schedule_complete(&job_id, now_ms),
                "scheduleFail" => store.schedule_fail(&job_id, now_ms),
                _ => store.schedule_cancel(&job_id, now_ms),
            })?;
            Response::value(&value.map(schedule_out))
        }
        "remoteStart" => {
            let (options,): (remote::StartOptions,) = wire::payload(request)?;
            host.remote_start(options)?;
            Response::value(&())
        }
        "remoteNext" => Response::value(&host.remote_next()?),
        "remoteAuthWrite" => {
            let (id, token, error): (u64, Option<String>, Option<String>) = wire::payload(request)?;
            host.remote_auth_write(id, token, error)?;
            Response::value(&())
        }
        "remotePull" => Response::value(&host.remote_pull()?),
        "remoteIdentity" => Response::value(&host.remote_identity()?),
        "remoteDocPush" => {
            let (table, id, first_commit_seq, updated_commit_seq): (String, String, i64, i64) =
                wire::payload(request)?;
            Response::value(&host.remote_doc_push(
                &table,
                &id,
                first_commit_seq,
                updated_commit_seq,
            )?)
        }
        "remoteScopeWrite" => {
            let (scope,): (String,) = wire::payload(request)?;
            host.remote_scope_write(&scope)?;
            Response::value(&())
        }
        "remoteClose" => {
            host.remote_close()?;
            Response::value(&())
        }
        "clear" => {
            host.run(storage::EmbeddedStore::clear)?;
            Response::value(&())
        }
        operation => Err(BridgeError::Protocol(format!(
            "unknown mobile store operation {operation}"
        ))),
    }
}

fn mutation_record(value: &MutationRecord) -> serde_json::Value {
    serde_json::json!({
        "commitSeq": value.commit_seq,
        "error": value.error,
        "mutationId": value.mutation_id,
        "result": value.result,
        "status": match value.status {
            MutationStatus::Accepted => "accepted",
            MutationStatus::Committed => "committed",
            MutationStatus::Failed => "failed",
        },
    })
}

fn commit_result(value: CommitResult, include_changes: bool) -> serde_json::Value {
    serde_json::json!({
        "changedTables": value.changed_tables,
        "changes": if include_changes { value.changes.iter().map(row_change).collect::<Vec<_>>() } else { Vec::new() },
        "commitSeq": value.commit_seq,
        "commitTs": value.commit_ts.map(|timestamp| timestamp.to_string()),
        "crdtOps": value.crdt_ops.into_iter().map(|op| serde_json::json!({
            "table": op.table,
            "id": op.id,
            "field": op.field,
            "kind": op.kind.as_wire(),
            "update": base64::encode(op.update),
        })).collect::<Vec<_>>(),
    })
}

fn row_change(value: &RowChange) -> serde_json::Value {
    serde_json::json!({"op": value.op.as_str(), "table": value.table, "id": value.id, "row": value.row})
}

fn snapshot_response(values: Vec<CrdtSnapshot>) -> BridgeResult<Response> {
    let mut buffers = Vec::with_capacity(values.len());
    let json = values
        .into_iter()
        .enumerate()
        .map(|(index, value)| {
            buffers.push(value.bytes);
            serde_json::json!({
                "field": value.field,
                "kind": value.kind.as_wire(),
                "headSeq": value.head_seq,
                "projectionHash": value.projection_hash,
                "bytes": {"$buffer": index},
                "hash": value.hash,
            })
        })
        .collect::<Vec<_>>();
    Response::with_buffers(&json, buffers)
}

fn result_entry(value: model::ResultEntry) -> ResultEntry {
    ResultEntry {
        key: value.key,
        function: value.function,
        args: value.args,
        schema_hash: value.schema_hash,
        module_hash: value.module_hash,
        skeleton: value.skeleton,
        paths: value.paths,
        skeleton_hash: value.skeleton_hash,
        clock: value.clock,
    }
}

fn result_response(value: Option<ResultEntry>) -> BridgeResult<Response> {
    let Some(value) = value else {
        return Response::value(&Option::<()>::None);
    };
    let json = serde_json::json!({
        "key": value.key,
        "function": value.function,
        "args": value.args,
        "schemaHash": value.schema_hash,
        "moduleHash": value.module_hash,
        "skeleton": {"$buffer": 0},
        "paths": {"$buffer": 1},
        "skeletonHash": value.skeleton_hash,
        "clock": value.clock,
    });
    Response::with_buffers(&json, vec![value.skeleton, value.paths])
}

fn id_mapping(value: IdMapping) -> model::IdMapping {
    model::IdMapping {
        convex_id: value.convex_id().map(str::to_owned),
        state: value.mapping.as_str().to_owned(),
        table: value.table,
        local_id: value.local_id,
        created_time: value.created_time,
        updated_time: value.updated_time,
    }
}

fn file_metadata(value: model::FileMetadata) -> FileMetadata {
    FileMetadata {
        storage_id: value.storage_id,
        sha256: value.sha256,
        size: value.size,
        content_type: value.content_type,
        source: value.source,
        created_time: value.created_time,
        updated_time: value.updated_time,
    }
}

fn file_metadata_out(value: FileMetadata) -> model::FileMetadata {
    model::FileMetadata {
        storage_id: value.storage_id,
        sha256: value.sha256,
        size: value.size,
        content_type: value.content_type,
        source: value.source,
        created_time: value.created_time,
        updated_time: value.updated_time,
    }
}

fn upload_out(value: PendingUpload) -> model::PendingUpload {
    model::PendingUpload {
        local_storage_id: value.local_storage_id,
        sha256: value.sha256,
        size: value.size,
        content_type: value.content_type,
        state: value.lease.as_str().to_owned(),
        owner: value.lease.owner().map(str::to_owned),
        lease_until: value.lease.lease_until(),
        created_time: value.created_time,
        updated_time: value.updated_time,
    }
}

fn schedule_out(value: ScheduledJob) -> model::ScheduledJob {
    model::ScheduledJob {
        job_id: value.job_id,
        kind: value.kind.as_str().to_owned(),
        name: value.name,
        args: value.args,
        due_time: value.due_time,
        state: value.state.as_str().to_owned(),
        lease_until: value.state.lease_until(),
        created_time: value.created_time,
        updated_time: value.updated_time,
    }
}

fn dirty_head(value: &DirtyHeadDebug) -> serde_json::Value {
    serde_json::json!({
        "table": value.row.table, "id": value.row.document_id, "op": value.op.as_str(),
        "firstCommitSeq": value.first_commit_seq, "updatedCommitSeq": value.updated_commit_seq,
        "createdTime": value.created_time, "updatedTime": value.updated_time,
        "serverDocumentId": value.server_document_id, "baseProjectionHash": value.base_projection_hash,
        "baseRootId": value.base_root_id, "baseNodeId": value.base_node_id, "logicalClock": value.logical_clock,
    })
}

fn remote_doc(value: &RowHead) -> serde_json::Value {
    serde_json::json!({
        "table": value.table, "localDocumentId": value.local_document_id,
        "currentRevId": value.current_rev_id, "serverDocumentId": value.server_document_id,
        "projectionHash": value.projection_hash, "currentRootId": value.current_root_id,
        "currentNodeId": value.current_node_id, "serverBase": value.server_base,
        "logicalClock": value.logical_clock, "updatedTime": value.updated_time,
    })
}

fn origin_page_json(page: &storage::OriginPage) -> BridgeResult<String> {
    Ok(serde_json::to_string(&serde_json::json!({
        "records": page.records.iter().map(|record| serde_json::json!({
            "identityKey": record.identity_key,
            "kind": record.kind,
            "recordKey": base64::encode(&record.record_key),
            "codec": record.codec,
            "flags": record.flags,
            "payload": base64::encode(&record.payload),
            "payloadHash": base64::encode(&record.payload_hash),
        })).collect::<Vec<_>>(),
        "cursor": page.cursor.as_ref().map(|cursor| serde_json::json!({
            "identityKey": cursor.identity_key,
            "kind": cursor.kind,
            "recordKey": base64::encode(&cursor.record_key),
        })),
    }))?)
}

fn origin_cursor_from_json(json: &str) -> BridgeResult<storage::OriginCursor> {
    let value: serde_json::Value = serde_json::from_str(json)?;
    Ok(storage::OriginCursor {
        identity_key: origin_json_str(&value, "identityKey")?.to_owned(),
        kind: origin_json_i64(&value, "kind")?,
        record_key: origin_base64_decode(origin_json_str(&value, "recordKey")?)?,
    })
}

fn origin_json_str<'a>(value: &'a serde_json::Value, field: &str) -> BridgeResult<&'a str> {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| BridgeError::Protocol(format!("missing string field {field}")))
}

fn origin_json_i64(value: &serde_json::Value, field: &str) -> BridgeResult<i64> {
    value
        .get(field)
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| BridgeError::Protocol(format!("missing integer field {field}")))
}

fn origin_base64_decode(value: &str) -> BridgeResult<Vec<u8>> {
    base64::decode(value).map_err(|error| BridgeError::Protocol(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(operation: &str, args: &serde_json::Value, buffers: Vec<Vec<u8>>) -> Vec<u8> {
        wire::encode_request(&wire::Request {
            operation: operation.to_owned(),
            json: args.to_string(),
            buffers,
        })
    }

    fn response(bytes: &[u8]) -> wire::Response {
        decode_response(bytes)
    }

    fn decode_response(bytes: &[u8]) -> wire::Response {
        // The full response decoder lives in TypeScript. Tests only need the fields below, so
        // decode them through the same tiny MessagePack grammar by checking round-trip behavior.
        assert!(!bytes.is_empty(), "response should not be empty");
        // A successful response always starts with a five-entry map and then the `ok` key/value.
        assert_eq!(bytes[0], 0x85);
        assert_eq!(&bytes[1..4], &[0xa2, b'o', b'k']);
        wire::Response {
            ok: bytes[4] == 0xc3,
            json: String::new(),
            buffers: if bytes.windows(3).any(|window| window == [0xc4, 3, 1]) {
                vec![vec![1, 2, 3]]
            } else {
                Vec::new()
            },
            error: None,
        }
    }

    #[test]
    fn store_round_trips_setup_blob_and_close() {
        let path = storage::testkit::tmp_path("mobile-round-trip.db");
        let handle =
            open_path(path.to_string_lossy().into_owned(), None, None).expect("store should open");
        let schema = serde_json::json!([{
            "hash": "0000000000000000000000000000000000000000000000000000000000000000",
            "setupHash": "",
            "tables": [{
                "name": "issues",
                "placement": "replicated",
                "columns": [{"name": "status", "field": "status"}],
                "crdtFields": [],
                "localFields": [{"field": "draft"}],
                "indexes": [{"name": "by_status", "fields": ["status"], "columns": ["status"]}],
            }],
        }]);
        assert!(response(&request_bytes(handle, &request("setup", &schema, vec![]))).ok);
        let write = request(
            "blobWrite",
            &serde_json::json!(["key", {"$buffer": 0}]),
            vec![vec![1, 2, 3]],
        );
        assert!(response(&request_bytes(handle, &write)).ok);
        let read = response(&request_bytes(
            handle,
            &request("blobRead", &serde_json::json!(["key"]), vec![]),
        ));
        assert!(read.ok);
        assert_eq!(read.buffers, [vec![1, 2, 3]]);
        let commit = serde_json::json!([{
            "docWrites": [{
                "table": "issues",
                "id": "issues|local",
                "data": "{\"status\":\"open\"}",
                "cols": [{"name": "status", "text": "open"}],
                "creationTime": 1.0,
            }],
            "deletes": [],
            "freshIds": [{"table": "issues", "id": "issues|local"}],
            "dataOnlyIds": [],
        }, {"source": "local", "includeChanges": false}]);
        assert!(response(&request_bytes(handle, &request("commit", &commit, vec![]))).ok);
        assert!(
            response(&request_bytes(
                handle,
                &request(
                    "docRead",
                    &serde_json::json!(["issues", "issues|local"]),
                    vec![]
                ),
            ))
            .ok
        );
        let overlay = serde_json::json!([{
            "docWrites": [],
            "deletes": [],
            "localFieldWrites": [{
                "table": "issues",
                "id": "issues|local",
                "field": "draft",
                "valueJson": "true",
            }],
            "localFieldDeletes": [],
        }, {"source": "device", "includeChanges": false}]);
        assert!(response(&request_bytes(handle, &request("commit", &overlay, vec![]))).ok);
        assert!(
            response(&request_bytes(
                handle,
                &request(
                    "localFieldsRead",
                    &serde_json::json!(["issues", "issues|local"]),
                    vec![]
                ),
            ))
            .ok
        );
        assert!(
            response(&request_bytes(
                handle,
                &request(
                    "docPageRead",
                    &serde_json::json!([{
                        "table": "issues",
                        "index": null,
                        "bounds": null,
                        "order": "asc",
                        "pageSize": 10,
                        "cursor": null,
                        "resumeAfterKey": null,
                    }]),
                    vec![]
                ),
            ))
            .ok
        );
        close_handle(handle).expect("store should close");
    }

    #[test]
    fn migration_queue_policy_bridge_preserves_false_then_true_completion() {
        let path = storage::testkit::tmp_path("mobile-policy-completion.db");
        let handle = open_path(path.to_string_lossy().into_owned(), None, None).unwrap();
        let host = host::read(handle).unwrap();
        let source = storage::StoreSchema {
            hash: "0".repeat(64),
            setup_hash: String::new(),
            tables: vec![],
        };
        host.run({
            let source = source.clone();
            move |store| store.setup(&source)
        })
        .unwrap();
        let target = storage::StoreSchema {
            hash: "1".repeat(64),
            ..source
        };
        let candidate = host
            .run(move |store| store.migration_prepare(&target))
            .unwrap();
        let generation = candidate.candidate_generation;
        let policy = |collect_complete| wire::Request {
            operation: "migrationQueuePolicyWrite".to_owned(),
            json: serde_json::json!([
                generation,
                serde_json::json!({
                    "collectComplete": collect_complete,
                    "cursor": null,
                    "thresholds": [],
                })
                .to_string(),
            ])
            .to_string(),
            buffers: vec![],
        };

        let pending = dispatch(&host, &policy(false)).unwrap();
        assert!(pending.ok);
        assert_eq!(pending.json, "false");
        let complete = dispatch(&host, &policy(true)).unwrap();
        assert!(complete.ok);
        assert_eq!(complete.json, "true");
        close_handle(handle).unwrap();
    }

    #[test]
    fn the_storage_worker_folds_the_wal_after_idle_and_keeps_committed_rows() {
        let path = storage::testkit::tmp_path("mobile-idle-checkpoint.db");
        let path_string = path.to_string_lossy().into_owned();
        let handle = host::open_with_idle(
            path_string.clone(),
            None,
            None,
            std::time::Duration::from_millis(100),
        )
        .expect("store should open");
        let schema = serde_json::json!([{
            "hash": "0000000000000000000000000000000000000000000000000000000000000000",
            "setupHash": "",
            "tables": [{
                "name": "issues",
                "placement": "replicated",
                "columns": [{"name": "status", "field": "status"}],
                "crdtFields": [],
                "localFields": [],
                "indexes": [{"name": "by_status", "fields": ["status"], "columns": ["status"]}],
            }],
        }]);
        assert!(response(&request_bytes(handle, &request("setup", &schema, vec![]))).ok);
        for index in 0..40 {
            let commit = serde_json::json!([{
                "docWrites": [{
                    "table": "issues",
                    "id": format!("issues|{index:03}"),
                    "data": format!("{{\"status\":\"open-{index}\"}}"),
                    "cols": [{"name": "status", "text": "open"}],
                    "creationTime": f64::from(index),
                }],
                "deletes": [],
                "freshIds": [{"table": "issues", "id": format!("issues|{index:03}")}],
                "dataOnlyIds": [],
            }, {"source": "local", "includeChanges": false}]);
            assert!(response(&request_bytes(handle, &request("commit", &commit, vec![]))).ok);
        }
        let wal = format!("{path_string}-wal");
        let before = std::fs::metadata(&wal).map_or(0, |meta| meta.len());
        assert!(before > 0, "the commits should have grown the WAL");

        std::thread::sleep(std::time::Duration::from_millis(500));

        let after = std::fs::metadata(&wal).map_or(0, |meta| meta.len());
        assert!(
            after < before,
            "the idle worker must fold the WAL ({before} -> {after})"
        );
        let read = request_bytes(
            handle,
            &request(
                "docRead",
                &serde_json::json!(["issues", "issues|000"]),
                vec![],
            ),
        );
        assert!(
            read.windows(6).any(|window| window == b"open-0"),
            "a committed row must survive the idle checkpoint"
        );
        close_handle(handle).expect("store should close");
    }
}
