use storage::{WIRE_ENDPOINT_PULL, WIRE_ENDPOINT_PUSH, WIRE_ENDPOINT_UPLOAD};

use crate::{RemoteFunction, RemoteResult};

pub const EMBEDDED_PULL: &str = WIRE_ENDPOINT_PULL;
pub const EMBEDDED_PUSH: &str = WIRE_ENDPOINT_PUSH;
pub const EMBEDDED_UPLOAD: &str = WIRE_ENDPOINT_UPLOAD;

pub(crate) fn pull_function() -> RemoteResult<RemoteFunction> {
    RemoteFunction::parse(EMBEDDED_PULL)
}

pub(crate) fn push_function() -> RemoteResult<RemoteFunction> {
    RemoteFunction::parse(EMBEDDED_PUSH)
}

pub(crate) fn upload_function() -> RemoteResult<RemoteFunction> {
    RemoteFunction::parse(EMBEDDED_UPLOAD)
}
