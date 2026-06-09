use std::sync::{Mutex, PoisonError};

use rustc_hash::FxHashMap;
use turso::transaction::{Transaction, TransactionBehavior};

use crate::clock::{wall_ms, Clock};
use crate::driver::TursoDriver;
use crate::error::StorageError;
use crate::sql::{
    compile_count, compile_scan, count_key, count_params, scan_key, scan_params, CompileResult,
    SCAN_CAP,
};
use crate::types::{
    ColValue, CountSpec, ReadOutcome, ScanSpec, StoreSchema, StoredDoc, TableDef, WriteBatch,
};

const SELECT_DOC: &str = "id, creation_time_ms, data";
const RESERVED: [&str; 4] = ["id", "identity_key", "creation_time_ms", "data"];

pub struct EmbeddedStore {
    driver: TursoDriver,
    identity_key: String,
    tables: Mutex<FxHashMap<String, TableDef>>,
    plans: Mutex<FxHashMap<String, CompileResult>>,
    clock: Mutex<Clock>,
}

impl EmbeddedStore {
    pub async fn open(path: &str) -> Result<Self, StorageError> {
        Self::open_with_identity_key(path, "").await
    }

    pub async fn open_with_identity_key(
        path: &str,
        identity_key: &str,
    ) -> Result<Self, StorageError> {
        let driver = TursoDriver::open(path).await?;
        Ok(Self {
            driver,
            identity_key: identity_key.to_owned(),
            tables: Mutex::new(FxHashMap::default()),
            plans: Mutex::new(FxHashMap::default()),
            clock: Mutex::new(Clock::new()),
        })
    }

    pub async fn setup(&self, schema: StoreSchema) -> Result<(), StorageError> {
        let conn = self.driver.conn();
        for table in &schema.tables {
            validate_ident(&table.name)?;
            let mut extra = String::new();
            for c in &table.columns {
                validate_ident(&c.name)?;
                if RESERVED.contains(&c.name.as_str()) {
                    return Err(StorageError::ReservedColumn(c.name.clone()));
                }
                extra.push_str(", ");
                extra.push_str(&c.name);
                extra.push(' ');
                extra.push_str(c.affinity.keyword());
            }
            let create = format!(
                "CREATE TABLE IF NOT EXISTS doc__{} \
                 (id TEXT NOT NULL, identity_key TEXT NOT NULL, creation_time_ms REAL NOT NULL, \
                  data json NOT NULL{extra}, PRIMARY KEY (identity_key, id)) STRICT",
                table.name,
            );
            conn.execute(&create, ()).await?;
            for index in &table.indexes {
                validate_ident(&index.name)?;
                for field in &index.fields {
                    validate_ident(field)?;
                }
                let create_ix = format!(
                    "CREATE INDEX IF NOT EXISTS ix__{tbl}__{name} \
                     ON doc__{tbl} (identity_key, {fields}, creation_time_ms, id)",
                    tbl = table.name,
                    name = index.name,
                    fields = index.fields.join(", "),
                );
                conn.execute(&create_ix, ()).await?;
            }
            self.tables
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .insert(table.name.clone(), table.clone());
        }
        self.plans
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
        let high = self.max_creation_time().await?;
        self.clock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .observe(high);
        Ok(())
    }

    /// The next monotonic creation time. Mirrors `nextCreationTime`.
    /// Calling this consumes a clock tick immediately, even if no commit follows.
    pub fn next_creation_time(&self) -> Result<f64, StorageError> {
        let wall = wall_ms()?;
        Ok(self
            .clock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .now(wall))
    }

