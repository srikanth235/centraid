import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/release/**/*.test.mjs"],
    exclude: ["scripts/release/surfaces.test.mjs"],
    environment: "node",
  },
});
