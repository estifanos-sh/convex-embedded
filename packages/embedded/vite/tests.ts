import { defineConfig } from "vite-plus";

import { browserRuntimeLog } from "../tests/browser/harness/log.js";
import { benchProject } from "./bench.js";
import { browserProject } from "./browser.js";
import { metalProject } from "./metal.js";
import { remoteProject } from "./remote.js";
import { runtimeProject } from "./runtime.js";
import { serverProject } from "./server.js";
import { storageProject } from "./storage.js";
import { surfaceProject } from "./surface.js";
import { unitProject } from "./unit.js";
import { webkitProject } from "./webkit.js";

export default defineConfig({
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
