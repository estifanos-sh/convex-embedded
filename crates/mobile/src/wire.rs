use serde::{de::DeserializeOwned, Serialize};

use crate::{BridgeError, BridgeResult};

#[derive(Debug)]
pub(crate) struct Request {
    pub operation: String,
    pub json: String,
    pub buffers: Vec<Vec<u8>>,
}

#[derive(Debug)]
pub(crate) struct Response {
    pub ok: bool,
    pub json: String,
    pub buffers: Vec<Vec<u8>>,
    pub error: Option<ResponseError>,
}

#[derive(Debug)]
pub(crate) struct ResponseError {
    pub code: String,
    pub message: String,
}

impl Response {
    pub(crate) fn value(value: &impl Serialize) -> BridgeResult<Self> {
        let mut value = serde_json::to_value(value)?;
        mark_unsafe_integers(&mut value);
        Ok(Self {
            ok: true,
            json: serde_json::to_string(&value)?,
            buffers: Vec::new(),
            error: None,
        })
    }

    pub(crate) fn bytes(value: Option<Vec<u8>>) -> Self {
        let (json, buffers) = value.map_or_else(
            || ("null".to_owned(), Vec::new()),
            |bytes| (r#"{"$buffer":0}"#.to_owned(), vec![bytes]),
        );
        Self {
            ok: true,
            json,
            buffers,
            error: None,
        }
    }

    pub(crate) fn with_buffers(
        value: &impl Serialize,
        buffers: Vec<Vec<u8>>,
    ) -> BridgeResult<Self> {
        let mut value = serde_json::to_value(value)?;
        mark_unsafe_integers(&mut value);
        Ok(Self {
            ok: true,
            json: serde_json::to_string(&value)?,
            buffers,
            error: None,
        })
    }

    pub(crate) fn failure(error: &BridgeError) -> Self {
        Self {
            ok: false,
            json: "null".to_owned(),
            buffers: Vec::new(),
            error: Some(ResponseError {
                code: error.code().to_owned(),
                message: error.to_string(),
            }),
        }
    }
}

pub(crate) fn decode_request(bytes: &[u8]) -> BridgeResult<Request> {
    let mut reader = Reader::new(bytes);
    let fields = reader.map_len()?;
    let mut bridge_contract_id = None;
    let mut operation = None;
    let mut json = None;
    let mut buffers = None;
    for _ in 0..fields {
        match reader.string()?.as_str() {
            "bridgeContractId" => bridge_contract_id = Some(reader.string()?),
            "operation" => operation = Some(reader.string()?),
            "json" => json = Some(reader.string()?),
            "buffers" => {
                let len = reader.array_len()?;
                let mut values = Vec::with_capacity(len);
                for _ in 0..len {
                    values.push(reader.binary()?);
                }
                buffers = Some(values);
            }
            other => {
                return Err(BridgeError::Protocol(format!(
                    "unknown request envelope field {other}"
                )));
            }
        }
    }
    if !reader.is_finished() {
        return Err(BridgeError::Protocol(
            "request envelope has trailing bytes".to_owned(),
        ));
    }
    let bridge_contract_id = bridge_contract_id
        .ok_or_else(|| BridgeError::Protocol("request bridge contract is missing".to_owned()))?;
    if bridge_contract_id != storage::CURRENT_MOBILE_BRIDGE_CONTRACT_ID {
        return Err(BridgeError::Protocol(format!(
            "mobile bridge contract mismatch; rebuild the native application"
        )));
    }
    Ok(Request {
        operation: operation
            .ok_or_else(|| BridgeError::Protocol("request operation is missing".to_owned()))?,
        json: json.ok_or_else(|| BridgeError::Protocol("request JSON is missing".to_owned()))?,
        buffers: buffers.unwrap_or_default(),
    })
}

pub(crate) fn encode_response(response: &Response) -> Vec<u8> {
    let mut bytes = Vec::new();
    map(&mut bytes, 5);
    string(&mut bytes, "ok");
    boolean(&mut bytes, response.ok);
    string(&mut bytes, "json");
    string(&mut bytes, &response.json);
    string(&mut bytes, "buffers");
    array(&mut bytes, response.buffers.len());
    for buffer in &response.buffers {
        binary(&mut bytes, buffer);
    }
    string(&mut bytes, "error");
    if let Some(error) = &response.error {
        map(&mut bytes, 2);
        string(&mut bytes, "code");
        string(&mut bytes, &error.code);
        string(&mut bytes, "message");
        string(&mut bytes, &error.message);
    } else {
        bytes.push(0xc0);
    }
    string(&mut bytes, "bridgeContractId");
    string(&mut bytes, storage::CURRENT_MOBILE_BRIDGE_CONTRACT_ID);
    bytes
}

#[cfg(test)]
pub(crate) fn encode_request(request: &Request) -> Vec<u8> {
    let mut bytes = Vec::new();
    map(&mut bytes, 4);
    string(&mut bytes, "bridgeContractId");
    string(&mut bytes, storage::CURRENT_MOBILE_BRIDGE_CONTRACT_ID);
    string(&mut bytes, "operation");
    string(&mut bytes, &request.operation);
    string(&mut bytes, "json");
    string(&mut bytes, &request.json);
    string(&mut bytes, "buffers");
    array(&mut bytes, request.buffers.len());
    for buffer in &request.buffers {
        binary(&mut bytes, buffer);
    }
    bytes
}

pub(crate) fn payload<T: DeserializeOwned>(request: &Request) -> BridgeResult<T> {
    let mut value: serde_json::Value = serde_json::from_str(&request.json)?;
    inflate(&mut value, &request.buffers)?;
    serde_json::from_value(value).map_err(BridgeError::from)
}

fn mark_unsafe_integers(value: &mut serde_json::Value) {
    const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                mark_unsafe_integers(value);
            }
        }
        serde_json::Value::Object(fields) => {
            for value in fields.values_mut() {
                mark_unsafe_integers(value);
            }
        }
        serde_json::Value::Number(number) => {
            let marker = number
                .as_i64()
                .filter(|integer| integer.unsigned_abs() > MAX_SAFE_INTEGER as u64)
                .map(|integer| integer.to_string())
                .or_else(|| {
                    number
                        .as_u64()
                        .filter(|integer| *integer > MAX_SAFE_INTEGER as u64)
                        .map(|integer| integer.to_string())
                });
            if let Some(integer) = marker {
                *value = serde_json::json!({"$integer": integer});
            }
        }
        _ => {}
    }
}

