export const benchProject = {
  test: {
    environment: "node",
    include: ["tests/bench/runtime.ts", "tests/bench/scale.ts"],
    name: "bench",
  },
};
