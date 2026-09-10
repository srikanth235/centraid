import { existsSync as sq } from "node:fs";
import { readFile as nq } from "node:fs/promises";
import M from "node:path";
import v from "node:path";
// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { pathToFileURL as J0 } from "node:url";
var Tq = v.resolve(import.meta.dirname, ".."),
  Iq = "__centraidAutomationRuntimeDir";
function Sq() {
  let q = globalThis[Iq];
  if (typeof q === "string" && q.length > 0) return v.resolve(q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return v.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return v.join(Tq, "runtime");
}
var p = Sq(),
  l = v.join(p, "models");
function fq(q) {
  if (q.length === 0) throw Error("argmax: row must be non-empty");
  let K = 0,
    Q = q[0];
  for (let Z = 1; Z < q.length; Z++) {
    let $ = q[Z];
    if ($ > Q) ((Q = $), (K = Z));
  }
  return { index: K, value: Q };
}
function Wq(q, K, Q = 0) {
  let Z = [],
    $ = [],
    W;
  for (let V of q) {
    let { index: G, value: U } = fq(V);
    if (G !== W && G !== Q) {
      let Y = K[G];
      if (Y !== void 0) (Z.push(Y), $.push(U));
    }
    W = G;
  }
  let J = $.length === 0 ? 0 : $.reduce((V, G) => V + G, 0) / $.length;
  return { text: Z.join(""), confidence: J };
}
function Vq(q, K, Q, Z) {
  let $ = Math.max(q, K),
    W = $ > Q ? Q / $ : 1,
    J = (V) => Math.max(Z, Math.round((V * W) / Z) * Z);
  return { width: J(q), height: J(K) };
}
function c(q, K, Q) {
  let Z = Q.width / K.width,
    $ = Q.height / K.height;
  return { x: q.x * Z, y: q.y * $, width: q.width * Z, height: q.height * $ };
}
function Gq(q) {
  return [
    Math.round(q.x),
    Math.round(q.y),
    Math.round(q.width),
    Math.round(q.height),
  ];
}
function Yq(q, K, Q) {
  let Z = Math.max(0, Math.min(K, Math.round(q.x))),
    $ = Math.max(0, Math.min(Q, Math.round(q.y))),
    W = Math.max(Z, Math.min(K, Math.round(q.x + q.width))),
    J = Math.max($, Math.min(Q, Math.round(q.y + q.height)));
  return [Z, $, W - Z, J - $];
}
function Rq(q, K, Q, Z = 0.3) {
  let $ = new Uint8Array(K * Q);
  for (let W = 0; W < $.length; W++) $[W] = (q[W] ?? 0) >= Z ? 1 : 0;
  return $;
}
function yq(q, K, Q, Z = 1) {
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
        NEGATIVE_INFINITY: H,
      } = Number,
      A = 0;
    while (J.length > 0) {
      let j = J.pop(),
        X = j % K,
        F = Math.floor(j / K);
      ((G = Math.min(G, X)),
        (U = Math.min(U, F)),
        (Y = Math.max(Y, X)),
        (H = Math.max(H, F)),
        A++);
      let N = [
        X > 0 ? j - 1 : -1,
        X < K - 1 ? j + 1 : -1,
        F > 0 ? j - K : -1,
        F < Q - 1 ? j + K : -1,
      ];
      for (let C of N) if (C >= 0 && q[C] && !$[C]) (($[C] = 1), J.push(C));
    }
    if (A >= Z)
      W.push({
        box: { x: G, y: U, width: Y - G + 1, height: H - U + 1 },
        area: A,
      });
  }
  return W;
}
function wq(q, K, Q = 1.5) {
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
function bq(q, K, Q) {
  let Z = Math.max(0, Math.min(K, Math.round(q.x))),
    $ = Math.max(0, Math.min(Q, Math.round(q.y))),
    W = Math.max(0, Math.min(K, Math.round(q.x + q.width))),
    J = Math.max(0, Math.min(Q, Math.round(q.y + q.height)));
  return { x: Z, y: $, width: Math.max(0, W - Z), height: Math.max(0, J - $) };
}
function uq(q, K, Q) {
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
function Uq(q, K, Q, Z = {}) {
  let {
      binaryThreshold: $ = 0.3,
      boxScoreThreshold: W = 0.5,
      unclipRatio: J = 1.5,
      minArea: V = 4,
    } = Z,
    G = Rq(q, K, Q, $),
    U = yq(G, K, Q, V),
    Y = [];
  for (let H of U) {
    let A = uq(q, K, H.box);
    if (A < W) continue;
    let j = wq(H.box, H.area, J),
      X = bq(j, K, Q);
    if (X.width <= 0 || X.height <= 0) continue;
    Y.push({ box: X, score: A });
  }
  return Y;
}
import { existsSync as s, readFileSync as mq, statSync as gq } from "node:fs";
import R from "node:path";
import { pathToFileURL as xq } from "node:url";
var S;
class y extends Error {
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
function P(q, K = p) {
  let Q = R.join(K, "node_modules");
  if (!s(Q)) throw new y(q);
  let Z = R.join(Q, ...q.split("/"));
  try {
    let $ = Hq(Z);
    if ($ === null) throw Error(`no entry point in ${Z}`);
    return $;
  } catch ($) {
    throw new y(q, $);
  }
}
function Hq(q, K = 0) {
  let Q = R.join(q, "package.json"),
    Z = s(Q) ? JSON.parse(mq(Q, "utf8")) : {},
    $ = [
      ...d(pq(Z.exports)),
      ...(typeof Z.main === "string" ? [Z.main] : []),
      "index.js",
    ];
  for (let W of $) {
    let J = hq(R.resolve(q, W), K);
    if (J !== null) return J;
  }
  return null;
}
function hq(q, K) {
  let Q = Xq(q);
  if (Q?.isFile()) return q;
  if (Q?.isDirectory()) return K >= 4 ? null : Hq(q, K + 1);
  for (let Z of [".js", ".json", ".node"]) {
    let $ = `${q}${Z}`;
    if (Xq($)?.isFile()) return $;
  }
  return null;
}
function Xq(q) {
  try {
    return gq(q);
  } catch {
    return null;
  }
}
function pq(q) {
  if (typeof q === "string") return q;
  if (q === null || typeof q !== "object") return;
  let K = q;
  return "." in K ? K["."] : K;
}
function d(q, K = 0) {
  if (typeof q === "string") return [q];
  if (K > 8 || q === null || typeof q !== "object") return [];
  if (Array.isArray(q)) return q.flatMap(($) => d($, K + 1));
  let Q = q,
    Z = [];
  for (let $ of ["require", "node", "default"])
    if ($ in Q) Z.push(...d(Q[$], K + 1));
  return Z;
}
async function w() {
  if (S) return S;
  let q = P("onnxruntime-node");
  return ((S = await import(xq(q).href)), S);
}
var f;
async function n(q) {
  f ??= new Map();
  let K = f.get(q);
  if (K) return K;
  if (!s(q)) throw new y(q);
  let Q = w().then((Z) => Z.InferenceSession.create(q));
  f.set(q, Q);
  try {
    return await Q;
  } catch (Z) {
    throw (f.delete(q), Z);
  }
}
import { pathToFileURL as lq } from "node:url";
var b;
async function r() {
  if (b) return b;
  let q = P("sharp");
  return ((b = (await import(lq(q).href)).default), b);
}
async function a(q) {
  let Q = (await r())(Buffer.from(q)),
    { data: Z, info: $ } = await Q.removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(Z.buffer, Z.byteOffset, Z.byteLength),
    width: $.width,
    height: $.height,
  };
}
async function jq(q, K, Q) {
  let $ = (await r())(Buffer.from(q)),
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
function Lq(q, K) {
  let Q = Math.max(0, Math.min(q.width, Math.round(K.x))),
    Z = Math.max(0, Math.min(q.height, Math.round(K.y))),
    $ = Math.max(Q, Math.min(q.width, Math.round(K.x + K.width))),
    W = Math.max(Z, Math.min(q.height, Math.round(K.y + K.height))),
    J = $ - Q,
    V = W - Z,
    G = new Uint8Array(J * V * 3);
  for (let U = 0; U < V; U++) {
    let Y = ((Z + U) * q.width + Q) * 3,
      H = U * J * 3;
    G.set(q.data.subarray(Y, Y + J * 3), H);
  }
  return { data: G, width: J, height: V };
}
async function Fq(q, K, Q) {
  let $ = (await r())(Buffer.from(q.data), {
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
var cq = [0.485, 0.456, 0.406],
  dq = [0.229, 0.224, 0.225];
function Aq(q) {
  let { width: K, height: Q, data: Z } = q,
    $ = K * Q,
    W = new Float32Array($ * 3);
  for (let J = 0; J < $; J++)
    for (let V = 0; V < 3; V++) {
      let G = (Z[J * 3 + V] ?? 0) / 255;
      W[V * $ + J] = (G - cq[V]) / dq[V];
    }
  return W;
}
function Bq(q) {
  let { width: K, height: Q, data: Z } = q,
    $ = K * Q,
    W = new Float32Array($ * 3);
  for (let J = 0; J < $; J++)
    for (let V = 0; V < 3; V++) W[V * $ + J] = (Z[J * 3 + V] ?? 0) / 127.5 - 1;
  return W;
}
var u = "pp-ocrv5@1";
var o = M.join(l, "ocr"),
  rq = M.join(o, "det.onnx"),
  aq = M.join(o, "rec.onnx"),
  oq = M.join(o, "dict.txt"),
  iq = 960,
  tq = 32,
  m = 48,
  eq = 320;
function i(q = l) {
  let K = M.join(q, "ocr");
  return ["det.onnx", "rec.onnx", "dict.txt"].every((Q) => sq(M.join(K, Q)));
}
function q0(q) {
  return ["", ...q, " "];
}
function K0(q) {
  let K = q.split(/\r?\n/u);
  if (K.at(-1) === "") K.pop();
  return K;
}
var g;
async function Q0() {
  if (g) return g;
  let q = await nq(oq, "utf8");
  return ((g = q0(K0(q))), g);
}
async function Z0(q) {
  let K = await a(q),
    Q = Vq(K.width, K.height, iq, tq),
    Z = await jq(q, Q.width, Q.height),
    $ = Aq(Z),
    W = await w(),
    J = await n(rq),
    V = J.inputNames[0] ?? "x",
    G = await J.run({
      [V]: new W.Tensor("float32", $, [1, 3, Q.height, Q.width]),
    }),
    U = J.outputNames[0],
    Y = U ? G[U]?.data : void 0;
  if (!Y || !(Y instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: Uq(Y, Q.width, Q.height).map(({ box: j, score: X }) => ({
      box: Gq(c(j, Q, K)),
      score: X,
    })),
    native: K,
  };
}
async function $0(q) {
  let K = m / q.height,
    Q = Math.min(eq, Math.max(m, Math.round(q.width * K))),
    Z = await Fq(q, Q, m),
    $ = Bq(Z),
    W = await w(),
    J = await n(aq),
    V = J.inputNames[0] ?? "x",
    G = await J.run({ [V]: new W.Tensor("float32", $, [1, 3, m, Q]) }),
    U = J.outputNames[0],
    Y = U ? G[U] : void 0;
  if (!Y || !(Y.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let H = await Q0(),
    A = H.length,
    j = Y.data.length / A,
    X = [];
  for (let F = 0; F < j; F++) {
    let N = Array.from(Y.data.subarray(F * A, (F + 1) * A));
    X.push(N);
  }
  return Wq(X, H);
}
async function t(q) {
  try {
    let K = Buffer.from(q.bytes, "base64"),
      { boxes: Q, native: Z } = await Z0(K),
      $ = await a(K),
      W =
        q.originalWidth && q.originalHeight
          ? { width: q.originalWidth, height: q.originalHeight }
          : { width: Z.width, height: Z.height },
      V = (
        await Promise.all(
          Q.map(async (G) => {
            let [U, Y, H, A] = G.box,
              j = Lq($, { x: U, y: Y, width: H, height: A });
            if (j.width <= 0 || j.height <= 0) return;
            let X = await $0(j);
            if (!X.text) return;
            let F = Yq(
              c({ x: U, y: Y, width: H, height: A }, Z, W),
              W.width,
              W.height
            );
            if (F[2] <= 0 || F[3] <= 0) return;
            return { text: X.text, confidence: X.confidence, box: F };
          })
        )
      ).filter((G) => G !== void 0);
    return { id: q.id, regions: V };
  } catch (K) {
    return { id: q.id, error: K instanceof Error ? K.message : String(K) };
  }
}
async function kq(q, K) {
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
var Cq = 12;
async function Nq(q, K) {
  try {
    let Q = await q.vault.invoke({
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
      Z = Q?.output ?? Q;
    return { failures: Number(Z?.failures ?? 0), declined: Z?.declined === !0 };
  } catch {
    return { failures: 0, declined: !1 };
  }
}
function e(q) {
  return (q instanceof Error ? q.message : String(q)).slice(0, 500);
}
var qq = 16,
  D = "ocr-v1",
  Kq = "built-in",
  zq = t,
  _q = i,
  Oq = async () => {
    let q = P("pdfjs-dist/legacy/build/pdf.mjs");
    return import(J0(q).href);
  },
  Eq = Oq;
function c0(q) {
  ((zq = q?.recognize ?? t),
    (_q = q?.weightsPresent ?? i),
    (Eq = q?.loadPdfJs ?? Oq));
}
function Qq(q, K, Q) {
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
function Pq(q) {
  return [...q]
    .sort((K, Q) =>
      K.box && Q.box
        ? K.box[1] - Q.box[1] || K.box[0] - Q.box[0]
        : K.order - Q.order
    )
    .map((K) => K.text).join(`
`);
}
function Mq() {
  return _q() ? u : null;
}
function W0(q) {
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
async function Zq(q) {
  let K = await zq(q);
  if (!K || K.error) throw Error(K?.error ?? "OCR returned no result");
  return K;
}
async function V0(q) {
  globalThis.DOMMatrix ??= class {
    constructor(G = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = G;
    }
  };
  let K = await Eq(),
    Q = Buffer.from(q.bytes, "base64"),
    Z = await K.getDocument({ data: new Uint8Array(Q), disableWorker: !0 })
      .promise,
    $ = [],
    W,
    J = Math.min(Z.numPages, 64);
  for (let V = 1; V <= J; V += 1) {
    let Y = (await (await Z.getPage(V)).getTextContent()).items
      .flatMap((B) =>
        B && typeof B === "object" && "str" in B ? [String(B.str).trim()] : []
      )
      .filter(Boolean)
      .join(" ");
    if (Y) {
      $.push({ text: Y, page: V });
      continue;
    }
    let H = await import(P("@napi-rs/canvas"));
    ((globalThis.DOMMatrix = H.DOMMatrix),
      (globalThis.ImageData = H.ImageData),
      (globalThis.Path2D = H.Path2D));
    class A {
      create(B, _) {
        let z = H.createCanvas(B, _);
        return { canvas: z, context: z.getContext("2d") };
      }
      reset(B, _, z) {
        ((B.canvas.width = _), (B.canvas.height = z));
      }
      destroy(B) {
        ((B.canvas.width = 0), (B.canvas.height = 0));
      }
    }
    W ??= await K.getDocument({
      data: new Uint8Array(Q),
      disableWorker: !0,
      CanvasFactory: A,
    }).promise;
    let j = await W.getPage(V),
      X = j.getViewport({ scale: 2 }),
      F = H.createCanvas(Math.ceil(X.width), Math.ceil(X.height)),
      N = F.getContext("2d");
    await j.render({ canvas: F, canvasContext: N, viewport: X }).promise;
    let C = F.toBuffer("image/png").toString("base64"),
      L = await Zq({ id: `capture:${V}`, bytes: C, mediaType: "image/png" });
    for (let B of L.regions ?? []) $.push({ ...B, page: V });
  }
  return { id: "capture", regions: $ };
}
async function G0(q) {
  if (!Mq())
    throw Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  let K =
      q.mediaType === "application/pdf"
        ? await V0(q)
        : await Zq({ id: "capture", bytes: q.bytes, mediaType: q.mediaType }),
    Q = Qq(K),
    Z = Q.filter((J) => J.confidence !== void 0),
    $ = Z.length ? Z.reduce((J, V) => J + V.confidence, 0) / Z.length : void 0,
    W = Pq(Q);
  return {
    summary: W ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: W,
      engine: "automation",
      model: u,
      ...($ === void 0 ? {} : { confidence: $ }),
    },
  };
}
async function Y0(q, K, Q) {
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
async function U0(q, K) {
  let Q = await q.vault.content({
    contentId: K.content_id,
    variant: "preview",
    maxBytes: 4194304,
  });
  if (Q?.status !== "ok" || Q.kind !== "bytes") return null;
  let Z = await Zq({
    id: K.content_id,
    bytes: Q.base64,
    mediaType: Q.mediaType,
    originalWidth: K.width,
    originalHeight: K.height,
  });
  return Qq(Z, K.width, K.height);
}
async function X0({ ctx: q, log: K }) {
  let Q = W0(q.input);
  if (Q) return G0(Q);
  let Z = q.input?.variant === "delegate",
    $ = Z ? q.input?.delegateModel : Mq();
  if (!$) {
    if (Z) throw Error("delegate OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  let W = q.input?.promptRev;
  if (Z && W && W !== D)
    throw Error(
      `delegate OCR: the engine profile pins prompt revision "${W}", but this handler ships "${D}"`
    );
  let J = q.input?.profileId ?? Kq,
    V = J === Kq ? "" : `:${J}`,
    G = `${Z ? "delegate" : "deterministic"}:${$}:${Z ? D : "local"}${V}`,
    U = await q.state.get("selection");
  if (U !== G) {
    let L = U === void 0 && !Z ? await Y0(q, $, J) : "";
    (await q.state.set("cursor", L),
      await q.state.set("selection", G),
      await q.state.delete("confirmedModel"));
  }
  let Y = (await q.state.get("cursor")) ?? "",
    H = await q.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: Y },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: qq,
    }),
    A = (H.rows ?? []).filter((L) => L.kind === "photo" || L.kind === "scan"),
    j = 0,
    X = 0,
    F = 0,
    N = "",
    C = new Set();
  for (let L of A) {
    let _ = (
        await q.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: L.content_id },
            { column: "variant", op: "eq", value: "text" },
            { column: "profile", op: "eq", value: J },
          ],
          limit: 1,
        })
      ).rows?.[0],
      z = Z ? await q.state.get("confirmedModel") : $,
      vq =
        typeof _?.payload_json === "string"
          ? JSON.parse(_.payload_json).prompt_rev
          : _?.prompt_rev;
    if (_?.model === z && (!Z || vq === D)) {
      X += 1;
      continue;
    }
    let T = !1,
      I = !1,
      O,
      x = async (k) => {
        if (
          (
            await Nq(q, {
              capability: "ocr",
              targetType: "core.content_item",
              targetId: L.content_id,
              ...k,
            })
          ).declined
        )
          ((I = !0), (X += 1));
        else ((T = !0), (F += 1));
      };
    if (Z) {
      let k;
      try {
        if (
          ((k = await q.delegate({
            prompt:
              "Transcribe all visible text in reading order. Return regions with text and optional [x,y,w,h] boxes; never invent confidence.",
            json: {
              type: "object",
              required: ["regions"],
              properties: { regions: { type: "array" } },
            },
            content: [
              {
                contentId: L.content_id,
                variant: "preview",
                maxBytes: 4194304,
              },
            ],
          })),
          typeof k?.__centraidModel !== "string")
        )
          throw Error("delegate OCR returned no ACP-confirmed model identity");
      } catch (E) {
        await x({ error: e(E), reason: "delegate-failed" });
      }
      if (!T && !I)
        ((z = k.__centraidModel),
          await q.state.set("confirmedModel", z),
          (O = Qq(k, L.width, L.height)));
    } else {
      try {
        O = await U0(q, L);
      } catch (k) {
        (await x({ error: e(k), reason: "failed" }), (O = null));
      }
      if (O === null && !T && !I) {
        if (await kq(q, L.content_id)) {
          ((X += 1),
            K.info(`photo ${L.asset_id}: no preview this codec can produce`));
          continue;
        }
        (await x({
          reason: "no-preview",
          error: "no preview landed for this asset",
          maxFailures: Cq,
        }),
          K.info(`photo ${L.asset_id}: preview has not landed yet`));
      }
    }
    if (I) continue;
    if (T) {
      C.add(L.asset_id);
      continue;
    }
    let $q = Pq(O);
    if (!$q) {
      ((X += 1), K.info(`photo ${L.asset_id}: no legible text`));
      continue;
    }
    let h = O.filter((k) => k.confidence !== void 0),
      Jq = h.length
        ? h.reduce((k, E) => k + E.confidence, 0) / h.length
        : void 0,
      Dq = O.map(({ order: k, ...E }) => E);
    (await q.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: L.content_id,
        text: $q,
        capability: "ocr",
        model: z,
        regions: Dq,
        ...(J === Kq ? {} : { profile: J }),
        ...(Z ? { prompt_rev: D } : {}),
        ...(Jq === void 0 ? {} : { confidence: Jq }),
      },
    }),
      (j += 1));
  }
  for (let L of H.rows ?? []) {
    if (C.has(L.asset_id)) break;
    N = L.asset_id;
  }
  if (N) await q.state.set("cursor", N);
  return {
    summary: `OCR derived ${j}; skipped ${X}; not ready ${F}; batch ${H.rows?.length ?? 0}/${qq}`,
    output: {
      derived: j,
      skipped: X,
      notReady: F,
      model: Z ? ((await q.state.get("confirmedModel")) ?? $) : $,
      rearm: (H.rows?.length ?? 0) === qq,
    },
  };
}
export { c0 as setPhotoOcrRuntimeForTests, X0 as default };
