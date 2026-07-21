use storage::{
    Bound, ColValue, ColumnDef, CommitOptions, CountSpec, CrdtFieldDef, CrdtFieldKind, CrdtOp,
    CrdtOperation, CrdtRestore, DeleteIn, DocWrite, IdMapping, IdMappingContent, IndexDef,
    LocalFieldDef, LocalFieldDelete, LocalFieldWrite, Order, ReadSpec, RowKey,
    ScheduledFunctionKind, ScheduledJob, ScheduledState, StoreSchema, TableDef, TablePlacement,
    UploadLease, UploadLeaseWrite, WriteBatch,
};

use crate::{model, BridgeError, BridgeResult};

pub(crate) fn schema(value: model::Schema) -> BridgeResult<StoreSchema> {
    Ok(StoreSchema {
        tables: value
            .tables
            .into_iter()
            .map(|table| {
                Ok(TableDef {
                    name: table.name,
                    placement: match table.placement.as_str() {
                        "replicated" => TablePlacement::Replicated,
                        "device" => TablePlacement::Device,
                        other => {
                            return Err(BridgeError::Protocol(format!(
                                "unknown embedded table placement {other}"
                            )))
                        }
                    },
                    columns: table
                        .columns
                        .into_iter()
                        .map(|column| ColumnDef {
                            name: column.name,
                            field: column.field,
                        })
                        .collect(),
                    crdt_fields: table
                        .crdt_fields
                        .into_iter()
                        .map(crdt_field)
                        .collect::<BridgeResult<_>>()?,
                    local_fields: table
                        .local_fields
                        .into_iter()
                        .map(|field| LocalFieldDef { field: field.field })
                        .collect(),
                    indexes: table
                        .indexes
                        .into_iter()
                        .map(index)
                        .collect::<BridgeResult<_>>()?,
                })
            })
            .collect::<BridgeResult<_>>()?,
    })
}

fn crdt_field(value: model::CrdtField) -> BridgeResult<CrdtFieldDef> {
    let kind = match value.kind.as_str() {
        "count" => CrdtFieldKind::Count,
        "set" => CrdtFieldKind::Set,
        "text" => CrdtFieldKind::Text,
        other => {
            return Err(BridgeError::Protocol(format!(
                "unknown CRDT field kind {other}"
            )))
        }
    };
    Ok(CrdtFieldDef {
        field: value.field,
        kind,
    })
}

fn index(value: model::Index) -> BridgeResult<IndexDef> {
    if value
        .columns
        .as_ref()
        .is_some_and(|columns| columns.len() != value.fields.len())
    {
        return Err(BridgeError::Protocol(format!(
            "index {} field and storage column counts differ",
            value.name
        )));
    }
    Ok(IndexDef {
        name: value.name,
        fields: value.fields,
        columns: value.columns,
    })
}

pub(crate) fn read_spec(value: model::ReadSpec) -> BridgeResult<ReadSpec> {
    Ok(ReadSpec {
        table: value.table,
        index: value.index,
        bounds: value.bounds.map(bounds).transpose()?,
        order: match value.order.as_str() {
            "asc" => Order::Asc,
            "desc" => Order::Desc,
            other => return Err(BridgeError::Protocol(format!("invalid order {other}"))),
        },
        page_size: value.page_size.map(|size| size as usize),
        cursor: value.cursor,
        resume_after_key: value
            .resume_after_key
            .map(|values| values.into_iter().map(scalar).collect())
            .transpose()?,
    })
}

pub(crate) fn count_spec(value: model::CountSpec) -> BridgeResult<CountSpec> {
    Ok(CountSpec {
        table: value.table,
        index: value.index,
        bounds: value.bounds.map(bounds).transpose()?,
    })
}

fn bounds(values: Vec<model::Bound>) -> BridgeResult<Vec<Bound>> {
    values.into_iter().map(bound).collect()
}

fn bound(value: model::Bound) -> BridgeResult<Bound> {
    match value.kind.as_str() {
        "eq" => Ok(Bound::Eq {
            value: value
                .value
                .map(scalar)
                .transpose()?
                .unwrap_or(ColValue::Null),
        }),
        "range" => Ok(Bound::Range {
            lower: value.lower.map(scalar).transpose()?,
            lower_inclusive: value.lower_inclusive.unwrap_or(false),
            upper: value.upper.map(scalar).transpose()?,
            upper_inclusive: value.upper_inclusive.unwrap_or(false),
        }),
        other => Err(BridgeError::Protocol(format!("invalid bound kind {other}"))),
    }
}

