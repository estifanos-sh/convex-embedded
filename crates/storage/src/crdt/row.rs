use std::collections::HashSet;

use loro::{
    Container, ExportMode, Frontiers, LoroCounter, LoroDoc, LoroMap, LoroText, LoroValue,
    ValueOrContainer,
};
use serde_json::{Map as JsonMap, Value as JsonValue};

use crate::error::StorageError;
use crate::types::{
    ColValue, CrdtFieldKind, CrdtOp, CrdtOperation, RevLifecycle, RevState, RowKey, TableDef,
};

const ROOT: &str = "row";
const DELETED: &str = "deleted";
const FIELDS: &str = "fields";
const CREATION_TIME: &str = "creationTime";
const JSON_LEAF: &str = "$embedded_json";
const SET_MARKER: &str = "$embedded_set";

pub(crate) fn projection_to_state(
    row: &RowKey,
    table: Option<&TableDef>,
    projection: Option<&str>,
    now_ms: i64,
) -> Result<RevState, StorageError> {
    let doc = LoroDoc::new();
    let root = doc.get_map(ROOT);
    match projection {
        Some(json) => {
            root.insert(DELETED, false).map_err(loro_error)?;
            let materialized = parse_json_object(json)?;
            let fields = fields_map(&root)?;
            write_fields(&fields, &materialized, table, &[])?;
            if let Some(value) = materialized.get("_creationTime") {
                root.insert(CREATION_TIME, json_to_loro_field(value)?)
                    .map_err(loro_error)?;
            }
        }
        None => {
            root.insert(DELETED, true).map_err(loro_error)?;
        }
    }
    doc.commit();
    Ok(RevState {
        frontier: doc.state_frontiers().encode(),
        key: crate::types::RevKey {
            rev_id: "main".to_owned(),
            row: row.clone(),
        },
        snapshot: doc.export(ExportMode::snapshot()).map_err(loro_error)?,
        log: Vec::new(),
        lifecycle: RevLifecycle::Current,
        updated_time: now_ms,
    })
}

fn doc_from_state(state: Option<&RevState>, peer_id: Option<u64>) -> Result<LoroDoc, StorageError> {
    let doc = LoroDoc::new();
    if let Some(peer_id) = peer_id {
        doc.set_peer_id(peer_id).map_err(loro_error)?;
    }
    if let Some(state) = state {
        if !state.snapshot.is_empty() {
            doc.import(&state.snapshot).map_err(loro_error)?;
        }
        for delta in &state.log {
            doc.import(delta).map_err(loro_error)?;
        }
        if !state.frontier.is_empty() {
            let frontier = Frontiers::decode(&state.frontier).map_err(loro_error)?;
            doc.checkout(&frontier).map_err(loro_error)?;
            doc.checkout_to_latest();
        }
    }
    Ok(doc)
}

fn fields_map(root: &LoroMap) -> Result<LoroMap, StorageError> {
    match root.get(FIELDS) {
        Some(ValueOrContainer::Container(Container::Map(map))) => Ok(map),
        Some(_) => Err(StorageError::Decode {
            expected: "loro row fields map",
            index: 0,
            got: "non-map fields".to_owned(),
        }),
        None => root
            .insert_container(FIELDS, LoroMap::new())
            .map_err(loro_error),
    }
}

fn write_fields(
    fields: &LoroMap,
    data: &JsonMap<String, JsonValue>,
    table: Option<&TableDef>,
    crdt_ops: &[CrdtOp],
) -> Result<(), StorageError> {
    write_fields_at(fields, data, table, crdt_ops, "")
}

