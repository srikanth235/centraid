import { nodeProject } from "@centraid/test-kit/vitest";

export default nodeProject({
  test: {
    name: "@centraid/model-runtime",
    include: ["src/**/*.test.ts", "automation-handlers/**/*.test.ts"],
    exclude: ["src/**/*.live.test.ts"],
  },
});
