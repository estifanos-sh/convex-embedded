//! SeaQuery-backed SQL construction for the Turso storage driver.
//!
//! This module owns every SQL statement shape. It uses `SeaQuery` for schema/query construction,
//! then hands final `SQLite` SQL text plus explicitly ordered Turso bind values to the driver.

use std::sync::LazyLock;

use sea_query::{
    Alias, Asterisk, ColumnDef as SqlColumnDef, Cond, ConditionalStatement, Expr, ExprTrait, Func,
    Index, IntoCondition, Order as SqlOrder, Query, SqliteQueryBuilder, Table,
};
use turso_core::Value;

use crate::error::StorageError;
use crate::types::{Bound, ColValue, CountSpec, Order, ScanSpec, TableDef};

/// Hard ceiling on rows in one page. Mirrors `SCAN_CAP` in the TS.
pub const SCAN_CAP: usize = 32_768;

/// Page size used when `ScanSpec::page_size` is omitted. Mirrors `DEFAULT_SCAN_PAGE` in the TS.
pub const DEFAULT_SCAN_PAGE: usize = 1_024;

/// Applied once per connection by the driver, in order.
pub(crate) const PRAGMAS: [&str; 3] = [
    "PRAGMA journal_mode = WAL",
    "PRAGMA synchronous = NORMAL",
    "PRAGMA temp_store = MEMORY",
];

/// On-disk storage format version, stamped into the database header via `PRAGMA user_version`.
/// Bump this whenever the persisted layout changes incompatibly; `setup` drops and recreates every
/// table when an opened database carries a different version (pre-1.0: reset, no migration).
/// Format 1 is the order-key BLOB index columns (previously INTEGER/TEXT affinity).
pub(crate) const STORAGE_FORMAT_VERSION: i64 = 1;

/// Reads the database's stored format version (0 on a brand-new database).
pub(crate) const READ_USER_VERSION: &str = "PRAGMA user_version";

/// Lists every table name in the database, for the version-mismatch reset to drop.
pub(crate) const LIST_TABLES: &str = "SELECT name FROM sqlite_master WHERE type = 'table'";

pub(crate) const BEGIN_IMMEDIATE: &str = "BEGIN IMMEDIATE";
pub(crate) const COMMIT: &str = "COMMIT";
pub(crate) const ROLLBACK: &str = "ROLLBACK";

const COMMITS: &str = "__embedded_commits";
const MUTATIONS: &str = "__embedded_mutations";
const BLOBS: &str = "__embedded_blobs";
const ID: &str = "id";
const IDENTITY_KEY: &str = "identity_key";
const CREATION_TIME: &str = "creation_time_ms";
const DATA: &str = "data";
const COMMIT_SEQ: &str = "commit_seq";
const SOURCE: &str = "source";
const MUTATION_ID: &str = "mutation_id";
const CHANGED_TABLES: &str = "changed_tables";
const NAME: &str = "name";
const ARGS: &str = "args";
const STATUS: &str = "status";
const RESULT: &str = "result";
const ERROR: &str = "error";
const KEY: &str = "key";
const BYTES: &str = "bytes";

static CREATE_COMMITS: LazyLock<String> = LazyLock::new(|| {
    strict(
        &Table::create()
            .table(alias(COMMITS))
            .if_not_exists()
            .col(text_col(IDENTITY_KEY))
            .col(integer_col(COMMIT_SEQ))
            .col(text_col(SOURCE))
            .col(nullable_text_col(MUTATION_ID))
            .col(text_col(CHANGED_TABLES))
            .primary_key(Index::create().col(alias(IDENTITY_KEY)).col(alias(COMMIT_SEQ)))
            .to_string(SqliteQueryBuilder),
    )
});
static CREATE_COMMITS_MUTATION_INDEX: LazyLock<String> = LazyLock::new(|| {
    Index::create()
        .unique()
        .if_not_exists()
        .name("ux__embedded_commits__mutation")
        .table(alias(COMMITS))
        .col(alias(IDENTITY_KEY))
        .col(alias(MUTATION_ID))
        .and_where(Expr::col(alias(MUTATION_ID)).is_not_null())
        .to_string(SqliteQueryBuilder)
});
static INSERT_COMMIT: LazyLock<String> = LazyLock::new(|| {
    insert(COMMITS, [IDENTITY_KEY, COMMIT_SEQ, SOURCE, MUTATION_ID, CHANGED_TABLES], 5, false)
});
static NEXT_COMMIT_SEQ: LazyLock<String> = LazyLock::new(|| {
    let next = Expr::expr(Func::coalesce([
        Expr::expr(Func::max(Expr::col(alias(COMMIT_SEQ)))),
        Expr::cust("0"),
    ]))
    .add(Expr::cust("1"));
    select_where(COMMITS, [next], [eq(IDENTITY_KEY)])
});
static MAX_COMMIT_SEQ: LazyLock<String> = LazyLock::new(|| {
    let max = Expr::expr(Func::coalesce([
        Expr::expr(Func::max(Expr::col(alias(COMMIT_SEQ)))),
        Expr::cust("0"),
    ]));
    select_where(COMMITS, [max], [eq(IDENTITY_KEY)])
});
static COMMIT_EXISTS: LazyLock<String> = LazyLock::new(|| {
    select_where(
        COMMITS,
        [Expr::cust("1")],
        [eq(IDENTITY_KEY), eq(COMMIT_SEQ)],
    )
});
static PRUNE_COMMITS: LazyLock<String> =
    LazyLock::new(|| delete_where(COMMITS, [eq(IDENTITY_KEY), lte(COMMIT_SEQ)]));
