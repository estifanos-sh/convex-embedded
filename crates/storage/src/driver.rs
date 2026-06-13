#[cfg(test)]
use std::cell::Cell;
use std::{
    num::NonZeroUsize,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

use rustc_hash::FxHashMap;

use crate::error::StorageError;
#[cfg(target_arch = "wasm32")]
use crate::opfs::Opfs;
use crate::sql;
#[cfg(not(target_arch = "wasm32"))]
use turso_core::PlatformIO;
use turso_core::{
    Connection, Database, DatabaseOpts, OpenFlags, Row, Statement, StepResult, Value, IO,
};

#[cfg(test)]
thread_local! {
    static FAIL_NEXT_COMMIT: Cell<bool> = const { Cell::new(false) };
}

#[cfg(test)]
pub(crate) fn fail_next_commit() {
    FAIL_NEXT_COMMIT.set(true);
}

pub(crate) struct TursoDriver {
    io: Arc<dyn IO>,
    // Keep the database alive for the connection lifetime.
    _keep_alive: Arc<Database>,
    conn: Arc<Connection>,
    /// Prepared statements keyed by SQL text. Statements are taken out for the duration of a
    /// run and put back only on success, so a failed statement is simply re-prepared next time.
    stmts: Mutex<FxHashMap<Box<str>, Statement>>,
}

impl TursoDriver {
    pub(crate) fn open(path: &str) -> Result<Self, StorageError> {
        #[cfg(target_arch = "wasm32")]
        let io: Arc<dyn IO> = Arc::new(Opfs);
        #[cfg(not(target_arch = "wasm32"))]
        let io: Arc<dyn IO> = Arc::new(PlatformIO::new()?);
        let driver = Self::open_with_io(path, io)?;
        driver.tune()?;
        Ok(driver)
    }

    pub(crate) fn open_with_io(path: &str, io: Arc<dyn IO>) -> Result<Self, StorageError> {
        let db = Database::open_file_with_flags(
            io.clone(),
            path,
            OpenFlags::Create,
            DatabaseOpts::new().with_custom_types(true),
            None,
        )?;
        let conn = db.connect()?;
        Ok(Self {
            io,
            _keep_alive: db,
            conn,
            stmts: Mutex::new(FxHashMap::default()),
        })
    }

    pub(crate) fn execute(&self, sql: &str, params: Vec<Value>) -> Result<(), StorageError> {
        #[cfg(test)]
        if sql == sql::COMMIT && FAIL_NEXT_COMMIT.replace(false) {
            return Err(turso_core::LimboError::Busy.into());
        }
        self.run_rows(sql, params, |_| Ok(()))
    }

    /// Run a statement, streaming each result row through `on_row` as it is stepped. Rows are
    /// register pointers invalidated by the next step, so `on_row` must decode, not retain.
    /// The statement is always reset before going back to the cache, even on error, so it never
    /// holds locks or registers between runs.
    pub(crate) fn run_rows(
        &self,
        sql: &str,
        params: Vec<Value>,
        mut on_row: impl FnMut(&Row) -> Result<(), StorageError>,
    ) -> Result<(), StorageError> {
        let mut stmt = self.take_stmt(sql)?;
        bind(&mut stmt, params);
        let result = step_rows(&self.io, &mut stmt, sql, &mut on_row);
        stmt.reset_best_effort();
        if result.is_ok() {
            self.put_stmt(sql, stmt);
        }
        result
    }

    /// Run a statement expected to yield at most one row and decode it.
    pub(crate) fn run_row<T>(
        &self,
        sql: &str,
        params: Vec<Value>,
        decode: impl FnOnce(&Row) -> Result<T, StorageError>,
    ) -> Result<Option<T>, StorageError> {
        let mut decode = Some(decode);
        let mut out = None;
        self.run_rows(sql, params, |row| {
            if let Some(decode) = decode.take() {
                out = Some(decode(row)?);
            }
            Ok(())
        })?;
        Ok(out)
    }

    /// Rows affected by the most recent statement.
    pub(crate) fn changes(&self) -> i64 {
        self.conn.changes()
    }

    /// Drop all cached prepared statements (called when the schema changes).
    pub(crate) fn clear_statements(&self) {
        lock(&self.stmts).clear();
    }

    fn take_stmt(&self, sql: &str) -> Result<Statement, StorageError> {
        if let Some(mut stmt) = lock(&self.stmts).remove(sql) {
            stmt.clear_bindings();
            return Ok(stmt);
        }
        Ok(self.conn.prepare(sql)?)
    }

    fn put_stmt(&self, sql: &str, stmt: Statement) {
        lock(&self.stmts).insert(sql.into(), stmt);
    }

    fn tune(&self) -> Result<(), StorageError> {
        for pragma in sql::PRAGMAS {
            self.execute(pragma, Vec::new())?;
        }
        self.conn.set_busy_timeout(Duration::from_secs(5));
        Ok(())
    }
}

/// The guarded state is coherent at every release point, so a poisoned guard is safe to use.
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn bind(stmt: &mut Statement, params: Vec<Value>) {
    for (i, value) in params.into_iter().enumerate() {
        let index = NonZeroUsize::new(i + 1).expect("bind indexes are one-based");
        stmt.bind_at(index, value);
    }
}

fn step_rows(
    io: &Arc<dyn IO>,
    stmt: &mut Statement,
    sql: &str,
    on_row: &mut impl FnMut(&Row) -> Result<(), StorageError>,
) -> Result<(), StorageError> {
    loop {
        match stmt.step()? {
            StepResult::Done => return Ok(()),
            StepResult::IO => io_step(io, "run", sql)?,
            StepResult::Row => {
                let Some(row) = stmt.row() else {
                    return Err(turso_core::LimboError::InternalError(
                        "step returned row without row data".to_owned(),
                    )
                    .into());
                };
                on_row(row)?;
            }
            StepResult::Interrupt | StepResult::Busy => {
                return Err(turso_core::LimboError::Busy.into())
            }
        }
    }
}

fn io_step(io: &Arc<dyn IO>, operation: &'static str, sql: &str) -> Result<(), StorageError> {
    io.step().map_err(|source| StorageError::IoStep {
        operation,
        sql: sql.to_owned(),
        source: Box::new(source),
    })
}
