export const remoteProject = {
  test: {
    environment: "node",
    fileParallelism: false,
    include: ["tests/remote/**/*.ts"],
    name: "remote",
    testTimeout: 70_000,
  },
};
