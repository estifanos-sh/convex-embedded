use serde::{Deserialize, Serialize};

/// A value extracted for an indexed/queryable column or bound. User-extracted index columns are
/// stored as the order-preserving byte key produced by [`ColValue::encode_key`] (see below);
/// `Undefined` is distinct from `Null` because Convex orders a missing field before an explicit
/// null.
#[derive(Debug, Clone, PartialEq)]
pub enum ColValue {
    Undefined,
    Null,
    Text(String),
    Real(f64),
    Integer(i64),
    Bool(bool),
}

impl ColValue {
    /// Encode this value into an order-preserving byte key: `memcmp` over two keys equals Convex
    /// `compareValues` over the two values. A leading tag byte = the Convex type ordinal
    /// (undefined < null < int64 < float64 < boolean < string), then an order-preserving payload.
    /// User-extracted index columns store this key as a `BLOB`, so the `SQLite` B-tree is already in
    /// exact Convex order — no JS reorder needed.
    ///
    /// Floats use the standard IEEE-754 big-endian total-order transform: exact for every finite
    /// value, ±0 (`-0` strictly below `+0`), ±Infinity, and any NaN a JS program can produce (all
    /// JS NaNs share one bit pattern, which sorts after every non-NaN number, matching Convex).
    /// The only divergence is the relative order of *distinct* same-sign NaN payloads, which
    /// Convex tie-breaks by little-endian bits — unreachable without hand-built typed arrays.
    #[must_use]
    pub fn encode_key(&self) -> Vec<u8> {
        match self {
            ColValue::Undefined => vec![0x00],
            ColValue::Null => vec![0x01],
            ColValue::Integer(n) => {
                let mut out = Vec::with_capacity(9);
                out.push(0x02);
                out.extend_from_slice(&((*n as u64) ^ 0x8000_0000_0000_0000).to_be_bytes());
                out
            }
            ColValue::Real(f) => {
                let bits = f.to_bits();
                let key = if bits & 0x8000_0000_0000_0000 != 0 {
                    !bits
                } else {
                    bits ^ 0x8000_0000_0000_0000
                };
                let mut out = Vec::with_capacity(9);
                out.push(0x03);
                out.extend_from_slice(&key.to_be_bytes());
                out
            }
            ColValue::Bool(b) => vec![0x04, u8::from(*b)],
            ColValue::Text(s) => {
                let mut out = Vec::with_capacity(1 + s.len());
                out.push(0x05);
                out.extend_from_slice(s.as_bytes());
                out
            }
        }
    }

    /// Inverse of [`ColValue::encode_key`]; reconstructs the value from a stored order key so the
    /// store can mint cursors from the last row of a page.
    #[must_use]
    pub fn decode_key(bytes: &[u8]) -> Option<ColValue> {
        match bytes.first()? {
            0x00 => Some(ColValue::Undefined),
            0x01 => Some(ColValue::Null),
            0x02 => {
                let raw = u64::from_be_bytes(bytes.get(1..9)?.try_into().ok()?);
                Some(ColValue::Integer((raw ^ 0x8000_0000_0000_0000) as i64))
            }
            0x03 => {
                let key = u64::from_be_bytes(bytes.get(1..9)?.try_into().ok()?);
                let bits = if key & 0x8000_0000_0000_0000 != 0 {
                    key ^ 0x8000_0000_0000_0000
                } else {
                    !key
                };
                Some(ColValue::Real(f64::from_bits(bits)))
            }
            0x04 => Some(ColValue::Bool(bytes.get(1)? != &0)),
            0x05 => Some(ColValue::Text(
                std::str::from_utf8(bytes.get(1..)?).ok()?.to_owned(),
            )),
            _ => None,
        }
    }
}

impl From<ColValue> for turso_core::Value {
    fn from(v: ColValue) -> Self {
        match v {
            ColValue::Undefined | ColValue::Null => turso_core::Value::Null,
            ColValue::Text(s) => turso_core::Value::Text(turso_core::types::Text::new(s)),
            ColValue::Real(n) => turso_core::Value::from_f64(n),
            ColValue::Integer(n) => turso_core::Value::from_i64(n),
            ColValue::Bool(b) => turso_core::Value::from_i64(i64::from(b)),
        }
    }
}

/// A user-declared, extracted index column. Mirrors the TS `ColumnDef`. Index columns store the
/// order-preserving key from [`ColValue::encode_key`] as a `BLOB`, so they carry no affinity —
/// any value type sorts correctly.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ColumnDef {
    pub name: String,
    pub field: Option<String>,
}

