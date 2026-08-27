// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as _v } from "node:fs";
import { readFile as c } from "node:fs/promises";
import w from "node:path";
import G from "node:path";
var o = G.resolve(import.meta.dirname, ".."),
  i = "__centraidAutomationRuntimeDir";
function t() {
  let v = globalThis[i];
  if (typeof v === "string" && v.length > 0) return G.resolve(v);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return G.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return G.join(o, "runtime");
}
var L = t(),
  P = G.join(L, "models");
import { existsSync as N, readFileSync as a, statSync as e } from "node:fs";
import M from "node:path";
import { pathToFileURL as vv } from "node:url";
var U;
class C extends Error {
  constructor(v, B) {
    super(
      `Automation model runtime dependency "${v}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: B }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function S(v, B = L) {
  let q = M.join(B, "node_modules");
  if (!N(q)) throw new C(v);
  let J = M.join(q, ...v.split("/"));
  try {
    let $ = b(J);
    if ($ === null) throw Error(`no entry point in ${J}`);
    return $;
  } catch ($) {
    throw new C(v, $);
  }
}
function b(v, B = 0) {
  let q = M.join(v, "package.json"),
    J = N(q) ? JSON.parse(a(q, "utf8")) : {},
    $ = [
      ...y($v(J.exports)),
      ...(typeof J.main === "string" ? [J.main] : []),
      "index.js",
    ];
  for (let V of $) {
    let W = qv(M.resolve(v, V), B);
    if (W !== null) return W;
  }
  return null;
}
function qv(v, B) {
  let q = E(v);
  if (q?.isFile()) return v;
  if (q?.isDirectory()) return B >= 4 ? null : b(v, B + 1);
  for (let J of [".js", ".json", ".node"]) {
    let $ = `${v}${J}`;
    if (E($)?.isFile()) return $;
  }
  return null;
}
function E(v) {
  try {
    return e(v);
  } catch {
    return null;
  }
}
function $v(v) {
  if (typeof v === "string") return v;
  if (v === null || typeof v !== "object") return;
  let B = v;
  return "." in B ? B["."] : B;
}
function y(v, B = 0) {
  if (typeof v === "string") return [v];
  if (B > 8 || v === null || typeof v !== "object") return [];
  if (Array.isArray(v)) return v.flatMap(($) => y($, B + 1));
  let q = v,
    J = [];
  for (let $ of ["require", "node", "default"])
    if ($ in q) J.push(...y(q[$], B + 1));
  return J;
}
async function z() {
  if (U) return U;
  let v = S("onnxruntime-node");
  return ((U = await import(vv(v).href)), U);
}
var A;
async function x(v) {
  A ??= new Map();
  let B = A.get(v);
  if (B) return B;
  if (!N(v)) throw new C(v);
  let q = z().then((J) => J.InferenceSession.create(v));
  A.set(v, q);
  try {
    return await q;
  } catch (J) {
    throw (A.delete(v), J);
  }
}
function Bv() {
  let v = [];
  for (let $ = "!".codePointAt(0); $ <= "~".codePointAt(0); $++) v.push($);
  for (let $ = "¡".codePointAt(0); $ <= "¬".codePointAt(0); $++) v.push($);
  for (let $ = "®".codePointAt(0); $ <= "ÿ".codePointAt(0); $++) v.push($);
  let B = [...v],
    q = 0;
  for (let $ = 0; $ < 256; $++)
    if (!v.includes($)) (v.push($), B.push(256 + q), q++);
  let J = new Map();
  for (let $ = 0; $ < v.length; $++) J.set(v[$], String.fromCodePoint(B[$]));
  return J;
}
function Jv(v) {
  let B = new Map();
  return (
    v.forEach(([q, J], $) => {
      B.set(`${q} ${J}`, $);
    }),
    B
  );
}
function Qv(v, B) {
  if (v.length === 0) return [];
  if (v.length === 1) return [`${v}</w>`];
  let q = [...v.slice(0, -1), `${v.at(-1)}</w>`];
  for (;;) {
    let J,
      $ = Number.POSITIVE_INFINITY;
    for (let Q = 0; Q < q.length - 1; Q++) {
      let X = q[Q],
        K = q[Q + 1],
        Y = B.get(`${X} ${K}`);
      if (Y !== void 0 && Y < $) (($ = Y), (J = [X, K]));
    }
    if (!J) break;
    let [V, W] = J,
      j = [],
      _ = 0;
    while (_ < q.length)
      if (q[_] === V && q[_ + 1] === W) (j.push(V + W), (_ += 2));
      else (j.push(q[_]), (_ += 1));
    q = j;
  }
  return q;
}
var Yv =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;
function Kv(v) {
  return v.trim().replace(/\s+/gu, " ").toLowerCase();
}
function Vv(v) {
  return Kv(v).match(Yv) ?? [];
}
var Wv = 77;
function m(v) {
  let B = Bv(),
    q = Jv(v.merges),
    J = new Map(),
    $ = v.vocab.get("<|startoftext|>"),
    V = v.vocab.get("<|endoftext|>");
  if ($ === void 0 || V === void 0)
    throw Error(
      "createClipTokenizer: vocab is missing <|startoftext|> or <|endoftext|>"
    );
  let W = $,
    j = V;
  function _(K) {
    let Y = new TextEncoder().encode(K),
      Z = "";
    for (let H of Y) Z += B.get(H) ?? "";
    return Z;
  }
  function Q(K) {
    let Y = J.get(K);
    if (Y) return Y;
    let Z = Qv(K, q);
    return (J.set(K, Z), Z);
  }
  function X(K, Y = Wv) {
    let Z = Vv(K),
      H = [];
    for (let h of Z) {
      let s = _(h);
      for (let d of Q(s)) {
        let I = v.vocab.get(d);
        if (I !== void 0) H.push(I);
      }
    }
    let n = Y - 2,
      r = H.slice(0, Math.max(0, n)),
      f = [W, ...r, j];
    while (f.length < Y) f.push(0);
    return f;
  }
  return { encode: X };
}
var g = "clip-vit-b-32@1",
  O = w.join(P, "clip"),
  gv = w.join(O, "visual.onnx"),
  jv = w.join(O, "textual.onnx"),
  Xv = w.join(O, "vocab.json"),
  Zv = w.join(O, "merges.txt");
var wv = 77;
function D(v = P) {
  let B = w.join(v, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (q) => _v(w.join(B, q))
  );
}
function uv(v) {
  let B = [];
  for (let q of v.split(`
`)) {
    let J = q.trim();
    if (!J || J.startsWith("#")) continue;
    let $ = J.split(" ");
    if ($.length === 2) B.push([$[0], $[1]]);
  }
  return B;
}
var F;
async function Gv() {
  if (F) return F;
  let [v, B] = await Promise.all([c(Xv, "utf8"), c(Zv, "utf8")]),
    q = JSON.parse(v);
  return ((F = m({ vocab: new Map(Object.entries(q)), merges: uv(B) })), F);
}
function Hv(v) {
  let B = 0;
  for (let J of v) B += J * J;
  let q = Math.sqrt(B);
  if (q === 0) return Array.from(v);
  return Array.from(v, (J) => J / q);
}
function Uv(v, B) {
  let q = B[0],
    J = q ? v[q] : void 0;
  if (!J || !(J.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return J.data;
}
async function R(v) {
  try {
    let q = (await Gv()).encode(v.text, wv),
      J = await z(),
      $ = await x(jv),
      W = {
        [$.inputNames[0] ?? "input_ids"]: new J.Tensor(
          "int64",
          BigInt64Array.from(q.map(BigInt)),
          [1, q.length]
        ),
      },
      j = await $.run(W),
      _ = Hv(Uv(j, $.outputNames));
    return { id: v.id, vector: _ };
  } catch (B) {
    return { id: v.id, error: B instanceof Error ? B.message : String(B) };
  }
}
var k = 16,
  u = "dpv:ServiceProvision",
  T = R,
  p = D;
function nv(v) {
  ((T = v?.infer ?? R), (p = v?.weightsPresent ?? D));
}
function Av() {
  return p() ? g : null;
}
function l(v, B, q) {
  let J =
    typeof v?.payload_json === "string"
      ? JSON.parse(v.payload_json).source_version
      : v?.source_version;
  return v?.model === B && J === q;
}
async function Mv(v, B) {
  let J = (
    await v.vault.read({
      entity: "core.content_derivative",
      where: [{ column: "variant", op: "in", value: ["text", "transcript"] }],
      orderBy: { column: "derivative_id", dir: "desc" },
      limit: 1,
      purpose: u,
    })
  ).rows?.[0];
  if (!J) return "";
  let $ = await v.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: J.content_id },
      { column: "variant", op: "eq", value: "embedding" },
    ],
    limit: 1,
    purpose: u,
  });
  return l($.rows?.[0], B, J.derivative_id) ? J.derivative_id : "";
}
async function Cv({ ctx: v, log: B }) {
  let q = Av();
  if (!q)
    return { summary: "text embedding skipped — model assets unavailable" };
  if (typeof v.input?.query === "string") {
    let Q = v.input.query.trim();
    if (!Q) throw Error("text embedding query is empty");
    let X = await T({ id: "query", text: Q });
    if (!X || X.error || !Array.isArray(X.vector))
      throw Error(X?.error ?? "text embedding returned no vector");
    return {
      summary: "embedded one search query",
      output: { model: q, vector: X.vector },
    };
  }
  let J = await v.state.get("model");
  if (J !== q)
    (await v.state.set("cursor", J === void 0 ? await Mv(v, q) : ""),
      await v.state.set("model", q));
  let $ = (await v.state.get("cursor")) ?? "",
    V = await v.vault.read({
      entity: "core.content_derivative",
      where: [
        { column: "derivative_id", op: "gt", value: $ },
        { column: "variant", op: "in", value: ["text", "transcript"] },
      ],
      orderBy: { column: "derivative_id", dir: "asc" },
      limit: k,
      purpose: u,
    }),
    W = 0,
    j = 0;
  for (let Q of V.rows ?? []) {
    let X = await v.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: Q.content_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: u,
    });
    if (l(X.rows?.[0], q, Q.derivative_id)) {
      j += 1;
      continue;
    }
    let K = await v.vault.content({
      contentId: Q.content_id,
      variant: Q.variant,
      maxBytes: 1048576,
      purpose: u,
    });
    if (K?.status !== "ok" || K.kind !== "text")
      throw Error(`content ${Q.content_id}: ${Q.variant} text is unavailable`);
    let Y = await T({ id: Q.content_id, text: K.text });
    if (!Y || Y.error || !Array.isArray(Y.vector)) {
      ((j += 1), B.info(`content ${Q.content_id}: no text vector`));
      continue;
    }
    (await v.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "core.content_item",
        entity_id: Q.content_id,
        model: q,
        vector: Y.vector,
        capability: "embed-text",
        source_version: Q.derivative_id,
      },
      purpose: u,
    }),
      (W += 1));
  }
  let _ = V.rows?.at(-1)?.derivative_id;
  if (_) await v.state.set("cursor", _);
  return {
    summary: `embedded ${W} texts; skipped ${j}; bounded batch ${V.rows?.length ?? 0}/${k}`,
    output: {
      derived: W,
      skipped: j,
      model: q,
      rearm: (V.rows?.length ?? 0) === k,
    },
  };
}
export { nv as setEmbedTextRuntimeForTests, Cv as default };
