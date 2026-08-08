#![allow(unreachable_pub)]

use std::collections::BTreeMap;

use convex::Value;
use storage::{
    ArgRef, AuthoritativeChange, BaseVersion, CrdtCheckpoint, CrdtEffect, CrdtFieldKind,
    CrdtReadWitness, InsertRef, Order, PushEnvelope, PushOutcome, PushResponse, PushVerdict,
    RangeVersion, ReadBound, ReadEquality, RejectionCode, RevisionCandidate, RevisionCheckpoint,
    RevisionCheckpointOperation, RevisionContent, RuntimeWireIdentity, ScheduleRef, SettledInsert,
    SettledSchedule, SettledUpload, UploadRef,
};

use crate::{codec, ConvexArgs, RemoteError, RemoteResult};

pub const BLOB_CHUNK_BYTES: usize = 196_608;

pub fn checkpoint_args(
    client_id: &str,
    runtime: &RuntimeWireIdentity,
    request: &storage::CrdtCheckpointRequest,
    checkpoint: &CrdtCheckpoint,
) -> ConvexArgs {
    BTreeMap::from([(
        "request".to_owned(),
        Value::Object(BTreeMap::from([
            ("kind".to_owned(), Value::String("checkpoint".to_owned())),
            ("clientId".to_owned(), Value::String(client_id.to_owned())),
            ("runtime".to_owned(), encode_runtime(runtime)),
            (
                "checkpointId".to_owned(),
                Value::String(request.checkpoint_id.clone()),
            ),
            (
                "responseToken".to_owned(),
                Value::String(request.response_token.clone()),
            ),
            (
                "throughSeq".to_owned(),
                Value::Float64(checkpoint.through_seq as f64),
            ),
            (
                "projectionHash".to_owned(),
                Value::String(request.projection_hash.clone()),
            ),
            (
                "content".to_owned(),
                encode_opaque(&checkpoint.bytes, &checkpoint.hash),
            ),
        ])),
    )])
}

pub fn blob_args(
    client_id: &str,
    runtime: &RuntimeWireIdentity,
    bytes: &[u8],
    hash: &str,
    ordinal: usize,
) -> ConvexArgs {
    let chunks = bytes.len().div_ceil(BLOB_CHUNK_BYTES);
    let start = ordinal * BLOB_CHUNK_BYTES;
    let chunk = &bytes[start..bytes.len().min(start + BLOB_CHUNK_BYTES)];
    BTreeMap::from([(
        "request".to_owned(),
        Value::Object(BTreeMap::from([
            ("kind".to_owned(), Value::String("blob".to_owned())),
            ("clientId".to_owned(), Value::String(client_id.to_owned())),
            ("runtime".to_owned(), encode_runtime(runtime)),
            ("hash".to_owned(), Value::String(hash.to_owned())),
            ("bytes".to_owned(), Value::Float64(bytes.len() as f64)),
            ("chunks".to_owned(), Value::Float64(chunks as f64)),
            ("ordinal".to_owned(), Value::Float64(ordinal as f64)),
            ("chunk".to_owned(), Value::Bytes(chunk.to_vec())),
            ("chunkHash".to_owned(), Value::String(sha256_hex(chunk))),
        ])),
    )])
}

#[allow(clippy::too_many_lines)]
pub fn mutation_args(
    envelope: &PushEnvelope,
    client_id: &str,
    acknowledge_replay_id: Option<&str>,
) -> RemoteResult<ConvexArgs> {
    let args = json_to_convex(envelope.args.clone())?;
    if !matches!(args, Value::Object(_)) {
        return Err(RemoteError::Protocol(
            "Embedded mutation arguments must be an object".to_owned(),
        ));
    }
    let mut request = BTreeMap::from([
        ("kind".to_owned(), Value::String("mutation".to_owned())),
        ("clientId".to_owned(), Value::String(client_id.to_owned())),
        (
            "functionName".to_owned(),
            Value::String(envelope.function.clone()),
        ),
        ("args".to_owned(), args),
        (
            "mutationId".to_owned(),
            Value::String(envelope.mutation_id.clone()),
        ),
        (
            "replayId".to_owned(),
            Value::String(envelope.replay_id.clone()),
        ),
        (
            "logicalFingerprint".to_owned(),
            Value::String(envelope.logical_fingerprint.clone()),
        ),
        ("runtime".to_owned(), encode_runtime(&envelope.runtime)),
        (
            "resultHash".to_owned(),
            Value::String(envelope.result_hash.clone()),
        ),
        (
            "argRefs".to_owned(),
            Value::Array(envelope.arg_refs.iter().map(encode_arg_ref).collect()),
        ),
        (
            "inserts".to_owned(),
            Value::Array(envelope.inserts.iter().map(encode_insert_ref).collect()),
        ),
        (
            "reads".to_owned(),
            Value::Array(
                envelope
                    .read_set
                    .iter()
                    .map(encode_read_witness)
                    .collect::<RemoteResult<Vec<_>>>()?,
            ),
        ),
        (
            "mutationTime".to_owned(),
            Value::Float64(envelope.mutation_time_hlc),
        ),
        (
            "randomSeed".to_owned(),
            Value::String(envelope.rng_seed.clone()),
        ),
        (
            "schedules".to_owned(),
            Value::Array(envelope.schedules.iter().map(encode_schedule_ref).collect()),
        ),
        (
            "uploads".to_owned(),
            Value::Array(envelope.uploads.iter().map(encode_upload_ref).collect()),
        ),
        (
            "crdt".to_owned(),
            Value::Array(
                envelope
                    .crdt
                    .iter()
                    .map(encode_crdt_effect)
                    .collect::<RemoteResult<Vec<_>>>()?,
            ),
        ),
        (
            "revisionCheckpoints".to_owned(),
            Value::Array(
                envelope
                    .revision_checkpoints
                    .iter()
                    .map(encode_revision_checkpoint)
                    .collect(),
            ),
        ),
        (
            "afterImages".to_owned(),
            Value::Array(
                envelope
                    .after_images
                    .iter()
                    .map(encode_revision_candidate)
                    .collect::<RemoteResult<Vec<_>>>()?,
            ),
        ),
    ]);
    if let Some(replay_id) = acknowledge_replay_id {
        request.insert(
            "acknowledgeReplayId".to_owned(),
            Value::String(replay_id.to_owned()),
        );
    }
    Ok(BTreeMap::from([(
        "request".to_owned(),
        Value::Object(request),
    )]))
}

