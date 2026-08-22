import { existsSync as wK } from "node:fs";
import { readFile as bK } from "node:fs/promises";
import M from "node:path";
import E from "node:path";
// governance: allow-repo-hygiene file-size-limit (#731) the self-contained OCR/PDF handler is one deployable runtime unit; splitting its bundled model/runtime rail would duplicate the content-resolution and bounded-batch invariants.
// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { pathToFileURL as rK } from "node:url";
var CK = E.resolve(import.meta.dirname, ".."),
  m = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? E.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : E.join(CK, "runtime"),
  x = E.join(m, "models");
function _K(K) {
  if (K.length === 0) throw Error("argmax: row must be non-empty");
  let Q = 0,
    Z = K[0];
  for (let $ = 1; $ < K.length; $++) {
    let q = K[$];
    if (q > Z) ((Z = q), (Q = $));
  }
  return { index: Q, value: Z };
}
function $K(K, Q, Z = 0) {
  let $ = [],
    q = [],
    G;
  for (let V of K) {
    let { index: W, value: X } = _K(V);
    if (W !== G && W !== Z) {
      let Y = Q[W];
      if (Y !== void 0) ($.push(Y), q.push(X));
    }
    G = W;
  }
  let J = q.length === 0 ? 0 : q.reduce((V, W) => V + W, 0) / q.length;
  return { text: $.join(""), confidence: J };
}
function qK(K, Q, Z, $) {
  let q = Math.max(K, Q),
    G = q > Z ? Z / q : 1,
    J = (V) => Math.max($, Math.round((V * G) / $) * $);
  return { width: J(K), height: J(Q) };
}
function g(K, Q, Z) {
  let $ = Z.width / Q.width,
    q = Z.height / Q.height;
  return { x: K.x * $, y: K.y * q, width: K.width * $, height: K.height * q };
}
function JK(K) {
  return [
    Math.round(K.x),
    Math.round(K.y),
    Math.round(K.width),
    Math.round(K.height),
  ];
}
function GK(K, Q, Z) {
  let $ = Math.max(0, Math.min(Q, Math.round(K.x))),
    q = Math.max(0, Math.min(Z, Math.round(K.y))),
    G = Math.max($, Math.min(Q, Math.round(K.x + K.width))),
    J = Math.max(q, Math.min(Z, Math.round(K.y + K.height)));
  return [$, q, G - $, J - q];
}
function zK(K, Q, Z, $ = 0.3) {
  let q = new Uint8Array(Q * Z);
  for (let G = 0; G < q.length; G++) q[G] = (K[G] ?? 0) >= $ ? 1 : 0;
  return q;
}
function MK(K, Q, Z, $ = 1) {
  let q = new Uint8Array(Q * Z),
    G = [],
    J = [];
  for (let V = 0; V < K.length; V++) {
    if (!K[V] || q[V]) continue;
    (J.push(V), (q[V] = 1));
    let {
        POSITIVE_INFINITY: W,
        POSITIVE_INFINITY: X,
        NEGATIVE_INFINITY: Y,
        NEGATIVE_INFINITY: j,
      } = Number,
      A = 0;
    while (J.length > 0) {
      let H = J.pop(),
        U = H % Q,
        L = Math.floor(H / Q);
      ((W = Math.min(W, U)),
        (X = Math.min(X, L)),
        (Y = Math.max(Y, U)),
        (j = Math.max(j, L)),
        A++);
      let B = [
        U > 0 ? H - 1 : -1,
        U < Q - 1 ? H + 1 : -1,
        L > 0 ? H - Q : -1,
        L < Z - 1 ? H + Q : -1,
      ];
      for (let N of B) if (N >= 0 && K[N] && !q[N]) ((q[N] = 1), J.push(N));
    }
    if (A >= $)
      G.push({
        box: { x: W, y: X, width: Y - W + 1, height: j - X + 1 },
        area: A,
      });
  }
  return G;
}
function OK(K, Q, Z = 1.5) {
  let $ = 2 * (K.width + K.height);
  if ($ <= 0) return K;
  let q = (Q * Z) / $;
  return {
    x: K.x - q,
    y: K.y - q,
    width: K.width + q * 2,
    height: K.height + q * 2,
  };
}
function TK(K, Q, Z) {
  let $ = Math.max(0, Math.min(Q, Math.round(K.x))),
    q = Math.max(0, Math.min(Z, Math.round(K.y))),
    G = Math.max(0, Math.min(Q, Math.round(K.x + K.width))),
    J = Math.max(0, Math.min(Z, Math.round(K.y + K.height)));
  return { x: $, y: q, width: Math.max(0, G - $), height: Math.max(0, J - q) };
}
function DK(K, Q, Z) {
  let $ = Math.max(0, Math.floor(Z.x)),
    q = Math.max(0, Math.floor(Z.y)),
    G = Math.max($, Math.ceil(Z.x + Z.width)),
    J = Math.max(q, Math.ceil(Z.y + Z.height)),
    V = 0,
    W = 0;
  for (let X = q; X < J; X++)
    for (let Y = $; Y < G; Y++) ((V += K[X * Q + Y] ?? 0), W++);
  return W === 0 ? 0 : V / W;
}
function VK(K, Q, Z, $ = {}) {
  let {
      binaryThreshold: q = 0.3,
      boxScoreThreshold: G = 0.5,
      unclipRatio: J = 1.5,
      minArea: V = 4,
    } = $,
    W = zK(K, Q, Z, q),
    X = MK(W, Q, Z, V),
    Y = [];
  for (let j of X) {
    let A = DK(K, Q, j.box);
    if (A < G) continue;
    let H = OK(j.box, j.area, J),
      U = TK(H, Q, Z);
    if (U.width <= 0 || U.height <= 0) continue;
    Y.push({ box: U, score: A });
  }
  return Y;
}
import { existsSync as h, readFileSync as EK, statSync as IK } from "node:fs";
import S from "node:path";
import { pathToFileURL as PK } from "node:url";
var I;
class R extends Error {
  constructor(K, Q) {
    super(
      `Automation model runtime dependency "${K}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: Q }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function z(K, Q = m) {
  let Z = S.join(Q, "node_modules");
  if (!h(Z)) throw new R(K);
  let $ = S.join(Z, ...K.split("/"));
  try {
    let q = YK($);
    if (q === null) throw Error(`no entry point in ${$}`);
    return q;
  } catch (q) {
    throw new R(K, q);
  }
}
function YK(K, Q = 0) {
  let Z = S.join(K, "package.json"),
    $ = h(Z) ? JSON.parse(EK(Z, "utf8")) : {},
    q = [
      ...p(RK($.exports)),
      ...(typeof $.main === "string" ? [$.main] : []),
      "index.js",
    ];
  for (let G of q) {
    let J = SK(S.resolve(K, G), Q);
    if (J !== null) return J;
  }
  return null;
}
function SK(K, Q) {
  let Z = WK(K);
  if (Z?.isFile()) return K;
  if (Z?.isDirectory()) return Q >= 4 ? null : YK(K, Q + 1);
  for (let $ of [".js", ".json", ".node"]) {
    let q = `${K}${$}`;
    if (WK(q)?.isFile()) return q;
  }
  return null;
}
function WK(K) {
  try {
    return IK(K);
  } catch {
    return null;
  }
}
function RK(K) {
  if (typeof K === "string") return K;
  if (K === null || typeof K !== "object") return;
  let Q = K;
  return "." in Q ? Q["."] : Q;
}
function p(K, Q = 0) {
  if (typeof K === "string") return [K];
  if (Q > 8 || K === null || typeof K !== "object") return [];
  if (Array.isArray(K)) return K.flatMap((q) => p(q, Q + 1));
  let Z = K,
    $ = [];
  for (let q of ["require", "node", "default"])
    if (q in Z) $.push(...p(Z[q], Q + 1));
  return $;
}
async function v() {
  if (I) return I;
  let K = z("onnxruntime-node");
  return ((I = await import(PK(K).href)), I);
}
var P;
async function l(K) {
  P ??= new Map();
  let Q = P.get(K);
  if (Q) return Q;
  if (!h(K)) throw new R(K);
  let Z = v().then(($) => $.InferenceSession.create(K));
  P.set(K, Z);
  try {
    return await Z;
  } catch ($) {
    throw (P.delete(K), $);
  }
}
import { pathToFileURL as vK } from "node:url";
var f;
async function c() {
  if (f) return f;
  let K = z("sharp");
  return ((f = (await import(vK(K).href)).default), f);
}
async function d(K) {
  let Z = (await c())(Buffer.from(K)),
    { data: $, info: q } = await Z.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array($.buffer, $.byteOffset, $.byteLength),
    width: q.width,
    height: q.height,
  };
}
async function XK(K, Q, Z) {
  let q = (await c())(Buffer.from(K)),
    { data: G, info: J } = await q
      .resize({ width: Q, height: Z, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(G.buffer, G.byteOffset, G.byteLength),
    width: J.width,
    height: J.height,
  };
}
function jK(K, Q) {
  let Z = Math.max(0, Math.min(K.width, Math.round(Q.x))),
    $ = Math.max(0, Math.min(K.height, Math.round(Q.y))),
    q = Math.max(Z, Math.min(K.width, Math.round(Q.x + Q.width))),
    G = Math.max($, Math.min(K.height, Math.round(Q.y + Q.height))),
    J = q - Z,
    V = G - $,
    W = new Uint8Array(J * V * 3);
  for (let X = 0; X < V; X++) {
    let Y = (($ + X) * K.width + Z) * 3,
      j = X * J * 3;
    W.set(K.data.subarray(Y, Y + J * 3), j);
  }
  return { data: W, width: J, height: V };
}
async function UK(K, Q, Z) {
  let q = (await c())(Buffer.from(K.data), {
      raw: { width: K.width, height: K.height, channels: 3 },
    }),
    { data: G, info: J } = await q
      .resize({ width: Q, height: Z, fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(G.buffer, G.byteOffset, G.byteLength),
    width: J.width,
    height: J.height,
  };
}
var fK = [0.485, 0.456, 0.406],
  yK = [0.229, 0.224, 0.225];
function s(K) {
  let { width: Q, height: Z, data: $ } = K,
    q = Q * Z,
    G = new Float32Array(q * 3);
  for (let J = 0; J < q; J++)
    for (let V = 0; V < 3; V++) {
      let W = ($[J * 3 + V] ?? 0) / 255;
      G[V * q + J] = (W - fK[V]) / yK[V];
    }
  return G;
}
var n = "pp-ocrv4@1",
  r = M.join(x, "ocr"),
  uK = M.join(r, "det.onnx"),
  mK = M.join(r, "rec.onnx"),
  xK = M.join(r, "dict.txt"),
  gK = 960,
  pK = 32,
  y = 48,
  hK = 320;
function o(K = x) {
  let Q = M.join(K, "ocr");
  return ["det.onnx", "rec.onnx", "dict.txt"].every((Z) => wK(M.join(Q, Z)));
}
function lK(K) {
  return ["", ...K, " "];
}
function cK(K) {
  let Q = K.split(/\r?\n/u);
  if (Q.at(-1) === "") Q.pop();
  return Q;
}
var w;
async function dK() {
  if (w) return w;
  let K = await bK(xK, "utf8");
  return ((w = lK(cK(K))), w);
}
async function sK(K) {
  let Q = await d(K),
    Z = qK(Q.width, Q.height, gK, pK),
    $ = await XK(K, Z.width, Z.height),
    q = s($),
    G = await v(),
    J = await l(uK),
    V = J.inputNames[0] ?? "x",
    W = await J.run({
      [V]: new G.Tensor("float32", q, [1, 3, Z.height, Z.width]),
    }),
    X = J.outputNames[0],
    Y = X ? W[X]?.data : void 0;
  if (!Y || !(Y instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: VK(Y, Z.width, Z.height).map(({ box: H, score: U }) => ({
      box: JK(g(H, Z, Q)),
      score: U,
    })),
    native: Q,
  };
}
async function nK(K) {
  let Q = y / K.height,
    Z = Math.min(hK, Math.max(y, Math.round(K.width * Q))),
    $ = await UK(K, Z, y),
    q = s($),
    G = await v(),
    J = await l(mK),
    V = J.inputNames[0] ?? "x",
    W = await J.run({ [V]: new G.Tensor("float32", q, [1, 3, y, Z]) }),
    X = J.outputNames[0],
    Y = X ? W[X] : void 0;
  if (!Y || !(Y.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let j = await dK(),
    A = j.length,
    H = Y.data.length / A,
    U = [];
  for (let L = 0; L < H; L++) {
    let B = Array.from(Y.data.subarray(L * A, (L + 1) * A));
    U.push(B);
  }
  return $K(U, j);
}
async function a(K) {
  try {
    let Q = Buffer.from(K.bytes, "base64"),
      { boxes: Z, native: $ } = await sK(Q),
      q = await d(Q),
      G =
        K.originalWidth && K.originalHeight
          ? { width: K.originalWidth, height: K.originalHeight }
          : { width: $.width, height: $.height },
      V = (
        await Promise.all(
          Z.map(async (W) => {
            let [X, Y, j, A] = W.box,
              H = jK(q, { x: X, y: Y, width: j, height: A });
            if (H.width <= 0 || H.height <= 0) return;
            let U = await nK(H);
            if (!U.text) return;
            let L = GK(
              g({ x: X, y: Y, width: j, height: A }, $, G),
              G.width,
              G.height
            );
            if (L[2] <= 0 || L[3] <= 0) return;
            return { text: U.text, confidence: U.confidence, box: L };
          })
        )
      ).filter((W) => W !== void 0);
    return { id: K.id, regions: V };
  } catch (Q) {
    return { id: K.id, error: Q instanceof Error ? Q.message : String(Q) };
  }
}
var i = 16,
  O = "dpv:ServiceProvision",
  D = "ocr-v1",
  t = "built-in",
  HK = a,
  LK = o,
  AK = async () => {
    let K = z("pdfjs-dist/legacy/build/pdf.mjs");
    return import(rK(K).href);
  },
  FK = AK;
function EQ(K) {
  ((HK = K?.recognize ?? a),
    (LK = K?.weightsPresent ?? o),
    (FK = K?.loadPdfJs ?? AK));
}
function e(K, Q, Z) {
  if (!K) return [];
  if (!Array.isArray(K.regions))
    return typeof K.text === "string" && K.text.trim()
      ? [{ text: K.text, order: 0 }]
      : [];
  return K.regions.flatMap(($, q) => {
    if (!$ || typeof $.text !== "string") return [];
    let G = $.confidence;
    if (G !== void 0 && (typeof G !== "number" || G < 0 || G > 1)) return [];
    let J = Array.isArray($.box) && $.box.length === 4 ? $.box : null,
      V =
        J &&
        J.every(
          (W) => typeof W === "number" && Number.isSafeInteger(W) && W >= 0
        ) &&
        J[2] > 0 &&
        J[3] > 0 &&
        (!Q || J[0] + J[2] <= Q) &&
        (!Z || J[1] + J[3] <= Z);
    return [
      {
        text: $.text,
        order: q,
        ...(V ? { box: J } : {}),
        ...(G === void 0 ? {} : { confidence: G }),
      },
    ];
  });
}
function BK(K) {
  return [...K]
    .sort((Q, Z) =>
      Q.box && Z.box
        ? Q.box[1] - Z.box[1] || Q.box[0] - Z.box[0]
        : Q.order - Z.order
    )
    .map((Q) => Q.text).join(`
`);
}
function kK() {
  return LK() ? n : null;
}
function oK(K) {
  let Q = K?.capture;
  if (!Q || typeof Q !== "object") return null;
  if (typeof Q.bytes !== "string" || !Q.bytes)
    throw Error("capture OCR needs base64 content bytes");
  if (
    typeof Q.mediaType !== "string" ||
    (!Q.mediaType.startsWith("image/") && Q.mediaType !== "application/pdf")
  )
    throw Error("capture OCR needs an image or PDF media type");
  return Q;
}
async function KK(K) {
  let Q = await HK(K);
  if (!Q || Q.error) throw Error(Q?.error ?? "OCR returned no result");
  return Q;
}
async function aK(K) {
  globalThis.DOMMatrix ??= class {
    constructor(W = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = W;
    }
  };
  let Q = await FK(),
    Z = Buffer.from(K.bytes, "base64"),
    $ = await Q.getDocument({ data: new Uint8Array(Z), disableWorker: !0 })
      .promise,
    q = [],
    G,
    J = Math.min($.numPages, 64);
  for (let V = 1; V <= J; V += 1) {
    let Y = (await (await $.getPage(V)).getTextContent()).items
      .flatMap((F) =>
        F && typeof F === "object" && "str" in F ? [String(F.str).trim()] : []
      )
      .filter(Boolean)
      .join(" ");
    if (Y) {
      q.push({ text: Y, page: V });
      continue;
    }
    let j = await import(z("@napi-rs/canvas"));
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
    G ??= await Q.getDocument({
      data: new Uint8Array(Z),
      disableWorker: !0,
      CanvasFactory: A,
    }).promise;
    let H = await G.getPage(V),
      U = H.getViewport({ scale: 2 }),
      L = j.createCanvas(Math.ceil(U.width), Math.ceil(U.height)),
      B = L.getContext("2d");
    await H.render({ canvas: L, canvasContext: B, viewport: U }).promise;
    let N = L.toBuffer("image/png").toString("base64"),
      _ = await KK({ id: `capture:${V}`, bytes: N, mediaType: "image/png" });
    for (let F of _.regions ?? []) q.push({ ...F, page: V });
  }
  return { id: "capture", regions: q };
}
async function iK(K) {
  if (!kK())
    throw Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  let Q =
      K.mediaType === "application/pdf"
        ? await aK(K)
        : await KK({ id: "capture", bytes: K.bytes, mediaType: K.mediaType }),
    Z = e(Q),
    $ = Z.filter((J) => J.confidence !== void 0),
    q = $.length ? $.reduce((J, V) => J + V.confidence, 0) / $.length : void 0,
    G = BK(Z);
  return {
    summary: G ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: G,
      engine: "automation",
      model: n,
      ...(q === void 0 ? {} : { confidence: q }),
    },
  };
}
async function tK(K, Q, Z) {
  let q = (
    await K.vault.read({
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
  if (!q) return "";
  return (
    await K.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: q.content_id },
        { column: "variant", op: "eq", value: "text" },
        { column: "profile", op: "eq", value: Z },
      ],
      limit: 1,
      purpose: O,
    })
  ).rows?.[0]?.model === Q
    ? q.asset_id
    : "";
}
async function eK(K, Q) {
  let Z = await K.vault.content({
    contentId: Q.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: O,
  });
  if (Z?.status !== "ok" || Z.kind !== "bytes")
    throw Error(`asset ${Q.asset_id}: preview is unavailable`);
  let $ = await KK({
    id: Q.content_id,
    bytes: Z.base64,
    mediaType: Z.mediaType,
    originalWidth: Q.width,
    originalHeight: Q.height,
  });
  return e($, Q.width, Q.height);
}
async function KQ({ ctx: K, log: Q }) {
  let Z = oK(K.input);
  if (Z) return iK(Z);
  let $ = K.input?.variant === "delegate",
    q = $ ? K.input?.delegateModel : kK();
  if (!q) {
    if ($) throw Error("delegate OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  let G = K.input?.promptRev;
  if ($ && G && G !== D)
    throw Error(
      `delegate OCR: the engine profile pins prompt revision "${G}", but this handler ships "${D}"`
    );
  let J = K.input?.profileId ?? t,
    V = J === t ? "" : `:${J}`,
    W = `${$ ? "delegate" : "deterministic"}:${q}:${$ ? D : "local"}${V}`,
    X = await K.state.get("selection");
  if (X !== W) {
    let B = X === void 0 && !$ ? await tK(K, q, J) : "";
    (await K.state.set("cursor", B),
      await K.state.set("selection", W),
      await K.state.delete("confirmedModel"));
  }
  let Y = (await K.state.get("cursor")) ?? "",
    j = await K.vault.read({
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
    let _ = (
        await K.vault.read({
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
      F = $ ? await K.state.get("confirmedModel") : q,
      T =
        typeof _?.payload_json === "string"
          ? JSON.parse(_.payload_json).prompt_rev
          : _?.prompt_rev;
    if (_?.model === F && (!$ || T === D)) {
      U += 1;
      continue;
    }
    let k;
    if ($) {
      let C = await K.delegate({
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
        await K.state.set("confirmedModel", F),
        (k = e(C, B.width, B.height)));
    } else k = await eK(K, B);
    let QK = BK(k);
    if (!QK) {
      ((U += 1), Q.info(`photo ${B.asset_id}: no legible text`));
      continue;
    }
    let b = k.filter((C) => C.confidence !== void 0),
      ZK = b.length
        ? b.reduce((C, u) => C + u.confidence, 0) / b.length
        : void 0,
      NK = k.map(({ order: C, ...u }) => u);
    (await K.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: B.content_id,
        text: QK,
        capability: "ocr",
        model: F,
        regions: NK,
        ...(J === t ? {} : { profile: J }),
        ...($ ? { prompt_rev: D } : {}),
        ...(ZK === void 0 ? {} : { confidence: ZK }),
      },
      purpose: O,
    }),
      (H += 1));
  }
  let L = j.rows?.at(-1)?.asset_id;
  if (L) await K.state.set("cursor", L);
  return {
    summary: `OCR derived ${H}; skipped ${U}; batch ${j.rows?.length ?? 0}/${i}`,
    output: {
      derived: H,
      skipped: U,
      model: $ ? ((await K.state.get("confirmedModel")) ?? q) : q,
      rearm: (j.rows?.length ?? 0) === i,
    },
  };
}
export { EQ as setPhotoOcrRuntimeForTests, KQ as default };
