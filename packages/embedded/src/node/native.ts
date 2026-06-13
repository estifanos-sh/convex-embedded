import { StoreAdapter, type StoreBinding } from "../storage/binding";

/**
 * Options for opening the native embedded store adapter.
 *
 * @internal
 */
export interface NativeStoreOptions {
  identityKey?: string;
}

/**
 * JavaScript adapter around the raw NAPI storage binding.
 *
 * @internal
 */
export class NativeStore extends StoreAdapter {
  private constructor(inner: StoreBinding) {
    super(inner);
  }

  /**
   * Wraps a raw NAPI store binding.
   *
   * @internal
   */
  static wrap(inner: unknown): NativeStore {
    return new NativeStore(inner as StoreBinding);
  }

  /**
   * Opens a native store using the loaded NAPI `Store` export.
   *
   * @internal
   */
  static async openWith(
    Store: { open(path: string, identityKey?: string): unknown },
    path: string,
    options: NativeStoreOptions = {},
  ): Promise<NativeStore> {
    return new NativeStore((await Store.open(path, options.identityKey)) as StoreBinding);
  }
}
