// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as qv } from "node:fs";
import { readFile as x } from "node:fs/promises";
import w from "node:path";
import G from "node:path";
var h = G.resolve(import.meta.dirname, ".."),
  y = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? G.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : G.join(h, "runtime"),
  C = G.join(y, "models");
import { existsSync as T } from "node:fs";
import { createRequire as d } from "node:module";
import k from "node:path";
import { pathToFileURL as o } from "node:url";
var U;
class A extends Error {
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
function E(v, B = y) {
  if (!T(k.join(B, "node_modules"))) throw new A(v);
  let $ = d(k.join(B, "package.json"));
  try {
    return $.resolve(v);
  } catch (q) {
    throw new A(v, q);
  }
}
async function f() {
  if (U) return U;
  let v = E("onnxruntime-node");
  return ((U = await import(o(v).href)), U);
}
var u;
async function I(v) {
  u ??= new Map();
  let B = u.get(v);
  if (B) return B;
  if (!T(v)) throw new A(v);
  let $ = f().then((q) => q.InferenceSession.create(v));
  u.set(v, $);
  try {
    return await $;
  } catch (q) {
    throw (u.delete(v), q);
  }
}
function s() {
  let v = [];
  for (let J = "!".codePointAt(0); J <= "~".codePointAt(0); J++) v.push(J);
  for (let J = "¡".codePointAt(0); J <= "¬".codePointAt(0); J++) v.push(J);
  for (let J = "®".codePointAt(0); J <= "ÿ".codePointAt(0); J++) v.push(J);
  let B = [...v],
    $ = 0;
  for (let J = 0; J < 256; J++)
    if (!v.includes(J)) (v.push(J), B.push(256 + $), $++);
  let q = new Map();
  for (let J = 0; J < v.length; J++) q.set(v[J], String.fromCodePoint(B[J]));
  return q;
}
function t(v) {
  let B = new Map();
  return (
    v.forEach(([$, q], J) => {
      B.set(`${$} ${q}`, J);
    }),
    B
  );
}
function i(v, B) {
  if (v.length === 0) return [];
  if (v.length === 1) return [`${v}</w>`];
  let $ = [...v.slice(0, -1), `${v.at(-1)}</w>`];
  for (;;) {
    let q,
      J = Number.POSITIVE_INFINITY;
    for (let Q = 0; Q < $.length - 1; Q++) {
      let W = $[Q],
        _ = $[Q + 1],
        Y = B.get(`${W} ${_}`);
      if (Y !== void 0 && Y < J) ((J = Y), (q = [W, _]));
    }
    if (!q) break;
    let [j, X] = q,
      V = [],
      K = 0;
    while (K < $.length)
      if ($[K] === j && $[K + 1] === X) (V.push(j + X), (K += 2));
      else (V.push($[K]), (K += 1));
    $ = V;
  }
  return $;
}
var a =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;
function e(v) {
  return v.trim().replace(/\s+/gu, " ").toLowerCase();
}
function vv(v) {
  return e(v).match(a) ?? [];
}
var $v = 77;
function S(v) {
  let B = s(),
    $ = t(v.merges),
    q = new Map(),
    J = v.vocab.get("<|startoftext|>"),
    j = v.vocab.get("<|endoftext|>");
  if (J === void 0 || j === void 0)
    throw Error(
      "createClipTokenizer: vocab is missing <|startoftext|> or <|endoftext|>"
    );
  let X = J,
    V = j;
  function K(_) {
    let Y = new TextEncoder().encode(_),
      Z = "";
    for (let F of Y) Z += B.get(F) ?? "";
    return Z;
  }
  function Q(_) {
    let Y = q.get(_);
    if (Y) return Y;
    let Z = i(_, $);
    return (q.set(_, Z), Z);
  }
  function W(_, Y = $v) {
    let Z = vv(_),
      F = [];
    for (let r of Z) {
      let l = K(r);
      for (let n of Q(l)) {
        let R = v.vocab.get(n);
        if (R !== void 0) F.push(R);
      }
    }
    let c = Y - 2,
      m = F.slice(0, Math.max(0, c)),
      D = [X, ...m, V];
    while (D.length < Y) D.push(0);
    return D;
  }
  return { encode: W };
}
var b = "clip-vit-b-32@1",
  O = w.join(C, "clip"),
  Ev = w.join(O, "visual.onnx"),
  Bv = w.join(O, "textual.onnx"),
  Jv = w.join(O, "vocab.json"),
  Qv = w.join(O, "merges.txt");
var Yv = 77;
function L(v = C) {
  let B = w.join(v, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    ($) => qv(w.join(B, $))
  );
}
function _v(v) {
  let B = [];
  for (let $ of v.split(`
`)) {
    let q = $.trim();
    if (!q || q.startsWith("#")) continue;
    let J = q.split(" ");
    if (J.length === 2) B.push([J[0], J[1]]);
  }
  return B;
}
var M;
async function Kv() {
  if (M) return M;
  let [v, B] = await Promise.all([x(Jv, "utf8"), x(Qv, "utf8")]),
    $ = JSON.parse(v);
  return ((M = S({ vocab: new Map(Object.entries($)), merges: _v(B) })), M);
}
function Vv(v) {
  let B = 0;
  for (let q of v) B += q * q;
  let $ = Math.sqrt(B);
  if ($ === 0) return Array.from(v);
  return Array.from(v, (q) => q / $);
}
function Wv(v, B) {
  let $ = B[0],
    q = $ ? v[$] : void 0;
  if (!q || !(q.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return q.data;
}
async function N(v) {
  try {
    let $ = (await Kv()).encode(v.text, Yv),
      q = await f(),
      J = await I(Bv),
      X = {
        [J.inputNames[0] ?? "input_ids"]: new q.Tensor(
          "int64",
          BigInt64Array.from($.map(BigInt)),
          [1, $.length]
        ),
      },
      V = await J.run(X),
      K = Vv(Wv(V, J.outputNames));
    return { id: v.id, vector: K };
  } catch (B) {
    return { id: v.id, error: B instanceof Error ? B.message : String(B) };
  }
}
var P = 16,
  H = "dpv:ServiceProvision",
  z = N,
  g = L;
function xv(v) {
  ((z = v?.infer ?? N), (g = v?.weightsPresent ?? L));
}
function jv() {
  return g() ? b : null;
}
function p(v, B, $) {
  let q =
    typeof v?.payload_json === "string"
      ? JSON.parse(v.payload_json).source_version
      : v?.source_version;
  return v?.model === B && q === $;
}
async function Xv(v, B) {
  let q = (
    await v.vault.read({
      entity: "core.content_derivative",
      where: [{ column: "variant", op: "in", value: ["text", "transcript"] }],
      orderBy: { column: "derivative_id", dir: "desc" },
      limit: 1,
      purpose: H,
    })
  ).rows?.[0];
  if (!q) return "";
  let J = await v.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: q.content_id },
      { column: "variant", op: "eq", value: "embedding" },
    ],
    limit: 1,
    purpose: H,
  });
  return p(J.rows?.[0], B, q.derivative_id) ? q.derivative_id : "";
}
async function Zv({ ctx: v, log: B }) {
  let $ = jv();
  if (!$)
    return { summary: "text embedding skipped — model assets unavailable" };
  if (typeof v.input?.query === "string") {
    let Q = v.input.query.trim();
    if (!Q) throw Error("text embedding query is empty");
    let W = await z({ id: "query", text: Q });
    if (!W || W.error || !Array.isArray(W.vector))
      throw Error(W?.error ?? "text embedding returned no vector");
    return {
      summary: "embedded one search query",
      output: { model: $, vector: W.vector },
    };
  }
  let q = await v.state.get("model");
  if (q !== $)
    (await v.state.set("cursor", q === void 0 ? await Xv(v, $) : ""),
      await v.state.set("model", $));
  let J = (await v.state.get("cursor")) ?? "",
    j = await v.vault.read({
      entity: "core.content_derivative",
      where: [
        { column: "derivative_id", op: "gt", value: J },
        { column: "variant", op: "in", value: ["text", "transcript"] },
      ],
      orderBy: { column: "derivative_id", dir: "asc" },
      limit: P,
      purpose: H,
    }),
    X = 0,
    V = 0;
  for (let Q of j.rows ?? []) {
    let W = await v.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: Q.content_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: H,
    });
    if (p(W.rows?.[0], $, Q.derivative_id)) {
      V += 1;
      continue;
    }
    let _ = await v.vault.content({
      contentId: Q.content_id,
      variant: Q.variant,
      maxBytes: 1048576,
      purpose: H,
    });
    if (_?.status !== "ok" || _.kind !== "text")
      throw Error(`content ${Q.content_id}: ${Q.variant} text is unavailable`);
    let Y = await z({ id: Q.content_id, text: _.text });
    if (!Y || Y.error || !Array.isArray(Y.vector)) {
      ((V += 1), B.info(`content ${Q.content_id}: no text vector`));
      continue;
    }
    (await v.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "core.content_item",
        entity_id: Q.content_id,
        model: $,
        vector: Y.vector,
        capability: "embed-text",
        source_version: Q.derivative_id,
      },
      purpose: H,
    }),
      (X += 1));
  }
  let K = j.rows?.at(-1)?.derivative_id;
  if (K) await v.state.set("cursor", K);
  return {
    summary: `embedded ${X} texts; skipped ${V}; bounded batch ${j.rows?.length ?? 0}/${P}`,
    output: {
      derived: X,
      skipped: V,
      model: $,
      rearm: (j.rows?.length ?? 0) === P,
    },
  };
}
export { xv as setEmbedTextRuntimeForTests, Zv as default };
