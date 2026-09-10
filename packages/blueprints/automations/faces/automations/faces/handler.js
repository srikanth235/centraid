// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as NK } from "node:fs";
import k from "node:path";
import A from "node:path";
var UK = A.resolve(import.meta.dirname, ".."),
  OK = "__centraidAutomationRuntimeDir";
function FK() {
  let K = globalThis[OK];
  if (typeof K === "string" && K.length > 0) return A.resolve(K);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return A.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return A.join(UK, "runtime");
}
var u = FK(),
  g = A.join(u, "models");
function n(K, J) {
  let {
      stride: Q,
      gridWidth: V,
      gridHeight: $,
      classScores: q,
      objectness: G,
      boxes: L,
      landmarks: B,
    } = K,
    Z = [];
  for (let j = 0; j < $; j++)
    for (let X = 0; X < V; X++) {
      let W = j * V + X,
        Y = Math.max(0, Math.min(1, q[W] ?? 0)),
        P = Math.max(0, Math.min(1, G[W] ?? 0)),
        O = Math.sqrt(Y * P);
      if (O < J) continue;
      let C = L[W * 4] ?? 0,
        U = L[W * 4 + 1] ?? 0,
        H = L[W * 4 + 2] ?? 0,
        v = L[W * 4 + 3] ?? 0,
        F = Math.exp(H) * Q,
        z = Math.exp(v) * Q,
        R = (X + C) * Q,
        BK = (j + U) * Q,
        f;
      if (B) {
        f = [];
        for (let D = 0; D < 5; D++) {
          let YK = B[W * 10 + D * 2] ?? 0,
            vK = B[W * 10 + D * 2 + 1] ?? 0;
          f.push({ x: (X + YK) * Q, y: (j + vK) * Q });
        }
      }
      Z.push({
        box: { x: R - F / 2, y: BK - z / 2, width: F, height: z },
        score: O,
        landmarks: f,
      });
    }
  return Z;
}
var o = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
function s(K, J) {
  if (K.length !== J.length || K.length === 0)
    throw Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  let Q = K.length,
    V = { x: 0, y: 0 },
    $ = { x: 0, y: 0 };
  for (let H = 0; H < Q; H++)
    ((V.x += K[H].x / Q),
      (V.y += K[H].y / Q),
      ($.x += J[H].x / Q),
      ($.y += J[H].y / Q));
  let q = 0,
    G = 0,
    L = 0,
    B = 0,
    Z = 0;
  for (let H = 0; H < Q; H++) {
    let v = K[H].x - V.x,
      F = K[H].y - V.y,
      z = J[H].x - $.x,
      R = J[H].y - $.y;
    ((q += v * z),
      (G += v * R),
      (L += F * z),
      (B += F * R),
      (Z += v * v + F * F));
  }
  let j = G - L,
    X = q + B,
    W = Math.atan2(j, X),
    Y = Math.hypot(X, j) / (Z === 0 ? 1 : Z),
    P = Y * Math.cos(W),
    O = Y * Math.sin(W),
    C = $.x - (P * V.x - O * V.y),
    U = $.y - (O * V.x + P * V.y);
  return { a: P, b: O, tx: C, ty: U };
}
function CK(K, J) {
  return { x: K.a * J.x - K.b * J.y + K.tx, y: K.b * J.x + K.a * J.y + K.ty };
}
function i(K, J, Q, V) {
  let $ = J.a ** 2 + J.b ** 2,
    q =
      $ === 0
        ? { a: 1, b: 0, tx: 0, ty: 0 }
        : {
            a: J.a / $,
            b: -J.b / $,
            tx: (-J.a * J.tx - J.b * J.ty) / $,
            ty: (J.b * J.tx - J.a * J.ty) / $,
          },
    G = new Uint8Array(Q * V * 3);
  for (let L = 0; L < V; L++)
    for (let B = 0; B < Q; B++) {
      let Z = CK(q, { x: B, y: L }),
        j = PK(K, Z.x, Z.y),
        X = (L * Q + B) * 3;
      ((G[X] = j[0]), (G[X + 1] = j[1]), (G[X + 2] = j[2]));
    }
  return { data: G, width: Q, height: V };
}
function PK(K, J, Q) {
  if (J < 0 || Q < 0 || J > K.width - 1 || Q > K.height - 1) return [0, 0, 0];
  let V = Math.floor(J),
    $ = Math.floor(Q),
    q = Math.min(K.width - 1, V + 1),
    G = Math.min(K.height - 1, $ + 1),
    L = J - V,
    B = Q - $,
    Z = (X, W, Y) => K.data[(W * K.width + X) * 3 + Y] ?? 0,
    j = [0, 0, 0];
  for (let X = 0; X < 3; X++) {
    let W = Z(V, $, X) * (1 - L) + Z(q, $, X) * L,
      Y = Z(V, G, X) * (1 - L) + Z(q, G, X) * L;
    j[X] = Math.round(W * (1 - B) + Y * B);
  }
  return j;
}
function r(K, J, Q) {
  let V = Q.width / J.width,
    $ = Q.height / J.height;
  return { x: K.x * V, y: K.y * $, width: K.width * V, height: K.height * $ };
}
function a(K, J, Q) {
  let V = Math.max(0, Math.min(J, Math.round(K.x))),
    $ = Math.max(0, Math.min(Q, Math.round(K.y))),
    q = Math.max(V, Math.min(J, Math.round(K.x + K.width))),
    G = Math.max($, Math.min(Q, Math.round(K.y + K.height)));
  return [V, $, q - V, G - $];
}
function t(K) {
  return Math.max(0, K.width) * Math.max(0, K.height);
}
function zK(K, J) {
  let Q = K.x + K.width,
    V = K.y + K.height,
    $ = J.x + J.width,
    q = J.y + J.height,
    G = Math.max(K.x, J.x),
    L = Math.max(K.y, J.y),
    B = Math.min(Q, $),
    Z = Math.min(V, q),
    j = Math.max(0, B - G),
    X = Math.max(0, Z - L),
    W = j * X;
  if (W <= 0) return 0;
  let Y = t(K) + t(J) - W;
  return Y <= 0 ? 0 : W / Y;
}
function e(K, J) {
  let Q = [...K].sort(($, q) => q.score - $.score),
    V = [];
  for (let $ of Q)
    if (!V.some((G) => zK(G.box, $.box) > J.iouThreshold)) {
      if ((V.push($), J.topK !== void 0 && V.length >= J.topK)) break;
    }
  return V;
}
import { existsSync as p, readFileSync as AK, statSync as MK } from "node:fs";
import E from "node:path";
import { pathToFileURL as kK } from "node:url";
var _;
class I extends Error {
  constructor(K, J) {
    super(
      `Automation model runtime dependency "${K}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: J }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function x(K, J = u) {
  let Q = E.join(J, "node_modules");
  if (!p(Q)) throw new I(K);
  let V = E.join(Q, ...K.split("/"));
  try {
    let $ = JK(V);
    if ($ === null) throw Error(`no entry point in ${V}`);
    return $;
  } catch ($) {
    throw new I(K, $);
  }
}
function JK(K, J = 0) {
  let Q = E.join(K, "package.json"),
    V = p(Q) ? JSON.parse(AK(Q, "utf8")) : {},
    $ = [
      ...h(DK(V.exports)),
      ...(typeof V.main === "string" ? [V.main] : []),
      "index.js",
    ];
  for (let q of $) {
    let G = RK(E.resolve(K, q), J);
    if (G !== null) return G;
  }
  return null;
}
function RK(K, J) {
  let Q = KK(K);
  if (Q?.isFile()) return K;
  if (Q?.isDirectory()) return J >= 4 ? null : JK(K, J + 1);
  for (let V of [".js", ".json", ".node"]) {
    let $ = `${K}${V}`;
    if (KK($)?.isFile()) return $;
  }
  return null;
}
function KK(K) {
  try {
    return MK(K);
  } catch {
    return null;
  }
}
function DK(K) {
  if (typeof K === "string") return K;
  if (K === null || typeof K !== "object") return;
  let J = K;
  return "." in J ? J["."] : J;
}
function h(K, J = 0) {
  if (typeof K === "string") return [K];
  if (J > 8 || K === null || typeof K !== "object") return [];
  if (Array.isArray(K)) return K.flatMap(($) => h($, J + 1));
  let Q = K,
    V = [];
  for (let $ of ["require", "node", "default"])
    if ($ in Q) V.push(...h(Q[$], J + 1));
  return V;
}
async function T() {
  if (_) return _;
  let K = x("onnxruntime-node");
  return ((_ = await import(kK(K).href)), _);
}
var N;
async function m(K) {
  N ??= new Map();
  let J = N.get(K);
  if (J) return J;
  if (!p(K)) throw new I(K);
  let Q = T().then((V) => V.InferenceSession.create(K));
  N.set(K, Q);
  try {
    return await Q;
  } catch (V) {
    throw (N.delete(K), V);
  }
}
import { pathToFileURL as _K } from "node:url";
var w;
async function QK() {
  if (w) return w;
  let K = x("sharp");
  return ((w = (await import(_K(K).href)).default), w);
}
async function $K(K) {
  let Q = (await QK())(Buffer.from(K)),
    { data: V, info: $ } = await Q.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(V.buffer, V.byteOffset, V.byteLength),
    width: $.width,
    height: $.height,
  };
}
async function VK(K, J, Q) {
  let $ = (await QK())(Buffer.from(K)),
    { data: q, info: G } = await $.resize({ width: J, height: Q, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(q.buffer, q.byteOffset, q.byteLength),
    width: G.width,
    height: G.height,
  };
}
function GK(K) {
  let { width: J, height: Q, data: V } = K,
    $ = J * Q,
    q = new Float32Array($ * 3);
  for (let G = 0; G < $; G++)
    ((q[G] = V[G * 3 + 2] ?? 0),
      (q[$ + G] = V[G * 3 + 1] ?? 0),
      (q[$ * 2 + G] = V[G * 3] ?? 0));
  return q;
}
function qK(K) {
  let { width: J, height: Q, data: V } = K,
    $ = J * Q,
    q = new Float32Array($ * 3);
  for (let G = 0; G < $; G++)
    ((q[G] = V[G * 3] ?? 0),
      (q[$ + G] = V[G * 3 + 1] ?? 0),
      (q[$ * 2 + G] = V[G * 3 + 2] ?? 0));
  return q;
}
var c = "yunet-arcface@1";
var ZK = k.join(g, "faces"),
  EK = k.join(ZK, "yunet.onnx"),
  IK = k.join(ZK, "arcface.onnx"),
  M = 640,
  TK = [8, 16, 32],
  wK = 0.6,
  SK = 0.3,
  S = 112,
  XK = 512;
function l(K = g) {
  let J = k.join(K, "faces");
  return ["yunet.onnx", "arcface.onnx"].every((Q) => NK(k.join(J, Q)));
}
async function bK(K, J) {
  let Q = await T(),
    V = await m(EK),
    $ = V.inputNames[0] ?? "input",
    q = await V.run({ [$]: new Q.Tensor("float32", K, [1, 3, J, J]) }),
    G = [];
  for (let Z of TK) {
    let j = J / Z,
      X = q[`cls_${Z}`]?.data,
      W = q[`obj_${Z}`]?.data,
      Y = q[`bbox_${Z}`]?.data,
      P = q[`kps_${Z}`]?.data;
    if (!X || !W || !Y || !P)
      throw Error(`faces: YuNet output set is incomplete at stride ${Z}`);
    G.push(
      ...n(
        {
          stride: Z,
          gridWidth: j,
          gridHeight: j,
          classScores: X,
          objectness: W,
          boxes: Y,
          landmarks: P,
        },
        wK
      )
    );
  }
  let L = e(
      G.map((Z) => ({ box: Z.box, score: Z.score })),
      { iouThreshold: SK, topK: 20 }
    ),
    B = new Set(L.map((Z) => Z.box));
  return G.filter((Z) => B.has(Z.box));
}
async function yK(K) {
  let J = await T(),
    Q = await m(IK),
    V = Q.inputNames[0] ?? "data",
    $ = await Q.run({ [V]: new J.Tensor("float32", K, [1, 3, S, S]) }),
    q = Q.outputNames[0],
    G = q ? $[q]?.data : void 0;
  if (!G || !(G instanceof Float32Array))
    throw Error("faces: ArcFace did not return a float32 embedding");
  if (G.length !== XK)
    throw Error(
      `faces: ArcFace returned ${G.length} dimensions, expected ${XK}`
    );
  return Array.from(G);
}
async function d(K) {
  try {
    let J = Buffer.from(K.bytes, "base64"),
      Q = await $K(J),
      V = await VK(J, M, M),
      $ = GK(V),
      q = await bK($, M),
      G = Q.width / M,
      L = Q.height / M,
      B =
        K.originalWidth && K.originalHeight
          ? { width: K.originalWidth, height: K.originalHeight }
          : { width: Q.width, height: Q.height },
      j = (
        await Promise.all(
          q
            .filter((X) => X.landmarks)
            .map(async (X) => {
              let Y = X.landmarks.map((F) => ({ x: F.x * G, y: F.y * L })),
                P = s(Y, o),
                O = i(Q, P, S, S),
                C = qK(O),
                U = await yK(C),
                H = {
                  x: X.box.x * G,
                  y: X.box.y * L,
                  width: X.box.width * G,
                  height: X.box.height * L,
                },
                v = a(r(H, Q, B), B.width, B.height);
              if (v[2] <= 0 || v[3] <= 0) return;
              return { box: v, confidence: X.score, embedding: U };
            })
        )
      ).filter((X) => X !== void 0);
    return { id: K.id, faces: j };
  } catch (J) {
    return { id: K.id, error: J instanceof Error ? J.message : String(J) };
  }
}
async function LK(K, J) {
  if (!J) return !1;
  return (
    ((
      await K.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "eq", value: J },
          { column: "variant", op: "eq", value: "preview" },
          { column: "capability", op: "eq", value: "previews" },
        ],
        limit: 1,
      })
    ).rows?.length ?? 0) > 0
  );
}
var b = 16,
  HK = d,
  jK = l;
function B0(K) {
  ((HK = K?.infer ?? d), (jK = K?.weightsPresent ?? l));
}
function fK() {
  return jK() ? c : null;
}
async function WK(K, J) {
  return (
    await K.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "eq", value: J },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 1,
    })
  ).rows?.[0];
}
async function y(K, J, Q) {
  if (
    (
      await K.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "eq", value: J.asset_id },
          { column: "variant", op: "eq", value: "faces" },
        ],
        limit: 1,
      })
    ).rows?.[0]?.model === Q
  )
    return { settled: !0, derived: 0, skipped: 1, notReady: 0 };
  let $ = await K.vault.content({
    contentId: J.content_id,
    variant: "preview",
    maxBytes: 4194304,
  });
  if ($?.status !== "ok" || $.kind !== "bytes") {
    if (await LK(K, J.content_id))
      return { settled: !0, derived: 0, skipped: 1, notReady: 0 };
    return { settled: !1, derived: 0, skipped: 0, notReady: 1 };
  }
  let q = await HK({
    id: J.asset_id,
    bytes: $.base64,
    mediaType: $.mediaType,
    originalWidth: J.width,
    originalHeight: J.height,
  });
  if (!q || q.error || !Array.isArray(q.faces))
    throw Error(
      q?.error ?? `asset ${J.asset_id}: face detector returned no result`
    );
  return (
    await K.vault.invoke({
      command: "enrich.upsert_faces",
      input: { asset_id: J.asset_id, model: Q, faces: q.faces },
    }),
    { settled: !0, derived: 1, skipped: 0, notReady: 0 }
  );
}
async function uK(K, J) {
  let Q = await K.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
  });
  return Q.rows?.[0]?.model === J ? Q.rows[0].target_id : "";
}
async function gK(K, J) {
  let V = (
    await K.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
    })
  ).rows?.[0];
  if (!V) return "";
  return (
    await K.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: V.asset_id },
        { column: "variant", op: "eq", value: "faces" },
      ],
      limit: 1,
    })
  ).rows?.[0]?.model === J
    ? V.asset_id
    : "";
}
async function hK({ ctx: K }) {
  let J = fK();
  if (!J)
    return { summary: "faces skipped — automation model assets unavailable" };
  let Q = await K.state.get("model");
  if (Q !== J)
    (await K.state.set("consentCursor", Q === void 0 ? await uK(K, J) : ""),
      await K.state.set("cursor", Q === void 0 ? await gK(K, J) : ""),
      await K.state.set("model", J));
  let V = await K.vault.read({
      entity: "enrich.request",
      where: [
        { column: "capability", op: "eq", value: "faces" },
        { column: "drained_at", op: "is-null" },
      ],
      orderBy: { column: "request_id", dir: "asc" },
      limit: b,
    }),
    $ = 0,
    q = 0,
    G = 0,
    L = b,
    B = (V.rows?.length ?? 0) === b,
    Z = [],
    j = new Set(),
    X = new Set();
  for (let W of V.rows ?? []) {
    if (L === 0) {
      B = !0;
      break;
    }
    if (W.target_id) {
      let v = await WK(K, W.target_id);
      if (!v) {
        ((q += 1), Z.push(W.request_id), (L -= 1));
        continue;
      }
      let F = await y(K, v, J);
      if ((j.add(v.asset_id), F.notReady)) X.add(v.asset_id);
      if (
        (($ += F.derived),
        (q += F.skipped),
        (G += F.notReady),
        (L -= 1),
        F.settled)
      )
        Z.push(W.request_id);
      continue;
    }
    let Y = `requestCursor:${W.request_id}`,
      P = (await K.state.get(Y)) ?? "",
      O = L,
      C = await K.vault.read({
        entity: "media.asset",
        where: [
          { column: "asset_id", op: "gt", value: P },
          { column: "kind", op: "in", value: ["photo", "scan"] },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "asset_id", dir: "asc" },
        limit: O,
      }),
      U = "",
      H = !1;
    for (let v of C.rows ?? []) {
      let F = await y(K, v, J);
      if (
        (j.add(v.asset_id),
        ($ += F.derived),
        (q += F.skipped),
        (G += F.notReady),
        (L -= 1),
        F.notReady)
      )
        (X.add(v.asset_id), (H = !0));
      else if (!H) U = v.asset_id;
    }
    if (U) await K.state.set(Y, U);
    if (!H && (C.rows?.length ?? 0) < O) Z.push(W.request_id);
    else B = !0;
  }
  if (L > 0) {
    let W = (await K.state.get("consentCursor")) ?? "",
      Y = L,
      P = await K.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "gt", value: W },
          { column: "variant", op: "eq", value: "faces" },
        ],
        orderBy: { column: "target_id", dir: "asc" },
        limit: Y,
      }),
      O = "",
      C = !1;
    for (let U of P.rows ?? []) {
      if (j.has(U.target_id)) {
        if (X.has(U.target_id)) C = !0;
        else if (!C) O = U.target_id;
        continue;
      }
      let H = await WK(K, U.target_id);
      if (!H) {
        if (((q += 1), !C)) O = U.target_id;
        continue;
      }
      let v = await y(K, H, J);
      if (
        (j.add(H.asset_id),
        ($ += v.derived),
        (q += v.skipped),
        (G += v.notReady),
        (L -= 1),
        v.notReady)
      )
        (X.add(H.asset_id), (C = !0));
      else if (!C) O = U.target_id;
    }
    if (O) await K.state.set("consentCursor", O);
    if ((P.rows?.length ?? 0) === Y) B = !0;
  }
  if (L > 0) {
    let W = (await K.state.get("cursor")) ?? "",
      Y = L,
      P = await K.vault.read({
        entity: "media.asset",
        where: [
          { column: "asset_id", op: "gt", value: W },
          { column: "kind", op: "in", value: ["photo", "scan"] },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "asset_id", dir: "asc" },
        limit: Y,
      }),
      O = "",
      C = !1;
    for (let U of P.rows ?? []) {
      if (j.has(U.asset_id)) {
        if (X.has(U.asset_id)) C = !0;
        else if (!C) O = U.asset_id;
        continue;
      }
      let H = await y(K, U, J);
      if (
        (j.add(U.asset_id),
        ($ += H.derived),
        (q += H.skipped),
        (G += H.notReady),
        (L -= 1),
        H.notReady)
      )
        (X.add(U.asset_id), (C = !0));
      else if (!C) O = U.asset_id;
    }
    if (O) await K.state.set("cursor", O);
    if ((P.rows?.length ?? 0) === Y) B = !0;
  }
  if (Z.length)
    await K.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: Z },
    });
  if ($ > 0)
    await K.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
    });
  return {
    summary: `faces derived ${$}; skipped ${q}; not ready ${G}; request queue batch ${V.rows?.length ?? 0}/${b}`,
    output: {
      derived: $,
      skipped: q,
      notReady: G,
      drained: Z.length,
      model: J,
      rearm: B,
    },
  };
}
export { B0 as setFacesRuntimeForTests, hK as default };
