//! napi bindings exposing the Rust `EmbeddedStore` to Node. This is not on the active path (the live
//! store is the TS implementation); it exists so the workspace builds and the engine is reachable
//! from Node if needed. `_creationTime` crosses the boundary as `f64` (its native type); other
//! integers above 2^53 would lose precision.

use napi_derive::napi;
use storage::{
    Affinity, Bound, ColValue, ColumnDef, CountSpec, DeleteIn, EmbeddedStore, IndexDef, Order,
    ReadOutcome, ScanSpec, StorageError, StoreSchema, StoredDoc, TableDef, UpsertIn, WriteBatch,
};

#[napi(object)]
pub struct JsColumn {
    /// `"TEXT"`, `"REAL"`, or `"INTEGER"`.
    pub name: String,
    pub affinity: String,
}

#[napi(object)]
pub struct JsIndex {
    pub name: String,
    pub fields: Vec<String>,
}

#[napi(object)]
pub struct JsTable {
    pub name: String,
    pub columns: Vec<JsColumn>,
    pub indexes: Vec<JsIndex>,
}

#[napi(object)]
pub struct JsSchema {
    pub tables: Vec<JsTable>,
}

/// An extracted column value, tagged by which field is set. At most one of `text`/`real`/`int`/`bool`
/// may be present; all absent means SQL NULL.
#[napi(object)]
pub struct JsColValue {
    pub name: String,
    pub text: Option<String>,
    pub real: Option<f64>,
    pub int: Option<i64>,
    pub r#bool: Option<bool>,
}

/// A tagged scalar value for bounds. At most one of `text`/`real`/`int`/`bool` may be present; all
/// absent means SQL NULL.
#[napi(object)]
pub struct JsValue {
    pub text: Option<String>,
    pub real: Option<f64>,
    pub int: Option<i64>,
    pub r#bool: Option<bool>,
}

#[napi(object)]
pub struct JsBound {
    pub kind: String,
    pub value: Option<JsValue>,
    pub lower: Option<JsValue>,
    pub lower_inclusive: Option<bool>,
    pub upper: Option<JsValue>,
    pub upper_inclusive: Option<bool>,
}

#[napi(object)]
pub struct JsScanSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<JsBound>>,
    pub order: String,
    pub limit: Option<u32>,
}

#[napi(object)]
pub struct JsCountSpec {
    pub table: String,
    pub index: Option<String>,
    pub bounds: Option<Vec<JsBound>>,
}

#[napi(object)]
pub struct JsUpsert {
    pub table: String,
    pub id: String,
    pub data: String,
    pub cols: Vec<JsColValue>,
    pub creation_time: f64,
}

#[napi(object)]
pub struct JsDelete {
    pub table: String,
    pub id: String,
}

#[napi(object)]
pub struct JsWriteBatch {
    pub upserts: Vec<JsUpsert>,
    pub deletes: Vec<JsDelete>,
}

#[napi(object)]
pub struct JsDoc {
    #[napi(js_name = "_id")]
    pub id: String,
    #[napi(js_name = "_creationTime")]
    pub creation_time: f64,
    pub data: String,
}

#[napi]
pub struct Store {
    inner: EmbeddedStore,
}

#[napi]
impl Store {
    #[napi]
    pub async fn open(path: String, identity_key: Option<String>) -> napi::Result<Store> {
        let inner =
            EmbeddedStore::open_with_identity_key(&path, identity_key.as_deref().unwrap_or(""))
                .await
                .map_err(map_err)?;
        Ok(Store { inner })
    }

    #[napi]
    pub async fn setup(&self, schema: JsSchema) -> napi::Result<()> {
        self.inner.setup(to_schema(schema)?).await.map_err(map_err)
    }

    #[napi]
    pub fn next_creation_time(&self) -> napi::Result<f64> {
        self.inner.next_creation_time().map_err(map_err)
    }

    #[napi]
    pub async fn commit(&self, batch: JsWriteBatch) -> napi::Result<()> {
        self.inner
            .commit(to_write_batch(batch)?)
            .await
            .map_err(map_err)
    }

    #[napi]
    pub async fn get(&self, table: String, id: String) -> napi::Result<Option<JsDoc>> {
        let doc = self.inner.get(&table, &id).await.map_err(map_err)?;
        Ok(doc.map(js_doc))
    }

    #[napi]
    pub async fn scan(&self, spec: JsScanSpec) -> napi::Result<Option<Vec<JsDoc>>> {
        let docs = self
            .inner
            .scan(&to_scan_spec(spec)?)
            .await
            .map_err(map_err)?;
        Ok(match docs {
            ReadOutcome::Executed(rows) => Some(rows.into_iter().map(js_doc).collect()),
            ReadOutcome::Unsupported => None,
        })
    }

    #[napi]
    pub async fn count(&self, spec: JsCountSpec) -> napi::Result<Option<i64>> {
        let count = self
            .inner
            .count(&to_count_spec(spec)?)
            .await
            .map_err(map_err)?;
        Ok(match count {
            ReadOutcome::Executed(n) => Some(n),
            ReadOutcome::Unsupported => None,
        })
    }

    #[napi]
    pub async fn clear(&self) -> napi::Result<()> {
        self.inner.clear().await.map_err(map_err)
    }

