#![allow(clippy::items_after_test_module)]

#[cfg(any(test, feature = "testkit"))]
use std::cell::Cell;
use std::{
    num::NonZeroUsize,
    ops::ControlFlow,
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc, Mutex, PoisonError,
    },
    time::{Duration, Instant},
};

use rustc_hash::FxHashMap;

use crate::error::StorageError;
#[cfg(target_arch = "wasm32")]
use crate::opfs::Opfs;
use crate::sql;
#[cfg(not(target_arch = "wasm32"))]
use turso_core::PlatformIO;
use turso_core::{
    Connection, Database, DatabaseOpts, MemoryIO, OpenFlags, Row, Statement, StepResult, Value, IO,
};

#[cfg(any(test, feature = "testkit"))]
thread_local! {
    static FAIL_NEXT_COMMIT: Cell<bool> = const { Cell::new(false) };
}

#[cfg(any(test, feature = "testkit"))]
pub(crate) fn fail_next_commit() {
    FAIL_NEXT_COMMIT.set(true);
}

pub(crate) struct TursoDriver {
    io: Arc<dyn IO>,
    /// Keep the database alive for the connection lifetime.
    _keep_alive: Arc<Database>,
    conn: Arc<Connection>,
    generation: AtomicI64,
    /// Prepared statements keyed by SQL text. The key stays resident while the statement is checked
    /// out, avoiding a key allocation on every hot statement execution. Failed statements are left as
    /// empty slots and re-prepared on the next run.
    stmts: Mutex<FxHashMap<Box<str>, Option<Statement>>>,
}

impl TursoDriver {
    pub(crate) fn open(path: &str) -> Result<Self, StorageError> {
        if path.starts_with(":memory:") {
            return Self::open_tuned(path, Arc::new(MemoryIO::new()));
        }
        #[cfg(target_arch = "wasm32")]
        let io: Arc<dyn IO> = Arc::new(Opfs);
        #[cfg(not(target_arch = "wasm32"))]
        let io: Arc<dyn IO> = Arc::new(PlatformIO::new()?);
        Self::open_tuned(path, io)
    }

