#![allow(unreachable_pub)]

use std::collections::BTreeMap;

use convex::Value;
use storage::{CrdtCheckpointRequest, CrdtFieldKind, RowChange, RowChangeOp, RuntimeWireIdentity};

use crate::{codec, ConvexArgs, RemoteError, RemoteResult};

/// One authoritative app-row change returned by the retained pull query.
#[derive(Debug, Clone, PartialEq)]
pub struct PullChange {
    pub body: PullChangeBody,
    pub plain_hash: String,
    /// The doc's current server revision token (the `revisions` head `revId`), stamped on each
    /// pulled `put` (§5 pull egress). The driver seeds the projection's `current_root_id` from it so
    /// an imported row carries a rev base a conflict loser can adopt. Absent on a `del`/`crdt`.
    pub rev: Option<String>,
}

/// The app-row payload of a [`PullChange`]. CRDT bytes travel in the response's separate `crdt`
/// collection so they can carry a checkpoint plus an ordered payload tail.
#[derive(Debug, Clone, PartialEq)]
pub enum PullChangeBody {
    Row(RowChange),
}

/// One carried CRDT op in the pull response (§1 `{ op:"crdt", table, id, field, kind, update }`). `update`
/// is the raw Loro update bytes (Convex `$bytes` on the JSON wire) the client imports/merges into
/// the field's local document — commutative, order-independent, never a conflict (§3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullCrdt {
    pub table: String,
    pub id: String,
    pub field: String,
    pub kind: CrdtFieldKind,
    pub epoch: i64,
    pub checkpoint: PullCheckpoint,
    pub head_seq: i64,
    pub projection_hash: String,
    pub payload: Option<PullPayload>,
    pub checkpoint_request: Option<CrdtCheckpointRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullPayload {
    pub seq: i64,
    pub bytes: Vec<u8>,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullCheckpoint {
    pub id: String,
    pub seq: i64,
    pub bytes: usize,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointPage {
    pub checkpoint: PullCheckpoint,
    pub head_seq: i64,
    pub chunks: Vec<CheckpointChunk>,
    pub payloads: Vec<PullPayload>,
    pub continue_cursor: Option<String>,
    pub is_done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointResult {
    Page(CheckpointPage),
    Stale,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckpointChunk {
    pub ordinal: usize,
    pub bytes: Vec<u8>,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorPage {
    pub found: bool,
    pub cursor: Option<String>,
    pub is_done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullMember {
    pub table: String,
    pub id: String,
}

/// The retained authored-result cache payload of a live pull (Cut 7 §2): the normalized `result`
/// skeleton with each matched complete-document subtree encoded as `null` in place, plus the
/// `resultRows` addresses that splice those subtrees back at reconstruction. Absent (older/plain-only
/// shape) means no cache write; present-but-empty still writes the transformed-scalar cache.
#[derive(Debug, Clone, PartialEq)]
pub struct PullResult {
    pub skeleton: Value,
    pub rows: Vec<PullResultRow>,
}

/// One `resultRows` address: an RFC 6901 JSON Pointer into the skeleton and the hosted row it names.
/// `row_id` stays the hosted id verbatim (§2); S4 resolves hosted -> local at reconstruction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullResultRow {
    pub path: String,
    pub table: String,
    pub row_id: String,
}

/// One complete authorized result from the app-defined retained pull query.
#[derive(Debug, Clone, PartialEq)]
pub struct PullPage {
    pub members: Vec<PullMember>,
    pub changes: Vec<PullChange>,
    pub crdt: Vec<PullCrdt>,
    pub result: Option<PullResult>,
}

/// Build the retained pull request. The app query runs under normal Convex auth; `clientId` is
/// operational only and `schemaHash` is generated from the local schema.
pub fn args(
    runtime: &RuntimeWireIdentity,
    _pull_fn: &str,
    pull_args: &serde_json::Value,
) -> RemoteResult<ConvexArgs> {
    let Value::Object(mut args) = json_to_convex(pull_args)? else {
        return Err(RemoteError::Protocol(
            "retained query arguments must be an object".to_owned(),
        ));
    };
    if args.contains_key("embeddedTransport") {
        return Err(RemoteError::Protocol(
            "retained query arguments use Embedded's reserved transport field".to_owned(),
        ));
    }
    args.insert(
        "embeddedTransport".to_owned(),
        Value::Object(BTreeMap::from([
            ("kind".to_owned(), Value::String("live".to_owned())),
            ("component".to_owned(), Value::String(String::new())),
            ("runtime".to_owned(), encode_runtime(runtime)),
            ("stack".to_owned(), Value::Array(Vec::new())),
            ("topLevel".to_owned(), Value::Boolean(true)),
        ])),
    );
    Ok(args)
}

pub fn live_args(
    runtime: &RuntimeWireIdentity,
    pull_fn: &str,
    pull_args: &serde_json::Value,
) -> RemoteResult<ConvexArgs> {
    let request = BTreeMap::from([
        ("kind".to_owned(), Value::String("live".to_owned())),
        ("functionName".to_owned(), Value::String(pull_fn.to_owned())),
        ("args".to_owned(), json_to_convex(pull_args)?),
        ("runtime".to_owned(), encode_runtime(runtime)),
    ]);
    Ok(BTreeMap::from([(
        "request".to_owned(),
        Value::Object(request),
    )]))
}

#[allow(clippy::too_many_arguments)]
pub fn checkpoint_args(
    runtime: &RuntimeWireIdentity,
    pull_fn: &str,
    pull_args: &serde_json::Value,
    table: &str,
    row_id: &str,
    field: &str,
    checkpoint_id: &str,
    epoch: i64,
    head_seq: i64,
    cursor: Option<&str>,
) -> RemoteResult<ConvexArgs> {
    let request = BTreeMap::from([
        ("kind".to_owned(), Value::String("checkpoint".to_owned())),
        ("functionName".to_owned(), Value::String(pull_fn.to_owned())),
        ("args".to_owned(), json_to_convex(pull_args)?),
        ("runtime".to_owned(), encode_runtime(runtime)),
        ("table".to_owned(), Value::String(table.to_owned())),
        ("rowId".to_owned(), Value::String(row_id.to_owned())),
        ("field".to_owned(), Value::String(field.to_owned())),
        (
            "checkpointId".to_owned(),
            Value::String(checkpoint_id.to_owned()),
        ),
        ("epoch".to_owned(), Value::Float64(epoch as f64)),
        ("headSeq".to_owned(), Value::Float64(head_seq as f64)),
        (
            "cursor".to_owned(),
            cursor.map_or(Value::Null, |value| Value::String(value.to_owned())),
        ),
    ]);
    Ok(BTreeMap::from([(
        "request".to_owned(),
        Value::Object(request),
    )]))
}

pub fn cursor_args(
    runtime: &RuntimeWireIdentity,
    pull_fn: &str,
    pull_args: &serde_json::Value,
    path: &str,
    boundary: &serde_json::Value,
    cursor: Option<&str>,
) -> RemoteResult<ConvexArgs> {
    let request = BTreeMap::from([
        ("kind".to_owned(), Value::String("cursor".to_owned())),
        ("functionName".to_owned(), Value::String(pull_fn.to_owned())),
        ("args".to_owned(), json_to_convex(pull_args)?),
        ("runtime".to_owned(), encode_runtime(runtime)),
        ("path".to_owned(), Value::String(path.to_owned())),
        ("boundary".to_owned(), json_to_convex(boundary)?),
        (
            "cursor".to_owned(),
            cursor.map_or(Value::Null, |value| Value::String(value.to_owned())),
        ),
    ]);
    Ok(BTreeMap::from([(
        "request".to_owned(),
        Value::Object(request),
    )]))
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
            "contractId".to_owned(),
            Value::String(runtime.contract_id.clone()),
        ),
    ]))
}

fn json_to_convex(value: &serde_json::Value) -> RemoteResult<Value> {
    Value::try_from(value.clone())
        .map_err(|e| RemoteError::Protocol(format!("pull args were not a Convex value: {e}")))
}

/// Decode an authoritative pull result. Wire shape:
///
/// ```json
/// { "members": [...], "changes": [
///     { "op": "put", "table": "documents", "rowId": "..", "fields": { .. } }
/// ], "crdt": [] }
/// ```
pub fn decode(value: Value) -> RemoteResult<PullPage> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "embedded:pull result must be an object".to_owned(),
        ));
    };
    let members = decode_members(fields.get("members"))?;
    let Some(Value::Array(rows)) = fields.get("changes") else {
        return Err(RemoteError::Protocol(
            "embedded:pull changes must be an array".to_owned(),
        ));
    };
    let changes = rows
        .iter()
        .map(decode_change)
        .collect::<RemoteResult<Vec<_>>>()?;
    let Some(Value::Array(crdt)) = fields.get("crdt") else {
        return Err(RemoteError::Protocol(
            "embedded:pull crdt must be an array".to_owned(),
        ));
    };
    let crdt = crdt
        .iter()
        .map(decode_crdt)
        .collect::<RemoteResult<Vec<_>>>()?
        .into_iter()
        .flatten()
        .collect();
    let result = decode_result(&fields)?;
    Ok(PullPage {
        members,
        changes,
        crdt,
        result,
    })
}

