use std::{
    ffi::{c_char, CStr},
    panic::{catch_unwind, AssertUnwindSafe},
    ptr,
};

use crate::{clock_read, close_handle, open_path, request_bytes, BridgeError};

/// Owned byte buffer returned across the C ABI.
#[repr(C)]
pub struct CemBuffer {
    pub ptr: *mut u8,
    pub len: usize,
    pub capacity: usize,
}

impl CemBuffer {
    fn from_vec(mut bytes: Vec<u8>) -> Self {
        let buffer = Self {
            ptr: bytes.as_mut_ptr(),
            len: bytes.len(),
            capacity: bytes.capacity(),
        };
        std::mem::forget(bytes);
        buffer
    }

    const fn empty() -> Self {
        Self {
            ptr: ptr::null_mut(),
            len: 0,
            capacity: 0,
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn cem_api_version() -> u32 {
    crate::API_VERSION
}

/// Open a store and return its opaque registry handle.
///
/// On failure this returns `0` and writes a UTF-8 error into `error` when it is non-null.
///
/// # Safety
///
/// `path` must be a valid NUL-terminated C string. Each non-null optional string must also be a
/// valid NUL-terminated C string. A non-null `error` must point to writable `CemBuffer` storage.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cem_open_path(
    path: *const c_char,
    selector_key: *const c_char,
    default_identity_key: *const c_char,
    error: *mut CemBuffer,
) -> u64 {
    ffi_result(error, || {
        // SAFETY: this exported function's contract requires each non-null input to be a valid,
        // NUL-terminated C string for the duration of this synchronous call.
        let path = unsafe { required_string(path, "path")? };
        // SAFETY: same foreign-caller contract as above; null represents `None`.
        let selector_key = unsafe { optional_string(selector_key)? };
        // SAFETY: same foreign-caller contract as above; null represents `None`.
        let default_identity_key = unsafe { optional_string(default_identity_key)? };
        open_path(path, selector_key, default_identity_key)
    })
    .unwrap_or(0)
}

/// Dispatch one `MessagePack` request and return a `MessagePack` response.
///
/// # Safety
///
/// When `len` is non-zero, `bytes` must point to at least `len` initialized bytes. The input only
/// needs to remain valid for this synchronous call because it is copied before dispatch.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cem_request(handle: u64, bytes: *const u8, len: usize) -> CemBuffer {
    let result = catch_unwind(AssertUnwindSafe(|| {
        // SAFETY: this exported function's contract requires `bytes` to describe `len`
        // initialized bytes for this synchronous call. Copying immediately prevents a borrowed
        // foreign lifetime from escaping into the Rust host.
        unsafe { owned_bytes(bytes, len) }.map(|bytes| request_bytes(handle, &bytes))
    }));
    match result {
        Ok(Ok(bytes)) => CemBuffer::from_vec(bytes),
        Ok(Err(error)) => CemBuffer::from_vec(error.to_string().into_bytes()),
        Err(_) => CemBuffer::from_vec(b"mobile request panicked".to_vec()),
    }
}

/// Read the in-memory monotonic clock without posting database I/O.
///
/// On failure this returns `NaN` and writes a UTF-8 error into `error` when it is non-null.
///
/// # Safety
///
/// A non-null `error` must point to writable `CemBuffer` storage.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cem_clock_read_value(handle: u64, error: *mut CemBuffer) -> f64 {
    ffi_result(error, || clock_read(handle)).unwrap_or(f64::NAN)
}

/// Close a store. The returned UTF-8 buffer is empty on success and contains an error otherwise.
#[unsafe(no_mangle)]
pub extern "C" fn cem_close(handle: u64) -> CemBuffer {
    match catch_unwind(AssertUnwindSafe(|| close_handle(handle))) {
        Ok(Ok(())) => CemBuffer::empty(),
        Ok(Err(error)) => CemBuffer::from_vec(error.to_string().into_bytes()),
        Err(_) => CemBuffer::from_vec(b"mobile close panicked".to_vec()),
    }
}