    /// Open, tune, and prove the physical store is readable. The version probe forces turso to parse
    /// the database header inside this boundary, so a pre-existing store written by an incompatible
    /// build fails closed here rather than escaping later from schema setup. The caller preserves
    /// the unreadable bytes for recovery or a future compatible runtime.
    fn open_tuned(path: &str, io: Arc<dyn IO>) -> Result<Self, StorageError> {
        let opened = Instant::now();
        let driver = Self::open_with_io(path, io)?;
        crate::log_open_phase("db_open", opened);
        let tuned = Instant::now();
        driver.tune()?;
        crate::log_open_phase("pragmas", tuned);
        let probed = Instant::now();
        driver.run_rows(sql::READ_USER_VERSION, Vec::new(), |_| Ok(()))?;
        crate::log_open_phase("first_read", probed);
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
            generation: AtomicI64::new(0),
            stmts: Mutex::new(FxHashMap::default()),
        })
    }

    pub(crate) fn generation(&self) -> i64 {
        self.generation.load(Ordering::Acquire)
    }

    pub(crate) fn generation_write(&self, generation: i64) {
        let previous = self.generation.swap(generation, Ordering::AcqRel);
        if previous != generation {
            self.clear_statements();
        }
    }

    pub(crate) fn wal_write(&self) -> Result<(), StorageError> {
        self.run_rows("PRAGMA wal_checkpoint(TRUNCATE)", Vec::new(), |_| Ok(()))
    }

    pub(crate) fn execute<I>(&self, sql: &str, params: I) -> Result<(), StorageError>
    where
        I: IntoIterator<Item = Value>,
    {
        #[cfg(any(test, feature = "testkit"))]
        if sql == sql::COMMIT && FAIL_NEXT_COMMIT.replace(false) {
            return Err(turso_core::LimboError::Busy.into());
        }
        self.run_rows(sql, params, |_| Ok(()))
    }

    /// Run a statement, streaming each result row through `on_row` as it is stepped. Rows are
    /// register pointers invalidated by the next step, so `on_row` must decode, not retain.
    /// The statement is always reset before going back to the cache, even on error, so it never
    /// holds locks or registers between runs.
    pub(crate) fn run_rows<I>(
        &self,
        sql: &str,
        params: I,
        mut on_row: impl FnMut(&Row) -> Result<(), StorageError>,
    ) -> Result<(), StorageError>
    where
        I: IntoIterator<Item = Value>,
    {
        self.run_rows_until(sql, params, |row| {
            on_row(row)?;
            Ok(ControlFlow::Continue(()))
        })
    }

    /// Run a statement, streaming each result row through `on_row` until it asks to stop by
    /// returning `ControlFlow::Break`. Callers driving a byte or record budget break as soon as the
    /// budget is reached, so large trailing rows are never stepped. Rows are register pointers
    /// invalidated by the next step, so `on_row` must decode, not retain. Break only outside an open
    /// transaction: under turso 0.6 resetting a half-stepped statement strands the transaction so the
    /// following commit or rollback fails.
    pub(crate) fn run_rows_until<I>(
        &self,
        sql: &str,
        params: I,
        mut on_row: impl FnMut(&Row) -> Result<ControlFlow<()>, StorageError>,
    ) -> Result<(), StorageError>
    where
        I: IntoIterator<Item = Value>,
    {
        let sql = sql::generation_sql(sql, self.generation());
        let sql = sql.as_ref();
        let mut stmt = self.take_stmt(sql)?;
        bind(&mut stmt, params)?;
        let result = step_rows(&self.io, &mut stmt, sql, &mut on_row);
        stmt.reset_best_effort();
        if result.is_ok() {
            self.put_stmt(sql, stmt);
        }
        result
    }

    /// Run a statement expected to yield at most one row and decode it. The statement is stepped to
    /// completion: a partial step followed by a reset leaves turso 0.6 unable to commit or roll back
    /// an enclosing transaction, so callers that want to stop early use `run_rows_until` directly,
    /// outside any open transaction.
    pub(crate) fn run_row<T, I>(
        &self,
        sql: &str,
        params: I,
        decode: impl FnOnce(&Row) -> Result<T, StorageError>,
    ) -> Result<Option<T>, StorageError>
    where
        I: IntoIterator<Item = Value>,
    {
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
        if let Some(slot) = lock(&self.stmts).get_mut(sql) {
            if let Some(mut stmt) = slot.take() {
                stmt.clear_bindings();
                return Ok(stmt);
            }
        }
        Ok(self.conn.prepare(sql)?)
    }

    fn put_stmt(&self, sql: &str, stmt: Statement) {
        let mut stmts = lock(&self.stmts);
        match stmts.get_mut(sql) {
            Some(slot) => *slot = Some(stmt),
            None => {
                stmts.insert(sql.into(), Some(stmt));
            }
        }
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

#[cfg(test)]
mod tests {
    use super::TursoDriver;

    #[test]
    fn memory_path_uses_the_memory_backend() {
        let driver = TursoDriver::open(":memory:storage-driver").expect("open memory store");
        driver
            .run_rows("SELECT 1", Vec::new(), |_| Ok(()))
            .expect("read memory store");
    }
}

fn bind<I>(stmt: &mut Statement, params: I) -> Result<(), StorageError>
where
    I: IntoIterator<Item = Value>,
{
    for (i, value) in params.into_iter().enumerate() {
        let index = NonZeroUsize::new(i + 1).expect("bind indexes are one-based");
        stmt.bind_at(index, value)?;
    }
    Ok(())
}

fn step_rows(
    io: &Arc<dyn IO>,
    stmt: &mut Statement,
    sql: &str,
    on_row: &mut impl FnMut(&Row) -> Result<ControlFlow<()>, StorageError>,
) -> Result<(), StorageError> {
    loop {
        match stmt.step()? {
            StepResult::Done => return Ok(()),
            StepResult::IO | StepResult::Yield => io_step(io, "run", sql)?,
            StepResult::Row => {
                let Some(row) = stmt.row() else {
                    return Err(turso_core::LimboError::InternalError(
                        "step returned row without row data".to_owned(),
                    )
                    .into());
                };
                if on_row(row)?.is_break() {
                    return Ok(());
                }
            }
            StepResult::Interrupt | StepResult::Busy => {
                return Err(turso_core::LimboError::Busy.into());
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
