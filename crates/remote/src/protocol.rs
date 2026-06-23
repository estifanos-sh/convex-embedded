use crate::{RemoteFunction, RemoteResult};

pub const EMBEDDED_PULL: &str = "embedded:pull";
pub const EMBEDDED_PUSH: &str = "embedded:push";
pub const EMBEDDED_UPLOAD: &str = "embedded:upload";

pub(crate) fn pull_function() -> RemoteResult<RemoteFunction> {
    RemoteFunction::parse(EMBEDDED_PULL)
}

pub(crate) fn push_function() -> RemoteResult<RemoteFunction> {
    RemoteFunction::parse(EMBEDDED_PUSH)
}

pub(crate) fn upload_function() -> RemoteResult<RemoteFunction> {
    RemoteFunction::parse(EMBEDDED_UPLOAD)
}
