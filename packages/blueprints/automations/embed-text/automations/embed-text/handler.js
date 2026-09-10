// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { existsSync as jQ } from "node:fs";
import { readFile as h } from "node:fs/promises";
import F from "node:path";
import A from "node:path";
var i = A.resolve(import.meta.dirname, ".."),
  a = "__centraidAutomationRuntimeDir";
function t() {
  let Q = globalThis[a];
  if (typeof Q === "string" && Q.length > 0) return A.resolve(Q);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return A.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return A.join(i, "runtime");
}
var P = t(),
  _ = A.join(P, "models");
import { existsSync as R, readFileSync as e, statSync as QQ } from "node:fs";
import O from "node:path";
import { pathToFileURL as $Q } from "node:url";
var M;
class C extends Error {
  constructor(Q, $) {
    super(
      `Automation model runtime dependency "${Q}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: $ }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function b(Q, $ = P) {
  let J = O.join($, "node_modules");
  if (!R(J)) throw new C(Q);
  let K = O.join(J, ...Q.split("/"));
  try {
    let Y = x(K);
    if (Y === null) throw Error(`no entry point in ${K}`);
    return Y;
  } catch (Y) {
    throw new C(Q, Y);
  }
}
function x(Q, $ = 0) {
  let J = O.join(Q, "package.json"),
    K = R(J) ? JSON.parse(e(J, "utf8")) : {},
    Y = [
      ...v(YQ(K.exports)),
      ...(typeof K.main === "string" ? [K.main] : []),
      "index.js",
    ];
  for (let j of Y) {
    let V = JQ(O.resolve(Q, j), $);
    if (V !== null) return V;
  }
  return null;
}
function JQ(Q, $) {
  let J = S(Q);
  if (J?.isFile()) return Q;
  if (J?.isDirectory()) return $ >= 4 ? null : x(Q, $ + 1);
  for (let K of [".js", ".json", ".node"]) {
    let Y = `${Q}${K}`;
    if (S(Y)?.isFile()) return Y;
  }
  return null;
}
function S(Q) {
  try {
    return QQ(Q);
  } catch {
    return null;
  }
}
function YQ(Q) {
  if (typeof Q === "string") return Q;
  if (Q === null || typeof Q !== "object") return;
  let $ = Q;
  return "." in $ ? $["."] : $;
}
function v(Q, $ = 0) {
  if (typeof Q === "string") return [Q];
  if ($ > 8 || Q === null || typeof Q !== "object") return [];
  if (Array.isArray(Q)) return Q.flatMap((Y) => v(Y, $ + 1));
  let J = Q,
    K = [];
  for (let Y of ["require", "node", "default"])
    if (Y in J) K.push(...v(J[Y], $ + 1));
  return K;
}
async function I() {
  if (M) return M;
  let Q = b("onnxruntime-node");
  return ((M = await import($Q(Q).href)), M);
}
var L;
async function g(Q) {
  L ??= new Map();
  let $ = L.get(Q);
  if ($) return $;
  if (!R(Q)) throw new C(Q);
  let J = I().then((K) => K.InferenceSession.create(Q));
  L.set(Q, J);
  try {
    return await J;
  } catch (K) {
    throw (L.delete(Q), K);
  }
}
function KQ() {
  let Q = [];
  for (let Y = "!".codePointAt(0); Y <= "~".codePointAt(0); Y++) Q.push(Y);
  for (let Y = "¡".codePointAt(0); Y <= "¬".codePointAt(0); Y++) Q.push(Y);
  for (let Y = "®".codePointAt(0); Y <= "ÿ".codePointAt(0); Y++) Q.push(Y);
  let $ = [...Q],
    J = 0;
  for (let Y = 0; Y < 256; Y++)
    if (!Q.includes(Y)) (Q.push(Y), $.push(256 + J), J++);
  let K = new Map();
  for (let Y = 0; Y < Q.length; Y++) K.set(Q[Y], String.fromCodePoint($[Y]));
  return K;
}
function qQ(Q) {
  let $ = new Map();
  return (
    Q.forEach(([J, K], Y) => {
      $.set(`${J} ${K}`, Y);
    }),
    $
  );
}
function WQ(Q, $) {
  if (Q.length === 0) return [];
  if (Q.length === 1) return [`${Q}</w>`];
  let J = [...Q.slice(0, -1), `${Q.at(-1)}</w>`];
  for (;;) {
    let K,
      Y = Number.POSITIVE_INFINITY;
    for (let B = 0; B < J.length - 1; B++) {
      let U = J[B],
        q = J[B + 1],
        W = $.get(`${U} ${q}`);
      if (W !== void 0 && W < Y) ((Y = W), (K = [U, q]));
    }
    if (!K) break;
    let [j, V] = K,
      X = [],
      Z = 0;
    while (Z < J.length)
      if (J[Z] === j && J[Z + 1] === V) (X.push(j + V), (Z += 2));
      else (X.push(J[Z]), (Z += 1));
    J = X;
  }
  return J;
}
var ZQ =
  /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|\p{L}+|\p{N}|[^\s\p{L}\p{N}]+/gu;
function VQ(Q) {
  return Q.trim().replace(/\s+/gu, " ").toLowerCase();
}
function XQ(Q) {
  return VQ(Q).match(ZQ) ?? [];
}
var BQ = 77;
function u(Q) {
  let $ = KQ(),
    J = qQ(Q.merges),
    K = new Map(),
    Y = Q.vocab.get("<|startoftext|>"),
    j = Q.vocab.get("<|endoftext|>");
  if (Y === void 0 || j === void 0)
    throw Error(
      "createClipTokenizer: vocab is missing <|startoftext|> or <|endoftext|>"
    );
  let V = Y,
    X = j;
  function Z(q) {
    let W = new TextEncoder().encode(q),
      G = "";
    for (let H of W) G += $.get(H) ?? "";
    return G;
  }
  function B(q) {
    let W = K.get(q);
    if (W) return W;
    let G = WQ(q, J);
    return (K.set(q, G), G);
  }
  function U(q, W = BQ) {
    let G = XQ(q),
      H = [];
    for (let n of G) {
      let o = Z(n);
      for (let r of B(o)) {
        let y = Q.vocab.get(r);
        if (y !== void 0) H.push(y);
      }
    }
    let k = W - 2,
      s = H.slice(0, Math.max(0, k)),
      D = [V, ...s, X];
    while (D.length < W) D.push(0);
    return D;
  }
  return { encode: U };
}
var m = "clip-vit-b-32@1",
  z = F.join(_, "clip"),
  cQ = F.join(z, "visual.onnx"),
  GQ = F.join(z, "textual.onnx"),
  UQ = F.join(z, "vocab.json"),
  HQ = F.join(z, "merges.txt");
var FQ = 77;
function w(Q = _) {
  let $ = F.join(Q, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (J) => jQ(F.join($, J))
  );
}
function AQ(Q) {
  let $ = [];
  for (let J of Q.split(`
`)) {
    let K = J.trim();
    if (!K || K.startsWith("#")) continue;
    let Y = K.split(" ");
    if (Y.length === 2) $.push([Y[0], Y[1]]);
  }
  return $;
}
var N;
async function MQ() {
  if (N) return N;
  let [Q, $] = await Promise.all([h(UQ, "utf8"), h(HQ, "utf8")]),
    J = JSON.parse(Q);
  return ((N = u({ vocab: new Map(Object.entries(J)), merges: AQ($) })), N);
}
function LQ(Q) {
  let $ = 0;
  for (let K of Q) $ += K * K;
  let J = Math.sqrt($);
  if (J === 0) return Array.from(Q);
  return Array.from(Q, (K) => K / J);
}
function OQ(Q, $) {
  let J = $[0],
    K = J ? Q[J] : void 0;
  if (!K || !(K.data instanceof Float32Array))
    throw Error("embed: expected a float32 tensor as the model's first output");
  return K.data;
}
async function T(Q) {
  try {
    let J = (await MQ()).encode(Q.text, FQ),
      K = await I(),
      Y = await g(GQ),
      V = {
        [Y.inputNames[0] ?? "input_ids"]: new K.Tensor(
          "int64",
          BigInt64Array.from(J.map(BigInt)),
          [1, J.length]
        ),
      },
      X = await Y.run(V),
      Z = LQ(OQ(X, Y.outputNames));
    return { id: Q.id, vector: Z };
  } catch ($) {
    return { id: Q.id, error: $ instanceof Error ? $.message : String($) };
  }
}
var c = 12;
async function p(Q, $) {
  try {
    let J = await Q.vault.invoke({
        command: "enrich.record_target_failure",
        input: {
          capability: $.capability,
          target_type: $.targetType,
          target_id: $.targetId,
          ...($.error === void 0
            ? {}
            : { error: String($.error).slice(0, 2000) }),
          ...($.reason === void 0 ? {} : { reason: $.reason }),
          ...($.permanent === void 0 ? {} : { permanent: $.permanent }),
          ...($.maxFailures === void 0 ? {} : { max_failures: $.maxFailures }),
        },
      }),
      K = J?.output ?? J;
    return { failures: Number(K?.failures ?? 0), declined: K?.declined === !0 };
  } catch {
    return { failures: 0, declined: !1 };
  }
}
var f = 16,
  E = T,
  l = w;
function nQ(Q) {
  ((E = Q?.infer ?? T), (l = Q?.weightsPresent ?? w));
}
function CQ() {
  return l() ? m : null;
}
function d(Q, $, J) {
  let K =
    typeof Q?.payload_json === "string"
      ? JSON.parse(Q.payload_json).source_version
      : Q?.source_version;
  return Q?.model === $ && K === J;
}
async function NQ(Q, $) {
  let K = (
    await Q.vault.read({
      entity: "core.content_derivative",
      where: [{ column: "variant", op: "in", value: ["text", "transcript"] }],
      orderBy: { column: "derivative_id", dir: "desc" },
      limit: 1,
    })
  ).rows?.[0];
  if (!K) return "";
  let Y = await Q.vault.read({
    entity: "enrich.derivation",
    where: [
      { column: "target_id", op: "eq", value: K.content_id },
      { column: "variant", op: "eq", value: "embedding" },
    ],
    limit: 1,
  });
  return d(Y.rows?.[0], $, K.derivative_id) ? K.derivative_id : "";
}
async function zQ({ ctx: Q, log: $ }) {
  let J = CQ();
  if (!J)
    return { summary: "text embedding skipped — model assets unavailable" };
  if (typeof Q.input?.query === "string") {
    let q = Q.input.query.trim();
    if (!q) throw Error("text embedding query is empty");
    let W = await E({ id: "query", text: q });
    if (!W || W.error || !Array.isArray(W.vector))
      throw Error(W?.error ?? "text embedding returned no vector");
    return {
      summary: "embedded one search query",
      output: { model: J, vector: W.vector },
    };
  }
  let K = await Q.state.get("model");
  if (K !== J)
    (await Q.state.set("cursor", K === void 0 ? await NQ(Q, J) : ""),
      await Q.state.set("model", J));
  let Y = (await Q.state.get("cursor")) ?? "",
    j = await Q.vault.read({
      entity: "core.content_derivative",
      where: [
        { column: "derivative_id", op: "gt", value: Y },
        { column: "variant", op: "in", value: ["text", "transcript"] },
      ],
      orderBy: { column: "derivative_id", dir: "asc" },
      limit: f,
    }),
    V = 0,
    X = 0,
    Z = 0,
    B = "",
    U = !1;
  for (let q of j.rows ?? []) {
    let W = await Q.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: q.content_id },
        { column: "variant", op: "eq", value: "embedding" },
      ],
      limit: 1,
    });
    if (d(W.rows?.[0], J, q.derivative_id)) {
      if (((X += 1), !U)) B = q.derivative_id;
      continue;
    }
    let G = await Q.vault.content({
      contentId: q.content_id,
      variant: q.variant,
      maxBytes: 1048576,
    });
    if (G?.status !== "ok" || G.kind !== "text") {
      if (
        (
          await p(Q, {
            capability: "embed-text",
            targetType: "core.content_item",
            targetId: q.content_id,
            reason: "no-text",
            error: `${q.variant} text is unavailable`,
            maxFailures: c,
          })
        ).declined
      ) {
        if (((X += 1), !U)) B = q.derivative_id;
        $.info(`content ${q.content_id}: ${q.variant} text never landed`);
      } else
        ((Z += 1),
          (U = !0),
          $.info(`content ${q.content_id}: ${q.variant} text is unavailable`));
      continue;
    }
    let H = await E({ id: q.content_id, text: G.text });
    if (!H || H.error || !Array.isArray(H.vector)) {
      if (((X += 1), !U)) B = q.derivative_id;
      $.info(`content ${q.content_id}: no text vector`);
      continue;
    }
    if (
      (await Q.vault.invoke({
        command: "enrich.upsert_embedding",
        input: {
          entity_type: "core.content_item",
          entity_id: q.content_id,
          model: J,
          vector: H.vector,
          capability: "embed-text",
          source_version: q.derivative_id,
        },
      }),
      (V += 1),
      !U)
    )
      B = q.derivative_id;
  }
  if (B) await Q.state.set("cursor", B);
  return {
    summary: `embedded ${V} texts; skipped ${X}; not ready ${Z}; bounded batch ${j.rows?.length ?? 0}/${f}`,
    output: {
      derived: V,
      skipped: X,
      notReady: Z,
      model: J,
      rearm: (j.rows?.length ?? 0) === f,
    },
  };
}
export { nQ as setEmbedTextRuntimeForTests, zQ as default };