fn encode_revision_candidate(candidate: &RevisionCandidate) -> RemoteResult<Value> {
    let mut fields = BTreeMap::from([
        ("table".to_owned(), Value::String(candidate.table.clone())),
        ("rowId".to_owned(), Value::String(candidate.row_id.clone())),
    ]);
    match &candidate.content {
        RevisionContent::Value(value) => {
            fields.insert("content".to_owned(), Value::String("value".to_owned()));
            fields.insert("value".to_owned(), json_to_convex(value.clone())?);
        }
        RevisionContent::Deleted => {
            fields.insert("content".to_owned(), Value::String("deleted".to_owned()));
        }
    }
    Ok(Value::Object(fields))
}

fn encode_revision_checkpoint(checkpoint: &RevisionCheckpoint) -> Value {
    Value::Object(BTreeMap::from([
        (
            "ordinal".to_owned(),
            Value::Float64(checkpoint.ordinal as f64),
        ),
        (
            "operation".to_owned(),
            Value::String(
                match checkpoint.operation {
                    RevisionCheckpointOperation::Create => "create",
                    RevisionCheckpointOperation::Retain => "retain",
                }
                .to_owned(),
            ),
        ),
        ("table".to_owned(), Value::String(checkpoint.table.clone())),
        (
            "snapshots".to_owned(),
            Value::Array(
                checkpoint
                    .snapshots
                    .iter()
                    .map(|snapshot| {
                        Value::Object(BTreeMap::from([
                            ("field".to_owned(), Value::String(snapshot.field.clone())),
                            (
                                "kind".to_owned(),
                                Value::String(
                                    match snapshot.kind {
                                        CrdtFieldKind::Text => "text",
                                        CrdtFieldKind::Count => "count",
                                        CrdtFieldKind::Set => "set",
                                    }
                                    .to_owned(),
                                ),
                            ),
                            (
                                "headSeq".to_owned(),
                                Value::Float64(snapshot.head_seq as f64),
                            ),
                            (
                                "projectionHash".to_owned(),
                                Value::String(snapshot.projection_hash.clone()),
                            ),
                            ("bytes".to_owned(), Value::Bytes(snapshot.bytes.clone())),
                            ("hash".to_owned(), Value::String(snapshot.hash.clone())),
                        ]))
                    })
                    .collect(),
            ),
        ),
    ]))
}

fn encode_runtime(runtime: &RuntimeWireIdentity) -> Value {
    Value::Object(BTreeMap::from([
        (
            "schemaHash".to_owned(),
            Value::String(runtime.schema_hash.clone()),
        ),
        (
            "moduleGraphHash".to_owned(),
            Value::String(runtime.module_graph_hash.clone()),
        ),
        (
            "protocolVersion".to_owned(),
            Value::Float64(runtime.protocol_version as f64),
        ),
    ]))
}

fn encode_insert_ref(insert: &InsertRef) -> Value {
    Value::Object(BTreeMap::from([
        (
            "mutationId".to_owned(),
            Value::String(insert.mutation_id.clone()),
        ),
        ("ordinal".to_owned(), Value::Float64(insert.ordinal as f64)),
        ("table".to_owned(), Value::String(insert.table.clone())),
    ]))
}

fn encode_schedule_ref(reference: &ScheduleRef) -> Value {
    Value::Object(BTreeMap::from([
        (
            "mutationId".to_owned(),
            Value::String(reference.mutation_id.clone()),
        ),
        (
            "ordinal".to_owned(),
            Value::Float64(reference.ordinal as f64),
        ),
    ]))
}

fn encode_upload_ref(reference: &UploadRef) -> Value {
    Value::Object(BTreeMap::from([
        (
            "mutationId".to_owned(),
            Value::String(reference.mutation_id.clone()),
        ),
        (
            "ordinal".to_owned(),
            Value::Float64(reference.ordinal as f64),
        ),
    ]))
}

fn encode_arg_ref(reference: &ArgRef) -> Value {
    match reference {
        ArgRef::Insert { path, insert } => Value::Object(BTreeMap::from([
            ("path".to_owned(), Value::String(path.clone())),
            ("insert".to_owned(), encode_insert_ref(insert)),
        ])),
        ArgRef::Schedule { path, schedule } => Value::Object(BTreeMap::from([
            ("path".to_owned(), Value::String(path.clone())),
            ("schedule".to_owned(), encode_schedule_ref(schedule)),
        ])),
    }
}

fn encode_read_witness(witness: &BaseVersion) -> RemoteResult<Value> {
    let fields = match witness {
        BaseVersion::Point {
            table,
            id,
            version: _,
            content_hash,
            crdt,
        } => BTreeMap::from([
            ("kind".to_owned(), Value::String("point".to_owned())),
            ("table".to_owned(), Value::String(table.clone())),
            ("rowId".to_owned(), Value::String(id.clone())),
            ("plainHash".to_owned(), Value::String(content_hash.clone())),
            (
                "crdt".to_owned(),
                Value::Array(crdt.iter().map(encode_crdt_read_witness).collect()),
            ),
        ]),
        BaseVersion::Range(range) => {
            let mut fields = BTreeMap::from([
                ("kind".to_owned(), Value::String("range".to_owned())),
                ("table".to_owned(), Value::String(range.table.clone())),
                ("index".to_owned(), Value::String(range.index.clone())),
                (
                    "equality".to_owned(),
                    Value::Array(
                        range
                            .equality
                            .iter()
                            .map(encode_read_equality)
                            .collect::<RemoteResult<Vec<_>>>()?,
                    ),
                ),
                (
                    "order".to_owned(),
                    Value::String(
                        match range.order {
                            Order::Asc => "asc",
                            Order::Desc => "desc",
                        }
                        .to_owned(),
                    ),
                ),
                (
                    "membersHash".to_owned(),
                    Value::String(range.members_hash.clone()),
                ),
            ]);
            if let Some(lower) = &range.lower {
                fields.insert("lower".to_owned(), encode_bound(lower)?);
            }
            if let Some(upper) = &range.upper {
                fields.insert("upper".to_owned(), encode_bound(upper)?);
            }
            if let Some(limit) = range.limit {
                fields.insert("limit".to_owned(), Value::Float64(limit as f64));
            }
            fields
        }
    };
    Ok(Value::Object(fields))
}

