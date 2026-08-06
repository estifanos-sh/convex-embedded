#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemotePending {
    pub checkpoints: usize,
    pub inflight: usize,
    pub mutations: usize,
    pub scope: usize,
    pub settlements: usize,
    pub uploads: usize,
}

impl RemotePending {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.checkpoints == 0
            && self.inflight == 0
            && self.mutations == 0
            && self.scope == 0
            && self.settlements == 0
            && self.uploads == 0
    }
}

/// A terminal replay meaning that is safe to surface outside the remote driver.
///
/// `Rebase` is intentionally absent: it leaves the durable envelope pending and is not a
/// settlement. A rejected verdict carries only the server's closed rejection code, while
/// conflict derives its one permitted code from the variant itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteMutationOutcome {
    Applied,
    Conflict,
    Rejected(storage::RejectionCode),
}

impl RemoteMutationOutcome {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Conflict => "conflict",
            Self::Rejected(_) => "rejected",
        }
    }

    #[must_use]
    pub fn code(self) -> Option<&'static str> {
        match self {
            Self::Applied => None,
            Self::Conflict => Some("EMBEDDED_CONFLICT"),
            Self::Rejected(code) => Some(code.as_str()),
        }
    }
}

/// One terminal mutation settlement produced after its local durable transaction commits.
///
/// Its fields remain private so an application-facing transport cannot pair an arbitrary code
/// with an outcome or report revisions from another settlement. Construct it through the private
/// producer below, after [`storage::EmbeddedStore::remote_settlement_write`] succeeds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteMutationSettlement {
    mutation_id: String,
    function: String,
    outcome: RemoteMutationOutcome,
    retained_revisions: Vec<storage::RetainedRevision>,
}

impl RemoteMutationSettlement {
    #[must_use]
    pub fn mutation_id(&self) -> &str {
        &self.mutation_id
    }

    #[must_use]
    pub fn function(&self) -> &str {
        &self.function
    }

    #[must_use]
    pub fn outcome(&self) -> RemoteMutationOutcome {
        self.outcome
    }

    #[must_use]
    pub fn retained_revisions(&self) -> &[storage::RetainedRevision] {
        &self.retained_revisions
    }

    /// Move the closed value across an FFI boundary without making it constructible there.
    #[must_use]
    pub fn into_parts(
        self,
    ) -> (
        String,
        String,
        RemoteMutationOutcome,
        Vec<storage::RetainedRevision>,
    ) {
        (
            self.mutation_id,
            self.function,
            self.outcome,
            self.retained_revisions,
        )
    }
}

/// Captures the validated response plus envelope identity before the store commits. Calling
/// [`Self::complete`] is deliberately deferred until that commit succeeds.
#[derive(Debug)]
pub(crate) struct RemoteMutationSettlementProducer {
    mutation_id: String,
    function: String,
    outcome: RemoteMutationOutcome,
}

impl RemoteMutationSettlementProducer {
    pub(crate) fn new(
        mutation_id: &str,
        function: &str,
        verdict: storage::PushVerdict,
    ) -> Option<Self> {
        let outcome = match verdict {
            storage::PushVerdict::Applied => RemoteMutationOutcome::Applied,
            storage::PushVerdict::Conflict => RemoteMutationOutcome::Conflict,
            storage::PushVerdict::Rejected(code) => RemoteMutationOutcome::Rejected(code),
            storage::PushVerdict::Rebase => return None,
        };
        Some(Self {
            mutation_id: mutation_id.to_owned(),
            function: function.to_owned(),
            outcome,
        })
    }

