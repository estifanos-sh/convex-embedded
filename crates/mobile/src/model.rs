use std::collections::BTreeMap;

use serde::{de, Deserialize, Deserializer, Serialize};

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum WireFloat {
    Number(f64),
    Bits {
        #[serde(rename = "$float")]
        bits: String,
    },
}

pub(crate) fn optional_float<'de, D>(deserializer: D) -> Result<Option<f64>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<WireFloat>::deserialize(deserializer)?.map_or(Ok(None), |value| match value {
        WireFloat::Number(value) => Ok(Some(value)),
        WireFloat::Bits { bits } => {
            if bits.len() != 16 || !bits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(de::Error::custom(
                    "float marker must contain 16 hexadecimal digits",
                ));
            }
            u64::from_str_radix(&bits, 16)
                .map(f64::from_bits)
                .map(Some)
                .map_err(de::Error::custom)
        }
    })
}

#[derive(Debug, Deserialize)]
pub(crate) struct Schema {
    pub hash: String,
    #[serde(default)]
    pub setup_hash: String,
    pub tables: Vec<Table>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Table {
    pub name: String,
    pub placement: String,
    pub columns: Vec<Column>,
    #[serde(default)]
    pub crdt_fields: Vec<CrdtField>,
    #[serde(default)]
    pub local_fields: Vec<LocalField>,
    pub indexes: Vec<Index>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Column {
    pub name: String,
    pub field: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CrdtField {
    pub field: String,
    pub kind: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LocalField {
    pub field: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Index {
    pub name: String,
    pub fields: Vec<String>,
    pub columns: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReadSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<Bound>>,
    pub order: String,
    pub page_size: Option<u32>,
    pub cursor: Option<String>,
    pub resume_after_key: Option<Vec<Scalar>>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct CountSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<Bound>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Bound {
    pub kind: String,
    pub value: Option<Scalar>,
    pub lower: Option<Scalar>,
    pub lower_inclusive: Option<bool>,
    pub upper: Option<Scalar>,
    pub upper_inclusive: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Scalar {
    pub text: Option<String>,
    #[serde(default, deserialize_with = "optional_float")]
    pub real: Option<f64>,
    pub int: Option<String>,
    #[serde(rename = "bool")]
    pub boolean: Option<bool>,
    pub undef: Option<bool>,
    #[serde(rename = "commitTs")]
    pub commit_ts: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteBatch {
    pub doc_writes: Vec<DocWrite>,
    pub deletes: Vec<Row>,
    #[serde(default)]
    pub local_field_writes: Vec<LocalFieldWrite>,
    #[serde(default)]
    pub local_field_deletes: Vec<LocalFieldDelete>,
    #[serde(default)]
    pub crdt_ops: Vec<CrdtOp>,
    #[serde(default)]
    pub crdt_restores: Vec<CrdtRestore>,
    #[serde(default)]
    pub fresh_ids: Vec<Row>,
    #[serde(default)]
    pub data_only_ids: Vec<Row>,
    #[serde(default)]
    pub id_mappings: Vec<IdMapping>,
    #[serde(default)]
    pub schedules: Vec<ScheduledJob>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocWrite {
    pub table: String,
    pub id: String,
    pub data: String,
    pub cols: Vec<ColValue>,
    pub creation_time: f64,
    pub pending_commit_ts: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct Row {
    pub table: String,
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalFieldWrite {
    pub table: String,
    pub id: String,
    pub field: String,
    pub value_json: String,
    pub pending_commit_ts: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct LocalFieldDelete {
    pub table: String,
    pub id: String,
    pub field: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ColValue {
    pub name: String,
    pub text: Option<String>,
    #[serde(default, deserialize_with = "optional_float")]
    pub real: Option<f64>,
    pub int: Option<String>,
    #[serde(rename = "bool")]
    pub boolean: Option<bool>,
    pub undef: Option<bool>,
    #[serde(rename = "commitTs")]
    pub commit_ts: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrdtOp {
    pub table: String,
    pub id: String,
    pub field: String,
    pub kind: String,
    pub delta: Option<f64>,
    pub value_json: Option<String>,
    pub index: Option<i64>,
    pub delete: Option<i64>,
    pub insert: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CrdtRestore {
    pub table: String,
    pub id: String,
    pub field: String,
    pub kind: String,
    pub head_seq: i64,
    pub projection_hash: String,
    pub bytes: Vec<u8>,
    pub hash: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdMapping {
    pub table: String,
    pub local_id: String,
    pub convex_id: Option<String>,
    pub state: String,
    pub created_time: i64,
    pub updated_time: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitOptions {
    pub commit_ts: Option<bool>,
    pub source: Option<String>,
    pub mutation_id: Option<String>,
    pub mutation_name: Option<String>,
    pub mutation_args: Option<String>,
    pub mutation_result: Option<String>,
    pub mutation_result_commit_ts: Option<bool>,
    pub push_envelope_json: Option<String>,
    pub push_envelope_now_ms: Option<f64>,
    pub push_after_images_commit_ts: Option<bool>,
    pub mutation_is_fresh: Option<bool>,
    pub include_changes: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MutationCall {
    pub args: String,
    pub mutation_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResultEntry {
    pub key: String,
    pub function: String,
    pub args: String,
    pub schema_hash: String,
    pub module_hash: String,
    pub skeleton: Vec<u8>,
    pub paths: Vec<u8>,
    pub skeleton_hash: String,
    pub clock: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileMetadata {
    pub storage_id: String,
    pub sha256: String,
    pub size: i64,
    pub content_type: Option<String>,
    pub source: Option<String>,
    pub created_time: i64,
    pub updated_time: i64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct FileStore {
    pub bytes: Vec<u8>,
    pub metadata: FileMetadata,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PendingUpload {
    pub local_storage_id: String,
    pub sha256: String,
    pub size: i64,
    pub content_type: Option<String>,
    pub state: String,
    pub owner: Option<String>,
    pub lease_until: Option<i64>,
    pub created_time: i64,
    pub updated_time: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UploadLeaseWrite {
    pub lease: String,
    pub local_storage_id: Option<String>,
    pub owner: String,
    pub now_ms: i64,
    pub lease_until: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduledJob {
    pub job_id: String,
    pub kind: String,
    pub name: String,
    pub args: String,
    pub due_time: i64,
    pub state: String,
    pub lease_until: Option<i64>,
    pub created_time: i64,
    pub updated_time: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    pub text: String,
    pub cursor: Option<String>,
    pub versions: BTreeMap<String, i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_fields_json: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::Page;
    use std::collections::BTreeMap;

    #[test]
    fn empty_page_overlay_is_omitted_from_the_wire_shape() {
        let value = serde_json::to_value(Page {
            text: "[]".to_owned(),
            cursor: None,
            versions: BTreeMap::new(),
            local_fields_json: None,
        })
        .expect("page should serialize");

        assert!(value.get("localFieldsJson").is_none());
    }
}
