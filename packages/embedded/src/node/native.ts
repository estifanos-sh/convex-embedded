import { StoreAdapter, type StoreBinding } from "../storage/binding";
import { normalizeStorageError } from "../error";

/**
 * Options for opening the native embedded store adapter.
 *
 * @internal
 */
export interface NativeStoreOptions {
  identityKey?: string;
  selectorKey?: string;
  defaultIdentityKey?: string;
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
    Store: { open(path: string, selectorKey?: string, defaultIdentityKey?: string): unknown },
    path: string,
    options: NativeStoreOptions = {},
  ): Promise<NativeStore> {
    const selectorKey = options.selectorKey ?? options.identityKey;
    const defaultIdentityKey = options.defaultIdentityKey ?? options.identityKey;
    try {
      return new NativeStore(
        (await Store.open(path, selectorKey, defaultIdentityKey)) as StoreBinding,
      );
    } catch (error) {
      throw normalizeStorageError(error);
    }
  }
}