fn scalar(value: model::Scalar) -> BridgeResult<ColValue> {
    tagged(
        value.text,
        value.real,
        value.int,
        value.boolean,
        value.undef,
    )
}

fn tagged(
    text: Option<String>,
    real: Option<f64>,
    int: Option<String>,
    boolean: Option<bool>,
    undef: Option<bool>,
) -> BridgeResult<ColValue> {
    let count = usize::from(text.is_some())
        + usize::from(real.is_some())
        + usize::from(int.is_some())
        + usize::from(boolean.is_some());
    if count > 1 || (count == 1 && undef == Some(true)) {
        return Err(BridgeError::Protocol(
            "multiple scalar value tags set".to_owned(),
        ));
    }
    match (text, real, int, boolean, undef) {
        (_, _, _, _, Some(true)) => Ok(ColValue::Undefined),
        (Some(value), None, None, None, _) => Ok(ColValue::Text(value)),
        (None, Some(value), None, None, _) => Ok(ColValue::Real(value)),
        (None, None, Some(value), None, _) => value
            .parse()
            .map(ColValue::Integer)
            .map_err(|error| BridgeError::Protocol(format!("invalid i64 value: {error}"))),
        (None, None, None, Some(value), _) => Ok(ColValue::Bool(value)),
        (None, None, None, None, _) => Ok(ColValue::Null),
        _ => Err(BridgeError::Protocol("invalid scalar tags".to_owned())),
    }
}

pub(crate) fn write_batch(value: model::WriteBatch) -> BridgeResult<WriteBatch> {
    Ok(WriteBatch {
        doc_writes: value
            .doc_writes
            .into_iter()
            .map(doc_write)
            .collect::<BridgeResult<_>>()?,
        deletes: value
            .deletes
            .into_iter()
            .map(|row| DeleteIn {
                table: row.table,
                id: row.id,
            })
            .collect(),
        local_field_writes: value
            .local_field_writes
            .into_iter()
            .map(|write| {
                Ok(LocalFieldWrite {
                    table: write.table,
                    id: write.id,
                    field: write.field,
                    value: serde_json::from_str(&write.value_json).map_err(|error| {
                        BridgeError::Protocol(format!("invalid device field JSON: {error}"))
                    })?,
                })
            })
            .collect::<BridgeResult<_>>()?,
        local_field_deletes: value
            .local_field_deletes
            .into_iter()
            .map(|delete| LocalFieldDelete {
                table: delete.table,
                id: delete.id,
                field: delete.field,
            })
            .collect(),
        crdt_ops: value
            .crdt_ops
            .into_iter()
            .map(crdt_op)
            .collect::<BridgeResult<_>>()?,
        crdt_restores: value
            .crdt_restores
            .into_iter()
            .map(crdt_restore)
            .collect::<BridgeResult<_>>()?,
        fresh_ids: rows(value.fresh_ids),
        data_only_ids: rows(value.data_only_ids),
        id_mappings: value
            .id_mappings
            .into_iter()
            .map(id_mapping)
            .collect::<BridgeResult<_>>()?,
        schedules: value
            .schedules
            .into_iter()
            .map(scheduled_job)
            .collect::<BridgeResult<_>>()?,
    })
}

fn rows(values: Vec<model::Row>) -> Vec<RowKey> {
    values
        .into_iter()
        .map(|row| RowKey {
            table: row.table,
            document_id: row.id,
        })
        .collect()
}

fn doc_write(value: model::DocWrite) -> BridgeResult<DocWrite> {
    Ok(DocWrite {
        table: value.table,
        id: value.id,
        data: value.data,
        cols: value
            .cols
            .into_iter()
            .map(|column| {
                let scalar = tagged(
                    column.text,
                    column.real,
                    column.int,
                    column.boolean,
                    column.undef,
                )?;
                Ok((column.name, scalar))
            })
            .collect::<BridgeResult<_>>()?,
        creation_time: value.creation_time,
    })
}

