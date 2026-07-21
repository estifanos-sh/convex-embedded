import { requireOptionalNativeModule } from "expo";

import { createNativeModuleLoader, type NativeModule } from "./module";

/** Resolve and validate the autolinked Expo module. @internal */
export const loadNativeModule = createNativeModuleLoader(() =>
  requireOptionalNativeModule<NativeModule>("ConvexEmbeddedNative"),
);