/// A secondary index over one or more extracted columns. Mirrors the TS `IndexDef`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct IndexDef {
    pub name: String,
    pub fields: Vec<String>,
    pub columns: Option<Vec<String>>,
}

/// A table: its document store plus extracted columns and indexes. Mirrors the TS `TableDef`.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TableDef {
    pub name: String,
    pub placement: TablePlacement,
    pub columns: Vec<ColumnDef>,
    pub crdt_fields: Vec<CrdtFieldDef>,
    pub local_fields: Vec<LocalFieldDef>,
    pub indexes: Vec<IndexDef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum TablePlacement {
    Replicated,
    Device,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct LocalFieldDef {
    pub field: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct CrdtFieldDef {
    pub field: String,
    pub kind: CrdtFieldKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
pub enum CrdtFieldKind {
    Count,
    Set,
    Text,
}

/// The full schema handed to `setup`. Mirrors the TS `StoreSchema`.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct StoreSchema {
    pub tables: Vec<TableDef>,
}

/// One page of a scan, as a single JSON text. For document scans the text is a JSON array of
/// materialized documents (`[{"_id":…,"_creationTime":…,…fields}, …]`); for key scans it is
/// `{"ids":[…],"cts":[…]}`. One string crosses the JS boundary per page and one `JSON.parse`
/// decodes it — never one per document. `cursor` is `None` when the scan is exhausted.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Page {
    pub text: String,
    pub cursor: Option<String>,
    /// Sidecar per-row adoption version (`localId -> pull seq`) for a document page (§11 D1). Kept
    /// beside the compact app-row JSON so rows stay clean; the runtime read-set capture reads it,
    /// absent id => version `0`. Empty for key pages.
    pub versions: std::collections::BTreeMap<String, i64>,
    /// Device-only field overlays keyed by local row id. They never enter `text`, hashes, or wire
    /// witnesses; a device-facing runtime may merge this sidecar after the replicated read.
    pub local_fields:
        std::collections::BTreeMap<String, serde_json::Map<String, serde_json::Value>>,
}

/// An doc_write: the document plus its extracted column values. Mirrors the TS `DocWrite`.
///
/// `data` is always compact JSON object text (the `encode()` output of the runtime): it starts
/// with `{`, carries no `_id`/`_creationTime` keys, and has no insignificant whitespace. The
/// page splicer relies on this invariant; any future writer (replication) must preserve it.
#[derive(Debug, Clone)]
pub struct DocWrite {
    pub table: String,
    pub id: String,
    pub data: String,
    pub cols: Vec<(String, ColValue)>,
    pub creation_time: f64,
}

/// A delete by id. Mirrors the TS `DeleteIn`.
#[derive(Debug, Clone)]
pub struct DeleteIn {
    pub table: String,
    pub id: String,
}

/// A batch of doc_writes and deletes applied in one transaction. Mirrors the TS `WriteBatch`.
#[derive(Debug, Clone, Default)]
pub struct WriteBatch {
    pub doc_writes: Vec<DocWrite>,
    pub deletes: Vec<DeleteIn>,
    pub local_field_writes: Vec<LocalFieldWrite>,
    pub local_field_deletes: Vec<LocalFieldDelete>,
    pub crdt_ops: Vec<CrdtOp>,
    pub crdt_restores: Vec<CrdtRestore>,
    pub fresh_ids: Vec<RowKey>,
    pub data_only_ids: Vec<RowKey>,
    pub id_mappings: Vec<IdMapping>,
    pub schedules: Vec<super::ScheduledJob>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LocalFieldWrite {
    pub table: String,
    pub id: String,
    pub field: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalFieldDelete {
    pub table: String,
    pub id: String,
    pub field: String,
}

#[derive(Debug, Clone)]
pub struct CrdtRestore {
    pub row: RowKey,
    pub field: String,
    pub kind: CrdtFieldKind,
    pub head_seq: i64,
    pub projection_hash: String,
    pub bytes: Vec<u8>,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CrdtOp {
    pub row: RowKey,
    pub field: String,
    pub operation: CrdtOperation,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CrdtOperation {
    CountAdd {
        delta: f64,
    },
    SetAdd {
        value_json: String,
    },
    SetDelete {
        value_json: String,
    },
    TextSplice {
        index: i64,
        delete: i64,
        insert: String,
    },
}

/// One row-level change produced by a committed batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RowChange {
    pub op: RowChangeOp,
    pub table: String,
    pub id: String,
    /// Materialized document JSON for doc_writes; absent for deletes.
    pub row: Option<String>,
}

/// Row change operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowChangeOp {
    Write,
    Delete,
}

impl RowChangeOp {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Write => "write",
            Self::Delete => "delete",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "write" | "doc_write" => Some(Self::Write),
            "delete" => Some(Self::Delete),
            legacy if legacy == concat!("up", "sert") => Some(Self::Write),
            _ => None,
        }
    }
}

/// Durable mapping between a locally-created id and the eventual Convex server id.
///
/// TODO(sync): add translation operations that can walk encoded mutation args/results and replace
/// local ids with mapped Convex ids at remote replay boundaries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdMapping {
    pub table: String,
    pub local_id: String,
    pub mapping: IdMappingContent,
    pub created_time: i64,
    pub updated_time: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdMappingContent {
    Local,
    Mapped { convex_id: String },
    Deleted { convex_id: Option<String> },
}

impl IdMappingContent {
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Mapped { .. } => "mapped",
            Self::Deleted { .. } => "deleted",
        }
    }

    #[must_use]
    pub fn decode(state: &str, convex_id: Option<String>) -> Option<Self> {
        match (state, convex_id) {
            ("local", None) => Some(Self::Local),
            ("mapped", Some(convex_id)) => Some(Self::Mapped { convex_id }),
            ("deleted", convex_id) => Some(Self::Deleted { convex_id }),
            _ => None,
        }
    }

    #[must_use]
    pub fn convex_id(&self) -> Option<&str> {
        match self {
            Self::Local => None,
            Self::Mapped { convex_id } => Some(convex_id),
            Self::Deleted { convex_id } => convex_id.as_deref(),
        }
    }
}

