// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as w0 } from "node:fs";
import M from "node:path";
import A from "node:path";
var F0 = A.resolve(import.meta.dirname, ".."),
  P0 = "__centraidAutomationRuntimeDir";
function z0() {
  let J = globalThis[P0];
  if (typeof J === "string" && J.length > 0) return A.resolve(J);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return A.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return A.join(F0, "runtime");
}
var g = z0(),
  u = A.join(g, "models");
function o(J, K) {
  let {
      stride: Q,
      gridWidth: V,
      gridHeight: $,
      classScores: q,
      objectness: G,
      boxes: L,
      landmarks: j,
    } = J,
    X = [];
  for (let B = 0; B < $; B++)
    for (let Z = 0; Z < V; Z++) {
      let W = B * V + Z,
        Y = Math.max(0, Math.min(1, q[W] ?? 0)),
        P = Math.max(0, Math.min(1, G[W] ?? 0)),
        O = Math.sqrt(Y * P);
      if (O < K) continue;
      let F = L[W * 4] ?? 0,
        U = L[W * 4 + 1] ?? 0,
        H = L[W * 4 + 2] ?? 0,
        v = L[W * 4 + 3] ?? 0,
        C = Math.exp(H) * Q,
        z = Math.exp(v) * Q,
        R = (Z + F) * Q,
        U0 = (B + U) * Q,
        f;
      if (j) {
        f = [];
        for (let D = 0; D < 5; D++) {
          let O0 = j[W * 10 + D * 2] ?? 0,
            C0 = j[W * 10 + D * 2 + 1] ?? 0;
          f.push({ x: (Z + O0) * Q, y: (B + C0) * Q });
        }
      }
      X.push({
        box: { x: R - C / 2, y: U0 - z / 2, width: C, height: z },
        score: O,
        landmarks: f,
      });
    }
  return X;
}
var s = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
function i(J, K) {
  if (J.length !== K.length || J.length === 0)
    throw Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  let Q = J.length,
    V = { x: 0, y: 0 },
    $ = { x: 0, y: 0 };
  for (let H = 0; H < Q; H++)
    ((V.x += J[H].x / Q),
      (V.y += J[H].y / Q),
      ($.x += K[H].x / Q),
      ($.y += K[H].y / Q));
  let q = 0,
    G = 0,
    L = 0,
    j = 0,
    X = 0;
  for (let H = 0; H < Q; H++) {
    let v = J[H].x - V.x,
      C = J[H].y - V.y,
      z = K[H].x - $.x,
      R = K[H].y - $.y;
    ((q += v * z),
      (G += v * R),
      (L += C * z),
      (j += C * R),
      (X += v * v + C * C));
  }
  let B = G - L,
    Z = q + j,
    W = Math.atan2(B, Z),
    Y = Math.hypot(Z, B) / (X === 0 ? 1 : X),
    P = Y * Math.cos(W),
    O = Y * Math.sin(W),
    F = $.x - (P * V.x - O * V.y),
    U = $.y - (O * V.x + P * V.y);
  return { a: P, b: O, tx: F, ty: U };
}
function A0(J, K) {
  return { x: J.a * K.x - J.b * K.y + J.tx, y: J.b * K.x + J.a * K.y + J.ty };
}
function r(J, K, Q, V) {
  let $ = K.a ** 2 + K.b ** 2,
    q =
      $ === 0
        ? { a: 1, b: 0, tx: 0, ty: 0 }
        : {
            a: K.a / $,
            b: -K.b / $,
            tx: (-K.a * K.tx - K.b * K.ty) / $,
            ty: (K.b * K.tx - K.a * K.ty) / $,
          },
    G = new Uint8Array(Q * V * 3);
  for (let L = 0; L < V; L++)
    for (let j = 0; j < Q; j++) {
      let X = A0(q, { x: j, y: L }),
        B = k0(J, X.x, X.y),
        Z = (L * Q + j) * 3;
      ((G[Z] = B[0]), (G[Z + 1] = B[1]), (G[Z + 2] = B[2]));
    }
  return { data: G, width: Q, height: V };
}
function k0(J, K, Q) {
  if (K < 0 || Q < 0 || K > J.width - 1 || Q > J.height - 1) return [0, 0, 0];
  let V = Math.floor(K),
    $ = Math.floor(Q),
    q = Math.min(J.width - 1, V + 1),
    G = Math.min(J.height - 1, $ + 1),
    L = K - V,
    j = Q - $,
    X = (Z, W, Y) => J.data[(W * J.width + Z) * 3 + Y] ?? 0,
    B = [0, 0, 0];
  for (let Z = 0; Z < 3; Z++) {
    let W = X(V, $, Z) * (1 - L) + X(q, $, Z) * L,
      Y = X(V, G, Z) * (1 - L) + X(q, G, Z) * L;
    B[Z] = Math.round(W * (1 - j) + Y * j);
  }
  return B;
}
function a(J, K, Q) {
  let V = Q.width / K.width,
    $ = Q.height / K.height;
  return { x: J.x * V, y: J.y * $, width: J.width * V, height: J.height * $ };
}
function t(J, K, Q) {
  let V = Math.max(0, Math.min(K, Math.round(J.x))),
    $ = Math.max(0, Math.min(Q, Math.round(J.y))),
    q = Math.max(V, Math.min(K, Math.round(J.x + J.width))),
    G = Math.max($, Math.min(Q, Math.round(J.y + J.height)));
  return [V, $, q - V, G - $];
}
function e(J) {
  return Math.max(0, J.width) * Math.max(0, J.height);
}
function M0(J, K) {
  let Q = J.x + J.width,
    V = J.y + J.height,
    $ = K.x + K.width,
    q = K.y + K.height,
    G = Math.max(J.x, K.x),
    L = Math.max(J.y, K.y),
    j = Math.min(Q, $),
    X = Math.min(V, q),
    B = Math.max(0, j - G),
    Z = Math.max(0, X - L),
    W = B * Z;
  if (W <= 0) return 0;
  let Y = e(J) + e(K) - W;
  return Y <= 0 ? 0 : W / Y;
}
function J0(J, K) {
  let Q = [...J].sort(($, q) => q.score - $.score),
    V = [];
  for (let $ of Q)
    if (!V.some((G) => M0(G.box, $.box) > K.iouThreshold)) {
      if ((V.push($), K.topK !== void 0 && V.length >= K.topK)) break;
    }
  return V;
}
import { existsSync as m, readFileSync as R0, statSync as D0 } from "node:fs";
import E from "node:path";
import { pathToFileURL as _0 } from "node:url";
var _;
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
function x(J, K = g) {
  let Q = E.join(K, "node_modules");
  if (!m(Q)) throw new I(J);
  let V = E.join(Q, ...J.split("/"));
  try {
    let $ = Q0(V);
    if ($ === null) throw Error(`no entry point in ${V}`);
    return $;
  } catch ($) {
    throw new I(J, $);
  }
}
function Q0(J, K = 0) {
  let Q = E.join(J, "package.json"),
    V = m(Q) ? JSON.parse(R0(Q, "utf8")) : {},
    $ = [
      ...h(E0(V.exports)),
      ...(typeof V.main === "string" ? [V.main] : []),
      "index.js",
    ];
  for (let q of $) {
    let G = N0(E.resolve(J, q), K);
    if (G !== null) return G;
  }
  return null;
}
function N0(J, K) {
  let Q = K0(J);
  if (Q?.isFile()) return J;
  if (Q?.isDirectory()) return K >= 4 ? null : Q0(J, K + 1);
  for (let V of [".js", ".json", ".node"]) {
    let $ = `${J}${V}`;
    if (K0($)?.isFile()) return $;
  }
  return null;
}
function K0(J) {
  try {
    return D0(J);
  } catch {
    return null;
  }
}
function E0(J) {
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
    V = [];
  for (let $ of ["require", "node", "default"])
    if ($ in Q) V.push(...h(Q[$], K + 1));
  return V;
}
async function w() {
  if (_) return _;
  let J = x("onnxruntime-node");
  return ((_ = await import(_0(J).href)), _);
}
var N;
async function p(J) {
  N ??= new Map();
  let K = N.get(J);
  if (K) return K;
  if (!m(J)) throw new I(J);
  let Q = w().then((V) => V.InferenceSession.create(J));
  N.set(J, Q);
  try {
    return await Q;
  } catch (V) {
    throw (N.delete(J), V);
  }
}
import { pathToFileURL as I0 } from "node:url";
var T;
async function $0() {
  if (T) return T;
  let J = x("sharp");
  return ((T = (await import(I0(J).href)).default), T);
}
async function V0(J) {
  let Q = (await $0())(Buffer.from(J)),
    { data: V, info: $ } = await Q.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(V.buffer, V.byteOffset, V.byteLength),
    width: $.width,
    height: $.height,
  };
}
async function G0(J, K, Q) {
  let $ = (await $0())(Buffer.from(J)),
    { data: q, info: G } = await $.resize({ width: K, height: Q, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(q.buffer, q.byteOffset, q.byteLength),
    width: G.width,
    height: G.height,
  };
}
function q0(J) {
  let { width: K, height: Q, data: V } = J,
    $ = K * Q,
    q = new Float32Array($ * 3);
  for (let G = 0; G < $; G++)
    ((q[G] = V[G * 3 + 2] ?? 0),
      (q[$ + G] = V[G * 3 + 1] ?? 0),
      (q[$ * 2 + G] = V[G * 3] ?? 0));
  return q;
}
function Z0(J) {
  let { width: K, height: Q, data: V } = J,
    $ = K * Q,
    q = new Float32Array($ * 3);
  for (let G = 0; G < $; G++)
    ((q[G] = V[G * 3] ?? 0),
      (q[$ + G] = V[G * 3 + 1] ?? 0),
      (q[$ * 2 + G] = V[G * 3 + 2] ?? 0));
  return q;
}
var c = "yunet-arcface@1";
var L0 = M.join(u, "faces"),
  T0 = M.join(L0, "yunet.onnx"),
  S0 = M.join(L0, "arcface.onnx"),
  k = 640,
  b0 = [8, 16, 32],
  y0 = 0.6,
  f0 = 0.3,
  S = 112,
  X0 = 512;
function l(J = u) {
  let K = M.join(J, "faces");
  return ["yunet.onnx", "arcface.onnx"].every((Q) => w0(M.join(K, Q)));
}
async function g0(J, K) {
  let Q = await w(),
    V = await p(T0),
    $ = V.inputNames[0] ?? "input",
    q = await V.run({ [$]: new Q.Tensor("float32", J, [1, 3, K, K]) }),
    G = [];
  for (let X of b0) {
    let B = K / X,
      Z = q[`cls_${X}`]?.data,
      W = q[`obj_${X}`]?.data,
      Y = q[`bbox_${X}`]?.data,
      P = q[`kps_${X}`]?.data;
    if (!Z || !W || !Y || !P)
      throw Error(`faces: YuNet output set is incomplete at stride ${X}`);
    G.push(
      ...o(
        {
          stride: X,
          gridWidth: B,
          gridHeight: B,
          classScores: Z,
          objectness: W,
          boxes: Y,
          landmarks: P,
        },
        y0
      )
    );
  }
  let L = J0(
      G.map((X) => ({ box: X.box, score: X.score })),
      { iouThreshold: f0, topK: 20 }
    ),
    j = new Set(L.map((X) => X.box));
  return G.filter((X) => j.has(X.box));
}
async function u0(J) {
  let K = await w(),
    Q = await p(S0),
    V = Q.inputNames[0] ?? "data",
    $ = await Q.run({ [V]: new K.Tensor("float32", J, [1, 3, S, S]) }),
    q = Q.outputNames[0],
    G = q ? $[q]?.data : void 0;
  if (!G || !(G instanceof Float32Array))
    throw Error("faces: ArcFace did not return a float32 embedding");
  if (G.length !== X0)
    throw Error(
      `faces: ArcFace returned ${G.length} dimensions, expected ${X0}`
    );
  return Array.from(G);
}
async function d(J) {
  try {
    let K = Buffer.from(J.bytes, "base64"),
      Q = await V0(K),
      V = await G0(K, k, k),
      $ = q0(V),
      q = await g0($, k),
      G = Q.width / k,
      L = Q.height / k,
      j =
        J.originalWidth && J.originalHeight
          ? { width: J.originalWidth, height: J.originalHeight }
          : { width: Q.width, height: Q.height },
      B = (
        await Promise.all(
          q
            .filter((Z) => Z.landmarks)
            .map(async (Z) => {
              let Y = Z.landmarks.map((C) => ({ x: C.x * G, y: C.y * L })),
                P = i(Y, s),
                O = r(Q, P, S, S),
                F = Z0(O),
                U = await u0(F),
                H = {
                  x: Z.box.x * G,
                  y: Z.box.y * L,
                  width: Z.box.width * G,
                  height: Z.box.height * L,
                },
                v = t(a(H, Q, j), j.width, j.height);
              if (v[2] <= 0 || v[3] <= 0) return;
              return { box: v, confidence: Z.score, embedding: U };
            })
        )
      ).filter((Z) => Z !== void 0);
    return { id: J.id, faces: B };
  } catch (K) {
    return { id: J.id, error: K instanceof Error ? K.message : String(K) };
  }
}
async function W0(J, K) {
  if (!K) return !1;
  return (
    ((
      await J.vault.read({
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
var H0 = 12;
async function n(J, K) {
  try {
    let Q = await J.vault.invoke({
        command: "enrich.record_target_failure",
        input: {
          capability: K.capability,
          target_type: K.targetType,
          target_id: K.targetId,
          ...(K.error === void 0
            ? {}
            : { error: String(K.error).slice(0, 2000) }),
          ...(K.reason === void 0 ? {} : { reason: K.reason }),
          ...(K.permanent === void 0 ? {} : { permanent: K.permanent }),
          ...(K.maxFailures === void 0 ? {} : { max_failures: K.maxFailures }),
        },
      }),
      V = Q?.output ?? Q;
    return { failures: Number(V?.failures ?? 0), declined: V?.declined === !0 };
  } catch {
    return { failures: 0, declined: !1 };
  }
}
function B0(J) {
  return (J instanceof Error ? J.message : String(J)).slice(0, 500);
}
var b = 16,
  Y0 = d,
  v0 = l;
function CJ(J) {
  ((Y0 = J?.infer ?? d), (v0 = J?.weightsPresent ?? l));
}
function h0() {
  return v0() ? c : null;
}
async function j0(J, K) {
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
async function y(J, K, Q) {
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
    return { settled: !0, derived: 0, skipped: 1, notReady: 0 };
  let $ = await J.vault.content({
    contentId: K.content_id,
    variant: "preview",
    maxBytes: 4194304,
  });
  if ($?.status !== "ok" || $.kind !== "bytes") {
    if (await W0(J, K.content_id))
      return { settled: !0, derived: 0, skipped: 1, notReady: 0 };
    if (
      (
        await n(J, {
          capability: "faces",
          targetType: "media.asset",
          targetId: K.asset_id,
          reason: "no-preview",
          error: "no preview landed for this asset",
          maxFailures: H0,
        })
      ).declined
    )
      return { settled: !0, derived: 0, skipped: 1, notReady: 0 };
    return { settled: !1, derived: 0, skipped: 0, notReady: 1 };
  }
  let q;
  try {
    if (
      ((q = await Y0({
        id: K.asset_id,
        bytes: $.base64,
        mediaType: $.mediaType,
        originalWidth: K.width,
        originalHeight: K.height,
      })),
      !q || q.error || !Array.isArray(q.faces))
    )
      throw Error(
        q?.error ?? `asset ${K.asset_id}: face detector returned no result`
      );
    await J.vault.invoke({
      command: "enrich.upsert_faces",
      input: { asset_id: K.asset_id, model: Q, faces: q.faces },
    });
  } catch (G) {
    if (
      (
        await n(J, {
          capability: "faces",
          targetType: "media.asset",
          targetId: K.asset_id,
          error: B0(G),
          reason: "failed",
        })
      ).declined
    )
      return { settled: !0, derived: 0, skipped: 1, notReady: 0, failed: 1 };
    return { settled: !1, derived: 0, skipped: 0, notReady: 1, failed: 1 };
  }
  return { settled: !0, derived: 1, skipped: 0, notReady: 0 };
}
async function m0(J, K) {
  let Q = await J.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
  });
  return Q.rows?.[0]?.model === K ? Q.rows[0].target_id : "";
}
async function x0(J, K) {
  let V = (
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
  if (!V) return "";
  return (
    await J.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: V.asset_id },
        { column: "variant", op: "eq", value: "faces" },
      ],
      limit: 1,
    })
  ).rows?.[0]?.model === K
    ? V.asset_id
    : "";
}
async function p0({ ctx: J }) {
  let K = h0();
  if (!K)
    return { summary: "faces skipped — automation model assets unavailable" };
  let Q = await J.state.get("model");
  if (Q !== K)
    (await J.state.set("consentCursor", Q === void 0 ? await m0(J, K) : ""),
      await J.state.set("cursor", Q === void 0 ? await x0(J, K) : ""),
      await J.state.set("model", K));
  let V = await J.vault.read({
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
    j = (V.rows?.length ?? 0) === b,
    X = [],
    B = new Set(),
    Z = new Set();
  for (let W of V.rows ?? []) {
    if (L === 0) {
      j = !0;
      break;
    }
    if (W.target_id) {
      let v = await j0(J, W.target_id);
      if (!v) {
        ((q += 1), X.push(W.request_id), (L -= 1));
        continue;
      }
      let C = await y(J, v, K);
      if ((B.add(v.asset_id), C.notReady)) Z.add(v.asset_id);
      if (
        (($ += C.derived),
        (q += C.skipped),
        (G += C.notReady),
        (L -= 1),
        C.settled)
      )
        X.push(W.request_id);
      continue;
    }
    let Y = `requestCursor:${W.request_id}`,
      P = (await J.state.get(Y)) ?? "",
      O = L,
      F = await J.vault.read({
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
    for (let v of F.rows ?? []) {
      let C = await y(J, v, K);
      if (
        (B.add(v.asset_id),
        ($ += C.derived),
        (q += C.skipped),
        (G += C.notReady),
        (L -= 1),
        C.notReady)
      )
        (Z.add(v.asset_id), (H = !0));
      else if (!H) U = v.asset_id;
    }
    if (U) await J.state.set(Y, U);
    if (!H && (F.rows?.length ?? 0) < O)
      (X.push(W.request_id), await J.state.delete(Y));
    else j = !0;
  }
  if (L > 0) {
    let W = (await J.state.get("consentCursor")) ?? "",
      Y = L,
      P = await J.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "gt", value: W },
          { column: "variant", op: "eq", value: "faces" },
        ],
        orderBy: { column: "target_id", dir: "asc" },
        limit: Y,
      }),
      O = "",
      F = !1;
    for (let U of P.rows ?? []) {
      if (B.has(U.target_id)) {
        if (Z.has(U.target_id)) F = !0;
        else if (!F) O = U.target_id;
        continue;
      }
      let H = await j0(J, U.target_id);
      if (!H) {
        if (((q += 1), !F)) O = U.target_id;
        continue;
      }
      let v = await y(J, H, K);
      if (
        (B.add(H.asset_id),
        ($ += v.derived),
        (q += v.skipped),
        (G += v.notReady),
        (L -= 1),
        v.notReady)
      )
        (Z.add(H.asset_id), (F = !0));
      else if (!F) O = U.target_id;
    }
    if (O) await J.state.set("consentCursor", O);
    if ((P.rows?.length ?? 0) === Y) j = !0;
  }
  if (L > 0) {
    let W = (await J.state.get("cursor")) ?? "",
      Y = L,
      P = await J.vault.read({
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
      F = !1;
    for (let U of P.rows ?? []) {
      if (B.has(U.asset_id)) {
        if (Z.has(U.asset_id)) F = !0;
        else if (!F) O = U.asset_id;
        continue;
      }
      let H = await y(J, U, K);
      if (
        (B.add(U.asset_id),
        ($ += H.derived),
        (q += H.skipped),
        (G += H.notReady),
        (L -= 1),
        H.notReady)
      )
        (Z.add(U.asset_id), (F = !0));
      else if (!F) O = U.asset_id;
    }
    if (O) await J.state.set("cursor", O);
    if ((P.rows?.length ?? 0) === Y) j = !0;
  }
  if (X.length)
    await J.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: X },
    });
  if ($ > 0)
    await J.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
    });
  return {
    summary: `faces derived ${$}; skipped ${q}; not ready ${G}; request queue batch ${V.rows?.length ?? 0}/${b}`,
    output: {
      derived: $,
      skipped: q,
      notReady: G,
      drained: X.length,
      model: K,
      rearm: j,
    },
  };
}
export { CJ as setFacesRuntimeForTests, p0 as default };
