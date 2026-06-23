import { StoreAdapter, type StoreBinding } from "../storage/binding";

/**
 * Options for opening the browser embedded store adapter.
 *
 * @internal
 */
export interface WasmStoreOptions {
  identityKey?: string;
  selectorKey?: string;
  defaultIdentityKey?: string;
}

/**
 * JavaScript adapter around the raw napi-rs WASM storage binding.
 *
 * @internal
 */
export class WasmStore extends StoreAdapter {
  private constructor(inner: StoreBinding) {
    super(inner);
  }

  /**
   * Wraps a raw napi-rs WASM store binding.
   *
   * @internal
   */
  static wrap(inner: unknown): WasmStore {
    return new WasmStore(inner as StoreBinding);
  }

  /**
   * Opens a browser store using the loaded napi-rs WASM `Store` export.
   *
   * @internal
   */
  static async openWith(
    Store: { open(name: string, selectorKey?: string, defaultIdentityKey?: string): unknown },
    name: string,
    options: WasmStoreOptions = {},
  ): Promise<WasmStore> {
    const selectorKey = options.selectorKey ?? options.identityKey;
    const defaultIdentityKey = options.defaultIdentityKey ?? options.identityKey;
    return new WasmStore((await Store.open(name, selectorKey, defaultIdentityKey)) as StoreBinding);
  }
}
