// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as Qq } from "node:fs";
import j from "node:path";
import U from "node:path";
var p = U.resolve(import.meta.dirname, ".."),
  l = "__centraidAutomationRuntimeDir";
function d() {
  let q = globalThis[l];
  if (typeof q === "string" && q.length > 0) return U.resolve(q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return U.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return U.join(p, "runtime");
}
var N = d(),
  z = U.join(N, "models");
import { existsSync as D, readFileSync as n, statSync as s } from "node:fs";
import M from "node:path";
import { pathToFileURL as o } from "node:url";
var F;
class L extends Error {
  constructor(q, Q) {
    super(
      `Automation model runtime dependency "${q}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: Q }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function _(q, Q = N) {
  let $ = M.join(Q, "node_modules");
  if (!D($)) throw new L(q);
  let J = M.join($, ...q.split("/"));
  try {
    let K = k(J);
    if (K === null) throw Error(`no entry point in ${J}`);
    return K;
  } catch (K) {
    throw new L(q, K);
  }
}
function k(q, Q = 0) {
  let $ = M.join(q, "package.json"),
    J = D($) ? JSON.parse(n($, "utf8")) : {},
    K = [
      ...P(i(J.exports)),
      ...(typeof J.main === "string" ? [J.main] : []),
      "index.js",
    ];
  for (let W of K) {
    let Z = r(M.resolve(q, W), Q);
    if (Z !== null) return Z;
  }
  return null;
}
function r(q, Q) {
  let $ = y(q);
  if ($?.isFile()) return q;
  if ($?.isDirectory()) return Q >= 4 ? null : k(q, Q + 1);
  for (let J of [".js", ".json", ".node"]) {
    let K = `${q}${J}`;
    if (y(K)?.isFile()) return K;
  }
  return null;
}
function y(q) {
  try {
    return s(q);
  } catch {
    return null;
  }
}
function i(q) {
  if (typeof q === "string") return q;
  if (q === null || typeof q !== "object") return;
  let Q = q;
  return "." in Q ? Q["."] : Q;
}
function P(q, Q = 0) {
  if (typeof q === "string") return [q];
  if (Q > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap((K) => P(K, Q + 1));
  let $ = q,
    J = [];
  for (let K of ["require", "node", "default"])
    if (K in $) J.push(...P($[K], Q + 1));
  return J;
}
async function f() {
  if (F) return F;
  let q = _("onnxruntime-node");
  return ((F = await import(o(q).href)), F);
}
var A;
async function E(q) {
  A ??= new Map();
  let Q = A.get(q);
  if (Q) return Q;
  if (!D(q)) throw new L(q);
  let $ = f().then((J) => J.InferenceSession.create(q));
  A.set(q, $);
  try {
    return await $;
  } catch (J) {
    throw (A.delete(q), J);
  }
}
import { pathToFileURL as a } from "node:url";
var C;
async function t() {
  if (C) return C;
  let q = _("sharp");
  return ((C = (await import(a(q).href)).default), C);
}
async function S(q, Q) {
  let J = (await t())(Buffer.from(q)),
    { data: K, info: W } = await J.resize({
      width: Q,
      height: Q,
      fit: "cover",
      position: "centre",
    })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(K.buffer, K.byteOffset, K.byteLength),
    width: W.width,
    height: W.height,
  };
}
var e = [0.48145466, 0.4578275, 0.40821073],
  qq = [0.26862954, 0.26130258, 0.27577711];
function b(q) {
  let { width: Q, height: $, data: J } = q,
    K = Q * $,
    W = new Float32Array(K * 3);
  for (let Z = 0; Z < K; Z++)
    for (let Y = 0; Y < 3; Y++) {
      let B = (J[Z * 3 + Y] ?? 0) / 255;
      W[Y * K + Z] = (B - e[Y]) / qq[Y];
    }
  return W;
}
var u = "clip-vit-b-32@1",
  O = j.join(z, "clip"),
  $q = j.join(O, "visual.onnx"),
  wq = j.join(O, "textual.onnx"),
  Rq = j.join(O, "vocab.json"),
  Tq = j.join(O, "merges.txt"),
  w = 224;
function R(q = z) {
  let Q = j.join(q, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    ($) => Qq(j.join(Q, $))
  );
}
function Jq(q) {
  let Q = 0;
  for (let J of q) Q += J * J;
  let $ = Math.sqrt(Q);
  if ($ === 0) return Array.from(q);
  return Array.from(q, (J) => J / $);
}
function Kq(q, Q) {
  let $ = Q[0],
    J = $ ? q[$] : void 0;
  if (!J || !(J.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return J.data;
}
async function T(q) {
  try {
    let Q = Buffer.from(q.bytes, "base64"),
      $ = await S(Q, w),
      J = b($),
      K = await f(),
      W = await E($q),
      Y = {
        [W.inputNames[0] ?? "pixel_values"]: new K.Tensor("float32", J, [
          1,
          3,
          w,
          w,
        ]),
      },
      B = await W.run(Y),
      X = Jq(Kq(B, W.outputNames));
    return { id: q.id, vector: X };
  } catch (Q) {
    return { id: q.id, error: Q instanceof Error ? Q.message : String(Q) };
  }
}
async function x(q, Q) {
  if (!Q) return !1;
  return (
    ((
      await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "eq", value: Q },
          { column: "variant", op: "eq", value: "preview" },
          { column: "capability", op: "eq", value: "previews" },
        ],
        limit: 1,
      })
    ).rows?.length ?? 0) > 0
  );
}
var g = 12;
async function h(q, Q) {
  try {
    let $ = await q.vault.invoke({
        command: "enrich.record_target_failure",
        input: {
          capability: Q.capability,
          target_type: Q.targetType,
          target_id: Q.targetId,
          ...(Q.error === void 0
            ? {}
            : { error: String(Q.error).slice(0, 2000) }),
          ...(Q.reason === void 0 ? {} : { reason: Q.reason }),
          ...(Q.permanent === void 0 ? {} : { permanent: Q.permanent }),
          ...(Q.maxFailures === void 0 ? {} : { max_failures: Q.maxFailures }),
        },
      }),
      J = $?.output ?? $;
    return { failures: Number(J?.failures ?? 0), declined: J?.declined === !0 };
  } catch {
    return { failures: 0, declined: !1 };
  }
}
var I = 16,
  m = T,
  c = R;
function uq(q) {
  ((m = q?.infer ?? T), (c = q?.weightsPresent ?? R));
}
function Vq() {
  return c() ? u : null;
}
async function Yq(q, Q) {
  let J = (
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
  if (!J) return "";
  return (
    await q.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: J.asset_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
    })
  ).rows?.[0]?.model === Q
    ? J.asset_id
    : "";
}
async function Wq({ ctx: q, log: Q }) {
  let $ = Vq();
  if (!$)
    return { summary: "image embedding skipped — model assets unavailable" };
  let J = await q.state.get("model");
  if (J !== $)
    (await q.state.set("cursor", J === void 0 ? await Yq(q, $) : ""),
      await q.state.set("model", $));
  let K = (await q.state.get("cursor")) ?? "",
    W = await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: K },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: I,
    }),
    Z = 0,
    Y = 0,
    B = 0,
    X = "",
    G = !1;
  for (let V of W.rows ?? []) {
    if (V.kind !== "photo" && V.kind !== "scan") {
      if (((Y += 1), !G)) X = V.asset_id;
      continue;
    }
    if (
      (
        await q.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: V.asset_id },
            { column: "variant", op: "eq", value: "embedding" },
          ],
          limit: 1,
        })
      ).rows?.[0]?.model === $
    ) {
      if (((Y += 1), !G)) X = V.asset_id;
      continue;
    }
    let H = await q.vault.content({
      contentId: V.content_id,
      variant: "preview",
      maxBytes: 4194304,
    });
    if (H?.status !== "ok" || H.kind !== "bytes") {
      if (await x(q, V.content_id)) {
        if (((Y += 1), !G)) X = V.asset_id;
        Q.info(`asset ${V.asset_id}: no preview this codec can produce`);
        continue;
      }
      if (
        (
          await h(q, {
            capability: "embed-image",
            targetType: "media.asset",
            targetId: V.asset_id,
            reason: "no-preview",
            error: "no preview landed for this asset",
            maxFailures: g,
          })
        ).declined
      ) {
        if (((Y += 1), !G)) X = V.asset_id;
        Q.info(`asset ${V.asset_id}: no preview ever landed`);
        continue;
      }
      ((B += 1),
        (G = !0),
        Q.info(`asset ${V.asset_id}: preview has not landed yet`));
      continue;
    }
    let v = await m({
      id: V.asset_id,
      mediaType: H.mediaType,
      bytes: H.base64,
    });
    if (!v || v.error || !Array.isArray(v.vector)) {
      if (((Y += 1), !G)) X = V.asset_id;
      Q.info(`asset ${V.asset_id}: no image vector`);
      continue;
    }
    if (
      (await q.vault.invoke({
        command: "enrich.upsert_embedding",
        input: {
          entity_type: "media.asset",
          entity_id: V.asset_id,
          model: $,
          vector: v.vector,
          capability: "embed-image",
        },
      }),
      (Z += 1),
      !G)
    )
      X = V.asset_id;
  }
  if (X) await q.state.set("cursor", X);
  return {
    summary: `embedded ${Z} images; skipped ${Y}; not ready ${B}; bounded batch ${W.rows?.length ?? 0}/${I}`,
    output: {
      derived: Z,
      skipped: Y,
      notReady: B,
      model: $,
      rearm: (W.rows?.length ?? 0) === I,
    },
  };
}
export { uq as setEmbedImageRuntimeForTests, Wq as default };
