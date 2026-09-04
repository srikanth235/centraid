// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as a } from "node:fs";
import V from "node:path";
import j from "node:path";
var x = j.resolve(import.meta.dirname, ".."),
  g = "__centraidAutomationRuntimeDir";
function p() {
  let $ = globalThis[g];
  if (typeof $ === "string" && $.length > 0) return j.resolve($);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return j.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return j.join(x, "runtime");
}
var F = p(),
  O = j.join(F, "models");
import { existsSync as u, readFileSync as c, statSync as s } from "node:fs";
import _ from "node:path";
import { pathToFileURL as l } from "node:url";
var w;
class A extends Error {
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
function P($, q = F) {
  let v = _.join(q, "node_modules");
  if (!u(v)) throw new A($);
  let B = _.join(v, ...$.split("/"));
  try {
    let Q = y(B);
    if (Q === null) throw Error(`no entry point in ${B}`);
    return Q;
  } catch (Q) {
    throw new A($, Q);
  }
}
function y($, q = 0) {
  let v = _.join($, "package.json"),
    B = u(v) ? JSON.parse(c(v, "utf8")) : {},
    Q = [
      ...L(d(B.exports)),
      ...(typeof B.main === "string" ? [B.main] : []),
      "index.js",
    ];
  for (let Y of Q) {
    let K = h(_.resolve($, Y), q);
    if (K !== null) return K;
  }
  return null;
}
function h($, q) {
  let v = R($);
  if (v?.isFile()) return $;
  if (v?.isDirectory()) return q >= 4 ? null : y($, q + 1);
  for (let B of [".js", ".json", ".node"]) {
    let Q = `${$}${B}`;
    if (R(Q)?.isFile()) return Q;
  }
  return null;
}
function R($) {
  try {
    return s($);
  } catch {
    return null;
  }
}
function d($) {
  if (typeof $ === "string") return $;
  if ($ === null || typeof $ !== "object") return;
  let q = $;
  return "." in q ? q["."] : q;
}
function L($, q = 0) {
  if (typeof $ === "string") return [$];
  if (q > 8 || $ === null || typeof $ !== "object") return [];
  if (Array.isArray($)) return $.flatMap((Q) => L(Q, q + 1));
  let v = $,
    B = [];
  for (let Q of ["require", "node", "default"])
    if (Q in v) B.push(...L(v[Q], q + 1));
  return B;
}
async function f() {
  if (w) return w;
  let $ = P("onnxruntime-node");
  return ((w = await import(l($).href)), w);
}
var U;
async function T($) {
  U ??= new Map();
  let q = U.get($);
  if (q) return q;
  if (!u($)) throw new A($);
  let v = f().then((B) => B.InferenceSession.create($));
  U.set($, v);
  try {
    return await v;
  } catch (B) {
    throw (U.delete($), B);
  }
}
import { pathToFileURL as n } from "node:url";
var M;
async function o() {
  if (M) return M;
  let $ = P("sharp");
  return ((M = (await import(n($).href)).default), M);
}
async function I($, q) {
  let B = (await o())(Buffer.from($)),
    { data: Q, info: Y } = await B.resize({
      width: q,
      height: q,
      fit: "cover",
      position: "centre",
    })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(Q.buffer, Q.byteOffset, Q.byteLength),
    width: Y.width,
    height: Y.height,
  };
}
var r = [0.48145466, 0.4578275, 0.40821073],
  i = [0.26862954, 0.26130258, 0.27577711];
function E($) {
  let { width: q, height: v, data: B } = $,
    Q = q * v,
    Y = new Float32Array(Q * 3);
  for (let K = 0; K < Q; K++)
    for (let J = 0; J < 3; J++) {
      let X = (B[K * 3 + J] ?? 0) / 255;
      Y[J * Q + K] = (X - r[J]) / i[J];
    }
  return Y;
}
var b = "clip-vit-b-32@1",
  C = V.join(O, "clip"),
  t = V.join(C, "visual.onnx"),
  L0 = V.join(C, "textual.onnx"),
  u0 = V.join(C, "vocab.json"),
  P0 = V.join(C, "merges.txt"),
  N = 224;
function z($ = O) {
  let q = V.join($, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (v) => a(V.join(q, v))
  );
}
function e($) {
  let q = 0;
  for (let B of $) q += B * B;
  let v = Math.sqrt(q);
  if (v === 0) return Array.from($);
  return Array.from($, (B) => B / v);
}
function $0($, q) {
  let v = q[0],
    B = v ? $[v] : void 0;
  if (!B || !(B.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return B.data;
}
async function D($) {
  try {
    let q = Buffer.from($.bytes, "base64"),
      v = await I(q, N),
      B = E(v),
      Q = await f(),
      Y = await T(t),
      J = {
        [Y.inputNames[0] ?? "pixel_values"]: new Q.Tensor("float32", B, [
          1,
          3,
          N,
          N,
        ]),
      },
      X = await Y.run(J),
      W = e($0(X, Y.outputNames));
    return { id: $.id, vector: W };
  } catch (q) {
    return { id: $.id, error: q instanceof Error ? q.message : String(q) };
  }
}
var k = 16,
  S = D,
  m = z;
function z0($) {
  ((S = $?.infer ?? D), (m = $?.weightsPresent ?? z));
}
function q0() {
  return m() ? b : null;
}
async function B0($, q) {
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
async function v0({ ctx: $, log: q }) {
  let v = q0();
  if (!v)
    return { summary: "image embedding skipped — model assets unavailable" };
  let B = await $.state.get("model");
  if (B !== v)
    (await $.state.set("cursor", B === void 0 ? await B0($, v) : ""),
      await $.state.set("model", v));
  let Q = (await $.state.get("cursor")) ?? "",
    Y = await $.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: Q },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: k,
    }),
    K = 0,
    J = 0;
  for (let W of Y.rows ?? []) {
    if (W.kind !== "photo" && W.kind !== "scan") {
      J += 1;
      continue;
    }
    if (
      (
        await $.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: W.asset_id },
            { column: "variant", op: "eq", value: "embedding" },
          ],
          limit: 1,
        })
      ).rows?.[0]?.model === v
    ) {
      J += 1;
      continue;
    }
    let G = await $.vault.content({
      contentId: W.content_id,
      variant: "preview",
      maxBytes: 4194304,
    });
    if (G?.status !== "ok" || G.kind !== "bytes")
      throw Error(`asset ${W.asset_id}: preview is unavailable`);
    let H = await S({
      id: W.asset_id,
      mediaType: G.mediaType,
      bytes: G.base64,
    });
    if (!H || H.error || !Array.isArray(H.vector)) {
      ((J += 1), q.info(`asset ${W.asset_id}: no image vector`));
      continue;
    }
    (await $.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "media.asset",
        entity_id: W.asset_id,
        model: v,
        vector: H.vector,
        capability: "embed-image",
      },
    }),
      (K += 1));
  }
  let X = Y.rows?.at(-1)?.asset_id;
  if (X) await $.state.set("cursor", X);
  return {
    summary: `embedded ${K} images; skipped ${J}; bounded batch ${Y.rows?.length ?? 0}/${k}`,
    output: {
      derived: K,
      skipped: J,
      model: v,
      rearm: (Y.rows?.length ?? 0) === k,
    },
  };
}
export { z0 as setEmbedImageRuntimeForTests, v0 as default };
