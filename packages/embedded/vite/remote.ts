export const remoteProject = {
  test: {
    environment: "node",
    fileParallelism: false,
    globalSetup: ["tests/testkit/remote.ts"],
    include: ["tests/remote/**/*.ts"],
    name: "remote",
    testTimeout: 70_000,
  },
};
