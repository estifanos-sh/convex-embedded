import ExpoModulesCore
import Dispatch
import Foundation
import ConvexEmbeddedMobile

public final class ConvexEmbeddedNativeModule: Module {
  // `remoteNext` intentionally blocks until the Rust actor commits work or closes. Expo's default
  // AsyncFunction queue is serial, so every store call must use a concurrent queue or that wait
  // would prevent identity, pull, auth, and close calls from ever reaching Rust.
  private static let storeQueue = DispatchQueue(
    label: "dev.convex.embedded.store",
    qos: .userInitiated,
    attributes: .concurrent
  )

  public func definition() -> ModuleDefinition {
    Name("ConvexEmbeddedNative")

    Function("bridgeContractId") {
      String(cString: cem_bridge_contract_id())
    }

    Function("wireContractId") {
      String(cString: cem_wire_contract_id())
    }

    Function("storageBindingContractId") {
      String(cString: cem_storage_binding_contract_id())
    }

    AsyncFunction("open") { (path: String, selectorKey: String, defaultIdentityKey: String) in
      let resolved = try Self.resolve(path)
      var error = CemBuffer(ptr: nil, len: 0, capacity: 0)
      let handle = resolved.withCString { pathPointer in
        selectorKey.withCString { selectorPointer in
          defaultIdentityKey.withCString { identityPointer in
            cem_open_path(pathPointer, selectorPointer, identityPointer, &error)
          }
        }
      }
      guard handle != 0 else {
        throw NativeStoreException(Self.consume(
          &error,
          fallback: "Rust storage rejected the database path or could not open it."
        ))
      }
      cem_buffer_free(error)
      return ConvexEmbeddedNativeStore(handle: handle)
    }

    Class("Store", ConvexEmbeddedNativeStore.self) {
      AsyncFunction("call") { (store: ConvexEmbeddedNativeStore, request: Data) in
        try store.call(request)
      }.runOnQueue(Self.storeQueue)
      Function("clockRead") { (store: ConvexEmbeddedNativeStore) in
        try store.clockRead()
      }
      AsyncFunction("close") { (store: ConvexEmbeddedNativeStore) in
        try store.close()
      }.runOnQueue(Self.storeQueue)
    }
  }

  private static func resolve(_ input: String) throws -> String {
    let url: URL
    if input.hasPrefix("/") {
      url = URL(fileURLWithPath: input)
    } else {
      let root = try FileManager.default.url(
        for: .applicationSupportDirectory,
        in: .userDomainMask,
        appropriateFor: nil,
        create: true
      )
      url = root.appendingPathComponent("ConvexEmbedded", isDirectory: true)
        .appendingPathComponent(input, isDirectory: false)
    }
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    return url.path
  }

  fileprivate static func consume(_ buffer: inout CemBuffer, fallback: String) -> String {
    defer {
      cem_buffer_free(buffer)
      buffer = CemBuffer(ptr: nil, len: 0, capacity: 0)
    }
    guard buffer.len > 0, let pointer = buffer.ptr else { return fallback }
    return String(decoding: UnsafeBufferPointer(start: pointer, count: Int(buffer.len)), as: UTF8.self)
  }
}

public final class ConvexEmbeddedNativeStore: SharedObject {
  private let lock = NSLock()
  private var handle: UInt64?

  init(handle: UInt64) {
    self.handle = handle
    super.init()
  }

  func call(_ request: Data) throws -> Data {
    let handle = try openHandle()
    let buffer = request.withUnsafeBytes { raw in
      cem_request(handle, raw.bindMemory(to: UInt8.self).baseAddress, UInt(raw.count))
    }
    defer { cem_buffer_free(buffer) }
    guard buffer.len == 0 || buffer.ptr != nil else {
      throw NativeStoreException("Rust storage returned an invalid response buffer.")
    }
    guard buffer.len > 0, let pointer = buffer.ptr else { return Data() }
    return Data(bytes: pointer, count: Int(buffer.len))
  }

  func clockRead() throws -> Double {
    var error = CemBuffer(ptr: nil, len: 0, capacity: 0)
    let value = cem_clock_read_value(try openHandle(), &error)
    guard value.isFinite else {
      throw NativeStoreException(ConvexEmbeddedNativeModule.consume(
        &error,
        fallback: "Rust storage clock is unavailable."
      ))
    }
    cem_buffer_free(error)
    return value
  }

  func close() throws {
    lock.lock()
    let current = handle
    handle = nil
    lock.unlock()
    guard let current else { return }
    var error = cem_close(current)
    guard error.len == 0 else {
      throw NativeStoreException(ConvexEmbeddedNativeModule.consume(
        &error,
        fallback: "Rust storage could not close the database."
      ))
    }
    cem_buffer_free(error)
  }

  public override func sharedObjectDidRelease() {
    try? close()
  }

  private func openHandle() throws -> UInt64 {
    lock.lock()
    defer { lock.unlock() }
    guard let handle else { throw NativeStoreException("Native store is closed.") }
    return handle
  }
}

private final class NativeStoreException: GenericException<String> {
  override var reason: String { param }
}
