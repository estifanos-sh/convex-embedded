import { describe, expect, test } from "vite-plus/test";

import { ConvexEmbeddedClient } from "../../src/browser/client";
import { EmbeddedClient } from "../../src/client";

describe("v5 browser surface", () => {
  test("exports the platform client without legacy write surfaces", () => {
    expect(typeof ConvexEmbeddedClient).toBe("function");
    expect("doc" in EmbeddedClient.prototype).toBe(false);
    expect("rev" in EmbeddedClient.prototype).toBe(false);
    expect("sync" in EmbeddedClient.prototype).toBe(false);
    expect(typeof EmbeddedClient.prototype.setAuth).toBe("function");
    expect(typeof EmbeddedClient.prototype.clearAuth).toBe("function");
    expect(typeof EmbeddedClient.prototype.connectionState).toBe("function");
  });
});