static CLEAR_COMMITS: LazyLock<String> = LazyLock::new(|| delete_where(COMMITS, [eq(IDENTITY_KEY)]));

static CREATE_MUTATIONS: LazyLock<String> = LazyLock::new(|| {
    strict(
        &Table::create()
            .table(alias(MUTATIONS))
            .if_not_exists()
            .col(text_col(IDENTITY_KEY))
            .col(text_col(MUTATION_ID))
            .col(text_col(NAME))
            .col(text_col(ARGS))
            .col(text_col(STATUS))
            .col(nullable_text_col(RESULT))
            .col(nullable_text_col(ERROR))
            .col(nullable_integer_col(COMMIT_SEQ))
            .primary_key(Index::create().col(alias(IDENTITY_KEY)).col(alias(MUTATION_ID)))
            .to_string(SqliteQueryBuilder),
    )
});
static INSERT_MUTATION: LazyLock<String> = LazyLock::new(|| {
    insert(MUTATIONS, [IDENTITY_KEY, MUTATION_ID, NAME, ARGS, STATUS], 5, false)
});
static READ_MUTATION: LazyLock<String> = LazyLock::new(|| {
    select_where(
        MUTATIONS,
        [
            Expr::col(alias(MUTATION_ID)),
            Expr::col(alias(STATUS)),
            Expr::col(alias(RESULT)),
            Expr::col(alias(ERROR)),
            Expr::col(alias(COMMIT_SEQ)),
        ],
        [eq(IDENTITY_KEY), eq(MUTATION_ID)],
    )
});
static READ_MUTATION_CALL: LazyLock<String> = LazyLock::new(|| {
    select_where(
        MUTATIONS,
        [Expr::col(alias(NAME)), Expr::col(alias(ARGS))],
        [eq(IDENTITY_KEY), eq(MUTATION_ID)],
    )
});
static FAIL_MUTATION: LazyLock<String> = LazyLock::new(|| {
    let mut query = Query::update();
    query
        .table(alias(MUTATIONS))
        .value(alias(STATUS), placeholder())
        .value(alias(ERROR), placeholder())
        .value(alias(RESULT), Expr::cust("NULL"))
        .value(alias(COMMIT_SEQ), Expr::cust("NULL"))
        .cond_where(all([eq(IDENTITY_KEY), eq(MUTATION_ID), ne(STATUS)]));
    query.build(SqliteQueryBuilder).0
});
static COMMIT_MUTATION: LazyLock<String> = LazyLock::new(|| {
    let mut query = Query::update();
    query
        .table(alias(MUTATIONS))
        .value(alias(STATUS), placeholder())
        .value(alias(RESULT), placeholder())
        .value(alias(ERROR), Expr::cust("NULL"))
        .value(alias(COMMIT_SEQ), placeholder())
        .cond_where(all([eq(IDENTITY_KEY), eq(MUTATION_ID)]));
    query.build(SqliteQueryBuilder).0
});
static PRUNE_MUTATIONS: LazyLock<String> = LazyLock::new(|| {
    let mut query = Query::delete();
    query
        .from_table(alias(MUTATIONS))
        .cond_where(all([
            eq(IDENTITY_KEY),
            Expr::col(alias(COMMIT_SEQ)).is_not_null(),
            lte(COMMIT_SEQ),
        ]));
    query.build(SqliteQueryBuilder).0
});
static CLEAR_MUTATIONS: LazyLock<String> =
    LazyLock::new(|| delete_where(MUTATIONS, [eq(IDENTITY_KEY)]));

