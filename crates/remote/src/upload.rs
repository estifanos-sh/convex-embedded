use std::{collections::BTreeMap, future::Future, pin::Pin};

use convex::Value;
use storage::{PendingUpload, RuntimeWireIdentity};

use crate::{ConvexArgs, RemoteError, RemoteResult};

pub type RemoteUploadFuture<'a> =
    Pin<Box<dyn Future<Output = RemoteResult<RemoteUploadReceipt>> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteUploadRequest {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
    pub local_storage_id: String,
    pub sha256: String,
    pub size: i64,
    pub upload_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteUploadReceipt {
    pub storage_id: String,
}

pub trait RemoteUploader {
    fn upload(&mut self, request: RemoteUploadRequest) -> RemoteUploadFuture<'_>;
}

#[cfg(target_arch = "wasm32")]
#[derive(Default)]
pub struct UnavailableRemoteUploader;

#[cfg(target_arch = "wasm32")]
impl RemoteUploader for UnavailableRemoteUploader {
    fn upload(&mut self, _request: RemoteUploadRequest) -> RemoteUploadFuture<'_> {
        Box::pin(async {
            Err(RemoteError::InvalidConfig(
                "remote uploads require a native HTTP uploader or browser host fetch bridge"
                    .to_owned(),
            ))
        })
    }
}

#[cfg(not(target_arch = "wasm32"))]
#[derive(Clone, Default)]
pub struct HttpRemoteUploader {
    client: reqwest::Client,
}

#[cfg(not(target_arch = "wasm32"))]
impl RemoteUploader for HttpRemoteUploader {
    fn upload(&mut self, request: RemoteUploadRequest) -> RemoteUploadFuture<'_> {
        let client = self.client.clone();
        Box::pin(async move {
            let mut builder = client.post(&request.upload_url).body(request.bytes);
            if let Some(content_type) = request.content_type {
                builder = builder.header(reqwest::header::CONTENT_TYPE, content_type);
            }
            let response = builder
                .send()
                .await
                .map_err(|error| RemoteError::Transport(format!("upload POST failed: {error}")))?;
            let status = response.status();
            let body = response.text().await.map_err(|error| {
                RemoteError::Transport(format!("upload response failed: {error}"))
            })?;
            if !status.is_success() {
                return Err(RemoteError::Transport(format!(
                    "upload POST failed with status {status}: {body}"
                )));
            }
            decode_upload_receipt_text(&body)
        })
    }
}

pub(crate) fn args(upload: &PendingUpload, runtime: &RuntimeWireIdentity) -> ConvexArgs {
    let mut args = BTreeMap::from([
        (
            "localStorageId".to_owned(),
            Value::String(upload.local_storage_id.clone()),
        ),
        ("sha256".to_owned(), Value::String(upload.sha256.clone())),
        ("size".to_owned(), Value::Float64(upload.size as f64)),
    ]);
    if let Some(content_type) = &upload.content_type {
        args.insert(
            "contentType".to_owned(),
            Value::String(content_type.clone()),
        );
    }
    args.insert(
        "runtime".to_owned(),
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
        ])),
    );
    args
}

pub(crate) fn decode_upload_url(value: Value) -> RemoteResult<String> {
    let Value::Object(mut object) = value else {
        return Err(RemoteError::Protocol(
            "embedded:upload result must be an object".to_owned(),
        ));
    };
    let Some(Value::String(upload_url)) = object.remove("uploadUrl") else {
        return Err(RemoteError::Protocol(
            "embedded:upload result missing uploadUrl".to_owned(),
        ));
    };
    Ok(upload_url)
}

#[cfg(not(target_arch = "wasm32"))]
fn decode_upload_receipt_text(body: &str) -> RemoteResult<RemoteUploadReceipt> {
    let value = serde_json::from_str(body)
        .map_err(|error| RemoteError::Protocol(format!("upload response was not JSON: {error}")))?;
    decode_upload_receipt(&value)
}

#[cfg(not(target_arch = "wasm32"))]
fn decode_upload_receipt(value: &serde_json::Value) -> RemoteResult<RemoteUploadReceipt> {
    let storage_id = value
        .as_object()
        .and_then(|object| object.get("storageId"))
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| RemoteError::Protocol("upload response missing storageId".to_owned()))?;
    Ok(RemoteUploadReceipt {
        storage_id: storage_id.to_owned(),
    })
}
