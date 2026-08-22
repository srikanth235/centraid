// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { spawnSync as m } from "node:child_process";
import { existsSync as u } from "node:fs";
import N from "node:path";
import X from "node:path";
import { pathToFileURL as y } from "node:url";
var T = X.resolve(import.meta.dirname, ".."),
  C = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? X.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : X.join(T, "runtime"),
  B = X.join(C, "models");
import { existsSync as O, readFileSync as f, statSync as x } from "node:fs";
import w from "node:path";
class k extends Error {
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
function A(z, G = C) {
  let J = w.join(G, "node_modules");
  if (!O(J)) throw new k(z);
  let K = w.join(J, ...z.split("/"));
  try {
    let V = D(K);
    if (V === null) throw Error(`no entry point in ${K}`);
    return V;
  } catch (V) {
    throw new k(z, V);
  }
}
function D(z, G = 0) {
  let J = w.join(z, "package.json"),
    K = O(J) ? JSON.parse(f(J, "utf8")) : {},
    V = [
      ...L(h(K.exports)),
      ...(typeof K.main === "string" ? [K.main] : []),
      "index.js",
    ];
  for (let $ of V) {
    let Q = g(w.resolve(z, $), G);
    if (Q !== null) return Q;
  }
  return null;
}
function g(z, G) {
  let J = F(z);
  if (J?.isFile()) return z;
  if (J?.isDirectory()) return G >= 4 ? null : D(z, G + 1);
  for (let K of [".js", ".json", ".node"]) {
    let V = `${z}${K}`;
    if (F(V)?.isFile()) return V;
  }
  return null;
}
function F(z) {
  try {
    return x(z);
  } catch {
    return null;
  }
}
function h(z) {
  if (typeof z === "string") return z;
  if (z === null || typeof z !== "object") return;
  let G = z;
  return "." in G ? G["."] : G;
}
function L(z, G = 0) {
  if (typeof z === "string") return [z];
  if (G > 8 || z === null || typeof z !== "object") return [];
  if (Array.isArray(z)) return z.flatMap((V) => L(V, G + 1));
  let J = z,
    K = [];
  for (let V of ["require", "node", "default"])
    if (V in J) K.push(...L(J[V], G + 1));
  return K;
}
var E = "whisper-tiny.en-q8@1",
  p = N.join(B, "transcript"),
  P = 600,
  l = P * 16000 * Float32Array.BYTES_PER_ELEMENT,
  d = [
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
  j,
  c = s,
  n = (z, G, J) => m(z, G, J),
  o = t;
function U(z = B) {
  let G = N.join(z, "transcript");
  return d.every((J) => u(N.join(G, J)));
}
function i(z) {
  if (!z.startsWith("audio/") && !z.startsWith("video/"))
    throw Error(`transcript: unsupported media type ${z}`);
}
async function s() {
  let z = A("@ffmpeg-installer/ffmpeg"),
    G = await import(y(z).href),
    J = G.default?.path ?? G.path;
  if (typeof J !== "string" || !J)
    throw Error("transcript: the bundled FFmpeg executable is unavailable");
  return J;
}
async function a(z) {
  let G = await c(),
    J = n(
      G,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-t",
        String(P),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { input: z, maxBuffer: l + 1048576 }
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
async function r() {
  if (j) return j;
  j = o();
  try {
    return await j;
  } catch (z) {
    throw ((j = void 0), z);
  }
}
async function t() {
  let z = A("@huggingface/transformers"),
    G = await import(y(z).href);
  return (
    (G.env.allowLocalModels = !0),
    (G.env.allowRemoteModels = !1),
    (G.env.localModelPath = B),
    (G.env.useBrowserCache = !1),
    G.pipeline("automatic-speech-recognition", p, {
      dtype: "q8",
      device: "cpu",
    })
  );
}
function e(z) {
  let G = Array.isArray(z)
    ? z
        .map((J) => (typeof J.text === "string" ? J.text.trim() : ""))
        .filter(Boolean)
        .join(" ")
    : z.text;
  return typeof G === "string" ? G.trim() : "";
}
async function M(z) {
  try {
    i(z.mediaType);
    let G = await a(Buffer.from(z.bytes, "base64")),
      K = await (
        await r()
      )(G, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: !1 });
    return { id: z.id, text: e(K) };
  } catch (G) {
    return { id: z.id, error: G instanceof Error ? G.message : String(G) };
  }
}
var _ = 2,
  q = "dpv:ServiceProvision",
  S = 67108864,
  R = M,
  b = U;
function Lz(z) {
  ((R = z?.transcribe ?? M), (b = z?.weightsPresent ?? U));
}
function zz() {
  return b() ? E : null;
}
async function Gz(z, G) {
  let K = (
    await z.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["audio", "video"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: q,
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
      purpose: q,
    })
  ).rows?.[0]?.model === G
    ? K.asset_id
    : "";
}
async function Jz({ ctx: z, log: G }) {
  let J = zz();
  if (!J)
    return {
      summary: "transcript skipped — automation model assets unavailable",
    };
  let K = await z.state.get("model");
  if (K !== J)
    (await z.state.set("cursor", K === void 0 ? await Gz(z, J) : ""),
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
      limit: _,
      purpose: q,
    }),
    Q = 0,
    W = 0;
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
          purpose: q,
        })
      ).rows?.[0]?.model === J
    ) {
      W += 1;
      continue;
    }
    let H = await z.vault.content({
      contentId: Z.content_id,
      variant: "original",
      maxBytes: S,
      purpose: q,
    });
    if (H?.status === "too-large") {
      ((W += 1),
        G.info(
          `asset ${Z.asset_id}: original exceeds the ${S}-byte transcription ceiling`
        ));
      continue;
    }
    if (H?.status !== "ok" || H.kind !== "bytes")
      throw Error(`asset ${Z.asset_id}: bounded original is unavailable`);
    let Y = await R({
      id: Z.content_id,
      bytes: H.base64,
      mediaType: H.mediaType,
    });
    if (!Y || Y.error)
      throw Error(Y?.error ?? `asset ${Z.asset_id}: ASR returned no result`);
    let I = typeof Y.text === "string" ? Y.text.trim() : "";
    if (!I) {
      ((W += 1), G.info(`asset ${Z.asset_id}: no speech detected`));
      continue;
    }
    (await z.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: Z.content_id,
        text: I,
        variant: "transcript",
        capability: "transcript",
        model: J,
      },
      purpose: q,
    }),
      (Q += 1));
  }
  let v = $.rows?.at(-1)?.asset_id;
  if (v) await z.state.set("cursor", v);
  return {
    summary: `transcribed ${Q}; skipped ${W}; bounded batch ${$.rows?.length ?? 0}/${_}`,
    output: {
      derived: Q,
      skipped: W,
      model: J,
      rearm: ($.rows?.length ?? 0) === _,
    },
  };
}
export { Lz as setTranscriptRuntimeForTests, Jz as default };
