use thiserror::Error;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("turso: {0}")]
    Turso(#[from] turso::Error),

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

    #[error("system clock is before the unix epoch")]
    Clock,
}
