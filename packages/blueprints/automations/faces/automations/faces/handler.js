// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as zq } from "node:fs";
import U from "node:path";
import F from "node:path";
var wq = F.resolve(import.meta.dirname, ".."),
  Wq = "__centraidAutomationRuntimeDir";
function jq() {
  let q = globalThis[Wq];
  if (typeof q === "string" && q.length > 0) return F.resolve(q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return F.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return F.join(wq, "runtime");
}
var b = jq(),
  p = F.join(b, "models");
function d(q, v) {
  let {
      stride: $,
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
        j = Math.sqrt(Z * L);
      if (j < v) continue;
      let W = k[C * 4] ?? 0,
        A = k[C * 4 + 1] ?? 0,
        w = k[C * 4 + 2] ?? 0,
        H = k[C * 4 + 3] ?? 0,
        u = Math.exp(w) * $,
        O = Math.exp(H) * $,
        R = (G + W) * $,
        Cq = (B + A) * $,
        S;
      if (X) {
        S = [];
        for (let z = 0; z < 5; z++) {
          let Zq = X[C * 10 + z * 2] ?? 0,
            Lq = X[C * 10 + z * 2 + 1] ?? 0;
          S.push({ x: (G + Zq) * $, y: (B + Lq) * $ });
        }
      }
      V.push({
        box: { x: R - u / 2, y: Cq - O / 2, width: u, height: O },
        score: j,
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
function r(q, v) {
  if (q.length !== v.length || q.length === 0)
    throw Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  let $ = q.length,
    K = { x: 0, y: 0 },
    J = { x: 0, y: 0 };
  for (let w = 0; w < $; w++)
    ((K.x += q[w].x / $),
      (K.y += q[w].y / $),
      (J.x += v[w].x / $),
      (J.y += v[w].y / $));
  let _ = 0,
    Q = 0,
    k = 0,
    X = 0,
    V = 0;
  for (let w = 0; w < $; w++) {
    let H = q[w].x - K.x,
      u = q[w].y - K.y,
      O = v[w].x - J.x,
      R = v[w].y - J.y;
    ((_ += H * O),
      (Q += H * R),
      (k += u * O),
      (X += u * R),
      (V += H * H + u * u));
  }
  let B = Q - k,
    G = _ + X,
    C = Math.atan2(B, G),
    Z = Math.hypot(G, B) / (V === 0 ? 1 : V),
    L = Z * Math.cos(C),
    j = Z * Math.sin(C),
    W = J.x - (L * K.x - j * K.y),
    A = J.y - (j * K.x + L * K.y);
  return { a: L, b: j, tx: W, ty: A };
}
function Aq(q, v) {
  return { x: q.a * v.x - q.b * v.y + q.tx, y: q.b * v.x + q.a * v.y + q.ty };
}
function o(q, v, $, K) {
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
  for (let k = 0; k < K; k++)
    for (let X = 0; X < $; X++) {
      let V = Aq(_, { x: X, y: k }),
        B = Hq(q, V.x, V.y),
        G = (k * $ + X) * 3;
      ((Q[G] = B[0]), (Q[G + 1] = B[1]), (Q[G + 2] = B[2]));
    }
  return { data: Q, width: $, height: K };
}
function Hq(q, v, $) {
  if (v < 0 || $ < 0 || v > q.width - 1 || $ > q.height - 1) return [0, 0, 0];
  let K = Math.floor(v),
    J = Math.floor($),
    _ = Math.min(q.width - 1, K + 1),
    Q = Math.min(q.height - 1, J + 1),
    k = v - K,
    X = $ - J,
    V = (G, C, Z) => q.data[(C * q.width + G) * 3 + Z] ?? 0,
    B = [0, 0, 0];
  for (let G = 0; G < 3; G++) {
    let C = V(K, J, G) * (1 - k) + V(_, J, G) * k,
      Z = V(K, Q, G) * (1 - k) + V(_, Q, G) * k;
    B[G] = Math.round(C * (1 - X) + Z * X);
  }
  return B;
}
function i(q, v, $) {
  let K = $.width / v.width,
    J = $.height / v.height;
  return { x: q.x * K, y: q.y * J, width: q.width * K, height: q.height * J };
}
function t(q, v, $) {
  let K = Math.max(0, Math.min(v, Math.round(q.x))),
    J = Math.max(0, Math.min($, Math.round(q.y))),
    _ = Math.max(K, Math.min(v, Math.round(q.x + q.width))),
    Q = Math.max(J, Math.min($, Math.round(q.y + q.height)));
  return [K, J, _ - K, Q - J];
}
function a(q) {
  return Math.max(0, q.width) * Math.max(0, q.height);
}
function uq(q, v) {
  let $ = q.x + q.width,
    K = q.y + q.height,
    J = v.x + v.width,
    _ = v.y + v.height,
    Q = Math.max(q.x, v.x),
    k = Math.max(q.y, v.y),
    X = Math.min($, J),
    V = Math.min(K, _),
    B = Math.max(0, X - Q),
    G = Math.max(0, V - k),
    C = B * G;
  if (C <= 0) return 0;
  let Z = a(q) + a(v) - C;
  return Z <= 0 ? 0 : C / Z;
}
function e(q, v) {
  let $ = [...q].sort((J, _) => _.score - J.score),
    K = [];
  for (let J of $)
    if (!K.some((Q) => uq(Q.box, J.box) > v.iouThreshold)) {
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
function c(q, v = b) {
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
      ...m(Uq(K.exports)),
      ...(typeof K.main === "string" ? [K.main] : []),
      "index.js",
    ];
  for (let _ of J) {
    let Q = Pq(N.resolve(q, _), v);
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
function m(q, v = 0) {
  if (typeof q === "string") return [q];
  if (v > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap((J) => m(J, v + 1));
  let $ = q,
    K = [];
  for (let J of ["require", "node", "default"])
    if (J in $) K.push(...m($[J], v + 1));
  return K;
}
async function I() {
  if (M) return M;
  let q = c("onnxruntime-node");
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
  let q = c("sharp");
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
function Qq(q) {
  let { width: v, height: $, data: K } = q,
    J = v * $,
    _ = new Float32Array(J * 3);
  for (let Q = 0; Q < J; Q++)
    ((_[Q] = K[Q * 3 + 2] ?? 0),
      (_[J + Q] = K[Q * 3 + 1] ?? 0),
      (_[J * 2 + Q] = K[Q * 3] ?? 0));
  return _;
}
function _q(q) {
  let { width: v, height: $, data: K } = q,
    J = v * $,
    _ = new Float32Array(J * 3);
  for (let Q = 0; Q < J; Q++)
    ((_[Q] = K[Q * 3] ?? 0),
      (_[J + Q] = K[Q * 3 + 1] ?? 0),
      (_[J * 2 + Q] = K[Q * 3 + 2] ?? 0));
  return _;
}
var Gq = "yunet-sface@1",
  Vq = U.join(p, "faces"),
  Mq = U.join(Vq, "yunet.onnx"),
  Dq = U.join(Vq, "sface.onnx"),
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
    _ = await K.run({ [J]: new $.Tensor("float32", q, [1, 3, v, v]) }),
    Q = [];
  for (let V of Nq) {
    let B = v / V,
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
        Eq
      )
    );
  }
  let k = e(
      Q.map((V) => ({ box: V.box, score: V.score })),
      { iouThreshold: Iq, topK: 20 }
    ),
    X = new Set(k.map((V) => V.box));
  return Q.filter((V) => X.has(V.box));
}
async function Tq(q) {
  let v = await I(),
    $ = await s(Dq),
    K = $.inputNames[0] ?? "data",
    J = await $.run({ [K]: new v.Tensor("float32", q, [1, 3, T, T]) }),
    _ = $.outputNames[0],
    Q = _ ? J[_]?.data : void 0;
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
      _ = await yq(J, P),
      Q = $.width / P,
      k = $.height / P,
      X =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: $.width, height: $.height },
      B = (
        await Promise.all(
          _.filter((G) => G.landmarks).map(async (G) => {
            let Z = G.landmarks.map((u) => ({ x: u.x * Q, y: u.y * k })),
              L = r(Z, n),
              j = o($, L, T, T),
              W = _q(j),
              A = await Tq(W),
              w = {
                x: G.box.x * Q,
                y: G.box.y * k,
                width: G.box.width * Q,
                height: G.box.height * k,
              },
              H = t(i(w, $, X), X.width, X.height);
            if (H[2] <= 0 || H[3] <= 0) return;
            return { box: H, confidence: G.score, embedding: A };
          })
        )
      ).filter((G) => G !== void 0);
    return { id: q.id, faces: B };
  } catch (v) {
    return { id: q.id, error: v instanceof Error ? v.message : String(v) };
  }
}
var f = 16,
  Y = "dpv:ServiceProvision",
  kq = l,
  Xq = h;
function G0(q) {
  ((kq = q?.infer ?? l), (Xq = q?.weightsPresent ?? h));
}
function fq() {
  return Xq() ? Gq : null;
}
async function Bq(q, v) {
  return (
    await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "eq", value: v },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 1,
      purpose: Y,
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
        purpose: Y,
      })
    ).rows?.[0]?.model === $
  )
    return { settled: !0, derived: 0, skipped: 1 };
  let J = await q.vault.content({
    contentId: v.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: Y,
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
      purpose: Y,
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
    purpose: Y,
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
      purpose: Y,
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
      let W = await Bq(q, B.target_id);
      if (!W) {
        ((_ += 1), X.push(B.request_id), (Q -= 1));
        continue;
      }
      let A = await x(q, W, v);
      if (
        (V.add(W.asset_id),
        (J += A.derived),
        (_ += A.skipped),
        (Q -= 1),
        A.settled)
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
        purpose: Y,
      });
    for (let W of L.rows ?? []) {
      let A = await x(q, W, v);
      (V.add(W.asset_id), (J += A.derived), (_ += A.skipped), (Q -= 1));
    }
    let j = L.rows?.at(-1)?.asset_id;
    if (j) await q.state.set(G, j);
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
        purpose: Y,
      });
    for (let L of C.rows ?? []) {
      if (V.has(L.target_id)) continue;
      let j = await Bq(q, L.target_id);
      if (!j) {
        _ += 1;
        continue;
      }
      let W = await x(q, j, v);
      ((J += W.derived), (_ += W.skipped));
    }
    let Z = C.rows?.at(-1)?.target_id;
    if (Z) await q.state.set("consentCursor", Z);
    if ((C.rows?.length ?? 0) === G) k = !0;
  }
  if (X.length)
    await q.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: X },
      purpose: Y,
    });
  if (J > 0)
    await q.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
      purpose: Y,
    });
  return {
    summary: `faces derived ${J}; skipped ${_}; consent queue batch ${K.rows?.length ?? 0}/${f}`,
    output: { derived: J, skipped: _, drained: X.length, model: v, rearm: k },
  };
}
export { G0 as setFacesRuntimeForTests, bq as default };