static CREATE_BLOBS: LazyLock<String> = LazyLock::new(|| {
    strict(
        &Table::create()
            .table(alias(BLOBS))
            .if_not_exists()
            .col(text_col(IDENTITY_KEY))
            .col(text_col(KEY))
            .col(blob_col(BYTES))
            .primary_key(Index::create().col(alias(IDENTITY_KEY)).col(alias(KEY)))
            .to_string(SqliteQueryBuilder),
    )
});
static READ_BLOB: LazyLock<String> = LazyLock::new(|| {
    select_where(BLOBS, [Expr::col(alias(BYTES))], [eq(IDENTITY_KEY), eq(KEY)])
});
static WRITE_BLOB: LazyLock<String> =
    LazyLock::new(|| insert(BLOBS, [IDENTITY_KEY, KEY, BYTES], 3, true));
static DELETE_BLOB: LazyLock<String> =
    LazyLock::new(|| delete_where(BLOBS, [eq(IDENTITY_KEY), eq(KEY)]));
static CLEAR_BLOBS: LazyLock<String> = LazyLock::new(|| delete_where(BLOBS, [eq(IDENTITY_KEY)]));

/// Column names every document table owns; user-declared columns may not collide with them.
pub(crate) const RESERVED: [&str; 4] = [ID, IDENTITY_KEY, CREATION_TIME, DATA];

pub(crate) fn create_commits() -> &'static str {
    &CREATE_COMMITS
}

pub(crate) fn create_commits_mutation_index() -> &'static str {
    &CREATE_COMMITS_MUTATION_INDEX
}

pub(crate) fn insert_commit() -> &'static str {
    &INSERT_COMMIT
}

pub(crate) fn next_commit_seq() -> &'static str {
    &NEXT_COMMIT_SEQ
}

pub(crate) fn max_commit_seq() -> &'static str {
    &MAX_COMMIT_SEQ
}

pub(crate) fn commit_exists() -> &'static str {
    &COMMIT_EXISTS
}

pub(crate) fn prune_commits() -> &'static str {
    &PRUNE_COMMITS
}

pub(crate) fn clear_commits() -> &'static str {
    &CLEAR_COMMITS
}

pub(crate) fn create_mutations() -> &'static str {
    &CREATE_MUTATIONS
}

pub(crate) fn insert_mutation() -> &'static str {
    &INSERT_MUTATION
}

pub(crate) fn read_mutation() -> &'static str {
    &READ_MUTATION
}

pub(crate) fn read_mutation_call() -> &'static str {
    &READ_MUTATION_CALL
}

pub(crate) fn fail_mutation() -> &'static str {
    &FAIL_MUTATION
}

pub(crate) fn commit_mutation() -> &'static str {
    &COMMIT_MUTATION
}

pub(crate) fn prune_mutations() -> &'static str {
    &PRUNE_MUTATIONS
}

pub(crate) fn clear_mutations() -> &'static str {
    &CLEAR_MUTATIONS
}

pub(crate) fn create_blobs() -> &'static str {
    &CREATE_BLOBS
}

pub(crate) fn read_blob() -> &'static str {
    &READ_BLOB
}

pub(crate) fn write_blob() -> &'static str {
    &WRITE_BLOB
}

pub(crate) fn delete_blob() -> &'static str {
    &DELETE_BLOB
}

pub(crate) fn clear_blobs() -> &'static str {
    &CLEAR_BLOBS
}

pub(crate) fn create_doc_table(def: &TableDef) -> String {
    let mut table = Table::create();
    table
        .table(alias(doc_table(&def.name)))
        .if_not_exists()
        .col(text_col(ID))
        .col(text_col(IDENTITY_KEY))
        .col(real_col(CREATION_TIME))
        .col(json_col(DATA))
        .primary_key(Index::create().col(alias(IDENTITY_KEY)).col(alias(ID)));
    for c in &def.columns {
        // User-extracted index columns store the order-preserving key from `ColValue::encode_key`
        // as a BLOB, so the SQLite B-tree is already in exact Convex order. System columns
        // (`creation_time_ms` REAL, `id` TEXT) keep native types — they are type-fixed, so native
        // SQLite order already matches Convex for them.
        table.col(blob_col(&c.name));
    }
    strict(&table.to_string(SqliteQueryBuilder))
}

pub(crate) fn create_doc_index(
    table: &str,
    index: &str,
    columns: &[String],
) -> Result<String, StorageError> {
    validate_bare_ident(table)?;
    validate_bare_ident(index)?;
    let name = format!("ix__{table}__{index}");
    let table = doc_table(table);
    validate_bare_ident(&name)?;
    validate_bare_ident(&table)?;

    let mut indexed_columns = Vec::with_capacity(columns.len() + 1);
    indexed_columns.push(IDENTITY_KEY);
    for column in columns {
        validate_bare_ident(column)?;
        indexed_columns.push(column);
    }

    // SeaQuery's quoted SQLite index columns are valid SQLite, but the current browser/WASM Turso
    // parser rejects quoted expressions in CREATE INDEX. This validated bare-identifier shape is
    // intentionally limited to document secondary indexes.
    Ok(format!(
        "CREATE INDEX IF NOT EXISTS {name} ON {table} ({})",
        indexed_columns.join(", ")
    ))
}

