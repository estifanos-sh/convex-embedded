use std::fmt::Write;

use loro::{Container, ExportMode, Frontiers, LoroCounter, LoroDoc};
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};

use super::{
    canonical_json, ensure_mergeable_counter, ensure_mergeable_set, ensure_mergeable_text,
    json_to_loro_field, loro_error, loro_value_to_json, parse_json_value, set_member_key, ROOT,
};
use crate::error::StorageError;
use crate::types::{CrdtFieldKind, CrdtOperation};

const FIELD_VALUE: &str = "v";

/// Durable state of one CRDT field (§8-A): a single-container Loro document — the field's
/// text/counter/set under the root key [`FIELD_VALUE`] — re-homing the kept checkpoint+log merge
/// (`snapshot` + oldest-first `log` deltas + `frontier`) onto the one pull response. Plain fields never enter
/// Loro; only declared CRDT fields do, keyed `(space, table, id, field)` in the store.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub(crate) struct CrdtFieldState {
    pub snapshot: Vec<u8>,
    pub log: Vec<Vec<u8>>,
    pub frontier: Vec<u8>,
    pub server_epoch: i64,
    pub server_seq: i64,
    pub server_projection_hash: String,
    pub accepted: Option<CrdtAcceptedState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CrdtAcceptedState {
    pub snapshot: Vec<u8>,
    pub log: Vec<Vec<u8>>,
    pub frontier: Vec<u8>,
}

impl CrdtAcceptedState {
    fn read(state: &CrdtFieldState) -> Self {
        Self {
            snapshot: state.snapshot.clone(),
            log: state.log.clone(),
            frontier: state.frontier.clone(),
        }
    }
}

fn field_doc_from_state(
    state: Option<&CrdtFieldState>,
    peer_id: Option<u64>,
) -> Result<LoroDoc, StorageError> {
    let doc = LoroDoc::new();
    if let Some(peer_id) = peer_id {
        doc.set_peer_id(peer_id).map_err(loro_error)?;
    }
    if let Some(state) = state {
        if !state.snapshot.is_empty() {
            doc.import(&state.snapshot).map_err(loro_error)?;
        }
        for delta in &state.log {
            doc.import(delta).map_err(loro_error)?;
        }
        if !state.frontier.is_empty() {
            let frontier = Frontiers::decode(&state.frontier).map_err(loro_error)?;
            doc.checkout(&frontier).map_err(loro_error)?;
            doc.checkout_to_latest();
        }
    }
    Ok(doc)
}

/// Re-checkpoint a field doc with geometric log/snapshot amortization: the
/// `update` delta appends to the prior log until the accumulated log would exceed the checkpoint
/// size, then a fresh full snapshot resets it (amortized O(change), never O(history)).
fn field_checkpoint(
    doc: &LoroDoc,
    prev: Option<&CrdtFieldState>,
    update: &[u8],
) -> Result<CrdtFieldState, StorageError> {
    let frontier = doc.state_frontiers().encode();
    let checkpoint = match prev {
        Some(prev) if !prev.snapshot.is_empty() => {
            let log_bytes = prev.log.iter().map(Vec::len).sum::<usize>() + update.len();
            log_bytes >= prev.snapshot.len()
        }
        _ => true,
    };
    let (snapshot, log) = if checkpoint {
        (
            doc.export(ExportMode::snapshot()).map_err(loro_error)?,
            Vec::new(),
        )
    } else {
        let prev = prev.expect("append path implies an existing field state");
        let mut log = prev.log.clone();
        log.push(update.to_vec());
        (prev.snapshot.clone(), log)
    };
    Ok(CrdtFieldState {
        snapshot,
        log,
        frontier,
        server_epoch: prev.map_or(0, |state| state.server_epoch),
        server_seq: prev.map_or(0, |state| state.server_seq),
        server_projection_hash: prev
            .map_or_else(String::new, |state| state.server_projection_hash.clone()),
        accepted: prev.and_then(|state| state.accepted.clone()),
    })
}

/// Reserved Loro peer for the deterministic plain-value SEED op (§8-A). A CRDT field can hold an
/// initial PLAIN value (e.g. `ctx.db.insert` set `body:"MID"`) that never entered Loro; the first
/// local CRDT edit must seed that base so a splice at index > 0 lands. Every client seeds the SAME
/// plain value under this SAME fixed peer, so the seed ops are byte-identical and Loro dedups them on
/// merge — the base is never duplicated. `create_peer_id` is carved to never return this value, so a
/// real client peer can never collide with the seed peer.
pub(crate) const SEED_PEER: u64 = u64::MAX - 1;