    async fn max_creation_time(&self) -> Result<f64, StorageError> {
        let names: Vec<String> = self
            .tables
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        let conn = self.driver.conn();
        let mut max = 0.0_f64;
        for name in names {
            let sql = format!(
                "SELECT MAX(creation_time_ms) AS m FROM doc__{name} WHERE identity_key = ?"
            );
            let params = vec![turso::Value::Text(self.identity_key.clone())];
            let mut rows = conn.query(&sql, params).await?;
            if let Some(row) = rows.next().await? {
                if !matches!(row.get_value(0)?, turso::Value::Null) {
                    let m = take_real(&row, 0)?;
                    if m > max {
                        max = m;
                    }
                }
            }
        }
        Ok(max)
    }
    pub async fn clear(&self) -> Result<(), StorageError> {
        let names: Vec<String> = self
            .tables
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .keys()
            .cloned()
            .collect();
        let conn = self.driver.conn();
        for name in names {
            let sql = format!("DELETE FROM doc__{name} WHERE identity_key = ?");
            conn.execute(&sql, vec![turso::Value::Text(self.identity_key.clone())])
                .await?;
        }
        Ok(())
    }

    /// Fetch one document by id. Mirrors `get`.
    pub async fn get(&self, table: &str, id: &str) -> Result<Option<StoredDoc>, StorageError> {
        self.def(table)?;
        let conn = self.driver.conn();
        let sql =
            format!("SELECT {SELECT_DOC} FROM doc__{table} WHERE identity_key = ? AND id = ?");
        let params = vec![
            turso::Value::Text(self.identity_key.clone()),
            turso::Value::Text(id.to_owned()),
        ];
        let mut rows = conn.query(&sql, params).await?;
        match rows.next().await? {
            Some(row) => Ok(Some(row_to_doc(&row)?)),
            None => Ok(None),
        }
    }

    pub async fn scan(&self, spec: &ScanSpec) -> Result<ReadOutcome<Vec<StoredDoc>>, StorageError> {
        let table = self.def(&spec.table)?;
        if let Some(limit) = spec.limit {
            if limit > SCAN_CAP {
                return Err(StorageError::Unsatisfiable(format!(
                    "scan: limit {limit} exceeds {SCAN_CAP}"
                )));
            }
        }
        let compiled = self.compile(scan_key(spec), || compile_scan(spec, &table));
        let (sql, _columns) = match compiled {
            CompileResult::Miss => return Ok(ReadOutcome::Unsupported),
            CompileResult::Unsatisfiable { reason } => {
                return Err(StorageError::Unsatisfiable(format!("scan: {reason}")))
            }
            CompileResult::Sql { sql, columns } => (sql, columns),
        };

        let mut params = vec![turso::Value::Text(self.identity_key.clone())];
        params.extend(scan_params(spec));
        let conn = self.driver.conn();
        let mut rows = conn.query(&sql, params).await?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(row_to_doc(&row)?);
        }
        if spec.limit.is_none() && out.len() > SCAN_CAP {
            return Err(StorageError::Unsatisfiable(format!(
                "scan exceeded {SCAN_CAP} documents; add an index bound or a limit"
            )));
        }
        Ok(ReadOutcome::Executed(out))
    }

    /// Count documents. `ReadOutcome::Unsupported` means the plan shape cannot be executed here.
    pub async fn count(&self, spec: &CountSpec) -> Result<ReadOutcome<i64>, StorageError> {
        let table = self.def(&spec.table)?;
        let compiled = self.compile(count_key(spec), || compile_count(spec, &table));
        let sql = match compiled {
            CompileResult::Miss => return Ok(ReadOutcome::Unsupported),
            CompileResult::Unsatisfiable { reason } => {
                return Err(StorageError::Unsatisfiable(format!("count: {reason}")))
            }
            CompileResult::Sql { sql, .. } => sql,
        };

        let mut params = vec![turso::Value::Text(self.identity_key.clone())];
        params.extend(count_params(spec));
        let conn = self.driver.conn();
        let mut rows = conn.query(&sql, params).await?;
        match rows.next().await? {
            Some(row) => Ok(ReadOutcome::Executed(take_int(&row, 0)?)),
            None => Ok(ReadOutcome::Executed(0)),
        }
    }
    pub async fn commit(&self, batch: WriteBatch) -> Result<(), StorageError> {
        let mut upsert_plans = Vec::with_capacity(batch.upserts.len());
        for up in &batch.upserts {
            let def = self.def(&up.table)?;
            let cols: Vec<String> = def.columns.iter().map(|c| c.name.clone()).collect();
            upsert_plans.push((up, cols));
        }
        for del in &batch.deletes {
            self.def(&del.table)?;
        }

        let conn = self.driver.conn();
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate).await?;
        let written: Result<(), StorageError> = async {
            for (up, cols) in &upsert_plans {
                let col_list = if cols.is_empty() {
                    String::new()
                } else {
                    format!(", {}", cols.join(", "))
                };
                let placeholders = ", ?".repeat(cols.len());
                let sql = format!(
                    "INSERT OR REPLACE INTO doc__{table} \
                     (id, identity_key, creation_time_ms, data{col_list}) \
                     VALUES (?, ?, ?, ?{placeholders})",
                    table = up.table,
                );
                let mut params = vec![
                    turso::Value::Text(up.id.clone()),
                    turso::Value::Text(self.identity_key.clone()),
                    turso::Value::Real(up.creation_time),
                    turso::Value::Text(up.data.clone()),
                ];
                for col in cols {
                    let value = up
                        .cols
                        .iter()
                        .find(|(name, _)| name == col)
                        .map_or(ColValue::Null, |(_, v)| v.clone());
                    params.push(value.into());
                }
                let mut stmt = tx.prepare(&sql).await?;
                stmt.execute(params).await?;
            }
            for del in &batch.deletes {
                let sql = format!(
                    "DELETE FROM doc__{} WHERE identity_key = ? AND id = ?",
                    del.table
                );
                let params = vec![
                    turso::Value::Text(self.identity_key.clone()),
                    turso::Value::Text(del.id.clone()),
                ];
                let mut stmt = tx.prepare(&sql).await?;
                stmt.execute(params).await?;
            }
            Ok(())
        }
        .await;

        match written {
            Ok(()) => {
                tx.commit().await?;
                Ok(())
            }
            Err(e) => {
                tx.rollback().await.ok();
                Err(e)
            }
        }
    }

    fn def(&self, table: &str) -> Result<TableDef, StorageError> {
        self.tables
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(table)
            .cloned()
            .ok_or_else(|| StorageError::InvalidIdent(table.to_owned()))
    }

    fn compile(&self, key: String, build: impl FnOnce() -> CompileResult) -> CompileResult {
        let mut plans = self.plans.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(compiled) = plans.get(&key) {
            return compiled.clone();
        }
        let compiled = build();
        plans.insert(key, compiled.clone());
        compiled
    }
}

