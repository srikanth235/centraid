// Generated recognition automation. Source: tools/recognition-automations/automation-handlers.
import { existsSync as $v } from "node:fs";
import { readFile as x } from "node:fs/promises";
import H from "node:path";
import U from "node:path";
var h = U.resolve(import.meta.dirname, ".."),
  C = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? U.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : U.join(h, "runtime"),
  y = U.join(C, "models");
import { existsSync as T } from "node:fs";
import { createRequire as n } from "node:module";
import k from "node:path";
import { pathToFileURL as d } from "node:url";
var _;
class M extends Error {
  constructor(v, B) {
    super(
      `Automation model runtime dependency "${v}" is not installed. ` +
        'Run "bun run --cwd tools/recognition-automations setup" first — it installs ' +
        "optional native recognition dependencies into tools/recognition-automations/runtime/ and downloads the model weights those capabilities need.",
      { cause: B }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function E(v, B = C) {
  if (!T(k.join(B, "node_modules"))) throw new M(v);
  let $ = n(k.join(B, "package.json"));
  try {
    return $.resolve(v);
  } catch (Q) {
    throw new M(v, Q);
  }
}
async function f() {
  if (_) return _;
  let v = E("onnxruntime-node");
  return ((_ = await import(d(v).href)), _);
}
var A;
async function I(v) {
  A ??= new Map();
  let B = A.get(v);
  if (B) return B;
  if (!T(v)) throw new M(v);
  let $ = f().then((Q) => Q.InferenceSession.create(v));
  A.set(v, $);
  try {
    return await $;
  } catch (Q) {
    throw (A.delete(v), Q);
  }
}
function o() {
  let v = [];
  for (let q = "!".codePointAt(0); q <= "~".codePointAt(0); q++) v.push(q);
  for (let q = "¡".codePointAt(0); q <= "¬".codePointAt(0); q++) v.push(q);
  for (let q = "®".codePointAt(0); q <= "ÿ".codePointAt(0); q++) v.push(q);
  let B = [...v],
    $ = 0;
  for (let q = 0; q < 256; q++)
    if (!v.includes(q)) (v.push(q), B.push(256 + $), $++);
  let Q = new Map();
  for (let q = 0; q < v.length; q++) Q.set(v[q], String.fromCodePoint(B[q]));
  return Q;
}
function t(v) {
  let B = new Map();
  return (
    v.forEach(([$, Q], q) => {
      B.set(`${$} ${Q}`, q);
    }),
    B
  );
}
function s(v, B) {
  if (v.length === 0) return [];
  if (v.length === 1) return [`${v}</w>`];
  let $ = [...v.slice(0, -1), `${v.at(-1)}</w>`];
  for (;;) {
    let Q,
      q = Number.POSITIVE_INFINITY;
    for (let Y = 0; Y < $.length - 1; Y++) {
      let Z = $[Y],
        K = $[Y + 1],
        J = B.get(`${Z} ${K}`);
      if (J !== void 0 && J < q) ((q = J), (Q = [Z, K]));
    }
    if (!Q) break;
    let [X, j] = Q,
      V = [],
      W = 0;
    while (W < $.length)
      if ($[W] === X && $[W + 1] === j) (V.push(X + j), (W += 2));
      else (V.push($[W]), (W += 1));
    $ = V;
  }
  return $;
}
var i =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;
function a(v) {
  return v.trim().replace(/\s+/gu, " ").toLowerCase();
}
function e(v) {
  return a(v).match(i) ?? [];
}
var vv = 77;
function S(v) {
  let B = o(),
    $ = t(v.merges),
    Q = new Map(),
    q = v.vocab.get("<|startoftext|>"),
    X = v.vocab.get("<|endoftext|>");
  if (q === void 0 || X === void 0)
    throw Error(
      "createClipTokenizer: vocab is missing <|startoftext|> or <|endoftext|>"
    );
  let j = q,
    V = X;
  function W(K) {
    let J = new TextEncoder().encode(K),
      w = "";
    for (let G of J) w += B.get(G) ?? "";
    return w;
  }
  function Y(K) {
    let J = Q.get(K);
    if (J) return J;
    let w = s(K, $);
    return (Q.set(K, w), w);
  }
  function Z(K, J = vv) {
    let w = e(K),
      G = [];
    for (let c of w) {
      let l = W(c);
      for (let r of Y(l)) {
        let R = v.vocab.get(r);
        if (R !== void 0) G.push(R);
      }
    }
    let p = J - 2,
      m = G.slice(0, Math.max(0, p)),
      O = [j, ...m, V];
    while (O.length < J) O.push(0);
    return O;
  }
  return { encode: Z };
}
var b = "clip-vit-b-32@1",
  D = H.join(y, "clip"),
  Tv = H.join(D, "visual.onnx"),
  qv = H.join(D, "textual.onnx"),
  Bv = H.join(D, "vocab.json"),
  Qv = H.join(D, "merges.txt");
var Yv = 77;
function L(v = y) {
  let B = H.join(v, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    ($) => $v(H.join(B, $))
  );
}
function Jv(v) {
  let B = [];
  for (let $ of v.split(`
`)) {
    let Q = $.trim();
    if (!Q || Q.startsWith("#")) continue;
    let q = Q.split(" ");
    if (q.length === 2) B.push([q[0], q[1]]);
  }
  return B;
}
var u;
async function Kv() {
  if (u) return u;
  let [v, B] = await Promise.all([x(Bv, "utf8"), x(Qv, "utf8")]),
    $ = JSON.parse(v);
  return ((u = S({ vocab: new Map(Object.entries($)), merges: Jv(B) })), u);
}
function Wv(v) {
  let B = 0;
  for (let Q of v) B += Q * Q;
  let $ = Math.sqrt(B);
  if ($ === 0) return Array.from(v);
  return Array.from(v, (Q) => Q / $);
}
function Vv(v, B) {
  let $ = B[0],
    Q = $ ? v[$] : void 0;
  if (!Q || !(Q.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return Q.data;
}
async function N(v) {
  try {
    let $ = (await Kv()).encode(v.text, Yv),
      Q = await f(),
      q = await I(qv),
      j = {
        [q.inputNames[0] ?? "input_ids"]: new Q.Tensor(
          "int64",
          BigInt64Array.from($.map(BigInt)),
          [1, $.length]
        ),
      },
      V = await q.run(j),
      W = Wv(Vv(V, q.outputNames));
    return { id: v.id, vector: W };
  } catch (B) {
    return { id: v.id, error: B instanceof Error ? B.message : String(B) };
  }
}
var P = 16,
  F = "dpv:ServiceProvision",
  z = N,
  g = L;
function Sv(v) {
  ((z = v?.infer ?? N), (g = v?.weightsPresent ?? L));
}
function Xv() {
  return g() ? b : null;
}
async function Zv(v, B) {
  let Q = (
    await v.vault.read({
      entity: "core.content_derivative",
      where: [{ column: "variant", op: "in", value: ["text", "transcript"] }],
      orderBy: { column: "derivative_id", dir: "desc" },
      limit: 1,
      purpose: F,
    })
  ).rows?.[0];
  if (!Q) return "";
  return (
    await v.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: Q.content_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
      purpose: F,
    })
  ).rows?.[0]?.model === B
    ? Q.derivative_id
    : "";
}
async function jv({ ctx: v, log: B }) {
  let $ = Xv();
  if (!$)
    return { summary: "text embedding skipped — model assets unavailable" };
  if (typeof v.input?.query === "string") {
    let Y = v.input.query.trim();
    if (!Y) throw Error("text embedding query is empty");
    let Z = await z({ id: "query", text: Y });
    if (!Z || Z.error || !Array.isArray(Z.vector))
      throw Error(Z?.error ?? "text embedding returned no vector");
    return {
      summary: "embedded one search query",
      output: { model: $, vector: Z.vector },
    };
  }
  let Q = await v.state.get("model");
  if (Q !== $)
    (await v.state.set("cursor", Q === void 0 ? await Zv(v, $) : ""),
      await v.state.set("model", $));
  let q = (await v.state.get("cursor")) ?? "",
    X = await v.vault.read({
      entity: "core.content_derivative",
      where: [
        { column: "derivative_id", op: "gt", value: q },
        { column: "variant", op: "in", value: ["text", "transcript"] },
      ],
      orderBy: { column: "derivative_id", dir: "asc" },
      limit: P,
      purpose: F,
    }),
    j = 0,
    V = 0;
  for (let Y of X.rows ?? []) {
    if (
      (
        await v.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: Y.content_id },
            { column: "variant", op: "eq", value: "embedding" },
          ],
          limit: 1,
          purpose: F,
        })
      ).rows?.[0]?.model === $
    ) {
      V += 1;
      continue;
    }
    let K = await v.vault.content({
      contentId: Y.content_id,
      variant: Y.variant,
      maxBytes: 1048576,
      purpose: F,
    });
    if (K?.status !== "ok" || K.kind !== "text")
      throw Error(`content ${Y.content_id}: ${Y.variant} text is unavailable`);
    let J = await z({ id: Y.content_id, text: K.text });
    if (!J || J.error || !Array.isArray(J.vector)) {
      ((V += 1), B.info(`content ${Y.content_id}: no text vector`));
      continue;
    }
    (await v.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "core.content_item",
        entity_id: Y.content_id,
        model: $,
        vector: J.vector,
        capability: "embed-text",
      },
      purpose: F,
    }),
      (j += 1));
  }
  let W = X.rows?.at(-1)?.derivative_id;
  if (W) await v.state.set("cursor", W);
  return {
    summary: `embedded ${j} texts; skipped ${V}; bounded batch ${X.rows?.length ?? 0}/${P}`,
    output: {
      derived: j,
      skipped: V,
      model: $,
      rearm: (X.rows?.length ?? 0) === P,
    },
  };
}
export { Sv as setEmbedTextRuntimeForTests, jv as default };