fn write_fields_at(
    fields: &LoroMap,
    data: &JsonMap<String, JsonValue>,
    table: Option<&TableDef>,
    crdt_ops: &[CrdtOp],
    prefix: &str,
) -> Result<(), StorageError> {
    let mut existing_keys = Vec::new();
    fields.for_each(|key, _| existing_keys.push(key.to_owned()));
    for key in existing_keys {
        if !data.contains_key(&key) || is_system_field(&key) {
            fields.delete(&key).map_err(loro_error)?;
        }
    }
    for (key, value) in data {
        if is_system_field(key) {
            continue;
        }
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        if let Some(kind) = crdt_field_kind(table, &path) {
            let field_ops = crdt_ops_for_field(crdt_ops, &path);
            if !field_ops.is_empty() {
                if has_crdt_container(fields, key, kind) {
                    ensure_crdt_container(fields, key, kind)?;
                } else {
                    let seed = crdt_seed_value(value, kind, &field_ops)?;
                    write_crdt_field(fields, key, &seed, kind)?;
                }
                continue;
            }
            write_crdt_field(fields, key, value, kind)?;
            continue;
        }
        if has_crdt_descendant(table, &path) {
            if let JsonValue::Object(object) = value {
                let child = ensure_mergeable_map(fields, key)?;
                write_fields_at(&child, object, table, crdt_ops, &path)?;
                continue;
            }
        }
        let next = json_to_loro_field(value)?;
        if fields
            .get(key)
            .is_some_and(|current| current.get_deep_value() == next)
        {
            continue;
        }
        fields.insert(key, next).map_err(loro_error)?;
    }
    Ok(())
}

fn ensure_crdt_container(
    fields: &LoroMap,
    key: &str,
    kind: CrdtFieldKind,
) -> Result<(), StorageError> {
    match kind {
        CrdtFieldKind::Count => ensure_mergeable_counter(fields, key).map(|_| ()),
        CrdtFieldKind::Set => ensure_mergeable_set(fields, key).map(|_| ()),
        CrdtFieldKind::Text => ensure_mergeable_text(fields, key).map(|_| ()),
    }
}

fn has_crdt_container(fields: &LoroMap, key: &str, kind: CrdtFieldKind) -> bool {
    let Some(value) = fields.get(key) else {
        return false;
    };
    match (kind, value.into_container()) {
        (CrdtFieldKind::Count, Ok(Container::Counter(_)))
        | (CrdtFieldKind::Text, Ok(Container::Text(_))) => true,
        (CrdtFieldKind::Set, Ok(Container::Map(map))) => map
            .get(SET_MARKER)
            .is_some_and(|value| matches!(value.get_deep_value(), LoroValue::Bool(true))),
        _ => false,
    }
}

fn crdt_ops_for_field<'a>(ops: &'a [CrdtOp], field: &str) -> Vec<&'a CrdtOp> {
    ops.iter().filter(|op| op.field == field).collect()
}

fn crdt_seed_value(
    target: &JsonValue,
    kind: CrdtFieldKind,
    ops: &[&CrdtOp],
) -> Result<JsonValue, StorageError> {
    match kind {
        CrdtFieldKind::Count => {
            let target = target.as_f64().ok_or_else(|| StorageError::Decode {
                expected: "embedded count number",
                index: 0,
                got: target.to_string(),
            })?;
            let delta = ops.iter().fold(0.0, |sum, op| match op.operation {
                CrdtOperation::CountAdd { delta } => sum + delta,
                _ => sum,
            });
            serde_json::Number::from_f64(target - delta)
                .map(JsonValue::Number)
                .ok_or_else(|| StorageError::Decode {
                    expected: "finite embedded count number",
                    index: 0,
                    got: (target - delta).to_string(),
                })
        }
        CrdtFieldKind::Set => {
            let JsonValue::Array(target) = target else {
                return Err(StorageError::Decode {
                    expected: "embedded set array",
                    index: 0,
                    got: target.to_string(),
                });
            };
            let mut seed = target.clone();
            for op in ops.iter().rev() {
                match &op.operation {
                    CrdtOperation::SetAdd { value_json } => {
                        let value = parse_json_value(value_json)?;
                        seed.retain(|member| member != &value);
                    }
                    CrdtOperation::SetDelete { value_json } => {
                        let value = parse_json_value(value_json)?;
                        if !seed.iter().any(|member| member == &value) {
                            seed.push(value);
                        }
                    }
                    _ => {}
                }
            }
            Ok(JsonValue::Array(seed))
        }
        CrdtFieldKind::Text => {
            let mut seed = target
                .as_str()
                .ok_or_else(|| StorageError::Decode {
                    expected: "embedded text string",
                    index: 0,
                    got: target.to_string(),
                })?
                .to_owned();
            for op in ops.iter().rev() {
                let CrdtOperation::TextSplice {
                    index,
                    delete,
                    insert,
                } = &op.operation
                else {
                    continue;
                };
                if *delete > 0 {
                    return Err(StorageError::Unsatisfiable(
                        "cannot reconstruct text CRDT base for a delete without a CRDT container"
                            .to_owned(),
                    ));
                }
                if insert.is_empty() {
                    continue;
                }
                let index = usize::try_from(*index).map_err(|_| StorageError::Decode {
                    expected: "nonnegative text splice index",
                    index: 0,
                    got: index.to_string(),
                })?;
                seed = remove_text_range(&seed, index, insert.chars().count())?;
            }
            Ok(JsonValue::String(seed))
        }
    }
}

