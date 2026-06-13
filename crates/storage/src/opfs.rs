use std::sync::Arc;

use turso_core::{
    io::{FileId, FileSyncType},
    Buffer, Clock, Completion, File, LimboError, MonotonicInstant, OpenFlags, Result,
    WallClockInstant, IO,
};

#[derive(Debug, Default)]
pub struct Opfs;

#[derive(Debug)]
struct OpfsFile {
    handle: i32,
}

unsafe impl Send for Opfs {}
unsafe impl Sync for Opfs {}

unsafe extern "C" {
    fn opfs_get_file(path: *const u8, path_len: usize) -> i32;
    fn opfs_close_file(handle: i32) -> i32;
    fn opfs_read(handle: i32, buffer: *mut u8, buffer_len: usize, offset: f64) -> i32;
    fn opfs_write(handle: i32, buffer: *const u8, buffer_len: usize, offset: f64) -> i32;
    fn opfs_sync(handle: i32) -> i32;
    fn opfs_truncate(handle: i32, length: usize) -> i32;
    fn opfs_remove_file(path: *const u8, path_len: usize) -> i32;
    fn opfs_size(handle: i32) -> f64;
    fn opfs_is_dedicated_worker() -> bool;
}

impl Clock for Opfs {
    fn current_time_monotonic(&self) -> MonotonicInstant {
        MonotonicInstant::now()
    }

    fn current_time_wall_clock(&self) -> WallClockInstant {
        WallClockInstant::now()
    }
}

impl IO for Opfs {
    fn open_file(&self, path: &str, _: OpenFlags, _: bool) -> Result<Arc<dyn File>> {
        ensure_worker("open_file")?;
        // SAFETY: `path.as_ptr()` is valid for `path.len()` bytes for the duration of this call.
        // The imported JS function copies the UTF-8 bytes synchronously.
        let result = unsafe { opfs_get_file(path.as_ptr(), path.len()) };
        if result >= 0 {
            Ok(Arc::new(OpfsFile { handle: result }))
        } else if result == -404 {
            Err(LimboError::InternalError(format!(
                "OPFS file was not registered before opening: {path}"
            )))
        } else {
            Err(LimboError::InternalError(format!(
                "OPFS file lookup failed for {path}: {result}"
            )))
        }
    }

    fn remove_file(&self, path: &str) -> Result<()> {
        ensure_worker("remove_file")?;
        // SAFETY: `path.as_ptr()` is valid for `path.len()` bytes for the duration of this call.
        // The imported JS bridge handles the logical delete synchronously.
        let result = unsafe { opfs_remove_file(path.as_ptr(), path.len()) };
        if result >= 0 {
            Ok(())
        } else {
            Err(LimboError::InternalError(format!(
                "OPFS remove_file failed for {path}: {result}"
            )))
        }
    }

    fn file_id(&self, path: &str) -> Result<FileId> {
        Ok(FileId::from_path_hash(path))
    }
}

/// Best-effort release of the JS-side registry handle; without this, reopening a store in one
/// worker would accumulate OPFS sync-access handles until the worker dies.
impl Drop for OpfsFile {
    fn drop(&mut self) {
        // SAFETY: Imported functions take no pointers; the handle came from `opfs_get_file`.
        unsafe {
            if opfs_is_dedicated_worker() {
                opfs_close_file(self.handle);
            }
        }
    }
}

impl File for OpfsFile {
    fn lock_file(&self, _: bool) -> Result<()> {
        Ok(())
    }

    fn unlock_file(&self) -> Result<()> {
        Ok(())
    }

    fn pread(&self, pos: u64, c: Completion) -> Result<Completion> {
        ensure_worker("read")?;
        let read_c = c.as_read();
        let buffer = read_c.buf_arc();
        let buffer = buffer.as_mut_slice();
        // SAFETY: OPFS sync access handles run in this worker. The mutable buffer points into
        // live WASM memory owned by this completion and is valid for this synchronous call.
        let result =
            unsafe { opfs_read(self.handle, buffer.as_mut_ptr(), buffer.len(), offset(pos)?) };
        c.complete(result);
        Ok(c)
    }

    fn pwrite(&self, pos: u64, buffer: Arc<Buffer>, c: Completion) -> Result<Completion> {
        ensure_worker("write")?;
        c.keep_write_buffer_alive(buffer.clone());
        let buffer = buffer.as_slice();
        // SAFETY: The buffer is kept alive by the completion. The JS import copies from shared
        // WASM memory synchronously before returning.
        let result =
            unsafe { opfs_write(self.handle, buffer.as_ptr(), buffer.len(), offset(pos)?) };
        c.complete(result);
        Ok(c)
    }

    fn sync(&self, c: Completion, _: FileSyncType) -> Result<Completion> {
        ensure_worker("sync")?;
        // SAFETY: The handle was returned by `opfs_get_file` for a registered OPFS file.
        let result = unsafe { opfs_sync(self.handle) };
        c.complete(result);
        Ok(c)
    }

    fn size(&self) -> Result<u64> {
        ensure_worker("size")?;
        // SAFETY: The handle was returned by `opfs_get_file` for a registered OPFS file.
        let result = unsafe { opfs_size(self.handle) };
        if result < 0.0 {
            Err(LimboError::InternalError(format!(
                "OPFS size failed for handle {}: {result}",
                self.handle
            )))
        } else if result > u64::MAX as f64 {
            Err(LimboError::InternalError(format!(
                "OPFS size exceeds u64 for handle {}: {result}",
                self.handle
            )))
        } else {
            Ok(result as u64)
        }
    }

    fn truncate(&self, len: u64, c: Completion) -> Result<Completion> {
        ensure_worker("truncate")?;
        let len = usize::try_from(len).map_err(|_| {
            LimboError::InternalError(format!("OPFS truncate length exceeds usize: {len}"))
        })?;
        // SAFETY: The handle was returned by `opfs_get_file` for a registered OPFS file.
        let result = unsafe { opfs_truncate(self.handle, len) };
        c.complete(result);
        Ok(c)
    }
}

fn ensure_worker(operation: &str) -> Result<()> {
    // SAFETY: Imported function has no arguments and returns whether the JS bridge is running in
    // the dedicated OPFS worker context.
    if unsafe { opfs_is_dedicated_worker() } {
        Ok(())
    } else {
        Err(LimboError::InternalError(format!(
            "OPFS {operation} must run in the embedded worker"
        )))
    }
}

fn offset(pos: u64) -> Result<f64> {
    const MAX_SAFE_JS_INTEGER: u64 = (1_u64 << 53) - 1;
    if pos <= MAX_SAFE_JS_INTEGER {
        Ok(pos as f64)
    } else {
        Err(LimboError::InternalError(format!(
            "OPFS offset exceeds JS number precision: {pos}"
        )))
    }
}