fn inflate(value: &mut serde_json::Value, buffers: &[Vec<u8>]) -> BridgeResult<()> {
    match value {
        serde_json::Value::Array(values) => {
            for value in values {
                inflate(value, buffers)?;
            }
        }
        serde_json::Value::Object(fields) => {
            if fields.len() == 1 {
                if let Some(index) = fields.get("$buffer").and_then(serde_json::Value::as_u64) {
                    let bytes = buffers.get(index as usize).ok_or_else(|| {
                        BridgeError::Protocol(format!("buffer index {index} is out of range"))
                    })?;
                    *value = serde_json::Value::Array(
                        bytes
                            .iter()
                            .copied()
                            .map(|byte| serde_json::Value::from(u64::from(byte)))
                            .collect(),
                    );
                    return Ok(());
                }
                if let Some(integer) = fields.get("$integer").and_then(serde_json::Value::as_str) {
                    let integer = integer.parse::<i64>().map_err(|error| {
                        BridgeError::Protocol(format!("invalid integer marker: {error}"))
                    })?;
                    *value = serde_json::Value::from(integer);
                    return Ok(());
                }
            }
            for value in fields.values_mut() {
                inflate(value, buffers)?;
            }
        }
        _ => {}
    }
    Ok(())
}

struct Reader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, cursor: 0 }
    }

    fn is_finished(&self) -> bool {
        self.cursor == self.bytes.len()
    }

    fn byte(&mut self) -> BridgeResult<u8> {
        let byte =
            self.bytes.get(self.cursor).copied().ok_or_else(|| {
                BridgeError::Protocol("truncated MessagePack envelope".to_owned())
            })?;
        self.cursor += 1;
        Ok(byte)
    }

    fn take(&mut self, len: usize) -> BridgeResult<&'a [u8]> {
        let end = self
            .cursor
            .checked_add(len)
            .ok_or_else(|| BridgeError::Protocol("MessagePack length overflow".to_owned()))?;
        let value = self
            .bytes
            .get(self.cursor..end)
            .ok_or_else(|| BridgeError::Protocol("truncated MessagePack envelope".to_owned()))?;
        self.cursor = end;
        Ok(value)
    }

    fn map_len(&mut self) -> BridgeResult<usize> {
        let tag = self.byte()?;
        match tag {
            0x80..=0x8f => Ok(usize::from(tag & 0x0f)),
            0xde => Ok(usize::from(self.u16()?)),
            0xdf => usize::try_from(self.u32()?)
                .map_err(|_| BridgeError::Protocol("map is too large".to_owned())),
            _ => Err(BridgeError::Protocol("expected MessagePack map".to_owned())),
        }
    }

    fn array_len(&mut self) -> BridgeResult<usize> {
        let tag = self.byte()?;
        match tag {
            0x90..=0x9f => Ok(usize::from(tag & 0x0f)),
            0xdc => Ok(usize::from(self.u16()?)),
            0xdd => usize::try_from(self.u32()?)
                .map_err(|_| BridgeError::Protocol("array is too large".to_owned())),
            _ => Err(BridgeError::Protocol(
                "expected MessagePack array".to_owned(),
            )),
        }
    }

    fn string(&mut self) -> BridgeResult<String> {
        let tag = self.byte()?;
        let len = match tag {
            0xa0..=0xbf => usize::from(tag & 0x1f),
            0xd9 => usize::from(self.byte()?),
            0xda => usize::from(self.u16()?),
            0xdb => usize::try_from(self.u32()?)
                .map_err(|_| BridgeError::Protocol("string is too large".to_owned()))?,
            _ => {
                return Err(BridgeError::Protocol(
                    "expected MessagePack string".to_owned(),
                ))
            }
        };
        std::str::from_utf8(self.take(len)?)
            .map(str::to_owned)
            .map_err(|error| {
                BridgeError::Protocol(format!("MessagePack string is not UTF-8: {error}"))
            })
    }

    fn binary(&mut self) -> BridgeResult<Vec<u8>> {
        let tag = self.byte()?;
        let len = match tag {
            0xc4 => usize::from(self.byte()?),
            0xc5 => usize::from(self.u16()?),
            0xc6 => usize::try_from(self.u32()?)
                .map_err(|_| BridgeError::Protocol("binary value is too large".to_owned()))?,
            _ => {
                return Err(BridgeError::Protocol(
                    "expected MessagePack binary".to_owned(),
                ))
            }
        };
        Ok(self.take(len)?.to_vec())
    }

    fn u16(&mut self) -> BridgeResult<u16> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().map_err(
            |_| BridgeError::Protocol("truncated u16".to_owned()),
        )?))
    }

    fn u32(&mut self) -> BridgeResult<u32> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().map_err(
            |_| BridgeError::Protocol("truncated u32".to_owned()),
        )?))
    }
}

