import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { MODELS_DIR } from "../config.js";
import { getOrCreateSession, loadOnnxRuntime } from "../onnx.js";
import { decodeImageCenterCropped, normalizeClip } from "../preprocess.js";
import { createClipTokenizer } from "../tokenizer.js";
import type { ClipTokenizer } from "../tokenizer.js";
import type {
  EmbedImageItem,
  EmbedResult,
  EmbedTextItem,
  ItemResult,
  ModelId,
} from "../types.js";

// CLIP ViT-B/32 (OpenAI weights, MIT — see LICENSES.md), ONNX export from
// immich-app/ViT-B-32__openai. Both the image tower (visual.onnx) and the
// text tower (textual.onnx) project into the SAME embedding space, so the
// wire contract advertises one model id for both embed-image and embed-text
// (issue #724 W8 requires this).
export const EMBED_MODEL_ID: ModelId = "clip-vit-b-32@1";

const CLIP_DIR = path.join(MODELS_DIR, "clip");
const VISUAL_MODEL_PATH = path.join(CLIP_DIR, "visual.onnx");
const TEXTUAL_MODEL_PATH = path.join(CLIP_DIR, "textual.onnx");
const VOCAB_PATH = path.join(CLIP_DIR, "vocab.json");
const MERGES_PATH = path.join(CLIP_DIR, "merges.txt");

const CLIP_IMAGE_SIZE = 224;
const CLIP_CONTEXT_LENGTH = 77;

export function embedWeightsPresent(modelsDir: string = MODELS_DIR): boolean {
  const clipDir = path.join(modelsDir, "clip");
  return ["visual.onnx", "textual.onnx", "vocab.json", "merges.txt"].every(
    (filename) => existsSync(path.join(clipDir, filename))
  );
}

/**
 * Parses the OpenAI CLIP BPE merges file: a `#version: ...` comment line
 * (skipped) followed by one `"symbolA symbolB"` pair per line, in learned
 * priority order.
 */
export function parseMergesFile(contents: string): Array<[string, string]> {
  const merges: Array<[string, string]> = [];
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const parts = trimmed.split(" ");
    if (parts.length === 2) {
      merges.push([parts[0] as string, parts[1] as string]);
    }
  }
  return merges;
}

let cachedTokenizer: ClipTokenizer | undefined;

async function loadTokenizer(): Promise<ClipTokenizer> {
  if (cachedTokenizer) {
    return cachedTokenizer;
  }
  const [vocabJson, mergesText] = await Promise.all([
    readFile(VOCAB_PATH, "utf8"),
    readFile(MERGES_PATH, "utf8"),
  ]);
  const vocabEntries = JSON.parse(vocabJson) as Record<string, number>;
  cachedTokenizer = createClipTokenizer({
    vocab: new Map(Object.entries(vocabEntries)),
    merges: parseMergesFile(mergesText),
  });
  return cachedTokenizer;
}

/** L2-normalizes a vector — CLIP embeddings are compared by cosine similarity, so callers expect unit vectors. */
export function l2Normalize(vector: Float32Array): number[] {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) {
    return Array.from(vector);
  }
  return Array.from(vector, (value) => value / norm);
}

/**
 * Reads the first output tensor's data regardless of its exact name — ONNX
 * exports of CLIP name their pooled embedding output differently across
 * conversion tools, so anchoring to `session.outputNames[0]` (rather than a
 * guessed literal like `"image_embeds"`) is robust to that variance. The
 * pinned export and this first-output lookup are exercised by the weekly
 * real-weight golden in `model-goldens.live.test.ts`.
 */
function firstOutputAsFloat32(
  fetches: Record<string, { data: unknown }>,
  outputNames: readonly string[]
): Float32Array {
  const name = outputNames[0];
  const value = name ? fetches[name] : undefined;
  if (!value || !(value.data instanceof Float32Array)) {
    throw new Error(
      "embed: expected a float32 tensor as the model's first output"
    );
  }
  return value.data;
}

export async function embedImage(
  item: EmbedImageItem
): Promise<ItemResult<EmbedResult>> {
  try {
    const bytes = Buffer.from(item.bytes, "base64");
    const decoded = await decodeImageCenterCropped(bytes, CLIP_IMAGE_SIZE);
    const chw = normalizeClip(decoded);

    const ort = await loadOnnxRuntime();
    const session = await getOrCreateSession(VISUAL_MODEL_PATH);
    const inputName = session.inputNames[0] ?? "pixel_values";
    const feeds = {
      [inputName]: new ort.Tensor("float32", chw, [
        1,
        3,
        CLIP_IMAGE_SIZE,
        CLIP_IMAGE_SIZE,
      ]),
    };
    const fetches = await session.run(feeds);
    const vector = l2Normalize(
      firstOutputAsFloat32(fetches, session.outputNames)
    );
    return { id: item.id, vector };
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function embedText(
  item: EmbedTextItem
): Promise<ItemResult<EmbedResult>> {
  try {
    const tokenizer = await loadTokenizer();
    const ids = tokenizer.encode(item.text, CLIP_CONTEXT_LENGTH);

    const ort = await loadOnnxRuntime();
    const session = await getOrCreateSession(TEXTUAL_MODEL_PATH);
    const inputName = session.inputNames[0] ?? "input_ids";
    const feeds = {
      [inputName]: new ort.Tensor(
        "int64",
        BigInt64Array.from(ids.map(BigInt)),
        [1, ids.length]
      ),
    };
    const fetches = await session.run(feeds);
    const vector = l2Normalize(
      firstOutputAsFloat32(fetches, session.outputNames)
    );
    return { id: item.id, vector };
  } catch (error) {
    return {
      id: item.id,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