/// Decode the retained-result payload. An absent `result` field yields `None` (no cache write); a
/// present `result` — including a scalar or `null` — yields `Some`, with `resultRows` defaulting to
/// empty when omitted alongside a present result.
fn decode_result(fields: &BTreeMap<String, Value>) -> RemoteResult<Option<PullResult>> {
    let Some(skeleton) = fields.get("result") else {
        return Ok(None);
    };
    let rows = match fields.get("resultRows") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(values)) => values
            .iter()
            .map(decode_result_row)
            .collect::<RemoteResult<Vec<_>>>()?,
        Some(_) => {
            return Err(RemoteError::Protocol(
                "embedded:pull resultRows must be an array".to_owned(),
            ));
        }
    };
    Ok(Some(PullResult {
        skeleton: skeleton.clone(),
        rows,
    }))
}

fn decode_result_row(value: &Value) -> RemoteResult<PullResultRow> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "embedded:pull resultRows entry must be an object".to_owned(),
        ));
    };
    let field = |name: &'static str| {
        fields
            .get(name)
            .ok_or_else(|| {
                RemoteError::Protocol(format!("embedded:pull resultRows missing {name}"))
            })
            .and_then(|value| codec::expect_string(value, name))
    };
    Ok(PullResultRow {
        path: field("path")?,
        table: field("table")?,
        row_id: field("rowId")?,
    })
}

