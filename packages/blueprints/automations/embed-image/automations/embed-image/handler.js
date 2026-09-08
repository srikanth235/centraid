// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as i } from "node:fs";
import V from "node:path";
import Z from "node:path";
var m = Z.resolve(import.meta.dirname, ".."),
  x = "__centraidAutomationRuntimeDir";
function g() {
  let $ = globalThis[x];
  if (typeof $ === "string" && $.length > 0) return Z.resolve($);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return Z.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return Z.join(m, "runtime");
}
var C = g(),
  F = Z.join(C, "models");
import { existsSync as L, readFileSync as c, statSync as p } from "node:fs";
import U from "node:path";
import { pathToFileURL as l } from "node:url";
var H;
class _ extends Error {
  constructor($, q) {
    super(
      `Automation model runtime dependency "${$}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: q }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function f($, q = C) {
  let Q = U.join(q, "node_modules");
  if (!L(Q)) throw new _($);
  let B = U.join(Q, ...$.split("/"));
  try {
    let Y = R(B);
    if (Y === null) throw Error(`no entry point in ${B}`);
    return Y;
  } catch (Y) {
    throw new _($, Y);
  }
}
function R($, q = 0) {
  let Q = U.join($, "package.json"),
    B = L(Q) ? JSON.parse(c(Q, "utf8")) : {},
    Y = [
      ...O(h(B.exports)),
      ...(typeof B.main === "string" ? [B.main] : []),
      "index.js",
    ];
  for (let J of Y) {
    let W = s(U.resolve($, J), q);
    if (W !== null) return W;
  }
  return null;
}
function s($, q) {
  let Q = k($);
  if (Q?.isFile()) return $;
  if (Q?.isDirectory()) return q >= 4 ? null : R($, q + 1);
  for (let B of [".js", ".json", ".node"]) {
    let Y = `${$}${B}`;
    if (k(Y)?.isFile()) return Y;
  }
  return null;
}
function k($) {
  try {
    return p($);
  } catch {
    return null;
  }
}
function h($) {
  if (typeof $ === "string") return $;
  if ($ === null || typeof $ !== "object") return;
  let q = $;
  return "." in q ? q["."] : q;
}
function O($, q = 0) {
  if (typeof $ === "string") return [$];
  if (q > 8 || $ === null || typeof $ !== "object") return [];
  if (Array.isArray($)) return $.flatMap((Y) => O(Y, q + 1));
  let Q = $,
    B = [];
  for (let Y of ["require", "node", "default"])
    if (Y in Q) B.push(...O(Q[Y], q + 1));
  return B;
}
async function N() {
  if (H) return H;
  let $ = f("onnxruntime-node");
  return ((H = await import(l($).href)), H);
}
var w;
async function y($) {
  w ??= new Map();
  let q = w.get($);
  if (q) return q;
  if (!L($)) throw new _($);
  let Q = N().then((B) => B.InferenceSession.create($));
  w.set($, Q);
  try {
    return await Q;
  } catch (B) {
    throw (w.delete($), B);
  }
}
import { pathToFileURL as d } from "node:url";
var A;
async function n() {
  if (A) return A;
  let $ = f("sharp");
  return ((A = (await import(d($).href)).default), A);
}
async function T($, q) {
  let B = (await n())(Buffer.from($)),
    { data: Y, info: J } = await B.resize({
      width: q,
      height: q,
      fit: "cover",
      position: "centre",
    })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(Y.buffer, Y.byteOffset, Y.byteLength),
    width: J.width,
    height: J.height,
  };
}
var o = [0.48145466, 0.4578275, 0.40821073],
  r = [0.26862954, 0.26130258, 0.27577711];
function I($) {
  let { width: q, height: Q, data: B } = $,
    Y = q * Q,
    J = new Float32Array(Y * 3);
  for (let W = 0; W < Y; W++)
    for (let K = 0; K < 3; K++) {
      let X = (B[W * 3 + K] ?? 0) / 255;
      J[K * Y + W] = (X - o[K]) / r[K];
    }
  return J;
}
var E = "clip-vit-b-32@1",
  M = V.join(F, "clip"),
  a = V.join(M, "visual.onnx"),
  O0 = V.join(M, "textual.onnx"),
  L0 = V.join(M, "vocab.json"),
  f0 = V.join(M, "merges.txt"),
  z = 224;
function D($ = F) {
  let q = V.join($, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (Q) => i(V.join(q, Q))
  );
}
function t($) {
  let q = 0;
  for (let B of $) q += B * B;
  let Q = Math.sqrt(q);
  if (Q === 0) return Array.from($);
  return Array.from($, (B) => B / Q);
}
function e($, q) {
  let Q = q[0],
    B = Q ? $[Q] : void 0;
  if (!B || !(B.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return B.data;
}
async function P($) {
  try {
    let q = Buffer.from($.bytes, "base64"),
      Q = await T(q, z),
      B = I(Q),
      Y = await N(),
      J = await y(a),
      K = {
        [J.inputNames[0] ?? "pixel_values"]: new Y.Tensor("float32", B, [
          1,
          3,
          z,
          z,
        ]),
      },
      X = await J.run(K),
      v = t(e(X, J.outputNames));
    return { id: $.id, vector: v };
  } catch (q) {
    return { id: $.id, error: q instanceof Error ? q.message : String(q) };
  }
}
var u = 16,
  b = P,
  S = D;
function D0($) {
  ((b = $?.infer ?? P), (S = $?.weightsPresent ?? D));
}
function $0() {
  return S() ? E : null;
}
async function q0($, q) {
  let B = (
    await $.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
    })
  ).rows?.[0];
  if (!B) return "";
  return (
    await $.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: B.asset_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
    })
  ).rows?.[0]?.model === q
    ? B.asset_id
    : "";
}
async function B0({ ctx: $, log: q }) {
  let Q = $0();
  if (!Q)
    return { summary: "image embedding skipped — model assets unavailable" };
  let B = await $.state.get("model");
  if (B !== Q)
    (await $.state.set("cursor", B === void 0 ? await q0($, Q) : ""),
      await $.state.set("model", Q));
  let Y = (await $.state.get("cursor")) ?? "",
    J = await $.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: Y },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: u,
    }),
    W = 0,
    K = 0;
  for (let v of J.rows ?? []) {
    if (v.kind !== "photo" && v.kind !== "scan") {
      K += 1;
      continue;
    }
    if (
      (
        await $.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: v.asset_id },
            { column: "variant", op: "eq", value: "embedding" },
          ],
          limit: 1,
        })
      ).rows?.[0]?.model === Q
    ) {
      K += 1;
      continue;
    }
    let j = await $.vault.content({
      contentId: v.content_id,
      variant: "preview",
      maxBytes: 4194304,
    });
    if (j?.status !== "ok" || j.kind !== "bytes")
      throw Error(`asset ${v.asset_id}: preview is unavailable`);
    let G = await b({
      id: v.asset_id,
      mediaType: j.mediaType,
      bytes: j.base64,
    });
    if (!G || G.error || !Array.isArray(G.vector)) {
      ((K += 1), q.info(`asset ${v.asset_id}: no image vector`));
      continue;
    }
    (await $.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "media.asset",
        entity_id: v.asset_id,
        model: Q,
        vector: G.vector,
        capability: "embed-image",
      },
    }),
      (W += 1));
  }
  let X = J.rows?.at(-1)?.asset_id;
  if (X) await $.state.set("cursor", X);
  return {
    summary: `embedded ${W} images; skipped ${K}; bounded batch ${J.rows?.length ?? 0}/${u}`,
    output: {
      derived: W,
      skipped: K,
      model: Q,
      rearm: (J.rows?.length ?? 0) === u,
    },
  };
}
export { D0 as setEmbedImageRuntimeForTests, B0 as default };
