// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { spawnSync as p } from "node:child_process";
import { existsSync as l } from "node:fs";
import N from "node:path";
import H from "node:path";
import { pathToFileURL as D } from "node:url";
var R = H.resolve(import.meta.dirname, ".."),
  T = "__centraidAutomationRuntimeDir";
function x() {
  let z = globalThis[T];
  if (typeof z === "string" && z.length > 0) return H.resolve(z);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return H.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return H.join(R, "runtime");
}
var C = x(),
  B = H.join(C, "models");
import { existsSync as O, readFileSync as g, statSync as h } from "node:fs";
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
function L(z, G = C) {
  let J = w.join(G, "node_modules");
  if (!O(J)) throw new k(z);
  let K = w.join(J, ...z.split("/"));
  try {
    let V = y(K);
    if (V === null) throw Error(`no entry point in ${K}`);
    return V;
  } catch (V) {
    throw new k(z, V);
  }
}
function y(z, G = 0) {
  let J = w.join(z, "package.json"),
    K = O(J) ? JSON.parse(g(J, "utf8")) : {},
    V = [
      ...A(u(K.exports)),
      ...(typeof K.main === "string" ? [K.main] : []),
      "index.js",
    ];
  for (let $ of V) {
    let q = m(w.resolve(z, $), G);
    if (q !== null) return q;
  }
  return null;
}
function m(z, G) {
  let J = F(z);
  if (J?.isFile()) return z;
  if (J?.isDirectory()) return G >= 4 ? null : y(z, G + 1);
  for (let K of [".js", ".json", ".node"]) {
    let V = `${z}${K}`;
    if (F(V)?.isFile()) return V;
  }
  return null;
}
function F(z) {
  try {
    return h(z);
  } catch {
    return null;
  }
}
function u(z) {
  if (typeof z === "string") return z;
  if (z === null || typeof z !== "object") return;
  let G = z;
  return "." in G ? G["."] : G;
}
function A(z, G = 0) {
  if (typeof z === "string") return [z];
  if (G > 8 || z === null || typeof z !== "object") return [];
  if (Array.isArray(z)) return z.flatMap((V) => A(V, G + 1));
  let J = z,
    K = [];
  for (let V of ["require", "node", "default"])
    if (V in J) K.push(...A(J[V], G + 1));
  return K;
}
var E = "whisper-tiny.en-q8@1",
  d = N.join(B, "transcript"),
  P = 600,
  c = P * 16000 * Float32Array.BYTES_PER_ELEMENT,
  n = [
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
  X,
  o = r,
  i = (z, G, J) => p(z, G, J),
  s = zz;
function v(z = B) {
  let G = N.join(z, "transcript");
  return n.every((J) => l(N.join(G, J)));
}
function a(z) {
  if (!z.startsWith("audio/") && !z.startsWith("video/"))
    throw Error(`transcript: unsupported media type ${z}`);
}
async function r() {
  let z = L("@ffmpeg-installer/ffmpeg"),
    G = await import(D(z).href),
    J = G.default?.path ?? G.path;
  if (typeof J !== "string" || !J)
    throw Error("transcript: the bundled FFmpeg executable is unavailable");
  return J;
}
async function t(z) {
  let G = await o(),
    J = i(
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
      { input: z, maxBuffer: c + 1048576 }
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
async function e() {
  if (X) return X;
  X = s();
  try {
    return await X;
  } catch (z) {
    throw ((X = void 0), z);
  }
}
async function zz() {
  let z = L("@huggingface/transformers"),
    G = await import(D(z).href);
  return (
    (G.env.allowLocalModels = !0),
    (G.env.allowRemoteModels = !1),
    (G.env.localModelPath = B),
    (G.env.useBrowserCache = !1),
    G.pipeline("automatic-speech-recognition", d, {
      dtype: "q8",
      device: "cpu",
    })
  );
}
function Gz(z) {
  let G = Array.isArray(z)
    ? z
        .map((J) => (typeof J.text === "string" ? J.text.trim() : ""))
        .filter(Boolean)
        .join(" ")
    : z.text;
  return typeof G === "string" ? G.trim() : "";
}
async function U(z) {
  try {
    a(z.mediaType);
    let G = await t(Buffer.from(z.bytes, "base64")),
      K = await (
        await e()
      )(G, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: !1 });
    return { id: z.id, text: Gz(K) };
  } catch (G) {
    return { id: z.id, error: G instanceof Error ? G.message : String(G) };
  }
}
var M = 2,
  S = 67108864,
  b = U,
  f = v;
function Nz(z) {
  ((b = z?.transcribe ?? U), (f = z?.weightsPresent ?? v));
}
function Jz() {
  return f() ? E : null;
}
async function Kz(z, G) {
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
async function Vz({ ctx: z, log: G }) {
  let J = Jz();
  if (!J)
    return {
      summary: "transcript skipped — automation model assets unavailable",
    };
  let K = await z.state.get("model");
  if (K !== J)
    (await z.state.set("cursor", K === void 0 ? await Kz(z, J) : ""),
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
      limit: M,
    }),
    q = 0,
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
        })
      ).rows?.[0]?.model === J
    ) {
      W += 1;
      continue;
    }
    let Y = await z.vault.content({
      contentId: Z.content_id,
      variant: "original",
      maxBytes: S,
    });
    if (Y?.status === "too-large") {
      ((W += 1),
        G.info(
          `asset ${Z.asset_id}: original exceeds the ${S}-byte transcription ceiling`
        ));
      continue;
    }
    if (Y?.status !== "ok" || Y.kind !== "bytes")
      throw Error(`asset ${Z.asset_id}: bounded original is unavailable`);
    let j = await b({
      id: Z.content_id,
      bytes: Y.base64,
      mediaType: Y.mediaType,
    });
    if (!j || j.error)
      throw Error(j?.error ?? `asset ${Z.asset_id}: ASR returned no result`);
    let _ = typeof j.text === "string" ? j.text.trim() : "";
    if (!_) {
      ((W += 1), G.info(`asset ${Z.asset_id}: no speech detected`));
      continue;
    }
    (await z.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: Z.content_id,
        text: _,
        variant: "transcript",
        capability: "transcript",
        model: J,
      },
    }),
      (q += 1));
  }
  let I = $.rows?.at(-1)?.asset_id;
  if (I) await z.state.set("cursor", I);
  return {
    summary: `transcribed ${q}; skipped ${W}; bounded batch ${$.rows?.length ?? 0}/${M}`,
    output: {
      derived: q,
      skipped: W,
      model: J,
      rearm: ($.rows?.length ?? 0) === M,
    },
  };
}
export { Nz as setTranscriptRuntimeForTests, Vz as default };
