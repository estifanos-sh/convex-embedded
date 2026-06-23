use convex::Value;

use crate::{RemoteError, RemoteResult};

pub(crate) fn expect_string(value: &Value, field: &'static str) -> RemoteResult<String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        other => Err(RemoteError::Protocol(format!(
            "{field} must be a string, got {other:?}"
        ))),
    }
}

pub(crate) fn expect_integral_number(value: &Value, field: &'static str) -> RemoteResult<i64> {
    match value {
        Value::Int64(value) => Ok(*value),
        Value::Float64(value)
            if value.is_finite()
                && value.fract() == 0.0
                && *value >= i64::MIN as f64
                && *value <= i64::MAX as f64 =>
        {
            Ok(*value as i64)
        }
        other => Err(RemoteError::Protocol(format!(
            "{field} must be an integral number, got {other:?}"
        ))),
    }
}

pub(crate) fn row_json_string(
    fields: &Value,
    server_doc_id: String,
    creation_time: Option<&Value>,
) -> RemoteResult<String> {
    let serde_json::Value::Object(mut json) = serde_json::Value::from(fields.clone()) else {
        return Err(RemoteError::Protocol(format!(
            "projection fields must be an object, got {fields:?}"
        )));
    };
    json.insert("_id".to_owned(), serde_json::Value::String(server_doc_id));
    if let Some(value) = creation_time {
        json.insert(
            "_creationTime".to_owned(),
            serde_json::Value::from(value.clone()),
        );
    }
    serde_json::to_string(&json)
        .map_err(|e| RemoteError::Protocol(format!("invalid projection JSON: {e}")))
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}