fn decode_members(value: Option<&Value>) -> RemoteResult<Vec<PullMember>> {
    let Some(Value::Array(values)) = value else {
        return Err(RemoteError::Protocol(
            "embedded:pull members must be an array".to_owned(),
        ));
    };
    values
        .iter()
        .map(|value| {
            let Value::Object(fields) = value else {
                return Err(RemoteError::Protocol(
                    "embedded:pull member must be an object".to_owned(),
                ));
            };
            Ok(PullMember {
                table: codec::expect_string(
                    fields.get("table").ok_or_else(|| {
                        RemoteError::Protocol("embedded:pull member is missing table".to_owned())
                    })?,
                    "table",
                )?,
                id: codec::expect_string(
                    fields.get("rowId").ok_or_else(|| {
                        RemoteError::Protocol("embedded:pull member is missing rowId".to_owned())
                    })?,
                    "rowId",
                )?,
            })
        })
        .collect()
}

fn decode_change(value: &Value) -> RemoteResult<PullChange> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "embedded:pull change must be an object".to_owned(),
        ));
    };
    let field = |name: &'static str| {
        fields
            .get(name)
            .ok_or_else(|| RemoteError::Protocol(format!("embedded:pull change missing {name}")))
    };
    let op_raw = codec::expect_string(field("op")?, "op")?;
    let table = codec::expect_string(field("table")?, "table")?;
    let id = codec::expect_string(field("rowId")?, "rowId")?;
    let plain_hash = codec::expect_string(field("plainHash")?, "plainHash")?;
    let op = RowChangeOp::parse(match op_raw.as_str() {
        "put" => "write",
        "del" => "delete",
        other => other,
    })
    .ok_or_else(|| RemoteError::Protocol(format!("embedded:pull change invalid op {op_raw}")))?;
    let row = match (op, fields.get("fields")) {
        (RowChangeOp::Write, Some(value)) => Some(codec::row_json_string(
            value,
            id.clone(),
            fields.get("creationTime"),
        )?),
        _ => None,
    };
    Ok(PullChange {
        body: PullChangeBody::Row(RowChange { op, table, id, row }),
        plain_hash,
        rev: None,
    })
}

