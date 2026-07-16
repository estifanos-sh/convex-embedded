/// Metadata for a blob stored through the local file storage surface.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMetadata {
    pub storage_id: String,
    pub sha256: String,
    pub size: i64,
    pub content_type: Option<String>,
    pub source: Option<String>,
    pub created_time: i64,
    pub updated_time: i64,
}

/// Atomic local file store input: blob bytes plus every durable row that makes the file visible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStore {
    pub bytes: Vec<u8>,
    pub metadata: FileMetadata,
}

/// A pending local file upload row.
///
/// Remote replication claims these rows, uploads bytes to the server, records the hosted id mapping,
/// and removes the row only after remote acceptance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingUpload {
    pub local_storage_id: String,
    pub sha256: String,
    pub size: i64,
    pub content_type: Option<String>,
    pub lease: UploadLease,
    pub created_time: i64,
    pub updated_time: i64,
}

/// Exact target states for an upload-lease lifecycle write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadLeaseWrite {
    Claimed {
        /// `None` selects the next pending or expired upload; `Some` rewrites that owned lease.
        local_storage_id: Option<String>,
        owner: String,
        now_ms: i64,
        lease_until: i64,
    },
    Pending {
        local_storage_id: String,
        owner: String,
        now_ms: i64,
    },
}

/// Pending upload lifecycle state.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UploadLease {
    Pending,
    Claimed { owner: String, lease_until: i64 },
}

impl UploadLease {
    pub const CLAIMED: &'static str = "claimed";
    pub const PENDING: &'static str = "pending";

    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => Self::PENDING,
            Self::Claimed { .. } => Self::CLAIMED,
        }
    }

    #[must_use]
    pub fn decode(state: &str, owner: Option<String>, lease_until: Option<i64>) -> Option<Self> {
        match (state, owner, lease_until) {
            ("pending", None, None) => Some(Self::Pending),
            ("claimed", Some(owner), Some(lease_until)) => {
                Some(Self::Claimed { owner, lease_until })
            }
            _ => None,
        }
    }

    #[must_use]
    pub fn owner(&self) -> Option<&str> {
        match self {
            Self::Pending => None,
            Self::Claimed { owner, .. } => Some(owner),
        }
    }

    #[must_use]
    pub fn lease_until(&self) -> Option<i64> {
        match self {
            Self::Pending => None,
            Self::Claimed { lease_until, .. } => Some(*lease_until),
        }
    }
}