    #[napi]
    pub fn close(&self) -> napi::Result<()> {
        Ok(())
    }
}

fn to_schema(schema: JsSchema) -> napi::Result<StoreSchema> {
    let mut tables = Vec::with_capacity(schema.tables.len());
    for t in schema.tables {
        let mut columns = Vec::with_capacity(t.columns.len());
        for c in t.columns {
            columns.push(ColumnDef {
                name: c.name,
                affinity: parse_affinity(&c.affinity)?,
            });
        }
        tables.push(TableDef {
            name: t.name,
            columns,
            indexes: t
                .indexes
                .into_iter()
                .map(|i| IndexDef {
                    name: i.name,
                    fields: i.fields,
                })
                .collect(),
        });
    }
    Ok(StoreSchema { tables })
}

fn parse_affinity(s: &str) -> napi::Result<Affinity> {
    match s {
        "TEXT" => Ok(Affinity::Text),
        "REAL" => Ok(Affinity::Real),
        "INTEGER" => Ok(Affinity::Integer),
        other => Err(napi::Error::from_reason(format!(
            "invalid affinity: {other}"
        ))),
    }
}

fn parse_order(s: &str) -> napi::Result<Order> {
    match s {
        "asc" => Ok(Order::Asc),
        "desc" => Ok(Order::Desc),
        other => Err(napi::Error::from_reason(format!("invalid order: {other}"))),
    }
}

fn to_scan_spec(spec: JsScanSpec) -> napi::Result<ScanSpec> {
    Ok(ScanSpec {
        table: spec.table,
        index: spec.index,
        bounds: spec.bounds.map(to_bounds).transpose()?,
        order: parse_order(&spec.order)?,
        limit: spec.limit.map(|l| l as usize),
    })
}

fn to_count_spec(spec: JsCountSpec) -> napi::Result<CountSpec> {
    Ok(CountSpec {
        table: spec.table,
        index: spec.index,
        bounds: spec.bounds.map(to_bounds).transpose()?,
    })
}

fn to_bounds(bounds: Vec<JsBound>) -> napi::Result<Vec<Bound>> {
    bounds.into_iter().map(to_bound).collect()
}

fn to_bound(bound: JsBound) -> napi::Result<Bound> {
    match bound.kind.as_str() {
        "eq" => Ok(Bound::Eq {
            value: bound
                .value
                .map(to_value)
                .transpose()?
                .unwrap_or(ColValue::Null),
        }),
        "range" => Ok(Bound::Range {
            lower: bound.lower.map(to_value).transpose()?,
            lower_inclusive: bound.lower_inclusive.unwrap_or(false),
            upper: bound.upper.map(to_value).transpose()?,
            upper_inclusive: bound.upper_inclusive.unwrap_or(false),
        }),
        other => Err(napi::Error::from_reason(format!(
            "invalid bound kind: {other}"
        ))),
    }
}

fn to_write_batch(batch: JsWriteBatch) -> napi::Result<WriteBatch> {
    Ok(WriteBatch {
        upserts: batch
            .upserts
            .into_iter()
            .map(to_upsert)
            .collect::<napi::Result<Vec<_>>>()?,
        deletes: batch
            .deletes
            .into_iter()
            .map(|d| DeleteIn {
                table: d.table,
                id: d.id,
            })
            .collect(),
    })
}

fn to_upsert(u: JsUpsert) -> napi::Result<UpsertIn> {
    Ok(UpsertIn {
        table: u.table,
        id: u.id,
        data: u.data,
        cols: u
            .cols
            .into_iter()
            .map(to_col)
            .collect::<napi::Result<Vec<_>>>()?,
        creation_time: u.creation_time,
    })
}

fn to_col(c: JsColValue) -> napi::Result<(String, ColValue)> {
    let name = c.name;
    let value = to_value(JsValue {
        text: c.text,
        real: c.real,
        int: c.int,
        r#bool: c.r#bool,
    })
    .map_err(|e| napi::Error::from_reason(format!("column value {name}: {e}")))?;
    Ok((name, value))
}

fn to_value(v: JsValue) -> napi::Result<ColValue> {
    let set = usize::from(v.text.is_some())
        + usize::from(v.real.is_some())
        + usize::from(v.int.is_some())
        + usize::from(v.r#bool.is_some());
    if set > 1 {
        return Err(napi::Error::from_reason("multiple value tags set"));
    }

    let value = match (v.text, v.real, v.int, v.r#bool) {
        (Some(t), None, None, None) => ColValue::Text(t),
        (None, Some(r), None, None) => ColValue::Real(r),
        (None, None, Some(i), None) => ColValue::Integer(i),
        (None, None, None, Some(b)) => ColValue::Bool(b),
        (None, None, None, None) => ColValue::Null,
        _ => unreachable!("multiple JsColValue tags already rejected"),
    };
    Ok(value)
}

fn js_doc(d: StoredDoc) -> JsDoc {
    JsDoc {
        id: d.id,
        creation_time: d.creation_time,
        data: d.data,
    }
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "passed as a fn item to Result::map_err, which hands over the error by value"
)]
fn map_err(e: StorageError) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}
