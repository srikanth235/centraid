// Generated recognition automation. Source: tools/recognition-automations/automation-handlers.
import { existsSync as jq } from "node:fs";
import U from "node:path";
import D from "node:path";
var Cq = D.resolve(import.meta.dirname, ".."),
  S = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? D.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : D.join(Cq, "runtime"),
  b = D.join(S, "models");
function h(q, v) {
  let {
      stride: $,
      gridWidth: k,
      gridHeight: _,
      classScores: K,
      objectness: J,
      boxes: B,
      landmarks: X,
    } = q,
    G = [];
  for (let V = 0; V < _; V++)
    for (let Q = 0; Q < k; Q++) {
      let C = V * k + Q,
        Z = Math.max(0, Math.min(1, K[C] ?? 0)),
        F = Math.max(0, Math.min(1, J[C] ?? 0)),
        W = Math.sqrt(Z * F);
      if (W < v) continue;
      let w = B[C * 4] ?? 0,
        H = B[C * 4 + 1] ?? 0,
        L = B[C * 4 + 2] ?? 0,
        j = B[C * 4 + 3] ?? 0,
        A = Math.exp(L) * $,
        O = Math.exp(j) * $,
        P = (Q + w) * $,
        Vq = (V + H) * $,
        f;
      if (X) {
        f = [];
        for (let R = 0; R < 5; R++) {
          let Bq = X[C * 10 + R * 2] ?? 0,
            Xq = X[C * 10 + R * 2 + 1] ?? 0;
          f.push({ x: (Q + Bq) * $, y: (V + Xq) * $ });
        }
      }
      G.push({
        box: { x: P - A / 2, y: Vq - O / 2, width: A, height: O },
        score: W,
        landmarks: f,
      });
    }
  return G;
}
var l = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
function x(q, v) {
  if (q.length !== v.length || q.length === 0)
    throw Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  let $ = q.length,
    k = { x: 0, y: 0 },
    _ = { x: 0, y: 0 };
  for (let L = 0; L < $; L++)
    ((k.x += q[L].x / $),
      (k.y += q[L].y / $),
      (_.x += v[L].x / $),
      (_.y += v[L].y / $));
  let K = 0,
    J = 0,
    B = 0,
    X = 0,
    G = 0;
  for (let L = 0; L < $; L++) {
    let j = q[L].x - k.x,
      A = q[L].y - k.y,
      O = v[L].x - _.x,
      P = v[L].y - _.y;
    ((K += j * O),
      (J += j * P),
      (B += A * O),
      (X += A * P),
      (G += j * j + A * A));
  }
  let V = J - B,
    Q = K + X,
    C = Math.atan2(V, Q),
    Z = Math.hypot(Q, V) / (G === 0 ? 1 : G),
    F = Z * Math.cos(C),
    W = Z * Math.sin(C),
    w = _.x - (F * k.x - W * k.y),
    H = _.y - (W * k.x + F * k.y);
  return { a: F, b: W, tx: w, ty: H };
}
function Zq(q, v) {
  return { x: q.a * v.x - q.b * v.y + q.tx, y: q.b * v.x + q.a * v.y + q.ty };
}
function d(q, v, $, k) {
  let _ = v.a ** 2 + v.b ** 2,
    K =
      _ === 0
        ? { a: 1, b: 0, tx: 0, ty: 0 }
        : {
            a: v.a / _,
            b: -v.b / _,
            tx: (-v.a * v.tx - v.b * v.ty) / _,
            ty: (v.b * v.tx - v.a * v.ty) / _,
          },
    J = new Uint8Array($ * k * 3);
  for (let B = 0; B < k; B++)
    for (let X = 0; X < $; X++) {
      let G = Zq(K, { x: X, y: B }),
        V = Fq(q, G.x, G.y),
        Q = (B * $ + X) * 3;
      ((J[Q] = V[0]), (J[Q + 1] = V[1]), (J[Q + 2] = V[2]));
    }
  return { data: J, width: $, height: k };
}
function Fq(q, v, $) {
  if (v < 0 || $ < 0 || v > q.width - 1 || $ > q.height - 1) return [0, 0, 0];
  let k = Math.floor(v),
    _ = Math.floor($),
    K = Math.min(q.width - 1, k + 1),
    J = Math.min(q.height - 1, _ + 1),
    B = v - k,
    X = $ - _,
    G = (Q, C, Z) => q.data[(C * q.width + Q) * 3 + Z] ?? 0,
    V = [0, 0, 0];
  for (let Q = 0; Q < 3; Q++) {
    let C = G(k, _, Q) * (1 - B) + G(K, _, Q) * B,
      Z = G(k, J, Q) * (1 - B) + G(K, J, Q) * B;
    V[Q] = Math.round(C * (1 - X) + Z * X);
  }
  return V;
}
function n(q, v, $) {
  let k = $.width / v.width,
    _ = $.height / v.height;
  return { x: q.x * k, y: q.y * _, width: q.width * k, height: q.height * _ };
}
function t(q, v, $) {
  let k = Math.max(0, Math.min(v, Math.round(q.x))),
    _ = Math.max(0, Math.min($, Math.round(q.y))),
    K = Math.max(k, Math.min(v, Math.round(q.x + q.width))),
    J = Math.max(_, Math.min($, Math.round(q.y + q.height)));
  return [k, _, K - k, J - _];
}
function r(q) {
  return Math.max(0, q.width) * Math.max(0, q.height);
}
function Lq(q, v) {
  let $ = q.x + q.width,
    k = q.y + q.height,
    _ = v.x + v.width,
    K = v.y + v.height,
    J = Math.max(q.x, v.x),
    B = Math.max(q.y, v.y),
    X = Math.min($, _),
    G = Math.min(k, K),
    V = Math.max(0, X - J),
    Q = Math.max(0, G - B),
    C = V * Q;
  if (C <= 0) return 0;
  let Z = r(q) + r(v) - C;
  return Z <= 0 ? 0 : C / Z;
}
function o(q, v) {
  let $ = [...q].sort((_, K) => K.score - _.score),
    k = [];
  for (let _ of $)
    if (!k.some((J) => Lq(J.box, _.box) > v.iouThreshold)) {
      if ((k.push(_), v.topK !== void 0 && k.length >= v.topK)) break;
    }
  return k;
}
import { existsSync as a } from "node:fs";
import { createRequire as wq } from "node:module";
import i from "node:path";
import { pathToFileURL as Wq } from "node:url";
var z;
class E extends Error {
  constructor(q, v) {
    super(
      `Automation model runtime dependency "${q}" is not installed. ` +
        'Run "bun run --cwd tools/recognition-automations setup" first — it installs ' +
        "optional native recognition dependencies into tools/recognition-automations/runtime/ and downloads the model weights those capabilities need.",
      { cause: v }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function p(q, v = S) {
  if (!a(i.join(v, "node_modules"))) throw new E(q);
  let $ = wq(i.join(v, "package.json"));
  try {
    return $.resolve(q);
  } catch (k) {
    throw new E(q, k);
  }
}
async function N() {
  if (z) return z;
  let q = p("onnxruntime-node");
  return ((z = await import(Wq(q).href)), z);
}
var M;
async function g(q) {
  M ??= new Map();
  let v = M.get(q);
  if (v) return v;
  if (!a(q)) throw new E(q);
  let $ = N().then((k) => k.InferenceSession.create(q));
  M.set(q, $);
  try {
    return await $;
  } catch (k) {
    throw (M.delete(q), k);
  }
}
import { pathToFileURL as Hq } from "node:url";
var I;
async function e() {
  if (I) return I;
  let q = p("sharp");
  return ((I = (await import(Hq(q).href)).default), I);
}
async function qq(q) {
  let $ = (await e())(Buffer.from(q)),
    { data: k, info: _ } = await $.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(k.buffer, k.byteOffset, k.byteLength),
    width: _.width,
    height: _.height,
  };
}
async function vq(q, v, $) {
  let _ = (await e())(Buffer.from(q)),
    { data: K, info: J } = await _.resize({ width: v, height: $, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(K.buffer, K.byteOffset, K.byteLength),
    width: J.width,
    height: J.height,
  };
}
function $q(q) {
  let { width: v, height: $, data: k } = q,
    _ = v * $,
    K = new Float32Array(_ * 3);
  for (let J = 0; J < _; J++)
    ((K[J] = k[J * 3 + 2] ?? 0),
      (K[_ + J] = k[J * 3 + 1] ?? 0),
      (K[_ * 2 + J] = k[J * 3] ?? 0));
  return K;
}
function _q(q) {
  let { width: v, height: $, data: k } = q,
    _ = v * $,
    K = new Float32Array(_ * 3);
  for (let J = 0; J < _; J++)
    ((K[J] = k[J * 3] ?? 0),
      (K[_ + J] = k[J * 3 + 1] ?? 0),
      (K[_ * 2 + J] = k[J * 3 + 2] ?? 0));
  return K;
}
var kq = "yunet-sface@1",
  Jq = U.join(b, "faces"),
  Aq = U.join(Jq, "yunet.onnx"),
  uq = U.join(Jq, "sface.onnx"),
  Y = 640,
  Oq = [8, 16, 32],
  Yq = 0.6,
  Uq = 0.3,
  y = 112;
function c(q = b) {
  let v = U.join(q, "faces");
  return ["yunet.onnx", "sface.onnx"].every(($) => jq(U.join(v, $)));
}
async function Pq(q, v) {
  let $ = await N(),
    k = await g(Aq),
    _ = k.inputNames[0] ?? "input",
    K = await k.run({ [_]: new $.Tensor("float32", q, [1, 3, v, v]) }),
    J = [];
  for (let G of Oq) {
    let V = v / G,
      Q = K[`cls_${G}`]?.data,
      C = K[`obj_${G}`]?.data,
      Z = K[`bbox_${G}`]?.data,
      F = K[`kps_${G}`]?.data;
    if (!Q || !C || !Z || !F)
      throw Error(`faces: YuNet output set is incomplete at stride ${G}`);
    J.push(
      ...h(
        {
          stride: G,
          gridWidth: V,
          gridHeight: V,
          classScores: Q,
          objectness: C,
          boxes: Z,
          landmarks: F,
        },
        Yq
      )
    );
  }
  let B = o(
      J.map((G) => ({ box: G.box, score: G.score })),
      { iouThreshold: Uq, topK: 20 }
    ),
    X = new Set(B.map((G) => G.box));
  return J.filter((G) => X.has(G.box));
}
async function Rq(q) {
  let v = await N(),
    $ = await g(uq),
    k = $.inputNames[0] ?? "data",
    _ = await $.run({ [k]: new v.Tensor("float32", q, [1, 3, y, y]) }),
    K = $.outputNames[0],
    J = K ? _[K]?.data : void 0;
  if (!J || !(J instanceof Float32Array))
    throw Error("faces: SFace did not return a float32 embedding");
  return Array.from(J);
}
async function m(q) {
  try {
    let v = Buffer.from(q.bytes, "base64"),
      $ = await qq(v),
      k = await vq(v, Y, Y),
      _ = $q(k),
      K = await Pq(_, Y),
      J = $.width / Y,
      B = $.height / Y,
      X =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: $.width, height: $.height },
      V = (
        await Promise.all(
          K.filter((Q) => Q.landmarks).map(async (Q) => {
            let Z = Q.landmarks.map((A) => ({ x: A.x * J, y: A.y * B })),
              F = x(Z, l),
              W = d($, F, y, y),
              w = _q(W),
              H = await Rq(w),
              L = {
                x: Q.box.x * J,
                y: Q.box.y * B,
                width: Q.box.width * J,
                height: Q.box.height * B,
              },
              j = t(n(L, $, X), X.width, X.height);
            if (j[2] <= 0 || j[3] <= 0) return;
            return { box: j, confidence: Q.score, embedding: H };
          })
        )
      ).filter((Q) => Q !== void 0);
    return { id: q.id, faces: V };
  } catch (v) {
    return { id: q.id, error: v instanceof Error ? v.message : String(v) };
  }
}
var T = 16,
  u = "dpv:ServiceProvision",
  Qq = m,
  Gq = c;
function q0(q) {
  ((Qq = q?.infer ?? m), (Gq = q?.weightsPresent ?? c));
}
function Dq() {
  return Gq() ? kq : null;
}
async function Kq(q, v) {
  return (
    await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "eq", value: v },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 1,
      purpose: u,
    })
  ).rows?.[0];
}
async function s(q, v, $) {
  if (
    (
      await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "eq", value: v.asset_id },
          { column: "variant", op: "eq", value: "faces" },
        ],
        limit: 1,
        purpose: u,
      })
    ).rows?.[0]?.model === $
  )
    return { settled: !0, derived: 0, skipped: 1 };
  let _ = await q.vault.content({
    contentId: v.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: u,
  });
  if (_?.status !== "ok" || _.kind !== "bytes")
    throw Error(`asset ${v.asset_id}: preview is unavailable`);
  let K = await Qq({
    id: v.asset_id,
    bytes: _.base64,
    mediaType: _.mediaType,
    originalWidth: v.width,
    originalHeight: v.height,
  });
  if (!K || K.error || !Array.isArray(K.faces))
    throw Error(
      K?.error ?? `asset ${v.asset_id}: face detector returned no result`
    );
  return (
    await q.vault.invoke({
      command: "enrich.upsert_faces",
      input: { asset_id: v.asset_id, model: $, faces: K.faces },
      purpose: u,
    }),
    { settled: !0, derived: 1, skipped: 0 }
  );
}
async function zq(q, v) {
  let $ = await q.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
    purpose: u,
  });
  return $.rows?.[0]?.model === v ? $.rows[0].target_id : "";
}
async function Mq({ ctx: q }) {
  let v = Dq();
  if (!v)
    return { summary: "faces skipped — automation model assets unavailable" };
  let $ = await q.state.get("model");
  if ($ !== v)
    (await q.state.set("consentCursor", $ === void 0 ? await zq(q, v) : ""),
      await q.state.set("model", v));
  let k = await q.vault.read({
      entity: "enrich.request",
      where: [
        { column: "capability", op: "eq", value: "faces" },
        { column: "drained_at", op: "is-null" },
      ],
      orderBy: { column: "request_id", dir: "asc" },
      limit: T,
      purpose: u,
    }),
    _ = 0,
    K = 0,
    J = T,
    B = (k.rows?.length ?? 0) === T,
    X = [],
    G = new Set();
  for (let V of k.rows ?? []) {
    if (J === 0) {
      B = !0;
      break;
    }
    if (V.target_id) {
      let w = await Kq(q, V.target_id);
      if (!w) {
        ((K += 1), X.push(V.request_id), (J -= 1));
        continue;
      }
      let H = await s(q, w, v);
      if (
        (G.add(w.asset_id),
        (_ += H.derived),
        (K += H.skipped),
        (J -= 1),
        H.settled)
      )
        X.push(V.request_id);
      continue;
    }
    let Q = `requestCursor:${V.request_id}`,
      C = (await q.state.get(Q)) ?? "",
      Z = J,
      F = await q.vault.read({
        entity: "media.asset",
        where: [
          { column: "asset_id", op: "gt", value: C },
          { column: "kind", op: "in", value: ["photo", "scan"] },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "asset_id", dir: "asc" },
        limit: Z,
        purpose: u,
      });
    for (let w of F.rows ?? []) {
      let H = await s(q, w, v);
      (G.add(w.asset_id), (_ += H.derived), (K += H.skipped), (J -= 1));
    }
    let W = F.rows?.at(-1)?.asset_id;
    if (W) await q.state.set(Q, W);
    if ((F.rows?.length ?? 0) < Z) X.push(V.request_id);
    else B = !0;
  }
  if (J > 0) {
    let V = (await q.state.get("consentCursor")) ?? "",
      Q = J,
      C = await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "gt", value: V },
          { column: "variant", op: "eq", value: "faces" },
        ],
        orderBy: { column: "target_id", dir: "asc" },
        limit: Q,
        purpose: u,
      });
    for (let F of C.rows ?? []) {
      if (G.has(F.target_id)) continue;
      let W = await Kq(q, F.target_id);
      if (!W) {
        K += 1;
        continue;
      }
      let w = await s(q, W, v);
      ((_ += w.derived), (K += w.skipped));
    }
    let Z = C.rows?.at(-1)?.target_id;
    if (Z) await q.state.set("consentCursor", Z);
    if ((C.rows?.length ?? 0) === Q) B = !0;
  }
  if (X.length)
    await q.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: X },
      purpose: u,
    });
  if (_ > 0)
    await q.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
      purpose: u,
    });
  return {
    summary: `faces derived ${_}; skipped ${K}; consent queue batch ${k.rows?.length ?? 0}/${T}`,
    output: { derived: _, skipped: K, drained: X.length, model: v, rearm: B },
  };
}
export { q0 as setFacesRuntimeForTests, Mq as default };
