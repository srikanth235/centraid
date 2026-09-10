// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as e } from "node:fs";
import j from "node:path";
import U from "node:path";
var m = U.resolve(import.meta.dirname, ".."),
  c = "__centraidAutomationRuntimeDir";
function p() {
  let q = globalThis[c];
  if (typeof q === "string" && q.length > 0) return U.resolve(q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return U.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return U.join(m, "runtime");
}
var N = p(),
  z = U.join(N, "models");
import { existsSync as P, readFileSync as l, statSync as n } from "node:fs";
import M from "node:path";
import { pathToFileURL as s } from "node:url";
var A;
class C extends Error {
  constructor(q, K) {
    super(
      `Automation model runtime dependency "${q}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: K }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function _(q, K = N) {
  let Q = M.join(K, "node_modules");
  if (!P(Q)) throw new C(q);
  let Y = M.join(Q, ...q.split("/"));
  try {
    let $ = k(Y);
    if ($ === null) throw Error(`no entry point in ${Y}`);
    return $;
  } catch ($) {
    throw new C(q, $);
  }
}
function k(q, K = 0) {
  let Q = M.join(q, "package.json"),
    Y = P(Q) ? JSON.parse(l(Q, "utf8")) : {},
    $ = [
      ...D(o(Y.exports)),
      ...(typeof Y.main === "string" ? [Y.main] : []),
      "index.js",
    ];
  for (let J of $) {
    let X = d(M.resolve(q, J), K);
    if (X !== null) return X;
  }
  return null;
}
function d(q, K) {
  let Q = y(q);
  if (Q?.isFile()) return q;
  if (Q?.isDirectory()) return K >= 4 ? null : k(q, K + 1);
  for (let Y of [".js", ".json", ".node"]) {
    let $ = `${q}${Y}`;
    if (y($)?.isFile()) return $;
  }
  return null;
}
function y(q) {
  try {
    return n(q);
  } catch {
    return null;
  }
}
function o(q) {
  if (typeof q === "string") return q;
  if (q === null || typeof q !== "object") return;
  let K = q;
  return "." in K ? K["."] : K;
}
function D(q, K = 0) {
  if (typeof q === "string") return [q];
  if (K > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap(($) => D($, K + 1));
  let Q = q,
    Y = [];
  for (let $ of ["require", "node", "default"])
    if ($ in Q) Y.push(...D(Q[$], K + 1));
  return Y;
}
async function f() {
  if (A) return A;
  let q = _("onnxruntime-node");
  return ((A = await import(s(q).href)), A);
}
var F;
async function E(q) {
  F ??= new Map();
  let K = F.get(q);
  if (K) return K;
  if (!P(q)) throw new C(q);
  let Q = f().then((Y) => Y.InferenceSession.create(q));
  F.set(q, Q);
  try {
    return await Q;
  } catch (Y) {
    throw (F.delete(q), Y);
  }
}
import { pathToFileURL as r } from "node:url";
var L;
async function i() {
  if (L) return L;
  let q = _("sharp");
  return ((L = (await import(r(q).href)).default), L);
}
async function S(q, K) {
  let Y = (await i())(Buffer.from(q)),
    { data: $, info: J } = await Y.resize({
      width: K,
      height: K,
      fit: "cover",
      position: "centre",
    })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array($.buffer, $.byteOffset, $.byteLength),
    width: J.width,
    height: J.height,
  };
}
var a = [0.48145466, 0.4578275, 0.40821073],
  t = [0.26862954, 0.26130258, 0.27577711];
function b(q) {
  let { width: K, height: Q, data: Y } = q,
    $ = K * Q,
    J = new Float32Array($ * 3);
  for (let X = 0; X < $; X++)
    for (let V = 0; V < 3; V++) {
      let B = (Y[X * 3 + V] ?? 0) / 255;
      J[V * $ + X] = (B - a[V]) / t[V];
    }
  return J;
}
var u = "clip-vit-b-32@1",
  O = j.join(z, "clip"),
  qq = j.join(O, "visual.onnx"),
  Pq = j.join(O, "textual.onnx"),
  _q = j.join(O, "vocab.json"),
  fq = j.join(O, "merges.txt"),
  w = 224;
function R(q = z) {
  let K = j.join(q, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (Q) => e(j.join(K, Q))
  );
}
function Kq(q) {
  let K = 0;
  for (let Y of q) K += Y * Y;
  let Q = Math.sqrt(K);
  if (Q === 0) return Array.from(q);
  return Array.from(q, (Y) => Y / Q);
}
function Qq(q, K) {
  let Q = K[0],
    Y = Q ? q[Q] : void 0;
  if (!Y || !(Y.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return Y.data;
}
async function T(q) {
  try {
    let K = Buffer.from(q.bytes, "base64"),
      Q = await S(K, w),
      Y = b(Q),
      $ = await f(),
      J = await E(qq),
      V = {
        [J.inputNames[0] ?? "pixel_values"]: new $.Tensor("float32", Y, [
          1,
          3,
          w,
          w,
        ]),
      },
      B = await J.run(V),
      Z = Kq(Qq(B, J.outputNames));
    return { id: q.id, vector: Z };
  } catch (K) {
    return { id: q.id, error: K instanceof Error ? K.message : String(K) };
  }
}
async function x(q, K) {
  if (!K) return !1;
  return (
    ((
      await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "eq", value: K },
          { column: "variant", op: "eq", value: "preview" },
          { column: "capability", op: "eq", value: "previews" },
        ],
        limit: 1,
      })
    ).rows?.length ?? 0) > 0
  );
}
var I = 16,
  g = T,
  h = R;
function yq(q) {
  ((g = q?.infer ?? T), (h = q?.weightsPresent ?? R));
}
function Yq() {
  return h() ? u : null;
}
async function $q(q, K) {
  let Y = (
    await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
    })
  ).rows?.[0];
  if (!Y) return "";
  return (
    await q.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: Y.asset_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
    })
  ).rows?.[0]?.model === K
    ? Y.asset_id
    : "";
}
async function Jq({ ctx: q, log: K }) {
  let Q = Yq();
  if (!Q)
    return { summary: "image embedding skipped — model assets unavailable" };
  let Y = await q.state.get("model");
  if (Y !== Q)
    (await q.state.set("cursor", Y === void 0 ? await $q(q, Q) : ""),
      await q.state.set("model", Q));
  let $ = (await q.state.get("cursor")) ?? "",
    J = await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: $ },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: I,
    }),
    X = 0,
    V = 0,
    B = 0,
    Z = "",
    G = !1;
  for (let W of J.rows ?? []) {
    if (W.kind !== "photo" && W.kind !== "scan") {
      if (((V += 1), !G)) Z = W.asset_id;
      continue;
    }
    if (
      (
        await q.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: W.asset_id },
            { column: "variant", op: "eq", value: "embedding" },
          ],
          limit: 1,
        })
      ).rows?.[0]?.model === Q
    ) {
      if (((V += 1), !G)) Z = W.asset_id;
      continue;
    }
    let v = await q.vault.content({
      contentId: W.content_id,
      variant: "preview",
      maxBytes: 4194304,
    });
    if (v?.status !== "ok" || v.kind !== "bytes") {
      if (await x(q, W.content_id)) {
        if (((V += 1), !G)) Z = W.asset_id;
        K.info(`asset ${W.asset_id}: no preview this codec can produce`);
        continue;
      }
      ((B += 1),
        (G = !0),
        K.info(`asset ${W.asset_id}: preview has not landed yet`));
      continue;
    }
    let H = await g({
      id: W.asset_id,
      mediaType: v.mediaType,
      bytes: v.base64,
    });
    if (!H || H.error || !Array.isArray(H.vector)) {
      if (((V += 1), !G)) Z = W.asset_id;
      K.info(`asset ${W.asset_id}: no image vector`);
      continue;
    }
    if (
      (await q.vault.invoke({
        command: "enrich.upsert_embedding",
        input: {
          entity_type: "media.asset",
          entity_id: W.asset_id,
          model: Q,
          vector: H.vector,
          capability: "embed-image",
        },
      }),
      (X += 1),
      !G)
    )
      Z = W.asset_id;
  }
  if (Z) await q.state.set("cursor", Z);
  return {
    summary: `embedded ${X} images; skipped ${V}; not ready ${B}; bounded batch ${J.rows?.length ?? 0}/${I}`,
    output: {
      derived: X,
      skipped: V,
      notReady: B,
      model: Q,
      rearm: (J.rows?.length ?? 0) === I,
    },
  };
}
export { yq as setEmbedImageRuntimeForTests, Jq as default };
