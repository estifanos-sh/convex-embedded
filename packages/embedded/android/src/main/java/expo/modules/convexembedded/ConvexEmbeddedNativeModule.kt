package expo.modules.convexembedded

import dev.convex.embedded.mobile.Native
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.sharedobjects.SharedObject
import java.io.File

class ConvexEmbeddedNativeModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ConvexEmbeddedNative")

    Function("apiVersion") {
      Native.apiVersion()
    }

    AsyncFunction("open") { path: String, selectorKey: String, defaultIdentityKey: String ->
      val context = appContext.reactContext
        ?: throw NativeStoreException("React context is unavailable while opening storage.")
      val requested = File(path)
      val resolved = if (requested.isAbsolute) requested else File(
        File(context.filesDir, "convex-embedded"),
        path,
      )
      resolved.parentFile?.let { parent ->
        if (!parent.exists() && !parent.mkdirs()) {
          throw NativeStoreException("Could not create the native storage directory.")
        }
      }
      val handle = Native.open(
        resolved.absolutePath,
        selectorKey,
        defaultIdentityKey,
      )
      if (handle == 0L) throw NativeStoreException("Rust storage could not open the database.")
      ConvexEmbeddedNativeStore(appContext, handle)
    }

    Class("Store", ConvexEmbeddedNativeStore::class) {
      AsyncFunction("call") { store: ConvexEmbeddedNativeStore, request: ByteArray ->
        store.call(request)
      }.runOnQueue(appContext.backgroundCoroutineScope)
      Function("clockRead") { store: ConvexEmbeddedNativeStore ->
        store.clockRead()
      }
      AsyncFunction("close") { store: ConvexEmbeddedNativeStore ->
        store.close()
      }.runOnQueue(appContext.backgroundCoroutineScope)
    }
  }
}

class ConvexEmbeddedNativeStore(
  appContext: expo.modules.kotlin.AppContext,
  private var handle: Long,
) : SharedObject(appContext) {
  fun call(request: ByteArray): ByteArray {
    val current = openHandle()
    return Native.call(current, request)
  }

  fun clockRead(): Double = Native.clockRead(openHandle())

  @Synchronized
  fun close() {
    val current = handle
    if (current == 0L) return
    handle = 0
    Native.close(current)
  }

  override fun sharedObjectDidRelease() {
    close()
  }

  @Synchronized
  private fun openHandle(): Long {
    if (handle == 0L) throw NativeStoreException("Native store is closed.")
    return handle
  }
}

private class NativeStoreException(message: String) : CodedException(message)
