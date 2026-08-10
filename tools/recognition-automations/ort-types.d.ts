// Minimal ambient declaration for the onnxruntime-node API surface this
// service actually calls (session creation, tensor construction, run, and
// the input/output name introspection used to build feeds generically).
//
// WHY a hand-rolled subset instead of onnxruntime-node's own types: that
// package is deliberately NOT a dependency of this workspace package (see
// runtime/package.json + src/onnx.ts) — it lives only in
// tools/recognition-automations/runtime/node_modules, installed by `bun run
// setup`, and is loaded there via a runtime `import()` resolved with
// `createRequire`. TypeScript has no way to see that installation from this
// package's own module graph, so `tsc -p tsconfig.json` (run WITHOUT setup
// ever having executed) would fail to resolve `"onnxruntime-node"` at all.
// This file declares the module ambiently so the calling code in
// src/onnx.ts and src/capabilities/*.ts typechecks against the exact shape
// we use, without requiring the real package — or its own @types — to be
// resolvable from here. It is intentionally NOT a full port of
// onnxruntime-node's .d.ts: extend it only when a new capability needs a
// field this subset doesn't cover yet.
/* eslint-disable max-classes-per-file -- #724: Tensor + InferenceSession are the two classes onnxruntime-node's real API actually exports; this ambient module mirrors that shape 1:1, so splitting them into two files would just fragment one module declaration for no reason. */
declare module "onnxruntime-node" {
  export type TypedTensorData =
    | Float32Array
    | Float64Array
    | Int32Array
    | BigInt64Array
    | Uint8Array
    | Int8Array
    | Uint8ClampedArray
    | string[];

  /** Tensor element type tags accepted by the Tensor constructor. */
  export type TensorType =
    | "float32"
    | "float64"
    | "int32"
    | "int64"
    | "uint8"
    | "int8"
    | "bool"
    | "string";

  export class Tensor {
    constructor(
      type: TensorType,
      data: TypedTensorData,
      dims: readonly number[]
    );
    readonly type: TensorType;
    readonly dims: readonly number[];
    readonly data: TypedTensorData;
  }

  export type OnnxValue = Tensor;
  export type OnnxValueMap = Record<string, OnnxValue>;

  export interface InferenceSessionOptions {
    executionProviders?: readonly string[];
    graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
    intraOpNumThreads?: number;
  }

  export class InferenceSession {
    static create(
      path: string,
      options?: InferenceSessionOptions
    ): Promise<InferenceSession>;
    run(feeds: OnnxValueMap): Promise<OnnxValueMap>;
    readonly inputNames: readonly string[];
    readonly outputNames: readonly string[];
    release(): Promise<void>;
  }
}
