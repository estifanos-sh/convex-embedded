use std::time::Duration;

use crate::error::StorageError;

pub struct TursoDriver {
    conn: turso::Connection,
}

impl TursoDriver {
    pub async fn open(path: &str) -> Result<Self, StorageError> {
        let db = turso::Builder::new_local(path)
            .experimental_custom_types(true)
            .build()
            .await?;
        let conn = db.connect()?;
        exec_drain(&conn, "PRAGMA journal_mode = WAL").await?;
        exec_drain(&conn, "PRAGMA synchronous = NORMAL").await?;
        exec_drain(&conn, "PRAGMA temp_store = MEMORY").await?;
        conn.busy_timeout(Duration::from_secs(5))?;
        Ok(Self { conn })
    }

    pub fn conn(&self) -> &turso::Connection {
        &self.conn
    }
}

async fn exec_drain(conn: &turso::Connection, sql: &str) -> Result<(), StorageError> {
    let mut rows = conn.query(sql, ()).await?;
    while rows.next().await?.is_some() {}
    Ok(())
}
