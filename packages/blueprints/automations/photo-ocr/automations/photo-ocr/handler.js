import { existsSync as EK } from "node:fs";
import { readFile as MK } from "node:fs/promises";
import T from "node:path";
import M from "node:path";
// governance: allow-repo-hygiene file-size-limit (#731) the self-contained OCR/PDF handler is one deployable runtime unit; splitting its bundled model/runtime rail would duplicate the content-resolution and bounded-batch invariants.
// Generated recognition automation. Source: tools/recognition-automations/automation-handlers.
import { pathToFileURL as xK } from "node:url";
var UK = M.resolve(import.meta.dirname, ".."),
  w = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? M.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : M.join(UK, "runtime"),
  b = M.join(w, "models");
function VK(K) {
  if (K.length === 0) throw Error("argmax: row must be non-empty");
  let Q = 0,
    $ = K[0];
  for (let Z = 1; Z < K.length; Z++) {
    let q = K[Z];
    if (q > $) (($ = q), (Q = Z));
  }
  return { index: Q, value: $ };
}
function a(K, Q, $ = 0) {
  let Z = [],
    q = [],
    G;
  for (let F of K) {
    let { index: W, value: j } = VK(F);
    if (W !== G && W !== $) {
      let Y = Q[W];
      if (Y !== void 0) (Z.push(Y), q.push(j));
    }
    G = W;
  }
  let J = q.length === 0 ? 0 : q.reduce((F, W) => F + W, 0) / q.length;
  return { text: Z.join(""), confidence: J };
}
function i(K, Q, $, Z) {
  let q = Math.max(K, Q),
    G = q > $ ? $ / q : 1,
    J = (F) => Math.max(Z, Math.round((F * G) / Z) * Z);
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
    G = Math.max(Z, Math.min(Q, Math.round(K.x + K.width))),
    J = Math.max(q, Math.min($, Math.round(K.y + K.height)));
  return [Z, q, G - Z, J - q];
}
function HK(K, Q, $, Z = 0.3) {
  let q = new Uint8Array(Q * $);
  for (let G = 0; G < q.length; G++) q[G] = (K[G] ?? 0) >= Z ? 1 : 0;
  return q;
}
function AK(K, Q, $, Z = 1) {
  let q = new Uint8Array(Q * $),
    G = [],
    J = [];
  for (let F = 0; F < K.length; F++) {
    if (!K[F] || q[F]) continue;
    (J.push(F), (q[F] = 1));
    let {
        POSITIVE_INFINITY: W,
        POSITIVE_INFINITY: j,
        NEGATIVE_INFINITY: Y,
        NEGATIVE_INFINITY: L,
      } = Number,
      H = 0;
    while (J.length > 0) {
      let X = J.pop(),
        U = X % Q,
        V = Math.floor(X / Q);
      ((W = Math.min(W, U)),
        (j = Math.min(j, V)),
        (Y = Math.max(Y, U)),
        (L = Math.max(L, V)),
        H++);
      let B = [
        U > 0 ? X - 1 : -1,
        U < Q - 1 ? X + 1 : -1,
        V > 0 ? X - Q : -1,
        V < $ - 1 ? X + Q : -1,
      ];
      for (let k of B) if (k >= 0 && K[k] && !q[k]) ((q[k] = 1), J.push(k));
    }
    if (H >= Z)
      G.push({
        box: { x: W, y: j, width: Y - W + 1, height: L - j + 1 },
        area: H,
      });
  }
  return G;
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
    G = Math.max(0, Math.min(Q, Math.round(K.x + K.width))),
    J = Math.max(0, Math.min($, Math.round(K.y + K.height)));
  return { x: Z, y: q, width: Math.max(0, G - Z), height: Math.max(0, J - q) };
}
function NK(K, Q, $) {
  let Z = Math.max(0, Math.floor($.x)),
    q = Math.max(0, Math.floor($.y)),
    G = Math.max(Z, Math.ceil($.x + $.width)),
    J = Math.max(q, Math.ceil($.y + $.height)),
    F = 0,
    W = 0;
  for (let j = q; j < J; j++)
    for (let Y = Z; Y < G; Y++) ((F += K[j * Q + Y] ?? 0), W++);
  return W === 0 ? 0 : F / W;
}
function KK(K, Q, $, Z = {}) {
  let {
      binaryThreshold: q = 0.3,
      boxScoreThreshold: G = 0.5,
      unclipRatio: J = 1.5,
      minArea: F = 4,
    } = Z,
    W = HK(K, Q, $, q),
    j = AK(W, Q, $, F),
    Y = [];
  for (let L of j) {
    let H = NK(K, Q, L.box);
    if (H < G) continue;
    let X = BK(L.box, L.area, J),
      U = kK(X, Q, $);
    if (U.width <= 0 || U.height <= 0) continue;
    Y.push({ box: U, score: H });
  }
  return Y;
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
async function S() {
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
  let $ = S().then((Z) => Z.InferenceSession.create(K));
  I.set(K, $);
  try {
    return await $;
  } catch (Z) {
    throw (I.delete(K), Z);
  }
}
import { pathToFileURL as OK } from "node:url";
var R;
async function g() {
  if (R) return R;
  let K = z("sharp");
  return ((R = (await import(OK(K).href)).default), R);
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
    { data: G, info: J } = await q
      .resize({ width: Q, height: $, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(G.buffer, G.byteOffset, G.byteLength),
    width: J.width,
    height: J.height,
  };
}
function qK(K, Q) {
  let $ = Math.max(0, Math.min(K.width, Math.round(Q.x))),
    Z = Math.max(0, Math.min(K.height, Math.round(Q.y))),
    q = Math.max($, Math.min(K.width, Math.round(Q.x + Q.width))),
    G = Math.max(Z, Math.min(K.height, Math.round(Q.y + Q.height))),
    J = q - $,
    F = G - Z,
    W = new Uint8Array(J * F * 3);
  for (let j = 0; j < F; j++) {
    let Y = ((Z + j) * K.width + $) * 3,
      L = j * J * 3;
    W.set(K.data.subarray(Y, Y + J * 3), L);
  }
  return { data: W, width: J, height: F };
}
async function JK(K, Q, $) {
  let q = (await g())(Buffer.from(K.data), {
      raw: { width: K.width, height: K.height, channels: 3 },
    }),
    { data: G, info: J } = await q
      .resize({ width: Q, height: $, fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(G.buffer, G.byteOffset, G.byteLength),
    width: J.width,
    height: J.height,
  };
}
var zK = [0.485, 0.456, 0.406],
  TK = [0.229, 0.224, 0.225];
function p(K) {
  let { width: Q, height: $, data: Z } = K,
    q = Q * $,
    G = new Float32Array(q * 3);
  for (let J = 0; J < q; J++)
    for (let F = 0; F < 3; F++) {
      let W = (Z[J * 3 + F] ?? 0) / 255;
      G[F * q + J] = (W - zK[F]) / TK[F];
    }
  return G;
}
var h = "pp-ocrv4@1",
  l = T.join(b, "ocr"),
  DK = T.join(l, "det.onnx"),
  IK = T.join(l, "rec.onnx"),
  PK = T.join(l, "dict.txt"),
  SK = 960,
  RK = 32,
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
    $ = i(Q.width, Q.height, SK, RK),
    Z = await $K(K, $.width, $.height),
    q = p(Z),
    G = await S(),
    J = await x(DK),
    F = J.inputNames[0] ?? "x",
    W = await J.run({
      [F]: new G.Tensor("float32", q, [1, 3, $.height, $.width]),
    }),
    j = J.outputNames[0],
    Y = j ? W[j]?.data : void 0;
  if (!Y || !(Y instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: KK(Y, $.width, $.height).map(({ box: X, score: U }) => ({
      box: t(u(X, $, Q)),
      score: U,
    })),
    native: Q,
  };
}
async function uK(K) {
  let Q = f / K.height,
    $ = Math.min(fK, Math.max(f, Math.round(K.width * Q))),
    Z = await JK(K, $, f),
    q = p(Z),
    G = await S(),
    J = await x(IK),
    F = J.inputNames[0] ?? "x",
    W = await J.run({ [F]: new G.Tensor("float32", q, [1, 3, f, $]) }),
    j = J.outputNames[0],
    Y = j ? W[j] : void 0;
  if (!Y || !(Y.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let L = await wK(),
    H = L.length,
    X = Y.data.length / H,
    U = [];
  for (let V = 0; V < X; V++) {
    let B = Array.from(Y.data.subarray(V * H, (V + 1) * H));
    U.push(B);
  }
  return a(U, L);
}
async function d(K) {
  try {
    let Q = Buffer.from(K.bytes, "base64"),
      { boxes: $, native: Z } = await bK(Q),
      q = await m(Q),
      G =
        K.originalWidth && K.originalHeight
          ? { width: K.originalWidth, height: K.originalHeight }
          : { width: Z.width, height: Z.height },
      F = (
        await Promise.all(
          $.map(async (W) => {
            let [j, Y, L, H] = W.box,
              X = qK(q, { x: j, y: Y, width: L, height: H });
            if (X.width <= 0 || X.height <= 0) return;
            let U = await uK(X);
            if (!U.text) return;
            let V = e(
              u({ x: j, y: Y, width: L, height: H }, Z, G),
              G.width,
              G.height
            );
            if (V[2] <= 0 || V[3] <= 0) return;
            return { text: U.text, confidence: U.confidence, box: V };
          })
        )
      ).filter((W) => W !== void 0);
    return { id: K.id, regions: F };
  } catch (Q) {
    return { id: K.id, error: Q instanceof Error ? Q.message : String(Q) };
  }
}
var s = 16,
  E = "dpv:ServiceProvision",
  r = "ocr-v1",
  GK = d,
  FK = c,
  WK = async () => {
    let K = z("pdfjs-dist/legacy/build/pdf.mjs");
    return import(xK(K).href);
  },
  YK = WK;
function kQ(K) {
  ((GK = K?.recognize ?? d),
    (FK = K?.weightsPresent ?? c),
    (YK = K?.loadPdfJs ?? WK));
}
function n(K, Q, $) {
  if (!K) return [];
  if (!Array.isArray(K.regions))
    return typeof K.text === "string" && K.text.trim()
      ? [{ text: K.text, order: 0 }]
      : [];
  return K.regions.flatMap((Z, q) => {
    if (!Z || typeof Z.text !== "string") return [];
    let G = Z.confidence;
    if (G !== void 0 && (typeof G !== "number" || G < 0 || G > 1)) return [];
    let J = Array.isArray(Z.box) && Z.box.length === 4 ? Z.box : null,
      F =
        J &&
        J.every(
          (W) => typeof W === "number" && Number.isSafeInteger(W) && W >= 0
        ) &&
        J[2] > 0 &&
        J[3] > 0 &&
        (!Q || J[0] + J[2] <= Q) &&
        (!$ || J[1] + J[3] <= $);
    return [
      {
        text: Z.text,
        order: q,
        ...(F ? { box: J } : {}),
        ...(G === void 0 ? {} : { confidence: G }),
      },
    ];
  });
}
function XK(K) {
  return [...K]
    .sort((Q, $) =>
      Q.box && $.box
        ? Q.box[1] - $.box[1] || Q.box[0] - $.box[0]
        : Q.order - $.order
    )
    .map((Q) => Q.text).join(`
`);
}
function jK() {
  return FK() ? h : null;
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
async function o(K) {
  let Q = await GK(K);
  if (!Q || Q.error) throw Error(Q?.error ?? "OCR returned no result");
  return Q;
}
async function mK(K) {
  globalThis.DOMMatrix ??= class {
    constructor(W = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = W;
    }
  };
  let Q = await YK(),
    $ = Buffer.from(K.bytes, "base64"),
    Z = await Q.getDocument({ data: new Uint8Array($), disableWorker: !0 })
      .promise,
    q = [],
    G,
    J = Math.min(Z.numPages, 64);
  for (let F = 1; F <= J; F += 1) {
    let Y = (await (await Z.getPage(F)).getTextContent()).items
      .flatMap((A) =>
        A && typeof A === "object" && "str" in A ? [String(A.str).trim()] : []
      )
      .filter(Boolean)
      .join(" ");
    if (Y) {
      q.push({ text: Y, page: F });
      continue;
    }
    let L = await import(z("@napi-rs/canvas"));
    ((globalThis.DOMMatrix = L.DOMMatrix),
      (globalThis.ImageData = L.ImageData),
      (globalThis.Path2D = L.Path2D));
    class H {
      create(A, C) {
        let O = L.createCanvas(A, C);
        return { canvas: O, context: O.getContext("2d") };
      }
      reset(A, C, O) {
        ((A.canvas.width = C), (A.canvas.height = O));
      }
      destroy(A) {
        ((A.canvas.width = 0), (A.canvas.height = 0));
      }
    }
    G ??= await Q.getDocument({
      data: new Uint8Array($),
      disableWorker: !0,
      CanvasFactory: H,
    }).promise;
    let X = await G.getPage(F),
      U = X.getViewport({ scale: 2 }),
      V = L.createCanvas(Math.ceil(U.width), Math.ceil(U.height)),
      B = V.getContext("2d");
    await X.render({ canvas: V, canvasContext: B, viewport: U }).promise;
    let k = V.toBuffer("image/png").toString("base64"),
      _ = await o({ id: `capture:${F}`, bytes: k, mediaType: "image/png" });
    for (let A of _.regions ?? []) q.push({ ...A, page: F });
  }
  return { id: "capture", regions: q };
}
async function pK(K) {
  if (!jK())
    throw Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  let Q =
      K.mediaType === "application/pdf"
        ? await mK(K)
        : await o({ id: "capture", bytes: K.bytes, mediaType: K.mediaType }),
    $ = n(Q),
    Z = $.filter((J) => J.confidence !== void 0),
    q = Z.length ? Z.reduce((J, F) => J + F.confidence, 0) / Z.length : void 0,
    G = XK($);
  return {
    summary: G ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: G,
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
  let Z = await o({
    id: Q.content_id,
    bytes: $.base64,
    mediaType: $.mediaType,
    originalWidth: Q.width,
    originalHeight: Q.height,
  });
  return n(Z, Q.width, Q.height);
}
async function cK({ ctx: K, log: Q }) {
  let $ = gK(K.input);
  if ($) return pK($);
  let Z = K.input?.variant === "agent",
    q = Z ? K.input?.agentModel : jK();
  if (!q) {
    if (Z) throw Error("agent OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  let G = `${Z ? "agent" : "deterministic"}:${q}:${Z ? r : "local"}`,
    J = await K.state.get("selection");
  if (J !== G) {
    let X = J === void 0 && !Z ? await hK(K, q) : "";
    (await K.state.set("cursor", X),
      await K.state.set("selection", G),
      await K.state.delete("confirmedModel"));
  }
  let F = (await K.state.get("cursor")) ?? "",
    W = await K.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: F },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: s,
      purpose: E,
    }),
    j = (W.rows ?? []).filter((X) => X.kind === "photo" || X.kind === "scan"),
    Y = 0,
    L = 0;
  for (let X of j) {
    let V = (
        await K.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: X.content_id },
            { column: "variant", op: "eq", value: "text" },
          ],
          limit: 1,
          purpose: E,
        })
      ).rows?.[0],
      B = Z ? await K.state.get("confirmedModel") : q,
      k =
        typeof V?.payload_json === "string"
          ? JSON.parse(V.payload_json).prompt_rev
          : V?.prompt_rev;
    if (V?.model === B && (!Z || k === r)) {
      L += 1;
      continue;
    }
    let _;
    if (Z) {
      let N = await K.agent({
        prompt:
          "Transcribe all visible text in reading order. Return regions with text and optional [x,y,w,h] boxes; never invent confidence.",
        json: {
          type: "object",
          required: ["regions"],
          properties: { regions: { type: "array" } },
        },
        content: [
          { contentId: X.content_id, variant: "preview", maxBytes: 4194304 },
        ],
      });
      if (typeof N?.__centraidModel !== "string")
        throw Error("agent OCR returned no ACP-confirmed model identity");
      ((B = N.__centraidModel),
        await K.state.set("confirmedModel", B),
        (_ = n(N, X.width, X.height)));
    } else _ = await lK(K, X);
    let A = XK(_);
    if (!A) {
      ((L += 1), Q.info(`photo ${X.asset_id}: no legible text`));
      continue;
    }
    let C = _.filter((N) => N.confidence !== void 0),
      O = C.length
        ? C.reduce((N, y) => N + y.confidence, 0) / C.length
        : void 0,
      LK = _.map(({ order: N, ...y }) => y);
    (await K.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: X.content_id,
        text: A,
        capability: "ocr",
        model: B,
        regions: LK,
        ...(Z ? { prompt_rev: r } : {}),
        ...(O === void 0 ? {} : { confidence: O }),
      },
      purpose: E,
    }),
      (Y += 1));
  }
  let H = W.rows?.at(-1)?.asset_id;
  if (H) await K.state.set("cursor", H);
  return {
    summary: `OCR derived ${Y}; skipped ${L}; batch ${W.rows?.length ?? 0}/${s}`,
    output: {
      derived: Y,
      skipped: L,
      model: Z ? ((await K.state.get("confirmedModel")) ?? q) : q,
      rearm: (W.rows?.length ?? 0) === s,
    },
  };
}
export { kQ as setPhotoOcrRuntimeForTests, cK as default };