fn decode_crdt(value: &Value) -> RemoteResult<Vec<PullCrdt>> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "embedded:pull crdt entry must be an object".to_owned(),
        ));
    };
    let string = |name: &'static str| {
        fields
            .get(name)
            .ok_or_else(|| RemoteError::Protocol(format!("embedded:pull crdt missing {name}")))
            .and_then(|value| codec::expect_string(value, name))
    };
    let table = string("table")?;
    let id = string("rowId")?;
    let field = string("field")?;
    let kind_raw = string("kind")?;
    let kind = CrdtFieldKind::parse_wire(&kind_raw).ok_or_else(|| {
        RemoteError::Protocol(format!("embedded:pull crdt invalid kind {kind_raw}"))
    })?;
    let epoch = fields
        .get("epoch")
        .ok_or_else(|| RemoteError::Protocol("embedded:pull crdt missing epoch".to_owned()))
        .and_then(|value| codec::expect_integral_number(value, "epoch"))?;
    let checkpoint = decode_checkpoint(fields.get("checkpoint"))?;
    let checkpoint_seq = checkpoint.seq;
    let head_seq = fields
        .get("headSeq")
        .ok_or_else(|| RemoteError::Protocol("embedded:pull crdt missing headSeq".to_owned()))
        .and_then(|value| codec::expect_integral_number(value, "headSeq"))?;
    let projection_hash = string("projectionHash")?;
    let payload = decode_live_payload(fields)?;
    let checkpoint_request = match fields.get("checkpointRequest") {
        None => None,
        Some(Value::Object(request)) => Some(CrdtCheckpointRequest {
            checkpoint_id: request
                .get("checkpointId")
                .ok_or_else(|| {
                    RemoteError::Protocol(
                        "embedded:pull checkpoint request missing checkpointId".to_owned(),
                    )
                })
                .and_then(|value| codec::expect_string(value, "checkpointId"))?,
            response_token: request
                .get("responseToken")
                .ok_or_else(|| {
                    RemoteError::Protocol(
                        "embedded:pull checkpoint request missing responseToken".to_owned(),
                    )
                })
                .and_then(|value| codec::expect_string(value, "responseToken"))?,
            through_seq: request
                .get("throughSeq")
                .ok_or_else(|| {
                    RemoteError::Protocol(
                        "embedded:pull checkpoint request missing throughSeq".to_owned(),
                    )
                })
                .and_then(|value| codec::expect_integral_number(value, "throughSeq"))?,
            projection_hash: request
                .get("projectionHash")
                .ok_or_else(|| {
                    RemoteError::Protocol(
                        "embedded:pull checkpoint request missing projectionHash".to_owned(),
                    )
                })
                .and_then(|value| codec::expect_string(value, "projectionHash"))?,
        }),
        Some(_) => {
            return Err(RemoteError::Protocol(
                "embedded:pull checkpointRequest must be an object".to_owned(),
            ));
        }
    };
    if checkpoint_seq > head_seq
        || (checkpoint_seq == head_seq && payload.is_some())
        || (checkpoint_seq < head_seq && payload.as_ref().is_none_or(|value| value.seq != head_seq))
    {
        return Err(RemoteError::Protocol(
            "embedded:pull CRDT manifest does not carry its latest payload".to_owned(),
        ));
    }
    Ok(vec![PullCrdt {
        table,
        id,
        field,
        kind,
        epoch,
        checkpoint,
        head_seq,
        projection_hash,
        payload,
        checkpoint_request,
    }])
}

