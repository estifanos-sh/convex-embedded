use thiserror::Error;

#[derive(Debug, Error)]
#[non_exhaustive]
pub enum StorageError {
    #[error("turso: {0}")]
    Turso(Box<turso_core::LimboError>),

    #[error("{operation} io step failed for {sql:?}: {source}")]
    IoStep {
        operation: &'static str,
        sql: String,
        #[source]
        source: Box<turso_core::LimboError>,
    },

    #[error("invalid identifier: {0:?}")]
    InvalidIdent(String),

    #[error("reserved column name: {0}")]
    ReservedColumn(String),

    #[error("unsatisfiable: {0}")]
    Unsatisfiable(String),

    #[error("decode: expected {expected} at column {index}, got {got}")]
    Decode {
        expected: &'static str,
        index: usize,
        got: String,
    },

    #[error("invalid scan cursor: {0}")]
    InvalidCursor(String),

    #[error("system clock is before the unix epoch")]
    Clock,
}

/// The turso error is boxed to keep `StorageError` (and every `Result` in the crate) small.
impl From<turso_core::LimboError> for StorageError {
    fn from(source: turso_core::LimboError) -> Self {
        Self::Turso(Box::new(source))
    }
}
