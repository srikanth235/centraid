// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as Pq } from "node:fs";
import U from "node:path";
import z from "node:path";
var Wq = z.resolve(import.meta.dirname, ".."),
  b = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? z.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : z.join(Wq, "runtime"),
  p = z.join(b, "models");
function d(q, $) {
  let {
      stride: v,
      gridWidth: K,
      gridHeight: J,
      classScores: _,
      objectness: Q,
      boxes: k,
      landmarks: X,
    } = q,
    V = [];
  for (let B = 0; B < J; B++)
    for (let G = 0; G < K; G++) {
      let C = B * K + G,
        Z = Math.max(0, Math.min(1, _[C] ?? 0)),
        L = Math.max(0, Math.min(1, Q[C] ?? 0)),
        H = Math.sqrt(Z * L);
      if (H < $) continue;
      let w = k[C * 4] ?? 0,
        j = k[C * 4 + 1] ?? 0,
        W = k[C * 4 + 2] ?? 0,
        A = k[C * 4 + 3] ?? 0,
        Y = Math.exp(W) * v,
        u = Math.exp(A) * v,
        P = (G + w) * v,
        Cq = (B + j) * v,
        S;
      if (X) {
        S = [];
        for (let R = 0; R < 5; R++) {
          let Zq = X[C * 10 + R * 2] ?? 0,
            Lq = X[C * 10 + R * 2 + 1] ?? 0;
          S.push({ x: (G + Zq) * v, y: (B + Lq) * v });
        }
      }
      V.push({
        box: { x: P - Y / 2, y: Cq - u / 2, width: Y, height: u },
        score: H,
        landmarks: S,
      });
    }
  return V;
}
var n = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
function r(q, $) {
  if (q.length !== $.length || q.length === 0)
    throw Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  let v = q.length,
    K = { x: 0, y: 0 },
    J = { x: 0, y: 0 };
  for (let W = 0; W < v; W++)
    ((K.x += q[W].x / v),
      (K.y += q[W].y / v),
      (J.x += $[W].x / v),
      (J.y += $[W].y / v));
  let _ = 0,
    Q = 0,
    k = 0,
    X = 0,
    V = 0;
  for (let W = 0; W < v; W++) {
    let A = q[W].x - K.x,
      Y = q[W].y - K.y,
      u = $[W].x - J.x,
      P = $[W].y - J.y;
    ((_ += A * u),
      (Q += A * P),
      (k += Y * u),
      (X += Y * P),
      (V += A * A + Y * Y));
  }
  let B = Q - k,
    G = _ + X,
    C = Math.atan2(B, G),
    Z = Math.hypot(G, B) / (V === 0 ? 1 : V),
    L = Z * Math.cos(C),
    H = Z * Math.sin(C),
    w = J.x - (L * K.x - H * K.y),
    j = J.y - (H * K.x + L * K.y);
  return { a: L, b: H, tx: w, ty: j };
}
function wq(q, $) {
  return { x: q.a * $.x - q.b * $.y + q.tx, y: q.b * $.x + q.a * $.y + q.ty };
}
function o(q, $, v, K) {
  let J = $.a ** 2 + $.b ** 2,
    _ =
      J === 0
        ? { a: 1, b: 0, tx: 0, ty: 0 }
        : {
            a: $.a / J,
            b: -$.b / J,
            tx: (-$.a * $.tx - $.b * $.ty) / J,
            ty: ($.b * $.tx - $.a * $.ty) / J,
          },
    Q = new Uint8Array(v * K * 3);
  for (let k = 0; k < K; k++)
    for (let X = 0; X < v; X++) {
      let V = wq(_, { x: X, y: k }),
        B = Hq(q, V.x, V.y),
        G = (k * v + X) * 3;
      ((Q[G] = B[0]), (Q[G + 1] = B[1]), (Q[G + 2] = B[2]));
    }
  return { data: Q, width: v, height: K };
}
function Hq(q, $, v) {
  if ($ < 0 || v < 0 || $ > q.width - 1 || v > q.height - 1) return [0, 0, 0];
  let K = Math.floor($),
    J = Math.floor(v),
    _ = Math.min(q.width - 1, K + 1),
    Q = Math.min(q.height - 1, J + 1),
    k = $ - K,
    X = v - J,
    V = (G, C, Z) => q.data[(C * q.width + G) * 3 + Z] ?? 0,
    B = [0, 0, 0];
  for (let G = 0; G < 3; G++) {
    let C = V(K, J, G) * (1 - k) + V(_, J, G) * k,
      Z = V(K, Q, G) * (1 - k) + V(_, Q, G) * k;
    B[G] = Math.round(C * (1 - X) + Z * X);
  }
  return B;
}
function i(q, $, v) {
  let K = v.width / $.width,
    J = v.height / $.height;
  return { x: q.x * K, y: q.y * J, width: q.width * K, height: q.height * J };
}
function t(q, $, v) {
  let K = Math.max(0, Math.min($, Math.round(q.x))),
    J = Math.max(0, Math.min(v, Math.round(q.y))),
    _ = Math.max(K, Math.min($, Math.round(q.x + q.width))),
    Q = Math.max(J, Math.min(v, Math.round(q.y + q.height)));
  return [K, J, _ - K, Q - J];
}
function a(q) {
  return Math.max(0, q.width) * Math.max(0, q.height);
}
function jq(q, $) {
  let v = q.x + q.width,
    K = q.y + q.height,
    J = $.x + $.width,
    _ = $.y + $.height,
    Q = Math.max(q.x, $.x),
    k = Math.max(q.y, $.y),
    X = Math.min(v, J),
    V = Math.min(K, _),
    B = Math.max(0, X - Q),
    G = Math.max(0, V - k),
    C = B * G;
  if (C <= 0) return 0;
  let Z = a(q) + a($) - C;
  return Z <= 0 ? 0 : C / Z;
}
function e(q, $) {
  let v = [...q].sort((J, _) => _.score - J.score),
    K = [];
  for (let J of v)
    if (!K.some((Q) => jq(Q.box, J.box) > $.iouThreshold)) {
      if ((K.push(J), $.topK !== void 0 && K.length >= $.topK)) break;
    }
  return K;
}
import { existsSync as m, readFileSync as Aq, statSync as Yq } from "node:fs";
import N from "node:path";
import { pathToFileURL as Oq } from "node:url";
var M;
class E extends Error {
  constructor(q, $) {
    super(
      `Automation model runtime dependency "${q}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: $ }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function c(q, $ = b) {
  let v = N.join($, "node_modules");
  if (!m(v)) throw new E(q);
  let K = N.join(v, ...q.split("/"));
  try {
    let J = $q(K);
    if (J === null) throw Error(`no entry point in ${K}`);
    return J;
  } catch (J) {
    throw new E(q, J);
  }
}
function $q(q, $ = 0) {
  let v = N.join(q, "package.json"),
    K = m(v) ? JSON.parse(Aq(v, "utf8")) : {},
    J = [
      ...g(Fq(K.exports)),
      ...(typeof K.main === "string" ? [K.main] : []),
      "index.js",
    ];
  for (let _ of J) {
    let Q = uq(N.resolve(q, _), $);
    if (Q !== null) return Q;
  }
  return null;
}
function uq(q, $) {
  let v = qq(q);
  if (v?.isFile()) return q;
  if (v?.isDirectory()) return $ >= 4 ? null : $q(q, $ + 1);
  for (let K of [".js", ".json", ".node"]) {
    let J = `${q}${K}`;
    if (qq(J)?.isFile()) return J;
  }
  return null;
}
function qq(q) {
  try {
    return Yq(q);
  } catch {
    return null;
  }
}
function Fq(q) {
  if (typeof q === "string") return q;
  if (q === null || typeof q !== "object") return;
  let $ = q;
  return "." in $ ? $["."] : $;
}
function g(q, $ = 0) {
  if (typeof q === "string") return [q];
  if ($ > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap((J) => g(J, $ + 1));
  let v = q,
    K = [];
  for (let J of ["require", "node", "default"])
    if (J in v) K.push(...g(v[J], $ + 1));
  return K;
}
async function I() {
  if (M) return M;
  let q = c("onnxruntime-node");
  return ((M = await import(Oq(q).href)), M);
}
var D;
async function h(q) {
  D ??= new Map();
  let $ = D.get(q);
  if ($) return $;
  if (!m(q)) throw new E(q);
  let v = I().then((K) => K.InferenceSession.create(q));
  D.set(q, v);
  try {
    return await v;
  } catch (K) {
    throw (D.delete(q), K);
  }
}
import { pathToFileURL as Uq } from "node:url";
var y;
async function vq() {
  if (y) return y;
  let q = c("sharp");
  return ((y = (await import(Uq(q).href)).default), y);
}
async function Jq(q) {
  let v = (await vq())(Buffer.from(q)),
    { data: K, info: J } = await v
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(K.buffer, K.byteOffset, K.byteLength),
    width: J.width,
    height: J.height,
  };
}
async function Kq(q, $, v) {
  let J = (await vq())(Buffer.from(q)),
    { data: _, info: Q } = await J.resize({ width: $, height: v, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(_.buffer, _.byteOffset, _.byteLength),
    width: Q.width,
    height: Q.height,
  };
}
function Qq(q) {
  let { width: $, height: v, data: K } = q,
    J = $ * v,
    _ = new Float32Array(J * 3);
  for (let Q = 0; Q < J; Q++)
    ((_[Q] = K[Q * 3 + 2] ?? 0),
      (_[J + Q] = K[Q * 3 + 1] ?? 0),
      (_[J * 2 + Q] = K[Q * 3] ?? 0));
  return _;
}
function _q(q) {
  let { width: $, height: v, data: K } = q,
    J = $ * v,
    _ = new Float32Array(J * 3);
  for (let Q = 0; Q < J; Q++)
    ((_[Q] = K[Q * 3] ?? 0),
      (_[J + Q] = K[Q * 3 + 1] ?? 0),
      (_[J * 2 + Q] = K[Q * 3 + 2] ?? 0));
  return _;
}
var Gq = "yunet-sface@1",
  Vq = U.join(p, "faces"),
  Rq = U.join(Vq, "yunet.onnx"),
  zq = U.join(Vq, "sface.onnx"),
  F = 640,
  Mq = [8, 16, 32],
  Dq = 0.6,
  Nq = 0.3,
  T = 112;
function l(q = p) {
  let $ = U.join(q, "faces");
  return ["yunet.onnx", "sface.onnx"].every((v) => Pq(U.join($, v)));
}
async function Eq(q, $) {
  let v = await I(),
    K = await h(Rq),
    J = K.inputNames[0] ?? "input",
    _ = await K.run({ [J]: new v.Tensor("float32", q, [1, 3, $, $]) }),
    Q = [];
  for (let V of Mq) {
    let B = $ / V,
      G = _[`cls_${V}`]?.data,
      C = _[`obj_${V}`]?.data,
      Z = _[`bbox_${V}`]?.data,
      L = _[`kps_${V}`]?.data;
    if (!G || !C || !Z || !L)
      throw Error(`faces: YuNet output set is incomplete at stride ${V}`);
    Q.push(
      ...d(
        {
          stride: V,
          gridWidth: B,
          gridHeight: B,
          classScores: G,
          objectness: C,
          boxes: Z,
          landmarks: L,
        },
        Dq
      )
    );
  }
  let k = e(
      Q.map((V) => ({ box: V.box, score: V.score })),
      { iouThreshold: Nq, topK: 20 }
    ),
    X = new Set(k.map((V) => V.box));
  return Q.filter((V) => X.has(V.box));
}
async function Iq(q) {
  let $ = await I(),
    v = await h(zq),
    K = v.inputNames[0] ?? "data",
    J = await v.run({ [K]: new $.Tensor("float32", q, [1, 3, T, T]) }),
    _ = v.outputNames[0],
    Q = _ ? J[_]?.data : void 0;
  if (!Q || !(Q instanceof Float32Array))
    throw Error("faces: SFace did not return a float32 embedding");
  return Array.from(Q);
}
async function s(q) {
  try {
    let $ = Buffer.from(q.bytes, "base64"),
      v = await Jq($),
      K = await Kq($, F, F),
      J = Qq(K),
      _ = await Eq(J, F),
      Q = v.width / F,
      k = v.height / F,
      X =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: v.width, height: v.height },
      B = (
        await Promise.all(
          _.filter((G) => G.landmarks).map(async (G) => {
            let Z = G.landmarks.map((Y) => ({ x: Y.x * Q, y: Y.y * k })),
              L = r(Z, n),
              H = o(v, L, T, T),
              w = _q(H),
              j = await Iq(w),
              W = {
                x: G.box.x * Q,
                y: G.box.y * k,
                width: G.box.width * Q,
                height: G.box.height * k,
              },
              A = t(i(W, v, X), X.width, X.height);
            if (A[2] <= 0 || A[3] <= 0) return;
            return { box: A, confidence: G.score, embedding: j };
          })
        )
      ).filter((G) => G !== void 0);
    return { id: q.id, faces: B };
  } catch ($) {
    return { id: q.id, error: $ instanceof Error ? $.message : String($) };
  }
}
var f = 16,
  O = "dpv:ServiceProvision",
  kq = s,
  Xq = l;
function Q0(q) {
  ((kq = q?.infer ?? s), (Xq = q?.weightsPresent ?? l));
}
function yq() {
  return Xq() ? Gq : null;
}
async function Bq(q, $) {
  return (
    await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "eq", value: $ },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 1,
      purpose: O,
    })
  ).rows?.[0];
}
async function x(q, $, v) {
  if (
    (
      await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "eq", value: $.asset_id },
          { column: "variant", op: "eq", value: "faces" },
        ],
        limit: 1,
        purpose: O,
      })
    ).rows?.[0]?.model === v
  )
    return { settled: !0, derived: 0, skipped: 1 };
  let J = await q.vault.content({
    contentId: $.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: O,
  });
  if (J?.status !== "ok" || J.kind !== "bytes")
    throw Error(`asset ${$.asset_id}: preview is unavailable`);
  let _ = await kq({
    id: $.asset_id,
    bytes: J.base64,
    mediaType: J.mediaType,
    originalWidth: $.width,
    originalHeight: $.height,
  });
  if (!_ || _.error || !Array.isArray(_.faces))
    throw Error(
      _?.error ?? `asset ${$.asset_id}: face detector returned no result`
    );
  return (
    await q.vault.invoke({
      command: "enrich.upsert_faces",
      input: { asset_id: $.asset_id, model: v, faces: _.faces },
      purpose: O,
    }),
    { settled: !0, derived: 1, skipped: 0 }
  );
}
async function Tq(q, $) {
  let v = await q.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
    purpose: O,
  });
  return v.rows?.[0]?.model === $ ? v.rows[0].target_id : "";
}
async function fq({ ctx: q }) {
  let $ = yq();
  if (!$)
    return { summary: "faces skipped — automation model assets unavailable" };
  let v = await q.state.get("model");
  if (v !== $)
    (await q.state.set("consentCursor", v === void 0 ? await Tq(q, $) : ""),
      await q.state.set("model", $));
  let K = await q.vault.read({
      entity: "enrich.request",
      where: [
        { column: "capability", op: "eq", value: "faces" },
        { column: "drained_at", op: "is-null" },
      ],
      orderBy: { column: "request_id", dir: "asc" },
      limit: f,
      purpose: O,
    }),
    J = 0,
    _ = 0,
    Q = f,
    k = (K.rows?.length ?? 0) === f,
    X = [],
    V = new Set();
  for (let B of K.rows ?? []) {
    if (Q === 0) {
      k = !0;
      break;
    }
    if (B.target_id) {
      let w = await Bq(q, B.target_id);
      if (!w) {
        ((_ += 1), X.push(B.request_id), (Q -= 1));
        continue;
      }
      let j = await x(q, w, $);
      if (
        (V.add(w.asset_id),
        (J += j.derived),
        (_ += j.skipped),
        (Q -= 1),
        j.settled)
      )
        X.push(B.request_id);
      continue;
    }
    let G = `requestCursor:${B.request_id}`,
      C = (await q.state.get(G)) ?? "",
      Z = Q,
      L = await q.vault.read({
        entity: "media.asset",
        where: [
          { column: "asset_id", op: "gt", value: C },
          { column: "kind", op: "in", value: ["photo", "scan"] },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "asset_id", dir: "asc" },
        limit: Z,
        purpose: O,
      });
    for (let w of L.rows ?? []) {
      let j = await x(q, w, $);
      (V.add(w.asset_id), (J += j.derived), (_ += j.skipped), (Q -= 1));
    }
    let H = L.rows?.at(-1)?.asset_id;
    if (H) await q.state.set(G, H);
    if ((L.rows?.length ?? 0) < Z) X.push(B.request_id);
    else k = !0;
  }
  if (Q > 0) {
    let B = (await q.state.get("consentCursor")) ?? "",
      G = Q,
      C = await q.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "gt", value: B },
          { column: "variant", op: "eq", value: "faces" },
        ],
        orderBy: { column: "target_id", dir: "asc" },
        limit: G,
        purpose: O,
      });
    for (let L of C.rows ?? []) {
      if (V.has(L.target_id)) continue;
      let H = await Bq(q, L.target_id);
      if (!H) {
        _ += 1;
        continue;
      }
      let w = await x(q, H, $);
      ((J += w.derived), (_ += w.skipped));
    }
    let Z = C.rows?.at(-1)?.target_id;
    if (Z) await q.state.set("consentCursor", Z);
    if ((C.rows?.length ?? 0) === G) k = !0;
  }
  if (X.length)
    await q.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: X },
      purpose: O,
    });
  if (J > 0)
    await q.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
      purpose: O,
    });
  return {
    summary: `faces derived ${J}; skipped ${_}; consent queue batch ${K.rows?.length ?? 0}/${f}`,
    output: { derived: J, skipped: _, drained: X.length, model: $, rearm: k },
  };
}
export { Q0 as setFacesRuntimeForTests, fq as default };
