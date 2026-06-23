export const runtimeProject = {
  test: {
    environment: "node",
    include: ["tests/runtime/**/*.ts"],
    name: "runtime",
    testTimeout: 15_000,
  },
};
