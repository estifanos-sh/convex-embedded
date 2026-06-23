export const storageProject = {
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/storage/**/*.ts"],
    name: "storage",
    testTimeout: 15_000,
  },
};
