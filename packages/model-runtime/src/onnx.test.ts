import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveRuntimeModule, RuntimeNotInstalledError } from "./onnx.js";

const absentRuntime = path.join(
  import.meta.dirname,
  "fixtures",
  "absent-runtime"
);

describe(resolveRuntimeModule, () => {
  it("throws a RuntimeNotInstalledError with a clear 'run setup first' message when runtime/ has no node_modules", () => {
    expect(() =>
      resolveRuntimeModule("onnxruntime-node", absentRuntime)
    ).toThrow(RuntimeNotInstalledError);
    expect(() =>
      resolveRuntimeModule("onnxruntime-node", absentRuntime)
    ).toThrow(/run.*setup/iu);
  });
});
