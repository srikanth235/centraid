import { existsSync as kt } from "node:fs";
import { readFile as Ut } from "node:fs/promises";
import D from "node:path";
import B from "node:path";
// governance: allow-repo-hygiene file-size-limit (#731) the self-contained OCR/PDF handler is one deployable runtime unit; splitting its bundled model/runtime rail would duplicate the content-resolution and bounded-batch invariants.
// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { pathToFileURL as Vt } from "node:url";
var Mt = B.resolve(import.meta.dirname, ".."),
  It = "__centraidAutomationRuntimeDir";
function gt() {
  let t = globalThis[It];
  if (typeof t === "string" && t.length > 0) return B.resolve(t);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return B.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return B.join(Mt, "runtime");
}
var U = gt(),
  L = B.join(U, "models");
function Dt(t) {
  if (t.length === 0) throw Error("argmax: row must be non-empty");
  let n = 0,
    r = t[0];
  for (let e = 1; e < t.length; e++) {
    let o = t[e];
    if (o > r) ((r = o), (n = e));
  }
  return { index: n, value: r };
}
function et(t, n, r = 0) {
  let e = [],
    o = [],
    a;
  for (let s of t) {
    let { index: u, value: c } = Dt(s);
    if (u !== a && u !== r) {
      let h = n[u];
      if (h !== void 0) (e.push(h), o.push(c));
    }
    a = u;
  }
  let i = o.length === 0 ? 0 : o.reduce((s, u) => s + u, 0) / o.length;
  return { text: e.join(""), confidence: i };
}
function ot(t, n, r, e) {
  let o = Math.max(t, n),
    a = o > r ? r / o : 1,
    i = (s) => Math.max(e, Math.round((s * a) / e) * e);
  return { width: i(t), height: i(n) };
}
function W(t, n, r) {
  let e = r.width / n.width,
    o = r.height / n.height;
  return { x: t.x * e, y: t.y * o, width: t.width * e, height: t.height * o };
}
function it(t) {
  return [
    Math.round(t.x),
    Math.round(t.y),
    Math.round(t.width),
    Math.round(t.height),
  ];
}
function at(t, n, r) {
  let e = Math.max(0, Math.min(n, Math.round(t.x))),
    o = Math.max(0, Math.min(r, Math.round(t.y))),
    a = Math.max(e, Math.min(n, Math.round(t.x + t.width))),
    i = Math.max(o, Math.min(r, Math.round(t.y + t.height)));
  return [e, o, a - e, i - o];
}
function At(t, n, r, e = 0.3) {
  let o = new Uint8Array(n * r);
  for (let a = 0; a < o.length; a++) o[a] = (t[a] ?? 0) >= e ? 1 : 0;
  return o;
}
function Tt(t, n, r, e = 1) {
  let o = new Uint8Array(n * r),
    a = [],
    i = [];
  for (let s = 0; s < t.length; s++) {
    if (!t[s] || o[s]) continue;
    (i.push(s), (o[s] = 1));
    let {
        POSITIVE_INFINITY: u,
        POSITIVE_INFINITY: c,
        NEGATIVE_INFINITY: h,
        NEGATIVE_INFINITY: m,
      } = Number,
      p = 0;
    while (i.length > 0) {
      let d = i.pop(),
        f = d % n,
        l = Math.floor(d / n);
      ((u = Math.min(u, f)),
        (c = Math.min(c, l)),
        (h = Math.max(h, f)),
        (m = Math.max(m, l)),
        p++);
      let b = [
        f > 0 ? d - 1 : -1,
        f < n - 1 ? d + 1 : -1,
        l > 0 ? d - n : -1,
        l < r - 1 ? d + n : -1,
      ];
      for (let x of b) if (x >= 0 && t[x] && !o[x]) ((o[x] = 1), i.push(x));
    }
    if (p >= e)
      a.push({
        box: { x: u, y: c, width: h - u + 1, height: m - c + 1 },
        area: p,
      });
  }
  return a;
}
function Bt(t, n, r = 1.5) {
  let e = 2 * (t.width + t.height);
  if (e <= 0) return t;
  let o = (n * r) / e;
  return {
    x: t.x - o,
    y: t.y - o,
    width: t.width + o * 2,
    height: t.height + o * 2,
  };
}
function _t(t, n, r) {
  let e = Math.max(0, Math.min(n, Math.round(t.x))),
    o = Math.max(0, Math.min(r, Math.round(t.y))),
    a = Math.max(0, Math.min(n, Math.round(t.x + t.width))),
    i = Math.max(0, Math.min(r, Math.round(t.y + t.height)));
  return { x: e, y: o, width: Math.max(0, a - e), height: Math.max(0, i - o) };
}
function Ot(t, n, r) {
  let e = Math.max(0, Math.floor(r.x)),
    o = Math.max(0, Math.floor(r.y)),
    a = Math.max(e, Math.ceil(r.x + r.width)),
    i = Math.max(o, Math.ceil(r.y + r.height)),
    s = 0,
    u = 0;
  for (let c = o; c < i; c++)
    for (let h = e; h < a; h++) ((s += t[c * n + h] ?? 0), u++);
  return u === 0 ? 0 : s / u;
}
function st(t, n, r, e = {}) {
  let {
      binaryThreshold: o = 0.3,
      boxScoreThreshold: a = 0.5,
      unclipRatio: i = 1.5,
      minArea: s = 4,
    } = e,
    u = At(t, n, r, o),
    c = Tt(u, n, r, s),
    h = [];
  for (let m of c) {
    let p = Ot(t, n, m.box);
    if (p < a) continue;
    let d = Bt(m.box, m.area, i),
      f = _t(d, n, r);
    if (f.width <= 0 || f.height <= 0) continue;
    h.push({ box: f, score: p });
  }
  return h;
}
import { existsSync as G, readFileSync as Nt, statSync as Rt } from "node:fs";
import R from "node:path";
import { pathToFileURL as Et } from "node:url";
var O;
class E extends Error {
  constructor(t, n) {
    super(
      `Automation model runtime dependency "${t}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: n }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function g(t, n = U) {
  let r = R.join(n, "node_modules");
  if (!G(r)) throw new E(t);
  let e = R.join(r, ...t.split("/"));
  try {
    let o = ht(e);
    if (o === null) throw Error(`no entry point in ${e}`);
    return o;
  } catch (o) {
    throw new E(t, o);
  }
}
function ht(t, n = 0) {
  let r = R.join(t, "package.json"),
    e = G(r) ? JSON.parse(Nt(r, "utf8")) : {},
    o = [
      ...v(St(e.exports)),
      ...(typeof e.main === "string" ? [e.main] : []),
      "index.js",
    ];
  for (let a of o) {
    let i = Ct(R.resolve(t, a), n);
    if (i !== null) return i;
  }
  return null;
}
function Ct(t, n) {
  let r = ut(t);
  if (r?.isFile()) return t;
  if (r?.isDirectory()) return n >= 4 ? null : ht(t, n + 1);
  for (let e of [".js", ".json", ".node"]) {
    let o = `${t}${e}`;
    if (ut(o)?.isFile()) return o;
  }
  return null;
}
function ut(t) {
  try {
    return Rt(t);
  } catch {
    return null;
  }
}
function St(t) {
  if (typeof t === "string") return t;
  if (t === null || typeof t !== "object") return;
  let n = t;
  return "." in n ? n["."] : n;
}
function v(t, n = 0) {
  if (typeof t === "string") return [t];
  if (n > 8 || t === null || typeof t !== "object") return [];
  if (Array.isArray(t)) return t.flatMap((o) => v(o, n + 1));
  let r = t,
    e = [];
  for (let o of ["require", "node", "default"])
    if (o in r) e.push(...v(r[o], n + 1));
  return e;
}
async function C() {
  if (O) return O;
  let t = g("onnxruntime-node");
  return ((O = await import(Et(t).href)), O);
}
var N;
async function Y(t) {
  N ??= new Map();
  let n = N.get(t);
  if (n) return n;
  if (!G(t)) throw new E(t);
  let r = C().then((e) => e.InferenceSession.create(t));
  N.set(t, r);
  try {
    return await r;
  } catch (e) {
    throw (N.delete(t), e);
  }
}
import { pathToFileURL as jt } from "node:url";
var S;
async function H() {
  if (S) return S;
  let t = g("sharp");
  return ((S = (await import(jt(t).href)).default), S);
}
async function X(t) {
  let r = (await H())(Buffer.from(t)),
    { data: e, info: o } = await r
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(e.buffer, e.byteOffset, e.byteLength),
    width: o.width,
    height: o.height,
  };
}
async function ct(t, n, r) {
  let o = (await H())(Buffer.from(t)),
    { data: a, info: i } = await o
      .resize({ width: n, height: r, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    width: i.width,
    height: i.height,
  };
}
function mt(t, n) {
  let r = Math.max(0, Math.min(t.width, Math.round(n.x))),
    e = Math.max(0, Math.min(t.height, Math.round(n.y))),
    o = Math.max(r, Math.min(t.width, Math.round(n.x + n.width))),
    a = Math.max(e, Math.min(t.height, Math.round(n.y + n.height))),
    i = o - r,
    s = a - e,
    u = new Uint8Array(i * s * 3);
  for (let c = 0; c < s; c++) {
    let h = ((e + c) * t.width + r) * 3,
      m = c * i * 3;
    u.set(t.data.subarray(h, h + i * 3), m);
  }
  return { data: u, width: i, height: s };
}
async function ft(t, n, r) {
  let o = (await H())(Buffer.from(t.data), {
      raw: { width: t.width, height: t.height, channels: 3 },
    }),
    { data: a, info: i } = await o
      .resize({ width: n, height: r, fit: "fill" })
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
    width: i.width,
    height: i.height,
  };
}
var Ft = [0.485, 0.456, 0.406],
  zt = [0.229, 0.224, 0.225];
function $(t) {
  let { width: n, height: r, data: e } = t,
    o = n * r,
    a = new Float32Array(o * 3);
  for (let i = 0; i < o; i++)
    for (let s = 0; s < 3; s++) {
      let u = (e[i * 3 + s] ?? 0) / 255;
      a[s * o + i] = (u - Ft[s]) / zt[s];
    }
  return a;
}
var q = "pp-ocrv4@1",
  K = D.join(L, "ocr"),
  Lt = D.join(K, "det.onnx"),
  Wt = D.join(K, "rec.onnx"),
  vt = D.join(K, "dict.txt"),
  Gt = 960,
  Yt = 32,
  j = 48,
  Ht = 320;
function Q(t = L) {
  let n = D.join(t, "ocr");
  return ["det.onnx", "rec.onnx", "dict.txt"].every((r) => kt(D.join(n, r)));
}
function Xt(t) {
  return ["", ...t, " "];
}
function $t(t) {
  let n = t.split(/\r?\n/u);
  if (n.at(-1) === "") n.pop();
  return n;
}
var F;
async function qt() {
  if (F) return F;
  let t = await Ut(vt, "utf8");
  return ((F = Xt($t(t))), F);
}
async function Kt(t) {
  let n = await X(t),
    r = ot(n.width, n.height, Gt, Yt),
    e = await ct(t, r.width, r.height),
    o = $(e),
    a = await C(),
    i = await Y(Lt),
    s = i.inputNames[0] ?? "x",
    u = await i.run({
      [s]: new a.Tensor("float32", o, [1, 3, r.height, r.width]),
    }),
    c = i.outputNames[0],
    h = c ? u[c]?.data : void 0;
  if (!h || !(h instanceof Float32Array))
    throw Error("ocr: detector did not return a float32 probability map");
  return {
    boxes: st(h, r.width, r.height).map(({ box: d, score: f }) => ({
      box: it(W(d, r, n)),
      score: f,
    })),
    native: n,
  };
}
async function Qt(t) {
  let n = j / t.height,
    r = Math.min(Ht, Math.max(j, Math.round(t.width * n))),
    e = await ft(t, r, j),
    o = $(e),
    a = await C(),
    i = await Y(Wt),
    s = i.inputNames[0] ?? "x",
    u = await i.run({ [s]: new a.Tensor("float32", o, [1, 3, j, r]) }),
    c = i.outputNames[0],
    h = c ? u[c] : void 0;
  if (!h || !(h.data instanceof Float32Array))
    throw Error("ocr: recognizer did not return a float32 tensor");
  let m = await qt(),
    p = m.length,
    d = h.data.length / p,
    f = [];
  for (let l = 0; l < d; l++) {
    let b = Array.from(h.data.subarray(l * p, (l + 1) * p));
    f.push(b);
  }
  return et(f, m);
}
async function V(t) {
  try {
    let n = Buffer.from(t.bytes, "base64"),
      { boxes: r, native: e } = await Kt(n),
      o = await X(n),
      a =
        t.originalWidth && t.originalHeight
          ? { width: t.originalWidth, height: t.originalHeight }
          : { width: e.width, height: e.height },
      s = (
        await Promise.all(
          r.map(async (u) => {
            let [c, h, m, p] = u.box,
              d = mt(o, { x: c, y: h, width: m, height: p });
            if (d.width <= 0 || d.height <= 0) return;
            let f = await Qt(d);
            if (!f.text) return;
            let l = at(
              W({ x: c, y: h, width: m, height: p }, e, a),
              a.width,
              a.height
            );
            if (l[2] <= 0 || l[3] <= 0) return;
            return { text: f.text, confidence: f.confidence, box: l };
          })
        )
      ).filter((u) => u !== void 0);
    return { id: t.id, regions: s };
  } catch (n) {
    return { id: t.id, error: n instanceof Error ? n.message : String(n) };
  }
}
var Z = 16,
  A = "dpv:ServiceProvision",
  _ = "ocr-v1",
  J = "built-in",
  dt = V,
  lt = Q,
  pt = async () => {
    let t = g("pdfjs-dist/legacy/build/pdf.mjs");
    return import(Vt(t).href);
  },
  yt = pt;
function Rn(t) {
  ((dt = t?.recognize ?? V),
    (lt = t?.weightsPresent ?? Q),
    (yt = t?.loadPdfJs ?? pt));
}
function P(t, n, r) {
  if (!t) return [];
  if (!Array.isArray(t.regions))
    return typeof t.text === "string" && t.text.trim()
      ? [{ text: t.text, order: 0 }]
      : [];
  return t.regions.flatMap((e, o) => {
    if (!e || typeof e.text !== "string") return [];
    let a = e.confidence;
    if (a !== void 0 && (typeof a !== "number" || a < 0 || a > 1)) return [];
    let i = Array.isArray(e.box) && e.box.length === 4 ? e.box : null,
      s =
        i &&
        i.every(
          (u) => typeof u === "number" && Number.isSafeInteger(u) && u >= 0
        ) &&
        i[2] > 0 &&
        i[3] > 0 &&
        (!n || i[0] + i[2] <= n) &&
        (!r || i[1] + i[3] <= r);
    return [
      {
        text: e.text,
        order: o,
        ...(s ? { box: i } : {}),
        ...(a === void 0 ? {} : { confidence: a }),
      },
    ];
  });
}
function bt(t) {
  return [...t]
    .sort((n, r) =>
      n.box && r.box
        ? n.box[1] - r.box[1] || n.box[0] - r.box[0]
        : n.order - r.order
    )
    .map((n) => n.text).join(`
`);
}
function wt() {
  return lt() ? q : null;
}
function Zt(t) {
  let n = t?.capture;
  if (!n || typeof n !== "object") return null;
  if (typeof n.bytes !== "string" || !n.bytes)
    throw Error("capture OCR needs base64 content bytes");
  if (
    typeof n.mediaType !== "string" ||
    (!n.mediaType.startsWith("image/") && n.mediaType !== "application/pdf")
  )
    throw Error("capture OCR needs an image or PDF media type");
  return n;
}
async function tt(t) {
  let n = await dt(t);
  if (!n || n.error) throw Error(n?.error ?? "OCR returned no result");
  return n;
}
async function Jt(t) {
  globalThis.DOMMatrix ??= class {
    constructor(u = [1, 0, 0, 1, 0, 0]) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = u;
    }
  };
  let n = await yt(),
    r = Buffer.from(t.bytes, "base64"),
    e = await n.getDocument({ data: new Uint8Array(r), disableWorker: !0 })
      .promise,
    o = [],
    a,
    i = Math.min(e.numPages, 64);
  for (let s = 1; s <= i; s += 1) {
    let h = (await (await e.getPage(s)).getTextContent()).items
      .flatMap((y) =>
        y && typeof y === "object" && "str" in y ? [String(y.str).trim()] : []
      )
      .filter(Boolean)
      .join(" ");
    if (h) {
      o.push({ text: h, page: s });
      continue;
    }
    let m = await import(g("@napi-rs/canvas"));
    ((globalThis.DOMMatrix = m.DOMMatrix),
      (globalThis.ImageData = m.ImageData),
      (globalThis.Path2D = m.Path2D));
    class p {
      create(y, T) {
        let w = m.createCanvas(y, T);
        return { canvas: w, context: w.getContext("2d") };
      }
      reset(y, T, w) {
        ((y.canvas.width = T), (y.canvas.height = w));
      }
      destroy(y) {
        ((y.canvas.width = 0), (y.canvas.height = 0));
      }
    }
    a ??= await n.getDocument({
      data: new Uint8Array(r),
      disableWorker: !0,
      CanvasFactory: p,
    }).promise;
    let d = await a.getPage(s),
      f = d.getViewport({ scale: 2 }),
      l = m.createCanvas(Math.ceil(f.width), Math.ceil(f.height)),
      b = l.getContext("2d");
    await d.render({ canvas: l, canvasContext: b, viewport: f }).promise;
    let x = l.toBuffer("image/png").toString("base64"),
      I = await tt({ id: `capture:${s}`, bytes: x, mediaType: "image/png" });
    for (let y of I.regions ?? []) o.push({ ...y, page: s });
  }
  return { id: "capture", regions: o };
}
async function Pt(t) {
  if (!wt())
    throw Error(
      "capture OCR unavailable: install the bundled automation model assets"
    );
  let n =
      t.mediaType === "application/pdf"
        ? await Jt(t)
        : await tt({ id: "capture", bytes: t.bytes, mediaType: t.mediaType }),
    r = P(n),
    e = r.filter((i) => i.confidence !== void 0),
    o = e.length ? e.reduce((i, s) => i + s.confidence, 0) / e.length : void 0,
    a = bt(r);
  return {
    summary: a ? "Capture OCR completed" : "Capture OCR found no legible text",
    output: {
      text: a,
      engine: "automation",
      model: q,
      ...(o === void 0 ? {} : { confidence: o }),
    },
  };
}
async function tn(t, n, r) {
  let o = (
    await t.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: A,
    })
  ).rows?.[0];
  if (!o) return "";
  return (
    await t.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: o.content_id },
        { column: "variant", op: "eq", value: "text" },
        { column: "profile", op: "eq", value: r },
      ],
      limit: 1,
      purpose: A,
    })
  ).rows?.[0]?.model === n
    ? o.asset_id
    : "";
}
async function nn(t, n) {
  let r = await t.vault.content({
    contentId: n.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: A,
  });
  if (r?.status !== "ok" || r.kind !== "bytes")
    throw Error(`asset ${n.asset_id}: preview is unavailable`);
  let e = await tt({
    id: n.content_id,
    bytes: r.base64,
    mediaType: r.mediaType,
    originalWidth: n.width,
    originalHeight: n.height,
  });
  return P(e, n.width, n.height);
}
async function rn({ ctx: t, log: n }) {
  let r = Zt(t.input);
  if (r) return Pt(r);
  let e = t.input?.variant === "delegate",
    o = e ? t.input?.delegateModel : wt();
  if (!o) {
    if (e) throw Error("delegate OCR requires an explicit pinned model");
    return { summary: "OCR skipped — automation model assets unavailable" };
  }
  let a = t.input?.promptRev;
  if (e && a && a !== _)
    throw Error(
      `delegate OCR: the engine profile pins prompt revision "${a}", but this handler ships "${_}"`
    );
  let i = t.input?.profileId ?? J,
    s = i === J ? "" : `:${i}`,
    u = `${e ? "delegate" : "deterministic"}:${o}:${e ? _ : "local"}${s}`,
    c = await t.state.get("selection");
  if (c !== u) {
    let b = c === void 0 && !e ? await tn(t, o, i) : "";
    (await t.state.set("cursor", b),
      await t.state.set("selection", u),
      await t.state.delete("confirmedModel"));
  }
  let h = (await t.state.get("cursor")) ?? "",
    m = await t.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: h },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: Z,
      purpose: A,
    }),
    p = (m.rows ?? []).filter((b) => b.kind === "photo" || b.kind === "scan"),
    d = 0,
    f = 0;
  for (let b of p) {
    let I = (
        await t.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: b.content_id },
            { column: "variant", op: "eq", value: "text" },
            { column: "profile", op: "eq", value: i },
          ],
          limit: 1,
          purpose: A,
        })
      ).rows?.[0],
      y = e ? await t.state.get("confirmedModel") : o,
      T =
        typeof I?.payload_json === "string"
          ? JSON.parse(I.payload_json).prompt_rev
          : I?.prompt_rev;
    if (I?.model === y && (!e || T === _)) {
      f += 1;
      continue;
    }
    let w;
    if (e) {
      let M = await t.delegate({
        prompt:
          "Transcribe all visible text in reading order. Return regions with text and optional [x,y,w,h] boxes; never invent confidence.",
        json: {
          type: "object",
          required: ["regions"],
          properties: { regions: { type: "array" } },
        },
        content: [
          { contentId: b.content_id, variant: "preview", maxBytes: 4194304 },
        ],
      });
      if (typeof M?.__centraidModel !== "string")
        throw Error("delegate OCR returned no ACP-confirmed model identity");
      ((y = M.__centraidModel),
        await t.state.set("confirmedModel", y),
        (w = P(M, b.width, b.height)));
    } else w = await nn(t, b);
    let nt = bt(w);
    if (!nt) {
      ((f += 1), n.info(`photo ${b.asset_id}: no legible text`));
      continue;
    }
    let z = w.filter((M) => M.confidence !== void 0),
      rt = z.length
        ? z.reduce((M, k) => M + k.confidence, 0) / z.length
        : void 0,
      xt = w.map(({ order: M, ...k }) => k);
    (await t.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: b.content_id,
        text: nt,
        capability: "ocr",
        model: y,
        regions: xt,
        ...(i === J ? {} : { profile: i }),
        ...(e ? { prompt_rev: _ } : {}),
        ...(rt === void 0 ? {} : { confidence: rt }),
      },
      purpose: A,
    }),
      (d += 1));
  }
  let l = m.rows?.at(-1)?.asset_id;
  if (l) await t.state.set("cursor", l);
  return {
    summary: `OCR derived ${d}; skipped ${f}; batch ${m.rows?.length ?? 0}/${Z}`,
    output: {
      derived: d,
      skipped: f,
      model: e ? ((await t.state.get("confirmedModel")) ?? o) : o,
      rearm: (m.rows?.length ?? 0) === Z,
    },
  };
}
export { Rn as setPhotoOcrRuntimeForTests, rn as default };