/// Apply a local CRDT intent to a field, returning the new durable state and the Loro update delta
/// carried verbatim on the push envelope (`PushCall.crdt_ops`, §1/§8-A). `peer_id` is the client's
/// stable Loro peer so concurrent clients' ops stay attributable and merge. When the field has no
/// Loro state yet (`prev` is None) but the row carries a `seed` plain value, the base is seeded
/// deterministically under [`SEED_PEER`] before the client op, and the exported delta carries
/// seed+op so a receiver that never seeded still materializes the base.
pub(crate) fn crdt_field_apply(
    prev: Option<&CrdtFieldState>,
    kind: CrdtFieldKind,
    op: &CrdtOperation,
    peer_id: u64,
    seed: Option<&JsonValue>,
) -> Result<(CrdtFieldState, Vec<u8>), StorageError> {
    if prev.is_none() {
        if let Some(seed) = seed {
            let doc = LoroDoc::new();
            let base_vv = doc.oplog_vv();
            doc.set_peer_id(SEED_PEER).map_err(loro_error)?;
            apply_seed(&doc, kind, seed)?;
            doc.commit();
            doc.set_peer_id(peer_id).map_err(loro_error)?;
            apply_field_op(&doc, kind, op)?;
            doc.commit();
            let update = doc
                .export(ExportMode::updates(&base_vv))
                .map_err(loro_error)?;
            let state = field_checkpoint(&doc, prev, &update)?;
            return Ok((state, update));
        }
    }
    let doc = field_doc_from_state(prev, Some(peer_id))?;
    let base_vv = doc.oplog_vv();
    apply_field_op(&doc, kind, op)?;
    doc.commit();
    let update = doc
        .export(ExportMode::updates(&base_vv))
        .map_err(loro_error)?;
    let state = field_checkpoint(&doc, prev, &update)?;
    Ok((state, update))
}

/// Seed a fresh field doc with its initial plain value under [`SEED_PEER`] (text → insert at 0,
/// counter → the plain number, set → each member). Deterministic across clients.
fn apply_seed(doc: &LoroDoc, kind: CrdtFieldKind, seed: &JsonValue) -> Result<(), StorageError> {
    let root = doc.get_map(ROOT);
    match kind {
        CrdtFieldKind::Text => {
            if let Some(text) = seed.as_str().filter(|text| !text.is_empty()) {
                ensure_mergeable_text(&root, FIELD_VALUE)?
                    .insert(0, text)
                    .map_err(loro_error)?;
            }
        }
        CrdtFieldKind::Count => {
            if let Some(value) = seed.as_f64() {
                let counter = ensure_mergeable_counter(&root, FIELD_VALUE)?;
                apply_counter_delta(&counter, value)?;
            }
        }
        CrdtFieldKind::Set => {
            if let JsonValue::Array(members) = seed {
                let set = ensure_mergeable_set(&root, FIELD_VALUE)?;
                for member in members {
                    set.insert(&set_member_key(member)?, json_to_loro_field(member)?)
                        .map_err(loro_error)?;
                }
            }
        }
    }
    Ok(())
}

/// Merge a remote CRDT update (one pulled `crdt` `RowChange`, §3) into a field, returning the new
/// durable state. Commutative and order-independent — never a conflict.
pub(crate) fn crdt_field_merge(
    prev: Option<&CrdtFieldState>,
    update: &[u8],
) -> Result<CrdtFieldState, StorageError> {
    let doc = field_doc_from_state(prev, None)?;
    doc.import(update).map_err(loro_error)?;
    doc.commit();
    field_checkpoint(&doc, prev, update)
}

/// Materialize a field's merged value to JSON so the local replica column reads the merged text
/// (§8-A: clients materialize, the server never does).
pub(crate) fn crdt_field_value(
    state: &CrdtFieldState,
    kind: CrdtFieldKind,
) -> Result<JsonValue, StorageError> {
    field_value(&field_doc_from_state(Some(state), None)?, kind)
}

pub(crate) fn crdt_field_snapshot(state: &CrdtFieldState) -> Result<Vec<u8>, StorageError> {
    field_doc_from_state(Some(state), None)?
        .export(ExportMode::snapshot())
        .map_err(loro_error)
}

