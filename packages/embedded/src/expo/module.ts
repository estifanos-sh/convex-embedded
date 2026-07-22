const EXPO_NATIVE_API_VERSION = 2;

/** Native Expo SharedObject contract. @internal */
export interface NativeStoreObject {
  call(request: Uint8Array): Promise<Uint8Array>;
  clockRead(): number;
  close(): Promise<void>;
  release(): void;
}

/** Autolinked Expo module contract. @internal */
export interface NativeModule {
  apiVersion(): number;
  open(path: string, selectorKey: string, defaultIdentityKey: string): Promise<NativeStoreObject>;
}

/** Create a lazy, ABI-checking native-module loader. @internal */
export function createNativeModuleLoader(resolve: () => NativeModule | null): () => NativeModule {
  let loaded: NativeModule | undefined;
  return () => {
    if (loaded) return loaded;
    const native = resolve();
    if (!native) {
      throw new Error(
        [
          "Convex Embedded native storage is not linked into this application.",
          "Expo Go cannot load custom native modules; use an Expo development build or a release build.",
          "After installing @convex-dev/embedded, rebuild the native application so Expo autolinking can include it.",
        ].join(" "),
      );
    }
    const version = native.apiVersion();
    if (version !== EXPO_NATIVE_API_VERSION) {
      throw new Error(
        `Convex Embedded native API version ${String(version)} does not match JavaScript version ${String(EXPO_NATIVE_API_VERSION)}. Rebuild the native application.`,
      );
    }
    loaded = native;
    return native;
  };
}
