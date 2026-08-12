import { existsSync as EK } from "node:fs";
import { readFile as MK } from "node:fs/promises";
import T from "node:path";
import M from "node:path";
// governance: allow-repo-hygiene file-size-limit (#731) the self-contained OCR/PDF handler is one deployable runtime unit; splitting its bundled model/runtime rail would duplicate the content-resolution and bounded-batch invariants.
// Generated recognition automation. Source: tools/recognition-automations/automation-handlers.
import { pathToFileURL as xK } from "node:url";
var LK = M.resolve(import.meta.dirname, ".."),
  w = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? M.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : M.join(LK, "runtime"),
  b = M.join(w, "models");
function UK(K) {
  if (K.length === 0) throw Error("argmax: row must be non-empty");
  let Q = 0,
    $ = K[0];
  for (let Z = 1; Z < K.length; Z++) {
    let q = K[Z];
    if (q > $) (($ = q), (Q = Z));
  }
  return { index: Q, value: $ };
}
function o(K, Q, $ = 0) {
  let Z = [],
    q = [],
    V;
  for (let G of K) {
    let { index: F, value: X } = UK(G);
    if (F !== V && F !== $) {
      let W = Q[F];
      if (W !== void 0) (Z.push(W), q.push(X));
    }
    V = F;
  }
  let J = q.length === 0 ? 0 : q.reduce((G, F) => G + F, 0) / q.length;
  return { text: Z.join(""), confidence: J };
}
function i(K, Q, $, Z) {
  let q = Math.max(K, Q),
    V = q > $ ? $ / q : 1,
    J = (G) => Math.max(Z, Math.round((G * V) / Z) * Z);
  return { width: J(K), height: J(Q) };
}
function u(K, Q, $) {
  let Z = $.width / Q.width,
    q = $.height / Q.height;
  return { x: K.x * Z, y: K.y * q, width: K.width * Z, height: K.height * q };
}
function t(K) {
  return [
    Math.round(K.x),
    Math.round(K.y),
    Math.round(K.width),
    Math.round(K.height),
  ];
}
function e(K, Q, $) {
  let Z = Math.max(0, Math.min(Q, Math.round(K.x))),
    q = Math.max(0, Math.min($, Math.round(K.y))),
    V = Math.max(Z, Math.min(Q, Math.round(K.x + K.width))),
    J = Math.max(q, Math.min($, Math.round(K.y + K.height)));
  return [Z, q, V - Z, J - q];
}
function HK(K, Q, $, Z = 0.3) {
  let q = new Uint8Array(Q * $);
  for (let V = 0; V < q.length; V++) q[V] = (K[V] ?? 0) >= Z ? 1 : 0;
  return q;
}
function AK(K, Q, $, Z = 1) {
  let q = new Uint8Array(Q * $),
    V = [],
    J = [];
  for (let G = 0; G < K.length; G++) {
    if (!K[G] || q[G]) continue;
    (J.push(G), (q[G] = 1));
    let {
        POSITIVE_INFINITY: F,
        POSITIVE_INFINITY: X,
        NEGATIVE_INFINITY: W,
        NEGATIVE_INFINITY: j,
      } = Number,
      H = 0;
    while (J.length > 0) {
      let Y = J.pop(),
        L = Y % Q,
        U = Math.floor(Y / Q);
      ((F = Math.min(F, L)),
        (X = Math.min(X, U)),
        (W = Math.max(W, L)),
        (j = Math.max(j, U)),
        H++);
      let B = [
        L > 0 ? Y - 1 : -1,
        L < Q - 1 ? Y + 1 : -1,
        U > 0 ? Y - Q : -1,
        U < $ - 1 ? Y + Q : -1,
      ];
      for (let k of B) if (k >= 0 && K[k] && !q[k]) ((q[k] = 1), J.push(k));
    }
    if (H >= Z)
      V.push({
        box: { x: F, y: X, width: W - F + 1, height: j - X + 1 },
        area: H,
      });
  }
  return V;
}
function BK(K, Q, $ = 1.5) {
  let Z = 2 * (K.width + K.height);
  if (Z <= 0) return K;
  let q = (Q * $) / Z;
  return {
    x: K.x - q,
    y: K.y - q,
    width: K.width + q * 2,
    height: K.height + q * 2,
  };
}
function kK(K, Q, $) {
  let Z = Math.max(0, Math.min(Q, Math.round(K.x))),
    q = Math.max(0, Math.min($, Math.round(K.y))),
    V = Math.max(0, Math.min(Q, Math.round(K.x + K.width))),
    J = Math.max(0, Math.min($, Math.round(K.y + K.height)));
  return { x: Z, y: q, width: Math.max(0, V - Z), height: Math.max(0, J - q) };
}
function NK(K, Q, $) {
  let Z = Math.max(0, Math.floor($.x)),
    q = Math.max(0, Math.floor($.y)),
    V = Math.max(Z, Math.ceil($.x + $.width)),
    J = Math.max(q, Math.ceil($.y + $.height)),
    G = 0,
    F = 0;
  for (let X = q; X < J; X++)
    for (let W = Z; W < V; W++) ((G += K[X * Q + W] ?? 0), F++);
  return F === 0 ? 0 : G / F;
}
function KK(K, Q, $, Z = {}) {
  let {
      binaryThreshold: q = 0.3,
      boxScoreThreshold: V = 0.5,
      unclipRatio: J = 1.5,
      minArea: G = 4,
    } = Z,
    F = HK(K, Q, $, q),
    X = AK(F, Q, $, G),
    W = [];
  for (let j of X) {
    let H = NK(K, Q, j.box);
    if (H < V) continue;
    let Y = BK(j.box, j.area, J),
      L = kK(Y, Q, $);
    if (L.width <= 0 || L.height <= 0) continue;
    W.push({ box: L, score: H });
  }
  return W;
}
import { existsSync as ZK } from "node:fs";
import { createRequire as _K } from "node:module";
import QK from "node:path";
import { pathToFileURL as CK } from "node:url";
var D;
class P extends Error {
  constructor(K, Q) {
    super(
      `Automation model runtime dependency "${K}" is not installed. ` +
        'Run "bun run --cwd tools/recognition-automations setup" first — it installs ' +
        "optional native recognition dependencies into tools/recognition-automations/runtime/ and downloads the model weights those capabilities need.",
      { cause: Q }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function z(K, Q = w) {
  if (!ZK(QK.join(Q, "node_modules"))) throw new P(K);
  let $ = _K(QK.join(Q, "package.json"));
  try {
    return $.resolve(K);
  } catch (Z) {
    throw new P(K, Z);
  }
}
async function R() {
  if (D) return D;
  let K = z("onnxruntime-node");
  return ((D = await import(CK(K).href)), D);
}
var I;
async function x(K) {
  I ??= new Map();
  let Q = I.get(K);
  if (Q) return Q;
  if (!ZK(K)) throw new P(K);
  let $ = R().then((Z) => Z.InferenceSession.create(K));
  I.set(K, $);
  try {
    return await $;
  } catch (Z) {
    throw (I.delete(K), Z);
  }
}
import { pathToFileURL as OK } from "node:url";
var S;
async function g() {
  if (S) return S;
  let K = z("sharp");
  return ((S = (await import(OK(K).href)).default), S);
}
async function m(K) {
  let $ = (await g())(Buffer.from(K)),
    { data: Z, info: q } = await $.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(Z.buffer, Z.byteOffset, Z.byteLength),
    width: q.width,
    height: q.height,
  };
}
async function $K(K, Q, $) {
  let q = (await g())(Buffer.from(K)),
    { data: V, info: J } = await q
      .resize({ width: Q, height: $, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(V.buffer, V.byteOffset, V.byteLength),
    width: J.width,
    height: J.height,
  };
}
function qK(K, Q) {
  let $ = Math.max(0, Math.min(K.width, Math.round(Q.x))),
    Z = Math.max(0, Math.min(K.height, Math.round(Q.y))),
    q = Math.max($, Math.min(K.width, Math.round(Q.x + Q.width))),
    V = Math.max(Z, Math.min(K.height, Math.round(Q.y + Q.height))),
    J = q - $,
    G = V - Z,
    F = new Uint8Array(J * G * 3);
  for (let X = 0; X < G; X++) {
    let W = ((Z + X) * K.width + $) * 3,
      j = X * J * 3;
    F.set(K.data.subarray(W, W + J * 3), j);
  }
  return { data: F, width: J, height: G };
}
async function JK(K, Q, $) {
  let q = (await g())(Buffer.from(K.data), {
      raw: { width: K.width, height: K.height, channels: 3 },
    }),
    { data: V, info: J } = await q
      .resize({ width: Q, height: $, fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(V.buffer, V.byteOffset, V.byteLength),
    width: J.width,
    height: J.height,
  };
}
var zK = [0.485, 0.456, 0.406],
  TK = [0.229, 0.224, 0.225];
function p(K) {
  let { width: Q, height: $, data: Z } = K,
    q = Q * $,
    V = new Float32Array(q * 3);
  for (let J = 0; J < q; J++)
    for (let G = 0; G < 3; G++) {
      let F = (Z[J * 3 + G] ?? 0) / 255;
      V[G * q + J] = (F - zK[G]) / TK[G];
    }
  return V;
}
var h = "pp-ocrv4@1",
  l = T.join(b, "ocr"),
  DK = T.join(l, "det.onnx"),
  IK = T.join(l, "rec.onnx"),
  PK = T.join(l, "dict.txt"),
  RK = 960,
  SK = 32,
  f = 48,
  fK = 320;
function c(K = b) {
  let Q = T.join(K, "ocr");
  return ["det.onnx", "rec.onnx", "dict.txt"].every(($) => EK(T.join(Q, $)));
}
function vK(K) {
  return ["", ...K, " "];
}
function yK(K) {
  let Q = K.split(/\r?\n/u);
  if (Q.at(-1) === "") Q.pop();
  return Q;
}
var v;
async function wK() {
  if (v) return v;
  let K = await MK(PK, "utf8");
  return ((v = vK(yK(K))), v);
}
async function bK(K) {
  let Q = await m(K),
    $ = i(Q.width, Q.height, RK, SK),
    Z = await $K(K, $.width, $.height),
    q = p(Z),
    V = await R(),
    J = await x(DK),
    G = J.inputNames[0] ?? "x",
    F = await J.run({
      [G]: new V.Tensor("float32", q, [1, 3, $.height, $.width]),
    }),
    X = J.outputNames[0],
    W = X ? F[X]?.data : void 0;
  if (!W || !(W instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: KK(W, $.width, $.height).map(({ box: Y, score: L }) => ({
      box: t(u(Y, $, Q)),
      score: L,
    })),
    native: Q,
  };
}
async function uK(K) {
  let Q = f / K.height,
    $ = Math.min(fK, Math.max(f, Math.round(K.width * Q))),
    Z = await JK(K, $, f),
    q = p(Z),
    V = await R(),
    J = await x(IK),
    G = J.inputNames[0] ?? "x",
    F = await J.run({ [G]: new V.Tensor("float32", q, [1, 3, f, $]) }),
    X = J.outputNames[0],
    W = X ? F[X] : void 0;
  if (!W || !(W.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let j = await wK(),
    H = j.length,
    Y = W.data.length / H,
    L = [];
  for (let U = 0; U < Y; U++) {
    let B = Array.from(W.data.subarray(U * H, (U + 1) * H));
    L.push(B);
  }
  return o(L, j);
}
async function d(K) {
  try {
    let Q = Buffer.from(K.bytes, "base64"),
      { boxes: $, native: Z } = await bK(Q),
      q = await m(Q),
      V =
        K.originalWidth && K.originalHeight
          ? { width: K.originalWidth, height: K.originalHeight }
          : { width: Z.width, height: Z.height },
      G = (
        await Promise.all(
          $.map(async (F) => {
            let [X, W, j, H] = F.box,
              Y = qK(q, { x: X, y: W, width: j, height: H });
            if (Y.width <= 0 || Y.height <= 0) return;
            let L = await uK(Y);
            if (!L.text) return;
            let U = e(
              u({ x: X, y: W, width: j, height: H }, Z, V),
              V.width,
              V.height
            );
            if (U[2] <= 0 || U[3] <= 0) return;
            return { text: L.text, confidence: L.confidence, box: U };
          })
        )
      ).filter((F) => F !== void 0);
    return { id: K.id, regions: G };
  } catch (Q) {
    return { id: K.id, error: Q instanceof Error ? Q.message : String(Q) };
  }
}
var s = 16,
  E = "dpv:ServiceProvision",
  n = "ocr-v1",
  VK = d,
  GK = c,
  FK = async () => {
    let K = z("pdfjs-dist/legacy/build/pdf.mjs");
    return import(xK(K).href);
  },
  WK = FK;
function kQ(K) {
  ((VK = K?.recognize ?? d),
    (GK = K?.weightsPresent ?? c),
    (WK = K?.loadPdfJs ?? FK));
}
function r(K, Q, $) {
  if (!K) return [];
  if (!Array.isArray(K.regions))
    return typeof K.text === "string" && K.text.trim()
      ? [{ text: K.text, order: 0 }]
      : [];
  return K.regions.flatMap((Z, q) => {
    if (!Z || typeof Z.text !== "string") return [];
    let V = Z.confidence;
    if (V !== void 0 && (typeof V !== "number" || V < 0 || V > 1)) return [];
    let J = Array.isArray(Z.box) && Z.box.length === 4 ? Z.box : null,
      G =
        J &&
        J.every(
          (F) => typeof F === "number" && Number.isSafeInteger(F) && F >= 0
        ) &&
        J[2] > 0 &&
        J[3] > 0 &&
        (!Q || J[0] + J[2] <= Q) &&
        (!$ || J[1] + J[3] <= $);
    return [
      {
        text: Z.text,
        order: q,
        ...(G ? { box: J } : {}),
        ...(V === void 0 ? {} : { confidence: V }),
      },
    ];
  });
}
function YK(K) {
  return [...K]
    .sort((Q, $) =>
      Q.box && $.box
        ? Q.box[1] - $.box[1] || Q.box[0] - $.box[0]
        : Q.order - $.order
    )
    .map((Q) => Q.text).join(`
`);
}
function XK() {
  return GK() ? h : null;
}
function gK(K) {
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
async function a(K) {
  let Q = await VK(K);
  if (!Q || Q.error) throw Error(Q?.error ?? "OCR returned no result");
  return Q;
}
async function mK(K) {
  globalThis.DOMMatrix ??= class {
    constructor(F = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = F;
    }
  };
  let Q = await WK(),
    $ = Buffer.from(K.bytes, "base64"),
    Z = await Q.getDocument({ data: new Uint8Array($), disableWorker: !0 })
      .promise,
    q = [],
    V,
    J = Math.min(Z.numPages, 64);
  for (let G = 1; G <= J; G += 1) {
    let W = (await (await Z.getPage(G)).getTextContent()).items
      .flatMap((A) =>
        A && typeof A === "object" && "str" in A ? [String(A.str).trim()] : []
      )
      .filter(Boolean)
      .join(" ");
    if (W) {
      q.push({ text: W, page: G });
      continue;
    }
    let j = await import(z("@napi-rs/canvas"));
    ((globalThis.DOMMatrix = j.DOMMatrix),
      (globalThis.ImageData = j.ImageData),
      (globalThis.Path2D = j.Path2D));
    class H {
      create(A, C) {
        let O = j.createCanvas(A, C);
        return { canvas: O, context: O.getContext("2d") };
      }
      reset(A, C, O) {
        ((A.canvas.width = C), (A.canvas.height = O));
      }
      destroy(A) {
        ((A.canvas.width = 0), (A.canvas.height = 0));
      }
    }
    V ??= await Q.getDocument({
      data: new Uint8Array($),
      disableWorker: !0,
      CanvasFactory: H,
    }).promise;
    let Y = await V.getPage(G),
      L = Y.getViewport({ scale: 2 }),
      U = j.createCanvas(Math.ceil(L.width), Math.ceil(L.height)),
      B = U.getContext("2d");
    await Y.render({ canvas: U, canvasContext: B, viewport: L }).promise;
    let k = U.toBuffer("image/png").toString("base64"),
      _ = await a({ id: `capture:${G}`, bytes: k, mediaType: "image/png" });
    for (let A of _.regions ?? []) q.push({ ...A, page: G });
  }
  return { id: "capture", regions: q };
}
async function pK(K) {
  if (!XK())
    throw Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  let Q =
      K.mediaType === "application/pdf"
        ? await mK(K)
        : await a({ id: "capture", bytes: K.bytes, mediaType: K.mediaType }),
    $ = r(Q),
    Z = $.filter((J) => J.confidence !== void 0),
    q = Z.length ? Z.reduce((J, G) => J + G.confidence, 0) / Z.length : void 0,
    V = YK($);
  return {
    summary: V ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: V,
      engine: "automation",
      model: h,
      ...(q === void 0 ? {} : { confidence: q }),
    },
  };
}
async function hK(K, Q) {
  let Z = (
    await K.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: E,
    })
  ).rows?.[0];
  if (!Z) return "";
  return (
    await K.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: Z.content_id },
        { column: "variant", op: "eq", value: "text" },
      ],
      limit: 1,
      purpose: E,
    })
  ).rows?.[0]?.model === Q
    ? Z.asset_id
    : "";
}
async function lK(K, Q) {
  let $ = await K.vault.content({
    contentId: Q.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: E,
  });
  if ($?.status !== "ok" || $.kind !== "bytes")
    throw Error(`asset ${Q.asset_id}: preview is unavailable`);
  let Z = await a({
    id: Q.content_id,
    bytes: $.base64,
    mediaType: $.mediaType,
    originalWidth: Q.width,
    originalHeight: Q.height,
  });
  return r(Z, Q.width, Q.height);
}
async function cK({ ctx: K, log: Q }) {
  let $ = gK(K.input);
  if ($) return pK($);
  let Z = K.input?.variant === "delegate",
    q = Z ? K.input?.delegateModel : XK();
  if (!q) {
    if (Z) throw Error("delegate OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  let V = `${Z ? "delegate" : "deterministic"}:${q}:${Z ? n : "local"}`,
    J = await K.state.get("selection");
  if (J !== V) {
    let Y = J === void 0 && !Z ? await hK(K, q) : "";
    (await K.state.set("cursor", Y),
      await K.state.set("selection", V),
      await K.state.delete("confirmedModel"));
  }
  let G = (await K.state.get("cursor")) ?? "",
    F = await K.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: G },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: s,
      purpose: E,
    }),
    X = (F.rows ?? []).filter((Y) => Y.kind === "photo" || Y.kind === "scan"),
    W = 0,
    j = 0;
  for (let Y of X) {
    let U = (
        await K.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: Y.content_id },
            { column: "variant", op: "eq", value: "text" },
          ],
          limit: 1,
          purpose: E,
        })
      ).rows?.[0],
      B = Z ? await K.state.get("confirmedModel") : q,
      k =
        typeof U?.payload_json === "string"
          ? JSON.parse(U.payload_json).prompt_rev
          : U?.prompt_rev;
    if (U?.model === B && (!Z || k === n)) {
      j += 1;
      continue;
    }
    let _;
    if (Z) {
      let N = await K.delegate({
        prompt:
          "Transcribe all visible text in reading order. Return regions with text and optional [x,y,w,h] boxes; never invent confidence.",
        json: {
          type: "object",
          required: ["regions"],
          properties: { regions: { type: "array" } },
        },
        content: [
          { contentId: Y.content_id, variant: "preview", maxBytes: 4194304 },
        ],
      });
      if (typeof N?.__centraidModel !== "string")
        throw Error("delegate OCR returned no ACP-confirmed model identity");
      ((B = N.__centraidModel),
        await K.state.set("confirmedModel", B),
        (_ = r(N, Y.width, Y.height)));
    } else _ = await lK(K, Y);
    let A = YK(_);
    if (!A) {
      ((j += 1), Q.info(`photo ${Y.asset_id}: no legible text`));
      continue;
    }
    let C = _.filter((N) => N.confidence !== void 0),
      O = C.length
        ? C.reduce((N, y) => N + y.confidence, 0) / C.length
        : void 0,
      jK = _.map(({ order: N, ...y }) => y);
    (await K.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: Y.content_id,
        text: A,
        capability: "ocr",
        model: B,
        regions: jK,
        ...(Z ? { prompt_rev: n } : {}),
        ...(O === void 0 ? {} : { confidence: O }),
      },
      purpose: E,
    }),
      (W += 1));
  }
  let H = F.rows?.at(-1)?.asset_id;
  if (H) await K.state.set("cursor", H);
  return {
    summary: `OCR derived ${W}; skipped ${j}; batch ${F.rows?.length ?? 0}/${s}`,
    output: {
      derived: W,
      skipped: j,
      model: Z ? ((await K.state.get("confirmedModel")) ?? q) : q,
      rearm: (F.rows?.length ?? 0) === s,
    },
  };
}
export { kQ as setPhotoOcrRuntimeForTests, cK as default };
