//! Data shapes mirroring the TS `storage/types.ts`. Field names, affinities, and bound encodings
//! must stay byte-parity with the TypeScript source of truth.

/// A column value extracted for an indexed/queryable column. Mirrors the subset of the TS `Param`
/// that the store binds for extracted columns and bounds.
#[derive(Debug, Clone, PartialEq)]
pub enum ColValue {
    Null,
    Text(String),
    Real(f64),
    Integer(i64),
    Bool(bool),
}

impl From<ColValue> for turso::Value {
    fn from(v: ColValue) -> Self {
        match v {
            ColValue::Null => turso::Value::Null,
            ColValue::Text(s) => turso::Value::Text(s),
            ColValue::Real(n) => turso::Value::Real(n),
            ColValue::Integer(n) => turso::Value::Integer(n),
            ColValue::Bool(b) => turso::Value::Integer(i64::from(b)),
        }
    }
}

/// `SQLite` column affinity for an extracted column. Mirrors the TS `Affinity` union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Affinity {
    Text,
    Real,
    Integer,
}

impl Affinity {
    /// The SQL keyword written into the `CREATE TABLE` statement.
    #[must_use]
    pub fn keyword(self) -> &'static str {
        match self {
            Affinity::Text => "TEXT",
            Affinity::Real => "REAL",
            Affinity::Integer => "INTEGER",
        }
    }
}

/// A user-declared, extracted column. Mirrors the TS `ColumnDef`.
#[derive(Debug, Clone)]
pub struct ColumnDef {
    pub name: String,
    pub affinity: Affinity,
}

/// A secondary index over one or more extracted columns. Mirrors the TS `IndexDef`.
#[derive(Debug, Clone)]
pub struct IndexDef {
    pub name: String,
    pub fields: Vec<String>,
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

/// A materialized document. `creation_time` is float milliseconds. Mirrors the TS `StoredDoc`
/// (`{ _id, _creationTime, data }`).
#[derive(Debug, Clone, PartialEq)]
pub struct StoredDoc {
    pub id: String,
    pub creation_time: f64,
    pub data: String,
}

/// An upsert: the document plus its extracted column values. Mirrors the TS `UpsertIn`.
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

/// The outcome of a storage read plan. `Unsupported` means the store cannot execute this plan
/// shape; it does not mean an empty result.
#[derive(Debug, Clone, PartialEq)]
pub enum ReadOutcome<T> {
    Executed(T),
    Unsupported,
}

impl<T> ReadOutcome<T> {
    #[must_use]
    pub fn into_option(self) -> Option<T> {
        match self {
            Self::Executed(value) => Some(value),
            Self::Unsupported => None,
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

/// A scan request. Mirrors the TS `ScanSpec`.
#[derive(Debug, Clone, Default)]
pub struct ScanSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<Bound>>,
    pub order: Order,
    pub limit: Option<usize>,
}

/// A count request. Mirrors the TS `CountSpec`.
#[derive(Debug, Clone, Default)]
pub struct CountSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<Bound>>,
}
