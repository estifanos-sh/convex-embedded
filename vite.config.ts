import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [".agents/**", ".claude/**", "convex/_generated/**"],
  },
  lint: {
    ignorePatterns: [".agents/**", ".claude/**", "convex/_generated/**"],
    options: { typeAware: true, typeCheck: true },
  },
  staged: {
    "*": "vp check --fix",
  },
  test: {
    exclude: [
      "packages/embedded/tests/browser/**/*.ts",
      "packages/embedded/tests/node/conformance.ts",
      "packages/embedded/tests/node/native.ts",
    ],
    include: ["packages/embedded/tests/node/**/*.ts"],
  },
});
