//! Data shapes mirroring the TS `storage/types.ts`. Field names, affinities, and bound encodings
//! must stay byte-parity with the TypeScript source of truth.

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
#[derive(Debug, Clone)]
pub struct ColumnDef {
    pub name: String,
    pub field: Option<String>,
}

/// A secondary index over one or more extracted columns. Mirrors the TS `IndexDef`.
#[derive(Debug, Clone)]
pub struct IndexDef {
    pub name: String,
    pub fields: Vec<String>,
    pub columns: Option<Vec<String>>,
}

/// A table: its document store plus extracted columns and indexes. Mirrors the TS `TableDef`.
#[derive(Debug, Clone)]
pub struct TableDef {
    pub name: String,
    pub columns: Vec<ColumnDef>,
    pub indexes: Vec<IndexDef>,
}

/// The full schema handed to `setup`. Mirrors the TS `StoreSchema`.
#[derive(Debug, Clone, Default)]
pub struct StoreSchema {
    pub tables: Vec<TableDef>,
}

/// One page of a scan, as a single JSON text. For document scans the text is a JSON array of
/// materialized documents (`[{"_id":…,"_creationTime":…,…fields}, …]`); for key scans it is
/// `{"ids":[…],"cts":[…]}`. One string crosses the JS boundary per page and one `JSON.parse`
/// decodes it — never one per document. `cursor` is `None` when the scan is exhausted.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub text: String,
    pub cursor: Option<String>,
}

/// An upsert: the document plus its extracted column values. Mirrors the TS `UpsertIn`.
///
/// `data` is always compact JSON object text (the `encode()` output of the runtime): it starts
/// with `{`, carries no `_id`/`_creationTime` keys, and has no insignificant whitespace. The
/// page splicer relies on this invariant; any future writer (replication) must preserve it.
#[derive(Debug, Clone)]
pub struct UpsertIn {
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

/// A batch of upserts and deletes applied in one transaction. Mirrors the TS `WriteBatch`.
#[derive(Debug, Clone, Default)]
pub struct WriteBatch {
    pub upserts: Vec<UpsertIn>,
    pub deletes: Vec<DeleteIn>,
}

/// Private metadata attached to a commit.
#[derive(Debug, Clone)]
pub struct CommitOptions {
    pub source: String,
    pub mutation_id: Option<String>,
    pub mutation_result: Option<String>,
}

impl Default for CommitOptions {
    fn default() -> Self {
        Self {
            source: "local".to_owned(),
            mutation_id: None,
            mutation_result: None,
        }
    }
}

/// Metadata returned after a batch commits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitResult {
    pub commit_seq: i64,
    pub changed_tables: Vec<String>,
}

/// Durable mutation call metadata.
#[derive(Debug, Clone)]
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

/// A paged scan request. Mirrors the TS `ScanSpec`.
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
pub struct ScanSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<Bound>>,
    pub order: Order,
    /// Max rows in this page, `1..=SCAN_CAP`. Defaults to `DEFAULT_SCAN_PAGE`.
    pub page_size: Option<usize>,
    /// Opaque continuation token from a prior page of the same
    /// (table, index, bounds-shape, order). Produced and parsed only by this crate.
    pub cursor: Option<String>,
    /// Alternative to `cursor`: resume strictly after this explicit key tuple, one value per
    /// physical order column (`index columns…, creation_time_ms, id`).
    pub resume_after_key: Option<Vec<ColValue>>,
}

/// Rows removed by `ledger_prune`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PruneResult {
    pub commits_deleted: i64,
    pub mutations_deleted: i64,
}

/// A count request. Mirrors the TS `CountSpec`.
#[derive(Debug, Clone, Default)]
pub struct CountSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<Bound>>,
}
