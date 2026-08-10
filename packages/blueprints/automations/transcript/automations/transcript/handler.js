// Generated recognition automation. Source: tools/recognition-automations/automation-handlers.
import { spawnSync as P } from "node:child_process";
import { existsSync as R } from "node:fs";
import C from "node:path";
import j from "node:path";
import { pathToFileURL as _ } from "node:url";
var E = j.resolve(import.meta.dirname, ".."),
  B = process.env.CENTRAID_AUTOMATION_RUNTIME_DIR
    ? j.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR)
    : j.join(E, "runtime"),
  q = j.join(B, "models");
import { existsSync as S } from "node:fs";
import { createRequire as g } from "node:module";
import M from "node:path";
class k extends Error {
  constructor(z, G) {
    super(
      `Automation model runtime dependency "${z}" is not installed. ` +
        'Run "bun run --cwd tools/recognition-automations setup" first — it installs ' +
        "optional native recognition dependencies into tools/recognition-automations/runtime/ and downloads the model weights those capabilities need.",
      { cause: G }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function w(z, G = B) {
  if (!S(M.join(G, "node_modules"))) throw new k(z);
  let J = g(M.join(G, "package.json"));
  try {
    return J.resolve(z);
  } catch (K) {
    throw new k(z, K);
  }
}
var I = "whisper-tiny.en-q8@1",
  T = C.join(q, "transcript"),
  O = 600,
  f = O * 16000 * Float32Array.BYTES_PER_ELEMENT,
  b = [
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
  W,
  x = u,
  h = (z, G, J) => P(z, G, J),
  m = c;
function F(z = q) {
  let G = C.join(z, "transcript");
  return b.every((J) => R(C.join(G, J)));
}
function p(z) {
  if (!z.startsWith("audio/") && !z.startsWith("video/"))
    throw Error(`transcript: unsupported media type ${z}`);
}
async function u() {
  let z = w("@ffmpeg-installer/ffmpeg"),
    G = await import(_(z).href),
    J = G.default?.path ?? G.path;
  if (typeof J !== "string" || !J)
    throw Error("transcript: the bundled FFmpeg executable is unavailable");
  return J;
}
async function d(z) {
  let G = await x(),
    J = h(
      G,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-t",
        String(O),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { input: z, maxBuffer: f + 1048576 }
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
async function l() {
  if (W) return W;
  W = m();
  try {
    return await W;
  } catch (z) {
    throw ((W = void 0), z);
  }
}
async function c() {
  let z = w("@huggingface/transformers"),
    G = await import(_(z).href);
  return (
    (G.env.allowLocalModels = !0),
    (G.env.allowRemoteModels = !1),
    (G.env.localModelPath = q),
    (G.env.useBrowserCache = !1),
    G.pipeline("automatic-speech-recognition", T, {
      dtype: "q8",
      device: "cpu",
    })
  );
}
function n(z) {
  let G = Array.isArray(z)
    ? z
        .map((J) => (typeof J.text === "string" ? J.text.trim() : ""))
        .filter(Boolean)
        .join(" ")
    : z.text;
  return typeof G === "string" ? G.trim() : "";
}
async function A(z) {
  try {
    p(z.mediaType);
    let G = await d(Buffer.from(z.bytes, "base64")),
      K = await (
        await l()
      )(G, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: !1 });
    return { id: z.id, text: n(K) };
  } catch (G) {
    return { id: z.id, error: G instanceof Error ? G.message : String(G) };
  }
}
var L = 2,
  Z = "dpv:ServiceProvision",
  o = 67108864,
  y = A,
  D = F;
function Xz(z) {
  ((y = z?.transcribe ?? A), (D = z?.weightsPresent ?? F));
}
function i() {
  return D() ? I : null;
}
async function a(z, G) {
  let K = (
    await z.vault.read({
      entity: "media.media_asset",
      where: [
        { column: "kind", op: "in", value: ["audio", "video"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: Z,
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
      purpose: Z,
    })
  ).rows?.[0]?.model === G
    ? K.asset_id
    : "";
}
async function s({ ctx: z, log: G }) {
  let J = i();
  if (!J)
    return {
      summary: "transcript skipped — automation model assets unavailable",
    };
  let K = await z.state.get("model");
  if (K !== J)
    (await z.state.set("cursor", K === void 0 ? await a(z, J) : ""),
      await z.state.set("model", J));
  let N = (await z.state.get("cursor")) ?? "",
    Y = await z.vault.read({
      entity: "media.media_asset",
      where: [
        { column: "asset_id", op: "gt", value: N },
        { column: "kind", op: "in", value: ["audio", "video"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: L,
      purpose: Z,
    }),
    X = 0,
    $ = 0;
  for (let V of Y.rows ?? []) {
    if (
      (
        await z.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: V.content_id },
            { column: "variant", op: "eq", value: "transcript" },
          ],
          limit: 1,
          purpose: Z,
        })
      ).rows?.[0]?.model === J
    ) {
      $ += 1;
      continue;
    }
    let H = await z.vault.content({
      contentId: V.content_id,
      variant: "original",
      maxBytes: o,
      purpose: Z,
    });
    if (H?.status !== "ok" || H.kind !== "bytes") {
      (($ += 1),
        G.info(`asset ${V.asset_id}: bounded original is unavailable`));
      continue;
    }
    let Q = await y({
      id: V.content_id,
      bytes: H.base64,
      mediaType: H.mediaType,
    });
    if (!Q || Q.error)
      throw Error(Q?.error ?? `asset ${V.asset_id}: ASR returned no result`);
    let v = typeof Q.text === "string" ? Q.text.trim() : "";
    if (!v) {
      (($ += 1), G.info(`asset ${V.asset_id}: no speech detected`));
      continue;
    }
    (await z.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: V.content_id,
        text: v,
        variant: "transcript",
        capability: "transcript",
        model: J,
      },
      purpose: Z,
    }),
      (X += 1));
  }
  let U = Y.rows?.at(-1)?.asset_id;
  if (U) await z.state.set("cursor", U);
  return {
    summary: `transcribed ${X}; skipped ${$}; bounded batch ${Y.rows?.length ?? 0}/${L}`,
    output: {
      derived: X,
      skipped: $,
      model: J,
      rearm: (Y.rows?.length ?? 0) === L,
    },
  };
}
export { Xz as setTranscriptRuntimeForTests, s as default };