fn encode_crdt_read_witness(witness: &CrdtReadWitness) -> Value {
    Value::Object(BTreeMap::from([
        ("field".to_owned(), Value::String(witness.field.clone())),
        ("epoch".to_owned(), Value::Float64(witness.epoch as f64)),
        (
            "headSeq".to_owned(),
            Value::Float64(witness.head_seq as f64),
        ),
        (
            "projectionHash".to_owned(),
            Value::String(witness.projection_hash.clone()),
        ),
    ]))
}

fn encode_read_equality(equality: &ReadEquality) -> RemoteResult<Value> {
    let mut fields = BTreeMap::from([
        ("field".to_owned(), Value::String(equality.field.clone())),
        ("value".to_owned(), json_to_convex(equality.value.clone())?),
    ]);
    if equality.commit_ts {
        fields.insert("commitTs".to_owned(), Value::Boolean(true));
    }
    Ok(Value::Object(fields))
}

fn encode_bound(bound: &ReadBound) -> RemoteResult<Value> {
    let mut fields = BTreeMap::from([
        ("value".to_owned(), json_to_convex(bound.value.clone())?),
        ("field".to_owned(), Value::String(bound.field.clone())),
        ("inclusive".to_owned(), Value::Boolean(bound.inclusive)),
    ]);
    if bound.commit_ts {
        fields.insert("commitTs".to_owned(), Value::Boolean(true));
    }
    Ok(Value::Object(fields))
}

fn encode_crdt_effect(effect: &CrdtEffect) -> RemoteResult<Value> {
    let mut fields = BTreeMap::from([
        ("table".to_owned(), Value::String(effect.table.clone())),
        ("rowId".to_owned(), Value::String(effect.row_id.clone())),
        ("field".to_owned(), Value::String(effect.field.clone())),
        (
            "kind".to_owned(),
            Value::String(
                match effect.kind {
                    CrdtFieldKind::Text => "text",
                    CrdtFieldKind::Count => "count",
                    CrdtFieldKind::Set => "set",
                }
                .to_owned(),
            ),
        ),
        ("baseSeq".to_owned(), Value::Float64(effect.base_seq as f64)),
        (
            "projection".to_owned(),
            json_to_convex(effect.projection.clone())?,
        ),
        (
            "projectionHash".to_owned(),
            Value::String(effect.projection_hash.clone()),
        ),
        ("payload".to_owned(), Value::Bytes(effect.payload.clone())),
    ]);
    if let Some(checkpoint) = &effect.checkpoint {
        fields.insert("checkpoint".to_owned(), encode_checkpoint(checkpoint));
    }
    Ok(Value::Object(fields))
}

fn encode_checkpoint(checkpoint: &CrdtCheckpoint) -> Value {
    Value::Object(BTreeMap::from([
        (
            "throughSeq".to_owned(),
            Value::Float64(checkpoint.through_seq as f64),
        ),
        (
            "content".to_owned(),
            encode_opaque(&checkpoint.bytes, &checkpoint.hash),
        ),
    ]))
}

fn encode_opaque(bytes: &[u8], hash: &str) -> Value {
    if bytes.len() <= BLOB_CHUNK_BYTES {
        Value::Object(BTreeMap::from([
            ("kind".to_owned(), Value::String("inline".to_owned())),
            ("bytes".to_owned(), Value::Bytes(bytes.to_vec())),
            ("hash".to_owned(), Value::String(hash.to_owned())),
        ]))
    } else {
        Value::Object(BTreeMap::from([
            ("kind".to_owned(), Value::String("staged".to_owned())),
            ("blobId".to_owned(), Value::String(hash.to_owned())),
            ("bytes".to_owned(), Value::Float64(bytes.len() as f64)),
            ("hash".to_owned(), Value::String(hash.to_owned())),
        ]))
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(bytes);
    codec::hex(&hash.finalize())
}

pub fn decode_envelope(json: &str) -> RemoteResult<PushEnvelope> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|error| RemoteError::Protocol(format!("push envelope was not JSON: {error}")))?;
    let fields = json_object(&value, "push envelope")?;
    let local_inserts = json_string_array(fields.get("localInserts"), "localInserts")?;
    let runtime =
        decode_runtime(fields.get("clientRuntime").ok_or_else(|| {
            RemoteError::Protocol("push envelope missing clientRuntime".to_owned())
        })?)?;
    let mutation_id = json_string(fields, "mutationId")?;
    let replay_id = fields
        .get("replayId")
        .map(|_| json_string(fields, "replayId"))
        .transpose()?
        .unwrap_or_else(|| mutation_id.clone());
    let logical_fingerprint = fields
        .get("logicalFingerprint")
        .map(|_| json_string(fields, "logicalFingerprint"))
        .transpose()?
        .unwrap_or(logical_envelope_fingerprint(&value)?);
    Ok(PushEnvelope {
        mutation_id,
        replay_id,
        logical_fingerprint,
        commit_seq: json_i64(fields, "commitSeq")?,
        runtime,
        function: json_string(fields, "functionName")?,
        args: fields
            .get("args")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        result_hash: json_string(fields, "resultHash")?,
        id_paths: json_string_array(fields.get("idPaths"), "idPaths")?,
        mutation_time_hlc: json_number(fields, "mutationTime")?,
        rng_seed: json_string(fields, "randomSeed")?,
        id_allocations: local_inserts,
        local_schedule_ids: json_string_array(fields.get("localSchedules"), "localSchedules")?,
        inserts: json_array(fields, "inserts")?
            .iter()
            .map(decode_insert_ref)
            .collect::<RemoteResult<Vec<_>>>()?,
        arg_refs: json_array(fields, "argRefs")?
            .iter()
            .map(decode_arg_ref)
            .collect::<RemoteResult<Vec<_>>>()?,
        read_set: json_array(fields, "reads")?
            .iter()
            .map(decode_read_witness)
            .collect::<RemoteResult<Vec<_>>>()?,
        schedules: json_array(fields, "schedules")?
            .iter()
            .map(decode_schedule_ref)
            .collect::<RemoteResult<Vec<_>>>()?,
        uploads: json_array(fields, "uploads")?
            .iter()
            .map(decode_upload_ref)
            .collect::<RemoteResult<Vec<_>>>()?,
        after_images: json_array(fields, "afterImages")?
            .iter()
            .map(decode_revision_candidate)
            .collect::<RemoteResult<Vec<_>>>()?,
        crdt: json_array(fields, "crdt")?
            .iter()
            .map(decode_crdt_effect)
            .collect::<RemoteResult<Vec<_>>>()?,
        revision_checkpoints: json_array(fields, "revisionCheckpoints")?
            .iter()
            .map(decode_revision_checkpoint)
            .collect::<RemoteResult<Vec<_>>>()?,
    })
}

