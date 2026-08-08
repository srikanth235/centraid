import { defineConfig } from "vitest/config";

/** Fast, fixture-free mutation root for tokenizer, CTC decoding, and NMS laws. */
export default defineConfig({
  test: {
    name: "@centraid/enrichment-service-mutation",
    environment: "node",
    pool: "forks",
    include: ["src/tokenizer.test.ts", "src/ctc.test.ts", "src/nms.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
