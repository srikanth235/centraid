// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as zq } from "node:fs";
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
  p = F.join(b, "models");
function d(q, v) {
  let {
      stride: $,
      gridWidth: K,
      gridHeight: J,
      classScores: u,
      objectness: Q,
      boxes: k,
      landmarks: B,
    } = q,
    G = [];
  for (let V = 0; V < J; V++)
    for (let _ = 0; _ < K; _++) {
      let w = V * K + _,
        C = Math.max(0, Math.min(1, u[w] ?? 0)),
        X = Math.max(0, Math.min(1, Q[w] ?? 0)),
        W = Math.sqrt(C * X);
      if (W < v) continue;
      let L = k[w * 4] ?? 0,
        H = k[w * 4 + 1] ?? 0,
        Z = k[w * 4 + 2] ?? 0,
        A = k[w * 4 + 3] ?? 0,
        j = Math.exp(Z) * $,
        O = Math.exp(A) * $,
        R = (_ + L) * $,
        wq = (V + H) * $,
        S;
      if (B) {
        S = [];
        for (let z = 0; z < 5; z++) {
          let Cq = B[w * 10 + z * 2] ?? 0,
            Xq = B[w * 10 + z * 2 + 1] ?? 0;
          S.push({ x: (_ + Cq) * $, y: (V + Xq) * $ });
        }
      }
      G.push({
        box: { x: R - j / 2, y: wq - O / 2, width: j, height: O },
        score: W,
        landmarks: S,
      });
    }
  return G;
}
var n = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
function r(q, v) {
  if (q.length !== v.length || q.length === 0)
    throw Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  let $ = q.length,
    K = { x: 0, y: 0 },
    J = { x: 0, y: 0 };
  for (let Z = 0; Z < $; Z++)
    ((K.x += q[Z].x / $),
      (K.y += q[Z].y / $),
      (J.x += v[Z].x / $),
      (J.y += v[Z].y / $));
  let u = 0,
    Q = 0,
    k = 0,
    B = 0,
    G = 0;
  for (let Z = 0; Z < $; Z++) {
    let A = q[Z].x - K.x,
      j = q[Z].y - K.y,
      O = v[Z].x - J.x,
      R = v[Z].y - J.y;
    ((u += A * O),
      (Q += A * R),
      (k += j * O),
      (B += j * R),
      (G += A * A + j * j));
  }
  let V = Q - k,
    _ = u + B,
    w = Math.atan2(V, _),
    C = Math.hypot(_, V) / (G === 0 ? 1 : G),
    X = C * Math.cos(w),
    W = C * Math.sin(w),
    L = J.x - (X * K.x - W * K.y),
    H = J.y - (W * K.x + X * K.y);
  return { a: X, b: W, tx: L, ty: H };
}
function Hq(q, v) {
  return { x: q.a * v.x - q.b * v.y + q.tx, y: q.b * v.x + q.a * v.y + q.ty };
}
function o(q, v, $, K) {
  let J = v.a ** 2 + v.b ** 2,
    u =
      J === 0
        ? { a: 1, b: 0, tx: 0, ty: 0 }
        : {
            a: v.a / J,
            b: -v.b / J,
            tx: (-v.a * v.tx - v.b * v.ty) / J,
            ty: (v.b * v.tx - v.a * v.ty) / J,
          },
    Q = new Uint8Array($ * K * 3);
  for (let k = 0; k < K; k++)
    for (let B = 0; B < $; B++) {
      let G = Hq(u, { x: B, y: k }),
        V = Aq(q, G.x, G.y),
        _ = (k * $ + B) * 3;
      ((Q[_] = V[0]), (Q[_ + 1] = V[1]), (Q[_ + 2] = V[2]));
    }
  return { data: Q, width: $, height: K };
}
function Aq(q, v, $) {
  if (v < 0 || $ < 0 || v > q.width - 1 || $ > q.height - 1) return [0, 0, 0];
  let K = Math.floor(v),
    J = Math.floor($),
    u = Math.min(q.width - 1, K + 1),
    Q = Math.min(q.height - 1, J + 1),
    k = v - K,
    B = $ - J,
    G = (_, w, C) => q.data[(w * q.width + _) * 3 + C] ?? 0,
    V = [0, 0, 0];
  for (let _ = 0; _ < 3; _++) {
    let w = G(K, J, _) * (1 - k) + G(u, J, _) * k,
      C = G(K, Q, _) * (1 - k) + G(u, Q, _) * k;
    V[_] = Math.round(w * (1 - B) + C * B);
  }
  return V;
}
function i(q, v, $) {
  let K = $.width / v.width,
    J = $.height / v.height;
  return { x: q.x * K, y: q.y * J, width: q.width * K, height: q.height * J };
}
function t(q, v, $) {
  let K = Math.max(0, Math.min(v, Math.round(q.x))),
    J = Math.max(0, Math.min($, Math.round(q.y))),
    u = Math.max(K, Math.min(v, Math.round(q.x + q.width))),
    Q = Math.max(J, Math.min($, Math.round(q.y + q.height)));
  return [K, J, u - K, Q - J];
}
function a(q) {
  return Math.max(0, q.width) * Math.max(0, q.height);
}
function jq(q, v) {
  let $ = q.x + q.width,
    K = q.y + q.height,
    J = v.x + v.width,
    u = v.y + v.height,
    Q = Math.max(q.x, v.x),
    k = Math.max(q.y, v.y),
    B = Math.min($, J),
    G = Math.min(K, u),
    V = Math.max(0, B - Q),
    _ = Math.max(0, G - k),
    w = V * _;
  if (w <= 0) return 0;
  let C = a(q) + a(v) - w;
  return C <= 0 ? 0 : w / C;
}
function e(q, v) {
  let $ = [...q].sort((J, u) => u.score - J.score),
    K = [];
  for (let J of $)
    if (!K.some((Q) => jq(Q.box, J.box) > v.iouThreshold)) {
      if ((K.push(J), v.topK !== void 0 && K.length >= v.topK)) break;
    }
  return K;
}
import { existsSync as g, readFileSync as Yq, statSync as Oq } from "node:fs";
import N from "node:path";
import { pathToFileURL as Fq } from "node:url";
var M;
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
function m(q, v = b) {
  let $ = N.join(v, "node_modules");
  if (!g($)) throw new E(q);
  let K = N.join($, ...q.split("/"));
  try {
    let J = vq(K);
    if (J === null) throw Error(`no entry point in ${K}`);
    return J;
  } catch (J) {
    throw new E(q, J);
  }
}
function vq(q, v = 0) {
  let $ = N.join(q, "package.json"),
    K = g($) ? JSON.parse(Yq($, "utf8")) : {},
    J = [
      ...c(Uq(K.exports)),
      ...(typeof K.main === "string" ? [K.main] : []),
      "index.js",
    ];
  for (let u of J) {
    let Q = Pq(N.resolve(q, u), v);
    if (Q !== null) return Q;
  }
  return null;
}
function Pq(q, v) {
  let $ = qq(q);
  if ($?.isFile()) return q;
  if ($?.isDirectory()) return v >= 4 ? null : vq(q, v + 1);
  for (let K of [".js", ".json", ".node"]) {
    let J = `${q}${K}`;
    if (qq(J)?.isFile()) return J;
  }
  return null;
}
function qq(q) {
  try {
    return Oq(q);
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
function c(q, v = 0) {
  if (typeof q === "string") return [q];
  if (v > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap((J) => c(J, v + 1));
  let $ = q,
    K = [];
  for (let J of ["require", "node", "default"])
    if (J in $) K.push(...c($[J], v + 1));
  return K;
}
async function I() {
  if (M) return M;
  let q = m("onnxruntime-node");
  return ((M = await import(Fq(q).href)), M);
}
var D;
async function s(q) {
  D ??= new Map();
  let v = D.get(q);
  if (v) return v;
  if (!g(q)) throw new E(q);
  let $ = I().then((K) => K.InferenceSession.create(q));
  D.set(q, $);
  try {
    return await $;
  } catch (K) {
    throw (D.delete(q), K);
  }
}
import { pathToFileURL as Rq } from "node:url";
var y;
async function $q() {
  if (y) return y;
  let q = m("sharp");
  return ((y = (await import(Rq(q).href)).default), y);
}
async function Jq(q) {
  let $ = (await $q())(Buffer.from(q)),
    { data: K, info: J } = await $.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(K.buffer, K.byteOffset, K.byteLength),
    width: J.width,
    height: J.height,
  };
}
async function Kq(q, v, $) {
  let J = (await $q())(Buffer.from(q)),
    { data: u, info: Q } = await J.resize({ width: v, height: $, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(u.buffer, u.byteOffset, u.byteLength),
    width: Q.width,
    height: Q.height,
  };
}
function Qq(q) {
  let { width: v, height: $, data: K } = q,
    J = v * $,
    u = new Float32Array(J * 3);
  for (let Q = 0; Q < J; Q++)
    ((u[Q] = K[Q * 3 + 2] ?? 0),
      (u[J + Q] = K[Q * 3 + 1] ?? 0),
      (u[J * 2 + Q] = K[Q * 3] ?? 0));
  return u;
}
function uq(q) {
  let { width: v, height: $, data: K } = q,
    J = v * $,
    u = new Float32Array(J * 3);
  for (let Q = 0; Q < J; Q++)
    ((u[Q] = K[Q * 3] ?? 0),
      (u[J + Q] = K[Q * 3 + 1] ?? 0),
      (u[J * 2 + Q] = K[Q * 3 + 2] ?? 0));
  return u;
}
var _q = "yunet-sface@1",
  Gq = U.join(p, "faces"),
  Mq = U.join(Gq, "yunet.onnx"),
  Dq = U.join(Gq, "sface.onnx"),
  P = 640,
  Nq = [8, 16, 32],
  Eq = 0.6,
  Iq = 0.3,
  T = 112;
function h(q = p) {
  let v = U.join(q, "faces");
  return ["yunet.onnx", "sface.onnx"].every(($) => zq(U.join(v, $)));
}
async function yq(q, v) {
  let $ = await I(),
    K = await s(Mq),
    J = K.inputNames[0] ?? "input",
    u = await K.run({ [J]: new $.Tensor("float32", q, [1, 3, v, v]) }),
    Q = [];
  for (let G of Nq) {
    let V = v / G,
      _ = u[`cls_${G}`]?.data,
      w = u[`obj_${G}`]?.data,
      C = u[`bbox_${G}`]?.data,
      X = u[`kps_${G}`]?.data;
    if (!_ || !w || !C || !X)
      throw Error(`faces: YuNet output set is incomplete at stride ${G}`);
    Q.push(
      ...d(
        {
          stride: G,
          gridWidth: V,
          gridHeight: V,
          classScores: _,
          objectness: w,
          boxes: C,
          landmarks: X,
        },
        Eq
      )
    );
  }
  let k = e(
      Q.map((G) => ({ box: G.box, score: G.score })),
      { iouThreshold: Iq, topK: 20 }
    ),
    B = new Set(k.map((G) => G.box));
  return Q.filter((G) => B.has(G.box));
}
async function Tq(q) {
  let v = await I(),
    $ = await s(Dq),
    K = $.inputNames[0] ?? "data",
    J = await $.run({ [K]: new v.Tensor("float32", q, [1, 3, T, T]) }),
    u = $.outputNames[0],
    Q = u ? J[u]?.data : void 0;
  if (!Q || !(Q instanceof Float32Array))
    throw Error("faces: SFace did not return a float32 embedding");
  return Array.from(Q);
}
async function l(q) {
  try {
    let v = Buffer.from(q.bytes, "base64"),
      $ = await Jq(v),
      K = await Kq(v, P, P),
      J = Qq(K),
      u = await yq(J, P),
      Q = $.width / P,
      k = $.height / P,
      B =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: $.width, height: $.height },
      V = (
        await Promise.all(
          u
            .filter((_) => _.landmarks)
            .map(async (_) => {
              let C = _.landmarks.map((j) => ({ x: j.x * Q, y: j.y * k })),
                X = r(C, n),
                W = o($, X, T, T),
                L = uq(W),
                H = await Tq(L),
                Z = {
                  x: _.box.x * Q,
                  y: _.box.y * k,
                  width: _.box.width * Q,
                  height: _.box.height * k,
                },
                A = t(i(Z, $, B), B.width, B.height);
              if (A[2] <= 0 || A[3] <= 0) return;
              return { box: A, confidence: _.score, embedding: H };
            })
        )
      ).filter((_) => _ !== void 0);
    return { id: q.id, faces: V };
  } catch (v) {
    return { id: q.id, error: v instanceof Error ? v.message : String(v) };
  }
}
var f = 16,
  kq = l,
  Bq = h;
function _0(q) {
  ((kq = q?.infer ?? l), (Bq = q?.weightsPresent ?? h));
}
function fq() {
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
async function x(q, v, $) {
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
  let u = await kq({
    id: v.asset_id,
    bytes: J.base64,
    mediaType: J.mediaType,
    originalWidth: v.width,
    originalHeight: v.height,
  });
  if (!u || u.error || !Array.isArray(u.faces))
    throw Error(
      u?.error ?? `asset ${v.asset_id}: face detector returned no result`
    );
  return (
    await q.vault.invoke({
      command: "enrich.upsert_faces",
      input: { asset_id: v.asset_id, model: $, faces: u.faces },
    }),
    { settled: !0, derived: 1, skipped: 0 }
  );
}
async function Sq(q, v) {
  let $ = await q.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
  });
  return $.rows?.[0]?.model === v ? $.rows[0].target_id : "";
}
async function bq({ ctx: q }) {
  let v = fq();
  if (!v)
    return { summary: "faces skipped — automation model assets unavailable" };
  let $ = await q.state.get("model");
  if ($ !== v)
    (await q.state.set("consentCursor", $ === void 0 ? await Sq(q, v) : ""),
      await q.state.set("model", v));
  let K = await q.vault.read({
      entity: "enrich.request",
      where: [
        { column: "capability", op: "eq", value: "faces" },
        { column: "drained_at", op: "is-null" },
      ],
      orderBy: { column: "request_id", dir: "asc" },
      limit: f,
    }),
    J = 0,
    u = 0,
    Q = f,
    k = (K.rows?.length ?? 0) === f,
    B = [],
    G = new Set();
  for (let V of K.rows ?? []) {
    if (Q === 0) {
      k = !0;
      break;
    }
    if (V.target_id) {
      let L = await Vq(q, V.target_id);
      if (!L) {
        ((u += 1), B.push(V.request_id), (Q -= 1));
        continue;
      }
      let H = await x(q, L, v);
      if (
        (G.add(L.asset_id),
        (J += H.derived),
        (u += H.skipped),
        (Q -= 1),
        H.settled)
      )
        B.push(V.request_id);
      continue;
    }
    let _ = `requestCursor:${V.request_id}`,
      w = (await q.state.get(_)) ?? "",
      C = Q,
      X = await q.vault.read({
        entity: "media.asset",
        where: [
          { column: "asset_id", op: "gt", value: w },
          { column: "kind", op: "in", value: ["photo", "scan"] },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "asset_id", dir: "asc" },
        limit: C,
      });
    for (let L of X.rows ?? []) {
      let H = await x(q, L, v);
      (G.add(L.asset_id), (J += H.derived), (u += H.skipped), (Q -= 1));
    }
    let W = X.rows?.at(-1)?.asset_id;
    if (W) await q.state.set(_, W);
    if ((X.rows?.length ?? 0) < C) B.push(V.request_id);
    else k = !0;
  }
  if (Q > 0) {
    let V = (await q.state.get("consentCursor")) ?? "",
      _ = Q,
      w = await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "gt", value: V },
          { column: "variant", op: "eq", value: "faces" },
        ],
        orderBy: { column: "target_id", dir: "asc" },
        limit: _,
      });
    for (let X of w.rows ?? []) {
      if (G.has(X.target_id)) continue;
      let W = await Vq(q, X.target_id);
      if (!W) {
        u += 1;
        continue;
      }
      let L = await x(q, W, v);
      ((J += L.derived), (u += L.skipped));
    }
    let C = w.rows?.at(-1)?.target_id;
    if (C) await q.state.set("consentCursor", C);
    if ((w.rows?.length ?? 0) === _) k = !0;
  }
  if (B.length)
    await q.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: B },
    });
  if (J > 0)
    await q.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
    });
  return {
    summary: `faces derived ${J}; skipped ${u}; consent queue batch ${K.rows?.length ?? 0}/${f}`,
    output: { derived: J, skipped: u, drained: B.length, model: v, rearm: k },
  };
}
export { _0 as setFacesRuntimeForTests, bq as default };
