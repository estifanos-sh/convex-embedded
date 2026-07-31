import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      ".agents/**",
      ".claude/**",
      "convex/_generated/**",
      "convex/embedded.generated.ts",
      "vendor/**",
    ],
  },
  lint: {
    ignorePatterns: [
      ".agents/**",
      ".claude/**",
      "convex/_generated/**",
      "convex/embedded.generated.ts",
      "vendor/**",
    ],
    options: { typeAware: true, typeCheck: true },
  },
  staged: {
    "*": "vp check --fix",
  },
  test: {
    fileParallelism: false,
    include: [
      "packages/embedded/tests/unit/**/*.ts",
      "packages/embedded/tests/storage/**/*.ts",
      "packages/embedded/tests/runtime/**/*.ts",
      "packages/embedded/tests/server/**/*.ts",
      "packages/embedded/tests/surface/**/*.ts",
    ],
  },
});