fn decode_live_payload(fields: &BTreeMap<String, Value>) -> RemoteResult<Option<PullPayload>> {
    match fields.get("payload") {
        None => Ok(None),
        Some(value) => decode_payload(value, "embedded:pull crdt payload").map(Some),
    }
}

fn decode_payload(value: &Value, label: &str) -> RemoteResult<PullPayload> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(format!("{label} must be an object")));
    };
    let Some(Value::Bytes(bytes)) = fields.get("bytes") else {
        return Err(RemoteError::Protocol(format!(
            "{label} bytes must be $bytes"
        )));
    };
    Ok(PullPayload {
        seq: fields
            .get("seq")
            .ok_or_else(|| RemoteError::Protocol(format!("{label} missing seq")))
            .and_then(|value| codec::expect_integral_number(value, "seq"))?,
        bytes: bytes.clone(),
        hash: fields
            .get("hash")
            .ok_or_else(|| RemoteError::Protocol(format!("{label} missing hash")))
            .and_then(|value| codec::expect_string(value, "hash"))?,
    })
}

fn decode_checkpoint(value: Option<&Value>) -> RemoteResult<PullCheckpoint> {
    let Some(Value::Object(fields)) = value else {
        return Err(RemoteError::Protocol(
            "embedded:pull checkpoint manifest must be an object".to_owned(),
        ));
    };
    let integral = |name| {
        fields
            .get(name)
            .ok_or_else(|| RemoteError::Protocol(format!("checkpoint manifest missing {name}")))
            .and_then(|value| codec::expect_integral_number(value, name))
    };
    let bytes = usize::try_from(integral("bytes")?).map_err(|_| {
        RemoteError::Protocol("checkpoint manifest byte length is invalid".to_owned())
    })?;
    Ok(PullCheckpoint {
        id: fields
            .get("id")
            .ok_or_else(|| RemoteError::Protocol("checkpoint manifest missing id".to_owned()))
            .and_then(|value| codec::expect_string(value, "id"))?,
        seq: integral("seq")?,
        bytes,
        hash: fields
            .get("hash")
            .ok_or_else(|| RemoteError::Protocol("checkpoint manifest missing hash".to_owned()))
            .and_then(|value| codec::expect_string(value, "hash"))?,
    })
}

pub fn decode_checkpoint_page(value: Value) -> RemoteResult<CheckpointResult> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "checkpoint result must be an object".to_owned(),
        ));
    };
    if matches!(fields.get("kind"), Some(Value::String(kind)) if kind == "stale") {
        return Ok(CheckpointResult::Stale);
    }
    let checkpoint = decode_checkpoint(fields.get("checkpoint"))?;
    let head_seq = fields
        .get("headSeq")
        .ok_or_else(|| RemoteError::Protocol("checkpoint result missing headSeq".to_owned()))
        .and_then(|value| codec::expect_integral_number(value, "headSeq"))?;
    let Some(Value::Array(values)) = fields.get("chunks") else {
        return Err(RemoteError::Protocol(
            "checkpoint chunks must be an array".to_owned(),
        ));
    };
    let mut chunks = Vec::with_capacity(values.len());
    for value in values {
        let Value::Object(chunk) = value else {
            return Err(RemoteError::Protocol(
                "checkpoint chunk must be an object".to_owned(),
            ));
        };
        let ordinal = chunk
            .get("ordinal")
            .ok_or_else(|| RemoteError::Protocol("checkpoint chunk missing ordinal".to_owned()))
            .and_then(|value| codec::expect_integral_number(value, "ordinal"))?;
        chunks.push(CheckpointChunk {
            ordinal: usize::try_from(ordinal).map_err(|_| {
                RemoteError::Protocol("checkpoint chunk ordinal is invalid".to_owned())
            })?,
            bytes: match chunk.get("bytes") {
                Some(Value::Bytes(bytes)) => bytes.clone(),
                _ => {
                    return Err(RemoteError::Protocol(
                        "checkpoint chunk bytes are invalid".to_owned(),
                    ));
                }
            },
            hash: chunk
                .get("hash")
                .ok_or_else(|| RemoteError::Protocol("checkpoint chunk missing hash".to_owned()))
                .and_then(|value| codec::expect_string(value, "hash"))?,
        });
    }
    let Some(Value::Array(values)) = fields.get("payloads") else {
        return Err(RemoteError::Protocol(
            "checkpoint payloads must be an array".to_owned(),
        ));
    };
    let payloads = values
        .iter()
        .map(|value| decode_payload(value, "checkpoint payload"))
        .collect::<RemoteResult<Vec<_>>>()?;
    let continue_cursor = match fields.get("continueCursor") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Null) => None,
        _ => {
            return Err(RemoteError::Protocol(
                "checkpoint cursor is invalid".to_owned(),
            ));
        }
    };
    let is_done = match fields.get("isDone") {
        Some(Value::Boolean(value)) => *value,
        _ => {
            return Err(RemoteError::Protocol(
                "checkpoint isDone is invalid".to_owned(),
            ));
        }
    };
    Ok(CheckpointResult::Page(CheckpointPage {
        checkpoint,
        head_seq,
        chunks,
        payloads,
        continue_cursor,
        is_done,
    }))
}