/// Rebuild the exact immutable server prefix named by a checkpoint request.
/// The caller supplies the complete checkpoint-covered pull result, so this
/// never consults optimistic local state or performs server-side CRDT work.
pub fn crdt_checkpoint_response(
    kind: CrdtFieldKind,
    checkpoint: &[u8],
    checkpoint_seq: i64,
    updates: &[Vec<u8>],
    request: &crate::types::CrdtCheckpointRequest,
) -> Result<crate::types::CrdtCheckpoint, StorageError> {
    let offset = request
        .through_seq
        .checked_sub(checkpoint_seq)
        .ok_or_else(|| {
            StorageError::Unsatisfiable(
                "CRDT checkpoint request precedes the retained ready checkpoint".to_owned(),
            )
        })?;
    let count = usize::try_from(offset).map_err(|_| {
        StorageError::Unsatisfiable(
            "CRDT checkpoint request sequence exceeds local address space".to_owned(),
        )
    })?;
    if count > updates.len() {
        return Err(StorageError::Unsatisfiable(
            "CRDT checkpoint request is not covered by the retained payload tail".to_owned(),
        ));
    }
    let mut state = crdt_field_restore(checkpoint, checkpoint_seq, String::new())?;
    for update in &updates[..count] {
        state = crdt_field_merge(Some(&state), update)?;
    }
    let projection_hash = crdt_field_projection_hash(&state, kind)?;
    if projection_hash != request.projection_hash {
        return Err(StorageError::Unsatisfiable(
            "CRDT checkpoint response does not match the requested projection".to_owned(),
        ));
    }
    let bytes = crdt_field_snapshot(&state)?;
    let hash = Sha256::digest(&bytes).iter().fold(
        String::with_capacity(Sha256::output_size() * 2),
        |mut encoded, byte| {
            write!(encoded, "{byte:02x}").expect("writing to a String cannot fail");
            encoded
        },
    );
    Ok(crate::types::CrdtCheckpoint {
        through_seq: request.through_seq,
        bytes,
        hash,
    })
}

pub(crate) fn crdt_field_projection_hash(
    state: &CrdtFieldState,
    kind: CrdtFieldKind,
) -> Result<String, StorageError> {
    let value = crdt_field_value(state, kind)?;
    let bytes = serde_json::to_vec(&canonical_json(&value)).map_err(|error| {
        StorageError::Unsatisfiable(format!("CRDT projection JSON encode failed: {error}"))
    })?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().fold(
        String::with_capacity(digest.len() * 2),
        |mut encoded, byte| {
            write!(encoded, "{byte:02x}").expect("writing to a String cannot fail");
            encoded
        },
    ))
}

pub(crate) fn crdt_field_restore(
    bytes: &[u8],
    head_seq: i64,
    projection_hash: String,
) -> Result<CrdtFieldState, StorageError> {
    let doc = LoroDoc::new();
    doc.import(bytes).map_err(loro_error)?;
    doc.commit();
    Ok(CrdtFieldState {
        snapshot: doc.export(ExportMode::snapshot()).map_err(loro_error)?,
        log: Vec::new(),
        frontier: doc.state_frontiers().encode(),
        server_epoch: 0,
        server_seq: head_seq,
        server_projection_hash: projection_hash,
        accepted: None,
    })
}
/// Merge a complete checkpoint-covered remote result into the accepted local field.
/// Loro's idempotent merge preserves local optimistic operations while the remote
/// subscription delivers its next complete result.
pub(crate) fn crdt_field_accept(
    accepted: Option<&CrdtFieldState>,
    kind: CrdtFieldKind,
    checkpoint: &[u8],
    updates: &[Vec<u8>],
    epoch: i64,
    head_seq: i64,
    projection_hash: String,
) -> Result<CrdtFieldState, StorageError> {
    let mut remote = crdt_field_restore(checkpoint, 0, String::new())?;
    for update in updates {
        remote = crdt_field_merge(Some(&remote), update)?;
    }
    if crdt_field_projection_hash(&remote, kind)? != projection_hash {
        return Err(StorageError::Unsatisfiable(
            "CRDT pull projection hash does not match its checkpoint and payload tail".to_owned(),
        ));
    }
    let remote_accepted = CrdtAcceptedState::read(&remote);
    let snapshot = crdt_field_snapshot(&remote)?;
    let mut accepted = crdt_field_merge(accepted, &snapshot)?;
    accepted.server_epoch = epoch;
    accepted.server_seq = head_seq;
    accepted.server_projection_hash = projection_hash;
    accepted.accepted = Some(remote_accepted);
    Ok(accepted)
}

/// Merge one authoritative next-head payload into the accepted base while preserving local
/// optimistic operations in the visible field state.
pub(crate) fn crdt_field_accept_incremental(
    current: &CrdtFieldState,
    kind: CrdtFieldKind,
    update: &[u8],
    epoch: i64,
    head_seq: i64,
    projection_hash: String,
) -> Result<CrdtFieldState, StorageError> {
    if current.server_epoch != epoch || current.server_seq + 1 != head_seq {
        return Err(StorageError::Unsatisfiable(
            "incremental CRDT pull does not follow the accepted server head".to_owned(),
        ));
    }
    let base = accepted_state(current)?.ok_or_else(|| {
        StorageError::Unsatisfiable(
            "incremental CRDT pull requires an accepted causal base".to_owned(),
        )
    })?;
    let remote = crdt_field_merge(Some(&base), update)?;
    if crdt_field_projection_hash(&remote, kind)? != projection_hash {
        return Err(StorageError::Unsatisfiable(
            "incremental CRDT pull projection does not match its payload".to_owned(),
        ));
    }
    let remote_accepted = CrdtAcceptedState::read(&remote);
    let snapshot = crdt_field_snapshot(&remote)?;
    let mut merged = crdt_field_merge(Some(current), &snapshot)?;
    merged.server_epoch = epoch;
    merged.server_seq = head_seq;
    merged.server_projection_hash = projection_hash;
    merged.accepted = Some(remote_accepted);
    Ok(merged)
}

