import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MODELS_DIR } from "../config.js";
import { resolveRuntimeModule } from "../onnx.js";
import type { ItemResult, TranscriptItem, TranscriptResult } from "../types.js";

export const TRANSCRIPT_MODEL_ID = "whisper-tiny.en-q8@1";
const MODEL_DIR = path.join(MODELS_DIR, "transcript");
const MAX_AUDIO_SECONDS = 10 * 60;
const MAX_PCM_BYTES =
  MAX_AUDIO_SECONDS * 16_000 * Float32Array.BYTES_PER_ELEMENT;
const REQUIRED_FILES = [
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
] as const;

interface TransformersModule {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    localModelPath: string;
    useBrowserCache: boolean;
  };
  pipeline: (
    task: "automatic-speech-recognition",
    model: string,
    options: Record<string, unknown>
  ) => Promise<
    (
      audio: Float32Array,
      options: Record<string, unknown>
    ) => Promise<{ text?: unknown } | Array<{ text?: unknown }>>
  >;
}

type Transcriber = (
  audio: Float32Array,
  options: Record<string, unknown>
) => Promise<{ text?: unknown } | Array<{ text?: unknown }>>;

interface FfmpegResult {
  status: number | null;
  stdout?: Buffer;
  stderr?: Buffer;
}

type FfmpegRunner = (
  executable: string,
  args: string[],
  options: { input: Buffer; maxBuffer: number }
) => FfmpegResult;

let cachedTranscriber: Promise<Transcriber> | undefined;
let locateFfmpeg = ffmpegPath;
let runFfmpeg: FfmpegRunner = (executable, args, options) =>
  spawnSync(executable, args, options);
let createTranscriber = createLocalTranscriber;

export function transcriptWeightsPresent(
  modelsDir: string = MODELS_DIR
): boolean {
  const modelDir = path.join(modelsDir, "transcript");
  return REQUIRED_FILES.every((file) => existsSync(path.join(modelDir, file)));
}

function requireMediaType(mediaType: string): void {
  if (!mediaType.startsWith("audio/") && !mediaType.startsWith("video/")) {
    throw new Error(`transcript: unsupported media type ${mediaType}`);
  }
}

async function ffmpegPath(): Promise<string> {
  const resolved = resolveRuntimeModule("@ffmpeg-installer/ffmpeg");
  const loaded = (await import(pathToFileURL(resolved).href)) as {
    default?: { path?: unknown };
    path?: unknown;
  };
  const executable = loaded.default?.path ?? loaded.path;
  if (typeof executable !== "string" || !executable) {
    throw new Error("transcript: the bundled FFmpeg executable is unavailable");
  }
  return executable;
}

async function decodePcm(bytes: Buffer): Promise<Float32Array> {
  const executable = await locateFfmpeg();
  const result = runFfmpeg(
    executable,
    [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-t",
      String(MAX_AUDIO_SECONDS),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { input: bytes, maxBuffer: MAX_PCM_BYTES + 1024 * 1024 }
  );
  if (result.status !== 0) {
    const detail = result.stderr?.toString("utf8").trim();
    throw new Error(
      `transcript: FFmpeg decode failed${detail ? `: ${detail}` : ""}`
    );
  }
  if (!result.stdout?.length)
    throw new Error("transcript: decoded audio is empty");
  if (result.stdout.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("transcript: FFmpeg returned an unaligned PCM stream");
  }
  return new Float32Array(
    result.stdout.buffer,
    result.stdout.byteOffset,
    result.stdout.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
}

async function loadTranscriber(): Promise<Transcriber> {
  if (cachedTranscriber) return cachedTranscriber;
  cachedTranscriber = createTranscriber();
  try {
    return await cachedTranscriber;
  } catch (error) {
    cachedTranscriber = undefined;
    throw error;
  }
}

async function createLocalTranscriber(): Promise<Transcriber> {
  const resolved = resolveRuntimeModule("@huggingface/transformers");
  const transformers = (await import(
    pathToFileURL(resolved).href
  )) as TransformersModule;
  transformers.env.allowLocalModels = true;
  transformers.env.allowRemoteModels = false;
  transformers.env.localModelPath = MODELS_DIR;
  transformers.env.useBrowserCache = false;
  return transformers.pipeline("automatic-speech-recognition", MODEL_DIR, {
    dtype: "q8",
    device: "cpu",
  });
}

function outputText(
  output: { text?: unknown } | Array<{ text?: unknown }>
): string {
  const text = Array.isArray(output)
    ? output
        .map((item) => (typeof item.text === "string" ? item.text.trim() : ""))
        .filter(Boolean)
        .join(" ")
    : output.text;
  return typeof text === "string" ? text.trim() : "";
}

export async function transcript(
  input: TranscriptItem
): Promise<ItemResult<TranscriptResult>> {
  try {
    requireMediaType(input.mediaType);
    const pcm = await decodePcm(Buffer.from(input.bytes, "base64"));
    const transcriber = await loadTranscriber();
    const output = await transcriber(pcm, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: false,
    });
    return { id: input.id, text: outputText(output) };
  } catch (error) {
    return {
      id: input.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Test-only seam for clearing the lazily loaded model pipeline. @public */
export function resetTranscriptRuntimeForTests(): void {
  cachedTranscriber = undefined;
  locateFfmpeg = ffmpegPath;
  runFfmpeg = (executable, args, options) =>
    spawnSync(executable, args, options);
  createTranscriber = createLocalTranscriber;
}

/** Test-only dependency replacement for deterministic PR coverage. @public */
export function setTranscriptRuntimeForTests(runtime: {
  ffmpegPath?: () => Promise<string>;
  runFfmpeg?: FfmpegRunner;
  createTranscriber?: () => Promise<Transcriber>;
}): void {
  cachedTranscriber = undefined;
  locateFfmpeg = runtime.ffmpegPath ?? ffmpegPath;
  runFfmpeg =
    runtime.runFfmpeg ??
    ((executable, args, options) => spawnSync(executable, args, options));
  createTranscriber = runtime.createTranscriber ?? createLocalTranscriber;
}
