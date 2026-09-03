// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as De } from "node:fs";
import S from "node:path";
import v from "node:path";
var fe = v.resolve(import.meta.dirname, ".."),
  ye = "__centraidAutomationRuntimeDir";
function we() {
  let e = globalThis[ye];
  if (typeof e === "string" && e.length > 0) return v.resolve(e);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return v.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return v.join(fe, "runtime");
}
var C = we(),
  j = v.join(C, "models");
function W(e, t) {
  let {
      stride: n,
      gridWidth: o,
      gridHeight: r,
      classScores: i,
      objectness: s,
      boxes: d,
      landmarks: l,
    } = e,
    c = [];
  for (let u = 0; u < r; u++)
    for (let a = 0; a < o; a++) {
      let h = u * o + a,
        m = Math.max(0, Math.min(1, i[h] ?? 0)),
        p = Math.max(0, Math.min(1, s[h] ?? 0)),
        w = Math.sqrt(m * p);
      if (w < t) continue;
      let y = d[h * 4] ?? 0,
        x = d[h * 4 + 1] ?? 0,
        f = d[h * 4 + 2] ?? 0,
        b = d[h * 4 + 3] ?? 0,
        g = Math.exp(f) * n,
        _ = Math.exp(b) * n,
        A = (a + y) * n,
        he = (u + x) * n,
        N;
      if (l) {
        N = [];
        for (let D = 0; D < 5; D++) {
          let me = l[h * 10 + D * 2] ?? 0,
            pe = l[h * 10 + D * 2 + 1] ?? 0;
          N.push({ x: (a + me) * n, y: (u + pe) * n });
        }
      }
      c.push({
        box: { x: A - g / 2, y: he - _ / 2, width: g, height: _ },
        score: w,
        landmarks: N,
      });
    }
  return c;
}
var X = [
  { x: 38.2946, y: 51.6963 },
  { x: 73.5318, y: 51.5014 },
  { x: 56.0252, y: 71.7366 },
  { x: 41.5493, y: 92.3655 },
  { x: 70.7299, y: 92.2041 },
];
function K(e, t) {
  if (e.length !== t.length || e.length === 0)
    throw Error(
      "computeSimilarityTransform: src and dst must be the same non-zero length"
    );
  let n = e.length,
    o = { x: 0, y: 0 },
    r = { x: 0, y: 0 };
  for (let f = 0; f < n; f++)
    ((o.x += e[f].x / n),
      (o.y += e[f].y / n),
      (r.x += t[f].x / n),
      (r.y += t[f].y / n));
  let i = 0,
    s = 0,
    d = 0,
    l = 0,
    c = 0;
  for (let f = 0; f < n; f++) {
    let b = e[f].x - o.x,
      g = e[f].y - o.y,
      _ = t[f].x - r.x,
      A = t[f].y - r.y;
    ((i += b * _),
      (s += b * A),
      (d += g * _),
      (l += g * A),
      (c += b * b + g * g));
  }
  let u = s - d,
    a = i + l,
    h = Math.atan2(u, a),
    m = Math.hypot(a, u) / (c === 0 ? 1 : c),
    p = m * Math.cos(h),
    w = m * Math.sin(h),
    y = r.x - (p * o.x - w * o.y),
    x = r.y - (w * o.x + p * o.y);
  return { a: p, b: w, tx: y, ty: x };
}
function xe(e, t) {
  return { x: e.a * t.x - e.b * t.y + e.tx, y: e.b * t.x + e.a * t.y + e.ty };
}
function G(e, t, n, o) {
  let r = t.a ** 2 + t.b ** 2,
    i =
      r === 0
        ? { a: 1, b: 0, tx: 0, ty: 0 }
        : {
            a: t.a / r,
            b: -t.b / r,
            tx: (-t.a * t.tx - t.b * t.ty) / r,
            ty: (t.b * t.tx - t.a * t.ty) / r,
          },
    s = new Uint8Array(n * o * 3);
  for (let d = 0; d < o; d++)
    for (let l = 0; l < n; l++) {
      let c = xe(i, { x: l, y: d }),
        u = be(e, c.x, c.y),
        a = (d * n + l) * 3;
      ((s[a] = u[0]), (s[a + 1] = u[1]), (s[a + 2] = u[2]));
    }
  return { data: s, width: n, height: o };
}
function be(e, t, n) {
  if (t < 0 || n < 0 || t > e.width - 1 || n > e.height - 1) return [0, 0, 0];
  let o = Math.floor(t),
    r = Math.floor(n),
    i = Math.min(e.width - 1, o + 1),
    s = Math.min(e.height - 1, r + 1),
    d = t - o,
    l = n - r,
    c = (a, h, m) => e.data[(h * e.width + a) * 3 + m] ?? 0,
    u = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    let h = c(o, r, a) * (1 - d) + c(i, r, a) * d,
      m = c(o, s, a) * (1 - d) + c(i, s, a) * d;
    u[a] = Math.round(h * (1 - l) + m * l);
  }
  return u;
}
function Z(e, t, n) {
  let o = n.width / t.width,
    r = n.height / t.height;
  return { x: e.x * o, y: e.y * r, width: e.width * o, height: e.height * r };
}
function J(e, t, n) {
  let o = Math.max(0, Math.min(t, Math.round(e.x))),
    r = Math.max(0, Math.min(n, Math.round(e.y))),
    i = Math.max(o, Math.min(t, Math.round(e.x + e.width))),
    s = Math.max(r, Math.min(n, Math.round(e.y + e.height)));
  return [o, r, i - o, s - r];
}
function V(e) {
  return Math.max(0, e.width) * Math.max(0, e.height);
}
function ge(e, t) {
  let n = e.x + e.width,
    o = e.y + e.height,
    r = t.x + t.width,
    i = t.y + t.height,
    s = Math.max(e.x, t.x),
    d = Math.max(e.y, t.y),
    l = Math.min(n, r),
    c = Math.min(o, i),
    u = Math.max(0, l - s),
    a = Math.max(0, c - d),
    h = u * a;
  if (h <= 0) return 0;
  let m = V(e) + V(t) - h;
  return m <= 0 ? 0 : h / m;
}
function Q(e, t) {
  let n = [...e].sort((r, i) => i.score - r.score),
    o = [];
  for (let r of n)
    if (!o.some((s) => ge(s.box, r.box) > t.iouThreshold)) {
      if ((o.push(r), t.topK !== void 0 && o.length >= t.topK)) break;
    }
  return o;
}
import { existsSync as U, readFileSync as Me, statSync as _e } from "node:fs";
import R from "node:path";
import { pathToFileURL as ve } from "node:url";
var T;
class E extends Error {
  constructor(e, t) {
    super(
      `Automation model runtime dependency "${e}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: t }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function q(e, t = C) {
  let n = R.join(t, "node_modules");
  if (!U(n)) throw new E(e);
  let o = R.join(n, ...e.split("/"));
  try {
    let r = te(o);
    if (r === null) throw Error(`no entry point in ${o}`);
    return r;
  } catch (r) {
    throw new E(e, r);
  }
}
function te(e, t = 0) {
  let n = R.join(e, "package.json"),
    o = U(n) ? JSON.parse(Me(n, "utf8")) : {},
    r = [
      ...L(Se(o.exports)),
      ...(typeof o.main === "string" ? [o.main] : []),
      "index.js",
    ];
  for (let i of r) {
    let s = Ie(R.resolve(e, i), t);
    if (s !== null) return s;
  }
  return null;
}
function Ie(e, t) {
  let n = ee(e);
  if (n?.isFile()) return e;
  if (n?.isDirectory()) return t >= 4 ? null : te(e, t + 1);
  for (let o of [".js", ".json", ".node"]) {
    let r = `${e}${o}`;
    if (ee(r)?.isFile()) return r;
  }
  return null;
}
function ee(e) {
  try {
    return _e(e);
  } catch {
    return null;
  }
}
function Se(e) {
  if (typeof e === "string") return e;
  if (e === null || typeof e !== "object") return;
  let t = e;
  return "." in t ? t["."] : t;
}
function L(e, t = 0) {
  if (typeof e === "string") return [e];
  if (t > 8 || e === null || typeof e !== "object") return [];
  if (Array.isArray(e)) return e.flatMap((r) => L(r, t + 1));
  let n = e,
    o = [];
  for (let r of ["require", "node", "default"])
    if (r in n) o.push(...L(n[r], t + 1));
  return o;
}
async function O() {
  if (T) return T;
  let e = q("onnxruntime-node");
  return ((T = await import(ve(e).href)), T);
}
var k;
async function z(e) {
  k ??= new Map();
  let t = k.get(e);
  if (t) return t;
  if (!U(e)) throw new E(e);
  let n = O().then((o) => o.InferenceSession.create(e));
  k.set(e, n);
  try {
    return await n;
  } catch (o) {
    throw (k.delete(e), o);
  }
}
import { pathToFileURL as Ae } from "node:url";
var F;
async function ne() {
  if (F) return F;
  let e = q("sharp");
  return ((F = (await import(Ae(e).href)).default), F);
}
async function re(e) {
  let n = (await ne())(Buffer.from(e)),
    { data: o, info: r } = await n
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(o.buffer, o.byteOffset, o.byteLength),
    width: r.width,
    height: r.height,
  };
}
async function oe(e, t, n) {
  let r = (await ne())(Buffer.from(e)),
    { data: i, info: s } = await r
      .resize({ width: t, height: n, fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(i.buffer, i.byteOffset, i.byteLength),
    width: s.width,
    height: s.height,
  };
}
function se(e) {
  let { width: t, height: n, data: o } = e,
    r = t * n,
    i = new Float32Array(r * 3);
  for (let s = 0; s < r; s++)
    ((i[s] = o[s * 3 + 2] ?? 0),
      (i[r + s] = o[s * 3 + 1] ?? 0),
      (i[r * 2 + s] = o[s * 3] ?? 0));
  return i;
}
function ie(e) {
  let { width: t, height: n, data: o } = e,
    r = t * n,
    i = new Float32Array(r * 3);
  for (let s = 0; s < r; s++)
    ((i[s] = o[s * 3] ?? 0),
      (i[r + s] = o[s * 3 + 1] ?? 0),
      (i[r * 2 + s] = o[s * 3 + 2] ?? 0));
  return i;
}
var ae = "yunet-sface@1",
  ce = S.join(j, "faces"),
  Te = S.join(ce, "yunet.onnx"),
  ke = S.join(ce, "sface.onnx"),
  I = 640,
  Re = [8, 16, 32],
  Ee = 0.6,
  Oe = 0.3,
  P = 112;
function $(e = j) {
  let t = S.join(e, "faces");
  return ["yunet.onnx", "sface.onnx"].every((n) => De(S.join(t, n)));
}
async function Fe(e, t) {
  let n = await O(),
    o = await z(Te),
    r = o.inputNames[0] ?? "input",
    i = await o.run({ [r]: new n.Tensor("float32", e, [1, 3, t, t]) }),
    s = [];
  for (let c of Re) {
    let u = t / c,
      a = i[`cls_${c}`]?.data,
      h = i[`obj_${c}`]?.data,
      m = i[`bbox_${c}`]?.data,
      p = i[`kps_${c}`]?.data;
    if (!a || !h || !m || !p)
      throw Error(`faces: YuNet output set is incomplete at stride ${c}`);
    s.push(
      ...W(
        {
          stride: c,
          gridWidth: u,
          gridHeight: u,
          classScores: a,
          objectness: h,
          boxes: m,
          landmarks: p,
        },
        Ee
      )
    );
  }
  let d = Q(
      s.map((c) => ({ box: c.box, score: c.score })),
      { iouThreshold: Oe, topK: 20 }
    ),
    l = new Set(d.map((c) => c.box));
  return s.filter((c) => l.has(c.box));
}
async function Pe(e) {
  let t = await O(),
    n = await z(ke),
    o = n.inputNames[0] ?? "data",
    r = await n.run({ [o]: new t.Tensor("float32", e, [1, 3, P, P]) }),
    i = n.outputNames[0],
    s = i ? r[i]?.data : void 0;
  if (!s || !(s instanceof Float32Array))
    throw Error("faces: SFace did not return a float32 embedding");
  return Array.from(s);
}
async function Y(e) {
  try {
    let t = Buffer.from(e.bytes, "base64"),
      n = await re(t),
      o = await oe(t, I, I),
      r = se(o),
      i = await Fe(r, I),
      s = n.width / I,
      d = n.height / I,
      l =
        e.originalWidth && e.originalHeight
          ? { width: e.originalWidth, height: e.originalHeight }
          : { width: n.width, height: n.height },
      u = (
        await Promise.all(
          i
            .filter((a) => a.landmarks)
            .map(async (a) => {
              let m = a.landmarks.map((g) => ({ x: g.x * s, y: g.y * d })),
                p = K(m, X),
                w = G(n, p, P, P),
                y = ie(w),
                x = await Pe(y),
                f = {
                  x: a.box.x * s,
                  y: a.box.y * d,
                  width: a.box.width * s,
                  height: a.box.height * d,
                },
                b = J(Z(f, n, l), l.width, l.height);
              if (b[2] <= 0 || b[3] <= 0) return;
              return { box: b, confidence: a.score, embedding: x };
            })
        )
      ).filter((a) => a !== void 0);
    return { id: e.id, faces: u };
  } catch (t) {
    return { id: e.id, error: t instanceof Error ? t.message : String(t) };
  }
}
var B = 16,
  M = "dpv:ServiceProvision",
  de = Y,
  le = $;
function at(e) {
  ((de = e?.infer ?? Y), (le = e?.weightsPresent ?? $));
}
function Be() {
  return le() ? ae : null;
}
async function ue(e, t) {
  return (
    await e.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "eq", value: t },
        { column: "deleted_at", op: "is-null" },
      ],
      limit: 1,
      purpose: M,
    })
  ).rows?.[0];
}
async function H(e, t, n) {
  if (
    (
      await e.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "eq", value: t.asset_id },
          { column: "variant", op: "eq", value: "faces" },
        ],
        limit: 1,
        purpose: M,
      })
    ).rows?.[0]?.model === n
  )
    return { settled: !0, derived: 0, skipped: 1 };
  let r = await e.vault.content({
    contentId: t.content_id,
    variant: "preview",
    maxBytes: 4194304,
    purpose: M,
  });
  if (r?.status !== "ok" || r.kind !== "bytes")
    throw Error(`asset ${t.asset_id}: preview is unavailable`);
  let i = await de({
    id: t.asset_id,
    bytes: r.base64,
    mediaType: r.mediaType,
    originalWidth: t.width,
    originalHeight: t.height,
  });
  if (!i || i.error || !Array.isArray(i.faces))
    throw Error(
      i?.error ?? `asset ${t.asset_id}: face detector returned no result`
    );
  return (
    await e.vault.invoke({
      command: "enrich.upsert_faces",
      input: { asset_id: t.asset_id, model: n, faces: i.faces },
      purpose: M,
    }),
    { settled: !0, derived: 1, skipped: 0 }
  );
}
async function Ne(e, t) {
  let n = await e.vault.read({
    entity: "enrich.derivation",
    where: [{ column: "variant", op: "eq", value: "faces" }],
    orderBy: { column: "target_id", dir: "desc" },
    limit: 1,
    purpose: M,
  });
  return n.rows?.[0]?.model === t ? n.rows[0].target_id : "";
}
async function Ce({ ctx: e }) {
  let t = Be();
  if (!t)
    return { summary: "faces skipped — automation model assets unavailable" };
  let n = await e.state.get("model");
  if (n !== t)
    (await e.state.set("consentCursor", n === void 0 ? await Ne(e, t) : ""),
      await e.state.set("model", t));
  let o = await e.vault.read({
      entity: "enrich.request",
      where: [
        { column: "capability", op: "eq", value: "faces" },
        { column: "drained_at", op: "is-null" },
      ],
      orderBy: { column: "request_id", dir: "asc" },
      limit: B,
      purpose: M,
    }),
    r = 0,
    i = 0,
    s = B,
    d = (o.rows?.length ?? 0) === B,
    l = [],
    c = new Set();
  for (let u of o.rows ?? []) {
    if (s === 0) {
      d = !0;
      break;
    }
    if (u.target_id) {
      let y = await ue(e, u.target_id);
      if (!y) {
        ((i += 1), l.push(u.request_id), (s -= 1));
        continue;
      }
      let x = await H(e, y, t);
      if (
        (c.add(y.asset_id),
        (r += x.derived),
        (i += x.skipped),
        (s -= 1),
        x.settled)
      )
        l.push(u.request_id);
      continue;
    }
    let a = `requestCursor:${u.request_id}`,
      h = (await e.state.get(a)) ?? "",
      m = s,
      p = await e.vault.read({
        entity: "media.asset",
        where: [
          { column: "asset_id", op: "gt", value: h },
          { column: "kind", op: "in", value: ["photo", "scan"] },
          { column: "deleted_at", op: "is-null" },
        ],
        orderBy: { column: "asset_id", dir: "asc" },
        limit: m,
        purpose: M,
      });
    for (let y of p.rows ?? []) {
      let x = await H(e, y, t);
      (c.add(y.asset_id), (r += x.derived), (i += x.skipped), (s -= 1));
    }
    let w = p.rows?.at(-1)?.asset_id;
    if (w) await e.state.set(a, w);
    if ((p.rows?.length ?? 0) < m) l.push(u.request_id);
    else d = !0;
  }
  if (s > 0) {
    let u = (await e.state.get("consentCursor")) ?? "",
      a = s,
      h = await e.vault.read({
        entity: "enrich.derivation",
        where: [
          { column: "target_id", op: "gt", value: u },
          { column: "variant", op: "eq", value: "faces" },
        ],
        orderBy: { column: "target_id", dir: "asc" },
        limit: a,
        purpose: M,
      });
    for (let p of h.rows ?? []) {
      if (c.has(p.target_id)) continue;
      let w = await ue(e, p.target_id);
      if (!w) {
        i += 1;
        continue;
      }
      let y = await H(e, w, t);
      ((r += y.derived), (i += y.skipped));
    }
    let m = h.rows?.at(-1)?.target_id;
    if (m) await e.state.set("consentCursor", m);
    if ((h.rows?.length ?? 0) === a) d = !0;
  }
  if (l.length)
    await e.vault.invoke({
      command: "enrich.mark_requests_drained",
      input: { request_ids: l },
      purpose: M,
    });
  if (r > 0)
    await e.vault.invoke({
      command: "enrich.rebuild_face_clusters",
      input: {},
      purpose: M,
    });
  return {
    summary: `faces derived ${r}; skipped ${i}; consent queue batch ${o.rows?.length ?? 0}/${B}`,
    output: { derived: r, skipped: i, drained: l.length, model: t, rearm: d },
  };
}
export { at as setFacesRuntimeForTests, Ce as default };
