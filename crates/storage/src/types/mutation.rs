use serde_json::Value as JsonValue;

use super::doc::{CrdtFieldKind, Order, RowChange};

/// A read-set bound: a Convex value plus its inclusivity. Mirrors the wire `Bound`
/// (`{ value, inclusive }`) shared by the push read-set (§2) and the pull read-range scope (§4).
#[derive(Debug, Clone, PartialEq)]
pub struct ReadBound {
    pub field: String,
    pub value: JsonValue,
    pub inclusive: bool,
    /// Rebind the physical value to hosted `db.vars.commitTs` before executing the range.
    pub commit_ts: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReadEquality {
    pub field: String,
    pub value: JsonValue,
    /// Distinguishes the logical timestamp marker from a literal maximum `i64`.
    pub commit_ts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdtReadWitness {
    pub field: String,
    pub epoch: i64,
    pub head_seq: i64,
    pub projection_hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrdtReadState {
    pub field: String,
    pub epoch: i64,
    pub head_seq: i64,
    pub projection_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdtSnapshot {
    pub field: String,
    pub kind: CrdtFieldKind,
    pub head_seq: i64,
    pub projection_hash: String,
    pub bytes: Vec<u8>,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RevisionCheckpoint {
    pub ordinal: usize,
    pub operation: RevisionCheckpointOperation,
    pub row_id: String,
    pub table: String,
    pub snapshots: Vec<CrdtSnapshot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionCheckpointOperation {
    Create,
    Retain,
}

/// One member of a mutation's read-set: the row or index range the optimistic run read, tagged
/// with the version (pull `seq` / adoption `logicalClock`) it observed. The server re-run raises a
/// conflict when any member advanced past `version` before it committed (e1-determinism §4/§6).
#[derive(Debug, Clone, PartialEq)]
pub enum BaseVersion {
    /// A point read; `version` is the row's `logicalClock`/seq.
    Point {
        table: String,
        id: String,
        version: f64,
        content_hash: String,
        crdt: Vec<CrdtReadWitness>,
    },
    /// An index-range read; `members` are the ids the range held at `version`.
    Range(Box<RangeVersion>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct RangeVersion {
    pub table: String,
    pub index: String,
    pub equality: Vec<ReadEquality>,
    pub limit: Option<usize>,
    pub lower: Option<ReadBound>,
    pub upper: Option<ReadBound>,
    pub order: Order,
    pub members_hash: String,
    pub members: Vec<String>,
    pub member_hashes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InsertRef {
    pub mutation_id: String,
    pub ordinal: usize,
    pub table: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgRef {
    Insert { path: String, insert: InsertRef },
    Schedule { path: String, schedule: ScheduleRef },
}

#[derive(Debug, Clone, PartialEq)]
pub struct RevisionCandidate {
    pub table: String,
    pub row_id: String,
    pub content: RevisionContent,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RevisionContent {
    Value(JsonValue),
    Deleted,
}

/// One carried CRDT-field edit on the wire (§1): the Loro update bytes for one collaborative field,
/// merged on apply and ordered by pull `seq`. `update` is raw Loro bytes in Rust (base64 on the JSON
/// wire, encoded as a Convex `Value::Bytes`). Shared by the push envelope [`PushCall::crdt_ops`] and
/// the pull-side `crdt` `RowChange`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdtWireOp {
    pub table: String,
    pub id: String,
    pub field: String,
    pub kind: CrdtFieldKind,
    pub update: Vec<u8>,
    pub checkpoint: Option<CrdtCheckpoint>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrdtEffect {
    pub table: String,
    pub row_id: String,
    pub field: String,
    pub kind: CrdtFieldKind,
    pub base_seq: i64,
    pub projection: JsonValue,
    pub projection_hash: String,
    pub payload: Vec<u8>,
    pub checkpoint: Option<CrdtCheckpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdtCheckpoint {
    pub through_seq: i64,
    pub bytes: Vec<u8>,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdtCheckpointRequest {
    pub checkpoint_id: String,
    pub response_token: String,
    pub through_seq: i64,
    pub projection_hash: String,
}

/// One pulled `crdt` `RowChange` handed to the store's per-field merge (§3/§8-A). `document_id` is the
/// SERVER doc id from the pull response; the store maps it to the local id before merging + materializing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCrdtChange {
    pub table: String,
    pub document_id: String,
    pub field: String,
    pub kind: CrdtFieldKind,
    pub epoch: i64,
    pub checkpoint_seq: i64,
    pub head_seq: i64,
    pub projection_hash: String,
    /// Present for a complete checkpoint-covered state and absent for one next-head live effect.
    pub checkpoint: Option<Vec<u8>>,
    pub updates: Vec<Vec<u8>>,
    pub checkpoint_request: Option<CrdtCheckpointRequest>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrdtRemoteState {
    pub epoch: i64,
    pub head_seq: i64,
    pub projection_hash: String,
    pub projection: JsonValue,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrdtRemoteEffect {
    pub base_seq: i64,
    pub projection: JsonValue,
    pub checkpoint: Option<CrdtCheckpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrdtRemoteWrite {
    pub table: String,
    pub id: String,
    pub field: String,
    pub kind: CrdtFieldKind,
    pub head_seq: i64,
    pub projection_hash: String,
    pub payload: Vec<u8>,
}

impl CrdtFieldKind {
    /// The `crdt` `RowChange` / `crdtOps` wire spelling (§1: `"text" | "count" | "set"`).
    #[must_use]
    pub fn as_wire(self) -> &'static str {
        match self {
            CrdtFieldKind::Text => "text",
            CrdtFieldKind::Count => "count",
            CrdtFieldKind::Set => "set",
        }
    }

    #[must_use]
    pub fn parse_wire(value: &str) -> Option<CrdtFieldKind> {
        match value {
            "text" => Some(CrdtFieldKind::Text),
            "count" => Some(CrdtFieldKind::Count),
            "set" => Some(CrdtFieldKind::Set),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeWireIdentity {
    pub schema_hash: String,
    pub module_graph_hash: String,
    pub protocol_version: i64,
}

/// One durable local mutation and its deterministic replay envelope.
#[derive(Debug, Clone, PartialEq)]
pub struct PushEnvelope {
    pub mutation_id: String,
    /// Durable idempotency key for this prepared replay attempt. The logical mutation id remains
    /// stable across a safe retry after the server rejects a stale prepared form.
    pub replay_id: String,
    /// Hash of the durable, unprepared mutation envelope. Unlike the hosted replay fingerprint,
    /// this does not change when CRDT bases and projections are prepared again.
    pub logical_fingerprint: String,
    pub commit_seq: i64,
    pub runtime: RuntimeWireIdentity,
    pub function: String,
    pub args: JsonValue,
    pub result_hash: String,
    pub id_paths: Vec<String>,
    pub mutation_time_hlc: f64,
    pub rng_seed: String,
    pub id_allocations: Vec<String>,
    pub local_schedule_ids: Vec<String>,
    pub inserts: Vec<InsertRef>,
    pub arg_refs: Vec<ArgRef>,
    pub read_set: Vec<BaseVersion>,
    pub schedules: Vec<ScheduleRef>,
    pub uploads: Vec<UploadRef>,
    pub after_images: Vec<RevisionCandidate>,
    pub crdt: Vec<CrdtEffect>,
    pub revision_checkpoints: Vec<RevisionCheckpoint>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleRef {
    pub mutation_id: String,
    pub ordinal: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadRef {
    pub mutation_id: String,
    pub ordinal: usize,
}

/// The server re-run verdict for one call (§2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushOutcome {
    Applied,
    Conflict,
    Rejected,
    Rebase,
}

impl PushOutcome {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Conflict => "conflict",
            Self::Rejected => "rejected",
            Self::Rebase => "rebase",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "applied" => Some(Self::Applied),
            "conflict" => Some(Self::Conflict),
            "rejected" => Some(Self::Rejected),
            "rebase" => Some(Self::Rebase),
            _ => None,
        }
    }
}

/// The only public code a terminal rejected replay may carry.
///
/// Server-provided reasons are deliberately neither accepted nor retained: they are arbitrary
/// application text and must not cross the durable remote boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RejectionCode {
    Rejected,
    Divergence,
}

impl RejectionCode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rejected => "EMBEDDED_REJECTED",
            Self::Divergence => "EMBEDDED_DIVERGENCE",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "EMBEDDED_REJECTED" => Some(Self::Rejected),
            "EMBEDDED_DIVERGENCE" => Some(Self::Divergence),
            _ => None,
        }
    }
}

/// Validated server verdict for one replay.
///
/// This is deliberately more specific than [`PushOutcome`]: a caller cannot pair `applied` with
/// an error code, cannot use an arbitrary conflict code, and cannot attach a rebase code to a
/// terminal settlement. It is created only by strict push-response decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushVerdict {
    Applied,
    Conflict,
    Rejected(RejectionCode),
    Rebase,
}

impl PushVerdict {
    #[must_use]
    pub fn outcome(self) -> PushOutcome {
        match self {
            Self::Applied => PushOutcome::Applied,
            Self::Conflict => PushOutcome::Conflict,
            Self::Rejected(_) => PushOutcome::Rejected,
            Self::Rebase => PushOutcome::Rebase,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledInsert {
    pub ordinal: usize,
    pub table: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledSchedule {
    pub ordinal: usize,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledUpload {
    pub ordinal: usize,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledRevision {
    pub table: String,
    pub row_id: String,
    pub rev_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettledCrdt {
    pub table: String,
    pub row_id: String,
    pub field: String,
    pub kind: CrdtFieldKind,
    pub head_seq: i64,
    pub projection_hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AuthoritativeChange {
    Put {
        table: String,
        row_id: String,
        fields: JsonValue,
        plain_hash: String,
    },
    Delete {
        table: String,
        row_id: String,
        plain_hash: String,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct PushResponse {
    pub mutation_id: String,
    pub verdict: PushVerdict,
    pub inserts: Vec<SettledInsert>,
    pub schedules: Vec<SettledSchedule>,
    pub uploads: Vec<SettledUpload>,
    pub revisions: Vec<SettledRevision>,
    pub crdt: Vec<SettledCrdt>,
    pub authoritative: Vec<AuthoritativeChange>,
}

impl PushResponse {
    #[must_use]
    pub fn outcome(&self) -> PushOutcome {
        self.verdict.outcome()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitSource {
    Local,
    Remote,
    Device,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitChanges {
    Include,
    Omit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitPush {
    pub mutation_id: String,
    pub json: String,
    pub now_ms: i64,
    /// Resolve markers only under `afterImages[].value`, preserving the logical replay envelope.
    pub after_images_commit_ts: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitMutation {
    None,
    Existing {
        mutation_id: String,
        result: Option<String>,
    },
    Terminal {
        call: MutationCall,
        result: String,
        fresh: bool,
    },
}

/// Exact private metadata attached to a commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitOptions {
    pub source: CommitSource,
    pub mutation: CommitMutation,
    pub push: Option<CommitPush>,
    pub changes: CommitChanges,
    /// Request transaction-local allocation and substitution of `db.vars.commitTs`.
    /// The floor is store-global rather than identity or generation scoped.
    pub commit_ts: bool,
    /// Resolve the encoded terminal/existing result; omitted results pay no JSON parse.
    pub mutation_result_commit_ts: bool,
}

impl Default for CommitOptions {
    fn default() -> Self {
        Self {
            source: CommitSource::Local,
            mutation: CommitMutation::None,
            push: None,
            changes: CommitChanges::Include,
            commit_ts: false,
            mutation_result_commit_ts: false,
        }
    }
}

impl CommitOptions {
    #[allow(clippy::too_many_arguments)]
    #[must_use]
    pub fn decode(
        source: Option<&str>,
        mutation_id: Option<String>,
        mutation_name: Option<String>,
        mutation_args: Option<String>,
        mutation_result: Option<String>,
        push_json: Option<String>,
        push_now_ms: Option<i64>,
        mutation_is_fresh: bool,
        include_changes: bool,
    ) -> Option<Self> {
        let source = match source.unwrap_or("local") {
            "local" => CommitSource::Local,
            "remote" => CommitSource::Remote,
            "device" => CommitSource::Device,
            _ => return None,
        };
        let push = match (push_json, push_now_ms, mutation_id.as_ref()) {
            (None, None, _) => None,
            (Some(json), Some(now_ms), Some(mutation_id)) => Some(CommitPush {
                mutation_id: mutation_id.clone(),
                json,
                now_ms,
                after_images_commit_ts: false,
            }),
            _ => return None,
        };
        let mutation = match (
            mutation_id,
            mutation_name,
            mutation_args,
            mutation_result,
            mutation_is_fresh,
            push.is_some(),
        ) {
            (None, None, None, None, false, false) | (Some(_), None, None, None, false, true) => {
                CommitMutation::None
            }
            (Some(mutation_id), None, None, result, false, false) => CommitMutation::Existing {
                mutation_id,
                result,
            },
            (Some(mutation_id), Some(name), Some(args), Some(result), fresh, _) => {
                CommitMutation::Terminal {
                    call: MutationCall {
                        args,
                        mutation_id,
                        name,
                    },
                    result,
                    fresh,
                }
            }
            _ => return None,
        };
        if source != CommitSource::Local && (mutation != CommitMutation::None || push.is_some()) {
            return None;
        }
        Some(Self {
            source,
            mutation,
            push,
            changes: if include_changes {
                CommitChanges::Include
            } else {
                CommitChanges::Omit
            },
            commit_ts: false,
            mutation_result_commit_ts: false,
        })
    }

    #[must_use]
    pub fn remote() -> Self {
        Self {
            source: CommitSource::Remote,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn existing(mutation_id: impl Into<String>, result: Option<String>) -> Self {
        Self {
            mutation: CommitMutation::Existing {
                mutation_id: mutation_id.into(),
                result,
            },
            ..Self::default()
        }
    }

    #[must_use]
    pub fn terminal(
        call: MutationCall,
        result: impl Into<String>,
        fresh: bool,
        push: Option<CommitPush>,
    ) -> Self {
        Self {
            mutation: CommitMutation::Terminal {
                call,
                result: result.into(),
                fresh,
            },
            push,
            ..Self::default()
        }
    }

    #[must_use]
    pub fn omit_changes(mut self) -> Self {
        self.changes = CommitChanges::Omit;
        self
    }

    #[must_use]
    pub fn is_local(&self) -> bool {
        self.source == CommitSource::Local
    }

    #[must_use]
    pub fn is_device(&self) -> bool {
        self.source == CommitSource::Device
    }

    #[must_use]
    pub fn includes_changes(&self) -> bool {
        self.changes == CommitChanges::Include
    }

    #[must_use]
    pub fn mutation_id(&self) -> Option<&str> {
        match &self.mutation {
            CommitMutation::None => None,
            CommitMutation::Existing { mutation_id, .. } => Some(mutation_id),
            CommitMutation::Terminal { call, .. } => Some(&call.mutation_id),
        }
    }

    #[must_use]
    pub fn mutation_result(&self) -> Option<&str> {
        match &self.mutation {
            CommitMutation::None => None,
            CommitMutation::Existing { result, .. } => result.as_deref(),
            CommitMutation::Terminal { result, .. } => Some(result),
        }
    }

    #[must_use]
    pub fn mutation_is_fresh(&self) -> bool {
        matches!(self.mutation, CommitMutation::Terminal { fresh: true, .. })
    }

    #[must_use]
    pub fn terminal_call(&self) -> Option<&MutationCall> {
        match &self.mutation {
            CommitMutation::Terminal { call, .. } => Some(call),
            _ => None,
        }
    }

    #[must_use]
    pub fn push(&self) -> Option<&CommitPush> {
        self.push.as_ref()
    }
}

/// Metadata returned after a batch commits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitResult {
    pub commit_seq: i64,
    /// Allocated only for a transaction which requested `commit_ts`.
    pub commit_ts: Option<i64>,
    pub changed_tables: Vec<String>,
    pub changes: Vec<RowChange>,
    /// CRDT-field edits this local commit produced, each carrying the Loro update delta the driver
    /// carries verbatim on the one push (`PushCall.crdt_ops`, §1/§8-A). Empty for remote-sourced
    /// commits and for commits with no collaborative-field edits.
    pub crdt_ops: Vec<CrdtWireOp>,
}

/// Durable mutation call metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationCall {
    pub args: String,
    pub mutation_id: String,
    pub name: String,
}

/// Durable mutation state used to make local retries idempotent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MutationRecord {
    pub commit_seq: Option<i64>,
    pub error: Option<String>,
    pub mutation_id: String,
    pub result: Option<String>,
    pub status: MutationStatus,
}

/// Durable mutation lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationStatus {
    Accepted,
    Committed,
    Failed,
}

impl MutationStatus {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Committed => "committed",
            Self::Failed => "failed",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "accepted" => Some(Self::Accepted),
            "committed" => Some(Self::Committed),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

/// Rows removed by `ledger_delete`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DeleteResult {
    pub commits_deleted: i64,
    pub mutations_deleted: i64,
}
