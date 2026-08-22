// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as r } from "node:fs";
import v from "node:path";
import G from "node:path";
var m = G.resolve(import.meta.dirname, ".."),
  C = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? G.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : G.join(m, "runtime"),
  O = G.join(C, "models");
import { existsSync as P, readFileSync as g, statSync as p } from "node:fs";
import w from "node:path";
import { pathToFileURL as c } from "node:url";
var U;
class M extends Error {
  constructor($, B) {
    super(
      `Automation model runtime dependency "${$}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: B }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function D($, B = C) {
  let Q = w.join(B, "node_modules");
  if (!P(Q)) throw new M($);
  let q = w.join(Q, ...$.split("/"));
  try {
    let Y = T(q);
    if (Y === null) throw Error(`no entry point in ${q}`);
    return Y;
  } catch (Y) {
    throw new M($, Y);
  }
}
function T($, B = 0) {
  let Q = w.join($, "package.json"),
    q = P(Q) ? JSON.parse(g(Q, "utf8")) : {},
    Y = [
      ...L(h(q.exports)),
      ...(typeof q.main === "string" ? [q.main] : []),
      "index.js",
    ];
  for (let J of Y) {
    let W = l(w.resolve($, J), B);
    if (W !== null) return W;
  }
  return null;
}
function l($, B) {
  let Q = u($);
  if (Q?.isFile()) return $;
  if (Q?.isDirectory()) return B >= 4 ? null : T($, B + 1);
  for (let q of [".js", ".json", ".node"]) {
    let Y = `${$}${q}`;
    if (u(Y)?.isFile()) return Y;
  }
  return null;
}
function u($) {
  try {
    return p($);
  } catch {
    return null;
  }
}
function h($) {
  if (typeof $ === "string") return $;
  if ($ === null || typeof $ !== "object") return;
  let B = $;
  return "." in B ? B["."] : B;
}
function L($, B = 0) {
  if (typeof $ === "string") return [$];
  if (B > 8 || $ === null || typeof $ !== "object") return [];
  if (Array.isArray($)) return $.flatMap((Y) => L(Y, B + 1));
  let Q = $,
    q = [];
  for (let Y of ["require", "node", "default"])
    if (Y in Q) q.push(...L(Q[Y], B + 1));
  return q;
}
async function N() {
  if (U) return U;
  let $ = D("onnxruntime-node");
  return ((U = await import(c($).href)), U);
}
var _;
async function y($) {
  _ ??= new Map();
  let B = _.get($);
  if (B) return B;
  if (!P($)) throw new M($);
  let Q = N().then((q) => q.InferenceSession.create($));
  _.set($, Q);
  try {
    return await Q;
  } catch (q) {
    throw (_.delete($), q);
  }
}
import { pathToFileURL as s } from "node:url";
var A;
async function d() {
  if (A) return A;
  let $ = D("sharp");
  return ((A = (await import(s($).href)).default), A);
}
async function I($, B) {
  let q = (await d())(Buffer.from($)),
    { data: Y, info: J } = await q
      .resize({ width: B, height: B, fit: "cover", position: "centre" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(Y.buffer, Y.byteOffset, Y.byteLength),
    width: J.width,
    height: J.height,
  };
}
var n = [0.48145466, 0.4578275, 0.40821073],
  o = [0.26862954, 0.26130258, 0.27577711];
function E($) {
  let { width: B, height: Q, data: q } = $,
    Y = B * Q,
    J = new Float32Array(Y * 3);
  for (let W = 0; W < Y; W++)
    for (let K = 0; K < 3; K++) {
      let X = (q[W * 3 + K] ?? 0) / 255;
      J[K * Y + W] = (X - n[K]) / o[K];
    }
  return J;
}
var S = "clip-vit-b-32@1",
  F = v.join(O, "clip"),
  i = v.join(F, "visual.onnx"),
  C0 = v.join(F, "textual.onnx"),
  O0 = v.join(F, "vocab.json"),
  L0 = v.join(F, "merges.txt"),
  z = 224;
function R($ = O) {
  let B = v.join($, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (Q) => r(v.join(B, Q))
  );
}
function a($) {
  let B = 0;
  for (let q of $) B += q * q;
  let Q = Math.sqrt(B);
  if (Q === 0) return Array.from($);
  return Array.from($, (q) => q / Q);
}
function t($, B) {
  let Q = B[0],
    q = Q ? $[Q] : void 0;
  if (!q || !(q.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return q.data;
}
async function f($) {
  try {
    let B = Buffer.from($.bytes, "base64"),
      Q = await I(B, z),
      q = E(Q),
      Y = await N(),
      J = await y(i),
      K = {
        [J.inputNames[0] ?? "pixel_values"]: new Y.Tensor("float32", q, [
          1,
          3,
          z,
          z,
        ]),
      },
      X = await J.run(K),
      V = a(t(X, J.outputNames));
    return { id: $.id, vector: V };
  } catch (B) {
    return { id: $.id, error: B instanceof Error ? B.message : String(B) };
  }
}
var k = 16,
  Z = "dpv:ServiceProvision",
  b = f,
  x = R;
function N0($) {
  ((b = $?.infer ?? f), (x = $?.weightsPresent ?? R));
}
function e() {
  return x() ? S : null;
}
async function $0($, B) {
  let q = (
    await $.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: Z,
    })
  ).rows?.[0];
  if (!q) return "";
  return (
    await $.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: q.asset_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: Z,
    })
  ).rows?.[0]?.model === B
    ? q.asset_id
    : "";
}
async function B0({ ctx: $, log: B }) {
  let Q = e();
  if (!Q)
    return { summary: "image embedding skipped — model assets unavailable" };
  let q = await $.state.get("model");
  if (q !== Q)
    (await $.state.set("cursor", q === void 0 ? await $0($, Q) : ""),
      await $.state.set("model", Q));
  let Y = (await $.state.get("cursor")) ?? "",
    J = await $.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: Y },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: k,
      purpose: Z,
    }),
    W = 0,
    K = 0;
  for (let V of J.rows ?? []) {
    if (V.kind !== "photo" && V.kind !== "scan") {
      K += 1;
      continue;
    }
    if (
      (
        await $.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: V.asset_id },
            { column: "variant", op: "eq", value: "embedding" },
          ],
          limit: 1,
          purpose: Z,
        })
      ).rows?.[0]?.model === Q
    ) {
      K += 1;
      continue;
    }
    let j = await $.vault.content({
      contentId: V.content_id,
      variant: "preview",
      maxBytes: 4194304,
      purpose: Z,
    });
    if (j?.status !== "ok" || j.kind !== "bytes")
      throw Error(`asset ${V.asset_id}: preview is unavailable`);
    let H = await b({
      id: V.asset_id,
      mediaType: j.mediaType,
      bytes: j.base64,
    });
    if (!H || H.error || !Array.isArray(H.vector)) {
      ((K += 1), B.info(`asset ${V.asset_id}: no image vector`));
      continue;
    }
    (await $.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "media.asset",
        entity_id: V.asset_id,
        model: Q,
        vector: H.vector,
        capability: "embed-image",
      },
      purpose: Z,
    }),
      (W += 1));
  }
  let X = J.rows?.at(-1)?.asset_id;
  if (X) await $.state.set("cursor", X);
  return {
    summary: `embedded ${W} images; skipped ${K}; bounded batch ${J.rows?.length ?? 0}/${k}`,
    output: {
      derived: W,
      skipped: K,
      model: Q,
      rearm: (J.rows?.length ?? 0) === k,
    },
  };
}
export { N0 as setEmbedImageRuntimeForTests, B0 as default };
