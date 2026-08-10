#![allow(
    unreachable_pub,
    reason = "Android resolves these exported JNI entry points by their stable symbol names"
)]

use std::panic::{catch_unwind, AssertUnwindSafe};

use jni::{
    objects::{JByteArray, JClass, JString},
    sys::{jbyteArray, jdouble, jlong},
    JNIEnv,
};

use crate::{clock_read, close_handle, open_path, request_bytes, BridgeError};

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_convex_embedded_mobile_Native_bridgeContractId(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
) -> jni::sys::jstring {
    env.new_string(storage::CURRENT_MOBILE_BRIDGE_CONTRACT_ID)
        .map(JString::into_raw)
        .unwrap_or_default()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_convex_embedded_mobile_Native_wireContractId(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
) -> jni::sys::jstring {
    env.new_string(storage::CURRENT_WIRE_CONTRACT_ID)
        .map(JString::into_raw)
        .unwrap_or_default()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_convex_embedded_mobile_Native_storageBindingContractId(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
) -> jni::sys::jstring {
    env.new_string(storage::CURRENT_STORAGE_BINDING_CONTRACT_ID)
        .map(JString::into_raw)
        .unwrap_or_default()
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_convex_embedded_mobile_Native_open(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    path: JString<'_>,
    selector_key: JString<'_>,
    default_identity_key: JString<'_>,
) -> jlong {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let path = java_string(&mut env, path, "path")?
            .ok_or_else(|| BridgeError::Protocol("path must not be null".to_owned()))?;
        let selector_key = java_string(&mut env, selector_key, "selectorKey")?;
        let default_identity_key =
            java_string(&mut env, default_identity_key, "defaultIdentityKey")?;
        open_path(path, selector_key, default_identity_key)
    }));
    match result {
        Ok(Ok(handle)) => handle as jlong,
        Ok(Err(error)) => {
            throw(&mut env, &error.marker());
            0
        }
        Err(_) => {
            throw(&mut env, "mobile open panicked");
            0
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_convex_embedded_mobile_Native_call(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
    request: JByteArray<'_>,
) -> jbyteArray {
    let result = catch_unwind(AssertUnwindSafe(|| {
        let request = env.convert_byte_array(request).map_err(|error| {
            BridgeError::Protocol(format!("request bytes are invalid: {error}"))
        })?;
        let response = request_bytes(handle as u64, &request);
        env.byte_array_from_slice(&response)
            .map(JByteArray::into_raw)
            .map_err(|error| BridgeError::Host(format!("response allocation failed: {error}")))
    }));
    match result {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            throw(&mut env, &error.to_string());
            JByteArray::default().into_raw()
        }
        Err(_) => {
            throw(&mut env, "mobile request panicked");
            JByteArray::default().into_raw()
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_convex_embedded_mobile_Native_clockRead(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) -> jdouble {
    match catch_unwind(AssertUnwindSafe(|| clock_read(handle as u64))) {
        Ok(Ok(value)) => value,
        Ok(Err(error)) => {
            throw(&mut env, &error.to_string());
            f64::NAN
        }
        Err(_) => {
            throw(&mut env, "mobile clock read panicked");
            f64::NAN
        }
    }
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_convex_embedded_mobile_Native_close(
    mut env: JNIEnv<'_>,
    _class: JClass<'_>,
    handle: jlong,
) {
    match catch_unwind(AssertUnwindSafe(|| close_handle(handle as u64))) {
        Ok(Ok(())) => {}
        Ok(Err(error)) => throw(&mut env, &error.to_string()),
        Err(_) => throw(&mut env, "mobile close panicked"),
    }
}

fn java_string(
    env: &mut JNIEnv<'_>,
    value: JString<'_>,
    label: &str,
) -> Result<Option<String>, BridgeError> {
    if value.is_null() {
        return Ok(None);
    }
    env.get_string(&value)
        .map(|value| Some(value.into()))
        .map_err(|error| BridgeError::Protocol(format!("{label} is invalid: {error}")))
}

fn throw(env: &mut JNIEnv<'_>, message: &str) {
    env.throw_new("java/lang/IllegalStateException", message)
        .ok();
}
