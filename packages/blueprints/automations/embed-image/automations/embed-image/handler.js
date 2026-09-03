// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as K } from "node:fs";
import u from "node:path";
import m from "node:path";
var L = m.resolve(import.meta.dirname, ".."),
  B = "__centraidAutomationRuntimeDir";
function U() {
  let e = globalThis[B];
  if (typeof e === "string" && e.length > 0) return m.resolve(e);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return m.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return m.join(L, "runtime");
}
var T = U(),
  v = m.join(T, "models");
import { existsSync as _, readFileSync as $, statSync as H } from "node:fs";
import b from "node:path";
import { pathToFileURL as W } from "node:url";
var h;
class w extends Error {
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
function A(e, t = T) {
  let r = b.join(t, "node_modules");
  if (!_(r)) throw new w(e);
  let n = b.join(r, ...e.split("/"));
  try {
    let o = k(n);
    if (o === null) throw Error(`no entry point in ${n}`);
    return o;
  } catch (o) {
    throw new w(e, o);
  }
}
function k(e, t = 0) {
  let r = b.join(e, "package.json"),
    n = _(r) ? JSON.parse($(r, "utf8")) : {},
    o = [
      ...x(X(n.exports)),
      ...(typeof n.main === "string" ? [n.main] : []),
      "index.js",
    ];
  for (let s of o) {
    let a = q(b.resolve(e, s), t);
    if (a !== null) return a;
  }
  return null;
}
function q(e, t) {
  let r = D(e);
  if (r?.isFile()) return e;
  if (r?.isDirectory()) return t >= 4 ? null : k(e, t + 1);
  for (let n of [".js", ".json", ".node"]) {
    let o = `${e}${n}`;
    if (D(o)?.isFile()) return o;
  }
  return null;
}
function D(e) {
  try {
    return H(e);
  } catch {
    return null;
  }
}
function X(e) {
  if (typeof e === "string") return e;
  if (e === null || typeof e !== "object") return;
  let t = e;
  return "." in t ? t["."] : t;
}
function x(e, t = 0) {
  if (typeof e === "string") return [e];
  if (t > 8 || e === null || typeof e !== "object") return [];
  if (Array.isArray(e)) return e.flatMap((o) => x(o, t + 1));
  let r = e,
    n = [];
  for (let o of ["require", "node", "default"])
    if (o in r) n.push(...x(r[o], t + 1));
  return n;
}
async function E() {
  if (h) return h;
  let e = A("onnxruntime-node");
  return ((h = await import(W(e).href)), h);
}
var g;
async function C(e) {
  g ??= new Map();
  let t = g.get(e);
  if (t) return t;
  if (!_(e)) throw new w(e);
  let r = E().then((n) => n.InferenceSession.create(e));
  g.set(e, r);
  try {
    return await r;
  } catch (n) {
    throw (g.delete(e), n);
  }
}
import { pathToFileURL as G } from "node:url";
var y;
async function J() {
  if (y) return y;
  let e = A("sharp");
  return ((y = (await import(G(e).href)).default), y);
}
async function P(e, t) {
  let n = (await J())(Buffer.from(e)),
    { data: o, info: s } = await n
      .resize({ width: t, height: t, fit: "cover", position: "centre" })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: !0 });
  return {
    data: new Uint8Array(o.buffer, o.byteOffset, o.byteLength),
    width: s.width,
    height: s.height,
  };
}
var V = [0.48145466, 0.4578275, 0.40821073],
  Z = [0.26862954, 0.26130258, 0.27577711];
function N(e) {
  let { width: t, height: r, data: n } = e,
    o = t * r,
    s = new Float32Array(o * 3);
  for (let a = 0; a < o; a++)
    for (let i = 0; i < 3; i++) {
      let d = (n[a * 3 + i] ?? 0) / 255;
      s[i * o + a] = (d - V[i]) / Z[i];
    }
  return s;
}
var F = "clip-vit-b-32@1",
  I = u.join(v, "clip"),
  Y = u.join(I, "visual.onnx"),
  xe = u.join(I, "textual.onnx"),
  _e = u.join(I, "vocab.json"),
  Ae = u.join(I, "merges.txt"),
  M = 224;
