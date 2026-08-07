import { describe, expect, it } from "vitest";

import { resolveRuntimeModule, RuntimeNotInstalledError } from "./onnx.js";

// This suite intentionally runs WITHOUT `bun run setup` ever having
// executed (issue #724 W8's core acceptance criterion), so
// runtime/node_modules genuinely does not exist here — exercising exactly
// the "run setup first" failure path a fresh clone hits.

describe(resolveRuntimeModule, () => {
  it("throws a RuntimeNotInstalledError with a clear 'run setup first' message when runtime/ has no node_modules", () => {
    expect(() => resolveRuntimeModule("onnxruntime-node")).toThrow(
      RuntimeNotInstalledError
    );
    expect(() => resolveRuntimeModule("onnxruntime-node")).toThrow(
      /run.*setup/iu
    );
  });
});
