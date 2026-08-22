import { existsSync as uq } from "node:fs";
import { readFile as mq } from "node:fs/promises";
import M from "node:path";
import E from "node:path";
// governance: allow-repo-hygiene file-size-limit (#731) the self-contained OCR/PDF handler is one deployable runtime unit; splitting its bundled model/runtime rail would duplicate the content-resolution and bounded-batch invariants.
// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { pathToFileURL as aq } from "node:url";
var Cq = E.resolve(import.meta.dirname, ".."),
  zq = "__centraidAutomationRuntimeDir";
function _q() {
  let q = globalThis[zq];
  if (typeof q === "string" && q.length > 0) return E.resolve(q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return E.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return E.join(Cq, "runtime");
}
var m = _q(),
  x = E.join(m, "models");
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
    G;
  for (let V of q) {
    let { index: W, value: X } = Mq(V);
    if (W !== G && W !== Q) {
      let Y = K[W];
      if (Y !== void 0) (Z.push(Y), $.push(X));
    }
    G = W;
  }
  let J = $.length === 0 ? 0 : $.reduce((V, W) => V + W, 0) / $.length;
  return { text: Z.join(""), confidence: J };
}
function $q(q, K, Q, Z) {
  let $ = Math.max(q, K),
    G = $ > Q ? Q / $ : 1,
    J = (V) => Math.max(Z, Math.round((V * G) / Z) * Z);
  return { width: J(q), height: J(K) };
}
function g(q, K, Q) {
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
function Gq(q, K, Q) {
  let Z = Math.max(0, Math.min(K, Math.round(q.x))),
    $ = Math.max(0, Math.min(Q, Math.round(q.y))),
    G = Math.max(Z, Math.min(K, Math.round(q.x + q.width))),
    J = Math.max($, Math.min(Q, Math.round(q.y + q.height)));
  return [Z, $, G - Z, J - $];
}
function Oq(q, K, Q, Z = 0.3) {
  let $ = new Uint8Array(K * Q);
  for (let G = 0; G < $.length; G++) $[G] = (q[G] ?? 0) >= Z ? 1 : 0;
  return $;
}
function Tq(q, K, Q, Z = 1) {
  let $ = new Uint8Array(K * Q),
    G = [],
    J = [];
  for (let V = 0; V < q.length; V++) {
    if (!q[V] || $[V]) continue;
    (J.push(V), ($[V] = 1));
    let {
        POSITIVE_INFINITY: W,
        POSITIVE_INFINITY: X,
        NEGATIVE_INFINITY: Y,
        NEGATIVE_INFINITY: j,
      } = Number,
      A = 0;
    while (J.length > 0) {
      let H = J.pop(),
        U = H % K,
        L = Math.floor(H / K);
      ((W = Math.min(W, U)),
        (X = Math.min(X, L)),
        (Y = Math.max(Y, U)),
        (j = Math.max(j, L)),
        A++);
      let B = [
        U > 0 ? H - 1 : -1,
        U < K - 1 ? H + 1 : -1,
        L > 0 ? H - K : -1,
        L < Q - 1 ? H + K : -1,
      ];
      for (let N of B) if (N >= 0 && q[N] && !$[N]) (($[N] = 1), J.push(N));
    }
    if (A >= Z)
      G.push({
        box: { x: W, y: X, width: Y - W + 1, height: j - X + 1 },
        area: A,
      });
  }
  return G;
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
function Dq(q, K, Q) {
  let Z = Math.max(0, Math.min(K, Math.round(q.x))),
    $ = Math.max(0, Math.min(Q, Math.round(q.y))),
    G = Math.max(0, Math.min(K, Math.round(q.x + q.width))),
    J = Math.max(0, Math.min(Q, Math.round(q.y + q.height)));
  return { x: Z, y: $, width: Math.max(0, G - Z), height: Math.max(0, J - $) };
}
function Iq(q, K, Q) {
  let Z = Math.max(0, Math.floor(Q.x)),
    $ = Math.max(0, Math.floor(Q.y)),
    G = Math.max(Z, Math.ceil(Q.x + Q.width)),
    J = Math.max($, Math.ceil(Q.y + Q.height)),
    V = 0,
    W = 0;
  for (let X = $; X < J; X++)
    for (let Y = Z; Y < G; Y++) ((V += q[X * K + Y] ?? 0), W++);
  return W === 0 ? 0 : V / W;
}
function Vq(q, K, Q, Z = {}) {
  let {
      binaryThreshold: $ = 0.3,
      boxScoreThreshold: G = 0.5,
      unclipRatio: J = 1.5,
      minArea: V = 4,
    } = Z,
    W = Oq(q, K, Q, $),
    X = Tq(W, K, Q, V),
    Y = [];
  for (let j of X) {
    let A = Iq(q, K, j.box);
    if (A < G) continue;
    let H = Eq(j.box, j.area, J),
      U = Dq(H, K, Q);
    if (U.width <= 0 || U.height <= 0) continue;
    Y.push({ box: U, score: A });
  }
  return Y;
}
import { existsSync as p, readFileSync as Pq, statSync as Sq } from "node:fs";
import S from "node:path";
import { pathToFileURL as vq } from "node:url";
var I;
class v extends Error {
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
  if (!p(Q)) throw new v(q);
  let Z = S.join(Q, ...q.split("/"));
  try {
    let $ = Yq(Z);
    if ($ === null) throw Error(`no entry point in ${Z}`);
    return $;
  } catch ($) {
    throw new v(q, $);
  }
}
function Yq(q, K = 0) {
  let Q = S.join(q, "package.json"),
    Z = p(Q) ? JSON.parse(Pq(Q, "utf8")) : {},
    $ = [
      ...h(fq(Z.exports)),
      ...(typeof Z.main === "string" ? [Z.main] : []),
      "index.js",
    ];
  for (let G of $) {
    let J = Rq(S.resolve(q, G), K);
    if (J !== null) return J;
  }
  return null;
}
function Rq(q, K) {
  let Q = Wq(q);
  if (Q?.isFile()) return q;
  if (Q?.isDirectory()) return K >= 4 ? null : Yq(q, K + 1);
  for (let Z of [".js", ".json", ".node"]) {
    let $ = `${q}${Z}`;
    if (Wq($)?.isFile()) return $;
  }
  return null;
}
function Wq(q) {
  try {
    return Sq(q);
  } catch {
    return null;
  }
}
function fq(q) {
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
async function R() {
  if (I) return I;
  let q = _("onnxruntime-node");
  return ((I = await import(vq(q).href)), I);
}
var P;
async function l(q) {
  P ??= new Map();
  let K = P.get(q);
  if (K) return K;
  if (!p(q)) throw new v(q);
  let Q = R().then((Z) => Z.InferenceSession.create(q));
  P.set(q, Q);
  try {
    return await Q;
  } catch (Z) {
    throw (P.delete(q), Z);
  }
}
import { pathToFileURL as yq } from "node:url";
var f;
async function c() {
  if (f) return f;
  let q = _("sharp");
  return ((f = (await import(yq(q).href)).default), f);
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
    { data: G, info: J } = await $.resize({ width: K, height: Q, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(G.buffer, G.byteOffset, G.byteLength),
    width: J.width,
    height: J.height,
  };
}
function jq(q, K) {
  let Q = Math.max(0, Math.min(q.width, Math.round(K.x))),
    Z = Math.max(0, Math.min(q.height, Math.round(K.y))),
    $ = Math.max(Q, Math.min(q.width, Math.round(K.x + K.width))),
    G = Math.max(Z, Math.min(q.height, Math.round(K.y + K.height))),
    J = $ - Q,
    V = G - Z,
    W = new Uint8Array(J * V * 3);
  for (let X = 0; X < V; X++) {
    let Y = ((Z + X) * q.width + Q) * 3,
      j = X * J * 3;
    W.set(q.data.subarray(Y, Y + J * 3), j);
  }
  return { data: W, width: J, height: V };
}
async function Uq(q, K, Q) {
  let $ = (await c())(Buffer.from(q.data), {
      raw: { width: q.width, height: q.height, channels: 3 },
    }),
    { data: G, info: J } = await $.resize({ width: K, height: Q, fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(G.buffer, G.byteOffset, G.byteLength),
    width: J.width,
    height: J.height,
  };
}
var wq = [0.485, 0.456, 0.406],
  bq = [0.229, 0.224, 0.225];
function s(q) {
  let { width: K, height: Q, data: Z } = q,
    $ = K * Q,
    G = new Float32Array($ * 3);
  for (let J = 0; J < $; J++)
    for (let V = 0; V < 3; V++) {
      let W = (Z[J * 3 + V] ?? 0) / 255;
      G[V * $ + J] = (W - wq[V]) / bq[V];
    }
  return G;
}
var n = "pp-ocrv4@1",
  r = M.join(x, "ocr"),
  xq = M.join(r, "det.onnx"),
  gq = M.join(r, "rec.onnx"),
  hq = M.join(r, "dict.txt"),
  pq = 960,
  lq = 32,
  y = 48,
  cq = 320;
function o(q = x) {
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
    G = await R(),
    J = await l(xq),
    V = J.inputNames[0] ?? "x",
    W = await J.run({
      [V]: new G.Tensor("float32", $, [1, 3, Q.height, Q.width]),
    }),
    X = J.outputNames[0],
    Y = X ? W[X]?.data : void 0;
  if (!Y || !(Y instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: Vq(Y, Q.width, Q.height).map(({ box: H, score: U }) => ({
      box: Jq(g(H, Q, K)),
      score: U,
    })),
    native: K,
  };
}
async function oq(q) {
  let K = y / q.height,
    Q = Math.min(cq, Math.max(y, Math.round(q.width * K))),
    Z = await Uq(q, Q, y),
    $ = s(Z),
    G = await R(),
    J = await l(gq),
    V = J.inputNames[0] ?? "x",
    W = await J.run({ [V]: new G.Tensor("float32", $, [1, 3, y, Q]) }),
    X = J.outputNames[0],
    Y = X ? W[X] : void 0;
  if (!Y || !(Y.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let j = await nq(),
    A = j.length,
    H = Y.data.length / A,
    U = [];
  for (let L = 0; L < H; L++) {
    let B = Array.from(Y.data.subarray(L * A, (L + 1) * A));
    U.push(B);
  }
  return Zq(U, j);
}
async function a(q) {
  try {
    let K = Buffer.from(q.bytes, "base64"),
      { boxes: Q, native: Z } = await rq(K),
      $ = await d(K),
      G =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: Z.width, height: Z.height },
      V = (
        await Promise.all(
          Q.map(async (W) => {
            let [X, Y, j, A] = W.box,
              H = jq($, { x: X, y: Y, width: j, height: A });
            if (H.width <= 0 || H.height <= 0) return;
            let U = await oq(H);
            if (!U.text) return;
            let L = Gq(
              g({ x: X, y: Y, width: j, height: A }, Z, G),
              G.width,
              G.height
            );
            if (L[2] <= 0 || L[3] <= 0) return;
            return { text: U.text, confidence: U.confidence, box: L };
          })
        )
      ).filter((W) => W !== void 0);
    return { id: q.id, regions: V };
  } catch (K) {
    return { id: q.id, error: K instanceof Error ? K.message : String(K) };
  }
}
var i = 16,
  O = "dpv:ServiceProvision",
  D = "ocr-v1",
  t = "built-in",
  Hq = a,
  Lq = o,
  Aq = async () => {
    let q = _("pdfjs-dist/legacy/build/pdf.mjs");
    return import(aq(q).href);
  },
  Fq = Aq;
function PK(q) {
  ((Hq = q?.recognize ?? a),
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
    let G = Z.confidence;
    if (G !== void 0 && (typeof G !== "number" || G < 0 || G > 1)) return [];
    let J = Array.isArray(Z.box) && Z.box.length === 4 ? Z.box : null,
      V =
        J &&
        J.every(
          (W) => typeof W === "number" && Number.isSafeInteger(W) && W >= 0
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
        ...(G === void 0 ? {} : { confidence: G }),
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
  let K = await Hq(q);
  if (!K || K.error) throw Error(K?.error ?? "OCR returned no result");
  return K;
}
async function tq(q) {
  globalThis.DOMMatrix ??= class {
    constructor(W = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = W;
    }
  };
  let K = await Fq(),
    Q = Buffer.from(q.bytes, "base64"),
    Z = await K.getDocument({ data: new Uint8Array(Q), disableWorker: !0 })
      .promise,
    $ = [],
    G,
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
    G ??= await K.getDocument({
      data: new Uint8Array(Q),
      disableWorker: !0,
      CanvasFactory: A,
    }).promise;
    let H = await G.getPage(V),
      U = H.getViewport({ scale: 2 }),
      L = j.createCanvas(Math.ceil(U.width), Math.ceil(U.height)),
      B = L.getContext("2d");
    await H.render({ canvas: L, canvasContext: B, viewport: U }).promise;
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
    G = Bq(Q);
  return {
    summary: G ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: G,
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
  let G = q.input?.promptRev;
  if (Z && G && G !== D)
    throw Error(
      `delegate OCR: the engine profile pins prompt revision "${G}", but this handler ships "${D}"`
    );
  let J = q.input?.profileId ?? t,
    V = J === t ? "" : `:${J}`,
    W = `${Z ? "delegate" : "deterministic"}:${$}:${Z ? D : "local"}${V}`,
    X = await q.state.get("selection");
  if (X !== W) {
    let B = X === void 0 && !Z ? await qK(q, $, J) : "";
    (await q.state.set("cursor", B),
      await q.state.set("selection", W),
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
    H = 0,
    U = 0;
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
    if (z?.model === F && (!Z || T === D)) {
      U += 1;
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
      ((U += 1), K.info(`photo ${B.asset_id}: no legible text`));
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
        ...(Z ? { prompt_rev: D } : {}),
        ...(Qq === void 0 ? {} : { confidence: Qq }),
      },
      purpose: O,
    }),
      (H += 1));
  }
  let L = j.rows?.at(-1)?.asset_id;
  if (L) await q.state.set("cursor", L);
  return {
    summary: `OCR derived ${H}; skipped ${U}; batch ${j.rows?.length ?? 0}/${i}`,
    output: {
      derived: H,
      skipped: U,
      model: Z ? ((await q.state.get("confirmedModel")) ?? $) : $,
      rearm: (j.rows?.length ?? 0) === i,
    },
  };
}
export { PK as setPhotoOcrRuntimeForTests, QK as default };
