import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "design",
    include: ["src/**/*.test.ts"],
    // The token layer's tests run on node; the element suites opt into jsdom
    // per file (`@vitest-environment jsdom`).
    environment: "node",
    pool: "forks",
    // Zero-assertion tests fail (#496). A legitimately assertion-free test
    // must call `expect.assertions(0)`.
    expect: { requireAssertions: true },
  },
});
