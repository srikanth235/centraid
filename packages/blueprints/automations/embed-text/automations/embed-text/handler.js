// Generated recognition automation. Source: tools/recognition-automations/automation-handlers.
import { existsSync as qv } from "node:fs";
import { readFile as x } from "node:fs/promises";
import F from "node:path";
import w from "node:path";
var h = w.resolve(import.meta.dirname, ".."),
  C = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? w.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : w.join(h, "runtime"),
  y = w.join(C, "models");
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
  let q = n(k.join(B, "package.json"));
  try {
    return q.resolve(v);
  } catch (Q) {
    throw new M(v, Q);
  }
}
async function L() {
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
  let q = L().then((Q) => Q.InferenceSession.create(v));
  A.set(v, q);
  try {
    return await q;
  } catch (Q) {
    throw (A.delete(v), Q);
  }
}
function o() {
  let v = [];
  for (let $ = "!".codePointAt(0); $ <= "~".codePointAt(0); $++) v.push($);
  for (let $ = "¡".codePointAt(0); $ <= "¬".codePointAt(0); $++) v.push($);
  for (let $ = "®".codePointAt(0); $ <= "ÿ".codePointAt(0); $++) v.push($);
  let B = [...v],
    q = 0;
  for (let $ = 0; $ < 256; $++)
    if (!v.includes($)) (v.push($), B.push(256 + q), q++);
  let Q = new Map();
  for (let $ = 0; $ < v.length; $++) Q.set(v[$], String.fromCodePoint(B[$]));
  return Q;
}
function s(v) {
  let B = new Map();
  return (
    v.forEach(([q, Q], $) => {
      B.set(`${q} ${Q}`, $);
    }),
    B
  );
}
function t(v, B) {
  if (v.length === 0) return [];
  if (v.length === 1) return [`${v}</w>`];
  let q = [...v.slice(0, -1), `${v.at(-1)}</w>`];
  for (;;) {
    let Q,
      $ = Number.POSITIVE_INFINITY;
    for (let Y = 0; Y < q.length - 1; Y++) {
      let Z = q[Y],
        K = q[Y + 1],
        J = B.get(`${Z} ${K}`);
      if (J !== void 0 && J < $) (($ = J), (Q = [Z, K]));
    }
    if (!Q) break;
    let [X, j] = Q,
      V = [],
      W = 0;
    while (W < q.length)
      if (q[W] === X && q[W + 1] === j) (V.push(X + j), (W += 2));
      else (V.push(q[W]), (W += 1));
    q = V;
  }
  return q;
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
    q = s(v.merges),
    Q = new Map(),
    $ = v.vocab.get("<|startoftext|>"),
    X = v.vocab.get("<|endoftext|>");
  if ($ === void 0 || X === void 0)
    throw Error(
      "createClipTokenizer: vocab is missing <|startoftext|> or <|endoftext|>"
    );
  let j = $,
    V = X;
  function W(K) {
    let J = new TextEncoder().encode(K),
      H = "";
    for (let U of J) H += B.get(U) ?? "";
    return H;
  }
  function Y(K) {
    let J = Q.get(K);
    if (J) return J;
    let H = t(K, q);
    return (Q.set(K, H), H);
  }
  function Z(K, J = vv) {
    let H = e(K),
      U = [];
    for (let c of H) {
      let l = W(c);
      for (let r of Y(l)) {
        let R = v.vocab.get(r);
        if (R !== void 0) U.push(R);
      }
    }
    let p = J - 2,
      m = U.slice(0, Math.max(0, p)),
      O = [j, ...m, V];
    while (O.length < J) O.push(0);
    return O;
  }
  return { encode: Z };
}
var b = "clip-vit-b-32@1",
  D = F.join(y, "clip"),
  Tv = F.join(D, "visual.onnx"),
  $v = F.join(D, "textual.onnx"),
  Bv = F.join(D, "vocab.json"),
  Qv = F.join(D, "merges.txt");
