#![allow(clippy::items_after_test_module)]

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

    #[error("storage owner lease: {0}")]
    Owner(#[from] std::io::Error),
}

impl StorageError {
    /// True when retrying the same storage operation may succeed without changing its input.
    ///
    /// Busy/locking/schema races are ordinary concurrency outcomes, and an I/O step can fail while
    /// the browser is suspending, reclaiming OPFS handles, or under temporary resource pressure.
    /// These failures must not permanently quarantine an otherwise valid authoritative result.
    #[must_use]
    pub fn is_transient(&self) -> bool {
        match self {
            Self::IoStep { source, .. } | Self::Turso(source) => is_transient_turso(source),
            Self::Owner(error) => matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
            ),
            Self::Clock
            | Self::Decode { .. }
            | Self::IncompatibleStore(_)
            | Self::InvalidCursor(_)
            | Self::InvalidIdent(_)
            | Self::ReservedColumn(_)
            | Self::Unsatisfiable(_) => false,
        }
    }
}

fn is_transient_turso(error: &turso_core::LimboError) -> bool {
    matches!(
        error,
        turso_core::LimboError::Busy
            | turso_core::LimboError::BusySnapshot
            | turso_core::LimboError::CheckpointFailed(_)
            | turso_core::LimboError::CommitDependencyAborted
            | turso_core::LimboError::Conflict(_)
            | turso_core::LimboError::LockingError(_)
            | turso_core::LimboError::OutOfMemory
            | turso_core::LimboError::SchemaConflict
            | turso_core::LimboError::SchemaUpdated
            | turso_core::LimboError::TableLocked
            | turso_core::LimboError::WriteWriteConflict
    )
}

#[cfg(test)]
mod tests {
    use super::StorageError;

    #[test]
    fn concurrency_and_io_failures_are_transient() {
        for source in [
            turso_core::LimboError::Busy,
            turso_core::LimboError::BusySnapshot,
            turso_core::LimboError::Conflict("retry the transaction".to_owned()),
            turso_core::LimboError::OutOfMemory,
            turso_core::LimboError::SchemaUpdated,
            turso_core::LimboError::TableLocked,
            turso_core::LimboError::WriteWriteConflict,
        ] {
            assert!(StorageError::from(source).is_transient());
        }
        assert!(StorageError::IoStep {
            operation: "read",
            sql: "SELECT 1".to_owned(),
            source: Box::new(turso_core::LimboError::Busy),
        }
        .is_transient());
        assert!(!StorageError::IoStep {
            operation: "read",
            sql: "SELECT 1".to_owned(),
            source: Box::new(turso_core::LimboError::Corrupt("bad page".to_owned())),
        }
        .is_transient());
    }

    #[test]
    fn corrupt_and_unsatisfiable_data_is_permanent() {
        assert!(
            !StorageError::from(turso_core::LimboError::Corrupt("bad page".to_owned()))
                .is_transient()
        );
        assert!(!StorageError::Decode {
            expected: "integer",
            index: 0,
            got: "text".to_owned(),
        }
        .is_transient());
        assert!(!StorageError::Unsatisfiable("bad manifest".to_owned()).is_transient());
    }
}

/// The turso error is boxed to keep `StorageError` (and every `Result` in the crate) small.
impl From<turso_core::LimboError> for StorageError {
    fn from(source: turso_core::LimboError) -> Self {
        Self::Turso(Box::new(source))
    }
}
