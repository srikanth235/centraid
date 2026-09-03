// Generated recognition automation. Source: packages/model-runtime/automation-handlers.
import { spawnSync as d } from "node:child_process";
import { existsSync as l } from "node:fs";
import O from "node:path";
import k from "node:path";
import { pathToFileURL as H } from "node:url";
var C = k.resolve(import.meta.dirname, ".."),
  F = "__centraidAutomationRuntimeDir";
function U() {
  let n = globalThis[F];
  if (typeof n === "string" && n.length > 0) return k.resolve(n);
  if (process.env?.CENTRAID_AUTOMATION_RUNTIME_DIR)
    return k.resolve(process.env.CENTRAID_AUTOMATION_RUNTIME_DIR);
  return k.join(C, "runtime");
}
var R = U(),
  v = k.join(R, "models");
import { existsSync as Q, readFileSync as X, statSync as B } from "node:fs";
import $ from "node:path";
class M extends Error {
  constructor(n, o) {
    super(
      `Automation model runtime dependency "${n}" is not installed. ` +
        'Run "bun run --cwd packages/model-runtime setup" first — it installs ' +
        "optional native recognition dependencies into packages/model-runtime/runtime/ and downloads the model weights those capabilities need.",
      { cause: o }
    );
    this.name = "RuntimeNotInstalledError";
  }
}
function J(n, o = R) {
  let i = $.join(o, "node_modules");
  if (!Q(i)) throw new M(n);
  let f = $.join(i, ...n.split("/"));
  try {
    let u = A(f);
    if (u === null) throw Error(`no entry point in ${f}`);
    return u;
  } catch (u) {
    throw new M(n, u);
  }
}
function A(n, o = 0) {
  let i = $.join(n, "package.json"),
    f = Q(i) ? JSON.parse(X(i, "utf8")) : {},
    u = [
      ...g(L(f.exports)),
      ...(typeof f.main === "string" ? [f.main] : []),
      "index.js",
    ];
  for (let w of u) {
    let s = E($.resolve(n, w), o);
    if (s !== null) return s;
  }
  return null;
}
function E(n, o) {
  let i = Z(n);
  if (i?.isFile()) return n;
  if (i?.isDirectory()) return o >= 4 ? null : A(n, o + 1);
  for (let f of [".js", ".json", ".node"]) {
    let u = `${n}${f}`;
    if (Z(u)?.isFile()) return u;
  }
  return null;
}
function Z(n) {
  try {
    return B(n);
  } catch {
    return null;
  }
}
function L(n) {
  if (typeof n === "string") return n;
  if (n === null || typeof n !== "object") return;
  let o = n;
  return "." in o ? o["."] : o;
}
function g(n, o = 0) {
  if (typeof n === "string") return [n];
  if (o > 8 || n === null || typeof n !== "object") return [];
  if (Array.isArray(n)) return n.flatMap((u) => g(u, o + 1));
  let i = n,
    f = [];
  for (let u of ["require", "node", "default"])
    if (u in i) f.push(...g(i[u], o + 1));
  return f;
}
var W = "whisper-tiny.en-q8@1",
  m = O.join(v, "transcript"),
  h = 600,
  S = h * 16000 * Float32Array.BYTES_PER_ELEMENT,
  T = [
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
  N,
  c = P,
  p = (n, o, i) => d(n, o, i),
  x = nn;
function q(n = v) {
  let o = O.join(n, "transcript");
  return T.every((i) => l(O.join(o, i)));
}
function b(n) {
  if (!n.startsWith("audio/") && !n.startsWith("video/"))
    throw Error(`transcript: unsupported media type ${n}`);
}
async function P() {
  let n = J("@ffmpeg-installer/ffmpeg"),
    o = await import(H(n).href),
    i = o.default?.path ?? o.path;
  if (typeof i !== "string" || !i)
    throw Error("transcript: the bundled FFmpeg executable is unavailable");
  return i;
}
async function e(n) {
  let o = await c(),
    i = p(
      o,
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-t",
        String(h),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { input: n, maxBuffer: S + 1048576 }
    );
  if (i.status !== 0) {
    let f = i.stderr?.toString("utf8").trim();
    throw Error(`transcript: FFmpeg decode failed${f ? `: ${f}` : ""}`);
  }
  if (!i.stdout?.length) throw Error("transcript: decoded audio is empty");
  if (i.stdout.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0)
    throw Error("transcript: FFmpeg returned an unaligned PCM stream");
  return new Float32Array(
    i.stdout.buffer,
    i.stdout.byteOffset,
    i.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}
async function a() {
  if (N) return N;
  N = x();
  try {
    return await N;
  } catch (n) {
    throw ((N = void 0), n);
  }
}
async function nn() {
  let n = J("@huggingface/transformers"),
    o = await import(H(n).href);
  return (
    (o.env.allowLocalModels = !0),
    (o.env.allowRemoteModels = !1),
    (o.env.localModelPath = v),
    (o.env.useBrowserCache = !1),
    o.pipeline("automatic-speech-recognition", m, {
      dtype: "q8",
      device: "cpu",
    })
  );
}
function on(n) {
  let o = Array.isArray(n)
    ? n
        .map((i) => (typeof i.text === "string" ? i.text.trim() : ""))
        .filter(Boolean)
        .join(" ")
    : n.text;
  return typeof o === "string" ? o.trim() : "";
}
async function z(n) {
  try {
    b(n.mediaType);
    let o = await e(Buffer.from(n.bytes, "base64")),
      f = await (
        await a()
      )(o, { chunk_length_s: 30, stride_length_s: 5, return_timestamps: !1 });
    return { id: n.id, text: on(f) };
  } catch (o) {
    return { id: n.id, error: o instanceof Error ? o.message : String(o) };
  }
}
var G = 2,
  y = "dpv:ServiceProvision",
  D = 67108864,
  Y = z,
  _ = q;
function qn(n) {
  ((Y = n?.transcribe ?? z), (_ = n?.weightsPresent ?? q));
}
function fn() {
  return _() ? W : null;
}
async function un(n, o) {
  let f = (
    await n.vault.read({
      entity: "media.asset",
      where: [
        { column: "kind", op: "in", value: ["audio", "video"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "desc" },
      limit: 1,
      purpose: y,
    })
  ).rows?.[0];
  if (!f) return "";
  return (
    await n.vault.read({
      entity: "enrich.derivation",
      where: [
        { column: "target_id", op: "eq", value: f.content_id },
        { column: "variant", op: "eq", value: "transcript" },
      ],
      limit: 1,
      purpose: y,
    })
  ).rows?.[0]?.model === o
    ? f.asset_id
    : "";
}
async function rn({ ctx: n, log: o }) {
  let i = fn();
  if (!i)
    return {
      summary: "transcript skipped — automation model assets unavailable",
    };
  let f = await n.state.get("model");
  if (f !== i)
    (await n.state.set("cursor", f === void 0 ? await un(n, i) : ""),
      await n.state.set("model", i));
  let u = (await n.state.get("cursor")) ?? "",
    w = await n.vault.read({
      entity: "media.asset",
      where: [
        { column: "asset_id", op: "gt", value: u },
        { column: "kind", op: "in", value: ["audio", "video"] },
        { column: "deleted_at", op: "is-null" },
      ],
      orderBy: { column: "asset_id", dir: "asc" },
      limit: G,
      purpose: y,
    }),
    s = 0,
    t = 0;
  for (let r of w.rows ?? []) {
    if (
      (
        await n.vault.read({
          entity: "enrich.derivation",
          where: [
            { column: "target_id", op: "eq", value: r.content_id },
            { column: "variant", op: "eq", value: "transcript" },
          ],
          limit: 1,
          purpose: y,
        })
      ).rows?.[0]?.model === i
    ) {
      t += 1;
      continue;
    }
    let I = await n.vault.content({
      contentId: r.content_id,
      variant: "original",
      maxBytes: D,
      purpose: y,
    });
    if (I?.status === "too-large") {
      ((t += 1),
        o.info(
          `asset ${r.asset_id}: original exceeds the ${D}-byte transcription ceiling`
        ));
      continue;
    }
    if (I?.status !== "ok" || I.kind !== "bytes")
      throw Error(`asset ${r.asset_id}: bounded original is unavailable`);
    let j = await Y({
      id: r.content_id,
      bytes: I.base64,
      mediaType: I.mediaType,
    });
    if (!j || j.error)
      throw Error(j?.error ?? `asset ${r.asset_id}: ASR returned no result`);
    let V = typeof j.text === "string" ? j.text.trim() : "";
    if (!V) {
      ((t += 1), o.info(`asset ${r.asset_id}: no speech detected`));
      continue;
    }
    (await n.vault.invoke({
      command: "core.set_extracted_text",
      input: {
        content_id: r.content_id,
        text: V,
        variant: "transcript",
        capability: "transcript",
        model: i,
      },
      purpose: y,
    }),
      (s += 1));
  }
  let K = w.rows?.at(-1)?.asset_id;
  if (K) await n.state.set("cursor", K);
  return {
    summary: `transcribed ${s}; skipped ${t}; bounded batch ${w.rows?.length ?? 0}/${G}`,
    output: {
      derived: s,
      skipped: t,
      model: i,
      rearm: (w.rows?.length ?? 0) === G,
    },
  };
}
export { qn as setTranscriptRuntimeForTests, rn as default };
