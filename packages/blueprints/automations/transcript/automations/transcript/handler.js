// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { spawnSync as u } from "node:child_process";
import { existsSync as p } from "node:fs";
import L from "node:path";
import j from "node:path";
import { pathToFileURL as F } from "node:url";
var b = j.resolve(import.meta.dirname, ".."),
  f = "__centraidAutomationRuntimeDir";
function T() {
  let z = globalThis[f];
  if (typeof z === "string" && z.length > 0) return j.resolve(z);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return j.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return j.join(b, "runtime");
}
var w = T(),
  X = j.join(w, "models");
import { existsSync as _, readFileSync as x, statSync as g } from "node:fs";
import B from "node:path";
class C extends Error {
  constructor(z, G) {
    super(
      `Automation model runtime dependency "${z}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: G }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function A(z, G = w) {
  let J = B.join(G, "node_modules");
  if (!_(J)) throw new C(z);
  let K = B.join(J, ...z.split("/"));
  try {
    let V = P(K);
    if (V === null) throw Error(`no entry point in ${K}`);
    return V;
  } catch (V) {
    throw new C(z, V);
  }
}
function P(z, G = 0) {
  let J = B.join(z, "package.json"),
    K = _(J) ? JSON.parse(x(J, "utf8")) : {},
    V = [
      ...k(m(K.exports)),
      ...(typeof K.main === "string" ? [K.main] : []),
      "index.js",
    ];
  for (let $ of V) {
    let q = h(B.resolve(z, $), G);
    if (q !== null) return q;
  }
  return null;
}
function h(z, G) {
  let J = I(z);
  if (J?.isFile()) return z;
  if (J?.isDirectory()) return G >= 4 ? null : P(z, G + 1);
  for (let K of [".js", ".json", ".node"]) {
    let V = `${z}${K}`;
    if (I(V)?.isFile()) return V;
  }
  return null;
}
function I(z) {
  try {
    return g(z);
  } catch {
    return null;
  }
}
function m(z) {
  if (typeof z === "string") return z;
  if (z === null || typeof z !== "object") return;
  let G = z;
  return "." in G ? G["."] : G;
}
function k(z, G = 0) {
  if (typeof z === "string") return [z];
  if (G > 8 || z === null || typeof z !== "object") return [];
  if (Array.isArray(z)) return z.flatMap((V) => k(V, G + 1));
  let J = z,
    K = [];
  for (let V of ["require", "node", "default"])
    if (V in J) K.push(...k(J[V], G + 1));
  return K;
}
var y = "whisper-tiny.en-q8@1",
  l = L.join(X, "transcript"),
  E = 600,
  d = E * 16000 * Float32Array.BYTES_PER_ELEMENT,
  c = [
    "added_tokens.json",
    "config.json",
    "generation_config.json",
    "merges.txt",
    "normalizer.json",
    "preprocessor_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "onnx/encoder_model_quantized.onnx",
    "onnx/decoder_model_merged_quantized.onnx",
  ],
  H,
  n = a,
  o = (z, G, J) => u(z, G, J),
  i = e;
function U(z = X) {
  let G = L.join(z, "transcript");
  return c.every((J) => p(L.join(G, J)));
}
function s(z) {
  if (!z.startsWith("audio/") && !z.startsWith("video/"))
    throw Error(`transcript: unsupported media type ${z}`);
}
async function a() {
  let z = A("@ffmpeg-installer/ffmpeg"),
    G = await import(F(z).href),
    J = G.default?.path ?? G.path;
  if (typeof J !== "string" || !J)
    throw Error("transcript: the bundled FFmpeg executable is unavailable");
  return J;
}
async function r(z) {
  let G = await n(),
    J = o(
      G,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-t",
        String(E),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { input: z, maxBuffer: d + 1048576 }
    );
  if (J.status !== 0) {
    let K = J.stderr?.toString("utf8").trim();
    throw Error(`transcript: FFmpeg decode failed${K ? `: ${K}` : ""}`);
  }
  if (!J.stdout?.length) throw Error("transcript: decoded audio is empty");
  if (J.stdout.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0)
    throw Error("transcript: FFmpeg returned an unaligned PCM stream");
  return new Float32Array(
    J.stdout.buffer,
    J.stdout.byteOffset,
    J.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}
async function t() {
  if (H) return H;
  H = i();
  try {
    return await H;
  } catch (z) {
    throw ((H = void 0), z);
  }
}
async function e() {
  let z = A("@huggingface/transformers"),
    G = await import(F(z).href);
  return (
    (G.env.allowLocalModels = !0),
    (G.env.allowRemoteModels = !1),
    (G.env.localModelPath = X),
    (G.env.useBrowserCache = !1),
    G.pipeline("automatic-speech-recognition", l, {
      dtype: "q8",
      device: "cpu",
    })
  );
}
function zz(z) {
  let G = Array.isArray(z)
    ? z
        .map((J) => (typeof J.text === "string" ? J.text.trim() : ""))
        .filter(Boolean)
        .join(" ")
    : z.text;
  return typeof G === "string" ? G.trim() : "";
}
async function N(z) {
  try {
    s(z.mediaType);
    let G = await r(Buffer.from(z.bytes, "base64")),
      K = await (
        await t()
      )(G, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: !1 });
    return { id: z.id, text: zz(K) };
  } catch (G) {
    return { id: z.id, error: G instanceof Error ? G.message : String(G) };
  }
}
var v = 2,
  S = 67108864,
  R = N,
  D = U;
function Lz(z) {
  ((R = z?.transcribe ?? N), (D = z?.weightsPresent ?? U));
}
function Gz() {
  return D() ? y : null;
}
async function Jz(z, G) {
  let K = (
    await z.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["audio", "video"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
    })
  ).rows?.[0];
  if (!K) return "";
  return (
    await z.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: K.content_id },
        { column: "variant", op: "eq", value: "transcript" },
      ],
      limit: 1,
    })
  ).rows?.[0]?.model === G
    ? K.asset_id
    : "";
}
async function Kz({ ctx: z, log: G }) {
  let J = Gz();
  if (!J)
    return {
      summary: "transcript skipped — automation model assets unavailable",
    };
  let K = await z.state.get("model");
  if (K !== J)
    (await z.state.set("cursor", K === void 0 ? await Jz(z, J) : ""),
      await z.state.set("model", J));
  let V = (await z.state.get("cursor")) ?? "",
    $ = await z.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: V },
        { column: "kind", op: "in", value: ["audio", "video"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: v,
    }),
    q = 0,
    Q = 0;
  for (let Z of $.rows ?? []) {
    if (
      (
        await z.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: Z.content_id },
            { column: "variant", op: "eq", value: "transcript" },
          ],
          limit: 1,
        })
      ).rows?.[0]?.model === J
    ) {
      Q += 1;
      continue;
    }
    let W = await z.vault.content({
      contentId: Z.content_id,
      variant: "original",
      maxBytes: S,
    });
    if (W?.status === "too-large") {
      ((Q += 1),
        G.info(
          `asset ${Z.asset_id}: original exceeds the ${S}-byte transcription ceiling`
        ));
      continue;
    }
    if (W?.status !== "ok" || W.kind !== "bytes")
      throw Error(`asset ${Z.asset_id}: bounded original is unavailable`);
    let Y = await R({
      id: Z.content_id,
      bytes: W.base64,
      mediaType: W.mediaType,
    });
    if (!Y || Y.error)
      throw Error(Y?.error ?? `asset ${Z.asset_id}: ASR returned no result`);
    let O = typeof Y.text === "string" ? Y.text.trim() : "";
    if (!O) {
      ((Q += 1), G.info(`asset ${Z.asset_id}: no speech detected`));
      continue;
    }
    (await z.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: Z.content_id,
        text: O,
        variant: "transcript",
        capability: "transcript",
        model: J,
      },
    }),
      (q += 1));
  }
  let M = $.rows?.at(-1)?.asset_id;
  if (M) await z.state.set("cursor", M);
  return {
    summary: `transcribed ${q}; skipped ${Q}; bounded batch ${$.rows?.length ?? 0}/${v}`,
    output: {
      derived: q,
      skipped: Q,
      model: J,
      rearm: ($.rows?.length ?? 0) === v,
    },
  };
}
export { Lz as setTranscriptRuntimeForTests, Kz as default };