/// Release a buffer returned by this library.
///
/// # Safety
///
/// `buffer` must be an owned value returned by a `cem_*` function in this library and must not
/// have been freed previously. Empty buffers are always safe to pass.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn cem_buffer_free(buffer: CemBuffer) {
    if buffer.capacity == 0 {
        return;
    }
    // SAFETY: `CemBuffer` values with non-zero capacity are created exclusively by
    // `CemBuffer::from_vec`; ownership is transferred exactly once to this function.
    unsafe {
        drop(Vec::from_raw_parts(buffer.ptr, buffer.len, buffer.capacity));
    }
}

fn ffi_result<T>(
    error: *mut CemBuffer,
    operation: impl FnOnce() -> Result<T, BridgeError>,
) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(operation)) {
        Ok(Ok(value)) => {
            write_error(error, CemBuffer::empty());
            Some(value)
        }
        Ok(Err(failure)) => {
            write_error(error, CemBuffer::from_vec(failure.to_string().into_bytes()));
            None
        }
        Err(_) => {
            write_error(
                error,
                CemBuffer::from_vec(b"mobile FFI call panicked".to_vec()),
            );
            None
        }
    }
}

fn write_error(destination: *mut CemBuffer, value: CemBuffer) {
    if destination.is_null() {
        if value.capacity != 0 {
            // SAFETY: values passed here are freshly created by `CemBuffer::from_vec`, and a null
            // destination means ownership was not transferred to the foreign caller.
            unsafe {
                drop(Vec::from_raw_parts(value.ptr, value.len, value.capacity));
            }
        }
        return;
    }
    // SAFETY: the caller supplied a non-null out pointer to writable `CemBuffer` storage.
    unsafe {
        destination.write(value);
    }
}

unsafe fn required_string(value: *const c_char, label: &str) -> Result<String, BridgeError> {
    if value.is_null() {
        return Err(BridgeError::Protocol(format!("{label} must not be null")));
    }
    // SAFETY: the foreign caller guarantees a valid NUL-terminated string for non-null inputs.
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(str::to_owned)
        .map_err(|error| BridgeError::Protocol(format!("{label} is not UTF-8: {error}")))
}

unsafe fn optional_string(value: *const c_char) -> Result<Option<String>, BridgeError> {
    if value.is_null() {
        return Ok(None);
    }
    // SAFETY: the foreign caller guarantees a valid NUL-terminated string for non-null inputs.
    unsafe { CStr::from_ptr(value) }
        .to_str()
        .map(|value| Some(value.to_owned()))
        .map_err(|error| BridgeError::Protocol(format!("string is not UTF-8: {error}")))
}

unsafe fn owned_bytes(bytes: *const u8, len: usize) -> Result<Vec<u8>, BridgeError> {
    if len == 0 {
        return Ok(Vec::new());
    }
    if bytes.is_null() {
        return Err(BridgeError::Protocol(
            "request bytes are null with non-zero length".to_owned(),
        ));
    }
    // SAFETY: the foreign caller guarantees `bytes` points to `len` initialized bytes and keeps
    // them alive for the duration of this synchronous call.
    Ok(unsafe { std::slice::from_raw_parts(bytes, len) }.to_vec())
}

#[cfg(test)]
mod tests {
    use std::ptr;

    use super::{cem_clock_read_value, cem_open_path};

    #[test]
    fn null_error_pointer_drops_failures_without_crossing_the_ffi() {
        // SAFETY: null is explicitly accepted for the error out-pointer, and a null path is a
        // deliberate invalid input covered by `cem_open_path`'s validation.
        let handle =
            unsafe { cem_open_path(ptr::null(), ptr::null(), ptr::null(), ptr::null_mut()) };
        assert_eq!(handle, 0);

        // SAFETY: any integer is a valid opaque handle input and null is accepted for errors.
        let clock = unsafe { cem_clock_read_value(u64::MAX, ptr::null_mut()) };
        assert!(clock.is_nan());
    }
}