fn crdt_field_kind(table: Option<&TableDef>, field: &str) -> Option<CrdtFieldKind> {
    table?
        .crdt_fields
        .iter()
        .find(|candidate| candidate.field == field)
        .map(|field| field.kind)
}

fn has_crdt_descendant(table: Option<&TableDef>, prefix: &str) -> bool {
    let Some(table) = table else {
        return false;
    };
    let prefix = format!("{prefix}.");
    table
        .crdt_fields
        .iter()
        .any(|field| field.field.starts_with(&prefix))
}

fn write_crdt_field(
    fields: &LoroMap,
    key: &str,
    value: &JsonValue,
    kind: CrdtFieldKind,
) -> Result<(), StorageError> {
    match kind {
        CrdtFieldKind::Count => write_count_field(fields, key, value),
        CrdtFieldKind::Set => write_set_field(fields, key, value),
        CrdtFieldKind::Text => write_text_field(fields, key, value),
    }
}

fn write_count_field(fields: &LoroMap, key: &str, value: &JsonValue) -> Result<(), StorageError> {
    let target = value.as_f64().ok_or_else(|| StorageError::Decode {
        expected: "embedded count number",
        index: 0,
        got: value.to_string(),
    })?;
    let counter = ensure_mergeable_counter(fields, key)?;
    let delta = target - counter.get();
    if delta > 0.0 {
        counter.increment(delta).map_err(loro_error)?;
    } else if delta < 0.0 {
        counter.decrement(-delta).map_err(loro_error)?;
    }
    Ok(())
}

fn write_text_field(fields: &LoroMap, key: &str, value: &JsonValue) -> Result<(), StorageError> {
    let target = value.as_str().ok_or_else(|| StorageError::Decode {
        expected: "embedded text string",
        index: 0,
        got: value.to_string(),
    })?;
    let text = ensure_mergeable_text(fields, key)?;
    replace_text_contents(&text, target)
}

fn write_set_field(fields: &LoroMap, key: &str, value: &JsonValue) -> Result<(), StorageError> {
    let JsonValue::Array(target) = value else {
        return Err(StorageError::Decode {
            expected: "embedded set array",
            index: 0,
            got: value.to_string(),
        });
    };
    let set = ensure_mergeable_set(fields, key)?;
    let target_keys = target
        .iter()
        .map(set_member_key)
        .collect::<Result<HashSet<_>, _>>()?;
    let mut current_keys = Vec::new();
    set.for_each(|member_key, _| {
        if member_key != SET_MARKER {
            current_keys.push(member_key.to_owned());
        }
    });
    for member_key in current_keys {
        if !target_keys.contains(&member_key) {
            set.delete(&member_key).map_err(loro_error)?;
        }
    }
    for member in target {
        set.insert(&set_member_key(member)?, json_to_loro_field(member)?)
            .map_err(loro_error)?;
    }
    Ok(())
}

fn replace_text_contents(text: &LoroText, target: &str) -> Result<(), StorageError> {
    let current = text.to_string();
    if current == target {
        return Ok(());
    }
    let prefix = common_prefix_chars(&current, target);
    let suffix = common_suffix_chars(&current, target, prefix);
    let current_len = current.chars().count();
    let target_len = target.chars().count();
    let delete_len = current_len.saturating_sub(prefix + suffix);
    if delete_len > 0 {
        text.delete(prefix, delete_len).map_err(loro_error)?;
    }
    let insert_len = target_len.saturating_sub(prefix + suffix);
    if insert_len > 0 {
        let insert = target
            .chars()
            .skip(prefix)
            .take(insert_len)
            .collect::<String>();
        text.insert(prefix, &insert).map_err(loro_error)?;
    }
    Ok(())
}