pub(crate) fn read_doc(table: &str) -> String {
    select_where(
        doc_table(table),
        [
            Expr::col(alias(ID)),
            Expr::col(alias(CREATION_TIME)),
            Expr::col(alias(DATA)),
        ],
        [eq(IDENTITY_KEY), eq(ID)],
    )
}

pub(crate) fn upsert_doc(def: &TableDef) -> String {
    let columns = doc_insert_columns(def);
    insert(doc_table(&def.name), columns, 4 + def.columns.len(), true)
}

pub(crate) fn delete_doc(table: &str) -> String {
    delete_where(doc_table(table), [eq(IDENTITY_KEY), eq(ID)])
}

pub(crate) fn clear_docs(table: &str) -> String {
    delete_where(doc_table(table), [eq(IDENTITY_KEY)])
}

pub(crate) fn doc_watermark(table: &str) -> String {
    select_where(
        doc_table(table),
        [Expr::expr(Func::max(Expr::col(alias(CREATION_TIME))))],
        [eq(IDENTITY_KEY)],
    )
}

/// A compiled scan/count plan.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ScanPlan {
    pub sql: String,
    /// The physical order columns (`index columns…, creation_time_ms, id`). Empty for counts.
    pub columns: Vec<String>,
    /// Whether the SQL bounds represent the requested bounds exactly. Widened bounds
    /// over-approximate: fine for scans (callers re-check), disqualifying for counts.
    pub exact: bool,
}

/// Whether a scan decodes documents or only their keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Projection {
    Docs,
    Keys,
}

/// Compile a paged scan. `resume` is true when the scan resumes from a cursor/key (the keyset
/// predicate is appended). User index columns are BLOB order-keys (never SQL NULL) and system
/// columns are NOT NULL, so the keyset predicate is the textbook lexicographic form with no
/// null-mask.
pub(crate) fn compile_scan(
    spec: &ScanSpec,
    table: &TableDef,
    projection: Projection,
    resume: bool,
) -> Result<ScanPlan, StorageError> {
    let cols = plan_columns(spec.index.as_deref(), table)?;
    let order_cols = order_columns(&cols);
    let bounds = bounds_condition(spec.bounds.as_deref().unwrap_or(&[]), &cols)?;

    let mut condition = all([eq(IDENTITY_KEY)]);
    condition = merge(condition, bounds.condition);
    if resume {
        condition = merge(condition, cursor_condition(&order_cols, spec.order));
    }

    let mut query = Query::select();
    for expr in select_list(projection, &order_cols) {
        query.expr(expr);
    }
    query.from(alias(doc_table(&table.name))).cond_where(condition);
    for column in &order_cols {
        query.order_by(
            alias(column),
            match spec.order {
                Order::Asc => SqlOrder::Asc,
                Order::Desc => SqlOrder::Desc,
            },
        );
    }
    query.limit(0);
    Ok(ScanPlan {
        sql: placeholder_limit_sql(&query.build(SqliteQueryBuilder).0),
        columns: order_cols,
        exact: bounds.exact,
    })
}

/// Compile a count.
pub(crate) fn compile_count(spec: &CountSpec, table: &TableDef) -> Result<ScanPlan, StorageError> {
    let cols = plan_columns(spec.index.as_deref(), table)?;
    let bounds = bounds_condition(spec.bounds.as_deref().unwrap_or(&[]), &cols)?;
    let mut query = Query::select();
    query
        .expr_as(Func::count(Expr::col(Asterisk)), alias("n"))
        .from(alias(doc_table(&table.name)))
        .cond_where(merge(all([eq(IDENTITY_KEY)]), bounds.condition));
    Ok(ScanPlan {
        sql: query.build(SqliteQueryBuilder).0,
        columns: Vec::new(),
        exact: bounds.exact,
    })
}

/// The bound params for a scan in placeholder order: bounds, cursor key values, page limit.
/// Mirrors the placeholder order produced by `compile_scan`. The limit fetches one past the
/// page so the store can detect a next page and mint its cursor. User index columns bind as
/// BLOB order-keys; system columns bind native.
pub(crate) fn scan_params(
    spec: &ScanSpec,
    table: &TableDef,
    cursor_values: Option<&[ColValue]>,
    page_size: usize,
) -> Result<Vec<Value>, StorageError> {
    let cols = plan_columns(spec.index.as_deref(), table)?;
    let mut params = bounds_params(spec.bounds.as_deref().unwrap_or(&[]), &cols);
    if let Some(values) = cursor_values {
        params.extend(cursor_params(values, &order_columns(&cols)));
    }
    params.push(Value::from_i64(page_size as i64 + 1));
    Ok(params)
}