fn logical_envelope_fingerprint(value: &serde_json::Value) -> RemoteResult<String> {
    let mut logical = value.clone();
    let fields = logical
        .as_object_mut()
        .ok_or_else(|| RemoteError::Protocol("push envelope was not an object".to_owned()))?;
    fields.remove("replayId");
    fields.remove("logicalFingerprint");
    let encoded = serde_json::to_vec(&logical).map_err(|error| {
        RemoteError::Protocol(format!(
            "logical push envelope could not be encoded: {error}"
        ))
    })?;
    Ok(sha256_hex(&encoded))
}

fn decode_revision_checkpoint(value: &serde_json::Value) -> RemoteResult<RevisionCheckpoint> {
    let fields = json_object(value, "revision checkpoint")?;
    exact_json_fields(
        fields,
        &["ordinal", "operation", "rowId", "table", "snapshots"],
        &[],
        "revision checkpoint",
    )?;
    Ok(RevisionCheckpoint {
        ordinal: json_usize(fields, "ordinal")?,
        operation: match json_string(fields, "operation")?.as_str() {
            "create" => RevisionCheckpointOperation::Create,
            "retain" => RevisionCheckpointOperation::Retain,
            _ => {
                return Err(RemoteError::Protocol(
                    "invalid revision checkpoint operation".to_owned(),
                ));
            }
        },
        row_id: json_string(fields, "rowId")?,
        table: json_string(fields, "table")?,
        snapshots: json_array(fields, "snapshots")?
            .iter()
            .map(|value| {
                let snapshot = json_object(value, "revision CRDT snapshot")?;
                exact_json_fields(
                    snapshot,
                    &[
                        "field",
                        "kind",
                        "headSeq",
                        "projectionHash",
                        "bytes",
                        "hash",
                    ],
                    &[],
                    "revision CRDT snapshot",
                )?;
                let kind = CrdtFieldKind::parse_wire(&json_string(snapshot, "kind")?).ok_or_else(
                    || RemoteError::Protocol("invalid revision CRDT snapshot kind".to_owned()),
                )?;
                Ok(storage::CrdtSnapshot {
                    field: json_string(snapshot, "field")?,
                    kind,
                    head_seq: json_i64(snapshot, "headSeq")?,
                    projection_hash: json_string(snapshot, "projectionHash")?,
                    bytes: json_bytes(snapshot.get("bytes"), "bytes")?,
                    hash: json_string(snapshot, "hash")?,
                })
            })
            .collect::<RemoteResult<Vec<_>>>()?,
    })
}

fn decode_runtime(value: &serde_json::Value) -> RemoteResult<RuntimeWireIdentity> {
    let fields = json_object(value, "runtime identity")?;
    Ok(RuntimeWireIdentity {
        schema_hash: json_string(fields, "schemaHash")?,
        module_graph_hash: json_string(fields, "moduleGraphHash")?,
        protocol_version: json_i64(fields, "protocolVersion")?,
    })
}

fn decode_revision_candidate(value: &serde_json::Value) -> RemoteResult<RevisionCandidate> {
    let fields = json_object(value, "revision candidate")?;
    let content = match json_string(fields, "content")?.as_str() {
        "value" => RevisionContent::Value(fields.get("value").cloned().ok_or_else(|| {
            RemoteError::Protocol("value revision candidate missing value".to_owned())
        })?),
        "deleted" if fields.contains_key("value") => {
            return Err(RemoteError::Protocol(
                "deleted revision candidate cannot contain value".to_owned(),
            ));
        }
        "deleted" => RevisionContent::Deleted,
        other => {
            return Err(RemoteError::Protocol(format!(
                "unknown revision candidate content: {other}"
            )));
        }
    };
    let expected = match &content {
        RevisionContent::Value(_) => ["content", "rowId", "table", "value"].as_slice(),
        RevisionContent::Deleted => ["content", "rowId", "table"].as_slice(),
    };
    if fields.len() != expected.len() || fields.keys().any(|key| !expected.contains(&key.as_str()))
    {
        return Err(RemoteError::Protocol(
            "revision candidate contains unknown fields".to_owned(),
        ));
    }
    Ok(RevisionCandidate {
        table: json_string(fields, "table")?,
        row_id: json_string(fields, "rowId")?,
        content,
    })
}

fn decode_insert_ref(value: &serde_json::Value) -> RemoteResult<InsertRef> {
    let fields = json_object(value, "insert reference")?;
    Ok(InsertRef {
        mutation_id: json_string(fields, "mutationId")?,
        ordinal: json_usize(fields, "ordinal")?,
        table: json_string(fields, "table")?,
    })
}

fn decode_schedule_ref(value: &serde_json::Value) -> RemoteResult<ScheduleRef> {
    let fields = json_object(value, "schedule reference")?;
    Ok(ScheduleRef {
        mutation_id: json_string(fields, "mutationId")?,
        ordinal: json_usize(fields, "ordinal")?,
    })
}

fn decode_upload_ref(value: &serde_json::Value) -> RemoteResult<UploadRef> {
    let fields = json_object(value, "upload reference")?;
    Ok(UploadRef {
        mutation_id: json_string(fields, "mutationId")?,
        ordinal: json_usize(fields, "ordinal")?,
    })
}

