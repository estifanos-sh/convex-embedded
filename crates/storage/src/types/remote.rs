use super::mutation::CommitResult;
use super::rev::RevWriteResult;

#[derive(Debug, Clone, PartialEq)]
pub struct RowHead {
    pub table: String,
    pub local_document_id: String,
    /// The ref id currently projecting to the visible row.
    pub current_rev_id: String,
    pub server_document_id: String,
    pub projection_hash: String,
    pub current_root_id: Option<String>,
    pub current_node_id: Option<String>,
    /// The last server-adopted projection hash. `None` means this row was never confirmed by the
    /// server (locally-created and not yet round-tripped) — the DIRTY/CLEAN + sweep guard key.
    pub server_base: Option<String>,
    /// Last server-accepted materialized row, used to restore an unverified rejection.
    pub server_row: Option<String>,
    pub logical_clock: f64,
    pub updated_time: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuthoritativeRow {
    pub table: String,
    pub local_document_id: Option<String>,
    pub server_document_id: String,
    /// Stable hash of the app-visible plain fields, excluding ids, creation time, and CRDT fields.
    pub plain_hash: String,
    pub projection_hash: String,
    pub current_root_id: Option<String>,
    pub current_node_id: Option<String>,
    pub row: Option<String>,
    pub logical_clock: Option<f64>,
    pub received_time: i64,
}

/// Hosted identity of one row in an authorized query result.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RemoteMember {
    pub table: String,
    pub server_document_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteBlob {
    pub key: String,
    pub bytes: Vec<u8>,
}

/// One retained authored-result cache entry (Cut 7 §3). `key` is the precomputed `ResultKey` hash
/// and sole primary key; the store fills the partition column from its active identity, and
/// `skeleton_hash` gates the zero-write fast path.
#[derive(Debug, Clone, PartialEq)]
pub struct ResultEntry {
    pub key: String,
    pub function: String,
    pub args: String,
    pub schema_hash: String,
    pub module_hash: String,
    pub skeleton: Vec<u8>,
    pub paths: Vec<u8>,
    pub skeleton_hash: String,
    pub clock: f64,
}

/// The authorized page's index-range descriptor stored on a subscription's membership edges (§4.5)
/// for S4's range-coverage check. Fields are opaque codec text (`None` until S4 wires population).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MembershipRange {
    pub lower: Option<String>,
    pub upper: Option<String>,
    pub order: Option<String>,
}

/// One indivisible pull transaction. Cursor progress cannot be recorded without applying the
/// corresponding projections and complete membership replacement.
#[derive(Debug, Clone, PartialEq)]
pub struct RemotePull {
    pub subscription: String,
    pub members: Vec<RemoteMember>,
    pub projections: Vec<AuthoritativeRow>,
    pub crdt: Vec<super::mutation::RemoteCrdtChange>,
    pub blobs: Vec<RemoteBlob>,
    pub cursor: Option<String>,
    pub received_time: i64,
    /// The retained authored-result cache entry (Cut 7 §5), written inside this page's transaction so
    /// it commits atomically with membership/projection/CRDT and a rollback strands no results row.
    /// Boxed so a resultless pull keeps `RemotePull` small (the common projection/CRDT page).
    pub result: Option<Box<ResultEntry>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoritativeApplyResult {
    pub committed: Vec<CommitResult>,
    /// Documents the server authoritatively re-rooted (a CAS reject): the local edit lost and was
    /// preserved on an archived ref. Surfaced as a conflict the app can act on.
    pub reroots: Vec<RetainedRevision>,
}

/// A server re-root: a local edit lost a compare-and-swap and was archived instead of destroyed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetainedRevision {
    pub table: String,
    pub local_document_id: String,
    pub archived_rev_id: String,
    pub server_rev_id: Option<String>,
    pub server_document_id: Option<String>,
    pub base_root_id: Option<String>,
    pub base_node_id: Option<String>,
    pub attached_node_id: Option<String>,
    pub current_root_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemotePullResult {
    pub rev_write: RevWriteResult,
    pub projection: AuthoritativeApplyResult,
    pub swept: usize,
    pub crdt: Vec<super::doc::RowChange>,
    /// The retained-result cache key this page durably rewrote (Cut 7 §5), or `None` when the page
    /// carried no result or hit the zero-write fast path. Surfaces the membership-free result change
    /// so the tick can re-emit a watch whose reconstruction changed with no member/projection row.
    pub result_changed: Option<String>,
}

/// One hosted/local document-ID binding accepted with an applied push verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteIdMapping {
    pub table: String,
    pub server_document_id: String,
    pub local_document_id: String,
}

/// One local/hosted schedule-ID binding accepted with an applied push verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteScheduleMapping {
    pub local_id: String,
    pub server_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RemoteRowTarget {
    pub table: String,
    pub local_document_id: String,
    pub server_rev_id: Option<String>,
}

/// All local state implied by one terminal hosted push verdict.
#[derive(Debug, Clone, PartialEq)]
pub struct RemotePushSettlement {
    pub mutation_id: String,
    pub expected_commit_seq: i64,
    pub now_ms: i64,
    pub outcome: RemotePushSettlementOutcome,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RemotePushSettlementOutcome {
    Applied {
        ids: Vec<RemoteIdMapping>,
        schedules: Vec<RemoteScheduleMapping>,
        projections: Vec<AuthoritativeRow>,
        crdt: Vec<super::mutation::CrdtRemoteWrite>,
    },
    Rejected {
        schedules: Vec<String>,
        targets: Vec<RemoteRowTarget>,
        projections: Vec<AuthoritativeRow>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemotePushSettlementResult {
    pub projection: AuthoritativeApplyResult,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirtyHeadToken {
    pub first_commit_seq: i64,
    pub updated_commit_seq: i64,
}