/// The bound params for a count. Mirrors `countParams`.
pub(crate) fn count_params(spec: &CountSpec, table: &TableDef) -> Result<Vec<Value>, StorageError> {
    let cols = plan_columns(spec.index.as_deref(), table)?;
    Ok(bounds_params(spec.bounds.as_deref().unwrap_or(&[]), &cols))
}

/// Bind a value for a target order column: user-extracted columns store BLOB order-keys; the
/// system columns `creation_time_ms` (REAL) and `id` (TEXT) bind native.
fn bind_col(col: &str, value: &ColValue) -> Value {
    if col == CREATION_TIME || col == ID {
        value.clone().into()
    } else {
        Value::Blob(value.encode_key())
    }
}

/// The canonical descriptor of a scan's plan shape: table, index, bounds shape AND values, order.
/// Baked into the cursor and checked on decode, so a cursor minted under one set of bound values
/// is rejected by a scan with different values of the same structural shape.
#[must_use]
pub(crate) fn scan_shape(spec: &ScanSpec) -> String {
    format!(
        "{}|{}|{}|{}|{}",
        spec.table,
        spec.index.as_deref().unwrap_or("@pk"),
        bounds_shape(spec.bounds.as_deref()),
        bounds_values(spec.bounds.as_deref()),
        order_tag(spec.order),
    )
}

/// Shape-keyed cache key for a scan plan. Includes the projection and whether the scan resumes
/// from a cursor (the keyset predicate changes the SQL text). The bound-value fingerprint is not
/// in the cache key — same-shape different-value scans reuse one cached statement (only the binds
/// differ) — but it IS in the cursor shape so cursors cannot cross value sets.
#[must_use]
pub(crate) fn scan_key(spec: &ScanSpec, projection: Projection, resume: bool) -> String {
    let proj = match projection {
        Projection::Docs => "d",
        Projection::Keys => "k",
    };
    format!(
        "s|{}|{}|{}|{proj}|{}",
        spec.table,
        spec.index.as_deref().unwrap_or("@pk"),
        bounds_shape(spec.bounds.as_deref()),
        if resume { "r" } else { "" },
    )
}

/// A fingerprint of the bound VALUES (order-key bytes, hex) folded into the cursor shape.
fn bounds_values(bounds: Option<&[Bound]>) -> String {
    let Some(bounds) = bounds else {
        return String::new();
    };
    let mut out = String::new();
    for b in bounds {
        match b {
            Bound::Eq { value } => push_value_hex(&mut out, value),
            Bound::Range { lower, upper, .. } => {
                if let Some(lo) = lower {
                    push_value_hex(&mut out, lo);
                }
                if let Some(hi) = upper {
                    push_value_hex(&mut out, hi);
                }
            }
        }
        out.push('|');
    }
    out
}

fn push_value_hex(out: &mut String, value: &ColValue) {
    use std::fmt::Write as _;
    for b in value.encode_key() {
        write!(out, "{b:02x}").expect("writing to a String cannot fail");
    }
    out.push('.');
}

/// Shape-keyed cache key for a count plan. Mirrors `countKey`.
#[must_use]
pub(crate) fn count_key(spec: &CountSpec) -> String {
    format!(
        "c|{}|{}|{}",
        spec.table,
        spec.index.as_deref().unwrap_or("@pk"),
        bounds_shape(spec.bounds.as_deref()),
    )
}

fn plan_columns(index: Option<&str>, table: &TableDef) -> Result<Vec<String>, StorageError> {
    match index {
        None => Ok(Vec::new()),
        Some(name) => table
            .indexes
            .iter()
            .find(|i| i.name == name)
            .map(|def| def.columns.clone().unwrap_or_else(|| def.fields.clone()))
            .ok_or_else(|| {
                StorageError::Unsatisfiable(format!("unknown index {name} on {}", table.name))
            }),
    }
}

fn order_columns(cols: &[String]) -> Vec<String> {
    let mut out = cols.to_vec();
    for column in [CREATION_TIME, ID] {
        if !out.iter().any(|candidate| candidate == column) {
            out.push(column.to_owned());
        }
    }
    out
}

fn select_list(projection: Projection, order_cols: &[String]) -> Vec<Expr> {
    let mut out = match projection {
        Projection::Docs => vec![
            Expr::col(alias(ID)),
            Expr::col(alias(CREATION_TIME)),
            Expr::col(alias(DATA)),
        ],
        Projection::Keys => vec![Expr::col(alias(ID)), Expr::col(alias(CREATION_TIME))],
    };
    for col in order_cols {
        if col != ID && col != CREATION_TIME {
            out.push(Expr::col(alias(col)));
        }
    }
    out
}

