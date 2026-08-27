import { existsSync as uq } from "node:fs";
import { readFile as mq } from "node:fs/promises";
import M from "node:path";
import D from "node:path";
// governance: allow-repo-hygiene file-size-limit (#731) the self-contained OCR/PDF handler is one deployable runtime unit; splitting its bundled model/runtime rail would duplicate the content-resolution and bounded-batch invariants.
// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { pathToFileURL as aq } from "node:url";
var Cq = D.resolve(import.meta.dirname, ".."),
  zq = "__centraidAutomationRuntimeDir";
function _q() {
  let q = globalThis[zq];
  if (typeof q === "string" && q.length > 0) return D.resolve(q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return D.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return D.join(Cq, "runtime");
}
var m = _q(),
  g = D.join(m, "models");
function Mq(q) {
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
    let { index: G, value: X } = Mq(V);
    if (G !== W && G !== Q) {
      let Y = K[G];
      if (Y !== void 0) (Z.push(Y), $.push(X));
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
function x(q, K, Q) {
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
function Oq(q, K, Q, Z = 0.3) {
  let $ = new Uint8Array(K * Q);
  for (let W = 0; W < $.length; W++) $[W] = (q[W] ?? 0) >= Z ? 1 : 0;
  return $;
}
function Tq(q, K, Q, Z = 1) {
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
        NEGATIVE_INFINITY: j,
      } = Number,
      A = 0;
    while (J.length > 0) {
      let U = J.pop(),
        H = U % K,
        L = Math.floor(U / K);
      ((G = Math.min(G, H)),
        (X = Math.min(X, L)),
        (Y = Math.max(Y, H)),
        (j = Math.max(j, L)),
        A++);
      let B = [
        H > 0 ? U - 1 : -1,
        H < K - 1 ? U + 1 : -1,
        L > 0 ? U - K : -1,
        L < Q - 1 ? U + K : -1,
      ];
      for (let N of B) if (N >= 0 && q[N] && !$[N]) (($[N] = 1), J.push(N));
    }
    if (A >= Z)
      W.push({
        box: { x: G, y: X, width: Y - G + 1, height: j - X + 1 },
        area: A,
      });
  }
  return W;
}
function Dq(q, K, Q = 1.5) {
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
function Eq(q, K, Q) {
  let Z = Math.max(0, Math.min(K, Math.round(q.x))),
    $ = Math.max(0, Math.min(Q, Math.round(q.y))),
    W = Math.max(0, Math.min(K, Math.round(q.x + q.width))),
    J = Math.max(0, Math.min(Q, Math.round(q.y + q.height)));
  return { x: Z, y: $, width: Math.max(0, W - Z), height: Math.max(0, J - $) };
}
function Iq(q, K, Q) {
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
function Vq(q, K, Q, Z = {}) {
  let {
      binaryThreshold: $ = 0.3,
      boxScoreThreshold: W = 0.5,
      unclipRatio: J = 1.5,
      minArea: V = 4,
    } = Z,
    G = Oq(q, K, Q, $),
    X = Tq(G, K, Q, V),
    Y = [];
  for (let j of X) {
    let A = Iq(q, K, j.box);
    if (A < W) continue;
    let U = Dq(j.box, j.area, J),
      H = Eq(U, K, Q);
    if (H.width <= 0 || H.height <= 0) continue;
    Y.push({ box: H, score: A });
  }
  return Y;
}
import { existsSync as p, readFileSync as Pq, statSync as Sq } from "node:fs";
import S from "node:path";
import { pathToFileURL as fq } from "node:url";
var I;
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
function _(q, K = m) {
  let Q = S.join(K, "node_modules");
  if (!p(Q)) throw new f(q);
  let Z = S.join(Q, ...q.split("/"));
  try {
    let $ = Yq(Z);
    if ($ === null) throw Error(`no entry point in ${Z}`);
    return $;
  } catch ($) {
    throw new f(q, $);
  }
}
function Yq(q, K = 0) {
  let Q = S.join(q, "package.json"),
    Z = p(Q) ? JSON.parse(Pq(Q, "utf8")) : {},
    $ = [
      ...h(Rq(Z.exports)),
      ...(typeof Z.main === "string" ? [Z.main] : []),
      "index.js",
    ];
  for (let W of $) {
    let J = vq(S.resolve(q, W), K);
    if (J !== null) return J;
  }
  return null;
}
function vq(q, K) {
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
    return Sq(q);
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
function h(q, K = 0) {
  if (typeof q === "string") return [q];
  if (K > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap(($) => h($, K + 1));
  let Q = q,
    Z = [];
  for (let $ of ["require", "node", "default"])
    if ($ in Q) Z.push(...h(Q[$], K + 1));
  return Z;
}
async function v() {
  if (I) return I;
  let q = _("onnxruntime-node");
  return ((I = await import(fq(q).href)), I);
}
var P;
async function l(q) {
  P ??= new Map();
  let K = P.get(q);
  if (K) return K;
  if (!p(q)) throw new f(q);
  let Q = v().then((Z) => Z.InferenceSession.create(q));
  P.set(q, Q);
  try {
    return await Q;
  } catch (Z) {
    throw (P.delete(q), Z);
  }
}
import { pathToFileURL as yq } from "node:url";
var R;
async function c() {
  if (R) return R;
  let q = _("sharp");
  return ((R = (await import(yq(q).href)).default), R);
}
async function d(q) {
  let Q = (await c())(Buffer.from(q)),
    { data: Z, info: $ } = await Q.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(Z.buffer, Z.byteOffset, Z.byteLength),
    width: $.width,
    height: $.height,
  };
}
async function Xq(q, K, Q) {
  let $ = (await c())(Buffer.from(q)),
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
function jq(q, K) {
  let Q = Math.max(0, Math.min(q.width, Math.round(K.x))),
    Z = Math.max(0, Math.min(q.height, Math.round(K.y))),
    $ = Math.max(Q, Math.min(q.width, Math.round(K.x + K.width))),
    W = Math.max(Z, Math.min(q.height, Math.round(K.y + K.height))),
    J = $ - Q,
    V = W - Z,
    G = new Uint8Array(J * V * 3);
  for (let X = 0; X < V; X++) {
    let Y = ((Z + X) * q.width + Q) * 3,
      j = X * J * 3;
    G.set(q.data.subarray(Y, Y + J * 3), j);
  }
  return { data: G, width: J, height: V };
}
async function Hq(q, K, Q) {
  let $ = (await c())(Buffer.from(q.data), {
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
var wq = [0.485, 0.456, 0.406],
  bq = [0.229, 0.224, 0.225];
function s(q) {
  let { width: K, height: Q, data: Z } = q,
    $ = K * Q,
    W = new Float32Array($ * 3);
  for (let J = 0; J < $; J++)
    for (let V = 0; V < 3; V++) {
      let G = (Z[J * 3 + V] ?? 0) / 255;
      W[V * $ + J] = (G - wq[V]) / bq[V];
    }
  return W;
}
var n = "pp-ocrv4@1",
  r = M.join(g, "ocr"),
  gq = M.join(r, "det.onnx"),
  xq = M.join(r, "rec.onnx"),
  hq = M.join(r, "dict.txt"),
  pq = 960,
  lq = 32,
  y = 48,
  cq = 320;
function o(q = g) {
  let K = M.join(q, "ocr");
  return ["det.onnx", "rec.onnx", "dict.txt"].every((Q) => uq(M.join(K, Q)));
}
function dq(q) {
  return ["", ...q, " "];
}
function sq(q) {
  let K = q.split(/\r?\n/u);
  if (K.at(-1) === "") K.pop();
  return K;
}
var w;
async function nq() {
  if (w) return w;
  let q = await mq(hq, "utf8");
  return ((w = dq(sq(q))), w);
}
async function rq(q) {
  let K = await d(q),
    Q = $q(K.width, K.height, pq, lq),
    Z = await Xq(q, Q.width, Q.height),
    $ = s(Z),
    W = await v(),
    J = await l(gq),
    V = J.inputNames[0] ?? "x",
    G = await J.run({
      [V]: new W.Tensor("float32", $, [1, 3, Q.height, Q.width]),
    }),
    X = J.outputNames[0],
    Y = X ? G[X]?.data : void 0;
  if (!Y || !(Y instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: Vq(Y, Q.width, Q.height).map(({ box: U, score: H }) => ({
      box: Jq(x(U, Q, K)),
      score: H,
    })),
    native: K,
  };
}
async function oq(q) {
  let K = y / q.height,
    Q = Math.min(cq, Math.max(y, Math.round(q.width * K))),
    Z = await Hq(q, Q, y),
    $ = s(Z),
    W = await v(),
    J = await l(xq),
    V = J.inputNames[0] ?? "x",
    G = await J.run({ [V]: new W.Tensor("float32", $, [1, 3, y, Q]) }),
    X = J.outputNames[0],
    Y = X ? G[X] : void 0;
  if (!Y || !(Y.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let j = await nq(),
    A = j.length,
    U = Y.data.length / A,
    H = [];
  for (let L = 0; L < U; L++) {
    let B = Array.from(Y.data.subarray(L * A, (L + 1) * A));
    H.push(B);
  }
  return Zq(H, j);
}
async function a(q) {
  try {
    let K = Buffer.from(q.bytes, "base64"),
      { boxes: Q, native: Z } = await rq(K),
      $ = await d(K),
      W =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: Z.width, height: Z.height },
      V = (
        await Promise.all(
          Q.map(async (G) => {
            let [X, Y, j, A] = G.box,
              U = jq($, { x: X, y: Y, width: j, height: A });
            if (U.width <= 0 || U.height <= 0) return;
            let H = await oq(U);
            if (!H.text) return;
            let L = Wq(
              x({ x: X, y: Y, width: j, height: A }, Z, W),
              W.width,
              W.height
            );
            if (L[2] <= 0 || L[3] <= 0) return;
            return { text: H.text, confidence: H.confidence, box: L };
          })
        )
      ).filter((G) => G !== void 0);
    return { id: q.id, regions: V };
  } catch (K) {
    return { id: q.id, error: K instanceof Error ? K.message : String(K) };
  }
}
var i = 16,
  O = "dpv:ServiceProvision",
  E = "ocr-v1",
  t = "built-in",
  Uq = a,
  Lq = o,
  Aq = async () => {
    let q = _("pdfjs-dist/legacy/build/pdf.mjs");
    return import(aq(q).href);
  },
  Fq = Aq;
function PK(q) {
  ((Uq = q?.recognize ?? a),
    (Lq = q?.weightsPresent ?? o),
    (Fq = q?.loadPdfJs ?? Aq));
}
function e(q, K, Q) {
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
function Bq(q) {
  return [...q]
    .sort((K, Q) =>
      K.box && Q.box
        ? K.box[1] - Q.box[1] || K.box[0] - Q.box[0]
        : K.order - Q.order
    )
    .map((K) => K.text).join(`
`);
}
function kq() {
  return Lq() ? n : null;
}
function iq(q) {
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
async function qq(q) {
  let K = await Uq(q);
  if (!K || K.error) throw Error(K?.error ?? "OCR returned no result");
  return K;
}
async function tq(q) {
  globalThis.DOMMatrix ??= class {
    constructor(G = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = G;
    }
  };
  let K = await Fq(),
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
    let j = await import(_("@napi-rs/canvas"));
    ((globalThis.DOMMatrix = j.DOMMatrix),
      (globalThis.ImageData = j.ImageData),
      (globalThis.Path2D = j.Path2D));
    class A {
      create(F, T) {
        let k = j.createCanvas(F, T);
        return { canvas: k, context: k.getContext("2d") };
      }
      reset(F, T, k) {
        ((F.canvas.width = T), (F.canvas.height = k));
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
    let U = await W.getPage(V),
      H = U.getViewport({ scale: 2 }),
      L = j.createCanvas(Math.ceil(H.width), Math.ceil(H.height)),
      B = L.getContext("2d");
    await U.render({ canvas: L, canvasContext: B, viewport: H }).promise;
    let N = L.toBuffer("image/png").toString("base64"),
      z = await qq({ id: `capture:${V}`, bytes: N, mediaType: "image/png" });
    for (let F of z.regions ?? []) $.push({ ...F, page: V });
  }
  return { id: "capture", regions: $ };
}
async function eq(q) {
  if (!kq())
    throw Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  let K =
      q.mediaType === "application/pdf"
        ? await tq(q)
        : await qq({ id: "capture", bytes: q.bytes, mediaType: q.mediaType }),
    Q = e(K),
    Z = Q.filter((J) => J.confidence !== void 0),
    $ = Z.length ? Z.reduce((J, V) => J + V.confidence, 0) / Z.length : void 0,
    W = Bq(Q);
  return {
    summary: W ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: W,
      engine: "automation",
      model: n,
      ...($ === void 0 ? {} : { confidence: $ }),
    },
  };
}
async function qK(q, K, Q) {
  let $ = (
    await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: O,
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
      purpose: O,
    })
  ).rows?.[0]?.model === K
    ? $.asset_id
    : "";
}
async function KK(q, K) {
  let Q = await q.vault.content({
    contentId: K.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: O,
  });
  if (Q?.status !== "ok" || Q.kind !== "bytes")
    throw Error(`asset ${K.asset_id}: preview is unavailable`);
  let Z = await qq({
    id: K.content_id,
    bytes: Q.base64,
    mediaType: Q.mediaType,
    originalWidth: K.width,
    originalHeight: K.height,
  });
  return e(Z, K.width, K.height);
}
async function QK({ ctx: q, log: K }) {
  let Q = iq(q.input);
  if (Q) return eq(Q);
  let Z = q.input?.variant === "delegate",
    $ = Z ? q.input?.delegateModel : kq();
  if (!$) {
    if (Z) throw Error("delegate OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  let W = q.input?.promptRev;
  if (Z && W && W !== E)
    throw Error(
      `delegate OCR: the engine profile pins prompt revision "${W}", but this handler ships "${E}"`
    );
  let J = q.input?.profileId ?? t,
    V = J === t ? "" : `:${J}`,
    G = `${Z ? "delegate" : "deterministic"}:${$}:${Z ? E : "local"}${V}`,
    X = await q.state.get("selection");
  if (X !== G) {
    let B = X === void 0 && !Z ? await qK(q, $, J) : "";
    (await q.state.set("cursor", B),
      await q.state.set("selection", G),
      await q.state.delete("confirmedModel"));
  }
  let Y = (await q.state.get("cursor")) ?? "",
    j = await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: Y },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: i,
      purpose: O,
    }),
    A = (j.rows ?? []).filter((B) => B.kind === "photo" || B.kind === "scan"),
    U = 0,
    H = 0;
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
          purpose: O,
        })
      ).rows?.[0],
      F = Z ? await q.state.get("confirmedModel") : $,
      T =
        typeof z?.payload_json === "string"
          ? JSON.parse(z.payload_json).prompt_rev
          : z?.prompt_rev;
    if (z?.model === F && (!Z || T === E)) {
      H += 1;
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
        (k = e(C, B.width, B.height)));
    } else k = await KK(q, B);
    let Kq = Bq(k);
    if (!Kq) {
      ((H += 1), K.info(`photo ${B.asset_id}: no legible text`));
      continue;
    }
    let b = k.filter((C) => C.confidence !== void 0),
      Qq = b.length
        ? b.reduce((C, u) => C + u.confidence, 0) / b.length
        : void 0,
      Nq = k.map(({ order: C, ...u }) => u);
    (await q.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: B.content_id,
        text: Kq,
        capability: "ocr",
        model: F,
        regions: Nq,
        ...(J === t ? {} : { profile: J }),
        ...(Z ? { prompt_rev: E } : {}),
        ...(Qq === void 0 ? {} : { confidence: Qq }),
      },
      purpose: O,
    }),
      (U += 1));
  }
  let L = j.rows?.at(-1)?.asset_id;
  if (L) await q.state.set("cursor", L);
  return {
    summary: `OCR derived ${U}; skipped ${H}; batch ${j.rows?.length ?? 0}/${i}`,
    output: {
      derived: U,
      skipped: H,
      model: Z ? ((await q.state.get("confirmedModel")) ?? $) : $,
      rearm: (j.rows?.length ?? 0) === i,
    },
  };
}
export { PK as setPhotoOcrRuntimeForTests, QK as default };
