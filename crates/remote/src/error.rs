use thiserror::Error;

#[derive(Debug, Error)]
pub enum RemoteError {
    #[error("remote client is already started")]
    AlreadyStarted,
    #[error("remote auth failed: {0}")]
    Auth(String),
    #[error("remote command channel closed")]
    Closed,
    #[error("remote command failed: {0}")]
    Command(String),
    #[error("remote deployment mismatch: {0}")]
    DeploymentMismatch(String),
    #[error("invalid remote config: {0}")]
    InvalidConfig(String),
    #[error("remote task failed: {0}")]
    Join(String),
    #[error("no Tokio runtime is active")]
    NoRuntime,
    #[error("remote client is not started")]
    NotStarted,
    #[error("remote checkpoint manifest became stale")]
    StaleCheckpoint,
    #[error("Convex protocol error: {0}")]
    Protocol(String),
    #[error("remote client retired: {0}")]
    Retired(String),
    #[error("storage error: {0}")]
    Storage(#[from] storage::StorageError),
    #[error("remote operation timed out: {0}")]
    Timeout(&'static str),
    #[error("transport error: {0}")]
    Transport(String),
}

impl RemoteError {
    /// Whether retrying the failed operation may succeed. Network failures and temporary local
    /// storage contention/resource failures are transient; invalid protocol data, configuration,
    /// corruption, and lifecycle errors are permanent.
    #[must_use]
    pub fn is_transient(&self) -> bool {
        matches!(self, RemoteError::Timeout(_) | RemoteError::Transport(_))
            || matches!(self, RemoteError::Storage(error) if error.is_transient())
    }
}
