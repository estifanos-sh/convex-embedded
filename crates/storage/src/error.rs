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

    #[error("incompatible store: {0}")]
    IncompatibleStore(String),

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

impl StorageError {
    /// True when the physical bytes on disk are not a readable current-format store: the header is
    /// corrupt or the file is not a database at all. This is a *format* incompatibility (e.g. a store
    /// written by a prior turso release), not same-format corruption of an already-openable store, so
    /// the opener resets it rather than failing closed (V5 "Local Store Evolution").
    pub(crate) fn is_unreadable_store(&self) -> bool {
        matches!(
            self,
            Self::Turso(error)
                if matches!(
                    error.as_ref(),
                    turso_core::LimboError::Corrupt(_) | turso_core::LimboError::NotADB
                )
        )
    }
}

/// The turso error is boxed to keep `StorageError` (and every `Result` in the crate) small.
impl From<turso_core::LimboError> for StorageError {
    fn from(source: turso_core::LimboError) -> Self {
        Self::Turso(Box::new(source))
    }
}
