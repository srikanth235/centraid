// Generated recognition automation. Source: tools/recognition-automations/automation-handlers.
import { existsSync as c } from "node:fs";
import V from "node:path";
import F from "node:path";
var S = F.resolve(import.meta.dirname, ".."),
  A = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? F.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : F.join(S, "runtime"),
  D = F.join(A, "models");
import { existsSync as z } from "node:fs";
import { createRequire as b } from "node:module";
import k from "node:path";
import { pathToFileURL as x } from "node:url";
var G;
class _ extends Error {
  constructor($, B) {
    super(
      `Automation model runtime dependency "${$}" is not installed. ` +
        'Run "bun run --cwd tools/recognition-automations setup" first — it installs ' +
        "optional native recognition dependencies into tools/recognition-automations/runtime/ and downloads the model weights those capabilities need.",
      { cause: B }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function O($, B = A) {
  if (!z(k.join(B, "node_modules"))) throw new _($);
  let Q = b(k.join(B, "package.json"));
  try {
    return Q.resolve($);
  } catch (v) {
    throw new _($, v);
  }
}
async function C() {
  if (G) return G;
  let $ = O("onnxruntime-node");
  return ((G = await import(x($).href)), G);
}
var U;
async function R($) {
  U ??= new Map();
  let B = U.get($);
  if (B) return B;
  if (!z($)) throw new _($);
  let Q = C().then((v) => v.InferenceSession.create($));
  U.set($, Q);
  try {
    return await Q;
  } catch (v) {
    throw (U.delete($), v);
  }
}
import { pathToFileURL as g } from "node:url";
var w;
async function p() {
  if (w) return w;
  let $ = O("sharp");
  return ((w = (await import(g($).href)).default), w);
}
async function u($, B) {
  let v = (await p())(Buffer.from($)),
    { data: J, info: Y } = await v
      .resize({ width: B, height: B, fit: "cover", position: "centre" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(J.buffer, J.byteOffset, J.byteLength),
    width: Y.width,
    height: Y.height,
  };
}
var m = [0.48145466, 0.4578275, 0.40821073],
  l = [0.26862954, 0.26130258, 0.27577711];
function y($) {
  let { width: B, height: Q, data: v } = $,
    J = B * Q,
    Y = new Float32Array(J * 3);
  for (let W = 0; W < J; W++)
    for (let q = 0; q < 3; q++) {
      let X = (v[W * 3 + q] ?? 0) / 255;
      Y[q * J + W] = (X - m[q]) / l[q];
    }
  return Y;
}
var T = "clip-vit-b-32@1",
  M = V.join(D, "clip"),
  s = V.join(M, "visual.onnx"),
  U0 = V.join(M, "textual.onnx"),
  _0 = V.join(M, "vocab.json"),
  w0 = V.join(M, "merges.txt"),
  L = 224;
function N($ = D) {
  let B = V.join($, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (Q) => c(V.join(B, Q))
  );
}
function h($) {
  let B = 0;
  for (let v of $) B += v * v;
  let Q = Math.sqrt(B);
  if (Q === 0) return Array.from($);
  return Array.from($, (v) => v / Q);
}
function d($, B) {
  let Q = B[0],
    v = Q ? $[Q] : void 0;
  if (!v || !(v.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return v.data;
}
async function P($) {
  try {
    let B = Buffer.from($.bytes, "base64"),
      Q = await u(B, L),
      v = y(Q),
      J = await C(),
      Y = await R(s),
      q = {
        [Y.inputNames[0] ?? "pixel_values"]: new J.Tensor("float32", v, [
          1,
          3,
          L,
          L,
        ]),
      },
      X = await Y.run(q),
      K = h(d(X, Y.outputNames));
    return { id: $.id, vector: K };
  } catch (B) {
    return { id: $.id, error: B instanceof Error ? B.message : String(B) };
  }
}
var f = 16,
  Z = "dpv:ServiceProvision",
  E = P,
  I = N;
function D0($) {
  ((E = $?.infer ?? P), (I = $?.weightsPresent ?? N));
}
function n() {
  return I() ? T : null;
}
async function r($, B) {
  let v = (
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
  if (!v) return "";
  return (
    await $.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: v.asset_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: Z,
    })
  ).rows?.[0]?.model === B
    ? v.asset_id
    : "";
}
async function o({ ctx: $, log: B }) {
  let Q = n();
  if (!Q)
    return { summary: "image embedding skipped — model assets unavailable" };
  let v = await $.state.get("model");
  if (v !== Q)
    (await $.state.set("cursor", v === void 0 ? await r($, Q) : ""),
      await $.state.set("model", Q));
  let J = (await $.state.get("cursor")) ?? "",
    Y = await $.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: J },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: f,
      purpose: Z,
    }),
    W = 0,
    q = 0;
  for (let K of Y.rows ?? []) {
    if (K.kind !== "photo" && K.kind !== "scan") {
      q += 1;
      continue;
    }
    if (
      (
        await $.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: K.asset_id },
            { column: "variant", op: "eq", value: "embedding" },
          ],
          limit: 1,
          purpose: Z,
        })
      ).rows?.[0]?.model === Q
    ) {
      q += 1;
      continue;
    }
    let j = await $.vault.content({
      contentId: K.content_id,
      variant: "preview",
      maxBytes: 4194304,
      purpose: Z,
    });
    if (j?.status !== "ok" || j.kind !== "bytes")
      throw Error(`asset ${K.asset_id}: preview is unavailable`);
    let H = await E({
      id: K.asset_id,
      mediaType: j.mediaType,
      bytes: j.base64,
    });
    if (!H || H.error || !Array.isArray(H.vector)) {
      ((q += 1), B.info(`asset ${K.asset_id}: no image vector`));
      continue;
    }
    (await $.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "media.asset",
        entity_id: K.asset_id,
        model: Q,
        vector: H.vector,
        capability: "embed-image",
      },
      purpose: Z,
    }),
      (W += 1));
  }
  let X = Y.rows?.at(-1)?.asset_id;
  if (X) await $.state.set("cursor", X);
  return {
    summary: `embedded ${W} images; skipped ${q}; bounded batch ${Y.rows?.length ?? 0}/${f}`,
    output: {
      derived: W,
      skipped: q,
      model: Q,
      rearm: (Y.rows?.length ?? 0) === f,
    },
  };
}
export { D0 as setEmbedImageRuntimeForTests, o as default };