impl IdMapping {
    #[must_use]
    pub fn convex_id(&self) -> Option<&str> {
        self.mapping.convex_id()
    }
}

/// Row identity for one projected Loro document.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RowKey {
    pub table: String,
    pub document_id: String,
}

/// Internal dirty-head diagnostic row exposed to devtools and metal benchmarks.
#[derive(Debug, Clone, PartialEq)]
pub struct DirtyHeadDebug {
    pub row: RowKey,
    pub op: RowChangeOp,
    pub first_commit_seq: i64,
    pub updated_commit_seq: i64,
    pub created_time: i64,
    pub updated_time: i64,
    pub server_document_id: Option<String>,
    pub base_projection_hash: Option<String>,
    pub base_root_id: Option<String>,
    pub base_node_id: Option<String>,
    pub logical_clock: f64,
}

/// A per-column bound for a scan/count. Mirrors the TS `Bound` union.
#[derive(Debug, Clone, PartialEq)]
pub enum Bound {
    Eq {
        value: ColValue,
    },
    Range {
        lower: Option<ColValue>,
        lower_inclusive: bool,
        upper: Option<ColValue>,
        upper_inclusive: bool,
    },
}

/// Scan ordering. Mirrors the TS `"asc" | "desc"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Order {
    #[default]
    Asc,
    Desc,
}

/// A paged scan request. Mirrors the TS `ReadSpec`.
///
/// Scans are total: every `(table, index, bounds, order)` compiles. Bounds the SQL layer cannot
/// represent exactly are widened (worst case dropped), so a page may over-approximate — callers
/// re-check exact order/bounds on the decoded documents.
///
/// Pages resume through keyset cursors over the physical order columns
/// (`index columns…, creation_time_ms, id`). Cursors are stable under inserts and deletes outside
/// the visited prefix; a row whose key columns are patched mid-pagination may be seen twice or
/// skipped, matching Convex pagination semantics.
#[derive(Debug, Clone, Default)]
pub struct ReadSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<Bound>>,
    pub order: Order,
    /// Max rows in this page, `1..=READ_CAP`. Defaults to `DEFAULT_READ_PAGE`.
    pub page_size: Option<usize>,
    /// Opaque continuation token from a prior page of the same
    /// (table, index, bounds-shape, order). Produced and parsed only by this crate.
    pub cursor: Option<String>,
    /// Alternative to `cursor`: resume strictly after this explicit key tuple, one value per
    /// physical order column (`index columns…, creation_time_ms, id`).
    pub resume_after_key: Option<Vec<ColValue>>,
}

/// A count request. Mirrors the TS `CountSpec`.
#[derive(Debug, Clone, Default)]
pub struct CountSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<Bound>>,
}
