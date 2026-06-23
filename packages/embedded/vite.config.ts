import { defineConfig } from "vite-plus";

import tsdownConfig from "./tsdown.config.js";
import { browserRuntimeLog } from "./tests/browser/harness/log.js";
import { benchProject } from "./vite/bench.js";
import { browserProject } from "./vite/browser.js";
import { metalProject } from "./vite/metal.js";
import { remoteProject } from "./vite/remote.js";
import { runtimeProject } from "./vite/runtime.js";
import { serverProject } from "./vite/server.js";
import { storageProject } from "./vite/storage.js";
import { surfaceProject } from "./vite/surface.js";
import { unitProject } from "./vite/unit.js";
import { webkitProject } from "./vite/webkit.js";

export default defineConfig({
  pack: tsdownConfig,
  plugins: [browserRuntimeLog()],
  test: {
    projects: [
      benchProject,
      unitProject,
      runtimeProject,
      storageProject,
      serverProject,
      remoteProject,
      metalProject,
      surfaceProject,
      browserProject,
      webkitProject,
    ],
  },
});
