import { existsSync as bq } from "node:fs";
import { readFile as uq } from "node:fs/promises";
import _ from "node:path";
import E from "node:path";
// governance: allow-repo-hygiene file-size-limit (#731) the self-contained OCR/PDF handler is one deployable runtime unit; splitting its bundled model/runtime rail would duplicate the content-resolution and bounded-batch invariants.
// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { pathToFileURL as oq } from "node:url";
var Nq = E.resolve(import.meta.dirname, ".."),
  Cq = "__centraidAutomationRuntimeDir";
function zq() {
  let q = globalThis[Cq];
  if (typeof q === "string" && q.length > 0) return E.resolve(q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return E.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return E.join(Nq, "runtime");
}
var u = zq(),
  m = E.join(u, "models");
function Oq(q) {
  if (q.length === 0) throw Error("argmax: row must be non-empty");
  let K = 0,
    Q = q[0];
  for (let Z = 1; Z < q.length; Z++) {
    let $ = q[Z];
    if ($ > Q) ((Q = $), (K = Z));
  }
  return { index: K, value: Q };
}
function Qq(q, K, Q = 0) {
  let Z = [],
    $ = [],
    W;
  for (let V of q) {
    let { index: G, value: X } = Oq(V);
    if (G !== W && G !== Q) {
      let Y = K[G];
      if (Y !== void 0) (Z.push(Y), $.push(X));
    }
    W = G;
  }
  let J = $.length === 0 ? 0 : $.reduce((V, G) => V + G, 0) / $.length;
  return { text: Z.join(""), confidence: J };
}
function Zq(q, K, Q, Z) {
  let $ = Math.max(q, K),
    W = $ > Q ? Q / $ : 1,
    J = (V) => Math.max(Z, Math.round((V * W) / Z) * Z);
  return { width: J(q), height: J(K) };
}
function g(q, K, Q) {
  let Z = Q.width / K.width,
    $ = Q.height / K.height;
  return { x: q.x * Z, y: q.y * $, width: q.width * Z, height: q.height * $ };
}
function $q(q) {
  return [
    Math.round(q.x),
    Math.round(q.y),
    Math.round(q.width),
    Math.round(q.height),
  ];
}
function Jq(q, K, Q) {
  let Z = Math.max(0, Math.min(K, Math.round(q.x))),
    $ = Math.max(0, Math.min(Q, Math.round(q.y))),
    W = Math.max(Z, Math.min(K, Math.round(q.x + q.width))),
    J = Math.max($, Math.min(Q, Math.round(q.y + q.height)));
  return [Z, $, W - Z, J - $];
}
function _q(q, K, Q, Z = 0.3) {
  let $ = new Uint8Array(K * Q);
  for (let W = 0; W < $.length; W++) $[W] = (q[W] ?? 0) >= Z ? 1 : 0;
  return $;
}
function Mq(q, K, Q, Z = 1) {
  let $ = new Uint8Array(K * Q),
    W = [],
    J = [];
  for (let V = 0; V < q.length; V++) {
    if (!q[V] || $[V]) continue;
    (J.push(V), ($[V] = 1));
    let {
        POSITIVE_INFINITY: G,
        POSITIVE_INFINITY: X,
        NEGATIVE_INFINITY: Y,
        NEGATIVE_INFINITY: U,
      } = Number,
      A = 0;
    while (J.length > 0) {
      let H = J.pop(),
        j = H % K,
        L = Math.floor(H / K);
      ((G = Math.min(G, j)),
        (X = Math.min(X, L)),
        (Y = Math.max(Y, j)),
        (U = Math.max(U, L)),
        A++);
      let B = [
        j > 0 ? H - 1 : -1,
        j < K - 1 ? H + 1 : -1,
        L > 0 ? H - K : -1,
        L < Q - 1 ? H + K : -1,
      ];
      for (let N of B) if (N >= 0 && q[N] && !$[N]) (($[N] = 1), J.push(N));
    }
    if (A >= Z)
      W.push({
        box: { x: G, y: X, width: Y - G + 1, height: U - X + 1 },
        area: A,
      });
  }
  return W;
}
function Eq(q, K, Q = 1.5) {
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
function Tq(q, K, Q) {
  let Z = Math.max(0, Math.min(K, Math.round(q.x))),
    $ = Math.max(0, Math.min(Q, Math.round(q.y))),
    W = Math.max(0, Math.min(K, Math.round(q.x + q.width))),
    J = Math.max(0, Math.min(Q, Math.round(q.y + q.height)));
  return { x: Z, y: $, width: Math.max(0, W - Z), height: Math.max(0, J - $) };
}
function Dq(q, K, Q) {
  let Z = Math.max(0, Math.floor(Q.x)),
    $ = Math.max(0, Math.floor(Q.y)),
    W = Math.max(Z, Math.ceil(Q.x + Q.width)),
    J = Math.max($, Math.ceil(Q.y + Q.height)),
    V = 0,
    G = 0;
  for (let X = $; X < J; X++)
    for (let Y = Z; Y < W; Y++) ((V += q[X * K + Y] ?? 0), G++);
  return G === 0 ? 0 : V / G;
}
function Wq(q, K, Q, Z = {}) {
  let {
      binaryThreshold: $ = 0.3,
      boxScoreThreshold: W = 0.5,
      unclipRatio: J = 1.5,
      minArea: V = 4,
    } = Z,
    G = _q(q, K, Q, $),
    X = Mq(G, K, Q, V),
    Y = [];
  for (let U of X) {
    let A = Dq(q, K, U.box);
    if (A < W) continue;
    let H = Eq(U.box, U.area, J),
      j = Tq(H, K, Q);
    if (j.width <= 0 || j.height <= 0) continue;
    Y.push({ box: j, score: A });
  }
  return Y;
}
import { existsSync as h, readFileSync as Pq, statSync as Iq } from "node:fs";
import I from "node:path";
import { pathToFileURL as Sq } from "node:url";
var D;
class S extends Error {
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
function O(q, K = u) {
  let Q = I.join(K, "node_modules");
  if (!h(Q)) throw new S(q);
  let Z = I.join(Q, ...q.split("/"));
  try {
    let $ = Gq(Z);
    if ($ === null) throw Error(`no entry point in ${Z}`);
    return $;
  } catch ($) {
    throw new S(q, $);
  }
}
function Gq(q, K = 0) {
  let Q = I.join(q, "package.json"),
    Z = h(Q) ? JSON.parse(Pq(Q, "utf8")) : {},
    $ = [
      ...x(Rq(Z.exports)),
      ...(typeof Z.main === "string" ? [Z.main] : []),
      "index.js",
    ];
  for (let W of $) {
    let J = fq(I.resolve(q, W), K);
    if (J !== null) return J;
  }
  return null;
}
function fq(q, K) {
  let Q = Vq(q);
  if (Q?.isFile()) return q;
  if (Q?.isDirectory()) return K >= 4 ? null : Gq(q, K + 1);
  for (let Z of [".js", ".json", ".node"]) {
    let $ = `${q}${Z}`;
    if (Vq($)?.isFile()) return $;
  }
  return null;
}
function Vq(q) {
  try {
    return Iq(q);
  } catch {
    return null;
  }
}
function Rq(q) {
  if (typeof q === "string") return q;
  if (q === null || typeof q !== "object") return;
  let K = q;
  return "." in K ? K["."] : K;
}
function x(q, K = 0) {
  if (typeof q === "string") return [q];
  if (K > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap(($) => x($, K + 1));
  let Q = q,
    Z = [];
  for (let $ of ["require", "node", "default"])
    if ($ in Q) Z.push(...x(Q[$], K + 1));
  return Z;
}
async function f() {
  if (D) return D;
  let q = O("onnxruntime-node");
  return ((D = await import(Sq(q).href)), D);
}
var P;
async function p(q) {
  P ??= new Map();
  let K = P.get(q);
  if (K) return K;
  if (!h(q)) throw new S(q);
  let Q = f().then((Z) => Z.InferenceSession.create(q));
  P.set(q, Q);
  try {
    return await Q;
  } catch (Z) {
    throw (P.delete(q), Z);
  }
}
import { pathToFileURL as vq } from "node:url";
var R;
async function l() {
  if (R) return R;
  let q = O("sharp");
  return ((R = (await import(vq(q).href)).default), R);
}
async function c(q) {
  let Q = (await l())(Buffer.from(q)),
    { data: Z, info: $ } = await Q.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(Z.buffer, Z.byteOffset, Z.byteLength),
    width: $.width,
    height: $.height,
  };
}
async function Yq(q, K, Q) {
  let $ = (await l())(Buffer.from(q)),
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
  for (let X = 0; X < V; X++) {
    let Y = ((Z + X) * q.width + Q) * 3,
      U = X * J * 3;
    G.set(q.data.subarray(Y, Y + J * 3), U);
  }
  return { data: G, width: J, height: V };
}
async function Uq(q, K, Q) {
  let $ = (await l())(Buffer.from(q.data), {
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
var yq = [0.485, 0.456, 0.406],
  wq = [0.229, 0.224, 0.225];
function d(q) {
  let { width: K, height: Q, data: Z } = q,
    $ = K * Q,
    W = new Float32Array($ * 3);
  for (let J = 0; J < $; J++)
    for (let V = 0; V < 3; V++) {
      let G = (Z[J * 3 + V] ?? 0) / 255;
      W[V * $ + J] = (G - yq[V]) / wq[V];
    }
  return W;
}
var s = "pp-ocrv4@1",
  n = _.join(m, "ocr"),
  mq = _.join(n, "det.onnx"),
  gq = _.join(n, "rec.onnx"),
  xq = _.join(n, "dict.txt"),
  hq = 960,
  pq = 32,
  v = 48,
  lq = 320;
function r(q = m) {
  let K = _.join(q, "ocr");
  return ["det.onnx", "rec.onnx", "dict.txt"].every((Q) => bq(_.join(K, Q)));
}
function cq(q) {
  return ["", ...q, " "];
}
function dq(q) {
  let K = q.split(/\r?\n/u);
  if (K.at(-1) === "") K.pop();
  return K;
}
var y;
async function sq() {
  if (y) return y;
  let q = await uq(xq, "utf8");
  return ((y = cq(dq(q))), y);
}
async function nq(q) {
  let K = await c(q),
    Q = Zq(K.width, K.height, hq, pq),
    Z = await Yq(q, Q.width, Q.height),
    $ = d(Z),
    W = await f(),
    J = await p(mq),
    V = J.inputNames[0] ?? "x",
    G = await J.run({
      [V]: new W.Tensor("float32", $, [1, 3, Q.height, Q.width]),
    }),
    X = J.outputNames[0],
    Y = X ? G[X]?.data : void 0;
  if (!Y || !(Y instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: Wq(Y, Q.width, Q.height).map(({ box: H, score: j }) => ({
      box: $q(g(H, Q, K)),
      score: j,
    })),
    native: K,
  };
}
async function rq(q) {
  let K = v / q.height,
    Q = Math.min(lq, Math.max(v, Math.round(q.width * K))),
    Z = await Uq(q, Q, v),
    $ = d(Z),
    W = await f(),
    J = await p(gq),
    V = J.inputNames[0] ?? "x",
    G = await J.run({ [V]: new W.Tensor("float32", $, [1, 3, v, Q]) }),
    X = J.outputNames[0],
    Y = X ? G[X] : void 0;
  if (!Y || !(Y.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let U = await sq(),
    A = U.length,
    H = Y.data.length / A,
    j = [];
  for (let L = 0; L < H; L++) {
    let B = Array.from(Y.data.subarray(L * A, (L + 1) * A));
    j.push(B);
  }
  return Qq(j, U);
}
async function o(q) {
  try {
    let K = Buffer.from(q.bytes, "base64"),
      { boxes: Q, native: Z } = await nq(K),
      $ = await c(K),
      W =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: Z.width, height: Z.height },
      V = (
        await Promise.all(
          Q.map(async (G) => {
            let [X, Y, U, A] = G.box,
              H = Xq($, { x: X, y: Y, width: U, height: A });
            if (H.width <= 0 || H.height <= 0) return;
            let j = await rq(H);
            if (!j.text) return;
            let L = Jq(
              g({ x: X, y: Y, width: U, height: A }, Z, W),
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
var a = 16,
  T = "ocr-v1",
  i = "built-in",
  jq = o,
  Hq = r,
  Lq = async () => {
    let q = O("pdfjs-dist/legacy/build/pdf.mjs");
    return import(oq(q).href);
  },
  Aq = Lq;
function PK(q) {
  ((jq = q?.recognize ?? o),
    (Hq = q?.weightsPresent ?? r),
    (Aq = q?.loadPdfJs ?? Lq));
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
function Fq(q) {
  return [...q]
    .sort((K, Q) =>
      K.box && Q.box
        ? K.box[1] - Q.box[1] || K.box[0] - Q.box[0]
        : K.order - Q.order
    )
    .map((K) => K.text).join(`
`);
}
function Bq() {
  return Hq() ? s : null;
}
function aq(q) {
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
  let K = await jq(q);
  if (!K || K.error) throw Error(K?.error ?? "OCR returned no result");
  return K;
}
async function iq(q) {
  globalThis.DOMMatrix ??= class {
    constructor(G = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = G;
    }
  };
  let K = await Aq(),
    Q = Buffer.from(q.bytes, "base64"),
    Z = await K.getDocument({ data: new Uint8Array(Q), disableWorker: !0 })
      .promise,
    $ = [],
    W,
    J = Math.min(Z.numPages, 64);
  for (let V = 1; V <= J; V += 1) {
    let Y = (await (await Z.getPage(V)).getTextContent()).items
      .flatMap((F) =>
        F && typeof F === "object" && "str" in F ? [String(F.str).trim()] : []
      )
      .filter(Boolean)
      .join(" ");
    if (Y) {
      $.push({ text: Y, page: V });
      continue;
    }
    let U = await import(O("@napi-rs/canvas"));
    ((globalThis.DOMMatrix = U.DOMMatrix),
      (globalThis.ImageData = U.ImageData),
      (globalThis.Path2D = U.Path2D));
    class A {
      create(F, M) {
        let k = U.createCanvas(F, M);
        return { canvas: k, context: k.getContext("2d") };
      }
      reset(F, M, k) {
        ((F.canvas.width = M), (F.canvas.height = k));
      }
      destroy(F) {
        ((F.canvas.width = 0), (F.canvas.height = 0));
      }
    }
    W ??= await K.getDocument({
      data: new Uint8Array(Q),
      disableWorker: !0,
      CanvasFactory: A,
    }).promise;
    let H = await W.getPage(V),
      j = H.getViewport({ scale: 2 }),
      L = U.createCanvas(Math.ceil(j.width), Math.ceil(j.height)),
      B = L.getContext("2d");
    await H.render({ canvas: L, canvasContext: B, viewport: j }).promise;
    let N = L.toBuffer("image/png").toString("base64"),
      z = await e({ id: `capture:${V}`, bytes: N, mediaType: "image/png" });
    for (let F of z.regions ?? []) $.push({ ...F, page: V });
  }
  return { id: "capture", regions: $ };
}
async function tq(q) {
  if (!Bq())
    throw Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  let K =
      q.mediaType === "application/pdf"
        ? await iq(q)
        : await e({ id: "capture", bytes: q.bytes, mediaType: q.mediaType }),
    Q = t(K),
    Z = Q.filter((J) => J.confidence !== void 0),
    $ = Z.length ? Z.reduce((J, V) => J + V.confidence, 0) / Z.length : void 0,
    W = Fq(Q);
  return {
    summary: W ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: W,
      engine: "automation",
      model: s,
      ...($ === void 0 ? {} : { confidence: $ }),
    },
  };
}
async function eq(q, K, Q) {
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
async function qK(q, K) {
  let Q = await q.vault.content({
    contentId: K.content_id,
    variant: "preview",
    maxBytes: 4194304,
  });
  if (Q?.status !== "ok" || Q.kind !== "bytes")
    throw Error(`asset ${K.asset_id}: preview is unavailable`);
  let Z = await e({
    id: K.content_id,
    bytes: Q.base64,
    mediaType: Q.mediaType,
    originalWidth: K.width,
    originalHeight: K.height,
  });
  return t(Z, K.width, K.height);
}
async function KK({ ctx: q, log: K }) {
  let Q = aq(q.input);
  if (Q) return tq(Q);
  let Z = q.input?.variant === "delegate",
    $ = Z ? q.input?.delegateModel : Bq();
  if (!$) {
    if (Z) throw Error("delegate OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  let W = q.input?.promptRev;
  if (Z && W && W !== T)
    throw Error(
      `delegate OCR: the engine profile pins prompt revision "${W}", but this handler ships "${T}"`
    );
  let J = q.input?.profileId ?? i,
    V = J === i ? "" : `:${J}`,
    G = `${Z ? "delegate" : "deterministic"}:${$}:${Z ? T : "local"}${V}`,
    X = await q.state.get("selection");
  if (X !== G) {
    let B = X === void 0 && !Z ? await eq(q, $, J) : "";
    (await q.state.set("cursor", B),
      await q.state.set("selection", G),
      await q.state.delete("confirmedModel"));
  }
  let Y = (await q.state.get("cursor")) ?? "",
    U = await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: Y },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: a,
    }),
    A = (U.rows ?? []).filter((B) => B.kind === "photo" || B.kind === "scan"),
    H = 0,
    j = 0;
  for (let B of A) {
    let z = (
        await q.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: B.content_id },
            { column: "variant", op: "eq", value: "text" },
            { column: "profile", op: "eq", value: J },
          ],
          limit: 1,
        })
      ).rows?.[0],
      F = Z ? await q.state.get("confirmedModel") : $,
      M =
        typeof z?.payload_json === "string"
          ? JSON.parse(z.payload_json).prompt_rev
          : z?.prompt_rev;
    if (z?.model === F && (!Z || M === T)) {
      j += 1;
      continue;
    }
    let k;
    if (Z) {
      let C = await q.delegate({
        prompt:
          "Transcribe all visible text in reading order. Return regions with text and optional [x,y,w,h] boxes; never invent confidence.",
        json: {
          type: "object",
          required: ["regions"],
          properties: { regions: { type: "array" } },
        },
        content: [
          { contentId: B.content_id, variant: "preview", maxBytes: 4194304 },
        ],
      });
      if (typeof C?.__centraidModel !== "string")
        throw Error("delegate OCR returned no ACP-confirmed model identity");
      ((F = C.__centraidModel),
        await q.state.set("confirmedModel", F),
        (k = t(C, B.width, B.height)));
    } else k = await qK(q, B);
    let qq = Fq(k);
    if (!qq) {
      ((j += 1), K.info(`photo ${B.asset_id}: no legible text`));
      continue;
    }
    let w = k.filter((C) => C.confidence !== void 0),
      Kq = w.length
        ? w.reduce((C, b) => C + b.confidence, 0) / w.length
        : void 0,
      kq = k.map(({ order: C, ...b }) => b);
    (await q.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: B.content_id,
        text: qq,
        capability: "ocr",
        model: F,
        regions: kq,
        ...(J === i ? {} : { profile: J }),
        ...(Z ? { prompt_rev: T } : {}),
        ...(Kq === void 0 ? {} : { confidence: Kq }),
      },
    }),
      (H += 1));
  }
  let L = U.rows?.at(-1)?.asset_id;
  if (L) await q.state.set("cursor", L);
  return {
    summary: `OCR derived ${H}; skipped ${j}; batch ${U.rows?.length ?? 0}/${a}`,
    output: {
      derived: H,
      skipped: j,
      model: Z ? ((await q.state.get("confirmedModel")) ?? $) : $,
      rearm: (U.rows?.length ?? 0) === a,
    },
  };
}
export { PK as setPhotoOcrRuntimeForTests, KK as default };
