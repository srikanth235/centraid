import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/model-runtime-mutation",
    environment: "node",
    pool: "forks",
    include: ["src/tokenizer.test.ts", "src/ctc.test.ts", "src/nms.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
