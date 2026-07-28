import { StoreAdapter, type StoreBinding } from "../storage/binding";

/**
 * Options for opening the browser embedded store adapter.
 *
 * @internal
 */
export interface WasmStoreOptions {
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
   * Opens a browser store using the loaded napi-rs WASM `Store` export.
   *
   * @internal
   */
  static async openWith(
    Store: { open(name: string, selectorKey?: string, defaultIdentityKey?: string): unknown },
    name: string,
    options: WasmStoreOptions = {},
  ): Promise<WasmStore> {
    return new WasmStore(
      (await Store.open(name, options.selectorKey, options.defaultIdentityKey)) as StoreBinding,
    );
  }
}
