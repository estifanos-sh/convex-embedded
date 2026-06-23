//! Rev types and the local rev id formats.
//!
//! `main` is the live local projection. `archive:<hash>` identifies a losing local CAS edit retained
//! for conflict recovery. Hosted savepoints and their public ids live in the Convex component.
use super::doc::RowKey;

/// Local revision identity for one row.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RevKey {
    pub row: RowKey,
    pub rev_id: String,
}

/// Raw Loro rev state. Each application document is a set of revs (histories) with exactly
/// one `status == Current` rev projecting to the visible row; the others are archived/detached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevState {
    pub key: RevKey,
    pub frontier: Vec<u8>,
    /// The last full-snapshot checkpoint of this rev's Loro oplog. Reconstructing the rev's doc means
    /// importing `snapshot` and then replaying `log` in order.
    pub snapshot: Vec<u8>,
    /// Incremental Loro update deltas committed since the `snapshot` checkpoint, ordered oldest-first.
    /// Empty for a freshly-checkpointed rev; grows per commit until a new checkpoint resets it. Keeping
    /// the full chain (never trimming below `snapshot`) is what preserves convergence — a concurrent
    /// peer update can never miss a dependency the rev once held.
    pub log: Vec<Vec<u8>>,
    pub lifecycle: RevLifecycle,
    pub updated_time: i64,
}

/// Lifecycle of a rev within a document's history set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevLifecycle {
    /// The one rev that projects to the visible application row.
    Current,
    /// A retained history: a re-rooted conflict loser (carrying its stamped server identity),
    /// a savepoint fork, or an unpromoted import.
    Archived(ArchivedRev),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchivedRev {
    pub parent: String,
    pub server_rev_id: Option<String>,
    pub server_root_id: Option<String>,
    pub server_node_id: Option<String>,
    pub base_root_id: Option<String>,
    pub base_node_id: Option<String>,
}

impl RevLifecycle {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            RevLifecycle::Current => "current",
            RevLifecycle::Archived(_) => "archived",
        }
    }

    #[must_use]
    pub fn decode(
        value: &str,
        parent: Option<String>,
        server_rev_id: Option<String>,
        server_root_id: Option<String>,
        server_node_id: Option<String>,
        base_root_id: Option<String>,
        base_node_id: Option<String>,
    ) -> Option<Self> {
        match (value, parent) {
            ("current", None)
                if server_rev_id.is_none()
                    && server_root_id.is_none()
                    && server_node_id.is_none()
                    && base_root_id.is_none()
                    && base_node_id.is_none() =>
            {
                Some(Self::Current)
            }
            ("archived", Some(parent)) => Some(Self::Archived(ArchivedRev {
                parent,
                server_rev_id,
                server_root_id,
                server_node_id,
                base_root_id,
                base_node_id,
            })),
            _ => None,
        }
    }

    #[must_use]
    pub fn archived(&self) -> Option<&ArchivedRev> {
        match self {
            Self::Archived(archived) => Some(archived),
            Self::Current => None,
        }
    }
}

/// Rev frontier advertised to the remote pull endpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevFrontier {
    pub key: RevKey,
    pub frontier: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevWriteResult {
    pub duplicates: usize,
    pub written: usize,
}
