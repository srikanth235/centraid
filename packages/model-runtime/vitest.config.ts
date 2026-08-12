import { nodeProject } from "@centraid/test-kit/vitest";

// Default project: hermetic and weight-free. Real ONNX sessions belong to the
// separately invoked weekly/manual vitest.live.config.ts lane.
export default nodeProject({
  test: {
    name: "@centraid/model-runtime",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.live.test.ts"],
  },
});
