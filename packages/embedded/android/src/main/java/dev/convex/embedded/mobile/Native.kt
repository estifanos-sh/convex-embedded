package dev.convex.embedded.mobile

object Native {
  init {
    System.loadLibrary("convex_embedded_mobile")
  }

  external fun bridgeContractId(): String
  external fun wireContractId(): String
  external fun storageBindingContractId(): String
  external fun open(path: String, selectorKey: String, defaultIdentityKey: String): Long
  external fun call(handle: Long, request: ByteArray): ByteArray
  external fun clockRead(handle: Long): Double
  external fun close(handle: Long)
}