fn validate_ident(name: &str) -> Result<(), StorageError> {
    let bytes = name.as_bytes();
    let valid = !bytes.is_empty()
        && bytes.len() <= 64
        && !bytes[0].is_ascii_digit()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_');
    if valid {
        Ok(())
    } else {
        Err(StorageError::InvalidIdent(name.to_owned()))
    }
}

fn row_to_doc(row: &turso::Row) -> Result<StoredDoc, StorageError> {
    Ok(StoredDoc {
        id: take_text(row, 0)?,
        creation_time: take_real(row, 1)?,
        data: take_text(row, 2)?,
    })
}

fn take_text(row: &turso::Row, i: usize) -> Result<String, StorageError> {
    match row.get_value(i)? {
        turso::Value::Text(s) => Ok(s),
        v => Err(StorageError::Decode {
            expected: "text",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

fn take_real(row: &turso::Row, i: usize) -> Result<f64, StorageError> {
    match row.get_value(i)? {
        turso::Value::Real(n) => Ok(n),
        turso::Value::Integer(n) => Ok(n as f64),
        v => Err(StorageError::Decode {
            expected: "real",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}

fn take_int(row: &turso::Row, i: usize) -> Result<i64, StorageError> {
    match row.get_value(i)? {
        turso::Value::Integer(n) => Ok(n),
        v => Err(StorageError::Decode {
            expected: "integer",
            index: i,
            got: format!("{v:?}"),
        }),
    }
}