fn decode_arg_ref(value: &serde_json::Value) -> RemoteResult<ArgRef> {
    let fields = json_object(value, "argument reference")?;
    let path = json_string(fields, "path")?;
    match (fields.get("insert"), fields.get("schedule")) {
        (Some(insert), None) => Ok(ArgRef::Insert {
            path,
            insert: decode_insert_ref(insert)?,
        }),
        (None, Some(schedule)) => Ok(ArgRef::Schedule {
            path,
            schedule: decode_schedule_ref(schedule)?,
        }),
        _ => Err(RemoteError::Protocol(
            "argument reference must contain exactly one insert or schedule reference".to_owned(),
        )),
    }
}

fn decode_read_witness(value: &serde_json::Value) -> RemoteResult<BaseVersion> {
    let fields = json_object(value, "read witness")?;
    match json_string(fields, "kind")?.as_str() {
        "point" => {
            exact_json_fields(
                fields,
                &["kind", "table", "rowId", "plainHash", "crdt"],
                &[],
                "point read witness",
            )?;
            Ok(BaseVersion::Point {
                table: json_string(fields, "table")?,
                id: json_string(fields, "rowId")?,
                version: 0.0,
                content_hash: json_string(fields, "plainHash")?,
                crdt: json_array(fields, "crdt")?
                    .iter()
                    .map(decode_crdt_read_witness)
                    .collect::<RemoteResult<Vec<_>>>()?,
            })
        }
        "range" => {
            exact_json_fields(
                fields,
                &[
                    "kind",
                    "table",
                    "index",
                    "equality",
                    "order",
                    "membersHash",
                    "members",
                    "memberHashes",
                ],
                &["limit", "lower", "upper"],
                "range read witness",
            )?;
            Ok(BaseVersion::Range(Box::new(RangeVersion {
                table: json_string(fields, "table")?,
                index: json_string(fields, "index")?,
                equality: json_array(fields, "equality")?
                    .iter()
                    .map(decode_read_equality)
                    .collect::<RemoteResult<Vec<_>>>()?,
                limit: fields
                    .get("limit")
                    .map(|_| json_usize(fields, "limit"))
                    .transpose()?,
                lower: decode_bound(fields.get("lower"))?,
                upper: decode_bound(fields.get("upper"))?,
                order: match json_string(fields, "order")?.as_str() {
                    "asc" => Order::Asc,
                    "desc" => Order::Desc,
                    _ => {
                        return Err(RemoteError::Protocol(
                            "invalid range witness order".to_owned(),
                        ));
                    }
                },
                members_hash: json_string(fields, "membersHash")?,
                members: required_json_string_array(fields, "members")?,
                member_hashes: required_json_string_array(fields, "memberHashes")?,
            })))
        }
        kind => Err(RemoteError::Protocol(format!(
            "invalid read witness kind {kind}"
        ))),
    }
}

fn decode_crdt_read_witness(value: &serde_json::Value) -> RemoteResult<CrdtReadWitness> {
    let fields = json_object(value, "CRDT read witness")?;
    exact_json_fields(
        fields,
        &["field", "epoch", "headSeq", "projectionHash"],
        &[],
        "CRDT read witness",
    )?;
    Ok(CrdtReadWitness {
        field: json_string(fields, "field")?,
        epoch: json_i64(fields, "epoch")?,
        head_seq: json_i64(fields, "headSeq")?,
        projection_hash: json_string(fields, "projectionHash")?,
    })
}

fn decode_read_equality(value: &serde_json::Value) -> RemoteResult<ReadEquality> {
    let fields = json_object(value, "read equality")?;
    exact_json_fields(fields, &["field", "value"], &["commitTs"], "read equality")?;
    Ok(ReadEquality {
        field: json_string(fields, "field")?,
        value: fields
            .get("value")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        commit_ts: optional_true(fields, "commitTs", "read equality")?,
    })
}

fn decode_bound(value: Option<&serde_json::Value>) -> RemoteResult<Option<ReadBound>> {
    let Some(value) = value else { return Ok(None) };
    let fields = json_object(value, "read bound")?;
    exact_json_fields(
        fields,
        &["field", "value", "inclusive"],
        &["commitTs"],
        "read bound",
    )?;
    Ok(Some(ReadBound {
        field: json_string(fields, "field")?,
        value: fields
            .get("value")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        inclusive: fields
            .get("inclusive")
            .and_then(serde_json::Value::as_bool)
            .ok_or_else(|| RemoteError::Protocol("read bound missing inclusive".to_owned()))?,
        commit_ts: optional_true(fields, "commitTs", "read bound")?,
    }))
}

fn optional_true(
    fields: &serde_json::Map<String, serde_json::Value>,
    field: &str,
    context: &str,
) -> RemoteResult<bool> {
    match fields.get(field) {
        None => Ok(false),
        Some(serde_json::Value::Bool(true)) => Ok(true),
        Some(_) => Err(RemoteError::Protocol(format!(
            "{context} {field} must be a boolean"
        ))),
    }
}

fn decode_crdt_effect(value: &serde_json::Value) -> RemoteResult<CrdtEffect> {
    let fields = json_object(value, "CRDT effect")?;
    let kind = CrdtFieldKind::parse_wire(&json_string(fields, "kind")?)
        .ok_or_else(|| RemoteError::Protocol("invalid CRDT effect kind".to_owned()))?;
    Ok(CrdtEffect {
        table: json_string(fields, "table")?,
        row_id: json_string(fields, "rowId")?,
        field: json_string(fields, "field")?,
        kind,
        base_seq: json_i64(fields, "baseSeq")?,
        projection: fields
            .get("projection")
            .cloned()
            .unwrap_or(serde_json::Value::Null),
        projection_hash: json_string(fields, "projectionHash")?,
        payload: json_bytes(fields.get("payload"), "payload")?,
        checkpoint: fields
            .get("checkpoint")
            .map(decode_checkpoint)
            .transpose()?,
    })
}

fn decode_checkpoint(value: &serde_json::Value) -> RemoteResult<CrdtCheckpoint> {
    let fields = json_object(value, "CRDT checkpoint")?;
    Ok(CrdtCheckpoint {
        through_seq: json_i64(fields, "throughSeq")?,
        bytes: json_bytes(fields.get("bytes"), "bytes")?,
        hash: json_string(fields, "hash")?,
    })
}

