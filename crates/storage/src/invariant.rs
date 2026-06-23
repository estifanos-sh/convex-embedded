//! Structural invariants of the local rev-graph and id-mapping.
//!
//! `check_id_mappings` (and its `ConvexIdCollision` variant) is exercised only through the
//! whole-store oracle in `testkit`; the in-flight `debug_assert` checks only the rev set. In a
//! debug build without the `testkit` feature it is therefore unused — allow that rather than
//! fragmenting the module with per-item cfgs.
#![cfg_attr(not(any(test, feature = "testkit")), allow(dead_code))]
//!
//! These are the properties the model simulator asserts and that future `debug_assert!` wiring will
//! probe from inside the store's mutating paths. They are pure and dependency-free so the identical
//! checks run in integration tests (via [`crate::testkit`]), in the simulator oracle, and — later —
//! as in-flight assertions in [`crate::store`].

use std::collections::{HashMap, HashSet};

use crate::types::{IdMapping, IdMappingContent, RevLifecycle, RevState};

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
    /// Two non-deleted id mappings in one table share a `convex_id`.
    ConvexIdCollision {
        table: String,
        convex_id: String,
        local_ids: (String, String),
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
            Violation::ConvexIdCollision {
                table,
                convex_id,
                local_ids,
            } => write!(
                f,
                "convex_id {convex_id} in {table} maps to two live local ids: {} and {}",
                local_ids.0, local_ids.1,
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

/// Check that no two non-deleted id mappings in one table share a `convex_id` — the 1:1 server↔local
/// mapping that makes a silent projection overwrite unconstructible.
pub(crate) fn check_id_mappings(table: &str, mappings: &[IdMapping]) -> Result<(), Violation> {
    let mut by_convex: HashMap<&str, &str> = HashMap::with_capacity(mappings.len());
    for mapping in mappings {
        if matches!(mapping.mapping, IdMappingContent::Deleted { .. }) {
            continue;
        }
        let Some(convex_id) = mapping.convex_id() else {
            continue;
        };
        if let Some(&existing) = by_convex.get(convex_id) {
            return Err(Violation::ConvexIdCollision {
                table: table.to_owned(),
                convex_id: convex_id.to_owned(),
                local_ids: (existing.to_owned(), mapping.local_id.clone()),
            });
        }
        by_convex.insert(convex_id, mapping.local_id.as_str());
    }
    Ok(())
}
