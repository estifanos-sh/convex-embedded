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
    use super::{RemotePending, RemoteTick};

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
}
