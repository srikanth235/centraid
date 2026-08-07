import { nodeProject } from "@centraid/test-kit/vitest";

// Project config for @centraid/enrichment-service. This suite MUST pass with
// no onnxruntime-node/sharp installed and no model weights on disk — that is
// the whole point of the runtime/ split (issue #724 W8). Every test in this
// package therefore exercises pure math (tokenizer BPE, CTC decode, NMS, DB
// postprocess) or route/config logic that only touches the filesystem to
// check for absence. Anything that would need a real ONNX session is left
// for the integrator to verify by hand after `bun run setup` (see README.md).
export default nodeProject({
  test: {
    name: "@centraid/enrichment-service",
    include: ["src/**/*.test.ts"],
  },
});