fn remove_text_range(value: &str, index: usize, count: usize) -> Result<String, StorageError> {
    let mut chars = value.chars();
    let mut out = String::with_capacity(value.len());
    for _ in 0..index {
        let Some(ch) = chars.next() else {
            return Err(StorageError::Decode {
                expected: "text range start inside string",
                index: 0,
                got: value.to_owned(),
            });
        };
        out.push(ch);
    }
    for _ in 0..count {
        if chars.next().is_none() {
            return Err(StorageError::Decode {
                expected: "text range end inside string",
                index: 0,
                got: value.to_owned(),
            });
        }
    }
    out.extend(chars);
    Ok(out)
}

fn common_prefix_chars(left: &str, right: &str) -> usize {
    left.chars()
        .zip(right.chars())
        .take_while(|(left, right)| left == right)
        .count()
}

fn common_suffix_chars(left: &str, right: &str, prefix: usize) -> usize {
    let left_remaining = left.chars().count().saturating_sub(prefix);
    let right_remaining = right.chars().count().saturating_sub(prefix);
    left.chars()
        .rev()
        .zip(right.chars().rev())
        .take(left_remaining.min(right_remaining))
        .take_while(|(left, right)| left == right)
        .count()
}

fn ensure_mergeable_counter(fields: &LoroMap, key: &str) -> Result<LoroCounter, StorageError> {
    if let Ok(counter) = fields.ensure_mergeable_counter(key) {
        Ok(counter)
    } else {
        fields.delete(key).map_err(loro_error)?;
        fields.ensure_mergeable_counter(key).map_err(loro_error)
    }
}

fn ensure_mergeable_set(fields: &LoroMap, key: &str) -> Result<LoroMap, StorageError> {
    let set = ensure_mergeable_map(fields, key)?;
    let marked = set
        .get(SET_MARKER)
        .is_some_and(|value| matches!(value.get_deep_value(), LoroValue::Bool(true)));
    if !marked {
        clear_fields(&set)?;
        set.insert(SET_MARKER, true).map_err(loro_error)?;
    }
    Ok(set)
}

fn ensure_mergeable_map(fields: &LoroMap, key: &str) -> Result<LoroMap, StorageError> {
    if let Ok(map) = fields.ensure_mergeable_map(key) {
        Ok(map)
    } else {
        fields.delete(key).map_err(loro_error)?;
        fields.ensure_mergeable_map(key).map_err(loro_error)
    }
}

fn ensure_mergeable_text(fields: &LoroMap, key: &str) -> Result<LoroText, StorageError> {
    if let Ok(text) = fields.ensure_mergeable_text(key) {
        Ok(text)
    } else {
        fields.delete(key).map_err(loro_error)?;
        fields.ensure_mergeable_text(key).map_err(loro_error)
    }
}

fn is_system_field(key: &str) -> bool {
    key == "_id" || key == "_creationTime"
}

fn clear_fields(fields: &LoroMap) -> Result<(), StorageError> {
    let mut keys = Vec::new();
    fields.for_each(|key, _| keys.push(key.to_owned()));
    for key in keys {
        fields.delete(&key).map_err(loro_error)?;
    }
    Ok(())
}

