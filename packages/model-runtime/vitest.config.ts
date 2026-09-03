import { nodeProject } from "@centraid/test-kit/vitest";

// Default project: hermetic and weight-free. Real ONNX sessions belong to the
// separately invoked weekly/manual vitest.live.config.ts lane.
export default nodeProject({
  test: {
    name: "@centraid/model-runtime",
    // `automation-handlers/**` is hand-authored production source, not build
    // output: it is the source of the published recognition bundles, so it is
    // tested and floored here (#781).
    include: ["src/**/*.test.ts", "automation-handlers/**/*.test.ts"],
    exclude: ["src/**/*.live.test.ts"],
  },
});