fn accepted_state(state: &CrdtFieldState) -> Result<Option<CrdtFieldState>, StorageError> {
    let Some(accepted) = &state.accepted else {
        if state.server_seq == 0 {
            return Ok(None);
        }
        return Err(StorageError::Unsatisfiable(
            "CRDT server head has no accepted causal state".to_owned(),
        ));
    };
    Ok(Some(CrdtFieldState {
        snapshot: accepted.snapshot.clone(),
        log: accepted.log.clone(),
        frontier: accepted.frontier.clone(),
        server_epoch: state.server_epoch,
        server_seq: state.server_seq,
        server_projection_hash: state.server_projection_hash.clone(),
        accepted: Some(accepted.clone()),
    }))
}

pub(crate) fn crdt_field_remote_effect(
    state: &CrdtFieldState,
    kind: CrdtFieldKind,
    prior_payloads: &[Vec<u8>],
    payload: &[u8],
) -> Result<crate::types::CrdtRemoteEffect, StorageError> {
    let mut base = accepted_state(state)?;
    for prior in prior_payloads {
        base = Some(crdt_field_merge(base.as_ref(), prior)?);
    }
    let next = crdt_field_merge(base.as_ref(), payload)?;
    let prefix_len = i64::try_from(prior_payloads.len()).map_err(|_| {
        StorageError::Unsatisfiable("CRDT speculative prefix is too large".to_owned())
    })?;
    let base_seq = state
        .server_seq
        .checked_add(prefix_len)
        .ok_or_else(|| StorageError::Unsatisfiable("CRDT sequence overflow".to_owned()))?;
    let checkpoint = if base_seq == 0 {
        let bytes = crdt_field_snapshot(&next)?;
        let hash = Sha256::digest(&bytes).iter().fold(
            String::with_capacity(Sha256::output_size() * 2),
            |mut encoded, byte| {
                write!(encoded, "{byte:02x}").expect("writing to a String cannot fail");
                encoded
            },
        );
        Some(crate::types::CrdtCheckpoint {
            through_seq: 1,
            bytes,
            hash,
        })
    } else {
        None
    };
    Ok(crate::types::CrdtRemoteEffect {
        base_seq,
        projection: crdt_field_value(&next, kind)?,
        checkpoint,
    })
}

pub(crate) fn crdt_field_settle(
    state: &mut CrdtFieldState,
    kind: CrdtFieldKind,
    payload: &[u8],
    head_seq: i64,
    projection_hash: &str,
) -> Result<(), StorageError> {
    if head_seq != state.server_seq + 1 {
        return Err(StorageError::Unsatisfiable(format!(
            "CRDT settlement sequence is not contiguous: local={}, settled={head_seq}",
            state.server_seq
        )));
    }
    let base = accepted_state(state)?;
    let next = crdt_field_merge(base.as_ref(), payload)?;
    if crdt_field_projection_hash(&next, kind)? != projection_hash {
        return Err(StorageError::Unsatisfiable(
            "CRDT settlement projection does not match its payload".to_owned(),
        ));
    }
    state.server_seq = head_seq;
    projection_hash.clone_into(&mut state.server_projection_hash);
    state.accepted = Some(CrdtAcceptedState::read(&next));
    Ok(())
}

pub(crate) fn crdt_field_reject(state: &CrdtFieldState) -> Option<CrdtFieldState> {
    let accepted = state.accepted.as_ref()?;
    Some(CrdtFieldState {
        snapshot: accepted.snapshot.clone(),
        log: accepted.log.clone(),
        frontier: accepted.frontier.clone(),
        server_epoch: state.server_epoch,
        server_seq: state.server_seq,
        server_projection_hash: state.server_projection_hash.clone(),
        accepted: Some(accepted.clone()),
    })
}

/// Apply a signed counter delta, rejecting a non-finite delta or a result that overflowed to a
/// non-finite value so a poison operation is refused rather than silently dropped.
fn apply_counter_delta(counter: &LoroCounter, delta: f64) -> Result<(), StorageError> {
    if !delta.is_finite() {
        return Err(StorageError::Unsatisfiable(format!(
            "CRDT count delta must be finite, got {delta}"
        )));
    }
    if delta > 0.0 {
        counter.increment(delta).map_err(loro_error)?;
    } else if delta < 0.0 {
        counter.decrement(-delta).map_err(loro_error)?;
    }
    if !counter.get().is_finite() {
        return Err(StorageError::Unsatisfiable(format!(
            "CRDT count overflowed to a non-finite value: {}",
            counter.get()
        )));
    }
    Ok(())
}

