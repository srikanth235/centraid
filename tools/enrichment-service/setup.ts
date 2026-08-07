#!/usr/bin/env bun
// `bun run --cwd tools/enrichment-service setup` — the ONLY place that
// touches the network or writes into runtime/ (issue #724 W8). It:
//   1. runs `bun install` inside runtime/ (never at the repo root), which
//      is the one place onnxruntime-node + sharp get installed;
//   2. downloads each capability's model weights + auxiliary files
//      (tokenizer vocab/merges, character dictionary) into
//      runtime/models/<capability>/;
//   3. prints exactly what it fetched and each file's upstream licence.
//
// Every model here is permissively licensed (Apache-2.0/MIT) — see
// LICENSES.md for the full table and source citations. Re-run any time to
// pick up new capabilities; existing files are skipped (idempotent).

import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { MODELS_DIR, RUNTIME_DIR } from "./src/config.js";

interface DownloadSpec {
  url: string;
  destination: string;
  /** Short "Name — SPDX-License-Identifier (source)" line, printed in the summary and matching LICENSES.md. */
  licence: string;
}

const CLIP_DIR = path.join(MODELS_DIR, "clip");
const OCR_DIR = path.join(MODELS_DIR, "ocr");
const FACES_DIR = path.join(MODELS_DIR, "faces");

const CLIP_LICENCE =
  "CLIP ViT-B/32 (OpenAI weights) — MIT (github.com/openai/CLIP)";
const PP_OCR_LICENCE =
  "PP-OCRv4 det/rec (PaddleOCR via RapidOCR ONNX export) — Apache-2.0 (github.com/PaddlePaddle/PaddleOCR, huggingface.co/SWHL/RapidOCR)";
const YUNET_LICENCE =
  "YuNet face detector (OpenCV Zoo) — MIT (github.com/opencv/opencv_zoo)";
const SFACE_LICENCE =
  "SFace face recognizer (OpenCV Zoo) — Apache-2.0 (github.com/opencv/opencv_zoo)";

const DOWNLOADS: DownloadSpec[] = [
  {
    url: "https://huggingface.co/immich-app/ViT-B-32__openai/resolve/main/visual/model.onnx",
    destination: path.join(CLIP_DIR, "visual.onnx"),
    licence: CLIP_LICENCE,
  },
  {
    url: "https://huggingface.co/immich-app/ViT-B-32__openai/resolve/main/textual/model.onnx",
    destination: path.join(CLIP_DIR, "textual.onnx"),
    licence: CLIP_LICENCE,
  },
  {
    url: "https://huggingface.co/immich-app/ViT-B-32__openai/resolve/main/textual/vocab.json",
    destination: path.join(CLIP_DIR, "vocab.json"),
    licence: CLIP_LICENCE,
  },
  {
    url: "https://huggingface.co/immich-app/ViT-B-32__openai/resolve/main/textual/merges.txt",
    destination: path.join(CLIP_DIR, "merges.txt"),
    licence: CLIP_LICENCE,
  },
  {
    url: "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_det_infer.onnx",
    destination: path.join(OCR_DIR, "det.onnx"),
    licence: PP_OCR_LICENCE,
  },
  {
    url: "https://huggingface.co/SWHL/RapidOCR/resolve/main/PP-OCRv4/ch_PP-OCRv4_rec_infer.onnx",
    destination: path.join(OCR_DIR, "rec.onnx"),
    licence: PP_OCR_LICENCE,
  },
  {
    url: "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt",
    destination: path.join(OCR_DIR, "dict.txt"),
    licence: PP_OCR_LICENCE,
  },
  {
    url: "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
    destination: path.join(FACES_DIR, "yunet.onnx"),
    licence: YUNET_LICENCE,
  },
  {
    url: "https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx",
    destination: path.join(FACES_DIR, "sface.onnx"),
    licence: SFACE_LICENCE,
  },
];

async function downloadFile(
  spec: DownloadSpec
): Promise<"downloaded" | "already present"> {
  if (existsSync(spec.destination)) {
    return "already present";
  }
  mkdirSync(path.dirname(spec.destination), { recursive: true });

  const response = await fetch(spec.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(
      `GET ${spec.url} failed: ${response.status} ${response.statusText}`
    );
  }

  const tempPath = `${spec.destination}.partial`;
  await pipeline(
    Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
    createWriteStream(tempPath)
  );
  // Rename only after the full stream lands, so a killed download never
  // leaves a truncated file mistaken for a complete one on the next run.
  renameSync(tempPath, spec.destination);
  return "downloaded";
}

function installRuntimeDependencies(): void {
  console.log(
    `Running "bun install" in ${RUNTIME_DIR} (installs onnxruntime-node + sharp)...`
  );
  const result = spawnSync("bun", ["install"], {
    cwd: RUNTIME_DIR,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `"bun install" in ${RUNTIME_DIR} exited with status ${result.status ?? "unknown"}`
    );
  }
}

async function main(): Promise<void> {
  mkdirSync(MODELS_DIR, { recursive: true });

  installRuntimeDependencies();

  console.log("\nFetching model weights + auxiliary files...");
  const fetched: string[] = [];
  for (const spec of DOWNLOADS) {
    // Sequential on purpose — these are large (hundreds of MB in total) and
    // this is a one-time setup step, not request-serving hot path; there is
    // no latency budget to protect here, only a wish to keep console
    // output in a legible, one-line-per-file order.
    // oxlint-disable-next-line no-await-in-loop -- see comment above
    const outcome = await downloadFile(spec);
    console.log(
      `  [${outcome === "downloaded" ? "downloaded" : "cached"}] ${path.relative(RUNTIME_DIR, spec.destination)}`
    );
    fetched.push(spec.destination);
  }

  console.log("\nLicences (also recorded in LICENSES.md):");
  const uniqueLicences = [...new Set(DOWNLOADS.map((d) => d.licence))];
  for (const licence of uniqueLicences) {
    console.log(`  - ${licence}`);
  }

  console.log(
    `\nDone. ${fetched.length} files present under ${MODELS_DIR}. Start the service with "bun run --cwd tools/enrichment-service serve".`
  );
}

await main();
