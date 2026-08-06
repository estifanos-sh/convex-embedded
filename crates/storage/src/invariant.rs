//! Structural invariants of the local rev-graph: at most one `Current` rev per row and acyclic
//! parent edges. `check_rev_set` is pure and dependency-free; its only caller is
//! `store::debug_assert_rev_invariants`, gated on `#[cfg(debug_assertions)]`, so a release build
//! compiles the check out. Allow the resulting dead code in that configuration rather than
//! fragmenting the module with per-item cfgs.
#![cfg_attr(not(any(test, debug_assertions)), allow(dead_code))]

use std::collections::{HashMap, HashSet};

use crate::types::{RevLifecycle, RevState};

/// A violated structural invariant, with enough context to localize the offending row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Violation {
    /// A row has more than one `Current` rev — two histories both claim the visible projection.
    /// (Zero `Current` is allowed: a tombstoned or unpromoted-peer row projects to nothing.)
    CurrentCount {
        table: String,
        document_id: String,
        current: usize,
    },
    /// Following `parent` edges revisits a rev — the rev graph is not acyclic.
    /// (A `parent` that names a rev outside the set is allowed: it is dropped-history provenance,
    /// e.g. after an ancestor rev is deleted, not a structural break.)
    ParentCycle {
        table: String,
        document_id: String,
        rev_id: String,
    },
}

impl std::fmt::Display for Violation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Violation::CurrentCount {
                table,
                document_id,
                current,
            } => write!(
                f,
                "rev set for {table}/{document_id} has {current} Current revs, expected exactly 1",
            ),
            Violation::ParentCycle {
                table,
                document_id,
                rev_id,
            } => write!(
                f,
                "rev {table}/{document_id}#{rev_id} sits on a parent cycle (rev graph is not acyclic)",
            ),
        }
    }
}

/// Check the rev set of a single `(table, document_id)` row: at most one `Current`, and the parent
/// edges are acyclic. An empty set is vacuously valid. These are the *universal* invariants — true
/// after every operation — so they are safe to assert in-flight; stricter context-specific shapes
/// (e.g. "a live row has exactly one Current") belong in the tests that establish that context.
pub(crate) fn check_rev_set(revs: &[RevState]) -> Result<(), Violation> {
    let Some(first) = revs.first() else {
        return Ok(());
    };
    let row = &first.key.row;

    let current = revs
        .iter()
        .filter(|rev| matches!(rev.lifecycle, RevLifecycle::Current))
        .count();
    if current > 1 {
        return Err(Violation::CurrentCount {
            table: row.table.clone(),
            document_id: row.document_id.clone(),
            current,
        });
    }

    let mut parents: HashMap<&str, &str> = HashMap::with_capacity(revs.len());
    for rev in revs {
        if let Some(archived) = rev.lifecycle.archived() {
            parents.insert(rev.key.rev_id.as_str(), archived.parent.as_str());
        }
    }

    for rev in revs {
        let start = rev.key.rev_id.as_str();
        let mut seen: HashSet<&str> = HashSet::new();
        seen.insert(start);
        let mut cursor = start;
        while let Some(&parent) = parents.get(cursor) {
            if !seen.insert(parent) {
                return Err(Violation::ParentCycle {
                    table: row.table.clone(),
                    document_id: row.document_id.clone(),
                    rev_id: rev.key.rev_id.clone(),
                });
            }
            cursor = parent;
        }
    }

    Ok(())
}