pub fn decode_push_response(value: &Value) -> RemoteResult<PushResponse> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "embedded:push result must be an object".to_owned(),
        ));
    };
    let field = |name: &'static str| {
        fields
            .get(name)
            .ok_or_else(|| RemoteError::Protocol(format!("embedded:push result missing {name}")))
    };
    let outcome_raw = codec::expect_string(field("outcome")?, "outcome")?;
    let outcome = PushOutcome::parse(&outcome_raw).ok_or_else(|| {
        RemoteError::Protocol(format!(
            "embedded:push returned invalid outcome {outcome_raw}"
        ))
    })?;
    let (required_payload, forbidden_payload) = match outcome {
        PushOutcome::Applied => ("result", "error"),
        PushOutcome::Conflict | PushOutcome::Rejected | PushOutcome::Rebase => ("error", "result"),
    };
    if !fields.contains_key(required_payload) || fields.contains_key(forbidden_payload) {
        return Err(RemoteError::Protocol(format!(
            "embedded:push {outcome_raw} settlement requires {required_payload} and forbids {forbidden_payload}"
        )));
    }
    let allowed = [
        "authoritative",
        "crdt",
        "error",
        "inserts",
        "mutationId",
        "outcome",
        "result",
        "revisions",
        "schedules",
        "uploads",
    ];
    if fields.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(RemoteError::Protocol(
            "embedded:push settlement contains unknown fields".to_owned(),
        ));
    }
    let inserts = decode_push_array(fields, "inserts", decode_settled_insert)?;
    let schedules = decode_push_array(fields, "schedules", decode_settled_schedule)?;
    let uploads = decode_push_array(fields, "uploads", decode_settled_upload)?;
    let revisions = decode_push_array(fields, "revisions", decode_settled_revision)?;
    let crdt = decode_push_array(fields, "crdt", decode_settled_crdt)?;
    let authoritative = decode_push_array(fields, "authoritative", decode_authoritative_change)?;
    Ok(PushResponse {
        mutation_id: codec::expect_string(field("mutationId")?, "mutationId")?,
        verdict: match outcome {
            PushOutcome::Applied => PushVerdict::Applied,
            PushOutcome::Conflict | PushOutcome::Rejected | PushOutcome::Rebase => {
                decode_push_failure(outcome, field("error")?)?
            }
        },
        inserts,
        schedules,
        uploads,
        revisions,
        crdt,
        authoritative,
    })
}

/// Decode the closed replay failure shape.
///
/// The server boundary removes untrusted payloads before this point. Reject every field except
/// `code`, so arbitrary application text cannot enter the native/public transport at all.
fn decode_push_failure(outcome: PushOutcome, value: &Value) -> RemoteResult<PushVerdict> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "embedded:push settlement error must be an object".to_owned(),
        ));
    };
    if fields.keys().any(|key| key != "code") {
        return Err(RemoteError::Protocol(
            "embedded:push settlement error contains unknown fields".to_owned(),
        ));
    }
    let code = fields
        .get("code")
        .ok_or_else(|| {
            RemoteError::Protocol("embedded:push settlement error missing code".to_owned())
        })
        .and_then(|value| codec::expect_string(value, "error.code"))?;
    match outcome {
        PushOutcome::Conflict if code == "EMBEDDED_CONFLICT" => Ok(PushVerdict::Conflict),
        PushOutcome::Rejected => RejectionCode::parse(&code)
            .map(PushVerdict::Rejected)
            .ok_or_else(|| {
                RemoteError::Protocol(
                    "embedded:push rejected settlement has invalid error code".to_owned(),
                )
            }),
        PushOutcome::Rebase if code == "EMBEDDED_REBASE" => Ok(PushVerdict::Rebase),
        PushOutcome::Applied => Err(RemoteError::Protocol(
            "embedded:push applied settlement cannot carry an error".to_owned(),
        )),
        PushOutcome::Conflict | PushOutcome::Rebase => Err(RemoteError::Protocol(
            "embedded:push settlement error code does not match its outcome".to_owned(),
        )),
    }
}

fn decode_settled_revision(value: &Value) -> RemoteResult<storage::SettledRevision> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "embedded:push revision settlement must be an object".to_owned(),
        ));
    };
    let field = |name: &'static str| {
        fields.get(name).ok_or_else(|| {
            RemoteError::Protocol(format!("embedded:push revision settlement missing {name}"))
        })
    };
    if fields
        .keys()
        .any(|key| !["revId", "rowId", "table"].contains(&key.as_str()))
    {
        return Err(RemoteError::Protocol(
            "embedded:push revision settlement contains unknown fields".to_owned(),
        ));
    }
    Ok(storage::SettledRevision {
        table: codec::expect_string(field("table")?, "table")?,
        row_id: codec::expect_string(field("rowId")?, "rowId")?,
        rev_id: codec::expect_string(field("revId")?, "revId")?,
    })
}

fn decode_settled_crdt(value: &Value) -> RemoteResult<storage::SettledCrdt> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "embedded:push crdt settlement must be an object".to_owned(),
        ));
    };
    let field = |name: &'static str| {
        fields.get(name).ok_or_else(|| {
            RemoteError::Protocol(format!("embedded:push crdt settlement missing {name}"))
        })
    };
    let kind = codec::expect_string(field("kind")?, "kind")?;
    Ok(storage::SettledCrdt {
        table: codec::expect_string(field("table")?, "table")?,
        row_id: codec::expect_string(field("rowId")?, "rowId")?,
        field: codec::expect_string(field("field")?, "field")?,
        kind: storage::CrdtFieldKind::parse_wire(&kind).ok_or_else(|| {
            RemoteError::Protocol(format!(
                "embedded:push crdt settlement has invalid kind {kind}"
            ))
        })?,
        head_seq: codec::expect_integral_number(field("headSeq")?, "headSeq")?,
        projection_hash: codec::expect_string(field("projectionHash")?, "projectionHash")?,
    })
}

fn decode_push_array<T>(
    fields: &std::collections::BTreeMap<String, Value>,
    name: &str,
    decode: impl Fn(&Value) -> RemoteResult<T>,
) -> RemoteResult<Vec<T>> {
    let Some(Value::Array(values)) = fields.get(name) else {
        return Err(RemoteError::Protocol(format!(
            "embedded:push {name} must be an array"
        )));
    };
    values.iter().map(decode).collect()
}