fn order_tag(order: Order) -> &'static str {
    match order {
        Order::Asc => "asc",
        Order::Desc => "desc",
    }
}

struct BoundsCondition {
    condition: Cond,
    exact: bool,
}

fn bounds_condition(bounds: &[Bound], cols: &[String]) -> Result<BoundsCondition, StorageError> {
    let pk = [ID.to_owned()];
    let target: &[String] = if cols.is_empty() { &pk } else { cols };
    if bounds.len() > target.len() {
        return Err(StorageError::Unsatisfiable(
            "more bounds than indexed columns".to_owned(),
        ));
    }
    // Every value (including null/undefined) encodes to an exact order key, so bounds are always
    // exact — there is no widening. An absent range endpoint simply contributes no clause.
    let mut condition = Cond::all();
    let mut seen_range = false;
    for (i, b) in bounds.iter().enumerate() {
        if seen_range {
            return Err(StorageError::Unsatisfiable(
                "bound follows a range bound".to_owned(),
            ));
        }
        let col = &target[i];
        match b {
            Bound::Eq { .. } => {
                condition = condition.add(eq(col));
            }
            Bound::Range {
                lower,
                lower_inclusive,
                upper,
                upper_inclusive,
            } => {
                seen_range = true;
                if lower.is_some() {
                    condition = condition.add(if *lower_inclusive { gte(col) } else { gt(col) });
                }
                if upper.is_some() {
                    condition = condition.add(if *upper_inclusive { lte(col) } else { lt(col) });
                }
            }
        }
    }
    Ok(BoundsCondition {
        condition,
        exact: true,
    })
}

fn bounds_params(bounds: &[Bound], cols: &[String]) -> Vec<Value> {
    let pk = [ID.to_owned()];
    let target: &[String] = if cols.is_empty() { &pk } else { cols };
    let mut params = Vec::new();
    for (i, b) in bounds.iter().enumerate() {
        let col = &target[i];
        match b {
            Bound::Eq { value } => params.push(bind_col(col, value)),
            Bound::Range { lower, upper, .. } => {
                if let Some(lo) = lower {
                    params.push(bind_col(col, lo));
                }
                if let Some(hi) = upper {
                    params.push(bind_col(col, hi));
                }
            }
        }
    }
    params
}

