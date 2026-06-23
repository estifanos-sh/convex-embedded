import { loadNativeModule, type NativeModule } from "../../src/node/artifact";

let cached: NativeModule | undefined;

export function nativeModule(): NativeModule {
  if (!cached) {
    const previous = process.env.CONVEX_EMBEDDED_DEV_NATIVE;
    process.env.CONVEX_EMBEDDED_DEV_NATIVE = "1";
    try {
      cached = loadNativeModule();
    } finally {
      if (previous === undefined) delete process.env.CONVEX_EMBEDDED_DEV_NATIVE;
      else process.env.CONVEX_EMBEDDED_DEV_NATIVE = previous;
    }
  }
  return cached;
}