fn apply_field_op(
    doc: &LoroDoc,
    kind: CrdtFieldKind,
    op: &CrdtOperation,
) -> Result<(), StorageError> {
    let root = doc.get_map(ROOT);
    match (kind, op) {
        (CrdtFieldKind::Count, CrdtOperation::CountAdd { delta }) => {
            let counter = ensure_mergeable_counter(&root, FIELD_VALUE)?;
            apply_counter_delta(&counter, *delta)?;
        }
        (CrdtFieldKind::Set, CrdtOperation::SetAdd { value_json }) => {
            let value = parse_json_value(value_json)?;
            let set = ensure_mergeable_set(&root, FIELD_VALUE)?;
            set.insert(&set_member_key(&value)?, json_to_loro_field(&value)?)
                .map_err(loro_error)?;
        }
        (CrdtFieldKind::Set, CrdtOperation::SetDelete { value_json }) => {
            let value = parse_json_value(value_json)?;
            let set = ensure_mergeable_set(&root, FIELD_VALUE)?;
            set.delete(&set_member_key(&value)?).map_err(loro_error)?;
        }
        (
            CrdtFieldKind::Text,
            CrdtOperation::TextSplice {
                index,
                delete,
                insert,
            },
        ) => {
            let text = ensure_mergeable_text(&root, FIELD_VALUE)?;
            let index = usize::try_from(*index).map_err(|_| StorageError::Decode {
                expected: "nonnegative text splice index",
                index: 0,
                got: index.to_string(),
            })?;
            let delete = usize::try_from(*delete).map_err(|_| StorageError::Decode {
                expected: "nonnegative text splice delete",
                index: 0,
                got: delete.to_string(),
            })?;
            if delete > 0 {
                text.delete(index, delete).map_err(loro_error)?;
            }
            if !insert.is_empty() {
                text.insert(index, insert).map_err(loro_error)?;
            }
        }
        (kind, _) => {
            return Err(StorageError::Unsatisfiable(format!(
                "crdt op does not match field kind {}",
                kind.as_wire()
            )));
        }
    }
    Ok(())
}

fn field_value(doc: &LoroDoc, kind: CrdtFieldKind) -> Result<JsonValue, StorageError> {
    let root = doc.get_map(ROOT);
    let container = root.get(FIELD_VALUE).and_then(|v| v.into_container().ok());
    match kind {
        CrdtFieldKind::Text => match container {
            Some(Container::Text(text)) => Ok(JsonValue::String(text.to_string())),
            _ => Ok(JsonValue::String(String::new())),
        },
        CrdtFieldKind::Count => match container {
            Some(Container::Counter(counter)) => serde_json::Number::from_f64(counter.get())
                .map(JsonValue::Number)
                .ok_or_else(|| StorageError::Decode {
                    expected: "finite embedded count number",
                    index: 0,
                    got: counter.get().to_string(),
                }),
            _ => Ok(JsonValue::Number(0.into())),
        },
        CrdtFieldKind::Set => match root.get(FIELD_VALUE) {
            Some(value) => loro_value_to_json(&value.get_deep_value()),
            None => Ok(JsonValue::Array(Vec::new())),
        },
    }
}

#[cfg(test)]
mod field_tests {
    use super::*;

    fn splice(index: i64, delete: i64, insert: &str) -> CrdtOperation {
        CrdtOperation::TextSplice {
            index,
            delete,
            insert: insert.to_owned(),
        }
    }