fn decode_authoritative_change(value: &Value) -> RemoteResult<AuthoritativeChange> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "authoritative change must be an object".to_owned(),
        ));
    };
    let field = |name: &'static str| {
        fields
            .get(name)
            .ok_or_else(|| RemoteError::Protocol(format!("authoritative change missing {name}")))
    };
    let table = codec::expect_string(field("table")?, "table")?;
    let row_id = codec::expect_string(field("rowId")?, "rowId")?;
    let plain_hash = codec::expect_string(field("plainHash")?, "plainHash")?;
    match codec::expect_string(field("op")?, "op")?.as_str() {
        "put" => Ok(AuthoritativeChange::Put {
            table,
            row_id,
            fields: serde_json::Value::from(field("fields")?.clone()),
            plain_hash,
        }),
        "del" => Ok(AuthoritativeChange::Delete {
            table,
            row_id,
            plain_hash,
        }),
        operation => Err(RemoteError::Protocol(format!(
            "invalid authoritative operation {operation}"
        ))),
    }
}

fn decode_settled_insert(value: &Value) -> RemoteResult<SettledInsert> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "settled insert must be an object".to_owned(),
        ));
    };
    Ok(SettledInsert {
        ordinal: codec::expect_integral_number(
            fields.get("ordinal").ok_or_else(|| {
                RemoteError::Protocol("settled insert missing ordinal".to_owned())
            })?,
            "ordinal",
        )? as usize,
        table: codec::expect_string(
            fields
                .get("table")
                .ok_or_else(|| RemoteError::Protocol("settled insert missing table".to_owned()))?,
            "table",
        )?,
        id: codec::expect_string(
            fields
                .get("id")
                .ok_or_else(|| RemoteError::Protocol("settled insert missing id".to_owned()))?,
            "id",
        )?,
    })
}

fn decode_settled_schedule(value: &Value) -> RemoteResult<SettledSchedule> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "settled schedule must be an object".to_owned(),
        ));
    };
    Ok(SettledSchedule {
        ordinal: codec::expect_integral_number(
            fields.get("ordinal").ok_or_else(|| {
                RemoteError::Protocol("settled schedule missing ordinal".to_owned())
            })?,
            "ordinal",
        )? as usize,
        id: codec::expect_string(
            fields
                .get("id")
                .ok_or_else(|| RemoteError::Protocol("settled schedule missing id".to_owned()))?,
            "id",
        )?,
    })
}

fn decode_settled_upload(value: &Value) -> RemoteResult<SettledUpload> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "settled upload must be an object".to_owned(),
        ));
    };
    Ok(SettledUpload {
        ordinal: codec::expect_integral_number(
            fields.get("ordinal").ok_or_else(|| {
                RemoteError::Protocol("settled upload missing ordinal".to_owned())
            })?,
            "ordinal",
        )? as usize,
        url: codec::expect_string(
            fields
                .get("url")
                .ok_or_else(|| RemoteError::Protocol("settled upload missing url".to_owned()))?,
            "url",
        )?,
    })
}

fn json_object<'a>(
    value: &'a serde_json::Value,
    name: &str,
) -> RemoteResult<&'a serde_json::Map<String, serde_json::Value>> {
    value
        .as_object()
        .ok_or_else(|| RemoteError::Protocol(format!("{name} must be an object")))
}

fn exact_json_fields(
    fields: &serde_json::Map<String, serde_json::Value>,
    required: &[&str],
    optional: &[&str],
    name: &str,
) -> RemoteResult<()> {
    if required.iter().any(|field| !fields.contains_key(*field)) {
        return Err(RemoteError::Protocol(format!(
            "{name} is missing required fields"
        )));
    }
    if fields
        .keys()
        .any(|field| !required.contains(&field.as_str()) && !optional.contains(&field.as_str()))
    {
        return Err(RemoteError::Protocol(format!(
            "{name} contains unknown fields"
        )));
    }
    Ok(())
}

fn required_json_string_array(
    fields: &serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> RemoteResult<Vec<String>> {
    json_array(fields, name)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| RemoteError::Protocol(format!("{name} entries must be strings")))
        })
        .collect()
}

fn json_array<'a>(
    fields: &'a serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> RemoteResult<&'a Vec<serde_json::Value>> {
    fields
        .get(name)
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| RemoteError::Protocol(format!("{name} must be an array")))
}

fn json_string(
    fields: &serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> RemoteResult<String> {
    fields
        .get(name)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| RemoteError::Protocol(format!("{name} must be a string")))
}

fn json_number(
    fields: &serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> RemoteResult<f64> {
    fields
        .get(name)
        .and_then(serde_json::Value::as_f64)
        .ok_or_else(|| RemoteError::Protocol(format!("{name} must be a number")))
}

fn json_i64(fields: &serde_json::Map<String, serde_json::Value>, name: &str) -> RemoteResult<i64> {
    let value = json_number(fields, name)?;
    if !value.is_finite()
        || value.fract() != 0.0
        || value < i64::MIN as f64
        || value > i64::MAX as f64
    {
        return Err(RemoteError::Protocol(format!("{name} must be an integer")));
    }
    Ok(value as i64)
}

fn json_usize(
    fields: &serde_json::Map<String, serde_json::Value>,
    name: &str,
) -> RemoteResult<usize> {
    let value = json_i64(fields, name)?;
    usize::try_from(value).map_err(|_| RemoteError::Protocol(format!("{name} must be nonnegative")))
}

fn json_string_array(value: Option<&serde_json::Value>, name: &str) -> RemoteResult<Vec<String>> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    value
        .as_array()
        .ok_or_else(|| RemoteError::Protocol(format!("{name} must be an array")))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| RemoteError::Protocol(format!("{name} entries must be strings")))
        })
        .collect()
}

fn json_bytes(value: Option<&serde_json::Value>, name: &str) -> RemoteResult<Vec<u8>> {
    match Value::try_from(value.cloned().unwrap_or(serde_json::Value::Null)) {
        Ok(Value::Bytes(bytes)) => Ok(bytes),
        _ => Err(RemoteError::Protocol(format!(
            "{name} must be Convex bytes"
        ))),
    }
}