fn bounds_shape(bounds: Option<&[Bound]>) -> String {
    let Some(bounds) = bounds else {
        return String::new();
    };
    bounds
        .iter()
        .map(|b| match b {
            Bound::Eq { value } => {
                if matches!(value, ColValue::Null) {
                    "eqn".to_owned()
                } else {
                    "eq".to_owned()
                }
            }
            Bound::Range {
                lower,
                lower_inclusive,
                upper,
                upper_inclusive,
            } => {
                let lo = match lower {
                    Some(ColValue::Null) => "N",
                    Some(_) if *lower_inclusive => "L",
                    Some(_) => "l",
                    None => "",
                };
                let hi = match upper {
                    Some(ColValue::Null) => "N",
                    Some(_) if *upper_inclusive => "U",
                    Some(_) => "u",
                    None => "",
                };
                format!("r{lo}{hi}")
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

#[must_use]
pub(crate) fn encode_cursor(shape: &str, values: &[ColValue]) -> String {
    let mut out = format!("ec2:{}:{shape}", shape.len());
    for value in values {
        match value {
            ColValue::Undefined => out.push('u'),
            ColValue::Null => out.push('n'),
            ColValue::Integer(n) => {
                out.push('i');
                out.push_str(&n.to_string());
                out.push(';');
            }
            ColValue::Bool(b) => {
                out.push('i');
                out.push_str(if *b { "1" } else { "0" });
                out.push(';');
            }
            ColValue::Real(f) => {
                use std::fmt::Write;
                out.push('f');
                write!(out, "{:016x}", f.to_bits()).expect("writing to a String cannot fail");
            }
            ColValue::Text(s) => {
                out.push('s');
                out.push_str(&s.len().to_string());
                out.push(':');
                out.push_str(s);
            }
        }
    }
    out
}

pub(crate) fn decode_cursor(
    cursor: &str,
    expected_shape: &str,
) -> Result<Vec<ColValue>, StorageError> {
    let invalid = |what: &str| StorageError::InvalidCursor(what.to_owned());
    let rest = cursor
        .strip_prefix("ec2:")
        .ok_or_else(|| invalid("bad prefix"))?;
    let (len, rest) = rest
        .split_once(':')
        .ok_or_else(|| invalid("missing shape length"))?;
    let len: usize = len.parse().map_err(|_| invalid("bad shape length"))?;
    if rest.len() < len || !rest.is_char_boundary(len) {
        return Err(invalid("truncated shape"));
    }
    let (shape, mut rest) = rest.split_at(len);
    if shape != expected_shape {
        return Err(StorageError::InvalidCursor(format!(
            "cursor was minted for a different scan shape: {shape:?}"
        )));
    }
    let mut values = Vec::new();
    while !rest.is_empty() {
        let tag = rest.as_bytes()[0];
        if !rest.is_char_boundary(1) {
            return Err(invalid("unknown value tag"));
        }
        rest = &rest[1..];
        match tag {
            b'u' => values.push(ColValue::Undefined),
            b'n' => values.push(ColValue::Null),
            b'i' => {
                let (digits, tail) = rest
                    .split_once(';')
                    .ok_or_else(|| invalid("unterminated integer"))?;
                values.push(ColValue::Integer(
                    digits.parse().map_err(|_| invalid("bad integer"))?,
                ));
                rest = tail;
            }
            b'f' => {
                if rest.len() < 16 || !rest.is_char_boundary(16) {
                    return Err(invalid("truncated real"));
                }
                let (hex, tail) = rest.split_at(16);
                let bits = u64::from_str_radix(hex, 16).map_err(|_| invalid("bad real"))?;
                values.push(ColValue::Real(f64::from_bits(bits)));
                rest = tail;
            }
            b's' => {
                let (len, tail) = rest
                    .split_once(':')
                    .ok_or_else(|| invalid("missing text length"))?;
                let len: usize = len.parse().map_err(|_| invalid("bad text length"))?;
                if tail.len() < len || !tail.is_char_boundary(len) {
                    return Err(invalid("truncated text"));
                }
                let (text, tail) = tail.split_at(len);
                values.push(ColValue::Text(text.to_owned()));
                rest = tail;
            }
            _ => return Err(invalid("unknown value tag")),
        }
    }
    Ok(values)
}

/// The keyset "strictly after the cursor key" predicate, plus a redundant leading sargable bound
/// on the first column so the planner seeks the index near the cursor. No null branches: user
/// columns are BLOB order-keys and system columns are NOT NULL, so no order column is ever SQL
/// NULL. `cursor_params` mirrors this placeholder order exactly.
fn cursor_condition(cols: &[String], order: Order) -> Cond {
    let after = |col: &str| -> Cond {
        match order {
            Order::Asc => expr(gt(col)),
            Order::Desc => expr(lt(col)),
        }
    };
    let last = cols.len() - 1;
    let mut chain = after(&cols[last]);
    for i in (0..last).rev() {
        chain = any([after(&cols[i]), all([expr(eq(&cols[i])), chain])]);
    }
    let leading = match order {
        Order::Asc => expr(gte(&cols[0])),
        Order::Desc => expr(lte(&cols[0])),
    };
    all([leading, chain])
}

fn cursor_params(values: &[ColValue], cols: &[String]) -> Vec<Value> {
    let mut params = vec![bind_col(&cols[0], &values[0])];
    let last = values.len() - 1;
    for (i, value) in values.iter().enumerate() {
        params.push(bind_col(&cols[i], value));
        if i != last {
            params.push(bind_col(&cols[i], value));
        }
    }
    params
}

fn text_col(name: &str) -> SqlColumnDef {
    let mut col = SqlColumnDef::new(alias(name));
    col.custom("TEXT").not_null();
    col
}

fn nullable_text_col(name: &str) -> SqlColumnDef {
    let mut col = SqlColumnDef::new(alias(name));
    col.custom("TEXT");
    col
}

fn integer_col(name: &str) -> SqlColumnDef {
    let mut col = SqlColumnDef::new(alias(name));
    col.custom("INTEGER").not_null();
    col
}

fn nullable_integer_col(name: &str) -> SqlColumnDef {
    let mut col = SqlColumnDef::new(alias(name));
    col.custom("INTEGER");
    col
}

fn real_col(name: &str) -> SqlColumnDef {
    let mut col = SqlColumnDef::new(alias(name));
    col.custom("REAL").not_null();
    col
}

fn blob_col(name: &str) -> SqlColumnDef {
    let mut col = SqlColumnDef::new(alias(name));
    col.custom("BLOB").not_null();
    col
}

fn json_col(name: &str) -> SqlColumnDef {
    let mut col = SqlColumnDef::new(alias(name));
    col.custom("json").not_null();
    col
}

fn insert<I, S>(table: S, columns: I, value_count: usize, replace: bool) -> String
where
    I: IntoIterator,
    I::Item: AsRef<str>,
    S: AsRef<str>,
{
    let mut query = Query::insert();
    if replace {
        query.replace();
    }
    query
        .into_table(alias(table.as_ref()))
        .columns(columns.into_iter().map(|c| alias(c.as_ref())))
        .values_panic(std::iter::repeat_with(placeholder).take(value_count));
    query.build(SqliteQueryBuilder).0
}

fn select_where<S, E, C>(table: S, select: E, conditions: C) -> String
where
    S: AsRef<str>,
    E: IntoIterator<Item = Expr>,
    C: IntoIterator<Item = Expr>,
{
    let mut query = Query::select();
    for expr in select {
        query.expr(expr);
    }
    query
        .from(alias(table.as_ref()))
        .cond_where(all(conditions));
    query.build(SqliteQueryBuilder).0
}

fn delete_where<S, C>(table: S, conditions: C) -> String
where
    S: AsRef<str>,
    C: IntoIterator<Item = Expr>,
{
    let mut query = Query::delete();
    query
        .from_table(alias(table.as_ref()))
        .cond_where(all(conditions));
    query.build(SqliteQueryBuilder).0
}

fn doc_insert_columns(def: &TableDef) -> Vec<String> {
    let mut columns = vec![
        ID.to_owned(),
        IDENTITY_KEY.to_owned(),
        CREATION_TIME.to_owned(),
        DATA.to_owned(),
    ];
    columns.extend(def.columns.iter().map(|c| c.name.clone()));
    columns
}

fn strict(sql: &str) -> String {
    format!("{sql} STRICT")
}

fn doc_table(table: &str) -> String {
    format!("doc__{table}")
}

/// Stamps the current `STORAGE_FORMAT_VERSION` into the database header. The value cannot be a bind
/// parameter in a PRAGMA, so it is a trusted in-process constant baked into the literal.
pub(crate) fn set_user_version() -> String {
    format!("PRAGMA user_version = {STORAGE_FORMAT_VERSION}")
}

/// Drops a table by name during a format-version reset. The name comes from `sqlite_master` (our own
/// `doc__*`/`__embedded_*` tables); it is double-quoted defensively.
pub(crate) fn drop_table(name: &str) -> String {
    format!("DROP TABLE IF EXISTS \"{name}\"")
}

fn alias(name: impl AsRef<str>) -> Alias {
    Alias::new(name.as_ref())
}

fn placeholder() -> Expr {
    Expr::val(0)
}

// SeaQuery 1.0 only exposes literal SELECT limits; scans keep page size as a Turso bind value so
// the same statement cache entry works across page sizes.
fn placeholder_limit_sql(sql: &str) -> String {
    sql.strip_suffix(" LIMIT 0")
        .map_or_else(|| sql.to_owned(), |prefix| format!("{prefix} LIMIT ?"))
}

fn validate_bare_ident(name: &str) -> Result<(), StorageError> {
    if is_bare_ident(name) && !is_sql_keyword(name) {
        Ok(())
    } else {
        Err(StorageError::InvalidIdent(name.to_owned()))
    }
}

fn is_bare_ident(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && !bytes[0].is_ascii_digit()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

fn is_sql_keyword(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "all"
            | "and"
            | "as"
            | "by"
            | "create"
            | "delete"
            | "drop"
            | "exists"
            | "from"
            | "group"
            | "if"
            | "in"
            | "index"
            | "insert"
            | "into"
            | "is"
            | "key"
            | "limit"
            | "not"
            | "null"
            | "on"
            | "or"
            | "order"
            | "primary"
            | "select"
            | "table"
            | "unique"
            | "update"
            | "values"
            | "where"
    )
}

fn eq(column: &str) -> Expr {
    Expr::col(alias(column)).eq(placeholder())
}

fn ne(column: &str) -> Expr {
    Expr::col(alias(column)).ne(placeholder())
}

fn gt(column: &str) -> Expr {
    Expr::col(alias(column)).gt(placeholder())
}

fn gte(column: &str) -> Expr {
    Expr::col(alias(column)).gte(placeholder())
}

fn lt(column: &str) -> Expr {
    Expr::col(alias(column)).lt(placeholder())
}

fn lte(column: &str) -> Expr {
    Expr::col(alias(column)).lte(placeholder())
}

fn expr(expression: Expr) -> Cond {
    expression.into_condition()
}

fn all<I>(conditions: I) -> Cond
where
    I: IntoIterator,
    I::Item: IntoCondition,
{
    conditions
        .into_iter()
        .fold(Cond::all(), sea_query::Condition::add)
}

fn any<I>(conditions: I) -> Cond
where
    I: IntoIterator,
    I::Item: IntoCondition,
{
    conditions
        .into_iter()
        .fold(Cond::any(), sea_query::Condition::add)
}

fn merge(left: Cond, right: Cond) -> Cond {
    all([left, right])
}
