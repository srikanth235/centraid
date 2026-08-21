// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
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
      gridWidth: J,
      gridHeight: k,
      classScores: Q,
      objectness: K,
      boxes: B,
      landmarks: X,
    } = q,
    G = [];
  for (let V = 0; V < k; V++)
    for (let _ = 0; _ < J; _++) {
      let C = V * J + _,
        Z = Math.max(0, Math.min(1, Q[C] ?? 0)),
        F = Math.max(0, Math.min(1, K[C] ?? 0)),
        W = Math.sqrt(Z * F);
      if (W < v) continue;
      let w = B[C * 4] ?? 0,
        H = B[C * 4 + 1] ?? 0,
        L = B[C * 4 + 2] ?? 0,
        j = B[C * 4 + 3] ?? 0,
        A = Math.exp(L) * $,
        O = Math.exp(j) * $,
        P = (_ + w) * $,
        Vq = (V + H) * $,
        f;
      if (X) {
        f = [];
        for (let R = 0; R < 5; R++) {
          let Bq = X[C * 10 + R * 2] ?? 0,
            Xq = X[C * 10 + R * 2 + 1] ?? 0;
          f.push({ x: (_ + Bq) * $, y: (V + Xq) * $ });
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
    J = { x: 0, y: 0 },
    k = { x: 0, y: 0 };
  for (let L = 0; L < $; L++)
    ((J.x += q[L].x / $),
      (J.y += q[L].y / $),
      (k.x += v[L].x / $),
      (k.y += v[L].y / $));
  let Q = 0,
    K = 0,
    B = 0,
    X = 0,
    G = 0;
  for (let L = 0; L < $; L++) {
    let j = q[L].x - J.x,
      A = q[L].y - J.y,
      O = v[L].x - k.x,
      P = v[L].y - k.y;
    ((Q += j * O),
      (K += j * P),
      (B += A * O),
      (X += A * P),
      (G += j * j + A * A));
  }
  let V = K - B,
    _ = Q + X,
    C = Math.atan2(V, _),
    Z = Math.hypot(_, V) / (G === 0 ? 1 : G),
    F = Z * Math.cos(C),
    W = Z * Math.sin(C),
    w = k.x - (F * J.x - W * J.y),
    H = k.y - (W * J.x + F * J.y);
  return { a: F, b: W, tx: w, ty: H };
}
function Zq(q, v) {
  return { x: q.a * v.x - q.b * v.y + q.tx, y: q.b * v.x + q.a * v.y + q.ty };
}
function d(q, v, $, J) {
  let k = v.a ** 2 + v.b ** 2,
    Q =
      k === 0
        ? { a: 1, b: 0, tx: 0, ty: 0 }
        : {
            a: v.a / k,
            b: -v.b / k,
            tx: (-v.a * v.tx - v.b * v.ty) / k,
            ty: (v.b * v.tx - v.a * v.ty) / k,
          },
    K = new Uint8Array($ * J * 3);
  for (let B = 0; B < J; B++)
    for (let X = 0; X < $; X++) {
      let G = Zq(Q, { x: X, y: B }),
        V = Fq(q, G.x, G.y),
        _ = (B * $ + X) * 3;
      ((K[_] = V[0]), (K[_ + 1] = V[1]), (K[_ + 2] = V[2]));
    }
  return { data: K, width: $, height: J };
}
function Fq(q, v, $) {
  if (v < 0 || $ < 0 || v > q.width - 1 || $ > q.height - 1) return [0, 0, 0];
  let J = Math.floor(v),
    k = Math.floor($),
    Q = Math.min(q.width - 1, J + 1),
    K = Math.min(q.height - 1, k + 1),
    B = v - J,
    X = $ - k,
    G = (_, C, Z) => q.data[(C * q.width + _) * 3 + Z] ?? 0,
    V = [0, 0, 0];
  for (let _ = 0; _ < 3; _++) {
    let C = G(J, k, _) * (1 - B) + G(Q, k, _) * B,
      Z = G(J, K, _) * (1 - B) + G(Q, K, _) * B;
    V[_] = Math.round(C * (1 - X) + Z * X);
  }
  return V;
}
function n(q, v, $) {
  let J = $.width / v.width,
    k = $.height / v.height;
  return { x: q.x * J, y: q.y * k, width: q.width * J, height: q.height * k };
}
function t(q, v, $) {
  let J = Math.max(0, Math.min(v, Math.round(q.x))),
    k = Math.max(0, Math.min($, Math.round(q.y))),
    Q = Math.max(J, Math.min(v, Math.round(q.x + q.width))),
    K = Math.max(k, Math.min($, Math.round(q.y + q.height)));
  return [J, k, Q - J, K - k];
}
function r(q) {
  return Math.max(0, q.width) * Math.max(0, q.height);
}
function Lq(q, v) {
  let $ = q.x + q.width,
    J = q.y + q.height,
    k = v.x + v.width,
    Q = v.y + v.height,
    K = Math.max(q.x, v.x),
    B = Math.max(q.y, v.y),
    X = Math.min($, k),
    G = Math.min(J, Q),
    V = Math.max(0, X - K),
    _ = Math.max(0, G - B),
    C = V * _;
  if (C <= 0) return 0;
  let Z = r(q) + r(v) - C;
  return Z <= 0 ? 0 : C / Z;
}
function o(q, v) {
  let $ = [...q].sort((k, Q) => Q.score - k.score),
    J = [];
  for (let k of $)
    if (!J.some((K) => Lq(K.box, k.box) > v.iouThreshold)) {
      if ((J.push(k), v.topK !== void 0 && J.length >= v.topK)) break;
    }
  return J;
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
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
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
  } catch (J) {
    throw new E(q, J);
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
  let $ = N().then((J) => J.InferenceSession.create(q));
  M.set(q, $);
  try {
    return await $;
  } catch (J) {
    throw (M.delete(q), J);
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
    { data: J, info: k } = await $.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(J.buffer, J.byteOffset, J.byteLength),
    width: k.width,
    height: k.height,
  };
}
async function vq(q, v, $) {
  let k = (await e())(Buffer.from(q)),
    { data: Q, info: K } = await k
      .resize({ width: v, height: $, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(Q.buffer, Q.byteOffset, Q.byteLength),
    width: K.width,
    height: K.height,
  };
}
function $q(q) {
  let { width: v, height: $, data: J } = q,
    k = v * $,
    Q = new Float32Array(k * 3);
  for (let K = 0; K < k; K++)
    ((Q[K] = J[K * 3 + 2] ?? 0),
      (Q[k + K] = J[K * 3 + 1] ?? 0),
      (Q[k * 2 + K] = J[K * 3] ?? 0));
  return Q;
}
function kq(q) {
  let { width: v, height: $, data: J } = q,
    k = v * $,
    Q = new Float32Array(k * 3);
  for (let K = 0; K < k; K++)
    ((Q[K] = J[K * 3] ?? 0),
      (Q[k + K] = J[K * 3 + 1] ?? 0),
      (Q[k * 2 + K] = J[K * 3 + 2] ?? 0));
  return Q;
}
var Jq = "yunet-sface@1",
  Kq = U.join(b, "faces"),
  Aq = U.join(Kq, "yunet.onnx"),
  uq = U.join(Kq, "sface.onnx"),
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
    J = await g(Aq),
    k = J.inputNames[0] ?? "input",
    Q = await J.run({ [k]: new $.Tensor("float32", q, [1, 3, v, v]) }),
    K = [];
  for (let G of Oq) {
    let V = v / G,
      _ = Q[`cls_${G}`]?.data,
      C = Q[`obj_${G}`]?.data,
      Z = Q[`bbox_${G}`]?.data,
      F = Q[`kps_${G}`]?.data;
    if (!_ || !C || !Z || !F)
      throw Error(`faces: YuNet output set is incomplete at stride ${G}`);
    K.push(
      ...h(
        {
          stride: G,
          gridWidth: V,
          gridHeight: V,
          classScores: _,
          objectness: C,
          boxes: Z,
          landmarks: F,
        },
        Yq
      )
    );
  }
  let B = o(
      K.map((G) => ({ box: G.box, score: G.score })),
      { iouThreshold: Uq, topK: 20 }
    ),
    X = new Set(B.map((G) => G.box));
  return K.filter((G) => X.has(G.box));
}
async function Rq(q) {
  let v = await N(),
    $ = await g(uq),
    J = $.inputNames[0] ?? "data",
    k = await $.run({ [J]: new v.Tensor("float32", q, [1, 3, y, y]) }),
    Q = $.outputNames[0],
    K = Q ? k[Q]?.data : void 0;
  if (!K || !(K instanceof Float32Array))
    throw Error("faces: SFace did not return a float32 embedding");
  return Array.from(K);
}
async function m(q) {
  try {
    let v = Buffer.from(q.bytes, "base64"),
      $ = await qq(v),
      J = await vq(v, Y, Y),
      k = $q(J),
      Q = await Pq(k, Y),
      K = $.width / Y,
      B = $.height / Y,
      X =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: $.width, height: $.height },
      V = (
        await Promise.all(
          Q.filter((_) => _.landmarks).map(async (_) => {
            let Z = _.landmarks.map((A) => ({ x: A.x * K, y: A.y * B })),
              F = x(Z, l),
              W = d($, F, y, y),
              w = kq(W),
              H = await Rq(w),
              L = {
                x: _.box.x * K,
                y: _.box.y * B,
                width: _.box.width * K,
                height: _.box.height * B,
              },
              j = t(n(L, $, X), X.width, X.height);
            if (j[2] <= 0 || j[3] <= 0) return;
            return { box: j, confidence: _.score, embedding: H };
          })
        )
      ).filter((_) => _ !== void 0);
    return { id: q.id, faces: V };
  } catch (v) {
    return { id: q.id, error: v instanceof Error ? v.message : String(v) };
  }
}
var T = 16,
  u = "dpv:ServiceProvision",
  _q = m,
  Gq = c;
function q0(q) {
  ((_q = q?.infer ?? m), (Gq = q?.weightsPresent ?? c));
}
function Dq() {
  return Gq() ? Jq : null;
}
async function Qq(q, v) {
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
  let k = await q.vault.content({
    contentId: v.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: u,
  });
  if (k?.status !== "ok" || k.kind !== "bytes")
    throw Error(`asset ${v.asset_id}: preview is unavailable`);
  let Q = await _q({
    id: v.asset_id,
    bytes: k.base64,
    mediaType: k.mediaType,
    originalWidth: v.width,
    originalHeight: v.height,
  });
  if (!Q || Q.error || !Array.isArray(Q.faces))
    throw Error(
      Q?.error ?? `asset ${v.asset_id}: face detector returned no result`
    );
  return (
    await q.vault.invoke({
      command: "enrich.upsert_faces",
      input: { asset_id: v.asset_id, model: $, faces: Q.faces },
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
  let J = await q.vault.read({
      entity: "enrich.request",
      where: [
        { column: "capability", op: "eq", value: "faces" },
        { column: "drained_at", op: "is-null" },
      ],
      orderBy: { column: "request_id", dir: "asc" },
      limit: T,
      purpose: u,
    }),
    k = 0,
    Q = 0,
    K = T,
    B = (J.rows?.length ?? 0) === T,
    X = [],
    G = new Set();
  for (let V of J.rows ?? []) {
    if (K === 0) {
      B = !0;
      break;
    }
    if (V.target_id) {
      let w = await Qq(q, V.target_id);
      if (!w) {
        ((Q += 1), X.push(V.request_id), (K -= 1));
        continue;
      }
      let H = await s(q, w, v);
      if (
        (G.add(w.asset_id),
        (k += H.derived),
        (Q += H.skipped),
        (K -= 1),
        H.settled)
      )
        X.push(V.request_id);
      continue;
    }
    let _ = `requestCursor:${V.request_id}`,
      C = (await q.state.get(_)) ?? "",
      Z = K,
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
      (G.add(w.asset_id), (k += H.derived), (Q += H.skipped), (K -= 1));
    }
    let W = F.rows?.at(-1)?.asset_id;
    if (W) await q.state.set(_, W);
    if ((F.rows?.length ?? 0) < Z) X.push(V.request_id);
    else B = !0;
  }
  if (K > 0) {
    let V = (await q.state.get("consentCursor")) ?? "",
      _ = K,
      C = await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "gt", value: V },
          { column: "variant", op: "eq", value: "faces" },
        ],
        orderBy: { column: "target_id", dir: "asc" },
        limit: _,
        purpose: u,
      });
    for (let F of C.rows ?? []) {
      if (G.has(F.target_id)) continue;
      let W = await Qq(q, F.target_id);
      if (!W) {
        Q += 1;
        continue;
      }
      let w = await s(q, W, v);
      ((k += w.derived), (Q += w.skipped));
    }
    let Z = C.rows?.at(-1)?.target_id;
    if (Z) await q.state.set("consentCursor", Z);
    if ((C.rows?.length ?? 0) === _) B = !0;
  }
  if (X.length)
    await q.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: X },
      purpose: u,
    });
  if (k > 0)
    await q.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
      purpose: u,
    });
  return {
    summary: `faces derived ${k}; skipped ${Q}; consent queue batch ${J.rows?.length ?? 0}/${T}`,
    output: { derived: k, skipped: Q, drained: X.length, model: v, rearm: B },
  };
}
export { q0 as setFacesRuntimeForTests, Mq as default };