function R(e = v) {
  let t = u.join(e, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (r) => K(u.join(t, r))
  );
}
function Q(e) {
  let t = 0;
  for (let n of e) t += n * n;
  let r = Math.sqrt(t);
  if (r === 0) return Array.from(e);
  return Array.from(e, (n) => n / r);
}
function ee(e, t) {
  let r = t[0],
    n = r ? e[r] : void 0;
  if (!n || !(n.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return n.data;
}
async function S(e) {
  try {
    let t = Buffer.from(e.bytes, "base64"),
      r = await P(t, M),
      n = N(r),
      o = await E(),
      s = await C(Y),
      i = {
        [s.inputNames[0] ?? "pixel_values"]: new o.Tensor("float32", n, [
          1,
          3,
          M,
          M,
        ]),
      },
      d = await s.run(i),
      c = Q(ee(d, s.outputNames));
    return { id: e.id, vector: c };
  } catch (t) {
    return { id: e.id, error: t instanceof Error ? t.message : String(t) };
  }
}
var O = 16,
  l = "dpv:ServiceProvision",
  z = S,
  j = R;
function Re(e) {
  ((z = e?.infer ?? S), (j = e?.weightsPresent ?? R));
}
function te() {
  return j() ? F : null;
}
async function ne(e, t) {
  let n = (
    await e.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["photo", "scan"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: l,
    })
  ).rows?.[0];
  if (!n) return "";
  return (
    await e.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: n.asset_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: l,
    })
  ).rows?.[0]?.model === t
    ? n.asset_id
    : "";
}
async function re({ ctx: e, log: t }) {
  let r = te();
  if (!r)
    return { summary: "image embedding skipped — model assets unavailable" };
  let n = await e.state.get("model");
  if (n !== r)
    (await e.state.set("cursor", n === void 0 ? await ne(e, r) : ""),
      await e.state.set("model", r));
  let o = (await e.state.get("cursor")) ?? "",
    s = await e.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: o },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: O,
      purpose: l,
    }),
    a = 0,
    i = 0;
  for (let c of s.rows ?? []) {
    if (c.kind !== "photo" && c.kind !== "scan") {
      i += 1;
      continue;
    }
    if (
      (
        await e.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: c.asset_id },
            { column: "variant", op: "eq", value: "embedding" },
          ],
          limit: 1,
          purpose: l,
        })
      ).rows?.[0]?.model === r
    ) {
      i += 1;
      continue;
    }
    let f = await e.vault.content({
      contentId: c.content_id,
      variant: "preview",
      maxBytes: 4194304,
      purpose: l,
    });
    if (f?.status !== "ok" || f.kind !== "bytes")
      throw Error(`asset ${c.asset_id}: preview is unavailable`);
    let p = await z({
      id: c.asset_id,
      mediaType: f.mediaType,
      bytes: f.base64,
    });
    if (!p || p.error || !Array.isArray(p.vector)) {
      ((i += 1), t.info(`asset ${c.asset_id}: no image vector`));
      continue;
    }
    (await e.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "media.asset",
        entity_id: c.asset_id,
        model: r,
        vector: p.vector,
        capability: "embed-image",
      },
      purpose: l,
    }),
      (a += 1));
  }
  let d = s.rows?.at(-1)?.asset_id;
  if (d) await e.state.set("cursor", d);
  return {
    summary: `embedded ${a} images; skipped ${i}; bounded batch ${s.rows?.length ?? 0}/${O}`,
    output: {
      derived: a,
      skipped: i,
      model: r,
      rearm: (s.rows?.length ?? 0) === O,
    },
  };
}
export { Re as setEmbedImageRuntimeForTests, re as default };
