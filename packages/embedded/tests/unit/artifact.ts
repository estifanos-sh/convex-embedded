import { describe, expect, test } from "vite-plus/test";

import { nativePlatformUnsupported } from "../../src/node/artifact";

describe("Node native artifact platforms", () => {
  test("requires an explicitly supplied artifact on Intel macOS", () => {
    expect(nativePlatformUnsupported("darwin", "x64")).toContain("does not ship a prebuilt");
    expect(nativePlatformUnsupported("darwin", "x64")).toContain("CONVEX_EMBEDDED_NATIVE");
  });

  test("keeps package-owned artifacts on supported Node platforms", () => {
    expect(nativePlatformUnsupported("darwin", "arm64")).toBeUndefined();
    expect(nativePlatformUnsupported("linux", "x64")).toBeUndefined();
    expect(nativePlatformUnsupported("linux", "arm64")).toBeUndefined();
    expect(nativePlatformUnsupported("win32", "x64")).toBeUndefined();
  });
});