fn map(bytes: &mut Vec<u8>, len: usize) {
    if len < 16 {
        bytes.push(0x80 | len as u8);
    } else {
        bytes.push(0xde);
        bytes.extend_from_slice(&(len as u16).to_be_bytes());
    }
}

fn array(bytes: &mut Vec<u8>, len: usize) {
    if len < 16 {
        bytes.push(0x90 | len as u8);
    } else if u16::try_from(len).is_ok() {
        bytes.push(0xdc);
        bytes.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        bytes.push(0xdd);
        bytes.extend_from_slice(&(len as u32).to_be_bytes());
    }
}

fn string(bytes: &mut Vec<u8>, value: &str) {
    let len = value.len();
    if len < 32 {
        bytes.push(0xa0 | len as u8);
    } else if u8::try_from(len).is_ok() {
        bytes.extend_from_slice(&[0xd9, len as u8]);
    } else if u16::try_from(len).is_ok() {
        bytes.push(0xda);
        bytes.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        bytes.push(0xdb);
        bytes.extend_from_slice(&(len as u32).to_be_bytes());
    }
    bytes.extend_from_slice(value.as_bytes());
}

fn binary(bytes: &mut Vec<u8>, value: &[u8]) {
    let len = value.len();
    if u8::try_from(len).is_ok() {
        bytes.extend_from_slice(&[0xc4, len as u8]);
    } else if u16::try_from(len).is_ok() {
        bytes.push(0xc5);
        bytes.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        bytes.push(0xc6);
        bytes.extend_from_slice(&(len as u32).to_be_bytes());
    }
    bytes.extend_from_slice(value);
}

fn boolean(bytes: &mut Vec<u8>, value: bool) {
    bytes.push(if value { 0xc3 } else { 0xc2 });
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::{decode_request, encode_request, payload, Request};

    #[derive(Deserialize)]
    struct Binary {
        bytes: Vec<u8>,
    }

    #[test]
    fn request_round_trips_and_inflates_binary_marker() {
        let encoded = encode_request(&Request {
            operation: "blobWrite".to_owned(),
            json: r#"{"bytes":{"$buffer":0}}"#.to_owned(),
            buffers: vec![vec![1, 2, 3]],
        });
        let request = decode_request(&encoded).expect("request should decode");
        let value: Binary = payload(&request).expect("binary marker should decode");
        assert_eq!(value.bytes, [1, 2, 3]);
    }

    #[test]
    fn request_rejects_a_foreign_bridge_contract() {
        let mut encoded = encode_request(&Request {
            operation: "setup".to_owned(),
            json: "[]".to_owned(),
            buffers: Vec::new(),
        });
        let expected = storage::CURRENT_MOBILE_BRIDGE_CONTRACT_ID.as_bytes();
        let start = encoded
            .windows(expected.len())
            .position(|window| window == expected)
            .expect("encoded bridge contract");
        encoded[start..start + expected.len()].fill(b'0');

        let error = decode_request(&encoded).expect_err("foreign bridge contract must fail");
        assert!(error.to_string().contains("rebuild the native application"));
    }

    #[test]
    fn payload_preserves_non_finite_float_bits() {
        let request = Request {
            operation: "commit".to_owned(),
            json: r#"{"real":{"$float":"fff0000000000000"}}"#.to_owned(),
            buffers: Vec::new(),
        };
        let value: crate::model::Scalar = payload(&request).expect("float marker should decode");
        assert_eq!(
            value.real.expect("real").to_bits(),
            f64::NEG_INFINITY.to_bits()
        );
    }
}
