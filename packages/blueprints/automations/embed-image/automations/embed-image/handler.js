// Generated recognition automation. Source: tools/recognition-automations/automation-handlers.
import { existsSync as c } from "node:fs";
import V from "node:path";
import _ from "node:path";
var S = _.resolve(import.meta.dirname, ".."),
  A = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? _.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : _.join(S, "runtime"),
  D = _.join(A, "models");
import { existsSync as z } from "node:fs";
import { createRequire as b } from "node:module";
import k from "node:path";
import { pathToFileURL as x } from "node:url";
var F;
class U extends Error {
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
  if (!z(k.join(B, "node_modules"))) throw new U($);
  let Y = b(k.join(B, "package.json"));
  try {
    return Y.resolve($);
  } catch (Q) {
    throw new U($, Q);
  }
}
async function C() {
  if (F) return F;
  let $ = O("onnxruntime-node");
  return ((F = await import(x($).href)), F);
}
var G;
async function R($) {
  G ??= new Map();
  let B = G.get($);
  if (B) return B;
  if (!z($)) throw new U($);
  let Y = C().then((Q) => Q.InferenceSession.create($));
  G.set($, Y);
  try {
    return await Y;
  } catch (Q) {
    throw (G.delete($), Q);
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
  let Q = (await p())(Buffer.from($)),
    { data: K, info: q } = await Q.resize({
      width: B,
      height: B,
      fit: "cover",
      position: "centre",
    })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(K.buffer, K.byteOffset, K.byteLength),
    width: q.width,
    height: q.height,
  };
}
var m = [0.48145466, 0.4578275, 0.40821073],
  l = [0.26862954, 0.26130258, 0.27577711];
function y($) {
  let { width: B, height: Y, data: Q } = $,
    K = B * Y,
    q = new Float32Array(K * 3);
  for (let W = 0; W < K; W++)
    for (let J = 0; J < 3; J++) {
      let X = (Q[W * 3 + J] ?? 0) / 255;
      q[J * K + W] = (X - m[J]) / l[J];
    }
  return q;
}
var T = "clip-vit-b-32@1",
  M = V.join(D, "clip"),
  s = V.join(M, "visual.onnx"),
  G0 = V.join(M, "textual.onnx"),
  U0 = V.join(M, "vocab.json"),
  w0 = V.join(M, "merges.txt"),
  L = 224;
function N($ = D) {
  let B = V.join($, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (Y) => c(V.join(B, Y))
  );
}
function h($) {
  let B = 0;
  for (let Q of $) B += Q * Q;
  let Y = Math.sqrt(B);
  if (Y === 0) return Array.from($);
  return Array.from($, (Q) => Q / Y);
}
function d($, B) {
  let Y = B[0],
    Q = Y ? $[Y] : void 0;
  if (!Q || !(Q.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return Q.data;
}
async function P($) {
  try {
    let B = Buffer.from($.bytes, "base64"),
      Y = await u(B, L),
      Q = y(Y),
      K = await C(),
      q = await R(s),
      J = {
        [q.inputNames[0] ?? "pixel_values"]: new K.Tensor("float32", Q, [
          1,
          3,
          L,
          L,
        ]),
      },
      X = await q.run(J),
      v = h(d(X, q.outputNames));
    return { id: $.id, vector: v };
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
async function o($, B) {
  let Q = (
    await $.vault.read({
      entity: "media.media_asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: Z,
    })
  ).rows?.[0];
  if (!Q) return "";
  return (
    await $.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: Q.asset_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: Z,
    })
  ).rows?.[0]?.model === B
    ? Q.asset_id
    : "";
}
async function r({ ctx: $, log: B }) {
  let Y = n();
  if (!Y)
    return { summary: "image embedding skipped — model assets unavailable" };
  let Q = await $.state.get("model");
  if (Q !== Y)
    (await $.state.set("cursor", Q === void 0 ? await o($, Y) : ""),
      await $.state.set("model", Y));
  let K = (await $.state.get("cursor")) ?? "",
    q = await $.vault.read({
      entity: "media.media_asset",
      where: [
        { column: "asset_id", op: "gt", value: K },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: f,
      purpose: Z,
    }),
    W = 0,
    J = 0;
  for (let v of q.rows ?? []) {
    if (v.kind !== "photo" && v.kind !== "scan") {
      J += 1;
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
          purpose: Z,
        })
      ).rows?.[0]?.model === Y
    ) {
      J += 1;
      continue;
    }
    let j = await $.vault.content({
        contentId: v.content_id,
        variant: "preview",
        maxBytes: 4194304,
        purpose: Z,
      }),
      H =
        j?.status === "ok" && j.kind === "bytes"
          ? await E({ id: v.asset_id, mediaType: j.mediaType, bytes: j.base64 })
          : null;
    if (!H || H.error || !Array.isArray(H.vector)) {
      ((J += 1), B.info(`asset ${v.asset_id}: no image vector`));
      continue;
    }
    (await $.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "media.media_asset",
        entity_id: v.asset_id,
        model: Y,
        vector: H.vector,
        capability: "embed-image",
      },
      purpose: Z,
    }),
      (W += 1));
  }
  let X = q.rows?.at(-1)?.asset_id;
  if (X) await $.state.set("cursor", X);
  return {
    summary: `embedded ${W} images; skipped ${J}; bounded batch ${q.rows?.length ?? 0}/${f}`,
    output: {
      derived: W,
      skipped: J,
      model: Y,
      rearm: (q.rows?.length ?? 0) === f,
    },
  };
}
export { D0 as setEmbedImageRuntimeForTests, r as default };
