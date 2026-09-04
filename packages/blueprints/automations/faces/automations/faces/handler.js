// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as Rq } from "node:fs";
import U from "node:path";
import F from "node:path";
var Zq = F.resolve(import.meta.dirname, ".."),
  Lq = "__centraidAutomationRuntimeDir";
function Wq() {
  let q = globalThis[Lq];
  if (typeof q === "string" && q.length > 0) return F.resolve(q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return F.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return F.join(Zq, "runtime");
}
var b = Wq(),
  S = F.join(b, "models");
function x(q, v) {
  let {
      stride: $,
      gridWidth: K,
      gridHeight: J,
      classScores: _,
      objectness: Q,
      boxes: B,
      landmarks: w,
    } = q,
    V = [];
  for (let k = 0; k < J; k++)
    for (let G = 0; G < K; G++) {
      let C = k * K + G,
        X = Math.max(0, Math.min(1, _[C] ?? 0)),
        Z = Math.max(0, Math.min(1, Q[C] ?? 0)),
        u = Math.sqrt(X * Z);
      if (u < v) continue;
      let W = B[C * 4] ?? 0,
        H = B[C * 4 + 1] ?? 0,
        L = B[C * 4 + 2] ?? 0,
        A = B[C * 4 + 3] ?? 0,
        j = Math.exp(L) * $,
        Y = Math.exp(A) * $,
        P = (G + W) * $,
        wq = (k + H) * $,
        f;
      if (w) {
        f = [];
        for (let R = 0; R < 5; R++) {
          let Cq = w[C * 10 + R * 2] ?? 0,
            Xq = w[C * 10 + R * 2 + 1] ?? 0;
          f.push({ x: (G + Cq) * $, y: (k + Xq) * $ });
        }
      }
      V.push({
        box: { x: P - j / 2, y: wq - Y / 2, width: j, height: Y },
        score: u,
        landmarks: f,
      });
    }
  return V;
}
var d = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
function n(q, v) {
  if (q.length !== v.length || q.length === 0)
    throw Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  let $ = q.length,
    K = { x: 0, y: 0 },
    J = { x: 0, y: 0 };
  for (let L = 0; L < $; L++)
    ((K.x += q[L].x / $),
      (K.y += q[L].y / $),
      (J.x += v[L].x / $),
      (J.y += v[L].y / $));
  let _ = 0,
    Q = 0,
    B = 0,
    w = 0,
    V = 0;
  for (let L = 0; L < $; L++) {
    let A = q[L].x - K.x,
      j = q[L].y - K.y,
      Y = v[L].x - J.x,
      P = v[L].y - J.y;
    ((_ += A * Y),
      (Q += A * P),
      (B += j * Y),
      (w += j * P),
      (V += A * A + j * j));
  }
  let k = Q - B,
    G = _ + w,
    C = Math.atan2(k, G),
    X = Math.hypot(G, k) / (V === 0 ? 1 : V),
    Z = X * Math.cos(C),
    u = X * Math.sin(C),
    W = J.x - (Z * K.x - u * K.y),
    H = J.y - (u * K.x + Z * K.y);
  return { a: Z, b: u, tx: W, ty: H };
}
function uq(q, v) {
  return { x: q.a * v.x - q.b * v.y + q.tx, y: q.b * v.x + q.a * v.y + q.ty };
}
function r(q, v, $, K) {
  let J = v.a ** 2 + v.b ** 2,
    _ =
      J === 0
        ? { a: 1, b: 0, tx: 0, ty: 0 }
        : {
            a: v.a / J,
            b: -v.b / J,
            tx: (-v.a * v.tx - v.b * v.ty) / J,
            ty: (v.b * v.tx - v.a * v.ty) / J,
          },
    Q = new Uint8Array($ * K * 3);
  for (let B = 0; B < K; B++)
    for (let w = 0; w < $; w++) {
      let V = uq(_, { x: w, y: B }),
        k = Hq(q, V.x, V.y),
        G = (B * $ + w) * 3;
      ((Q[G] = k[0]), (Q[G + 1] = k[1]), (Q[G + 2] = k[2]));
    }
  return { data: Q, width: $, height: K };
}
function Hq(q, v, $) {
  if (v < 0 || $ < 0 || v > q.width - 1 || $ > q.height - 1) return [0, 0, 0];
  let K = Math.floor(v),
    J = Math.floor($),
    _ = Math.min(q.width - 1, K + 1),
    Q = Math.min(q.height - 1, J + 1),
    B = v - K,
    w = $ - J,
    V = (G, C, X) => q.data[(C * q.width + G) * 3 + X] ?? 0,
    k = [0, 0, 0];
  for (let G = 0; G < 3; G++) {
    let C = V(K, J, G) * (1 - B) + V(_, J, G) * B,
      X = V(K, Q, G) * (1 - B) + V(_, Q, G) * B;
    k[G] = Math.round(C * (1 - w) + X * w);
  }
  return k;
}
function o(q, v, $) {
  let K = $.width / v.width,
    J = $.height / v.height;
  return { x: q.x * K, y: q.y * J, width: q.width * K, height: q.height * J };
}
function i(q, v, $) {
  let K = Math.max(0, Math.min(v, Math.round(q.x))),
    J = Math.max(0, Math.min($, Math.round(q.y))),
    _ = Math.max(K, Math.min(v, Math.round(q.x + q.width))),
    Q = Math.max(J, Math.min($, Math.round(q.y + q.height)));
  return [K, J, _ - K, Q - J];
}
function t(q) {
  return Math.max(0, q.width) * Math.max(0, q.height);
}
function Aq(q, v) {
  let $ = q.x + q.width,
    K = q.y + q.height,
    J = v.x + v.width,
    _ = v.y + v.height,
    Q = Math.max(q.x, v.x),
    B = Math.max(q.y, v.y),
    w = Math.min($, J),
    V = Math.min(K, _),
    k = Math.max(0, w - Q),
    G = Math.max(0, V - B),
    C = k * G;
  if (C <= 0) return 0;
  let X = t(q) + t(v) - C;
  return X <= 0 ? 0 : C / X;
}
function a(q, v) {
  let $ = [...q].sort((J, _) => _.score - J.score),
    K = [];
  for (let J of $)
    if (!K.some((Q) => Aq(Q.box, J.box) > v.iouThreshold)) {
      if ((K.push(J), v.topK !== void 0 && K.length >= v.topK)) break;
    }
  return K;
}
import { existsSync as m, readFileSync as jq, statSync as Yq } from "node:fs";
import D from "node:path";
import { pathToFileURL as Fq } from "node:url";
var z;
class N extends Error {
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
function c(q, v = b) {
  let $ = D.join(v, "node_modules");
  if (!m($)) throw new N(q);
  let K = D.join($, ...q.split("/"));
  try {
    let J = qq(K);
    if (J === null) throw Error(`no entry point in ${K}`);
    return J;
  } catch (J) {
    throw new N(q, J);
  }
}
function qq(q, v = 0) {
  let $ = D.join(q, "package.json"),
    K = m($) ? JSON.parse(jq($, "utf8")) : {},
    J = [
      ...g(Uq(K.exports)),
      ...(typeof K.main === "string" ? [K.main] : []),
      "index.js",
    ];
  for (let _ of J) {
    let Q = Oq(D.resolve(q, _), v);
    if (Q !== null) return Q;
  }
  return null;
}
function Oq(q, v) {
  let $ = e(q);
  if ($?.isFile()) return q;
  if ($?.isDirectory()) return v >= 4 ? null : qq(q, v + 1);
  for (let K of [".js", ".json", ".node"]) {
    let J = `${q}${K}`;
    if (e(J)?.isFile()) return J;
  }
  return null;
}
function e(q) {
  try {
    return Yq(q);
  } catch {
    return null;
  }
}
function Uq(q) {
  if (typeof q === "string") return q;
  if (q === null || typeof q !== "object") return;
  let v = q;
  return "." in v ? v["."] : v;
}
function g(q, v = 0) {
  if (typeof q === "string") return [q];
  if (v > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap((J) => g(J, v + 1));
  let $ = q,
    K = [];
  for (let J of ["require", "node", "default"])
    if (J in $) K.push(...g($[J], v + 1));
  return K;
}
async function E() {
  if (z) return z;
  let q = c("onnxruntime-node");
  return ((z = await import(Fq(q).href)), z);
}
var M;
async function p(q) {
  M ??= new Map();
  let v = M.get(q);
  if (v) return v;
  if (!m(q)) throw new N(q);
  let $ = E().then((K) => K.InferenceSession.create(q));
  M.set(q, $);
  try {
    return await $;
  } catch (K) {
    throw (M.delete(q), K);
  }
}
import { pathToFileURL as Pq } from "node:url";
var I;
async function vq() {
  if (I) return I;
  let q = c("sharp");
  return ((I = (await import(Pq(q).href)).default), I);
}
async function $q(q) {
  let $ = (await vq())(Buffer.from(q)),
    { data: K, info: J } = await $.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(K.buffer, K.byteOffset, K.byteLength),
    width: J.width,
    height: J.height,
  };
}
async function Jq(q, v, $) {
  let J = (await vq())(Buffer.from(q)),
    { data: _, info: Q } = await J.resize({ width: v, height: $, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(_.buffer, _.byteOffset, _.byteLength),
    width: Q.width,
    height: Q.height,
  };
}
function Kq(q) {
  let { width: v, height: $, data: K } = q,
    J = v * $,
    _ = new Float32Array(J * 3);
  for (let Q = 0; Q < J; Q++)
    ((_[Q] = K[Q * 3 + 2] ?? 0),
      (_[J + Q] = K[Q * 3 + 1] ?? 0),
      (_[J * 2 + Q] = K[Q * 3] ?? 0));
  return _;
}
function Qq(q) {
  let { width: v, height: $, data: K } = q,
    J = v * $,
    _ = new Float32Array(J * 3);
  for (let Q = 0; Q < J; Q++)
    ((_[Q] = K[Q * 3] ?? 0),
      (_[J + Q] = K[Q * 3 + 1] ?? 0),
      (_[J * 2 + Q] = K[Q * 3 + 2] ?? 0));
  return _;
}
var _q = "yunet-sface@1",
  Gq = U.join(S, "faces"),
  zq = U.join(Gq, "yunet.onnx"),
  Mq = U.join(Gq, "sface.onnx"),
  O = 640,
  Dq = [8, 16, 32],
  Nq = 0.6,
  Eq = 0.3,
  y = 112;
function h(q = S) {
  let v = U.join(q, "faces");
  return ["yunet.onnx", "sface.onnx"].every(($) => Rq(U.join(v, $)));
}
async function Iq(q, v) {
  let $ = await E(),
    K = await p(zq),
    J = K.inputNames[0] ?? "input",
    _ = await K.run({ [J]: new $.Tensor("float32", q, [1, 3, v, v]) }),
    Q = [];
  for (let V of Dq) {
    let k = v / V,
      G = _[`cls_${V}`]?.data,
      C = _[`obj_${V}`]?.data,
      X = _[`bbox_${V}`]?.data,
      Z = _[`kps_${V}`]?.data;
    if (!G || !C || !X || !Z)
      throw Error(`faces: YuNet output set is incomplete at stride ${V}`);
    Q.push(
      ...x(
        {
          stride: V,
          gridWidth: k,
          gridHeight: k,
          classScores: G,
          objectness: C,
          boxes: X,
          landmarks: Z,
        },
        Nq
      )
    );
  }
  let B = a(
      Q.map((V) => ({ box: V.box, score: V.score })),
      { iouThreshold: Eq, topK: 20 }
    ),
    w = new Set(B.map((V) => V.box));
  return Q.filter((V) => w.has(V.box));
}
async function yq(q) {
  let v = await E(),
    $ = await p(Mq),
    K = $.inputNames[0] ?? "data",
    J = await $.run({ [K]: new v.Tensor("float32", q, [1, 3, y, y]) }),
    _ = $.outputNames[0],
    Q = _ ? J[_]?.data : void 0;
  if (!Q || !(Q instanceof Float32Array))
    throw Error("faces: SFace did not return a float32 embedding");
  return Array.from(Q);
}
async function s(q) {
  try {
    let v = Buffer.from(q.bytes, "base64"),
      $ = await $q(v),
      K = await Jq(v, O, O),
      J = Kq(K),
      _ = await Iq(J, O),
      Q = $.width / O,
      B = $.height / O,
      w =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: $.width, height: $.height },
      k = (
        await Promise.all(
          _.filter((G) => G.landmarks).map(async (G) => {
            let X = G.landmarks.map((j) => ({ x: j.x * Q, y: j.y * B })),
              Z = n(X, d),
              u = r($, Z, y, y),
              W = Qq(u),
              H = await yq(W),
              L = {
                x: G.box.x * Q,
                y: G.box.y * B,
                width: G.box.width * Q,
                height: G.box.height * B,
              },
              A = i(o(L, $, w), w.width, w.height);
            if (A[2] <= 0 || A[3] <= 0) return;
            return { box: A, confidence: G.score, embedding: H };
          })
        )
      ).filter((G) => G !== void 0);
    return { id: q.id, faces: k };
  } catch (v) {
    return { id: q.id, error: v instanceof Error ? v.message : String(v) };
  }
}
var T = 16,
  kq = s,
  Bq = h;
function _0(q) {
  ((kq = q?.infer ?? s), (Bq = q?.weightsPresent ?? h));
}
function Tq() {
  return Bq() ? _q : null;
}
async function Vq(q, v) {
  return (
    await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "eq", value: v },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 1,
    })
  ).rows?.[0];
}
async function l(q, v, $) {
  if (
    (
      await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "eq", value: v.asset_id },
          { column: "variant", op: "eq", value: "faces" },
        ],
        limit: 1,
      })
    ).rows?.[0]?.model === $
  )
    return { settled: !0, derived: 0, skipped: 1 };
  let J = await q.vault.content({
    contentId: v.content_id,
    variant: "preview",
    maxBytes: 4194304,
  });
  if (J?.status !== "ok" || J.kind !== "bytes")
    throw Error(`asset ${v.asset_id}: preview is unavailable`);
  let _ = await kq({
    id: v.asset_id,
    bytes: J.base64,
    mediaType: J.mediaType,
    originalWidth: v.width,
    originalHeight: v.height,
  });
  if (!_ || _.error || !Array.isArray(_.faces))
    throw Error(
      _?.error ?? `asset ${v.asset_id}: face detector returned no result`
    );
  return (
    await q.vault.invoke({
      command: "enrich.upsert_faces",
      input: { asset_id: v.asset_id, model: $, faces: _.faces },
    }),
    { settled: !0, derived: 1, skipped: 0 }
  );
}
async function fq(q, v) {
  let $ = await q.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
  });
  return $.rows?.[0]?.model === v ? $.rows[0].target_id : "";
}
async function bq({ ctx: q }) {
  let v = Tq();
  if (!v)
    return { summary: "faces skipped — automation model assets unavailable" };
  let $ = await q.state.get("model");
  if ($ !== v)
    (await q.state.set("consentCursor", $ === void 0 ? await fq(q, v) : ""),
      await q.state.set("model", v));
  let K = await q.vault.read({
      entity: "enrich.request",
      where: [
        { column: "capability", op: "eq", value: "faces" },
        { column: "drained_at", op: "is-null" },
      ],
      orderBy: { column: "request_id", dir: "asc" },
      limit: T,
    }),
    J = 0,
    _ = 0,
    Q = T,
    B = (K.rows?.length ?? 0) === T,
    w = [],
    V = new Set();
  for (let k of K.rows ?? []) {
    if (Q === 0) {
      B = !0;
      break;
    }
    if (k.target_id) {
      let W = await Vq(q, k.target_id);
      if (!W) {
        ((_ += 1), w.push(k.request_id), (Q -= 1));
        continue;
      }
      let H = await l(q, W, v);
      if (
        (V.add(W.asset_id),
        (J += H.derived),
        (_ += H.skipped),
        (Q -= 1),
        H.settled)
      )
        w.push(k.request_id);
      continue;
    }
    let G = `requestCursor:${k.request_id}`,
      C = (await q.state.get(G)) ?? "",
      X = Q,
      Z = await q.vault.read({
        entity: "media.asset",
        where: [
          { column: "asset_id", op: "gt", value: C },
          { column: "kind", op: "in", value: ["photo", "scan"] },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "asset_id", dir: "asc" },
        limit: X,
      });
    for (let W of Z.rows ?? []) {
      let H = await l(q, W, v);
      (V.add(W.asset_id), (J += H.derived), (_ += H.skipped), (Q -= 1));
    }
    let u = Z.rows?.at(-1)?.asset_id;
    if (u) await q.state.set(G, u);
    if ((Z.rows?.length ?? 0) < X) w.push(k.request_id);
    else B = !0;
  }
  if (Q > 0) {
    let k = (await q.state.get("consentCursor")) ?? "",
      G = Q,
      C = await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "gt", value: k },
          { column: "variant", op: "eq", value: "faces" },
        ],
        orderBy: { column: "target_id", dir: "asc" },
        limit: G,
      });
    for (let Z of C.rows ?? []) {
      if (V.has(Z.target_id)) continue;
      let u = await Vq(q, Z.target_id);
      if (!u) {
        _ += 1;
        continue;
      }
      let W = await l(q, u, v);
      ((J += W.derived), (_ += W.skipped));
    }
    let X = C.rows?.at(-1)?.target_id;
    if (X) await q.state.set("consentCursor", X);
    if ((C.rows?.length ?? 0) === G) B = !0;
  }
  if (w.length)
    await q.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: w },
    });
  if (J > 0)
    await q.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
    });
  return {
    summary: `faces derived ${J}; skipped ${_}; consent queue batch ${K.rows?.length ?? 0}/${T}`,
    output: { derived: J, skipped: _, drained: w.length, model: v, rearm: B },
  };
}
export { _0 as setFacesRuntimeForTests, bq as default };
