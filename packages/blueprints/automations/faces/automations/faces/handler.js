// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as _J } from "node:fs";
import M from "node:path";
import R from "node:path";
var YJ = R.resolve(import.meta.dirname, ".."),
  CJ = "__centraidAutomationRuntimeDir";
function OJ() {
  let J = globalThis[CJ];
  if (typeof J === "string" && J.length > 0) return R.resolve(J);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return R.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return R.join(YJ, "runtime");
}
var u = OJ(),
  g = R.join(u, "models");
function d(J, K) {
  let {
      stride: Q,
      gridWidth: G,
      gridHeight: $,
      classScores: X,
      objectness: V,
      boxes: j,
      landmarks: B,
    } = J,
    q = [];
  for (let L = 0; L < $; L++)
    for (let Z = 0; Z < G; Z++) {
      let W = L * G + Z,
        H = Math.max(0, Math.min(1, X[W] ?? 0)),
        Y = Math.max(0, Math.min(1, V[W] ?? 0)),
        C = Math.sqrt(H * Y);
      if (C < K) continue;
      let U = j[W * 4] ?? 0,
        F = j[W * 4 + 1] ?? 0,
        O = j[W * 4 + 2] ?? 0,
        A = j[W * 4 + 3] ?? 0,
        k = Math.exp(O) * Q,
        z = Math.exp(A) * Q,
        D = (Z + U) * Q,
        jJ = (L + F) * Q,
        f;
      if (B) {
        f = [];
        for (let _ = 0; _ < 5; _++) {
          let BJ = B[W * 10 + _ * 2] ?? 0,
            HJ = B[W * 10 + _ * 2 + 1] ?? 0;
          f.push({ x: (Z + BJ) * Q, y: (L + HJ) * Q });
        }
      }
      q.push({
        box: { x: D - k / 2, y: jJ - z / 2, width: k, height: z },
        score: C,
        landmarks: f,
      });
    }
  return q;
}
var n = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
function o(J, K) {
  if (J.length !== K.length || J.length === 0)
    throw Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  let Q = J.length,
    G = { x: 0, y: 0 },
    $ = { x: 0, y: 0 };
  for (let O = 0; O < Q; O++)
    ((G.x += J[O].x / Q),
      (G.y += J[O].y / Q),
      ($.x += K[O].x / Q),
      ($.y += K[O].y / Q));
  let X = 0,
    V = 0,
    j = 0,
    B = 0,
    q = 0;
  for (let O = 0; O < Q; O++) {
    let A = J[O].x - G.x,
      k = J[O].y - G.y,
      z = K[O].x - $.x,
      D = K[O].y - $.y;
    ((X += A * z),
      (V += A * D),
      (j += k * z),
      (B += k * D),
      (q += A * A + k * k));
  }
  let L = V - j,
    Z = X + B,
    W = Math.atan2(L, Z),
    H = Math.hypot(Z, L) / (q === 0 ? 1 : q),
    Y = H * Math.cos(W),
    C = H * Math.sin(W),
    U = $.x - (Y * G.x - C * G.y),
    F = $.y - (C * G.x + Y * G.y);
  return { a: Y, b: C, tx: U, ty: F };
}
function UJ(J, K) {
  return { x: J.a * K.x - J.b * K.y + J.tx, y: J.b * K.x + J.a * K.y + J.ty };
}
function s(J, K, Q, G) {
  let $ = K.a ** 2 + K.b ** 2,
    X =
      $ === 0
        ? { a: 1, b: 0, tx: 0, ty: 0 }
        : {
            a: K.a / $,
            b: -K.b / $,
            tx: (-K.a * K.tx - K.b * K.ty) / $,
            ty: (K.b * K.tx - K.a * K.ty) / $,
          },
    V = new Uint8Array(Q * G * 3);
  for (let j = 0; j < G; j++)
    for (let B = 0; B < Q; B++) {
      let q = UJ(X, { x: B, y: j }),
        L = FJ(J, q.x, q.y),
        Z = (j * Q + B) * 3;
      ((V[Z] = L[0]), (V[Z + 1] = L[1]), (V[Z + 2] = L[2]));
    }
  return { data: V, width: Q, height: G };
}
function FJ(J, K, Q) {
  if (K < 0 || Q < 0 || K > J.width - 1 || Q > J.height - 1) return [0, 0, 0];
  let G = Math.floor(K),
    $ = Math.floor(Q),
    X = Math.min(J.width - 1, G + 1),
    V = Math.min(J.height - 1, $ + 1),
    j = K - G,
    B = Q - $,
    q = (Z, W, H) => J.data[(W * J.width + Z) * 3 + H] ?? 0,
    L = [0, 0, 0];
  for (let Z = 0; Z < 3; Z++) {
    let W = q(G, $, Z) * (1 - j) + q(X, $, Z) * j,
      H = q(G, V, Z) * (1 - j) + q(X, V, Z) * j;
    L[Z] = Math.round(W * (1 - B) + H * B);
  }
  return L;
}
function r(J, K, Q) {
  let G = Q.width / K.width,
    $ = Q.height / K.height;
  return { x: J.x * G, y: J.y * $, width: J.width * G, height: J.height * $ };
}
function i(J, K, Q) {
  let G = Math.max(0, Math.min(K, Math.round(J.x))),
    $ = Math.max(0, Math.min(Q, Math.round(J.y))),
    X = Math.max(G, Math.min(K, Math.round(J.x + J.width))),
    V = Math.max($, Math.min(Q, Math.round(J.y + J.height)));
  return [G, $, X - G, V - $];
}
function a(J) {
  return Math.max(0, J.width) * Math.max(0, J.height);
}
function AJ(J, K) {
  let Q = J.x + J.width,
    G = J.y + J.height,
    $ = K.x + K.width,
    X = K.y + K.height,
    V = Math.max(J.x, K.x),
    j = Math.max(J.y, K.y),
    B = Math.min(Q, $),
    q = Math.min(G, X),
    L = Math.max(0, B - V),
    Z = Math.max(0, q - j),
    W = L * Z;
  if (W <= 0) return 0;
  let H = a(J) + a(K) - W;
  return H <= 0 ? 0 : W / H;
}
function t(J, K) {
  let Q = [...J].sort(($, X) => X.score - $.score),
    G = [];
  for (let $ of Q)
    if (!G.some((V) => AJ(V.box, $.box) > K.iouThreshold)) {
      if ((G.push($), K.topK !== void 0 && G.length >= K.topK)) break;
    }
  return G;
}
import { existsSync as m, readFileSync as kJ, statSync as zJ } from "node:fs";
import E from "node:path";
import { pathToFileURL as RJ } from "node:url";
var v;
class I extends Error {
  constructor(J, K) {
    super(
      `Automation model runtime dependency "${J}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: K }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function p(J, K = u) {
  let Q = E.join(K, "node_modules");
  if (!m(Q)) throw new I(J);
  let G = E.join(Q, ...J.split("/"));
  try {
    let $ = JJ(G);
    if ($ === null) throw Error(`no entry point in ${G}`);
    return $;
  } catch ($) {
    throw new I(J, $);
  }
}
function JJ(J, K = 0) {
  let Q = E.join(J, "package.json"),
    G = m(Q) ? JSON.parse(kJ(Q, "utf8")) : {},
    $ = [
      ...h(MJ(G.exports)),
      ...(typeof G.main === "string" ? [G.main] : []),
      "index.js",
    ];
  for (let X of $) {
    let V = PJ(E.resolve(J, X), K);
    if (V !== null) return V;
  }
  return null;
}
function PJ(J, K) {
  let Q = e(J);
  if (Q?.isFile()) return J;
  if (Q?.isDirectory()) return K >= 4 ? null : JJ(J, K + 1);
  for (let G of [".js", ".json", ".node"]) {
    let $ = `${J}${G}`;
    if (e($)?.isFile()) return $;
  }
  return null;
}
function e(J) {
  try {
    return zJ(J);
  } catch {
    return null;
  }
}
function MJ(J) {
  if (typeof J === "string") return J;
  if (J === null || typeof J !== "object") return;
  let K = J;
  return "." in K ? K["."] : K;
}
function h(J, K = 0) {
  if (typeof J === "string") return [J];
  if (K > 8 || J === null || typeof J !== "object") return [];
  if (Array.isArray(J)) return J.flatMap(($) => h($, K + 1));
  let Q = J,
    G = [];
  for (let $ of ["require", "node", "default"])
    if ($ in Q) G.push(...h(Q[$], K + 1));
  return G;
}
async function w() {
  if (v) return v;
  let J = p("onnxruntime-node");
  return ((v = await import(RJ(J).href)), v);
}
var N;
async function x(J) {
  N ??= new Map();
  let K = N.get(J);
  if (K) return K;
  if (!m(J)) throw new I(J);
  let Q = w().then((G) => G.InferenceSession.create(J));
  N.set(J, Q);
  try {
    return await Q;
  } catch (G) {
    throw (N.delete(J), G);
  }
}
import { pathToFileURL as DJ } from "node:url";
var T;
async function KJ() {
  if (T) return T;
  let J = p("sharp");
  return ((T = (await import(DJ(J).href)).default), T);
}
async function QJ(J) {
  let Q = (await KJ())(Buffer.from(J)),
    { data: G, info: $ } = await Q.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(G.buffer, G.byteOffset, G.byteLength),
    width: $.width,
    height: $.height,
  };
}
async function $J(J, K, Q) {
  let $ = (await KJ())(Buffer.from(J)),
    { data: X, info: V } = await $.resize({ width: K, height: Q, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(X.buffer, X.byteOffset, X.byteLength),
    width: V.width,
    height: V.height,
  };
}
function GJ(J) {
  let { width: K, height: Q, data: G } = J,
    $ = K * Q,
    X = new Float32Array($ * 3);
  for (let V = 0; V < $; V++)
    ((X[V] = G[V * 3 + 2] ?? 0),
      (X[$ + V] = G[V * 3 + 1] ?? 0),
      (X[$ * 2 + V] = G[V * 3] ?? 0));
  return X;
}
function VJ(J) {
  let { width: K, height: Q, data: G } = J,
    $ = K * Q,
    X = new Float32Array($ * 3);
  for (let V = 0; V < $; V++)
    ((X[V] = G[V * 3] ?? 0),
      (X[$ + V] = G[V * 3 + 1] ?? 0),
      (X[$ * 2 + V] = G[V * 3 + 2] ?? 0));
  return X;
}
var XJ = "yunet-sface@1",
  ZJ = M.join(g, "faces"),
  vJ = M.join(ZJ, "yunet.onnx"),
  NJ = M.join(ZJ, "sface.onnx"),
  P = 640,
  EJ = [8, 16, 32],
  IJ = 0.6,
  wJ = 0.3,
  S = 112;
function c(J = g) {
  let K = M.join(J, "faces");
  return ["yunet.onnx", "sface.onnx"].every((Q) => _J(M.join(K, Q)));
}
async function TJ(J, K) {
  let Q = await w(),
    G = await x(vJ),
    $ = G.inputNames[0] ?? "input",
    X = await G.run({ [$]: new Q.Tensor("float32", J, [1, 3, K, K]) }),
    V = [];
  for (let q of EJ) {
    let L = K / q,
      Z = X[`cls_${q}`]?.data,
      W = X[`obj_${q}`]?.data,
      H = X[`bbox_${q}`]?.data,
      Y = X[`kps_${q}`]?.data;
    if (!Z || !W || !H || !Y)
      throw Error(`faces: YuNet output set is incomplete at stride ${q}`);
    V.push(
      ...d(
        {
          stride: q,
          gridWidth: L,
          gridHeight: L,
          classScores: Z,
          objectness: W,
          boxes: H,
          landmarks: Y,
        },
        IJ
      )
    );
  }
  let j = t(
      V.map((q) => ({ box: q.box, score: q.score })),
      { iouThreshold: wJ, topK: 20 }
    ),
    B = new Set(j.map((q) => q.box));
  return V.filter((q) => B.has(q.box));
}
async function SJ(J) {
  let K = await w(),
    Q = await x(NJ),
    G = Q.inputNames[0] ?? "data",
    $ = await Q.run({ [G]: new K.Tensor("float32", J, [1, 3, S, S]) }),
    X = Q.outputNames[0],
    V = X ? $[X]?.data : void 0;
  if (!V || !(V instanceof Float32Array))
    throw Error("faces: SFace did not return a float32 embedding");
  return Array.from(V);
}
async function l(J) {
  try {
    let K = Buffer.from(J.bytes, "base64"),
      Q = await QJ(K),
      G = await $J(K, P, P),
      $ = GJ(G),
      X = await TJ($, P),
      V = Q.width / P,
      j = Q.height / P,
      B =
        J.originalWidth && J.originalHeight
          ? { width: J.originalWidth, height: J.originalHeight }
          : { width: Q.width, height: Q.height },
      L = (
        await Promise.all(
          X.filter((Z) => Z.landmarks).map(async (Z) => {
            let H = Z.landmarks.map((k) => ({ x: k.x * V, y: k.y * j })),
              Y = o(H, n),
              C = s(Q, Y, S, S),
              U = VJ(C),
              F = await SJ(U),
              O = {
                x: Z.box.x * V,
                y: Z.box.y * j,
                width: Z.box.width * V,
                height: Z.box.height * j,
              },
              A = i(r(O, Q, B), B.width, B.height);
            if (A[2] <= 0 || A[3] <= 0) return;
            return { box: A, confidence: Z.score, embedding: F };
          })
        )
      ).filter((Z) => Z !== void 0);
    return { id: J.id, faces: L };
  } catch (K) {
    return { id: J.id, error: K instanceof Error ? K.message : String(K) };
  }
}
var y = 16,
  LJ = l,
  WJ = c;
function ZK(J) {
  ((LJ = J?.infer ?? l), (WJ = J?.weightsPresent ?? c));
}
function yJ() {
  return WJ() ? XJ : null;
}
async function qJ(J, K) {
  return (
    await J.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "eq", value: K },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 1,
    })
  ).rows?.[0];
}
async function b(J, K, Q) {
  if (
    (
      await J.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "eq", value: K.asset_id },
          { column: "variant", op: "eq", value: "faces" },
        ],
        limit: 1,
      })
    ).rows?.[0]?.model === Q
  )
    return { settled: !0, derived: 0, skipped: 1 };
  let $ = await J.vault.content({
    contentId: K.content_id,
    variant: "preview",
    maxBytes: 4194304,
  });
  if ($?.status !== "ok" || $.kind !== "bytes")
    throw Error(`asset ${K.asset_id}: preview is unavailable`);
  let X = await LJ({
    id: K.asset_id,
    bytes: $.base64,
    mediaType: $.mediaType,
    originalWidth: K.width,
    originalHeight: K.height,
  });
  if (!X || X.error || !Array.isArray(X.faces))
    throw Error(
      X?.error ?? `asset ${K.asset_id}: face detector returned no result`
    );
  return (
    await J.vault.invoke({
      command: "enrich.upsert_faces",
      input: { asset_id: K.asset_id, model: Q, faces: X.faces },
    }),
    { settled: !0, derived: 1, skipped: 0 }
  );
}
async function bJ(J, K) {
  let Q = await J.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
  });
  return Q.rows?.[0]?.model === K ? Q.rows[0].target_id : "";
}
async function fJ(J, K) {
  let G = (
    await J.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
    })
  ).rows?.[0];
  if (!G) return "";
  return (
    await J.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: G.asset_id },
        { column: "variant", op: "eq", value: "faces" },
      ],
      limit: 1,
    })
  ).rows?.[0]?.model === K
    ? G.asset_id
    : "";
}
async function uJ({ ctx: J }) {
  let K = yJ();
  if (!K)
    return { summary: "faces skipped — automation model assets unavailable" };
  let Q = await J.state.get("model");
  if (Q !== K)
    (await J.state.set("consentCursor", Q === void 0 ? await bJ(J, K) : ""),
      await J.state.set("cursor", Q === void 0 ? await fJ(J, K) : ""),
      await J.state.set("model", K));
  let G = await J.vault.read({
      entity: "enrich.request",
      where: [
        { column: "capability", op: "eq", value: "faces" },
        { column: "drained_at", op: "is-null" },
      ],
      orderBy: { column: "request_id", dir: "asc" },
      limit: y,
    }),
    $ = 0,
    X = 0,
    V = y,
    j = (G.rows?.length ?? 0) === y,
    B = [],
    q = new Set();
  for (let L of G.rows ?? []) {
    if (V === 0) {
      j = !0;
      break;
    }
    if (L.target_id) {
      let U = await qJ(J, L.target_id);
      if (!U) {
        ((X += 1), B.push(L.request_id), (V -= 1));
        continue;
      }
      let F = await b(J, U, K);
      if (
        (q.add(U.asset_id),
        ($ += F.derived),
        (X += F.skipped),
        (V -= 1),
        F.settled)
      )
        B.push(L.request_id);
      continue;
    }
    let Z = `requestCursor:${L.request_id}`,
      W = (await J.state.get(Z)) ?? "",
      H = V,
      Y = await J.vault.read({
        entity: "media.asset",
        where: [
          { column: "asset_id", op: "gt", value: W },
          { column: "kind", op: "in", value: ["photo", "scan"] },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "asset_id", dir: "asc" },
        limit: H,
      });
    for (let U of Y.rows ?? []) {
      let F = await b(J, U, K);
      (q.add(U.asset_id), ($ += F.derived), (X += F.skipped), (V -= 1));
    }
    let C = Y.rows?.at(-1)?.asset_id;
    if (C) await J.state.set(Z, C);
    if ((Y.rows?.length ?? 0) < H) B.push(L.request_id);
    else j = !0;
  }
  if (V > 0) {
    let L = (await J.state.get("consentCursor")) ?? "",
      Z = V,
      W = await J.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "gt", value: L },
          { column: "variant", op: "eq", value: "faces" },
        ],
        orderBy: { column: "target_id", dir: "asc" },
        limit: Z,
      });
    for (let Y of W.rows ?? []) {
      if (q.has(Y.target_id)) continue;
      let C = await qJ(J, Y.target_id);
      if (!C) {
        X += 1;
        continue;
      }
      let U = await b(J, C, K);
      (q.add(C.asset_id), ($ += U.derived), (X += U.skipped), (V -= 1));
    }
    let H = W.rows?.at(-1)?.target_id;
    if (H) await J.state.set("consentCursor", H);
    if ((W.rows?.length ?? 0) === Z) j = !0;
  }
  if (V > 0) {
    let L = (await J.state.get("cursor")) ?? "",
      Z = V,
      W = await J.vault.read({
        entity: "media.asset",
        where: [
          { column: "asset_id", op: "gt", value: L },
          { column: "kind", op: "in", value: ["photo", "scan"] },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "asset_id", dir: "asc" },
        limit: Z,
      });
    for (let Y of W.rows ?? []) {
      if (q.has(Y.asset_id)) continue;
      let C = await b(J, Y, K);
      (q.add(Y.asset_id), ($ += C.derived), (X += C.skipped), (V -= 1));
    }
    let H = W.rows?.at(-1)?.asset_id;
    if (H) await J.state.set("cursor", H);
    if ((W.rows?.length ?? 0) === Z) j = !0;
  }
  if (B.length)
    await J.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: B },
    });
  if ($ > 0)
    await J.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
    });
  return {
    summary: `faces derived ${$}; skipped ${X}; request queue batch ${G.rows?.length ?? 0}/${y}`,
    output: { derived: $, skipped: X, drained: B.length, model: K, rearm: j },
  };
}
export { ZK as setFacesRuntimeForTests, uJ as default };
