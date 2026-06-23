use std::collections::{BTreeMap, HashMap};

use loro::LoroValue;
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};

use super::{JSON_LEAF, SET_MARKER};
use crate::error::StorageError;

pub(super) fn parse_json_object(value: &str) -> Result<JsonMap<String, JsonValue>, StorageError> {
    match serde_json::from_str::<JsonValue>(value).map_err(|e| json_error(&e))? {
        JsonValue::Object(map) => Ok(map),
        value => Err(StorageError::Decode {
            expected: "json object",
            index: 0,
            got: value.to_string(),
        }),
    }
}

pub(super) fn parse_json_value(value: &str) -> Result<JsonValue, StorageError> {
    serde_json::from_str::<JsonValue>(value).map_err(|e| json_error(&e))
}

pub(super) fn json_to_loro_field(value: &JsonValue) -> Result<LoroValue, StorageError> {
    Ok(match value {
        JsonValue::Null => LoroValue::Null,
        JsonValue::Bool(value) => LoroValue::Bool(*value),
        JsonValue::String(value) => LoroValue::String(value.clone().into()),
        JsonValue::Number(value) => {
            if let Some(n) = value.as_i64() {
                LoroValue::I64(n)
            } else if let Some(n) = value.as_f64() {
                LoroValue::Double(n)
            } else {
                return Err(StorageError::Decode {
                    expected: "number",
                    index: 0,
                    got: value.to_string(),
                });
            }
        }
        JsonValue::Array(_) | JsonValue::Object(_) => {
            let mut tagged = HashMap::new();
            tagged.insert(
                JSON_LEAF.to_owned(),
                LoroValue::String(
                    serde_json::to_string(&canonical_json(value))
                        .map_err(|e| json_error(&e))?
                        .into(),
                ),
            );
            LoroValue::from(tagged)
        }
    })
}

pub(super) fn set_member_key(value: &JsonValue) -> Result<String, StorageError> {
    let canonical = serde_json::to_string(&canonical_json(value)).map_err(|e| json_error(&e))?;
    Ok(sha256_prefixed([canonical.as_bytes()]))
}

/// Inverse of `json_to_loro_field`: decode a stored Loro field value back to JSON, unwrapping the
/// `$embedded_json` tag used for arrays and nested objects.
pub(super) fn loro_value_to_json(value: &LoroValue) -> Result<JsonValue, StorageError> {
    Ok(match value {
        LoroValue::Bool(value) => JsonValue::Bool(*value),
        LoroValue::I64(value) => JsonValue::Number((*value).into()),
        LoroValue::Double(value) => {
            serde_json::Number::from_f64(*value).map_or(JsonValue::Null, JsonValue::Number)
        }
        LoroValue::String(value) => JsonValue::String(value.to_string()),
        LoroValue::List(items) => JsonValue::Array(
            items
                .iter()
                .map(loro_value_to_json)
                .collect::<Result<_, _>>()?,
        ),
        LoroValue::Map(map) => {
            if let Some(LoroValue::String(json)) = map.get(JSON_LEAF) {
                serde_json::from_str(json.as_str()).map_err(|e| json_error(&e))?
            } else if matches!(map.get(SET_MARKER), Some(LoroValue::Bool(true))) {
                let mut members = map
                    .iter()
                    .filter(|(key, _)| key.as_str() != SET_MARKER)
                    .map(|(key, value)| Ok((key.clone(), loro_value_to_json(value)?)))
                    .collect::<Result<Vec<_>, StorageError>>()?;
                members.sort_by(|(left, _), (right, _)| left.cmp(right));
                JsonValue::Array(members.into_iter().map(|(_, value)| value).collect())
            } else {
                JsonValue::Object(
                    map.iter()
                        .map(|(key, value)| Ok((key.clone(), loro_value_to_json(value)?)))
                        .collect::<Result<serde_json::Map<_, _>, StorageError>>()?,
                )
            }
        }
        LoroValue::Null | LoroValue::Binary(_) | LoroValue::Container(_) => JsonValue::Null,
    })
}

pub(crate) fn sha256_prefixed<'a>(parts: impl IntoIterator<Item = &'a [u8]>) -> String {
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part);
    }
    format!("sha256:{}", hex(&hash.finalize()))
}

pub(super) fn loro_error(error: impl std::fmt::Display) -> StorageError {
    StorageError::Unsatisfiable(format!("loro: {error}"))
}

pub(super) fn json_error(error: &serde_json::Error) -> StorageError {
    StorageError::Unsatisfiable(format!("json: {error}"))
}

pub(crate) fn canonical_json(value: &JsonValue) -> JsonValue {
    match value {
        JsonValue::Array(values) => JsonValue::Array(values.iter().map(canonical_json).collect()),
        JsonValue::Object(fields) => {
            let mut sorted = BTreeMap::new();
            for (key, value) in fields {
                sorted.insert(key.clone(), canonical_json(value));
            }
            let mut out = JsonMap::new();
            for (key, value) in sorted {
                out.insert(key, value);
            }
            JsonValue::Object(out)
        }
        value => value.clone(),
    }
}

pub(super) fn decode_i64_base64(value: &str) -> Result<i64, StorageError> {
    let bytes = decode_base64_8(value, "base64 int64")?;
    Ok(i64::from_le_bytes(bytes))
}

pub(super) fn decode_f64_base64(value: &str) -> Result<f64, StorageError> {
    let bytes = decode_base64_8(value, "base64 float64")?;
    Ok(f64::from_le_bytes(bytes))
}

pub(super) fn decode_base64_8(
    value: &str,
    expected: &'static str,
) -> Result<[u8; 8], StorageError> {
    let bytes = base64::decode(value).map_err(|e| StorageError::Decode {
        expected,
        index: 0,
        got: e.to_string(),
    })?;
    bytes
        .try_into()
        .map_err(|bytes: Vec<u8>| StorageError::Decode {
            expected: "8 decoded bytes",
            index: 0,
            got: format!("{} bytes", bytes.len()),
        })
}

pub(super) fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut out, "{byte:02x}").expect("writing to a String never fails");
    }
    out
}
