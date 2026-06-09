//! Faithful port of the TS `storage/sql.ts`. Compiles `ScanSpec`/`CountSpec` into SQL against the
//! `doc__<table>` tables, with a 3-state result (`Sql` / `Miss` / `Unsatisfiable`). The SQL text,
//! column ordering, bound encodings, and cache keys must stay byte-parity with the TypeScript.

use crate::types::{Bound, ColValue, CountSpec, Order, ScanSpec, TableDef};

/// The outcome of compiling a scan/count. Mirrors the TS `CompileResult` union.
#[derive(Debug, Clone, PartialEq)]
pub enum CompileResult {
    Sql { sql: String, columns: Vec<String> },
    Miss,
    Unsatisfiable { reason: String },
}

/// Hard ceiling on rows returned by an unbounded scan. Mirrors `SCAN_CAP` in the TS.
pub const SCAN_CAP: usize = 32_768;

const SELECT_COLS: &str = "id, creation_time_ms, data";

/// Compile a scan into SQL, or report an unsupported / unsatisfiable spec.
#[must_use]
pub fn compile_scan(spec: &ScanSpec, table: &TableDef) -> CompileResult {
    let Some(cols) = plan_columns(spec.index.as_deref(), table) else {
        return CompileResult::Miss;
    };

    let clause = match bounds_clause(spec.bounds.as_deref().unwrap_or(&[]), &cols) {
        Ok(clause) => clause,
        Err(reason) => return CompileResult::Unsatisfiable { reason },
    };

    let order_cols = order_columns(&cols);
    let dir = if spec.order == Order::Desc {
        " DESC"
    } else {
        ""
    };
    let order_by = order_cols
        .iter()
        .map(|c| format!("{c}{dir}"))
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "SELECT {SELECT_COLS} FROM doc__{} WHERE identity_key = ?{clause} ORDER BY {order_by} LIMIT ?",
        table.name,
    );
    CompileResult::Sql {
        sql,
        columns: order_cols,
    }
}

/// Compile a count into SQL, or report an unsupported / unsatisfiable spec.
#[must_use]
pub fn compile_count(spec: &CountSpec, table: &TableDef) -> CompileResult {
    let Some(cols) = plan_columns(spec.index.as_deref(), table) else {
        return CompileResult::Miss;
    };

    let clause = match bounds_clause(spec.bounds.as_deref().unwrap_or(&[]), &cols) {
        Ok(clause) => clause,
        Err(reason) => return CompileResult::Unsatisfiable { reason },
    };

    let sql = format!(
        "SELECT COUNT(*) AS n FROM doc__{} WHERE identity_key = ?{clause}",
        table.name,
    );
    CompileResult::Sql {
        sql,
        columns: vec!["n".to_owned()],
    }
}

/// The bound params for a scan, followed by the trailing `LIMIT` value. An unbounded scan fetches
/// one past the cap so the store can detect (and loudly reject) overflow. Mirrors `scanParams`.
#[must_use]
pub fn scan_params(spec: &ScanSpec) -> Vec<turso::Value> {
    let mut params: Vec<turso::Value> = bounds_params(spec.bounds.as_deref().unwrap_or(&[]))
        .into_iter()
        .map(Into::into)
        .collect();
    let limit = spec.limit.unwrap_or(SCAN_CAP + 1);
    params.push(turso::Value::Integer(limit as i64));
    params
}

/// The bound params for a count. Mirrors `countParams`.
#[must_use]
pub fn count_params(spec: &CountSpec) -> Vec<turso::Value> {
    bounds_params(spec.bounds.as_deref().unwrap_or(&[]))
        .into_iter()
        .map(Into::into)
        .collect()
}

/// Shape-keyed cache key for a scan plan. Mirrors `scanKey`.
#[must_use]
pub fn scan_key(spec: &ScanSpec) -> String {
    format!(
        "s|{}|{}|{}|{}|{}",
        spec.table,
        spec.index.as_deref().unwrap_or("@pk"),
        bounds_shape(spec.bounds.as_deref()),
        order_tag(spec.order),
        if spec.limit.is_some() { "l" } else { "" },
    )
}