pub fn decode_cursor(value: Value) -> RemoteResult<CursorPage> {
    let Value::Object(fields) = value else {
        return Err(RemoteError::Protocol(
            "cursor resolution result must be an object".to_owned(),
        ));
    };
    let found = match fields.get("found") {
        Some(Value::Boolean(value)) => *value,
        _ => {
            return Err(RemoteError::Protocol(
                "cursor result found is invalid".to_owned(),
            ))
        }
    };
    let cursor = match fields.get("cursor") {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Null) => None,
        _ => {
            return Err(RemoteError::Protocol(
                "cursor result cursor is invalid".to_owned(),
            ))
        }
    };
    let is_done = match fields.get("isDone") {
        Some(Value::Boolean(value)) => *value,
        _ => {
            return Err(RemoteError::Protocol(
                "cursor result isDone is invalid".to_owned(),
            ))
        }
    };
    Ok(CursorPage {
        found,
        cursor,
        is_done,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> RuntimeWireIdentity {
        RuntimeWireIdentity {
            schema_hash: "schema-1".to_owned(),
            module_graph_hash: "modules-1".to_owned(),
            contract_id: storage::CURRENT_WIRE_CONTRACT_ID.to_owned(),
        }
    }

    fn args() -> serde_json::Value {
        serde_json::json!({ "channel": "live" })
    }

    #[test]
    fn args_carry_live_transport_on_authored_query() {
        let request = args();
        let out = super::args(&runtime(), "messages:list", &request).unwrap();
        assert_eq!(out.get("channel"), Some(&Value::from("live")));
        let Some(Value::Object(transport)) = out.get("embeddedTransport") else {
            panic!("retained query args must contain live transport");
        };
        assert_eq!(transport.get("kind"), Some(&Value::from("live")));
        assert_eq!(transport.get("topLevel"), Some(&Value::Boolean(true)));
        assert!(transport.contains_key("runtime"));
        assert!(!transport.contains_key("functionName"));
        assert!(!transport.contains_key("args"));
    }

    #[test]
    fn args_omit_membership_and_cursor() {
        let out = super::args(&runtime(), "messages:list", &args()).unwrap();
        let Some(Value::Object(out)) = out.get("embeddedTransport") else {
            panic!("retained query args must contain live transport");
        };
        assert!(!out.contains_key("cursor"));
        assert!(!out.contains_key("members"));
    }

    #[test]
    fn live_args_address_an_authoritative_one_shot_refresh() {
        let out = live_args(&runtime(), "messages:list", &args()).unwrap();
        let Some(Value::Object(request)) = out.get("request") else {
            panic!("one-shot live pull must carry a protocol request");
        };
        assert_eq!(request.get("kind"), Some(&Value::from("live")));
        assert_eq!(
            request.get("functionName"),
            Some(&Value::from("messages:list"))
        );
        assert_eq!(
            request.get("args"),
            Some(&Value::Object(BTreeMap::from([(
                "channel".to_owned(),
                Value::from("live")
            )])))
        );
        assert!(request.contains_key("runtime"));
    }

    #[test]
    fn decode_reads_snapshot_page() {
        let value = Value::try_from(serde_json::json!({
            "members": [{ "table": "messages", "rowId": "m1" }],
            "changes": [
                { "plainHash": "h1", "op": "put", "table": "messages", "rowId": "m1", "fields": { "text": "hi" } },
                { "plainHash": "h2", "op": "del", "table": "messages", "rowId": "m2" },
            ],
            "crdt": [],
        }))
        .unwrap();
        let page = decode(value).unwrap();
        assert_eq!(
            page.members,
            vec![PullMember {
                table: "messages".to_owned(),
                id: "m1".to_owned(),
            }]
        );
        assert_eq!(page.changes.len(), 2);
        let PullChangeBody::Row(first) = &page.changes[0].body;
        assert_eq!(first.op, RowChangeOp::Write);
        let PullChangeBody::Row(second) = &page.changes[1].body;
        assert_eq!(second.op, RowChangeOp::Delete);
        assert!(second.row.is_none());
    }

    #[test]
    fn decode_reads_a_crdt_change() {
        let value = Value::try_from(serde_json::json!({
            "members": [{ "table": "documents", "rowId": "d1" }],
            "changes": [],
            "crdt": [
                { "table": "documents", "rowId": "d1", "field": "body", "kind": "text",
                  "epoch": 2, "headSeq": 9, "projectionHash": "hash-9",
                  "checkpointRequest": { "checkpointId": "c1", "responseToken": "token", "throughSeq": 9, "projectionHash": "hash-9" },
                  "checkpoint": { "id": "ready-1", "seq": 8, "bytes": 2, "hash": "checkpoint-hash" },
                  "payload": { "seq": 9, "bytes": { "$bytes": "Aw==" }, "hash": "payload-hash" } },
            ],
        }))
        .unwrap();
        let page = decode(value).unwrap();
        assert!(page.changes.is_empty());
        assert_eq!(page.crdt.len(), 1);
        let crdt = &page.crdt[0];
        assert_eq!(crdt.table, "documents");
        assert_eq!(crdt.id, "d1");
        assert_eq!(crdt.field, "body");
        assert_eq!(crdt.kind, CrdtFieldKind::Text);
        assert_eq!(crdt.epoch, 2);
        assert_eq!(crdt.checkpoint.seq, 8);
        assert_eq!(crdt.head_seq, 9);
        assert_eq!(crdt.projection_hash, "hash-9");
        assert_eq!(crdt.checkpoint.id, "ready-1");
        assert_eq!(crdt.checkpoint.bytes, 2);
        assert_eq!(crdt.checkpoint.hash, "checkpoint-hash");
        assert_eq!(crdt.payload.as_ref().map(|payload| payload.seq), Some(9));
        assert_eq!(
            crdt.payload
                .as_ref()
                .map(|payload| payload.bytes.as_slice()),
            Some([3u8].as_slice())
        );
        assert_eq!(
            crdt.checkpoint_request,
            Some(CrdtCheckpointRequest {
                checkpoint_id: "c1".to_owned(),
                response_token: "token".to_owned(),
                through_seq: 9,
                projection_hash: "hash-9".to_owned(),
            })
        );
    }

    #[test]
    fn decode_reads_a_bounded_checkpoint_page() {
        let value = Value::try_from(serde_json::json!({
            "checkpoint": { "id": "ready-1", "seq": 8, "bytes": 3, "hash": "whole" },
            "headSeq": 9,
            "chunks": [{ "ordinal": 0, "bytes": { "$bytes": "AQI=" }, "hash": "chunk" }],
            "payloads": [],
            "continueCursor": "payload:8",
            "isDone": false,
        }))
        .unwrap();
        let CheckpointResult::Page(page) = decode_checkpoint_page(value).unwrap() else {
            panic!("expected a checkpoint page");
        };
        assert_eq!(page.checkpoint.id, "ready-1");
        assert_eq!(page.chunks[0].ordinal, 0);
        assert_eq!(page.chunks[0].bytes, vec![1, 2]);
        assert_eq!(page.head_seq, 9);
        assert_eq!(page.continue_cursor.as_deref(), Some("payload:8"));
        assert!(!page.is_done);
    }

    #[test]
    fn decode_reads_a_stale_checkpoint_outcome() {
        let value = Value::try_from(serde_json::json!({ "kind": "stale" })).unwrap();
        assert_eq!(
            decode_checkpoint_page(value).unwrap(),
            CheckpointResult::Stale
        );
    }

    #[test]
    fn cursor_request_and_result_keep_the_exact_boundary() {
        let request = cursor_args(
            &runtime(),
            "messages:page",
            &serde_json::json!({
                "paginationOpts": { "cursor": null, "numItems": 1 }
            }),
            "/paginationOpts/cursor",
            &serde_json::json!({
                "rowId": "hosted-boundary",
                "values": [{ "field": "_id", "value": "hosted-boundary" }]
            }),
            Some("hosted-cursor"),
        )
        .unwrap();
        let Some(Value::Object(request)) = request.get("request") else {
            panic!("cursor args must contain a request object");
        };
        assert_eq!(request.get("kind"), Some(&Value::from("cursor")));
        assert!(matches!(request.get("boundary"), Some(Value::Object(_))));
        assert_eq!(request.get("cursor"), Some(&Value::from("hosted-cursor")));

        let result = Value::try_from(serde_json::json!({
            "found": true,
            "cursor": "resolved-cursor",
            "isDone": false,
        }))
        .unwrap();
        assert_eq!(
            decode_cursor(result).unwrap(),
            CursorPage {
                found: true,
                cursor: Some("resolved-cursor".to_owned()),
                is_done: false,
            }
        );
    }

    #[test]
    fn decode_reads_the_retained_result_and_its_rows() {
        let value = Value::try_from(serde_json::json!({
            "members": [{ "table": "documents", "rowId": "j57" }],
            "changes": [],
            "crdt": [],
            "result": { "latest": null, "total": 42 },
            "resultRows": [{ "path": "/latest", "table": "documents", "rowId": "j57" }],
        }))
        .unwrap();
        let result = decode(value).unwrap().result.unwrap();
        let Value::Object(skeleton) = &result.skeleton else {
            panic!("skeleton must be an object");
        };
        assert_eq!(skeleton.get("latest"), Some(&Value::Null));
        assert_eq!(skeleton.get("total"), Some(&Value::Float64(42.0)));
        assert_eq!(
            result.rows,
            vec![PullResultRow {
                path: "/latest".to_owned(),
                table: "documents".to_owned(),
                row_id: "j57".to_owned(),
            }]
        );
    }

    #[test]
    fn decode_treats_an_absent_result_as_no_cache_write() {
        let value = Value::try_from(serde_json::json!({
            "members": [{ "table": "documents", "rowId": "j57" }],
            "changes": [],
            "crdt": [],
        }))
        .unwrap();
        assert_eq!(decode(value).unwrap().result, None);
    }

    #[test]
    fn decode_keeps_a_present_scalar_result_with_no_rows() {
        let value = Value::try_from(serde_json::json!({
            "members": [],
            "changes": [],
            "crdt": [],
            "result": 42,
        }))
        .unwrap();
        let result = decode(value).unwrap().result.unwrap();
        assert_eq!(result.skeleton, Value::Float64(42.0));
        assert!(result.rows.is_empty());
    }

    #[test]
    fn decode_rejects_a_result_without_membership() {
        let value = Value::try_from(serde_json::json!({
            "reseed": true,
            "changes": [],
            "crdt": [],
        }))
        .unwrap();
        assert!(decode(value)
            .unwrap_err()
            .to_string()
            .contains("members must be an array"));
    }

    #[test]
    fn decode_rejects_a_crdt_result_without_a_checkpoint() {
        let value = Value::try_from(serde_json::json!({
            "members": [{ "table": "documents", "rowId": "d1" }],
            "changes": [],
            "crdt": [{
                "table": "documents", "rowId": "d1", "field": "body", "kind": "text",
                "epoch": 0, "checkpointSeq": 1, "headSeq": 1, "projectionHash": "hash-1",
            }],
        }))
        .unwrap();
        assert!(decode(value)
            .unwrap_err()
            .to_string()
            .contains("checkpoint manifest must be an object"));
    }
}