    #[must_use]
    pub(crate) fn complete(
        self,
        retained_revisions: Vec<storage::RetainedRevision>,
    ) -> RemoteMutationSettlement {
        RemoteMutationSettlement {
            mutation_id: self.mutation_id,
            function: self.function,
            outcome: self.outcome,
            retained_revisions,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteTick {
    /// Transport connectivity transition observed by the native actor.
    pub connected: Option<bool>,
    pub changed_tables: Vec<String>,
    pub rows_applied: usize,
    pub pull_attempted: usize,
    pub push_accepted: usize,
    pub push_attempted: usize,
    pub received: usize,
    pub reconnected: bool,
    pub pushed: usize,
    /// Replays the server rejected this tick; skipped so one poison record cannot wedge the pump.
    pub push_failed: usize,
    /// Push calls the server re-run reported as a conflict this tick (§2 `outcome=conflict`).
    pub push_conflicts: usize,
    /// Push calls whose CRDT witness must be refreshed before replay can continue.
    pub push_rebases: usize,
    /// Local after-images retained because an authoritative row displaced them.
    pub retained_revisions: Vec<storage::RetainedRevision>,
    /// Ordered terminal mutation settlements produced by durable local transactions this tick.
    pub settlements: Vec<RemoteMutationSettlement>,
    pub sent: usize,
    /// Durable push receipts the server accepted and the local store removed this tick.
    pub receipts_pushed: usize,
    pub store_jobs: usize,
    /// `RowChange` events applied from the remote pull stream this tick.
    pub pull_changes_applied: usize,
    /// Complete membership snapshots committed this tick.
    pub pull_snapshots: usize,
    /// Retained pull results this tick that failed to apply for a permanent (non-transient) reason —
    /// an incompatible, corrupt, or unsatisfiable checkpoint manifest. Each is reported once and then
    /// held without re-attempt until the live manifest changes, so one bad result cannot hot-loop the
    /// one-shot pull lane (V5 "reports a diagnostic, and does not silently choose or delete either").
    pub pull_diagnostics: usize,
    /// First permanent pull-application failure observed in this merged tick.
    pub pull_error: Option<String>,
    /// Retained-result cache keys whose entry this tick durably rewrote (Cut 7 §5). These watches
    /// are table-invisible by construction — a scalar/aggregate/transformed result changed server-side
    /// with no member/projection row — so the runtime reruns them by key, bypassing table invalidation.
    pub changed_results: Vec<String>,
    /// Authoritative durable and actor-owned work remaining after this turn.
    pub pending: Option<RemotePending>,
}

impl RemoteTick {
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn has_observable_progress(&self) -> bool {
        !self.changed_tables.is_empty()
            || self.connected.is_some()
            || self.rows_applied > 0
            || self.push_accepted > 0
            || self.push_failed > 0
            || self.push_conflicts > 0
            || self.push_rebases > 0
            || self.pushed > 0
            || !self.retained_revisions.is_empty()
            || !self.settlements.is_empty()
            || self.receipts_pushed > 0
            || self.pull_changes_applied > 0
            || self.pull_snapshots > 0
            || self.pull_diagnostics > 0
            || !self.changed_results.is_empty()
            || self.reconnected
    }

    #[cfg_attr(target_arch = "wasm32", allow(dead_code))]
    pub(crate) fn merge(&mut self, other: Self) {
        for table in other.changed_tables {
            if !self.changed_tables.contains(&table) {
                self.changed_tables.push(table);
            }
        }
        for key in other.changed_results {
            if !self.changed_results.contains(&key) {
                self.changed_results.push(key);
            }
        }
        self.rows_applied += other.rows_applied;
        if other.connected.is_some() {
            self.connected = other.connected;
        }
        self.pull_attempted += other.pull_attempted;
        self.push_accepted += other.push_accepted;
        self.push_attempted += other.push_attempted;
        self.received += other.received;
        self.reconnected |= other.reconnected;
        self.pushed += other.pushed;
        self.push_failed += other.push_failed;
        self.push_conflicts += other.push_conflicts;
        self.push_rebases += other.push_rebases;
        self.retained_revisions.extend(other.retained_revisions);
        self.settlements.extend(other.settlements);
        self.sent += other.sent;
        self.receipts_pushed += other.receipts_pushed;
        self.store_jobs += other.store_jobs;
        self.pull_changes_applied += other.pull_changes_applied;
        self.pull_snapshots += other.pull_snapshots;
        self.pull_diagnostics += other.pull_diagnostics;
        if self.pull_error.is_none() {
            self.pull_error = other.pull_error;
        }
        if other.pending.is_some() {
            self.pending = other.pending;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        RemoteMutationSettlement, RemoteMutationSettlementProducer, RemotePending, RemoteTick,
    };

    #[test]
    fn pending_is_empty_only_when_every_lane_is_clear() {
        assert!(RemotePending::default().is_empty());
        assert!(!RemotePending {
            mutations: 1,
            ..RemotePending::default()
        }
        .is_empty());
        assert!(!RemotePending {
            checkpoints: 1,
            ..RemotePending::default()
        }
        .is_empty());
        assert!(!RemotePending {
            inflight: 1,
            ..RemotePending::default()
        }
        .is_empty());
        assert!(!RemotePending {
            scope: 1,
            ..RemotePending::default()
        }
        .is_empty());
        assert!(!RemotePending {
            settlements: 1,
            ..RemotePending::default()
        }
        .is_empty());
        assert!(!RemotePending {
            uploads: 1,
            ..RemotePending::default()
        }
        .is_empty());
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn result_only_settlement_is_observable_without_network_chatter() {
        assert!(RemoteTick {
            push_accepted: 1,
            ..RemoteTick::default()
        }
        .has_observable_progress());
        assert!(!RemoteTick {
            received: 1,
            sent: 1,
            ..RemoteTick::default()
        }
        .has_observable_progress());
        assert!(RemoteTick {
            pushed: 1,
            ..RemoteTick::default()
        }
        .has_observable_progress());
    }

    #[test]
    fn settlements_merge_in_completion_order() {
        let first = RemoteMutationSettlementProducer::new(
            "first",
            "documents:write",
            storage::PushVerdict::Applied,
        )
        .expect("applied is terminal")
        .complete(Vec::new());
        let second = RemoteMutationSettlementProducer::new(
            "second",
            "documents:write",
            storage::PushVerdict::Conflict,
        )
        .expect("conflict is terminal")
        .complete(Vec::new());

        let mut tick = RemoteTick {
            settlements: vec![first],
            ..RemoteTick::default()
        };
        tick.merge(RemoteTick {
            settlements: vec![second],
            ..RemoteTick::default()
        });

        assert_eq!(
            tick.settlements
                .iter()
                .map(RemoteMutationSettlement::mutation_id)
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
    }

    #[test]
    fn terminal_settlement_keeps_its_own_retained_revisions() {
        let revision = storage::RetainedRevision {
            table: "documents".to_owned(),
            local_document_id: "documents|local".to_owned(),
            archived_rev_id: "rev:archived".to_owned(),
            server_rev_id: Some("rev:server".to_owned()),
            server_document_id: Some("documents|server".to_owned()),
            base_root_id: Some("root:base".to_owned()),
            base_node_id: Some("node:base".to_owned()),
            attached_node_id: Some("node:local".to_owned()),
            current_root_id: Some("root:server".to_owned()),
        };
        let settlement = RemoteMutationSettlementProducer::new(
            "mutation",
            "documents:write",
            storage::PushVerdict::Conflict,
        )
        .expect("conflict is terminal")
        .complete(vec![revision.clone()]);

        assert_eq!(settlement.retained_revisions(), [revision]);
    }
}