/// Shape-keyed cache key for a count plan. Mirrors `countKey`.
#[must_use]
pub fn count_key(spec: &CountSpec) -> String {
    format!(
        "c|{}|{}|{}",
        spec.table,
        spec.index.as_deref().unwrap_or("@pk"),
        bounds_shape(spec.bounds.as_deref()),
    )
}

/// The indexed columns for `index`, `Some([])` for the primary key, or `None` when unsupported.
/// Mirrors `planColumns` (which returns `[]` / fields / `"miss"`).
#[must_use]
pub fn plan_columns(index: Option<&str>, table: &TableDef) -> Option<Vec<String>> {
    match index {
        None => Some(Vec::new()),
        Some(name) => table
            .indexes
            .iter()
            .find(|i| i.name == name)
            .map(|def| def.fields.clone()),
    }
}

fn order_columns(cols: &[String]) -> Vec<String> {
    if cols.is_empty() {
        vec!["creation_time_ms".to_owned(), "id".to_owned()]
    } else {
        let mut out = cols.to_vec();
        out.push("creation_time_ms".to_owned());
        out.push("id".to_owned());
        out
    }
}

fn order_tag(order: Order) -> &'static str {
    match order {
        Order::Asc => "asc",
        Order::Desc => "desc",
    }
}

/// Build the ` AND ...` clause suffix, or `Err(reason)` if the bounds are unsatisfiable.
/// Mirrors `boundsClause` (returns `{ clause }` or `{ unsatisfiable, reason }`).
fn bounds_clause(bounds: &[Bound], cols: &[String]) -> Result<String, String> {
    let pk = ["id".to_owned()];
    let target: &[String] = if cols.is_empty() { &pk } else { cols };
    if bounds.len() > target.len() {
        return Err("more bounds than indexed columns".to_owned());
    }
    let mut clauses: Vec<String> = Vec::new();
    let mut seen_range = false;
    for (i, b) in bounds.iter().enumerate() {
        if seen_range {
            return Err("bound follows a range bound".to_owned());
        }
        let col = &target[i];
        match b {
            Bound::Eq { .. } => clauses.push(format!("{col} = ?")),
            Bound::Range {
                lower,
                lower_inclusive,
                upper,
                upper_inclusive,
            } => {
                seen_range = true;
                // A range with neither side set intentionally contributes no SQL clause. This mirrors
                // the TS builder and keeps programmatic range construction a harmless no-op.
                if lower.is_some() {
                    let op = if *lower_inclusive { ">=" } else { ">" };
                    clauses.push(format!("{col} {op} ?"));
                }
                if upper.is_some() {
                    let op = if *upper_inclusive { "<=" } else { "<" };
                    clauses.push(format!("{col} {op} ?"));
                }
            }
        }
    }
    if clauses.is_empty() {
        Ok(String::new())
    } else {
        Ok(format!(" AND {}", clauses.join(" AND ")))
    }
}

/// The bound values in placeholder order. Mirrors `boundsParams`.
fn bounds_params(bounds: &[Bound]) -> Vec<ColValue> {
    let mut params: Vec<ColValue> = Vec::new();
    for b in bounds {
        match b {
            Bound::Eq { value } => params.push(value.clone()),
            Bound::Range { lower, upper, .. } => {
                if let Some(lo) = lower {
                    params.push(lo.clone());
                }
                if let Some(hi) = upper {
                    params.push(hi.clone());
                }
            }
        }
    }
    params
}

/// The cache-key fragment encoding the bound shapes (eq / r + lo + hi). Mirrors `boundsShape`.
fn bounds_shape(bounds: Option<&[Bound]>) -> String {
    let Some(bounds) = bounds else {
        return String::new();
    };
    bounds
        .iter()
        .map(|b| match b {
            Bound::Eq { .. } => "eq".to_owned(),
            Bound::Range {
                lower,
                lower_inclusive,
                upper,
                upper_inclusive,
            } => {
                let lo = match lower {
                    Some(_) if *lower_inclusive => "L",
                    Some(_) => "l",
                    None => "",
                };
                let hi = match upper {
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
