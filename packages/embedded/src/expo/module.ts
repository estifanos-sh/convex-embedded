import { CURRENT_MOBILE_BRIDGE_CONTRACT_ID, CURRENT_WIRE_CONTRACT_ID } from "./contract";
import { CURRENT_STORAGE_BINDING_CONTRACT_ID } from "../storage/contract";

/** Native Expo SharedObject contract. @internal */
export interface NativeStoreObject {
  call(request: Uint8Array): Promise<Uint8Array>;
  clockRead(): number;
  close(): Promise<void>;
  release(): void;
}

/** Autolinked Expo module contract. @internal */
export interface NativeModule {
  bridgeContractId(): string;
  storageBindingContractId(): string;
  wireContractId(): string;
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
          "After installing @estifanos-sh/convex-embedded, rebuild the native application so Expo autolinking can include it.",
        ].join(" "),
      );
    }
    const bridgeContractId = readContractId(native, "bridgeContractId");
    if (bridgeContractId !== CURRENT_MOBILE_BRIDGE_CONTRACT_ID) {
      throw new Error(
        "Convex Embedded native bridge does not match this JavaScript package. Rebuild the native application.",
      );
    }
    const wireContractId = readContractId(native, "wireContractId");
    if (wireContractId !== CURRENT_WIRE_CONTRACT_ID) {
      throw new Error(
        "Convex Embedded native runtime does not match this JavaScript package. Rebuild the native application.",
      );
    }
    const storageBindingContractId = readContractId(native, "storageBindingContractId");
    if (storageBindingContractId !== CURRENT_STORAGE_BINDING_CONTRACT_ID) {
      throw new Error(
        "Convex Embedded native storage does not match this JavaScript package. Rebuild the native application.",
      );
    }
    if (typeof native.open !== "function") {
      throw new Error(
        "Convex Embedded native module is missing open(). Rebuild the native application after installing this package.",
      );
    }
    loaded = native;
    return native;
  };
}

function readContractId(
  native: NativeModule,
  name: "bridgeContractId" | "storageBindingContractId" | "wireContractId",
): string {
  const read = native[name];
  if (typeof read !== "function") {
    throw new Error(
      `Convex Embedded native module is missing ${name}(). Rebuild the native application after installing this package.`,
    );
  }
  const value = read.call(native);
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(
      `Convex Embedded native module returned an invalid ${name}(). Rebuild the native application after installing this package.`,
    );
  }
  return value;
}