fn json_to_convex(value: serde_json::Value) -> RemoteResult<Value> {
    Value::try_from(value)
        .map_err(|error| RemoteError::Protocol(format!("invalid push value: {error}")))
}

#[cfg(test)]
mod tests {
    use convex::Value;
    use storage::{BaseVersion, PushVerdict, RejectionCode};

    use super::{decode_envelope, decode_push_response, mutation_args, RemoteError};

    fn envelope_with_after_images(after_images: &serde_json::Value) -> String {
        serde_json::json!({
            "mutationId": "m1",
            "commitSeq": 1,
            "clientRuntime": {
                "schemaHash": "local",
                "moduleGraphHash": "local",
                "protocolVersion": crate::config::EMBEDDED_PROTOCOL_VERSION,
            },
            "functionName": "documents:write",
            "args": {},
            "resultHash": "result",
            "idPaths": [],
            "mutationTime": 1,
            "randomSeed": "seed",
            "localInserts": [],
            "localSchedules": [],
            "inserts": [],
            "argRefs": [],
            "reads": [],
            "schedules": [],
            "uploads": [],
            "afterImages": after_images,
            "crdt": [],
            "revisionCheckpoints": [],
        })
        .to_string()
    }

    #[test]
    fn present_after_images_array_decodes() {
        let json = envelope_with_after_images(&serde_json::json!([]));
        assert!(decode_envelope(&json).is_ok());
    }

    #[test]
    fn missing_after_images_is_rejected() {
        let mut value: serde_json::Value =
            serde_json::from_str(&envelope_with_after_images(&serde_json::json!([]))).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .remove("afterImages")
            .unwrap();
        let error = decode_envelope(&value.to_string()).unwrap_err();
        assert!(matches!(error, RemoteError::Protocol(_)), "{error:?}");
    }

    #[test]
    fn mistyped_after_images_is_rejected() {
        let json = envelope_with_after_images(&serde_json::json!(7));
        let error = decode_envelope(&json).unwrap_err();
        assert!(matches!(error, RemoteError::Protocol(_)), "{error:?}");
    }

    #[test]
    fn commit_timestamp_witness_flag_round_trips_as_ordinary_convex_values() {
        let mut value: serde_json::Value =
            serde_json::from_str(&envelope_with_after_images(&serde_json::json!([]))).unwrap();
        value["reads"] = serde_json::json!([{
            "kind": "range",
            "table": "issues",
            "index": "by_stamp",
            "equality": [{
                "field": "stamp",
                "value": { "$integer": "/////////38=" },
                "commitTs": true,
            }],
            "lower": {
                "field": "stamp",
                "value": { "$integer": "/////////38=" },
                "inclusive": true,
                "commitTs": true,
            },
            "order": "asc",
            "membersHash": "members",
            "members": [],
            "memberHashes": [],
        }]);

        let envelope = decode_envelope(&value.to_string()).unwrap();
        let BaseVersion::Range(range) = &envelope.read_set[0] else {
            panic!("expected range witness");
        };
        assert!(range.equality[0].commit_ts);
        assert!(range.lower.as_ref().unwrap().commit_ts);

        let encoded = mutation_args(&envelope, "client", None).unwrap();
        let Value::Object(request) = &encoded["request"] else {
            panic!("request must be an object");
        };
        let Value::Array(reads) = &request["reads"] else {
            panic!("reads must be an array");
        };
        let Value::Object(range) = &reads[0] else {
            panic!("range must be an object");
        };
        let Value::Array(equality) = &range["equality"] else {
            panic!("equality must be an array");
        };
        let Value::Object(equality) = &equality[0] else {
            panic!("equality must be an object");
        };
        assert_eq!(equality["commitTs"], Value::Boolean(true));
        assert_eq!(equality["value"], Value::Int64(i64::MAX));
    }

    fn failure_response(outcome: &str, error: &serde_json::Value) -> Value {
        Value::try_from(serde_json::json!({
            "mutationId": "m1",
            "outcome": outcome,
            "error": error,
            "inserts": [],
            "schedules": [],
            "uploads": [],
            "revisions": [],
            "crdt": [],
            "authoritative": [],
        }))
        .expect("test response is a Convex value")
    }

    #[test]
    fn structured_push_failure_codes_decode_to_closed_verdicts() {
        let cases = [
            (
                "conflict",
                serde_json::json!({ "code": "EMBEDDED_CONFLICT" }),
                PushVerdict::Conflict,
            ),
            (
                "rejected",
                serde_json::json!({ "code": "EMBEDDED_REJECTED" }),
                PushVerdict::Rejected(RejectionCode::Rejected),
            ),
            (
                "rejected",
                serde_json::json!({ "code": "EMBEDDED_DIVERGENCE" }),
                PushVerdict::Rejected(RejectionCode::Divergence),
            ),
            (
                "rebase",
                serde_json::json!({ "code": "EMBEDDED_REBASE" }),
                PushVerdict::Rebase,
            ),
        ];

        for (outcome, error, expected) in cases {
            let decoded = decode_push_response(&failure_response(outcome, &error))
                .expect("closed error code should decode");
            assert_eq!(decoded.verdict, expected);
        }
    }

    #[test]
    fn malformed_or_unknown_push_failure_codes_are_rejected() {
        let cases = [
            ("conflict", serde_json::json!("not an object")),
            ("conflict", serde_json::json!({})),
            ("conflict", serde_json::json!({ "code": 7 })),
            (
                "conflict",
                serde_json::json!({ "code": "EMBEDDED_REJECTED" }),
            ),
            (
                "rejected",
                serde_json::json!({ "code": "EMBEDDED_CONFLICT" }),
            ),
            ("rebase", serde_json::json!({ "code": "EMBEDDED_CONFLICT" })),
            ("rejected", serde_json::json!({ "code": "CUT4_SEED" })),
            (
                "rejected",
                serde_json::json!({ "code": "EMBEDDED_REJECTED", "reason": "secret" }),
            ),
            (
                "rejected",
                serde_json::json!({ "code": "EMBEDDED_REJECTED", "detail": "nope" }),
            ),
        ];

        for (outcome, error) in cases {
            assert!(
                matches!(
                    decode_push_response(&failure_response(outcome, &error)),
                    Err(RemoteError::Protocol(_))
                ),
                "{outcome} failure must fail closed"
            );
        }
    }
}
