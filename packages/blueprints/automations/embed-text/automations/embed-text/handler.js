// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as de } from "node:fs";
import { readFile as B } from "node:fs/promises";
import p from "node:path";
import g from "node:path";
var V = g.resolve(import.meta.dirname, ".."),
  Z = "__centraidAutomationRuntimeDir";
function K() {
  let e = globalThis[Z];
  if (typeof e === "string" && e.length > 0) return g.resolve(e);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return g.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return g.join(V, "runtime");
}
var A = K(),
  E = g.join(A, "models");
import { existsSync as S, readFileSync as Y, statSync as Q } from "node:fs";
import v from "node:path";
import { pathToFileURL as ee } from "node:url";
var b;
class x extends Error {
  constructor(e, r) {
    super(
      `Automation model runtime dependency "${e}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: r }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function F(e, r = A) {
  let t = v.join(r, "node_modules");
  if (!S(t)) throw new x(e);
  let o = v.join(t, ...e.split("/"));
  try {
    let n = j(o);
    if (n === null) throw Error(`no entry point in ${o}`);
    return n;
  } catch (n) {
    throw new x(e, n);
  }
}
function j(e, r = 0) {
  let t = v.join(e, "package.json"),
    o = S(t) ? JSON.parse(Y(t, "utf8")) : {},
    n = [
      ...M(ne(o.exports)),
      ...(typeof o.main === "string" ? [o.main] : []),
      "index.js",
    ];
  for (let c of n) {
    let u = te(v.resolve(e, c), r);
    if (u !== null) return u;
  }
  return null;
}
function te(e, r) {
  let t = P(e);
  if (t?.isFile()) return e;
  if (t?.isDirectory()) return r >= 4 ? null : j(e, r + 1);
  for (let o of [".js", ".json", ".node"]) {
    let n = `${e}${o}`;
    if (P(n)?.isFile()) return n;
  }
  return null;
}
function P(e) {
  try {
    return Q(e);
  } catch {
    return null;
  }
}
function ne(e) {
  if (typeof e === "string") return e;
  if (e === null || typeof e !== "object") return;
  let r = e;
  return "." in r ? r["."] : r;
}
function M(e, r = 0) {
  if (typeof e === "string") return [e];
  if (r > 8 || e === null || typeof e !== "object") return [];
  if (Array.isArray(e)) return e.flatMap((n) => M(n, r + 1));
  let t = e,
    o = [];
  for (let n of ["require", "node", "default"])
    if (n in t) o.push(...M(t[n], r + 1));
  return o;
}
async function R() {
  if (b) return b;
  let e = F("onnxruntime-node");
  return ((b = await import(ee(e).href)), b);
}
var y;
async function z(e) {
  y ??= new Map();
  let r = y.get(e);
  if (r) return r;
  if (!S(e)) throw new x(e);
  let t = R().then((o) => o.InferenceSession.create(e));
  y.set(e, t);
  try {
    return await t;
  } catch (o) {
    throw (y.delete(e), o);
  }
}
function re() {
  let e = [];
  for (let n = "!".codePointAt(0); n <= "~".codePointAt(0); n++) e.push(n);
  for (let n = "¡".codePointAt(0); n <= "¬".codePointAt(0); n++) e.push(n);
  for (let n = "®".codePointAt(0); n <= "ÿ".codePointAt(0); n++) e.push(n);
  let r = [...e],
    t = 0;
  for (let n = 0; n < 256; n++)
    if (!e.includes(n)) (e.push(n), r.push(256 + t), t++);
  let o = new Map();
  for (let n = 0; n < e.length; n++) o.set(e[n], String.fromCodePoint(r[n]));
  return o;
}
function oe(e) {
  let r = new Map();
  return (
    e.forEach(([t, o], n) => {
      r.set(`${t} ${o}`, n);
    }),
    r
  );
}
function ie(e, r) {
  if (e.length === 0) return [];
  if (e.length === 1) return [`${e}</w>`];
  let t = [...e.slice(0, -1), `${e.at(-1)}</w>`];
  for (;;) {
    let o,
      n = Number.POSITIVE_INFINITY;
    for (let i = 0; i < t.length - 1; i++) {
      let m = t[i],
        a = t[i + 1],
        s = r.get(`${m} ${a}`);
      if (s !== void 0 && s < n) ((n = s), (o = [m, a]));
    }
    if (!o) break;
    let [c, u] = o,
      l = [],
      d = 0;
    while (d < t.length)
      if (t[d] === c && t[d + 1] === u) (l.push(c + u), (d += 2));
      else (l.push(t[d]), (d += 1));
    t = l;
  }
  return t;
}
var se =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;
function ae(e) {
  return e.trim().replace(/\s+/gu, " ").toLowerCase();
}
function ce(e) {
  return ae(e).match(se) ?? [];
}
var ue = 77;
function L(e) {
  let r = re(),
    t = oe(e.merges),
    o = new Map(),
    n = e.vocab.get("<|startoftext|>"),
    c = e.vocab.get("<|endoftext|>");
  if (n === void 0 || c === void 0)
    throw Error(
      "createClipTokenizer: vocab is missing <|startoftext|> or <|endoftext|>"
    );
  let u = n,
    l = c;
  function d(a) {
    let s = new TextEncoder().encode(a),
      f = "";
    for (let w of s) f += r.get(w) ?? "";
    return f;
  }
  function i(a) {
    let s = o.get(a);
    if (s) return s;
    let f = ie(a, t);
    return (o.set(a, f), f);
  }
  function m(a, s = ue) {
    let f = ce(a),
      w = [];
    for (let X of f) {
      let G = d(X);
      for (let J of i(G)) {
        let N = e.vocab.get(J);
        if (N !== void 0) w.push(N);
      }
    }
    let H = s - 2,
      W = w.slice(0, Math.max(0, H)),
      T = [u, ...W, l];
    while (T.length < s) T.push(0);
    return T;
  }
  return { encode: m };
}
var U = "clip-vit-b-32@1",
  I = p.join(E, "clip"),
  Ue = p.join(I, "visual.onnx"),
  le = p.join(I, "textual.onnx"),
  me = p.join(I, "vocab.json"),
  fe = p.join(I, "merges.txt");
var pe = 77;
function O(e = E) {
  let r = p.join(e, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (t) => de(p.join(r, t))
  );
}
function he(e) {
  let r = [];
  for (let t of e.split(`
`)) {
    let o = t.trim();
    if (!o || o.startsWith("#")) continue;
    let n = o.split(" ");
    if (n.length === 2) r.push([n[0], n[1]]);
  }
  return r;
}
var _;
async function ge() {
  if (_) return _;
  let [e, r] = await Promise.all([B(me, "utf8"), B(fe, "utf8")]),
    t = JSON.parse(e);
  return ((_ = L({ vocab: new Map(Object.entries(t)), merges: he(r) })), _);
}
function we(e) {
  let r = 0;
  for (let o of e) r += o * o;
  let t = Math.sqrt(r);
  if (t === 0) return Array.from(e);
  return Array.from(e, (o) => o / t);
}
function be(e, r) {
  let t = r[0],
    o = t ? e[t] : void 0;
  if (!o || !(o.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return o.data;
}
async function D(e) {
  try {
    let t = (await ge()).encode(e.text, pe),
      o = await R(),
      n = await z(le),
      u = {
        [n.inputNames[0] ?? "input_ids"]: new o.Tensor(
          "int64",
          BigInt64Array.from(t.map(BigInt)),
          [1, t.length]
        ),
      },
      l = await n.run(u),
      d = we(be(l, n.outputNames));
    return { id: e.id, vector: d };
  } catch (r) {
    return { id: e.id, error: r instanceof Error ? r.message : String(r) };
  }
}
var k = 16,
  h = "dpv:ServiceProvision",
  C = D,
  $ = O;
function He(e) {
  ((C = e?.infer ?? D), ($ = e?.weightsPresent ?? O));
}
function ye() {
  return $() ? U : null;
}
function q(e, r, t) {
  let o =
    typeof e?.payload_json === "string"
      ? JSON.parse(e.payload_json).source_version
      : e?.source_version;
  return e?.model === r && o === t;
}
async function ve(e, r) {
  let o = (
    await e.vault.read({
      entity: "core.content_derivative",
      where: [{ column: "variant", op: "in", value: ["text", "transcript"] }],
      orderBy: { column: "derivative_id", dir: "desc" },
      limit: 1,
      purpose: h,
    })
  ).rows?.[0];
  if (!o) return "";
  let n = await e.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: o.content_id },
      { column: "variant", op: "eq", value: "embedding" },
    ],
    limit: 1,
    purpose: h,
  });
  return q(n.rows?.[0], r, o.derivative_id) ? o.derivative_id : "";
}
async function xe({ ctx: e, log: r }) {
  let t = ye();
  if (!t)
    return { summary: "text embedding skipped — model assets unavailable" };
  if (typeof e.input?.query === "string") {
    let i = e.input.query.trim();
    if (!i) throw Error("text embedding query is empty");
    let m = await C({ id: "query", text: i });
    if (!m || m.error || !Array.isArray(m.vector))
      throw Error(m?.error ?? "text embedding returned no vector");
    return {
      summary: "embedded one search query",
      output: { model: t, vector: m.vector },
    };
  }
  let o = await e.state.get("model");
  if (o !== t)
    (await e.state.set("cursor", o === void 0 ? await ve(e, t) : ""),
      await e.state.set("model", t));
  let n = (await e.state.get("cursor")) ?? "",
    c = await e.vault.read({
      entity: "core.content_derivative",
      where: [
        { column: "derivative_id", op: "gt", value: n },
        { column: "variant", op: "in", value: ["text", "transcript"] },
      ],
      orderBy: { column: "derivative_id", dir: "asc" },
      limit: k,
      purpose: h,
    }),
    u = 0,
    l = 0;
  for (let i of c.rows ?? []) {
    let m = await e.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: i.content_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: h,
    });
    if (q(m.rows?.[0], t, i.derivative_id)) {
      l += 1;
      continue;
    }
    let a = await e.vault.content({
      contentId: i.content_id,
      variant: i.variant,
      maxBytes: 1048576,
      purpose: h,
    });
    if (a?.status !== "ok" || a.kind !== "text")
      throw Error(`content ${i.content_id}: ${i.variant} text is unavailable`);
    let s = await C({ id: i.content_id, text: a.text });
    if (!s || s.error || !Array.isArray(s.vector)) {
      ((l += 1), r.info(`content ${i.content_id}: no text vector`));
      continue;
    }
    (await e.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "core.content_item",
        entity_id: i.content_id,
        model: t,
        vector: s.vector,
        capability: "embed-text",
        source_version: i.derivative_id,
      },
      purpose: h,
    }),
      (u += 1));
  }
  let d = c.rows?.at(-1)?.derivative_id;
  if (d) await e.state.set("cursor", d);
  return {
    summary: `embedded ${u} texts; skipped ${l}; bounded batch ${c.rows?.length ?? 0}/${k}`,
    output: {
      derived: u,
      skipped: l,
      model: t,
      rearm: (c.rows?.length ?? 0) === k,
    },
  };
}
export { He as setEmbedTextRuntimeForTests, xe as default };