pub(crate) fn crdt_op(value: model::CrdtOp) -> BridgeResult<CrdtOp> {
    let operation = match value.kind.as_str() {
        "count.add" => CrdtOperation::CountAdd {
            delta: value
                .delta
                .ok_or_else(|| BridgeError::Protocol("count.add missing delta".to_owned()))?,
        },
        "set.add" => CrdtOperation::SetAdd {
            value_json: value
                .value_json
                .ok_or_else(|| BridgeError::Protocol("set.add missing valueJson".to_owned()))?,
        },
        "set.delete" => CrdtOperation::SetDelete {
            value_json: value
                .value_json
                .ok_or_else(|| BridgeError::Protocol("set.delete missing valueJson".to_owned()))?,
        },
        "text.splice" => CrdtOperation::TextSplice {
            index: value
                .index
                .ok_or_else(|| BridgeError::Protocol("text.splice missing index".to_owned()))?,
            delete: value
                .delete
                .ok_or_else(|| BridgeError::Protocol("text.splice missing delete".to_owned()))?,
            insert: value
                .insert
                .ok_or_else(|| BridgeError::Protocol("text.splice missing insert".to_owned()))?,
        },
        other => {
            return Err(BridgeError::Protocol(format!(
                "invalid CRDT op kind {other}"
            )))
        }
    };
    Ok(CrdtOp {
        row: RowKey {
            table: value.table,
            document_id: value.id,
        },
        field: value.field,
        operation,
    })
}

fn crdt_restore(value: model::CrdtRestore) -> BridgeResult<CrdtRestore> {
    let kind = CrdtFieldKind::parse_wire(&value.kind).ok_or_else(|| {
        BridgeError::Protocol(format!("invalid CRDT restore kind {}", value.kind))
    })?;
    Ok(CrdtRestore {
        row: RowKey {
            table: value.table,
            document_id: value.id,
        },
        field: value.field,
        kind,
        head_seq: value.head_seq,
        projection_hash: value.projection_hash,
        bytes: value.bytes,
        hash: value.hash,
    })
}

pub(crate) fn commit_options(value: Option<model::CommitOptions>) -> BridgeResult<CommitOptions> {
    let Some(value) = value else {
        return Ok(CommitOptions::default());
    };
    CommitOptions::decode(
        value.source.as_deref(),
        value.mutation_id,
        value.mutation_name,
        value.mutation_args,
        value.mutation_result,
        value.push_envelope_json,
        value.push_envelope_now_ms.map(|time| time as i64),
        value.mutation_is_fresh.unwrap_or(false),
        value.include_changes.unwrap_or(true),
    )
    .ok_or_else(|| BridgeError::Protocol("invalid exact commit metadata".to_owned()))
}

pub(crate) fn id_mapping(value: model::IdMapping) -> BridgeResult<IdMapping> {
    let mapping = IdMappingContent::decode(&value.state, value.convex_id).ok_or_else(|| {
        BridgeError::Protocol(format!("invalid id mapping state {}", value.state))
    })?;
    Ok(IdMapping {
        table: value.table,
        local_id: value.local_id,
        mapping,
        created_time: value.created_time,
        updated_time: value.updated_time,
    })
}

pub(crate) fn upload(value: model::PendingUpload) -> BridgeResult<storage::PendingUpload> {
    let lease = UploadLease::decode(&value.state, value.owner, value.lease_until)
        .ok_or_else(|| BridgeError::Protocol(format!("invalid upload state {}", value.state)))?;
    Ok(storage::PendingUpload {
        local_storage_id: value.local_storage_id,
        sha256: value.sha256,
        size: value.size,
        content_type: value.content_type,
        lease,
        created_time: value.created_time,
        updated_time: value.updated_time,
    })
}

pub(crate) fn upload_lease(value: model::UploadLeaseWrite) -> BridgeResult<UploadLeaseWrite> {
    match (
        value.lease.as_str(),
        value.local_storage_id,
        value.lease_until,
    ) {
        ("claimed", local_storage_id, Some(lease_until)) => Ok(UploadLeaseWrite::Claimed {
            local_storage_id,
            owner: value.owner,
            now_ms: value.now_ms,
            lease_until,
        }),
        ("pending", Some(local_storage_id), None) => Ok(UploadLeaseWrite::Pending {
            local_storage_id,
            owner: value.owner,
            now_ms: value.now_ms,
        }),
        _ => Err(BridgeError::Protocol(format!(
            "invalid upload lease {}",
            value.lease
        ))),
    }
}

pub(crate) fn scheduled_job(value: model::ScheduledJob) -> BridgeResult<ScheduledJob> {
    let state = ScheduledState::decode(&value.state, value.lease_until)
        .ok_or_else(|| BridgeError::Protocol(format!("invalid schedule state {}", value.state)))?;
    let kind = ScheduledFunctionKind::parse(&value.kind)
        .ok_or_else(|| BridgeError::Protocol(format!("invalid schedule kind {}", value.kind)))?;
    Ok(ScheduledJob {
        job_id: value.job_id,
        kind,
        name: value.name,
        args: value.args,
        due_time: value.due_time,
        state,
        created_time: value.created_time,
        updated_time: value.updated_time,
    })
}