/// Materialize the visible row JSON (`{_id, _creationTime, ...fields}`) from a ref's Loro state,
/// or `None` if the ref is a tombstone. Total + deterministic for any ref (including bare
/// fork/import revs) because `_creationTime` lives in a Loro register, not a separate row.
pub(crate) fn rev_doc_read(
    state: &RevState,
    document_id: &str,
) -> Result<Option<String>, StorageError> {
    let doc = doc_from_state(Some(state), None)?;
    let LoroValue::Map(root) = doc.get_map(ROOT).get_deep_value() else {
        return Ok(None);
    };
    if matches!(root.get(DELETED), Some(LoroValue::Bool(true))) {
        return Ok(None);
    }
    let mut json = serde_json::Map::new();
    if let Some(LoroValue::Map(fields)) = root.get(FIELDS) {
        for (key, value) in fields.iter() {
            json.insert(key.clone(), loro_value_to_json(value)?);
        }
    }
    json.insert("_id".to_owned(), JsonValue::String(document_id.to_owned()));
    if let Some(value) = root.get(CREATION_TIME) {
        json.insert("_creationTime".to_owned(), loro_value_to_json(value)?);
    }
    serde_json::to_string(&JsonValue::Object(json))
        .map(Some)
        .map_err(|e| json_error(&e))
}

pub(crate) fn extract_cols(
    table: &TableDef,
    data: &JsonMap<String, JsonValue>,
) -> Result<Vec<(String, ColValue)>, StorageError> {
    table
        .columns
        .iter()
        .map(|column| {
            let field = column.field.as_ref().unwrap_or(&column.name);
            Ok((column.name.clone(), json_to_col(read_field(data, field))?))
        })
        .collect()
}

fn read_field<'a>(data: &'a JsonMap<String, JsonValue>, field: &str) -> Option<&'a JsonValue> {
    let mut current = None;
    for (index, segment) in field.split('.').enumerate() {
        current = if index == 0 {
            data.get(segment)
        } else {
            current?.as_object()?.get(segment)
        };
    }
    current
}

fn json_to_col(value: Option<&JsonValue>) -> Result<ColValue, StorageError> {
    let Some(value) = value else {
        return Ok(ColValue::Undefined);
    };
    match value {
        JsonValue::Null => Ok(ColValue::Null),
        JsonValue::Bool(value) => Ok(ColValue::Bool(*value)),
        JsonValue::String(value) => Ok(ColValue::Text(value.clone())),
        JsonValue::Number(value) => {
            if let Some(n) = value.as_i64() {
                Ok(ColValue::Integer(n))
            } else if let Some(n) = value.as_f64() {
                Ok(ColValue::Real(n))
            } else {
                Err(StorageError::Decode {
                    expected: "number",
                    index: 0,
                    got: value.to_string(),
                })
            }
        }
        JsonValue::Object(value) => {
            if let Some(JsonValue::String(integer)) = value.get("$integer") {
                return decode_i64_base64(integer).map(ColValue::Integer);
            }
            if let Some(JsonValue::String(real)) = value.get("$float") {
                return decode_f64_base64(real).map(ColValue::Real);
            }
            Err(StorageError::Unsatisfiable(
                "indexed column value is not scalar".to_owned(),
            ))
        }
        JsonValue::Array(_) => Err(StorageError::Unsatisfiable(
            "indexed column value is not scalar".to_owned(),
        )),
    }
}

/// A stable, content-addressed ref id (`<prefix>:<hash>`). Re-deriving from the same state yields
/// the same id (idempotent); distinct states get distinct ids.
fn content_rev_id(prefix: &str, frontier: &[u8]) -> String {
    let digest = sha256_prefixed([frontier]);
    format!("{prefix}:{}", &digest[7..23])
}

/// Rev id for an archived copy of a ref's state (a reset loser).
pub(crate) fn archive_rev_id(frontier: &[u8]) -> String {
    content_rev_id("archive", frontier)
}

#[path = "value.rs"]
mod value;
pub(crate) use value::canonical_json;
use value::{
    decode_f64_base64, decode_i64_base64, json_error, json_to_loro_field, loro_error,
    loro_value_to_json, parse_json_object, parse_json_value, set_member_key, sha256_prefixed,
};

#[path = "field.rs"]
mod field;

pub use field::crdt_checkpoint_response;
pub(crate) use field::{
    crdt_field_accept, crdt_field_accept_incremental, crdt_field_apply, crdt_field_merge,
    crdt_field_projection_hash, crdt_field_reject, crdt_field_remote_effect, crdt_field_restore,
    crdt_field_settle, crdt_field_snapshot, crdt_field_value, CrdtAcceptedState, CrdtFieldState,
    SEED_PEER,
};
