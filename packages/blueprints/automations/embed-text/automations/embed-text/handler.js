// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as Kv } from "node:fs";
import { readFile as c } from "node:fs/promises";
import H from "node:path";
import w from "node:path";
var s = w.resolve(import.meta.dirname, ".."),
  P = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? w.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : w.join(s, "runtime"),
  D = w.join(P, "models");
import { existsSync as z, readFileSync as i, statSync as t } from "node:fs";
import u from "node:path";
import { pathToFileURL as a } from "node:url";
var A;
class F extends Error {
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
function S(v, B = P) {
  let q = u.join(B, "node_modules");
  if (!z(q)) throw new F(v);
  let J = u.join(q, ...v.split("/"));
  try {
    let $ = b(J);
    if ($ === null) throw Error(`no entry point in ${J}`);
    return $;
  } catch ($) {
    throw new F(v, $);
  }
}
function b(v, B = 0) {
  let q = u.join(v, "package.json"),
    J = z(q) ? JSON.parse(i(q, "utf8")) : {},
    $ = [
      ...N(vv(J.exports)),
      ...(typeof J.main === "string" ? [J.main] : []),
      "index.js",
    ];
  for (let K of $) {
    let V = e(u.resolve(v, K), B);
    if (V !== null) return V;
  }
  return null;
}
function e(v, B) {
  let q = I(v);
  if (q?.isFile()) return v;
  if (q?.isDirectory()) return B >= 4 ? null : b(v, B + 1);
  for (let J of [".js", ".json", ".node"]) {
    let $ = `${v}${J}`;
    if (I($)?.isFile()) return $;
  }
  return null;
}
function I(v) {
  try {
    return t(v);
  } catch {
    return null;
  }
}
function vv(v) {
  if (typeof v === "string") return v;
  if (v === null || typeof v !== "object") return;
  let B = v;
  return "." in B ? B["."] : B;
}
function N(v, B = 0) {
  if (typeof v === "string") return [v];
  if (B > 8 || v === null || typeof v !== "object") return [];
  if (Array.isArray(v)) return v.flatMap(($) => N($, B + 1));
  let q = v,
    J = [];
  for (let $ of ["require", "node", "default"])
    if ($ in q) J.push(...N(q[$], B + 1));
  return J;
}
async function f() {
  if (A) return A;
  let v = S("onnxruntime-node");
  return ((A = await import(a(v).href)), A);
}
var M;
async function x(v) {
  M ??= new Map();
  let B = M.get(v);
  if (B) return B;
  if (!z(v)) throw new F(v);
  let q = f().then((J) => J.InferenceSession.create(v));
  M.set(v, q);
  try {
    return await q;
  } catch (J) {
    throw (M.delete(v), J);
  }
}
function qv() {
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
function $v(v) {
  let B = new Map();
  return (
    v.forEach(([q, J], $) => {
      B.set(`${q} ${J}`, $);
    }),
    B
  );
}
function Bv(v, B) {
  if (v.length === 0) return [];
  if (v.length === 1) return [`${v}</w>`];
  let q = [...v.slice(0, -1), `${v.at(-1)}</w>`];
  for (;;) {
    let J,
      $ = Number.POSITIVE_INFINITY;
    for (let Q = 0; Q < q.length - 1; Q++) {
      let X = q[Q],
        _ = q[Q + 1],
        Y = B.get(`${X} ${_}`);
      if (Y !== void 0 && Y < $) (($ = Y), (J = [X, _]));
    }
    if (!J) break;
    let [K, V] = J,
      j = [],
      W = 0;
    while (W < q.length)
      if (q[W] === K && q[W + 1] === V) (j.push(K + V), (W += 2));
      else (j.push(q[W]), (W += 1));
    q = j;
  }
  return q;
}
var Jv =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;
function Qv(v) {
  return v.trim().replace(/\s+/gu, " ").toLowerCase();
}
function Yv(v) {
  return Qv(v).match(Jv) ?? [];
}
var _v = 77;
function m(v) {
  let B = qv(),
    q = $v(v.merges),
    J = new Map(),
    $ = v.vocab.get("<|startoftext|>"),
    K = v.vocab.get("<|endoftext|>");
  if ($ === void 0 || K === void 0)
    throw Error(
      "createClipTokenizer: vocab is missing <|startoftext|> or <|endoftext|>"
    );
  let V = $,
    j = K;
  function W(_) {
    let Y = new TextEncoder().encode(_),
      Z = "";
    for (let U of Y) Z += B.get(U) ?? "";
    return Z;
  }
  function Q(_) {
    let Y = J.get(_);
    if (Y) return Y;
    let Z = Bv(_, q);
    return (J.set(_, Z), Z);
  }
  function X(_, Y = _v) {
    let Z = Yv(_),
      U = [];
    for (let r of Z) {
      let o = W(r);
      for (let d of Q(o)) {
        let E = v.vocab.get(d);
        if (E !== void 0) U.push(E);
      }
    }
    let h = Y - 2,
      n = U.slice(0, Math.max(0, h)),
      L = [V, ...n, j];
    while (L.length < Y) L.push(0);
    return L;
  }
  return { encode: X };
}
var p = "clip-vit-b-32@1",
  C = H.join(D, "clip"),
  mv = H.join(C, "visual.onnx"),
  Vv = H.join(C, "textual.onnx"),
  Wv = H.join(C, "vocab.json"),
  jv = H.join(C, "merges.txt");
var Xv = 77;
function y(v = D) {
  let B = H.join(v, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (q) => Kv(H.join(B, q))
  );
}
function Zv(v) {
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
var O;
async function Hv() {
  if (O) return O;
  let [v, B] = await Promise.all([c(Wv, "utf8"), c(jv, "utf8")]),
    q = JSON.parse(v);
  return ((O = m({ vocab: new Map(Object.entries(q)), merges: Zv(B) })), O);
}
function Gv(v) {
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
    let q = (await Hv()).encode(v.text, Xv),
      J = await f(),
      $ = await x(Vv),
      V = {
        [$.inputNames[0] ?? "input_ids"]: new J.Tensor(
          "int64",
          BigInt64Array.from(q.map(BigInt)),
          [1, q.length]
        ),
      },
      j = await $.run(V),
      W = Gv(Uv(j, $.outputNames));
    return { id: v.id, vector: W };
  } catch (B) {
    return { id: v.id, error: B instanceof Error ? B.message : String(B) };
  }
}
var k = 16,
  G = "dpv:ServiceProvision",
  T = R,
  g = y;
function gv(v) {
  ((T = v?.infer ?? R), (g = v?.weightsPresent ?? y));
}
function wv() {
  return g() ? p : null;
}
function l(v, B, q) {
  let J =
    typeof v?.payload_json === "string"
      ? JSON.parse(v.payload_json).source_version
      : v?.source_version;
  return v?.model === B && J === q;
}
async function Av(v, B) {
  let J = (
    await v.vault.read({
      entity: "core.content_derivative",
      where: [{ column: "variant", op: "in", value: ["text", "transcript"] }],
      orderBy: { column: "derivative_id", dir: "desc" },
      limit: 1,
      purpose: G,
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
    purpose: G,
  });
  return l($.rows?.[0], B, J.derivative_id) ? J.derivative_id : "";
}
async function Mv({ ctx: v, log: B }) {
  let q = wv();
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
    (await v.state.set("cursor", J === void 0 ? await Av(v, q) : ""),
      await v.state.set("model", q));
  let $ = (await v.state.get("cursor")) ?? "",
    K = await v.vault.read({
      entity: "core.content_derivative",
      where: [
        { column: "derivative_id", op: "gt", value: $ },
        { column: "variant", op: "in", value: ["text", "transcript"] },
      ],
      orderBy: { column: "derivative_id", dir: "asc" },
      limit: k,
      purpose: G,
    }),
    V = 0,
    j = 0;
  for (let Q of K.rows ?? []) {
    let X = await v.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: Q.content_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: G,
    });
    if (l(X.rows?.[0], q, Q.derivative_id)) {
      j += 1;
      continue;
    }
    let _ = await v.vault.content({
      contentId: Q.content_id,
      variant: Q.variant,
      maxBytes: 1048576,
      purpose: G,
    });
    if (_?.status !== "ok" || _.kind !== "text")
      throw Error(`content ${Q.content_id}: ${Q.variant} text is unavailable`);
    let Y = await T({ id: Q.content_id, text: _.text });
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
      purpose: G,
    }),
      (V += 1));
  }
  let W = K.rows?.at(-1)?.derivative_id;
  if (W) await v.state.set("cursor", W);
  return {
    summary: `embedded ${V} texts; skipped ${j}; bounded batch ${K.rows?.length ?? 0}/${k}`,
    output: {
      derived: V,
      skipped: j,
      model: q,
      rearm: (K.rows?.length ?? 0) === k,
    },
  };
}
export { gv as setEmbedTextRuntimeForTests, Mv as default };
