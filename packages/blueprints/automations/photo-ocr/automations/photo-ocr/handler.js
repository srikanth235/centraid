import { existsSync as PK } from "node:fs";
import { readFile as SK } from "node:fs/promises";
import O from "node:path";
import E from "node:path";
// governance: allow-repo-hygiene file-size-limit (#731) the self-contained OCR/PDF handler is one deployable runtime unit; splitting its bundled model/runtime rail would duplicate the content-resolution and bounded-batch invariants.
// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { pathToFileURL as hK } from "node:url";
var BK = E.resolve(import.meta.dirname, ".."),
  u = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? E.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : E.join(BK, "runtime"),
  g = E.join(u, "models");
function kK(K) {
  if (K.length === 0) throw Error("argmax: row must be non-empty");
  let Q = 0,
    Z = K[0];
  for (let $ = 1; $ < K.length; $++) {
    let q = K[$];
    if (q > Z) ((Z = q), (Q = $));
  }
  return { index: Q, value: Z };
}
function KK(K, Q, Z = 0) {
  let $ = [],
    q = [],
    G;
  for (let V of K) {
    let { index: W, value: F } = kK(V);
    if (W !== G && W !== Z) {
      let Y = Q[W];
      if (Y !== void 0) ($.push(Y), q.push(F));
    }
    G = W;
  }
  let J = q.length === 0 ? 0 : q.reduce((V, W) => V + W, 0) / q.length;
  return { text: $.join(""), confidence: J };
}
function QK(K, Q, Z, $) {
  let q = Math.max(K, Q),
    G = q > Z ? Z / q : 1,
    J = (V) => Math.max($, Math.round((V * G) / $) * $);
  return { width: J(K), height: J(Q) };
}
function x(K, Q, Z) {
  let $ = Z.width / Q.width,
    q = Z.height / Q.height;
  return { x: K.x * $, y: K.y * q, width: K.width * $, height: K.height * q };
}
function ZK(K) {
  return [
    Math.round(K.x),
    Math.round(K.y),
    Math.round(K.width),
    Math.round(K.height),
  ];
}
function $K(K, Q, Z) {
  let $ = Math.max(0, Math.min(Q, Math.round(K.x))),
    q = Math.max(0, Math.min(Z, Math.round(K.y))),
    G = Math.max($, Math.min(Q, Math.round(K.x + K.width))),
    J = Math.max(q, Math.min(Z, Math.round(K.y + K.height)));
  return [$, q, G - $, J - q];
}
function NK(K, Q, Z, $ = 0.3) {
  let q = new Uint8Array(Q * Z);
  for (let G = 0; G < q.length; G++) q[G] = (K[G] ?? 0) >= $ ? 1 : 0;
  return q;
}
function CK(K, Q, Z, $ = 1) {
  let q = new Uint8Array(Q * Z),
    G = [],
    J = [];
  for (let V = 0; V < K.length; V++) {
    if (!K[V] || q[V]) continue;
    (J.push(V), (q[V] = 1));
    let {
        POSITIVE_INFINITY: W,
        POSITIVE_INFINITY: F,
        NEGATIVE_INFINITY: Y,
        NEGATIVE_INFINITY: X,
      } = Number,
      L = 0;
    while (J.length > 0) {
      let U = J.pop(),
        j = U % Q,
        H = Math.floor(U / Q);
      ((W = Math.min(W, j)),
        (F = Math.min(F, H)),
        (Y = Math.max(Y, j)),
        (X = Math.max(X, H)),
        L++);
      let B = [
        j > 0 ? U - 1 : -1,
        j < Q - 1 ? U + 1 : -1,
        H > 0 ? U - Q : -1,
        H < Z - 1 ? U + Q : -1,
      ];
      for (let N of B) if (N >= 0 && K[N] && !q[N]) ((q[N] = 1), J.push(N));
    }
    if (L >= $)
      G.push({
        box: { x: W, y: F, width: Y - W + 1, height: X - F + 1 },
        area: L,
      });
  }
  return G;
}
function _K(K, Q, Z = 1.5) {
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
function zK(K, Q, Z) {
  let $ = Math.max(0, Math.min(Q, Math.round(K.x))),
    q = Math.max(0, Math.min(Z, Math.round(K.y))),
    G = Math.max(0, Math.min(Q, Math.round(K.x + K.width))),
    J = Math.max(0, Math.min(Z, Math.round(K.y + K.height)));
  return { x: $, y: q, width: Math.max(0, G - $), height: Math.max(0, J - q) };
}
function OK(K, Q, Z) {
  let $ = Math.max(0, Math.floor(Z.x)),
    q = Math.max(0, Math.floor(Z.y)),
    G = Math.max($, Math.ceil(Z.x + Z.width)),
    J = Math.max(q, Math.ceil(Z.y + Z.height)),
    V = 0,
    W = 0;
  for (let F = q; F < J; F++)
    for (let Y = $; Y < G; Y++) ((V += K[F * Q + Y] ?? 0), W++);
  return W === 0 ? 0 : V / W;
}
function qK(K, Q, Z, $ = {}) {
  let {
      binaryThreshold: q = 0.3,
      boxScoreThreshold: G = 0.5,
      unclipRatio: J = 1.5,
      minArea: V = 4,
    } = $,
    W = NK(K, Q, Z, q),
    F = CK(W, Q, Z, V),
    Y = [];
  for (let X of F) {
    let L = OK(K, Q, X.box);
    if (L < G) continue;
    let U = _K(X.box, X.area, J),
      j = zK(U, Q, Z);
    if (j.width <= 0 || j.height <= 0) continue;
    Y.push({ box: j, score: L });
  }
  return Y;
}
import { existsSync as GK } from "node:fs";
import { createRequire as DK } from "node:module";
import JK from "node:path";
import { pathToFileURL as MK } from "node:url";
var I;
class S extends Error {
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
function z(K, Q = u) {
  if (!GK(JK.join(Q, "node_modules"))) throw new S(K);
  let Z = DK(JK.join(Q, "package.json"));
  try {
    return Z.resolve(K);
  } catch ($) {
    throw new S(K, $);
  }
}
async function R() {
  if (I) return I;
  let K = z("onnxruntime-node");
  return ((I = await import(MK(K).href)), I);
}
var P;
async function m(K) {
  P ??= new Map();
  let Q = P.get(K);
  if (Q) return Q;
  if (!GK(K)) throw new S(K);
  let Z = R().then(($) => $.InferenceSession.create(K));
  P.set(K, Z);
  try {
    return await Z;
  } catch ($) {
    throw (P.delete(K), $);
  }
}
import { pathToFileURL as TK } from "node:url";
var v;
async function p() {
  if (v) return v;
  let K = z("sharp");
  return ((v = (await import(TK(K).href)).default), v);
}
async function h(K) {
  let Z = (await p())(Buffer.from(K)),
    { data: $, info: q } = await Z.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array($.buffer, $.byteOffset, $.byteLength),
    width: q.width,
    height: q.height,
  };
}
async function VK(K, Q, Z) {
  let q = (await p())(Buffer.from(K)),
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
function WK(K, Q) {
  let Z = Math.max(0, Math.min(K.width, Math.round(Q.x))),
    $ = Math.max(0, Math.min(K.height, Math.round(Q.y))),
    q = Math.max(Z, Math.min(K.width, Math.round(Q.x + Q.width))),
    G = Math.max($, Math.min(K.height, Math.round(Q.y + Q.height))),
    J = q - Z,
    V = G - $,
    W = new Uint8Array(J * V * 3);
  for (let F = 0; F < V; F++) {
    let Y = (($ + F) * K.width + Z) * 3,
      X = F * J * 3;
    W.set(K.data.subarray(Y, Y + J * 3), X);
  }
  return { data: W, width: J, height: V };
}
async function YK(K, Q, Z) {
  let q = (await p())(Buffer.from(K.data), {
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
var EK = [0.485, 0.456, 0.406],
  IK = [0.229, 0.224, 0.225];
function l(K) {
  let { width: Q, height: Z, data: $ } = K,
    q = Q * Z,
    G = new Float32Array(q * 3);
  for (let J = 0; J < q; J++)
    for (let V = 0; V < 3; V++) {
      let W = ($[J * 3 + V] ?? 0) / 255;
      G[V * q + J] = (W - EK[V]) / IK[V];
    }
  return G;
}
var c = "pp-ocrv4@1",
  d = O.join(g, "ocr"),
  RK = O.join(d, "det.onnx"),
  vK = O.join(d, "rec.onnx"),
  fK = O.join(d, "dict.txt"),
  yK = 960,
  wK = 32,
  f = 48,
  bK = 320;
function s(K = g) {
  let Q = O.join(K, "ocr");
  return ["det.onnx", "rec.onnx", "dict.txt"].every((Z) => PK(O.join(Q, Z)));
}
function uK(K) {
  return ["", ...K, " "];
}
function gK(K) {
  let Q = K.split(/\r?\n/u);
  if (Q.at(-1) === "") Q.pop();
  return Q;
}
var y;
async function xK() {
  if (y) return y;
  let K = await SK(fK, "utf8");
  return ((y = uK(gK(K))), y);
}
async function mK(K) {
  let Q = await h(K),
    Z = QK(Q.width, Q.height, yK, wK),
    $ = await VK(K, Z.width, Z.height),
    q = l($),
    G = await R(),
    J = await m(RK),
    V = J.inputNames[0] ?? "x",
    W = await J.run({
      [V]: new G.Tensor("float32", q, [1, 3, Z.height, Z.width]),
    }),
    F = J.outputNames[0],
    Y = F ? W[F]?.data : void 0;
  if (!Y || !(Y instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: qK(Y, Z.width, Z.height).map(({ box: U, score: j }) => ({
      box: ZK(x(U, Z, Q)),
      score: j,
    })),
    native: Q,
  };
}
async function pK(K) {
  let Q = f / K.height,
    Z = Math.min(bK, Math.max(f, Math.round(K.width * Q))),
    $ = await YK(K, Z, f),
    q = l($),
    G = await R(),
    J = await m(vK),
    V = J.inputNames[0] ?? "x",
    W = await J.run({ [V]: new G.Tensor("float32", q, [1, 3, f, Z]) }),
    F = J.outputNames[0],
    Y = F ? W[F] : void 0;
  if (!Y || !(Y.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let X = await xK(),
    L = X.length,
    U = Y.data.length / L,
    j = [];
  for (let H = 0; H < U; H++) {
    let B = Array.from(Y.data.subarray(H * L, (H + 1) * L));
    j.push(B);
  }
  return KK(j, X);
}
async function n(K) {
  try {
    let Q = Buffer.from(K.bytes, "base64"),
      { boxes: Z, native: $ } = await mK(Q),
      q = await h(Q),
      G =
        K.originalWidth && K.originalHeight
          ? { width: K.originalWidth, height: K.originalHeight }
          : { width: $.width, height: $.height },
      V = (
        await Promise.all(
          Z.map(async (W) => {
            let [F, Y, X, L] = W.box,
              U = WK(q, { x: F, y: Y, width: X, height: L });
            if (U.width <= 0 || U.height <= 0) return;
            let j = await pK(U);
            if (!j.text) return;
            let H = $K(
              x({ x: F, y: Y, width: X, height: L }, $, G),
              G.width,
              G.height
            );
            if (H[2] <= 0 || H[3] <= 0) return;
            return { text: j.text, confidence: j.confidence, box: H };
          })
        )
      ).filter((W) => W !== void 0);
    return { id: K.id, regions: V };
  } catch (Q) {
    return { id: K.id, error: Q instanceof Error ? Q.message : String(Q) };
  }
}
var r = 16,
  D = "dpv:ServiceProvision",
  T = "ocr-v1",
  a = "built-in",
  FK = n,
  XK = s,
  jK = async () => {
    let K = z("pdfjs-dist/legacy/build/pdf.mjs");
    return import(hK(K).href);
  },
  UK = jK;
function zQ(K) {
  ((FK = K?.recognize ?? n),
    (XK = K?.weightsPresent ?? s),
    (UK = K?.loadPdfJs ?? jK));
}
function o(K, Q, Z) {
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
function HK(K) {
  return [...K]
    .sort((Q, Z) =>
      Q.box && Z.box
        ? Q.box[1] - Z.box[1] || Q.box[0] - Z.box[0]
        : Q.order - Z.order
    )
    .map((Q) => Q.text).join(`
`);
}
function LK() {
  return XK() ? c : null;
}
function lK(K) {
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
async function i(K) {
  let Q = await FK(K);
  if (!Q || Q.error) throw Error(Q?.error ?? "OCR returned no result");
  return Q;
}
async function cK(K) {
  globalThis.DOMMatrix ??= class {
    constructor(W = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = W;
    }
  };
  let Q = await UK(),
    Z = Buffer.from(K.bytes, "base64"),
    $ = await Q.getDocument({ data: new Uint8Array(Z), disableWorker: !0 })
      .promise,
    q = [],
    G,
    J = Math.min($.numPages, 64);
  for (let V = 1; V <= J; V += 1) {
    let Y = (await (await $.getPage(V)).getTextContent()).items
      .flatMap((A) =>
        A && typeof A === "object" && "str" in A ? [String(A.str).trim()] : []
      )
      .filter(Boolean)
      .join(" ");
    if (Y) {
      q.push({ text: Y, page: V });
      continue;
    }
    let X = await import(z("@napi-rs/canvas"));
    ((globalThis.DOMMatrix = X.DOMMatrix),
      (globalThis.ImageData = X.ImageData),
      (globalThis.Path2D = X.Path2D));
    class L {
      create(A, M) {
        let k = X.createCanvas(A, M);
        return { canvas: k, context: k.getContext("2d") };
      }
      reset(A, M, k) {
        ((A.canvas.width = M), (A.canvas.height = k));
      }
      destroy(A) {
        ((A.canvas.width = 0), (A.canvas.height = 0));
      }
    }
    G ??= await Q.getDocument({
      data: new Uint8Array(Z),
      disableWorker: !0,
      CanvasFactory: L,
    }).promise;
    let U = await G.getPage(V),
      j = U.getViewport({ scale: 2 }),
      H = X.createCanvas(Math.ceil(j.width), Math.ceil(j.height)),
      B = H.getContext("2d");
    await U.render({ canvas: H, canvasContext: B, viewport: j }).promise;
    let N = H.toBuffer("image/png").toString("base64"),
      _ = await i({ id: `capture:${V}`, bytes: N, mediaType: "image/png" });
    for (let A of _.regions ?? []) q.push({ ...A, page: V });
  }
  return { id: "capture", regions: q };
}
async function dK(K) {
  if (!LK())
    throw Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  let Q =
      K.mediaType === "application/pdf"
        ? await cK(K)
        : await i({ id: "capture", bytes: K.bytes, mediaType: K.mediaType }),
    Z = o(Q),
    $ = Z.filter((J) => J.confidence !== void 0),
    q = $.length ? $.reduce((J, V) => J + V.confidence, 0) / $.length : void 0,
    G = HK(Z);
  return {
    summary: G ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: G,
      engine: "automation",
      model: c,
      ...(q === void 0 ? {} : { confidence: q }),
    },
  };
}
async function sK(K, Q, Z) {
  let q = (
    await K.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: D,
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
      purpose: D,
    })
  ).rows?.[0]?.model === Q
    ? q.asset_id
    : "";
}
async function nK(K, Q) {
  let Z = await K.vault.content({
    contentId: Q.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: D,
  });
  if (Z?.status !== "ok" || Z.kind !== "bytes")
    throw Error(`asset ${Q.asset_id}: preview is unavailable`);
  let $ = await i({
    id: Q.content_id,
    bytes: Z.base64,
    mediaType: Z.mediaType,
    originalWidth: Q.width,
    originalHeight: Q.height,
  });
  return o($, Q.width, Q.height);
}
async function rK({ ctx: K, log: Q }) {
  let Z = lK(K.input);
  if (Z) return dK(Z);
  let $ = K.input?.variant === "delegate",
    q = $ ? K.input?.delegateModel : LK();
  if (!q) {
    if ($) throw Error("delegate OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  let G = K.input?.promptRev;
  if ($ && G && G !== T)
    throw Error(
      `delegate OCR: the engine profile pins prompt revision "${G}", but this handler ships "${T}"`
    );
  let J = K.input?.profileId ?? a,
    V = J === a ? "" : `:${J}`,
    W = `${$ ? "delegate" : "deterministic"}:${q}:${$ ? T : "local"}${V}`,
    F = await K.state.get("selection");
  if (F !== W) {
    let B = F === void 0 && !$ ? await sK(K, q, J) : "";
    (await K.state.set("cursor", B),
      await K.state.set("selection", W),
      await K.state.delete("confirmedModel"));
  }
  let Y = (await K.state.get("cursor")) ?? "",
    X = await K.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: Y },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: r,
      purpose: D,
    }),
    L = (X.rows ?? []).filter((B) => B.kind === "photo" || B.kind === "scan"),
    U = 0,
    j = 0;
  for (let B of L) {
    let _ = (
        await K.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: B.content_id },
            { column: "variant", op: "eq", value: "text" },
            { column: "profile", op: "eq", value: J },
          ],
          limit: 1,
          purpose: D,
        })
      ).rows?.[0],
      A = $ ? await K.state.get("confirmedModel") : q,
      M =
        typeof _?.payload_json === "string"
          ? JSON.parse(_.payload_json).prompt_rev
          : _?.prompt_rev;
    if (_?.model === A && (!$ || M === T)) {
      j += 1;
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
      ((A = C.__centraidModel),
        await K.state.set("confirmedModel", A),
        (k = o(C, B.width, B.height)));
    } else k = await nK(K, B);
    let t = HK(k);
    if (!t) {
      ((j += 1), Q.info(`photo ${B.asset_id}: no legible text`));
      continue;
    }
    let w = k.filter((C) => C.confidence !== void 0),
      e = w.length
        ? w.reduce((C, b) => C + b.confidence, 0) / w.length
        : void 0,
      AK = k.map(({ order: C, ...b }) => b);
    (await K.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: B.content_id,
        text: t,
        capability: "ocr",
        model: A,
        regions: AK,
        ...(J === a ? {} : { profile: J }),
        ...($ ? { prompt_rev: T } : {}),
        ...(e === void 0 ? {} : { confidence: e }),
      },
      purpose: D,
    }),
      (U += 1));
  }
  let H = X.rows?.at(-1)?.asset_id;
  if (H) await K.state.set("cursor", H);
  return {
    summary: `OCR derived ${U}; skipped ${j}; batch ${X.rows?.length ?? 0}/${r}`,
    output: {
      derived: U,
      skipped: j,
      model: $ ? ((await K.state.get("confirmedModel")) ?? q) : q,
      rearm: (X.rows?.length ?? 0) === r,
    },
  };
}
export { zQ as setPhotoOcrRuntimeForTests, rK as default };