var Yv = 77;
function f(v = y) {
  let B = F.join(v, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (q) => qv(F.join(B, q))
  );
}
function Jv(v) {
  let B = [];
  for (let q of v.split(`
`)) {
    let Q = q.trim();
    if (!Q || Q.startsWith("#")) continue;
    let $ = Q.split(" ");
    if ($.length === 2) B.push([$[0], $[1]]);
  }
  return B;
}
var u;
async function Kv() {
  if (u) return u;
  let [v, B] = await Promise.all([x(Bv, "utf8"), x(Qv, "utf8")]),
    q = JSON.parse(v);
  return ((u = S({ vocab: new Map(Object.entries(q)), merges: Jv(B) })), u);
}
function Wv(v) {
  let B = 0;
  for (let Q of v) B += Q * Q;
  let q = Math.sqrt(B);
  if (q === 0) return Array.from(v);
  return Array.from(v, (Q) => Q / q);
}
function Vv(v, B) {
  let q = B[0],
    Q = q ? v[q] : void 0;
  if (!Q || !(Q.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return Q.data;
}
async function N(v) {
  try {
    let q = (await Kv()).encode(v.text, Yv),
      Q = await L(),
      $ = await I($v),
      j = {
        [$.inputNames[0] ?? "input_ids"]: new Q.Tensor(
          "int64",
          BigInt64Array.from(q.map(BigInt)),
          [1, q.length]
        ),
      },
      V = await $.run(j),
      W = Wv(Vv(V, $.outputNames));
    return { id: v.id, vector: W };
  } catch (B) {
    return { id: v.id, error: B instanceof Error ? B.message : String(B) };
  }
}
var P = 16,
  G = "dpv:ServiceProvision",
  z = N,
  g = f;
function Sv(v) {
  ((z = v?.infer ?? N), (g = v?.weightsPresent ?? f));
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
      purpose: G,
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
      purpose: G,
    })
  ).rows?.[0]?.model === B
    ? Q.derivative_id
    : "";
}
async function jv({ ctx: v, log: B }) {
  let q = Xv();
  if (!q)
    return { summary: "text embedding skipped — model assets unavailable" };
  if (typeof v.input?.query === "string") {
    let Y = v.input.query.trim();
    if (!Y) throw Error("text embedding query is empty");
    let Z = await z({ id: "query", text: Y });
    if (!Z || Z.error || !Array.isArray(Z.vector))
      throw Error(Z?.error ?? "text embedding returned no vector");
    return {
      summary: "embedded one search query",
      output: { model: q, vector: Z.vector },
    };
  }
  let Q = await v.state.get("model");
  if (Q !== q)
    (await v.state.set("cursor", Q === void 0 ? await Zv(v, q) : ""),
      await v.state.set("model", q));
  let $ = (await v.state.get("cursor")) ?? "",
    X = await v.vault.read({
      entity: "core.content_derivative",
      where: [
        { column: "derivative_id", op: "gt", value: $ },
        { column: "variant", op: "in", value: ["text", "transcript"] },
      ],
      orderBy: { column: "derivative_id", dir: "asc" },
      limit: P,
      purpose: G,
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
          purpose: G,
        })
      ).rows?.[0]?.model === q
    ) {
      V += 1;
      continue;
    }
    let K = await v.vault.content({
        contentId: Y.content_id,
        variant: Y.variant,
        maxBytes: 1048576,
        purpose: G,
      }),
      J =
        K?.status === "ok" && K.kind === "text"
          ? await z({ id: Y.content_id, text: K.text })
          : null;
    if (!J || J.error || !Array.isArray(J.vector)) {
      ((V += 1), B.info(`content ${Y.content_id}: no text vector`));
      continue;
    }
    (await v.vault.invoke({
      command: "enrich.upsert_embedding",
      input: {
        entity_type: "core.content_item",
        entity_id: Y.content_id,
        model: q,
        vector: J.vector,
        capability: "embed-text",
      },
      purpose: G,
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
      model: q,
      rearm: (X.rows?.length ?? 0) === P,
    },
  };
}
export { Sv as setEmbedTextRuntimeForTests, jv as default };
