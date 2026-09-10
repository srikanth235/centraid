import { existsSync as hq } from "node:fs";
import { readFile as pq } from "node:fs/promises";
import M from "node:path";
import P from "node:path";
// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { pathToFileURL as qK } from "node:url";
var Eq = P.resolve(import.meta.dirname, ".."),
  Mq = "__centraidAutomationRuntimeDir";
function Pq() {
  let q = globalThis[Mq];
  if (typeof q === "string" && q.length > 0) return P.resolve(q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return P.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return P.join(Eq, "runtime");
}
var g = Pq(),
  x = P.join(g, "models");
function Dq(q) {
  if (q.length === 0) throw Error("argmax: row must be non-empty");
  let K = 0,
    Q = q[0];
  for (let Z = 1; Z < q.length; Z++) {
    let $ = q[Z];
    if ($ > Q) ((Q = $), (K = Z));
  }
  return { index: K, value: Q };
}
function Zq(q, K, Q = 0) {
  let Z = [],
    $ = [],
    W;
  for (let V of q) {
    let { index: G, value: U } = Dq(V);
    if (G !== W && G !== Q) {
      let Y = K[G];
      if (Y !== void 0) (Z.push(Y), $.push(U));
    }
    W = G;
  }
  let J = $.length === 0 ? 0 : $.reduce((V, G) => V + G, 0) / $.length;
  return { text: Z.join(""), confidence: J };
}
function $q(q, K, Q, Z) {
  let $ = Math.max(q, K),
    W = $ > Q ? Q / $ : 1,
    J = (V) => Math.max(Z, Math.round((V * W) / Z) * Z);
  return { width: J(q), height: J(K) };
}
function h(q, K, Q) {
  let Z = Q.width / K.width,
    $ = Q.height / K.height;
  return { x: q.x * Z, y: q.y * $, width: q.width * Z, height: q.height * $ };
}
function Jq(q) {
  return [
    Math.round(q.x),
    Math.round(q.y),
    Math.round(q.width),
    Math.round(q.height),
  ];
}
function Wq(q, K, Q) {
  let Z = Math.max(0, Math.min(K, Math.round(q.x))),
    $ = Math.max(0, Math.min(Q, Math.round(q.y))),
    W = Math.max(Z, Math.min(K, Math.round(q.x + q.width))),
    J = Math.max($, Math.min(Q, Math.round(q.y + q.height)));
  return [Z, $, W - Z, J - $];
}
function Tq(q, K, Q, Z = 0.3) {
  let $ = new Uint8Array(K * Q);
  for (let W = 0; W < $.length; W++) $[W] = (q[W] ?? 0) >= Z ? 1 : 0;
  return $;
}
function vq(q, K, Q, Z = 1) {
  let $ = new Uint8Array(K * Q),
    W = [],
    J = [];
  for (let V = 0; V < q.length; V++) {
    if (!q[V] || $[V]) continue;
    (J.push(V), ($[V] = 1));
    let {
        POSITIVE_INFINITY: G,
        POSITIVE_INFINITY: U,
        NEGATIVE_INFINITY: Y,
        NEGATIVE_INFINITY: X,
      } = Number,
      F = 0;
    while (J.length > 0) {
      let H = J.pop(),
        j = H % K,
        L = Math.floor(H / K);
      ((G = Math.min(G, j)),
        (U = Math.min(U, L)),
        (Y = Math.max(Y, j)),
        (X = Math.max(X, L)),
        F++);
      let C = [
        j > 0 ? H - 1 : -1,
        j < K - 1 ? H + 1 : -1,
        L > 0 ? H - K : -1,
        L < Q - 1 ? H + K : -1,
      ];
      for (let B of C) if (B >= 0 && q[B] && !$[B]) (($[B] = 1), J.push(B));
    }
    if (F >= Z)
      W.push({
        box: { x: G, y: U, width: Y - G + 1, height: X - U + 1 },
        area: F,
      });
  }
  return W;
}
function Iq(q, K, Q = 1.5) {
  let Z = 2 * (q.width + q.height);
  if (Z <= 0) return q;
  let $ = (K * Q) / Z;
  return {
    x: q.x - $,
    y: q.y - $,
    width: q.width + $ * 2,
    height: q.height + $ * 2,
  };
}
function fq(q, K, Q) {
  let Z = Math.max(0, Math.min(K, Math.round(q.x))),
    $ = Math.max(0, Math.min(Q, Math.round(q.y))),
    W = Math.max(0, Math.min(K, Math.round(q.x + q.width))),
    J = Math.max(0, Math.min(Q, Math.round(q.y + q.height)));
  return { x: Z, y: $, width: Math.max(0, W - Z), height: Math.max(0, J - $) };
}
function Sq(q, K, Q) {
  let Z = Math.max(0, Math.floor(Q.x)),
    $ = Math.max(0, Math.floor(Q.y)),
    W = Math.max(Z, Math.ceil(Q.x + Q.width)),
    J = Math.max($, Math.ceil(Q.y + Q.height)),
    V = 0,
    G = 0;
  for (let U = $; U < J; U++)
    for (let Y = Z; Y < W; Y++) ((V += q[U * K + Y] ?? 0), G++);
  return G === 0 ? 0 : V / G;
}
function Vq(q, K, Q, Z = {}) {
  let {
      binaryThreshold: $ = 0.3,
      boxScoreThreshold: W = 0.5,
      unclipRatio: J = 1.5,
      minArea: V = 4,
    } = Z,
    G = Tq(q, K, Q, $),
    U = vq(G, K, Q, V),
    Y = [];
  for (let X of U) {
    let F = Sq(q, K, X.box);
    if (F < W) continue;
    let H = Iq(X.box, X.area, J),
      j = fq(H, K, Q);
    if (j.width <= 0 || j.height <= 0) continue;
    Y.push({ box: j, score: F });
  }
  return Y;
}
import { existsSync as l, readFileSync as Rq, statSync as yq } from "node:fs";
import I from "node:path";
import { pathToFileURL as wq } from "node:url";
var T;
class f extends Error {
  constructor(q, K) {
    super(
      `Automation model runtime dependency "${q}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: K }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function E(q, K = g) {
  let Q = I.join(K, "node_modules");
  if (!l(Q)) throw new f(q);
  let Z = I.join(Q, ...q.split("/"));
  try {
    let $ = Yq(Z);
    if ($ === null) throw Error(`no entry point in ${Z}`);
    return $;
  } catch ($) {
    throw new f(q, $);
  }
}
function Yq(q, K = 0) {
  let Q = I.join(q, "package.json"),
    Z = l(Q) ? JSON.parse(Rq(Q, "utf8")) : {},
    $ = [
      ...p(uq(Z.exports)),
      ...(typeof Z.main === "string" ? [Z.main] : []),
      "index.js",
    ];
  for (let W of $) {
    let J = bq(I.resolve(q, W), K);
    if (J !== null) return J;
  }
  return null;
}
function bq(q, K) {
  let Q = Gq(q);
  if (Q?.isFile()) return q;
  if (Q?.isDirectory()) return K >= 4 ? null : Yq(q, K + 1);
  for (let Z of [".js", ".json", ".node"]) {
    let $ = `${q}${Z}`;
    if (Gq($)?.isFile()) return $;
  }
  return null;
}
function Gq(q) {
  try {
    return yq(q);
  } catch {
    return null;
  }
}
function uq(q) {
  if (typeof q === "string") return q;
  if (q === null || typeof q !== "object") return;
  let K = q;
  return "." in K ? K["."] : K;
}
function p(q, K = 0) {
  if (typeof q === "string") return [q];
  if (K > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap(($) => p($, K + 1));
  let Q = q,
    Z = [];
  for (let $ of ["require", "node", "default"])
    if ($ in Q) Z.push(...p(Q[$], K + 1));
  return Z;
}
async function S() {
  if (T) return T;
  let q = E("onnxruntime-node");
  return ((T = await import(wq(q).href)), T);
}
var v;
async function c(q) {
  v ??= new Map();
  let K = v.get(q);
  if (K) return K;
  if (!l(q)) throw new f(q);
  let Q = S().then((Z) => Z.InferenceSession.create(q));
  v.set(q, Q);
  try {
    return await Q;
  } catch (Z) {
    throw (v.delete(q), Z);
  }
}
import { pathToFileURL as mq } from "node:url";
var R;
async function d() {
  if (R) return R;
  let q = E("sharp");
  return ((R = (await import(mq(q).href)).default), R);
}
async function s(q) {
  let Q = (await d())(Buffer.from(q)),
    { data: Z, info: $ } = await Q.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(Z.buffer, Z.byteOffset, Z.byteLength),
    width: $.width,
    height: $.height,
  };
}
async function Uq(q, K, Q) {
  let $ = (await d())(Buffer.from(q)),
    { data: W, info: J } = await $.resize({ width: K, height: Q, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(W.buffer, W.byteOffset, W.byteLength),
    width: J.width,
    height: J.height,
  };
}
function Xq(q, K) {
  let Q = Math.max(0, Math.min(q.width, Math.round(K.x))),
    Z = Math.max(0, Math.min(q.height, Math.round(K.y))),
    $ = Math.max(Q, Math.min(q.width, Math.round(K.x + K.width))),
    W = Math.max(Z, Math.min(q.height, Math.round(K.y + K.height))),
    J = $ - Q,
    V = W - Z,
    G = new Uint8Array(J * V * 3);
  for (let U = 0; U < V; U++) {
    let Y = ((Z + U) * q.width + Q) * 3,
      X = U * J * 3;
    G.set(q.data.subarray(Y, Y + J * 3), X);
  }
  return { data: G, width: J, height: V };
}
async function jq(q, K, Q) {
  let $ = (await d())(Buffer.from(q.data), {
      raw: { width: q.width, height: q.height, channels: 3 },
    }),
    { data: W, info: J } = await $.resize({ width: K, height: Q, fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(W.buffer, W.byteOffset, W.byteLength),
    width: J.width,
    height: J.height,
  };
}
var gq = [0.485, 0.456, 0.406],
  xq = [0.229, 0.224, 0.225];
function Hq(q) {
  let { width: K, height: Q, data: Z } = q,
    $ = K * Q,
    W = new Float32Array($ * 3);
  for (let J = 0; J < $; J++)
    for (let V = 0; V < 3; V++) {
      let G = (Z[J * 3 + V] ?? 0) / 255;
      W[V * $ + J] = (G - gq[V]) / xq[V];
    }
  return W;
}
function Lq(q) {
  let { width: K, height: Q, data: Z } = q,
    $ = K * Q,
    W = new Float32Array($ * 3);
  for (let J = 0; J < $; J++)
    for (let V = 0; V < 3; V++) W[V * $ + J] = (Z[J * 3 + V] ?? 0) / 127.5 - 1;
  return W;
}
var y = "pp-ocrv5@1";
var n = M.join(x, "ocr"),
  lq = M.join(n, "det.onnx"),
  cq = M.join(n, "rec.onnx"),
  dq = M.join(n, "dict.txt"),
  sq = 960,
  nq = 32,
  w = 48,
  rq = 320;
function r(q = x) {
  let K = M.join(q, "ocr");
  return ["det.onnx", "rec.onnx", "dict.txt"].every((Q) => hq(M.join(K, Q)));
}
function aq(q) {
  return ["", ...q, " "];
}
function oq(q) {
  let K = q.split(/\r?\n/u);
  if (K.at(-1) === "") K.pop();
  return K;
}
var b;
async function iq() {
  if (b) return b;
  let q = await pq(dq, "utf8");
  return ((b = aq(oq(q))), b);
}
async function tq(q) {
  let K = await s(q),
    Q = $q(K.width, K.height, sq, nq),
    Z = await Uq(q, Q.width, Q.height),
    $ = Hq(Z),
    W = await S(),
    J = await c(lq),
    V = J.inputNames[0] ?? "x",
    G = await J.run({
      [V]: new W.Tensor("float32", $, [1, 3, Q.height, Q.width]),
    }),
    U = J.outputNames[0],
    Y = U ? G[U]?.data : void 0;
  if (!Y || !(Y instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: Vq(Y, Q.width, Q.height).map(({ box: H, score: j }) => ({
      box: Jq(h(H, Q, K)),
      score: j,
    })),
    native: K,
  };
}
async function eq(q) {
  let K = w / q.height,
    Q = Math.min(rq, Math.max(w, Math.round(q.width * K))),
    Z = await jq(q, Q, w),
    $ = Lq(Z),
    W = await S(),
    J = await c(cq),
    V = J.inputNames[0] ?? "x",
    G = await J.run({ [V]: new W.Tensor("float32", $, [1, 3, w, Q]) }),
    U = J.outputNames[0],
    Y = U ? G[U] : void 0;
  if (!Y || !(Y.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let X = await iq(),
    F = X.length,
    H = Y.data.length / F,
    j = [];
  for (let L = 0; L < H; L++) {
    let C = Array.from(Y.data.subarray(L * F, (L + 1) * F));
    j.push(C);
  }
  return Zq(j, X);
}
async function a(q) {
  try {
    let K = Buffer.from(q.bytes, "base64"),
      { boxes: Q, native: Z } = await tq(K),
      $ = await s(K),
      W =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: Z.width, height: Z.height },
      V = (
        await Promise.all(
          Q.map(async (G) => {
            let [U, Y, X, F] = G.box,
              H = Xq($, { x: U, y: Y, width: X, height: F });
            if (H.width <= 0 || H.height <= 0) return;
            let j = await eq(H);
            if (!j.text) return;
            let L = Wq(
              h({ x: U, y: Y, width: X, height: F }, Z, W),
              W.width,
              W.height
            );
            if (L[2] <= 0 || L[3] <= 0) return;
            return { text: j.text, confidence: j.confidence, box: L };
          })
        )
      ).filter((G) => G !== void 0);
    return { id: q.id, regions: V };
  } catch (K) {
    return { id: q.id, error: K instanceof Error ? K.message : String(K) };
  }
}
async function Aq(q, K) {
  if (!K) return !1;
  return (
    ((
      await q.vault.read({
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
var o = 16,
  D = "ocr-v1",
  i = "built-in",
  Fq = a,
  kq = r,
  Bq = async () => {
    let q = E("pdfjs-dist/legacy/build/pdf.mjs");
    return import(qK(q).href);
  },
  Cq = Bq;
function uK(q) {
  ((Fq = q?.recognize ?? a),
    (kq = q?.weightsPresent ?? r),
    (Cq = q?.loadPdfJs ?? Bq));
}
function t(q, K, Q) {
  if (!q) return [];
  if (!Array.isArray(q.regions))
    return typeof q.text === "string" && q.text.trim()
      ? [{ text: q.text, order: 0 }]
      : [];
  return q.regions.flatMap((Z, $) => {
    if (!Z || typeof Z.text !== "string") return [];
    let W = Z.confidence;
    if (W !== void 0 && (typeof W !== "number" || W < 0 || W > 1)) return [];
    let J = Array.isArray(Z.box) && Z.box.length === 4 ? Z.box : null,
      V =
        J &&
        J.every(
          (G) => typeof G === "number" && Number.isSafeInteger(G) && G >= 0
        ) &&
        J[2] > 0 &&
        J[3] > 0 &&
        (!K || J[0] + J[2] <= K) &&
        (!Q || J[1] + J[3] <= Q);
    return [
      {
        text: Z.text,
        order: $,
        ...(V ? { box: J } : {}),
        ...(W === void 0 ? {} : { confidence: W }),
      },
    ];
  });
}
function Nq(q) {
  return [...q]
    .sort((K, Q) =>
      K.box && Q.box
        ? K.box[1] - Q.box[1] || K.box[0] - Q.box[0]
        : K.order - Q.order
    )
    .map((K) => K.text).join(`
`);
}
function _q() {
  return kq() ? y : null;
}
function KK(q) {
  let K = q?.capture;
  if (!K || typeof K !== "object") return null;
  if (typeof K.bytes !== "string" || !K.bytes)
    throw Error("capture OCR needs base64 content bytes");
  if (
    typeof K.mediaType !== "string" ||
    (!K.mediaType.startsWith("image/") && K.mediaType !== "application/pdf")
  )
    throw Error("capture OCR needs an image or PDF media type");
  return K;
}
async function e(q) {
  let K = await Fq(q);
  if (!K || K.error) throw Error(K?.error ?? "OCR returned no result");
  return K;
}
async function QK(q) {
  globalThis.DOMMatrix ??= class {
    constructor(G = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = G;
    }
  };
  let K = await Cq(),
    Q = Buffer.from(q.bytes, "base64"),
    Z = await K.getDocument({ data: new Uint8Array(Q), disableWorker: !0 })
      .promise,
    $ = [],
    W,
    J = Math.min(Z.numPages, 64);
  for (let V = 1; V <= J; V += 1) {
    let Y = (await (await Z.getPage(V)).getTextContent()).items
      .flatMap((k) =>
        k && typeof k === "object" && "str" in k ? [String(k.str).trim()] : []
      )
      .filter(Boolean)
      .join(" ");
    if (Y) {
      $.push({ text: Y, page: V });
      continue;
    }
    let X = await import(E("@napi-rs/canvas"));
    ((globalThis.DOMMatrix = X.DOMMatrix),
      (globalThis.ImageData = X.ImageData),
      (globalThis.Path2D = X.Path2D));
    class F {
      create(k, _) {
        let N = X.createCanvas(k, _);
        return { canvas: N, context: N.getContext("2d") };
      }
      reset(k, _, N) {
        ((k.canvas.width = _), (k.canvas.height = N));
      }
      destroy(k) {
        ((k.canvas.width = 0), (k.canvas.height = 0));
      }
    }
    W ??= await K.getDocument({
      data: new Uint8Array(Q),
      disableWorker: !0,
      CanvasFactory: F,
    }).promise;
    let H = await W.getPage(V),
      j = H.getViewport({ scale: 2 }),
      L = X.createCanvas(Math.ceil(j.width), Math.ceil(j.height)),
      C = L.getContext("2d");
    await H.render({ canvas: L, canvasContext: C, viewport: j }).promise;
    let B = L.toBuffer("image/png").toString("base64"),
      A = await e({ id: `capture:${V}`, bytes: B, mediaType: "image/png" });
    for (let k of A.regions ?? []) $.push({ ...k, page: V });
  }
  return { id: "capture", regions: $ };
}
async function ZK(q) {
  if (!_q())
    throw Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  let K =
      q.mediaType === "application/pdf"
        ? await QK(q)
        : await e({ id: "capture", bytes: q.bytes, mediaType: q.mediaType }),
    Q = t(K),
    Z = Q.filter((J) => J.confidence !== void 0),
    $ = Z.length ? Z.reduce((J, V) => J + V.confidence, 0) / Z.length : void 0,
    W = Nq(Q);
  return {
    summary: W ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: W,
      engine: "automation",
      model: y,
      ...($ === void 0 ? {} : { confidence: $ }),
    },
  };
}
async function $K(q, K, Q) {
  let $ = (
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
  if (!$) return "";
  return (
    await q.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: $.content_id },
        { column: "variant", op: "eq", value: "text" },
        { column: "profile", op: "eq", value: Q },
      ],
      limit: 1,
    })
  ).rows?.[0]?.model === K
    ? $.asset_id
    : "";
}
async function JK(q, K) {
  let Q = await q.vault.content({
    contentId: K.content_id,
    variant: "preview",
    maxBytes: 4194304,
  });
  if (Q?.status !== "ok" || Q.kind !== "bytes") return null;
  let Z = await e({
    id: K.content_id,
    bytes: Q.base64,
    mediaType: Q.mediaType,
    originalWidth: K.width,
    originalHeight: K.height,
  });
  return t(Z, K.width, K.height);
}
async function WK({ ctx: q, log: K }) {
  let Q = KK(q.input);
  if (Q) return ZK(Q);
  let Z = q.input?.variant === "delegate",
    $ = Z ? q.input?.delegateModel : _q();
  if (!$) {
    if (Z) throw Error("delegate OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  let W = q.input?.promptRev;
  if (Z && W && W !== D)
    throw Error(
      `delegate OCR: the engine profile pins prompt revision "${W}", but this handler ships "${D}"`
    );
  let J = q.input?.profileId ?? i,
    V = J === i ? "" : `:${J}`,
    G = `${Z ? "delegate" : "deterministic"}:${$}:${Z ? D : "local"}${V}`,
    U = await q.state.get("selection");
  if (U !== G) {
    let A = U === void 0 && !Z ? await $K(q, $, J) : "";
    (await q.state.set("cursor", A),
      await q.state.set("selection", G),
      await q.state.delete("confirmedModel"));
  }
  let Y = (await q.state.get("cursor")) ?? "",
    X = await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: Y },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: o,
    }),
    F = (X.rows ?? []).filter((A) => A.kind === "photo" || A.kind === "scan"),
    H = 0,
    j = 0,
    L = 0,
    C = "",
    B = new Set();
  for (let A of F) {
    let _ = (
        await q.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: A.content_id },
            { column: "variant", op: "eq", value: "text" },
            { column: "profile", op: "eq", value: J },
          ],
          limit: 1,
        })
      ).rows?.[0],
      N = Z ? await q.state.get("confirmedModel") : $,
      zq =
        typeof _?.payload_json === "string"
          ? JSON.parse(_.payload_json).prompt_rev
          : _?.prompt_rev;
    if (_?.model === N && (!Z || zq === D)) {
      j += 1;
      continue;
    }
    let qq = !1,
      O;
    if (Z) {
      let z = await q.delegate({
        prompt:
          "Transcribe all visible text in reading order. Return regions with text and optional [x,y,w,h] boxes; never invent confidence.",
        json: {
          type: "object",
          required: ["regions"],
          properties: { regions: { type: "array" } },
        },
        content: [
          { contentId: A.content_id, variant: "preview", maxBytes: 4194304 },
        ],
      });
      if (typeof z?.__centraidModel !== "string")
        throw Error("delegate OCR returned no ACP-confirmed model identity");
      ((N = z.__centraidModel),
        await q.state.set("confirmedModel", N),
        (O = t(z, A.width, A.height)));
    } else if (((O = await JK(q, A)), O === null)) {
      if (await Aq(q, A.content_id)) {
        ((j += 1),
          K.info(`photo ${A.asset_id}: no preview this codec can produce`));
        continue;
      }
      ((L += 1),
        (qq = !0),
        K.info(`photo ${A.asset_id}: preview has not landed yet`));
    }
    if (qq) {
      B.add(A.asset_id);
      continue;
    }
    let Kq = Nq(O);
    if (!Kq) {
      ((j += 1), K.info(`photo ${A.asset_id}: no legible text`));
      continue;
    }
    let u = O.filter((z) => z.confidence !== void 0),
      Qq = u.length
        ? u.reduce((z, m) => z + m.confidence, 0) / u.length
        : void 0,
      Oq = O.map(({ order: z, ...m }) => m);
    (await q.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: A.content_id,
        text: Kq,
        capability: "ocr",
        model: N,
        regions: Oq,
        ...(J === i ? {} : { profile: J }),
        ...(Z ? { prompt_rev: D } : {}),
        ...(Qq === void 0 ? {} : { confidence: Qq }),
      },
    }),
      (H += 1));
  }
  for (let A of X.rows ?? []) {
    if (B.has(A.asset_id)) break;
    C = A.asset_id;
  }
  if (C) await q.state.set("cursor", C);
  return {
    summary: `OCR derived ${H}; skipped ${j}; not ready ${L}; batch ${X.rows?.length ?? 0}/${o}`,
    output: {
      derived: H,
      skipped: j,
      notReady: L,
      model: Z ? ((await q.state.get("confirmedModel")) ?? $) : $,
      rearm: (X.rows?.length ?? 0) === o,
    },
  };
}
export { uK as setPhotoOcrRuntimeForTests, WK as default };