    #[test]
    fn text_apply_then_materialize() {
        let (mut state, _) =
            crdt_field_apply(None, CrdtFieldKind::Text, &splice(0, 0, "hello"), 1, None).unwrap();
        state.server_projection_hash = "hosted-before-local-edit".to_owned();
        assert_eq!(
            crdt_field_value(&state, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("hello".to_owned())
        );
        assert_eq!(
            crdt_field_projection_hash(&state, CrdtFieldKind::Text).unwrap(),
            "5aa762ae383fbb727af3c7a36d4940a5b8c40a989452d2304fc958ff3f354e7a"
        );
    }

    #[test]
    fn concurrent_text_edits_converge_by_merge() {
        let (_, base_update) =
            crdt_field_apply(None, CrdtFieldKind::Text, &splice(0, 0, "ab"), 1, None).unwrap();
        let peer_a = crdt_field_merge(None, &base_update).unwrap();
        let peer_b = crdt_field_merge(None, &base_update).unwrap();
        let (a_state, a_update) = crdt_field_apply(
            Some(&peer_a),
            CrdtFieldKind::Text,
            &splice(1, 0, "X"),
            1,
            None,
        )
        .unwrap();
        let (b_state, b_update) = crdt_field_apply(
            Some(&peer_b),
            CrdtFieldKind::Text,
            &splice(2, 0, "Y"),
            2,
            None,
        )
        .unwrap();
        let a_final = crdt_field_merge(Some(&a_state), &b_update).unwrap();
        let b_final = crdt_field_merge(Some(&b_state), &a_update).unwrap();
        assert_eq!(
            crdt_field_value(&a_final, CrdtFieldKind::Text).unwrap(),
            crdt_field_value(&b_final, CrdtFieldKind::Text).unwrap(),
            "concurrent splices must converge to the same merged text"
        );
    }

    #[test]
    fn concurrent_seed_from_plain_converges_without_base_duplication() {
        let seed = JsonValue::String("MID".to_owned());
        let (a_state, a_update) = crdt_field_apply(
            None,
            CrdtFieldKind::Text,
            &splice(0, 0, "A-"),
            1,
            Some(&seed),
        )
        .unwrap();
        let (b_state, b_update) = crdt_field_apply(
            None,
            CrdtFieldKind::Text,
            &splice(3, 0, "-B"),
            2,
            Some(&seed),
        )
        .unwrap();
        assert_eq!(
            crdt_field_value(&a_state, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("A-MID".to_owned())
        );
        assert_eq!(
            crdt_field_value(&b_state, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("MID-B".to_owned())
        );
        let a_final = crdt_field_merge(Some(&a_state), &b_update).unwrap();
        let b_final = crdt_field_merge(Some(&b_state), &a_update).unwrap();
        assert_eq!(
            crdt_field_value(&a_final, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("A-MID-B".to_owned()),
            "independent identical seeds must dedup, not duplicate the base"
        );
        assert_eq!(
            crdt_field_value(&b_final, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("A-MID-B".to_owned())
        );
    }

    #[test]
    fn seed_peer_is_the_reserved_sentinel() {
        assert_eq!(SEED_PEER, u64::MAX - 1);
    }

    #[test]
    fn self_echo_merge_is_idempotent() {
        let seed = JsonValue::String("MID".to_owned());
        let (state, update) = crdt_field_apply(
            None,
            CrdtFieldKind::Text,
            &splice(3, 0, "-B"),
            7,
            Some(&seed),
        )
        .unwrap();
        assert_eq!(
            crdt_field_value(&state, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("MID-B".to_owned())
        );
        let echoed = crdt_field_merge(Some(&state), &update).unwrap();
        assert_eq!(
            crdt_field_value(&echoed, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("MID-B".to_owned()),
            "pulling back one's own pushed update must be an idempotent no-op"
        );
        let twice = crdt_field_merge(Some(&echoed), &update).unwrap();
        assert_eq!(
            crdt_field_value(&twice, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("MID-B".to_owned())
        );
    }

    #[test]
    fn checkpoint_covered_tail_keeps_the_accepted_causal_base() {
        let (accepted, _) =
            crdt_field_apply(None, CrdtFieldKind::Text, &splice(0, 0, "abcA"), 1, None).unwrap();
        let (_, dependent_update) = crdt_field_apply(
            Some(&accepted),
            CrdtFieldKind::Text,
            &splice(4, 0, "B"),
            2,
            None,
        )
        .unwrap();

        let checkpoint = crdt_field_snapshot(&accepted).unwrap();
        let mut remote = crdt_field_restore(&checkpoint, 0, String::new()).unwrap();
        remote = crdt_field_merge(Some(&remote), &dependent_update).unwrap();
        let projection_hash = crdt_field_projection_hash(&remote, CrdtFieldKind::Text).unwrap();
        let merged = crdt_field_accept(
            Some(&accepted),
            CrdtFieldKind::Text,
            &checkpoint,
            &[dependent_update],
            0,
            2,
            projection_hash,
        )
        .unwrap();

        assert_eq!(
            crdt_field_value(&merged, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("abcAB".to_owned()),
            "a checkpoint-covered tail must merge over its accepted causal base"
        );
    }

    #[test]
    fn incremental_head_preserves_optimistic_local_state() {
        let (seed, _) =
            crdt_field_apply(None, CrdtFieldKind::Text, &splice(0, 0, "a"), 1, None).unwrap();
        let checkpoint = crdt_field_snapshot(&seed).unwrap();
        let seed_hash = crdt_field_projection_hash(&seed, CrdtFieldKind::Text).unwrap();
        let accepted =
            crdt_field_accept(None, CrdtFieldKind::Text, &checkpoint, &[], 3, 1, seed_hash)
                .unwrap();
        let (optimistic, _) = crdt_field_apply(
            Some(&accepted),
            CrdtFieldKind::Text,
            &splice(1, 0, "L"),
            11,
            None,
        )
        .unwrap();
        let (remote, remote_payload) = crdt_field_apply(
            Some(&accepted),
            CrdtFieldKind::Text,
            &splice(1, 0, "R"),
            12,
            None,
        )
        .unwrap();
        let remote_hash = crdt_field_projection_hash(&remote, CrdtFieldKind::Text).unwrap();

        let merged = crdt_field_accept_incremental(
            &optimistic,
            CrdtFieldKind::Text,
            &remote_payload,
            3,
            2,
            remote_hash,
        )
        .unwrap();

        let JsonValue::String(visible) = crdt_field_value(&merged, CrdtFieldKind::Text).unwrap()
        else {
            panic!("text CRDT must materialize as a string");
        };
        assert!(visible.contains('L'));
        assert!(visible.contains('R'));
        assert_eq!(merged.server_seq, 2);
        assert_eq!(
            crdt_field_value(&crdt_field_reject(&merged).unwrap(), CrdtFieldKind::Text).unwrap(),
            crdt_field_value(&remote, CrdtFieldKind::Text).unwrap(),
            "rejection must discard the optimistic edit and retain the incremental server head"
        );
    }

    #[test]
    fn queued_effects_advance_only_their_exact_accepted_prefix() {
        let (first, first_payload) =
            crdt_field_apply(None, CrdtFieldKind::Text, &splice(0, 0, "a"), 1, None).unwrap();
        let (mut optimistic, second_payload) = crdt_field_apply(
            Some(&first),
            CrdtFieldKind::Text,
            &splice(1, 0, "b"),
            1,
            None,
        )
        .unwrap();

        let first_effect =
            crdt_field_remote_effect(&optimistic, CrdtFieldKind::Text, &[], &first_payload)
                .unwrap();
        assert_eq!(first_effect.base_seq, 0);
        assert_eq!(first_effect.projection, JsonValue::String("a".to_owned()));
        assert!(first_effect.checkpoint.is_some());
        let first_hash = crdt_field_projection_hash(&first, CrdtFieldKind::Text).unwrap();
        crdt_field_settle(
            &mut optimistic,
            CrdtFieldKind::Text,
            &first_payload,
            1,
            &first_hash,
        )
        .unwrap();
        assert_eq!(
            crdt_field_value(&optimistic, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("ab".to_owned()),
            "settling the first payload must preserve the later optimistic edit"
        );

        let second_effect =
            crdt_field_remote_effect(&optimistic, CrdtFieldKind::Text, &[], &second_payload)
                .unwrap();
        assert_eq!(second_effect.base_seq, 1);
        assert_eq!(second_effect.projection, JsonValue::String("ab".to_owned()));
        assert!(second_effect.checkpoint.is_none());
        let second_hash = crdt_field_projection_hash(&optimistic, CrdtFieldKind::Text).unwrap();
        crdt_field_settle(
            &mut optimistic,
            CrdtFieldKind::Text,
            &second_payload,
            2,
            &second_hash,
        )
        .unwrap();
        let accepted = crdt_field_reject(&optimistic).unwrap();
        assert_eq!(
            crdt_field_value(&accepted, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("ab".to_owned())
        );
    }

    #[test]
    fn speculative_effects_advance_without_mutating_the_accepted_prefix() {
        let (first, first_payload) =
            crdt_field_apply(None, CrdtFieldKind::Text, &splice(0, 0, "a"), 1, None).unwrap();
        let (_, second_payload) = crdt_field_apply(
            Some(&first),
            CrdtFieldKind::Text,
            &splice(1, 0, "b"),
            1,
            None,
        )
        .unwrap();

        let speculative = crdt_field_remote_effect(
            &first,
            CrdtFieldKind::Text,
            std::slice::from_ref(&first_payload),
            &second_payload,
        )
        .unwrap();

        assert_eq!(speculative.base_seq, 1);
        assert_eq!(speculative.projection, JsonValue::String("ab".to_owned()));
        assert!(speculative.checkpoint.is_none());
        assert_eq!(first.server_seq, 0);
        assert!(first.accepted.is_none());
    }

    #[test]
    fn counter_and_set_materialize() {
        let (count, _) = crdt_field_apply(
            None,
            CrdtFieldKind::Count,
            &CrdtOperation::CountAdd { delta: 3.0 },
            1,
            None,
        )
        .unwrap();
        assert_eq!(
            crdt_field_value(&count, CrdtFieldKind::Count).unwrap(),
            JsonValue::Number(serde_json::Number::from_f64(3.0).unwrap())
        );

        let (set, _) = crdt_field_apply(
            None,
            CrdtFieldKind::Set,
            &CrdtOperation::SetAdd {
                value_json: "\"x\"".to_owned(),
            },
            1,
            None,
        )
        .unwrap();
        assert_eq!(
            crdt_field_value(&set, CrdtFieldKind::Set).unwrap(),
            JsonValue::Array(vec![JsonValue::String("x".to_owned())])
        );
    }

    #[test]
    fn counter_rejects_non_finite_delta() {
        for delta in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let error = crdt_field_apply(
                None,
                CrdtFieldKind::Count,
                &CrdtOperation::CountAdd { delta },
                1,
                None,
            )
            .unwrap_err();
            assert!(
                matches!(error, StorageError::Unsatisfiable(_)),
                "delta {delta} produced {error:?}"
            );
        }
    }

    #[test]
    fn counter_rejects_overflow_to_non_finite() {
        let (base, _) = crdt_field_apply(
            None,
            CrdtFieldKind::Count,
            &CrdtOperation::CountAdd { delta: f64::MAX },
            1,
            None,
        )
        .unwrap();
        assert_eq!(
            crdt_field_value(&base, CrdtFieldKind::Count).unwrap(),
            JsonValue::Number(serde_json::Number::from_f64(f64::MAX).unwrap())
        );
        let error = crdt_field_apply(
            Some(&base),
            CrdtFieldKind::Count,
            &CrdtOperation::CountAdd { delta: f64::MAX },
            1,
            None,
        )
        .unwrap_err();
        assert!(
            matches!(error, StorageError::Unsatisfiable(_)),
            "overflow produced {error:?}"
        );
    }

    #[test]
    fn counter_and_set_seed_from_plain() {
        let (count, _) = crdt_field_apply(
            None,
            CrdtFieldKind::Count,
            &CrdtOperation::CountAdd { delta: 2.0 },
            1,
            Some(&JsonValue::Number(
                serde_json::Number::from_f64(5.0).unwrap(),
            )),
        )
        .unwrap();
        assert_eq!(
            crdt_field_value(&count, CrdtFieldKind::Count).unwrap(),
            JsonValue::Number(serde_json::Number::from_f64(7.0).unwrap())
        );

        let seed = JsonValue::Array(vec![JsonValue::String("a".to_owned())]);
        let (set, _) = crdt_field_apply(
            None,
            CrdtFieldKind::Set,
            &CrdtOperation::SetAdd {
                value_json: "\"b\"".to_owned(),
            },
            1,
            Some(&seed),
        )
        .unwrap();
        let JsonValue::Array(members) = crdt_field_value(&set, CrdtFieldKind::Set).unwrap() else {
            panic!("set materializes to an array");
        };
        assert_eq!(members.len(), 2);
        assert!(members.contains(&JsonValue::String("a".to_owned())));
        assert!(members.contains(&JsonValue::String("b".to_owned())));
    }

    #[test]
    fn checkpoint_covered_history_promotes_directly() {
        let (first, _first_update) =
            crdt_field_apply(None, CrdtFieldKind::Text, &splice(0, 0, "a"), 1, None).unwrap();
        let (_, second_update) = crdt_field_apply(
            Some(&first),
            CrdtFieldKind::Text,
            &splice(1, 0, "b"),
            1,
            None,
        )
        .unwrap();
        let checkpoint = crdt_field_snapshot(&first).unwrap();
        let mut remote = crdt_field_restore(&checkpoint, 0, String::new()).unwrap();
        remote = crdt_field_merge(Some(&remote), &second_update).unwrap();
        let projection_hash = crdt_field_projection_hash(&remote, CrdtFieldKind::Text).unwrap();
        let accepted = crdt_field_accept(
            None,
            CrdtFieldKind::Text,
            &checkpoint,
            &[second_update],
            3,
            2,
            projection_hash,
        )
        .unwrap();
        assert_eq!(accepted.server_epoch, 3);
        assert_eq!(accepted.server_seq, 2);
        assert_eq!(
            crdt_field_value(&accepted, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("ab".to_owned())
        );
    }

    #[test]
    fn checkpoint_response_rebuilds_only_the_requested_prefix() {
        let (first, _) =
            crdt_field_apply(None, CrdtFieldKind::Text, &splice(0, 0, "a"), 1, None).unwrap();
        let (second, second_update) = crdt_field_apply(
            Some(&first),
            CrdtFieldKind::Text,
            &splice(1, 0, "b"),
            1,
            None,
        )
        .unwrap();
        let (_, third_update) = crdt_field_apply(
            Some(&second),
            CrdtFieldKind::Text,
            &splice(2, 0, "c"),
            1,
            None,
        )
        .unwrap();
        let checkpoint = crdt_field_snapshot(&first).unwrap();
        let request = crate::types::CrdtCheckpointRequest {
            checkpoint_id: "checkpoint".to_owned(),
            response_token: "token".to_owned(),
            through_seq: 2,
            projection_hash: crdt_field_projection_hash(&second, CrdtFieldKind::Text).unwrap(),
        };

        let response = crdt_checkpoint_response(
            CrdtFieldKind::Text,
            &checkpoint,
            1,
            &[second_update, third_update],
            &request,
        )
        .unwrap();
        let rebuilt = crdt_field_restore(&response.bytes, 2, String::new()).unwrap();

        assert_eq!(
            crdt_field_value(&rebuilt, CrdtFieldKind::Text).unwrap(),
            JsonValue::String("ab".to_owned())
        );
    }
}
